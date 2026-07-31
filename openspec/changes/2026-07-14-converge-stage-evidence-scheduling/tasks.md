# Tasks / 任务

## Specification / 规格

- [x] Record the approved generic convergence design and task-1 compatibility constraint.
- [x] Add bilingual workflow, core-tool, and CLI evaluation delta requirements.
- [x] Validate the change and canonical specs strictly.

- [x] 记录已批准的通用 convergence 设计与第一题兼容性约束。
- [x] 增加双语 workflow、core-tool 与 CLI evaluation 增量要求。
- [x] 严格验证本 change 与 canonical specs。

## Runtime Evidence Window / Runtime 证据窗口

- [x] Add a failing regression that rejects non-visible inspection before execution and opens recovery on the next turn.
- [x] Add failing regressions for same-target range extension, duplicate search evidence, wrong-target evidence, and window exhaustion.
- [x] Implement a focused stage-evidence convergence module and integrate it with agent-loop projection and feedback.
- [x] Preserve exact-target mutation recovery and verification repair behavior.

- [x] 增加失败回归测试：non-visible inspection 在执行前拒绝，并在下一轮打开 recovery。
- [x] 为同目标范围扩展、重复搜索证据、错目标证据与窗口耗尽增加失败回归测试。
- [x] 实现 focused stage-evidence convergence module，并接入 agent-loop projection 与 feedback。
- [x] 保留 exact-target mutation recovery 与 verification repair 行为。

## Search Evidence / 搜索证据

- [x] Add a failing regression that focused recovery search returns content even when the model omits `outputMode`.
- [x] Add a failing regression that equivalent result sets remain duplicates across glob variants.
- [x] Implement focused search normalization and deterministic result evidence identity.
- [x] Add regressions for direct-parent package globs and repository-wide glob rejection.

- [x] 增加失败回归测试：即使模型省略 `outputMode`，focused recovery search 仍返回 content。
- [x] 增加失败回归测试：不同 glob 产生的等价结果集仍判定为 duplicate。
- [x] 实现 focused search 归一化与确定性 result evidence identity。
- [x] 增加 direct-parent package glob 与 repository-wide glob 拒绝回归测试。

## Pre-Harness Attempts / Harness 前 Attempts

- [x] Add a failing regression that an empty-patch child consumes attempt 1 and launches attempt 2 with structured feedback.
- [x] Add a failing regression that environment/configuration failures do not retry.
- [x] Implement typed pre-harness retry classification without weakening candidate restoration.
- [x] Preserve authoritative official failure evidence across a later pre-harness failure.

- [x] 增加失败回归测试：empty-patch child 消耗 attempt 1，并携带结构化反馈启动 attempt 2。
- [x] 增加失败回归测试：environment/configuration failure 不重试。
- [x] 实现 typed pre-harness retry classification，且不削弱 candidate restoration。
- [x] 在后续 pre-harness failure 后保留权威 official failure evidence。

## Compatibility Replays / 兼容性 Replay

- [x] Add a task-1-shaped regression where a second overlapping read adds uncovered lines and mutation/test progress remains reachable.
- [x] Add a task-2-shaped regression where focused `header_rows` search returns content and later equivalent searches cannot consume the stage budget.
- [x] Add regressions for ANSI-colored zero-test output and exact-checkout-root safe reproduction.

- [x] 增加第一题形状回归：第二次重叠读取增加未覆盖行，mutation/test progress 仍可到达。
- [x] 增加第二题形状回归：focused `header_rows` search 返回 content，后续等价搜索不能继续消耗 stage budget。
- [x] 增加 ANSI 彩色零测试输出与精确 checkout root 安全复现回归测试。

### Live Evidence / Live 证据

- 2026-07-14 DeepSeek task 1 baseline `swe-lite-task-1-deepseek-stage-evidence-20260714-1`: `attemptCount=1`, `bestAttempt=1`, `evaluationResolved=true`.
- 2026-07-15 DeepSeek task 2 canary `swe-lite-task-2-deepseek-exact-root-repro-20260715-18`: `attemptCount=3`, `bestAttempt=1`, `evaluationResolved=false`; the best 554-byte partial patch still failed `astropy/io/ascii/tests/test_rst.py::test_rst_with_header_rows`.
- 2026-07-14 DeepSeek 第一题基线 `swe-lite-task-1-deepseek-stage-evidence-20260714-1`：`attemptCount=1`、`bestAttempt=1`、`evaluationResolved=true`。
- 2026-07-15 DeepSeek 第二题 canary `swe-lite-task-2-deepseek-exact-root-repro-20260715-18`：`attemptCount=3`、`bestAttempt=1`、`evaluationResolved=false`；最佳 554-byte 部分 patch 仍未通过 `astropy/io/ascii/tests/test_rst.py::test_rst_with_header_rows`。

## Verification / 验证

- [ ] Run focused runtime, core-tool, and SWE runner tests.
- [ ] Run typecheck, lint, full tests, boundary checks, and all release/acceptance suites.
- [ ] Run task-1 and task-2 live canaries and record attempt/result evidence.

- [ ] 运行 focused runtime、core-tool 与 SWE runner tests。
- [ ] 运行 typecheck、lint、full tests、boundary checks 与全部 release/acceptance suites。
- [ ] 运行第一题和第二题 live canary，并记录 attempt/result evidence。
