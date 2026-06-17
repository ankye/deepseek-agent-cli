# Govern SWE-bench 200 Ramp

## Why

The SWE-bench Lite supervision loop is below the release ramp threshold: the completed task 2-10 sample is 4/9 resolved, provider cache evidence is below the 90% target in the latest canary, and several failures still collapse into broad labels such as request-budget exceeded or model patch insufficiency. Continuing to launch more tasks would mix model capability, framework defects, cache instability, harness/environment failures, and repair-feedback gaps into one noisy score.

SWE-bench Lite 监督循环目前低于放量门槛：已完成的第 2-10 题样本为 4/9 resolved，最新 canary 的 provider cache 证据低于 90% 目标，并且多个失败仍被压成 request-budget exceeded 或 model patch insufficiency 等宽泛标签。继续启动更多任务会把模型能力、框架缺陷、缓存不稳定、harness/环境失败与 repair feedback 缺口混成一个噪声分数。

## What Changes

- Add a governed ramp contract for the cumulative 200 resolved target: no batch expansion while success is below 80% or provider cache is below 90%.
- Require all previous unresolved/error/pending tasks to receive stable primary reason codes, failure category, actionability, and evidence pointers before any expansion.
- Treat "model capability insufficient" as the last classification, only after framework, cache, harness, environment, prompt/reproduction, and repair-feedback causes are excluded.
- Require problem-statement reproduction synthesis before trusting public local tests, and require high-fidelity official harness failure excerpts in repair context.
- Keep provider token cache and context projection cache separate, with context projection no-store events excluded from hit-rate denominators.
- Forbid repo-name, instance-id, task-number, or hidden-answer allowlists in production behavior; compatibility fixes must be metadata-driven and reusable.
- Require a single-task canary after framework fixes before returning to batch mode.

- 增加累计 200 resolved 目标的治理放量合同：success 低于 80% 或 provider cache 低于 90% 时不得扩批。
- 要求所有历史 unresolved/error/pending 任务在扩批前具备稳定 primary reason code、failure category、actionability 与 evidence pointers。
- 将“模型能力不足”作为最后分类；只有排除框架、缓存、harness、环境、prompt/reproduction 与 repair-feedback 原因后才能使用。
- 要求先从 problem statement 综合最小复现，再信任公开本地测试；repair context 必须包含高保真 official harness failure excerpt。
- 分离 provider token cache 与 context projection cache，并把 context projection no-store 事件排除出命中率分母。
- 禁止生产行为使用 repo-name、instance-id、task-number 或隐藏答案 allowlist；兼容性修复必须是元数据驱动且可复用的。
- 框架修复后必须先跑单题 canary，再回到批量模式。

## Non-Goals

- Do not manually solve any SWE-bench task or encode expected task patches.
- Do not loosen official SWE-bench resolved scoring.
- Do not count cache engineering SLOs as public leaderboard score.
- Do not run task 11, task 12, or any expansion while gates are below threshold.

- 不手工解决任何 SWE-bench 题，也不编码预期题目 patch。
- 不放宽 official SWE-bench resolved scoring。
- 不把 cache 工程 SLO 当作公开榜单分数。
- success/cache 门槛未达标时，不运行第 11/12 题或任何扩批。

## Impact

The next allowed work is review-only or single-canary framework validation. Product changes must be test-first, generic, and traceable to this change. Batch growth resumes only when the latest governed evidence shows both success and cache gates are healthy.

下一步允许的工作仅限复盘或单题 canary 框架验证。产品改动必须 test-first、通用，并能追溯到本 change。只有最新治理证据同时证明 success 与 cache 门槛健康后，才能恢复批量放量。
