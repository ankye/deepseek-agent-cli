# Role Profile Workflow Governance Design

## Boundary / 边界

Role profiles are runtime-owned professional workflow contracts. They are not prompt decoration and not task-specific answer recipes. A role profile defines the stable responsibility boundary for a professional mode: what stages exist, which capabilities may count as progress, what evidence is required, and who accepts the stage.

Role profile 是 runtime 拥有的职业工作流 contract，不是 prompt 装饰，也不是任务特定答案配方。Role profile 定义职业模式的稳定职责边界：有哪些 stage、哪些 capability 可以计为进展、需要什么 evidence、由谁验收 stage。

Dynamic model assembly remains valid only inside a ready stage. The model may choose which files to inspect, which tests to run, and which implementation tactic to use, but it must do so through the stage's allowed capability profile and produce the expected evidence refs before the workflow can advance.

动态模型拼装只在 ready stage 内有效。模型可以选择读哪些文件、跑哪些测试、采用哪种实现策略，但必须通过该 stage 的 allowed capability profile，并在 workflow 推进前产出 expected evidence refs。

## Catalog Layers / Catalog 分层

The catalog has three layers:

Catalog 分三层：

1. Role Profile: product-facing professional role and responsibility, such as `engineering/coding.v1`, `engineering/debugging.v1`, `product/manager.v1`, `design/visual.v1`, `architecture/review.v1`, and `governance/technical-director.v1`.
2. Workflow Profile: ordered stages, dependencies, stage objectives, entry criteria, exit criteria, and terminal close semantics.
3. Capability Profile: allowed tools, required tools, evidence refs, no-progress policy, timeout class, retry policy, and failure taxonomy for each stage.

## Primary vs Advisory / Primary 与 Advisory

Primary workflows are required for execution-bearing tasks: code mutation, repository debugging, generated artifacts, evaluation runs, release/readiness claims, architecture changes, and high-impact product/design deliverables. Advisory profiles remain for casual chat, low-risk explanation, and pure informational requests.

具备执行性质的任务必须使用 primary workflow：代码修改、仓库调试、生成产物、评测运行、发布/就绪声明、架构修改、高影响产品/设计交付。闲聊、低风险解释与纯信息请求保留 advisory profile。

## Initial Engineering Workflow / 初始工程师工作流

The first implementation should promote engineering execution prompts to `engineering/coding.v1` with this primary workflow:

首个实现应将工程执行型 prompt 提升为 `engineering/coding.v1` primary workflow：

1. `understand`: collect local evidence and identify relevant files or blockers.
2. `plan`: produce scoped implementation intent and acceptance criteria.
3. `test`: create or select focused verification before implementation when mutation is planned.
4. `implement`: make the minimal governed workspace change.
5. `verify`: run focused verification and inspect diff.
6. `report`: return outcome, evidence, residual risks, and next blocker.

This is not a SWE-bench special case. It is the generic engineering profile that SWE-bench child solving, ordinary repo fixes, and CLI framework work should reuse.

这不是 SWE-bench 特例，而是通用工程师 profile。SWE-bench child solving、普通 repo 修复与 CLI framework work 都应复用它。

## Acceptance / 验收

Every primary role workflow must expose:

每个 primary role workflow 必须暴露：

- selected role profile id and workflow graph id;
- ready-stage control before model dispatch;
- model-visible required action and allowed capabilities;
- typed no-progress handling when a required action is ignored;
- stage evaluation and technical-director acceptance records;
- separation between stable profile contract and dynamic run state for cache analysis.

Technical director acceptance is a gate, not a summary. A stage can only be accepted when the evidence satisfies that stage's exit criteria. Missing evidence must produce `blocked` or `needs-review`, not `passed`.

技术总监验收是 gate，不是 summary。只有 evidence 满足 stage exit criteria 时，stage 才能 accepted。缺少 evidence 必须产生 `blocked` 或 `needs-review`，不得标记为 `passed`。
