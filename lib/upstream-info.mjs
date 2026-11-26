import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON } from './settings.mjs';

export async function readUpstreamJSON(baseURL, operation, auth, signal, fetchInfo = fetch) {
  const timeout = AbortSignal.timeout(8000);
  const response = await fetchInfo(`${baseURL}/${operation}`, {
    headers: { authorization: `Bearer ${auth.key}`, accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'manual',
  });
  if (!response.ok) throw new Error(`查询暂时不可用（HTTP ${response.status}），站点可能尚未开放；已有配置保持不变。`);
  if (/text\/html/i.test(response.headers.get('content-type') || '')) throw new Error('站点返回了网页，暂时无法查询；已有配置保持不变。');
  try { return await response.json(); }
  catch { throw new Error('站点未返回有效查询结果；已有配置保持不变。'); }
}

export class ModelCatalog {
  constructor(directory, fetchInfo = fetch) {
    this.directory = directory;
    this.fetch = fetchInfo;
    this.accounts = new Map();
  }

  async read(baseURL, auth, signal, account) {
    if (!baseURL || auth?.type !== 'api' || !auth.key) return { models: [], fallback: false };
    const identity = account || auth.key;
    const file = account ? join(this.directory, `models-${encodeURIComponent(account)}.json`) : null;
    let saved = this.accounts.get(identity);
    if (!saved && file) {
      try { saved = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const previous = saved?.baseURL === baseURL ? saved.models : [];
    try {
      const payload = await readUpstreamJSON(baseURL, 'models', auth, signal, this.fetch);
      if (!Array.isArray(payload.data)) throw new Error('模型接口未返回模型列表。');
      const models = [...new Set(payload.data.map(row => row?.id).filter(id => typeof id === 'string' && id.trim()))];
      if (!models.length) throw new Error('站点当前没有返回可用模型，保留上次成功的列表。');
      const next = { baseURL, models };
      this.accounts.set(identity, next);
      if (file) await atomicJSON(file, next);
      return { models, fallback: false };
    } catch (error) {
      signal?.throwIfAborted();
      return { models: previous, fallback: true, error: error.message };
    }
  }
}

const numeric = value => (typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isFinite(Number(value)) ? Number(value) : undefined;
const money = value => value === undefined ? undefined : `$${value.toFixed(2)}`;

export function usageInfo(data) {
  const result = { signIn: 'kept', windows: [] };
  if (typeof data?.planName === 'string') result.plan = data.planName;
  const wallet = numeric(data?.balance);
  const quota = numeric(data?.quota?.remaining);
  const remaining = numeric(data?.remaining);
  if (wallet !== undefined) result.balance = money(wallet);
  else if (quota !== undefined) result.balance = `Key 剩余额度 ${money(quota)}`;
  else if (data?.subscription && remaining !== undefined && remaining >= 0) result.balance = `套餐剩余额度 ${money(remaining)}`;
  else if (remaining !== undefined && remaining >= 0) result.balance = money(remaining);

  const window = (name, used, limit, extra = {}) => {
    const amount = numeric(used), cap = numeric(limit);
    if (amount === undefined || cap === undefined || cap <= 0) return;
    result.windows.push({ name, amount, limit: cap, unit: 'USD', display: `${money(amount)} / ${money(cap)}`, ...extra });
  };
  if (data?.quota) window('Key 总额度', data.quota.used, data.quota.limit);
  for (const rate of Array.isArray(data?.rate_limits) ? data.rate_limits : []) {
    const name = { '5h': '5 小时额度', '1d': '每日额度', '7d': '7 天额度' }[rate.window] || String(rate.window);
    window(name, rate.used, rate.limit, rate.reset_at ? { resetsAt: rate.reset_at } : {});
  }
  if (data?.subscription) {
    for (const [kind, name] of [['daily', '每日额度'], ['weekly', '每周额度'], ['monthly', '每月额度']]) window(name, data.subscription[`${kind}_usage_usd`], data.subscription[`${kind}_limit_usd`]);
  }
  const until = data?.expires_at || data?.subscription?.expires_at;
  if (until) result.until = until;
  for (const [kind, name] of [['today', '今日消耗'], ['total', '累计消耗']]) {
    const cost = numeric(data?.usage?.[kind]?.actual_cost);
    if (cost !== undefined) result.windows.push({ name, display: money(cost), aside: true });
  }
  if (!result.balance && !result.windows.length) throw new Error('余额接口没有返回有效余额或额度。');
  return result;
}

export async function readUsage(baseURL, auth, signal, fetchInfo = fetch) {
  if (!baseURL) return { balance: '未填写千刀地址', windows: [], signIn: 'kept' };
  if (auth?.type !== 'api' || !auth.key) return { balance: '未填写 API Key', windows: [], signIn: 'kept' };
  try {
    const data = await readUpstreamJSON(baseURL, 'usage', auth, signal, fetchInfo);
    return usageInfo(data);
  } catch (error) {
    signal?.throwIfAborted();
    return { balance: '暂时无法查询', error: /查询|余额|站点/.test(error.message) ? error.message : '余额查询暂时不可用，站点可能尚未开放。', windows: [], signIn: 'kept' };
  }
}
