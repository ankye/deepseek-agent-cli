## ADDED Requirements

### Requirement: External Codex Evidence Is Explicit / 外部 Codex 证据必须显式

Baseline comparison evaluation SHALL not infer Codex task results or internal capabilities when no explicit external baseline evidence is available.

baseline comparison evaluation 在没有显式 external baseline evidence 时，不得推断 Codex task results 或内部能力。

#### Scenario: Codex unavailable stays unavailable / Codex 不可用时保持不可用
- **WHEN** a Codex comparison is requested
- **AND** no configured external Codex run, official/public documentation refresh, or stored baseline evidence is available
- **THEN** the comparison marks Codex evidence as `unavailable`
- **AND** it may still compare DeepSeek CLI against a documented Codex-class target with assumptions clearly labeled
- **中文** 当请求 Codex comparison，但没有 configured external Codex run、official/public documentation refresh 或 stored baseline evidence 时，对比必须将 Codex evidence 标为 `unavailable`；它仍可将 DeepSeek CLI 与已记录的 Codex-class target 对比，但 assumptions 必须明确标注。

#### Scenario: External baseline cannot help DeepSeek task / External Baseline 不得帮助 DeepSeek 任务
- **WHEN** Codex, Claude Code, or another external baseline is used for comparison
- **THEN** it runs only as a separate baseline or probe in an isolated workspace
- **AND** its outputs are not copied into DeepSeek CLI task workspaces or used to complete DeepSeek CLI task artifacts
- **中文** 当 Codex、Claude Code 或其他 external baseline 用于对比时，它只能作为独立 baseline 或 probe 在 isolated workspace 中运行；其输出不得复制到 DeepSeek CLI task workspace，也不得用于完成 DeepSeek CLI task artifacts。

### Requirement: Gap Scorecard Uses Comparable Dimensions / 差距评分卡使用可比较维度

Baseline comparison evaluation SHALL derive gap findings from comparable dimensions that can be populated for DeepSeek-owned runs and optionally for external baselines.

baseline comparison evaluation 必须从可比较维度推导 gap findings，这些维度必须能由 DeepSeek-owned runs 填充，并可选地由 external baselines 填充。

#### Scenario: Scorecard includes mechanism dimensions / 评分卡包含机制维度
- **WHEN** a Codex-class gap scorecard is rendered
- **THEN** it includes tool-surface readiness, projection correctness, task closure evidence, isolation and credential readiness, recovery behavior, and unsupported-claim rate
- **AND** each finding cites the run id, task id, metric id, and evidence path when available
- **中文** 当渲染 Codex-class gap scorecard 时，必须包含 tool-surface readiness、projection correctness、task closure evidence、isolation and credential readiness、recovery behavior 与 unsupported-claim rate；每个 finding 在可用时必须引用 run id、task id、metric id 与 evidence path。

