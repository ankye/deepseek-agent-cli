## Why

Supervised SWE-bench prediction now preserves the child CLI JSONL trace, but the adapter still reports prediction success from patch extraction alone. A real run can generate an official-resolved patch while the child CLI terminal event is `agent.loop.failed` because it exceeded model iterations. Supervisors need that terminal status as structured evidence before scaling to 200 instances.

监督式 SWE-bench prediction 已经保留子 CLI JSONL trace，但 adapter 仍只根据 patch extraction 报告 prediction success。真实运行可能已经生成官方 resolved patch，同时子 CLI terminal event 是 `agent.loop.failed`，原因是耗尽 model iterations。扩展到 200 个实例前，监督层需要把这个 terminal status 作为结构化证据。

## What Changes

- Summarize child trace stdout during `diagnostics swe-bench predict` without exposing raw trace bodies.
- Record terminal kind/status/reason plus bounded counters for model requests, usage events, tool intents, and iterations.
- Emit a warning diagnostic when the child terminal event is failed or cancelled while still preserving the official prediction record for harness evaluation.

- 在 `diagnostics swe-bench predict` 中汇总 child trace stdout，但不暴露 raw trace body。
- 记录 terminal kind/status/reason，以及 model requests、usage events、tool intents、iterations 等有界计数。
- 当 child terminal event 为 failed 或 cancelled 时输出 warning diagnostic，同时仍保留 official prediction record 供 harness evaluation 使用。

## Impact

- Harness scoring remains independent: a patch may still be evaluated even if the child loop failed to stop cleanly.
- Batch supervision can separate official resolved score from CLI delivery/stop-condition quality.

- Harness scoring 保持独立：即使 child loop 未干净停机，patch 仍可被评测。
- 批量监督可以区分官方 resolved 分数与 CLI delivery/stop-condition 质量。
