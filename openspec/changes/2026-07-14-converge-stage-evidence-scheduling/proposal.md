# Converge Stage Evidence Scheduling

## Why / 背景

Live SWE-bench runs exposed a generic scheduling defect rather than a task-specific solver gap. A reviewed change stage continued executing source inspection that was not model-visible, repeated searches with equivalent results consumed the whole stage budget, and a child that produced no patch ended the outer run without using the remaining supervised attempts. A naive one-call inspection limit would also regress a previously successful task that legitimately extended a bounded read over the same source file.

实时 SWE-bench 运行暴露的是通用调度缺陷，而不是特定题目的求解缺口。已 review 的 change stage 继续执行未向模型展示的 source inspection；结果等价的重复搜索消耗了整个 stage budget；child 未生成 patch 时，outer run 没有使用剩余 supervised attempts 就直接结束。简单限制为一次 inspection 调用还会使已通过任务回归，因为该任务确实需要对同一源码文件扩展 bounded read 范围。

## What Changes / 变更内容

- Add a runtime-owned, progress-aware focused evidence window for governed mutation stages.
- Execute only model-visible capabilities and open recovery explicitly on the following model turn.
- Distinguish novel file-range coverage from duplicate search/read evidence.
- Normalize focused recovery searches to content output.
- Bound focused evidence by the remaining configured stage budget while allowing novel continuation reads and reviewed package-scoped searches.
- Treat zero-test verification, including ANSI-colored deselection output, as incomplete until a safe problem reproduction succeeds in the governed checkout.
- Retry model-owned pre-harness generation failures within the configured supervised-attempt budget.
- Preserve authoritative official-harness failure evidence across an intervening pre-harness failure.
- Preserve exact-target mutation recovery, verification repair, and transactional best-candidate restoration.

- 为受治理 mutation stage 增加 runtime-owned、progress-aware 的 focused evidence window。
- 仅执行 model-visible capabilities，并在下一次模型轮次显式打开 recovery。
- 区分新增文件范围覆盖与重复 search/read evidence。
- 将 focused recovery search 归一化为 content output。
- 使用当前 stage 的剩余配置预算限制 focused evidence，同时允许具有新增覆盖的连续读取与已 review package 范围搜索。
- 将零测试验证（包括带 ANSI 色彩的 deselection 输出）视为未完成，直到在受治理 checkout 中成功执行安全问题复现。
- 在配置的 supervised-attempt budget 内重试 model-owned pre-harness generation failure。
- 在中间出现 pre-harness failure 时继续保留权威 official-harness failure evidence。
- 保留 exact-target mutation recovery、verification repair 与事务式最佳候选恢复。

## Capabilities / 影响能力

- `workflow-orchestration`: generic stage convergence, evidence novelty, and recovery-window governance.
- `core-coding-tools`: focused search normalization and structured evidence identity.
- `cli-task-completion-evaluation`: retry classification for pre-harness child failures.

- `workflow-orchestration`：通用 stage convergence、evidence novelty 与 recovery-window governance。
- `core-coding-tools`：focused search 归一化与结构化 evidence identity。
- `cli-task-completion-evaluation`：pre-harness child failure 的重试分类。

## Non-Goals / 非目标

- Do not encode SWE task ids, repositories, source symbols, or expected patches.
- Do not guarantee that a stochastic model produces a correct patch.
- Do not reopen unrestricted understanding after a mutation stage begins.
- Do not change ordinary non-governed chat/tool workflows.

- 不编码 SWE task id、repository、source symbol 或 expected patch。
- 不保证随机模型一定生成正确 patch。
- 不在 mutation stage 开始后重新开放无限制 understanding。
- 不改变普通 non-governed chat/tool workflow。
