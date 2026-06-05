# Tasks

- [x] 1. Add OpenSpec deltas for task delivery flow, agent-loop delivery gates, staged task integration, prompt assembly, diagnostics smoke evidence, and unified model request/token audit.
- [x] 2. Add failing contract/runtime tests for deterministic task intake, decision packet creation, goal creation, phase plan creation, acceptance review, guidance invalidation, and return-state mapping.
- [x] 3. Add failing prompt-assembly tests proving decision prompts are assembled as stable sections with prefix/cache evidence and budget exclusions.
- [x] 4. Add failing runtime audit tests proving model request counts and token usage are recorded in unified audit and usage-budget records without leaking secrets.
- [x] 5. Add failing CLI diagnostics tests for `diagnostics flow inspect` JSON and JSONL output.
- [x] 6. Implement host-neutral task delivery flow contracts in `@deepseek/platform-contracts`, including `TaskDecisionRequest`, `TaskDecisionEnvelope`, `TaskGuidanceEvent`, and `DecisionInvalidation`.
- [x] 7. Add task decision prompt contracts to prompt assembly and a first-party decision section provider.
- [x] 8. Implement the minimal deterministic task delivery controller in `@deepseek/runtime`.
- [x] 9. Record runtime model request and usage events through the unified audit/usage path.
- [x] 10. Wire `diagnostics flow inspect` into CLI parsing, diagnostics collection, text rendering, JSON, and JSONL.
- [x] 11. Validate OpenSpec and run focused plus broader verification.
- [x] 12. Wire replay-safe task delivery flow lineage into ordinary agent-loop started, hook, model request, and model metadata paths.
- [x] 13. Pass task decision requests through ordinary prompt assembly so the main model dispatch can return multi-step decisions without an extra provider request.
- [x] 14. Parse model-returned `TaskDecisionEnvelope` JSON, emit replay-safe decision evidence, and carry the model decision into the final agent-loop summary.
- [x] 15. Project model-selected goal and plan fields into decision evidence and final task-delivery flow lineage.
- [x] 16. Prevent raw model `TaskDecisionEnvelope` JSON from becoming completion evidence or final assistant delivery text.
- [x] 17. Render public diagnostics evaluation execution traces in text output without exposing provider raw chain-of-thought or unbounded stdout/stderr.
- [x] 18. Stream safe diagnostics evaluation progress from allowlisted child JSONL events while filtering raw model deltas and unbounded stdout/stderr.

# 任务

- [x] 1. 为 task delivery flow、agent-loop 交付门禁、staged task 集成、prompt assembly、diagnostics smoke evidence 与统一 model request/token audit 增加 OpenSpec delta。
- [x] 2. 为确定性 task intake、decision packet creation、goal creation、phase plan creation、acceptance review、guidance invalidation 与 return-state mapping 增加先失败的 contract/runtime 测试。
- [x] 3. 增加先失败的 prompt-assembly 测试，证明 decision prompts 作为稳定 sections 组装，并携带 prefix/cache evidence 与 budget exclusions。
- [x] 4. 增加先失败的 runtime audit 测试，证明 model request counts 与 token usage 写入统一 audit 和 usage-budget records，且不泄漏 secrets。
- [x] 5. 为 `diagnostics flow inspect` JSON 与 JSONL 输出增加先失败的 CLI diagnostics 测试。
- [x] 6. 在 `@deepseek/platform-contracts` 中实现 host-neutral task delivery flow contracts，包括 `TaskDecisionRequest`、`TaskDecisionEnvelope`、`TaskGuidanceEvent` 与 `DecisionInvalidation`。
- [x] 7. 将 task decision prompt contracts 接入 prompt assembly，并增加一等 decision section provider。
- [x] 8. 在 `@deepseek/runtime` 中实现最小确定性 task delivery controller。
- [x] 9. 将 runtime model request 与 usage events 通过统一 audit/usage 路径记录。
- [x] 10. 将 `diagnostics flow inspect` 接入 CLI parsing、diagnostics collection、text rendering、JSON 与 JSONL。
- [x] 11. 校验 OpenSpec，并运行聚焦与扩大验证。
- [x] 12. 将 replay-safe task delivery flow lineage 接入普通 agent-loop started、hook、model request 与 model metadata 路径。
- [x] 13. 将 task decision requests 交给普通 prompt assembly，让主模型请求可返回多步决策而不增加额外 provider request。
- [x] 14. 解析模型返回的 `TaskDecisionEnvelope` JSON，输出 replay-safe decision evidence，并将模型决策带入最终 agent-loop summary。
- [x] 15. 将模型选择的 goal 与 plan 字段投影到 decision evidence 和最终 task-delivery flow lineage。
- [x] 16. 防止原始模型 `TaskDecisionEnvelope` JSON 被当作完成证据或最终 assistant 交付文本。
- [x] 17. 在 diagnostics evaluate 文本输出中渲染公开执行轨迹，且不暴露 provider raw chain-of-thought 或无界 stdout/stderr。
- [x] 18. 从 allowlist child JSONL events 流式输出安全的 diagnostics evaluation progress，同时过滤 raw model deltas 与无界 stdout/stderr。
