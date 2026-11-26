import test from 'node:test';
import assert from 'node:assert/strict';
import { Relay } from '../lib/relay.mjs';
import { summarizeAttempts } from '../lib/attempt-history.mjs';

function fixture(t, replies, policy = {}) {
  const now = Date.UTC(2026, 10, 26);
  t.mock.timers.enable({ apis: ['Date'], now });
  let cooldownUntil = now, index = 0;
  const waits = [], requests = [], sentAt = [], records = [];
  const scheduler = {
    async acquire(signal, deadline) {
      signal.throwIfAborted();
      if (cooldownUntil >= deadline) { t.mock.timers.setTime(deadline); return null; }
      if (cooldownUntil > Date.now()) t.mock.timers.setTime(cooldownUntil);
      return async record => { if (record) records.unshift(record); };
    },
    async cooldown(until) { waits.push(until - Date.now()); cooldownUntil = Math.max(cooldownUntil, until); return cooldownUntil; },
    async snapshot() { return { cooldownUntil }; },
  };
  const relay = new Relay(scheduler, { policy, fetchUpstream: async req => {
    sentAt.push(Date.now() - now);
    requests.push(await req.text());
    let reply = replies[Math.min(index++, replies.length - 1)];
    if (reply && typeof reply === 'object') {
      t.mock.timers.setTime(Date.now() + (reply.elapsed ?? 0));
      if (reply.sharedWait) cooldownUntil = Math.max(cooldownUntil, Date.now() + reply.sharedWait);
      reply = reply.after;
    }
    if (reply === 'ok') return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] });
    return Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429, headers: reply === null ? {} : { 'retry-after': reply } });
  } });
  const request = () => new Request('https://example.invalid/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'gpt-6-astra', service_tier: 'priority', input: 'unchanged' }) });
  return { relay, request, waits, requests, sentAt, now, records };
}

test('the first long Retry-After waits 30 seconds, then the next follows upstream', async t => {
  const { relay, request, waits, requests, sentAt, records } = fixture(t, ['120', '90', 'ok']);
  assert.equal((await relay.send(request(), { id: 'one', attempt: 1 })).status, 200);
  assert.deepEqual(waits, [30000, 90000]);
  assert.equal(requests.length, 3);
  assert.deepEqual(sentAt, [0, 30000, 120000]);
  assert.deepEqual(summarizeAttempts(records).errors.map(row => [row.attempt, row.retryDelayMs, row.actualRetryMs]), [[2, 90000, 90000], [1, 30000, 30000]]);
  assert.ok(requests.every(x => x === requests[0]));
  assert.equal((await relay.send(request(), { id: 'one', attempt: 2 })).status, 409);
  assert.equal(requests.length, 3);
});

test('the history shows the shared cooldown and does not promise a retry outside the request budget', async t => {
  const { relay, request, sentAt, records } = fixture(t, [{ after: '120', sharedWait: 35000 }, { after: '1', sharedWait: 270000 }]);
  assert.equal((await relay.send(request(), { id: 'shared-delay', attempt: 1 })).status, 429);
  assert.deepEqual(sentAt, [0, 35000]);
  assert.deepEqual(summarizeAttempts(records).errors.map(row => [row.attempt, row.retryDelayMs, row.actualRetryMs]), [[2, null, undefined], [1, 35000, 35000]]);
});

test('a long Retry-After first seen later still gets exactly one 30-second wait', async t => {
  const { relay, request, waits } = fixture(t, [null, null, null, null, '120', '90', 'ok']);
  assert.equal((await relay.send(request(), { id: 'late', attempt: 1 })).status, 200);
  assert.deepEqual(waits, [3000, 6000, 10000, 20000, 30000, 90000]);
});

test('short, equal-threshold and invalid Retry-After retain the original delays', async t => {
  const { relay, request, waits } = fixture(t, ['20', '30', 'invalid', '120', '25', 'ok']);
  assert.equal((await relay.send(request(), { id: 'mixed', attempt: 1 })).status, 200);
  assert.deepEqual(waits, [20000, 30000, 10000, 30000, 40000]);
});

test('HTTP-date Retry-After uses the same one-time rule and remains request-local', async t => {
  const start = Date.UTC(2026, 10, 26);
  const { relay, request, waits } = fixture(t, [new Date(start + 120000).toUTCString(), new Date(start + 150000).toUTCString(), 'ok', '80', 'ok']);
  assert.equal((await relay.send(request(), { id: 'dates', attempt: 1 })).status, 200);
  assert.equal((await relay.send(request(), { id: 'new', attempt: 1 })).status, 200);
  assert.deepEqual(waits, [30000, 120000, 30000]);
});

test('repeated long Retry-After never starts a new attempt past the original budget', async t => {
  const { relay, request, waits, requests } = fixture(t, ['600']);
  const failed = await relay.send(request(), { id: 'budget', attempt: 1 });
  assert.equal(failed.status, 429);
  assert.equal(requests.length, 2);
  assert.deepEqual(waits, [30000, 600000]);
  await relay.send(request(), { id: 'budget', attempt: 2 });
  assert.equal(requests.length, 2);
});

test('exhausting attempts preserves the upstream cooldown without another early retry', async t => {
  const { relay, request, waits, requests } = fixture(t, ['120'], { maxAttempts: 2 });
  assert.equal((await relay.send(request(), { id: 'cap', attempt: 1 })).status, 429);
  assert.equal(requests.length, 2);
  assert.deepEqual(waits, [30000, 120000]);
});

test('an untagged single-attempt request does not shorten a cooldown for a retry it cannot make', async t => {
  const once = fixture(t, ['120']);
  assert.equal((await once.relay.send(once.request())).status, 429);
  assert.deepEqual(once.waits, [120000]);
});

test('a later long Retry-After cannot renew the early retry after a missing header', async t => {
  const { relay, request, waits } = fixture(t, ['120', null, '90', 'ok']);
  assert.equal((await relay.send(request(), { id: 'gap', attempt: 1 })).status, 200);
  assert.deepEqual(waits, [30000, 6000, 90000]);
});

for (const elapsed of [280000, 310000]) {
  test(`a ${elapsed / 1000}-second attempt keeps the full cooldown when no 30-second retry fits`, async t => {
    const { relay, request, waits, requests } = fixture(t, [{ after: '120', elapsed }]);
    assert.equal((await relay.send(request(), { id: 'deadline', attempt: 1 })).status, 429);
    assert.equal(requests.length, 1);
    assert.deepEqual(waits, [120000]);
  });
}
