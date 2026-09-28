import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  Store,
  DEFAULT_MODEL,
  validateGroup,
  validateModel,
  type TaskRecord,
} from "../src/server/store.js";
import { Engine } from "../src/server/engine.js";
import { createApp } from "../src/server/app.js";
import type {
  ReviewContext,
  Reviewer,
} from "../src/agents/rfc-review/reviewer.js";
import { zipHtml, result } from "./helpers.js";

async function fixture(t: any) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rfc-studio-test-"));
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith("rfc-studio-test-"));
    await rm(target, { recursive: true, force: true });
  });
  return store;
}
async function makeTask(store: Store, status: TaskRecord["Status"] = "queued") {
  const rules = validateGroup({
    name: "原规则组",
    rules: [
      { Id: "101", Title: "可用性", Description: "确认可用", Level: "必要" },
      {
        Id: "102",
        Title: "恢复能力",
        Description: "确认恢复步骤",
        Level: "建议",
      },
    ],
  });
  store.saveGroup(rules);
  const task: TaskRecord = {
    Id: randomUUID(),
    Title: "测试方案",
    GroupName: rules.name,
    Status: status,
    EntryPath: "index.html",
    Attempt: 0,
    LastError: "",
    CreatedAt: new Date().toISOString(),
    UpdatedAt: "",
    Checklist: rules.rules.map((r) => ({ ...r, Status: "pending" })),
    Documents: [],
    Warnings: [],
  };
  await writeFile(store.packagePath(task.Id), zipHtml());
  store.saveTask(task);
  return task;
}
const ready = (store: Store) =>
  store.saveModel({
    ...DEFAULT_MODEL,
    apiKey: "local-test-secret",
    concurrency: 1,
  });

test("settings encrypt secrets and preserve a blank key; validation strips upload results and rejects invalid settings", async (t) => {
  const store = await fixture(t);
  ready(store);
  assert.equal(store.model().apiKey, undefined);
  assert.equal(store.model().hasApiKey, true);
  assert.equal(store.model(true).apiKey, "local-test-secret");
  assert.ok(
    !JSON.stringify(store.db.prepare("SELECT * FROM settings").all()).includes(
      "local-test-secret",
    ),
  );
  store.saveModel({ ...DEFAULT_MODEL, apiKey: "", model: "another" });
  assert.equal(store.model(true).apiKey, "local-test-secret");
  const reopened = new Store(store.directory);
  assert.equal(reopened.model(true).apiKey, "local-test-secret");
  reopened.close();
  store.saveModel(DEFAULT_MODEL, true);
  assert.equal(store.model().hasApiKey, false);
  assert.throws(() =>
    validateModel({ ...DEFAULT_MODEL, baseUrl: "file:///tmp" }),
  );
  assert.throws(() => validateModel({ ...DEFAULT_MODEL, concurrency: 9 }));
  assert.throws(() => validateModel({ ...DEFAULT_MODEL, maxTokens: 999999 }));
  const group = validateGroup({
    name: "Rule",
    rules: [
      {
        Title: "One",
        Description: "Verify",
        Status: "completed",
        Verdict: "passed",
      },
    ],
  });
  assert.equal((group.rules[0] as any).Verdict, undefined);
  assert.throws(() =>
    validateGroup({
      name: "Rule",
      rules: [{ Title: "", Description: "Verify" }],
    }),
  );
});

test("engine resumes only unfinished checklist items and never reruns completed results", async (t) => {
  const store = await fixture(t);
  ready(store);
  const task = await makeTask(store);
  let attempts = 0;
  const engine = new Engine(store, () => ({
    async review(ctx) {
      attempts++;
      if (attempts === 1) {
        assert.equal(ctx.pending.length, 2);
        await ctx.submit(result());
        throw new Error("temporary error");
      }
      assert.deepEqual(
        ctx.pending.map((x) => x.Id),
        ["102"],
      );
      await ctx.submit(result({ ChecklistId: "102" }));
    },
  }));
  engine.pump();
  await engine.idle();
  assert.equal(store.task(task.Id)?.Status, "failed");
  assert.equal(store.task(task.Id)?.Checklist[0]?.Status, "completed");
  engine.retry(task.Id);
  await engine.idle();
  assert.equal(store.task(task.Id)?.Status, "completed");
  assert.equal(attempts, 2);
  const modified = store.groups()[0]!;
  modified.name = "改名";
  modified.rules[0]!.Title = "改规则";
  store.saveGroup(modified);
  assert.equal(store.task(task.Id)?.GroupName, "原规则组");
  assert.equal(store.task(task.Id)?.Checklist[0]?.Title, "可用性");
  await engine.stop();
});

for (const action of ["cancel", "remove"] as const)
  test(`${action} aborts running work and rejects late submissions`, async (t) => {
    const store = await fixture(t);
    ready(store);
    const task = await makeTask(store);
    let started!: (ctx: ReviewContext) => void, release!: () => void;
    const context = new Promise<ReviewContext>((resolve) => {
        started = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const engine = new Engine(store, () => ({
      async review(ctx) {
        started(ctx);
        await gate;
        await assert.rejects(ctx.submit(result()), /停止|删除/);
      },
    }));
    engine.pump();
    const ctx = await context;
    engine[action](task.Id);
    assert.ok(ctx.signal.aborted);
    release();
    await engine.idle();
    assert.equal(
      store.task(task.Id)?.Status,
      action === "cancel" ? "cancelled" : undefined,
    );
    await engine.stop();
  });

test("configured concurrency is bounded and queued work starts once capacity becomes available", async (t) => {
  const store = await fixture(t);
  store.saveModel({
    ...DEFAULT_MODEL,
    apiKey: "local-test-secret",
    concurrency: 2,
  });
  for (let i = 0; i < 4; i++) await makeTask(store);
  let active = 0,
    peak = 0,
    calls = 0;
  const engine = new Engine(store, () => ({
    async review(ctx) {
      active++;
      peak = Math.max(peak, active);
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const item of ctx.pending)
        await ctx.submit(result({ ChecklistId: item.Id }));
      active--;
    },
  }));
  engine.pump();
  engine.pump();
  await engine.idle();
  assert.equal(peak, 2);
  assert.equal(calls, 4);
  assert.ok(store.tasks().every((t) => t.Status === "completed"));
  await engine.stop();
});

test("restart recovery preserves submitted results and leaves interrupted work explicitly resumable", async (t) => {
  const store = await fixture(t);
  const task = await makeTask(store, "running");
  task.Checklist[0]!.Status = "completed";
  store.saveTask(task);
  const engine = new Engine(store);
  engine.recover();
  assert.equal(store.task(task.Id)?.Status, "failed");
  assert.equal(store.task(task.Id)?.Checklist[0]?.Status, "completed");
  await engine.stop();
});

test("standalone HTTP upload → real pi-agent tools → persisted results through a local streaming model", async (t) => {
  const store = await fixture(t);
  const modelRequests: any[] = [];
  const errors: unknown[] = [];
  const mock = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, "Bearer local-test-secret");
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      modelRequests.push(input);
      if (!input.stream) {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "OK" } }],
          }),
        );
        return;
      }
      const index = modelRequests.filter((x) => x.stream).length - 1;
      assert.ok(index < 2);
      const name = index === 0 ? "read_document" : "submit_checklist_result";
      const args =
        index === 0
          ? { refs: ["B1"] }
          : {
              checklistId: "101",
              verdict: "passed",
              description: "**可用性**已确认。",
              suggestion: "",
              ref: "B1",
              quote: "Available",
              verificationSummary: "已核对方案正文。",
              unresolvedQuestions: [],
              evidence: [],
            };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (delta: any, finish_reason: any = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "model-" + index, object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call-" + index,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      send({}, "tool_calls");
      res.end("data: [DONE]\n\n");
    } catch (error) {
      errors.push(error);
      res.writeHead(500);
      res.end("{}");
    }
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  store.saveModel({
    ...DEFAULT_MODEL,
    provider: "openai-compatible",
    model: "test-model",
    baseUrl: `http://127.0.0.1:${(mock.address() as any).port}/v1`,
    apiKey: "local-test-secret",
    thinkingLevel: "off",
  });
  const { server, engine } = createApp(store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await engine.stop();
    server.closeAllConnections();
    server.close();
    mock.closeAllConnections();
    mock.close();
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const boot = (await (await fetch(base + "/api/bootstrap")).json()) as any;
  const headers = {
    "X-Studio-Token": boot.token,
    "Content-Type": "application/json",
  };
  assert.equal(
    (await fetch(base + "/api/groups", { method: "POST", body: "{}" })).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/groups", {
        method: "POST",
        headers: { ...headers, Origin: "https://evil.example" },
        body: "{}",
      })
    ).status,
    403,
  );
  const badHost = await new Promise<number | undefined>((resolve) => {
    http.get(
      base + "/api/bootstrap",
      { headers: { Host: "evil.example" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
  });
  assert.equal(badHost, 403);
  const config = await (await fetch(base + "/api/model")).text();
  assert.ok(!config.includes("local-test-secret"));
  assert.ok(!config.includes("encryptedKey"));
  const groupRes = await fetch(base + "/api/groups", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "可用性",
      rules: [
        {
          Id: "101",
          Title: "可用性",
          Description: "Verify availability",
          Level: "必要",
        },
      ],
    }),
  });
  assert.equal(groupRes.status, 200);
  const group = (await groupRes.json()) as any;
  assert.equal(
    (await fetch(base + "/api/model/test", { method: "POST", headers })).status,
    200,
  );
  const raw = zipHtml();
  const uploaded = await fetch(
    base + `/api/tasks?group=${group.id}&fileName=sample.zip`,
    { method: "POST", headers: { "X-Studio-Token": boot.token }, body: raw },
  );
  assert.equal(uploaded.status, 201);
  const task = (await uploaded.json()) as any;
  await engine.idle();
  const detail = (await (
    await fetch(base + `/api/tasks/${task.Id}`)
  ).json()) as any;
  assert.equal(detail.Task.Status, "completed");
  assert.equal(detail.Checklist[0].Verdict, "passed");
  assert.ok(detail.Checklist[0].Selector);
  assert.equal(detail.Checklist[0].Quote, "Available");
  assert.equal(detail.Task.CompletedCount, 1);
  assert.equal(detail.Documents[0].Path, "index.html");
  assert.deepEqual(
    Buffer.from(
      await (
        await fetch(base + `/api/tasks/${task.Id}/download`)
      ).arrayBuffer(),
    ),
    raw,
  );
  const streaming = modelRequests.filter((x) => x.stream);
  assert.equal(streaming.length, 2);
  assert.deepEqual(
    streaming[1].messages.slice(0, streaming[0].messages.length),
    streaming[0].messages,
  );
  assert.ok(JSON.stringify(streaming[0]).includes("Verify availability"));
  assert.deepEqual(errors, []);
  assert.equal(
    (await fetch(base + `/api/tasks/${task.Id}`, { method: "DELETE", headers }))
      .status,
    200,
  );
  assert.equal((await fetch(base + `/api/tasks/${task.Id}`)).status, 404);
  await assert.rejects(readFile(store.packagePath(task.Id)));
});
