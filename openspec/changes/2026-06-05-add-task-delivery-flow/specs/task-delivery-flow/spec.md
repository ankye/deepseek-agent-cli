## ADDED Requirements

### Requirement: Canonical Task Delivery Flow / 规范任务交付流程

The platform SHALL define a host-neutral task delivery flow that transforms short user input into a typed task brief, goal, plan, execution state, proof evidence, acceptance review, and final delivery decision.

平台必须定义 host-neutral task delivery flow，将短用户输入转换为类型化 task brief、goal、plan、execution state、proof evidence、acceptance review 与 final delivery decision。

#### Scenario: Short input becomes a task brief before goal creation / 短输入先变成 Task Brief 再定目标

- **WHEN** a user submits a short, stateful, or ambiguous instruction such as "continue", "optimize", "run score", or "execute"
- **THEN** the flow creates a `TaskBrief` that records raw input, normalized intent, confidence, context requirements, assumptions, missing information, and whether user confirmation is required
- **AND** goal creation consumes the `TaskBrief` rather than reading raw prompt text directly
- **中文** 当用户提交“继续”、“优化”、“跑分”或“执行”等短、带状态或有歧义的指令时，流程必须创建 `TaskBrief`，记录 raw input、normalized intent、confidence、context requirements、assumptions、missing information 与是否需要用户确认；目标创建必须消费 `TaskBrief`，而不是直接读取 raw prompt text。

#### Scenario: Goal binds acceptance criteria / 目标绑定验收标准

- **WHEN** a `TaskGoal` is created from a sufficiently confident task brief
- **THEN** it records a goal id, goal statement, task kind, risk level, acceptance criteria, non-goals, budget policy, and redaction metadata
- **AND** downstream planning, staged execution, proof, and delivery decisions reference the goal id
- **中文** 当 `TaskGoal` 从置信度足够的 task brief 创建时，必须记录 goal id、goal statement、task kind、risk level、acceptance criteria、non-goals、budget policy 与 redaction metadata；下游 planning、staged execution、proof 与 delivery decisions 必须引用该 goal id。

#### Scenario: Plan can select or defer profile decisions / 计划可以选择或延后 Profile 决策

- **WHEN** the flow creates a delivery plan
- **THEN** it records whether it selected a catalog profile, requires a dynamic profile proposal, continues an existing task run, or must ask the user before planning
- **AND** it records the selected or candidate profile id without executing model calls, processes, tools, or workspace mutations during intake and planning
- **中文** 当流程创建 delivery plan 时，必须记录它是选择 catalog profile、需要 dynamic profile proposal、继续 existing task run，还是必须在规划前询问用户；它必须记录 selected 或 candidate profile id，并且 intake 与 planning 阶段不得执行 model calls、processes、tools 或 workspace mutations。

### Requirement: Acceptance Gate Before Delivery / 交付前验收门禁

The platform SHALL run a typed acceptance review before final delivery for structured, mutating, externally scored, or evidence-bound tasks.

对于结构化、有副作用、外部评分或 evidence-bound 任务，平台必须在最终交付前运行类型化 acceptance review。

#### Scenario: Delivery requires accepted criteria / 交付要求验收标准通过

- **WHEN** a task reaches proof or verification completion
- **THEN** the acceptance review compares available proof evidence against the goal's acceptance criteria
- **AND** final delivery is allowed only when every required criterion is accepted or explicitly marked not applicable by policy
- **中文** 当任务到达 proof 或 verification completion 时，acceptance review 必须将可用 proof evidence 与 goal acceptance criteria 对比；只有所有 required criteria 被接受，或被 policy 明确标记为 not applicable，才允许最终交付。

#### Scenario: Failed acceptance returns to owning phase / 验收失败回到负责阶段

- **WHEN** acceptance review finds missing information, goal mismatch, wrong plan/profile, missing artifact, insufficient evidence, failed verification, or exhausted budget
- **THEN** it returns a typed decision: `intake_required`, `goal_refinement_required`, `replan_required`, `repair_required`, `verify_required`, or `blocked`
- **AND** the decision records failure code, failed criteria ids, evidence refs, recommended return phase, and repair budget remaining
- **中文** 当 acceptance review 发现信息缺失、目标不匹配、plan/profile 错误、artifact 缺失、证据不足、验证失败或预算耗尽时，必须返回类型化决策：`intake_required`、`goal_refinement_required`、`replan_required`、`repair_required`、`verify_required` 或 `blocked`；该决策必须记录 failure code、failed criteria ids、evidence refs、recommended return phase 与剩余 repair budget。

### Requirement: Batched AI Decision Packets / 批量 AI 决策包

The platform SHALL minimize repeated model requests by preparing a bounded `TaskDecisionRequest` from deterministic intake and evidence summaries, and by allowing a single AI decision response to propose goal, acceptance, plan, profile, tool strategy, verification, repair, and stop conditions as structured data.

平台必须通过 deterministic intake 与 evidence summaries 准备有界 `TaskDecisionRequest`，并允许一次 AI decision response 以结构化数据提出 goal、acceptance、plan、profile、tool strategy、verification、repair 与 stop conditions，从而减少重复 model requests。

#### Scenario: One decision request can return multiple governed steps / 一次决策请求可返回多步治理计划

- **WHEN** a task requires model-assisted planning and deterministic intake has enough evidence to avoid asking the user first
- **THEN** the runtime sends one bounded `TaskDecisionRequest` containing task brief, evidence refs, constraints, allowed tools, budget, risk, candidate profiles, acceptance draft, and output schema
- **AND** the model response is normalized into a `TaskDecisionEnvelope` containing intent decision, goal proposal, acceptance criteria, plan steps, profile selection or dynamic profile proposal, tool strategy, verification plan, repair policy, stop conditions, questions for user, confidence, and assumptions
- **AND** the runtime validates the envelope before execution and does not treat model text as completion evidence
- **中文** 当任务需要模型辅助规划，且 deterministic intake 已有足够证据无需先询问用户时，runtime 必须发送一个有界 `TaskDecisionRequest`，包含 task brief、evidence refs、constraints、allowed tools、budget、risk、candidate profiles、acceptance draft 与 output schema；模型响应必须归一化为 `TaskDecisionEnvelope`，包含 intent decision、goal proposal、acceptance criteria、plan steps、profile selection 或 dynamic profile proposal、tool strategy、verification plan、repair policy、stop conditions、questions for user、confidence 与 assumptions；runtime 必须在执行前校验该 envelope，且不得把模型文本当作完成证据。

#### Scenario: Decision packet protects token budget / 决策包保护 Token 预算

- **WHEN** evidence for a task exceeds the decision budget
- **THEN** the decision request sends bounded summaries, refs, fingerprints, and source coverage metadata instead of unbounded raw files, raw command output, raw model transcripts, or repeated repository instructions
- **AND** omitted evidence is recorded with exclusion reason, expected impact, and whether the omission blocks planning
- **中文** 当任务证据超过 decision budget 时，decision request 必须发送有界 summaries、refs、fingerprints 与 source coverage metadata，而不是无限 raw files、raw command output、raw model transcripts 或重复 repository instructions；被省略的证据必须记录 exclusion reason、expected impact 与是否阻断 planning。

#### Scenario: Decision prompts are assembled centrally / 决策 Prompt 集中组装

- **WHEN** the runtime needs to ask a model for a task decision envelope
- **THEN** it passes the decision request through `@deepseek/prompt-assembly` as typed task decision sections and consumes the returned provider-neutral assembly result
- **AND** task-delivery-flow, CLI diagnostics, staged-task execution, and model providers do not construct private decision prompts or provider-specific messages directly
- **中文** 当 runtime 需要向模型请求 task decision envelope 时，必须将 decision request 作为类型化 task decision sections 交给 `@deepseek/prompt-assembly`，并消费返回的 provider-neutral assembly result；task-delivery-flow、CLI diagnostics、staged-task execution 与 model providers 不得直接构造私有 decision prompts 或 provider-specific messages。

#### Scenario: Decision request and usage enter unified audit / 决策请求与用量进入统一审计

- **WHEN** a task delivery flow dispatches any model-bound decision, planning, execution, repair, verification, or synthesis request
- **THEN** the runtime records a replay-safe audit entry for request count, task ids, phase, provider, model, prompt assembly fingerprint, and provider request id when available
- **AND** provider-returned token usage is recorded through the same audit lineage and the usage-budget service without inventing missing token counts
- **AND** diagnostics, evaluation scoring, budget checks, and cache analysis read request and token evidence from that unified audit/usage path rather than provider-specific logs
- **中文** 当 task delivery flow 发起任何 model-bound decision、planning、execution、repair、verification 或 synthesis request 时，runtime 必须记录 replay-safe audit entry，包含 request count、task ids、phase、provider、model、prompt assembly fingerprint 与可用的 provider request id；provider 返回的 token usage 必须通过同一条 audit lineage 与 usage-budget service 记录，且不得伪造缺失 token counts；diagnostics、evaluation scoring、budget checks 与 cache analysis 必须从统一 audit/usage 路径读取 request 和 token evidence，而不是读取 provider-specific logs。

### Requirement: User Guidance Replans Precisely / 用户引导触发精确重规划

The platform SHALL treat mid-task user guidance as typed input that can invalidate part of a prior decision envelope and resume from the correct phase instead of blindly continuing or restarting the whole task.

平台必须将任务中途的用户引导视为类型化输入，可使 prior decision envelope 的部分内容失效，并从正确 phase 恢复，而不是盲目继续或整任务重启。

#### Scenario: Guidance event classifies impact / 用户引导事件分类影响范围

- **WHEN** the user sends mid-task guidance such as a correction, new constraint, provider change, priority change, scope change, approval, stop, or "continue"
- **THEN** the flow records a `TaskGuidanceEvent` with guidance kind, raw input, target decision id when known, confidence, and redaction metadata
- **AND** it computes a `DecisionInvalidation` with preserved decision fields, invalidated fields, preserved evidence refs, replan scope, reason, and recommended return phase
- **中文** 当用户在任务中途发送 correction、新 constraint、provider change、priority change、scope change、approval、stop 或“继续”等引导时，流程必须记录 `TaskGuidanceEvent`，包含 guidance kind、raw input、已知的 target decision id、confidence 与 redaction metadata；并计算 `DecisionInvalidation`，包含 preserved decision fields、invalidated fields、preserved evidence refs、replan scope、reason 与 recommended return phase。

#### Scenario: Replanning is local when possible / 尽可能局部重规划

- **WHEN** guidance changes only execution parameters, provider, profile, acceptance criteria, or the goal
- **THEN** the flow returns to the narrowest safe phase: plan patch, replan, acceptance refinement, goal refinement, or intake
- **AND** unchanged evidence refs and successful immutable stage refs remain preserved unless policy marks them stale
- **中文** 当用户引导只改变执行参数、provider、profile、acceptance criteria 或目标时，流程必须回到最窄安全 phase：plan patch、replan、acceptance refinement、goal refinement 或 intake；未改变的 evidence refs 与已成功 immutable stage refs 必须保留，除非 policy 将其标记为 stale。

### Requirement: Flow Decisions Are Replayable / 流程决策可回放

Task delivery flow decisions SHALL be recorded as deterministic data with schema version, stable ids, compatibility metadata, redaction metadata, and phase attribution.

任务交付流程决策必须以确定性数据记录，包含 schema version、stable ids、compatibility metadata、redaction metadata 与 phase attribution。

#### Scenario: Diagnostics can inspect the minimal flow / Diagnostics 可检查最小流程

- **WHEN** `deepseek diagnostics flow inspect` runs with a raw prompt
- **THEN** the CLI emits the task brief, goal decision, delivery plan, phase statuses, acceptance review, final delivery decision, and redaction metadata in text, JSON, and JSONL modes
- **AND** the diagnostics command does not call live models, execute arbitrary tools, mutate the workspace, or hide unsupported user input inside free-form assistant text
- **中文** 当 `deepseek diagnostics flow inspect` 带 raw prompt 运行时，CLI 必须以 text、JSON 与 JSONL 输出 task brief、goal decision、delivery plan、phase statuses、acceptance review、final delivery decision 与 redaction metadata；该 diagnostics 命令不得调用 live model、执行任意 tool、修改 workspace，或把不支持的用户输入隐藏在自由格式 assistant 文本里。
