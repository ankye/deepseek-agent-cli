## ADDED Requirements

### Requirement: Isolated Live Credential Resolution / 隔离 Live 凭据解析

Live agent tool execution SHALL resolve provider credentials for disposable task workspaces through approved user or global configuration sources without copying raw secrets into the workspace.

live agent tool execution 必须通过批准的 user 或 global configuration sources 为 disposable task workspaces 解析 provider credentials，且不得把 raw secrets 复制进 workspace。

#### Scenario: Disposable workspace uses redacted credential fallback / Disposable Workspace 使用脱敏凭据回退
- **WHEN** a live task runs from an isolated disposable workspace
- **AND** the repository workspace or user/global configuration contains valid provider credentials
- **THEN** provider readiness succeeds using a redacted credential source reference
- **AND** evidence records credential presence and source class without raw secret values
- **中文** 当 live task 从 isolated disposable workspace 运行，且 repository workspace 或 user/global configuration 包含有效 provider credentials 时，provider readiness 必须使用脱敏 credential source reference 成功；evidence 必须记录 credential presence 与 source class，但不得记录 raw secret values。

#### Scenario: Missing credentials are environment failures / 缺失凭据是环境失败
- **WHEN** no approved credential source is available for a requested live provider
- **THEN** the run is classified as `invalid-test-environment`
- **AND** the diagnostic distinguishes unavailable credentials from model failure, tool projection failure, and task failure
- **中文** 当 requested live provider 没有可用的 approved credential source 时，run 必须分类为 `invalid-test-environment`；diagnostic 必须区分 credential unavailable、model failure、tool projection failure 与 task failure。

### Requirement: Tool Projection Evidence Drives Continuation / 工具投影证据驱动继续

Live agent tool execution SHALL include compiled tool projection evidence in model dispatch and task traces so missing tools are not mistaken for model weakness.

live agent tool execution 必须在 model dispatch 与 task traces 中包含 compiled tool projection evidence，避免把缺失工具误判为模型弱。

#### Scenario: Model dispatch records visible tools / 模型调用记录可见工具
- **WHEN** runtime sends a live model request
- **THEN** trace evidence includes profile id, stage id, projection status, visible tool ids, required family ids, and unresolved family diagnostics
- **中文** 当 runtime 发送 live model request 时，trace evidence 必须包含 profile id、stage id、projection status、visible tool ids、required family ids 与 unresolved family diagnostics。

#### Scenario: Required write tool missing prevents live request / 必需写工具缺失阻止 Live Request
- **WHEN** a write-capable stage requires mutation or verification tools
- **AND** the compiled projection lacks those tools
- **THEN** runtime does not send the live model request
- **AND** it emits terminal projection evidence instead
- **中文** 当 write-capable stage 需要 mutation 或 verification tools，但 compiled projection 缺少这些工具时，runtime 不得发送 live model request，必须改为发出 terminal projection evidence。

