# workflow-orchestration Specification

## Purpose
Define workflow orchestration requirements for invocation lifecycles, step ordering, rollback, hook points, and governed runtime coordination.

定义 workflow orchestration 对 invocation lifecycles、step ordering、rollback、hook points 与受治理 runtime coordination 的要求。
## Requirements
### Requirement: Workflow Task Model

The system SHALL define a workflow orchestration layer for user tasks, workflow graphs, steps, dependencies, artifacts, checkpoints, handoff, rollback, retry policy, and completion criteria.

系统必须定义 workflow orchestration layer，管理 user tasks、workflow graphs、steps、dependencies、artifacts、checkpoints、handoff、rollback、retry policy 和 completion criteria。

#### Scenario: Create workflow from user turn

- **WHEN** runtime receives a user turn
- **THEN** the workflow orchestrator can create a workflow with task id, owner agent, session id, initial step, completion criteria, and trace metadata

#### Scenario: Step dependencies are validated

- **WHEN** a workflow graph is registered or resumed
- **THEN** the orchestrator validates step ids, dependencies, cycles, required artifacts, and rollback metadata

### Requirement: Pipeline Execution

The workflow orchestrator SHALL emit structured events for step scheduled, started, blocked, completed, failed, skipped, rolled back, and checkpointed states.

workflow orchestrator 必须为 step scheduled、started、blocked、completed、failed、skipped、rolled back 和 checkpointed states 输出结构化事件。

#### Scenario: Single-turn workflow emits step events

- **WHEN** the first implementation executes a single-turn workflow
- **THEN** it still emits workflow and step events around runtime/model/capability activity

#### Scenario: Workflow uses concurrency orchestrator

- **WHEN** a workflow step executes asynchronous work
- **THEN** it is scheduled through the concurrency orchestrator with task scope, deadline, cancellation, and resource metadata

### Requirement: Checkpoint and Rollback

The workflow orchestrator SHALL integrate checkpoint and rollback metadata with the session store.

workflow orchestrator 必须将 checkpoint 和 rollback metadata 接入 session store。

#### Scenario: Create workflow checkpoint

- **WHEN** a workflow reaches a checkpoint boundary
- **THEN** it records checkpoint metadata with session position, workflow id, step id, artifacts, and rollback strategy

#### Scenario: Rollback is explicit

- **WHEN** a workflow step needs rollback
- **THEN** the orchestrator emits a rollback event and applies only declared rollback actions after policy approval when required

### Requirement: Handoff and Delegation

The workflow model SHALL include handoff and delegation metadata for future sub-agent and multi-agent execution.

workflow model 必须包含 handoff 和 delegation metadata，用于未来 sub-agent 和 multi-agent execution。

#### Scenario: Delegation records scope constraints

- **WHEN** a future workflow delegates a step to another agent
- **THEN** the delegation metadata includes source agent, target agent definition, task summary, scope constraints, approval requirements, and session linkage

### Requirement: Workflow Tests

The framework SHALL include deterministic tests for workflow graph validation, step ordering, checkpoint creation, rollback metadata, and event emission.

框架必须包含 workflow graph validation、step ordering、checkpoint creation、rollback metadata 和 event emission 的确定性测试。

#### Scenario: Workflow replay matches golden events

- **WHEN** a workflow golden trace is replayed
- **THEN** normalized workflow events match the expected sequence

### Requirement: Executable Workflow Nodes

The workflow orchestrator SHALL represent executable capability invocations as typed workflow nodes with dependencies, owner agent, expected artifacts, rollback metadata, checkpoint policy, and execution envelope references.

workflow orchestrator 必须将 executable capability invocations 表示为 typed workflow nodes，并包含 dependencies、owner agent、expected artifacts、rollback metadata、checkpoint policy 和 execution envelope references。

#### Scenario: Workflow plans tool execution

- **WHEN** a user turn requires a tool, command, skill-backed action, MCP call, hook mutation, model call, workspace edit, plugin lifecycle action, or subagent delegation
- **THEN** the workflow graph contains an executable node instead of allowing direct primitive invocation from the host or arbitrary package

#### Scenario: Workflow does not own locks

- **WHEN** an executable workflow node declares resource needs
- **THEN** the workflow records semantic dependencies and resource intent but leaves lock acquisition, rate limits, cancellation, deadlines, and retry budget enforcement to the concurrency scheduler

### Requirement: Minimal Kernel Workflow Boundary

The workflow orchestrator SHALL create a minimal workflow and task boundary for each kernel invocation.

workflow orchestrator 必须为每个 kernel invocation 创建最小 workflow 和 task boundary。

#### Scenario: Create workflow for capability invocation

- **WHEN** the kernel accepts an executable capability request
- **THEN** workflow orchestration records workflow id, task id, owner agent when available, session id when available, step id, capability id, envelope id, trace context, and completion criteria

#### Scenario: Close workflow on terminal result

- **WHEN** the scheduled executable task completes, fails, times out, or is cancelled
- **THEN** workflow orchestration emits a terminal workflow event linked to the same envelope and task

### Requirement: Workflow Defers Execution Enforcement

The workflow orchestrator SHALL not bypass the scheduler for executable work.

workflow orchestrator 不得绕过 scheduler 执行 executable work。

#### Scenario: Workflow records intent only

- **WHEN** a workflow step declares resource or timeout intent
- **THEN** workflow stores the semantic intent and the scheduler enforces queueing, timeout, cancellation, and concurrency

### Requirement: Single Workflow Closure

Workflow orchestration SHALL close each kernel invocation exactly once with a terminal status linked to the same envelope, task, and trace lineage.

workflow orchestration 必须对每个 kernel invocation 只关闭一次，并使用与同一 envelope、task 和 trace lineage 关联的 terminal status。

#### Scenario: Successful invocation closes once

- **WHEN** a kernel invocation completes successfully
- **THEN** exactly one workflow closed event is emitted after capability and scheduler terminal events

#### Scenario: Cancelled invocation closes once

- **WHEN** a kernel invocation is cancelled or timed out
- **THEN** exactly one workflow closed event is emitted with cancelled or timed-out status

### Requirement: Runtime-Owned Tool Pipelines / Runtime 拥有工具管线
Workflow orchestration SHALL represent tool chaining as runtime-owned pipelines with typed steps, declared inputs, artifact references, policy decisions, preflight results, execution results, and replay metadata.

workflow orchestration 必须把工具衔接表示为 runtime-owned pipelines，包含 typed steps、declared inputs、artifact references、policy decisions、preflight results、execution results 与 replay metadata。

#### Scenario: Sequential pipeline routes artifacts / 顺序管线路由 Artifact
- **WHEN** a pipeline reads a file, applies a patch, and runs tests
- **THEN** each step consumes explicit inputs or artifact references and records its own policy, preflight, execution, and evidence records
- **中文** 当 pipeline 读取文件、应用 patch 并运行测试时，每一步必须消费显式 inputs 或 artifact references，并记录自己的 policy、preflight、execution 与 evidence records。

### Requirement: Executors Do Not Call Executors / Executor 不得互调
Capability executors SHALL NOT directly invoke other capability executors; all chaining SHALL go through the runtime pipeline or agent loop.

capability executors 不得直接调用其他 capability executors；所有衔接必须经过 runtime pipeline 或 agent loop。

#### Scenario: Private tool call is rejected / 私下工具调用被拒绝
- **WHEN** an implementation attempts to call another tool executor from inside a tool executor
- **THEN** architecture lint or runtime validation fails with a stable diagnostic
- **中文** 当实现试图在一个 tool executor 内调用另一个 tool executor 时，architecture lint 或 runtime validation 必须以稳定 diagnostic 失败。

### Requirement: Parallel Pipelines Preserve Isolation / 并行管线保持隔离
Parallel pipeline steps SHALL declare independent scopes, resource locks, merge strategy, and conflict behavior before execution.

并行 pipeline steps 必须在执行前声明 independent scopes、resource locks、merge strategy 与 conflict behavior。

#### Scenario: Overlapping write scopes block parallel mutation / 写范围重叠阻止并行修改
- **WHEN** two parallel steps request overlapping write scope
- **THEN** orchestration rejects the parallel plan or serializes the steps with explicit diagnostics
- **中文** 当两个 parallel steps 请求重叠 write scope 时，orchestration 必须拒绝 parallel plan 或以显式 diagnostics 串行化这些 steps。

### Requirement: Stream Pipelines Are Bounded / 流式管线有边界
Streaming pipelines SHALL preserve backpressure, truncation, redaction, cancellation, and replay-safe summaries between steps.

流式 pipelines 必须在 steps 之间保留 backpressure、truncation、redaction、cancellation 与 replay-safe summaries。

#### Scenario: Stream truncation is recorded / 流式截断被记录
- **WHEN** one step streams more output than the next step can accept
- **THEN** orchestration records truncation metadata and passes a bounded artifact reference rather than unbounded raw content
- **中文** 当某一步 stream 的输出超过下一步可接受范围时，orchestration 必须记录 truncation metadata，并传递 bounded artifact reference，而不是无边界 raw content。

### Requirement: Pipeline Families Are Executable Runtime Capabilities / Pipeline Families 是可执行 Runtime Capabilities
The workflow orchestration layer SHALL expose `pipeline.sequence`, `pipeline.parallel`, `pipeline.artifact-routing`, and `pipeline.stream` as runtime-owned executable capabilities.

workflow orchestration layer 必须把 `pipeline.sequence`、`pipeline.parallel`、`pipeline.artifact-routing` 与 `pipeline.stream` 暴露为 runtime-owned executable capabilities。

#### Scenario: Sequential pipeline records every governed step / 顺序管线记录每个受治理 Step
- **WHEN** a sequential pipeline reads a file, applies a patch, and runs tests
- **THEN** every step records policy, preflight, execution, evidence, replay metadata, and bounded artifact references
- **中文** 当顺序管线读取文件、应用 patch 并运行测试时，每一步都必须记录 policy、preflight、execution、evidence、replay metadata 与 bounded artifact references。

### Requirement: Private Executor Chaining Is Rejected / 私下 Executor 互调被拒绝
Tool executors SHALL NOT call other tool executors directly; all composition SHALL go through runtime pipelines or the agent loop.

tool executors 不得直接调用其他 tool executors；所有组合必须通过 runtime pipelines 或 agent loop。

#### Scenario: Lint catches executor-to-executor call / Lint 捕获 Executor 互调
- **WHEN** a tool executor imports or resolves another executor to run it privately
- **THEN** architecture lint or runtime validation fails with a stable diagnostic
- **中文** 当 tool executor 导入或解析另一个 executor 并私下运行时，architecture lint 或 runtime validation 必须以稳定 diagnostic 失败。

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

### Requirement: Role Workflow Catalog Defines Runtime-Owned Stage Contracts / Role Workflow Catalog 定义 Runtime 拥有的 Stage Contract

The workflow orchestration layer SHALL treat common professional role workflows as runtime-owned contracts with explicit stages, dependencies, allowed capabilities, evidence refs, no-progress policy, and acceptance gates.

workflow orchestration layer 必须将常用职业 role workflow 视为 runtime 拥有的 contract，包含显式 stage、dependencies、allowed capabilities、evidence refs、no-progress policy 与 acceptance gates。

#### Scenario: Role profile compiles through catalog layers / Role Profile 通过 Catalog 分层编译

- **WHEN** an execution-bearing task selects a role profile
- **THEN** the orchestrator compiles it through role profile, workflow profile, and capability profile layers
- **AND** the compiled workflow records the role id, workflow graph id, stage ids, stage objectives, allowed capability ids, expected evidence refs, and acceptance criteria
- **中文** 当具备执行性质的任务选择 role profile 时，orchestrator 必须通过 role profile、workflow profile 与 capability profile 三层编译；编译后的 workflow 必须记录 role id、workflow graph id、stage ids、stage objectives、allowed capability ids、expected evidence refs 与 acceptance criteria。

#### Scenario: Dynamic model decisions stay inside stages / 动态模型决策限定在 Stage 内

- **WHEN** a primary role workflow has an active ready stage
- **THEN** the model may choose tactics only within that stage's allowed capability profile
- **AND** the orchestrator must not count out-of-stage or disallowed capability use as stage progress
- **中文** 当 primary role workflow 有 active ready stage 时，模型只能在该 stage 的 allowed capability profile 内选择策略；orchestrator 不得把越过 stage 或不允许的 capability use 计为 stage progress。

### Requirement: Capability Affordance Compilation / 能力可供性编译

Workflow orchestration SHALL compile profile and stage capability-family requirements into a model-visible executable tool projection before dispatching a model request.

workflow orchestration 必须在 dispatch model request 前，将 profile 与 stage 的 capability-family requirements 编译为 model-visible executable tool projection。

#### Scenario: Stage projection exposes required tools / Stage Projection 暴露必需工具
- **WHEN** a stage declares required capability families
- **THEN** the compiler resolves each family through registry, host policy, sandbox, credential readiness, and executor availability
- **AND** the prompt assembly evidence records required family ids, resolved tool ids, hidden tool ids, projection policy, and projection status
- **中文** 当 stage 声明 required capability families 时，compiler 必须通过 registry、host policy、sandbox、credential readiness 与 executor availability 解析每个 family；prompt assembly evidence 必须记录 required family ids、resolved tool ids、hidden tool ids、projection policy 与 projection status。

#### Scenario: Missing required capability fails closed / 缺失必需能力安全失败
- **WHEN** a required family cannot resolve to at least one executable model-visible tool
- **THEN** the workflow emits a typed terminal blocker before provider dispatch
- **AND** the blocker is classified as `blocked-by-cli-capability-gap`, `blocked-by-cli-bug`, or `invalid-test-environment` according to the failing boundary
- **中文** 当 required family 无法解析为至少一个 executable model-visible tool 时，workflow 必须在 provider dispatch 前发出 typed terminal blocker；该 blocker 必须根据失败边界分类为 `blocked-by-cli-capability-gap`、`blocked-by-cli-bug` 或 `invalid-test-environment`。

#### Scenario: Optional capability degrades with evidence / 可选能力带证据降级
- **WHEN** an optional family is unavailable but all required families are ready
- **THEN** the stage may proceed in degraded mode
- **AND** the unavailable optional family is recorded in diagnostics without being hidden from gap reporting
- **中文** 当 optional family 不可用但所有 required families 已 ready 时，stage 可以以 degraded mode 继续；不可用的 optional family 必须记录在 diagnostics 中，且不得从 gap reporting 中隐藏。

### Requirement: Pipeline Outputs Require Evaluation Gates / Pipeline 输出需要评估 Gate

Workflow orchestration SHALL evaluate every pipeline step output before downstream steps can treat it as accepted input.

workflow orchestration 必须评估每个 pipeline step output，下游 step 才能将其作为已接受输入使用。

#### Scenario: Stage identity matches required progress action / 阶段身份匹配必需推进动作
- **WHEN** a ready stage requires mutation-grade progress such as write, edit, or patch
- **THEN** the stage id, stage kind, objective, ready-state prompt, and required next action describe a production or implementation action rather than a test-only action
- **AND** the ready-state prompt lists allowed capabilities, progress capabilities, and the exact required capability choices before provider dispatch
- **中文** 当 ready stage 要求 write、edit 或 patch 等 mutation-grade progress 时，stage id、stage kind、objective、ready-state prompt 与 required next action 必须描述 production/implementation action，而不是 test-only action；ready-state prompt 必须在 provider dispatch 前列出 allowed capabilities、progress capabilities 与精确 required capability choices。

#### Scenario: Downstream consumes accepted artifacts only / 下游只消费已验收产物
- **WHEN** a step produces a patch, file edit, command result, test result, browser artifact, or generated file
- **THEN** downstream steps receive an accepted artifact reference only after the configured gate checks status, evidence type, scope, and redaction metadata
- **中文** 当某个 step 产生 patch、file edit、command result、test result、browser artifact 或 generated file 时，只有 configured gate 检查 status、evidence type、scope 与 redaction metadata 后，下游 step 才能收到 accepted artifact reference。

#### Scenario: Failed gate blocks pass credit / Gate 失败阻止 Pass 计分
- **WHEN** a stage output lacks required evidence or fails its checker
- **THEN** the workflow may continue for repair if policy allows it
- **AND** the task cannot be marked pass until the missing or failed evidence is corrected
- **中文** 当 stage output 缺少必需 evidence 或 checker 失败时，workflow 可以在 policy 允许时继续修复；但在缺失或失败 evidence 被纠正前，task 不得标记为 pass。

#### Scenario: Artifact paths preserve requested literals / Artifact 路径保留请求字面量
- **WHEN** a task explicitly requests generated artifact paths
- **THEN** prompt assembly exposes the requested path literals in the generic file mutation output contract before model dispatch
- **AND** artifact delivery gates compare requested path literals against produced workspace paths case-sensitively
- **AND** case-mismatched or otherwise different paths are recorded as missing requested artifacts rather than accepted delivery evidence
- **AND** runtime output verification performs the same case-sensitive literal check regardless of host filesystem case sensitivity
- **AND** automatic staged workflows do not close as completed until required artifact path checks pass or a bounded repair path is exhausted
- **AND** while an artifact output-contract repair gate is active, file mutation tool calls that target a case-mismatched requested artifact path are rejected before execution with feedback containing the exact requested path literal
- **中文** 当任务显式请求生成 artifact path 时，prompt assembly 必须在 model dispatch 前通过通用 file mutation output contract 暴露请求路径字面量；artifact delivery gate 必须以大小写敏感方式比较请求路径字面量与工作区实际产物路径；大小写不匹配或其他不同路径必须记录为缺失请求 artifact，而不能作为已验收交付证据；runtime output verification 必须不受宿主文件系统大小写敏感性影响，执行同样的大小写敏感字面量检查；automatic staged workflow 在必需 artifact path checks 通过或 bounded repair 耗尽前不得关闭为 completed；当 artifact output-contract repair gate 激活时，大小写不匹配的 file mutation tool call 必须在执行前被拒绝，并返回精确请求路径字面量作为反馈。

#### Scenario: Non-visible stale supporting tools are rejected before execution / 非可见旧支持工具在执行前拒绝
- **WHEN** a produce, materialize, or repair stage is ready and the model requests a supporting tool that is not in the current visible projection
- **THEN** workflow orchestration rejects the request before kernel execution
- **AND** the rejection is recorded as `workflow-required-action.missed` with a bounded correction message that names the exact provider-visible function names for the current stage
- **AND** repeated misses consume a bounded correction budget with attempt counts before fail-closed classification
- **中文** 当 produce、materialize 或 repair stage 已 ready，但模型请求的 supporting tool 不在当前可见投影中时，workflow orchestration 必须在 kernel execution 前拒绝该请求；该拒绝必须记录为 `workflow-required-action.missed`，并用 bounded correction message 给出当前 stage 的精确 provider-visible function names；重复 miss 必须消耗带 attempt counts 的 bounded correction budget，然后才能 fail closed。

### Requirement: Engineering Profiles Are Workflow Contracts / 工程 Profile 是 Workflow Contract

Reusable engineering profiles SHALL be represented as staged workflow contracts with success criteria, allowed capability families, expected evidence refs, fallback blocker criteria, and decision-board projection metadata.

可复用工程 profile 必须表示为 staged workflow contracts，包含 success criteria、allowed capability families、expected evidence refs、fallback blocker criteria 与 decision-board projection metadata。

#### Scenario: Software engineer profile stages engineering work / 软件工程师 Profile 分阶段执行工程任务

- **WHEN** the `software-engineer` profile is active for a coding task
- **THEN** the workflow SHALL include understand, plan, change, verify, and report stages
- **AND** each stage SHALL declare allowed tool families and required evidence before downstream stages become ready
- **AND** the runtime SHALL not mark stage success from text-only claims when required evidence refs are missing.
- **中文** 当 `software-engineer` profile 用于 coding task 时，workflow 必须包含 understand、plan、change、verify 与 report 阶段；每个阶段必须声明 allowed tool families 与下游阶段 ready 前所需 evidence；当缺少必需 evidence refs 时，runtime 不得仅根据文本声明标记阶段成功。

### Requirement: Read-only Task Workflow Routing

The CLI SHALL route read-only analysis, localization, and architecture-inspection prompts to a read-only workflow/profile surface that can complete through read/search/diff evidence without requiring mutation or implementation-stage progress.

CLI 必须将只读分析、定位和架构检查类 prompt 路由到只读 workflow/profile，使其可以通过 read/search/diff evidence 完成，而不要求 mutation 或实现阶段推进。

#### Scenario: Read-only analysis avoids engineering implementation workflow

- **GIVEN** a prompt asks to analyze, locate, or inspect repository architecture without editing files
- **WHEN** the CLI assembles runtime workflow guidance
- **THEN** the selected profile SHALL not require implementation-stage mutation progress
- **AND** read/search/glob/diff evidence SHALL be sufficient to advance the workflow

- **中文** 给定 prompt 要求分析、定位或检查仓库架构且不要编辑文件；当 CLI 组装 runtime workflow guidance 时，所选 profile 不得要求实现阶段 mutation progress；read/search/glob/diff evidence 必须足以推进 workflow。

### Requirement: Workflow Governance Mode Boundary

Workflow orchestration SHALL represent governance mode separately from workflow priority.

Workflow orchestration 必须将 governance mode 与 workflow priority 分开表达。

#### Scenario: Primary does not imply evaluation supervision / Primary 不等于 evaluation supervision

- **WHEN** a profile declares `workflowPriority=primary`
- **THEN** runtime does not infer benchmark supervision, technical-director acceptance, anti-tailoring, or model-attribution gates from priority alone
- **AND** those policies are applied only when the profile explicitly declares an evaluation or supervisor governance mode
- **中文** 当 profile 声明 `workflowPriority=primary` 时，runtime 不得仅根据 priority 推断 benchmark supervision、技术总监验收、anti-tailoring 或 model-attribution gates；这些策略只能在 profile 显式声明 evaluation 或 supervisor governance mode 时应用。

#### Scenario: Read-only analysis does not enter mutation workflow / 只读分析不进入变更 workflow

- **WHEN** a CLI prompt explicitly constrains the task to read-only analysis, inspection, or diagnosis
- **THEN** profile selection MUST route the task to a standard read-only analysis workflow
- **AND** that workflow MUST expose only read, search, glob, list, diff, or other non-mutating evidence capabilities
- **AND** it MUST NOT include mutation, patch, write, test-before-change, or implementation stages
- **中文** 当 CLI prompt 显式约束为只读分析、检查或诊断时，profile selection 必须将任务路由到 standard read-only analysis workflow；该 workflow 只能暴露 read/search/glob/list/diff 或其他非变更证据能力，不得包含 mutation、patch、write、先测后改或实现阶段。

