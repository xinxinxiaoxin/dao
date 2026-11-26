import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/classify.mjs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRuntime } from '../lib/provider.mjs';
const event = x => `event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`;

test('completed Responses without any output are recoverable, not successful answers', () => {
  const response = { id: 'resp_empty', status: 'completed', output: [], usage: { output_tokens: 34 } };
  assert.equal(classify(200, 'text/event-stream', event({ type: 'response.created', response: { ...response, status: 'in_progress' } }) + event({ type: 'response.completed', response })).retry, true);
  assert.equal(classify(200, 'application/json', JSON.stringify(response)).retry, true);
});

test('Responses that carry only reasoning or a progress update cannot end a tool task', () => {
  for (const output of [
    [{ type: 'reasoning', summary: [], encrypted_content: 'fixture' }],
    [{ type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'I will inspect the files.' }] }],
  ]) assert.equal(classify(200, 'text/event-stream', event({ type: 'response.completed', response: { status: 'completed', output } })).retry, true);
});

test('tool calls, refusals, final answers and explicit incomplete responses stay deliverable', () => {
  const message = { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'I will check.' }] };
  for (const item of [
    { type: 'function_call', call_id: 'call_one', name: 'read', arguments: '{}' },
    { type: 'custom_tool_call', call_id: 'call_two', name: 'exec', input: 'text(1)' },
    { ...message, phase: 'final_answer' },
    { ...message, phase: undefined },
    { ...message, content: [{ type: 'refusal', refusal: 'I cannot help.' }] },
  ]) {
    assert.equal(classify(200, 'text/event-stream', event({ type: 'response.completed', response: { status: 'completed', output: [message, item] } })).retry, false);
    assert.equal(classify(200, 'text/event-stream', event({ type: 'response.output_item.done', item }) + event({ type: 'response.completed', response: { status: 'completed', output: [] } })).retry, false);
  }
  assert.equal(classify(200, 'text/event-stream', event({ type: 'response.incomplete', response: { output: [], incomplete_details: { reason: 'max_output_tokens' } } })).retry, false);
});

test('empty completion recovery shares seven attempts and preserves the tool-result request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dao-output-'));
  t.after(async () => { assert.equal(dirname(await realpath(directory)), await realpath(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  let calls = 0, alwaysEmpty = false;
  const bodies = [];
  const output = [{ type: 'custom_tool_call', id: 'ctc_ok', call_id: 'call_next', name: 'exec', input: 'text(364)', status: 'completed' }];
  const good = event({ type: 'response.completed', response: { id: 'resp_ok', output } });
  const runtime = await createRuntime(directory, { policy: { budgetMs: 3000, rateDelays: [1], errorDelays: [1] }, fetchUpstream: async req => {
    bodies.push(await req.text()); calls++;
    return new Response(alwaysEmpty || calls === 1 ? event({ type: 'response.completed', response: { output: [] } }) : good, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const body = JSON.stringify({ model: 'gpt-6-astra', service_tier: 'priority', input: [{ type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking.' }] }, { type: 'custom_tool_call_output', call_id: 'call_previous', output: '323' }] });
  const request = () => new Request('https://example.invalid/v1/responses', { method: 'POST', body });
  assert.equal(await (await runtime.relay.send(request(), { id: 'recover', attempt: 1 })).text(), good);
  assert.equal(calls, 2); assert.ok(bodies.every(x => x === body));
  alwaysEmpty = true; calls = 0;
  const failed = await runtime.relay.send(request(), { id: 'exhaust', attempt: 1 });
  assert.equal(failed.status, 502); assert.equal(calls, 7);
  await runtime.relay.send(request(), { id: 'exhaust', attempt: 2 });
  assert.equal(calls, 7);
});
