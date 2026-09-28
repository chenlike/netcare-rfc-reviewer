import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, validateGroup } from '../src/server/store.js';
import { initializePresets } from '../src/server/presets.js';

test('preset installs once, preserves existing rules and respects deletion', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'netcare-preset-'));
  const store = new Store(dir);
  try {
    store.saveGroup(validateGroup({ name: 'Custom', rules: [{ Title: 'Custom', Description: 'Keep' }] }));
    initializePresets(store);
    assert.equal(store.groups().length, 2);
    const preset = store.groups().find(g => g.name === 'RFC 方案审核规则')!;
    assert.equal(preset.rules.length, 24);
    initializePresets(store);
    assert.equal(store.groups().length, 2);
    store.deleteGroup(preset.id);
    initializePresets(store);
    assert.equal(store.groups().length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
