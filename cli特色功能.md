# DeepSeek CLI 特色功能

> 用途：沉淀 DeepSeek CLI 的独有能力、宣传口径、演示场景和边界说明。后续可拆成官网文案、README、发布说明、路演材料、技术文章和销售资料。

## 使用口径

- 这份文档是“宣传素材库”，不是发布承诺清单。
- 对外只把已有证据支撑的能力写成“已具备 / 已接入 / 已形成”；仍在治理、灰度或设计中的能力写成“推进中 / 路线图 / 方向”。
- SWE-bench 相关内容只宣传治理方法、评测闭环和阶段性事实，不宣传未验证的通过率。
- 所有卖点都围绕通用 Agent runtime 能力，避免写成 benchmark-specific、provider-specific 或 task-specific 定制。
- 每次新增卖点时，同步补三项：能力名称、可验证证据、不能夸大的边界。

## 一句话定位

DeepSeek CLI 不是一个“模型套命令行”的助手，而是一套面向 Coding Agent 的本地工程运行时：用同一个 runtime kernel 编排工具、技能、插件、MCP、Hook、命令、子 Agent、上下文、缓存、权限、诊断和验证。

## 电梯稿

DeepSeek CLI 把 Coding Agent 从“聊天 + 工具列表”升级为“可治理、可回放、可编排的本地 Agent 工作台”。它用 contract-first 的 TypeScript 平台架构承载 CLI、TUI、VSCode 和未来 Server/SDK；所有能力都通过统一 capability model、execution envelope、policy sandbox、workflow orchestration 和 runtime event stream 运转。

这意味着它不仅能执行任务，还能解释任务如何被拆解、哪些能力被调用、证据来自哪里、缓存为什么命中或失效、失败到底属于环境、流程、验证、模型还是系统 bug。

## 核心主张

### 1. 从 CLI 工具升级为 Agent Runtime

传统 CLI Agent 更像“模型 + 一组工具”。DeepSeek CLI 的核心是 runtime：它管理任务生命周期、上下文、能力、权限、调度、缓存、诊断和验证。

可用文案：

- 不是工具箱，是本地 Agent 操作系统。
- 一个 kernel，一套协议，多端适配。
- 所有能力都可编排、可治理、可回放。

### 2. 从 Prompt 驱动升级为契约驱动

Prompt 仍然重要，但它不再是唯一控制面。DeepSeek CLI 把 profile、task intent、tool projection、cache hint、diagnostics、workflow 和 verification 都做成结构化契约。

可用文案：

- Prompt 不是临时字符串，而是可回放的工程产物。
- Profile 不是提示词皮肤，而是工作流角色。
- 工具选择不靠模型瞎猜，系统给出可验证的能力边界。

### 3. 从跑通任务升级为可治理成功率

系统把成功率、provider cache 命中率、context projection cache、source inspection、mutation、test command、harness feedback 和 reason code 拆开治理。失败不是黑盒，而是进入可复盘、可修复的工程闭环。

可用文案：

- 低于门槛不盲目扩量，先修系统性问题。
- 失败有 taxonomy，不先甩给模型能力。
- 把 benchmark 当作 runtime 能力体检，而不是刷题脚本。

### 4. 从隐藏执行升级为可见证据

DeepSeek CLI 记录有界的 intent、context selection、tool intent、verification、outcome 和 evidence summary。用户能看到 Agent 在做什么、为什么做、证据在哪里、失败卡在哪，同时不暴露原始 chain-of-thought。

可用文案：

- 让工程过程可见，但不泄露隐藏推理链。
- 每个结论都能回到证据、命令或产物。
- 诊断不是开发者后门，而是用户可理解的产品表面。

## 十大特色能力

| 能力 | 宣传卖点 | 差异化表达 | 当前口径 |
| --- | --- | --- | --- |
| 一个内核，多端适配 | CLI、TUI、VSCode、Server/SDK 共享运行时 | 不为每个端重复写状态机，所有端消费同一条事件流 | 平台架构已形成，非 CLI host 按 thin adapter 推进 |
| 能力即 Agent | tool、skill、plugin、MCP、hook、command、subagent 都进入统一 capability/agent 模型 | 不是“工具列表”，而是可治理、可路由、可组合、可审计的能力网络 | 核心契约已建立，编排能力持续增强 |
| 运行时编排工作流 | 用户意图先进入 workflow graph，再调度能力、验证和修复 | 模型建议工作，平台决定拆解、依赖、调度、取消、重试和合并 | 作为最高优先级能力持续强化 |
| 受治理执行信封 | 每次能力调用都有 envelope、policy、sandbox、timeout、audit metadata | 防止能力绕过权限、沙箱和审计路径 | 已作为 runtime/kernel 基础能力 |
| Profile 作为工作流角色 | profile 表达环境和任务角色，组合通用能力 | 不是硬编码特权开关，也不是 benchmark 定制提示词 | 已按 workflow composition 方向调整 |
| 可回放 Prompt Assembly | 分层 section、fingerprint、budget、cache hint、replay evidence | prompt 可比较、可复盘、可治理 | 已实现，并用于 cache/prompt 诊断 |
| 稳定前缀缓存治理 | 拆分 provider cache、context projection cache 和 stable prefix | cache 低时能定位是前缀、动态尾部还是 provider shape 问题 | 已用于 SWE-bench 治理复盘 |
| Lossless Context 记忆 | context 节点可 status、grep、describe、summarize、expand、pin | 不只靠模型窗口记忆，有本地可检索证据层 | context compactor 已作为一方插件能力接入 |
| Evidence-first 输出 | 项目事实、命令、产物、评测结论先找证据再输出 | 减少幻觉命令、虚构包名和无证据发布声明 | 已接入事实敏感任务流程 |
| 诊断即产品表面 | diagnostics/doctor/release 暴露 kernel、UAPI、cache、policy、agent、module、evidence 状态 | 用户和开发者能看到系统为什么不能发布或扩量 | 已是一等发布表面 |

## 特色能力卡片

### 能力即 Agent

工具、命令、技能、Hook、MCP、插件、工作流和子 Agent 都被视为 capability surface。可执行能力必须声明身份、schema、可见性、副作用、权限、资源范围、沙箱、脱敏和 replay metadata。

为什么独特：

- 新能力类型不新增私有执行路径，只新增 manifest/contribution shape。
- 插件/MCP/技能不是松散外设，而是进入统一治理管线。
- 能力结果不会无脑进入稳定 prompt 前缀，避免污染上下文和缓存。

可展示证据：

- `docs/architecture/capability-model.md`
- `openspec/specs/command-skill-hook-composition/spec.md`
- `src/packages/platform-contracts`

边界：

- “所有能力都是 Agent”是架构目标和治理模型，不代表每个技能都已经具备独立自治执行器。

### 工作流编排优先

CLI 成败的关键不只是模型强弱，而是平台能否把任务拆成可靠步骤：识别意图、搜证、规划、执行、验证、修复、合成，并让每一步都有边界和证据。

为什么独特：

- workflow 决定“有哪些工作”，scheduler 决定“何时运行”。
- 子 Agent、工具链、并行步骤、artifact routing、stream pipeline 都进入统一 workflow/scheduler 模型。
- executors 不能私下互调，组合必须走 runtime pipeline 或 agent loop。
- 当 gate 拒绝某类动作时，profile workflow state 会同步收敛到 edit/test/bounded blocker 这类下一步动作，而不是继续把只读探索当成 active next step。

可展示证据：

- `docs/architecture/orchestration-and-scheduling.md`
- `openspec/specs/workflow-orchestration/spec.md`
- `openspec/specs/agent-mode-orchestration/spec.md`

边界：

- 这是当前最高优先级方向，仍需用更多可执行 pipeline 和评测证据证明默认收益。

### Contract-first 多端平台

CLI 是近期主产品面，但不是唯一架构目标。CLI、TUI、VSCode、未来 Server/SDK 都应通过 shared contracts、communication protocol 和 runtime event stream 连接同一个 kernel。

为什么独特：

- Host 是 thin adapter，负责收集输入和渲染输出，不拥有业务状态机。
- 共享 runtime events 让 text、JSON、JSONL、TUI、未来 IDE 看到同一套事实。
- 非 CLI host 先保持 landing zone，等 CLI workflow 通过验收后再推广。

可展示证据：

- `README.md`
- `docs/product/product-roadmap.md`
- `docs/architecture/system-overview.md`

边界：

- 不宣传 VSCode、Server/SDK 已完整发布；只说架构和 landing zone 已规划。

### Prompt Assembly 与缓存治理

DeepSeek CLI 不把 prompt 当作不可复盘的大字符串，而是通过 context pipeline 分层组装：kernel prefix、project prefix、session pipe、current turn tail。稳定内容尽量保持前缀，易变内容放在尾部。

为什么独特：

- 用 prefix hash、fingerprint、cache hint 和 replay evidence 解释缓存行为。
- 区分 provider cache 与 context projection cache，避免把 0% 命中误判成单一问题。
- 能定位 stable prefix、dynamic tail、provider request shape、tool result projection 等不同 failure mode。

可展示证据：

- `docs/architecture/context-pipeline-cache.md`
- `openspec/specs/context-pipeline-prefix-cache/spec.md`
- `src/packages/prompt-assembly`

边界：

- cache 命中率是受 provider、prompt 结构和任务流共同影响的运行指标，不承诺固定值。

### Evidence-first 与可见推理表面

事实敏感任务必须先收集本地证据，再把结论分类为 verified、inferred、assumption 或 unsupported。可见推理只展示有界摘要和证据链接，不暴露原始 provider reasoning。

为什么独特：

- 从产品层阻止虚构包名、虚构命令、无证据发布声明。
- text、JSON、JSONL、TUI 都能消费同一套 visible reasoning projection。
- support bundle 保留脱敏摘要、证据数量、fingerprint 和 replay path。

可展示证据：

- `README.md`
- `src/apps/cli/README.md`
- `openspec/specs/visible-reasoning-surface/spec.md`

边界：

- 不是公开 chain-of-thought，也不保证每个模型内部推理都可见。

### 诊断、发布门禁和失败归因

DeepSeek CLI 把 diagnostics 做成用户可见的产品表面：release readiness、support bundle、evaluation、doctor、verify 都输出结构化证据。

为什么独特：

- 失败被归类为环境、cache、workflow、validation、harness、model patch、policy、system bug 等 reason code。
- 发布不只看 typecheck，还看 acceptance evidence、boundary lint、golden、matrix、e2e。
- SWE-bench canary 失败会进入复盘和 framework fix，而不是直接怪模型。

可展示证据：

- `docs/operations/acceptance-evidence.md`
- `docs/operations/validation-gates.md`
- `openspec/specs/cli-diagnostics-release-readiness/spec.md`

边界：

- 诊断能提高定位能力，不等于自动修复所有失败。

### 插件、技能、MCP 的统一贡献模型

插件不只是安装一个命令。它可以贡献 command、hook、MCP bridge、tool、TUI/keymap/palette/render hint、diagnostics provider，但必须先作为 inert composition record 进入投影，再经 policy 执行。

为什么独特：

- CLI help、slash command、palette、model-visible command list 都从组合记录投影。
- model-visible projection fail-closed，缺 schema、权限不明或 host-only 的能力不会暴露给模型。
- 插件不会拿到 runtime 私有对象、raw credential resolver 或 model SDK client。

可展示证据：

- `openspec/specs/plugin-system/spec.md`
- `openspec/specs/mcp-gateway/spec.md`
- `openspec/specs/command-skill-hook-composition/spec.md`

边界：

- 不宣传完整插件市场已发布；当前重点是一方插件、贡献模型和治理边界。

### DeepSeek Workbench TUI

CLI 不是只能流式输出文本。DeepSeek Workbench 方向包含 transcript、command bar、reasoning rail、inspector、activity feed、plugin shelf、visible prompt、vi-inspired focus keys 和 cache-aware statusline。

为什么独特：

- TUI 消费 runtime events，而不是 host 自建状态。
- reasoning rail、inspector 和 activity feed 可以追踪证据、能力调用和结果。
- 默认 auto profile 保持脚本友好，full-screen TUI 是显式提升。

可展示证据：

- `README.md`
- `src/apps/cli/README.md`
- `openspec/specs/professional-vi-tui-experience/spec.md`

边界：

- 不把所有 TUI 体验描述成已完全稳定；用“Workbench 方向 / 部分路径已具备”更准确。

### OpenSpec 治理

重大架构变化先写 OpenSpec，再实现、验证、归档。规格必须描述 DeepSeek 自己的行为、验收门槛和反定制原则。

为什么独特：

- 把产品目标、反定制边界、验收证据和测试要求写入可维护契约。
- 对 SWE-bench、cache、profile、workflow 等争议点形成可追溯治理记录。
- 防止短期为了跑分破坏长期平台架构。

可展示证据：

- `openspec/specs`
- `openspec/changes`
- `AGENTS.md`

边界：

- OpenSpec 是治理方法，不替代最终测试和真实运行证据。

### SWE-bench 受管评测

SWE-bench Lite 被用作 runtime 能力体检：不仅看 resolved，还看 cache 命中率、prompt 稳定性、source inspection 收敛、mutation、test command、harness feedback、official evaluation 和失败 taxonomy。

为什么独特：

- 有单题 canary、扩量门槛、provider cache SLO 和失败复盘。
- 禁止按 repo name、instance id、task number 或 expected patch 做生产分支。
- 将“模型能力不行”作为最后归因，先查流程和系统 bug。

可展示证据：

- `openspec/changes/2026-06-09-govern-swebench-200-ramp`
- `.deepseek/verification` 中的本地运行证据
- `.deepseek/swe-lite-runs` 中的 summary/trace

边界：

- 不宣传未达成的 90%+ 通过率，不泄露 benchmark 解法，不把单题修复包装成通用能力。

## 能力素材清单

### Runtime 与执行

- Governed runtime kernel
- Runtime message bus
- Execution envelope
- Policy sandbox
- Tool intent preflight
- Workflow orchestration
- Concurrency scheduling
- Agent namespace、quota、lineage
- Checkpoint、rollback、repair loop

### 上下文与模型

- Context pipeline
- Immutable context blocks
- Prefix hashes
- Prompt assembly replay
- Stable provider prefix evidence
- Provider cache usage normalization
- Context projection cache
- Lossless context memory
- Code intelligence projection

### 能力生态

- Capability registry
- Core coding tools
- Command system
- Skill system
- Hook system
- MCP gateway
- Plugin system
- Subagent/workflow composition
- Inert composition records

### 质量与治理

- OpenSpec workflow
- Architecture lint
- Contract tests
- Golden replay
- Matrix tests
- E2E tests
- Release diagnostics
- Evidence matrix
- SWE-bench governed runner

### 用户体验

- Headless JSON/JSONL
- Text output
- DeepSeek Workbench TUI
- Visible reasoning rail
- Inspector
- Activity feed
- Plugin shelf
- Cache-aware statusline
- Slash command / command palette projection

## 面向受众的卖点

### 给开发者

- 一个 CLI 入口，背后是可扩展 runtime，不是只能聊天的 wrapper。
- Agent 的上下文、工具、命令、验证、失败原因都有证据链。
- 出问题时可以看 diagnostics、trace、prompt replay 和 reason code，而不是猜模型为什么乱走。
- profile 能表达任务角色，减少“换一大坨 prompt”的脆弱操作。

### 给团队和企业

- 权限、沙箱、审计、执行信封、发布门禁都可以治理。
- Profile 可以表达不同团队、环境、任务类型的工作流角色。
- 插件、MCP、技能进入统一能力边界，减少各自为政的集成风险。
- 诊断和 support bundle 默认本地、脱敏、可回放。

### 给插件和能力开发者

- 插件不只是塞一个命令，而是贡献 governed capability。
- 能力可以被 help、palette、TUI、diagnostics、runtime route 统一发现和编排。
- 输入输出、policy、timeout、lineage、evidence 都能成为能力契约的一部分。

### 给研究和评测场景

- Benchmark 不只是跑分，而是 runtime 能力体检。
- cache、prompt、source inspection、mutation、test command、harness feedback 都能分开归因。
- 失败优先进入 taxonomy 和 framework fix，而不是直接甩给模型能力。

## 可演示场景

| 场景 | 展示点 | 可用素材 |
| --- | --- | --- |
| 一次 governed tool call | execution envelope、policy、audit、timeout | tool trace、diagnostics JSON |
| 一次 prompt replay | stable prefix、dynamic tail、fingerprint、cache hint | prompt assembly JSONL |
| 一次 profile workflow | parent dispatch、managed child run、capability route | CLI trace、OpenSpec task |
| 一次 SWE-bench canary | attempt、patch、test、harness、reason code | summary.json、trace JSONL |
| 一次插件贡献 | descriptor、composition record、TUI/help/diagnostics 投影 | plugin manifest、palette 截图 |
| 一次 Workbench 操作 | transcript、reasoning rail、inspector、activity feed | TUI 截图或录屏 |
| 一次 release gate | lint、typecheck、tests、boundary、acceptance evidence | diagnostics release 输出 |

## 状态口径

| 口径 | 含义 | 可用表达 |
| --- | --- | --- |
| 已具备 | 已有代码、测试或文档证据，可本地验证 | “已接入”“已形成基础能力”“已作为产品表面” |
| 推进中 | 有架构和部分实现，但仍在补验收或扩面 | “持续增强”“按 CLI-first 路线推进” |
| 门禁中 | 能力存在，但默认启用或扩量受指标约束 | “受 release/evaluation gate 控制” |
| 路线图 | 架构方向明确，尚不能宣传为已发布 | “未来将推广到”“规划支持” |
| 禁止夸大 | 缺真实证据或会造成误解 | 不写成已稳定、已完整发布、任意模型可保证 |

## 命名词典

| 名称 | 推荐解释 | 适用文案 |
| --- | --- | --- |
| Agent Runtime | 管理 Agent 上下文、能力、权限、执行、缓存、诊断和验证的本地运行时 | 官网、README、路演 |
| Capability Agent | 每个工具/技能/插件/MCP/子 Agent 都是有输入输出和运行逻辑的可编排能力 | 架构文章、插件文档 |
| Execution Envelope | 每次能力调用的治理信封，携带 policy、sandbox、timeout、audit 和 lineage | 技术白皮书、企业场景 |
| Workflow Role | profile 表达的任务/环境角色，用来组合通用能力和流程 | 产品文案、工作流介绍 |
| Prompt Replay | prompt assembly 的可回放证据，用于比较、诊断、缓存治理 | 技术文章、评测复盘 |
| Cache Governance | 拆分 provider cache、context projection cache 和 stable prefix 的命中率治理 | 评测文章、性能优化 |
| Evidence Matrix | 把命令、产物、trace、diagnostics 和结论绑定起来的证据表面 | 发布说明、企业治理 |
| Managed Canary | 小批量、可归因、带门槛的能力验证运行 | SWE-bench、回归测试 |
| DeepSeek Workbench | CLI/TUI 工作台：transcript、reasoning、inspector、activity、plugin shelf 的统一体验 | 官网、演示、发布说明 |

## 宣传文案草稿

### 短版

DeepSeek CLI 是面向 Coding Agent 的本地工程运行时。它把工具、技能、插件、MCP、Hook、命令和子 Agent 统一建模为可编排能力，用同一个 runtime kernel 处理上下文、权限、缓存、诊断、执行和验证，让 CLI 不再只是聊天入口，而是可治理、可回放、可扩展的 Agent 工作台。

### 技术版

DeepSeek CLI 采用 contract-first TypeScript monorepo 架构。CLI、TUI、VSCode 和未来 Server/SDK 都是 thin host adapter；共享 runtime kernel、communication protocol、capability registry、policy sandbox、context pipeline、prompt assembly、workflow orchestration 和 diagnostics。每个能力调用都通过统一 execution envelope，所有关键输出都有事件、证据、fingerprint 和 replay path。

### SWE-bench 版

DeepSeek CLI 用 SWE-bench Lite 做 runtime 能力体检：不只看 resolved 数量，还治理 provider cache 命中率、prompt 稳定性、source-inspection 收敛、测试命令选择、环境失败、official harness feedback 和模型 patch 不足。只有当成功率和 cache 门槛达标时才扩量，避免把系统问题误判为模型问题。

### 企业版

DeepSeek CLI 面向企业级 Coding Agent 治理：每个能力调用都有权限、沙箱、审计、超时、脱敏和证据记录；插件、MCP、技能和子 Agent 进入统一能力边界；诊断和 support bundle 默认本地、可回放、可脱敏。它让团队不仅能使用 Agent，还能治理 Agent。

## 后续可补充素材

- 一张“一个 kernel，多端适配”的架构图。
- 一张“能力即 Agent”的编排图。
- 一张“Profile 作为 workflow role”的组合图。
- 一张“workflow orchestration 决定成败”的任务流图。
- 一张 SWE-bench 治理闭环图：attempt -> trace -> reason code -> framework fix -> canary -> ramp gate。
- 一组真实 diagnostics JSON/JSONL 截图。
- 一组 TUI Workbench 截图或录屏。
- 一组 cache hit-rate 提升前后对比数据。
- 一组 capability/plugin descriptor 到 UI 投影的截图。

## 对外禁用边界

- 不宣传未验证的 resolved 数量。
- 不把进行中的 SWE-bench 治理说成已经稳定 90%+。
- 不声称插件市场、VSCode、Server/SDK 已完整发布。
- 不把 benchmark-specific 行为包装成通用能力。
- 不说“任意模型都能稳定自主修复复杂仓库”。
- 不泄露 provider 原始推理链、密钥、隐藏 harness 内容或具体 benchmark 解法。
- 不把 profile 写成特权开关；profile 是 workflow role/composition。
- 不把测试定制、instance id 分支、repo name 分支包装成能力提升。
