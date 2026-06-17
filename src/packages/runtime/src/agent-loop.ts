import type {
  AgentLoopControl,
  AgentLoopLimits,
  AgentLoopOutputContractVerification,
  AgentLoopRequest,
  AgentLoopSummary,
  EvidenceFactClass,
  EvidenceFirstRuntimeContext,
  EvidenceItem,
  AgentModeSessionSummary,
  AgentPhasePlan,
  AgentReasoningEffortMapping,
  AgentVerifierResult,
  ContextProjectionResult,
  HookInvocationResult,
  HookLifecyclePoint,
  InteractionModeState,
  InteractionModeTransition,
  JsonObject,
  AgentLoopProfilePolicyMetadata,
  ModelChatMessage,
  ModelOutputOptions,
  ModelReasoningOptions,
  RedactedError,
  RuntimeDependencies,
  RuntimeEvent,
  RuntimeKernel,
  RuntimeKernelRequest,
  SelfRepairAttemptRecord,
  SelfRepairFailureClassification,
  SelfRepairOutcomeSummary,
  SelfRepairPlan,
  SelfRepairVerificationSummary,
  SessionId,
  TaskDecisionEnvelope,
  TraceContext,
  TurnId,
  VisibleReasoningProjection,
  VisibleReasoningRecord,
  VisibleReasoningStatus
} from "@deepseek/platform-contracts";
import { EVIDENCE_FIRST_COMPATIBILITY, EVIDENCE_FIRST_SCHEMA_VERSION, asId } from "@deepseek/platform-contracts";
import { isStandardTestCommand } from "@deepseek/core-coding-tools";
import { projectAgentLoopContext, projectionEventData } from "./context-projection.js";
import { kernelError, toolIntentError } from "./errors.js";
import { createEvidenceFirstRuntimeContext, evidenceFirstEventData, groundStrictClaims } from "./evidence-first.js";
import { agentLoopEvent, collectRuntimeEvents, lastRuntimeEvent, recordRuntimeAdapterEvent, recordRuntimeModelRequestAudit, recordRuntimeModelUsageAudit } from "./events.js";
import {
  boundedModelText,
  buildToolResultFeedback,
  modelToolResultText,
  providerMetadata,
  resolveCapabilityId
} from "./model-tooling.js";
import { assemblePromptForIteration, promptAssemblyEventPayload, toolProjectionPolicy } from "./prompt-assembly-integration.js";
import {
  classifyRepairFailure,
  createAttemptRecord,
  createRepairPlan,
  createVerificationSummary,
  decideRepairPolicy,
  outcomeFromState,
  repairEvent,
  selfRepairConfig,
  stopPayload
} from "./self-repair/index.js";
import { runtimeTrace, stableHash } from "./trace.js";
import { executionFeedbackStatus, referenceContextSummary, summarizeAgentLoop } from "./agent-loop-summary.js";
import { advanceWorkflowStageFromToolEvidence, extractSkillActivateMetadata, projectToolSet, recordToolResultEvidence, taskScopedToolGuard, workflowCapabilityBoundaryGuard } from "./agent-loop-tools.js";
import { consumedBudgetEvents, createAgentLoopBudget } from "./modes/budgets.js";
import { recordLosslessAssistantMessage, recordLosslessToolResult, recordLosslessUserMessage } from "./lossless-context.js";
import { proposePermanentMemoryCandidates } from "./permanent-memory.js";
import { createRuntimeModePlan } from "./modes/phase-planner.js";
import {
  createAgentModeBinding,
  createInteractionModeState,
  createInteractionModeTransition,
  mapReasoningEffort,
  summarizeModePlan
} from "./modes/mode-state.js";
import { runFinalVerification } from "./agent-loop-verification.js";
import { projectReasoningForOutput, recordVisibleReasoning, recordVisibleReasoningProjection, visibleReasoningEvidence } from "./visible-reasoning.js";
import {
  createTaskDeliveryFlowSummary,
  parseTaskDecisionEnvelopeText,
  taskDecisionEnvelopeEventData,
  taskDeliveryFlowEventData,
  taskDeliveryFlowWithDecisionData
} from "./task-delivery-flow.js";

export const defaultAgentLoopLimits: AgentLoopLimits = {
  maxModelIterations: 4,
  maxToolCalls: 8,
  turnTimeoutMs: 120_000,
  toolTimeoutMs: 30_000,
  maxOutputBytes: 16_000,
  maxRetries: 0,
  maxRepairAttempts: 1
};

const RESTORED_HISTORY_MESSAGE_LIMIT = 12;
const RESTORED_HISTORY_CONTENT_LIMIT = 4_000;
const SWE_BENCH_PROVIDER_HISTORY_TOOL_TAIL_LIMIT = 1;
const SWE_BENCH_PROVIDER_TOOL_FEEDBACK_LIMIT_BYTES = 1_024;
const TERMINAL_TOOL_CAPABILITY_IDS = new Set(["core.swe.bench.run"]);
const SWE_BENCH_SOURCE_INSPECTION_GATE_TOOL_THRESHOLD = 8;
const SWE_BENCH_SOURCE_INSPECTION_GATE_FOCUSED_READ_LIMIT = 1;
const SWE_BENCH_SOURCE_INSPECTION_GATE_DEFIANCE_LIMIT = 2;
const SWE_BENCH_SOURCE_READ_DUPLICATE_OVERLAP_RATIO = 0.8;
const SWE_BENCH_VERIFICATION_GATE_SHELL_THRESHOLD = 8;
const SWE_BENCH_ENVIRONMENT_BLOCKER_SHELL_THRESHOLD = 2;
const SWE_BENCH_MODEL_REQUEST_BUDGET = 12;
const SWE_BENCH_RUN_ROUTING_GATE_TOOL_THRESHOLD = 3;

export async function* runAgentLoop(
  deps: RuntimeDependencies,
  kernel: RuntimeKernel,
  request: AgentLoopRequest,
  control: AgentLoopControl = {}
): AsyncIterable<RuntimeEvent> {
  const sessionId = request.sessionId ?? await deps.sessions.create({ caller: request.caller, workspaceRoot: request.workspaceRoot });
  const trace: TraceContext = request.trace ?? runtimeTrace(sessionId, "agent-loop");
  const turnId = asId<"turn">(`turn-${stableHash(`${sessionId}:${request.prompt}`)}`);
  const limits = { ...defaultAgentLoopLimits, ...(request.limits ?? {}) };
  const diagnostics: RedactedError[] = [];
  const selfRepair = selfRepairConfig(request.selfRepair, limits.maxRepairAttempts);
  const repairClassifications: SelfRepairFailureClassification[] = [];
  const repairAttempts: SelfRepairAttemptRecord[] = [];
  const repairVerification: SelfRepairVerificationSummary[] = [];
  let repairStopReason: SelfRepairOutcomeSummary["stopReason"] = selfRepair.enabled ? "completed" : "disabled";
  let assistantText = "";
  let iterations = 0;
  let toolCalls = 0;
  let terminalEmitted = false;
  let activeProfilePolicy = request.profilePolicy;
  let repairContinuationRequested = false;
  let toolEvidenceEvents: RuntimeEvent[] = [];
  let outputContractVerification: AgentLoopOutputContractVerification | undefined;
  const restoredHistory = await restoreSessionHistory(deps, sessionId);
  const messages: ModelChatMessage[] = [...restoredHistory.messages, { role: "user", content: request.prompt }];
  let contextProjection: ContextProjectionResult | undefined;
  let evidenceFirst: EvidenceFirstRuntimeContext | undefined;
  let phasePlan: AgentPhasePlan | undefined;
  let modeSummary: AgentModeSessionSummary | undefined;
  let interactionModeState: InteractionModeState | undefined;
  let interactionModeTransitions: readonly InteractionModeTransition[] | undefined;
  let reasoningEffortMapping: AgentReasoningEffortMapping | undefined = request.reasoningEffortMapping;
  let evidenceRevisionAttempted = false;
  let losslessUserNodeId: string | undefined;
  let visibleReasoningSequence = 0;
  let visibleReasoningRecords: VisibleReasoningRecord[] = [];
  let visibleReasoningProjection: VisibleReasoningProjection | undefined;
  const taskDeliveryFlow = createTaskDeliveryFlowSummary({ rawInput: request.prompt, activeTaskAvailable: true });
  let taskDeliveryFlowData = taskDeliveryFlowEventData(taskDeliveryFlow);
  const signal = control.signal;
  const sweBenchVerificationGate = createSweBenchVerificationGateState(request.prompt);

  const currentRepairOutcome = (): SelfRepairOutcomeSummary => outcomeFromState({
    enabled: selfRepair.enabled,
    classifications: repairClassifications,
    attempts: repairAttempts,
    verification: repairVerification,
    stopReason: repairStopReason
  });

  const summaryMode = () => ({
    phasePlan,
    modeSummary,
    interactionModeState,
    interactionModeTransitions,
    reasoningEffortMapping,
    outputContract: outputContractVerification,
    selfRepair: currentRepairOutcome(),
    visibleReasoning: visibleReasoningProjection ?? (visibleReasoningRecords.length > 0 ? projectReasoningForOutput(visibleReasoningRecords, request.outputMode) : undefined),
    taskDeliveryFlow: taskDeliveryFlowData
  });

  const maybeInsertSweBenchVerificationGate = async (): Promise<RuntimeEvent | undefined> => {
    if (shouldInsertSweBenchRunCapabilityRoutingGate(sweBenchVerificationGate)) {
      sweBenchVerificationGate.runCapabilityRoutingGateInserted = true;
      const content = [
        "SWE_BENCH_RUN_CAPABILITY_ROUTING_GATE",
        "Framework routing gate: this user-level SWE-bench Lite task request has spent the pre-run tool budget without invoking the governed core.swe.bench.run terminal capability.",
        `Observed preRunNonTerminalToolCalls=${sweBenchVerificationGate.preRunNonTerminalToolCount}, iterations=${iterations}, toolCalls=${toolCalls}.`,
        "Next action must call core.swe.bench.run for the requested task number or task range, or report a bounded blocker. Do not continue read/search/memory/project exploration before the governed run capability."
      ].join("\n");
      messages.push({ role: "user", content });
      const budget = createAgentLoopBudget({
        kind: "verification",
        requested: 1,
        allowed: 1,
        consumed: 1,
        stopReason: "swe-bench-run-capability-routing",
        policySource: "runtime.swe-bench-routing-gate"
      });
      const event = agentLoopEvent("agent.loop.budget.consumed", sessionId, turnId, trace, {
        budget,
        gate: "SWE_BENCH_RUN_CAPABILITY_ROUTING_GATE",
        preRunNonTerminalToolCount: sweBenchVerificationGate.preRunNonTerminalToolCount,
        iterationCount: iterations,
        toolCallCount: toolCalls
      }, request.agentId);
      await recordRuntimeAdapterEvent(deps, event);
      return event;
    }
    if (shouldInsertSweBenchSourceInspectionGate(sweBenchVerificationGate)) {
      sweBenchVerificationGate.sourceInspectionGateInserted = true;
      const content = [
        "SWE_BENCH_SOURCE_INSPECTION_GATE",
        "Framework acceptance gate: this managed SWE-bench run has spent the source-inspection budget on read/search/list tools without producing source-edit or test progress.",
        `Observed sourceInspectionTools=${sweBenchVerificationGate.sourceInspectionToolCount}, sourceMutations=${sweBenchVerificationGate.sourceMutationCount}, shellCommands=${sweBenchVerificationGate.shellCommandCount}, testCommands=${sweBenchVerificationGate.testCommandCount}, iterations=${iterations}, toolCalls=${toolCalls}.`,
        "Next action must make concrete progress: perform the smallest source edit, run a standard test command, or report a bounded blocker. Do not continue broad read/search/list exploration."
      ].join("\n");
      messages.push({ role: "user", content });
      const budget = createAgentLoopBudget({
        kind: "verification",
        requested: 1,
        allowed: 1,
        consumed: 1,
        stopReason: "swe-bench-source-inspection-budget",
        policySource: "runtime.swe-bench-phase-gate"
      });
      const event = agentLoopEvent("agent.loop.budget.consumed", sessionId, turnId, trace, {
        budget,
        gate: "SWE_BENCH_SOURCE_INSPECTION_GATE",
        sourceInspectionToolCount: sweBenchVerificationGate.sourceInspectionToolCount,
        shellCommandCount: sweBenchVerificationGate.shellCommandCount,
        testCommandCount: sweBenchVerificationGate.testCommandCount,
        sourceMutationCount: sweBenchVerificationGate.sourceMutationCount,
        iterationCount: iterations,
        toolCallCount: toolCalls
      }, request.agentId);
      await recordRuntimeAdapterEvent(deps, event);
      return event;
    }
    if (shouldInsertSweBenchReadyForHarnessGate(sweBenchVerificationGate)) {
      const budget = createAgentLoopBudget({
        kind: "verification",
        requested: 1,
        allowed: 1,
        consumed: 1,
        stopReason: "swe-bench-ready-for-harness",
        policySource: "runtime.swe-bench-ready-for-harness-gate"
      });
      const event = agentLoopEvent("agent.loop.budget.consumed", sessionId, turnId, trace, {
        budget,
        gate: "SWE_BENCH_READY_FOR_HARNESS_GATE",
        modelRequestCount: iterations,
        toolCallCount: toolCalls,
        sourceInspectionToolCount: sweBenchVerificationGate.sourceInspectionToolCount,
        sourceMutationCount: sweBenchVerificationGate.sourceMutationCount,
        shellCommandCount: sweBenchVerificationGate.shellCommandCount,
        testCommandCount: sweBenchVerificationGate.testCommandCount,
        successfulTestCommandCount: sweBenchVerificationGate.successfulTestCommandCount,
        diffInspectionCount: sweBenchVerificationGate.diffInspectionCount,
        postVerificationShellCommandCount: sweBenchVerificationGate.postVerificationShellCommandCount
      }, request.agentId);
      await recordRuntimeAdapterEvent(deps, event);
      return event;
    }
    if (shouldInsertSweBenchRepoLocalRunnerGate(sweBenchVerificationGate)) {
      sweBenchVerificationGate.repoLocalRunnerGateInserted = true;
      const alternateCommand = sweBenchVerificationGate.pendingRepoLocalRunnerCommand ?? "repo-local test runner";
      const alternateRunnerPath = sweBenchVerificationGate.pendingRepoLocalRunnerPath ?? "repo-local runner";
      const content = [
        "SWE_BENCH_REPO_LOCAL_RUNNER_GATE",
        "Framework workflow gate: the latest Python test command failed because a Python test launcher is unavailable, but the tool evidence found a repo-local Python test runner.",
        `Observed alternateRunnerPath=${alternateRunnerPath}, alternateCommand=${alternateCommand}, testCommands=${sweBenchVerificationGate.testCommandCount}, sourceMutations=${sweBenchVerificationGate.sourceMutationCount}, iterations=${iterations}, toolCalls=${toolCalls}.`,
        `Next action must rerun the focused test through the repo-local runner from the checkout root, starting with: ${alternateCommand}.`,
        "Do not install the missing test launcher or continue dependency probing before trying the repo-local runner once."
      ].join("\n");
      messages.push({ role: "user", content });
      const budget = createAgentLoopBudget({
        kind: "verification",
        requested: 1,
        allowed: 1,
        consumed: 1,
        stopReason: "swe-bench-repo-local-runner-routing",
        policySource: "runtime.swe-bench-workflow-gate"
      });
      const event = agentLoopEvent("agent.loop.budget.consumed", sessionId, turnId, trace, {
        budget,
        gate: "SWE_BENCH_REPO_LOCAL_RUNNER_GATE",
        alternateCommand,
        alternateRunnerPath,
        testCommandCount: sweBenchVerificationGate.testCommandCount,
        sourceMutationCount: sweBenchVerificationGate.sourceMutationCount,
        iterationCount: iterations,
        toolCallCount: toolCalls
      }, request.agentId);
      await recordRuntimeAdapterEvent(deps, event);
      return event;
    }
    if (shouldInsertSweBenchEnvironmentBlockerGate(sweBenchVerificationGate)) {
      sweBenchVerificationGate.environmentBlockerInserted = true;
      const content = [
        "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
        "Framework acceptance gate: this managed SWE-bench run has already produced source-edit and test evidence, but continues spending shell commands on environment setup or dependency probing.",
        `Observed shellCommands=${sweBenchVerificationGate.shellCommandCount}, postVerificationShellCommands=${sweBenchVerificationGate.postVerificationShellCommandCount}, testCommands=${sweBenchVerificationGate.testCommandCount}, sourceMutations=${sweBenchVerificationGate.sourceMutationCount}, iterations=${iterations}, toolCalls=${toolCalls}.`,
        "Do not continue broad dependency installation or environment probing. Use existing test output and source evidence to make the smallest source adjustment if needed, inspect git diff if useful, then end the child run so the governed outer SWE-bench harness can score the patch.",
        "If the local environment is blocked, report that blocker briefly and still return control with the current diff instead of consuming more setup iterations."
      ].join("\n");
      messages.push({ role: "user", content });
      const budget = createAgentLoopBudget({
        kind: "verification",
        requested: 1,
        allowed: 1,
        consumed: 1,
        stopReason: "swe-bench-environment-blocker",
        policySource: "runtime.swe-bench-phase-gate"
      });
      const event = agentLoopEvent("agent.loop.budget.consumed", sessionId, turnId, trace, {
        budget,
        gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
        shellCommandCount: sweBenchVerificationGate.shellCommandCount,
        postVerificationShellCommandCount: sweBenchVerificationGate.postVerificationShellCommandCount,
        testCommandCount: sweBenchVerificationGate.testCommandCount,
        successfulTestCommandCount: sweBenchVerificationGate.successfulTestCommandCount,
        sourceMutationCount: sweBenchVerificationGate.sourceMutationCount,
        iterationCount: iterations,
        toolCallCount: toolCalls
      }, request.agentId);
      await recordRuntimeAdapterEvent(deps, event);
      return event;
    }
    if (shouldInsertSweBenchPostEditVerificationGate(sweBenchVerificationGate)) {
      sweBenchVerificationGate.postEditVerificationGateInserted = true;
      const content = [
        "SWE_BENCH_POST_EDIT_VERIFICATION_GATE",
        "Framework acceptance gate: this managed SWE-bench run has produced a source edit after heavy inspection but still has no model-authored standard test command.",
        `Observed sourceInspectionTools=${sweBenchVerificationGate.sourceInspectionToolCount}, sourceMutations=${sweBenchVerificationGate.sourceMutationCount}, shellCommands=${sweBenchVerificationGate.shellCommandCount}, testCommands=${sweBenchVerificationGate.testCommandCount}, iterations=${iterations}, toolCalls=${toolCalls}.`,
        "Next action must be a standard test command that exercises the checkout, such as pytest, python -m pytest, python -m unittest, tox, nox, or the repository package test runner.",
        "If the test environment is blocked, report the bounded blocker instead of spending more read/search/list or setup iterations."
      ].join("\n");
      messages.push({ role: "user", content });
      const budget = createAgentLoopBudget({
        kind: "verification",
        requested: 1,
        allowed: 1,
        consumed: 1,
        stopReason: "swe-bench-post-edit-test-command-missing",
        policySource: "runtime.swe-bench-phase-gate"
      });
      const event = agentLoopEvent("agent.loop.budget.consumed", sessionId, turnId, trace, {
        budget,
        gate: "SWE_BENCH_POST_EDIT_VERIFICATION_GATE",
        sourceInspectionToolCount: sweBenchVerificationGate.sourceInspectionToolCount,
        shellCommandCount: sweBenchVerificationGate.shellCommandCount,
        testCommandCount: sweBenchVerificationGate.testCommandCount,
        sourceMutationCount: sweBenchVerificationGate.sourceMutationCount,
        iterationCount: iterations,
        toolCallCount: toolCalls
      }, request.agentId);
      await recordRuntimeAdapterEvent(deps, event);
      return event;
    }
    if (!shouldInsertSweBenchVerificationGate(sweBenchVerificationGate)) return undefined;
    sweBenchVerificationGate.inserted = true;
    const content = [
      "SWE_BENCH_VERIFICATION_GATE",
      "Framework acceptance gate: this managed SWE-bench run has used shell commands without a model-authored standard test command.",
      `Observed shellCommands=${sweBenchVerificationGate.shellCommandCount}, testCommands=${sweBenchVerificationGate.testCommandCount}, iterations=${iterations}, toolCalls=${toolCalls}.`,
      "Next action must be a standard test command that exercises the checkout, such as pytest, python -m pytest, python -m unittest, tox, nox, or the repository package test runner.",
      "After that test evidence exists, continue with the smallest source fix or report the test/setup blocker."
    ].join("\n");
    messages.push({ role: "user", content });
    const budget = createAgentLoopBudget({
      kind: "verification",
      requested: 1,
      allowed: 1,
      consumed: 1,
      stopReason: "swe-bench-test-command-missing",
      policySource: "runtime.swe-bench-phase-gate"
    });
    const event = agentLoopEvent("agent.loop.budget.consumed", sessionId, turnId, trace, {
      budget,
      gate: "SWE_BENCH_VERIFICATION_GATE",
      shellCommandCount: sweBenchVerificationGate.shellCommandCount,
      testCommandCount: sweBenchVerificationGate.testCommandCount,
      iterationCount: iterations,
      toolCallCount: toolCalls
    }, request.agentId);
    await recordRuntimeAdapterEvent(deps, event);
    return event;
  };

  const maybeStopAtSweBenchRequestBudget = async function* (): AsyncGenerator<RuntimeEvent, boolean, void> {
    if (!shouldStopAtSweBenchRequestBudget(sweBenchVerificationGate, iterations)) return false;
    if (shouldStopAtSweBenchRunCapabilityRoutingBudget(sweBenchVerificationGate, iterations)) {
      const error = kernelError(
        "KERNEL_QUEUE_BACKPRESSURE",
        "SWE_BENCH_RUN_CAPABILITY_ROUTING_REQUEST_BUDGET_GATE: user-level SWE-bench task request exhausted the model request budget before invoking core.swe.bench.run.",
        {
          gate: "SWE_BENCH_RUN_CAPABILITY_ROUTING_REQUEST_BUDGET_GATE",
          maxModelRequests: SWE_BENCH_MODEL_REQUEST_BUDGET,
          modelRequestCount: iterations,
          toolCallCount: toolCalls,
          preRunNonTerminalToolCount: sweBenchVerificationGate.preRunNonTerminalToolCount
        }
      );
      diagnostics.push(error);
      const budget = createAgentLoopBudget({
        kind: "model-iteration",
        requested: SWE_BENCH_MODEL_REQUEST_BUDGET,
        allowed: SWE_BENCH_MODEL_REQUEST_BUDGET,
        consumed: iterations,
        stopReason: "swe-bench-run-capability-routing-budget-exceeded",
        policySource: "runtime.swe-bench-routing-request-budget-gate"
      });
      const event = agentLoopEvent("agent.loop.budget.consumed", sessionId, turnId, trace, {
        budget,
        gate: "SWE_BENCH_RUN_CAPABILITY_ROUTING_REQUEST_BUDGET_GATE",
        modelRequestCount: iterations,
        toolCallCount: toolCalls,
        preRunNonTerminalToolCount: sweBenchVerificationGate.preRunNonTerminalToolCount
      }, request.agentId, error);
      await recordRuntimeAdapterEvent(deps, event);
      yield event;
      yield* emitFailureWithRepair("rejected", "swe-bench-run-capability-routing-budget-exceeded", error, event, {
        requestBudget: {
          gate: "SWE_BENCH_RUN_CAPABILITY_ROUTING_REQUEST_BUDGET_GATE",
          maxModelRequests: SWE_BENCH_MODEL_REQUEST_BUDGET,
          modelRequestCount: iterations,
          toolCallCount: toolCalls
        }
      });
      terminalEmitted = true;
      return true;
    }
    if (shouldCompleteSweBenchReadyForHarness(sweBenchVerificationGate)) {
      const budget = createAgentLoopBudget({
        kind: "verification",
        requested: 1,
        allowed: 1,
        consumed: 1,
        stopReason: "swe-bench-ready-for-harness",
        policySource: "runtime.swe-bench-ready-for-harness-gate"
      });
      const event = agentLoopEvent("agent.loop.budget.consumed", sessionId, turnId, trace, {
        budget,
        gate: "SWE_BENCH_READY_FOR_HARNESS_GATE",
        modelRequestCount: iterations,
        toolCallCount: toolCalls,
        sourceInspectionToolCount: sweBenchVerificationGate.sourceInspectionToolCount,
        sourceMutationCount: sweBenchVerificationGate.sourceMutationCount,
        shellCommandCount: sweBenchVerificationGate.shellCommandCount,
        testCommandCount: sweBenchVerificationGate.testCommandCount,
        successfulTestCommandCount: sweBenchVerificationGate.successfulTestCommandCount,
        diffInspectionCount: sweBenchVerificationGate.diffInspectionCount,
        postVerificationShellCommandCount: sweBenchVerificationGate.postVerificationShellCommandCount
      }, request.agentId);
      await recordRuntimeAdapterEvent(deps, event);
      yield event;
      const outcomeReasoning = await emitVisibleReasoning({
        actor: "runtime",
        stepKind: "outcome",
        status: "completed",
        summary: "SWE-bench child run has source edit and successful test evidence at the request budget boundary; returning control for official harness scoring.",
        phase: "verification",
        certainty: "verified",
        evidence: [visibleReasoningEvidence("trace", {
          kind: "turn",
          id: `${event.kind}:${event.createdAt}`,
          label: "SWE-bench ready for harness gate",
          sessionId,
          turnId,
          metadata: { gate: event.data.gate }
        }, "SWE-bench ready for harness gate")]
      });
      yield outcomeReasoning;
      const projectedReasoning = await emitVisibleReasoningProjection();
      yield projectedReasoning;
      const summary = {
        ...summarizeAgentLoop("completed", request, sessionId, turnId, trace, assistantText, iterations, toolCalls, diagnostics, summaryMode()),
        reason: "swe-bench-ready-for-harness",
        terminalGate: {
          gate: "SWE_BENCH_READY_FOR_HARNESS_GATE",
          modelRequestCount: iterations,
          toolCallCount: toolCalls,
          sourceMutationCount: sweBenchVerificationGate.sourceMutationCount,
          testCommandCount: sweBenchVerificationGate.testCommandCount,
          successfulTestCommandCount: sweBenchVerificationGate.successfulTestCommandCount,
          diffInspectionCount: sweBenchVerificationGate.diffInspectionCount
        }
      };
      yield* recordLosslessAssistantMessage(deps, {
        sessionId,
        turnId,
        trace,
        content: assistantText,
        ...(losslessUserNodeId ? { userNodeId: losslessUserNodeId } : {}),
        ...(request.agentId ? { agentId: request.agentId } : {})
      });
      const completed = agentLoopEvent("turn.completed", sessionId, turnId, trace, summary, request.agentId);
      await recordRuntimeAdapterEvent(deps, completed);
      yield completed;
      const loopTerminal = agentLoopEvent("agent.loop.completed", sessionId, turnId, trace, summary, request.agentId);
      await recordRuntimeAdapterEvent(deps, loopTerminal);
      yield loopTerminal;
      terminalEmitted = true;
      return true;
    }
    const error = kernelError(
      "KERNEL_QUEUE_BACKPRESSURE",
      "SWE_BENCH_REQUEST_BUDGET_GATE: managed SWE-bench child run exhausted the model request budget before producing completion-grade evidence.",
      {
        gate: "SWE_BENCH_REQUEST_BUDGET_GATE",
        maxModelRequests: SWE_BENCH_MODEL_REQUEST_BUDGET,
        modelRequestCount: iterations,
        toolCallCount: toolCalls,
        sourceInspectionToolCount: sweBenchVerificationGate.sourceInspectionToolCount,
        sourceMutationCount: sweBenchVerificationGate.sourceMutationCount,
        shellCommandCount: sweBenchVerificationGate.shellCommandCount,
        testCommandCount: sweBenchVerificationGate.testCommandCount,
        successfulTestCommandCount: sweBenchVerificationGate.successfulTestCommandCount,
        diffInspectionCount: sweBenchVerificationGate.diffInspectionCount,
        postVerificationShellCommandCount: sweBenchVerificationGate.postVerificationShellCommandCount
      }
    );
    diagnostics.push(error);
    const budget = createAgentLoopBudget({
      kind: "model-iteration",
      requested: SWE_BENCH_MODEL_REQUEST_BUDGET,
      allowed: SWE_BENCH_MODEL_REQUEST_BUDGET,
      consumed: iterations,
      stopReason: "swe-bench-request-budget-exceeded",
      policySource: "runtime.swe-bench-request-budget-gate"
    });
    const event = agentLoopEvent("agent.loop.budget.consumed", sessionId, turnId, trace, {
      budget,
      gate: "SWE_BENCH_REQUEST_BUDGET_GATE",
      modelRequestCount: iterations,
      toolCallCount: toolCalls,
      sourceInspectionToolCount: sweBenchVerificationGate.sourceInspectionToolCount,
      sourceMutationCount: sweBenchVerificationGate.sourceMutationCount,
      shellCommandCount: sweBenchVerificationGate.shellCommandCount,
      testCommandCount: sweBenchVerificationGate.testCommandCount,
      diffInspectionCount: sweBenchVerificationGate.diffInspectionCount,
      postVerificationShellCommandCount: sweBenchVerificationGate.postVerificationShellCommandCount
    }, request.agentId, error);
    await recordRuntimeAdapterEvent(deps, event);
    yield event;
    yield* emitFailureWithRepair("rejected", "swe-bench-request-budget-exceeded", error, event, {
      requestBudget: {
        gate: "SWE_BENCH_REQUEST_BUDGET_GATE",
        maxModelRequests: SWE_BENCH_MODEL_REQUEST_BUDGET,
        modelRequestCount: iterations,
        toolCallCount: toolCalls
      }
    });
    terminalEmitted = true;
    return true;
  };

  const maybeStopAtSweBenchSourceInspectionDefiance = async function* (
    terminalKind: string,
    rejectedEvent: RuntimeEvent
  ): AsyncGenerator<RuntimeEvent, boolean, void> {
    if (!shouldStopAtSweBenchSourceInspectionDefiance(sweBenchVerificationGate, terminalKind)) return false;
    const error = kernelError(
      "KERNEL_POLICY_DENIED",
      "SWE_BENCH_SOURCE_INSPECTION_DEFIANCE_GATE: managed SWE-bench child run repeatedly requested read/search/list or non-test setup after the source-inspection gate required edit, test, or bounded blocker progress.",
      {
        gate: "SWE_BENCH_SOURCE_INSPECTION_DEFIANCE_GATE",
        sourceInspectionGate: "SWE_BENCH_SOURCE_INSPECTION_GATE",
        defianceCount: sweBenchVerificationGate.sourceInspectionGateDefianceCount,
        defianceLimit: SWE_BENCH_SOURCE_INSPECTION_GATE_DEFIANCE_LIMIT,
        modelRequestCount: iterations,
        toolCallCount: toolCalls,
        sourceInspectionToolCount: sweBenchVerificationGate.sourceInspectionToolCount,
        sourceMutationCount: sweBenchVerificationGate.sourceMutationCount,
        shellCommandCount: sweBenchVerificationGate.shellCommandCount,
        testCommandCount: sweBenchVerificationGate.testCommandCount
      }
    );
    diagnostics.push(error);
    const budget = createAgentLoopBudget({
      kind: "verification",
      requested: SWE_BENCH_SOURCE_INSPECTION_GATE_DEFIANCE_LIMIT,
      allowed: SWE_BENCH_SOURCE_INSPECTION_GATE_DEFIANCE_LIMIT,
      consumed: sweBenchVerificationGate.sourceInspectionGateDefianceCount,
      stopReason: "swe-bench-source-inspection-defiance",
      policySource: "runtime.swe-bench-source-inspection-defiance-gate"
    });
    const event = agentLoopEvent("agent.loop.budget.consumed", sessionId, turnId, trace, {
      budget,
      gate: "SWE_BENCH_SOURCE_INSPECTION_DEFIANCE_GATE",
      sourceInspectionGate: "SWE_BENCH_SOURCE_INSPECTION_GATE",
      modelRequestCount: iterations,
      toolCallCount: toolCalls,
      defianceCount: sweBenchVerificationGate.sourceInspectionGateDefianceCount,
      sourceInspectionToolCount: sweBenchVerificationGate.sourceInspectionToolCount,
      sourceMutationCount: sweBenchVerificationGate.sourceMutationCount,
      shellCommandCount: sweBenchVerificationGate.shellCommandCount,
      testCommandCount: sweBenchVerificationGate.testCommandCount,
      rejectedToolCallId: rejectedEvent.data.toolCallId,
      rejectedToolName: rejectedEvent.data.toolName,
      rejectedTerminalKind: terminalKind
    }, request.agentId, error);
    await recordRuntimeAdapterEvent(deps, event);
    yield event;
    yield* emitFailureWithRepair("rejected", "swe-bench-source-inspection-defiance", error, event, {
      sourceInspectionDefiance: {
        gate: "SWE_BENCH_SOURCE_INSPECTION_DEFIANCE_GATE",
        sourceInspectionGate: "SWE_BENCH_SOURCE_INSPECTION_GATE",
        defianceCount: sweBenchVerificationGate.sourceInspectionGateDefianceCount,
        defianceLimit: SWE_BENCH_SOURCE_INSPECTION_GATE_DEFIANCE_LIMIT,
        modelRequestCount: iterations,
        toolCallCount: toolCalls
      }
    });
    return true;
  };

  const nextReasoningSequence = (): number => {
    visibleReasoningSequence += 10;
    return visibleReasoningSequence;
  };

  const emitVisibleReasoning = async (input: Omit<import("./visible-reasoning.js").RuntimeVisibleReasoningInput, "sessionId" | "turnId" | "trace" | "sequence" | "agentId">): Promise<RuntimeEvent> => {
    const { event, record } = await recordVisibleReasoning(deps, {
      sessionId,
      turnId,
      trace,
      sequence: nextReasoningSequence(),
      ...(request.agentId ? { agentId: request.agentId } : {}),
      ...input
    });
    visibleReasoningRecords = [...visibleReasoningRecords, record];
    return event;
  };

  const emitVisibleReasoningProjection = async (): Promise<RuntimeEvent> => {
    const { event, projection } = await recordVisibleReasoningProjection(deps, {
      sessionId,
      turnId,
      trace,
      records: visibleReasoningRecords,
      outputMode: request.outputMode,
      ...(request.agentId ? { agentId: request.agentId } : {})
    });
    visibleReasoningProjection = projection;
    return event;
  };

  const emitFailureWithRepair = async function* (
    status: AgentLoopSummary["status"],
    reason: string,
    error?: RedactedError,
    event?: RuntimeEvent,
    extraData: JsonObject = {}
  ): AsyncGenerator<RuntimeEvent, boolean, void> {
    if (error || event) {
      const classification = classifyRepairFailure({
        terminalKind: event?.kind ?? reason,
        ...(error ? { error } : {}),
        ...(event ? { event } : {}),
        trace,
        ...(event ? { evidenceFingerprint: `event:${stableHash(JSON.stringify({ kind: event.kind, data: event.data, error: event.error?.code }))}` } : {})
      });
      repairClassifications.push(classification);
      const startedRepair = await repairEvent(deps, "agent.repair.started", sessionId, turnId, trace, {
        reason,
        enabled: selfRepair.enabled,
        attemptBudget: selfRepair.maxAttempts,
        redaction: { class: "internal", fields: ["reason"] }
      }, request.agentId);
      yield startedRepair;
      const classifiedRepair = await repairEvent(deps, "agent.repair.classified", sessionId, turnId, trace, { classification }, request.agentId);
      yield classifiedRepair;
      const decision = decideRepairPolicy(selfRepair, classification, currentRepairOutcome());
      repairStopReason = decision.stopReason;
      if (decision.allowed) {
        const plan = createRepairPlan({
          classification,
          attemptNumber: repairAttempts.length + 1,
          requiresCheckpoint: decision.requiresCheckpoint,
          verificationMode: selfRepair.verificationMode,
          trace
        });
        const planEvent = await repairEvent(deps, "agent.repair.plan.created", sessionId, turnId, trace, { plan }, request.agentId);
        yield planEvent;
        if (plan.requiresCheckpoint && !hasEligibleRepairCheckpoint(deps, sessionId, turnId)) {
          repairStopReason = "checkpoint-unavailable";
          const stopped = await repairEvent(deps, "agent.repair.stopped", sessionId, turnId, trace, stopPayload({ stopReason: "checkpoint-unavailable", classification, plan }), request.agentId);
          yield stopped;
        } else {
          const verification = createVerificationSummary({ status: "skipped", command: plan.expectedVerification[0] ?? "next model iteration" });
          repairVerification.push(verification);
          const verificationStarted = await repairEvent(deps, "agent.repair.verification.started", sessionId, turnId, trace, { verification }, request.agentId);
          yield verificationStarted;
          const attempt = createAttemptRecord({
            plan,
            status: "started",
            verification: [verification],
            materialChangeFingerprint: "pending-model-feedback"
          });
          repairAttempts.push(attempt);
          const attemptStarted = await repairEvent(deps, "agent.repair.attempt.started", sessionId, turnId, trace, { attempt }, request.agentId);
          yield attemptStarted;
          messages.push(repairFeedbackMessage(plan, classification, error));
          const attemptCompleted = createAttemptRecord({
            plan,
            status: "completed",
            verification: [verification],
            materialChangeFingerprint: "model-feedback"
          });
          repairAttempts[repairAttempts.length - 1] = attemptCompleted;
          const attemptCompletedEvent = await repairEvent(deps, "agent.repair.attempt.completed", sessionId, turnId, trace, { attempt: attemptCompleted }, request.agentId);
          yield attemptCompletedEvent;
          const verificationCompleted = await repairEvent(deps, "agent.repair.verification.completed", sessionId, turnId, trace, { verification }, request.agentId);
          yield verificationCompleted;
          const stopped = await repairEvent(deps, "agent.repair.stopped", sessionId, turnId, trace, stopPayload({ stopReason: "completed", classification, plan, attempt: attemptCompleted }), request.agentId);
          repairStopReason = "completed";
          yield stopped;
          if (iterations < limits.maxModelIterations) {
            repairContinuationRequested = true;
            return true;
          }
        }
      } else {
        const stopped = await repairEvent(deps, "agent.repair.stopped", sessionId, turnId, trace, stopPayload({ stopReason: decision.stopReason, classification }), request.agentId);
        yield stopped;
      }
    }
    const outcomeReasoning = await emitVisibleReasoning({
      actor: "runtime",
      stepKind: "outcome",
      status: visibleStatusForTerminal(status),
      certainty: "verified",
      summary: `Agent loop stopped with status=${status} reason=${reason}.`,
      phase: "outcome",
      evidence: event ? [visibleReasoningEvidence("trace", { kind: "turn", id: `${event.kind}:${event.createdAt}`, label: event.kind, sessionId, turnId }, event.kind)] : []
    });
    yield outcomeReasoning;
    const projectedReasoning = await emitVisibleReasoningProjection();
    yield projectedReasoning;
    const summary = summarizeAgentLoop(status, request, sessionId, turnId, trace, assistantText, iterations, toolCalls, diagnostics, summaryMode());
    const failed = agentLoopEvent("agent.loop.failed", sessionId, turnId, trace, { ...summary, reason, ...extraData }, request.agentId, error);
    await recordRuntimeAdapterEvent(deps, failed);
    yield failed;
    return false;
  };

  const emitCancelled = async function* (): AsyncGenerator<RuntimeEvent, void, void> {
    const outcomeReasoning = await emitVisibleReasoning({
      actor: "runtime",
      stepKind: "outcome",
      status: "blocked",
      certainty: "verified",
      summary: "Agent loop was cancelled by the user before completion.",
      phase: "outcome"
    });
    yield outcomeReasoning;
    const projectedReasoning = await emitVisibleReasoningProjection();
    yield projectedReasoning;
    const summary = summarizeAgentLoop("cancelled", request, sessionId, turnId, trace, assistantText, iterations, toolCalls, diagnostics, summaryMode());
    const cancelled = agentLoopEvent("agent.loop.cancelled", sessionId, turnId, trace, { ...summary, reason: "user-cancelled" }, request.agentId);
    await recordRuntimeAdapterEvent(deps, cancelled);
    yield cancelled;
  };

  const fireHooks = async function* (point: HookLifecyclePoint, input: JsonObject): AsyncGenerator<RuntimeEvent, HookInvocationResult, void> {
    let result: HookInvocationResult;
    try {
      result = await deps.hooks.invokeHooks({
        schemaVersion: "1.0.0",
        point,
        input,
        sessionId,
        trace,
        ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {})
      });
    } catch (error) {
      result = {
        schemaVersion: "1.0.0",
        point,
        status: "failed",
        orderedHookIds: [],
        executions: [],
        diagnostics: [{
          code: "HOOK_SYSTEM_FAILED",
          message: error instanceof Error ? error.message : "hook system threw",
          retryable: false,
          redaction: { class: "internal" }
        }],
        redaction: { class: "internal" },
        compatibility: { schemaVersion: "1.0.0" },
        replayFingerprint: "hook-invoke-error"
      };
    }
    const event = agentLoopEvent("hooks.invoked", sessionId, turnId, trace, {
      point,
      status: result.status,
      hookCount: result.orderedHookIds.length,
      diagnostics: result.diagnostics
    }, request.agentId);
    await recordRuntimeAdapterEvent(deps, event);
    yield event;
    return result;
  };

  const started = agentLoopEvent("agent.loop.started", sessionId, turnId, trace, {
    schemaVersion: "1.0.0",
    caller: request.caller,
    outputMode: request.outputMode,
    workspaceRoot: request.workspaceRoot,
    model: request.profile.model,
    ...(request.referenceContext ? { referenceContext: referenceContextSummary(request) } : {}),
    taskDeliveryFlow: taskDeliveryFlowData,
    limits
  }, request.agentId);
  await recordRuntimeAdapterEvent(deps, started);
  yield started;

  if (signal?.aborted) {
    yield* emitCancelled();
    return;
  }

  const turnStarted = agentLoopEvent("turn.started", sessionId, turnId, trace, {
    promptHash: stableHash(request.prompt),
    caller: request.caller,
    ...(request.referenceContext ? { referenceContext: request.referenceContext } : {})
  }, request.agentId);
  await recordRuntimeAdapterEvent(deps, turnStarted);
  yield turnStarted;
  const intentReasoning = await emitVisibleReasoning({
    actor: "runtime",
    stepKind: "intent",
    status: "running",
    summary: `Working on: ${boundedModelText(request.prompt, 180)}`,
    detail: "Visible reasoning records summarize product-facing decisions and link them to evidence; raw provider/internal reasoning is excluded.",
    phase: "intent",
    certainty: "inferred",
    evidence: [visibleReasoningEvidence("trace", { kind: "turn", id: String(turnId), label: "current turn", sessionId, turnId }, "current turn")]
  });
  yield intentReasoning;
  losslessUserNodeId = yield* recordLosslessUserMessage(deps, {
    sessionId,
    turnId,
    trace,
    content: request.prompt,
    ...(request.agentId ? { agentId: request.agentId } : {})
  });
  yield* proposePermanentMemoryCandidates(deps, request, sessionId, turnId, trace);

  const userInputResult = yield* fireHooks("user-input.before", {
    promptHash: stableHash(request.prompt),
    caller: request.caller,
    workspaceRoot: request.workspaceRoot,
    taskDeliveryFlow: taskDeliveryFlowData,
    ...(request.referenceContext ? { referenceContext: request.referenceContext } : {})
  });
  if (userInputResult.status === "blocked") {
    diagnostics.push({ code: "HOOK_BLOCKED", message: "user-input.before hook blocked this turn", retryable: false, redaction: { class: "internal" } });
    const summary = { ...summarizeAgentLoop("rejected", request, sessionId, turnId, trace, assistantText, iterations, toolCalls, diagnostics, summaryMode()), reason: "blocked-by-hook" };
    const failed = agentLoopEvent("agent.loop.failed", sessionId, turnId, trace, summary, request.agentId);
    await recordRuntimeAdapterEvent(deps, failed);
    yield failed;
    terminalEmitted = true;
    return;
  }

  evidenceFirst = await createEvidenceFirstRuntimeContext(deps, request, sessionId, turnId, trace);
  const modePlan = createRuntimeModePlan({ request, sessionId, turnId, trace, limits, evidenceFirst, selfRepair });
  phasePlan = modePlan.phasePlan;
  interactionModeState = createInteractionModeState({ sessionId, turnId, mode: modePlan.interactionMode, trace });
  const transition = createInteractionModeTransition({ sessionId, turnId, nextMode: modePlan.interactionMode, trace });
  interactionModeTransitions = [transition];
  reasoningEffortMapping = reasoningEffortMapping ?? mapReasoningEffort({
    ...(request.reasoning?.effort ? { requested: request.reasoning.effort } : {}),
    ...(request.reasoning?.providerEffort ? { providerEffort: request.reasoning.providerEffort } : {}),
    provider: String(request.profile.providerId),
    model: request.profile.model
  });
  modeSummary = summarizeModePlan({ phasePlan, reasoningEffortMapping });
  const modeChanged = agentLoopEvent("mode.interaction.changed", sessionId, turnId, trace, transition, request.agentId);
  await recordRuntimeAdapterEvent(deps, modeChanged);
  yield modeChanged;
  const agentModeBinding = await createAgentModeBinding({ deps, sessionId, mode: modePlan.agentMode, interactionMode: modePlan.interactionMode });
  const agentBound = agentLoopEvent("mode.agent.bound", sessionId, turnId, trace, agentModeBinding, request.agentId);
  await recordRuntimeAdapterEvent(deps, agentBound);
  yield agentBound;
  const planEvent = agentLoopEvent("agent.phase.plan.created", sessionId, turnId, trace, phasePlan, request.agentId);
  await recordRuntimeAdapterEvent(deps, planEvent);
  yield planEvent;
  const phaseReasoning = await emitVisibleReasoning({
    actor: "runtime",
    stepKind: "assumption",
    status: "completed",
    summary: `Planned ${phasePlan.agentMode} work with required phases: ${phasePlan.phases.filter((phase) => phase.required).map((phase) => phase.phase).join(",") || "none"}.`,
    phase: "planning",
    certainty: "inferred",
    evidence: [visibleReasoningEvidence("trace", { kind: "tool-evidence", id: phasePlan.planId, label: "agent phase plan", sessionId, turnId }, "agent phase plan", phasePlan.planId)]
  });
  yield phaseReasoning;
  for (const skippedPhase of modePlan.skippedPhases) {
    const skipped = agentLoopEvent("agent.phase.skipped", sessionId, turnId, trace, skippedPhase, request.agentId);
    await recordRuntimeAdapterEvent(deps, skipped);
    yield skipped;
  }
  for (const budget of consumedBudgetEvents(phasePlan)) {
    const consumed = agentLoopEvent("agent.loop.budget.consumed", sessionId, turnId, trace, budget, request.agentId);
    await recordRuntimeAdapterEvent(deps, consumed);
    yield consumed;
  }
  const reasoningMapped = agentLoopEvent("model.reasoning.effort.mapped", sessionId, turnId, trace, reasoningEffortMapping, request.agentId);
  await recordRuntimeAdapterEvent(deps, reasoningMapped);
  yield reasoningMapped;
  const classified = agentLoopEvent("evidence.classified", sessionId, turnId, trace, evidenceFirst.classification, request.agentId);
  await recordRuntimeAdapterEvent(deps, classified);
  yield classified;
  const evidenceReasoning = await emitVisibleReasoning({
    actor: "runtime",
    stepKind: "context-selection",
    status: evidenceFirst.classification.evidenceRequired ? "running" : "skipped",
    summary: evidenceFirst.classification.evidenceRequired
      ? `Evidence is required for this turn; fact classes=${evidenceFirst.classification.factClasses.join(",") || "none"}.`
      : "No additional evidence discovery required for this turn.",
    phase: "evidence",
    certainty: "verified",
    evidence: [visibleReasoningEvidence("trace", { kind: "tool-evidence", id: evidenceFirst.classification.classificationId, label: "evidence classification", sessionId, turnId }, "evidence classification", evidenceFirst.classification.classificationId)]
  });
  yield evidenceReasoning;
  if (evidenceFirst.plan) {
    const planCreated = agentLoopEvent("evidence.plan.created", sessionId, turnId, trace, evidenceFirst.plan, request.agentId);
    await recordRuntimeAdapterEvent(deps, planCreated);
    yield planCreated;
  }
  if (evidenceFirst.classification.evidenceRequired) {
    const selected = agentLoopEvent("evidence.selected", sessionId, turnId, trace, {
      schemaVersion: evidenceFirst.schemaVersion,
      selectedEvidenceCount: evidenceFirst.selectedEvidence.length,
      sourceCoverage: evidenceFirst.sourceCoverage,
      summary: evidenceFirst.summary,
      evidenceItems: evidenceFirst.selectedEvidence.map((item) => ({
        evidenceId: item.evidenceId,
        sourceGroup: item.sourceGroup,
        sourcePath: item.sourcePath,
        sourceLabel: item.sourceLabel,
        factClasses: item.factClasses,
        fingerprint: item.fingerprint,
        freshness: item.freshness,
        redaction: item.redaction
      })),
      redaction: { class: "internal", fields: ["evidenceItems"] }
    }, request.agentId);
    await recordRuntimeAdapterEvent(deps, selected);
    yield selected;
    const selectedReasoning = await emitVisibleReasoning({
      actor: "runtime",
      stepKind: "context-selection",
      status: "completed",
      summary: `Selected ${evidenceFirst.selectedEvidence.length} evidence items before model dispatch.`,
      phase: "evidence",
      certainty: "verified",
      evidence: evidenceFirst.selectedEvidence.slice(0, 5).map((item) => visibleReasoningEvidence("tool-evidence", {
        kind: "tool-evidence",
        id: item.evidenceId,
        label: item.sourceLabel,
        sessionId,
        turnId,
        metadata: { sourceGroup: item.sourceGroup, fingerprint: item.fingerprint }
      }, item.sourceLabel, item.fingerprint))
    });
    yield selectedReasoning;
  }

  const projectionStream = projectAgentLoopContext(deps, request, sessionId, turnId, trace);
  let projectionStep = await projectionStream.next();
  while (!projectionStep.done) {
    const projectionEvent = projectionStep.value;
    yield projectionEvent;
    if (projectionEvent.kind === "context.projection.rejected") {
      diagnostics.push(projectionEvent.error ?? kernelError("KERNEL_ENVELOPE_INVALID", "Context projection rejected model dispatch"));
      yield* emitFailureWithRepair("rejected", "context-projection-rejected", diagnostics[0], projectionEvent);
      terminalEmitted = true;
      return;
    }
    projectionStep = await projectionStream.next();
  }
  contextProjection = projectionStep.value?.projection;
  if (contextProjection) {
    const contextReasoning = await emitVisibleReasoning({
      actor: "runtime",
      stepKind: "context-selection",
      status: contextProjection.status === "completed" ? "completed" : contextProjection.status === "degraded" ? "warning" : "failed",
      summary: `Projected ${contextProjection.selectedNodes.length} context nodes and excluded ${contextProjection.excludedNodes.length}; budget=${contextProjection.budget.status}.`,
      phase: "context",
      certainty: "verified",
      evidence: contextProjection.selectedNodes.slice(0, 5).map((node) => visibleReasoningEvidence("context-node", {
        kind: "tool-evidence",
        id: String(node.id),
        label: `${node.kind}:${node.source}`,
        sessionId,
        turnId,
        metadata: { source: node.source, kind: node.kind, fingerprints: node.dependencyFingerprints }
      }, `${node.kind}:${node.source}`, node.dependencyFingerprints[0]))
    });
    yield contextReasoning;
  }

  while (iterations < limits.maxModelIterations) {
    repairContinuationRequested = false;
    if (signal?.aborted) {
      yield* emitCancelled();
      terminalEmitted = true;
      return;
    }
    if (yield* maybeStopAtSweBenchRequestBudget()) return;
    iterations += 1;
    let iterationReasoning = "";
    let reasoningPersistedForIteration = false;
    const iterationRequest = activeProfilePolicy ? { ...request, profilePolicy: activeProfilePolicy } : request;
    const availableCapabilities = await deps.capabilities.listModelVisible();
    const visibleCapabilities = projectToolSet(availableCapabilities, iterationRequest);
    const providerHistory = providerHistoryForRequest(messages, sweBenchVerificationGate);
    const assembly = await assemblePromptForIteration(deps, iterationRequest, sessionId, turnId, trace, providerHistory, contextProjection, visibleCapabilities, limits, evidenceFirst, currentRepairOutcome(), {
      phasePlan,
      reasoningEffortMapping,
      taskDecision: taskDeliveryFlow.decisionRequest
    });
    if (assembly.status === "rejected") {
      diagnostics.push(...assembly.diagnostics);
      const error = assembly.diagnostics[0] ?? kernelError("KERNEL_ENVELOPE_INVALID", "Prompt assembly rejected model dispatch");
      yield* emitFailureWithRepair("rejected", "prompt-assembly-rejected", error, undefined, { promptAssembly: promptAssemblyEventPayload(assembly, iterationRequest) });
      terminalEmitted = true;
      return;
    }
    const toolProjection = toolProjectionPolicy(iterationRequest);
    const visibleCapabilityIds = visibleCapabilities.map((capability) => capability.id);
    const capabilityResolutionSet = visibleCapabilities.length === availableCapabilities.length
      ? visibleCapabilities
      : availableCapabilities;
    const modelBeforeResult = yield* fireHooks("model-call.before", {
      iteration: iterations,
      model: request.profile.model,
      messageCount: assembly.messages.length,
      visibleToolCount: assembly.toolPlan.visibleToolCount,
      promptAssembly: {
        fingerprint: assembly.fingerprint,
        sectionCount: assembly.sections.length,
        budgetStatus: assembly.budget.status
      },
      ...(assembly.trace.pipeline ? { contextPipeline: assembly.trace.pipeline } : {}),
      ...(evidenceFirst ? { evidenceFirst: evidenceFirstEventData(evidenceFirst) } : {}),
      ...(contextProjection ? { contextProjection: projectionEventData(contextProjection) } : {}),
      taskDeliveryFlow: taskDeliveryFlowData
    });
    if (modelBeforeResult.status === "blocked") {
      diagnostics.push({ code: "HOOK_BLOCKED", message: "model-call.before hook blocked this iteration", retryable: false, redaction: { class: "internal" } });
      const blockedEvent = agentLoopEvent("model.blocked", sessionId, turnId, trace, {
        iteration: iterations,
        reason: "blocked-by-hook"
      }, request.agentId);
      await recordRuntimeAdapterEvent(deps, blockedEvent);
      yield blockedEvent;
      const summary = { ...summarizeAgentLoop("rejected", request, sessionId, turnId, trace, assistantText, iterations, toolCalls, diagnostics, summaryMode()), reason: "blocked-by-hook" };
      const failed = agentLoopEvent("agent.loop.failed", sessionId, turnId, trace, summary, request.agentId);
      await recordRuntimeAdapterEvent(deps, failed);
      yield failed;
      terminalEmitted = true;
      return;
    }
    const promptAssembled = agentLoopEvent("prompt.assembled", sessionId, turnId, trace, promptAssemblyEventPayload(assembly, iterationRequest), request.agentId);
    await recordRuntimeAdapterEvent(deps, promptAssembled);
    yield promptAssembled;
    const promptReasoning = await emitVisibleReasoning({
      actor: "prompt-assembly",
      stepKind: "prompt-assembly",
      status: assembly.status === "assembled" ? "completed" : "failed",
      summary: `Assembled provider-neutral request with ${assembly.budget.includedSectionCount} included sections, ${assembly.budget.excludedSectionCount} excluded sections, and ${assembly.toolPlan.visibleToolCount} visible tools.`,
      phase: "prompt",
      certainty: "verified",
      evidence: [visibleReasoningEvidence("prompt-section", {
        kind: "tool-evidence",
        id: assembly.fingerprint,
        label: "prompt assembly",
        sessionId,
        turnId,
        metadata: { sectionOrderFingerprint: assembly.trace.replay.sectionOrderFingerprint, budgetFingerprint: assembly.trace.replay.budgetFingerprint }
      }, "prompt assembly", assembly.fingerprint)]
    });
    yield promptReasoning;

    const modelRequested = agentLoopEvent("model.requested", sessionId, turnId, trace, {
      iteration: iterations,
      model: request.profile.model,
      toolProjection,
      visibleToolCount: assembly.toolPlan.visibleToolCount,
      providerRequestReplay: providerRequestReplayEvidence(assembly.messages, restoredHistory, assembly.toolPlan.visibleToolCount, providerHistory.length),
      promptAssembly: {
        fingerprint: assembly.fingerprint,
        sectionCount: assembly.sections.length,
        budgetStatus: assembly.budget.status
      },
      ...(assembly.trace.pipeline ? { contextPipeline: assembly.trace.pipeline } : {}),
      ...(evidenceFirst ? { evidenceFirst: evidenceFirstEventData(evidenceFirst) } : {}),
      ...(contextProjection ? { contextProjection: projectionEventData(contextProjection) } : {}),
      ...(iterationRequest.profilePolicy ? { profilePolicy: iterationRequest.profilePolicy } : {}),
      taskDeliveryFlow: taskDeliveryFlowData,
      ...(iterationRequest.referenceContext ? { referenceContext: referenceContextSummary(iterationRequest) } : {})
    }, request.agentId);
    await recordRuntimeAdapterEvent(deps, modelRequested);
    await recordRuntimeModelRequestAudit(deps, modelRequested, {
      phase: "runtime",
      requestCount: 1,
      providerId: String(request.profile.providerId),
      model: request.profile.model,
      promptAssemblyFingerprint: assembly.fingerprint,
      ...(iterationRequest.profilePolicy ? { profilePolicy: iterationRequest.profilePolicy } : {}),
      taskDeliveryFlow: taskDeliveryFlowData
    });
    yield modelRequested;

    let requestedTool = false;
    const reasoning = modelReasoningOptions(request.reasoning, reasoningEffortMapping);
    const output = modelOutputOptions(request);
    for await (const modelEvent of deps.models.stream({
      profile: request.profile,
      prompt: assembly.promptText,
      messages: assembly.messages,
      tools: assembly.toolPlan.visibleTools,
      toolProjection,
      ...(request.credentialRef ? { credentialRef: request.credentialRef } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(output ? { output } : {}),
      ...(signal ? { signal } : {}),
      timeoutMs: request.timeoutMs ?? limits.turnTimeoutMs,
      metadata: {
        agentLoop: true,
        sessionId,
        turnId,
        trace,
        outputMode: request.outputMode,
        ...(contextProjection ? { contextProjection: projectionEventData(contextProjection) } : {}),
        ...(iterationRequest.profilePolicy ? { profilePolicy: iterationRequest.profilePolicy } : {}),
        taskDeliveryFlow: taskDeliveryFlowData,
        promptAssembly: {
          fingerprint: assembly.fingerprint,
          budget: assembly.budget,
          replay: assembly.trace.replay
        },
        ...(assembly.trace.pipeline ? { contextPipeline: assembly.trace.pipeline } : {}),
        ...(iterationRequest.referenceContext ? { referenceContext: iterationRequest.referenceContext } : {}),
        live: request.live === true
      }
    })) {
      if (signal?.aborted) {
        yield* emitCancelled();
        terminalEmitted = true;
        return;
      }
      if (modelEvent.kind === "delta") {
        assistantText += modelEvent.text;
        const event = agentLoopEvent("model.delta", sessionId, turnId, trace, {
          text: modelEvent.text,
          iteration: iterations,
          provider: modelEvent.provider ?? providerMetadata(request)
        }, request.agentId);
        await recordRuntimeAdapterEvent(deps, event);
        yield event;
        continue;
      }
      if (modelEvent.kind === "reasoning") {
        iterationReasoning += modelEvent.text;
        const event = agentLoopEvent("model.reasoning", sessionId, turnId, trace, {
          text: modelEvent.text,
          redaction: modelEvent.redaction,
          iteration: iterations,
          provider: modelEvent.provider ?? providerMetadata(request)
        }, request.agentId);
        await recordRuntimeAdapterEvent(deps, event);
        yield event;
        continue;
      }
      if (modelEvent.kind === "usage") {
        const event = agentLoopEvent("usage.updated", sessionId, turnId, trace, {
          inputTokens: modelEvent.inputTokens,
          outputTokens: modelEvent.outputTokens,
          metadata: modelEvent.metadata ?? {}
        }, request.agentId);
        await recordRuntimeAdapterEvent(deps, event);
        await recordRuntimeModelUsageAudit(deps, event, {
          inputTokens: modelEvent.inputTokens,
          outputTokens: modelEvent.outputTokens,
          ...(modelEvent.metadata ? { metadata: modelEvent.metadata } : {})
        });
        yield event;
        continue;
      }
      if (modelEvent.kind === "tool-call") {
        requestedTool = true;
        if (toolCalls >= limits.maxToolCalls) {
          const error = kernelError("KERNEL_QUEUE_BACKPRESSURE", "Agent loop tool-call limit exceeded", { maxToolCalls: limits.maxToolCalls });
          diagnostics.push(error);
          const providerToolName = modelEvent.name;
          const toolName = resolveCapabilityId(providerToolName, capabilityResolutionSet);
          const toolCallId = modelEvent.id ?? `tool-${iterations}-${toolCalls + 1}`;
          const limitFeedback = buildToolResultFeedback({
            toolCallId,
            toolName,
            status: "rejected",
            text: error.message,
            diagnostics: [error],
            trace,
            limitBytes: limits.maxOutputBytes,
            continuation: "terminate"
          });
          const rejected = agentLoopEvent("model.tool.rejected", sessionId, turnId, trace, {
            reason: "tool-call-limit",
            maxToolCalls: limits.maxToolCalls,
            toolName,
            feedback: limitFeedback,
            evidence: await recordToolResultEvidence(deps, {
              toolCallId,
              toolName,
              terminalKind: "tool-call-limit",
              feedback: limitFeedback
            })
          }, request.agentId, error);
          await recordRuntimeAdapterEvent(deps, rejected);
          yield rejected;
          yield* emitFailureWithRepair("rejected", "tool-call-limit", error, rejected);
          terminalEmitted = true;
          return;
        }
        toolCalls += 1;
        const providerToolName = modelEvent.name;
        const toolCallId = modelEvent.id ?? `tool-${iterations}-${toolCalls}`;
        const toolName = resolveCapabilityId(providerToolName, capabilityResolutionSet);
        recordSweBenchVerificationGateToolIntent(sweBenchVerificationGate, toolName, modelEvent.input);
        const intentEvent = agentLoopEvent("model.tool.intent", sessionId, turnId, trace, {
          toolCallId,
          name: toolName,
          input: modelEvent.input,
          provider: modelEvent.provider ?? providerMetadata(request),
          iteration: iterations
        }, request.agentId);
        await recordRuntimeAdapterEvent(deps, intentEvent);
        yield intentEvent;
        const toolIntentReasoning = await emitVisibleReasoning({
          actor: "runtime",
          stepKind: "tool-intent",
          status: "running",
          summary: `Model requested governed tool ${toolName}; preflight will validate capability and policy before execution.`,
          phase: "tools",
          certainty: "inferred",
          evidence: [visibleReasoningEvidence("command-result", {
            kind: "command",
            id: toolCallId,
            label: toolName,
            sessionId,
            turnId,
            metadata: { iteration: iterations, providerToolName }
          }, toolName, toolCallId)]
        });
        yield toolIntentReasoning;
        const persistedReasoning = iterationReasoning;
        if (persistedReasoning.length > 0 && !reasoningPersistedForIteration) {
          reasoningPersistedForIteration = true;
          const persistedEvent = agentLoopEvent("model.reasoning.persisted", sessionId, turnId, trace, {
            iteration: iterations,
            byteLength: Buffer.byteLength(persistedReasoning, "utf8"),
            redaction: { class: "internal" }
          }, request.agentId);
          await recordRuntimeAdapterEvent(deps, persistedEvent);
          yield persistedEvent;
        }
        messages.push({
          role: "assistant",
          content: "",
          toolCalls: [{
            id: toolCallId,
            name: providerToolName,
            input: modelEvent.input
          }],
          ...(persistedReasoning.length > 0 ? { reasoningContent: persistedReasoning, reasoningRedaction: { class: "internal" } } : {})
        });

        const descriptor = await deps.platform.descriptor();
        const resolvedCapabilityId = asId<"capability">(toolName);
        const preflightVisibleCapabilityIds = visibleCapabilityIds.includes(resolvedCapabilityId) ||
          !availableCapabilities.some((capability) => capability.id === resolvedCapabilityId)
          ? visibleCapabilityIds
          : [...visibleCapabilityIds, resolvedCapabilityId];
        const preflight = await deps.toolIntentPreflight.check({
          intent: {
            toolCallId,
            name: toolName,
            input: modelEvent.input,
            source: "model"
          },
          workspaceRoot: request.workspaceRoot,
          platform: descriptor.os,
          modelVisibleCapabilities: preflightVisibleCapabilityIds,
          providerId: request.profile.providerId,
          profileId: request.profile.id,
          providerHints: {
            userPrompt: request.prompt
          }
        });
        const preflightKind = preflight.status === "rejected" ? "model.tool.rejected" : preflight.status === "repaired" ? "model.tool.repaired" : "model.tool.repaired";
        const preflightEvent = agentLoopEvent(preflightKind, sessionId, turnId, trace, {
          status: preflight.status,
          capabilityId: preflight.capabilityId ?? "",
          repairs: preflight.repairs,
          diagnostics: preflight.diagnostics,
          repaired: preflight.repaired ?? {}
        }, request.agentId, preflight.status === "rejected" ? toolIntentError(preflight.diagnostics) : undefined);
        await recordRuntimeAdapterEvent(deps, preflightEvent);
        yield preflightEvent;
        if (preflight.status === "rejected" || !preflight.capabilityId) {
          const error = toolIntentError(preflight.diagnostics);
          diagnostics.push(error);
          const preflightFeedback = buildToolResultFeedback({
            toolCallId,
            toolName,
            ...(preflight.capabilityId ? { capabilityId: String(preflight.capabilityId) } : {}),
            status: "rejected",
            text: `Tool request rejected: ${error.message}`,
            diagnostics: [error, ...preflight.diagnostics],
            trace,
            limitBytes: limits.maxOutputBytes,
            continuation: "continue"
          });
          const preflightResultEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
            toolCallId,
            toolName,
            result: preflightFeedback.preview.text,
            terminalKind: "preflight.rejected",
            feedback: preflightFeedback,
            evidence: await recordToolResultEvidence(deps, {
              toolCallId,
              toolName,
              ...(preflight.capabilityId ? { capabilityId: String(preflight.capabilityId) } : {}),
              terminalKind: "preflight.rejected",
              feedback: preflightFeedback
            })
          }, request.agentId, error);
          await recordRuntimeAdapterEvent(deps, preflightResultEvent);
          yield preflightResultEvent;
          messages.push({ role: "tool", content: preflightFeedback.preview.text, toolCallId, toolName });
          continue;
        }

        const toolInput = preflight.repaired?.input ?? modelEvent.input;
        const workflowBoundaryError = workflowCapabilityBoundaryGuard({
          ...(activeProfilePolicy ? { profilePolicy: activeProfilePolicy } : {}),
          capabilityId: String(preflight.capabilityId),
          toolName,
          toolInput
        });
        if (workflowBoundaryError) {
          diagnostics.push(workflowBoundaryError);
          const boundaryFeedback = buildToolResultFeedback({
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            status: "rejected",
            text: workflowBoundaryError.message,
            diagnostics: [workflowBoundaryError],
            trace,
            limitBytes: limits.maxOutputBytes,
            continuation: "continue"
          });
          const boundaryRejectedEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
            toolCallId,
            toolName,
            result: boundaryFeedback.preview.text,
            terminalKind: "workflow-capability-boundary.rejected",
            feedback: boundaryFeedback,
            evidence: await recordToolResultEvidence(deps, {
              toolCallId,
              toolName,
              capabilityId: String(preflight.capabilityId),
              terminalKind: "workflow-capability-boundary.rejected",
              feedback: boundaryFeedback
            })
          }, request.agentId, workflowBoundaryError);
          await recordRuntimeAdapterEvent(deps, boundaryRejectedEvent);
          yield boundaryRejectedEvent;
          messages.push({ role: "tool", content: boundaryFeedback.preview.text, toolCallId, toolName });
          continue;
        }
        const sweBenchGateRejection = sweBenchGatePolicyRejection(sweBenchVerificationGate, toolName, toolInput);
        if (sweBenchGateRejection) {
          const { error, terminalKind } = sweBenchGateRejection;
          recordSweBenchGatePolicyRejection(sweBenchVerificationGate, terminalKind);
          activeProfilePolicy = applyWorkflowGateOverride(activeProfilePolicy, {
            terminalKind,
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            error
          });
          if (!isNonFatalSweBenchGateRejection(terminalKind)) diagnostics.push(error);
          const gateFeedback = buildToolResultFeedback({
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            status: "rejected",
            text: error.message,
            diagnostics: [error],
            trace,
            limitBytes: limits.maxOutputBytes,
            continuation: "continue"
          });
          const gateRejectedEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
            toolCallId,
            toolName,
            result: gateFeedback.preview.text,
            terminalKind,
            feedback: gateFeedback,
            evidence: await recordToolResultEvidence(deps, {
              toolCallId,
              toolName,
              capabilityId: String(preflight.capabilityId),
              terminalKind,
              feedback: gateFeedback
            })
          }, request.agentId, error);
          await recordRuntimeAdapterEvent(deps, gateRejectedEvent);
          yield gateRejectedEvent;
          if (yield* maybeStopAtSweBenchSourceInspectionDefiance(terminalKind, gateRejectedEvent)) {
            terminalEmitted = true;
            return;
          }
          messages.push({ role: "tool", content: gateFeedback.preview.text, toolCallId, toolName });
          continue;
        }
        const taskScopeError = taskScopedToolGuard({
          taskDeliveryFlow: taskDeliveryFlowData,
          toolName,
          toolInput
        });
        if (taskScopeError) {
          diagnostics.push(taskScopeError);
          const deniedFeedback = buildToolResultFeedback({
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            status: "rejected",
            text: taskScopeError.message,
            diagnostics: [taskScopeError],
            trace,
            limitBytes: limits.maxOutputBytes,
            continuation: "continue"
          });
          const deniedEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
            toolCallId,
            toolName,
            result: deniedFeedback.preview.text,
            terminalKind: "task-scope.rejected",
            feedback: deniedFeedback,
            evidence: await recordToolResultEvidence(deps, {
              toolCallId,
              toolName,
              capabilityId: String(preflight.capabilityId),
              terminalKind: "task-scope.rejected",
              feedback: deniedFeedback
            })
          }, request.agentId, taskScopeError);
          await recordRuntimeAdapterEvent(deps, deniedEvent);
          yield deniedEvent;
          messages.push({ role: "tool", content: deniedFeedback.preview.text, toolCallId, toolName });
          continue;
        }
        const toolBeforeResult = yield* fireHooks("tool-execution.before", {
          toolName,
          capabilityId: String(preflight.capabilityId),
          toolCallId,
          input: toolInput
        });
        if (toolBeforeResult.status === "blocked") {
          const blockError: RedactedError = {
            code: "HOOK_TOOL_BLOCKED",
            message: `tool-execution.before hook blocked ${toolName}`,
            retryable: false,
            redaction: { class: "internal" }
          };
          diagnostics.push(blockError);
          const deniedFeedback = buildToolResultFeedback({
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            status: "denied",
            text: blockError.message,
            diagnostics: [blockError],
            trace,
            limitBytes: limits.maxOutputBytes,
            continuation: "continue"
          });
          const deniedEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
            toolCallId,
            toolName,
            result: deniedFeedback.preview.text,
            terminalKind: "hook.blocked",
            feedback: deniedFeedback,
            evidence: await recordToolResultEvidence(deps, {
              toolCallId,
              toolName,
              capabilityId: String(preflight.capabilityId),
              terminalKind: "hook.blocked",
              feedback: deniedFeedback
            })
          }, request.agentId, blockError);
          await recordRuntimeAdapterEvent(deps, deniedEvent);
          yield deniedEvent;
          messages.push({ role: "tool", content: deniedFeedback.preview.text, toolCallId, toolName });
          continue;
        }
        const toolManifest = visibleCapabilities.find((capability) => capability.id === preflight.capabilityId);
        const kernelRequest: RuntimeKernelRequest = {
          capabilityId: preflight.capabilityId,
          caller: request.caller,
          input: toolInput,
          sessionId,
          turnId,
          timeoutMs: toolTimeoutFor(toolInput, limits.toolTimeoutMs, toolManifest?.timeoutMs),
          trace
        };
        const toolEvents = await collectRuntimeEvents(kernel.execute({
          ...kernelRequest,
          ...(request.agentId ? { agentId: request.agentId } : {}),
          ...(modelEvent.id ? { parentInvocationId: modelEvent.id } : {})
        }));
        for (const event of toolEvents) {
          yield event;
        }
        const terminal = lastRuntimeEvent(toolEvents, (event) => event.kind === "capability.completed" || event.kind === "capability.failed" || event.kind === "capability.cancelled" || event.kind === "execution.rejected");
        recordSweBenchVerificationGateToolCompletion(sweBenchVerificationGate, toolName, toolInput, terminal);
        const toolResultText = modelToolResultText(terminal);
        const feedbackStatus = executionFeedbackStatus(terminal);
        const recoverableToolFailure = isRecoverableToolError(terminal?.error);
        const executionFeedback = buildToolResultFeedback({
          toolCallId,
          toolName,
          capabilityId: String(preflight.capabilityId),
          status: feedbackStatus,
          text: toolResultText,
          diagnostics: terminal?.error ? [terminal.error] : [],
          trace,
          limitBytes: limits.maxOutputBytes,
          ...(terminal?.kind === "capability.completed" || recoverableToolFailure ? { continuation: "continue" as const } : {})
        });
        messages.push({ role: "tool", content: executionFeedback.preview.text, toolCallId, toolName });
        const resultEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
          toolCallId,
          toolName,
          result: boundedModelText(toolResultText, limits.maxOutputBytes),
          terminalKind: terminal?.kind ?? "unknown",
          feedback: executionFeedback,
          evidence: await recordToolResultEvidence(deps, {
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            terminalKind: terminal?.kind ?? "unknown",
            feedback: executionFeedback
          })
        }, request.agentId, recoverableToolFailure ? undefined : terminal?.error);
        await recordRuntimeAdapterEvent(deps, resultEvent);
        yield resultEvent;
        const gateOverrideProgressed = shouldClearWorkflowGateOverride(activeProfilePolicy?.workflowGateOverride, toolName, toolInput, terminal);
        const workflowProgress = advanceWorkflowStageFromToolEvidence({
          ...(activeProfilePolicy ? { profilePolicy: activeProfilePolicy } : {}),
          capabilityId: String(preflight.capabilityId),
          toolCallId,
          toolInput,
          terminal,
          at: terminal?.createdAt ?? resultEvent.createdAt
        });
        if (workflowProgress) {
          activeProfilePolicy = clearWorkflowGateOverride(workflowProgress.profilePolicy);
          for (const stageEvent of workflowProgress.stageEvents) {
            const workflowStep = agentLoopEvent("workflow.step", sessionId, turnId, trace, {
              workflowId: workflowProgress.profilePolicy.workflowGraphId,
              graphId: workflowProgress.profilePolicy.stagedTaskWorkflow?.graphId ?? workflowProgress.profilePolicy.workflowGraphId,
              stageId: stageEvent.stageId,
              status: stageEvent.kind === "stage.started" ? "running" : stageEvent.kind === "stage.succeeded" ? "succeeded" : "failed",
              capabilityId: String(preflight.capabilityId),
              toolCallId,
              stageEvent,
              runState: workflowProgress.profilePolicy.stagedTaskWorkflow?.runState,
              redaction: { class: "internal", fields: ["runState.stageStates.diagnostics", "stageEvent.outputRefs.preview"] }
            }, request.agentId);
            await recordRuntimeAdapterEvent(deps, workflowStep);
            yield workflowStep;
          }
        } else if (gateOverrideProgressed && activeProfilePolicy) {
          activeProfilePolicy = clearWorkflowGateOverride(activeProfilePolicy);
        }
        const toolResultReasoning = await emitVisibleReasoning({
          actor: "runtime",
          stepKind: "verification",
          status: executionFeedback.status === "success" ? "completed" : executionFeedback.status === "denied" || executionFeedback.status === "rejected" ? "blocked" : "warning",
          summary: `Tool ${toolName} returned ${executionFeedback.status}; result is bounded and linked as evidence.`,
          phase: "tools",
          certainty: "verified",
          evidence: [visibleReasoningEvidence("tool-evidence", {
            kind: "tool-evidence",
            id: `tool-result:${toolCallId}`,
            label: `${toolName} result`,
            sessionId,
            turnId,
            metadata: { toolCallId, terminalKind: terminal?.kind ?? "unknown", status: executionFeedback.status }
          }, `${toolName} result`, `tool-result:${toolCallId}:${executionFeedback.status}`)]
        });
        yield toolResultReasoning;
        yield* recordLosslessToolResult(deps, {
          sessionId,
          turnId,
          trace,
          toolCallId,
          toolName,
          content: toolResultText,
          ...(losslessUserNodeId ? { assistantNodeId: losslessUserNodeId } : {}),
          ...(request.agentId ? { agentId: request.agentId } : {})
        });
        toolEvidenceEvents = [...toolEvidenceEvents, resultEvent];
        if (toolName === "core.skill.activate" && terminal?.kind === "capability.completed") {
          const metadata = extractSkillActivateMetadata(terminal);
          if (metadata && metadata.status === "activated") {
            const skillEvent = agentLoopEvent("skill.activated", sessionId, turnId, trace, {
              name: metadata.name,
              status: metadata.status,
              segmentCount: metadata.segmentCount,
              loadingState: metadata.loadingState
            }, request.agentId);
            await recordRuntimeAdapterEvent(deps, skillEvent);
            yield skillEvent;
          }
        }
        yield* fireHooks("tool-execution.after", {
          toolName,
          capabilityId: String(preflight.capabilityId),
          toolCallId,
          terminalKind: terminal?.kind ?? "unknown",
          feedbackStatus: executionFeedback.status
        });
        if (isTerminalToolCompletion(String(preflight.capabilityId), terminal)) {
          const outcomeReasoning = await emitVisibleReasoning({
            actor: "runtime",
            stepKind: "outcome",
            status: "completed",
            summary: `Terminal tool ${toolName} completed the governed task; outer loop will not request additional model actions.`,
            phase: "outcome",
            certainty: "verified",
            evidence: [visibleReasoningEvidence("tool-evidence", {
              kind: "tool-evidence",
              id: `tool-result:${toolCallId}`,
              label: `${toolName} terminal result`,
              sessionId,
              turnId,
              metadata: {
                toolCallId,
                terminalKind: terminal?.kind ?? "unknown",
                status: executionFeedback.status,
                capabilityId: String(preflight.capabilityId)
              }
            }, `${toolName} terminal result`, `tool-result:${toolCallId}:${executionFeedback.status}`)]
          });
          yield outcomeReasoning;
          const projectedReasoning = await emitVisibleReasoningProjection();
          yield projectedReasoning;
          const summary = {
            ...summarizeAgentLoop("completed", request, sessionId, turnId, trace, assistantText, iterations, toolCalls, diagnostics, summaryMode()),
            reason: "terminal-tool-completed",
            terminalTool: {
              toolCallId,
              toolName,
              capabilityId: String(preflight.capabilityId),
              terminalKind: terminal?.kind ?? "unknown",
              feedbackStatus: executionFeedback.status
            }
          };
          yield* recordLosslessAssistantMessage(deps, {
            sessionId,
            turnId,
            trace,
            content: assistantText,
            ...(losslessUserNodeId ? { userNodeId: losslessUserNodeId } : {}),
            ...(request.agentId ? { agentId: request.agentId } : {})
          });
          const completed = agentLoopEvent("turn.completed", sessionId, turnId, trace, summary, request.agentId);
          await recordRuntimeAdapterEvent(deps, completed);
          yield completed;
          const loopTerminal = agentLoopEvent("agent.loop.completed", sessionId, turnId, trace, summary, request.agentId);
          await recordRuntimeAdapterEvent(deps, loopTerminal);
          yield loopTerminal;
          terminalEmitted = true;
          return;
        }
        if (terminal?.error) {
          diagnostics.push(terminal.error);
          if (executionFeedback.continuation === "continue") {
            continue;
          }
          const status = terminal.kind === "capability.cancelled"
            ? "cancelled"
            : terminal.kind === "execution.rejected"
              ? "rejected"
              : "failed";
          const repairQueued = yield* emitFailureWithRepair(status, "tool-terminal-error", terminal.error, terminal);
          if (repairQueued && iterations < limits.maxModelIterations) {
            break;
          }
          terminalEmitted = true;
          return;
        }
      }
      if (modelEvent.kind === "finish") {
        const event = agentLoopEvent("model.finished", sessionId, turnId, trace, {
          reason: modelEvent.reason,
          provider: modelEvent.provider ?? providerMetadata(request),
          iteration: iterations
        }, request.agentId);
        await recordRuntimeAdapterEvent(deps, event);
        yield event;
      }
      if (modelEvent.kind === "done") {
        const event = agentLoopEvent("model.done", sessionId, turnId, trace, {
          provider: modelEvent.provider ?? providerMetadata(request),
          iteration: iterations
        }, request.agentId);
        await recordRuntimeAdapterEvent(deps, event);
        yield event;
      }
      if (modelEvent.kind === "error") {
        diagnostics.push(modelEvent.error);
        const failed = agentLoopEvent("runtime.error", sessionId, turnId, trace, {
          source: "model",
          provider: modelEvent.provider ?? providerMetadata(request)
        }, request.agentId, modelEvent.error);
        await recordRuntimeAdapterEvent(deps, failed);
        yield failed;
        const repairQueued = yield* emitFailureWithRepair("failed", "model-provider-error", modelEvent.error, failed);
        if (repairQueued && iterations < limits.maxModelIterations) {
          break;
        }
        terminalEmitted = true;
        return;
      }
    }
    if (iterationReasoning.length > 0) {
      const modelSummaryReasoning = await emitVisibleReasoning({
        actor: "model-summary",
        stepKind: requestedTool ? "tool-intent" : "outcome",
        status: "completed",
        summary: `Model emitted reasoning metadata for iteration ${iterations}; raw provider/internal reasoning remains excluded from visible reasoning records.`,
        phase: "model",
        certainty: "inferred",
        metadata: {
          iteration: iterations,
          byteLength: Buffer.byteLength(iterationReasoning, "utf8"),
          rawProviderReasoningExcluded: true
        }
      });
      yield modelSummaryReasoning;
    }
    yield* fireHooks("model-call.after", {
      iteration: iterations,
      toolRequested: requestedTool,
      messageCount: messages.length
    });
    const sweBenchGateEvent = await maybeInsertSweBenchVerificationGate();
    if (sweBenchGateEvent) {
      yield sweBenchGateEvent;
      if (sweBenchGateEvent.data.gate === "SWE_BENCH_READY_FOR_HARNESS_GATE") {
        const outcomeReasoning = await emitVisibleReasoning({
          actor: "runtime",
          stepKind: "outcome",
          status: "completed",
          summary: "SWE-bench child run has source edit, successful test, and patch evidence; returning control for official harness scoring.",
          phase: "verification",
          certainty: "verified",
          evidence: [visibleReasoningEvidence("trace", {
            kind: "turn",
            id: `${sweBenchGateEvent.kind}:${sweBenchGateEvent.createdAt}`,
            label: "SWE-bench ready for harness gate",
            sessionId,
            turnId,
            metadata: { gate: sweBenchGateEvent.data.gate }
          }, "SWE-bench ready for harness gate")]
        });
        yield outcomeReasoning;
        const projectedReasoning = await emitVisibleReasoningProjection();
        yield projectedReasoning;
        const summary = {
          ...summarizeAgentLoop("completed", request, sessionId, turnId, trace, assistantText, iterations, toolCalls, diagnostics, summaryMode()),
          reason: "swe-bench-ready-for-harness",
          terminalGate: {
            gate: "SWE_BENCH_READY_FOR_HARNESS_GATE",
            modelRequestCount: sweBenchGateEvent.data.modelRequestCount,
            toolCallCount: sweBenchGateEvent.data.toolCallCount,
            sourceMutationCount: sweBenchGateEvent.data.sourceMutationCount,
            testCommandCount: sweBenchGateEvent.data.testCommandCount,
            successfulTestCommandCount: sweBenchGateEvent.data.successfulTestCommandCount,
            diffInspectionCount: sweBenchGateEvent.data.diffInspectionCount
          }
        };
        yield* recordLosslessAssistantMessage(deps, {
          sessionId,
          turnId,
          trace,
          content: assistantText,
          ...(losslessUserNodeId ? { userNodeId: losslessUserNodeId } : {}),
          ...(request.agentId ? { agentId: request.agentId } : {})
        });
        const completed = agentLoopEvent("turn.completed", sessionId, turnId, trace, summary, request.agentId);
        await recordRuntimeAdapterEvent(deps, completed);
        yield completed;
        const loopTerminal = agentLoopEvent("agent.loop.completed", sessionId, turnId, trace, summary, request.agentId);
        await recordRuntimeAdapterEvent(deps, loopTerminal);
        yield loopTerminal;
        terminalEmitted = true;
        return;
      }
      if (sweBenchGateEvent.data.gate === "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE") {
        const outcomeReasoning = await emitVisibleReasoning({
          actor: "runtime",
          stepKind: "outcome",
          status: "completed",
          summary: "SWE-bench environment blocker gate reached; returning control to the governed harness with the current diff instead of requesting more environment setup actions.",
          phase: "verification",
          certainty: "verified",
          evidence: [visibleReasoningEvidence("trace", {
            kind: "turn",
            id: `${sweBenchGateEvent.kind}:${sweBenchGateEvent.createdAt}`,
            label: "SWE-bench environment blocker gate",
            sessionId,
            turnId,
            metadata: { gate: sweBenchGateEvent.data.gate }
          }, "SWE-bench environment blocker gate")]
        });
        yield outcomeReasoning;
        const projectedReasoning = await emitVisibleReasoningProjection();
        yield projectedReasoning;
        const summary = {
          ...summarizeAgentLoop("completed", request, sessionId, turnId, trace, assistantText, iterations, toolCalls, diagnostics, summaryMode()),
          reason: "swe-bench-environment-blocker",
          terminalGate: {
            gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
            shellCommandCount: sweBenchGateEvent.data.shellCommandCount,
            postVerificationShellCommandCount: sweBenchGateEvent.data.postVerificationShellCommandCount,
            testCommandCount: sweBenchGateEvent.data.testCommandCount,
            sourceMutationCount: sweBenchGateEvent.data.sourceMutationCount
          }
        };
        yield* recordLosslessAssistantMessage(deps, {
          sessionId,
          turnId,
          trace,
          content: assistantText,
          ...(losslessUserNodeId ? { userNodeId: losslessUserNodeId } : {}),
          ...(request.agentId ? { agentId: request.agentId } : {})
        });
        const completed = agentLoopEvent("turn.completed", sessionId, turnId, trace, summary, request.agentId);
        await recordRuntimeAdapterEvent(deps, completed);
        yield completed;
        const loopTerminal = agentLoopEvent("agent.loop.completed", sessionId, turnId, trace, summary, request.agentId);
        await recordRuntimeAdapterEvent(deps, loopTerminal);
        yield loopTerminal;
        terminalEmitted = true;
        return;
      }
      continue;
    }
    if (repairContinuationRequested && iterations < limits.maxModelIterations) {
      continue;
    }
    if (!requestedTool) {
      const decisionEnvelope = parseTaskDecisionEnvelopeText(assistantText, taskDeliveryFlow.decisionRequest.requestId);
      if (decisionEnvelope) {
        taskDeliveryFlowData = taskDeliveryFlowWithDecisionData(taskDeliveryFlowData, decisionEnvelope, "model");
        const decisionReceived = agentLoopEvent("task.decision.received", sessionId, turnId, trace, taskDecisionEnvelopeEventData(decisionEnvelope, taskDeliveryFlowData), request.agentId);
        await recordRuntimeAdapterEvent(deps, decisionReceived);
        yield decisionReceived;
        assistantText = taskDecisionRuntimeStatus(decisionEnvelope);
      }
      if (evidenceFirst?.classification.evidenceRequired) {
        const groundingContext = withToolResultEvidence(evidenceFirst, toolEvidenceEvents, sessionId, turnId, trace);
        const grounding = groundStrictClaims(assistantText, groundingContext);
        evidenceFirst = { ...groundingContext, summary: grounding.summary };
        const groundedEvent = agentLoopEvent("evidence.claims.grounded", sessionId, turnId, trace, {
          schemaVersion: evidenceFirst.schemaVersion,
          claimGroundingCount: grounding.claimGroundings.length,
          unsupportedClaimCount: grounding.unsupportedClaims.length,
          claimGroundings: grounding.claimGroundings,
          summary: grounding.summary,
          redaction: { class: "internal", fields: ["claimGroundings.claimPreview"] }
        }, request.agentId);
        await recordRuntimeAdapterEvent(deps, groundedEvent);
        yield groundedEvent;
        for (const unsupported of grounding.unsupportedClaims) {
          const unsupportedEvent = agentLoopEvent("evidence.unsupported-claim", sessionId, turnId, trace, unsupported, request.agentId);
          await recordRuntimeAdapterEvent(deps, unsupportedEvent);
          yield unsupportedEvent;
        }
        if (grounding.unsupportedClaims.length > 0 && !evidenceRevisionAttempted && iterations < limits.maxModelIterations) {
          evidenceRevisionAttempted = true;
          assistantText = "";
          messages.push({
            role: "tool",
            toolCallId: `evidence-revision:${stableHash(grounding.unsupportedClaims.map((claim) => claim.claimFingerprint).join("|"))}`,
            toolName: "evidence-first.claim-grounding",
            content: [
              "Evidence-first revision required:",
              `Unsupported strict claims: ${grounding.unsupportedClaims.map((claim) => `${claim.code}:${claim.claimPreview}`).join("; ")}`,
              "Revise once by removing unsupported claims, rewriting them as unknown, or labeling explicit assumptions. Preserve the original user task."
            ].join("\n")
          });
          continue;
        }
        if (grounding.unsupportedClaims.length > 0) {
          const error = kernelError("KERNEL_ENVELOPE_INVALID", "Evidence-first unsupported strict claims remained after revision", {
            unsupportedClaimCount: grounding.unsupportedClaims.length
          });
          diagnostics.push(error);
          const failed = agentLoopEvent("agent.loop.failed", sessionId, turnId, trace, {
            ...summarizeAgentLoop("rejected", request, sessionId, turnId, trace, assistantText, iterations, toolCalls, diagnostics, summaryMode()),
            reason: "evidence-unsupported-claim",
            evidenceFirst: evidenceFirstEventData(evidenceFirst)
          }, request.agentId, error);
          await recordRuntimeAdapterEvent(deps, failed);
          yield failed;
          terminalEmitted = true;
          return;
        }
      }
      const verification = await runFinalVerification({
        deps,
        request,
        sessionId,
        turnId,
        trace,
        phasePlan,
        modeSummary,
        assistantText,
        toolEvents: toolEvidenceEvents,
        diagnostics,
        iteration: iterations
      });
      outputContractVerification = verification.outputContract ?? outputContractVerification;
      modeSummary = verification.modeSummary;
      for (const event of verification.events) yield event;
      if (verification.events.length > 0 || verification.verifierResult || verification.outputContract) {
        const verificationReasoning = await emitVisibleReasoning({
          actor: "verifier",
          stepKind: "verification",
          status: verification.terminalStatus === "completed" ? "completed" : "failed",
          summary: `Final verification status=${verification.terminalStatus}; verifier=${verification.verifierResult?.verdict ?? "none"} outputContract=${verification.outputContract?.status ?? "not_applicable"}.`,
          phase: "verification",
          certainty: "verified",
          evidence: [
            ...(verification.verifierResult ? [visibleReasoningEvidence("check", {
              kind: "tool-evidence",
              id: verification.verifierResult.verifierResultId,
              label: "verifier result",
              sessionId,
              turnId,
              metadata: { verdict: verification.verifierResult.verdict, evidenceIds: verification.verifierResult.evidenceIds }
            }, "verifier result", verification.verifierResult.verifierResultId)] : []),
            ...(verification.outputContract ? [visibleReasoningEvidence("diagnostic", {
              kind: "diagnostic",
              id: `output-contract:${verification.outputContract.contract.kind}`,
              label: "output contract",
              sessionId,
              turnId,
              metadata: { status: verification.outputContract.status, kind: verification.outputContract.contract.kind }
            }, "output contract", `${verification.outputContract.contract.kind}:${verification.outputContract.status}`)] : [])
          ]
        });
        yield verificationReasoning;
      }
      if (verification.repairRequested || verification.terminalStatus === "failed") {
        const verifierError = finalVerifierFailureError(verification.verifierResult, verification.outputContract);
        diagnostics.push(verifierError);
        if (iterations < limits.maxModelIterations) {
          const repairQueued = yield* emitFailureWithRepair("failed", "final-verifier-failed", verifierError, lastVerifierEvent(verification.events));
          if (repairQueued) {
            assistantText = "";
            continue;
          }
          terminalEmitted = true;
          return;
        }
      }
      const terminalStatus = verification.terminalStatus;
      const outcomeReasoning = await emitVisibleReasoning({
        actor: "runtime",
        stepKind: "outcome",
        status: terminalStatus === "completed" ? "completed" : "failed",
        summary: `Completed turn with status=${terminalStatus}; iterations=${iterations}; toolCalls=${toolCalls}.`,
        phase: "outcome",
        certainty: "verified",
        evidence: [visibleReasoningEvidence("trace", {
          kind: "turn",
          id: String(turnId),
          label: "turn outcome",
          sessionId,
          turnId,
          metadata: { iterations, toolCalls, diagnostics: diagnostics.length }
        }, "turn outcome")]
      });
      yield outcomeReasoning;
      const projectedReasoning = await emitVisibleReasoningProjection();
      yield projectedReasoning;
      const summary = summarizeAgentLoop(terminalStatus, request, sessionId, turnId, trace, assistantText, iterations, toolCalls, diagnostics, summaryMode());
      yield* recordLosslessAssistantMessage(deps, {
        sessionId,
        turnId,
        trace,
        content: assistantText,
        ...(losslessUserNodeId ? { userNodeId: losslessUserNodeId } : {}),
        ...(request.agentId ? { agentId: request.agentId } : {})
      });
      const completed = agentLoopEvent("turn.completed", sessionId, turnId, trace, summary, request.agentId);
      await recordRuntimeAdapterEvent(deps, completed);
      yield completed;
      const loopTerminal = agentLoopEvent(terminalStatus === "failed" ? "agent.loop.failed" : "agent.loop.completed", sessionId, turnId, trace, summary, request.agentId, terminalStatus === "failed" ? diagnostics.at(-1) : undefined);
      await recordRuntimeAdapterEvent(deps, loopTerminal);
      yield loopTerminal;
      terminalEmitted = true;
      return;
    }
  }

  if (!terminalEmitted) {
    const error = kernelError("KERNEL_QUEUE_BACKPRESSURE", "Agent loop model iteration limit exceeded", { maxModelIterations: limits.maxModelIterations });
    diagnostics.push(error);
    yield* emitFailureWithRepair("rejected", "model-iteration-limit", error);
  }
}

function isTerminalToolCompletion(capabilityId: string, terminal?: RuntimeEvent): boolean {
  return terminal?.kind === "capability.completed" && TERMINAL_TOOL_CAPABILITY_IDS.has(capabilityId);
}

function taskDecisionRuntimeStatus(envelope: TaskDecisionEnvelope): string {
  return [
    "Task decision recorded.",
    `Runtime execution, proof collection, and acceptance review are still required before delivery; planned steps=${envelope.planSteps.length}.`
  ].join(" ");
}

function withToolResultEvidence(
  context: EvidenceFirstRuntimeContext,
  toolEvents: readonly RuntimeEvent[],
  sessionId: SessionId,
  turnId: TurnId,
  trace: TraceContext
): EvidenceFirstRuntimeContext {
  const existingFingerprints = new Set(context.selectedEvidence.map((item) => item.fingerprint));
  const toolEvidence: EvidenceItem[] = [];
  for (const event of toolEvents) {
    if (event.kind !== "model.tool.result") continue;
    const feedback = event.data.feedback;
    if (!isToolFeedbackRecord(feedback)) continue;
    const preview = feedback.preview;
    if (!preview || typeof preview.text !== "string" || preview.text.trim().length === 0) continue;
    const fingerprint = `tool-result:${stableHash(`${feedback.toolCallId}:${preview.text}`)}`;
    if (existingFingerprints.has(fingerprint)) continue;
    existingFingerprints.add(fingerprint);
    toolEvidence.push({
      schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
      evidenceId: `evidence:${fingerprint}`,
      sourceGroup: "runtime-record",
      sourcePath: `tool:${feedback.toolName}:${feedback.toolCallId}`,
      sourceLabel: `${feedback.toolName} result`,
      factClasses: toolResultFactClasses(feedback.toolName, feedback.status),
      preview: preview.text,
      fingerprint,
      freshness: { status: "current" },
      trace: {
        traceId: trace.traceId,
        sessionId,
        turnId
      },
      compatibility: EVIDENCE_FIRST_COMPATIBILITY,
      redaction: { class: "internal", fields: ["preview"] }
    });
  }
  if (toolEvidence.length === 0) return context;
  return {
    ...context,
    selectedEvidence: [...context.selectedEvidence, ...toolEvidence],
    summary: {
      ...context.summary,
      evidenceItemCount: context.summary.evidenceItemCount + toolEvidence.length
    }
  };
}

function isToolFeedbackRecord(value: unknown): value is {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: string;
  readonly preview?: { readonly text?: string };
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.toolCallId === "string" && typeof record.toolName === "string" && typeof record.status === "string";
}

function toolResultFactClasses(toolName: string, status: string): readonly EvidenceFactClass[] {
  const classes = new Set<EvidenceFactClass>(["feature", "code", "evaluation"]);
  const lowerTool = toolName.toLowerCase();
  const lowerStatus = status.toLowerCase();
  if (lowerTool.includes("shell") || lowerTool.includes("command")) classes.add("command");
  if (lowerTool.includes("file") || lowerTool.includes("search")) classes.add("docs");
  if (lowerStatus !== "success") classes.add("architecture");
  return [...classes].sort((left, right) => left.localeCompare(right));
}

function modelOutputOptions(request: AgentLoopRequest): ModelOutputOptions | undefined {
  const contract = request.outputContract;
  if (contract?.kind !== "json-object" && contract?.kind !== "command-plan") return undefined;
  return {
    format: "json_object",
    ...(contract.schema ? { schema: contract.schema } : {}),
    ...(contract.description ? { description: contract.description } : {}),
    ...(contract.maxParseRetries !== undefined ? { maxParseRetries: contract.maxParseRetries } : {}),
    strict: true
  };
}

interface RestoredSessionHistory {
  readonly messages: readonly ModelChatMessage[];
  readonly sessionEventCount: number;
  readonly restoredNodeIds: readonly string[];
  readonly restoredSourceClasses: readonly string[];
  readonly diagnostics: readonly string[];
}

interface RestoredHistoryGroup {
  readonly messages: readonly ModelChatMessage[];
  readonly nodeId: string;
  readonly sourceClass: string;
}

async function restoreSessionHistory(deps: RuntimeDependencies, sessionId: SessionId): Promise<RestoredSessionHistory> {
  const events = await deps.sessions.events(sessionId);
  if (events.length === 0) {
    return { messages: [], sessionEventCount: 0, restoredNodeIds: [], restoredSourceClasses: [], diagnostics: [] };
  }
  if (!deps.losslessContext) {
    return { messages: [], sessionEventCount: events.length, restoredNodeIds: [], restoredSourceClasses: [], diagnostics: ["LOSSLESS_CONTEXT_UNAVAILABLE"] };
  }

  const toolIntents = new Map<string, ModelChatMessage>();
  for (const event of events) {
    if (event.kind !== "model.tool.intent") continue;
    const toolCallId = stringValue(event.payload.toolCallId);
    const name = stringValue(event.payload.name);
    const input = jsonObjectValue(event.payload.input);
    if (!toolCallId || !name || !input) continue;
    toolIntents.set(toolCallId, {
      role: "assistant",
      content: "",
      toolCalls: [{ id: toolCallId, name, input }]
    });
  }

  const newestGroups: RestoredHistoryGroup[] = [];
  let restoredMessageCount = 0;
  const emittedToolCallIds = new Set<string>();
  const lcmEvents = events
    .filter((event) => event.kind === "context.lcm.node-recorded")
    .slice(-RESTORED_HISTORY_MESSAGE_LIMIT * 2);

  for (let index = lcmEvents.length - 1; index >= 0; index -= 1) {
    const event = lcmEvents[index];
    if (!event) continue;
    const nodeId = stringValue(event.payload.nodeId);
    if (!nodeId) continue;
    const described = await deps.losslessContext.describe({ nodeId });
    const node = described.node;
    if (!node || node.kind === "summary" || node.role === "summary" || node.content.trim().length === 0) continue;
    const groupMessages: ModelChatMessage[] = [];
    if (node.role === "user") {
      groupMessages.push({ role: "user", content: boundedHistoryContent(node.content) });
    } else if (node.role === "assistant") {
      groupMessages.push({ role: "assistant", content: boundedHistoryContent(node.content) });
    } else if (node.role === "tool") {
      const toolCallId = stringValue(node.metadata.toolCallId);
      const toolName = stringValue(node.metadata.toolName);
      if (toolCallId) {
        const intent = toolIntents.get(toolCallId);
        if (intent && !emittedToolCallIds.has(toolCallId)) {
          groupMessages.push(intent);
          emittedToolCallIds.add(toolCallId);
        }
      }
      groupMessages.push({
        role: "tool",
        content: boundedHistoryContent(node.content),
        ...(toolCallId ? { toolCallId } : {}),
        ...(toolName ? { toolName } : {})
      });
    }
    if (groupMessages.length === 0) continue;
    if (restoredMessageCount + groupMessages.length > RESTORED_HISTORY_MESSAGE_LIMIT) continue;
    newestGroups.push({
      messages: groupMessages,
      nodeId: node.nodeId,
      sourceClass: node.sourceClass
    });
    restoredMessageCount += groupMessages.length;
    if (restoredMessageCount >= RESTORED_HISTORY_MESSAGE_LIMIT) break;
  }
  const selectedGroups = newestGroups.reverse();
  const messages = selectedGroups.flatMap((group) => group.messages);
  const restoredNodeIds = selectedGroups.map((group) => group.nodeId);
  const sourceClasses = selectedGroups.map((group) => group.sourceClass);

  return {
    messages,
    sessionEventCount: events.length,
    restoredNodeIds,
    restoredSourceClasses: [...new Set(sourceClasses)],
    diagnostics: []
  };
}

function providerRequestReplayEvidence(
  messages: readonly ModelChatMessage[],
  restored: RestoredSessionHistory,
  visibleToolCount: number,
  selectedHistoryMessageCount: number
): JsonObject {
  const toolResultCount = messages.filter((message) => message.role === "tool").length;
  const assistantToolCallCount = messages.reduce((count, message) => count + (message.toolCalls?.length ?? 0), 0);
  const reasoningContinuationCount = messages.filter((message) => typeof message.reasoningContent === "string" && message.reasoningContent.length > 0).length;
  const latestUserIndex = latestUserMessageIndex(messages);
  const historyMessageCount = latestUserIndex >= 0 ? messages.length - latestUserIndex - 1 : messages.length;
  return {
    schemaVersion: "1.0.0",
    status: restored.messages.length > 0 ? "restored" : restored.sessionEventCount > 0 ? "no-restorable-lossless-history" : "empty",
    sessionEventCount: restored.sessionEventCount,
    visibleToolCount,
    providerMessageCount: messages.length,
    selectedHistoryMessageCount,
    historyMessageCount,
    restoredMessageCount: restored.messages.length,
    messageRoleSequence: messages.map((message) => message.role),
    toolCallLinkage: {
      assistantToolCallCount,
      toolResultCount,
      paired: assistantToolCallCount === toolResultCount || toolResultCount === 0
    },
    losslessContextReferences: restored.restoredNodeIds,
    losslessSourceClasses: restored.restoredSourceClasses,
    reasoningContinuationCount,
    diagnostics: restored.diagnostics,
    replayFingerprint: `provider-request:${stableHash(JSON.stringify({
      roles: messages.map((message) => message.role),
      toolResultCount,
      assistantToolCallCount,
      reasoningContinuationCount,
      restoredNodeIds: restored.restoredNodeIds
    }))}`,
    redaction: { class: "internal", fields: ["losslessContextReferences", "diagnostics"] }
  };
}

function latestUserMessageIndex(messages: readonly ModelChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function boundedHistoryContent(value: string): string {
  return value.length > RESTORED_HISTORY_CONTENT_LIMIT ? value.slice(0, RESTORED_HISTORY_CONTENT_LIMIT) : value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function jsonObjectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function isRecoverableToolError(error: RedactedError | undefined): boolean {
  if (!error) return false;
  if (error.code === "KERNEL_SCHEDULER_TIMEOUT") return true;
  if (error.code !== "KERNEL_EXECUTOR_FAILED") return false;
  const details = jsonObjectValue(error.details);
  return typeof details?.originalCode === "string" && details.originalCode.length > 0;
}

function toolTimeoutFor(input: unknown, maxToolTimeoutMs: number, manifestTimeoutMs?: number): number {
  const upperBound = typeof manifestTimeoutMs === "number" && Number.isFinite(manifestTimeoutMs) && manifestTimeoutMs > 0
    ? Math.floor(manifestTimeoutMs)
    : maxToolTimeoutMs;
  const requested = jsonObjectValue(input)?.timeoutMs;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return upperBound;
  return Math.min(Math.floor(requested), upperBound);
}

function hasEligibleRepairCheckpoint(deps: RuntimeDependencies, sessionId: SessionId, turnId: TurnId): boolean {
  return deps.workspaceState.checkpoints().some((checkpoint) =>
    checkpoint.status === "eligible" &&
    checkpoint.sessionId === sessionId &&
    (!checkpoint.turnId || checkpoint.turnId === turnId)
  );
}

function modelReasoningOptions(
  reasoning: ModelReasoningOptions | undefined,
  mapping: AgentReasoningEffortMapping | undefined
): ModelReasoningOptions | undefined {
  if (!reasoning) return undefined;
  return {
    ...reasoning,
    ...(mapping?.providerEffort ? { providerEffort: mapping.providerEffort } : {})
  };
}

function repairFeedbackMessage(
  plan: SelfRepairPlan,
  classification: SelfRepairFailureClassification,
  error: RedactedError | undefined
): ModelChatMessage {
  return {
    role: "tool",
    toolCallId: plan.attemptId,
    toolName: "agent.self-repair",
    content: [
      "Self-repair feedback:",
      `Failure source: ${classification.failureSource}.`,
      `Affected scope: ${classification.affectedScope}.`,
      `Repair action: ${plan.actionType}.`,
      `Verification: ${plan.expectedVerification.join(", ") || "next model iteration"}.`,
      error ? `Diagnostic: ${error.code}: ${error.message}` : "Diagnostic: unavailable.",
      "Make the smallest bounded correction, use only visible governed tools, then stop or verify."
    ].join("\n")
  };
}

interface SweBenchVerificationGateState {
  readonly enabled: boolean;
  readonly runCapabilityRoutingEnabled: boolean;
  sourceInspectionToolCount: number;
  shellCommandCount: number;
  testCommandCount: number;
  successfulTestCommandCount: number;
  sourceMutationCount: number;
  diffInspectionCount: number;
  postVerificationShellCommandCount: number;
  inspectedSourcePaths: Set<string>;
  mutatedSourcePaths: Set<string>;
  completedSourceReadWindows: Set<string>;
  completedSourceInspectionSignatures: string[];
  focusedSourceReadAfterGateCount: number;
  sourceInspectionGateDefianceCount: number;
  duplicateSourceInspectionGateInserted: boolean;
  providerHistoryBounded: boolean;
  sourceInspectionGateInserted: boolean;
  postEditVerificationGateInserted: boolean;
  inserted: boolean;
  environmentBlockerInserted: boolean;
  preRunNonTerminalToolCount: number;
  runCapabilityInvoked: boolean;
  runCapabilityRoutingGateInserted: boolean;
  pendingRepoLocalRunnerCommand?: string;
  pendingRepoLocalRunnerPath?: string;
  repoLocalRunnerGateInserted: boolean;
  repoLocalRunnerAttempted: boolean;
}

function providerHistoryForRequest(
  messages: readonly ModelChatMessage[],
  sweBenchState: SweBenchVerificationGateState
): readonly ModelChatMessage[] {
  if (!sweBenchState.providerHistoryBounded) return messages;
  return sweBenchBoundedHistoryTail(messages);
}

function sweBenchBoundedHistoryTail(messages: readonly ModelChatMessage[]): readonly ModelChatMessage[] {
  const firstUserIndex = messages.findIndex((message) => message.role === "user");
  const prefix = firstUserIndex >= 0 ? [messages[firstUserIndex] as ModelChatMessage] : [];
  const tail = messages.slice(firstUserIndex >= 0 ? firstUserIndex + 1 : 0);
  const latestControlUserIndex = latestUserMessageIndex(tail);
  const retained: { readonly index: number; readonly message: ModelChatMessage }[] = [];
  if (latestControlUserIndex >= 0 && tail[latestControlUserIndex]) {
    retained.push({ index: latestControlUserIndex, message: tail[latestControlUserIndex] as ModelChatMessage });
  }
  let retainedToolResults = 0;
  let latestRetainedToolIndex: number | undefined;
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const message = tail[index];
    if (!message) continue;
    if (message.role === "tool") {
      if (retainedToolResults >= SWE_BENCH_PROVIDER_HISTORY_TOOL_TAIL_LIMIT) continue;
      retainedToolResults += 1;
      latestRetainedToolIndex = index;
      const previous = tail[index - 1];
      if (previous?.role === "assistant" && (previous.toolCalls?.length ?? 0) > 0) {
        retained.push({ index: index - 1, message: previous });
      }
      retained.push({ index, message: compactSweBenchProviderToolFeedback(message) });
      break;
    }
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      if (retainedToolResults >= SWE_BENCH_PROVIDER_HISTORY_TOOL_TAIL_LIMIT) continue;
      retainedToolResults += 1;
      retained.push({ index, message });
      break;
    }
  }
  const latestRetainedTool = latestRetainedToolIndex !== undefined ? tail[latestRetainedToolIndex] : undefined;
  if (latestRetainedToolIndex !== undefined && latestRetainedTool && isSweBenchSourceInspectionRejectionMessage(latestRetainedTool)) {
    const priorSourceEvidence = recentSuccessfulSourceInspectionPair(tail, latestRetainedToolIndex);
    for (const entry of priorSourceEvidence) {
      if (!retained.some((retainedEntry) => retainedEntry.index === entry.index)) retained.push(entry);
    }
  }
  const boundedTail = retained
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.message);
  return [...prefix, ...boundedTail];
}

function recentSuccessfulSourceInspectionPair(
  tail: readonly ModelChatMessage[],
  beforeIndex: number
): readonly { readonly index: number; readonly message: ModelChatMessage }[] {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const message = tail[index];
    if (!message || message.role !== "tool") continue;
    if (isSweBenchSourceInspectionRejectionMessage(message)) continue;
    if (!isSourceInspectionTool(String(message.toolName ?? ""))) continue;
    const pair: { readonly index: number; readonly message: ModelChatMessage }[] = [];
    const previous = tail[index - 1];
    if (previous?.role === "assistant" && (previous.toolCalls?.length ?? 0) > 0) {
      pair.push({ index: index - 1, message: previous });
    }
    pair.push({ index, message: compactSweBenchProviderToolFeedback(message) });
    return pair;
  }
  return [];
}

function isSweBenchSourceInspectionRejectionMessage(message: ModelChatMessage): boolean {
  return message.role === "tool" && (
    message.content.includes("SWE_BENCH_SOURCE_INSPECTION_DUPLICATE_GATE_ENFORCED") ||
    message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED")
  );
}

function compactSweBenchProviderToolFeedback(message: ModelChatMessage): ModelChatMessage {
  const byteLength = Buffer.byteLength(message.content, "utf8");
  if (byteLength <= SWE_BENCH_PROVIDER_TOOL_FEEDBACK_LIMIT_BYTES) return message;
  const text = boundedModelText(message.content, SWE_BENCH_PROVIDER_TOOL_FEEDBACK_LIMIT_BYTES);
  return {
    ...message,
    content: [
      `Provider-visible tool feedback truncated to ${SWE_BENCH_PROVIDER_TOOL_FEEDBACK_LIMIT_BYTES} bytes from ${byteLength} bytes.`,
      "Full output remains available in lossless trace and model.tool.result evidence.",
      "",
      text
    ].join("\n")
  };
}

function createSweBenchVerificationGateState(prompt: string): SweBenchVerificationGateState {
  const inheritedPatch = promptCarriesInheritedSweBenchPatch(prompt);
  const enabled = prompt.includes("Managed SWE-bench execution profile");
  const runCapabilityRoutingEnabled = isUserLevelSweBenchLiteTaskPrompt(prompt);
  return {
    enabled,
    runCapabilityRoutingEnabled,
    sourceInspectionToolCount: 0,
    shellCommandCount: 0,
    testCommandCount: 0,
    successfulTestCommandCount: 0,
    sourceMutationCount: inheritedPatch ? 1 : 0,
    diffInspectionCount: 0,
    postVerificationShellCommandCount: 0,
    inspectedSourcePaths: new Set<string>(),
    mutatedSourcePaths: new Set<string>(),
    completedSourceReadWindows: new Set<string>(),
    completedSourceInspectionSignatures: [],
    focusedSourceReadAfterGateCount: 0,
    sourceInspectionGateDefianceCount: 0,
    duplicateSourceInspectionGateInserted: false,
    providerHistoryBounded: enabled || runCapabilityRoutingEnabled || isSweBenchPrompt(prompt),
    sourceInspectionGateInserted: false,
    postEditVerificationGateInserted: false,
    inserted: false,
    environmentBlockerInserted: false,
    preRunNonTerminalToolCount: 0,
    runCapabilityInvoked: false,
    runCapabilityRoutingGateInserted: false,
    repoLocalRunnerGateInserted: false,
    repoLocalRunnerAttempted: false
  };
}

function isSweBenchPrompt(prompt: string): boolean {
  return /swe[- ]?bench/i.test(prompt);
}

function isUserLevelSweBenchLiteTaskPrompt(prompt: string): boolean {
  const normalized = prompt
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10))
    .toLowerCase();
  if (!/swe[- ]?bench\s+lite/.test(normalized)) return false;
  return (
    /第\s*\d{1,3}\s*(?:到|至|-|~)?\s*第?\s*\d{0,3}\s*(?:题|个|项|task|tasks|instance|instances)/i.test(normalized)
    || /\b(?:task|tasks|instance|instances)\s*#?\s*\d{1,3}\b/i.test(normalized)
    || /\b\d{1,3}\s*(?:st|nd|rd|th)?\s*(?:task|tasks|instance|instances)\b/i.test(normalized)
  );
}

function promptCarriesInheritedSweBenchPatch(prompt: string): boolean {
  return /Previous patch status:\s*non-empty patchBytes=[1-9]\d*/i.test(prompt);
}

function recordSweBenchVerificationGateToolIntent(state: SweBenchVerificationGateState, toolName: string, input: JsonObject): void {
  if (state.runCapabilityRoutingEnabled && !state.runCapabilityInvoked) {
    if (toolName === "core.swe.bench.run") {
      state.runCapabilityInvoked = true;
    } else {
      state.preRunNonTerminalToolCount += 1;
    }
  }
  if (!state.enabled) return;
  if (isSourceInspectionTool(toolName)) {
    state.sourceInspectionToolCount += 1;
    const inspectedPath = sourceInspectionReadPath(toolName, input);
    if (inspectedPath) state.inspectedSourcePaths.add(inspectedPath);
    return;
  }
  if (isSourceMutationTool(toolName)) {
    return;
  }
  if (isPatchReviewTool(toolName)) {
    state.diffInspectionCount += 1;
    return;
  }
  if (toolName === "core.test.run" || toolName === "test.run") {
    const commandText = shellCommandText(input);
    if (isPendingRepoLocalRunnerCommand(state, commandText)) state.repoLocalRunnerAttempted = true;
    if (commandText) state.testCommandCount += 1;
    return;
  }
  if (toolName !== "core.shell.run") return;
  const commandText = shellCommandText(input);
  if (!commandText) return;
  if (isPendingRepoLocalRunnerCommand(state, commandText)) state.repoLocalRunnerAttempted = true;
  state.shellCommandCount += 1;
  if (isStandardTestCommand(commandText)) state.testCommandCount += 1;
  if (state.sourceMutationCount > 0 && state.testCommandCount > 0 && !isStandardTestCommand(commandText)) {
    state.postVerificationShellCommandCount += 1;
  }
}

function recordSweBenchVerificationGateToolCompletion(
  state: SweBenchVerificationGateState,
  toolName: string,
  input: JsonObject,
  terminal: RuntimeEvent | undefined
): void {
  if (!state.enabled) return;
  if (isSourceInspectionTool(toolName) && terminal?.kind === "capability.completed") {
    const signature = sourceInspectionSignature(toolName, input);
    if (signature) state.completedSourceInspectionSignatures = [...state.completedSourceInspectionSignatures, signature].slice(-4);
  }
  if (toolName === "core.file.read" && terminal?.kind === "capability.completed") {
    const completedWindowKey = sourceReadWindowKey(toolName, input);
    if (completedWindowKey) state.completedSourceReadWindows.add(completedWindowKey);
  }
  if ((toolName === "core.test.run" || toolName === "test.run" || (toolName === "core.shell.run" && isStandardTestCommand(shellCommandText(input)))) && testCommandCompletedSuccessfully(terminal)) {
    state.successfulTestCommandCount += 1;
  }
  const repoLocalRunner = repoLocalRunnerActionFromTestFailure(terminal);
  if (repoLocalRunner && !state.repoLocalRunnerAttempted) {
    state.pendingRepoLocalRunnerCommand = repoLocalRunner.command;
    state.pendingRepoLocalRunnerPath = repoLocalRunner.path;
  }
  if (!isSourceMutationTool(toolName) || terminal?.kind !== "capability.completed") return;
  state.sourceMutationCount += 1;
  const mutatedPath = sourceToolPath(input);
  if (mutatedPath) state.mutatedSourcePaths.add(mutatedPath);
}

function repoLocalRunnerActionFromTestFailure(terminal: RuntimeEvent | undefined): { readonly command: string; readonly path: string } | undefined {
  const output = jsonObjectValue(terminal?.data.output);
  const evidence = jsonObjectValue(output?.evidence);
  const metadata = jsonObjectValue(evidence?.metadata);
  const testFailure = jsonObjectValue(metadata?.testFailure);
  const command = stringValue(testFailure?.alternateCommand);
  const path = stringValue(testFailure?.alternateRunnerPath);
  if (!command || !path) return undefined;
  return { command, path };
}

function isPendingRepoLocalRunnerCommand(state: SweBenchVerificationGateState, commandText: string): boolean {
  if (!commandText || !state.pendingRepoLocalRunnerCommand || !state.pendingRepoLocalRunnerPath) return false;
  return commandUsesRepoLocalRunner(commandText, state.pendingRepoLocalRunnerCommand, state.pendingRepoLocalRunnerPath);
}

function commandUsesRepoLocalRunner(commandText: string, alternateCommand: string, runnerPath: string): boolean {
  const normalized = normalizeShellCommandText(commandText);
  const normalizedAlternate = normalizeShellCommandText(alternateCommand);
  const normalizedPath = normalizeShellCommandText(runnerPath);
  if (normalizedAlternate && normalized.includes(normalizedAlternate)) return true;
  if (!normalizedPath) return false;
  return new RegExp(`(?:^|[\\s;&|])(?:[\\w./:-]*python[\\w./:-]*)\\s+${escapeRegExp(normalizedPath)}(?:\\s|$)`).test(normalized);
}

function normalizeShellCommandText(value: string): string {
  return value.replace(/\\/g, "/").replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shouldInsertSweBenchSourceInspectionGate(state: SweBenchVerificationGateState): boolean {
  return (
    state.enabled &&
    !state.sourceInspectionGateInserted &&
    state.sourceInspectionToolCount >= SWE_BENCH_SOURCE_INSPECTION_GATE_TOOL_THRESHOLD &&
    state.sourceMutationCount === 0 &&
    state.testCommandCount === 0
  );
}

function shouldInsertSweBenchVerificationGate(state: SweBenchVerificationGateState): boolean {
  return (
    state.enabled &&
    !state.inserted &&
    state.shellCommandCount >= SWE_BENCH_VERIFICATION_GATE_SHELL_THRESHOLD &&
    state.testCommandCount === 0
  );
}

function shouldInsertSweBenchPostEditVerificationGate(state: SweBenchVerificationGateState): boolean {
  return (
    state.enabled &&
    !state.postEditVerificationGateInserted &&
    state.sourceMutationCount > 0 &&
    state.testCommandCount === 0
  );
}

function shouldInsertSweBenchRepoLocalRunnerGate(state: SweBenchVerificationGateState): boolean {
  return (
    state.enabled &&
    !state.repoLocalRunnerGateInserted &&
    !state.repoLocalRunnerAttempted &&
    state.sourceMutationCount > 0 &&
    state.testCommandCount > 0 &&
    state.successfulTestCommandCount === 0 &&
    Boolean(state.pendingRepoLocalRunnerCommand && state.pendingRepoLocalRunnerPath)
  );
}

function shouldInsertSweBenchEnvironmentBlockerGate(state: SweBenchVerificationGateState): boolean {
  return (
    state.enabled &&
    !state.environmentBlockerInserted &&
    state.sourceMutationCount > 0 &&
    state.testCommandCount > 0 &&
    state.successfulTestCommandCount === 0 &&
    state.postVerificationShellCommandCount >= SWE_BENCH_ENVIRONMENT_BLOCKER_SHELL_THRESHOLD
  );
}

function shouldInsertSweBenchRunCapabilityRoutingGate(state: SweBenchVerificationGateState): boolean {
  return (
    state.runCapabilityRoutingEnabled &&
    !state.runCapabilityInvoked &&
    !state.runCapabilityRoutingGateInserted &&
    state.preRunNonTerminalToolCount >= SWE_BENCH_RUN_ROUTING_GATE_TOOL_THRESHOLD
  );
}

function shouldStopAtSweBenchRequestBudget(state: SweBenchVerificationGateState, modelRequestCount: number): boolean {
  return (
    state.enabled && modelRequestCount >= SWE_BENCH_MODEL_REQUEST_BUDGET
  ) || shouldStopAtSweBenchRunCapabilityRoutingBudget(state, modelRequestCount);
}

function shouldStopAtSweBenchRunCapabilityRoutingBudget(state: SweBenchVerificationGateState, modelRequestCount: number): boolean {
  return (
    state.runCapabilityRoutingEnabled &&
    !state.runCapabilityInvoked &&
    modelRequestCount >= SWE_BENCH_MODEL_REQUEST_BUDGET
  );
}

function recordSweBenchGatePolicyRejection(state: SweBenchVerificationGateState, terminalKind: string): void {
  if (terminalKind === "swe-bench-source-inspection-gate.rejected") {
    state.sourceInspectionGateDefianceCount += 1;
  }
  if (terminalKind === "swe-bench-source-inspection-duplicate.rejected") {
    if (state.duplicateSourceInspectionGateInserted) {
      state.sourceInspectionGateDefianceCount += 1;
    }
    state.duplicateSourceInspectionGateInserted = true;
  }
}

function shouldStopAtSweBenchSourceInspectionDefiance(state: SweBenchVerificationGateState, terminalKind: string): boolean {
  const sourceInspectionRejection =
    terminalKind === "swe-bench-source-inspection-gate.rejected" ||
    terminalKind === "swe-bench-source-inspection-duplicate.rejected";
  return (
    state.enabled &&
    sourceInspectionRejection &&
    state.sourceMutationCount === 0 &&
    state.testCommandCount === 0 &&
    state.sourceInspectionGateDefianceCount >= SWE_BENCH_SOURCE_INSPECTION_GATE_DEFIANCE_LIMIT
  );
}

function shouldCompleteSweBenchReadyForHarness(state: SweBenchVerificationGateState): boolean {
  return state.enabled && state.sourceMutationCount > 0 && state.successfulTestCommandCount > 0;
}

function shouldInsertSweBenchReadyForHarnessGate(state: SweBenchVerificationGateState): boolean {
  return shouldCompleteSweBenchReadyForHarness(state);
}

function testCommandCompletedSuccessfully(terminal: RuntimeEvent | undefined): boolean {
  if (terminal?.kind !== "capability.completed") return false;
  const output = jsonObjectValue(terminal.data.output);
  const evidence = jsonObjectValue(output?.evidence);
  if (!evidence) return false;
  const status = typeof evidence.status === "string" ? evidence.status : "";
  const metadata = jsonObjectValue(evidence.metadata);
  return status === "completed" && metadata?.exitCode === 0;
}

interface SweBenchGatePolicyRejection {
  readonly error: RedactedError;
  readonly terminalKind: string;
}

function applyWorkflowGateOverride(
  profilePolicy: AgentLoopProfilePolicyMetadata | undefined,
  input: {
    readonly terminalKind: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly capabilityId: string;
    readonly error: RedactedError;
  }
): AgentLoopProfilePolicyMetadata | undefined {
  if (!profilePolicy?.stagedTaskWorkflow) return profilePolicy;
  const details = jsonObjectValue(input.error.details);
  if (!details) return profilePolicy;
  const requiredNextAction = stringField(details, "requiredNextAction");
  const gate = stringField(details, "gate");
  if (!requiredNextAction || !gate) return profilePolicy;
  return {
    ...profilePolicy,
    workflowGateOverride: {
      gate,
      requiredNextAction: providerFacingWorkflowGateAction(requiredNextAction),
      rejectedToolName: input.toolName,
      rejectedCapabilityId: input.capabilityId,
      terminalKind: input.terminalKind,
      toolCallId: input.toolCallId
    }
  };
}

function clearWorkflowGateOverride(profilePolicy: AgentLoopProfilePolicyMetadata): AgentLoopProfilePolicyMetadata {
  if (!profilePolicy.workflowGateOverride) return profilePolicy;
  const { workflowGateOverride: _workflowGateOverride, ...rest } = profilePolicy;
  return rest;
}

function providerFacingWorkflowGateAction(requiredNextAction: string): string {
  if (requiredNextAction === "source-edit-or-test-or-blocker") {
    return "source-edit-or-test-or-bounded-blocker";
  }
  return requiredNextAction;
}

function shouldClearWorkflowGateOverride(
  override: AgentLoopProfilePolicyMetadata["workflowGateOverride"] | undefined,
  toolName: string,
  toolInput: JsonObject,
  terminal: RuntimeEvent | undefined
): boolean {
  if (!override || terminal?.kind !== "capability.completed") return false;
  const commandText = shellCommandText(toolInput);
  if (override.requiredNextAction === "source-edit-or-test-or-bounded-blocker") {
    return isSourceMutationTool(toolName) ||
      toolName === "core.test.run" ||
      toolName === "test.run" ||
      (toolName === "core.shell.run" && isStandardTestCommand(commandText));
  }
  if (override.requiredNextAction === "standard-test-command-or-bounded-blocker" || override.requiredNextAction === "standard-test-command") {
    return toolName === "core.test.run" ||
      toolName === "test.run" ||
      (toolName === "core.shell.run" && isStandardTestCommand(commandText));
  }
  return false;
}

function sweBenchGatePolicyRejection(state: SweBenchVerificationGateState, toolName: string, input: JsonObject): SweBenchGatePolicyRejection | undefined {
  const commandText = toolCommandTextForSweBenchGate(toolName, input);
  const isShellRunTool = toolName === "core.shell.run";
  const isTestTool = toolName === "core.test.run" || toolName === "test.run";
  if (
    state.runCapabilityRoutingEnabled &&
    state.runCapabilityRoutingGateInserted &&
    !state.runCapabilityInvoked &&
    toolName !== "core.swe.bench.run"
  ) {
    return {
      terminalKind: "swe-bench-run-capability-routing-gate.rejected",
      error: kernelError(
        "KERNEL_POLICY_DENIED",
        "SWE_BENCH_RUN_CAPABILITY_ROUTING_GATE_ENFORCED: the previous SWE_BENCH_RUN_CAPABILITY_ROUTING_GATE requires invoking core.swe.bench.run for this numbered SWE-bench Lite task, or reporting a bounded blocker without more non-run tool calls.",
        {
          gate: "SWE_BENCH_RUN_CAPABILITY_ROUTING_GATE",
          requiredNextAction: "core.swe.bench.run-or-bounded-blocker",
          rejectedToolName: toolName,
          rejectedInput: input
        }
      )
    };
  }
  if (
    state.enabled &&
    !state.sourceInspectionGateInserted &&
    state.duplicateSourceInspectionGateInserted &&
    state.sourceMutationCount === 0 &&
    state.testCommandCount === 0 &&
    (isSourceInspectionTool(toolName) || (toolName === "core.shell.run" && (!commandText || !isStandardTestCommand(commandText))))
  ) {
    return {
      terminalKind: "swe-bench-source-inspection-duplicate.rejected",
      error: kernelError(
        "KERNEL_POLICY_DENIED",
        "SWE_BENCH_SOURCE_INSPECTION_DUPLICATE_GATE_ENFORCED: this managed SWE-bench run already has enough source-inspection evidence after a duplicate read/search request. Reuse the existing evidence and make the smallest source edit, run a standard test command, or report a bounded blocker instead of continuing read-location exploration.",
        {
          gate: "SWE_BENCH_SOURCE_INSPECTION_DUPLICATE_GATE",
          requiredNextAction: "source-edit-or-test-or-blocker",
          rejectedToolName: toolName,
          ...(commandText ? { rejectedCommand: commandText } : {}),
          rejectedInput: input
        }
      )
    };
  }
  if (
    state.enabled &&
    !state.sourceInspectionGateInserted &&
    state.sourceMutationCount === 0 &&
    state.testCommandCount === 0 &&
    isSourceInspectionTool(toolName) &&
    isDuplicateSourceInspectionRequest(state, toolName, input)
  ) {
    const signature = sourceInspectionSignature(toolName, input);
    return {
      terminalKind: "swe-bench-source-inspection-duplicate.rejected",
      error: kernelError(
        "KERNEL_POLICY_DENIED",
        "SWE_BENCH_SOURCE_INSPECTION_DUPLICATE_GATE_ENFORCED: this managed SWE-bench run already has the same source-inspection evidence. Reuse the existing evidence and make the smallest source edit, run a standard test command, or report a bounded blocker instead of rereading the same location.",
        {
          gate: "SWE_BENCH_SOURCE_INSPECTION_DUPLICATE_GATE",
          requiredNextAction: "source-edit-or-test-or-blocker",
          rejectedToolName: toolName,
          ...(signature ? { duplicateSignature: signature } : {}),
          rejectedInput: input
        }
      )
    };
  }
  if (
    state.enabled &&
    state.sourceInspectionGateInserted &&
    state.sourceMutationCount === 0 &&
    state.testCommandCount === 0 &&
    (isSourceInspectionTool(toolName) || (toolName === "core.shell.run" && (!commandText || !isStandardTestCommand(commandText))))
  ) {
    if (isFocusedSourceReadAfterInspectionGate(state, toolName, input)) {
      state.focusedSourceReadAfterGateCount += 1;
      return undefined;
    }
    return {
      terminalKind: "swe-bench-source-inspection-gate.rejected",
      error: kernelError(
        "KERNEL_POLICY_DENIED",
        "SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED: the previous SWE_BENCH_SOURCE_INSPECTION_GATE requires concrete progress before more read/search/list exploration or non-test shell setup. Make the smallest source edit, run a standard test command, or report a bounded blocker.",
        {
          gate: "SWE_BENCH_SOURCE_INSPECTION_GATE",
          requiredNextAction: "source-edit-or-test-or-blocker",
          rejectedToolName: toolName,
          ...(commandText ? { rejectedCommand: commandText } : {}),
          rejectedInput: input
        }
      )
    };
  }
  if (
    state.enabled &&
    state.postEditVerificationGateInserted &&
    state.testCommandCount === 0 &&
    (isSourceInspectionTool(toolName) || (toolName === "core.shell.run" && (!commandText || !isStandardTestCommand(commandText))))
  ) {
    return {
      terminalKind: "swe-bench-post-edit-verification-gate.rejected",
      error: kernelError(
        "KERNEL_POLICY_DENIED",
        "SWE_BENCH_POST_EDIT_VERIFICATION_GATE_ENFORCED: the previous SWE_BENCH_POST_EDIT_VERIFICATION_GATE requires the next action to be a standard test command or bounded blocker report. Run pytest, python -m pytest, python -m unittest, tox, nox, npm test, or the repository package test runner before more read/search/list or setup actions.",
        {
          gate: "SWE_BENCH_POST_EDIT_VERIFICATION_GATE",
          requiredNextAction: "standard-test-command-or-bounded-blocker",
          rejectedToolName: toolName,
          ...(commandText ? { rejectedCommand: commandText } : {}),
          rejectedInput: input
        }
      )
    };
  }
  if (isBroadSourceInspectionAfterTest(state, toolName, input)) {
    return {
      terminalKind: "swe-bench-post-test-source-read.rejected",
      error: kernelError(
        "KERNEL_POLICY_DENIED",
        "SWE_BENCH_POST_TEST_CONVERGENCE_GATE_ENFORCED: this managed SWE-bench run already has source edit and test evidence. Avoid broad source exploration after tests; use a focused same-file read with offset/limit, make the smallest source adjustment, run another standard test, or return control for official harness scoring.",
        {
          gate: "SWE_BENCH_POST_TEST_CONVERGENCE_GATE",
          requiredNextAction: "focused-read-or-source-edit-or-test-or-return-control",
          rejectedToolName: toolName,
          rejectedInput: input
        }
      )
    };
  }
  if (!state.enabled) return undefined;
  if (!commandText) return undefined;
  if (
    state.repoLocalRunnerGateInserted &&
    !state.repoLocalRunnerAttempted &&
    state.pendingRepoLocalRunnerCommand &&
    state.pendingRepoLocalRunnerPath &&
    !commandUsesRepoLocalRunner(commandText, state.pendingRepoLocalRunnerCommand, state.pendingRepoLocalRunnerPath) &&
    (isTestTool || isStandardTestCommand(commandText) || isSweBenchEnvironmentSetupCommand(commandText))
  ) {
    return {
      terminalKind: "swe-bench-repo-local-runner-gate.rejected",
      error: kernelError(
        "KERNEL_POLICY_DENIED",
        `SWE_BENCH_REPO_LOCAL_RUNNER_GATE_ENFORCED: the previous SWE_BENCH_REPO_LOCAL_RUNNER_GATE requires trying the repo-local Python test runner before repeating tests or setup probes. Rerun the focused test from the checkout root with: ${state.pendingRepoLocalRunnerCommand}.`,
        {
          gate: "SWE_BENCH_REPO_LOCAL_RUNNER_GATE",
          requiredNextAction: "repo-local-python-test-runner",
          alternateCommand: state.pendingRepoLocalRunnerCommand,
          alternateRunnerPath: state.pendingRepoLocalRunnerPath,
          rejectedToolName: toolName,
          rejectedCommand: commandText
        }
      )
    };
  }
  if (!isShellRunTool) return undefined;
  if (state.postEditVerificationGateInserted && state.testCommandCount === 0 && !isStandardTestCommand(commandText)) {
    return {
      terminalKind: "swe-bench-post-edit-verification-gate.rejected",
      error: kernelError(
        "KERNEL_POLICY_DENIED",
        "SWE_BENCH_POST_EDIT_VERIFICATION_GATE_ENFORCED: the previous SWE_BENCH_POST_EDIT_VERIFICATION_GATE requires the next action to be a standard test command or bounded blocker report. Run pytest, python -m pytest, python -m unittest, tox, nox, npm test, or the repository package test runner before more read/search/list or setup actions.",
        {
          gate: "SWE_BENCH_POST_EDIT_VERIFICATION_GATE",
          requiredNextAction: "standard-test-command-or-bounded-blocker",
          rejectedToolName: toolName,
          rejectedCommand: commandText
        }
      )
    };
  }
  if (state.inserted && state.testCommandCount === 0 && !isStandardTestCommand(commandText)) {
    return {
      terminalKind: "swe-bench-verification-gate.rejected",
      error: kernelError(
        "KERNEL_POLICY_DENIED",
        "SWE_BENCH_VERIFICATION_GATE_ENFORCED: the previous SWE_BENCH_VERIFICATION_GATE requires the next shell action to be a standard test command. Run pytest, python -m pytest, python -m unittest, tox, nox, npm test, or the repository package test runner before more setup/probing shell commands.",
        {
          gate: "SWE_BENCH_VERIFICATION_GATE",
          requiredNextAction: "standard-test-command",
          rejectedToolName: toolName,
          rejectedCommand: commandText
        }
      )
    };
  }
  if (state.environmentBlockerInserted && isSweBenchEnvironmentSetupCommand(commandText)) {
    return {
      terminalKind: "swe-bench-environment-blocker-gate.rejected",
      error: kernelError(
        "KERNEL_POLICY_DENIED",
        "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE_ENFORCED: the previous SWE_BENCH_ENVIRONMENT_BLOCKER_GATE rejected another dependency setup/probing shell command. Return control with the current diff, run a standard test if needed, or report the local environment blocker instead of spending more shell iterations on setup.",
        {
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          rejectedAction: "environment-setup-or-dependency-probe",
          rejectedToolName: toolName,
          rejectedCommand: commandText
        }
      )
    };
  }
  return undefined;
}

function isNonFatalSweBenchGateRejection(terminalKind: string): boolean {
  return terminalKind === "swe-bench-post-test-source-read.rejected" || terminalKind === "swe-bench-source-inspection-duplicate.rejected";
}

function isSourceMutationTool(toolName: string): boolean {
  return toolName === "core.file.edit" || toolName === "core.file.write" || toolName === "core.patch.apply";
}

function isSourceInspectionTool(toolName: string): boolean {
  return toolName === "core.file.read" || toolName === "core.file.list" || toolName === "core.search.text" || toolName === "core.workspace.glob";
}

function isPatchReviewTool(toolName: string): boolean {
  return toolName === "core.git.diff" || toolName === "git.diff";
}

function isFocusedSourceReadAfterInspectionGate(state: SweBenchVerificationGateState, toolName: string, input: JsonObject): boolean {
  const path = sourceInspectionReadPath(toolName, input);
  const windowKey = sourceReadWindowKey(toolName, input);
  return path !== undefined &&
    windowKey !== undefined &&
    state.inspectedSourcePaths.has(path) &&
    !state.completedSourceReadWindows.has(windowKey) &&
    state.focusedSourceReadAfterGateCount < SWE_BENCH_SOURCE_INSPECTION_GATE_FOCUSED_READ_LIMIT;
}

function isDuplicateSourceInspectionRequest(state: SweBenchVerificationGateState, toolName: string, input: JsonObject): boolean {
  const signature = sourceInspectionSignature(toolName, input);
  if (signature === undefined || !isDuplicateEligibleSourceInspection(toolName, input)) return false;
  return state.completedSourceInspectionSignatures.slice(-2).includes(signature) || isOverlappingCompletedSourceReadWindow(state, toolName, input);
}

function sourceInspectionSignature(toolName: string, input: JsonObject): string | undefined {
  if (toolName === "core.file.read") {
    const path = sourceToolPath(input);
    if (!path) return undefined;
    const offset = numberField(input, "offset");
    const limit = numberField(input, "limit");
    return `read:${path}:${offset ?? "whole"}:${limit ?? "all"}`;
  }
  if (toolName === "core.file.list") {
    const path = sourceToolPath(input);
    return path ? `list:${path}` : undefined;
  }
  if (toolName === "core.search.text") {
    const pattern = stringField(input, "pattern");
    if (!pattern) return undefined;
    return [
      "search",
      pattern,
      stringField(input, "glob") ?? "",
      stringField(input, "outputMode") ?? "",
      numberField(input, "contextLines") ?? ""
    ].join(":");
  }
  if (toolName === "core.workspace.glob") {
    const pattern = stringField(input, "pattern");
    return pattern ? `glob:${pattern}` : undefined;
  }
  return undefined;
}

function isDuplicateEligibleSourceInspection(toolName: string, input: JsonObject): boolean {
  return toolName === "core.search.text" || (toolName === "core.file.read" && boundedSourceReadWindow(input));
}

function sourceInspectionReadPath(toolName: string, input: JsonObject): string | undefined {
  if (toolName !== "core.file.read") return undefined;
  return sourceToolPath(input);
}

function sourceReadWindowKey(toolName: string, input: JsonObject): string | undefined {
  const window = sourceReadWindow(toolName, input);
  return window ? `${window.path}:${window.offset}:${window.limit}` : undefined;
}

interface SourceReadWindow {
  readonly path: string;
  readonly offset: number;
  readonly limit: number;
  readonly end: number;
}

function sourceReadWindow(toolName: string, input: JsonObject): SourceReadWindow | undefined {
  const path = sourceInspectionReadPath(toolName, input);
  if (!path || !boundedSourceReadWindow(input)) return undefined;
  const offset = numberField(input, "offset");
  const limit = numberField(input, "limit");
  if (offset === undefined || limit === undefined) return undefined;
  return { path, offset, limit, end: offset + limit };
}

function sourceReadWindowFromKey(key: string): SourceReadWindow | undefined {
  const serialized = key.startsWith("read:") ? key.slice("read:".length) : key;
  const match = /^(.*):(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(serialized);
  if (!match) return undefined;
  const path = match[1];
  const offset = Number(match[2]);
  const limit = Number(match[3]);
  if (!path || !Number.isFinite(offset) || !Number.isFinite(limit) || limit <= 0) return undefined;
  return { path, offset, limit, end: offset + limit };
}

function isOverlappingCompletedSourceReadWindow(state: SweBenchVerificationGateState, toolName: string, input: JsonObject): boolean {
  const current = sourceReadWindow(toolName, input);
  if (!current) return false;
  for (const completedSignature of state.completedSourceInspectionSignatures.slice(-2)) {
    const completed = sourceReadWindowFromKey(completedSignature);
    if (!completed || completed.path !== current.path) continue;
    const overlap = Math.max(0, Math.min(current.end, completed.end) - Math.max(current.offset, completed.offset));
    if (overlap / current.limit >= SWE_BENCH_SOURCE_READ_DUPLICATE_OVERLAP_RATIO) return true;
  }
  return false;
}

function sourceToolPath(input: JsonObject): string | undefined {
  const path = typeof input.path === "string" ? input.path.trim() : "";
  if (!path) return undefined;
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function boundedSourceReadWindow(input: JsonObject): boolean {
  const offset = numberField(input, "offset");
  const limit = numberField(input, "limit");
  return offset !== undefined && offset >= 0 && limit !== undefined && limit > 0 && limit <= 200;
}

function numberField(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isBroadSourceInspectionAfterTest(state: SweBenchVerificationGateState, toolName: string, input: JsonObject): boolean {
  if (!state.enabled || state.sourceMutationCount === 0 || state.testCommandCount === 0) return false;
  if (!isSourceInspectionTool(toolName)) return false;
  return !isFocusedSourceReadAfterTest(state, toolName, input);
}

function isFocusedSourceReadAfterTest(state: SweBenchVerificationGateState, toolName: string, input: JsonObject): boolean {
  const path = sourceInspectionReadPath(toolName, input);
  if (!path || !state.mutatedSourcePaths.has(path)) return false;
  return boundedSourceReadWindow(input);
}

function shellCommandText(input: JsonObject): string {
  const command = typeof input.command === "string" ? input.command : "";
  if (!command) return "";
  const args = Array.isArray(input.args) ? input.args.filter((item): item is string => typeof item === "string") : [];
  return [command, ...args].join(" ");
}

function toolCommandTextForSweBenchGate(toolName: string, input: JsonObject): string | undefined {
  if (toolName === "core.shell.run" || toolName === "core.test.run" || toolName === "test.run") {
    return shellCommandText(input);
  }
  return undefined;
}

function isSweBenchEnvironmentSetupCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    /(^|[;&|]\s*)(?:[\w./-]*python[\w./-]*\s+-m\s+)?pip\s+(?:install|download|wheel|sync|compile)(\s|$)/.test(normalized)
    || /(^|[;&|]\s*)uv\s+(?:pip\s+)?(?:install|sync|add|update)(\s|$)/.test(normalized)
    || /(^|[;&|]\s*)(?:poetry|pipenv|conda|mamba)\s+(?:install|sync|add|update|create)(\s|$)/.test(normalized)
    || /(^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:install|add|update|ci)(\s|$)/.test(normalized)
    || /\b(?:source|\.)\s+[^;&|]*venv[^;&|]*activate\b/.test(normalized)
  );
}

function finalVerifierFailureError(verifierResult: AgentVerifierResult | undefined, outputContract: AgentLoopOutputContractVerification | undefined): RedactedError {
  if (outputContract?.status === "fail") {
    return kernelError("KERNEL_ENVELOPE_INVALID", "Output contract verification failed; repair the final answer or required artifact before stopping.", {
      contractKind: outputContract.contract.kind,
      requiredPath: outputContract.contract.path ?? "assistant-response",
      diagnostics: outputContract.diagnostics.slice(0, 5).map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message
      }))
    });
  }
  return kernelError("KERNEL_ENVELOPE_INVALID", "Final verifier failed; revise the result and collect independent verification evidence before stopping.", {
    verifierResultId: verifierResult?.verifierResultId ?? "unknown",
    verdict: verifierResult?.verdict ?? "unknown",
    diagnostics: (verifierResult?.diagnostics ?? []).slice(0, 5).map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message
    }))
  });
}

function lastVerifierEvent(events: readonly RuntimeEvent[]): RuntimeEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "agent.verifier.verdict") return event;
  }
  return undefined;
}

function visibleStatusForTerminal(status: AgentLoopSummary["status"]): VisibleReasoningStatus {
  if (status === "completed") return "completed";
  if (status === "cancelled" || status === "rejected") return "blocked";
  return "failed";
}
