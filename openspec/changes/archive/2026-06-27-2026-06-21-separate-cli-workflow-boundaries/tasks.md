# Tasks

## OpenSpec / 规格

- [x] Create this OpenSpec change for CLI workflow boundary separation.
- [x] Define ordinary CLI workflow, evaluation runner workflow, and staged-task contract boundaries.
- [x] Define explicit governance and stage acceptance modes.
- [x] Validate this change with `npx openspec validate 2026-06-21-separate-cli-workflow-boundaries --strict`.
- [x] Validate canonical specs with `npx openspec validate --specs --strict`.

- [x] 创建 CLI workflow boundary separation OpenSpec change。
- [x] 定义普通 CLI workflow、evaluation runner workflow 与 staged-task contract 边界。
- [x] 定义显式 governance 与 stage acceptance modes。
- [x] 使用 `npx openspec validate 2026-06-21-separate-cli-workflow-boundaries --strict` 校验本 change。
- [x] 使用 `npx openspec validate --specs --strict` 校验 canonical specs。

## Implementation / 实现

- [x] Add failing coverage proving ordinary CLI engineering workflow auto-advances from accepted runtime evidence.
- [x] Add failing coverage proving evaluation workflow still requires supervisor/technical-director acceptance.
- [x] Add failing coverage proving active CLI workflows without a ready stage do not fall back to all tools.
- [x] Add profile metadata for workflow governance and stage acceptance modes.
- [x] Route `engineering/coding.v1` to `standard + automatic`.
- [x] Route `evaluation/swe-bench-lite.v1` to `evaluation + supervisor`.
- [x] Implement automatic runtime stage success for standard CLI workflows.
- [x] Keep supervisor acceptance for evaluation/runner workflows only.
- [x] Emit typed orchestration blocker when an active primary staged workflow has no ready stage and no terminal state.
- [x] Add failing coverage proving ordinary CLI plan stages advance from declared planning evidence.
- [x] Add failing coverage proving completed stages are not reopened by later stage evidence.
- [x] Implement ordinary CLI plan-stage evidence acceptance without relaxing mutation-stage acceptance.
- [x] Add failing coverage proving explicitly read-only analysis prompts do not enter mutation workflows.
- [x] Add a read-only CLI analysis profile with only read/search/diff stages.
- [x] Implement read-only evidence-stage completion without relaxing mutation-stage completion.
- [x] Add failing coverage proving same-response multiple tool calls use the latest workflow state.
- [x] Implement same-response workflow progression from the active profile state rather than the iteration snapshot.
- [x] Add failing coverage proving automatic primary workflows close when every stage reaches terminal success.
- [x] Implement generic automatic workflow completion instead of continuing to model iteration exhaustion.

- [x] 增加失败测试，证明普通 CLI engineering workflow 可根据 runtime 已接受证据自动推进。
- [x] 增加失败测试，证明 evaluation workflow 仍需要 supervisor/technical-director 验收。
- [x] 增加失败测试，证明 active CLI workflow 没有 ready stage 时不会回退到全量工具。
- [x] 增加 workflow governance 与 stage acceptance modes profile metadata。
- [x] 将 `engineering/coding.v1` 路由为 `standard + automatic`。
- [x] 将 `evaluation/swe-bench-lite.v1` 路由为 `evaluation + supervisor`。
- [x] 为 standard CLI workflows 实现 automatic runtime stage success。
- [x] 只为 evaluation/runner workflows 保留 supervisor acceptance。
- [x] active primary staged workflow 没有 ready stage 且未终态时发出 typed orchestration blocker。
- [x] 增加失败测试，证明普通 CLI plan stage 可由声明的 planning evidence 推进。
- [x] 增加失败测试，证明已完成 stage 不会被后续 stage evidence 重新打开。
- [x] 实现普通 CLI plan-stage evidence acceptance，但不放宽 mutation-stage acceptance。
- [x] 增加失败测试，证明显式只读分析 prompt 不会进入 mutation workflow。
- [x] 增加只读 CLI analysis profile，阶段只包含 read/search/diff 能力。
- [x] 实现 read-only evidence stage completion，但不放宽 mutation stage completion。
- [x] 增加失败测试，证明同一次模型响应中的多个 tool call 使用最新 workflow state。
- [x] 使用 active profile state 推进同响应 workflow，而不是固定使用 iteration snapshot。
- [x] 增加失败测试，证明 automatic primary workflow 在所有 stage 成功后关闭。
- [x] 实现通用 automatic workflow completion，避免继续请求模型直到迭代耗尽。

## Verification / 验证

- [x] Run focused runtime workflow boundary tests.
- [x] Run focused CLI model-selection/profile tests.
- [x] Run focused ordinary CLI plan-stage regression tests.
- [x] Run focused read-only analysis workflow regression tests.
- [x] Run `npm run typecheck`.
- [x] Run `npm run lint`.
- [x] Run `node scripts/check-boundaries.mjs`.
- [x] Run `npm test`.

- [x] 运行 runtime workflow boundary focused tests。
- [x] 运行 CLI model-selection/profile focused tests。
- [x] 运行普通 CLI plan-stage focused regression tests。
- [x] 运行只读 analysis workflow focused regression tests。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run lint`。
- [x] 运行 `node scripts/check-boundaries.mjs`。
- [x] 运行 `npm test`。
