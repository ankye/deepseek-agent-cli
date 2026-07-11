# Proposal: Supervise CLI Capability Task Matrix

## Why / 为什么

Repeated unit and focused tests can prove individual contracts, but they do not show whether the live CLI can solve user-shaped tasks through its own workflow. We need a supervised task matrix that lets the CLI attempt representative tasks by itself, then classifies failures as model limitation, CLI capability gap, or CLI bug. The supervising agent must not complete the benchmark task for the CLI.

重复运行单元测试和 focused tests 可以证明单个契约，但不能说明 live CLI 是否能通过自己的 workflow 完成真实用户形态的任务。我们需要一个监督式任务矩阵，让 CLI 自己尝试代表性任务，然后把失败归因为模型能力限制、CLI 能力缺口或 CLI bug。监督者不得替 CLI 完成被测任务。

## What / 做什么

- Define a CLI capability task matrix covering read-only analysis, engineering modification, verification, context/search, permissions, error recovery, long-task decomposition, and artifact delivery.
- Run tasks in isolated workspaces or read-only project scopes so task execution does not mutate the main repository unless the task explicitly targets a disposable fixture.
- Capture JSONL traces, workspace diffs, tool-call counts, workflow stage transitions, terminal reason, and final artifact evidence for every task.
- Classify each task result into pass, partial, blocked-by-model, blocked-by-cli-capability-gap, blocked-by-cli-bug, or invalid-test-environment.
- Use findings to decide whether to add CLI capability, fix CLI orchestration, or record a model limitation.

- 定义 CLI capability task matrix，覆盖只读分析、工程修改、验证、上下文/搜索、权限、错误恢复、长任务拆分和产物交付。
- 在隔离 workspace 或只读项目范围中运行任务，除非任务明确使用 disposable fixture，否则不得修改主仓库。
- 为每个任务记录 JSONL trace、workspace diff、tool-call 次数、workflow stage transitions、terminal reason 和最终产物证据。
- 将每个任务结果分类为 pass、partial、blocked-by-model、blocked-by-cli-capability-gap、blocked-by-cli-bug 或 invalid-test-environment。
- 根据 findings 决定是补 CLI capability、修 CLI orchestration，还是记录模型限制。

## Non-Goals / 非目标

- Do not manually solve the task for the CLI during supervision.
- Do not add task-specific shortcuts, benchmark-specific branches, or prompt hacks to make a task pass.
- Do not treat a final text answer as success unless required artifacts, diffs, tests, or evidence exist.
- Do not run destructive tasks against the main repository.

- 监督过程中不得手工替 CLI 解题。
- 不为某个任务添加 task-specific shortcuts、benchmark-specific branches 或 prompt hacks。
- 除非存在必需的 artifact、diff、test 或 evidence，否则不得把最终文本回答当作成功。
- 不在主仓库上运行破坏性任务。
