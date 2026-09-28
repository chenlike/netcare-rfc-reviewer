let token = "";
export async function bootstrap() {
  const result = await api<{
    token: string;
    modelReady: boolean;
    directory: string;
    desktop: boolean;
    preferences: { theme: "light" | "dark" | "system" };
    onboarding: { completed: boolean; modelReady: boolean; rulesReady: boolean };
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
  let result: any;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      `服务响应异常（HTTP ${response.status}），请重新打开程序后再试`,
    );
  }
  if (!response.ok)
    throw new Error(result.error || `请求失败：${response.status}`);
  return result;
}
export async function downloadFile(path: string, name: string) {
  const response = await fetch(`/api${path}`, {
    headers: { "X-Studio-Token": token },
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new Error(value.error || `下载失败：HTTP ${response.status}`);
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export function uploadTask(
  file: File,
  group: string,
  uploadId: string,
  progress: (value: number) => void,
) {
  return new Promise<import("./types/rfcAudit").Task>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/tasks?group=${encodeURIComponent(group)}&fileName=${encodeURIComponent(file.name)}`,
    );
    xhr.setRequestHeader("X-Studio-Token", token);
    xhr.setRequestHeader("X-Upload-Id", uploadId);
    xhr.setRequestHeader("Content-Type", "application/zip");
    xhr.timeout = 300000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () =>
      reject(new Error("连接中断，可以重试此文件；同次上传不会重复创建任务"));
    xhr.ontimeout = () =>
      reject(
        new Error("上传或解析超时，可以重试此文件；同次上传不会重复创建任务"),
      );
    xhr.onload = () => {
      try {
        const value = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(value);
        else reject(new Error(value.error || `上传失败：HTTP ${xhr.status}`));
      } catch {
        reject(new Error("服务返回无效响应，请重试此文件"));
      }
    };
    xhr.send(file);
  });
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
