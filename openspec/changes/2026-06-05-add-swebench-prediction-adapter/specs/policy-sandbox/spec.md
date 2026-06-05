## ADDED Requirements

### Requirement: Explicit Live Repo Process Execution

The live CLI dependency factory SHALL distinguish workspace file writes from workspace process execution, and SHALL allow process execution only when the caller explicitly requests live all-tools repository execution.

Live CLI dependency factory 必须区分 workspace file writes 与 workspace process execution，并且只有 caller 显式请求 live all-tools repository execution 时才允许 process execution。

#### Scenario: All-tools live repo run may execute scoped process commands / All-tools Live Repo Run 可执行受限进程命令

- **WHEN** a live CLI run creates dependencies for a benchmark repository with `allowWorkspaceWrites=true` and `allowWorkspaceProcesses=true`
- **THEN** workspace-scoped file writes are allowed
- **AND** workspace-scoped process commands are allowed when sandbox checks allow the active repository cwd
- **AND** the policy audit includes a live CLI process execution reason code
- **AND** process execution remains denied when `allowWorkspaceProcesses` is not enabled
- **中文** 当 live CLI run 为 benchmark repository 创建 dependencies，且设置 `allowWorkspaceWrites=true` 与 `allowWorkspaceProcesses=true` 时，workspace-scoped file writes 必须被允许；当 sandbox checks 允许 active repository cwd 时，workspace-scoped process commands 也必须被允许；policy audit 必须包含 live CLI process execution reason code；未启用 `allowWorkspaceProcesses` 时 process execution 必须仍然被拒绝。
