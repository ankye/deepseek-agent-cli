## ADDED Requirements

### Requirement: Adapter Refactor Regression / Adapter Refactor Regression

Provider adapter file reorganization SHALL be covered by deterministic regression tests that prove request construction, stream normalization, error redaction, and public exports remain stable.

provider adapter file reorganization 必须由 deterministic regression tests 覆盖，以证明 request construction、stream normalization、error redaction 与 public exports 保持稳定。

#### Scenario: Offline tests cover adapter moves / Offline tests 覆盖 adapter moves

- **WHEN** adapter implementation files move under vendor/protocol directories
- **THEN** focused model-gateway tests pass without live credentials or network access
- **中文** 当 adapter implementation files 移动到 vendor/protocol directories 下时，focused model-gateway tests 必须在不需要 live credentials 或 network access 的情况下通过。

#### Scenario: Live smoke gates remain opt-in / Live smoke gates 保持 opt-in

- **WHEN** default `npm test` runs after adapter reorganization
- **THEN** DeepSeek and GLM live smoke tests remain skipped unless their provider-specific live environment gates are explicitly set
- **中文** 当 adapter reorganization 后运行默认 `npm test` 时，DeepSeek 与 GLM live smoke tests 必须继续跳过，除非显式设置 provider-specific live environment gates。
