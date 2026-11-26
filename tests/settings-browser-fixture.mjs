import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../lib/provider.mjs';
import { startPage } from '../lib/page-service.mjs';

const parent = fileURLToPath(new URL('../.sandbox/', import.meta.url));
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(path.join(parent, 'settings-browser-'));
const runtime = await createRuntime(directory);
const page = await startPage(runtime, 0);
const pageURL = `http://127.0.0.1:${page.address().port}/`;
const wrapper = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>dao settings sandbox</title><iframe title="dao" sandbox="allow-scripts" src="${pageURL}" style="width:100%;height:95vh;border:0"></iframe>`);
});
wrapper.listen(0, '127.0.0.1'); await once(wrapper, 'listening');
await writeFile(path.join(parent, 'settings-browser-session.json'), JSON.stringify({ url: `http://127.0.0.1:${wrapper.address().port}/`, pageURL, settings: runtime.settings.file }));
console.log('READY: settings page in the Magpie allow-scripts sandbox');
await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
wrapper.closeAllConnections(); page.closeAllConnections();
await Promise.all([new Promise(resolve => wrapper.close(resolve)), new Promise(resolve => page.close(resolve))]);
assert.equal(path.dirname(await realpath(directory)), await realpath(parent));
await rm(directory, { recursive: true, force: true });
