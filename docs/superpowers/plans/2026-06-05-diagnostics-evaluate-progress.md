# Diagnostics Evaluate Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show safe, real-time `diagnostics evaluate` progress while child DeepSeek CLI tasks are still running.

**Architecture:** Keep final evaluation records unchanged. Add an optional host-only platform process chunk observer as a fourth `runProcess` argument, and a diagnostics progress sink that projects only allowlisted child JSONL events into bounded public progress lines.

**Tech Stack:** TypeScript, Node child_process, existing `PlatformRuntime`, CLI diagnostics, OpenSpec, node:test.

---

### Task 1: Platform Process Chunk Observer

**Files:**
- Modify: `src/packages/platform-contracts/src/platform.ts`
- Modify: `src/packages/platform-abstraction/src/index.ts`
- Test: `src/packages/platform-abstraction/test/process-streaming.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it("streams stdout chunks through the optional process observer before completion", async () => {
  const platform = new NodePlatformRuntime();
  const chunks: string[] = [];

  const result = await platform.runProcess(
    process.execPath,
    ["-e", "process.stdout.write('one\\n'); setTimeout(() => process.stdout.write('two\\n'), 20);"],
    {},
    { onStdoutChunk: (chunk) => chunks.push(chunk) }
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.includes("one"), true);
  assert.equal(result.stdout.includes("two"), true);
  assert.equal(chunks.join("").includes("one"), true);
  assert.equal(chunks.join("").includes("two"), true);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/packages/platform-abstraction/test/process-streaming.test.ts --test-name-pattern "streams stdout chunks"`

Expected: FAIL because `runProcess()` ignores the observer and `chunks` stays empty.

- [x] **Step 3: Write minimal implementation**

Add a host-only observer beside serializable `ProcessRunOptions`:

```ts
export interface ProcessRunObserver {
readonly onStdoutChunk?: (chunk: string) => void;
readonly onStderrChunk?: (chunk: string) => void;
}
```

Call it from `NodePlatformRuntime.runProcess()` inside the stdout/stderr `data` handlers before bounded aggregation.

- [x] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/packages/platform-abstraction/test/process-streaming.test.ts --test-name-pattern "streams stdout chunks"`

Expected: PASS.

### Task 2: Safe Evaluation Progress Projection

**Files:**
- Create: `src/apps/cli/src/diagnostics/evaluation-progress.ts`
- Modify: `src/apps/cli/src/diagnostics/evaluation-task-execution.ts`
- Modify: `src/apps/cli/src/diagnostics/evaluation.ts`
- Modify: `src/apps/cli/src/diagnostics/index.ts`
- Test: `src/apps/cli/test/cli.test.ts`

- [x] **Step 1: Write the failing test**

Add a CLI diagnostics test with a fake platform whose `runProcess()` calls the fourth-argument process observer with child JSONL lines for `model.tool.intent`, `model.tool.result`, and `model.delta`.

Expected assertions:

```ts
assert.equal(lines.some((line) => line.includes("progress eval.webpage.generation: tool core.file.read started")), true);
assert.equal(lines.some((line) => line.includes("progress eval.webpage.generation: tool core.file.read success")), true);
assert.equal(lines.join("\\n").includes("secret raw delta"), false);
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-name-pattern "streams safe diagnostics evaluate progress" src/apps/cli/test/cli.test.ts`

Expected: FAIL because no progress sink exists.

- [x] **Step 3: Write minimal implementation**

Implement:

```ts
export interface EvaluationProgressSink {
  emit(line: string): void;
}

export function progressLineFromChildJsonl(taskId: string, line: string): string | undefined;
```

Allowlist only:
- `model.tool.intent`
- `model.tool.result`
- `agent.repair.started`
- `agent.repair.stopped`
- `agent.loop.completed`
- `agent.loop.failed`

Never emit `model.delta`, raw stdout, raw stderr, provider request bodies, or JSON payloads.

- [x] **Step 4: Run test to verify it passes**

Run: `npx tsx --test --test-name-pattern "streams safe diagnostics evaluate progress" src/apps/cli/test/cli.test.ts`

Expected: PASS.

### Task 3: OpenSpec, Build, and Commit

**Files:**
- Modify: `openspec/changes/2026-06-05-add-task-delivery-flow/specs/cli-diagnostics-release-readiness/spec.md`
- Modify: `openspec/changes/2026-06-05-add-task-delivery-flow/tasks.md`

- [x] **Step 1: Add bilingual OpenSpec scenario**

Document that `diagnostics evaluate` may stream bounded public progress while a child process is still running and must not expose raw chain-of-thought or unbounded stdout/stderr.

- [x] **Step 2: Verify**

Run:

```bash
node_modules/.bin/openspec validate --specs --strict
npm run typecheck
npm run lint
node scripts/check-boundaries.mjs
npm run build:cli
npm test
```

Expected: all commands exit 0.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-06-05-diagnostics-evaluate-progress.md src packages openspec
git commit -m "feat: stream diagnostics evaluation progress"
```
