# agent-loop Specification

## Purpose
Define how the agent loop coordinates planning, tool governance, verification, repair, synthesis, and terminal phases for DeepSeek runtime turns.

定义 agent loop 如何协调 DeepSeek runtime turn 中的 planning、tool governance、verification、repair、synthesis 与 terminal 阶段。
## Requirements
### Requirement: First Usable Agent Loop / 第一个可用 Agent Loop

The system SHALL provide a product-grade agent loop that can accept user tasks, call the configured model, normalize model output, execute governed tool calls, feed tool results back to the model, and emit a terminal turn result through host-neutral runtime events.

系统必须提供产品级 agent loop，能够接收用户任务、调用配置模型、归一化模型输出、执行受治理工具调用、把工具结果回灌给模型，并通过 host-neutral runtime events 发出 turn 终态结果。

#### Scenario: One-shot run completes without tools / 无工具的一次性运行完成

- **WHEN** `deepseek run "explain this repository"` is executed with a model response that completes without tool calls
- **THEN** the loop emits session, turn, model, output, and terminal completion events in order
- **中文** 当执行 `deepseek run "explain this repository"` 且模型响应不包含 tool calls 时，loop 必须按顺序发出 session、turn、model、output 和 terminal completion events。

#### Scenario: One-shot run completes with a tool call / 带工具调用的一次性运行完成

- **WHEN** the model requests a registered read-only coding tool during `deepseek run`
- **THEN** the loop validates the request, executes the tool through governed capability execution, sends the tool result back to the model, and emits a terminal assistant result
- **中文** 当模型在 `deepseek run` 中请求已注册 read-only coding tool 时，loop 必须校验请求、通过受治理 capability execution 执行工具、把工具结果回传模型，并发出终态 assistant result。

### Requirement: Chat Session Loop / 交互式 Chat Session Loop

The system SHALL provide a chat loop that preserves session identity across multiple user turns while using the same runtime event loop and governance boundaries as one-shot runs.

系统必须提供 chat loop，在多个 user turns 之间保留 session identity，并与 one-shot runs 使用同一 runtime event loop 和治理边界。

#### Scenario: Chat preserves session id / Chat 保留 session id

- **WHEN** a user submits multiple prompts in `deepseek chat`
- **THEN** each turn uses the same session id unless the user explicitly starts, resumes, or forks another session
- **中文** 当用户在 `deepseek chat` 中提交多个 prompts 时，每个 turn 必须使用相同 session id，除非用户显式 start、resume 或 fork 另一个 session。

#### Scenario: Chat exits cleanly / Chat 干净退出

- **WHEN** a user sends EOF, exit, quit, or the host requests cancellation
- **THEN** the loop emits a terminal session event and does not leave scheduled work running
- **中文** 当用户发送 EOF、exit、quit，或 host 请求 cancellation 时，loop 必须发出 terminal session event，且不得留下仍在运行的 scheduled work。

### Requirement: Agent Loop Event Presentation / Agent Loop 事件呈现

The system SHALL expose human-readable text output and machine-readable JSON/JSONL output for the same canonical runtime events without changing execution behavior.

系统必须针对同一 canonical runtime events 暴露 human-readable text output 与 machine-readable JSON/JSONL output，且不得改变执行行为。

#### Scenario: Text mode streams assistant output / Text mode 串流 assistant output

- **WHEN** a CLI user runs the agent loop in default text mode
- **THEN** assistant text streams as readable output while tool progress and diagnostics remain bounded and traceable
- **中文** 当 CLI 用户以默认 text mode 运行 agent loop 时，assistant text 必须以可读形式串流输出，同时 tool progress 与 diagnostics 保持有界且可追踪。

#### Scenario: JSONL mode emits event records / JSONL mode 发出事件记录

- **WHEN** a caller passes JSONL output mode
- **THEN** each canonical runtime event is emitted as one JSON line with event type, schema version, session id, turn id, trace id, timestamp, redaction metadata, and payload
- **中文** 当 caller 使用 JSONL output mode 时，每个 canonical runtime event 必须作为一行 JSON 输出，包含 event type、schema version、session id、turn id、trace id、timestamp、redaction metadata 和 payload。

### Requirement: Agent Loop Failure Semantics / Agent Loop 失败语义

The agent loop SHALL fail closed with typed terminal events for missing credentials, unsupported model capabilities, unsafe tool requests, policy denial, timeout, cancellation, provider failure, malformed unrepaired tool calls, and scheduler failure.

agent loop 必须针对 missing credentials、unsupported model capabilities、unsafe tool requests、policy denial、timeout、cancellation、provider failure、malformed unrepaired tool calls 和 scheduler failure 以 typed terminal events 安全失败。

#### Scenario: Missing credentials fail before provider call / 缺少凭证在 provider 调用前失败

- **WHEN** no configured credential can be resolved for a live DeepSeek profile
- **THEN** the loop emits a missing-credential terminal event and does not call the provider transport
- **中文** 当 live DeepSeek profile 无法解析配置凭证时，loop 必须发出 missing-credential terminal event，且不得调用 provider transport。

#### Scenario: Unsafe tool request is rejected / 不安全工具请求被拒绝

- **WHEN** a model requests a tool with traversal paths, unsupported platform commands, disabled capabilities, or schema-invalid input
- **THEN** the loop emits validation and terminal or model-feedback events without executing the unsafe request
- **中文** 当模型请求包含 traversal paths、unsupported platform commands、disabled capabilities 或 schema-invalid input 的工具时，loop 必须发出 validation 与 terminal 或 model-feedback events，且不得执行不安全请求。

### Requirement: Agent Loop Injects Projected Reference Context / Agent Loop 注入已投影引用上下文

The agent loop SHALL make selected reference projection content model-visible through a runtime-owned context message while preserving the original user prompt message.

Agent loop 必须通过 runtime-owned context message 让 selected reference projection content 对模型可见，同时保留原始 user prompt message。

#### Scenario: Projected references become model context / 已投影引用成为模型上下文

- **WHEN** context projection selects reference-derived nodes for a prompt turn
- **THEN** the model request includes a deterministic context message containing the selected projected content and metadata summarizing the projection
- **中文** 当 context projection 为某个 prompt turn 选中 reference-derived nodes 时，model request 必须包含确定性的 context message，内含 selected projected content，并通过 metadata 汇总 projection。

#### Scenario: User prompt remains unchanged / 用户 Prompt 保持不变

- **WHEN** projected reference context is included in the model request
- **THEN** the user message content remains the exact submitted prompt and reference content is not appended to that user message
- **中文** 当 projected reference context 被加入 model request 时，user message content 必须保持为用户提交的确切 prompt，reference content 不得追加到该 user message。

#### Scenario: Rejected projection fails before model dispatch / 被拒绝的投影在模型派发前失败

- **WHEN** context projection rejects the turn due to hard budget or policy
- **THEN** the agent loop emits a typed terminal failure and does not call the model gateway
- **中文** 当 context projection 因 hard budget 或 policy 拒绝 turn 时，agent loop 必须发出 typed terminal failure，且不得调用 model gateway。

### Requirement: Agent Loop Emits Memory And Compact Evidence / Agent Loop 发出记忆与压缩证据

The agent loop SHALL publish host-neutral runtime events that describe memory candidate collection and compact boundary decisions without mutating the user prompt or requiring host-specific state.

Agent loop 必须发布 host-neutral runtime events，用于描述 memory candidate collection 与 compact boundary decisions，且不得修改用户 prompt 或依赖 host-specific state。

#### Scenario: Memory candidates are visible before model dispatch / 模型派发前可见记忆候选

- **WHEN** a turn collects eligible memory entries for context projection
- **THEN** the runtime event stream includes structured memory evidence with scope counts, selected candidate counts, redaction metadata, and replay fingerprints before `model.requested`
- **中文** 当某个回合为 context projection 收集 eligible memory entries 时，runtime event stream 必须在 `model.requested` 前包含结构化 memory evidence，含 scope counts、selected candidate counts、redaction metadata 与 replay fingerprints。

#### Scenario: Compact boundary is replayable / 压缩边界可 replay

- **WHEN** context projection crosses compact pressure thresholds
- **THEN** the agent loop emits a compact boundary event with projection fingerprint, budget pressure, selected/excluded counts, and no hidden prompt rewrite
- **中文** 当 context projection 跨过 compact pressure thresholds 时，agent loop 必须发出 compact boundary event，包含 projection fingerprint、budget pressure、selected/excluded counts，且不得隐藏改写 prompt。

### Requirement: Agent Loop Records Bounded Tool Result Evidence / Agent Loop 记录有界工具结果证据

The agent loop SHALL convert tool execution outcomes into bounded, redacted, replayable evidence records owned by runtime events rather than CLI-rendered text.

Agent loop 必须将工具执行结果转换为有界、脱敏、可 replay 的 evidence records，并由 runtime events 拥有，而不是由 CLI rendered text 拥有。

#### Scenario: Tool result evidence excludes raw output / 工具结果证据排除原始输出

- **WHEN** a tool execution completes with stdout, stderr, diagnostics, changed files, or model feedback
- **THEN** the runtime records stable ids, capability ids, status, bounded summaries, replay hashes, and redaction metadata without persisting raw unbounded stdout/stderr
- **中文** 当工具执行完成并包含 stdout、stderr、diagnostics、changed files 或 model feedback 时，runtime 必须记录 stable ids、capability ids、status、有界 summaries、replay hashes 与 redaction metadata，不得持久化 raw unbounded stdout/stderr。

### Requirement: Agent Loop Uses Prompt Assembly Plan / Agent Loop 使用 Prompt Assembly Plan

The agent loop SHALL obtain model-visible messages, prompt text, tool visibility, and prompt metadata from the prompt assembly package before dispatching each model request.

Agent loop 在派发每次 model request 前，必须从 prompt assembly package 获取 model-visible messages、prompt text、tool visibility 与 prompt metadata。

#### Scenario: Assembly occurs before model request / Model Request 前执行 Assembly
- **WHEN** the agent loop is ready to call the model for an iteration
- **THEN** it invokes the configured `PromptAssembler`, receives a provider-neutral assembly result, and builds the `ModelRequest` from that result rather than constructing messages inline
- **中文** 当 agent loop 准备在某次 iteration 调用模型时，必须调用配置的 `PromptAssembler`，接收 provider-neutral assembly result，并从该 result 构建 `ModelRequest`，而不是内联构造 messages。

#### Scenario: Existing prompt semantics are preserved / 保持现有 Prompt 语义
- **WHEN** only the current user prompt and projected reference context are available
- **THEN** the assembled model request preserves the existing behavior of a system context message followed by the exact user prompt message
- **中文** 当只有当前用户 prompt 与 projected reference context 可用时，组装后的 model request 必须保持现有行为：system context message 后跟精确的 user prompt message。

#### Scenario: Assembly failure fails closed / Assembly 失败安全关闭
- **WHEN** prompt assembly rejects a turn due to hard budget, invalid required section, incompatible provider metadata, or policy exclusion of required context
- **THEN** the agent loop emits a typed terminal failure and does not call the model gateway
- **中文** 当 prompt assembly 因 hard budget、invalid required section、incompatible provider metadata 或 required context 被 policy exclusion 而拒绝某个 turn 时，agent loop 必须发出 typed terminal failure，且不得调用 model gateway。

### Requirement: Agent Loop Emits Prompt Assembly Evidence / Agent Loop 发出 Prompt Assembly 证据

The agent loop SHALL emit a host-neutral `prompt.assembled` runtime event before `model.requested` for every model dispatch attempt.

Agent loop 必须在每次 model dispatch attempt 的 `model.requested` 之前发出 host-neutral `prompt.assembled` runtime event。

#### Scenario: Prompt assembled event precedes model requested / Prompt Assembled 事件先于 Model Requested
- **WHEN** a model request is successfully assembled
- **THEN** the runtime event stream includes `prompt.assembled` before `model.requested`, with assembly fingerprint, section summary, budget report summary, tool plan summary, provider target metadata, compatibility metadata, and redaction metadata
- **中文** 当 model request 成功组装时，runtime event stream 必须在 `model.requested` 之前包含 `prompt.assembled`，并带有 assembly fingerprint、section summary、budget report summary、tool plan summary、provider target metadata、compatibility metadata 与 redaction metadata。

#### Scenario: Prompt assembled event is replayable / Prompt Assembled 事件可 Replay
- **WHEN** a golden replay captures a turn that dispatches a model request
- **THEN** the captured `prompt.assembled` event contains enough redacted structural evidence to compare future assembly output without persisting raw unbounded prompt content
- **中文** 当 golden replay 捕获一个派发 model request 的 turn 时，捕获的 `prompt.assembled` event 必须包含足够的脱敏结构证据，用于对比未来 assembly output，且不持久化 raw unbounded prompt content。

#### Scenario: Tool visibility is recorded / Tool Visibility 被记录
- **WHEN** tools are projected into or excluded from a model request
- **THEN** the prompt assembly evidence records visible tool count, excluded tool count, projection policy, and bounded exclusion reasons
- **中文** 当 tools 被投影进或排除出 model request 时，prompt assembly evidence 必须记录 visible tool count、excluded tool count、projection policy 与有界 exclusion reasons。

### Requirement: Agent Loop Runs Evidence Discovery Before Fact-Sensitive Dispatch / Agent Loop 在事实敏感派发前执行搜证

The agent loop SHALL run task-intent classification and evidence discovery before model dispatch for fact-sensitive repository, product, code, documentation, release, or evaluation tasks.

agent loop 必须在 fact-sensitive repository、product、code、documentation、release 或 evaluation tasks 的 model dispatch 前运行 task-intent classification 与 evidence discovery。

#### Scenario: Fact-sensitive run emits evidence events / 事实敏感运行发出证据事件
- **WHEN** `deepseek run` receives a prompt that asks for current-project product copy, command guidance, code changes, docs, release, or evaluation conclusions
- **THEN** the event stream includes evidence classification, evidence plan, selected evidence summary, and evidence manifest or unsupported-claim decision before final output
- **中文** 当 `deepseek run` 收到要求当前项目产品文案、命令指导、代码修改、文档、发布或评估结论的 prompt 时，event stream 必须在最终输出前包含 evidence classification、evidence plan、selected evidence summary 与 evidence manifest 或 unsupported-claim decision。

#### Scenario: Non-fact task can skip evidence with classification / 非事实任务可带分类跳过搜证
- **WHEN** a task is classified as casual, explicitly fictional, or pure brainstorming
- **THEN** the agent loop may skip mandatory evidence discovery but records the classification and prevents the output from being treated as factual project evidence
- **中文** 当任务被分类为 casual、明确虚构或纯 brainstorming 时，agent loop 可以跳过强制 evidence discovery，但必须记录分类，并防止输出被当作 factual project evidence。

### Requirement: Agent Loop Preserves Prompt Boundary With Evidence Context / Agent Loop 通过证据上下文保留 Prompt 边界

The agent loop SHALL preserve the exact user prompt while adding evidence plan and selected evidence as runtime-owned model context.

agent loop 必须保留用户 prompt 的精确内容，同时将 evidence plan 与 selected evidence 作为 runtime-owned model context 加入。

#### Scenario: Evidence context does not mutate user prompt / 证据上下文不修改用户 Prompt
- **WHEN** evidence-first context is projected into a model request
- **THEN** the user message remains byte-equivalent to the submitted prompt and evidence appears only in runtime-owned context sections or messages
- **中文** 当 evidence-first context 被投影到 model request 时，user message 必须与提交 prompt 字节等价，evidence 只能出现在 runtime-owned context sections 或 messages 中。

#### Scenario: Unsupported claim feedback reaches model / 未支持声明反馈给模型
- **WHEN** the workflow detects unsupported strict claims before final output acceptance
- **THEN** the agent loop can feed bounded diagnostics back to the model for revision, or fail closed if retry policy is exhausted
- **中文** 当 workflow 在最终输出接受前检测到 unsupported strict claims 时，agent loop 可以将有界 diagnostics 回传给模型进行修订，或在 retry policy 耗尽时安全失败。

### Requirement: Agent Loop Supports Governed Self-Repair Phase / Agent Loop 支持受治理自修复阶段

The agent loop SHALL support a governed self-repair phase between repairable failure detection and terminal failure emission when request policy, safety gates, and budgets allow repair.

agent loop 必须在检测到可修复失败与发出 terminal failure 之间支持受治理 self-repair phase，前提是 request policy、safety gates 与 budgets 允许修复。

#### Scenario: Repairable failure enters repair phase / 可修复失败进入修复阶段
- **WHEN** a tool execution, model provider event, artifact checker, or verification command fails with a repairable classification
- **THEN** the agent loop emits self-repair classification and planning events before either attempting a governed repair or failing with a typed stop reason
- **中文** 当 tool execution、model provider event、artifact checker 或 verification command 以可修复分类失败时，agent loop 必须在尝试受治理修复或以 typed stop reason 失败之前，发出 self-repair classification 与 planning events。

#### Scenario: Final verifier failure reruns through repair feedback / 最终验证失败通过修复反馈重跑
- **WHEN** final verification fails and self-repair is enabled with remaining repair and model-iteration budget
- **THEN** the agent loop feeds bounded verifier diagnostics back to the model as runtime-owned repair context, clears the unaccepted assistant draft, and reruns the normal model/tool loop before any terminal completion can be emitted
- **中文** 当最终验证失败，且 self-repair 已启用并仍有 repair 与 model-iteration 预算时，agent loop 必须将有界 verifier diagnostics 作为 runtime-owned repair context 回灌给模型、清空尚未被接受的 assistant draft，并在发出任何 terminal completion 之前重跑正常 model/tool loop。

#### Scenario: Unrepaired verifier failure fails closed / 未修复验证失败安全失败
- **WHEN** final verification fails but repair is disabled, unsafe, exhausted, or there is no remaining model-iteration budget
- **THEN** the agent loop emits a typed failed terminal event instead of reporting verifier failure as completed delivery
- **中文** 当最终验证失败但 repair 被禁用、不安全、耗尽，或没有剩余 model-iteration 预算时，agent loop 必须发出 typed failed terminal event，而不是把 verifier failure 报告成已完成交付。

#### Scenario: Non-repairable failure remains fail-closed / 不可修复失败保持安全失败
- **WHEN** a failure is classified as non-repairable, unsafe, missing approval, missing credential, or outside allowed tool projection
- **THEN** the agent loop emits terminal failure or escalation evidence without mutating the workspace or creating an extra model repair turn
- **中文** 当 failure 被分类为 non-repairable、unsafe、missing approval、missing credential 或 outside allowed tool projection 时，agent loop 必须发出 terminal failure 或 escalation evidence，且不得修改 workspace 或创建额外 model repair turn。

### Requirement: Agent Loop Summary Includes Repair Outcome / Agent Loop Summary 包含修复结果

The agent loop SHALL include repair-loop outcome summaries in terminal events whenever repair classification or repair attempts occur.

只要发生 repair classification 或 repair attempts，agent loop 必须在 terminal events 中包含 repair-loop outcome summaries。

#### Scenario: Completed turn includes repair success summary / 完成回合包含修复成功摘要
- **WHEN** a turn initially fails, performs a repair attempt, passes verification, and completes
- **THEN** `agent.loop.completed` includes repair activation count, successful attempt id, verification summary, touched-scope summary, and redaction metadata
- **中文** 当一个 turn 先失败、执行 repair attempt、通过 verification 并完成时，`agent.loop.completed` 必须包含 repair activation count、successful attempt id、verification summary、touched-scope summary 与 redaction metadata。

#### Scenario: Failed turn includes repair stop summary / 失败回合包含修复停止摘要
- **WHEN** a turn stops after repair attempts fail or are blocked
- **THEN** `agent.loop.failed` includes failure classification, attempt count, last verification summary, stop reason, escalation action when any, and redaction metadata
- **中文** 当一个 turn 在 repair attempts 失败或被阻止后停止时，`agent.loop.failed` 必须包含 failure classification、attempt count、last verification summary、stop reason、可能的 escalation action 与 redaction metadata。

### Requirement: Agent Loop Preserves Existing Tool Governance During Repair / Agent Loop 在修复中保留工具治理

The agent loop SHALL route repair tool calls through the same model-visible capability projection, tool-intent preflight, policy engine, runtime kernel, hooks, and tool-result evidence path as normal tool calls.

agent loop 必须让 repair tool calls 经过与普通 tool calls 相同的 model-visible capability projection、tool-intent preflight、policy engine、runtime kernel、hooks 与 tool-result evidence path。

#### Scenario: Repair tool call uses normal execution path / 修复工具调用使用普通执行路径
- **WHEN** a repair attempt requests a file read, file write, shell, artifact check, or other capability
- **THEN** the request is validated, preflighted, governed, executed, recorded, and fed back to the model using the existing runtime tool path
- **中文** 当 repair attempt 请求 file read、file write、shell、artifact check 或其他 capability 时，该请求必须通过现有 runtime tool path 完成 validate、preflight、govern、execute、record 与 model feedback。

#### Scenario: Repair cannot bypass rejected tool intent / 修复不得绕过被拒绝工具意图
- **WHEN** tool-intent preflight rejects or repairs a repair-mode tool request
- **THEN** the agent loop records the preflight decision as repair evidence and MUST NOT execute the original unsafe intent
- **中文** 当 tool-intent preflight 拒绝或修复 repair-mode tool request 时，agent loop 必须将 preflight decision 记录为 repair evidence，且不得执行原始 unsafe intent。

### Requirement: Mode-Aware Turn Lifecycle / 感知模式的 Turn 生命周期

The agent loop SHALL emit mode-aware lifecycle events for classification, evidence, planning, execution, verification, repair, synthesis, and terminal completion when those phases are used or skipped by policy.

agent loop 必须在 classification、evidence、planning、execution、verification、repair、synthesis 与 terminal completion 阶段被使用或被 policy 跳过时，发出 mode-aware lifecycle events。

#### Scenario: Turn records phase plan / Turn 记录阶段计划
- **WHEN** an agent loop starts a task
- **THEN** it emits or records a phase plan that identifies required phases, skipped phases, skip reasons, budgets, active interaction mode, and active agent mode
- **中文** 当 agent loop 启动任务时，必须 emit 或记录 phase plan，标识 required phases、skipped phases、skip reasons、budgets、active interaction mode 与 active agent mode。

#### Scenario: Terminal event summarizes phases / 终止事件总结阶段
- **WHEN** a turn completes, fails, cancels, times out, or is rejected
- **THEN** the terminal event includes a bounded phase summary with evidence, delegation, verification, repair, and synthesis outcomes
- **中文** 当 turn completed、failed、cancelled、timed out 或 rejected 时，terminal event 必须包含有界 phase summary，说明 evidence、delegation、verification、repair 与 synthesis outcomes。

### Requirement: Evidence And Verification Are Product Phases / 证据与验证是产品阶段

The agent loop SHALL treat evidence and verification loops as product orchestration phases independent from model reasoning effort.

agent loop 必须将 evidence 与 verification loops 作为独立于模型 reasoning effort 的产品编排阶段。

#### Scenario: Evidence count is measured externally / 外部计量 Evidence 次数
- **WHEN** a turn searches repository, project, code, generated artifact, or evaluation evidence
- **THEN** the agent loop records evidence source count, selected evidence count, unsupported claim count, and evidence loop rounds separately from model usage
- **中文** 当 turn 搜索 repository、project、code、generated artifact 或 evaluation evidence 时，agent loop 必须将 evidence source count、selected evidence count、unsupported claim count 与 evidence loop rounds 与 model usage 分开记录。

#### Scenario: Verification count is measured externally / 外部计量 Verification 次数
- **WHEN** a turn verifies output through tests, typecheck, artifact checks, lint, browser checks, or manual inspection records
- **THEN** the agent loop records verification commands, results, failures, corrections, and final verdict separately from provider reasoning tokens
- **中文** 当 turn 通过 tests、typecheck、artifact checks、lint、browser checks 或 manual inspection records 验证输出时，agent loop 必须将 verification commands、results、failures、corrections 与 final verdict 与 provider reasoning tokens 分开记录。

### Requirement: Coordinator Turn Routing / Coordinator Turn 路由

The agent loop SHALL route coordinator, worker, and verifier work through runtime-owned events and governed capability paths.

agent loop 必须通过 runtime-owned events 与 governed capability paths 路由 coordinator、worker 与 verifier 工作。

#### Scenario: Worker launch is runtime-owned / Worker 启动由 Runtime 拥有
- **WHEN** an agent requests worker launch
- **THEN** the request is validated through agent-management, policy, session lineage, scope projection, and runtime events before the child loop starts
- **中文** 当 agent 请求 worker launch 时，该请求必须在 child loop 启动前通过 agent-management、policy、session lineage、scope projection 与 runtime events 验证。

#### Scenario: Worker result returns through event stream / Worker 结果通过事件流返回
- **WHEN** a child loop reaches terminal status
- **THEN** the parent receives a typed worker-result event instead of raw transcript text masquerading as a user prompt
- **中文** 当 child loop 到达 terminal status 时，parent 必须收到 typed worker-result event，而不是伪装成 user prompt 的 raw transcript text。

### Requirement: Safe Phase Skipping / 安全跳过阶段

The agent loop SHALL skip phases for simple or low-risk tasks only when it records a typed skip decision.

agent loop 必须只在记录类型化 skip decision 时，才能为简单或低风险任务跳过阶段。

#### Scenario: Simple casual prompt stays single phase / 简单随意 Prompt 保持单阶段
- **WHEN** a prompt does not reference project facts, code, files, tools, generated artifacts, or mutation
- **THEN** the agent loop may run a simple default path and records that evidence, planning, verification, delegation, and repair were not required
- **中文** 当 prompt 不引用 project facts、code、files、tools、generated artifacts 或 mutation 时，agent loop 可以运行 simple default path，并记录 evidence、planning、verification、delegation 与 repair 不需要执行。

#### Scenario: High-risk skip is rejected / 高风险跳过被拒绝
- **WHEN** policy marks a task as high risk and a required evidence or verification phase has no available budget or provider
- **THEN** the loop fails closed or asks for explicit user approval instead of silently skipping the phase
- **中文** 当 policy 将任务标记为 high risk，且必需 evidence 或 verification phase 没有可用 budget 或 provider 时，loop 必须安全失败或请求显式用户批准，而不是静默跳过阶段。

### Requirement: Layered Delivery Workflow Uses The Existing Agent Loop / 分层交付工作流复用现有 Agent Loop

The agent loop SHALL coordinate project rules, tool governance, output contracts, verification expectations, and context or memory evidence through the existing evidence, planning, execution, verification, repair, synthesis, and terminal phases.

agent loop 必须通过现有 evidence、planning、execution、verification、repair、synthesis 与 terminal phases 协调 project rules、tool governance、output contracts、verification expectations 与 context 或 memory evidence。

#### Scenario: Turn records delivery layer plan / Turn 记录交付分层计划

- **WHEN** a task begins and any delivery layer is required by task intent, repository policy, output contract, tool projection, or memory policy
- **THEN** the phase plan records which layers are required, skipped, degraded, or not applicable
- **AND** the terminal event summarizes each required layer outcome before reporting completion or failure
- **中文** 当任务开始且任一交付层因 task intent、repository policy、output contract、tool projection 或 memory policy 被要求时，phase plan 必须记录哪些层 required、skipped、degraded 或 not applicable；terminal event 必须在报告完成或失败前汇总每个 required layer outcome。

#### Scenario: Layer gap routes to owning subsystem / 层级缺口归属到负责子系统

- **WHEN** verification detects a missing project rule, unavailable tool, unsatisfied output contract, absent required memory, or missing regression evidence
- **THEN** the agent loop records the owning layer and failure code instead of hiding the gap inside assistant text
- **中文** 当验证检测到 missing project rule、unavailable tool、unsatisfied output contract、absent required memory 或 missing regression evidence 时，agent loop 必须记录 owning layer 与 failure code，而不是把缺口隐藏在 assistant text 中。

### Requirement: Structured Delivery Completion Is Evidence-Bound / 结构化交付完成受证据约束

For structured, mutating, or externally scored tasks, the agent loop SHALL NOT emit a successful delivery terminal event until required output contracts and verification expectations are satisfied or explicitly not applicable.

对于结构化、有副作用或外部评分的任务，agent loop 不得在 required output contracts 与 verification expectations 被满足或明确不适用之前发出成功交付终态事件。

#### Scenario: Model text alone is insufficient / 仅模型文本不足以完成

- **WHEN** a task requires a JSON artifact, schema-compliant file, command plan, workspace mutation, or benchmark-checkable output
- **THEN** final assistant text without matching contract verification does not count as completed delivery
- **AND** the loop either enters self-repair or fails closed with typed diagnostics
- **中文** 当任务要求 JSON artifact、schema-compliant file、command plan、workspace mutation 或可由 benchmark 检查的 output 时，只有 final assistant text 而没有匹配的 contract verification 不得计为完成交付；loop 必须进入 self-repair 或带 typed diagnostics 安全失败。

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

### Requirement: Execution-Bearing Coding Prompts Use Primary Role Workflows / 执行型 Coding Prompt 使用 Primary Role Workflow

The agent loop SHALL route execution-bearing coding prompts through a primary role workflow instead of treating the role profile as an advisory prompt hint.

agent loop 必须将具备执行性质的 coding prompt 路由到 primary role workflow，而不是把 role profile 当作 advisory prompt hint。

#### Scenario: Engineering task has ready-stage control / 工程任务具备 Ready-Stage Control

- **WHEN** a user prompt asks the CLI to fix, implement, modify, debug, test, verify, refactor, review, or otherwise perform repository-sensitive engineering work
- **THEN** the selected profile is a primary engineering role profile
- **AND** the provider request metadata includes ready-stage control before model dispatch
- **AND** the model-visible required action is constrained by the active engineering stage
- **中文** 当用户 prompt 要求 CLI 修复、实现、修改、调试、测试、验证、重构、审查或执行其它 repository-sensitive engineering work 时，选中的 profile 必须是 primary engineering role profile；provider request metadata 必须在模型派发前包含 ready-stage control；模型可见的 required action 必须受当前 engineering stage 约束。

#### Scenario: Casual chat remains advisory / 闲聊保持 Advisory

- **WHEN** a user prompt is casual chat, low-risk explanation, or pure informational conversation without repository-sensitive execution intent
- **THEN** the selected profile may remain advisory
- **AND** the loop must not force mutation-oriented workflow stages or required tool calls
- **中文** 当用户 prompt 是闲聊、低风险解释或没有 repository-sensitive execution intent 的纯信息对话时，选中的 profile 可以保持 advisory；loop 不得强制进入 mutation-oriented workflow stage 或 required tool call。

### Requirement: Stable Profile Contract Is Separate From Dynamic Run State / 稳定 Profile Contract 与动态 Run State 分离

The agent loop SHALL keep stable role/workflow/capability profile contracts separate from dynamic run state and progress markers.

agent loop 必须将稳定的 role/workflow/capability profile contract 与动态 run state、progress marker 分离。

#### Scenario: Provider request distinguishes stable and dynamic profile data / Provider Request 区分稳定与动态 Profile 数据

- **WHEN** a primary role workflow is projected into a provider request
- **THEN** stable profile identifiers, stage contracts, allowed capabilities, and exit criteria are represented separately from current attempts, produced refs, diagnostics, and stage status
- **AND** cache/prefix analysis can distinguish profile contract churn from dynamic run-state churn
- **中文** 当 primary role workflow 被投影到 provider request 时，稳定的 profile id、stage contract、allowed capabilities 与 exit criteria 必须与当前 attempts、produced refs、diagnostics 与 stage status 分离表达；cache/prefix analysis 必须能区分 profile contract churn 与 dynamic run-state churn。

### Requirement: Ordinary CLI Stage Progression

The agent loop SHALL distinguish ordinary CLI staged workflows from evaluation runner workflows before applying stage acceptance gates.

Agent loop 必须在应用 stage acceptance gate 前区分普通 CLI staged workflows 与 evaluation runner workflows。

#### Scenario: Ordinary CLI workflow auto-advances from accepted evidence / 普通 CLI workflow 根据已接受证据自动推进

- **WHEN** an ordinary CLI engineering workflow stage completes a runtime-accepted tool action
- **THEN** the agent loop records typed stage evaluation evidence and advances the stage without requiring technical-director acceptance
- **AND** the next dependent stage becomes ready when its input refs are satisfied
- **中文** 当普通 CLI engineering workflow stage 完成 runtime 已接受的工具动作时，agent loop 必须记录结构化 stage evaluation evidence，并在不要求技术总监验收的情况下推进该 stage；当依赖 input refs 满足时，下一个依赖 stage 必须变为 ready。

#### Scenario: Evaluation runner workflows keep supervisor acceptance / Evaluation runner workflow 保留 supervisor 验收

- **WHEN** an evaluation or managed runner workflow stage completes tool evidence
- **THEN** the agent loop MAY require supervisor or technical-director acceptance before downstream expansion according to the profile's stage acceptance mode
- **中文** 当 evaluation 或 managed runner workflow stage 完成工具证据时，agent loop 可以根据 profile 的 stage acceptance mode 要求 supervisor 或技术总监验收后再扩展下游。

### Requirement: Active Workflow Projection Does Not Fall Back To All Tools

Primary staged workflows SHALL NOT expose every model-visible tool merely because no stage is currently ready.

Primary staged workflows 不得仅因为当前没有 ready stage 就暴露所有 model-visible tools。

#### Scenario: Active workflow without ready stage fails closed / Active workflow 无 ready stage 时安全失败

- **WHEN** a primary staged workflow has unfinished stages but no ready stage and no explicit supervisor gate override
- **THEN** the agent loop emits a typed workflow orchestration blocker or projects a bounded supervisor recovery action
- **AND** it does not fall back to all registered model-visible tools
- **中文** 当 primary staged workflow 存在未完成 stage、但没有 ready stage 且没有显式 supervisor gate override 时，agent loop 必须发出 typed workflow orchestration blocker 或投影有界 supervisor recovery action；不得回退到所有已注册 model-visible tools。

