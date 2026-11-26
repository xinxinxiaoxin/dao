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
  const before = JSON.stringify(data);
  data.providers ??= [];
  let provider = data.providers.find(x => x.id === providerId);
  if (!provider) { provider = { id: providerId, maxConcurrency: 0 }; data.providers.push(provider); }
  const present = new Set((provider.passHeaders || []).map(name => name.toLowerCase()));
  provider.passHeaders = [...(provider.passHeaders || []), ...headers.filter(name => !present.has(name.toLowerCase()))];
  provider.limitRestOff = true;
  provider.patience = -1;
  if (JSON.stringify(data) === before) return;
  let current = null;
  try { current = await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (current !== raw) throw new Error('供应商配置正在保存，请稍后重新加载千刀插件。');
  await atomicJSON(file, data);
}

export async function manualModels(directory) {
  const file = join(directory, providerId, 'manual-models.json');
  let previous = [];
  try { previous = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  try {
    const data = JSON.parse(await readFile(join(directory, 'providers.json'), 'utf8'));
    const provider = data.providers?.find(x => x.id === providerId);
    const listed = new Set(provider?.pickedFrom || []);
    // Once offered by this hook, typed IDs also enter Magpie's pickedFrom list.
    const models = (provider?.models || []).filter(x => typeof x === 'string' && (!listed.has(x) || previous.includes(x)));
    if (JSON.stringify(models) !== JSON.stringify(previous)) await atomicJSON(file, models);
    return models;
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

export async function keepModelSelections(directory, candidates) {
  const file = join(directory, 'providers.json');
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  const data = JSON.parse(raw);
  const provider = data.providers?.find(x => x.id === providerId);
  if (!provider?.models?.length || provider.noModels) return;
  // Magpie auto-includes newly listed IDs when all previously listed IDs were picked.
  const listed = [...new Set([...(provider.pickedFrom || []), ...candidates])];
  if (JSON.stringify(listed) === JSON.stringify(provider.pickedFrom)) return;
  provider.pickedFrom = listed;
  if (await readFile(file, 'utf8') !== raw) throw new Error('供应商配置正在保存，请重新获取模型。');
  await atomicJSON(file, data);
}
