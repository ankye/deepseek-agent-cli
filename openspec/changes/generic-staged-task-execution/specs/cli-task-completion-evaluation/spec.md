## MODIFIED Requirements

### Requirement: CLI Evaluation Includes Webpage Generation Task / CLI 评估包含网页生成任务

CLI task-completion evaluation SHALL include a deterministic webpage-generation task with local artifact validation and SHALL allow DeepSeek-owned live execution only when explicitly requested.

CLI task-completion evaluation 必须包含带本地产物校验的 deterministic webpage-generation task，并且只有在显式请求时才允许 DeepSeek 自有 live execution。

#### Scenario: Evaluation task can be represented as a staged graph / Evaluation Task 可表示为 Stage Graph

- **WHEN** CLI evaluation prepares an executable task profile such as `eval.webpage.generation`
- **THEN** it can build a domain-neutral staged graph with materialization, agent execution, checker, artifact scan, and scoring stages
- **AND** the evaluation controller consumes staged run records rather than embedding task-specific execution order in the controller
- **中文** 当 CLI evaluation 准备 `eval.webpage.generation` 等 executable task profile 时，它可以构建包含 materialization、agent execution、checker、artifact scan 与 scoring stages 的领域中立 staged graph；evaluation controller 必须消费 staged run records，而不是在 controller 中嵌入 task-specific execution order。

#### Scenario: Evaluation run records expose staged snapshots / Evaluation Run 记录暴露 Stage Snapshot

- **WHEN** CLI evaluation reports a task run that has a staged profile
- **THEN** the task run includes a redacted staged task snapshot with profile id, graph id, profile fingerprint, graph, initial run state, stage count, ref count, and executor kinds
- **AND** planned dry-runs and executed runs use the same snapshot shape without changing the existing command execution behavior
- **中文** 当 CLI evaluation 输出带 staged profile 的 task run 时，task run 必须包含 redacted staged task snapshot，其中包括 profile id、graph id、profile fingerprint、graph、initial run state、stage count、ref count 与 executor kinds；planned dry-run 与 executed runs 使用相同 snapshot 形态，且不改变现有命令执行行为。
