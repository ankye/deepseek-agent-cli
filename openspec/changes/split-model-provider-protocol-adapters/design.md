## Design

The model gateway will use adapter units named by both vendor and wire protocol. A vendor directory may contain more than one protocol directory when the same vendor supports multiple wire formats. The first target shape is:

model gateway 将使用同时由 vendor 与 wire protocol 命名的 adapter units。当同一个 vendor 支持多种 wire format 时，一个 vendor directory 可以包含多个 protocol directory。第一阶段目标结构为：

```text
src/packages/model-gateway/src/providers/
  deepseek/
    openai/
    anthropic/
  glm/
    anthropic/
  shared/
```

Each adapter module owns its config, default model profile, request construction, stream normalization, typed provider errors, and live verification behavior for that exact vendor/protocol pair. For example, `deepseek/openai` owns DeepSeek chat-completions normalization, `deepseek/anthropic` owns DeepSeek Anthropic-compatible request/response behavior, and `glm/anthropic` owns GLM Anthropic-compatible behavior including GLM-specific usage placeholder handling.

每个 adapter module 拥有该 vendor/protocol pair 的 config、default model profile、request construction、stream normalization、typed provider errors 与 live verification behavior。例如，`deepseek/openai` 拥有 DeepSeek chat-completions normalization，`deepseek/anthropic` 拥有 DeepSeek Anthropic-compatible request/response behavior，`glm/anthropic` 拥有 GLM Anthropic-compatible behavior，包括 GLM-specific usage placeholder handling。

The package root remains the compatibility boundary. Existing imports such as `DeepSeekOpenAIProvider`, `GlmAnthropicProvider`, `defaultDeepSeekProfile`, and `defaultGlmAnthropicProfile` stay exported from `@deepseek/model-gateway`. Runtime and host adapters continue to depend on `ModelGateway`, `ModelProfile`, and `ModelStreamEvent`; they must not import provider internals.

package root 仍是 compatibility boundary。现有 imports 例如 `DeepSeekOpenAIProvider`、`GlmAnthropicProvider`、`defaultDeepSeekProfile` 与 `defaultGlmAnthropicProfile` 继续从 `@deepseek/model-gateway` 导出。runtime 与 host adapters 继续依赖 `ModelGateway`、`ModelProfile` 与 `ModelStreamEvent`；它们不得 import provider internals。

Shared helpers are allowed only when they reduce duplicated protocol mechanics without erasing provider differences. Examples include provider-neutral SSE chunk decoding, redacted transport errors, Anthropic content-block assembly helpers, and OpenAI-style tool-call fragment assembly. Shared helpers must not own vendor policy, credential refs, endpoint defaults, model ids, or provider-specific usage quirks.

shared helpers 只在减少 protocol mechanics 重复且不抹平 provider differences 时允许存在。例如 provider-neutral SSE chunk decoding、redacted transport errors、Anthropic content-block assembly helpers 与 OpenAI-style tool-call fragment assembly。shared helpers 不得拥有 vendor policy、credential refs、endpoint defaults、model ids 或 provider-specific usage quirks。

## Migration Strategy

The migration should be mechanical and test-first. Start by adding structure and moving one adapter at a time while preserving public exports. After each move, run focused model-gateway tests. Once all adapter units are separated, run architecture lint, boundary checks, full tests, and OpenSpec validation.

migration 应该是 mechanical 且 test-first。先增加结构，再一次移动一个 adapter，同时保持 public exports。每次移动后运行 focused model-gateway tests。所有 adapter units 分离后，运行 architecture lint、boundary checks、full tests 与 OpenSpec validation。

## Non-Goals

- Do not change CLI flags or user-facing provider selection in this change.
- 本 change 不改变 CLI flags 或 user-facing provider selection。
- Do not add account routing, fallback policy, or automatic provider failover.
- 不新增 account routing、fallback policy 或 automatic provider failover。
- Do not require live credentials for default verification.
- 默认 verification 不要求 live credentials。
