## ADDED Requirements

### Requirement: Reference-Class Tool Arsenal Completeness / 参考级工具弹药库完整度

The CLI platform SHALL maintain a reference-to-DeepSeek tool matrix that maps every reference-class tool capability to a DeepSeek capability family, implementation owner, projection policy, fallback behavior, and verification command. A tool family SHALL NOT be considered complete from catalog metadata alone.

CLI 平台必须维护 reference-to-DeepSeek 工具矩阵，将每个参考级工具能力映射到 DeepSeek capability family、implementation owner、projection policy、fallback behavior 与 verification command。不得仅凭 catalog metadata 判定某个工具族完成。

#### Scenario: Tool family has executable or typed unavailable state / 工具族具备可执行或类型化不可用状态

- **WHEN** release readiness evaluates a tool family required by an active profile
- **THEN** the family SHALL be classified as `executable`, `adapter-unavailable-with-diagnostics`, or `not-yet-implemented`
- **AND** `executable` SHALL require registered capability metadata, executable lookup, preflight/policy handling, bounded result feedback, replay evidence, and deterministic coverage
- **AND** `adapter-unavailable-with-diagnostics` SHALL return typed provider/platform/connector diagnostics without being counted as implemented
- **中文** 当 release readiness 评估 active profile 必需的工具族时，该工具族必须分类为 `executable`、`adapter-unavailable-with-diagnostics` 或 `not-yet-implemented`；`executable` 必须具备 capability metadata 注册、可执行 lookup、preflight/policy 处理、有界结果反馈、replay evidence 与确定性覆盖；`adapter-unavailable-with-diagnostics` 必须返回类型化 provider/platform/connector diagnostics，且不得计为已实现。

#### Scenario: Active profile fails on missing arsenal / Active Profile 因弹药库缺失失败

- **WHEN** an active engineering profile declares required tool families
- **AND** any required family is missing, hidden without a projection reason, policy-denied without corrective feedback, or non-executable
- **THEN** the profile readiness gate SHALL fail before live task attribution can blame model quality
- **中文** 当 active engineering profile 声明必需工具族，且任一必需工具族缺失、无投影原因被隐藏、policy-denied 但无可修正反馈，或不可执行时，profile readiness gate 必须先失败，不得将 live task 失败归因为模型质量。

### Requirement: Tool Arsenal Covers Reference Capability Areas / 工具弹药库覆盖参考能力区域

The complete arsenal SHALL cover workspace I/O, search/code intelligence, mutation/patching, shell/process, git/build/package/test, planning/control, agents/tasks, web/public data, MCP/browser connectors, skills/plugins/hooks/commands, memory/context/session/worktree, scheduling/remote/observability, and media/design capability areas.

完整弹药库必须覆盖 workspace I/O、search/code intelligence、mutation/patching、shell/process、git/build/package/test、planning/control、agents/tasks、web/public data、MCP/browser connectors、skills/plugins/hooks/commands、memory/context/session/worktree、scheduling/remote/observability 与 media/design 能力区域。

#### Scenario: Coverage report is actionable / 覆盖报告可行动

- **WHEN** the tool arsenal coverage report runs
- **THEN** it SHALL emit each reference capability, mapped DeepSeek family, capability ids, implementation state, projection state, missing evidence, and next implementation action
- **AND** the report SHALL distinguish "not registered", "registered but not executable", "executable but not projected", "projected but rejected by policy", and "provider unavailable"
- **中文** 当工具弹药库覆盖报告运行时，必须输出每个参考能力、映射的 DeepSeek 工具族、capability ids、implementation state、projection state、缺失证据与下一步实现动作；报告必须区分“未注册”、“已注册但不可执行”、“可执行但未投影”、“已投影但被 policy 拒绝”与“provider 不可用”。
