## ADDED Requirements

### Requirement: Managed Runner Has Staged Child Orchestration / 受管 Runner 具备 Child 分阶段编排

A terminal runner capability that supervises a child solver SHALL represent the child run as staged workflow contract data rather than an unstructured subprocess.

监督 child solver 的 terminal runner capability 必须将 child run 表示为 staged workflow contract data，而不是无结构 subprocess。

#### Scenario: Runner stages are explicit / Runner Stage 显式存在

- **WHEN** a managed benchmark-style runner starts a child solver
- **THEN** it records stages for prepare, understand, change, verify, score, package, and return
- **AND** each stage has entry criteria, exit criteria, allowed capability families, accepted input refs, expected output refs, evaluation result, and technical-director acceptance state
- **中文** 当受管 benchmark 类 runner 启动 child solver 时，必须记录 prepare、understand、change、verify、score、package 与 return stages；每个 stage 必须包含 entry criteria、exit criteria、allowed capability families、accepted input refs、expected output refs、evaluation result 与技术总监验收状态。

#### Scenario: Parent receives one terminal child outcome / Parent 只接收一个 Child 终态结果

- **WHEN** the child run completes, fails, is blocked, times out, or is cancelled
- **THEN** the runner packages one bounded terminal outcome for the parent supervisor
- **AND** the parent loop does not continue asking the model for alternate actions after a terminal child outcome
- **中文** 当 child run 完成、失败、阻塞、超时或取消时，runner 必须为 parent supervisor 打包一个有界终态结果；parent loop 不得在 child 终态结果之后继续要求模型尝试其它动作。

### Requirement: Runner Attribution Is Evidence-Gated / Runner 归因由证据 Gate 控制

Managed runner workflows SHALL evaluate tool availability, environment state, harness state, packaging state, budget state, and model behavior separately.

受管 runner workflow 必须分别评估工具可用性、环境状态、harness 状态、打包状态、预算状态与模型行为。

#### Scenario: Model attribution requires readiness acceptance / 模型归因需要 Readiness 验收

- **WHEN** a managed child run fails
- **THEN** model-owned attribution is allowed only after technical-director acceptance confirms child tool matrix completeness, environment readiness or typed blocker, harness readiness or typed blocker, prediction packaging state, budget sufficiency, and model-visible feedback sufficiency
- **中文** 当 managed child run 失败时，只有技术总监验收确认 child tool matrix 完整、环境 ready 或有 typed blocker、harness ready 或有 typed blocker、prediction packaging state、budget sufficiency 与模型可见反馈充分后，才允许模型侧归因。
