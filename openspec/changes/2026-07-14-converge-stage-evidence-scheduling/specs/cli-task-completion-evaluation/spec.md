## ADDED Requirements

### Requirement: Model-Owned Pre-Harness Failures Consume Retryable Attempts / 模型侧 Harness 前失败消耗可重试 Attempt

The governed SWE runner SHALL count every child invocation as an attempt and SHALL retry model-owned pre-harness generation failures while supervised-attempt budget remains. It SHALL NOT retry environment, checkout, permission, provider-configuration, or unavailable-tool failures.

受治理 SWE runner 必须把每次 child invocation 计为 attempt，并在 supervised-attempt budget 尚有剩余时重试 model-owned pre-harness generation failure。它不得重试 environment、checkout、permission、provider-configuration 或 unavailable-tool failure。

#### Scenario: Empty patch receives structured retry / Empty Patch 获得结构化重试

- **WHEN** attempt 1 terminates after governed model execution with no source mutation and an empty patch
- **AND** no terminal environment or configuration failure is present
- **AND** supervised-attempt budget remains
- **THEN** attempt 1 is persisted as non-harness-ready evidence
- **AND** attempt 2 starts with bounded structured feedback containing the failed stage, terminal reason, evidence counts, and required next action
- **AND** official harness execution remains skipped until an attempt becomes harness-ready
- **中文** 当 attempt 1 在受治理模型执行后终止，且无源码修改、patch 为空，不存在终态 environment 或 configuration failure，并且 supervised-attempt budget 尚有剩余时，attempt 1 必须作为 non-harness-ready evidence 持久化；attempt 2 必须携带包含失败 stage、terminal reason、evidence count 与 required next action 的有界结构化反馈启动；在某次 attempt 达到 harness readiness 前，official harness execution 必须保持跳过。

#### Scenario: Environment failure remains terminal / Environment Failure 保持终态

- **WHEN** a child attempt cannot become harness-ready because checkout, environment, permission, provider configuration, or required tooling is unavailable
- **THEN** the runner records the typed terminal failure and does not launch another model attempt
- **中文** 当 child attempt 因 checkout、environment、permission、provider configuration 或 required tooling 不可用而无法达到 harness readiness 时，runner 必须记录 typed terminal failure，且不得启动新的模型 attempt。

#### Scenario: Official repair starts from the applied best candidate / Official Repair 从已应用最佳候选开始

- **WHEN** an official harness result is unresolved and the runner starts another supervised attempt from a non-empty best candidate
- **THEN** repair feedback states that the previous patch is already applied in the current checkout
- **AND** the model is required to diagnose the remaining failure and make an incremental change instead of replaying the previous patch
- **中文** 当 official harness 未解决实例，且 runner 从 non-empty best candidate 启动下一次 supervised attempt 时，repair feedback 必须声明 previous patch 已应用在当前 checkout；模型必须诊断剩余失败并进行增量修改，不得原样重放 previous patch。

#### Scenario: Official failure survives an intervening pre-harness failure / Official Failure 跨越中间 Harness 前失败

- **WHEN** a best candidate has a valid unresolved official harness result
- **AND** the following supervised attempt stops before harness readiness
- **AND** another supervised attempt remains
- **THEN** the next repair context includes the latest pre-harness terminal reason
- **AND** it also preserves the best candidate's official failing test ids and bounded failure excerpts
- **中文** 当最佳候选具有有效但 unresolved 的 official harness 结果，下一 supervised attempt 在 harness readiness 前终止，且仍有后续 supervised attempt 时，下一 repair context 必须包含最新 pre-harness terminal reason，同时保留最佳候选的 official failing test id 与有界 failure excerpt。

#### Scenario: Reproduction feedback identifies the governed checkout / 复现反馈标识受治理 Checkout

- **WHEN** zero-test public verification requires a safe problem reproduction
- **THEN** runner feedback includes the actual governed checkout root
- **AND** it instructs the child to run the reproduction relative to that root and omit redundant absolute `cwd` or `cd`
- **中文** 当零测试 public verification 要求安全问题复现时，runner feedback 必须包含实际受治理 checkout root，并指示 child 相对该 root 执行复现，省略冗余的绝对 `cwd` 或 `cd`。

#### Scenario: Repair evidence preserves the actual failing block / Repair 证据保留真实失败块

- **WHEN** pytest output contains a detailed failure block and a later short-summary line for the same test
- **THEN** the runner extracts the bounded detailed failure block, including the failing call and terminal exception, instead of selecting only the short-summary line
- **AND** if the named test symbol is absent from the local checkout, the runner records that absence and does not label unrelated file-prefix content as the test source
- **中文** 当 pytest output 同时包含某测试的详细 failure block 与后续 short-summary 行时，runner 必须提取包含失败调用和终态异常的有界详细 failure block，不得只选择 short-summary 行；若命名 test symbol 不存在于本地 checkout，runner 必须记录该缺失，且不得把无关文件前缀标成测试源码。

#### Scenario: Repair feedback does not complete diagnosis / Repair Feedback 不直接完成诊断

- **WHEN** the runner creates a child workflow state for a supervised repair attempt
- **THEN** official or pre-harness repair feedback is an input reference for diagnosis and change
- **AND** the `understand` stage remains pending until the repair child gathers focused current-checkout evidence
- **AND** the child is not forced directly into mutation before it can inspect the applied candidate and relevant dependencies
- **中文** 当 runner 为 supervised repair attempt 创建 child workflow state 时，official 或 pre-harness repair feedback 必须作为 diagnosis 与 change 的 input reference；`understand` stage 必须保持 pending，直到 repair child 收集当前 checkout 的 focused evidence；child 在检查已应用候选与相关依赖前不得被直接强制进入 mutation。
