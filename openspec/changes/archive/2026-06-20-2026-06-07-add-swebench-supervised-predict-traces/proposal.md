## Why

The supervised SWE-bench flow must let DeepSeek CLI solve instances independently while Codex only observes evidence. Today `diagnostics swe-bench predict` runs the child CLI and records a patch, but it discards the child JSONL stdout and overwrites the prediction file. That blocks batch supervision because we cannot audit the CLI's own tool events, usage events, cache evidence, or accumulate predictions for many instances in one official-compatible JSONL file.

监督式 SWE-bench 流程必须让 DeepSeek CLI 独立解题，Codex 只观察证据。当前 `diagnostics swe-bench predict` 会运行子 CLI 并记录 patch，但会丢弃子进程 JSONL stdout，且每次覆盖 prediction file。这会阻塞批量监督：我们无法审计 CLI 自己的工具事件、usage events、cache evidence，也无法把多题 prediction 累积到一个官方兼容 JSONL 文件。

## What Changes

- Add an internal `--trace-output-path` option for `diagnostics swe-bench predict` that saves the child CLI JSONL stdout as replay/audit evidence.
- Add an opt-in `--append-output` option so multiple supervised prediction runs can append official prediction records to the same JSONL file.
- Keep trace paths, command arguments, raw model patches, and trace bodies internal/redacted.

- 为 `diagnostics swe-bench predict` 增加 internal `--trace-output-path` 选项，用于保存子 CLI JSONL stdout 作为 replay/audit evidence。
- 增加 opt-in `--append-output`，使多次监督式 prediction run 可以把官方 prediction records 追加到同一个 JSONL 文件。
- 保持 trace paths、command arguments、raw model patches 与 trace bodies 为 internal/redacted。

## Impact

- Existing single-instance prediction behavior remains overwrite-by-default.
- Batch orchestration can now call predict per instance without Codex reading or solving the benchmark task.

- 现有单题 prediction 行为仍默认覆盖输出。
- 批量编排现在可以逐题调用 predict，而不需要 Codex 阅读或解答 benchmark task。
