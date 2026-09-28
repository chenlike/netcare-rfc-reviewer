import { readableError } from "./errors.js";
import { readFile } from "node:fs/promises";
import { parsePackage } from "../agents/rfc-review/document.js";
import { PiReviewer, type Reviewer } from "../agents/rfc-review/reviewer.js";
import type { RfcReviewConfig } from "../agents/rfc-review/config.js";
import { logPreview } from "../core/log-preview.js";
import { Store, type ModelSettings } from "./store.js";
import type { ReferenceMaterial } from '../agents/rfc-review/references.js';

export interface Activity {
  Preview: string;
  UpdatedAt: string;
  Event: string;
}
/** 单机调度，任务状态和尝试编号共同阻止删除、取消后的迟到回调。 */
export class Engine {
  readonly activity = new Map<string, Activity>();
  readonly activityHistory = new Map<string, Activity[]>();
  private recordActivity(id: string, value: Activity) {
    this.activity.set(id, value);
    const history = this.activityHistory.get(id) || [];
    if (history.at(-1)?.Preview !== value.Preview || history.at(-1)?.Event !== value.Event)
      history.push(value);
    this.activityHistory.delete(id);
    this.activityHistory.set(id, history.slice(-80));
    if (this.activityHistory.size > 100)
      this.activityHistory.delete(this.activityHistory.keys().next().value!);
  }
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private stopping = false;
  constructor(
    readonly store: Store,
    private readonly reviewerFactory?: (
      config: RfcReviewConfig,
      model: ModelSettings,
    ) => Reviewer,
  ) {}
  recover() {
    for (const task of this.store.tasks())
      if (task.Status === "running") {
        task.Status = "failed";
        task.LastError =
          "上次程序退出时审核未完成，请点击继续审核。已提交的结论会保留。";
        this.store.saveTask(task);
      }
    this.pump();
  }
  pump() {
    if (this.stopping) return;
    const settings = this.store.model(true);
    if (!settings.apiKey) return;
    for (const task of this.store.tasks().reverse()) {
      if (this.active.size >= settings.concurrency) break;
      if (task.Status !== "queued" || this.active.has(task.Id)) continue;
      task.Status = "running";
      task.Attempt++;
      task.LastError = "";
      task.Usage ??= { input: 0, output: 0, cache: 0 };
      task.Model = { name: settings.model, baseUrl: settings.baseUrl };
      this.store.saveTask(task);
      const controller = new AbortController();
      const promise = this.execute(
        task.Id,
        task.Attempt,
        settings,
        controller,
      ).finally(() => {
        this.active.delete(task.Id);
        this.activity.delete(task.Id);
        this.pump();
      });
      this.active.set(task.Id, { controller, promise });
    }
  }
  cancel(id: string) {
    const task = this.store.task(id);
    if (!task) throw new Error("任务不存在");
    if (!["running", "queued"].includes(task.Status))
      throw new Error("当前任务不在执行中");
    task.Status = "cancelled";
    this.store.saveTask(task);
    this.active.get(id)?.controller.abort(new Error("用户停止审核"));
    this.activity.delete(id);
  }
  remove(id: string) {
    this.activityHistory.delete(id);
    this.active.get(id)?.controller.abort(new Error("任务已删除"));
    this.activity.delete(id);
    this.store.deleteTask(id);
  }
  retry(id: string) {
    const task = this.store.task(id);
    if (!task || !["failed", "cancelled"].includes(task.Status))
      throw new Error("只能继续失败或已停止的任务");
    if (!this.store.model().hasApiKey)
      throw new Error("请先在模型配置中填写 API Key");
    task.Status = "queued";
    task.LastError = "";
    this.store.saveTask(task);
    this.pump();
  }
  private async execute(
    id: string,
    attempt: number,
    model: ModelSettings,
    controller: AbortController,
  ) {
    const signal = controller.signal;
    const started = Date.now();
    const config: RfcReviewConfig = {
      basePrompt: this.store.task(id)?.BasePrompt || model.basePrompt,
      runTimeoutMs: 1800000,
      maxModelCalls: 300,
      maxToolCalls: 600,
      maxDownloadBytes: 50 * 1024 * 1024,
      model: {
        provider: model.provider,
        id: model.model,
        baseUrl: model.baseUrl,
        apiKeyEnvironmentVariable: "STUDIO_UNUSED_KEY",
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        supportsImages: model.supportsImages,
        thinkingLevel: model.thinkingLevel,
        temperature: model.temperature,
        requestTimeoutMs: model.requestTimeoutMs,
      },
    };
    const assertActive = () => {
      signal.throwIfAborted();
      const task = this.store.task(id);
      if (!task || task.Status !== "running" || task.Attempt !== attempt)
        throw new Error("任务已停止");
    };
    try {
      const task = this.store.task(id)!;
      if (task.Checklist.every((item) => item.Status === "completed")) {
        task.Status = "completed";
        this.store.saveTask(task);
        return;
      }
      this.recordActivity(id, {
        Preview: "正在读取方案包",
        UpdatedAt: new Date().toISOString(),
        Event: "agent_start",
      });
      const pkg = await parsePackage(
        await readFile(this.store.packagePath(id)),
      );
      assertActive();
      const reviewer =
        this.reviewerFactory?.(config, model) ??
        new PiReviewer(
          config,
          undefined,
          (event) => {
            console.log(
              JSON.stringify({ taskId: id, component: "pi-agent", ...event }),
            );
            if (event.event === "model_end") {
              const current = this.store.task(id);
              if (
                current?.Status === "running" &&
                current.Attempt === attempt
              ) {
                current.Usage ??= { input: 0, output: 0, cache: 0 };
                current.Usage.input += event.inputTokens ?? 0;
                current.Usage.output += event.outputTokens ?? 0;
                current.Usage.cache += event.cacheReadTokens ?? 0;
                this.store.saveTask(current);
              }
            }
          },
          () => model.apiKey!,
        );
      await reviewer.review({
        references: task.References?.length ? JSON.parse(await readFile(this.store.referencesPath(id), 'utf8')) as ReferenceMaterial[] : [],
        request: { TaskId: id, Title: task.Title, EntryPath: task.EntryPath },
        pkg,
        pending: task.Checklist.filter((item) => item.Status !== "completed"),
        signal,
        assertActive,
        reportActivity: (value) => {
          if (!signal.aborted && this.store.task(id)?.Status === "running")
            this.recordActivity(id, {
              Preview: logPreview(value.preview, [model.apiKey || ""]),
              UpdatedAt: new Date().toISOString(),
              Event: value.event,
            });
        },
        submit: async (result) => {
          assertActive();
          this.store.submit(id, attempt, result);
        },
      });
      assertActive();
      const current = this.store.task(id)!;
      if (current.Checklist.some((item) => item.Status !== "completed"))
        throw new Error("审核未完成，请继续未完成的检查项");
      current.Status = "completed";
      this.store.saveTask(current);
    } catch (error) {
      const current = this.store.task(id);
      if (current?.Status === "running" && current.Attempt === attempt) {
        current.Status = "failed";
        current.LastError = logPreview(
          readableError(error),
          [model.apiKey || ""],
          600,
        );
        if (current.LastError.includes("MODEL_NO_TOOL_PROGRESS"))
          current.LastError =
            "模型连续 3 轮未产生工具动作，已停止避免空转。可调整模型或输出额度后继续审核。";
        this.store.saveTask(current);
      }
    } finally {
      const current = this.store.task(id);
      if (current?.Attempt === attempt) {
        current.DurationMs = (current.DurationMs || 0) + Date.now() - started;
        this.store.saveTask(current);
      }
    }
  }
  async idle() {
    while (this.active.size)
      await Promise.all([...this.active.values()].map((item) => item.promise));
  }
  async stop() {
    this.stopping = true;
    for (const item of this.active.values())
      item.controller.abort(new Error("应用正在关闭，待重新打开后继续"));
    await this.idle();
  }
}
