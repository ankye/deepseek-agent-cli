## ADDED Requirements

### Requirement: Run-Scoped SWE-bench Short Prompt Routing

SWE-bench Lite short prompts SHALL route the agent toward governed, run-scoped evaluation capabilities and SHALL NOT expose historical evaluator workspace roots as model-facing task guidance.

SWE-bench Lite 短 prompt 必须把 agent 路由到受管、绑定本轮运行的 evaluation capability，不得把历史 evaluator workspace root 暴露成面向模型的任务指导。

#### Scenario: Short prompt does not advertise stale benchmark directories / 短 prompt 不宣传历史 benchmark 目录

- **WHEN** a user prompt asks the CLI to complete a SWE-bench Lite numbered task, for example `给我完成 SWE-bench Lite 第 2 题测试，跑通并告诉我结果。`
- **THEN** task delivery flow MUST classify it as an executable evaluation task
- **AND** the runtime task state MUST bind the turn to governed SWE-bench run preparation/evaluation capabilities rather than historical evaluator directories
- **AND** those model-facing strings MUST NOT mention `.deepseek/swebench-workspaces`, historical prediction traces, or evaluator-side artifact directories as paths to list or choose from
- **中文** 当用户 prompt 要求 CLI 完成 SWE-bench Lite 编号任务，例如 `给我完成 SWE-bench Lite 第 2 题测试，跑通并告诉我结果。`，task delivery flow 必须将其分类为可执行评测任务；runtime task state 必须把该 turn 绑定到受管 SWE-bench run preparation/evaluation capability，而不是历史 evaluator directories；这些面向模型的字符串不得提到 `.deepseek/swebench-workspaces`、历史 prediction traces 或 evaluator-side artifact directories 作为可列举或可选择路径。

#### Scenario: Runtime rejects stale workspace tool input before kernel execution / Runtime 在 kernel 执行前拒绝 stale workspace 工具输入

- **WHEN** a model tool call in a SWE-bench Lite task includes `.deepseek/swebench-workspaces` in any model-authored tool input
- **THEN** the agent loop MUST return a typed `task-scope.rejected` tool result before calling the runtime kernel
- **AND** no `kernel.request.accepted`, `capability.started`, or process execution event may be emitted for that tool call
- **AND** the rejection MUST be recorded as evidence independently of whether the prompt asked the model to avoid stale workspaces
- **中文** 当 SWE-bench Lite task 中的模型工具调用在任意模型编写的 tool input 里包含 `.deepseek/swebench-workspaces` 时，agent loop 必须在调用 runtime kernel 前返回 typed `task-scope.rejected` tool result；该 tool call 不得产生 `kernel.request.accepted`、`capability.started` 或 process execution event；拒绝证据必须独立于 prompt 是否要求模型避免 stale workspaces。

### Requirement: Governed SWE-bench Run Capability

The CLI host SHALL expose a model-visible governed SWE-bench run capability that accepts a numbered SWE-bench Lite task request and performs run-scoped environment preparation, dataset resolution, checkout binding, prediction capture, trace capture, and bounded evidence without requiring the model to provide evaluator artifact paths.

CLI host 必须暴露一个模型可见的受管 SWE-bench run capability，接受 SWE-bench Lite 编号任务请求，并由框架完成 run-scoped environment preparation、dataset resolution、checkout binding、prediction capture、trace capture 与 bounded evidence；模型不得被要求提供 evaluator artifact path。

#### Scenario: Numbered task input binds a run-scoped prediction flow / 编号任务输入绑定本轮 prediction flow

- **WHEN** the model calls the governed SWE-bench run capability with `taskNumber: 2`
- **THEN** the capability MUST create or reuse only a run-scoped checkout under the current run root
- **AND** it MUST resolve the dataset instance, bind the checkout to the instance base commit, run the prediction flow, and write redacted evidence for the run
- **AND** it MUST default to execution unless the model explicitly sets `dryRun: true` or `execute: false`
- **AND** SWE-bench short prompts MUST receive a tool execution timeout budget high enough for the governed run capability, capped at the runtime envelope maximum of 7200000 ms
- **AND** the model-visible evidence MUST NOT include raw problem statements, API keys, raw patch contents, `.deepseek/swebench-workspaces`, or host-only evaluator paths
- **中文** 当模型调用受管 SWE-bench run capability，并传入 `taskNumber: 2` 时，该 capability 必须只在本轮 run root 下创建或复用 run-scoped checkout；它必须解析 dataset instance、把 checkout 绑定到 instance base commit、运行 prediction flow，并写入本轮脱敏证据；除非模型显式设置 `dryRun: true` 或 `execute: false`，否则 capability 必须默认执行；SWE-bench 短 prompt 必须获得足以运行受管 run capability 的 tool execution timeout budget，并以 runtime envelope 最大值 7200000 ms 为上限；模型可见证据不得包含原始题面、API key、raw patch 内容、`.deepseek/swebench-workspaces` 或 host-only evaluator path。

#### Scenario: Batch task input is scheduled by the framework / 批量任务输入由框架调度

- **WHEN** the model calls the governed SWE-bench run capability with `taskNumbers: [2, 3, 4]`
- **THEN** the capability MUST schedule each task through an isolated per-task run root under the batch run id
- **AND** `resume: true` MUST skip tasks whose persisted per-task summary proves `evaluationResolved: true`
- **AND** batch evidence MUST include total, completed, resolved, unresolved, failed, skipped counts, resolved rate, unresolved task numbers, skipped task numbers, and child run summaries
- **AND** batch evidence MUST include per-task states with each task number, child run id, resolved/unresolved/failed/skipped/pending status, evaluation result when known, and attempt count when known
- **AND** the batch summary MUST be persisted after each child task completes so interrupted campaigns can resume from durable partial evidence
- **AND** this batching MUST be implemented by the capability layer rather than requiring the model to loop over single-task prompts
- **中文** 当模型调用受管 SWE-bench run capability 并传入 `taskNumbers: [2, 3, 4]` 时，该 capability 必须在 batch run id 下为每个任务调度独立 per-task run root；`resume: true` 必须跳过已有持久化 per-task summary 且能证明 `evaluationResolved: true` 的任务；batch evidence 必须包含 total、completed、resolved、unresolved、failed、skipped count、resolved rate、unresolved task numbers、skipped task numbers 与 child run summaries；batch evidence 还必须包含 per-task states，记录每个 task number、child run id、resolved/unresolved/failed/skipped/pending 状态、已知 evaluation result 和已知 attempt count；batch summary 必须在每个 child task 完成后持久化，使中断的 campaign 可以从 durable partial evidence 恢复；该批量能力必须由 capability 层实现，而不是要求模型自己循环单题 prompt。

#### Scenario: Resume without explicit run id uses a stable campaign id / 未显式 run id 的 resume 使用稳定 campaign id

- **WHEN** the model calls `core.swe.bench.run` with `taskNumbers` and `resume: true` but omits `runId`
- **THEN** the capability MUST use a stable default campaign run id derived from the task range
- **AND** repeated resume requests for the same range MUST look for the same per-task summaries
- **AND** non-resume live probes that omit `runId` MUST still use fresh default run ids so ad-hoc probes do not mix evidence
- **中文** 当模型以 `taskNumbers` 和 `resume: true` 调用 `core.swe.bench.run` 但省略 `runId` 时，capability 必须使用由 task range 派生的稳定默认 campaign run id；同一 range 的重复 resume 请求必须查找同一组 per-task summaries；非 resume 的临时 live probe 如果省略 `runId`，仍必须使用 fresh 默认 run id，避免临时 probe 混用证据。

#### Scenario: User prompt range repairs a single-task model call / 用户 prompt 范围修复单题模型调用

- **WHEN** the original user prompt explicitly asks for a SWE-bench Lite range such as `第 2 到第 4 题`
- **AND** the model calls `core.swe.bench.run` with only the first task as `taskNumber: 2`
- **THEN** tool-intent preflight MUST repair the model input to include `taskNumbers: [2, 3, 4]`
- **AND** the repair MUST be recorded with `swe-bench-task-range-normalized`
- **AND** the runtime MUST pass the original user prompt into tool-intent preflight as bounded provider hints rather than relying on prompt-only compliance
- **AND** the range normalization MUST support 200-instance campaign prompts such as `第 1 到第 200 题`
- **中文** 当原始用户 prompt 明确要求 SWE-bench Lite 范围，例如 `第 2 到第 4 题`，且模型只以 `taskNumber: 2` 调用 `core.swe.bench.run` 时，tool-intent preflight 必须把模型输入修复为包含 `taskNumbers: [2, 3, 4]`；该修复必须以 `swe-bench-task-range-normalized` 记录；runtime 必须把原始用户 prompt 作为有界 provider hints 传给 tool-intent preflight，而不是只依赖 prompt 合规；range normalization 必须支持 `第 1 到第 200 题` 这类 200-instance campaign prompt。

#### Scenario: Omitted run id creates fresh evidence root / 省略 run id 时创建 fresh 证据根

- **WHEN** the model calls `core.swe.bench.run` without an explicit `runId`
- **THEN** the capability MUST generate a fresh default run id for that invocation
- **AND** repeated live probes for the same task number MUST NOT reuse the same default trace and summary directory
- **AND** explicit `runId` values MAY still be used for deliberate resume or campaign workflows
- **中文** 当模型调用 `core.swe.bench.run` 且未显式提供 `runId` 时，capability 必须为本次调用生成 fresh 默认 run id；同一 task number 的重复 live probe 不得复用同一个默认 trace 和 summary 目录；显式 `runId` 仍可用于有意的 resume 或 campaign workflow。

#### Scenario: Cache evidence separates provider and context cache / Cache 证据区分 provider 与 context cache

- **WHEN** a governed SWE-bench evaluation reads a child trace for cache auditing
- **THEN** provider token cache SLO metrics MUST be computed only from provider usage events such as `usage.updated.metadata.cache`
- **AND** context projection cache metrics MUST be reported separately from `context.projection.completed.data.cache`
- **AND** governed run and batch summaries MUST surface provider cache hit rate, request count, and pass/fail status when cache evidence is available
- **AND** the engineering cache hit target MUST gate provider token cache hit rate, while context projection cache MUST remain an observability metric and MUST NOT be mixed into provider token hit rate
- **中文** 当受管 SWE-bench evaluation 读取 child trace 进行 cache audit 时，provider token cache SLO 指标必须只从 `usage.updated.metadata.cache` 等 provider usage event 计算；context projection cache 指标必须从 `context.projection.completed.data.cache` 单独报告；当 cache evidence 可用时，受管 run 和 batch summary 必须暴露 provider cache hit rate、request count 与 pass/fail status；工程 cache hit target 必须 gate provider token cache hit rate，而 context projection cache 只能作为可观测指标，不能混入 provider token hit rate。

#### Scenario: Workspace process defaults are injected before policy evaluation / Workspace process 默认值在 policy evaluation 前注入

- **WHEN** the model calls `core.swe.bench.run` or `core.env.prepare` without `cwd` or `workspaceRoot`
- **THEN** tool-intent preflight MUST repair the input with `cwd: "."` and the active `workspaceRoot`
- **AND** for `core.swe.bench.run`, tool-intent preflight MUST default `timeoutMs` to 7200000 when the model omits a timeout
- **AND** policy evaluation MUST see a process resource scope with a cwd so the request is not denied for `process.cwd.missing`
- **AND** this repair MUST be framework-owned rather than prompt-owned
- **中文** 当模型调用 `core.swe.bench.run` 或 `core.env.prepare` 且没有提供 `cwd` 或 `workspaceRoot` 时，tool-intent preflight 必须把 input 修复为 `cwd: "."` 并注入当前 active `workspaceRoot`；对于 `core.swe.bench.run`，当模型省略 timeout 时，tool-intent preflight 必须默认注入 `timeoutMs: 7200000`；policy evaluation 必须看到带 cwd 的 process resource scope，因此不能因为 `process.cwd.missing` 拒绝请求；该修复必须属于框架层，而不是靠 prompt 要求模型填写。

#### Scenario: Long-running run capability returns evidence instead of scheduler timeout / 长运行 run capability 返回证据而不是 scheduler timeout

- **WHEN** a model calls a governed long-running capability such as `core.swe.bench.run` without specifying `timeoutMs`
- **THEN** tool-intent preflight MUST inject the capability's governed long-running timeout
- **AND** if the model supplies a lower or otherwise non-governed timeout for `core.swe.bench.run`, tool-intent preflight and the CLI host capability MUST normalize it to the governed long-running timeout before execution
- **AND** the agent loop MUST pass the manifest-declared tool budget into the runtime kernel instead of clamping it to the ordinary short tool timeout
- **AND** runtime envelope validation and sandbox policy MUST allow that timeout up to the platform maximum of 7200000 ms
- **AND** ordinary tools without a manifest-declared long budget MUST remain bounded by the agent-loop tool timeout limit
- **中文** 当模型调用 `core.swe.bench.run` 这类受管长运行 capability 且没有指定 `timeoutMs` 时，tool-intent preflight 必须注入该 capability 的受管长运行 timeout；如果模型为 `core.swe.bench.run` 提供了更低或非受管的 timeout，tool-intent preflight 与 CLI host capability 必须在执行前将其标准化为受管长运行 timeout；agent loop 必须把 manifest 声明的 tool budget 传入 runtime kernel，而不是压到普通短工具 timeout；runtime envelope validation 与 sandbox policy 必须允许该 timeout，以上限 7200000 ms 为准；没有 manifest 长预算声明的普通工具仍必须受 agent-loop tool timeout limit 约束。

#### Scenario: Child trace records missing SWE verification / Child trace 记录缺失 SWE 验证

- **WHEN** a governed SWE-bench prediction run captures model-authored process tool intents in the supervised child trace
- **AND** none of those intents is either a recognized shell test command such as `pytest`, `python -m pytest`, `tox`, `nox`, `unittest`, or package test runners, or a first-class test capability such as `core.test.run`
- **THEN** the diagnostics summary MUST include `SWE_BENCH_CHILD_TRACE_VERIFICATION_MISSING` with shell and test command counts
- **AND** governed `core.swe.bench.run` evidence MUST surface `childShellCommandCount`, `childTestCommandCount`, and `verificationCommandMissing` in metadata and a bounded preview
- **AND** this diagnostic MUST be emitted from trace evidence rather than supervisor inference or hidden model reasoning
- **AND** a trace that includes a recognized model-authored test command or `core.test.run` intent MUST NOT emit this diagnostic
- **中文** 当受管 SWE-bench prediction run 在受监督 child trace 中捕获到模型编写的 process tool intent，且这些 intent 中既没有 `pytest`、`python -m pytest`、`tox`、`nox`、`unittest` 或 package test runner 等可识别 shell test command，也没有 `core.test.run` 这类一等 test capability 时，diagnostics summary 必须包含 `SWE_BENCH_CHILD_TRACE_VERIFICATION_MISSING`，并记录 shell/test command count；受管 `core.swe.bench.run` evidence 必须在 metadata 和 bounded preview 中暴露 `childShellCommandCount`、`childTestCommandCount` 与 `verificationCommandMissing`；该诊断必须来自 trace evidence，而不是监督者推断或隐藏模型思维；如果 trace 包含可识别的模型自发 test command 或 `core.test.run` intent，则不得发出该诊断。

#### Scenario: Managed child prompt carries phase and verification gates / 受管 child prompt 携带阶段与验证门禁

- **WHEN** the governed SWE-bench prediction adapter launches the child CLI agent for a resolved instance
- **THEN** the child prompt MUST include a managed SWE-bench execution profile with phase budgets for source inspection, dependency setup, source edit, and verification
- **AND** the profile MUST require at least one model-authored standard test command before the child may answer `SWE patch ready`
- **AND** the profile MUST remain process guidance only and MUST NOT include solution-specific source edits or benchmark answers
- **中文** 当受管 SWE-bench prediction adapter 为已解析 instance 启动 child CLI agent 时，child prompt 必须包含受管 SWE-bench execution profile，覆盖 source inspection、dependency setup、source edit 与 verification 的阶段预算；profile 必须要求 child 在回答 `SWE patch ready` 前至少发起一次模型自发 standard test command；该 profile 只能是流程指导，不得包含特定题目的源码修改方案或 benchmark 答案。

#### Scenario: Runtime forces verification when managed child loop keeps probing / Runtime 在 managed child loop 持续探查时强制进入验证

- **WHEN** a managed SWE-bench child agent repeatedly issues model-authored shell commands without any recognized standard test command
- **AND** the child trace has not recorded first-class test verification through `core.test.run`
- **THEN** runtime MUST consume verification budget and emit an `agent.loop.budget.consumed` event with `gate: "SWE_BENCH_VERIFICATION_GATE"`
- **AND** runtime MUST insert framework feedback containing `SWE_BENCH_VERIFICATION_GATE` into the next model-bound message context
- **AND** any following non-test `core.shell.run` call MUST be rejected before kernel execution with terminal kind `swe-bench-verification-gate.rejected` until the child emits a recognized standard test command or `core.test.run`
- **AND** the rejection feedback MUST include `SWE_BENCH_VERIFICATION_GATE_ENFORCED` and MUST continue the model loop so the child can self-correct by running a test
- **AND** the rejected tool call MUST NOT emit `kernel.request.accepted`, `capability.started`, or process execution evidence
- **AND** runtime MUST NOT insert this gate after a model-authored `core.test.run` intent has been observed for the managed run
- **AND** this gate MUST be scoped to prompts carrying the managed SWE-bench execution profile so ordinary shell workflows are not redirected
- **中文** 当 managed SWE-bench child agent 重复发出模型编写的 shell command，却没有任何可识别 standard test command，且 child trace 尚未通过 `core.test.run` 记录一等测试验证时，runtime 必须消耗 verification budget，并发出带 `gate: "SWE_BENCH_VERIFICATION_GATE"` 的 `agent.loop.budget.consumed` event；runtime 必须把包含 `SWE_BENCH_VERIFICATION_GATE` 的框架反馈插入下一轮模型上下文；之后任何非测试 `core.shell.run` 调用必须在 kernel 执行前以 `swe-bench-verification-gate.rejected` 拒绝，直到 child 发出可识别 standard test command 或 `core.test.run`；拒绝反馈必须包含 `SWE_BENCH_VERIFICATION_GATE_ENFORCED`，并继续 model loop，让 child 能通过运行测试自行纠正；被拒绝的 tool call 不得产生 `kernel.request.accepted`、`capability.started` 或进程执行证据；如果 managed run 已经观察到模型编写的 `core.test.run` intent，runtime 不得再插入该 gate；该 gate 只能作用于携带 managed SWE-bench execution profile 的 prompt，不能重定向普通 shell workflow。

#### Scenario: Runtime stops source-inspection loops before model iteration exhaustion / Runtime 在模型迭代耗尽前阻止源码探索循环

- **WHEN** a managed SWE-bench child agent spends the source-inspection budget on model-authored read/search/list tool calls
- **AND** the child trace has not recorded source mutation, a recognized standard test command, or `core.test.run`
- **THEN** runtime MUST consume verification budget and emit an `agent.loop.budget.consumed` event with `gate: "SWE_BENCH_SOURCE_INSPECTION_GATE"`
- **AND** runtime MUST insert framework feedback containing `SWE_BENCH_SOURCE_INSPECTION_GATE` into the next model-bound message context
- **AND** any following read/search/list inspection tool call MUST be rejected before kernel execution with terminal kind `swe-bench-source-inspection-gate.rejected` until the child emits source edit or test progress
- **AND** the rejection feedback MUST include `SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED`
- **AND** the gate MUST still allow source edits, standard test commands, `core.test.run`, and bounded blocker reporting
- **中文** 当 managed SWE-bench child agent 把 source-inspection 预算消耗在模型编写的 read/search/list tool call 上，且 child trace 尚未记录源码修改、可识别 standard test command 或 `core.test.run` 时，runtime 必须消耗 verification budget，并发出带 `gate: "SWE_BENCH_SOURCE_INSPECTION_GATE"` 的 `agent.loop.budget.consumed` event；runtime 必须把包含 `SWE_BENCH_SOURCE_INSPECTION_GATE` 的框架反馈插入下一轮模型上下文；随后任何 read/search/list 探索类 tool call 必须在 kernel 执行前以 `swe-bench-source-inspection-gate.rejected` 拒绝，直到 child 发出源码编辑或测试进展；拒绝反馈必须包含 `SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED`；该 gate 仍必须允许源码编辑、standard test command、`core.test.run` 与有界 blocker 汇报。

#### Scenario: Runtime stops dependency-loop drift after edit and test evidence / Runtime 在已有编辑和测试证据后阻止依赖循环漂移

- **WHEN** a managed SWE-bench child agent has already issued a model-authored source mutation and a model-authored standard test command or `core.test.run`
- **AND** it continues spending repeated non-test shell commands on environment setup, dependency installation, or dependency probing
- **THEN** runtime MUST consume verification budget and emit an `agent.loop.budget.consumed` event with `gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"`
- **AND** runtime MUST insert framework feedback telling the child to stop broad dependency setup, use existing test/source evidence, inspect the diff if useful, and return control so the governed outer harness can score the patch
- **AND** following dependency setup or dependency probing `core.shell.run` calls MUST be rejected before kernel execution with terminal kind `swe-bench-environment-blocker-gate.rejected`
- **AND** the rejection feedback MUST include `SWE_BENCH_ENVIRONMENT_BLOCKER_GATE_ENFORCED`
- **AND** the gate MUST still allow source edits, diff inspection, final reporting, and recognized standard test commands
- **AND** this gate MUST be scoped to managed SWE-bench prompts so ordinary development sessions may continue environment setup when appropriate
- **中文** 当 managed SWE-bench child agent 已经发出模型编写的源码修改，并且已经发出模型编写的 standard test command 或 `core.test.run`，但仍然把多轮非测试 shell command 消耗在 environment setup、dependency installation 或 dependency probing 上时，runtime 必须消耗 verification budget，并发出带 `gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"` 的 `agent.loop.budget.consumed` event；runtime 必须向 child 插入框架反馈，要求停止广泛依赖安装，使用已有 test/source evidence，必要时检查 diff，并把控制权交还给受管 outer harness 评分；随后依赖准备或依赖探测类 `core.shell.run` 调用必须在 kernel 执行前以 `swe-bench-environment-blocker-gate.rejected` 拒绝；拒绝反馈必须包含 `SWE_BENCH_ENVIRONMENT_BLOCKER_GATE_ENFORCED`；该 gate 仍必须允许源码编辑、diff 检查、最终汇报与可识别 standard test command；该 gate 只能作用于 managed SWE-bench prompt，普通开发会话仍可在合适时继续环境准备。

#### Scenario: Unresolved official harness triggers supervised repair attempt / Unresolved official harness 触发受监督 repair attempt

- **WHEN** the first official SWE-bench harness evaluation completes for a governed run and reports unresolved instances
- **THEN** `core.swe.bench.run` MUST launch one additional child CLI repair attempt in the same run-scoped checkout before final scoring
- **AND** the second child prompt MUST include bounded previous-attempt feedback with failing test names and MUST NOT include solution-specific source edits
- **AND** the run evidence MUST include attempt count and whether repair was attempted
- **中文** 当受管 run 的第一次 official SWE-bench harness evaluation 完成并报告 unresolved instance 时，`core.swe.bench.run` 必须在最终打分前，在同一个 run-scoped checkout 中额外启动一次 child CLI repair attempt；第二次 child prompt 必须包含有界的 previous-attempt feedback 和失败测试名，但不得包含特定源码修改方案；run evidence 必须包含 attempt count 和是否触发 repair。

#### Scenario: Supervised attempts keep independent child traces / 受监督 attempt 保留独立 child trace

- **WHEN** `core.swe.bench.run` launches multiple child CLI attempts for the same governed run
- **THEN** each attempt MUST write its child trace to a stable per-attempt file such as `trace-attempt-1.jsonl` and `trace-attempt-2.jsonl`
- **AND** `trace.jsonl` MUST remain available as a latest-trace pointer for existing diagnostics and operator workflows
- **AND** evaluation cache and verification diagnostics for each official harness attempt MUST read the trace for the corresponding child attempt
- **中文** 当 `core.swe.bench.run` 为同一个受管 run 启动多个 child CLI attempt 时，每次 attempt 必须把 child trace 写入稳定的 per-attempt 文件，例如 `trace-attempt-1.jsonl` 与 `trace-attempt-2.jsonl`；`trace.jsonl` 必须继续作为 latest-trace 指针供现有 diagnostics 与操作者 workflow 使用；每次 official harness attempt 的 cache 与 verification diagnostics 必须读取对应 child attempt 的 trace。

#### Scenario: Stale harness reports are rejected / Stale harness report 被拒绝

- **WHEN** a governed SWE-bench evaluation run executes the official harness for a reused run id
- **AND** the expected `logs/run_evaluation/.../report.json` exists but is older than the current evaluation freshness marker
- **THEN** the evaluation adapter MUST NOT read that stale report as current score evidence
- **AND** it MUST emit `SWE_BENCH_REPORT_STALE` and fail the evaluation summary rather than reporting a resolved or unresolved score from stale data
- **中文** 当受管 SWE-bench evaluation run 使用复用 run id 执行 official harness，且预期的 `logs/run_evaluation/.../report.json` 存在但早于当前 evaluation freshness marker 时，evaluation adapter 不得把该 stale report 当作当前分数证据读取；它必须发出 `SWE_BENCH_REPORT_STALE` 并使 evaluation summary 失败，而不是从旧数据报告 resolved 或 unresolved score。

#### Scenario: Official harness run ids are unique per execution / Official harness run id 每次执行唯一

- **WHEN** `core.swe.bench.run` executes official SWE-bench evaluation multiple times for the same run-scoped checkout id
- **THEN** each official harness invocation MUST use a unique `--run_id`
- **AND** the stable outer run id MAY continue to identify the checkout and evidence root
- **AND** the unique official harness run id MUST prevent collisions with prior `logs/run_evaluation/<run_id>` directories across repeated CLI invocations
- **中文** 当 `core.swe.bench.run` 对同一个 run-scoped checkout id 多次执行 official SWE-bench evaluation 时，每次 official harness invocation 必须使用唯一 `--run_id`；稳定的外层 run id 可以继续标识 checkout 与 evidence root；唯一 official harness run id 必须避免重复 CLI 调用时撞上旧的 `logs/run_evaluation/<run_id>` 目录。

#### Scenario: Evaluation failures return structured run evidence / Evaluation failure 返回结构化运行证据

- **WHEN** a governed SWE-bench run reaches prediction or official evaluation and the final status is `fail`
- **THEN** `core.swe.bench.run` MUST return a successful capability envelope containing bounded `evidence.status: "failed"` rather than a kernel executor failure
- **AND** the evidence metadata MUST preserve the run id, instance id when known, prediction/evaluation statuses, diagnostics, command counts, attempt count, and verification summary
- **AND** kernel executor failures MUST be reserved for early failures that do not have structured prediction or evaluation evidence
- **中文** 当受管 SWE-bench run 已经进入 prediction 或 official evaluation，且最终状态为 `fail` 时，`core.swe.bench.run` 必须返回包含有界 `evidence.status: "failed"` 的成功 capability envelope，而不是 kernel executor failure；evidence metadata 必须保留 run id、已知 instance id、prediction/evaluation status、diagnostics、command count、attempt count 与 verification summary；kernel executor failure 只能用于尚未形成结构化 prediction/evaluation evidence 的早期失败。

### Requirement: Agentic Evaluation Blocker Catalog

The SWE-bench evaluation test framework SHALL maintain an executable blocker catalog with at least 100 real agentic failure modes and SHALL project child trace/run summary signals into machine-readable findings.

SWE-bench 评测测试框架必须维护至少 100 个真实 agentic failure mode 的可执行 blocker catalog，并必须把 child trace/run summary 信号投射成机器可读 findings。

#### Scenario: Catalog covers at least 100 real blockers / Catalog 覆盖至少 100 个真实 blocker

- **WHEN** the diagnostics test framework loads the agentic evaluation blocker catalog
- **THEN** it MUST contain at least 100 stable unique blocker ids
- **AND** every blocker MUST include phase, severity, executable detector, and remediation text
- **AND** the catalog MUST cover task routing, tool policy, phase progress, environment, verification, tool execution, evaluation scoring, batch resume, cache economics, and trace observability
- **中文** 当 diagnostics test framework 加载 agentic evaluation blocker catalog 时，catalog 必须包含至少 100 个稳定且唯一的 blocker id；每个 blocker 必须包含 phase、severity、可执行 detector 与 remediation 文本；catalog 必须覆盖 task routing、tool policy、phase progress、environment、verification、tool execution、evaluation scoring、batch resume、cache economics 与 trace observability。

#### Scenario: Child trace summary emits blocker findings / Child trace summary 输出 blocker findings

- **WHEN** a child trace shows live-run failure signals such as source-inspection loops, model iteration limit, unresolved official harness score, incomplete batch progress, or low provider cache hit rate
- **THEN** the diagnostics framework MUST emit matching blocker findings without requiring a human to inspect JSONL manually
- **AND** blocker findings MUST be linked to stable blocker ids from the catalog
- **AND** missing metrics MUST NOT produce metric-only blocker false positives
- **中文** 当 child trace 暴露真实运行失败信号，例如 source-inspection loop、model iteration limit、official harness unresolved、batch progress incomplete 或 provider cache hit rate 过低时，diagnostics framework 必须输出匹配的 blocker findings，不得要求人工手动翻 JSONL；blocker findings 必须链接到 catalog 中稳定的 blocker id；缺失指标不得产生 metric-only blocker 假阳性。

### Requirement: Stale SWE-bench Workspace Traversal Guard

Model-authored shell commands SHALL NOT traverse from the CLI workspace root into historical SWE-bench workspaces. Commands that are already scoped to an explicitly selected benchmark checkout MAY still run focused source inspection, local virtualenv, tests, and git diff operations within that checkout.

模型编写的 shell 命令不得从 CLI workspace root 直接进入历史 SWE-bench workspace。已经被显式限定在选定 benchmark checkout 内的命令，仍可在该 checkout 内运行 focused source inspection、本地 virtualenv、测试与 git diff 操作。

#### Scenario: Direct historical workspace traversal is rejected / 直接历史 workspace traversal 被拒绝

- **WHEN** `core.shell.run` receives a model-authored command such as `cd .deepseek/swebench-workspaces/<instance>/repo && ...` while its cwd is the CLI workspace root
- **THEN** the capability MUST fail before process execution with a typed SWE-bench boundary diagnostic
- **AND** no shell process may be launched
- **中文** 当 `core.shell.run` 在 cwd 为 CLI workspace root 时收到模型编写的 `cd .deepseek/swebench-workspaces/<instance>/repo && ...` 这类命令，capability 必须在执行进程前以 typed SWE-bench boundary diagnostic 失败，且不得启动 shell 进程。
