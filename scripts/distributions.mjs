// Additional native distributions; the existing portable ZIP remains unchanged.
import { cp, mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('无效版本号');
const windows = process.platform === 'win32' && process.arch === 'x64';
const mac = process.platform === 'darwin' && process.arch === 'arm64';
if (!windows && !mac) throw new Error('请使用 Windows x64 或 macOS ARM64 构建');
const release = path.join(root, 'release');
await mkdir(release, { recursive: true });
const name = `Netcare-RFC-Reviewer-${version}-${windows ? 'windows-x64' : 'macos-arm64'}`;
const output = path.join(release, name + (windows ? '-setup.exe' : '.dmg'));

if (windows) {
  const directory = path.join(root, 'src-tauri/target/release/bundle/nsis');
  const installers = (await readdir(directory)).filter(file => file.includes(`_${version}_`) && file.endsWith('-setup.exe'));
  if (installers.length !== 1) throw new Error('未找到唯一的对应版本 NSIS 安装包，请先用 --bundles nsis 构建');
  await cp(path.join(directory, installers[0]), output);
  const file = await readFile(output);
  if (file.subarray(0, 2).toString() !== 'MZ' || file.length < 1_000_000) throw new Error('EXE 安装包无效');
} else {
  // Package the already signed and smoke-tested .app from the portable build.
  const appName = 'Netcare RFC方案审核工具.app';
  const sourceApp = path.join(release, name, appName);
  await stat(path.join(sourceApp, 'Contents/MacOS/rfc-review-studio'));
  const staging = path.join(release, `${name}-dmg-content`);
  const mount = path.join(release, `${name}-dmg-check`);
  for (const directory of [staging, mount]) {
    if (path.dirname(directory) !== release) throw new Error('临时打包目录无效');
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory);
  }
  try {
    execFileSync('/usr/bin/ditto', [sourceApp, path.join(staging, appName)]);
    await writeFile(path.join(staging, '使用说明.txt'), `Netcare RFC方案审核工具 ${version}\n\n请先将 .app 复制到用户可写的独立文件夹，再双击启动。无需安装 Node.js。\n配置和审核资料保存为 .app 旁边的 data/，日志位于 logs/；不要直接从只读 DMG 内运行。\nApple Silicon，macOS 13+。当前使用 ad-hoc 签名，未 Apple 公证；首次打开可能需要在系统设置 → 隐私与安全性中允许打开。\n`);
    execFileSync('/usr/bin/hdiutil', ['create', '-volname', 'Netcare RFC Reviewer', '-srcfolder', staging, '-ov', '-format', 'UDZO', output], { stdio: 'inherit' });
    execFileSync('/usr/bin/hdiutil', ['verify', output], { stdio: 'inherit' });
    execFileSync('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, output], { stdio: 'inherit' });
    try {
      const app = path.join(mount, appName);
      await stat(path.join(app, 'Contents/Resources/runtime/node'));
      const actualVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
      if (actualVersion !== version) throw new Error('DMG 内应用版本不一致');
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    } finally {
      execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'inherit' });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
    // Never recursively delete a potentially mounted image if detach failed.
    await rm(mount, { recursive: false, force: true }).catch(() => {});
  }
}
const hash = createHash('sha256').update(await readFile(output)).digest('hex');
await writeFile(output + '.sha256', `${hash}  ${path.basename(output)}\n`);
console.log(`Native distribution verified: ${output}`);
