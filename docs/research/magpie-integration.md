# Magpie 接入边界

核对版本：本机 `magpie --version` 为 `0.1.4795`，对应公开源码标签 `v0.1.4795`。

## 原样转发的适用范围

普通 API Key 供应商可以设置 `passErrors`，使 Magpie 保留最终错误，停止同供应商重试、fallback、组成员切换及因该错误而休息 Key 的行为。

Provider 插件不满足这个条件。`TakesPassErrors()` 要求 `Account == nil`，源码注释明确排除插件；`PassesErrors()` 同时检查该条件。见 [pass_errors.go:3](https://github.com/yetone/magpie/blob/v0.1.4795/internal/provider/pass_errors.go#L3)。所以截图里普通供应商的开关不能直接视作插件的行为保证。

## 宿主重试与插件预算

宿主仍对 429 和部分 5xx 进行额外尝试。当前实现的同供应商短重试上限分别为 3 和 2；较长的 `Retry-After` 只会退出这一段短重试，不能关闭后续等待逻辑。见 [fallback.go:2442](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/fallback.go#L2442)。

纯插件可通过中间件关联同一次客户端请求，让不同的 Provider 调用共享次数、期限与终止状态。这样宿主再次调用也不能重新获得上游发送预算。AG 插件已使用这种结构，但千刀的错误分类和次数需要单独确定。

这种结构限制实际发送量，不等于关闭宿主的错误处理。最终错误返回后，Magpie 的等待或账号状态处理仍可能发生。客户端重新发起的请求属于新的入口，也不能自动当作同一次请求。

## 普通供应商中间件

普通中间件的响应钩子用于变换当前输出，不能完整接管上游请求的等待和重新发送。请求 hooks 与完成通知也不提供普通供应商的 transport 替换能力，因此不能简单给截图里的供应商加一个响应钩子，就实现旧网关的完整重试。

见 [gateway-middleware.md](https://github.com/yetone/magpie/blob/v0.1.4795/docs/subsystems/gateway-middleware.md) 与 [gateway-request-hooks.md](https://github.com/yetone/magpie/blob/v0.1.4795/docs/subsystems/gateway-request-hooks.md)。

## 接入验证

真正需要观察的是本地模拟千刀收到多少次请求、收到哪些字段，以及 Codex 最终收到什么。单测只证明插件函数本身，不能证明宿主没有叠加请求。

Base URL、模型名、推理强度和并发设置都必须通过实际宿主入口改变实际请求；不能只凭表单存在判定可用。模型列表暂时不可用时，手填模型仍应能走 Responses 接口。缓存相关字段、工具调用配对、真实客户端 UA 和 `service_tier` 需要在模拟上游检查。

## 可编辑地址

AG 参考插件的 loader 写死了 Base URL，不能直接复用这一部分。宿主的目标选择优先采用 `loader.baseURL`，其次才是模型和 provider 的地址。千刀插件需要把用户配置的地址传到 loader，账号 metadata 是已有的输入渠道。账号配置变化后，宿主会重建对应 loader。见 [plugins.go:840](https://github.com/yetone/magpie/blob/v0.1.4795/internal/provider/plugins.go#L840) 与 [host.js:3298](https://github.com/yetone/magpie/blob/v0.1.4795/internal/plugin/host.js#L3298)。

`auth.options` 只支持布尔开关，不能直接作为文本或数字输入框。地址和并发入口的交付必须以宿主实际支持的界面为准。

## 模型与请求字段

模型支持推理时，声明 `reasoning: true` 可沿用宿主模型目录中的档位。默认强度不由插件补写。服务等级需要正确声明 `serviceTiers`，并验证上游实际收到的字段；客户端选择 Priority 不代表上游实际执行了 Priority。见 [plugins.go:429](https://github.com/yetone/magpie/blob/v0.1.4795/internal/provider/plugins.go#L429) 与 [gateway.go:8984](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/gateway.go#L8984)。

## 共用并发与配置入口

宿主按 provider ID 和账号分别计数，名额从 Provider 调用前取得，到完整响应读完或取消才释放。插件内部等待和退避也占宿主名额。因此原生并发设置不能直接满足“整个插件共用 5、退避不占上游名额”。见 [gateway.go:4740](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/gateway.go#L4740) 与 [gateway.go:4796](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/gateway.go#L4796)。

目前查到的正式插件输入没有提供供应商界面的 `maxConcurrency`。插件选项 JSON 可以保存独立数字配置，但保存会重启插件宿主；账号 metadata 的现成用户入口是登录问题表单，未找到通用直接编辑控件。不能据此承诺修改参数不影响在途请求。见 [host.js:1512](https://github.com/yetone/magpie/blob/v0.1.4795/internal/plugin/host.js#L1512)、[host.js:2210](https://github.com/yetone/magpie/blob/v0.1.4795/internal/plugin/host.js#L2210) 与 [store.go:758](https://github.com/yetone/magpie/blob/v0.1.4795/internal/plugin/store.go#L758)。

## 整段缓存的等待边界

插件宿主等待首响应以及两块响应之间静默的上限都是 30 分钟，客户端取消会传进插件。更早的限制可能来自客户端：Magpie 约 3 秒后发流式响应头，再定期发 SSE 注释保活，但源码记录 Codex 的空闲计时只认事件，不认注释。宿主自己的缓冲会在约 4 分钟时尝试释放已有事件；插件如果一直隐藏事件，宿主就没有内容可释放。

因此整段缓存的代价不仅是看不到逐字输出，还包括长回复可能先撞客户端超时。当前 Codex 的具体超时配置尚未核对，不能将源码提到的历史默认值当成本机实际配置。见 [host.go:2183](https://github.com/yetone/magpie/blob/v0.1.4795/internal/plugin/host.go#L2183) 与 [fallback.go:3476](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/fallback.go#L3476)。

## 已知限制

不跨站和保留会话字段有利于缓存连续性，但千刀内部如何分配请求、是否命中缓存，不能由本地插件保证。公告是否认可这种插件使用方式也尚无明确证据。
