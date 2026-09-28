// 用安装包中的 Node 和依赖验证启动、隔离、资源、真实解析器、关闭和再次启动；不调用模型。
import { spawn } from "node:child_process";
import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve(import.meta.dirname, ".."),
  runtime = path.join(root, "src-tauri/runtime");
const directory = await mkdtemp(path.join(os.tmpdir(), "rfc-packaged-smoke-"));
const secret = "packaged-test-secret-not-real-".repeat(3);
let current;
async function boot() {
  const child = spawn(
    path.join(runtime, "node.exe"),
    [path.join(runtime, "dist/server/index.js")],
    {
      cwd: os.tmpdir(),
      env: {
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        PATH: "",
        DATA_DIRECTORY: directory,
        STUDIO_DESKTOP: "1",
        STUDIO_DESKTOP_SECRET: secret,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  current = child;
  const exit = once(child, "exit");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const ready = await new Promise((resolve, reject) => {
    let raw = "";
    child.stdout.on("data", (chunk) => {
      raw += chunk;
      const line = raw.split("\n").find((x) => x.includes("desktop_ready"));
      if (line) resolve(JSON.parse(line));
    });
    child.once("exit", () => reject(new Error(errors)));
  });
  const url = `http://127.0.0.1:${ready.port}`;
  assert.equal((await fetch(url + "/api/bootstrap")).status, 403);
  const opened = await fetch(url + "/desktop/open?session=" + secret, {
    redirect: "manual",
  });
  assert.equal(opened.status, 303);
  const Cookie = opened.headers.get("set-cookie").split(";")[0];
  const request = (p, options = {}) =>
    fetch(url + p, { ...options, headers: { Cookie, ...options.headers } });
  const boot = await (await request("/api/bootstrap")).json();
  assert.equal(boot.desktop, true);
  assert.equal(boot.directory, directory);
  return { child, exit, request, token: boot.token };
}
try {
  const first = await boot();
  const page = await first.request("/");
  assert.equal(page.status, 200);
  const html = await page.text();
  const js = html.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await first.request(js)).status, 200);
  const headers = {
    "Content-Type": "application/json",
    "X-Studio-Token": first.token,
  };
  let groups = await (await first.request("/api/groups")).json();
  assert.equal(groups.length, 0);
  const group = await (
    await first.request("/api/groups", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Persisted test group",
        rules: [
          {
            Id: "scope",
            Title: "Scope",
            Description: "Verify scope",
            Level: "必要",
          },
        ],
      }),
    })
  ).json();
  assert.ok(group.id);
  first.child.stdin.write("shutdown\n");
  assert.equal((await first.exit)[0], 0);
  await assert.rejects(access(path.join(directory, "instance.lock")));
  const second = await boot();
  groups = await (await second.request("/api/groups")).json();
  assert.equal(groups[0].id, group.id);
  second.child.stdin.end();
  assert.equal((await second.exit)[0], 0);
  // 导入内置 sharp/SQLite 和实际 ZIP 解析器，验证原生依赖均随包分发。
  const verify = spawn(
    path.join(runtime, "node.exe"),
    [
      "--input-type=module",
      "-e",
      `import {parsePackage,getImage} from ${JSON.stringify(new URL("../src-tauri/runtime/dist/agents/rfc-review/document.js", import.meta.url).href)};import {readFile} from 'node:fs/promises';const pkg=await parsePackage(await readFile(${JSON.stringify(path.join(root, "examples/sample-rfc.zip"))}));if(pkg.images.length!==1)throw Error('missing image');await getImage(pkg,pkg.images[0].id);console.log('packaged parser and sharp verified');`,
    ],
    {
      cwd: os.tmpdir(),
      env: { SystemRoot: process.env.SystemRoot, PATH: "" },
      stdio: "pipe",
      windowsHide: true,
    },
  );
  let output = "";
  verify.stdout.on("data", (b) => (output += b));
  verify.stderr.on("data", (b) => (output += b));
  assert.equal((await once(verify, "exit"))[0], 0, output);
  console.log(
    "PASS: packaged Node with empty PATH; private session; built UI assets; settings persistence; graceful exit; ZIP/image native dependencies.",
  );
} finally {
  if (current && current.exitCode === null) {
    current.kill();
    await once(current, "exit");
  }
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith("rfc-packaged-smoke-"));
  await rm(target, { recursive: true, force: true });
}
