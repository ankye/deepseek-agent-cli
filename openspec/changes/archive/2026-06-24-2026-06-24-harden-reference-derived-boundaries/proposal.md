# Harden Reference-Derived Boundaries

## Why / 为什么

Reference inspection exposed several recurring boundary traps that match recent CLI failures: discovery can be ergonomic while artifact writes must stay literal, tool rejection must guide recovery, and final evaluation must be evidence-gated rather than output-gated. These are generic platform contracts, not benchmark-specific shortcuts.

参考目录暴露出几个与近期 CLI 失败相似的边界陷阱：发现/搜索可以更智能，但 artifact 写入必须保持字面路径；工具拒绝必须给出可修正反馈；最终评估必须由证据 gate 控制，而不是“有输出就通过”。这些是通用平台契约，不是 benchmark 特例。

## What / 做什么

- Define that smart-case and platform canonicalization are allowed for read/search discovery, but mutation/artifact paths must preserve literal requested casing after workspace safety checks.
- Require corrective tool rejection feedback that tells the model what to change next.
- Require capability-matrix and runner acceptance to check command/output evidence plus at least one meaningful adversarial probe for nontrivial changes.
- Keep terminal/final outcome evidence ahead of transient recovery events when classifying failures.

- 明确 smart-case 与平台 canonicalization 可用于 read/search discovery，但 mutation/artifact path 在 workspace 安全检查后必须保留请求的字面大小写。
- 要求工具拒绝反馈提供下一步可修正动作。
- 要求 capability-matrix 与 runner 验收对非平凡变更检查命令/输出证据，并至少包含一个有意义的对抗性探针。
- 分类失败时，terminal/final outcome evidence 优先于中间 transient recovery events。

## Non-Goals / 非目标

- Do not copy reference implementation code.
- Do not add benchmark-specific expected patches, task-id branches, or test-only shortcuts.
- Do not weaken evidence-first or artifact gates to make live tests pass.

- 不复制参考实现代码。
- 不增加 benchmark-specific expected patch、task-id 分支或 test-only shortcut。
- 不削弱 evidence-first 或 artifact gate 来让 live 测试通过。
