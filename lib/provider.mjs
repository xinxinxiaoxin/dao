import { join } from 'node:path';
import { createSettings } from './settings.mjs';
import { Scheduler } from './scheduler.mjs';
import { Relay } from './relay.mjs';
import { startPage } from './page-service.mjs';
import { configureProvider, manualModels, keepModelSelections, providerId } from './host-settings.mjs';
import { ModelCatalog, readUsage } from './upstream-info.mjs';

const base = 'https://qiandao.invalid/v1';
const operations = new Set(['responses', 'responses/compact', 'responses/input_tokens', 'models']);
const fail = (status, code, message) => Response.json({ error: { type: code, code, message } }, { status });

export async function createRuntime(directory, options = {}) {
  const settings = await createSettings(join(directory, 'qiandao-gateway'));
  const scheduler = new Scheduler(settings);
  return { settings, scheduler, relay: new Relay(scheduler, options) };
}

export function createProvider(overrides = {}) {
  return async function qiandao(input = {}, options = {}) {
    if (!input.directory) throw new Error('千刀网关需要 Magpie 插件目录。');
    const runtime = await createRuntime(input.directory, overrides);
    const catalog = new ModelCatalog(runtime.settings.directory, overrides.metadataFetch);
    const listModels = async (provider, { auth, signal } = {}) => {
      const settings = await runtime.settings.read();
      const remote = await catalog.read(settings.baseURL, auth, signal, input.magpie?.account?.(providerId));
      const names = new Set([...remote.models, ...settings.models, ...await manualModels(input.directory), ...Object.keys(provider.models || {})]);
      if (!remote.fallback) await keepModelSelections(input.directory, names);
      const list = Object.fromEntries([...names].map(id => {
        const existing = provider.models?.[id] || {};
        return [id, { ...existing, id, name: existing.name || id, api: { ...existing.api, id: existing.api?.id || id, npm: '@ai-sdk/openai', url: base }, capabilities: { reasoning: true, ...existing.capabilities }, serviceTiers: ['priority'] }];
      }));
      if (remote.fallback) list[Symbol.for('magpie.fellBack')] = true;
      return list;
    };
    if (input.magpie) await configureProvider(input.directory);
    let pageServer;
    let pageStarting;
    let pageError;
    const ensurePage = async () => {
      if (pageServer?.listening) return;
      pageStarting ??= startPage(runtime, options.settingsPort ?? 38418).then(server => { pageServer = server; }).finally(() => { pageStarting = null; });
      await pageStarting;
    };
    const reportPageError = error => {
      if (pageError !== error.message) console.warn(`dao 设置页：${error.message} 模型请求仍可使用；可在插件选项中修改 settingsPort。`);
      pageError = error.message;
    };
    if (!overrides.noPage) {
      await ensurePage().catch(reportPageError);
      const timer = setInterval(() => { ensurePage().then(() => { pageError = undefined; }).catch(reportPageError); }, 2000);
      timer.unref();
    }
    return {
      config: async config => {
        config.provider ??= {};
        config.provider[providerId] ??= { name: 'dao', api: base, npm: '@ai-sdk/openai', models: {} };
      },
      provider: {
        id: providerId,
        models: listModels,
      },
      auth: {
        provider: providerId,
        methods: [{ type: 'api', label: 'dao API Key' }],
        async usage(getAuth, _provider, options) {
          const settings = await runtime.settings.read();
          return readUsage(settings.baseURL, await getAuth(), options?.signal, overrides.metadataFetch);
        },
        async loader(getAuth) {
          return { baseURL: base, async fetch(source, init) {
            const incoming = new Request(source, init);
            const parsed = new URL(incoming.url);
            const operation = parsed.pathname.replace(/^\/v1\//, '');
            if (!operations.has(operation)) return fail(400, 'unsupported_endpoint', '千刀网关支持 Responses 接口。');
            const settings = await runtime.settings.read();
            if (operation === 'models') {
              const list = await listModels({ models: {} }, { auth: await getAuth(), signal: incoming.signal });
              return Response.json({ object: 'list', data: Object.keys(list).map(id => ({ id, object: 'model', owned_by: 'qiandao' })) });
            }
            if (!settings.baseURL) return fail(400, 'qiandao_not_configured', '请在 dao 设置页填写千刀 Base URL。');
            const auth = await getAuth();
            if (auth?.type !== 'api' || !auth.key?.trim()) return fail(401, 'invalid_api_key', '请在 dao 供应商中填写 API Key。');
            incoming.signal.throwIfAborted();
            let bytes = ['GET', 'HEAD'].includes(incoming.method) ? undefined : Buffer.from(await incoming.arrayBuffer());
            let tag;
            if (bytes?.length) {
              let body;
              try { body = JSON.parse(bytes.toString()); } catch { return fail(400, 'invalid_request_error', '请求体必须是 JSON。'); }
              tag = body.client_metadata?._qiandao_request;
              if (tag) {
                delete body.client_metadata._qiandao_request;
                if (!Object.keys(body.client_metadata).length) delete body.client_metadata;
              }
              if (tag && (typeof tag.id !== 'string' || !Number.isSafeInteger(tag.attempt) || tag.attempt < 1)) tag = undefined;
              if (tag?.original && typeof tag.original === 'object') {
                const original = { ...tag.original, model: body.model };
                if (original.client_metadata?._qiandao_request) delete original.client_metadata._qiandao_request;
                if (body.service_tier !== undefined) original.service_tier = body.service_tier;
                if (body.reasoning?.effort !== undefined) original.reasoning = { ...original.reasoning, effort: body.reasoning.effort };
                body = original;
              }
              bytes = Buffer.from(JSON.stringify(body));
            }
            const headers = new Headers(incoming.headers);
            for (const name of [...headers.keys()]) if (name.startsWith('x-magpie-') || ['host', 'content-length', 'connection', 'cookie', 'proxy-authorization', 'x-api-key', 'api-key'].includes(name)) headers.delete(name);
            headers.set('authorization', `Bearer ${auth.key.trim()}`);
            const target = `${settings.baseURL}/${operation}${parsed.search}`;
            const request = new Request(target, { method: incoming.method, headers, body: bytes, signal: incoming.signal, redirect: 'manual' });
            return runtime.relay.send(request, tag);
          } };
        },
      },
    };
  };
}
