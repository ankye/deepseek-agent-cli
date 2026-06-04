## MODIFIED Requirements

### Requirement: Auth And Privacy Readiness / Auth 与 Privacy 可用性

The local readiness layer SHALL verify selected provider credential presence and privacy settings without printing raw secrets or exporting telemetry by default. DeepSeek credential checks SHALL remain the default when no provider is selected; GLM Anthropic-compatible checks SHALL use GLM credential references when GLM is selected.

local readiness layer 必须验证 selected provider credential presence 与 privacy settings，且不得打印 raw secrets 或默认导出 telemetry。未选择 provider 时，DeepSeek credential checks 必须保持默认；选择 GLM 时，GLM Anthropic-compatible checks 必须使用 GLM credential references。

#### Scenario: Auth reports redacted credential reference / auth 报告脱敏凭证引用

- **WHEN** `deepseek auth` or `deepseek doctor` evaluates credentials for the selected model provider
- **THEN** it reports a scoped credential reference, provider id, source class, and redaction class without printing the raw value
- **中文** 当 `deepseek auth` 或 `deepseek doctor` 为 selected model provider 评估 credentials 时，必须报告 scoped credential reference、provider id、source class 与 redaction class，且不得打印 raw value。

#### Scenario: Privacy reports local policy / privacy 报告本地策略

- **WHEN** `deepseek privacy` runs
- **THEN** it reports local telemetry/export policy, diagnostic persistence policy, and opt-out state as structured metadata
- **中文** 当 `deepseek privacy` 运行时，必须以 structured metadata 报告 local telemetry/export policy、diagnostic persistence policy 和 opt-out state。

### Requirement: Explicit Live Doctor / 显式 Live Doctor

The local readiness layer SHALL support explicit live connectivity verification for the selected model provider while keeping default `doctor` deterministic and offline.

local readiness layer 必须支持 selected model provider 的显式 live connectivity verification，同时保持默认 `doctor` deterministic 和 offline。

#### Scenario: Default doctor is offline / 默认 doctor 离线运行

- **WHEN** `deepseek doctor` runs without a live flag or live command input
- **THEN** it validates config, selected-provider credential presence, platform, install, privacy, and workspace metadata without calling a live model API
- **中文** 当 `deepseek doctor` 在没有 live flag 或 live command input 的情况下运行时，必须校验 config、selected-provider credential presence、platform、install、privacy 和 workspace metadata，且不得调用 live model API。

#### Scenario: Live doctor verifies provider through gateway / live doctor 通过 gateway 验证 provider

- **WHEN** `deepseek doctor --live` or `deepseek diagnostics doctor --live` runs with a selected provider and available credential reference
- **THEN** it calls model-gateway through injected credential resolution and returns provider id, protocol, model id, reachability, terminal status, latency metadata, and redacted diagnostics without exact model-text snapshots
- **中文** 当 `deepseek doctor --live` 或 `deepseek diagnostics doctor --live` 在 selected provider 与可用 credential reference 下运行时，必须通过 injected credential resolution 调用 model-gateway，并返回 provider id、protocol、model id、reachability、terminal status、latency metadata 与 redacted diagnostics，且不包含精确模型文本快照。
