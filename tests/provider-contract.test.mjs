import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { createProvider } from '../lib/provider.mjs';
import { createSettings } from '../lib/settings.mjs';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dao-contract-'));
  t.after(async () => {
    assert.equal(dirname(await realpath(dir)), await realpath(tmpdir()));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('provider defaults preserve explicit user configuration', async t => {
  const dir = await directory(t);
  const hooks = await createProvider({ noPage: true })({ directory: dir });
  const explicit = { name: 'My dao', api: 'https://custom.invalid/v1', npm: '@ai-sdk/openai', models: { 'manual-model': { reasoning: false, limit: { context: 64000, output: 4096 } } } };
  const cfg = { provider: { 'qiandao-gateway': structuredClone(explicit) } };
  await hooks.config(cfg);
  assert.deepEqual(cfg.provider['qiandao-gateway'], explicit);
});

test('collaboration aliases preserve call IDs, past ciphertext and unrelated schemas', async t => {
  const dir = await directory(t);
  let sent;
  const hooks = await createProvider({ noPage: true, fetchUpstream: async request => {
    sent = await request.json(); return Response.json({ id: 'fixture' });
  } })({ directory: dir });
  const settings = await createSettings(join(dir, 'qiandao-gateway'));
  await settings.save({ baseURL: 'https://example.invalid', maxConcurrency: 1, models: [] });
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fixture' }));
  const fn = name => ({ type: 'function', name, parameters: { type: 'object', properties: { message: { type: 'string', encrypted: true }, private_value: { type: 'string', encrypted: true } } } });
  const body = { model: 'gpt-6-astra', tools: [{ type: 'namespace', name: 'collaboration', tools: [fn('spawn_agent'), fn('other')] }, fn('collaboration__send_message'), fn('spawn_agent'), { type: 'namespace', name: 'other', tools: [fn('followup_task')] }], input: [{ type: 'agent_message', content: [{ type: 'encrypted_content', encrypted_content: 'fixture' }] }, { type: 'function_call', name: 'spawn_agent', encrypted_function_args: ['message'], arguments: '{"message":"prior"}' }] };
  body.input.push({ type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'call_worker', arguments: '{"message":"read the fixture"}' }, { type: 'function_call_output', call_id: 'call_worker', output: 'ok' });
  await loader.fetch('https://qiandao.invalid/v1/responses', { method: 'POST', body: JSON.stringify(body) });
  const expected = structuredClone(body);
  const first = expected.tools[0].tools.shift();
  first.name = 'collaboration__spawn_agent';
  delete first.parameters.properties.message.encrypted;
  delete expected.tools[1].parameters.properties.message.encrypted;
  expected.tools.splice(1, 0, first);
  expected.input[2].name = 'collaboration__spawn_agent'; delete expected.input[2].namespace;
  assert.deepEqual(sent, expected);
});

test('removing a settings model takes effect in the same plugin host', async t => {
  const dir = await directory(t);
  const hooks = await createProvider({ noPage: true })({ directory: dir });
  const settings = await createSettings(join(dir, 'qiandao-gateway'));
  await settings.save({ baseURL: 'https://example.invalid', maxConcurrency: 5, models: ['gpt-6-astra', 'remove-me'] });
  const cfg = {};
  await hooks.config(cfg);
  const provider = { models: Object.fromEntries(Object.entries(cfg.provider['qiandao-gateway'].models).map(([id, m]) => [id, { id, capabilities: { reasoning: m.reasoning } }])) };
  assert.ok((await hooks.provider.models(provider))['remove-me']);
  await settings.save({ ...(await settings.read()), models: ['gpt-6-astra'] });
  const models = await hooks.provider.models(provider);
  assert.ok(models['gpt-6-astra']);
  assert.equal(models['remove-me'], undefined);
});

test('explicit model capabilities survive the models hook', async t => {
  const dir = await directory(t);
  const hooks = await createProvider({ noPage: true })({ directory: dir });
  const configured = { id: 'manual-model', capabilities: { reasoning: false, toolcall: false }, limit: { context: 64000, output: 4096 }, variants: { high: {} } };
  const models = await hooks.provider.models({ models: { 'manual-model': configured } });
  assert.deepEqual(models['manual-model'].capabilities, configured.capabilities);
  assert.deepEqual(models['manual-model'].limit, configured.limit);
  assert.deepEqual(models['manual-model'].variants, configured.variants);
});

test('an occupied settings port does not prevent provider chat', async t => {
  const dir = await directory(t);
  const occupied = http.createServer((_, res) => { res.writeHead(404); res.end('another application'); });
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(String(message));
  let hooks;
  try {
    hooks = await createProvider({ fetchUpstream: async () => Response.json({ output: ['OK'] }) })({ directory: dir }, { settingsPort: occupied.address().port });
  } finally { console.warn = originalWarn; }
  assert.equal(hooks.auth.provider, 'qiandao-gateway');
  assert.ok(warnings.some(text => text.includes('设置')));
  const settings = await createSettings(join(dir, 'qiandao-gateway'));
  await settings.save({ baseURL: 'https://example.invalid', maxConcurrency: 5, models: ['gpt-6-astra'] });
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fixture' }));
  const response = await loader.fetch('https://qiandao.invalid/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-6-astra', input: 'hello' }) });
  assert.equal(response.status, 200);
});
