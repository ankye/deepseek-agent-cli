## ADDED Requirements

### Requirement: Task Decision Prompt Sections / 任务决策 Prompt Section

Prompt assembly SHALL be the only path that turns task delivery decision requests into model-visible messages.

prompt assembly 必须是将 task delivery decision requests 转换为模型可见 messages 的唯一路径。

#### Scenario: Decision request becomes stable sections / 决策请求成为稳定 Section

- **WHEN** a `TaskDecisionRequest` is included in prompt assembly input
- **THEN** the assembler contributes typed task decision sections for task brief, evidence refs, constraints, allowed tools, budget, risk, candidate profiles, acceptance draft, output schema, and required response shape
- **AND** stable kernel/project/session decision sections appear before volatile current-turn guidance and raw user input
- **中文** 当 prompt assembly input 包含 `TaskDecisionRequest` 时，assembler 必须贡献类型化 task decision sections，覆盖 task brief、evidence refs、constraints、allowed tools、budget、risk、candidate profiles、acceptance draft、output schema 与 required response shape；稳定的 kernel/project/session decision sections 必须位于易变 current-turn guidance 与 raw user input 前。

#### Scenario: Decision assembly preserves cache evidence / 决策组装保留缓存证据

- **WHEN** a decision prompt is assembled from a context pipeline manifest and decision request refs
- **THEN** the result includes pipeline fingerprint, layer prefix hashes, decision section fingerprints, included/excluded block ids, cache hint summary, budget exclusions, and replay fingerprints without persisting raw unbounded evidence
- **中文** 当 decision prompt 从 context pipeline manifest 与 decision request refs 组装时，结果必须包含 pipeline fingerprint、layer prefix hashes、decision section fingerprints、included/excluded block ids、cache hint summary、budget exclusions 与 replay fingerprints，且不得持久化 raw unbounded evidence。

#### Scenario: Runtime does not hand-roll decision prompts / Runtime 不手写决策 Prompt

- **WHEN** code introduces a model-assisted task decision path
- **THEN** it must use prompt assembly contracts and section providers rather than concatenating private prompt strings in runtime, CLI, staged-task, diagnostics, model-gateway, or provider adapters
- **中文** 当代码引入模型辅助 task decision path 时，必须使用 prompt assembly contracts 与 section providers，而不是在 runtime、CLI、staged-task、diagnostics、model-gateway 或 provider adapters 中拼接私有 prompt strings。
