## ADDED Requirements

### Requirement: Provider Internal Import Guardrail / Provider Internal Import Guardrail

Application hosts, runtime packages, and non-model-gateway packages SHALL NOT import model-gateway provider internal implementation paths after provider adapters are split into vendor/protocol directories.

provider adapters 拆入 vendor/protocol directories 后，application hosts、runtime packages 与 non-model-gateway packages 不得 import model-gateway provider internal implementation paths。

#### Scenario: Package root is the only external provider import boundary / Package root 是唯一外部 provider import 边界

- **WHEN** a non-model-gateway package needs a model provider class, profile, transport, or credential ref
- **THEN** it imports from `@deepseek/model-gateway` rather than `@deepseek/model-gateway/providers/...` or cross-package relative paths
- **中文** 当 non-model-gateway package 需要 model provider class、profile、transport 或 credential ref 时，必须从 `@deepseek/model-gateway` import，而不是从 `@deepseek/model-gateway/providers/...` 或 cross-package relative paths import。

#### Scenario: Lint or boundary check protects adapter internals / Lint 或 boundary check 保护 adapter internals

- **WHEN** an implementation introduces an external import of provider internal adapter files
- **THEN** `npm run lint` or `node scripts/check-boundaries.mjs` fails before the change is accepted
- **中文** 当 implementation 引入对 provider internal adapter files 的外部 import 时，`npm run lint` 或 `node scripts/check-boundaries.mjs` 必须在 change 被接受前失败。
