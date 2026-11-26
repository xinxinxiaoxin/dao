import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const magpie = process.argv[2] || path.join(process.env.LOCALAPPDATA, 'Programs/magpie/magpie.exe');
const bun = await realpath(process.argv[3] || path.join(root, '../ag网关/.local-tools/node_modules/@oven/bun-windows-x64/bin/bun.exe'));
const parent = path.join(root, '.sandbox');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(path.join(parent, 'host-'));
const home = path.join(directory, 'home');
const config = path.join(directory, 'config/magpie');
const fixture = path.join(directory, 'fixture');
const captures = [];
let mode = 'pass', recover = 0, disconnected = false, active = 0, peak = 0;
const holds = [];
function reply(res, body, model) {
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'qiandao fixture OK' }] };
  const response = { id: 'resp_fixture', object: 'response', status: 'completed', model, output: [item], usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 80 } }, service_tier: body.service_tier || 'default' };
  if (body.stream) {
    const values = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } }, { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'qiandao fixture OK' }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    return res.end(values.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(''));
  }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response));
}
const upstream = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  assert.ok(!raw.includes('_qiandao_request'), 'Internal marker leaked');
  const body = JSON.parse(raw || '{}');
  captures.push({ body, url: req.url, headers: req.headers });
  active++; peak = Math.max(peak, active); res.once('close', () => { active--; });
  if (mode === 'hang') { res.once('close', () => { disconnected = true; }); return; }
  if (mode === 'hold') { holds.push(() => reply(res, body, body.model)); return; }
  if (mode === 'rate' || (mode === 'recover' && ++recover <= 2)) {
    res.writeHead(429, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Too many requests' } }));
  }
  if (mode === 'auth') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'invalid key' } })); }
  if (mode === 'tier-rejected') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 'unsupported_parameter', message: 'Unsupported parameter: service_tier' } })); }
  if (mode === 'context') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end('event: response.failed\ndata: '+JSON.stringify({ type: 'response.failed', response: { id: 'resp_failed', status: 'failed', error: { code: 'context_length_exceeded', message: 'fixture context limit' } } })+'\n\n'); }
  if (mode === 'slow') await delay(180);
  reply(res, body, body.model);
});
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const freePort = async () => { const server = http.createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; };
const upstreamPort = await listen(upstream);
const port = await freePort(), webPort = await freePort(), pagePort = await freePort();
const addr = `127.0.0.1:${port}`, web = `http://127.0.0.1:${webPort}`, page = `http://127.0.0.1:${pagePort}`;
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, SystemDrive: process.env.SystemDrive, COMSPEC: process.env.COMSPEC, PATH: path.join(process.env.SystemRoot, 'System32'), HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming'), TEMP: directory, TMP: directory, XDG_CONFIG_HOME: path.dirname(config), XDG_CACHE_HOME: path.join(directory, 'cache'), XDG_DATA_HOME: path.join(directory, 'data'), XDG_STATE_HOME: path.join(directory, 'state'), MAGPIE_BIN_DIR: path.join(directory, 'bin'), MAGPIE_BUN: bun, MAGPIE_ADDR: addr, MAGPIE_PLUGIN_MARKET: 'off', DO_NOT_TRACK: '1', MAGPIE_WEB_KEY: randomUUID() };
const cli = async (...args) => (await promisify(execFile)(magpie, args, { cwd: directory, env, windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const json = (file, data) => writeFile(file, JSON.stringify(data));
let gateway, ended, log = '', cookie;
const webAPI = async (route, body) => {
  const response = await fetch(`${web}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: web, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text);
};
try {
  for (const dir of [config, fixture, home, env.LOCALAPPDATA, env.APPDATA, path.join(config, 'qiandao-gateway')]) await mkdir(dir, { recursive: true });
  assert.ok((await cli('data')).includes(config));
  if (process.argv[4]) await promisify(execFile)('tar.exe', ['-xf', path.resolve(process.argv[4]), '--strip-components', '1', '-C', fixture]);
  else for (const file of ['lib', 'ui', 'provider.mjs', 'package.json', 'qiandao.middleware.mjs']) await cp(path.join(root, file), path.join(fixture, file), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(fixture, 'package.json'), 'utf8'));
  manifest.magpie.options.settingsPort = pagePort; manifest.magpie.page.service.port = pagePort;
  await json(path.join(fixture, 'package.json'), manifest);
  await json(path.join(config, 'settings.json'), { sessionReads: { asked: true, all: false, agents: {} } });
  await json(path.join(config, 'providers.json'), { providers: [{ id: 'qiandao-gateway', models: ['gpt-6-astra', 'future-model'] }] });
  await json(path.join(config, 'qiandao-gateway/settings.json'), { baseURL: `http://127.0.0.1:${upstreamPort}/v1`, maxConcurrency: 2, models: ['gpt-6-astra'] });
  const catalogDir = path.join(env.XDG_CACHE_HOME, 'magpie'); await mkdir(catalogDir, { recursive: true });
  await json(path.join(catalogDir, 'models.json'), { openai: { id: 'openai', models: { 'gpt-6-astra': { id: 'gpt-6-astra', reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }] } } } });
  await cli('plugin', 'add', fixture);
  let listed = JSON.parse(await cli('plugin', '--json'));
  assert.ok(listed.providers?.some(row => row.id === 'qiandao-gateway'), JSON.stringify(listed));
  console.log('PASS: packaged provider loads without credentials');
  const installed = JSON.parse(await readFile(path.join(config, 'plugins.json'), 'utf8'));
  installed.plugins[0].options = { settingsPort: pagePort };
  await json(path.join(config, 'plugins.json'), installed);
  // Exercise the same relay with shorter waits in the isolated host.
  await writeFile(path.join(fixture, 'provider.mjs'), "import { createProvider } from './lib/provider.mjs'; export default createProvider({policy:{maxAttempts:3,budgetMs:3000,rateDelays:[20],errorDelays:[20]}});\n");
  gateway = spawn(magpie, ['serve', `--web=127.0.0.1:${webPort}`], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  ended = once(gateway, 'close');
  for (const stream of [gateway.stdout, gateway.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-6000); });
  for (let i = 0; i < 150; i++) {
    try { await (await fetch(`http://${addr}`, { signal: AbortSignal.timeout(200) })).text(); break; } catch { await delay(100); }
    assert.equal(gateway.exitCode, null, log);
  }
  const login = await fetch(`${web}/?k=${env.MAGPIE_WEB_KEY}`, { redirect: 'manual' });
  cookie = login.headers.getSetCookie()[0]?.split(';')[0]; assert.ok(cookie);
  assert.equal((await webAPI('plugin-signin', { provider: 'qiandao-gateway', method: 0, key: 'fixture-only' })).state, 'done');
  listed = JSON.parse(await cli('plugin', '--json'));
  const models = listed.providers.find(x => x.id === 'qiandao-gateway').models;
  for (const id of ['gpt-6-astra', 'future-model']) assert.ok(models.find(x => x.id === id)?.serviceTiers?.includes('priority'), JSON.stringify(models));
  const post = (body = {}, signal = AbortSignal.timeout(20000)) => fetch(`http://${addr}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'codex_cli_rs/fixture', originator: 'codex_cli_rs', 'session-id': 'fixture-session', 'thread-id': 'fixture-thread' }, body: JSON.stringify({ model: 'qiandao-gateway/gpt-6-astra', input: 'fixture', stream: false, ...body }), signal });
  for (const model of ['gpt-6-astra', 'future-model']) {
    const before = captures.length;
    const response = await post({ model: `qiandao-gateway/${model}`, reasoning: { effort: 'high' }, prompt_cache_key: 'fixture-cache', client_metadata: { preserved: 'value' }, additional_tools: [{ type: 'tool_search' }], input: [{ type: 'reasoning', id: 'rs_fixture', encrypted_content: 'fixture-encrypted' }, { role: 'user', content: 'fixture' }] });
    const text = await response.text(); assert.equal(response.status, 200, text); assert.match(text, /qiandao fixture OK/);
    assert.equal(captures.length - before, 1);
    const sent = captures.at(-1); assert.equal(sent.body.reasoning?.effort, 'high'); assert.equal(sent.body.prompt_cache_key, 'fixture-cache'); assert.equal(sent.body.client_metadata?.preserved, 'value');
    assert.equal(sent.headers['user-agent'], 'codex_cli_rs/fixture'); assert.equal(sent.headers['session-id'], 'fixture-session');
    assert.deepEqual(sent.body.additional_tools, [{ type: 'tool_search' }]);
    assert.equal(sent.body.input[0].encrypted_content, 'fixture-encrypted');
  }
  console.log('PASS: plain Key, hand-entered models, UA/session/cache/effort preserved');
  const nativePicker = await webAPI('state');
  assert.match(JSON.stringify(nativePicker), /qiandao-gateway/);
  assert.match(JSON.stringify(nativePicker), /fastFor/);
  await webAPI('agent-fast', { for: 'codex', ref: 'qiandao-gateway/gpt-6-astra', fast: true });
  await (await post()).text(); assert.equal(captures.at(-1).body.service_tier, 'priority');
  mode = 'recover'; const beforeRecover = captures.length;
  await (await post()).text(); assert.equal(captures.length - beforeRecover, 3); assert.ok(captures.slice(beforeRecover).every(x => x.body.service_tier === 'priority'));
  mode = 'pass';
  await webAPI('agent-fast', { for: 'codex', ref: 'qiandao-gateway/future-model', fast: true });
  await (await post({ model: 'qiandao-gateway/future-model' })).text(); assert.equal(captures.at(-1).body.service_tier, 'priority');
  await webAPI('agent-fast', { for: 'codex', ref: 'qiandao-gateway/future-model', fast: false });
  await webAPI('agent-fast', { for: 'codex', ref: 'qiandao-gateway/gpt-6-astra', fast: false });
  await (await post()).text(); assert.notEqual(captures.at(-1).body.service_tier, 'priority');
  console.log('PASS: native Magpie Fast enabled/disabled without client tier, retries retain Priority');
  const pages = await webAPI('plugin-pages');
  assert.match(JSON.stringify(pages), /千刀网关/);
  const launch = await fetch(new URL(pages[0].url, web), { headers: { cookie } });
  assert.equal(launch.status, 200);
  assert.match(await launch.text(), /location.replace/);
  let html;
  for (let i = 0; i < 50; i++) { try { html = await (await fetch(page)).text(); if (html.includes('PAGE_TOKEN')) throw new Error('missing token'); break; } catch { await delay(100); } }
  const token = html.match(/const token='([^']+)'/)[1];
  const save = async change => {
    const current = await (await fetch(`${page}/api/state`, { headers: { 'x-qiandao-page': token } })).json();
    const res = await fetch(`${page}/api/settings`, { method: 'PUT', headers: { 'x-qiandao-page': token, 'content-type': 'application/json' }, body: JSON.stringify({ ...current.settings, ...change }) });
    assert.equal(res.status, 200, await res.text());
  };
  const pidBefore = (await (await fetch(`${page}/_health`)).json()).pid;
  await save({ baseURL: `http://127.0.0.1:${upstreamPort}/changed/v1`, maxConcurrency: 1 });
  await (await post()).text(); assert.equal(captures.at(-1).url, '/changed/v1/responses');
  assert.equal((await (await fetch(`${page}/_health`)).json()).pid, pidBefore);
  mode = 'slow'; peak = 0;
  await Promise.all(Array.from({ length: 4 }, async (_, i) => { const response = await post({ input: `queued-${i}` }); assert.equal(response.status, 200, await response.text()); }));
  assert.equal(peak, 1);
  console.log('PASS: settings page hot update, changed Base URL and shared concurrency=1');
  mode = 'hold'; peak = 0;
  const oldReply = post({ input: 'before-host-reload' }).then(async r => { assert.equal(r.status, 200, await r.text()); });
  for (let i = 0; i < 100 && holds.length === 0; i++) await delay(20);
  assert.equal(holds.length, 1);
  await webAPI('plugins/options', { spec: fixture, options: { settingsPort: pagePort, hostReloadFixture: true } });
  const newReply = post({ input: 'after-host-reload' }).then(async r => { assert.equal(r.status, 200, await r.text()); });
  await delay(350);
  assert.equal(holds.length, 1, 'The new host bypassed the retiring host concurrency');
  holds.shift()(); await oldReply;
  for (let i = 0; i < 100 && holds.length === 0; i++) await delay(30);
  assert.equal(holds.length, 1); holds.shift()(); await newReply;
  assert.equal(peak, 1);
  console.log('PASS: shared concurrency survives plugin host reload, in-flight response completes');
  mode = 'context'; const beforeContext = captures.length;
  const failed = await post({ stream: true }); const errorEvent = await failed.text(); assert.match(errorEvent, /context_length_exceeded/); assert.equal(captures.length - beforeContext, 1);
  console.log('PASS: context limit reaches the client as an SSE failure, one upstream send');
  mode = 'rate'; const beforeRate = captures.length;
  const exhausted = await post({}, AbortSignal.timeout(80000)); await exhausted.text();
  assert.equal(captures.length - beforeRate, 3, log);
  console.log('PASS: persistent 429 across host attempts, exactly three configured upstream sends');
  mode = 'hang'; const beforeHang = captures.length; const controller = new AbortController();
  const pending = post({}, controller.signal).then(r => r.text()).catch(() => {});
  for (let i = 0; i < 100 && captures.length === beforeHang; i++) await delay(30);
  assert.equal(captures.length, beforeHang + 1); controller.abort(); await pending;
  for (let i = 0; i < 100 && !disconnected; i++) await delay(30);
  assert.equal(disconnected, true);
  console.log('PASS: client cancellation closes the upstream request');
  mode = 'tier-rejected';
  await webAPI('agent-fast', { for: 'codex', ref: 'qiandao-gateway/gpt-6-astra', fast: true });
  const beforeTier = captures.length;
  const refused = await post(); assert.equal(refused.status, 400, await refused.text());
  assert.equal(captures.length - beforeTier, 1, 'Fast refusal must not resend downgraded');
  assert.equal(captures.at(-1).body.service_tier, 'priority');
  const beforeNextTier = captures.length;
  const nextRefused = await post({ input: 'next-priority-request' }); await nextRefused.text();
  assert.equal(captures.length - beforeNextTier, 1);
  assert.equal(captures.at(-1).body.service_tier, 'priority', 'A previous refusal must not silently downgrade a new Fast request');
  console.log('PASS: explicit Fast refusal is not retried as Standard');
  if (process.env.QIANDAO_UI_MODE === '1') {
    mode = 'pass';
    await writeFile(path.join(parent, 'ui-session.json'), JSON.stringify({ web, key: env.MAGPIE_WEB_KEY, page, pages, directory }));
    console.log('UI READY: isolated Magpie settings are available for browser validation');
    while (true) {
      try { await readFile(path.join(parent, 'ui-done')); break; } catch { await delay(500); }
    }
  }
  await writeFile(path.join(parent, 'last-host-result.json'), JSON.stringify({ version: manifest.version, passed: true, at: new Date().toISOString() }));
} catch (error) {
  await writeFile(path.join(parent, 'last-host-failure.log'), `${error.stack}\n${log}`);
  throw error;
} finally {
  if (gateway && gateway.exitCode === null) gateway.kill();
  if (ended) await ended;
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  assert.equal(path.dirname(await realpath(directory)), await realpath(parent));
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
