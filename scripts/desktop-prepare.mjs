import { cp, mkdir, readFile, writeFile, rm, copyFile, chmod, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import sharp from "sharp";
const root = path.resolve(import.meta.dirname, "..");
const destination = path.join(root, "src-tauri/runtime");
const windows = process.platform === "win32" && process.arch === "x64";
const mac = process.platform === "darwin" && process.arch === "arm64";
if (!windows && !mac)
  throw new Error("请使用 Windows x64 或 macOS ARM64 原生环境构建");
if (Number(process.versions.node.split(".")[0]) < 22)
  throw new Error("构建需要 Node.js 22.19+");
// 只清理固定的生成目录，永不接触用户的数据目录。
if (path.dirname(destination) !== path.join(root, "src-tauri"))
  throw new Error("输出目录无效");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(path.join(root, "dist"), path.join(destination, "dist"), {
  recursive: true,
});
await cp(path.join(root, "presets"), path.join(destination, "presets"), { recursive: true });
const bundledNode = path.join(destination, windows ? "node.exe" : "node");
await copyFile(process.execPath, bundledNode);
if (mac) await chmod(bundledNode, 0o755);
const licenseCandidates = [
  path.join(path.dirname(process.execPath), "LICENSE"),
  path.resolve(path.dirname(process.execPath), "../LICENSE"),
  path.resolve(path.dirname(process.execPath), "../share/doc/node/LICENSE"),
];
let nodeLicense;
for (const candidate of licenseCandidates) {
  try { await access(candidate); nodeLicense = await readFile(candidate); break; } catch {}
}
if (!nodeLicense) {
  const response = await fetch(`https://nodejs.org/dist/${process.version}/LICENSE`);
  if (!response.ok) throw new Error(`无法取得 Node ${process.version} 的 LICENSE：${response.status}`);
  nodeLicense = Buffer.from(await response.arrayBuffer());
}
await writeFile(path.join(destination, "NODE-LICENSE.txt"), nodeLicense);
await copyFile(
  path.join(root, "package.json"),
  path.join(destination, "package.json"),
);
await copyFile(
  path.join(root, "package-lock.json"),
  path.join(destination, "package-lock.json"),
);
await copyFile(path.join(root,'THIRD-PARTY-NOTICES.md'),path.join(destination,'THIRD-PARTY-NOTICES.md'));
const npmCandidates = [process.env.npm_execpath,
  path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
].filter(Boolean);
let npm;
for (const candidate of npmCandidates) {
  try { await access(candidate); npm = candidate; break; } catch {}
}
if (!npm) throw new Error("找不到当前 Node 附带的 npm-cli.js");
execFileSync(
  process.execPath,
  [npm, "ci", "--omit=dev", "--no-audit", "--no-fund"],
  { cwd: destination, stdio: "inherit", windowsHide: true },
);
const notice = execFileSync(
  process.execPath,
  ["-p", 'process.release.name + " " + process.version'],
  { encoding: "utf8" },
);
await writeFile(
  path.join(destination, "RUNTIME.txt"),
  `Bundled runtime: ${notice}Node.js: https://nodejs.org/\nDependencies retain their LICENSE files in node_modules.\n`,
);
// 工程内生成矢量风格图标，不依赖远程图片或设计工具。
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" rx="58" fill="#242424"/><path d="M64 202V54h37l54 87V54h37v148h-36l-55-89v89z" fill="white"/></svg>`;
const png = await sharp(Buffer.from(svg)).png().toBuffer();
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = 0;
header[7] = 0;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);
await mkdir(path.join(root, "src-tauri/icons"), { recursive: true });
await writeFile(
  path.join(root, "src-tauri/icons/icon.ico"),
  Buffer.concat([header, png]),
);
await writeFile(path.join(root, "src-tauri/icons/icon.png"), png);
const icns = Buffer.alloc(16);
icns.write("icns", 0);
icns.writeUInt32BE(16 + png.length, 4);
icns.write("ic08", 8);
icns.writeUInt32BE(8 + png.length, 12);
await writeFile(path.join(root, "src-tauri/icons/icon.icns"), Buffer.concat([icns, png]));
console.log(
  "桌面运行环境已生成：自带 Node.js、审核服务及前端，不包含用户数据或 Key。",
);
