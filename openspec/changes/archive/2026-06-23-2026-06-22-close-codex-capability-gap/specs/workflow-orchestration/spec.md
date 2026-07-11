## ADDED Requirements

### Requirement: Capability Affordance Compilation / 能力可供性编译

Workflow orchestration SHALL compile profile and stage capability-family requirements into a model-visible executable tool projection before dispatching a model request.

workflow orchestration 必须在 dispatch model request 前，将 profile 与 stage 的 capability-family requirements 编译为 model-visible executable tool projection。

#### Scenario: Stage projection exposes required tools / Stage Projection 暴露必需工具
- **WHEN** a stage declares required capability families
- **THEN** the compiler resolves each family through registry, host policy, sandbox, credential readiness, and executor availability
- **AND** the prompt assembly evidence records required family ids, resolved tool ids, hidden tool ids, projection policy, and projection status
- **中文** 当 stage 声明 required capability families 时，compiler 必须通过 registry、host policy、sandbox、credential readiness 与 executor availability 解析每个 family；prompt assembly evidence 必须记录 required family ids、resolved tool ids、hidden tool ids、projection policy 与 projection status。

#### Scenario: Missing required capability fails closed / 缺失必需能力安全失败
- **WHEN** a required family cannot resolve to at least one executable model-visible tool
- **THEN** the workflow emits a typed terminal blocker before provider dispatch
- **AND** the blocker is classified as `blocked-by-cli-capability-gap`, `blocked-by-cli-bug`, or `invalid-test-environment` according to the failing boundary
- **中文** 当 required family 无法解析为至少一个 executable model-visible tool 时，workflow 必须在 provider dispatch 前发出 typed terminal blocker；该 blocker 必须根据失败边界分类为 `blocked-by-cli-capability-gap`、`blocked-by-cli-bug` 或 `invalid-test-environment`。

#### Scenario: Optional capability degrades with evidence / 可选能力带证据降级
- **WHEN** an optional family is unavailable but all required families are ready
- **THEN** the stage may proceed in degraded mode
- **AND** the unavailable optional family is recorded in diagnostics without being hidden from gap reporting
- **中文** 当 optional family 不可用但所有 required families 已 ready 时，stage 可以以 degraded mode 继续；不可用的 optional family 必须记录在 diagnostics 中，且不得从 gap reporting 中隐藏。

### Requirement: Pipeline Outputs Require Evaluation Gates / Pipeline 输出需要评估 Gate

Workflow orchestration SHALL evaluate every pipeline step output before downstream steps can treat it as accepted input.

workflow orchestration 必须评估每个 pipeline step output，下游 step 才能将其作为已接受输入使用。

#### Scenario: Stage identity matches required progress action / 阶段身份匹配必需推进动作
- **WHEN** a ready stage requires mutation-grade progress such as write, edit, or patch
- **THEN** the stage id, stage kind, objective, ready-state prompt, and required next action describe a production or implementation action rather than a test-only action
- **AND** the ready-state prompt lists allowed capabilities, progress capabilities, and the exact required capability choices before provider dispatch
- **中文** 当 ready stage 要求 write、edit 或 patch 等 mutation-grade progress 时，stage id、stage kind、objective、ready-state prompt 与 required next action 必须描述 production/implementation action，而不是 test-only action；ready-state prompt 必须在 provider dispatch 前列出 allowed capabilities、progress capabilities 与精确 required capability choices。

#### Scenario: Downstream consumes accepted artifacts only / 下游只消费已验收产物
- **WHEN** a step produces a patch, file edit, command result, test result, browser artifact, or generated file
- **THEN** downstream steps receive an accepted artifact reference only after the configured gate checks status, evidence type, scope, and redaction metadata
- **中文** 当某个 step 产生 patch、file edit、command result、test result、browser artifact 或 generated file 时，只有 configured gate 检查 status、evidence type、scope 与 redaction metadata 后，下游 step 才能收到 accepted artifact reference。

#### Scenario: Failed gate blocks pass credit / Gate 失败阻止 Pass 计分
- **WHEN** a stage output lacks required evidence or fails its checker
- **THEN** the workflow may continue for repair if policy allows it
- **AND** the task cannot be marked pass until the missing or failed evidence is corrected
- **中文** 当 stage output 缺少必需 evidence 或 checker 失败时，workflow 可以在 policy 允许时继续修复；但在缺失或失败 evidence 被纠正前，task 不得标记为 pass。

#### Scenario: Artifact paths preserve requested literals / Artifact 路径保留请求字面量
- **WHEN** a task explicitly requests generated artifact paths
- **THEN** prompt assembly exposes the requested path literals in the generic file mutation output contract before model dispatch
- **AND** artifact delivery gates compare requested path literals against produced workspace paths case-sensitively
- **AND** case-mismatched or otherwise different paths are recorded as missing requested artifacts rather than accepted delivery evidence
- **AND** runtime output verification performs the same case-sensitive literal check regardless of host filesystem case sensitivity
- **AND** automatic staged workflows do not close as completed until required artifact path checks pass or a bounded repair path is exhausted
- **AND** while an artifact output-contract repair gate is active, file mutation tool calls that target a case-mismatched requested artifact path are rejected before execution with feedback containing the exact requested path literal
- **中文** 当任务显式请求生成 artifact path 时，prompt assembly 必须在 model dispatch 前通过通用 file mutation output contract 暴露请求路径字面量；artifact delivery gate 必须以大小写敏感方式比较请求路径字面量与工作区实际产物路径；大小写不匹配或其他不同路径必须记录为缺失请求 artifact，而不能作为已验收交付证据；runtime output verification 必须不受宿主文件系统大小写敏感性影响，执行同样的大小写敏感字面量检查；automatic staged workflow 在必需 artifact path checks 通过或 bounded repair 耗尽前不得关闭为 completed；当 artifact output-contract repair gate 激活时，大小写不匹配的 file mutation tool call 必须在执行前被拒绝，并返回精确请求路径字面量作为反馈。

#### Scenario: Non-visible stale supporting tools are rejected before execution / 非可见旧支持工具在执行前拒绝
- **WHEN** a produce, materialize, or repair stage is ready and the model requests a supporting tool that is not in the current visible projection
- **THEN** workflow orchestration rejects the request before kernel execution
- **AND** the rejection is recorded as `workflow-required-action.missed` with a bounded correction message that names the exact provider-visible function names for the current stage
- **AND** repeated misses consume a bounded correction budget with attempt counts before fail-closed classification
- **中文** 当 produce、materialize 或 repair stage 已 ready，但模型请求的 supporting tool 不在当前可见投影中时，workflow orchestration 必须在 kernel execution 前拒绝该请求；该拒绝必须记录为 `workflow-required-action.missed`，并用 bounded correction message 给出当前 stage 的精确 provider-visible function names；重复 miss 必须消耗带 attempt counts 的 bounded correction budget，然后才能 fail closed。
