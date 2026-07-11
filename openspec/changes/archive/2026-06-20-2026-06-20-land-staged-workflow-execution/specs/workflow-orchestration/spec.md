## ADDED Requirements

### Requirement: Governed Workflow Projection Fails Closed / 受治理工作流投影安全失败

The workflow orchestration layer SHALL fail closed when a primary governed workflow cannot project its declared capabilities into the model-visible tool set.

当 primary governed workflow 无法把声明的 capabilities 投影到 model-visible tool set 时，workflow orchestration layer 必须安全失败。

#### Scenario: Empty governed projection is an architecture error / 空受治理投影是架构错误

- **WHEN** a selected profile is governed, evaluation-owned, anti-tailoring, or otherwise marked as a primary staged workflow
- **AND** the compiled workflow declares allowed capabilities
- **AND** model-visible projection yields no matching executable capability
- **THEN** the runtime emits a stable workflow projection diagnostic and does not fall back to exposing unrelated capabilities
- **中文** 当所选 profile 是 governed、evaluation-owned、anti-tailoring，或以其他方式标记为 primary staged workflow，且 compiled workflow 声明了 allowed capabilities，但 model-visible projection 没有得到匹配的 executable capability 时，runtime 必须发出稳定 workflow projection diagnostic，不得回退暴露无关 capabilities。

#### Scenario: Boundary rejection remains before kernel execution / Boundary 拒绝发生在 Kernel Execution 前

- **WHEN** a model requests a capability outside the compiled primary workflow boundary
- **THEN** the workflow boundary guard rejects the request before kernel execution with profile id, workflow graph id, rejected capability id, and allowed capability ids
- **AND** the rejection updates ready-stage control feedback rather than clearing the required action
- **中文** 当模型请求 compiled primary workflow boundary 外的 capability 时，workflow boundary guard 必须在 kernel execution 前拒绝，并包含 profile id、workflow graph id、rejected capability id 与 allowed capability ids；该拒绝必须更新 ready-stage control feedback，而不是清除 required action。

### Requirement: Workflow Stalls Are Durable Terminal Evidence / 工作流卡住产生可持久终态证据

Workflow orchestration SHALL convert child/stage stalls, provider stream stalls, missing terminal traces, and timeout exits into durable terminal evidence.

workflow orchestration 必须将 child/stage stall、provider stream stall、missing terminal trace 与 timeout exit 转换为可持久复盘的终态证据。

#### Scenario: Child run without terminal trace is summarized / 无终态 Trace 的 Child Run 被汇总

- **WHEN** a supervised child or stage execution starts
- **AND** it exits, stalls, times out, or is cancelled without producing the expected terminal agent-loop event
- **THEN** the supervisor writes a durable summary with stage id, child run id, model request count when known, tool call count when known, last progress marker, terminal reason, diagnostics, and artifact paths
- **AND** the parent workflow records the summary as failed or blocked evidence instead of leaving only a partial progress ledger
- **中文** 当受监督 child 或 stage execution 启动后，在没有产生预期 agent-loop terminal event 的情况下退出、卡住、超时或取消时，supervisor 必须写入 durable summary，包含 stage id、child run id、已知 model request count、已知 tool call count、last progress marker、terminal reason、diagnostics 与 artifact paths；parent workflow 必须把该 summary 记录为 failed 或 blocked evidence，而不是只留下半截 progress ledger。

### Requirement: Pipeline Steps Have Evaluation Gates / Pipeline Step 具备评估 Gate

Workflow pipelines SHALL evaluate each step output before allowing downstream steps to treat the output as accepted input.

workflow pipeline 必须在允许下游 step 将输出作为已验收输入之前，对每个 step output 执行评估。

#### Scenario: Downstream consumes accepted refs only / 下游只消费已验收引用

- **WHEN** a pipeline step produces refs for a downstream step
- **THEN** the pipeline records a step evaluation result before those refs become accepted inputs
- **AND** downstream execution may consume `passed` refs normally, may consume `needs-review` refs only when the downstream policy explicitly allows review-state inputs, and MUST NOT consume `failed` or `blocked` refs as successful inputs
- **中文** 当 pipeline step 为下游 step 产出 refs 时，pipeline 必须先记录 step evaluation result，这些 refs 才能成为已验收输入；下游可正常消费 `passed` refs，只有在下游 policy 明确允许 review-state input 时才可消费 `needs-review` refs，且不得把 `failed` 或 `blocked` refs 当作成功输入消费。

#### Scenario: Downstream waits for technical-director acceptance / 下游等待技术总监验收

- **WHEN** a pipeline step evaluation returns `passed`
- **AND** no technical-director acceptance record has accepted that evaluation
- **THEN** downstream steps that require accepted input remain blocked
- **AND** the pipeline records the block reason as `TECHNICAL_DIRECTOR_ACCEPTANCE_MISSING`
- **中文** 当 pipeline step evaluation 返回 `passed`，但没有技术总监验收记录接受该 evaluation 时，需要已验收输入的下游 step 必须保持 blocked；pipeline 必须将阻塞原因记录为 `TECHNICAL_DIRECTOR_ACCEPTANCE_MISSING`。
