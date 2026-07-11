# Stabilize Provider Prefix Cache Diagnostics / 稳定 Provider Prefix Cache 诊断

## Summary / 摘要

Separate stable provider-prefix cache evidence from dynamic prompt tails such as staged workflow state, tool result history, and stage-scoped tool projections.

将 stable provider-prefix 缓存证据与 staged workflow state、tool result history、stage-scoped tool projections 等动态 prompt tail 分离。

## Problem / 问题

SWE-bench runs can report `PROMPT_CACHE_PREFIX_BUSTED` even when prompt assembly uses the pipeline and emits a stable `providerPrefixFingerprint`. The current diagnostic path still treats dynamic `toolPlanFingerprint`, whole section order, and budget drift as cache-prefix drift in cases where the provider-facing stable prefix remains unchanged.

SWE-bench run 即使已经通过 prompt assembly pipeline 并输出稳定的 `providerPrefixFingerprint`，仍可能报告 `PROMPT_CACHE_PREFIX_BUSTED`。当前诊断路径在 provider-facing stable prefix 未变化时，仍会把动态 `toolPlanFingerprint`、整体 section order 与 budget 漂移视为 cache-prefix 漂移。

## Goals / 目标

- Treat `providerPrefixFingerprint` as the authoritative cacheable prefix signal when present.
- Keep dynamic tool projection changes visible as dynamic-tail/tool-plan telemetry, not prefix-busted evidence.
- Preserve true `PROMPT_CACHE_PREFIX_BUSTED` for cases with no provider-prefix evidence or with changing provider-prefix fingerprints.
- Re-run SWE-bench Lite task 1 and verify the first task remains resolved while cache diagnostics are correctly classified.

- 当存在 `providerPrefixFingerprint` 时，将其作为 cacheable prefix 的权威信号。
- 将动态工具投影变化保留为 dynamic-tail/tool-plan telemetry，而不是 prefix-busted 证据。
- 对没有 provider-prefix evidence 或 provider-prefix fingerprint 变化的情况继续保留真实 `PROMPT_CACHE_PREFIX_BUSTED`。
- 重新运行 SWE-bench Lite 第一题，验证第一题仍 resolved 且 cache 诊断分类正确。

## Non-Goals / 非目标

- Do not hardcode SWE-bench task ids, patches, models, or expected answers.
- Do not weaken stage-scoped tool scheduling.
- Do not remove whole-prompt replay fingerprints; they remain useful for replay diagnostics.

- 不硬编码 SWE-bench task id、patch、model 或答案。
- 不削弱按 stage 限定的工具调度。
- 不移除 whole-prompt replay fingerprints；它们仍用于 replay 诊断。
