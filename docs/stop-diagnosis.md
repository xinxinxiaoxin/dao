# Responses delivery at the Magpie boundary

## Observed stop

On 2026-11-26 at 14:32:24 China time, the reported Codex turn ended after two file-reading tools. Its last response contained a reasoning item, no recorded answer or tool call, and `model_needs_follow_up=false`. Context limits were not reached. Magpie recorded HTTP 200 after 9.799 seconds; dao recorded one attempt as completed. This was not exhaustion of the retry or timeout budget.

The original upstream bytes for that request were not retained. The historical response's exact shape cannot be determined from these logs.

## Reproducible delivery failures

Two local upstream sequences cause real Codex to stop between tools when relayed by rc.7:

- A reasoning item followed by `response.completed` without an aggregate `output` field.
- A reasoning item followed by an aggregate containing a tool call, with no corresponding `response.output_item.done` for that tool.

The first bypassed the output-array-gated check. The second passed that check even though Codex does not execute tools from the aggregate alone. Successful SSE delivery now requires usable item events before the terminal event. JSON responses continue to use their aggregate output. These conditions recover within the existing budget.

## Request-path comparison

An isolated Magpie 0.1.4827 serves both an ordinary API-key provider pointing to the original QianDao gateway and the dao provider. The same local upstream supplies the same reasoning and function/custom-tool events to both. Delivered tool items are identical for the complete response fixtures.

Their request shaping differs: the ordinary provider converts Codex's `additional_tools` input into the standard tools field, whereas dao restores the original request. dao must retain that original request's reasoning context and summary while applying Magpie's selected effort. Replacing the entire reasoning object loses those fields; the provider now overlays effort alone.

The path comparison is an isolated fixture test. It does not establish that the user's untested Magpie-to-original-gateway chain succeeds against live QianDao, or that the omitted reasoning field caused the historical stop.

## Evidence retained

The scheduler stores the latest 100 attempt summaries across plugin hosts, including plugin version, request and response IDs, HTTP status, terminal event, aggregate item types and delivered item types. No conversation text, tool arguments or credentials are retained. This distinguishes future upstream output failures from a downstream loss without storing private response bodies.
