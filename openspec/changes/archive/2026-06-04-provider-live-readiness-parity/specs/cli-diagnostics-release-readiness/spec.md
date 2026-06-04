## MODIFIED Requirements

### Requirement: CLI Release Readiness Evidence / CLI 发布就绪证据

CLI diagnostics release readiness SHALL require DeepSeek live acceptance evidence for publish readiness and SHALL also surface provider-specific GLM live evidence when GLM verification is requested or present.

CLI diagnostics release readiness 必须要求 DeepSeek live acceptance evidence 才能发布就绪，并且在请求或存在 GLM verification 时展示 provider-specific GLM live evidence。

#### Scenario: Live release evidence gates publish readiness / Live 发布证据门禁 Publish Ready

- **WHEN** `diagnostics verify` evaluates release readiness before publishing
- **THEN** it requires DeepSeek live provider smoke, live agent-loop smoke, live agent-tool smoke, live CLI run smoke, live doctor smoke, live tool coverage, provider response cache, and current-schema overall delivery capability evidence
- **AND** `publishDryRunReady` remains `false` when any required DeepSeek live evidence is missing, replay-only, skipped, stale, or does not include current delivery dimensions
- **AND** GLM live provider smoke, GLM live agent-tool smoke, and GLM live doctor evidence are reported as provider-parity evidence without weakening the DeepSeek gate
- **中文** 当 `diagnostics verify` 在发布前评估 release readiness 时，必须要求 DeepSeek live provider smoke、live agent-loop smoke、live agent-tool smoke、live CLI run smoke、live doctor smoke、live tool coverage、provider response cache 与当前 schema 的 overall delivery capability evidence；任一 required DeepSeek live evidence 缺失、仅 replay、被 skip、过期或不包含当前 delivery dimensions 时，`publishDryRunReady` 必须保持 `false`；GLM live provider smoke、GLM live agent-tool smoke 与 GLM live doctor evidence 必须作为 provider-parity evidence 报告，且不得削弱 DeepSeek gate。

## ADDED Requirements

### Requirement: Diagnostics Doctor Is Provider-Aware / Diagnostics Doctor 支持 Provider 感知

CLI diagnostics doctor SHALL pass explicit provider/model options into local readiness so live verification, credential checks, and metadata describe the selected provider.

CLI diagnostics doctor 必须把显式 provider/model options 传入 local readiness，使 live verification、credential checks 与 metadata 描述 selected provider。

#### Scenario: Diagnostics doctor verifies selected GLM provider / Diagnostics Doctor 校验选中的 GLM Provider

- **WHEN** a user runs `deepseek diagnostics doctor --live --provider glm --model glm-5.1 --output json`
- **THEN** diagnostics output includes `liveRequested = true`, selected provider metadata for GLM Anthropic-compatible verification, a `doctor.live` check for GLM, and redaction metadata without raw credential values
- **中文** 当用户运行 `deepseek diagnostics doctor --live --provider glm --model glm-5.1 --output json` 时，diagnostics output 必须包含 `liveRequested = true`、GLM Anthropic-compatible verification 的 selected provider metadata、面向 GLM 的 `doctor.live` check，以及不包含 raw credential values 的 redaction metadata。
