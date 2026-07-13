# Stabilize SWE-bench Repair Outcomes

## Why / 背景

A live GLM 5.2 SWE-bench Lite task-2 run exposed a coupled failure: an earlier candidate passed all public regression tests but failed the hidden target, a later repair regressed every official test, and the final non-harness-ready attempt erased the useful evaluation from the summary. The outer diagnostics command still reported `pass`, while cache readiness became the primary failure reason. This prevents trustworthy model evaluation and wastes supervised repair attempts.

一次 GLM 5.2 SWE-bench Lite 第二题实时运行暴露了耦合失败：较早候选通过全部 public regression tests 但未通过隐藏目标，后续 repair 使全部官方测试退化，最后的 non-harness-ready attempt 又从 summary 中擦除了有用 evaluation。外层 diagnostics command 仍报告 `pass`，同时 cache readiness 成为 primary failure reason。这使模型评估不可信，并浪费 supervised repair attempts。

## What Changes / 变更内容

- Add one-shot, same-target exact refresh after recoverable mutation precondition failure.
- Persist immutable per-attempt candidates and restore the best harness-scored patch when a later attempt regresses.
- Require a SWE-owned problem-statement behavior reproduction before public-test-only success can close first-attempt verification.
- Preserve both best-attempt official evidence and last-attempt terminal evidence.
- Propagate nested benchmark failure to outer CLI diagnostics status.
- Rank correctness and flow failures ahead of cache readiness findings.

- 在可恢复 mutation precondition failure 后增加一次性、同目标 exact refresh。
- 持久化不可变的逐 attempt 候选，并在后续 attempt 退化时恢复最佳 harness-scored patch。
- 在 public-test-only success 关闭首次验证前，要求 SWE-owned problem-statement behavior reproduction。
- 同时保留 best-attempt 官方证据和 last-attempt 终态证据。
- 将嵌套 benchmark failure 传播到外层 CLI diagnostics status。
- 将 correctness 和 flow failure 排在 cache readiness findings 之前。

## Capabilities / 影响能力

- `workflow-orchestration`: bounded mutation recovery, SWE behavior reproduction gate, and transactional supervised attempts.
- `cli-task-completion-evaluation`: authoritative outcome propagation and correctness-first attribution.

- `workflow-orchestration`：有界 mutation recovery、SWE behavior reproduction gate 与事务式 supervised attempts。
- `cli-task-completion-evaluation`：权威 outcome 传播与 correctness-first 归因。

## Non-Goals / 非目标

- Do not encode task-specific or repository-specific expected patches.
- Do not relax all workflow stage boundaries.
- Do not guarantee a stochastic model pass.
- Do not turn cache readiness into a correctness gate.

- 不编码 task-specific 或 repository-specific expected patch。
- 不全面放宽 workflow stage 边界。
- 不保证随机模型一定通过。
- 不把 cache readiness 变成 correctness gate。
