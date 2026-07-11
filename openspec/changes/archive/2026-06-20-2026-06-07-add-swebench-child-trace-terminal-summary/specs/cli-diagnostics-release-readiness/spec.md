## MODIFIED Requirements

### Requirement: SWE-bench Prediction Adapter

CLI diagnostics SHALL summarize the child CLI trace terminal status for supervised SWE-bench prediction without exposing raw model, tool, patch, stdout, or trace bodies.

CLI diagnostics 必须为监督式 SWE-bench prediction 汇总 child CLI trace terminal status，且不得暴露 raw model、tool、patch、stdout 或 trace bodies。

#### Scenario: Prediction adapter reports child terminal status / Prediction Adapter 报告子进程终态

- **WHEN** `diagnostics swe-bench predict --trace-output-path <trace.jsonl> --live` captures child CLI JSONL stdout
- **THEN** the prediction summary includes bounded child trace evidence: trace path, terminal event kind, terminal status, terminal reason when present, model request count, usage event count, tool intent count, and observed iteration count
- **AND** if the terminal event is `agent.loop.failed` or `agent.loop.cancelled`, diagnostics include a warning that the child CLI did not stop cleanly
- **AND** diagnostics do not include raw trace lines, raw model deltas, raw tool inputs/outputs, raw patch bodies, or raw stdout/stderr bodies
- **中文** 当 `diagnostics swe-bench predict --trace-output-path <trace.jsonl> --live` 捕获 child CLI JSONL stdout 时，prediction summary 必须包含有界 child trace evidence：trace path、terminal event kind、terminal status、存在时的 terminal reason、model request count、usage event count、tool intent count 与 observed iteration count；如果 terminal event 是 `agent.loop.failed` 或 `agent.loop.cancelled`，diagnostics 必须给出 child CLI 未干净停机的 warning；diagnostics 不得包含 raw trace lines、raw model deltas、raw tool inputs/outputs、raw patch bodies 或 raw stdout/stderr bodies。
