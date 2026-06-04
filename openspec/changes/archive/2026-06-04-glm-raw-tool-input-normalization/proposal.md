# GLM Webpage Evaluation Flow Stabilization

## Why

GLM Anthropic-compatible live tool calls can emit large tool arguments as a JSON object containing a single `raw` string whose value is itself a JSON object. The runtime currently forwards that wrapper to core tools, so policy cannot see fields such as `path` and can deny valid write operations before execution.

GLM Anthropic-compatible live tool calls 可能把较大的 tool arguments 输出为只包含 `raw` 字符串的 JSON object，而该 `raw` 值本身又是 JSON object。runtime 当前会把这个 wrapper 原样传给 core tools，导致 policy 看不到 `path` 等字段，从而在执行前拒绝合法写入。

Live webpage generation also needs a larger provider output budget for GLM because HTML/CSS/JS/evidence writes are serialized through Anthropic tool-use JSON. Without that budget, GLM can stop with `length` mid-argument. After artifact generation, the final assistant summary must stay short so evidence-first validation is focused on generated artifacts instead of natural-language recaps that may restate command strings.

GLM live webpage generation 还需要更大的 provider output budget，因为 HTML/CSS/JS/evidence 写入会通过 Anthropic tool-use JSON 串行输出。若预算不足，GLM 可能在 tool argument 中途以 `length` 停止。artifact generation 之后，最终 assistant summary 必须保持短句，避免 evidence-first validation 去校验自然语言复盘中重复出现的 command strings，而是聚焦 generated artifacts。

## What Changes

- Normalize single-field `raw` tool inputs when the `raw` value parses to a JSON object.
- Preserve non-JSON raw strings as redacted/opaque raw input.
- Use a larger GLM Anthropic `max_tokens` budget for expanded webpage/html evaluation tasks, while preserving simple prompt defaults.
- Widen one-shot agent-loop limits for expanded webpage/html tasks.
- Constrain webpage evaluation final responses to a fixed short completion sentence; artifact evidence stays in `generated-webpage/evidence.json`.
- Cover the behavior with focused GLM provider, CLI model-selection, and webpage-task prompt regression tests.

- 当单字段 `raw` tool input 的值可解析为 JSON object 时，将其规范化为真实 tool input。
- 对非 JSON raw strings 保持 opaque raw input，不误解析。
- 对 expanded webpage/html evaluation tasks 使用更大的 GLM Anthropic `max_tokens` budget，同时保持 simple prompt 默认行为。
- 对 expanded webpage/html tasks 放宽 one-shot agent-loop limits。
- 将 webpage evaluation 的最终回复约束为固定短句；artifact evidence 保持写入 `generated-webpage/evidence.json`。
- 用聚焦 GLM provider、CLI model-selection 与 webpage-task prompt 回归测试覆盖这些行为。

## Follow-up

The live run still shows that webpage evaluation would be healthier as internally staged sub-tasks. This change stabilizes the current single-loop path first; a later OpenSpec should split webpage evaluation into artifact-plan, HTML, CSS, JS, evidence manifest, and checker phases.

后续仍应将 webpage evaluation 内部分阶段执行。此变更先稳定当前 single-loop 路径；后续 OpenSpec 应将 webpage evaluation 拆为 artifact-plan、HTML、CSS、JS、evidence manifest 与 checker phases。
