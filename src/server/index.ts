import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { Store } from "./store.js";
import { createApp } from "./app.js";
import { createInterface } from "node:readline";

const desktop = process.env.STUDIO_DESKTOP === "1";
const desktopSecret = desktop ? process.env.STUDIO_DESKTOP_SECRET : undefined;
if (desktop && (!desktopSecret || !process.env.DATA_DIRECTORY))
  throw new Error("桌面运行参数缺失");
const directory = path.resolve(process.env.DATA_DIRECTORY || ".data");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const lock = path.join(directory, "instance.lock");
try {
  const pid = Number(readFileSync(lock, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("无效进程锁，请检查数据目录");
  try {
    process.kill(pid, 0);
    throw new Error(`数据目录已由进程 ${pid} 使用`);
  } catch (error: any) {
    if (error.code !== "ESRCH") throw error;
    unlinkSync(lock);
  }
} catch (error: any) {
  if (error.code !== "ENOENT") throw error;
}
writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
const store = new Store(directory),
  { server, engine } = createApp(store, undefined, { desktopSecret });
const port = desktop ? 0 : Number(process.env.PORT || 4328);
if (!Number.isSafeInteger(port) || port < (desktop ? 0 : 1) || port > 65535)
  throw new Error("PORT 无效");
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  await engine.stop();
  server.close();
  server.closeAllConnections();
  store.close();
  try {
    unlinkSync(lock);
  } catch {}
  if (desktop) process.exit(0);
}
server.on("error", (error) => {
  console.error(error.message);
  void stop().then(() => {
    process.exitCode = 1;
  });
});
server.listen(port, "127.0.0.1", () => {
  if (desktop)
    console.log(
      JSON.stringify({
        event: "desktop_ready",
        port: (server.address() as import("node:net").AddressInfo).port,
      }),
    );
  else
    console.log(
      `RFC 审核工作台：http://127.0.0.1:${port}\n数据目录：${directory}`,
    );
  engine.recover();
});
if (desktop) {
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (line === "shutdown") void stop();
  });
  input.on("close", () => void stop());
}
process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
