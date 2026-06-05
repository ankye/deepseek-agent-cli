## MODIFIED Requirements

### Requirement: Layered Delivery Workflow Uses The Existing Agent Loop / 分层交付工作流复用现有 Agent Loop

The agent loop SHALL coordinate task intake, goal creation, project rules, tool governance, output contracts, verification expectations, acceptance review, and context or memory evidence through the existing evidence, planning, execution, verification, repair, synthesis, and terminal phases.

agent loop 必须通过现有 evidence、planning、execution、verification、repair、synthesis 与 terminal phases 协调 task intake、goal creation、project rules、tool governance、output contracts、verification expectations、acceptance review 与 context 或 memory evidence。

#### Scenario: Turn records delivery layer plan / Turn 记录交付分层计划

- **WHEN** a task begins and any delivery layer is required by task intake, goal policy, repository policy, output contract, tool projection, verification policy, acceptance policy, or memory policy
- **THEN** the phase plan records which layers are required, skipped, degraded, or not applicable
- **AND** the terminal event summarizes each required layer outcome before reporting completion, repair, blocked, or failure
- **中文** 当任务开始且任一交付层因 task intake、goal policy、repository policy、output contract、tool projection、verification policy、acceptance policy 或 memory policy 被要求时，phase plan 必须记录哪些层 required、skipped、degraded 或 not applicable；terminal event 必须在报告 completion、repair、blocked 或 failure 前汇总每个 required layer outcome。

#### Scenario: Layer gap routes to owning subsystem / 层级缺口归属到负责子系统

- **WHEN** verification or acceptance detects a missing task brief, ambiguous goal, wrong profile, missing project rule, unavailable tool, unsatisfied output contract, absent required memory, missing regression evidence, or failed acceptance criterion
- **THEN** the agent loop records the owning layer and failure code instead of hiding the gap inside assistant text
- **中文** 当 verification 或 acceptance 检测到 missing task brief、ambiguous goal、wrong profile、missing project rule、unavailable tool、unsatisfied output contract、absent required memory、missing regression evidence 或 failed acceptance criterion 时，agent loop 必须记录 owning layer 与 failure code，而不是把缺口隐藏在 assistant text 中。

#### Scenario: Model request and token accounting is centralized / 模型请求与 Token 记账集中化

- **WHEN** the agent loop dispatches a model request and later receives provider-normalized usage events
- **THEN** it records the request count, provider/model identity, prompt assembly fingerprint, phase attribution, and returned input/output/cache/reasoning token usage through the runtime-owned audit and usage-budget path
- **AND** provider adapters do not write private usage ledgers, diagnostics do not parse raw provider logs, and missing provider usage remains explicitly absent rather than estimated as real usage
- **中文** 当 agent loop 发起 model request 并随后收到 provider-normalized usage events 时，必须通过 runtime-owned audit 与 usage-budget 路径记录 request count、provider/model identity、prompt assembly fingerprint、phase attribution，以及返回的 input/output/cache/reasoning token usage；provider adapters 不得写入私有 usage ledger，diagnostics 不得解析 raw provider logs，缺失的 provider usage 必须显式保持 absent，而不能被估算成真实用量。
