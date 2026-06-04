## Design

The GLM provider will be modeled as its own provider config and `ModelGateway` implementation rather than as a DeepSeek branch. The adapter targets Anthropic Messages at `baseUrl + /v1/messages`, uses `x-api-key` plus `anthropic-version`, and keeps provider id/model metadata visible as `provider=glm` and `protocol=anthropic-messages`.

GLM provider 会作为独立 provider config 与 `ModelGateway` implementation 建模，而不是作为 DeepSeek 分支。该 adapter 面向 `baseUrl + /v1/messages` 的 Anthropic Messages，使用 `x-api-key` 与 `anthropic-version`，并将 provider id/model metadata 保持为 `provider=glm` 与 `protocol=anthropic-messages`。

Runtime calls still pass through the existing `ModelGateway` interface. CLI live runs choose a model profile before invoking the runtime; deterministic/offline paths keep the mock provider and current defaults. The live GLM smoke uses a dedicated env gate so default checks do not perform network calls.

runtime 调用仍通过现有 `ModelGateway` interface。CLI live runs 在调用 runtime 前选择 model profile；deterministic/offline 路径保留 mock provider 和当前默认值。live GLM smoke 使用专用 env gate，避免默认检查发起网络请求。

Credential handling follows the DeepSeek live pattern: process env wins over `.env`, credentials are passed as scoped secret values through injected providers, and tests assert that redacted event summaries never include raw key material or authorization headers.

credential handling 沿用 DeepSeek live pattern：process env 优先于 `.env`，凭据通过 injected providers 作为 scoped secret values 传递，测试断言脱敏事件摘要绝不包含 raw key material 或 authorization headers。

## Alternatives Considered

- Reuse `DeepSeekOpenAIProvider.buildAnthropicMessagesProviderRequest`. Rejected because it keeps metadata, credential refs, and endpoint ownership tied to DeepSeek.
- 复用 `DeepSeekOpenAIProvider.buildAnthropicMessagesProviderRequest`。拒绝，因为它会把 metadata、credential refs 与 endpoint ownership 绑定在 DeepSeek 上。
- Use the Anthropic SDK. Rejected for this first adapter because the repository already has a provider-neutral fetch/SSE transport boundary and GLM compatibility can be covered with a small Messages-specific transport.
- 使用 Anthropic SDK。第一版 adapter 不采用，因为仓库已有 provider-neutral fetch/SSE transport boundary，GLM compatibility 可以通过较小的 Messages-specific transport 覆盖。
