import test from 'node:test';
import assert from 'node:assert/strict';
import { Type, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { logPreview } from '../src/core/log-preview.js';
import { runPiAgent, type AgentTelemetry, type PiAgentOptions } from '../src/core/pi-runner.js';
import { reviewActivity } from '../src/agents/rfc-review/telemetry.js';
import { buildReviewTools, type ReviewContext } from '../src/agents/rfc-review/reviewer.js';
import { parsePackage } from '../src/agents/rfc-review/document.js';
import { task, testConfig, zipHtml } from './helpers.js';

test('activity previews cap Unicode characters at 160 without splitting emoji', () => {
  const preview = logPreview('😀'.repeat(161));
  assert.equal(Array.from(preview).length, 160);
  assert.equal(preview, '😀'.repeat(159) + '…');
  assert.equal(logPreview('😀'.repeat(160)), '😀'.repeat(160));
  assert.equal(logPreview('第一行\r\n第二行\t\u001b\u202e末尾'), '第一行 第二行 末尾');
});

test('activity previews redact known keys, Bearer credentials, passwords and URLs before truncating', () => {
  const known = 'PRIVATE_BOUNDARY_KEY_01234567890123456789';
  const samples = [
    { source: known, forbidden: 'PRIVATE_BOUNDARY' },
    { source: 'Bearer BEARER_BOUNDARY_01234567890123456789', forbidden: 'BEARER_BOUNDARY' },
    { source: 'password=PASSWORD_BOUNDARY_01234567890123456789', forbidden: 'PASSWORD_BOUNDARY' },
    { source: 'https://URL_BOUNDARY.example/private?token=credential', forbidden: 'URL_BOUNDARY' }
  ];
  for (const { source, forbidden } of samples) {
    const preview = logPreview('界'.repeat(135) + source + ' ' + '尾'.repeat(100), [known]);
    assert.equal(Array.from(preview).length, 160);
    assert.equal(preview.includes(forbidden), false);
    assert.match(preview, /\[(?:REDACTED|LINK)\]/);
  }
  assert.doesNotMatch(logPreview('password="秘密 内容"; Authorization: Bearer abc123'), /秘密|内容|abc123/);
});

test('RFC activity extracts current body text without block metadata, cursors or image bytes', () => {
  const activity = reviewActivity(task().Checklist);
  const preview = activity.describeToolResult('read_document', {
    content: [
      { type: 'text', text: JSON.stringify({ text: '[B1 S1 headers=B2 INTERNAL_METADATA]\n这里是新增正文。', nextCursor: 'PRIVATE_CURSOR', documentPath: 'PRIVATE_PATH' }) },
      { type: 'image', data: 'PRIVATE_BASE64_IMAGE', mimeType: 'image/png' }
    ],
    details: { raw: 'PRIVATE_DETAILS' }
  }, false);
  assert.match(preview!, /这里是新增正文/);
  assert.match(preview!, /可继续翻页/);
  for (const hidden of ['INTERNAL_METADATA', 'headers=', 'PRIVATE_CURSOR', 'PRIVATE_PATH', 'PRIVATE_BASE64_IMAGE', 'PRIVATE_DETAILS']) {
    assert.equal(preview!.includes(hidden), false);
  }
});

test('RFC activity identifies actual repeated reads and image reuse', async () => {
  const request = task();
  const context: ReviewContext = {
    request, pending: request.Checklist,
    pkg: await parsePackage(zipHtml('<p>这是正文。</p><svg width="20" height="20"><rect width="20" height="20" fill="green"/></svg>')),
    signal: new AbortController().signal, assertActive() {}, async submit() {}
  };
  const { tools } = buildReviewTools(context, true);
  const activity = reviewActivity(context.pending);
  const execute = (name: string, args: object) => tools.find(tool => tool.name === name)!.execute('activity-test', args as never, context.signal);
  const read = await execute('read_document', { refs: ['B1'] });
  assert.match(activity.describeToolResult('read_document', read, false)!, /这是正文/);
  const repeated = activity.describeToolResult('read_document', await execute('read_document', { refs: ['B1'] }), false)!;
  assert.match(repeated, /复用已读内容/);
  assert.equal(repeated.includes('这是正文'), false);
  const image = context.pkg.images[0]!;
  assert.match(activity.describeToolResult('inspect_image', await execute('inspect_image', { imageId: image.id }), false)!, /已读取图片/);
  assert.match(activity.describeToolResult('inspect_image', await execute('inspect_image', { imageId: image.id }), false)!, /复用已查看图片/);
});

test('throwing activity hooks do not interrupt a completed tool run or duplicate telemetry', async () => {
  let starts = 0, ends = 0;
  const events = await completedRun({
    describeToolCall() { starts++; throw new Error('PRIVATE_FORMATTER_ERROR'); },
    describeToolResult() { ends++; throw new Error('PRIVATE_FORMATTER_ERROR'); }
  });
  assert.equal(starts, 1);
  assert.equal(ends, 1);
  assert.equal(events.at(-1)?.outcome, 'completed');
  assert.equal(events.at(-1)?.completed, 1);
  assert.equal(events.some(event => event.preview !== undefined), false);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_FORMATTER_ERROR|VISIBLE_OUTPUT|PRIVATE_THINKING|PRIVATE_ARGUMENT|PRIVATE_RESULT/);
  assertSingleRun(events);
});

test('model activity logs visible text once despite stream updates and excludes thinking and tool arguments', async () => {
  const events = await completedRun({ logModelText: true });
  const modelEnd = events.find(event => event.event === 'model_end')!;
  assert.equal(modelEnd.preview, 'VISIBLE_OUTPUT 可见结论');
  assert.equal(modelEnd.inputTokens, 11);
  assert.equal(modelEnd.outputTokens, 7);
  assert.equal(modelEnd.reasoningTokens, 3);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_THINKING|PRIVATE_ARGUMENT|PRIVATE_RESULT|PRIVATE_SYSTEM_PROMPT|PRIVATE_INITIAL_PROMPT/);
  assertSingleRun(events);
});

test('application activity hooks add call and result previews at their matching event boundaries', async () => {
  const events = await completedRun({
    describeToolCall(name, args) {
      assert.equal(name, 'complete');
      assert.deepEqual(args, { value: 'PRIVATE_ARGUMENT' });
      return '正在处理 password=HIDDEN_PASSWORD';
    },
    describeToolResult(name, result, isError) {
      assert.equal(name, 'complete');
      assert.equal(isError, false);
      assert.match(JSON.stringify(result), /PRIVATE_RESULT/);
      return '已处理 https://private.example/credential';
    }
  });
  const start = events.find(event => event.event === 'tool_start')!;
  const end = events.find(event => event.event === 'tool_end')!;
  assert.equal(start.preview, '正在处理 password=[REDACTED]');
  assert.equal(start.completed, 0);
  assert.equal(end.preview, '已处理 [LINK]');
  assert.equal(end.completed, 1);
  assert.equal(events.find(event => event.event === 'model_end')!.preview, undefined);
  assertSingleRun(events);
});

function assertSingleRun(events: AgentTelemetry[]) {
  assert.deepEqual(events.map(event => event.event), ['agent_start', 'model_start', 'model_end', 'tool_start', 'tool_end', 'agent_end']);
}

async function completedRun(activity: Pick<PiAgentOptions, 'describeToolCall' | 'describeToolResult' | 'logModelText'>): Promise<AgentTelemetry[]> {
  let completed = false;
  const events: AgentTelemetry[] = [];
  const complete: AgentTool = {
    name: 'complete', label: 'Complete', description: 'Finish the test run',
    parameters: Type.Object({ value: Type.String() }),
    async execute() {
      completed = true;
      return { content: [{ type: 'text', text: 'PRIVATE_RESULT' }], details: {}, terminate: true };
    }
  };
  const providerStream: StreamFn = model => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: Date.now(),
      content: [
        { type: 'thinking', thinking: 'PRIVATE_THINKING', thinkingSignature: 'PRIVATE_SIGNATURE' },
        { type: 'text', text: 'VISIBLE_OUTPUT' },
        { type: 'text', text: '可见结论' },
        { type: 'toolCall', id: 'activity-call', name: 'complete', arguments: { value: 'PRIVATE_ARGUMENT' } }
      ],
      usage: { input: 11, output: 7, reasoning: 3, totalTokens: 18, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    };
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'thinking_delta', contentIndex: 0, delta: 'PRIVATE_THINKING', partial: message });
      stream.push({ type: 'text_delta', contentIndex: 1, delta: 'VISIBLE_', partial: message });
      stream.push({ type: 'text_delta', contentIndex: 1, delta: 'OUTPUT', partial: message });
      stream.push({ type: 'done', reason: 'toolUse', message });
      stream.end();
    });
    return stream;
  };
  await runPiAgent(testConfig(), {
    systemPrompt: 'PRIVATE_SYSTEM_PROMPT', initialPrompt: 'PRIVATE_INITIAL_PROMPT', continuationPrompt: () => 'continue',
    tools: [complete], isComplete: () => completed,
    signal: new AbortController().signal, assertActive() {}, progress: () => ({ completed: Number(completed), total: 1 }),
    providerStream, telemetry: event => events.push(event), ...activity
  });
  assert.equal(completed, true);
  return events;
}
