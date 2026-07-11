# Design: Engineering Intelligence Decision Loop

## Reference Pattern / 参考模式

Reference inspection shows a layered tool-decision architecture:

参考实现呈现的是分层工具决策架构：

1. **Tool pool assembly**: built-in tools, feature-gated tools, MCP tools, and special tools are assembled from the current environment.
2. **Projection filtering**: permission deny rules, simple/bare mode, REPL mode, agent type, and enabled checks remove tools before the model sees them.
3. **Model choice**: the model chooses from the projected tool pool.
4. **Runtime decision**: `canUseTool` / permission / preflight validates the concrete input, records denials, and may ask or reject.
5. **Tool feedback**: result messages, progress, diffs, denials, and summaries become context for the next decision.

1. **工具池组装**：从当前环境组装 built-in tools、feature-gated tools、MCP tools 与 special tools。
2. **投影过滤**：permission deny rules、simple/bare mode、REPL mode、agent type 与 enabled checks 在模型看到工具前先收窄。
3. **模型选择**：模型只从已投影工具池中选择。
4. **运行时决策**：`canUseTool` / permission / preflight 校验具体 input，记录拒绝，并可请求确认或拒绝。
5. **工具反馈**：result messages、progress、diffs、denials 与 summaries 进入下一步决策上下文。

## Target Architecture / 目标架构

DeepSeek CLI should keep the same ownership split:

DeepSeek CLI 应保持同样的责任拆分：

- **Capability registry owns availability**: what can exist.
- **Profile/stage projection owns visibility**: what the model can see now.
- **Model owns intent selection**: which visible tool to call and with what input.
- **Preflight/policy owns concrete safety**: whether this input may execute.
- **Runtime feedback owns learning signal**: what the model must change next.
- **Evaluation owns acceptance**: whether evidence is sufficient.

## Reference-Class Arsenal / 参考级弹药库

Tool completeness is a prerequisite for intelligence. The model cannot produce engineering behavior if it lacks the tools to inspect, mutate, verify, coordinate, browse, remember, and recover. Completeness means every family has a contract, executable implementation or explicitly unavailable adapter, projection metadata, preflight/policy handling, bounded feedback, and deterministic coverage.

工具完备是智能化前提。模型如果缺少 inspect、mutate、verify、coordinate、browse、remember 与 recover 的工具，就无法产生工程行为。完整度意味着每个工具族都有 contract、可执行实现或明确 unavailable adapter、projection metadata、preflight/policy 处理、有界反馈和确定性覆盖。

The reference tool inventory maps to DeepSeek tool families as follows:

参考工具清单映射到 DeepSeek 工具族如下：

| Reference capability | DeepSeek family target | Completeness expectation |
| --- | --- | --- |
| Agent / Team / Task tools | `agent.spawn`, `agent.message-continue`, `agent.wait-result`, `agent.stop-close`, task create/get/list/update/output | Spawn, continue, wait, stop, task-board state, and result packaging are executable and traceable. |
| Bash / PowerShell / process tools | `shell.run`, `process.output`, `process.kill`, `repl.execute` | POSIX and PowerShell semantics, read-only validation, process output/kill, timeout, evidence preservation. |
| File read/write/edit/notebook/glob/grep/sed | `file.read`, `file.write`, `file.edit`, `text.replace`, `notebook.read`, `workspace.glob`, `search.text` | Bounded read, exact edit, governed text replacement, literal artifact write, notebook read/edit path, glob/search options, image/local asset handling. |
| LSP and code intelligence | `search.symbol`, `code.diagnostics-lsp` | Symbol search, diagnostics, references/definitions where host support exists, unavailable diagnostics otherwise. |
| Git/build/package/test | `git.status-diff`, `git.history-branch`, `build.test-lint-typecheck`, `package.manager` | Status, diff, history/branch, focused tests, lint/typecheck/build commands, package manager operations. |
| Planning and user control | `plan.todo`, `mode.plan-auto-review`, `user.input`, `approval.permission` | Structured todo, plan/exit plan, user question, approval/permission lifecycle, no host-only hidden state. |
| Web/MCP/browser | `web.search`, `web.fetch`, `web.extract`, `mcp.*`, `browser.*` | Web search/fetch, MCP list/read/call/auth, browser navigate/interact/inspect/screenshot when connector exists. |
| Skills/plugins/commands/hooks | `skill.list-activate`, `hook.list-run`, `plugin.install-verify`, `command.palette-slash` | List/activate skills, hook projection/run evidence, plugin install/verify, command palette/slash projection. |
| Worktree/session/memory/compact | `worktree.environment`, `session.resume-fork`, `memory.read-write`, `compact.summary`, `context.project-index` | Worktree enter/exit, resume/fork, memory read/write, compaction summary, project context index. |
| Scheduling/remote/observability | `schedule.sleep-cron`, `remote.runtime`, `observability.trace-budget` | Sleep/cron/monitor equivalents, remote runtime binding, trace/budget inspection. |
| Media/design | `image.*`, `design.*`, local asset view | Image generate/edit/search/inspect and design document query/edit/export where providers are configured. |

| 参考能力 | DeepSeek 工具族目标 | 完整度要求 |
| --- | --- | --- |
| Agent / Team / Task 工具 | `agent.spawn`、`agent.message-continue`、`agent.wait-result`、`agent.stop-close`、task create/get/list/update/output | spawn、continue、wait、stop、task-board state 与 result packaging 必须可执行、可追踪。 |
| Bash / PowerShell / process 工具 | `shell.run`、`process.output`、`process.kill`、`repl.execute` | POSIX 与 PowerShell 语义、read-only validation、process output/kill、timeout、证据保留。 |
| File read/write/edit/notebook/glob/grep/sed | `file.read`、`file.write`、`file.edit`、`text.replace`、`notebook.read`、`workspace.glob`、`search.text` | 有界读取、精确编辑、受治理文本替换、字面 artifact 写入、notebook read/edit path、glob/search 选项、图片/本地 asset 处理。 |
| LSP 与代码智能 | `search.symbol`、`code.diagnostics-lsp` | host 支持时提供 symbol search、diagnostics、references/definitions；否则返回 unavailable diagnostics。 |
| Git/build/package/test | `git.status-diff`、`git.history-branch`、`build.test-lint-typecheck`、`package.manager` | status、diff、history/branch、focused tests、lint/typecheck/build 命令、包管理操作。 |
| Planning 与用户控制 | `plan.todo`、`mode.plan-auto-review`、`user.input`、`approval.permission` | 结构化 todo、plan/exit plan、用户问题、approval/permission 生命周期，不依赖隐藏 host 状态。 |
| Web/MCP/browser | `web.search`、`web.fetch`、`web.extract`、`mcp.*`、`browser.*` | web search/fetch、MCP list/read/call/auth、connector 存在时 browser navigate/interact/inspect/screenshot。 |
| Skills/plugins/commands/hooks | `skill.list-activate`、`hook.list-run`、`plugin.install-verify`、`command.palette-slash` | skill list/activate、hook projection/run evidence、plugin install/verify、command palette/slash projection。 |
| Worktree/session/memory/compact | `worktree.environment`、`session.resume-fork`、`memory.read-write`、`compact.summary`、`context.project-index` | worktree enter/exit、resume/fork、memory read/write、压缩摘要、项目上下文索引。 |
| Scheduling/remote/observability | `schedule.sleep-cron`、`remote.runtime`、`observability.trace-budget` | sleep/cron/monitor 等价能力、remote runtime binding、trace/budget inspection。 |
| Media/design | `image.*`、`design.*`、local asset view | provider 配置后支持 image generate/edit/search/inspect 与 design document query/edit/export。 |

## Decision Board / 决策看板

Each agent turn should emit a replayable decision board:

每个 agent turn 应输出可 replay 的决策看板：

- projected tools: id, family, side effect, stage fit, policy state, visibility reason;
- hidden tools: id, family, hidden reason, user-visible safe summary;
- tool intents: raw name/input, normalized capability id, provider alias repairs;
- preflight decisions: accepted, repaired, rejected, diagnostics, corrective action;
- execution results: status, bounded preview, evidence refs, follow-up recommendation;
- decision metrics: repeated failure count, same-input retry count, next-action compliance, stage progress.

## Stage-Aware Projection / 阶段感知投影

Profiles define stages and stage tool families. The projection should not merely say "read-write"; it should state why the active stage exposes read/search, mutation, verification, artifact, or terminal runner tools. If a model asks for a hidden tool, the feedback should say whether the issue is wrong stage, missing capability, policy denial, or platform unavailability.

Profile 定义阶段和阶段工具族。投影不应只说 “read-write”；它应说明当前阶段为什么暴露 read/search、mutation、verification、artifact 或 terminal runner 工具。如果模型请求隐藏工具，反馈应说明问题是阶段不符、能力缺失、policy denial，还是平台不可用。

## Engineering Profiles / 工程 Profile

Reusable profiles should be workflow contracts, not code branches:

可复用 profile 应是 workflow contract，而不是代码分支：

- `software-engineer`: understand -> plan -> change -> verify -> report.
- `product-manager`: clarify -> scope -> prioritize -> spec -> acceptance.
- `design-master`: inspect -> concept -> produce -> visual-verify -> package.

The first implementation should land `software-engineer` only, because it exercises the existing coding tool families and live capability matrix.

第一阶段只落地 `software-engineer`，因为它能覆盖现有 coding tool families 与 live capability matrix。

## Intelligence Metrics / 智能化指标

The system should measure not only pass/fail, but whether the model improved after feedback:

系统不仅要衡量 pass/fail，还要衡量模型收到反馈后是否改进：

- Did the model choose a projected tool?
- Did preflight need repair?
- Did the model repeat a rejected tool/input?
- Did it follow corrective feedback?
- Did each stage produce required evidence before moving on?
- Was a failure attributable to missing tools, bad projection, unsafe input, weak model planning, or insufficient feedback?
