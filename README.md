# 千刀网关插件

把千刀旧网关的错误处理接入 Magpie，减少重复重试，保留日常可调整的连接配置。

## 使用要求

- Base URL 由使用者填写和修改，支持千刀更换域名。
- 整个插件共用一个并发上限，初始为 5，可在插件界面调整。
- 以 Codex Desktop 的千刀请求为主要使用场景，尽量接近 CCS 直连的行为。
- 首要目标是由插件内部消化可恢复错误，避免中间失败直接打断 Codex，并避免与 Magpie 的默认重试叠加。
- 旧网关是错误处理的参考实现；与温和重试目标存在冲突的行为需要单独确定。

当前处于设计讨论阶段。资料在 [docs/research](docs/research/README.md)，架构决定存放在 `docs/adr/`。

## 参考

- [千刀旧网关](https://github.com/xinxinxiaoxin/qiandao)
- [AG 插件讨论](codex://threads/01a2129f-a7a6-7212-ba64-aa44f7927c8c)
