# Magpie plugin contract

Reference: [Magpie plugin development guide](https://usemagpie.ai/docs/zh/plugins), read on 2026-11-26.

dao uses the documented `config`, `auth.loader.fetch`, `provider.models`, and `auth.usage` hooks. The entry module exports only the plugin factory. Models declare Responses through `@ai-sdk/openai`, with `serviceTiers` set in the models hook. The settings launch page uses the documented bridge and external scripts. GitHub distribution uses a root package manifest and the `magpie-plugin` topic.

Provider defaults are initialized only when no explicit provider configuration exists. Model metadata retains explicit capability and limit values. The live settings list is read by the models hook, so removing a model is reflected without restarting the host. Models explicitly configured in other supported inputs remain available.

The native provider refresh invokes `provider.models(provider, { auth, signal })`. It queries the configured `/models` endpoint once and returns the current candidates with optional manual additions. Unavailable or empty upstream lists return the last successful list with `Symbol.for("magpie.fellBack")`, preserving Magpie's saved list and picks. Account-scoped model caches also survive plugin-host restarts. The plugin remembers IDs added by hand so subsequent native saves do not turn them into remotely managed models.

Magpie's native provider selection metadata distinguishes selected IDs from their candidate list. dao extends `pickedFrom` for successful discovery while preserving `models`, preventing the host's automatic inclusion of newly listed models from changing explicit user picks. This host integration is scoped to dao. The source behavior is `Provider.withNewlyListed` and `listedWith` in Magpie's provider implementation; it is separate from the public models hook.

`auth.usage` queries Sub2API's `/usage` endpoint with the same model API key. Wallet balance, key allowance, subscription windows, and spend are mapped to Magpie's usage fields. Query failures return `signIn: "kept"` and an explicit error, with no fabricated zero. Magpie retains prior successful usage alongside its read-error notice. Normal JSON authentication errors from chat keep their terminal meaning; HTML closure pages are temporary failures.

QianDao's public key-usage page and read-only live requests on 2026-11-26 confirmed `/v1/models` and `/v1/usage`. The latter returned `mode`, `unit`, `balance`, `remaining`, and `usage`. Live chat was not exercised. Query implementations use an eight-second timeout, the host cancellation signal, and no internal retries.

The settings service is optional for transport availability. Failure to bind its port is reported in the plugin log; the provider continues serving requests using persisted settings and retries page startup when the port becomes available.

The settings page remains inside Magpie's `sandbox="allow-scripts"` iframe after navigation to its local service. Save uses a normal button's click handler and individual input validation. It does not submit an HTML form, which the sandbox prohibits. The regression test verifies the file written by an actual browser click and the provider's subsequent request destination.

The service's page token persists in dao's data directory across host generations, allowing already-open pages to continue saving after a host restart. Unknown tokens are refused with an explicit unsaved-edit message.

The shared scheduler and complete-response retry policy are dao behavior, rather than requirements of the plugin contract. The account-level concurrency advertised by `magpie.maxConcurrency` is not used as a substitute for dao's shared upstream limit.

Validation uses isolated configuration and a local upstream. Contract regressions cover preservation of user defaults and model metadata, removal from the live model list, and provider availability when the settings port is occupied.
