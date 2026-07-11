## ADDED Requirements

### Requirement: CLI Diagnostics Environment Preparation / CLI 诊断环境准备

CLI diagnostics SHALL expose a structured `diagnostics env prepare` command that prepares local evaluation prerequisites through named readiness profiles while preserving diagnostics output parity and secret safety.

CLI diagnostics 必须暴露结构化 `diagnostics env prepare` 命令，通过命名 readiness profiles 准备本地评测前置条件，同时保持 diagnostics output parity 与 secret safety。

#### Scenario: Diagnostics env prepare renders text and structured output / Diagnostics Env Prepare 渲染文本与结构化输出

- **WHEN** `deepseek diagnostics env prepare --profile swe-bench-lite` is rendered as text, JSON, or JSONL
- **THEN** all modes derive from the same environment preparation summary and include profile id, dry-run state, dependency statuses, command plan, diagnostics, next action, schema version, and redaction metadata
- **AND** structured modes contain no ANSI, cursor state, raw secrets, SDK instances, host UI objects, or terminal-only formatting
- **中文** 当 `deepseek diagnostics env prepare --profile swe-bench-lite` 以 text、JSON 或 JSONL 渲染时，所有模式必须来自同一 environment preparation summary，并包含 profile id、dry-run 状态、dependency statuses、command plan、diagnostics、next action、schema version 与 redaction metadata；structured modes 不得包含 ANSI、cursor state、raw secrets、SDK instances、host UI objects 或 terminal-only formatting。

#### Scenario: Diagnostics env prepare rejects arbitrary commands / Diagnostics Env Prepare 拒绝任意命令

- **WHEN** `diagnostics env prepare` receives unsupported positional input, unsupported profile ids, or command-like extra arguments
- **THEN** diagnostics returns a typed failure with the rejected arguments recorded as redacted metadata and executes no environment step
- **中文** 当 `diagnostics env prepare` 收到 unsupported positional input、unsupported profile id 或类似 command 的额外参数时，diagnostics 必须返回 typed failure，以脱敏 metadata 记录被拒绝参数，且不执行任何 environment step。
