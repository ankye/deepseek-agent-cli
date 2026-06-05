# Define Agentic Evaluation Boundary

## Why

DeepSeek CLI evaluation must measure what the CLI can do from a realistic user request, not what an external orchestrator can pre-solve and feed into the model. Recent SWE-bench Lite probing proved the adapter and repo execution path can work, but the evaluation contract still needs to define who is allowed to provide the entry prompt, who owns task discovery and decomposition, and when a maintainer may repair product code without contaminating the measured run.

DeepSeek CLI 评测必须衡量 CLI 从真实用户请求出发能完成什么，而不是衡量外部编排者把任务预先拆好再喂给模型的能力。最近 SWE-bench Lite probe 已证明 adapter 与 repo execution path 可以跑通，但评测合同仍需要定义：谁能提供入口 prompt、谁负责任务发现与拆解，以及维护者何时可以修复产品代码而不污染被测 run。

## What Changes

- Define user-realistic entry prompts as the only task instruction sent to the evaluated CLI.
- Require the evaluated CLI to collect benchmark context, decompose the work, execute tools, verify, and report by itself.
- Define evaluator intervention boundaries: observe, classify, and fix reusable CLI framework bugs, but do not solve benchmark tasks or inject task-specific hints.
- Require reruns after framework fixes to use the same entry prompt and a clean benchmark workspace.
- Require visible audit trails for plan/tool/result/failure/retry evidence without exposing hidden reasoning.

- 将真实用户风格短 prompt 定义为发送给被测 CLI 的唯一任务指令。
- 要求被测 CLI 自己收集 benchmark 上下文、拆解工作、执行工具、验证并报告。
- 定义评测员干预边界：可以观察、分类、修复可复用 CLI 框架缺陷，但不得代做 benchmark task 或注入题目专用提示。
- 要求框架修复后的重跑使用同一个入口 prompt 与干净 benchmark workspace。
- 要求暴露 plan/tool/result/failure/retry 的可审计轨迹，但不暴露隐藏 reasoning。

## Non-Goals

- Do not implement the full SWE-bench batch runner in this change.
- Do not change provider-specific model behavior or benchmark scoring math.
- Do not require exposing chain-of-thought or raw provider reasoning.
- Do not prohibit evaluator-authored acceptance criteria for external scoring; prohibit sending those criteria as hidden task-solving instructions to the evaluated CLI.

- 本变更不实现完整 SWE-bench batch runner。
- 不改变 provider-specific model 行为或 benchmark scoring 计算。
- 不要求暴露 chain-of-thought 或 raw provider reasoning。
- 不禁止评测侧编写外部评分验收标准；禁止把这些标准作为隐藏解题指令发送给被测 CLI。
