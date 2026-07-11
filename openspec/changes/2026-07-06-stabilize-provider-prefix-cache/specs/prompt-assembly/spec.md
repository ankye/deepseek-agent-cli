## MODIFIED Requirements

### Requirement: Stable Prefix Section Planning / 稳定前缀 Section Planning

Prompt assembly SHALL emit section plans that preserve stable prefix blocks ahead of volatile current-turn content and record prefix fingerprints in assembly evidence. Provider-prefix fingerprints SHALL identify the provider-facing cacheable prefix independently from dynamic tool projection, workflow state, budget tail, and conversation history changes.

Prompt assembly 必须输出 section plans，将稳定前缀 blocks 保持在易变 current-turn content 前面，并在 assembly evidence 中记录 prefix fingerprints。Provider-prefix fingerprints 必须独立标识 provider-facing cacheable prefix，不受动态 tool projection、workflow state、budget tail 与 conversation history changes 影响。

#### Scenario: Stable sections precede current turn / 稳定 Section 位于当前回合之前

- **WHEN** a prompt is assembled for a normal coding turn
- **THEN** kernel and project sections appear before session summaries and current user input, preserving the manifest prefix order
- **中文** 当为普通 coding turn 组装 prompt 时，kernel 与 project sections 必须出现在 session summaries 与当前用户输入之前，并保持 manifest prefix order。

#### Scenario: Assembly evidence carries hashes / Assembly 证据携带 Hashes

- **WHEN** prompt assembly returns a result
- **THEN** the result includes pipeline fingerprint, layer prefix hashes, included block ids, excluded block ids, and cache hint summary
- **中文** 当 prompt assembly 返回结果时，结果必须包含 pipeline fingerprint、layer prefix hashes、included block ids、excluded block ids 与 cache hint summary。

#### Scenario: Dynamic tool plans do not bust stable provider prefix / 动态工具计划不破坏稳定 Provider Prefix

- **WHEN** consecutive prompt assemblies keep the same provider-prefix fingerprint while stage-scoped tool projections change
- **THEN** cache diagnostics treat the provider prefix as stable and do not emit a prompt-prefix-busted diagnostic solely because the tool-plan fingerprint changed
- **中文** 当连续 prompt assemblies 保持相同 provider-prefix fingerprint 但 stage-scoped tool projections 变化时，cache diagnostics 必须将 provider prefix 视为稳定，不得仅因 tool-plan fingerprint 变化而发出 prompt-prefix-busted 诊断。
