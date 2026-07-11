# Design: CLI Workflow Boundary Split

## Boundary / 边界

There are three distinct layers:

1. `staged-task` contract layer: generic state machine and optional acceptance/evaluation fields.
2. Ordinary CLI workflow layer: engineering/product/design profiles that run inside the CLI and auto-advance on runtime-accepted evidence.
3. Evaluation runner layer: benchmark/diagnostics supervisors that may require technical-director or supervisor acceptance before model attribution.

三层必须分开：

1. `staged-task` contract layer：通用状态机，以及可选的 evaluation/acceptance 字段。
2. 普通 CLI workflow layer：CLI 内部的工程/产品/设计 profile，根据 runtime 接受的证据自动推进。
3. Evaluation runner layer：benchmark/diagnostics supervisor，可在模型归因前要求技术总监或 supervisor 验收。

## Policy Shape / 策略形状

Profile metadata gets an explicit acceptance boundary:

- `workflowGovernanceMode`: `standard` or `evaluation`
- `stageAcceptanceMode`: `automatic` or `supervisor`

Ordinary CLI engineering profile uses `standard + automatic`.
SWE/runner profiles use `evaluation + supervisor`.

Profile metadata 增加显式验收边界：

- `workflowGovernanceMode`: `standard` 或 `evaluation`
- `stageAcceptanceMode`: `automatic` 或 `supervisor`

普通 CLI engineering profile 使用 `standard + automatic`。
SWE/runner profiles 使用 `evaluation + supervisor`。

## Projection / 工具投影

When a primary staged workflow is active:

- If a ready stage exists, project only that stage's tools.
- If a supervisor gate override exists, project only gate-satisfying tools.
- If no ready stage exists while unfinished stages remain, fail closed with a typed orchestration blocker instead of exposing all tools.
- Only evaluation/supervisor workflows may project the broad workflow boundary after stage gates.

当 primary staged workflow active：

- 有 ready stage 时，只投影该 stage 的工具。
- 有 supervisor gate override 时，只投影满足 gate 的工具。
- 没有 ready stage 但仍有未完成 stage 时，必须以 typed orchestration blocker fail closed，而不是暴露所有工具。
- 只有 evaluation/supervisor workflows 可在 stage gate 后投影宽 workflow boundary。

## Runtime Progression / Runtime 推进

For `stageAcceptanceMode=automatic`, runtime-accepted tool evidence creates `stage.succeeded` and advances dependent stages.
For `stageAcceptanceMode=supervisor`, runtime emits `stage.evaluation.required` and waits for the supervisor/runner path.

对于 `stageAcceptanceMode=automatic`，runtime 已接受的工具证据生成 `stage.succeeded`，并推进依赖 stage。
对于 `stageAcceptanceMode=supervisor`，runtime 发出 `stage.evaluation.required`，等待 supervisor/runner 路径。
