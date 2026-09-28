import type { AgentConfig } from '../../core/config.js';

/** RFC 阅读工具的输出预算；采用本地启发式估算，并非供应商的实际计费 Token。 */
export interface RfcReadingConfig {
  outlineTokens: number;
  searchTokens: number;
  readTokens: number;
  maxTokens: number;
}

/** 领域配置不进入通用执行核心，其他 Agent 类型无需读取这些选项。 */
export interface RfcReviewConfig extends AgentConfig {
  rfcReading?: Partial<RfcReadingConfig>;
}

export const DEFAULT_RFC_READING: Readonly<RfcReadingConfig> = Object.freeze({
  outlineTokens: 600, searchTokens: 800, readTokens: 2000, maxTokens: 6000
});

/** 缺少配置时使用默认预算；不允许无效预算令截断、续读或证据记录失效。 */
export function resolveRfcReading(config?: Partial<RfcReadingConfig>): RfcReadingConfig {
  if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config)))
    throw new Error('Invalid rfcReading configuration');
  const value = { ...DEFAULT_RFC_READING, ...config };
  if (!Number.isSafeInteger(value.maxTokens) || value.maxTokens < 256 || value.maxTokens > 32000)
    throw new Error('Invalid rfcReading.maxTokens (256..32000)');
  for (const key of ['outlineTokens', 'searchTokens', 'readTokens'] as const)
    if (!Number.isSafeInteger(value[key]) || value[key] < 128 || value[key] > value.maxTokens)
      throw new Error(`Invalid rfcReading.${key} (128..maxTokens)`);
  return value;
}
