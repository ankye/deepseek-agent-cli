# Design: Reference-Derived Boundary Hardening

## Reference Findings / 参考发现

The reference directory is read-only input. We extract principles, not code:

参考目录只是只读输入。我们抽象原则，不复制代码：

- Smart-case search is useful for discovery, but it must not define write/artifact acceptance semantics.
- Rejected tools should return actionable feedback, not only a denial.
- Verification needs command evidence and adversarial probes; passing tests alone are context, not proof.
- Workflow steps need success criteria and downstream artifacts when later steps depend on them.
- Shell and permission matching must follow platform/shell semantics, including case sensitivity.
- Read-only command validation must reject evidence destruction, not only filesystem mutation.

## Boundary Rule / 边界规则

Path handling has two modes:

路径处理分为两种模式：

1. Discovery mode for read/list/search: platform canonicalization may normalize existing paths so tools can find files ergonomically.
2. Mutation/artifact mode for write/edit/patch: platform resolution still proves the path is workspace-safe, but the executor path preserves the requested literal casing so generated artifacts are validated exactly.

This keeps platform safety centralized while preventing case-insensitive hosts from silently changing artifact names.

这样既保持平台安全检查集中，又避免大小写不敏感平台静默改变 artifact 名称。

## Evaluation Rule / 评估规则

Supervised evaluation and runner acceptance must judge whether evidence satisfies the contract. A final text answer, a transient correction event, or a passing unit test is insufficient by itself. Nontrivial implementation acceptance must cite command/output evidence and one meaningful adversarial probe when practical.

监督式评估与 runner 验收必须判断证据是否满足契约。最终文本、中间纠错事件或单个通过的单测本身都不足以通过。非平凡实现验收在可行时必须引用命令/输出证据和一个有意义的对抗性探针。
