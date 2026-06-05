import type {
  AgentLoopControl,
  AgentLoopLimits,
  AgentLoopOutputContractVerification,
  AgentLoopRequest,
  AgentLoopSummary,
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
  TraceContext,
  TurnId,
  VisibleReasoningProjection,
  VisibleReasoningRecord,
  VisibleReasoningStatus
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
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
import { extractSkillActivateMetadata, projectToolSet, recordToolResultEvidence } from "./agent-loop-tools.js";
import { consumedBudgetEvents } from "./modes/budgets.js";
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
import { createTaskDeliveryFlowSummary, taskDeliveryFlowEventData } from "./task-delivery-flow.js";

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
  let repairContinuationRequested = false;
  let toolEvidenceEvents: RuntimeEvent[] = [];
  let outputContractVerification: AgentLoopOutputContractVerification | undefined;
  const restoredHistory = await restoreSessionHistory(deps, sessionId);
  const messages: ModelChatMessage[] = [...restoredHistory.messages, { role: "user", content: request.prompt }];
  let contextProjection: ContextProjectionResult | undefined;
  let evidenceFirst: import("@deepseek/platform-contracts").EvidenceFirstRuntimeContext | undefined;
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
  const taskDeliveryFlowData = taskDeliveryFlowEventData(taskDeliveryFlow);
  const signal = control.signal;

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
    visibleReasoning: visibleReasoningProjection ?? (visibleReasoningRecords.length > 0 ? projectReasoningForOutput(visibleReasoningRecords, request.outputMode) : undefined)
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
          repairContinuationRequested = true;
          yield stopped;
          return true;
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
    iterations += 1;
    let iterationReasoning = "";
    let reasoningPersistedForIteration = false;
    const availableCapabilities = await deps.capabilities.listModelVisible();
    const assembly = await assemblePromptForIteration(deps, request, sessionId, turnId, trace, messages, contextProjection, availableCapabilities, limits, evidenceFirst, currentRepairOutcome(), {
      phasePlan,
      reasoningEffortMapping,
      taskDecision: taskDeliveryFlow.decisionRequest
    });
    if (assembly.status === "rejected") {
      diagnostics.push(...assembly.diagnostics);
      const error = assembly.diagnostics[0] ?? kernelError("KERNEL_ENVELOPE_INVALID", "Prompt assembly rejected model dispatch");
      yield* emitFailureWithRepair("rejected", "prompt-assembly-rejected", error, undefined, { promptAssembly: promptAssemblyEventPayload(assembly, request) });
      terminalEmitted = true;
      return;
    }
    const visibleCapabilities = projectToolSet(availableCapabilities, request);
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
    const promptAssembled = agentLoopEvent("prompt.assembled", sessionId, turnId, trace, promptAssemblyEventPayload(assembly, request), request.agentId);
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
      visibleToolCount: assembly.toolPlan.visibleToolCount,
      providerRequestReplay: providerRequestReplayEvidence(assembly.messages, restoredHistory),
      promptAssembly: {
        fingerprint: assembly.fingerprint,
        sectionCount: assembly.sections.length,
        budgetStatus: assembly.budget.status
      },
      ...(assembly.trace.pipeline ? { contextPipeline: assembly.trace.pipeline } : {}),
      ...(evidenceFirst ? { evidenceFirst: evidenceFirstEventData(evidenceFirst) } : {}),
      ...(contextProjection ? { contextProjection: projectionEventData(contextProjection) } : {}),
      taskDeliveryFlow: taskDeliveryFlowData,
      ...(request.referenceContext ? { referenceContext: referenceContextSummary(request) } : {})
    }, request.agentId);
    await recordRuntimeAdapterEvent(deps, modelRequested);
    await recordRuntimeModelRequestAudit(deps, modelRequested, {
      phase: "runtime",
      requestCount: 1,
      providerId: String(request.profile.providerId),
      model: request.profile.model,
      promptAssemblyFingerprint: assembly.fingerprint,
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
        taskDeliveryFlow: taskDeliveryFlowData,
        promptAssembly: {
          fingerprint: assembly.fingerprint,
          budget: assembly.budget,
          replay: assembly.trace.replay
        },
        ...(assembly.trace.pipeline ? { contextPipeline: assembly.trace.pipeline } : {}),
        ...(request.referenceContext ? { referenceContext: request.referenceContext } : {}),
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
          const toolName = resolveCapabilityId(providerToolName, visibleCapabilities);
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
        const toolName = resolveCapabilityId(providerToolName, visibleCapabilities);
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
        const preflight = await deps.toolIntentPreflight.check({
          intent: {
            toolCallId,
            name: toolName,
            input: modelEvent.input,
            source: "model"
          },
          workspaceRoot: request.workspaceRoot,
          platform: descriptor.os,
          modelVisibleCapabilities: visibleCapabilities.map((capability) => capability.id),
          providerId: request.profile.providerId,
          profileId: request.profile.id
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
        const kernelRequest: RuntimeKernelRequest = {
          capabilityId: preflight.capabilityId,
          caller: request.caller,
          input: toolInput,
          sessionId,
          turnId,
          timeoutMs: limits.toolTimeoutMs,
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
        const toolResultText = modelToolResultText(terminal);
        messages.push({ role: "tool", content: toolResultText, toolCallId, toolName });
        const executionFeedback = buildToolResultFeedback({
          toolCallId,
          toolName,
          capabilityId: String(preflight.capabilityId),
          status: executionFeedbackStatus(terminal),
          text: toolResultText,
          diagnostics: terminal?.error ? [terminal.error] : [],
          trace,
          limitBytes: limits.maxOutputBytes
        });
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
        }, request.agentId, terminal?.error);
        await recordRuntimeAdapterEvent(deps, resultEvent);
        yield resultEvent;
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
    if (repairContinuationRequested && iterations < limits.maxModelIterations) {
      continue;
    }
    if (!requestedTool) {
      if (evidenceFirst?.classification.evidenceRequired) {
        const grounding = groundStrictClaims(assistantText, evidenceFirst);
        evidenceFirst = { ...evidenceFirst, summary: grounding.summary };
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

  const messages: ModelChatMessage[] = [];
  const restoredNodeIds: string[] = [];
  const sourceClasses: string[] = [];
  const emittedToolCallIds = new Set<string>();
  const lcmEvents = events
    .filter((event) => event.kind === "context.lcm.node-recorded")
    .slice(-RESTORED_HISTORY_MESSAGE_LIMIT * 2);

  for (const event of lcmEvents) {
    const nodeId = stringValue(event.payload.nodeId);
    if (!nodeId) continue;
    const described = await deps.losslessContext.describe({ nodeId });
    const node = described.node;
    if (!node || node.kind === "summary" || node.role === "summary" || node.content.trim().length === 0) continue;
    if (node.role === "user") {
      messages.push({ role: "user", content: boundedHistoryContent(node.content) });
    } else if (node.role === "assistant") {
      messages.push({ role: "assistant", content: boundedHistoryContent(node.content) });
    } else if (node.role === "tool") {
      const toolCallId = stringValue(node.metadata.toolCallId);
      const toolName = stringValue(node.metadata.toolName);
      if (toolCallId) {
        const intent = toolIntents.get(toolCallId);
        if (intent && !emittedToolCallIds.has(toolCallId)) {
          messages.push(intent);
          emittedToolCallIds.add(toolCallId);
        }
      }
      messages.push({
        role: "tool",
        content: boundedHistoryContent(node.content),
        ...(toolCallId ? { toolCallId } : {}),
        ...(toolName ? { toolName } : {})
      });
    }
    restoredNodeIds.push(node.nodeId);
    sourceClasses.push(node.sourceClass);
    if (messages.length >= RESTORED_HISTORY_MESSAGE_LIMIT) break;
  }

  return {
    messages,
    sessionEventCount: events.length,
    restoredNodeIds,
    restoredSourceClasses: [...new Set(sourceClasses)],
    diagnostics: []
  };
}

function providerRequestReplayEvidence(messages: readonly ModelChatMessage[], restored: RestoredSessionHistory): JsonObject {
  const toolResultCount = messages.filter((message) => message.role === "tool").length;
  const assistantToolCallCount = messages.reduce((count, message) => count + (message.toolCalls?.length ?? 0), 0);
  const reasoningContinuationCount = messages.filter((message) => typeof message.reasoningContent === "string" && message.reasoningContent.length > 0).length;
  return {
    schemaVersion: "1.0.0",
    status: restored.messages.length > 0 ? "restored" : restored.sessionEventCount > 0 ? "no-restorable-lossless-history" : "empty",
    sessionEventCount: restored.sessionEventCount,
    selectedHistoryMessageCount: messages.length,
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

function boundedHistoryContent(value: string): string {
  return value.length > RESTORED_HISTORY_CONTENT_LIMIT ? value.slice(0, RESTORED_HISTORY_CONTENT_LIMIT) : value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function jsonObjectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
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
