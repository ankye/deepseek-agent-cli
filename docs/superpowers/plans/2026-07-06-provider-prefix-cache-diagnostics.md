# Provider Prefix Cache Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep SWE-bench cache diagnostics tied to stable provider-prefix evidence while allowing dynamic staged tool projection.

**Architecture:** Prompt assembly remains the provider-neutral pipeline. Cache diagnostics distinguish whole replay drift from provider-facing stable prefix drift, and dynamic tool plans are classified as tail/tool-schema telemetry rather than prefix-busted evidence.

**Tech Stack:** TypeScript, Node test runner via `tsx --test`, OpenSpec.

## Global Constraints

- No hardcoded benchmark answers, task ids, patches, or model mappings.
- Preserve staged tool projection and active-stage execution boundaries.
- Test first for behavior changes under `src/**`.
- OpenSpec artifacts stay bilingual.

---

### Task 1: Spec The Cache Boundary

**Files:**
- Create: `openspec/changes/2026-07-06-stabilize-provider-prefix-cache/proposal.md`
- Create: `openspec/changes/2026-07-06-stabilize-provider-prefix-cache/design.md`
- Create: `openspec/changes/2026-07-06-stabilize-provider-prefix-cache/tasks.md`
- Create: `openspec/changes/2026-07-06-stabilize-provider-prefix-cache/specs/prompt-assembly/spec.md`
- Create: `openspec/changes/2026-07-06-stabilize-provider-prefix-cache/specs/context-pipeline-prefix-cache/spec.md`

**Interfaces:**
- Produces: bilingual requirement that dynamic tool-plan drift must not emit `PROMPT_CACHE_PREFIX_BUSTED` when `providerPrefixFingerprint` is stable.

- [x] **Step 1:** Write bilingual OpenSpec proposal, design, tasks, and spec deltas.
- [x] **Step 2:** Run `npx openspec validate --specs --strict`.

### Task 2: Regression Coverage

**Files:**
- Modify: `src/apps/cli/src/diagnostics/swe-bench-prediction.test.ts`

**Interfaces:**
- Consumes: `collectSweBenchPrediction()` diagnostics summary.
- Produces: regression test `does not report stage-scoped tool projection changes as prompt cache prefix drift when provider prefix is stable`.

- [x] **Step 1:** Add a failing test with stable `providerPrefixFingerprint`, changing `toolPlanFingerprint`, and low provider cache hit rate.
- [x] **Step 2:** Run focused test and confirm it fails because `lowHitPromptAssemblyDriftCount` is non-zero.

### Task 3: Cache Trace Classification Fix

**Files:**
- Modify: `src/apps/cli/src/diagnostics/swe-bench-cache-trace.ts`

**Interfaces:**
- Consumes: `prompt.assembled` replay and pipeline evidence.
- Produces: `promptAssemblyCacheablePrefixIsStable()` that prefers stable provider-prefix fingerprints when available.

- [x] **Step 1:** Keep `stableReplayFingerprint` as whole replay stability.
- [x] **Step 2:** Change cacheable prefix stability so multiple provider-prefix events require only `providerPrefixFingerprints.size <= 1`.
- [x] **Step 3:** Run focused diagnostics tests.

### Task 4: Verification And Canary

**Files:**
- Generated evidence under `.deepseek/swe-lite-runs/<runId>`.

**Interfaces:**
- Produces: task 1 canary result with resolved status, child request count, and cache diagnostics.

- [x] **Step 1:** Run prompt assembly focused tests.
- [x] **Step 2:** Run `npm run typecheck` and `npm run build:cli`.
- [x] **Step 3:** Re-run SWE-bench Lite task 1 with a fresh run id.
- [x] **Step 4:** Inspect `summary.json` for `evaluationResolved`, child request count, and absence/presence of cache diagnostics.

### Task 5: Shared Board Prefix Contract

**Files:**
- Create: `src/packages/prompt-assembly/src/providers/shared-board-contract.ts`
- Modify: `src/packages/prompt-assembly/src/providers.ts`
- Modify: `src/packages/prompt-assembly/test/prompt-assembly.test.ts`
- Modify: `openspec/changes/2026-07-06-stabilize-provider-prefix-cache/specs/context-pipeline-prefix-cache/spec.md`
- Modify: `openspec/changes/2026-07-06-stabilize-provider-prefix-cache/tasks.md`

**Interfaces:**
- Consumes: `PromptAssemblyInput.toolDecisionBoard`.
- Produces: stable provider-prefix section `core.shared-board-contract`.
- Preserves: dynamic board records remain in `core.tool-decision-board` as ephemeral tail content.

- [x] **Step 1:** Add failing prompt assembly regression that changes board id, iteration, records, and recommendations while expecting provider prefix fingerprint stability.
- [x] **Step 2:** Add a stable shared board cache contract provider containing only board schema, parent-child sharing rules, and partition boundaries.
- [x] **Step 3:** Register the provider in default prompt section providers before dynamic board summaries.
- [x] **Step 4:** Run focused prompt assembly tests, OpenSpec validation, typecheck, and CLI build.
- [x] **Step 5:** Re-run SWE-bench Lite task 1 and compare provider cache summary against the previous failed run.

Result: `swe-lite-task-1-deepseek-support-tools-v3-20260706-1` resolved `astropy__astropy-12907` with 8 child model requests, 1 completed mutation, 1 successful test command, `patchBytes=506`, and `technicalDirectorAcceptance.accepted=true`. Provider prefix stayed stable (`uniqueProviderPrefixFingerprintCount=1`), but provider cache remained below target at 74.4% because dynamic request tails still dominated misses.
