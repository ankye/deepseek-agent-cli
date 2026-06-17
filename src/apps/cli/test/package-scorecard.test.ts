import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PackageScorecardCriterionResult, PlatformRuntime } from "@deepseek/platform-contracts";
import { collectCliEvaluation, collectToolFamilyParityMatrix } from "../src/diagnostics/evaluation.js";
import { aggregatePackageScorecards, collectPackageScorecards, packageScorecardCatalog, summarizeCriterionResults } from "../src/diagnostics/package-scorecard.js";
import { coreToolExecutionCriterionId, liveFamilyCoverageTargets, liveToolCoverageTargets } from "../src/diagnostics/tool-live-coverage.js";
import { runCli } from "../src/index.js";

describe("package scorecard diagnostics", () => {
  it("scores package delivery capability without partial or missing credit", () => {
    const summary = summarizeCriterionResults({
      packageId: "example",
      packageName: "@deepseek/example",
      packagePath: "src/packages/example",
      role: "example",
      rubricIds: ["rubric.package.shared.v1"],
      evidencePaths: [],
      criteria: [
        criterion("criterion.pass", "pass", 2),
        criterion("criterion.partial", "partial", 2),
        criterion("criterion.fail", "fail", 1),
        criterion("criterion.not-assessed", "not_assessed", 1),
        criterion("criterion.not-applicable", "not_applicable", 99)
      ]
    });

    assert.equal(summary.weightedScore, 0.333);
    assert.equal(summary.objectiveScore, 0.266);
    assert.equal(summary.deliveryCapabilityScore, 0.266);
    assert.equal(summary.deliveryCapabilityTargetScore, 0.9);
    assert.equal(summary.deliveryCapabilityPassed, false);
    assert.equal(summary.passRate, 0.25);
    assert.equal(summary.assessmentCoverage, 0.75);
    assert.equal(summary.rubricCoverage, 0.8);
    assert.equal(summary.passedCriterionCount, 1);
    assert.equal(summary.partialCriterionCount, 1);
    assert.equal(summary.failedCriterionCount, 1);
    assert.equal(summary.notAssessedCriterionCount, 1);
    assert.equal(summary.readiness, "warn");
  });

  it("lets hard gates override a high weighted score", () => {
    const summary = summarizeCriterionResults({
      packageId: "example",
      packageName: "@deepseek/example",
      packagePath: "src/packages/example",
      role: "example",
      rubricIds: ["rubric.package.shared.v1"],
      evidencePaths: [],
      criteria: [
        criterion("criterion.quality", "pass", 10),
        criterion("criterion.hard-gate", "fail", 1, true)
      ]
    });

    assert.equal(summary.weightedScore, 0.909);
    assert.equal(summary.objectiveScore, 0);
    assert.equal(summary.deliveryCapabilityScore, 0);
    assert.equal(summary.deliveryCapabilityPassed, false);
    assert.equal(summary.hardGateStatus, "fail");
    assert.equal(summary.readiness, "fail");
    assert.equal(summary.hardGates[0]?.gateId, "criterion.hard-gate");
  });

  it("collects package scorecards for every workspace package", async () => {
    const result = await collectPackageScorecards();
    const runtime = result.scorecards.find((scorecard) => scorecard.packageId === "runtime");

    assert.equal(result.catalogVersion, packageScorecardCatalog.catalogVersion);
    assert.equal(result.scorecards.length >= 29, true);
    assert.equal(result.aggregate.totalPackageCount, result.scorecards.length);
    assert.equal(result.scorecards.every((scorecard) => typeof scorecard.deliveryCapabilityScore === "number"), true);
    assert.equal(result.aggregate.deliveryCapabilityTotalPackageCount, result.scorecards.length);
    assert.equal(result.aggregate.deliveryCapabilityPassedPackageCount, result.aggregate.deliveryCapabilityTotalPackageCount);
    assert.equal(result.aggregate.deliveryCapabilityPassed, true);
    assert.equal(result.aggregate.averageDeliveryCapabilityScore, 1);
    assert.equal(result.aggregate.averageObjectiveScore, 1);
    assert.equal(result.aggregate.averageWeightedScore, 1);
    assert.equal(result.aggregate.averageRubricCoverage, 1);
    assert.equal(runtime?.rubricIds.includes("rubric.package.runtime.v1"), true);
    assert.equal(runtime?.criteria.some((criterionResult) => criterionResult.criterionId === "runtime.tool-feedback-tests" && criterionResult.status === "pass"), true);
  });

  it("requires live model tool coverage before core tools can score above 90 percent", () => {
    assert.equal(liveToolCoverageTargets.length, 20);
    assert.equal(liveFamilyCoverageTargets.length >= 64, true);

    const shared = sharedPassCriteria();
    const missingLive = summarizeCriterionResults({
      packageId: "core-coding-tools",
      packageName: "@deepseek/core-coding-tools",
      packagePath: "src/packages/core-coding-tools",
      role: "core-coding-tools",
      rubricIds: ["rubric.package.shared.v1", "rubric.package.core-coding-tools.v1"],
      evidencePaths: [],
      criteria: [
        ...shared,
        criterion("package.delivery.core-coding-tools.acceptance-evidence", "pass", 3),
        ...liveToolCoverageTargets.map((target) => criterion(coreToolExecutionCriterionId(target.toolId), "not_assessed", 2))
      ]
    });
    const eighteenOfTwenty = summarizeCriterionResults({
      packageId: "core-coding-tools",
      packageName: "@deepseek/core-coding-tools",
      packagePath: "src/packages/core-coding-tools",
      role: "core-coding-tools",
      rubricIds: ["rubric.package.shared.v1", "rubric.package.core-coding-tools.v1"],
      evidencePaths: [],
      criteria: [
        ...shared,
        criterion("package.delivery.core-coding-tools.acceptance-evidence", "pass", 3),
        ...liveToolCoverageTargets.map((target, index) => criterion(coreToolExecutionCriterionId(target.toolId), index < 18 ? "pass" : "fail", 2))
      ]
    });

    assert.equal(missingLive.objectiveScore, 0.298);
    assert.equal(missingLive.deliveryCapabilityScore, 0.298);
    assert.equal(missingLive.deliveryCapabilityPassed, false);
    assert.equal(missingLive.notAssessedCriterionCount, 20);
    assert.equal((eighteenOfTwenty.objectiveScore ?? 0) >= 0.9, true);
    assert.equal(eighteenOfTwenty.objectiveScore, 0.93);
    assert.equal(eighteenOfTwenty.deliveryCapabilityScore, 0.93);
    assert.equal(eighteenOfTwenty.deliveryCapabilityPassed, true);
  });

  it("includes package scorecards in diagnostics evaluate JSON and JSONL output", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "evaluate", "--full", "--dry-run", "--output", "jsonl"], (line: string) => {
      lines.push(line);
    });
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      aggregate?: {
        totalPackageCount?: number;
        averageObjectiveScore?: number;
        averageDeliveryCapabilityScore?: number;
        deliveryCapabilityTargetScore?: number;
        deliveryCapabilityPassedPackageCount?: number;
        deliveryCapabilityTotalPackageCount?: number;
        deliveryCapabilityPassed?: boolean;
      };
      scorecard?: { packageId?: string; readiness?: string; deliveryCapabilityScore?: number; deliveryCapabilityPassed?: boolean };
      matrix?: {
        totalFamilyCount?: number;
        implementedFamilyCount?: number;
        objectiveScore?: number;
        deliveryCapabilityScore?: number;
        deliveryCapabilityTargetScore?: number;
        deliveryCapabilityPassed?: boolean;
        deliveryCapabilityTargetFamilyCount?: number;
        deliveryCapabilityPassedFamilyCount?: number;
        deliveryCapabilityBlockingFamilyIds?: readonly string[];
        liveCoveredFamilyCount?: number;
        modeDeliveryCapabilityScore?: number;
        modeDeliveryCapabilityCompletedCount?: number;
        modeDeliveryCapabilityTotalCount?: number;
      };
      deliveryCapability?: {
        score?: number;
        targetScore?: number;
        scoringMethod?: string;
        unfinishedPenaltyPerItem?: number;
        unfinishedTargetCount?: number;
        passedTargetCount?: number;
        totalTargetCount?: number;
        toolFamilyScore?: number;
        toolFamilyPassedCount?: number;
        toolFamilyTotalCount?: number;
        modeScore?: number;
        packageScore?: number;
        evaluationTaskScore?: number;
        evaluationTaskSolvedCount?: number;
        evaluationTaskTotalCount?: number;
        deepSeekApiScore?: number;
        deepSeekApiPassedCount?: number;
        deepSeekApiTotalCount?: number;
        memoryScore?: number;
        memoryPassedCount?: number;
        memoryTotalCount?: number;
        cacheObservabilityScore?: number;
        cacheObservabilityPassedCount?: number;
        cacheObservabilityTotalCount?: number;
        blockingFamilyIds?: readonly string[];
        blockingCapabilityIds?: readonly string[];
        unfinishedTargetIds?: readonly string[];
        packagePassedCount?: number;
        packageTotalCount?: number;
        status?: string;
      };
    });

    assert.equal(records.some((record) => record.kind === "diagnostics.evaluate.package-scorecard-aggregate" && (record.aggregate?.totalPackageCount ?? 0) >= 29 && record.aggregate?.averageDeliveryCapabilityScore === 1 && record.aggregate?.deliveryCapabilityTargetScore === 0.9 && record.aggregate?.deliveryCapabilityPassed === true), true);
    assert.equal(records.some((record) => record.kind === "diagnostics.evaluate.package-scorecard" && record.scorecard?.packageId === "runtime" && typeof record.scorecard.deliveryCapabilityScore === "number"), true);
    const parity = records.find((record) => record.kind === "diagnostics.evaluate.tool-family-parity")?.matrix;
    assert.equal(parity?.totalFamilyCount, liveFamilyCoverageTargets.length);
    assert.equal(parity?.implementedFamilyCount, liveFamilyCoverageTargets.length);
    assert.equal(parity?.deliveryCapabilityTargetFamilyCount, Math.ceil((parity?.totalFamilyCount ?? 0) * (parity?.deliveryCapabilityTargetScore ?? 0)));
    assert.equal((parity?.liveCoveredFamilyCount ?? 0) <= (parity?.totalFamilyCount ?? 0), true);
    if ((parity?.liveCoveredFamilyCount ?? 0) < (parity?.totalFamilyCount ?? 0)) {
      assert.equal((parity?.deliveryCapabilityBlockingFamilyIds?.length ?? 0) > 0, true);
    }
    assert.equal(records.some((record) => record.kind === "diagnostics.mode-matrix.summary" && record.matrix?.modeDeliveryCapabilityScore === 1 && record.matrix.modeDeliveryCapabilityCompletedCount === 20 && record.matrix.modeDeliveryCapabilityTotalCount === 20), true);
    const delivery = records.find((record) => record.kind === "diagnostics.delivery-capability.summary")?.deliveryCapability;
    assert.equal(delivery?.toolFamilyScore, parity?.deliveryCapabilityScore);
    assert.equal(delivery?.toolFamilyPassedCount, parity?.deliveryCapabilityPassedFamilyCount);
    assert.equal(delivery?.toolFamilyTotalCount, parity?.totalFamilyCount);
    assert.deepEqual(delivery?.blockingFamilyIds, (parity?.deliveryCapabilityBlockingFamilyIds ?? []).map(String));
    assert.equal(delivery?.unfinishedTargetCount, delivery?.unfinishedTargetIds?.length);
    assert.equal(records.some((record) => record.kind === "diagnostics.delivery-capability.summary"
      && typeof record.deliveryCapability?.score === "number"
      && record.deliveryCapability.targetScore === 0.9
      && record.deliveryCapability.scoringMethod === "unfinished-penalty"
      && record.deliveryCapability.unfinishedPenaltyPerItem === 0.1
      && record.deliveryCapability.unfinishedTargetCount === record.deliveryCapability.unfinishedTargetIds?.length
      && record.deliveryCapability.toolFamilyScore === parity?.deliveryCapabilityScore
      && record.deliveryCapability.modeScore === 1
      && record.deliveryCapability.packageScore === 1
      && record.deliveryCapability.evaluationTaskScore === 0
      && record.deliveryCapability.evaluationTaskSolvedCount === 0
      && record.deliveryCapability.evaluationTaskTotalCount === 9
      && record.deliveryCapability.deepSeekApiScore === 1
      && record.deliveryCapability.deepSeekApiPassedCount === 11
      && record.deliveryCapability.deepSeekApiTotalCount === 11
      && record.deliveryCapability.memoryScore === 1
      && record.deliveryCapability.memoryPassedCount === 16
      && record.deliveryCapability.memoryTotalCount === 16
      && record.deliveryCapability.cacheObservabilityScore === 1
      && record.deliveryCapability.cacheObservabilityPassedCount === 4
      && record.deliveryCapability.cacheObservabilityTotalCount === 4
      && record.deliveryCapability.blockingCapabilityIds?.length === 0
      && record.deliveryCapability.status === "blocked"), true);
  });

  it("includes package scorecard aggregates in direct evaluation summaries", async () => {
    const summary = await collectCliEvaluation({
      mode: "full",
      dryRun: true,
      live: false,
      baselineId: "deepseek-cli",
      compareBaselineIds: [],
      allowExternalBaseline: false,
      baselineArgs: [],
      extraArgs: []
    });

    assert.equal(summary.packageScorecardCatalogVersion, packageScorecardCatalog.catalogVersion);
    assert.equal((summary.packageScorecards?.length ?? 0) >= 29, true);
    assert.equal(summary.packageScorecardAggregate?.totalPackageCount, summary.packageScorecards?.length);
    assert.equal(summary.packageScorecardAggregate?.deliveryCapabilityTotalPackageCount, summary.packageScorecards?.length);
    assert.equal(summary.packageScorecardAggregate?.deliveryCapabilityPassed, true);
    assert.equal(summary.packageScorecardAggregate?.averageDeliveryCapabilityScore, 1);
    assert.equal(summary.toolFamilyParityMatrix?.totalFamilyCount, liveFamilyCoverageTargets.length);
    assert.equal(summary.toolFamilyParityMatrix?.implementedFamilyCount, liveFamilyCoverageTargets.length);
    assert.equal(summary.toolFamilyParityMatrix?.deliveryCapabilityTargetFamilyCount, Math.ceil((summary.toolFamilyParityMatrix?.totalFamilyCount ?? 0) * (summary.toolFamilyParityMatrix?.deliveryCapabilityTargetScore ?? 0)));
    assert.equal((summary.toolFamilyParityMatrix?.objectiveScore ?? 0) <= 1, true);
    assert.equal((summary.toolFamilyParityMatrix?.deliveryCapabilityScore ?? 0) <= 1, true);
    assert.equal(summary.toolFamilyParityMatrix?.deliveryCapabilityPassed, (summary.toolFamilyParityMatrix?.deliveryCapabilityScore ?? 0) >= (summary.toolFamilyParityMatrix?.deliveryCapabilityTargetScore ?? 1) && (summary.toolFamilyParityMatrix?.deliveryCapabilityPassedFamilyCount ?? 0) >= (summary.toolFamilyParityMatrix?.deliveryCapabilityTargetFamilyCount ?? Infinity));
    if ((summary.toolFamilyParityMatrix?.liveCoveredFamilyCount ?? 0) < (summary.toolFamilyParityMatrix?.totalFamilyCount ?? 0)) {
      assert.equal((summary.toolFamilyParityMatrix?.deliveryCapabilityBlockingFamilyIds.length ?? 0) > 0, true);
    }
  });

  it("does not count replay-only evidence as live product readiness", async () => {
    const replayOnlyPlatform = {
      readFile: async (path: string) => {
        if (path.endsWith("live-tool-coverage-replay.json")) {
          return JSON.stringify({
            schemaVersion: "1.1.0",
            kind: "deepseek.live-tool-coverage",
            generatedAt: "1970-01-01T00:00:00.000Z",
            provider: "deepseek",
            model: "deepseek-test",
            summary: { replayOnly: true },
            records: liveFamilyCoverageTargets.map((target) => ({
              toolId: target.toolId,
              familyId: target.familyId,
              safeName: target.safeName,
              status: "pass",
              model: { replay: true },
              preflight: { status: "pass" },
              execution: { status: "pass" },
              continuation: { status: "pass" },
              taskOutcome: { status: "pass" },
              safetyOutcome: { status: "pass" },
              providerNative: { status: "native" },
              diagnostics: []
            }))
          });
        }
        throw new Error(`live evidence intentionally unavailable: ${path}`);
      }
    } as unknown as PlatformRuntime;

    const matrix = await collectToolFamilyParityMatrix(replayOnlyPlatform);

    assert.equal(matrix.liveCoveredFamilyCount, 0);
    assert.equal(matrix.deliveryCapabilityScore, 0);
    assert.equal(matrix.deliveryCapabilityPassed, false);
    assert.equal(matrix.deliveryCapabilityBlockingFamilyIds.length, matrix.totalFamilyCount);
  });

  it("keeps package scorecard release evidence advisory", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "release", "--output", "json"], (line: string) => {
      lines.push(line);
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      status?: string;
      release?: {
        status?: string;
        packageScorecardAdvisory?: {
          advisoryOnly?: boolean;
          aggregate?: { totalPackageCount?: number; averageObjectiveScore?: number; averageDeliveryCapabilityScore?: number };
        };
      };
    };

    assert.equal(parsed.status, parsed.release?.status);
    assert.equal(parsed.release?.packageScorecardAdvisory?.advisoryOnly, true);
    assert.equal((parsed.release?.packageScorecardAdvisory?.aggregate?.totalPackageCount ?? 0) >= 29, true);
    assert.equal(parsed.release?.packageScorecardAdvisory?.aggregate?.averageDeliveryCapabilityScore, 1);
  });

  it("derives platform aggregate counts from package readiness", () => {
    const pass = summarizeCriterionResults({
      packageId: "pass",
      packageName: "@deepseek/pass",
      packagePath: "src/packages/pass",
      role: "pass",
      rubricIds: ["rubric.package.shared.v1"],
      evidencePaths: [],
      criteria: [criterion("criterion.pass", "pass", 1)]
    });
    const fail = summarizeCriterionResults({
      packageId: "fail",
      packageName: "@deepseek/fail",
      packagePath: "src/packages/fail",
      role: "fail",
      rubricIds: ["rubric.package.shared.v1"],
      evidencePaths: [],
      criteria: [criterion("criterion.hard-gate", "fail", 1, true)]
    });
    const aggregate = aggregatePackageScorecards([pass, fail]);

    assert.equal(aggregate.totalPackageCount, 2);
    assert.equal(aggregate.passPackageCount, 1);
    assert.equal(aggregate.failPackageCount, 1);
    assert.equal(aggregate.hardGateFailureCount, 1);
    assert.equal(aggregate.averageObjectiveScore, 0.5);
    assert.equal(aggregate.averageDeliveryCapabilityScore, 0.5);
    assert.equal(aggregate.deliveryCapabilityPassedPackageCount, 1);
    assert.equal(aggregate.deliveryCapabilityTotalPackageCount, 2);
    assert.deepEqual(aggregate.deliveryCapabilityBlockingPackageIds, ["fail"]);
    assert.equal(aggregate.deliveryCapabilityPassed, false);
  });
});

function criterion(
  criterionId: string,
  status: PackageScorecardCriterionResult["status"],
  weight: number,
  hardGate = false
): PackageScorecardCriterionResult {
  const score = status === "not_applicable" ? undefined : status === "pass" ? 1 : 0;
  return {
    criterionId,
    title: criterionId,
    category: "maintainability",
    status,
    ...(score !== undefined ? { score } : {}),
    weight,
    required: hardGate,
    hardGate,
    evidence: [{ kind: "catalog", ref: "test", status, redaction: { class: "internal", fields: ["ref"] } }],
    diagnostics: [],
    redaction: { class: "internal", fields: ["evidence.ref"] }
  };
}

function sharedPassCriteria(): readonly PackageScorecardCriterionResult[] {
  return [
    criterion("package.manifest.present", "pass", 2, true),
    criterion("package.manifest.public-export", "pass", 2, true),
    criterion("package.source-index.present", "pass", 2, true),
    criterion("package.workspace-name.matches-path", "pass", 2, true),
    criterion("package.internal-dependencies.versioned", "pass", 2, true),
    criterion("package.test-evidence.present", "pass", 1),
    criterion("package.secret-source-scan.clean", "pass", 3, true)
  ];
}
