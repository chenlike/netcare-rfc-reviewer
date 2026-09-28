import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Type, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { runPiAgent, type AgentTelemetry } from '../src/core/pi-runner.js';
import type { AgentConfig } from '../src/core/config.js';

for (const scenario of ['recover', 'stalled', 'thinking-off'] as const)
test(`reasoning truncation recovery is bounded and preserves tool execution: ${scenario}`, async () => {
  const config: AgentConfig = {
    runTimeoutMs: 3000, maxModelCalls: 20, maxToolCalls: 20, maxDownloadBytes: 1024,
    model: { provider: 'deepseek', id: 'test', baseUrl: 'http://localhost', apiKeyEnvironmentVariable: 'UNUSED_TEST_KEY',
      contextWindow: 128000, maxTokens: 8192, supportsImages: false, thinkingLevel: scenario === 'thinking-off' ? 'off' : 'low' }
  };
  let completed = false;
  const limits: number[] = [], telemetry: AgentTelemetry[] = [];
  const providerStream: StreamFn = (model, context, options) => {
    limits.push(options!.maxTokens!);
    assert.ok(JSON.stringify(context.messages).includes('stable-system'));
    const success = scenario === 'recover' && limits.length === 2;
    const message: AssistantMessage = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: success ? [{ type: 'toolCall', id: 'save', name: 'save', arguments: {} }]
        : [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }],
      stopReason: success ? 'toolUse' : 'length',
      usage: { input: 10, output: options!.maxTokens!, reasoning: options!.maxTokens!, cacheRead: 0, cacheWrite: 0,
        totalTokens: 10 + options!.maxTokens!, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason as 'toolUse' | 'length', message }); stream.end(); });
    return stream;
  };
  const run = runPiAgent(config, {
    systemPrompt: 'stable-system', initialPrompt: 'goal', continuationPrompt: () => 'continue',
    tools: [{ name: 'save', label: 'save', description: 'save', parameters: Type.Object({}),
      async execute() { completed = true; return { content: [{ type: 'text', text: 'saved' }], details: {} }; } }],
    isComplete: () => completed, signal: new AbortController().signal, assertActive() {},
    progress: () => ({ completed: completed ? 1 : 0, total: 1 }), providerStream, telemetry: event => telemetry.push(event)
  });
  if (scenario === 'recover') { await run; assert.deepEqual(limits, [8192, 16384]); assert.equal(completed, true); }
  else { await assert.rejects(run, /MODEL_NO_TOOL_PROGRESS/); assert.equal(completed, false);
    assert.deepEqual(limits, scenario === 'thinking-off' ? [8192, 8192, 8192] : [8192, 16384, 16384]); }
  assert.equal(telemetry.find(event => event.event === 'model_end')?.stopReason, 'length');
  assert.equal(telemetry.at(-1)?.outcome, scenario === 'recover' ? 'completed' : 'failed');
  assert.equal(JSON.stringify(telemetry).includes('PRIVATE_REASONING'), false);
});

for (const thinkingLevel of ['off', 'low', 'high', 'max'] as const)
test(`generic runner completes tools with configured ${thinkingLevel} thinking and sampling`, async () => {
  const config: AgentConfig = {
    runTimeoutMs: 3000, maxModelCalls: 4, maxToolCalls: 4, maxDownloadBytes: 1024,
    model: { provider: 'deepseek', id: 'test-model', baseUrl: 'http://localhost', apiKeyEnvironmentVariable: 'UNUSED_TEST_KEY', contextWindow: 128000, maxTokens: 1024, supportsImages: false, temperature: 0, thinkingLevel }
  };
  let answer: number | undefined, calls = 0, continuations = 0, checkedActive = 0;
  const prompts: string[] = [], telemetry: AgentTelemetry[] = [];
  const sumTool: AgentTool = {
    name: 'save_sum', label: 'Save sum', description: 'Calculate and save the sum of two numbers.',
    parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
    async execute(_id, values: any) {
      answer = values.a + values.b;
      return { content: [{ type: 'text', text: String(answer) }], details: {} };
    }
  };
  const providerStream: StreamFn = async (model, context, options) => {
    assert.equal(model.reasoning, thinkingLevel !== 'off');
    assert.equal(options?.temperature, 0);
    assert.equal(options?.reasoning, thinkingLevel === 'off' ? undefined : thinkingLevel);
    const payload = await options?.onPayload?.({ temperature: options.temperature }, model) as Record<string, unknown>;
    assert.deepEqual(payload.thinking, { type: thinkingLevel === 'off' ? 'disabled' : 'enabled' });
    assert.equal(payload.temperature, thinkingLevel === 'off' ? 0 : undefined);
    assert.equal(payload.reasoning_effort, thinkingLevel === 'off' ? undefined : thinkingLevel);
    calls++;
    for (const message of context.messages) if (message.role === 'system' || message.role === 'user') {
      const content = typeof message.content === 'string' ? message.content : message.content.filter(item => item.type === 'text').map(item => item.text).join('');
      if (!prompts.includes(content)) prompts.push(content);
    }
    const stream = createAssistantMessageEventStream();
    const finish = calls === 2;
    const message: AssistantMessage = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: finish ? [{ type: 'toolCall', id: 'sum-call', name: 'save_sum', arguments: { a: 2, b: 3 } }] : [{ type: 'text', text: 'Preparing calculation.' }],
      stopReason: finish ? 'toolUse' : 'stop',
      usage: { input: calls * 10, output: calls * 5, totalTokens: calls * 120, cacheRead: calls * 100, cacheWrite: calls * 5,
        reasoning: calls * 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    };
    queueMicrotask(() => { stream.push({ type: 'done', reason: finish ? 'toolUse' : 'stop', message }); stream.end(); });
    return stream;
  };
  await runPiAgent(config, {
    systemPrompt: 'You are a calculator. Complete the requested arithmetic with the provided tool.',
    initialPrompt: 'Compute 2 + 3. PRIVATE_APPLICATION_PROMPT',
    continuationPrompt: () => { continuations++; return 'Use save_sum to finish the calculation.'; },
    tools: [sumTool], isComplete: () => answer !== undefined,
    signal: new AbortController().signal,
    assertActive: () => { checkedActive++; },
    progress: () => ({ completed: answer === undefined ? 0 : 1, total: 1 }),
    providerStream, telemetry: event => telemetry.push(event)
  });
  assert.equal(answer, 5); assert.equal(calls, 2); assert.equal(continuations, 1); assert.ok(checkedActive > 0);
  assert.ok(prompts.some(prompt => prompt.includes('You are a calculator')));
  assert.ok(prompts.some(prompt => prompt.startsWith('Use save_sum to finish the calculation.')));
  assert.equal(telemetry.at(-1)?.event, 'agent_end'); assert.equal(telemetry.at(-1)?.outcome, 'completed');
  const modelEnds = telemetry.filter(event => event.event === 'model_end');
  assert.equal(modelEnds.length, 2);
  assert.equal(modelEnds[0]?.inputTokens, 10);
  assert.equal(modelEnds[0]?.promptTokens, 115);
  assert.equal(modelEnds[0]?.cacheReadTokens, 100);
  assert.equal(modelEnds[0]?.cacheWriteTokens, 5);
  assert.equal(modelEnds[0]?.totalTokens, 120);
  assert.equal(modelEnds[1]?.totalTokens, 240);
  const totals = telemetry.at(-1)!;
  assert.equal(totals.inputTokens, 30);
  assert.equal(totals.outputTokens, 15);
  assert.equal(totals.promptTokens, 345);
  assert.equal(totals.cacheReadTokens, 300);
  assert.equal(totals.cacheWriteTokens, 15);
  assert.equal(totals.totalTokens, 360);
  assert.equal(totals.reasoningTokens, 6);
  assert.equal(totals.totalTokens, totals.promptTokens! + totals.outputTokens!);
  assert.equal(JSON.stringify(telemetry).includes('PRIVATE_APPLICATION_PROMPT'), false);
});

test('failed conversations retain provider-reported token totals without inventing a reasoning breakdown', async () => {
  const config: AgentConfig = {
    runTimeoutMs: 3000, maxModelCalls: 1, maxToolCalls: 1, maxDownloadBytes: 1024,
    model: { provider: 'test', id: 'test-model', baseUrl: 'http://localhost', apiKeyEnvironmentVariable: 'UNUSED_TEST_KEY',
      contextWindow: 128000, maxTokens: 1024, supportsImages: false }
  };
  const telemetry: AgentTelemetry[] = [];
  const providerStream: StreamFn = model => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: [{ type: 'text', text: 'Work remains incomplete.' }], stopReason: 'stop',
      usage: { input: 11, output: 5, cacheRead: 23, cacheWrite: 0, totalTokens: 39,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    };
    queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
    return stream;
  };
  await assert.rejects(runPiAgent(config, {
    systemPrompt: 'test', initialPrompt: 'test', continuationPrompt: () => 'continue',
    tools: [], isComplete: () => false, signal: new AbortController().signal,
    assertActive: () => {}, progress: () => ({ completed: 0, total: 1 }),
    providerStream, telemetry: event => telemetry.push(event)
  }), /MODEL_CALL_BUDGET_EXCEEDED/);
  const end = telemetry.at(-1)!;
  assert.equal(end.outcome, 'failed');
  assert.equal(end.promptTokens, 34);
  assert.equal(end.totalTokens, 39);
  assert.equal(end.reasoningTokens, undefined);
  assert.equal(end.completed, 0);
});

test('installed provider maps DeepSeek cache hit usage from an actual local SSE response', async () => {
  const telemetry: AgentTelemetry[] = [];
  let completed = false, received = false;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the local request without logging prompts or credentials. */ }
    received = true;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const envelope = { id: 'cache-test', object: 'chat.completion.chunk', created: 1, model: 'test-model' };
    response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { role: 'assistant', content: 'Complete.' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: {
      prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
      prompt_cache_hit_tokens: 75, prompt_cache_miss_tokens: 25,
      completion_tokens_details: { reasoning_tokens: 4 }
    } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const key = 'CORE_SSE_CACHE_TEST_KEY', previous = process.env[key];
  process.env[key] = 'local-test-key';
  try {
    const config: AgentConfig = {
      runTimeoutMs: 3000, maxModelCalls: 1, maxToolCalls: 1, maxDownloadBytes: 1024,
      model: { provider: 'deepseek', id: 'test-model', baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnvironmentVariable: key, contextWindow: 128000, maxTokens: 1024, supportsImages: false }
    };
    await runPiAgent(config, {
      systemPrompt: 'test', initialPrompt: 'test', continuationPrompt: () => 'continue', tools: [],
      isComplete: () => completed, signal: new AbortController().signal, assertActive: () => {},
      progress: () => ({ completed: completed ? 1 : 0, total: 1 }),
      telemetry: event => { telemetry.push(event); if (event.event === 'model_end') completed = true; }
    });
    assert.equal(received, true);
    for (const event of telemetry.filter(row => row.event === 'model_end' || row.event === 'agent_end')) {
      assert.equal(event.inputTokens, 25);
      assert.equal(event.cacheReadTokens, 75);
      assert.equal(event.cacheWriteTokens, 0);
      assert.equal(event.promptTokens, 100);
      assert.equal(event.outputTokens, 10);
      assert.equal(event.reasoningTokens, 4);
      assert.equal(event.totalTokens, 110);
    }
    assert.equal(telemetry.filter(row => row.event === 'model_end').length, 1);
    assert.equal(telemetry.at(-1)?.event, 'agent_end');
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
