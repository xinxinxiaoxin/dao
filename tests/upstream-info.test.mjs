import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProvider } from '../lib/provider.mjs';
import { createSettings } from '../lib/settings.mjs';
import { classify } from '../lib/classify.mjs';
import { ModelCatalog, readUsage } from '../lib/upstream-info.mjs';

const auth = { type: 'api', key: 'fixture-key' };
async function setup(t, metadataFetch) {
  const directory = await mkdtemp(join(tmpdir(), 'dao-info-'));
  t.after(async () => { assert.equal(dirname(await realpath(directory)), await realpath(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  const hooks = await createProvider({ noPage: true, metadataFetch })({ directory });
  const settings = await createSettings(join(directory, 'qiandao-gateway'));
  await settings.save({ baseURL: 'https://example.invalid/api/v1', maxConcurrency: 5, models: ['manual-model'] });
  return { hooks, settings, directory };
}

test('native models hook reads current upstream models with the saved key', async t => {
  const calls = [];
  const { hooks, directory } = await setup(t, async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ data: [{ id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol' }] }); });
  await writeFile(join(directory, 'providers.json'), JSON.stringify({ providers: [{ id: 'qiandao-gateway', models: ['typed-model'], pickedFrom: [] }] }));
  const list = await hooks.provider.models({ models: {} }, { auth });
  assert.deepEqual(Object.keys(list).sort(), ['gpt-6-astra', 'gpt-6.1-sol', 'manual-model', 'typed-model']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.invalid/api/v1/models');
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer fixture-key');
  assert.deepEqual(list['gpt-6.1-sol'].serviceTiers, ['priority']);
});

test('refresh replaces remote candidates and a closure keeps the last successful list', async t => {
  let mode = 'old', calls = 0;
  const { hooks, directory } = await setup(t, async () => {
    calls++;
    if (mode === 'closed') return new Response('<html>closed</html>', { status: 503, headers: { 'content-type': 'text/html' } });
    if (mode === 'empty') return Response.json({ data: [] });
    return Response.json({ data: [{ id: mode === 'old' ? 'old-model' : 'new-model' }] });
  });
  const provider = { models: {} };
  await hooks.provider.models(provider, { auth });
  await writeFile(join(directory, 'providers.json'), JSON.stringify({ providers: [{ id: 'qiandao-gateway', models: ['old-model'], pickedFrom: ['old-model'] }] }));
  mode = 'new';
  const updated = await hooks.provider.models(provider, { auth });
  assert.ok(updated['new-model']); assert.equal(updated['old-model'], undefined);
  for (mode of ['closed', 'empty']) {
    const kept = await hooks.provider.models(provider, { auth });
    assert.ok(kept['new-model']); assert.equal(kept[Symbol.for('magpie.fellBack')], true);
  }
  assert.equal(calls, 4);
});

test('account and endpoint model lists stay separate', async t => {
  const { hooks, settings } = await setup(t, async (url, init) => {
    const key = new Headers(init.headers).get('authorization');
    if (String(url).includes('other.invalid') || key.endsWith('second')) throw new Error('closed');
    return Response.json({ data: [{ id: 'first-account-model' }] });
  });
  await hooks.provider.models({ models: {} }, { auth });
  const second = await hooks.provider.models({ models: {} }, { auth: { ...auth, key: 'second' } });
  assert.equal(second['first-account-model'], undefined);
  await settings.save({ ...(await settings.read()), baseURL: 'https://other.invalid/v1' });
  const changed = await hooks.provider.models({ models: {} }, { auth });
  assert.equal(changed['first-account-model'], undefined);
});

test('a fresh host recovers account models from disk without persisting credentials', async t => {
  const { settings } = await setup(t, async () => Response.json({ data: [] }));
  const first = new ModelCatalog(settings.directory, async () => Response.json({ data: [{ id: 'saved-model' }] }));
  await first.read('https://example.invalid/v1', auth, undefined, 'qiandao-gateway');
  const file = await readFile(join(settings.directory, 'models-qiandao-gateway.json'), 'utf8');
  assert.ok(!file.includes(auth.key));
  const reopened = new ModelCatalog(settings.directory, async () => { throw new Error('closed'); });
  assert.deepEqual(await reopened.read('https://example.invalid/v1', auth, undefined, 'qiandao-gateway'), { models: ['saved-model'], fallback: true, error: 'closed' });
  assert.deepEqual((await reopened.read('https://example.invalid/v1', auth, undefined, 'qiandao-gateway:second')).models, []);
});

test('cancelled metadata queries stop without retries or a successful fallback', async t => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const query = async (_url, init) => { calls++; init.signal.throwIfAborted(); };
  const { hooks, settings } = await setup(t, query);
  await assert.rejects(hooks.provider.models({ models: {} }, { auth, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(readUsage((await settings.read()).baseURL, auth, controller.signal, query), { name: 'AbortError' });
  assert.equal(calls, 2);
  await settings.save({ ...(await settings.read()), models: [] });
  assert.deepEqual((await settings.read()).models, []);
});

test('usage hook reports wallet balance including a real zero', async t => {
  let balance = 12.5;
  const calls = [];
  const { hooks } = await setup(t, async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ mode: 'unrestricted', unit: 'USD', balance, remaining: balance, usage: { today: { actual_cost: 1.25 }, total: { actual_cost: 3.5 } } }); });
  assert.equal(typeof hooks.auth.usage, 'function');
  const info = await hooks.auth.usage(async () => auth, {}, {});
  assert.equal(info.balance, '$12.50'); assert.equal(info.signIn, 'kept');
  assert.equal(calls[0].url, 'https://example.invalid/api/v1/usage');
  assert.ok(info.windows.some(x => x.display === '$1.25'));
  balance = 0;
  assert.equal((await hooks.auth.usage(async () => auth, {}, {})).balance, '$0.00');
});

test('unavailable usage is not zero or an expired login and does not retry', async t => {
  let calls = 0;
  const { hooks } = await setup(t, async () => { calls++; return new Response('<html>closed</html>', { status: 403, headers: { 'content-type': 'text/html' } }); });
  assert.equal(typeof hooks.auth.usage, 'function');
  const info = await hooks.auth.usage(async () => auth, {}, {});
  assert.equal(calls, 1); assert.equal(info.signIn, 'kept');
  assert.notEqual(info.balance, '$0.00'); assert.match(info.error, /暂时|查询/);
  assert.deepEqual(info.windows, []);
});

test('quota and subscription windows do not pretend to be a wallet', async t => {
  let payload = { mode: 'quota_limited', quota: { limit: 20, used: 5, remaining: 15, unit: 'USD' }, rate_limits: [{ window: '5h', used: 2, limit: 10, reset_at: '2026-11-27T00:00:00Z' }] };
  const { hooks } = await setup(t, async () => Response.json(payload));
  assert.equal(typeof hooks.auth.usage, 'function');
  const quota = await hooks.auth.usage(async () => auth, {}, {});
  assert.match(quota.balance, /15.00/); assert.ok(quota.windows.some(x => x.amount === 2 && x.limit === 10));
  payload = { mode: 'unrestricted', planName: 'Plan', remaining: 7, unit: 'USD', subscription: { daily_usage_usd: 3, daily_limit_usd: 10, expires_at: '2026-12-01T00:00:00Z' } };
  const plan = await hooks.auth.usage(async () => auth, {}, {});
  assert.equal(plan.plan, 'Plan'); assert.match(plan.balance, /7.00/); assert.equal(plan.until, payload.subscription.expires_at);
});

test('a closed-site HTML response is a temporary upstream failure, not a completed answer', () => {
  for (const status of [200, 403, 503]) {
    const verdict = classify(status, 'text/html', '<html>closed</html>');
    assert.equal(verdict.retry, true);
    assert.equal(verdict.signIn, 'kept');
  }
  assert.equal(classify(401, 'application/json', JSON.stringify({ error: { code: 'invalid_api_key' } })).retry, false);
});
