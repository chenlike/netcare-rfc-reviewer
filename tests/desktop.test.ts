import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { desktopSession } from "../src/server/desktop-session.js";

test("desktop session gates every resource, grants one HttpOnly session and rejects replay", async () => {
  const secret = "test-only-desktop-session-".repeat(3),
    guard = desktopSession(secret);
  const server = http.createServer((req, res) => {
    if (guard(req, res, new URL(req.url!, "http://127.0.0.1")))
      res.end("allowed");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    assert.equal((await fetch(url + "/api/bootstrap")).status, 403);
    assert.equal((await fetch(url + "/assets/app.js")).status, 403);
    assert.equal(
      (await fetch(url + "/desktop/open?session=wrong")).status,
      403,
    );
    const open = await fetch(url + "/desktop/open?session=" + secret, {
      redirect: "manual",
    });
    assert.equal(open.status, 303);
    assert.equal(open.headers.get("location"), "/");
    const cookie = open.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal(
      (
        await fetch(url + "/desktop/open?session=" + secret, {
          redirect: "manual",
        })
      ).status,
      403,
    );
    assert.equal(
      await (
        await fetch(url + "/api/bootstrap", {
          headers: { Cookie: cookie.split(";")[0]! },
        })
      ).text(),
      "allowed",
    );
    assert.equal(
      (await fetch(url, { headers: { Cookie: "rfc_desktop=invalid" } })).status,
      403,
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

for (const shutdown of ["request", "parent-disconnected"] as const)
  test(
    `desktop engine uses a dynamic port and exits on ${shutdown}`,
    { timeout: 15000 },
    async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "rfc-desktop-test-"),
      );
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/server/index.ts"],
        {
          cwd: path.resolve("."),
          env: {
            ...process.env,
            STUDIO_DESKTOP: "1",
            STUDIO_DESKTOP_SECRET: "test-only-secret".repeat(4),
            DATA_DIRECTORY: directory,
            PORT: "invalid-on-purpose",
          },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let stderr = "";
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      const exited = once(child, "exit");
      try {
        const ready: any = await new Promise((resolve, reject) => {
          let text = "";
          child.stdout.on("data", (data) => {
            text += data;
            const line = text
              .split("\n")
              .find((line) => line.includes("desktop_ready"));
            if (line) resolve(JSON.parse(line));
          });
          child.once("exit", () => reject(new Error(stderr)));
        });
        assert.ok(ready.port > 0);
        assert.notEqual(ready.port, 4328);
        assert.equal(
          (await fetch(`http://127.0.0.1:${ready.port}/api/bootstrap`)).status,
          403,
        );
        if (shutdown === "request") child.stdin.write("shutdown\n");
        else child.stdin.end();
        assert.equal((await exited)[0], 0, stderr);
        await assert.rejects(access(path.join(directory, "instance.lock")));
        await access(path.join(directory, "studio.sqlite"));
      } finally {
        if (child.exitCode === null) {
          child.kill();
          await exited;
        }
        assert.equal(
          path.dirname(path.resolve(directory)),
          path.resolve(os.tmpdir()),
        );
        assert.ok(path.basename(directory).startsWith("rfc-desktop-test-"));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
