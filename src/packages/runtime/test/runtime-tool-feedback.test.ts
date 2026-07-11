import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  CapabilityManifest,
  CapabilityExecutionContext,
  AgentLoopOutputContract,
  AgentLoopProfilePolicyMetadata,
  JsonObject,
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
  PolicyDecision,
  PolicyEngine,
  PolicyRequest,
  ProcessResult,
  ProcessRunObserver,
  ProcessRunOptions,
  RuntimeEvent,
  ToolResultFeedback
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import {
  collectRuntimeEvents,
  createDefaultRuntimeKernel,
  registerRuntimeCoreTools,
  runtimeEchoCapability,
  runAgentLoop
} from "../src/index.js";
import { advanceWorkflowStageFromToolEvidence, projectProviderCacheToolSet, projectToolSet, projectWorkflowGateOverrideTools, workflowCapabilityBoundaryGuard } from "../src/agent-loop-tools.js";
import { readyStageBudgetForControl } from "../src/ready-stage-budget.js";
import {
  buildDeniedDispatchFeedback,
  buildDeniedDispatchResult,
  buildRejectedDispatchFeedback,
  buildRejectedDispatchResult,
  buildDispatchTerminalSummary,
  shouldQuarantineStaleToolResult,
  outputContractArtifactPathRejection,
  toolTimeoutFor
} from "../src/agent-loop-tool-dispatch.js";
import {
  failureAnalysisConvergence,
  readyStageToolBudgetConvergence,
  repeatedRejectedIntentConvergence,
  readyStageRequiredActionConvergence,
  terminalToolConvergence
} from "../src/agent-loop-convergence.js";
import { READY_STAGE_REQUIRED_ACTION_CORRECTION_LIMIT } from "../src/ready-stage-control.js";
import { planToolDispatchBatch } from "../src/agent-loop-tool-batches.js";
import {
  createToolDecisionBoardState,
  recordFailureAnalysis,
  recordSharedBoardLineage,
  toolDecisionBoardSnapshot
} from "../src/tool-decision-board.js";
import { boundedModelText, modelToolResultText, toolFeedbackPreview } from "../src/model-tooling.js";
import { progressCapabilityIdsForWorkflowStage } from "../src/workflow-capability-policy.js";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";
import { defaultDeepSeekProfile, defaultGlmAnthropicProfile } from "@deepseek/model-gateway";
import { FakePlatformRuntime } from "@deepseek/platform-abstraction";
import { coreToolManifests } from "@deepseek/core-coding-tools";

describe("agent loop typed tool feedback", () => {
  it("plans a single dispatch item for one model tool call", () => {
    const batch = planToolDispatchBatch({
      modelToolCalls: [{
        toolCallId: "call-1",
        providerToolName: "core.file.read",
        resolvedCapabilityId: "core.file.read",
        normalizedInputHash: "hash-1",
        input: { path: "README.md" },
        sideEffect: "read",
        iteration: 3
      }],
      visibleCapabilityIds: ["core.file.read"],
      activeStageControl: {
        stageKind: "verify",
        progressCapabilityIds: ["core.file.read"]
      }
    });

    assert.equal(batch.items.length, 1);
    assert.equal(batch.items[0]?.toolCallId, "call-1");
    assert.equal(batch.items[0]?.resolvedCapabilityId, "core.file.read");
    assert.equal(batch.items[0]?.executionMode, "serial");
    assert.equal(batch.items[0]?.iteration, 3);
  });

  it("partitions read-only dispatch runs into concurrent groups while keeping side-effecting tools serial", () => {
    const batch = planToolDispatchBatch({
      modelToolCalls: [
        toolDispatchItem("call-read-1", "core.file.read", "read", 1),
        toolDispatchItem("call-read-2", "runtime.inspect", "none", 1),
        toolDispatchItem("call-write", "core.file.write", "write", 1),
        toolDispatchItem("call-read-3", "core.file.read", "read", 1),
        toolDispatchItem("call-process", "core.test.run", "process", 1),
        toolDispatchItem("call-network", "core.web.fetch", "network", 1)
      ],
      visibleCapabilityIds: ["core.file.read", "runtime.inspect", "core.file.write", "core.test.run", "core.web.fetch"]
    });

    assert.deepEqual(batch.groups.map((group) => ({
      executionMode: group.executionMode,
      toolCallIds: group.items.map((item) => item.toolCallId)
    })), [
      { executionMode: "concurrent", toolCallIds: ["call-read-1", "call-read-2"] },
      { executionMode: "serial", toolCallIds: ["call-write"] },
      { executionMode: "concurrent", toolCallIds: ["call-read-3"] },
      { executionMode: "serial", toolCallIds: ["call-process"] },
      { executionMode: "serial", toolCallIds: ["call-network"] }
    ]);
  });

  it("keeps generic tool dispatch policy helpers deterministic", () => {
    const outputContract: AgentLoopOutputContract = {
      schemaVersion: "1.0.0",
      kind: "file" as const,
      path: "result.md",
      required: true,
      redaction: { class: "internal" as const }
    };

    assert.equal(toolTimeoutFor({ timeoutMs: 8_000 }, 30_000, 20_000, 10_000), 8_000);
    assert.equal(toolTimeoutFor({ timeoutMs: 80_000 }, 30_000, 20_000, 10_000), 10_000);
    assert.equal(toolTimeoutFor({}, 30_000, 20_000), 20_000);
    assert.equal(toolTimeoutFor({}, 30_000, 7_200_000, 600_000), 7_200_000);

    assert.equal(outputContractArtifactPathRejection({
      toolName: "core.file.read",
      toolInput: { path: "other.md" },
      outputContract
    }), undefined);
    assert.equal(outputContractArtifactPathRejection({
      toolName: "core.file.write",
      toolInput: { path: "./result.md" },
      outputContract
    }), undefined);

    const rejected = outputContractArtifactPathRejection({
      toolName: "core.file.write",
      toolInput: { path: "other.md" },
      outputContract
    });
    assert.equal(rejected?.terminalKind, "output-contract.path.rejected");
    assert.equal(rejected?.error.code, "KERNEL_POLICY_DENIED");
    assert.equal(rejected?.error.message.includes("result.md"), true);
  });

  it("builds bounded rejected dispatch feedback with correction guidance", () => {
    const feedback = buildRejectedDispatchFeedback({
      toolCallId: "call-rejected",
      toolName: "core.file.read",
      text: "Repeated rejected intent.",
      diagnostics: [{
        code: "KERNEL_POLICY_DENIED",
        message: "Rejected.",
        retryable: false,
        redaction: { class: "internal" }
      }],
      correctiveAction: "Use corrected input.",
      recommendedNextAction: "corrected input",
      trace: {
        traceId: asId<"trace">("trace-dispatch"),
        spanId: asId<"span">("span-dispatch"),
        correlationId: asId<"correlation">("correlation-dispatch")
      },
      limitBytes: 64,
      continuation: "continue"
    });

    assert.equal(feedback.status, "rejected");
    assert.equal(feedback.toolCallId, "call-rejected");
    assert.equal(feedback.toolName, "core.file.read");
    assert.equal(feedback.correctiveAction, "Use corrected input.");
    assert.equal(feedback.recommendedNextAction, "corrected input");
    assert.equal(feedback.continuation, "continue");
    assert.equal(Buffer.byteLength(feedback.preview.text, "utf8") <= 64, true);
  });

  it("renders structured tool error diagnostics into model-visible feedback", () => {
    const text = modelToolResultText({
      kind: "capability.failed",
      sessionId: asId<"session">("session-test"),
      createdAt: "1970-01-01T00:00:00.000Z",
      trace: {
        traceId: asId<"trace">("trace-test"),
        spanId: asId<"span">("span-test"),
        correlationId: asId<"correlation">("correlation-test")
      },
      data: {
        capabilityId: "core.file.edit"
      },
      error: {
        code: "KERNEL_EXECUTOR_FAILED",
        message: "Expected text must appear exactly once; found 0.",
        retryable: false,
        suggestedActions: [
          "Read the target file window, copy exact current text, then retry."
        ],
        redaction: { class: "public" },
        details: {
          originalCode: "EDIT_PRECONDITION_FAILED",
          operation: "exact-match",
          occurrences: 0
        }
      }
    } as unknown as RuntimeEvent);

    assert.match(text, /KERNEL_EXECUTOR_FAILED/);
    assert.match(text, /EDIT_PRECONDITION_FAILED/);
    assert.match(text, /Read the target file window/);
    assert.match(text, /occurrences/);
  });

  it("preserves an optional capability id in rejected dispatch feedback", () => {
    const feedback = buildRejectedDispatchFeedback({
      toolCallId: "call-capability",
      toolName: "core.file.edit",
      capabilityId: "core.file.edit",
      text: "Rejected with capability id.",
      diagnostics: [],
      trace: {
        traceId: asId<"trace">("trace-capability"),
        spanId: asId<"span">("span-capability"),
        correlationId: asId<"correlation">("correlation-capability")
      },
      limitBytes: 64
    });

    assert.equal(feedback.capabilityId, "core.file.edit");
  });

  it("does not complete collect-evidence stages from broad root directory listings", () => {
    const advanced = advanceWorkflowStageFromToolEvidence({
      profilePolicy: supervisorRootListThenChangePolicy(),
      capabilityId: "core.file.list",
      toolCallId: "call-root-list",
      toolInput: { path: "." },
      terminal: completedCapabilityEvent(),
      at: "2026-07-06T00:00:00.000Z"
    });

    assert.equal(advanced, undefined);
  });

  it("does not complete collect-evidence stages from truncated source reads", () => {
    const advanced = advanceWorkflowStageFromToolEvidence({
      profilePolicy: supervisorRootListThenChangePolicy(),
      capabilityId: "core.file.read",
      toolCallId: "call-source-read",
      toolInput: { path: "src/modeling/separable.py" },
      terminal: completedCapabilityEvent({ truncatedLines: false }, { text: "class Model(...)\n...", truncated: true }),
      at: "2026-07-06T00:00:00.000Z"
    });

    assert.equal(advanced, undefined);
  });

  it("completes collect-evidence stages from untruncated focused source reads", () => {
    const advanced = advanceWorkflowStageFromToolEvidence({
      profilePolicy: supervisorRootListThenChangePolicy(),
      capabilityId: "core.file.read",
      toolCallId: "call-source-read",
      toolInput: { path: "src/modeling/separable.py" },
      terminal: completedCapabilityEvent({ truncatedLines: false }, { text: "def _cstack(...):\n  pass\n", truncated: false }),
      at: "2026-07-06T00:00:00.000Z"
    });

    assert.equal(advanced?.stage.stageId, "stage:understand");
    assert.equal(advanced?.stageEvents.at(-1)?.kind, "stage.evaluation.required");
  });

  it("completes collect-evidence stages from bounded focused source reads", () => {
    const advanced = advanceWorkflowStageFromToolEvidence({
      profilePolicy: supervisorRootListThenChangePolicy(),
      capabilityId: "core.file.read",
      toolCallId: "call-source-read",
      toolInput: { path: "src/modeling/separable.py", offset: 120, limit: 80 },
      terminal: completedCapabilityEvent(),
      at: "2026-07-06T00:00:00.000Z"
    });

    assert.equal(advanced?.stage.stageId, "stage:understand");
    assert.equal(advanced?.stageEvents.at(-1)?.kind, "stage.evaluation.required");
  });

  it("completes collect-evidence stages from bounded focused source windows when the file has more lines outside the window", () => {
    const advanced = advanceWorkflowStageFromToolEvidence({
      profilePolicy: supervisorRootListThenChangePolicy(),
      capabilityId: "core.file.read",
      toolCallId: "call-source-read-window",
      toolInput: { path: "src/modeling/separable.py", offset: 150, limit: 150 },
      terminal: completedCapabilityEvent(
        { truncatedLines: true },
        { text: "def _cdot(left, right):\n  return left, right\n", byteLength: 4338, lineCount: 150, truncated: false }
      ),
      at: "2026-07-06T00:00:00.000Z"
    });

    assert.equal(advanced?.stage.stageId, "stage:understand");
    assert.equal(advanced?.stageEvents.at(-1)?.kind, "stage.evaluation.required");
  });

  it("completes collect-evidence stages from bounded focused source windows when the returned window reaches the requested limit", () => {
    const advanced = advanceWorkflowStageFromToolEvidence({
      profilePolicy: supervisorRootListThenChangePolicy(),
      capabilityId: "core.file.read",
      toolCallId: "call-source-read-window",
      toolInput: { path: "src/modeling/separable.py", offset: 1, limit: 300 },
      terminal: completedCapabilityEvent(
        { truncatedLines: true },
        { text: "def _coord_matrix(...):\n  pass\n", byteLength: 9028, lineCount: 300, truncated: true }
      ),
      at: "2026-07-06T00:00:00.000Z"
    });

    assert.equal(advanced?.stage.stageId, "stage:understand");
    assert.equal(advanced?.stageEvents.at(-1)?.kind, "stage.evaluation.required");
  });

  it("does not complete evaluation collect-evidence from truncated header source windows", () => {
    const advanced = advanceWorkflowStageFromToolEvidence({
      profilePolicy: evaluationHeaderSensitiveReadThenChangePolicy(),
      capabilityId: "core.file.read",
      toolCallId: "call-source-header-window",
      toolInput: { path: "astropy/modeling/separable.py", offset: 1, limit: 300 },
      terminal: completedCapabilityEvent(
        { startLine: 1, endLine: 301, totalLines: 318, nextOffset: 301, truncatedLines: true },
        { text: "module docstring and imports only\n", byteLength: 9028, lineCount: 300, truncated: true }
      ),
      at: "2026-07-06T00:00:00.000Z"
    });

    assert.equal(advanced, undefined);
  });

  it("does not complete collect-evidence stages from bounded reads whose evidence is still truncated", () => {
    const advanced = advanceWorkflowStageFromToolEvidence({
      profilePolicy: supervisorRootListThenChangePolicy(),
      capabilityId: "core.file.read",
      toolCallId: "call-source-read",
      toolInput: { path: "src/modeling/separable.py", offset: 1, limit: 300 },
      terminal: completedCapabilityEvent({ truncatedLines: true }, { text: "header only\n...", truncated: true }),
      at: "2026-07-06T00:00:00.000Z"
    });

    assert.equal(advanced, undefined);
  });

  it("does not complete collect-evidence stages from unfocused search or glob probes", () => {
    const broadSearch = advanceWorkflowStageFromToolEvidence({
      profilePolicy: supervisorDiscoveryThenChangePolicy(),
      capabilityId: "core.search.text",
      toolCallId: "call-broad-search",
      toolInput: { query: "x", path: "." },
      terminal: completedCapabilityEvent(),
      at: "2026-07-06T00:00:00.000Z"
    });
    const broadGlob = advanceWorkflowStageFromToolEvidence({
      profilePolicy: supervisorDiscoveryThenChangePolicy(),
      capabilityId: "core.workspace.glob",
      toolCallId: "call-broad-glob",
      toolInput: { pattern: "**/*" },
      terminal: completedCapabilityEvent(),
      at: "2026-07-06T00:00:01.000Z"
    });

    assert.equal(broadSearch, undefined);
    assert.equal(broadGlob, undefined);
  });

  it("completes collect-evidence stages from focused search but not path-only glob probes", () => {
    const focusedSearch = advanceWorkflowStageFromToolEvidence({
      profilePolicy: supervisorDiscoveryThenChangePolicy(),
      capabilityId: "core.search.text",
      toolCallId: "call-focused-search",
      toolInput: { query: "def _separable", path: "astropy/modeling" },
      terminal: completedCapabilityEvent(),
      at: "2026-07-06T00:00:00.000Z"
    });
    const focusedGlob = advanceWorkflowStageFromToolEvidence({
      profilePolicy: supervisorDiscoveryThenChangePolicy(),
      capabilityId: "core.workspace.glob",
      toolCallId: "call-focused-glob",
      toolInput: { pattern: "astropy/modeling/**/*.py" },
      terminal: completedCapabilityEvent(),
      at: "2026-07-06T00:00:01.000Z"
    });

    assert.equal(focusedSearch?.stage.stageId, "stage:understand");
    assert.equal(focusedGlob, undefined);
  });

  it("does not complete collect-evidence stages from focused searches with empty results", () => {
    const emptyFocusedSearch = advanceWorkflowStageFromToolEvidence({
      profilePolicy: supervisorDiscoveryThenChangePolicy(),
      capabilityId: "core.search.text",
      toolCallId: "call-empty-focused-search",
      toolInput: { pattern: "_cascade", glob: "astropy/modeling/separable.py", outputMode: "content", contextLines: 5 },
      terminal: completedCapabilityEvent({}, { text: "", lineCount: 0, truncated: false }),
      at: "2026-07-06T00:00:00.000Z"
    });

    assert.equal(emptyFocusedSearch, undefined);
  });

  it("builds rejected dispatch result DTOs for event and decision-board callers", () => {
    const result = buildRejectedDispatchResult({
      toolCallId: "call-preflight",
      toolName: "core.file.read",
      capabilityId: "core.file.read",
      normalizedInputHash: "hash-preflight",
      terminalKind: "preflight.rejected",
      text: "Tool request rejected.",
      diagnostics: [{
        code: "KERNEL_POLICY_DENIED",
        message: "Unsafe path.",
        retryable: false,
        redaction: { class: "internal" }
      }],
      correctiveAction: "Correct the tool input or choose a different projected tool.",
      recommendedNextAction: "corrected input or different projected tool",
      trace: {
        traceId: asId<"trace">("trace-rejected-result"),
        spanId: asId<"span">("span-rejected-result"),
        correlationId: asId<"correlation">("correlation-rejected-result")
      },
      limitBytes: 256,
      continuation: "continue",
      iteration: 2
    });

    assert.equal(result.feedback.status, "rejected");
    assert.equal(result.eventData.toolCallId, "call-preflight");
    assert.equal(result.eventData.terminalKind, "preflight.rejected");
    assert.equal(result.eventData.result, result.feedback.preview.text);
    assert.equal(result.decisionRecord.terminalKind, "preflight.rejected");
    assert.equal(result.decisionRecord.normalizedInputHash, "hash-preflight");
    assert.equal(result.evidenceInput.capabilityId, "core.file.read");
  });

  it("builds bounded denied dispatch feedback with permission guidance", () => {
    const feedback = buildDeniedDispatchFeedback({
      toolCallId: "call-denied",
      toolName: "core.file.read",
      text: "Denied by hook.",
      diagnostics: [],
      correctiveAction: "Request permission.",
      recommendedNextAction: "permission change",
      trace: {
        traceId: asId<"trace">("trace-denied"),
        spanId: asId<"span">("span-denied"),
        correlationId: asId<"correlation">("correlation-denied")
      },
      limitBytes: 64
    });

    assert.equal(feedback.status, "denied");
    assert.equal(feedback.correctiveAction, "Request permission.");
    assert.equal(feedback.recommendedNextAction, "permission change");
  });

  it("builds denied dispatch result DTOs for event and decision-board callers", () => {
    const result = buildDeniedDispatchResult({
      toolCallId: "call-hook",
      toolName: "core.file.read",
      capabilityId: "core.file.read",
      normalizedInputHash: "hash-hook",
      terminalKind: "hook.blocked",
      text: "tool-execution.before hook blocked core.file.read",
      diagnostics: [{
        code: "HOOK_TOOL_BLOCKED",
        message: "Blocked by hook.",
        retryable: false,
        redaction: { class: "internal" }
      }],
      correctiveAction: "Address hook policy or choose a different projected tool.",
      recommendedNextAction: "hook policy change or bounded blocker",
      trace: {
        traceId: asId<"trace">("trace-denied-result"),
        spanId: asId<"span">("span-denied-result"),
        correlationId: asId<"correlation">("correlation-denied-result")
      },
      limitBytes: 256,
      continuation: "continue",
      iteration: 3,
      metadata: { hook: "tool-execution.before" }
    });

    assert.equal(result.feedback.status, "denied");
    assert.equal(result.eventData.terminalKind, "hook.blocked");
    assert.equal(result.eventData.result, result.feedback.preview.text);
    assert.equal(result.decisionRecord.terminalKind, "hook.blocked");
    assert.equal(result.decisionRecord.metadata?.hook, "tool-execution.before");
    assert.equal(result.evidenceInput.feedback.status, "denied");
  });

  it("summarizes terminal dispatch state and quarantines stale tool results", () => {
    const summary = buildDispatchTerminalSummary({
      batchId: "batch-1",
      toolCallId: "call-stale",
      toolName: "core.file.read",
      capabilityId: "core.file.read",
      terminalStatus: "abandoned",
      inProgressToolCallIds: ["call-stale"],
      elapsedMs: 125,
      evidenceIds: ["tool-result:call-stale"],
      diagnostics: [{
        code: "KERNEL_CANCELLED",
        message: "Cancelled.",
        retryable: false,
        redaction: { class: "internal" }
      }],
      convergence: {
        kind: "terminal",
        reasonCode: "dispatch.abandoned"
      }
    });

    assert.equal(summary.terminalStatus, "abandoned");
    assert.equal(summary.inProgressToolCallIds[0], "call-stale");
    assert.equal(summary.evidenceIds[0], "tool-result:call-stale");
    assert.equal(summary.convergence.reasonCode, "dispatch.abandoned");
    assert.equal(shouldQuarantineStaleToolResult({
      toolCallId: "call-stale",
      summary
    }), true);
    assert.equal(shouldQuarantineStaleToolResult({
      toolCallId: "call-fresh",
      summary
    }), false);
  });

  it("maps repeated rejected intent to a retry-with-feedback convergence decision", () => {
    const decision = repeatedRejectedIntentConvergence({ threshold: 3, count: 3 });
    assert.equal(decision.kind, "retry-with-feedback");
    assert.equal(decision.reasonCode, "decision-loop.rejected");
    assert.equal(decision.terminalKind, "decision-loop.rejected");
    assert.equal(decision.recommendedNextAction, "different projected tool or corrected input or bounded blocker");
  });

  it("maps failure analysis proof state into explicit convergence transitions", () => {
    const analyze = failureAnalysisConvergence({
      attemptId: "attempt:1",
      terminalKind: "agent.loop.budget.consumed",
      proofStatus: "unproven",
      nextAllowedAction: "rerun",
      attribution: "model-owned"
    });
    assert.equal(analyze.kind, "analyze-failure");
    assert.equal(analyze.reasonCode, "failure-analysis.required");
    assert.equal(analyze.recommendedNextAction, "search-evidence");

    const prove = failureAnalysisConvergence({
      attemptId: "attempt:1",
      terminalKind: "agent.loop.budget.consumed",
      proofStatus: "unproven",
      nextAllowedAction: "prove-attribution",
      attribution: "framework-scheduling"
    });
    assert.equal(prove.kind, "prove-attribution");
    assert.equal(prove.recommendedNextAction, "prove-attribution");

    const repair = failureAnalysisConvergence({
      attemptId: "attempt:1",
      terminalKind: "agent.loop.budget.consumed",
      proofStatus: "proven",
      nextAllowedAction: "repair",
      attribution: "framework-scheduling"
    });
    assert.equal(repair.kind, "repair-required");
    assert.equal(repair.reasonCode, "failure-analysis.repair-required");

    const rerun = failureAnalysisConvergence({
      attemptId: "attempt:1",
      terminalKind: "agent.loop.failed",
      proofStatus: "proven",
      nextAllowedAction: "rerun",
      attribution: "environment"
    });
    assert.equal(rerun.kind, "rerun-allowed");
    assert.equal(rerun.reasonCode, "failure-analysis.rerun-allowed");

    const stop = failureAnalysisConvergence({
      attemptId: "attempt:1",
      terminalKind: "agent.loop.failed",
      proofStatus: "proven",
      nextAllowedAction: "stop-with-classification",
      attribution: "tool-availability"
    });
    assert.equal(stop.kind, "stop-with-classification");
    assert.equal(stop.reasonCode, "failure-analysis.stop-with-classification");
  });

  it("maps ready-stage budget exhaustion to a review-required convergence decision", () => {
    const decision = readyStageToolBudgetConvergence({
      workflowReadyStageControl: { stageId: "stage:verify" },
      budget: { maxToolCalls: 1, consumed: 1 }
    });
    assert.equal(decision.kind, "review-required");
    assert.equal(decision.reasonCode, "workflow-stage-budget.review-required");
    assert.equal(decision.terminalKind, "workflow-stage-budget.review-required");
  });

  it("stops a supervisor ready stage after model budget review is already injected", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage budget\n");
    const gateway = new RepeatingReadToolCallGateway();
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "inspect until the stage budget stops you",
      caller: "runtime.stage-budget.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorReadThenChangePolicy(),
      limits: {
        maxModelIterations: 5,
        maxToolCalls: 10,
        stageBudgets: [{
          stageId: "stage:understand",
          maxModelIterations: 1,
          stopReason: "test-understand-stage-budget"
        }]
      }
    }));

    assert.equal(events.filter((event) => event.kind === "model.requested").length, 2);
    assert.equal(events.filter((event) => event.kind === "agent.loop.budget.consumed").some((event) => event.data.stopReason === "test-understand-stage-budget"), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.failed");
    assert.equal(events.at(-1)?.data.reason, "test-understand-stage-budget");
    await kernel.shutdown();
  });

  it("flags repeated supervisor evidence inspection as non-progress while hiding supporting reads", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new SuccessfulTestFakePlatformRuntime() });
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new RepeatingReadToolCallGateway();
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "inspect the same evidence forever",
      caller: "runtime.stage-novelty.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorReadThenChangePolicy(),
      limits: {
        maxModelIterations: 5,
        maxToolCalls: 10,
        stageBudgets: [{
          stageId: "stage:understand",
          maxModelIterations: 4,
          stopReason: "test-understand-stage-budget"
        }]
      }
    }));

    const readResults = events.filter((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.read" &&
      event.data.terminalKind === "capability.completed"
    );
    const nonProgressMisses = events.filter((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.stageId === "stage:change" &&
      event.data.requestedCapabilityId === "core.file.read"
    );
    assert.equal(readResults.length, 1, "supporting reads execute only in the evidence stage before progress-only tightening");
    assert.ok(nonProgressMisses.length >= 1, "supporting reads must still be classified as non-progress");
    assert.equal(events.some((event) => event.kind === "agent.loop.failed" && event.data.reason === "test-understand-stage-budget"), false);
    await kernel.shutdown();
  });

  it("keeps repeated evidence corrections recoverable when the model switches to mutation", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-read-1", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-read-2", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-read-3", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "inspect then change",
      caller: "runtime.stage-repeat-recovery.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorReadThenChangePolicy(),
      limits: { maxModelIterations: 5, maxToolCalls: 8 }
    }));

    const boundaryRejections = events.filter((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.read" &&
      event.data.terminalKind === "workflow-capability-boundary.rejected"
    );
    assert.equal(boundaryRejections.length, 2);
    assert.equal(events.filter((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.stageId === "stage:change" &&
      event.data.requestedCapabilityId === "core.file.read"
    ).length, 2);
    const providerToolsAfterCorrection = providerToolNames(gateway.requests[3]);
    assert.equal(providerToolsAfterCorrection.includes("core_file_read"), true);
    assert.equal(providerToolsAfterCorrection.includes("core_file_edit"), true);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      ((event.data.feedback as JsonObject | undefined)?.capabilityId === "core.file.edit" ||
        (event.data.dispatchSummary as JsonObject | undefined)?.capabilityId === "core.file.edit") &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    assert.equal(events.some((event) => event.kind === "agent.loop.failed" && event.data.reason === "workflow-required-action-missed"), false);
    await kernel.shutdown();
  });

  it("clears stale evidence correction overrides when refreshed evidence advances to mutation", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\nmore context\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-read-truncated", name: "core.file.read", input: { path: "README.md", limitBytes: 1 } },
      { id: "call-read-focused", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 3 } },
      { id: "call-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "refresh truncated evidence then change",
      caller: "runtime.stage-stale-override-clear.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorReadThenChangePolicy(),
      limits: { maxModelIterations: 4, maxToolCalls: 6 }
    }));

    const thirdSnapshot = events
      .filter((event) => event.kind === "tool.decision-board.snapshot")
      .find((event) => event.data.iteration === 3);
    const visibleToolIds = thirdSnapshot?.data.visibleToolIds as readonly string[] | undefined;
    const thirdRequest = events
      .filter((event) => event.kind === "model.requested")
      .find((event) => event.data.iteration === 3);
    const override = (thirdRequest?.data.profilePolicy as JsonObject | undefined)?.workflowGateOverride as JsonObject | undefined;

    assert.equal(visibleToolIds?.includes("core.file.edit"), true);
    assert.equal(override?.requiredNextAction, undefined);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\nmore context\n");
    await kernel.shutdown();
  });

  it("surfaces nearest file edit context in model-visible failed tool feedback", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/app.ts", "function alpha() {\n  return 1;\n}\n\nfunction beta() {\n  return 2;\n}\n");
    const gateway = new SequentialToolCallModelGateway([
      {
        id: "call-edit-stale",
        name: "core.file.edit",
        input: {
          path: "app.ts",
          expected: "function beta() {\n  return missing;\n}",
          replacement: "function beta() {\n  return 3;\n}"
        }
      }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "edit with stale context",
      caller: "runtime.file-edit-nearest-context.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      limits: { maxModelIterations: 1, maxToolCalls: 2 }
    }));

    const result = events.find((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.edit"
    );
    assert.match(String(result?.data.result ?? ""), /nearestContext/);
    assert.match(String(result?.data.result ?? ""), /function beta/);
    assert.match(String(result?.data.result ?? ""), /return 2/);
    await kernel.shutdown();
  });

  it("tightens mutation stages to progress tools after one supporting read miss", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-read-1", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-read-2", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-read-3", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "inspect then change without repeating supporting reads",
      caller: "runtime.stage-support-read-tightening.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorReadThenChangePolicy(),
      limits: { maxModelIterations: 5, maxToolCalls: 8 }
    }));

    const changeMisses = events.filter((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.stageId === "stage:change" &&
      event.data.requestedCapabilityId === "core.file.read"
    );
    const providerToolsAfterMiss = providerToolNames(gateway.requests[2]);

    assert.equal(changeMisses.length, 2);
    assert.equal(providerToolsAfterMiss.includes("core_file_read"), true);
    assert.equal(providerToolsAfterMiss.includes("core_file_edit"), true);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.edit" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    await kernel.shutdown();
  });

  it("keeps workflow boundary correction feedback after the rejected tool result in provider history", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-read-1", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-read-2", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "inspect then change",
      caller: "runtime.boundary-correction-history.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorReadThenChangePolicy(),
      limits: { maxModelIterations: 4, maxToolCalls: 8 }
    }));

    assert.ok(gateway.requests.length >= 3, "boundary correction should trigger a third model request");
    assertProviderToolCallsArePaired(gateway.requests[2]?.messages ?? []);
    await kernel.shutdown();
  });

  it("fails closed after repeated workflow boundary misses in the same ready stage", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-read-1", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-read-2", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-read-3", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-read-4", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-read-5", name: "core.file.read", input: { path: "README.md" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "keep missing the active workflow action",
      caller: "runtime.stage-boundary-miss.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorReadThenChangePolicy(),
      limits: { maxModelIterations: 12, maxToolCalls: 20 }
    }));

    const missed = events.filter((event) => event.kind === "workflow.required-action.missed");
    const failed = events.find((event) => event.kind === "agent.loop.failed");

    assert.equal(missed.length, READY_STAGE_REQUIRED_ACTION_CORRECTION_LIMIT + 1);
    assert.equal(failed?.data.reason, "workflow-required-action-missed");
    assert.equal(events.filter((event) => event.kind === "model.requested").length < 12, true);
    await kernel.shutdown();
  });

  it("projects downstream mutation progress and supporting reads after supervisor evidence needs review", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new RecordingSingleToolCallModelGateway("core.file.read", { path: "README.md" });
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "inspect then change",
      caller: "runtime.stage-transition.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorReadThenChangePolicy(),
      limits: { maxModelIterations: 2, maxToolCalls: 4 }
    }));

    const secondRequest = events.filter((event) => event.kind === "model.requested").at(1);
    const secondBoard = events.filter((event) => event.kind === "tool.decision-board.snapshot").at(1);
    const control = secondRequest?.data.workflowReadyStageControl as JsonObject | undefined;

    assert.equal(control?.stageId, "stage:change");
    assert.equal(control?.stageKind, "produce");
    assert.equal(control?.requiredNextAction, "core.file.edit");
    assert.deepEqual(control?.progressCapabilityIds, ["core.file.edit"]);
    assert.equal((secondBoard?.data.visibleToolIds as string[] | undefined)?.includes("core.file.edit"), true);
    assert.equal((secondBoard?.data.visibleToolIds as string[] | undefined)?.includes("core.file.read"), true);
    await kernel.shutdown();
  });

  it("keeps supervisor downstream mutation stages open for follow-up edits", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-read", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-edit-1", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "broken evidence" } },
      { id: "call-edit-2", name: "core.file.edit", input: { path: "README.md", expected: "broken evidence", replacement: "fixed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "inspect then change twice",
      caller: "runtime.stage-transition.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorReadThenChangePolicy(),
      limits: { maxModelIterations: 4, maxToolCalls: 8 }
    }));

    const editResults = events.filter((event) =>
      event.kind === "model.tool.result" &&
      ((event.data.feedback as JsonObject | undefined)?.capabilityId === "core.file.edit" ||
        (event.data.dispatchSummary as JsonObject | undefined)?.capabilityId === "core.file.edit") &&
      event.data.terminalKind === "capability.completed"
    );
    const thirdBoard = events.filter((event) => event.kind === "tool.decision-board.snapshot").at(2);

    assert.equal(editResults.length, 2);
    assert.equal((thirdBoard?.data.visibleToolIds as string[] | undefined)?.includes("core.file.edit"), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "fixed evidence\n");
    await kernel.shutdown();
  });

  it("keeps mutation repair converged on source edits after a failed edit", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-read", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-edit-failed", name: "core.file.edit", input: { path: "README.md", expected: "missing evidence", replacement: "fixed evidence" } },
      { id: "call-read-after-failure", name: "core.file.read", input: { path: "README.md" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "inspect then repair failed edit",
      caller: "runtime.mutation-repair-convergence.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorReadThenChangePolicy(),
      limits: { maxModelIterations: 4, maxToolCalls: 8 }
    }));

    const postFailureRequest = events
      .filter((event) => event.kind === "model.requested")
      .find((event) => {
        const override = (event.data.profilePolicy as JsonObject | undefined)?.workflowGateOverride as JsonObject | undefined;
        return override?.terminalKind === "workflow-mutation-repair.required";
      });
    const override = (postFailureRequest?.data.profilePolicy as JsonObject | undefined)?.workflowGateOverride as JsonObject | undefined;

    assert.equal(override?.requiredNextAction, "core.file.edit");
    await kernel.shutdown();
  });

  it("projects verification instead of repeated mutation after a supervised change has downstream verification", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-read", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-edit-1", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "broken evidence" } },
      { id: "call-edit-2", name: "core.file.edit", input: { path: "README.md", expected: "broken evidence", replacement: "fixed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "inspect, change, then verify",
      caller: "runtime.stage-transition.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorReadChangeVerifyPolicy(),
      limits: { maxModelIterations: 4, maxToolCalls: 8 }
    }));

    const editResults = events.filter((event) =>
      event.kind === "model.tool.result" &&
      ((event.data.feedback as JsonObject | undefined)?.capabilityId === "core.file.edit" ||
        (event.data.dispatchSummary as JsonObject | undefined)?.capabilityId === "core.file.edit") &&
      event.data.terminalKind === "capability.completed"
    );
    const rejectedEdits = events.filter((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.edit" &&
      event.data.terminalKind === "workflow-capability-boundary.rejected"
    );
    const thirdBoard = events.filter((event) => event.kind === "tool.decision-board.snapshot").at(2);

    assert.equal(editResults.length, 1);
    assert.equal(rejectedEdits.length > 0, true);
    assert.equal((thirdBoard?.data.visibleToolIds as string[] | undefined)?.includes("core.file.edit"), true);
    assert.equal((thirdBoard?.data.visibleToolIds as string[] | undefined)?.includes("core.test.run"), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "broken evidence\n");
    await kernel.shutdown();
  });

  it("prefers surgical mutation progress over whole-file writes when edit or patch tools exist", () => {
    assert.deepEqual(
      progressCapabilityIdsForWorkflowStage("produce", ["core.file.write", "core.file.edit", "core.patch.apply"]),
      ["core.file.edit", "core.patch.apply"]
    );
  });

  it("does not advance mutation stages from patch dry-runs without applied changes", () => {
    const policy = workflowMutationStageProfilePolicy();
    const workflow = policy.stagedTaskWorkflow;
    assert.ok(workflow);
    const patchPolicy: AgentLoopProfilePolicyMetadata = {
      ...policy,
      workflowCapabilityIds: ["core.file.read", "core.workspace.glob", "core.file.edit", "core.patch.apply", "core.test.run"],
      stagedTaskWorkflow: {
        ...workflow,
        graph: {
          ...workflow.graph,
          stages: workflow.graph.stages.map((stage) =>
            stage.stageId === "stage:change"
              ? { ...stage, allowedTools: ["core.file.read", "core.file.edit", "core.patch.apply"] }
              : stage
          )
        }
      }
    };

    const dryRun = advanceWorkflowStageFromToolEvidence({
      profilePolicy: patchPolicy,
      capabilityId: "core.patch.apply",
      toolCallId: "call-patch-dry-run",
      toolInput: { patch: "--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n", dryRun: true },
      terminal: completedCapabilityEvent({ dryRun: true, applied: false }),
      at: "2026-07-06T00:00:00.000Z"
    });
    const applied = advanceWorkflowStageFromToolEvidence({
      profilePolicy: patchPolicy,
      capabilityId: "core.patch.apply",
      toolCallId: "call-patch-apply",
      toolInput: { patch: "--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n" },
      terminal: completedCapabilityEvent({ dryRun: false, applied: true }),
      at: "2026-07-06T00:00:01.000Z"
    });

    assert.equal(dryRun, undefined);
    assert.equal(applied?.stage.stageId, "stage:change");
  });

  it("keeps the model-visible mutation workflow schema stable while preserving supporting reads", () => {
    const projected = projectToolSet([
      manifest("core.file.read", "read", []),
      manifest("core.workspace.glob", "read", []),
      manifest("core.file.edit", "write", []),
      manifest("core.test.run", "process", ["process:run"])
    ], {
      prompt: "inspect target source before editing",
      caller: "runtime.mutation-supporting-read.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: workflowMutationStageProfilePolicy()
    });

    assert.deepEqual(projected.map((tool) => String(tool.id)), ["core.file.read", "core.workspace.glob", "core.file.edit", "core.test.run"]);
  });

  it("keeps explicit-prefix provider cache tools on the stable workflow boundary across active stages", () => {
    const capabilities = [
      manifest("core.file.read", "read", []),
      manifest("core.workspace.glob", "read", []),
      manifest("core.file.edit", "write", []),
      manifest("core.patch.apply", "write", []),
      manifest("core.test.run", "process", ["process:test"])
    ];
    const request = {
      prompt: "edit the target source",
      caller: "runtime.provider-tool-projection.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl" as const,
      profile: defaultGlmAnthropicProfile,
      toolProjection: "safe-all" as const,
      profilePolicy: {
        ...workflowMutationStageProfilePolicy(),
        workflowCapabilityIds: [
          "core.file.read",
          "core.workspace.glob",
          "core.file.edit",
          "core.patch.apply",
          "core.test.run"
        ]
      }
    };

    assert.deepEqual(
      projectProviderCacheToolSet(capabilities, request).map((tool) => String(tool.id)),
      ["core.file.read", "core.workspace.glob", "core.file.edit", "core.patch.apply", "core.test.run"]
    );
  });

  it("keeps explicit-prefix provider cache tools stable when a runtime convergence gate narrows executable tools", () => {
    const capabilities = [
      manifest("core.file.read", "read", []),
      manifest("core.workspace.glob", "read", []),
      manifest("core.file.edit", "write", []),
      manifest("core.patch.apply", "write", []),
      manifest("core.test.run", "process", ["process:test"])
    ];
    const request = {
      prompt: "edit the target source",
      caller: "runtime.provider-tool-projection.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl" as const,
      profile: defaultGlmAnthropicProfile,
      toolProjection: "safe-all" as const,
      profilePolicy: {
        ...workflowMutationStageProfilePolicy(),
        workflowCapabilityIds: [
          "core.file.read",
          "core.workspace.glob",
          "core.file.edit",
          "core.patch.apply",
          "core.test.run"
        ],
        workflowGateOverride: {
          gate: "runtime-convergence",
          requiredNextAction: "core.file.edit|core.patch.apply",
          terminalKind: "workflow-required-action.rejected",
          toolCallId: "call-convergence"
        }
      }
    };

    assert.deepEqual(
      projectToolSet(capabilities, request).map((tool) => String(tool.id)),
      ["core.file.edit", "core.patch.apply"]
    );
    assert.deepEqual(
      projectProviderCacheToolSet(capabilities, request).map((tool) => String(tool.id)),
      ["core.file.read", "core.workspace.glob", "core.file.edit", "core.patch.apply", "core.test.run"]
    );
  });

  it("narrows automatic-cache provider tools when a runtime convergence gate requires mutation progress", () => {
    const capabilities = [
      manifest("core.file.read", "read", []),
      manifest("core.workspace.glob", "read", []),
      manifest("core.file.edit", "write", []),
      manifest("core.patch.apply", "write", []),
      manifest("core.test.run", "process", ["process:test"])
    ];
    const request = {
      prompt: "edit the target source",
      caller: "runtime.provider-tool-projection.deepseek.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl" as const,
      profile: defaultDeepSeekProfile,
      toolProjection: "all" as const,
      profilePolicy: {
        ...workflowMutationStageProfilePolicy(),
        profileId: "evaluation/swe-bench-lite.v1",
        role: "evaluation-workflow",
        workflowGraphId: "workflow/evaluation.swe-bench-lite.child.v1",
        workflowGovernanceMode: "evaluation" as const,
        workflowCapabilityIds: [
          "core.file.read",
          "core.workspace.glob",
          "core.file.edit",
          "core.patch.apply",
          "core.test.run"
        ],
        workflowGateOverride: {
          gate: "runtime-convergence",
          requiredNextAction: "core.file.edit|core.patch.apply",
          terminalKind: "workflow-required-action.rejected",
          toolCallId: "call-convergence"
        }
      }
    };

    assert.deepEqual(
      projectToolSet(capabilities, request).map((tool) => String(tool.id)),
      ["core.file.edit", "core.patch.apply"]
    );
    assert.deepEqual(
      projectProviderCacheToolSet(capabilities, request).map((tool) => String(tool.id)),
      ["core.file.edit", "core.patch.apply"]
    );
  });

  it("narrows automatic-cache provider tools to active evaluation stage progress before misses", () => {
    const basePolicy = workflowMutationStageProfilePolicy();
    assert.ok(basePolicy.stagedTaskWorkflow);
    const capabilities = [
      manifest("core.file.read", "read", []),
      manifest("core.workspace.glob", "read", []),
      manifest("core.file.edit", "write", []),
      manifest("core.patch.apply", "write", []),
      manifest("core.test.run", "process", ["process:test"]),
      manifest("core.shell.run", "process", ["process:run"])
    ];
    const request = {
      prompt: "edit the target source",
      caller: "runtime.provider-tool-projection.deepseek-ready-stage.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl" as const,
      profile: defaultDeepSeekProfile,
      toolProjection: "all" as const,
      profilePolicy: {
        ...basePolicy,
        profileId: "evaluation/swe-bench-lite.v1",
        role: "evaluation-workflow",
        workflowGraphId: "workflow/evaluation.swe-bench-lite.child.v1",
        workflowGovernanceMode: "evaluation" as const,
        workflowCapabilityIds: [
          "core.file.read",
          "core.workspace.glob",
          "core.file.edit",
          "core.patch.apply",
          "core.test.run",
          "core.shell.run"
        ],
        stagedTaskWorkflow: {
          ...basePolicy.stagedTaskWorkflow,
          graph: {
            ...basePolicy.stagedTaskWorkflow.graph,
            stages: basePolicy.stagedTaskWorkflow.graph.stages.map((stage) =>
              stage.stageId === "stage:change"
                ? { ...stage, allowedTools: ["core.file.read", "core.file.edit", "core.patch.apply", "core.shell.run"] }
                : stage
            )
          }
        }
      }
    };

    assert.deepEqual(
      projectProviderCacheToolSet(capabilities, request).map((tool) => String(tool.id)),
      ["core.file.edit", "core.patch.apply"]
    );
  });

  it("projects provider repair tools after a failed standard verification gate", () => {
    const capabilities = [
      manifest("core.file.read", "read", []),
      manifest("core.search.text", "read", []),
      manifest("core.file.edit", "write", []),
      manifest("core.patch.apply", "write", []),
      manifest("core.test.run", "process", ["process:test"]),
      manifest("core.shell.run", "process", ["process:run"])
    ];
    const request = {
      prompt: "inspect failed verification and repair",
      caller: "runtime.provider-verification-repair-projection.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl" as const,
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all" as const,
      profilePolicy: {
        ...supervisorReadyVerifyPolicy(),
        workflowCapabilityIds: [
          "core.file.read",
          "core.search.text",
          "core.file.edit",
          "core.patch.apply",
          "core.test.run"
        ],
        workflowGateOverride: {
          gate: "runtime-convergence" as const,
          requiredNextAction: "focused-read-or-source-edit-or-test-or-return-control",
          rejectedCapabilityId: "core.test.run",
          rejectedToolName: "core.test.run",
          terminalKind: "workflow-standard-test-failed",
          toolCallId: "call-standard-test"
        }
      }
    };

    assert.deepEqual(
      projectProviderCacheToolSet(capabilities, request).map((tool) => String(tool.id)),
      ["core.file.read", "core.search.text", "core.file.edit", "core.patch.apply", "core.test.run"]
    );
  });

  it("keeps model-visible staged workflow tools on the stable workflow boundary", () => {
    const capabilities = [
      manifest("core.file.read", "read", []),
      manifest("core.workspace.glob", "read", []),
      manifest("core.file.edit", "write", []),
      manifest("core.patch.apply", "write", []),
      manifest("core.test.run", "process", ["process:test"]),
      manifest("core.shell.run", "process", ["process:run"])
    ];
    const request = {
      prompt: "edit the target source",
      caller: "runtime.visible-tool-stability.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl" as const,
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all" as const,
      profilePolicy: {
        ...workflowMutationStageProfilePolicy(),
        workflowCapabilityIds: [
          "core.file.read",
          "core.workspace.glob",
          "core.file.edit",
          "core.patch.apply",
          "core.test.run"
        ]
      }
    };

    assert.deepEqual(
      projectToolSet(capabilities, request).map((tool) => String(tool.id)),
      ["core.file.read", "core.workspace.glob", "core.file.edit", "core.patch.apply", "core.test.run"]
    );
  });

  it("prefers standard test progress over shell smoke commands during verification", () => {
    assert.deepEqual(
      progressCapabilityIdsForWorkflowStage("verify", ["core.test.run", "core.shell.run", "core.git.diff"]),
      ["core.test.run"]
    );
  });

  it("projects standard-test-only provider schema with anti-reproduction command guidance", () => {
    const projected = projectProviderCacheToolSet([
      manifest("core.test.run", "process", ["process:test"])
    ], {
      profile: defaultDeepSeekProfile,
      profilePolicy: verifyOnlyPolicy("core.test.run"),
      toolProjection: "all"
    } as unknown as Parameters<typeof projectProviderCacheToolSet>[1]);
    const schemaText = JSON.stringify(projected[0]?.inputSchema ?? {});

    assert.equal(String(projected[0]?.id), "core.test.run");
    assert.match(projected[0]?.description ?? "", /standard repository test command/i);
    assert.match(schemaText, /Do not use python -c/i);
    assert.match(schemaText, /Do not set cwd to \/workspace/i);
  });

  it("projects strict standard-test gates to core test execution instead of shell", () => {
    const projected = projectWorkflowGateOverrideTools([
      manifest("core.test.run", "process", ["process:run"]),
      manifest("core.shell.run", "process", ["process:run"])
    ], {
      gate: "runtime-convergence",
      requiredNextAction: "standard-test-command",
      terminalKind: "workflow-standard-test-required",
      toolCallId: "call-non-standard-test"
    }, { strict: true, preferCanonicalCoreActions: true });

    assert.deepEqual(projected.map((tool) => String(tool.id)), ["core.test.run"]);
  });

  it("matches ready-stage budgets by active control stage before reviewed parent stage", () => {
    const budget = readyStageBudgetForControl({
      maxModelIterations: 10,
      maxToolCalls: 10,
      turnTimeoutMs: 120_000,
      toolTimeoutMs: 30_000,
      maxOutputBytes: 16_000,
      maxRetries: 0,
      maxRepairAttempts: 1,
      stageBudgets: [
        { stageId: "stage:change", maxModelIterations: 16, stopReason: "change-budget" },
        { stageId: "stage:verify", maxModelIterations: 12, stopReason: "verify-budget" }
      ]
    }, {
      stageId: "stage:verify",
      stageKind: "verify",
      budgetStageId: "stage:change",
      budgetStageKind: "produce"
    });

    assert.equal(budget?.stopReason, "verify-budget");
  });

  it("bounds ready-stage required-action misses as correction before fail-closed", () => {
    const correction = readyStageRequiredActionConvergence({
      missCount: 0,
      correctionLimit: 1,
      iteration: 2,
      maxModelIterations: 4,
      workflowReadyStageControl: { stageId: "stage:implement", requiredNextAction: "modify workspace" },
      requestedCapabilityId: "core.file.read"
    });
    assert.equal(correction.kind, "retry-with-feedback");
    assert.equal(correction.reasonCode, "workflow-required-action.missed");
    assert.equal(correction.terminalKind, "workflow-required-action.rejected");
    assert.equal(correction.metadata?.retryPolicy, "correct-bounded");
    assert.equal(correction.metadata?.correctionAttempt, 1);

    const exhausted = readyStageRequiredActionConvergence({
      missCount: 1,
      correctionLimit: 1,
      iteration: 4,
      maxModelIterations: 4,
      workflowReadyStageControl: { stageId: "stage:implement", requiredNextAction: "modify workspace" },
      requestedCapabilityId: "core.file.read"
    });
    assert.equal(exhausted.kind, "terminal");
    assert.equal(exhausted.reasonCode, "workflow-required-action.missed");
    assert.equal(exhausted.metadata?.retryPolicy, "fail-closed");
    assert.equal(exhausted.metadata?.correctionAttempt, 2);
  });

  it("maps terminal tool completion to terminal convergence without another model turn", () => {
    const completed = terminalToolConvergence({
      capabilityId: "core.task.complete",
      toolName: "core.task.complete",
      terminalKind: "capability.completed",
      feedbackStatus: "success"
    });
    assert.equal(completed.kind, "terminal");
    assert.equal(completed.reasonCode, "terminal-tool-completed");
    assert.equal(completed.terminalKind, "capability.completed");

    const failed = terminalToolConvergence({
      capabilityId: "core.task.complete",
      toolName: "core.task.complete",
      terminalKind: "capability.failed",
      feedbackStatus: "failed"
    });
    assert.equal(failed.kind, "terminal");
    assert.equal(failed.reasonCode, "terminal-tool-failed");
    assert.equal(failed.metadata?.feedbackStatus, "failed");
  });

  it("bounds model-facing tool text without splitting Unicode surrogate pairs", () => {
    const text = `${"a".repeat(7999)}🧠tail`;
    const bounded = boundedModelText(text, 8000);
    const preview = toolFeedbackPreview(text, 8000);

    assert.equal(Buffer.byteLength(bounded, "utf8") <= 8000, true);
    assert.equal(Buffer.byteLength(preview.text, "utf8") <= 8000, true);
    assert.equal(preview.truncated, true);
    assert.equal(hasLoneSurrogate(bounded), false);
    assert.equal(hasLoneSurrogate(preview.text), false);
  });

  it("expands staged workflow family ids into the stable model-visible capability boundary", () => {
    const capabilities = [
      manifest("core.file.edit", "write"),
      manifest("core.text.replace", "write"),
      manifest("core.file.copy", "write"),
      manifest("core.file.move", "write"),
      manifest("core.test.run", "process", ["process:test"])
    ];
    const projected = projectToolSet(capabilities, {
      prompt: "change files",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: {
        schemaVersion: "1.0.0",
        profileId: "test/family-allowed-tools.v1",
        role: "engineering-agent",
        workflowGraphId: "workflow/test.family-allowed-tools.v1",
        toolProjection: "safe-all",
        toolProjectionSource: "profile",
        workflowPriority: "primary",
        orchestrationMode: "staged-capability-workflow",
        workflowCapabilityIds: ["file.edit", "file.copy", "build.test-lint-typecheck"],
        workflowStages: [{
          id: "change",
          objective: "Apply governed semantic mutations.",
          capabilityIds: ["file.edit", "file.copy", "build.test-lint-typecheck"],
          entryCriteria: ["change stage ready"],
          exitCriteria: ["mutation evidence produced"]
        }],
        antiTailoring: false,
        executionBoundary: "governed-capabilities",
        redaction: { class: "internal" },
        stagedTaskWorkflow: {
          schemaVersion: "1.0.0",
          profileId: "test/family-allowed-tools.v1",
          graphId: "graph:test.family-allowed-tools",
          fingerprint: "fnv1a:family-allowed-tools",
          stageCount: 1,
          refCount: 1,
          executorKinds: ["agent-loop"],
          graph: {
            schemaVersion: "1.0.0",
            graphId: "graph:test.family-allowed-tools",
            profileId: "test/family-allowed-tools.v1",
            stages: [{
              schemaVersion: "1.0.0",
              stageId: "stage:change",
              kind: "produce",
              executorKind: "agent-loop",
              dependsOn: [],
              inputRefs: [],
              expectedOutputRefs: ["ref:change"],
              allowedTools: ["file.edit", "file.copy", "file.move", "build.test-lint-typecheck"],
              compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
              redaction: { class: "internal" }
            }],
            refs: [{
              schemaVersion: "1.0.0",
              refId: "ref:change",
              type: "evidence",
              producerStageId: "stage:change",
              scope: "task",
              compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
              redaction: { class: "internal" }
            }],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          runState: {
            schemaVersion: "1.0.0",
            taskRunId: "staged:graph:test.family-allowed-tools",
            graphId: "graph:test.family-allowed-tools",
            profileId: "test/family-allowed-tools.v1",
            stageStates: [{
              stageId: "stage:change",
              status: "ready",
              attempts: 0,
              inputRefs: [],
              outputRefs: [],
              diagnostics: []
            }],
            refs: [],
            events: [],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          redaction: { class: "internal" }
        }
      }
    });

    const ids = projected.map((manifest) => String(manifest.id));
    assert.deepEqual(ids, [
      "core.file.edit",
      "core.text.replace",
      "core.file.copy",
      "core.file.move",
      "core.test.run"
    ]);
  });

  it("bounds tool result continuation messages before sending them back to the model", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const longOutput = `${"x".repeat(240)}SHOULD_NOT_REACH_MODEL`;
    await deps.capabilities.register({
      ...runtimeEchoCapability,
      id: "runtime.large-tool-output" as typeof runtimeEchoCapability.id,
      name: "Runtime Large Tool Output",
      sideEffect: "none",
      permissions: []
    }, async () => ({
      ok: true,
      value: {
        evidence: {
          tool: "large.output",
          status: "completed",
          affectedPaths: [],
          preview: {
            text: longOutput,
            byteLength: Buffer.byteLength(longOutput, "utf8"),
            lineCount: 1,
            truncated: false,
            limitBytes: Buffer.byteLength(longOutput, "utf8"),
            redaction: { class: "internal" }
          },
          diagnostics: [],
          metadata: {},
          replay: {},
          redaction: { class: "internal", fields: ["preview.text"] }
        }
      }
    }));
    const gateway = new RecordingSingleToolCallModelGateway("runtime.large-tool-output", {});
    const loopDeps = { ...deps, models: gateway };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "run large tool",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxOutputBytes: 80 }
    }));

    const toolMessage = gateway.requests[1]?.messages?.find((message) => message.role === "tool");
    assert.ok(toolMessage, "second model request should include bounded tool feedback");
    assert.equal(Buffer.byteLength(toolMessage.content, "utf8") <= 80, true);
    assert.equal(toolMessage.content.includes("SHOULD_NOT_REACH_MODEL"), false);
    await kernel.shutdown();
  });

  it("reports provider replay telemetry from the bounded model request history", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "bounded replay telemetry\n");
    const calls = Array.from({ length: 10 }, (_, index) => ({
      id: `call-read-${index + 1}`,
      name: "core.file.read",
      input: { path: "README.md" }
    }));
    const gateway = new SequentialToolCallModelGateway(calls);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "read repeatedly so provider history must be bounded",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      limits: { maxModelIterations: 11, maxToolCalls: 10 }
    }));

    const requestEvents = events.filter((event) => event.kind === "model.requested");
    const lastRequest = requestEvents.at(-1);
    const lastGatewayRequest = gateway.requests.at(-1);
    const replay = lastRequest?.data.providerRequestReplay as { readonly selectedHistoryMessageCount?: number; readonly providerMessageCount?: number } | undefined;

    assert.ok(lastGatewayRequest?.messages, "gateway should capture the final bounded provider messages");
    assert.equal(replay?.providerMessageCount, lastGatewayRequest.messages.length);
    assert.equal(replay?.selectedHistoryMessageCount, lastGatewayRequest.messages.length);
    await kernel.shutdown();
  });

  it("passes model provider key and provider id separately to capability context", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const capabilityId = "runtime.model-metadata-echo" as typeof runtimeEchoCapability.id;
    await deps.capabilities.register({
      ...runtimeEchoCapability,
      id: capabilityId,
      name: "Runtime Model Metadata Echo",
      sideEffect: "none",
      permissions: []
    }, async (_input, context) => ({
      ok: true,
      value: {
        activeModel: context.metadata.activeModel,
        activeModelProvider: context.metadata.activeModelProvider,
        activeModelProviderId: context.metadata.activeModelProviderId
      }
    }));
    const loopDeps = { ...deps, models: new RecordingSingleToolCallModelGateway(capabilityId, {}) };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "echo model metadata",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: { ...defaultDeepSeekProfile, provider: "fixture-provider", model: "fixture-model" }
    }));

    const output = events.find((event) => event.kind === "capability.output")?.data.output as JsonObject | undefined;
    assert.equal(output?.activeModel, "fixture-model");
    assert.equal(output?.activeModelProvider, "fixture-provider");
    assert.equal(output?.activeModelProviderId, String(defaultDeepSeekProfile.providerId));
    await kernel.shutdown();
  });

  it("emits a success feedback DTO when a tool execution completes", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "feedback success\n");
    const loopDeps = { ...deps, models: new OneToolThenFinishModelGateway("core.file.read", { path: "README.md" }) };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "read readme",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const feedback = readFeedback(events);
    assert.ok(feedback, "model.tool.result event should carry a typed feedback payload");
    assert.equal(feedback.schemaVersion, "1.0.0");
    assert.equal(feedback.status, "success");
    assert.equal(feedback.continuation, "continue");
    assert.equal(feedback.toolCallId, "call-runtime");
    assert.equal(feedback.toolName, "core.file.read");
    assert.equal(feedback.preview.limitBytes > 0, true);
    assert.equal(feedback.trace.traceId.length > 0, true);
    assert.equal(feedback.trace.correlationId.length > 0, true);
    const resultEvent = events.find((event) => event.kind === "model.tool.result");
    const dispatchSummary = (resultEvent?.data as JsonObject | undefined)?.dispatchSummary as JsonObject | undefined;
    assert.equal(dispatchSummary?.terminalStatus, "completed");
    assert.equal(dispatchSummary?.toolCallId, "call-runtime");
    assert.equal(dispatchSummary?.inProgressToolCallIds instanceof Array, true);
    await kernel.shutdown();
  });

  it("emits failed feedback when a completed capability reports failed evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.capabilities.register({
      ...runtimeEchoCapability,
      id: "runtime.failed-evidence" as typeof runtimeEchoCapability.id,
      name: "Runtime Failed Evidence",
      sideEffect: "none",
      permissions: []
    }, async () => ({
      ok: true,
      value: {
        evidence: {
          tool: "test.run",
          status: "failed",
          affectedPaths: ["/workspace"],
          preview: {
            text: "exit code 2\nmissing test file\n",
            byteLength: 30,
            lineCount: 2,
            truncated: false,
            limitBytes: 8000,
            redaction: { class: "internal" }
          },
          diagnostics: [],
          metadata: { exitCode: 2 },
          replay: {},
          redaction: { class: "internal", fields: ["preview.text", "affectedPaths"] }
        }
      }
    }));
    const loopDeps = { ...deps, models: new OneToolThenFinishModelGateway("runtime.failed-evidence", {}) };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "run a failing test",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const feedback = readFeedback(events);
    assert.ok(feedback);
    assert.equal(feedback.status, "failed");
    assert.equal(feedback.continuation, "continue");
    assert.match(feedback.preview.text, /Tool runtime\.failed-evidence reported failed/);
    assert.match(feedback.preview.text, /exit code 2/);
    await kernel.shutdown();
  });

  it("passes bounded model-requested tool timeouts into the kernel envelope", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.capabilities.register({
      ...runtimeEchoCapability,
      id: "runtime.timeout-observer" as typeof runtimeEchoCapability.id,
      name: "Runtime Timeout Observer",
      inputSchema: {
        type: "object",
        properties: {
          timeoutMs: { type: "number" }
        }
      }
    }, async (_input: JsonObject, context: CapabilityExecutionContext) => ({
      ok: true,
      value: {
        evidence: {
          tool: "timeout.observer",
          status: "completed",
          affectedPaths: [],
          preview: {
            text: `observed timeout ${context.envelope.timeoutMs}`,
            byteLength: 22,
            lineCount: 1,
            truncated: false,
            limitBytes: 8000,
            redaction: { class: "internal" }
          },
          diagnostics: [],
          metadata: { observedTimeoutMs: context.envelope.timeoutMs },
          replay: {},
          redaction: { class: "internal", fields: ["preview.text"] }
        }
      }
    }));
    const loopDeps = { ...deps, models: new OneToolThenFinishModelGateway("runtime.timeout-observer", { timeoutMs: 90_000 }) };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "run a longer tool",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { toolTimeoutMs: 120_000 }
    }));

    const completed = events.find((event) => event.kind === "capability.completed");
    const output = completed?.data.output as { evidence?: { metadata?: { observedTimeoutMs?: number } } } | undefined;
    assert.equal(output?.evidence?.metadata?.observedTimeoutMs, 90_000);
    await kernel.shutdown();
  });

  it("uses manifest-declared long tool budgets when the model omits timeoutMs", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.capabilities.register({
      ...runtimeEchoCapability,
      id: "runtime.long-timeout-observer" as typeof runtimeEchoCapability.id,
      name: "Runtime Long Timeout Observer",
      sideEffect: "process",
      permissions: ["process:run"],
      timeoutMs: 7_200_000
    }, async (_input: JsonObject, context: CapabilityExecutionContext) => ({
      ok: true,
      value: {
        evidence: {
          tool: "timeout.observer",
          status: "completed",
          affectedPaths: [],
          preview: {
            text: `observed timeout ${context.envelope.timeoutMs}`,
            byteLength: 22,
            lineCount: 1,
            truncated: false,
            limitBytes: 8000,
            redaction: { class: "internal" }
          },
          diagnostics: [],
          metadata: { observedTimeoutMs: context.envelope.timeoutMs },
          replay: {},
          redaction: { class: "internal", fields: ["preview.text"] }
        }
      }
    }));
    const loopDeps = {
      ...deps,
      models: new OneToolThenFinishModelGateway("runtime.long-timeout-observer", {}),
      policy: new AllowAllPolicyEngine()
    };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "run a governed long tool",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { toolTimeoutMs: 30_000 }
    }));

    const completed = events.find((event) => event.kind === "capability.completed");
    const output = completed?.data.output as { evidence?: { metadata?: { observedTimeoutMs?: number } } } | undefined;
    assert.equal(output?.evidence?.metadata?.observedTimeoutMs, 7_200_000);
    await kernel.shutdown();
  });

  it("does not shrink manifest-declared long tool budgets to the outer run timeout", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.capabilities.register({
      ...runtimeEchoCapability,
      id: "runtime.outer-timeout-long-tool" as typeof runtimeEchoCapability.id,
      name: "Runtime Outer Timeout Long Tool",
      sideEffect: "process",
      permissions: ["process:run"],
      timeoutMs: 7_200_000
    }, async (_input: JsonObject, context: CapabilityExecutionContext) => ({
      ok: true,
      value: {
        evidence: {
          tool: "timeout.observer",
          status: "completed",
          affectedPaths: [],
          preview: {
            text: `observed timeout ${context.envelope.timeoutMs}`,
            byteLength: 22,
            lineCount: 1,
            truncated: false,
            limitBytes: 8000,
            redaction: { class: "internal" }
          },
          diagnostics: [],
          metadata: { observedTimeoutMs: context.envelope.timeoutMs },
          replay: {},
          redaction: { class: "internal", fields: ["preview.text"] }
        }
      }
    }));
    const loopDeps = {
      ...deps,
      models: new OneToolThenFinishModelGateway("runtime.outer-timeout-long-tool", {}),
      policy: new AllowAllPolicyEngine()
    };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "run a governed long tool under a shorter outer run budget",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      timeoutMs: 600_000,
      limits: { toolTimeoutMs: 30_000 }
    }));

    const completed = events.find((event) => event.kind === "capability.completed");
    const output = completed?.data.output as { evidence?: { metadata?: { observedTimeoutMs?: number } } } | undefined;
    assert.equal(output?.evidence?.metadata?.observedTimeoutMs, 7_200_000);
    await kernel.shutdown();
  });

  it("emits a terminal failed event when a repairable tool error happens on the final model iteration", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.capabilities.register({
      ...runtimeEchoCapability,
      id: "runtime.throwing-tool" as typeof runtimeEchoCapability.id,
      name: "Runtime Throwing Tool"
    }, async () => {
      throw new Error("simulated tool failure");
    });
    const loopDeps = { ...deps, models: new OneToolThenFinishModelGateway("runtime.throwing-tool", {}) };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "trigger a repairable tool failure",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      selfRepair: { enabled: true, maxAttempts: 1, requireCheckpointForWrites: false, verificationMode: "minimal" },
      limits: { maxModelIterations: 1, maxRepairAttempts: 1 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.repair.attempt.completed"), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.failed");
    assert.equal(events.at(-1)?.data.reason, "tool-terminal-error");
    await kernel.shutdown();
  });

  it("emits a denied feedback DTO when policy rejects the tool execution", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "feedback deny\n");
    const loopDeps = { ...deps, models: new OneToolThenFinishModelGateway("core.file.read", { path: "README.md" }), policy: new DenyAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "policy denies this",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const feedback = readFeedback(events);
    assert.ok(feedback);
    assert.equal(feedback.status, "denied");
    assert.match(feedback.correctiveAction ?? "", /permission|policy|different projected tool/i);
    assert.match(feedback.recommendedNextAction ?? "", /permission|different projected tool|bounded blocker/i);
    assert.equal(feedback.diagnostics.length >= 1, true);
    assert.equal(feedback.diagnostics[0]?.code, "KERNEL_POLICY_DENIED");
    const laterSnapshot = lastMatchingEvent(events, "tool.decision-board.snapshot");
    const deniedRecord = ((laterSnapshot?.data as JsonObject | undefined)?.records as JsonObject[] | undefined)
      ?.find((record) => record.kind === "policy" && record.status === "denied");
    assert.ok(deniedRecord, "decision board must record policy denials");
    await kernel.shutdown();
  });

  it("emits a denied feedback DTO when a tool-execution hook blocks the tool", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "hook deny\n");
    await deps.hooks.registerHook({
      id: "hook:block-tool-execution" as never,
      name: "Block Tool Execution",
      version: "1.0.0",
      point: "tool-execution.before",
      source: "workspace",
      trust: "trusted",
      ordering: { priority: 0 },
      timeoutMs: 1000,
      failurePolicy: "block",
      isolation: "in-process-observe-only",
      permissions: [],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      enabled: true,
      redaction: { class: "internal" }
    }, async () => ({
      ok: false,
      error: {
        code: "HOOK_BLOCKED_BY_TEST",
        message: "test hook blocked tool execution",
        retryable: false,
        redaction: { class: "internal" }
      }
    }));
    const loopDeps = { ...deps, models: new OneToolThenFinishModelGateway("core.file.read", { path: "README.md" }) };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "read with hook block",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const result = events.find((event) => event.kind === "model.tool.result" && event.data.terminalKind === "hook.blocked");
    const feedback = (result?.data as { feedback?: ToolResultFeedback } | undefined)?.feedback;
    assert.ok(feedback);
    assert.equal(feedback.status, "denied");
    assert.match(feedback.preview.text, /tool-execution\.before hook blocked core\.file\.read/);
    assert.equal(events.some((event) => event.kind === "capability.started"), false);
    await kernel.shutdown();
  });

  it("emits a rejected feedback DTO when preflight rejects an unsafe path", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const loopDeps = { ...deps, models: new OneToolThenFinishModelGateway("core.file.read", { path: "../outside.txt" }) };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "unsafe path",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 1 }
    }));

    const feedback = readFeedback(events);
    assert.ok(feedback, "preflight rejection must still produce a typed feedback record");
    assert.equal(feedback.status, "rejected");
    assert.equal(feedback.continuation, "continue");
    assert.match(feedback.correctiveAction ?? "", /correct|different projected tool/i);
    assert.match(feedback.recommendedNextAction ?? "", /corrected input|different projected tool/i);
    assert.equal(feedback.preview.truncated, false);
    await kernel.shutdown();
  });

  it("records successful and failed execution outcomes on the decision board", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "decision execution\n");
    const successGateway = new RecordingSingleToolCallModelGateway("core.file.read", { path: "README.md" });
    const successDeps = { ...deps, models: successGateway };
    await registerRuntimeCoreTools(successDeps, "/workspace");
    const successKernel = await createDefaultRuntimeKernel(successDeps);
    const successEvents = await collectRuntimeEvents(runAgentLoop(successDeps, successKernel, {
      prompt: "read a file",
      caller: "runtime.decision-board.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 2 }
    }));
    const successSnapshot = lastMatchingEvent(successEvents, "tool.decision-board.snapshot");
    const successRecord = ((successSnapshot?.data as JsonObject | undefined)?.records as JsonObject[] | undefined)
      ?.find((record) => record.kind === "execution" && record.status === "completed" && record.capabilityId === "core.file.read");
    assert.ok(successRecord, "decision board must record completed tool executions");
    await successKernel.shutdown();

    const failureDeps = createDeterministicRuntimeDependencies();
    await failureDeps.capabilities.register({
      ...runtimeEchoCapability,
      id: "runtime.failed-evidence-board" as typeof runtimeEchoCapability.id,
      name: "Runtime Failed Evidence Board",
      sideEffect: "none",
      permissions: []
    }, async () => ({
      ok: true,
      value: {
        evidence: {
          tool: "test.run",
          status: "failed",
          affectedPaths: [],
          preview: {
            text: "focused test failed",
            byteLength: 19,
            lineCount: 1,
            truncated: false,
            limitBytes: 8000,
            redaction: { class: "internal" }
          },
          diagnostics: [],
          metadata: {},
          replay: {},
          redaction: { class: "internal", fields: ["preview.text"] }
        }
      }
    }));
    const failedLoopDeps = { ...failureDeps, models: new RecordingSingleToolCallModelGateway("runtime.failed-evidence-board", {}) };
    const failureKernel = await createDefaultRuntimeKernel(failedLoopDeps);
    const failureEvents = await collectRuntimeEvents(runAgentLoop(failedLoopDeps, failureKernel, {
      prompt: "run failing evidence",
      caller: "runtime.decision-board.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 2 }
    }));
    const failureSnapshot = lastMatchingEvent(failureEvents, "tool.decision-board.snapshot");
    const failureRecord = ((failureSnapshot?.data as JsonObject | undefined)?.records as JsonObject[] | undefined)
      ?.find((record) => record.kind === "execution" && record.status === "failed" && record.capabilityId === "runtime.failed-evidence-board");
    assert.ok(failureRecord, "decision board must record failed tool executions");
    await failureKernel.shutdown();
  });

  it("continues after a structured tool policy failure so the model can choose a safer command", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const loopDeps = {
      ...deps,
      models: new OneToolThenFinishModelGateway("core.shell.run", {
        command: "pip3 install --break-system-packages 'numpy<2' 2>&1 | tail -5"
      }),
      policy: new AllowAllPolicyEngine()
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "try unsafe host package install and recover",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      live: true,
      toolProjection: "safe-all",
      limits: { maxModelIterations: 2 }
    }));

    const feedback = readFeedback(events);
    assert.ok(feedback);
    assert.equal(feedback.status, "failed");
    assert.equal(feedback.continuation, "continue");
    assert.equal(feedback.diagnostics[0]?.details?.originalCode, "HOST_PACKAGE_INSTALL_REJECTED");
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    await kernel.shutdown();
  });

  it("continues after a tool scheduler timeout so the model can degrade or report partial verification", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.capabilities.register({
      ...runtimeEchoCapability,
      id: "runtime.timeout-tool" as typeof runtimeEchoCapability.id,
      name: "Runtime Timeout Tool"
    }, async () => {
      const error = new Error("Task cancelled: timeout");
      error.name = "SCHEDULER_TASK_TIMEOUT";
      throw error;
    });
    const loopDeps = { ...deps, models: new OneToolThenFinishModelGateway("runtime.timeout-tool", {}) };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "run a slow verification and continue",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 2 }
    }));

    const feedback = readFeedback(events);
    assert.ok(feedback);
    assert.equal(feedback.status, "timeout");
    assert.equal(feedback.continuation, "continue");
    assert.equal(feedback.diagnostics[0]?.code, "KERNEL_SCHEDULER_TIMEOUT");
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    await kernel.shutdown();
  });

  it("does not close a terminal verify stage after a timed-out verification tool", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.capabilities.register({
      ...runtimeEchoCapability,
      id: "runtime.verify-timeout-tool" as typeof runtimeEchoCapability.id,
      name: "Runtime Verify Timeout Tool",
      sideEffect: "process",
      permissions: ["process:test"]
    }, async () => {
      const error = new Error("Task cancelled: timeout");
      error.name = "SCHEDULER_TASK_TIMEOUT";
      throw error;
    });
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-timeout-1", name: "runtime.verify-timeout-tool", input: { command: "python -m pytest tests/unit.py", timeoutMs: 300_000 } },
      { id: "call-timeout-2", name: "runtime.verify-timeout-tool", input: { command: "python setup.py build_ext --inplace", timeoutMs: 300_000 } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "verify with bounded retries",
      caller: "runtime.verify-timeout-budget.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: verifyOnlyPolicy("runtime.verify-timeout-tool"),
      limits: { maxModelIterations: 5, maxToolCalls: 8 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "agent.loop.completed" &&
      event.data.reason === "terminal-tool-completed"
    ), false);
    assert.equal(events.some((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.requestedCapabilityId === "runtime.verify-timeout-tool"
    ), true);
    await kernel.shutdown();
  });

  it("does not close a terminal verify stage from a non-standard test command", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-reproduction", name: "core.test.run", input: { command: "python", args: ["-c", "print('focused reproduction')"] } },
      { id: "call-standard-test", name: "core.test.run", input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"] } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "verify with a reproduction before a standard test",
      caller: "runtime.verify-standard-test.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: verifyOnlyPolicy("core.test.run"),
      limits: { maxModelIterations: 4, maxToolCalls: 4 }
    }));

    const completed = events.find((event) => event.kind === "agent.loop.completed");
    const secondVisibleToolNames = (gateway.requests[1]?.tools ?? [])
      .map((tool) => {
        const fn = typeof tool.function === "object" && tool.function !== null ? tool.function as { readonly name?: unknown } : undefined;
        return typeof fn?.name === "string" ? fn.name : "";
      })
      .filter(Boolean)
      .sort();
    assert.equal(events.filter((event) => event.kind === "model.requested").length, 2);
    assert.equal(secondVisibleToolNames.includes("core_git_diff"), false);
    assert.equal(secondVisibleToolNames.includes("core_test_run"), true);
    assert.equal(completed?.data.reason, "workflow-stages-completed");
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolCallId === "call-reproduction" &&
      event.data.terminalKind !== "capability.completed"
    ), true);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolCallId === "call-standard-test" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    await kernel.shutdown();
  });

  it("returns evaluation workflows to the external harness after standard local verification", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-standard-test", name: "core.test.run", input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"] } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "verify locally, then return to the external harness",
      caller: "runtime.verify-ready-harness.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorReadyVerifyThenScorePolicy(),
      limits: { maxModelIterations: 3, maxToolCalls: 4 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "workflow.step" &&
      event.data.stageId === "stage:score" &&
      event.data.status === "ready"
    ), false);
    const readyForHarnessGate = events.find((event) =>
      event.kind === "agent.loop.budget.consumed" &&
      event.data.gate === "EXTERNAL_SCORE_READY_GATE"
    );
    const readyForHarnessBudget = readyForHarnessGate?.data.budget as JsonObject | undefined;

    assert.equal(readyForHarnessBudget?.stopReason, "external-score-ready");
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal(events.at(-1)?.data.reason, "external-score-ready");
    assert.equal(gateway.requests.length, 1);
    await kernel.shutdown();
  });

  it("returns ready score stages to the external harness before projecting child harness tools", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "return ready scoring stage to the external harness",
      caller: "runtime.score-ready-harness.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorScoreReadyAfterLocalVerificationPolicy(),
      limits: { maxModelIterations: 3, maxToolCalls: 4 }
    }));

    const readyForHarnessGate = events.find((event) =>
      event.kind === "agent.loop.budget.consumed" &&
      event.data.gate === "EXTERNAL_SCORE_READY_GATE"
    );
    const projectionFailure = events.find((event) =>
      event.kind === "agent.loop.failed" &&
      event.data.reason === "workflow-capability-projection-empty"
    );

    assert.ok(readyForHarnessGate);
    assert.equal(projectionFailure, undefined);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal(events.at(-1)?.data.reason, "external-score-ready");
    assert.equal(gateway.requests.length, 0);
    await kernel.shutdown();
  });

  it("does not advance a verify stage from non-standard core test commands", () => {
    const smoke = advanceWorkflowStageFromToolEvidence({
      profilePolicy: verifyOnlyPolicy("core.test.run"),
      capabilityId: "core.test.run",
      toolCallId: "call-smoke",
      toolInput: { command: "python -c \"print('smoke')\"" },
      terminal: completedCapabilityEvent(),
      at: "2026-07-07T00:00:00.000Z"
    });
    const mixedSideEffect = advanceWorkflowStageFromToolEvidence({
      profilePolicy: verifyOnlyPolicy("core.test.run"),
      capabilityId: "core.test.run",
      toolCallId: "call-mixed-side-effect",
      toolInput: { command: "git checkout astropy/modeling/separable.py && python -m pytest astropy/modeling/tests/test_separable.py -q" },
      terminal: completedCapabilityEvent(),
      at: "2026-07-07T00:00:00.000Z"
    });
    const standard = advanceWorkflowStageFromToolEvidence({
      profilePolicy: verifyOnlyPolicy("core.test.run"),
      capabilityId: "core.test.run",
      toolCallId: "call-standard",
      toolInput: { command: "python -m pytest tests/test_example.py" },
      terminal: completedCapabilityEvent(),
      at: "2026-07-07T00:00:00.000Z"
    });

    assert.equal(smoke, undefined);
    assert.equal(mixedSideEffect, undefined);
    assert.equal(standard?.stage.stageId, "stage:verify");
    assert.equal((standard?.stageEvents.length ?? 0) > 0, true);
  });

  it("rejects non-standard test tool commands before verify execution", () => {
    const error = workflowCapabilityBoundaryGuard({
      profilePolicy: verifyOnlyPolicy("core.test.run"),
      capabilityId: "core.test.run",
      toolName: "core.test.run",
      toolInput: { command: "python -c \"print('smoke')\"" }
    });

    assert.equal(error?.code, "WORKFLOW_STANDARD_TEST_REQUIRED");
  });

  it("allows evaluation reproduction commands without completing verify", () => {
    const policy = {
      ...supervisorReadyVerifyPolicy(),
      workflowGovernanceMode: "evaluation" as const
    };
    const toolInput = {
      command: "python -c \"from demo import reproduce; print(reproduce())\"",
      intent: "reproduce the reported regression before standard verification"
    };
    const error = workflowCapabilityBoundaryGuard({
      profilePolicy: policy,
      workflowReadyStageControl: {
        stageId: "stage:verify",
        stageKind: "verify",
        requiredNextAction: "core.test.run"
      },
      capabilityId: "core.test.run",
      toolName: "core.test.run",
      toolInput
    });
    const progress = advanceWorkflowStageFromToolEvidence({
      profilePolicy: policy,
      capabilityId: "core.test.run",
      toolCallId: "call-evaluation-reproduction",
      toolInput,
      terminal: completedCapabilityEvent(),
      at: "2026-07-07T00:00:00.000Z"
    });

    assert.equal(error, undefined);
    assert.equal(progress, undefined);
  });

  it("allows safe evaluation reproduction commands without intent metadata", () => {
    const policy = {
      ...supervisorReadyVerifyPolicy(),
      workflowGovernanceMode: "evaluation" as const
    };
    const toolInput = {
      command: "python -c \"from demo import reproduce; print(reproduce())\""
    };
    const error = workflowCapabilityBoundaryGuard({
      profilePolicy: policy,
      workflowReadyStageControl: {
        stageId: "stage:verify",
        stageKind: "verify",
        requiredNextAction: "core.test.run"
      },
      capabilityId: "core.test.run",
      toolName: "core.test.run",
      toolInput
    });
    const progress = advanceWorkflowStageFromToolEvidence({
      profilePolicy: policy,
      capabilityId: "core.test.run",
      toolCallId: "call-evaluation-reproduction-without-intent",
      toolInput,
      terminal: completedCapabilityEvent(),
      at: "2026-07-07T00:00:00.000Z"
    });

    assert.equal(error, undefined);
    assert.equal(progress, undefined);
  });

  it("projects focused repair capabilities after a successful evaluation reproduction", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new SuccessfulTestFakePlatformRuntime() });
    await deps.platform.writeFile("/workspace/README.md", "repair target\n");
    const gateway = new SequentialToolCallModelGateway([
      {
        id: "call-evaluation-reproduction",
        name: "core.test.run",
        input: {
          command: "python",
          args: ["-c", "print('reported regression still reproduces')"],
          intent: "reproduce the reported regression before standard verification"
        }
      },
      {
        id: "call-standard-verify",
        name: "core.test.run",
        input: { command: "python -m pytest tests/test_demo.py" }
      }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "reproduce the evaluation failure, repair if needed, then run a standard test",
      caller: "runtime.evaluation-reproduction-repair.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: {
        ...supervisorReadyVerifyPolicy(),
        workflowGovernanceMode: "evaluation"
      },
      limits: { maxModelIterations: 4, maxToolCalls: 4 }
    }));

    const secondVisibleToolNames = providerToolNames(gateway.requests[1]);
    const secondModelRequest = events.filter((event) => event.kind === "model.requested")[1];
    const secondProfilePolicy = secondModelRequest?.data.profilePolicy as {
      workflowGateOverride?: { requiredNextAction?: string; terminalKind?: string };
    } | undefined;

    const reproductionResults = events.filter((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolCallId === "call-evaluation-reproduction"
    );
    assert.equal(
      reproductionResults.some((event) => event.data.terminalKind === "capability.completed"),
      true,
      JSON.stringify(reproductionResults.map((event) => event.data))
    );
    assert.equal(secondVisibleToolNames.includes("core_file_read"), true);
    assert.equal(secondVisibleToolNames.includes("core_search_text"), true);
    assert.equal(secondVisibleToolNames.includes("core_file_edit"), true);
    assert.equal(secondVisibleToolNames.includes("core_patch_apply"), true);
    assert.equal(secondVisibleToolNames.includes("core_test_run"), true);
    assert.equal(
      secondProfilePolicy?.workflowGateOverride?.requiredNextAction,
      "focused-read-or-source-edit-or-test-or-return-control"
    );
    assert.equal(
      secondProfilePolicy?.workflowGateOverride?.terminalKind,
      "workflow-evaluation-reproduction.completed"
    );
    await kernel.shutdown();
  });

  it("rejects evaluation reproduction commands that can mutate the workspace", () => {
    const policy = {
      ...supervisorReadyVerifyPolicy(),
      workflowGovernanceMode: "evaluation" as const
    };
    const writeError = workflowCapabilityBoundaryGuard({
      profilePolicy: policy,
      workflowReadyStageControl: {
        stageId: "stage:verify",
        stageKind: "verify",
        requiredNextAction: "core.test.run"
      },
      capabilityId: "core.test.run",
      toolName: "core.test.run",
      toolInput: {
        command: "python -c \"from pathlib import Path; Path('result.txt').write_text('changed')\"",
        intent: "reproduce the reported regression before standard verification"
      }
    });
    const shellError = workflowCapabilityBoundaryGuard({
      profilePolicy: policy,
      workflowReadyStageControl: {
        stageId: "stage:verify",
        stageKind: "verify",
        requiredNextAction: "core.test.run"
      },
      capabilityId: "core.shell.run",
      toolName: "core.shell.run",
      toolInput: {
        command: "python -c \"from demo import reproduce; print(reproduce())\"",
        intent: "reproduce the reported regression before standard verification"
      }
    });

    assert.equal(writeError?.code, "WORKFLOW_STANDARD_TEST_REQUIRED");
    assert.equal(shellError?.code, "WORKFLOW_STANDARD_TEST_REQUIRED");
  });

  it("rejects mixed side-effect test tool commands before verify execution", () => {
    const error = workflowCapabilityBoundaryGuard({
      profilePolicy: verifyOnlyPolicy("core.test.run"),
      capabilityId: "core.test.run",
      toolName: "core.test.run",
      toolInput: { command: "git checkout astropy/modeling/separable.py && python -m pytest astropy/modeling/tests/test_separable.py -q" }
    });

    assert.equal(error?.code, "WORKFLOW_STANDARD_TEST_REQUIRED");
  });

  it("uses runtime ready-stage control when rejecting non-standard verify commands", () => {
    const policy = supervisorReadChangeVerifyPolicy();
    const error = workflowCapabilityBoundaryGuard({
      profilePolicy: policy,
      workflowReadyStageControl: {
        stageId: "stage:verify",
        stageKind: "verify",
        requiredNextAction: "core.test.run"
      },
      capabilityId: "core.test.run",
      toolName: "core.test.run",
      toolInput: { command: "python -c \"import inspect; print(inspect.getsource(object))\"" }
    });

    assert.equal(error?.code, "WORKFLOW_STANDARD_TEST_REQUIRED");
  });

  it("projects only standard verification after a non-standard verify command is rejected", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "verify target\n");
    const gateway = new SequentialToolCallModelGateway([
      {
        id: "call-non-standard-verify",
        name: "core.test.run",
        input: { command: "python -c \"import inspect; print(inspect.getsource(object))\"" }
      },
      {
        id: "call-standard-verify",
        name: "core.test.run",
        input: { command: "python -m pytest tests/test_demo.py" }
      }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "verify with exactly one standard test action after rejection",
      caller: "runtime.verify-standard-next-action.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorReadyVerifyPolicy(),
      limits: { maxModelIterations: 4, maxToolCalls: 4 }
    }));

    assert.deepEqual(providerToolNames(gateway.requests[1]), ["core_file_edit", "core_file_read", "core_git_diff", "core_test_run"]);
    const secondModelRequest = events.filter((event) => event.kind === "model.requested")[1];
    const secondProfilePolicy = secondModelRequest?.data.profilePolicy as {
      workflowGateOverride?: { requiredNextAction?: string };
    } | undefined;
    assert.equal(secondProfilePolicy?.workflowGateOverride?.requiredNextAction, "standard-test-command");
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.terminalKind === "workflow-capability-boundary.rejected" &&
      event.data.toolName === "core.test.run"
    ), true);
    await kernel.shutdown();
  });

  it("clears a standard-test gate after a standard test fails so repair tools are visible", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FailedTestFakePlatformRuntime() });
    await deps.platform.writeFile("/workspace/README.md", "verify repair target\n");
    const gateway = new SequentialToolCallModelGateway([
      {
        id: "call-non-standard-verify",
        name: "core.test.run",
        input: { command: "python -c \"import inspect; print(inspect.getsource(object))\"" }
      },
      {
        id: "call-standard-verify",
        name: "core.test.run",
        input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"] }
      },
      {
        id: "call-read-after-failed-test",
        name: "core.file.read",
        input: { path: "README.md", offset: 1, limit: 20 }
      }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "verify, inspect failed test evidence, then repair",
      caller: "runtime.verify-standard-gate-clear.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorReadyVerifyPolicy(),
      limits: { maxModelIterations: 5, maxToolCalls: 5 }
    }));

    assert.deepEqual(providerToolNames(gateway.requests[1]), ["core_file_edit", "core_file_read", "core_git_diff", "core_test_run"]);
    assert.equal(providerToolNames(gateway.requests[2]).includes("core_file_read"), true);
    const thirdModelRequest = events.filter((event) => event.kind === "model.requested")[2];
    const thirdProfilePolicy = thirdModelRequest?.data.profilePolicy as {
      workflowGateOverride?: { requiredNextAction?: string };
    } | undefined;
    assert.equal(
      thirdProfilePolicy?.workflowGateOverride?.requiredNextAction,
      "focused-read-or-source-edit-or-test-or-return-control"
    );
    await kernel.shutdown();
  });

  it("narrows failed standard-test repair after one focused evidence refresh", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FailedTestFakePlatformRuntime() });
    await deps.platform.writeFile("/workspace/README.md", "verify repair target\n");
    const gateway = new SequentialToolCallModelGateway([
      {
        id: "call-standard-verify",
        name: "core.test.run",
        input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"] }
      },
      {
        id: "call-read-after-failed-test",
        name: "core.file.read",
        input: { path: "README.md", offset: 0, limit: 20 }
      },
      {
        id: "call-repeat-read-after-refresh",
        name: "core.file.read",
        input: { path: "README.md", offset: 0, limit: 20 }
      }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "verify, refresh evidence once, then repair or retest",
      caller: "runtime.verify-standard-one-refresh.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorReadyVerifyPolicy(),
      limits: { maxModelIterations: 5, maxToolCalls: 5 }
    }));

    assert.deepEqual(providerToolNames(gateway.requests[1]), ["core_file_edit", "core_file_read", "core_git_diff", "core_patch_apply", "core_search_text", "core_test_run"]);
    assert.deepEqual(providerToolNames(gateway.requests[2]), ["core_file_edit", "core_file_read", "core_git_diff", "core_patch_apply", "core_test_run"]);
    const thirdModelRequest = events.filter((event) => event.kind === "model.requested")[2];
    const thirdProfilePolicy = thirdModelRequest?.data.profilePolicy as {
      workflowGateOverride?: { requiredNextAction?: string };
    } | undefined;
    assert.equal(
      thirdProfilePolicy?.workflowGateOverride?.requiredNextAction,
      "source-edit-or-test-or-bounded-blocker"
    );
    await kernel.shutdown();
  });

  it("routes failed source edits from standard-test repair into mutation repair", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FailedTestFakePlatformRuntime() });
    await deps.platform.writeFile("/workspace/README.md", "verify repair target\n");
    const gateway = new SequentialToolCallModelGateway([
      {
        id: "call-standard-verify",
        name: "core.test.run",
        input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"] }
      },
      {
        id: "call-read-after-failed-test",
        name: "core.file.read",
        input: { path: "README.md", offset: 0, limit: 20 }
      },
      {
        id: "call-stale-repair-edit",
        name: "core.file.edit",
        input: { path: "README.md", expected: "missing repair target", replacement: "fixed repair target" }
      },
      {
        id: "call-repeat-read-after-edit-failure",
        name: "core.file.read",
        input: { path: "README.md", offset: 0, limit: 20 }
      }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "verify, refresh evidence, then repair failed edit",
      caller: "runtime.verify-standard-edit-failure-repair.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorReadyVerifyPolicy(),
      limits: { maxModelIterations: 6, maxToolCalls: 6 }
    }));

    assert.deepEqual(providerToolNames(gateway.requests[2]), ["core_file_edit", "core_file_read", "core_git_diff", "core_patch_apply", "core_test_run"]);
    assert.deepEqual(providerToolNames(gateway.requests[3]), ["core_file_edit", "core_file_read", "core_git_diff", "core_patch_apply", "core_test_run"]);
    const fourthModelRequest = events.filter((event) => event.kind === "model.requested")[3];
    const fourthProfilePolicy = fourthModelRequest?.data.profilePolicy as {
      workflowGateOverride?: { requiredNextAction?: string; terminalKind?: string };
    } | undefined;
    assert.equal(fourthProfilePolicy?.workflowGateOverride?.terminalKind, "workflow-mutation-repair.required");
    assert.equal(fourthProfilePolicy?.workflowGateOverride?.requiredNextAction, "core.patch.apply|core.file.edit");
    const staleEditMiss = events.find((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.requestedCapabilityId === "core.file.edit"
    );
    assert.notEqual(
      staleEditMiss?.data.requiredNextAction,
      "core.test.run",
      "failed source edits allowed by a repair gate must not be attributed to the verify-stage test action"
    );
    await kernel.shutdown();
  });

  it("returns to standard verification after a successful standard-test repair edit", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FailedTestFakePlatformRuntime() });
    await deps.platform.writeFile("/workspace/README.md", "verify repair target\n");
    const gateway = new SequentialToolCallModelGateway([
      {
        id: "call-standard-verify",
        name: "core.test.run",
        input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"] }
      },
      {
        id: "call-read-after-failed-test",
        name: "core.file.read",
        input: { path: "README.md", offset: 0, limit: 20 }
      },
      {
        id: "call-stale-repair-edit",
        name: "core.file.edit",
        input: { path: "README.md", expected: "missing repair target", replacement: "fixed repair target" }
      },
      {
        id: "call-fresh-repair-edit",
        name: "core.file.edit",
        input: { path: "README.md", expected: "verify repair target", replacement: "fixed repair target" }
      },
      {
        id: "call-standard-verify-after-repair",
        name: "core.test.run",
        input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"] }
      }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "verify, refresh evidence, repair a failed edit, then verify again",
      caller: "runtime.verify-standard-repair-success-returns-to-test.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: supervisorReadyVerifyPolicy(),
      limits: { maxModelIterations: 8, maxToolCalls: 8 }
    }));

    assert.deepEqual(providerToolNames(gateway.requests[4]), ["core_file_edit", "core_file_read", "core_git_diff", "core_test_run"]);
    const fifthModelRequest = events.filter((event) => event.kind === "model.requested")[4];
    const fifthProfilePolicy = fifthModelRequest?.data.profilePolicy as {
      workflowGateOverride?: { requiredNextAction?: string; terminalKind?: string };
    } | undefined;
    assert.equal(fifthProfilePolicy?.workflowGateOverride?.requiredNextAction, "standard-test-command");
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "fixed repair target\n");
    await kernel.shutdown();
  });

  it("does not advance a verify stage from git diff shell commands", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-git-diff", name: "core.shell.run", input: { command: "git", args: ["diff", "astropy/modeling/separable.py"] } },
      { id: "call-standard-test", name: "core.test.run", input: { command: "python -m pytest tests/test_demo.py" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "verify with git diff before standard test",
      caller: "runtime.verify-git-diff-shell.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: verifyOnlyPolicy("core.shell.run"),
      limits: { maxModelIterations: 3, maxToolCalls: 4 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "workflow.step" &&
      event.data.stageId === "stage:verify" &&
      (event.data.status === "evaluation-required" || event.data.status === "succeeded") &&
      event.data.toolCallId === "call-git-diff"
    ), false);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.intent" &&
      event.data.toolCallId === "call-standard-test" &&
      event.data.name === "core.test.run"
    ), true);
    await kernel.shutdown();
  });

  it("emits a rejected feedback DTO when the tool-call limit is exceeded", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "limit test\n");
    const loopDeps = { ...deps, models: new LoopingToolCallModelGateway("core.file.read", { path: "README.md" }) };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "looping tool",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxToolCalls: 1, maxModelIterations: 3 }
    }));

    const rejectedEvent = events.find((event) => event.kind === "model.tool.rejected" && (event.data as JsonObject).reason === "tool-call-limit");
    assert.ok(rejectedEvent, "tool-call-limit rejection event is expected");
    const feedback = (rejectedEvent!.data as { feedback?: ToolResultFeedback }).feedback;
    assert.ok(feedback, "tool-call-limit rejection must include a typed feedback record");
    assert.equal(feedback.status, "rejected");
    assert.equal(feedback.continuation, "terminate");
    assert.equal(events.at(-1)?.kind, "agent.loop.failed");
    await kernel.shutdown();
  });

  it("projects only read-only tools to the model when live=true is set", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "projection\n");
    const recorder = new ToolSchemaRecordingGateway();
    const loopDeps = { ...deps, models: recorder };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "tell me a file",
      caller: "runtime.projection.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      live: true,
      limits: { maxModelIterations: 1 }
    }));

    const sideEffects = new Set(recorder.observedSideEffects);
    assert.equal(sideEffects.has("read"), true);
    assert.equal(sideEffects.has("write"), false);
    assert.equal(sideEffects.has("process"), false);
    assert.equal(sideEffects.has("network"), false);
    await kernel.shutdown();
  });

  it("projects Tier 1 tools but not external connectors when toolProjection is explicitly set to safe-all", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const recorder = new ToolSchemaRecordingGateway();
    const loopDeps = { ...deps, models: recorder };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "anything",
      caller: "runtime.projection.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      live: true,
      toolProjection: "safe-all",
      limits: { maxModelIterations: 1 }
    }));

    const sideEffects = new Set(recorder.observedSideEffects);
    assert.equal(sideEffects.has("write"), true);
    assert.equal(sideEffects.has("process"), true);
    assert.equal(sideEffects.has("network"), false);
    assert.equal(recorder.observedToolNames.includes("core.web.search"), false);
    await kernel.shutdown();
  });

  it("projects network tools only when the runtime request explicitly opts into network tools", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const recorder = new ToolSchemaRecordingGateway();
    const loopDeps = { ...deps, models: recorder };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "fetch public documentation",
      caller: "runtime.projection.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      live: true,
      toolProjection: "safe-all",
      toolOptIns: ["network"],
      limits: { maxModelIterations: 1 }
    }));

    const sideEffects = new Set(recorder.observedSideEffects);
    assert.equal(sideEffects.has("network"), true);
    assert.equal(recorder.observedToolNames.includes("core_web_fetch"), true);
    await kernel.shutdown();
  });

  it("keeps arbitrary shell execution out of default read-write projection", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const recorder = new ToolSchemaRecordingGateway();
    const loopDeps = { ...deps, models: recorder };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "inspect and verify the fixture",
      caller: "runtime.projection.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      live: true,
      toolProjection: "read-write",
      limits: { maxModelIterations: 1 }
    }));

    assert.equal(recorder.observedToolNames.includes("core_shell_run"), false);
    assert.equal(recorder.observedToolNames.includes("core_test_run"), true);
    assert.equal(recorder.observedToolNames.includes("core_web_search"), false);
    await kernel.shutdown();
  });

  it("projects no tools when toolProjection is explicitly set to none", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const recorder = new ToolSchemaRecordingGateway();
    const loopDeps = { ...deps, models: recorder };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "return a command plan as plain JSON",
      caller: "runtime.projection.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      live: true,
      toolProjection: "none",
      limits: { maxModelIterations: 1 }
    }));

    assert.deepEqual(recorder.observedToolNames, []);
    assert.deepEqual(recorder.observedSideEffects, []);
    await kernel.shutdown();
  });

  it("continues the model loop after a denied tool feedback instead of terminating", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "deny\n");
    const loopDeps = { ...deps, models: new SingleToolCallModelGateway("core.file.read", { path: "README.md" }), policy: new DenyAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "retry please",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const feedback = readFeedback(events);
    assert.ok(feedback);
    assert.equal(feedback.status, "denied");
    assert.equal(feedback.continuation, "continue");
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    await kernel.shutdown();
  });

  it("suppresses repeated identical rejected tool intents through the decision board", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const loopDeps = { ...deps, models: new RepeatingRejectedToolCallGateway("core.file.read", { path: "../outside.txt" }) };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "keep trying the same bad read",
      caller: "runtime.decision-board.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 4, maxToolCalls: 6 }
    }));

    const snapshots = events.filter((event) => event.kind === "tool.decision-board.snapshot");
    assert.equal(snapshots.length >= 2, true);
    const suppressed = events.find((event) => event.kind === "model.tool.result" && (event.data as JsonObject).terminalKind === "decision-loop.rejected");
    assert.ok(suppressed, "third repeated rejected intent should be suppressed by decision board");
    const feedback = (suppressed.data as { feedback?: ToolResultFeedback }).feedback;
    assert.equal(feedback?.status, "rejected");
    assert.match(feedback?.preview.text ?? "", /different projected tool|corrected input|blocker/i);
    const board = (suppressed.data as JsonObject).decisionBoard as JsonObject | undefined;
    assert.equal(board?.decisionLoopFailureCandidate, true);
    assert.equal(board?.repeatedRejectedIntentCount, 3);
    await kernel.shutdown();
  });

  it("feeds bounded decision board guidance into the next model request after a rejection", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new RecordingSingleToolCallModelGateway("core.file.read", { path: "../outside.txt" });
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "try an unsafe read and recover",
      caller: "runtime.decision-board.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 2 }
    }));

    const secondRequest = gateway.requests[1];
    assert.ok(secondRequest, "second model request should include feedback after rejected tool call");
    const boardMessage = secondRequest.messages?.find((message) => message.role === "system" && message.content.includes("Tool decision board summary:"));
    assert.ok(boardMessage, "decision-board summary should be injected into dynamic prompt state");
    assert.match(boardMessage.content, /preflight\.rejected core\.file\.read -> corrected input or different projected tool/);
    assert.equal(boardMessage.cacheHint?.policy, "ephemeral");
    await kernel.shutdown();
  });

  it("records dispatch planning metadata on the decision board after a tool intent", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "dispatch metadata\n");
    const loopDeps = { ...deps, models: new OneToolThenFinishModelGateway("core.file.read", { path: "README.md" }) };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "read readme",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const snapshot = lastMatchingEvent(events, "tool.decision-board.snapshot");
    assert.ok(snapshot, "dispatch planning should be reflected in the decision board snapshot");
    const records = (snapshot.data as JsonObject).records as readonly JsonObject[] | undefined;
    const intentRecord = records?.find((record) => record.kind === "intent" && record.toolName === "core.file.read");
    assert.ok(intentRecord, "tool intent record should be present");
    const metadata = intentRecord.metadata as JsonObject | undefined;
    const dispatch = metadata?.dispatch as JsonObject | undefined;
    assert.equal(dispatch?.itemCount, 1);
    assert.equal(dispatch?.executionMode, "serial");
    assert.equal(dispatch?.sideEffect, "read");
    await kernel.shutdown();
  });

  it("explains visible, hidden, denied, and unavailable projection reasons in board snapshots", () => {
    const state = createToolDecisionBoardState({ sessionId: asId<"session">("session-projection"), turnId: asId<"turn">("turn-projection") });
    const availableCapabilities = [
      manifest("core.file.read", "read", []),
      manifest("core.file.edit", "write", []),
      manifest("core.web.search", "network", ["network"]),
      manifest("core.shell.run", "process", ["process:run"])
    ];
    const snapshot = toolDecisionBoardSnapshot({
      state,
      iteration: 1,
      activeProfileId: "engineering/coding.v1",
      activeStageId: "change",
      availableCapabilities,
      visibleCapabilities: [availableCapabilities[1]!],
      profilePolicy: {
        profileId: "engineering/coding.v1",
        toolProjectionSource: "software-engineer-profile",
        workflowCapabilityIds: ["core.file.edit", "core.test.run"],
        missingCapabilityIds: ["core.test.run"],
        deniedCapabilityIds: ["core.shell.run"],
        requiredStageCapabilityIds: ["core.file.edit", "core.test.run"]
      }
    });

    const summaries = snapshot.projectionSummaries;
    assert.ok(summaries, "projection summaries should include every decision category");
    assert.ok(summaries.find((entry) =>
      entry.capabilityId === "core.file.edit"
      && entry.status === "visible"
      && entry.reasonCode === "stage-required-visible"
      && entry.policySource === "software-engineer-profile"
      && entry.stageId === "change"
    ));
    assert.ok(summaries.find((entry) =>
      entry.capabilityId === "core.file.read"
      && entry.status === "hidden"
      && entry.reasonCode === "stage-boundary"
    ));
    assert.ok(summaries.find((entry) =>
      entry.capabilityId === "core.web.search"
      && entry.status === "hidden"
      && entry.reasonCode === "explicit-host-opt-in-required"
    ));
    assert.ok(summaries.find((entry) =>
      entry.capabilityId === "core.shell.run"
      && entry.status === "denied"
      && entry.reasonCode === "profile-denied"
    ));
    assert.ok(summaries.find((entry) =>
      entry.capabilityId === "core.test.run"
      && entry.status === "unavailable"
      && entry.reasonCode === "workflow-capability-unregistered"
    ));
    assert.equal((snapshot.counters as JsonObject).unavailableToolCount, 1);
    assert.equal((snapshot.counters as JsonObject).deniedToolCount, 1);
  });

  it("recommends a next action even before any rejected tool feedback exists", () => {
    const state = createToolDecisionBoardState({ sessionId: asId<"session">("session-next-action"), turnId: asId<"turn">("turn-next-action") });
    const visible = manifest("core.test.run", "process", ["process:run"]);
    const snapshot = toolDecisionBoardSnapshot({
      state,
      iteration: 1,
      activeProfileId: "engineering/coding.v1",
      activeStageId: "stage:verify",
      availableCapabilities: [visible],
      visibleCapabilities: [visible],
      profilePolicy: {
        profileId: "engineering/coding.v1",
        toolProjectionSource: "software-engineer-profile",
        requiredStageCapabilityIds: ["core.test.run"]
      }
    });

    assert.equal(snapshot.recommendedNextActions.length, 1);
    assert.match(snapshot.recommendedNextActions[0] ?? "", /core\.test\.run/);
    assert.match(snapshot.recommendedNextActions[0] ?? "", /stage:verify/);
  });

  it("shares parent and child scheduling evidence without merging model context", () => {
    const state = createToolDecisionBoardState({
      sessionId: asId<"session">("session-parent-board"),
      turnId: asId<"turn">("turn-parent-board")
    });

    recordSharedBoardLineage(state, {
      parentRunId: "agent-run:parent",
      childRunId: "agent-run:child",
      attemptId: "attempt:1",
      stageId: "stage:change",
      dispatchBatchId: "dispatch:batch-1",
      toolCallId: "tool-call:edit",
      terminalEventId: "event:terminal",
      evidenceRefs: ["evidence:accepted-edit"],
      nextAllowedAction: "verify"
    });

    const snapshot = toolDecisionBoardSnapshot({
      state,
      iteration: 2,
      activeProfileId: "engineering/coding.v1",
      activeStageId: "stage:change",
      availableCapabilities: [],
      visibleCapabilities: []
    });
    const shared = snapshot.sharedSchedulingEvidence;

    assert.equal(shared.lineageIds.length, 1);
    assert.equal(shared.lineageIds[0]?.parentRunId, "agent-run:parent");
    assert.equal(shared.lineageIds[0]?.childRunId, "agent-run:child");
    assert.deepEqual(shared.acceptedEvidenceRefs, ["evidence:accepted-edit"]);
    assert.equal(shared.nextAllowedAction, "verify");
    assert.equal(JSON.stringify(snapshot).includes("provider history"), false);
    assert.equal(JSON.stringify(snapshot).includes("raw reasoning"), false);
    assert.equal(JSON.stringify(snapshot).includes("unredacted child context"), false);
  });

  it("requires proven failure analysis before model-owned attribution or rerun", () => {
    const state = createToolDecisionBoardState({
      sessionId: asId<"session">("session-failure-analysis"),
      turnId: asId<"turn">("turn-failure-analysis")
    });

    const unproven = recordFailureAnalysis(state, {
      attemptId: "attempt:source-only",
      stageId: "stage:understand",
      terminalKind: "agent.loop.budget.consumed",
      failureClass: "empty-required-artifact",
      attribution: "model-owned",
      proofStatus: "unproven",
      evidenceQueries: ["exclude framework scheduling", "exclude tool availability", "exclude environment"],
      acceptedEvidenceRefs: ["evidence:source-inspection-only"],
      nextAllowedAction: "rerun"
    });

    assert.equal(unproven.rerunAllowed, false);
    assert.equal(unproven.modelOwnedAttributionAllowed, false);
    assert.equal(unproven.nextAllowedAction, "search-evidence");

    const proven = recordFailureAnalysis(state, {
      attemptId: "attempt:source-only",
      stageId: "stage:change",
      terminalKind: "agent.loop.budget.consumed",
      failureClass: "non-progress-after-source-inspection",
      attribution: "framework-scheduling",
      proofStatus: "proven",
      evidenceQueries: ["source inspection count", "mutation count", "test count"],
      acceptedEvidenceRefs: ["evidence:48-source-inspections", "evidence:0-mutations", "evidence:0-tests"],
      nextAllowedAction: "repair"
    });

    const snapshot = toolDecisionBoardSnapshot({
      state,
      iteration: 3,
      activeProfileId: "engineering/coding.v1",
      activeStageId: "stage:change",
      availableCapabilities: [],
      visibleCapabilities: []
    });

    assert.equal(proven.rerunAllowed, false);
    assert.equal(proven.nextAllowedAction, "repair");
    assert.equal(snapshot.sharedSchedulingEvidence.failureAnalysisRecords.length, 2);
    assert.equal(snapshot.sharedSchedulingEvidence.nextAllowedAction, "repair");
    assert.deepEqual(snapshot.sharedSchedulingEvidence.acceptedEvidenceRefs, [
      "evidence:source-inspection-only",
      "evidence:48-source-inspections",
      "evidence:0-mutations",
      "evidence:0-tests"
    ]);
  });

  it("records failure analysis on the decision board when the model iteration limit is reached", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const loopDeps = { ...deps, models: new RepeatingReadToolCallGateway() };
    await loopDeps.platform.writeFile("/workspace/README.md", "repeat read\n");
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "keep thinking without progress",
      caller: "runtime.failure-analysis.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 2 }
    }));

    const finalSnapshot = lastMatchingEvent(events, "tool.decision-board.snapshot");
    const shared = (finalSnapshot?.data as JsonObject | undefined)?.sharedSchedulingEvidence as JsonObject | undefined;
    const records = shared?.failureAnalysisRecords as readonly JsonObject[] | undefined;
    const failed = lastMatchingEvent(events, "agent.loop.failed");

    assert.equal(failed?.data.reason, "model-iteration-limit");
    assert.ok(records?.some((record) =>
      record.terminalKind === "model-iteration-limit"
      && record.attribution === "framework-scheduling"
      && record.nextAllowedAction === "repair"
    ), "iteration-limit failure should be classified on the shared board before terminal close");
    assert.equal(shared?.nextAllowedAction, "repair");
    await kernel.shutdown();
  });

  it("projects tool manifest names through the OpenAI-safe pattern while keeping capability ids on kernel events", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "safe names\n");
    const recorder = new ToolSchemaRecordingGateway();
    const loopDeps = { ...deps, models: recorder };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "observe tool schema",
      caller: "runtime.safe-name.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      live: true,
      limits: { maxModelIterations: 1 }
    }));

    for (const name of recorder.observedToolNames) {
      assert.match(name, /^[A-Za-z0-9_-]+$/, `tool name ${name} must match OpenAI pattern`);
    }
    assert.equal(recorder.observedToolNames.includes("core_file_read"), true);
    assert.equal(recorder.observedToolNames.includes("core.file.read"), false);
    await kernel.shutdown();
  });

  it("resolves a sanitized tool-call name returned by the provider back to the real capability id", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "resolve back\n");
    const loopDeps = { ...deps, models: new SingleToolCallModelGateway("core_file_read", { path: "README.md" }) };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "sanitized name",
      caller: "runtime.safe-name.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const intent = events.find((event) => event.kind === "model.tool.intent");
    assert.equal((intent?.data as JsonObject).name, "core.file.read");
    const feedback = readFeedback(events);
    assert.equal(feedback?.status, "success");
    await kernel.shutdown();
  });

  it("keeps the provider-returned tool name in continuation history", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "provider name\n");
    const gateway = new RecordingSingleToolCallModelGateway("core_file_read", { path: "README.md" });
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "provider safe name",
      caller: "runtime.safe-name.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const intent = events.find((event) => event.kind === "model.tool.intent");
    const assistant = gateway.requests[1]?.messages?.find((message) => message.role === "assistant");
    assert.equal((intent?.data as JsonObject).name, "core.file.read");
    assert.equal(assistant?.toolCalls?.[0]?.name, "core_file_read");
    assert.equal(readFeedback(events)?.status, "success");
    await kernel.shutdown();
  });

  it("resolves mixed separator tool-call names returned by the provider back to the real capability id", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "mixed separator name\n");
    const loopDeps = { ...deps, models: new SingleToolCallModelGateway("core.file_read", { path: "README.md" }) };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "mixed separator name",
      caller: "runtime.safe-name.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const intent = events.find((event) => event.kind === "model.tool.intent");
    assert.equal((intent?.data as JsonObject).name, "core.file.read");
    const feedback = readFeedback(events);
    assert.equal(feedback?.status, "success");
    await kernel.shutdown();
  });
});

function readFeedback(events: readonly RuntimeEvent[]): ToolResultFeedback | undefined {
  const resultEvent = events.find((event) => event.kind === "model.tool.result");
  return resultEvent ? (resultEvent.data as { feedback?: ToolResultFeedback }).feedback : undefined;
}

function toolDispatchItem(
  toolCallId: string,
  resolvedCapabilityId: string,
  sideEffect: "none" | "read" | "write" | "network" | "process",
  iteration: number
): {
  readonly toolCallId: string;
  readonly providerToolName: string;
  readonly resolvedCapabilityId: string;
  readonly normalizedInputHash: string;
  readonly input: JsonObject;
  readonly sideEffect: "none" | "read" | "write" | "network" | "process";
  readonly iteration: number;
} {
  return {
    toolCallId,
    providerToolName: resolvedCapabilityId,
    resolvedCapabilityId,
    normalizedInputHash: `${toolCallId}:${resolvedCapabilityId}`,
    input: { toolCallId, resolvedCapabilityId },
    sideEffect,
    iteration
  };
}

function lastMatchingEvent(events: readonly RuntimeEvent[], kind: RuntimeEvent["kind"]): RuntimeEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === kind) return event;
  }
  return undefined;
}

function assertProviderToolCallsArePaired(messages: NonNullable<ModelRequest["messages"]>): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || !message.toolCalls?.length) continue;
    const expectedIds = message.toolCalls.map((call) => call.id);
    const following = messages.slice(index + 1, index + 1 + expectedIds.length);
    assert.deepEqual(
      following.map((candidate) => candidate?.role),
      expectedIds.map(() => "tool"),
      "assistant tool calls must be followed immediately by tool results"
    );
    assert.deepEqual(
      following.map((candidate) => candidate?.toolCallId),
      expectedIds,
      "tool result ids must match the assistant tool calls"
    );
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function manifest(
  id: string,
  sideEffect: "none" | "read" | "write" | "network" | "process" = "read",
  permissions: readonly string[] = []
): CapabilityManifest {
  if (id === "core.test.run") {
    const testRun = coreToolManifests().find((tool) => String(tool.id) === "core.test.run");
    if (testRun) return testRun;
  }
  return {
    id: id as CapabilityManifest["id"],
    name: id,
    source: "runtime-test",
    version: "1.0.0",
    trust: "trusted",
    sideEffect,
    permissions,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    enabled: true,
    projection: { modelAliases: [id.split(".").at(-1) ?? id] }
  };
}

function supervisorReadThenChangePolicy(): AgentLoopProfilePolicyMetadata {
  return {
    schemaVersion: "1.0.0" as const,
    profileId: "test/supervisor-stage-budget.v1",
    role: "evaluation-workflow",
    workflowGraphId: "workflow/test.supervisor-stage-budget.v1",
    workflowPriority: "primary" as const,
    orchestrationMode: "staged-capability-workflow" as const,
    workflowCapabilityIds: ["core.file.read", "core.file.edit"],
    toolProjectionSource: "profile",
    stageAcceptanceMode: "supervisor" as const,
    antiTailoring: true,
    executionBoundary: "governed-capabilities",
    redaction: { class: "internal" as const },
    stagedTaskWorkflow: {
      schemaVersion: "1.0.0" as const,
      profileId: "test/supervisor-stage-budget.v1",
      graphId: "graph:test.supervisor-stage-budget",
      fingerprint: "fnv1a:supervisor-stage-budget",
      stageCount: 2,
      refCount: 2,
      executorKinds: ["agent-loop"],
      graph: {
        schemaVersion: "1.0.0" as const,
        graphId: "graph:test.supervisor-stage-budget",
        profileId: "test/supervisor-stage-budget.v1",
        stages: [
          {
            schemaVersion: "1.0.0" as const,
            stageId: "stage:understand",
            kind: "collect-evidence",
            executorKind: "agent-loop",
            dependsOn: [],
            inputRefs: [],
            expectedOutputRefs: ["ref:understand"],
            allowedTools: ["core.file.read"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" as const }
          },
          {
            schemaVersion: "1.0.0" as const,
            stageId: "stage:change",
            kind: "produce",
            executorKind: "agent-loop",
            dependsOn: ["stage:understand"],
            inputRefs: ["ref:understand"],
            expectedOutputRefs: ["ref:change"],
            allowedTools: ["core.file.edit"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" as const }
          }
        ],
        refs: [
          {
            schemaVersion: "1.0.0" as const,
            refId: "ref:understand",
            type: "evidence",
            producerStageId: "stage:understand",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" as const }
          },
          {
            schemaVersion: "1.0.0" as const,
            refId: "ref:change",
            type: "artifact",
            producerStageId: "stage:change",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" as const }
          }
        ],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" as const }
      },
      runState: {
        schemaVersion: "1.0.0" as const,
        taskRunId: "staged:graph:test.supervisor-stage-budget",
        graphId: "graph:test.supervisor-stage-budget",
        profileId: "test/supervisor-stage-budget.v1",
        stageStates: [
          {
            stageId: "stage:understand",
            status: "ready",
            attempts: 0,
            inputRefs: [],
            outputRefs: [],
            diagnostics: []
          },
          {
            stageId: "stage:change",
            status: "pending",
            attempts: 0,
            inputRefs: ["ref:understand"],
            outputRefs: [],
            diagnostics: []
          }
        ],
        refs: [],
        events: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" as const }
      },
      redaction: { class: "internal" as const }
    }
  };
}

function workflowMutationStageProfilePolicy(): AgentLoopProfilePolicyMetadata {
  const policy = supervisorReadThenChangePolicy();
  const workflow = policy.stagedTaskWorkflow;
  assert.ok(workflow);
  return {
    ...policy,
    workflowCapabilityIds: ["core.file.read", "core.workspace.glob", "core.file.edit", "core.test.run"],
    stageAcceptanceMode: "automatic",
    stagedTaskWorkflow: {
      ...workflow,
      graph: {
        ...workflow.graph,
        stages: workflow.graph.stages.map((stage) =>
          stage.stageId === "stage:change"
            ? { ...stage, allowedTools: ["core.file.read", "core.file.edit"] }
            : stage
        )
      },
      runState: {
        ...workflow.runState,
        stageStates: workflow.runState.stageStates.map((stage) =>
          stage.stageId === "stage:understand"
            ? { ...stage, status: "succeeded" as const, outputRefs: ["ref:understand"] }
            : stage.stageId === "stage:change"
              ? { ...stage, status: "ready" as const }
              : stage
        )
      }
    }
  };
}

function supervisorRootListThenChangePolicy(): AgentLoopProfilePolicyMetadata {
  const policy = supervisorReadThenChangePolicy();
  const workflow = policy.stagedTaskWorkflow;
  if (!workflow) return policy;
  return {
    ...policy,
    workflowCapabilityIds: ["core.file.read", "core.file.list", "core.file.edit"],
    stagedTaskWorkflow: {
      ...workflow,
      graph: {
        ...workflow.graph,
        stages: workflow.graph.stages.map((stage) =>
          stage.stageId === "stage:understand"
            ? { ...stage, allowedTools: ["core.file.read", "core.file.list"] }
            : stage
        )
      }
    }
  };
}

function evaluationHeaderSensitiveReadThenChangePolicy(): AgentLoopProfilePolicyMetadata {
  const policy = supervisorRootListThenChangePolicy();
  const workflow = policy.stagedTaskWorkflow;
  if (!workflow) return policy;
  return {
    ...policy,
    profileId: "evaluation/swe-bench-lite.child.v1",
    workflowGraphId: "workflow/evaluation.swe-bench-lite.child.v1",
    stagedTaskWorkflow: {
      ...workflow,
      profileId: "evaluation/swe-bench-lite.child.v1",
      graphId: "workflow/evaluation.swe-bench-lite.child.v1",
      graph: {
        ...workflow.graph,
        profileId: "evaluation/swe-bench-lite.child.v1",
        graphId: "workflow/evaluation.swe-bench-lite.child.v1",
        stages: workflow.graph.stages.map((stage) =>
          stage.stageId === "stage:understand"
            ? {
                ...stage,
                parameters: {
                  ...(stage.parameters ?? {}),
                  requireNonHeaderSourceWindow: true
                }
              }
            : stage
        )
      }
    }
  };
}

function supervisorDiscoveryThenChangePolicy(): AgentLoopProfilePolicyMetadata {
  const policy = supervisorReadThenChangePolicy();
  const workflow = policy.stagedTaskWorkflow;
  if (!workflow) return policy;
  return {
    ...policy,
    workflowCapabilityIds: ["core.file.read", "core.file.list", "core.search.text", "core.workspace.glob", "core.file.edit"],
    stagedTaskWorkflow: {
      ...workflow,
      graph: {
        ...workflow.graph,
        stages: workflow.graph.stages.map((stage) =>
          stage.stageId === "stage:understand"
            ? { ...stage, allowedTools: ["core.file.read", "core.file.list", "core.search.text", "core.workspace.glob"] }
            : stage
        )
      }
    }
  };
}

function completedCapabilityEvent(metadata: JsonObject = {}, preview?: JsonObject): RuntimeEvent {
  return {
    kind: "capability.completed",
    data: {
      output: {
        evidence: {
          status: "completed",
          ...(preview ? { preview } : {}),
          metadata
        }
      }
    }
  } as unknown as RuntimeEvent;
}

function supervisorReadChangeVerifyPolicy(): AgentLoopProfilePolicyMetadata {
  const policy = supervisorReadThenChangePolicy();
  const workflow = policy.stagedTaskWorkflow;
  if (!workflow) return policy;
  return {
    ...policy,
    workflowCapabilityIds: ["core.file.read", "core.file.edit", "core.test.run", "core.git.diff"],
    stagedTaskWorkflow: {
      ...workflow,
      stageCount: 3,
      refCount: 3,
      graph: {
        ...workflow.graph,
        stages: [
          ...workflow.graph.stages,
          {
            schemaVersion: "1.0.0" as const,
            stageId: "stage:verify",
            kind: "verify",
            executorKind: "agent-loop",
            dependsOn: ["stage:change"],
            inputRefs: ["ref:change"],
            expectedOutputRefs: ["ref:verify"],
            allowedTools: ["core.test.run", "core.git.diff"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" as const }
          }
        ],
        refs: [
          ...workflow.graph.refs,
          {
            schemaVersion: "1.0.0" as const,
            refId: "ref:verify",
            type: "check",
            producerStageId: "stage:verify",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" as const }
          }
        ]
      },
      runState: {
        ...workflow.runState,
        stageStates: [
          ...workflow.runState.stageStates,
          {
            stageId: "stage:verify",
            status: "pending",
            attempts: 0,
            inputRefs: ["ref:change"],
            outputRefs: [],
            diagnostics: []
          }
        ]
      }
    }
  };
}

function supervisorReadyVerifyPolicy(): AgentLoopProfilePolicyMetadata {
  const policy = supervisorReadChangeVerifyPolicy();
  const workflow = policy.stagedTaskWorkflow;
  if (!workflow) return policy;
  return {
    ...policy,
    stagedTaskWorkflow: {
      ...workflow,
      runState: {
        ...workflow.runState,
        refs: [
          ...(workflow.runState.refs ?? []),
          {
            schemaVersion: "1.0.0" as const,
            refId: "ref:understand",
            type: "evidence",
            producerStageId: "stage:understand",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" as const }
          },
          {
            schemaVersion: "1.0.0" as const,
            refId: "ref:change",
            type: "artifact",
            producerStageId: "stage:change",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" as const }
          }
        ],
        stageStates: workflow.runState.stageStates.map((stage) => {
          if (stage.stageId === "stage:understand") {
            return {
              ...stage,
              status: "succeeded" as const,
              outputRefs: ["ref:understand"],
              evaluation: {
                schemaVersion: "1.0.0" as const,
                evaluationId: "evaluation:stage:understand:test-passed",
                stageId: "stage:understand",
                evaluatorId: "runtime:test",
                status: "passed" as const,
                score: 1,
                reason: "Test fixture marks prior stage accepted.",
                evidenceRefs: ["ref:understand"],
                evaluatedAt: "2026-07-08T00:00:00.000Z",
                compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
                redaction: { class: "internal" as const }
              }
            };
          }
          if (stage.stageId === "stage:change") {
            return {
              ...stage,
              status: "succeeded" as const,
              inputRefs: ["ref:understand"],
              outputRefs: ["ref:change"],
              evaluation: {
                schemaVersion: "1.0.0" as const,
                evaluationId: "evaluation:stage:change:test-passed",
                stageId: "stage:change",
                evaluatorId: "runtime:test",
                status: "passed" as const,
                score: 1,
                reason: "Test fixture marks prior stage accepted.",
                evidenceRefs: ["ref:change"],
                evaluatedAt: "2026-07-08T00:00:00.000Z",
                compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
                redaction: { class: "internal" as const }
              }
            };
          }
          if (stage.stageId === "stage:verify") {
            return {
              ...stage,
              status: "ready" as const,
              inputRefs: ["ref:change"],
              outputRefs: []
            };
          }
          return stage;
        })
      }
    }
  };
}

function supervisorReadyVerifyThenScorePolicy(): AgentLoopProfilePolicyMetadata {
  const policy = supervisorReadyVerifyPolicy();
  const workflow = policy.stagedTaskWorkflow;
  if (!workflow) return policy;
  return {
    ...policy,
    workflowCapabilityIds: ["core.file.read", "core.file.edit", "core.test.run", "core.swe.harness.run"],
    stagedTaskWorkflow: {
      ...workflow,
      stageCount: 4,
      refCount: 4,
      graph: {
        ...workflow.graph,
        stages: [
          ...workflow.graph.stages,
          {
            schemaVersion: "1.0.0" as const,
            stageId: "stage:score",
            kind: "produce",
            executorKind: "agent-loop",
            dependsOn: ["stage:verify"],
            inputRefs: ["ref:verify"],
            expectedOutputRefs: ["ref:score"],
            allowedTools: ["core.swe.harness.run"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" as const }
          }
        ],
        refs: [
          ...workflow.graph.refs,
          {
            schemaVersion: "1.0.0" as const,
            refId: "ref:score",
            type: "check",
            producerStageId: "stage:score",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" as const }
          }
        ]
      },
      runState: {
        ...workflow.runState,
        stageStates: [
          ...workflow.runState.stageStates,
          {
            stageId: "stage:score",
            status: "pending",
            attempts: 0,
            inputRefs: ["ref:verify"],
            outputRefs: [],
            diagnostics: []
          }
        ]
      }
    }
  };
}

function supervisorScoreReadyAfterLocalVerificationPolicy(): AgentLoopProfilePolicyMetadata {
  const policy = supervisorReadyVerifyThenScorePolicy();
  const workflow = policy.stagedTaskWorkflow;
  if (!workflow) return policy;
  return {
    ...policy,
    stagedTaskWorkflow: {
      ...workflow,
      runState: {
        ...workflow.runState,
        refs: [
          ...(workflow.runState.refs ?? []),
          {
            schemaVersion: "1.0.0" as const,
            refId: "ref:verify",
            type: "check",
            producerStageId: "stage:verify",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" as const }
          }
        ],
        stageStates: workflow.runState.stageStates.map((stage) => {
          if (stage.stageId === "stage:verify") {
            return {
              ...stage,
              status: "succeeded" as const,
              inputRefs: ["ref:change"],
              outputRefs: ["ref:verify"],
              evaluation: {
                schemaVersion: "1.0.0" as const,
                evaluationId: "evaluation:stage:verify:test-passed",
                stageId: "stage:verify",
                evaluatorId: "runtime:test",
                status: "passed" as const,
                score: 1,
                reason: "Local verification passed and should return to the harness.",
                evidenceRefs: ["ref:verify"],
                evaluatedAt: "2026-07-08T00:00:00.000Z",
                compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
                redaction: { class: "internal" as const }
              }
            };
          }
          if (stage.stageId === "stage:score") {
            return {
              ...stage,
              status: "ready" as const,
              inputRefs: ["ref:verify"],
              outputRefs: []
            };
          }
          return stage;
        })
      }
    }
  };
}

function verifyOnlyPolicy(capabilityId: string): AgentLoopProfilePolicyMetadata {
  return {
    schemaVersion: "1.0.0" as const,
    profileId: "test/verify-only.v1",
    role: "verification-workflow",
    workflowGraphId: "workflow/test.verify-only.v1",
    workflowPriority: "primary" as const,
    orchestrationMode: "staged-capability-workflow" as const,
    workflowCapabilityIds: [capabilityId],
    toolProjectionSource: "profile",
    stageAcceptanceMode: "automatic" as const,
    antiTailoring: false,
    executionBoundary: "governed-capabilities",
    redaction: { class: "internal" as const },
    stagedTaskWorkflow: {
      schemaVersion: "1.0.0" as const,
      profileId: "test/verify-only.v1",
      graphId: "graph:test.verify-only",
      fingerprint: "fnv1a:verify-only",
      stageCount: 1,
      refCount: 1,
      executorKinds: ["agent-loop"],
      graph: {
        schemaVersion: "1.0.0" as const,
        graphId: "graph:test.verify-only",
        profileId: "test/verify-only.v1",
        stages: [{
          schemaVersion: "1.0.0" as const,
          stageId: "stage:verify",
          kind: "verify",
          executorKind: "agent-loop",
          dependsOn: [],
          inputRefs: [],
          expectedOutputRefs: ["ref:verify"],
          allowedTools: [capabilityId],
          compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
          redaction: { class: "internal" as const }
        }],
        refs: [{
          schemaVersion: "1.0.0" as const,
          refId: "ref:verify",
          type: "check",
          producerStageId: "stage:verify",
          scope: "task",
          compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
          redaction: { class: "internal" as const }
        }],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" as const }
      },
      runState: {
        schemaVersion: "1.0.0" as const,
        taskRunId: "staged:graph:test.verify-only",
        graphId: "graph:test.verify-only",
        profileId: "test/verify-only.v1",
        stageStates: [{
          stageId: "stage:verify",
          status: "ready",
          attempts: 0,
          inputRefs: [],
          outputRefs: [],
          diagnostics: []
        }],
        refs: [],
        events: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" as const }
      },
      redaction: { class: "internal" as const }
    }
  };
}

class OneToolThenFinishModelGateway implements ModelGateway {
  constructor(private readonly name: string, private readonly input: JsonObject) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.messages?.some((message) => message.role === "tool")) {
      yield { kind: "delta", text: "tool turn resolved" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "tool-call", id: "call-runtime", name: this.name, input: this.input };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class LoopingToolCallModelGateway implements ModelGateway {
  constructor(private readonly name: string, private readonly input: JsonObject) {}

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { kind: "tool-call", id: "call-a", name: this.name, input: this.input };
    yield { kind: "tool-call", id: "call-b", name: this.name, input: this.input };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SingleToolCallModelGateway implements ModelGateway {
  constructor(private readonly name: string, private readonly input: JsonObject) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.messages?.some((message) => message.role === "tool")) {
      yield { kind: "delta", text: "tool outcome acknowledged" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "tool-call", id: "call-runtime", name: this.name, input: this.input };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class RecordingSingleToolCallModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly name: string, private readonly input: JsonObject) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (this.requests.length > 1) {
      yield { kind: "delta", text: "tool outcome acknowledged" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "tool-call", id: "call-runtime", name: this.name, input: this.input };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class RepeatingRejectedToolCallGateway implements ModelGateway {
  private calls = 0;

  constructor(private readonly name: string, private readonly input: JsonObject) {}

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    yield { kind: "tool-call", id: `call-repeated-rejected-${this.calls}`, name: this.name, input: this.input };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SequentialToolCallModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly calls: readonly { readonly id: string; readonly name: string; readonly input: JsonObject }[]) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const call = this.calls[Math.min(this.index, this.calls.length - 1)];
    this.index += 1;
    if (call) {
      yield { kind: "tool-call", id: call.id, name: call.name, input: call.input };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: "done" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

function providerToolNames(request: ModelRequest | undefined): readonly string[] {
  return (request?.tools ?? [])
    .map((tool) => {
      const fn = typeof tool.function === "object" && tool.function !== null
        ? tool.function as { readonly name?: unknown }
        : undefined;
      return typeof fn?.name === "string" ? fn.name : "";
    })
    .filter(Boolean)
    .sort();
}

class FailedTestFakePlatformRuntime extends FakePlatformRuntime {
  override async runProcess(command: string, args: readonly string[], options: ProcessRunOptions = {}, observer?: ProcessRunObserver): Promise<ProcessResult> {
    if (isFakePytestInvocation(command, args)) {
      const stdout = "FAILED tests/test_demo.py::test_expected_fix";
      observer?.onStdoutChunk?.(stdout);
      observer?.onProcessExit?.();
      return {
        exitCode: 1,
        stdout,
        stderr: "",
        metadata: {
          selectedProvider: "argv",
          status: "available",
          fallbackChain: [],
          degradedReasons: [],
          diagnostics: [],
          redaction: { class: "internal" }
        }
      };
    }
    return super.runProcess(command, args, options, observer);
  }
}

class SuccessfulTestFakePlatformRuntime extends FakePlatformRuntime {
  override async runProcess(command: string, args: readonly string[], options: ProcessRunOptions = {}, observer?: ProcessRunObserver): Promise<ProcessResult> {
    const commandLine = [command, ...args].join(" ").toLowerCase();
    if (commandLine.includes("python -c") || isFakePytestInvocation(command, args)) {
      const stdout = "successful command output";
      observer?.onStdoutChunk?.(stdout);
      observer?.onProcessExit?.();
      return {
        exitCode: 0,
        stdout,
        stderr: "",
        metadata: {
          selectedProvider: "argv",
          status: "available",
          fallbackChain: [],
          degradedReasons: [],
          diagnostics: [],
          redaction: { class: "internal" }
        }
      };
    }
    return super.runProcess(command, args, options, observer);
  }
}

function isFakePytestInvocation(command: string, args: readonly string[]): boolean {
  const commandLine = [command, ...args].join(" ").toLowerCase();
  return /\b(?:python\s+-m\s+)?pytest\b/.test(commandLine);
}

class RepeatingReadToolCallGateway implements ModelGateway {
  private calls = 0;

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    yield { kind: "tool-call", id: `call-repeat-read-${this.calls}`, name: "core.file.read", input: { path: "README.md" } };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class DenyAllPolicyEngine implements PolicyEngine {
  async decide(_request: PolicyRequest): Promise<PolicyDecision> {
    return {
      action: "deny",
      reason: "Denied by runtime feedback test policy",
      audit: { policy: "deny-all-feedback-test" }
    };
  }
}

class AllowAllPolicyEngine implements PolicyEngine {
  async decide(request: PolicyRequest): Promise<PolicyDecision> {
    return {
      action: "allow",
      reason: "Allowed by runtime feedback test policy",
      audit: request.auditEvidence ?? { policy: "allow-all-feedback-test" }
    };
  }
}

class ToolSchemaRecordingGateway implements ModelGateway {
  readonly observedSideEffects: string[] = [];
  readonly observedToolNames: string[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    for (const tool of request.tools ?? []) {
      const fn = (tool as JsonObject).function as JsonObject | undefined;
      if (fn && typeof fn.name === "string") this.observedToolNames.push(fn.name);
      const metadata = (tool as JsonObject).metadata as JsonObject | undefined;
      const sideEffect = metadata && typeof metadata.sideEffect === "string" ? metadata.sideEffect : undefined;
      if (sideEffect) this.observedSideEffects.push(sideEffect);
    }
    yield { kind: "delta", text: "noop" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}
