import { logPreview } from "../core/log-preview.js";
import type { ModelSettings } from "./store.js";

/** Test exactly the draft shown in the UI without saving it or starting an audit. */
export async function testModel(value: ModelSettings, signal?: AbortSignal) {
  const key = value.apiKey || "";
  if (!key) throw new Error("请填写 API Key，或留空使用本机已保存的 Key");
  const started = Date.now();
  try {
    const response = await fetch(`${value.baseUrl}/chat/completions`, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      signal: AbortSignal.any([
        AbortSignal.timeout(Math.min(30000, value.requestTimeoutMs)),
        ...(signal ? [signal] : []),
      ]),
      body: JSON.stringify({
        model: value.model,
        messages: [{ role: "user", content: "只回复 OK" }],
        max_tokens: 64,
        ...(value.provider === "deepseek"
          ? { thinking: { type: "disabled" } }
          : {}),
      }),
    });
    const reader = response.body?.getReader();
    let raw = "",
      bytes = 0;
    const decoder = new TextDecoder();
    if (reader)
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          bytes += chunk.length;
          if (bytes > 65536) {
            await reader.cancel();
            throw new Error("模型接口响应过大，请检查 API 地址是否为正确接口");
          }
          raw += decoder.decode(chunk, { stream: true });
        }
        raw += decoder.decode();
      } finally {
        reader?.releaseLock();
      }
    let result: any;
    try {
      result = JSON.parse(raw);
    } catch {
      /* HTML and proxy errors still need a readable status. */
    }
    if (!response.ok) {
      const hint =
        response.status === 401 || response.status === 403
          ? "请检查 Key、模型访问权限与余额"
          : response.status === 404
            ? "请检查 API 根地址和模型名称"
            : response.status === 429
              ? "请求受限，请检查余额或稍后重试"
              : "模型服务暂不可用";
      throw new Error(
        `HTTP ${response.status} · ${hint}。${logPreview(String(result?.error?.message || raw || response.statusText), [key], 240)}`,
      );
    }
    if (!Array.isArray(result?.choices) || !result.choices.length)
      throw new Error(
        "接口未返回 Chat Completions 格式，请检查 API 地址（不要填写网页地址）",
      );
    return {
      message: "模型连接成功",
      latencyMs: Date.now() - started,
      model: value.model,
      note: "已验证文本连接；审核仍需模型支持流式工具调用，图片能力按配置启用。",
    };
  } catch (error: any) {
    if (error.name === "TimeoutError")
      throw new Error("模型连接超时，请检查网络、代理和 API 地址后重试");
    if (error.name === "AbortError") throw new Error("连接测试已取消");
    if (error instanceof TypeError)
      throw new Error(
        `无法连接模型服务，请检查网络或 API 地址。${logPreview(String((error.cause as any)?.code || error.message), [key], 180)}`,
      );
    throw new Error(logPreview(error.message || String(error), [key], 600));
  }
}
