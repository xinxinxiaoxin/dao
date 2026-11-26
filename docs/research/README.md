# Design references

## Requirements

- Deliver one Magpie plugin with integrated QianDao transport, error recovery, concurrency control, and settings.
- Preserve the original Codex, CCS direct-connection, and QianDao gateway behavior as closely as the plugin interface permits.
- Keep the upstream Base URL editable.
- Share one configurable concurrency limit across models, accounts, and conversations; default to 5.
- Buffer complete responses to recover temporary failures before delivering content.
- Share request budgets across repeated Magpie calls, while preserving explicit terminal errors for client recovery.
- Keep Codex's default waiting behavior and unrelated provider settings unchanged.
- Offer Fast in Magpie through its native lightning control, without requiring a Codex Fast button.

## Sources

- [Original QianDao gateway](https://github.com/xinxinxiaoxin/qiandao), reference commit `4119d7891fe4af0b978d1a238041e91f072c6b02`.
- [AG Relay plugin](https://github.com/xinxinxiaoxin/magpie-agentrouter-relay), including its host integration tests.
- [Original gateway behavior](qiandao-behavior.md).
- [Magpie integration boundaries](magpie-integration.md), based on the inspected 0.1.4795 source.
- [Plugin integration responsibilities](architecture-options.md).
- [AG integration lessons](ag-integration-lessons.md).

Local reference checkouts are ignored by Git and are not included in release packages. Supporting design documents retain their original working language.

## Architecture decisions

- [Provider-owned retries](../adr/0001-provider-owned-retries.md).
- [Complete-response delivery](../adr/0002-buffer-before-delivery.md).
- [Preserving explicit terminal errors](../adr/0003-preserve-terminal-errors.md).

## Validation

The [design](../design.md) defines request behavior; the [validation record](../validation.md) covers the implemented package.

Validation observes actual upstream sends and client-visible responses. It covers sign-in, manually entered models, reasoning effort, Fast, request preservation, hot URL and concurrency changes, overlapping host generations, cancellation, bounded retries, and terminal context-limit events.

Native Fast is checked with requests that do not already contain a service tier. Enabling it must send `priority`; disabling it must stop forcing Priority; retries retain the original choice.

## Limitations

Complete-response buffering remains subject to the client's default idle timeout. Upstream routing, cache hits, granted service tiers, and live-account acceptance cannot be established by local fixtures alone.
