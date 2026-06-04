## 1. OpenSpec And Contracts / OpenSpec 与契约

- [x] 1.1 Open a bilingual OpenSpec change for vendor/protocol adapter separation. / 为 vendor/protocol adapter separation 开启双语 OpenSpec change。
- [x] 1.2 Validate `split-model-provider-protocol-adapters` with strict OpenSpec mode. / 使用 strict OpenSpec mode 校验 `split-model-provider-protocol-adapters`。

## 2. Adapter Layout / Adapter 布局

- [x] 2.1 Add or update focused model-gateway tests that prove public exports and provider-neutral events remain unchanged during file moves. / 增加或更新 focused model-gateway tests，证明 file moves 期间 public exports 与 provider-neutral events 保持不变。
- [x] 2.2 Split DeepSeek OpenAI-compatible logic into `providers/deepseek/openai`. / 将 DeepSeek OpenAI-compatible logic 拆入 `providers/deepseek/openai`。
- [x] 2.3 Split DeepSeek Anthropic-compatible logic into `providers/deepseek/anthropic`. / 将 DeepSeek Anthropic-compatible logic 拆入 `providers/deepseek/anthropic`。
- [x] 2.4 Split GLM Anthropic-compatible logic into `providers/glm/anthropic`. / 将 GLM Anthropic-compatible logic 拆入 `providers/glm/anthropic`。
- [x] 2.5 Extract shared helpers only for protocol-level mechanics and keep vendor-specific behavior inside adapter modules. / 仅为 protocol-level mechanics 抽取 shared helpers，并把 vendor-specific behavior 留在 adapter modules 内。
- [x] 2.6 Keep `@deepseek/model-gateway` package-root exports backward compatible. / 保持 `@deepseek/model-gateway` package-root exports 向后兼容。

## 3. Regression And Governance / 回归与治理

- [x] 3.1 Ensure runtime, CLI, VSCode, and testing packages do not import provider internal file paths. / 确保 runtime、CLI、VSCode 与 testing packages 不 import provider internal file paths。
- [x] 3.2 Preserve skip-by-default live smoke scripts and provider-specific live gates. / 保持默认跳过的 live smoke scripts 与 provider-specific live gates。
- [x] 3.3 Run focused model-gateway tests after each adapter move. / 每次 adapter move 后运行 focused model-gateway tests。

## 4. Verification / 校验

- [x] 4.1 Run `npx openspec validate split-model-provider-protocol-adapters --type change --strict`. / 运行 `npx openspec validate split-model-provider-protocol-adapters --type change --strict`。
- [x] 4.2 Run `npx openspec validate --specs --strict`, `npm run typecheck`, `npm run lint`, `npm test`, and `node scripts/check-boundaries.mjs`. / 运行 `npx openspec validate --specs --strict`、`npm run typecheck`、`npm run lint`、`npm test` 与 `node scripts/check-boundaries.mjs`。
- [x] 4.3 Confirm `git status --short --ignored` and `git ls-files -- '参考/*'` do not include reference material or secrets. / 确认 `git status --short --ignored` 与 `git ls-files -- '参考/*'` 不包含 reference material 或 secrets。
