import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store, DEFAULT_MODEL, validateGroup } from "../src/server/store.js";
import { migrateLegacyData } from "../src/server/data-migration.js";

async function fixture(t: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), "netcare-migration-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("netcare-migration-test-"));
    await rm(root, { recursive: true, force: true });
  });
  return { root, legacy: path.join(root, "legacy"), destination: path.join(root, "install", "data") };
}
test("installation migration preserves encrypted settings, rules, progress and packages without overwriting destination", async (t) => {
  const { legacy, destination } = await fixture(t);
  const source = new Store(legacy);
  source.saveModel({ ...DEFAULT_MODEL, apiKey: "migration-test-secret" });
  source.saveGroup(validateGroup({ name: "Legacy rules", rules: [{ Id: "one", Title: "One", Description: "Verify" }] }));
  source.completeOnboarding();
  await writeFile(path.join(legacy, "packages", "sample.zip"), "test package");
  source.close();
  assert.equal(await migrateLegacyData(destination, legacy), true);
  const migrated = new Store(destination);
  try {
    assert.equal(migrated.model(true).apiKey, "migration-test-secret");
    assert.equal(migrated.groups()[0]!.name, "Legacy rules");
    assert.equal(migrated.onboarding().completed, true);
    assert.equal(await readFile(path.join(destination, "packages", "sample.zip"), "utf8"), "test package");
    migrated.saveModel({ ...DEFAULT_MODEL, apiKey: "new-install-key" });
    assert.equal(await migrateLegacyData(destination, legacy), false);
    assert.equal(migrated.model(true).apiKey, "new-install-key");
    assert.ok(existsSync(path.join(legacy, "studio.sqlite")));
  } finally { migrated.close(); }
});
test("migration refuses an active legacy process and rolls back damaged credentials without publishing partial data", async (t) => {
  const { root, legacy, destination } = await fixture(t);
  new Store(legacy).close();
  await writeFile(path.join(legacy, "instance.lock"), String(process.pid));
  await assert.rejects(migrateLegacyData(destination, legacy), /仍在运行/);
  assert.equal(existsSync(destination), false);
  await rm(path.join(legacy, "instance.lock"));
  await writeFile(path.join(legacy, "master.key"), "bad key");
  await assert.rejects(migrateLegacyData(destination, legacy), /密钥文件/);
  assert.equal(existsSync(path.join(destination, "studio.sqlite")), false);
  assert.deepEqual(await readdir(path.join(root, "install")), []);
  assert.ok(existsSync(path.join(legacy, "studio.sqlite")));
});
