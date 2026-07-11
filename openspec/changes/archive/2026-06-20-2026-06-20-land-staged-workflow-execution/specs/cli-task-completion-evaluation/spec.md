## ADDED Requirements

### Requirement: Evaluation Uses Generic Workflow Execution / 评测使用通用工作流执行

Evaluation prompts SHALL validate the generic CLI staged workflow execution path rather than bypassing it with benchmark-specific command routing.

评测 prompt 必须验证通用 CLI staged workflow execution 路径，不得用 benchmark-specific command routing 绕过它。

#### Scenario: SWE-style evaluation is a stress case, not a bypass / SWE 类评测是压力用例而非旁路

- **WHEN** a SWE-style evaluation prompt is classified and assigned an evaluation profile
- **THEN** the run must pass through task intent evidence, selected profile metadata, compiled staged-task workflow, ready-stage control, governed capability projection, kernel execution, stage evidence, and supervisor terminal close
- **AND** production behavior MUST NOT directly invoke benchmark execution from the CLI host by matching repository names, instance ids, numbered task ids, or known benchmark phrases outside the normal intent/profile/workflow path
- **中文** 当 SWE 类 evaluation prompt 被分类并分配 evaluation profile 时，该 run 必须经过 task intent evidence、selected profile metadata、compiled staged-task workflow、ready-stage control、governed capability projection、kernel execution、stage evidence 与 supervisor terminal close；生产行为不得在正常 intent/profile/workflow 路径之外，通过匹配 repository name、instance id、编号 task id 或已知 benchmark phrase 从 CLI host 直接调用 benchmark execution。

#### Scenario: Basic workflow checklist gates benchmark expansion / 基础工作流清单阻止 Benchmark 扩批

- **WHEN** the basic staged workflow execution checklist lacks passing deterministic tests or current runtime evidence
- **THEN** evaluation governance treats low pass rate as architecture-blocked
- **AND** wider benchmark batches remain blocked until the checklist passes
- **AND** only single-canary architecture validation is allowed after generic framework fixes
- **中文** 当基础 staged workflow execution checklist 缺少通过的确定性测试或当前 runtime evidence 时，evaluation governance 必须把低通过率视为 architecture-blocked；在 checklist 通过前不得扩展更大 benchmark batch；通用框架修复后只允许单题 canary 架构验证。

#### Scenario: Technical director accepts every evaluation gate / 技术总监验收每个评估 Gate

- **WHEN** an evaluation run reports a stage, pipeline step, canary, batch gate, or release-readiness result as passed
- **THEN** the evidence must include a technical-director acceptance record confirming the acceptance criteria, evidence sufficiency, residual risks, and pass/fail decision
- **AND** without that record the result remains proposed, not accepted, and cannot unlock benchmark expansion or release readiness
- **中文** 当 evaluation run 把 stage、pipeline step、canary、batch gate 或 release-readiness result 报告为 passed 时，证据必须包含技术总监验收记录，确认验收标准、证据充分性、残余风险与通过/失败决定；没有该记录时，该结果只算 proposed，不算 accepted，不能解锁 benchmark 扩批或 release readiness。
