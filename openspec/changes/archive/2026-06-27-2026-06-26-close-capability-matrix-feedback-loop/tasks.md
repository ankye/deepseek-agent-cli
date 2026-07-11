# Tasks

## OpenSpec / 规格

- [x] Create bilingual OpenSpec change for capability-matrix feedback-loop closure.
- [x] Add checklist items for read-only profile routing, rubric gap feedback, T05 rubric, and strict non-bypass behavior.
- [x] Validate this change with `npx openspec validate 2026-06-26-close-capability-matrix-feedback-loop --strict`.
- [x] Validate canonical specs with `npx openspec validate --specs --strict`.

- [x] 创建 capability-matrix feedback-loop closure 双语 OpenSpec change。
- [x] 增加只读 profile 路由、rubric gap 反馈、T05 rubric、严格禁止绕过行为的 checklist。
- [x] 使用 `npx openspec validate 2026-06-26-close-capability-matrix-feedback-loop --strict` 校验本 change。
- [x] 使用 `npx openspec validate --specs --strict` 校验 canonical specs。

## Implementation / 实现

- [x] Add regression coverage proving read-only analysis tasks select a read-only workflow/profile instead of `engineering/coding.v1`.
- [x] Add regression coverage proving T05 permission-boundary evidence can pass a task-specific rubric.
- [x] Add regression coverage proving task-specific rubric gaps can be surfaced as model-continuation feedback before final classification.
- [x] Implement the read-only routing glue without task-id special casing.
- [x] Implement rubric gap feedback as a general capability-matrix/supervisor feedback mechanism, not as a benchmark workaround.
- [x] Implement T05 rubric based on no mutation, parent-path safety explanation, and safe alternative evidence.
- [x] Keep T06 strict so creating `missing-check.js` does not satisfy the broken test script repair rubric.

- [x] 增加回归覆盖，证明只读分析任务选择只读 workflow/profile，而不是 `engineering/coding.v1`。
- [x] 增加回归覆盖，证明 T05 权限边界证据可以通过任务级 rubric。
- [x] 增加回归覆盖，证明任务级 rubric 缺口可在最终分类前反馈给模型继续处理。
- [x] 实现只读路由胶水，不使用 task-id 特例。
- [x] 将 rubric gap feedback 实现为通用 capability-matrix/supervisor 反馈机制，而不是 benchmark 绕行。
- [x] 基于无修改、父级路径安全说明和安全替代方案证据实现 T05 rubric。
- [x] 保持 T06 严格，创建 `missing-check.js` 不能满足坏测试脚本修复 rubric。

## Verification / 验证

- [x] Run focused CLI diagnostics and runtime/profile tests.
- [x] Run `npm run build:cli`.
- [x] Rerun the capability matrix tasks affected by this change and record pass/partial/blocker analysis.
- [x] Do not edit task workspaces manually; all fixes must occur in CLI/platform code.

- [x] 运行聚焦 CLI diagnostics 与 runtime/profile 测试。
- [x] 运行 `npm run build:cli`。
- [x] 重新运行本变更影响的 capability matrix 任务，并记录 pass/partial/blocker 分析。
- [x] 不手动编辑任务 workspace；所有修复必须发生在 CLI/platform 代码中。
