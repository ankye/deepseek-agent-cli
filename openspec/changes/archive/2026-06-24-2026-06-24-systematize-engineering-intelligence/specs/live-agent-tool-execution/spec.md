## ADDED Requirements

### Requirement: Tool Decisions Are Replayable / 工具决策可回放

Live agent tool execution SHALL record a replayable tool decision board for each agent turn, covering projected tools, hidden tools, model tool intents, preflight decisions, policy decisions, execution results, and follow-up recommendations.

Live agent tool execution 必须为每个 agent turn 记录可回放的工具决策看板，覆盖已投影工具、隐藏工具、模型工具意图、preflight decisions、policy decisions、execution results 与 follow-up recommendations。

#### Scenario: Model request includes decision context / 模型请求包含决策上下文

- **WHEN** runtime sends a live model request
- **THEN** trace evidence SHALL include the active profile id, stage id when present, visible tool ids, hidden tool summaries, projection reasons, previous rejected intents, and decision-quality counters
- **AND** the model-visible prompt MAY include a bounded dynamic summary of corrective next actions
- **中文** 当 runtime 发送 live model request 时，trace evidence 必须包含 active profile id、存在时的 stage id、visible tool ids、hidden tool summaries、projection reasons、previous rejected intents 与 decision-quality counters；模型可见 prompt 可以包含有界的动态 corrective next actions 摘要。

### Requirement: Tool Feedback Guides Next Action / 工具反馈指导下一步

Tool feedback SHALL distinguish success evidence, repair evidence, retryable rejection, non-retryable denial, platform unavailability, and bounded blocker states, and SHALL provide provider-neutral corrective next-action metadata when the model can recover.

工具反馈必须区分 success evidence、repair evidence、retryable rejection、non-retryable denial、platform unavailability 与 bounded blocker states，并在模型可恢复时提供 provider-neutral corrective next-action metadata。

#### Scenario: Repeated rejected intent is suppressed / 重复拒绝意图被抑制

- **WHEN** a model repeats the same rejected tool name and normalized input beyond the configured threshold
- **THEN** runtime SHALL stop re-executing the same failing request
- **AND** it SHALL return bounded feedback requiring a different projected tool, corrected input, or explicit blocker report
- **AND** the decision board SHALL classify the loop as a decision-loop failure candidate.
- **中文** 当模型以相同工具名和归一化输入重复被拒绝超过配置阈值时，runtime 必须停止重复执行同一失败请求；它必须返回有界反馈，要求使用不同的已投影工具、修正输入，或明确报告 blocker；decision board 必须将该循环分类为 decision-loop failure candidate。
