## ADDED Requirements

### Requirement: CLI Evaluation Propagates The Authoritative Nested Outcome / CLI Evaluation 传播权威嵌套 Outcome

CLI task-completion evaluation SHALL distinguish transport or capability completion from benchmark success. The outer diagnostics status SHALL be derived from the authoritative nested benchmark summary when one exists.

CLI task-completion evaluation 必须区分 transport 或 capability completion 与 benchmark success。当权威嵌套 benchmark summary 存在时，外层 diagnostics status 必须从该 summary 派生。

#### Scenario: Capability completes with failed benchmark evidence / Capability 完成但 Benchmark Evidence 失败

- **WHEN** `core.swe.bench.run` returns a completed capability envelope
- **AND** the nested benchmark summary has `status=fail` or an authoritative unresolved outcome
- **THEN** the outer diagnostics result has `status=fail`
- **AND** automation cannot interpret the invocation as a benchmark pass
- **中文** 当 `core.swe.bench.run` 返回已完成 capability envelope，但嵌套 benchmark summary 为 `status=fail` 或拥有权威 unresolved outcome 时，外层 diagnostics result 必须为 `status=fail`，自动化不得将该 invocation 解读为 benchmark pass。

### Requirement: Correctness And Flow Failures Precede Cache Readiness / Correctness 与 Flow Failure 优先于 Cache Readiness

CLI evaluation SHALL retain cache readiness diagnostics without allowing them to become the primary explanation for an unresolved official result, invalid prediction, packaging failure, or terminal flow-control failure. The final record SHALL retain both best-attempt official evidence and last-attempt terminal evidence.

CLI evaluation 必须保留 cache readiness diagnostics，但不得让它们成为 unresolved 官方结果、invalid prediction、packaging failure 或终态 flow-control failure 的 primary explanation。最终记录必须同时保留 best-attempt 官方证据和 last-attempt 终态证据。

#### Scenario: Cache target is missed after an unresolved candidate and flow failure / Unresolved 候选与 Flow Failure 后 Cache Target 未命中

- **WHEN** the best candidate has a valid official unresolved result
- **AND** the last attempt terminates with a flow-control failure before harness
- **AND** provider cache hit rate is below readiness target
- **THEN** the primary reason is correctness or flow-control, not cache readiness
- **AND** cache diagnostics remain available as non-primary review evidence
- **AND** the authoritative evaluation remains the best candidate's official result
- **中文** 当最佳候选拥有有效官方 unresolved 结果，最后 attempt 在 harness 前以 flow-control failure 终止，且 provider cache hit rate 低于 readiness target 时，primary reason 必须是 correctness 或 flow-control，而不是 cache readiness；cache diagnostics 必须作为非 primary review evidence 保留；权威 evaluation 必须保持为最佳候选的官方结果。
