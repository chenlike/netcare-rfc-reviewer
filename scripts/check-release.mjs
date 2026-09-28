import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(import.meta.dirname, "..");
const read = (name) => readFileSync(path.join(root, name), "utf8");
const pkg = JSON.parse(read("package.json"));
const config = JSON.parse(read("src-tauri/tauri.conf.json"));
const cargo = read("src-tauri/Cargo.toml");
const tag = process.env.RELEASE_TAG || (process.env.GITHUB_REF?.startsWith("refs/tags/") ? process.env.GITHUB_REF.slice(10) : "");
if (tag) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag))
    throw new Error("发布标签应为 v主版本.次版本.修订号，例如 v0.0.1");
  const version = tag.slice(1), previous = pkg.version;
  const lock = JSON.parse(read("package-lock.json"));
  const cargoLock = read("src-tauri/Cargo.lock");
  const packageVersion = /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/;
  const lockedVersion = /(\[\[package\]\]\r?\nname = "rfc-review-studio"\r?\nversion = ")[^"]+(")/;
  if (!packageVersion.test(cargo) || !lockedVersion.test(cargoLock) || !lock.packages?.[""])
    throw new Error("无法定位应用版本字段，停止发布");
  pkg.version = config.version = lock.version = lock.packages[""].version = version;
  const changes = new Map([
    ["package.json", JSON.stringify(pkg, null, 2) + "\n"],
    ["package-lock.json", JSON.stringify(lock, null, 2) + "\n"],
    ["src-tauri/tauri.conf.json", JSON.stringify(config, null, 2) + "\n"],
    ["src-tauri/Cargo.toml", cargo.replace(packageVersion, (_, a, b) => a + version + b)],
    ["src-tauri/Cargo.lock", cargoLock.replace(lockedVersion, (_, a, b) => a + version + b)],
  ]);
  // 同步历史版本的界面和诊断版本字面量；不改 Git 标签或回写源码提交。
  for (const name of ["web/src/App.vue", "src/server/workspace.ts"]) {
    if (existsSync(path.join(root, name))) changes.set(name, read(name)
      .replaceAll(`<span>v${previous}</span>`, `<span>v${version}</span>`)
      .replaceAll(`version: "${previous}"`, `version: "${version}"`));
  }
  for (const [name, content] of changes) writeFileSync(path.join(root, name), content);
  console.log(`Release version synchronized: ${previous} → ${version} (${tag})`);
} else {
  if (config.version !== pkg.version || !cargo.includes(`version = "${pkg.version}"`))
    throw new Error("应用版本号不一致");
  console.log(`Development build: ${pkg.version}; ${process.platform}/${process.arch}`);
}
