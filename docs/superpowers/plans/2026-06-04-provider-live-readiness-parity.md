# Provider Live Readiness Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `diagnostics` and local readiness treat GLM live verification as a first-class provider path while preserving DeepSeek defaults.

**Architecture:** Keep runtime/model execution on provider-neutral `ModelGateway` contracts. Add provider-aware readiness metadata, credential checks, live verifier selection, and release evidence classification in CLI/command-system host layers without importing provider internals outside package-root exports.

**Tech Stack:** TypeScript, Node test runner, OpenSpec, `@deepseek/command-system`, `@deepseek/model-gateway`, `@deepseek/credential-auth-management`, CLI diagnostics.

---

### Task 1: OpenSpec Contract

**Files:**
- Create: `openspec/changes/provider-live-readiness-parity/.openspec.yaml`
- Create: `openspec/changes/provider-live-readiness-parity/proposal.md`
- Create: `openspec/changes/provider-live-readiness-parity/design.md`
- Create: `openspec/changes/provider-live-readiness-parity/tasks.md`
- Create: `openspec/changes/provider-live-readiness-parity/specs/local-readiness/spec.md`
- Create: `openspec/changes/provider-live-readiness-parity/specs/cli-diagnostics-release-readiness/spec.md`

- [x] **Step 1: Add bilingual OpenSpec artifacts**

Write the change as provider-aware readiness parity, not a new provider implementation.

- [x] **Step 2: Validate the change**

Run: `npx openspec validate provider-live-readiness-parity --type change --strict`
Expected: valid.

### Task 2: Provider-Aware Readiness Contract

**Files:**
- Test: `tests/contracts/local-readiness.test.ts`
- Modify: `src/packages/command-system/src/implementation.ts`
- Modify: `src/packages/platform-contracts/src/readiness.ts`

- [x] **Step 1: Write failing contract tests**

Add tests that expect `doctor` to report `auth.glm`, provider metadata, and live check messages using the selected provider.

- [x] **Step 2: Run focused contract test**

Run: `npx tsx --test tests/contracts/local-readiness.test.ts`
Expected: fail because readiness is DeepSeek-only.

- [x] **Step 3: Implement minimal contract support**

Extend readiness environment metadata enough to represent selected model provider and credential references without raw secrets.

- [x] **Step 4: Re-run focused contract test**

Run: `npx tsx --test tests/contracts/local-readiness.test.ts`
Expected: pass.

### Task 3: CLI Diagnostics Provider Selection

**Files:**
- Test: `src/apps/cli/test/cli.test.ts`
- Modify: `src/apps/cli/src/commands/parse.ts`
- Modify: `src/apps/cli/src/commands/readiness.ts`
- Modify: `src/apps/cli/src/diagnostics/index.ts`

- [x] **Step 1: Write failing CLI tests**

Add tests for `diagnostics doctor --live --provider glm --model glm-5.1 --output json` proving the parsed provider reaches readiness input and JSON metadata.

- [x] **Step 2: Run focused CLI tests**

Run: `npx tsx --test src/apps/cli/test/cli.test.ts --test-name-pattern "diagnostics doctor"`
Expected: fail because diagnostics ignores `--provider`.

- [x] **Step 3: Implement minimal CLI wiring**

Parse provider/model for diagnostics and reuse the existing model profile selection to build the live verifier.

- [x] **Step 4: Re-run focused CLI tests**

Run: `npx tsx --test src/apps/cli/test/cli.test.ts --test-name-pattern "diagnostics doctor"`
Expected: pass.

### Task 4: Provider-Aware Release Evidence

**Files:**
- Test: `tests/contracts/local-readiness.test.ts`
- Test: `src/apps/cli/test/cli.test.ts`
- Modify: `src/apps/cli/src/diagnostics/release-evidence.ts`
- Modify: `scripts/write-acceptance-index.mjs`
- Modify: `tests/acceptance/acceptance-index.md`

- [x] **Step 1: Write failing release evidence tests**

Add GLM evidence fixture expectations and ensure legacy DeepSeek evidence still passes.

- [x] **Step 2: Run focused tests**

Run: `npx tsx --test tests/contracts/local-readiness.test.ts src/apps/cli/test/cli.test.ts --test-name-pattern "release|acceptance|provider"`
Expected: fail where evidence is DeepSeek-only.

- [x] **Step 3: Implement minimal release evidence support**

Add provider-aware required commands and GLM acceptance index entries without making GLM the default release blocker unless provider-specific verification is requested.

- [x] **Step 4: Re-run focused tests**

Run: `npx tsx --test tests/contracts/local-readiness.test.ts src/apps/cli/test/cli.test.ts --test-name-pattern "release|acceptance|provider"`
Expected: pass.

### Task 5: Verification And Commit

**Files:**
- All changed files.

- [x] **Step 1: Run OpenSpec and focused checks**

Run: `npx openspec validate provider-live-readiness-parity --type change --strict`
Run: `npx openspec validate --specs --strict`
Run focused tests from Tasks 2-4.

- [x] **Step 2: Run framework checks**

Run: `npm run typecheck`
Run: `npm run lint`
Run: `npm test`
Run: `node scripts/check-boundaries.mjs`

- [x] **Step 3: Run live GLM verification when credential is provided out-of-band**

Run: `npm run smoke:live:glm`
Run: `npm run smoke:live:glm-agent-tools`
Run: `deepseek diagnostics doctor --live --provider glm --model glm-5.1 --output json`

- [x] **Step 4: Hygiene and commit**

Run: `git diff --check`
Run: `git status --short --ignored`
Run: `git ls-files -- '参考/*'`
Commit with a provider-readiness message only after verification evidence is read.
