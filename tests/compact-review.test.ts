import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewTools, type ReviewContext } from '../src/agents/rfc-review/reviewer.js';
import { parsePackage } from '../src/agents/rfc-review/document.js';
import { task, zipHtml } from './helpers.js';

async function fixture(html: string) {
  const request = task(), submitted: any[] = [];
  const ctx: ReviewContext = { request, pending: request.Checklist, pkg: await parsePackage(zipHtml(html)), signal: new AbortController().signal, assertActive() {}, async submit(value) { submitted.push(value); } };
  const { tools } = buildReviewTools(ctx, true);
  const execute = (name: string, args: object = {}) => tools.find(tool => tool.name === name)!.execute('test', args as never, ctx.signal);
  return { ctx, submitted, execute };
}
const result = (ref: string, quote: string) => ({ checklistId: '101', verdict: 'passed', ref, quote, description: '已核实', suggestion: '', verificationSummary: '直接原文证据满足要求', unresolvedQuestions: [], evidence: [] });
const text = (output: any) => output.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');

test('短编号提交还原唯一原文定位，未读的同文块不能被冒充引用', async () => {
  const { ctx, submitted, execute } = await fixture('<p>Available</p><p>Available</p>');
  const output = await execute('read_document', { refs: ['B1'] });
  assert.equal(text(output).includes('nth-of-type'), false);
  await assert.rejects(execute('submit_checklist_result', result('B2', 'Available')), /READ_CITED_EVIDENCE/);
  await execute('submit_checklist_result', result('B1', 'Available'));
  assert.equal(submitted[0].DocumentPath, 'index.html');
  assert.equal(submitted[0].Selector, ctx.pkg.blocks[0]!.selector);
  assert.equal(submitted[0].Quote, 'Available');
});

test('同一会话重复阅读返回引用，需要时可显式重展', async () => {
  const { execute } = await fixture('<p>UNIQUE_BODY_CONTENT</p>');
  assert.match(text(await execute('read_document', { refs: ['B1'] })), /UNIQUE_BODY_CONTENT/);
  const repeat = text(await execute('read_document', { refs: ['B1'] }));
  assert.equal(repeat.includes('UNIQUE_BODY_CONTENT'), false);
  assert.match(repeat, /B1/);
  assert.match(text(await execute('read_document', { refs: ['B1'], full: true })), /UNIQUE_BODY_CONTENT/);
});

test('图片短编号只需真实看图即可提交，无需伪造正文引文', async () => {
  const { submitted, execute } = await fixture('<svg width="20" height="20"><rect width="20" height="20" fill="green"/></svg>');
  await assert.rejects(execute('submit_checklist_result', result('I1', '')), /READ_DOCUMENT_BEFORE|INSPECT_IMAGE_BEFORE/);
  await execute('inspect_image', { imageId: 'I1' });
  await execute('submit_checklist_result', result('I1', ''));
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].Quote, '');
});

test('同会话的图片及裁切范围复用历史，显式重看或新范围才再次发送图像', async () => {
  const { ctx, execute } = await fixture('<svg width="20" height="20"><rect width="20" height="20" fill="green"/></svg>');
  const hasImage = (result: any) => result.content.some((part: any) => part.type === 'image');
  assert.equal(hasImage(await execute('inspect_image', { imageId: 'I1' })), true);
  const repeat = await execute('inspect_image', { imageId: ctx.pkg.images[0]!.id });
  assert.equal(hasImage(repeat), false);
  assert.equal(JSON.parse(text(repeat)).alreadyInspected, true);
  const region = { x: 0, y: 0, width: 0.5, height: 0.5 };
  assert.equal(hasImage(await execute('inspect_image', { imageId: 'I1', region })), true);
  assert.equal(hasImage(await execute('inspect_image', { imageId: 'I1', region })), false);
  assert.equal(hasImage(await execute('inspect_image', { imageId: 'I1', region, full: true })), true);
  assert.equal(hasImage(await execute('inspect_image', { imageId: 'I1', region: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } })), true);
  const newAttempt = buildReviewTools(ctx, true);
  const firstInNewAttempt = await newAttempt.tools.find(tool => tool.name === 'inspect_image')!.execute('new', { imageId: 'I1' }, ctx.signal);
  assert.equal(hasImage(firstInNewAttempt), true);
});

test('旧显式定位也不能借用其他节点的同文证据', async () => {
  const { execute } = await fixture('<p id="a">Available</p><p id="b">Available</p>');
  await execute('read_document', { refs: ['B1'] });
  const location = { documentPath: 'index.html', selector: '#b', quote: 'Available' };
  const { ref: _ref, ...args } = result('', 'Available');
  await assert.rejects(execute('submit_checklist_result', { ...args, ...location, evidence: [location] }), /READ_CITED_EVIDENCE/);
});

test('搜索长块末尾的命中窗口可引用，未返回的开头不能被标记为已读', async () => {
  const { execute } = await fixture(`<p>UNREAD_BEGIN ${'x'.repeat(9000)} ACTUAL_MATCH_END</p>`);
  const output = text(await execute('search_document', { query: 'ACTUAL_MATCH_END' }));
  assert.match(output, /ACTUAL_MATCH_END/);
  assert.equal(output.includes('UNREAD_BEGIN'), false);
  await assert.rejects(execute('submit_checklist_result', result('B1', 'UNREAD_BEGIN')), /READ_CITED_EVIDENCE/);
  await execute('submit_checklist_result', result('B1', 'ACTUAL_MATCH_END'));
});

test('旧单元格定位不能借用同一表格行中尚未读到的同文单元格', async () => {
  const { execute } = await fixture(`<table><tr><td>Available</td><td>${'填充'.repeat(1000)}</td><td id="later">Available</td></tr></table>`);
  await execute('read_document', { refs: ['B1'], tokenBudget: 256 });
  const { ref: _ref, ...args } = result('', 'Available');
  const location = { documentPath: 'index.html', selector: '#later', quote: 'Available' };
  await assert.rejects(execute('submit_checklist_result', { ...args, ...location, evidence: [location] }), /READ_CITED_EVIDENCE/);
  await execute('read_document', { refs: ['B1'], full: true, tokenBudget: 6000 });
  await execute('submit_checklist_result', { ...args, ...location, evidence: [location] });
});

test('跨分页边界的引文只有连续范围全部读到才允许提交', async () => {
  const { execute } = await fixture(`<p>${'甲'.repeat(2000)}边界核验${'乙'.repeat(1000)}</p>`);
  let response = JSON.parse(text(await execute('read_document', { refs: ['B1'], tokenBudget: 256 })));
  await assert.rejects(execute('submit_checklist_result', result('B1', '甲边界核验乙')), /READ_CITED_EVIDENCE/);
  let pages = 1;
  while (response.nextCursor) {
    response = JSON.parse(text(await execute('read_document', { refs: ['B1'], tokenBudget: 256, cursor: response.nextCursor })));
    assert.ok(++pages < 100);
  }
  await execute('submit_checklist_result', result('B1', '甲边界核验乙'));
});
