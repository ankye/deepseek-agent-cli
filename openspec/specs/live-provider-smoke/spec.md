# live-provider-smoke Specification

## Purpose
Define live provider smoke requirements for opt-in DeepSeek reachability, structural assertions, credential safety, and default skip behavior.

定义 live provider smoke 对显式启用的 DeepSeek reachability、structural assertions、credential safety 与默认跳过行为的要求。
## Requirements
### Requirement: Opt-In Live Provider Smoke / 显式启用的 Live Provider Smoke

The repository SHALL provide a dedicated live DeepSeek provider smoke path that is skipped unless `DEEPSEEK_LIVE_TESTS=1` is set and a DeepSeek credential is available.

repository 必须提供专用 live DeepSeek provider smoke path，只有设置 `DEEPSEEK_LIVE_TESTS=1` 且存在 DeepSeek credential 时才运行，否则跳过。

#### Scenario: Live smoke is skipped by default / 默认跳过 live smoke

- **WHEN** the live smoke script runs without `DEEPSEEK_LIVE_TESTS=1`
- **THEN** it exits successfully with a skipped status and performs no network request
- **中文** 当 live smoke script 在未设置 `DEEPSEEK_LIVE_TESTS=1` 时运行，它必须成功退出并标记 skipped，且不发起网络请求。

#### Scenario: Live smoke streams real response / Live smoke 流式返回真实响应

- **WHEN** `DEEPSEEK_LIVE_TESTS=1` and a credential are available
- **THEN** the smoke sends one minimal OpenAI-like chat completion request and observes normalized text, finish or done, and provider metadata events
- **中文** 当 `DEEPSEEK_LIVE_TESTS=1` 且 credential 可用时，smoke 必须发送一次最小 OpenAI-like chat completion request，并观察 normalized text、finish 或 done 以及 provider metadata events。

### Requirement: Secret-Safe Live Evidence / Secret 安全的 Live 证据

Live provider smoke output SHALL contain only redacted summaries and SHALL NOT print, persist, or serialize raw API keys, authorization headers, or full request bodies.

live provider smoke output 必须只包含脱敏摘要，且不得打印、持久化或序列化 raw API keys、authorization headers 或完整 request bodies。

#### Scenario: Credential is redacted / 凭证被脱敏

- **WHEN** the live smoke resolves a credential from `.env` or process environment
- **THEN** the credential is passed as a scoped secret reference and the output contains no raw secret value
- **中文** 当 live smoke 从 `.env` 或 process environment 解析 credential 时，该 credential 必须作为 scoped secret reference 传递，输出不得包含 raw secret value。

#### Scenario: Provider error is redacted / Provider 错误被脱敏

- **WHEN** the provider returns an error or transport failure
- **THEN** the smoke reports a redacted error code/message without dumping request headers or body
- **中文** 当 provider 返回 error 或 transport failure 时，smoke 必须报告脱敏 error code/message，不得 dump request headers 或 body。

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

#### Scenario: GLM live agent tool smoke executes runtime tools / GLM live agent tool smoke 执行 runtime tools

- **WHEN** `GLM_ANTHROPIC_LIVE_AGENT_TOOL_TESTS=1` and a credential are available
- **THEN** the smoke runs a live agent loop through the GLM provider and observes model tool intent, governed tool result feedback, and loop completion without leaking raw credentials
- **中文** 当 `GLM_ANTHROPIC_LIVE_AGENT_TOOL_TESTS=1` 且 credential 可用时，smoke 必须通过 GLM provider 运行 live agent loop，并观察 model tool intent、governed tool result feedback 与 loop completion，且不得泄露 raw credentials。
