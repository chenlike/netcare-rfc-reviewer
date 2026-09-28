import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
const zip = new JSZip();
async function add(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory())
      await add(path.join(directory, entry.name), relative + "/");
    else zip.file(relative, await readFile(path.join(directory, entry.name)));
  }
}
await add("examples/sample-rfc");
await writeFile(
  "examples/sample-rfc.zip",
  await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
);
console.log(
  "已生成 examples/sample-rfc.zip；可配合 examples/checklist.json 手动导入测试。",
);
