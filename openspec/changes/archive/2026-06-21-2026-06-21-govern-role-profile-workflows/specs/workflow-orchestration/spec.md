## ADDED Requirements

### Requirement: Role Workflow Catalog Defines Runtime-Owned Stage Contracts / Role Workflow Catalog 定义 Runtime 拥有的 Stage Contract

The workflow orchestration layer SHALL treat common professional role workflows as runtime-owned contracts with explicit stages, dependencies, allowed capabilities, evidence refs, no-progress policy, and acceptance gates.

workflow orchestration layer 必须将常用职业 role workflow 视为 runtime 拥有的 contract，包含显式 stage、dependencies、allowed capabilities、evidence refs、no-progress policy 与 acceptance gates。

#### Scenario: Role profile compiles through catalog layers / Role Profile 通过 Catalog 分层编译

- **WHEN** an execution-bearing task selects a role profile
- **THEN** the orchestrator compiles it through role profile, workflow profile, and capability profile layers
- **AND** the compiled workflow records the role id, workflow graph id, stage ids, stage objectives, allowed capability ids, expected evidence refs, and acceptance criteria
- **中文** 当具备执行性质的任务选择 role profile 时，orchestrator 必须通过 role profile、workflow profile 与 capability profile 三层编译；编译后的 workflow 必须记录 role id、workflow graph id、stage ids、stage objectives、allowed capability ids、expected evidence refs 与 acceptance criteria。

#### Scenario: Dynamic model decisions stay inside stages / 动态模型决策限定在 Stage 内

- **WHEN** a primary role workflow has an active ready stage
- **THEN** the model may choose tactics only within that stage's allowed capability profile
- **AND** the orchestrator must not count out-of-stage or disallowed capability use as stage progress
- **中文** 当 primary role workflow 有 active ready stage 时，模型只能在该 stage 的 allowed capability profile 内选择策略；orchestrator 不得把越过 stage 或不允许的 capability use 计为 stage progress。
