import { readFileSync } from 'node:fs';
import { Store, validateGroup } from './store.js';

/** Apply once per workspace; deletion and user edits remain respected on later starts. */
export function initializePresets(store: Store) {
  const marker = 'preset:rfc-standard:v1';
  if (store.db.prepare('SELECT id FROM settings WHERE id=?').get(marker)) return;
  const preset = validateGroup(JSON.parse(readFileSync(new URL('../../presets/rfc-standard.json', import.meta.url), 'utf8')));
  const alreadyImported = store.groups().some(group =>
    group.name === preset.name && preset.rules.every(rule => group.rules.some(existing => existing.Id === rule.Id)));
  store.db.exec('BEGIN IMMEDIATE');
  try {
    if (!alreadyImported) store.saveGroup(preset);
    store.db.prepare('INSERT INTO settings VALUES (?, ?)').run(marker, 'true');
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}
