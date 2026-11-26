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

## Magpie 原生 Fast 开关

千刀的 Fast 操作入口以 Magpie 模型选择器右侧的闪电为首选。`CanFast()` 对 Provider 插件检查模型是否已声明、协议是否为 Chat 或 Responses，以及 `serviceTiers` 是否包含 `priority`，满足后即可返回 true；`m.fast` 属于另一个 Cursor 专用分支，不是千刀所需的能力声明。见 [groupfast.go:66](https://github.com/yetone/magpie/blob/v0.1.4795/internal/provider/groupfast.go#L66)。

界面在选项带有 `fastFor`、`ref` 且不属于运行命令时显示 `fastToggle`。网关在选中 Fast 后调用 `withFast` 处理请求，因此不要求 Codex 自己提供 Fast 按钮或先发送 `service_tier`。见 [app.js:5582](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gui/assets/app.js#L5582) 与 [gateway.go:4499](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/gateway.go#L4499)。

宿主支持该入口，插件仍需在真实宿主中验证开关状态、手填模型能力与实际上游请求。用户也接受供应商设置中的 Fast 开关作为入口。

手填模型需同步进入插件声明的模型列表，并包含对应协议和 `serviceTiers`；仅在宿主填写一个插件尚未列出的 ID，不满足 `CanFast` 的 `listed` 条件。见 [plugins.go:343](https://github.com/yetone/magpie/blob/v0.1.4795/internal/provider/plugins.go#L343)。

模型选项由 `CanFast` 派生 `fastFor`；点击闪电调用 `/api/agent-fast`，普通 Fast 保存为 `priority`。网关读取该选择后把 Responses 请求的 `service_tier` 设为 `priority`。见 [route.go:163](https://github.com/yetone/magpie/blob/v0.1.4795/internal/agent/route.go#L163)、[agent_models.go:300](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gui/agent_models.go#L300) 与 [groupfast.go:23](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/groupfast.go#L23)。

## 共用并发与配置入口

宿主按 provider ID 和账号分别计数，名额从 Provider 调用前取得，到完整响应读完或取消才释放。插件内部等待和退避也占宿主名额。因此原生并发设置不能直接满足“整个插件共用 5、退避不占上游名额”。见 [gateway.go:4740](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/gateway.go#L4740) 与 [gateway.go:4796](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/gateway.go#L4796)。

正式插件输入没有提供供应商界面的 `maxConcurrency`。插件选项 JSON 可以保存独立数字配置，但保存会重载共享插件宿主，影响宿主内全部插件；账号 metadata 的现成用户入口是登录问题表单，未找到通用直接编辑控件。见 [host.js:1512](https://github.com/yetone/magpie/blob/v0.1.4795/internal/plugin/host.js#L1512)、[host.js:2210](https://github.com/yetone/magpie/blob/v0.1.4795/internal/plugin/host.js#L2210) 与 [pluginpage.go:598](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gui/pluginpage.go#L598)。

重载时旧宿主继续处理已有请求，新请求交给新宿主；旧宿主最多保留 10 分钟。只用内存调度时，两个宿主各持有一份计数，因此频繁调整并发不能直接依赖这个保存入口。见 [host.go:848](https://github.com/yetone/magpie/blob/v0.1.4795/internal/plugin/host.go#L848)。

## 专用设置页

官方支持 `magpie.panels`、`magpie.page` 与 `magpie.page.service`。静态面板可以放在插件供应商的编辑器中，但使用 `magpie.options.set()` 仍会重载共享宿主。

`magpie.page.service` 允许插件宿主提供本机页面服务。桌面客户端打开该服务页面，网页版通过 Magpie 反代；页面自己的配置请求可以直接更新当前插件状态，无需调用 options 保存链。插件需要自行实现配置持久化和更新逻辑，聊天 Key 继续由 Magpie 管理。见 [plugin-runtime.md:296](https://github.com/yetone/magpie/blob/v0.1.4795/docs/subsystems/plugin-runtime.md#L296) 与 [pageservice.go:17](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gui/pageservice.go#L17)。

这为频繁修改地址和共用并发提供了正式页面入口；页面服务承载设置，模型请求仍走 Provider。它不需要用户单独启动外置网关。

## 整段缓存的等待边界

插件宿主等待首响应以及两块响应之间静默的上限都是 30 分钟，客户端取消会传进插件。更早的限制可能来自客户端：Magpie 约 3 秒后发流式响应头，再定期发 SSE 注释保活，但源码记录 Codex 的空闲计时只认事件，不认注释。宿主自己的缓冲会在约 4 分钟时尝试释放已有事件；插件如果一直隐藏事件，宿主就没有内容可释放。

因此整段缓存的代价不仅是看不到逐字输出，还包括长回复可能先撞客户端超时。见 [host.go:2183](https://github.com/yetone/magpie/blob/v0.1.4795/internal/plugin/host.go#L2183) 与 [fallback.go:3476](https://github.com/yetone/magpie/blob/v0.1.4795/internal/gateway/fallback.go#L3476)。

2026-11-26 检查到本机 Codex 为 `0.171.0-alpha.13.2`，磁盘配置选用 `magpie` provider，未显式设置 `stream_idle_timeout_ms`，运行命令也没有对应覆盖。当前[官方配置参考](https://developers.openai.com/codex/config-reference/)规定该项默认 300000 毫秒。现有证据支持按 5 分钟流闲置窗口设计，但未实测运行中超时。

旧网关 300 秒准入期限内开始的最后一次尝试最多继续 900 秒，可能约 20 分钟才交付。项目采用 Codex 默认等待设置，不修改 `[model_providers.magpie]` 的全局流闲置窗口。客户端先超时或取消时，插件停止对应的等待与上游调用；完整网关预算不保证在客户端等待期限内用完。

## 已知限制

不跨站和保留会话字段有利于缓存连续性，但千刀内部如何分配请求、是否命中缓存，不能由本地插件保证。公告是否认可这种插件使用方式也尚无明确证据。
