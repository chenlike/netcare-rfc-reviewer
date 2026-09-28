/** Shared execution limits and provider settings for any agent implementation. */
export interface AgentConfig {
  /** 整次任务尝试的运行和调用上限。 */
  runTimeoutMs: number;
  maxModelCalls: number;
  maxToolCalls: number;
  /** Maximum input size accepted by an adapter, in bytes. */
  maxDownloadBytes: number;
  model: {
    provider: string;
    id: string;
    baseUrl: string;
    apiKeyEnvironmentVariable: string;
    contextWindow: number;
    maxTokens: number;
    supportsImages: boolean;
    temperature?: number;
    thinkingLevel?: 'off' | 'low' | 'high' | 'max';
    requestTimeoutMs?: number;
  };
}
