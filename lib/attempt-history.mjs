export const attemptHistoryLimit = 100;

const reasons = new Map([
  ['限流', '请求太多，千刀限流了'],
  ['站点暂时不可用或尚未开放', '千刀入口暂时关闭或打不开'],
  ['上游空回复', '千刀没返回任何内容'],
  ['上游重定向', '千刀返回了跳转地址，没有交付回复'],
  ['响应未完成', '千刀明确结束了生成，但回答没有完成'],
  ['响应格式无效', '千刀返回的不是完整有效的 JSON 回复'],
  ['上游服务报错', '千刀服务报错，本次生成失败'],
  ['上游拒绝请求', '千刀不接受这次请求的格式或参数'],
  ['流未完整结束', '千刀的回复中断，没收到结束信号'],
  ['响应已结束但没有有效答案或工具调用', '千刀结束了这轮，但没给出可用回答或工具调用'],
  ['有工具调用没有完整交付', '千刀有工具调用没发完整'],
  ['上游超时', '等待千刀回复超时'],
  ['连接失败', '没能连上千刀'],
  ['连接或响应读取中断', '千刀回复没传完，连接就断了'],
  ['context_length_exceeded', '对话太长，超过模型能接收的长度'],
  ['invalid_api_key', '千刀不认这个 API Key'],
  ['authentication_error', '千刀不认这个 API Key'],
  ['permission_denied', '这把 Key 没有使用权限'],
  ['model_not_found', '千刀找不到这个模型'],
  ['unsupported_parameter', '千刀不支持这次请求里的某个设置'],
  ['insufficient_quota', '千刀额度不够'],
  ['insufficient_balance', '千刀余额不够'],
  ['billing_hard_limit_reached', '千刀账号已达到用量上限'],
]);

const httpReasons = new Map([
  [400, '千刀不接受这次请求的格式或参数'],
  [401, '千刀不认这个 API Key'],
  [403, '这把 Key 或这个模型没有使用权限'],
  [404, '千刀找不到这个接口或模型'],
  [408, '千刀处理请求超时'],
  [425, '千刀要求稍后再发这次请求'],
  [429, reasons.get('限流')],
  [500, '千刀服务内部出错'],
  [502, '千刀网关没拿到正常的上游回复'],
  [503, '千刀服务暂时不可用'],
  [504, '千刀网关等上游回复超时'],
  [522, '千刀网关连不上它的上游'],
  [524, '千刀网关等上游回复超时'],
  [530, '千刀入口暂时不可用'],
]);

const serviceReasons = new Set(['站点暂时不可用或尚未开放', '上游超时', '连接失败', '连接或响应读取中断', '流未完整结束', '上游服务报错', '上游重定向', '响应格式无效']);

export function knownReason(reason) {
  return reasons.has(reason) ? reason : undefined;
}

export function summarizeAttempts(records) {
  const successful = new Set();
  const laterAttempts = new Map();
  const errors = [];
  for (const record of [...records].sort((left, right) => right.time - left.time)) {
    const { requestId, time, status = null, retry, terminal, attempt, retryDelayMs, response } = record;
    const errorCode = record.errorCode ?? (/^\d{1,6}$/.test(record.reason) ? String(record.reason) : undefined);
    const numeric = Number(errorCode);
    let reason = record.reason;
    if (response?.status === 'incomplete' || response?.endEvent === 'response.incomplete') reason = '响应未完成';
    else if ((!reason || reason === '流未完整结束') && (response?.endEvent === 'response.failed' || response?.status === 'failed')) {
      if (numeric === 429 || status === 429) reason = '限流';
      else if ((numeric >= 400 && numeric < 500) || (status >= 400 && status < 500)) reason = '上游拒绝请求';
      else reason = '上游服务报错';
    }
    else if (!reason && status >= 300 && status < 400) reason = '上游重定向';
    const next = laterAttempts.get(requestId);
    if (requestId) laterAttempts.set(requestId, record);
    if (!retry && !terminal && status >= 200 && status < 300 && !reason) {
      if (requestId) successful.add(requestId);
      continue;
    }
    const httpMessage = httpReasons.get(numeric) ?? httpReasons.get(status);
    const serviceCode = [numeric, status].find(code => code === 408 || code === 425 || (code >= 500 && code < 600));
    const detail = reason === '上游服务报错' ? httpReasons.get(serviceCode) : reason === '上游拒绝请求' ? httpMessage : undefined;
    const message = detail ?? reasons.get(reason) ?? httpMessage
      ?? (retry ? '千刀暂时没能正常回复' : '千刀返回了错误');
    const limited = reason === '限流' || (!knownReason(reason) && (status === 429 || numeric === 429));
    const category = limited ? 'rate' : (status === null || status >= 500 || status === 408 || (numeric >= 500 && numeric < 600) || numeric === 408 || serviceReasons.has(reason)) ? 'service' : 'other';
    const startedAt = next?.attempt === attempt + 1 ? next.startedAt : record.retryStartedAt;
    const actualRetryMs = Number.isFinite(startedAt) ? Math.max(0, startedAt - time) : undefined;
    errors.push({ time, status, attempt, errorCode, message, category, recovered: successful.has(requestId), retryDelayMs: retry === false ? null : retryDelayMs, actualRetryMs, retrySkipped: record.retrySkipped });
  }
  return { limit: attemptHistoryLimit, attempts: records.length, errors };
}
