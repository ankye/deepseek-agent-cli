# live-agent-tool-execution Specification

## Purpose
Define live agent tool execution requirements for opt-in provider-backed tool loops, bounded feedback, redaction, and replay evidence.

定义 live agent tool execution 对显式启用的 provider-backed tool loops、有界 feedback、redaction 与 replay evidence 的要求。
## Requirements
### Requirement: Live Agent Tool Execution Loop / Live Agent 工具执行循环

The system SHALL support live DeepSeek agent turns where provider-emitted tool calls are normalized, validated, executed through governed runtime boundaries, converted into bounded tool feedback, and sent back to the model for continuation.

系统必须支持 live DeepSeek agent turns：provider 发出的 tool calls 会被归一化、校验、通过受治理 runtime boundaries 执行、转换为有界 tool feedback，并回传给模型继续生成。

#### Scenario: Live tool turn completes / Live 工具回合完成

- **WHEN** a live DeepSeek response requests a registered model-visible read-only tool
- **THEN** runtime validates the intent, executes it through the runtime kernel, sends bounded tool result feedback to the model, and emits a terminal assistant result
- **中文** 当 live DeepSeek response 请求一个已注册且 model-visible 的 read-only tool 时，runtime 必须校验 intent、通过 runtime kernel 执行、把有界 tool result feedback 回传模型，并发出终态 assistant result。

#### Scenario: Provider does not execute tools / Provider 不执行工具

- **WHEN** the DeepSeek provider receives or emits a tool call
- **THEN** it only normalizes the tool-call intent and never invokes capabilities, policy, sandbox, scheduler, bus, workflow, command, skill, hook, MCP, plugin, or session mutation directly
- **中文** 当 DeepSeek provider 接收或发出 tool call 时，它只能归一化 tool-call intent，不得直接调用 capabilities、policy、sandbox、scheduler、bus、workflow、command、skill、hook、MCP、plugin 或 session mutation。

### Requirement: Live Tool Feedback Contract / Live 工具反馈契约

The system SHALL convert every live tool execution outcome into provider-compatible tool feedback with bounded preview, normalized status, diagnostics, trace metadata, and redaction metadata.

系统必须把每个 live tool execution outcome 转换为 provider-compatible tool feedback，包含有界 preview、normalized status、diagnostics、trace metadata 和 redaction metadata。

#### Scenario: Successful tool feedback is bounded / 成功工具反馈有界

- **WHEN** a tool execution succeeds with large output
- **THEN** model-facing feedback includes a bounded redacted preview and replay evidence retains richer structured metadata
- **中文** 当 tool execution 成功但输出很大时，model-facing feedback 必须只包含有界脱敏 preview，replay evidence 保留更丰富的结构化 metadata。

#### Scenario: Failed tool feedback is typed / 失败工具反馈类型化

- **WHEN** a tool execution is rejected, denied, times out, is cancelled, or fails
- **THEN** model-facing feedback carries a normalized non-success status and typed diagnostics without raw stack traces or secrets
- **中文** 当 tool execution 被拒绝、被 deny、超时、取消或失败时，model-facing feedback 必须包含 normalized non-success status 和 typed diagnostics，且不得包含 raw stack traces 或 secrets。

### Requirement: Live Tool Loop Limits / Live 工具循环限制

The live tool loop SHALL enforce explicit limits for model iterations, tool calls, turn timeout, tool timeout, output bytes, retry attempts, and continuation eligibility.

live tool loop 必须强制执行 model iterations、tool calls、turn timeout、tool timeout、output bytes、retry attempts 和 continuation eligibility 的显式限制。

#### Scenario: Iteration limit stops loop / 迭代上限停止循环

- **WHEN** the model continues requesting tools after `maxModelIterations` or `maxToolCalls` is reached
- **THEN** runtime emits a typed terminal failure and does not dispatch more provider requests or tool executions
- **中文** 当模型在达到 `maxModelIterations` 或 `maxToolCalls` 后继续请求 tools 时，runtime 必须发出 typed terminal failure，且不得继续 dispatch provider requests 或 tool executions。

#### Scenario: Timeout prevents continuation / 超时阻止继续

- **WHEN** a turn or tool execution times out
- **THEN** runtime aborts queued or running work and does not send another continuation request to the model
- **中文** 当 turn 或 tool execution 超时时，runtime 必须 abort queued 或 running work，且不得向模型发送另一个 continuation request。

### Requirement: Live Unsafe Tool Handling / Live 不安全工具处理

The live tool loop SHALL fail closed or send bounded corrective feedback for unsafe model tool requests according to safety class.

live tool loop 必须根据 safety class 对不安全 model tool requests fail closed，或发送有界 corrective feedback。

#### Scenario: Unsafe path is rejected before envelope / 不安全路径在 envelope 前被拒绝

- **WHEN** a live model tool call contains traversal, home, absolute, drive-relative, null-byte, or unsupported platform paths
- **THEN** preflight rejects or repairs it before execution envelope creation, emits evidence, and never executes the unsafe original input
- **中文** 当 live model tool call 包含 traversal、home、absolute、drive-relative、null-byte 或 unsupported platform paths 时，preflight 必须在 execution envelope creation 前拒绝或修复，发出 evidence，且不得执行 unsafe original input。

#### Scenario: Unknown tool is not executed / 未知工具不被执行

- **WHEN** a live model requests an unknown, hidden, disabled, or policy-incompatible tool
- **THEN** runtime emits typed rejection evidence and does not schedule executable work
- **中文** 当 live model 请求 unknown、hidden、disabled 或 policy-incompatible tool 时，runtime 必须发出 typed rejection evidence，且不得 schedule executable work。

### Requirement: Live Tool Event Ordering / Live 工具事件顺序

The live tool loop SHALL emit canonical runtime events in deterministic order so CLI, VSCode, tests, and future server hosts can render tool state without owning separate state machines.

live tool loop 必须以确定性顺序发出 canonical runtime events，使 CLI、VSCode、tests 和未来 server hosts 可以渲染 tool state，而不需要拥有独立状态机。

#### Scenario: Successful live tool event order / 成功 Live 工具事件顺序

- **WHEN** a live tool call succeeds and the model continues to final text
- **THEN** events include model request, tool intent, optional repair, envelope, policy, sandbox, scheduler, tool result, continuation model request, model output, and turn completion in order
- **中文** 当 live tool call 成功且模型继续生成最终文本时，events 必须按顺序包含 model request、tool intent、可选 repair、envelope、policy、sandbox、scheduler、tool result、continuation model request、model output 和 turn completion。

#### Scenario: Failed live tool event order / 失败 Live 工具事件顺序

- **WHEN** a live tool call fails at validation, policy, sandbox, scheduler, executor, or provider continuation
- **THEN** events preserve the prefix up to the failing boundary and emit a typed terminal event or bounded model feedback according to the configured continuation policy
- **中文** 当 live tool call 在 validation、policy、sandbox、scheduler、executor 或 provider continuation 阶段失败时，events 必须保留到失败边界为止的前缀，并根据 configured continuation policy 发出 typed terminal event 或有界 model feedback。

### Requirement: Isolated Live Credential Resolution / 隔离 Live 凭据解析

Live agent tool execution SHALL resolve provider credentials for disposable task workspaces through approved user or global configuration sources without copying raw secrets into the workspace.

live agent tool execution 必须通过批准的 user 或 global configuration sources 为 disposable task workspaces 解析 provider credentials，且不得把 raw secrets 复制进 workspace。

#### Scenario: Disposable workspace uses redacted credential fallback / Disposable Workspace 使用脱敏凭据回退
- **WHEN** a live task runs from an isolated disposable workspace
- **AND** the repository workspace or user/global configuration contains valid provider credentials
- **THEN** provider readiness succeeds using a redacted credential source reference
- **AND** evidence records credential presence and source class without raw secret values
- **中文** 当 live task 从 isolated disposable workspace 运行，且 repository workspace 或 user/global configuration 包含有效 provider credentials 时，provider readiness 必须使用脱敏 credential source reference 成功；evidence 必须记录 credential presence 与 source class，但不得记录 raw secret values。

#### Scenario: Missing credentials are environment failures / 缺失凭据是环境失败
- **WHEN** no approved credential source is available for a requested live provider
- **THEN** the run is classified as `invalid-test-environment`
- **AND** the diagnostic distinguishes unavailable credentials from model failure, tool projection failure, and task failure
- **中文** 当 requested live provider 没有可用的 approved credential source 时，run 必须分类为 `invalid-test-environment`；diagnostic 必须区分 credential unavailable、model failure、tool projection failure 与 task failure。

### Requirement: Tool Projection Evidence Drives Continuation / 工具投影证据驱动继续

Live agent tool execution SHALL include compiled tool projection evidence in model dispatch and task traces so missing tools are not mistaken for model weakness.

live agent tool execution 必须在 model dispatch 与 task traces 中包含 compiled tool projection evidence，避免把缺失工具误判为模型弱。

#### Scenario: Model dispatch records visible tools / 模型调用记录可见工具
- **WHEN** runtime sends a live model request
- **THEN** trace evidence includes profile id, stage id, projection status, visible tool ids, required family ids, and unresolved family diagnostics
- **中文** 当 runtime 发送 live model request 时，trace evidence 必须包含 profile id、stage id、projection status、visible tool ids、required family ids 与 unresolved family diagnostics。

#### Scenario: Required write tool missing prevents live request / 必需写工具缺失阻止 Live Request
- **WHEN** a write-capable stage requires mutation or verification tools
- **AND** the compiled projection lacks those tools
- **THEN** runtime does not send the live model request
- **AND** it emits terminal projection evidence instead
- **中文** 当 write-capable stage 需要 mutation 或 verification tools，但 compiled projection 缺少这些工具时，runtime 不得发送 live model request，必须改为发出 terminal projection evidence。

### Requirement: Tool Decisions Are Replayable / 工具决策可回放

Live agent tool execution SHALL record a replayable tool decision board for each agent turn, covering projected tools, hidden tools, model tool intents, preflight decisions, policy decisions, execution results, and follow-up recommendations.

Live agent tool execution 必须为每个 agent turn 记录可回放的工具决策看板，覆盖已投影工具、隐藏工具、模型工具意图、preflight decisions、policy decisions、execution results 与 follow-up recommendations。

#### Scenario: Model request includes decision context / 模型请求包含决策上下文

- **WHEN** runtime sends a live model request
- **THEN** trace evidence SHALL include the active profile id, stage id when present, visible tool ids, hidden tool summaries, projection reasons, previous rejected intents, and decision-quality counters
- **AND** the model-visible prompt MAY include a bounded dynamic summary of corrective next actions
- **中文** 当 runtime 发送 live model request 时，trace evidence 必须包含 active profile id、存在时的 stage id、visible tool ids、hidden tool summaries、projection reasons、previous rejected intents 与 decision-quality counters；模型可见 prompt 可以包含有界的动态 corrective next actions 摘要。

### Requirement: Tool Feedback Guides Next Action / 工具反馈指导下一步

Tool feedback SHALL distinguish success evidence, repair evidence, retryable rejection, non-retryable denial, platform unavailability, and bounded blocker states, and SHALL provide provider-neutral corrective next-action metadata when the model can recover.

工具反馈必须区分 success evidence、repair evidence、retryable rejection、non-retryable denial、platform unavailability 与 bounded blocker states，并在模型可恢复时提供 provider-neutral corrective next-action metadata。

#### Scenario: Repeated rejected intent is suppressed / 重复拒绝意图被抑制

- **WHEN** a model repeats the same rejected tool name and normalized input beyond the configured threshold
- **THEN** runtime SHALL stop re-executing the same failing request
- **AND** it SHALL return bounded feedback requiring a different projected tool, corrected input, or explicit blocker report
- **AND** the decision board SHALL classify the loop as a decision-loop failure candidate.
- **中文** 当模型以相同工具名和归一化输入重复被拒绝超过配置阈值时，runtime 必须停止重复执行同一失败请求；它必须返回有界反馈，要求使用不同的已投影工具、修正输入，或明确报告 blocker；decision board 必须将该循环分类为 decision-loop failure candidate。

### Requirement: Capability Matrix Evidence Artifacts

Live agent tool execution SHALL be auditable through per-task evidence artifacts when run under the supervised capability matrix.

在 supervised capability matrix 下运行时，live agent tool execution 必须通过每个任务的 evidence artifacts 可审计。

#### Scenario: Every task run records a bounded evidence bundle / 每次任务运行记录有界证据包

- **WHEN** a supervised capability-matrix task runs
- **THEN** the CLI SHALL record `prompt.txt`, `trace.jsonl`, `summary.json`, `diff.patch`, and `classification.json` under a run-specific directory
- **AND** the evidence bundle SHALL be sufficient to determine whether the CLI had the needed tools, called them correctly, advanced workflow stages, and closed with a valid terminal reason
- **中文** 当 supervised capability-matrix task 运行时，CLI 必须在 run-specific directory 下记录 `prompt.txt`、`trace.jsonl`、`summary.json`、`diff.patch` 和 `classification.json`；该 evidence bundle 必须足以判断 CLI 是否拥有所需工具、是否正确调用工具、是否推进 workflow stages，以及是否以有效 terminal reason 关闭。

#### Scenario: Disposable write tasks do not mutate the platform repository / Disposable 写任务不修改平台仓库

- **WHEN** a matrix task requires mutation
- **THEN** it SHALL run in a disposable fixture workspace
- **AND** the platform repository SHALL only receive matrix evidence artifacts, not task-target source edits
- **中文** 当 matrix task 需要变更时，必须在 disposable fixture workspace 中运行；平台仓库只能接收 matrix evidence artifacts，不得接收任务目标源码修改。

