## ADDED Requirements

### Requirement: Evaluation Entry Prompts Stay User-Realistic / 评测入口 Prompt 保持真实用户风格

CLI task-completion evaluation SHALL send the evaluated CLI only a user-realistic entry prompt plus execution-envelope configuration, and SHALL keep evaluator-authored task decomposition, expected patch knowledge, and scoring criteria outside the prompt sent to the evaluated CLI.

CLI task-completion evaluation 必须只向被测 CLI 发送真实用户风格入口 prompt 与执行信封配置，并且必须把评测员编写的任务拆解、预期 patch 知识与评分标准留在 prompt 外部。

#### Scenario: SWE-bench Lite item request uses a short user prompt / SWE-bench Lite 题号请求使用短用户 Prompt

- **WHEN** an evaluation run asks DeepSeek CLI to complete a SWE-bench Lite item such as `给我完成 SWE-bench Lite 第 1 题测试，跑通并告诉我结果。`
- **THEN** the prompt sent to the evaluated CLI may identify the benchmark family and item selector
- **AND** it must not include the resolved instance id, problem statement, target repository file, target line, correct patch, hidden task plan, harness command recipe, or evaluator acceptance checklist
- **AND** the evaluation record stores the exact prompt text or digest as evidence for prompt purity
- **中文** 当 evaluation run 要求 DeepSeek CLI 完成 SWE-bench Lite 题目，例如 `给我完成 SWE-bench Lite 第 1 题测试，跑通并告诉我结果。` 时，发送给被测 CLI 的 prompt 可以包含 benchmark family 与题目选择器；但不得包含已解析 instance id、problem statement、目标 repo 文件、目标行、正确 patch、隐藏任务计划、harness command recipe 或评测员验收清单；evaluation record 必须保存 exact prompt text 或 digest 作为 prompt purity 证据。

### Requirement: Evaluated CLI Owns Collection Decomposition Execution And Verification / 被测 CLI 自己负责收集拆解执行与验证

Once the entry prompt is sent, the evaluated CLI SHALL be responsible for resolving benchmark context, decomposing the task, invoking tools, mutating the benchmark repository, collecting outputs, running verification, and reporting the result through product capabilities.

入口 prompt 发出后，被测 CLI 必须通过产品能力自己负责解析 benchmark context、拆解任务、调用工具、修改 benchmark repository、采集输出、运行验证并报告结果。

#### Scenario: Missing autonomous step is scored as evidence / 缺失自主步骤计为证据

- **WHEN** a CLI run cannot determine the requested benchmark instance, cannot prepare or locate the repository, cannot choose the next tool call, cannot collect a patch, or cannot run the verifier
- **THEN** the run is not repaired by injecting missing decomposition into the prompt
- **AND** the evaluation classifies the failure as a product gap, tool gap, environment gap, adapter gap, or model capability failure using available audit evidence
- **中文** 当 CLI run 无法确定请求的 benchmark instance、无法准备或定位 repository、无法选择下一步 tool call、无法采集 patch 或无法运行 verifier 时，不得通过向 prompt 注入缺失拆解来修复本次 run；evaluation 必须根据可用 audit evidence 将失败分类为 product gap、tool gap、environment gap、adapter gap 或 model capability failure。

### Requirement: Evaluator Repairs Frameworks Without Solving Benchmark Tasks / 评测员修框架但不代做 Benchmark 任务

The evaluator SHALL NOT solve the benchmark task for the evaluated CLI, but MAY repair reusable DeepSeek CLI framework defects with tests and rerun the same user prompt against a clean benchmark workspace.

评测员不得替被测 CLI 解 benchmark task，但可以用测试修复可复用 DeepSeek CLI 框架缺陷，并用同一个用户 prompt 在干净 benchmark workspace 上重跑。

#### Scenario: Framework fix reruns same prompt / 框架修复后使用同一 Prompt 重跑

- **WHEN** a run fails because of a reusable CLI defect such as a tool schema gap, sandbox policy bug, repo execution bug, adapter bug, credential routing bug, or verifier integration bug
- **THEN** the evaluator may change CLI product code under normal OpenSpec and test-first governance
- **AND** the next measured run uses the same entry prompt, a clean benchmark repository checkout, and new run evidence linked to the framework fix
- **AND** the evaluator must not manually edit the benchmark repository, provide the expected source change, or change the entry prompt to include task-specific hints
- **中文** 当 run 因可复用 CLI 缺陷失败，例如 tool schema gap、sandbox policy bug、repo execution bug、adapter bug、credential routing bug 或 verifier integration bug 时，评测员可以按正常 OpenSpec 与 test-first governance 修改 CLI 产品代码；下一次被计分 run 必须使用同一个入口 prompt、干净 benchmark repository checkout，并把新 run evidence 链接到框架修复；评测员不得手动编辑 benchmark repository、提供预期源码改动，或修改入口 prompt 加入题目专用提示。

#### Scenario: Neutral execution envelope may widen budget / 中性执行信封可以扩大预算

- **WHEN** the entry prompt names a task family such as SWE-bench Lite but does not include hidden decomposition or solution hints
- **THEN** the CLI may classify the task as an evaluation task and widen provider output, model-iteration, tool-call, timeout, or output-record budgets for that task family
- **AND** the widened envelope must not encode the resolved instance id, target repository file, target line, correct patch, hidden task plan, verifier command recipe, or evaluator acceptance checklist
- **中文** 当入口 prompt 指明 SWE-bench Lite 这类任务族但不包含隐藏拆解或解题提示时，CLI 可以把任务归类为 evaluation task，并为该任务族扩大 provider output、model-iteration、tool-call、timeout 或 output-record 预算；扩大的执行信封不得编码已解析 instance id、目标 repo 文件、目标行、正确 patch、隐藏任务计划、verifier command recipe 或评测员验收清单。

#### Scenario: Focused verification can satisfy delivery / Focused Verification 可满足交付

- **WHEN** a SWE-style run has a source diff and focused verification evidence for the target behavior
- **THEN** the CLI may complete with the focused proof and report any broad-suite or dependency setup failures as verification gaps
- **AND** it should not keep installing optional dependencies or running broad suites unless the focused evidence contradicts the claimed fix
- **中文** 当 SWE 类 run 已经具备 source diff 与目标行为的 focused verification evidence 时，CLI 可以使用 focused proof 完成交付，并将 broad-suite 或 dependency setup 失败报告为 verification gap；除非 focused evidence 与 claimed fix 矛盾，否则不应继续安装 optional dependency 或反复运行 broad suite。

#### Scenario: Product upgrade guidance follows the same boundary / 产品升级指导遵守同一边界

- **WHEN** a maintainer evaluates a coding agent by asking it to update or upgrade the CLI product
- **THEN** the entry prompt may state the product goal, affected product area, or user-facing problem
- **AND** the evaluated agent must discover impacted files, plan implementation, edit code, run verification, and report evidence through its own capabilities
- **AND** a maintainer may repair reusable framework gaps discovered during the run, but must not convert the next prompt into a hidden implementation script or provide task-specific file/line/patch instructions as measured-agent input
- **中文** 当维护者通过要求 coding agent 更新或升级 CLI 产品来评测它时，入口 prompt 可以说明产品目标、受影响产品区域或用户问题；被测 agent 必须通过自身能力发现受影响文件、规划实现、编辑代码、运行验证并报告证据；维护者可以修复运行中发现的可复用框架缺口，但不得把下一次 prompt 转成隐藏实现脚本，也不得把题目专用文件、行号或 patch 指令作为被测 agent 输入。

### Requirement: Evaluation Reports Show Audit Trails Without Hidden Reasoning / 评测报告展示审计轨迹但不展示隐藏推理

CLI task-completion evaluation SHALL expose auditable execution traces for what the CLI did while excluding hidden chain-of-thought, raw provider reasoning, raw model request bodies, raw model responses, and secrets.

CLI task-completion evaluation 必须暴露 CLI 做了什么的可审计执行轨迹，同时排除 hidden chain-of-thought、raw provider reasoning、raw model request bodies、raw model responses 与 secrets。

#### Scenario: Trace explains run progress and breakpoints / Trace 解释运行进展与断点

- **WHEN** an evaluated CLI run completes, fails, times out, or is interrupted
- **THEN** the evaluation evidence includes bounded records for prompt digest, plan summary when available, tool calls, tool results, repository diff summary, verifier command/result, retries, failure classification, and rerun linkage
- **AND** the evidence must not expose hidden chain-of-thought or raw provider reasoning
- **中文** 当被测 CLI run 完成、失败、超时或中断时，evaluation evidence 必须包含有界记录：prompt digest、可用时的 plan summary、tool calls、tool results、repository diff summary、verifier command/result、retries、failure classification 与 rerun linkage；evidence 不得暴露 hidden chain-of-thought 或 raw provider reasoning。

#### Scenario: Final grounding uses bounded tool-result evidence / 最终 Grounding 使用有界工具结果证据

- **WHEN** the CLI final answer cites a code line, diff snippet, test result, command outcome, or file content discovered through a governed tool call during the run
- **THEN** final evidence grounding may use the bounded, redacted tool-result preview already returned to the model and recorded in the audit trail
- **AND** Markdown/check-mark summaries of test names and pass status may be grounded from equivalent `test_name: PASS` style tool-result evidence
- **AND** the run must not be rejected as an unsupported claim solely because that evidence was not part of the initial pre-dispatch evidence selection
- **AND** grounding must not reopen raw command output, hidden caches, secrets, or unbounded provider responses
- **中文** 当 CLI 最终答案引用运行过程中通过受治理工具调用发现的 code line、diff snippet、test result、command outcome 或 file content 时，最终 evidence grounding 可以使用已经返回给模型并记录在 audit trail 中的有界、脱敏 tool-result preview；Markdown/勾选形式的测试名称与通过状态总结，可以由等价的 `test_name: PASS` 类 tool-result evidence 支撑；不得仅因为该 evidence 不属于模型调度前的 initial evidence selection 就把 run 判为 unsupported claim；grounding 不得重新打开 raw command output、hidden cache、secret 或无限 provider response。

#### Scenario: Internal evaluation artifacts are not model-visible evidence / 内部评测产物不能作为模型可见证据

- **WHEN** a measured run uses model-visible workspace tools such as file read, glob, or text search
- **THEN** prior evaluation traces, prediction files, harness reports, historical benchmark run outputs, `.pytest_cache`, `__pycache__`, and local virtualenv internals such as `.venv` are filtered or rejected as internal artifacts
- **AND** full-access tool projection may still allow repository mutation, process execution, and verification commands, but it must not expose evaluator-side answer artifacts through model-visible tools or shell path references
- **AND** the evaluated CLI may still use governed product adapters or clean benchmark repositories to discover and execute the task
- **AND** repo-local shell execution may still use `.venv`, including workspace-contained absolute `.venv` paths, for dependency setup and verification when governed by the tool policy
- **中文** 当被计分 run 使用模型可见 workspace 工具，例如 file read、glob 或 text search 时，历史 evaluation trace、prediction file、harness report、旧 benchmark run output、`.pytest_cache`、`__pycache__` 与 `.venv` 等本地 virtualenv 内部文件必须作为内部产物被过滤或拒绝；full-access tool projection 仍可允许 repository mutation、process execution 与 verification command，但不得通过模型可见工具或 shell path reference 暴露评测侧答案产物；被测 CLI 仍可通过受治理的产品 adapter 或干净 benchmark repository 发现并执行任务；受工具策略治理时，repo-local shell execution 仍可使用 `.venv`，包括 workspace 内绝对 `.venv` 路径，做依赖安装与验证。

#### Scenario: Workspace-contained absolute paths are repaired / Workspace 内绝对路径可修复

- **WHEN** a model-authored tool call provides an absolute path or `cwd` that resolves inside the active workspace root
- **THEN** tool-intent preflight repairs it to an executor-safe workspace-relative value and records the repair
- **AND** absolute paths outside the workspace remain rejected before execution
- **中文** 当模型生成的 tool call 提供的 absolute path 或 `cwd` 可解析到 active workspace root 内时，tool-intent preflight 必须将其修复为 executor-safe workspace-relative value 并记录 repair；workspace 外 absolute path 仍必须在执行前拒绝。
