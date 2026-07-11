## MODIFIED Requirements

### Requirement: Task State Machine Ownership / 任务状态机所有权

The runtime SHALL own the task and stage state-machine transition rules while each task run owns its own isolated state snapshot, and the task run SHALL be linked to the upstream task brief, goal, delivery plan, and acceptance review when those delivery-flow records exist.

runtime 必须拥有 task 与 stage state-machine transition rules，而每个 task run 拥有自己的隔离 state snapshot；当上游 task brief、goal、delivery plan 与 acceptance review 存在时，task run 必须与这些 delivery-flow records 关联。

#### Scenario: Controller advances through typed events / 总控通过类型化事件推进

- **WHEN** a stage is scheduled, started, succeeded, failed, blocked, skipped, retried, repaired, cancelled, or returned from acceptance review
- **THEN** the controller applies a typed stage or delivery event to the task run state and records the resulting stage state without allowing executors to mutate state directly
- **AND** acceptance return decisions identify the target phase or stage without rewriting successful immutable refs
- **中文** 当 stage 被 scheduled、started、succeeded、failed、blocked、skipped、retried、repaired、cancelled 或从 acceptance review 回流时，controller 必须将 typed stage 或 delivery event 应用到 task run state，并记录结果 stage state，不允许 executors 直接修改 state；acceptance return decisions 必须识别目标 phase 或 stage，且不得重写已成功的 immutable refs。

#### Scenario: Dependencies choose ready stages / Dependency 决定 Ready Stage

- **WHEN** a stage has dependencies
- **THEN** it becomes ready only after all required dependency stages have reached terminal success or an allowed skip policy
- **AND** acceptance-driven repair or verification reruns only the owning failed phase or ready repair stages unless goal or plan refinement invalidates the graph
- **中文** 当 stage 存在 dependencies 时，只有所有必要依赖 stage 达到 terminal success 或允许的 skip policy 后，该 stage 才能进入 ready；由 acceptance 驱动的 repair 或 verification rerun 只能运行负责失败的 phase 或 ready repair stages，除非 goal 或 plan refinement 使 graph 失效。
