# Magpie plugin contract

Reference: [Magpie plugin development guide](https://usemagpie.ai/docs/zh/plugins), read on 2026-11-26.

dao uses the documented `config`, `auth.loader.fetch`, and `provider.models` hooks. The entry module exports only the plugin factory. Models declare Responses through `@ai-sdk/openai`, with `serviceTiers` set in the models hook. The settings launch page uses the documented bridge and external scripts. GitHub distribution uses a root package manifest and the `magpie-plugin` topic.

Provider defaults are initialized only when no explicit provider configuration exists. Model metadata retains explicit capability and limit values. The live settings list is read by the models hook, so removing a model is reflected without restarting the host. Models explicitly configured in other supported inputs remain available.

The settings service is optional for transport availability. Failure to bind its port is reported in the plugin log; the provider continues serving requests using persisted settings and retries page startup when the port becomes available.

The shared scheduler and complete-response retry policy are dao behavior, rather than requirements of the plugin contract. The account-level concurrency advertised by `magpie.maxConcurrency` is not used as a substitute for dao's shared upstream limit.

Validation uses isolated configuration and a local upstream. Contract regressions cover preservation of user defaults and model metadata, removal from the live model list, and provider availability when the settings port is occupied.
