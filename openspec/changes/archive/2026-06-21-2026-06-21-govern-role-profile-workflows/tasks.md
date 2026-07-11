# Tasks

## OpenSpec / 规格

- [x] Create this OpenSpec change for role profile workflow governance.
- [x] Record the boundary between fixed role workflow contracts and dynamic model decisions.
- [x] Define the three catalog layers: role profile, workflow profile, capability profile.
- [x] Define primary vs advisory routing boundaries.
- [x] Define the initial generic engineering workflow.
- [x] Validate this OpenSpec change with `npx openspec validate 2026-06-21-govern-role-profile-workflows --strict`.
- [x] Validate canonical specs with `npx openspec validate --specs --strict`.

- [x] 创建 role profile workflow governance OpenSpec change。
- [x] 记录固定 role workflow contract 与动态模型决策之间的边界。
- [x] 定义三层 catalog：role profile、workflow profile、capability profile。
- [x] 定义 primary 与 advisory 路由边界。
- [x] 定义初始通用工程师 workflow。
- [x] 使用 `npx openspec validate 2026-06-21-govern-role-profile-workflows --strict` 校验本 change。
- [x] 使用 `npx openspec validate --specs --strict` 校验 canonical specs。

## Implementation / 实现

- [x] Add failing coverage proving casual chat remains `coding/general.v1` advisory.
- [x] Add failing coverage proving execution-bearing coding prompts route to `engineering/coding.v1` primary workflow.
- [x] Add failing coverage proving the engineering workflow stages are `understand`, `plan`, `test`, `implement`, `verify`, and `report`.
- [x] Add failing coverage proving the engineering primary workflow emits ready-stage control before model dispatch.
- [x] Add failing coverage proving stable profile contract and dynamic run state remain separately represented.
- [x] Implement execution-bearing prompt classification without benchmark, repository, task id, or expected-answer tailoring.
- [x] Compile `engineering/coding.v1` into staged-task workflow metadata with allowed capability profiles per stage.
- [x] Preserve advisory behavior for pure chat and low-risk explanation prompts.
- [x] Surface role/workflow/capability profile ids in prompt assembly and provider request metadata.
- [x] Add failing coverage proving a primary ready-stage required-action miss receives exactly one bounded corrective feedback turn before the loop fails closed.
- [x] Add failing coverage proving a model can recover from the corrective feedback by calling the required ready-stage capability on the next iteration.
- [x] Implement generic required-action miss correction for primary staged workflows without benchmark, repository, task id, or expected-answer tailoring.
- [x] Record correction attempts in visible runtime events and model request replay evidence.

- [x] 增加失败测试，证明闲聊仍使用 `coding/general.v1` advisory。
- [x] 增加失败测试，证明具备执行性质的 coding prompt 路由到 `engineering/coding.v1` primary workflow。
- [x] 增加失败测试，证明 engineering workflow stages 为 `understand`、`plan`、`test`、`implement`、`verify` 与 `report`。
- [x] 增加失败测试，证明 engineering primary workflow 在模型派发前发出 ready-stage control。
- [x] 增加失败测试，证明稳定 profile contract 与动态 run state 分离表达。
- [x] 实现 execution-bearing prompt classification，不基于 benchmark、repository、task id 或 expected-answer 定制。
- [x] 将 `engineering/coding.v1` 编译为 staged-task workflow metadata，并为每个 stage 配置 allowed capability profile。
- [x] 保留纯聊天与低风险解释 prompt 的 advisory 行为。
- [x] 在 prompt assembly 与 provider request metadata 中暴露 role/workflow/capability profile id。
- [x] 增加失败测试，证明 primary ready-stage required-action 缺失时只获得一次有界纠偏反馈，然后 loop 才 fail closed。
- [x] 增加失败测试，证明模型可在纠偏反馈后的下一轮调用 required ready-stage capability 并恢复执行。
- [x] 实现 primary staged workflow 的通用 required-action miss 纠偏，不基于 benchmark、repository、task id 或 expected-answer 定制。
- [x] 在可见 runtime event 与 model request replay evidence 中记录纠偏尝试。

## Verification / 验证

- [x] Run focused model selection tests: `npx tsx --test src/apps/cli/src/host/model-selection.test.ts`.
- [x] Run focused runtime workflow projection tests after implementation.
- [x] Run `npm run typecheck`.
- [x] Run `npm run lint`.
- [x] Run `node scripts/check-boundaries.mjs`.
- [x] Run `npm test`.
- [x] Run one CLI scheduling smoke after deterministic tests pass; record whether engineering prompts now show primary ready-stage control.
  - 2026-06-21 smoke `cli-engineering-profile-scheduling-smoke-20260621`: engineering prompt selected `engineering/coding.v1`, emitted `workflow.ready-stage.control`, exposed `stage:understand` with allowed capabilities `core.file.read|core.file.list|core.search.text|core.workspace.glob|core.shell.run`, then failed closed because the model did not request the required workflow action. This confirms scheduling boundary correctness but not downstream model compliance.
  - 2026-06-21 after-correction smoke `cli-engineering-profile-scheduling-smoke-20260621-after-correction`: engineering prompt selected `engineering/coding.v1`, emitted 2 `workflow.ready-stage.control` events and 2 `model.requested` events; first no-tool miss recorded `retryPolicy=correct-once`, second no-tool miss recorded `retryPolicy=fail-closed`. This confirms the runtime correction loop is active, while the provider still failed to issue a tool call.

- [x] 运行 model selection focused 测试：`npx tsx --test src/apps/cli/src/host/model-selection.test.ts`。
- [x] 实现后运行 runtime workflow projection focused 测试。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run lint`。
- [x] 运行 `node scripts/check-boundaries.mjs`。
- [x] 运行 `npm test`。
- [x] deterministic tests 通过后运行一次 CLI 调度 smoke；记录 engineering prompt 是否显示 primary ready-stage control。
