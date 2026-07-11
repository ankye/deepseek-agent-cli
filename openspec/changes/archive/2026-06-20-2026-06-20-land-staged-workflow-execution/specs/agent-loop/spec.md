## ADDED Requirements

### Requirement: Agent Loop Enforces Required Workflow Actions / Agent Loop 强制工作流必需动作

When a primary staged workflow has a ready-stage control record, the agent loop SHALL enforce the required action semantics instead of treating the turn as unconstrained conversational planning.

当 primary staged workflow 具备 ready-stage control record 时，agent loop 必须强制执行 required action 语义，而不得把该轮当成无约束对话规划。

#### Scenario: Required action is visible before model dispatch / 必需动作在模型派发前可见

- **WHEN** ready-stage control exists for a model iteration
- **THEN** `prompt.assembled`, `model.requested`, and provider request audit metadata include a bounded summary of the active stage and required/progress action
- **AND** stable task intent/profile contract remains separate from dynamic run state so provider cache evidence can distinguish static and dynamic regions
- **中文** 当某次模型迭代存在 ready-stage control 时，`prompt.assembled`、`model.requested` 与 provider request audit metadata 必须包含 active stage 与 required/progress action 的有界摘要；稳定 task intent/profile contract 必须与动态 run state 分离，使 provider cache evidence 能区分静态与动态区域。

#### Scenario: No-tool model turn cannot consume workflow budget silently / 无工具模型轮次不得静默消耗工作流预算

- **WHEN** a required workflow action exists
- **AND** the model response contains no tool call and no accepted terminal blocker
- **THEN** the agent loop emits a typed no-progress event with workflow graph id, stage id, required action, model request count, and retry policy
- **AND** the loop either gives one bounded corrective feedback turn or fails closed according to the ready-stage control policy
- **AND** it MUST NOT continue indefinitely until the generic model-iteration budget is exhausted
- **中文** 当存在 required workflow action，且模型响应没有 tool call 也没有被接受的 terminal blocker 时，agent loop 必须发出 typed no-progress event，包含 workflow graph id、stage id、required action、model request count 与 retry policy；loop 必须按 ready-stage control policy 给出一次有界纠偏反馈或安全失败；不得一直运行到通用 model-iteration budget 耗尽。

### Requirement: Terminal Workflow Capabilities Close The Supervisor / 终端工作流 Capability 关闭 Supervisor

The agent loop SHALL close exactly once when a terminal workflow capability succeeds, fails, is cancelled, or is rejected during execution, after recording structured stage and tool result evidence.

terminal workflow capability 成功、失败、取消或执行拒绝后，agent loop 必须在记录结构化 stage 与 tool result evidence 后恰好关闭一次。

#### Scenario: Terminal capability outcome stops outer loop / Terminal Capability 产生结果后停止外层 Loop

- **WHEN** a ready-stage control marks a capability as terminal for the supervising workflow
- **AND** that capability returns a governed kernel terminal outcome
- **THEN** the agent loop records the tool result evidence, advances or closes the workflow stage where applicable, emits terminal workflow events, and emits one terminal agent-loop event with matching success or failure status
- **AND** it does not request another model iteration merely to summarize the terminal result
- **中文** 当 ready-stage control 将某个 capability 标记为 supervising workflow 的 terminal capability，且该 capability 返回受管 kernel terminal outcome 时，agent loop 必须记录 tool result evidence、在适用时推进或关闭 workflow stage、发出 terminal workflow events，并以匹配的成功或失败状态发出一个 agent-loop terminal event；不得仅为了总结 terminal result 再请求一次模型。

### Requirement: Caller Deadline Caps Nested Work / Caller Deadline 限制嵌套工作

The agent loop SHALL cap model-requested tool timeouts, nested capability deadlines, and child process deadlines by the caller's remaining deadline.

agent loop 必须用 caller 剩余 deadline 限制模型请求的 tool timeout、嵌套 capability deadline 与 child process deadline。

#### Scenario: Model timeout cannot inflate caller deadline / 模型 Timeout 不能放大 Caller Deadline

- **WHEN** a model tool input requests a timeout greater than the caller deadline or remaining stage deadline
- **THEN** preflight or runtime timeout normalization caps the nested timeout to the smaller remaining deadline
- **AND** the runtime records the requested timeout, capped timeout, caller deadline, and reason
- **AND** long-running manifest defaults may raise too-short tool inputs only up to the caller deadline, never beyond it
- **中文** 当模型 tool input 请求的 timeout 大于 caller deadline 或剩余 stage deadline 时，preflight 或 runtime timeout normalization 必须把嵌套 timeout 限制为较小的剩余 deadline；runtime 必须记录 requested timeout、capped timeout、caller deadline 与原因；long-running manifest default 可以把过短 tool input 提升到 caller deadline 内，但绝不能超过 caller deadline。
