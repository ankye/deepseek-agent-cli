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

