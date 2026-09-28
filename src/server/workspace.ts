import { readFile, stat, writeFile, unlink, statfs } from "node:fs/promises";
import path from "node:path";
import { MIME } from "./mime.js";
import JSZip from "jszip";
import yauzl from "yauzl";
import {
  Store,
  validateGroup,
  type TaskRecord,
  type TaskCheck,
} from "./store.js";
import { parsePackage } from "../agents/rfc-review/document.js";
import { logPreview } from "../core/log-preview.js";

export const BACKUP_LIMIT = 250 * 1024 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const string = (v: unknown, max = 20000) => {
  if (typeof v !== "string" || v.length > max)
    throw new Error("备份字段无效或过长");
  return v;
};
export async function workspaceInfo(store: Store) {
  const tasks = store.tasks();
  let bytes = 0,
    missing = 0;
  for (const task of tasks)
    try {
      bytes += (await stat(store.packagePath(task.Id))).size;
    } catch {
      missing++;
    }
  let availableBytes: number | null = null;
  try {
    const disk = await statfs(store.directory);
    availableBytes = disk.bavail * disk.bsize;
  } catch {}
  return {
    version: "1.1.0",
    directory: store.directory,
    taskCount: tasks.length,
    groupCount: store.groups().length,
    activeCount: tasks.filter((t) => ["running", "queued"].includes(t.Status))
      .length,
    resumableCount: tasks.filter((t) =>
      ["failed", "cancelled"].includes(t.Status),
    ).length,
    packageBytes: bytes,
    availableBytes,
    missingPackages: missing,
    backupLimit: BACKUP_LIMIT,
  };
}
export function diagnostics(store: Store) {
  const tasks = store.tasks(),
    key = store.model(true).apiKey || "";
  return {
    version: "1.1.0",
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    model: {
      provider: store.model().provider,
      configured: store.model().hasApiKey,
    },
    taskCounts: Object.fromEntries(
      ["queued", "running", "completed", "failed", "cancelled"].map((s) => [
        s,
        tasks.filter((t) => t.Status === s).length,
      ]),
    ),
    recentErrors: tasks
      .filter((t) => t.LastError)
      .slice(0, 20)
      .map((t) => ({
        status: t.Status,
        attempt: t.Attempt,
        updatedAt: t.UpdatedAt,
        error: logPreview(t.LastError, [key], 400),
      })),
  };
}
/** Snapshot records before the first await. HTTP mutations are excluded for the operation. */
export async function exportWorkspace(store: Store) {
  const snapshot = {
    format: "rfc-studio-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    groups: store.groups(),
    tasks: store.tasks().map(({ Model, ...task }) => task),
  };
  if (snapshot.tasks.length > 500 || snapshot.groups.length > 500)
    throw new Error(
      "自动备份最多支持 500 个任务和 500 个规则组，请关闭程序后备份整个数据目录",
    );
  const manifest = JSON.stringify(snapshot);
  if (Buffer.byteLength(manifest) > 10 * 1024 * 1024)
    throw new Error("记录过大，请关闭程序后备份整个数据目录");
  let size = Buffer.byteLength(manifest);
  for (const task of snapshot.tasks) {
    size += (await stat(store.packagePath(task.Id))).size;
    if (size > BACKUP_LIMIT)
      throw new Error("工作空间超过 250 MB，请关闭程序后备份整个数据目录");
  }
  const archive = new JSZip();
  archive.file("workspace.json", manifest);
  for (const task of snapshot.tasks)
    archive.file(
      `packages/${task.Id}.zip`,
      await readFile(store.packagePath(task.Id)),
    );
  return archive.generateAsync({ type: "nodebuffer", compression: "STORE" });
}
/** Read bounded bytes with strict names; never extract arbitrary paths or trust ZIP size headers alone. */
export async function readBackup(raw: Buffer): Promise<Map<string, Buffer>> {
  if (!raw.length || raw.length > BACKUP_LIMIT + 1024 * 1024)
    throw new Error("备份文件最大 250 MB");
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(
      raw,
      { lazyEntries: true, validateEntrySizes: true },
      (err, zip) => {
        if (err || !zip) return reject(new Error("无法读取备份 ZIP"));
        const files = new Map<string, Buffer>();
        const names = new Set<string>();
        let total = 0,
          count = 0,
          failed = false;
        const fail = (e: unknown) => {
          if (!failed) {
            failed = true;
            zip.close();
            reject(e);
          }
        };
        zip.on("error", () =>
          fail(new Error("备份 ZIP 已损坏或包含不安全路径")),
        );
        zip.on("end", () => {
          if (!failed) resolve(files);
        });
        zip.on("entry", (entry: yauzl.Entry) => {
          const name = entry.fileName;
          if (
            ++count > 502 ||
            names.has(name) ||
            entry.isEncrypted() ||
            ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000 ||
            !(
              name === "workspace.json" ||
              name === "packages/" ||
              /^packages\/[a-f0-9-]{36}\.zip$/i.test(name)
            )
          )
            return fail(new Error("备份含未知、重复或不安全的文件"));
          names.add(name);
          if (name === "packages/") {
            zip.readEntry();
            return;
          }
          const max =
            name === "workspace.json" ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
          if (
            entry.uncompressedSize > max ||
            total + entry.uncompressedSize > BACKUP_LIMIT
          )
            return fail(new Error("备份解压内容超出限制"));
          zip.openReadStream(entry, (e, stream) => {
            if (e || !stream) return fail(new Error("备份内容已损坏"));
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on("error", fail);
            stream.on("data", (chunk: Buffer) => {
              size += chunk.length;
              total += chunk.length;
              if (size > max || total > BACKUP_LIMIT) {
                stream.destroy();
                fail(new Error("备份解压内容超出限制"));
              } else chunks.push(chunk);
            });
            stream.on("end", () => {
              if (!failed) {
                files.set(name, Buffer.concat(chunks));
                zip.readEntry();
              }
            });
          });
        });
        zip.readEntry();
      },
    ),
  );
}
/** Restore only into an empty workspace; no credentials imported, no tasks automatically run. */
export async function importWorkspace(store: Store, raw: Buffer) {
  if (store.tasks().length || store.groups().length)
    throw new Error(
      "为避免覆盖数据，只能在没有任务和规则组的空工作空间恢复备份",
    );
  const files = await readBackup(raw);
  const manifest = files.get("workspace.json");
  if (!manifest) throw new Error("不是 RFC Studio 备份文件");
  const input = JSON.parse(manifest.toString("utf8"));
  if (
    input.format !== "rfc-studio-backup" ||
    input.version !== 1 ||
    !Array.isArray(input.groups) ||
    !Array.isArray(input.tasks) ||
    input.groups.length > 500 ||
    input.tasks.length > 500
  )
    throw new Error("备份格式或版本不支持");
  const groups = input.groups.map((g: any) => validateGroup(g));
  const tasks: TaskRecord[] = [];
  const ids = new Set<string>();
  for (const source of input.tasks) {
    if (!source || !uuid.test(source.Id) || ids.has(source.Id))
      throw new Error("备份任务编号无效或重复");
    ids.add(source.Id);
    const rawPackage = files.get(`packages/${source.Id}.zip`);
    if (!rawPackage) throw new Error("备份缺少方案包");
    const pkg = await parsePackage(rawPackage);
    if ((pkg.assets?.length || 0) > 2000) throw new Error("方案资源过多");
    if (
      !Array.isArray(source.Checklist) ||
      !source.Checklist.length ||
      source.Checklist.length > 500
    )
      throw new Error("备份检查项无效");
    const rules = validateGroup({
      name: "snapshot",
      rules: source.Checklist,
    }).rules;
    const checks: TaskCheck[] = rules.map((rule, i) => {
      const old = source.Checklist[i];
      const completed = old.Status === "completed";
      if (
        completed &&
        !["failed", "passed", "not_applicable"].includes(old.Verdict)
      )
        throw new Error("备份审核结论无效");
      const { enabled, ...base } = rule;
      return {
        ...base,
        Status: completed ? "completed" : "pending",
        ...(completed
          ? {
              Verdict: old.Verdict,
              Finding: string(old.Finding || ""),
              Suggestion: string(old.Suggestion || ""),
              DocumentPath: string(old.DocumentPath || "", 1000),
              Selector: string(old.Selector || "", 4000),
              Quote: string(old.Quote || ""),
            }
          : {}),
      };
    });
    const complete = checks.every((c) => c.Status === "completed");
    const usage = source.Usage;
    if (
      usage &&
      !["input", "output", "cache"].every(
        (k) => Number.isSafeInteger(usage[k]) && usage[k] >= 0,
      )
    )
      throw new Error("备份用量统计无效");
    if (
      source.DurationMs !== undefined &&
      (!Number.isSafeInteger(source.DurationMs) || source.DurationMs < 0)
    )
      throw new Error("备份耗时统计无效");
    const created = string(source.CreatedAt, 100);
    if (!Number.isFinite(Date.parse(created))) throw new Error("备份时间无效");
    tasks.push({
      Id: source.Id,
      Title: string(source.Title, 500),
      GroupName: string(source.GroupName, 100),
      Status: complete ? "completed" : "cancelled",
      EntryPath:
        pkg.documents.find((d) => d.path === source.EntryPath)?.path ||
        pkg.documents[0]!.path,
      CreatedAt: created,
      UpdatedAt: new Date().toISOString(),
      Attempt: 0,
      ...(usage
        ? {
            Usage: {
              input: usage.input,
              output: usage.output,
              cache: usage.cache,
            },
          }
        : {}),
      DurationMs: source.DurationMs || 0,
      LastError: complete ? "" : "从备份恢复，点击继续审核处理未完成项。",
      Checklist: checks,
      Documents: (pkg.assets || []).map((a) => ({
        Path: a.path,
        Size: a.size,
        ContentType:
          MIME[path.extname(a.path).toLowerCase()] ||
          "application/octet-stream",
      })),
      Warnings: [...pkg.warnings, "此任务从本地备份恢复。"],
    });
  }
  if (files.size !== tasks.length + 1)
    throw new Error("备份包含未关联的方案包");
  // Recheck after asynchronous validation. Caller excludes all concurrent mutations.
  if (store.tasks().length || store.groups().length)
    throw new Error("工作空间已发生变化，请重新打开后重试");
  const written: string[] = [];
  try {
    for (const task of tasks) {
      const file = store.packagePath(task.Id);
      await writeFile(file, files.get(`packages/${task.Id}.zip`)!, {
        flag: "wx",
        mode: 0o600,
      });
      written.push(file);
    }
    store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const g of groups) store.saveGroup(g);
      for (const t of tasks) store.saveTask(t);
      store.db.exec("COMMIT");
    } catch (e) {
      store.db.exec("ROLLBACK");
      throw e;
    }
  } catch (e) {
    for (const file of written) await unlink(file).catch(() => {});
    throw e;
  }
  return { tasks: tasks.length, groups: groups.length };
}
