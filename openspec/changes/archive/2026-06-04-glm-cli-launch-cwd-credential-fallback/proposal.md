# GLM CLI Launch CWD Credential Fallback

## Why

`deepseek diagnostics evaluate` executes live task runs in isolated temporary workspaces. When a maintainer launches the CLI from the project root with GLM credentials in the project `.env`, the child `deepseek run` process currently resolves credentials only from its task working directory and can fail with `PROVIDER_CREDENTIAL_MISSING` before any tool call happens.

`deepseek diagnostics evaluate` 会在隔离的临时 workspace 中执行 live task runs。当维护者从项目根目录启动 CLI，且 GLM credentials 位于项目 `.env` 中时，子进程 `deepseek run` 当前只从任务工作目录解析 credentials，可能在任何 tool call 前因 `PROVIDER_CREDENTIAL_MISSING` 失败。

## What Changes

- Add a credential loading requirement for GLM live CLI runs to support an explicit launch/current workspace fallback in addition to the task working directory.
- Keep process environment values higher priority than any `.env` file.
- Keep raw credentials out of diagnostics, traces, committed fixtures, and command output.

- 为 GLM live CLI runs 增加 credential loading 要求：除 task working directory 外，还要支持显式 launch/current workspace fallback。
- 保持 process environment 的优先级高于任何 `.env` 文件。
- 继续防止 raw credentials 进入 diagnostics、traces、committed fixtures 与 command output。
