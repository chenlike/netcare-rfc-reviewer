import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
const root = path.resolve(import.meta.dirname, "..");
const env = { ...process.env };
if (process.platform === "win32") {
  const locator = path.join(
    process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)",
    "Microsoft Visual Studio/Installer/vswhere.exe",
  );
  if (existsSync(locator)) {
    const installation = execFileSync(
      locator,
      [
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        "installationPath",
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    if (installation) {
      const script = path.join(installation, "Common7/Tools/VsDevCmd.bat");
      if (/["\r\n&|]/.test(script))
        throw new Error("编译器路径含有不支持的字符");
      const output = execFileSync(
        "cmd.exe",
        [
          "/d",
          "/s",
          "/c",
          `""${script}" -no_logo -arch=x64 -host_arch=x64 >nul && set"`,
        ],
        { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true },
      );
      for (const line of output.split(/\r?\n/)) {
        const split = line.indexOf("=");
        if (split > 0) {
          const key = line.slice(0, split);
          const previous = Object.keys(env).find(
            (k) => k.toLowerCase() === key.toLowerCase(),
          );
          if (previous) delete env[previous];
          env[key] = line.slice(split + 1);
        }
      }
    }
  }
  const key =
    Object.keys(env).find((k) => k.toLowerCase() === "path") || "Path";
  env[key] = path.join(os.homedir(), ".cargo/bin") + ";" + (env[key] || "");
}
const child = spawn(
  process.execPath,
  [
    path.join(root, "node_modules/@tauri-apps/cli/tauri.js"),
    ...process.argv.slice(2),
  ],
  { cwd: root, env, stdio: "inherit", windowsHide: true },
);
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
