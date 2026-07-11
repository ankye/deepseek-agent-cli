## MODIFIED Requirements

### Requirement: Agent Loop Audit Evidence / Agent Loop 审计证据

Observability SHALL record replay-safe audit evidence for agent loop decisions, including model profile, policy decision, repair decision, scheduler admission, tool result summary, and terminal status.

observability 必须为 agent loop decisions 记录 replay-safe audit evidence，包括 model profile、policy decision、repair decision、scheduler admission、tool result summary 和 terminal status。

#### Scenario: Repair decision is auditable / 修复决策可审计

- **WHEN** runtime repairs a provider tool-call intent
- **THEN** observability records the repair type, before/after structural metadata, validation evidence, and redacted diagnostics without storing secret or unsafe raw content
- **中文** 当 runtime 修复 provider tool-call intent 时，observability 必须记录 repair type、before/after structural metadata、validation evidence 和 redacted diagnostics，且不存储 secret 或 unsafe raw content。

#### Scenario: Model requests and usage are audit entries / 模型请求与用量是审计记录

- **WHEN** runtime emits a model request or consumes a provider-normalized usage event
- **THEN** observability stores replay-safe `audit` records for request count, session id, turn id, trace id, phase attribution, provider, model, provider request id when available, prompt assembly fingerprint, input tokens, output tokens, cache token metadata, reasoning token metadata, and total tokens
- **AND** the audit records contain no raw prompts, raw provider request bodies, raw provider responses, raw credentials, authorization headers, or secret-like environment values
- **AND** diagnostics and evaluation evidence may reference these audit records instead of parsing provider-specific transport logs
- **中文** 当 runtime 发出 model request 或消费 provider-normalized usage event 时，observability 必须存储 replay-safe 的 `audit` records，包含 request count、session id、turn id、trace id、phase attribution、provider、model、可用的 provider request id、prompt assembly fingerprint、input tokens、output tokens、cache token metadata、reasoning token metadata 与 total tokens；审计记录不得包含 raw prompts、raw provider request bodies、raw provider responses、raw credentials、authorization headers 或 secret-like environment values；diagnostics 与 evaluation evidence 可以引用这些 audit records，而不是解析 provider-specific transport logs。
