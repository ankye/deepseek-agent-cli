## 1. Contracts / 契约

- [x] 1.1 Add failing contract tests for generic staged task DTOs and exports. / 增加失败 contract tests，覆盖通用 staged task DTO 与导出。
- [x] 1.2 Add `@deepseek/platform-contracts` staged task DTOs with schema version, redaction, and compatibility metadata. / 增加带 schema version、redaction 与 compatibility metadata 的 staged task DTO。
- [x] 1.3 Add failing contract tests for task profile records and domain/version profile ids. / 增加失败 contract tests，覆盖 task profile records 与 domain/version profile ids。
- [x] 1.4 Add the host-neutral `src/packages/task-profiles` catalog skeleton with profile registry exports only. / 增加 host-neutral 的 `src/packages/task-profiles` catalog 骨架，只导出 profile registry。
- [x] 1.5 Add failing tests for deterministic profile composition and conflict diagnostics. / 增加失败测试，覆盖 deterministic profile composition 与 conflict diagnostics。
- [x] 1.6 Add failing tests for dynamic profile admission, fingerprinting, and governance rejection. / 增加失败测试，覆盖 dynamic profile admission、fingerprinting 与 governance rejection。
- [x] 1.7 Implement MVP profile compiler for base + fragments + overlays + dynamic profiles with stable fingerprints. / 实现 MVP profile compiler，支持 base + fragments + overlays + dynamic profiles 与稳定 fingerprints。

## 2. Runtime State Machine / Runtime 状态机

- [x] 2.1 Add failing runtime tests for dependency validation, ready-stage selection, and event-only state transitions. / 增加失败 runtime tests，覆盖 dependency validation、ready-stage selection 与 event-only state transitions。
- [x] 2.2 Add failing runtime tests for typed ref outputs and event-log-derived replay state. / 增加失败 runtime tests，覆盖 typed ref outputs 与 event-log-derived replay state。
- [x] 2.3 Implement runtime staged task state-machine helpers without executing tools directly. / 实现 runtime staged task state-machine helpers，且不直接执行 tools。

## 3. Injectable Executors / 可注入 Executor

- [x] 3.1 Add failing runtime tests proving executors are resolved by `executorKind` and cannot mutate task state directly. / 增加失败 runtime tests，证明 executors 通过 `executorKind` 解析且不能直接修改 task state。
- [x] 3.2 Add failing tests that unknown executor kinds fail closed. / 增加失败测试，验证 unknown executor kinds fail closed。
- [x] 3.3 Implement `StageExecutor` and `runReadyStage` helpers that return typed events/results. / 实现 `StageExecutor` 与 `runReadyStage` helpers，返回 typed events/results。

## 4. CLI Evaluation First Slice / CLI 评估首个切片

- [x] 4.1 Add focused CLI evaluation tests for building a staged graph from the webpage task without embedding webpage semantics in the controller. / 增加聚焦 CLI evaluation tests，验证可从 webpage task 构建 staged graph，且 controller 不嵌入网页语义。
- [x] 4.2 Add `evaluation/webpage-generation.v1` profile using generic stages and typed refs. / 增加使用 generic stages 与 typed refs 的 `evaluation/webpage-generation.v1` profile。
- [x] 4.3 Extract reusable evaluation stage graph construction and keep existing webpage execution behavior stable. / 抽出可复用 evaluation stage graph construction，并保持现有网页执行行为稳定。

## 5. Verification / 验证

- [x] 5.1 Validate the OpenSpec change in strict mode. / 使用 strict mode 校验 OpenSpec change。
- [x] 5.2 Run focused tests for platform contracts, runtime staged task execution, and CLI evaluation. / 运行 platform contracts、runtime staged task execution 与 CLI evaluation 聚焦测试。
- [x] 5.3 Run repository static gates before commit. / 提交前运行仓库静态门。

## 6. CLI Evaluation Snapshot / CLI 评估快照

- [x] 6.1 Add failing tests that webpage evaluation run records expose staged task snapshots. / 增加失败测试，验证网页 evaluation run records 暴露 staged task snapshots。
- [x] 6.2 Add a redacted `CliEvaluationStagedTaskSnapshot` DTO with graph and run-state references. / 增加 redacted `CliEvaluationStagedTaskSnapshot` DTO，包含 graph 与 run-state references。
- [x] 6.3 Emit staged snapshots for planned dry-runs and executed webpage evaluation runs without changing command execution behavior. / 为 planned dry-runs 与 executed webpage evaluation runs 输出 staged snapshots，且不改变 command execution 行为。
- [x] 6.4 Re-run focused tests and strict OpenSpec validation. / 重新运行聚焦测试与 strict OpenSpec validation。
