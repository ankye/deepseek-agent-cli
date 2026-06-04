## ADDED Requirements

### Requirement: Optional GLM Live Provider Smoke / 可选 GLM Live Provider Smoke

The repository SHALL provide a dedicated live GLM Anthropic-compatible provider smoke path that is skipped unless `GLM_ANTHROPIC_LIVE_TESTS=1` is set and a GLM credential is available.

repository 必须提供专用 live GLM Anthropic-compatible provider smoke path，只有设置 `GLM_ANTHROPIC_LIVE_TESTS=1` 且存在 GLM credential 时才运行，否则跳过。

#### Scenario: GLM live smoke is skipped by default / GLM live smoke 默认跳过

- **WHEN** the GLM live smoke script runs without `GLM_ANTHROPIC_LIVE_TESTS=1`
- **THEN** it exits successfully with a skipped status and performs no network request
- **中文** 当 GLM live smoke script 未设置 `GLM_ANTHROPIC_LIVE_TESTS=1` 时，它必须成功退出并标记 skipped，且不发起网络请求。

#### Scenario: GLM live smoke streams real response / GLM live smoke 流式返回真实响应

- **WHEN** `GLM_ANTHROPIC_LIVE_TESTS=1` and a credential are available
- **THEN** the smoke sends one minimal Anthropic Messages request and observes normalized text, finish or done, and GLM provider metadata events
- **中文** 当 `GLM_ANTHROPIC_LIVE_TESTS=1` 且 credential 可用时，smoke 必须发送一次最小 Anthropic Messages request，并观察 normalized text、finish or done 与 GLM provider metadata events。
