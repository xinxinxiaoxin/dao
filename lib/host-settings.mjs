import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON } from './settings.mjs';

export const providerId = 'qiandao-gateway';
const headers = ['User-Agent', 'originator', 'session-id', 'thread-id', 'x-codex-turn-metadata', 'x-codex-turn-state', 'x-codex-beta-features'];

export async function configureProvider(directory) {
  const file = join(directory, 'providers.json');
  let raw = null;
  try { raw = await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const data = raw ? JSON.parse(raw) : {};
  data.providers ??= [];
  let provider = data.providers.find(x => x.id === providerId);
  if (!provider) { provider = { id: providerId, maxConcurrency: 0 }; data.providers.push(provider); }
  provider.passHeaders = [...new Set([...(provider.passHeaders || []), ...headers])];
  provider.limitRestOff = true;
  provider.patience = -1;
  const next = JSON.stringify(data, null, 2) + '\n';
  if (raw === next) return;
  let current = null;
  try { current = await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (current !== raw) throw new Error('供应商配置正在保存，请稍后重新加载千刀插件。');
  await atomicJSON(file, data);
}

export async function manualModels(directory) {
  try {
    const data = JSON.parse(await readFile(join(directory, 'providers.json'), 'utf8'));
    const provider = data.providers?.find(x => x.id === providerId);
    return (provider?.models || []).filter(x => typeof x === 'string');
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
