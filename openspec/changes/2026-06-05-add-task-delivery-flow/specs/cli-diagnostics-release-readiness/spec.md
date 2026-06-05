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

#### Scenario: Diagnostics evaluation exposes public execution trace / Diagnostics Evaluate 暴露公开执行轨迹

- **WHEN** `deepseek diagnostics evaluate --execute-task <id> --output text` renders an executed task run
- **THEN** the text output includes a bounded public execution trace with instrumentation event order, final event, staged run status, active/failed stage ids, executor kinds, checker status, checker exit code, and repair stop reason when available
- **AND** it does not render provider raw chain-of-thought, raw model request or response bodies, complete stdout/stderr, raw secrets, environment credentials, or unbounded command output
- **中文** 当 `deepseek diagnostics evaluate --execute-task <id> --output text` 渲染已执行任务 run 时，文本输出必须包含有界的公开执行轨迹，包括 instrumentation event order、final event、staged run status、active/failed stage ids、executor kinds、checker status、checker exit code 与可用的 repair stop reason；不得渲染 provider raw chain-of-thought、raw model request/response bodies、完整 stdout/stderr、raw secrets、environment credentials 或无界 command output。

#### Scenario: Diagnostics evaluation streams safe child progress / Diagnostics Evaluate 流式输出安全子进程进度

- **WHEN** `deepseek diagnostics evaluate --execute-task <id> --output text` runs a DeepSeek CLI child process that emits JSONL task events before the child exits
- **THEN** diagnostics may stream bounded public progress lines for allowlisted child events such as tool intent, tool result, repair started, repair stopped, loop completed, and loop failed
- **AND** progress streaming ignores raw model deltas, provider raw chain-of-thought, raw stdout/stderr lines, raw model request or response bodies, raw secrets, environment credentials, and unrecognized child payloads
- **中文** 当 `deepseek diagnostics evaluate --execute-task <id> --output text` 运行 DeepSeek CLI 子进程，且子进程在退出前输出 JSONL task events 时，diagnostics 可以为 tool intent、tool result、repair started、repair stopped、loop completed 与 loop failed 等 allowlist child events 流式输出有界公开进度行；progress streaming 必须忽略 raw model deltas、provider raw chain-of-thought、raw stdout/stderr lines、raw model request/response bodies、raw secrets、environment credentials 与未识别的 child payloads。

#### Scenario: Diagnostics evaluation streams safe phase progress / Diagnostics Evaluate 流式输出安全阶段进度

- **WHEN** `deepseek diagnostics evaluate --execute-task <id> --output text` advances through workspace preparation, agent command execution, checker execution, artifact scan, and final run outcome
- **THEN** diagnostics may stream bounded public progress lines for those phase transitions before the final evaluation summary renders
- **AND** those phase progress lines include only public task id, baseline id, phase labels, pass/fail state, exit code, outcome, and bounded counts
- **AND** they do not include workspace paths, command arguments, prompts, model deltas, stdout/stderr content, provider request or response bodies, raw secrets, or environment credentials
- **中文** 当 `deepseek diagnostics evaluate --execute-task <id> --output text` 经过 workspace preparation、agent command execution、checker execution、artifact scan 与最终 run outcome 阶段时，diagnostics 可以在最终 evaluation summary 渲染前流式输出这些 phase transitions 的有界公开进度行；这些阶段进度行只能包含 public task id、baseline id、phase labels、pass/fail state、exit code、outcome 与有界计数，不得包含 workspace paths、command arguments、prompts、model deltas、stdout/stderr content、provider request/response bodies、raw secrets 或 environment credentials。
