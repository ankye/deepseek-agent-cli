## MODIFIED Requirements
### Requirement: Statusline Telemetry Projection / 状态栏遥测投影

The pipeline SHALL provide a bounded statusline telemetry projection for CLI/TUI surfaces, including cache hit rate, cache hit/miss tokens when available, selected model, thinking mode, context size, budget pressure, and prefix stability.

Pipeline 必须为 CLI/TUI 表面提供有界 statusline telemetry projection，包括缓存命中率、可用时的 cache hit/miss tokens、当前模型、思考模式、上下文大小、预算压力与 prefix stability。

#### Scenario: Statusline receives bounded cache context / 状态栏获得有界缓存上下文

- **WHEN** a model request is assembled from a pipeline manifest and usage evidence is available
- **THEN** the statusline telemetry reports cache hit rate, hit/miss tokens when available, model id/profile, thinking mode, selected context tokens, hard/soft budget, and prefix stability without raw context content
- **中文** 当模型请求由 pipeline manifest 组装且 usage evidence 可用时，状态栏 telemetry 必须报告缓存命中率、可用时的 hit/miss tokens、model id/profile、思考模式、selected context tokens、hard/soft budget 与 prefix stability，且不包含 raw context content。

#### Scenario: Multi-request turn uses aggregate cache rate / 多请求 Turn 使用聚合缓存率

- **WHEN** one agent turn emits multiple `usage.updated` events
- **THEN** statusline telemetry calculates cache hit tokens, miss tokens, and hit rate across all usage events in that turn instead of using only the final provider request
- **AND** provider events that expose cache-read tokens without miss tokens use request input tokens as the replay-safe miss-token fallback
- **中文** 当一个 agent turn 发出多个 `usage.updated` events 时，状态栏 telemetry 必须跨该 turn 的所有 usage events 计算 cache hit tokens、miss tokens 与 hit rate，而不是只使用最后一次 provider request；当 provider event 只暴露 cache-read tokens 而没有 miss tokens 时，必须使用 request input tokens 作为可 replay 的 miss-token fallback。

#### Scenario: Missing provider cache usage degrades gracefully / 缺失 Provider 缓存用量时优雅降级

- **WHEN** the provider does not report cache hit/miss token usage
- **THEN** telemetry still reports prefix hash reuse and context token budget while marking provider cache hit rate as unavailable rather than zero
- **中文** 当 provider 不报告 cache hit/miss token usage 时，telemetry 仍必须报告 prefix hash reuse 与 context token budget，并将 provider cache hit rate 标记为 unavailable，而不是零。

### Requirement: Pipeline Cache Evidence / Pipeline 缓存证据

The pipeline SHALL emit replay-safe cache evidence that records prefix hash reuse, cache hint application, provider cache hit/miss usage when available, and reasons for cache opportunity loss.

Pipeline 必须发出可 replay 的缓存证据，记录 prefix hash reuse、cache hint application、可用时的 provider cache hit/miss usage，以及缓存机会丢失原因。

#### Scenario: Cache opportunity loss is diagnosable / 缓存机会丢失可诊断

- **WHEN** a previously stable prefix hash changes
- **THEN** diagnostics record the changed layer, changed block hash, reason when known, and affected token estimate
- **中文** 当此前稳定的 prefix hash 发生变化时，diagnostics 必须记录变化 layer、变化 block hash、已知原因和受影响 token estimate。

#### Scenario: Provider cache usage is normalized / Provider 缓存用量被归一化

- **WHEN** an Anthropic-compatible provider reports cache-read input tokens and total input tokens
- **THEN** model-gateway usage evidence includes hit tokens, miss tokens, and hit rate before runtime audit or CLI/TUI telemetry consumes it
- **中文** 当 Anthropic-compatible provider 返回 cache-read input tokens 与 total input tokens 时，model-gateway usage evidence 必须在 runtime audit 或 CLI/TUI telemetry 消费前包含 hit tokens、miss tokens 与 hit rate。
