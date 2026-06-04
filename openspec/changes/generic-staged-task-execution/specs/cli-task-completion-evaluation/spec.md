## MODIFIED Requirements

### Requirement: CLI Evaluation Includes Webpage Generation Task / CLI 评估包含网页生成任务

CLI task-completion evaluation SHALL include a deterministic webpage-generation task with local artifact validation and SHALL allow DeepSeek-owned live execution only when explicitly requested.

CLI task-completion evaluation 必须包含带本地产物校验的 deterministic webpage-generation task，并且只有在显式请求时才允许 DeepSeek 自有 live execution。

#### Scenario: Evaluation task can be represented as a staged graph / Evaluation Task 可表示为 Stage Graph

- **WHEN** CLI evaluation prepares an executable task profile such as `eval.webpage.generation`
- **THEN** it can build a domain-neutral staged graph with materialization, agent execution, checker, artifact scan, and scoring stages
- **AND** the evaluation controller consumes staged run records rather than embedding task-specific execution order in the controller
- **中文** 当 CLI evaluation 准备 `eval.webpage.generation` 等 executable task profile 时，它可以构建包含 materialization、agent execution、checker、artifact scan 与 scoring stages 的领域中立 staged graph；evaluation controller 必须消费 staged run records，而不是在 controller 中嵌入 task-specific execution order。
