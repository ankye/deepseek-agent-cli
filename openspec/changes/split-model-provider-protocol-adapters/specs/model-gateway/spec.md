## ADDED Requirements

### Requirement: Vendor Protocol Adapter Units / Vendor Protocol Adapter Units

The model gateway SHALL organize live provider adapters by vendor and wire protocol so that each adapter unit owns exactly one vendor/protocol pair, such as DeepSeek OpenAI-compatible, DeepSeek Anthropic-compatible, or GLM Anthropic-compatible.

model gateway 必须按 vendor 与 wire protocol 组织 live provider adapters，使每个 adapter unit 只拥有一个 vendor/protocol pair，例如 DeepSeek OpenAI-compatible、DeepSeek Anthropic-compatible 或 GLM Anthropic-compatible。

#### Scenario: Adapter identity includes protocol / Adapter identity 包含 protocol

- **WHEN** a model provider supports multiple wire protocols
- **THEN** each protocol-specific implementation is represented as a separate adapter unit with its own request builder, stream normalizer, provider metadata, and focused tests
- **中文** 当一个 model provider 支持多个 wire protocols 时，每个 protocol-specific implementation 必须表示为独立 adapter unit，并拥有自己的 request builder、stream normalizer、provider metadata 与 focused tests。

#### Scenario: DeepSeek protocol lanes stay distinct / DeepSeek protocol lanes 保持区分

- **WHEN** DeepSeek OpenAI-compatible and DeepSeek Anthropic-compatible lanes are implemented
- **THEN** their wire request construction and response normalization live in separate adapter modules even though they share the same vendor
- **中文** 当实现 DeepSeek OpenAI-compatible 与 DeepSeek Anthropic-compatible lanes 时，即使它们共享同一 vendor，其 wire request construction 与 response normalization 也必须位于不同 adapter modules。

#### Scenario: GLM Anthropic adapter owns GLM quirks / GLM Anthropic adapter 拥有 GLM 差异

- **WHEN** GLM Anthropic-compatible streaming includes provider-specific details such as placeholder usage or GLM metadata
- **THEN** those details are handled inside the GLM Anthropic adapter and are not generalized into DeepSeek or shared adapter policy
- **中文** 当 GLM Anthropic-compatible streaming 包含 placeholder usage 或 GLM metadata 等 provider-specific details 时，这些细节必须在 GLM Anthropic adapter 内处理，不得泛化进 DeepSeek 或 shared adapter policy。

### Requirement: Provider Package Root Compatibility / Provider Package Root Compatibility

The model gateway package root SHALL preserve stable public exports while internal provider files are reorganized.

model gateway package root 必须在 reorganize internal provider files 时保持稳定 public exports。

#### Scenario: Public imports remain stable / Public imports 保持稳定

- **WHEN** runtime, CLI, tests, or future hosts import provider classes, default profiles, transports, or credential refs from `@deepseek/model-gateway`
- **THEN** those imports continue to resolve from the package root without requiring callers to import provider internal file paths
- **中文** 当 runtime、CLI、tests 或未来 hosts 从 `@deepseek/model-gateway` import provider classes、default profiles、transports 或 credential refs 时，这些 imports 必须继续从 package root 解析，不要求 callers import provider internal file paths。

#### Scenario: Runtime contract remains provider-neutral / Runtime contract 保持 provider-neutral

- **WHEN** a provider adapter emits text, reasoning, tool-call, usage, finish, done, or error events
- **THEN** runtime receives the same `ModelStreamEvent` shapes before and after adapter file reorganization
- **中文** 当 provider adapter 发出 text、reasoning、tool-call、usage、finish、done 或 error events 时，runtime 在 adapter file reorganization 前后必须收到相同的 `ModelStreamEvent` shapes。

### Requirement: Shared Helper Boundaries / Shared Helper Boundaries

Shared model-gateway helper modules SHALL contain only provider-neutral or protocol-level mechanics and SHALL NOT own vendor-specific endpoint defaults, credential refs, model ids, quota policy, or provider-specific usage quirks.

model-gateway shared helper modules 只能包含 provider-neutral 或 protocol-level mechanics，不得拥有 vendor-specific endpoint defaults、credential refs、model ids、quota policy 或 provider-specific usage quirks。

#### Scenario: Shared Anthropic mechanics do not erase vendor policy / Shared Anthropic mechanics 不抹平 vendor policy

- **WHEN** DeepSeek Anthropic-compatible and GLM Anthropic-compatible adapters reuse Anthropic content-block parsing helpers
- **THEN** endpoint defaults, credential refs, provider ids, model ids, and provider-specific usage decisions remain in their adapter modules
- **中文** 当 DeepSeek Anthropic-compatible 与 GLM Anthropic-compatible adapters 复用 Anthropic content-block parsing helpers 时，endpoint defaults、credential refs、provider ids、model ids 与 provider-specific usage decisions 必须留在各自 adapter modules。
