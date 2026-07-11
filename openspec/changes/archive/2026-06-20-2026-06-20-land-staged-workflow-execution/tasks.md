# Tasks

## Architecture Checklist / 架构落地清单

- [x] Create this OpenSpec change for staged workflow execution landing.
- [x] Record the current architecture finding: profile/staged workflow exists but is only partially enforced.
- [x] Define the architecture director checklist for intent, profile, compiled graph, ready-stage control, projection, no-tool policy, terminal close, timeout inheritance, and stall recovery.
- [x] Record host/profile/test ownership boundaries so CLI smoke tests do not own benchmark orchestration semantics.
- [x] Validate this OpenSpec change with `npx openspec validate 2026-06-20-land-staged-workflow-execution --strict`.
- [x] Validate canonical specs with `npx openspec validate --specs --strict`.

- [x] 创建 staged workflow execution 落地 OpenSpec change。
- [x] 记录当前架构发现：profile/staged workflow 已存在但只部分强制执行。
- [x] 定义架构负责人清单，覆盖 intent、profile、compiled graph、ready-stage control、projection、no-tool policy、terminal close、timeout inheritance 与 stall recovery。
- [x] 记录 host/profile/test ownership 边界，避免 CLI smoke 测试承载 benchmark orchestration 语义。
- [x] 使用 `npx openspec validate 2026-06-20-land-staged-workflow-execution --strict` 校验本 change。
- [x] 使用 `npx openspec validate --specs --strict` 校验 canonical specs。

## Test-First Implementation / 测试先行实现

- [x] Add failing runtime coverage proving a primary governed workflow with a single ready terminal capability emits a ready-stage control record before the first model request.
- [x] Add failing runtime coverage proving a required-action model turn with no tool call emits a typed no-progress event and terminates or retries by workflow policy instead of consuming generic loop budget indefinitely.
- [x] Add failing tool-projection coverage proving governed primary workflow projection fails closed when declared workflow capabilities are unavailable or projected out.
- [x] Add failing runtime coverage proving terminal workflow capability completion closes the supervising loop exactly once.
- [x] Add failing staged-task coverage proving a stage with output refs but no passing evaluation result is not marked succeeded.
- [x] Add failing staged-task coverage proving stage evaluation records score/status/reason/evidence refs before state transition.
- [x] Add failing staged-task coverage proving a passing evaluator result without technical-director acceptance cannot mark the stage succeeded.
- [x] Add failing pipeline coverage proving downstream expansion is blocked until technical-director acceptance confirms criteria applicability and evidence sufficiency.
- [x] Add failing timeout coverage proving nested capability timeout is capped by the caller deadline and cannot be inflated by model-supplied `timeoutMs`.
- [x] Add failing child/stage recovery coverage proving a child process or provider stream that exits/stalls without an agent terminal event still writes typed summary/progress evidence.
- [x] Add focused host profile coverage proving ordinary prompts remain advisory while evaluation prompts compile primary staged workflows without using CLI smoke fixtures.
- [x] Implement ready-stage control derivation from compiled staged-task workflow state.
- [x] Thread ready-stage control into prompt assembly, model request events, provider request audit metadata, and visible reasoning summaries.
- [x] Enforce no-tool required-action policy in the agent loop.
- [x] Tighten governed primary workflow tool projection and boundary failure semantics.
- [x] Implement terminal workflow capability close semantics without benchmark-specific branching.
- [x] Implement generic stage evaluation before stage success transitions, including `passed`, `needs-review`, `failed`, and `blocked` statuses.
- [x] Implement technical-director acceptance records for every stage/pipeline evaluation before final success transitions.
- [x] Implement timeout inheritance/capping for model-requested tool inputs and nested child runs.
- [x] Implement durable child/stage stall recovery summaries at the supervisor boundary.
- [x] Move benchmark profile orchestration assertions out of the broad CLI smoke suite into focused host/profile or runtime tests.
- [x] Run focused tests for runtime agent loop, agent-loop tools, CLI profile model selection, SWE-bench run capability diagnostics, and timeout handling.
- [x] Run `npm run typecheck`.
- [x] Run `npm run lint`.
- [x] Run `node scripts/check-boundaries.mjs`.
- [x] Run `npm test` after focused tests pass.
- [x] Only after the basic workflow checklist passes, run one single-task canary as architecture evidence; do not expand batch volume. Evidence: `.deepseek/verification/deepseek-swe-lite-task-2-staged-workflow-canary-20260621-1.jsonl` emitted one ready-stage control, one model request, one governed terminal capability call, zero `workflow.required-action.missed` records, and closed with `terminal-tool-failed` after `core.swe.bench.run` returned `CLI_SWE_BENCH_RUN_FAILED`; this proves supervisor close behavior, not benchmark pass.

- [x] 增加失败的 runtime 覆盖：primary governed workflow 若只有一个 ready terminal capability，必须在第一次 model request 前发出 ready-stage control record。
- [x] 增加失败的 runtime 覆盖：存在 required action 时，模型无 tool-call 的轮次必须发出 typed no-progress event，并按 workflow policy 终止或重试，而不是无限消耗通用 loop budget。
- [x] 增加失败的 tool-projection 覆盖：governed primary workflow 的声明能力不可用或被投影掉时必须 fail closed。
- [x] 增加失败的 runtime 覆盖：terminal workflow capability 完成后 supervising loop 只关闭一次。
- [x] 增加失败的 staged-task 覆盖：stage 只有 output refs 但没有 passing evaluation result 时，不得标记 succeeded。
- [x] 增加失败的 staged-task 覆盖：stage evaluation 必须在状态迁移前记录 score/status/reason/evidence refs。
- [x] 增加失败的 staged-task 覆盖：只有 evaluator pass 但没有技术总监验收时，不得标记 stage succeeded。
- [x] 增加失败的 pipeline 覆盖：技术总监未确认验收标准适用与证据充分前，阻止下游扩展。
- [x] 增加失败的 timeout 覆盖：嵌套 capability timeout 受 caller deadline 限制，不能被模型传入的 `timeoutMs` 放大。
- [x] 增加失败的 child/stage recovery 覆盖：child process 或 provider stream 在没有 agent terminal event 的情况下退出/卡住时，仍必须写 typed summary/progress evidence。
- [x] 增加 focused host profile 覆盖：普通 prompt 保持 advisory，evaluation prompt 编译 primary staged workflow，且不依赖 CLI smoke fixture。
- [x] 从 compiled staged-task workflow state 实现 ready-stage control 推导。
- [x] 将 ready-stage control 传入 prompt assembly、model request events、provider request audit metadata 与 visible reasoning summaries。
- [x] 在 agent loop 中强制 no-tool required-action policy。
- [x] 收紧 governed primary workflow 的 tool projection 与 boundary failure 语义。
- [x] 实现 terminal workflow capability close semantics，且不做 benchmark-specific branching。
- [x] 在 stage success transition 前实现通用 stage evaluation，包含 `passed`、`needs-review`、`failed` 与 `blocked` 状态。
- [x] 为每个 stage/pipeline evaluation 实现技术总监验收记录，之后才允许最终成功迁移。
- [x] 为模型请求的 tool input 与嵌套 child run 实现 timeout inheritance/capping。
- [x] 在 supervisor boundary 实现 durable child/stage stall recovery summaries。
- [x] 将 benchmark profile orchestration 断言从宽泛 CLI smoke suite 迁移到 focused host/profile 或 runtime 测试。
- [x] 运行 runtime agent loop、agent-loop tools、CLI profile model selection、SWE-bench run capability diagnostics 与 timeout handling 的 focused tests。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run lint`。
- [x] 运行 `node scripts/check-boundaries.mjs`。
- [x] focused tests 通过后运行 `npm test`。
- [x] 基础 workflow checklist 通过后，才运行一个单题 canary 作为架构证据；不得扩批。证据：`.deepseek/verification/deepseek-swe-lite-task-2-staged-workflow-canary-20260621-1.jsonl` 产生了 1 条 ready-stage control、1 次 model request、1 次 governed terminal capability 调用、0 条 `workflow.required-action.missed`，并在 `core.swe.bench.run` 返回 `CLI_SWE_BENCH_RUN_FAILED` 后以 `terminal-tool-failed` 关闭；这证明 supervisor close 行为，不代表 benchmark 已通过。
