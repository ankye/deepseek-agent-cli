# GLM Diagnostics Evaluate Provider Passthrough

## Summary / 摘要

Allow `diagnostics evaluate` to execute the DeepSeek CLI baseline with an explicitly selected GLM provider/model instead of silently falling back to the default DeepSeek provider.

允许 `diagnostics evaluate` 在执行 DeepSeek CLI baseline 时使用显式选择的 GLM provider/model，而不是静默回退到默认 DeepSeek provider。

## Why / 原因

Provider comparison and local scoring are misleading if `--provider glm --model glm-5.1` is accepted by the diagnostics command but not forwarded to the isolated `deepseek run` subprocess used for task execution.

如果 diagnostics command 接受了 `--provider glm --model glm-5.1`，但没有传递给用于任务执行的隔离 `deepseek run` 子进程，则 provider comparison 与本地跑分会产生误导。

## What Changes / 变更内容

- Pass model provider and model selection from diagnostics evaluate input into CLI evaluation options.
- Forward GLM provider/model flags to the `deepseek run` subprocess for the `deepseek-cli` baseline.
- Supply GLM live credentials to that subprocess without printing raw secrets.

- 将 diagnostics evaluate input 中的 model provider 和 model selection 传入 CLI evaluation options。
- 将 GLM provider/model flags 传递给 `deepseek-cli` baseline 的 `deepseek run` 子进程。
- 向该子进程提供 GLM live credentials，且不打印 raw secrets。
