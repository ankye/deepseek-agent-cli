# staged-task-execution Specification

## Purpose
Define the generic staged task execution framework for compiling reusable profiles into replayable DAGs, governing dynamic profile admission, dispatching stages through injected executors, and preserving typed event/ref state for resume, replay, inspection, and scoring.

定义通用 staged task execution 框架，用于将可复用 profiles 编译为可回放 DAG，治理 dynamic profile 准入，通过 injected executors 派发 stages，并保留 typed event/ref state 以支持恢复、回放、检查与评分。
## Requirements
### Requirement: Generic Staged Task Contract / 通用分阶段任务契约

The system SHALL define staged task contracts that describe task graphs, stage contracts, dependencies, budgets, inputs, outputs, acceptance gates, artifact references, evidence references, and redaction metadata without embedding any domain-specific task type such as webpage, code patch, document, or benchmark.

系统必须定义 staged task contracts，用于描述 task graphs、stage contracts、dependencies、budgets、inputs、outputs、acceptance gates、artifact references、evidence references 与 redaction metadata，且不得嵌入 webpage、code patch、document 或 benchmark 等领域专用任务类型。

#### Scenario: Stage graph is domain-neutral / Stage Graph 保持领域中立

- **WHEN** a task profile builds a staged execution graph
- **THEN** each stage declares generic kind, executor kind, dependencies, input refs, expected output refs, allowed tools, budget policy, acceptance policy, retry policy, and redaction metadata
- **AND** the graph does not require framework-level knowledge of HTML, CSS, JavaScript, package tests, document pages, or benchmark scorecards
- **中文** 当 task profile 构建 staged execution graph 时，每个 stage 必须声明通用 kind、executor kind、dependencies、input refs、expected output refs、allowed tools、budget policy、acceptance policy、retry policy 与 redaction metadata；graph 不得要求框架层理解 HTML、CSS、JavaScript、package tests、document pages 或 benchmark scorecards。

### Requirement: Task State Machine Ownership / 任务状态机所有权

The runtime SHALL own the task and stage state-machine transition rules while each task run owns its own isolated state snapshot.

runtime 必须拥有 task 与 stage state-machine transition rules，而每个 task run 拥有自己的隔离 state snapshot。

#### Scenario: Controller advances through typed events / 总控通过类型化事件推进

- **WHEN** a stage is scheduled, started, succeeded, failed, blocked, skipped, retried, repaired, or cancelled
- **THEN** the controller applies a typed stage event to the task run state and records the resulting stage state without allowing executors to mutate state directly
- **中文** 当 stage 被 scheduled、started、succeeded、failed、blocked、skipped、retried、repaired 或 cancelled 时，controller 必须将 typed stage event 应用到 task run state，并记录结果 stage state，不允许 executors 直接修改 state。

#### Scenario: Dependencies choose ready stages / Dependency 决定 Ready Stage

- **WHEN** a stage has dependencies
- **THEN** it becomes ready only after all required dependency stages have reached terminal success or an allowed skip policy
- **中文** 当 stage 存在 dependencies 时，只有所有必要依赖 stage 达到 terminal success 或允许的 skip policy 后，该 stage 才能进入 ready。

### Requirement: Injectable Stage Executors / 可注入 Stage Executor

The runtime SHALL execute stages through injected executors resolved by `executorKind`, and executors SHALL return structured results or events rather than mutating task state.

runtime 必须通过按 `executorKind` 解析的 injected executors 执行 stages，executors 必须返回结构化 results 或 events，而不是直接修改 task state。

#### Scenario: Executor dispatch reuses governed paths / Executor Dispatch 复用治理路径

- **WHEN** a ready stage uses an executor kind such as `agent-loop`, `process-check`, `artifact-scan`, `file-materialize`, or `manual`
- **THEN** the selected executor dispatches work through existing governed runtime or platform paths and returns a typed stage execution result with artifact refs, evidence refs, check refs, diagnostics, and redaction metadata
- **中文** 当 ready stage 使用 `agent-loop`、`process-check`、`artifact-scan`、`file-materialize` 或 `manual` 等 executor kind 时，选中的 executor 必须通过现有受治理 runtime 或 platform 路径派发 work，并返回包含 artifact refs、evidence refs、check refs、diagnostics 与 redaction metadata 的 typed stage execution result。

#### Scenario: Unknown executor fails closed / 未知 Executor Fail Closed

- **WHEN** a ready stage references an executor kind that is not registered
- **THEN** dispatch fails closed with a typed diagnostic and the task state is advanced only through a failure event
- **中文** 当 ready stage 引用未注册的 executor kind 时，dispatch 必须以 typed diagnostic fail closed，并且 task state 只能通过 failure event 推进。

### Requirement: Task Profile Catalog / 任务 Profile 目录

The system SHALL organize first-party staged task profiles as a catalog of domain process assets that reuse a small stable set of executor kinds.

系统必须将 first-party staged task profiles 组织为领域流程资产目录，并复用少量稳定 executor kinds。

#### Scenario: Profiles scale without executor explosion / Profile 扩展不导致 Executor 爆炸

- **WHEN** new task families such as webpage generation, TypeScript bugfixes, document rewrites, release checks, security audits, or TUI regressions are added
- **THEN** the project adds or updates task profiles under a domain and versioned profile path
- **AND** it reuses existing executor kinds unless the task requires a genuinely new execution mechanism that cannot be represented by current executors plus stage contract parameters
- **中文** 当新增 webpage generation、TypeScript bugfixes、document rewrites、release checks、security audits 或 TUI regressions 等 task families 时，项目必须在 domain 与 versioned profile path 下新增或更新 task profiles；除非任务确实需要当前 executors 加 stage contract parameters 无法表达的新执行机制，否则必须复用现有 executor kinds。

#### Scenario: Profile package stays host-neutral / Profile Package 保持 Host Neutral

- **WHEN** first-party task profiles are exported from `src/packages/task-profiles`
- **THEN** they export typed profile records and graph builders only
- **AND** they do not execute processes, read local files, call models, call checkers, or import CLI/VSCode host adapters
- **中文** 当 first-party task profiles 从 `src/packages/task-profiles` 导出时，它们只能导出 typed profile records 与 graph builders；不得执行 processes、读取 local files、调用 models、调用 checkers 或 import CLI/VSCode host adapters。

### Requirement: Dynamic Task Profile Admission / 动态 Task Profile 准入

The system SHALL support task-scoped or session-scoped dynamic profiles generated by an AI or controller, but dynamic profiles SHALL compile through the same deterministic compiler and admission policy as catalog profiles.

系统必须支持由 AI 或 controller 生成的 task-scoped / session-scoped dynamic profiles，但 dynamic profiles 必须通过与 catalog profiles 相同的 deterministic compiler 与 admission policy。

#### Scenario: AI-generated profile compiles as data / AI 生成的 Profile 作为数据编译

- **WHEN** an AI proposes a temporary staged profile for a task
- **THEN** the profile declares `source: dynamic`, scope, provenance, stage patches, fragments, overlays, budgets, acceptance gates, and typed refs as data
- **AND** the compiler emits a fingerprinted compiled graph or fails closed with diagnostics
- **中文** 当 AI 为任务提出临时 staged profile 时，该 profile 必须以数据形式声明 `source: dynamic`、scope、provenance、stage patches、fragments、overlays、budgets、acceptance gates 与 typed refs；compiler 必须输出带 fingerprint 的 compiled graph，或以 diagnostics fail closed。

#### Scenario: Dynamic profile cannot bypass governance / Dynamic Profile 不能绕过治理

- **WHEN** a dynamic profile references an unknown executor kind, exceeds stage-count caps, exceeds budget caps, creates duplicate refs, creates dependency cycles, or attempts to alter controller transition rules
- **THEN** admission rejects it before execution
- **中文** 当 dynamic profile 引用未知 executor kind、超过 stage-count caps、超过 budget caps、创建 duplicate refs、创建 dependency cycles，或试图改变 controller transition rules 时，admission 必须在执行前拒绝它。

#### Scenario: Dynamic profile snapshot is replayable / Dynamic Profile 快照可回放

- **WHEN** a dynamic profile is admitted for execution
- **THEN** the task run persists the proposed profile payload, compiler fingerprint, compiled graph, applied fragments, applied overlays, and admission diagnostics as a task-run snapshot
- **AND** promotion into the static catalog requires a normal code and OpenSpec change
- **中文** 当 dynamic profile 被准入执行时，task run 必须持久化 proposed profile payload、compiler fingerprint、compiled graph、applied fragments、applied overlays 与 admission diagnostics 作为 task-run snapshot；若要沉淀到 static catalog，必须通过正常 code 与 OpenSpec 变更。

### Requirement: Deterministic Profile Composition / 确定性 Profile 组装

The system SHALL compile task profiles from base profiles, ordered fragments, ordered overlays, and profile-local parameters into one validated `CompiledTaskProfile` and one replayable `StageGraph`.

系统必须将 base profiles、ordered fragments、ordered overlays 与 profile-local parameters 编译为一个经过校验的 `CompiledTaskProfile` 和一个可回放的 `StageGraph`。

#### Scenario: Profile compiler produces stable fingerprints / Profile Compiler 产出稳定指纹

- **WHEN** the same profile composition inputs are compiled twice
- **THEN** the compiler emits the same compiled profile id, stage graph id, stage order, dependency order, ref declarations, and replay fingerprint
- **AND** the fingerprint includes base profile id, fragment ids, overlay ids, profile-local parameter hash, and compiler version
- **中文** 当相同 profile composition inputs 被编译两次时，compiler 必须输出相同的 compiled profile id、stage graph id、stage order、dependency order、ref declarations 与 replay fingerprint；fingerprint 必须包含 base profile id、fragment ids、overlay ids、profile-local parameter hash 与 compiler version。

#### Scenario: Profile conflicts fail closed / Profile 冲突 Fail Closed

- **WHEN** profile composition creates duplicate stage ids, duplicate output refs, unknown fragments, dependency cycles, incompatible executor kinds, budget-policy collisions, acceptance-policy collisions, or undeclared required inputs
- **THEN** compilation fails with typed diagnostics and no runnable stage graph is emitted
- **中文** 当 profile composition 产生 duplicate stage ids、duplicate output refs、unknown fragments、dependency cycles、incompatible executor kinds、budget-policy collisions、acceptance-policy collisions 或 undeclared required inputs 时，compilation 必须以 typed diagnostics 失败，且不得输出可运行 stage graph。

#### Scenario: Overlays are declarative patches / Overlay 是声明式 Patch

- **WHEN** an overlay changes budgets, allowed tools, model profile hints, retry policy, acceptance policy, or redaction policy
- **THEN** the overlay declares the target stage or graph field explicitly and the compiler records the applied overlay in compiled profile metadata
- **中文** 当 overlay 改变 budgets、allowed tools、model profile hints、retry policy、acceptance policy 或 redaction policy 时，overlay 必须显式声明目标 stage 或 graph field，compiler 必须在 compiled profile metadata 中记录已应用 overlay。

### Requirement: Typed DAG Pipe References / 类型化 DAG 管道引用

Staged tasks SHALL pass data between stages through immutable typed references rather than raw large content in task state.

staged tasks 必须通过不可变 typed references 在 stages 之间传递数据，而不得把 raw large content 放入 task state。

#### Scenario: Stage outputs become immutable refs / Stage Output 变为不可变 Ref

- **WHEN** a stage succeeds with generated files, evidence, check output, metrics, state summaries, diagnostics, or command output
- **THEN** it records typed refs such as artifact refs, evidence refs, check refs, metric refs, state refs, or diagnostic refs with producer stage id, ref id, storage scope, optional storage path, content fingerprint, bounded preview metadata, redaction metadata, and replay metadata
- **AND** downstream stages consume only declared refs or bounded summaries, not producer internals
- **中文** 当 stage 成功生成 files、evidence、check output、metrics、state summaries、diagnostics 或 command output 时，它必须记录 typed refs，例如 artifact refs、evidence refs、check refs、metric refs、state refs 或 diagnostic refs，并包含 producer stage id、ref id、storage scope、可选 storage path、content fingerprint、有界 preview metadata、redaction metadata 与 replay metadata；下游 stages 只能消费声明过的 refs 或有界 summaries，而不是 producer internals。

#### Scenario: Ref resolution is explicit / Ref Resolution 显式化

- **WHEN** an executor needs content behind a ref
- **THEN** it resolves the ref through injected runtime or platform services using the ref type, scope, and storage metadata
- **AND** the resolution emits evidence of access without copying raw secret or large artifact content into task state
- **中文** 当 executor 需要读取 ref 背后的内容时，它必须通过 injected runtime 或 platform services，依据 ref type、scope 与 storage metadata 解析该 ref；解析过程必须发出 access evidence，且不得把 raw secret 或 large artifact content 复制进 task state。

#### Scenario: Pipe graph supports DAG fan-in and fan-out / 管道图支持 DAG Fan-in 与 Fan-out

- **WHEN** a stage depends on multiple upstream refs or multiple downstream stages consume the same ref
- **THEN** the stage graph records fan-in and fan-out relationships by ref id and dependency id, preserving deterministic ordering for replay and scoring
- **中文** 当一个 stage 依赖多个 upstream refs，或多个 downstream stages 消费同一个 ref 时，stage graph 必须通过 ref id 与 dependency id 记录 fan-in 和 fan-out 关系，并为 replay 与 scoring 保持确定性顺序。

### Requirement: Task Run Persistence And Replay / Task Run 持久化与回放

The staged task controller SHALL persist enough typed events and references to resume, replay, inspect, and score a task run without re-running completed executors.

staged task controller 必须持久化足够的 typed events 与 references，使 task run 可在不重新运行已完成 executors 的情况下恢复、回放、检查与评分。

#### Scenario: State derives from event log / State 从 Event Log 派生

- **WHEN** a staged task run is resumed or inspected
- **THEN** the controller reconstructs task and stage state from the persisted graph, compiled profile metadata, stage events, executor result refs, budget records, and diagnostics
- **AND** reconstructed state does not require raw model output, raw command output, or raw artifact content
- **中文** 当 staged task run 被恢复或检查时，controller 必须从 persisted graph、compiled profile metadata、stage events、executor result refs、budget records 与 diagnostics 重建 task 与 stage state；重建 state 不得依赖 raw model output、raw command output 或 raw artifact content。

#### Scenario: Resume continues from failed or ready stage / Resume 从失败或 Ready Stage 继续

- **WHEN** a staged task run stops after a failed, blocked, timed-out, or cancelled stage
- **THEN** resume keeps successful completed stage refs immutable, recomputes ready stages from current state, and dispatches only stages that are ready or explicitly selected for repair or retry
- **中文** 当 staged task run 在 failed、blocked、timed-out 或 cancelled stage 后停止时，resume 必须保持已成功完成 stages 的 refs 不可变，从当前 state 重新计算 ready stages，并只 dispatch ready stages 或显式选中的 repair/retry stages。

#### Scenario: Replay does not execute side effects / Replay 不执行副作用

- **WHEN** a staged task run is replayed for diagnostics, comparison, scoring, or UI inspection
- **THEN** replay reads persisted events and refs but does not execute agent loops, process checks, file materialization, artifact scans, or external calls
- **中文** 当 staged task run 为 diagnostics、comparison、scoring 或 UI inspection 回放时，replay 只能读取 persisted events 与 refs，不得执行 agent loops、process checks、file materialization、artifact scans 或 external calls。

### Requirement: Executor Admission Governance / Executor 准入治理

The system SHALL keep executor kinds as a small stable mechanism set and require explicit evidence before adding a new executor kind.

系统必须将 executor kinds 保持为少量稳定机制集合，并要求新增 executor kind 前具备显式证据。

#### Scenario: New executor requires mechanism proof / 新 Executor 需要机制证明

- **WHEN** a contributor proposes a new executor kind
- **THEN** the change documents why existing executors plus stage contract parameters cannot express the required execution mechanism
- **AND** it adds contract coverage, owner metadata, policy/scope declarations, timeout behavior, redaction behavior, and architecture lint or boundary evidence
- **中文** 当 contributor 提议新增 executor kind 时，该变更必须说明为什么现有 executors 加 stage contract parameters 无法表达所需 execution mechanism；并增加 contract coverage、owner metadata、policy/scope declarations、timeout behavior、redaction behavior 与 architecture lint 或 boundary evidence。

### Requirement: Primary Workflow Ready-Stage Control / 主工作流 Ready Stage 控制

The runtime SHALL derive an executable ready-stage control record from every primary staged workflow before model dispatch when the workflow has at least one ready stage.

当 primary staged workflow 至少存在一个 ready stage 时，runtime 必须在 model dispatch 前从该 workflow 推导出可执行的 ready-stage control record。

#### Scenario: Ready stage becomes execution control / Ready Stage 变成执行控制

- **WHEN** a selected profile has `workflowPriority: "primary"` and `orchestrationMode: "staged-capability-workflow"`
- **AND** its compiled staged-task run state has a ready stage
- **THEN** the runtime records a ready-stage control event before `model.requested`
- **AND** the control includes workflow graph id, stage id, stage kind, allowed capability ids, progress capability ids, preferred capability id when determinable, no-tool policy, terminal-close policy, and redaction metadata
- **AND** the control is host-neutral and generic across task families
- **中文** 当所选 profile 具有 `workflowPriority: "primary"` 与 `orchestrationMode: "staged-capability-workflow"`，且其 compiled staged-task run state 存在 ready stage 时，runtime 必须在 `model.requested` 前记录 ready-stage control event；该 control 必须包含 workflow graph id、stage id、stage kind、allowed capability ids、progress capability ids、可确定时的 preferred capability id、no-tool policy、terminal-close policy 与 redaction metadata；该 control 必须 host-neutral，且对任务族通用。

#### Scenario: No ready stage fails closed when required / 无 Ready Stage 时安全失败

- **WHEN** a primary staged workflow is selected
- **AND** the workflow cannot compute any ready stage
- **AND** the task is not already terminal
- **THEN** the runtime emits a typed workflow diagnostic and does not silently fall back to a generic conversational loop
- **中文** 当 primary staged workflow 已选择，但 workflow 无法计算任何 ready stage，且 task 尚未终态时，runtime 必须发出 typed workflow diagnostic，不得静默退回通用对话 loop。

### Requirement: Stage Progress Requires Completion-Grade Evidence / Stage 推进需要完成级证据

Ready-stage control SHALL distinguish allowed support capabilities from capabilities that can complete or progress the active stage.

ready-stage control 必须区分允许的辅助 capability 与能够完成或推进 active stage 的 capability。

#### Scenario: Support evidence does not complete mutation stage / 辅助证据不完成变更阶段

- **WHEN** a ready stage allows read/search/list tools as supporting evidence
- **AND** the stage kind requires mutation-grade, verification-grade, or terminal-capability evidence
- **THEN** successful support tool execution may be recorded as evidence but MUST NOT complete the stage
- **AND** the next ready-stage control still names the required progress capability class
- **中文** 当 ready stage 允许 read/search/list 工具作为辅助证据，但 stage kind 需要 mutation-grade、verification-grade 或 terminal-capability evidence 时，成功的辅助工具执行可以记录为 evidence，但不得完成 stage；下一次 ready-stage control 仍必须指出所需 progress capability class。

### Requirement: Stage Evaluation Gates Success / Stage 评估决定成功

Every staged workflow stage SHALL evaluate its produced outputs and evidence against the stage acceptance policy before the controller marks the stage as succeeded.

每个 staged workflow stage 在 controller 标记 succeeded 前，必须根据 stage acceptance policy 评估其产出的 outputs 与 evidence。

#### Scenario: Output refs alone do not pass a stage / 只有输出引用不算 Stage 通过

- **WHEN** a stage executor returns artifact refs, evidence refs, check refs, diagnostics, or bounded output previews
- **THEN** the controller records them as produced evidence
- **AND** the stage remains not succeeded until a stage evaluation result is recorded with status `passed`
- **AND** statuses `needs-review`, `failed`, and `blocked` MUST NOT be collapsed into success merely because output exists
- **中文** 当 stage executor 返回 artifact refs、evidence refs、check refs、diagnostics 或有界输出 preview 时，controller 必须将其记录为 produced evidence；只有记录了 status 为 `passed` 的 stage evaluation result 后，stage 才能 succeeded；不得因为存在输出就把 `needs-review`、`failed` 或 `blocked` 压成成功。

#### Scenario: Evaluation result is typed evidence / Evaluation Result 是类型化证据

- **WHEN** a stage evaluation runs
- **THEN** it records evaluator id, acceptance policy id, status, optional score, threshold when applicable, reason codes, consumed evidence refs, produced diagnostic refs, and redaction metadata
- **AND** the stage transition event links to that evaluation result
- **中文** 当 stage evaluation 运行时，必须记录 evaluator id、acceptance policy id、status、可选 score、适用时的 threshold、reason codes、consumed evidence refs、produced diagnostic refs 与 redaction metadata；stage transition event 必须链接该 evaluation result。

#### Scenario: Evaluation can be deterministic or model-assisted / Evaluation 可确定性或模型辅助

- **WHEN** a stage acceptance policy can be checked by schema, exit code, score threshold, diff presence, test result, artifact inspection, or diagnostic code
- **THEN** evaluation MUST use deterministic checks first
- **AND** model-assisted review MAY add bounded qualitative judgment only after deterministic evidence is recorded
- **AND** model-assisted review MUST NOT override deterministic failure without an explicit repair or reviewer policy
- **中文** 当 stage acceptance policy 可通过 schema、exit code、score threshold、diff presence、test result、artifact inspection 或 diagnostic code 检查时，evaluation 必须先使用确定性检查；模型辅助 review 只能在确定性证据已记录后添加有界质量判断；没有显式 repair 或 reviewer policy 时，模型辅助 review 不得覆盖确定性失败。

### Requirement: Technical Director Acceptance Gates Final Success / 技术总监验收决定最终成功

Every stage or pipeline step SHALL require an explicit technical-director acceptance record before its success state becomes final.

每个 stage 或 pipeline step 在成功状态最终成立前，必须要求显式的技术总监验收记录。

#### Scenario: Passing evaluator is not enough / Evaluator 通过仍不足够

- **WHEN** a stage evaluation returns `passed`
- **THEN** the controller records the evaluation as proposed acceptance
- **AND** the stage MUST NOT transition to final `succeeded` until a technical-director acceptance record confirms the acceptance criteria, evidence sufficiency, residual risks, and pass/fail disposition
- **AND** if the technical director marks evidence insufficient, the stage transitions to `needs-review`, `blocked`, or `failed` according to the recorded disposition
- **中文** 当 stage evaluation 返回 `passed` 时，controller 必须将该 evaluation 记录为 proposed acceptance；只有技术总监验收记录确认验收标准、证据充分性、残余风险与通过/失败结论后，stage 才能最终转为 `succeeded`；如果技术总监标记证据不足，则 stage 必须根据记录的结论转为 `needs-review`、`blocked` 或 `failed`。

#### Scenario: Acceptance record is auditable / 验收记录可审计

- **WHEN** technical-director acceptance is recorded
- **THEN** it includes reviewer role `technical-director`, acceptance criteria ids, evaluation result ids, evidence refs reviewed, decision `accepted`, `rejected`, `needs-review`, or `blocked`, rationale, residual risks, timestamp, and redaction metadata
- **AND** automated director policy may produce the record only when the policy id and deterministic evidence basis are recorded
- **中文** 当记录技术总监验收时，必须包含 reviewer role `technical-director`、acceptance criteria ids、evaluation result ids、已审 evidence refs、decision `accepted`、`rejected`、`needs-review` 或 `blocked`、rationale、residual risks、timestamp 与 redaction metadata；只有记录 policy id 与确定性证据依据后，自动化 director policy 才能产生该记录。

#### Scenario: Criteria applicability is confirmed each time / 每次都确认验收标准适用性

- **WHEN** a stage or pipeline step reaches evaluation
- **THEN** the technical-director acceptance record confirms whether the configured acceptance criteria are applicable to the current stage output
- **AND** if criteria are missing, stale, too weak, or not applicable, the step cannot pass and must record a criteria-defect diagnostic
- **中文** 当 stage 或 pipeline step 到达 evaluation 时，技术总监验收记录必须确认配置的验收标准是否适用于当前 stage output；如果标准缺失、过期、过弱或不适用，该 step 不得通过，并必须记录 criteria-defect diagnostic。

### Requirement: Engineering Role Workflow Has Evidence-Gated Stages / 工程师 Role Workflow 具备 Evidence-Gated Stages

The staged task execution system SHALL provide a generic engineering role workflow for repository-sensitive coding work.

staged task execution system 必须为 repository-sensitive coding work 提供通用工程师 role workflow。

#### Scenario: Engineering workflow stages are fixed / 工程师 Workflow Stage 固定

- **WHEN** `engineering/coding.v1` is compiled
- **THEN** its stage order is `understand`, `plan`, `test`, `implement`, `verify`, and `report`
- **AND** each stage has explicit entry criteria, exit criteria, allowed capabilities, and expected evidence refs
- **中文** 当 `engineering/coding.v1` 被编译时，其 stage 顺序必须是 `understand`、`plan`、`test`、`implement`、`verify` 与 `report`；每个 stage 必须具备显式 entry criteria、exit criteria、allowed capabilities 与 expected evidence refs。

#### Scenario: Technical director acceptance is required for primary role stage completion / Primary Role Stage 完成需要技术总监验收

- **WHEN** a primary role workflow reports a stage as passed, completed, or accepted
- **THEN** the stage state includes a technical-director acceptance record with criteria, evidence sufficiency, decision, and residual risk
- **AND** a stage without sufficient evidence remains `blocked` or `needs-review`, not `passed`
- **中文** 当 primary role workflow 报告某个 stage 已 passed、completed 或 accepted 时，stage state 必须包含技术总监验收记录，说明 criteria、evidence sufficiency、decision 与 residual risk；证据不足的 stage 必须保持 `blocked` 或 `needs-review`，不得标记为 `passed`。

### Requirement: Staged Task Acceptance Is Policy-Selected

Staged-task execution SHALL support optional supervisor acceptance without making it mandatory for every staged workflow.

Staged-task execution 必须支持可选 supervisor acceptance，但不得让它成为每个 staged workflow 的强制要求。

#### Scenario: Contract fields do not force CLI acceptance gates / Contract 字段不强制 CLI 验收门禁

- **WHEN** a staged task graph is used by an ordinary CLI workflow
- **THEN** the presence of evaluation or acceptance fields in the contract does not require technical-director acceptance unless the profile opts into supervisor acceptance
- **中文** 当 staged task graph 被普通 CLI workflow 使用时，contract 中存在 evaluation 或 acceptance 字段并不意味着必须要求技术总监验收，除非 profile 显式 opt into supervisor acceptance。

#### Scenario: Completed stages remain terminal / 已完成 stage 保持终态

- **WHEN** a standard CLI staged workflow marks a stage as `succeeded`
- **AND** later tool evidence also uses a capability that appeared in the completed stage
- **THEN** runtime MUST NOT reopen, restart, or emit duplicate success for the completed stage
- **AND** evidence is considered only against currently ready stages
- **中文** 当 standard CLI staged workflow 已将某个 stage 标记为 `succeeded`，后续工具证据即使使用了该 stage 曾声明的 capability，runtime 也不得重新打开、重新开始或重复发出该 stage 成功事件；证据只能匹配当前 ready stages。

#### Scenario: Same-response tool calls use latest stage state / 同响应 tool call 使用最新 stage state

- **WHEN** one model response contains multiple tool calls
- **AND** an earlier tool call advances the active staged workflow
- **THEN** later tool calls in the same response MUST evaluate against the updated active run state
- **AND** later tool calls MUST NOT evaluate against the stale run state captured at model-request creation time
- **中文** 当一次模型响应包含多个 tool call，且前一个 tool call 已推进 active staged workflow 时，后续 tool call 必须基于更新后的 active run state 评估，不得基于 model-request 创建时捕获的旧 run state。

#### Scenario: Automatic workflows close at terminal stage state / Automatic workflow 在 stage 终态关闭

- **WHEN** a standard automatic primary staged workflow has no remaining pending, ready, or running stages
- **AND** every stage is `succeeded` or `skipped`
- **THEN** the agent loop MUST emit completion for the workflow turn
- **AND** it MUST NOT continue requesting model iterations until the iteration budget is exhausted
- **中文** 当 standard automatic primary staged workflow 没有 pending、ready 或 running stage，且所有 stage 都是 `succeeded` 或 `skipped` 时，agent loop 必须发出 workflow turn completion，不得继续请求模型直到耗尽迭代预算。

#### Scenario: Ordinary plan stages accept planning evidence / 普通 plan stage 接受规划证据

- **WHEN** an ordinary CLI profile declares a `plan` stage with read, search, glob, list, or diff capabilities
- **THEN** successful runtime evidence from those declared capabilities MAY satisfy the plan stage
- **AND** mutation, materialization, and repair stages MUST still require mutation-capable evidence
- **中文** 当普通 CLI profile 声明 `plan` stage 且使用 read/search/glob/list/diff 等 capability 时，这些已声明 capability 的成功 runtime evidence 可以满足 plan stage；但 mutation、materialization 与 repair stage 仍必须要求具备变更能力的证据。

#### Scenario: Read-only evidence stages can complete without mutation / 只读证据 stage 可无变更完成

- **WHEN** a standard CLI staged workflow declares a produce-like stage whose allowed capabilities are all read-only evidence capabilities
- **THEN** successful evidence from any declared read-only capability MAY satisfy that stage
- **AND** produce-like stages that declare mutation-capable tools MUST NOT be satisfied by read-only evidence alone
- **中文** 当 standard CLI staged workflow 声明一个 produce-like stage，且其 allowed capabilities 全部是只读证据能力时，任一已声明只读能力的成功 evidence 可以满足该 stage；但声明了 mutation-capable tools 的 produce-like stage 不得仅由只读 evidence 满足。

