import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSettings } from '../lib/settings.mjs';
import { Scheduler } from '../lib/scheduler.mjs';
import { Relay } from '../lib/relay.mjs';

const { createGateway, loadConfig } = await import(pathToFileURL(resolve(process.argv[2] || 'docs/research/qiandao-source/gateway.mjs')).href);
const directory = await mkdtemp(join(tmpdir(), 'qiandao-parity-'));
const settings = await createSettings(directory);
const sse = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const done = sse({ type: 'response.completed', response: { id: 'fixture', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture OK' }] }] } });
let scenario, sent = [];
const upstream = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  sent.push({ body: Buffer.concat(chunks).toString(), tier: req.headers['x-fixture-tier'] });
  const count = sent.length;
  let status = 200, text = done, type = 'text/event-stream';
  if (scenario === '429' && count < 3) { status = 429; text = JSON.stringify({ error: { message: 'too many requests' } }); type = 'application/json'; }
  if (scenario === 'embedded' && count === 1) text = sse({ type: 'error', error: { code: 'rate_limit_exceeded', message: 'concurrency limit exceeded' } });
  if (scenario === 'cut' && count === 1) text = sse({ type: 'response.output_text.delta', delta: 'uncommitted' });
  if (scenario === 'empty' && count === 1) text = '';
  if (scenario === 'auth') { status = 401; type = 'application/json'; text = JSON.stringify({ error: { code: 'invalid_api_key', message: 'invalid key' } }); }
  res.writeHead(status, { 'content-type': type }); res.end(text);
});
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const upstreamPort = await listen(upstream);
const body = JSON.stringify({ model: 'gpt-6-astra', input: 'fixture', stream: true, service_tier: 'priority', reasoning: { effort: 'high' }, prompt_cache_key: 'stable' });
try {
  for (scenario of ['normal', '429', 'embedded', 'cut', 'empty', 'auth']) {
    sent = [];
    const gateway = createGateway({ ...loadConfig({}), upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`, maxAttempts: 3, retryBaseMs: 2, retryMaxMs: 2, rateLimitRetryDelaysMs: [2], totalBudgetMs: 5000 });
    const oldPort = await listen(gateway.server);
    let old;
    try {
      const response = await fetch(`http://127.0.0.1:${oldPort}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-tier': 'priority' }, body });
      old = { status: response.status, text: await response.text(), sent: [...sent] };
    } finally { gateway.server.closeAllConnections(); await new Promise(resolve => gateway.server.close(resolve)); }
    sent = [];
    const scheduler = new Scheduler(settings);
    await scheduler.transaction(state => { state.cooldownUntil = 0; });
    const relay = new Relay(scheduler, { policy: { maxAttempts: 3, budgetMs: 5000, rateDelays: [2], errorDelays: [2] } });
    const response = await relay.send(new Request(`http://127.0.0.1:${upstreamPort}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-tier': 'priority' }, body }), { id: scenario, attempt: 1 });
    assert.equal(response.status, old.status);
    assert.equal(await response.text(), old.text);
    assert.deepEqual(sent, old.sent);
    console.log(`PASS: old/new ${scenario}, ${sent.length} upstream sends, identical request and response bodies`);
  }
} finally {
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  assert.equal(dirname(await realpath(directory)), await realpath(tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
