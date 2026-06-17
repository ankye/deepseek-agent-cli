# SWE-bench 200 Ramp Governance Design

## Governance Gates

The ramp target is cumulative 200 official resolved instances. The gate for increasing task volume is stricter than the long-term target because the current sample is unstable.

累计目标是 200 个 official resolved instance。扩批门槛必须高于长期目标，因为当前样本仍不稳定。

| Gate | Required value | Action when below gate |
| --- | --- | --- |
| Official success rate | `resolved / attempted >= 0.80` | Review previous failures only; no task 11/12 or wider batch |
| Provider cache hit rate | `providerCache.hitRate >= 0.90` | Cache review and framework fix only; no wider batch |
| Failure attribution | every non-resolved task has stable codes | Add diagnostics before rerun |
| Prompt/repro evidence | reproduction attempted or missing reason recorded | Fix prompt/repair loop before blaming model |

| 门槛 | 要求值 | 低于门槛时动作 |
| --- | --- | --- |
| Official success rate | `resolved / attempted >= 0.80` | 只复盘历史失败；不跑第 11/12 题或更大批次 |
| Provider cache hit rate | `providerCache.hitRate >= 0.90` | 只做缓存复盘与框架修复；不扩批 |
| Failure attribution | 每个未 resolved task 都有稳定 code | 先补诊断再重跑 |
| Prompt/repro evidence | 已尝试复现或记录缺失原因 | 先修 prompt/repair loop，再归因模型 |

## Failure Taxonomy

Reason codes are stable product evidence, not prose summaries. A task may have multiple reason codes but must choose one primary code.

Reason code 是稳定产品证据，不是散文总结。一个任务可以有多个 reason code，但必须选择一个 primary code。

```text
FLOW_REQUEST_BUDGET_EXCEEDED
SWE_BENCH_RUN_CAPABILITY_ROUTING_GATE
FLOW_POST_EDIT_VERIFICATION_MISSING
GATE_SOURCE_INSPECTION_DEFIANCE
SWE_BENCH_READY_FOR_HARNESS_GATE_MISSING
VERIFICATION_ORACLE_GAP
REPRO_SYNTHESIS_MISSING
REPAIR_FEEDBACK_LOW_FIDELITY
LOCAL_TEST_SELECTION_PARAM_GAP
PATCH_SCOPE_UNDERSPECIFIED
GREEN_TEST_OVERTRUST
BATCH_PENDING_GOVERNANCE_BACKPRESSURE
PROVIDER_CACHE_BELOW_TARGET
PROVIDER_CACHE_PIPELINE_TELEMETRY_ABSENT
PROVIDER_CACHE_PIPELINE_MISSING
PROVIDER_CACHE_HISTORY_TAIL_MISS
PROVIDER_CACHE_PREFIX_HINT_MISSING
PROVIDER_CACHE_PREFIX_HINT_UNSUPPORTED
PROMPT_CACHE_PREFIX_BUSTED
CONTEXT_PROJECTION_NO_HIT
CONTEXT_PROJECTION_NO_STORE_ONLY
HARNESS_ERROR
HARNESS_DOCKER_IMAGE_MISSING
ENVIRONMENT_CHECKOUT_WARNING
ENV_TEST_DEPENDENCY_INCOMPATIBLE
ENV_TEST_DEPENDENCY_MISSING
ENV_POST_VERIFICATION_BLOCKER
VERIFICATION_TEST_ENTRYPOINT_MISSING
VERIFICATION_TEST_ARGUMENT_UNSUPPORTED
VERIFICATION_TEST_COMMAND_ENV_MISSCOPED
OFFICIAL_UNRESOLVED_AFTER_REPAIR
MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR
```

Actionability values:

```text
framework-fix
environment-fix
cache-fix
verification-fix
repair-feedback-fix
model-feedback
pending-review
```

Only `MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR` may use `model-feedback`, and only when official harness failure evidence, reproduction effort, local verification, cache state, and environment state are all available and non-blocking.

只有 `MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR` 可以使用 `model-feedback`，且前提是 official harness 失败证据、复现努力、本地验证、缓存状态与环境状态均已可用且不阻塞。

## Cache Governance

Provider token cache and context projection cache answer different questions. Provider cache measures whether the model provider can reuse stable prompt prefixes. Context projection cache measures whether stable context candidates avoid repeated projection work. A no-store projection that only contains the volatile current prompt is evidence, but it must not lower the cacheable projection hit rate.

Provider token cache 与 context projection cache 回答不同问题。Provider cache 衡量模型 provider 是否能复用稳定 prompt 前缀。Context projection cache 衡量稳定 context candidates 是否避免重复 projection。只包含易变当前 prompt 的 no-store projection 是证据，但不得拉低可缓存 projection 命中率。

Anthropic-compatible provider usage must account for cache read, uncached input, and cache creation/write tokens separately. Cache creation/write tokens are not free hits; they must contribute to miss/write evidence so cache hit-rate review does not silently drop provider-side prefix creation cost.

Anthropic-compatible provider usage 必须分别计量 cache read、未缓存 input 与 cache creation/write tokens。Cache creation/write tokens 不是免费命中；它们必须计入 miss/write 证据，避免 cache hit-rate 复盘静默丢失 provider 侧 prefix 创建成本。

Low provider cache is a framework/cache issue until diagnostics prove the stable prefix is healthy and misses are explainable as unavoidable cold start or bounded history tail. Whole-prompt dynamic keys are not acceptable when stable prefix sections are unchanged.

低 provider cache 在诊断证明稳定前缀健康且 miss 可解释为不可避免 cold start 或有界 history tail 之前，都属于框架/缓存问题。当稳定 prefix sections 未变化时，整段 prompt 动态 key 不可接受。

Provider adapters that speak an Anthropic-compatible protocol and support explicit prefix caching must carry context pipeline fingerprints into both provider requests and usage evidence. When the current task has a cacheable stable user prompt, that prompt is the single primary provider-native cache breakpoint; adapters must not also attach native breakpoints to the stable system prefix, visible tool schemas, or dynamic history tail in the same request. If no stable user task prompt is cacheable, adapters may fall back to a cacheable system prefix, visible tool schema, or bounded history-tail breakpoint according to provider constraints. If a provider reports explicit prefix hints as unsupported while the adapter can send them, treat that as a provider capability configuration bug, not model capability.

使用 Anthropic-compatible 协议且支持显式 prefix caching 的 provider adapter，必须把 context pipeline fingerprint 同时传入 provider request 与 usage evidence。当当前任务存在可缓存的稳定 user prompt 时，该 prompt 是唯一主 provider-native cache breakpoint；adapter 不得在同一 request 内再给稳定 system prefix、可见 tool schema 或动态 history tail 附加 native breakpoint。若没有可缓存的稳定 user task prompt，adapter 可以根据 provider 约束回退到可缓存 system prefix、可见 tool schema 或有界 history-tail breakpoint。如果 adapter 能发送 prefix hint 但 provider 报告 unsupported，应视为 provider capability 配置 bug，而不是模型能力问题。

Provider-facing cache evidence must be derived from the final prompt assembly message shape, not only from context projection. A no-store/current-turn context projection may have zero stable projection blocks while the assembled provider prompt still has a stable framework prefix. In that case the prompt assembly evidence must expose the stable provider prefix fingerprint and keep the original context projection cache summary separate.

面向 provider 的 cache evidence 必须来自最终 prompt assembly 的 message shape，而不能只来自 context projection。no-store/current-turn context projection 可以没有 stable projection block，但组装后的 provider prompt 仍可能有稳定的框架前缀。此时 prompt assembly evidence 必须暴露稳定 provider prefix fingerprint，并将原始 context projection cache summary 分开保留。

For Anthropic-compatible explicit prefix caching, the stable provider prefix includes contiguous stable system messages plus the current task's stable user prompt before dynamic assistant/tool history. Runtime task-delivery identifiers, session ids, turn ids, request ids, and plan ids may remain in provenance or trace evidence, but must not appear in model-visible stable prefix text.

对于 Anthropic-compatible 的显式 prefix caching，稳定 provider prefix 包括连续稳定 system messages，以及动态 assistant/tool history 之前的当前任务稳定 user prompt。runtime task-delivery identifiers、session id、turn id、request id 与 plan id 可以保留在 provenance 或 trace evidence 中，但不得出现在模型可见的稳定 prefix 文本里。

Anthropic-compatible adapters must also treat the stable visible tool schema set as cacheable provider input. A stable task-prompt breakpoint remains the primary cache breakpoint when available, so tool schemas must not receive a conflicting separate breakpoint in that shape. If no stable task prompt is cacheable, stable visible tool schemas should remain inside an explicit provider-native cache breakpoint when provider constraints allow it. If stable prompt replay, stable provider-prefix fingerprints, and a stable visible tool set still produce repeated low provider-cache hits, diagnostics must emit a stable tool-schema cache gap code before any model-owned attribution.

Anthropic-compatible adapter 还必须把稳定的可见 tool schema 集合作为可缓存 provider 输入处理。当稳定 task-prompt breakpoint 可用时，它仍是主 cache breakpoint，因此 tool schema 在该形态下不得再获得冲突的独立 breakpoint。若没有可缓存的稳定 task prompt，在 provider 约束允许时，稳定可见 tool schema 应保留在显式 provider-native cache breakpoint 内。如果 stable prompt replay、stable provider-prefix fingerprint 与稳定可见 tool set 同时存在，但 provider cache 仍反复低命中，diagnostics 必须先输出稳定的 tool-schema cache gap code，再考虑任何模型侧归因。

Stable provider-prefix evidence must include coverage, not only fingerprint stability. A stable prefix with too little token coverage over the growing provider request must be classified as provider-prefix coverage low and treated as cache/process work, not as model capability.

稳定 provider-prefix 证据必须包含覆盖率，而不只是 fingerprint 稳定。稳定 prefix 相对于不断增长的 provider request token 覆盖太低时，必须归类为 provider-prefix coverage low，并视为缓存/流程工作，而不是模型能力。

Whole-prompt fingerprint churn is not, by itself, proof that the stable provider prefix is broken. When stable replay/provider-prefix evidence exists and low cache hits are already explained by history tail, dynamic tail, or post-gate unbounded history diagnostics, whole-prompt churn must not remain an actionable reason code. The actionable diagnosis should name the dynamic tail shape that can be fixed.

whole-prompt fingerprint 抖动本身不能证明稳定 provider prefix 坏了。当 stable replay/provider-prefix 证据存在，且低缓存命中已经由 history tail、dynamic tail 或 post-gate unbounded history diagnostics 解释时，whole-prompt churn 不得继续作为可执行 reason code。可执行诊断应命名可修复的动态尾部形态。

## Reproduction And Repair Feedback

Each SWE-style attempt must derive the smallest reproduction from the problem statement, "How to Reproduce", expected behavior, or failing test description before trusting public local tests. If a reproduction cannot run, the trace records why. Passing public tests alone is not enough when official hidden tests fail.

每次 SWE 类 attempt 必须先从 problem statement、"How to Reproduce"、expected behavior 或 failing test description 推导最小复现，再信任公开本地测试。如果复现无法运行，trace 必须记录原因。公开测试通过但 official hidden tests 失败时，不能只凭公开测试通过判断完成。

Verification must follow a low-cost ladder. The child should run the cheapest standard command that can falsify the patch first: problem reproduction or changed-file focused test, then affected module/package subset, and only then broad public suites if focused evidence is inconclusive and request budget remains. Once a focused standard test passes, broad scoring belongs to the supervisor harness unless repair feedback requires another focused check.

验证必须遵循低成本阶梯。child 应先运行能最便宜 falsify patch 的标准命令：problem reproduction 或 changed-file focused test，其次是受影响 module/package 子集；只有 focused evidence 不确定且 request budget 仍可用时，才运行广泛公开套件。一旦 focused standard test 通过，广泛评分交给 supervisor harness，除非 repair feedback 要求另一个 focused check。

Standard-test command recognition is shared runtime evidence, not per-component string matching. Runtime gates, core tool feedback, and offline child-trace diagnostics must use the same ecosystem classifier, including cross-platform shell payload normalization for POSIX/WSL shells, PowerShell, cmd, and Windows-style paths.

标准测试命令识别是共享 runtime evidence，不是各组件各自匹配字符串。runtime gate、core tool feedback 与离线 child-trace diagnostics 必须使用同一套生态分类器，并包含 POSIX/WSL shell、PowerShell、cmd 与 Windows 风格路径的跨平台 shell payload 规范化。

Repair attempts must receive bounded official harness excerpts: failing test id, assertion/exception line, and nearby stack/source context when available. The excerpt is generic harness feedback, not a hidden solution hint.

Repair attempt 必须收到有界 official harness excerpt：failing test id、assertion/exception line，以及可用时的附近 stack/source context。该 excerpt 是通用 harness feedback，不是隐藏解法提示。

User-level SWE-bench Lite numbered task requests must route into the governed `core.swe.bench.run` terminal capability before spending repeated read/search/memory tool calls. If the outer agent repeatedly avoids the run capability, the runtime must emit a stable routing gate and force the next action back to the governed run capability or a bounded blocker.

用户级 SWE-bench Lite 编号任务请求必须先路由到受管 `core.swe.bench.run` 终端 capability，而不是反复消耗 read/search/memory 工具调用。如果外层 agent 持续绕开 run capability，runtime 必须发出稳定 routing gate，并把下一步限制为受管 run capability 或有界 blocker。

Model-provided run arguments are evidence to preflight, not higher-priority intent than the user prompt. For live SWE-bench completion prompts, a model-supplied `dryRun: true` must not suppress execution unless the user explicitly asked for dry-run, preview, review-only, or resume-only behavior. This normalization is a generic intent repair from prompt semantics and must not branch on repository, instance, task number, or expected patch.

模型提供的运行参数是 preflight 证据，不比用户 prompt 的意图优先。对于要求完成/跑通的 live SWE-bench prompt，模型传入的 `dryRun: true` 不得抑制执行，除非用户明确要求 dry-run、预览、review-only 或 resume-only 行为。这个规范化是根据 prompt 语义做的通用 intent repair，不得基于 repository、instance、task number 或 expected patch 分支。

Source mutation progress is only valid after a write-capable tool reports a successful material change. A model-authored edit intent, a policy-denied write, or an exact edit whose replacement leaves the file unchanged is not source progress and must not unlock post-edit verification or environment gates.

source mutation progress 只能来自写入类工具报告成功且产生实际内容变化之后。模型发出 edit intent、被 policy 拒绝的写入，或 replacement 后文件内容不变的 exact edit，都不算 source progress，也不得解锁 post-edit verification 或 environment gate。

Source-inspection gate feedback is a recovery affordance, not an unlimited retry loop. The child loop may show one corrective rejection after the gate so a model can switch to edit, test, or bounded blocker reporting. If it repeats rejected read-location or non-test setup actions after that feedback, the framework should stop with source-inspection defiance before the generic request budget is consumed. This preserves autonomy for models that recover while preventing a stuck child run from spending the remaining budget on forbidden exploration.

source-inspection gate 的反馈是恢复机会，不是无限重试循环。child loop 可以在 gate 后给出一次纠偏拒绝反馈，让模型切换到编辑、测试或有界 blocker 报告；如果模型在该反馈后继续重复被拒绝的读定位或非测试 setup 行为，框架应在泛化请求预算耗尽前以 source-inspection defiance 终止。这样既保留能纠偏模型的自主空间，也避免卡住的 child run 把剩余预算继续花在禁止的探索上。

Provider-facing history compaction must not make source-inspection recovery impossible. When the latest retained tool result is a source-inspection gate or duplicate-evidence rejection that tells the child to reuse existing source evidence, the bounded provider tail should also retain one recent successful source-inspection tool pair. This keeps the useful evidence visible while preserving a small dynamic tail for provider cache reuse.

provider-facing history 压缩不能让 source-inspection 恢复变得不可能。当最新保留的工具结果是 source-inspection gate 或 duplicate-evidence rejection，并要求 child 复用已有源码证据时，有界 provider tail 也应保留一组最近成功的 source-inspection 工具 pair。这样既让有用证据继续可见，也保持较小动态尾部以利于 provider cache 复用。

Repeated source-inspection signatures are a separate early-loop signal. If the child asks for the same bounded source read window, a bounded same-path window whose content is mostly covered by a very recent completed window, or the same text-search query again before any source edit or test progress, the runtime should reject that duplicate evidence and tell the model to reuse the already captured evidence for edit, test, or bounded blocker reporting. After that duplicate-evidence gate is inserted, further read-location exploration should also be rejected until source edit, standard test, or bounded blocker progress exists, because otherwise the model can evade the gate by alternating nearby reads with new searches. This is generic evidence de-duplication, not a task-specific source rule.

重复的 source-inspection signature 是独立的早期循环信号。如果 child 在任何 source edit 或 test 进展之前，再次请求相同的有界源码读取窗口、内容主要已被最近成功完成的同路径有界窗口覆盖的读取窗口，或相同的文本搜索查询，runtime 应拒绝这类重复证据，并要求模型复用已捕获的证据进入 edit、test 或有界 blocker 报告。duplicate-evidence gate 插入后，后续读定位探索也应被拒绝，直到出现源码编辑、标准测试或有界 blocker 进展；否则模型可以通过交替附近读取与新搜索来绕开 gate。这是通用 evidence 去重，不是针对某个题目的源码规则。

## Anti-Tailoring Rule

Production behavior must not branch on benchmark repo names, instance ids, task numbers, or known expected patches. Environment and compatibility behavior must be selected from repository metadata, declared dependency constraints, available interpreter capabilities, and observed generic process failures.

生产行为不得基于 benchmark repo name、instance id、task number 或已知 expected patch 分支。环境与兼容性行为必须来自 repository metadata、声明的 dependency constraints、可用 interpreter capabilities 与观察到的通用 process failure。

Container-style checkout aliases such as `/home/user` are execution-environment conventions, not task hints. Governed checkout command normalization may rewrite those aliases to the active run-scoped checkout root when the command is already scoped to that checkout, but it must not use repository name, task number, instance id, or expected patch content to select the rewrite.

`/home/user` 等容器式 checkout alias 是执行环境约定，不是题目提示。当命令已经限定在当前 run-scoped checkout 内时，治理 checkout command normalization 可以把这些 alias 改写到当前活动 checkout root，但不得使用 repository name、task number、instance id 或 expected patch content 来选择改写。

Python test setup failures caused by missing checkout-local modules, incompatible dependency APIs, missing runner entrypoints, or unsupported runner arguments must be classified before model-owned attribution. Missing or incompatible test dependencies are environment-fix work; missing runner files or unsupported runner flags are verification-command work unless separate evidence shows a deeper environment blocker.

由缺失 checkout-local module、不兼容 dependency API、缺失 runner entrypoint 或不支持的 runner argument 导致的 Python test setup failure，必须先于模型侧归因进行分类。缺失或不兼容测试依赖属于 environment-fix；缺失 runner 文件或不支持 runner 参数属于 verification-command work，除非另有证据显示更深层环境阻塞。

If a missing external Python test launcher/framework failure includes structured evidence for a repo-local alternate Python runner, such as `alternateCommand` and `alternateRunnerPath`, the primary action is verification-command selection rather than dependency installation. Diagnostics should keep the underlying missing dependency code as supporting evidence, but the primary reason should point to the reusable runner workflow fix. Model-visible feedback and structured next-action metadata must expose a single primary next action and must not keep a conflicting dependency-install command when the runner action is available.

如果缺失的是外部 Python 测试 launcher/framework，且失败证据里包含 repo-local alternate Python runner 的结构化信息，例如 `alternateCommand` 与 `alternateRunnerPath`，主要行动应是修正验证命令选择，而不是安装依赖。诊断可以保留底层缺失依赖 code 作为辅助证据，但 primary reason 应指向可复用的 runner workflow 修复。模型可见反馈与结构化 next-action metadata 必须暴露单一主下一步；当 runner action 可用时，不得继续保留与之冲突的依赖安装命令。

Runtime orchestration must also consume that structured alternate-runner evidence. Before treating continued setup probing as an environment blocker, the child loop should insert a bounded workflow gate that asks the model to try the repo-local runner once, and should reject repeated dependency setup or non-runner test retries while that routed action is pending. This is a generic evidence-to-action transition, not a benchmark repository branch.

runtime 编排也必须消费这些结构化 alternate-runner evidence。在把后续 setup probing 当成环境阻断之前，child loop 应插入一个有界 workflow gate，要求模型先尝试一次 repo-local runner；在该 routed action 待处理时，应拒绝重复依赖安装或非 runner 测试重试。这是通用 evidence-to-action 转换，不是 benchmark repository 分支。

Resume-only review may recover that alternate-runner evidence for legacy missing test-launcher traces by reading generic runner files from the run-scoped checkout (`repo/tests/runtests.py` or `repo/runtests.py`). This is evidence enrichment from the preserved workspace, not benchmark tailoring.

resume-only 复盘可以通过读取 run-scoped checkout 中的通用 runner 文件（`repo/tests/runtests.py` 或 `repo/runtests.py`）为旧的缺失 test-launcher trace 恢复 alternate-runner evidence。这是来自保留 workspace 的证据补全，不是 benchmark 定制。

CLI profile workflows are roles over composable capabilities. The selected profile metadata must be compilable into a replayable staged-task graph with stage refs, dependencies, executor kinds, allowed capability ids, and run-state evidence. It must also declare primary workflow priority and the staged-capability orchestration mode so prompt assembly and diagnostics treat it as the main route instead of advisory prose. This compiled graph is evidence and orchestration contract data; it must not become a deep class hierarchy, a benchmark-specific subclass, or a command script that bypasses the capability registry.

CLI profile workflow 是可组合能力之上的角色。所选 profile metadata 必须能编译成可 replay 的 staged-task graph，包含 stage refs、dependencies、executor kinds、allowed capability ids 与 run-state evidence。它还必须声明 primary workflow priority 与 staged-capability orchestration mode，使 prompt assembly 与 diagnostics 把它当作主路线，而不是建议性散文。这个编译后的 graph 是证据与编排契约数据；不得演变成深层 class hierarchy、benchmark-specific subclass，或绕过 capability registry 的命令脚本。

For user-level SWE-bench requests, the outer CLI evaluation profile should be a dispatch workflow whose ready stage is the governed `core.swe.bench.run` capability. Repository source inspection, source editing, focused tests, and patch review belong to the managed child run profile created by that capability. Keeping those as separate parent/child workflow roles prevents the outer loop from spending requests on source work before binding the run-scoped checkout, while still preserving a lightweight staged workflow for the child solver.

对于用户级 SWE-bench 请求，外层 CLI evaluation profile 应是派发工作流，ready stage 指向受管 `core.swe.bench.run` capability。仓库源码检查、源码编辑、focused tests 与 patch review 属于该 capability 创建的 managed child run profile。把父/子 workflow role 分开，可以避免外层 loop 在绑定 run-scoped checkout 之前消耗请求做源码工作，同时仍为 child solver 保留轻量 staged workflow。

Runtime orchestration should consume that contract in small, evidence-safe steps. The first hard control is a primary workflow capability boundary for governed/evaluation profiles: model tool calls outside the profile workflow capability ids or compiled staged-task allowed tools are rejected before kernel execution with typed feedback. Strict stage ordering remains deferred until a generic exit-criteria evidence evaluator exists, because treating the static initial run state as permanent would deadlock valid runs instead of improving autonomy.

runtime 编排应以小步、安全证据方式消费该契约。第一层硬控制是 governed/evaluation profile 的 primary workflow capability boundary：模型调用不在 profile workflow capability ids 或编译后 staged-task allowed tools 内的工具时，在 kernel execution 前用 typed feedback 拒绝。严格 stage ordering 暂缓到通用 exit-criteria evidence evaluator 存在之后再启用，因为把静态初始 run state 当成永久状态会卡死合法运行，而不是提升自主能力。

The next orchestration control is evidence-driven stage progress. When a successful governed tool result matches a ready staged-task allowed capability and satisfies the stage kind's completion-grade evidence requirement, runtime advances the staged-task run state, emits replayable workflow step events, and carries the updated run state into the next prompt/model-request metadata. Allowed capabilities remain the stage boundary, not a proof that every allowed tool completes the stage: read/search/list evidence may support a source-change stage, but mutation-grade evidence must complete it. Prompt assembly must expose that current run state to the model as dynamic workflow state, while keeping the static workflow definition in the stable provider prefix. This makes orchestration stronger without making the CLI a heavyweight workflow engine.

下一层编排控制是基于证据的阶段推进。当成功的受管工具结果匹配 ready staged-task 允许的 capability，且满足该 stage kind 的 completion-grade evidence 要求时，runtime 推进 staged-task run state，发出可 replay 的 workflow step events，并把更新后的 run state 带入下一轮 prompt/model-request metadata。允许的 capability 是阶段边界，不是每个允许工具都能完成阶段的证明：read/search/list evidence 可以支撑源码变更阶段，但必须由 mutation-grade evidence 完成它。prompt assembly 必须把当前 run state 作为动态 workflow state 暴露给模型，同时把静态 workflow definition 保留在稳定 provider prefix 中。这样增强编排能力，但不会把 CLI 变成重型 workflow engine。

Prompt assembly should add a deterministic task-intent contract between profile selection and workflow execution. The contract is stable task metadata derived from the user prompt boundary, selected profile role, workflow graph, and capability registry visibility; it must not call another model, include session/turn ids, include stage run state, or branch on benchmark repo names, task numbers, instance ids, expected patches, or known solutions. The contract belongs in the stable provider prefix so the model repeatedly sees the same intent route without increasing dynamic tail churn. Dynamic ready-stage state remains outside that prefix and must translate the current stage into a primary next-action cue: for a ready produce/repair stage after understand has succeeded, read/search/list-only exploration is supporting evidence, not completion; the primary move is mutation-grade edit/patch/write, a standard test action when verifying, or a bounded blocker.

Prompt assembly 应在 profile selection 与 workflow execution 之间增加确定性的 task-intent contract。该 contract 是由用户 prompt 边界、已选 profile role、workflow graph 与 capability registry 可见性推导出的稳定任务元数据；不得再调用一个模型，不得包含 session/turn id，不得包含阶段 run state，也不得基于 benchmark repo name、task number、instance id、expected patch 或已知解法分支。该 contract 属于稳定 provider prefix，使模型在多轮中持续看到同一条意图路线，同时不增加动态尾部抖动。动态 ready-stage state 仍保留在该 prefix 之外，并必须把当前阶段翻译成主下一步提示：当 understand 已 succeeded 且 produce/repair stage ready 时，read/search/list-only exploration 只是辅助证据，不是完成条件；主动作应是 mutation-grade edit/patch/write，验证阶段则是标准测试动作，或报告有界 blocker。

Recovered Python setup failures are historical evidence, not current blockers. If a later model-authored standard test command succeeds, refreshed diagnostics must remove the earlier setup failure and environment blocker gate from current reason codes; unresolved official scoring should then be reviewed as cache, verification-oracle, repair-feedback, or official-unresolved evidence unless a newer setup failure occurs after the successful test.

已恢复的 Python setup failure 是历史证据，不是当前 blocker。如果后续模型发起的标准测试命令成功，刷新 diagnostics 时必须从当前 reason codes 中移除更早的 setup failure 与 environment blocker gate；此后 official scoring 仍 unresolved 时，应按 cache、verification-oracle、repair-feedback 或 official-unresolved 证据复盘，除非成功测试之后又出现新的 setup failure。

Resume-only refresh must treat child-trace setup and gate diagnostics as recomputable evidence. Historical summary diagnostics are kept only if the preserved trace recomputes them again; otherwise the persisted summary, review codes, reason codes, and blocker ids must drop the stale setup attribution.

resume-only refresh 必须把 child-trace setup 与 gate diagnostics 视为可重算证据。历史 summary diagnostics 只有在保留 trace 重新计算后仍支持时才能保留；否则持久化 summary、review codes、reason codes 与 blocker ids 都必须移除过期 setup 归因。

## Allowed Next Moves

Until gates pass, allowed actions are:

1. Review and reclassify existing task 2-10 evidence.
2. Add test-first framework diagnostics and repair-feedback improvements.
3. Run a single canary for a previously failed task after a framework fix.
4. Refresh existing batch evidence in resume-only mode.

在门槛通过前，允许动作是：

1. 复盘并重新归类第 2-10 题既有证据。
2. 用 test-first 方式增加框架诊断与 repair-feedback 改进。
3. 框架修复后对一个历史失败题跑单题 canary。
4. 用 resume-only 模式刷新既有 batch 证据。
