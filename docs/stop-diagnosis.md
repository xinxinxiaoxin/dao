# Responses delivery at the Magpie boundary

## Client tool discovery, 15:22–15:23 (UTC+8)

On November 26, dao rc.8 and Magpie's usage log recorded the same response IDs for both stops. At 15:22:30 dao received reasoning, a commentary message and `tool_search_call`; Codex recorded reasoning and a final message, with no search. At 15:23:04 dao received only `tool_search_call`; Codex recorded no output item. Both requests succeeded on their first upstream attempt with HTTP 200. Neither produced a search result in the next request.

On Magpie 0.1.4834, offering web search alongside client tool discovery triggers a response translation path. Magpie offers the provider a function named `tool_search`; dao restores the original client-executed search declaration for QianDao. A native `tool_search_call` returned unchanged by dao is then lost in translation. Without the web-search declaration, the same native call survives the isolated control request. The production records contain the upstream item types, not the complete payloads.

dao declares native web search for its Responses provider. If Magpie takes over web search and builds a request with a `web_search` function, dao uses that request, including its tool history and streaming mode. Otherwise it restores the native Codex request for QianDao. In both cases the gateway forwards the buffered response without converting individual tools. This also covers free-form calls and namespaced calls, which the translated path otherwise drops or delivers without their namespace.

## Earlier stop, 14:32 (UTC+8)

On 2026-11-26 at 14:32:24 China time, the reported Codex turn ended after two file-reading tools. Its last response contained a reasoning item, no recorded answer or tool call, and `model_needs_follow_up=false`. Context limits were not reached. Magpie recorded HTTP 200 after 9.799 seconds; dao recorded one attempt as completed. This was not exhaustion of the retry or timeout budget.

The original upstream bytes for that request were not retained. The historical response's exact shape cannot be determined from these logs.

## Reproducible delivery failures

Two local upstream sequences cause real Codex to stop between tools when relayed by rc.7:

- A reasoning item followed by `response.completed` without an aggregate `output` field.
- A reasoning item followed by an aggregate containing a tool call, with no corresponding `response.output_item.done` for that tool.

The first bypassed the output-array-gated check. The second passed that check even though Codex does not execute tools from the aggregate alone. Successful SSE delivery now requires usable item events before the terminal event. JSON responses continue to use their aggregate output. These conditions recover within the existing budget.

## Request-path comparison

On Magpie 0.1.4834, the same 28 streaming and JSON cases were sent directly to the original gateway (`4119d78`) and through Magpie. Direct access preserved every tool, argument, call ID and message phase. Feeding the same native replies to a generic Magpie provider pointed at that gateway preserved 20 of 28. When the fixture answered using the tool definitions actually sent upstream, that route preserved 27 of 28: the non-streaming mixed reply included a plain `tool_search` function instead of a native search call. These controls test the protocol boundary, not the frequency of failures on a live model. dao preserved 28 of 28 both with native search and with Magpie search takeover.

An isolated Magpie 0.1.4827 serves both an ordinary API-key provider pointing to the original QianDao gateway and the dao provider. The same local upstream supplies the same reasoning and function/custom-tool events to both. Delivered tool items are identical for the complete response fixtures.

Their request shaping differs: the ordinary provider converts Codex's `additional_tools` input into the standard tools field, whereas dao restores the original request. dao must retain that original request's reasoning context and summary while applying Magpie's selected effort. Replacing the entire reasoning object loses those fields; the provider now overlays effort alone.

The path comparison is an isolated fixture test. It does not establish that the user's untested Magpie-to-original-gateway chain succeeds against live QianDao, or that the omitted reasoning field caused the historical stop.

## Evidence retained

The scheduler stores the latest 100 attempt summaries across plugin hosts, including plugin version, request and response IDs, HTTP status, terminal event, and upstream aggregate and event item types. These are provider-side records, not proof that Codex executed a tool; correlate the response ID with the client turn. No conversation text, tool arguments or credentials are retained.
