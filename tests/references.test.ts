import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import { prepareReference, referenceImage } from '../src/agents/rfc-review/references.js';
import { buildReferenceTools } from '../src/agents/rfc-review/reference-tools.js';
import { Store, DEFAULT_MODEL, validateModel, validateGroup } from '../src/server/store.js';
import { DEFAULT_RFC_PROMPT } from '../src/agents/rfc-review/prompt.js';
import { createApp } from '../src/server/app.js';
import { Engine } from '../src/server/engine.js';
import { exportWorkspace, importWorkspace } from '../src/server/workspace.js';
import { zipHtml } from './helpers.js';
import { parsePackage } from '../src/agents/rfc-review/document.js';
import { buildReviewTools } from '../src/agents/rfc-review/reviewer.js';

function pdfFixture() {
  let value = '%PDF-1.4\n';
  const stream = 'BT /F1 12 Tf 30 150 Td (Required version 8.6.1) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(value.length); value += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = value.length;
  value += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(value);
}

test('reference parsers handle PDF text and actual page rendering, DOCX, HTML and images', async () => {
  const pdf = await prepareReference(pdfFixture(), 'manual.pdf', 'R1');
  assert.match(pdf.Text[0]!, /8\.6\.1/);
  assert.equal(pdf.Sections, 1);
  const screenshot = await referenceImage(pdf, 1);
  assert.equal((await sharp(Buffer.from(screenshot.data, 'base64')).metadata()).format, 'png');
  const docx = new JSZip();
  docx.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  docx.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Manual version 8.6.1</w:t></w:r></w:p></w:body></w:document>');
  const doc = await prepareReference(await docx.generateAsync({ type: 'nodebuffer' }), 'manual.docx', 'R2');
  assert.match(doc.Text[0]!, /8\.6\.1/);
  const html = await prepareReference(Buffer.from('<script>DO NOT READ</script><p>Version 8.6.1</p>'), 'manual.html', 'R3');
  assert.match(html.Text[0]!, /Version/); assert.doesNotMatch(html.Text[0]!, /DO NOT READ/);
  const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'white' } }).png().toBuffer();
  assert.equal((await prepareReference(png, 'topology.png', 'R4')).Images, 1);
  await assert.rejects(prepareReference(Buffer.from('bad'), 'bad.exe', 'R1'));
});

test('reference tools require observed citations, paginate and reuse previously read content', async () => {
  const ref = await prepareReference(Buffer.from('A'.repeat(4500) + ' required 8.6.1'), 'manual.txt', 'R1');
  const { tools, citations } = buildReferenceTools([ref], true, () => {});
  const invoke = (name: string, params: any) => tools.find(t => t.name === name)!.execute('id', params, undefined);
  const cite = [{ referenceId: 'R1', section: 1, quote: 'required 8.6.1' }];
  assert.throws(() => citations(cite), /READ_REFERENCE/);
  await invoke('search_references', { query: 'required' });
  assert.throws(() => citations(cite), /READ_REFERENCE/);
  const first = await invoke('read_reference', { referenceId: 'R1', section: 1 });
  assert.match(JSON.stringify(first), /nextOffset.*4000/);
  assert.throws(() => citations(cite), /READ_REFERENCE/);
  await invoke('read_reference', { referenceId: 'R1', section: 1, offset: 4000 });
  assert.match(citations(cite), /manual.txt/);
  const again = await invoke('read_reference', { referenceId: 'R1', section: 1, offset: 4000 });
  assert.match(JSON.stringify(again), /已读/);
  assert.throws(() => citations([{ referenceId: 'R1', image: 1, quote: '' }]), /INSPECT_REFERENCE/);
});

test('submitted findings include verified reference citations while primary location stays in the plan', async () => {
  const material = await prepareReference(Buffer.from('Required version 8.6.1'), 'manual.txt', 'R1');
  let submitted: any;
  const { tools } = buildReviewTools({ request: { TaskId: 'test', Title: 'Test', EntryPath: 'index.html' },
    pkg: await parsePackage(zipHtml('<p id="scope">Available</p>')), references: [material],
    pending: [{ Id: 'one', Title: 'Rule', Description: 'Check', Level: '必要' }], signal: new AbortController().signal,
    assertActive() {}, async submit(value) { submitted = value; },
  }, true);
  const invoke = (name: string, value: any) => tools.find(tool => tool.name === name)!.execute('test', value, undefined);
  await invoke('read_document', {});
  const params = { checklistId: 'one', verdict: 'passed', description: 'Checked', suggestion: '', documentPath: 'index.html', selector: '#scope', quote: 'Available', verificationSummary: 'Compared manual', unresolvedQuestions: [], evidence: [{ documentPath: 'index.html', selector: '#scope', quote: 'Available' }], referenceEvidence: [{ referenceId: 'R1', section: 1, quote: 'Required version 8.6.1' }] };
  await assert.rejects(invoke('submit_checklist_result', params), /READ_REFERENCE/);
  assert.equal(submitted, undefined);
  await invoke('read_reference', { referenceId: 'R1', section: 1 });
  await invoke('submit_checklist_result', params);
  assert.equal(submitted.Selector, '#scope');
  assert.match(submitted.Description, /manual.txt/);
  assert.match(submitted.Description, /Required version 8.6.1/);
});

test('multipart task creation freezes reference materials and prompt, backup restores originals, deletion cleans files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'netcare-refs-'));
  const store = new Store(path.join(directory, 'source')), target = new Store(path.join(directory, 'target'));
  let received: any, prompt: string | undefined;
  const engine = new Engine(store, config => ({ async review(context) {
    received = context.references; prompt = config.basePrompt;
    await context.submit({ ChecklistId: 'one', Verdict: 'passed', Description: 'ok', Suggestion: '', Level: '必要', DocumentPath: 'index.html', Selector: '#scope', Quote: 'Available' });
  } }));
  const { server } = createApp(store, engine);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    store.saveModel({ ...DEFAULT_MODEL, apiKey: 'fixture', basePrompt: '自定义审核指令' });
    const group = store.saveGroup(validateGroup({ name: 'Rules', rules: [{ Id: 'one', Title: 'Rule', Description: 'Check' }] }));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const boot = await (await fetch(base + '/api/bootstrap')).json() as any;
    const id = randomUUID(), headers = { 'X-Studio-Token': boot.token, 'X-Upload-Id': id };
    const invalid = new FormData();
    for (const name of ['one.zip', 'two.zip']) invalid.append('file', new Blob([new Uint8Array(zipHtml('<p>Plan</p>'))]), name);
    const rejected = await fetch(base + `/api/tasks?group=${group.id}&fileName=plan.zip`, { method: 'POST', headers: { ...headers, 'X-Upload-Id': randomUUID() }, body: invalid });
    assert.equal(rejected.status, 400);
    assert.match(await rejected.text(), /每次只能上传一个 ZIP 主方案/);
    assert.equal(store.tasks().length, 0);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(zipHtml('<p id="scope">Available</p>'))]), 'plan.zip');
    form.append('references', new Blob(['参考标准 8.6.1']), 'guide.txt');
    form.append('references', new Blob(['## 操作指导\n需要备份']), 'steps.md');
    const response = await fetch(base + `/api/tasks?group=${group.id}&fileName=plan.zip`, { method: 'POST', headers, body: form });
    assert.equal(response.status, 201, await response.clone().text());
    for (let i = 0; i < 100 && store.task(id)?.Status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(received.length, 2); assert.equal(prompt, '自定义审核指令');
    assert.equal(store.task(id)?.BasePrompt, prompt);
    assert.equal(store.task(id)?.Status, 'completed');
    store.saveModel({ ...DEFAULT_MODEL, apiKey: 'fixture', basePrompt: '后来修改的指令' });
    const retryTask = store.task(id)!;
    retryTask.Status = 'failed'; retryTask.Checklist.forEach(item => item.Status = 'pending'); store.saveTask(retryTask);
    engine.retry(id);
    for (let i = 0; i < 100 && store.task(id)?.Status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(prompt, '自定义审核指令');
    const duplicate = await fetch(base + `/api/tasks?group=${group.id}&fileName=plan.zip`, { method: 'POST', headers, body: form });
    assert.equal(duplicate.status, 201); assert.equal(store.tasks().length, 1);
    const downloaded = await fetch(base + `/api/tasks/${id}/references?id=R1`);
    assert.equal(await downloaded.text(), '参考标准 8.6.1');
    const backup = await exportWorkspace(store);
    await importWorkspace(target, backup);
    assert.equal(target.task(id)?.References?.length, 2);
    assert.equal(target.task(id)?.BasePrompt, prompt);
    const restored = JSON.parse(await readFile(target.referencesPath(id), 'utf8'));
    assert.equal(Buffer.from(restored[0].Raw, 'base64').toString(), '参考标准 8.6.1');
    assert.equal(validateModel({ ...DEFAULT_MODEL, basePrompt: '' }).basePrompt, DEFAULT_RFC_PROMPT);
    await fetch(base + `/api/tasks/${id}`, { method: 'DELETE', headers });
    await assert.rejects(access(store.referencesPath(id)));
  } finally {
    await engine.stop(); server.closeAllConnections(); server.close(); store.close(); target.close();
    await rm(directory, { recursive: true, force: true });
  }
});
