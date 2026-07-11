# Land Staged Workflow Execution

## Why

The CLI already has task intent classification, profile selection, profile workflow metadata, staged-task compilation, prompt assembly, tool projection, and workflow boundary guards. Recent live SWE-bench evidence shows those layers are not yet acting as a single execution control plane: the selected evaluation profile was visible, but the outer loop still spent many model requests before the governed terminal capability was invoked, and a child prediction run stopped after one model request without terminal summary recovery.

This is an architecture landing gap, not a benchmark special case. If a primary staged workflow is only prompt guidance and passive tool filtering, then any task family can drift: a ready stage may not become a required action, no-tool model iterations may consume budget without executing the workflow, projection fallback may hide a broken profile, terminal tools may not close the supervisor, and stalled child work may be invisible to the controller.

CLI 中已经具备 task intent classification、profile selection、profile workflow metadata、staged-task compilation、prompt assembly、tool projection 与 workflow boundary guard。最近的 live SWE-bench 证据表明，这些层还没有作为统一执行控制面真正落地：evaluation profile 已经可见，但外层 loop 仍消耗多次 model request 后才调用受管 terminal capability；child prediction run 在一次 model request 后停止，且没有 terminal summary recovery。

这是架构落地缺口，不是 benchmark 特例。如果 primary staged workflow 只是 prompt guidance 与被动 tool filtering，那么任何任务族都会漂移：ready stage 可能不会变成 required action，无 tool-call 的模型轮次会消耗预算却不执行 workflow，projection fallback 会掩盖损坏的 profile，terminal tool 可能不会关闭 supervisor，child 卡住也可能对 controller 不可见。

## What Changes

- Add a staged workflow execution checklist that must pass before optimizing benchmark-specific success rates.
- Require primary staged workflows to produce an executable ready-stage control record before model dispatch.
- Require ready-stage control to become provider-visible required action and runtime-enforced no-tool/no-progress behavior.
- Fail closed when governed workflow capability projection is empty or falls outside the compiled profile boundary.
- Require terminal workflow capabilities to close the supervising agent loop after structured result capture.
- Require child/stage execution stalls, provider stream stalls, and timeout exits to emit typed terminal events and durable summaries.
- Require nested capability and child deadlines to be capped by the caller deadline instead of inflated by model-supplied inputs.
- Keep the implementation generic: no repository, instance, task-number, expected-patch, or hidden-answer branches.

- 增加 staged workflow execution checklist；在优化 benchmark 专项通过率前，必须先通过该基础清单。
- 要求 primary staged workflow 在 model dispatch 前产生可执行的 ready-stage control record。
- 要求 ready-stage control 同时成为 provider-visible required action，并由 runtime 执行 no-tool/no-progress 约束。
- 当 governed workflow capability projection 为空或越过 compiled profile boundary 时 fail closed。
- 要求 terminal workflow capability 在结构化结果捕获后关闭 supervisor agent loop。
- 要求 child/stage execution stall、provider stream stall 与 timeout exit 都发出 typed terminal events 和 durable summaries。
- 要求嵌套 capability 与 child deadline 受 caller deadline 上限约束，不得被模型输入放大。
- 实现必须保持通用：不得基于 repository、instance、task number、expected patch 或 hidden answer 分支。

## Non-Goals

- Do not add a SWE-bench-only direct route that bypasses normal CLI intent, profile, staged workflow, capability registry, or runtime governance.
- Do not manually solve benchmark tasks or encode expected benchmark patches.
- Do not replace the existing staged-task/profile architecture with a separate command script.
- Do not make stage executors call other executors privately.

- 不增加绕过正常 CLI intent、profile、staged workflow、capability registry 或 runtime governance 的 SWE-bench 专用直通路径。
- 不手工解决 benchmark task，也不编码预期 benchmark patch。
- 不用独立命令脚本替换现有 staged-task/profile 架构。
- 不允许 stage executor 私下调用其他 executor。

## Impact

This change turns already-designed architecture into enforced execution behavior. Work should proceed from checklist and tests, not from more benchmark attempts. SWE-bench remains the stress case, but the fix belongs to generic CLI workflow execution and should improve every primary staged workflow.

该变更把已经设计好的架构转化为强制执行行为。后续应从 checklist 与测试推进，而不是继续增加 benchmark 尝试。SWE-bench 仍是压力用例，但修复属于通用 CLI workflow execution，应该改善所有 primary staged workflow。
