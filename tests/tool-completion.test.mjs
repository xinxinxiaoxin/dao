import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/classify.mjs';

const plain = { type: 'function_call', name: 'lookup', call_id: 'call_a', arguments: '{}' };
const patch = { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_b', input: 'patch fixture' };
const hosted = { type: 'web_search_call', id: 'ws_fixture', status: 'completed', action: { type: 'search', query: 'fixture' } };
const final = { type: 'message', phase: 'final_answer', role: 'assistant', content: [{ type: 'output_text', text: 'Found it.' }] };

function completed(delivered, output) {
  const events = [...delivered.map(item => ({ type: 'response.output_item.done', item })), { type: 'response.completed', response: { status: 'completed', output } }];
  return classify(200, 'text/event-stream', events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

test('a second parallel tool listed only in the summary cannot be silently dropped', () => {
  assert.equal(completed([plain], [plain, patch]).retry, true);
  assert.equal(completed([plain, patch], [plain, patch]).retry, false);
  assert.equal(completed([plain, patch], undefined).retry, false);
});

test('a hosted web search without any final answer or client action cannot end the turn', () => {
  assert.equal(completed([hosted], [hosted]).retry, true);
  assert.equal(completed([hosted, final], [hosted, final]).retry, false);
  assert.equal(completed([hosted, plain], [hosted, plain]).retry, false);
});

test('client tool discovery requires an executable call while hosted discovery can accompany an answer', () => {
  const search = { type: 'tool_search_call', execution: 'client', call_id: 'call_find', arguments: { query: 'lookup' } };
  const server = { ...search, execution: 'server', call_id: null };
  const serverResult = { type: 'tool_search_output', execution: 'server', tools: [] };
  for (const output of [[server, serverResult], [{ ...search, arguments: null }], [{ ...search, call_id: '' }]]) {
    assert.equal(completed(output, output).retry, true);
    assert.equal(classify(200, 'application/json', JSON.stringify({ status: 'completed', output })).retry, true);
  }
  for (const output of [[search], [server, serverResult, final]]) assert.equal(completed(output, output).retry, false);
});
