# dao recovery policy

dao runs inside Magpie as a provider plugin. Codex sends a request to Magpie, the dao middleware associates host retries with that request, and dao's provider sends it to the configured QianDao URL. No separate gateway process is required.

## One response, one delivery

dao buffers the entire upstream response before delivery. Recovery can discard an unsuccessful response before Codex sees text or tool calls. A successful tool call is delivered once; Codex executes it and sends its result in a new request with its own budget. Assistant `phase`, tool names, call IDs, arguments, outputs, reasoning data and Fast selection are preserved.

A completed Responses result must contain something the client can use: an answer, refusal, or tool/output item. Empty completed output, reasoning-only output, or only `phase: "commentary"` without a tool call is retried before delivery. A valid `final_answer`, an unphased text answer, an explicit refusal, or `response.incomplete` keeps its upstream meaning. dao does not guess from the wording whether a valid final answer has finished the user's task.

## Limits and delays

| Case | Handling |
| --- | --- |
| HTTP 429 or recognized rate/concurrency-limit error | Up to 7 total attempts, including the first; waits of 3, 6, 10, 20, 40 and 60 seconds |
| Retryable 408, 425, 500, 502, 503, 504, 522 or 524; connection failure; incomplete stream; empty response; closed-site HTML; completed output without a deliverable | Same 7-attempt budget; waits of 0.75, 1.5, 3, 3, 3 and 3 seconds |
| Valid `Retry-After` longer than the normal delay | Wait at least the upstream's requested duration |
| Clear authentication, permission, model, parameter, balance/quota or context-length refusal | Return the terminal error without repeating the same request |
| Explicit rejection of Priority | Preserve the error; never silently retry as Standard |
| Client cancellation or disconnection | Stop its queue, backoff and active upstream request |

New attempts may start only within 300 seconds of the request entering dao. An already-started upstream attempt has a 900-second timeout. Queueing and waiting consume the admission window. Thus 300 seconds is not an unconditional total response timeout. The rate-limit delays total 139 seconds, before queueing and execution time. Concurrency and cooldown are shared across models, accounts and overlapping plugin hosts; queueing and backoff do not occupy execution slots. The default concurrency is 5 and the user may change it live.

Repeated host calls carrying the same middleware marker share the attempt budget and final result. They cannot start another seven attempts. A call without that marker is sent at most once. A client reconnect or manual resend is a new request and has a new budget.

## Magpie boundary

dao disables extra patience waiting and rate-limit rests for its own provider. Magpie still hosts the plugin, resolves models, handles protocol transport and can inspect the final error. Its provider-plugin interface does not offer the API-key provider's complete pass-errors bypass. dao therefore limits actual upstream sends even if the host invokes it again; it does not claim that every host behavior is disabled.

If retries cannot recover within the limits, dao returns an explicit failure. It cannot guarantee that every failure disappears, cannot keep working after the client cancels, and cannot correct a model that intentionally marks a premature statement as a valid final answer without guessing at its intent.

## Verification

The real Codex CLI is exercised against an isolated Magpie host and a local upstream. The upstream returns a first tool call, then an empty completed response after the tool result, then a second tool call and a final answer. dao must hide the empty response, resend identical tool history once, and let Codex finish both calls. Use `QIANDAO_CODEX_LOOP=1` with `tests/magpie-host.mjs`; set `CODEX_TEST_BIN` to the installed Codex executable when its location differs.

A separate live QianDao check on 2026-11-26 completed two JavaScript computation calls and a final answer through the installed Magpie and dao. The reported stalled conversation's Codex logs showed no output item after its last tool result, then `needs_follow_up=false`; the original upstream response body was not retained, so that historical response cannot be reconstructed byte for byte. The isolated test reproduces this exact client-visible stop and verifies recovery. Another reported turn carried `phase: "final_answer"` on its short progress-like text; no wording-based retry is applied to that case.
