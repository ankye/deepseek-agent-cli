## ADDED Requirements

### Requirement: Codex-Class Gap Reporting / Codex-Class 差距报告

CLI task-completion evaluation SHALL report DeepSeek CLI gaps against a Codex-class production coding agent baseline using explicit evidence boundaries.

CLI task-completion evaluation 必须基于明确证据边界，报告 DeepSeek CLI 相对 Codex-class 生产级 coding agent baseline 的差距。

#### Scenario: Gap report records source boundary / 差距报告记录来源边界
- **WHEN** a report compares DeepSeek CLI with Codex-class capabilities
- **THEN** it records whether Codex evidence came from an executed external baseline, official/public documentation refresh, or bounded current-session observation
- **AND** unsupported Codex claims are marked as unavailable or assumptions rather than facts
- **中文** 当报告将 DeepSeek CLI 与 Codex-class capabilities 对比时，必须记录 Codex evidence 来自 executed external baseline、official/public documentation refresh，还是 bounded current-session observation；未支持的 Codex 声明必须标为 unavailable 或 assumptions，而不是事实。

#### Scenario: Gap report separates product and model limits / 差距报告区分产品与模型限制
- **WHEN** a DeepSeek CLI task fails
- **THEN** the report identifies whether the failure occurred before model dispatch, during tool projection, during tool execution, during model action selection, during verification, or during final evidence scoring
- **AND** model limitation is not assigned when required tool projection or provider readiness was missing
- **中文** 当 DeepSeek CLI task 失败时，报告必须识别失败发生在 model dispatch 前、tool projection 中、tool execution 中、model action selection 中、verification 中，还是 final evidence scoring 中；当 required tool projection 或 provider readiness 缺失时，不得归因为 model limitation。

### Requirement: Completion Requires Capability Evidence / 完成需要能力证据

CLI task completion SHALL require evidence that required capabilities were available, invoked as needed, and produced accepted artifacts before a run can be marked solved.

CLI task completion 必须要求 evidence 证明必需 capabilities 可用、按需调用并产生已验收 artifacts，run 才能标记 solved。

#### Scenario: Final text cannot replace missing artifacts / Final Text 不能替代缺失产物
- **WHEN** a task requires a source edit, generated file, command result, test result, or report artifact
- **THEN** final assistant text alone is insufficient for `solved`
- **AND** the evaluator requires accepted artifact refs, diffs, checks, or evidence manifests according to the task rubric
- **中文** 当任务需要 source edit、generated file、command result、test result 或 report artifact 时，仅有 final assistant text 不足以标记 `solved`；evaluator 必须根据 task rubric 要求 accepted artifact refs、diffs、checks 或 evidence manifests。

#### Scenario: Required tool absence is capability gap / 必需工具缺失是能力缺口
- **WHEN** the selected profile and stage require a general-purpose tool family
- **AND** the family is absent, unregistered, hidden, or has no executable projection
- **THEN** the evaluator classifies the run as `blocked-by-cli-capability-gap` unless evidence proves the capability exists and failed due to a bug
- **中文** 当选中的 profile 与 stage 需要通用 tool family，且该 family absent、unregistered、hidden 或没有 executable projection 时，除非证据证明该 capability 存在但因 bug 失败，否则 evaluator 必须将 run 分类为 `blocked-by-cli-capability-gap`。

#### Scenario: Failure report guides the next correction / 失败报告指导下一次修正
- **WHEN** a capability-matrix task is planned or completed
- **THEN** the run record includes structured guidance with owner layer, root cause, recommended action, rerun condition, evidence gaps, and confidence
- **AND** the guidance distinguishes model behavior, prompt/profile assembly, tool projection, tool implementation, host policy/sandbox, credentials, test environment, and task design
- **AND** the rendered text report exposes a concise repair direction for each task rather than only pass/fail counts
- **中文** 当 capability-matrix task 被计划或完成时，run record 必须包含结构化 guidance，包括 owner layer、root cause、recommended action、rerun condition、evidence gaps 与 confidence；guidance 必须区分 model behavior、prompt/profile assembly、tool projection、tool implementation、host policy/sandbox、credentials、test environment 与 task design；文本报告必须为每个 task 暴露简洁的修复方向，而不仅是通过/失败数量。
