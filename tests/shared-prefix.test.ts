import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import type { ReviewResult } from '../src/agents/rfc-review/contracts.js';
import { parsePackage } from '../src/agents/rfc-review/document.js';
import { PiReviewer } from '../src/agents/rfc-review/reviewer.js';
import type { AgentTelemetry } from '../src/core/pi-runner.js';
import { task, testConfig, zipHtml } from './helpers.js';

interface WireMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }> | null;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
}
interface WireRequest {
  messages: WireMessage[];
  tools: unknown[];
  thinking: { type: string };
  reasoning_effort: string;
  temperature?: number;
}
const messageText = (message: WireMessage) => typeof message.content === 'string' ? message.content
  : (message.content ?? []).map(part => part.text ?? '').join('');

test('one checklist conversation preserves the HTTP prefix, read evidence and DeepSeek reasoning across submissions', async () => {
  const request = task({ Checklist: [
    { Id: '101', Title: 'Availability', Description: 'Verify availability', Level: 'required', Status: 'pending' },
    { Id: '102', Title: 'Recovery', Description: 'Verify recovery documentation', Level: 'required', Status: 'pending' },
  ] });
  const submitted: ReviewResult[] = [], telemetry: AgentTelemetry[] = [], requests: WireRequest[] = [];
  const paths: string[] = [], serverErrors: unknown[] = [];
  const submission = (checklistId: string, quote: string) => ({
    checklistId, verdict: 'passed', description: `${quote} is confirmed.`, suggestion: '', ref: 'B1', quote,
    verificationSummary: 'Checked the shared source paragraph.', unresolvedQuestions: [], evidence: [],
  });
  const turns = [
    { name: 'read_document', args: { refs: ['B1'] }, reasoning: 'Read the paragraph for both checklist rules.' },
    { name: 'submit_checklist_result', args: submission('101', 'Available'), reasoning: 'The paragraph supports availability.' },
    { name: 'submit_checklist_result', args: submission('102', 'Recovery is documented'), reasoning: 'The same paragraph supports recovery documentation.' },
  ];
  const server = http.createServer(async (incoming, response) => {
    try {
      let body = '';
      for await (const chunk of incoming) body += chunk.toString();
      paths.push(incoming.url ?? '');
      requests.push(JSON.parse(body) as WireRequest);
      const index = requests.length - 1, turn = turns[index];
      assert.ok(turn, 'The checklist must finish without restarting or making another model request.');
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const envelope = { id: `shared-prefix-${index}`, object: 'chat.completion.chunk', created: 1, model: 'test-model' };
      const write = (delta: object, finishReason: string | null = null, usage?: object) => response.write(
        `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}) })}\n\n`,
      );
      write({ role: 'assistant', reasoning_content: turn.reasoning });
      write({ tool_calls: [{ index: 0, id: `call-${index}`, type: 'function', function: { name: turn.name, arguments: JSON.stringify(turn.args) } }] });
      write({}, 'tool_calls', {
        prompt_tokens: 100, completion_tokens: 10, total_tokens: 110,
        prompt_cache_hit_tokens: 75, prompt_cache_miss_tokens: 25,
        completion_tokens_details: { reasoning_tokens: 4 },
      });
      response.end('data: [DONE]\n\n');
    } catch (error) {
      serverErrors.push(error);
      response.writeHead(500).end('Unexpected local test request');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const key = 'SHARED_PREFIX_LOCAL_TEST_KEY', previous = process.env[key];
  process.env[key] = 'local-test-key';
  try {
    const base = testConfig();
    const config = testConfig({
      runTimeoutMs: 10000, maxModelCalls: 3, maxToolCalls: 3,
      model: { ...base.model, provider: 'deepseek', baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnvironmentVariable: key, thinkingLevel: 'low', temperature: 0 },
    });
    await new PiReviewer(config, undefined, event => telemetry.push(event)).review({
      request, pkg: await parsePackage(zipHtml('<p>Available. Recovery is documented.</p>')), pending: request.Checklist,
      signal: new AbortController().signal, assertActive() {}, async submit(result) { submitted.push(result); },
    });

    assert.deepEqual(serverErrors, []);
    assert.deepEqual(paths, ['/chat/completions', '/chat/completions', '/chat/completions']);
    assert.equal(requests.length, 3);
    const first = requests[0]!;
    assert.deepEqual(first.messages.map(message => message.role), ['system', 'user']);
    assert.deepEqual(JSON.parse(messageText(first.messages[1]!)).checklist, request.Checklist);
    assert.ok(first.tools.length > 0);
    for (const [index, payload] of requests.entries()) {
      assert.deepEqual(payload.thinking, { type: 'enabled' });
      assert.equal(payload.reasoning_effort, 'low');
      assert.equal(payload.temperature, undefined);
      assert.equal(JSON.stringify(payload.tools), JSON.stringify(first.tools));
      assert.equal(JSON.stringify(payload.messages[0]), JSON.stringify(first.messages[0]));
      assert.equal(payload.messages.filter(message => message.role === 'system').length, 1);
      assert.equal(payload.messages.filter(message => message.role === 'user').length, 1);
      // Completed rules remain in the unchanged initial input, including after submitting rule 101.
      assert.equal(JSON.stringify(payload.messages[1]!.content), JSON.stringify(first.messages[1]!.content));
      assert.deepEqual(JSON.parse(messageText(payload.messages[1]!)).checklist, request.Checklist);
      assert.equal(payload.messages.length, 2 + index * 2);
      if (index > 0) {
        const previousRequest = requests[index - 1]!;
        assert.equal(JSON.stringify(payload.messages.slice(0, previousRequest.messages.length)), JSON.stringify(previousRequest.messages));
      }
      for (let priorTurn = 0; priorTurn < index; priorTurn++) {
        const assistant = payload.messages[2 + priorTurn * 2]!, toolResult = payload.messages[3 + priorTurn * 2]!;
        assert.equal(assistant.role, 'assistant');
        assert.equal(assistant.reasoning_content, turns[priorTurn]!.reasoning);
        assert.equal(assistant.tool_calls?.[0]?.function.name, turns[priorTurn]!.name);
        assert.equal(toolResult.role, 'tool');
        assert.equal(toolResult.tool_call_id, `call-${priorTurn}`);
      }
    }
    assert.match(messageText(requests[2]!.messages[3]!), /Available\. Recovery is documented\./);
    assert.deepEqual(JSON.parse(messageText(requests[2]!.messages[5]!)), { checklistId: '101', acknowledged: true, remaining: 1 });
    assert.deepEqual(submitted.map(result => [result.ChecklistId, result.Verdict]), [['101', 'passed'], ['102', 'passed']]);
    assert.deepEqual(telemetry.filter(event => event.event === 'tool_start').map(event => event.tool), turns.map(turn => turn.name));
    assert.equal(telemetry.filter(event => event.event === 'agent_start').length, 1);
    const ends = telemetry.filter(event => event.event === 'agent_end');
    assert.equal(ends.length, 1);
    assert.equal(new Set(telemetry.map(event => event.run)).size, 1);
    const end = ends[0]!;
    assert.equal(end.outcome, 'completed');
    assert.equal(end.completed, 2);
    assert.equal(end.total, 2);
    assert.equal(end.modelCalls, 3);
    assert.equal(end.toolCalls, 3);
    assert.equal(end.cacheReadTokens, 225);
    assert.equal(end.inputTokens, 75);
    assert.equal(end.promptTokens, 300);
    assert.equal(end.outputTokens, 30);
    assert.equal(end.reasoningTokens, 12);
    assert.equal(end.totalTokens, 330);
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
