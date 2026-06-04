## MODIFIED Requirements

### Requirement: GLM Credential Loading / GLM 凭据加载

Credential handling for GLM live provider flows SHALL load credentials from process environment or local `.env` files as scoped secret references without adding `.env` contents to traces, test fixtures, or committed files.

GLM live provider flows 的 credential handling 必须从 process environment 或本地 `.env` 文件加载 credentials，并作为 scoped secret references 使用，不得把 `.env` 内容加入 traces、test fixtures 或 committed files。

#### Scenario: Launch cwd credentials survive isolated task cwd / 启动目录凭证可用于隔离任务目录

- **WHEN** `deepseek run --live --provider glm` executes with a task working directory that differs from the CLI launch workspace
- **THEN** credential loading first honors process environment values, then the task working directory `.env`, then the launch workspace `.env`, and never serializes the raw GLM credential
- **中文** 当 `deepseek run --live --provider glm` 使用的 task working directory 与 CLI 启动 workspace 不同时，credential loading 必须先使用 process environment values，再使用 task working directory `.env`，再使用 launch workspace `.env`，且绝不序列化 raw GLM credential。
