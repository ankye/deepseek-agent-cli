# Govern Role Profile Workflows

## Why

The CLI already has intent classification, profile metadata, staged workflow graphs, ready-stage control, and technical-director acceptance primitives. The current gap is that common professional workflows can still be treated as advisory prompt hints, leaving the model to assemble the engineering loop dynamically. That makes success depend on model improvisation instead of runtime-enforced workflow contracts.

CLI 已经具备 intent classification、profile metadata、staged workflow graph、ready-stage control 与技术总监验收原语。当前缺口是常用职业工作流仍可能只是 advisory prompt hint，导致模型临场拼装工程闭环。这样通过率取决于模型即兴发挥，而不是 runtime 强制执行的 workflow contract。

## What Changes

- Define role profile catalog boundaries for engineer, debugging engineer, product manager, visual designer, architect, and technical director.
- Require role profiles to compile into workflow profile and capability profile contracts when the user task is execution-bearing.
- Preserve dynamic model decisions inside a stage, but move stage ordering, allowed capabilities, required evidence, and acceptance gates into runtime-owned metadata.
- Require every primary role workflow to expose visible profile selection, ready-stage control, stage evidence, and technical-director acceptance records.
- Keep casual chat and low-risk informational prompts advisory so they are not forced through mutation-oriented workflows.

- 定义工程师、调试工程师、产品经理、视觉设计师、架构师与技术总监的 role profile catalog 边界。
- 当用户任务具备执行性质时，role profile 必须编译为 workflow profile 与 capability profile contract。
- 允许模型在 stage 内动态决策，但 stage 顺序、允许能力、必需证据与验收 gate 必须归 runtime metadata 管理。
- 每个 primary role workflow 必须暴露 profile selection、ready-stage control、stage evidence 与技术总监验收记录。
- 闲聊与低风险信息型 prompt 保持 advisory，不强制进入 mutation-oriented workflow。

## Non-Goals

- Do not hard-code benchmark, repository, task id, or expected answer paths.
- Do not require all prompts to use primary staged workflows.
- Do not replace model judgment inside a stage with fixed command scripts.
- Do not merge role profile governance into the SWE-bench runner-specific change.

- 不写死 benchmark、repository、task id 或预期答案路径。
- 不要求所有 prompt 都使用 primary staged workflow。
- 不用固定命令脚本替代模型在 stage 内的判断。
- 不把 role profile governance 混入 SWE-bench runner 专项 change。
