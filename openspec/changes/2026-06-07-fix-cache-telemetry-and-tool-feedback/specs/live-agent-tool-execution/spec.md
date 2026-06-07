## MODIFIED Requirements
### Requirement: Live Tool Feedback Contract / Live 工具反馈契约

The system SHALL convert every live tool execution outcome into provider-compatible tool feedback with bounded preview, normalized status, diagnostics, trace metadata, and redaction metadata.

系统必须把每个 live tool execution outcome 转换为 provider-compatible tool feedback，包含有界 preview、normalized status、diagnostics、trace metadata 和 redaction metadata。

#### Scenario: Successful tool feedback is bounded / 成功工具反馈有界

- **WHEN** a tool execution succeeds with large output
- **THEN** model-facing feedback includes a bounded redacted preview and replay evidence retains richer structured metadata
- **中文** 当 tool execution 成功但输出很大时，model-facing feedback 必须只包含有界脱敏 preview，replay evidence 保留更丰富的结构化 metadata。

#### Scenario: Continuation history is bounded / 续轮历史有界

- **WHEN** runtime sends tool feedback back to the model for continuation
- **THEN** the `tool` role message content uses the bounded feedback preview instead of the raw terminal output
- **AND** runtime events, replay evidence, and audit records may retain richer structured evidence without making it model-visible
- **中文** 当 runtime 将 tool feedback 回传给模型继续生成时，`tool` role message content 必须使用有界 feedback preview，而不是原始 terminal output；runtime events、replay evidence 与 audit records 可以保留更丰富的结构化证据，但不得让这些内容变成 model-visible。

#### Scenario: Failed tool feedback is typed / 失败工具反馈类型化

- **WHEN** a tool execution is rejected, denied, times out, is cancelled, or fails
- **THEN** model-facing feedback carries a normalized non-success status and typed diagnostics without raw stack traces or secrets
- **中文** 当 tool execution 被拒绝、被 deny、超时、取消或失败时，model-facing feedback 必须包含 normalized non-success status 和 typed diagnostics，且不得包含 raw stack traces 或 secrets。
