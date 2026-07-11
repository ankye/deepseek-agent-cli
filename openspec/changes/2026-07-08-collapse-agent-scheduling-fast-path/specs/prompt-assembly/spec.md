## ADDED Requirements

### Requirement: Prompt Assembly Separates Stable Scheduling Contract From Dynamic Board State

Prompt assembly SHALL keep stable scheduling contracts in the provider-cacheable prefix and dynamic board records in a bounded dynamic tail.

prompt assembly 必须将稳定 scheduling contracts 保持在 provider-cacheable prefix，并将动态 board records 放入有界 dynamic tail。

#### Scenario: Stable scheduling prefix remains cacheable

- **WHEN** consecutive child model requests use the same scheduling contract, tool schema contract, board schema, and stable prefix sections
- **THEN** provider-prefix fingerprints remain stable even if active stage id, iteration number, counters, recent board records, accepted evidence refs, or next action details change
- **AND** cache diagnostics classify such changes as dynamic-tail drift, not stable-prefix drift
- **中文** 当连续 child model requests 使用相同 scheduling contract、tool schema contract、board schema 与 stable prefix sections 时，即使 active stage id、iteration number、counters、recent board records、accepted evidence refs 或 next action details 改变，provider-prefix fingerprints 也必须保持稳定；cache diagnostics 必须把这些变化归类为 dynamic-tail drift，而不是 stable-prefix drift。

#### Scenario: Child prompt receives only next-action evidence

- **WHEN** prompt assembly builds a child model request for a governed staged workflow
- **THEN** the child-visible dynamic tail contains the current stage, one authoritative next action, the bounded evidence required for that action, and current visible tools
- **AND** it excludes cache-hit diagnostics, full board history, technical-director residual-risk commentary, stale rejected actions, parent-only orchestration decisions, raw provider reasoning, and unredacted tool output unless one of those items is explicitly required by the next action
- **中文** 当 prompt assembly 为受治理 staged workflow 构建 child model request 时，child-visible dynamic tail 必须包含 current stage、一个权威 next action、该 action 所需的有界 evidence 与当前 visible tools；除非某项被 next action 明确需要，否则必须排除 cache-hit diagnostics、完整 board history、technical-director residual-risk commentary、过期 rejected actions、parent-only orchestration decisions、raw provider reasoning 与未脱敏 tool output。

### Requirement: Prompt Assembly Does Not Build Scheduler Prompts Inline

Prompt assembly SHALL receive next-action data through provider-neutral contracts instead of relying on inline prompt string concatenation inside the agent loop.

prompt assembly 必须通过 provider-neutral contracts 接收 next-action data，而不是依赖 agent loop 内联 prompt 字符串拼接。

#### Scenario: Next action is structured prompt data

- **WHEN** the agent loop prepares a governed model request
- **THEN** the next action is passed to prompt assembly as structured data with action class, stage id, allowed capability ids, accepted evidence refs, correction text when any, and redaction metadata
- **AND** prompt assembly evidence records the next-action fingerprint without persisting raw unbounded prompt text
- **中文** 当 agent loop 准备受治理 model request 时，next action 必须作为结构化数据传给 prompt assembly，包含 action class、stage id、allowed capability ids、accepted evidence refs、存在时的 correction text 与 redaction metadata；prompt assembly evidence 必须记录 next-action fingerprint，且不得持久化 raw unbounded prompt text。
