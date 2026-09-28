import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewResult } from '../src/agents/rfc-review/contracts.js';
import { parsePackage } from '../src/agents/rfc-review/document.js';
import { buildReviewTools, type ReviewContext } from '../src/agents/rfc-review/reviewer.js';
import { task, zipHtml } from './helpers.js';

const unrelatedSvg = '<svg width="20" height="20"><title>Company logo</title><rect width="20" height="20" fill="green"/></svg>';

async function fixture(html: string, supportsImages: boolean) {
  const request = task(), submitted: ReviewResult[] = [], calls: string[] = [];
  const context: ReviewContext = {
    request, pkg: await parsePackage(zipHtml(html)), pending: request.Checklist,
    signal: new AbortController().signal, assertActive() {},
    async submit(result) { submitted.push(result); },
  };
  // The package contains a valid, decodable image even when this model cannot inspect it.
  assert.equal(context.pkg.images.length, 1);
  assert.deepEqual(context.pkg.warnings, []);
  const { tools, completed } = buildReviewTools(context, supportsImages);
  return {
    context, submitted, calls, completed,
    async execute(name: string, args: object = {}) {
      calls.push(name);
      const tool = tools.find(candidate => candidate.name === name);
      assert.ok(tool, `Missing tool: ${name}`);
      if (name === 'submit_checklist_result') {
        const location = args as { documentPath: string; selector: string; quote: string };
        args = { verificationSummary: '已核实相关 HTML，无需无关图片。', unresolvedQuestions: [],
          evidence: location.documentPath ? [{ documentPath: location.documentPath, selector: location.selector, quote: location.quote }] : [], ...args };
      }
      return tool.execute('html-first-test', args as never, context.signal);
    },
  };
}

test('HTML browsing tools return text and image metadata without multimodal image content', async () => {
  const { context, execute, calls } = await fixture(`<p>Available</p>${unrelatedSvg}`, true);
  const image = context.pkg.images[0]!;
  const outputs = [
    await execute('list_documents'),
    await execute('read_document', { offset: 0, limit: 20 }),
    await execute('search_document', { query: 'Company logo' }),
  ];
  const payloads = outputs.map(output => {
    assert.ok(output.content.length > 0);
    assert.ok(output.content.every(content => content.type === 'text'));
    const text = output.content.map(content => content.type === 'text' ? content.text : '').join('');
    assert.equal(text.includes(image.data.toString('base64')), false);
    return JSON.parse(text);
  });
  assert.equal(payloads[0].images, undefined);
  assert.match(payloads[1].text, /Available/);
  assert.match(payloads[1].text, /I1/);
  assert.match(payloads[2].text, /B\d+/);
  for (const payload of payloads) {
    const text = JSON.stringify(payload);
    assert.equal(text.includes(image.selector), false);
    assert.equal(text.includes(image.id), false);
    assert.equal(text.includes('"data"'), false);
  }
  assert.equal(calls.includes('inspect_image'), false);
});

test('sufficient HTML evidence passes with an unrelated SVG and an image-unsupported model', async () => {
  const { context, execute, submitted, completed, calls } = await fixture(`<p>Available</p><p>Unrelated chapter</p>${unrelatedSvg}`, false);
  const evidence = context.pkg.blocks.find(block => block.text === 'Available')!;
  await execute('read_document', { offset: 0, limit: 1 });
  await execute('submit_checklist_result', {
    checklistId: '101', verdict: 'passed', description: 'HTML explicitly confirms availability.', suggestion: '',
    documentPath: evidence.documentPath, selector: evidence.selector, quote: 'Available',
  });
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]!.Verdict, 'passed');
  assert.equal(completed.has('101'), true);
  assert.equal(calls.includes('inspect_image'), false);
});

test('a missing-information verdict requires complete HTML text coverage but no unrelated image inspection', async () => {
  const { context, execute, submitted, completed, calls } = await fixture(`<p>${'A'.repeat(10000)}</p><p>Available</p>${unrelatedSvg}`, false);
  assert.deepEqual(context.pkg.blocks.map(block => block.kind), ['text', 'text', 'image']);
  const missing = {
    checklistId: '101', verdict: 'failed', description: 'The HTML contains no rollback instructions.',
    suggestion: 'Add the rollback steps and responsible person.', documentPath: '', selector: '', quote: '',
  };
  let page = await execute('read_document', { refs: ['B1'] });
  await assert.rejects(execute('submit_checklist_result', missing), /MISSING_INFORMATION_REQUIRES_FULL/);
  assert.equal(submitted.length, 0);
  let cursor = JSON.parse((page.content[0] as { text: string }).text).nextCursor;
  while (cursor) {
    page = await execute('read_document', { refs: ['B1'], cursor });
    cursor = JSON.parse((page.content[0] as { text: string }).text).nextCursor;
  }
  // Covering a long block is insufficient while another HTML text block remains unread.
  await assert.rejects(execute('submit_checklist_result', missing), /MISSING_INFORMATION_REQUIRES_FULL/);
  assert.equal(submitted.length, 0);
  await execute('read_document', { offset: 1, limit: 1 });
  await execute('submit_checklist_result', missing);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]!.Verdict, 'failed');
  assert.equal(submitted[0]!.DocumentPath, '');
  assert.equal(completed.has('101'), true);
  assert.equal(calls.includes('inspect_image'), false);
});

test('reading HTML and image metadata does not permit citing an uninspected image', async () => {
  const { context, execute, submitted, completed, calls } = await fixture(`<p>Available</p>${unrelatedSvg}`, true);
  const image = context.pkg.images[0]!;
  await execute('list_documents');
  await execute('read_document', { offset: 0, limit: 20 });
  await execute('search_document', { query: 'Company logo' });
  await assert.rejects(execute('submit_checklist_result', {
    checklistId: '101', verdict: 'passed', description: 'The image confirms the requirement.', suggestion: '',
    documentPath: image.documentPath, selector: image.selector, quote: '',
  }), /INSPECT_IMAGE_BEFORE_CITING/);
  assert.equal(submitted.length, 0);
  assert.equal(completed.size, 0);
  assert.equal(calls.includes('inspect_image'), false);
});
