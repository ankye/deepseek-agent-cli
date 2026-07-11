## ADDED Requirements

### Requirement: Managed Runner Tool Matrix Is Audited / 受管 Runner 工具矩阵必须审计

Terminal runner capabilities that create managed child agent runs SHALL audit the required child tool matrix before the first child model request.

创建 managed child agent run 的 terminal runner capability 必须在第一次 child model request 前审计必需 child tool matrix。

#### Scenario: Missing child tool blocks model attribution / 缺少 Child 工具阻止模型归因

- **WHEN** `core.swe.bench.run` creates a managed child run
- **AND** a required child capability family is missing, not executable, policy-denied, or projected out
- **THEN** the runner records a typed tool-matrix failure before child model dispatch
- **AND** the failure category is not model-owned
- **中文** 当 `core.swe.bench.run` 创建 managed child run，且必需 child capability family 缺失、不可执行、被 policy 拒绝或被投影掉时，runner 必须在 child model dispatch 前记录 typed tool-matrix failure，且 failure category 不得归为模型侧。

#### Scenario: Tool matrix evidence is replayable / 工具矩阵证据可回放

- **WHEN** the runner audits child tools
- **THEN** the evidence records required capability ids, projected ids, executable ids, unavailable ids, policy-denied ids, projection-limited ids, tool families, profile id, workflow graph id, and redaction metadata
- **中文** 当 runner 审计 child tools 时，证据必须记录 required capability ids、projected ids、executable ids、unavailable ids、policy-denied ids、projection-limited ids、tool families、profile id、workflow graph id 与 redaction metadata。
