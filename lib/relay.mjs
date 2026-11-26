import { classify, retryAfter } from './classify.mjs';
import { policy as defaults } from './settings.mjs';
import manifest from '../package.json' with { type: 'json' };

function capture(response, body) {
  const headers = new Headers(response.headers);
  for (const name of ['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive']) headers.delete(name);
  return { status: response.status, headers: [...headers], body };
}
const restore = result => new Response([204, 205, 304].includes(result.status) ? null : result.body, { status: result.status, headers: result.headers });
const localError = (status, code, message) => ({ status, headers: [['content-type', 'application/json']], body: Buffer.from(JSON.stringify({ error: { type: code, code, message } })) });

export class Relay {
  constructor(scheduler, { fetchUpstream = fetch, policy = {} } = {}) {
    this.scheduler = scheduler;
    this.fetch = fetchUpstream;
    this.policy = { ...defaults, ...policy };
    this.turns = new Map();
    this.recent = [];
  }

  async send(request, tag) {
    const now = Date.now();
    for (const [id, state] of this.turns) if (state.finished && state.expires <= now) this.turns.delete(id);
    const existing = tag && this.turns.get(tag.id);
    if (existing) return restore(await existing.promise);
    if (tag && tag.attempt !== 1) return restore(localError(409, 'qiandao_request_closed', '此请求的插件上下文已结束，未再次发送到千刀。'));
    const state = { id: tag?.id, started: now, deadline: now + this.policy.budgetMs, used: 0, finished: false, expires: Infinity, phase: '排队', reason: '' };
    if (tag) this.turns.set(tag.id, state);
    const run = this.run(request, state, tag ? this.policy.maxAttempts : 1);
    state.promise = run.catch(error => {
      if (request.signal.aborted) return localError(499, 'request_cancelled', '客户端已取消请求。');
      return localError(502, 'qiandao_gateway_error', error.message);
    });
    const result = await state.promise;
    state.finished = true;
    state.expires = Date.now() + 600000;
    state.phase = request.signal.aborted ? '已取消' : (result.status >= 400 || result.terminal ? '已失败' : '已完成');
    this.recent.unshift({ time: Date.now(), attempts: state.used, phase: state.phase, reason: state.reason, ms: Date.now() - state.started });
    this.recent.length = Math.min(this.recent.length, 20);
    if (result.status < 400 && !result.terminal) state.promise = Promise.resolve(localError(409, 'qiandao_request_delivered', '此请求已交付，未再次发送到千刀。'));
    return restore(result);
  }

  async run(request, state, maxAttempts) {
    const bytes = ['GET', 'HEAD'].includes(request.method) ? undefined : Buffer.from(await request.arrayBuffer());
    let last;
    let earlyRetryAfterUsed = false;
    while (state.used < maxAttempts && Date.now() < state.deadline) {
      request.signal.throwIfAborted();
      state.phase = '排队';
      const release = await this.scheduler.acquire(request.signal, state.deadline);
      if (!release) break;
      let assessment, record, after = 0;
      try {
        state.used++;
        state.phase = '上游执行';
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(this.policy.upstreamTimeoutMs)]);
        const response = await this.fetch(new Request(request.url, { method: request.method, headers: request.headers, body: bytes, signal, redirect: 'manual' }));
        const body = Buffer.from(await response.arrayBuffer());
        last = capture(response, body);
        assessment = classify(response.status, response.headers.get('content-type') || '', body);
        record = { time: Date.now(), version: manifest.version, pid: process.pid, requestId: state.id, attempt: state.used, status: response.status, retry: assessment.retry, reason: assessment.reason, response: assessment.response };
        state.reason = assessment.reason;
        if (!assessment.retry) {
          last.terminal = assessment.terminal;
          last.headers.push(['x-qiandao-attempts', String(state.used)]);
          return last;
        }
        after = retryAfter(response.headers.get('retry-after'));
      } catch (error) {
        request.signal.throwIfAborted();
        state.reason = error.name === 'TimeoutError' ? '上游超时' : '连接或响应读取中断';
        last = localError(502, 'upstream_connection_error', state.reason);
        assessment = { rate: false };
      } finally {
        try {
          if (assessment && !request.signal.aborted && assessment.retry !== false) {
            const delays = assessment.rate ? this.policy.rateDelays : this.policy.errorDelays;
            let wait = Math.max(delays[Math.min(state.used - 1, delays.length - 1)], after);
            if (after > 30000 && !earlyRetryAfterUsed && state.used < maxAttempts && Date.now() + 30000 < state.deadline) {
              wait = 30000;
              earlyRetryAfterUsed = true;
            }
            state.phase = '冷却等待';
            await this.scheduler.cooldown(Date.now() + wait);
          }
        } finally { await release(record); }
      }
    }
    const status = last?.status === 429 ? 429 : Date.now() >= state.deadline ? 504 : 502;
    const out = localError(status, 'upstream_unavailable', `千刀请求在 ${state.used} 次尝试后未恢复：${state.reason || '等待名额超过期限'}。`);
    out.headers.push(['x-qiandao-attempts', String(state.used)]);
    out.headers.push(['x-magpie-sign-in', 'kept']);
    const remaining = (await this.scheduler.snapshot()).cooldownUntil - Date.now();
    if (remaining > 0) out.headers.push(['retry-after', String(Math.ceil(remaining / 1000))]);
    return out;
  }
}
