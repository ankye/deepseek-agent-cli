## Design

Readiness will carry explicit selected-provider metadata from CLI parsing into the command-system environment. The command-system layer will render credential checks and live verification messages from that metadata instead of hardcoding DeepSeek labels and environment keys.

readiness 会把 CLI parsing 得到的 selected-provider metadata 显式带入 command-system environment。command-system layer 将基于该 metadata 渲染 credential checks 与 live verification messages，而不是硬编码 DeepSeek labels 和环境键。

CLI diagnostics will reuse the same model profile selection already used by `run/chat`. For DeepSeek, it keeps the existing OpenAI-compatible verifier and credential service. For GLM, it constructs the existing GLM Anthropic-compatible provider via package-root exports and secret-safe GLM credential loading.

CLI diagnostics 会复用 `run/chat` 已使用的 model profile selection。DeepSeek 保持现有 OpenAI-compatible verifier 与 credential service。GLM 通过 package-root exports 和 secret-safe GLM credential loading 构建现有 GLM Anthropic-compatible provider。

Release evidence will remain conservative: existing DeepSeek evidence continues to gate publish readiness. GLM evidence is added as provider-specific parity evidence so the project can prove the alternate provider path without silently weakening DeepSeek release criteria.

release evidence 保持保守：现有 DeepSeek evidence 继续作为 publish readiness gate。GLM evidence 作为 provider-specific parity evidence 加入，使项目可以证明 alternate provider path，同时不悄悄降低 DeepSeek release criteria。

## Non-Goals

- Do not make GLM the default provider for CLI runs or diagnostics.
- 不把 GLM 设为 CLI runs 或 diagnostics 的默认 provider。
- Do not require GLM credentials for default offline checks, `npm test`, or release verification unless GLM live evidence is explicitly requested.
- 默认 offline checks、`npm test` 或 release verification 不要求 GLM credentials，除非显式请求 GLM live evidence。
- Do not persist or print the user-provided GLM key.
- 不持久化或打印用户提供的 GLM key。
