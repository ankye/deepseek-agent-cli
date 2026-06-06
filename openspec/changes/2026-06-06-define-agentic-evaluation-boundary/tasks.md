# Tasks

- [x] 1. Define the agentic evaluation boundary in OpenSpec proposal and design notes.
- [x] 2. Add CLI task-completion evaluation deltas for entry prompt purity, autonomous execution, evaluator intervention, and visible audit trails.
- [x] 3. Validate the active OpenSpec change and canonical specs.
- [x] 4. Commit the OpenSpec boundary change.
- [x] 5. Add test-first framework repair for SWE-bench prompt classification and neutral expanded execution envelope.
- [x] 6. Add test-first filtering for model-visible internal evaluation artifacts.
- [x] 7. Add test-first runtime grounding for final answers that cite bounded tool-result evidence.
- [x] 8. Add test-first filtering for benchmark-local `.pytest_cache`, `.venv`, and `__pycache__` from model-visible file tools.
- [x] 9. Rerun the same short SWE-bench Lite prompt against a clean benchmark workspace and record evidence.
- [x] 10. Add test-first preflight repair for workspace-contained absolute tool paths while preserving outside-path rejection.
- [x] 11. Add SWE task-flow stop guidance after focused verification passes and a source diff exists.

# 任务

- [x] 1. 在 OpenSpec proposal 与 design notes 中定义 agentic evaluation boundary。
- [x] 2. 为 CLI task-completion evaluation 增加入口 prompt 纯度、自主执行、评测员干预与可见审计轨迹的 delta。
- [x] 3. 校验 active OpenSpec change 与 canonical specs。
- [x] 4. 提交 OpenSpec 边界变更。
- [x] 5. 用 test-first 方式修复 SWE-bench prompt 分类与中性扩展执行信封。
- [x] 6. 用 test-first 方式过滤模型可见的内部评测产物。
- [x] 7. 用 test-first 方式支持最终答案引用有界 tool-result evidence 的 runtime grounding。
- [x] 8. 用 test-first 方式将 benchmark 本地 `.pytest_cache`、`.venv` 与 `__pycache__` 从模型可见文件工具中过滤。
- [x] 9. 使用同一个 SWE-bench Lite 短 prompt 在干净 benchmark workspace 上重跑，并记录证据。
- [x] 10. 用 test-first 方式支持 workspace 内绝对 tool path 的 preflight 修复，同时保持 workspace 外路径拒绝。
- [x] 11. 增加 focused verification 已通过且存在 source diff 后的 SWE task-flow 停止指引。

## Acceptance Evidence / 验收证据

- `../deepseek-agent-cli-evaluation-artifact-archive/current-runs/swe-lite-1-short-prompt-toolgrounding-20260606-125651.jsonl`: same short prompt, GLM `glm-5.1`, `--tool-projection all`, clean benchmark checkout; final `agent.loop.completed`, exit code 0, 44 model requests, 43 tool results, second final grounding `unsupportedClaimCount=0`.
- Benchmark repo diff after the run changes only `astropy/modeling/separable.py` and `astropy/modeling/tests/test_separable.py`; no evaluator-authored benchmark patch was injected.
- Remaining improvement evidence: GLM still spent many turns on Python/dependency verification, hit one tool timeout, and had one `core.test.run` rejection for a workspace-internal absolute path before recovering.
- Follow-up repairs landed from that evidence: workspace-contained absolute `cwd`/path values are repaired by tool-intent preflight, and SWE task flow now instructs the model to stop chasing full dependency setup once focused verification and a diff are available.

- `../deepseek-agent-cli-evaluation-artifact-archive/current-runs/swe-lite-1-short-prompt-toolgrounding-20260606-125651.jsonl`：同一个短 prompt，GLM `glm-5.1`，`--tool-projection all`，干净 benchmark checkout；最终 `agent.loop.completed`，退出码 0，44 次模型请求、43 个工具结果，第二次最终 grounding 的 `unsupportedClaimCount=0`。
- run 后 benchmark repo diff 只修改 `astropy/modeling/separable.py` 与 `astropy/modeling/tests/test_separable.py`；没有注入评测员编写的 benchmark patch。
- 剩余改进证据：GLM 仍在 Python/dependency 验证上消耗较多轮次，出现 1 次 tool timeout，并在恢复前遇到 1 次 workspace 内绝对路径导致的 `core.test.run` 拒绝。
- 已基于该证据落地的后续修复：tool-intent preflight 会修复 workspace 内绝对 `cwd`/path 值；SWE task flow 现在明确要求 focused verification 与 diff 已具备时停止继续追完整依赖安装。
