import { randomUUID } from 'node:crypto';
import { NetcareSession, NETCARE_ORIGIN, validateCredentials, validateIdpCredentials, validateNetcareNumber, type NetcareCredentials, type IdpCredentials } from './netcare-session.js';

export const IDP_ORIGIN = 'https://kdp.idp.huawei.com';
export async function limitedBody(response: Response, maximum: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('服务器未返回方案内容');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      size += value.byteLength;
      if (size > maximum) throw new Error('下载内容超过大小限制（方案包最大 50 MB）');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export class ExportLoginRequired extends Error {
  constructor() { super('方案导出服务需要连接统一登录'); }
}
export async function verifyExportSession(credentials: IdpCredentials, signal: AbortSignal, transport: typeof fetch = fetch): Promise<IdpCredentials> {
  const headers = { Cookie: credentials.cookie, 'X-CSRF-TOKEN': credentials.csrfToken };
  const check = await transport(IDP_ORIGIN + '/ows1/services/sso/getloginuser', { headers, redirect:'manual', signal });
  if (!check.ok || check.status === 204) throw new ExportLoginRequired();
  let user: any;
  try { user = JSON.parse((await limitedBody(check, 1024 * 1024)).toString('utf8')); }
  catch { throw new ExportLoginRequired(); }
  if (!user?.uid || !user?.employeeNumber || user.uid !== credentials.username) throw new ExportLoginRequired();
  return validateIdpCredentials({ ...credentials, csrfToken: String(user.employeeNumber) });
}
export async function downloadHtml(number: string, credentials: IdpCredentials, signal: AbortSignal, transport: typeof fetch = fetch) {
  const verified = await verifyExportSession(credentials, signal, transport);
  const params = new URLSearchParams({ id: validateNetcareNumber(number), username: verified.username, from:'ows' });
  const response = await transport(`${IDP_ORIGIN}/ows1/services/ows/downloadHtmlZip?${params}`, {
    headers: { Cookie: verified.cookie, 'X-CSRF-TOKEN': verified.csrfToken }, redirect:'manual', signal,
  });
  if ([301,302,303,307,308,401,403].includes(response.status)) throw new ExportLoginRequired();
  if (!response.ok) throw new Error(`方案下载失败（HTTP ${response.status}），请稍后重试`);
  const raw = await limitedBody(response, 50 * 1024 * 1024);
  if (raw.length < 4 || raw.readUInt32LE(0) !== 0x04034b50)
    throw new Error('方案导出服务未返回 HTML 方案包，请确认该单已有数字化方案且账号有下载权限');
  return raw;
}

export const NETCARE_QUERY = '/adc-service/web/rest/v1/services/NetCareRFCEbgService/cs_nc_ne_network_tuning_query/ne_query_rfc_getList_for_report';
export class NetcareLoginRequired extends Error {
  constructor() { super('Netcare 登录已失效，请点击登录后重试'); }
}
export function csrfHeader(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const token = Array.isArray(parsed) ? parsed[0]?.csrfToken : parsed?.csrfToken;
    if (typeof token === 'string' && token && !/[\r\n]/.test(token)) return token;
  } catch { /* 兼容旧版纯字符串 Token。 */ }
  if (!raw || raw.startsWith('[') || raw.startsWith('{')) throw new NetcareLoginRequired();
  return raw;
}
export class NetcareClient {
  constructor(private credentials: NetcareCredentials, private transport: typeof fetch = fetch) {}
  async request(endpoint: string, data: unknown, signal?: AbortSignal): Promise<any> {
    if (!endpoint.startsWith('/adc-service/')) throw new Error('无效的 Netcare 服务地址');
    const response = await this.transport(NETCARE_ORIGIN + endpoint, {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: this.credentials.cookie, 'x-gde-csrf-token': csrfHeader(this.credentials.csrfToken),
        'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json',
        Origin: NETCARE_ORIGIN, Referer: NETCARE_ORIGIN + '/adc-web/ui/standalone/index.html',
        'x-gde-target-app': 'NetCareRFCEbgService',
        'x-gde-src-page': '/NetCareRFCEbgService/cs_nc_ne_network_tuning_query/ne_workflow_rfc_getList_for_report',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36' },
      body: JSON.stringify(data), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
    });
    if ([301,302,303,307,308,401,403].includes(response.status)) throw new NetcareLoginRequired();
    if (!response.ok) throw new Error(`Netcare 请求失败（HTTP ${response.status}），请稍后重试`);
    const raw = (await limitedBody(response, 8 * 1024 * 1024)).toString('utf8');
    let value: any;
    try { value = JSON.parse(raw); } catch { throw new NetcareLoginRequired(); }
    if (value.code !== undefined && ![0,'0','0000','200',200].includes(value.code)) {
      if (/session|login|csrf|token|登录/i.test(JSON.stringify(value))) throw new NetcareLoginRequired();
      throw new Error('Netcare 未能完成查询，请确认账号有访问该作业单的权限');
    }
    return value;
  }
  query(number: string, signal?: AbortSignal) {
    // 官方列表接口要求空筛选字段也显式传递，省略会触发服务端 500。
    const emptyFields = 'ne_country_code query_time_year query_time_quarter query_time_month query_time_start query_time_end region_code rep_office_code country_code important_network_flag company_level network_id customer_org product_line category_id product_id currentoperator originator owner solution_developer fsip_group fsip_solution_reviewer l1_solution_reviewer history_operator nt_severity is_escalate_l2 l2_solution_reviewer pse_group is_escalate_l3 l3_solution_reviewer rde_group is_solution_verified verification_mode group_name emergency_change source_type request_type operation service_type bu_type delivery_model delivery_model_child customer_implementation special_scene_identification change_type urgent_review online_solution auth_type service_report try_send_sms delivery_roip_group_code is_auto_close spoc_flag';
    return this.request(NETCARE_QUERY, { ...Object.fromEntries(emptyFields.split(' ').map(key => [key, ''])), dir:'DESC',sort:'lastupdatetime',active:'1',beneficiary_bg:'EBG',
      orderid:number,current_phase:'',query_type:'query',scenes_rep_id_list:'',report_list_id:'nt_workflow_rfc_getList_for_report',
      authenticationMode:'1',archive:'',time_type:'CreateTime',start:0,limit:35 }, signal);
  }
}
export type NetcareState = 'disconnected' | 'login' | 'verifying' | 'ready' | 'downloading' | 'error';
export class NetcareService {
  readonly session: NetcareSession;
  private state: NetcareState = 'disconnected';
  private message = '';
  private loginGeneration = 0;
  private loginTimer?: ReturnType<typeof setTimeout>;
  private client?: NetcareClient;
  private loginController?: AbortController;
  private pendingLogin?: { credentials: NetcareCredentials; client: NetcareClient };
  private verifyingExport = false;
  private exportWait?: { id: string; resolve: (value: IdpCredentials) => void; reject: (error: Error) => void };
  private downloadController?: AbortController;
  constructor(directory: string, readonly desktop: boolean, private emit = (value: unknown) => console.log(JSON.stringify(value))) {
    this.session = new NetcareSession(directory);
  }
  async status() {
    return { available: this.desktop, state: this.state, message: this.message, cached: !!await this.session.load() };
  }
  async login(clear = false) {
    if (!this.desktop) throw new Error('请在桌面程序中连接 Netcare');
    if (this.state === 'downloading') throw new Error('正在导入方案，请稍后再登录');
    if (this.state === 'verifying' || this.state === 'login') return;
    const generation = ++this.loginGeneration;
    this.loginController = new AbortController();
    this.pendingLogin = undefined; this.verifyingExport = false;
    this.state = 'login'; this.message = '请在弹窗中登录，查询与下载服务均连接成功后会自动关闭';
    if (clear) { this.client = undefined; await this.session.forget(); }
    if (generation !== this.loginGeneration) return;
    clearTimeout(this.loginTimer);
    this.loginTimer = setTimeout(() => this.cancelLogin('登录等待已超时，请重新打开登录窗口'), 10 * 60 * 1000);
    this.loginTimer.unref();
    this.emit({ event: 'netcare_login', clear, requestId: String(generation) });
  }
  async receive(value: any) {
    if (!value || typeof value !== 'object') return;
    if (typeof value?.event === 'string' && value.event.startsWith('netcare_export_')) {
      const pending = this.exportWait;
      if (!pending || value.requestId !== pending.id) return;
      if (value.event === 'netcare_export_credentials') {
        try { pending.resolve(validateIdpCredentials(value)); }
        catch { pending.reject(new Error('无法读取方案导出会话，请重试')); }
      } else if (value.event === 'netcare_export_closed' || value.event === 'netcare_export_error') {
        pending.reject(new Error('方案导出服务连接已取消，请重新导入'));
      }
      return;
    }
    if (value.requestId !== String(this.loginGeneration)) return;
    if (value.event === 'netcare_login_closed') {
      if (this.state === 'login' || this.state === 'verifying') this.cancelLogin('登录窗口已关闭');
      return;
    }
    if (value.event === 'netcare_login_error') { this.cancelLogin('登录窗口未能完成连接，请重试'); return; }
    if (value.event === 'netcare_login_export_credentials') {
      if (this.state !== 'verifying' || !this.pendingLogin || this.verifyingExport) return;
      const generation = this.loginGeneration, pending = this.pendingLogin;
      this.verifyingExport = true;
      try {
        const idp = await verifyExportSession(validateIdpCredentials(value), AbortSignal.any([this.loginController!.signal, AbortSignal.timeout(60000)]));
        if (generation !== this.loginGeneration) return;
        await this.session.save({ ...pending.credentials, idp });
        if (generation !== this.loginGeneration) return;
        this.client = pending.client; this.pendingLogin = undefined;
        this.state = 'ready'; this.message = 'Netcare 与方案下载服务均已连接，登录会话已保存';
        clearTimeout(this.loginTimer);
        this.emit({ event:'netcare_login_complete' });
      } catch {
        if (generation === this.loginGeneration) this.message = 'Netcare 已连接，方案下载服务尚未验证成功，请保留当前弹窗，系统将重试';
      } finally { if (generation === this.loginGeneration) this.verifyingExport = false; }
      return;
    }
    if (value.event !== 'netcare_credentials' || this.state !== 'login') return;
    const generation = this.loginGeneration;
    this.state = 'verifying'; this.message = '正在验证登录会话…';
    try {
      const credentials = validateCredentials(value);
      const client = new NetcareClient(credentials);
      await client.query('NE00000000000000', this.loginController!.signal);
      if (generation !== this.loginGeneration) return;
      this.pendingLogin = { credentials, client };
      this.message = 'Netcare 已连接，正在同一窗口连接方案下载服务；如华为要求验证，请在该窗口完成';
      this.emit({ event:'netcare_login_export', requestId:String(generation) });
    } catch (error) {
      if (generation !== this.loginGeneration) return;
      this.state = 'login';
      this.message = `登录会话验证失败：${error instanceof Error ? error.message : '请检查网络'}。请保留弹窗，系统将重试。`;
    }
  }
  cancelLogin(message = '已取消登录') {
    if (this.state === 'downloading') { this.downloadController?.abort(); return; }
    this.loginGeneration++;
    this.loginController?.abort(); this.pendingLogin = undefined; this.verifyingExport = false;
    clearTimeout(this.loginTimer);
    this.state = 'disconnected'; this.message = message;
    this.emit({ event: 'netcare_login_cancel' });
  }
  async connection() {
    if (this.client) return this.client;
    const saved = await this.session.load();
    if (!saved) throw new NetcareLoginRequired();
    this.client = new NetcareClient(saved);
    return this.client;
  }
  private async exportConnection(number: string, signal: AbortSignal): Promise<IdpCredentials> {
    if (!this.desktop) throw new Error('请在桌面程序中连接方案导出服务');
    this.message = '正在连接方案导出服务，统一登录完成后窗口会自动关闭…';
    try {
      return await new Promise<IdpCredentials>((resolve, reject) => {
        const id = randomUUID();
        const abort = () => reject(new Error('方案导入已超时或取消，请重试'));
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once:true });
        const finish = () => signal.removeEventListener('abort', abort);
        this.exportWait = { id, resolve: value => { finish(); resolve(value); }, reject: error => { finish(); reject(error); } };
        this.emit({ event:'netcare_export_login', requestId:id, number });
      });
    } finally {
      this.exportWait = undefined;
      this.emit({ event:'netcare_export_complete' });
    }
  }
  async download(input: unknown): Promise<{ raw: Buffer; fileName: string }> {
    const number = validateNetcareNumber(input);
    if (!this.desktop) throw new Error('请使用桌面程序从 Netcare 导入');
    if (['login','verifying','downloading'].includes(this.state)) throw new Error('Netcare 正在连接或导入，请稍后重试');
    this.state = 'downloading'; this.message = '正在查询 Netcare 作业单…';
    this.downloadController = new AbortController();
    const signal = AbortSignal.any([this.downloadController.signal, AbortSignal.timeout(5 * 60 * 1000)]);
    try {
      const client = await this.connection();
      const result = await client.query(number, signal);
      const row = result.results?.find((r: any) => r.orderid === number);
      if (!row) throw new Error('未找到该 Netcare 单号，请确认单号及账号访问权限');
      const config = await client.request('/adc-service/web/rest/v1/legacy/services/app.service.cs_nc_solution_center.cs_nc_solution_center_url_configure_get_service', {
        order_id:number,customer_org:row.customer_org,configure_key:'IDP_url_new',
      }, signal);
      if (new URL(config.result?.configure_value || NETCARE_ORIGIN).origin !== IDP_ORIGIN)
        throw new Error('此作业单使用的方案导出服务暂不支持，请从 Netcare 下载 HTML ZIP 后上传');
      const saved = await this.session.load();
      if (!saved) throw new NetcareLoginRequired();
      let idp = saved.idp, raw: Buffer | undefined;
      if (idp) {
        try { raw = await downloadHtml(number, idp, signal); }
        catch (error) { if (!(error instanceof ExportLoginRequired)) throw error; }
      }
      if (!raw) {
        idp = await this.exportConnection(number, signal);
        this.message = '正在下载 HTML 方案包…';
        raw = await downloadHtml(number, idp, signal);
        await this.session.save({ ...saved, idp });
      }
      this.state = 'ready'; this.message = '方案已下载，正在创建审核任务';
      const title = typeof row.title === 'string' ? row.title.trim().replace(/[\\/]/g, ' ') : '';
      return { raw, fileName: `${number}${title ? ' ' + title.slice(0, 350) : ''}.zip` };
    } catch (error) {
      this.state = 'error';
      if (error instanceof NetcareLoginRequired) { this.client = undefined; await this.session.forget(); }
      this.message = signal.aborted ? '方案下载超时，请检查网络后重试' : error instanceof Error ? error.message : '方案下载失败，请重试';
      throw new Error(this.message);
    } finally { this.downloadController = undefined; }
  }
  close() { clearTimeout(this.loginTimer); this.loginGeneration++; this.loginController?.abort(); this.pendingLogin = undefined; this.downloadController?.abort(); }
}
