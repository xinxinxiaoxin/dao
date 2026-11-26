# 千刀接入方案比较

## 目标与职责

目标是保留原来 Codex、CCS 直连配置和千刀网关配合使用的效果，同时由 Magpie 管理模型选择与 Fast。服务入口可改，整个网关共用并发上限，默认 5；临时错误在内部消化；客户端保持默认等待配置。

这要求一处负责实际上游请求的重试、冷却和并发，另外几层保留模型选择、凭据和请求语义。是否有独立后台进程，是交付与维护方式的取舍，不直接决定是否需要用户每天手动启动。

## 方案

| 方案 | 重试归属 | 使用与维护 | 关键取舍 |
| --- | --- | --- | --- |
| Provider 插件与请求中间件 | 插件通过跨调用共享预算约束实际发送 | 安装插件即可使用独立供应商 | Magpie 仍处理错误与请求字段；需固定首次请求语义、终态和预算，处理宿主重载边界 |
| 普通供应商与独立后台网关，插件提供设置入口 | 普通供应商 `errors=pass`，网关承担错误恢复 | 一次安装自动启动项，日常使用 Magpie；换电脑需要安装后台组件 | 多一个后台进程，普通供应商的直连行为和旧网关可以直接复用 |
| 普通供应商与共享插件宿主内的 HTTP 网关 | 普通供应商可原样转发，网关承担错误恢复 | 表面上全部位于插件宿主 | 外部 HTTP 请求不计入宿主忙碌 RPC，重载可能切断请求；旧新宿主并存时固定端口可能冲突 |

**建议选择独立后台网关方案。** 它最接近原有路径，也能实际使用普通供应商的原样转发和 Codex 请求保留设置。架构变更仍待确认；已接受的 Provider 插件决定保持有效，直到新决定形成。

## 推荐候选的请求路径

`Codex → Magpie 普通千刀供应商 → 本机后台网关 → 用户填写的千刀地址`

该供应商使用 Responses 接口，指向本机网关地址；开启 `errors=pass` 和 `codex=as-sent`。Magpie 负责模型选择、Fast 与 Key，网关负责整段缓存、错误分类、重试、共享冷却和并发。插件页面用于修改真实千刀地址与并发并查看状态。

Magpie 中的 Base URL 指向本机服务，真实千刀地址在网关设置中编辑。一次请求及其重试使用同一份地址、凭据、模型、Fast 选择和正文。改变上游地址只影响新请求。

后台组件由系统自动启动，独立于共享插件宿主。安装和配置只作用于千刀线路及其后台组件，不修改 Codex 默认等待或其他供应商设置。原生界面支持一次性创建普通供应商；插件页面是否有正式的一键创建能力尚未确认。

## 源码依据

- 普通 API Key 供应商支持 `PassErrors`，Provider 插件不适用：[pass_errors.go:3](https://github.com/yetone/magpie/blob/v0.1.4795/internal/provider/pass_errors.go#L3)。
- `codex=as-sent` 用于保留 Codex Responses 请求形态，跳过当前阶段的兼容转换：[provider.go:356](https://github.com/yetone/magpie/blob/v0.1.4795/internal/provider/provider.go#L356)、[gateway.go:7165](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/gateway.go#L7165)。它不等于任意字段逐字节不变。
- Magpie 的 Fast 在上述转换之前写入 `priority`，保留请求形态不会撤销该选择：[gateway.go:4499](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/gateway.go#L4499)、[gateway.go:7250](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/gateway.go#L7250)。
- 普通 key + URL 供应商默认传递客户端 UA；Codex 身份、会话头按专门规则保留：[provider.go:451](https://github.com/yetone/magpie/blob/v0.1.4795/internal/provider/provider.go#L451)、[gateway.go:6875](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/gateway.go#L6875)。
- `page.service` 描述本地页面服务入口，监听服务由插件自行创建：[pageservice.go:17](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gui/pageservice.go#L17)。
- 插件宿主按调用启动；重载后也需要新的插件调用。忙碌判定只计算 RPC 槽，旧宿主最多保留十分钟：[host.go:848](https://github.com/yetone/magpie/blob/v0.1.4795/internal/plugin/host.go#L848)、[host.go:902](https://github.com/yetone/magpie/blob/v0.1.4795/internal/plugin/host.go#L902)。据此可知，放进该宿主的独立 HTTP 监听服务不能获得与 Provider 请求相同的在途保护。

## 需要补齐的行为

### 明确终态与可恢复错误

旧网关没有把 `response.failed` 当作终止事件。上游明确返回 `context_length_exceeded` 时，也可能按断流重试，最终包装成 `upstream_unavailable`。这会丢失 Codex 用于自动压缩的信号。建议明确终态保留原意交付，限流、临时繁忙和真正断流继续内部消化。错误语义不明确时，不仅凭笼统的“额度”字样推断永久失败。

依据：[旧网关 gateway.mjs:254](https://github.com/xinxinxiaoxin/qiandao/blob/4119d7891fe4af0b978d1a238041e91f072c6b02/gateway.mjs#L254)、[Magpie fallback.go:3487](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/fallback.go#L3487)。这项修改待确认。

### 排队与冷却恢复

旧网关的冷却到期时，信号量会一次补满空闲名额；五个请求可能同时再次撞到上游限制。建议保持共用冷却，恢复时按队列错峰放行；排队自身应响应准入期限和取消，不能过期后仍长期占队列。共用并发上限和实际发送节奏分别控制在途数量与请求突发，不增加自动调参系统。

依据：[gateway.mjs:110](https://github.com/xinxinxiaoxin/qiandao/blob/4119d7891fe4af0b978d1a238041e91f072c6b02/gateway.mjs#L110)、[gateway.mjs:341](https://github.com/xinxinxiaoxin/qiandao/blob/4119d7891fe4af0b978d1a238041e91f072c6b02/gateway.mjs#L341)。具体错峰策略在错误恢复规则确认后确定。

### 客户端自动重连

七次上限属于一次进入网关的请求。Codex 超时自动重连与用户手动重发一样，会形成新的 HTTP 请求；共享宿主调用预算不能自动跨越这个边界。取消应及时终止旧请求，共用冷却继续有效。对话 ID 不等于同一次请求，不按正文摘要合并合法的新请求。

### Fast 与请求语义

Provider 插件方案需要保留首次实际发送的正文、Fast 选择和最终结果。宿主可能在字段被拒绝后删除 `service_tier` 再调用插件；只共享剩余次数不足以避免静默降级。普通供应商的 `errors=pass` 可以跳过相应的错误后修复重试路径。

依据：[gateway.go:9435](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/gateway.go#L9435)、[gateway.go:9183](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/gateway.go#L9183)。

### 等待状态

设置页应能区分排队、上游执行、冷却等待和最后错误，展示本次尝试次数、下一次可尝试时间及当前在途数量。长时间无正文时，用户据此判断是在恢复还是已经停止。状态数据不需要保存完整对话或 Key。

## 已知限制

整段缓存隐藏了失败片段，也隐藏了正常生成进度；保留默认客户端等待时，长回复可能先超时。转发几个真实生命周期事件不能保证持续续命，重复编造事件会改变协议语义。临近默认超时转为流式交付可以另作取舍，但一旦内容交付，就无法同时保证隐藏后续断流并整单重放。当前保持用户已确认的整段缓存方案。

以上结论来自源码调查。后台安装、热更新设置、新旧实现对照以及实际 Magpie 请求链尚未实施或验收。千刀内部路由和缓存命中由上游决定。
