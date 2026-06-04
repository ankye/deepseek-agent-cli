## 1. OpenSpec And Contracts / OpenSpec 与契约

- [x] 1.1 Add bilingual OpenSpec requirements for provider-aware readiness doctor and GLM live release evidence parity. / 增加 provider-aware readiness doctor 与 GLM live release evidence parity 的双语 OpenSpec requirements。
- [x] 1.2 Validate `provider-live-readiness-parity` with strict OpenSpec mode. / 使用 strict OpenSpec mode 校验 `provider-live-readiness-parity`。

## 2. Readiness Provider Selection / Readiness Provider 选择

- [x] 2.1 Add failing contract tests for selected provider metadata, GLM credential checks, and provider-specific live doctor messages. / 增加失败的 contract tests，覆盖 selected provider metadata、GLM credential checks 与 provider-specific live doctor messages。
- [x] 2.2 Extend readiness environment and result metadata without exposing raw secrets. / 扩展 readiness environment 与 result metadata，且不暴露 raw secrets。
- [x] 2.3 Keep default doctor offline and DeepSeek-compatible. / 保持默认 doctor offline 与 DeepSeek-compatible。

## 3. CLI Diagnostics Wiring / CLI Diagnostics 接线

- [x] 3.1 Add failing CLI tests proving `diagnostics doctor --live --provider glm --model glm-5.1` reaches the GLM live verifier path. / 增加失败的 CLI tests，证明 `diagnostics doctor --live --provider glm --model glm-5.1` 会进入 GLM live verifier path。
- [x] 3.2 Parse diagnostics provider/model selection and pass it into readiness input. / 解析 diagnostics provider/model selection 并传入 readiness input。
- [x] 3.3 Build GLM and DeepSeek live verifiers from provider-neutral model profiles. / 基于 provider-neutral model profiles 构建 GLM 与 DeepSeek live verifiers。

## 4. Release Evidence And Acceptance Index / 发布证据与验收索引

- [x] 4.1 Add failing tests for GLM live evidence entries and provider-specific evidence classification. / 增加失败测试，覆盖 GLM live evidence entries 与 provider-specific evidence classification。
- [x] 4.2 Add GLM acceptance index entries and release evidence recognition without weakening existing DeepSeek gates. / 增加 GLM acceptance index entries 与 release evidence recognition，且不削弱现有 DeepSeek gates。

## 5. Verification / 校验

- [x] 5.1 Run focused contract and CLI tests. / 运行聚焦 contract 与 CLI tests。
- [x] 5.2 Run OpenSpec, typecheck, lint, tests, boundaries, and hygiene checks. / 运行 OpenSpec、typecheck、lint、tests、boundaries 与 hygiene checks。
- [x] 5.3 Run live GLM smokes with credentials supplied out-of-band and confirm diagnostics output is redacted. / 使用 out-of-band credentials 运行 live GLM smokes，并确认 diagnostics output 已脱敏。
