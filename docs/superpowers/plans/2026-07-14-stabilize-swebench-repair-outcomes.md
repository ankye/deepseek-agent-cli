# SWE-bench Repair Outcome Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make governed SWE-bench repairs recover from stale edits, preserve and restore the best officially scored candidate, require task-specific behavior reproduction, and report the authoritative benchmark outcome.

**Architecture:** Generic runtime receives only a one-shot same-target mutation recovery and a host-activated behavior-reproduction gate. SWE-specific candidate scoring, artifact persistence, checkout restoration, and best/last attempt state remain in the CLI host. The diagnostics adapter reads the nested runner summary, while failure attribution keeps cache metrics secondary to correctness and flow failures.

**Tech Stack:** TypeScript, Node.js test runner through `tsx --test`, OpenSpec, injected `PlatformRuntime`, existing CLI/runtime contracts.

## Global Constraints

- Follow the repository test-first gate: each production behavior change starts with a focused failing regression and a confirmed RED result.
- Keep `src/apps/cli` as the SWE host owner; do not move SWE-specific candidate policy into `src/packages/runtime`.
- Do not introduce benchmark instance, repository, test-id, or gold-patch tailoring.
- Keep all OpenSpec behavior and implementation guidance bilingual.
- Preserve existing user-authored worktree changes. Do not revert them or include them in an implementation commit unless the staged diff is proven to contain only this repair.
- Cache readiness remains observable but cannot become the primary explanation for a semantic correctness or flow failure.
- A live GLM result is observational acceptance; deterministic tests validate the framework repair.

---

## File Structure

- Create `src/apps/cli/src/host/swe-bench-attempt-candidates.ts`: pure attempt score, comparison, and best-candidate selection.
- Create `src/apps/cli/src/host/swe-bench-attempt-candidates.test.ts`: focused unit coverage for ranking and non-harness-ready candidates.
- Modify `src/packages/runtime/src/agent-loop.ts`: one-shot exact-target mutation recovery and host-activated behavior reproduction state.
- Modify `src/packages/runtime/src/agent-loop-tools.ts`: project exact-refresh tools while the recovery override is active.
- Modify `src/packages/runtime/src/ready-stage-control.ts`: targeted recovery feedback and exhaustion wording.
- Modify `src/packages/runtime/test/runtime-tool-feedback.test.ts`: runtime regressions for stale edit recovery and first-attempt behavior reproduction.
- Modify `src/apps/cli/src/host/swe-bench-run-capabilities.ts`: candidate persistence, restoration, best/last attempt summary, behavior-contract ref, and correctness-first attribution.
- Modify `src/apps/cli/src/host/swe-bench-run-capabilities.test.ts`: deterministic three-attempt orchestration and attribution regressions.
- Modify `src/apps/cli/src/diagnostics/swe-bench-cli-diagnostics.ts`: authoritative nested outcome extraction.
- Modify `src/apps/cli/test/cli.test.ts`: outer diagnostics status regression.
- Modify `openspec/changes/2026-07-13-stabilize-swebench-repair-outcomes/tasks.md`: acceptance evidence and completed task state.

### Task 1: One-Shot Exact-Target Mutation Recovery

**Files:**
- Modify: `src/packages/runtime/test/runtime-tool-feedback.test.ts`
- Modify: `src/packages/runtime/src/agent-loop.ts`
- Modify: `src/packages/runtime/src/agent-loop-tools.ts`
- Modify: `src/packages/runtime/src/ready-stage-control.ts`

**Interfaces:**
- Consumes: typed tool diagnostics with `details.originalCode === "EDIT_PRECONDITION_FAILED"`, the failed mutation input path, and the active workflow gate.
- Produces: runtime override `requiredNextAction: "exact-target-refresh-or-source-edit-or-bounded-blocker"`, terminal reason `flow-mutation-recovery-exhausted`, and attribution code `FLOW_MUTATION_RECOVERY_EXHAUSTED`.

- [ ] **Step 1: Add a failing same-target recovery regression**

Add a sequential gateway case that exhausts official-repair focused reads, fails an exact `core.file.edit`, then requests one bounded read of the failed target and a corrected edit:

```ts
function fourFocusedOfficialRepairReads(path: string) {
  return Array.from({ length: 4 }, (_, index) => ({
    id: `call-official-read-${index + 1}`,
    name: "core.file.read",
    input: { path, offset: 0, limit: 20 }
  }));
}

function toolResult(events: readonly RuntimeEvent[], toolCallId: string): RuntimeEvent | undefined {
  return events.find((event) =>
    event.kind === "model.tool.result" && event.data.toolCallId === toolCallId
  );
}

async function runOfficialRepairChangeLoop(
  deps: ReturnType<typeof createDeterministicRuntimeDependencies>,
  gateway: SequentialToolCallModelGateway
): Promise<readonly RuntimeEvent[]> {
  const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
  await registerRuntimeCoreTools(loopDeps, "/workspace");
  const kernel = await createDefaultRuntimeKernel(loopDeps);
  const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
    prompt: "refresh official repair evidence, recover one stale edit, then mutate",
    caller: "runtime.official-repair-exact-refresh.test",
    workspaceRoot: "/workspace",
    outputMode: "jsonl",
    profile: defaultDeepSeekProfile,
    toolProjection: "safe-all",
    profilePolicy: supervisorOfficialRepairChangePolicy(),
    limits: { maxModelIterations: 10, maxToolCalls: 10 }
  }));
  await kernel.shutdown();
  return events;
}

it("allows one exact target refresh after an official repair edit precondition failure", async () => {
  const deps = createDeterministicRuntimeDependencies();
  await deps.platform.writeFile("/workspace/README.md", "current repair target\n");
  const gateway = new SequentialToolCallModelGateway([
    ...fourFocusedOfficialRepairReads("README.md"),
    {
      id: "call-stale-edit",
      name: "core.file.edit",
      input: { path: "README.md", expected: "stale repair target", replacement: "fixed repair target" }
    },
    {
      id: "call-exact-refresh",
      name: "core.file.read",
      input: { path: "README.md", offset: 0, limit: 20 }
    },
    {
      id: "call-corrected-edit",
      name: "core.file.edit",
      input: { path: "README.md", expected: "current repair target", replacement: "fixed repair target" }
    }
  ]);

  const events = await runOfficialRepairChangeLoop(deps, gateway);

  assert.equal(toolResult(events, "call-exact-refresh")?.data.terminalKind, "capability.completed");
  assert.equal(await deps.platform.readFile("/workspace/README.md"), "fixed repair target\n");
});
```

- [ ] **Step 2: Run the regression and confirm RED**

Run:

```bash
TSX_DISABLE_CACHE=1 npx tsx --test --test-name-pattern "allows one exact target refresh" src/packages/runtime/test/runtime-tool-feedback.test.ts
```

Expected: FAIL because the live-equivalent gate continues to require `core.patch.apply|core.file.edit` and rejects `call-exact-refresh`.

- [ ] **Step 3: Add failing wrong-target and repeated-refresh coverage**

Add two assertions to a separate test:

```ts
assert.equal(toolResult(events, "call-wrong-target")?.data.terminalKind, "workflow-mutation-recovery-target.rejected");
assert.equal(events.some((event) =>
  event.kind === "agent.loop.failed" &&
  event.data.reason === "flow-mutation-recovery-exhausted"
), true);
```

Run the same focused command with pattern `mutation recovery` and confirm the new cases fail for the expected missing behavior.

- [ ] **Step 4: Implement typed recovery state**

In `agent-loop.ts`, add per-stage recovery state with exact target ownership:

```ts
interface MutationExactRefreshState {
  readonly targetPath: string;
  readonly failedToolCallId: string;
  readonly consumed: boolean;
}

const mutationExactRefreshByStage = new Map<string, MutationExactRefreshState>();
```

When a recoverable mutation terminal contains `EDIT_PRECONDITION_FAILED`, set the state from `toolInput.path` and project:

```ts
const gateOverride = convergenceWorkflowGateOverride({
  requiredNextAction: "exact-target-refresh-or-source-edit-or-bounded-blocker",
  rejectedCapabilityId: String(preflight.capabilityId),
  rejectedToolName: toolName,
  terminalKind: "workflow-mutation-exact-refresh.required",
  toolCallId
});
```

Preflight permits `core.file.read` only when its normalized path equals `targetPath` and `consumed === false`. After successful bounded evidence, mark it consumed and replace the override with `core.file.edit|core.patch.apply`. Wrong-target or repeated refresh emits `flow-mutation-recovery-exhausted` without self-repair classification as `needs-user`.

- [ ] **Step 5: Project the recovery tool set and targeted feedback**

Teach `agent-loop-tools.ts` and required-action parsing that:

```ts
"exact-target-refresh-or-source-edit-or-bounded-blocker"
```

projects `core.file.read`, `core.file.edit`, and `core.patch.apply`. Add a correction message in `ready-stage-control.ts` that names the exact target path and states that only one bounded read is available.

- [ ] **Step 6: Verify GREEN and nearby runtime coverage**

Run:

```bash
TSX_DISABLE_CACHE=1 npx tsx --test --test-name-pattern "mutation recovery|failed source edits from standard-test repair" src/packages/runtime/test/runtime-tool-feedback.test.ts
```

Expected: all selected tests PASS, including the existing standard-test repair recovery case.

- [ ] **Step 7: Record an implementation checkpoint**

Inspect `git diff -- src/packages/runtime`. Commit only when the staged diff excludes pre-existing user changes; otherwise leave the verified checkpoint uncommitted and record the passing command in the OpenSpec task evidence.

### Task 2: Host-Activated Initial Behavior Reproduction

**Files:**
- Modify: `src/apps/cli/src/host/swe-bench-run-capabilities.test.ts`
- Modify: `src/apps/cli/src/host/swe-bench-run-capabilities.ts`
- Modify: `src/packages/runtime/test/runtime-tool-feedback.test.ts`
- Modify: `src/packages/runtime/src/agent-loop.ts`

**Interfaces:**
- Consumes: initial SWE instance file, staged runner state, and the `toolResult()` test helper introduced in Task 1.
- Produces: `ref:runner:problem-behavior-contract` and a runtime predicate that requires one safe governed reproduction before successful public-test-only closure.

- [ ] **Step 1: Add a failing runner-state contract test**

Extend the initial child-state test to assert:

```ts
const behaviorRef = refs?.find((ref) => ref.refId === "ref:runner:problem-behavior-contract");
const verifyStage = stageStates?.find((stage) => stage.stageId === "verify");

assert.equal(behaviorRef?.type, "diagnostic");
assert.equal(behaviorRef?.path, "/workspace/.deepseek/swe-lite-runs/unit-run/instance.json");
assert.equal((verifyStage?.inputRefs as string[]).includes("ref:runner:problem-behavior-contract"), true);
```

- [ ] **Step 2: Confirm runner-state RED**

Run:

```bash
TSX_DISABLE_CACHE=1 npx tsx --test --test-name-pattern "problem behavior contract" src/apps/cli/src/host/swe-bench-run-capabilities.test.ts
```

Expected: FAIL because the initial runner state has no behavior-contract ref.

- [ ] **Step 3: Add runtime RED coverage for initial public-test closure**

Add a profile policy containing `ref:runner:problem-behavior-contract`:

```ts
function supervisorInitialBehaviorContractVerifyPolicy(): AgentLoopProfilePolicyMetadata {
  const policy = supervisorOfficialRepairVerifyPolicy();
  const workflow = policy.stagedTaskWorkflow;
  if (!workflow) return policy;
  const behaviorRef: StagedTaskRef = {
    schemaVersion: STAGED_TASK_SCHEMA_VERSION,
    refId: "ref:runner:problem-behavior-contract",
    type: "diagnostic",
    producerStageId: "stage:understand",
    scope: "task",
    metadata: { source: "problem-statement", reproductionRequired: true },
    compatibility: STAGED_TASK_COMPATIBILITY,
    redaction: { class: "internal", fields: ["metadata"] }
  };
  return {
    ...policy,
    stagedTaskWorkflow: {
      ...workflow,
      runState: {
        ...workflow.runState,
        refs: [
          ...(workflow.runState.refs ?? []).filter((ref) =>
            ref.refId !== "ref:runner:official-repair-feedback"
          ),
          behaviorRef
        ],
        stageStates: workflow.runState.stageStates.map((stage) => ({
          ...stage,
          inputRefs: stage.inputRefs.map((refId) =>
            refId === "ref:runner:official-repair-feedback" ? behaviorRef.refId : refId
          )
        }))
      }
    }
  };
}
```

Then sequence a successful public pytest, a safe `python -c` reproduction, and the public pytest again:

```ts
it("requires initial SWE behavior reproduction before public test-only closure", async () => {
  const deps = createDeterministicRuntimeDependencies({
    platform: new SuccessfulTestWithShellFakePlatformRuntime()
  });
  const gateway = new SequentialToolCallModelGateway([
    {
      id: "call-public-pytest-only",
      name: "core.test.run",
      input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"] }
    },
    {
      id: "call-problem-reproduction",
      name: "core.shell.run",
      input: {
        command: "cd /workspace && python -c \"from io import StringIO; print(StringIO('x').read())\"",
        intent: "reproduce the problem-statement behavior without mutation"
      }
    },
    {
      id: "call-public-pytest-after-repro",
      name: "core.test.run",
      input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"] }
    }
  ]);
  const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
  await registerRuntimeCoreTools(loopDeps, "/workspace");
  const kernel = await createDefaultRuntimeKernel(loopDeps);
  const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
    prompt: "verify the initial SWE behavior contract before public-test closure",
    caller: "runtime.initial-swe-behavior-reproduction.test",
    workspaceRoot: "/workspace",
    outputMode: "jsonl",
    profile: defaultDeepSeekProfile,
    toolProjection: "safe-all",
    profilePolicy: supervisorInitialBehaviorContractVerifyPolicy(),
    limits: { maxModelIterations: 5, maxToolCalls: 6 }
  }));

  const publicOnlyMiss = events.find((event) =>
    event.kind === "workflow.required-action.missed" &&
    event.data.requestedCapabilityId === "core.test.run" &&
    event.error?.message.includes("WORKFLOW_BEHAVIOR_REPRODUCTION_REQUIRED")
  );

  assert.notEqual(publicOnlyMiss, undefined);
  assert.equal(toolResult(events, "call-problem-reproduction")?.data.terminalKind, "capability.completed");
  assert.equal(events.some((event) =>
    event.kind === "agent.loop.completed" && event.data.reason === "terminal-tool-completed"
  ), true);
  await kernel.shutdown();
});
```

Also run the existing ordinary verify policy without the ref and assert it still closes from a successful standard test.

- [ ] **Step 4: Confirm runtime RED**

Run:

```bash
TSX_DISABLE_CACHE=1 npx tsx --test --test-name-pattern "initial SWE behavior reproduction" src/packages/runtime/test/runtime-tool-feedback.test.ts
```

Expected: FAIL because reproduction enforcement currently recognizes official repair feedback only.

- [ ] **Step 5: Implement the host ref and generic activation predicate**

Add the initial reference in `runnerStageRefs()`:

```ts
runnerRef(
  "ref:runner:problem-behavior-contract",
  "diagnostic",
  "understand",
  runRoot ? `${runRoot}/instance.json` : undefined,
  { source: "problem-statement", reproductionRequired: true }
)
```

Include it in `verify` input refs. Replace the repair-only runtime predicate with a generic host-reference predicate:

```ts
function evaluationBehaviorReproductionActive(
  profilePolicy: AgentLoopProfilePolicyMetadata | undefined
): boolean {
  return (profilePolicy?.stagedTaskWorkflow?.runState.refs ?? []).some((ref) =>
    ref.refId === "ref:runner:problem-behavior-contract" ||
    ref.refId === "ref:runner:official-repair-feedback"
  );
}
```

Use the existing safe non-mutating reproduction classifier. Failed public tests remain failure evidence; only successful public-test closure is gated.
Emit `WORKFLOW_BEHAVIOR_REPRODUCTION_REQUIRED` for both activating refs so the rule is named for the generic behavior contract rather than for an official-repair phase.

- [ ] **Step 6: Verify GREEN**

Run both focused commands from Steps 2 and 4. Expected: all selected tests PASS and ordinary workflows remain unchanged.

- [ ] **Step 7: Record an implementation checkpoint**

Review the host/runtime diff. Commit only when no pre-existing worktree edits would be captured.

### Task 3: Pure Attempt Candidate Ranking

**Files:**
- Create: `src/apps/cli/src/host/swe-bench-attempt-candidates.ts`
- Create: `src/apps/cli/src/host/swe-bench-attempt-candidates.test.ts`

**Interfaces:**
- Consumes: attempt number, patch/prediction artifact paths, optional official evaluation, and local harness-readiness evidence.
- Produces: `SweBenchAttemptCandidate`, `compareSweBenchAttemptCandidates()`, and `selectBestSweBenchAttemptCandidate()`.

- [ ] **Step 1: Write candidate ranking tests before the module exists**

Create tests for resolved preference, pass-to-pass protection, fail-to-pass comparison, and non-harness-ready rejection:

```ts
function candidate(
  overrides: Partial<SweBenchAttemptCandidate<Record<string, never>, Record<string, never>>>
): SweBenchAttemptCandidate<Record<string, never>, Record<string, never>> {
  const attempt = overrides.attempt ?? 1;
  return {
    attempt,
    patchPath: `/run/candidate-attempt-${attempt}.patch`,
    predictionPath: `/run/prediction-attempt-${attempt}.jsonl`,
    tracePath: `/run/trace-attempt-${attempt}.jsonl`,
    metadataPath: `/run/candidate-attempt-${attempt}.json`,
    prediction: {},
    harnessReady: true,
    localVerificationPassed: true,
    harnessReportValid: true,
    resolved: false,
    passToPassFailures: 0,
    failToPassFailures: 1,
    ...overrides
  };
}

it("keeps a harness-scored candidate over a later non-harness-ready attempt", () => {
  const best = selectBestSweBenchAttemptCandidate([
    candidate({ attempt: 1, harnessReportValid: true, resolved: false, passToPassFailures: 0, failToPassFailures: 1 }),
    candidate({ attempt: 2, harnessReportValid: false, resolved: false, passToPassFailures: 0, failToPassFailures: 0 })
  ]);

  assert.equal(best?.attempt, 1);
});
```

```ts
it("rejects a repair that introduces pass-to-pass regressions", () => {
  const comparison = compareSweBenchAttemptCandidates(
    candidate({ attempt: 2, harnessReportValid: true, passToPassFailures: 9, failToPassFailures: 1 }),
    candidate({ attempt: 1, harnessReportValid: true, passToPassFailures: 0, failToPassFailures: 1 })
  );

  assert.equal(comparison < 0, true);
});
```

- [ ] **Step 2: Run the new test file and confirm RED**

Run:

```bash
TSX_DISABLE_CACHE=1 npx tsx --test src/apps/cli/src/host/swe-bench-attempt-candidates.test.ts
```

Expected: FAIL because the candidate module does not exist.

- [ ] **Step 3: Implement the minimal pure candidate model**

Create:

```ts
export interface SweBenchAttemptCandidate<TPrediction = unknown, TEvaluation = unknown> {
  readonly attempt: number;
  readonly patchPath: string;
  readonly predictionPath: string;
  readonly tracePath: string;
  readonly metadataPath: string;
  readonly prediction: TPrediction;
  readonly evaluation?: TEvaluation;
  readonly harnessReady: boolean;
  readonly localVerificationPassed: boolean;
  readonly harnessReportValid: boolean;
  readonly resolved: boolean;
  readonly passToPassFailures: number;
  readonly failToPassFailures: number;
}

function candidateScore(candidate: SweBenchAttemptCandidate): readonly number[] {
  return [
    candidate.resolved ? 1 : 0,
    candidate.harnessReportValid ? 1 : 0,
    -candidate.passToPassFailures,
    -candidate.failToPassFailures,
    candidate.harnessReady ? 1 : 0,
    candidate.localVerificationPassed ? 1 : 0
  ];
}

export function compareSweBenchAttemptCandidates<TPrediction, TEvaluation>(
  left: SweBenchAttemptCandidate<TPrediction, TEvaluation>,
  right: SweBenchAttemptCandidate<TPrediction, TEvaluation>
): number {
  const leftScore = candidateScore(left);
  const rightScore = candidateScore(right);
  for (let index = 0; index < leftScore.length; index += 1) {
    const difference = (leftScore[index] ?? 0) - (rightScore[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return right.attempt - left.attempt;
}

export function selectBestSweBenchAttemptCandidate<TPrediction, TEvaluation>(
  candidates: readonly SweBenchAttemptCandidate<TPrediction, TEvaluation>[]
): SweBenchAttemptCandidate<TPrediction, TEvaluation> | undefined {
  return candidates.reduce<SweBenchAttemptCandidate<TPrediction, TEvaluation> | undefined>((best, candidate) =>
    !best || compareSweBenchAttemptCandidates(candidate, best) > 0 ? candidate : best
  , undefined);
}
```

The score orders resolved, valid report, negative pass-to-pass failures, negative fail-to-pass failures, harness readiness, and local verification. The attempt-number fallback makes an earlier equal candidate stable.

- [ ] **Step 4: Verify GREEN**

Run the new test file. Expected: all candidate ranking tests PASS.

- [ ] **Step 5: Commit the isolated new module when safe**

Because both files are new, stage only these two files, inspect `git diff --cached`, and commit with:

```bash
git commit -m "feat: rank SWE-bench attempt candidates"
```

Skip the commit if another process has staged unrelated files.

### Task 4: Transactional Attempt Persistence And Restoration

**Files:**
- Modify: `src/apps/cli/src/host/swe-bench-run-capabilities.test.ts`
- Modify: `src/apps/cli/src/host/swe-bench-run-capabilities.ts`
- Use: `src/apps/cli/src/host/swe-bench-attempt-candidates.ts`

**Interfaces:**
- Consumes: `SweBenchAttemptCandidate` ranking functions and existing prediction/evaluation summaries.
- Produces: immutable attempt artifacts, `bestAttempt`, `lastAttempt`, restored best checkout, and a final authoritative best evaluation.

- [ ] **Step 1: Extend the fake platform for per-attempt evidence**

Add deterministic arrays without changing existing defaults:

```ts
gitDiffOutputs: string[] = [];
harnessOutcomes: Array<{
  readonly resolved: boolean;
  readonly failToPassFailures: readonly string[];
  readonly passToPassFailures: readonly string[];
}> = [];
```

Return `gitDiffOutputs[agentRunCount - 1] ?? gitDiffOutput` for `git diff`, and use `harnessOutcomes[harnessRunCount - 1]` when writing reports.

- [ ] **Step 2: Add the three-attempt failing orchestration regression**

Configure:

```ts
function failedChildTraceWithoutMutation(): string {
  return [
    JSON.stringify({ kind: "model.requested", data: { iteration: 1 } }),
    JSON.stringify({
      kind: "agent.loop.failed",
      data: { status: "rejected", reason: "flow-mutation-recovery-exhausted" }
    })
  ].join("\n") + "\n";
}

const runRoot = "/workspace/.deepseek/swe-lite-runs/unit-run-best-candidate";
const patchOne = [
  "diff --git a/src/example.py b/src/example.py",
  "--- a/src/example.py",
  "+++ b/src/example.py",
  "@@ -1 +1 @@",
  "-old",
  "+best-candidate",
  ""
].join("\n");
const patchTwo = [
  "diff --git a/src/example.py b/src/example.py",
  "--- a/src/example.py",
  "+++ b/src/example.py",
  "@@ -1 +1 @@",
  "-old",
  "+regressed-candidate",
  ""
].join("\n");

platform.gitDiffOutputs = [patchOne, patchTwo, patchOne];
platform.agentStdouts = [solvedChildTrace(), solvedChildTrace(), failedChildTraceWithoutMutation()];
platform.harnessOutcomes = [
  { resolved: false, failToPassFailures: ["tests/test_demo.py::test_expected_fix"], passToPassFailures: [] },
  { resolved: false, failToPassFailures: ["tests/test_demo.py::test_expected_fix"], passToPassFailures: ["tests/test_demo.py::test_existing"] }
];
```

Assert:

```ts
assert.equal(metadata?.bestAttempt, 1);
assert.equal(metadata?.lastAttempt, 3);
assert.equal(metadata?.evaluationResolved, false);
assert.equal(metadata?.passToPassFailureCount, 0);
assert.equal(await platform.readFile(`${runRoot}/candidate-attempt-1.patch`), patchOne);
assert.equal(await platform.readFile(`${runRoot}/candidate-attempt-2.patch`), patchTwo);
assert.equal(await platform.readFile(`${runRoot}/prediction.jsonl`), await platform.readFile(`${runRoot}/prediction-attempt-1.jsonl`));
assert.equal(platform.executedCommands.some((entry) => entry.command === "git" && entry.args.includes("apply")), true);
```

Execute the capability with `runId: "unit-run-best-candidate"`; `runRoot` above is the corresponding deterministic artifact root.

- [ ] **Step 3: Run the orchestration regression and confirm RED**

Run:

```bash
TSX_DISABLE_CACHE=1 npx tsx --test --test-name-pattern "restores the best SWE-bench candidate" src/apps/cli/src/host/swe-bench-run-capabilities.test.ts
```

Expected: FAIL because the runner currently overwrites shared prediction state and returns early from attempt 3.

- [ ] **Step 4: Add attempt fields to the summary contract local to the CLI host**

Extend `SweBenchRunSummary`:

```ts
readonly bestAttempt?: number;
readonly lastAttempt?: number;
readonly attemptCandidates?: readonly JsonObject[];
readonly lastAttemptTerminalReason?: string;
```

Extend the internal `summary()` input so the authoritative and terminal attempts remain separate:

```ts
readonly bestAttempt?: number;
readonly lastAttempt?: number;
readonly lastAttemptPrediction?: SweBenchPredictionSummary;
```

Extend `SweBenchRepairContext` only with host-neutral evidence fields needed by prompt rendering:

```ts
readonly restoredFromAttempt?: number;
readonly discardedRegressedAttempt?: number;
```

- [ ] **Step 5: Persist immutable candidate artifacts**

After every prediction, write:

```ts
candidate-attempt-${attempt}.patch
prediction-attempt-${attempt}.jsonl
trace-attempt-${attempt}.jsonl
candidate-attempt-${attempt}.json
```

The metadata JSON contains only observable counts, artifact paths, readiness, official score fields, and redaction metadata. Persistence failure adds `SWE_BENCH_ATTEMPT_ARTIFACT_PERSIST_FAILED` and prevents candidate promotion.

- [ ] **Step 6: Restore the best candidate before a later repair**

When the latest scored candidate ranks below the best candidate, run in the isolated checkout:

```ts
await platform.runProcess("git", ["-C", repoDir, "reset", "--hard", instance.baseCommit], options);
await platform.runProcess("git", ["-C", repoDir, "clean", "-fdx", "-e", ".venv"], options);
await platform.runProcess("git", ["-C", repoDir, "apply", "--binary", best.patchPath], options);
```

Record every command in `run-progress.jsonl`. On failure, emit `SWE_BENCH_CANDIDATE_RESTORE_FAILED`, retain all artifacts, and stop without model attribution.

- [ ] **Step 7: Return best and last evidence together**

Replace the pre-harness early return so it chooses the best candidate and passes its prediction/evaluation into `summary()`, while copying its prediction artifact back to `prediction.jsonl`. Merge last-attempt trace fields separately:

```ts
summary({
  prediction: best.prediction,
  evaluation: best.evaluation,
  bestAttempt: best.attempt,
  lastAttempt: attempt,
  lastAttemptPrediction: prediction,
  status: "fail"
});
```

The best evaluation remains authoritative; last-attempt diagnostics remain visible.

- [ ] **Step 8: Verify GREEN and existing repair tests**

Run:

```bash
TSX_DISABLE_CACHE=1 npx tsx --test --test-name-pattern "restores the best SWE-bench candidate|supervised repair|preserves separate child traces" src/apps/cli/src/host/swe-bench-run-capabilities.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 9: Record an implementation checkpoint**

Do not commit the large host file unless its staged diff excludes pre-existing user edits. The new candidate module may remain committed independently from Task 3.

### Task 5: Truthful Diagnostics Status And Correctness-First Attribution

**Files:**
- Modify: `src/apps/cli/test/cli.test.ts`
- Modify: `src/apps/cli/src/diagnostics/swe-bench-cli-diagnostics.ts`
- Modify: `src/apps/cli/src/host/swe-bench-run-capabilities.test.ts`
- Modify: `src/apps/cli/src/host/swe-bench-run-capabilities.ts`

**Interfaces:**
- Consumes: `run.value.evidence.metadata.status`, `evaluationResolved`, `bestAttempt`, and last-attempt flow fields.
- Produces: outer diagnostics `status` aligned with nested benchmark status and primary failure reasons that rank correctness/flow ahead of cache.

- [ ] **Step 1: Add a failing outer-status CLI regression**

Allow the fake SWE capability helper to return runner metadata:

```ts
await registerFakeCliSweBenchRunCapability(toolDeps, capturedInputs, {
  status: "fail",
  evaluationResolved: false,
  bestAttempt: 1,
  lastAttempt: 3
});
```

Assert:

```ts
assert.equal(parsed.status, "fail");
assert.equal(parsed.sweBench?.status, "fail");
assert.equal(parsed.sweBench?.run?.ok, true);
```

This proves transport success does not imply benchmark success.

- [ ] **Step 2: Confirm CLI RED**

Run:

```bash
TSX_DISABLE_CACHE=1 npx tsx --test --test-name-pattern "propagates failed SWE-bench evidence" src/apps/cli/test/cli.test.ts
```

Expected: FAIL because `collectSweBenchRunDiagnostics()` currently derives status only from adapter diagnostics.

- [ ] **Step 3: Implement authoritative nested status extraction**

Add a local helper:

```ts
function sweBenchRunOutcomeStatus(
  run: SerializableResult | undefined,
  diagnostics: readonly SweBenchPredictionDiagnostic[]
): "pass" | "warn" | "fail" {
  if (diagnostics.some((entry) => entry.severity === "error")) return "fail";
  const evidence = isJsonObject(run?.value?.evidence) ? run.value.evidence : undefined;
  const metadata = isJsonObject(evidence?.metadata) ? evidence.metadata : undefined;
  if (metadata?.status === "fail" || metadata?.evaluationResolved === false) return "fail";
  if (metadata?.status === "warn" || evidence?.status === "failed") return "warn";
  return run?.ok ? "pass" : "fail";
}
```

Use this helper for both `sweBench.status` and the returned diagnostics status.

- [ ] **Step 4: Add failing correctness-first attribution coverage**

Create a recovered or direct summary with:

```ts
evaluationResolved: false,
bestAttempt: 1,
lastAttempt: 3,
lastAttemptTerminalReason: "flow-mutation-recovery-exhausted",
diagnostics: [{ code: "SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET", severity: "error", ... }]
```

Assert:

```ts
assert.equal(metadata?.primaryReasonCode, "FLOW_MUTATION_RECOVERY_EXHAUSTED");
assert.equal((metadata?.reasonCodes as string[]).includes("CACHE_PROVIDER_BELOW_TARGET"), true);
assert.equal(metadata?.primaryFailureCategory, "flow-control");
```

- [ ] **Step 5: Confirm attribution RED**

Run:

```bash
TSX_DISABLE_CACHE=1 npx tsx --test --test-name-pattern "does not let cache readiness mask" src/apps/cli/src/host/swe-bench-run-capabilities.test.ts
```

Expected: FAIL because cache priority currently precedes official unresolved/model failure and final pre-harness summaries lose prior evaluation.

- [ ] **Step 6: Implement correctness-first reason ordering**

Map `flow-mutation-recovery-exhausted` to `FLOW_MUTATION_RECOVERY_EXHAUSTED`. Adjust priorities so flow, packaging, official unresolved, and model-patch-insufficient reasons precede cache readiness. Preserve cache codes in `reasonCodes` and `reviewCodes`. Compute `modelAttributionAllowed` from complete runner evidence plus a valid best official unresolved result, while flow-control and restoration failures remain framework-owned.

- [ ] **Step 7: Verify GREEN**

Run both focused commands from Steps 2 and 5. Expected: all selected tests PASS.

- [ ] **Step 8: Record an implementation checkpoint**

Review staged and unstaged diffs. Do not commit pre-existing worktree changes.

### Task 6: OpenSpec Evidence, Repository Verification, And Live Canary

**Files:**
- Modify: `openspec/changes/2026-07-13-stabilize-swebench-repair-outcomes/tasks.md`
- Create through runtime execution: `.deepseek/swe-lite-runs/<new-run-id>/...` ignored acceptance artifacts.

**Interfaces:**
- Consumes: all deterministic implementation tasks.
- Produces: validated OpenSpec state, repository verification evidence, and one observed GLM 5.2 task-2 result.

- [ ] **Step 1: Run complete focused suites**

Run:

```bash
TSX_DISABLE_CACHE=1 npx tsx --test src/packages/runtime/test/runtime-tool-feedback.test.ts
TSX_DISABLE_CACHE=1 npx tsx --test src/apps/cli/src/host/swe-bench-attempt-candidates.test.ts
TSX_DISABLE_CACHE=1 npx tsx --test src/apps/cli/src/host/swe-bench-run-capabilities.test.ts
TSX_DISABLE_CACHE=1 npx tsx --test --test-name-pattern "SWE-bench" src/apps/cli/test/cli.test.ts
```

Expected: all commands exit 0 with no failed tests.

- [ ] **Step 2: Run repository gates**

Run:

```bash
npm run typecheck
npm run lint
npm test
node scripts/check-boundaries.mjs
```

Expected: every command exits 0. If an unrelated pre-existing failure appears, capture the exact command and failure without weakening focused acceptance.

- [ ] **Step 3: Validate OpenSpec**

Run:

```bash
npx openspec validate 2026-07-13-stabilize-swebench-repair-outcomes --strict
npx openspec validate --specs --strict
```

Expected: the change is valid and canonical specs report zero failures.

- [ ] **Step 4: Update bilingual OpenSpec task evidence**

Mark only completed tasks as `[x]`. Record focused command names, repository gate outcomes, and any pre-existing unrelated failure in both English and Chinese. Do not mark the live model pass as deterministic acceptance.

- [ ] **Step 5: Run one new GLM 5.2 task-2 canary**

Use a unique run id and the same governed command shape:

```bash
npx tsx src/apps/cli/src/index.ts diagnostics swe-bench run \
  --task 2 \
  --execute \
  --live \
  --provider glm \
  --model glm-5.2 \
  --run-id swe-lite-task-2-glm52-transactional-<timestamp> \
  --tool-projection safe-all \
  --trusted \
  --timeout-ms 600000 \
  --output json
```

Expected framework behavior: no stale-edit deadlock, immutable candidate artifacts exist, `bestAttempt` cannot be replaced by a worse or non-harness-ready attempt, and outer CLI status matches the authoritative nested result. Record whether the model resolved the instance and the observed attempt count.

- [ ] **Step 6: Perform final verification-before-completion**

Re-read the final summary and candidate metadata with a structured Node command. Confirm no SWE process or Docker harness container remains running. Run `git diff --check`. Report changed files, deterministic verification, live canary outcome, and remaining model variability.

- [ ] **Step 7: Final commit decision**

Commit only repair-owned changes whose staged diff has been reviewed. Because the worktree began with modifications in the same implementation files, leave mixed ownership changes uncommitted unless the user explicitly approves including the complete file diffs.
