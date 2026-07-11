# Tasks

## OpenSpec / 规格

- [x] Create this OpenSpec change for scheduling fast-path convergence.
- [x] Record architect and technical-director direction.
- [x] Add spec deltas for agent-loop, workflow-orchestration, prompt-assembly, and CLI task-completion evaluation.
- [x] Validate this change with `npx openspec validate 2026-07-08-collapse-agent-scheduling-fast-path --strict`.
- [x] Validate canonical specs with `npx openspec validate --specs --strict`.

- [x] 创建 scheduling fast-path convergence OpenSpec change。
- [x] 记录架构师与技术总监方向。
- [x] 增加 agent-loop、workflow-orchestration、prompt-assembly 与 CLI task-completion evaluation spec delta。
- [x] 使用 `npx openspec validate 2026-07-08-collapse-agent-scheduling-fast-path --strict` 校验本 change。
- [x] 使用 `npx openspec validate --specs --strict` 校验 canonical specs。

## Contract Tests First / 契约测试优先

- [ ] Add failing unit tests for deriving exactly one authoritative next action from active stage, board evidence, dispatch result, and failure-analysis state.
- [ ] Add failing unit tests proving conflicting candidate actions are suppressed with durable diagnostics and are not all projected to the model.
- [x] Add failing prompt-assembly tests proving cache diagnostics, technical-director commentary, full board history, rejected stale actions, raw reasoning, and unredacted tool output stay out of child model-visible messages unless required by the next action.
- [ ] Add failing recovery tests proving a failed child attempt resumes from the board's accepted `nextAllowedAction` instead of unrestricted discovery.
- [ ] Add failing convergence tests proving non-progress produce/verify tools update the decision board before the next model request.
- [x] Add failing tests proving standard verification rejection feeds one correction and then projects only standard verification, not arbitrary shell inspection.
- [ ] Add failing CLI evaluation tests proving trajectory quality reports short-path convergence separately from runtime hard caps and model attribution.

- [ ] 增加失败单元测试：从 active stage、board evidence、dispatch result 与 failure-analysis state 推导唯一权威 next action。
- [ ] 增加失败单元测试：证明冲突 candidate actions 会被持久诊断抑制，且不会全部投影给模型。
- [x] 增加失败 prompt-assembly 测试：证明 cache diagnostics、technical-director commentary、完整 board history、过期 rejected actions、raw reasoning 与未脱敏 tool output 不会进入 child model-visible messages，除非 next action 需要。
- [ ] 增加失败 recovery 测试：证明 failed child attempt 从 board 已接受的 `nextAllowedAction` 恢复，而不是 unrestricted discovery。
- [ ] 增加失败 convergence 测试：证明 produce/verify 无进展工具在下一次 model request 前更新 decision board。
- [x] 增加失败测试：证明 standard verification rejection 只回灌一次 correction，然后只投影 standard verification，而不是任意 shell inspection。
- [ ] 增加失败 CLI evaluation 测试：证明 trajectory quality 报告短路径收敛，且与 runtime hard cap 和 model attribution 分离。

## Runtime Implementation / Runtime 实现

- [ ] Add a flat `agent-loop-next-action.ts` helper that derives `focused-evidence`, `mutation`, `standard-verification`, `package`, `failure-analysis`, `repair`, `rerun`, `blocker`, or `terminal-report` from existing runtime data.
- [x] Wire next-action projection into prompt assembly through existing contracts rather than inline prompt string concatenation.
- [ ] Update convergence so repeated non-progress, repeated invalid verify commands, and second budget review cannot continue as ordinary model/tool cycles.
- [ ] Update decision-board writes so every suppressed candidate action, accepted next action, and recovery entry point is replayable.
- [ ] Update attempt recovery routing to consume accepted failure-analysis evidence and start from the accepted next action.
- [x] Keep provider/model glue generic. Do not add provider-specific scheduler behavior beyond existing model-gateway normalization.

- [ ] 增加扁平的 `agent-loop-next-action.ts` helper，从现有 runtime data 推导 `focused-evidence`、`mutation`、`standard-verification`、`package`、`failure-analysis`、`repair`、`rerun`、`blocker` 或 `terminal-report`。
- [x] 通过现有 contracts 将 next-action projection 接入 prompt assembly，不进行内联 prompt 字符串拼接。
- [ ] 更新 convergence，确保重复无进展、重复 invalid verify command 与第二次 budget review 不得继续作为普通 model/tool cycle。
- [ ] 更新 decision-board 写入，使每个被抑制 candidate action、已接受 next action 与 recovery entry point 可 replay。
- [ ] 更新 attempt recovery routing，消费已接受 failure-analysis evidence 并从 accepted next action 开始。
- [x] 保持 provider/model glue 通用。除现有 model-gateway normalization 外，不增加 provider-specific scheduler behavior。

## Verification / 验证

- [x] Run focused next-action, convergence, prompt-assembly, recovery, and CLI evaluation tests.
- [x] Run `npm run typecheck`.
- [x] Run `npm run build:cli`.
- [ ] Run one first-task canary only after deterministic tests pass.
- [ ] Classify canary quality by model request count, accepted next-action sequence, invalid command count, mutation evidence, verification evidence, cache prefix stability, and terminal result.
- [ ] If canary fails, create a failure-analysis record before another rerun or implementation change.
- [ ] Acceptance Gate 1: deterministic contract evidence proves single next action, suppressed conflicts, prompt filtering, recovery from `nextAllowedAction`, non-progress board updates, and provider-neutral scheduler behavior.
- [ ] Acceptance Gate 2: canary trajectory evidence shows package-successful terminal result, natural focused-evidence/mutation/standard-verification/package shape, mutation before verification acceptance, no repeated broad discovery after focused evidence, and no scheduler prompt churn as cache failure root cause.
- [ ] Acceptance Gate 3: prohibited-behavior scan proves no benchmark hardcode, no fixed five-step runtime cap, no provider-specific scheduler policy, no prompt assembly bypass, no premature model-owned attribution, no parent/child context merge, and no raw reasoning or unredacted tool output in shared board or child prompt.

- [x] 运行 next-action、convergence、prompt-assembly、recovery 与 CLI evaluation focused tests。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run build:cli`。
- [ ] deterministic tests 通过后只运行一个第一题 canary。
- [ ] 按 model request count、accepted next-action sequence、invalid command count、mutation evidence、verification evidence、cache prefix stability 与 terminal result 分类 canary 质量。
- [ ] 如果 canary 失败，必须先创建 failure-analysis record，然后才允许下一次 rerun 或实现修改。
- [ ] Acceptance Gate 1：确定性契约证据证明 single next action、suppressed conflicts、prompt filtering、从 `nextAllowedAction` 恢复、non-progress board updates 与 provider-neutral scheduler behavior。
- [ ] Acceptance Gate 2：canary trajectory evidence 显示 package-successful terminal result、自然 focused-evidence/mutation/standard-verification/package 形态、verification acceptance 前存在 mutation、focused evidence 后不重复 broad discovery，且 scheduler prompt churn 不是 cache failure 根因。
- [ ] Acceptance Gate 3：禁止项扫描证明不存在 benchmark hardcode、固定五步 runtime cap、provider-specific scheduler policy、prompt assembly bypass、过早 model-owned attribution、parent/child context merge，以及 shared board 或 child prompt 中的 raw reasoning / unredacted tool output。
