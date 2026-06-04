import type {
  AgentLoopOutputMode,
  CliEvaluationComparisonSummary,
  JsonObject
} from "@deepseek/platform-contracts";
import type { CliDeliveryCapabilitySummary } from "./delivery-capability.js";
import type { CliEvaluationOptions } from "./evaluation.js";

export function buildEvaluationDeliveryCapabilityEvidence(
  evaluation: CliEvaluationComparisonSummary,
  overallDeliveryCapability: CliDeliveryCapabilitySummary,
  evaluationOptions: CliEvaluationOptions,
  outputMode: AgentLoopOutputMode
): JsonObject {
  return {
    schemaVersion: "1.0.0",
    kind: "cli.overall-delivery-capability-score.evidence",
    generatedAt: new Date().toISOString(),
    command: evaluationDeliveryCapabilityCommand(evaluationOptions, outputMode),
    invocation: {
      schemaVersion: "1.0.0",
      kind: "cli.evaluation.invocation",
      mode: evaluationOptions.mode,
      live: evaluationOptions.live,
      dryRun: evaluationOptions.dryRun,
      executeTask: evaluationOptions.executeTaskId ?? "none",
      provider: evaluationOptions.modelProvider ?? "deepseek",
      providerSource: evaluationOptions.modelProvider ? "explicit" : "default",
      ...(evaluationOptions.model ? { model: evaluationOptions.model } : {}),
      baselineId: evaluationOptions.baselineId,
      baselines: evaluation.baselines.map((baseline) => baseline.baselineId),
      output: outputMode,
      redaction: { class: "internal", fields: [] }
    },
    status: overallDeliveryCapability.status === "pass" ? "pass" : "blocked",
    scoringMethod: overallDeliveryCapability.scoringMethod,
    score: overallDeliveryCapability.score,
    targetScore: overallDeliveryCapability.targetScore,
    unfinishedPenaltyPerItem: overallDeliveryCapability.unfinishedPenaltyPerItem,
    unfinishedTargetCount: overallDeliveryCapability.unfinishedTargetCount,
    unfinishedTargetIds: overallDeliveryCapability.unfinishedTargetIds,
    passedTargetCount: overallDeliveryCapability.passedTargetCount,
    totalTargetCount: overallDeliveryCapability.totalTargetCount,
    dimensions: overallDeliveryCapability.dimensions,
    toolFamily: {
      score: overallDeliveryCapability.toolFamilyScore,
      passedFamilyCount: overallDeliveryCapability.toolFamilyPassedCount,
      totalFamilyCount: overallDeliveryCapability.toolFamilyTotalCount,
      gate: overallDeliveryCapability.toolFamilyGatePassed ? "pass" : "blocked",
      fakeCoveredFamilyCount: evaluation.toolFamilyParityMatrix?.fakeCoveredFamilyCount,
      replayedCoveredFamilyCount: evaluation.toolFamilyParityMatrix?.replayedCoveredFamilyCount,
      liveCoveredFamilyCount: evaluation.toolFamilyParityMatrix?.liveCoveredFamilyCount,
      taskCoveredFamilyCount: evaluation.toolFamilyParityMatrix?.taskCoveredFamilyCount,
      safetyCoveredFamilyCount: evaluation.toolFamilyParityMatrix?.safetyCoveredFamilyCount,
      providerNativeSupportedFamilyCount: evaluation.toolFamilyParityMatrix?.providerNativeSupportedFamilyCount,
      sourceEvidencePath: "tests/acceptance/latest/live-tool-coverage.json"
    },
    modeMatrix: {
      score: overallDeliveryCapability.modeScore,
      completedModeCount: overallDeliveryCapability.modeCompleteCount,
      totalModeCount: overallDeliveryCapability.modeTotalCount,
      gate: overallDeliveryCapability.modeGatePassed ? "pass" : "blocked",
      blockingModeIds: overallDeliveryCapability.blockingModeIds
    },
    packageScorecards: {
      score: overallDeliveryCapability.packageScore,
      passedPackageCount: overallDeliveryCapability.packagePassedCount,
      totalPackageCount: overallDeliveryCapability.packageTotalCount,
      gate: overallDeliveryCapability.packageGatePassed ? "pass" : "blocked",
      blockingPackageIds: overallDeliveryCapability.blockingPackageIds
    },
    evaluationTasks: {
      score: overallDeliveryCapability.evaluationTaskScore,
      solvedTaskCount: overallDeliveryCapability.evaluationTaskSolvedCount,
      totalTaskCount: overallDeliveryCapability.evaluationTaskTotalCount,
      gate: overallDeliveryCapability.evaluationTaskGatePassed ? "pass" : "blocked",
      blockingTaskIds: overallDeliveryCapability.blockingEvaluationTaskIds,
      taskRuns: evaluation.taskRuns
        .filter((run) => run.baseline.baselineId === "deepseek-cli")
        .map((run) => ({
          taskId: run.task.taskId,
          outcome: run.outcome,
          checkPassRate: run.metrics.checkPassRate,
          retryCount: run.metrics.retryCount,
          evidenceManifestStatus: run.metrics.evidenceManifestStatus,
          unsupportedClaimCount: run.metrics.unsupportedClaimCount,
          hallucinatedCommandCount: run.metrics.hallucinatedCommandCount,
          repairMetricsAvailability: run.metrics.repairMetricsAvailability,
          repairActivationCount: run.metrics.repairActivationCount,
          repairSuccessCount: run.metrics.repairSuccessCount
        }))
    },
    deepSeekApi: {
      score: overallDeliveryCapability.deepSeekApiScore,
      passedCount: overallDeliveryCapability.deepSeekApiPassedCount,
      totalCount: overallDeliveryCapability.deepSeekApiTotalCount,
      gate: overallDeliveryCapability.deepSeekApiGatePassed ? "pass" : "blocked"
    },
    memory: {
      score: overallDeliveryCapability.memoryScore,
      passedCount: overallDeliveryCapability.memoryPassedCount,
      totalCount: overallDeliveryCapability.memoryTotalCount,
      gate: overallDeliveryCapability.memoryGatePassed ? "pass" : "blocked"
    },
    cacheObservability: {
      score: overallDeliveryCapability.cacheObservabilityScore,
      passedCount: overallDeliveryCapability.cacheObservabilityPassedCount,
      totalCount: overallDeliveryCapability.cacheObservabilityTotalCount,
      gate: overallDeliveryCapability.cacheObservabilityGatePassed ? "pass" : "blocked"
    },
    blockingCapabilityIds: overallDeliveryCapability.blockingCapabilityIds,
    calculation: `max(0, 1 - ${overallDeliveryCapability.unfinishedTargetCount} unfinished targets * ${overallDeliveryCapability.unfinishedPenaltyPerItem})`,
    redaction: {
      class: "internal",
      fields: [
        "modeMatrix.blockingModeIds",
        "packageScorecards.blockingPackageIds",
        "evaluationTasks.blockingTaskIds",
        "dimensions.blockingIds",
        "blockingCapabilityIds",
        "unfinishedTargetIds"
      ]
    }
  };
}

function evaluationDeliveryCapabilityCommand(options: CliEvaluationOptions, outputMode: AgentLoopOutputMode): string {
  const args = [
    "npx",
    "tsx",
    "src/apps/cli/src/index.ts",
    "diagnostics",
    "evaluate"
  ];
  if (options.mode === "full") args.push("--full");
  if (options.executeTaskId) args.push("--execute-task", options.executeTaskId);
  if (options.live) args.push("--live");
  if (options.compareBaselineIds.length > 0) {
    for (const baselineId of options.compareBaselineIds) args.push("--compare-baseline", baselineId);
  } else if (options.baselineId !== "deepseek-cli") {
    args.push("--baseline", options.baselineId);
  }
  if (options.allowExternalBaseline) args.push("--allow-external-baseline");
  if (options.modelProvider) args.push("--provider", options.modelProvider);
  if (options.model) args.push("--model", options.model);
  args.push("--output", outputMode);
  return args.map(commandArg).join(" ");
}

function commandArg(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value);
}
