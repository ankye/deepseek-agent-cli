# Design / 设计

## Cache Evidence Boundary / 缓存证据边界

Prompt assembly already emits two kinds of evidence:

Prompt assembly 已经输出两类证据：

- Whole assembly replay evidence: section order, budget, tool plan, message roles, and whole prompt fingerprint.
- Provider stable-prefix evidence: `providerPrefixFingerprint`, prefix message count, prefix token estimate, and cache-hint summary.

- 整体 assembly replay 证据：section order、budget、tool plan、message roles 与 whole prompt fingerprint。
- Provider stable-prefix 证据：`providerPrefixFingerprint`、prefix message count、prefix token estimate 与 cache-hint summary。

When provider-prefix evidence exists for more than one prompt assembly event, provider cache-prefix stability SHALL be determined by provider-prefix fingerprints, not by dynamic tool-plan fingerprints.

当多个 prompt assembly event 存在 provider-prefix 证据时，provider cache-prefix 稳定性必须由 provider-prefix fingerprints 判定，而不是由动态 tool-plan fingerprints 判定。

## Dynamic Tail / 动态尾部

Stage-scoped tool projection is intentionally dynamic. A child repair workflow may expose read tools, then mutation tools, then shell/test tools. This changes `toolPlanFingerprint` and possibly whole-prompt replay data, but does not imply the provider stable prefix changed.

按 stage 限定的工具投影是有意动态的。子修复 workflow 可能先暴露 read 工具，再暴露 mutation 工具，再暴露 shell/test 工具。这会改变 `toolPlanFingerprint` 和可能的 whole-prompt replay 数据，但不表示 provider stable prefix 变化。

## Diagnostics / 诊断

`PROMPT_CACHE_PREFIX_BUSTED` SHOULD be emitted only when:

`PROMPT_CACHE_PREFIX_BUSTED` 只应在以下情况发出：

- no provider-prefix evidence exists and replay prefix evidence drifts; or
- provider-prefix evidence exists and provider-prefix fingerprints drift.

- 不存在 provider-prefix evidence 且 replay prefix evidence 漂移；或
- 存在 provider-prefix evidence 且 provider-prefix fingerprints 漂移。

If provider-prefix fingerprints are stable but cache hit rate is low, diagnostics should prefer dynamic tail, history tail, provider breakpoint-shape, provider prefix size/coverage, or provider/tool-schema cache categories.

如果 provider-prefix fingerprints 稳定但 cache hit rate 低，诊断应优先归类为 dynamic tail、history tail、provider breakpoint-shape、provider prefix size/coverage 或 provider/tool-schema cache 类别。
