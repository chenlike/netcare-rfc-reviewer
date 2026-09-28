import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

/** 桌面内嵌服务仅接受本次应用实例的会话，网页不能直接读取本地资料。 */
export function desktopSession(secret?: string) {
  if (secret !== undefined && secret.length < 32)
    throw new Error("桌面会话密钥无效");
  let opened = false;
  const equal = (value: string) => {
    const bytes = Buffer.from(value);
    return (
      bytes.length === Buffer.byteLength(secret!) &&
      timingSafeEqual(bytes, Buffer.from(secret!))
    );
  };
  return (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (!secret) return true;
    res.setHeader("Cache-Control", "no-store");
    if (
      url.pathname === "/desktop/open" &&
      req.method === "GET" &&
      !opened &&
      equal(url.searchParams.get("session") || "")
    ) {
      opened = true;
      res.setHeader(
        "Set-Cookie",
        `rfc_desktop=${secret}; HttpOnly; SameSite=Strict; Path=/`,
      );
      res.writeHead(303, { Location: "/" });
      res.end();
      return false;
    }
    const cookie =
      (req.headers.cookie || "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("rfc_desktop="))
        ?.slice(12) || "";
    if (equal(cookie)) return true;
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "请从 Netcare RFC方案审核工具 桌面窗口访问" }));
    return false;
  };
}
