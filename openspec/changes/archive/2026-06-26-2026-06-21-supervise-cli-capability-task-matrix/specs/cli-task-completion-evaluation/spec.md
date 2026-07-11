## ADDED Requirements

### Requirement: Supervised CLI Capability Task Matrix

CLI task completion evaluation SHALL include a supervised task matrix that evaluates live CLI behavior without supervisor task intervention.

CLI task completion evaluation 必须包含 supervised task matrix，用于评估 live CLI 行为，且监督者不得介入完成任务。

#### Scenario: Supervisor observes but does not solve / 监督者只观察不解题

- **WHEN** a capability-matrix task run starts
- **THEN** the supervisor may launch the CLI, collect trace artifacts, inspect diffs, and classify the result
- **AND** the supervisor MUST NOT edit the target task workspace to improve the task outcome
- **AND** any platform fix MUST be made in the CLI platform repository and validated before rerunning a fresh task fixture
- **中文** 当 capability-matrix task run 开始后，监督者可以启动 CLI、收集 trace artifacts、检查 diff 并分类结果；监督者不得编辑目标任务 workspace 来改善结果；任何平台修复必须发生在 CLI platform 仓库中并验证后，再使用 fresh task fixture 重跑。

#### Scenario: Capability areas are covered / 覆盖 CLI 能力区域

- **WHEN** the supervised matrix is executed
- **THEN** it SHALL include tasks covering read-only analysis, focused code edit, test-first bug fix, search/context, permission boundary, tool error recovery, long-task decomposition, and artifact delivery
- **AND** each task SHALL define required evidence before it can be marked pass
- **中文** 当 supervised matrix 执行时，必须包含覆盖只读分析、聚焦代码修改、测试优先 bug 修复、搜索/上下文、权限边界、工具错误恢复、长任务拆分和产物交付的任务；每个任务必须定义标记 pass 前所需的 evidence。

#### Scenario: Failures are attributed to actionable classes / 失败归因到可行动类别

- **WHEN** a task does not pass
- **THEN** the evaluator SHALL classify it as `partial`, `blocked-by-model`, `blocked-by-cli-capability-gap`, `blocked-by-cli-bug`, or `invalid-test-environment`
- **AND** the classification SHALL cite trace evidence including profile id, visible tool count, tool intents/results, workflow stage transitions, terminal reason, and workspace diff status when applicable
- **中文** 当任务未通过时，evaluator 必须将其分类为 `partial`、`blocked-by-model`、`blocked-by-cli-capability-gap`、`blocked-by-cli-bug` 或 `invalid-test-environment`；分类必须引用 trace evidence，包括 profile id、visible tool count、tool intents/results、workflow stage transitions、terminal reason，以及适用时的 workspace diff 状态。
