import { DatabaseSync, backup } from "node:sqlite";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** One-time upgrade from the old per-user directory. Existing installation data always wins. */
export async function migrateLegacyData(directory: string, legacy?: string) {
  const destination = path.resolve(directory);
  if (!legacy || path.resolve(legacy) === destination || existsSync(path.join(destination, "studio.sqlite"))) return false;
  const source = path.resolve(legacy);
  if (!existsSync(path.join(source, "studio.sqlite"))) return false;
  const lock = path.join(source, "instance.lock");
  if (existsSync(lock)) {
    const pid = Number(await readFile(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("旧版数据锁无效，请先检查旧数据目录");
    try { process.kill(pid, 0); throw new Error("旧版审核程序仍在运行，请先关闭旧版，再启动 Netcare"); }
    catch (error: any) { if (error.code !== "ESRCH") throw error; }
  }
  if (existsSync(destination) && (await readdir(destination)).length)
    throw new Error("安装目录的 data 文件夹已有不完整数据，已停止迁移以避免覆盖，请检查该目录");

  const parent = path.dirname(destination);
  const staging = path.join(parent, `.netcare-data-migration-${randomUUID()}`);
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    const keyFile = path.join(source, "master.key");
    if (!(await lstat(keyFile)).isFile() || (await readFile(keyFile)).length !== 32)
      throw new Error("旧版密钥文件缺失或损坏，无法安全迁移模型配置");
    await copyFile(keyFile, path.join(staging, "master.key"));
    const database = new DatabaseSync(path.join(source, "studio.sqlite"), { readOnly: true });
    try { await backup(database, path.join(staging, "studio.sqlite")); }
    finally { database.close(); }
    const copied = new DatabaseSync(path.join(staging, "studio.sqlite"));
    try {
      if (copied.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("旧版数据库校验失败，已保留原数据");
    } finally { copied.close(); }
    const packages = path.join(source, "packages");
    await mkdir(path.join(staging, "packages"));
    if (existsSync(packages)) {
      if (!(await lstat(packages)).isDirectory()) throw new Error("旧版方案目录无效");
      for (const entry of await readdir(packages, { withFileTypes: true })) {
        if (!entry.isFile()) throw new Error("旧版方案目录包含非常规文件，已停止自动迁移");
        await copyFile(path.join(packages, entry.name), path.join(staging, "packages", entry.name));
      }
    }
    // Publish only the complete copy. Never merge into or overwrite an existing workspace.
    if (existsSync(destination)) await rmdir(destination);
    await rename(staging, destination);
    return true;
  } finally {
    if (path.dirname(staging) !== parent || !path.basename(staging).startsWith(".netcare-data-migration-")) throw new Error("迁移临时目录无效");
    await rm(staging, { recursive: true, force: true });
  }
}
