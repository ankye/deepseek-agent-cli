## Why

SWE-bench Lite evaluation must measure the DeepSeek CLI agent, not an external supervisor that prepares benchmark workspaces by hand. The CLI already has environment diagnostics and expanded SWE-bench budgets, but the model-visible capability surface does not make benchmark preparation capabilities discoverable. This makes a short user prompt depend on hidden evaluator setup or on the model guessing product internals.

SWE-bench Lite 评测必须衡量 DeepSeek CLI agent 本身，而不是衡量外部监督者手动准备 benchmark workspace 的能力。CLI 已有环境 diagnostics 与 SWE-bench 扩展预算，但模型可见 capability surface 还没有让 benchmark preparation 能力可发现。这会让短用户 prompt 依赖隐藏的评测员准备，或依赖模型猜产品内部实现。

## What Changes

- Add an agent-visible CLI environment preparation capability for short benchmark prompts.
- The capability lets the measured agent decide whether to inspect or execute allowlisted environment preparation, without the evaluator preparing the environment by hand.
- Preserve the exact user prompt as the final user message so prompt purity remains auditable.

- 为短 benchmark prompt 增加 agent-visible CLI 环境准备能力。
- 该能力允许被测 agent 自行决定是否检查或执行 allowlisted environment preparation，而不是评测员手动准备环境。
- 保持原始用户 prompt 作为最终 user message，确保 prompt purity 可审计。

## Impact

- DeepSeek CLI can be supervised with a short prompt while invoking environment preparation itself.
- Future benchmark tools can plug into the same agent-owned capability pattern without changing the user prompt boundary.

- DeepSeek CLI 可以在短 prompt 监督下运行，同时自行调用环境准备能力。
- 后续 benchmark 工具可以接入同一 agent-owned 能力模式，而不改变用户 prompt 边界。
