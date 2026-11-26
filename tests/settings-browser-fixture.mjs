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
const now = Date.now();
const examples = [
  { status: 503, retry: true, retryDelayMs: 1500 },
  { status: 429, retry: true, retryDelayMs: 6000, reason: '限流' },
  { status: 200, retry: false },
  { status: 530, retry: false },
  { status: 200, retry: true, retryDelayMs: 30000, reason: '限流', errorCode: '429' },
  { status: 401, retry: false },
  { status: 200, retry: false },
  { status: 429, retry: true, reason: '限流' },
];
await runtime.scheduler.transaction(state => {
  state.recent = [
    { time: now, startedAt: now - 950, requestId: 'preview-recovered', attempt: 2, status: 200, retry: false },
    { time: now - 4300, requestId: 'preview-recovered', attempt: 1, status: 429, retry: true, retryDelayMs: 3000, reason: '限流' },
    ...Array.from({ length: 98 }, (_, index) => ({ time: now - (index + 1) * 12000, attempt: 1, ...examples[index % examples.length] })),
  ];
});
let page = await startPage(runtime, 0);
const pagePort = page.address().port;
const pageURL = `http://127.0.0.1:${page.address().port}/`;
const wrapper = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/restart') {
    page.closeAllConnections(); await new Promise(resolve => page.close(resolve));
    page = await startPage(await createRuntime(directory), pagePort);
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>dao 本地模拟预览</title><iframe title="dao" sandbox="allow-scripts" src="${pageURL}" style="width:100%;height:95vh;border:0"></iframe>`);
});
wrapper.listen(0, '127.0.0.1'); await once(wrapper, 'listening');
await writeFile(path.join(parent, 'settings-browser-session.json'), JSON.stringify({ url: `http://127.0.0.1:${wrapper.address().port}/`, pageURL, settings: runtime.settings.file, pid: process.pid }));
console.log('READY: settings page in the Magpie allow-scripts sandbox');
await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
wrapper.closeAllConnections(); page.closeAllConnections();
await Promise.all([new Promise(resolve => wrapper.close(resolve)), new Promise(resolve => page.close(resolve))]);
assert.equal(path.dirname(await realpath(directory)), await realpath(parent));
await rm(directory, { recursive: true, force: true });
