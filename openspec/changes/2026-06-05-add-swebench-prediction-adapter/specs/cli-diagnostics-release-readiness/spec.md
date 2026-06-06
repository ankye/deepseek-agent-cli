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

#### Scenario: Evaluation adapter runs official harness / Evaluation Adapter 运行官方 Harness

- **WHEN** `deepseek diagnostics swe-bench evaluate --predictions-path <path> --report-dir <path> --run-id <id> --instance-id <id>` runs
- **THEN** the adapter invokes the official `swebench.harness.run_evaluation` module with the provided prediction JSONL, run id, instance ids, dataset name, split, and report working directory
- **AND** relative prediction, report, and harness Python paths are normalized against the CLI workspace before the harness process changes into the report working directory
- **AND** the adapter detects the active Docker context host and passes it to the Python harness subprocess through `DOCKER_HOST` when available
- **AND** it reads the resulting harness `report.json`
- **AND** diagnostics include the completed flag, resolved flag, report path, model name, instance id, and `FAIL_TO_PASS` / `PASS_TO_PASS` success and failure counts
- **AND** diagnostics redact prediction paths, report paths, raw model patches, command arguments, stdout/stderr bodies, and internal metadata
- **AND** a single-instance evaluation result MUST NOT be reported as a public SWE-bench Lite leaderboard score
- **中文** 当运行 `deepseek diagnostics swe-bench evaluate --predictions-path <path> --report-dir <path> --run-id <id> --instance-id <id>` 时，adapter 必须用给定 prediction JSONL、run id、instance ids、dataset name、split 与 report working directory 调用官方 `swebench.harness.run_evaluation` module；relative prediction、report 与 harness Python paths 必须在 harness process 切换到 report working directory 前按 CLI workspace 归一化；adapter 必须检测 active Docker context host，并在可用时通过 `DOCKER_HOST` 传给 Python harness subprocess；必须读取产生的 harness `report.json`；diagnostics 必须包含 completed flag、resolved flag、report path、model name、instance id，以及 `FAIL_TO_PASS` / `PASS_TO_PASS` 成功和失败数量；diagnostics 必须脱敏 prediction paths、report paths、raw model patches、command arguments、stdout/stderr bodies 与 internal metadata；单题 evaluation result 不得被报告为公开 SWE-bench Lite 榜单分。
