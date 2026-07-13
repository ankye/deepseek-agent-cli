# SWE-bench Repair Outcome Stabilization Design

## Purpose / 目标

The current SWE-bench runner can lose a better earlier patch, terminate a later repair after a recoverable edit precondition failure, and report a successful CLI invocation even when the benchmark outcome failed. This design makes supervised attempts transactional, keeps workflow recovery bounded, requires task-specific behavior reproduction, and propagates the authoritative benchmark result without moving SWE-specific policy into the generic runtime.

当前 SWE-bench runner 可能丢失更好的早期 patch，在可恢复的 edit precondition failure 后终止后续修复，并在 benchmark 失败时仍把 CLI invocation 报告为成功。本设计将 supervised attempts 改为事务式候选过程，保持 workflow recovery 有界，要求题目特定的行为复现，并传播权威 benchmark 结果，同时不把 SWE 专用策略下沉到通用 runtime。

## Scope / 范围

This change covers four coupled behaviors:

1. One-shot exact source refresh after a recoverable mutation precondition failure.
2. Immutable per-attempt candidate evidence with best-candidate restoration.
3. A first-attempt SWE behavior contract that requires a safe problem-statement reproduction before public-test-only verification can close.
4. Truthful CLI status and failure attribution in which correctness and flow failures outrank cache readiness findings.

本变更覆盖四个耦合行为：

1. 可恢复 mutation precondition failure 后的一次性精确源文件刷新。
2. 不可变的逐 attempt 候选证据与最佳候选恢复。
3. 首次 SWE attempt 的 behavior contract，要求仅靠 public tests 关闭验证前先完成基于 problem statement 的安全复现。
4. 真实的 CLI status 与失败归因，correctness 和 flow failure 必须高于 cache readiness finding。

## Architecture / 架构

### Generic runtime recovery / 通用 Runtime 恢复

The runtime recognizes a typed `EDIT_PRECONDITION_FAILED` or equivalent exact-match mutation failure. It grants one focused refresh of the same target file even when the ordinary inspection budget is exhausted. The refresh must be bounded and must target the failed mutation path. After it completes, the gate returns to `core.file.edit|core.patch.apply`. A second refresh request terminates with `FLOW_MUTATION_RECOVERY_EXHAUSTED`; it is not classified as requiring user approval.

Runtime 识别类型化的 `EDIT_PRECONDITION_FAILED` 或等价 exact-match mutation failure。即使普通 inspection budget 已用尽，也允许针对同一失败目标文件进行一次 focused refresh。该刷新必须有界，且必须指向失败 mutation path。刷新完成后，gate 恢复为 `core.file.edit|core.patch.apply`。第二次刷新请求以 `FLOW_MUTATION_RECOVERY_EXHAUSTED` 终止，不得归类为需要用户授权。

### SWE host candidate manager / SWE Host 候选管理

The CLI host owns SWE-specific attempt state. Every attempt writes immutable `candidate-attempt-N.patch`, `prediction-attempt-N.jsonl`, `trace-attempt-N.jsonl`, and evaluation metadata. Candidate ranking uses only observable evidence, in this order:

1. official `resolved=true`;
2. a valid official harness report;
3. fewer `PASS_TO_PASS` failures;
4. fewer `FAIL_TO_PASS` failures;
5. harness-ready mutation plus successful local verification;
6. stable attempt order as the final tie-break.

An attempt without a valid harness report cannot replace an existing harness-scored candidate. Before another repair begins, the runner restores the best tracked-file patch when the latest candidate regressed. Checkout-local `.venv` and runner metadata remain intact. The repair context is rebuilt from the restored best candidate and includes a typed note that the regressed attempt was discarded.

CLI host 拥有 SWE 专用 attempt state。每个 attempt 写入不可变的 `candidate-attempt-N.patch`、`prediction-attempt-N.jsonl`、`trace-attempt-N.jsonl` 和 evaluation metadata。候选排序只使用可观测证据，顺序为：官方 `resolved=true`、有效官方 harness report、更少的 `PASS_TO_PASS` 失败、更少的 `FAIL_TO_PASS` 失败、harness-ready mutation 加成功本地验证，以及作为最终 tie-break 的稳定 attempt 顺序。

没有有效 harness report 的 attempt 不能覆盖已经 harness-scored 的候选。开始下一次修复前，若最新候选退化，runner 恢复最佳 tracked-file patch，同时保留 checkout-local `.venv` 和 runner metadata。repair context 从已恢复的最佳候选重建，并包含已丢弃退化 attempt 的类型化说明。

### SWE behavior reproduction / SWE 行为复现

The first child workflow receives a SWE-owned behavior-contract reference derived from the problem statement. A successful public repository test alone cannot close verification until one safe, non-mutating `python -c` or equivalent governed reproduction has run. A failing public test remains valid failure evidence and can enter repair without first satisfying the reproduction gate. This rule is activated only by the SWE behavior-contract reference and does not affect normal coding profiles.

首个 child workflow 接收一个由 problem statement 派生的 SWE-owned behavior-contract reference。在至少执行一次安全、无写入的 `python -c` 或等价受治理复现前，仅有成功的 public repository test 不能关闭验证。失败的 public test 仍然是有效 failure evidence，可以在尚未满足 reproduction gate 时进入 repair。该规则仅由 SWE behavior-contract reference 激活，不影响普通 coding profile。

### Diagnostics and attribution / Diagnostics 与归因

The final summary records both `bestAttempt` and `lastAttempt`. The best attempt supplies the returned patch and authoritative evaluation. The last attempt supplies terminal flow/model diagnostics. A pre-harness final attempt cannot erase a prior official evaluation.

The diagnostics command derives outer status from the nested benchmark outcome. Capability transport success is not benchmark success. Correctness, official unresolved, packaging, and flow failures rank ahead of cache readiness. Cache findings remain visible review codes but become primary only when no correctness failure exists or when the task is already resolved.

最终 summary 同时记录 `bestAttempt` 和 `lastAttempt`。最佳 attempt 提供返回 patch 与权威 evaluation；最后 attempt 提供终态 flow/model diagnostics。最后一个 pre-harness attempt 不能擦除先前的官方 evaluation。

Diagnostics command 从嵌套 benchmark outcome 派生外层 status。Capability transport success 不等于 benchmark success。Correctness、official unresolved、packaging 和 flow failures 的优先级高于 cache readiness。Cache findings 保留为可见 review codes，但只能在没有 correctness failure 或任务已 resolved 时成为 primary。

## Failure Handling / 失败处理

- Candidate persistence failure is a runner packaging failure and prevents that attempt from replacing the best candidate.
- Candidate restoration failure is a runner environment/checkout failure and stops further attempts without deleting prior evidence.
- An exhausted exact-refresh recovery is a flow-control failure, never a user-approval request.
- A final non-harness-ready attempt preserves the previous best official result and adds last-attempt failure evidence.
- No implementation may inspect benchmark gold patches, instance-specific expected code, or repository-specific hardcoded solutions.

- 候选持久化失败属于 runner packaging failure，该 attempt 不得替换最佳候选。
- 候选恢复失败属于 runner environment/checkout failure，必须停止后续 attempts，且不删除既有证据。
- 耗尽 exact-refresh recovery 属于 flow-control failure，绝不得标记为需要用户授权。
- 最后的 non-harness-ready attempt 必须保留先前最佳官方结果，并增加 last-attempt failure evidence。
- 任何实现都不得读取 benchmark gold patch、instance-specific expected code 或 repository-specific 硬编码解法。

## Testing / 测试

Implementation follows test-first development:

1. Runtime regression for exact-refresh recovery after `EDIT_PRECONDITION_FAILED`, including one successful refresh and one exhausted retry.
2. Runner regression with attempt 1 as the best unresolved candidate, attempt 2 as a regression, and attempt 3 as non-harness-ready.
3. CLI regression proving nested benchmark failure propagates to outer JSON status.
4. Attribution regression proving cache findings cannot mask correctness or flow failure.
5. SWE behavior-contract regression proving public-test-only success cannot close initial verification before a safe reproduction.
6. Focused tests, typecheck, lint, full tests, boundary checks, and one GLM 5.2 task-2 canary after deterministic verification passes.

实现严格遵循 test-first development，覆盖 exact-refresh recovery、最佳候选回滚、外层 status 传播、cache 不遮蔽 correctness/flow failure、首次 SWE behavior reproduction，以及 focused tests、typecheck、lint、全量 tests、boundary checks 和一次 GLM 5.2 第二题 canary。

The live canary is observational rather than deterministic acceptance. The repair is accepted when the workflow does not deadlock, a worse or non-harness-ready candidate cannot overwrite the best candidate, and CLI status matches the authoritative official outcome. A model pass remains a measured result, not a guaranteed code-test condition.

实时 canary 是观测性验收，不是确定性验收。当 workflow 不死锁、更差或 non-harness-ready 候选无法覆盖最佳候选，且 CLI status 与权威官方 outcome 一致时，修复通过验收。模型是否通过是测量结果，不是代码测试必须保证的条件。

## Non-Goals / 非目标

- Do not relax all staged workflow boundaries.
- Do not reset every repair attempt to a clean checkout unconditionally.
- Do not make cache readiness a correctness gate.
- Do not guarantee that a stochastic model resolves the benchmark instance.
- Do not refactor unrelated runtime or CLI architecture.

- 不全面放宽 staged workflow 边界。
- 不无条件将每次 repair attempt 重置为干净 checkout。
- 不把 cache readiness 作为 correctness gate。
- 不保证随机模型一定解决 benchmark instance。
- 不重构与本修复无关的 runtime 或 CLI 架构。
