## MODIFIED Requirements

### Requirement: Pipeline Cache Evidence / Pipeline 缓存证据

The pipeline SHALL emit replay-safe cache evidence that records prefix hash reuse, cache hint application, provider cache hit/miss usage when available, and reasons for cache opportunity loss. When provider-prefix cache evidence is available, diagnostics SHALL distinguish stable-prefix reuse from dynamic prompt-tail drift.

Pipeline 必须发出可 replay 的缓存证据，记录 prefix hash reuse、cache hint application、可用时的 provider cache hit/miss usage，以及缓存机会丢失原因。当 provider-prefix cache evidence 可用时，诊断必须区分 stable-prefix reuse 与 dynamic prompt-tail drift。

#### Scenario: Cache opportunity loss is diagnosable / 缓存机会丢失可诊断

- **WHEN** a previously stable prefix hash changes
- **THEN** diagnostics record the changed layer, changed block hash, reason when known, and affected token estimate
- **中文** 当此前稳定的 prefix hash 发生变化时，diagnostics 必须记录变化 layer、变化 block hash、已知原因和受影响 token estimate。

#### Scenario: Dynamic tail drift is not prefix drift / 动态尾部漂移不是 Prefix 漂移

- **WHEN** provider-prefix fingerprints remain stable but whole prompt, tool plan, workflow state, or history-tail fingerprints change
- **THEN** diagnostics classify low cache reuse as provider behavior, prefix size/coverage, tool-schema cache gap, history tail, or dynamic tail instead of prompt-prefix-busted
- **中文** 当 provider-prefix fingerprints 保持稳定但 whole prompt、tool plan、workflow state 或 history-tail fingerprints 变化时，诊断必须将低缓存复用归类为 provider behavior、prefix size/coverage、tool-schema cache gap、history tail 或 dynamic tail，而不是 prompt-prefix-busted。

#### Scenario: Shared board contract is cacheable while records remain dynamic / 共享看板契约可缓存而记录保持动态

- **WHEN** a run exposes a shared parent-child agent board
- **THEN** prompt assembly SHALL put only the board schema, sharing contract, and stable/dynamic partition rules into the stable provider prefix
- **AND** board ids, current iteration, stage status, recent records, recommended actions, counters, lineage, and failure-analysis evidence SHALL remain in the dynamic prompt tail
- **AND** changing dynamic board records SHALL NOT change the provider-prefix fingerprint
- **中文** 当运行暴露父子 agent 共享看板时，prompt assembly 必须只把看板 schema、共享契约、稳定/动态分区规则放入稳定 provider prefix。
- **中文** 看板 id、当前 iteration、stage 状态、最近记录、推荐动作、计数器、lineage、失败归因证据必须留在动态 prompt tail。
- **中文** 动态看板记录变化不得改变 provider-prefix fingerprint。
