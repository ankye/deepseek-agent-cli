# Add Task Delivery Flow

## Why

User prompts are often short, stateful, and ambiguous: "continue", "optimize", "run score", or "execute" may depend on the current task, repository state, budgets, and prior evidence. The platform already has staged task execution, dynamic profile composition, repair loops, and diagnostics evidence, but it does not yet define a first-class flow from raw input to task brief, goal, plan, execution, proof, acceptance, and final delivery. Without this layer, profiles and executors can run successfully while still solving the wrong goal or reporting before acceptance evidence is sufficient.

用户输入经常很短、带状态且有歧义：例如“继续”、“优化”、“跑分”、“执行”都依赖当前任务、仓库状态、预算与既有证据。平台已经有 staged task execution、dynamic profile composition、repair loops 与 diagnostics evidence，但还没有定义从 raw input 到 task brief、goal、plan、execution、proof、acceptance 与 final delivery 的一等流程。缺少这一层时，profile 与 executor 即使运行成功，也可能解决了错误目标，或在验收证据不足时提前交付。

## What Changes

- Add a `task-delivery-flow` capability spec for the canonical 0-7 flow: Intake, Goal, Planning, Runtime, Executor, Proof, Acceptance, Delivery.
- Define host-neutral contracts for `TaskBrief`, `TaskGoal`, `TaskDeliveryPlan`, `TaskDeliveryRunState`, `TaskAcceptanceReview`, and typed return decisions.
- Require acceptance review before delivery for structured, mutating, scored, or evidence-bound tasks.
- Route failed acceptance back to the owning phase instead of restarting blindly or hiding the issue in assistant text.
- Route every model-bound decision prompt through `@deepseek/prompt-assembly` so decision packets reuse stable section ordering, prefix-cache fingerprints, budget exclusions, redaction, and replay evidence.
- Record model request counts and returned token usage through unified audit and usage-budget records, so diagnostics, scoring, cache analysis, and budget enforcement share one evidence source.
- Provide a diagnostics smoke command for deterministic flow inspection and proof that the minimal flow can run without model calls or side effects.
- Keep intelligent decision-making incremental: deterministic intake and acceptance first, profile selection/generation and model-assisted goal refinement later through typed contracts.

- 新增 `task-delivery-flow` 能力规格，定义规范 0-7 流程：Intake、Goal、Planning、Runtime、Executor、Proof、Acceptance、Delivery。
- 定义 host-neutral contracts：`TaskBrief`、`TaskGoal`、`TaskDeliveryPlan`、`TaskDeliveryRunState`、`TaskAcceptanceReview` 与类型化回流决策。
- 对结构化、有副作用、可评分或 evidence-bound 任务，要求交付前必须经过 acceptance review。
- 验收失败必须回流到负责 phase，不得盲目从头开始，也不得把问题隐藏在 assistant 文本里。
- 每个发往模型的决策 prompt 都必须通过 `@deepseek/prompt-assembly`，使 decision packets 复用稳定 section ordering、prefix-cache fingerprints、budget exclusions、redaction 与 replay evidence。
- 将 model request counts 与 provider 返回的 token usage 统一写入 audit 与 usage-budget records，使 diagnostics、跑分、cache analysis 与 budget enforcement 共用同一个证据源。
- 提供 diagnostics smoke 命令，用确定性方式检查流程，并证明最小流程无需模型调用或副作用即可跑通。
- 智能决策分步推进：先做确定性 intake 与 acceptance，再通过类型化契约逐步接入 profile 选择/生成与模型辅助目标细化。

## Impact

- Affected specs: `task-delivery-flow`, `prompt-assembly`, `agent-loop`, `staged-task-execution`, `cli-diagnostics-release-readiness`, `observability-privacy`, `usage-budget-management`.
- Affected code: `src/packages/platform-contracts`, `src/packages/prompt-assembly`, `src/packages/runtime`, `src/packages/usage-budget-management`, `src/apps/cli/src/commands/parse.ts`, `src/apps/cli/src/diagnostics/*`, focused contract/runtime/prompt/CLI tests.

- 影响规格：`task-delivery-flow`、`prompt-assembly`、`agent-loop`、`staged-task-execution`、`cli-diagnostics-release-readiness`、`observability-privacy`、`usage-budget-management`。
- 影响代码：`src/packages/platform-contracts`、`src/packages/prompt-assembly`、`src/packages/runtime`、`src/packages/usage-budget-management`、`src/apps/cli/src/commands/parse.ts`、`src/apps/cli/src/diagnostics/*`、聚焦 contract/runtime/prompt/CLI 测试。
