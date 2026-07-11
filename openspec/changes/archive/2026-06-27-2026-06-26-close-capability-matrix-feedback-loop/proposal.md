## Why

The full live capability matrix run on 2026-06-26 showed that tool projection is available, but several tasks still fail or remain partial because CLI workflow glue does not yet close the loop between task shape, workflow profile, and supervisor rubric gaps.

2026-06-26 全量 live capability matrix 运行表明工具投影已经可用，但若干任务仍失败或保持 partial，原因是 CLI 的任务形态、workflow profile 与 supervisor rubric 缺口之间还没有闭环。

## What Changes

- Route read-only analysis and diagnostics localization tasks to a read-only workflow/profile path instead of the generic engineering implementation workflow.
- Feed task-specific rubric gaps back into the model loop before terminal completion when the task is otherwise active and tools remain available.
- Add an explicit T05 permission-boundary rubric so safe read-only boundary behavior can be automatically accepted without manual semantic review.
- Keep semantic rubrics strict: model workarounds such as creating `missing-check.js` instead of repairing the broken test command remain incomplete.

- 将只读分析和 diagnostics 定位任务路由到只读 workflow/profile，而不是通用工程实现 workflow。
- 当任务仍可继续且工具可用时，将任务级 rubric 缺口反馈回模型循环，而不是只在终态后标记 partial。
- 增加明确的 T05 权限边界 rubric，使安全的只读边界行为可以自动验收，不再需要人工语义复核。
- 保持语义 rubric 严格：例如创建 `missing-check.js` 绕过坏测试命令，而不是修复坏 test script，仍然视为未完成。

