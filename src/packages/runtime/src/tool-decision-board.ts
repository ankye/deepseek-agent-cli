import type {
  CapabilityManifest,
  FailureAnalysisNextAction,
  FailureAnalysisRecord,
  JsonObject,
  SharedSchedulingLineageRecord,
  SessionId,
  ToolDecisionBoard,
  ToolDecisionRecord,
  ToolFeedbackStatus,
  ToolProjectionDecision,
  TurnId
} from "@deepseek/platform-contracts";
import { stableHash } from "./trace.js";

export const REPEATED_REJECTED_INTENT_SUPPRESSION_THRESHOLD = 3;

export interface ToolDecisionBoardState {
  readonly boardId: string;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly records: ToolDecisionRecord[];
  readonly lineageRecords: SharedSchedulingLineageRecord[];
  readonly failureAnalysisRecords: FailureAnalysisRecord[];
  readonly rejectedIntentCounts: Map<string, number>;
}

export interface ToolDecisionRecordInput {
  readonly kind: ToolDecisionRecord["kind"];
  readonly status: ToolDecisionRecord["status"];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly capabilityId?: string;
  readonly normalizedInputHash?: string;
  readonly reasonCode?: string;
  readonly correctiveAction?: string;
  readonly recommendedNextAction?: string;
  readonly iteration?: number;
  readonly metadata?: JsonObject;
}

export function createToolDecisionBoardState(input: {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
}): ToolDecisionBoardState {
  return {
    boardId: `tool-decision-board:${stableHash(`${input.sessionId}:${input.turnId}`)}`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    records: [],
    lineageRecords: [],
    failureAnalysisRecords: [],
    rejectedIntentCounts: new Map()
  };
}

export function normalizeToolInputHash(input: JsonObject): string {
  return stableHash(stableJson(input));
}

export function recordToolDecision(
  state: ToolDecisionBoardState,
  record: ToolDecisionRecordInput
): ToolDecisionRecord {
  const { metadata, ...recordFields } = record;
  const fullRecord: ToolDecisionRecord = {
    ...recordFields,
    recordId: `tool-decision:${state.records.length + 1}:${stableHash(JSON.stringify(record))}`,
    timestamp: new Date(0).toISOString(),
    metadata: metadata ?? {}
  };
  state.records.push(fullRecord);
  return fullRecord;
}

export function recordSharedBoardLineage(
  state: ToolDecisionBoardState,
  input: {
    readonly parentRunId?: string;
    readonly childRunId?: string;
    readonly attemptId?: string;
    readonly stageId?: string;
    readonly dispatchBatchId?: string;
    readonly toolCallId?: string;
    readonly terminalEventId?: string;
    readonly evidenceRefs?: readonly string[];
    readonly nextAllowedAction?: FailureAnalysisNextAction | string;
  }
): SharedSchedulingLineageRecord {
  const record: SharedSchedulingLineageRecord = {
    recordId: `shared-lineage:${state.lineageRecords.length + 1}:${stableHash(stableJson(input))}`,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    ...(input.childRunId ? { childRunId: input.childRunId } : {}),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ...(input.stageId ? { stageId: input.stageId } : {}),
    ...(input.dispatchBatchId ? { dispatchBatchId: input.dispatchBatchId } : {}),
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    ...(input.terminalEventId ? { terminalEventId: input.terminalEventId } : {}),
    evidenceRefs: input.evidenceRefs ?? [],
    ...(input.nextAllowedAction ? { nextAllowedAction: input.nextAllowedAction } : {}),
    timestamp: new Date(0).toISOString(),
    redaction: { class: "internal" }
  };
  state.lineageRecords.push(record);
  recordToolDecision(state, {
    kind: "lineage",
    status: "accepted",
    reasonCode: "shared-board.lineage-recorded",
    ...(input.nextAllowedAction ? { recommendedNextAction: input.nextAllowedAction } : {}),
    metadata: {
      recordId: record.recordId,
      parentRunId: input.parentRunId,
      childRunId: input.childRunId,
      attemptId: input.attemptId,
      stageId: input.stageId,
      dispatchBatchId: input.dispatchBatchId,
      toolCallId: input.toolCallId,
      terminalEventId: input.terminalEventId,
      evidenceRefs: input.evidenceRefs ?? []
    }
  });
  return record;
}

export function recordFailureAnalysis(
  state: ToolDecisionBoardState,
  input: {
    readonly attemptId: string;
    readonly stageId?: string;
    readonly terminalKind: string;
    readonly failureClass: string;
    readonly attribution: FailureAnalysisRecord["attribution"];
    readonly proofStatus: FailureAnalysisRecord["proofStatus"];
    readonly evidenceQueries?: readonly string[];
    readonly acceptedEvidenceRefs?: readonly string[];
    readonly nextAllowedAction: FailureAnalysisNextAction;
    readonly residualRisk?: string;
  }
): FailureAnalysisRecord {
  const modelOwnedAllowed = input.attribution === "model-owned" && input.proofStatus === "proven" && modelOwnedExclusionsSatisfied(input.acceptedEvidenceRefs ?? []);
  const provenOrBounded = input.proofStatus === "proven" || input.proofStatus === "inconclusive";
  const action = input.attribution === "model-owned" && !modelOwnedAllowed
    ? "search-evidence"
    : input.proofStatus === "unproven"
      ? "search-evidence"
      : input.nextAllowedAction;
  const record: FailureAnalysisRecord = {
    recordId: `failure-analysis:${state.failureAnalysisRecords.length + 1}:${stableHash(stableJson(input))}`,
    attemptId: input.attemptId,
    ...(input.stageId ? { stageId: input.stageId } : {}),
    terminalKind: input.terminalKind,
    failureClass: input.failureClass,
    attribution: input.attribution,
    proofStatus: input.proofStatus,
    evidenceQueries: input.evidenceQueries ?? [],
    acceptedEvidenceRefs: input.acceptedEvidenceRefs ?? [],
    nextAllowedAction: action,
    rerunAllowed: provenOrBounded && action === "rerun",
    modelOwnedAttributionAllowed: modelOwnedAllowed,
    ...(input.residualRisk ? { residualRisk: input.residualRisk } : {}),
    timestamp: new Date(0).toISOString(),
    redaction: { class: "internal", fields: ["acceptedEvidenceRefs"] }
  };
  state.failureAnalysisRecords.push(record);
  recordToolDecision(state, {
    kind: "failure-analysis",
    status: record.rerunAllowed || action === "repair" ? "accepted" : "blocked",
    reasonCode: `failure-analysis.${record.proofStatus}`,
    recommendedNextAction: action,
    metadata: {
      recordId: record.recordId,
      attemptId: record.attemptId,
      stageId: record.stageId,
      terminalKind: record.terminalKind,
      failureClass: record.failureClass,
      attribution: record.attribution,
      proofStatus: record.proofStatus,
      evidenceQueries: record.evidenceQueries,
      acceptedEvidenceRefs: record.acceptedEvidenceRefs,
      rerunAllowed: record.rerunAllowed,
      modelOwnedAttributionAllowed: record.modelOwnedAttributionAllowed
    }
  });
  return record;
}

export function rejectedIntentKey(input: {
  readonly toolName: string;
  readonly normalizedInputHash: string;
}): string {
  return `${input.toolName}:${input.normalizedInputHash}`;
}

export function recordRejectedIntent(
  state: ToolDecisionBoardState,
  input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly capabilityId?: string;
    readonly normalizedInputHash: string;
    readonly terminalKind: string;
    readonly correctiveAction?: string | undefined;
    readonly recommendedNextAction?: string | undefined;
    readonly iteration: number;
  }
): { readonly count: number; readonly record: ToolDecisionRecord } {
  const key = rejectedIntentKey(input);
  const count = (state.rejectedIntentCounts.get(key) ?? 0) + 1;
  state.rejectedIntentCounts.set(key, count);
  const record = recordToolDecision(state, {
    kind: "feedback",
    status: "rejected",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
    normalizedInputHash: input.normalizedInputHash,
    reasonCode: input.terminalKind,
    ...(input.correctiveAction ? { correctiveAction: input.correctiveAction } : {}),
    ...(input.recommendedNextAction ? { recommendedNextAction: input.recommendedNextAction } : {}),
    iteration: input.iteration,
    metadata: { repeatedRejectedIntentCount: count }
  });
  return { count, record };
}

export function recordRejectedToolFeedback(
  state: ToolDecisionBoardState,
  input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly capabilityId?: string;
    readonly normalizedInputHash: string;
    readonly terminalKind: string;
    readonly correctiveAction?: string | undefined;
    readonly recommendedNextAction?: string | undefined;
    readonly iteration: number;
    readonly metadata?: JsonObject;
  }
): ToolDecisionRecord {
  return recordToolDecision(state, {
    kind: "feedback",
    status: "rejected",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
    normalizedInputHash: input.normalizedInputHash,
    reasonCode: input.terminalKind,
    ...(input.correctiveAction ? { correctiveAction: input.correctiveAction } : {}),
    ...(input.recommendedNextAction ? { recommendedNextAction: input.recommendedNextAction } : {}),
    iteration: input.iteration,
    metadata: input.metadata ?? {}
  });
}

export function shouldSuppressRepeatedRejectedIntent(
  state: ToolDecisionBoardState,
  input: {
    readonly toolName: string;
    readonly normalizedInputHash: string;
  }
): boolean {
  return (state.rejectedIntentCounts.get(rejectedIntentKey(input)) ?? 0) >= REPEATED_REJECTED_INTENT_SUPPRESSION_THRESHOLD - 1;
}

export function shouldSuppressRepeatedMutationFailure(
  state: ToolDecisionBoardState,
  input: {
    readonly toolName: string;
    readonly normalizedInputHash: string;
  }
): boolean {
  return (state.rejectedIntentCounts.get(rejectedIntentKey(input)) ?? 0) >= 1;
}

export function toolDecisionBoardSnapshot(input: {
  readonly state: ToolDecisionBoardState;
  readonly iteration: number;
  readonly activeProfileId?: string;
  readonly activeStageId?: string;
  readonly availableCapabilities: readonly CapabilityManifest[];
  readonly visibleCapabilities: readonly CapabilityManifest[];
  readonly profilePolicy?: ToolProjectionEvidencePolicy;
}): ToolDecisionBoard {
  const visibleIds = new Set(input.visibleCapabilities.map((capability) => String(capability.id)));
  const projectionSummaries = buildProjectionSummaries(input, visibleIds);
  const hidden = projectionSummaries.filter((summary) => summary.status === "hidden");
  const previousRejectedIntents = input.state.records.filter((record) => record.status === "rejected").slice(-8);
  const repeatedRejectedIntentCount = Math.max(0, ...[...input.state.rejectedIntentCounts.values()]);
  const recommendedNextActions = [
    ...new Set(previousRejectedIntents.flatMap((record) => [
      record.recommendedNextAction,
      record.correctiveAction
    ].filter((value): value is string => typeof value === "string" && value.length > 0))
      .concat(defaultRecommendedNextActions(input, projectionSummaries)))
  ].slice(0, 5);
  return {
    boardId: input.state.boardId,
    sessionId: input.state.sessionId,
    turnId: input.state.turnId,
    iteration: input.iteration,
    ...(input.activeProfileId ? { activeProfileId: input.activeProfileId } : {}),
    ...(input.activeStageId ? { activeStageId: input.activeStageId } : {}),
    visibleToolIds: input.visibleCapabilities.map((capability) => String(capability.id)),
    projectionSummaries,
    hiddenToolSummaries: hidden,
    records: input.state.records.slice(-20),
    previousRejectedIntents,
    repeatedRejectedIntentCount,
    decisionLoopFailureCandidate: repeatedRejectedIntentCount >= REPEATED_REJECTED_INTENT_SUPPRESSION_THRESHOLD,
    recommendedNextActions,
    sharedSchedulingEvidence: sharedSchedulingEvidence(input.state),
    counters: {
      visibleToolCount: input.visibleCapabilities.length,
      hiddenToolCount: hidden.length,
      deniedToolCount: projectionSummaries.filter((summary) => summary.status === "denied").length,
      unavailableToolCount: projectionSummaries.filter((summary) => summary.status === "unavailable").length,
      recordCount: input.state.records.length,
      rejectedIntentKeyCount: input.state.rejectedIntentCounts.size
    },
    redaction: { class: "internal", fields: ["records.metadata", "previousRejectedIntents.metadata"] }
  };
}

function sharedSchedulingEvidence(state: ToolDecisionBoardState): ToolDecisionBoard["sharedSchedulingEvidence"] {
  const evidenceRefs = new Set<string>();
  for (const record of state.lineageRecords) {
    for (const ref of record.evidenceRefs) evidenceRefs.add(ref);
  }
  for (const record of state.failureAnalysisRecords) {
    for (const ref of record.acceptedEvidenceRefs) evidenceRefs.add(ref);
  }
  const nextAllowedAction = latestNextAllowedAction(state);
  return {
    lineageIds: state.lineageRecords.slice(-20),
    failureAnalysisRecords: state.failureAnalysisRecords.slice(-20),
    acceptedEvidenceRefs: [...evidenceRefs],
    ...(nextAllowedAction ? { nextAllowedAction } : {}),
    redaction: { class: "internal", fields: ["lineageIds", "failureAnalysisRecords.acceptedEvidenceRefs"] }
  };
}

function latestNextAllowedAction(state: ToolDecisionBoardState): FailureAnalysisNextAction | string | undefined {
  for (let index = state.failureAnalysisRecords.length - 1; index >= 0; index -= 1) {
    const action = state.failureAnalysisRecords[index]?.nextAllowedAction;
    if (action) return action;
  }
  for (let index = state.lineageRecords.length - 1; index >= 0; index -= 1) {
    const action = state.lineageRecords[index]?.nextAllowedAction;
    if (action) return action;
  }
  return undefined;
}

function modelOwnedExclusionsSatisfied(evidenceRefs: readonly string[]): boolean {
  const text = evidenceRefs.join("\n").toLowerCase();
  return [
    "framework",
    "tool",
    "environment",
    "harness",
    "cache",
    "prompt",
    "repair"
  ].every((category) => text.includes(category));
}

function defaultRecommendedNextActions(input: {
  readonly activeStageId?: string;
  readonly visibleCapabilities: readonly CapabilityManifest[];
}, projectionSummaries: readonly ToolProjectionDecision[]): readonly string[] {
  const requiredVisible = projectionSummaries
    .filter((summary) => summary.status === "visible" && summary.requiredByStage)
    .map((summary) => summary.capabilityId);
  const fallbackVisible = input.visibleCapabilities.map((capability) => String(capability.id));
  const candidates = requiredVisible.length > 0 ? requiredVisible : fallbackVisible;
  const visibleList = [...new Set(candidates)].slice(0, 4);
  if (visibleList.length === 0) return [];
  const stage = input.activeStageId ? ` for ${input.activeStageId}` : "";
  return [`Use visible tool ${visibleList.join("|")}${stage}, or report a bounded blocker if none fits.`];
}

interface ToolProjectionEvidencePolicy {
  readonly profileId?: string;
  readonly toolProjectionSource?: string;
  readonly workflowCapabilityIds?: readonly string[];
  readonly requiredStageCapabilityIds?: readonly string[];
  readonly deniedCapabilityIds?: readonly string[];
  readonly missingCapabilityIds?: readonly string[];
  readonly capabilityAffordanceCompiler?: JsonObject;
}

export function feedbackStatusToDecisionStatus(status: ToolFeedbackStatus): ToolDecisionRecord["status"] {
  if (status === "success") return "completed";
  if (status === "denied") return "denied";
  if (status === "rejected") return "rejected";
  return "failed";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function modelAliases(capability: CapabilityManifest): readonly string[] {
  const aliases = capability.projection?.modelAliases;
  return Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === "string") : [];
}

function buildProjectionSummaries(input: {
  readonly activeProfileId?: string;
  readonly activeStageId?: string;
  readonly availableCapabilities: readonly CapabilityManifest[];
  readonly visibleCapabilities: readonly CapabilityManifest[];
  readonly profilePolicy?: ToolProjectionEvidencePolicy;
}, visibleIds: ReadonlySet<string>): readonly ToolProjectionDecision[] {
  const availableById = new Map(input.availableCapabilities.map((capability) => [String(capability.id), capability]));
  const profile = input.profilePolicy;
  const policySource = profile?.toolProjectionSource ?? "runtime-tool-projection";
  const requiredStageIds = new Set((profile?.requiredStageCapabilityIds ?? profile?.workflowCapabilityIds ?? []).map(String));
  const deniedIds = new Set((profile?.deniedCapabilityIds ?? []).map(String));
  const missingIds = new Set([
    ...(profile?.missingCapabilityIds ?? []).map(String),
    ...stringArray(profile?.capabilityAffordanceCompiler?.missingCapabilityIds)
  ]);
  const allIds = new Set([
    ...input.availableCapabilities.map((capability) => String(capability.id)),
    ...requiredStageIds,
    ...deniedIds,
    ...missingIds
  ]);

  return [...allIds].sort().map((capabilityId): ToolProjectionDecision => {
    const capability = availableById.get(capabilityId);
    const requiredByStage = requiredStageIds.has(capabilityId);
    const base = {
      capabilityId,
      aliases: capability ? modelAliases(capability) : [],
      sideEffect: capability?.sideEffect ?? "none",
      policySource,
      ...(profile?.profileId || input.activeProfileId ? { profileId: profile?.profileId ?? input.activeProfileId } : {}),
      ...(input.activeStageId ? { stageId: input.activeStageId } : {}),
      requiredByStage
    };
    if (!capability || missingIds.has(capabilityId)) {
      return {
        ...base,
        status: "unavailable",
        visible: false,
        reason: "workflow capability is not registered or has no executable provider",
        reasonCode: "workflow-capability-unregistered",
        issueClass: "cli-capability-gap",
        unavailableBecause: capability ? "capability-affordance-compiler-missing" : "capability-not-registered"
      };
    }
    if (deniedIds.has(capabilityId)) {
      return {
        ...base,
        status: "denied",
        visible: false,
        reason: "profile or policy denied this capability for the current stage",
        reasonCode: "profile-denied",
        issueClass: "policy-denial"
      };
    }
    if (visibleIds.has(capabilityId)) {
      return {
        ...base,
        status: "visible",
        visible: true,
        reason: requiredByStage ? "required stage capability is model-visible" : "capability is model-visible under the active projection policy",
        reasonCode: requiredByStage ? "stage-required-visible" : "projection-visible",
        issueClass: "none"
      };
    }
    const hostOptInRequired = requiresExplicitHostOptIn(capability);
    return {
      ...base,
      status: "hidden",
      visible: false,
      reason: hiddenProjectionReason(requiredByStage, hostOptInRequired),
      reasonCode: hostOptInRequired ? "explicit-host-opt-in-required" : requiredByStage ? "stage-required-hidden" : "stage-boundary",
      issueClass: hostOptInRequired ? "deliberate-boundary" : requiredByStage ? "provider-compatibility-limit" : "deliberate-boundary"
    };
  });
}

function hiddenProjectionReason(requiredByStage: boolean, hostOptInRequired: boolean): string {
  if (hostOptInRequired) return "capability requires explicit host opt-in before model projection";
  if (requiredByStage) return "required stage capability is hidden by the active projection policy";
  return "capability is outside the current stage or projection boundary";
}

function requiresExplicitHostOptIn(capability: CapabilityManifest): boolean {
  if (capability.sideEffect === "network") return true;
  const permissions = capability.permissions.map((permission) => permission.toLowerCase());
  return permissions.some((permission) =>
    permission.includes("network")
    || permission.includes("browser")
    || permission.includes("connector")
    || permission.includes("mcp")
    || permission.includes("media")
    || permission.includes("design")
    || permission.includes("remote")
  );
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}
