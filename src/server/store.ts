import { DatabaseSync } from "node:sqlite";
import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type {
  ChecklistItem,
  ReviewResult,
} from "../agents/rfc-review/contracts.js";

export interface Rule extends ChecklistItem {
  enabled: boolean;
}
export interface RuleGroup {
  id: string;
  name: string;
  rules: Rule[];
  updatedAt: string;
}
export interface ModelSettings {
  baseUrl: string;
  model: string;
  apiKey?: string;
  hasApiKey?: boolean;
  provider: string;
  supportsImages: boolean;
  thinkingLevel: "off" | "low" | "high" | "max";
  temperature: number;
  maxTokens: number;
  contextWindow: number;
  concurrency: number;
  requestTimeoutMs: number;
}
export const DEFAULT_MODEL: ModelSettings = {
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  provider: "deepseek",
  supportsImages: true,
  thinkingLevel: "low",
  temperature: 0,
  maxTokens: 8192,
  contextWindow: 128000,
  concurrency: 8,
  requestTimeoutMs: 120000,
};
export interface TaskCheck extends ChecklistItem {
  Status: string;
  Verdict?: string;
  Finding?: string;
  Suggestion?: string;
  DocumentPath?: string;
  Selector?: string;
  Quote?: string;
}
export interface TaskRecord {
  Id: string;
  Title: string;
  GroupName: string;
  Status: "queued" | "running" | "completed" | "failed" | "cancelled";
  EntryPath: string;
  CreatedAt: string;
  UpdatedAt: string;
  Attempt: number;
  DurationMs?: number;
  LastError: string;
  Checklist: TaskCheck[];
  Documents: { Path: string; Size: number; ContentType: string }[];
  Warnings: string[];
  Model?: { name: string; baseUrl: string };
  Usage?: { input: number; output: number; cache: number };
}

/** 本地 SQLite 保存业务记录，API Key 只以加密密文持久化。 */
export class Store {
  readonly db: DatabaseSync;
  private readonly key: Buffer;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    mkdirSync(path.join(directory, "packages"), {
      recursive: true,
      mode: 0o700,
    });
    const keyPath = path.join(directory, "master.key");
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    this.key = readFileSync(keyPath);
    this.db = new DatabaseSync(path.join(directory, "studio.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, value TEXT NOT NULL);",
    );
  }
  private encrypt(value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    return Buffer.concat([
      iv,
      cipher.update(value, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  }
  private decrypt(value: string) {
    const bytes = Buffer.from(value, "base64"),
      decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        bytes.subarray(0, 12),
      );
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([
      decipher.update(bytes.subarray(12, -16)),
      decipher.final(),
    ]).toString("utf8");
  }
  preferences(): { theme: "light" | "dark" | "system" } {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE id=?")
      .get("preferences") as { value: string } | undefined;
    return row ? JSON.parse(row.value) : { theme: "system" };
  }
  savePreferences(value: { theme: "light" | "dark" | "system" }) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run("preferences", JSON.stringify(value));
    return value;
  }
  onboarding() {
    const completed = this.db.prepare("SELECT value FROM settings WHERE id=?").get("onboardingCompleted");
    return {
      completed: completed?.value === "true",
      modelReady: this.model().hasApiKey === true,
      rulesReady: this.groups().some((group) => group.rules.some((rule) => rule.enabled)),
    };
  }
  completeOnboarding() {
    const state = this.onboarding();
    if (!state.modelReady || !state.rulesReady)
      throw new Error("请先保存模型连接，并配置至少一条启用的审核规则");
    this.db.prepare("INSERT INTO settings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
      .run("onboardingCompleted", "true");
    return this.onboarding();
  }
  model(secret = false): ModelSettings {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE id=?")
      .get("model") as { value: string } | undefined;
    const saved = row ? JSON.parse(row.value) : {};
    const { encryptedKey, ...settings } = saved;
    return {
      ...DEFAULT_MODEL,
      ...settings,
      hasApiKey: !!encryptedKey,
      ...(secret
        ? { apiKey: encryptedKey ? this.decrypt(encryptedKey) : "" }
        : {}),
    };
  }
  saveModel(value: ModelSettings, clearKey = false) {
    const previous = this.model(true),
      key = clearKey ? "" : value.apiKey?.trim() || previous.apiKey || "";
    const { apiKey: _, hasApiKey: __, ...settings } = value;
    this.db
      .prepare(
        "INSERT INTO settings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(
        "model",
        JSON.stringify({
          ...settings,
          encryptedKey: key ? this.encrypt(key) : "",
        }),
      );
    return this.model();
  }
  groups(): RuleGroup[] {
    return this.db
      .prepare("SELECT value FROM groups ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(String(row.value)));
  }
  group(id: string): RuleGroup | undefined {
    return this.groups().find((group) => group.id === id);
  }
  saveGroup(group: RuleGroup) {
    this.db
      .prepare(
        "INSERT INTO groups VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(group.id, JSON.stringify(group));
    return group;
  }
  deleteGroup(id: string) {
    this.db.prepare("DELETE FROM groups WHERE id=?").run(id);
  }
  tasks(): TaskRecord[] {
    return this.db
      .prepare("SELECT value FROM tasks ORDER BY rowid DESC")
      .all()
      .map((row) => JSON.parse(String(row.value)));
  }
  task(id: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT value FROM tasks WHERE id=?").get(id);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  saveTask(task: TaskRecord) {
    task.UpdatedAt = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO tasks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(task.Id, JSON.stringify(task));
  }
  deleteTask(id: string) {
    this.db.prepare("DELETE FROM tasks WHERE id=?").run(id);
  }
  packagePath(id: string) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("任务编号无效");
    return path.join(this.directory, "packages", `${id}.zip`);
  }
  submit(id: string, attempt: number, result: ReviewResult) {
    const task = this.task(id);
    if (!task || task.Status !== "running" || task.Attempt !== attempt)
      throw new Error("任务已停止");
    const item = task.Checklist.find((item) => item.Id === result.ChecklistId);
    if (!item || item.Status === "completed")
      throw new Error("检查项已提交或不存在");
    Object.assign(item, {
      Status: "completed",
      Verdict: result.Verdict,
      Finding: result.Description,
      Suggestion: result.Suggestion,
      DocumentPath: result.DocumentPath,
      Selector: result.Selector,
      Quote: result.Quote,
    });
    this.saveTask(task);
  }
  close() {
    this.db.close();
  }
}

/** 从外部 JSON 或编辑表单导入规则，只接受规则内容，不接受既有审核结论。 */
export function validateGroup(value: any, existingId?: string): RuleGroup {
  if (
    !value ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 100
  )
    throw new Error("规则组名称为必填项，最多 100 字");
  if (!Array.isArray(value.rules) || value.rules.length > 500)
    throw new Error("每组最多 500 条规则");
  const ids = new Set<string>();
  const rules = value.rules.map((item: any) => {
    if (
      !item ||
      typeof item.Title !== "string" ||
      !item.Title.trim() ||
      item.Title.length > 500 ||
      typeof item.Description !== "string" ||
      !item.Description.trim() ||
      item.Description.length > 20000
    )
      throw new Error(
        "规则标题和描述不能为空，标题最多 500 字，描述最多 20000 字",
      );
    const id =
      typeof item.Id === "string" && item.Id.trim()
        ? item.Id.trim()
        : randomUUID();
    if (ids.has(id) || id.length > 200) throw new Error("规则 ID 重复或过长");
    ids.add(id);
    return {
      Id: id,
      Title: item.Title.trim(),
      Description: item.Description.trim(),
      Level: String(item.Level || "必要").slice(0, 50),
      Chapter: String(item.Chapter || "").slice(0, 500),
      enabled: item.enabled !== false,
    };
  });
  return {
    id: existingId || randomUUID(),
    name: value.name.trim(),
    rules,
    updatedAt: new Date().toISOString(),
  };
}

export function validateModel(value: any): ModelSettings {
  if (!value || typeof value !== "object") throw new Error("模型配置无效");
  let url: URL;
  try {
    url = new URL(String(value.baseUrl || "").trim());
  } catch {
    throw new Error("请输入完整的 API 地址，例如 https://api.example.com/v1");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "API 地址必须为 HTTP(S) 根地址，不能包含密码、查询参数或锚点",
    );
  if (
    typeof value.model !== "string" ||
    !value.model.trim() ||
    value.model.length > 200
  )
    throw new Error("请输入模型名称");
  if (!["off", "low", "high", "max"].includes(value.thinkingLevel))
    throw new Error("思考程度无效");
  for (const [key, min, max] of [
    ["maxTokens", 256, 131072],
    ["contextWindow", 8192, 2000000],
    ["concurrency", 1, 8],
    ["requestTimeoutMs", 10000, 600000],
  ] as const)
    if (
      !Number.isSafeInteger(value[key]) ||
      value[key] < min ||
      value[key] > max
    )
      throw new Error(`${key} 应在 ${min}～${max} 之间`);
  if (
    typeof value.temperature !== "number" ||
    !Number.isFinite(value.temperature) ||
    value.temperature < 0 ||
    value.temperature > 2 ||
    value.maxTokens > value.contextWindow
  )
    throw new Error("温度或输出额度无效");
  if (
    value.apiKey !== undefined &&
    (typeof value.apiKey !== "string" || value.apiKey.length > 8000)
  )
    throw new Error("API Key 无效");
  return {
    baseUrl: url
      .toString()
      .replace(/\/$/, "")
      .replace(/\/chat\/completions$/, ""),
    model: value.model.trim(),
    provider:
      url.hostname === "api.deepseek.com" || value.provider === "deepseek"
        ? "deepseek"
        : "openai-compatible",
    apiKey: value.apiKey,
    supportsImages: value.supportsImages === true,
    thinkingLevel: value.thinkingLevel,
    temperature: value.temperature,
    maxTokens: value.maxTokens,
    contextWindow: value.contextWindow,
    concurrency: value.concurrency,
    requestTimeoutMs: value.requestTimeoutMs,
  };
}
