# Agentic Evaluation Boundary Design

## Boundary Model

The evaluated system is DeepSeek CLI plus its product capabilities: prompt assembly, context collection, tool execution, repo mutation, verification, diagnostics, and reporting. The evaluator is outside the measured system. The evaluator may start a run with a user-realistic entry prompt and a configured execution envelope, then observe and score the result.

被测系统是 DeepSeek CLI 及其产品能力：prompt assembly、context collection、tool execution、repo mutation、verification、diagnostics 与 reporting。评测员位于被测系统外部。评测员可以用真实用户风格入口 prompt 与配置好的执行信封启动一次 run，然后观察并评分结果。

## Entry Prompt Purity

For SWE-bench Lite style tests, the prompt sent to the CLI should look like a real user request, for example: `给我完成 SWE-bench Lite 第 1 题测试，跑通并告诉我结果。` The prompt may identify the benchmark family and requested item, but it must not include pre-collected instance metadata, correct patch locations, expected code changes, hidden decomposition, harness command recipes, or evaluator-authored acceptance criteria.

对于 SWE-bench Lite 这类测试，发送给 CLI 的 prompt 应该像真实用户请求，例如：`给我完成 SWE-bench Lite 第 1 题测试，跑通并告诉我结果。` prompt 可以指明 benchmark family 与请求的题号，但不得包含预收集 instance metadata、正确 patch 位置、预期代码改动、隐藏拆解、harness command recipe 或评测员编写的验收标准。

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
