import type {
  AgentLoopControl,
  AgentLoopLimits,
  AgentLoopOutputContract,
  AgentLoopOutputContractVerification,
  AgentLoopRequest,
  AgentLoopSummary,
  AgentLoopProfileWorkflowGateOverride,
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
  PromptSchedulingNextAction,
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
  SessionEvent,
  SessionId,
  TaskDecisionEnvelope,
  TraceContext,
  TurnId,
  VisibleReasoningProjection,
  VisibleReasoningRecord,
  VisibleReasoningStatus
} from "@deepseek/platform-contracts";
import { EVIDENCE_FIRST_COMPATIBILITY, EVIDENCE_FIRST_SCHEMA_VERSION, asId } from "@deepseek/platform-contracts";
import { modelToolSchema } from "@deepseek/prompt-assembly";
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
import { advanceWorkflowStageFromToolEvidence, extractSkillActivateMetadata, isAllowedEvaluationReproductionToolInput, projectProviderCacheToolSet, projectToolSet, projectWorkflowGateOverrideTools, recordToolResultEvidence, workflowCapabilityBoundaryGuard } from "./agent-loop-tools.js";
import { consumedBudgetEvents, createAgentLoopBudget } from "./modes/budgets.js";
import {
  createReadyStageBudgetUsage,
  nextReadyStageBudgetUsage,
  readyStageBudgetEventData,
  readyStageBudgetForControl,
  readyStageBudgetKey,
  readyStageBudgetReviewMessage
} from "./ready-stage-budget.js";
import {
  READY_STAGE_REQUIRED_ACTION_CORRECTION_LIMIT,
  mutationExactRefreshCorrectionMessage,
  officialRepairRequiredActionCorrectionMessage,
  readyStageAntiLoopInstruction,
  readyStageNonProgressCapabilityMiss,
  readyStageProgressCapabilitySatisfied,
  readyStageRequiredActionCorrectionMessage,
  readyStageRequiredActionMissKey,
  standardTestRepairRequiredActionCorrectionMessage
} from "./ready-stage-control.js";
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
import { isStandardTestCommand } from "@deepseek/core-coding-tools";
import { projectReasoningForOutput, recordVisibleReasoning, recordVisibleReasoningProjection, visibleReasoningEvidence } from "./visible-reasoning.js";
import { terminalSearchEvidenceHasContent } from "./agent-loop-tool-evidence.js";
import {
  createTaskDeliveryFlowSummary,
  parseTaskDecisionEnvelopeText,
  taskDecisionEnvelopeEventData,
  taskDeliveryFlowEventData,
  taskDeliveryFlowWithDecisionData
} from "./task-delivery-flow.js";
import {
  createToolDecisionBoardState,
  normalizeToolInputHash,
  feedbackStatusToDecisionStatus,
  recordFailureAnalysis,
  recordRejectedIntent,
  recordRejectedToolFeedback,
  recordToolDecision,
  shouldSuppressRepeatedMutationFailure,
  shouldSuppressRepeatedRejectedIntent,
  toolDecisionBoardSnapshot
} from "./tool-decision-board.js";
import {
  buildDispatchTerminalSummary,
  buildDeniedDispatchFeedback,
  buildDeniedDispatchResult,
  buildRejectedDispatchFeedback,
  buildRejectedDispatchResult,
  correctiveActionForToolFeedback,
  isRecoverableToolError,
  outputContractArtifactPathRejection,
  recommendedNextActionForToolFeedback,
  toolTimeoutFor
} from "./agent-loop-tool-dispatch.js";
import {
  readyStageRequiredActionConvergence,
  readyStageToolBudgetConvergence,
  repeatedRejectedIntentConvergence,
  terminalToolConvergence
} from "./agent-loop-convergence.js";
import { planToolDispatchBatch } from "./agent-loop-tool-batches.js";
import { isMutationCapabilityId, isStandardTestExecutionCapabilityId, isTestCapabilityId, progressCapabilityIdsForWorkflowStage } from "./workflow-capability-policy.js";
import {
  acceptStageEvidenceRead,
  acceptStageEvidenceSearch,
  createStageEvidenceWindow,
  focusedStageEvidenceSearchGlob,
  nextStageEvidenceReadOffset,
  stageEvidenceRequestDecision,
  stageEvidenceWindowShouldClose,
  type StageEvidenceWindowState
} from "./stage-evidence-convergence.js";

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
const FAILED_STANDARD_TEST_REPAIR_FOCUSED_REFRESH_LIMIT = 4;
const OFFICIAL_DIAGNOSTIC_REPAIR_FOCUSED_REFRESH_LIMIT = 4;
const STANDARD_TEST_REQUIRED_CLOSURE_MODEL_ITERATION_RESERVE = 2;

interface MutationExactRefreshState {
  readonly targetPath: string;
  readonly failedToolCallId: string;
  readonly consumed: boolean;
}

export async function* runAgentLoop(
  deps: RuntimeDependencies,
  kernel: RuntimeKernel,
  request: AgentLoopRequest,
  control: AgentLoopControl = {}
): AsyncIterable<RuntimeEvent> {
  const sessionId = request.sessionId ?? await deps.sessions.create({ caller: request.caller, workspaceRoot: request.workspaceRoot });
  const trace: TraceContext = request.trace ?? runtimeTrace(sessionId, "agent-loop");
  const turnId = asId<"turn">(`turn-${stableHash(`${sessionId}:${request.prompt}`)}`);
  const baseLimits = { ...defaultAgentLoopLimits, ...(request.limits ?? {}) };
  const limits = request.timeoutMs && request.timeoutMs > baseLimits.turnTimeoutMs
    ? { ...baseLimits, turnTimeoutMs: request.timeoutMs }
    : baseLimits;
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
  let activeWorkflowGateOverride: AgentLoopProfileWorkflowGateOverride | undefined;
  let repairContinuationRequested = false;
  let toolEvidenceEvents: RuntimeEvent[] = [];
  let outputContractVerification: AgentLoopOutputContractVerification | undefined;
  const restoredHistory = await restoreSessionHistory(deps, sessionId);
  const messages: ModelChatMessage[] = [
    ...restoredHistory.messages,
    { role: "user", content: request.prompt },
    ...(request.initialMessages ?? [])
  ];
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
  let currentReadyStageControl: JsonObject | undefined;
  const readyStageRequiredActionMisses = new Map<string, number>();
  const readyStageMutationRepairMisses = new Map<string, number>();
  const readyStageEditRepairFailures = new Set<string>();
  const readyStagePatchRepairFailures = new Set<string>();
  const readyStageMutationInputStalls = new Map<string, number>();
  const readyStageMutationRepairHadFocusedRefresh = new Set<string>();
  const failedStandardTestRepairFocusedRefreshCounts = new Map<string, number>();
  const officialDiagnosticRepairFocusedRefreshCounts = new Map<string, number>();
  const openedStageEvidenceWindows = new Set<string>();
  const stageEvidenceWindows = new Map<string, StageEvidenceWindowState>();
  const evaluationBehaviorReproductionSatisfied = new Set<string>();
  const mutationExactRefreshByStage = new Map<string, MutationExactRefreshState>();
  const readyStageProgressEvidenceCounts = new Map<string, number>();
  const readyStageBudgetUsage = new Map<string, ReturnType<typeof createReadyStageBudgetUsage>>();
  const toolDecisionBoard = createToolDecisionBoardState({ sessionId, turnId });
  const acceptedSourceEvidencePaths = new Set<string>();

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

  const emitDecisionBoardSnapshot = async function* (): AsyncGenerator<RuntimeEvent, void, void> {
    const availableCapabilities = await deps.capabilities.listModelVisible();
    const snapshotRequest: AgentLoopRequest = {
      ...request,
      ...(activeProfilePolicy ? { profilePolicy: activeProfilePolicy } : {})
    };
    const projectedCapabilities = projectToolSet(availableCapabilities, snapshotRequest);
    const visibleCapabilities = projectWorkflowGateOverrideTools(
      projectedCapabilities,
      activeWorkflowGateOverride,
      { preferCanonicalCoreActions: true }
    );
    const activeStageId = currentReadyStageControl && typeof currentReadyStageControl.stageId === "string"
      ? currentReadyStageControl.stageId
      : undefined;
    const decisionBoard = toolDecisionBoardSnapshot({
      state: toolDecisionBoard,
      iteration: iterations,
      activeProfileId: activeProfilePolicy?.profileId ?? request.profile.id,
      ...(activeStageId ? { activeStageId } : {}),
      availableCapabilities,
      visibleCapabilities,
      ...(activeProfilePolicy ? { profilePolicy: projectionEvidencePolicy(activeProfilePolicy, currentReadyStageControl) } : {})
    });
    const event = agentLoopEvent("tool.decision-board.snapshot", sessionId, turnId, trace, decisionBoard, request.agentId);
    await recordRuntimeAdapterEvent(deps, event);
    yield event;
  };

  const recordLoopFailureAnalysis = (input: {
    readonly reason: string;
    readonly status: AgentLoopSummary["status"];
    readonly error?: RedactedError;
    readonly event?: RuntimeEvent;
  }) => {
    const stageId = currentReadyStageControl && typeof currentReadyStageControl.stageId === "string"
      ? currentReadyStageControl.stageId
      : undefined;
    const terminalKind = input.event?.kind ?? input.reason;
    return recordFailureAnalysis(toolDecisionBoard, {
      attemptId: `attempt:${turnId}:${input.reason}:${iterations}`,
      ...(stageId ? { stageId } : {}),
      terminalKind,
      failureClass: failureClassForLoopTerminal(input.reason, input.status),
      attribution: attributionForLoopTerminal(input.reason, input.error),
      proofStatus: "proven",
      evidenceQueries: evidenceQueriesForLoopTerminal(input.reason),
      acceptedEvidenceRefs: [
        `turn:${turnId}`,
        `terminal:${terminalKind}`,
        `iterations:${iterations}`,
        `toolCalls:${toolCalls}`
      ],
      nextAllowedAction: nextActionForLoopTerminal(input.reason)
    });
  };

  const emitFailureWithRepair = async function* (
    status: AgentLoopSummary["status"],
    reason: string,
    error?: RedactedError,
    event?: RuntimeEvent,
    extraData: JsonObject = {}
  ): AsyncGenerator<RuntimeEvent, boolean, void> {
    const failureAnalysis = recordLoopFailureAnalysis({ reason, status, ...(error ? { error } : {}), ...(event ? { event } : {}) });
    yield* emitDecisionBoardSnapshot();
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
    const failed = agentLoopEvent("agent.loop.failed", sessionId, turnId, trace, { ...summary, reason, failureAnalysis, ...extraData }, request.agentId, error);
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

  while (iterations < effectiveMaxModelIterationsForWorkflowGate(limits.maxModelIterations, activeWorkflowGateOverride)) {
    repairContinuationRequested = false;
    if (signal?.aborted) {
      yield* emitCancelled();
      terminalEmitted = true;
      return;
    }
    iterations += 1;
    let iterationReasoning = "";
    let reasoningPersistedForIteration = false;
    let iterationProgressCapabilitySatisfied = false;
    let iterationProfilePolicy = profilePolicyWithRuntimeWorkflowGateOverride(activeProfilePolicy, activeWorkflowGateOverride);
    let iterationRequest = iterationProfilePolicy
      ? { ...request, profilePolicy: iterationProfilePolicy }
      : request;
    currentReadyStageControl = readyStageControlForProfilePolicy(iterationRequest.profilePolicy);
    if (
      workflowGateOverrideStaleForReadyStage(
        iterationRequest.profilePolicy?.workflowGateOverride,
        currentReadyStageControl
      )
    ) {
      activeWorkflowGateOverride = undefined;
      activeProfilePolicy = activeProfilePolicy ? clearWorkflowGateOverride(activeProfilePolicy) : activeProfilePolicy;
      iterationProfilePolicy = activeProfilePolicy;
      iterationRequest = iterationProfilePolicy
        ? { ...request, profilePolicy: iterationProfilePolicy }
        : request;
      currentReadyStageControl = readyStageControlForProfilePolicy(iterationRequest.profilePolicy);
    }
    const stalledWorkflowError = currentReadyStageControl
      ? undefined
      : stalledPrimaryWorkflowError(iterationRequest.profilePolicy);
    if (stalledWorkflowError) {
      diagnostics.push(stalledWorkflowError);
      yield* emitFailureWithRepair("failed", "workflow-orchestration-stalled", stalledWorkflowError);
      terminalEmitted = true;
      return;
    }
    if (currentReadyStageControl) {
      const controlEvent = agentLoopEvent("workflow.ready-stage.control", sessionId, turnId, trace, currentReadyStageControl, request.agentId);
      await recordRuntimeAdapterEvent(deps, controlEvent);
      yield controlEvent;
      const externalHarnessReturn = externalHarnessReturnGateForReadyScoreStage(iterationRequest.profilePolicy, currentReadyStageControl);
      if (externalHarnessReturn) {
        const consumed = agentLoopEvent("agent.loop.budget.consumed", sessionId, turnId, trace, externalHarnessReturn, request.agentId);
        await recordRuntimeAdapterEvent(deps, consumed);
        yield consumed;
        const summary = {
          ...summarizeAgentLoop("completed", request, sessionId, turnId, trace, assistantText, iterations, toolCalls, diagnostics, summaryMode()),
          reason: "external-score-ready",
          workflow: {
            profileId: iterationRequest.profilePolicy?.profileId,
            workflowGraphId: iterationRequest.profilePolicy?.workflowGraphId,
            graphId: iterationRequest.profilePolicy?.stagedTaskWorkflow?.graphId,
            stageStates: iterationRequest.profilePolicy?.stagedTaskWorkflow?.runState.stageStates.map((stage) => ({
              stageId: stage.stageId,
              status: stage.status,
              outputRefs: stage.outputRefs
            })) ?? []
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
      const readyStageBudget = readyStageBudgetForControl(limits, currentReadyStageControl);
      if (readyStageBudget?.maxModelIterations !== undefined) {
        const budgetKey = readyStageBudgetKey(currentReadyStageControl, readyStageBudget);
        const usage = readyStageBudgetUsage.get(budgetKey) ?? {
          modelIterations: 0,
          toolCalls: 0,
          modelIterationReviewInjected: false,
          toolCallReviewInjected: false
        };
        if (usage.modelIterations >= readyStageBudget.maxModelIterations) {
          const budget = readyStageBudgetEventData({
            control: currentReadyStageControl,
            budget: readyStageBudget,
            kind: "ready-stage-model-iterations",
            allowed: readyStageBudget.maxModelIterations,
            consumed: usage.modelIterations,
            remaining: 0,
            stopReason: readyStageBudget.stopReason ?? "ready-stage-model-budget-review-required"
          });
          const consumed = agentLoopEvent("agent.loop.budget.consumed", sessionId, turnId, trace, budget, request.agentId);
          await recordRuntimeAdapterEvent(deps, consumed);
          yield consumed;
          if (usage.modelIterationReviewInjected) {
            const stopReason = readyStageBudget.stopReason ?? "ready-stage-model-budget-review-required";
            const error = kernelError("KERNEL_QUEUE_BACKPRESSURE", "WORKFLOW_STAGE_BUDGET_REVIEW_REQUIRED: active ready-stage model budget is spent after review feedback; stop this stage and classify the blocker.", {
              workflowReadyStageControl: currentReadyStageControl,
              budget
            });
            diagnostics.push(error);
            yield* emitFailureWithRepair("rejected", stopReason, error, consumed, {
              workflowReadyStageControl: currentReadyStageControl,
              budget
            });
            terminalEmitted = true;
            return;
          }
          messages.push(readyStageBudgetReviewMessage(currentReadyStageControl, budget));
          readyStageBudgetUsage.set(budgetKey, {
            ...usage,
            modelIterations: Math.max(readyStageBudget.maxModelIterations - 1, 0),
            modelIterationReviewInjected: true
          });
          continue;
        }
        readyStageBudgetUsage.set(budgetKey, { ...usage, modelIterations: usage.modelIterations + 1 });
      }
    }
    const availableCapabilities = await deps.capabilities.listModelVisible();
    const projectedCapabilities = projectToolSet(availableCapabilities, iterationRequest);
    const visibleCapabilities = projectWorkflowGateOverrideTools(
      projectedCapabilities,
      iterationRequest.profilePolicy?.workflowGateOverride,
      {
        preferCanonicalCoreActions: true,
        strict: iterationRequest.profilePolicy?.workflowGateOverride?.gate === "runtime-convergence"
      }
    );
    const activeStageId = currentReadyStageControl && typeof currentReadyStageControl.stageId === "string"
      ? currentReadyStageControl.stageId
      : undefined;
    const decisionBoard = toolDecisionBoardSnapshot({
      state: toolDecisionBoard,
      iteration: iterations,
      activeProfileId: iterationRequest.profilePolicy?.profileId ?? request.profile.id,
      ...(activeStageId ? { activeStageId } : {}),
      availableCapabilities,
      visibleCapabilities,
      ...(iterationRequest.profilePolicy ? { profilePolicy: projectionEvidencePolicy(iterationRequest.profilePolicy, currentReadyStageControl) } : {})
    });
    const decisionBoardEvent = agentLoopEvent("tool.decision-board.snapshot", sessionId, turnId, trace, decisionBoard, request.agentId);
    await recordRuntimeAdapterEvent(deps, decisionBoardEvent);
    yield decisionBoardEvent;
    const projectionError = workflowProjectionError(iterationRequest.profilePolicy, availableCapabilities, visibleCapabilities, currentReadyStageControl);
    if (projectionError) {
      diagnostics.push(projectionError);
      yield* emitFailureWithRepair("failed", "workflow-capability-projection-empty", projectionError);
      terminalEmitted = true;
      return;
    }
    const providerHistory = messages;
    const schedulingNextAction = schedulingNextActionForModelRequest(iterationRequest.profilePolicy, currentReadyStageControl, visibleCapabilities);
    const assembly = await assemblePromptForIteration(deps, iterationRequest, sessionId, turnId, trace, providerHistory, contextProjection, visibleCapabilities, limits, evidenceFirst, currentRepairOutcome(), {
      phasePlan,
      reasoningEffortMapping,
      taskDecision: taskDeliveryFlow.decisionRequest,
      ...(schedulingNextAction ? { schedulingNextAction } : {}),
      toolDecisionBoard: decisionBoard
    });
    if (assembly.status === "rejected") {
      diagnostics.push(...assembly.diagnostics);
      const error = assembly.diagnostics[0] ?? kernelError("KERNEL_ENVELOPE_INVALID", "Prompt assembly rejected model dispatch");
      yield* emitFailureWithRepair("rejected", "prompt-assembly-rejected", error, undefined, { promptAssembly: promptAssemblyEventPayload(assembly, iterationRequest) });
      terminalEmitted = true;
      return;
    }
    const providerTools = projectProviderCacheToolSet(availableCapabilities, {
      ...iterationRequest,
      ...(currentReadyStageControl ? { workflowReadyStageControl: currentReadyStageControl } : {})
    }).map((capability) => modelToolSchema(capability));
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

    const providerMessages = providerCacheMessages(assembly.messages);
    const modelRequested = agentLoopEvent("model.requested", sessionId, turnId, trace, {
      iteration: iterations,
      model: request.profile.model,
      toolProjection,
      visibleToolCount: assembly.toolPlan.visibleToolCount,
      providerToolSchemaCount: providerTools.length,
      providerRequestReplay: providerRequestReplayEvidence(providerMessages, restoredHistory, providerTools.length, providerMessages.length),
      promptAssembly: {
        fingerprint: assembly.fingerprint,
        sectionCount: assembly.sections.length,
        budgetStatus: assembly.budget.status
      },
      ...(assembly.trace.pipeline ? { contextPipeline: assembly.trace.pipeline } : {}),
      ...(evidenceFirst ? { evidenceFirst: evidenceFirstEventData(evidenceFirst) } : {}),
      ...(contextProjection ? { contextProjection: projectionEventData(contextProjection) } : {}),
      ...(currentReadyStageControl ? { workflowReadyStageControl: currentReadyStageControl } : {}),
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
      ...(currentReadyStageControl ? { workflowReadyStageControl: currentReadyStageControl } : {}),
      taskDeliveryFlow: taskDeliveryFlowData
    });
    yield modelRequested;

    let requestedTool = false;
    let restartModelAfterWorkflowCorrection = false;
    let modelDispatchInterrupted = false;
    const reasoning = modelReasoningOptions(request.reasoning, reasoningEffortMapping);
    const output = modelOutputOptions(request);
    for await (const modelEvent of deps.models.stream({
      profile: request.profile,
      prompt: assembly.promptText,
      messages: providerMessages,
      tools: providerTools,
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
        ...(currentReadyStageControl ? { workflowReadyStageControl: currentReadyStageControl } : {}),
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
          const rejectedDispatch = buildRejectedDispatchResult({
            toolCallId,
            toolName,
            normalizedInputHash: normalizeToolInputHash(modelEvent.input),
            terminalKind: "tool-call-limit",
            text: error.message,
            diagnostics: [error],
            correctiveAction: "Stop requesting additional tools and report the bounded tool-call budget blocker.",
            recommendedNextAction: "bounded blocker report",
            trace,
            limitBytes: limits.maxOutputBytes,
            iteration: iterations,
            continuation: "terminate",
            metadata: { maxToolCalls: limits.maxToolCalls }
          });
          recordRejectedToolFeedback(toolDecisionBoard, rejectedDispatch.decisionRecord);
          const rejected = agentLoopEvent("model.tool.rejected", sessionId, turnId, trace, {
            reason: "tool-call-limit",
            maxToolCalls: limits.maxToolCalls,
            toolName,
            feedback: rejectedDispatch.feedback,
            evidence: await recordToolResultEvidence(deps, {
              ...rejectedDispatch.evidenceInput,
              terminalKind: "tool-call-limit"
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
        const normalizedInputHash = normalizeToolInputHash(modelEvent.input);
        const requestedCapabilityManifest = visibleCapabilities.find((capability) => String(capability.id) === toolName) ??
          availableCapabilities.find((capability) => String(capability.id) === toolName);
        const dispatchBatch = planToolDispatchBatch({
          modelToolCalls: [{
            toolCallId,
            providerToolName,
            resolvedCapabilityId: toolName,
            normalizedInputHash,
            input: modelEvent.input,
            sideEffect: requestedCapabilityManifest?.sideEffect ?? "unknown",
            iteration: iterations
          }],
          visibleCapabilityIds: visibleCapabilityIds.map(String),
          ...(currentReadyStageControl ? { activeStageControl: currentReadyStageControl } : {})
        });
        const dispatchItem = dispatchBatch.items[0];
        recordToolDecision(toolDecisionBoard, {
          kind: "intent",
          status: "requested",
          toolCallId,
          toolName,
          normalizedInputHash,
          iteration: iterations,
          metadata: {
            providerToolName,
            inputKeys: Object.keys(modelEvent.input).sort(),
            dispatch: {
              itemCount: dispatchBatch.items.length,
              executionMode: dispatchItem?.executionMode ?? "serial",
              sideEffect: dispatchItem?.sideEffect ?? "unknown"
            }
          }
        });
        const intentEvent = agentLoopEvent("model.tool.intent", sessionId, turnId, trace, {
          toolCallId,
          name: toolName,
          input: modelEvent.input,
          normalizedInputHash,
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

        const activePreflightWorkflowGate = iterationRequest.profilePolicy?.workflowGateOverride;
        const allowedDiagnosticRepairRefresh = allowsDiagnosticRepairFocusedRefresh(
          toolName,
          currentReadyStageControl,
          iterationRequest.profilePolicy
        );
        const mutationExactRefreshKey = currentReadyStageControl
          ? readyStageRequiredActionMissKey(currentReadyStageControl)
          : undefined;
        const mutationExactRefresh = mutationExactRefreshKey
          ? mutationExactRefreshByStage.get(mutationExactRefreshKey)
          : undefined;
        const modelToolInput = mutationExactRefresh && toolName === "core.file.read"
          ? {
              ...modelEvent.input,
              offset: typeof modelEvent.input.offset === "number" ? modelEvent.input.offset : 0,
              limit: typeof modelEvent.input.limit === "number" ? modelEvent.input.limit : 200
            }
          : modelEvent.input;
        if (
          mutationExactRefresh &&
          toolName === "core.file.read" &&
          !mutationExactRefreshInputAllowed(mutationExactRefresh, modelToolInput)
        ) {
          const requestedPath = typeof modelToolInput.path === "string"
            ? normalizeEvidencePath(modelToolInput.path)
            : "";
          const wrongTarget = requestedPath !== mutationExactRefresh.targetPath;
          const terminalKind = wrongTarget
            ? "workflow-mutation-recovery-target.rejected"
            : "workflow-mutation-recovery-exhausted";
          const error = kernelError(
            "KERNEL_POLICY_DENIED",
            wrongTarget
              ? `WORKFLOW_MUTATION_RECOVERY_TARGET_REJECTED: the one-shot refresh must read ${mutationExactRefresh.targetPath}, not ${requestedPath || "an unspecified path"}.`
              : `WORKFLOW_MUTATION_RECOVERY_EXHAUSTED: the one-shot bounded refresh for ${mutationExactRefresh.targetPath} is no longer available.`,
            {
              targetPath: mutationExactRefresh.targetPath,
              requestedPath,
              failedToolCallId: mutationExactRefresh.failedToolCallId,
              consumed: mutationExactRefresh.consumed,
              requestedCapabilityId: toolName
            }
          );
          diagnostics.push(error);
          const feedback = buildRejectedDispatchFeedback({
            toolCallId,
            toolName,
            capabilityId: toolName,
            text: error.message,
            diagnostics: [error],
            correctiveAction: "Apply a corrected source edit or report a bounded blocker.",
            recommendedNextAction: "corrected source edit or bounded blocker",
            trace,
            limitBytes: limits.maxOutputBytes,
            continuation: "terminate"
          });
          recordRejectedToolFeedback(toolDecisionBoard, {
            toolCallId,
            toolName,
            capabilityId: toolName,
            normalizedInputHash,
            terminalKind,
            correctiveAction: feedback.correctiveAction,
            recommendedNextAction: feedback.recommendedNextAction,
            iteration: iterations,
            metadata: { targetPath: mutationExactRefresh.targetPath, requestedPath }
          });
          const rejected = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
            toolCallId,
            toolName,
            result: feedback.preview.text,
            terminalKind,
            feedback,
            evidence: await recordToolResultEvidence(deps, {
              toolCallId,
              toolName,
              capabilityId: toolName,
              terminalKind,
              feedback
            })
          }, request.agentId, error);
          await recordRuntimeAdapterEvent(deps, rejected);
          yield rejected;
          messages.push({ role: "tool", content: feedback.preview.text, toolCallId, toolName });
          yield* emitFailureWithRepair("rejected", "flow-mutation-recovery-exhausted", error, rejected);
          terminalEmitted = true;
          return;
        }
        const preflightWorkflowGateMiss = activePreflightWorkflowGate !== undefined
          && !workflowGateOverrideAllowsCapability(activePreflightWorkflowGate, toolName)
          && !allowedDiagnosticRepairRefresh
          && currentReadyStageControl?.stageKind !== undefined
          && ["produce", "materialize", "repair"].includes(String(currentReadyStageControl.stageKind))
          && (
            readyStageProgressCapabilitySatisfied(toolName, currentReadyStageControl) ||
            readyStageNonProgressCapabilityMiss(toolName, currentReadyStageControl)
          );
        if (preflightWorkflowGateMiss) {
          const readyStageControl = currentReadyStageControl;
          if (!readyStageControl) continue;
          const missKey = readyStageRequiredActionMissKey(readyStageControl);
          const missCount = readyStageRequiredActionMisses.get(missKey) ?? 0;
          const convergence = readyStageRequiredActionConvergence({
            missCount,
            correctionLimit: READY_STAGE_REQUIRED_ACTION_CORRECTION_LIMIT,
            iteration: iterations,
            maxModelIterations: effectiveMaxModelIterationsForWorkflowGate(
              limits.maxModelIterations,
              activePreflightWorkflowGate
            ),
            workflowReadyStageControl: readyStageControl,
            requestedCapabilityId: toolName,
            rejectedBeforeExecution: true
          });
          const correctionAttempt = Number(convergence.metadata?.correctionAttempt ?? missCount + 1);
          const retryPolicy = String(convergence.metadata?.retryPolicy ?? "fail-closed");
          const canCorrect = convergence.kind === "retry-with-feedback";
          const error = kernelError(
            "KERNEL_POLICY_DENIED",
            `WORKFLOW_REQUIRED_ACTION_MISSED: model requested ${toolName} but the active workflow gate requires ${activePreflightWorkflowGate.requiredNextAction}.`,
            {
              workflowReadyStageControl: readyStageControl,
              requestedCapabilityId: toolName,
              workflowGateOverride: activePreflightWorkflowGate,
              iteration: iterations
            }
          );
          diagnostics.push(error);
          const missed = agentLoopEvent("workflow.required-action.missed", sessionId, turnId, trace, {
            ...readyStageControl,
            requestedCapabilityId: toolName,
            iteration: iterations,
            modelRequestCount: iterations,
            toolCallCount: toolCalls,
            correctionAttempt,
            retryPolicy,
            rejectedBeforeExecution: true,
            terminalKind: "workflow-required-action.rejected"
          }, request.agentId, error);
          await recordRuntimeAdapterEvent(deps, missed);
          yield missed;
          const stageFeedback = buildRejectedDispatchFeedback({
            toolCallId,
            toolName,
            capabilityId: toolName,
            text: error.message,
            diagnostics: [error],
            ...(convergence.correctiveAction ? { correctiveAction: convergence.correctiveAction } : {}),
            ...(convergence.recommendedNextAction ? { recommendedNextAction: convergence.recommendedNextAction } : {}),
            trace,
            limitBytes: limits.maxOutputBytes,
            continuation: "continue"
          });
          recordRejectedToolFeedback(toolDecisionBoard, {
            toolCallId,
            toolName,
            capabilityId: toolName,
            normalizedInputHash,
            terminalKind: "workflow-required-action.rejected",
            correctiveAction: stageFeedback.correctiveAction,
            recommendedNextAction: stageFeedback.recommendedNextAction,
            iteration: iterations,
            metadata: { workflowReadyStageControl: readyStageControl, workflowGateOverride: activePreflightWorkflowGate }
          });
          const stageRejectedEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
            toolCallId,
            toolName,
            result: stageFeedback.preview.text,
            terminalKind: "workflow-required-action.rejected",
            feedback: stageFeedback,
            evidence: await recordToolResultEvidence(deps, {
              toolCallId,
              toolName,
              capabilityId: toolName,
              terminalKind: "workflow-required-action.rejected",
              feedback: stageFeedback
            })
          }, request.agentId, error);
          await recordRuntimeAdapterEvent(deps, stageRejectedEvent);
          yield stageRejectedEvent;
          messages.push({ role: "tool", content: stageFeedback.preview.text, toolCallId, toolName });
          readyStageRequiredActionMisses.set(missKey, missCount + 1);
          if (canCorrect) {
            messages.push(
              activePreflightWorkflowGate.terminalKind === "workflow-official-repair.refreshed"
                ? officialRepairRequiredActionCorrectionMessage(readyStageControl, missCount + 1, error)
                : activePreflightWorkflowGate.terminalKind === "workflow-standard-test-repair.refreshed"
                  ? standardTestRepairRequiredActionCorrectionMessage(
                      readyStageControl,
                      missCount + 1,
                      error,
                      activePreflightWorkflowGate.requiredNextAction
                    )
                : readyStageRequiredActionCorrectionMessage(readyStageControl, missCount + 1, error)
            );
            restartModelAfterWorkflowCorrection = true;
            break;
          }
          yield* emitFailureWithRepair("rejected", "workflow-required-action-missed", error, missed);
          terminalEmitted = true;
          return;
        }

        if (shouldSuppressRepeatedRejectedIntent(toolDecisionBoard, { toolName, normalizedInputHash })) {
          const error = kernelError("KERNEL_POLICY_DENIED", "DECISION_LOOP_REPEATED_REJECTED_INTENT: repeated identical rejected tool intent suppressed; choose a different projected tool, corrected input, or report a bounded blocker.", {
            toolName,
            normalizedInputHash,
            threshold: 3
          });
          diagnostics.push(error);
          const convergence = repeatedRejectedIntentConvergence({
            threshold: 3,
            count: 3
          });
          const suppressFeedback = buildRejectedDispatchFeedback({
            toolCallId,
            toolName,
            text: "Repeated identical rejected tool intent suppressed. Use a different projected tool, provide corrected input, or report an explicit bounded blocker.",
            diagnostics: [error],
            ...(convergence.correctiveAction ? { correctiveAction: convergence.correctiveAction } : {}),
            ...(convergence.recommendedNextAction ? { recommendedNextAction: convergence.recommendedNextAction } : {}),
            trace,
            limitBytes: limits.maxOutputBytes,
            continuation: "continue"
          });
          const repeated = recordRejectedIntent(toolDecisionBoard, {
            toolCallId,
            toolName,
            normalizedInputHash,
            terminalKind: convergence.terminalKind ?? "decision-loop.rejected",
            correctiveAction: convergence.correctiveAction,
            recommendedNextAction: convergence.recommendedNextAction,
            iteration: iterations
          });
          const suppressedBoard = toolDecisionBoardSnapshot({
            state: toolDecisionBoard,
            iteration: iterations,
            activeProfileId: iterationRequest.profilePolicy?.profileId ?? request.profile.id,
            ...(activeStageId ? { activeStageId } : {}),
            availableCapabilities,
            visibleCapabilities,
            ...(iterationRequest.profilePolicy ? { profilePolicy: projectionEvidencePolicy(iterationRequest.profilePolicy, currentReadyStageControl) } : {})
          });
          const suppressEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
            toolCallId,
            toolName,
            result: suppressFeedback.preview.text,
            terminalKind: "decision-loop.rejected",
            feedback: suppressFeedback,
            decisionBoard: {
              boardId: suppressedBoard.boardId,
              repeatedRejectedIntentCount: repeated.count,
              decisionLoopFailureCandidate: suppressedBoard.decisionLoopFailureCandidate,
              record: repeated.record
            },
            evidence: await recordToolResultEvidence(deps, {
              toolCallId,
              toolName,
              terminalKind: "decision-loop.rejected",
              feedback: suppressFeedback
            })
          }, request.agentId, error);
          await recordRuntimeAdapterEvent(deps, suppressEvent);
          yield suppressEvent;
          messages.push({ role: "tool", content: suppressFeedback.preview.text, toolCallId, toolName });
          continue;
        }

        const activeReadyStageBudget = currentReadyStageControl
          ? readyStageBudgetForControl(limits, currentReadyStageControl)
          : undefined;
        if (currentReadyStageControl && activeReadyStageBudget?.maxToolCalls !== undefined) {
          const budgetKey = readyStageBudgetKey(currentReadyStageControl, activeReadyStageBudget);
          const usage = readyStageBudgetUsage.get(budgetKey) ?? {
            modelIterations: 0,
            toolCalls: 0,
            modelIterationReviewInjected: false,
            toolCallReviewInjected: false
          };
          if (usage.toolCalls >= activeReadyStageBudget.maxToolCalls) {
            const budget = readyStageBudgetEventData({
              control: currentReadyStageControl,
              budget: activeReadyStageBudget,
              kind: "ready-stage-tool-calls",
              allowed: activeReadyStageBudget.maxToolCalls,
              consumed: usage.toolCalls,
              remaining: 0,
              stopReason: activeReadyStageBudget.stopReason ?? "ready-stage-tool-budget-review-required"
            });
            const consumed = agentLoopEvent("agent.loop.budget.consumed", sessionId, turnId, trace, budget, request.agentId);
            await recordRuntimeAdapterEvent(deps, consumed);
            yield consumed;
            if (usage.toolCallReviewInjected) {
              const stopReason = activeReadyStageBudget.stopReason ?? "ready-stage-tool-budget-review-required";
              const error = kernelError("KERNEL_QUEUE_BACKPRESSURE", "WORKFLOW_STAGE_BUDGET_REVIEW_REQUIRED: active ready-stage tool budget is spent after review feedback; stop this stage and classify the blocker.", {
                workflowReadyStageControl: currentReadyStageControl,
                budget,
                requestedToolName: toolName
              });
              diagnostics.push(error);
              yield* emitFailureWithRepair("rejected", stopReason, error, consumed, {
                workflowReadyStageControl: currentReadyStageControl,
                budget,
                requestedToolName: toolName
              });
              terminalEmitted = true;
              return;
            }
            const error = kernelError("KERNEL_QUEUE_BACKPRESSURE", "WORKFLOW_STAGE_BUDGET_REVIEW_REQUIRED: active ready-stage tool budget is spent; review progress and choose the next workflow action or report a bounded blocker.", {
              workflowReadyStageControl: currentReadyStageControl,
              budget,
              requestedToolName: toolName
            });
            diagnostics.push(error);
            const convergence = readyStageToolBudgetConvergence({
              workflowReadyStageControl: currentReadyStageControl,
              budget
            });
            const budgetFeedback = buildRejectedDispatchFeedback({
              toolCallId,
              toolName,
              text: error.message,
              diagnostics: [error],
              ...(convergence.correctiveAction ? { correctiveAction: convergence.correctiveAction } : {}),
              ...(convergence.recommendedNextAction ? { recommendedNextAction: convergence.recommendedNextAction } : {}),
              trace,
              limitBytes: limits.maxOutputBytes,
              continuation: "continue"
            });
            recordRejectedToolFeedback(toolDecisionBoard, {
              toolCallId,
              toolName,
              normalizedInputHash,
              terminalKind: "workflow-stage-budget.review-required",
              correctiveAction: budgetFeedback.correctiveAction,
              recommendedNextAction: budgetFeedback.recommendedNextAction,
              iteration: iterations,
              metadata: { workflowReadyStageControl: currentReadyStageControl, budget }
            });
            const budgetRejected = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
              toolCallId,
              toolName,
              result: budgetFeedback.preview.text,
              terminalKind: "workflow-stage-budget.review-required",
              feedback: budgetFeedback,
              evidence: await recordToolResultEvidence(deps, {
                toolCallId,
                toolName,
                terminalKind: "workflow-stage-budget.review-required",
                feedback: budgetFeedback
              })
            }, request.agentId, error);
            await recordRuntimeAdapterEvent(deps, budgetRejected);
            yield budgetRejected;
            messages.push({ role: "tool", content: budgetFeedback.preview.text, toolCallId, toolName });
            messages.push(readyStageBudgetReviewMessage(currentReadyStageControl, budget));
            readyStageBudgetUsage.set(budgetKey, { ...usage, toolCalls: 0, toolCallReviewInjected: true });
            continue;
          }
          readyStageBudgetUsage.set(budgetKey, { ...usage, toolCalls: usage.toolCalls + 1 });
        }

        const descriptor = await deps.platform.descriptor();
        const resolvedCapabilityId = asId<"capability">(toolName);
        const preflightVisibleCapabilityIds = visibleCapabilityIds.includes(resolvedCapabilityId) ||
          !availableCapabilities.some((capability) => capability.id === resolvedCapabilityId)
          ? visibleCapabilityIds
          : [...visibleCapabilityIds, resolvedCapabilityId];
        const preflightManifest = visibleCapabilities.find((capability) => capability.id === resolvedCapabilityId);
        const preflightToolTimeoutMs = toolTimeoutFor(modelToolInput, limits.toolTimeoutMs, preflightManifest?.timeoutMs, request.timeoutMs);
        const preflight = await deps.toolIntentPreflight.check({
          intent: {
            toolCallId,
            name: toolName,
            input: modelToolInput,
            source: "model"
          },
          workspaceRoot: request.workspaceRoot,
          platform: descriptor.os,
          modelVisibleCapabilities: preflightVisibleCapabilityIds,
          providerId: request.profile.providerId,
          profileId: request.profile.id,
          providerHints: {
            userPrompt: request.prompt
          },
          toolTimeoutMs: preflightToolTimeoutMs
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
          const rejectedDispatch = buildRejectedDispatchResult({
            toolCallId,
            toolName,
            ...(preflight.capabilityId ? { capabilityId: String(preflight.capabilityId) } : {}),
            normalizedInputHash,
            terminalKind: "preflight.rejected",
            text: `Tool request rejected: ${error.message}`,
            diagnostics: [error, ...preflight.diagnostics],
            correctiveAction: "Correct the tool input or choose a different projected tool.",
            recommendedNextAction: "corrected input or different projected tool",
            trace,
            limitBytes: limits.maxOutputBytes,
            continuation: "continue",
            iteration: iterations
          });
          const preflightResultEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
            ...rejectedDispatch.eventData,
            evidence: await recordToolResultEvidence(deps, {
              ...rejectedDispatch.evidenceInput,
              terminalKind: "preflight.rejected"
            })
          }, request.agentId, error);
          recordRejectedIntent(toolDecisionBoard, rejectedDispatch.decisionRecord);
          await recordRuntimeAdapterEvent(deps, preflightResultEvent);
          yield preflightResultEvent;
          messages.push({ role: "tool", content: rejectedDispatch.feedback.preview.text, toolCallId, toolName });
          continue;
        }

        let toolInput = preflight.repaired?.input ?? modelToolInput;
        const activeStageEvidenceWindowKey = currentReadyStageControl &&
          iterationRequest.profilePolicy?.workflowGateOverride?.terminalKind === "workflow-stage-evidence-window.opened"
          ? readyStageRequiredActionMissKey(currentReadyStageControl)
          : undefined;
        const activeStageEvidenceWindow = activeStageEvidenceWindowKey
          ? stageEvidenceWindows.get(activeStageEvidenceWindowKey)
          : undefined;
        if (
          String(preflight.capabilityId) === "core.search.text" &&
          iterationRequest.profilePolicy?.workflowGateOverride?.terminalKind === "workflow-stage-evidence-window.opened"
        ) {
          const focusedGlob = focusedStageEvidenceSearchGlob(activeStageEvidenceWindow, toolInput);
          toolInput = {
            ...toolInput,
            outputMode: "content",
            ...(focusedGlob ? { glob: focusedGlob } : {})
          };
        }
        if (
          String(preflight.capabilityId) === "core.file.read" &&
          iterationRequest.profilePolicy?.workflowGateOverride?.terminalKind === "workflow-stage-evidence-window.opened"
        ) {
          const path = typeof toolInput.path === "string" ? toolInput.path : undefined;
          toolInput = {
            ...toolInput,
            offset: typeof toolInput.offset === "number"
              ? toolInput.offset
              : activeStageEvidenceWindow && path
                ? nextStageEvidenceReadOffset(activeStageEvidenceWindow, path)
                : 0,
            limit: typeof toolInput.limit === "number" ? toolInput.limit : 200
          };
        }
        if (activeStageEvidenceWindow && isFocusedEvidenceRefreshCapabilityId(String(preflight.capabilityId))) {
          const evidenceDecision = stageEvidenceRequestDecision(
            activeStageEvidenceWindow,
            String(preflight.capabilityId),
            toolInput
          );
          if (evidenceDecision !== "allow") {
            const terminalKind = `workflow-stage-evidence-${evidenceDecision}.rejected`;
            const error = kernelError(
              "KERNEL_POLICY_DENIED",
              `WORKFLOW_STAGE_EVIDENCE_${evidenceDecision.toUpperCase().replaceAll("-", "_")}: focused evidence request cannot execute because it is ${evidenceDecision}. Apply the source mutation or report a bounded blocker.`,
              {
                stageKey: activeStageEvidenceWindow.stageKey,
                targetPath: activeStageEvidenceWindow.targetPath,
                acceptedOperations: activeStageEvidenceWindow.acceptedOperations,
                maxAcceptedOperations: activeStageEvidenceWindow.maxAcceptedOperations,
                requestedCapabilityId: String(preflight.capabilityId),
                toolInput
              }
            );
            diagnostics.push(error);
            const rejectedDispatch = buildRejectedDispatchResult({
              toolCallId,
              toolName,
              capabilityId: String(preflight.capabilityId),
              normalizedInputHash,
              terminalKind,
              text: error.message,
              diagnostics: [error],
              correctiveAction: "Apply a source mutation or report a bounded blocker.",
              recommendedNextAction: "source mutation or bounded blocker",
              trace,
              limitBytes: limits.maxOutputBytes,
              continuation: "continue",
              iteration: iterations
            });
            recordRejectedToolFeedback(toolDecisionBoard, rejectedDispatch.decisionRecord);
            const rejectedEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
              ...rejectedDispatch.eventData,
              evidence: await recordToolResultEvidence(deps, {
                ...rejectedDispatch.evidenceInput,
                terminalKind
              })
            }, request.agentId, error);
            await recordRuntimeAdapterEvent(deps, rejectedEvent);
            yield rejectedEvent;
            messages.push({ role: "tool", content: rejectedDispatch.feedback.preview.text, toolCallId, toolName });
            const explicitMutationAction = String(currentReadyStageControl?.requiredNextAction ?? "core.file.edit|core.patch.apply");
            const gateOverride = convergenceWorkflowGateOverride({
              requiredNextAction: explicitMutationAction,
              rejectedCapabilityId: String(preflight.capabilityId),
              rejectedToolName: toolName,
              terminalKind,
              toolCallId
            });
            activeWorkflowGateOverride = gateOverride;
            activeProfilePolicy = profilePolicyWithRuntimeWorkflowGateOverride(iterationRequest.profilePolicy, gateOverride);
            const closedEvent = agentLoopEvent("workflow.stage-evidence.window.closed", sessionId, turnId, trace, {
              stageId: currentReadyStageControl?.stageId ?? "unknown",
              stageKey: activeStageEvidenceWindow.stageKey,
              reason: evidenceDecision,
              acceptedOperations: activeStageEvidenceWindow.acceptedOperations,
              requiredNextAction: explicitMutationAction,
              rejectedToolCallId: toolCallId
            }, request.agentId);
            await recordRuntimeAdapterEvent(deps, closedEvent);
            yield closedEvent;
            continue;
          }
        }
        const workflowBoundaryError = workflowCapabilityBoundaryGuard({
          ...(iterationRequest.profilePolicy ? { profilePolicy: iterationRequest.profilePolicy } : {}),
          ...(currentReadyStageControl ? { workflowReadyStageControl: currentReadyStageControl } : {}),
          capabilityId: String(preflight.capabilityId),
          toolName,
          toolInput
        });
        if (workflowBoundaryError) {
          diagnostics.push(workflowBoundaryError);
          const readyStageControl = currentReadyStageControl;
          const missKey = readyStageControl ? readyStageRequiredActionMissKey(readyStageControl) : undefined;
          const missCount = missKey ? readyStageRequiredActionMisses.get(missKey) ?? 0 : 0;
          const convergence = readyStageControl
            ? readyStageRequiredActionConvergence({
              missCount,
              correctionLimit: READY_STAGE_REQUIRED_ACTION_CORRECTION_LIMIT,
              iteration: iterations,
              maxModelIterations: effectiveMaxModelIterationsForWorkflowGate(
                limits.maxModelIterations,
                iterationRequest.profilePolicy?.workflowGateOverride
              ),
              workflowReadyStageControl: readyStageControl,
              requestedCapabilityId: String(preflight.capabilityId),
              rejectedBeforeExecution: true
            })
            : undefined;
          const correctionAttempt = Number(convergence?.metadata?.correctionAttempt ?? missCount + 1);
          const retryPolicy = String(convergence?.metadata?.retryPolicy ?? "correct-bounded");
          const canCorrect = convergence?.kind !== "terminal";
          const rejectedDispatch = buildRejectedDispatchResult({
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            normalizedInputHash,
            terminalKind: "workflow-capability-boundary.rejected",
            text: workflowBoundaryError.message,
            diagnostics: [workflowBoundaryError],
            correctiveAction: convergence?.correctiveAction ?? "Choose a tool allowed by the active workflow profile boundary or report a bounded blocker.",
            recommendedNextAction: convergence?.recommendedNextAction ?? "allowed workflow tool or bounded blocker",
            trace,
            limitBytes: limits.maxOutputBytes,
            continuation: "continue",
            iteration: iterations
          });
          recordRejectedToolFeedback(toolDecisionBoard, rejectedDispatch.decisionRecord);
          const boundaryRejectedEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
            ...rejectedDispatch.eventData,
            evidence: await recordToolResultEvidence(deps, {
              ...rejectedDispatch.evidenceInput,
              terminalKind: "workflow-capability-boundary.rejected"
            })
          }, request.agentId, workflowBoundaryError);
          await recordRuntimeAdapterEvent(deps, boundaryRejectedEvent);
          yield boundaryRejectedEvent;
          if (readyStageControl && missKey) {
            const missed = agentLoopEvent("workflow.required-action.missed", sessionId, turnId, trace, {
              ...readyStageControl,
              requestedCapabilityId: String(preflight.capabilityId),
              iteration: iterations,
              modelRequestCount: iterations,
              toolCallCount: toolCalls,
              correctionAttempt,
              retryPolicy,
              rejectedBeforeExecution: true,
              terminalKind: "workflow-capability-boundary.rejected"
            }, request.agentId, workflowBoundaryError);
            await recordRuntimeAdapterEvent(deps, missed);
            yield missed;
            readyStageRequiredActionMisses.set(missKey, missCount + 1);
            if (!canCorrect) {
              yield* emitFailureWithRepair("rejected", "workflow-required-action-missed", workflowBoundaryError, missed);
              terminalEmitted = true;
              return;
            }
          }
          messages.push({ role: "tool", content: rejectedDispatch.feedback.preview.text, toolCallId, toolName });
          if (readyStageControl && missKey && canCorrect) {
            if (workflowBoundaryError.code === "WORKFLOW_STANDARD_TEST_REQUIRED") {
              const gateOverride = convergenceWorkflowGateOverride({
                requiredNextAction: "standard-test-command",
                rejectedCapabilityId: String(preflight.capabilityId),
                rejectedToolName: toolName,
                terminalKind: "workflow-standard-test-required",
                toolCallId
              });
              activeWorkflowGateOverride = gateOverride;
              activeProfilePolicy = profilePolicyWithRuntimeWorkflowGateOverride(iterationRequest.profilePolicy, gateOverride);
              restartModelAfterWorkflowCorrection = true;
            }
            const openFocusedEvidenceWindow =
              isFocusedEvidenceRefreshCapabilityId(String(preflight.capabilityId)) &&
              readyStageControlProjectedFromReviewedEvidence(readyStageControl) &&
              readyStageKindMatches(readyStageControl, ["produce", "materialize", "repair"]) &&
              iterationRequest.profilePolicy?.workflowPriority === "primary" &&
              iterationRequest.profilePolicy.orchestrationMode === "staged-capability-workflow" &&
              !openedStageEvidenceWindows.has(missKey);
            if (openFocusedEvidenceWindow) {
              const gateOverride = convergenceWorkflowGateOverride({
                requiredNextAction: "focused-read-or-source-edit-or-bounded-blocker",
                rejectedCapabilityId: String(preflight.capabilityId),
                rejectedToolName: toolName,
                terminalKind: "workflow-stage-evidence-window.opened",
                toolCallId
              });
              openedStageEvidenceWindows.add(missKey);
              const stageBudget = readyStageBudgetForControl(limits, readyStageControl);
              const stageBudgetUsage = stageBudget
                ? readyStageBudgetUsage.get(readyStageBudgetKey(readyStageControl, stageBudget))
                : undefined;
              const remainingStageToolCalls = stageBudget?.maxToolCalls !== undefined
                ? stageBudget.maxToolCalls - (stageBudgetUsage?.toolCalls ?? 0)
                : limits.maxToolCalls - toolCalls;
              const evidenceWindow = createStageEvidenceWindow({
                stageKey: missKey,
                capabilityId: String(preflight.capabilityId),
                toolInput,
                relatedTargetPaths: [...acceptedSourceEvidencePaths],
                maxAcceptedOperations: Math.max(1, remainingStageToolCalls)
              });
              stageEvidenceWindows.set(missKey, evidenceWindow);
              const openedEvent = agentLoopEvent("workflow.stage-evidence.window.opened", sessionId, turnId, trace, {
                stageId: readyStageControl.stageId,
                stageKey: missKey,
                targetPath: evidenceWindow.targetPath ?? "unknown",
                maxAcceptedOperations: evidenceWindow.maxAcceptedOperations,
                requestedCapabilityId: String(preflight.capabilityId),
                rejectedToolCallId: toolCallId
              }, request.agentId);
              await recordRuntimeAdapterEvent(deps, openedEvent);
              yield openedEvent;
              messages.push({
                role: "user",
                content: [
                  "WORKFLOW_FOCUSED_EVIDENCE_WINDOW_OPENED.",
                  "The rejected source-inspection request did not execute.",
                  `Target scope: ${evidenceWindow.targetPath ?? "the rejected source target"}.`,
                  `Evidence operations available: ${evidenceWindow.maxAcceptedOperations}.`,
                  "Reissue the rejected focused request with a bounded read or search. Focused search returns matching source content automatically.",
                  "Use only the same target scope or a direct relative dependency proven by accepted source content, then apply a source mutation."
                ].join("\n")
              });
              activeWorkflowGateOverride = gateOverride;
              activeProfilePolicy = profilePolicyWithRuntimeWorkflowGateOverride(iterationRequest.profilePolicy, gateOverride);
              restartModelAfterWorkflowCorrection = true;
            }
            const activeBoundaryGate = iterationRequest.profilePolicy?.workflowGateOverride;
            messages.push(
              activeBoundaryGate?.terminalKind === "workflow-standard-test-repair.refreshed"
                ? standardTestRepairRequiredActionCorrectionMessage(
                    readyStageControl,
                    missCount + 1,
                    workflowBoundaryError,
                    activeBoundaryGate.requiredNextAction
                  )
                : readyStageRequiredActionCorrectionMessage(readyStageControl, missCount + 1, workflowBoundaryError)
            );
          }
          if (restartModelAfterWorkflowCorrection) break;
          continue;
        }
        const repeatedMutationFailureSuppressed = isMutationCapabilityId(String(preflight.capabilityId)) &&
          shouldSuppressRepeatedMutationFailure(toolDecisionBoard, { toolName, normalizedInputHash });
        if (repeatedMutationFailureSuppressed) {
          const error = kernelError("KERNEL_POLICY_DENIED", "DECISION_LOOP_REPEATED_STALE_MUTATION: repeated stale mutation input suppressed after diagnostic evidence; use the current nearestContext/actual context from the failed tool result, corrected input, or report a bounded blocker.", {
            toolName,
            capabilityId: String(preflight.capabilityId),
            normalizedInputHash,
            threshold: 2
          });
          diagnostics.push(error);
          const convergence = repeatedRejectedIntentConvergence({
            threshold: 2,
            count: 2
          });
          const suppressFeedback = buildRejectedDispatchFeedback({
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            text: "Repeated stale mutation input suppressed. Use nearestContext/actual context from the failed mutation diagnostic to provide corrected input, choose a different mutation, or report an explicit bounded blocker.",
            diagnostics: [error],
            ...(convergence.correctiveAction ? { correctiveAction: convergence.correctiveAction } : {}),
            ...(convergence.recommendedNextAction ? { recommendedNextAction: convergence.recommendedNextAction } : {}),
            trace,
            limitBytes: limits.maxOutputBytes,
            continuation: "continue"
          });
          const repeated = recordRejectedIntent(toolDecisionBoard, {
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            normalizedInputHash,
            terminalKind: convergence.terminalKind ?? "decision-loop.rejected",
            correctiveAction: convergence.correctiveAction,
            recommendedNextAction: convergence.recommendedNextAction,
            iteration: iterations
          });
          const suppressedBoard = toolDecisionBoardSnapshot({
            state: toolDecisionBoard,
            iteration: iterations,
            activeProfileId: iterationRequest.profilePolicy?.profileId ?? request.profile.id,
            ...(activeStageId ? { activeStageId } : {}),
            availableCapabilities,
            visibleCapabilities,
            ...(iterationRequest.profilePolicy ? { profilePolicy: projectionEvidencePolicy(iterationRequest.profilePolicy, currentReadyStageControl) } : {})
          });
          const suppressEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
            toolCallId,
            toolName,
            result: suppressFeedback.preview.text,
            terminalKind: "decision-loop.rejected",
            feedback: suppressFeedback,
            decisionBoard: {
              boardId: suppressedBoard.boardId,
              repeatedRejectedIntentCount: repeated.count,
              decisionLoopFailureCandidate: suppressedBoard.decisionLoopFailureCandidate,
              record: repeated.record
            },
            evidence: await recordToolResultEvidence(deps, {
              toolCallId,
              toolName,
              terminalKind: "decision-loop.rejected",
              feedback: suppressFeedback
            })
          }, request.agentId, error);
          await recordRuntimeAdapterEvent(deps, suppressEvent);
          yield suppressEvent;
          messages.push({ role: "tool", content: suppressFeedback.preview.text, toolCallId, toolName });
          if (readyStageKindMatches(currentReadyStageControl, ["produce", "materialize", "repair"])) {
            const patchRecoveryAvailable = readyStageAllowsCapability(currentReadyStageControl, "core.patch.apply");
            const gateOverride = convergenceWorkflowGateOverride({
              requiredNextAction: patchRecoveryAvailable
                ? "core.patch.apply"
                : String(currentReadyStageControl?.requiredNextAction ?? "core.file.edit"),
              rejectedCapabilityId: String(preflight.capabilityId),
              rejectedToolName: toolName,
              terminalKind: "decision-loop.rejected",
              toolCallId
            });
            activeWorkflowGateOverride = gateOverride;
            activeProfilePolicy = activeProfilePolicy ? { ...activeProfilePolicy, workflowGateOverride: gateOverride } : activeProfilePolicy;
          }
          continue;
        }
        const activeOutputContract = outputContractVerification?.contract ?? request.outputContract;
        const activeOutputContractGate = iterationRequest.profilePolicy?.workflowGateOverride ?? activeWorkflowGateOverride;
        const outputContractPathRejection = outputContractArtifactPathRejection({
          toolName,
          toolInput,
          ...(activeOutputContract ? { outputContract: activeOutputContract } : {}),
          ...(activeOutputContractGate ? { workflowGateOverride: activeOutputContractGate } : {})
        });
        if (outputContractPathRejection) {
          const { error, terminalKind } = outputContractPathRejection;
          diagnostics.push(error);
          const rejectedDispatch = buildRejectedDispatchResult({
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            normalizedInputHash,
            terminalKind,
            text: error.message,
            diagnostics: [error],
            correctiveAction: "Write to the required output artifact path or report an output-contract blocker.",
            recommendedNextAction: "required output artifact path or bounded blocker",
            trace,
            limitBytes: limits.maxOutputBytes,
            continuation: "continue",
            iteration: iterations
          });
          recordRejectedToolFeedback(toolDecisionBoard, rejectedDispatch.decisionRecord);
          const deniedEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
            ...rejectedDispatch.eventData,
            evidence: await recordToolResultEvidence(deps, {
              ...rejectedDispatch.evidenceInput,
              terminalKind
            })
          }, request.agentId, error);
          await recordRuntimeAdapterEvent(deps, deniedEvent);
          yield deniedEvent;
          messages.push({ role: "tool", content: rejectedDispatch.feedback.preview.text, toolCallId, toolName });
          continue;
        }
        const activeWorkflowGate = iterationRequest.profilePolicy?.workflowGateOverride;
        const preExecutionGateMiss = activeWorkflowGate !== undefined
          && !workflowGateOverrideAllowsCapability(activeWorkflowGate, String(preflight.capabilityId))
          && currentReadyStageControl?.stageKind !== undefined
          && ["produce", "materialize", "repair"].includes(String(currentReadyStageControl.stageKind))
          && (
            readyStageProgressCapabilitySatisfied(String(preflight.capabilityId), currentReadyStageControl) ||
            readyStageNonProgressCapabilityMiss(String(preflight.capabilityId), currentReadyStageControl)
          );
        if (preExecutionGateMiss) {
          const readyStageControl = currentReadyStageControl;
          if (!readyStageControl) continue;
          const missKey = readyStageRequiredActionMissKey(readyStageControl);
          const missCount = readyStageRequiredActionMisses.get(missKey) ?? 0;
          const convergence = readyStageRequiredActionConvergence({
            missCount,
            correctionLimit: READY_STAGE_REQUIRED_ACTION_CORRECTION_LIMIT,
            iteration: iterations,
            maxModelIterations: effectiveMaxModelIterationsForWorkflowGate(
              limits.maxModelIterations,
              activeWorkflowGate
            ),
            workflowReadyStageControl: readyStageControl,
            requestedCapabilityId: String(preflight.capabilityId),
            rejectedBeforeExecution: true
          });
          const correctionAttempt = Number(convergence.metadata?.correctionAttempt ?? missCount + 1);
          const retryPolicy = String(convergence.metadata?.retryPolicy ?? "fail-closed");
          const canCorrect = convergence.kind === "retry-with-feedback";
          const error = kernelError(
            "KERNEL_POLICY_DENIED",
            `WORKFLOW_REQUIRED_ACTION_MISSED: model requested ${String(preflight.capabilityId)} but the active stage requires ${String(readyStageControl.requiredNextAction ?? "")}.`,
            {
              workflowReadyStageControl: readyStageControl,
              requestedCapabilityId: String(preflight.capabilityId),
              iteration: iterations
            }
          );
          diagnostics.push(error);
          const missed = agentLoopEvent("workflow.required-action.missed", sessionId, turnId, trace, {
            ...readyStageControl,
            requestedCapabilityId: String(preflight.capabilityId),
            iteration: iterations,
            modelRequestCount: iterations,
            toolCallCount: toolCalls,
            correctionAttempt,
            retryPolicy,
            rejectedBeforeExecution: true
          }, request.agentId, error);
          await recordRuntimeAdapterEvent(deps, missed);
          yield missed;
          const stageFeedback = buildRejectedDispatchFeedback({
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            text: error.message,
            diagnostics: [error],
            ...(convergence.correctiveAction ? { correctiveAction: convergence.correctiveAction } : {}),
            ...(convergence.recommendedNextAction ? { recommendedNextAction: convergence.recommendedNextAction } : {}),
            trace,
            limitBytes: limits.maxOutputBytes,
            continuation: "continue"
          });
          recordRejectedToolFeedback(toolDecisionBoard, {
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            normalizedInputHash,
            terminalKind: "workflow-required-action.rejected",
            correctiveAction: stageFeedback.correctiveAction,
            recommendedNextAction: stageFeedback.recommendedNextAction,
            iteration: iterations,
            metadata: { workflowReadyStageControl: readyStageControl }
          });
          const stageRejectedEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
            toolCallId,
            toolName,
            result: stageFeedback.preview.text,
            terminalKind: "workflow-required-action.rejected",
            feedback: stageFeedback,
            evidence: await recordToolResultEvidence(deps, {
              toolCallId,
              toolName,
              capabilityId: String(preflight.capabilityId),
              terminalKind: "workflow-required-action.rejected",
              feedback: stageFeedback
            })
          }, request.agentId, error);
          await recordRuntimeAdapterEvent(deps, stageRejectedEvent);
          yield stageRejectedEvent;
          messages.push({ role: "tool", content: stageFeedback.preview.text, toolCallId, toolName });
          readyStageRequiredActionMisses.set(missKey, missCount + 1);
          if (canCorrect) {
            messages.push(readyStageRequiredActionCorrectionMessage(readyStageControl, missCount + 1, error));
            restartModelAfterWorkflowCorrection = true;
            break;
          }
          yield* emitFailureWithRepair("rejected", "workflow-required-action-missed", error, missed);
          terminalEmitted = true;
          return;
        }
        const unboundedSourceRead = unboundedSourceReadDiagnostic({
          capabilityId: String(preflight.capabilityId),
          toolName,
          toolInput,
          workflowReadyStageControl: currentReadyStageControl
        });
        if (unboundedSourceRead) {
          diagnostics.push(unboundedSourceRead);
          const rejectedDispatch = buildRejectedDispatchResult({
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            normalizedInputHash,
            terminalKind: "workflow-unbounded-source-read.rejected",
            text: unboundedSourceRead.message,
            diagnostics: [unboundedSourceRead],
            correctiveAction: "Read a bounded source window with offset and limit, or use search/glob if the target file is not yet known.",
            recommendedNextAction: "bounded source read or focused evidence query",
            trace,
            limitBytes: limits.maxOutputBytes,
            continuation: "continue",
            iteration: iterations
          });
          recordRejectedToolFeedback(toolDecisionBoard, rejectedDispatch.decisionRecord);
          const unboundedReadEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
            ...rejectedDispatch.eventData,
            evidence: await recordToolResultEvidence(deps, {
              ...rejectedDispatch.evidenceInput,
              terminalKind: "workflow-unbounded-source-read.rejected"
            })
          }, request.agentId, unboundedSourceRead);
          await recordRuntimeAdapterEvent(deps, unboundedReadEvent);
          yield unboundedReadEvent;
          messages.push({ role: "tool", content: rejectedDispatch.feedback.preview.text, toolCallId, toolName });
          continue;
        }
        const invalidMutationIntent = invalidMutationIntentDiagnostic({
          capabilityId: String(preflight.capabilityId),
          toolName,
          toolInput,
          workflowReadyStageControl: currentReadyStageControl,
          acceptedSourceEvidencePaths: [...acceptedSourceEvidencePaths]
        });
        if (invalidMutationIntent) {
          diagnostics.push(invalidMutationIntent);
          const readyStageControl = currentReadyStageControl;
          const rejectedDispatch = buildRejectedDispatchResult({
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            normalizedInputHash,
            terminalKind: "workflow-invalid-mutation-intent.rejected",
            text: invalidMutationIntent.message,
            diagnostics: [invalidMutationIntent],
            correctiveAction: "Provide a real source mutation with a non-placeholder diff, refresh exact local evidence once, or report a bounded blocker.",
            recommendedNextAction: "real source mutation, focused evidence refresh, or bounded blocker",
            trace,
            limitBytes: limits.maxOutputBytes,
            continuation: "continue",
            iteration: iterations
          });
          recordRejectedToolFeedback(toolDecisionBoard, rejectedDispatch.decisionRecord);
          const invalidMutationEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
            ...rejectedDispatch.eventData,
            evidence: await recordToolResultEvidence(deps, {
              ...rejectedDispatch.evidenceInput,
              terminalKind: "workflow-invalid-mutation-intent.rejected"
            })
          }, request.agentId, invalidMutationIntent);
          await recordRuntimeAdapterEvent(deps, invalidMutationEvent);
          yield invalidMutationEvent;
          messages.push({ role: "tool", content: rejectedDispatch.feedback.preview.text, toolCallId, toolName });
          if (readyStageControl && readyStageKindMatches(readyStageControl, ["produce", "materialize", "repair"])) {
            const missKey = readyStageRequiredActionMissKey(readyStageControl);
            if (readyStageControlProjectedFromReviewedEvidence(readyStageControl)) {
              readyStageMutationInputStalls.set(missKey, (readyStageMutationInputStalls.get(missKey) ?? 0) + 1);
            }
            const mutationInputStallCount = readyStageMutationInputStalls.get(missKey) ?? 0;
            const editAlreadyFailedForStage = readyStageEditRepairFailures.has(missKey);
            const patchAlreadyFailedForStage = readyStagePatchRepairFailures.has(missKey);
            const patchRecoveryAvailable = readyStageAllowsCapability(readyStageControl, "core.patch.apply");
            const editRecoveryAvailable = readyStageAllowsCapability(readyStageControl, "core.file.edit");
            const currentGateOverride = iterationRequest.profilePolicy?.workflowGateOverride ?? activeWorkflowGateOverride;
            const invalidMutationAfterRefreshedEvidence =
              currentGateOverride?.terminalKind === "workflow-mutation-repair.refreshed";
            const patchOnlyAfterInvalidMutation =
              String(preflight.capabilityId) === "core.patch.apply" &&
              currentGateOverride?.requiredNextAction === "core.patch.apply" &&
              currentGateOverride?.terminalKind === "workflow-invalid-mutation-intent.rejected";
            const exactEditRecoveryAfterMutationFailure =
              editAlreadyFailedForStage &&
              String(preflight.capabilityId) === "core.file.edit" &&
              editRecoveryAvailable;
            if (
              mutationInputStallCount >= 2 &&
              !editAlreadyFailedForStage &&
              !patchAlreadyFailedForStage &&
              (!patchRecoveryAvailable || (!invalidMutationAfterRefreshedEvidence && !patchOnlyAfterInvalidMutation))
            ) {
              const stallError = kernelError(
                "KERNEL_POLICY_DENIED",
                "WORKFLOW_MUTATION_INPUT_STALLED: reviewed evidence already projected this mutation stage, but repeated preflight mutation intents carried no real source change; stop spending turns and report a bounded mutation blocker.",
                {
                  workflowReadyStageControl: readyStageControl,
                  requestedCapabilityId: String(preflight.capabilityId),
                  iteration: iterations,
                  mutationInputStallCount,
                  terminalKind: "workflow-invalid-mutation-intent.rejected"
                }
              );
              diagnostics.push(stallError);
              yield* emitFailureWithRepair("rejected", "workflow-mutation-input-stalled", stallError, invalidMutationEvent);
              terminalEmitted = true;
              return;
            }
            const currentGateAllowsEvidenceRefresh = currentGateOverride === undefined ||
              workflowGateRequiredActionAllowsCapability(currentGateOverride.requiredNextAction, "core.file.read") ||
              workflowGateRequiredActionAllowsCapability(currentGateOverride.requiredNextAction, "core.search.text");
            const reviewedEvidenceAlreadyProjected = readyStageControlProjectedFromReviewedEvidence(readyStageControl);
            const reviewedStageAllowsFocusedRefresh = reviewedEvidenceAlreadyProjected &&
              currentGateAllowsEvidenceRefresh &&
              readyStageAllowsCapability(readyStageControl, "core.file.read") &&
              mutationInputStallCount <= 1;
            const patchOnlyAfterRepeatedReviewedNoOp = reviewedEvidenceAlreadyProjected &&
              patchRecoveryAvailable &&
              invalidMutationAfterRefreshedEvidence &&
              !patchAlreadyFailedForStage &&
              mutationInputStallCount >= 2;
            const noOpFileEditInReviewedStage = reviewedEvidenceAlreadyProjected &&
              String(preflight.capabilityId) === "core.file.edit" &&
              editRecoveryAvailable &&
              invalidMutationIntentHasReason(invalidMutationIntent, "expected and replacement are identical");
            const keepExactEditRecovery = reviewedEvidenceAlreadyProjected && exactEditRecoveryAfterMutationFailure;
            const requiredNextAction = currentGateAllowsEvidenceRefresh && !reviewedEvidenceAlreadyProjected
              ? "focused-read-or-source-edit-or-bounded-blocker"
              : reviewedStageAllowsFocusedRefresh
                ? "focused-read-or-source-edit-or-bounded-blocker"
              : patchOnlyAfterInvalidMutation && editRecoveryAvailable
                ? "core.patch.apply|core.file.edit"
              : exactEditRecoveryAfterMutationFailure
                ? "core.patch.apply|core.file.edit"
              : patchOnlyAfterRepeatedReviewedNoOp
                ? "core.patch.apply"
              : noOpFileEditInReviewedStage
                ? "core.file.edit"
              : keepExactEditRecovery
                ? "core.file.edit"
              : patchRecoveryAvailable
                ? "core.patch.apply"
                : String(readyStageControl.requiredNextAction ?? currentGateOverride?.requiredNextAction ?? "core.file.edit");
            const gateOverride = convergenceWorkflowGateOverride({
              requiredNextAction,
              rejectedCapabilityId: String(preflight.capabilityId),
              rejectedToolName: toolName,
              terminalKind: "workflow-invalid-mutation-intent.rejected",
              toolCallId
            });
            activeWorkflowGateOverride = gateOverride;
            activeProfilePolicy = activeProfilePolicy ? { ...activeProfilePolicy, workflowGateOverride: gateOverride } : activeProfilePolicy;
            messages.push(invalidMutationIntentCorrectionMessage(readyStageControl, invalidMutationIntent, toolInput));
          }
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
          const deniedDispatch = buildDeniedDispatchResult({
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            normalizedInputHash,
            terminalKind: "hook.blocked",
            text: blockError.message,
            diagnostics: [blockError],
            correctiveAction: "Request permission, choose a different projected tool, or report a bounded blocker.",
            recommendedNextAction: "permission change, different projected tool, or bounded blocker",
            trace,
            limitBytes: limits.maxOutputBytes,
            continuation: "continue",
            iteration: iterations,
            metadata: { hook: "tool-execution.before" }
          });
          recordToolDecision(toolDecisionBoard, {
            kind: "policy",
            status: "denied",
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            normalizedInputHash,
            reasonCode: "hook.blocked",
            ...(deniedDispatch.feedback.correctiveAction ? { correctiveAction: deniedDispatch.feedback.correctiveAction } : {}),
            ...(deniedDispatch.feedback.recommendedNextAction ? { recommendedNextAction: deniedDispatch.feedback.recommendedNextAction } : {}),
            iteration: iterations,
            metadata: { hook: "tool-execution.before" }
          });
          recordRejectedToolFeedback(toolDecisionBoard, deniedDispatch.decisionRecord);
          const deniedEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
            ...deniedDispatch.eventData,
            evidence: await recordToolResultEvidence(deps, {
              ...deniedDispatch.evidenceInput,
              terminalKind: "hook.blocked"
            })
          }, request.agentId, blockError);
          await recordRuntimeAdapterEvent(deps, deniedEvent);
          yield deniedEvent;
          messages.push({ role: "tool", content: deniedDispatch.feedback.preview.text, toolCallId, toolName });
          continue;
        }
        const toolManifest = visibleCapabilities.find((capability) => capability.id === preflight.capabilityId);
        const kernelRequest: RuntimeKernelRequest = {
          capabilityId: preflight.capabilityId,
          caller: request.caller,
          input: toolInput,
          metadata: {
            activeModel: request.profile.model,
            activeModelProvider: typeof request.profile.provider === "string" && request.profile.provider.trim().length > 0
              ? request.profile.provider.trim()
              : String(request.profile.providerId),
            activeModelProviderId: String(request.profile.providerId),
            activeProfileId: request.profile.id
          },
          sessionId,
          turnId,
          timeoutMs: toolTimeoutFor(toolInput, limits.toolTimeoutMs, toolManifest?.timeoutMs, request.timeoutMs),
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
        if (terminal?.kind === "capability.completed") {
          const sourcePath = sourceEvidencePathFromToolInput(String(preflight.capabilityId), toolInput);
          if (sourcePath) acceptedSourceEvidencePaths.add(sourcePath);
        }
        const toolResultText = modelToolResultText(terminal);
        const feedbackStatus = executionFeedbackStatus(terminal);
        const recoverableToolFailure = isRecoverableToolError(terminal?.error);
        const correctiveAction = correctiveActionForToolFeedback(feedbackStatus);
        const recommendedNextAction = recommendedNextActionForToolFeedback(feedbackStatus);
        const executionFeedback = buildToolResultFeedback({
          toolCallId,
          toolName,
          capabilityId: String(preflight.capabilityId),
          status: feedbackStatus,
          text: toolResultText,
          diagnostics: terminal?.error ? [terminal.error] : [],
          ...(correctiveAction ? { correctiveAction } : {}),
          ...(recommendedNextAction ? { recommendedNextAction } : {}),
          trace,
          limitBytes: limits.maxOutputBytes,
          ...(terminal?.kind === "capability.completed" || recoverableToolFailure ? { continuation: "continue" as const } : {})
        });
        if (feedbackStatus === "denied") {
          recordToolDecision(toolDecisionBoard, {
            kind: "policy",
            status: "denied",
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            normalizedInputHash,
            reasonCode: terminal?.error?.code ?? terminal?.kind ?? "policy.denied",
            ...(executionFeedback.correctiveAction ? { correctiveAction: executionFeedback.correctiveAction } : {}),
            ...(executionFeedback.recommendedNextAction ? { recommendedNextAction: executionFeedback.recommendedNextAction } : {}),
            iteration: iterations,
            metadata: {
              terminalKind: terminal?.kind ?? "unknown"
            }
          });
        }
        recordToolDecision(toolDecisionBoard, {
          kind: "execution",
          status: feedbackStatusToDecisionStatus(feedbackStatus),
          toolCallId,
          toolName,
          capabilityId: String(preflight.capabilityId),
          normalizedInputHash,
          reasonCode: terminal?.kind ?? "unknown",
          ...(executionFeedback.correctiveAction ? { correctiveAction: executionFeedback.correctiveAction } : {}),
          ...(executionFeedback.recommendedNextAction ? { recommendedNextAction: executionFeedback.recommendedNextAction } : {}),
          iteration: iterations,
          metadata: {
            continuation: executionFeedback.continuation,
            terminalKind: terminal?.kind ?? "unknown"
          }
        });
        if (recoverableToolFailure && feedbackStatus !== "success") {
          recordRejectedIntent(toolDecisionBoard, {
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            normalizedInputHash,
            terminalKind: terminal?.kind ?? "capability.failed",
            correctiveAction: executionFeedback.correctiveAction,
            recommendedNextAction: executionFeedback.recommendedNextAction,
            iteration: iterations
          });
        }
        messages.push({ role: "tool", content: executionFeedback.preview.text, toolCallId, toolName });
        const resultEvent = agentLoopEvent("model.tool.result", sessionId, turnId, trace, {
          toolCallId,
          toolName,
          result: boundedModelText(toolResultText, limits.maxOutputBytes),
          terminalKind: terminal?.kind ?? "unknown",
          dispatchSummary: buildDispatchTerminalSummary({
            batchId: `dispatch:${toolCallId}`,
            toolCallId,
            toolName,
            capabilityId: String(preflight.capabilityId),
            terminalStatus: terminal?.kind === "capability.completed"
              ? "completed"
              : terminal?.kind === "capability.cancelled"
                ? terminal.error?.code === "KERNEL_SCHEDULER_TIMEOUT"
                  ? "timed-out"
                  : "cancelled"
                : terminal?.kind === "execution.rejected"
                  ? "rejected"
                  : terminal?.error?.code === "KERNEL_SCHEDULER_TIMEOUT"
                    ? "timed-out"
                    : "failed",
            inProgressToolCallIds: [toolCallId],
            elapsedMs: 0,
            evidenceIds: [`tool-result:${toolCallId}`],
            diagnostics: terminal?.error ? [terminal.error] : [],
            convergence: {
              kind: "continue",
              reasonCode: terminal?.kind ?? "unknown"
            }
          }),
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
        const completedMutationRefreshKey = currentReadyStageControl
          ? readyStageRequiredActionMissKey(currentReadyStageControl)
          : undefined;
        const completedMutationRefresh = completedMutationRefreshKey
          ? mutationExactRefreshByStage.get(completedMutationRefreshKey)
          : undefined;
        if (
          completedMutationRefreshKey &&
          completedMutationRefresh &&
          String(preflight.capabilityId) === "core.file.read" &&
          terminal?.kind === "capability.completed" &&
          mutationExactRefreshInputAllowed(completedMutationRefresh, toolInput)
        ) {
          mutationExactRefreshByStage.set(completedMutationRefreshKey, {
            ...completedMutationRefresh,
            consumed: true
          });
          readyStageMutationRepairHadFocusedRefresh.add(completedMutationRefreshKey);
          const gateOverride = convergenceWorkflowGateOverride({
            requiredNextAction: "core.file.edit|core.patch.apply",
            rejectedCapabilityId: "core.file.read",
            rejectedToolName: toolName,
            terminalKind: "workflow-mutation-exact-refresh.completed",
            toolCallId
          });
          activeWorkflowGateOverride = gateOverride;
          activeProfilePolicy = activeProfilePolicy
            ? { ...clearWorkflowGateOverride(activeProfilePolicy), workflowGateOverride: gateOverride }
            : activeProfilePolicy;
        }
        const currentProfilePolicy = activeProfilePolicy ?? iterationRequest.profilePolicy;
        const activeGateOverride = currentProfilePolicy?.workflowGateOverride ?? activeWorkflowGateOverride;
        const workflowProgress = advanceWorkflowStageFromToolEvidence({
          ...(currentProfilePolicy ? { profilePolicy: currentProfilePolicy } : {}),
          capabilityId: String(preflight.capabilityId),
          toolCallId,
          toolInput,
          terminal,
          at: terminal?.createdAt ?? resultEvent.createdAt
        });
        const workflowAdvanced = workflowProgress !== undefined;
        if (workflowProgress) {
          activeProfilePolicy = clearWorkflowGateOverride(workflowProgress.profilePolicy);
          activeWorkflowGateOverride = activeProfilePolicy.workflowGateOverride;
          for (const stageEvent of workflowProgress.stageEvents) {
            const workflowStep = agentLoopEvent("workflow.step", sessionId, turnId, trace, {
              workflowId: workflowProgress.profilePolicy.workflowGraphId,
              graphId: workflowProgress.profilePolicy.stagedTaskWorkflow?.graphId ?? workflowProgress.profilePolicy.workflowGraphId,
              stageId: stageEvent.stageId,
              status: stageEvent.kind === "stage.started"
                ? "running"
                : stageEvent.kind === "stage.succeeded"
                  ? "succeeded"
                  : stageEvent.kind === "stage.evaluation.required"
                    ? "evaluation-required"
                    : "failed",
              capabilityId: String(preflight.capabilityId),
              toolCallId,
              stageEvent,
              runState: workflowProgress.profilePolicy.stagedTaskWorkflow?.runState,
              redaction: { class: "internal", fields: ["runState.stageStates.diagnostics", "stageEvent.outputRefs.preview"] }
            }, request.agentId);
            await recordRuntimeAdapterEvent(deps, workflowStep);
            yield workflowStep;
          }
          const externalHarnessReturn = externalHarnessReturnGateAfterLocalVerification(activeProfilePolicy, workflowProgress.stage.kind);
          if (externalHarnessReturn) {
            const consumed = agentLoopEvent("agent.loop.budget.consumed", sessionId, turnId, trace, externalHarnessReturn, request.agentId);
            await recordRuntimeAdapterEvent(deps, consumed);
            yield consumed;
            const summary = {
              ...summarizeAgentLoop("completed", request, sessionId, turnId, trace, assistantText, iterations, toolCalls, diagnostics, summaryMode()),
              reason: "external-score-ready",
              workflow: {
                profileId: activeProfilePolicy.profileId,
                workflowGraphId: activeProfilePolicy.workflowGraphId,
                graphId: activeProfilePolicy.stagedTaskWorkflow?.graphId,
                stageStates: activeProfilePolicy.stagedTaskWorkflow?.runState.stageStates.map((stage) => ({
                  stageId: stage.stageId,
                  status: stage.status,
                  outputRefs: stage.outputRefs
                })) ?? []
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
          if (activeProfilePolicy && shouldClosePrimaryWorkflowAfterProgress(activeProfilePolicy, workflowProgress.stage.kind)) {
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
            if (verification.repairRequested || verification.terminalStatus === "failed") {
              const verifierError = finalVerifierFailureError(verification.verifierResult, verification.outputContract);
              diagnostics.push(verifierError);
              if (iterations < limits.maxModelIterations) {
                const repairQueued = yield* emitFailureWithRepair("failed", "final-verifier-failed", verifierError, lastVerifierEvent(verification.events));
                if (repairQueued) {
                  activeWorkflowGateOverride = outputContractRepairWorkflowGateOverride(verification.outputContract) ?? activeWorkflowGateOverride;
                  assistantText = "";
                  continue;
                }
              }
              terminalEmitted = true;
              return;
            }
            const outcomeReasoning = await emitVisibleReasoning({
              actor: "runtime",
              stepKind: "outcome",
              status: "completed",
              summary: "Primary staged workflow completed all stages; outer loop will not request additional model actions.",
              phase: "outcome",
              certainty: "verified",
              evidence: [visibleReasoningEvidence("trace", {
                kind: "tool-evidence",
                id: `workflow-completed:${activeProfilePolicy.stagedTaskWorkflow?.graphId ?? activeProfilePolicy.workflowGraphId}`,
                label: "workflow stages completed",
                sessionId,
                turnId,
                metadata: {
                  profileId: activeProfilePolicy.profileId,
                  workflowGraphId: activeProfilePolicy.workflowGraphId,
                  graphId: activeProfilePolicy.stagedTaskWorkflow?.graphId
                }
              }, "workflow stages completed")]
            });
            yield outcomeReasoning;
            const projectedReasoning = await emitVisibleReasoningProjection();
            yield projectedReasoning;
            const terminalToolCompletedWorkflow = activeProfilePolicy.stageAcceptanceMode === "supervisor" &&
              terminal?.kind === "capability.completed" &&
              terminalEvidenceStatusCompleted(terminal) &&
              terminal.error === undefined;
            const summary = {
              ...summarizeAgentLoop("completed", request, sessionId, turnId, trace, assistantText, iterations, toolCalls, diagnostics, summaryMode()),
              reason: terminalToolCompletedWorkflow ? "terminal-tool-completed" : "workflow-stages-completed",
              ...(terminalToolCompletedWorkflow
                ? {
                  terminalTool: {
                    toolCallId,
                    toolName,
                    capabilityId: String(preflight.capabilityId),
                    terminalKind: terminal?.kind ?? "unknown",
                    feedbackStatus: executionFeedback.status
                  }
                }
                : {}),
              workflow: {
                profileId: activeProfilePolicy.profileId,
                workflowGraphId: activeProfilePolicy.workflowGraphId,
                graphId: activeProfilePolicy.stagedTaskWorkflow?.graphId,
                stageStates: activeProfilePolicy.stagedTaskWorkflow?.runState.stageStates.map((stage) => ({
                  stageId: stage.stageId,
                  status: stage.status,
                  outputRefs: stage.outputRefs
                })) ?? []
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
        }
        if (
          !workflowAdvanced &&
          activeGateOverride !== undefined &&
          (
            activeGateOverride.terminalKind === "workflow-mutation-repair.required" ||
            activeGateOverride.terminalKind === "workflow-mutation-repair.refreshed" ||
            activeGateOverride.terminalKind === "workflow-standard-test-repair.refreshed"
          ) &&
          readyStageKindMatches(currentReadyStageControl, ["verify", "score"]) &&
          isMutationCapabilityId(String(preflight.capabilityId)) &&
          terminal?.kind === "capability.completed" &&
          terminalEvidenceStatusCompleted(terminal)
        ) {
          const evaluationWorkflow = activeProfilePolicy?.workflowGovernanceMode === "evaluation" ||
            String(activeProfilePolicy?.role ?? "").includes("evaluation");
          const requiredNextAction = evaluationWorkflow
            ? "standard-test-command-or-bounded-blocker"
            : "standard-test-command";
          const gateOverride = convergenceWorkflowGateOverride({
            requiredNextAction,
            rejectedCapabilityId: String(preflight.capabilityId),
            rejectedToolName: toolName,
            terminalKind: "workflow-standard-test-required",
            toolCallId
          });
          activeWorkflowGateOverride = gateOverride;
          activeProfilePolicy = activeProfilePolicy
            ? { ...clearWorkflowGateOverride(activeProfilePolicy), workflowGateOverride: gateOverride }
            : activeProfilePolicy;
          messages.push({
            role: "system",
            content: [
              "WORKFLOW_STANDARD_TEST_REQUIRED: a source mutation completed during failed-test repair.",
              `Required next action: ${requiredNextAction}.`,
              evaluationWorkflow
                ? "Run the narrowest problem reproduction with a safe python -c command when it can falsify the fix, or run the narrowest applicable standard repository test command before making more source edits."
                : "Run the narrowest applicable standard repository test command before making more source edits."
            ].join("\n")
          });
          restartModelAfterWorkflowCorrection = true;
          break;
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
        if (
          activeGateOverride?.terminalKind === "workflow-stage-evidence-window.opened" &&
          isFocusedEvidenceRefreshCapabilityId(String(preflight.capabilityId)) &&
          terminal?.kind === "capability.completed"
        ) {
          const windowKey = readyStageRequiredActionMissKey(currentReadyStageControl);
          const currentWindow = stageEvidenceWindows.get(windowKey);
          const evidenceCompleted = focusedEvidenceRefreshCompleted(String(preflight.capabilityId), terminal, toolInput);
          const searchAcceptance = evidenceCompleted && currentWindow && String(preflight.capabilityId) === "core.search.text"
            ? acceptStageEvidenceSearch(currentWindow, toolInput, toolResultText)
            : undefined;
          const duplicateSearchEvidence = searchAcceptance?.duplicate === true;
          const updatedWindow = evidenceCompleted && currentWindow && String(preflight.capabilityId) === "core.file.read"
            ? acceptStageEvidenceRead(currentWindow, toolInput, toolResultText)
            : searchAcceptance?.state ?? (evidenceCompleted && currentWindow
              ? { ...currentWindow, acceptedOperations: currentWindow.acceptedOperations + 1 }
              : currentWindow);
          if (updatedWindow) stageEvidenceWindows.set(windowKey, updatedWindow);
          if (evidenceCompleted && updatedWindow && !duplicateSearchEvidence) {
            const acceptedEvent = agentLoopEvent("workflow.stage-evidence.accepted", sessionId, turnId, trace, {
              stageId: currentReadyStageControl?.stageId ?? "unknown",
              stageKey: windowKey,
              capabilityId: String(preflight.capabilityId),
              acceptedOperations: updatedWindow.acceptedOperations,
              maxAcceptedOperations: updatedWindow.maxAcceptedOperations,
              coveredReadRanges: updatedWindow.coveredReadRanges,
              relatedTargetPaths: updatedWindow.relatedTargetPaths,
              ...(searchAcceptance ? { evidenceFingerprint: searchAcceptance.fingerprint } : {}),
              toolCallId
            }, request.agentId);
            await recordRuntimeAdapterEvent(deps, acceptedEvent);
            yield acceptedEvent;
          }
          if (evidenceCompleted && !duplicateSearchEvidence && updatedWindow && !stageEvidenceWindowShouldClose(updatedWindow, String(preflight.capabilityId))) {
            continue;
          }
          const explicitMutationAction = String(currentReadyStageControl?.requiredNextAction ?? "core.file.edit|core.patch.apply");
          const gateOverride = convergenceWorkflowGateOverride({
            requiredNextAction: explicitMutationAction,
            rejectedCapabilityId: String(preflight.capabilityId),
            rejectedToolName: toolName,
            terminalKind: "workflow-stage-evidence-window.closed",
            toolCallId
          });
          activeWorkflowGateOverride = gateOverride;
          activeProfilePolicy = profilePolicyWithRuntimeWorkflowGateOverride(iterationRequest.profilePolicy, gateOverride);
          const closedEvent = agentLoopEvent("workflow.stage-evidence.window.closed", sessionId, turnId, trace, {
            stageId: currentReadyStageControl?.stageId ?? "unknown",
            stageKey: windowKey,
            reason: duplicateSearchEvidence
              ? "duplicate"
              : String(preflight.capabilityId) === "core.search.text"
              ? "search-completed"
              : evidenceCompleted
                ? "window-exhausted"
                : "evidence-empty",
            acceptedOperations: updatedWindow?.acceptedOperations ?? 0,
            requiredNextAction: explicitMutationAction,
            toolCallId
          }, request.agentId);
          await recordRuntimeAdapterEvent(deps, closedEvent);
          yield closedEvent;
          messages.push({
            role: "user",
            content: [
              "WORKFLOW_FOCUSED_EVIDENCE_WINDOW_CLOSED.",
              "Focused source evidence is now available for the reviewed mutation stage.",
              `Required next action: ${explicitMutationAction}.`,
              "Apply a source mutation or report a bounded blocker; do not continue source inspection."
            ].join("\n")
          });
        }
        if (
          allowedDiagnosticRepairRefresh &&
          (
            activeGateOverride === undefined ||
            activeGateOverride.terminalKind === "workflow-official-repair.refreshed"
          ) &&
          isFocusedEvidenceRefreshCapabilityId(String(preflight.capabilityId)) &&
          terminal?.kind === "capability.completed" &&
          focusedEvidenceRefreshCompleted(String(preflight.capabilityId), terminal, toolInput) &&
          (
            readyStageKindMatches(currentReadyStageControl, ["produce", "materialize", "repair"]) ||
            (
              activeGateOverride?.terminalKind === "workflow-mutation-repair.required" &&
              readyStageKindMatches(currentReadyStageControl, ["verify", "score"])
            )
          )
        ) {
          const refreshKey = readyStageRequiredActionMissKey(currentReadyStageControl);
          const refreshCount = (officialDiagnosticRepairFocusedRefreshCounts.get(refreshKey) ?? 0) + 1;
          officialDiagnosticRepairFocusedRefreshCounts.set(refreshKey, refreshCount);
          const explicitMutationAction = String(currentReadyStageControl?.requiredNextAction ?? "core.file.edit|core.patch.apply");
          const requiredNextAction = refreshCount >= OFFICIAL_DIAGNOSTIC_REPAIR_FOCUSED_REFRESH_LIMIT
            ? explicitMutationAction
            : "focused-read-or-source-edit-or-bounded-blocker";
          const gateOverride = convergenceWorkflowGateOverride({
            requiredNextAction,
            rejectedCapabilityId: String(preflight.capabilityId),
            rejectedToolName: toolName,
            terminalKind: "workflow-official-repair.refreshed",
            toolCallId
          });
          activeWorkflowGateOverride = gateOverride;
          activeProfilePolicy = activeProfilePolicy ? { ...activeProfilePolicy, workflowGateOverride: gateOverride } : activeProfilePolicy;
          messages.push({
            role: "user",
            content: [
              "WORKFLOW_OFFICIAL_REPAIR_EVIDENCE_REFRESHED.",
              "A focused read/search refreshed evidence for an official evaluation repair stage.",
              `Focused evidence refresh count: ${refreshCount}/${OFFICIAL_DIAGNOSTIC_REPAIR_FOCUSED_REFRESH_LIMIT}.`,
              `Required next action: ${requiredNextAction}.`,
              refreshCount >= OFFICIAL_DIAGNOSTIC_REPAIR_FOCUSED_REFRESH_LIMIT
                ? "Apply a source mutation, run a standard test, or report a bounded blocker. Do not continue source inspection without acting on the collected diagnostic evidence."
                : "Continue bounded focused inspection only when needed, then apply a source mutation, run a standard test, or report a bounded blocker."
            ].join("\n")
          });
        }
        if (
          (
            activeGateOverride?.terminalKind === "workflow-mutation-repair.required" ||
            activeGateOverride?.terminalKind === "workflow-invalid-mutation-intent.rejected" ||
            activeGateOverride?.terminalKind === "workflow-mutation-repair.refreshed"
          ) &&
          (
            workflowGateRequiredActionAllowsCapability(activeGateOverride.requiredNextAction, String(preflight.capabilityId)) ||
            (
              activeGateOverride.terminalKind === "workflow-mutation-repair.required" &&
              isFocusedEvidenceRefreshCapabilityId(String(preflight.capabilityId))
            )
          ) &&
          isFocusedEvidenceRefreshCapabilityId(String(preflight.capabilityId)) &&
          terminal?.kind === "capability.completed" &&
          focusedEvidenceRefreshCompleted(String(preflight.capabilityId), terminal, toolInput) &&
          readyStageKindMatches(currentReadyStageControl, ["produce", "materialize", "repair"])
        ) {
          if (
            readyStageControlProjectedFromReviewedEvidence(currentReadyStageControl) &&
            currentReadyStageControl !== undefined
          ) {
            readyStageMutationRepairHadFocusedRefresh.add(readyStageRequiredActionMissKey(currentReadyStageControl));
          }
          const supportingContextRefresh = !workflowGateRequiredActionAllowsCapability(
            activeGateOverride.requiredNextAction,
            String(preflight.capabilityId)
          );
          const requiredNextAction = supportingContextRefresh
            ? activeGateOverride.requiredNextAction
            : String(preflight.capabilityId) === "core.search.text" ||
            (
              activeGateOverride?.terminalKind === "workflow-invalid-mutation-intent.rejected" &&
              readyStageControlProjectedFromReviewedEvidence(currentReadyStageControl)
            )
            ? "focused-read-or-source-edit-or-bounded-blocker"
            : String(currentReadyStageControl?.requiredNextAction ?? "source-edit-or-test-or-bounded-blocker");
          const gateOverride = convergenceWorkflowGateOverride({
            requiredNextAction,
            rejectedCapabilityId: String(preflight.capabilityId),
            rejectedToolName: toolName,
            terminalKind: "workflow-mutation-repair.refreshed",
            toolCallId
          });
          activeWorkflowGateOverride = gateOverride;
          activeProfilePolicy = activeProfilePolicy ? { ...activeProfilePolicy, workflowGateOverride: gateOverride } : activeProfilePolicy;
        }
        if (
          (
            activeGateOverride?.terminalKind === "workflow-standard-test-failed" ||
            activeGateOverride?.terminalKind === "workflow-standard-test-repair.refreshed"
          ) &&
          workflowGateRequiredActionAllowsCapability(activeGateOverride.requiredNextAction, String(preflight.capabilityId)) &&
          isFocusedEvidenceRefreshCapabilityId(String(preflight.capabilityId)) &&
          terminal?.kind === "capability.completed" &&
          focusedEvidenceRefreshCompleted(String(preflight.capabilityId), terminal, toolInput)
        ) {
          const standardTestFailureToolCallId = String(
            activeGateOverride.standardTestFailureToolCallId ?? activeGateOverride.toolCallId
          );
          const refreshKey = [
            readyStageRequiredActionMissKey(currentReadyStageControl),
            standardTestFailureToolCallId
          ].join(":");
          const refreshCount = (failedStandardTestRepairFocusedRefreshCounts.get(refreshKey) ?? 0) + 1;
          failedStandardTestRepairFocusedRefreshCounts.set(refreshKey, refreshCount);
          const requiredNextAction = refreshCount >= FAILED_STANDARD_TEST_REPAIR_FOCUSED_REFRESH_LIMIT
            ? "core.file.edit|core.patch.apply|core.test.run"
            : "focused-read-or-source-edit-or-test-or-return-control";
          const gateOverride = convergenceWorkflowGateOverride({
            requiredNextAction,
            rejectedCapabilityId: String(preflight.capabilityId),
            rejectedToolName: toolName,
            terminalKind: "workflow-standard-test-repair.refreshed",
            toolCallId,
            standardTestFailureToolCallId
          });
          activeWorkflowGateOverride = gateOverride;
          activeProfilePolicy = activeProfilePolicy ? { ...activeProfilePolicy, workflowGateOverride: gateOverride } : activeProfilePolicy;
          messages.push({
            role: "user",
            content: [
              "WORKFLOW_STANDARD_TEST_REPAIR_EVIDENCE_REFRESHED.",
              "A focused read/search refreshed evidence after a failed standard test.",
              `Focused evidence refresh count: ${refreshCount}/${FAILED_STANDARD_TEST_REPAIR_FOCUSED_REFRESH_LIMIT}.`,
              `Required next action: ${requiredNextAction}.`,
              refreshCount >= FAILED_STANDARD_TEST_REPAIR_FOCUSED_REFRESH_LIMIT
                ? "Apply a source mutation, rerun a standard test, or report a bounded blocker. Do not keep inspecting without a new failed-test proof obligation."
                : "Continue with bounded focused reads only when needed, apply a source mutation, rerun a standard test, or report a bounded blocker."
            ].join("\n")
          });
        }
        const evaluationReproductionCompleted = terminal?.kind === "capability.completed" &&
          terminalEvidenceStatusCompleted(terminal) &&
          isAllowedEvaluationReproductionToolInput({
            ...(iterationRequest.profilePolicy ? { profilePolicy: iterationRequest.profilePolicy } : {}),
            capabilityId: String(preflight.capabilityId),
            toolInput
          });
        if (evaluationReproductionCompleted) {
          if (evaluationBehaviorReproductionActive(iterationRequest.profilePolicy, currentReadyStageControl)) {
            evaluationBehaviorReproductionSatisfied.add(readyStageRequiredActionMissKey(currentReadyStageControl));
          }
          const gateOverride = convergenceWorkflowGateOverride({
            requiredNextAction: "focused-read-or-source-edit-or-test-or-return-control",
            rejectedCapabilityId: String(preflight.capabilityId),
            rejectedToolName: toolName,
            terminalKind: "workflow-evaluation-reproduction.completed",
            toolCallId
          });
          activeWorkflowGateOverride = gateOverride;
          activeProfilePolicy = activeProfilePolicy
            ? { ...clearWorkflowGateOverride(activeProfilePolicy), workflowGateOverride: gateOverride }
            : activeProfilePolicy;
          messages.push({
            role: "user",
            content: [
              "WORKFLOW_EVALUATION_REPRODUCTION_COMPLETED.",
              "The bounded evaluation reproduction command ran without mutating the workspace.",
              "Required next action: focused-read-or-source-edit-or-test-or-return-control.",
              "Evaluate the reproduction output: if the reported behavior still reproduces, inspect focused source context and apply a minimal source edit or patch; otherwise run the narrowest standard repository test.",
              "Do not use core.test.run for source inspection commands; use focused read/search tools for inspection and mutation tools for fixes."
            ].join("\n")
          });
          restartModelAfterWorkflowCorrection = true;
          break;
        }
        const progressCapabilityRequested = readyStageProgressCapabilitySatisfied(String(preflight.capabilityId), currentReadyStageControl);
        const standardVerifyCommandMissing = requiresStandardVerifyCommandBeforeTerminal(
          String(preflight.capabilityId),
          terminal,
          currentReadyStageControl,
          toolInput
        );
        const evaluationBehaviorReproductionMissing = requiresEvaluationBehaviorReproductionBeforePublicTest({
          profilePolicy: iterationRequest.profilePolicy,
          readyStageControl: currentReadyStageControl,
          capabilityId: String(preflight.capabilityId),
          toolInput,
          reproductionSatisfied: evaluationBehaviorReproductionSatisfied.has(readyStageRequiredActionMissKey(currentReadyStageControl))
        });
        const publicTestSelectedNoTests = evaluationBehaviorReproductionMissing && testResultSelectedNoTests(toolResultText);
        if (
          evaluationBehaviorReproductionMissing &&
          terminal !== undefined &&
          (
            (terminal.kind === "capability.completed" && terminalEvidenceStatusCompleted(terminal)) ||
            publicTestSelectedNoTests
          )
        ) {
          const readyStageControl = currentReadyStageControl;
          if (!readyStageControl) continue;
          const error = kernelError(
            "KERNEL_POLICY_DENIED",
            "WORKFLOW_BEHAVIOR_REPRODUCTION_REQUIRED: evaluation cannot close from a public repository test file alone because the required behavior may be hidden or harness-injected; run a safe python -c reproduction from the problem statement or official failure evidence first.",
            {
              workflowReadyStageControl: readyStageControl,
              requestedCapabilityId: String(preflight.capabilityId),
              iteration: iterations,
              terminalKind: terminal.kind,
              command: toolCommandText(toolInput)
            }
          );
          diagnostics.push(error);
          const missed = agentLoopEvent("workflow.required-action.missed", sessionId, turnId, trace, {
            ...readyStageControl,
            requestedCapabilityId: String(preflight.capabilityId),
            iteration: iterations,
            modelRequestCount: iterations,
            toolCallCount: toolCalls,
            correctionAttempt: 1,
            retryPolicy: "retry-with-feedback",
            behaviorReproductionMissing: true,
            feedbackStatus: executionFeedback.status,
            terminalKind: terminal.kind
          }, request.agentId, error);
          await recordRuntimeAdapterEvent(deps, missed);
          yield missed;
          const gateOverride = convergenceWorkflowGateOverride({
            requiredNextAction: "standard-test-command-or-bounded-blocker",
            rejectedCapabilityId: String(preflight.capabilityId),
            rejectedToolName: toolName,
            terminalKind: "workflow-behavior-reproduction.required",
            toolCallId
          });
          activeWorkflowGateOverride = gateOverride;
          activeProfilePolicy = activeProfilePolicy
            ? { ...clearWorkflowGateOverride(activeProfilePolicy), workflowGateOverride: gateOverride }
            : activeProfilePolicy;
          messages.push({
            role: "system",
            content: [
              "WORKFLOW_OFFICIAL_REPAIR_REPRODUCTION_REQUIRED.",
              "Official fail-to-pass tests may be hidden or injected by the harness; passing the existing public test file alone is not sufficient repair evidence.",
              "Required next action: standard-test-command-or-bounded-blocker.",
              `Current governed checkout root: ${request.workspaceRoot}.`,
              "Run the reproduction directly from that checkout root: omit cwd and do not prepend cd or another absolute workspace path.",
              "Run a safe python -c reproduction constructed from the official failure excerpt or original problem statement. After that reproduction runs, you may run the narrowest public pytest/unittest command as a closure check.",
              "Do not inspect more source or make another source edit until the hidden-case reproduction has been attempted or you report a bounded blocker."
            ].join("\n")
          });
          restartModelAfterWorkflowCorrection = true;
          break;
        }
        const terminalToolCompleted = isTerminalToolCompletion(String(preflight.capabilityId), terminal, currentReadyStageControl, toolInput);
        const progressCapabilitySucceeded = progressCapabilityRequested
          && terminal?.kind === "capability.completed"
          && (terminalEvidenceStatusCompleted(terminal) || terminalToolCompleted)
          && !standardVerifyCommandMissing;
        const terminalToolFailed = isTerminalToolFailure(String(preflight.capabilityId), terminal, currentReadyStageControl);
        const failedProgressCapability = progressCapabilityRequested
          && terminal !== undefined
          && !terminalToolFailed
          && !terminalToolCompleted
          && (
            readyStageKindMatches(currentReadyStageControl, ["verify", "score"]) ||
            (readyStageKindMatches(currentReadyStageControl, ["produce", "materialize", "repair"]) && recoverableToolFailure)
          )
          && !progressCapabilitySucceeded;
        const failedStandardVerifyCommand = failedProgressCapability
          && readyStageKindMatches(currentReadyStageControl, ["verify"])
          && (terminal?.kind === "capability.completed" || terminal?.kind === "capability.failed")
          && !standardVerifyCommandMissing;
        const repeatedProgressEvidence = progressCapabilitySucceeded
          && repeatedReadyStageProgressEvidence(readyStageProgressEvidenceCounts, {
            control: currentReadyStageControl,
            capabilityId: String(preflight.capabilityId),
            toolInput,
            normalizedInputHash
          });
        if (progressCapabilitySucceeded && !repeatedProgressEvidence) {
          iterationProgressCapabilitySatisfied = true;
        }
        const gateOverrideSatisfied = workflowGateOverrideAllowsCapability(
          iterationRequest.profilePolicy?.workflowGateOverride,
          String(preflight.capabilityId)
        );
        const gateMutationFailure = gateOverrideSatisfied &&
          isMutationCapabilityId(String(preflight.capabilityId)) &&
          terminal !== undefined &&
          terminal.kind !== "capability.completed" &&
          recoverableToolFailure;
        const nonProgressStageMiss = (
          !workflowAdvanced &&
          !gateOverrideSatisfied &&
          !allowsDiagnosticRepairFocusedRefresh(
            String(preflight.capabilityId),
            currentReadyStageControl,
            iterationRequest.profilePolicy
          ) &&
          (
            (!iterationProgressCapabilitySatisfied && readyStageNonProgressCapabilityMiss(String(preflight.capabilityId), currentReadyStageControl))
            || repeatedProgressEvidence
          )
        ) || (failedProgressCapability && !failedStandardVerifyCommand) || gateMutationFailure;
        if (nonProgressStageMiss && terminal !== undefined) {
          const readyStageControl = currentReadyStageControl;
          if (!readyStageControl) continue;
          const activeGateForMiss = iterationRequest.profilePolicy?.workflowGateOverride;
          const effectiveReadyStageControl = gateMutationFailure &&
            activeGateForMiss &&
            readyStageKindMatches(readyStageControl, ["verify", "score"])
            ? {
                ...readyStageControl,
                requiredNextAction: activeGateForMiss.requiredNextAction,
                gateRequiredNextAction: activeGateForMiss.requiredNextAction,
                underlyingRequiredNextAction: readyStageControl.requiredNextAction,
                terminalKind: activeGateForMiss.terminalKind
              }
            : readyStageControl;
          const missKey = readyStageRequiredActionMissKey(effectiveReadyStageControl);
          const recoverableMutationFailure = (failedProgressCapability || gateMutationFailure) &&
            recoverableToolFailure &&
            (
              readyStageKindMatches(readyStageControl, ["produce", "materialize", "repair"]) ||
              workflowGateRequiredActionAllowsCapability(
                iterationRequest.profilePolicy?.workflowGateOverride?.requiredNextAction ?? "",
                String(preflight.capabilityId)
              )
            );
          const mutationRepairMissKey = recoverableMutationFailure
            ? `${missKey}:${String(preflight.capabilityId)}`
            : missKey;
          const missCount = recoverableMutationFailure
            ? readyStageMutationRepairMisses.get(mutationRepairMissKey) ?? 0
            : readyStageRequiredActionMisses.get(missKey) ?? 0;
          const convergence = readyStageRequiredActionConvergence({
            missCount,
            correctionLimit: READY_STAGE_REQUIRED_ACTION_CORRECTION_LIMIT,
            iteration: iterations,
            maxModelIterations: effectiveMaxModelIterationsForWorkflowGate(
              limits.maxModelIterations,
              iterationRequest.profilePolicy?.workflowGateOverride
            ),
            workflowReadyStageControl: effectiveReadyStageControl,
            requestedCapabilityId: String(preflight.capabilityId)
          });
          const correctionAttempt = Number(convergence.metadata?.correctionAttempt ?? missCount + 1);
          const retryPolicy = String(convergence.metadata?.retryPolicy ?? "fail-closed");
          const canCorrect = convergence.kind === "retry-with-feedback";
          const error = kernelError(
            "KERNEL_POLICY_DENIED",
            repeatedProgressEvidence
              ? `WORKFLOW_REQUIRED_ACTION_MISSED: model repeated ${String(preflight.capabilityId)} for evidence already inspected in ${String(effectiveReadyStageControl.stageId ?? "the active stage")}; choose the next workflow action or report a bounded blocker.`
              : standardVerifyCommandMissing
                ? `WORKFLOW_REQUIRED_ACTION_MISSED: model requested ${String(preflight.capabilityId)} for ${String(effectiveReadyStageControl.stageId ?? "the active stage")} with a non-standard verification command; run a standard repository test command.`
                : failedProgressCapability
                ? `WORKFLOW_REQUIRED_ACTION_MISSED: model requested ${String(preflight.capabilityId)} for ${String(effectiveReadyStageControl.stageId ?? "the active stage")} but the tool did not complete successfully; choose a bounded retry, narrower verification, or report the blocker.`
              : `WORKFLOW_REQUIRED_ACTION_MISSED: model requested ${String(preflight.capabilityId)} but the active stage requires ${String(effectiveReadyStageControl.requiredNextAction ?? "")}.`,
            {
              workflowReadyStageControl: effectiveReadyStageControl,
              requestedCapabilityId: String(preflight.capabilityId),
              iteration: iterations,
              repeatedProgressEvidence,
              failedProgressCapability,
              standardVerifyCommandMissing,
              feedbackStatus: executionFeedback.status,
              terminalKind: terminal.kind
            }
          );
          diagnostics.push(error);
          const missed = agentLoopEvent("workflow.required-action.missed", sessionId, turnId, trace, {
            ...effectiveReadyStageControl,
            requestedCapabilityId: String(preflight.capabilityId),
            iteration: iterations,
            modelRequestCount: iterations,
            toolCallCount: toolCalls,
            correctionAttempt,
            retryPolicy,
            failedProgressCapability,
            standardVerifyCommandMissing,
            feedbackStatus: executionFeedback.status,
            terminalKind: terminal.kind
          }, request.agentId, error);
          await recordRuntimeAdapterEvent(deps, missed);
          yield missed;
          const exactRefreshTargetPath = recoverableMutationFailure
            ? editPreconditionFailureTargetPath(
                String(preflight.capabilityId),
                toolInput,
                terminal?.error
              )
            : undefined;
          if (recoverableMutationFailure) {
            const mutationStageKey = readyStageRequiredActionMissKey(readyStageControl);
            if (exactRefreshTargetPath) {
              mutationExactRefreshByStage.set(mutationStageKey, {
                targetPath: exactRefreshTargetPath,
                failedToolCallId: toolCallId,
                consumed: false
              });
            }
            if (String(preflight.capabilityId) === "core.file.edit") {
              readyStageEditRepairFailures.add(missKey);
            }
            if (String(preflight.capabilityId) === "core.patch.apply") {
              readyStagePatchRepairFailures.add(missKey);
            }
            const reviewedEvidenceAlreadyProjected = readyStageControlProjectedFromReviewedEvidence(readyStageControl);
            const mutationInputStallCount = reviewedEvidenceAlreadyProjected
              ? (readyStageMutationInputStalls.get(missKey) ?? 0) + 1
              : 0;
            if (reviewedEvidenceAlreadyProjected) {
              readyStageMutationInputStalls.set(missKey, mutationInputStallCount);
            }
            readyStageMutationRepairMisses.set(mutationRepairMissKey, missCount + 1);
            const mutationInputStallLimit = readyStageMutationRepairHadFocusedRefresh.has(missKey) ? 5 : 4;
            if (mutationInputStallCount >= mutationInputStallLimit) {
              const stallError = kernelError(
                "KERNEL_POLICY_DENIED",
                "WORKFLOW_MUTATION_INPUT_STALLED: reviewed evidence already projected this mutation stage, but repeated edit/patch inputs failed or carried no real source change; stop spending turns and report a bounded mutation blocker.",
                {
                  workflowReadyStageControl: readyStageControl,
                  requestedCapabilityId: String(preflight.capabilityId),
                  iteration: iterations,
                  mutationInputStallCount,
                  failedProgressCapability,
                  feedbackStatus: executionFeedback.status,
                  terminalKind: terminal.kind
                }
              );
              diagnostics.push(stallError);
              yield* emitFailureWithRepair("rejected", "workflow-mutation-input-stalled", stallError, missed);
              terminalEmitted = true;
              return;
            }
          } else {
            readyStageRequiredActionMisses.set(missKey, missCount + 1);
          }
          if (canCorrect) {
            if (recoverableMutationFailure) {
              const activeRequiredNextAction = iterationRequest.profilePolicy?.workflowGateOverride?.requiredNextAction ?? "";
              const patchRecoveryAvailable = readyStageAllowsCapability(readyStageControl, "core.patch.apply") ||
                workflowGateRequiredActionAllowsCapability(activeRequiredNextAction, "core.patch.apply");
              const patchOnlyAfterInvalidMutation =
                activeRequiredNextAction === "core.patch.apply" &&
                iterationRequest.profilePolicy?.workflowGateOverride?.terminalKind === "workflow-invalid-mutation-intent.rejected";
              const reviewedEvidenceAlreadyProjected = readyStageControlProjectedFromReviewedEvidence(readyStageControl);
              const editAlreadyFailedForStage = readyStageEditRepairFailures.has(missKey);
              const patchAlreadyFailedForStage = readyStagePatchRepairFailures.has(missKey);
              const exactEditRecoveryAvailable = String(preflight.capabilityId) === "core.file.edit" &&
                (
                  patchAlreadyFailedForStage ||
                  readyStageMutationRepairHadFocusedRefresh.has(missKey) ||
                  (!patchRecoveryAvailable && reviewedEvidenceAlreadyProjected)
                ) &&
                (
                  readyStageAllowsCapability(readyStageControl, "core.file.edit") ||
                  workflowGateRequiredActionAllowsCapability(activeRequiredNextAction, "core.file.edit")
                );
              const effectiveMutationMissCount = gateMutationFailure && String(preflight.capabilityId) !== "core.patch.apply"
                ? Math.max(missCount, 1)
                : missCount;
              const defaultMutationRepairRequiredNextAction = exactEditRecoveryAvailable && patchRecoveryAvailable
                ? "core.patch.apply|core.file.edit"
                : exactEditRecoveryAvailable
                  ? "core.file.edit"
                : patchRecoveryAvailable &&
                String(preflight.capabilityId) === "core.patch.apply" &&
                effectiveMutationMissCount >= 1
                ? "core.patch.apply"
                : patchRecoveryAvailable &&
                  String(preflight.capabilityId) === "core.patch.apply" &&
                  patchOnlyAfterInvalidMutation
                ? "core.patch.apply|core.file.edit"
                : patchRecoveryAvailable && effectiveMutationMissCount >= 2
                ? "core.patch.apply"
                : effectiveMutationMissCount >= 1
                  ? patchRecoveryAvailable ? "core.patch.apply|core.file.edit" : "core.file.edit"
                  : reviewedEvidenceAlreadyProjected && (String(preflight.capabilityId) === "core.patch.apply" || patchAlreadyFailedForStage || (editAlreadyFailedForStage && effectiveMutationMissCount >= 1))
                    ? patchRecoveryAvailable ? "core.patch.apply|core.file.edit" : "core.file.edit"
                    : "focused-read-or-source-edit-or-bounded-blocker";
              const mutationRepairRequiredNextAction = exactRefreshTargetPath
                ? "exact-target-refresh-or-source-edit-or-bounded-blocker"
                : defaultMutationRepairRequiredNextAction;
              const gateOverride = convergenceWorkflowGateOverride({
                requiredNextAction: mutationRepairRequiredNextAction,
                rejectedCapabilityId: String(preflight.capabilityId),
                rejectedToolName: toolName,
                terminalKind: "workflow-mutation-repair.required",
                toolCallId
              });
              activeWorkflowGateOverride = gateOverride;
              activeProfilePolicy = activeProfilePolicy ? { ...activeProfilePolicy, workflowGateOverride: gateOverride } : activeProfilePolicy;
              messages.push(
                exactRefreshTargetPath
                  ? mutationExactRefreshCorrectionMessage(readyStageControl, exactRefreshTargetPath, error)
                  : mutationRepairCorrectionMessage(readyStageControl, error, executionFeedback.diagnostics)
              );
            } else if (
              repeatedProgressEvidence ||
              readyStageKindMatches(readyStageControl, ["produce", "materialize", "repair"]) ||
              standardVerifyCommandMissing
            ) {
              const gateOverride = convergenceWorkflowGateOverride({
                requiredNextAction: standardVerifyCommandMissing
                  ? "standard-test-command"
                  : String(readyStageControl.requiredNextAction ?? "source-edit-or-test-or-bounded-blocker"),
                rejectedCapabilityId: String(preflight.capabilityId),
                rejectedToolName: toolName,
                terminalKind: standardVerifyCommandMissing ? "workflow-standard-test-required" : "workflow-required-action.rejected",
                toolCallId
              });
              activeWorkflowGateOverride = gateOverride;
              activeProfilePolicy = activeProfilePolicy ? { ...activeProfilePolicy, workflowGateOverride: gateOverride } : activeProfilePolicy;
            }
            if (!activeWorkflowGateOverride) {
              const gateOverride = convergenceWorkflowGateOverride({
                requiredNextAction: String(readyStageControl.requiredNextAction ?? "workflow-progress-capability-or-bounded-blocker"),
                rejectedCapabilityId: String(preflight.capabilityId),
                rejectedToolName: toolName,
                terminalKind: "workflow-required-action.rejected",
                toolCallId
              });
              activeWorkflowGateOverride = gateOverride;
              activeProfilePolicy = activeProfilePolicy ? { ...activeProfilePolicy, workflowGateOverride: gateOverride } : activeProfilePolicy;
            }
            if (!recoverableMutationFailure) {
              messages.push(
                activeGateForMiss?.terminalKind === "workflow-official-repair.refreshed"
                  ? officialRepairRequiredActionCorrectionMessage(readyStageControl, missCount + 1, error)
                  : activeGateForMiss?.terminalKind === "workflow-standard-test-repair.refreshed"
                    ? standardTestRepairRequiredActionCorrectionMessage(
                        readyStageControl,
                        missCount + 1,
                        error,
                        activeGateForMiss.requiredNextAction
                      )
                  : readyStageRequiredActionCorrectionMessage(readyStageControl, missCount + 1, error)
              );
            }
            restartModelAfterWorkflowCorrection = true;
            break;
          }
          yield* emitFailureWithRepair("rejected", "workflow-required-action-missed", error, missed);
          terminalEmitted = true;
          return;
        }
        if (failedStandardVerifyCommand) {
          const gateOverride = convergenceWorkflowGateOverride({
            requiredNextAction: "focused-read-or-source-edit-or-test-or-return-control",
            rejectedCapabilityId: String(preflight.capabilityId),
            rejectedToolName: toolName,
            terminalKind: "workflow-standard-test-failed",
            toolCallId,
            standardTestFailureToolCallId: toolCallId
          });
          activeWorkflowGateOverride = gateOverride;
          activeProfilePolicy = activeProfilePolicy
            ? { ...clearWorkflowGateOverride(activeProfilePolicy), workflowGateOverride: gateOverride }
            : activeProfilePolicy;
          messages.push({
            role: "user",
            content: [
              "WORKFLOW_STANDARD_TEST_FAILED.",
              "A standard repository test command ran and produced failure evidence.",
              "Required next action: focused-read-or-source-edit-or-test-or-return-control.",
              "Inspect the failure evidence with focused read/search tools, repair the workspace with mutation tools, rerun a standard test, or report a bounded blocker.",
              "Do not use core.test.run for source inspection commands; use focused read/search tools for inspection and mutation tools for fixes."
            ].join("\n")
          });
          restartModelAfterWorkflowCorrection = true;
          break;
        }
        if (standardVerifyCommandMissing) {
          const gateOverride = convergenceWorkflowGateOverride({
            requiredNextAction: "standard-test-command",
            rejectedCapabilityId: String(preflight.capabilityId),
            rejectedToolName: toolName,
            terminalKind: "workflow-standard-test-required",
            toolCallId
          });
          activeWorkflowGateOverride = gateOverride;
          activeProfilePolicy = activeProfilePolicy ? { ...activeProfilePolicy, workflowGateOverride: gateOverride } : activeProfilePolicy;
          messages.push({
            role: "system",
            content: [
              "WORKFLOW_STANDARD_TEST_REQUIRED: the verification evidence completed, but terminal verify requires a standard repository test command before closing.",
              "Required next action: standard-test-command.",
              "Use the narrowest applicable standard test runner such as pytest, python -m pytest, python -m unittest, tox, nox, or the repository package test command."
            ].join("\n")
          });
          restartModelAfterWorkflowCorrection = true;
          break;
        }
        if (terminalToolCompleted) {
          const convergence = terminalToolConvergence({
            capabilityId: String(preflight.capabilityId),
            toolName,
            terminalKind: terminal?.kind ?? "unknown",
            feedbackStatus: executionFeedback.status
          });
          const terminalReason = convergence.reasonCode;
          const terminalFailed = terminalReason === "terminal-tool-failed";
          const outcomeReasoning = await emitVisibleReasoning({
            actor: "runtime",
            stepKind: "outcome",
            status: terminalFailed ? "blocked" : "completed",
            summary: terminalFailed
              ? `Terminal tool ${toolName} failed the governed task; outer loop will not request additional model actions.`
              : `Terminal tool ${toolName} completed the governed task; outer loop will not request additional model actions.`,
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
            ...summarizeAgentLoop(terminalFailed ? "failed" : "completed", request, sessionId, turnId, trace, assistantText, iterations, toolCalls, diagnostics, summaryMode()),
            reason: terminalReason,
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
          const loopTerminal = terminalFailed
            ? agentLoopEvent("agent.loop.failed", sessionId, turnId, trace, summary, request.agentId, terminal?.error)
            : agentLoopEvent("agent.loop.completed", sessionId, turnId, trace, summary, request.agentId);
          await recordRuntimeAdapterEvent(deps, loopTerminal);
          yield loopTerminal;
          terminalEmitted = true;
          return;
        }
        if (terminalToolFailed) {
          const convergence = terminalToolConvergence({
            capabilityId: String(preflight.capabilityId),
            toolName,
            terminalKind: terminal?.kind ?? "unknown",
            feedbackStatus: executionFeedback.status
          });
          diagnostics.push(...(terminal?.error ? [terminal.error] : []));
          const summary = {
            ...summarizeAgentLoop("failed", request, sessionId, turnId, trace, assistantText, iterations, toolCalls, diagnostics, summaryMode()),
            reason: convergence.reasonCode,
            terminalTool: {
              toolCallId,
              toolName,
              capabilityId: String(preflight.capabilityId),
              terminalKind: terminal?.kind ?? "unknown",
              feedbackStatus: executionFeedback.status
            }
          };
          const completed = agentLoopEvent("turn.completed", sessionId, turnId, trace, summary, request.agentId);
          await recordRuntimeAdapterEvent(deps, completed);
          yield completed;
          const loopTerminal = agentLoopEvent("agent.loop.failed", sessionId, turnId, trace, summary, request.agentId, terminal?.error);
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
          modelDispatchInterrupted = true;
          break;
        }
        terminalEmitted = true;
        return;
      }
    }
    if (restartModelAfterWorkflowCorrection) {
      yield* fireHooks("model-call.after", {
        iteration: iterations,
        toolRequested: requestedTool,
        messageCount: messages.length
      });
      continue;
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
    if (modelDispatchInterrupted && repairContinuationRequested && iterations < limits.maxModelIterations) {
      continue;
    }
    if (!requestedTool && currentReadyStageControl) {
      const missKey = readyStageRequiredActionMissKey(currentReadyStageControl);
      const missCount = readyStageRequiredActionMisses.get(missKey) ?? 0;
      const convergence = readyStageRequiredActionConvergence({
        missCount,
        correctionLimit: READY_STAGE_REQUIRED_ACTION_CORRECTION_LIMIT,
        iteration: iterations,
        maxModelIterations: effectiveMaxModelIterationsForWorkflowGate(
          limits.maxModelIterations,
          iterationRequest.profilePolicy?.workflowGateOverride
        ),
        workflowReadyStageControl: currentReadyStageControl
      });
      const correctionAttempt = Number(convergence.metadata?.correctionAttempt ?? missCount + 1);
      const retryPolicy = String(convergence.metadata?.retryPolicy ?? "fail-closed");
      const canCorrect = convergence.kind === "retry-with-feedback";
      const error = kernelError(
        "KERNEL_POLICY_DENIED",
        `WORKFLOW_REQUIRED_ACTION_MISSED: model response did not request the required workflow action ${String(currentReadyStageControl.requiredNextAction ?? "")}.`,
        {
          workflowReadyStageControl: currentReadyStageControl,
          iteration: iterations
        }
      );
      diagnostics.push(error);
      const missed = agentLoopEvent("workflow.required-action.missed", sessionId, turnId, trace, {
        ...currentReadyStageControl,
        iteration: iterations,
        modelRequestCount: iterations,
        toolCallCount: toolCalls,
        correctionAttempt,
        retryPolicy
      }, request.agentId, error);
      await recordRuntimeAdapterEvent(deps, missed);
      yield missed;
      readyStageRequiredActionMisses.set(missKey, missCount + 1);
      if (canCorrect) {
        messages.push(readyStageRequiredActionCorrectionMessage(currentReadyStageControl, missCount + 1, error));
        continue;
      }
      yield* emitFailureWithRepair("rejected", "workflow-required-action-missed", error, missed);
      terminalEmitted = true;
      return;
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
            role: "user",
            content: [
              "evidence-first.claim-grounding",
              "Evidence-first revision required:",
              `Revision id: evidence-revision:${stableHash(grounding.unsupportedClaims.map((claim) => claim.claimFingerprint).join("|"))}.`,
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
            activeWorkflowGateOverride = outputContractRepairWorkflowGateOverride(verification.outputContract) ?? activeWorkflowGateOverride;
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

function isTerminalToolCompletion(
  capabilityId: string,
  terminal: RuntimeEvent | undefined,
  readyStageControl: JsonObject | undefined,
  toolInput: JsonObject
): boolean {
  if (terminal?.kind !== "capability.completed" || terminal.error) return false;
  if (!readyStageControl) return false;
  const terminalClosePolicy = typeof readyStageControl.terminalClosePolicy === "string"
    ? readyStageControl.terminalClosePolicy
    : "";
  if (!terminalClosePolicy.startsWith("close-")) return false;
  if (!terminalEvidenceStatusCompleted(terminal) && readyStageKindMatches(readyStageControl, ["verify"])) return false;
  const progressCapabilityIds = Array.isArray(readyStageControl.progressCapabilityIds)
    ? readyStageControl.progressCapabilityIds.map(String)
    : [];
  const allowedCapabilityIds = Array.isArray(readyStageControl.allowedCapabilityIds)
    ? readyStageControl.allowedCapabilityIds.map(String)
    : [];
  const terminalCapabilityIds = progressCapabilityIds.length > 0 ? progressCapabilityIds : allowedCapabilityIds;
  if (
    readyStageKindMatches(readyStageControl, ["verify", "score"]) &&
    (capabilityId === "core.test.run" || capabilityId === "core.shell.run") &&
    !isStandardTestCommand(toolCommandText(toolInput))
  ) {
    return false;
  }
  return terminalCapabilityIds.includes(capabilityId);
}

function isTerminalToolFailure(
  capabilityId: string,
  terminal: RuntimeEvent | undefined,
  readyStageControl: JsonObject | undefined
): boolean {
  if (!terminal || terminal.kind !== "capability.failed") return false;
  if (!readyStageControl) return false;
  const terminalClosePolicy = typeof readyStageControl.terminalClosePolicy === "string"
    ? readyStageControl.terminalClosePolicy
    : "";
  if (!terminalClosePolicy.startsWith("close-")) return false;
  const progressCapabilityIds = Array.isArray(readyStageControl.progressCapabilityIds)
    ? readyStageControl.progressCapabilityIds.map(String)
    : [];
  const allowedCapabilityIds = Array.isArray(readyStageControl.allowedCapabilityIds)
    ? readyStageControl.allowedCapabilityIds.map(String)
    : [];
  const terminalCapabilityIds = progressCapabilityIds.length > 0 ? progressCapabilityIds : allowedCapabilityIds;
  return terminalCapabilityIds.includes(capabilityId);
}

function requiresStandardVerifyCommandBeforeTerminal(
  capabilityId: string,
  terminal: RuntimeEvent | undefined,
  readyStageControl: JsonObject | undefined,
  toolInput: JsonObject
): boolean {
  if (terminal?.kind !== "capability.completed" || terminal.error) return false;
  if (!terminalEvidenceStatusCompleted(terminal)) return false;
  if (!readyStageKindMatches(readyStageControl, ["verify", "score"])) return false;
  if (capabilityId !== "core.test.run" && capabilityId !== "core.shell.run") return false;
  return !isStandardTestCommand(toolCommandText(toolInput));
}

function terminalEvidenceStatusCompleted(terminal: RuntimeEvent): boolean {
  const output = jsonObjectValue(terminal.data.output);
  const evidence = jsonObjectValue(output?.evidence);
  return evidence?.status === "completed";
}

function testResultSelectedNoTests(result: string): boolean {
  const plainResult = result.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  return /(?:^|\n)\s*(?:no tests (?:ran|were found)|collected 0 items|\d+ deselected(?:\s+in\s+[^\n]+)?)\s*(?:\n|$)/i.test(plainResult);
}

function focusedEvidenceRefreshCompleted(capabilityId: string, terminal: RuntimeEvent, toolInput: JsonObject): boolean {
  if (!terminalEvidenceStatusCompleted(terminal)) return false;
  if (capabilityId === "core.search.text") return terminalSearchEvidenceHasContent(terminal);
  if (capabilityId === "core.file.read") return !terminalEvidenceEmpty(terminal) && !terminalEvidenceTruncatedForRead(toolInput, terminal);
  return true;
}

function terminalEvidenceTruncatedForRead(toolInput: JsonObject, terminal: RuntimeEvent | undefined): boolean {
  if (!terminal) return false;
  const output = jsonObjectValue(terminal.data.output);
  const evidence = jsonObjectValue(output?.evidence);
  if (!evidence) return false;
  const preview = jsonObjectValue(evidence.preview);
  if (preview?.truncated === true) return !boundedReadPreviewCoversRequestedWindow(toolInput, preview);
  const metadata = jsonObjectValue(evidence.metadata);
  if (metadata?.truncatedLines !== true) return false;
  if (!boundedReadRequested(toolInput)) return true;
  return !terminalEvidencePreviewHasContent(preview);
}

function boundedReadRequested(input: JsonObject): boolean {
  return nonNegativeNumberField(input, "offset") !== undefined || nonNegativeNumberField(input, "limit") !== undefined;
}

function boundedReadPreviewCoversRequestedWindow(input: JsonObject, preview: JsonObject): boolean {
  const limit = nonNegativeNumberField(input, "limit");
  if (limit === undefined || limit === 0) return false;
  const lineCount = preview.lineCount;
  return typeof lineCount === "number" && Number.isFinite(lineCount) && lineCount >= limit;
}

function terminalEvidencePreviewHasContent(preview: JsonObject | undefined): boolean {
  if (!preview) return false;
  if (typeof preview.text === "string" && preview.text.trim().length > 0) return true;
  if (typeof preview.lineCount === "number" && preview.lineCount > 0) return true;
  if (typeof preview.byteLength === "number" && preview.byteLength > 0) return true;
  return false;
}

function nonNegativeNumberField(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function terminalEvidenceEmpty(terminal: RuntimeEvent | undefined): boolean {
  if (!terminal) return false;
  const output = jsonObjectValue(terminal.data.output);
  const evidence = jsonObjectValue(output?.evidence);
  if (!evidence) return false;
  const preview = jsonObjectValue(evidence.preview);
  if (preview) {
    if (typeof preview.text === "string" && preview.text.trim().length === 0) return true;
    if (preview.lineCount === 0 || preview.byteLength === 0) return true;
  }
  const metadata = jsonObjectValue(evidence.metadata);
  if (metadata) {
    if (
      metadata.lineCount === 0 ||
      metadata.resultCount === 0 ||
      metadata.matchCount === 0 ||
      metadata.count === 0 ||
      metadata.byteLength === 0
    ) {
      return true;
    }
  }
  return false;
}

function toolCommandText(input: JsonObject | undefined): string {
  if (!input) return "";
  const command = typeof input.command === "string" ? input.command : "";
  if (!command) return "";
  const args = Array.isArray(input.args) ? input.args.filter((value): value is string => typeof value === "string") : [];
  return [command, ...args].join(" ");
}

function readyStageKindMatches(control: JsonObject | undefined, kinds: readonly string[]): boolean {
  const stageKind = typeof control?.stageKind === "string" ? control.stageKind : "";
  return kinds.includes(stageKind);
}

function failureClassForLoopTerminal(reason: string, status: AgentLoopSummary["status"]): string {
  if (reason === "model-iteration-limit") return "loop-budget-exhausted";
  if (reason.includes("workflow-required-action")) return "workflow-required-action-missed";
  if (reason.includes("workflow-stage-budget")) return "workflow-stage-budget-exhausted";
  if (reason.includes("tool")) return "tool-terminal";
  if (status === "rejected") return "runtime-rejected";
  return "runtime-failed";
}

function attributionForLoopTerminal(
  reason: string,
  error: RedactedError | undefined
): import("@deepseek/platform-contracts").FailureAnalysisAttribution {
  if (reason === "model-iteration-limit") return "framework-scheduling";
  if (reason.includes("workflow")) return "framework-scheduling";
  if (reason.includes("tool") || error?.code === "KERNEL_CAPABILITY_NOT_FOUND") return "tool-availability";
  if (error?.code === "KERNEL_SCHEDULER_TIMEOUT") return "environment";
  if (error?.code === "KERNEL_POLICY_DENIED") return "framework-scheduling";
  return "inconclusive";
}

function evidenceQueriesForLoopTerminal(reason: string): readonly string[] {
  if (reason === "model-iteration-limit") {
    return [
      "count model iterations",
      "count tool calls",
      "check whether stage progress capability was satisfied",
      "check whether failure happened before required artifact production"
    ];
  }
  if (reason.includes("workflow")) {
    return [
      "inspect active workflow stage",
      "compare requested action with required next action",
      "check accepted evidence refs"
    ];
  }
  return [
    "inspect terminal event",
    "inspect diagnostics",
    "check accepted evidence refs"
  ];
}

function nextActionForLoopTerminal(reason: string): import("@deepseek/platform-contracts").FailureAnalysisNextAction {
  if (reason === "model-iteration-limit") return "repair";
  if (reason === "workflow-mutation-input-stalled") return "repair";
  if (reason.includes("workflow-required-action")) return "repair";
  if (reason.includes("workflow-stage-budget")) return "prove-attribution";
  if (reason.includes("tool")) return "focused-evidence-query";
  return "search-evidence";
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
  const events = await inheritedSessionEvents(deps, sessionId);
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

async function inheritedSessionEvents(
  deps: RuntimeDependencies,
  sessionId: SessionId,
  visited: ReadonlySet<string> = new Set(),
  ownMaxSequence?: number
): Promise<readonly SessionEvent[]> {
  if (visited.has(sessionId)) return [];
  const currentVisited = new Set(visited);
  currentVisited.add(sessionId);
  const events = await deps.sessions.events(sessionId);
  const ownEvents = ownMaxSequence === undefined
    ? events
    : events.filter((event) => event.sequence <= ownMaxSequence);
  const metadata = await deps.sessions.metadata(sessionId);
  if (!metadata.ok || !metadata.value) return ownEvents;
  const parentSessionId = metadata.value.lineage.parentSessionId;
  const forkPointSequence = metadata.value.lineage.forkPointSequence;
  if (!parentSessionId || typeof forkPointSequence !== "number" || !Number.isFinite(forkPointSequence)) return ownEvents;
  const parentEvents = await inheritedSessionEvents(deps, parentSessionId, currentVisited, forkPointSequence);
  return [...parentEvents, ...ownEvents];
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

function providerCacheMessages(messages: readonly ModelChatMessage[]): readonly ModelChatMessage[] {
  return messages;
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

function stringField(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
  const detailDiagnostics = repairDiagnosticLines(error);
  return {
    role: "tool",
    toolCallId: plan.attemptId,
    toolName: "agent.self-repair",
    content: [
      "agent.self-repair",
      "Self-repair feedback:",
      `Repair attempt: ${plan.attemptId}.`,
      `Failure source: ${classification.failureSource}.`,
      `Affected scope: ${classification.affectedScope}.`,
      `Repair action: ${plan.actionType}.`,
      `Verification: ${plan.expectedVerification.join(", ") || "next model iteration"}.`,
      error ? `Diagnostic: ${error.code}: ${error.message}` : "Diagnostic: unavailable.",
      ...detailDiagnostics,
      "Make the smallest bounded correction, use only visible governed tools, then stop or verify."
    ].join("\n")
  };
}

function repairDiagnosticLines(error: RedactedError | undefined): readonly string[] {
  const details = jsonObjectValue(error?.details);
  const diagnostics = Array.isArray(details?.diagnostics) ? details.diagnostics : [];
  return diagnostics
    .map((diagnostic) => jsonObjectValue(diagnostic))
    .filter((diagnostic): diagnostic is JsonObject => diagnostic !== undefined)
    .map((diagnostic) => {
      const code = stringField(diagnostic, "code");
      const message = stringField(diagnostic, "message");
      return code && message ? `Contract diagnostic: ${code}: ${message}` : undefined;
    })
    .filter((line): line is string => typeof line === "string")
    .slice(0, 5);
}

function profilePolicyWithRuntimeWorkflowGateOverride(
  profilePolicy: AgentLoopProfilePolicyMetadata | undefined,
  override: AgentLoopProfileWorkflowGateOverride | undefined
): AgentLoopProfilePolicyMetadata | undefined {
  if (!override) return profilePolicy;
  if (!profilePolicy) {
    return {
      schemaVersion: "1.0.0",
      profileId: "runtime/workflow-gate-override.v1",
      role: "runtime-gate-workflow",
      workflowGraphId: "runtime/workflow-gate-override",
      workflowPriority: "primary",
      orchestrationMode: "staged-capability-workflow",
      workflowCapabilityIds: [],
      toolProjectionSource: "runtime-gate",
      workflowGateOverride: override,
      antiTailoring: false,
      executionBoundary: "runtime-gate-override",
      redaction: { class: "internal" }
    };
  }
  return { ...profilePolicy, workflowGateOverride: override };
}

function convergenceWorkflowGateOverride(input: {
  readonly requiredNextAction: string;
  readonly rejectedToolName: string;
  readonly rejectedCapabilityId: string;
  readonly terminalKind: string;
  readonly toolCallId: string;
  readonly standardTestFailureToolCallId?: string;
}): AgentLoopProfileWorkflowGateOverride {
  return {
    gate: "runtime-convergence",
    requiredNextAction: input.requiredNextAction,
    rejectedToolName: input.rejectedToolName,
    rejectedCapabilityId: input.rejectedCapabilityId,
    terminalKind: input.terminalKind,
    toolCallId: input.toolCallId,
    ...(input.standardTestFailureToolCallId ? { standardTestFailureToolCallId: input.standardTestFailureToolCallId } : {})
  };
}

function workflowGateOverrideAllowsCapability(
  override: AgentLoopProfileWorkflowGateOverride | undefined,
  capabilityId: string
): boolean {
  if (!override) return false;
  return workflowGateRequiredActionAllowsCapability(override.requiredNextAction, capabilityId);
}

function workflowGateOverrideStaleForReadyStage(
  override: AgentLoopProfileWorkflowGateOverride | undefined,
  readyStageControl: JsonObject | undefined
): boolean {
  if (!override) return false;
  if (!readyStageKindMatches(readyStageControl, ["produce", "materialize", "repair"])) return false;
  const progressCapabilityIds = Array.isArray(readyStageControl?.progressCapabilityIds)
    ? readyStageControl.progressCapabilityIds.map(String)
    : [];
  if (!progressCapabilityIds.some((capabilityId) => isMutationCapabilityId(capabilityId))) return false;
  const requiredCapabilityIds = workflowGateOverrideRequiredCapabilityIds(override.requiredNextAction);
  if (requiredCapabilityIds.length === 0) return false;
  return requiredCapabilityIds.every(isSourceInspectionCapabilityId);
}

function isSourceInspectionCapabilityId(capabilityId: string): boolean {
  return capabilityId === "core.file.read" ||
    capabilityId === "core.file.list" ||
    capabilityId === "core.search.text" ||
    capabilityId === "core.workspace.glob";
}

function effectiveMaxModelIterationsForWorkflowGate(
  maxModelIterations: number,
  override: AgentLoopProfileWorkflowGateOverride | undefined
): number {
  if (override?.terminalKind !== "workflow-standard-test-required") return maxModelIterations;
  return maxModelIterations + STANDARD_TEST_REQUIRED_CLOSURE_MODEL_ITERATION_RESERVE;
}

function readyStageAllowsCapability(control: JsonObject | undefined, capabilityId: string): boolean {
  const allowed = Array.isArray(control?.allowedCapabilityIds)
    ? control.allowedCapabilityIds.map(String)
    : [];
  const progress = Array.isArray(control?.progressCapabilityIds)
    ? control.progressCapabilityIds.map(String)
    : [];
  return allowed.includes(capabilityId) || progress.includes(capabilityId);
}

function readyStageControlProjectedFromReviewedEvidence(control: JsonObject | undefined): boolean {
  return control?.projectedFromReviewedStage === true;
}

function allowsDiagnosticRepairFocusedRefresh(
  capabilityId: string,
  control: JsonObject | undefined,
  profilePolicy: AgentLoopProfilePolicyMetadata | undefined
): boolean {
  if (!isFocusedEvidenceRefreshCapabilityId(capabilityId)) return false;
  if (profilePolicy?.workflowGovernanceMode !== "evaluation") return false;
  if (!profilePolicy.workflowGateOverride) return false;
  if (!workflowGateOverrideAllowsCapability(profilePolicy.workflowGateOverride, capabilityId)) return false;
  if (!readyStageKindMatches(control, ["produce", "materialize", "repair"])) return false;
  const stageId = typeof control?.stageId === "string" ? control.stageId : "";
  if (!stageId) return false;
  const workflow = profilePolicy.stagedTaskWorkflow;
  const stageState = workflow?.runState.stageStates.find((stage) => stage.stageId === stageId);
  const refs = workflow?.runState.refs ?? [];
  const refsById = new Map(refs.map((ref) => [ref.refId, ref]));
  return refs.some((ref) => ref.type === "diagnostic") ||
    (stageState?.inputRefs ?? []).some((refId) => refsById.get(refId)?.type === "diagnostic");
}

function requiresEvaluationBehaviorReproductionBeforePublicTest(input: {
  readonly profilePolicy: AgentLoopProfilePolicyMetadata | undefined;
  readonly readyStageControl: JsonObject | undefined;
  readonly capabilityId: string;
  readonly toolInput: JsonObject;
  readonly reproductionSatisfied: boolean;
}): boolean {
  if (input.reproductionSatisfied) return false;
  if (!evaluationBehaviorReproductionActive(input.profilePolicy, input.readyStageControl)) return false;
  if (!readyStageKindMatches(input.readyStageControl, ["verify", "score"])) return false;
  if (!isStandardTestExecutionCapabilityId(input.capabilityId)) return false;
  const command = toolCommandText(input.toolInput);
  if (!isStandardTestCommand(command)) return false;
  if (isSafePythonReproductionCommand(command)) return false;
  return isPublicRepositoryTestCommand(command);
}

function evaluationBehaviorReproductionActive(
  profilePolicy: AgentLoopProfilePolicyMetadata | undefined,
  control: JsonObject | undefined
): boolean {
  if (profilePolicy?.workflowGovernanceMode !== "evaluation") return false;
  const workflow = profilePolicy.stagedTaskWorkflow;
  if (!workflow) return false;
  const refs = workflow.runState.refs ?? [];
  const activatingRefIds = new Set([
    "ref:runner:problem-behavior-contract",
    "ref:runner:official-repair-feedback"
  ]);
  if (refs.some((ref) => activatingRefIds.has(ref.refId))) return true;
  const stageId = typeof control?.stageId === "string" ? control.stageId : "";
  const stageState = stageId
    ? workflow.runState.stageStates.find((stage) => stage.stageId === stageId)
    : workflow.runState.stageStates.find((stage) => stage.status === "ready");
  return (stageState?.inputRefs ?? []).some((refId) => {
    return activatingRefIds.has(refId);
  });
}

function isSafePythonReproductionCommand(command: string): boolean {
  const normalized = command.trim().replace(/^cd\s+(?:"\/workspace"|'\/workspace'|\/workspace)\s*&&\s*/i, "").trim();
  return /^(?:python(?:3(?:\.\d+)?)?|py)\s+-c(?:\s|$)/i.test(normalized);
}

function isPublicRepositoryTestCommand(command: string): boolean {
  return /\b(?:pytest|unittest|tox|nox)\b/i.test(command);
}

function workflowGateRequiredActionAllowsCapability(requiredNextAction: string, capabilityId: string): boolean {
  const alternatives = requiredNextAction.split("|").map((part) => part.trim()).filter(Boolean);
  if (alternatives.length > 1) return alternatives.some((alternative) => workflowGateRequiredActionAllowsCapability(alternative, capabilityId));
  if (requiredNextAction === "focused-read-or-source-edit-or-bounded-blocker") {
    return isFocusedEvidenceRefreshCapabilityId(capabilityId) || isMutationCapabilityId(capabilityId);
  }
  if (requiredNextAction === "focused-read-or-source-edit-or-test-or-return-control") {
    return isFocusedEvidenceRefreshCapabilityId(capabilityId) || isMutationCapabilityId(capabilityId) || isStandardTestExecutionCapabilityId(capabilityId);
  }
  if (requiredNextAction === "source-edit-or-test-or-bounded-blocker" || requiredNextAction === "source-edit-or-test-or-blocker") {
    return isMutationCapabilityId(capabilityId) || isTestCapabilityId(capabilityId);
  }
  if (requiredNextAction === "standard-test-command") {
    return capabilityId === "core.test.run";
  }
  if (requiredNextAction === "standard-test-command-or-bounded-blocker") {
    return capabilityId === "core.test.run" || capabilityId === "core.shell.run";
  }
  if (requiredNextAction === "exact-target-refresh-or-source-edit-or-bounded-blocker") {
    return capabilityId === "core.file.read" || isMutationCapabilityId(capabilityId);
  }
  if (requiredNextAction.startsWith("core.")) return capabilityId === requiredNextAction;
  return false;
}

function isFocusedEvidenceRefreshCapabilityId(capabilityId: string): boolean {
  return capabilityId === "core.file.read" || capabilityId === "core.search.text";
}

function unboundedSourceReadDiagnostic(input: {
  readonly capabilityId: string;
  readonly toolName: string;
  readonly toolInput: JsonObject;
  readonly workflowReadyStageControl: JsonObject | undefined;
}): RedactedError | undefined {
  if (input.capabilityId !== "core.file.read") return undefined;
  if (!readyStageKindMatches(input.workflowReadyStageControl, ["collect-evidence"])) return undefined;
  const path = typeof input.toolInput.path === "string" ? input.toolInput.path : "";
  if (!isSourceFilePath(path)) return undefined;
  const hasOffset = typeof input.toolInput.offset === "number";
  const hasLimit = typeof input.toolInput.limit === "number";
  if (hasOffset && hasLimit) return undefined;
  return kernelError(
    "KERNEL_POLICY_DENIED",
    "WORKFLOW_UNBOUNDED_SOURCE_READ: governed evidence collection for source files must use a bounded read with offset and limit.",
    {
      toolName: input.toolName,
      capabilityId: input.capabilityId,
      path,
      workflowReadyStageControl: input.workflowReadyStageControl
    }
  );
}

function isSourceFilePath(path: string): boolean {
  return /\.(c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|mjs|py|rb|rs|scala|swift|ts|tsx)$/i.test(path);
}

function invalidMutationIntentDiagnostic(input: {
  readonly capabilityId: string;
  readonly toolName: string;
  readonly toolInput: JsonObject;
  readonly workflowReadyStageControl: JsonObject | undefined;
  readonly acceptedSourceEvidencePaths?: readonly string[];
}): RedactedError | undefined {
  if (!isMutationCapabilityId(input.capabilityId)) return undefined;
  if (!readyStageKindMatches(input.workflowReadyStageControl, ["produce", "materialize", "repair"])) return undefined;
  const expected = typeof input.toolInput.expected === "string" ? input.toolInput.expected : undefined;
  const replacement = typeof input.toolInput.replacement === "string" ? input.toolInput.replacement : undefined;
  const content = typeof input.toolInput.content === "string" ? input.toolInput.content : undefined;
  const patch = typeof input.toolInput.patch === "string" ? input.toolInput.patch : undefined;
  const reasons: string[] = [];
  if (expected !== undefined && replacement !== undefined && expected === replacement) reasons.push("expected and replacement are identical");
  if (expected !== undefined && isPlaceholderMutationText(expected)) reasons.push("expected text is a placeholder");
  if (replacement !== undefined && isPlaceholderMutationText(replacement)) reasons.push("replacement text is a placeholder");
  if (content !== undefined && isPlaceholderMutationText(content)) reasons.push("write content is a placeholder");
  if (patch !== undefined && patchHasPlaceholderMutation(patch)) reasons.push("patch content is a placeholder");
  if (patch !== undefined && !patchHasUnifiedDiffShape(patch)) reasons.push("patch content is not a unified diff");
  const unrelatedTargets = mutationTargetsOutsideAcceptedEvidence(input.toolInput, input.acceptedSourceEvidencePaths ?? []);
  if (unrelatedTargets.length > 0) reasons.push(`patch target is outside accepted source evidence: ${unrelatedTargets.join(", ")}`);
  if (reasons.length === 0) return undefined;
  return kernelError(
    "KERNEL_POLICY_DENIED",
    `WORKFLOW_INVALID_MUTATION_INTENT: placeholder mutation intent rejected before execution; ${reasons.join("; ")}.`,
    {
      toolName: input.toolName,
      capabilityId: input.capabilityId,
      reasons,
      acceptedSourceEvidencePaths: input.acceptedSourceEvidencePaths ?? [],
      mutationTargetPaths: mutationTargetPaths(input.toolInput),
      workflowReadyStageControl: input.workflowReadyStageControl
    }
  );
}

function sourceEvidencePathFromToolInput(capabilityId: string, input: JsonObject): string | undefined {
  if (capabilityId !== "core.file.read") return undefined;
  const path = typeof input.path === "string" ? normalizeEvidencePath(input.path) : undefined;
  return path && !path.startsWith(".") ? path : undefined;
}

function mutationTargetsOutsideAcceptedEvidence(input: JsonObject, acceptedPaths: readonly string[]): readonly string[] {
  const accepted = new Set(acceptedPaths.map(normalizeEvidencePath).filter(Boolean));
  if (accepted.size === 0) return [];
  const targets = mutationTargetPaths(input);
  return targets.filter((target) => !accepted.has(target));
}

function mutationTargetPaths(input: JsonObject): readonly string[] {
  const paths: string[] = [];
  if (typeof input.path === "string") paths.push(input.path);
  if (typeof input.file === "string") paths.push(input.file);
  if (typeof input.patch === "string") {
    for (const line of input.patch.replace(/\r\n/g, "\n").split("\n")) {
      if (!line.startsWith("+++ ")) continue;
      const path = normalizePatchTargetPath(line.slice(4).trim());
      if (path && path !== "/dev/null") paths.push(path);
    }
  }
  return [...new Set(paths.map(normalizeEvidencePath).filter(Boolean))];
}

function normalizePatchTargetPath(path: string): string {
  if (path.startsWith("b/") || path.startsWith("a/")) return path.slice(2);
  return path;
}

function normalizeEvidencePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function editPreconditionFailureTargetPath(
  capabilityId: string,
  toolInput: JsonObject,
  error: RedactedError | undefined
): string | undefined {
  if (capabilityId !== "core.file.edit") return undefined;
  const details = error?.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  if (String((details as JsonObject).originalCode ?? "") !== "EDIT_PRECONDITION_FAILED") return undefined;
  const path = typeof toolInput.path === "string" ? normalizeEvidencePath(toolInput.path) : "";
  return path || undefined;
}

function mutationExactRefreshInputAllowed(
  state: MutationExactRefreshState,
  toolInput: JsonObject
): boolean {
  if (state.consumed) return false;
  const path = typeof toolInput.path === "string" ? normalizeEvidencePath(toolInput.path) : "";
  if (path !== state.targetPath) return false;
  return typeof toolInput.offset === "number" && Number.isFinite(toolInput.offset) && toolInput.offset >= 0 &&
    typeof toolInput.limit === "number" && Number.isFinite(toolInput.limit) && toolInput.limit > 0;
}

function isPlaceholderMutationText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return normalized === "placeholder" ||
    normalized === "todo" ||
    normalized === "tbd" ||
    normalized === "fixme" ||
    normalized === "..." ||
    normalized === "<placeholder>" ||
    normalized === "/* placeholder */" ||
    normalized === "# placeholder";
}

function patchHasPlaceholderMutation(value: string): boolean {
  if (isPlaceholderMutationText(value)) return true;
  const mutationLines = value
    .split(/\r?\n/)
    .filter((line) =>
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    )
    .map((line) => line.slice(1).trim())
    .filter(Boolean);
  return mutationLines.length > 0 && mutationLines.every(isPlaceholderMutationText);
}

function patchHasUnifiedDiffShape(value: string): boolean {
  return /^---\s+[ab]\//m.test(value) &&
    /^\+\+\+\s+[ab]\//m.test(value) &&
    /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m.test(value);
}

function invalidMutationIntentCorrectionMessage(
  control: JsonObject,
  error: RedactedError,
  toolInput: JsonObject
): ModelChatMessage {
  const details = error.details && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as JsonObject
    : {};
  const reasons = Array.isArray(details.reasons) ? details.reasons.map(String) : [];
  const acceptedPaths = Array.isArray(details.acceptedSourceEvidencePaths) ? details.acceptedSourceEvidencePaths.map(String) : [];
  const targetPaths = Array.isArray(details.mutationTargetPaths) ? details.mutationTargetPaths.map(String) : [];
  const evidencePaths = [...new Set([...acceptedPaths, ...targetPaths])];
  const rejectedInput = rejectedMutationInputSummary(toolInput);
  return {
    role: "user",
    content: [
      "WORKFLOW_INVALID_MUTATION_INTENT_REJECTED.",
      `Active stage: ${String(control.stageId ?? "unknown")}.`,
      `Diagnostic: ${error.code}: ${error.message}`,
      ...(reasons.length > 0 ? [`Rejected reasons: ${reasons.join("; ")}.`] : []),
      ...(rejectedInput ? [
        "Rejected mutation input:",
        rejectedInput
      ] : []),
      evidencePaths.length > 0
        ? `Current accepted source evidence: ${evidencePaths.join(", ")}.`
        : "Current accepted source evidence: unavailable; refresh exact local evidence before guessing expected text.",
      "A mutation tool call must carry a real source change. Do not use placeholder text, no-op replacements, or mutation tools to request more reading.",
      "For core.file.edit, expected and replacement must differ; copy expected exactly from current evidence and make replacement the intended changed text.",
      "For core.patch.apply, provide a complete unified diff whose removed lines match current evidence and whose added lines are the intended changed text.",
      "Next action: refresh exact local evidence with one visible focused read/search tool, call a visible edit/patch tool with a real diff, or report a bounded blocker."
    ].join("\n")
  };
}

function rejectedMutationInputSummary(input: JsonObject): string | undefined {
  const fields: Record<string, string> = {};
  for (const key of ["path", "file", "expected", "replacement", "content", "patch"] as const) {
    const value = input[key];
    if (typeof value !== "string") continue;
    fields[key] = boundedModelText(value, 1_200);
  }
  return Object.keys(fields).length > 0 ? JSON.stringify(fields, undefined, 2) : undefined;
}

function invalidMutationIntentHasReason(error: RedactedError, reason: string): boolean {
  const details = error.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const reasons = (details as JsonObject).reasons;
  return Array.isArray(reasons) && reasons.map(String).includes(reason);
}

function mutationRepairCorrectionMessage(
  control: JsonObject,
  error: RedactedError,
  diagnostics: readonly RedactedError[] = []
): ModelChatMessage {
  const progressCapabilityIds = Array.isArray(control.progressCapabilityIds)
    ? control.progressCapabilityIds.map(String).join(", ")
    : "";
  const mutationContext = mutationRepairContextSummary(diagnostics);
  return {
    role: "user",
    content: [
      "WORKFLOW_MUTATION_REPAIR_REQUIRED.",
      `Active stage: ${String(control.stageId ?? "unknown")}.`,
      "A source mutation tool was selected but failed before changing the workspace.",
      `Diagnostic: ${error.code}: ${error.message}`,
      ...(mutationContext ? [
        mutationContext.heading,
        mutationContext.summary,
        mutationContext.source === "actualAtDeclaredLocation"
          ? "For file.edit, copy actualAtDeclaredLocation verbatim into expected and change only the replacement lines. Use nearestContext only if the intended target is elsewhere."
          : "For file.edit, copy the exact current context verbatim into expected and change only the replacement lines."
      ] : []),
      progressCapabilityIds ? `Mutation progress capabilities: ${progressCapabilityIds}.` : "Mutation progress capabilities: unavailable.",
      "Next action: use the failed tool feedback and either refresh exact local evidence with a visible focused read/search tool or call a visible source edit/patch tool with corrected input.",
      "Do not broaden discovery or repeat the same stale edit/patch input."
    ].join("\n")
  };
}

function mutationRepairContextSummary(
  diagnostics: readonly RedactedError[]
): { readonly source: "actualAtDeclaredLocation" | "nearestContext"; readonly heading: string; readonly summary: string } | undefined {
  for (const diagnostic of diagnostics) {
    const details = diagnostic.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) continue;
    const object = details as JsonObject;
    const context = typeof object.actualAtDeclaredLocation === "string" ? object.actualAtDeclaredLocation.trimEnd() : "";
    if (!context) continue;
    return {
      source: "actualAtDeclaredLocation",
      heading: "Current actualAtDeclaredLocation from failed mutation:",
      summary: mutationContextDetails(
        object,
        context,
        typeof object.hunkOldStart === "number" ? object.hunkOldStart : undefined,
        context.split(/\r?\n/).length,
        "Exact current context at declared hunk location:"
      )
    };
  }
  for (const diagnostic of diagnostics) {
    const details = diagnostic.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) continue;
    const object = details as JsonObject;
    const context = typeof object.nearestContext === "string" ? object.nearestContext.trimEnd() : "";
    if (!context) continue;
    return {
      source: "nearestContext",
      heading: "Current nearestContext from failed mutation:",
      summary: mutationContextDetails(
        object,
        context,
        typeof object.nearestContextStartLine === "number" ? object.nearestContextStartLine : undefined,
        typeof object.nearestContextLineCount === "number" ? object.nearestContextLineCount : undefined,
        "Nearest current context:"
      )
    };
  }
  return undefined;
}

function mutationContextDetails(
  details: JsonObject,
  context: string,
  startLine: number | undefined,
  lineCount: number | undefined,
  label: string
): string {
  const path = typeof details.path === "string" && details.path.trim() ? details.path.trim() : undefined;
  return [
    path ? `Path: ${path}` : undefined,
    startLine !== undefined ? `Start line: ${startLine}` : undefined,
    lineCount !== undefined ? `Line count: ${lineCount}` : undefined,
    label,
    context
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function clearWorkflowGateOverride(profilePolicy: AgentLoopProfilePolicyMetadata): AgentLoopProfilePolicyMetadata {
  if (!profilePolicy.workflowGateOverride) return profilePolicy;
  const { workflowGateOverride: _workflowGateOverride, ...rest } = profilePolicy;
  return rest;
}

function readyStageControlForProfilePolicy(profilePolicy: AgentLoopProfilePolicyMetadata | undefined): JsonObject | undefined {
  const workflow = profilePolicy?.stagedTaskWorkflow;
  if (!profilePolicy || !workflow || profilePolicy.workflowPriority !== "primary") return undefined;
  const acceptanceMode = stageAcceptanceModeForReadyStageControl(profilePolicy);
  const readyStageState = workflow.runState.stageStates.find((stage) => stage.status === "ready") ??
    workflow.runState.stageStates.find((stage) =>
      acceptanceMode === "supervisor" &&
      stage.status === "running" &&
      stage.evaluation?.status === "needs-review"
    );
  if (!readyStageState) return undefined;
  const readyStage = workflow.graph.stages.find((stage) => stage.stageId === readyStageState.stageId);
  if (!readyStage) return undefined;
  const controlStage = readyStageControlStageForReviewedEvidence({
    stages: workflow.graph.stages,
    refs: workflow.runState.refs,
    readyStage,
    readyStageState,
    acceptanceMode
  }) ?? readyStage;
  const projectedFromReviewedStage = controlStage.stageId !== readyStage.stageId;
  const allowedCapabilityIds = (controlStage.allowedTools ?? []).map(String);
  const progressCapabilityIds = readyStageProgressCapabilityIdsForControl({
    stages: workflow.graph.stages,
    refs: workflow.runState.refs,
    readyStage: controlStage,
    readyStageState,
    acceptanceMode,
    allowedCapabilityIds,
    projectedFromReviewedStage
  });
  const terminalStage = !workflow.graph.stages.some((stage) => (stage.dependsOn ?? []).map(String).includes(controlStage.stageId));
  return {
    schemaVersion: "1.0.0",
    profileId: profilePolicy.profileId,
    workflowGraphId: profilePolicy.workflowGraphId,
    graphId: workflow.graphId,
    stageId: controlStage.stageId,
    stageKind: controlStage.kind,
    budgetStageId: readyStage.stageId,
    budgetStageKind: readyStage.kind,
    projectedFromReviewedStage,
    executorKind: controlStage.executorKind,
    requiredNextAction: requiredNextActionForStage(controlStage.kind, progressCapabilityIds),
    allowedCapabilityIds,
    progressCapabilityIds,
    stageAcceptanceMode: acceptanceMode,
    terminalClosePolicy: terminalClosePolicyForControlStage(controlStage.kind, terminalStage, acceptanceMode),
    redaction: { class: "internal" }
  };
}

function readyStageControlStageForReviewedEvidence(input: {
  readonly stages: readonly { readonly stageId: string; readonly kind: string; readonly dependsOn?: readonly string[]; readonly allowedTools?: readonly string[] }[];
  readonly refs?: readonly { readonly refId: string; readonly type?: string }[];
  readonly readyStage: { readonly stageId: string; readonly kind: string; readonly allowedTools?: readonly string[] };
  readonly readyStageState: { readonly status: string; readonly inputRefs?: readonly string[]; readonly outputRefs: readonly string[]; readonly evaluation?: { readonly status?: string } };
  readonly acceptanceMode: "automatic" | "supervisor";
}): { readonly stageId: string; readonly kind: string; readonly executorKind?: string; readonly dependsOn?: readonly string[]; readonly allowedTools?: readonly string[] } | undefined {
  if (
    input.acceptanceMode !== "supervisor" ||
    input.readyStageState.status !== "running" ||
    input.readyStageState.evaluation?.status !== "needs-review"
  ) {
    return undefined;
  }
  const currentAllowedCapabilityIds = (input.readyStage.allowedTools ?? []).map(String);
  const currentProgress = new Set(progressCapabilityIdsForWorkflowStage(input.readyStage.kind, currentAllowedCapabilityIds));
  if (
    input.readyStageState.outputRefs.length === 0 &&
    readyStageNeedsDiagnosticEvidenceReview(input.readyStage.kind, input.readyStageState.inputRefs ?? [], input.refs ?? [])
  ) {
    return undefined;
  }
  if (readyStageOwnProgressShouldWin(input.readyStage.kind, currentProgress) && input.readyStageState.outputRefs.length === 0) {
    return undefined;
  }
  return input.stages.find((stage) => (stage.dependsOn ?? []).map(String).includes(input.readyStage.stageId));
}

function readyStageNeedsDiagnosticEvidenceReview(
  stageKind: string | undefined,
  inputRefs: readonly string[],
  refs: readonly { readonly refId: string; readonly type?: string }[]
): boolean {
  if (stageKind !== "collect-evidence") return false;
  const refsById = new Map(refs.map((ref) => [ref.refId, ref]));
  return inputRefs.some((refId) => refsById.get(refId)?.type === "diagnostic");
}

function terminalClosePolicyForControlStage(
  stageKind: string | undefined,
  terminalStage: boolean,
  acceptanceMode: "automatic" | "supervisor"
): "automatic" | "supervisor" | "close-on-progress-capability" {
  if (!terminalStage) return acceptanceMode === "supervisor" ? "supervisor" : "automatic";
  if (acceptanceMode === "supervisor" && (stageKind === "produce" || stageKind === "materialize" || stageKind === "repair")) {
    return "supervisor";
  }
  return "close-on-progress-capability";
}

function readyStageProgressCapabilityIdsForControl(input: {
  readonly stages: readonly { readonly stageId: string; readonly kind: string; readonly dependsOn?: readonly string[]; readonly allowedTools?: readonly string[] }[];
  readonly refs?: readonly { readonly refId: string; readonly type?: string }[];
  readonly readyStage: { readonly stageId: string; readonly kind: string };
  readonly readyStageState: { readonly status: string; readonly inputRefs?: readonly string[]; readonly outputRefs: readonly string[]; readonly evaluation?: { readonly status?: string } };
  readonly acceptanceMode: "automatic" | "supervisor";
  readonly allowedCapabilityIds: readonly string[];
  readonly projectedFromReviewedStage?: boolean;
}): readonly string[] {
  const currentProgress = new Set(progressCapabilityIdsForWorkflowStage(input.readyStage.kind, input.allowedCapabilityIds));
  if (input.projectedFromReviewedStage) {
    return [...currentProgress];
  }
  if (
    input.acceptanceMode === "supervisor" &&
    input.readyStageState.status === "running" &&
    input.readyStageState.evaluation?.status === "needs-review"
  ) {
    if (readyStageNeedsDiagnosticEvidenceReview(input.readyStage.kind, input.readyStageState.inputRefs ?? [], input.refs ?? [])) {
      return [...currentProgress];
    }
    if (readyStageOwnProgressShouldWin(input.readyStage.kind, currentProgress) && input.readyStageState.outputRefs.length === 0) {
      return [...currentProgress];
    }
    const progress = new Set<string>();
    for (const stage of input.stages) {
      if (!(stage.dependsOn ?? []).map(String).includes(input.readyStage.stageId)) continue;
      for (const capabilityId of progressCapabilityIdsForWorkflowStage(stage.kind, (stage.allowedTools ?? []).map(String))) {
        progress.add(capabilityId);
      }
    }
    if (progress.size > 0 || input.readyStage.kind === "collect-evidence") {
      return [...progress];
    }
  }
  return [...currentProgress];
}

function readyStageOwnProgressShouldWin(stageKind: string | undefined, progressCapabilityIds: ReadonlySet<string>): boolean {
  if (stageKind !== "produce" && stageKind !== "materialize" && stageKind !== "repair") return false;
  for (const capabilityId of progressCapabilityIds) {
    if (isMutationCapabilityId(capabilityId)) return true;
  }
  return false;
}

function stageAcceptanceModeForReadyStageControl(profilePolicy: AgentLoopProfilePolicyMetadata): "automatic" | "supervisor" {
  if (profilePolicy.stageAcceptanceMode === "automatic" || profilePolicy.stageAcceptanceMode === "supervisor") {
    return profilePolicy.stageAcceptanceMode;
  }
  return profilePolicy.antiTailoring === true || profilePolicy.role.includes("evaluation")
    ? "supervisor"
    : "automatic";
}

function requiredNextActionForStage(stageKind: string, progressCapabilityIds: readonly string[]): string {
  if (
    stageKind === "collect-evidence" &&
    progressCapabilityIds.includes("core.file.read") &&
    progressCapabilityIds.some((capabilityId) => isMutationCapabilityId(capabilityId))
  ) {
    return "focused-read-or-source-edit-or-test-or-return-control";
  }
  if (progressCapabilityIds.length > 0) return progressCapabilityIds.join("|");
  if (stageKind === "produce" || stageKind === "materialize" || stageKind === "repair") return "source-edit-or-test-or-bounded-blocker";
  if (stageKind === "verify" || stageKind === "score") return "standard-test-command-or-bounded-blocker";
  return "workflow-progress-capability-or-bounded-blocker";
}

function stalledPrimaryWorkflowError(profilePolicy: AgentLoopProfilePolicyMetadata | undefined): RedactedError | undefined {
  const workflow = profilePolicy?.stagedTaskWorkflow;
  if (!profilePolicy || !workflow || profilePolicy.workflowPriority !== "primary") return undefined;
  const incomplete = workflow.runState.stageStates.some((stage) => stage.status !== "succeeded" && stage.status !== "skipped");
  const ready = workflow.runState.stageStates.some((stage) => stage.status === "ready");
  const running = workflow.runState.stageStates.some((stage) => stage.status === "running");
  if (!incomplete || ready || running) return undefined;
  return kernelError("KERNEL_QUEUE_BACKPRESSURE", "Primary staged workflow has incomplete stages but no ready stage.", {
    profileId: profilePolicy.profileId,
    workflowGraphId: profilePolicy.workflowGraphId,
    graphId: workflow.graphId,
    stageStates: workflow.runState.stageStates.map((stage) => ({ stageId: stage.stageId, status: stage.status }))
  });
}

function projectionEvidencePolicy(
  profilePolicy: AgentLoopProfilePolicyMetadata,
  readyStageControl: JsonObject | undefined
): JsonObject {
  return {
    profileId: profilePolicy.profileId,
    workflowGraphId: profilePolicy.workflowGraphId,
    workflowPriority: profilePolicy.workflowPriority,
    orchestrationMode: profilePolicy.orchestrationMode,
    workflowCapabilityIds: profilePolicy.workflowCapabilityIds,
    ...(profilePolicy.workflowGateOverride ? { workflowGateOverride: profilePolicy.workflowGateOverride } : {}),
    ...(readyStageControl ? { readyStageControl } : {}),
    redaction: { class: "internal" }
  };
}

function repeatedReadyStageProgressEvidence(
  counts: Map<string, number>,
  input: {
    readonly control: JsonObject | undefined;
    readonly capabilityId: string;
    readonly toolInput: JsonObject;
    readonly normalizedInputHash: string;
  }
): boolean {
  const stage = input.control ?? {};
  if (String(stage.stageAcceptanceMode ?? "") !== "supervisor") return false;
  if (String(stage.stageKind ?? "") !== "collect-evidence") return false;
  const key = [
    String(stage.profileId ?? ""),
    String(stage.graphId ?? stage.workflowGraphId ?? ""),
    String(stage.stageId ?? ""),
    input.capabilityId,
    readyStageEvidenceTarget(input.toolInput, input.normalizedInputHash)
  ].join(":");
  const count = (counts.get(key) ?? 0) + 1;
  counts.set(key, count);
  return count > 1;
}

function readyStageEvidenceTarget(input: JsonObject, fallbackHash: string): string {
  for (const key of ["path", "file", "query", "pattern", "command", "cwd"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return `${key}:${value.trim()}`;
  }
  return `input:${fallbackHash}`;
}

function workflowProjectionError(
  profilePolicy: AgentLoopProfilePolicyMetadata | undefined,
  availableCapabilities: readonly { readonly id: unknown }[],
  visibleCapabilities: readonly { readonly id: unknown }[],
  readyStageControl: JsonObject | undefined
): RedactedError | undefined {
  if (!profilePolicy || profilePolicy.workflowPriority !== "primary") return undefined;
  const workflowCapabilityIds = (profilePolicy.workflowCapabilityIds ?? []).map(String);
  const availableCapabilityIds = new Set(availableCapabilities.map((capability) => String(capability.id)));
  const visibleCapabilityIds = new Set(visibleCapabilities.map((capability) => String(capability.id)));
  const gateOverrideCapabilityIds = profilePolicy.workflowGateOverride
    ? workflowGateOverrideRequiredCapabilityIds(profilePolicy.workflowGateOverride.requiredNextAction)
    : [];
  const activeStageCapabilityIds = gateOverrideCapabilityIds.length > 0
    ? gateOverrideCapabilityIds
    : activeStageRequiredCapabilityIds(readyStageControl);
  const requiredCapabilityIds = activeStageCapabilityIds.length > 0 ? activeStageCapabilityIds : workflowCapabilityIds;
  const executableCapabilityIds = requiredCapabilityIds.filter((capabilityId) => visibleCapabilityIds.has(capabilityId));
  if (executableCapabilityIds.length > 0) return undefined;
  if (requiredCapabilityIds.length === 0 && visibleCapabilities.length > 0) return undefined;
  const unregisteredWorkflowCapabilityIds = requiredCapabilityIds.filter((capabilityId) => !availableCapabilityIds.has(capabilityId));
  const policyHiddenCapabilityIds = requiredCapabilityIds.filter((capabilityId) =>
    availableCapabilityIds.has(capabilityId) && !visibleCapabilityIds.has(capabilityId)
  );
  const diagnosticKind = unregisteredWorkflowCapabilityIds.length > 0 ? "absent-implementation" : "disabled-by-policy";
  return kernelError("KERNEL_CONFIGURATION_ERROR", "Primary workflow projected no visible capabilities.", {
    profileId: profilePolicy.profileId,
    workflowGraphId: profilePolicy.workflowGraphId,
    workflowCapabilityIds,
    ...(activeStageCapabilityIds.length > 0 ? { requiredStageCapabilityIds: activeStageCapabilityIds } : {}),
    availableCapabilityCount: availableCapabilities.length,
    classification: "blocked-by-cli-capability-gap",
    diagnosticKind,
    unregisteredWorkflowCapabilityIds,
    policyHiddenCapabilityIds,
    missingCapabilityIds: requiredCapabilityIds
  });
}

function activeStageRequiredCapabilityIds(readyStageControl: JsonObject | undefined): readonly string[] {
  const control = readyStageControl ?? {};
  const allowedCapabilityIds = Array.isArray(control.allowedCapabilityIds)
    ? control.allowedCapabilityIds.map(String)
    : [];
  const progressCapabilityIds = Array.isArray(control.progressCapabilityIds)
    ? control.progressCapabilityIds.map(String)
    : [];
  return [...new Set([...allowedCapabilityIds, ...progressCapabilityIds])];
}

function workflowGateOverrideRequiredCapabilityIds(requiredNextAction: string): readonly string[] {
  const alternatives = requiredNextAction.split("|").map((part) => part.trim()).filter(Boolean);
  if (alternatives.length > 1) {
    return [...new Set(alternatives.flatMap((alternative) => workflowGateOverrideRequiredCapabilityIds(alternative)))];
  }
  if (requiredNextAction === "standard-test-command") return ["core.test.run"];
  if (requiredNextAction === "standard-test-command-or-bounded-blocker") return ["core.test.run", "core.shell.run"];
  if (requiredNextAction === "exact-target-refresh-or-source-edit-or-bounded-blocker") {
    return ["core.file.read", "core.file.edit", "core.patch.apply"];
  }
  if (requiredNextAction === "focused-read-or-source-edit-or-bounded-blocker") {
    return ["core.file.read", "core.search.text", "core.file.edit", "core.patch.apply"];
  }
  if (requiredNextAction === "focused-read-or-source-edit-or-test-or-return-control") {
    return ["core.file.read", "core.search.text", "core.file.edit", "core.patch.apply", "core.test.run", "core.shell.run"];
  }
  if (requiredNextAction === "source-edit-or-test-or-bounded-blocker" || requiredNextAction === "source-edit-or-test-or-blocker") {
    return ["core.file.edit", "core.patch.apply", "core.test.run"];
  }
  if (requiredNextAction.startsWith("core.")) return [requiredNextAction];
  return [];
}

function schedulingNextActionForModelRequest(
  profilePolicy: AgentLoopProfilePolicyMetadata | undefined,
  readyStageControl: JsonObject | undefined,
  visibleCapabilities: readonly { readonly id: unknown }[]
): PromptSchedulingNextAction | undefined {
  if (!profilePolicy || profilePolicy.workflowPriority !== "primary") return undefined;
  const override = profilePolicy.workflowGateOverride;
  const control = readyStageControl ?? {};
  const requiredNextAction = String(override?.requiredNextAction ?? control.requiredNextAction ?? "");
  if (!requiredNextAction) return undefined;
  const visibleCapabilityIds = new Set(visibleCapabilities.map((capability) => String(capability.id)));
  const requiredCapabilityIds = override
    ? workflowGateOverrideRequiredCapabilityIds(requiredNextAction)
    : activeStageRequiredCapabilityIds(readyStageControl);
  const allowedCapabilityIds = [...new Set(requiredCapabilityIds.filter((capabilityId) => visibleCapabilityIds.has(capabilityId)))];
  const correction = typeof override?.correction === "string" ? override.correction : undefined;
  return {
    schemaVersion: "1.0.0",
    actionClass: schedulingActionClassFor(requiredNextAction, String(control.stageKind ?? "")),
    ...(typeof control.stageId === "string" ? { stageId: control.stageId } : {}),
    requiredNextAction,
    allowedCapabilityIds,
    acceptedEvidenceRefs: schedulingAcceptedEvidenceRefs(profilePolicy),
    ...(correction ? { correctionText: correction } : {}),
    redaction: { class: "internal", fields: ["acceptedEvidenceRefs", "correctionText"] }
  };
}

function schedulingActionClassFor(
  requiredNextAction: string,
  stageKind: string
): PromptSchedulingNextAction["actionClass"] {
  if (requiredNextAction === "standard-test-command" || requiredNextAction.includes("core.test.run")) return "standard-verification";
  if (requiredNextAction.includes("core.git.diff")) return "package";
  if (
    requiredNextAction.includes("core.file.edit") ||
    requiredNextAction.includes("core.patch.apply") ||
    requiredNextAction.includes("core.file.write") ||
    stageKind === "produce" ||
    stageKind === "materialize" ||
    stageKind === "repair"
  ) {
    return "mutation";
  }
  if (requiredNextAction.includes("blocker")) return "blocker";
  if (stageKind === "verify" || stageKind === "score") return "standard-verification";
  return "focused-evidence";
}

function schedulingAcceptedEvidenceRefs(profilePolicy: AgentLoopProfilePolicyMetadata): readonly string[] {
  const sharedSchedulingEvidence = profilePolicy.sharedSchedulingEvidence;
  if (!sharedSchedulingEvidence || typeof sharedSchedulingEvidence !== "object" || Array.isArray(sharedSchedulingEvidence)) return [];
  const shared = sharedSchedulingEvidence as JsonObject;
  const acceptedEvidenceRefs = shared.acceptedEvidenceRefs;
  if (Array.isArray(acceptedEvidenceRefs)) return acceptedEvidenceRefs.map(String);
  return [];
}

function isPrimaryWorkflowComplete(profilePolicy: AgentLoopProfilePolicyMetadata): boolean {
  const workflow = profilePolicy.stagedTaskWorkflow;
  if (!workflow || profilePolicy.workflowPriority !== "primary") return false;
  return workflow.runState.stageStates.length > 0 &&
    workflow.runState.stageStates.every((stage) => stage.status === "succeeded" || stage.status === "skipped");
}

function shouldClosePrimaryWorkflowAfterProgress(profilePolicy: AgentLoopProfilePolicyMetadata, completedStageKind: string | undefined): boolean {
  if (!isPrimaryWorkflowComplete(profilePolicy)) return false;
  if ((profilePolicy.stageAcceptanceMode ?? "automatic") !== "supervisor") return true;
  return completedStageKind !== "produce" && completedStageKind !== "materialize" && completedStageKind !== "repair";
}

function externalHarnessReturnGateAfterLocalVerification(
  profilePolicy: AgentLoopProfilePolicyMetadata,
  completedStageKind: string | undefined
): JsonObject | undefined {
  if (completedStageKind !== "verify") return undefined;
  if (!isEvaluationWorkflow(profilePolicy)) return undefined;
  const workflow = profilePolicy.stagedTaskWorkflow;
  if (!workflow) return undefined;
  const completedVerifyStage = workflow.runState.stageStates.find((stage) => {
    if (stage.status !== "running" || stage.evaluation?.status !== "needs-review") return false;
    const contract = workflow.graph.stages.find((candidate) => candidate.stageId === stage.stageId);
    return contract?.kind === "verify";
  });
  if (!completedVerifyStage) return undefined;
  const harnessStage = workflow.graph.stages.find((stage) =>
    isExternalHarnessStage(stage) &&
    stage.dependsOn.map(String).includes(completedVerifyStage.stageId)
  );
  if (!harnessStage) return undefined;
  const sourceMutationCount = workflow.runState.stageStates.some((stage) =>
    stage.status === "succeeded" &&
    workflow.graph.stages.find((candidate) => candidate.stageId === stage.stageId)?.kind === "produce"
  ) ? 1 : 0;
  return {
    schemaVersion: "1.0.0",
    budget: {
      kind: "verification",
      stopReason: "external-score-ready"
    },
    gate: "EXTERNAL_SCORE_READY_GATE",
    sourceMutationCount,
    testCommandCount: 1,
    successfulTestCommandCount: 1,
    modelRequestCount: 1,
    workflowReadyStageControl: {
      profileId: profilePolicy.profileId,
      workflowGraphId: profilePolicy.workflowGraphId,
      graphId: workflow.graphId,
      stageId: harnessStage.stageId,
      stageKind: "score"
    },
    redaction: { class: "internal" }
  };
}

function externalHarnessReturnGateForReadyScoreStage(
  profilePolicy: AgentLoopProfilePolicyMetadata | undefined,
  readyStageControl: JsonObject | undefined
): JsonObject | undefined {
  if (!profilePolicy || !readyStageControl) return undefined;
  if (!isEvaluationWorkflow(profilePolicy)) return undefined;
  const workflow = profilePolicy.stagedTaskWorkflow;
  if (!workflow) return undefined;
  const scoreStageId = String(readyStageControl.stageId ?? "");
  const scoreStage = workflow.graph.stages.find((stage) =>
    stage.stageId === scoreStageId &&
    isExternalHarnessStage(stage)
  );
  if (!scoreStage) return undefined;
  const scoreState = workflow.runState.stageStates.find((stage) => stage.stageId === scoreStage.stageId);
  if (scoreState?.status !== "ready") return undefined;
  const verifiedLocally = scoreStage.dependsOn.some((stageId) => {
    const stage = workflow.graph.stages.find((candidate) => candidate.stageId === stageId);
    const state = workflow.runState.stageStates.find((candidate) => candidate.stageId === stageId);
    return stage?.kind === "verify" &&
      state?.status === "succeeded" &&
      state.outputRefs.length > 0;
  });
  if (!verifiedLocally) return undefined;
  const sourceMutationCount = workflow.runState.stageStates.some((stage) =>
    stage.status === "succeeded" &&
    workflow.graph.stages.find((candidate) => candidate.stageId === stage.stageId)?.kind === "produce"
  ) ? 1 : 0;
  return {
    schemaVersion: "1.0.0",
    budget: {
      kind: "verification",
      stopReason: "external-score-ready"
    },
    gate: "EXTERNAL_SCORE_READY_GATE",
    sourceMutationCount,
    testCommandCount: 1,
    successfulTestCommandCount: 1,
    modelRequestCount: 1,
    workflowReadyStageControl: {
      profileId: profilePolicy.profileId,
      workflowGraphId: profilePolicy.workflowGraphId,
      graphId: workflow.graphId,
      stageId: scoreStage.stageId,
      stageKind: "score"
    },
    redaction: { class: "internal" }
  };
}

function isExternalHarnessStage(stage: {
  readonly stageId: string;
  readonly kind: string;
  readonly allowedTools?: readonly string[];
}): boolean {
  return (stage.allowedTools ?? []).map(String).includes("core.swe.harness.run") &&
    (stage.stageId.includes("score") || stage.kind === "score" || stage.kind === "produce");
}

function isEvaluationWorkflow(profilePolicy: AgentLoopProfilePolicyMetadata): boolean {
  return profilePolicy.workflowGovernanceMode === "evaluation" ||
    profilePolicy.role.includes("evaluation") ||
    profilePolicy.antiTailoring === true;
}

function outputContractRepairWorkflowGateOverride(outputContract: AgentLoopOutputContractVerification | undefined): AgentLoopProfileWorkflowGateOverride | undefined {
  const requiredPath = outputContract?.contract.path;
  if (!requiredPath || outputContract.status !== "fail") return undefined;
  return {
    gate: "OUTPUT_CONTRACT_REPAIR_GATE",
    requiredNextAction: "core.file.write|core.file.edit",
    terminalKind: "output-contract.repair.required",
    toolCallId: `output-contract:${stableHash(requiredPath)}`
  };
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
