## MODIFIED Requirements

### Requirement: SWE-bench Prediction Adapter

CLI diagnostics SHALL expose `diagnostics swe-bench predict` and `diagnostics swe-bench evaluate` adapters that can produce official-compatible SWE-bench prediction JSONL, run the official harness, and report local batch scoring evidence for the selected instance subset, including governed ramp gates, cache review evidence, and stable failure attribution.

CLI diagnostics 必须暴露 `diagnostics swe-bench predict` 与 `diagnostics swe-bench evaluate` adapters，用于生成官方兼容的 SWE-bench prediction JSONL、运行官方 harness，并报告所选 instance 子集的本地 batch scoring evidence，包括治理放量门槛、缓存复盘证据与稳定失败归因。

#### Scenario: Below-threshold runs enter review instead of expansion / 低于门槛进入复盘而非扩批

- **WHEN** a SWE-bench governed batch summary has `resolved / attempted < 0.80`
- **OR** its provider token cache summary has `hitRate < 0.90`
- **THEN** diagnostics MUST mark the ramp status as blocked for expansion
- **AND** the next allowed actions MUST be limited to review-only evidence refresh, framework/cache/environment fixes, or a single canary for a previously failed task after a fix
- **AND** the backpressure diagnostic metadata MUST expose `rampStatus`, `blockedExpansionTaskNumbers`, `nextAllowedActions`, and canary candidate task numbers derived from completed unresolved or failed task states
- **AND** task 11, task 12, or any larger batch MUST NOT be launched by the governed runner while the latest evidence remains below either threshold
- **AND** a direct single-task `core.swe.bench.run` invocation MUST also be rejected without dataset resolution, child-agent launch, official harness execution, or checkout mutation when the latest relevant governed batch summary lists that task in `blockedExpansionTaskNumbers`
- **AND** the summary MUST show the concrete numerator/denominator and cache rate that caused the block
- **中文** 当 SWE-bench 治理 batch summary 的 `resolved / attempted < 0.80`，或 provider token cache summary 的 `hitRate < 0.90` 时，diagnostics 必须把 ramp status 标记为阻止扩批；下一步允许动作必须限制为 review-only evidence refresh、framework/cache/environment fix，或修复后对历史失败任务进行单题 canary；backpressure diagnostic metadata 必须暴露 `rampStatus`、`blockedExpansionTaskNumbers`、`nextAllowedActions`，以及从已完成但 unresolved/failed 任务状态推导出的 canary candidate task numbers；最新证据低于任一门槛时，治理 runner 不得启动第 11/12 题或任何更大批次；当最新相关治理 batch summary 将某个任务列入 `blockedExpansionTaskNumbers` 时，直接单题调用 `core.swe.bench.run` 也必须在解析 dataset、启动 child agent、执行 official harness 或修改 checkout 之前被拒绝；summary 必须展示导致阻塞的具体 numerator/denominator 与 cache rate。

#### Scenario: Previous failures are reviewed before expansion / 历史失败先复盘再扩批

- **WHEN** a governed SWE-bench batch contains unresolved, harness-error, environment-error, cache-failed, verification-gap, repair-feedback-gap, or pending tasks
- **THEN** every non-resolved task state MUST include `primaryReasonCode`, `reasonCodes`, `failureCategory`, `actionability`, and bounded evidence pointers
- **AND** batch evidence MUST aggregate those codes so the supervisor can see the failure mix without opening every trace
- **AND** batch-level review codes MUST NOT aggregate non-cache flow, verification, environment, harness, prediction, or model-patch review codes from child summaries whose official evaluation is already resolved
- **AND** cache, prompt-cache, and context-projection governance review codes MAY still aggregate from resolved child summaries because cache economics is an independent ramp gate
- **AND** Python test environment or command diagnostics MUST preserve bounded structured failure details such as missing module name, missing runner path, unsupported option, suggested action, suggested command, and repo-local alternate runner command when those details are present in child trace evidence or recoverable from standardized tool output
- **AND** expansion remains blocked while any previous non-resolved task lacks stable attribution
- **中文** 当治理 SWE-bench batch 包含 unresolved、harness-error、environment-error、cache-failed、verification-gap、repair-feedback-gap 或 pending task 时，每个未 resolved task state 必须包含 `primaryReasonCode`、`reasonCodes`、`failureCategory`、`actionability` 与有界 evidence pointers；batch evidence 必须聚合这些 code，使监督者不用逐个打开 trace 也能看到失败结构；batch-level review codes 不得从 official evaluation 已 resolved 的 child summary 聚合非 cache 的 flow、verification、environment、harness、prediction 或 model-patch review code；cache、prompt-cache 与 context-projection 治理 review code 仍可从已 resolved child summary 聚合，因为 cache economics 是独立放量门槛；Python 测试环境或命令诊断必须在 child trace evidence 中存在或可从标准化 tool output 恢复时，保留缺失模块名、缺失 runner 路径、不支持的参数、建议动作、建议命令与 repo-local alternate runner command 等有界结构化失败细节；只要任何历史未 resolved task 缺少稳定归因，就继续阻止扩批。

#### Scenario: Platform shell wrappers preserve test-command evidence / 平台 Shell 包裹保留测试命令证据

- **WHEN** a SWE-bench child trace records a model-authored standard test command through a platform wrapper such as WSL, PowerShell, cmd, or POSIX shell
- **THEN** diagnostics MUST classify the underlying ecosystem test command from the wrapped payload rather than treating the wrapper as a non-test command
- **AND** WSL option parsing MUST handle command-line options separately from the nested command payload so supported WSL launch styles do not erase local verification evidence
- **AND** the classifier MUST be based on wrapper and ecosystem command grammar, not an allowlist of benchmark repos, instances, or exact test command strings
- **中文** 当 SWE-bench child trace 通过 WSL、PowerShell、cmd 或 POSIX shell 等平台包裹记录模型写出的标准测试命令时，diagnostics 必须从包裹 payload 中识别底层生态测试命令，而不能把 wrapper 当成非测试命令；WSL option parsing 必须把启动参数与嵌套 command payload 分开处理，避免受支持的 WSL 启动方式抹掉本地验证证据；分类器必须基于 wrapper 与生态命令 grammar，而不是 benchmark repo、instance 或精确测试命令字符串 allowlist。

#### Scenario: Batch resume-only task states preserve evaluation status / Batch Resume-only 任务状态保留评测结果

- **WHEN** `core.swe.bench.run` refreshes a governed batch with `resumeOnly: true`
- **AND** an existing child summary is found for a requested task
- **THEN** that task's `taskStates` entry MUST use the child evaluation result as its status: `resolved`, `unresolved`, or `failed`
- **AND** the entry MAY set `resumedFromSummary: true` to show that solving work was skipped during refresh
- **AND** batch-level `resumedTaskNumbers` MAY list tasks restored from existing child summaries
- **AND** `skipped` MUST be used only for requested tasks that have no child summary and were not executed because of review-only or backpressure flow
- **AND** batch-level `skippedTaskNumbers` and `skippedTasks` MUST count only those true skipped tasks, not tasks restored from child summaries
- **AND** `resolvedTaskNumbers`, `unresolvedTaskNumbers`, `failedTaskNumbers`, and `taskStates[].status` MUST NOT contradict each other
- **中文** 当 `core.swe.bench.run` 以 `resumeOnly: true` 刷新治理 batch，且某个请求任务存在 child summary 时，该任务的 `taskStates` 条目必须使用 child 评测结果作为状态：`resolved`、`unresolved` 或 `failed`；该条目可以设置 `resumedFromSummary: true` 表示刷新期间跳过了解题执行；batch 级 `resumedTaskNumbers` 可以列出从既有 child summary 恢复的任务；`skipped` 只能用于没有 child summary 且因 review-only 或 backpressure 流程未执行的请求任务；batch 级 `skippedTaskNumbers` 与 `skippedTasks` 只能统计这些真正 skipped 的任务，不得统计从 child summary 恢复的任务；`resolvedTaskNumbers`、`unresolvedTaskNumbers`、`failedTaskNumbers` 与 `taskStates[].status` 不得互相矛盾。

#### Scenario: CLI profile is a workflow role over generic capabilities / CLI Profile 是通用能力上的工作流角色

- **WHEN** the CLI selects an evaluation profile such as SWE-bench Lite for a one-shot or governed run
- **THEN** the selected profile MUST be represented as structured policy metadata with a profile id, role, workflow graph id, generic capability ids, projection policy, context pipeline policy, loop limits, and governance metadata
- **AND** the profile MUST compose governed capabilities rather than directly embedding benchmark solution behavior, repository-name branches, instance-id branches, numbered-task branches, or expected patch knowledge
- **AND** explicit user projection policy MAY override the profile default while preserving the profile's workflow and governance metadata for trace and review
- **AND** diagnostics MUST treat the profile as a workflow role or composition profile, not as a prompt-string privilege switch
- **AND** the profile workflow MUST declare `workflowPriority: primary` and `orchestrationMode: staged-capability-workflow` so runtime, prompt assembly, diagnostics, and review tooling treat it as the main task route rather than advisory prose
- **AND** the profile workflow metadata MUST include ordered lightweight stages with objectives, generic capability ids, entry criteria, and exit criteria so the run can be supervised by evidence gates without a heavyweight workflow engine
- **AND** for user-level SWE-bench prompts, the outer evaluation profile MUST make `core.swe.bench.run` the ready dispatch capability rather than exposing repository source inspection, source editing, or focused-test capabilities as parent-loop ready-stage alternatives
- **AND** repository source inspection, source editing, focused verification, and patch review capabilities MUST belong to the managed child run profile created by `core.swe.bench.run`, and that child profile MUST NOT include `core.swe.bench.run` as a recursive workflow capability
- **AND** this parent/child split MUST be selected from prompt/run-role evidence such as the managed execution profile marker, not from benchmark repo names, task numbers, instance ids, expected patches, or known solutions
- **AND** runtime MUST enforce the primary governed workflow's declared capability boundary before kernel execution for evaluation/governed profiles, rejecting model tool calls outside the profile workflow capability ids or compiled staged-task allowed tools with typed feedback
- **AND** when a successful governed tool result matches a ready staged-task stage's allowed capability id and satisfies that stage kind's completion-grade evidence requirement, runtime MUST advance the staged-task run state, emit replayable `workflow.step` evidence for the stage progress, and include the updated run state in the next prompt assembly and model-request metadata
- **AND** read/search/list evidence MAY support a later `produce` or source-change stage while remaining available to the model, but it MUST NOT complete that stage or emit its output refs unless a mutation-grade capability such as file write, file edit, or patch apply succeeds
- **AND** runtime MUST NOT enforce strict stage-to-stage ordering until a generic exit-criteria evidence evaluator can prove the current stage has completed, so workflow control cannot deadlock valid runs by treating static initial run state as permanent
- **AND** prompt assembly MUST surface the selected profile workflow as stable model-visible orchestration guidance before phase-plan details so the model can compose generic capabilities instead of inferring the workflow from hidden metadata
- **AND** prompt assembly MUST surface those ordered workflow stages in the same stable section and preserve stage ids in section trace provenance for replay and cache review
- **AND** prompt assembly MUST surface a deterministic task-intent contract in the stable provider prefix, derived from the exact user prompt boundary, selected profile role, workflow graph, and capability visibility rather than another model call
- **AND** that task-intent contract MUST remain stable across session ids, turn ids, request ids, attempt ids, dynamic tool feedback, and staged-task run-state updates for the same user prompt and profile contract
- **AND** the task-intent contract MUST NOT include benchmark repository names, instance ids, task numbers, expected patch content, known solution details, or dynamic stage status as branching inputs
- **AND** prompt assembly MUST surface the current staged-task run state as model-visible dynamic workflow state outside the stable provider prefix so stage progress can guide the next action without busting provider prefix cache reuse
- **AND** dynamic workflow state for ready stages MUST expose a primary next-action cue derived from the ready stage kind and allowed capability ids
- **AND** after an understand or collect-evidence stage has succeeded, a ready `produce` or `repair` stage MUST tell the model that read/search/list-only exploration is supporting evidence, not completion-grade progress, and that the primary next action is mutation-grade edit, patch, write, or a bounded blocker
- **AND** that guidance MUST distinguish preferred workflow capability ids from capabilities that are actually model-visible under the current projection, projection-limited, or unregistered in the current runtime
- **AND** the profile workflow metadata MUST include a compiled replayable staged-task workflow snapshot with graph id, fingerprint, stage contracts, refs, executor kinds, allowed capability ids, and initial run state
- **AND** the compiled staged-task workflow MUST be contract data over the capability registry and MUST NOT bypass governed capability execution with benchmark-specific commands or subclasses
- **AND** this orchestration guidance MUST remain lightweight contract data and MUST NOT require a deep class hierarchy, benchmark-specific workflow subclass, or duplicated command taxonomy
- **中文** 当 CLI 为 one-shot 或受管运行选择 SWE-bench Lite 等 evaluation profile 时，所选 profile 必须表示为结构化 policy metadata，包含 profile id、role、workflow graph id、通用 capability id、projection policy、context pipeline policy、loop limits 与 governance metadata。
- **中文** 该 profile 必须编排受管 capabilities，而不是直接内嵌 benchmark 解题行为、repo name 分支、instance id 分支、编号 task 分支或 expected patch 知识。
- **中文** 用户显式 projection policy 可以覆盖 profile 默认值，但必须保留 profile 的 workflow 与 governance metadata 供 trace 和复盘使用。
- **中文** diagnostics 必须把 profile 视为 workflow role 或 composition profile，而不是 prompt 字符串触发的特权开关。
- **中文** profile workflow 必须声明 `workflowPriority: primary` 与 `orchestrationMode: staged-capability-workflow`，使 runtime、prompt assembly、diagnostics 与 review tooling 把它当作主任务路线，而不是建议性散文。
- **中文** profile workflow metadata 必须包含有序的轻量 stages，每个 stage 声明 objective、通用 capability ids、entry criteria 与 exit criteria，使运行可以由证据门禁监督，而不需要重型 workflow engine。
- **中文** 对用户级 SWE-bench prompt，外层 evaluation profile 必须把 `core.swe.bench.run` 作为 ready dispatch capability，而不是把仓库源码检查、源码编辑或 focused-test capabilities 暴露成父 loop 的 ready-stage 替代路线。
- **中文** 仓库源码检查、源码编辑、focused verification 与 patch review capabilities 必须属于 `core.swe.bench.run` 创建的 managed child run profile，且该 child profile 不得把 `core.swe.bench.run` 作为递归 workflow capability。
- **中文** 这个父/子拆分必须根据 managed execution profile marker 等 prompt/run-role evidence 选择，不得根据 benchmark repo name、task number、instance id、expected patch 或已知解法选择。
- **中文** runtime 必须在 kernel execution 之前，为 evaluation/governed profile 强制 primary workflow 声明的 capability boundary；当模型调用不在 profile workflow capability ids 或编译后 staged-task allowed tools 内的工具时，必须用 typed feedback 拒绝。
- **中文** 当成功的受管工具结果匹配 ready staged-task stage 允许的 capability id，且满足该 stage kind 的 completion-grade evidence 要求时，runtime 必须推进 staged-task run state，发出可 replay 的 `workflow.step` 阶段进展证据，并在下一轮 prompt assembly 与 model-request metadata 中包含更新后的 run state。
- **中文** read/search/list evidence 可以支撑后续 `produce` 或源码变更阶段并继续对模型可见，但除非 file write、file edit 或 patch apply 等 mutation-grade capability 成功，否则不得完成该阶段或发出该阶段的 output refs。
- **中文** 在通用 exit-criteria evidence evaluator 能证明当前阶段完成之前，runtime 不得强制严格 stage-to-stage ordering，避免把静态初始 run state 当成永久状态而卡死合法运行。
- **中文** prompt assembly 必须在 phase-plan 细节之前，把所选 profile workflow 作为稳定且模型可见的编排指导暴露出来，使模型能够组合通用 capabilities，而不是从隐藏 metadata 中猜测 workflow。
- **中文** prompt assembly 必须在同一个 stable section 中暴露这些有序 workflow stages，并在 section trace provenance 中保留 stage ids 供 replay 与 cache 复盘。
- **中文** prompt assembly 必须在稳定 provider prefix 中暴露确定性的 task-intent contract；该 contract 必须由精确用户 prompt 边界、已选 profile role、workflow graph 与 capability visibility 推导，而不是再调用一个模型。
- **中文** 对同一用户 prompt 与 profile contract，该 task-intent contract 必须在 session id、turn id、request id、attempt id、动态工具反馈与 staged-task run-state 更新之间保持稳定。
- **中文** 该 task-intent contract 不得把 benchmark repository name、instance id、task number、expected patch content、已知解法细节或动态 stage status 作为分支输入。
- **中文** prompt assembly 必须把当前 staged-task run state 作为模型可见的动态 workflow state 暴露在稳定 provider prefix 之外，使阶段进展能指导下一步动作，同时不破坏 provider prefix cache 复用。
- **中文** 对 ready stage，动态 workflow state 必须根据 ready stage kind 与 allowed capability id 暴露主下一步提示。
- **中文** 当 understand 或 collect-evidence stage 已 succeeded 且 `produce` 或 `repair` stage ready 时，必须告诉模型 read/search/list-only exploration 只是辅助证据，不是 completion-grade progress；主下一步是 mutation-grade edit、patch、write，或有界 blocker。
- **中文** 该指导必须区分 preferred workflow capability ids、当前 projection 下实际 model-visible 的能力、被 projection 限制的能力，以及当前 runtime 未注册的能力。
- **中文** profile workflow metadata 必须包含编译后的、可 replay 的 staged-task workflow snapshot，包含 graph id、fingerprint、stage contracts、refs、executor kinds、allowed capability ids 与初始 run state。
- **中文** 编译后的 staged-task workflow 必须是 capability registry 之上的 contract data，不得用 benchmark-specific 命令或 subclass 绕过受管 capability execution。
- **中文** 该编排指导必须保持为轻量 contract data，不得要求深层 class hierarchy、benchmark-specific workflow subclass 或重复的 command taxonomy。

#### Scenario: Single-task review-only refresh does not rerun solving / 单题 review-only 刷新不得重新解题

- **WHEN** `core.swe.bench.run` is invoked for one numbered task with `resumeOnly: true`
- **THEN** the governed runner MUST refresh the existing run summary and child trace attribution without resolving the dataset, launching the child agent, running the official harness, or mutating the benchmark checkout
- **AND** if no resumable summary exists, the runner MUST return structured missing-summary evidence instead of silently starting a new attempt
- **AND** refreshed cache diagnostics MUST apply the same 90% provider cache governance target used by batch readiness
- **中文** 当 `core.swe.bench.run` 针对单个编号任务以 `resumeOnly: true` 调用时，治理 runner 必须只刷新既有 run summary 与 child trace 归因，不得解析 dataset、启动 child agent、运行 official harness 或修改 benchmark checkout；若不存在可恢复 summary，runner 必须返回结构化缺失 summary 证据，而不是静默启动新 attempt；刷新后的 cache diagnostics 必须应用与 batch readiness 相同的 90% provider cache 治理目标。

#### Scenario: Missing summary recovers from partial artifacts / Summary 缺失时从部分产物恢复

- **WHEN** a governed single-task run root contains `trace.jsonl` or `prediction.jsonl`
- **AND** `summary.json` is missing during `resumeOnly: true`
- **THEN** the runner MUST recover a structured warning summary from the preserved trace and prediction artifacts
- **AND** recovered evidence MUST include available instance id, patch byte size, child trace counters, provider/context cache metrics, cache review codes, and stable failure attribution
- **AND** the recovered summary MUST persist back to `summary.json` so later review does not lose the same evidence again
- **AND** recovery MUST NOT launch a child agent, run the official harness, or mutate the benchmark checkout
- **中文** 当治理单题 run root 中存在 `trace.jsonl` 或 `prediction.jsonl`，但 `resumeOnly: true` 时 `summary.json` 缺失，runner 必须从保留的 trace 与 prediction 产物恢复结构化 warn summary；恢复证据必须包含可用的 instance id、patch 字节数、child trace 计数、provider/context cache 指标、cache review code 与稳定失败归因；恢复后的 summary 必须写回 `summary.json`，避免后续复盘再次丢失同一证据；恢复不得启动 child agent、运行 official harness 或修改 benchmark checkout。

#### Scenario: Empty patch harness skips remain diagnosable / 空 Patch Harness 跳过仍可诊断

- **WHEN** the official SWE-bench harness top-level report includes an instance in `empty_patch_ids`
- **OR** a review-only recovery reads a preserved prediction JSONL record whose `model_patch` is empty
- **THEN** the run summary MUST preserve a structured empty-patch diagnostic and map it to a stable `PREDICTION_EMPTY_PATCH` reason code
- **AND** the empty-patch evidence MUST NOT be collapsed into missing per-instance report diagnostics such as `HARNESS_INSTANCE_REPORT_MISSING`
- **AND** provider cache and child request-budget evidence from the same trace MUST still be reported and may outrank empty-patch attribution when more actionable
- **AND** recovery MUST NOT rerun solving work, rerun the official harness, or mutate the benchmark checkout
- **中文** 当 official SWE-bench harness 顶层报告把实例列入 `empty_patch_ids`，或 review-only recovery 读取到保留的 prediction JSONL 记录且 `model_patch` 为空时，run summary 必须保留结构化 empty-patch diagnostic，并映射到稳定的 `PREDICTION_EMPTY_PATCH` reason code；empty-patch 证据不得被压成 `HARNESS_INSTANCE_REPORT_MISSING` 等 per-instance report 缺失诊断；同一 trace 中的 provider cache 与 child request-budget 证据仍必须报告，并且在更可执行时可以优先于 empty-patch 归因；恢复不得重新解题、重新运行 official harness 或修改 benchmark checkout。

#### Scenario: Single-task progress ledger survives interruption / 单题进度账本可跨中断保留

- **WHEN** a governed single-task SWE-bench run executes
- **THEN** the runner MUST persist a run-scoped progress ledger before and after major phases such as environment preparation, dataset resolution, checkout preparation, prediction, evaluation, and summary persistence
- **AND** progress records MUST be durable enough for review-only resume to distinguish never-started, interrupted, prediction-complete, evaluation-complete, and summary-persisted states
- **AND** progress records MUST NOT contain benchmark secrets, hidden expected patches, or raw problem statement text beyond existing redacted evidence policy
- **中文** 当治理单题 SWE-bench run 执行时，runner 必须在 environment preparation、dataset resolution、checkout preparation、prediction、evaluation 与 summary persistence 等主要阶段前后持久化 run-scoped progress ledger；这些 progress record 必须足够持久，使 review-only resume 能区分 never-started、interrupted、prediction-complete、evaluation-complete 与 summary-persisted 状态；progress record 不得包含 benchmark secret、隐藏 expected patch，或超出现有脱敏策略的原始 problem statement 文本。

#### Scenario: Refreshed cache diagnostics replace stale cache-shape reasons / 刷新后的缓存诊断替换过期缓存形状原因

- **WHEN** resume-only refresh reads a preserved child trace and recomputes provider cache diagnostics
- **THEN** previous cache-shape diagnostics such as provider-prefix drift, breakpoint-shape miss, tool-schema cache gap, and whole-prompt-dynamic-with-stable-prefix MUST be removed unless the refreshed trace still supports them
- **AND** refreshed review codes, reason codes, blocker findings, and persisted summary evidence MUST be derived from the current recomputed diagnostics
- **AND** stale cache-shape reasons MUST NOT remain primary attribution after the trace no longer supports them
- **中文** 当 resume-only refresh 读取保留的 child trace 并重新计算 provider cache diagnostics 时，之前的 provider-prefix drift、breakpoint-shape miss、tool-schema cache gap 与 whole-prompt-dynamic-with-stable-prefix 等 cache-shape 诊断必须被移除，除非刷新后的 trace 仍能支持它们；刷新的 review code、reason code、blocker finding 与持久化 summary evidence 必须来自当前重新计算的 diagnostics；当 trace 不再支持旧原因时，过期 cache-shape reason 不得继续作为 primary attribution。

#### Scenario: Model feedback is the last classification / 模型反馈是最后分类

- **WHEN** a task remains official-unresolved after repair
- **THEN** diagnostics MUST NOT classify it as model-owned until harness errors, environment warnings, cache gate failures, prompt/reproduction gaps, local verification oracle gaps, missing official failure excerpts, and request-budget control-flow gaps have been excluded or separately coded
- **AND** resumed child traces that contain an environment blocker gate MUST expose a stable environment reason code before request-budget-derived attribution
- **AND** twelve or more model requests in a single governed SWE-bench child attempt MUST be treated as suspicious request-budget evidence unless a more specific gate explains the same trace
- **AND** missing successful-test-count telemetry MUST NOT suppress request-budget attribution when the only available bounded evidence shows the managed child reached the model-request budget without a ready-for-harness terminal reason
- **AND** model-owned classification MUST use a stable code such as `MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR`
- **AND** all other framework, environment, cache, verification, trace, and repair-feedback codes MUST expose non-model actionability
- **中文** 当一个 task 在 repair 后仍 official-unresolved 时，diagnostics 不得立即归为模型侧，必须先排除或单独编码 harness error、environment warning、cache gate failure、prompt/reproduction gap、local verification oracle gap、official failure excerpt 缺失与 request-budget control-flow gap；当恢复的 child trace 包含 environment blocker gate 时，必须先暴露稳定的环境 reason code，再考虑由 request budget 推导的归因；单个治理 SWE-bench child attempt 中 12 次或更多模型请求必须视为可疑的 request-budget 证据，除非同一 trace 有更具体 gate 解释；当唯一有界证据显示 managed child 到达模型请求预算且没有 ready-for-harness terminal reason 时，缺失 successful-test-count telemetry 不得压制 request-budget attribution；模型侧归因必须使用稳定 code，例如 `MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR`；其他 framework、environment、cache、verification、trace 与 repair-feedback code 必须暴露非模型 actionability。

#### Scenario: Stale post-edit gates do not outrank later verification / 过期 post-edit gate 不得压过后续验证证据

- **WHEN** a governed child trace contains an earlier `SWE_BENCH_POST_EDIT_VERIFICATION_GATE`
- **AND** later trace evidence shows one or more model-authored standard test commands before a normal `agent.loop.completed` event
- **THEN** diagnostics MUST NOT keep `FLOW_POST_EDIT_VERIFICATION_MISSING` in current `reasonCodes` or blocker findings
- **AND** the raw gate event MAY remain in trace evidence as historical flow-control evidence
- **AND** if provider cache is below the 90% governance target, `CACHE_PROVIDER_BELOW_TARGET` MUST remain the primary actionable reason unless a higher-priority terminal flow, environment, or harness blocker is present
- **AND** child trace summarization MUST NOT treat non-terminal post-edit, source-inspection, or phase-planner budget events as the final terminal event when a later `agent.loop.completed` event exists
- **中文** 当治理 child trace 先出现 `SWE_BENCH_POST_EDIT_VERIFICATION_GATE`，但后续已经有一个或多个模型发起的标准测试命令并最终正常 `agent.loop.completed` 时，diagnostics 不得继续在当前 `reasonCodes` 或 blocker findings 中保留 `FLOW_POST_EDIT_VERIFICATION_MISSING`；原始 gate event 可以继续作为历史流程控制证据保留在 trace 中；如果 provider cache 低于 90% 治理目标，且没有更高优先级的终局 flow、environment 或 harness blocker，则 `CACHE_PROVIDER_BELOW_TARGET` 必须成为主要可执行原因；child trace summary 不得在后续存在 `agent.loop.completed` 时，把非终局的 post-edit、source-inspection 或 phase-planner budget event 当作最终 terminal event。

#### Scenario: Recovered setup blockers do not outrank later successful tests / 已恢复的 Setup 阻塞不得压过后续成功测试

- **WHEN** a governed child trace contains an earlier Python test setup or command failure such as missing dependency, incompatible dependency, missing runner entrypoint, or unsupported runner argument
- **AND** later trace evidence shows a model-authored standard test command completed successfully
- **THEN** refreshed diagnostics MUST NOT keep the recovered setup failure or `SWE_BENCH_ENVIRONMENT_BLOCKER_GATE` in current `reasonCodes` or blocker findings
- **AND** the raw failed setup output MAY remain in trace evidence as historical recovery context
- **AND** resume-only summary refresh MUST remove stale setup diagnostics from the persisted summary before merging diagnostics recomputed from the preserved child trace
- **AND** if the official harness remains unresolved after the successful local test, diagnostics MUST prefer cache, verification-oracle, repair-feedback, or official-unresolved attribution over stale environment setup attribution
- **AND** if another setup failure occurs after the latest successful standard test, that later failure MAY still be reported as current evidence
- **中文** 当治理 child trace 先出现 Python 测试 setup 或命令失败，例如缺失依赖、依赖不兼容、测试入口缺失或 runner 参数不支持，但后续 trace 证据显示模型发起的标准测试命令已经成功完成时，刷新后的 diagnostics 不得继续在当前 `reasonCodes` 或 blocker findings 中保留已恢复的 setup failure 或 `SWE_BENCH_ENVIRONMENT_BLOCKER_GATE`；原始失败 setup 输出可以作为历史恢复上下文留在 trace 证据中；resume-only summary refresh 必须先从持久 summary 中移除过期 setup diagnostics，再合并根据保留 child trace 重新计算出的 diagnostics；如果 successful local test 后 official harness 仍 unresolved，diagnostics 必须优先使用 cache、verification-oracle、repair-feedback 或 official-unresolved 归因，而不是过期环境 setup 归因；如果最新成功标准测试之后又出现新的 setup failure，则该后续失败仍可作为当前证据报告。

#### Scenario: Source mutation progress requires a successful material change / Source Mutation 进展必须来自成功实际变更

- **WHEN** a governed SWE-bench child trace contains `core.file.edit`, `core.file.write`, or `core.patch.apply`
- **THEN** diagnostics MUST count source mutation progress only after a successful completed tool result that represents a material workspace change
- **AND** failed, rejected, policy-denied, or no-op exact edits MUST NOT satisfy post-edit verification, environment blocker, ready-for-harness, or model-owned attribution preconditions
- **AND** no-op exact edits MUST return a stable diagnostic instead of producing an eligible checkpoint or empty patch
- **中文** 当治理 SWE-bench child trace 包含 `core.file.edit`、`core.file.write` 或 `core.patch.apply` 时，diagnostics 只能在成功完成且代表 workspace 实际变更的工具结果之后统计 source mutation progress；失败、拒绝、policy-denied 或 no-op exact edit 不得满足 post-edit verification、environment blocker、ready-for-harness 或模型侧归因前置条件；no-op exact edit 必须返回稳定诊断，而不是产生 eligible checkpoint 或空 patch。

#### Scenario: Source inspection gates cover all read-location tools / Source Inspection 门控覆盖所有读定位工具

- **WHEN** a governed SWE-bench child run spends read-location calls before source mutation or test progress
- **THEN** runtime and diagnostics MUST count `core.file.read`, `core.file.list`, `core.search.text`, and `core.workspace.glob` as source-inspection tools
- **AND** the runtime MUST insert `SWE_BENCH_SOURCE_INSPECTION_GATE` no later than the eighth source-inspection tool call when no source mutation or test progress exists
- **AND** under the managed twelve-model-request budget, that gate timing MUST leave recovery budget for one supplemental focused read, one enforced read rejection, one source edit, one post-edit verification gate, and one standard test or ready-for-harness completion
- **AND** before that threshold is spent, repeated source-inspection requests for the same recently completed bounded `core.file.read` window, a bounded same-path `core.file.read` window whose content is mostly covered by a very recent completed bounded window, or the same recently completed `core.search.text` query SHOULD be rejected as duplicate evidence until the child makes a source edit, runs a standard test command, or reports a bounded blocker
- **AND** after a duplicate-evidence rejection is emitted before source mutation or test progress, subsequent source-inspection tools and non-test setup shell commands SHOULD be rejected with the same required next action until source edit, standard test, or bounded blocker progress exists
- **AND** after `SWE_BENCH_SOURCE_INSPECTION_GATE` is inserted, subsequent broad read-location calls through any of those tools MUST be rejected until a source edit, standard test command, or bounded blocker report exists
- **AND** a same-file `core.file.read` after that gate MUST be considered focused only when it carries a bounded read window such as non-negative `offset` and small positive `limit`; same-file whole-file reads remain broad read-location calls and MUST be rejected
- **AND** runtime MUST allow at most one supplemental focused read after that gate; additional focused reads, even with different windows, MUST be rejected because window-by-window reading consumes the edit/test recovery budget
- **AND** a focused same-file read after that gate MUST be rejected when the same path and bounded read window already completed earlier in the run, because repeated windows provide no new progress evidence
- **AND** runtime MAY give the model one corrective rejection feedback after the source-inspection gate, but repeated rejected read-location or non-test setup actions after that feedback MUST emit `SWE_BENCH_SOURCE_INSPECTION_DEFIANCE_GATE` and terminate with a stable `swe-bench-source-inspection-defiance` classification before the generic request-budget gate is exhausted
- **AND** when the latest provider-facing tool tail contains a source-inspection gate or duplicate-evidence rejection that instructs the child to reuse existing source evidence, runtime MUST keep one recent successful source-inspection tool pair visible in the bounded provider-facing history so the model can act on the evidence without rereading it
- **AND** refreshed batch and single-task summaries MUST preserve that terminal classification as `GATE_SOURCE_INSPECTION_DEFIANCE` rather than collapsing it into generic source-inspection pressure or request-budget attribution
- **AND** offline child-trace review MUST classify the same tool mix as source-inspection pressure instead of leaving the later request-budget failure as the only actionable evidence
- **AND** when source-inspection pressure and generic request-budget evidence occur in the same trace, the source-inspection pressure reason MUST be the primary attribution because it identifies the runaway phase to fix
- **中文** 当治理 SWE-bench child run 在 source mutation 或 test 进展前消耗读定位调用时，runtime 与 diagnostics 必须把 `core.file.read`、`core.file.list`、`core.search.text` 和 `core.workspace.glob` 都计为 source-inspection 工具；当还没有源码变更或测试进展时，runtime 必须最晚在第 8 次 source-inspection 工具调用后插入 `SWE_BENCH_SOURCE_INSPECTION_GATE`；在受管 12 次模型请求预算内，这个 gate 时机必须为一次补充 focused read、一次强制读取拒绝、一次源码编辑、一次 post-edit verification gate，以及一次标准测试或 ready-for-harness 完成留下恢复预算；在耗尽该阈值之前，如果 child 重复请求最近已经成功完成的相同有界 `core.file.read` 窗口、内容主要已被最近成功完成的同路径有界窗口覆盖的 `core.file.read` 窗口，或相同 `core.search.text` 查询，runtime 应将其作为重复证据拒绝，直到 child 产生源码编辑、标准测试命令或有界 blocker 报告；在 source mutation 或 test 进展前一旦发出 duplicate-evidence 拒绝，后续 source-inspection 工具与非测试 setup shell 命令也应继续按同一个 required next action 被拒绝，直到出现源码编辑、标准测试或有界 blocker 进展；插入 `SWE_BENCH_SOURCE_INSPECTION_GATE` 后，这些工具的后续宽泛读定位调用必须被拒绝，直到存在源码编辑、标准测试命令或有界 blocker 报告；gate 之后的同文件 `core.file.read` 只有携带非负 `offset` 与较小正数 `limit` 等有界读取窗口时才算 focused，同文件整文件读取仍属于宽泛读定位调用并必须被拒绝；runtime 最多只能允许一次 gate 后补充 focused read，后续即使是不同窗口也必须被拒绝，因为继续窗口式阅读会消耗 edit/test 恢复预算；如果同一路径与同一有界读取窗口在本轮早些时候已经成功完成，gate 之后重复读取该窗口必须被拒绝，因为重复窗口不提供新的进展证据；source-inspection gate 后 runtime 可以给模型一次纠偏拒绝反馈，但如果该反馈后仍重复发起被拒绝的读定位或非测试 setup 行为，必须发出 `SWE_BENCH_SOURCE_INSPECTION_DEFIANCE_GATE` 并以稳定的 `swe-bench-source-inspection-defiance` 分类终止，不能继续消耗到泛化 request-budget gate；当最新 provider-facing tool tail 包含 source-inspection gate 或 duplicate-evidence rejection，并要求 child 复用已有源码证据时，runtime 必须在有界 provider-facing history 中保留一组最近成功的 source-inspection 工具 pair，使模型可以基于该证据行动而不必重新读取；刷新后的 batch 与单题 summary 必须把这个终局分类保留为 `GATE_SOURCE_INSPECTION_DEFIANCE`，不得折叠成泛化 source-inspection pressure 或 request-budget 归因；离线 child-trace 复盘也必须把同样的工具组合归类为 source-inspection pressure，而不是只留下后续 request-budget failure 作为唯一可执行证据；当 source-inspection pressure 与泛化 request-budget 证据同时出现时，source-inspection pressure 必须作为 primary attribution，因为它定位了需要修复的失控阶段。

#### Scenario: Standard test command execution normalizes duplicate interpreter flags / 标准测试命令执行必须规范化重复解释器开关

- **WHEN** `core.test.run` or `core.shell.run` receives a model-authored shell command string that already includes an interpreter execution flag such as `python -c`
- **AND** the argument vector repeats the same leading execution flag before the script text
- **THEN** the process invocation MUST normalize the duplicate flag or return a stable tool-input diagnostic before execution
- **AND** it MUST NOT run a malformed command such as `python -c -c <script>` and treat the resulting interpreter error as model capability, verification, or repository failure evidence
- **AND** this normalization MUST be generic across supported interpreter-style commands and MUST NOT depend on SWE-bench repository names, instance ids, target files, or hidden solution details
- **中文** 当 `core.test.run` 或 `core.shell.run` 收到模型生成的 shell command string，且该 command 已包含类似 `python -c` 的解释器执行开关，同时 args 又在脚本文本前重复同一个执行开关时，process invocation 必须在执行前规范化重复开关，或返回稳定 tool-input diagnostic；不得执行 `python -c -c <script>` 这类畸形命令，并把由此产生的解释器错误当作模型能力、verification 或 repository failure 证据；该规范化必须对支持的解释器式命令通用，且不得依赖 SWE-bench repository name、instance id、目标文件或隐藏解法细节。

#### Scenario: Successful local verification takes precedence over post-verification probing / 成功本地验证优先于后验证探测

- **WHEN** a managed SWE-bench child trace has a successful material source mutation
- **AND** a model-authored `core.test.run` or standard test command completes with successful process evidence
- **AND** the trace has patch review evidence such as a diff inspection or a subsequent non-test post-verification shell probe
- **THEN** runtime MUST emit `SWE_BENCH_READY_FOR_HARNESS_GATE` and complete the child run so the governed outer harness can score the patch
- **AND** post-verification dependency probes MUST NOT become the primary `SWE_BENCH_ENVIRONMENT_BLOCKER_GATE` reason after successful test evidence exists
- **AND** offline child-trace diagnostics MUST classify legacy traces that exceed the managed request budget after source mutation and successful test evidence as `FLOW_READY_FOR_HARNESS_GATE_MISSING` instead of generic `FLOW_REQUEST_BUDGET_EXCEEDED`
- **AND** failed, rejected, timed-out, or non-zero-exit test commands MUST NOT satisfy this ready-for-harness precondition
- **中文** 当 managed SWE-bench child trace 已经有成功的实际源码变更，并且模型编写的 `core.test.run` 或标准测试命令以成功进程证据完成，且 trace 已经有 diff 检查或随后出现非测试的后验证 shell probe 等 patch review 证据时，runtime 必须发出 `SWE_BENCH_READY_FOR_HARNESS_GATE` 并完成 child run，让受管 outer harness 给 patch 打分；成功测试证据存在后，后验证依赖探测不得成为主要的 `SWE_BENCH_ENVIRONMENT_BLOCKER_GATE` 原因；离线 child-trace diagnostics 必须把源码变更与成功测试证据之后仍超过 managed request budget 的 legacy trace 归因为 `FLOW_READY_FOR_HARNESS_GATE_MISSING`，而不是泛化 `FLOW_REQUEST_BUDGET_EXCEEDED`；失败、拒绝、超时或非零退出的测试命令不得满足该 ready-for-harness 前置条件。

#### Scenario: Successful test evidence is bound to test commands / 成功测试证据必须绑定测试命令

- **WHEN** child trace review observes successful `core.shell.run` tool results
- **THEN** those results MUST count as successful test evidence only when they correspond to a prior model-authored standard test command intent
- **AND** runtime gates, core tool feedback, and child-trace review MUST use a shared standard-test command classifier rather than divergent local regex copies
- **AND** that classifier MUST normalize shell payload wrappers and path syntax across POSIX/WSL shells, PowerShell, cmd, and Windows-style paths before classifying ecosystem test commands
- **AND** successful non-test shell probes MUST NOT satisfy ready-for-harness, post-edit verification, or local-test-success attribution
- **AND** attempted tests with known result evidence and zero successful test commands MUST emit a stable local-test-unsuccessful diagnostic before environment or model-owned attribution
- **中文** 当 child trace 复盘观察到成功的 `core.shell.run` 工具结果时，只有它们对应此前模型发起的标准测试命令 intent 时，才可以计入 successful test evidence；runtime gate、core tool feedback 与 child-trace review 必须使用共享标准测试命令分类器，而不是各自维护分叉 regex；该分类器必须在分类生态测试命令前，跨 POSIX/WSL shell、PowerShell、cmd 与 Windows 风格路径规范化 shell payload wrapper 与路径语法；成功的非测试 shell probe 不得满足 ready-for-harness、post-edit verification 或 local-test-success 归因；已尝试测试且结果证据已知、但成功测试数为 0 时，必须先输出稳定的 local-test-unsuccessful 诊断，再考虑环境或模型侧归因。

#### Scenario: Python test setup failures are classified before model blame / Python 测试环境失败先分类再归因模型

- **WHEN** child trace review observes a model-authored Python test command result with non-zero process evidence
- **AND** the bounded output shows a missing module, interpreter `No module named ...` response, incompatible dependency API, missing runner file, unsupported runner argument, or checkout-local test module/settings import failure caused by the selected runner/cwd/settings
- **THEN** diagnostics MUST emit a stable test setup diagnostic such as `SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING`, `SWE_BENCH_TEST_ENV_DEPENDENCY_INCOMPATIBLE`, `SWE_BENCH_TEST_ENTRYPOINT_MISSING`, `SWE_BENCH_TEST_ARGUMENT_UNSUPPORTED`, or `SWE_BENCH_TEST_COMMAND_ENV_MISSCOPED`
- **AND** missing or incompatible checkout-local test dependencies MUST map to environment failure reason codes such as `ENV_TEST_DEPENDENCY_MISSING` or `ENV_TEST_DEPENDENCY_INCOMPATIBLE` with `environment-fix` actionability
- **AND** when the missing module is an external Python test launcher/framework such as `pytest`, `nose`, or `nose2` and structured failure detail includes a repo-local alternate runner command and path, diagnostics MUST preserve the dependency evidence while selecting `VERIFICATION_REPO_LOCAL_RUNNER_AVAILABLE` with `verification-fix` actionability as the primary reason unless stronger environment evidence outranks it
- **AND** when that repo-local alternate runner is available, model-visible feedback and structured `suggestedCommand` metadata MUST expose the alternate runner command as the single primary next action and MUST NOT keep dependency installation such as `python -m pip install pytest` or `python -m pip install nose` as the next suggested command
- **AND** when that repo-local alternate runner evidence is observed before a successful local test, runtime workflow control MUST insert a bounded repo-local runner routing gate before terminally classifying continued setup probing as `SWE_BENCH_ENVIRONMENT_BLOCKER_GATE`
- **AND** while the repo-local runner routing gate is pending, repeated dependency setup commands or non-runner test retries through shell or first-class test tools SHOULD be rejected with model-visible feedback that names the alternate runner command
- **AND** resume-only refresh MAY enrich legacy missing test-launcher trace details from the run-scoped checkout when a generic repo-local runner file such as `tests/runtests.py` or `runtests.py` is present, without using repository name, task number, instance id, or expected patch content
- **AND** missing runner entrypoints or unsupported runner arguments MUST map to verification-command reason codes with `verification-fix` actionability unless separate environment evidence outranks them
- **AND** checkout-local test module/settings import failures caused by runner/cwd/settings selection MUST map to `VERIFICATION_TEST_COMMAND_ENV_MISSCOPED` with `verification-fix` actionability unless separate environment evidence outranks them
- **AND** these diagnostics MUST outrank `MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR` and generic local-test-unsuccessful attribution
- **AND** the model-visible feedback SHOULD tell the child not to repeat the same test command until the dependency, entrypoint, or argument issue is repaired
- **中文** 当 child trace 复盘观察到模型发起的 Python 测试命令以非零进程证据结束，并且有界输出显示缺失 module、解释器 `No module named ...` 响应、不兼容 dependency API、缺失 runner file、不支持的 runner argument，或由 runner/cwd/settings 选择导致的 checkout-local 测试 module/settings import failure 时，diagnostics 必须输出稳定测试 setup diagnostic，例如 `SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING`、`SWE_BENCH_TEST_ENV_DEPENDENCY_INCOMPATIBLE`、`SWE_BENCH_TEST_ENTRYPOINT_MISSING`、`SWE_BENCH_TEST_ARGUMENT_UNSUPPORTED` 或 `SWE_BENCH_TEST_COMMAND_ENV_MISSCOPED`；缺失或不兼容 checkout-local 测试依赖必须映射为 `ENV_TEST_DEPENDENCY_MISSING` 或 `ENV_TEST_DEPENDENCY_INCOMPATIBLE` 等 environment failure reason code，并带 `environment-fix` actionability；当缺失 module 是 `pytest`、`nose` 或 `nose2` 等外部 Python test launcher/framework，且结构化失败详情包含 repo-local alternate runner command 与 path 时，diagnostics 必须保留依赖证据，但除非更强环境证据优先，否则 primary reason 应选择 `VERIFICATION_REPO_LOCAL_RUNNER_AVAILABLE` 并带 `verification-fix` actionability；当该 repo-local alternate runner 可用时，模型可见反馈与结构化 `suggestedCommand` metadata 必须把 alternate runner command 暴露为单一主下一步，不得继续把 `python -m pip install pytest` 或 `python -m pip install nose` 等依赖安装命令保留为下一步建议；当 successful local test 之前观察到该 repo-local alternate runner evidence 时，runtime workflow control 必须在把继续 setup probing 终局分类为 `SWE_BENCH_ENVIRONMENT_BLOCKER_GATE` 之前插入有界 repo-local runner routing gate；该 gate 待处理时，通过 shell 或一等测试工具发起的重复依赖 setup 命令或非 runner 测试重试应被拒绝，并在模型可见反馈中点名 alternate runner command；resume-only refresh 可以在 run-scoped checkout 中存在 `tests/runtests.py` 或 `runtests.py` 等通用 repo-local runner 文件时，补全旧 trace 缺失的 test-launcher alternate runner evidence，但不得使用 repository name、task number、instance id 或 expected patch content；缺失 runner entrypoint 或不支持 runner argument 必须映射为 verification-command reason code，并带 `verification-fix` actionability；由 runner/cwd/settings 选择导致的 checkout-local 测试 module/settings import failure 必须映射为 `VERIFICATION_TEST_COMMAND_ENV_MISSCOPED` 并带 `verification-fix` actionability，除非另有更高优先级环境证据；这些诊断必须优先于 `MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR` 与泛化 local-test-unsuccessful 归因；模型可见反馈应提示 child 在修复依赖、entrypoint、参数或测试命令作用域问题之前不要重复同一测试命令。

#### Scenario: User-level SWE-bench task requests route to the governed run capability / 用户级 SWE-bench 题号请求路由到受管运行能力

- **WHEN** a user-level prompt asks the CLI to complete a numbered SWE-bench Lite task
- **AND** the run is live without an explicit user tool-projection override
- **THEN** the CLI host MUST select a tool projection that makes the governed `core.swe.bench.run` terminal capability visible
- **AND** the selected projection MUST be visible in runtime model-request evidence so reviewers can distinguish missing capability projection from model routing failure
- **AND** when the visible tool set includes `core.swe.bench.run`
- **AND** the model spends repeated non-terminal read, search, memory, or project-inspection tool calls without invoking `core.swe.bench.run`
- **THEN** the runtime MUST emit a stable `SWE_BENCH_RUN_CAPABILITY_ROUTING_GATE`
- **AND** subsequent non-run tool calls MUST be rejected until the model invokes `core.swe.bench.run` or reports a bounded blocker
- **AND** this routing gate MUST NOT depend on benchmark repo names, instance ids, target files, expected patches, or hidden solution details
- **中文** 当用户级 prompt 要求 CLI 完成某个编号 SWE-bench Lite 题目，且该 run 是 live 并且用户没有显式覆盖 tool projection 时，CLI host 必须选择能让受管 `core.swe.bench.run` 终端 capability 可见的 tool projection；所选 projection 必须出现在 runtime model-request evidence 中，使复盘者能区分 capability projection 缺失与模型路由失败；当可见工具集包含 `core.swe.bench.run`，但模型反复消耗非终端 read、search、memory 或 project-inspection 工具调用而不调用 `core.swe.bench.run` 时，runtime 必须发出稳定的 `SWE_BENCH_RUN_CAPABILITY_ROUTING_GATE`；后续非 run 工具调用必须被拒绝，直到模型调用 `core.swe.bench.run` 或报告有界 blocker；该 routing gate 不得依赖 benchmark repo name、instance id、目标文件、期望 patch 或隐藏解法细节。

#### Scenario: Live completion intent overrides accidental model dry-run arguments / Live 完成意图覆盖模型误传的 dry-run 参数

- **WHEN** a user-level prompt asks the CLI to complete, run, solve, test, or canary a numbered SWE-bench Lite task in live mode
- **AND** the user did not explicitly request dry-run, preview, review-only, resume-only, or non-execution behavior
- **AND** the model invokes `core.swe.bench.run` with `dryRun: true`
- **THEN** tool intent preflight MUST repair the invocation to `dryRun: false` and `execute: true` before the capability decides whether to launch a child run
- **AND** the repair MUST be recorded with a stable intent repair kind such as `swe-bench-run-execution-normalized`
- **AND** explicit user requests for dry-run, preview, review-only, resume-only, or non-execution behavior MUST preserve `dryRun: true`
- **AND** this normalization MUST be selected from user intent semantics and run mode, not benchmark repo names, instance ids, task numbers, expected patches, hidden solution details, or historical outcome allowlists
- **中文** 当用户级 prompt 要求 CLI 在 live mode 完成、运行、解题、测试或 canary 某个编号 SWE-bench Lite 任务，且用户没有明确要求 dry-run、预览、review-only、resume-only 或不执行行为，而模型调用 `core.swe.bench.run` 时传入 `dryRun: true`，tool intent preflight 必须在 capability 决定是否启动 child run 之前，把调用修正为 `dryRun: false` 与 `execute: true`；该修正必须用稳定 intent repair kind 记录，例如 `swe-bench-run-execution-normalized`；如果用户明确要求 dry-run、预览、review-only、resume-only 或不执行行为，则必须保留 `dryRun: true`；该规范化必须来自用户意图语义与 run mode，不得基于 benchmark repo name、instance id、task number、expected patch、隐藏解法细节或历史结果 allowlist。

#### Scenario: Official harness failure excerpts feed repair / Official Harness 失败片段进入修复

- **WHEN** the official harness reports failing tests, assertions, exceptions, or traceback/source context for an unresolved instance
- **THEN** the evaluation summary MUST expose bounded sanitized failure excerpts with failing test ids and the most relevant assertion or exception lines
- **AND** repair context MUST include those excerpts in a clearly labeled official harness feedback section
- **AND** diagnostics MUST use `REPAIR_FEEDBACK_LOW_FIDELITY` when repair is requested without available high-fidelity official failure excerpts
- **中文** 当 official harness 为 unresolved instance 报告 failing tests、assertion、exception 或 traceback/source context 时，evaluation summary 必须暴露有界脱敏 failure excerpts，包含 failing test id 与最相关 assertion/exception line；repair context 必须在清晰标注的 official harness feedback section 中包含这些 excerpt；当已有高保真 official failure excerpt 但 repair 请求没有携带时，diagnostics 必须使用 `REPAIR_FEEDBACK_LOW_FIDELITY`。

#### Scenario: Cache metrics remain separated and actionable / 缓存指标保持分离且可执行

- **WHEN** a governed SWE-bench run reports cache evidence
- **THEN** provider token cache metrics and context projection cache metrics MUST be reported separately
- **AND** context projection no-store events MUST be counted separately and MUST NOT lower the cacheable context projection hit rate
- **AND** provider-prefix cache evidence MUST be derived from final prompt assembly/model request shape, not only from context projection selected blocks
- **AND** Anthropic-compatible provider usage MUST count cache creation/write tokens in cache miss/write evidence instead of dropping them from the provider cache denominator
- **AND** when context projection is no-store or current-turn-only but final prompt assembly contains a stable framework prefix, diagnostics MUST preserve the context projection cache summary separately and expose provider-prefix fingerprint/count evidence for the stable prefix
- **AND** low provider cache MUST be classified into cold start, bounded history tail, or prompt prefix drift when evidence permits
- **AND** Anthropic-compatible provider requests with context pipeline fingerprints MUST surface explicit prefix cache hint status as `sent`, `missing`, or `unsupported`
- **AND** a provider adapter that can send provider-native prefix hints MUST NOT report `unsupported` because of missing default capability metadata
- **AND** explicit prefix hint status `sent` MUST NOT be treated as cache-health evidence unless the request shape places provider-native cache breakpoints on the stable shared prefix instead of merging volatile system tails into the cached block
- **AND** when explicit prefix hint status is `sent` but the stable provider prefix is too small for meaningful reuse, diagnostics MUST emit a stable provider-prefix-too-small reason with prefix message-count and token-estimate evidence
- **AND** when the provider-prefix fingerprint is stable but the stable prefix covers too little of the growing provider request, diagnostics MUST emit a stable provider-prefix-coverage-low reason with prefix coverage-ratio evidence
- **AND** when positive provider cache-hit token evidence is larger than the prompt-side provider-prefix token estimate but the total provider cache hit rate remains below target, diagnostics MUST emit a provider-cache-dynamic-tail-miss reason with effective stable hit-token and dynamic miss-token evidence instead of treating the stable prefix as missing or unstable
- **AND** when positive provider cache-hit token evidence is larger than the prompt-side provider-prefix token estimate but low-hit requests are intermittent zero-hit requests without breakpoint-shape telemetry, diagnostics MUST NOT also emit provider-prefix-coverage-low, provider-tool-schema-cache-gap, or whole-prompt-dynamic-with-stable-prefix as the actionable cache-shape reason
- **AND** when prompt replay fingerprints remain stable but provider-prefix fingerprints change, diagnostics MUST emit a stable provider-prefix-drift reason with provider-prefix fingerprint/count/token evidence
- **AND** when whole-prompt fingerprints change while stable provider-prefix evidence remains stable, diagnostics MUST NOT emit whole-prompt churn as an actionable reason if the same low-cache evidence is already explained by history-tail, dynamic-tail, or post-gate unbounded-history diagnostics
- **AND** changes to model-visible staged workflow state that is intentionally outside the stable provider prefix MUST NOT be counted as prompt cache prefix drift when provider-prefix fingerprint/count/token evidence remains stable
- **AND** when repeated zero-hit provider requests occur for the same context pipeline despite sent prefix hints, diagnostics MUST emit a stable provider-cache-breakpoint-shape-miss reason instead of attributing the failure to model capability
- **AND** Anthropic-compatible adapters MUST preserve cacheable system prefix boundaries in provider-facing prompt evidence, and when a stable user task prompt is cacheable they MUST use that stable task prompt as the single provider-native cache breakpoint for the request
- **AND** when a stable user task prompt carries that single provider-native cache breakpoint, the same request MUST NOT also add provider-native cache breakpoints to the system prefix, visible tool schemas, or dynamic history tail
- **AND** managed SWE-bench provider-facing history MUST keep the stable task prompt plus only the latest dynamic tool-feedback pair and latest framework gate needed for the next action, while preserving the full assistant/tool history in lossless trace evidence
- **AND** CLI one-shot SWE-bench prompts such as `Resolve SWE-bench instance ...` MUST apply the same bounded provider-facing history policy used for managed SWE-bench child runs without enabling managed child-run verification gates unless the managed execution profile is present
- **AND** volatile system-state messages that are intentionally outside the stable provider prefix MUST NOT prevent a later stable user task prompt from receiving the single message-level provider-native cache breakpoint
- **AND** when that stable user task prompt already carries the Anthropic-compatible message-level cache breakpoint, the adapter MUST NOT add a second message-level breakpoint to the dynamic history tail in the same request
- **AND** provider usage evidence MUST expose redacted cache breakpoint-shape counts and message breakpoint positions such as first-message, middle-message, or last-message, and diagnostics MUST emit a stable `SWE_BENCH_PROVIDER_CACHE_MULTI_MESSAGE_BREAKPOINT` / `CACHE_PROVIDER_MULTI_MESSAGE_BREAKPOINT` reason when low provider cache hits coincide with more than one message-level cache breakpoint
- **AND** runtime usage evidence such as `usage.updated` and `model.usage.audit` MUST preserve provider-supplied cache breakpoint-shape counts so diagnostics can distinguish missing historical telemetry from runtime metadata loss
- **AND** when low provider cache hits occur but provider usage evidence lacks breakpoint-shape counts, diagnostics MUST emit a stable `SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_TELEMETRY_MISSING` / `CACHE_PROVIDER_BREAKPOINT_SHAPE_TELEMETRY_MISSING` reason instead of inferring cache shape from incomplete historical traces
- **AND** when a low-cache trace has stable prompt replay evidence but no context-pipeline telemetry in prompt assembly, model request, or provider usage, diagnostics MUST emit `SWE_BENCH_PROVIDER_CACHE_PIPELINE_TELEMETRY_ABSENT` / `CACHE_PROVIDER_PIPELINE_TELEMETRY_ABSENT` rather than treating the historical trace as proof that the current provider path still drops pipeline metadata
- **AND** when that context-pipeline telemetry is absent, diagnostics MUST NOT also emit current-remediation history-tail or post-gate-unbounded history reasons from legacy provider replay fields
- **AND** when no stable user task prompt is cacheable, the adapter MAY fall back to cacheable system prefix, visible tool-schema, or bounded message-tail provider-native breakpoints according to provider constraints, while keeping at most one message-level cache breakpoint
- **AND** Anthropic-compatible adapters MUST treat stable visible tool schemas as cacheable provider input, MUST NOT add a separate tool-schema cache breakpoint when the stable user task prompt is already the single primary breakpoint, and diagnostics MUST emit a stable provider-tool-schema-cache-gap reason when stable prompt replay and provider-prefix evidence still produce low cache hits with a stable visible tool set
- **AND** provider request replay MUST normalize visible tool schema count evidence across runtime/provider field names so cache-gap diagnostics are not lost because one trace uses `visibleToolSchemaCount` instead of `visibleToolCount`
- **AND** provider request replay telemetry MUST distinguish total provider message count from selected dynamic history count, so history-tail diagnostics are based on bounded provider-facing dynamic history rather than stable system/profile/user prefix messages
- **AND** cache failures below target MUST use framework/cache actionability rather than model feedback
- **中文** 当治理 SWE-bench run 报告缓存证据时，provider token cache metrics 与 context projection cache metrics 必须分开报告；context projection no-store event 必须单独计数，且不得拉低可缓存 context projection hit rate；provider-prefix cache evidence 必须来自最终 prompt assembly/model request shape，而不能只看 context projection selected blocks；Anthropic-compatible provider usage 必须把 cache creation/write tokens 计入 cache miss/write 证据，而不是从 provider cache 分母中丢弃；当 context projection 是 no-store 或只有 current-turn，但最终 prompt assembly 含稳定框架前缀时，diagnostics 必须分开保留 context projection cache summary，并为稳定前缀暴露 provider-prefix fingerprint/count evidence；证据允许时，低 provider cache 必须分类为 cold start、有界 history tail 或 prompt prefix drift；带 context pipeline fingerprint 的 Anthropic-compatible provider request 必须暴露 explicit prefix cache hint 状态为 `sent`、`missing` 或 `unsupported`；能够发送 provider-native prefix hint 的 adapter 不得因为缺失默认 capability metadata 而报告 `unsupported`；explicit prefix hint 状态为 `sent` 不得直接视为缓存健康证据，除非 request shape 把 provider-native cache breakpoint 放在稳定共享前缀上，而不是把易变 system tail 合进缓存块；当 explicit prefix hint 状态为 `sent` 但 stable provider prefix 小到不足以形成有效复用时，diagnostics 必须带 prefix message-count 与 token-estimate 证据输出稳定的 provider-prefix-too-small 原因；当 provider-prefix fingerprint 稳定但 stable prefix 对增长中的 provider request 覆盖过低时，diagnostics 必须带 coverage-ratio 证据输出稳定的 provider-prefix-coverage-low 原因；当正向 provider cache-hit token 证据已经大于 prompt 侧 provider-prefix token estimate、但总 provider cache hit rate 仍低于目标时，diagnostics 必须带 effective stable hit-token 与 dynamic miss-token 证据输出 provider-cache-dynamic-tail-miss 原因，而不是把稳定前缀当成缺失或不稳定；当 prompt replay fingerprint 保持稳定但 provider-prefix fingerprint 变化时，diagnostics 必须带 provider-prefix fingerprint/count/token 证据输出稳定的 provider-prefix-drift 原因；当同一 context pipeline 在已发送 prefix hint 的情况下反复出现 provider 零命中时，diagnostics 必须输出稳定的 provider-cache-breakpoint-shape-miss 原因，而不是归因于模型能力；启用 provider-native prompt caching 时，Anthropic-compatible adapter 必须在 provider-facing prompt evidence 中保留可缓存 system prefix boundaries；当稳定 user task prompt 可缓存时，adapter 必须把该 prompt 作为本 request 的唯一 provider-native cache breakpoint，且不得同时给 system prefix、可见 tool schema 或 dynamic history tail 添加 provider-native cache breakpoint；受管 SWE-bench 的 provider-facing history 必须保留稳定任务 prompt，以及下一步动作所需的最新动态工具反馈 pair 和最新 framework gate，同时把完整 assistant/tool history 保留在 lossless trace evidence 中；CLI one-shot 的 `Resolve SWE-bench instance ...` 类 prompt 也必须应用同一 provider-facing history 有界策略，但只有出现 managed execution profile 时才启用受管 child-run verification gates；当稳定 user task prompt 已经承载 Anthropic-compatible message-level cache breakpoint 时，同一个 request 内不得再给动态 history tail 添加第二个 message-level breakpoint；provider usage evidence 必须暴露脱敏的 cache breakpoint-shape 计数，当低 provider cache hit 与超过一个 message-level cache breakpoint 同时出现时，diagnostics 必须输出稳定的 `SWE_BENCH_PROVIDER_CACHE_MULTI_MESSAGE_BREAKPOINT` / `CACHE_PROVIDER_MULTI_MESSAGE_BREAKPOINT` 原因；当没有可缓存的稳定 user task prompt 时，adapter 可以按 provider 约束回退到可缓存 system prefix、可见 tool schema 或有界 message-tail breakpoint，但最多保留一个 message-level cache breakpoint；Anthropic-compatible adapter 必须把稳定可见 tool schema 视为可缓存 provider input；当稳定 user task prompt 已经是单一主 breakpoint 时，不得再给 tool schema 添加独立 breakpoint；当 stable prompt replay、provider-prefix evidence 与稳定可见 tool set 仍产生低缓存命中时，diagnostics 必须输出稳定的 provider-tool-schema-cache-gap 原因；provider request replay 必须跨 runtime/provider 字段名规范化 visible tool schema count 证据，避免某条 trace 使用 `visibleToolSchemaCount` 而不是 `visibleToolCount` 时丢失 cache-gap 诊断；低于目标的 cache failure 必须使用 framework/cache actionability，而不是 model feedback。
- **中文补充** 有意放在稳定 provider prefix 之外的易变 system-state message 不得阻止后续稳定 user task prompt 获得唯一的 message-level provider-native cache breakpoint；provider usage evidence 必须暴露脱敏的 message breakpoint 位置，例如 first-message、middle-message 或 last-message，并在低缓存 breakpoint-shape 诊断 metadata 中聚合这些位置计数。
- **中文补充** 当低 provider cache hit 发生但 provider usage evidence 缺少 breakpoint-shape 计数时，diagnostics 必须输出稳定的 `SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_TELEMETRY_MISSING` / `CACHE_PROVIDER_BREAKPOINT_SHAPE_TELEMETRY_MISSING` 原因，而不是基于不完整历史 trace 推断 cache shape。
- **中文补充** `usage.updated` 与 `model.usage.audit` 等 runtime usage evidence 必须保留 provider 传入的 cache breakpoint-shape 计数，使 diagnostics 能区分历史 telemetry 缺失与 runtime metadata 丢失。
- **中文补充** 当低缓存 trace 有稳定 prompt replay 证据，但 prompt assembly、model request 和 provider usage 都没有 context-pipeline telemetry 时，diagnostics 必须输出 `SWE_BENCH_PROVIDER_CACHE_PIPELINE_TELEMETRY_ABSENT` / `CACHE_PROVIDER_PIPELINE_TELEMETRY_ABSENT`，而不是把历史 trace 当成当前 provider path 仍然丢 pipeline metadata 的证据。
- **中文补充** 当 context-pipeline telemetry 缺失时，diagnostics 不得再从旧 provider replay 字段同时输出需要当前修复的 history-tail 或 post-gate-unbounded history 原因。
- **中文补充** 当正向 provider cache-hit token 证据已经大于 prompt 侧 provider-prefix token estimate，但低命中请求是缺少 breakpoint-shape telemetry 的间歇零命中请求时，diagnostics 不得再同时输出 provider-prefix-coverage-low、provider-tool-schema-cache-gap 或 whole-prompt-dynamic-with-stable-prefix 作为可执行 cache-shape 原因。
- **中文补充** provider request replay telemetry 必须区分总 provider message count 与选入的动态 history count，使 history-tail 诊断基于有界 provider-facing dynamic history，而不是稳定 system/profile/user prefix messages。
- **中文补充** 故意放在稳定 provider prefix 外的模型可见 staged workflow state 发生变化时，只要 provider-prefix fingerprint/count/token 证据保持稳定，diagnostics 不得把该变化计为 prompt cache prefix drift。

#### Scenario: Volatile prompt sections do not interrupt stable provider prefix / 易变 Prompt 区块不得截断稳定 Provider Prefix

- **WHEN** prompt assembly contains stable runtime framework sections and volatile runtime sections such as task-decision or self-repair evidence
- **THEN** the provider-facing message order MUST keep stable system framework sections contiguous before the first volatile system section
- **AND** volatile current-turn context blocks MUST remain available in trace evidence without being rendered inside provider-facing stable context-pipeline text
- **AND** model-visible stable prefix text MUST NOT include session, turn, request, plan, or current-turn block identifiers that change across otherwise equivalent attempts
- **AND** provider-prefix fingerprints SHOULD remain stable across attempts when only those runtime identifiers change and the user task/framework content is otherwise equivalent
- **中文** 当 prompt assembly 同时包含稳定 runtime framework 区块和 task-decision/self-repair 等易变 runtime 区块时，provider-facing message order 必须让稳定 system framework 区块在第一个易变 system 区块之前保持连续；易变 current-turn context block 必须继续保留在 trace evidence 中，但不得渲染进 provider-facing stable context-pipeline 文本；model-visible stable prefix 文本不得包含跨等价 attempt 会变化的 session、turn、request、plan 或 current-turn block 标识；当只有这些 runtime 标识变化且用户任务/框架内容等价时，provider-prefix fingerprint 应保持稳定。

#### Scenario: Stable repository instructions do not truncate provider prefix / 稳定仓库指令不得截断 Provider Prefix

- **WHEN** final prompt assembly includes repository instructions from current workspace governance files before runtime mode context
- **AND** those repository instructions are stable for the current run and included in the provider-facing system message prefix
- **THEN** prompt assembly MUST mark those repository instruction messages as stable provider-prefix content
- **AND** provider-prefix evidence MUST count both the stable repository instruction messages and later stable runtime framework messages until the first volatile system tail
- **AND** provider cache diagnostics MUST treat a zero stable provider-prefix count in that shape as prompt cache prefix busted or missing, not as model capability evidence
- **中文** 当最终 prompt assembly 在 runtime mode context 之前包含当前 workspace 治理文件中的仓库指令，且这些仓库指令在当前 run 中稳定并位于 provider-facing system message 前缀时，prompt assembly 必须把这些仓库指令消息标记为 stable provider-prefix content；provider-prefix evidence 必须同时计入稳定仓库指令消息与后续稳定 runtime framework 消息，直到第一个易变 system tail；这种形状下 stable provider-prefix count 为 0 时，cache diagnostics 必须归为 prompt cache prefix busted 或 missing，而不是模型能力证据。

#### Scenario: Resumed provider history preserves newest lossless evidence / 恢复后的 Provider History 必须保留最新 Lossless Evidence

- **WHEN** a resumed SWE-bench or coding session has more lossless context nodes than the provider-facing restored history limit
- **THEN** runtime restoration MUST select the newest restorable user, assistant, and tool-result nodes before older nodes
- **AND** the provider-facing restored messages MUST remain in chronological order after selection
- **AND** newer tool-result feedback MUST NOT be dropped merely because older restored nodes filled the provider history limit first
- **中文** 当恢复中的 SWE-bench 或 coding session 的 lossless context nodes 数量超过 provider-facing restored history limit 时，runtime restoration 必须优先选择最新的可恢复 user、assistant 与 tool-result nodes，再考虑旧节点；选中后交给 provider 的 restored messages 仍必须保持时间顺序；不能因为旧恢复节点先填满 provider history limit 而丢掉更新的 tool-result feedback。
