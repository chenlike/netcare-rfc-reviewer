let token = "";
export async function bootstrap() {
  const result = await api<{
    token: string;
    modelReady: boolean;
    directory: string;
  }>("/bootstrap");
  token = result.token;
  return result;
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { "X-Studio-Token": token, ...options.headers },
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || `请求失败：${response.status}`);
  return result;
}
export function save<T = any>(path: string, value: unknown, method = "PUT") {
  return api<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}
export async function downloadPackage(id: string, signal: AbortSignal) {
  const response = await fetch(`/api/tasks/${id}/download`, { signal });
  if (!response.ok)
    throw new Error((await response.json()).error || "方案下载失败");
  return response.blob();
}
export function downloadJson(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const statusText = (status: string) =>
  ({
    queued: "排队中",
    running: "审核中",
    completed: "已完成",
    failed: "需继续",
    cancelled: "已停止",
  })[status] || status;
export const dateText = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
