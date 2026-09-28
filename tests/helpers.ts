import type { RfcReviewConfig as RuntimeConfig } from '../src/agents/rfc-review/config.js';
import type { ChecklistItem, ReviewResult } from '../src/agents/rfc-review/contracts.js';
type RunRequest = { TaskId: string; Title: string; EntryPath: string; Checklist: ChecklistItem[] };

export function testConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return { runTimeoutMs: 3000, maxModelCalls: 12, maxToolCalls: 30, maxDownloadBytes: 1024 * 1024,
    model: { provider: 'test', id: 'test-model', baseUrl: 'http://localhost', apiKeyEnvironmentVariable: 'TEST_API_KEY', contextWindow: 128000, maxTokens: 1024, supportsImages: true }, ...overrides };
}
export function task(overrides: Partial<RunRequest> = {}): RunRequest {
  return { TaskId: '42', Title: 'Test review', EntryPath: 'index.html',
    Checklist: [{ Id: '101', Title: 'Availability', Description: 'Verify availability', Level: 'required', Status: 'pending' }], ...overrides };
}
export function result(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return { ChecklistId: '101', Verdict: 'passed', Description: 'Evidence checked', Suggestion: '', Level: 'required', DocumentPath: 'index.html', Selector: 'p', Quote: 'Available', ...overrides };
}
export function zipHtml(html = '<p>Available</p>'): Buffer {
  const data = Buffer.from(html), name = Buffer.from('index.html');
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}
