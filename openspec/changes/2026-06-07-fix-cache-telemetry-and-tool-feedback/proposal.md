# Fix Cache Telemetry and Tool Feedback Bounds

## Summary
Correct cache-hit telemetry for multi-request agent loops and ensure live tool continuation messages are bounded before they are sent back to the model.

修正多请求 agent loop 的缓存命中率 telemetry，并确保 live tool continuation message 在回传模型前已经被边界裁剪。

## Motivation
SWE-bench style tool loops can make many model requests in one turn. Reporting only the final request's cache usage makes the CLI/TUI statusline understate or misstate the actual hit rate, especially when the last request follows a large verification step. GLM Anthropic-compatible usage also reports cache-read tokens without miss tokens, so downstream telemetry needs a normalized breakdown.

SWE-bench 类型的工具循环会在一个 turn 内发起多次模型请求。只报告最后一次请求的缓存用量，会让 CLI/TUI 状态栏低估或误报真实命中率，尤其当最后一次请求跟在大型验证步骤之后。GLM Anthropic-compatible usage 还会只返回 cache-read tokens 而不返回 miss tokens，因此下游 telemetry 需要归一化 breakdown。

The same traces showed that runtime events stored bounded tool-result previews, but the continuation message sent to the model could still contain the raw tool result. That inflates prompt size, pollutes stable prefix cache opportunities, and weakens the product's bounded-feedback contract.

同一批 trace 也显示 runtime events 存储的是有界 tool-result preview，但回传给模型的 continuation message 仍可能包含原始 tool result。这会膨胀 prompt size、污染 stable prefix cache 机会，并削弱产品的 bounded-feedback 契约。

## Scope
- Normalize GLM Anthropic-compatible cache usage to include hit tokens, miss tokens, and hit rate.
- Aggregate statusline cache telemetry across all usage events in a turn, with `inputTokens` as the fallback miss count for legacy provider events.
- Send only bounded `ToolResultFeedback.preview.text` to the next model continuation request.
- Keep richer raw/structured tool evidence in replay/audit records, not model-visible continuation history.

- 将 GLM Anthropic-compatible cache usage 归一化为 hit tokens、miss tokens 与 hit rate。
- 在一个 turn 内跨所有 usage events 聚合状态栏缓存 telemetry，并对旧 provider event 使用 `inputTokens` 作为 miss count fallback。
- 下一次模型 continuation request 只发送有界的 `ToolResultFeedback.preview.text`。
- 更丰富的原始/结构化工具证据保留在 replay/audit records 中，而不是 model-visible continuation history。
