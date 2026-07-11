## ADDED Requirements

### Requirement: Agent Loop Delegates Tool Dispatch

The agent loop SHALL delegate model-requested tool execution to a runtime-owned dispatch layer that plans tool batches, preserves tool-call identity, performs governed preflight and execution, and returns bounded result feedback.

agent loop 必须将模型请求的工具执行委托给 runtime-owned dispatch layer。该层负责规划 tool batches、保留 tool-call identity、执行受治理 preflight 与 execution，并返回有界 result feedback。

#### Scenario: Tool call becomes dispatch request

- **WHEN** the model emits a tool call
- **THEN** the agent loop resolves the provider tool name to a capability id, records the intent, and creates a dispatch request with tool-call id, provider tool name, resolved capability id, normalized input hash, iteration, visible capabilities, workflow/profile context, and limits
- **AND** capability execution is performed by the dispatch layer through existing preflight, hook, kernel, policy, scheduler, resource-lock, and evidence paths
- **中文** 当模型发出 tool call 时，agent loop 必须将 provider tool name 解析为 capability id、记录 intent，并创建包含 tool-call id、provider tool name、resolved capability id、normalized input hash、iteration、visible capabilities、workflow/profile context 与 limits 的 dispatch request；capability execution 必须由 dispatch layer 通过现有 preflight、hook、kernel、policy、scheduler、resource-lock 与 evidence paths 执行。

#### Scenario: Rejection still feeds bounded tool result

- **WHEN** dispatch rejects a tool call because of tool-call budget, repeated rejected intent, preflight, workflow boundary, output contract, required action, hook block, policy denial, timeout, or cancellation
- **THEN** exactly one bounded model-facing tool result feedback is produced for the original tool-call id
- **AND** the decision board records the rejection reason, corrective action, recommended next action, and replayable evidence id
- **中文** 当 dispatch 因 tool-call budget、repeated rejected intent、preflight、workflow boundary、output contract、required action、hook block、policy denial、timeout 或 cancellation 拒绝 tool call 时，必须为原始 tool-call id 产生恰好一个有界 model-facing tool result feedback；decision board 必须记录 rejection reason、corrective action、recommended next action 与 replayable evidence id。

### Requirement: Agent Loop Uses Explicit Convergence Decisions

The agent loop SHALL apply explicit convergence decisions after model output and after each dispatch result instead of embedding stop/continue/retry behavior only inside tool-specific branches.

agent loop 必须在 model output 后和每个 dispatch result 后应用显式 convergence decisions，而不是只把 stop/continue/retry 行为嵌入各个 tool-specific branches。

#### Scenario: Budget exhaustion routes to review

- **WHEN** a stage or turn budget is consumed
- **THEN** convergence returns a review/correction/blocker transition unless the active policy declares a hard terminal limit
- **AND** the next model-visible message explains the required next action or bounded blocker path
- **中文** 当 stage 或 turn budget 被消耗完时，convergence 必须返回 review/correction/blocker transition，除非 active policy 声明 hard terminal limit；下一条 model-visible message 必须解释 required next action 或 bounded blocker path。

#### Scenario: Budget review cannot become an unbounded ordinary loop

- **WHEN** a ready-stage budget has already emitted review feedback and the same stage reaches the same budget again without accepted progress evidence
- **THEN** convergence SHALL fail closed or enter typed failure analysis with durable evidence
- **AND** the loop MUST NOT issue another ordinary model/tool cycle for that stage
- **中文** 当 ready-stage budget 已经发出 review feedback，而同一 stage 在没有 accepted progress evidence 的情况下再次达到同一预算时，convergence 必须安全失败或进入带 durable evidence 的类型化 failure analysis；loop 不得继续为该 stage 发起普通 model/tool cycle。

#### Scenario: Non-progress repetition cannot continue silently

- **WHEN** the decision board shows repeated non-progress, repeated rejected intent, or repeated ready-stage required-action misses
- **THEN** convergence requires corrected input, a different projected capability, a required progress capability, repair, or a bounded blocker
- **AND** the loop does not issue another ordinary model request without that convergence feedback
- **中文** 当 decision board 显示 repeated non-progress、repeated rejected intent 或 repeated ready-stage required-action misses 时，convergence 必须要求 corrected input、different projected capability、required progress capability、repair 或 bounded blocker；loop 不得在没有该 convergence feedback 的情况下发起下一次普通 model request。

#### Scenario: Produce stage progress remains mutation-centered

- **WHEN** a supervisor-reviewed produce, materialize, or repair stage is still the active stage
- **THEN** its progress capabilities SHALL remain visible workspace mutation capabilities from that stage, such as file edit or patch apply, when such capabilities are available
- **AND** downstream verification, score, or review tools MUST NOT replace those mutation progress capabilities before accepted mutation evidence advances the workflow
- **中文** 当 supervisor-reviewed 的 produce、materialize 或 repair stage 仍是 active stage 时，只要该 stage 有可用 workspace mutation capabilities，其 progress capabilities 必须保持为该 stage 的 mutation capabilities，例如 file edit 或 patch apply；在 accepted mutation evidence 推进 workflow 前，下游 verification、score 或 review tools 不得替代这些 mutation progress capabilities。

#### Scenario: Collect evidence requires focused repository evidence

- **WHEN** a collect-evidence stage is ready in a governed repository workflow
- **THEN** broad workspace discovery such as listing `.`, `/`, an empty path, `**`, or `**/*` SHALL NOT complete the stage by itself
- **AND** focused evidence such as reading a non-root file, searching a non-trivial pattern in a focused path, using a non-trivial glob, or collecting an accepted diff MAY complete the stage according to stage policy
- **AND** the workflow MUST keep discovery tools active until focused evidence exists instead of advancing to a mutation-only stage with insufficient source context
- **中文** 当 governed repository workflow 中的 collect-evidence stage 处于 ready 状态时，列出 `.`, `/`, 空路径、`**` 或 `**/*` 这类宽泛 workspace discovery 不得单独完成该 stage；读取非根文件、在聚焦路径搜索非平凡 pattern、使用非平凡 glob，或收集已接受 diff 等聚焦 evidence 可按 stage policy 完成该 stage；workflow 必须在存在聚焦 evidence 前保持 discovery tools 可用，而不是在源码上下文不足时推进到 mutation-only stage。

#### Scenario: Simple-task trajectory quality is supervised, not hardcoded

- **WHEN** an external supervisor or acceptance rubric identifies a simple patch task whose effective solution path should naturally be short, such as inspect target file, mutate source, add or run focused test, verify, and report evidence
- **THEN** the CLI MUST NOT encode that expected step count as a runtime loop cap, task-number branch, known-answer shortcut, benchmark-specific patch, or scorer-specific heuristic
- **AND** if the actual trajectory repeatedly performs discovery, produces contradictory tool evidence, or reaches budget without source mutation or required progress evidence, convergence treats that as a framework/tool/scheduling defect candidate and enters failure analysis
- **AND** the failure-analysis record searches evidence for tool availability, workspace binding, path resolution, stage constraints, model-visible feedback, and environment causes before any model-owned attribution is allowed
- **中文** 当外部 supervisor 或 acceptance rubric 判断某个简单 patch task 的有效解题路径天然应较短，例如 inspect target file、mutate source、add/run focused test、verify 与 report evidence 时，CLI 不得把该预期步数编码为 runtime loop cap、task-number branch、known-answer shortcut、benchmark-specific patch 或 scorer-specific heuristic；如果实际轨迹反复 discovery、产生矛盾工具证据，或在没有 source mutation / required progress evidence 的情况下耗尽预算，convergence 必须把它作为 framework/tool/scheduling defect candidate 进入 failure analysis；failure-analysis record 必须先搜索 tool availability、workspace binding、path resolution、stage constraints、model-visible feedback 与 environment 证据，然后才允许 model-owned attribution。

### Requirement: Agent Loop Standardizes Failure Analysis

The agent loop SHALL treat failure analysis, attribution, evidence search, proof, and continue/rerun selection as a typed convergence workflow rather than prose-only diagnostics.

agent loop 必须把 failure analysis、attribution、evidence search、proof 与 continue/rerun selection 作为类型化 convergence workflow，而不是仅作为 prose diagnostics。

#### Scenario: Failed attempt enters analysis before rerun

- **WHEN** an attempt fails, is rejected, times out, exhausts budget, produces an empty required artifact, or returns unresolved evaluation evidence
- **THEN** convergence records a failure-analysis item with attempt id, stage id, terminal kind, preliminary failure class, candidate attributions, required evidence queries, and blocked next actions
- **AND** another repair or rerun attempt is not allowed until the analysis item is proven, disproven, or explicitly marked inconclusive with bounded residual risk
- **中文** 当 attempt 失败、被拒绝、超时、耗尽预算、产出空 required artifact，或返回 unresolved evaluation evidence 时，convergence 必须记录包含 attempt id、stage id、terminal kind、preliminary failure class、candidate attributions、required evidence queries 与 blocked next actions 的 failure-analysis item；在该 analysis item 被证明、反证，或带有有界 residual risk 标记为 inconclusive 前，不得允许另一个 repair 或 rerun attempt。

#### Scenario: Attribution requires exclusion evidence

- **WHEN** convergence considers model-owned attribution
- **THEN** it first requires exclusion evidence for framework scheduling, tool availability, environment, harness or adapter, cache, prompt or reproduction, and repair-feedback categories where those categories are applicable
- **AND** missing exclusion evidence routes to `search-evidence` or `prove-attribution`, not `blocked-by-model`
- **中文** 当 convergence 考虑 model-owned attribution 时，必须先要求 framework scheduling、tool availability、environment、harness 或 adapter、cache、prompt 或 reproduction、repair-feedback 等适用类别的排除证据；缺少排除证据时必须路由到 `search-evidence` 或 `prove-attribution`，不得直接归为 `blocked-by-model`。

#### Scenario: Continue decision consumes proven attribution

- **WHEN** a failure-analysis item has proven attribution and accepted evidence refs
- **THEN** convergence chooses exactly one next transition: repair required, rerun allowed, stop with classification, escalate environment, or report bounded blocker
- **AND** the next model-visible request includes only bounded evidence summaries and required next action, not raw unrelated trace history
- **中文** 当 failure-analysis item 具备已证明 attribution 与已接受 evidence refs 时，convergence 必须只选择一个下一步 transition：repair required、rerun allowed、stop with classification、escalate environment 或 report bounded blocker；下一次 model-visible request 只能包含有界 evidence summaries 与 required next action，不得包含无关 raw trace history。

### Requirement: Parent And Child Agents Share A Durable Board

Parent and child agent runs SHALL write scheduling decisions, dispatch summaries, stage progress, failure analysis, and accepted evidence refs to a shared durable board while preserving independent model contexts.

parent 与 child agent run 必须把 scheduling decisions、dispatch summaries、stage progress、failure analysis 与 accepted evidence refs 写入共享 durable board，同时保持独立 model contexts。

#### Scenario: Shared board does not merge contexts

- **WHEN** a parent run dispatches a child run
- **THEN** the child run uses its own session id, workspace root, prompt history, context projection, and visible tool projection
- **AND** the shared board records lineage ids linking parent run, child run, attempt, stage, dispatch batch, tool-call id, terminal event, and evidence refs
- **AND** board entries contain bounded summaries and evidence pointers, not raw child provider reasoning or unredacted child context
- **中文** 当 parent run dispatch child run 时，child run 必须使用自己的 session id、workspace root、prompt history、context projection 与 visible tool projection；共享 board 必须记录连接 parent run、child run、attempt、stage、dispatch batch、tool-call id、terminal event 与 evidence refs 的 lineage ids；board entries 只能包含有界 summaries 与 evidence pointers，不得包含 raw child provider reasoning 或未脱敏 child context。

#### Scenario: Isolation and sharing are explicit

- **WHEN** parent and child runs are active for one task
- **THEN** mutable session ids, workspace roots, model-visible messages, provider history, context projections, visible tool projections, raw provider reasoning, and unredacted tool output remain isolated per agent run
- **AND** lineage ids, active stage, dispatch summaries, convergence decisions, failure-analysis records, accepted evidence refs, and next allowed action are shared only through the durable board
- **中文** 当 parent 与 child run 同时服务一个任务时，可变的 session ids、workspace roots、model-visible messages、provider history、context projections、visible tool projections、raw provider reasoning 与未脱敏 tool output 必须按 agent run 隔离；lineage ids、active stage、dispatch summaries、convergence decisions、failure-analysis records、accepted evidence refs 与 next allowed action 只能通过 durable board 共享。

#### Scenario: Decision authority is not bypassed

- **WHEN** a parent, child, workflow, dispatch, convergence, or technical-director component makes a scheduling decision
- **THEN** tool execution belongs to dispatch, stage advancement belongs to workflow orchestration plus convergence evidence, repair/rerun/stop belongs to convergence, and supervisor acceptance plus model-owned attribution belong to technical-director policy
- **AND** no component may replace those authorities with benchmark-specific branches, task-number branches, known-patch checks, or scorer-specific success shortcuts
- **中文** 当 parent、child、workflow、dispatch、convergence 或 technical-director component 做调度决策时，工具执行归 dispatch，stage advancement 归 workflow orchestration 与 convergence evidence，repair/rerun/stop 归 convergence，supervisor acceptance 与 model-owned attribution 归 technical-director policy；任何 component 都不得用 benchmark-specific branches、task-number branches、known-patch checks 或 scorer-specific success shortcuts 替代这些权限。

#### Scenario: Child failure feeds parent scheduling

- **WHEN** a child attempt reaches a terminal failed, rejected, timed-out, unresolved, or empty-artifact state
- **THEN** its dispatch summaries and failure-analysis item are imported into the parent-visible board before the parent chooses repair, rerun, expansion, or stop
- **AND** the next child attempt starts from the board's accepted next action rather than resetting blindly to the first discovery stage
- **中文** 当 child attempt 到达 failed、rejected、timed-out、unresolved 或 empty-artifact 终态时，其 dispatch summaries 与 failure-analysis item 必须先导入 parent-visible board，然后 parent 才能选择 repair、rerun、expansion 或 stop；下一次 child attempt 必须从 board 已接受的 next action 开始，而不是盲目重置到第一个 discovery stage。

### Requirement: Task And Profile Remain Declarative Control Plane

Task and profile artifacts SHALL remain declarative control-plane inputs and SHALL NOT be treated as substitutes for runtime dispatch or convergence.

task 与 profile artifacts 必须保持声明式控制面输入，不得被当作 runtime dispatch 或 convergence 的替代品。

#### Scenario: Profile constrains dispatch but does not execute

- **WHEN** a profile declares workflow stages, allowed tools, progress capabilities, budgets, acceptance mode, or projection policy
- **THEN** dispatch consumes those declarations as constraints
- **AND** the profile does not directly execute tools, inspect tool results, or mutate loop state outside the runtime dispatch/convergence path
- **中文** 当 profile 声明 workflow stages、allowed tools、progress capabilities、budgets、acceptance mode 或 projection policy 时，dispatch 必须将这些声明作为约束消费；profile 不得直接执行工具、检查工具结果，或在 runtime dispatch/convergence path 外修改 loop state。

#### Scenario: Task supplies acceptance target

- **WHEN** a task supplies prompt, workspace scope, output contract, active refs, or acceptance criteria
- **THEN** dispatch and convergence use that task data to validate progress and terminal closure
- **AND** task data does not hardcode benchmark-specific or instance-specific execution behavior in shared runtime code
- **中文** 当 task 提供 prompt、workspace scope、output contract、active refs 或 acceptance criteria 时，dispatch 与 convergence 必须使用这些 task data 校验 progress 与 terminal closure；task data 不得在 shared runtime code 中硬编码 benchmark-specific 或 instance-specific execution behavior。

### Requirement: Tool Dispatch Is Fault Tolerant

The agent loop dispatch layer SHALL make tool execution robust against cancellation, timeout, fallback, stale results, partial results, and retry ambiguity.

agent loop dispatch layer 必须对 cancellation、timeout、fallback、stale results、partial results 与 retry ambiguity 保持健壮。

#### Scenario: Cancellation does not leak late results

- **WHEN** a dispatch batch is cancelled or abandoned while a tool is in progress
- **THEN** the dispatch layer marks the original tool-call id as cancelled or abandoned
- **AND** any late result from that execution attempt is quarantined from model-visible messages
- **AND** convergence receives durable evidence with in-progress ids, terminal ids, elapsed time, diagnostics, and last progress marker
- **中文** 当 dispatch batch 在工具执行中被 cancelled 或 abandoned 时，dispatch layer 必须把原始 tool-call id 标记为 cancelled 或 abandoned；该 execution attempt 的任何 late result 都必须从 model-visible messages 中隔离；convergence 必须收到包含 in-progress ids、terminal ids、elapsed time、diagnostics 与 last progress marker 的 durable evidence。

#### Scenario: Timeout is classified separately

- **WHEN** a tool execution exceeds its effective timeout
- **THEN** dispatch emits a timed-out terminal status distinct from executor failure
- **AND** the feedback includes timeout limit, elapsed time when available, capability id, and retry eligibility
- **中文** 当工具执行超过 effective timeout 时，dispatch 必须发出与 executor failure 区分开的 timed-out terminal status；feedback 必须包含 timeout limit、可用的 elapsed time、capability id 与 retry eligibility。

#### Scenario: Partial result is not automatic progress

- **WHEN** a tool produces partial output before failure, cancellation, or timeout
- **THEN** dispatch records the partial output as bounded evidence
- **AND** workflow progress does not advance unless the capability contract and stage policy explicitly accept partial success
- **中文** 当工具在 failure、cancellation 或 timeout 前产生 partial output 时，dispatch 必须将 partial output 记录为有界 evidence；除非 capability contract 与 stage policy 显式接受 partial success，否则 workflow progress 不得推进。

#### Scenario: Retry is policy-derived

- **WHEN** dispatch considers retrying a failed tool call
- **THEN** retry eligibility is derived from failure classification, side-effect safety, idempotency metadata, attempt count, and active stage policy
- **AND** dispatch returns retry eligibility as data rather than repeating the tool or scheduling another model request by itself
- **AND** convergence decides whether retry is allowed, requires model feedback, enters repair, or closes with a bounded blocker
- **AND** mutation, process, network, approval, hook, plugin, MCP, or unknown-side-effect tools are not retried automatically without explicit idempotency and policy allowance
- **中文** 当 dispatch 考虑 retry 失败工具调用时，retry eligibility 必须由 failure classification、side-effect safety、idempotency metadata、attempt count 与 active stage policy 推导；dispatch 必须把 retry eligibility 作为数据返回，而不是自行重复工具或调度另一个 model request；convergence 决定是否允许 retry、要求 model feedback、进入 repair，或以 bounded blocker 关闭；mutation、process、network、approval、hook、plugin、MCP 或 unknown-side-effect tools 如果没有显式 idempotency 与 policy allowance，不得自动 retry。
