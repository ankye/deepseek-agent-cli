# Runner Tool Orchestration Design

## Architecture Boundary / 架构边界

The parent CLI evaluation profile is a dispatcher. It should expose only `core.swe.bench.run` for user-level SWE-bench requests. That is not "too few tools"; it is the supervisor boundary. The complete tool set belongs inside the managed child profile created by `core.swe.bench.run`, where the checkout root, task metadata, harness paths, environment state, and replay artifacts are known.

外层 CLI evaluation profile 是 dispatcher。用户级 SWE-bench 请求只暴露 `core.swe.bench.run`，这不是“工具太少”，而是 supervisor 边界。完整工具集属于 `core.swe.bench.run` 创建的 managed child profile，因为只有那里知道 checkout root、task metadata、harness paths、environment state 与 replay artifacts。

## Required Child Tool Matrix / 必需 Child 工具矩阵

`core.swe.bench.run` must prove the managed child has these tool families before the first child model request:

`core.swe.bench.run` 必须在第一次 child model request 前证明 managed child 具备以下工具族：

| Family | Capabilities | Required evidence |
| --- | --- | --- |
| Environment | `core.env.prepare`, dependency/readiness probes | checkout root, base commit, dependency state, interpreter/test runner availability |
| Source inspection | `core.file.read`, `core.file.list`, `core.search.text`, `core.workspace.glob` | bounded source windows, problem refs, duplicate-read rejection counters |
| Mutation | `core.file.write`, `core.file.edit`, `core.patch.apply` | material diff, changed paths, no-op rejection, anti-tailoring scan |
| Command execution | `core.shell.run` | cwd, argv/shell normalization, timeout, stdout/stderr bounded excerpts |
| Verification | `core.test.run`, standard-test classifier, focused-test ladder | reproduction result, focused test result, broad test only when justified |
| Patch review | `core.git.diff`, artifact scanner | patch summary, changed-file scope, generated prediction patch presence |
| Harness scoring | official harness runner adapter | resolved/unresolved/error, failing test excerpt, prediction artifact path |
| Packaging | prediction/result writer | prediction JSON, summary JSON, child trace, progress ledger, terminal status |

## Orchestration Flow / 编排流程

The runner flow is staged and evidence-gated:

runner 流程必须按 stage 编排并由 evidence gate 控制：

1. `prepare`: create or resume run-scoped checkout, validate base commit, dependency state, harness availability, and workspace locks.
2. `understand`: gather problem statement, relevant source/test evidence, and reproduction hypothesis with duplicate-read controls.
3. `change`: require mutation-grade evidence before source-progress is counted.
4. `verify`: run the low-cost verification ladder and record standard-test classification.
5. `score`: run official harness or record a typed blocker when harness cannot run.
6. `package`: write prediction, child trace, progress ledger, failure category, and terminal result.
7. `return`: return one bounded terminal outcome to the parent supervisor.

## Attribution Rule / 归因规则

Model-owned attribution is last. A task can be labeled model-insufficient only after evidence proves:

模型侧归因必须最后使用。只有证据证明以下条件后，才能标记模型能力不足：

- child tool projection was complete;
- environment and harness were runnable or had typed non-model blockers;
- the model received source evidence, mutation tools, verification feedback, and official harness excerpts when available;
- budget and timeout were sufficient for the declared stage policy;
- prediction packaging was successful or the failure is classified outside model quality.

## Technical Director Acceptance / 技术总监验收

Each runner stage needs a technical-director acceptance record. Acceptance is not "an event exists"; it must judge whether the evidence satisfies the stage criteria. The final runner-readiness acceptance must state whether failures are due to missing tools, projection, budget, environment, harness, packaging, orchestration, or model behavior.

每个 runner stage 都需要技术总监验收记录。验收不是“有输出事件”；它必须判断证据是否满足 stage criteria。最终 runner-readiness 验收必须说明失败属于缺工具、投影、预算、环境、harness、打包、编排，还是模型行为。
