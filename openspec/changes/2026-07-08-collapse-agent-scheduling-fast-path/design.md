# Scheduling Fast Path Design

## Executive Direction / 技术总监方向

The product target is not "more supervision"; it is faster convergence with fewer ambiguous choices. The runtime should make the correct next action obvious to the model and make incorrect repetition expensive for the scheduler, not for the user.

产品目标不是“更多监督”，而是用更少歧义选择实现更快收敛。runtime 应让模型清楚看到正确下一步，并让错误重复由调度器快速收束，而不是把成本转嫁给用户。

Architecture direction:

架构方向：

1. Keep task/profile as the declarative control plane.
   保持 task/profile 作为声明式控制面。
2. Keep dispatch as the only model-requested tool execution path.
   保持 dispatch 作为模型请求工具的唯一执行路径。
3. Make convergence the only component that chooses continue, correction, recovery, rerun, or terminal.
   让 convergence 成为唯一选择 continue、correction、recovery、rerun 或 terminal 的组件。
4. Add a fast-path projection layer that turns workflow state and board evidence into exactly one model-visible next action.
   增加 fast-path projection layer，把 workflow state 与 board evidence 转成唯一 model-visible next action。
5. Keep technical-director policy as an evidence gate, not a second implementation route and not prompt noise.
   保持 technical-director policy 作为证据 gate，而不是第二条实现路径，也不是 prompt 噪声。

## Fast Path Shape / 快路径形态

For a straightforward repository patch task, the scheduler should naturally project this shape:

对直接的仓库补丁任务，调度器应自然投影出以下形态：

1. Focused evidence: inspect problem-relevant source or tests.
   聚焦证据：检查和问题相关的源码或测试。
2. Mutation: edit or apply patch with material diff evidence.
   修改：执行 edit 或 apply patch，并产生实质 diff 证据。
3. Standard verification: run the declared standard or focused verification command.
   标准验证：运行声明的标准或聚焦验证命令。
4. Package/report: emit patch, prediction, terminal outcome, and evidence summary.
   打包/报告：输出 patch、prediction、终态结果与证据摘要。

This is a scheduling quality target, not a runtime step cap. If the model takes a longer valid path because the task genuinely needs more evidence, the scheduler can allow it. If the model loops without accepted progress, convergence must classify and correct the loop early.

这是调度质量目标，不是 runtime 步数上限。如果任务确实需要更多证据，模型可以走更长的有效路径。如果模型在没有 accepted progress 的情况下循环，convergence 必须及早分类并纠正。

## Single Next Action / 单一下一动作

Every model request in a governed staged workflow must include one authoritative `nextAction` projection derived from:

受治理 staged workflow 中的每次 model request 必须包含一个权威 `nextAction` 投影，其来源包括：

- active stage kind and progress policy;
- active stage kind 与 progress policy；
- accepted board evidence;
- 已接受的 board evidence；
- previous dispatch result and convergence decision;
- 上一次 dispatch result 与 convergence decision；
- failure-analysis next allowed action when present;
- 如果存在 failure-analysis，则使用其 next allowed action；
- visible capability projection for the current stage.
- 当前 stage 的 visible capability projection。

The next action must select one action class: `focused-evidence`, `mutation`, `standard-verification`, `package`, `failure-analysis`, `repair`, `rerun`, `blocker`, or `terminal-report`.

next action 必须选择一个 action class：`focused-evidence`、`mutation`、`standard-verification`、`package`、`failure-analysis`、`repair`、`rerun`、`blocker` 或 `terminal-report`。

When multiple internal components disagree, convergence wins and records why other candidates were suppressed. The model must not see competing instructions such as "verify", "review budget", "inspect more", and "technical-director acceptance pending" at the same priority.

当多个内部组件不一致时，由 convergence 决定，并记录其它候选被抑制的原因。模型不得在同一优先级看到相互竞争的指令，例如同时看到 “verify”、“review budget”、“inspect more” 与 “technical-director acceptance pending”。

## Model-Visible Signal Budget / 模型可见信号预算

The child model-visible prompt should contain only:

child model-visible prompt 应只包含：

- stable framework instructions and tool contracts from the cacheable prefix;
- 来自可缓存前缀的稳定框架指令与工具契约；
- the exact user/task objective;
- 精确 user/task objective；
- current stage and one authoritative next action;
- 当前 stage 与一个权威 next action；
- bounded accepted evidence needed for that next action;
- 当前 next action 所需的有界已接受证据；
- current visible tools.
- 当前可见工具。

The following should stay out of the child prompt unless directly required by the next action:

以下内容不得进入 child prompt，除非被 next action 直接需要：

- cache-hit diagnostics;
- cache-hit diagnostics；
- full historical board records;
- 完整历史 board records；
- technical-director residual risk commentary;
- technical-director residual risk commentary；
- rejected candidate actions that are no longer allowed;
- 已不允许的 rejected candidate actions；
- parent-only orchestration decisions;
- parent-only orchestration decisions；
- raw provider reasoning or unredacted tool output.
- raw provider reasoning 或未脱敏 tool output。

This improves convergence and cache stability at the same time: the stable contract stays in the provider prefix, while dynamic board records remain in the tail and are aggressively summarized.

这会同时提升收敛和缓存稳定性：稳定契约留在 provider prefix，动态 board records 留在 tail 并被积极摘要。

## Recovery Path / 恢复路径

Recovery is not a restart. A failed attempt must enter failure analysis, produce accepted evidence and one `nextAllowedAction`, and the next attempt must start from that action.

Recovery 不是重启。失败 attempt 必须进入 failure analysis，产出已接受证据与一个 `nextAllowedAction`，下一次 attempt 必须从该 action 开始。

Examples:

示例：

- If the previous attempt inspected the right source but made no mutation, recovery starts at mutation.
  如果上一 attempt 已检查正确源码但没有 mutation，恢复从 mutation 开始。
- If mutation happened but verification used a non-standard command, recovery starts at standard verification.
  如果 mutation 已发生但 verification 使用了非标准命令，恢复从 standard verification 开始。
- If verification failed with a useful trace, recovery starts at repair with that bounded trace.
  如果 verification 失败且有有用 trace，恢复从 repair 开始并携带有界 trace。
- If tool projection or environment was broken, recovery blocks model attribution until that cause is proven or fixed.
  如果 tool projection 或 environment 损坏，恢复必须阻止 model attribution，直到该原因被证明或修复。

## Reference Lessons / 参考吸收点

Reference code suggests useful principles, not copy targets:

参考代码提供的是原则，不是复制目标：

- Keep the query loop state small and explicit.
  保持 query loop state 小而明确。
- Partition tool execution separately from model streaming.
  将工具执行分区从模型串流中分离。
- Run safe read-only batches concurrently and unsafe/mutation/process work serially.
  安全只读批次可并发，unsafe/mutation/process 工作串行。
- Track in-progress and terminal tool ids so late or fallback results cannot leak into later turns.
  跟踪 in-progress 与 terminal tool ids，防止 late 或 fallback result 泄漏到后续 turn。
- Snapshot immutable config once per turn and keep dynamic context as data.
  每个 turn 固化一次 immutable config，并把动态上下文作为数据处理。

DeepSeek CLI must implement these principles through its own platform contracts, staged workflows, decision board, and prompt assembly pipeline.

DeepSeek CLI 必须通过自己的 platform contracts、staged workflows、decision board 与 prompt assembly pipeline 实现这些原则。

## Implementation Boundary / 实施边界

The first implementation should be complete enough to show effect:

第一版实现必须足够完整，能体现效果：

- deterministic tests for single next action projection;
- 单一 next action 投影的确定性测试；
- deterministic tests for model-visible signal filtering;
- 模型可见信号过滤的确定性测试；
- deterministic tests for recovery from accepted board next action;
- 从已接受 board next action 恢复的确定性测试；
- deterministic tests proving non-progress cannot issue an ordinary next request without a board/convergence update;
- 证明无进展不能在没有 board/convergence 更新时发起普通下一请求的确定性测试；
- one canary run after tests pass, classified by trajectory evidence.
- 测试通过后运行一个 canary，并用 trajectory evidence 分类。

## Acceptance Standard / 验收标准

Acceptance is evidence-based and has three gates. Passing one gate does not waive the others.

验收基于证据，分三道 gate。通过其中一道不能豁免其它 gate。

### Gate 1: Deterministic Contract Acceptance / 确定性契约验收

The change is acceptable only when deterministic tests prove:

只有确定性测试证明以下行为时，变更才可接受：

- every governed model request has exactly one authoritative next action;
- 每个受治理 model request 恰好只有一个权威 next action；
- conflicting candidate actions are suppressed before model dispatch and recorded on the board;
- 冲突 candidate actions 在 model dispatch 前被抑制，并记录到 board；
- child prompt projection excludes non-immediate governance, cache, technical-director, and stale board noise;
- child prompt projection 排除非 immediate 的 governance、cache、technical-director 与过期 board 噪声；
- failed attempts recover from accepted board `nextAllowedAction`;
- 失败 attempt 从 board 已接受的 `nextAllowedAction` 恢复；
- produce/verify non-progress cannot issue another ordinary model request without convergence and board updates;
- produce/verify 无进展不能在没有 convergence 与 board 更新时发起下一次普通 model request；
- provider behavior uses the same scheduler contracts for GLM, DeepSeek, and future providers.
- GLM、DeepSeek 与未来 provider 使用同一套 scheduler contracts。

Required commands:

必需命令：

- focused unit and contract tests for next-action, convergence, prompt assembly, recovery, and CLI trajectory evaluation;
- next-action、convergence、prompt assembly、recovery 与 CLI trajectory evaluation 的 focused unit/contract tests；
- `npm run typecheck`;
- `npm run typecheck`；
- `npm run build:cli`.
- `npm run build:cli`。

### Gate 2: Canary Trajectory Acceptance / Canary 轨迹验收

The first-task canary is acceptable when the trajectory evidence shows:

第一题 canary 只有在 trajectory evidence 显示以下结果时才可接受：

- terminal outcome is passed, resolved, or otherwise package-successful according to the official runner contract;
- terminal outcome 按官方 runner contract 为 passed、resolved 或其它 package-successful；
- accepted next-action sequence follows the natural shape: focused evidence, mutation, standard verification, package or terminal report;
- accepted next-action sequence 符合自然形态：focused evidence、mutation、standard verification、package 或 terminal report；
- source mutation evidence exists before verification or package acceptance;
- verification 或 package acceptance 前存在 source mutation evidence；
- invalid verification commands are zero, or at most one followed by a corrected `standard-verification` next action;
- invalid verification commands 为 0，或最多 1 次且随后投影纠正后的 `standard-verification` next action；
- duplicate broad discovery does not recur after focused evidence is accepted;
- focused evidence 被接受后不再重复宽泛 discovery；
- model request count is reported as quality evidence and expected to be short for simple tasks, but not enforced as a runtime hard cap;
- model request count 作为质量证据报告；简单任务期望短路径，但不作为 runtime hard cap；
- cache-prefix stability evidence does not show scheduler prompt churn as the primary reason for low cache reuse.
- cache-prefix stability evidence 不显示 scheduler prompt churn 是低缓存复用的主因。

If the canary exceeds the expected short trajectory, the run can still pass only when failure analysis proves the extra steps came from valid task complexity or external environment/harness blockers. Otherwise it is a scheduler defect candidate.

如果 canary 超出预期短轨迹，只有 failure analysis 证明额外步骤来自真实任务复杂度或外部 environment/harness blocker 时，该 run 才能接受。否则必须视为 scheduler defect candidate。

### Gate 3: Prohibited-Behavior Acceptance / 禁止项验收

The implementation is not acceptable if any of these are found:

如果发现以下任一情况，实现不得验收：

- benchmark task-number branches, instance-id branches, known-patch checks, file-name shortcuts, scorer-specific success checks, or provider-specific scheduling policy;
- benchmark task-number branches、instance-id branches、known-patch checks、file-name shortcuts、scorer-specific success checks 或 provider-specific scheduling policy；
- fixed five-step runtime caps presented as scheduling logic;
- 作为调度逻辑存在的固定五步 runtime cap；
- prompt string concatenation inside `agent-loop.ts` that bypasses prompt assembly contracts;
- `agent-loop.ts` 内绕过 prompt assembly contracts 的 prompt 字符串拼接；
- model-owned attribution without explicit exclusion evidence for applicable framework, tool, environment, harness, cache, prompt, and feedback causes;
- 未对适用的 framework、tool、environment、harness、cache、prompt 与 feedback 原因提供明确排除证据就进行 model-owned attribution；
- parent and child model contexts merged as mutable state instead of sharing only bounded board evidence;
- parent 与 child model contexts 作为可变状态合并，而不是只共享有界 board evidence；
- raw provider reasoning or unredacted tool output written to the shared board or child prompt.
- raw provider reasoning 或未脱敏 tool output 写入 shared board 或 child prompt。
