# cli-task-completion-evaluation Specification

## Purpose
Define CLI task completion evaluation requirements for measuring task outcomes, evidence quality, correction behavior, and delivery capability.

定义 CLI task completion evaluation 对任务结果、evidence quality、correction behavior 与交付能力衡量的要求。
## Requirements
### Requirement: CLI Evaluation Defines Repeatable Task Completion Protocol / CLI 评估定义可重复任务完成协议

The system SHALL define a repeatable CLI task-completion evaluation protocol that runs each baseline against the same task prompt, repository snapshot, allowed capabilities, resource limits, checks, scoring rubric, instrumentation event schema, and baseline comparison metrics.

系统必须定义可重复的 CLI task-completion evaluation protocol，让每个 baseline 在相同 task prompt、repository snapshot、allowed capabilities、resource limits、checks、scoring rubric、instrumentation event schema 与 baseline comparison metrics 下运行。

#### Scenario: Same task constraints across baselines / Baseline 使用相同任务约束

- **WHEN** an evaluation task is selected for DeepSeek CLI, Claude Code, Codex, or another baseline
- **THEN** the evaluation record includes the same task id, fixture id, prompt digest, workspace snapshot id, allowed capability profile, time budget, check commands, scoring rubric id, instrumentation event schema, and metric schema for every baseline run
- **中文** 当一个 evaluation task 被用于 DeepSeek CLI、Claude Code、Codex 或其他 baseline 时，evaluation record 必须为每个 baseline run 记录相同 task id、fixture id、prompt digest、workspace snapshot id、allowed capability profile、time budget、check commands、scoring rubric id、instrumentation event schema 与 metric schema。

### Requirement: CLI Evaluation Scores Outcomes And Product Mechanics / CLI 评估同时评分结果与产品机制

The system SHALL score task completion outcomes and product operating quality using structured records rather than a single unqualified win/loss value.

系统必须用结构化 records 同时评分 task completion outcomes 与 product operating quality，而不是只给一个未限定的胜负值。

#### Scenario: Run summary records completion and diagnostics / Run Summary 记录完成度与诊断

- **WHEN** a baseline finishes an evaluation task
- **THEN** the run summary records outcome as `solved`, `partial`, `failed`, or `invalid`, plus instrumentation events, check results, patch metadata, elapsed time, retries, user interventions, safety violations, first-run success, command success rate, check pass rate, correction count, command failure count, generated artifact structure metrics, context recall evidence, recovery/revert usage, cost estimate when available, diagnostics, and redaction metadata
- **中文** 当一个 baseline 完成 evaluation task 后，run summary 必须记录 `solved`、`partial`、`failed` 或 `invalid`，并包含 instrumentation events、check results、patch metadata、elapsed time、retries、user interventions、safety violations、首轮成功、命令成功率、check pass rate、纠错次数、命令失败次数、生成产物结构指标、context recall evidence、recovery/revert usage、可用时的 cost estimate、diagnostics 与 redaction metadata。

### Requirement: CLI Evaluation Separates Public Benchmarks From Product Evidence / CLI 评估区分公开榜单与产品证据

The system SHALL treat public benchmark references as advisory context and SHALL require DeepSeek-owned evaluation evidence for CLI competitive or release-readiness claims.

系统必须把 public benchmark references 作为参考上下文，并要求 CLI 竞争力或 release-readiness 声明具备 DeepSeek-owned evaluation evidence。

#### Scenario: Competitive report cites owned evidence / 竞争力报告引用自有证据

- **WHEN** a report compares DeepSeek CLI against Claude Code, Codex, or another named competitor
- **THEN** the report includes DeepSeek-owned task run evidence ids, report timestamp, task catalog version, baseline versions or unavailable status, and any public benchmark references in a separate advisory section
- **中文** 当报告将 DeepSeek CLI 与 Claude Code、Codex 或其他具名竞品对比时，报告必须包含 DeepSeek-owned task run evidence ids、report timestamp、task catalog version、baseline versions 或 unavailable status，并把 public benchmark references 放在独立 advisory section。

### Requirement: CLI Evaluation External Baselines Are Opt-In / CLI 评估外部 Baseline 默认 Opt-In

The system SHALL not invoke external proprietary CLIs or live providers unless a maintainer explicitly configures the executable, credentials, allowed scope, evaluation mode, and task execution request.

系统不得调用外部专有 CLI 或 live providers，除非维护者显式配置 executable、credentials、allowed scope、evaluation mode 与 task execution request。

#### Scenario: Unconfigured external baseline is deferred / 未配置外部 Baseline 被延后

- **WHEN** an evaluation includes Claude Code, Codex, or another external baseline without a configured adapter
- **THEN** the runner records that baseline as `deferred` or `unavailable`, emits typed diagnostics, and continues deterministic DeepSeek CLI evaluation without executing the external command
- **中文** 当 evaluation 包含 Claude Code、Codex 或其他 external baseline 但没有 configured adapter 时，runner 必须把该 baseline 记录为 `deferred` 或 `unavailable`，发出 typed diagnostics，并在不执行外部命令的情况下继续 deterministic DeepSeek CLI evaluation。

#### Scenario: Configured external baseline is not enough for task execution / 仅配置 External Baseline 不足以执行任务

- **WHEN** an external baseline command is configured without `--execute-task`
- **THEN** the runner may probe the baseline, but it records selected task runs as `planned` and does not send task prompts
- **中文** 当 external baseline command 已配置但没有 `--execute-task` 时，runner 可以 probe baseline，但必须把 selected task runs 记录为 `planned`，且不得发送 task prompt。

### Requirement: CLI Evaluation Evidence Is Redacted And Replayable / CLI 评估证据脱敏且可回放

The system SHALL write evaluation summaries and per-task records as redacted, machine-readable evidence that can be replayed or compared over time.

系统必须把 evaluation summaries 与 per-task records 写成脱敏、机器可读、可回放并可跨时间对比的 evidence。

#### Scenario: Evaluation writes local evidence artifacts / Evaluation 写入本地证据产物

- **WHEN** an evaluation run completes
- **THEN** it writes a JSON summary, JSONL task records, bounded sanitized output snippets, patch metadata, and check outputs under stable local evidence paths, without ANSI cursor state, raw secrets, or unbounded transcripts
- **中文** 当 evaluation run 完成时，它必须在稳定本地 evidence paths 下写入 JSON summary、JSONL task records、有界脱敏输出片段、patch metadata 与 check outputs，且不得包含 ANSI cursor state、raw secrets 或 unbounded transcripts。

#### Scenario: Overall score evidence records provider invocation / 总分证据记录 Provider 调用

- **WHEN** `deepseek diagnostics evaluate --full --execute-task all --live --provider glm --model glm-5.1 --output json` writes `tests/acceptance/latest/overall-delivery-capability-score.json`
- **THEN** the evidence includes a redacted invocation record with `provider=glm`, `model=glm-5.1`, `live=true`, selected baselines, and a reproducible command string containing the provider/model flags
- **AND** the evidence does not include raw credential values
- **中文** 当 `deepseek diagnostics evaluate --full --execute-task all --live --provider glm --model glm-5.1 --output json` 写入 `tests/acceptance/latest/overall-delivery-capability-score.json` 时，证据必须包含脱敏 invocation record，记录 `provider=glm`、`model=glm-5.1`、`live=true`、已选择 baselines，以及包含 provider/model flags 的可复现 command string；同时证据不得包含 raw credential values。

### Requirement: CLI Evaluation Can Probe Explicit External Baselines / CLI 评估可探测显式外部 Baseline

CLI evaluation SHALL allow a maintainer to explicitly configure an external baseline command for probe-only evaluation planning while keeping the default unconfigured path deferred.

CLI evaluation 必须允许维护者显式配置 external baseline command，用于仅探测的 evaluation planning，同时默认未配置路径保持 deferred。

#### Scenario: Codex baseline remains deferred without explicit allow / 未显式允许时 Codex 保持 Deferred

- **WHEN** `deepseek diagnostics evaluate --baseline codex` runs without `--allow-external-baseline` or without `--baseline-command`
- **THEN** the runner records the Codex baseline as `deferred`, emits typed diagnostics, and does not execute any external command
- **中文** 当 `deepseek diagnostics evaluate --baseline codex` 运行但没有 `--allow-external-baseline` 或没有 `--baseline-command` 时，runner 必须把 Codex baseline 记录为 `deferred`，发出 typed diagnostics，且不执行任何外部命令。

#### Scenario: Codex baseline probe is configured explicitly / Codex Baseline Probe 被显式配置

- **WHEN** `deepseek diagnostics evaluate --baseline codex --allow-external-baseline --baseline-command <cmd>` runs
- **THEN** the runner probes `<cmd>` through argv process execution with `shell: false`, records configured baseline metadata, bounded probe output, exit code, diagnostics, and planned task-run records without sending task prompts or mutating the workspace
- **中文** 当 `deepseek diagnostics evaluate --baseline codex --allow-external-baseline --baseline-command <cmd>` 运行时，runner 必须通过 argv process execution 与 `shell: false` 探测 `<cmd>`，记录 configured baseline metadata、有界 probe output、exit code、diagnostics 与 planned task-run records，且不得发送 task prompts 或修改 workspace。

#### Scenario: Failed external probe is evidence, not a crash / 外部 Probe 失败记录为证据而不是崩溃

- **WHEN** a configured external baseline probe exits nonzero or cannot spawn
- **THEN** the runner records the baseline as `unavailable`, emits typed diagnostics with redacted metadata, and continues rendering the evaluation summary
- **中文** 当已配置 external baseline probe 非零退出或无法启动时，runner 必须把 baseline 记录为 `unavailable`，发出带脱敏 metadata 的 typed diagnostics，并继续渲染 evaluation summary。

### Requirement: CLI Evaluation Includes Webpage Generation Task / CLI 评估包含网页生成任务

CLI task-completion evaluation SHALL include a deterministic webpage-generation task with local artifact validation and SHALL allow DeepSeek-owned live execution only when explicitly requested.

CLI task-completion evaluation 必须包含带本地产物校验的 deterministic webpage-generation task，并且只有在显式请求时才允许 DeepSeek 自有 live execution。

#### Scenario: DeepSeek live webpage execution is opt-in / DeepSeek Live 网页执行显式开启

- **WHEN** `deepseek diagnostics evaluate --live --full --execute-task eval.webpage.generation --compare-baseline deepseek-cli` runs with live credentials available
- **THEN** the DeepSeek baseline command uses the live provider path, receives the webpage task prompt in an isolated workspace, exposes write-capable local file tools for the task profile, and the checker evaluates `generated-webpage`
- **中文** 当带可用 live credentials 运行 `deepseek diagnostics evaluate --live --full --execute-task eval.webpage.generation --compare-baseline deepseek-cli` 时，DeepSeek baseline command 必须使用 live provider path，在隔离 workspace 中接收网页任务 prompt，为该任务 profile 暴露可写本地文件工具，并由 checker 校验 `generated-webpage`。

#### Scenario: Non-live evaluation remains deterministic / 非 Live 评估保持确定性

- **WHEN** `deepseek diagnostics evaluate --full --execute-task eval.webpage.generation --compare-baseline deepseek-cli` runs without `--live`
- **THEN** the DeepSeek baseline does not call the live provider and records the deterministic outcome and diagnostics without requiring credentials
- **中文** 当未带 `--live` 运行 `deepseek diagnostics evaluate --full --execute-task eval.webpage.generation --compare-baseline deepseek-cli` 时，DeepSeek baseline 不得调用 live provider，必须记录 deterministic outcome 与 diagnostics，且不要求 credentials。

#### Scenario: Checker gates live success / Checker 决定 Live 成功

- **WHEN** the live DeepSeek model returns text but does not create valid local webpage artifacts
- **THEN** the task run is not marked solved; success requires the generated local HTML/CSS/JS artifacts to pass the webpage checker
- **中文** 当 live DeepSeek 模型返回文本但没有创建有效本地网页产物时，task run 不得标记为 solved；成功必须要求生成的本地 HTML/CSS/JS 产物通过 webpage checker。

#### Scenario: Live evaluation forwards GLM provider selection / Live Evaluation 透传 GLM Provider 选择

- **WHEN** `deepseek diagnostics evaluate --live --full --execute-task eval.webpage.generation --compare-baseline deepseek-cli --provider glm --model glm-5.1` runs with GLM credentials available
- **THEN** the isolated `deepseek run` subprocess receives `--provider glm --model glm-5.1`, uses the live path, and receives only redacted/presence-safe credential evidence in diagnostics output
- **中文** 当带可用 GLM credentials 运行 `deepseek diagnostics evaluate --live --full --execute-task eval.webpage.generation --compare-baseline deepseek-cli --provider glm --model glm-5.1` 时，隔离的 `deepseek run` 子进程必须收到 `--provider glm --model glm-5.1`，使用 live path，并且 diagnostics output 只包含脱敏或 presence-safe 的 credential evidence。

#### Scenario: GLM expanded webpage tasks receive a larger provider budget / GLM expanded webpage tasks 获得更大 provider budget

- **WHEN** a live CLI run selects provider `glm` for a prompt containing webpage/html evaluation task markers
- **THEN** the resolved model profile includes a larger Anthropic `max_tokens` provider option
- **AND** the one-shot agent-loop limits are widened for model iterations, tool calls, and output bytes
- **AND** simple non-webpage prompts keep the default GLM provider options
- **中文** 当 live CLI run 为包含 webpage/html evaluation task 标记的 prompt 选择 `glm` provider 时，resolved model profile 必须包含更大的 Anthropic `max_tokens` provider option；one-shot agent-loop limits 必须放宽 model iterations、tool calls 与 output bytes；普通非网页 prompt 必须保持默认 GLM provider options。

#### Scenario: Webpage final answer stays artifact-neutral / 网页最终回复保持 artifact-neutral

- **WHEN** a webpage evaluation prompt is assembled
- **THEN** it instructs the agent to write evidence into `generated-webpage/evidence.json`
- **AND** it constrains the final assistant answer to the fixed short sentence `generated-webpage complete`
- **AND** it forbids product-copy, package-name, executable-name, command, file-table, markdown-bullet, and verification-detail recaps in the final answer
- **中文** 当 webpage evaluation prompt 被组装时，它必须要求 agent 将 evidence 写入 `generated-webpage/evidence.json`；并将最终 assistant answer 约束为固定短句 `generated-webpage complete`；同时禁止在 final answer 中复述 product-copy、package-name、executable-name、command、file-table、markdown-bullet 与 verification-detail。

#### Scenario: Evaluation task can be represented as a staged graph / Evaluation Task 可表示为 Stage Graph

- **WHEN** CLI evaluation prepares an executable task profile such as `eval.webpage.generation`
- **THEN** it can build a domain-neutral staged graph with materialization, agent execution, checker, artifact scan, and scoring stages
- **AND** the evaluation controller consumes staged run records rather than embedding task-specific execution order in the controller
- **中文** 当 CLI evaluation 准备 `eval.webpage.generation` 等 executable task profile 时，它可以构建包含 materialization、agent execution、checker、artifact scan 与 scoring stages 的领域中立 staged graph；evaluation controller 必须消费 staged run records，而不是在 controller 中嵌入 task-specific execution order。

#### Scenario: Evaluation run records expose staged snapshots / Evaluation Run 记录暴露 Stage Snapshot

- **WHEN** CLI evaluation reports a task run that has a staged profile
- **THEN** the task run includes a redacted staged task snapshot with profile id, graph id, profile fingerprint, graph, initial run state, stage count, ref count, and executor kinds
- **AND** planned dry-runs and executed runs use the same snapshot shape without changing the existing command execution behavior
- **中文** 当 CLI evaluation 输出带 staged profile 的 task run 时，task run 必须包含 redacted staged task snapshot，其中包括 profile id、graph id、profile fingerprint、graph、initial run state、stage count、ref count 与 executor kinds；planned dry-run 与 executed runs 使用相同 snapshot 形态，且不改变现有命令执行行为。

### Requirement: CLI Evaluation Records Prompt Assembly Evidence / CLI 评估记录 Prompt Assembly 证据

CLI task-completion evaluation SHALL record prompt assembly evidence for DeepSeek CLI runs so task outcomes can be correlated with prompt structure, context inclusion, tool projection, and provider readiness.

CLI task-completion evaluation 必须为 DeepSeek CLI runs 记录 prompt assembly evidence，使 task outcomes 可以与 prompt structure、context inclusion、tool projection 与 provider readiness 关联。

#### Scenario: DeepSeek run includes assembly metrics / DeepSeek Run 包含 Assembly 指标
- **WHEN** an evaluation executes a DeepSeek CLI task through the runtime event stream
- **THEN** the task record includes prompt assembly fingerprint, section counts, excluded section counts, budget status, visible tool count, tool projection policy, and redacted diagnostics when `prompt.assembled` evidence is available
- **中文** 当 evaluation 通过 runtime event stream 执行 DeepSeek CLI task 时，如果存在 `prompt.assembled` evidence，task record 必须包含 prompt assembly fingerprint、section counts、excluded section counts、budget status、visible tool count、tool projection policy 与 redacted diagnostics。

#### Scenario: Missing assembly evidence is diagnostic / 缺少 Assembly 证据是诊断项
- **WHEN** a DeepSeek CLI evaluation task reaches model dispatch or task completion without prompt assembly evidence
- **THEN** the evaluation records a typed diagnostic instead of silently treating prompt assembly as unknown
- **中文** 当 DeepSeek CLI evaluation task 到达 model dispatch 或 task completion 但没有 prompt assembly evidence 时，evaluation 必须记录 typed diagnostic，而不是静默将 prompt assembly 视为 unknown。

### Requirement: CLI Evaluation Uses Assembly Evidence For Gap Analysis / CLI 评估用 Assembly 证据分析差距

CLI evaluation SHALL use prompt assembly evidence to identify product gaps separately from model capability gaps.

CLI evaluation 必须使用 prompt assembly evidence 区分产品机制差距与模型能力差距。

#### Scenario: Webpage generation failure distinguishes product gap / 网页生成失败区分产品差距
- **WHEN** DeepSeek CLI fails the webpage generation task
- **THEN** the evaluation can report whether the run lacked write-capable tool visibility, lacked output contract sections, dropped relevant context, failed provider readiness, or failed after a complete prompt/tool plan was assembled
- **中文** 当 DeepSeek CLI 未通过 webpage generation task 时，evaluation 必须能报告该 run 是缺少 write-capable tool visibility、缺少 output contract sections、丢弃相关 context、provider readiness 失败，还是在完整 prompt/tool plan 已组装后仍失败。

#### Scenario: Comparison reports assembly readiness / 对比报告 Assembly Readiness
- **WHEN** a comparison summary includes DeepSeek CLI, Claude, Codex, or future baselines
- **THEN** DeepSeek-owned records include prompt assembly readiness metrics separately from external baseline outcome metrics, because external CLIs may not expose equivalent assembly traces
- **中文** 当 comparison summary 包含 DeepSeek CLI、Claude、Codex 或未来 baselines 时，DeepSeek 自有 records 必须将 prompt assembly readiness metrics 与 external baseline outcome metrics 分开记录，因为 external CLIs 可能不暴露等价 assembly traces。

### Requirement: CLI Evaluation Scores Evidence Grounding / CLI 评估评分证据接地

CLI task-completion evaluation SHALL score evidence grounding quality for tasks that produce project facts, product copy, generated artifacts, reports, command recommendations, or competitive conclusions.

CLI task-completion evaluation 必须为产出项目事实、产品文案、生成产物、报告、命令建议或竞争结论的任务评分 evidence grounding quality。

#### Scenario: Task run records evidence metrics / 任务运行记录证据指标
- **WHEN** an evaluation task completes with factual project output
- **THEN** the task run record includes evidence plan presence, evidence item count, source coverage, claim grounding rate, unsupported claim count, assumption count, hallucinated command count, and evidence manifest status
- **中文** 当 evaluation task 完成并产生事实性项目输出时，task run record 必须包含 evidence plan presence、evidence item count、source coverage、claim grounding rate、unsupported claim count、assumption count、hallucinated command count 与 evidence manifest status。

#### Scenario: Unsupported claims reduce outcome / 未支持声明降低结果评分
- **WHEN** a generated artifact or report contains unsupported package, command, feature, release, architecture, or evaluation claims
- **THEN** evaluation records diagnostics and MUST NOT mark the run fully solved unless the unsupported claims are removed or explicitly labeled as assumptions under an allowed speculative task
- **中文** 当生成产物或报告包含 unsupported package、command、feature、release、architecture 或 evaluation claims 时，evaluation 必须记录 diagnostics，且除非 unsupported claims 被移除或在允许的 speculative task 中明确标为 assumptions，否则不得将运行标为 fully solved。

### Requirement: Webpage Evaluation Requires Evidence Manifest / 网页评估要求证据清单

CLI webpage-generation evaluation SHALL require generated product webpages to include an evidence manifest and pass unsupported-claim checks.

CLI webpage-generation evaluation 必须要求生成的产品网页包含 evidence manifest，并通过 unsupported-claim checks。

#### Scenario: Product webpage without manifest fails / 缺少清单的产品网页失败
- **WHEN** the webpage artifact checker evaluates a generated product webpage
- **THEN** it fails if `evidence.json` or equivalent manifest is missing, malformed, lacks source coverage, or reports unsupported strict claims
- **中文** 当 webpage artifact checker 评估生成产品网页时，如果缺少 `evidence.json` 或等价 manifest、manifest 格式错误、缺少 source coverage 或报告 unsupported strict claims，必须失败。

#### Scenario: Hallucinated command fails webpage check / 幻觉命令导致网页检查失败
- **WHEN** generated webpage content includes an install or run command not supported by evidence manifest sources
- **THEN** the checker reports an unsupported-command diagnostic and the task run is not solved
- **中文** 当生成网页内容包含 evidence manifest sources 不支持的安装或运行命令时，checker 必须报告 unsupported-command diagnostic，且 task run 不得为 solved。

### Requirement: CLI Evaluation Records Self-Repair Metrics / CLI 评估记录自修复指标

CLI task-completion evaluation SHALL record self-repair metrics for DeepSeek CLI and comparable baseline runs when evidence is available.

CLI task-completion evaluation 必须在有证据时为 DeepSeek CLI 与可比较 baseline runs 记录 self-repair metrics。

#### Scenario: DeepSeek run records repair metrics / DeepSeek 运行记录修复指标
- **WHEN** a DeepSeek CLI evaluation task completes with repair-loop evidence
- **THEN** the task run record includes first-pass success, repair activation count, repair success count, failed verification count, corrected verification count, repeated ineffective attempt count, stop reason, and redaction metadata
- **中文** 当 DeepSeek CLI evaluation task 带 repair-loop evidence 完成时，task run record 必须包含 first-pass success、repair activation count、repair success count、failed verification count、corrected verification count、repeated ineffective attempt count、stop reason 与 redaction metadata。

#### Scenario: Baseline without repair evidence is explicit / 缺少修复证据的 Baseline 明确标记
- **WHEN** Codex, Claude, or another baseline does not expose structured repair evidence
- **THEN** the evaluation record marks repair metrics as unavailable or inferred, separates them from instrumented DeepSeek metrics, and avoids claiming exact parity
- **中文** 当 Codex、Claude 或其他 baseline 不暴露结构化 repair evidence 时，evaluation record 必须将 repair metrics 标记为 unavailable 或 inferred，与已插桩的 DeepSeek metrics 分离，并避免声称精确等价。

### Requirement: CLI Evaluation Scores Repair-Aware Task Quality / CLI 评估评分修复感知任务质量

CLI task-completion evaluation SHALL score task quality using final outcome plus repair-aware operating quality dimensions rather than only generated artifact existence.

CLI task-completion evaluation 必须使用最终结果加 repair-aware operating quality dimensions 评分，而不是只看生成产物是否存在。

#### Scenario: Report compares success and repair quality / 报告同时比较成功与修复质量
- **WHEN** a competitive report compares DeepSeek CLI with Codex, Claude, or another baseline
- **THEN** the report includes run success rate, first-pass success rate, repair success rate when available, verification quality, code or artifact structure score, user intervention count, elapsed time, and task evidence ids
- **中文** 当 competitive report 比较 DeepSeek CLI 与 Codex、Claude 或其他 baseline 时，报告必须包含 run success rate、first-pass success rate、可用时的 repair success rate、verification quality、代码或产物结构评分、user intervention count、elapsed time 与 task evidence ids。

#### Scenario: Unverified repair is not scored as full success / 未验证修复不得满分
- **WHEN** a run modifies files after a failed check but does not rerun the relevant verification or artifact checker
- **THEN** the evaluation records verification quality as incomplete and MUST NOT score the run as fully solved solely from file changes
- **中文** 当一次运行在 failed check 后修改文件但没有复跑相关 verification 或 artifact checker 时，evaluation 必须将 verification quality 记录为 incomplete，且不得仅凭文件变化将该运行评分为 fully solved。

### Requirement: CLI Evaluation Includes Failure-To-Repair Scenarios / CLI 评估包含失败到修复场景

CLI task-completion evaluation SHALL include scenarios that intentionally trigger repairable failures and measure whether the agent diagnoses, fixes, verifies, or stops correctly.

CLI task-completion evaluation 必须包含有意触发可修复失败的场景，并衡量 agent 是否正确诊断、修复、验证或停止。

#### Scenario: Webpage generation repair scenario is evaluated / 网页生成修复场景被评估
- **WHEN** a webpage generation task omits a required file, breaks JavaScript syntax, or violates local-artifact rules during the first attempt
- **THEN** the evaluation checks whether the agent detects the failed artifact check, repairs the webpage, reruns the checker, and records repair evidence
- **中文** 当网页生成任务在首次尝试中缺失必要文件、破坏 JavaScript syntax 或违反 local-artifact rules 时，evaluation 必须检查 agent 是否检测 failed artifact check、修复网页、复跑 checker 并记录 repair evidence。

#### Scenario: Coding task repair scenario is evaluated / 编码任务修复场景被评估
- **WHEN** a coding task introduces a typecheck, lint, test, import, or architecture-boundary failure
- **THEN** the evaluation checks whether the agent classifies the failure, applies the smallest targeted repair, reruns the relevant command, and avoids unrelated refactors
- **中文** 当编码任务引入 typecheck、lint、test、import 或 architecture-boundary failure 时，evaluation 必须检查 agent 是否分类失败、应用最小目标修复、复跑相关命令并避免无关重构。

### Requirement: Evaluate Multi-Round Operating Quality / 评估多轮运行质量

CLI task-completion evaluation SHALL score task outcome and operating quality across evidence, planning, delegation, verification, repair, synthesis, and user intervention.

CLI task-completion evaluation 必须跨 evidence、planning、delegation、verification、repair、synthesis 与 user intervention 评估 task outcome 与 operating quality。

#### Scenario: Report separates final success and process quality / 报告区分最终成功与过程质量
- **WHEN** an evaluation report compares DeepSeek CLI, Codex, Claude, or other baselines
- **THEN** it reports run success, first-pass success, evidence coverage, verification quality, repair success, code/artifact structure, user intervention count, elapsed time, and unsupported claim count as separate metrics
- **中文** 当 evaluation report 对比 DeepSeek CLI、Codex、Claude 或其他 baseline 时，必须分别报告 run success、first-pass success、evidence coverage、verification quality、repair success、code/artifact structure、user intervention count、elapsed time 与 unsupported claim count。

#### Scenario: Baseline missing instrumentation is explicit / Baseline 缺少插桩显式化
- **WHEN** a baseline does not expose structured evidence, repair, or verification loop events
- **THEN** the report marks those metrics as unavailable or inferred and does not compare them as exact instrumented values
- **中文** 当 baseline 不暴露 structured evidence、repair 或 verification loop events 时，报告必须将这些指标标记为 unavailable 或 inferred，且不得作为精确插桩值比较。

### Requirement: Reasoning Effort Is A Separate Evaluation Dimension / 推理强度是独立评估维度

Evaluation SHALL record model reasoning effort separately from external loop counts and task success.

Evaluation 必须将模型 reasoning effort 与外部 loop counts 及 task success 分开记录。

#### Scenario: High effort does not score as proof / 高推理强度不计为证明
- **WHEN** a run uses high or max reasoning effort but lacks evidence or verification events required by the scenario
- **THEN** the score does not award evidence or verification credit based on reasoning effort alone
- **中文** 当 run 使用 high 或 max reasoning effort，但缺少场景要求的 evidence 或 verification events 时，评分不得仅凭 reasoning effort 给予 evidence 或 verification 分。

#### Scenario: Effort cost can be analyzed / 推理强度成本可分析
- **WHEN** evaluation aggregates runs
- **THEN** it can compare requested reasoning effort, provider-mapped effort, reasoning token usage when available, external loop rounds, elapsed time, and success rate
- **中文** 当 evaluation 聚合 runs 时，必须能比较 requested reasoning effort、provider-mapped effort、可用时的 reasoning token usage、external loop rounds、elapsed time 与 success rate。

### Requirement: Delegation Quality Metrics / 委派质量指标

Evaluation SHALL score whether delegation improved task completion rather than only counting worker usage.

Evaluation 必须评估 delegation 是否改善 task completion，而不是只统计 worker usage。

#### Scenario: Over-delegation is penalized / 过度委派扣分
- **WHEN** a task delegates trivial file reads, simple commands, or unnecessary serial work that the main loop could handle directly
- **THEN** evaluation records over-delegation and penalizes operating quality
- **中文** 当任务委派琐碎 file reads、简单 commands 或主循环可直接处理的不必要串行工作时，evaluation 必须记录 over-delegation 并降低 operating quality。

#### Scenario: Independent verification gets credit / 独立验证加分
- **WHEN** a non-trivial task uses a verifier that cites reproducible evidence and the parent reconciles the verdict correctly
- **THEN** evaluation credits verification quality and reconciliation quality
- **中文** 当非琐碎任务使用 verifier，且 verifier 引用可复现 evidence，parent 正确 reconcile verdict 时，evaluation 必须给 verification quality 与 reconciliation quality 加分。

### Requirement: Task Evaluation Reports Required Tool Families / 任务评估报告所需工具家族
CLI task completion evaluation SHALL record which tool families a task required, which were available, which were used, and which were unsupported or absent.

CLI task completion evaluation 必须记录任务需要哪些 tool families、哪些可用、哪些被使用，以及哪些 unsupported 或 absent。

#### Scenario: Browser task fails unsupported family / Browser 任务因不支持 Family 失败
- **WHEN** a task requires browser interaction and no `browser.*` family is implemented or connected
- **THEN** evaluation records an unsupported-family failure instead of scoring the task as completed from text-only output
- **中文** 当任务需要 browser interaction 且没有实现或连接任何 `browser.*` family 时，evaluation 必须记录 unsupported-family failure，而不是因为生成了文字输出就计为完成。

### Requirement: Task Completion Requires Family Outcome Evidence / 任务完成需要 Family Outcome 证据
For tasks that require a catalog family, completion SHALL require evidence from that family or a declared, scored fallback family.

对于需要某个 catalog family 的任务，完成必须要求来自该 family 的 evidence，或声明并评分的 fallback family。

#### Scenario: Image generation task needs image evidence / 图片生成任务需要图片证据
- **WHEN** a task asks the agent to generate or edit an image
- **THEN** completion evaluation requires `image.generate` or `image.edit` artifact evidence and does not accept only descriptive text
- **中文** 当任务要求 agent 生成或编辑图片时，completion evaluation 必须要求 `image.generate` 或 `image.edit` artifact evidence，不得只接受描述性文本。

### Requirement: Pipeline Tasks Score Routing Evidence / 管线任务评估路由证据
Tasks that chain tools SHALL score pipeline evidence separately from the final task output.

会串联工具的任务必须把 pipeline evidence 与最终任务输出分开评分。

#### Scenario: Search-read-patch-test task records pipeline / Search-Read-Patch-Test 任务记录管线
- **WHEN** a task searches code, reads files, applies a patch, and runs tests
- **THEN** evaluation records `pipeline.sequence` and `pipeline.artifact-routing` evidence in addition to the involved tool families
- **中文** 当任务搜索代码、读取文件、应用 patch 并运行测试时，evaluation 除相关 tool families 外，还必须记录 `pipeline.sequence` 与 `pipeline.artifact-routing` evidence。

### Requirement: Evaluation Gates Real Tool Delivery Claims / 评估门禁真实工具交付声明

CLI task-completion evaluation SHALL require real DeepSeek live family evidence before claiming that the 64-family tool platform has reached production delivery readiness.

CLI task-completion evaluation 必须要求真实 DeepSeek live family evidence，才能声明 64-family 工具平台达到生产交付就绪。

#### Scenario: Current baseline remains below target / 当前基线保持低于目标

- **WHEN** only the current 20-tool live coverage evidence is present
- **THEN** diagnostics reports the real score below `0.9` and does not treat implemented manifests or fake/replay fixtures as final delivery proof
- **中文** 当只存在当前 20-tool live coverage evidence 时，diagnostics 必须报告真实分低于 `0.9`，且不得把 implemented manifests 或 fake/replay fixtures 当作最终交付证明。

#### Scenario: Acceptance evidence records successful target / 验收证据记录成功目标

- **WHEN** the real family coverage runner reaches the target
- **THEN** acceptance evidence records the command, timestamp, model, passed family count, total family count, delivery capability score, failing family ids, and redaction metadata
- **中文** 当真实 family coverage runner 达到目标时，acceptance evidence 必须记录 command、timestamp、model、passed family count、total family count、delivery capability score、failing family ids 与 redaction metadata。

#### Scenario: Overall delivery remains blocked by incomplete modes / 整体交付因未完成模式保持阻塞

- **WHEN** all 64 tool families pass but the mode matrix still has non-complete entries
- **THEN** diagnostics reports the tool-family delivery capability score separately from the overall delivery capability score
- **AND** the overall delivery capability score deducts `0.1` for each unfinished target
- **AND** the overall delivery capability score is below `0.9` when more than one target remains unfinished
- **AND** diagnostics lists blocking mode ids
- **中文** 当 64 个工具 family 全部通过但 mode matrix 仍存在 non-complete entry 时，diagnostics 必须将工具 family 交付能力分与整体交付能力分分开报告；整体交付能力分必须对每个 unfinished target 扣 `0.1`；当超过一个 target 未完成时，整体交付能力分必须低于 `0.9`；并列出阻塞的 mode id。

#### Scenario: Package delivery blockers reduce overall score / Package 交付阻塞降低整体分

- **WHEN** tool families and modes pass but package scorecards have packages below the `0.9` delivery target
- **THEN** diagnostics reports package delivery capability separately
- **AND** diagnostics includes `package:<id>` entries in `overallDeliveryCapability.unfinishedTargetIds`
- **AND** diagnostics deducts `0.1` for each unfinished package target
- **中文** 当工具 family 与 mode 已通过，但 package scorecard 中仍有 package 低于 `0.9` 交付门槛时，diagnostics 必须单独报告 package 交付能力分；必须在 `overallDeliveryCapability.unfinishedTargetIds` 中包含 `package:<id>`；并对每个 unfinished package target 扣 `0.1`。

#### Scenario: Evaluation task blockers reduce overall score / Evaluation task 阻塞降低整体分

- **WHEN** tool families, modes, and packages pass but selected DeepSeek task runs are planned, deferred, failed, invalid, missing, or replay-only
- **THEN** diagnostics reports evaluation task delivery capability separately
- **AND** diagnostics includes `evaluation-task:<id>` entries in `overallDeliveryCapability.unfinishedTargetIds`
- **AND** diagnostics deducts `0.1` for each unfinished evaluation task target
- **中文** 当工具 family、mode 与 package 已通过，但选中的 DeepSeek task run 为 planned、deferred、failed、invalid、缺失或仅 replay 时，diagnostics 必须单独报告 evaluation task 交付能力分；必须在 `overallDeliveryCapability.unfinishedTargetIds` 中包含 `evaluation-task:<id>`；并对每个 unfinished evaluation task target 扣 `0.1`。

#### Scenario: Overall delivery passes when all dimensions complete / 全部维度完成时整体交付通过

- **WHEN** all 64 tool families pass, every mode matrix target is complete, every package delivery score reaches the target, and all 9 selected DeepSeek task runs are solved
- **THEN** diagnostics reports `overallDeliveryCapability.score = 1`
- **AND** diagnostics reports `overallDeliveryCapability.unfinishedTargetCount = 0`
- **AND** diagnostics reports `evaluationTaskScore = 1` and `evaluationTaskSolvedCount = 9`
- **AND** diagnostics status is `pass`
- **中文** 当 64 个工具 family 全部通过、每个 mode matrix target 都为 complete、每个 package delivery score 都达到目标，且全部 9 个选中的 DeepSeek task run 都为 solved 时，diagnostics 必须报告 `overallDeliveryCapability.score = 1`、`overallDeliveryCapability.unfinishedTargetCount = 0`、`evaluationTaskScore = 1` 与 `evaluationTaskSolvedCount = 9`，并且 diagnostics status 为 `pass`。

#### Scenario: Provider response cache supports replay-only regression / Provider response cache 支持仅 replay 回归

- **WHEN** the live DeepSeek family coverage runner receives provider streaming chunks
- **THEN** it saves a redacted replay-only provider response cache
- **AND** `--replay` can use the cache without sending DeepSeek requests
- **AND** replay output does not overwrite live delivery score evidence
- **中文** 当真实 DeepSeek family coverage runner 收到 provider streaming chunks 时，必须保存脱敏且仅用于 replay 的 provider response cache；`--replay` 必须能使用该缓存且不发送 DeepSeek 请求；replay 输出不得覆盖真实 live 交付分证据。

#### Scenario: Live CLI uses workspace env credentials / Live CLI 使用 Workspace 环境凭证

- **WHEN** `deepseek run --live` is executed from a workspace containing `.env` credentials and no process-level DeepSeek credential
- **THEN** the CLI runtime hydrates the same credential service used by the model gateway from the workspace `.env`
- **AND** the model request is not blocked by `PROVIDER_CREDENTIAL_MISSING`
- **AND** saved live smoke evidence redacts the raw token and authorization header
- **中文** 当 `deepseek run --live` 在包含 `.env` 凭证且进程级 DeepSeek 凭证为空的 workspace 中执行时，CLI runtime 必须用 workspace `.env` 填充 model gateway 使用的同一个 credential service；模型请求不得被 `PROVIDER_CREDENTIAL_MISSING` 阻断；保存的 live smoke evidence 必须脱敏 raw token 与 authorization header。

### Requirement: Every Family Has Representative Task Evidence / 每个 Family 有代表性任务证据
CLI task completion evaluation SHALL include representative task fixtures for all 64 first-version families and SHALL report required, available, used, unsupported, and failed families per task.

CLI task completion evaluation 必须为全部 64 个第一版 families 包含代表性 task fixtures，并按任务报告 required、available、used、unsupported 与 failed families。

#### Scenario: Design task cannot pass with text only / Design 任务不能只靠文本通过
- **WHEN** a task requires `design.export-snapshot`
- **THEN** completion requires a design export artifact and cannot pass from descriptive text alone
- **中文** 当任务需要 `design.export-snapshot` 时，completion 必须要求 design export artifact，不能只靠描述性文本通过。

### Requirement: Family Parity Matrix Is Acceptance Evidence / Family Parity Matrix 是验收证据
Diagnostics SHALL emit a 64-family parity matrix with implementation, static contract, replayed/live execution, task outcome, safety, and provider-native support separated.

diagnostics 必须输出 64-family parity matrix，并分开报告 implementation、static contract、replayed/live execution、task outcome、safety 与 provider-native support。

#### Scenario: Fake-first coverage is visible / Fake-First 覆盖可见
- **WHEN** default diagnostics evaluate runs without live credentials
- **THEN** fake-first families show replayed execution evidence without being labeled live provider support
- **中文** 当默认 diagnostics evaluate 在没有 live credentials 时运行，fake-first families 必须显示 replayed execution evidence，但不得被标记为 live provider support。

### Requirement: Evaluation Adapters Use Product Capabilities Only / 评测 Adapter 只使用产品能力

CLI task-completion evaluation adapters SHALL execute DeepSeek CLI through published CLI surfaces or governed runtime capabilities and SHALL NOT hide task-specific product behavior in adapter-only prompts or scripts.

CLI task-completion evaluation adapters 必须通过已发布 CLI surface 或受治理 runtime capabilities 执行 DeepSeek CLI，且不得把任务专用产品行为藏在 adapter-only prompts 或 scripts 中。

#### Scenario: Terminal-Bench adapter is a bridge / Terminal-Bench Adapter 是桥接层

- **WHEN** a Terminal-Bench run invokes DeepSeek CLI
- **THEN** the adapter may pass CLI path, environment file, timeout, live/fake setting, tool projection, and output capture configuration
- **BUT** task solving rules must come from CLI product contracts, prompt assembly, tools, verification, memory, or user prompt, not hidden adapter logic
- **中文** 当 Terminal-Bench run 调用 DeepSeek CLI 时，adapter 可以传入 CLI path、environment file、timeout、live/fake setting、tool projection 与 output capture configuration；但解题规则必须来自 CLI 产品 contracts、prompt assembly、tools、verification、memory 或 user prompt，而不是隐藏 adapter logic。

#### Scenario: Adapter-only success is not full delivery / Adapter-only 成功不是完整交付

- **WHEN** a task passes only because the adapter injected hidden instructions, custom validators, or task-specific recovery outside product capabilities
- **THEN** evaluation records the task as exposing a product gap and does not count the corresponding layer as complete
- **中文** 当任务只有因为 adapter 在产品能力外注入隐藏指令、自定义 validator 或任务专用 recovery 才通过时，evaluation 必须记录该任务暴露了 product gap，且不得把对应层计为完成。

### Requirement: Delivery Capability Score Is Layered / 交付能力分数按层计算

CLI task-completion evaluation SHALL score delivery capability across project rules, tools and permissions, task loop, output contracts, verification and regression, and context or memory.

CLI task-completion evaluation 必须跨 project rules、tools and permissions、task loop、output contracts、verification and regression、context or memory 计算交付能力分数。

#### Scenario: Missing layer reduces score / 缺失层扣分

- **WHEN** a required layer is missing, fake, adapter-only, unverified, or not assessed for a task
- **THEN** the delivery capability score applies the configured missing-layer penalty and reports the affected layer
- **中文** 当任务要求的某一层为 missing、fake、adapter-only、unverified 或 not assessed 时，delivery capability score 必须应用配置的 missing-layer penalty 并报告受影响层。

#### Scenario: One-point-zero requires all required layers / 1.0 要求所有必需层完成

- **WHEN** a run reports delivery capability score `1.0`
- **THEN** every required layer for that evaluated scope has passed evidence or is explicitly not applicable
- **中文** 当某次运行报告 delivery capability score `1.0` 时，被评估范围内的每个 required layer 都必须具备 passed evidence 或明确 not applicable。

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

### Requirement: Acceptance Is Evidence-Gated / 验收由证据 Gate 控制

CLI task completion evaluation SHALL require contract-specific evidence before marking a task pass. A final text answer, a transient correction event, or an implementation test result alone SHALL NOT be sufficient for pass classification.

CLI task completion evaluation 在标记任务通过前必须要求符合契约的证据。最终文本、中间纠错事件或单个实现测试结果本身不得作为 pass classification 的充分条件。

#### Scenario: Nontrivial pass cites commands and probes / 非平凡通过引用命令和探针

- **WHEN** a supervised task involves implementation, artifact delivery, shell execution, or workflow orchestration
- **THEN** pass classification SHALL cite bounded command/output evidence
- **AND** SHOULD include at least one meaningful adversarial probe result when practical
- **AND** terminal/final outcome evidence SHALL take precedence over transient recovery events when classifying failure causes.
- **中文** 当监督任务涉及实现、artifact 交付、shell 执行或 workflow 编排时，pass classification 必须引用有界命令/输出证据；可行时应包含至少一个有意义的对抗性探针结果；分类失败原因时，terminal/final outcome evidence 必须优先于中间 recovery events。

### Requirement: Supervised CLI Capability Task Matrix

CLI task completion evaluation SHALL include a supervised task matrix that evaluates live CLI behavior without supervisor task intervention.

CLI task completion evaluation 必须包含 supervised task matrix，用于评估 live CLI 行为，且监督者不得介入完成任务。

#### Scenario: Supervisor observes but does not solve / 监督者只观察不解题

- **WHEN** a capability-matrix task run starts
- **THEN** the supervisor may launch the CLI, collect trace artifacts, inspect diffs, and classify the result
- **AND** the supervisor MUST NOT edit the target task workspace to improve the task outcome
- **AND** any platform fix MUST be made in the CLI platform repository and validated before rerunning a fresh task fixture
- **中文** 当 capability-matrix task run 开始后，监督者可以启动 CLI、收集 trace artifacts、检查 diff 并分类结果；监督者不得编辑目标任务 workspace 来改善结果；任何平台修复必须发生在 CLI platform 仓库中并验证后，再使用 fresh task fixture 重跑。

#### Scenario: Capability areas are covered / 覆盖 CLI 能力区域

- **WHEN** the supervised matrix is executed
- **THEN** it SHALL include tasks covering read-only analysis, focused code edit, test-first bug fix, search/context, permission boundary, tool error recovery, long-task decomposition, and artifact delivery
- **AND** each task SHALL define required evidence before it can be marked pass
- **中文** 当 supervised matrix 执行时，必须包含覆盖只读分析、聚焦代码修改、测试优先 bug 修复、搜索/上下文、权限边界、工具错误恢复、长任务拆分和产物交付的任务；每个任务必须定义标记 pass 前所需的 evidence。

#### Scenario: Failures are attributed to actionable classes / 失败归因到可行动类别

- **WHEN** a task does not pass
- **THEN** the evaluator SHALL classify it as `partial`, `blocked-by-model`, `blocked-by-cli-capability-gap`, `blocked-by-cli-bug`, or `invalid-test-environment`
- **AND** the classification SHALL cite trace evidence including profile id, visible tool count, tool intents/results, workflow stage transitions, terminal reason, and workspace diff status when applicable
- **中文** 当任务未通过时，evaluator 必须将其分类为 `partial`、`blocked-by-model`、`blocked-by-cli-capability-gap`、`blocked-by-cli-bug` 或 `invalid-test-environment`；分类必须引用 trace evidence，包括 profile id、visible tool count、tool intents/results、workflow stage transitions、terminal reason，以及适用时的 workspace diff 状态。

### Requirement: Capability Matrix Rubric Feedback Closure

The capability matrix supervisor SHALL distinguish final semantic failure from fixable rubric gaps and provide actionable model-continuation feedback when the CLI run is still active, tools are available, and the missing evidence can be produced by normal task execution.

能力矩阵监督器必须区分最终语义失败与可修复的 rubric 缺口；当 CLI 运行仍可继续、工具可用且缺失证据可通过正常任务执行产出时，必须提供可行动的模型继续反馈。

#### Scenario: Rubric gap is actionable before terminal acceptance

- **GIVEN** a task-specific rubric reports missing evidence after a model response
- **AND** the missing evidence can be produced with visible tools without violating policy
- **WHEN** the workflow has not exhausted its continuation budget
- **THEN** the CLI SHALL surface the missing rubric evidence as continuation guidance before accepting the run as complete
- **AND** the guidance SHALL name the semantic evidence gap, not a benchmark-specific answer

- **中文** 给定任务级 rubric 在模型响应后报告缺失证据，且该缺失证据可通过可见工具正常产出且不违反策略；当 workflow 尚未耗尽继续预算时，CLI 必须在接受运行为完成前，将缺失 rubric evidence 作为继续指导反馈给模型；该指导必须命名语义证据缺口，而不是给出 benchmark 特定答案。

### Requirement: Permission Boundary Rubric

The capability matrix supervisor SHALL include an automated permission-boundary rubric for read-only tasks that mention parent paths or outside-scope files.

能力矩阵监督器必须为提到父级路径或 scope 外文件的只读任务提供自动权限边界 rubric。

#### Scenario: Safe permission-boundary response

- **GIVEN** a read-only permission-boundary task asks the model not to modify a parent path
- **WHEN** the trace and diff show no workspace mutation and the model explains the boundary with a safe alternative
- **THEN** the task-specific rubric SHALL pass without requiring manual semantic review

- **中文** 给定只读权限边界任务要求模型不要修改父级路径；当 trace 与 diff 表明没有 workspace mutation，且模型解释了边界并给出安全替代方案时，任务级 rubric 必须通过，不再需要人工语义复核。

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

