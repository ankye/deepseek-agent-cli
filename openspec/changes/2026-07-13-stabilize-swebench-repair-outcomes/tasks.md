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

- [ ] Add a failing regression for one same-target refresh after typed edit precondition failure.
- [ ] Add a failing regression for exhausted or wrong-target refresh recovery.
- [ ] Implement bounded exact-refresh recovery without relaxing ordinary workflow stages.
- [ ] Preserve typed flow-control attribution without user-approval classification.

- [ ] 增加 typed edit precondition failure 后一次同目标刷新的失败回归测试。
- [ ] 增加刷新恢复耗尽或目标错误的失败回归测试。
- [ ] 实现有界 exact-refresh recovery，不放宽普通 workflow stages。
- [ ] 保留 typed flow-control 归因，不归类为用户授权。

## Transactional Attempts / 事务式 Attempts

- [ ] Add a failing regression with a better first candidate, regressed second candidate, and non-harness-ready final attempt.
- [ ] Persist immutable patch, prediction, trace, and evaluation metadata per attempt.
- [ ] Implement deterministic candidate ranking and best-candidate restoration.
- [ ] Rebuild repair context from the restored best candidate and record discarded regressions.
- [ ] Preserve best official evaluation and last terminal evidence in the final summary.

- [ ] 增加包含更好首个候选、退化第二候选与 non-harness-ready 最后 attempt 的失败回归测试。
- [ ] 持久化逐 attempt 不可变 patch、prediction、trace 和 evaluation metadata。
- [ ] 实现确定性候选排序与最佳候选恢复。
- [ ] 从已恢复最佳候选重建 repair context，并记录已丢弃退化。
- [ ] 在最终 summary 中保留最佳官方 evaluation 和最后终态证据。

## Behavior Reproduction / 行为复现

- [ ] Add a failing regression proving first-attempt public-test-only success cannot close SWE verification.
- [ ] Add a passing regression for safe problem-statement reproduction followed by public verification.
- [ ] Add a SWE-owned behavior-contract reference to initial child stage state.
- [ ] Activate the reproduction gate only when that host reference is present.

- [ ] 增加失败回归测试，证明首次 public-test-only success 不能关闭 SWE verification。
- [ ] 增加安全 problem-statement reproduction 后执行 public verification 的通过回归测试。
- [ ] 向初始 child stage state 增加 SWE-owned behavior-contract reference。
- [ ] 仅当存在该 host reference 时激活 reproduction gate。

## Status And Attribution / 状态与归因

- [ ] Add a failing CLI regression proving nested benchmark failure propagates to outer status.
- [ ] Add a failing attribution regression proving correctness and flow outrank cache readiness.
- [ ] Implement authoritative nested outcome extraction in the diagnostics adapter.
- [ ] Preserve cache findings as review evidence without allowing them to mask semantic failure.

- [ ] 增加 CLI 失败回归测试，证明嵌套 benchmark failure 传播到外层 status。
- [ ] 增加归因失败回归测试，证明 correctness 和 flow 优先于 cache readiness。
- [ ] 在 diagnostics adapter 中实现权威嵌套 outcome 提取。
- [ ] 保留 cache findings 作为 review evidence，不允许其遮蔽语义失败。

## Verification / 验证

- [ ] Run focused runtime tool-feedback tests.
- [ ] Run focused SWE-bench runner and CLI diagnostics tests.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `npm test`.
- [ ] Run `node scripts/check-boundaries.mjs`.
- [ ] Run one GLM 5.2 SWE-bench Lite task-2 canary and record observed attempts and authoritative outcome.

- [ ] 运行 focused runtime tool-feedback tests。
- [ ] 运行 focused SWE-bench runner 和 CLI diagnostics tests。
- [ ] 运行 `npm run typecheck`。
- [ ] 运行 `npm run lint`。
- [ ] 运行 `npm test`。
- [ ] 运行 `node scripts/check-boundaries.mjs`。
- [ ] 运行一次 GLM 5.2 SWE-bench Lite 第二题 canary，记录实际 attempts 与权威 outcome。
