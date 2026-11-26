import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSettings, normalizeBase, policy } from '../lib/settings.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import { Relay } from '../lib/relay.mjs';
import { classify, retryAfter } from '../lib/classify.mjs';
import { createProvider } from '../lib/provider.mjs';
import { onRequest, onProvider } from '../qiandao.middleware.mjs';
import { startPage } from '../lib/page-service.mjs';

const fast = { budgetMs: 2000, upstreamTimeoutMs: 1000, rateDelays: [2], errorDelays: [2] };
const request = (signal, input = 'hello') => new Request('https://example.invalid/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input, service_tier: 'priority' }), signal });
const limited = () => Response.json({ error: { code: 'rate_limit_exceeded', message: 'Too many requests' } }, { status: 429 });
const success = () => Response.json({ id: 'resp_ok', status: 'completed', output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'OK' }] }] });
const event = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;

async function fixture(t, limit = 5) {
  const directory = await mkdtemp(join(tmpdir(), 'qiandao-test-'));
  t.after(async () => { assert.equal(dirname(await realpath(directory)), await realpath(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  const settings = await createSettings(directory);
  await settings.save({ baseURL: 'https://example.invalid', models: ['gpt-6-astra'], maxConcurrency: limit });
  return { directory, settings, scheduler: new Scheduler(settings) };
}

test('旧策略次数、间隔和地址路径', () => {
  assert.equal(policy.maxAttempts, 7);
  assert.deepEqual(policy.rateDelays, [3000, 6000, 10000, 20000, 40000, 60000]);
  assert.equal(policy.rateDelays.reduce((a, b) => a + b), 139000);
  assert.equal(normalizeBase('https://example.org/'), 'https://example.org/v1');
  assert.equal(normalizeBase('https://example.org/api/v1/'), 'https://example.org/api/v1');
  assert.equal(retryAfter('12'), 12000);
  assert.equal(retryAfter(new Date(50000).toUTCString(), 30000), 20000);
});

test('临时错误和明确终态分类', () => {
  assert.equal(classify(429, 'application/json', '{}').retry, true);
  assert.equal(classify(529, 'application/json', '{}').retry, false);
  assert.equal(classify(200, 'application/json', JSON.stringify({ error: { message: 'concurrency limit exceeded' } })).rate, true);
  const failed = event({ type: 'response.failed', response: { error: { code: 'context_length_exceeded', message: 'too long' } } });
  assert.equal(classify(200, 'text/event-stream', failed).retry, false);
  assert.equal(classify(200, 'text/event-stream', event({ type: 'response.failed', response: { error: { code: 'server_error', message: 'upstream interrupted' } } })).retry, true);
  assert.equal(classify(200, 'text/event-stream', event({ type: 'response.output_text.delta', delta: 'half' })).retry, true);
  assert.equal(classify(200, 'text/event-stream', event({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } })).retry, false);
  assert.equal(classify(429, 'application/json', JSON.stringify({ error: { code: 'insufficient_quota' } })).retry, false);
});

test('429恢复与宿主重复调用共用七次上限', async t => {
  const { scheduler } = await fixture(t);
  let calls = 0;
  const relay = new Relay(scheduler, { policy: fast, fetchUpstream: async () => { calls++; return limited(); } });
  const first = await relay.send(request(), { id: 'request-one', attempt: 1 });
  assert.equal(first.status, 429);
  assert.equal(calls, 7);
  const lastBody = await first.text();
  assert.equal(await (await relay.send(request(), { id: 'request-one', attempt: 2 })).text(), lastBody);
  assert.equal(calls, 7);
  const afterReload = new Relay(scheduler, { policy: fast, fetchUpstream: async () => { calls++; return success(); } });
  assert.equal((await afterReload.send(request(), { id: 'request-one', attempt: 3 })).status, 409);
  assert.equal(calls, 7);
});

test('同一请求正在恢复时再次调用不会重复发送', async t => {
  const { scheduler } = await fixture(t);
  let calls = 0;
  const relay = new Relay(scheduler, { policy: fast, fetchUpstream: async () => { calls++; await delay(30); return success(); } });
  const a = relay.send(request(), { id: 'simultaneous', attempt: 1 });
  await delay(5);
  const b = relay.send(request(), { id: 'simultaneous', attempt: 2 });
  assert.deepEqual(await (await a).json(), await (await b).json());
  assert.equal(calls, 1);
});

test('整段缓存丢弃失败片段，完成后仅交付成功结果', async t => {
  const { scheduler } = await fixture(t);
  let calls = 0;
  const relay = new Relay(scheduler, { policy: fast, fetchUpstream: async () => new Response(++calls === 1 ? event({ type: 'response.output_text.delta', delta: 'bad fragment' }) : event({ type: 'response.completed', response: { output: ['good result'] } }), { headers: { 'content-type': 'text/event-stream' } }) });
  const text = await (await relay.send(request(), { id: 'cut-stream', attempt: 1 })).text();
  assert.match(text, /good result/);
  assert.doesNotMatch(text, /bad fragment/);
  assert.equal(calls, 2);
});

test('上下文超限原事件保留且最终结果阻止宿主重放', async t => {
  const { scheduler } = await fixture(t);
  const body = event({ type: 'response.failed', response: { id: 'resp_failed', error: { code: 'context_length_exceeded' } } });
  let calls = 0;
  const relay = new Relay(scheduler, { policy: fast, fetchUpstream: async () => { calls++; return new Response(body, { headers: { 'content-type': 'text/event-stream' } }); } });
  assert.equal(await (await relay.send(request(), { id: 'too-long', attempt: 1 })).text(), body);
  assert.equal(relay.recent[0].phase, '已失败');
  assert.equal(await (await relay.send(request(), { id: 'too-long', attempt: 2 })).text(), body);
  assert.equal(calls, 1);
});

test('缺少中间件标记时只发一次', async t => {
  const { scheduler } = await fixture(t);
  let calls = 0;
  const relay = new Relay(scheduler, { policy: fast, fetchUpstream: async () => { calls++; return limited(); } });
  await relay.send(request());
  assert.equal(calls, 1);
});

test('并发池跨实例共用，调低不杀已有请求且取消退出队列', async t => {
  const { settings, scheduler } = await fixture(t, 2);
  const other = new Scheduler(settings);
  const signal = new AbortController().signal;
  const releaseA = await scheduler.acquire(signal, Date.now() + 3000);
  const releaseB = await other.acquire(signal, Date.now() + 3000);
  await settings.save({ ...(await settings.read()), maxConcurrency: 1 });
  const controller = new AbortController();
  const pending = other.acquire(controller.signal, Date.now() + 3000).catch(e => e);
  await delay(100);
  assert.equal((await scheduler.snapshot()).active, 2);
  await releaseA();
  await delay(100);
  assert.equal((await scheduler.snapshot()).active, 1);
  assert.equal((await scheduler.snapshot()).queued, 1);
  controller.abort(); await pending;
  assert.equal((await scheduler.snapshot()).queued, 0);
  await releaseB();
  assert.equal((await scheduler.snapshot()).active, 0);
});

test('排队准入期限到期，冷却不占上游名额', async t => {
  const { scheduler } = await fixture(t, 1);
  await scheduler.cooldown(Date.now() + 5000);
  const granted = await scheduler.acquire(new AbortController().signal, Date.now() + 80);
  assert.equal(granted, null);
  const state = await scheduler.snapshot();
  assert.equal(state.active, 0); assert.equal(state.queued, 0);
});

test('长Retry-After不得提前重发；取消关闭上游', async t => {
  const { scheduler } = await fixture(t);
  let calls = 0;
  const relay = new Relay(scheduler, { policy: { ...fast, budgetMs: 100 }, fetchUpstream: async () => { calls++; return Response.json({ error: { message: 'too many requests' } }, { status: 429, headers: { 'retry-after': '5' } }); } });
  await relay.send(request(), { id: 'respect-delay', attempt: 1 });
  assert.equal(calls, 1);
  await scheduler.transaction(state => { state.cooldownUntil = 0; });
  let ended = false;
  const hang = new Relay(scheduler, { policy: fast, fetchUpstream: req => new Promise((_, reject) => req.signal.addEventListener('abort', () => { ended = true; reject(req.signal.reason); })) });
  const controller = new AbortController();
  const pending = hang.send(request(controller.signal), { id: 'cancel', attempt: 1 });
  await delay(40); controller.abort(); await pending;
  assert.equal(ended, true);
  assert.equal((await scheduler.snapshot()).active, 0);
});

test('Provider还原Codex字段、原生Fast、地址热改及手填模型', async t => {
  const { directory } = await fixture(t);
  const wire = [];
  const provider = await createProvider({ noPage: true, policy: fast, fetchUpstream: async req => { wire.push({ url: req.url, ua: req.headers.get('user-agent'), body: await req.json() }); return success(); } })({ directory });
  const settings = await createSettings(join(directory, 'qiandao-gateway'));
  await settings.save({ baseURL: 'https://one.invalid', maxConcurrency: 5, models: ['gpt-6-astra'] });
  const config = {}; await provider.config(config);
  await writeFile(join(directory, 'providers.json'), JSON.stringify({ providers: [{ id: 'qiandao-gateway', models: ['future-model'] }] }));
  const models = await provider.provider.models({ models: {} });
  assert.deepEqual(models['future-model'].serviceTiers, ['priority']);
  const loader = await provider.auth.loader(async () => ({ type: 'api', key: 'fixture-only' }));
  const original = { model: 'qiandao-gateway/gpt-6-astra', input: [{ type: 'reasoning', encrypted_content: 'fixture' }], additional_tools: [{ type: 'tool_search' }], prompt_cache_key: 'stable-cache', reasoning: { effort: 'high' } };
  const ctx = { protocol: 'responses', state: {}, provider: { id: 'qiandao-gateway' } };
  onRequest(original, ctx);
  const tagged = onProvider(original, ctx);
  delete tagged.additional_tools;
  tagged.model = 'gpt-6-astra'; tagged.service_tier = 'priority';
  await loader.fetch('https://qiandao.invalid/v1/responses', { method: 'POST', headers: { 'user-agent': 'codex/fixture' }, body: JSON.stringify(tagged) });
  assert.equal(wire[0].url, 'https://one.invalid/v1/responses');
  assert.equal(wire[0].body.prompt_cache_key, 'stable-cache');
  assert.deepEqual(wire[0].body.additional_tools, original.additional_tools);
  assert.equal(wire[0].body.service_tier, 'priority');
  assert.equal(wire[0].body.client_metadata?._qiandao_request, undefined);
  await settings.save({ ...(await settings.read()), baseURL: 'https://two.invalid/prefix/v1' });
  await loader.fetch('https://qiandao.invalid/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-6-astra', input: 'second' }) });
  assert.equal(wire[1].url, 'https://two.invalid/prefix/v1/responses');
});

test('设置页保存并发和地址无需重建Provider', async t => {
  const { settings, scheduler } = await fixture(t);
  const server = await startPage({ settings, scheduler, relay: { recent: [] } }, 0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(url)).text();
  const token = html.match(/const token='([^']+)'/)[1];
  const value = { baseURL: 'https://new.invalid', maxConcurrency: 3, models: ['gpt-6-astra', 'future-model'] };
  assert.equal((await fetch(`${url}/api/settings`, { method: 'PUT', body: JSON.stringify(value) })).status, 403);
  const saved = await fetch(`${url}/api/settings`, { method: 'PUT', headers: { 'x-qiandao-page': token }, body: JSON.stringify(value) });
  assert.equal(saved.status, 200);
  assert.equal((await settings.read()).maxConcurrency, 3);
  assert.equal((await settings.read()).baseURL, 'https://new.invalid/v1');
});
