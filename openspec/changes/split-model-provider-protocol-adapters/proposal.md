## Why

The model gateway now has more than one axis of provider behavior. DeepSeek can expose OpenAI-compatible and Anthropic-compatible lanes, while GLM currently uses an Anthropic-compatible lane. Treating "provider" as only the vendor name makes the adapter boundary too blurry and keeps unrelated wire protocols in the same files.

model gateway 现在已经不止一个 provider behavior 维度。DeepSeek 可以有 OpenAI-compatible 与 Anthropic-compatible 两条 lane，而 GLM 当前使用 Anthropic-compatible lane。只把 "provider" 理解为 vendor name 会让 adapter boundary 变模糊，并把无关 wire protocols 混在同一批文件中。

## What Changes

- Define the canonical adapter identity as `vendor + protocol + adapter`, not only a vendor/provider name.
- 将 canonical adapter identity 定义为 `vendor + protocol + adapter`，而不仅是 vendor/provider name。
- Split model-gateway provider code into protocol-specific adapter modules, beginning with `deepseek/openai`, `deepseek/anthropic`, and `glm/anthropic`.
- 将 model-gateway provider code 拆为 protocol-specific adapter modules，首批覆盖 `deepseek/openai`、`deepseek/anthropic` 与 `glm/anthropic`。
- Keep runtime, CLI, VSCode, capability governance, and live smoke callers on provider-neutral `ModelGateway` and `ModelStreamEvent` contracts.
- 保持 runtime、CLI、VSCode、capability governance 与 live smoke callers 只依赖 provider-neutral `ModelGateway` 与 `ModelStreamEvent` contracts。
- Move shared SSE parsing, usage normalization, error redaction, and tool schema translation into shared helpers only when they are protocol-level or provider-neutral.
- 仅当 SSE parsing、usage normalization、error redaction 与 tool schema translation 属于 protocol-level 或 provider-neutral 时，才移动到 shared helpers。
- Preserve existing public exports while allowing internal file paths to change.
- 保持现有 public exports 不变，同时允许内部文件路径调整。

## Impact

- Affects `src/packages/model-gateway` source layout and tests.
- 影响 `src/packages/model-gateway` source layout 与 tests。
- May touch CLI/runtime imports only if they currently rely on implementation file structure; package-level imports must remain stable.
- 只有当 CLI/runtime imports 依赖 implementation file structure 时才可能触及；package-level imports 必须保持稳定。
- Does not add a new provider, credential type, runtime event type, or live network requirement.
- 不新增 provider、credential type、runtime event type 或 live network requirement。
- Default tests remain offline and live smoke gates stay opt-in.
- 默认 tests 保持 offline，live smoke gates 仍为 opt-in。
