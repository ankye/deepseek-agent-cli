# Agentic Evaluation Boundary Design

## Boundary Model

The evaluated system is DeepSeek CLI plus its product capabilities: prompt assembly, context collection, tool execution, repo mutation, verification, diagnostics, and reporting. The evaluator is outside the measured system. The evaluator may start a run with a user-realistic entry prompt and a configured execution envelope, then observe and score the result.

被测系统是 DeepSeek CLI 及其产品能力：prompt assembly、context collection、tool execution、repo mutation、verification、diagnostics 与 reporting。评测员位于被测系统外部。评测员可以用真实用户风格入口 prompt 与配置好的执行信封启动一次 run，然后观察并评分结果。

## Entry Prompt Purity

For SWE-bench Lite style tests, the prompt sent to the CLI should look like a real user request, for example: `给我完成 SWE-bench Lite 第 1 题测试，跑通并告诉我结果。` The prompt may identify the benchmark family and requested item, but it must not include pre-collected instance metadata, correct patch locations, expected code changes, hidden decomposition, harness command recipes, or evaluator-authored acceptance criteria.

对于 SWE-bench Lite 这类测试，发送给 CLI 的 prompt 应该像真实用户请求，例如：`给我完成 SWE-bench Lite 第 1 题测试，跑通并告诉我结果。` prompt 可以指明 benchmark family 与请求的题号，但不得包含预收集 instance metadata、正确 patch 位置、预期代码改动、隐藏拆解、harness command recipe 或评测员编写的验收标准。

## Execution Envelope

The evaluator may configure a neutral execution envelope around the prompt, such as provider, model, tool projection, timeout, and task-family budget. The envelope may let the CLI recognize that a SWE-bench prompt needs enough planning and tool-call budget to run, but it must not carry resolved instance metadata, target files, expected patches, harness recipes, or hidden decomposition.

评测员可以在 prompt 外配置中性的执行信封，例如 provider、model、tool projection、timeout 与 task-family budget。执行信封可以让 CLI 识别 SWE-bench prompt 需要足够的规划和工具调用预算来运行，但不得携带已解析 instance metadata、目标文件、预期 patch、harness recipe 或隐藏拆解。

## Autonomy Requirement

The CLI owns the work after the prompt is sent. It must discover which instance is meant, prepare or locate benchmark assets, inspect the repository, decide the plan, call tools, mutate the repo, collect the patch, run the official or configured verifier, and summarize the result. If it cannot do one of those steps, that is evidence: product gap, environment gap, tool gap, or model capability failure.

prompt 发出后，工作归 CLI 自己负责。它必须自己识别题目实例、准备或定位 benchmark 资产、检查 repository、决定计划、调用工具、修改 repo、采集 patch、运行官方或配置的 verifier，并总结结果。如果某一步做不到，这就是证据：product gap、environment gap、tool gap 或 model capability failure。

## Evaluator Intervention

When the CLI runs off course, the evaluator may inspect the audit trail and classify the failure. If the issue is reusable product infrastructure, the evaluator may fix CLI code with tests and OpenSpec evidence, then rerun the same entry prompt against a clean workspace. The evaluator must not manually patch the benchmark repo, provide corrective task hints, select the target source line for the CLI, or change the prompt to include missing decomposition.

当 CLI 跑偏时，评测员可以检查审计轨迹并分类失败。如果问题属于可复用产品基础设施，评测员可以用测试与 OpenSpec 证据修复 CLI 代码，然后用同一个入口 prompt 在干净 workspace 上重跑。评测员不得手动修改 benchmark repo、提供纠偏题目提示、替 CLI 选择目标源码行，或通过修改 prompt 补上缺失拆解。

## Product Upgrade Analogy

The same boundary applies when a maintainer guides a coding agent such as Codex or DeepSeek CLI to update or upgrade the product. The human-level instruction names the goal, for example "upgrade the CLI evaluation boundary", while the agent must inspect the project, discover affected files, plan changes, implement, and verify. If the agent lacks a product capability needed to complete that goal, the maintainer fixes the reusable framework capability and reruns the same goal-level instruction instead of turning the prompt into a line-by-line implementation script.

同样的边界也适用于维护者指导 Codex 或 DeepSeek CLI 进行产品更新升级。人类级指令只命名目标，例如“升级 CLI 评测边界”，agent 必须自己检查项目、发现受影响文件、规划改动、实现并验证。如果 agent 缺少完成目标所需的产品能力，维护者修复可复用框架能力，并用同一个目标级指令重跑，而不是把 prompt 改写成逐行实现脚本。

## Visibility Without Hidden Reasoning

Evaluation reports should show what the CLI did: prompt digest, plan summary, tool calls, tool outcomes, repo changes, verifier command, verifier result, retries, and failure classification. Reports must not expose hidden chain-of-thought or raw provider reasoning; visible reasoning is an audit summary, not a transcript of private model cognition.

评测报告应该展示 CLI 做了什么：prompt digest、plan summary、tool calls、tool outcomes、repo changes、verifier command、verifier result、retries 与 failure classification。报告不得暴露 hidden chain-of-thought 或 raw provider reasoning；visible reasoning 是审计摘要，不是私有模型认知 transcript。

## Runtime Evidence Grounding

Final answer acceptance must be grounded against both pre-dispatch project evidence and bounded runtime tool-result evidence. Tool-result evidence is the same redacted, size-limited preview that was already visible to the model and recorded in the audit trail; it must not reopen raw caches or unbounded command output. This prevents a completed run from being rejected only because the final answer cites a diff line, test result, or file content discovered during execution rather than during initial evidence selection.

最终答案验收必须同时使用模型调度前的 project evidence 与有界 runtime tool-result evidence。tool-result evidence 使用已经展示给模型并写入 audit trail 的脱敏、限长 preview；不得重新打开原始 cache 或无限 command output。这样可以避免 run 已经完成修复，却仅因为最终答案引用的是执行过程中发现的 diff line、test result 或 file content，而不是初始 evidence selection 中的内容，就被误判失败。

When the final answer summarizes tests with Markdown names, PASS words, check marks, or Chinese pass wording, grounding may normalize those expressions against test symbols and PASS markers found in the bounded tool-result preview. This is a formatting equivalence for test outcomes, not a relaxation for package, command, release, or secret-sensitive claims.

当最终答案用 Markdown 名称、PASS 字样、勾选符号或中文通过表述总结测试时，grounding 可以将这些表达与有界 tool-result preview 中的测试符号和 PASS 标记做归一化匹配。这只是测试结果表述的格式等价，不放宽 package、command、release 或 secret-sensitive claim 的证据要求。

## Model-Visible Workspace Hygiene

The measured CLI may use clean benchmark workspaces under the product-controlled `.deepseek/swebench-workspaces` area, but model-visible read, list, glob, and search tools must hide evaluator artifacts and runtime caches. Hidden model-visible segments include prior evaluation outputs, harness reports, `.pytest_cache`, `__pycache__`, and local virtual environment internals such as `.venv`. Governed shell execution may still use `.venv` inside the benchmark repository, including workspace-contained absolute `.venv` paths, for dependency setup and verification; the restriction is about model-visible evidence, not about disabling the repo-local test environment.

被测 CLI 可以使用产品控制的 `.deepseek/swebench-workspaces` 下的干净 benchmark workspace，但模型可见的 read、list、glob 与 search 工具必须隐藏评测员产物与运行缓存。模型不可见的 segment 包括历史 evaluation output、harness report、`.pytest_cache`、`__pycache__` 与 `.venv` 等本地 virtual environment 内部文件。受治理的 shell execution 仍可在 benchmark repository 内使用 `.venv`，包括 workspace 内绝对 `.venv` 路径，做依赖安装与验证；这个限制针对模型可见 evidence，不是禁用 repo-local test environment。

## Tool Preflight Repair Boundary

Tool-intent preflight should repair model-authored absolute paths that are provably inside the active workspace root by converting them to executor-safe relative paths. Absolute paths outside the workspace, home-directory paths, parent traversal, null bytes, and ambiguous drive-relative paths remain rejected. This keeps full-access benchmark runs ergonomic without weakening the workspace boundary.

tool-intent preflight 应该将模型生成且可证明位于 active workspace root 内的绝对路径修复为 executor-safe relative path。workspace 外绝对路径、home-directory path、parent traversal、null byte 与 ambiguous drive-relative path 仍必须拒绝。这样可以让 full-access benchmark run 更顺手，同时不削弱 workspace 边界。

## Verification Stop Policy

SWE-style runs should prefer focused proof over open-ended environment setup. Once a focused reproduction or repository test passes for the target behavior and a source diff exists, the CLI should stop chasing broad dependency installation or full-suite execution unless the focused evidence contradicts the claimed fix. Missing optional dependencies or broad-suite environment failures become reported verification gaps, not an instruction to keep spending turns.

SWE 类 run 应优先使用 focused proof，而不是开放式环境搭建。一旦目标行为的 focused reproduction 或 repository test 已通过并且存在 source diff，CLI 应停止继续追 broad dependency installation 或 full-suite execution，除非 focused evidence 与 claimed fix 相互矛盾。缺失 optional dependency 或 broad-suite environment failure 应作为 verification gap 报告，而不是继续消耗轮次的指令。
