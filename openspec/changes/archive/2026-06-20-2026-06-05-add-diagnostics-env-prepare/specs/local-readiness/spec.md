## ADDED Requirements

### Requirement: Diagnostics Environment Preparation Profiles / 诊断环境准备 Profile

Local readiness SHALL expose explicit environment preparation profiles that inspect and optionally prepare local development or evaluation prerequisites without storing raw secrets or running arbitrary user-supplied commands.

local readiness 必须暴露明确的 environment preparation profiles，用于检查并可选准备本地开发或评测前置条件，且不得存储 raw secrets 或运行用户提供的任意命令。

#### Scenario: SWE-bench Lite profile checks required prerequisites / SWE-bench Lite Profile 检查必要前置条件

- **WHEN** `deepseek diagnostics env prepare --profile swe-bench-lite` runs
- **THEN** the result includes stable dependency records for Docker CLI, Docker daemon, Docker host wiring, Python virtualenv, SWE-bench package, Rust toolchain, GLM credential reference, and optional Hugging Face token presence
- **AND** the result reports each dependency as `detected`, `missing`, `fixed`, `blocked`, or `skipped` with suggested actions and redaction metadata
- **中文** 当 `deepseek diagnostics env prepare --profile swe-bench-lite` 运行时，结果必须包含 Docker CLI、Docker daemon、Docker host wiring、Python virtualenv、SWE-bench package、Rust toolchain、GLM credential reference 与可选 Hugging Face token 的稳定 dependency records；每个 dependency 必须以 `detected`、`missing`、`fixed`、`blocked` 或 `skipped` 报告，并包含 suggested actions 与 redaction metadata。

#### Scenario: Environment preparation is dry-run by default / 环境准备默认 Dry-Run

- **WHEN** `deepseek diagnostics env prepare --profile swe-bench-lite` runs without `--execute`
- **THEN** the CLI does not mutate the host, does not start Docker or Colima, does not create virtualenvs, does not install packages, and emits an allowlisted command plan instead
- **中文** 当 `deepseek diagnostics env prepare --profile swe-bench-lite` 未带 `--execute` 运行时，CLI 不得修改 host，不得启动 Docker 或 Colima，不得创建 virtualenv，不得安装 packages，而是输出 allowlisted command plan。

#### Scenario: Environment preparation execution is allowlisted / 环境准备执行受 Allowlist 限制

- **WHEN** `deepseek diagnostics env prepare --profile swe-bench-lite --execute` runs
- **THEN** only profile-owned allowlisted steps may execute, each step records command id, status, exit code, elapsed time, and redacted output summary
- **AND** unsupported profile ids, unsupported actions, or extra positional arguments fail before any step executes
- **中文** 当 `deepseek diagnostics env prepare --profile swe-bench-lite --execute` 运行时，只有 profile 拥有的 allowlisted steps 可以执行；每个 step 必须记录 command id、状态、exit code、耗时与脱敏 output summary；unsupported profile id、unsupported action 或额外 positional arguments 必须在任何 step 执行前失败。

#### Scenario: Environment credentials are references only / 环境凭证仅作为引用

- **WHEN** an environment profile checks GLM or Hugging Face credentials
- **THEN** output reports credential source class and presence without printing, persisting, or embedding raw credential values in command plans, JSON, JSONL, text output, or evidence files
- **中文** 当 environment profile 检查 GLM 或 Hugging Face credentials 时，输出只能报告 credential source class 与 presence，不得在 command plans、JSON、JSONL、text output 或 evidence files 中打印、持久化或嵌入 raw credential values。
