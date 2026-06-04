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
