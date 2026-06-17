## MODIFIED Requirements

### Requirement: SWE-bench Prediction Adapter

CLI diagnostics SHALL expose `diagnostics swe-bench predict` and `diagnostics swe-bench evaluate` adapters that can produce official-compatible SWE-bench prediction JSONL, run the official harness, and report local batch scoring evidence for the selected instance subset, including structured harness error evidence when the official top-level report contains `error_ids`.

CLI diagnostics 必须暴露 `diagnostics swe-bench predict` 与 `diagnostics swe-bench evaluate` adapters，用于生成官方兼容的 SWE-bench prediction JSONL、运行官方 harness，并报告所选 instance 子集的本地 batch scoring evidence；当 official 顶层 report 包含 `error_ids` 时，还必须报告结构化 harness error evidence。

#### Scenario: Top-level harness errors remain structured / 顶层 Harness Error 保持结构化

- **WHEN** `diagnostics swe-bench evaluate` runs the official harness and the top-level report contains `error_ids`
- **AND** the matching per-instance `logs/run_evaluation/.../report.json` file is absent
- **THEN** the evaluation summary MUST include the errored instance id as a harness error instance
- **AND** diagnostics MUST include a stable harness-error code with the top-level report path and error instance ids in internal metadata
- **AND** the errored instance MUST NOT be counted as a model unresolved instance
- **AND** generic per-instance report stat/read failures MUST NOT be the primary classification when top-level harness error evidence is available
- **中文** 当 `diagnostics swe-bench evaluate` 运行 official harness，且顶层 report 包含 `error_ids`，同时匹配的单实例 `logs/run_evaluation/.../report.json` 文件不存在时，evaluation summary 必须把该 instance id 记录为 harness error instance；diagnostics 必须包含稳定的 harness-error code，并在 internal metadata 中携带顶层 report path 与 error instance ids；该 errored instance 不得计入模型 unresolved instance；当顶层 harness error evidence 可用时，通用单实例 report stat/read failure 不得成为主分类。

#### Scenario: Stable prompt prefix is not conflated with projection-cache miss / 稳定 Prompt 前缀不得与 Projection Cache Miss 混淆

- **WHEN** `diagnostics swe-bench evaluate` reads a cache trace whose provider token cache meets the requested hit-rate target
- **AND** the trace contains repeated `prompt.assembled` events with stable section-order and budget fingerprints
- **AND** `context.projection.completed` cache records are all misses with prompt dependency fingerprints
- **THEN** the cache summary MUST keep provider-cache and context-projection-cache metrics separate
- **AND** diagnostics MUST include stable reason codes for context projection no-hit and whole-prompt dynamic key review
- **AND** the context projection cache summary and whole-prompt dynamic key diagnostic metadata MUST expose the unique prompt dependency count and bounded sample prompt dependency fingerprints
- **AND** diagnostics MUST NOT imply that the stable prompt prefix itself is unstable
- **中文** 当 `diagnostics swe-bench evaluate` 读取 cache trace，provider token cache 已达到请求的命中率目标，trace 中重复的 `prompt.assembled` 事件拥有稳定 section-order 与 budget 指纹，但 `context.projection.completed` cache 记录全部 miss 且依赖 `prompt:*` 指纹时，cache summary 必须分离 provider-cache 与 context-projection-cache 指标；diagnostics 必须包含 context projection no-hit 与 whole-prompt dynamic key 复盘的稳定 reason codes；context projection cache summary 与 whole-prompt dynamic key diagnostic metadata 必须暴露 unique prompt dependency count 与有界 sample prompt dependency fingerprints；diagnostics 不得暗示稳定 prompt 前缀本身不稳定。

#### Scenario: Provider cache misses distinguish history tail from prefix drift / Provider Cache Miss 区分历史尾部与前缀漂移

- **WHEN** `diagnostics swe-bench evaluate` reads a cache trace whose provider token cache is below the requested hit-rate target
- **AND** repeated `prompt.assembled` events keep stable section-order, budget, and tool-plan fingerprints while `model.requested` replay evidence shows growing history/tool-result counts
- **THEN** the provider cache summary MUST count those low-hit requests as history-tail misses
- **AND** diagnostics MUST include a stable history-tail cache review code rather than treating the stable prompt prefix as busted
- **WHEN** low provider cache hit requests occur while prompt assembly section-order, budget, or tool-plan fingerprints drift
- **THEN** diagnostics MUST include a stable prompt-cache-prefix-busted code with bounded fingerprint-count metadata
- **中文** 当 `diagnostics swe-bench evaluate` 读取 cache trace，provider token cache 低于请求命中率目标，且重复的 `prompt.assembled` 事件保持 section-order、budget 与 tool-plan 指纹稳定，但 `model.requested` replay evidence 显示 history/tool-result 数量增长时，provider cache summary 必须把这些低命中请求计为 history-tail miss；diagnostics 必须包含稳定的 history-tail cache 复盘 code，而不是把稳定 prompt 前缀归为 busted。当低 provider cache 命中请求同时伴随 prompt assembly 的 section-order、budget 或 tool-plan 指纹漂移时，diagnostics 必须包含稳定的 prompt-cache-prefix-busted code，并带有有界 fingerprint-count metadata。

#### Scenario: Prompt-only projection is no-store cache evidence / 仅 Prompt 投影是 No-store 缓存证据

- **WHEN** context projection only contains the volatile current-turn user prompt and no stable context candidates
- **THEN** the projection cache metadata MUST use a no-store cache key and an empty dependency fingerprint list rather than a `prompt:*` dependency key
- **AND** SWE-bench cache trace summaries MUST count no-store projection events separately from cacheable context projection request, hit, and miss counts
- **AND** no-store projection events MUST NOT lower the context projection cache hit rate
- **中文** 当 context projection 只包含易变的当前轮用户 prompt，且没有稳定 context candidates 时，projection cache metadata 必须使用 no-store cache key 和空 dependency fingerprint list，而不是 `prompt:*` 依赖 key；SWE-bench cache trace summary 必须把 no-store projection events 与可缓存 context projection request/hit/miss 计数分开；no-store projection events 不得拉低 context projection cache hit rate。

#### Scenario: Current-turn prompt does not poison stable projection cache keys / 当前轮 Prompt 不污染稳定投影缓存 Key

- **WHEN** context projection receives unchanged stable context candidates across turns
- **AND** the current-turn user prompt changes
- **THEN** the projection cache key MUST remain based on the stable candidates rather than the whole current prompt
- **AND** a cache hit MUST still rebuild the returned projection with the current turn prompt rather than reusing a previous turn prompt
- **中文** 当 context projection 跨轮收到不变的稳定 context candidates，且当前轮用户 prompt 发生变化时，projection cache key 必须基于稳定 candidates，而不是整段当前 prompt；cache hit 仍必须用当前轮 prompt 重建返回的 projection，不得复用上一轮 prompt。

#### Scenario: Batch evidence preserves cache review codes / Batch Evidence 保留 Cache 复盘 Code

- **WHEN** `core.swe.bench.run` executes a numbered SWE-bench task batch
- **AND** child task summaries include cache review diagnostics such as context projection no-hit or provider-cache-below-target
- **THEN** the batch summary MUST aggregate provider cache metrics, context projection cache metrics, and stable review codes from child diagnostics
- **AND** the batch evidence preview MUST expose the aggregated review codes without requiring the supervisor to open each child summary
- **中文** 当 `core.swe.bench.run` 执行编号 SWE-bench task batch，且 child task summaries 包含 context projection no-hit 或 provider-cache-below-target 等 cache 复盘诊断时，batch summary 必须聚合 provider cache 指标、context projection cache 指标和来自 child diagnostics 的稳定 review codes；batch evidence preview 必须暴露聚合后的 review codes，避免监督者必须逐个打开 child summary 才能复盘。

#### Scenario: Batch task states expose actionable failure attribution / Batch Task State 暴露可执行失败归因

- **WHEN** `core.swe.bench.run` summarizes a numbered SWE-bench task batch below the required success-rate gate
- **AND** child task summaries include a mix of official unresolved scores, harness errors, verification gaps, or cache review diagnostics
- **THEN** every non-resolved task state MUST include stable reason codes, a primary reason code, a failure category, an actionability value, and blocker ids when blocker catalog entries match
- **AND** only model patch insufficiency MUST be classified as model-owned; harness, environment, verification, cache, trace, and framework diagnostics MUST be classified as fixable framework/environment work
- **AND** cache reason codes, including provider history-tail misses, MUST expose `framework-fix` actionability rather than soft review or model feedback
- **AND** the batch evidence preview MUST show the task-level review codes without requiring the supervisor to open every child trace
- **中文** 当 `core.swe.bench.run` 汇总一个低于成功率门槛的 SWE-bench 编号批次，且 child task summary 混合了 official unresolved、harness error、verification gap 或 cache 复盘诊断时，每个未 resolved 的 task state 必须包含稳定 reason codes、primary reason code、failure category、actionability value，并在命中 blocker catalog 时包含 blocker ids；只有模型 patch 不充分可以归为模型侧，harness、environment、verification、cache、trace 与 framework 诊断必须归为可修复的框架/环境问题；包括 provider history-tail miss 在内的 cache reason code 必须暴露 `framework-fix` actionability，而不是软复核或模型反馈；batch preview 必须展示 task 级 review codes，避免监督者逐个打开 child trace。

#### Scenario: Harness error logs expose missing Docker images / Harness Error Log 暴露缺失 Docker 镜像

- **WHEN** the official harness top-level report contains `error_ids`
- **AND** an errored instance `run_instance.log` says the required Docker image was not found locally
- **THEN** diagnostics MUST include a stable Docker image missing code with the instance id and internal log path metadata
- **AND** batch task attribution MUST classify that task as an environment fix rather than a model patch failure
- **中文** 当 official harness 顶层 report 包含 `error_ids`，且 errored instance 的 `run_instance.log` 表明所需 Docker 镜像在本地不存在时，diagnostics 必须包含稳定的 Docker image missing code，并在 internal metadata 中携带 instance id 与日志路径；batch task 归因必须把该 task 归为环境修复，而不是模型 patch 失败。

#### Scenario: Missing remote harness images retry with local build / 缺失远程 Harness 镜像时本地构建重试

- **WHEN** `diagnostics swe-bench evaluate` detects a missing default-namespace SWE-bench instance image from harness error logs
- **THEN** the evaluation adapter MUST retry the official harness once with `--namespace none --force_rebuild true` and a fresh retry run id
- **AND** if the retry produces fresh per-instance reports without the Docker image error, the original missing-image diagnostics MUST be retained as recovered internal evidence rather than failing the final evaluation summary
- **AND** the retry MUST be visible through stable diagnostics and command-plan evidence
- **中文** 当 `diagnostics swe-bench evaluate` 从 harness error log 中识别出默认 namespace 的 SWE-bench instance image 缺失时，evaluation adapter 必须使用 `--namespace none --force_rebuild true` 和新的 retry run id 重试一次 official harness；如果重试产出新鲜单实例 report 且不再出现 Docker image error，原始缺镜像诊断必须作为 recovered internal evidence 保留，而不能继续使最终 evaluation summary 失败；该重试必须通过稳定 diagnostics 和 command-plan evidence 可见。

#### Scenario: Resume imports recovered harness sidecar evidence / Resume 导入已恢复 Harness Sidecar 证据

- **WHEN** `core.swe.bench.run` resumes a numbered batch and an existing child summary failed only because of retryable harness/report diagnostics
- **AND** the child run root contains a recovered `local-build-evaluate.json` sidecar with fresh official evaluation evidence
- **THEN** resume MUST import the sidecar evaluation into the child summary before deciding whether to rerun the child model
- **AND** an unresolved sidecar evaluation MUST classify the child as model patch insufficient instead of preserving a stale framework report failure
- **AND** the recovered child summary MUST be persisted so subsequent batch evidence and task review codes use the recovered official harness result
- **中文** 当 `core.swe.bench.run` resume 编号 batch，且已有 child summary 仅因可重试 harness/report diagnostics 失败，同时 child run root 包含已恢复的 `local-build-evaluate.json` official evaluation sidecar 时，resume 必须先把 sidecar evaluation 导入 child summary，再决定是否重跑 child model；若 sidecar official evaluation 仍 unresolved，该 child 必须归类为 model patch insufficient，而不是继续保留陈旧的 framework report failure；恢复后的 child summary 必须持久化，使后续 batch evidence 与 task review codes 使用恢复后的 official harness 结果。

#### Scenario: Resume-only review does not expand incomplete batches / 仅复盘 Resume 不扩张未完成批次

- **WHEN** `core.swe.bench.run` is invoked for a numbered batch with `resumeOnly=true`
- **AND** some requested child run summaries exist while later task summaries are still absent
- **THEN** the capability MUST import and refresh existing resumable child summaries, including recovered harness sidecars
- **AND** it MUST leave missing child tasks pending without resolving dataset instances, launching child agents, or running the official harness
- **AND** the batch summary MUST preserve the requested task number set so pending tasks remain visible in the below-threshold review
- **中文** 当 `core.swe.bench.run` 以 `resumeOnly=true` 调用编号批次，且部分 child run summary 已存在、后续任务 summary 仍缺失时，该能力必须导入并刷新已有可 resume 的 child summary，包括已恢复的 harness sidecar；它不得解析缺失任务的数据集、启动 child agent 或运行 official harness；batch summary 必须保留请求的 task number 集合，使 pending 任务仍在低于门槛的复盘中可见。

#### Scenario: Checkout environment warnings carry process evidence / Checkout 环境告警携带进程证据

- **WHEN** `core.swe.bench.run` prepares a run-scoped checkout environment
- **AND** nonfatal pip bootstrap or editable install commands exit nonzero
- **THEN** diagnostics MUST keep the run as structured evidence rather than collapsing it into a pre-scoring executor failure
- **AND** each checkout environment warning MUST include internal metadata for command, args, cwd, exit code, stdout preview, and stderr preview
- **AND** batch attribution MUST classify checkout environment warnings as environment-fix work unless later evidence proves they are unrelated
- **中文** 当 `core.swe.bench.run` 准备 run-scoped checkout 环境，且非致命 pip bootstrap 或 editable install 命令以非零状态退出时，诊断必须保留结构化运行证据，而不能把它压成 scoring 前 executor failure；每个 checkout 环境告警必须在 internal metadata 中包含 command、args、cwd、exit code、stdout preview 和 stderr preview；batch 归因必须把 checkout 环境告警归为 environment-fix，除非后续证据证明它无关。

#### Scenario: Checkout environment selects legacy-compatible Python profiles / Checkout 环境选择旧版本兼容 Python Profile

- **WHEN** `core.swe.bench.run` prepares a run-scoped checkout for SWE-bench Astropy tasks whose source tree requires old Python packaging or native extension behavior
- **THEN** the checkout environment MUST select a compatible local Python command instead of always using the newest interpreter
- **AND** editable install MUST receive run-scoped pip constraints for build isolation, including setuptools constraints for Astropy 5.x-era pyproject builds
- **AND** older Astropy 3.x-era checkouts MUST also receive NumPy/Cython constraints and legacy compiler flags needed to build their bundled native extensions on current macOS toolchains
- **AND** these compatibility settings MUST be applied before launching the child model so environment failures are not misattributed as model patch insufficiency
- **中文** 当 `core.swe.bench.run` 为需要旧 Python packaging 或 native extension 行为的 SWE-bench Astropy 任务准备 run-scoped checkout 时，checkout 环境必须选择兼容的本地 Python 命令，而不是总是使用最新解释器；editable install 必须接收 run-scoped pip 约束，包括 Astropy 5.x pyproject build isolation 所需的 setuptools 约束；更老的 Astropy 3.x checkout 还必须接收 NumPy/Cython 约束和当前 macOS toolchain 构建其 bundled native extensions 所需的 legacy compiler flags；这些兼容设置必须在启动 child model 前应用，避免把环境失败误归因成模型 patch 不充分。
