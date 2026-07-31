# Stage Evidence Scheduling Convergence Design

## Boundary / 边界

The generic runtime owns stage convergence. It evaluates only structured tool intent, projection state, target scope, result metadata, content digests, covered source ranges, workspace revision, and typed diagnostics. It does not inspect hidden model reasoning and does not infer a task solution. Host adapters configure policy and classify outer attempts but do not implement convergence.

通用 runtime 负责 stage convergence。它只评估结构化 tool intent、projection state、target scope、result metadata、content digest、已覆盖源码范围、workspace revision 与 typed diagnostics。它不读取隐藏模型推理，也不推断任务答案。Host adapter 配置 policy 并分类 outer attempt，但不实现 convergence。

## Focused Evidence Window / 聚焦证据窗口

A reviewed mutation stage starts with its declared mutation capabilities. A request for non-visible source inspection is rejected before execution and may open one explicit focused evidence window for the next model request. The window projects only bounded read/search support plus the stage's mutation tools, is scoped to the rejected target, and derives its operation ceiling from the remaining configured stage tool budget. This preserves a hard upper bound without imposing an unrelated fixed two-operation limit.

已 review 的 mutation stage 以其声明的 mutation capabilities 开始。对 non-visible source inspection 的请求必须在执行前被拒绝，并可为下一次模型请求打开一个显式 focused evidence window。窗口只投影 bounded read/search support 与该 stage 的 mutation tools，范围限定为被拒绝的目标，并根据当前 stage 剩余的已配置 tool budget 确定操作上限。这样既保留硬上限，也不会强加无关的固定两次操作限制。

For reads, novelty is uncovered line-range content for the same path and workspace revision. A larger overlapping read is novel only for the newly covered interval. For searches, novelty is the normalized set of matching path, line, and matching-content digests; changing a glob without changing the result is duplicate evidence. A successful mutation advances the workspace revision so post-mutation evidence is evaluated independently.

对 read，novelty 是同一路径与 workspace revision 下尚未覆盖的行范围内容。更大的重叠读取只有新增覆盖区间属于 novel。对 search，novelty 是归一化的 matching path、line 与 matching-content digest 集合；改变 glob 但结果不变属于 duplicate evidence。成功 mutation 会推进 workspace revision，因此 mutation 后证据独立评估。

A focused content search with matches records normalized result evidence and may be followed by a bounded continuation read while stage budget remains. Bounded reads may extend previously accepted coverage, including a refresh of an already reviewed mutation target. Empty, duplicate, wrong-target, or exhausted evidence closes the window without reopening inspection. Existing exact-target refresh after typed edit precondition failure remains a separate, stricter recovery lane.

带匹配结果的 focused content search 会记录归一化结果证据；只要 stage budget 尚有剩余，之后仍可执行一次 bounded continuation read。Bounded read 可以扩展此前已接纳的覆盖范围，也可以刷新已 review 的 mutation target。空、重复、错目标或已耗尽 evidence 会关闭窗口，不再重新开放 inspection。Typed edit precondition failure 后的 existing exact-target refresh 保持为独立且更严格的 recovery lane。

Target scope includes the rejected target, direct relative dependencies proven by accepted source content, and searches constrained to the direct parent of a reviewed target. A package-scoped glob such as `pkg/**/*.py` is accepted only when it covers a reviewed target or related target in that direct parent. Repository-wide discovery such as `**/*.py` remains wrong-target.

目标范围包括被拒绝的目标、由已接纳源码内容证明的直接相对依赖，以及限定在已 review 目标直接父目录内的搜索。只有当 `pkg/**/*.py` 这类 package-scoped glob 覆盖该直接父目录中的已 review target 或 related target 时才允许执行；`**/*.py` 这类 repository-wide discovery 仍属于 wrong-target。

## Projection And Search Semantics / 投影与搜索语义

The runtime never executes a capability absent from the current model-visible projection. Opening or closing a recovery window updates the next request's projection and emits structured events. Within focused recovery, `core.search.text` is normalized to `outputMode: "content"`; ordinary searches retain their current default file-list behavior.

Runtime 不得执行当前 model-visible projection 中不存在的 capability。打开或关闭 recovery window 会更新下一次请求的 projection，并发出结构化事件。在 focused recovery 中，`core.search.text` 归一化为 `outputMode: "content"`；普通搜索保留当前默认文件列表行为。

## Attempt Classification / Attempt 分类

Every child invocation counts as an attempt. Model-owned pre-harness failures such as empty patch, no source mutation, or governed stage budget exhaustion are retryable while attempt budget remains. Environment, checkout, permission, provider configuration, or unavailable-tool failures are terminal. A retry receives bounded structured feedback and a fresh stage budget. Existing immutable candidate persistence and best-candidate restoration remain authoritative.

每次 child invocation 都计为一次 attempt。Empty patch、无源码修改或受治理 stage budget 耗尽等 model-owned pre-harness failure 在 attempt budget 尚有剩余时可重试。Environment、checkout、permission、provider configuration 或 unavailable-tool failure 属于终态。Retry 获得有界结构化反馈与新的 stage budget。现有不可变 candidate persistence 与最佳候选恢复继续保持权威。

When an official harness has already produced a valid unresolved result, that result remains the authoritative repair source even if the next child stops before harness readiness. The following attempt receives both the latest pre-harness terminal reason and the best candidate's official failing test ids and excerpts.

当 official harness 已产生有效但 unresolved 的结果后，即使下一 child 在达到 harness readiness 前终止，该结果仍是权威 repair source。再下一 attempt 必须同时收到最新 pre-harness terminal reason，以及最佳候选的 official failing test id 与 excerpt。

## Verification Completion / 验证完成条件

Pytest output that executes zero tests is not successful verification. Classification strips ANSI control sequences and recognizes no-tests, zero-collected, and deselected-only summaries. A governed SWE verification with zero executed tests remains open and requires a safe non-mutating reproduction derived from the problem statement.

执行零个测试的 pytest 输出不属于成功验证。分类时必须去除 ANSI 控制序列，并识别 no-tests、zero-collected 与仅 deselected 的摘要。受治理 SWE verification 若执行零个测试，必须保持打开，并要求执行由 problem statement 派生的安全无写入复现。

The host exposes the actual governed checkout root in reproduction feedback. Runtime command normalization may accept `cd <exact workspaceRoot> && <safe command>` as equivalent to running the command in that checkout, while unrelated absolute directories, workspace mutation, and unsafe shell composition remain rejected. Models are instructed to omit redundant absolute `cwd` or `cd` when possible.

Host 在复现反馈中暴露实际受治理 checkout root。Runtime command normalization可以接受 `cd <exact workspaceRoot> && <safe command>`，并将其视为在该 checkout 中执行；无关绝对目录、workspace mutation 与不安全 shell 组合仍必须拒绝。反馈应指示模型尽量省略冗余的绝对 `cwd` 或 `cd`。

## Compatibility / 兼容性

The first implementation keeps existing workflow-graph stage transitions unchanged and applies convergence only to governed staged workflows. Deterministic replay must preserve the successful task-1 path where a second same-target read adds previously uncovered lines, while task-2 replay must reject searches whose normalized match evidence is unchanged.

首个实现保持现有 workflow-graph stage transition 不变，并只对受治理 staged workflow 应用 convergence。确定性 replay 必须保留第一题成功路径，其中第二次同目标 read 新增了此前未覆盖的行；第二题 replay 必须拒绝 normalized match evidence 未变化的搜索。

## Observability / 可观测性

The runtime emits recovery requested, opened, evidence accepted, duplicate rejected, exhausted, and closed events with stage id, target scope, workspace revision, operation counts, and redacted evidence fingerprints. The SWE summary records pre-harness retry reasons separately from official harness repair reasons.

Runtime 发出 recovery requested、opened、evidence accepted、duplicate rejected、exhausted 与 closed events，包含 stage id、target scope、workspace revision、operation count 与脱敏 evidence fingerprint。SWE summary 分别记录 pre-harness retry reason 与 official harness repair reason。

## Verification / 验证

Implementation begins with failing focused tests. Acceptance includes deterministic task-1 and task-2 trace-shaped regressions, runtime routing tests, search-tool tests, SWE attempt tests, repository verification, and live task-1/task-2 canaries after all deterministic checks pass. Live stochastic resolution is evidence, while deterministic scheduling invariants are the release gate.

实现从失败的 focused tests 开始。验收包括确定性的第一题与第二题 trace-shaped regressions、runtime routing tests、search-tool tests、SWE attempt tests、repository verification，以及全部确定性检查通过后的第一题/第二题 live canary。Live 随机 resolution 是证据，确定性调度 invariant 才是 release gate。
