# Design: Close Codex-Class Capability Gap

## Current Diagnosis / 当前诊断

The main gap is not yet proven to be the model. Live traces show:

- T01 read-only analysis works with a small read/search/glob tool set.
- T02 selects an engineering profile but reports required write families as unregistered or unprojected.
- T02 and T05 disposable workspace runs can lose provider readiness because isolated fixtures do not reliably resolve user/global credentials.
- Therefore write-capable failures are currently blocked by CLI capability projection and environment readiness before model reasoning can be isolated.

主要差距尚不能证明是模型问题。live trace 显示：

- T01 只读分析可以用小型 read/search/glob 工具集工作。
- T02 选中了 engineering profile，但所需写入 family 被报告为未注册或未投影。
- T02 与 T05 disposable workspace run 可能因为隔离 fixture 无法可靠解析 user/global credentials 而失去 provider readiness。
- 因此可写任务失败目前先被 CLI capability projection 与环境就绪问题阻塞，尚未进入可隔离判断模型推理的阶段。

## Codex-Class Gap Dimensions / Codex-Class 差距维度

| Dimension | Codex-class target | Current DeepSeek CLI gap | Required closure |
| --- | --- | --- | --- |
| Tool surface | Read, edit, patch, shell, test, git, browser/artifact, MCP/plugin, package, docs/CI connectors | Read-only loop works; mutation and verification tools are absent or unprojected in live engineering stage | Implement concrete executors and model-visible projections by family |
| Projection | Task/profile/stage compiles exact allowed tools | Profile selection can succeed while required tools remain invisible | Add capability/affordance compiler and fail-closed preflight |
| Task closure | Success requires artifacts, diffs, tests, evidence, and terminal state | Some paths can over-credit final text or incomplete evidence | Gate every stage and final outcome on evidence |
| Isolation | Disposable workspaces keep credentials usable without secret copying | Isolated live runs can become `PROVIDER_CREDENTIAL_MISSING` | Add user/global credential fallback with redacted evidence |
| Recovery | Tool failures feed back into bounded repair behavior | Recovery cannot be judged when core tools are missing | Record repeated failures, retries, alternatives, and terminal blockers |
| Session step board | Every run can be reviewed as ordered execution steps | Raw session events are hard to inspect during continuous repair | Project persisted session events into a user-visible board without changing execution |

| 维度 | Codex-class 目标 | 当前 DeepSeek CLI 差距 | 必须补齐 |
| --- | --- | --- | --- |
| 工具面 | read、edit、patch、shell、test、git、browser/artifact、MCP/plugin、package、docs/CI connectors | 只读循环可用；mutation 与 verification tools 在 live engineering stage 缺失或未投影 | 按 family 实现真实 executor 与 model-visible projection |
| 投影 | task/profile/stage 编译精确 allowed tools | profile selection 成功时 required tools 仍可能不可见 | 增加 capability/affordance compiler 和 fail-closed preflight |
| 任务闭环 | 成功要求 artifacts、diffs、tests、evidence 与 terminal state | 部分路径可能对 final text 或不完整 evidence 过度给分 | 每个 stage 与最终结果都以 evidence gate 验收 |
| 隔离 | disposable workspace 可使用凭据但不复制 secret | 隔离 live run 可能变成 `PROVIDER_CREDENTIAL_MISSING` | 增加 user/global credential fallback 与脱敏证据 |
| 恢复 | 工具失败会反馈给有界修复行为 | 核心工具缺失时无法判断恢复能力 | 记录重复失败、重试、替代动作和终态 blocker |
| Session step board | 每次运行都可以按有序执行步骤复盘 | raw session events 在连续修复时难以查看 | 将已持久化 session events 投影成用户可见看板，不改变执行流程 |

## Tool Tiers / 工具层级

Tier 0 core read tools:

- `core.file.read`
- `core.file.list`
- `core.search.text`
- `core.workspace.glob`
- `core.git.diff` in read-only mode

Tier 1 engineering closure tools:

- `core.file.write`
- `core.file.edit`
- `core.patch.apply`
- `core.shell.run`
- `core.test.run`
- `core.git.status`
- `core.git.diff`

Projection boundary: Tier 1 registration does not mean every Tier 1 tool is model-visible under default `read-write`.
Default `read-write` may expose file mutation and governed process capabilities such as `core.test.run`,
evaluation runners, and environment preparation. Arbitrary shell execution (`core.shell.run`) requires explicit `all`
projection, a governed shell profile, or an active workflow gate that narrows the command class.

Tier 2 production workflow tools:

- package manager execution through governed shell profiles
- browser inspect/screenshot for local web artifacts
- artifact routing and manifest writing
- docker/process inspection where host policy allows it
- MCP/skill/plugin invocation through governed adapters

Tier 3 ecosystem connectors:

- issue/PR/CI/release connectors
- documentation and knowledge-base connectors
- drive/base/sheets/slides or equivalent business workflow connectors

Tier 0 核心只读工具：

- `core.file.read`
- `core.file.list`
- `core.search.text`
- `core.workspace.glob`
- `core.git.diff` 只读模式

Tier 1 工程闭环工具：

- `core.file.write`
- `core.file.edit`
- `core.patch.apply`
- `core.shell.run`
- `core.test.run`
- `core.git.status`
- `core.git.diff`

投影边界：Tier 1 注册不等于所有 Tier 1 工具都会在默认 `read-write` 下对模型可见。
默认 `read-write` 可以暴露文件 mutation 与受治理 process capability，例如 `core.test.run`、
evaluation runner 与 environment preparation。任意 shell 执行（`core.shell.run`）必须依赖显式 `all`
projection、受治理 shell profile，或能收窄命令类别的 active workflow gate。

Tier 2 生产工作流工具：

- 通过受治理 shell profile 执行 package manager
- 对本地 Web artifact 执行 browser inspect/screenshot
- artifact routing 与 manifest 写入
- 在 host policy 允许时执行 docker/process inspection
- 通过受治理 adapter 调用 MCP/skill/plugin

Tier 3 生态连接器：

- issue/PR/CI/release connectors
- documentation 与 knowledge-base connectors
- drive/base/sheets/slides 或等价业务工作流 connectors

## Capability/Affordance Compiler / 能力编译器

Profiles must declare required capability families and optional families, not hand-maintained raw tool lists. Stage compilation resolves those families against the host registry, policy, sandbox, credential state, and task risk. The compiled result becomes the only model-visible tool set for the stage.

profile 必须声明 required capability families 与 optional families，而不是维护手写 raw tool lists。stage compilation 根据 host registry、policy、sandbox、credential state 与 task risk 解析这些 families。编译结果成为该 stage 唯一的 model-visible tool set。

Compilation outcomes:

- `ready`: all required families have executable tools and model-visible schemas.
- `degraded`: required families are present, but optional families are unavailable with diagnostics.
- `blocked-by-cli-capability-gap`: required families have no executable implementation.
- `blocked-by-cli-bug`: required families exist but cannot be projected, invoked, or validated.
- `invalid-test-environment`: credentials, sandbox, dependency, or workspace setup prevents execution.

编译结果：

- `ready`：所有 required families 都有 executable tools 与 model-visible schemas。
- `degraded`：required families 存在，但 optional families 不可用并带 diagnostics。
- `blocked-by-cli-capability-gap`：required families 没有 executable implementation。
- `blocked-by-cli-bug`：required families 存在但无法 projection、invoke 或 validate。
- `invalid-test-environment`：credential、sandbox、dependency 或 workspace setup 阻止执行。

## Acceptance Strategy / 验收策略

The gap is closed only when evidence shows:

- Engineering stages expose Tier 1 tools for write-capable tasks.
- Missing required tools stop before model dispatch with a typed capability-gap diagnostic.
- Isolated live task workspaces can resolve provider credentials through user/global configuration without raw secret leakage.
- T02, T03, T06, T07, and T08 can progress past projection and environment readiness, so remaining failures can be attributed to model behavior, tool execution bugs, or task logic.
- A Codex-class comparison report cites DeepSeek-owned evidence and marks unavailable external Codex evidence as unavailable rather than inferred.
- Capability-matrix output is actionable as a continuous correction loop: every task result names the likely owner layer, missing evidence, next repair action, and rerun condition before another live batch is launched.
- A session board view can show each persisted session's ordered steps, tool calls, verification records, terminal status, and blockers from existing session events.

只有证据证明以下事项时，差距才算缩小到可判断阶段：

- engineering stages 在可写任务中暴露 Tier 1 tools。
- required tools 缺失时，在 model dispatch 前以 typed capability-gap diagnostic 停止。
- 隔离 live task workspace 可以通过 user/global configuration 解析 provider credentials，且不泄漏 raw secret。
- T02、T03、T06、T07、T08 能越过 projection 与 environment readiness，使剩余失败可以归因为 model behavior、tool execution bugs 或 task logic。
- Codex-class comparison report 引用 DeepSeek-owned evidence，并把不可用的 external Codex evidence 标为 unavailable，而不是推断。
- capability-matrix output 必须能作为连续修正循环使用：每个 task result 都要说明可能的 owner layer、缺失 evidence、下一步修复动作与 rerun condition，然后才能发起下一轮 live batch。
- session board view 可以从现有 session events 展示每个已持久化 session 的有序步骤、工具调用、验证记录、终态与 blocker。
