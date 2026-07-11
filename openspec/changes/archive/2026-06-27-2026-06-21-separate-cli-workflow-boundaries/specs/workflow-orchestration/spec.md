## ADDED Requirements

### Requirement: Workflow Governance Mode Boundary

Workflow orchestration SHALL represent governance mode separately from workflow priority.

Workflow orchestration 必须将 governance mode 与 workflow priority 分开表达。

#### Scenario: Primary does not imply evaluation supervision / Primary 不等于 evaluation supervision

- **WHEN** a profile declares `workflowPriority=primary`
- **THEN** runtime does not infer benchmark supervision, technical-director acceptance, anti-tailoring, or model-attribution gates from priority alone
- **AND** those policies are applied only when the profile explicitly declares an evaluation or supervisor governance mode
- **中文** 当 profile 声明 `workflowPriority=primary` 时，runtime 不得仅根据 priority 推断 benchmark supervision、技术总监验收、anti-tailoring 或 model-attribution gates；这些策略只能在 profile 显式声明 evaluation 或 supervisor governance mode 时应用。

#### Scenario: Read-only analysis does not enter mutation workflow / 只读分析不进入变更 workflow

- **WHEN** a CLI prompt explicitly constrains the task to read-only analysis, inspection, or diagnosis
- **THEN** profile selection MUST route the task to a standard read-only analysis workflow
- **AND** that workflow MUST expose only read, search, glob, list, diff, or other non-mutating evidence capabilities
- **AND** it MUST NOT include mutation, patch, write, test-before-change, or implementation stages
- **中文** 当 CLI prompt 显式约束为只读分析、检查或诊断时，profile selection 必须将任务路由到 standard read-only analysis workflow；该 workflow 只能暴露 read/search/glob/list/diff 或其他非变更证据能力，不得包含 mutation、patch、write、先测后改或实现阶段。
