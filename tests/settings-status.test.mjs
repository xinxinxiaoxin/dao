import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { setImmediate as tick } from 'node:timers/promises';

test('the open error tab keeps old rows, marks a disconnected service and resumes live updates', async () => {
  const html = await readFile(new URL('../ui/settings.html', import.meta.url), 'utf8');
  const nodes = new Map(), timers = new Map();
  function element() {
    return { children: [], textContent: '', hidden: false, queries: new Map(),
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      querySelector(selector) { if (!this.queries.has(selector)) this.queries.set(selector, element()); return this.queries.get(selector); },
      querySelectorAll() { return []; },
    };
  }
  for (const match of html.matchAll(/<[^<>]*\bid="([\w-]+)"[^<>]*>/g)) nodes.set(match[1], { ...element(), hidden: /\bhidden\b/.test(match[0]) });
  const get = id => nodes.get(id);
  const tabs = ['connectionTab', 'errorsTab'].map((id, index) => Object.assign(get(id), {
    setAttribute() {}, getAttribute: () => index ? 'errorsPanel' : 'connectionPanel',
  }));
  get('viewTabs').querySelectorAll = () => tabs;
  const row = { time: 1000, status: 429, attempt: 1, category: 'rate', message: '限流', retryDelayMs: 3000, retrySkipped: true };
  let online = true;
  const state = { settings: { models: [], maxConcurrency: 1 }, scheduler: { active: 1, queued: 0, cooldownUntil: Date.now() + 90000 }, recent: [],
    upstreamHistory: { attempts: 1, errors: [row], limit: 100 }, retryPolicy: { maxAttempts: 7, rateDelays: [3000], errorDelays: [750] } };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], { document: { getElementById: get, createElement: element },
    URL, location: { href: 'http://127.0.0.1/' }, AbortSignal, setInterval: (fn, ms) => timers.set(ms, fn),
    fetch: async () => { if (!online) throw new Error('offline'); return { ok: true, json: async () => state }; },
  });
  await tick();
  get('errorsTab').onclick();
  assert.equal(get('errorsPanel').hidden, false);
  const timing = get('upstreamErrors').querySelector('tbody').children[0].children.at(-1);
  assert.match(timing.textContent, /实际未重试/);
  assert.match(timing.children[0].textContent, /最早 3 秒/);
  const previous = get('upstreamSummary').textContent;
  online = false; await timers.get(2000)();
  assert.equal(get('upstreamSummary').textContent, previous);
  assert.equal(get('connectionWarning').hidden, false);
  assert.match(get('connectionWarning').textContent, /上次/);
  timers.get(1000)(); assert.equal(get('logCooldown').textContent, '未知');
  online = true; await timers.get(2000)();
  assert.equal(get('connectionWarning').hidden, true);
  assert.match(get('logCooldown').textContent, /秒/);
});
