import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptSession, decryptSession, validateNetcareNumber, validateCredentials } from '../src/server/netcare-session.js';
import { csrfHeader, NetcareClient, NetcareLoginRequired, downloadHtml, limitedBody, ExportLoginRequired, NetcareService, IDP_ORIGIN } from '../src/server/netcare.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { zipHtml } from './helpers.js';
import { createApp } from '../src/server/app.js';
import { Store, DEFAULT_MODEL, validateGroup } from '../src/server/store.js';
import { Engine } from '../src/server/engine.js';

test('Netcare validates and normalizes a user supplied RFC number', () => {
  assert.equal(validateNetcareNumber(' ne20260828000800 '), 'NE20260828000800');
  for (const input of ['', 'NE1', '../test', 'https://example.com', null]) assert.throws(() => validateNetcareNumber(input));
});
test('Netcare session is authenticated encrypted data tied to the workspace key', () => {
  const key = randomBytes(32), value = { cookie: 'session=secret-cookie', csrfToken: 'secret-token' };
  const encrypted = encryptSession(value, key);
  assert.equal(encrypted.includes(Buffer.from('secret-cookie')), false);
  assert.deepEqual(decryptSession(encrypted, key), value);
  assert.throws(() => decryptSession(encrypted, randomBytes(32)));
  encrypted[30] ^= 1;
  assert.throws(() => decryptSession(encrypted, key));
  assert.throws(() => validateCredentials({ cookie: 'a=b\r\nInjected: yes', csrfToken: 'token' }));
});
test('Netcare supports the official csrfTokens array and legacy tokens', () => {
  assert.equal(csrfHeader(JSON.stringify([{ csrfToken:'token', headerKey:'x-gde-csrf-token' }])), 'token');
  assert.equal(csrfHeader('legacy-token'), 'legacy-token');
  assert.throws(() => csrfHeader('[]'), NetcareLoginRequired);
});
test('Netcare requests stay on the official origin and do not forward cookies through redirects', async () => {
  let calls = 0;
  const client = new NetcareClient({cookie:'a=b',csrfToken:'csrf'}, (async (url, options) => {
    calls++;
    assert.ok(String(url).startsWith('https://netcare.huawei.com/adc-service/'));
    assert.equal(options?.redirect, 'manual');
    assert.equal(new Headers(options?.headers).get('x-gde-csrf-token'), 'csrf');
    return new Response('', { status:302, headers:{Location:'https://example.com'} });
  }) as typeof fetch);
  await assert.rejects(client.query('NE20260828000800'), NetcareLoginRequired);
  assert.equal(calls, 1);
  await assert.rejects(client.request('https://example.com', {}));
  assert.equal(calls, 1);
});

const idp = { cookie:'idp-session=secret', csrfToken:'old-csrf', username:'test-user' };
test('HTML export uses the IDP identity and scoped cookies, and rejects login pages before ZIP parsing', async () => {
  const zip = zipHtml(); let calls = 0;
  const transport = (async (input, options) => {
    const url = new URL(String(input)); calls++;
    assert.equal(url.origin, IDP_ORIGIN);
    assert.equal(options?.redirect, 'manual');
    assert.equal(new Headers(options?.headers).get('cookie'), idp.cookie);
    if (url.pathname.endsWith('getloginuser')) return Response.json({uid:'test-user',employeeNumber:'fresh-csrf'});
    assert.equal(url.searchParams.get('id'), 'NE20260828000800');
    assert.equal(url.searchParams.get('from'), 'ows');
    assert.equal(new Headers(options?.headers).get('X-CSRF-TOKEN'), 'fresh-csrf');
    return new Response(zip);
  }) as typeof fetch;
  assert.deepEqual(await downloadHtml('NE20260828000800', idp, AbortSignal.timeout(5000), transport), zip);
  assert.equal(calls, 2);
  await assert.rejects(downloadHtml('NE20260828000800', idp, AbortSignal.timeout(5000),
    (async () => new Response('', {status:302,headers:{Location:'https://example.com'}})) as typeof fetch), ExportLoginRequired);
  await assert.rejects(downloadHtml('NE20260828000800', idp, AbortSignal.timeout(5000),
    (async (url) => String(url).endsWith('getloginuser') ? Response.json({uid:'test-user',employeeNumber:'csrf'}) : new Response('<html>Login</html>')) as typeof fetch), /未返回 HTML 方案包/);
});

test('bounded downloads cancel an oversized stream without buffering the full response', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(16)); }, cancel() { cancelled = true; } }));
  await assert.rejects(limitedBody(response, 20), /超过大小限制/);
  assert.equal(cancelled, true);
});

async function temporaryDirectory(t: any) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rfc-netcare-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('rfc-netcare-test-'));
    await rm(directory, {recursive:true,force:true});
  });
  return directory;
}

test('Netcare import checks an exact order, completes native export handoff and reuses encrypted IDP session', async t => {
  const directory = await temporaryDirectory(t);
  await writeFile(path.join(directory, 'master.key'), randomBytes(32));
  const events: any[] = [];
  const service = new NetcareService(directory, true, event => {
    events.push(event);
    const e = event as any;
    if (e.event === 'netcare_export_login') queueMicrotask(() => void service.receive({event:'netcare_export_credentials',requestId:e.requestId,...idp}));
  });
  await service.session.save({cookie:'netcare-session=secret',csrfToken:'csrf'});
  const zip = zipHtml(); let exists = true;
  t.mock.method(globalThis, 'fetch', async (input: any, options: any) => {
    const url = new URL(String(input));
    if (url.origin === IDP_ORIGIN) {
      assert.equal(new Headers(options.headers).get('cookie'), idp.cookie);
      return url.pathname.endsWith('getloginuser') ? Response.json({uid:idp.username,employeeNumber:'csrf'}) : new Response(zip);
    }
    assert.equal(new Headers(options.headers).get('cookie'), 'netcare-session=secret');
    if (url.pathname.endsWith('ne_query_rfc_getList_for_report')) {
      const data = JSON.parse(options.body);
      assert.equal(data.query_time_year, '');
      return Response.json({results:[{orderid:exists ? data.orderid : 'NE20260828000801',customer_org:'test'}]});
    }
    return Response.json({result:{configure_value:IDP_ORIGIN+'/ows1/static/editor/IdpLiteView/PublishLiteView.html'}});
  });
  assert.deepEqual((await service.download('NE20260828000800')).raw, zip);
  assert.equal(events.filter(e=>e.event === 'netcare_export_login').length, 1);
  assert.equal(events.filter(e=>e.event === 'netcare_export_complete').length, 1);
  assert.deepEqual((await service.session.load())?.idp, idp);
  assert.deepEqual((await service.download('NE20260828000800')).raw, zip);
  assert.equal(events.filter(e=>e.event === 'netcare_export_login').length, 1);
  exists = false;
  await assert.rejects(service.download('NE20260828000800'), /未找到/);
  assert.equal((await service.status()).state, 'error');
  assert.equal(JSON.stringify(await service.status()).includes('secret'), false);
  service.close();
});

test('JSON Netcare imports download bytes before parsing and preserve upload idempotency', async t => {
  const store = new Store(await temporaryDirectory(t));
  store.saveModel({...DEFAULT_MODEL,apiKey:'local-test'});
  store.saveGroup(validateGroup({name:'test',rules:[{Title:'可用性',Description:'确认可用',Level:'必要'}]}));
  const engine = new Engine(store);
  let pumped = 0;
  t.mock.method(engine, 'pump', () => { pumped++; });
  const {server,netcare} = createApp(store, engine);
  let downloaded = 0;
  t.mock.method(netcare, 'download', async number => {
    assert.equal(number, 'NE20260828000800'); downloaded++;
    return {raw:zipHtml(),fileName:'Netcare 方案.zip'};
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const {token} = await (await fetch(base+'/api/bootstrap')).json() as any;
    const group = store.groups()[0]!;
    const id = 'a1234567-1234-1234-1234-123456789abc';
    const send = () => fetch(base+`/api/tasks?group=${group.id}`, {method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':token,'X-Upload-Id':id},body:JSON.stringify({netcareNumber:'NE20260828000800'})});
    const first = await send(); assert.equal(first.status,201);
    const task = await first.json() as any;
    assert.equal(task.Title,'Netcare 方案');
    assert.equal(task.Status,'queued');
    assert.equal(store.task(id)?.EntryPath,'index.html');
    assert.equal((await send()).status,201);
    assert.equal(downloaded,1); assert.equal(pumped,1);
  } finally { server.close(); await once(server,'close'); store.close(); }
});

test('failed or cancelled native login never saves an unverified session or closes a newer login', async t => {
  const directory = await temporaryDirectory(t);
  await writeFile(path.join(directory,'master.key'),randomBytes(32));
  const events: any[] = [];
  const service = new NetcareService(directory,true,e=>events.push(e));
  t.mock.method(globalThis,'fetch', async () => new Response('',{status:401}));
  await service.login();
  const first = events.at(-1).requestId;
  await service.receive({event:'netcare_credentials',requestId:first,cookie:'a=b',csrfToken:'csrf'});
  assert.equal((await service.status()).state,'login');
  assert.equal(await service.session.load(),undefined);
  assert.equal(events.some(e=>e.event==='netcare_login_complete'),false);
  service.cancelLogin();
  await service.login();
  await service.receive({event:'netcare_login_closed',requestId:first});
  assert.equal((await service.status()).state,'login');
  service.cancelLogin(); service.close();
});

test('cancelling an export handoff closes its native window and permits retry', async t => {
  const directory = await temporaryDirectory(t);
  await writeFile(path.join(directory,'master.key'),randomBytes(32));
  const events: any[] = [];
  let opened!: () => void;
  const ready = new Promise<void>(resolve=>{opened=resolve;});
  const service = new NetcareService(directory,true,e=>{events.push(e);if((e as any).event==='netcare_export_login')opened();});
  await service.session.save({cookie:'a=b',csrfToken:'csrf'});
  t.mock.method(globalThis,'fetch',async (url: any)=>String(url).endsWith('ne_query_rfc_getList_for_report')
    ? Response.json({results:[{orderid:'NE20260828000800',customer_org:'test'}]})
    : Response.json({result:{configure_value:IDP_ORIGIN+'/ows1/'}}));
  const operation = service.download('NE20260828000800');
  const rejection = assert.rejects(operation,/超时|取消/);
  await ready; service.cancelLogin(); await rejection;
  assert.ok(events.some(e=>e.event==='netcare_export_complete'));
  assert.equal((await service.status()).state,'error');
  assert.equal((await service.session.load())?.idp,undefined);
  service.close();
});
