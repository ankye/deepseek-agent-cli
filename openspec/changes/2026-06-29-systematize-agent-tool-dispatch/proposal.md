# Systematize Agent Tool Dispatch

## Why

The current agent loop mixes model streaming, tool preflight, workflow gates, hook blocking, capability execution, result feedback, budget review, and terminal convergence in one large control path. This makes scheduling behavior hard to reason about: simple tasks can spend many model turns repeating inspection or rejected tool calls even when the correct state-machine transition should be obvious.

当前 agent loop 把 model streaming、tool preflight、workflow gates、hook blocking、capability execution、result feedback、budget review 与 terminal convergence 混在同一条大型控制路径里。这让调度行为很难推理：简单任务也可能消耗很多模型轮次重复检查或重复被拒绝的工具调用，而正确的状态机转移本应很明显。

The reference architecture separates query turn orchestration from tool execution orchestration: the loop collects tool requests and feeds results back, while a dedicated tool orchestrator partitions safe read-only work from mutation/process work, tracks in-progress/completed tool ids, and returns bounded result updates. DeepSeek CLI needs the same separation, adapted to our profile/task/workflow contracts instead of copying reference implementation details.

参考架构把 query turn orchestration 与 tool execution orchestration 分开：loop 收集工具请求并回灌结果，专门的 tool orchestrator 负责区分安全只读工作与 mutation/process 工作、跟踪 in-progress/completed tool ids，并返回有界 result updates。DeepSeek CLI 需要同样的分层，但必须适配我们自己的 profile/task/workflow contracts，而不是复制参考实现细节。

## What Changes

- Introduce a runtime-owned tool dispatch layer between `agent-loop` and kernel capability execution.
- 引入 runtime 拥有的 tool dispatch layer，位于 `agent-loop` 与 kernel capability execution 之间。
- Define dispatch batches, serial/concurrent execution policy, lifecycle ids, result feedback, and orphan-result prevention as generic runtime contracts.
- 将 dispatch batches、serial/concurrent execution policy、lifecycle ids、result feedback 与 orphan-result prevention 定义为通用 runtime contracts。
- Define dispatch robustness and fault tolerance: abort cleanup, timeout classification, partial-result handling, retry eligibility, stale-result quarantine, and durable failure summaries.
- 定义 dispatch 健壮性与容错性：abort cleanup、timeout classification、partial-result handling、retry eligibility、stale-result quarantine 与 durable failure summaries。
- Introduce an explicit convergence layer for budget review, repeated non-progress, required-action correction, stop/continue decisions, and terminal close reasons.
- 引入显式 convergence layer，处理 budget review、重复无进展、required-action correction、stop/continue decisions 与 terminal close reasons。
- Standardize the failure-analysis loop as runtime control flow: classify the failure, attribute it to an actionable owner, search evidence, prove or disprove the attribution, and only then choose repair, rerun, continue, or stop.
- 将 failure-analysis loop 标准化为 runtime control flow：分类失败、归因到可行动 owner、搜索证据、证明或反证归因，然后才能选择 repair、rerun、continue 或 stop。
- Add shared parent/child scheduling evidence: parent and child agents keep independent model contexts, but write stage progress, dispatch summaries, failure-analysis records, and accepted evidence refs into one durable board/ledger.
- 增加 parent/child 共享调度证据：parent 与 child agent 保持独立 model context，但将 stage progress、dispatch summaries、failure-analysis records 与 accepted evidence refs 写入同一个 durable board/ledger。
- Clarify that task and profile remain declarative inputs: task describes the work instance and acceptance target; profile describes role/workflow/tool policy; dispatch/convergence executes and stabilizes the loop.
- 明确 task 与 profile 仍是声明式输入：task 描述工作实例与验收目标；profile 描述角色/workflow/tool policy；dispatch/convergence 负责执行并稳定循环。
- Refactor `agent-loop.ts` toward a thin orchestrator that streams model events, delegates tool batches, applies convergence decisions, and emits terminal events.
- 将 `agent-loop.ts` 重构为薄编排器：串流 model events、委托 tool batches、应用 convergence decisions，并发出 terminal events。

## Non-Goals

- Do not hardcode benchmark tasks, benchmark profiles, expected patches, repo names, scorer behavior, or task numbers.
- 不硬编码 benchmark tasks、benchmark profiles、expected patches、repo names、scorer behavior 或 task numbers。
- Do not replace profile or task contracts with ad hoc runtime conditionals.
- 不用临时 runtime conditionals 替代 profile 或 task contracts。
- Do not add a Java-style class hierarchy or framework-heavy state machine.
- 不引入 Java 风格 class hierarchy 或臃肿框架式状态机。
- Do not bypass existing kernel policy, scheduler, resource locks, preflight, hooks, or evidence records.
- 不绕过现有 kernel policy、scheduler、resource locks、preflight、hooks 或 evidence records。
