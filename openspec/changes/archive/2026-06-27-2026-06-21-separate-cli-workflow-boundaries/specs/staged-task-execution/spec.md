## ADDED Requirements

### Requirement: Staged Task Acceptance Is Policy-Selected

Staged-task execution SHALL support optional supervisor acceptance without making it mandatory for every staged workflow.

Staged-task execution 必须支持可选 supervisor acceptance，但不得让它成为每个 staged workflow 的强制要求。

#### Scenario: Contract fields do not force CLI acceptance gates / Contract 字段不强制 CLI 验收门禁

- **WHEN** a staged task graph is used by an ordinary CLI workflow
- **THEN** the presence of evaluation or acceptance fields in the contract does not require technical-director acceptance unless the profile opts into supervisor acceptance
- **中文** 当 staged task graph 被普通 CLI workflow 使用时，contract 中存在 evaluation 或 acceptance 字段并不意味着必须要求技术总监验收，除非 profile 显式 opt into supervisor acceptance。

#### Scenario: Completed stages remain terminal / 已完成 stage 保持终态

- **WHEN** a standard CLI staged workflow marks a stage as `succeeded`
- **AND** later tool evidence also uses a capability that appeared in the completed stage
- **THEN** runtime MUST NOT reopen, restart, or emit duplicate success for the completed stage
- **AND** evidence is considered only against currently ready stages
- **中文** 当 standard CLI staged workflow 已将某个 stage 标记为 `succeeded`，后续工具证据即使使用了该 stage 曾声明的 capability，runtime 也不得重新打开、重新开始或重复发出该 stage 成功事件；证据只能匹配当前 ready stages。

#### Scenario: Same-response tool calls use latest stage state / 同响应 tool call 使用最新 stage state

- **WHEN** one model response contains multiple tool calls
- **AND** an earlier tool call advances the active staged workflow
- **THEN** later tool calls in the same response MUST evaluate against the updated active run state
- **AND** later tool calls MUST NOT evaluate against the stale run state captured at model-request creation time
- **中文** 当一次模型响应包含多个 tool call，且前一个 tool call 已推进 active staged workflow 时，后续 tool call 必须基于更新后的 active run state 评估，不得基于 model-request 创建时捕获的旧 run state。

#### Scenario: Automatic workflows close at terminal stage state / Automatic workflow 在 stage 终态关闭

- **WHEN** a standard automatic primary staged workflow has no remaining pending, ready, or running stages
- **AND** every stage is `succeeded` or `skipped`
- **THEN** the agent loop MUST emit completion for the workflow turn
- **AND** it MUST NOT continue requesting model iterations until the iteration budget is exhausted
- **中文** 当 standard automatic primary staged workflow 没有 pending、ready 或 running stage，且所有 stage 都是 `succeeded` 或 `skipped` 时，agent loop 必须发出 workflow turn completion，不得继续请求模型直到耗尽迭代预算。

#### Scenario: Ordinary plan stages accept planning evidence / 普通 plan stage 接受规划证据

- **WHEN** an ordinary CLI profile declares a `plan` stage with read, search, glob, list, or diff capabilities
- **THEN** successful runtime evidence from those declared capabilities MAY satisfy the plan stage
- **AND** mutation, materialization, and repair stages MUST still require mutation-capable evidence
- **中文** 当普通 CLI profile 声明 `plan` stage 且使用 read/search/glob/list/diff 等 capability 时，这些已声明 capability 的成功 runtime evidence 可以满足 plan stage；但 mutation、materialization 与 repair stage 仍必须要求具备变更能力的证据。

#### Scenario: Read-only evidence stages can complete without mutation / 只读证据 stage 可无变更完成

- **WHEN** a standard CLI staged workflow declares a produce-like stage whose allowed capabilities are all read-only evidence capabilities
- **THEN** successful evidence from any declared read-only capability MAY satisfy that stage
- **AND** produce-like stages that declare mutation-capable tools MUST NOT be satisfied by read-only evidence alone
- **中文** 当 standard CLI staged workflow 声明一个 produce-like stage，且其 allowed capabilities 全部是只读证据能力时，任一已声明只读能力的成功 evidence 可以满足该 stage；但声明了 mutation-capable tools 的 produce-like stage 不得仅由只读 evidence 满足。
