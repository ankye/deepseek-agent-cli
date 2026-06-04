## ADDED Requirements

### Requirement: GLM Anthropic-Compatible Provider / GLM Anthropic-Compatible Provider

The model gateway SHALL provide a GLM provider adapter that targets an Anthropic Messages-compatible endpoint while exposing only provider-neutral `ModelGateway` contracts to runtime, CLI, VSCode, tests, and future hosts.

model gateway 必须提供 GLM provider adapter，面向 Anthropic Messages-compatible endpoint，但只向 runtime、CLI、VSCode、tests 和未来 hosts 暴露 provider-neutral `ModelGateway` contracts。

#### Scenario: Provider builds Anthropic Messages request / Provider 构造 Anthropic Messages request

- **WHEN** a `ModelRequest` is streamed through the GLM provider with prompt, profile, messages, tools, tool choice, and output options
- **THEN** the provider sends an Anthropic-compatible `POST /v1/messages` request through the injected transport with `x-api-key` credentials and `anthropic-version`
- **中文** 当 `ModelRequest` 通过 GLM provider stream，并包含 prompt、profile、messages、tools、tool choice 与 output options 时，provider 必须通过 injected transport 发送 Anthropic-compatible `POST /v1/messages` request，并使用 `x-api-key` 凭据与 `anthropic-version`。

#### Scenario: Provider normalizes Anthropic response / Provider 归一化 Anthropic response

- **WHEN** the Anthropic-compatible endpoint returns text blocks, tool-use blocks, stop reasons, usage, or provider errors
- **THEN** the adapter emits provider-neutral delta, tool-call, finish, usage, done, or error events with GLM provider metadata and without executing tools
- **中文** 当 Anthropic-compatible endpoint 返回 text blocks、tool-use blocks、stop reasons、usage 或 provider errors 时，adapter 必须发出带有 GLM provider metadata 的 provider-neutral delta、tool-call、finish、usage、done 或 error events，且不得执行工具。

#### Scenario: Placeholder usage does not hide final usage / 占位 usage 不得掩盖最终 usage

- **WHEN** GLM streams a `message_start` usage placeholder with zero input and output tokens before later `message_delta` usage
- **THEN** the adapter defers the usage event until the real `message_delta` token counts are available and maps provider cache-read metadata into normalized cache usage
- **中文** 当 GLM 在后续 `message_delta` usage 前先 stream 一个 input/output tokens 为零的 `message_start` usage placeholder 时，adapter 必须推迟 usage event，直到真实 `message_delta` token counts 可用，并把 provider cache-read metadata 映射为 normalized cache usage。

#### Scenario: Provider fails closed without credential / 缺少凭据时 fail closed

- **WHEN** the GLM provider has a credential reference but no credential can be resolved
- **THEN** it emits a typed missing-credential error and sends no provider request
- **中文** 当 GLM provider 存在 credential reference 但无法解析 credential 时，必须发出 typed missing-credential error，且不得发送 provider request。
