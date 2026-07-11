# Tasks

## OpenSpec / 规格

- [x] Create this OpenSpec change for systemic agent tool dispatch and convergence.
- [x] Record task/profile/dispatch/convergence responsibilities.
- [x] Record dispatch robustness and fault-tolerance responsibilities.
- [x] Add agent-loop and workflow-orchestration spec deltas.
- [x] Validate this OpenSpec change with `npx openspec validate 2026-06-29-systematize-agent-tool-dispatch --strict`.
- [x] Validate canonical specs with `npx openspec validate --specs --strict`.

- [x] 创建 systemic agent tool dispatch and convergence OpenSpec change。
- [x] 记录 task/profile/dispatch/convergence 职责。
- [x] 记录 dispatch 健壮性与容错职责。
- [x] 增加 agent-loop 与 workflow-orchestration spec delta。
- [x] 使用 `npx openspec validate 2026-06-29-systematize-agent-tool-dispatch --strict` 校验本 change。
- [x] 使用 `npx openspec validate --specs --strict` 校验 canonical specs。

## Dispatch Contracts / 调度契约

- [x] Add failing tests for V1 single-item batch planning: one model tool call becomes one dispatch item with preserved ids and side-effect classification.
- [x] Add failing tests for final tool batch partitioning: consecutive `none/read` tools form a concurrent-safe batch, mutation/process/network/unknown tools run serially.
- [ ] Add failing tests proving batch planning preserves provider tool-call ids, resolved capability ids, normalized input hashes, and model iteration number.
- [ ] Add failing tests proving rejected preflight, workflow boundary rejection, output contract rejection, hook block, and tool-call-limit rejection each produce one bounded model-facing feedback record.
- [ ] Add failing tests proving discarded or aborted dispatch attempts cannot feed orphan tool results into a later model request.
- [x] Implement `agent-loop-tool-batches.ts` with flat functions and DTOs.
- [ ] Implement `agent-loop-tool-dispatch.ts` DTO builders for rejection/result feedback without benchmark-specific branches.
- [ ] Keep kernel execution behind the existing scheduler, policy, resource-lock, hook, and evidence pipeline.

- [ ] 增加 V1 single-item batch planning 失败测试：一个模型 tool call 变成一个 dispatch item，并保留 ids 与 side-effect classification。
- [ ] 增加最终 tool batch partitioning 失败测试：连续 `none/read` 工具形成 concurrent-safe batch，mutation/process/network/unknown 工具串行。
- [ ] 增加失败测试，证明 batch planning 保留 provider tool-call ids、resolved capability ids、normalized input hashes 与 model iteration number。
- [ ] 增加失败测试，证明 rejected preflight、workflow boundary rejection、output contract rejection、hook block 与 tool-call-limit rejection 各自产生一个有界 model-facing feedback record。
- [ ] 增加失败测试，证明 discarded 或 aborted dispatch attempts 不能把 orphan tool results 回灌到后续 model request。
- [ ] 实现 `agent-loop-tool-batches.ts`，使用 flat functions 与 DTO。
- [ ] 在 `agent-loop-tool-dispatch.ts` 中实现 rejection/result feedback 的 DTO builders，不包含 benchmark-specific branches。
- [ ] 保持 kernel execution 经过现有 scheduler、policy、resource-lock、hook 与 evidence pipeline。

## Robustness And Fault Tolerance / 健壮性与容错

- [ ] Add failing tests proving every accepted dispatch item reaches exactly one terminal lifecycle status: `completed`, `failed`, `rejected`, `cancelled`, `timed-out`, or `abandoned`.
- [ ] Add failing tests proving cancellation releases in-progress tool ids, emits bounded feedback, and prevents late results from entering model-visible messages.
- [ ] Add failing tests proving timeouts are classified separately from executor failure and carry elapsed time, timeout limit, and last progress marker.
- [ ] Add failing tests proving partial results are recorded as evidence but do not advance workflow stages unless the capability contract declares partial success.
- [ ] Add failing tests proving retry eligibility is denied for unsafe mutation/process/network tools unless idempotency and stage policy allow retry, and retry execution remains a convergence decision.
- [ ] Add failing tests proving fallback/discarded attempts quarantine stale tool results and preserve one feedback record per original tool-call id.
- [x] Add failing tests proving dispatch summaries include batch id, in-progress ids, terminal ids, elapsed time, diagnostics, evidence refs, and convergence decision.
- [ ] Implement typed dispatch terminal summaries and stale-result quarantine in the dispatch layer. (Pure DTO/helper and normal execution-path summary are in place; rejection/cancellation/abandoned paths still need full integration.)
- [ ] Implement retry classification as pure policy data, not benchmark-specific or prompt-specific logic.

- [ ] 增加失败测试，证明每个 accepted dispatch item 到达且只到达一个 terminal lifecycle status：`completed`、`failed`、`rejected`、`cancelled`、`timed-out` 或 `abandoned`。
- [ ] 增加失败测试，证明 cancellation 会释放 in-progress tool ids、发出有界 feedback，并阻止 late results 进入 model-visible messages。
- [ ] 增加失败测试，证明 timeout 与 executor failure 分开分类，并携带 elapsed time、timeout limit 与 last progress marker。
- [ ] 增加失败测试，证明 partial results 会记录为 evidence，但除非 capability contract 声明 partial success，否则不推进 workflow stages。
- [ ] 增加失败测试，证明 unsafe mutation/process/network tools 默认不允许 retry，除非 idempotency 与 stage policy 允许，且 retry execution 仍由 convergence 决定。
- [ ] 增加失败测试，证明 fallback/discarded attempts 会隔离 stale tool results，并为每个原始 tool-call id 保持一个 feedback record。
- [x] 增加失败测试，证明 dispatch summaries 包含 batch id、in-progress ids、terminal ids、elapsed time、diagnostics、evidence refs 与 convergence decision。
- [ ] 在 dispatch layer 实现 typed dispatch terminal summaries 与 stale-result quarantine。（纯 DTO/helper 与正常执行路径 summary 已接入；rejection/cancellation/abandoned 路径仍需完整集成。）
- [ ] 将 retry classification 实现为纯 policy data，不包含 benchmark-specific 或 prompt-specific logic。

## Convergence Contracts / 收敛契约

- [x] Add failing tests proving budget exhaustion routes to review/correction/blocker decisions instead of immediate terminal failure unless a hard terminal limit is configured.
- [x] Add failing tests proving repeated rejected intent triggers a convergence decision requiring different input, different projected tool, or bounded blocker.
- [x] Add failing tests proving ready-stage required-action misses are bounded by correction attempts and produce durable terminal evidence when exhausted.
- [ ] Add failing tests proving supervisor-reviewed produce stages keep mutation progress capabilities instead of projecting downstream verification tools.
- [ ] Add failing tests proving stage budget exhaustion cannot continue as another ordinary model/tool cycle after review feedback is already emitted.
- [ ] Add failing tests proving non-progress produce/verify stage tools update the decision board before the next model request.
- [x] Add failing tests proving collect-evidence stages reject broad root discovery and require focused repository evidence before downstream mutation-only stages.
- [x] Add failing tests proving failed attempts enter a standardized failure-analysis loop before rerun: classify failure, assign attribution, search evidence, prove/disprove attribution, then choose repair/rerun/stop.
- [x] Add failing tests proving model-owned attribution is impossible until framework scheduling, tool availability, environment, harness/adapter, cache, prompt/reproduction, and repair-feedback causes have explicit exclusion evidence.
- [x] Add failing tests proving a rerun or repair attempt receives the previous attempt's accepted failure-analysis evidence through the shared board, without merging parent/child model contexts.
- [x] Document that short effective solution paths, such as the supervised five-step first-task rubric, are external trajectory-quality checks and not CLI runtime step caps or benchmark hardcode.
- [x] Implement `agent-loop-convergence.ts` with pure transition decisions: `continue`, `retry-with-feedback`, `review-required`, `repair-required`, `terminal`.
- [x] Implement failure-analysis convergence decisions: `analyze-failure`, `search-evidence`, `prove-attribution`, `repair-required`, `rerun-allowed`, and `stop-with-classification`.
- [x] Implement focused collect-evidence stage acceptance for read, list, search, glob, and diff evidence without benchmark-specific branches.
- [ ] Refactor `agent-loop.ts` to apply convergence decisions instead of embedding each decision inline. (Partial: repeated rejected intent, ready-stage budget, ready-stage required-action miss, and terminal tool completion now use convergence helpers.)

- [x] 增加失败测试，证明 budget exhaustion 路由到 review/correction/blocker decisions，而不是直接 terminal failure，除非配置 hard terminal limit。
- [x] 增加失败测试，证明 repeated rejected intent 会触发 convergence decision，要求 different input、different projected tool 或 bounded blocker。
- [x] 增加失败测试，证明 ready-stage required-action miss 受 correction attempts 限制，并在耗尽时产生 durable terminal evidence。
- [ ] 增加失败测试，证明 supervisor-reviewed produce stage 保持 mutation progress capabilities，而不是投影下游 verification tools。
- [ ] 增加失败测试，证明 stage budget exhaustion 在 review feedback 已发出后不得继续作为普通 model/tool cycle 执行。
- [ ] 增加失败测试，证明 non-progress produce/verify stage tools 在下一次 model request 前更新 decision board。
- [x] 增加失败测试，证明 collect-evidence stage 会拒绝宽泛根目录 discovery，并要求聚焦 repository evidence 后才能进入下游 mutation-only stage。
- [x] 增加失败测试，证明失败 attempt 在 rerun 前必须进入标准化 failure-analysis loop：分类失败、分配归因、搜索证据、证明/反证归因，然后选择 repair/rerun/stop。
- [x] 增加失败测试，证明只有 framework scheduling、tool availability、environment、harness/adapter、cache、prompt/reproduction 与 repair-feedback 原因都有明确排除证据后，才能归因为 model-owned。
- [x] 增加失败测试，证明 rerun 或 repair attempt 会通过共享 board 接收上一 attempt 的已接受 failure-analysis evidence，但不会合并 parent/child model context。
- [x] 记录短有效解题路径（例如受监督的第一题五步 rubric）是外部 trajectory-quality 检查，不是 CLI runtime step cap 或 benchmark hardcode。
- [x] 实现 `agent-loop-convergence.ts`，提供纯 transition decisions：`continue`、`retry-with-feedback`、`review-required`、`repair-required`、`terminal`。
- [x] 实现 failure-analysis convergence decisions：`analyze-failure`、`search-evidence`、`prove-attribution`、`repair-required`、`rerun-allowed` 与 `stop-with-classification`。
- [x] 实现 read、list、search、glob 与 diff evidence 的 focused collect-evidence stage acceptance，不包含 benchmark-specific branches。
- [ ] 重构 `agent-loop.ts`，应用 convergence decisions，而不是内联每个 decision。（部分完成：repeated rejected intent、ready-stage budget、ready-stage required-action miss 与 terminal tool completion 已使用 convergence helpers。）

## Parent/Child Board And Attempt Recovery / 父子看板与 Attempt 恢复

- [ ] Add failing contract tests for the isolation boundary: parent and child never share mutable session ids, workspace roots, model-visible messages, provider history, context projections, visible tool projections, raw provider reasoning, or unredacted tool output.
- [x] Add failing contract tests for the shared boundary: board records lineage ids, active stage, dispatch summaries, convergence decisions, failure-analysis records, accepted evidence refs, and next allowed action.
- [ ] Add failing contract tests for decision authority: dispatch executes tools, convergence chooses repair/rerun/stop, workflow advances stages, and technical-director policy gates supervisor acceptance and model-owned attribution.
- [x] Add failing tests proving parent and child agent runs write to one durable decision-board/evidence ledger while keeping separate session ids, workspace roots, prompt histories, and context projections.
- [ ] Add failing tests proving child dispatch summaries are streamed or imported into the parent board with stage id, attempt id, terminal status, attribution, evidence refs, and next allowed action.
- [ ] Add failing tests proving a failed child attempt cannot start the next attempt from a blank understand stage when accepted failure-analysis evidence requires repair/change/verify.
- [x] Add failing tests proving board state never includes raw provider reasoning or unredacted child context; it stores bounded evidence pointers and replayable summaries only.
- [x] Implement board lineage ids for parent run, child run, attempt, stage, dispatch batch, tool-call id, terminal event, and evidence refs.
- [ ] Implement attempt recovery routing from accepted failure-analysis evidence to the next stage/action.

- [ ] 增加 isolation boundary 失败契约测试：parent 与 child 永不共享可变的 session ids、workspace roots、model-visible messages、provider history、context projections、visible tool projections、raw provider reasoning 或未脱敏 tool output。
- [x] 增加 shared boundary 失败契约测试：board 记录 lineage ids、active stage、dispatch summaries、convergence decisions、failure-analysis records、accepted evidence refs 与 next allowed action。
- [ ] 增加 decision authority 失败契约测试：dispatch 执行工具，convergence 选择 repair/rerun/stop，workflow 推进 stage，technical-director policy gate supervisor acceptance 与 model-owned attribution。
- [x] 增加失败测试，证明 parent 与 child agent run 写入同一个 durable decision-board/evidence ledger，同时保持独立 session id、workspace root、prompt history 与 context projection。
- [ ] 增加失败测试，证明 child dispatch summaries 会流式写入或导入 parent board，包含 stage id、attempt id、terminal status、attribution、evidence refs 与 next allowed action。
- [ ] 增加失败测试，证明当已接受 failure-analysis evidence 要求 repair/change/verify 时，失败 child attempt 不能让下一次 attempt 从空白 understand stage 重新开始。
- [x] 增加失败测试，证明 board state 不包含 raw provider reasoning 或未脱敏 child context；只保存有界 evidence pointers 与可 replay summaries。
- [x] 实现 parent run、child run、attempt、stage、dispatch batch、tool-call id、terminal event 与 evidence refs 的 board lineage ids。
- [ ] 实现基于已接受 failure-analysis evidence 的 attempt recovery routing。

## Agent Loop Refactor / Agent Loop 重构

- [ ] Move tool-call-limit rejection construction out of `agent-loop.ts`.
- [ ] Move repeated rejected intent suppression result construction out of `agent-loop.ts`.
- [ ] Move ready-stage tool budget review result construction out of `agent-loop.ts`.
- [ ] Move preflight rejection result construction out of `agent-loop.ts`.
- [ ] Move workflow boundary, output contract, required-action, and hook-block rejection construction out of `agent-loop.ts`.
- [ ] Move successful/failed execution feedback construction out of `agent-loop.ts`.
- [ ] Keep `agent-loop.ts` as the thin model-stream orchestrator: emit model events, delegate dispatch, apply convergence, emit terminal events.

- [ ] 将 tool-call-limit rejection construction 移出 `agent-loop.ts`。
- [ ] 将 repeated rejected intent suppression result construction 移出 `agent-loop.ts`。
- [ ] 将 ready-stage tool budget review result construction 移出 `agent-loop.ts`。
- [ ] 将 preflight rejection result construction 移出 `agent-loop.ts`。
- [ ] 将 workflow boundary、output contract、required-action 与 hook-block rejection construction 移出 `agent-loop.ts`。
- [ ] 将 successful/failed execution feedback construction 移出 `agent-loop.ts`。
- [ ] 保持 `agent-loop.ts` 为薄 model-stream orchestrator：发出 model events、委托 dispatch、应用 convergence、发出 terminal events。

## Verification / 验证

- [x] Run focused dispatch/convergence unit tests.
- [x] Run `npm run typecheck`.
- [x] Run `npm run lint`.
- [x] Run `node scripts/check-boundaries.mjs`.
- [x] Run focused runtime agent-loop tests that are not tied to benchmark hardcode.
- [ ] Run one first-task canary only after deterministic tests pass; classify remaining failure as dispatch, convergence, tool availability, environment, harness/adapter, or model-owned behavior.

- [ ] 运行 dispatch/convergence focused unit tests。
- [ ] 运行 `npm run typecheck`。
- [x] 运行 `npm run lint`。
- [x] 运行 `node scripts/check-boundaries.mjs`。
- [x] 运行不依赖 benchmark hardcode 的 runtime agent-loop focused tests。
- [ ] deterministic tests 通过后只运行一个第一题 canary；将剩余失败分类为 dispatch、convergence、tool availability、environment、harness/adapter 或 model-owned behavior。
