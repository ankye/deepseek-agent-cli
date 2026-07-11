## ADDED Requirements

### Requirement: Workflow Recovery Starts From Accepted Next Action

Workflow recovery SHALL start from the shared board's accepted next allowed action instead of resetting to unrestricted discovery by default.

workflow recovery 必须从共享 board 已接受的 next allowed action 开始，而不是默认重置为 unrestricted discovery。

#### Scenario: Recovery resumes after source inspection without mutation

- **WHEN** a child attempt fails after accepted focused evidence exists but before accepted mutation evidence exists
- **THEN** failure analysis records whether the next allowed action is mutation, focused evidence query, blocker, or stop
- **AND** the next child attempt is constrained by that accepted next allowed action
- **AND** the workflow does not restart at unrestricted discovery unless accepted failure-analysis proof invalidates the prior focused evidence
- **中文** 当 child attempt 在已有 accepted focused evidence 但尚无 accepted mutation evidence 后失败时，failure analysis 必须记录 next allowed action 是 mutation、focused evidence query、blocker 还是 stop；下一次 child attempt 必须受该已接受 next allowed action 约束；除非 accepted failure-analysis proof 证明此前 focused evidence 无效，workflow 不得重启到 unrestricted discovery。

#### Scenario: Recovery resumes after mutation with invalid verification

- **WHEN** a child attempt has accepted mutation evidence and then repeatedly requests invalid verification commands
- **THEN** workflow recovery keeps the accepted mutation evidence
- **AND** the next attempt or retry projects standard verification as the next action unless failure-analysis evidence proves the mutation is invalid
- **中文** 当 child attempt 已有 accepted mutation evidence 后重复请求 invalid verification commands 时，workflow recovery 必须保留 accepted mutation evidence；除非 failure-analysis evidence 证明 mutation 无效，下一次 attempt 或 retry 必须投影 standard verification 作为 next action。

### Requirement: Workflow Stage Projection Is Minimal And Action-Oriented

Workflow orchestration SHALL expose only the active stage, one accepted next action, accepted input refs, and currently visible capability families to model prompt assembly.

workflow orchestration 必须只向 model prompt assembly 暴露 active stage、一个已接受 next action、accepted input refs 与当前可见 capability families。

#### Scenario: Historical workflow state is summarized

- **WHEN** a staged workflow has historical stage records, rejected candidate actions, technical-director notes, cache diagnostics, or parent-only orchestration events
- **THEN** workflow orchestration keeps those records on the durable board
- **AND** prompt assembly receives only bounded summaries required by the current next action
- **中文** 当 staged workflow 拥有历史 stage records、rejected candidate actions、technical-director notes、cache diagnostics 或 parent-only orchestration events 时，workflow orchestration 必须将这些 records 保留在 durable board；prompt assembly 只能接收当前 next action 所需的有界 summaries。

#### Scenario: Stage advancement consumes accepted refs

- **WHEN** a stage attempts to advance from focused evidence to mutation, mutation to verification, or verification to package
- **THEN** workflow orchestration consumes only accepted refs and convergence decisions
- **AND** failed, blocked, stale, partial, or unreviewed refs cannot advance the stage as successful progress
- **中文** 当 stage 试图从 focused evidence 推进到 mutation、从 mutation 推进到 verification，或从 verification 推进到 package 时，workflow orchestration 只能消费 accepted refs 与 convergence decisions；failed、blocked、stale、partial 或未 review 的 refs 不得作为成功 progress 推进 stage。
