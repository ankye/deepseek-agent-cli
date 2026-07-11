# Proposal: Close Codex-Class Capability Gap

## Why / 为什么

Live capability-matrix evidence shows the CLI can run a read-only tool loop, but write-capable engineering tasks currently fail before model quality can be judged. The engineering profile is selected, yet implementation tools such as shell, test, file edit, patch, and git diff are absent or not projected as model-visible executable capabilities. This is a CLI architecture gap, not a task-specific benchmark issue.

live capability-matrix 证据显示 CLI 可以执行只读工具循环，但可写工程任务目前在判断模型质量之前就失败了。engineering profile 已被选中，但 shell、test、file edit、patch、git diff 等实现工具缺失或没有作为 model-visible executable capabilities 投影出来。这是 CLI 架构缺口，不是某个 benchmark 的特例问题。

The current Codex comparison is bounded: official Codex documentation could not be fetched in this session, so this change compares against a Codex-class production coding agent surface and current-session observable supervisor capabilities, not undocumented Codex internals. Any release or marketing comparison must refresh official/public baseline evidence first.

当前 Codex 对比有边界：本会话未能成功获取官方 Codex 文档，因此本 change 对比的是 Codex-class 生产级 coding agent 能力面与当前会话可观察到的监督者能力，不对未公开 Codex 内部实现下结论。任何发布或市场化对比都必须先刷新官方/公开 baseline 证据。

## What / 做什么

- Define a Codex-class gap scorecard that compares tool surface, stage projection, task closure, isolation, credential readiness, and recovery.
- Require a capability/affordance compiler: profiles declare required capability families, stages compile those requirements into model-visible executable tools, and missing required families fail closed before a model call.
- Define production tool tiers that close the practical gap: core read tools, coding mutation tools, verification/shell/git tools, browser/artifact tools, MCP/plugin connectors, and ecosystem integrations.
- Require evidence that each pipeline step is evaluated before downstream stages consume its output.
- Require isolated workspace credential resolution so live disposable tasks can use user/global credentials without copying secrets into fixtures.
- Preserve the supervisor boundary: Codex or other evaluators may inspect and score, but must not help the DeepSeek CLI solve its own test tasks.

- 定义 Codex-class gap scorecard，对比 tool surface、stage projection、task closure、isolation、credential readiness 与 recovery。
- 要求 capability/affordance compiler：profile 声明所需 capability families，stage 将这些需求编译为 model-visible executable tools，缺失必需 family 时必须在模型调用前 fail closed。
- 定义缩小实际差距的生产工具层级：核心只读工具、代码修改工具、验证/shell/git 工具、browser/artifact 工具、MCP/plugin connectors 与生态集成。
- 要求每个 pipeline step 在下游消费其输出之前必须经过评估。
- 要求隔离 workspace 的凭据解析能力，使 live disposable tasks 可以使用 user/global credentials，而不把 secret 复制进 fixture。
- 保持监督者边界：Codex 或其他 evaluator 可以检查和评分，但不得帮助 DeepSeek CLI 完成自己的测试任务。

## Non-Goals / 非目标

- Do not encode SWE-bench, capability-matrix, or evaluator-specific shortcuts into normal CLI task execution.
- Do not claim exact Codex internals or official Codex parity without refreshed external baseline evidence.
- Do not mark a task solved from final text alone when required tools, diffs, tests, artifacts, or evidence are missing.
- Do not expose all tools by default as a substitute for governed projection.

- 不把 SWE-bench、capability-matrix 或 evaluator-specific shortcuts 写进正常 CLI 任务执行流程。
- 在没有刷新 external baseline 证据前，不声称精确 Codex 内部机制或官方 Codex parity。
- 当所需 tools、diffs、tests、artifacts 或 evidence 缺失时，不得仅凭 final text 标记任务解决。
- 不用默认暴露全部工具来替代受治理的 projection。

