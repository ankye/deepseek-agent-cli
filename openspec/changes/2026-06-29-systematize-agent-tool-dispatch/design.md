# Agent Tool Dispatch Design

## Architecture Model

The runtime SHALL separate four concerns:

runtime 必须分离四类职责：

1. **Task**: the concrete work item, user intent, workspace scope, acceptance target, and output contract.
   **Task**：具体工作项、用户意图、workspace scope、验收目标与 output contract。
2. **Profile**: role policy, workflow graph, allowed capabilities, stage budgets, stage acceptance mode, and projection policy.
   **Profile**：角色策略、workflow graph、allowed capabilities、stage budgets、stage acceptance mode 与 projection policy。
3. **Dispatch**: execution planning for model-requested tools, including capability resolution, batching, serial/concurrent policy, lifecycle ids, preflight, hook gate, kernel invocation, and result feedback.
   **Dispatch**：模型请求工具的执行计划，包括 capability resolution、batching、serial/concurrent policy、lifecycle ids、preflight、hook gate、kernel invocation 与 result feedback。
4. **Convergence**: loop-level decision making after model output or tool results, including continue, correction, review, retry, repair, terminal close, and bounded blocker routing.
   **Convergence**：模型输出或工具结果后的 loop-level 决策，包括 continue、correction、review、retry、repair、terminal close 与 bounded blocker routing。

Task/profile are not wasted work. They are the declarative control plane. Dispatch/convergence are the runtime data plane that makes those declarations execute predictably.

task/profile 不是无用层。它们是声明式控制面。dispatch/convergence 是运行时数据面，负责让这些声明可预测地执行。

## Dispatch Layer

The dispatch layer should be small, flat TypeScript modules rather than classes:

dispatch layer 应保持小而平的 TypeScript modules，而不是 class hierarchy：

- `agent-loop-tool-dispatch.ts`: pure policy helpers and dispatch request/result DTO builders.
- `agent-loop-tool-batches.ts`: partition model-requested tool calls into execution batches.
- `agent-loop-tool-executor.ts`: run a batch through preflight, workflow boundary checks, hooks, kernel execution, and feedback evidence.
- `agent-loop-convergence.ts`: choose loop transition after each model iteration or batch result.

Initial implementation may keep single-tool execution behavior while introducing batch DTOs. The key requirement is that the agent loop owns orchestration, while the dispatch layer owns tool execution decisions.

初始实现可以保留单工具执行行为，同时引入 batch DTO。关键要求是 agent loop 拥有整体编排，而 dispatch layer 拥有工具执行决策。

Dispatch MUST NOT decide loop continuation. It returns execution facts, terminal status, feedback, evidence, and retry eligibility. Convergence consumes those facts and decides whether the loop continues, retries with feedback, enters review/repair, reports a blocker, or closes terminally.

dispatch 不得决定 loop continuation。它只返回 execution facts、terminal status、feedback、evidence 与 retry eligibility。convergence 消费这些事实，并决定 loop 是继续、带反馈重试、进入 review/repair、报告 blocker，还是终态关闭。

## V1 Closure Target

V1 is not a partial feature. It is the smallest complete dispatch/convergence loop:

V1 不是半截功能，而是最小完整 dispatch/convergence 闭环：

- One model-requested tool call is converted into a dispatch item and a single-item batch.
- 一个模型请求的 tool call 会被转换成 dispatch item 与 single-item batch。
- Dispatch performs or rejects the tool through existing governed paths and returns exactly one bounded feedback record.
- dispatch 通过现有治理路径执行或拒绝该工具，并返回恰好一个有界 feedback record。
- Convergence consumes the dispatch result and returns an explicit transition: `continue`, `retry-with-feedback`, `review-required`, `repair-required`, or `terminal`.
- convergence 消费 dispatch result，并返回显式 transition：`continue`、`retry-with-feedback`、`review-required`、`repair-required` 或 `terminal`。
- Repeated rejected intent, ready-stage required-action misses, and non-progress stage tools cannot continue silently into another ordinary model request.
- repeated rejected intent、ready-stage required-action misses 与 non-progress stage tools 不能静默进入下一次普通 model request。
- Dispatch records terminal lifecycle evidence for success, rejection, cancellation, timeout, and abandoned execution.
- dispatch 为 success、rejection、cancellation、timeout 与 abandoned execution 记录 terminal lifecycle evidence。

V1 acceptance is measured by deterministic tests and a single first-task canary. The expected visible improvement is fewer unproductive model turns and earlier typed blocker/correction feedback.

V1 验收通过 deterministic tests 与单个第一题 canary 衡量。预期可见改进是减少无效模型轮次，并更早产生 typed blocker/correction feedback。

## Final Target

The final shape extends V1 without changing the boundary:

最终形态在不改变边界的前提下扩展 V1：

- Multi-tool batches support conservative read-only concurrency and serial mutation/process/network execution.
- multi-tool batches 支持保守的 read-only concurrency，以及 mutation/process/network 的串行执行。
- Streaming dispatch supports partial progress events, backpressure, stale-result quarantine, and resumable summaries.
- streaming dispatch 支持 partial progress events、backpressure、stale-result quarantine 与 resumable summaries。
- Retry policy uses typed failure classification, idempotency metadata, stage policy, and convergence decisions.
- retry policy 使用 typed failure classification、idempotency metadata、stage policy 与 convergence decisions。
- Workflow recovery consumes dispatch summaries after cancellation, timeout, provider fallback, process exit, or abandoned execution.
- workflow recovery 在 cancellation、timeout、provider fallback、process exit 或 abandoned execution 后消费 dispatch summaries。
- The agent loop remains a thin model-stream orchestrator and does not regain tool-specific branch sprawl.
- agent loop 保持为薄 model-stream orchestrator，不得重新膨胀为 tool-specific branch 集合。

## Scheduling Rules

Dispatch SHALL conservatively partition tools:

dispatch 必须保守地划分工具：

- Read-only/no-side-effect tools may be grouped into a concurrent batch only when manifests declare `sideEffect` as `none` or `read` and resource scopes do not conflict.
- 只有 manifest 声明 `sideEffect` 为 `none` 或 `read` 且 resource scopes 不冲突时，read-only/no-side-effect tools 才可进入 concurrent batch。
- Mutation, process, network, approval, hook, plugin, MCP, or unknown-side-effect tools MUST run serially.
- mutation、process、network、approval、hook、plugin、MCP 或 unknown-side-effect tools 必须串行执行。
- Batch execution MUST preserve model tool-call ids and produce exactly one model-facing result feedback per accepted or rejected tool call.
- batch execution 必须保留 model tool-call ids，并为每个 accepted 或 rejected tool call 产生恰好一个 model-facing result feedback。
- Aborted, fallback, or discarded attempts MUST prevent orphan tool results from being fed to a later model request.
- aborted、fallback 或 discarded attempts 必须防止 orphan tool results 被回灌到后续 model request。

## Convergence Rules

Convergence is not a budget reminder. It is a state transition decision.

收敛不是预算提醒，而是状态转移决策。

- Budget exhaustion SHALL route to review/correction/blocker states unless the caller requested a hard terminal limit.
- budget 耗尽必须路由到 review/correction/blocker 状态，除非 caller 请求 hard terminal limit。
- Repeated rejected intent SHALL force corrected input, different projected capability, or bounded blocker instead of allowing unbounded repetition.
- 重复 rejected intent 必须强制 corrected input、different projected capability 或 bounded blocker，不能无限重复。
- Ready-stage required-action misses SHALL feed a bounded correction message and then either retry through the normal model/tool loop or fail closed with durable evidence.
- ready-stage required-action miss 必须回灌有界 correction message，然后通过正常 model/tool loop retry，或以 durable evidence 安全失败。
- Non-progress tool batches in produce/verify stages SHALL update the decision board and convergence state before another model request is allowed.
- produce/verify 阶段的 non-progress tool batch 必须在允许下一次 model request 前更新 decision board 与 convergence state。

## Parent/Child Scheduling Board

Parent and child agents must share scheduling evidence, not model context.

parent 与 child agent 必须共享调度证据，而不是共享模型上下文。

### Isolation Boundary

These fields are agent-local and MUST NOT be shared as mutable state:

以下字段属于 agent-local，绝对不得作为可变状态共享：

| Field | Owner | Rule |
| --- | --- | --- |
| `sessionId` / `turnId` | each agent loop | Unique per parent or child run; lineage links are separate board records. |
| `workspaceRoot` | each agent or attempt | Child runs may use isolated checkouts; parent cannot execute child-scoped file operations directly. |
| model-visible `messages` and provider history | each agent loop | Never merge parent and child prompt histories. Share only bounded board summaries. |
| context projection and cache keys | each agent loop | Parent and child may share stable framework prefixes, but dynamic context windows stay separate. |
| visible tool projection | current profile/stage | Parent dispatch tools and child solve tools are computed independently from profile and stage policy. |
| raw provider reasoning | provider adapter / trace policy | Never written to the shared board. |
| unredacted tool output | capability execution scope | Board stores evidence refs and bounded previews only. |

| 字段 | 归属 | 规则 |
| --- | --- | --- |
| `sessionId` / `turnId` | 每个 agent loop | parent 或 child run 各自唯一；lineage 通过独立 board record 关联。 |
| `workspaceRoot` | 每个 agent 或 attempt | child run 可以使用隔离 checkout；parent 不得直接执行 child scope 的文件操作。 |
| model-visible `messages` 与 provider history | 每个 agent loop | 不得合并 parent 与 child prompt history；只能共享有界 board summaries。 |
| context projection 与 cache keys | 每个 agent loop | parent 与 child 可以共享稳定框架 prefix，但动态 context window 必须隔离。 |
| visible tool projection | 当前 profile/stage | parent dispatch tools 与 child solve tools 必须分别由 profile/stage policy 计算。 |
| raw provider reasoning | provider adapter / trace policy | 不得写入 shared board。 |
| 未脱敏 tool output | capability execution scope | board 只保存 evidence refs 与 bounded previews。 |

### Shared Boundary

These fields are durable scheduling evidence and MUST be shared through the board:

以下字段是 durable scheduling evidence，必须通过 board 共享：

| Field | Purpose |
| --- | --- |
| parent/child/attempt lineage ids | Reconstruct who spawned whom and which attempt produced evidence. |
| active stage id and stage status | Allow parent, child, and recovery logic to agree on workflow position. |
| dispatch batch summary | Preserve accepted/rejected tool calls, terminal kinds, diagnostics, and evidence refs. |
| convergence decision | Record why the loop continued, repaired, reran, blocked, or stopped. |
| failure-analysis record | Make attribution, evidence search, proof status, and next action replayable. |
| accepted evidence refs | Let later attempts consume proof without copying raw context. |
| next allowed action | Prevent blind restart from discovery when repair/change/verify is required. |

| 字段 | 用途 |
| --- | --- |
| parent/child/attempt lineage ids | 重建谁派生了谁，以及哪次 attempt 产出证据。 |
| active stage id 与 stage status | 让 parent、child 与 recovery logic 对 workflow 位置达成一致。 |
| dispatch batch summary | 保留 accepted/rejected tool calls、terminal kinds、diagnostics 与 evidence refs。 |
| convergence decision | 记录 loop 为什么 continue、repair、rerun、block 或 stop。 |
| failure-analysis record | 让 attribution、evidence search、proof status 与 next action 可 replay。 |
| accepted evidence refs | 让后续 attempt 消费证明，而不是复制 raw context。 |
| next allowed action | 当必须 repair/change/verify 时，防止盲目从 discovery 重启。 |

- Each agent run keeps its own session id, workspace root, prompt history, context projection, visible tool projection, and model request cache boundary.
- 每个 agent run 保持自己的 session id、workspace root、prompt history、context projection、visible tool projection 与 model request cache boundary。
- The durable board records lineage ids for parent run, child run, attempt, stage, dispatch batch, tool-call id, terminal event, and evidence refs.
- durable board 记录 parent run、child run、attempt、stage、dispatch batch、tool-call id、terminal event 与 evidence refs 的 lineage ids。
- Child stage events and dispatch summaries must be streamed or imported into the parent-visible board before the parent chooses repair, rerun, expansion, or stop.
- child stage events 与 dispatch summaries 必须先流式写入或导入 parent-visible board，然后 parent 才能选择 repair、rerun、expansion 或 stop。
- The board stores bounded summaries and evidence pointers only. It must not store raw provider reasoning or unredacted child context.
- board 只保存有界 summaries 与 evidence pointers。不得保存 raw provider reasoning 或未脱敏 child context。
- A new child attempt must start from the board's accepted next action. It must not blindly reset to the first discovery stage unless failure-analysis evidence proves the previous evidence is invalid.
- 新 child attempt 必须从 board 已接受的 next action 开始。除非 failure-analysis evidence 证明上一轮 evidence 无效，否则不得盲目重置到第一个 discovery stage。

## Failure Analysis Loop

Failure analysis is a required convergence phase, not a final prose summary.

failure analysis 是必需的 convergence phase，不是最终 prose summary。

Every failed, rejected, timed-out, unresolved, empty-artifact, or budget-exhausted attempt must produce a failure-analysis record before any rerun or repair attempt is allowed. The record must contain:

每个 failed、rejected、timed-out、unresolved、empty-artifact 或 budget-exhausted attempt 都必须先产出 failure-analysis record，才能允许 rerun 或 repair attempt。该 record 必须包含：

- failure class and terminal kind;
- failure class 与 terminal kind；
- candidate attribution: framework scheduling, tool availability, environment, harness/adapter, cache, prompt/reproduction, repair-feedback, model-owned, or inconclusive;
- candidate attribution：framework scheduling、tool availability、environment、harness/adapter、cache、prompt/reproduction、repair-feedback、model-owned 或 inconclusive；
- evidence queries required to prove or disprove each candidate attribution;
- 证明或反证每个 candidate attribution 所需的 evidence queries；
- accepted evidence refs and proof status: `unproven`, `proven`, `disproven`, or `inconclusive`;
- accepted evidence refs 与 proof status：`unproven`、`proven`、`disproven` 或 `inconclusive`；
- the next allowed action: repair, rerun, focused evidence query, environment escalation, bounded blocker, or stop with classification.
- next allowed action：repair、rerun、focused evidence query、environment escalation、bounded blocker 或 stop with classification。

Model-owned attribution is the last classification. It is allowed only when applicable framework scheduling, tool availability, environment, harness/adapter, cache, prompt/reproduction, and repair-feedback causes have explicit exclusion evidence.

model-owned attribution 是最后分类。只有适用的 framework scheduling、tool availability、environment、harness/adapter、cache、prompt/reproduction 与 repair-feedback 原因都有明确排除证据后，才能使用。

## Decision Authority

The technical-director role is a policy gate over evidence, not a second hidden implementation path.

technical-director role 是 evidence 上的 policy gate，不是第二条隐藏实现路径。

| Decision | Authority | Required input |
| --- | --- | --- |
| Execute a model-requested tool | dispatch layer | profile/stage constraints, preflight result, hooks, kernel policy. |
| Advance an automatic stage | convergence + workflow orchestration | completed dispatch evidence satisfying stage progress policy. |
| Accept a supervisor stage | technical-director policy | stage evaluation, accepted evidence refs, residual-risk record. |
| Start a child attempt | parent scheduler/convergence | board lineage, task/profile, accepted next allowed action. |
| Start repair/rerun | convergence | proven or inconclusive failure-analysis record with next action. |
| Attribute to model-owned behavior | technical-director policy | exclusion evidence for framework, tools, environment, harness/adapter, cache, prompt/reproduction, and repair-feedback. |
| Stop with classification | convergence + technical-director policy when supervised | terminal evidence, failure-analysis proof status, bounded final reason. |

| 决策 | 权限归属 | 必需输入 |
| --- | --- | --- |
| 执行模型请求工具 | dispatch layer | profile/stage constraints、preflight result、hooks、kernel policy。 |
| 推进 automatic stage | convergence + workflow orchestration | 满足 stage progress policy 的 completed dispatch evidence。 |
| 接受 supervisor stage | technical-director policy | stage evaluation、accepted evidence refs、residual-risk record。 |
| 启动 child attempt | parent scheduler/convergence | board lineage、task/profile、已接受 next allowed action。 |
| 启动 repair/rerun | convergence | 已证明或 inconclusive 的 failure-analysis record 与 next action。 |
| 归因为 model-owned behavior | technical-director policy | framework、tools、environment、harness/adapter、cache、prompt/reproduction 与 repair-feedback 的排除证据。 |
| 带分类停止 | convergence + supervised 时的 technical-director policy | terminal evidence、failure-analysis proof status、有界 final reason。 |

No layer may bypass this authority table by adding benchmark-specific branches, task-number branches, known-patch checks, or scorer-specific success shortcuts.

任何层都不得通过 benchmark-specific branches、task-number branches、known-patch checks 或 scorer-specific success shortcuts 绕过这张权限表。

## Robustness And Fault Tolerance

Dispatch robustness is a first-class responsibility. The dispatch layer must make every tool-call lifecycle terminal, replayable, and safe to resume.

dispatch 健壮性是一等职责。dispatch layer 必须让每个 tool-call lifecycle 都具备终态、可 replay，并且可安全恢复。

- Every accepted dispatch item MUST reach one of: `completed`, `failed`, `rejected`, `cancelled`, `timed-out`, or `abandoned`.
- 每个已接受 dispatch item 必须到达以下状态之一：`completed`、`failed`、`rejected`、`cancelled`、`timed-out` 或 `abandoned`。
- Timeout and cancellation MUST release in-progress state, detach stale result streams, and produce bounded feedback for the original tool-call id.
- timeout 与 cancellation 必须释放 in-progress state、隔离 stale result streams，并为原始 tool-call id 产生有界 feedback。
- Partial results MUST be recorded as evidence but MUST NOT be treated as successful progress unless the capability contract declares partial success semantics.
- partial results 必须记录为 evidence，但除非 capability contract 声明 partial success 语义，否则不得视为成功 progress。
- Retry eligibility MUST be derived from typed failure classification, side-effect safety, idempotency metadata, and stage policy.
- retry eligibility 必须由 typed failure classification、side-effect safety、idempotency metadata 与 stage policy 推导。
- Retry execution MUST be a convergence decision; dispatch may classify eligibility but must not schedule another model turn or repeat a tool by itself.
- retry execution 必须是 convergence decision；dispatch 可以分类 eligibility，但不得自行调度另一个 model turn 或重复执行工具。
- Stale or orphaned results from fallback, aborted, discarded, or superseded attempts MUST be quarantined and must not enter model-visible messages.
- fallback、aborted、discarded 或 superseded attempts 产生的 stale/orphaned results 必须被隔离，不得进入 model-visible messages。
- Dispatch summaries MUST record last progress marker, in-progress tool ids, terminal status, elapsed time, diagnostics, and evidence refs for recovery.
- dispatch summaries 必须记录 last progress marker、in-progress tool ids、terminal status、elapsed time、diagnostics 与 evidence refs，用于恢复。

## Migration Plan

1. Add contract tests for dispatch batch partitioning and convergence decisions.
2. 增加 dispatch batch partitioning 与 convergence decisions 的 contract tests。
3. Extract pure dispatch and convergence helpers from `agent-loop.ts`.
4. 从 `agent-loop.ts` 抽出纯 dispatch 与 convergence helpers。
5. Introduce single-tool batch DTOs without changing runtime event order.
6. 引入 single-tool batch DTO，保持 runtime event order 不变。
7. Move rejection/result feedback construction into the dispatch layer.
8. 将 rejection/result feedback construction 移入 dispatch layer。
9. Add multi-tool batch support only after deterministic tests prove serial/concurrent partitioning and orphan-result prevention.
10. 只有 deterministic tests 证明 serial/concurrent partitioning 与 orphan-result prevention 后，才加入 multi-tool batch support。
11. Add robustness tests for timeout, cancellation, partial result, stale result, retry eligibility, and durable dispatch summaries.
12. 增加 timeout、cancellation、partial result、stale result、retry eligibility 与 durable dispatch summaries 的健壮性测试。
13. Add shared-board and failure-analysis records, then route child attempt recovery through accepted next actions.
14. 增加 shared-board 与 failure-analysis records，然后通过已接受的 next actions 路由 child attempt recovery。
