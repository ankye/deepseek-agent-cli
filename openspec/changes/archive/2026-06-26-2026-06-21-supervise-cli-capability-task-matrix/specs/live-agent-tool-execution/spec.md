## ADDED Requirements

### Requirement: Capability Matrix Evidence Artifacts

Live agent tool execution SHALL be auditable through per-task evidence artifacts when run under the supervised capability matrix.

在 supervised capability matrix 下运行时，live agent tool execution 必须通过每个任务的 evidence artifacts 可审计。

#### Scenario: Every task run records a bounded evidence bundle / 每次任务运行记录有界证据包

- **WHEN** a supervised capability-matrix task runs
- **THEN** the CLI SHALL record `prompt.txt`, `trace.jsonl`, `summary.json`, `diff.patch`, and `classification.json` under a run-specific directory
- **AND** the evidence bundle SHALL be sufficient to determine whether the CLI had the needed tools, called them correctly, advanced workflow stages, and closed with a valid terminal reason
- **中文** 当 supervised capability-matrix task 运行时，CLI 必须在 run-specific directory 下记录 `prompt.txt`、`trace.jsonl`、`summary.json`、`diff.patch` 和 `classification.json`；该 evidence bundle 必须足以判断 CLI 是否拥有所需工具、是否正确调用工具、是否推进 workflow stages，以及是否以有效 terminal reason 关闭。

#### Scenario: Disposable write tasks do not mutate the platform repository / Disposable 写任务不修改平台仓库

- **WHEN** a matrix task requires mutation
- **THEN** it SHALL run in a disposable fixture workspace
- **AND** the platform repository SHALL only receive matrix evidence artifacts, not task-target source edits
- **中文** 当 matrix task 需要变更时，必须在 disposable fixture workspace 中运行；平台仓库只能接收 matrix evidence artifacts，不得接收任务目标源码修改。
