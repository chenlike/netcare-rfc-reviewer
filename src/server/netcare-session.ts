import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export const NETCARE_ORIGIN = 'https://netcare.huawei.com';
export const NETCARE_URL = `${NETCARE_ORIGIN}/p/netcare/new.html#/iframe/iframe-page/%2Fadc-web%2Fui%2Fstandalone%2Findex.html%23%2Fspl2%2Fcs_nc_network_tuning_query%2Fnt_workflow_rfc_getList_for_report%3Fbg_type=EBG&title=%25E5%258F%2598%25E6%259B%25B4%25E5%2588%2597%25E8%25A1%25A8&title_en=RFC%2520List`;
export interface IdpCredentials { cookie: string; csrfToken: string; username: string; }
export interface NetcareCredentials { cookie: string; csrfToken: string; idp?: IdpCredentials; }

export function validateNetcareNumber(value: unknown): string {
  if (typeof value !== 'string' || !/^NE\d{14}$/i.test(value.trim()))
    throw new Error('请输入有效的 Netcare 单号，例如 NE20260828000800');
  return value.trim().toUpperCase();
}
export function validateCredentials(value: unknown): NetcareCredentials {
  const input = value as NetcareCredentials;
  if (!input || typeof input.cookie !== 'string' || typeof input.csrfToken !== 'string'
      || !input.cookie || !input.csrfToken || input.cookie.length > 64000 || input.csrfToken.length > 16000
      || /[\r\n]/.test(input.cookie + input.csrfToken)) throw new Error('Netcare 登录会话无效，请重新登录');
  return { cookie: input.cookie, csrfToken: input.csrfToken, ...(input.idp ? { idp: validateIdpCredentials(input.idp) } : {}) };
}
export function validateIdpCredentials(value: unknown): IdpCredentials {
  const input = value as IdpCredentials;
  if (!input || [input.cookie, input.csrfToken, input.username].some(v => typeof v !== 'string' || !v || v.length > 64000 || /[\r\n]/.test(v)))
    throw new Error('方案导出服务会话无效，请重试');
  return { cookie: input.cookie, csrfToken: input.csrfToken, username: input.username };
}
export function encryptSession(value: unknown, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}
export function decryptSession(bytes: Buffer, key: Buffer): NetcareCredentials {
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return validateCredentials(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')));
}

/** 登录凭证只经桌面父子进程管道传递；本机 HTTP API 从不返回 Cookie 或 Token。 */
export class NetcareSession {
  constructor(readonly directory: string) {}
  private get file() { return path.join(this.directory, 'netcare-session.enc'); }
  async load(): Promise<NetcareCredentials | undefined> {
    try { return decryptSession(await readFile(this.file), await readFile(path.join(this.directory, 'master.key'))); }
    catch { return undefined; }
  }
  async save(credentials: NetcareCredentials) {
    const key = await readFile(path.join(this.directory, 'master.key'));
    await writeFile(this.file + '.tmp', encryptSession(validateCredentials(credentials), key), { mode: 0o600 });
    await rename(this.file + '.tmp', this.file);
  }
  async forget() { await unlink(this.file).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; }); }
}
