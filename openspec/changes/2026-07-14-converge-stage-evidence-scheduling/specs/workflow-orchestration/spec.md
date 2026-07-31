## ADDED Requirements

### Requirement: Governed Mutation Stages Use Progress-Aware Evidence Windows / 受治理 Mutation Stage 使用进展感知证据窗口

The workflow runtime SHALL reject non-visible source-inspection capabilities before execution and MAY open an explicit bounded focused evidence window on the next model turn. The window SHALL accept only target-scoped novel evidence and SHALL return to mutation after sufficient, duplicate, wrong-target, or exhausted evidence.

Workflow runtime 必须在执行前拒绝 non-visible source-inspection capability，并可以在下一次模型轮次打开显式 bounded focused evidence window。该窗口只能接受目标范围内的 novel evidence，并必须在 evidence 充分、重复、错目标或耗尽后恢复 mutation。

#### Scenario: Window uses remaining configured stage budget / 窗口使用剩余 Stage 配置预算

- **WHEN** a governed mutation stage opens a focused evidence window after consuming part of its configured tool budget
- **THEN** the window operation ceiling equals the remaining configured stage tool budget, with a minimum of one recovery operation
- **AND** accepted novel evidence cannot exceed that ceiling
- **AND** the runtime does not impose a separate fixed two-operation ceiling
- **中文** 当受治理 mutation stage 在已消耗部分配置 tool budget 后打开 focused evidence window 时，窗口操作上限必须等于当前 stage 剩余的已配置 tool budget，且至少提供一次 recovery operation；已接纳 novel evidence 不得超过该上限；runtime 不得额外施加固定两次操作上限。

#### Scenario: Same-target bounded read extends prior coverage / 同目标 Bounded Read 扩展已有覆盖

- **WHEN** a governed mutation stage opens a focused evidence window for path `P` at workspace revision `R`
- **AND** a first bounded read covers lines 160 through 239
- **AND** a second overlapping bounded read covers lines 160 through 359
- **THEN** the second read is novel only for lines 240 through 359 and remains allowed within the window limit
- **AND** a third read whose content is fully covered is duplicate evidence and is rejected before execution
- **中文** 当受治理 mutation stage 为 workspace revision `R` 的路径 `P` 打开 focused evidence window，第一次 bounded read 覆盖 160 至 239 行，第二次重叠 bounded read 覆盖 160 至 359 行时，第二次读取仅对 240 至 359 行属于 novel，并可在窗口上限内继续；第三次内容已完全覆盖的 read 属于 duplicate evidence，必须在执行前拒绝。

#### Scenario: Equivalent searches do not extend the window / 等价搜索不扩展窗口

- **WHEN** a focused content search records normalized matching path, line, and content digests
- **AND** a later search changes its glob or context request but produces the same normalized matches at the same workspace revision
- **THEN** the later search is duplicate evidence
- **AND** the runtime closes inspection recovery and requires mutation without spending the remaining stage budget on equivalent searches
- **中文** 当 focused content search 记录了归一化 matching path、line 与 content digest，后续搜索改变 glob 或 context request，但在同一 workspace revision 产生相同 normalized matches 时，后续搜索属于 duplicate evidence；runtime 必须关闭 inspection recovery 并要求 mutation，不得让等价搜索继续消耗剩余 stage budget。

#### Scenario: Direct relative dependency remains target-scoped / 直接相对依赖仍属于目标范围

- **WHEN** the first accepted source read for path `P` contains an explicit relative import of source path `D`
- **AND** the second focused evidence request reads `D` within the existing operation limit
- **THEN** the runtime treats `D` as a proven direct dependency of `P` and allows the bounded read
- **AND** an unrelated path not proven by the accepted source evidence remains wrong-target and is rejected before execution
- **中文** 当路径 `P` 的第一份已接纳源码读取包含对源码路径 `D` 的显式相对导入，且第二次 focused evidence request 在既有 operation limit 内读取 `D` 时，runtime 必须把 `D` 视为 `P` 的已证明直接依赖并允许该 bounded read；未被已接纳源码证据证明的无关路径仍属于 wrong-target，必须在执行前拒绝。

#### Scenario: Package-scoped related search remains bounded / Package 范围 Related Search 保持有界

- **WHEN** accepted evidence has established a reviewed target or related target under direct parent `pkg`
- **AND** a focused search uses a glob such as `pkg/**/*.py` that covers that reviewed path
- **THEN** the runtime admits the search and normalizes it to content evidence within `pkg`
- **AND** a repository-wide glob such as `**/*.py` remains wrong-target and is rejected before execution
- **中文** 当已接纳证据在直接父目录 `pkg` 下建立了 reviewed target 或 related target，且 focused search 使用覆盖该路径的 `pkg/**/*.py` 等 glob 时，runtime 必须允许该搜索并将其归一化为 `pkg` 范围内的 content evidence；`**/*.py` 等 repository-wide glob 仍属于 wrong-target，必须在执行前拒绝。

#### Scenario: Hidden inspection opens recovery instead of executing / 隐藏 Inspection 打开 Recovery 而不执行

- **WHEN** a model requests source inspection that is absent from the current model-visible mutation-stage projection
- **THEN** the runtime rejects the current request before kernel execution
- **AND** if policy permits recovery, the following model request explicitly projects the bounded focused evidence capabilities
- **AND** no capability may execute merely because an internal recovery branch knows its id
- **中文** 当模型请求当前 model-visible mutation-stage projection 中不存在的 source inspection 时，runtime 必须在 kernel execution 前拒绝当前请求；若 policy 允许 recovery，下一次模型请求必须显式投影 bounded focused evidence capabilities；任何 capability 都不得仅因内部 recovery branch 知道其 id 就被执行。

### Requirement: Evidence Novelty Is Revision And Result Based / 证据新颖性基于 Revision 与结果

The workflow runtime SHALL determine progress from structured result evidence rather than successful tool completion or syntactic input variation. File evidence SHALL include target and covered ranges; search evidence SHALL include normalized result identity; successful mutation SHALL advance the relevant workspace revision.

Workflow runtime 必须从结构化 result evidence 判断进展，而不是把工具成功完成或输入语法变化当作进展。File evidence 必须包含目标与覆盖范围；search evidence 必须包含 normalized result identity；成功 mutation 必须推进相关 workspace revision。

#### Scenario: Mutation makes later evidence independently observable / Mutation 使后续证据可独立观察

- **WHEN** source evidence for path `P` was recorded at revision `R1`
- **AND** a successful mutation changes `P` and advances it to revision `R2`
- **THEN** a bounded post-mutation read of `P` is evaluated under `R2` and is not rejected as a duplicate of `R1`
- **中文** 当路径 `P` 的 source evidence 已记录在 revision `R1`，成功 mutation 修改 `P` 并推进到 `R2` 时，对 `P` 的 bounded post-mutation read 必须在 `R2` 下评估，不得作为 `R1` 的 duplicate 被拒绝。

### Requirement: Governed Verification Rejects Zero-Test Success / 受治理验证拒绝零测试成功

The workflow runtime SHALL NOT treat a test command as successful closure evidence when it executes zero tests. It SHALL normalize terminal text before classification, including removal of ANSI control sequences, and SHALL keep SWE behavior-contract verification open until a safe reproduction succeeds.

Workflow runtime 不得把执行零个测试的测试命令作为成功关闭证据。它必须先归一化终态文本再分类，包括移除 ANSI 控制序列；对于带 SWE behavior-contract 的验证，必须保持打开直到安全复现成功。

#### Scenario: ANSI-colored deselection is zero-test evidence / ANSI 彩色 Deselection 属于零测试证据

- **WHEN** pytest terminates with an ANSI-colored summary such as `158 deselected`
- **AND** no test executed
- **THEN** the runtime strips ANSI control sequences and classifies the result as zero-test evidence
- **AND** public verification remains incomplete and requests a safe problem reproduction
- **中文** 当 pytest 以 `158 deselected` 等带 ANSI 色彩的摘要终止，且没有测试实际执行时，runtime 必须去除 ANSI 控制序列并将结果归类为零测试证据；public verification 必须保持未完成并要求安全问题复现。

#### Scenario: Exact governed checkout prefix is safe / 精确受治理 Checkout 前缀安全

- **WHEN** a non-mutating reproduction command is prefixed by `cd <workspaceRoot> &&`
- **AND** `<workspaceRoot>` exactly equals the governed checkout root from tool input
- **THEN** normalization may accept the command as checkout-local reproduction
- **AND** an unrelated absolute directory remains rejected
- **中文** 当无写入复现命令以 `cd <workspaceRoot> &&` 开头，且 `<workspaceRoot>` 与 tool input 中的受治理 checkout root 完全相等时，归一化可以将该命令作为 checkout-local reproduction 接纳；无关绝对目录仍必须拒绝。
