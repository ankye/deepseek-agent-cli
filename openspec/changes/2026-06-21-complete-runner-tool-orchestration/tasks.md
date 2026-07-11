# Tasks

## OpenSpec / 规格

- [x] Create this OpenSpec change for complete runner tool orchestration.
- [x] Record the parent/runner/child architecture boundary.
- [x] Define the complete managed child tool matrix.
- [x] Define staged runner orchestration and technical-director acceptance.
- [x] Validate this OpenSpec change with `npx openspec validate 2026-06-21-complete-runner-tool-orchestration --strict`.
- [x] Validate canonical specs with `npx openspec validate --specs --strict`.

- [x] 创建 complete runner tool orchestration OpenSpec change。
- [x] 记录 parent/runner/child 架构边界。
- [x] 定义完整 managed child 工具矩阵。
- [x] 定义 staged runner 编排与技术总监验收。
- [x] 使用 `npx openspec validate 2026-06-21-complete-runner-tool-orchestration --strict` 校验本 change。
- [x] 使用 `npx openspec validate --specs --strict` 校验 canonical specs。

## Tool Matrix Audit / 工具矩阵审计

- [x] Add failing coverage proving `core.swe.bench.run` audits required child capabilities before child model dispatch.
- [x] Add failing coverage proving missing child environment capability fails with `RUNNER_TOOL_MATRIX_INCOMPLETE` before model attribution.
- [x] Add failing coverage proving missing child mutation capability fails with `RUNNER_MUTATION_TOOL_UNAVAILABLE` before source-progress gates can pass.
- [x] Add failing coverage proving missing child verification capability fails with `RUNNER_VERIFICATION_TOOL_UNAVAILABLE` before model attribution.
- [x] Add failing coverage proving parent dispatcher still exposes only `core.swe.bench.run` for user-level SWE-bench prompts.
- [x] Implement a reusable runner tool matrix descriptor owned by the CLI host/runtime contract boundary, not by tests.
- [x] Emit runner tool matrix evidence into prompt assembly, provider request audit metadata, child trace, and summary JSON.
- [x] Emit visible counts for required, projected, executable, unavailable, policy-denied, and projection-limited child tools.

- [x] 增加失败测试，证明 `core.swe.bench.run` 在 child model dispatch 前审计必需 child capabilities。
- [x] 增加失败测试，证明缺少 child environment capability 时，在模型归因前以 `RUNNER_TOOL_MATRIX_INCOMPLETE` 失败。
- [x] 增加失败测试，证明缺少 child mutation capability 时，在 source-progress gate 通过前以 `RUNNER_MUTATION_TOOL_UNAVAILABLE` 失败。
- [x] 增加失败测试，证明缺少 child verification capability 时，在模型归因前以 `RUNNER_VERIFICATION_TOOL_UNAVAILABLE` 失败。
- [x] 增加失败测试，证明用户级 SWE-bench prompt 的 parent dispatcher 仍只暴露 `core.swe.bench.run`。
- [x] 实现可复用 runner tool matrix descriptor，由 CLI host/runtime contract 边界拥有，而不是由测试拥有。
- [x] 将 runner tool matrix evidence 写入 prompt assembly、provider request audit metadata、child trace 与 summary JSON。
- [x] 输出 required、projected、executable、unavailable、policy-denied 与 projection-limited child tools 的可见计数。

## Staged Runner Orchestration / 分阶段 Runner 编排

- [x] Add failing coverage proving runner stages are `prepare`, `understand`, `change`, `verify`, `score`, `package`, and `return`.
- [x] Add failing coverage proving `understand` cannot complete from duplicate read/search evidence alone.
- [x] Add failing coverage proving `change` cannot complete without mutation-grade evidence and material diff.
- [x] Add failing coverage proving `verify` follows the low-cost ladder before broad public suites.
- [x] Add failing coverage proving `score` distinguishes official unresolved, harness error, environment blocker, and prediction packaging failure.
- [x] Add failing coverage proving `package` writes prediction, child trace, progress ledger, and terminal status before returning to parent.
- [x] Implement runner stage state as replayable contract data with accepted input/output refs.
- [x] Thread runner stage state into child prompt dynamic state without polluting stable provider prefix.
- [x] Preserve parent terminal close behavior: one child terminal outcome produces exactly one parent result.

- [x] 增加失败测试，证明 runner stages 为 `prepare`、`understand`、`change`、`verify`、`score`、`package` 与 `return`。
- [x] 增加失败测试，证明 `understand` 不能只靠重复 read/search evidence 完成。
- [x] 增加失败测试，证明 `change` 没有 mutation-grade evidence 与 material diff 时不能完成。
- [x] 增加失败测试，证明 `verify` 在 broad public suites 前执行低成本验证阶梯。
- [x] 增加失败测试，证明 `score` 区分 official unresolved、harness error、environment blocker 与 prediction packaging failure。
- [x] 增加失败测试，证明 `package` 在返回 parent 前写出 prediction、child trace、progress ledger 与 terminal status。
- [x] 将 runner stage state 实现为可 replay 的 contract data，包含已验收 input/output refs。
- [x] 将 runner stage state 注入 child prompt dynamic state，且不污染稳定 provider prefix。
- [x] 保持 parent terminal close 行为：一个 child terminal outcome 只产生一个 parent result。

## Evidence And Attribution / 证据与归因

- [x] Add failing coverage proving model-owned attribution is rejected when child tool matrix evidence is missing.
- [x] Add failing coverage proving model-owned attribution is rejected when official harness excerpt is unavailable but harness failure is unclassified.
- [x] Add failing coverage proving timeout/budget exhaustion records model request count, tool call count, last stage, and last progress marker.
- [x] Add failing coverage proving technical-director acceptance evaluates evidence sufficiency for every runner stage.
- [x] Add failing coverage proving checkout command blockers carry typed command evidence and block the `prepare` stage before child model dispatch.
- [x] Implement runner failure taxonomy for missing tools, projection gaps, policy denial, environment blockers, harness failures, packaging failures, timeout/budget, and model behavior.
- [x] Add child summary fields for `toolMatrix`, `stageEvaluations`, `technicalDirectorAcceptance`, `primaryFailureCategory`, and `modelAttributionAllowed`.
- [x] Update diagnostics so "model problem" is only emitted when `modelAttributionAllowed=true`.

- [x] 增加失败测试，证明缺少 child tool matrix evidence 时拒绝模型侧归因。
- [x] 增加失败测试，证明 official harness excerpt 不可用且 harness failure 未分类时拒绝模型侧归因。
- [x] 增加失败测试，证明 timeout/budget exhaustion 记录 model request count、tool call count、last stage 与 last progress marker。
- [x] 增加失败测试，证明技术总监验收会评估每个 runner stage 的证据充分性。
- [x] 增加失败测试，证明 checkout command blocker 会携带结构化命令证据，并在 child model dispatch 前阻断 `prepare` 阶段。
- [x] 实现 runner failure taxonomy，覆盖缺工具、投影缺口、policy denial、环境阻塞、harness failure、打包失败、timeout/budget 与模型行为。
- [x] 增加 child summary 字段：`toolMatrix`、`stageEvaluations`、`technicalDirectorAcceptance`、`primaryFailureCategory` 与 `modelAttributionAllowed`。
- [x] 更新 diagnostics，只有 `modelAttributionAllowed=true` 时才输出“模型问题”。

## Verification / 验证

- [x] Run focused CLI host/runtime tests for profile projection, runner tool matrix, child stage orchestration, and attribution.
- [x] Run focused checkout blocker regression: `npx tsx --test --test-name-pattern "classifies checkout command failures" src/apps/cli/src/host/swe-bench-run-capabilities.test.ts`.
- [x] Run focused SWE-bench capability tests: `npx tsx --test src/apps/cli/src/host/swe-bench-run-capabilities.test.ts`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run lint`.
- [x] Run `node scripts/check-boundaries.mjs`.
- [x] Run `npm test`.
- [x] Run one single-task canary only after deterministic tests pass; record whether failure is tool-matrix, orchestration, harness, packaging, budget, or model-attribution-allowed.
  - 2026-06-21 canary `swe-lite-task-2-mqmpv0yl-1`: failed in `prepare` before child model dispatch; `toolMatrix` complete 13/13; category `runner-readiness`; `modelAttributionAllowed=false`; blocker `SWE_BENCH_CHECKOUT_FAILED` with `commandId=swe-bench.checkout.clone`, `exitCode=128`, stderr `Error in the HTTP2 framing layer`.
- [ ] Do not expand task volume until ramp gates in `2026-06-09-govern-swebench-200-ramp` pass.

- [x] 运行 CLI host/runtime focused tests，覆盖 profile projection、runner tool matrix、child stage orchestration 与 attribution。
- [x] 运行 checkout blocker focused 回归测试：`npx tsx --test --test-name-pattern "classifies checkout command failures" src/apps/cli/src/host/swe-bench-run-capabilities.test.ts`。
- [x] 运行 SWE-bench capability focused 测试：`npx tsx --test src/apps/cli/src/host/swe-bench-run-capabilities.test.ts`。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run lint`。
- [x] 运行 `node scripts/check-boundaries.mjs`。
- [x] 运行 `npm test`。
- [x] deterministic tests 通过后只运行一个单题 canary；记录失败属于 tool-matrix、orchestration、harness、packaging、budget，还是允许模型归因。
  - 2026-06-21 canary `swe-lite-task-2-mqmpv0yl-1`：在 child model dispatch 前失败于 `prepare`；`toolMatrix` 完整 13/13；分类 `runner-readiness`；`modelAttributionAllowed=false`；阻塞点为 `SWE_BENCH_CHECKOUT_FAILED`，包含 `commandId=swe-bench.checkout.clone`、`exitCode=128`、stderr `Error in the HTTP2 framing layer`。
- [ ] 在 `2026-06-09-govern-swebench-200-ramp` 的 ramp gates 通过前不得扩批。
