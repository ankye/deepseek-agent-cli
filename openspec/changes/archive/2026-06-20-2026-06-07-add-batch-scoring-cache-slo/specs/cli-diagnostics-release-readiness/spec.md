## MODIFIED Requirements

### Requirement: SWE-bench Prediction Adapter

CLI diagnostics SHALL expose `diagnostics swe-bench predict` and `diagnostics swe-bench evaluate` adapters that can produce official-compatible SWE-bench prediction JSONL, run the official harness, and report local batch scoring evidence for the selected instance subset.

CLI diagnostics 必须暴露 `diagnostics swe-bench predict` 与 `diagnostics swe-bench evaluate` adapters，用于生成官方兼容的 SWE-bench prediction JSONL、运行官方 harness，并报告所选 instance 子集的本地 batch scoring evidence。

#### Scenario: Evaluation adapter reports batch score / Evaluation Adapter 报告批量分数

- **WHEN** `deepseek diagnostics swe-bench evaluate --predictions-path <path> --report-dir <path> --run-id <id> --instance-id <id-a> --instance-id <id-b>` runs
- **THEN** the adapter invokes the official `swebench.harness.run_evaluation` module with all requested instance ids
- **AND** it reads every resulting harness `report.json` for requested predictions
- **AND** diagnostics include attempted instance count, resolved instance count, unresolved instance ids, resolved rate, and per-instance `FAIL_TO_PASS` / `PASS_TO_PASS` success and failure counts
- **AND** a local batch result for a selected subset MUST NOT be reported as a public SWE-bench Lite leaderboard score
- **中文** 当运行 `deepseek diagnostics swe-bench evaluate --predictions-path <path> --report-dir <path> --run-id <id> --instance-id <id-a> --instance-id <id-b>` 时，adapter 必须用所有 requested instance ids 调用官方 `swebench.harness.run_evaluation` module；必须读取每个 requested prediction 对应的 harness `report.json`；diagnostics 必须包含 attempted instance count、resolved instance count、unresolved instance ids、resolved rate，以及每题 `FAIL_TO_PASS` / `PASS_TO_PASS` 成功和失败数量；所选子集的本地 batch result 不得被报告为公开 SWE-bench Lite 榜单分。

#### Scenario: Cache target gates SWE-bench engineering score / Cache 目标门禁 SWE-bench 工程分

- **WHEN** `diagnostics swe-bench evaluate` receives `--cache-trace-path <jsonl> --cache-hit-target 0.9`
- **THEN** diagnostics aggregate provider cache hit tokens, miss tokens, request count, low-hit request count, and hit rate from `usage.updated` records in the trace
- **AND** the diagnostic status fails when the measured hit rate is below the requested target
- **AND** cache hit rate is reported as an internal engineering SLO separate from official harness resolved rate
- **AND** raw prompts, raw model responses, raw model patches, command arguments, and raw usage record bodies are not exposed in diagnostics output
- **中文** 当 `diagnostics swe-bench evaluate` 收到 `--cache-trace-path <jsonl> --cache-hit-target 0.9` 时，diagnostics 必须从 trace 的 `usage.updated` records 聚合 provider cache hit tokens、miss tokens、request count、low-hit request count 与 hit rate；当 measured hit rate 低于 requested target 时 diagnostic status 必须失败；cache hit rate 必须作为内部工程 SLO 报告，并与官方 harness resolved rate 分离；raw prompts、raw model responses、raw model patches、command arguments 与 raw usage record bodies 不得暴露在 diagnostics output 中。
