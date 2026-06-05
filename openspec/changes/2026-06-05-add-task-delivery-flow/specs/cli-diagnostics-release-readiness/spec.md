## ADDED Requirements

### Requirement: CLI Diagnostics Task Flow Inspection / CLI 诊断任务流程检查

CLI diagnostics SHALL expose a deterministic `diagnostics flow inspect` command for inspecting the canonical task delivery flow without live model calls or workspace mutations.

CLI diagnostics 必须暴露确定性的 `diagnostics flow inspect` 命令，用于检查规范任务交付流程，且不得进行 live model calls 或 workspace mutations。

#### Scenario: Diagnostics flow inspect renders parity output / Diagnostics Flow Inspect 渲染一致输出

- **WHEN** `deepseek diagnostics flow inspect --prompt "continue" --output text|json|jsonl` runs
- **THEN** all output modes derive from the same flow summary and include task brief, goal, plan, phase statuses, acceptance review, delivery decision, diagnostics, schema version, and redaction metadata
- **AND** JSON and JSONL output contain no ANSI, raw terminal state, raw secrets, SDK instances, model client instances, or host UI objects
- **中文** 当 `deepseek diagnostics flow inspect --prompt "continue" --output text|json|jsonl` 运行时，所有输出模式必须来自同一 flow summary，并包含 task brief、goal、plan、phase statuses、acceptance review、delivery decision、diagnostics、schema version 与 redaction metadata；JSON 与 JSONL 输出不得包含 ANSI、raw terminal state、raw secrets、SDK instances、model client instances 或 host UI objects。

#### Scenario: Diagnostics flow inspect rejects arbitrary execution / Diagnostics Flow Inspect 拒绝任意执行

- **WHEN** diagnostics flow inspect receives extra positional command input or execution-like flags outside its allowlist
- **THEN** it returns a typed failure with rejected arguments in redacted metadata and does not call executors, model providers, process runners, or workspace writers
- **中文** 当 diagnostics flow inspect 收到额外 positional command input 或 allowlist 之外的执行类 flags 时，必须返回 typed failure，以脱敏 metadata 记录 rejected arguments，并且不得调用 executors、model providers、process runners 或 workspace writers。

#### Scenario: Diagnostics uses unified request and token audit / Diagnostics 使用统一请求与 Token 审计

- **WHEN** diagnostics flow inspection, evaluation scoring, or release-readiness evidence needs model request counts or token usage
- **THEN** it reads replay-safe audit records and usage-budget totals produced by runtime model request and usage handling
- **AND** it does not parse provider-specific logs, raw provider responses, terminal output, or JSONL rendering artifacts as the source of truth for request or token counts
- **中文** 当 diagnostics flow inspection、evaluation scoring 或 release-readiness evidence 需要 model request counts 或 token usage 时，必须读取 runtime model request 与 usage handling 产出的 replay-safe audit records 和 usage-budget totals；不得解析 provider-specific logs、raw provider responses、terminal output 或 JSONL rendering artifacts 作为请求数或 token 数的事实来源。
