## ADDED Requirements

### Requirement: Ordinary CLI Stage Progression

The agent loop SHALL distinguish ordinary CLI staged workflows from evaluation runner workflows before applying stage acceptance gates.

Agent loop 必须在应用 stage acceptance gate 前区分普通 CLI staged workflows 与 evaluation runner workflows。

#### Scenario: Ordinary CLI workflow auto-advances from accepted evidence / 普通 CLI workflow 根据已接受证据自动推进

- **WHEN** an ordinary CLI engineering workflow stage completes a runtime-accepted tool action
- **THEN** the agent loop records typed stage evaluation evidence and advances the stage without requiring technical-director acceptance
- **AND** the next dependent stage becomes ready when its input refs are satisfied
- **中文** 当普通 CLI engineering workflow stage 完成 runtime 已接受的工具动作时，agent loop 必须记录结构化 stage evaluation evidence，并在不要求技术总监验收的情况下推进该 stage；当依赖 input refs 满足时，下一个依赖 stage 必须变为 ready。

#### Scenario: Evaluation runner workflows keep supervisor acceptance / Evaluation runner workflow 保留 supervisor 验收

- **WHEN** an evaluation or managed runner workflow stage completes tool evidence
- **THEN** the agent loop MAY require supervisor or technical-director acceptance before downstream expansion according to the profile's stage acceptance mode
- **中文** 当 evaluation 或 managed runner workflow stage 完成工具证据时，agent loop 可以根据 profile 的 stage acceptance mode 要求 supervisor 或技术总监验收后再扩展下游。

### Requirement: Active Workflow Projection Does Not Fall Back To All Tools

Primary staged workflows SHALL NOT expose every model-visible tool merely because no stage is currently ready.

Primary staged workflows 不得仅因为当前没有 ready stage 就暴露所有 model-visible tools。

#### Scenario: Active workflow without ready stage fails closed / Active workflow 无 ready stage 时安全失败

- **WHEN** a primary staged workflow has unfinished stages but no ready stage and no explicit supervisor gate override
- **THEN** the agent loop emits a typed workflow orchestration blocker or projects a bounded supervisor recovery action
- **AND** it does not fall back to all registered model-visible tools
- **中文** 当 primary staged workflow 存在未完成 stage、但没有 ready stage 且没有显式 supervisor gate override 时，agent loop 必须发出 typed workflow orchestration blocker 或投影有界 supervisor recovery action；不得回退到所有已注册 model-visible tools。
