## Why

DeepSeek CLI needs a second live AI provider path that can exercise the runtime through an Anthropic Messages-compatible API without changing provider-neutral runtime contracts or leaking credentials into source, logs, fixtures, or commits.

DeepSeek CLI 需要第二条 live AI provider 路径，可以通过 Anthropic Messages-compatible API 跑通 runtime，同时不改变 provider-neutral runtime contracts，也不把凭据泄漏到源码、日志、fixture 或提交中。

Zhipu GLM exposes a Claude-compatible endpoint under `https://open.bigmodel.cn/api/anthropic`, which makes it useful for low-cost provider flow validation while keeping the model gateway boundary clean.

智谱 GLM 在 `https://open.bigmodel.cn/api/anthropic` 暴露 Claude-compatible endpoint，适合用于低成本 provider flow validation，同时保持 model gateway 边界清晰。

## What Changes

- Add an independent GLM Anthropic-compatible provider adapter under `@deepseek/model-gateway`.
- 在 `@deepseek/model-gateway` 中增加独立的 GLM Anthropic-compatible provider adapter。
- Translate provider-neutral `ModelRequest` messages, tools, tool choice, and output limits into Anthropic Messages requests sent to `/v1/messages`.
- 将 provider-neutral `ModelRequest` 的 messages、tools、tool choice 与输出限制转换为发送到 `/v1/messages` 的 Anthropic Messages request。
- Normalize Anthropic-style content blocks, tool-use blocks, usage, stop reasons, and errors into existing `ModelStreamEvent` values.
- 将 Anthropic-style content blocks、tool-use blocks、usage、stop reasons 和 errors 归一化为现有 `ModelStreamEvent` values。
- Add secret-safe GLM credential loading from process environment or local `.env`, preferring process environment and never serializing raw secrets.
- 增加 secret-safe GLM credential loading，支持 process environment 或本地 `.env`，优先使用 process environment，且永不序列化 raw secrets。
- Let CLI live runs select the GLM provider and model by explicit provider/model options, without changing offline deterministic defaults.
- 允许 CLI live runs 通过显式 provider/model options 选择 GLM provider 和 model，且不改变 offline deterministic defaults。
- Add optional live GLM smoke coverage that is skipped unless explicitly enabled.
- 增加 optional live GLM smoke 覆盖，只有显式启用时才运行。

## Impact

- Affects `src/packages/model-gateway`, `src/packages/credential-auth-management`, CLI runtime/profile selection, live smoke tests, package scripts, and OpenSpec artifacts.
- 影响 `src/packages/model-gateway`、`src/packages/credential-auth-management`、CLI runtime/profile selection、live smoke tests、package scripts 和 OpenSpec artifacts。
- Default `npm test` remains offline and credential-free.
- 默认 `npm test` 保持 offline 且不需要凭据。
- Runtime/tool execution ownership remains unchanged: providers emit normalized intent only.
- runtime/tool execution 归属不变：providers 只发出 normalized intent。
