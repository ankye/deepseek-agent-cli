## ADDED Requirements

### Requirement: Engineering Role Workflow Has Evidence-Gated Stages / 工程师 Role Workflow 具备 Evidence-Gated Stages

The staged task execution system SHALL provide a generic engineering role workflow for repository-sensitive coding work.

staged task execution system 必须为 repository-sensitive coding work 提供通用工程师 role workflow。

#### Scenario: Engineering workflow stages are fixed / 工程师 Workflow Stage 固定

- **WHEN** `engineering/coding.v1` is compiled
- **THEN** its stage order is `understand`, `plan`, `test`, `implement`, `verify`, and `report`
- **AND** each stage has explicit entry criteria, exit criteria, allowed capabilities, and expected evidence refs
- **中文** 当 `engineering/coding.v1` 被编译时，其 stage 顺序必须是 `understand`、`plan`、`test`、`implement`、`verify` 与 `report`；每个 stage 必须具备显式 entry criteria、exit criteria、allowed capabilities 与 expected evidence refs。

#### Scenario: Technical director acceptance is required for primary role stage completion / Primary Role Stage 完成需要技术总监验收

- **WHEN** a primary role workflow reports a stage as passed, completed, or accepted
- **THEN** the stage state includes a technical-director acceptance record with criteria, evidence sufficiency, decision, and residual risk
- **AND** a stage without sufficient evidence remains `blocked` or `needs-review`, not `passed`
- **中文** 当 primary role workflow 报告某个 stage 已 passed、completed 或 accepted 时，stage state 必须包含技术总监验收记录，说明 criteria、evidence sufficiency、decision 与 residual risk；证据不足的 stage 必须保持 `blocked` 或 `needs-review`，不得标记为 `passed`。
