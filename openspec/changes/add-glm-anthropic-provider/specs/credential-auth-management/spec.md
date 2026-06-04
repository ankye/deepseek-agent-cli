## ADDED Requirements

### Requirement: GLM Credential Loading / GLM 凭据加载

Credential handling for GLM live provider flows SHALL load credentials from process environment or a local `.env` file as scoped secret references without adding `.env` contents to traces, test fixtures, or committed files.

GLM live provider flows 的 credential handling 必须从 process environment 或本地 `.env` 文件加载 credentials，并作为 scoped secret references 使用，不得把 `.env` 内容加入 traces、test fixtures 或 committed files。

#### Scenario: Environment credentials take precedence / 环境变量凭据优先

- **WHEN** both process environment and `.env` contain a GLM credential
- **THEN** the process environment value is used and represented as a secret credential reference
- **中文** 当 process environment 和 `.env` 都包含 GLM credential 时，必须使用 process environment 值，并表示为 secret credential reference。

#### Scenario: Secret values are not serialized / Secret values 不被序列化

- **WHEN** live GLM smoke or CLI flow reports events, diagnostics, or failures
- **THEN** output does not contain raw API keys, `x-api-key` values, authorization headers, or full request bodies
- **中文** 当 live GLM smoke 或 CLI flow 报告 events、diagnostics 或 failures 时，输出不得包含 raw API keys、`x-api-key` values、authorization headers 或完整 request bodies。
