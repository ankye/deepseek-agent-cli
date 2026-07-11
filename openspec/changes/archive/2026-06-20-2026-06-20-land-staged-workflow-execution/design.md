# Staged Workflow Execution Landing Design

## Architecture Review

The current architecture has the right layers, but the control handoff is incomplete.

1. CLI host selects a profile from the prompt.
2. Profile metadata compiles into a staged-task graph.
3. Prompt assembly exposes stable workflow guidance.
4. Tool projection and boundary guards constrain model-requested tools.
5. Stage progress is recorded after successful tool evidence.

The missing piece is between steps 2 and 4: a ready staged workflow must create an execution control record before the model call. That record must say what the active stage is, which capabilities can satisfy it, which capability is preferred when only one valid terminal route exists, what counts as progress, what happens if the model emits no tool call, and how the supervisor closes when the stage terminal capability completes.

当前架构层次是对的，但控制权交接不完整。

1. CLI host 从 prompt 选择 profile。
2. Profile metadata 编译为 staged-task graph。
3. Prompt assembly 暴露稳定 workflow guidance。
4. Tool projection 与 boundary guards 约束模型请求的工具。
5. 成功工具证据出现后记录 stage progress。

缺失点在第 2 步与第 4 步之间：ready staged workflow 必须在 model call 前创建 execution control record。该记录必须说明当前 active stage、哪些 capabilities 可以满足它、当只有一个合法 terminal route 时首选哪个 capability、什么算 progress、如果模型不发 tool-call 会发生什么，以及 stage terminal capability 完成后 supervisor 如何关闭。

## Root Cause

The profile and staged-task graph are treated as data attached to the model request, while the agent loop remains the real scheduler. Runtime guards only fire after a tool intent exists. A no-tool model turn therefore bypasses workflow execution semantics. This makes the system look architecturally complete in traces while still behaving like a generic conversational loop.

profile 与 staged-task graph 当前被当作附着在 model request 上的数据，而 agent loop 仍是真正 scheduler。runtime guard 只有在 tool intent 已经存在后才触发。因此无 tool-call 的模型轮次会绕过 workflow execution semantics。这会让 trace 看起来架构齐全，但行为仍像通用对话 loop。

## Target Control Flow

```text
user prompt
  -> task delivery intent classification
  -> CLI profile selection
  -> profile workflow compilation
  -> ready-stage control record
  -> prompt assembly with stable contract + dynamic required action
  -> model request
  -> tool intent or no-tool terminal/progress policy
  -> preflight + workflow boundary
  -> kernel capability execution
  -> stage progress events
  -> terminal workflow close or next ready stage
```

```text
用户 prompt
  -> task delivery intent classification
  -> CLI profile selection
  -> profile workflow compilation
  -> ready-stage control record
  -> prompt assembly 加入稳定 contract 与动态 required action
  -> model request
  -> tool intent 或 no-tool terminal/progress policy
  -> preflight + workflow boundary
  -> kernel capability execution
  -> stage progress events
  -> terminal workflow close 或下一个 ready stage
```

## Execution Checklist

This checklist is the architecture director gate. Implementation cannot claim benchmark readiness until each item has deterministic coverage and runtime evidence.

这是架构负责人 gate。每一项都必须有确定性覆盖与 runtime evidence，否则不能宣称 benchmark readiness。

- Intent/profile selected: the run records task intent, selected profile id, workflow graph id, role, priority, and orchestration mode before model dispatch.
- Profile compiled: the run records compiled staged-task graph fingerprint, stage count, ready stage ids, allowed capability ids, and initial run state.
- Ready-stage control created: the run records the active ready stage, required/progress capabilities, preferred capability when applicable, no-tool policy, and terminal-close policy.
- Prompt contract emitted: stable task-intent contract is in stable prompt sections; dynamic ready-stage required action is outside the stable provider prefix.
- Tool projection enforced: governed primary workflow projection is restricted to compiled workflow capabilities and fails closed when empty.
- Boundary enforced: a model tool outside the compiled primary workflow boundary is rejected before kernel execution.
- No-tool iteration governed: when a required action exists, a model response without a tool call emits a typed no-progress event and hits retry/terminal policy instead of silently consuming generic loop budget.
- Stage progress evidence-driven: stage state advances only from completion-grade governed tool evidence.
- Stage evaluation required: every stage records an evaluation result for its outputs and evidence before it can be marked succeeded; output existence alone is not acceptance.
- Technical director acceptance required: each stage/pipeline evaluation records an explicit technical-director acceptance decision confirming the acceptance criteria, evidence sufficiency, and pass/fail disposition before success is final.
- Terminal capability closes supervisor: a terminal workflow capability success, failure, cancellation, or execution rejection captures structured result evidence and closes the outer loop exactly once with a matching completed or failed status.
- Timeout inheritance enforced: nested capability, child process, provider stream, and stage deadlines are capped by the caller deadline.
- Stall recovery durable: provider stream stall, child process stall, missing terminal trace, or timeout emits typed terminal events plus durable summary/progress artifacts.
- Diagnostics classify architecture failures: missing profile, projection empty, no required action, no-tool required-action miss, child no-terminal, timeout inflation, and terminal-tool continued are stable reason codes.

- Intent/profile 已选择：run 在 model dispatch 前记录 task intent、selected profile id、workflow graph id、role、priority 与 orchestration mode。
- Profile 已编译：run 记录 compiled staged-task graph fingerprint、stage count、ready stage ids、allowed capability ids 与初始 run state。
- Ready-stage control 已创建：run 记录 active ready stage、required/progress capabilities、适用时的 preferred capability、no-tool policy 与 terminal-close policy。
- Prompt contract 已发出：稳定 task-intent contract 位于 stable prompt sections；动态 ready-stage required action 位于 stable provider prefix 之外。
- Tool projection 已强制：governed primary workflow projection 限制在 compiled workflow capabilities 内，且为空时 fail closed。
- Boundary 已强制：模型请求 compiled primary workflow boundary 外工具时，在 kernel execution 前拒绝。
- No-tool iteration 受治理：存在 required action 时，模型无 tool-call 响应必须发出 typed no-progress event 并触发 retry/terminal policy，而不是静默消耗通用 loop budget。
- Stage progress 由证据驱动：stage state 只能从 completion-grade governed tool evidence 推进。
- Stage evaluation 必需：每个 stage 在标记 succeeded 前必须记录对其输出与证据的 evaluation result；仅有输出不等于验收通过。
- 技术总监验收必需：每个 stage/pipeline evaluation 必须记录显式的技术总监验收决定，确认验收标准、证据充分性与通过/失败结论后，成功才算最终成立。
- Terminal capability 关闭 supervisor：terminal workflow capability 成功、失败、取消或执行拒绝后，必须捕获结构化 result evidence，并以匹配的 completed 或 failed 状态让 outer loop 只关闭一次。
- Timeout inheritance 已强制：嵌套 capability、child process、provider stream 与 stage deadline 受 caller deadline 上限约束。
- Stall recovery 可持久复盘：provider stream stall、child process stall、missing terminal trace 或 timeout 都发出 typed terminal events，并写 durable summary/progress artifacts。
- Diagnostics 能归类架构失败：missing profile、projection empty、no required action、no-tool required-action miss、child no-terminal、timeout inflation 与 terminal-tool continued 都是稳定 reason codes。

## Implementation Shape

Prefer small generic additions over benchmark branching.

- Add a runtime function that derives ready-stage control from `AgentLoopProfilePolicyMetadata.stagedTaskWorkflow`.
- Thread the control record into prompt assembly metadata and provider request audit.
- Tighten governed workflow projection so empty projection is a terminal architecture error for primary governed workflows.
- Add no-tool required-action handling in the model iteration loop.
- Mark terminal workflow capabilities in profile/control metadata instead of hard-coding benchmark task ids.
- Cap `toolTimeoutFor` and child capability deadlines by the outer request deadline.
- Add child/stage watchdog summaries at the capability boundary where the supervisor owns progress ledgers.
- Add a generic stage evaluation adapter that turns stage outputs, evidence refs, diagnostics, and acceptance policy into `passed`, `needs-review`, `failed`, or `blocked` before state transition.

优先做小型通用补强，不做 benchmark 分支。

- 增加 runtime 函数，从 `AgentLoopProfilePolicyMetadata.stagedTaskWorkflow` 推导 ready-stage control。
- 将 control record 传入 prompt assembly metadata 与 provider request audit。
- 收紧 governed workflow projection，使 primary governed workflow 的空 projection 成为 terminal architecture error。
- 在 model iteration loop 增加 required-action no-tool 处理。
- 在 profile/control metadata 中标记 terminal workflow capability，而不是硬编码 benchmark task id。
- 用 outer request deadline 限制 `toolTimeoutFor` 与 child capability deadline。
- 在 supervisor 拥有 progress ledger 的 capability boundary 增加 child/stage watchdog summary。
- 增加通用 stage evaluation adapter，在状态迁移前把 stage outputs、evidence refs、diagnostics 与 acceptance policy 评估为 `passed`、`needs-review`、`failed` 或 `blocked`。

## Ownership Boundary

- CLI host tests own command parsing, output rendering, host/runtime wiring, and one thin smoke that proves a selected governed capability is projected to the model.
- Host profile tests own intent/profile selection and profile workflow compilation, including the rule that ordinary coding prompts remain advisory while evaluation prompts compile primary staged workflows.
- Runtime tests own ready-stage control, required-action no-tool policy, governed projection failure, terminal capability close, timeout inheritance, and generic staged workflow behavior.
- Benchmark capability tests own SWE-bench command construction, diagnostics, child trace parsing, and harness-specific evidence. They do not define scheduler semantics.
- Broad CLI smoke tests must not carry benchmark orchestration assertions such as staged graph shape, history trimming policy, or profile compilation details. Those are profile/runtime contracts.

## Ownership Boundary / 所有权边界

- CLI host 测试负责命令解析、输出渲染、host/runtime 接线，以及一个薄烟测来证明选中的 governed capability 会投影给模型。
- Host profile 测试负责 intent/profile selection 与 profile workflow compilation，包括普通 coding prompt 保持 advisory、evaluation prompt 编译 primary staged workflow 的规则。
- Runtime 测试负责 ready-stage control、required-action no-tool policy、governed projection failure、terminal capability close、timeout inheritance 与通用 staged workflow 行为。
- Benchmark capability 测试负责 SWE-bench 命令构造、diagnostics、child trace parsing 与 harness-specific evidence。它们不定义 scheduler 语义。
- 宽泛 CLI smoke 测试不得承载 benchmark orchestration 断言，例如 staged graph shape、history trimming policy 或 profile compilation 细节；这些属于 profile/runtime contract。

## Risks

The main risk is over-constraining exploratory coding workflows. The mitigation is to apply required-action no-tool policy only when a primary staged workflow has a ready-stage control record. General coding profiles can remain advisory until they opt into primary staged workflow enforcement.

主要风险是过度限制探索型 coding workflow。缓解方式是：只有 primary staged workflow 具备 ready-stage control record 时，才应用 required-action no-tool policy。普通 coding profile 在选择加入 primary staged workflow enforcement 前可以保持建议性。
