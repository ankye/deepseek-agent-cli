## ADDED Requirements

### Requirement: Evaluation Distinguishes Tool Gaps From Model Gaps / Evaluation 区分工具缺口与模型缺口

CLI task-completion evaluation SHALL distinguish missing runner tools, child projection gaps, orchestration gaps, harness failures, packaging failures, budget failures, and model behavior failures before reporting model capability as the primary cause.

CLI task-completion evaluation 必须先区分 runner 工具缺失、child 投影缺口、编排缺口、harness failure、打包失败、预算失败与模型行为失败，再把模型能力报告为 primary cause。

#### Scenario: Runner summary exposes attribution gates / Runner Summary 暴露归因 Gate

- **WHEN** a governed runner task finishes unsuccessfully
- **THEN** the task record includes runner tool matrix evidence, stage evaluation summaries, technical-director acceptance, primary failure category, and `modelAttributionAllowed`
- **AND** reports do not present "model problem" as primary unless `modelAttributionAllowed` is true
- **中文** 当受治理 runner task 未成功结束时，task record 必须包含 runner tool matrix evidence、stage evaluation summaries、技术总监验收、primary failure category 与 `modelAttributionAllowed`；当 `modelAttributionAllowed` 不为 true 时，报告不得把“模型问题”作为 primary cause。
