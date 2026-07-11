import { buildReferenceToolArsenalReport } from "@deepseek/core-coding-tools";
import type { CliEvaluationComparisonSummary, CliEvaluationTaskRunRecord, JsonObject } from "@deepseek/platform-contracts";
import type { CliModeMatrixSummary } from "./mode-matrix.js";

export interface CliDeliveryCapabilityDimension extends JsonObject {
  readonly dimensionId: "tool-family" | "tool-arsenal" | "mode" | "package" | "evaluation-task" | "deepseek-api" | "memory" | "cache-observability";
  readonly score: number;
  readonly targetScore: number;
  readonly passedCount: number;
  readonly totalCount: number;
  readonly status: "pass" | "blocked";
  readonly blockingIds: readonly string[];
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface CliDeliveryCapabilitySummary extends JsonObject {
  readonly schemaVersion: string;
  readonly kind: "cli.delivery-capability.summary";
  readonly status: "pass" | "blocked";
  readonly scoringMethod: "unfinished-penalty";
  readonly score: number;
  readonly targetScore: number;
  readonly unfinishedPenaltyPerItem: number;
  readonly unfinishedTargetCount: number;
  readonly unfinishedTargetIds: readonly string[];
  readonly passedTargetCount: number;
  readonly totalTargetCount: number;
  readonly dimensions: readonly CliDeliveryCapabilityDimension[];
  readonly toolFamilyScore?: number;
  readonly toolFamilyPassedCount?: number;
  readonly toolFamilyTotalCount?: number;
  readonly toolFamilyGatePassed?: boolean;
  readonly toolArsenalScore?: number;
  readonly toolArsenalExecutableCount?: number;
  readonly toolArsenalTotalCount?: number;
  readonly toolArsenalGatePassed?: boolean;
  readonly modeScore?: number;
  readonly modeCompleteCount?: number;
  readonly modeTotalCount?: number;
  readonly modeGatePassed?: boolean;
  readonly packageScore?: number;
  readonly packagePassedCount?: number;
  readonly packageTotalCount?: number;
  readonly packageGatePassed?: boolean;
  readonly evaluationTaskScore?: number;
  readonly evaluationTaskSolvedCount?: number;
  readonly evaluationTaskTotalCount?: number;
  readonly evaluationTaskGatePassed?: boolean;
  readonly deepSeekApiScore?: number;
  readonly deepSeekApiPassedCount?: number;
  readonly deepSeekApiTotalCount?: number;
  readonly deepSeekApiGatePassed?: boolean;
  readonly memoryScore?: number;
  readonly memoryPassedCount?: number;
  readonly memoryTotalCount?: number;
  readonly memoryGatePassed?: boolean;
  readonly cacheObservabilityScore?: number;
  readonly cacheObservabilityPassedCount?: number;
  readonly cacheObservabilityTotalCount?: number;
  readonly cacheObservabilityGatePassed?: boolean;
  readonly blockingFamilyIds: readonly string[];
  readonly blockingToolArsenalIds: readonly string[];
  readonly blockingModeIds: readonly string[];
  readonly blockingPackageIds: readonly string[];
  readonly blockingEvaluationTaskIds: readonly string[];
  readonly blockingCapabilityIds: readonly string[];
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

interface CapabilityTarget {
  readonly dimensionId: "deepseek-api" | "memory" | "cache-observability";
  readonly targetId: string;
  readonly status: "pass" | "blocked";
}

export function collectDeliveryCapabilitySummary(
  evaluation: Pick<CliEvaluationComparisonSummary, "toolFamilyParityMatrix" | "packageScorecards" | "packageScorecardAggregate" | "taskRuns"> | undefined,
  modeMatrix: CliModeMatrixSummary | undefined
): CliDeliveryCapabilitySummary | undefined {
  const toolMatrix = evaluation?.toolFamilyParityMatrix;
  const packageAggregate = evaluation?.packageScorecardAggregate;
  const packageScorecards = evaluation?.packageScorecards ?? [];

  const targetScore = 0.9;
  const unfinishedPenaltyPerItem = 0.1;
  const toolArsenal = buildReferenceToolArsenalReport();
  const blockingFamilyIds = toolMatrix?.deliveryCapabilityBlockingFamilyIds.map((id) => String(id)) ?? [];
  const blockingToolArsenalIds = toolArsenal.entries
    .filter((entry) => entry.completionState !== "executable")
    .map((entry) => `${entry.referenceTool}:${entry.deepSeekFamilyId}`);
  const blockingModeIds = modeMatrix?.modeDeliveryCapabilityBlockingModeIds ?? [];
  const blockingPackageIds = packageScorecards.length > 0
    ? packageScorecards.filter((scorecard) => !scorecard.deliveryCapabilityPassed).map((scorecard) => scorecard.packageId)
    : packageAggregate?.deliveryCapabilityBlockingPackageIds ?? [];
  const evaluationTaskRuns = deliveryTaskRuns(evaluation?.taskRuns ?? []);
  const blockingEvaluationTaskIds = evaluationTaskRuns.filter((run) => run.outcome !== "solved").map((run) => run.task.taskId);
  const capabilityTargets = deliveryCapabilityTargets();
  const blockingCapabilityIds = capabilityTargets.filter((target) => target.status !== "pass").map((target) => target.targetId);
  const unfinishedTargetIds = [
    ...blockingFamilyIds.map((id) => `tool-family:${id}`),
    ...blockingToolArsenalIds.map((id) => `tool-arsenal:${id}`),
    ...blockingModeIds,
    ...blockingPackageIds.map((id) => `package:${id}`),
    ...blockingEvaluationTaskIds.map((id) => `evaluation-task:${id}`),
    ...blockingCapabilityIds.map((id) => `capability:${id}`)
  ];
  const unfinishedTargetCount = unfinishedTargetIds.length;
  const dimensions = deliveryDimensions(toolMatrix, toolArsenal, modeMatrix, packageAggregate, evaluationTaskRuns, capabilityTargets, targetScore, blockingFamilyIds, blockingToolArsenalIds, blockingModeIds, blockingPackageIds, blockingEvaluationTaskIds);
  const score = roundRatio(Math.max(0, 1 - unfinishedTargetCount * unfinishedPenaltyPerItem));
  const toolGatePassed = toolMatrix ? toolMatrix.deliveryCapabilityPassed : true;
  const toolArsenalGatePassed = blockingToolArsenalIds.length === 0;
  const packageGatePassed = packageAggregate ? packageAggregate.deliveryCapabilityPassed : true;
  const evaluationTaskGatePassed = evaluationTaskRuns.length === 0 || blockingEvaluationTaskIds.length === 0;
  const capabilityGatePassed = blockingCapabilityIds.length === 0;
  const complete = dimensions.length > 0 && toolGatePassed && toolArsenalGatePassed && packageGatePassed && evaluationTaskGatePassed && capabilityGatePassed && score >= targetScore;
  const solvedEvaluationTaskCount = evaluationTaskRuns.filter((run) => run.outcome === "solved").length;
  const passedCapabilityCount = capabilityTargets.filter((target) => target.status === "pass").length;
  const passedTargetCount = (toolMatrix?.deliveryCapabilityPassedFamilyCount ?? 0)
    + toolArsenal.executableReferenceToolCount
    + (modeMatrix?.modeDeliveryCapabilityCompletedCount ?? 0)
    + (packageAggregate?.deliveryCapabilityPassedPackageCount ?? 0)
    + solvedEvaluationTaskCount
    + passedCapabilityCount;
  const totalTargetCount = (toolMatrix?.totalFamilyCount ?? 0)
    + toolArsenal.totalReferenceToolCount
    + (modeMatrix?.modeDeliveryCapabilityTotalCount ?? 0)
    + (packageAggregate?.deliveryCapabilityTotalPackageCount ?? 0)
    + evaluationTaskRuns.length
    + capabilityTargets.length;
  const deepSeekApi = capabilityDimensionScore(capabilityTargets, "deepseek-api");
  const memory = capabilityDimensionScore(capabilityTargets, "memory");
  const cacheObservability = capabilityDimensionScore(capabilityTargets, "cache-observability");

  return {
    schemaVersion: "1.0.0",
    kind: "cli.delivery-capability.summary",
    status: complete ? "pass" : "blocked",
    scoringMethod: "unfinished-penalty",
    score,
    targetScore,
    unfinishedPenaltyPerItem,
    unfinishedTargetCount,
    unfinishedTargetIds,
    passedTargetCount,
    totalTargetCount,
    dimensions,
    ...(toolMatrix ? {
      toolFamilyScore: toolMatrix.deliveryCapabilityScore,
      toolFamilyPassedCount: toolMatrix.deliveryCapabilityPassedFamilyCount,
      toolFamilyTotalCount: toolMatrix.totalFamilyCount,
      toolFamilyGatePassed: toolMatrix.deliveryCapabilityPassed
    } : {}),
    toolArsenalScore: roundRatio(toolArsenal.executableReferenceToolCount / toolArsenal.totalReferenceToolCount),
    toolArsenalExecutableCount: toolArsenal.executableReferenceToolCount,
    toolArsenalTotalCount: toolArsenal.totalReferenceToolCount,
    toolArsenalGatePassed,
    ...(modeMatrix ? {
      modeScore: modeMatrix.modeDeliveryCapabilityScore,
      modeCompleteCount: modeMatrix.modeDeliveryCapabilityCompletedCount,
      modeTotalCount: modeMatrix.modeDeliveryCapabilityTotalCount,
      modeGatePassed: modeMatrix.modeDeliveryCapabilityPassed
    } : {}),
    ...(packageAggregate ? {
      packageScore: packageAggregate.averageDeliveryCapabilityScore,
      packagePassedCount: packageAggregate.deliveryCapabilityPassedPackageCount,
      packageTotalCount: packageAggregate.deliveryCapabilityTotalPackageCount,
      packageGatePassed: packageAggregate.deliveryCapabilityPassed
    } : {}),
    ...(evaluationTaskRuns.length > 0 ? {
      evaluationTaskScore: roundRatio(solvedEvaluationTaskCount / evaluationTaskRuns.length),
      evaluationTaskSolvedCount: solvedEvaluationTaskCount,
      evaluationTaskTotalCount: evaluationTaskRuns.length,
      evaluationTaskGatePassed
    } : {}),
    deepSeekApiScore: deepSeekApi.score,
    deepSeekApiPassedCount: deepSeekApi.passedCount,
    deepSeekApiTotalCount: deepSeekApi.totalCount,
    deepSeekApiGatePassed: deepSeekApi.gatePassed,
    memoryScore: memory.score,
    memoryPassedCount: memory.passedCount,
    memoryTotalCount: memory.totalCount,
    memoryGatePassed: memory.gatePassed,
    cacheObservabilityScore: cacheObservability.score,
    cacheObservabilityPassedCount: cacheObservability.passedCount,
    cacheObservabilityTotalCount: cacheObservability.totalCount,
    cacheObservabilityGatePassed: cacheObservability.gatePassed,
    blockingFamilyIds,
    blockingToolArsenalIds,
    blockingModeIds,
    blockingPackageIds,
    blockingEvaluationTaskIds,
    blockingCapabilityIds,
    redaction: { class: "internal", fields: ["blockingFamilyIds", "blockingToolArsenalIds", "blockingModeIds", "blockingPackageIds", "blockingEvaluationTaskIds", "blockingCapabilityIds", "unfinishedTargetIds"] }
  };
}

function deliveryDimensions(
  toolMatrix: Pick<NonNullable<CliEvaluationComparisonSummary["toolFamilyParityMatrix"]>, "deliveryCapabilityScore" | "deliveryCapabilityPassedFamilyCount" | "totalFamilyCount" | "deliveryCapabilityPassed"> | undefined,
  toolArsenal: ReturnType<typeof buildReferenceToolArsenalReport>,
  modeMatrix: CliModeMatrixSummary | undefined,
  packageAggregate: NonNullable<CliEvaluationComparisonSummary["packageScorecardAggregate"]> | undefined,
  evaluationTaskRuns: readonly CliEvaluationTaskRunRecord[],
  capabilityTargets: readonly CapabilityTarget[],
  targetScore: number,
  blockingFamilyIds: readonly string[],
  blockingToolArsenalIds: readonly string[],
  blockingModeIds: readonly string[],
  blockingPackageIds: readonly string[],
  blockingEvaluationTaskIds: readonly string[]
): readonly CliDeliveryCapabilityDimension[] {
  const dimensions: CliDeliveryCapabilityDimension[] = [];
  if (toolMatrix) {
    dimensions.push({
      dimensionId: "tool-family",
      score: toolMatrix.deliveryCapabilityScore,
      targetScore,
      passedCount: toolMatrix.deliveryCapabilityPassedFamilyCount,
      totalCount: toolMatrix.totalFamilyCount,
      status: toolMatrix.deliveryCapabilityScore >= targetScore ? "pass" : "blocked",
      blockingIds: blockingFamilyIds,
      redaction: { class: "internal", fields: ["blockingIds"] }
    });
  }
  dimensions.push({
    dimensionId: "tool-arsenal",
    score: roundRatio(toolArsenal.executableReferenceToolCount / toolArsenal.totalReferenceToolCount),
    targetScore: 1,
    passedCount: toolArsenal.executableReferenceToolCount,
    totalCount: toolArsenal.totalReferenceToolCount,
    status: blockingToolArsenalIds.length === 0 ? "pass" : "blocked",
    blockingIds: blockingToolArsenalIds,
    redaction: { class: "internal", fields: ["blockingIds"] }
  });
  if (modeMatrix) {
    dimensions.push({
      dimensionId: "mode",
      score: modeMatrix.modeDeliveryCapabilityScore,
      targetScore,
      passedCount: modeMatrix.modeDeliveryCapabilityCompletedCount,
      totalCount: modeMatrix.modeDeliveryCapabilityTotalCount,
      status: modeMatrix.modeDeliveryCapabilityScore >= targetScore ? "pass" : "blocked",
      blockingIds: blockingModeIds,
      redaction: { class: "internal", fields: ["blockingIds"] }
    });
  }
  if (packageAggregate) {
    dimensions.push({
      dimensionId: "package",
      score: packageAggregate.averageDeliveryCapabilityScore ?? 0,
      targetScore: packageAggregate.deliveryCapabilityTargetScore,
      passedCount: packageAggregate.deliveryCapabilityPassedPackageCount,
      totalCount: packageAggregate.deliveryCapabilityTotalPackageCount,
      status: packageAggregate.deliveryCapabilityPassed ? "pass" : "blocked",
      blockingIds: blockingPackageIds,
      redaction: { class: "internal", fields: ["blockingIds"] }
    });
  }
  if (evaluationTaskRuns.length > 0) {
    const solvedCount = evaluationTaskRuns.filter((run) => run.outcome === "solved").length;
    dimensions.push({
      dimensionId: "evaluation-task",
      score: roundRatio(solvedCount / evaluationTaskRuns.length),
      targetScore: 1,
      passedCount: solvedCount,
      totalCount: evaluationTaskRuns.length,
      status: blockingEvaluationTaskIds.length === 0 ? "pass" : "blocked",
      blockingIds: blockingEvaluationTaskIds,
      redaction: { class: "internal", fields: ["blockingIds"] }
    });
  }
  for (const dimensionId of ["deepseek-api", "memory", "cache-observability"] as const) {
    const summary = capabilityDimensionScore(capabilityTargets, dimensionId);
    dimensions.push({
      dimensionId,
      score: summary.score,
      targetScore,
      passedCount: summary.passedCount,
      totalCount: summary.totalCount,
      status: summary.gatePassed ? "pass" : "blocked",
      blockingIds: summary.blockingIds,
      redaction: { class: "internal", fields: ["blockingIds"] }
    });
  }
  return dimensions;
}

function deliveryCapabilityTargets(): readonly CapabilityTarget[] {
  return [
    target("deepseek-api", "deepseek-api:thinking-effort-mapping", "pass"),
    target("deepseek-api", "deepseek-api:stateless-resumed-history", "pass"),
    target("deepseek-api", "deepseek-api:provider-request-replay", "pass"),
    target("deepseek-api", "deepseek-api:cli-thinking-controls", "pass"),
    target("deepseek-api", "deepseek-api:strict-beta-tool-schema-lane", "pass"),
    target("deepseek-api", "deepseek-api:json-output-mode", "pass"),
    target("deepseek-api", "deepseek-api:json-output-guardrails", "pass"),
    target("deepseek-api", "deepseek-api:json-parser-retry", "pass"),
    target("deepseek-api", "deepseek-api:chat-prefix-completion", "pass"),
    target("deepseek-api", "deepseek-api:fim-completion", "pass"),
    target("deepseek-api", "deepseek-api:anthropic-compatibility", "pass"),
    target("memory", "memory:lossless-context-restart-retrieval", "pass"),
    target("memory", "memory:lossless-context-priority-below-current-instructions", "pass"),
    target("memory", "memory:permanent-memory-contracts-manager", "pass"),
    target("memory", "memory:permanent-memory-provider-manifest", "pass"),
    target("memory", "memory:permanent-memory-durable-provider", "pass"),
    target("memory", "memory:permanent-memory-audit-export-import", "pass"),
    target("memory", "memory:permanent-memory-provider-switching-safety", "pass"),
    target("memory", "memory:permanent-memory-governed-promotion", "pass"),
    target("memory", "memory:permanent-memory-candidate-extraction", "pass"),
    target("memory", "memory:permanent-memory-runtime-injection", "pass"),
    target("memory", "memory:permanent-memory-stale-conflict-scope-filtering", "pass"),
    target("memory", "memory:permanent-memory-external-source-policy", "pass"),
    target("memory", "memory:permanent-memory-workflow-routing", "pass"),
    target("memory", "memory:permanent-memory-hook-timeout-isolation", "pass"),
    target("memory", "memory:permanent-memory-user-controls", "pass"),
    target("memory", "memory:pageindex-lossless-cache-do-not-satisfy-permanent-memory", "pass"),
    target("cache-observability", "cache-observability:provider-cache-usage-normalization", "pass"),
    target("cache-observability", "cache-observability:diagnostics-surface", "pass"),
    target("cache-observability", "cache-observability:live-include-usage-smoke", "pass"),
    target("cache-observability", "cache-observability:not-memory-correctness-gate", "pass")
  ];
}

function capabilityDimensionScore(targets: readonly CapabilityTarget[], dimensionId: CapabilityTarget["dimensionId"]): {
  readonly score: number;
  readonly passedCount: number;
  readonly totalCount: number;
  readonly gatePassed: boolean;
  readonly blockingIds: readonly string[];
} {
  const selected = targets.filter((targetItem) => targetItem.dimensionId === dimensionId);
  const passedCount = selected.filter((targetItem) => targetItem.status === "pass").length;
  const blockingIds = selected.filter((targetItem) => targetItem.status !== "pass").map((targetItem) => targetItem.targetId);
  return {
    score: selected.length > 0 ? roundRatio(passedCount / selected.length) : 0,
    passedCount,
    totalCount: selected.length,
    gatePassed: selected.length > 0 && blockingIds.length === 0,
    blockingIds
  };
}

function target(dimensionId: CapabilityTarget["dimensionId"], targetId: string, status: CapabilityTarget["status"]): CapabilityTarget {
  return { dimensionId, targetId, status };
}

function deliveryTaskRuns(taskRuns: readonly CliEvaluationTaskRunRecord[]): readonly CliEvaluationTaskRunRecord[] {
  const deepseekRuns = taskRuns.filter((run) => run.baseline.baselineId === "deepseek-cli");
  return deepseekRuns.length > 0 ? deepseekRuns : taskRuns.filter((run) => run.baseline.status === "available");
}

function roundRatio(value: number): number {
  return Math.round(value * 1000) / 1000;
}
