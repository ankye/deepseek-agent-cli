# core-coding-tools Specification

## Purpose

Defines the built-in governed coding tools that let DeepSeek CLI operate on a repository through platform, policy, scheduling, replay, and host-neutral runtime boundaries.

定义内置受治理 coding tools，使 DeepSeek CLI 能通过 platform、policy、scheduling、replay 和 host-neutral runtime 边界操作仓库。
## Requirements
### Requirement: Built-In Core Coding Tool Set / 内置核心 Coding Tool 集合

The system SHALL provide built-in governed coding tools for file read, file write, exact edit, glob/list files, semantic search, shell/process execution, git status, git diff, test command execution, and todo/plan state.

系统必须提供内置受治理 coding tools，覆盖 file read、file write、exact edit、glob/list files、semantic search、shell/process execution、git status、git diff、test command execution 和 todo/plan state。

#### Scenario: Register core tools / 注册核心工具

- **WHEN** runtime dependencies register built-in coding tools
- **THEN** each tool has a stable capability id, version, input schema, output schema, side-effect level, permissions, timeout defaults, replay policy, and host/model projection metadata
- **中文** 当 runtime dependencies 注册内置 coding tools 时，每个工具必须具备稳定 capability id、version、input schema、output schema、side-effect level、permissions、timeout defaults、replay policy 和 host/model projection metadata。

#### Scenario: Disabled tool is not projected / 禁用工具不投影

- **WHEN** a core coding tool is disabled by policy or compatibility metadata
- **THEN** the model-visible tool projection excludes it and executable lookup cannot run it
- **中文** 当 core coding tool 被 policy 或 compatibility metadata 禁用时，model-visible tool projection 必须排除它，executable lookup 也不能运行它。

### Requirement: File Read And Listing Tools / 文件读取与列表工具

The core coding tools SHALL expose typed file read and listing capabilities scoped to the governed workspace. Read tools SHALL support `offset` and `limit` parameters for large files, return a typed `{ kind: "image", mime, base64 }` shape for image MIME types under a configurable size cap, and (where a PDF reader is injected) accept an explicit `pages: "M-N"` range to extract text from the first 20 pages. Existing callers that omit these parameters SHALL continue to receive the current behavior.

核心工具必须暴露 typed 文件读取与列表 capability，范围限定在受治理工作区。读取工具必须支持 `offset` 与 `limit` 参数用于大文件，对图片 MIME 在可配置大小上限内返回 typed `{ kind: "image", mime, base64 }`，并且（在注入 PDF reader 时）接受显式 `pages: "M-N"` 范围从前 20 页抽取文字。既有不传这些参数的调用方必须保留今天行为。

#### Scenario: Read returns bounded content with offset / 支持 offset/limit

- **WHEN** the read tool is invoked with `offset: k` and `limit: n`
- **THEN** the tool returns at most `n` lines starting from line `k`, preserving redaction, and the result metadata records the `nextOffset`
- **中文** 当读取工具以 `offset: k` 与 `limit: n` 被调用时，必须返回从第 `k` 行开始的最多 `n` 行，保留 redaction，结果 metadata 记录 `nextOffset`。

#### Scenario: Read returns base64 for image MIME / 图片返回 base64

- **WHEN** the read tool is invoked for a path whose MIME is `image/png`, `image/jpeg`, or `image/gif` and whose size is within 10 MB
- **THEN** the result is `{ kind: "image", mime, base64, sizeBytes }` with no textual body
- **中文** 当读取工具访问 MIME 为 `image/png`、`image/jpeg` 或 `image/gif` 且大小 ≤ 10MB 的路径时，结果必须是 `{ kind: "image", mime, base64, sizeBytes }`，不含文本主体。

#### Scenario: List sorts by modification time / 列表按 mtime 排序

- **WHEN** the list tool returns multiple matches
- **THEN** results are sorted by file modification time in descending order (most recent first) unless an explicit `sort` parameter overrides
- **中文** 当列表工具返回多条匹配时，必须按文件修改时间降序排序（最新在前），除非 `sort` 参数显式覆盖。

### Requirement: File Write And Edit Transactions / 文件写入与编辑事务

Write and edit tools SHALL represent mutations as workspace edit transactions with preconditions, affected paths, rollback metadata, policy context, and post-edit evidence.

write 和 edit tools 必须把修改表示为 workspace edit transactions，包含 preconditions、affected paths、rollback metadata、policy context 和 post-edit evidence。

#### Scenario: Exact edit succeeds / 精确编辑成功

- **WHEN** an edit tool receives target path, expected old text, and replacement text and the expected text appears exactly once
- **THEN** it applies the edit, records pre-edit snapshot metadata, records rollback metadata, returns changed ranges, and emits replay-safe evidence
- **中文** 当 edit tool 收到 target path、expected old text 和 replacement text，且 expected text 恰好出现一次时，必须应用编辑、记录 pre-edit snapshot metadata、记录 rollback metadata、返回 changed ranges，并发出 replay-safe evidence。

#### Scenario: Edit precondition fails / 编辑前置条件失败

- **WHEN** expected old text is missing or appears more than once
- **THEN** the edit tool rejects without mutating the file and returns diagnostics explaining the precondition failure
- **中文** 当 expected old text 缺失或出现多次时，edit tool 必须拒绝且不修改文件，并返回说明 precondition failure 的 diagnostics。

### Requirement: Semantic Search And Glob Tools / 语义化搜索与 Glob 工具

The core coding tools SHALL expose typed semantic search and glob capabilities that operate on the governed workspace scope. Search tools SHALL support ripgrep-style options including case-insensitive matching, context lines (`-C`), multiline patterns, glob filters, and explicit output modes (`content` / `files_with_matches` / `count`), while preserving the existing required parameters and default behavior. Glob tools SHALL sort matches by modification time (descending) by default and accept `**`-style recursive patterns.

核心工具必须暴露 typed 语义搜索与 glob capability，在受治理的工作区范围内运行。搜索工具必须支持 ripgrep 风格选项，包括大小写不敏感、上下文行（`-C`）、multiline 模式、glob 过滤、显式 output 模式（`content` / `files_with_matches` / `count`），并保留原有必选参数与默认行为。Glob 工具默认必须按修改时间降序排序匹配，并接受 `**` 风格递归 pattern。

#### Scenario: Default search returns file paths with redaction / 默认搜索返回带脱敏的文件路径

- **WHEN** the search tool is invoked with only a `pattern`
- **THEN** it returns the list of matching files with redaction metadata and no surprising content inlining
- **中文** 当搜索工具仅带 `pattern` 被调用时，必须返回匹配的文件路径列表，带 redaction metadata，且不意外内联文件内容。

#### Scenario: Context lines expose surrounding matches / 上下文行暴露匹配周围

- **WHEN** the search tool is invoked with `contextLines: n` and `outputMode: "content"`
- **THEN** each match includes up to `n` lines before and after the matching line, separated by a deterministic boundary, without exceeding the configured byte cap
- **中文** 当搜索工具以 `contextLines: n` 与 `outputMode: "content"` 被调用时，每次命中必须包含前后最多 `n` 行，用确定性分隔标识，且不超过配置的字节上限。

#### Scenario: Multiline matching requires explicit opt-in / 多行匹配需显式开启

- **WHEN** the search tool is invoked with `multiline: true`
- **THEN** patterns may match across line boundaries; otherwise patterns match within a single line as today
- **中文** 当搜索工具以 `multiline: true` 被调用时，pattern 可跨行匹配；否则按今天的单行匹配行为。

#### Scenario: Glob filter restricts file set / glob 过滤限定文件集

- **WHEN** the search tool is invoked with `glob: "*.ts"` (or similar)
- **THEN** only files matching the glob participate in the search, independent of `pattern`
- **中文** 当搜索工具以 `glob: "*.ts"`（或类似）被调用时，必须只让匹配该 glob 的文件参与搜索，与 `pattern` 无关。

### Requirement: Shell Process And Test Command Tools / Shell Process 与测试命令工具

Shell/process and test command tools SHALL declare platform provider context, cwd, argv or shell profile, timeout, resource locks, environment scope, policy metadata, and redacted output limits before scheduling.

shell/process 和 test command tools 必须在 scheduling 前声明 platform provider context、cwd、argv 或 shell profile、timeout、resource locks、environment scope、policy metadata 和脱敏 output limits。

#### Scenario: Process execution requires policy / 进程执行要求策略

- **WHEN** a shell/process or test command tool is invoked
- **THEN** policy receives side effect, command summary, cwd, shell profile when any, process provider, timeout, and resource locks before scheduler submission
- **中文** 当 shell/process 或 test command tool 被调用时，policy 必须在 scheduler submission 前收到 side effect、command summary、cwd、适用时的 shell profile、process provider、timeout 和 resource locks。

#### Scenario: Remote no-shell fails closed / 远程无 shell 安全失败

- **WHEN** shell syntax is requested on a remote/no-local-shell host
- **THEN** the tool returns a typed platform unavailable diagnostic and no command is scheduled
- **中文** 当 remote/no-local-shell host 请求 shell syntax 时，工具必须返回 typed platform unavailable diagnostic，且不调度任何命令。

### Requirement: Git Evidence Tools / Git 证据工具

Git status and diff tools SHALL be read-only semantic tools that collect repository evidence through governed platform process semantics or deterministic fallbacks.

git status 和 diff tools 必须是 read-only semantic tools，通过受治理 platform process semantics 或 deterministic fallbacks 收集 repository evidence。

#### Scenario: Git status summarizes repository state / Git status 汇总仓库状态

- **WHEN** git status runs in a repository
- **THEN** it returns branch metadata when available, changed file summaries, provider metadata, diagnostics, and bounded output evidence
- **中文** 当 git status 在仓库中运行时，必须返回可用的 branch metadata、changed file summaries、provider metadata、diagnostics 和 bounded output evidence。

#### Scenario: Git unavailable returns diagnostics / Git 不可用返回诊断

- **WHEN** git is unavailable or the workspace is not a repository
- **THEN** git tools return structured diagnostics instead of shell-specific failures
- **中文** 当 git 不可用或 workspace 不是仓库时，git tools 必须返回 structured diagnostics，而不是 shell-specific failures。

### Requirement: Todo And Plan Tool / Todo 与计划工具

The todo/plan tool SHALL store structured task state as replayable runtime evidence and SHALL not create a host-owned state machine.

todo/plan tool 必须把 structured task state 存储为可 replay 的 runtime evidence，且不得创建 host-owned state machine。

#### Scenario: Update plan state / 更新计划状态

- **WHEN** the todo/plan tool receives a list of tasks and statuses
- **THEN** it validates statuses, records a replay-safe plan snapshot, and emits a runtime-visible output
- **中文** 当 todo/plan tool 收到 tasks 与 statuses 列表时，必须校验 statuses、记录 replay-safe plan snapshot，并发出 runtime-visible output。

### Requirement: Tool Result Evidence / 工具结果证据

Every core coding tool result SHALL use a structured evidence object with redaction metadata, bounded previews, affected paths, diagnostics, provider metadata, and replay metadata.

每个核心 coding tool result 必须使用 structured evidence object，包含 redaction metadata、bounded previews、affected paths、diagnostics、provider metadata 和 replay metadata。

#### Scenario: Large output is bounded / 大输出有边界

- **WHEN** a file read, search, shell, git, or test command result exceeds configured limits
- **THEN** the tool returns a preview, truncation metadata, digest or byte counts, and redaction metadata rather than unbounded raw output
- **中文** 当 file read、search、shell、git 或 test command result 超过配置限制时，工具必须返回 preview、truncation metadata、digest 或 byte counts 和 redaction metadata，而不是无边界 raw output。

### Requirement: Core Tool Checkpoint Evidence / 核心工具 Checkpoint 证据

File write and edit tools SHALL include checkpoint references and redacted rollback evidence in successful mutation results.

file write 与 edit tools 必须在成功 mutation result 中包含 checkpoint references 和脱敏 rollback evidence。

#### Scenario: Write result exposes checkpoint id / 写入结果暴露 checkpoint id

- **WHEN** a file write tool successfully mutates a workspace file
- **THEN** the tool result metadata includes a checkpoint id, before/after hashes, and redaction metadata without raw rollback content
- **中文** 当 file write tool 成功修改 workspace file 时，tool result metadata 必须包含 checkpoint id、before/after hashes 和 redaction metadata，且不包含 raw rollback content。

#### Scenario: Edit result exposes checkpoint id / 编辑结果暴露 checkpoint id

- **WHEN** an exact edit tool successfully mutates a workspace file
- **THEN** the tool result metadata includes a checkpoint id and changed ranges while preserving redacted rollback evidence
- **中文** 当 exact edit tool 成功修改 workspace file 时，tool result metadata 必须包含 checkpoint id 与 changed ranges，并保留脱敏 rollback evidence。

### Requirement: Model-Visible Core Tool Projection / 面向模型的核心工具投影

Core coding tools SHALL expose model-visible tool schemas derived from registered executable capabilities, policy state, platform availability, and provider compatibility metadata.

core coding tools 必须暴露 model-visible tool schemas，其来源必须是已注册 executable capabilities、policy state、platform availability 和 provider compatibility metadata。

#### Scenario: Disabled or unavailable tool is hidden / 禁用或不可用工具被隐藏

- **WHEN** a tool is disabled by policy, unavailable on the active platform, or unsupported by the selected provider profile
- **THEN** the model-visible tool projection excludes the tool and executable lookup rejects direct invocation
- **中文** 当工具被 policy 禁用、在当前平台不可用，或被所选 provider profile 不支持时，model-visible tool projection 必须排除该工具，executable lookup 也必须拒绝直接调用。

#### Scenario: Projected schema is executable / 投影 schema 可执行

- **WHEN** runtime projects a core coding tool to the model
- **THEN** the same capability id, version, input schema, side-effect metadata, timeout defaults, and replay policy are available to the governed execution pipeline
- **中文** 当 runtime 把 core coding tool 投影给模型时，同一 capability id、version、input schema、side-effect metadata、timeout defaults 和 replay policy 必须可用于受治理 execution pipeline。

### Requirement: Core Tool Preflight for Model Calls / 模型调用的核心工具预检

Core coding tools SHALL validate and normalize model-supplied inputs before execution, including workspace paths, platform command semantics, output bounds, resource locks, and side-effect metadata.

core coding tools 必须在执行前校验并归一化模型提供的输入，包括 workspace paths、platform command semantics、output bounds、resource locks 和 side-effect metadata。

#### Scenario: Path is normalized before read / 读取前路径被归一化

- **WHEN** a model requests a file read with provider-specific path separators, relative segments, or workspace aliases
- **THEN** the tool preflight resolves the path through the platform workspace contract and rejects escapes before reading
- **中文** 当模型请求 file read 且输入包含 provider-specific path separators、relative segments 或 workspace aliases 时，tool preflight 必须通过 platform workspace contract 解析路径，并在读取前拒绝 escape。

#### Scenario: Shell command is platform checked / Shell 命令经过平台检查

- **WHEN** a model requests a shell or test command
- **THEN** the tool preflight checks shell profile availability, cwd, argv, environment scope, timeout, policy metadata, and resource locks before scheduler submission
- **中文** 当模型请求 shell 或 test command 时，tool preflight 必须在 scheduler submission 前检查 shell profile availability、cwd、argv、environment scope、timeout、policy metadata 和 resource locks。

### Requirement: Tool Result Feedback Shape / 工具结果反馈形态

Core coding tools SHALL produce bounded, provider-neutral tool result messages suitable for returning to the model and richer replay evidence suitable for trace, audit, and golden tests.

core coding tools 必须生成有界 provider-neutral tool result messages 以回传模型，并生成更丰富的 replay evidence 用于 trace、audit 和 golden tests。

#### Scenario: Tool result separates model preview and evidence / 工具结果分离模型预览与证据

- **WHEN** a core tool completes
- **THEN** the result includes a bounded model-facing preview, structured evidence, affected paths when any, redaction metadata, diagnostics, and replay metadata
- **中文** 当 core tool 完成时，结果必须包含有界 model-facing preview、structured evidence、适用时的 affected paths、redaction metadata、diagnostics 和 replay metadata。

### Requirement: Web Access Tools / 网络接入工具

The core coding tools SHALL expose `core.web.fetch` and `core.web.search` capabilities so agents can incorporate external web content within governed constraints. `core.web.fetch` SHALL convert HTML responses into redacted markdown by default and SHALL invoke a summarizer only when the caller opts in. `core.web.search` SHALL stay disabled unless an explicit `WebSearchProvider` is injected via runtime dependencies; when disabled it SHALL return a typed `WEB_SEARCH_UNAVAILABLE` diagnostic rather than attempting network access.

核心工具必须提供 `core.web.fetch` 与 `core.web.search` 两个 capability，使 agent 能在受约束前提下引入外部网页内容。`core.web.fetch` 默认必须把 HTML 响应转换为脱敏 markdown，只在调用方 opt-in 时调用摘要器。`core.web.search` 默认必须保持 disabled，除非通过 runtime dependencies 注入 `WebSearchProvider`；disabled 状态必须返回 typed `WEB_SEARCH_UNAVAILABLE` diagnostic，而不是发起网络请求。

#### Scenario: Fetch returns markdown without summarization by default / fetch 默认返回 markdown

- **WHEN** `core.web.fetch` is invoked without `summarize: true`
- **THEN** the tool fetches the URL via HTTP(S) only, follows at most 5 redirects, truncates the response body at 10 MB, strips `<script>` / `<style>` / `<iframe>`, returns the converted markdown plus response metadata, and does not call the model gateway
- **中文** 当 `core.web.fetch` 被调用且未设 `summarize: true` 时，必须仅通过 HTTP(S) 请求 URL、最多 follow 5 次 redirect、响应体 > 10MB 截断、剥离 `<script>` / `<style>` / `<iframe>`，返回转换后的 markdown 与响应 metadata，并不得调用 model gateway。

#### Scenario: Fetch summarization is explicit / fetch 摘要需显式 opt-in

- **WHEN** `core.web.fetch` is invoked with `summarize: true` and a non-empty `prompt`
- **THEN** the tool passes the extracted markdown and prompt to the configured model gateway with a bounded token budget and returns the structured summary alongside the source metadata
- **中文** 当 `core.web.fetch` 被调用且 `summarize: true` 并带非空 `prompt` 时，工具必须把抽取的 markdown 和 prompt 交给已配置的 model gateway，使用有界 token 预算，返回结构化摘要与来源 metadata。

#### Scenario: Search without provider reports unavailable / 未注入 provider 时报告不可用

- **WHEN** `core.web.search` is invoked and no `WebSearchProvider` is registered in runtime dependencies
- **THEN** the tool returns a typed `WEB_SEARCH_UNAVAILABLE` diagnostic listing supported provider names and does not perform any outbound network request
- **中文** 当 `core.web.search` 被调用且 runtime dependencies 未注册 `WebSearchProvider` 时，工具必须返回 typed `WEB_SEARCH_UNAVAILABLE` diagnostic 并列出支持的 provider 名称，且不得发起任何外部网络请求。

### Requirement: Sub-Agent Spawn Tool / 子 Agent 派生工具

The core coding tools SHALL expose `core.agent.spawn` to run a governed sub-agent in a forked session with a bounded tool projection, so that delegated research or bulk tasks do not pollute the parent agent's context. The returned result SHALL summarize the sub-agent's terminal status, assistant text, iterations, and child session id, while the sub-agent's intermediate events SHALL remain isolated to the forked session.

核心工具必须提供 `core.agent.spawn`，在 fork 出的子 session 中运行受治理的子 agent，并限定工具投影边界，使委派的调研或批量任务不污染父 agent 上下文。返回结果必须汇总子 agent 的终态、assistantText、iterations 与 childSessionId；子 agent 的中间事件必须隔离在 fork session 内。

#### Scenario: Spawn defaults to read-only projection / 默认只读投影

- **WHEN** `core.agent.spawn` is invoked without specifying `toolProjection`
- **THEN** the sub-agent loop runs with `toolProjection: "read-only"` regardless of the parent's projection, preventing accidental write side-effects during delegated work
- **中文** 当 `core.agent.spawn` 被调用且未指定 `toolProjection` 时，子 agent loop 必须以 `toolProjection: "read-only"` 运行，无论父 agent 投影如何，以免在委派工作中意外写入副作用。

#### Scenario: Sub-agent events isolated to forked session / 子 agent 事件隔离

- **WHEN** a sub-agent emits `agent.loop.started`, `model.delta`, `agent.loop.completed`, or any other runtime event
- **THEN** those events are appended to the forked child session's event log only; the parent session bus SHALL NOT observe them; the parent agent SHALL receive only a structured `AgentSpawnResult` summarizing the terminal outcome
- **中文** 当子 agent 发出 `agent.loop.started`、`model.delta`、`agent.loop.completed` 等任何 runtime event 时，必须仅追加到 fork 出的子 session 事件日志；父 session bus 必须看不到这些事件；父 agent 仅能收到结构化 `AgentSpawnResult` 汇总终态。

### Requirement: Background Shell Tools / 后台 Shell 工具

The core coding tools SHALL support `core.shell.run` with an optional `runInBackground` flag, and expose companion `core.shell.output` and `core.shell.kill` capabilities, backed by a runtime-injected `BackgroundTaskManager`. Background tasks SHALL write stdout and stderr to workspace-scoped files addressable by `taskId`, and the CLI SHALL terminate any surviving tasks on shutdown.

核心工具必须支持 `core.shell.run` 的 `runInBackground` 可选 flag，并提供 `core.shell.output` 与 `core.shell.kill` 配套 capability，由 runtime 注入 `BackgroundTaskManager` 承载。后台任务必须把 stdout/stderr 写到以 `taskId` 寻址的工作区内文件，CLI 关闭时必须终止所有存活任务。

#### Scenario: Background shell returns task id immediately / 后台 shell 立即返回 taskId

- **WHEN** `core.shell.run` is invoked with `runInBackground: true`
- **THEN** the tool returns `{ taskId, status: "running" }` without waiting for the process to complete, and subsequent `core.shell.output` calls for that `taskId` return accumulated stdout and stderr plus a `done` flag and `exitCode` once the process terminates
- **中文** 当 `core.shell.run` 被调用且 `runInBackground: true` 时，工具必须立即返回 `{ taskId, status: "running" }` 而不等待进程结束；后续对该 `taskId` 调用 `core.shell.output` 必须返回累计的 stdout/stderr，进程结束后带 `done` 标记与 `exitCode`。

#### Scenario: Kill terminates task by id / 按 id 终止任务

- **WHEN** `core.shell.kill` is invoked with a live `taskId`
- **THEN** the tool sends `SIGTERM` to the subprocess, waits up to 2 seconds for graceful exit, and escalates to `SIGKILL` if still alive; the subsequent `core.shell.output` for that `taskId` reports `done: true` with the observed `exitCode`
- **中文** 当 `core.shell.kill` 被调用且 `taskId` 对应任务存活时，工具必须发送 `SIGTERM`、等待至多 2 秒优雅退出、仍存活则发 `SIGKILL`；随后对该 `taskId` 的 `core.shell.output` 必须报告 `done: true` 与观察到的 `exitCode`。

#### Scenario: CLI shutdown disposes background tasks / CLI 退出时清理后台任务

- **WHEN** the CLI process exits after running one or more background tasks
- **THEN** the runtime SHALL call `backgroundTasks.disposeAll()`, which sends `SIGTERM` followed by `SIGKILL` (2 s grace) to every surviving task so no orphan processes remain
- **中文** 当 CLI 在运行过一个或多个后台任务后退出时，runtime 必须调 `backgroundTasks.disposeAll()`，对所有存活任务发 `SIGTERM`、2 秒后 `SIGKILL`，不留孤儿进程。

### Requirement: Skill Discovery And Activation Tools / Skill 发现与激活工具

The core coding tools SHALL expose `core.skill.list` and `core.skill.activate` so agents can discover registered skills and trigger explicit activation through governed tool invocations. Both tools SHALL route through the runtime-injected `SkillSystem` rather than reaching into any private registry.

核心 coding tools 必须暴露 `core.skill.list` 与 `core.skill.activate`,使 agent 能通过受治理的 tool invocation 发现已注册 skill 并触发显式激活。两个 tool 必须经由 runtime 注入的 `SkillSystem`,不得访问任何私有注册表。

#### Scenario: skill.list enumerates registered skills without activation / skill.list 枚举不激活

- **WHEN** `core.skill.list` is invoked
- **THEN** the tool calls `deps.skills.listSummaries()`, returns the count and per-skill `{id, name, version, trust, loadingState}` summaries, and does not trigger any activation side effect
- **中文** 当 `core.skill.list` 被调用时,tool 必须调用 `deps.skills.listSummaries()`,返回数量与每个 skill 的 `{id, name, version, trust, loadingState}` summary,且不触发任何激活副作用。

#### Scenario: skill.activate performs explicit activation and returns a compact result / skill.activate 执行显式激活并返回紧凑结果

- **WHEN** `core.skill.activate` is invoked with `name`
- **THEN** the tool calls `deps.skills.activateSkill({name, trigger: "explicit", context, sessionId})` and returns `{status, name, segmentCount, loadingState, estimatedTokens}`,omitting the full segment text to bound token footprint
- **中文** 当 `core.skill.activate` 被调用并带 `name` 时,tool 必须调用 `deps.skills.activateSkill({name, trigger: "explicit", context, sessionId})`,返回 `{status, name, segmentCount, loadingState, estimatedTokens}`,不得包含 segment 完整文本,以限制 token 占用。

#### Scenario: skill tools fail closed without SkillSystem / 无 SkillSystem 时 tool 安全失败

- **WHEN** either `core.skill.list` or `core.skill.activate` is invoked while `deps.skills` is undefined
- **THEN** the tool returns a typed `SKILL_SYSTEM_UNAVAILABLE` diagnostic and does not throw
- **中文** 当 `deps.skills` 未定义时,`core.skill.list` 或 `core.skill.activate` 必须返回 typed `SKILL_SYSTEM_UNAVAILABLE` diagnostic,不得抛错。

### Requirement: Core Tools Map Into Catalog Families / Core Tools 映射到 Catalog Families
Built-in core coding tools SHALL map each existing core capability id to one or more canonical tool families without removing absent catalog families from the denominator.

内置 core coding tools 必须把每个现有 core capability id 映射到一个或多个 canonical tool families，且不得从分母中移除缺失 catalog families。

#### Scenario: Existing shell tools map to process families / 现有 Shell 工具映射到 Process Families
- **WHEN** the catalog evaluates `core.shell.run`, `core.shell.output`, and `core.shell.kill`
- **THEN** they map to `shell.run`, `process.output`, and `process.kill` respectively
- **中文** 当 catalog 评估 `core.shell.run`、`core.shell.output` 与 `core.shell.kill` 时，它们必须分别映射到 `shell.run`、`process.output` 与 `process.kill`。

### Requirement: Built-In Tools Use Family-Owned Source Layout / 内置工具使用 Family-Owned 源码布局
Built-in core tool implementations SHALL live under `src/packages/core-coding-tools/src/families/<domain>/<family>/` and SHALL NOT keep implementation or compatibility shim directories under `src/packages/core-coding-tools/src/tools/`.

内置 core tool 实现必须位于 `src/packages/core-coding-tools/src/families/<domain>/<family>/`，不得在 `src/packages/core-coding-tools/src/tools/` 下保留实现或兼容 shim 目录。

#### Scenario: Old tools directory is absent / 旧 Tools 目录不存在
- **WHEN** repository structure checks inspect `src/packages/core-coding-tools/src`
- **THEN** no `tools/` implementation tree exists and model-visible built-in tool registration imports from `families/<domain>/<family>/`
- **中文** 当 repository structure checks 检查 `src/packages/core-coding-tools/src` 时，不得存在 `tools/` implementation tree，并且 model-visible built-in tool registration 必须从 `families/<domain>/<family>/` 导入。

### Requirement: Patch Family Is Separate From File Edit / Patch Family 独立于 File Edit
The `patch.apply` family SHALL require multi-hunk patch semantics, precondition validation, affected-file accounting, and rollback evidence; exact string edit or whole-file write alone SHALL NOT satisfy it.

`patch.apply` family 必须要求 multi-hunk patch semantics、precondition validation、affected-file accounting 与 rollback evidence；仅 exact string edit 或 whole-file write 不得满足它。

#### Scenario: Exact edit does not satisfy patch / 精确编辑不满足 Patch
- **WHEN** only `core.file.edit` exists and no patch capability exists
- **THEN** `file.edit` may pass but `patch.apply` remains absent or unassessed with zero score
- **中文** 当只存在 `core.file.edit` 而没有 patch capability 时，`file.edit` 可以通过，但 `patch.apply` 必须保持 absent 或 unassessed 且为零分。

### Requirement: Core Tool Absence Is Reported / Core Tool 缺口必须报告
Core coding tool diagnostics SHALL report catalog families that are not implemented by built-in tools, including browser, media, design, notebook/REPL, pipeline, and scheduling families.

core coding tool diagnostics 必须报告 built-in tools 尚未实现的 catalog families，包括 browser、media、design、notebook/REPL、pipeline 与 scheduling families。

#### Scenario: Missing design tool is visible / 缺失 Design Tool 可见
- **WHEN** no design/canvas capability is registered
- **THEN** diagnostics reports `design.document-state`, `design.node-query`, `design.batch-edit`, and `design.export-snapshot` as absent or planned
- **中文** 当没有注册 design/canvas capability 时，diagnostics 必须报告 `design.document-state`、`design.node-query`、`design.batch-edit` 与 `design.export-snapshot` 为 absent 或 planned。

#### Scenario: Missing family is not a fake tool / 缺失 Family 不是假工具
- **WHEN** a built-in family is planned but no executable capability exists
- **THEN** `core-coding-tools` keeps the family visible in diagnostics but does not add a placeholder entry under the family tool list
- **中文** 当某个 built-in family 已规划但没有可执行 capability 时，`core-coding-tools` 必须在 diagnostics 中保持该 family 可见，但不得在 family tool list 中添加占位条目。

### Requirement: Local Family Tools Are Concrete / 本地 Family 工具必须真实
Core coding tools SHALL implement all DeepSeek-owned local families with concrete executors, including `workspace.glob`, `asset.view-local`, `notebook.read`, `patch.apply`, `revert.undo`, `repl.execute`, `git.history-branch`, `package.manager`, and local wrappers for owner-package capabilities where appropriate.

core coding tools 必须用真实 executor 实现所有 DeepSeek-owned local families，包括 `workspace.glob`、`asset.view-local`、`notebook.read`、`patch.apply`、`revert.undo`、`repl.execute`、`git.history-branch`、`package.manager`，以及适当的 owner-package capability wrappers。

#### Scenario: Core catalog has no empty local implementation family / Core Catalog 无空本地实现 Family
- **WHEN** `coreToolManifests()` and the tool family catalog are loaded
- **THEN** every local built-in family owned by `core-coding-tools` has a capability id, executor, model-visible projection, and test evidence
- **中文** 当加载 `coreToolManifests()` 与 tool family catalog 时，每个由 `core-coding-tools` 拥有的本地 built-in family 必须拥有 capability id、executor、model-visible projection 与测试证据。

### Requirement: Patch Apply Is Multi-Hunk And Transactional / Patch Apply 支持 Multi-Hunk 与事务
The `patch.apply` capability SHALL apply unified multi-hunk patches with precondition validation, affected-file accounting, bounded diagnostics, and rollback or checkpoint evidence.

`patch.apply` capability 必须应用 unified multi-hunk patches，并包含 precondition validation、affected-file accounting、有界 diagnostics 与 rollback 或 checkpoint evidence。

#### Scenario: Failed patch does not mutate workspace / Patch 失败不修改 Workspace
- **WHEN** a patch hunk precondition fails
- **THEN** no target file is mutated and the result reports the failed hunk with bounded evidence
- **中文** 当 patch hunk 前置条件失败时，不得修改目标文件，并且结果必须用有界证据报告失败 hunk。

### Requirement: Local Asset And Notebook Output Is Bounded / 本地 Asset 与 Notebook 输出有界
Asset and notebook capabilities SHALL detect supported file types, bound previews, preserve binary safety, and redact unsafe metadata.

asset 与 notebook capabilities 必须识别支持的文件类型、限制 preview、保持 binary safety，并脱敏不安全 metadata。

#### Scenario: Large notebook is truncated safely / 大 Notebook 安全截断
- **WHEN** `notebook.read` reads a notebook exceeding output limits
- **THEN** it returns a cell summary with truncation metadata instead of unbounded cell content
- **中文** 当 `notebook.read` 读取超过输出限制的 notebook 时，它必须返回带截断元数据的 cell summary，而不是无界 cell content。

### Requirement: Shell And Test Tools Support Noninteractive Execution / Shell 与 Test 工具支持非交互执行

Shell/process, git-backed evidence, and test command tools SHALL support a governed noninteractive execution profile that prevents pagers, editors, credential prompts, and unbounded terminal state from blocking agent delivery.

shell/process、git-backed evidence 与 test command tools 必须支持受治理的 noninteractive execution profile，防止 pagers、editors、credential prompts 与无边界 terminal state 阻塞 agent delivery。

#### Scenario: Noninteractive command avoids pagers and prompts / 非交互命令避免 Pager 与 Prompt

- **WHEN** a process-like core tool executes with the noninteractive profile
- **THEN** the tool applies platform-appropriate environment policy such as disabling git pagers and credential prompts, bounding output, and marking terminal capabilities as noninteractive
- **AND** the result evidence records the effective profile without exposing secrets
- **中文** 当 process-like core tool 使用 noninteractive profile 执行时，工具必须应用平台适配的 environment policy，例如禁用 git pagers 与 credential prompts、限制输出并将 terminal capabilities 标记为 noninteractive；结果证据必须记录 effective profile 且不暴露 secrets。

#### Scenario: Interactive blocker becomes typed diagnostic / 交互阻塞变成类型化诊断

- **WHEN** a command appears to require a pager, editor, password prompt, TTY input, or other unsupported interactivity
- **THEN** the tool returns a typed diagnostic and bounded output evidence that can feed self-repair
- **中文** 当命令看起来需要 pager、editor、password prompt、TTY input 或其他不支持的交互时，工具必须返回 typed diagnostic 与有界 output evidence，并可进入 self-repair。

### Requirement: Data Artifact Semantics Are Verifiable / 数据产物语义可验证

Core coding tools and artifact checkers SHALL expose enough structured evidence for generated data artifacts to be checked for schema compliance, id/name semantics, referential integrity, and aggregate consistency when such expectations are available.

core coding tools 与 artifact checkers 必须为生成的数据产物暴露足够的结构化证据，以便在存在相关期望时检查 schema compliance、id/name semantics、referential integrity 与 aggregate consistency。

#### Scenario: JSON artifact checker reports semantic mismatch / JSON 产物检查报告语义不匹配

- **WHEN** a generated JSON artifact passes parse checks but violates discovered schema semantics, foreign-key expectations, or aggregate consistency
- **THEN** the checker returns a typed verification failure with bounded diagnostics for repair
- **中文** 当生成的 JSON artifact 通过 parse checks 但违反 discovered schema semantics、foreign-key expectations 或 aggregate consistency 时，checker 必须返回 typed verification failure 与有界 diagnostics 供修复使用。

### Requirement: Mutation Paths Preserve Literal Artifact Identity / Mutation Path 保留 Artifact 字面身份

Core coding tool preflight SHALL distinguish discovery path canonicalization from mutation/artifact path execution. Read, list, and search tools MAY use platform canonicalization to resolve existing files. Write, edit, and patch tools SHALL still use platform workspace resolution for safety, but SHALL preserve the model/user supplied literal relative path casing for executor input after rejecting unsafe syntax.

核心 coding tool preflight 必须区分 discovery path canonicalization 与 mutation/artifact path execution。read、list 与 search 工具可以使用平台 canonicalization 来解析既有文件。write、edit 与 patch 工具仍必须使用 platform workspace resolution 做安全检查，但在拒绝不安全语法后，executor input 必须保留模型/用户提供的字面相对路径大小写。

#### Scenario: Write path stays literal after safe platform resolution / 安全平台解析后写入路径保持字面值

- **WHEN** a model requests `core.file.write` with `path: "Docs/USAGE.md"` on a case-insensitive platform
- **AND** platform workspace resolution confirms the path is inside the governed workspace
- **THEN** preflight SHALL pass `Docs/USAGE.md` to the executor rather than lowercasing it
- **AND** read/search preflight MAY continue to return platform canonical paths for discovery.
- **中文** 当模型在大小写不敏感平台上以 `path: "Docs/USAGE.md"` 请求 `core.file.write`，且平台 workspace resolution 确认路径位于受治理 workspace 内时，preflight 必须把 `Docs/USAGE.md` 传给 executor，而不是转成小写；read/search preflight 仍可为 discovery 返回平台 canonical path。

### Requirement: Rejected Tool Feedback Is Corrective / 工具拒绝反馈必须可修正

Core coding tool preflight and execution diagnostics SHALL include enough provider-neutral feedback for the model to choose a valid next action when a rejection is retryable or recoverable.

核心 coding tool preflight 与 execution diagnostics 在拒绝可重试或可恢复请求时，必须包含足够的 provider-neutral feedback，帮助模型选择有效下一步。

#### Scenario: Rejection names the repair direction / 拒绝反馈说明修正方向

- **WHEN** a model tool call is rejected for unsafe path syntax, missing required input, policy denial, or unavailable platform capability
- **THEN** the tool feedback SHALL include the failing field, typed reason, and corrective direction such as using a workspace-relative path, supplying the missing field, choosing a projected tool, or reporting a bounded blocker.
- **中文** 当模型工具调用因 unsafe path syntax、缺少必填输入、policy denial 或平台能力不可用而被拒绝时，工具反馈必须包含失败字段、typed reason，以及修正方向，例如使用 workspace-relative path、补齐缺失字段、选择已投影工具，或报告有界 blocker。

