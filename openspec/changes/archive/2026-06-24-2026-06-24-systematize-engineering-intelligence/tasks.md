# Tasks

## OpenSpec / 规格

- [x] Create this OpenSpec change for systemic engineering intelligence.
- [x] Record reference-derived tool decision architecture without copying code.
- [x] Define decision board, stage-aware projection, corrective feedback, and reusable profile boundaries.
- [x] Validate this change with `npx openspec validate 2026-06-24-systematize-engineering-intelligence --strict`.
- [x] Validate canonical specs with `npx openspec validate --specs --strict`.

- [x] 创建 systemic engineering intelligence OpenSpec change。
- [x] 记录参考抽象出的工具决策架构，不复制代码。
- [x] 定义 decision board、stage-aware projection、corrective feedback 与 reusable profile 边界。
- [x] 使用 `npx openspec validate 2026-06-24-systematize-engineering-intelligence --strict` 校验本 change。
- [x] 使用 `npx openspec validate --specs --strict` 校验 canonical specs。

## Contracts / 契约

- [x] Add `ToolDecisionRecord`, `ToolProjectionDecision`, and `ToolDecisionBoard` contracts under platform contracts.
- [x] Extend tool feedback with provider-neutral `correctiveAction` / `recommendedNextAction` metadata.
- [x] Add stage projection evidence fields for visible, hidden, denied, and unavailable tool reasons.
- [x] Keep contracts host-agnostic and implementation-free.

- [x] 在 platform contracts 中增加 `ToolDecisionRecord`、`ToolProjectionDecision` 与 `ToolDecisionBoard`。
- [x] 为 tool feedback 增加 provider-neutral `correctiveAction` / `recommendedNextAction` metadata。
- [x] 为 stage projection evidence 增加 visible、hidden、denied 与 unavailable tool reasons。
- [x] 保持 contracts host-agnostic 且不包含实现。

## Full Tool Arsenal / 完整工具弹药库

- [x] Produce a reference-to-DeepSeek tool matrix covering every reference tool, its target DeepSeek family, implementation owner, projection policy, and verification command.
- [x] Mark each tool family as one of `executable`, `adapter-unavailable-with-diagnostics`, or `not-yet-implemented`; do not count catalog entries alone as complete.
- [x] Implement or harden workspace I/O: file read, file list, glob, text search, local asset/image view, notebook read/edit.
- [x] Implement core code diagnostics over `CodeIntelligenceService`, with unavailable diagnostics, unit coverage, and reference arsenal completion state.
- [x] Implement or harden mutation tools: literal file write, exact edit, patch apply, revert/undo, checkpoint evidence.
- [x] Verify mutation tools with deterministic coverage for file write validation, exact edit transactions, semantic copy/move/delete/create/touch, JSON patch, archives, multi-hunk patch apply, dry-run undo, stale undo rejection, path escape rejection, and replay-safe checkpoint evidence.
- [x] Implement or harden shell/process tools: POSIX shell, PowerShell profile, process output, process kill, REPL execute, read-only validation, evidence-destruction rejection.
- [x] Verify PowerShell execution through the generic `shell.run` profile path, with unit coverage and reference arsenal completion state.
- [x] Verify background `shell.output` and `shell.kill` through deterministic contract tests, including fail-closed behavior without background task support.
- [x] Implement or harden git/build tools: status, diff, history/branch, focused test, lint/typecheck/build runner, package manager, environment prepare.
- [x] Verify core git/build execution with deterministic coverage for `git.status`, `git.diff`, `git.history-branch`, `test.run`, and `package.manager`.
- [x] Keep `core.env.prepare` host-bound in the CLI adapter, with tests proving agent-visible registration, dry-run default behavior, secret redaction, JSONL diagnostics, and rejection of arbitrary positional input.
- [ ] Implement or harden planning/control tools: todo, plan enter/exit, approval permission, user question, mode review.
- [x] Implement core user input with interactive-host adapter execution and headless unavailable diagnostics, plus unit coverage and reference arsenal completion state.
- [x] Implement core plan enter/exit tools with session-scoped evidence, plus unit coverage and reference arsenal completion states.
- [x] Implement or harden agents/tasks tools: spawn, continue/message, wait result, stop, task create/get/list/update/output, team coordination equivalents.
- [x] Implement deterministic session task-board tools for task create/get/list/update/output with unit coverage and reference arsenal completion states.
- [x] Implement team create/delete tools as orchestration wrappers over AgentSpawner with unit coverage and reference arsenal completion states.
- [x] Implement governed worktree enter/exit tools over workspace-state-management with unit coverage and reference arsenal completion states.
- [x] Implement notebook edit with workspace checkpoint evidence and reference arsenal completion state.
- [ ] Implement or harden web/MCP/browser tools: web search/fetch/extract, MCP list/read/call/auth, browser navigate/interact/inspect/screenshot.
- [x] Verify core `web.fetch` and `web.search` with deterministic contract coverage for local HTTP fetch, URL rejection, injected providers, unavailable diagnostics, and domain filtering.
- [x] Implement MCP tool call, MCP resource list, and MCP resource read facades over injected `McpGateway`, with unit coverage and reference arsenal completion states.
- [x] Implement or harden extension tools: skill list/activate, hook list/run, plugin install/verify, command palette/slash projection.
- [x] Add deterministic unit coverage for core `skill.list` and `skill.activate` over injected `SkillSystem`, including unavailable diagnostics and not-found activation.
- [x] Add deterministic unit coverage for core `hook.list` over injected `HookSystem.listHooks`, including lifecycle point filtering and unavailable diagnostics.
- [x] Add governed core `hook.run` facade over injected `HookSystem.invokeHooks`, with unavailable diagnostics and unit coverage.
- [x] Add governed core `plugin.install` and `plugin.verify` facades over injected `PluginManager`, with integrity rejection, lockfile evidence, unavailable diagnostics, semantic aliases, and unit coverage.
- [x] Add governed core `command.palette` projection over injected `CommandSystem.help`, with unavailable diagnostics, slash-command metadata, semantic alias, and unit coverage.
- [x] Implement core config inspect/get/set over injected `ConfigStore`, plus unit coverage and reference arsenal completion state.
- [ ] Implement or harden memory/session/worktree tools: memory read/write, context project index, compact summary, resume/fork, worktree enter/exit.
- [ ] Implement or harden scheduling/remote/observability tools: sleep/cron/monitor equivalents, remote runtime, trace and budget inspection.
- [x] Implement remote runtime trigger bind/reconnect/cancel facade over injected `RemoteRuntimeConnectivity`, with unit coverage and reference arsenal completion state.
- [x] Implement deterministic tool search over model-visible capability registry with unit coverage and reference arsenal completion state.
- [x] Implement deterministic schedule run/list/cancel facade over `ConcurrencyOrchestrator` with unit coverage and reference arsenal completion state.
- [x] Implement brief packaging and synthetic output artifact tools with unit coverage and reference arsenal completion states.
- [x] Implement governed core `session.resume` and `session.fork` facades over injected `SessionStore`, with unavailable diagnostics, semantic aliases, and unit coverage.
- [x] Implement governed core `memory.write` and `memory.read` facades over injected `MemoryManager`, with scoped session evidence, redaction, semantic aliases, and unit coverage.
- [x] Implement governed core `compact.summary` facade over deterministic compact summary creation, with bounded redacted evidence, semantic alias, and unit coverage.
- [x] Clear all `not-yet-implemented` reference arsenal entries; remaining blockers are adapter/host connector diagnostics.
- [x] Raise reference arsenal executable coverage to 37/38; remaining blocker is the explicit MCP credential/auth connector flow.
- [ ] Implement or harden media/design tools where providers exist: image generate/edit/search/inspect, design document state/query/batch edit/export.
- [x] Add deterministic contract tests for the reference-to-DeepSeek arsenal matrix and completion-state report.
- [x] Project reference-tool arsenal blockers into CLI delivery capability diagnostics so unfinished tools are visible before live evaluation.
- [x] Add cross-platform semantic tool aliases for common model-facing names (`Read`, `Grep`, `Glob`, `Edit`, `Write`) while keeping execution routed through governed core capabilities.
- [x] Extend provider semantic aliases for reference-style core tool names across process, git/build, planning, web, agent/task, extension, MCP, worktree, remote, artifact, diagnostics, and notebook families.
- [x] Add prompt projection guidance that prefers semantic workspace tools over platform shell habits such as `sed`, `cp`, `mv`, `rm`, `cat`, and shell redirection.
- [x] Add governed cross-platform `text.replace` with dry-run and checkpoint evidence so `sed`-class substitutions do not depend on platform shell commands.
- [x] Add governed cross-platform `file.copy`, `file.move`, and `file.delete` tools so models do not need to choose platform-specific `cp`, `mv`, or `rm` commands.
- [x] Reject common shell workspace mutation habits (`cp`, `mv`, `rm`, `sed -i`, redirection, and platform equivalents) with corrective semantic-tool metadata.
- [x] Add governed `directory.create` and `file.touch` semantic tools, and reject `mkdir` / `touch` shell habits with semantic-tool guidance.
- [x] Add governed read-only `file.stat`, `json.read`, `checksum.hash`, and `path.resolve` semantic tools so metadata, structured JSON reads, digests, and path normalization do not depend on platform shell commands.
- [x] Add governed `json.patch` semantic mutation with checkpoint evidence so structured JSON edits do not depend on `sed`, `jq`, or ad hoc scripts.
- [x] Extend shell corrective feedback for `jq`, checksum commands, and platform path-resolution commands toward semantic tools.
- [x] Add governed `env.inspect` and `command.lookup` tools so environment and command availability checks do not depend on `env`, `printenv`, `which`, `where`, or `Get-Command` shell habits.
- [x] Add governed deterministic archive baseline tools `archive.create` and `archive.extract`, and route `tar` / `zip` / `unzip` shell habits toward semantic archive operations.
- [ ] Add deterministic contract tests for every executable tool family and live smoke tests for every tool family with available providers/connectors.
- [x] Add capability-matrix reporting that fails a profile when any required arsenal family is missing, hidden without reason, or non-executable.

- [x] 产出 reference-to-DeepSeek 工具矩阵，覆盖每个参考工具、目标 DeepSeek 工具族、实现 owner、投影策略与验证命令。
- [x] 将每个工具族标记为 `executable`、`adapter-unavailable-with-diagnostics` 或 `not-yet-implemented`；不得把 catalog entry 本身视为完成。
- [x] 实现或加固 workspace I/O：file read、file list、glob、text search、本地 asset/image view、notebook read/edit。
- [x] 基于 `CodeIntelligenceService` 实现 core code diagnostics，包含 unavailable diagnostics、单元测试与 reference arsenal 完成状态。
- [x] 实现或加固 mutation 工具：字面 file write、exact edit、patch apply、revert/undo、checkpoint evidence。
- [x] 用确定性覆盖验证 mutation 工具：file write validation、exact edit transaction、语义 copy/move/delete/create/touch、JSON patch、archive、多 hunk patch apply、dry-run undo、stale undo rejection、path escape rejection 与 replay-safe checkpoint evidence。
- [x] 实现或加固 shell/process 工具：POSIX shell、PowerShell profile、process output、process kill、REPL execute、read-only validation、evidence-destruction rejection。
- [x] 验证 PowerShell 通过通用 `shell.run` profile 路径执行，并补充单元测试与 reference arsenal 完成状态。
- [x] 通过确定性 contract tests 验证 background `shell.output` 与 `shell.kill`，包含缺少 background task 支持时的 fail-closed 行为。
- [x] 实现或加固 git/build 工具：status、diff、history/branch、focused test、lint/typecheck/build runner、package manager、environment prepare。
- [x] 用确定性覆盖验证 core git/build 执行：`git.status`、`git.diff`、`git.history-branch`、`test.run` 与 `package.manager`。
- [x] 保持 `core.env.prepare` 位于 CLI adapter host 边界，并用测试证明 agent-visible registration、默认 dry-run、secret redaction、JSONL diagnostics 与拒绝任意 positional input。
- [ ] 实现或加固 planning/control 工具：todo、plan enter/exit、approval permission、user question、mode review。
- [x] 实现 core user input：支持 interactive-host adapter 执行与 headless unavailable diagnostics，并补充单元测试与 reference arsenal 完成状态。
- [x] 实现 core plan enter/exit 工具：记录 session-scoped evidence，并补充单元测试与 reference arsenal 完成状态。
- [x] 实现或加固 agents/tasks 工具：spawn、continue/message、wait result、stop、task create/get/list/update/output、team coordination equivalents。
- [x] 实现 deterministic session task-board 工具：task create/get/list/update/output，并补充单元测试与 reference arsenal 完成状态。
- [x] 将 team create/delete 实现为 AgentSpawner 上的 orchestration wrapper，并补充单元测试与 reference arsenal 完成状态。
- [x] 基于 workspace-state-management 实现 governed worktree enter/exit，并补充单元测试与 reference arsenal 完成状态。
- [x] 实现 notebook edit，包含 workspace checkpoint evidence 与 reference arsenal 完成状态。
- [ ] 实现或加固 web/MCP/browser 工具：web search/fetch/extract、MCP list/read/call/auth、browser navigate/interact/inspect/screenshot。
- [x] 验证 core `web.fetch` 与 `web.search`：包含本地 HTTP fetch、URL rejection、注入 provider、unavailable diagnostics 与 domain filtering 的确定性 contract 覆盖。
- [x] 基于注入的 `McpGateway` 实现 MCP tool call、MCP resource list 与 MCP resource read facade，并补充单元测试与 reference arsenal 完成状态。
- [x] 实现或加固 extension 工具：skill list/activate、hook list/run、plugin install/verify、command palette/slash projection。
- [x] 为 core `skill.list` 与 `skill.activate` 增加确定性单元覆盖：基于注入的 `SkillSystem`，包含 unavailable diagnostics 与 not-found activation。
- [x] 为 core `hook.list` 增加确定性单元覆盖：基于注入的 `HookSystem.listHooks`，包含 lifecycle point filtering 与 unavailable diagnostics。
- [x] 增加受治理的 core `hook.run` facade：基于注入的 `HookSystem.invokeHooks`，包含 unavailable diagnostics 与单元测试。
- [x] 增加受治理的 core `plugin.install` 与 `plugin.verify` facade：基于注入的 `PluginManager`，包含 integrity rejection、lockfile evidence、unavailable diagnostics、语义别名与单元测试。
- [x] 增加受治理的 core `command.palette` 投影：基于注入的 `CommandSystem.help`，包含 unavailable diagnostics、slash-command metadata、语义别名与单元测试。
- [x] 基于注入的 `ConfigStore` 实现 core config inspect/get/set，并补充单元测试与 reference arsenal 完成状态。
- [ ] 实现或加固 memory/session/worktree 工具：memory read/write、context project index、compact summary、resume/fork、worktree enter/exit。
- [ ] 实现或加固 scheduling/remote/observability 工具：sleep/cron/monitor 等价能力、remote runtime、trace 与 budget inspection。
- [x] 基于注入的 `RemoteRuntimeConnectivity` 实现 remote runtime trigger bind/reconnect/cancel facade，并补充单元测试与 reference arsenal 完成状态。
- [x] 基于 model-visible capability registry 实现 deterministic tool search，并补充单元测试与 reference arsenal 完成状态。
- [x] 基于 `ConcurrencyOrchestrator` 实现 deterministic schedule run/list/cancel facade，并补充单元测试与 reference arsenal 完成状态。
- [x] 实现 brief packaging 与 synthetic output artifact 工具，并补充单元测试与 reference arsenal 完成状态。
- [x] 基于注入的 `SessionStore` 实现受治理的 core `session.resume` 与 `session.fork` facade，包含 unavailable diagnostics、语义别名与单元测试。
- [x] 基于注入的 `MemoryManager` 实现受治理的 core `memory.write` 与 `memory.read` facade，包含 scoped session evidence、redaction、语义别名与单元测试。
- [x] 基于确定性 compact summary 创建实现受治理的 core `compact.summary` facade，包含有界脱敏 evidence、语义别名与单元测试。
- [x] 清空所有 `not-yet-implemented` reference arsenal 项；剩余 blocker 均为 adapter/host connector diagnostics。
- [x] 将 reference arsenal executable coverage 提升到 37/38；剩余 blocker 为显式 MCP credential/auth connector flow。
- [ ] provider 存在时实现或加固 media/design 工具：image generate/edit/search/inspect、design document state/query/batch edit/export。
- [x] 为 reference-to-DeepSeek 弹药库矩阵和完成状态报告增加确定性 contract tests。
- [x] 将 reference-tool 弹药库阻塞项投影到 CLI delivery capability diagnostics，使未完成工具在 live evaluation 前可见。
- [x] 为常见模型可见名称（`Read`、`Grep`、`Glob`、`Edit`、`Write`）增加跨平台语义工具别名，同时执行仍路由到受治理的 core capability。
- [x] 扩展 provider 语义别名：覆盖 process、git/build、planning、web、agent/task、extension、MCP、worktree、remote、artifact、diagnostics 与 notebook 等 reference-style core tool 名称。
- [x] 增加 prompt projection guidance：优先使用语义 workspace 工具，而不是 `sed`、`cp`、`mv`、`rm`、`cat` 与 shell redirection 等平台 shell 习惯。
- [x] 增加受治理的跨平台 `text.replace`，包含 dry-run 与 checkpoint evidence，使 `sed` 类替换不依赖平台 shell 命令。
- [x] 增加受治理的跨平台 `file.copy`、`file.move` 与 `file.delete` 工具，使模型不需要选择平台特定的 `cp`、`mv` 或 `rm` 命令。
- [x] 对常见 shell workspace mutation 习惯（`cp`、`mv`、`rm`、`sed -i`、重定向及平台等价命令）返回拒绝，并携带可恢复的语义工具 metadata。
- [x] 增加受治理的 `directory.create` 与 `file.touch` 语义工具，并对 `mkdir` / `touch` shell 习惯返回语义工具引导。
- [x] 增加受治理的只读 `file.stat`、`json.read`、`checksum.hash` 与 `path.resolve` 语义工具，使 metadata、结构化 JSON 读取、摘要计算与路径归一化不依赖平台 shell 命令。
- [x] 增加受治理的 `json.patch` 语义 mutation，并携带 checkpoint evidence，使结构化 JSON 编辑不依赖 `sed`、`jq` 或临时脚本。
- [x] 扩展 shell corrective feedback：将 `jq`、checksum 命令与平台路径解析命令引导到语义工具。
- [x] 增加受治理的 `env.inspect` 与 `command.lookup` 工具，使环境与命令可用性检查不依赖 `env`、`printenv`、`which`、`where` 或 `Get-Command` shell 习惯。
- [x] 增加受治理的 deterministic archive baseline 工具 `archive.create` 与 `archive.extract`，并将 `tar` / `zip` / `unzip` shell 习惯引导到语义归档操作。
- [ ] 为每个可执行工具族增加确定性 contract tests，并为 provider/connector 可用的工具族增加 live smoke tests。
- [x] 为 capability-matrix 增加报告：任一 profile 必需工具族缺失、无理由隐藏或不可执行时失败。

## Runtime / 运行时

- [x] Emit a decision board snapshot before each model request.
- [x] Record every model tool intent, preflight repair/rejection, policy denial, execution result, and follow-up recommendation into the board.
  - Current evidence covers model intents, preflight rejections, kernel policy denials, execution success/failure, repeated rejection suppression, and runtime rejection branches routed through the shared board writer.
- [x] Suppress repeated identical rejected calls after the configured threshold and return a bounded blocker instruction.
- [x] Feed the latest board summary into dynamic prompt state without polluting stable provider prefix cache.

- [x] 每次模型请求前发出 decision board snapshot。
- [x] 将每个 model tool intent、preflight repair/rejection、policy denial、execution result 与 follow-up recommendation 记录到 board。
  - 当前证据已覆盖 model intent、preflight rejection、kernel policy denial、execution success/failure、repeated rejection suppression，并将 runtime rejection 分支统一接入 shared board writer。
- [x] 对重复的相同 rejected call 达到阈值后进行抑制，并返回有界 blocker 指令。
- [x] 将最新 board summary 注入 dynamic prompt state，且不污染稳定 provider prefix cache。

## Profiles / Profile

- [x] Define `software-engineer` as a reusable staged workflow contract: understand, plan, change, verify, report.
- [x] Require each stage to declare success criteria, allowed tool families, required evidence refs, and fallback blocker criteria.
- [ ] Do not add product/design profiles until the engineering profile passes deterministic and live matrix checks.

- [x] 将 `software-engineer` 定义为可复用 staged workflow contract：understand、plan、change、verify、report。
- [x] 要求每个 stage 声明 success criteria、allowed tool families、required evidence refs 与 fallback blocker criteria。
- [ ] 在 engineering profile 通过 deterministic 与 live matrix 检查前，不增加 product/design profiles。

## Evaluation / 评估

- [x] Add deterministic tests proving tool projection explains visible and hidden tools for a stage.
- [x] Add tests proving rejected tool feedback includes corrective next action.
- [x] Add tests proving repeated identical rejected tool calls are classified as decision-loop failure.
- [x] Add capability-matrix reporting for decision quality metrics.
- [x] Run focused tests, `npm run typecheck`, `npm run lint`, `node scripts/check-boundaries.mjs`, and OpenSpec validation.

- [x] 增加确定性测试，证明工具投影会解释某阶段可见和隐藏工具。
- [x] 增加测试，证明 rejected tool feedback 包含 corrective next action。
- [x] 增加测试，证明重复相同 rejected tool call 会归类为 decision-loop failure。
- [x] 为 capability-matrix 报告增加 decision quality metrics。
- [x] 运行 focused tests、`npm run typecheck`、`npm run lint`、`node scripts/check-boundaries.mjs` 与 OpenSpec validation。
