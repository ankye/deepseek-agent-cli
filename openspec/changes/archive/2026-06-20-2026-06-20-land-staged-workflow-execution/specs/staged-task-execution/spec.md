## ADDED Requirements

### Requirement: Primary Workflow Ready-Stage Control / 主工作流 Ready Stage 控制

The runtime SHALL derive an executable ready-stage control record from every primary staged workflow before model dispatch when the workflow has at least one ready stage.

当 primary staged workflow 至少存在一个 ready stage 时，runtime 必须在 model dispatch 前从该 workflow 推导出可执行的 ready-stage control record。

#### Scenario: Ready stage becomes execution control / Ready Stage 变成执行控制

- **WHEN** a selected profile has `workflowPriority: "primary"` and `orchestrationMode: "staged-capability-workflow"`
- **AND** its compiled staged-task run state has a ready stage
- **THEN** the runtime records a ready-stage control event before `model.requested`
- **AND** the control includes workflow graph id, stage id, stage kind, allowed capability ids, progress capability ids, preferred capability id when determinable, no-tool policy, terminal-close policy, and redaction metadata
- **AND** the control is host-neutral and generic across task families
- **中文** 当所选 profile 具有 `workflowPriority: "primary"` 与 `orchestrationMode: "staged-capability-workflow"`，且其 compiled staged-task run state 存在 ready stage 时，runtime 必须在 `model.requested` 前记录 ready-stage control event；该 control 必须包含 workflow graph id、stage id、stage kind、allowed capability ids、progress capability ids、可确定时的 preferred capability id、no-tool policy、terminal-close policy 与 redaction metadata；该 control 必须 host-neutral，且对任务族通用。

#### Scenario: No ready stage fails closed when required / 无 Ready Stage 时安全失败

- **WHEN** a primary staged workflow is selected
- **AND** the workflow cannot compute any ready stage
- **AND** the task is not already terminal
- **THEN** the runtime emits a typed workflow diagnostic and does not silently fall back to a generic conversational loop
- **中文** 当 primary staged workflow 已选择，但 workflow 无法计算任何 ready stage，且 task 尚未终态时，runtime 必须发出 typed workflow diagnostic，不得静默退回通用对话 loop。

### Requirement: Stage Progress Requires Completion-Grade Evidence / Stage 推进需要完成级证据

Ready-stage control SHALL distinguish allowed support capabilities from capabilities that can complete or progress the active stage.

ready-stage control 必须区分允许的辅助 capability 与能够完成或推进 active stage 的 capability。

#### Scenario: Support evidence does not complete mutation stage / 辅助证据不完成变更阶段

- **WHEN** a ready stage allows read/search/list tools as supporting evidence
- **AND** the stage kind requires mutation-grade, verification-grade, or terminal-capability evidence
- **THEN** successful support tool execution may be recorded as evidence but MUST NOT complete the stage
- **AND** the next ready-stage control still names the required progress capability class
- **中文** 当 ready stage 允许 read/search/list 工具作为辅助证据，但 stage kind 需要 mutation-grade、verification-grade 或 terminal-capability evidence 时，成功的辅助工具执行可以记录为 evidence，但不得完成 stage；下一次 ready-stage control 仍必须指出所需 progress capability class。

### Requirement: Stage Evaluation Gates Success / Stage 评估决定成功

Every staged workflow stage SHALL evaluate its produced outputs and evidence against the stage acceptance policy before the controller marks the stage as succeeded.

每个 staged workflow stage 在 controller 标记 succeeded 前，必须根据 stage acceptance policy 评估其产出的 outputs 与 evidence。

#### Scenario: Output refs alone do not pass a stage / 只有输出引用不算 Stage 通过

- **WHEN** a stage executor returns artifact refs, evidence refs, check refs, diagnostics, or bounded output previews
- **THEN** the controller records them as produced evidence
- **AND** the stage remains not succeeded until a stage evaluation result is recorded with status `passed`
- **AND** statuses `needs-review`, `failed`, and `blocked` MUST NOT be collapsed into success merely because output exists
- **中文** 当 stage executor 返回 artifact refs、evidence refs、check refs、diagnostics 或有界输出 preview 时，controller 必须将其记录为 produced evidence；只有记录了 status 为 `passed` 的 stage evaluation result 后，stage 才能 succeeded；不得因为存在输出就把 `needs-review`、`failed` 或 `blocked` 压成成功。

#### Scenario: Evaluation result is typed evidence / Evaluation Result 是类型化证据

- **WHEN** a stage evaluation runs
- **THEN** it records evaluator id, acceptance policy id, status, optional score, threshold when applicable, reason codes, consumed evidence refs, produced diagnostic refs, and redaction metadata
- **AND** the stage transition event links to that evaluation result
- **中文** 当 stage evaluation 运行时，必须记录 evaluator id、acceptance policy id、status、可选 score、适用时的 threshold、reason codes、consumed evidence refs、produced diagnostic refs 与 redaction metadata；stage transition event 必须链接该 evaluation result。

#### Scenario: Evaluation can be deterministic or model-assisted / Evaluation 可确定性或模型辅助

- **WHEN** a stage acceptance policy can be checked by schema, exit code, score threshold, diff presence, test result, artifact inspection, or diagnostic code
- **THEN** evaluation MUST use deterministic checks first
- **AND** model-assisted review MAY add bounded qualitative judgment only after deterministic evidence is recorded
- **AND** model-assisted review MUST NOT override deterministic failure without an explicit repair or reviewer policy
- **中文** 当 stage acceptance policy 可通过 schema、exit code、score threshold、diff presence、test result、artifact inspection 或 diagnostic code 检查时，evaluation 必须先使用确定性检查；模型辅助 review 只能在确定性证据已记录后添加有界质量判断；没有显式 repair 或 reviewer policy 时，模型辅助 review 不得覆盖确定性失败。

### Requirement: Technical Director Acceptance Gates Final Success / 技术总监验收决定最终成功

Every stage or pipeline step SHALL require an explicit technical-director acceptance record before its success state becomes final.

每个 stage 或 pipeline step 在成功状态最终成立前，必须要求显式的技术总监验收记录。

#### Scenario: Passing evaluator is not enough / Evaluator 通过仍不足够

- **WHEN** a stage evaluation returns `passed`
- **THEN** the controller records the evaluation as proposed acceptance
- **AND** the stage MUST NOT transition to final `succeeded` until a technical-director acceptance record confirms the acceptance criteria, evidence sufficiency, residual risks, and pass/fail disposition
- **AND** if the technical director marks evidence insufficient, the stage transitions to `needs-review`, `blocked`, or `failed` according to the recorded disposition
- **中文** 当 stage evaluation 返回 `passed` 时，controller 必须将该 evaluation 记录为 proposed acceptance；只有技术总监验收记录确认验收标准、证据充分性、残余风险与通过/失败结论后，stage 才能最终转为 `succeeded`；如果技术总监标记证据不足，则 stage 必须根据记录的结论转为 `needs-review`、`blocked` 或 `failed`。

#### Scenario: Acceptance record is auditable / 验收记录可审计

- **WHEN** technical-director acceptance is recorded
- **THEN** it includes reviewer role `technical-director`, acceptance criteria ids, evaluation result ids, evidence refs reviewed, decision `accepted`, `rejected`, `needs-review`, or `blocked`, rationale, residual risks, timestamp, and redaction metadata
- **AND** automated director policy may produce the record only when the policy id and deterministic evidence basis are recorded
- **中文** 当记录技术总监验收时，必须包含 reviewer role `technical-director`、acceptance criteria ids、evaluation result ids、已审 evidence refs、decision `accepted`、`rejected`、`needs-review` 或 `blocked`、rationale、residual risks、timestamp 与 redaction metadata；只有记录 policy id 与确定性证据依据后，自动化 director policy 才能产生该记录。

#### Scenario: Criteria applicability is confirmed each time / 每次都确认验收标准适用性

- **WHEN** a stage or pipeline step reaches evaluation
- **THEN** the technical-director acceptance record confirms whether the configured acceptance criteria are applicable to the current stage output
- **AND** if criteria are missing, stale, too weak, or not applicable, the step cannot pass and must record a criteria-defect diagnostic
- **中文** 当 stage 或 pipeline step 到达 evaluation 时，技术总监验收记录必须确认配置的验收标准是否适用于当前 stage output；如果标准缺失、过期、过弱或不适用，该 step 不得通过，并必须记录 criteria-defect diagnostic。
