import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const defaults = { baseURL: '', maxConcurrency: 5, models: ['gpt-6-astra'] };
export const policy = { maxAttempts: 7, budgetMs: 300000, upstreamTimeoutMs: 900000, rateDelays: [3000, 6000, 10000, 20000, 40000, 60000], errorDelays: [750, 1500, 3000, 3000, 3000, 3000] };

export function normalizeBase(value) {
  if (!value?.trim()) return '';
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL 应为不含账号、查询参数或片段的 HTTP(S) 地址。');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
  return url.toString().replace(/\/+$/, '');
}

export function validateSettings(input) {
  const baseURL = normalizeBase(input.baseURL);
  const maxConcurrency = Number(input.maxConcurrency);
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('总并发必须是大于零的整数。');
  const models = [...new Set((Array.isArray(input.models) ? input.models : String(input.models ?? '').split(/\r?\n/)).map(x => String(x).trim()).filter(Boolean))];
  if (!models.length) throw new Error('请至少填写一个模型名。');
  return { baseURL, maxConcurrency, models };
}

export async function atomicJSON(file, value) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}

export async function createSettings(directory) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'settings.json');
  try { await writeFile(file, JSON.stringify(defaults), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return {
    directory, file,
    async read() { return validateSettings(JSON.parse(await readFile(file, 'utf8'))); },
    async save(value) { const next = validateSettings(value); await atomicJSON(file, next); return next; },
  };
}
