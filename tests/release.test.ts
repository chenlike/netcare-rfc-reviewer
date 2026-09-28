import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

test('release tag sets app, lockfiles, UI and diagnostics versions without changing dependencies', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'netcare-release-'));
  try {
    for (const folder of ['src-tauri', 'web/src', 'src/server']) await mkdir(path.join(root, folder), { recursive: true });
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'rfc-review-studio', version: '1.2.0' }),
      'package-lock.json': JSON.stringify({ version: '1.2.0', packages: { '': { version: '1.2.0' }, dependency: { version: '1.2.0' } } }),
      'src-tauri/tauri.conf.json': JSON.stringify({ version: '1.2.0' }),
      'src-tauri/Cargo.toml': '[package]\nname = "rfc-review-studio"\nversion = "1.2.0"\n[dependencies]\nuuid = "1"\n',
      'src-tauri/Cargo.lock': 'version = 4\n[[package]]\nname = "dependency"\nversion = "1.2.0"\n[[package]]\nname = "rfc-review-studio"\nversion = "1.2.0"\n',
      'web/src/App.vue': '<span>v1.2.0</span>',
      'src/server/workspace.ts': 'const info = {version: "1.2.0"};',
    };
    for (const [name, data] of Object.entries(files)) await writeFile(path.join(root, name), data);
    const run = (ref: string, tag = '') => spawnSync(process.execPath, ['scripts/check-release.mjs', root], { encoding: 'utf8', env: { ...process.env, GITHUB_REF: ref, RELEASE_TAG: tag } });
    let result = run('refs/heads/main', 'v0.0.1');
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json'])
      assert.equal(JSON.parse(await readFile(path.join(root, name), 'utf8')).version, '0.0.1');
    const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages[''].version, '0.0.1'); assert.equal(lock.packages.dependency.version, '1.2.0');
    assert.match(await readFile(path.join(root, 'src-tauri/Cargo.lock'), 'utf8'), /name = "dependency"\nversion = "1.2.0"/);
    assert.match(await readFile(path.join(root, 'web/src/App.vue'), 'utf8'), /v0.0.1/);
    assert.match(await readFile(path.join(root, 'src/server/workspace.ts'), 'utf8'), /0.0.1/);
    result = run('refs/tags/v0.0.2');
    assert.equal(result.status, 0, result.stderr);
    assert.match(await readFile(path.join(root, 'src-tauri/Cargo.toml'), 'utf8'), /version = "0.0.2"/);
    for (const tag of ['v01.2.3', 'vtest', '../bad']) assert.notEqual(run('refs/heads/main', tag).status, 0);
    assert.equal(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, '0.0.2');
    assert.equal(run('refs/heads/main').status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
