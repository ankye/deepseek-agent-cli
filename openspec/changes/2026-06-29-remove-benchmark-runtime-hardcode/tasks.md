# Tasks

- [x] 1. Open a fresh OpenSpec change documenting benchmark hardcode removal and profile governance.
- [x] 1. 新建 OpenSpec 变更，记录 benchmark hardcode 清理与 profile governance。
- [x] 2. Add failing architecture lint/contract coverage for benchmark tokens in shared runtime/platform packages.
- [x] 2. 增加会失败的 architecture lint/contract 覆盖，禁止 benchmark tokens 出现在 shared runtime/platform packages。
- [x] 3. Remove SWE-bench-specific runtime gates, counters, request budgets, prompt classifiers, and profile selections.
- [x] 3. 移除 SWE-bench-specific runtime gates、counters、request budgets、prompt classifiers 与 profile selections。
- [x] 4. Remove benchmark-specific shell/tool guards from shared tool packages or replace them with generic workspace/evaluation-scope guards driven by host policy data.
- [x] 4. 移除 shared tool packages 中的 benchmark-specific shell/tool guards，或替换为由 host policy data 驱动的通用 workspace/evaluation-scope guards。
- [x] 5. Ensure CLI/runtime accepts benchmark-like workflows only through dynamic or externally supplied declarative profiles, not source-code phase-1 profile hardcode.
- [x] 5. 确保 CLI/runtime 只通过 dynamic 或外部声明式 profiles 接收 benchmark-like workflows，不在源码中 hardcode 第一期 profile。
- [ ] 6. Preserve generic staged workflow scheduling behavior with focused unit/contract tests.
- [ ] 6. 用 focused unit/contract tests 保留通用 staged workflow scheduling behavior。
- [x] 7. Run `npx openspec validate 2026-06-29-remove-benchmark-runtime-hardcode --strict` and `npx openspec validate --specs --strict`.
- [x] 7. 运行 `npx openspec validate 2026-06-29-remove-benchmark-runtime-hardcode --strict` 与 `npx openspec validate --specs --strict`。
- [x] 8. Run focused tests, `npm run typecheck`, `npm run lint`, and `node scripts/check-boundaries.mjs`.
- [x] 8. 运行 focused tests、`npm run typecheck`、`npm run lint` 与 `node scripts/check-boundaries.mjs`。
- [ ] 9. After deterministic cleanup passes, run exactly one task-1 canary and report model request count, tool count, terminal reason, and whether the result is resolved.
- [ ] 9. 确定性清理通过后，只运行一次第 1 题 canary，并报告 model request count、tool count、terminal reason 与 resolved 状态。
