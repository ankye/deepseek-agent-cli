## ADDED Requirements

### Requirement: Agent Loop Projects One Authoritative Next Action

The agent loop SHALL project exactly one authoritative next action into each governed staged model request.

agent loop 必须在每个受治理 staged model request 中投影且只投影一个权威 next action。

#### Scenario: Next action is derived from runtime state

- **WHEN** a governed staged workflow is ready to issue a model request
- **THEN** the runtime derives one next action from active stage control, accepted board evidence, previous dispatch result, convergence decision, failure-analysis next allowed action when present, and visible capability projection
- **AND** the next action class is one of `focused-evidence`, `mutation`, `standard-verification`, `package`, `failure-analysis`, `repair`, `rerun`, `blocker`, or `terminal-report`
- **AND** the model-visible request does not contain multiple same-priority candidate actions
- **中文** 当受治理 staged workflow 准备发起 model request 时，runtime 必须从 active stage control、已接受 board evidence、上一 dispatch result、convergence decision、存在时的 failure-analysis next allowed action 与 visible capability projection 中推导一个 next action；next action class 必须是 `focused-evidence`、`mutation`、`standard-verification`、`package`、`failure-analysis`、`repair`、`rerun`、`blocker` 或 `terminal-report` 之一；model-visible request 不得包含多个同优先级 candidate actions。

#### Scenario: Conflicts are suppressed before model dispatch

- **WHEN** stage policy, budget review, technical-director review, dispatch feedback, or board history suggest conflicting next actions
- **THEN** convergence chooses one authoritative next action before model dispatch
- **AND** suppressed candidates are recorded as bounded diagnostics on the decision board
- **AND** suppressed candidates are not projected as instructions to the child model
- **中文** 当 stage policy、budget review、technical-director review、dispatch feedback 或 board history 暗示相互冲突的 next actions 时，convergence 必须在 model dispatch 前选择一个权威 next action；被抑制候选必须作为有界 diagnostics 记录到 decision board；被抑制候选不得作为指令投影给 child model。

### Requirement: Agent Loop Has A Natural Fast Path For Simple Patch Tasks

The agent loop SHALL support a natural fast path for straightforward repository patch tasks without encoding task-specific shortcuts or hard step caps.

agent loop 必须支持直接仓库补丁任务的自然快路径，但不得编码 task-specific shortcuts 或 hard step caps。

#### Scenario: Fast path advances through accepted progress

- **WHEN** a staged repository patch task has accepted focused evidence
- **THEN** the next action may advance to mutation when mutation capabilities are visible and no accepted mutation evidence exists
- **AND** after accepted mutation evidence exists, the next action may advance to standard verification
- **AND** after accepted standard verification or typed verifier blocker exists, the next action may advance to package or terminal report according to the workflow contract
- **中文** 当 staged repository patch task 已有 accepted focused evidence 时，如果 mutation capabilities 可见且尚无 accepted mutation evidence，next action 可以推进到 mutation；当 accepted mutation evidence 存在后，next action 可以推进到 standard verification；当 accepted standard verification 或 typed verifier blocker 存在后，next action 可以按 workflow contract 推进到 package 或 terminal report。

#### Scenario: Fast path is not hardcoded to a benchmark

- **WHEN** a trajectory quality target expects a simple patch task to complete in a short effective path
- **THEN** the runtime MUST NOT enforce that target with task-number branches, known-patch checks, file-name shortcuts, provider-specific scheduler branches, scorer-specific success checks, or a fixed model-request cap
- **AND** the runtime reports deviation as trajectory evidence for scheduling analysis rather than as an automatic model-owned failure
- **中文** 当 trajectory quality target 期望简单补丁任务以短有效路径完成时，runtime 不得用 task-number branches、known-patch checks、file-name shortcuts、provider-specific scheduler branches、scorer-specific success checks 或固定 model-request cap 强制该目标；runtime 必须将偏离报告为用于调度分析的 trajectory evidence，而不是自动归因为模型侧失败。

### Requirement: Non-Progress Cannot Issue Ordinary Next Request

The agent loop SHALL NOT issue another ordinary model request after non-progress in produce or verify stages until convergence updates the decision board and projects a corrected next action.

agent loop 在 produce 或 verify stage 出现 non-progress 后，必须先由 convergence 更新 decision board 并投影纠正后的 next action，才能发起下一次普通 model request。

#### Scenario: Invalid verification command becomes corrected next action

- **WHEN** a verify stage rejects a model-requested test command because it is not a standard verification command for the active stage
- **THEN** dispatch produces exactly one bounded rejection feedback for the original tool-call id
- **AND** convergence records the invalid command and projects `standard-verification` as the authoritative next action when verification remains required
- **AND** another ordinary model request cannot expose arbitrary shell inspection as an equal alternative unless failure-analysis evidence changes the stage requirement
- **中文** 当 verify stage 因模型请求的 test command 不是当前 stage 的标准验证命令而拒绝时，dispatch 必须为原始 tool-call id 产生恰好一个有界 rejection feedback；convergence 必须记录 invalid command，并在仍需验证时将 `standard-verification` 投影为权威 next action；除非 failure-analysis evidence 改变 stage requirement，否则下一次普通 model request 不得把任意 shell inspection 暴露为同等替代。

#### Scenario: Repeated budget review cannot reset the stage loop

- **WHEN** a ready stage already emitted budget review feedback and still has no accepted progress evidence
- **THEN** the next transition is failure analysis, corrected next action, blocker, or terminal according to policy
- **AND** the loop does not reset the model-iteration counter in a way that grants another ordinary full stage budget
- **中文** 当 ready stage 已发出 budget review feedback 且仍无 accepted progress evidence 时，下一 transition 必须是 failure analysis、corrected next action、blocker 或 terminal；loop 不得通过重置 model-iteration counter 的方式再授予一轮完整普通 stage budget。
