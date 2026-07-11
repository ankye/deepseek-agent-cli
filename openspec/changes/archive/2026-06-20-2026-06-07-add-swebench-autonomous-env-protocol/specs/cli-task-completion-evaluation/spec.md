## MODIFIED Requirements

### Requirement: Agentic Evaluation Boundary

CLI evaluation SHALL preserve short user prompts while allowing the measured CLI agent to invoke benchmark-related environment preparation through neutral governed product capabilities.

CLI 评测必须保持短用户 prompt，同时允许被测 CLI agent 通过中性的受治理产品能力自行调用 benchmark 相关环境准备。

#### Scenario: SWE-bench environment preparation is agent-owned / SWE-bench 环境准备由 Agent 拥有

- **WHEN** prompt assembly receives a short SWE-bench Lite request such as `给我完成 SWE-bench Lite 第 2 题测试，跑通并告诉我结果。`
- **THEN** the CLI runtime exposes a model-visible governed environment preparation capability that the agent may call by its own decision
- **AND** the capability defaults to dry-run inspection unless the agent explicitly requests execution
- **AND** capability feedback includes bounded dependency status evidence and redacted execution status, not raw commands, raw stdout/stderr, credentials, dataset paths, workspace naming schemes, harness invocation recipes, or required sequences
- **AND** the evaluation supervisor MUST NOT manually prepare a real SWE-bench item workspace for the measured run
- **AND** the final user message remains the exact original prompt
- **中文** 当 prompt assembly 收到短 SWE-bench Lite 请求，例如 `给我完成 SWE-bench Lite 第 2 题测试，跑通并告诉我结果。` 时，CLI runtime 必须暴露 model-visible 的受治理环境准备能力，由 agent 自己决定是否调用；该 capability 默认 dry-run inspection，除非 agent 显式请求 execution；capability feedback 只包含有界 dependency status evidence 与脱敏 execution status，不包含 raw commands、raw stdout/stderr、credentials、dataset paths、workspace naming schemes、harness invocation recipes 或 required sequences；评测监督者不得为被测 run 手动准备真实 SWE-bench item workspace；最终 user message 必须保持原始 prompt 完全一致。
