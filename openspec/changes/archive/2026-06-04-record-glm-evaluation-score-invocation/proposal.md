# Record GLM Evaluation Score Invocation

## Summary / 摘要

Make overall delivery capability score evidence record the live evaluation invocation, including provider and model selection, so a GLM score can be audited without relying on transient process observations.

让 overall delivery capability score evidence 记录 live evaluation invocation，包括 provider 与 model 选择，使 GLM 跑分可以被审计，而不依赖临时进程观察。

## Why / 原因

`diagnostics evaluate --provider glm --model glm-5.1` already forwards provider selection to isolated task subprocesses, but the generated `overall-delivery-capability-score.json` stores a hard-coded command that omits provider/model. That makes the score look provider-neutral even when GLM was the model under test.

`diagnostics evaluate --provider glm --model glm-5.1` 已经会把 provider 选择透传给隔离 task 子进程，但生成的 `overall-delivery-capability-score.json` 保存的是省略 provider/model 的硬编码命令。这样即使实际被测模型是 GLM，分数看起来也像 provider-neutral。

## What Changes / 变更内容

- Add provider/model invocation metadata to overall delivery score evidence.
- Build the evidence command from the current evaluation options instead of a fixed string.
- Keep raw credentials out of score evidence and continue using additive evidence fields for compatibility.

- 在 overall delivery score evidence 中增加 provider/model invocation metadata。
- 使用当前 evaluation options 生成 evidence command，而不是固定字符串。
- 保持 score evidence 不包含 raw credentials，并通过 additive evidence fields 保持兼容。
