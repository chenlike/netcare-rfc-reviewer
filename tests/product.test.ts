import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import {
  Store,
  DEFAULT_MODEL,
  validateGroup,
  type TaskRecord,
} from "../src/server/store.js";
import {
  exportWorkspace,
  importWorkspace,
  readBackup,
  diagnostics,
} from "../src/server/workspace.js";
import { testModel } from "../src/server/model-test.js";
import { report } from "../src/server/report.js";
import { createApp } from "../src/server/app.js";
import { Engine } from "../src/server/engine.js";
import { zipHtml } from "./helpers.js";

async function store(t: any) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rfc-product-test-"));
  const value = new Store(directory);
  t.after(async () => {
    value.close();
    assert.equal(
      path.dirname(path.resolve(directory)),
      path.resolve(os.tmpdir()),
    );
    assert.ok(path.basename(directory).startsWith("rfc-product-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  return value;
}
async function seed(s: Store) {
  const group = s.saveGroup(
    validateGroup({
      name: "Production standards",
      rules: [
        {
          Id: "one",
          Title: "Availability",
          Description: "Verify the plan",
          Level: "必要",
        },
      ],
    }),
  );
  const task: TaskRecord = {
    Id: randomUUID(),
    Title: "Plan",
    GroupName: group.name,
    Status: "running",
    EntryPath: "index.html",
    CreatedAt: new Date().toISOString(),
    UpdatedAt: "",
    Attempt: 1,
    LastError: "",
    Checklist: [{ ...group.rules[0]!, Status: "pending" }],
    Documents: [],
    Warnings: [],
  };
  await writeFile(s.packagePath(task.Id), zipHtml());
  s.saveTask(task);
  return task;
}

test("first-run guidance requires saved model and enabled rules, persists across restart and survives theme changes", async (t) => {
  const s = await store(t);
  const app = createApp(s);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    await app.engine.stop();
    app.server.closeAllConnections();
    app.server.close();
  });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const initial: any = await (await fetch(base + "/api/bootstrap")).json();
  assert.deepEqual(initial.onboarding, { completed: false, seen: false, modelReady: false, rulesReady: false });
  assert.equal((await fetch(base + "/api/onboarding/seen", { method: "POST" })).status, 403);
  const seen = await fetch(base + "/api/onboarding/seen", { method: "POST", headers: { "X-Studio-Token": initial.token } });
  assert.equal((await seen.json()).seen, true);
  const seenStore = new Store(s.directory);
  try {
    assert.equal(seenStore.onboarding().seen, true);
    assert.equal(seenStore.onboarding().completed, false);
  } finally { seenStore.close(); }
  assert.equal((await fetch(base + "/api/onboarding/complete", { method: "POST" })).status, 403);
  const complete = () => fetch(base + "/api/onboarding/complete", { method: "POST", headers: { "X-Studio-Token": initial.token } });
  assert.equal((await complete()).status, 400);
  s.saveModel({ ...DEFAULT_MODEL, apiKey: "onboarding-fixture-key" });
  const group = s.saveGroup(validateGroup({ name: "Guide rules", rules: [{ Id: "one", Title: "Scope", Description: "Check scope", enabled: false }] }));
  assert.equal((await complete()).status, 400);
  group.rules[0]!.enabled = true;
  s.saveGroup(group);
  const response = await complete();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { completed: true, seen: true, modelReady: true, rulesReady: true });
  s.savePreferences({ theme: "dark" });
  const reopened = new Store(s.directory);
  try {
    assert.equal(reopened.onboarding().completed, true);
    assert.equal(reopened.preferences().theme, "dark");
  } finally { reopened.close(); }
  s.saveModel(DEFAULT_MODEL, true);
  assert.deepEqual(s.onboarding(), { completed: true, seen: true, modelReady: false, rulesReady: true });
});
test("portable backup restores rules, packages and stopped tasks without keys or automatic execution", async (t) => {
  const source = await store(t),
    target = await store(t);
  const task = await seed(source);
  task.Model = { name: "private-model", baseUrl: "https://private-endpoint.example" };
  task.Usage = { input: 100, output: 20, cache: 80 };
  task.DurationMs = 1200;
  source.saveTask(task);
  source.saveModel({ ...DEFAULT_MODEL, apiKey: "private-source-key" });
  target.saveModel({ ...DEFAULT_MODEL, apiKey: "private-target-key" });
  const raw = await exportWorkspace(source),
    files = await readBackup(raw);
  assert.ok(
    !files.get("workspace.json")!.toString().includes("private-source-key"),
  );
  assert.equal(files.size, 2);
  assert.ok(!files.get("workspace.json")!.toString().includes("private-endpoint.example"));
  assert.deepEqual(await importWorkspace(target, raw), { tasks: 1, groups: 1 });
  const restored = target.task(task.Id)!;
  assert.equal(restored.Status, "cancelled");
  assert.equal(restored.Checklist[0]!.Status, "pending");
  assert.deepEqual(await readFile(target.packagePath(task.Id)), zipHtml());
  assert.ok(restored.Documents.length);
  assert.deepEqual(restored.Usage, task.Usage);
  assert.equal(restored.DurationMs, 1200);
  assert.equal(target.model(true).apiKey, "private-target-key");
  await assert.rejects(importWorkspace(target, raw), /空工作空间/);
});
test("backup import rejects unsafe paths, missing packages and malformed verdicts without partial writes", async (t) => {
  const source = await store(t),
    target = await store(t);
  const task = await seed(source);
  const evil = new JSZip();
  evil.file("../outside", "test");
  await assert.rejects(
    readBackup(await evil.generateAsync({ type: "nodebuffer" })),
    /不安全/,
  );
  const valid = await exportWorkspace(source),
    archive = await JSZip.loadAsync(valid);
  archive.remove(`packages/${task.Id}.zip`);
  await assert.rejects(
    importWorkspace(
      target,
      await archive.generateAsync({ type: "nodebuffer" }),
    ),
    /缺少方案包/,
  );
  const invalid = await JSZip.loadAsync(valid);
  const manifest = JSON.parse(
    await invalid.file("workspace.json")!.async("string"),
  );
  manifest.tasks[0].Checklist[0].Status = "completed";
  manifest.tasks[0].Checklist[0].Verdict = "invented";
  invalid.file("workspace.json", JSON.stringify(manifest));
  await assert.rejects(
    importWorkspace(
      target,
      await invalid.generateAsync({ type: "nodebuffer" }),
    ),
    /结论无效/,
  );
  assert.equal(target.tasks().length, 0);
  assert.equal(target.groups().length, 0);
});
test("offline report renders readable Markdown and never executes embedded HTML or remote images", async (t) => {
  const s = await store(t),
    task = await seed(s);
  task.Title = "<script>alert(1)</script>";
  task.Checklist[0] = {
    ...task.Checklist[0]!,
    Status: "completed",
    Verdict: "failed",
    Finding: "<img src=x onerror=alert(1)>",
    Suggestion:
      "1. **Fix this**\n2. Verify again\n\n![tracking](https://evil.example/pixel)\n\n[click](javascript:alert(1))",
  };
  const html = report(task, "html");
  assert.match(html, /<strong>Fix this<\/strong>/);
  assert.match(html, /<ol>/);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("href="));
  assert.match(html, /Content-Security-Policy/);
  assert.match(report(task, "md"), /\[需修改\]/);
  s.saveModel({ ...DEFAULT_MODEL, apiKey: "secret-diagnostics-key" });
  task.LastError =
    "Authorization: secret-diagnostics-key https://private.example/plan";
  s.saveTask(task);
  const info = JSON.stringify(diagnostics(s));
  assert.ok(!info.includes("secret-diagnostics-key"));
  assert.ok(!info.includes("private.example"));
  assert.ok(!info.includes(task.Title));
});
test("draft model test handles non-JSON errors, redacts draft keys and does not save configuration", async (t) => {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (value.model === "bad") {
      res.writeHead(401, { "Content-Type": "text/html" });
      res.end("Denied draft-secret-key");
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const config = {
    ...DEFAULT_MODEL,
    baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
    apiKey: "draft-secret-key",
    model: "good",
  };
  const result = await testModel(config);
  assert.ok(result.latencyMs >= 0);
  assert.equal(result.message, "模型连接成功");
  await assert.rejects(
    testModel({ ...config, model: "bad" }),
    (e: any) =>
      e.message.includes("HTTP 401") && !e.message.includes(config.apiKey),
  );
  const s = await store(t);
  const app = createApp(s);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    await app.engine.stop();
    app.server.closeAllConnections();
    app.server.close();
  });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const boot: any = await (await fetch(base + "/api/bootstrap")).json();
  const response = await fetch(base + "/api/model/test", {
    method: "POST",
    headers: { "X-Studio-Token": boot.token },
    body: JSON.stringify(config),
  });
  assert.equal(response.status, 200);
  assert.equal(s.model().hasApiKey, false);
  assert.equal(s.model().baseUrl, DEFAULT_MODEL.baseUrl);
});
test("repeated upload IDs create one task, completed retry avoids model calls, reports and rename remain available", async (t) => {
  const s = await store(t);
  s.saveModel({ ...DEFAULT_MODEL, apiKey: "local-test" });
  const g = s.saveGroup(
    validateGroup({
      name: "Rules",
      rules: [{ Id: "one", Title: "One", Description: "Check" }],
    }),
  );
  let calls = 0;
  const engine = new Engine(s, () => ({
    async review(ctx) {
      calls++;
      await ctx.submit({
        ChecklistId: "one",
        Verdict: "passed",
        Description: "done",
        Suggestion: "",
        Level: "必要",
        DocumentPath: "index.html",
        Selector: "#scope",
        Quote: "Available",
      });
    },
  }));
  const { server } = createApp(s, engine);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await engine.stop();
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const boot: any = await (await fetch(base + "/api/bootstrap")).json();
  const headers = { "X-Studio-Token": boot.token, "X-Upload-Id": randomUUID() };
  const request = () =>
    fetch(base + `/api/tasks?group=${g.id}&fileName=plan.zip`, {
      method: "POST",
      headers,
      body: zipHtml(),
    });
  const responses = await Promise.all([request(), request()]);
  for (const response of responses) assert.equal(response.status, 201);
  await engine.idle();
  assert.equal(s.tasks().length, 1);
  assert.equal(calls, 1);
  assert.equal((await request()).status, 201);
  assert.equal(calls, 1);
  const task = s.tasks()[0]!;
  const patch = await fetch(base + `/api/tasks/${task.Id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ Title: "Renamed" }),
  });
  assert.equal(patch.status, 200);
  assert.equal(s.task(task.Id)!.Title, "Renamed");
  const html = await fetch(base + `/api/tasks/${task.Id}/report?format=html`);
  assert.match(html.headers.get("content-type")!, /text\/html/);
  assert.match(await html.text(), /Renamed/);
  task.Status = "failed";
  task.Usage = { input: 10, output: 20, cache: 30 };
  s.saveTask(task);
  engine.retry(task.Id);
  await engine.idle();
  assert.equal(calls, 1);
  assert.equal(s.task(task.Id)!.Status, "completed");
  assert.deepEqual(s.task(task.Id)!.Usage, {
    input: 10,
    output: 20,
    cache: 30,
  });
});
