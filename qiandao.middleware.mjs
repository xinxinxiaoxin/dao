export function onRequest(body, ctx) {
  if (body && typeof body === 'object') ctx.state.qiandaoOriginal = body;
}

export function onProvider(body, ctx) {
  if (ctx.provider?.id !== 'qiandao-gateway' || !body || typeof body !== 'object') return;
  if (!ctx.state.qiandaoId) {
    ctx.state.qiandaoId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    ctx.state.qiandaoTry = 0;
  }
  return { ...body, client_metadata: { ...body.client_metadata, _qiandao_request: {
    id: ctx.state.qiandaoId, attempt: ++ctx.state.qiandaoTry,
    original: ctx.protocol === 'responses' ? ctx.state.qiandaoOriginal : undefined,
  } } };
}
