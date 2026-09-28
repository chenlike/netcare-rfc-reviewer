import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveBlob } from '../web/src/lib/download.js';

test('desktop exports wait for native completion, preserve Blob lifetime and handle cancellation/errors', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const win = Object.assign(new EventTarget(), { __NETCARE_NATIVE_DOWNLOAD__: true });
  let anchor: any;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => (anchor = { href: '', download: '', click() {}, remove() {} }),
    body: { appendChild() {} },
  } });
  const signal = (status: string) => win.dispatchEvent(new CustomEvent('netcare-download', { detail: { url: anchor.href, status } }));
  try {
    const result = saveBlob(new Blob(['中文配置']), 'invalid:name.json', true);
    const url = anchor.href;
    assert.equal(anchor.download, 'invalid_name.json');
    assert.equal(await (await fetch(url)).text(), '中文配置');
    await assert.rejects(saveBlob(new Blob(), 'second.json', true), /已有导出/);
    signal('started'); signal('saved');
    assert.equal(await result, true);
    await assert.rejects(fetch(url));
    const cancelled = saveBlob(new Blob(), 'cancel.json', true);
    signal('cancelled');
    assert.equal(await cancelled, false);
    const failed = saveBlob(new Blob(), 'failed.zip', true);
    signal('failed');
    await assert.rejects(failed, /保存失败/);
    win.__NETCARE_NATIVE_DOWNLOAD__ = false;
    await assert.rejects(saveBlob(new Blob(), 'old.json', true), /安装新版/);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
