import type { JsonObject } from "@deepseek/platform-contracts";

export interface CapabilityMatrixDecisionQuality extends JsonObject {
  readonly score: number;
  readonly boardSnapshotCount: number;
  readonly projectionSummaryCount: number;
  readonly projectionReasonCoverage: number;
  readonly visibleCapabilityIds: readonly string[];
  readonly hiddenReasonCount: number;
  readonly deniedReasonCount: number;
  readonly unavailableReasonCount: number;
  readonly repeatedRejectedIntentCount: number;
  readonly decisionLoopFailureCandidateCount: number;
  readonly recommendedNextActionCount: number;
  readonly gaps: readonly string[];
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export function collectDecisionQuality(combined: string): CapabilityMatrixDecisionQuality {
  let boardSnapshotCount = 0;
  let projectionSummaryCount = 0;
  let projectionReasonCount = 0;
  const visibleCapabilityIds = new Set<string>();
  let hiddenReasonCount = 0;
  let deniedReasonCount = 0;
  let unavailableReasonCount = 0;
  let repeatedRejectedIntentCount = 0;
  let decisionLoopFailureCandidateCount = 0;
  const recommendedNextActions = new Set<string>();

  for (const event of parseJsonLineObjects(combined)) {
    if (event.kind !== "tool.decision-board.snapshot") continue;
    const board = jsonObject(event.data) ?? event;
    boardSnapshotCount += 1;
    for (const capabilityId of stringArrayValue(board.visibleToolIds)) visibleCapabilityIds.add(capabilityId);
    const projectionSummaries = arrayValue(board.projectionSummaries);
    projectionSummaryCount += projectionSummaries.length;
    for (const item of projectionSummaries) {
      const summary = jsonObject(item);
      if (!summary) continue;
      const reasonCode = typeof summary.reasonCode === "string" && summary.reasonCode.length > 0;
      if (reasonCode) projectionReasonCount += 1;
      const status = typeof summary.status === "string" ? summary.status : "";
      const capabilityId = typeof summary.capabilityId === "string" ? summary.capabilityId : "";
      if (status === "visible" && capabilityId.length > 0) visibleCapabilityIds.add(capabilityId);
      if (status === "hidden" && reasonCode) hiddenReasonCount += 1;
      if (status === "denied" && reasonCode) deniedReasonCount += 1;
      if (status === "unavailable" && reasonCode) unavailableReasonCount += 1;
    }
    const repeated = numberValue(board.repeatedRejectedIntentCount);
    repeatedRejectedIntentCount = Math.max(repeatedRejectedIntentCount, repeated ?? 0);
    if (board.decisionLoopFailureCandidate === true) decisionLoopFailureCandidateCount += 1;
    for (const action of stringArrayValue(board.recommendedNextActions)) recommendedNextActions.add(action);
  }

  const projectionReasonCoverage = projectionSummaryCount > 0
    ? roundDecisionQualityRatio(projectionReasonCount / projectionSummaryCount)
    : 0;
  const gaps = [
    ...(boardSnapshotCount === 0 ? ["decision-board:missing"] : []),
    ...(projectionSummaryCount === 0 ? ["projection-evidence:missing"] : []),
    ...(projectionSummaryCount > 0 && projectionReasonCoverage < 1 ? ["projection-evidence:missing-reasons"] : []),
    ...(repeatedRejectedIntentCount > 0 ? ["decision-loop:repeated-rejections"] : []),
    ...(decisionLoopFailureCandidateCount > 0 ? ["decision-loop:failure-candidate"] : []),
    ...(recommendedNextActions.size === 0 ? ["repair-guidance:missing-next-action"] : [])
  ];
  let score = 1;
  if (boardSnapshotCount === 0) score -= 0.35;
  if (projectionSummaryCount === 0) score -= 0.25;
  score -= (1 - projectionReasonCoverage) * 0.2;
  if (recommendedNextActions.size === 0) score -= 0.1;
  if (repeatedRejectedIntentCount > 0) score -= Math.min(0.2, repeatedRejectedIntentCount * 0.05);
  if (decisionLoopFailureCandidateCount > 0) score -= 0.2;
  return {
    score: roundDecisionQualityRatio(Math.max(0, Math.min(1, score))),
    boardSnapshotCount,
    projectionSummaryCount,
    projectionReasonCoverage,
    visibleCapabilityIds: [...visibleCapabilityIds].sort(),
    hiddenReasonCount,
    deniedReasonCount,
    unavailableReasonCount,
    repeatedRejectedIntentCount,
    decisionLoopFailureCandidateCount,
    recommendedNextActionCount: recommendedNextActions.size,
    gaps,
    redaction: { class: "internal", fields: ["gaps"] }
  };
}

export function emptyDecisionQuality(gaps: readonly string[] = []): CapabilityMatrixDecisionQuality {
  return {
    score: 0,
    boardSnapshotCount: 0,
    projectionSummaryCount: 0,
    projectionReasonCoverage: 0,
    visibleCapabilityIds: [],
    hiddenReasonCount: 0,
    deniedReasonCount: 0,
    unavailableReasonCount: 0,
    repeatedRejectedIntentCount: 0,
    decisionLoopFailureCandidateCount: 0,
    recommendedNextActionCount: 0,
    gaps,
    redaction: { class: "internal", fields: ["gaps"] }
  };
}

export function roundDecisionQualityRatio(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function parseJsonLineObjects(text: string): readonly JsonObject[] {
  const objects: JsonObject[] = [];
  for (const line of text.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const object = jsonObject(JSON.parse(trimmed));
      if (object) objects.push(object);
    } catch {
      // Non-JSON stdout lines are classified elsewhere.
    }
  }
  return objects;
}

function jsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArrayValue(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
