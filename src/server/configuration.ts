import { Store, validateGroup, validateModel } from './store.js';

export function exportConfiguration(store: Store, includeKey = false) {
  const { hasApiKey, ...model } = store.model(includeKey);
  const result = {
    format: 'netcare-rfc-configuration', version: 1,
    createdAt: new Date().toISOString(), model,
    preferences: store.preferences(), groups: store.groups(),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 10 * 1024 * 1024)
    throw new Error('配置超过 10 MB，请分别导出规则组');
  return result;
}

export function importConfiguration(store: Store, input: any) {
  if (!input || input.format !== 'netcare-rfc-configuration' || input.version !== 1
      || !Array.isArray(input.groups) || input.groups.length > 500)
    throw new Error('配置文件格式或版本不支持');
  const model = validateModel(input.model);
  const theme = input.preferences?.theme;
  if (!['light', 'dark', 'system'].includes(theme)) throw new Error('主题配置无效');
  const groups = input.groups.map((g: any) => validateGroup(g));
  // Without an imported key, never carry credentials to a different endpoint.
  const clearKey = !model.apiKey?.trim() && model.baseUrl !== store.model().baseUrl;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.saveModel(model, clearKey);
    store.savePreferences({ theme });
    for (const group of groups) store.saveGroup(group);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
  return { groups: groups.length, preferences: { theme }, hasApiKey: store.model().hasApiKey };
}
