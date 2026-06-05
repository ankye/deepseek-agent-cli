## ADDED Requirements

### Requirement: SWE-bench Prediction Adapter

CLI diagnostics SHALL expose a `diagnostics swe-bench predict` adapter that produces official-compatible SWE-bench prediction JSONL from a prepared benchmark repository checkout.

CLI diagnostics 必须暴露 `diagnostics swe-bench predict` adapter，用于从已准备好的 benchmark repository checkout 生成兼容官方 SWE-bench 的 prediction JSONL。

#### Scenario: Prediction adapter writes official JSONL / Prediction Adapter 写出官方 JSONL

- **WHEN** `deepseek diagnostics swe-bench predict --instance-file <path> --repo-dir <path> --output-path <path> --live --provider glm --model glm-5.1` runs
- **THEN** the adapter reads the instance id and problem statement from the instance file
- **AND** it runs the selected CLI provider/model inside the repository checkout with explicit all-tools projection
- **AND** it extracts the repository `git diff` after the run
- **AND** it writes one JSONL record containing `instance_id`, `model_name_or_path`, and `model_patch`
- **AND** diagnostics include redacted invocation metadata without raw credentials, raw model request bodies, raw model responses, or unbounded stdout/stderr
- **中文** 当运行 `deepseek diagnostics swe-bench predict --instance-file <path> --repo-dir <path> --output-path <path> --live --provider glm --model glm-5.1` 时，adapter 必须从 instance file 读取 instance id 与 problem statement；必须在 repository checkout 内用显式 all-tools projection 运行所选 CLI provider/model；必须在运行后提取 repository `git diff`；必须写出一条包含 `instance_id`、`model_name_or_path` 与 `model_patch` 的 JSONL record；diagnostics 必须包含脱敏 invocation metadata，且不得包含 raw credentials、raw model request bodies、raw model responses 或无界 stdout/stderr。

#### Scenario: Prediction adapter validates inputs before execution / Prediction Adapter 执行前校验输入

- **WHEN** `diagnostics swe-bench predict` is missing the instance file, repository directory, output path, or receives unsupported extra arguments
- **THEN** diagnostics return a typed failure before launching a model, running repository commands, or writing prediction files
- **AND** rejected paths and extra arguments are reported only through internal redacted metadata
- **中文** 当 `diagnostics swe-bench predict` 缺少 instance file、repository directory、output path，或收到 unsupported extra arguments 时，diagnostics 必须在启动模型、运行 repo commands 或写 prediction files 前返回 typed failure；被拒绝的 paths 与 extra args 只能通过 internal redacted metadata 报告。
