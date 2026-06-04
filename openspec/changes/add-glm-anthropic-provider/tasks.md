## 1. OpenSpec And Contracts / OpenSpec 与契约

- [x] 1.1 Add bilingual model-gateway, credential, live-smoke, and testing requirements for GLM Anthropic-compatible provider support. / 增加 GLM Anthropic-compatible provider support 的双语 model-gateway、credential、live-smoke 与 testing requirements。
- [x] 1.2 Validate `add-glm-anthropic-provider` with OpenSpec strict mode. / 使用 OpenSpec strict mode 校验 `add-glm-anthropic-provider`。

## 2. Provider Implementation / Provider 实现

- [x] 2.1 Add failing deterministic tests for GLM request construction, credential fail-closed behavior, Anthropic response normalization, and CLI profile selection. / 增加失败的 deterministic tests，覆盖 GLM request construction、credential fail-closed behavior、Anthropic response normalization 与 CLI profile selection。
- [x] 2.2 Add GLM provider config, default model profile, credential ref, and Anthropic Messages adapter under `@deepseek/model-gateway`. / 在 `@deepseek/model-gateway` 中增加 GLM provider config、default model profile、credential ref 与 Anthropic Messages adapter。
- [x] 2.3 Add secret-safe GLM credential environment loading and live runtime provider selection. / 增加 secret-safe GLM credential environment loading 与 live runtime provider selection。
- [x] 2.4 Add CLI provider/model option parsing without changing deterministic defaults. / 增加 CLI provider/model option parsing，且不改变 deterministic defaults。

## 3. Optional Live Smoke / 可选 Live Smoke

- [x] 3.1 Add skip-by-default GLM provider smoke and npm script. / 增加默认跳过的 GLM provider smoke 与 npm script。
- [x] 3.2 Run the GLM live provider smoke with explicit environment credentials and confirm redacted normalized output. / 使用显式环境凭据运行 GLM live provider smoke，并确认输出为脱敏 normalized output。
- [x] 3.3 Run a CLI live flow against GLM with explicit provider/model selection. / 使用显式 provider/model selection 针对 GLM 运行 CLI live flow。

## 4. Verification / 校验

- [x] 4.1 Run focused model-gateway, credential, CLI, and live-smoke tests. / 运行聚焦的 model-gateway、credential、CLI 与 live-smoke tests。
- [x] 4.2 Run `openspec validate --specs --strict`, `npm run typecheck`, `npm run lint`, `npm test`, and `node scripts/check-boundaries.mjs`. / 运行 `openspec validate --specs --strict`、`npm run typecheck`、`npm run lint`、`npm test` 与 `node scripts/check-boundaries.mjs`。
- [x] 4.3 Confirm `git status --short --ignored` and `git ls-files -- '参考/*'` do not include reference material or secrets. / 确认 `git status --short --ignored` 与 `git ls-files -- '参考/*'` 不包含 reference material 或 secrets。
