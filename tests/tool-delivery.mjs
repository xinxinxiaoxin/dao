import assert from 'node:assert/strict';

const parameter = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
const fn = name => ({ type: 'function', name, parameters: parameter });
const custom = name => ({ type: 'custom', name, format: { type: 'text' } });
const namespace = (name, ...tools) => ({ type: 'namespace', name, description: name, tools });
const search = { type: 'tool_search', execution: 'client', description: 'Find a tool', parameters: parameter };
const definitions = [fn('read_note'), custom('apply_patch'), namespace('desk', fn('lookup')), namespace('notes', fn('lookup')), search];
const inputText = 'a "quoted" word\n第二行: C:\\data';
const patch = '*** Begin Patch\n*** Add File: hello.txt\n+你好\n*** End Patch';
const call = (type, call_id, rest) => ({ id: `item_${call_id}`, type, call_id, status: 'completed', ...rest });
const plain = call('function_call', 'call_plain', { name: 'read_note', arguments: JSON.stringify({ text: inputText }) });
const freeform = call('custom_tool_call', 'call_patch', { name: 'apply_patch', input: patch });
const scoped = name => call('function_call', `call_${name}`, { namespace: name, name: 'lookup', arguments: JSON.stringify({ text: name }) });
const discovery = call('tool_search_call', 'call_lookup', { execution: 'client', arguments: { text: 'notes' } });
const message = (phase, text) => ({ type: 'message', id: `msg_${phase}`, role: 'assistant', status: 'completed', phase, content: [{ type: 'output_text', text, annotations: [] }] });
const progress = message('commentary', 'Reading a fixture.');
const answer = message('final_answer', 'Done.');
const web = { type: 'web_search_call', id: 'ws_one', status: 'completed', action: { type: 'search', query: 'fixture' } };

function clientItem(item) {
  const { type, name, namespace, call_id, arguments: args, input, phase } = item;
  if (type === 'message') return [type, phase, item.content.map(part => part.text ?? part.refusal).join('')];
  if (type === 'web_search_call') return [type, item.action?.type, item.action?.query ?? item.action?.queries?.[0]];
  return [type, namespace ?? '', name, call_id, type === 'function_call' ? JSON.parse(args) : args ?? input];
}

export function asOffered(output, tools) {
  const offered = name => tools.some(tool => tool.type === 'function' && tool.name === name);
  return output.map(item => {
    if (item.type === 'custom_tool_call' && offered(item.name)) {
      const { input, ...call } = item;
      return { ...call, type: 'function_call', arguments: JSON.stringify({ input }) };
    }
    if (item.type === 'function_call' && item.namespace && offered(`${item.namespace}__${item.name}`)) {
      const { namespace, ...call } = item;
      return { ...call, name: `${namespace}__${item.name}` };
    }
    if (item.type === 'tool_search_call' && item.execution === 'client' && offered('tool_search')) {
      const { execution, ...call } = item;
      return { ...call, type: 'function_call', name: 'tool_search', arguments: JSON.stringify(item.arguments) };
    }
    return item;
  });
}

export async function checkToolDelivery(post, setOutput, route = 'dao', compare = false) {
  const cases = [
    ['ordinary function', [plain]], ['freeform patch', [freeform]], ['namespaced function', [scoped('desk')]],
    ['parallel same-name tools', [scoped('desk'), scoped('notes')]],
    ['mixed calls after commentary', [progress, plain, freeform, discovery]],
    ['hosted web search with answer', [web, answer]], ['final answer', [answer]],
  ];
  const failures = [];
  for (const stream of [true, false]) for (const webSearch of [false, true]) for (const [name, output] of cases) {
    const label = `${name}, stream=${stream}, web=${webSearch}`;
    try {
      setOutput(output);
      const tools = webSearch || output.includes(web) ? [...definitions, { type: 'web_search' }] : definitions;
      const body = { input: [{ type: 'additional_tools', role: 'developer', tools }, { role: 'user', content: 'Tool delivery fixture.' }], stream };
      const response = await post(body);
      assert.equal(response.status, 200);
      if (!stream) {
        const result = await response.json();
        assert.deepEqual(result.output.map(clientItem), output.map(clientItem));
      } else {
        const events = (await response.text()).split(/\r?\n/).filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
        const done = events.filter(event => event.type === 'response.output_item.done').map(event => event.item);
        assert.deepEqual(done.map(clientItem), output.map(clientItem));
        assert.deepEqual(events.find(event => event.type === 'response.completed')?.response?.output?.map(clientItem), output.map(clientItem));
      }
    } catch (error) { failures.push(`${label}: ${error.message}`); }
  }
  if (compare) console.log(`${route}: ${cases.length * 4 - failures.length}/${cases.length * 4}; differences: ${failures.map(error => error.split(':')[0]).join('; ') || 'none'}`);
  else {
    assert.equal(failures.length, 0, failures.join('\n'));
    console.log(`PASS: ${route} preserves calls, arguments, namespaces, phases and order in ${cases.length * 4} cases`);
  }
}
