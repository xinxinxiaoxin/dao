import { createInterface } from 'node:readline';

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result = {};
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  if (request.method === 'tools/list') result = { tools: [{ name: 'fixture_lookup', description: 'Look up a local fixture label', annotations: { readOnlyHint: true, openWorldHint: false }, inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] } }] };
  if (request.method === 'tools/call') {
    const label = request.params.arguments?.label;
    const valid = request.params.name === 'fixture_lookup' && ['left', 'right'].includes(label);
    result = { isError: !valid, content: [{ type: 'text', text: valid ? `DAO_FIXTURE_${label}` : 'Unknown fixture call' }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
