import type { TaskRecord, TaskCheck } from "./store.js";
import { Marked, Renderer } from "marked";
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const status = (c: TaskCheck) =>
  c.Status !== "completed"
    ? "未审核"
    : c.Verdict === "failed"
      ? "需修改"
      : c.Verdict === "not_applicable"
        ? "不适用"
        : "通过";
const taskStatus: Record<string, string> = {
  queued: "排队中",
  running: "审核中",
  completed: "已完成",
  failed: "未完成",
  cancelled: "已停止",
};
const renderer = new Renderer();
renderer.html = (token) => escape(token.text);
renderer.link = function (token) {
  return this.parser.parseInline(token.tokens);
};
renderer.image = (token) => escape(token.text);
const markdown = new Marked({ renderer, gfm: true, breaks: true });
export function report(task: TaskRecord, format: "md" | "html") {
  const checks = [...task.Checklist].sort(
    (a, b) => Number(b.Verdict === "failed") - Number(a.Verdict === "failed"),
  );
  const completed = checks.filter((c) => c.Status === "completed").length;
  const issues = checks.filter((c) => c.Verdict === "failed").length;
  const meta = `状态：${taskStatus[task.Status] || task.Status} · 已审核 ${completed}/${checks.length} 项 · 需修改 ${issues} 项`;
  const note =
    "本报告为 Agent 审核结果，请结合方案原文复核；未审核项不代表通过。";
  const text = (v = "") => v.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (format === "md")
    return (
      `# ${text(task.Title)}\n\n${meta}\n\n规则组：${text(task.GroupName)}\n\n生成时间：${new Date().toISOString()}\n\n> ${note}\n\n` +
      checks
        .map(
          (c, i) =>
            `## ${i + 1}. [${status(c)}] ${text(c.Title)}\n\n等级：${text(c.Level)}${c.Chapter ? " · 章节：" + text(c.Chapter) : ""}\n\n${c.Suggestion ? "**修改建议**\n\n" + text(c.Suggestion) + "\n\n" : ""}**审核发现**\n\n${text(c.Finding || "尚未形成结论")}\n\n${c.Quote ? "**原文引用**\n\n> " + text(c.Quote).replaceAll("\n", "\n> ") + "\n\n" : ""}**检查规则**\n\n${text(c.Description)}\n\n`,
        )
        .join("")
    );
  // Offline report has no executable HTML, scripts, remote fonts, images or external dependencies.
  const block = (label: string, content?: string) =>
    content
      ? `<div class="block"><h3>${label}</h3><div class="prose">${markdown.parse(content, { async: false })}</div></div>`
      : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escape(task.Title)} · 审核报告</title><style>body{font:14px/1.8 system-ui,'Microsoft YaHei',sans-serif;color:#292929;background:#f7f7f5;max-width:960px;margin:40px auto;padding:0 25px}h1{font-size:26px}h2{font-size:17px;margin:0}h3{font-size:12px;color:#777;margin:0 0 6px}.meta{color:#777;font-size:12px}article{background:white;padding:24px;border:1px solid #ddd;border-radius:12px;margin:16px 0;break-inside:avoid}.issue{border-left:4px solid #b47435}.tag{font-size:12px;color:#96632d}.block{margin-top:18px}.prose{overflow-wrap:anywhere}pre{white-space:pre-wrap;background:#f5f5f5;padding:12px}table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:6px 10px}footer{font-size:12px;color:#777}@media print{body{background:white;margin:0;max-width:none}article{border-radius:0}}</style></head><body><h1>${escape(task.Title)}</h1><p>${meta}</p><p class="meta">规则组：${escape(task.GroupName)} · 生成时间：${new Date().toISOString()}</p><p class="meta">${note}</p>${checks.map((c, i) => `<article class="${c.Verdict === "failed" ? "issue" : ""}"><span class="tag">${status(c)} · ${escape(c.Level)}</span><h2>${i + 1}. ${escape(c.Title)}</h2>${block("修改建议", c.Suggestion)}${block("审核发现", c.Finding || "尚未形成结论")}${block("原文引用", c.Quote)}${block("检查规则", c.Description)}</article>`).join("")}<footer>Netcare RFC方案审核工具 · 本地审核报告</footer></body></html>`;
}
