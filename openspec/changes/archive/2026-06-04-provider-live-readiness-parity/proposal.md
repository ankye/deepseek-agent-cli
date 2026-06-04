## Why

GLM live model and tool-loop smokes now prove that the remote provider path can run through the runtime, but diagnostics, readiness, release evidence, and acceptance indexing still describe live verification as a DeepSeek-only capability.

GLM live model 与 tool-loop smoke 已经证明 remote provider path 可以跑通 runtime，但 diagnostics、readiness、release evidence 与 acceptance index 仍把 live verification 描述为 DeepSeek-only capability。

This creates a product gap: `run/chat --provider glm` can work while `diagnostics doctor --live --provider glm` and release-readiness evidence cannot show the same provider as a first-class, redacted, governed path.

这形成了产品缺口：`run/chat --provider glm` 可以工作，但 `diagnostics doctor --live --provider glm` 与 release-readiness evidence 还不能把同一 provider 作为 first-class、redacted、governed path 展示。

## What Changes

- Make readiness doctor provider-aware for explicit live verification while keeping the default doctor offline and DeepSeek-compatible.
- 让 readiness doctor 在显式 live verification 时支持 provider-aware 行为，同时保持默认 doctor offline 与 DeepSeek-compatible。
- Add GLM credential presence and live verifier metadata to diagnostics without printing raw credentials.
- 在 diagnostics 中增加 GLM credential presence 与 live verifier metadata，且不得打印 raw credentials。
- Let diagnostics parse provider/model selection for doctor/release/evidence paths where those commands use model-provider context.
- 允许 diagnostics 在 doctor/release/evidence 路径解析 provider/model selection。
- Add GLM live acceptance evidence entries and release evidence recognition while preserving existing DeepSeek release gates.
- 增加 GLM live acceptance evidence entries 与 release evidence recognition，同时保留现有 DeepSeek release gates。

## Impact

- Affects `src/packages/command-system`, `src/packages/platform-contracts`, CLI diagnostics/readiness wiring, release evidence parsing, acceptance index generation, and focused tests.
- 影响 `src/packages/command-system`、`src/packages/platform-contracts`、CLI diagnostics/readiness wiring、release evidence parsing、acceptance index generation 与 focused tests。
- Does not add automatic provider failover, account routing, or a default network call.
- 不新增 automatic provider failover、account routing 或默认 network call。
- Raw provider credentials remain local-only and must not appear in source, fixtures, diagnostics, or commits.
- raw provider credentials 保持 local-only，且不得出现在 source、fixtures、diagnostics 或 commits 中。
