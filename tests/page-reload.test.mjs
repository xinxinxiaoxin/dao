import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRuntime } from '../lib/provider.mjs';
import { startPage } from '../lib/page-service.mjs';

test('an open settings page can save after its plugin service restarts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dao-page-'));
  let server;
  const close = async () => { if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
  t.after(async () => { await close(); assert.equal(dirname(await realpath(directory)), await realpath(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  const runtime = await createRuntime(directory);
  server = await startPage(runtime, 0);
  const port = server.address().port, url = `http://127.0.0.1:${port}`;
  const html = await (await fetch(url)).text();
  const token = html.match(/const token='([^']+)'/)[1];
  await close(); server = await startPage(await createRuntime(directory), port);
  const result = await fetch(`${url}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-qiandao-page': token }, body: JSON.stringify({ baseURL: 'https://example.invalid', models: [], maxConcurrency: 3 }) });
  assert.equal(result.status, 200, await result.text());
  assert.equal((await runtime.settings.read()).baseURL, 'https://example.invalid/v1');
  assert.equal((await runtime.settings.read()).maxConcurrency, 3);
  const refused = await fetch(`${url}/api/settings`, { method: 'PUT', headers: { 'x-qiandao-page': 'stale-token' }, body: '{}' });
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /尚未保存/);
});
