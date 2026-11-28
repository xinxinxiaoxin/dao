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
import { asOffered, checkToolDelivery } from './tool-delivery.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const magpie = process.argv[2] || path.join(process.env.LOCALAPPDATA, 'Programs/magpie/magpie.exe');
const bun = await realpath(process.argv[3] || process.env.MAGPIE_BUN || path.join(root, '.local-tools/node_modules/@oven/bun-windows-x64/bin/bun.exe'));
const parent = path.join(root, '.sandbox');
await mkdir(parent, { recursive: true });
if (process.env.QIANDAO_UI_MODE === '1') await rm(path.join(parent, 'ui-done'), { force: true });
const directory = await mkdtemp(path.join(parent, 'host-'));
const home = path.join(directory, 'home');
const config = path.join(directory, 'config/magpie');
const fixture = path.join(directory, 'fixture');
const captures = [];
const metadataCalls = [];
let remoteModels = ['gpt-6-astra', 'remote-old'], metadataClosed = false;
let mode = 'pass', recover = 0, disconnected = false, active = 0, peak = 0;
let emptyTurnSent = false;
let longRetrySent = false;
let firstFailure;
let wireOutput = [];
let matchWireTools = false;
const holds = [];
function responseItems(res, output, id = 'resp_loop', variant = '') {
  const response = { id, object: 'response', status: 'completed', model: 'gpt-6-astra', output, usage: { input_tokens: 40, output_tokens: 34, total_tokens: 74 } };
  const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }];
  for (const [output_index, item] of output.entries()) {
    if (variant === 'aggregate-only' && item.type !== 'reasoning') continue;
    if (item.type === 'message') {
      events.push({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', content: [] } });
      for (const [content_index, part] of item.content.entries()) {
        const index = { item_id: item.id, output_index, content_index };
        events.push({ type: 'response.content_part.added', ...index, part: { ...part, text: '' } }, { type: 'response.output_text.delta', ...index, delta: part.text }, { type: 'response.output_text.done', ...index, text: part.text }, { type: 'response.content_part.done', ...index, part });
      }
    } else if (['function_call', 'custom_tool_call'].includes(item.type)) {
      const field = item.type === 'function_call' ? 'arguments' : 'input';
      const prefix = item.type === 'function_call' ? 'function_call_arguments' : 'custom_tool_call_input';
      const index = { item_id: item.id, output_index };
      events.push({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', [field]: '' } });
      const middle = Math.floor(item[field].length / 2);
      for (const delta of [item[field].slice(0, middle), item[field].slice(middle)]) events.push({ type: `response.${prefix}.delta`, ...index, delta });
      events.push({ type: `response.${prefix}.done`, ...index, [field]: item[field] });
    } else events.push({ type: 'response.output_item.added', output_index, item });
    events.push({ type: 'response.output_item.done', output_index, item });
  }
  const completed = { ...response };
  if (variant === 'missing-output') delete completed.output;
  events.push({ type: 'response.completed', response: completed });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(events.map((e, sequence_number) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number })}\n\n`).join(''));
}
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
  if (req.method === 'GET' && /\/(models|usage)$/.test(req.url)) {
    metadataCalls.push(req.url);
    assert.equal(req.headers.authorization, 'Bearer fixture-only');
    if (metadataClosed) { res.writeHead(503, { 'content-type': 'text/html' }); return res.end('<html>Not open</html>'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(req.url.endsWith('/models')
      ? { object: 'list', data: remoteModels.map(id => ({ id, object: 'model' })) }
      : { mode: 'unrestricted', balance: 12.5, remaining: 12.5, unit: 'USD', usage: { today: { actual_cost: 1.25 } } }));
  }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  assert.ok(!raw.includes('_qiandao_request'), 'Internal marker leaked');
  const body = JSON.parse(raw || '{}');
  captures.push({ body, url: req.url, headers: req.headers, at: Date.now() });
  active++; peak = Math.max(peak, active); res.once('close', () => { active--; });
  if (firstFailure) {
    const [type, payload] = firstFailure;
    firstFailure = undefined;
    res.writeHead(200, { 'content-type': type }); return res.end(payload);
  }
  if (mode === 'handoff') return responseItems(res, ['spawn_agent','send_message','followup_task'].map(name => ({ type: 'function_call', id: `fc_${name}`, call_id: `call_${name}`, name: `collaboration__${name}`, status: 'completed', arguments: JSON.stringify({ message: 'Read the fixture.' }) })), 'resp_handoff');
  if (mode === 'tool-search') {
    const tools = [...body.tools || [], ...(body.input || []).filter(item => item.type === 'additional_tools').flatMap(item => item.tools)];
    const search = tools.find(tool => tool.type === 'tool_search' || tool.name === 'tool_search');
    const result = body.input.find(item => (item.type === 'tool_search_output' || item.type === 'function_call_output') && item.call_id === 'call_discover');
    if (result) {
      const found = (result.tools || tools).flatMap(tool => tool.type === 'namespace' ? tool.tools.map(child => ({ name: child.name, namespace: tool.name })) : [{ name: tool.name }]).find(tool => tool.name?.includes('fixture_lookup'));
      if (!found) { res.writeHead(400); return res.end('The client did not discover the fixture tool'); }
      const calls = ['left', 'right'].map(label => ({ id: `fc_${label}`, type: 'function_call', status: 'completed', call_id: `call_${label}`, ...found, arguments: JSON.stringify({ label }) }));
      const results = body.input.filter(item => item.type === 'function_call_output' && calls.some(call => call.call_id === item.call_id));
      if (!results.length) return responseItems(res, calls, 'resp_parallel');
      if (results.length !== calls.length || !['left', 'right'].every(label => JSON.stringify(results.find(item => item.call_id === `call_${label}`)?.output ?? '').includes(`DAO_FIXTURE_${label}`))) {
        res.writeHead(400); return res.end(`Fixture lookup results are missing or mismatched: ${JSON.stringify(results)}`);
      }
      return responseItems(res, [{ type: 'message', id: 'msg_found', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: 'DAO_SEARCH_FOUND', annotations: [] }] }], 'resp_found');
    }
    if (!search) { res.writeHead(400); return res.end('Fixture request did not offer client tool search'); }
    const args = { query: 'fixture_lookup' };
    const call = { id: 'ts_fixture', call_id: 'call_discover', status: 'completed', ...(search.type === 'function'
      ? { type: 'function_call', name: 'tool_search', arguments: JSON.stringify(args) }
      : { type: 'tool_search_call', execution: 'client', arguments: args }) };
    const progress = { type: 'message', id: 'msg_search', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'Looking up the fixture.', annotations: [] }] };
    return responseItems(res, JSON.stringify(body.input).includes('Show progress, then search.') ? [progress, call] : [call], 'resp_search');
  }
  if (mode === 'wire') {
    const output = matchWireTools ? asOffered(wireOutput, body.tools || []) : wireOutput;
    if (body.stream) return responseItems(res, output, 'resp_wire');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 'resp_wire', object: 'response', status: 'completed', model: body.model, output }));
  }
  if (mode === 'codex-loop') {
    const inputs = Array.isArray(body.input) ? body.input : [];
    const toolResult = id => inputs.find(x => x.call_id === id && /_output$/.test(x.type));
    const second = toolResult('call_dao_second');
    if (second) {
      assert.match(JSON.stringify(second.output), /\b364\b/, 'The second calculation did not run');
      assert.doesNotMatch(JSON.stringify(second.output), /error|rejected|failed/i);
      return responseItems(res, [{ type: 'message', id: 'msg_final', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: 'DAO_TOOL_LOOP_OK: 364', annotations: [], logprobs: [] }] }], 'resp_final');
    }
    const first = toolResult('call_dao_first');
    if (first) {
      assert.match(JSON.stringify(first.output), /\b323\b/, 'The first calculation did not run');
      assert.doesNotMatch(JSON.stringify(first.output), /error|rejected|failed/i);
      assert.ok(inputs.some(x => x.role === 'assistant' && x.phase === 'commentary'), 'Assistant phase was dropped from tool history');
      if (!emptyTurnSent) {
        emptyTurnSent = true;
        if (process.env.QIANDAO_OMITTED_OUTPUT === '1') return responseItems(res, [{ type: 'reasoning', id: 'rs_only', summary: [{ type: 'summary_text', text: 'Reviewing documentation and scripts' }] }], 'resp_empty', 'missing-output');
        if (process.env.QIANDAO_AGGREGATE_ONLY === '1') return responseItems(res, [{ type: 'reasoning', id: 'rs_only', summary: [{ type: 'summary_text', text: 'Reviewing documentation and scripts' }] }, { type: 'custom_tool_call', id: 'ctc_missing', call_id: 'call_dao_second', name: 'exec', input: 'text(323 + 41)', status: 'completed' }], 'resp_empty', 'aggregate-only');
        return responseItems(res, [], 'resp_empty');
      }
      return responseItems(res, [{ type: 'custom_tool_call', id: 'ctc_second', call_id: 'call_dao_second', name: 'exec', input: 'text(323 + 41)', status: 'completed' }], 'resp_second');
    }
    return responseItems(res, [{ type: 'message', id: 'msg_progress', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'I will run two calculations.', annotations: [], logprobs: [] }] }, { type: 'custom_tool_call', id: 'ctc_first', call_id: 'call_dao_first', name: 'exec', input: 'text(17 * 19)', status: 'completed' }], 'resp_first');
  }
  if (mode === 'hang') { res.once('close', () => { disconnected = true; }); return; }
  if (mode === 'long-retry' && !longRetrySent) {
    longRetrySent = true;
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
    return res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Too many requests' } }));
  }
  if (mode === 'hold') { holds.push(() => reply(res, body, body.model)); return; }
  if (mode === 'rate' || (mode === 'recover' && ++recover <= 2)) {
    res.writeHead(429, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Too many requests' } }));
  }
  if (mode === 'auth') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'invalid key' } })); }
  if (mode === 'closed') { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<html>Not open</html>'); }
  if (mode === 'tier-rejected') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 'unsupported_parameter', message: 'Unsupported parameter: service_tier' } })); }
  if (mode === 'context') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end('event: response.failed\ndata: '+JSON.stringify({ type: 'response.failed', response: { id: 'resp_failed', status: 'failed', error: { code: 'context_length_exceeded', message: 'fixture context limit' } } })+'\n\n'); }
  if (mode === 'slow') await delay(180);
  reply(res, body, body.model);
});
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const freePort = async () => { const server = http.createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; };
const upstreamPort = await listen(upstream);
let originalGateway, originalPort;
if (process.env.QIANDAO_PATH_COMPARE === '1') {
  const { createGateway, loadConfig } = await import('../docs/research/qiandao-source/gateway.mjs');
  originalGateway = createGateway({ ...loadConfig({}), upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`, upstreamApiKey: 'fixture-only' });
  originalPort = await listen(originalGateway.server);
}
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
  await json(path.join(config, 'settings.json'), { searchAll: process.env.QIANDAO_HOST_SEARCH === '1', sessionReads: { asked: true, all: false, agents: {} } });
  await json(path.join(config, 'providers.json'), { ...(process.env.QIANDAO_HOST_SEARCH === '1' ? { searches: [{ vendor: 'tavily', key: 'fixture-only' }] } : {}), providers: [
    { id: 'qiandao-gateway', models: ['gpt-6-astra', 'future-model'], pickedFrom: ['gpt-6-astra', 'future-model'] },
    ...(originalPort ? [{ id: 'baseline', name: 'Original gateway', key: 'fixture-only', responses: `http://127.0.0.1:${originalPort}/v1`, models: ['gpt-6-astra'], passErrors: true }] : []),
  ] });
  await json(path.join(config, 'qiandao-gateway/manual-models.json'), ['future-model']);
  await json(path.join(config, 'qiandao-gateway/settings.json'), { baseURL: `http://127.0.0.1:${upstreamPort}/v1`, maxConcurrency: 2, models: ['gpt-6-astra', 'removable-model'] });
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
  await writeFile(path.join(fixture, 'provider.mjs'), `import { createProvider } from './lib/provider.mjs'; export default createProvider({policy:{maxAttempts:3,budgetMs:${process.env.QIANDAO_RETRY_AFTER === '1' ? 90000 : 3000},rateDelays:[20],errorDelays:[20]}});\n`);
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
  const codexModels = await (await fetch(`http://${addr}/v1/codex/models?client_version=0.171.0`)).json();
  const codexModel = codexModels.models.find(x => x.slug === 'qiandao-gateway/gpt-6-astra');
  assert.ok(codexModel?.supported_reasoning_levels?.some(x => x.effort === 'high'));
  assert.ok(models.some(x => x.id === 'removable-model'));
  assert.ok(models.some(x => x.id === 'remote-old'), 'Upstream models are missing');
  const savedProvider = async () => JSON.parse(await readFile(path.join(config, 'providers.json'), 'utf8')).providers.find(x => x.id === 'qiandao-gateway');
  let picksBefore = (await savedProvider()).models;
  {
    const pickState = async () => {
      const p = (await webAPI('providers')).providers.find(x => x.id === 'qiandao-gateway');
      return { chosen: p.chosen, models: p.models.map(x => ({ id: x.id, on: x.on })), stored: (await savedProvider()).models };
    };
    await webAPI('provider/save', { id: 'qiandao-gateway', models: picksBefore });
    const subset = await pickState();
    assert.deepEqual(subset.chosen, picksBefore, 'Deselecting a candidate must persist in the provider editor');
    assert.deepEqual(subset.models.filter(x => x.on).map(x => x.id).sort(), [...picksBefore].sort());
    await webAPI('provider/save', { id: 'qiandao-gateway', models: [], noModels: true });
    const none = await pickState();
    assert.deepEqual(none.models.filter(x => x.on), [], 'Select none must leave every candidate unselected');
    await webAPI('provider/save', { id: 'qiandao-gateway', models: picksBefore });
    console.log('PASS: saving the original subset does not auto-select new candidates; Select none also persists');
    const originalSettings = JSON.parse(await readFile(path.join(config, 'qiandao-gateway/settings.json'), 'utf8'));
    await json(path.join(config, 'qiandao-gateway/settings.json'), { ...originalSettings, models: [] });
    await webAPI('provider/save', { id: 'qiandao-gateway', models: ['gpt-6-astra'] });
    remoteModels = ['temporary-model']; await webAPI('provider/models', { id: 'qiandao-gateway' });
    assert.ok((await savedProvider()).delisted.includes('gpt-6-astra'));
    remoteModels = ['gpt-6-astra', 'newly-opened-model']; await webAPI('provider/models', { id: 'qiandao-gateway' });
    assert.deepEqual((await pickState()).chosen, ['gpt-6-astra'], 'Restoring a delisted pick must not select a newly opened model');
    await json(path.join(config, 'qiandao-gateway/settings.json'), originalSettings);
    await webAPI('provider/save', { id: 'qiandao-gateway', models: picksBefore });
    console.log('PASS: a delisted pick returns without selecting other newly opened models');
  }
  remoteModels = ['gpt-6-astra', 'remote-new'];
  let fetched = await webAPI('provider/models', { id: 'qiandao-gateway' });
  assert.ok(JSON.stringify(fetched.provider).includes('remote-new'), JSON.stringify(fetched));
  assert.ok(!JSON.stringify(fetched.provider).includes('remote-old'), 'Removed upstream candidate is still listed');
  assert.deepEqual((await savedProvider()).models, picksBefore, 'Fetching candidates must not select new models');
  picksBefore = [...picksBefore, 'remote-new'];
  await webAPI('provider/save', { id: 'qiandao-gateway', models: picksBefore });
  assert.deepEqual((await savedProvider()).models, picksBefore, 'Native selection did not save');
  let quota = await cli('quota', 'qiandao-gateway', '--json');
  assert.ok(quota.includes('$12.50'), quota);
  metadataClosed = true;
  fetched = await webAPI('provider/models', { id: 'qiandao-gateway' });
  assert.ok(JSON.stringify(fetched.provider).includes('remote-new'), 'A closed site erased the last list');
  assert.deepEqual((await savedProvider()).models, picksBefore, 'A closed site changed selected models');
  quota = await cli('quota', 'qiandao-gateway', '--json');
  assert.match(JSON.parse(quota)[0].readError, /暂时不可用/);
  assert.ok(!quota.includes('$0.00'), quota);
  listed = JSON.parse(await cli('plugin', '--json'));
  assert.ok(!JSON.stringify(listed.providers.find(x => x.id === 'qiandao-gateway').accounts).includes('expired'), 'Closure expired the account');
  metadataClosed = false;
  remoteModels = ['gpt-6-astra', 'remote-reopened'];
  fetched = await webAPI('provider/models', { id: 'qiandao-gateway' });
  assert.ok(JSON.stringify(fetched.provider).includes('remote-reopened'));
  assert.ok(!JSON.stringify(fetched.provider).includes('remote-new'));
  assert.deepEqual((await savedProvider()).models, picksBefore.filter(id => id !== 'remote-new'), 'Reopening should remove only the delisted upstream pick');
  console.log('PASS: native model refresh updates candidates without selecting them; closure keeps models and login, balance is unavailable rather than zero');
  const post = (body = {}, signal = AbortSignal.timeout(20000)) => fetch(`http://${addr}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'codex_cli_rs/fixture', originator: 'codex_cli_rs', 'session-id': 'fixture-session', 'thread-id': 'fixture-thread' }, body: JSON.stringify({ model: 'qiandao-gateway/gpt-6-astra', input: 'fixture', stream: false, ...body }), signal });
  {
    const names = ['spawn_agent', 'send_message', 'followup_task'];
    const definition = name => ({ type: 'function', name, parameters: { type: 'object', properties: { message: { type: 'string', encrypted: true } } } });
    const group = { type: 'namespace', name: 'collaboration', tools: names.map(definition) };
    mode = 'handoff';
    for (const placement of ['tools', 'additional_tools', 'tool_search_output']) for (const withWeb of [true, false]) {
      const input = [{ type: 'message', role: 'user', content: 'Delegate the fixture.' }];
      const tools = withWeb ? [{ type: 'web_search' }] : [];
      if (placement === 'tools') tools.push(group);
      else if (placement === 'additional_tools') input.unshift({ type: placement, role: 'developer', tools: [group] });
      else input.unshift({ type: 'tool_search_call', execution: 'client', call_id: 'call_load', arguments: { query: 'collaboration' } }, { type: placement, execution: 'client', call_id: 'call_load', tools: [group] });
      if (placement === 'tool_search_output') tools.push({ type: 'tool_search', execution: 'client', description: 'Find tools', parameters: { type: 'object', properties: { query: { type: 'string' } } } });
      const response = await post({ stream: true, tools, input });
      const reply = await response.text(); assert.equal(response.status, 200, reply);
      const returned = reply.split(/\r?\n/).filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6))).filter(event => event.type === 'response.output_item.done').map(event => event.item);
      assert.equal(returned.length, names.length);
      const sent = captures.at(-1).body;
      const definitions = [...sent.tools || [], ...(sent.input || []).flatMap(item => item.tools || [])].flatMap(item => item.type === 'namespace' ? item.tools : [item]);
      for (const name of names) {
        const tool = definitions.find(item => item.name === name || item.name === `collaboration__${name}`);
        assert.equal(tool?.parameters?.properties?.message?.type, 'string', `${placement}: lost ${name}`);
        assert.equal(tool.name, `collaboration__${name}`, 'Do not alter the schema of a reserved upstream function');
        assert.notEqual(tool.parameters.properties.message.encrypted, true, `${placement}, web=${withWeb}: ${name} requests an unreadable sealed task`);
        const call = returned.find(item => item.call_id === `call_${name}`);
        assert.equal(call?.namespace, 'collaboration', `${placement}, web=${withWeb}: ${name} lost its namespace`);
        assert.equal(call.name, name); assert.deepEqual(call.encrypted_function_args, []); assert.deepEqual(JSON.parse(call.arguments), { message: 'Read the fixture.' });
      }
    }
    console.log('PASS: Codex V2 task, message and follow-up tools request readable text with or without web search');
  }
  mode = 'wire';
  if (originalPort) {
    const setOutput = output => { wireOutput = output; };
    const direct = body => fetch(`http://127.0.0.1:${originalPort}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6-astra', ...body }) });
    await checkToolDelivery(direct, setOutput, 'direct original gateway');
    await checkToolDelivery(body => post({ ...body, model: 'baseline/gpt-6-astra' }), setOutput, 'Magpie + original gateway (identical native replies)', true);
    matchWireTools = true;
    await checkToolDelivery(body => post({ ...body, model: 'baseline/gpt-6-astra' }), setOutput, 'Magpie + original gateway (declared tools)', true);
  }
  matchWireTools = true;
  await checkToolDelivery(post, output => { wireOutput = output; });
  mode = 'pass';
  if (process.env.QIANDAO_CODEX_SEARCH === '1') {
    const codexHome = path.join(directory, 'search-home'); await mkdir(codexHome);
    const mcp = fileURLToPath(new URL('./tool-search-mcp.mjs', import.meta.url));
    await json(path.join(codexHome, 'models.json'), { models: [codexModel] });
    await writeFile(path.join(codexHome, 'config.toml'), `model = "qiandao-gateway/gpt-6-astra"\nmodel_provider = "fixture"\nmodel_catalog_json = "models.json"\nweb_search = "live"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.fixture]\nname = "dao fixture"\nbase_url = "http://${addr}/v1"\nwire_api = "responses"\n[mcp_servers.fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(mcp)}]\nrequired = true\n[mcp_servers.fixture.tools.fixture_lookup]\napproval_mode = "approve"\n`);
    mode = 'tool-search'; const before = captures.length;
    const output = await new Promise((resolve, reject) => {
      const child = execFile(process.env.CODEX_TEST_BIN || 'codex.exe', ['exec', '--ephemeral', '--trust', '--skip-git-repo-check', '--json', '-C', directory, 'Discover the fixture lookup tool and report the result.'], { env: { ...process.env, CODEX_HOME: codexHome }, windowsHide: true, timeout: 45000 }, (error, stdout, stderr) => error ? reject(new Error(`Search client failed: ${stderr.slice(-1000)}; ${stdout.slice(-1400)}`)) : resolve(stdout));
      child.stdin.end();
    });
    assert.ok(output.includes('DAO_SEARCH_FOUND'), `Codex stopped without returning the discovered tool: ${output}`);
    assert.equal(captures.length - before, 3);
    console.log('PASS: real Codex discovers the MCP tool, executes two calls in one turn, and returns both results to their original IDs');
    mode = 'pass';
  }
  mode = 'tool-search';
  for (const webSearch of [false, true]) {
    const search = { type: 'tool_search', execution: 'client', description: 'Find a tool', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
    const tools = webSearch ? [search, { type: 'web_search' }] : [search];
    for (const content of ['Find the fixture tool.', 'Show progress, then search.']) {
      const input = [{ type: 'additional_tools', role: 'developer', tools }, { type: 'message', role: 'user', content }];
      const before = captures.length;
      const res = await post({ stream: true, input });
      assert.equal(res.status, 200);
      const events = (await res.text()).split(/\r?\n/).filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
      const items = events.filter(event => event.type === 'response.output_item.done').map(event => event.item);
      assert.ok(items.some(item => item.type === 'tool_search_call' && item.execution === 'client' && item.call_id === 'call_discover' && item.arguments?.query === 'fixture_lookup'), `Client lost the search call (web_search=${webSearch}); delivered: ${JSON.stringify(items.map(item => item.type))}`);
      if (content.startsWith('Show progress')) assert.ok(items.some(item => item.type === 'message' && item.phase === 'commentary'), `Progress phase changed (web_search=${webSearch}): ${items.map(item => `${item.type}:${item.phase || ''}`)}`);
      if (!webSearch || process.env.QIANDAO_HOST_SEARCH !== '1') assert.deepEqual(captures.at(-1).body.input, input);
      else assert.ok(captures.at(-1).body.tools.some(tool => tool.type === 'function' && tool.name === 'web_search'));
      assert.equal(captures.length - before, 1);
    }
  }
  console.log('PASS: client tool discovery survives both direct and web-search-capable Responses requests');
  mode = 'pass';
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
  if (originalPort) {
    mode = 'wire';
    matchWireTools = false;
    const readItems = text => text.split(/\r?\n\r?\n/).flatMap(block => {
      try {
        const value = JSON.parse(block.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n'));
        return value.type === 'response.output_item.done' ? [value.item] : [];
      } catch { return []; }
    });
    for (const tool of [
      { type: 'function_call', id: 'fc_wire', call_id: 'call_wire', name: 'exec_command', arguments: '{"cmd":"fixture"}', status: 'completed' },
      { type: 'custom_tool_call', id: 'ctc_wire', call_id: 'call_wire', name: 'exec', input: 'text(323)', status: 'completed' },
    ]) {
      wireOutput = [{ type: 'reasoning', id: 'rs_wire', summary: [{ type: 'summary_text', text: 'Inspecting fixture documents' }] }, tool];
      const definition = tool.type === 'function_call' ? { type: 'function', name: tool.name, parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } : { type: 'custom', name: tool.name, format: { type: 'text' } };
      const input = [{ type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'functions', tools: [definition] }] }, { role: 'user', content: 'Inspect the fixture.' }];
      const body = { stream: true, input, reasoning: { effort: 'high', context: 'all_turns' } };
      const old = readItems(await (await post({ ...body, model: 'baseline/gpt-6-astra' })).text());
      const oldRequest = captures.at(-1).body;
      const current = readItems(await (await post(body)).text());
      const pluginRequest = captures.at(-1).body;
      assert.equal(pluginRequest.reasoning.context, 'all_turns', 'Restored Codex tools lost their original reasoning context');
      assert.deepEqual(current, old, 'Plugin and original gateway changed delivered output items differently');
      assert.ok(current.some(x => x.type === tool.type && x.call_id === tool.call_id));
      console.log(`PASS: Magpie -> original gateway and Magpie -> dao deliver identical ${tool.type} items`);
      console.log(JSON.stringify({ requestShapes: { original: { additionalTools: oldRequest.input?.some(x => x.type === 'additional_tools'), tools: oldRequest.tools?.length, reasoning: oldRequest.reasoning }, plugin: { additionalTools: pluginRequest.input?.some(x => x.type === 'additional_tools'), tools: pluginRequest.tools?.length, reasoning: pluginRequest.reasoning } } }));
    }
    mode = 'pass';
  }
  if (process.env.QIANDAO_CODEX_LOOP === '1') {
    const codexHome = path.join(directory, 'codex-home'); await mkdir(codexHome);
    await writeFile(path.join(codexHome, 'config.toml'), `model = "qiandao-gateway/gpt-6-astra"\nmodel_provider = "fixture"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.fixture]\nname = "dao fixture"\nbase_url = "http://${addr}/v1"\nwire_api = "responses"\n`);
    mode = 'codex-loop'; const beforeLoop = captures.length;
    const codex = process.env.CODEX_TEST_BIN || 'C:/Program Files/WindowsApps/OpenAI.Codex_26.1120.6357.0_x64__2p2nqsd0c76g0/app/resources/codex.exe';
    const result = await new Promise((resolve, reject) => {
      const child = execFile(codex, ['exec', '--ephemeral', '--skip-git-repo-check', '--json', '-C', directory, 'Use exec for two separate JavaScript calculations: text(17 * 19), then text(323 + 41). Do not access files, shell or network. Finish with DAO_TOOL_LOOP_OK: 364.'], { env: { ...process.env, CODEX_HOME: codexHome }, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
      child.stdin.end();
    });
    assert.ok(result.stdout.includes('DAO_TOOL_LOOP_OK: 364'), `Codex stopped before finishing the second tool call: ${result.stdout}`);
    assert.equal(captures.length - beforeLoop, 4, 'The empty completion must use one recovery attempt');
    const loopCalls = captures.slice(beforeLoop);
    assert.deepEqual(loopCalls[1].body, loopCalls[2].body, 'Recovery changed the tool history');
    console.log('PASS: real Codex executes two tools and finishes after dao recovers a completion without delivered output');
    mode = 'pass';
  }
  const pages = await webAPI('plugin-pages');
  assert.ok(pages.some(item => item.title === 'dao'));
  const launch = await fetch(new URL(pages[0].url, web), { headers: { cookie } });
  assert.equal(launch.status, 200);
  assert.match(await launch.text(), /location.replace/);
  let html;
  for (let i = 0; i < 50; i++) { try { html = await (await fetch(page)).text(); if (html.includes('PAGE_TOKEN')) throw new Error('missing token'); break; } catch { await delay(100); } }
  assert.match(html, /上游报错记录/);
  assert.match(html, /重试等待/);
  const token = html.match(/const token='([^']+)'/)[1];
  const pageState = async () => {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const response = await fetch(`${page}/api/state`, { headers: { 'x-qiandao-page': token } });
        assert.equal(response.status, 200);
        return response.json();
      } catch (error) {
        if (error.cause?.code !== 'ECONNREFUSED' || Date.now() >= deadline) throw error;
        await delay(100);
      }
    }
  };
  const save = async change => {
    const current = await pageState();
    const res = await fetch(`${page}/api/settings`, { method: 'PUT', headers: { 'x-qiandao-page': token, 'content-type': 'application/json' }, body: JSON.stringify({ ...current.settings, ...change }) });
    assert.equal(res.status, 200, await res.text());
  };
  const pidBefore = (await (await fetch(`${page}/_health`)).json()).pid;
  await save({ baseURL: `http://127.0.0.1:${upstreamPort}/changed/v1`, maxConcurrency: 1, models: ['gpt-6-astra'] });
  const refreshed = await webAPI('provider/models', { id: 'qiandao-gateway' });
  assert.ok(!JSON.stringify(refreshed.provider).includes('removable-model'), 'Deleted settings model reappeared after refreshing');
  assert.ok(JSON.stringify(refreshed.provider).includes('future-model'), 'A manually configured model was removed');
  assert.ok(metadataCalls.includes('/changed/v1/models'), 'Model refresh ignored the new Base URL');
  console.log('PASS: settings model removal reaches the current host model list, manual models remain');
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
  mode = 'pass';
  for (const [type, payload, stream] of [
    ['text/event-stream', 'data: [DONE]\n\n', true],
    ['text/event-stream', 'data: {"type":"error","code":"server_error","message":"discard-me"}\n\ndata: [DONE]\n\n', true],
    ['application/json', '{"output":["discard-me"', false],
    ['application/json', '{"error":{"code":429,"message":"忙"}}', false],
  ]) {
    const start = captures.length;
    firstFailure = [type, payload];
    const response = await post({ stream });
    const text = await response.text();
    assert.equal(response.status, 200); assert.match(text, /qiandao fixture OK/); assert.doesNotMatch(text, /discard-me/);
    assert.equal(captures.length - start, 2); assert.deepEqual(captures[start].body, captures[start + 1].body);
  }
  console.log('PASS: empty SSE, failed SSE, truncated JSON and embedded 429 recover before the client sees an answer');
  mode = 'rate'; const beforeRate = captures.length;
  const beforeHistory = (await pageState()).upstreamHistory;
  const startedRate = Date.now();
  const exhausted = await post({}, AbortSignal.timeout(80000)); await exhausted.text();
  assert.equal(captures.length - beforeRate, 3, log);
  const afterHistory = (await pageState()).upstreamHistory;
  assert.equal(afterHistory.attempts, Math.min(100, beforeHistory.attempts + 3));
  const logged = afterHistory.errors.slice(0, 3);
  assert.deepEqual(logged.map(row => [row.status, row.attempt, row.message, row.recovered]),
    [3, 2, 1].map(attempt => [429, attempt, '请求太多，千刀限流了', false]));
  assert.ok(logged.every(row => row.time >= startedRate && row.time <= Date.now()));
  assert.deepEqual(logged.map(row => row.retryDelayMs), [null, 20, 20]);
  assert.ok(logged.slice(1).every(row => row.actualRetryMs >= 20));
  console.log('PASS: persistent 429 has three upstream sends, two recorded retry waits, and no retry after the cap');
  mode = 'closed'; const beforeClosed = captures.length;
  const closedReply = await post({}, AbortSignal.timeout(80000)); const closedText = await closedReply.text();
  assert.equal(captures.length - beforeClosed, 3);
  assert.notEqual(closedReply.status, 200); assert.ok(!closedText.includes('<html>'));
  listed = JSON.parse(await cli('plugin', '--json'));
  assert.ok(!JSON.stringify(listed.providers.find(x => x.id === 'qiandao-gateway').accounts).includes('expired'));
  mode = 'pass'; const openAgain = await post(); assert.equal(openAgain.status, 200, await openAgain.text());
  console.log('PASS: closed-site HTML has a bounded recovery budget and the account works after reopening');
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
  if (process.env.QIANDAO_RETRY_AFTER === '1') {
    mode = 'long-retry'; const beforeLong = captures.length;
    const recovered = await post({}, AbortSignal.timeout(80000));
    assert.equal(recovered.status, 200, await recovered.text());
    const attempts = captures.slice(beforeLong);
    assert.equal(attempts.length, 2);
    const wait = attempts[1].at - attempts[0].at;
    assert.ok(wait >= 30000 && wait < 60000, `Expected the first retry after 30 seconds, observed ${wait}ms`);
    assert.deepEqual(attempts[0].body, attempts[1].body);
    console.log(`PASS: real host waited ${wait}ms for the first Retry-After: 120, then recovered without changing the request`);
  }
  if (process.env.QIANDAO_UI_MODE === '1') {
    mode = 'pass';
    remoteModels = ['gpt-6-astra', 'gpt-6.1-sol', 'codex-auto-review', 'gpt-5.3-codex-spark'];
    await json(path.join(config, 'qiandao-gateway/settings.json'), { baseURL: `http://127.0.0.1:${upstreamPort}/v1`, maxConcurrency: 5, models: [] });
    await webAPI('provider/save', { id: 'qiandao-gateway', models: ['gpt-6-astra'] });
    await webAPI('provider/models', { id: 'qiandao-gateway' });
    await writeFile(path.join(parent, 'ui-session.json'), JSON.stringify({ web, key: env.MAGPIE_WEB_KEY, page, pages, directory, settings: path.join(config, 'qiandao-gateway/settings.json'), upstreamURL: `http://127.0.0.1:${upstreamPort}` }));
    console.log('UI READY: isolated Magpie settings are available for browser validation');
    while (true) {
      try { await readFile(path.join(parent, 'ui-done')); break; } catch { await delay(500); }
    }
    const uiSaved = JSON.parse(await readFile(path.join(config, 'qiandao-gateway/settings.json'), 'utf8'));
    assert.equal(uiSaved.baseURL, `http://127.0.0.1:${upstreamPort}/v1`);
    assert.equal(uiSaved.maxConcurrency, 3);
    const uiResponse = await post(); const uiBody = await uiResponse.text();
    assert.equal(uiResponse.status, 200, uiBody);
    assert.equal(captures.at(-1).url, '/v1/responses');
    console.log('PASS: browser-saved settings persist and the provider sends to that upstream successfully');
  }
  await writeFile(path.join(parent, 'last-host-result.json'), JSON.stringify({ version: manifest.version, passed: true, at: new Date().toISOString() }));
} catch (error) {
  await writeFile(path.join(parent, 'last-host-failure.log'), `${error.stack}\n${log}`);
  throw error;
} finally {
  if (gateway && gateway.exitCode === null) gateway.kill();
  if (ended) await ended;
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  if (originalGateway) { originalGateway.server.closeAllConnections(); await new Promise(resolve => originalGateway.server.close(resolve)); }
  assert.equal(path.dirname(await realpath(directory)), await realpath(parent));
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
