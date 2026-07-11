## Why

SWE-bench Lite supervision currently treats every missing per-instance `report.json` as a report read failure, even when the official harness produced a top-level report with `error_ids`. This collapses environment or harness failures into generic framework read errors and makes the below-80% review less actionable.

SWE-bench Lite 监督流程目前把每个缺失的单实例 `report.json` 都视为 report read failure，即使 official harness 已经产出包含 `error_ids` 的顶层 report。这样会把环境或 harness 失败压扁成通用框架读取错误，使低于 80% 后的复盘缺少可执行归因。

## What Changes

- Preserve top-level official harness error evidence when per-instance reports are absent.
- Emit a stable diagnostic code for harness error instances instead of only `SWE_BENCH_REPORT_STAT_FAILED` / `SWE_BENCH_REPORT_READ_FAILED`.
- Keep error instances separate from model unresolved instances in batch evidence.
- Add explicit review codes for cache-key instability so provider cache and context projection cache failures are not conflated.

- 当单实例 report 缺失时，保留 official harness 顶层 error evidence。
- 为 harness error instances 输出稳定 diagnostic code，而不是只输出 `SWE_BENCH_REPORT_STAT_FAILED` / `SWE_BENCH_REPORT_READ_FAILED`。
- 在 batch evidence 中把 error instances 与模型 unresolved instances 分开。
- 增加明确的 cache-key instability 复盘 code，避免把 provider cache 与 context projection cache 失败混在一起。

## Impact

- Task-level failed evidence remains failed, but the reason becomes actionable: harness/environment error versus model unresolved.
- Existing official resolved/unresolved scoring remains unchanged when per-instance reports are present.

- 单题 failed evidence 仍然是 failed，但原因变得可执行：区分 harness/environment error 与模型 unresolved。
- 当单实例 report 存在时，现有 official resolved/unresolved scoring 不变。
