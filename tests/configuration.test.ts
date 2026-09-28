import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, DEFAULT_MODEL, validateGroup } from '../src/server/store.js';
import { exportConfiguration, importConfiguration } from '../src/server/configuration.js';

test('configuration roundtrip, optional credentials, validation and endpoint isolation', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'netcare-config-'));
  const source = new Store(path.join(dir, 'source')), target = new Store(path.join(dir, 'target'));
  try {
    source.saveModel({ ...DEFAULT_MODEL, apiKey: 'source-secret' });
    source.savePreferences({ theme: 'dark' });
    source.saveGroup(validateGroup({ name: 'Rules', rules: [{ Id: '1', Title: 'Title', Description: 'Description', enabled: true }] }));
    const publicConfig = exportConfiguration(source);
    assert.equal(JSON.stringify(publicConfig).includes('source-secret'), false);
    target.saveModel({ ...DEFAULT_MODEL, apiKey: 'existing-secret' });
    importConfiguration(target, publicConfig);
    assert.equal(target.model(true).apiKey, 'existing-secret');
    assert.equal(target.preferences().theme, 'dark');
    importConfiguration(target, exportConfiguration(source, true));
    assert.equal(target.model(true).apiKey, 'source-secret');
    assert.equal(target.groups().length, 2);
    assert.equal(JSON.stringify(target.db.prepare('SELECT value FROM settings').all()).includes('source-secret'), false);
    const invalid = { ...publicConfig, preferences: { theme: 'invalid' } };
    assert.throws(() => importConfiguration(target, invalid));
    assert.equal(target.groups().length, 2);
    importConfiguration(target, { ...publicConfig, model: { ...publicConfig.model, baseUrl: 'https://example.com/v1' } });
    assert.equal(target.model().hasApiKey, false);
    assert.equal(target.tasks().length, 0);
  } finally {
    source.db.close(); target.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
