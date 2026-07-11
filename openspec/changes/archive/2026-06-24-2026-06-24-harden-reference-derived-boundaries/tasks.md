# Tasks

## OpenSpec / 规格

- [x] Create this OpenSpec change for reference-derived boundary hardening.
- [x] Record read/search versus mutation/artifact path semantics.
- [x] Record tool rejection feedback and evidence-gated acceptance requirements.
- [x] Validate this change with `npx openspec validate 2026-06-24-harden-reference-derived-boundaries --strict`.
- [x] Validate canonical specs with `npx openspec validate --specs --strict`.

- [x] 创建 reference-derived boundary hardening OpenSpec change。
- [x] 记录 read/search 与 mutation/artifact path 语义差异。
- [x] 记录工具拒绝反馈与 evidence-gated acceptance 要求。
- [x] 使用 `npx openspec validate 2026-06-24-harden-reference-derived-boundaries --strict` 校验本 change。
- [x] 使用 `npx openspec validate --specs --strict` 校验 canonical specs。

## Path Preflight / 路径预检

- [x] Add failing coverage proving mutation/artifact paths preserve literal casing after platform workspace safety resolution.
- [x] Implement generic mutation path preservation without weakening read/search canonicalization.
- [x] Confirm read/search platform canonicalization coverage remains green.

- [x] 增加失败测试，证明 mutation/artifact path 在平台 workspace 安全解析后保留字面大小写。
- [x] 实现通用 mutation path 保留逻辑，不削弱 read/search canonicalization。
- [x] 确认 read/search 平台 canonicalization 覆盖仍为绿色。

## Follow-Up Checklist / 后续检查清单

- [x] Add corrective next-action fields to rejected tool feedback where diagnostics are currently only denial text.
- [x] Add evaluation coverage proving nontrivial pass requires command/output evidence and at least one applicable adversarial probe.
- [x] Add read-only shell validation coverage for evidence-destruction commands such as terminal clearing.
- [x] Add shell permission coverage proving wildcard/prefix matching follows platform/shell case semantics.
- [x] Reclassify `McpAuthTool` as executable only after MCP gateway lifecycle/auth evidence proves credential denials fail closed.
- [x] Expand the reference arsenal matrix to include browser, image, design, web extraction/data lookup, and MCP prompt capability families.

- [x] 为当前只有拒绝文本的工具 diagnostics 增加 corrective next-action 字段。
- [x] 增加评估覆盖，证明非平凡 pass 需要命令/输出证据，并至少包含一个适用的对抗性探针。
- [x] 增加 read-only shell validation 覆盖，拦截 terminal clearing 等销毁证据的命令。
- [x] 增加 shell permission 覆盖，证明 wildcard/prefix matching 遵循平台/shell 大小写语义。
- [x] 只有在 MCP gateway lifecycle/auth evidence 证明 credential denial 会 fail closed 后，才将 `McpAuthTool` 重新归类为 executable。
- [x] 扩展 reference arsenal matrix，纳入 browser、image、design、web extraction/data lookup 与 MCP prompt 能力家族。
