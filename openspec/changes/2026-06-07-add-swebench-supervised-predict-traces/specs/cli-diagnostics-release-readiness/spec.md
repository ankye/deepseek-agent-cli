## MODIFIED Requirements

### Requirement: SWE-bench Prediction Adapter

CLI diagnostics SHALL expose `diagnostics swe-bench predict` evidence controls that preserve the child CLI's own execution trace and allow supervised batch prediction accumulation without Codex solving benchmark tasks.

CLI diagnostics 必须暴露 `diagnostics swe-bench predict` evidence controls，用于保留子 CLI 自己的执行 trace，并允许监督式批量 prediction 累积，而不由 Codex 代替解决 benchmark tasks。

#### Scenario: Prediction adapter preserves supervised child trace / Prediction Adapter 保留监督式子进程 Trace

- **WHEN** `deepseek diagnostics swe-bench predict --instance-file <path> --repo-dir <path> --output-path <jsonl> --trace-output-path <trace.jsonl> --append-output --live` runs
- **THEN** the adapter runs the selected CLI provider/model inside the repository checkout
- **AND** it writes the child CLI stdout to the requested trace path for replay-safe supervision
- **AND** it appends one official-compatible prediction JSONL record to the output path without deleting existing records
- **AND** diagnostics redact trace paths, raw trace bodies, raw model patches, command arguments, and internal metadata
- **中文** 当运行 `deepseek diagnostics swe-bench predict --instance-file <path> --repo-dir <path> --output-path <jsonl> --trace-output-path <trace.jsonl> --append-output --live` 时，adapter 必须在 repository checkout 中运行所选 CLI provider/model；必须把子 CLI stdout 写入指定 trace path 作为可 replay 的监督证据；必须向 output path 追加一条官方兼容 prediction JSONL record，且不得删除已有 records；diagnostics 必须脱敏 trace paths、raw trace bodies、raw model patches、command arguments 与 internal metadata。
