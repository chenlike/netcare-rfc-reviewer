import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { randomUUID } from 'node:crypto';
import type { AgentConfig } from './config.js';
import { AgentError } from './errors.js';
import { logPreview } from './log-preview.js';

/** Actual provider-reported tokens. Input excludes cache; reasoning is a subset of output. */
export interface AgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  promptTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface AgentTelemetry extends Partial<AgentTokenUsage> {
  event: 'agent_start' | 'model_start' | 'model_end' | 'tool_start' | 'tool_end' | 'agent_end';
  run: string; modelCalls: number; toolCalls: number; completed: number; total: number;
  tool?: string; error?: boolean; elapsedMs?: number;
  preview?: string;
  stopReason?: string;
  noToolRounds?: number;
  maxOutputTokens?: number;
  outcome?: 'completed' | 'failed' | 'aborted';
}
export type AgentTelemetrySink = (event: AgentTelemetry) => void;
export interface PiAgentOptions {
  systemPrompt: string;
  initialPrompt: string;
  continuationPrompt(): string;
  tools: AgentTool[];
  isComplete(): boolean;
  getBlockedReason?(): string | undefined;
  signal: AbortSignal;
  assertActive(): void;
  progress(): { completed: number; total: number };
  telemetry?: AgentTelemetrySink;
  getApiKey?(): string | undefined;
  /** Optional application diagnostics. Hooks are never included in model prompts or tool results. */
  describeToolCall?(name: string, args: unknown): string | undefined;
  describeToolResult?(name: string, result: unknown, isError: boolean): string | undefined;
  logModelText?: boolean;
  /** 宿主提供一次执行尝试的统一预算。 */
  consumeBudget?(kind: 'model' | 'tool'): void;
  /** Optional provider injection for deterministic tests or compatible transports. */
  providerStream?: StreamFn;
}

export function configuredModel(config: AgentConfig): Model<'openai-completions'> {
  return {
    id: config.model.id, name: config.model.id, provider: config.model.provider,
    api: 'openai-completions', baseUrl: config.model.baseUrl, reasoning: (config.model.thinkingLevel ?? 'off') !== 'off',
    input: config.model.supportsImages ? ['text', 'image'] : ['text'],
    contextWindow: config.model.contextWindow, maxTokens: config.model.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens' }
  };
}

/** Execute application-supplied tools until the supplied completion predicate is satisfied. */
export async function runPiAgent(config: AgentConfig, options: PiAgentOptions): Promise<void> {
  if (options.isComplete()) return;
  let modelCalls = 0, toolCalls = 0;
  const run = randomUUID().slice(0, 8), started = Date.now();
  const knownTools = new Set(options.tools.map(tool => tool.name));
  let modelStarted = 0, outcome: AgentTelemetry['outcome'] = 'failed';
  const totals: AgentTokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, promptTokens: 0, totalTokens: 0 };
  let currentRequestTimeout: AbortSignal | undefined;
  let noToolRounds = 0, truncated = false, expandedOutput = false;
  let maxOutputTokens = config.model.maxTokens;
  const deadline = new AbortController();
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  const assertActive = () => { signal.throwIfAborted(); options.assertActive(); };
  const telemetry = options.telemetry ?? (event => console.log(JSON.stringify({ component: 'pi-agent', ...event })));
  const emit = (event: AgentTelemetry['event'], details: Partial<AgentTelemetry> = {}) => {
    // Metadata by default; applications may opt into bounded previews, never raw payloads.
    // Formatting and logging failures must not break application execution.
    try {
      if (details.preview !== undefined) details = { ...details, preview: logPreview(details.preview, [options.getApiKey?.() ?? process.env[config.model.apiKeyEnvironmentVariable] ?? '']) };
      telemetry({ event, run, modelCalls, toolCalls, ...options.progress(), ...details });
    } catch { /* Ignore logging failures. */ }
  };
  const describe = (format: () => string | undefined): Pick<AgentTelemetry, 'preview'> => {
    try { const preview = format(); return typeof preview === 'string' && preview ? { preview } : {}; }
    catch { return {}; }
  };
  const model = configuredModel(config);
  const agent = new Agent({
    initialState: { model, tools: options.tools, thinkingLevel: config.model.thinkingLevel ?? 'off', systemPrompt: options.systemPrompt },
    toolExecution: 'sequential', maxRetryDelayMs: 10000,
    getApiKey: () => options.getApiKey?.() ?? process.env[config.model.apiKeyEnvironmentVariable],
    streamFn: async (incomingModel, llmContext, streamOptions) => {
      assertActive();
      options.consumeBudget?.('model');
      if (++modelCalls > config.maxModelCalls) throw new AgentError('MODEL_CALL_BUDGET_EXCEEDED');
      modelStarted = Date.now(); emit('model_start', { maxOutputTokens });
      currentRequestTimeout = AbortSignal.timeout(config.model.requestTimeoutMs ?? 120000);
      const signals = [signal, currentRequestTimeout];
      if (streamOptions?.signal) signals.push(streamOptions.signal);
      const merged = {
        ...streamOptions, signal: AbortSignal.any(signals), maxTokens: maxOutputTokens, temperature: config.model.temperature ?? 0,
        onPayload: async (payload: unknown, providerModel: Model<any>) => {
          const prepared = await streamOptions?.onPayload?.(payload, providerModel) ?? payload;
          if (providerModel.provider === 'deepseek' || new URL(providerModel.baseUrl).hostname === 'api.deepseek.com') {
            const body = { ...(prepared as Record<string, unknown>) };
            const level = config.model.thinkingLevel ?? 'off';
            body.thinking = { type: level === 'off' ? 'disabled' : 'enabled' };
            if (level === 'off') delete body.reasoning_effort;
            else {
              body.reasoning_effort = level;
              // DeepSeek 思考模式不使用温度；推理内容由 pi 保留并随工具调用回传。
              delete body.temperature;
            }
            return body;
          }
          return prepared;
        }
      };
      return options.providerStream ? options.providerStream(incomingModel, llmContext, merged) : streamSimple(model, llmContext, merged);
    },
    beforeToolCall: async ({ toolCall, args }) => {
      assertActive();
      options.consumeBudget?.('tool');
      if (++toolCalls > config.maxToolCalls) throw new AgentError('TOOL_CALL_BUDGET_EXCEEDED');
      const tool = knownTools.has(toolCall.name) ? toolCall.name : 'unknown_tool';
      emit('tool_start', { tool, ...describe(() => options.describeToolCall?.(tool, args)) });
      return undefined;
    },
    finishTurn: async () => options.isComplete() || options.getBlockedReason?.() !== undefined ? { action: 'end' } : undefined
  });
  agent.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const message = event.message, usage = message.usage;
      // 无工具的连续回复不能无限触发相同续跑；正常取证与工具调用不受此计数限制。
      if (options.tools.length) noToolRounds = message.content.some(part => part.type === 'toolCall') ? 0 : noToolRounds + 1;
      truncated = message.stopReason === 'length';
      const tokens: AgentTokenUsage = {
        inputTokens: usage.input, outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
        promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
        totalTokens: usage.totalTokens,
        ...(usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning })
      };
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'promptTokens', 'totalTokens'] as const)
        totals[key] += tokens[key];
      if (tokens.reasoningTokens !== undefined) totals.reasoningTokens = (totals.reasoningTokens ?? 0) + tokens.reasoningTokens;
      emit('model_end', {
        elapsedMs: Date.now() - modelStarted, ...tokens,
        stopReason: message.stopReason, noToolRounds, maxOutputTokens,
        ...describe(() => options.logModelText ? message.content.filter(part => part.type === 'text').map(part => part.text).join(' ')
          || (message.errorMessage ? `模型调用失败：${message.errorMessage}` : undefined) : undefined),
        error: event.message.stopReason === 'error' || event.message.stopReason === 'aborted'
      });
    } else if (event.type === 'tool_execution_end') {
      const tool = knownTools.has(event.toolName) ? event.toolName : 'unknown_tool';
      emit('tool_end', { tool, error: event.isError, ...describe(() => options.describeToolResult?.(tool, event.result, event.isError)) });
    }
  });
  const timer = setTimeout(() => deadline.abort(new AgentError('RUN_TIMEOUT')), config.runTimeoutMs);
  const abort = () => agent.abort(); signal.addEventListener('abort', abort, { once: true });
  try {
    emit('agent_start'); assertActive();
    await agent.prompt(options.initialPrompt);
    while (!options.isComplete()) {
      const blocked = options.getBlockedReason?.();
      if (blocked !== undefined) throw new AgentError('AGENT_BLOCKED', blocked);
      assertActive();
      if (agent.state.errorMessage) throw new AgentError(currentRequestTimeout?.aborted ? 'MODEL_REQUEST_TIMEOUT' : 'MODEL_PROVIDER_FAILED');
      if (modelCalls >= config.maxModelCalls) throw new AgentError('MODEL_CALL_BUDGET_EXCEEDED');
      if (noToolRounds >= 3) throw new AgentError('MODEL_NO_TOOL_PROGRESS');
      // 仅在思考被截断且没有工具动作时扩容一次，不关思考、不重建会话或移除历史证据。
      if (truncated && noToolRounds && !expandedOutput && config.model.thinkingLevel && config.model.thinkingLevel !== 'off') {
        maxOutputTokens = Math.max(maxOutputTokens, Math.min(maxOutputTokens * 2, 32768, config.model.contextWindow));
        expandedOutput = true;
      }
      const recovery = noToolRounds ? '\n上一轮没有发起工具调用。下一轮只推进一个具体工具动作；先获取必要证据，再根据任务标准执行。不要一次推演整个任务，不要输出计划或强行下结论。'
        + (truncated ? '上一轮输出达到长度限制；请缩小当前处理范围。' : '') : '';
      await agent.prompt(options.continuationPrompt() + recovery);
    }
    signal.throwIfAborted(); outcome = 'completed';
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
    // Totals cover this conversation. An RFC review uses one conversation per task attempt.
    emit('agent_end', { elapsedMs: Date.now() - started, outcome: signal.aborted ? 'aborted' : outcome, ...totals,
      ...(noToolRounds >= 3 && outcome !== 'completed' ? { preview: '连续 3 轮没有工具动作，停止本次执行以避免空转；未完成项保留待重试。' } : {}) });
  }
}
