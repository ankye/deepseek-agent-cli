# Tasks / 任务

## Specification / 规格

- [x] Record the approved layered transactional-runner design.
- [x] Add workflow-orchestration and CLI evaluation delta requirements.
- [x] Validate this change with `npx openspec validate 2026-07-13-stabilize-swebench-repair-outcomes --strict`.
- [x] Validate canonical specs with `npx openspec validate --specs --strict`.

- [x] 记录已批准的分层事务式 runner 设计。
- [x] 增加 workflow-orchestration 和 CLI evaluation 增量要求。
- [x] 使用 `npx openspec validate 2026-07-13-stabilize-swebench-repair-outcomes --strict` 验证本 change。
- [x] 使用 `npx openspec validate --specs --strict` 验证 canonical specs。

## Runtime Recovery / Runtime 恢复

- [x] Add a failing regression for one same-target refresh after typed edit precondition failure.
- [x] Add a failing regression for exhausted or wrong-target refresh recovery.
- [x] Implement bounded exact-refresh recovery without relaxing ordinary workflow stages.
- [x] Preserve typed flow-control attribution without user-approval classification.

- [x] 增加 typed edit precondition failure 后一次同目标刷新的失败回归测试。
- [x] 增加刷新恢复耗尽或目标错误的失败回归测试。
- [x] 实现有界 exact-refresh recovery，不放宽普通 workflow stages。
- [x] 保留 typed flow-control 归因，不归类为用户授权。

## Transactional Attempts / 事务式 Attempts

- [x] Add a failing regression with a better first candidate, regressed second candidate, and non-harness-ready final attempt.
- [x] Persist immutable patch, prediction, trace, and evaluation metadata per attempt.
- [x] Implement deterministic candidate ranking and best-candidate restoration.
- [x] Rebuild repair context from the restored best candidate and record discarded regressions.
- [x] Preserve best official evaluation and last terminal evidence in the final summary.

- [x] 增加包含更好首个候选、退化第二候选与 non-harness-ready 最后 attempt 的失败回归测试。
- [x] 持久化逐 attempt 不可变 patch、prediction、trace 和 evaluation metadata。
- [x] 实现确定性候选排序与最佳候选恢复。
- [x] 从已恢复最佳候选重建 repair context，并记录已丢弃退化。
- [x] 在最终 summary 中保留最佳官方 evaluation 和最后终态证据。

## Behavior Reproduction / 行为复现

- [x] Add a failing regression proving first-attempt public-test-only success cannot close SWE verification.
- [x] Add a passing regression for safe problem-statement reproduction followed by public verification.
- [x] Add a SWE-owned behavior-contract reference to initial child stage state.
- [x] Activate the reproduction gate only when that host reference is present.

- [x] 增加失败回归测试，证明首次 public-test-only success 不能关闭 SWE verification。
- [x] 增加安全 problem-statement reproduction 后执行 public verification 的通过回归测试。
- [x] 向初始 child stage state 增加 SWE-owned behavior-contract reference。
- [x] 仅当存在该 host reference 时激活 reproduction gate。

## Status And Attribution / 状态与归因

- [x] Add a failing CLI regression proving nested benchmark failure propagates to outer status.
- [x] Add a failing attribution regression proving correctness and flow outrank cache readiness.
- [x] Implement authoritative nested outcome extraction in the diagnostics adapter.
- [x] Preserve cache findings as review evidence without allowing them to mask semantic failure.

- [x] 增加 CLI 失败回归测试，证明嵌套 benchmark failure 传播到外层 status。
- [x] 增加归因失败回归测试，证明 correctness 和 flow 优先于 cache readiness。
- [x] 在 diagnostics adapter 中实现权威嵌套 outcome 提取。
- [x] 保留 cache findings 作为 review evidence，不允许其遮蔽语义失败。

## Verification / 验证

- [x] Run focused runtime tool-feedback tests.
- [x] Run focused SWE-bench runner and CLI diagnostics tests.
- [x] Run `npm run typecheck`.
- [x] Run `npm run lint`.
- [x] Run `npm test`.
- [x] Run `node scripts/check-boundaries.mjs`.
- [x] Run one GLM 5.2 SWE-bench Lite task-2 canary and record observed attempts and authoritative outcome.

- [x] 运行 focused runtime tool-feedback tests。
- [x] 运行 focused SWE-bench runner 和 CLI diagnostics tests。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run lint`。
- [x] 运行 `npm test`。
- [x] 运行 `node scripts/check-boundaries.mjs`。
- [x] 运行一次 GLM 5.2 SWE-bench Lite 第二题 canary，记录实际 attempts 与权威 outcome。

### Acceptance Evidence / 验收证据

- 2026-07-14 focused runtime mutation routing: 44 passed, 0 failed; runtime tool feedback: 122 passed, 0 failed.
- 2026-07-14 focused SWE runner: 117 passed, 0 failed; candidate ranking: 5 passed, 0 failed; CLI SWE diagnostics: 4 passed, 0 failed.
- 2026-07-14 repository verification: `npm run typecheck`, `npm run lint`, `npm test`, `node scripts/check-boundaries.mjs`, and `git diff --check` passed. Full tests: 1713 total, 1706 passed, 7 skipped, 0 failed.
- GLM 5.2 canary 1 used all 3 attempts and remained unresolved. Attempt 1 was retained after later regression; the run exposed and led to a fix for final restoration after a harness-ready tie.
- GLM 5.2 canary 2 used all 3 attempts and remained unresolved: `status=fail`, `evaluationResolved=false`, `bestAttempt=1`, `lastAttempt=3`. Canonical prediction and checkout both matched the restored best candidate.

- 2026-07-14 focused runtime mutation routing：44 通过、0 失败；runtime tool feedback：122 通过、0 失败。
- 2026-07-14 focused SWE runner：117 通过、0 失败；candidate ranking：5 通过、0 失败；CLI SWE diagnostics：4 通过、0 失败。
- 2026-07-14 仓库验证：`npm run typecheck`、`npm run lint`、`npm test`、`node scripts/check-boundaries.mjs` 与 `git diff --check` 均通过。全量测试共 1713 项，1706 通过、7 跳过、0 失败。
- GLM 5.2 canary 1 用满 3 次 attempt 后仍未解决。Attempt 1 在后续退化后被保留；该运行暴露并推动修复了 harness-ready tie 后最终恢复缺失的问题。
- GLM 5.2 canary 2 用满 3 次 attempt 后仍未解决：`status=fail`、`evaluationResolved=false`、`bestAttempt=1`、`lastAttempt=3`。Canonical prediction 与 checkout 均匹配已恢复的最佳候选。
