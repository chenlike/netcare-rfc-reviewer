import http from "node:http";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePackage } from "../agents/rfc-review/document.js";
import { logPreview } from "../core/log-preview.js";
import {
  Store,
  validateGroup,
  validateModel,
  type TaskRecord,
} from "./store.js";
import { Engine } from "./engine.js";
import { desktopSession } from "./desktop-session.js";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};
async function body(req: http.IncomingMessage, maximum = 2 * 1024 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw new Error("上传内容超过大小限制");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function json(req: http.IncomingMessage) {
  return JSON.parse((await body(req)).toString("utf8"));
}
const summary = ({ Checklist, Documents, Warnings, ...task }: TaskRecord) => ({
  ...task,
  TotalCount: Checklist.length,
  CompletedCount: Checklist.filter((item) => item.Status === "completed")
    .length,
  FailedCount: Checklist.filter((item) => item.Verdict === "failed").length,
});

/** HTTP 仅面向回环地址；每次启动的随机令牌阻止其他网页触发本地修改和模型消费。 */
export function createApp(
  store: Store,
  engine = new Engine(store),
  options: { desktopSecret?: string } = {},
) {
  const token = randomBytes(32).toString("hex");
  const allowSession = desktopSession(options.desktopSecret);
  const webRoot = fileURLToPath(new URL("../web/", import.meta.url));
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(value));
    };
    try {
      const host = req.headers.host || "";
      if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host))
        return send({ error: "仅允许本机访问" }, 403);
      const url = new URL(req.url || "/", `http://${host}`),
        p = url.pathname;
      if (!allowSession(req, res, url)) return;
      if (p.startsWith("/api/")) {
        res.setHeader("Cache-Control", "no-store");
        const origin = req.headers.origin;
        if (origin && !/^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(origin))
          return send({ error: "请求来源不允许" }, 403);
        if (req.headers["sec-fetch-site"] === "cross-site")
          return send({ error: "请求来源不允许" }, 403);
        if (req.method !== "GET") {
          const provided = Buffer.from(
            String(req.headers["x-studio-token"] || ""),
          );
          if (
            provided.length !== token.length ||
            !timingSafeEqual(provided, Buffer.from(token))
          )
            return send({ error: "页面已失效，请刷新后再试" }, 403);
        }
        if (p === "/api/bootstrap" && req.method === "GET")
          return send({
            token,
            modelReady: store.model().hasApiKey,
            directory: store.directory,
            desktop: !!options.desktopSecret,
            preferences: store.preferences(),
          });
        if (p === "/api/preferences" && req.method === "PUT") {
          const value = await json(req);
          if (!["light", "dark", "system"].includes(value?.theme))
            throw new Error("无效的主题设置");
          return send(store.savePreferences({ theme: value.theme }));
        }
        if (p === "/api/model" && req.method === "GET")
          return send(store.model());
        if (p === "/api/model" && req.method === "PUT") {
          const value = await json(req);
          const result = store.saveModel(
            validateModel(value),
            value.clearKey === true,
          );
          engine.pump();
          return send(result);
        }
        if (p === "/api/model/test" && req.method === "POST") {
          const value = store.model(true);
          if (!value.apiKey) throw new Error("请先保存 API Key");
          const response = await fetch(`${value.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${value.apiKey}`,
            },
            signal: AbortSignal.timeout(
              Math.min(30000, value.requestTimeoutMs),
            ),
            body: JSON.stringify({
              model: value.model,
              messages: [{ role: "user", content: "只回复 OK" }],
              max_tokens: 64,
              ...(value.provider === "deepseek"
                ? { thinking: { type: "disabled" } }
                : {}),
            }),
          });
          const result: any = await response.json();
          if (!response.ok)
            throw new Error(
              `模型接口 HTTP ${response.status}：${logPreview(String(result?.error?.message || "调用失败"), [value.apiKey], 300)}`,
            );
          if (!Array.isArray(result.choices) || !result.choices.length)
            throw new Error("接口未返回有效的 Chat Completions 响应");
          return send({ message: "连接成功", model: value.model });
        }
        if (p === "/api/groups" && req.method === "GET")
          return send(store.groups());
        if (p === "/api/groups" && req.method === "POST")
          return send(store.saveGroup(validateGroup(await json(req))));
        const groupMatch = p.match(/^\/api\/groups\/([a-f0-9-]+)$/);
        if (groupMatch) {
          if (!store.group(groupMatch[1]!))
            return send({ error: "规则组不存在" }, 404);
          if (req.method === "PUT")
            return send(
              store.saveGroup(validateGroup(await json(req), groupMatch[1])),
            );
          if (req.method === "DELETE") {
            store.deleteGroup(groupMatch[1]!);
            return send({ ok: true });
          }
        }
        if (p === "/api/tasks" && req.method === "GET")
          return send(store.tasks().map(summary));
        if (p === "/api/tasks" && req.method === "POST") {
          const group = store.group(url.searchParams.get("group") || "");
          if (!group?.rules.some((rule) => rule.enabled))
            throw new Error("请选择至少包含一条启用规则的规则组");
          if (!store.model().hasApiKey)
            throw new Error("请先在模型配置中填写 API Key");
          const fileName = url.searchParams.get("fileName") || "方案.zip";
          if (!/\.zip$/i.test(fileName) || fileName.length > 500)
            throw new Error("请选择 ZIP 方案包");
          const raw = await body(req, 50 * 1024 * 1024),
            pkg = await parsePackage(raw);
          const assets = pkg.assets || [];
          if (
            assets.length > 2000 ||
            assets.reduce((n, item) => n + item.size, 0) > 150 * 1024 * 1024
          )
            throw new Error("方案解压后超过 150 MB 或 2000 个文件");
          const now = new Date().toISOString(),
            id = randomUUID();
          const task: TaskRecord = {
            Id: id,
            Title: path
              .basename(fileName.replaceAll("\\", "/"))
              .replace(/\.zip$/i, ""),
            GroupName: group.name,
            Status: "queued",
            EntryPath:
              pkg.documents.find((doc) =>
                /(^|\/)zh-cn_bookmap_[^/]+\.html$/i.test(doc.path),
              )?.path ||
              pkg.documents.find((doc) => /(^|\/)index\.html?$/i.test(doc.path))
                ?.path ||
              pkg.documents[0]!.path,
            CreatedAt: now,
            UpdatedAt: now,
            Attempt: 0,
            LastError: "",
            Checklist: group.rules
              .filter((rule) => rule.enabled)
              .map(({ enabled, ...rule }) => ({ ...rule, Status: "pending" })),
            Documents: assets.map((item) => ({
              Path: item.path,
              Size: item.size,
              ContentType:
                MIME[path.extname(item.path).toLowerCase()] ||
                "application/octet-stream",
            })),
            Warnings: pkg.warnings,
          };
          await writeFile(store.packagePath(id), raw, {
            flag: "wx",
            mode: 0o600,
          });
          try {
            store.saveTask(task);
          } catch (error) {
            await unlink(store.packagePath(id));
            throw error;
          }
          engine.pump();
          return send(summary(task), 201);
        }
        const taskMatch = p.match(
          /^\/api\/tasks\/([a-f0-9-]+)(?:\/(download|report|cancel|retry))?$/,
        );
        if (taskMatch) {
          const id = taskMatch[1]!,
            action = taskMatch[2],
            task = store.task(id);
          if (!task) return send({ error: "任务不存在" }, 404);
          if (action === "download" && req.method === "GET") {
            res.setHeader("Content-Type", "application/zip");
            res.setHeader(
              "Content-Disposition",
              `attachment; filename*=UTF-8''${encodeURIComponent(task.Title + ".zip")}`,
            );
            return res.end(await readFile(store.packagePath(id)));
          }
          if (action === "report" && req.method === "GET") {
            res.setHeader(
              "Content-Disposition",
              `attachment; filename*=UTF-8''${encodeURIComponent(task.Title + "-审核结果.json")}`,
            );
            return send(task);
          }
          if (action === "cancel" && req.method === "POST") {
            engine.cancel(id);
            return send({ ok: true });
          }
          if (action === "retry" && req.method === "POST") {
            engine.retry(id);
            return send({ ok: true });
          }
          if (!action && req.method === "GET")
            return send({
              Task: summary(task),
              Checklist: task.Checklist,
              Documents: task.Documents,
              Warnings: task.Warnings,
              Activity:
                task.Status === "running"
                  ? engine.activity.get(id) || null
                  : null,
            });
          if (!action && req.method === "DELETE") {
            engine.remove(id);
            await unlink(store.packagePath(id)).catch(() => {});
            return send({ ok: true });
          }
        }
        return send({ error: "接口不存在" }, 404);
      }
      if (req.method !== "GET") return send({ error: "方法不允许" }, 405);
      const relative =
        p === "/" ? "index.html" : decodeURIComponent(p).replace(/^\/+/, "");
      const file = path.resolve(webRoot, relative);
      if (!file.startsWith(webRoot)) return send({ error: "路径无效" }, 403);
      try {
        const raw = await readFile(file);
        res.setHeader(
          "Content-Type",
          `${MIME[path.extname(file)] || "application/octet-stream"}; charset=utf-8`,
        );
        res.end(raw);
      } catch {
        return send(
          {
            error:
              "界面尚未构建，请先执行 npm run build；开发模式请打开 http://127.0.0.1:5188",
          },
          404,
        );
      }
    } catch (error) {
      let key = "";
      try {
        key = store.model(true).apiKey || "";
      } catch {
        /* 密钥文件损坏时仍返回可读错误。 */
      }
      send(
        {
          error: logPreview(
            error instanceof Error ? error.message : String(error),
            [key],
            600,
          ),
        },
        400,
      );
    }
  });
  return { server, engine };
}
