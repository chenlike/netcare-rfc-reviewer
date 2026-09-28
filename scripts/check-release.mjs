import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url)));
const cargo = readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");
if (config.version !== pkg.version || !cargo.includes(`version = "${pkg.version}"`)) throw new Error("应用版本号不一致");
const ref = process.env.GITHUB_REF || "";
if (ref.startsWith("refs/tags/") && ref !== `refs/tags/v${pkg.version}`) throw new Error("发布标签必须与 package.json 的版本一致");
console.log(`Version verified: ${pkg.version}; ${process.platform}/${process.arch}`);
