# Systematize Engineering Intelligence

## Why / 为什么

Live CLI runs still rely too much on the model inferring the engineering loop from prompts. Reference inspection shows a stronger pattern: the runtime assembles a governed tool pool, narrows it by mode/profile/permission/environment, records tool decisions and denials, and feeds corrective results back into the next model step. We need that as a generic decision system, not benchmark-specific guidance.

当前 live CLI 仍过度依赖模型从 prompt 中自行推断工程闭环。参考实现显示出更强的模式：runtime 组装受治理工具池，再按 mode/profile/permission/environment 收窄，记录工具决策和拒绝，并把可修正结果反馈给下一次模型步骤。我们需要把它做成通用决策系统，而不是 benchmark 特例提示。

## What Changes / 做什么

- Add a first-class tool decision board for each agent session/turn.
- Expand the CLI tool arsenal to reference-class completeness across workspace I/O, search, code intelligence, mutation, shell/process, git/build, planning, agents/tasks, web, MCP, browser, memory/session, worktree, scheduling, and observability.
- Require stage-aware tool projection records that explain why each tool is visible, hidden, narrowed, or denied.
- Require corrective feedback contracts for rejected, failed, repaired, and bounded tool results.
- Define reusable engineering profiles as workflow contracts with stage success criteria, not hardcoded task branches.
- Add decision-quality metrics: repeated failure suppression, missing-tool attribution, stage evidence sufficiency, and tool-result-followup quality.

- 为每个 agent session/turn 增加一等公民 tool decision board。
- 将 CLI 工具弹药库扩展到参考级完整度，覆盖 workspace I/O、search、code intelligence、mutation、shell/process、git/build、planning、agents/tasks、web、MCP、browser、memory/session、worktree、scheduling 与 observability。
- 要求 stage-aware tool projection records 说明每个工具为什么可见、隐藏、收窄或拒绝。
- 为 rejected、failed、repaired 与 bounded tool results 定义可修正反馈契约。
- 将可复用工程 profile 定义为带 stage success criteria 的 workflow contracts，而不是硬编码 task 分支。
- 增加决策质量指标：重复失败抑制、缺工具归因、stage evidence sufficiency 与 tool-result-followup quality。

## Non-Goals / 非目标

- Do not copy reference implementation code.
- Do not make the CLI solve tasks through evaluator-side special cases.
- Do not expose all tools globally just to compensate for weak planning; completeness means registered, executable, governed, tested, and selectively projected.
- Do not bake Codex/technical-director supervision into the CLI runtime; CLI records evidence, external supervisors may evaluate it.

- 不复制参考实现代码。
- 不通过 evaluator 侧特例让 CLI 假装完成任务。
- 不为了补偿规划弱而全局暴露所有工具；完整度意味着已注册、可执行、受治理、有测试，并且按场景选择性投影。
- 不把 Codex/技术总监监督固化进 CLI runtime；CLI 记录证据，外部监督者可以评估。
