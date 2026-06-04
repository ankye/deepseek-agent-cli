## MODIFIED Requirements

### Requirement: GLM Anthropic-Compatible Provider / GLM Anthropic-Compatible Provider

The model gateway SHALL provide a GLM provider adapter that targets an Anthropic Messages-compatible endpoint while exposing only provider-neutral `ModelGateway` contracts to runtime, CLI, VSCode, tests, and future hosts.

model gateway 必须提供 GLM provider adapter，面向 Anthropic Messages-compatible endpoint，但只向 runtime、CLI、VSCode、tests 和未来 hosts 暴露 provider-neutral `ModelGateway` contracts。

#### Scenario: Raw JSON wrapper is expanded / Raw JSON wrapper 被展开

- **WHEN** a GLM Anthropic-compatible tool call emits input as `{ "raw": "{\"path\":\"generated-webpage/index.html\",\"content\":\"...\"}" }`
- **THEN** the provider emits a tool-call event with input `{ "path": "generated-webpage/index.html", "content": "..." }`
- **中文** 当 GLM Anthropic-compatible tool call 将 input 输出为 `{ "raw": "{\"path\":\"generated-webpage/index.html\",\"content\":\"...\"}" }` 时，provider 必须发出 input 为 `{ "path": "generated-webpage/index.html", "content": "..." }` 的 tool-call event。
