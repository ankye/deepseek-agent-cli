# Isolate SWE-bench Agent Runs

SWE-bench live scoring must measure the DeepSeek CLI agent on the requested run, not on stale evaluator artifacts left by previous attempts. The latest GLM live probe showed the agent could operate shell tools autonomously, but the task flow exposed `.deepseek/swebench-workspaces` as a visible root and the shell boundary allowed direct historical workspace traversal. A short prompt for "SWE-bench Lite 第 2 题" therefore drifted into an old `astropy__astropy-12907` checkout, spent 48 model iterations there, never called the environment preparation capability, and failed on model-iteration-limit.

SWE-bench live 跑分必须衡量 DeepSeek CLI agent 对本次请求的执行能力，而不是衡量它是否会捡到历史评测残留。最新 GLM live probe 证明 agent 已能自主操作 shell 工具，但 task flow 把 `.deepseek/swebench-workspaces` 暴露成可见 root，shell 边界也允许直接进入历史 workspace。结果短 prompt 请求 “SWE-bench Lite 第 2 题” 时漂移到了旧的 `astropy__astropy-12907` checkout，在其中消耗 48 次模型迭代，未调用环境准备能力，并以 model-iteration-limit 失败。

## Scope

- Remove historical SWE-bench workspace paths from model-facing short-prompt task guidance so stale directories are not advertised.
- Add a runtime task-scope guard that rejects model tool inputs containing historical SWE-bench workspace paths before kernel execution.
- Require SWE-bench short-prompt execution to flow through governed run-scoped evaluation capabilities or diagnostics adapters.
- Require governed SWE-bench runs to execute the official harness after prediction and surface unresolved scores as failed evidence, not as a successful patch-only completion.
- Require official harness reports to be fresh for the current evaluation run so stale `logs/run_evaluation/.../report.json` artifacts cannot be reused as current scores.
- Require supervised child traces to classify missing model-authored verification commands so batch scoring can distinguish "agent never tested" from "tested but failed official harness."
- Add a runtime SWE-bench source-inspection gate that consumes verification budget and feeds back `SWE_BENCH_SOURCE_INSPECTION_GATE` when a managed child loop spends too many read/search/list tool calls without producing source edit or test progress.
- Add a runtime SWE-bench verification gate that consumes verification budget and feeds back `SWE_BENCH_VERIFICATION_GATE` when a managed child loop keeps using shell commands without starting either a standard shell test command or first-class `core.test.run` verification.
- Add a runtime SWE-bench environment blocker gate that consumes verification budget and feeds back `SWE_BENCH_ENVIRONMENT_BLOCKER_GATE` when a managed child loop has already edited and tested but keeps drifting into dependency setup.
- Enforce SWE-bench gates at tool execution time: after the source-inspection gate, additional read/search/list calls are rejected before kernel execution; after the verification gate, non-test shell calls are rejected before kernel execution; after the environment blocker gate, dependency setup/probing shell calls are rejected before kernel execution.
- Add an executable agentic evaluation blocker catalog with at least 100 real failure modes so live-run failures become machine-readable test findings instead of human-only JSONL review.
- Add a supervised repair attempt after unresolved official harness results so DeepSeek CLI can revise the same checkout from failing-test feedback before the run is scored final.
- Add capability-owned batch scheduling through `taskNumbers`, `resume`, persisted per-task summaries, and aggregate resolved/unresolved scoring so large runs do not depend on model-authored loops.
- Add framework-owned SWE-bench Lite range normalization so a short user prompt such as "第 2 到第 4 题" can repair a model's single-task `core.swe.bench.run` call into a batch `taskNumbers` call.
- Use fresh default governed run ids when the model omits `runId` so repeated live probes do not mix new traces and summaries with old evidence; explicit `runId` remains available for deliberate resume workflows.
- Use stable default campaign run ids when the model asks for `resume` without an explicit `runId` so long batch scoring can intentionally reuse per-task summaries.
- Persist batch progress after every child task and expose per-task states so interrupted 200-instance campaigns have auditable recovery evidence before the final batch summary is complete.
- Surface provider cache metrics from child traces into governed run and batch summaries so the 90% cache-hit target is visible at the same scoring layer as resolved-rate evidence.
- Split cache evidence into provider token cache SLO metrics and context projection cache observability metrics so the 90% target gates the correct cache layer.
- Treat governed SWE-bench execution as a long-running tool budget instead of a normal short tool timeout so repair attempts plus official harness evaluation can return structured evidence instead of scheduler timeout.
- Run model-authored bash shell syntax with `pipefail` so pipeline commands cannot hide failed setup, build, or test steps from the agent.
- Keep tool-level shell boundaries as a second layer for direct model-authored shell traversal into `.deepseek/swebench-workspaces/*/repo`.
- Preserve the evaluator boundary: the supervisor records evidence and fixes CLI framework behavior, but does not manually prepare workspaces or solve SWE instances.
- Track `src/apps/cli/src/diagnostics/swe-bench-prediction.ts` and `src/apps/cli/src/host/swe-bench-run-capabilities.ts` as temporary split-plan debt until prediction, official harness evaluation, and batch run orchestration responsibilities are extracted into separate owner modules.

## 范围

- 从短 prompt 任务指导中移除面向模型的历史 SWE-bench workspace 路径，避免宣传 stale directories。
- 增加 runtime task-scope guard，在进入 kernel 前拒绝包含历史 SWE-bench workspace 路径的模型工具输入。
- 要求 SWE-bench 短 prompt 执行进入受管的 run-scoped evaluation capability 或 diagnostics adapter。
- 要求受管 SWE-bench run 在 prediction 后执行 official harness，并把 unresolved score 暴露为 failed evidence，而不是把仅产出 patch 视为成功完成。
- 要求 official harness report 必须属于当前 evaluation run，避免 stale `logs/run_evaluation/.../report.json` artifact 被复用成当前分数。
- 要求受监督 child trace 对缺失模型自发 verification command 的情况做分类，使批量跑分能区分 “agent 从未测试” 与 “测试过但 official harness 失败”。
- 增加 runtime SWE-bench source-inspection gate：当 managed child loop 把过多 read/search/list tool call 消耗在源码探索上，却没有源码编辑或测试进展时，消耗 verification budget 并反馈 `SWE_BENCH_SOURCE_INSPECTION_GATE`。
- 增加 runtime SWE-bench verification gate：当 managed child loop 持续使用 shell command，却没有启动 standard shell test command 或一等 `core.test.run` 验证时，消耗 verification budget 并反馈 `SWE_BENCH_VERIFICATION_GATE`。
- 增加 runtime SWE-bench environment blocker gate：当 managed child loop 已经编辑并测试，却继续漂移到依赖准备时，消耗 verification budget 并反馈 `SWE_BENCH_ENVIRONMENT_BLOCKER_GATE`。
- 在工具执行时强制 SWE-bench gate：source-inspection gate 之后，继续 read/search/list 必须在 kernel 执行前被拒绝；verification gate 之后，非测试 shell 调用必须在 kernel 执行前被拒绝；environment blocker gate 之后，依赖准备/探测类 shell 调用必须在 kernel 执行前被拒绝。
- 增加至少 100 个真实失败模式的可执行 agentic evaluation blocker catalog，使 live-run failure 变成机器可读测试发现，而不是只能人工翻 JSONL。
- 在 official harness unresolved 后增加受监督 repair attempt，让 DeepSeek CLI 基于失败测试反馈在同一 checkout 中自主二次修补，然后再给最终分。
- 增加 capability 层拥有的批量调度：通过 `taskNumbers`、`resume`、持久化 per-task summary 与 resolved/unresolved 聚合评分支持大规模运行，不依赖模型自己写循环。
- 增加框架层拥有的 SWE-bench Lite 范围归一：当短用户 prompt 明确包含 “第 2 到第 4 题” 时，即使模型只调用单题 `core.swe.bench.run`，preflight 也能修复成批量 `taskNumbers` 调用。
- 当模型省略 `runId` 时使用 fresh 默认受管 run id，避免重复 live probe 将新 trace/summary 与旧证据混在一起；显式 `runId` 仍用于有意的 resume workflow。
- 当模型请求 `resume` 但未显式提供 `runId` 时，使用稳定的默认 campaign run id，使长批量跑分可以有意复用 per-task summary。
- 每个 child task 完成后持久化 batch progress，并暴露 per-task states，使 200-instance campaign 即使中断，也能在最终 batch summary 完成前拥有可审计恢复证据。
- 将 child trace 中的 provider cache 指标汇入受管 run 与 batch summary，使 90% cache-hit target 与 resolved-rate evidence 出现在同一评分层。
- 将 cache evidence 拆成 provider token cache SLO 指标与 context projection cache 可观测指标，让 90% 目标 gate 正确的 cache 层级。
- 将受管 SWE-bench 执行视为 long-running tool budget，而不是普通短工具 timeout，确保 repair attempt 与 official harness evaluation 能返回结构化证据，而不是被 scheduler timeout 截断。
- 使用 `pipefail` 执行模型编写的 bash shell syntax，避免 pipeline command 隐藏 setup、build 或 test step 的失败。
- 保留 tool-level shell boundary 作为第二层，拦截模型直接通过 shell 进入 `.deepseek/swebench-workspaces/*/repo`。
- 保持评测边界：监督者只记录证据并修复 CLI 框架行为，不手工准备 workspace 或替 agent 解 SWE 题。
- 将 `src/apps/cli/src/diagnostics/swe-bench-prediction.ts` 与 `src/apps/cli/src/host/swe-bench-run-capabilities.ts` 记录为临时 split-plan debt，直到 prediction、official harness evaluation 与 batch run orchestration 职责被拆入独立 owner modules。
