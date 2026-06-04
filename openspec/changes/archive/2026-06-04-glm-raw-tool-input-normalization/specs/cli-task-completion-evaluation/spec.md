## MODIFIED Requirements

### Requirement: CLI Evaluation Includes Webpage Generation Task / CLI 评估包含网页生成任务

CLI task-completion evaluation SHALL include a deterministic webpage-generation task with local artifact validation and SHALL allow DeepSeek-owned live execution only when explicitly requested.

CLI task-completion evaluation 必须包含带本地产物校验的 deterministic webpage-generation task，并且只有在显式请求时才允许 DeepSeek 自有 live execution。

#### Scenario: GLM expanded webpage tasks receive a larger provider budget / GLM expanded webpage tasks 获得更大 provider budget

- **WHEN** a live CLI run selects provider `glm` for a prompt containing webpage/html evaluation task markers
- **THEN** the resolved model profile includes a larger Anthropic `max_tokens` provider option
- **AND** the one-shot agent-loop limits are widened for model iterations, tool calls, and output bytes
- **AND** simple non-webpage prompts keep the default GLM provider options
- **中文** 当 live CLI run 为包含 webpage/html evaluation task 标记的 prompt 选择 `glm` provider 时，resolved model profile 必须包含更大的 Anthropic `max_tokens` provider option；one-shot agent-loop limits 必须放宽 model iterations、tool calls 与 output bytes；普通非网页 prompt 必须保持默认 GLM provider options。

#### Scenario: Webpage final answer stays artifact-neutral / 网页最终回复保持 artifact-neutral

- **WHEN** a webpage evaluation prompt is assembled
- **THEN** it instructs the agent to write evidence into `generated-webpage/evidence.json`
- **AND** it constrains the final assistant answer to the fixed short sentence `generated-webpage complete`
- **AND** it forbids product-copy, package-name, executable-name, command, file-table, markdown-bullet, and verification-detail recaps in the final answer
- **中文** 当 webpage evaluation prompt 被组装时，它必须要求 agent 将 evidence 写入 `generated-webpage/evidence.json`；并将最终 assistant answer 约束为固定短句 `generated-webpage complete`；同时禁止在 final answer 中复述 product-copy、package-name、executable-name、command、file-table、markdown-bullet 与 verification-detail。
