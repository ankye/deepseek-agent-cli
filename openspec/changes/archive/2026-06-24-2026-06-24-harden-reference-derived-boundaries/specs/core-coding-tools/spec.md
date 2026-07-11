## ADDED Requirements

### Requirement: Mutation Paths Preserve Literal Artifact Identity / Mutation Path 保留 Artifact 字面身份

Core coding tool preflight SHALL distinguish discovery path canonicalization from mutation/artifact path execution. Read, list, and search tools MAY use platform canonicalization to resolve existing files. Write, edit, and patch tools SHALL still use platform workspace resolution for safety, but SHALL preserve the model/user supplied literal relative path casing for executor input after rejecting unsafe syntax.

核心 coding tool preflight 必须区分 discovery path canonicalization 与 mutation/artifact path execution。read、list 与 search 工具可以使用平台 canonicalization 来解析既有文件。write、edit 与 patch 工具仍必须使用 platform workspace resolution 做安全检查，但在拒绝不安全语法后，executor input 必须保留模型/用户提供的字面相对路径大小写。

#### Scenario: Write path stays literal after safe platform resolution / 安全平台解析后写入路径保持字面值

- **WHEN** a model requests `core.file.write` with `path: "Docs/USAGE.md"` on a case-insensitive platform
- **AND** platform workspace resolution confirms the path is inside the governed workspace
- **THEN** preflight SHALL pass `Docs/USAGE.md` to the executor rather than lowercasing it
- **AND** read/search preflight MAY continue to return platform canonical paths for discovery.
- **中文** 当模型在大小写不敏感平台上以 `path: "Docs/USAGE.md"` 请求 `core.file.write`，且平台 workspace resolution 确认路径位于受治理 workspace 内时，preflight 必须把 `Docs/USAGE.md` 传给 executor，而不是转成小写；read/search preflight 仍可为 discovery 返回平台 canonical path。

### Requirement: Rejected Tool Feedback Is Corrective / 工具拒绝反馈必须可修正

Core coding tool preflight and execution diagnostics SHALL include enough provider-neutral feedback for the model to choose a valid next action when a rejection is retryable or recoverable.

核心 coding tool preflight 与 execution diagnostics 在拒绝可重试或可恢复请求时，必须包含足够的 provider-neutral feedback，帮助模型选择有效下一步。

#### Scenario: Rejection names the repair direction / 拒绝反馈说明修正方向

- **WHEN** a model tool call is rejected for unsafe path syntax, missing required input, policy denial, or unavailable platform capability
- **THEN** the tool feedback SHALL include the failing field, typed reason, and corrective direction such as using a workspace-relative path, supplying the missing field, choosing a projected tool, or reporting a bounded blocker.
- **中文** 当模型工具调用因 unsafe path syntax、缺少必填输入、policy denial 或平台能力不可用而被拒绝时，工具反馈必须包含失败字段、typed reason，以及修正方向，例如使用 workspace-relative path、补齐缺失字段、选择已投影工具，或报告有界 blocker。
