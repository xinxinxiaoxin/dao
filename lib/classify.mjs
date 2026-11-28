const statuses = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);
const rate = /\b(?:concurrency limit|too many requests|rate\s+limit(?:ed|\s+exceeded)?)\b/i;
const rateCode = /^(?:rate[_-]*limit(?:ed|[_-](?:exceeded|error))?|too_many_requests)$/i;
const messageCode = /^(?:error:\s*)?([\w-]+)(?:\s|:|$)/i;
const wrappedRate = /exceeded retry limit,?\s*last status:\s*(429)\b/i;
const transient = /please retry later/i;
const terminalCodes = new Set(['context_length_exceeded', 'invalid_api_key', 'authentication_error', 'permission_denied', 'model_not_found', 'unsupported_parameter', 'insufficient_quota', 'insufficient_balance', 'billing_hard_limit_reached']);

function errorIn(value) {
  if (!value || typeof value !== 'object') return null;
  return value.error || value.response?.error || (value.type === 'error' ? value : null);
}

function withoutOutput(value) {
  return Array.isArray(value?.output) && value.output.length ? { ...value, output: [] } : value;
}

function clientCall(item) {
  return item?.type === 'function_call' || item?.type === 'custom_tool_call' || (item?.type === 'tool_search_call' && item.execution === 'client');
}

function deliverable(item) {
  if (!item || typeof item.type !== 'string') return false;
  if (['reasoning', 'tool_search_output', 'web_search_call'].includes(item.type)) return false;
  if (item.type === 'tool_search_call') return item.execution === 'client' && typeof item.call_id === 'string' && !!item.call_id && !!item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments);
  if (item.type === 'function_call') return !!(item.call_id && item.name && typeof item.arguments === 'string');
  if (item.type === 'custom_tool_call') return !!(item.call_id && item.name && typeof item.input === 'string');
  if (item.type !== 'message') return true;
  return item.content?.some(part => (part.type === 'refusal' && part.refusal?.trim()) || (item.phase !== 'commentary' && part.type === 'output_text' && part.text?.trim()));
}

export function classify(status, contentType, bytes, expectsAnswer = true) {
  if (status >= 300 && status < 400) return { retry: false, terminal: true, reason: '上游重定向' };
  const text = Buffer.from(bytes).toString('utf8');
  if (/text\/html/i.test(contentType) || /^\s*(?:<!doctype html|<html\b)/i.test(text)) return { retry: true, rate: status === 429, signIn: 'kept', reason: status === 429 ? '限流' : '站点暂时不可用或尚未开放' };
  const sse = /text\/event-stream/i.test(contentType) || /^\s*(?:event:|data:)/.test(text);
  const errors = [];
  let terminal = false;
  let completed = false;
  let incomplete = false;
  let failed = false;
  let validJSON = false;
  let malformedBlocks;
  const blocks = sse ? text.split(/\r?\n\r?\n/) : [];
  let errorBody;
  let completedOutput;
  const doneItems = [];
  const summary = { endEvent: '', status: '', aggregateOutput: 'missing', itemTypes: [] };
  if (sse) {
    for (const block of blocks) {
      const data = block.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
      if (!data.trim()) continue;
      if (data === '[DONE]') { terminal = true; continue; }
      try {
        const value = JSON.parse(data);
        const type = value.type || block.split(/\r?\n/).find(x => x.startsWith('event:'))?.slice(6).trim();
        const err = errorIn(value) || (type === 'error' ? value : null);
        if (err) errors.push(err);
        if (err || type === 'response.failed') {
          const response = withoutOutput(value.response);
          const clean = response !== value.response ? { ...value, response } : withoutOutput(value);
          errorBody = clean !== value ? `event: ${type || 'error'}\ndata: ${JSON.stringify(clean)}\n\n` : (block.trim() === text.trim() ? undefined : `${block}\n\n`);
        }
        if (type === 'response.output_item.done' && !terminal && value.item) doneItems.push(value.item);
        if (['response.completed', 'response.incomplete', 'response.failed'].includes(type)) {
          summary.endEvent = type;
          summary.status = value.response?.status || '';
          summary.id = value.response?.id;
          summary.aggregateOutput = Array.isArray(value.response?.output) ? value.response.output.map(x => x?.type || 'unknown') : 'missing';
        }
        if (type === 'response.completed' && !terminal) { completed = true; completedOutput = value.response?.output; }
        if (type === 'response.incomplete' || (completed && value.response?.status === 'incomplete')) incomplete = true;
        if (type === 'response.failed' || type === 'error') failed = true;
        if (completed || incomplete || failed) terminal = true;
      } catch { (malformedBlocks ??= new Set()).add(block); }
    }
  } else {
    try {
      const value = JSON.parse(text);
      validJSON = value !== null && typeof value === 'object' && !Array.isArray(value);
      const error = errorIn(value); if (error) errors.push(error);
      if (error) {
        const clean = withoutOutput(value);
        if (clean !== value) errorBody = JSON.stringify(clean);
      }
      failed = value.status === 'failed';
      incomplete = value.status === 'incomplete';
      if (value.status === 'completed' || (!value.status && Array.isArray(value.output))) {
        completed = true;
        completedOutput = Array.isArray(value.output) ? value.output : [];
      }
      summary.id = value.id;
      summary.status = value.status || '';
      summary.aggregateOutput = Array.isArray(value.output) ? value.output.map(x => x?.type || 'unknown') : 'missing';
    } catch { /* Plain HTTP errors are classified by their status and text. */ }
  }
  summary.itemTypes = doneItems.map(x => ({ type: x.type || 'unknown', ...(x.phase ? { phase: x.phase } : {}) }));
  const words = errors.length ? errors.map(error => typeof error === 'string' ? error : error.message || '').join('\n') : (status >= 400 || /text\/plain/i.test(contentType) ? text : '');
  const codes = errors.flatMap(e => typeof e === 'object' ? [e.code, e.type] : []);
  const errorCode = codes.find(code => (typeof code === 'string' || typeof code === 'number') && /^\d{1,6}$/.test(code))
    ?? wrappedRate.exec(words)?.[1];
  const finish = result => ({ ...result, response: summary, errorCode: errorCode === undefined ? undefined : String(errorCode), ...(result.terminal && errorBody !== undefined ? { deliveryBody: errorBody } : {}) });
  const terminalCode = codes.find(code => terminalCodes.has(code)) || (/\bcontext_length_exceeded\b/.test(words) && 'context_length_exceeded');
  const authStatus = [401, 403].includes(status) ? status : Number(errorCode);
  if (terminalCode || [401, 403].includes(authStatus)) return finish({ retry: false, terminal: true, reason: terminalCode || (authStatus === 401 ? 'invalid_api_key' : 'permission_denied') });
  const embeddedStatus = Number(errorCode);
  const limited = status === 429 || embeddedStatus === 429 || wrappedRate.test(words) || codes.some(code => rateCode.test(code)) || rate.test(words) || rateCode.test(messageCode.exec(words.trim())?.[1]);
  if (limited) return finish({ retry: true, rate: true, reason: '限流' });
  if (statuses.has(status) || statuses.has(embeddedStatus) || transient.test(words) || codes.includes('server_error')) return finish({ retry: true, rate: false, reason: '上游服务报错' });
  if ((embeddedStatus >= 400 && embeddedStatus < 500) || (status >= 400 && status < 500) || codes.includes('invalid_request_error')) return finish({ retry: false, terminal: true, reason: '上游拒绝请求' });
  if (failed && sse) return finish({ retry: true, rate: false, reason: '上游服务报错' });
  if (errors.length && !sse) return finish({ retry: false, terminal: true, reason: codes[0] || '上游明确失败' });
  if (status >= 400) return finish({ retry: false, terminal: true, reason: '' });
  if (incomplete) return finish({ retry: false, incomplete: true, singleDelivery: true, reason: '响应未完成', ...(malformedBlocks ? { deliveryBody: blocks.filter(block => !malformedBlocks.has(block)).join('\n\n') } : {}) });
  if (!text.trim()) return finish({ retry: true, rate: false, reason: '上游空回复' });
  if (malformedBlocks) return finish({ retry: true, rate: false, reason: '响应格式无效' });
  if (sse && !completed) return finish({ retry: true, rate: false, reason: '流未完整结束' });
  if (!sse && !validJSON) return finish({ retry: true, rate: false, reason: '响应格式无效' });
  // Codex consumes output_item.done; the completed aggregate alone cannot deliver a tool call.
  if (expectsAnswer && (!completed || !(sse ? doneItems : completedOutput).some(deliverable))) return finish({ retry: true, rate: false, reason: '响应已结束但没有有效答案或工具调用' });
  if (sse && Array.isArray(completedOutput)) {
    const delivered = new Set(doneItems.filter(item => clientCall(item) && deliverable(item)).map(item => item.call_id));
    if (completedOutput.some(item => clientCall(item) && !delivered.has(item.call_id))) return finish({ retry: true, rate: false, reason: '有工具调用没有完整交付' });
  }
  if (failed || errors.length) return finish({ retry: false, terminal: true, reason: '上游明确失败' });
  const singleDelivery = expectsAnswer && (sse ? doneItems : completedOutput).some(item => !['message', 'reasoning'].includes(item?.type));
  return finish({ retry: false, terminal: false, singleDelivery, reason: '' });
}

export function retryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
