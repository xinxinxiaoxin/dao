# 千刀插件集成边界

## 目标与职责

目标是保留原来 Codex、CCS 直连配置和千刀网关配合使用的效果，同时由 Magpie 管理模型选择与 Fast。服务入口可改，整个网关共用并发上限，默认 5；临时错误在内部消化；客户端保持默认等待配置。

交付单位为一个 Magpie 插件。模型转发、重试、冷却、共享并发和设置均集成在插件内，生命周期归 Magpie 宿主管理。

## 请求路径与职责

`Codex → Magpie 千刀 Provider → 用户填写的千刀地址`

Magpie 提供模型选择、Fast 和 Key 管理；Provider 负责上游请求、整段缓存、错误恢复和共享并发。中间件关联同一次客户端请求，插件保留首次发送的内容、预算和最终结果，避免宿主重复调用放大实际上游发送量。

## 设置与宿主生命周期

插件页面服务只承载配置交互，模型请求通过 Provider 直接发往千刀。设置修改后持久化并更新插件当前状态；日常修改地址与并发不通过重载共享宿主来应用。

一次请求使用同一份地址、凭据、模型、Fast 选择和正文。地址更改用于之后进入的新请求，在途请求及重试继续使用原地址。

Provider 调用计入宿主忙碌 RPC；重载时旧宿主会等待已有调用收尾，最多十分钟。其他插件也可能触发重载，新旧宿主的在途请求与并发状态需要在实现中验证。

## 源码依据

- Provider 插件不适用 `PassErrors`：[pass_errors.go:3](https://github.com/yetone/magpie/blob/v0.1.4795/internal/provider/pass_errors.go#L3)。
- 插件模型声明 `priority` 和 Responses 协议后，Magpie 可以提供 Fast 并写入服务等级：[groupfast.go:66](https://github.com/yetone/magpie/blob/v0.1.4795/internal/provider/groupfast.go#L66)、[gateway.go:4499](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/gateway.go#L4499)。
- `page.service` 描述本地页面服务入口，监听服务由插件自行创建：[pageservice.go:17](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gui/pageservice.go#L17)。
- 插件宿主按调用启动；忙碌判定计算 RPC 槽，旧宿主最多保留十分钟：[host.go:848](https://github.com/yetone/magpie/blob/v0.1.4795/internal/plugin/host.go#L848)、[host.go:902](https://github.com/yetone/magpie/blob/v0.1.4795/internal/plugin/host.go#L902)。

## 需要补齐的行为

### 明确终态与可恢复错误

明确终态保留原意交付，限流、临时繁忙和真正断流继续内部消化。`response.failed` 按错误原因判断可恢复性，`context_length_exceeded` 保留响应事件，让 Codex 有机会自动压缩；明确鉴权失败直接交付。错误语义不明确时，不仅凭笼统的“额度”字样推断永久失败。

旧网关未将 `response.failed` 纳入终止集合，可能把可操作的压缩信号包装为普通上游失败。依据：[旧网关 gateway.mjs:254](https://github.com/xinxinxiaoxin/qiandao/blob/4119d7891fe4af0b978d1a238041e91f072c6b02/gateway.mjs#L254)、[Magpie fallback.go:3487](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/fallback.go#L3487)。

### 排队与冷却恢复

旧网关的冷却到期时，信号量会一次补满空闲名额；五个请求可能同时再次撞到上游限制。建议保持共用冷却，恢复时按队列错峰放行；排队自身应响应准入期限和取消，不能过期后仍长期占队列。共用并发上限和实际发送节奏分别控制在途数量与请求突发，不增加自动调参系统。

依据：[gateway.mjs:110](https://github.com/xinxinxiaoxin/qiandao/blob/4119d7891fe4af0b978d1a238041e91f072c6b02/gateway.mjs#L110)、[gateway.mjs:341](https://github.com/xinxinxiaoxin/qiandao/blob/4119d7891fe4af0b978d1a238041e91f072c6b02/gateway.mjs#L341)。具体错峰策略在错误恢复规则确认后确定。

### 客户端自动重连

七次上限属于一次进入网关的请求。Codex 超时自动重连与用户手动重发一样，会形成新的 HTTP 请求；共享宿主调用预算不能自动跨越这个边界。取消应及时终止旧请求，共用冷却继续有效。对话 ID 不等于同一次请求，不按正文摘要合并合法的新请求。

### Fast 与请求语义

Provider 保留首次实际发送的正文、Fast 选择和最终结果。宿主可能在字段被拒绝后删除 `service_tier` 再调用插件；只共享剩余次数不足以避免静默降级。已确定不可恢复终态的请求，宿主再次调用时直接交付同一终态。

依据：[gateway.go:9435](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/gateway.go#L9435)、[gateway.go:9183](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/gateway.go#L9183)。

### 等待状态

设置页应能区分排队、上游执行、冷却等待和最后错误，展示本次尝试次数、下一次可尝试时间及当前在途数量。长时间无正文时，用户据此判断是在恢复还是已经停止。状态数据不需要保存完整对话或 Key。

## 已知限制

整段缓存隐藏了失败片段，也隐藏了正常生成进度；保留默认客户端等待时，长回复可能先超时。转发几个真实生命周期事件不能保证持续续命，重复编造事件会改变协议语义。临近默认超时转为流式交付可以另作取舍，但一旦内容交付，就无法同时保证隐藏后续断流并整单重放。当前保持用户已确认的整段缓存方案。

以上为设计与源码依据，插件设置更新、新旧实现对照以及实际 Magpie 请求链尚未实施或验收。千刀内部路由和缓存命中由上游决定。
