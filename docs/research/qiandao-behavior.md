# 旧千刀网关的实际行为

来源：[xinxinxiaoxin/qiandao](https://github.com/xinxinxiaoxin/qiandao/tree/4119d7891fe4af0b978d1a238041e91f072c6b02)，提交 `4119d7891fe4af0b978d1a238041e91f072c6b02`。本文描述源码，不表示新插件已经采用全部行为。

## 错误分类

| 响应 | 旧网关行为 |
| --- | --- |
| HTTP 429 | 一律限流重试，不区分余额不足、日额度耗尽与暂时限流 |
| HTTP 408、425、500、502、503、504、522、524 | 重试；命中限流文本时使用限流退避，否则普通退避 |
| HTTP 400、529 及其他状态 | 正文命中限流或 `please retry later` 时重试，否则保留原响应 |
| HTTP 200 内的 JSON 或 SSE 错误 | 提取错误文本，按关键词分类 |
| SSE 缺少认可的终止事件 | 按断流重试，包括已收到部分文本的情况 |
| 2xx 空响应 | 重试 |
| 网络、读响应体、单次超时 | 普通退避重试；客户端取消除外 |

固定状态集合与关键词见 [gateway.mjs:17](https://github.com/xinxinxiaoxin/qiandao/blob/4119d7891fe4af0b978d1a238041e91f072c6b02/gateway.mjs#L17)，分类函数见 [gateway.mjs:236](https://github.com/xinxinxiaoxin/qiandao/blob/4119d7891fe4af0b978d1a238041e91f072c6b02/gateway.mjs#L236)。README 的“5xx 自动重试”比实现范围更宽。

SSE 认可 `response.completed`、`response.incomplete`、`message_stop`、`[DONE]` 以及常见 `finish_reason`。`response.failed` 不在终止集合：即使该错误不是暂时故障，也可能按断流重试。

## 次数与等待

- 默认最多 7 次尝试，含首次请求。
- 限流等待依次为 3、6、10、20、40、60 秒；超过第七次尝试后仍为 60 秒。
- 普通等待为 0.75、1.5、3、3、3、3 秒。
- 有效 `Retry-After` 与本地等待时间取较大值，支持秒数和 HTTP 日期。
- 默认 300 秒内允许发起新的尝试；在途请求不受这个预算截断。
- 单次上游请求的超时为 900 秒，覆盖完整响应读取。
- 信号量排队没有预算到期计时器，可能超过 300 秒后取得名额，才发现预算已过期。
- 默认并发 5；整个网关实例共用并发池和冷却时间，不按 Key、模型或会话划分。

见 [默认值](https://github.com/xinxinxiaoxin/qiandao/blob/4119d7891fe4af0b978d1a238041e91f072c6b02/gateway.mjs#L38) 与 [重试控制](https://github.com/xinxinxiaoxin/qiandao/blob/4119d7891fe4af0b978d1a238041e91f072c6b02/gateway.mjs#L341)。

## 响应交付

通过 `await upstream.arrayBuffer()` 完整读完响应，才向客户端写响应头和正文。因此可以丢弃失败尝试已生成的片段，重新提交整单请求。成功回答也要等整段完成才显示。现有测试明确要求“上游生成部分内容后断流，可以重试”。见 [实现](https://github.com/xinxinxiaoxin/qiandao/blob/4119d7891fe4af0b978d1a238041e91f072c6b02/gateway.mjs#L357) 与 [对应测试](https://github.com/xinxinxiaoxin/qiandao/blob/4119d7891fe4af0b978d1a238041e91f072c6b02/gateway.test.mjs#L257)。

重试耗尽后重新包装错误为 `upstream_unavailable`：最后状态为 429 时返回 429；其他情况预算耗尽返回 504，次数耗尽返回 502。未进入重试的响应直接透传。

## 请求保留与地址

请求体按原字节发送，重试复用相同内容；不截断历史、不改推理强度、不生成新的缓存键。请求头除逐跳头、Host、Content-Length 外保留；配置额外上游 Key 时才覆盖 Authorization。

每个实例使用一个可配置 Base URL，不切换其他站点。路径拼接支持地址自带前缀；重定向采用手动处理。启动脚本的地址参数会覆盖同名环境变量，修改地址时应使用脚本参数或直接运行 Node 入口。见 [URL 和请求头](https://github.com/xinxinxiaoxin/qiandao/blob/4119d7891fe4af0b978d1a238041e91f072c6b02/gateway.mjs#L124) 与 [启动脚本](https://github.com/xinxinxiaoxin/qiandao/blob/4119d7891fe4af0b978d1a238041e91f072c6b02/start.ps1#L1)。

## 需要取舍的行为

完整缓存便于隐藏断流，代价是失去实时输出，并可能让上游重复生成已完成的部分。全部 429 重试、永久 SSE 错误被当成断流，以及普通错误 0.75 秒开始重试，都需要结合“温和重试”的目标确定。客户端重新发起的请求也可能再次获得预算，插件单次请求上限不等于整个对话的总发送上限。
