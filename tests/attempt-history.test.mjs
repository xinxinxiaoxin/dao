import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRuntime } from '../lib/provider.mjs';
import { startPage } from '../lib/page-service.mjs';

const request = signal => new Request('https://example.invalid/v1/responses', { method: 'POST', body: 'fixture', signal });
const ok = () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] });

async function fixture(t, fetchUpstream) {
  const directory = await mkdtemp(join(tmpdir(), 'dao-attempts-'));
  const runtime = await createRuntime(directory, { fetchUpstream, policy: { budgetMs: 5000, rateDelays: [0], errorDelays: [0] } });
  let server, url;
  const close = async () => {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  t.after(async () => {
    await close();
    assert.equal(dirname(await realpath(directory)), await realpath(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  async function open(source) {
    server = await startPage(source, 0);
    url = `http://127.0.0.1:${server.address().port}`;
  }
  await open(runtime);
  const html = await (await fetch(url)).text();
  const token = html.match(/const token='([^']+)'/)[1];
  return {
    runtime, html,
    async state() {
      const res = await fetch(`${url}/api/state`, { headers: { 'x-qiandao-page': token } });
      assert.equal(res.status, 200);
      return res.json();
    },
    async restart() { await close(); await open(await createRuntime(directory)); },
  };
}

test('shows 429 during a retry, counts the eventual success and keeps the row after reload', async t => {
  const next = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let calls = 0;
  const page = await fixture(t, async () => {
    if (++calls === 1) return Response.json({ error: { message: 'Too many requests' } }, { status: 429 });
    next.resolve();
    return finish.promise;
  });
  const started = Date.now();
  const pending = page.runtime.relay.send(request(), { id: 'recovered', attempt: 1 });
  let row;
  try {
    await Promise.race([next.promise, pending]);
    const { upstreamHistory } = await page.state();
    assert.equal(upstreamHistory?.attempts, 1, 'the 429 must be visible before the retry finishes');
    [row] = upstreamHistory.errors;
    assert.ok(row.time >= started && row.time <= Date.now());
    assert.deepEqual({ ...row, time: undefined }, { time: undefined, status: 429, attempt: 1, message: '请求太多，千刀限流了', category: 'rate', recovered: false, retryDelayMs: 0 });
    assert.match(page.html, /上游报错记录/);
  } finally {
    finish.resolve(ok());
    assert.equal((await pending).status, 200);
  }
  const finished = (await page.state()).upstreamHistory;
  const { actualRetryMs } = finished.errors[0];
  assert.ok(Number.isFinite(actualRetryMs) && actualRetryMs >= 0);
  const expected = { limit: 100, attempts: 2, errors: [{ ...row, recovered: true, actualRetryMs }] };
  assert.deepEqual(finished, expected);
  await page.restart();
  const after = await page.state();
  assert.deepEqual(after.recent, []);
  assert.deepEqual(after.upstreamHistory, expected);
  assert.deepEqual(after.retryPolicy, { maxAttempts: 7, rateDelays: [3000, 6000, 10000, 20000, 40000, 60000], errorDelays: [750, 1500, 3000, 3000, 3000, 3000] });
});

test('labels HTTP 200 errors and network failures without recording raw messages or client cancellation', async t => {
  const entered = Promise.withResolvers();
  const context = { type: 'response.failed', response: { error: { code: 'context_length_exceeded', message: 'fixture-private' } } };
  const replies = [
    () => Response.json({ error: { message: 'exceeded retry limit, last status: 429' } }),
    () => new Response(`data: ${JSON.stringify(context)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
    () => Response.json({ error: { code: 'fixture-private' } }, { status: 503 }),
    () => { throw new Error('fixture-private'); },
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('fixture-private')); } })),
    () => { throw new DOMException('fixture-private', 'TimeoutError'); },
    () => Response.json({ error: { code: 'fixture-private' } }),
    () => new Response('Unreachable', { status: 530 }),
    request => new Promise((_, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      entered.resolve();
    }),
  ];
  const page = await fixture(t, incoming => replies.shift()(incoming));
  for (let index = 0; index < 8; index++) await page.runtime.relay.send(request());
  const controller = new AbortController();
  const pending = page.runtime.relay.send(request(controller.signal));
  await Promise.race([entered.promise, pending]);
  controller.abort();
  assert.equal((await pending).status, 499);
  const data = await page.state();
  assert.equal(data.upstreamHistory.attempts, 8);
  assert.deepEqual(data.upstreamHistory.errors.map(row => [row.status, row.errorCode, row.message]), [
    [530, undefined, '千刀入口暂时不可用'],
    [200, undefined, '千刀返回了错误'],
    [null, undefined, '等待千刀回复超时'],
    [200, undefined, '千刀回复没传完，连接就断了'],
    [null, undefined, '没能连上千刀'],
    [503, undefined, '千刀服务暂时不可用'],
    [200, undefined, '对话太长，超过模型能接收的长度'],
    [200, '429', '请求太多，千刀限流了'],
  ]);
  assert.deepEqual(data.upstreamHistory.errors.map(row => row.category), ['service', 'other', 'service', 'service', 'service', 'service', 'other', 'rate']);
  assert.ok(data.upstreamHistory.errors.every(row => row.retryDelayMs === null && row.actualRetryMs === undefined));
  assert.doesNotMatch(JSON.stringify(data), /fixture-private/);
  assert.doesNotMatch(await readFile(page.runtime.scheduler.file, 'utf8'), /fixture-private/);
});

test('includes older retained attempts and keeps the rate denominator within the 100-row history', async t => {
  const page = await fixture(t, ok);
  const now = Date.now();
  await page.runtime.scheduler.transaction(state => {
    state.recent = Array.from({ length: 100 }, (_, index) => ({ time: now - index * 1000, status: index % 2 ? 200 : 429, attempt: 1, retry: index % 2 === 0, reason: index % 2 ? '' : '限流' }));
  });
  await page.runtime.relay.send(request());
  const { upstreamHistory } = await page.state();
  assert.equal(upstreamHistory.attempts, 100);
  assert.equal(upstreamHistory.errors.length, 50);
  assert.equal(upstreamHistory.errors[0].time, now);
  assert.equal(upstreamHistory.errors[0].status, 429);
  assert.equal(upstreamHistory.errors[0].retryDelayMs, undefined);
  assert.equal(upstreamHistory.errors[0].actualRetryMs, undefined);
});

test('redirects and explicit incomplete responses do not recover a preceding 429', async t => {
  const answers = [() => new Response(null, { status: 307, headers: { location: '/maintenance' } }),
    () => new Response('data: {"type":"response.incomplete","response":{"status":"incomplete","output":[]}}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    () => Response.json({ status: 'incomplete', output: [] })];
  let sends = 0, final;
  const page = await fixture(t, async () => ++sends === 1 ? new Response(null, { status: 429 }) : final());
  for (const [index, answer] of answers.entries()) {
    sends = 0; final = answer;
    const res = await page.runtime.relay.send(request(), { id: `final-${index}`, attempt: 1 });
    assert.equal(res.status, index === 0 ? 307 : 200);
    assert.equal(await res.text(), await answer().text());
    assert.equal(sends, 2);
    const { upstreamHistory, recent } = await page.state();
    assert.equal(upstreamHistory.errors.length, (index + 1) * 2);
    assert.ok(upstreamHistory.errors.every(row => !row.recovered));
    assert.equal(recent[0].phase, index === 0 ? '已失败' : '未完成');
  }
});

test('service failures, numeric codes and explicit context errors retain their meaning across versions', async t => {
  const replies = [() => Response.json({ error: { code: 503 } }),
    () => new Response('data: {"type":"response.failed","response":{"error":{"code":"server_error"}}}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    () => Response.json({ error: { code: 'invalid_request_error', message: 'context_length_exceeded' } }, { status: 400 })];
  const page = await fixture(t, () => replies.shift()());
  await page.runtime.scheduler.transaction(state => { state.recent = [
    { time: 2, requestId: 'old', attempt: 2, status: 200, retry: false, reason: '', response: { endEvent: 'response.incomplete' } },
    { time: 1, requestId: 'old', attempt: 1, status: 200, retry: false, reason: 503 },
  ]; });
  for (let index = 0; index < 3; index++) await page.runtime.relay.send(request());
  const { errors } = (await page.state()).upstreamHistory;
  assert.equal(errors.length, 5);
  assert.match(errors[0].message, /对话太长/);
  assert.equal(errors[1].category, 'service'); assert.doesNotMatch(errors[1].message, /没收到结束信号/);
  for (const row of [errors[2], errors[4]]) {
    assert.deepEqual([row.status, row.errorCode, row.category, row.recovered], [200, '503', 'service', false]);
    assert.match(row.message, /服务暂时不可用/);
  }
});

test('a planned retry that cannot start records its final outcome and original wait after reload', async t => {
  const page = await fixture(t, () => new Response(null, { status: 429 }));
  page.runtime.relay.policy.budgetMs = 1500;
  page.runtime.relay.policy.rateDelays = [900];
  const pending = page.runtime.relay.send(request(), { id: 'later-cooldown', attempt: 1 });
  while (!(await page.state()).upstreamHistory.errors.length) await new Promise(resolve => setTimeout(resolve, 10));
  await page.runtime.scheduler.cooldown(Date.now() + 5000);
  assert.equal((await pending).status, 429);
  await page.restart();
  const { errors } = (await page.state()).upstreamHistory;
  assert.equal(errors.length, 1);
  assert.deepEqual([errors[0].retryDelayMs, errors[0].actualRetryMs, errors[0].retrySkipped], [900, undefined, true]);
});

test('an HTML redirect is preserved without following or retrying it', async t => {
  let sends = 0;
  const page = await fixture(t, () => ++sends === 1 ? new Response(null, { status: 429 }) : new Response('<html>please retry later</html>', { status: 302, headers: { location: '/maintenance', 'content-type': 'text/html' } }));
  const result = await page.runtime.relay.send(request(), { id: 'html-redirect', attempt: 1 });
  assert.equal(result.status, 302); assert.equal(result.headers.get('location'), '/maintenance');
  assert.equal(sends, 2);
  assert.ok((await page.state()).upstreamHistory.errors.every(row => !row.recovered));
});

test('terminal SSE errors never deliver earlier tool events, even on repeated host callbacks', async t => {
  let code, sends = 0;
  const tool = { type: 'function_call', name: 'write', call_id: 'discard-call', arguments: '{}' };
  const frame = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
  const page = await fixture(t, () => {
    sends++;
    const body = frame({ type: 'response.output_text.delta', delta: 'discard-text' }) + frame({ type: 'response.output_item.done', item: tool })
      + frame({ type: 'response.failed', response: { id: 'resp_keep', status: 'failed', output: [tool], error: { code, message: 'request refused' } } }) + 'data: [DONE]\n\n';
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  for (code of [400, 401, 404]) {
    sends = 0;
    for (const attempt of [1, 2]) {
      const res = await page.runtime.relay.send(request(), { id: `client-error-${code}`, attempt });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /response\.failed/); assert.match(text, /resp_keep/); assert.match(text, new RegExp(`"code":${code}`));
      assert.doesNotMatch(text, /discard-call|discard-text|output_item\.done/);
    }
    assert.equal(sends, 1);
  }
});

test('exhausted embedded numeric rate limits retain 429 at the client boundary', async t => {
  const page = await fixture(t, () => Response.json({ error: { code: 429, message: '忙' } }));
  const response = await page.runtime.relay.send(request());
  assert.equal(response.status, 429);
  assert.deepEqual((await page.state()).upstreamHistory.errors.map(row => [row.status, row.errorCode]), [[200, '429']]);
});

test('HTML 429 uses the rate-limit schedule and a failed JSON 400 remains a request error', async t => {
  const replies = [() => new Response('<html>closed</html>', { status: 429, headers: { 'content-type': 'text/html' } }), ok,
    () => Response.json({ status: 'failed', error: { code: 400, message: 'bad parameters' } })];
  const page = await fixture(t, () => replies.shift()());
  page.runtime.relay.policy.rateDelays = [15];
  await page.runtime.relay.send(request(), { id: 'html-429', attempt: 1 });
  await page.runtime.relay.send(request(), { id: 'json-400', attempt: 1 });
  const { errors } = (await page.state()).upstreamHistory;
  assert.deepEqual(errors.map(row => [row.category, row.retryDelayMs]), [['other', null], ['rate', 15]]);
  assert.match(errors[0].message, /参数/);
});

test('an explicit upstream rate limit wins over a generic 400 wrapper, not over a quota refusal', async t => {
  const note = 'exceeded retry limit, last status: 429';
  const replies = [() => Response.json({ error: { code: 400, message: note } }), ok,
    () => Response.json({ error: { code: 400, type: 'insufficient_quota', message: note } })];
  const page = await fixture(t, () => replies.shift()());
  page.runtime.relay.policy.rateDelays = [25];
  await page.runtime.relay.send(request(), { id: 'limited', attempt: 1 });
  await page.runtime.relay.send(request(), { id: 'quota', attempt: 1 });
  const { errors } = (await page.state()).upstreamHistory;
  assert.deepEqual(errors.map(row => [row.errorCode, row.retryDelayMs, row.recovered]), [['400', null, false], ['400', 25, true]]);
});

test('an incomplete response keeps valid events but does not deliver corrupt SSE data or retry', async t => {
  let sends = 0;
  const valid = 'data: {"type":"response.output_text.delta","delta":"partial"}\n\nevent: response.incomplete\ndata: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n';
  const page = await fixture(t, () => { sends++; return new Response('data: {broken\n\n' + valid, { headers: { 'content-type': 'text/event-stream' } }); });
  const res = await page.runtime.relay.send(request(), { id: 'limited-output', attempt: 1 });
  assert.equal(await res.text(), valid); assert.equal(sends, 1);
  assert.equal((await page.state()).recent[0].phase, '未完成');
});
