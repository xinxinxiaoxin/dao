const statuses = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);
const rate = /concurrency limit|exceeded retry limit,?\s*last status:\s*429|too many requests|rate[_\s-]*limit(?:ed|_exceeded)?|too_many_requests/i;
const transient = /please retry later/i;
const terminalCodes = new Set(['context_length_exceeded', 'invalid_api_key', 'authentication_error', 'permission_denied', 'model_not_found', 'unsupported_parameter', 'insufficient_quota', 'insufficient_balance', 'billing_hard_limit_reached']);

function errorIn(value) {
  if (!value || typeof value !== 'object') return null;
  return value.error || value.response?.error || (value.type === 'error' ? value : null);
}

export function classify(status, contentType, bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  if (/text\/html/i.test(contentType) || /^\s*(?:<!doctype html|<html\b)/i.test(text)) return { retry: true, rate: false, signIn: 'kept', reason: '站点暂时不可用或尚未开放' };
  const sse = /text\/event-stream/i.test(contentType) || /^\s*(?:event:|data:)/.test(text);
  const errors = [];
  let terminal = false;
  if (sse) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
      if (data === '[DONE]') { terminal = true; continue; }
      try {
        const value = JSON.parse(data);
        const err = errorIn(value);
        if (err) errors.push(err);
        if (['response.completed', 'response.incomplete', 'message_stop'].includes(value.type)) terminal = true;
        if (value.choices?.some(x => ['stop', 'length', 'tool_calls', 'function_call', 'content_filter'].includes(x.finish_reason))) terminal = true;
      } catch { /* SSE comments and non-JSON data do not carry a response error. */ }
    }
  } else {
    try { const error = errorIn(JSON.parse(text)); if (error) errors.push(error); } catch { /* Plain HTTP errors are classified by their status and text. */ }
  }
  const words = errors.length ? errors.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n') : (status >= 400 || /text\/plain/i.test(contentType) ? text : '');
  const codes = errors.flatMap(e => typeof e === 'object' ? [e.code, e.type] : []);
  const explicitTerminal = [401, 403].includes(status) || codes.some(code => terminalCodes.has(code)) || /\bcontext_length_exceeded\b/.test(words);
  if (explicitTerminal) return { retry: false, terminal: true, reason: codes.find(x => terminalCodes.has(x)) || `HTTP ${status}` };
  const limited = status === 429 || rate.test(words);
  if (statuses.has(status) || rate.test(words) || transient.test(words)) return { retry: true, rate: limited, reason: limited ? '限流' : `HTTP ${status} 临时失败` };
  if (errors.length && !sse) return { retry: false, terminal: true, reason: codes[0] || '上游明确失败' };
  if (sse && !terminal) return { retry: true, rate: false, reason: '流未完整结束' };
  if (status >= 200 && status < 300 && !text.trim()) return { retry: true, rate: false, reason: '上游空回复' };
  return { retry: false, terminal: status >= 400, reason: '' };
}

export function retryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
