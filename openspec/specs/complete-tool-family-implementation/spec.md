# complete-tool-family-implementation Specification

## Purpose
Define requirements for implementing tool-family capabilities as executable, governed, tested tools rather than catalog-only placeholders.

定义 tool-family capabilities 的实现要求，确保它们是可执行、受治理且有测试的工具，而不是仅目录占位。
## Requirements
### Requirement: All First-Version Families Have Concrete Capabilities / 全部第一版 Family 拥有真实 Capability
The system SHALL implement every first-version catalog family as at least one concrete executable capability with a stable capability id, manifest, executor, model-visible projection, tool family metadata, governed runtime path, bounded output, and tests.

系统必须把每个第一版 catalog family 实现为至少一个真实可执行 capability，并具备稳定 capability id、manifest、executor、model-visible projection、tool family metadata、受治理 runtime path、有界输出与测试。

#### Scenario: No planned family remains in the shipped baseline / 发布基线中不再保留 Planned Family
- **WHEN** diagnostics evaluates the first-version 64-family catalog after this change
- **THEN** every family reports `implementationState: implemented` and has at least one executable model-visible tool entry
- **中文** 当 diagnostics 在本变更后评估第一版 64-family catalog 时，每个 family 必须报告 `implementationState: implemented`，并且至少有一个可执行、model-visible 的 tool entry。

### Requirement: No Placeholder Or Catalog-Only Tools / 禁止占位或仅目录工具
The system SHALL NOT count catalog-only entries, fake labels without executors, docs-only commands, planned records, or disabled connectors as implemented tool entries.

系统不得把 catalog-only 条目、没有 executor 的 fake label、docs-only command、planned record 或 disabled connector 计为已实现 tool entry。

#### Scenario: Planned patch does not pass / Planned Patch 不通过
- **WHEN** `patch.apply` lacks a working executor or cannot apply a multi-hunk patch in a deterministic test
- **THEN** the family remains non-passing and contributes zero score
- **中文** 当 `patch.apply` 缺少可工作的 executor，或无法在确定性测试中应用 multi-hunk patch 时，该 family 必须保持不通过并贡献零分。

### Requirement: Fake-First Is Executable Evidence / Fake-First 是可执行证据
Families that depend on external providers SHALL provide deterministic fake-first adapters that execute through the same manifest, policy, preflight, runtime, evidence, and scorecard path as real adapters.

依赖外部 provider 的 families 必须提供 deterministic fake-first adapters，并且与真实 adapters 走同一套 manifest、policy、preflight、runtime、evidence 与 scorecard 路径。

#### Scenario: Image generation has local deterministic evidence / 图片生成拥有本地确定性证据
- **WHEN** default tests exercise `image.generate`
- **THEN** the fake image provider returns a bounded artifact reference and score evidence without requiring live credentials
- **中文** 当默认测试执行 `image.generate` 时，fake image provider 必须返回有界 artifact reference 与评分证据，且不要求 live credentials。

### Requirement: Family Score Separates Evidence Layers / Family 分层评分
Every implemented family SHALL report implementation, static contract, replayed or live execution, task outcome, and safety evidence as separate scorecard layers.

每个已实现 family 必须把 implementation、static contract、replayed 或 live execution、task outcome 与 safety evidence 作为独立 scorecard layers 报告。

#### Scenario: Executor without task evidence is not fully complete / 只有 Executor 不算完全完成
- **WHEN** a family has a registered executor but lacks representative task evidence
- **THEN** implementation and static layers may pass, but task outcome remains zero
- **中文** 当某个 family 已注册 executor 但缺少代表性任务证据时，implementation 与 static layers 可以通过，但 task outcome 必须保持零分。

### Requirement: Family Ownership Is Enforced / Family 归属必须受约束
Each family implementation SHALL live in or project from its owner package and SHALL NOT violate package boundaries or import app-specific hosts into platform contracts.

每个 family implementation 必须位于或投影自所属 owner package，不得违反 package boundaries，也不得把 app-specific host 导入 platform contracts。

#### Scenario: Design tools do not live in core coding tools / Design 工具不放进 Core Coding Tools
- **WHEN** `design.batch-edit` is implemented
- **THEN** it is exposed through a design connector or MCP profile and projected with catalog metadata instead of being owned by `core-coding-tools`
- **中文** 当 `design.batch-edit` 被实现时，它必须通过 design connector 或 MCP profile 暴露并携带 catalog metadata，而不是由 `core-coding-tools` 拥有。

### Requirement: Reference-Class Tool Arsenal Completeness / 参考级工具弹药库完整度

The CLI platform SHALL maintain a reference-to-DeepSeek tool matrix that maps every reference-class tool capability to a DeepSeek capability family, implementation owner, projection policy, fallback behavior, and verification command. A tool family SHALL NOT be considered complete from catalog metadata alone.

CLI 平台必须维护 reference-to-DeepSeek 工具矩阵，将每个参考级工具能力映射到 DeepSeek capability family、implementation owner、projection policy、fallback behavior 与 verification command。不得仅凭 catalog metadata 判定某个工具族完成。

#### Scenario: Tool family has executable or typed unavailable state / 工具族具备可执行或类型化不可用状态

- **WHEN** release readiness evaluates a tool family required by an active profile
- **THEN** the family SHALL be classified as `executable`, `adapter-unavailable-with-diagnostics`, or `not-yet-implemented`
- **AND** `executable` SHALL require registered capability metadata, executable lookup, preflight/policy handling, bounded result feedback, replay evidence, and deterministic coverage
- **AND** `adapter-unavailable-with-diagnostics` SHALL return typed provider/platform/connector diagnostics without being counted as implemented
- **中文** 当 release readiness 评估 active profile 必需的工具族时，该工具族必须分类为 `executable`、`adapter-unavailable-with-diagnostics` 或 `not-yet-implemented`；`executable` 必须具备 capability metadata 注册、可执行 lookup、preflight/policy 处理、有界结果反馈、replay evidence 与确定性覆盖；`adapter-unavailable-with-diagnostics` 必须返回类型化 provider/platform/connector diagnostics，且不得计为已实现。

#### Scenario: Active profile fails on missing arsenal / Active Profile 因弹药库缺失失败

- **WHEN** an active engineering profile declares required tool families
- **AND** any required family is missing, hidden without a projection reason, policy-denied without corrective feedback, or non-executable
- **THEN** the profile readiness gate SHALL fail before live task attribution can blame model quality
- **中文** 当 active engineering profile 声明必需工具族，且任一必需工具族缺失、无投影原因被隐藏、policy-denied 但无可修正反馈，或不可执行时，profile readiness gate 必须先失败，不得将 live task 失败归因为模型质量。

### Requirement: Tool Arsenal Covers Reference Capability Areas / 工具弹药库覆盖参考能力区域

The complete arsenal SHALL cover workspace I/O, search/code intelligence, mutation/patching, shell/process, git/build/package/test, planning/control, agents/tasks, web/public data, MCP/browser connectors, skills/plugins/hooks/commands, memory/context/session/worktree, scheduling/remote/observability, and media/design capability areas.

完整弹药库必须覆盖 workspace I/O、search/code intelligence、mutation/patching、shell/process、git/build/package/test、planning/control、agents/tasks、web/public data、MCP/browser connectors、skills/plugins/hooks/commands、memory/context/session/worktree、scheduling/remote/observability 与 media/design 能力区域。

#### Scenario: Coverage report is actionable / 覆盖报告可行动

- **WHEN** the tool arsenal coverage report runs
- **THEN** it SHALL emit each reference capability, mapped DeepSeek family, capability ids, implementation state, projection state, missing evidence, and next implementation action
- **AND** the report SHALL distinguish "not registered", "registered but not executable", "executable but not projected", "projected but rejected by policy", and "provider unavailable"
- **中文** 当工具弹药库覆盖报告运行时，必须输出每个参考能力、映射的 DeepSeek 工具族、capability ids、implementation state、projection state、缺失证据与下一步实现动作；报告必须区分“未注册”、“已注册但不可执行”、“可执行但未投影”、“已投影但被 policy 拒绝”与“provider 不可用”。

