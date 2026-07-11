# Proposal: Separate CLI Workflow Boundaries

## Why / 为什么

The ordinary CLI engineering workflow currently inherits evaluation-runner semantics: successful tool evidence moves a stage to `needs-review` and waits for technical-director acceptance that does not exist in the normal CLI path. This blocks execution after the first evidence-gathering tool and then lets the model continue with broad tools until the iteration budget expires.

普通 CLI 工程流程当前继承了评测 runner 语义：工具证据成功后 stage 进入 `needs-review`，并等待普通 CLI 路径中不存在的技术总监验收。这会在第一次收集证据后阻断执行，然后让模型带着宽工具集持续运行直到耗尽迭代预算。

## What / 做什么

- Separate ordinary CLI engineering workflows from evaluation/runner workflows.
- Add an explicit workflow governance boundary so `primary` does not imply benchmark-style supervision.
- Let CLI engineering stages auto-advance from accepted runtime evidence.
- Keep technical-director/supervisor acceptance only for evaluation/runner workflows that explicitly opt in.
- Prevent active staged workflows from falling back to all model-visible tools when no ready stage exists.

- 将普通 CLI 工程 workflow 与 evaluation/runner workflow 分离。
- 增加显式 workflow governance 边界，避免把 `primary` 等同于 benchmark 风格监督。
- 普通 CLI engineering stages 根据 runtime 已接受证据自动推进。
- 技术总监/supervisor 验收只保留给显式 opt-in 的 evaluation/runner workflows。
- active staged workflow 没有 ready stage 时，不得回退到所有 model-visible tools。

## Non-Goals / 非目标

- Do not remove staged-task acceptance records from platform contracts.
- Do not weaken SWE-bench or managed runner supervision.
- Do not add benchmark-specific behavior to the ordinary CLI path.

- 不从 platform contracts 中移除 staged-task acceptance records。
- 不削弱 SWE-bench 或 managed runner supervision。
- 不向普通 CLI 路径加入 benchmark 特例。
