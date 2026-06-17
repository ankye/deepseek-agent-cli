## MODIFIED Requirements

### Requirement: Evaluator Repairs Frameworks Without Solving Benchmark Tasks / 评测员修框架但不代做 Benchmark 任务

The evaluator SHALL NOT solve the benchmark task for the evaluated CLI, but MAY repair reusable DeepSeek CLI framework defects with tests and rerun the same user prompt against a clean benchmark workspace. Production behavior SHALL NOT branch on benchmark repository name, instance id, task number, or known expected patch.

评测员不得替被测 CLI 解 benchmark task，但可以用测试修复可复用 DeepSeek CLI 框架缺陷，并用同一个用户 prompt 在干净 benchmark workspace 上重跑。生产行为不得基于 benchmark repository name、instance id、task number 或已知 expected patch 分支。

#### Scenario: Framework fix reruns same prompt / 框架修复后使用同一 Prompt 重跑

- **WHEN** a run fails because of a reusable CLI defect such as a tool schema gap, sandbox policy bug, repo execution bug, adapter bug, credential routing bug, cache accounting bug, repair-feedback gap, or verifier integration bug
- **THEN** the evaluator may change CLI product code under normal OpenSpec and test-first governance
- **AND** the next measured run uses the same entry prompt, a clean benchmark repository checkout, and new run evidence linked to the framework fix
- **AND** the evaluator must not manually edit the benchmark repository, provide the expected source change, or change the entry prompt to include task-specific hints
- **中文** 当 run 因可复用 CLI 缺陷失败，例如 tool schema gap、sandbox policy bug、repo execution bug、adapter bug、credential routing bug、cache accounting bug、repair-feedback gap 或 verifier integration bug 时，评测员可以按正常 OpenSpec 与 test-first governance 修改 CLI 产品代码；下一次被计分 run 必须使用同一个入口 prompt、干净 benchmark repository checkout，并把新 run evidence 链接到框架修复；评测员不得手动编辑 benchmark repository、提供预期源码改动，或修改入口 prompt 加入题目专用提示。

#### Scenario: Generic metadata drives compatibility behavior / 通用元数据驱动兼容行为

- **WHEN** a SWE-style benchmark checkout requires legacy interpreter, package, compiler, or dependency behavior
- **THEN** the CLI may select a compatibility profile from repository metadata, declared dependency constraints, available interpreter capabilities, and observed generic process failures
- **AND** production code MUST NOT select behavior from repository name, organization name, instance id, numbered task id, failing hidden test id, or known expected patch content
- **AND** audit evidence MUST expose the metadata basis for the selected compatibility profile
- **中文** 当 SWE 类 benchmark checkout 需要旧 interpreter、package、compiler 或 dependency 行为时，CLI 可以根据 repository metadata、声明的 dependency constraints、可用 interpreter capabilities 与观察到的通用 process failure 选择兼容 profile；生产代码不得根据 repository name、organization name、instance id、编号 task id、failing hidden test id 或已知 expected patch content 选择行为；审计证据必须暴露所选 compatibility profile 的元数据依据。

### Requirement: Evaluated CLI Owns Collection Decomposition Execution And Verification / 被测 CLI 自己负责收集拆解执行与验证

Once the entry prompt is sent, the evaluated CLI SHALL be responsible for resolving benchmark context, decomposing the task, invoking tools, mutating the benchmark repository, collecting outputs, running verification, and reporting the result through product capabilities. SWE-style attempts SHALL synthesize focused reproduction evidence from the problem statement before treating public local tests as sufficient.

入口 prompt 发出后，被测 CLI 必须通过产品能力自己负责解析 benchmark context、拆解任务、调用工具、修改 benchmark repository、采集输出、运行验证并报告结果。SWE 类 attempt 必须先从 problem statement 综合 focused reproduction evidence，再把公开本地测试视为充分证据。

#### Scenario: Problem statement reproduction precedes public-test trust / 问题陈述复现先于信任公开测试

- **WHEN** a SWE-style task provides a problem statement, reproduction text, expected behavior, or failing test description
- **THEN** the CLI prompt and repair flow MUST instruct the agent to derive and run the smallest practical reproduction or equivalent focused regression before trusting broad public local test success
- **AND** if the reproduction cannot be run, the trace MUST record a stable missing-reproduction reason code and the run MUST NOT be classified as model-owned solely because public tests passed
- **AND** a public local test pass followed by official hidden test failure MUST be reviewed for `VERIFICATION_ORACLE_GAP`, `REPRO_SYNTHESIS_MISSING`, `LOCAL_TEST_SELECTION_PARAM_GAP`, `GREEN_TEST_OVERTRUST`, and `PATCH_SCOPE_UNDERSPECIFIED` before model feedback is assigned
- **中文** 当 SWE 类任务提供 problem statement、reproduction text、expected behavior 或 failing test description 时，CLI prompt 与 repair flow 必须要求 agent 先推导并运行最小可行复现或等价 focused regression，再信任广泛公开本地测试成功；如果复现无法运行，trace 必须记录稳定的 missing-reproduction reason code，且不得仅因公开测试通过就把 run 归为模型侧；公开本地测试通过但 official hidden test 失败时，必须先复盘 `VERIFICATION_ORACLE_GAP`、`REPRO_SYNTHESIS_MISSING`、`LOCAL_TEST_SELECTION_PARAM_GAP`、`GREEN_TEST_OVERTRUST` 与 `PATCH_SCOPE_UNDERSPECIFIED`，再分配 model feedback。

#### Scenario: Verification uses a low-cost ladder before broad suites / 验证先走低成本阶梯再考虑大套件

- **WHEN** a governed SWE-style child run has produced a candidate patch
- **THEN** the CLI prompt and repair flow MUST instruct the agent to run the cheapest standard command that can falsify the patch first, preferring a problem reproduction or changed-file focused test before affected module/package subsets
- **AND** broad public suites MUST be reserved for cases where focused evidence is inconclusive and request budget remains
- **AND** after a passing focused standard test, the child SHOULD stop local testing and leave broad official scoring to the supervisor harness unless official repair feedback requires another focused check
- **AND** this cost ladder MUST be generic and MUST NOT branch on benchmark repository names, instance ids, task numbers, hidden failing tests, or expected patches
- **中文** 当治理 SWE 类 child run 已产生候选 patch 时，CLI prompt 与 repair flow 必须要求 agent 先运行能最便宜 falsify patch 的标准命令，优先选择 problem reproduction 或 changed-file focused test，然后才考虑受影响 module/package 子集；只有 focused evidence 不确定且 request budget 仍可用时，才考虑广泛公开套件；focused standard test 通过后，child 应停止本地扩测，把广泛 official scoring 留给 supervisor harness，除非 official repair feedback 要求另一个 focused check；该成本阶梯必须是通用行为，不得基于 benchmark repository name、instance id、task number、隐藏失败测试或 expected patch 分支。

#### Scenario: Material edits force immediate verification / 实际编辑后必须立即验证

- **WHEN** a governed SWE-style child run records a successful material source mutation
- **AND** no model-authored standard test command has been recorded after that mutation
- **THEN** the runtime MUST insert a post-edit verification gate before allowing further source read/search/list or broad setup exploration
- **AND** the next non-test source inspection or setup action MUST be rejected until the child runs a standard test command or reports a bounded blocker
- **AND** failed, policy-denied, or no-op edits MUST NOT trigger this gate as source mutation progress
- **中文** 当治理 SWE 类 child run 记录到成功且实际改变源码的 mutation，且该 mutation 之后尚未记录模型发起的标准测试命令时，runtime 必须先插入 post-edit verification gate，再允许继续 source read/search/list 或广泛 setup exploration；下一次非测试 source inspection 或 setup action 必须被拒绝，直到 child 运行标准测试命令或报告有界 blocker；失败、policy-denied 或 no-op edit 不得作为 source mutation progress 触发该 gate。

#### Scenario: Gate rejections override the next workflow action / Gate 拒绝后覆盖下一步工作流动作

- **WHEN** a governed SWE-style child run rejects duplicate or excessive source-inspection evidence before source mutation or standard-test progress exists
- **THEN** the next provider-visible profile workflow state MUST include a gate-enforced next action requiring source edit, standard test, or bounded blocker progress
- **AND** ready produce or repair stages MUST NOT present read/search/list-only capabilities as the active next action while that gate override is active
- **AND** the override MUST clear after successful source mutation or standard-test evidence and MUST NOT clear from another read/search/list-only action
- **AND** this behavior MUST be driven by generic gate, workflow stage, capability side-effect, and tool-result evidence rather than benchmark repository names, instance ids, task numbers, hidden tests, or expected patches
- **中文** 当治理 SWE 类 child run 在 source mutation 或标准测试进展之前拒绝重复或过量 source-inspection evidence 时，下一次 provider 可见的 profile workflow state 必须包含 gate-enforced next action，要求执行源码编辑、标准测试或报告有界 blocker；该 gate override 生效期间，ready 的 produce 或 repair 阶段不得继续把 read/search/list-only capability 呈现为 active next action；成功的 source mutation 或标准测试证据出现后必须清除 override，另一次 read/search/list-only action 不得清除 override；该行为必须由通用 gate、workflow stage、capability side-effect 与 tool-result evidence 驱动，不得基于 benchmark repository name、instance id、task number、hidden test 或 expected patch。

#### Scenario: Checkout aliases resolve to the active run root / Checkout Alias 解析到当前 Run Root

- **WHEN** a governed SWE-style child command runs inside a run-scoped checkout
- **AND** the model-authored command references a common container checkout alias such as `/home/user`
- **THEN** the process layer MAY rewrite the alias to the active run-scoped checkout root before execution
- **AND** the rewrite MUST preserve the command's test or setup intent, checkout-local virtualenv binding, and bounded timeout policy
- **AND** the rewrite MUST be selected only from the active checkout path and generic execution conventions, not from benchmark repository names, instance ids, numbered task ids, target files, failing hidden test ids, or expected patch content
- **AND** a command that targets a historical or unrelated checkout MUST still be rejected by workspace boundary policy rather than rewritten into the active checkout
- **中文** 当治理 SWE 类 child command 在 run-scoped checkout 内执行，且模型生成的命令引用 `/home/user` 这类常见容器 checkout alias 时，process layer 可以在执行前把 alias 改写到当前活动 run-scoped checkout root；该改写必须保留命令的测试或 setup 意图、checkout-local virtualenv 绑定与有界 timeout policy；改写只能由当前活动 checkout path 与通用执行约定决定，不得基于 benchmark repository name、instance id、编号 task id、目标文件、failing hidden test id 或 expected patch content；如果命令指向历史或无关 checkout，仍必须由 workspace boundary policy 拒绝，而不是改写到当前 checkout。
