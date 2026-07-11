# Complete Runner Tool Orchestration

## Why

The latest single-task canary proves the outer staged workflow now dispatches correctly: the model saw one governed terminal tool, called it, and the supervisor closed on terminal failure. The remaining failure is inside the managed runner path. We need a generic capability/tool and orchestration checklist for the child run before blaming model quality or expanding benchmark volume.

最新单题 canary 证明外层 staged workflow 已正确派发：模型只看到一个受治理终端工具、调用了它，并且 supervisor 在终态失败后关闭。剩余失败位于受管 runner 内部。在归因模型质量或扩展 benchmark 批量前，需要为 child run 建立通用 capability/tool 与编排清单。

## What Changes

- Define the parent dispatcher, terminal runner capability, and managed child solver as separate workflow roles.
- Require `core.swe.bench.run` to audit and project a complete child tool matrix before model dispatch.
- Require stage-by-stage orchestration for environment preparation, evidence collection, source mutation, verification, harness scoring, prediction packaging, and result return.
- Require each child tool family to produce typed evidence, progress counters, failure taxonomy, and replayable artifacts.
- Require technical-director acceptance criteria for runner readiness before model-owned failure attribution.

- 明确 parent dispatcher、terminal runner capability 与 managed child solver 是不同 workflow role。
- 要求 `core.swe.bench.run` 在模型派发前审计并投影完整 child 工具矩阵。
- 要求按阶段编排环境准备、证据收集、源码修改、验证、harness 评分、prediction 打包与结果返回。
- 要求每个 child 工具族输出 typed evidence、progress counters、failure taxonomy 与可回放 artifacts。
- 要求在归因为模型能力前，先通过技术总监验收 runner readiness。

## Non-Goals

- Do not expose child file/search/edit/test tools directly to the outer user-level SWE-bench dispatcher.
- Do not add repo-name, task-number, instance-id, or expected-patch tailoring.
- Do not manually solve benchmark tasks or encode expected patches.
- Do not expand to task 11/12 or larger batches until ramp gates pass.

- 不把 child file/search/edit/test 工具直接暴露给外层用户级 SWE-bench dispatcher。
- 不增加基于 repo name、task number、instance id 或 expected patch 的定制。
- 不手工解 benchmark 题或编码预期 patch。
- ramp gates 未通过前，不扩展到第 11/12 题或更大批次。
