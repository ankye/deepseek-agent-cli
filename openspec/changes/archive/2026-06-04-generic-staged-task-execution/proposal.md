# Generic Staged Task Execution

## Why

The current live evaluation path can run real GLM tasks, but executable task flow is still too linear: workspace setup, prompt materialization, model execution, checker execution, artifact scan, metrics, and repair signals are concentrated in one task-specific path. Raising budgets helped GLM complete a webpage task, but it did not create a reusable execution shape for coding, webpage, document, benchmark, and future multi-step tasks.

当前 live evaluation 路径已经可以真实运行 GLM 任务，但 executable task flow 仍过于线性：workspace setup、prompt materialization、model execution、checker execution、artifact scan、metrics 与 repair signals 都集中在一条 task-specific 路径里。提高预算让 GLM 能完成网页任务，但没有形成可复用的执行形态，无法自然覆盖 coding、webpage、document、benchmark 与未来多步骤任务。

We need a general state-machine layer where each task run owns state, the controller advances a validated stage graph, and concrete execution is injected through governed executors that reuse the existing runtime scheduler, policy, agent loop, process checks, and artifact scanners. The graph must be generic; webpage generation is only the first migration target.

我们需要一个通用状态机层：每个 task run 拥有自己的状态，controller 推进经过校验的 stage graph，具体执行通过受治理的可注入 executors 完成，并复用现有 runtime scheduler、policy、agent loop、process checks 与 artifact scanners。这个 graph 必须是通用能力；网页生成只是第一个迁移目标。

## What Changes

- Add provider-neutral staged task DTOs in `@deepseek/platform-contracts`: task graph, stage contract, stage state, task run state, stage event, artifact/evidence/check references, and executor result.
- Add runtime-owned staged task state-machine helpers that validate dependencies, expose ready stages, and advance state only through typed events.
- Add an injectable `StageExecutor` boundary. Executors may run agent-loop, process checks, artifact scans, materialization, or deferred/manual steps, but cannot mutate task state directly.
- Add a first-party task profile catalog layout where many domain profiles reuse a small stable executor set.
- Add dynamic task profiles so an AI or controller can generate a temporary task-scoped or session-scoped profile while still passing the same compiler, admission, budget, executor, and typed-ref constraints as catalog profiles.
- Add deterministic profile composition: base profiles, reusable fragments, overlays, and profile-local parameters compile into one validated `CompiledTaskProfile` and one replayable `StageGraph`.
- Add typed pipe references so stages exchange immutable artifact/evidence/check/metric/state references rather than raw large content.
- Add task-run persistence semantics so staged execution can be resumed, replayed, inspected, and scored from typed state events.
- Keep actual capability/process/model execution on existing governed runtime paths; staged task execution records intent and dispatches through injected executors.
- Refactor CLI evaluation toward a staged execution adapter without hardcoding webpage semantics in the controller.

- 在 `@deepseek/platform-contracts` 中新增 provider-neutral staged task DTO：task graph、stage contract、stage state、task run state、stage event、artifact/evidence/check refs 与 executor result。
- 新增 runtime-owned staged task state-machine helpers，用于校验 dependencies、暴露 ready stages，并且只通过 typed events 推进状态。
- 新增可注入 `StageExecutor` 边界。executors 可以运行 agent-loop、process checks、artifact scans、materialization 或 deferred/manual steps，但不得直接修改 task state。
- 增加 first-party task profile catalog layout，让大量领域 profiles 复用少量稳定 executor set。
- 增加 dynamic task profiles，使 AI 或 controller 可以生成 task-scoped / session-scoped 的临时 profile，但仍必须通过与 catalog profiles 相同的 compiler、admission、budget、executor 与 typed-ref 约束。
- 增加 deterministic profile composition：base profiles、可复用 fragments、overlays 与 profile-local parameters 编译为一个经过校验的 `CompiledTaskProfile` 和一个可回放的 `StageGraph`。
- 增加 typed pipe references，使 stages 通过不可变 artifact/evidence/check/metric/state refs 交互，而不是传递大块 raw content。
- 增加 task-run persistence 语义，使 staged execution 可以从 typed state events 恢复、回放、检查与评分。
- 真实 capability/process/model execution 继续走现有受治理 runtime 路径；staged task execution 只记录 intent 并通过 injected executors dispatch。
- 将 CLI evaluation 向 staged execution adapter 重构，controller 不写死网页语义。

## MVP Scope

The first implementation slice is intentionally small:

- Minimal staged task DTOs and profile DTOs.
- Minimal stage states: `pending`, `ready`, `running`, `succeeded`, `failed`, `skipped`.
- Minimal typed refs: `refId`, `type`, `producerStageId`, `scope`, optional `path`, `fingerprint`, `redaction`.
- Deterministic profile composition with base, fragments, and overlays, but overlays only target budget, allowed tools, acceptance, retry, and model-profile hints.
- Dynamic profiles with explicit `source: dynamic`, task/session scope, provenance, stage-count caps, executor-kind admission, budget caps, compiled fingerprints, and task-run snapshots. Dynamic profiles are not written into the static catalog unless promoted through a normal code/OpenSpec change.
- Three executable mechanism kinds: `agent-loop`, `process-check`, and `artifact-scan`; `file-materialize` can remain a profile stage kind represented as data until an executor is needed.
- First profile: `evaluation/webpage-generation.v1`.
- Persistence records enough events and refs for replay diagnostics, but full resume execution can remain a later change.

第一版实现刻意保持很小：

- 最小 staged task DTO 与 profile DTO。
- 最小 stage states：`pending`、`ready`、`running`、`succeeded`、`failed`、`skipped`。
- 最小 typed refs：`refId`、`type`、`producerStageId`、`scope`、可选 `path`、`fingerprint`、`redaction`。
- 支持 base、fragments 与 overlays 的确定性 profile composition，但 overlays 只允许作用于 budget、allowed tools、acceptance、retry 与 model-profile hints。
- 支持 dynamic profiles，并要求显式 `source: dynamic`、task/session scope、provenance、stage-count caps、executor-kind admission、budget caps、compiled fingerprints 与 task-run snapshots。dynamic profiles 不会自动写入 static catalog，除非后续通过正常 code/OpenSpec 变更沉淀。
- 三个 executable mechanism kinds：`agent-loop`、`process-check` 与 `artifact-scan`；`file-materialize` 可先作为数据型 profile stage kind 保留，直到确实需要 executor。
- 第一个 profile：`evaluation/webpage-generation.v1`。
- persistence 先记录足够 events 与 refs 用于 replay diagnostics，完整 resume execution 留到后续变更。

## Profile Catalog Layout

Profiles are durable engineering process assets. Executors stay few and mechanical; profiles can be numerous and domain-specific.

Profiles 是可沉淀的工程流程资产。Executors 保持少量且机制化；profiles 可以很多，并承载领域差异。

Proposed first-party layout:

```text
src/packages/task-profiles/
  package.json
  src/
    index.ts
    registry.ts
    catalog.ts
    compiler.ts
    builders/
      stage-graph-builder.ts
      acceptance-builders.ts
      budget-builders.ts
      ref-builders.ts
    bases/
      evidence-grounded-task.v1.ts
      mutation-with-verification.v1.ts
    fragments/
      materialize-workspace.v1.ts
      collect-project-evidence.v1.ts
      agent-produce-artifacts.v1.ts
      process-check.v1.ts
      artifact-scan.v1.ts
      score-task.v1.ts
      repair-from-check.v1.ts
    overlays/
      live-glm-expanded-budget.v1.ts
      strict-evidence-manifest.v1.ts
      no-remote-dependencies.v1.ts
    profiles/
      evaluation/
        webpage-generation.v1.ts
        webpage-failing-first-repair.v1.ts
        baseline-comparison.v1.ts
      coding/
        typescript-bugfix-regression-first.v1.ts
        typescript-refactor-boundary-safe.v1.ts
      docs/
        evidence-grounded-rewrite.v1.ts
      release/
        npm-prepublish.v1.ts
      security/
        secret-redaction-audit.v1.ts
      tui/
        interaction-regression.v1.ts
```

The package exports typed profile records and graph builders only. It does not execute commands, read local files, call models, call checkers, or import CLI hosts.

该 package 只导出 typed profile records 与 graph builders。它不得执行 commands、读取本地文件、调用 models、调用 checkers 或 import CLI hosts。

Profile compilation order is deterministic:

```text
base profile -> ordered fragments -> ordered overlays -> profile-local parameters -> validate -> fingerprint
```

Profile compilation fails closed on conflicting stage ids, dependency cycles, incompatible executor kinds, duplicate output refs, budget-policy collisions, or acceptance-policy collisions.

Dynamic profile compilation uses the same compiler. The flow is:

```text
task intent -> AI/controller proposes profile JSON -> compiler/admission validates -> fingerprinted compiled graph -> task-run profile snapshot -> optional promotion to catalog
```

Dynamic profiles may be more convenient than catalog lookup for unusual tasks, but they are still data. They cannot introduce new executor code, bypass typed refs, exceed admission caps, or directly edit the controller state machine.

Profile compilation 的顺序必须确定：

```text
base profile -> ordered fragments -> ordered overlays -> profile-local parameters -> validate -> fingerprint
```

当出现 stage id 冲突、dependency cycles、executor kinds 不兼容、output refs 重复、budget-policy 冲突或 acceptance-policy 冲突时，profile compilation 必须 fail closed。

Dynamic profile compilation 使用同一个 compiler。流程为：

```text
task intent -> AI/controller proposes profile JSON -> compiler/admission validates -> fingerprinted compiled graph -> task-run profile snapshot -> optional promotion to catalog
```

Dynamic profiles 对非常规任务比 catalog lookup 更方便，但它们仍然只是数据。它们不能引入新的 executor code、不能绕过 typed refs、不能超过 admission caps，也不能直接修改 controller state machine。

## Non-Goals

- Do not introduce a second scheduler.
- Do not let model output directly redefine the controller state machine.
- Do not hardcode HTML/CSS/JS/evidence/checker as framework concepts.
- Do not create one executor per task or profile; executor kinds must remain a small stable mechanism set.
- Do not store raw generated artifact content inside task run state; store typed refs plus bounded previews and fingerprints.
- Do not replace the existing agent-loop phase planner in this change.

- 不新增第二套 scheduler。
- 不允许模型输出直接改写 controller state machine。
- 不把 HTML/CSS/JS/evidence/checker 写成框架概念。
- 不为每个 task 或 profile 创建一个 executor；executor kinds 必须保持少量稳定机制集合。
- 不把 raw generated artifact content 存入 task run state；只存 typed refs、有界 previews 与 fingerprints。
- 本变更不替换现有 agent-loop phase planner。
