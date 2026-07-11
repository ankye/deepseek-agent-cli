## ADDED Requirements

### Requirement: Execution-Bearing Coding Prompts Use Primary Role Workflows / 执行型 Coding Prompt 使用 Primary Role Workflow

The agent loop SHALL route execution-bearing coding prompts through a primary role workflow instead of treating the role profile as an advisory prompt hint.

agent loop 必须将具备执行性质的 coding prompt 路由到 primary role workflow，而不是把 role profile 当作 advisory prompt hint。

#### Scenario: Engineering task has ready-stage control / 工程任务具备 Ready-Stage Control

- **WHEN** a user prompt asks the CLI to fix, implement, modify, debug, test, verify, refactor, review, or otherwise perform repository-sensitive engineering work
- **THEN** the selected profile is a primary engineering role profile
- **AND** the provider request metadata includes ready-stage control before model dispatch
- **AND** the model-visible required action is constrained by the active engineering stage
- **中文** 当用户 prompt 要求 CLI 修复、实现、修改、调试、测试、验证、重构、审查或执行其它 repository-sensitive engineering work 时，选中的 profile 必须是 primary engineering role profile；provider request metadata 必须在模型派发前包含 ready-stage control；模型可见的 required action 必须受当前 engineering stage 约束。

#### Scenario: Casual chat remains advisory / 闲聊保持 Advisory

- **WHEN** a user prompt is casual chat, low-risk explanation, or pure informational conversation without repository-sensitive execution intent
- **THEN** the selected profile may remain advisory
- **AND** the loop must not force mutation-oriented workflow stages or required tool calls
- **中文** 当用户 prompt 是闲聊、低风险解释或没有 repository-sensitive execution intent 的纯信息对话时，选中的 profile 可以保持 advisory；loop 不得强制进入 mutation-oriented workflow stage 或 required tool call。

### Requirement: Stable Profile Contract Is Separate From Dynamic Run State / 稳定 Profile Contract 与动态 Run State 分离

The agent loop SHALL keep stable role/workflow/capability profile contracts separate from dynamic run state and progress markers.

agent loop 必须将稳定的 role/workflow/capability profile contract 与动态 run state、progress marker 分离。

#### Scenario: Provider request distinguishes stable and dynamic profile data / Provider Request 区分稳定与动态 Profile 数据

- **WHEN** a primary role workflow is projected into a provider request
- **THEN** stable profile identifiers, stage contracts, allowed capabilities, and exit criteria are represented separately from current attempts, produced refs, diagnostics, and stage status
- **AND** cache/prefix analysis can distinguish profile contract churn from dynamic run-state churn
- **中文** 当 primary role workflow 被投影到 provider request 时，稳定的 profile id、stage contract、allowed capabilities 与 exit criteria 必须与当前 attempts、produced refs、diagnostics 与 stage status 分离表达；cache/prefix analysis 必须能区分 profile contract churn 与 dynamic run-state churn。
