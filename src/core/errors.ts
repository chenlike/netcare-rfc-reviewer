/** Agent 执行错误不绑定传输协议；HTTP 状态由接入层处理。 */
export class AgentError extends Error {
  constructor(public readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}
