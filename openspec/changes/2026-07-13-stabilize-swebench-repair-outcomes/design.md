# SWE-bench Repair Outcome Stabilization Design

## Architecture Boundary / 架构边界

Generic runtime owns only typed tool recovery and bounded workflow progression. The CLI SWE host owns attempt candidates, checkout restoration, official harness comparison, and repair context. The CLI diagnostics adapter owns user-facing status propagation. No layer may infer or inspect benchmark gold patches.

通用 runtime 只负责 typed tool recovery 和有界 workflow progression。CLI SWE host 负责 attempt candidates、checkout restoration、官方 harness 比较与 repair context。CLI diagnostics adapter 负责面向用户的 status 传播。任何层都不得推断或读取 benchmark gold patch。

## Runtime Mutation Recovery / Runtime Mutation 恢复

When `core.file.edit` or an equivalent exact-match mutation fails with typed precondition evidence, the runtime records the failed target path and grants one bounded refresh of that same file. The refresh is available even after ordinary source-inspection limits, because it repairs stale mutation input rather than reopening understanding. The next workflow action returns to mutation. Repeated refresh attempts close with `FLOW_MUTATION_RECOVERY_EXHAUSTED` and remain a flow-control failure.

当 `core.file.edit` 或等价 exact-match mutation 以类型化 precondition evidence 失败时，runtime 记录失败目标路径，并允许对同一文件进行一次 bounded refresh。即使普通 source-inspection limit 已用尽，该刷新仍可用，因为它修复的是 stale mutation input，而不是重新打开 understanding。下一个 workflow action 恢复为 mutation。重复刷新以 `FLOW_MUTATION_RECOVERY_EXHAUSTED` 关闭，并保持 flow-control failure 归类。

## Transactional Candidate State / 事务式候选状态

Each supervised attempt produces immutable patch, prediction, trace, and evaluation artifacts. The runner maintains `bestAttempt` separately from `lastAttempt`. Candidate comparison is lexicographic: resolved, valid official report, pass-to-pass failures, fail-to-pass failures, harness readiness with successful local verification, then attempt order.

每个 supervised attempt 生成不可变的 patch、prediction、trace 和 evaluation artifacts。Runner 分离维护 `bestAttempt` 与 `lastAttempt`。候选比较按 resolved、有效官方 report、pass-to-pass failures、fail-to-pass failures、带成功本地验证的 harness readiness，以及 attempt order 进行字典序排序。

A regressed candidate is retained as evidence but does not become the next repair base. The runner restores tracked files to the benchmark base commit, reapplies the best patch, preserves `.venv` and runner metadata, and rebuilds repair feedback from the restored candidate. A non-harness-ready final attempt cannot erase a previous official evaluation.

退化候选保留为证据，但不成为下一次 repair base。Runner 将 tracked files 恢复到 benchmark base commit，重新应用最佳 patch，保留 `.venv` 和 runner metadata，并从已恢复候选重建 repair feedback。最后一个 non-harness-ready attempt 不能擦除先前官方 evaluation。

## Behavior Contract / 行为契约

The initial SWE child state carries a diagnostic behavior-contract reference derived from the problem statement. A successful public test is insufficient to close verification until a safe non-mutating reproduction has completed. Failed public tests remain immediately actionable. The generic runtime activates this gate only when the host-provided SWE behavior reference exists.

初始 SWE child state 携带一个从 problem statement 派生的 diagnostic behavior-contract reference。在安全无写入复现完成前，成功 public test 不足以关闭验证。失败 public tests 仍可立即驱动修复。只有存在 host-provided SWE behavior reference 时，通用 runtime 才激活该 gate。

## Result Semantics / 结果语义

Transport completion, capability completion, and benchmark completion are separate states. The diagnostics adapter reports `pass` only when the authoritative nested benchmark summary is successful. The final summary returns the best candidate patch and evaluation while retaining last-attempt failure evidence.

Transport completion、capability completion 与 benchmark completion 是不同状态。只有权威嵌套 benchmark summary 成功时，diagnostics adapter 才报告 `pass`。最终 summary 返回最佳候选 patch 和 evaluation，同时保留 last-attempt failure evidence。

Correctness and flow reasons precede cache findings in primary attribution. Cache metrics stay visible and can block readiness claims, but they cannot explain semantic test failure. Model attribution is allowed only after complete runner evidence and a valid unresolved official result; flow-control or packaging failures remain framework-owned.

Correctness 和 flow reasons 在 primary attribution 中优先于 cache findings。Cache metrics 保持可见，且可以阻断 readiness claims，但不能解释语义测试失败。只有在 runner evidence 完整且有有效 unresolved 官方结果时，才允许模型归因；flow-control 或 packaging failure 仍由框架负责。

## Verification / 验证

All implementation changes start from focused failing regressions. Deterministic acceptance includes runtime recovery, candidate rollback, initial reproduction, nested status propagation, and correctness-first attribution. Repository verification includes focused tests, `npm run typecheck`, `npm run lint`, `npm test`, and `node scripts/check-boundaries.mjs`. One GLM 5.2 task-2 canary follows deterministic success and records observed model attempts without making stochastic resolution a release condition.

所有实现变更都从 focused failing regressions 开始。确定性验收覆盖 runtime recovery、candidate rollback、initial reproduction、nested status propagation 与 correctness-first attribution。仓库验证包括 focused tests、`npm run typecheck`、`npm run lint`、`npm test` 和 `node scripts/check-boundaries.mjs`。确定性验证成功后运行一次 GLM 5.2 第二题 canary，记录实际模型 attempts，但不把随机 resolution 作为发布条件。
