import { cp, mkdir, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const windows = process.platform === "win32" && process.arch === "x64";
const mac = process.platform === "darwin" && process.arch === "arm64";
if (!windows && !mac) throw new Error("仅支持 Windows x64 / macOS ARM64 原生构建");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("无效的发布版本");
const name = `Netcare-RFC-Reviewer-${pkg.version}-${windows ? "windows-x64" : "macos-arm64"}`;
const release = path.join(root, "release");
const folder = path.join(release, name);
if (path.dirname(folder) !== release) throw new Error("便携包输出目录无效");
await mkdir(release, { recursive: true });
await rm(folder, { recursive: true, force: true });
await mkdir(folder);
let runtime;
if (windows) {
  await cp(path.join(root, "src-tauri/target/release/rfc-review-studio.exe"), path.join(folder, "Netcare RFC方案审核工具.exe"));
  runtime = path.join(folder, "runtime");
  await cp(path.join(root, "src-tauri/runtime"), runtime, { recursive: true });
} else {
  const appName = "Netcare RFC方案审核工具.app";
  const app = path.join(folder, appName);
  // ditto 保留 .app 内的符号链接、可执行权限与资源属性。
  execFileSync("/usr/bin/ditto", [path.join(root, "src-tauri/target/release/bundle/macos", appName), app]);
  runtime = path.join(app, "Contents/Resources/runtime");
  // 原生 Node 插件也必须具有有效的 ARM64 本地签名。
  async function sign(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await sign(file);
      else if (entry.isFile() && (entry.name === "node" || /\.(node|dylib)$/.test(entry.name)))
        execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", file], { stdio: "inherit" });
    }
  }
  await sign(runtime);
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
}
for (const file of ["package.json", "dist/server/index.js", "presets/rfc-standard.json", windows ? "node.exe" : "node"])
  await stat(path.join(runtime, file));
await cp(path.join(root, "THIRD-PARTY-NOTICES.md"), path.join(folder, "THIRD-PARTY-NOTICES.md"));
await writeFile(path.join(folder, "使用说明.txt"), `Netcare RFC方案审核工具 ${pkg.version}\n\n请完整解压并将整个文件夹放到可写位置，然后双击${windows ? "Netcare RFC方案审核工具.exe" : "Netcare RFC方案审核工具.app"}。无需安装 Node.js。\n${windows ? "系统要求：Windows 10/11 x64，Microsoft Edge WebView2 Runtime（多数系统已自带）。缺少时从 https://developer.microsoft.com/microsoft-edge/webview2 下载。" : "系统要求：macOS 13+，Apple Silicon（M 系列）。本包为 ad-hoc 签名，未做 Apple 公证，首次打开可能被系统阻止。请在系统设置 → 隐私与安全性中按提示允许打开。不要在压缩包或只读位置直接运行。"}\n\n配置和任务保存在本文件夹的 data/，日志在 logs/。升级前关闭软件，仅替换程序与 runtime/，保留 data/、logs/、webview/。macOS 替换 .app 即可，data/ 位于 .app 旁边。\n第一次进入请配置自己的模型地址和 API Key。本包不含用户配置或凭据。\n`);
// 在最终归档的运行时上验证，无系统 Node/PATH 依赖，不调用模型。
execFileSync(process.execPath, [path.join(root, "scripts/desktop-smoke.mjs"), runtime], { cwd: root, stdio: "inherit", windowsHide: true });
const archive = folder + ".zip";
await rm(archive, { force: true });
if (windows) {
  execFileSync("python", [path.join(root, "scripts/zip-portable.py"), folder, archive], { stdio: "inherit", windowsHide: true });
} else {
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", folder, archive], { stdio: "inherit" });
}
const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
await writeFile(archive + ".sha256", `${digest}  ${path.basename(archive)}\n`);
console.log(`便携包已生成：${archive}`);
