## MODIFIED Requirements

### Requirement: CLI Evaluation Evidence Is Redacted And Replayable / CLI 评估证据脱敏且可回放

The system SHALL write evaluation summaries and per-task records as redacted, machine-readable evidence that can be replayed or compared over time.

系统必须把 evaluation summaries 与 per-task records 写成脱敏、机器可读、可回放并可跨时间对比的 evidence。

#### Scenario: Evaluation writes local evidence artifacts / Evaluation 写入本地证据产物

- **WHEN** an evaluation run completes
- **THEN** it writes a JSON summary, JSONL task records, bounded sanitized output snippets, patch metadata, and check outputs under stable local evidence paths, without ANSI cursor state, raw secrets, or unbounded transcripts
- **中文** 当 evaluation run 完成时，它必须在稳定本地 evidence paths 下写入 JSON summary、JSONL task records、有界脱敏输出片段、patch metadata 与 check outputs，且不得包含 ANSI cursor state、raw secrets 或 unbounded transcripts。

#### Scenario: Overall score evidence records provider invocation / 总分证据记录 Provider 调用

- **WHEN** `deepseek diagnostics evaluate --full --execute-task all --live --provider glm --model glm-5.1 --output json` writes `tests/acceptance/latest/overall-delivery-capability-score.json`
- **THEN** the evidence includes a redacted invocation record with `provider=glm`, `model=glm-5.1`, `live=true`, selected baselines, and a reproducible command string containing the provider/model flags
- **AND** the evidence does not include raw credential values
- **中文** 当 `deepseek diagnostics evaluate --full --execute-task all --live --provider glm --model glm-5.1 --output json` 写入 `tests/acceptance/latest/overall-delivery-capability-score.json` 时，证据必须包含脱敏 invocation record，记录 `provider=glm`、`model=glm-5.1`、`live=true`、已选择 baselines，以及包含 provider/model flags 的可复现 command string；同时证据不得包含 raw credential values。
