## MODIFIED Requirements

### Requirement: CLI Evaluation Includes Webpage Generation Task / CLI 评估包含网页生成任务

CLI task-completion evaluation SHALL include a deterministic webpage-generation task with local artifact validation and SHALL allow DeepSeek-owned live execution only when explicitly requested.

CLI task-completion evaluation 必须包含带本地产物校验的 deterministic webpage-generation task，并且只有在显式请求时才允许 DeepSeek 自有 live execution。

#### Scenario: DeepSeek live webpage execution is opt-in / DeepSeek Live 网页执行显式开启

- **WHEN** `deepseek diagnostics evaluate --live --full --execute-task eval.webpage.generation --compare-baseline deepseek-cli` runs with live credentials available
- **THEN** the DeepSeek baseline command uses the live provider path, receives the webpage task prompt in an isolated workspace, exposes write-capable local file tools for the task profile, and the checker evaluates `generated-webpage`
- **中文** 当带可用 live credentials 运行 `deepseek diagnostics evaluate --live --full --execute-task eval.webpage.generation --compare-baseline deepseek-cli` 时，DeepSeek baseline command 必须使用 live provider path，在隔离 workspace 中接收网页任务 prompt，为该任务 profile 暴露可写本地文件工具，并由 checker 校验 `generated-webpage`。

#### Scenario: Non-live evaluation remains deterministic / 非 Live 评估保持确定性

- **WHEN** `deepseek diagnostics evaluate --full --execute-task eval.webpage.generation --compare-baseline deepseek-cli` runs without `--live`
- **THEN** the DeepSeek baseline does not call the live provider and records the deterministic outcome and diagnostics without requiring credentials
- **中文** 当未带 `--live` 运行 `deepseek diagnostics evaluate --full --execute-task eval.webpage.generation --compare-baseline deepseek-cli` 时，DeepSeek baseline 不得调用 live provider，必须记录 deterministic outcome 与 diagnostics，且不要求 credentials。

#### Scenario: Checker gates live success / Checker 决定 Live 成功

- **WHEN** the live DeepSeek model returns text but does not create valid local webpage artifacts
- **THEN** the task run is not marked solved; success requires the generated local HTML/CSS/JS artifacts to pass the webpage checker
- **中文** 当 live DeepSeek 模型返回文本但没有创建有效本地网页产物时，task run 不得标记为 solved；成功必须要求生成的本地 HTML/CSS/JS 产物通过 webpage checker。

#### Scenario: Live evaluation forwards GLM provider selection / Live Evaluation 透传 GLM Provider 选择

- **WHEN** `deepseek diagnostics evaluate --live --full --execute-task eval.webpage.generation --compare-baseline deepseek-cli --provider glm --model glm-5.1` runs with GLM credentials available
- **THEN** the isolated `deepseek run` subprocess receives `--provider glm --model glm-5.1`, uses the live path, and receives only redacted/presence-safe credential evidence in diagnostics output
- **中文** 当带可用 GLM credentials 运行 `deepseek diagnostics evaluate --live --full --execute-task eval.webpage.generation --compare-baseline deepseek-cli --provider glm --model glm-5.1` 时，隔离的 `deepseek run` 子进程必须收到 `--provider glm --model glm-5.1`，使用 live path，并且 diagnostics output 只包含脱敏或 presence-safe 的 credential evidence。
