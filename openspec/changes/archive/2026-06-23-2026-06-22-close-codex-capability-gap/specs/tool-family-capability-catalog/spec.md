## MODIFIED Requirements

### Requirement: Family Implementation State Is Explicit / Family 实现状态显式化
Every first-version family SHALL be reported as `implemented`, `planned`, `absent`, `unavailable`, `deprecated`, or `not_applicable` for each host/product edition.

每个第一版 family 必须针对每个 host/product edition 报告为 `implemented`、`planned`、`absent`、`unavailable`、`deprecated` 或 `not_applicable`。

#### Scenario: Missing family is absent not invisible / 缺失 Family 是 Absent 而不是消失
- **WHEN** DeepSeek has no capability, connector, or planned implementation for a catalog family
- **THEN** diagnostics report the family as `absent` and scorecard collection gives it zero credit
- **中文** 当 DeepSeek 对某个 catalog family 没有 capability、connector 或规划实现时，diagnostics 必须报告该 family 为 `absent`，scorecard collection 必须给零分。

#### Scenario: Required engineering family blocks before model dispatch / 必需工程 Family 在模型调用前阻塞
- **WHEN** a selected engineering profile requires a catalog family such as `core.file.edit`, `patch.apply`, `shell.run`, `test.run`, or `git.diff`
- **AND** that family has no executable implementation or no model-visible projection for the current host
- **THEN** capability compilation fails with `blocked-by-cli-capability-gap` before provider dispatch
- **AND** the diagnostic includes profile id, stage id, required family id, implementation state, and projection state
- **中文** 当选中的 engineering profile 需要 `core.file.edit`、`patch.apply`、`shell.run`、`test.run` 或 `git.diff` 等 catalog family，且该 family 在当前 host 没有 executable implementation 或 model-visible projection 时，capability compilation 必须在 provider dispatch 前以 `blocked-by-cli-capability-gap` 失败；diagnostic 必须包含 profile id、stage id、required family id、implementation state 与 projection state。

## ADDED Requirements

### Requirement: Codex-Class Tool Tier Scorecard / Codex-Class 工具层级评分卡

The tool family catalog SHALL support a Codex-class gap scorecard that groups families into production tool tiers without removing the underlying family-level denominator.

tool family catalog 必须支持 Codex-class gap scorecard，将 families 分组为生产工具层级，同时不得移除底层 family-level 分母。

#### Scenario: Tier score keeps absent families visible / 层级评分保持缺失 Family 可见
- **WHEN** a Codex-class gap report is rendered
- **THEN** it includes Tier 0 core read, Tier 1 engineering closure, Tier 2 production workflow, and Tier 3 ecosystem connector sections
- **AND** every absent, planned, unavailable, or unassessed family remains visible with zero or explicit non-credit state
- **中文** 当渲染 Codex-class gap report 时，必须包含 Tier 0 core read、Tier 1 engineering closure、Tier 2 production workflow 与 Tier 3 ecosystem connector sections；每个 absent、planned、unavailable 或 unassessed family 必须保持可见，并带零分或明确 non-credit 状态。

#### Scenario: Tier 1 closure requires concrete tools / Tier 1 闭环要求真实工具
- **WHEN** an engineering task requires source mutation and verification
- **THEN** Tier 1 is not considered ready unless executable model-visible families exist for file mutation, patch application or equivalent edit, command or test execution, and diff/status inspection
- **中文** 当工程任务需要源码修改与验证时，只有存在 file mutation、patch application 或等价 edit、command 或 test execution、diff/status inspection 的 executable model-visible families，Tier 1 才能视为 ready。

