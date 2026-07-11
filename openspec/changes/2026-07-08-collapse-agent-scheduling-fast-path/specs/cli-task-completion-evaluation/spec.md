## ADDED Requirements

### Requirement: Evaluation Reports Trajectory Convergence Quality

CLI task-completion evaluation SHALL report trajectory convergence quality separately from runtime caps, benchmark scoring, and model-owned attribution.

CLI task-completion evaluation 必须将 trajectory convergence quality 与 runtime caps、benchmark scoring、model-owned attribution 分开报告。

#### Scenario: Short-path quality target is evidence, not cap

- **WHEN** a canary or external rubric expects a straightforward patch task to converge through a short effective path
- **THEN** evaluation records model request count, accepted next-action sequence, invalid command count, duplicate discovery count, mutation evidence, verification evidence, cache-prefix stability, terminal status, and failure category
- **AND** it does not treat the expected short path as a hard runtime cap or benchmark-specific success shortcut
- **中文** 当 canary 或外部 rubric 期望直接补丁任务通过短有效路径收敛时，evaluation 必须记录 model request count、accepted next-action sequence、invalid command count、duplicate discovery count、mutation evidence、verification evidence、cache-prefix stability、terminal status 与 failure category；不得把期望短路径当作 hard runtime cap 或 benchmark-specific success shortcut。

#### Scenario: Model attribution waits for scheduler evidence

- **WHEN** a short-path canary fails or exceeds the expected trajectory quality target
- **THEN** evaluation first requires evidence for scheduler projection, tool availability, workspace binding, path resolution, standard verification projection, model-visible feedback sufficiency, cache stability, environment readiness, harness readiness, and packaging state
- **AND** model-owned attribution remains disallowed until applicable non-model causes have explicit exclusion evidence
- **中文** 当 short-path canary 失败或超过预期 trajectory quality target 时，evaluation 必须先要求 scheduler projection、tool availability、workspace binding、path resolution、standard verification projection、model-visible feedback sufficiency、cache stability、environment readiness、harness readiness 与 packaging state 证据；在适用的非模型原因有明确排除证据前，不得允许 model-owned attribution。

### Requirement: Evaluation Uses Provider-Neutral Scheduler Metrics

CLI task-completion evaluation SHALL compare providers through the same scheduler metrics and SHALL NOT require provider-specific scheduler fixes for equivalent behavior.

CLI task-completion evaluation 必须通过同一套 scheduler metrics 比较 providers，不得为等价行为要求 provider-specific scheduler fixes。

#### Scenario: Providers share scheduler assessment

- **WHEN** two providers run the same governed task profile
- **THEN** evaluation compares their trajectories using the same accepted next-action sequence, dispatch rejection counts, invalid command counts, cache evidence fields, mutation evidence, verification evidence, and terminal classifications
- **AND** provider-specific normalization may live only in model-gateway or prompt compatibility layers, not in scheduling policy
- **中文** 当两个 providers 运行同一个受治理 task profile 时，evaluation 必须使用同一套 accepted next-action sequence、dispatch rejection counts、invalid command counts、cache evidence fields、mutation evidence、verification evidence 与 terminal classifications 比较轨迹；provider-specific normalization 只能存在于 model-gateway 或 prompt compatibility layers，不得进入 scheduling policy。

### Requirement: Evaluation Enforces Fast-Path Acceptance Gates

CLI task-completion evaluation SHALL expose explicit fast-path acceptance gates so release decisions cannot reinterpret trajectory results ad hoc.

CLI task-completion evaluation 必须暴露明确 fast-path acceptance gates，避免发布验收临时解释 trajectory results。

#### Scenario: Acceptance gates are reported

- **WHEN** a governed canary run completes, fails, times out, or is blocked
- **THEN** evaluation reports `deterministicContractsPassed`, `canaryTrajectoryAccepted`, `prohibitedBehaviorAbsent`, `modelAttributionAllowed`, and `schedulerDefectCandidate`
- **AND** `canaryTrajectoryAccepted` is false when terminal packaging failed, mutation evidence is absent before verification/package acceptance, invalid verification commands repeat after correction, broad discovery repeats after focused evidence acceptance, or scheduler prompt churn is the proven cache failure root cause
- **AND** `schedulerDefectCandidate` is true when canary trajectory misses the expected short path without accepted evidence proving valid task complexity or external environment/harness blockers
- **中文** 当受治理 canary run 完成、失败、超时或 blocked 时，evaluation 必须报告 `deterministicContractsPassed`、`canaryTrajectoryAccepted`、`prohibitedBehaviorAbsent`、`modelAttributionAllowed` 与 `schedulerDefectCandidate`；当 terminal packaging 失败、verification/package acceptance 前缺少 mutation evidence、invalid verification commands 在 correction 后重复、focused evidence acceptance 后重复 broad discovery，或 scheduler prompt churn 被证明为 cache failure 根因时，`canaryTrajectoryAccepted` 必须为 false；当 canary trajectory 未达到预期短路径且没有 accepted evidence 证明原因是真实任务复杂度或外部 environment/harness blocker 时，`schedulerDefectCandidate` 必须为 true。
