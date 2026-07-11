## Why

The SWE-bench adapter can invoke the official harness with more than one instance id, but the CLI summary still reads a single instance report and cannot produce an honest batch score. Cache evidence is also split from the SWE-bench evaluation path, so a run can appear successful while missing the engineering goal of keeping provider prompt-cache hit rate at or above 90%.

SWE-bench adapter 已经可以把多个 instance id 传给官方 harness，但 CLI summary 仍只读取单题 report，不能产出真实的 batch score。缓存证据也和 SWE-bench evaluation 路径分离，导致一次运行可能显示解题成功，却没有验证工程目标：provider prompt-cache hit rate 是否达到 90% 以上。

## What Changes

- Extend `diagnostics swe-bench evaluate` so it reads every requested prediction/report pair and emits aggregate batch scoring: attempted instances, resolved instances, unresolved instances, resolved rate, and per-instance test counts.
- Add optional cache trace auditing for evaluate via `--cache-trace-path` and `--cache-hit-target`; the audit aggregates `usage.updated` records, computes hit/miss tokens and hit rate, identifies low-hit requests, and fails the diagnostic gate when the measured hit rate is below the requested target.
- Keep leaderboard boundaries honest: batch score is local official-harness evidence for the selected subset, while cache hit rate is an internal engineering SLO and must not be reported as public SWE-bench Lite ranking.
- Keep all new diagnostics redacted: prediction paths, report paths, cache trace paths, command arguments, model patches, and raw usage record bodies stay internal.

- 扩展 `diagnostics swe-bench evaluate`，读取每个 requested prediction/report pair，并输出 aggregate batch scoring：attempted instances、resolved instances、unresolved instances、resolved rate 与每题 test counts。
- 为 evaluate 增加可选 cache trace 审计：`--cache-trace-path` 与 `--cache-hit-target`；审计聚合 `usage.updated` records，计算 hit/miss tokens 与 hit rate，标记低命中请求，并在 measured hit rate 低于目标时让 diagnostic gate 失败。
- 保持榜单边界诚实：batch score 是本地官方 harness 对所选子集的证据；cache hit rate 是内部工程 SLO，不得作为公开 SWE-bench Lite 排名。
- 保持新增 diagnostics 脱敏：prediction paths、report paths、cache trace paths、command arguments、model patches 与 raw usage record bodies 均为 internal。

## Impact

- A single-instance evaluation remains supported and becomes a one-item batch summary.
- Existing prediction JSONL format stays official-compatible.
- The default behavior does not enforce a cache target unless `--cache-hit-target` is supplied, so existing one-off harness verification does not unexpectedly fail.

- 单题 evaluation 继续支持，并表现为单元素 batch summary。
- 现有 prediction JSONL 格式保持官方兼容。
- 默认不强制 cache target；只有显式提供 `--cache-hit-target` 才启用门禁，避免现有一次性 harness 验证意外失败。
