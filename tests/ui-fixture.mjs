// 仅手动 UI 测试使用。隔离的临时数据库和假 Reviewer，不调用真实模型。
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store, DEFAULT_MODEL, validateGroup } from "../dist/server/store.js";
import { createApp } from "../dist/server/app.js";
import { Engine } from "../dist/server/engine.js";
const directory = await mkdtemp(path.join(os.tmpdir(), "rfc-studio-ui-"));
const store = new Store(directory);
if (!process.argv.includes("--empty")) {
store.saveModel({
  ...DEFAULT_MODEL,
  apiKey: "ui-fixture-key",
  baseUrl: "http://127.0.0.1:1",
  model: "UI TEST ONLY",
});
store.saveGroup(
  validateGroup({
    name: "UI 验证规则（模拟）",
    rules: JSON.parse(await readFile("examples/checklist.json", "utf8")),
  }),
);
}
const engine = new Engine(store, () => ({
  async review(ctx) {
    for (const item of ctx.pending) {
      ctx.assertActive();
      const block =
        ctx.pkg.blocks.find((b) =>
          item.Id === "scope"
            ? b.text.includes("2台") || b.text.includes("2 台")
            : item.Id === "window"
              ? b.text.includes("30")
              : b.kind === "image",
        ) || ctx.pkg.blocks[0];
      await ctx.submit({
        ChecklistId: item.Id,
        Verdict: item.Id === "window" ? "failed" : "passed",
        Description:
          item.Id === "window"
            ? "维护窗口只有 **30 分钟**，低于规则要求的 **60 分钟**。\n\n已核验实施计划。"
            : "**模拟通过**：仅用于界面验证。",
        Suggestion:
          item.Id === "window"
            ? "1. 将维护窗口延长至 **至少 60 分钟**。\n2. 同步更新通知和回退时间安排。"
            : "",
        Level: item.Level,
        DocumentPath: block.documentPath,
        Selector: block.selector,
        Quote: block.text,
      });
    }
  },
}));
const { server } = createApp(store, engine);
server.listen(4329, "127.0.0.1", () =>
  console.log("隔离 UI 测试：http://127.0.0.1:4329"),
);
async function stop() {
  await engine.stop();
  server.closeAllConnections();
  server.close();
  store.close();
  const target = path.resolve(directory);
  if (
    path.dirname(target) === path.resolve(os.tmpdir()) &&
    path.basename(target).startsWith("rfc-studio-ui-")
  )
    await rm(target, { recursive: true, force: true });
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
