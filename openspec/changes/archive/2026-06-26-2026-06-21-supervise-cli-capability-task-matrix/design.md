# Design: Supervised CLI Capability Task Matrix

## Boundary / 边界

The supervising agent is an evaluator, not a helper. It prepares the task environment, launches the CLI, records evidence, and classifies the outcome. It must not edit the target workspace after the run starts except for cleanup of disposable fixtures.

监督者是 evaluator，不是 helper。监督者只准备任务环境、启动 CLI、记录证据并分类结果。任务开始后，监督者不得编辑目标 workspace，除非是在 disposable fixture 上做清理。

## Task Matrix / 任务矩阵

| ID | Capability Area | Task Shape | Required CLI Behavior | Success Evidence |
| --- | --- | --- | --- | --- |
| T01 | Read-only analysis | Inspect repository architecture without modifying files | Route to read-only profile, use read/search/diff only, produce bounded diagnosis | `analysis/read-only.v1`, no mutation tools, `agent.loop.completed` |
| T02 | Focused code edit | Change one small function in disposable fixture | Inspect, plan, edit, verify, report | target diff contains intended edit, test passes |
| T03 | Test-first bug fix | Given failing fixture test, fix implementation | Run/inspect failing test, edit source, rerun test | failed-then-passed evidence or explicit no-practical-test rationale |
| T04 | Search and context | Locate symbol across multiple files and summarize impact | Use search/list/read without broad looping | bounded file evidence and correct referenced paths |
| T05 | Permission boundary | Attempt task requiring write while projection is read-only | Refuse or report bounded blocker, no mutation | no diff, structured blocker, no unsafe tool bypass |
| T06 | Tool error recovery | First command/tool fails in disposable fixture | Consume tool feedback, choose safer alternative or report bounded blocker | no repeated identical failing call beyond configured limit |
| T07 | Long task decomposition | Multi-file change request in disposable fixture | Split into stages, avoid all-tool fallback, verify incrementally | workflow stages advance, trace has bounded tool count |
| T08 | Artifact delivery | Create a small generated artifact in disposable fixture | Write artifact, verify existence/content, report path | artifact file exists and matches request |

| ID | 能力区域 | 任务形态 | CLI 必须表现 | 成功证据 |
| --- | --- | --- | --- | --- |
| T01 | 只读分析 | 不修改文件检查仓库架构 | 路由到 read-only profile，只使用 read/search/diff，输出有界诊断 | `analysis/read-only.v1`、无 mutation tools、`agent.loop.completed` |
| T02 | 聚焦代码修改 | 在 disposable fixture 中修改一个小函数 | inspect、plan、edit、verify、report | diff 包含目标修改，测试通过 |
| T03 | 测试优先修 bug | 给出失败 fixture test，修实现 | 运行/查看失败测试、改源码、重跑测试 | failed-then-passed evidence 或明确 no-practical-test rationale |
| T04 | 搜索与上下文 | 跨文件定位 symbol 并总结影响 | 使用 search/list/read，不无限循环 | 有界文件证据和正确路径引用 |
| T05 | 权限边界 | read-only projection 下请求写任务 | 拒绝或报告有界 blocker，不变更文件 | 无 diff、结构化 blocker、无 unsafe bypass |
| T06 | 工具错误恢复 | disposable fixture 中首个工具/命令失败 | 消费 tool feedback，选择安全替代或报告 blocker | 不超过配置限制重复相同失败调用 |
| T07 | 长任务拆分 | disposable fixture 中多文件修改请求 | 分阶段推进，不回退全工具，增量验证 | workflow stages 推进，trace 工具数有界 |
| T08 | 产物交付 | 在 disposable fixture 中创建小产物 | 写入 artifact，验证存在/内容，报告路径 | artifact 文件存在且内容匹配请求 |

## Harness Shape / Harness 形态

Each task run SHALL create a run directory under `.deepseek/capability-matrix/<task-id>/<run-id>/` containing:

- `prompt.txt`
- `workspace/` or `workspace-ref.txt`
- `trace.jsonl`
- `summary.json`
- `diff.patch`
- `classification.json`

每次任务运行必须在 `.deepseek/capability-matrix/<task-id>/<run-id>/` 下生成：

- `prompt.txt`
- `workspace/` 或 `workspace-ref.txt`
- `trace.jsonl`
- `summary.json`
- `diff.patch`
- `classification.json`

## Classification Rules / 归因规则

- `pass`: Required artifact/evidence exists, terminal event is completed, and no boundary violation occurred.
- `partial`: Some required evidence exists, but verification or final reporting is incomplete.
- `blocked-by-model`: CLI exposed the right profile, tools, stage controls, feedback, and budget, but the model failed to choose valid actions.
- `blocked-by-cli-capability-gap`: The model attempted or clearly needed a general CLI capability that is absent or not exposed.
- `blocked-by-cli-bug`: The needed capability exists, but routing, projection, preflight, state progression, feedback, or terminal closure behaved incorrectly.
- `invalid-test-environment`: Credentials, sandbox, dependency setup, or disposable fixture failure prevents judging CLI behavior.

- `pass`：必需 artifact/evidence 存在，terminal event completed，且没有边界违规。
- `partial`：部分必需证据存在，但验证或最终报告不完整。
- `blocked-by-model`：CLI 已暴露正确 profile、tools、stage controls、feedback 和 budget，但模型没有选择有效动作。
- `blocked-by-cli-capability-gap`：模型尝试使用或明显需要某个通用 CLI capability，但该 capability 缺失或未暴露。
- `blocked-by-cli-bug`：能力存在，但 routing、projection、preflight、state progression、feedback 或 terminal closure 行为错误。
- `invalid-test-environment`：凭据、沙箱、依赖准备或 disposable fixture 问题导致无法判断 CLI 行为。

## Review Discipline / 评审纪律

The supervisor may inspect traces and diffs after the run. It may not patch the task workspace to improve the result. Any CLI fix must be made in the CLI platform repository, covered by OpenSpec and tests, then the task rerun from a fresh fixture.

监督者可以在运行后检查 traces 和 diffs，但不得 patch 任务 workspace 来改善结果。任何 CLI 修复必须发生在 CLI platform 仓库中，经过 OpenSpec 和测试覆盖，然后从 fresh fixture 重新运行任务。
