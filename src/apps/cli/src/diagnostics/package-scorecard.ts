import { basename, dirname, relative } from "node:path";
import type {
  JsonObject,
  PackageScorecardAggregate,
  PackageScorecardCatalog,
  PackageScorecardCriterionDefinition,
  PackageScorecardCriterionResult,
  PackageScorecardCriterionStatus,
  PackageScorecardDiagnostic,
  PackageScorecardEvidenceKind,
  PackageScorecardEvidenceRef,
  PackageScorecardHardGateResult,
  PackageScorecardHardGateStatus,
  PackageScorecardReleaseAdvisory,
  PackageScorecardRubric,
  PackageScorecardSummary,
  PlatformRuntime,
  ReadinessStatus
} from "@deepseek/platform-contracts";
import { PACKAGE_SCORECARD_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import { NodePlatformRuntime } from "@deepseek/platform-abstraction";
import {
  coreToolExecutionCriterionId,
  coreToolLiveExecutionCriterionDefinitions,
  liveToolCoverageEvidencePath,
  liveToolCoverageRecordFor,
  liveToolCoverageTargets,
  readLiveToolCoverageEvidence,
  toolIntentLivePreflightCriterionDefinitions,
  toolIntentPreflightCriterionId
} from "./tool-live-coverage.js";

interface PackageManifest extends JsonObject {
  readonly name?: string;
  readonly exports?: JsonObject;
  readonly dependencies?: JsonObject;
  readonly devDependencies?: JsonObject;
}

interface WorkspacePackage {
  readonly role: string;
  readonly packageName: string;
  readonly packagePath: string;
  readonly packageRoot: string;
  readonly manifestPath: string;
  readonly manifest: PackageManifest;
}

interface EvaluationContext {
  readonly platform: PlatformRuntime;
  readonly workspaceRoot: string;
  readonly pkg: WorkspacePackage;
}

const roleAcceptanceEvidenceByRole: Readonly<Record<string, readonly string[]>> = {
  "agent-management": ["tests/contracts/agent-management-modes.test.ts", "tests/contracts/agent-spawn.test.ts"],
  "capability-registry": ["tests/contracts/capability-registry-hardening.test.ts"],
  "code-intelligence": ["src/packages/code-intelligence/src/index.test.ts", "tests/contracts/code-intelligence-contracts.test.ts", "tests/matrix/code-intelligence-matrix.test.ts"],
  "command-system": ["src/packages/command-system/test/interactive-controls.test.ts", "tests/contracts/command-composition.test.ts"],
  "communication-protocol": ["src/packages/communication-protocol/test/protocol.test.ts"],
  "concurrency-orchestration": ["src/packages/concurrency-orchestration/test/scheduler.test.ts"],
  "config": ["src/packages/config/test/config-service.test.ts", "tests/contracts/persistent-config-auth-contracts.test.ts"],
  "context-engine": ["src/packages/context-engine/src/index.test.ts", "tests/contracts/context-engine-cache.test.ts", "tests/matrix/context-projection-matrix.test.ts"],
  "core-coding-tools": ["src/packages/core-coding-tools/src/index.test.ts", "tests/contracts/core-coding-tools-contracts.test.ts"],
  "credential-auth-management": ["tests/contracts/extension-auth-boundaries.test.ts", "tests/contracts/persistent-config-auth-contracts.test.ts"],
  "first-party-dev-plugins": ["tests/contracts/first-party-dev-plugins.test.ts", "tests/contracts/first-party-dev-workflows.test.ts"],
  "hook-system": ["src/packages/hook-system/src/index.test.ts", "tests/contracts/hook-system-contracts.test.ts", "tests/integration/hook-system-invocation.test.ts"],
  "index-provider": ["tests/contracts/index-provider-contracts.test.ts", "tests/e2e/local-readiness-cli.test.ts"],
  "mcp-gateway": ["src/packages/mcp-gateway/src/index.test.ts", "tests/contracts/mcp-gateway-contracts.test.ts", "tests/matrix/mcp-gateway-matrix.test.ts"],
  "memory-cache-management": ["tests/contracts/memory-cache-management.test.ts"],
  "model-gateway": ["src/packages/model-gateway/test/deepseek-provider.test.ts", "src/packages/model-gateway/test/deepseek-partial-tool-calls.test.ts"],
  "observability": ["src/packages/observability/src/index.test.ts", "tests/contracts/observability-privacy-contracts.test.ts", "tests/integration/observability-privacy-runtime.test.ts"],
  "platform-abstraction": ["tests/contracts/cross-platform-runtime-contracts.test.ts", "tests/contracts/remote-identity-fixtures.test.ts", "tests/matrix/fake-platforms.test.ts"],
  "platform-contracts": ["src/packages/platform-contracts/test/dependency-boundary.test.ts", "src/packages/platform-contracts/test/package-scorecard-contracts.test.ts", "tests/contracts/package-boundaries.test.ts"],
  builtin: ["tests/contracts/builtin-plugin-registry.test.ts"],
  "plugin-api": ["tests/contracts/plugin-api.test.ts", "tests/contracts/plugin-platform-foundation.test.ts"],
  "plugin-system": ["tests/contracts/plugin-api.test.ts", "tests/contracts/plugin-platform-foundation.test.ts"],
  "policy-sandbox": ["src/packages/policy-sandbox/src/index.test.ts", "tests/contracts/secret-sandbox-hardening-contracts.test.ts", "tests/matrix/secret-sandbox-matrix.test.ts"],
  "prompt-assembly": ["src/packages/prompt-assembly/test/prompt-assembly.test.ts"],
  "runtime": ["src/packages/runtime/test/runtime.test.ts", "src/packages/runtime/test/runtime-tool-feedback.test.ts", "tests/integration/runtime-pipeline.test.ts"],
  "runtime-message-bus": ["src/packages/runtime-message-bus/test/bus.test.ts", "tests/golden/runtime-kernel-replay.test.ts"],
  "session-store": ["src/packages/session-store/src/index.test.ts", "tests/contracts/session-store-resume-fork.test.ts", "tests/integration/session-resume-fork-runtime.test.ts"],
  "skill-system": ["src/packages/skill-system/src/index.test.ts", "tests/contracts/skill-system-contracts.test.ts", "tests/matrix/skill-system-matrix.test.ts"],
  "task-profiles": ["src/packages/task-profiles/test/profile-compiler.test.ts", "tests/contracts/task-profile-catalog.test.ts"],
  "testing-regression": ["src/packages/testing-regression/src/family-evidence/index.test.ts", "tests/integration/live-factory-real-fs.test.ts"],
  "tool-intent-preflight": ["src/packages/tool-intent-preflight/test/preflight.test.ts", "tests/matrix/live-tool-preflight.test.ts"],
  "usage-budget-management": ["src/packages/usage-budget-management/src/index.test.ts"],
  "workflow-orchestration": ["src/packages/workflow-orchestration/test/workflow.test.ts"],
  "workspace-state-management": ["src/packages/workspace-state-management/src/index.test.ts", "tests/matrix/checkpoint-undo-matrix.test.ts"]
};

export const packageScorecardCatalog: PackageScorecardCatalog = {
  schemaVersion: PACKAGE_SCORECARD_SCHEMA_VERSION,
  catalogVersion: "2026-05-15.v1",
  sharedRubricId: "rubric.package.shared.v1",
  rubrics: [
    rubric("rubric.package.shared.v1", "*", [
      "package.manifest.present",
      "package.manifest.public-export",
      "package.source-index.present",
      "package.workspace-name.matches-path",
      "package.internal-dependencies.versioned",
      "package.test-evidence.present",
      "package.secret-source-scan.clean"
    ]),
    rubric("rubric.package.platform-contracts.v1", "platform-contracts", [
      roleAcceptanceCriterionId("platform-contracts"),
      "platform-contracts.no-implementation-imports",
      "platform-contracts.no-host-api-imports",
      "platform-contracts.contract-tests-present"
    ]),
    rubric("rubric.package.model-gateway.v1", "model-gateway", [
      roleAcceptanceCriterionId("model-gateway"),
      "model-gateway.tool-call-protocol-tests",
      "model-gateway.no-runtime-imports",
      "model-gateway.partial-tool-call-tests"
    ]),
    rubric("rubric.package.runtime.v1", "runtime", [
      roleAcceptanceCriterionId("runtime"),
      "runtime.tool-feedback-tests",
      "runtime.preflight-policy-integration",
      "runtime.replayable-events"
    ]),
    rubric("rubric.package.core-coding-tools.v1", "core-coding-tools", [
      roleAcceptanceCriterionId("core-coding-tools"),
      ...liveToolCoverageTargets.map((item) => coreToolExecutionCriterionId(item.toolId))
    ]),
    rubric("rubric.package.tool-intent-preflight.v1", "tool-intent-preflight", [
      roleAcceptanceCriterionId("tool-intent-preflight"),
      ...liveToolCoverageTargets.map((item) => toolIntentPreflightCriterionId(item.toolId))
    ]),
    ...roleAcceptanceRubrics()
  ],
  criteria: [
    criterion("package.manifest.present", "Package manifest exists", "contract", 2, true, true, ["*"], "src/packages/<name>/package.json or src/plugins/<name>/package.json"),
    criterion("package.manifest.public-export", "Package public export points at src/index.ts", "contract", 2, true, true, ["*"], "package.json exports[\".\"]"),
    criterion("package.source-index.present", "Package source index exists", "maintainability", 2, true, true, ["*"], "src/index.ts"),
    criterion("package.workspace-name.matches-path", "Package name matches workspace path", "boundary", 2, true, true, ["*"], "@deepseek/<workspace>"),
    criterion("package.internal-dependencies.versioned", "Internal package dependencies use local semver", "boundary", 2, true, true, ["*"], "package.json dependencies"),
    criterion("package.test-evidence.present", "Package has focused test evidence", "testing", 1, false, false, ["*"], "*.test.ts under package"),
    criterion("package.secret-source-scan.clean", "Package source has no literal secret values", "security", 3, true, true, ["*"], "non-test source scan"),
    criterion("platform-contracts.no-implementation-imports", "Contracts do not import implementation packages", "role", 3, true, true, ["platform-contracts"], "platform-contracts source imports"),
    criterion("platform-contracts.no-host-api-imports", "Contracts remain host agnostic", "role", 3, true, true, ["platform-contracts"], "platform-contracts host API imports"),
    criterion("platform-contracts.contract-tests-present", "Contracts expose contract test evidence", "role", 1, false, false, ["platform-contracts"], "platform-contracts test files"),
    criterion("model-gateway.tool-call-protocol-tests", "Model gateway tests tool call continuation protocol", "role", 3, true, false, ["model-gateway"], "deepseek-provider tests"),
    criterion("model-gateway.no-runtime-imports", "Model gateway does not own runtime execution", "role", 3, true, true, ["model-gateway"], "model-gateway source imports"),
    criterion("model-gateway.partial-tool-call-tests", "Model gateway tests partial streaming tool calls", "role", 1, false, false, ["model-gateway"], "deepseek partial tool call tests"),
    criterion("runtime.tool-feedback-tests", "Runtime tests tool feedback loop closure", "role", 3, true, false, ["runtime"], "runtime tool feedback tests"),
    criterion("runtime.preflight-policy-integration", "Runtime integrates tool preflight and policy path", "role", 3, true, false, ["runtime"], "runtime source and tests"),
    criterion("runtime.replayable-events", "Runtime emits replayable loop events", "role", 2, true, false, ["runtime"], "runtime event tests"),
    ...roleAcceptanceCriterionDefinitions(),
    ...coreToolLiveExecutionCriterionDefinitions(),
    ...toolIntentLivePreflightCriterionDefinitions()
  ],
  redaction: { class: "internal", fields: ["criteria.evidenceHint"] }
};

export async function collectPackageScorecards(platform: PlatformRuntime = new NodePlatformRuntime()): Promise<{
  readonly catalogVersion: string;
  readonly scorecards: readonly PackageScorecardSummary[];
  readonly aggregate: PackageScorecardAggregate;
}> {
  const workspaceRoot = process.cwd();
  const workspaceRoots = [
    platform.resolvePath(workspaceRoot, "src", "packages"),
    platform.resolvePath(workspaceRoot, "src", "plugins")
  ];
  const packages = await discoverWorkspacePackages(platform, workspaceRoot, workspaceRoots);
  const scorecards = await Promise.all(packages.map((pkg) => scorePackage({ platform, workspaceRoot, pkg })));
  return {
    catalogVersion: packageScorecardCatalog.catalogVersion,
    scorecards,
    aggregate: aggregatePackageScorecards(scorecards)
  };
}

export function releasePackageScorecardAdvisory(aggregate: PackageScorecardAggregate, scorecards: readonly PackageScorecardSummary[]): PackageScorecardReleaseAdvisory {
  const failing = scorecards.flatMap((scorecard) => scorecard.hardGates.filter((gate) => gate.status === "fail").map((gate) => ({ scorecard, gate })));
  return {
    schemaVersion: PACKAGE_SCORECARD_SCHEMA_VERSION,
    kind: "package.scorecard.release-advisory",
    advisoryOnly: true,
    status: failing.length > 0 ? "warn" : aggregate.failPackageCount > 0 ? "warn" : "pass",
    aggregate,
    evidencePaths: scorecards.flatMap((scorecard) => scorecard.evidencePaths),
    diagnostics: failing.map(({ scorecard, gate }) => diagnostic(
      "PACKAGE_SCORECARD_RELEASE_HARD_GATE",
      "warn",
      `${scorecard.packageName} package scorecard hard gate failed: ${gate.gateId}.`,
      { packageId: scorecard.packageId, gateId: gate.gateId }
    )),
    redaction: { class: "internal", fields: ["evidencePaths", "diagnostics.metadata"] }
  };
}

export function aggregatePackageScorecards(scorecards: readonly PackageScorecardSummary[]): PackageScorecardAggregate {
  const weightedScores = scorecards.map((scorecard) => scorecard.weightedScore).filter(isNumber);
  const objectiveScores = scorecards.map((scorecard) => scorecard.objectiveScore).filter(isNumber);
  const deliveryCapabilityScores = scorecards.map((scorecard) => scorecard.deliveryCapabilityScore).filter(isNumber);
  const passRates = scorecards.map((scorecard) => scorecard.passRate).filter(isNumber);
  const deliveryCapabilityBlockingPackageIds = scorecards.filter((scorecard) => !scorecard.deliveryCapabilityPassed).map((scorecard) => scorecard.packageId);
  return {
    schemaVersion: PACKAGE_SCORECARD_SCHEMA_VERSION,
    kind: "package.scorecard.aggregate",
    catalogVersion: packageScorecardCatalog.catalogVersion,
    totalPackageCount: scorecards.length,
    passPackageCount: scorecards.filter((scorecard) => scorecard.readiness === "pass").length,
    warnPackageCount: scorecards.filter((scorecard) => scorecard.readiness === "warn").length,
    failPackageCount: scorecards.filter((scorecard) => scorecard.readiness === "fail").length,
    ...(weightedScores.length > 0 ? { averageWeightedScore: roundRatio(average(weightedScores)) } : {}),
    ...(objectiveScores.length > 0 ? { averageObjectiveScore: roundRatio(average(objectiveScores)) } : {}),
    ...(deliveryCapabilityScores.length > 0 ? { averageDeliveryCapabilityScore: roundRatio(average(deliveryCapabilityScores)) } : {}),
    deliveryCapabilityTargetScore: packageDeliveryCapabilityTargetScore,
    deliveryCapabilityPassedPackageCount: scorecards.filter((scorecard) => scorecard.deliveryCapabilityPassed).length,
    deliveryCapabilityTotalPackageCount: scorecards.length,
    deliveryCapabilityBlockingPackageIds,
    deliveryCapabilityPassed: deliveryCapabilityBlockingPackageIds.length === 0 && scorecards.length > 0,
    ...(passRates.length > 0 ? { averagePassRate: roundRatio(average(passRates)) } : {}),
    averageAssessmentCoverage: roundRatio(average(scorecards.map((scorecard) => scorecard.assessmentCoverage))),
    averageRubricCoverage: roundRatio(average(scorecards.map((scorecard) => scorecard.rubricCoverage))),
    hardGateFailureCount: scorecards.filter((scorecard) => scorecard.hardGateStatus === "fail").length,
    packageScorecardIds: scorecards.map((scorecard) => scorecard.scorecardId),
    redaction: { class: "internal" }
  };
}

export function summarizeCriterionResults(input: {
  readonly packageId: string;
  readonly packageName: string;
  readonly packagePath: string;
  readonly role: string;
  readonly rubricIds: readonly string[];
  readonly criteria: readonly PackageScorecardCriterionResult[];
  readonly evidencePaths: readonly string[];
}): PackageScorecardSummary {
  const applicable = input.criteria.filter((item) => item.status !== "not_applicable");
  const assessed = applicable.filter((item) => item.status === "pass" || item.status === "partial" || item.status === "fail");
  const weightedDenominator = applicable.reduce((sum, item) => sum + item.weight, 0);
  const weightedNumerator = applicable.reduce((sum, item) => sum + strictScoreForStatus(item.status) * item.weight, 0);
  const passCount = assessed.filter((item) => item.status === "pass").length;
  const partialCount = assessed.filter((item) => item.status === "partial").length;
  const failCount = assessed.filter((item) => item.status === "fail").length;
  const notAssessedCount = applicable.filter((item) => item.status === "not_assessed").length;
  const hardGates = input.criteria.filter((item) => item.hardGate && item.status !== "not_applicable").map(hardGateFromCriterion);
  const hardGateStatus = hardGates.some((gate) => gate.status === "fail")
    ? "fail"
    : hardGates.some((gate) => gate.status === "not_assessed")
      ? "not_assessed"
      : "pass";
  const weightedScore = weightedDenominator > 0 ? roundRatio(weightedNumerator / weightedDenominator) : undefined;
  const rubricCoverage = rubricCoverageFor(input.rubricIds, input.criteria, applicable);
  const objectiveScore = weightedScore === undefined ? undefined : hardGateStatus === "pass" ? roundRatio(weightedScore * rubricCoverage) : 0;
  const deliveryCapabilityScore = objectiveScore;
  const deliveryCapabilityPassed = deliveryCapabilityScore !== undefined && deliveryCapabilityScore >= packageDeliveryCapabilityTargetScore && hardGateStatus === "pass";
  const passRate = applicable.length > 0 ? roundRatio(passCount / applicable.length) : undefined;
  const assessmentCoverage = applicable.length > 0 ? roundRatio(assessed.length / applicable.length) : 0;
  const readiness = packageReadiness(hardGateStatus, objectiveScore);
  const diagnostics = [
    ...(hardGateStatus === "fail" ? [diagnostic("PACKAGE_SCORECARD_HARD_GATE_FAILED", "error", `${input.packageName} has one or more failing hard gates.`)] : []),
    ...(notAssessedCount > 0 ? [diagnostic("PACKAGE_SCORECARD_NOT_ASSESSED", "warn", `${input.packageName} has ${notAssessedCount} unassessed applicable criterion result(s).`)] : [])
  ];

  return {
    schemaVersion: PACKAGE_SCORECARD_SCHEMA_VERSION,
    kind: "package.scorecard.summary",
    scorecardId: `package-scorecard:${input.packageId}`,
    packageId: input.packageId,
    packageName: input.packageName,
    packagePath: input.packagePath,
    role: input.role,
    catalogVersion: packageScorecardCatalog.catalogVersion,
    rubricIds: input.rubricIds,
    criteria: input.criteria,
    hardGates,
    hardGateStatus,
    ...(weightedScore !== undefined ? { weightedScore } : {}),
    ...(objectiveScore !== undefined ? { objectiveScore } : {}),
    ...(deliveryCapabilityScore !== undefined ? { deliveryCapabilityScore } : {}),
    deliveryCapabilityTargetScore: packageDeliveryCapabilityTargetScore,
    deliveryCapabilityPassed,
    ...(passRate !== undefined ? { passRate } : {}),
    assessmentCoverage,
    rubricCoverage,
    applicableCriterionCount: applicable.length,
    assessedCriterionCount: assessed.length,
    passedCriterionCount: passCount,
    partialCriterionCount: partialCount,
    failedCriterionCount: failCount,
    notAssessedCriterionCount: notAssessedCount,
    readiness,
    diagnostics,
    evidencePaths: [...new Set(input.evidencePaths)].sort(),
    redaction: { class: "internal", fields: ["criteria.evidence.ref", "hardGates.evidence.ref", "evidencePaths", "diagnostics.metadata"] }
  };
}

async function discoverWorkspacePackages(platform: PlatformRuntime, workspaceRoot: string, workspaceRoots: readonly string[]): Promise<readonly WorkspacePackage[]> {
  const manifestPaths = (await Promise.all(workspaceRoots.map((root) => platform.findFiles("package.json", root).catch(() => []))))
    .flat()
    .filter((file) => /[\\/]src[\\/](packages|plugins)[\\/][^\\/]+[\\/]package\.json$/.test(file))
    .sort((a, b) => workspaceRole(a).localeCompare(workspaceRole(b)));
  const packages: WorkspacePackage[] = [];
  for (const manifestPath of manifestPaths) {
    const raw = await platform.readFile(manifestPath);
    const manifest = JSON.parse(raw) as PackageManifest;
    const role = workspaceRole(manifestPath);
    const packageRoot = dirname(manifestPath);
    packages.push({
      role,
      packageName: typeof manifest.name === "string" ? manifest.name : `@deepseek/${role}`,
      packagePath: toPosix(relative(workspaceRoot, packageRoot)),
      packageRoot,
      manifestPath,
      manifest
    });
  }
  return packages;
}

async function scorePackage(context: EvaluationContext): Promise<PackageScorecardSummary> {
  const rubricIds = rubricIdsForRole(context.pkg.role);
  const liveToolCoverage = context.pkg.role === "core-coding-tools" || context.pkg.role === "tool-intent-preflight"
    ? await readLiveToolCoverageEvidence(context.platform, context.workspaceRoot)
    : undefined;
  const criterionIds = packageScorecardCatalog.criteria.map((item) => item.criterionId);
  const criteria = await Promise.all(criterionIds.map(async (criterionId) => evaluateCriterion(criterionId, context, liveToolCoverage)));
  return summarizeCriterionResults({
    packageId: context.pkg.role,
    packageName: context.pkg.packageName,
    packagePath: context.pkg.packagePath,
    role: context.pkg.role,
    rubricIds,
    criteria,
    evidencePaths: criteria.flatMap((criterionResult) => criterionResult.evidence.map((item) => item.ref))
  });
}

async function evaluateCriterion(
  criterionId: string,
  context: EvaluationContext,
  liveToolCoverage?: Awaited<ReturnType<typeof readLiveToolCoverageEvidence>>
): Promise<PackageScorecardCriterionResult> {
  const definition = definitionFor(criterionId);
  if (!definition) {
    return criterionResult(fallbackDefinition(criterionId), "not_assessed", context, [], [diagnostic("PACKAGE_SCORECARD_UNKNOWN_CRITERION", "warn", `Unknown package scorecard criterion: ${criterionId}.`)]);
  }
  if (!appliesToRole(definition, context.pkg.role)) {
    return criterionResult(definition, "not_applicable", context, [evidence("catalog", packageScorecardCatalog.catalogVersion, "not_applicable")]);
  }

  const coreToolId = liveToolCoverageTargets.find((item) => criterionId === coreToolExecutionCriterionId(item.toolId))?.toolId;
  if (coreToolId) return coreToolExecutionCoverageCriterion(definition, context, coreToolId, liveToolCoverage);
  const preflightToolId = liveToolCoverageTargets.find((item) => criterionId === toolIntentPreflightCriterionId(item.toolId))?.toolId;
  if (preflightToolId) return toolIntentPreflightCoverageCriterion(definition, context, preflightToolId, liveToolCoverage);
  if (criterionId === roleAcceptanceCriterionId(context.pkg.role)) return roleAcceptanceCriterion(definition, context);

  switch (criterionId) {
    case "package.manifest.present":
      return criterionResult(definition, "pass", context, [evidence("package-manifest", context.pkg.manifestPath, "pass")]);
    case "package.manifest.public-export":
      return publicExportCriterion(definition, context);
    case "package.source-index.present":
      return fileExistsCriterion(definition, context, context.platform.resolvePath(context.pkg.packageRoot, "src", "index.ts"));
    case "package.workspace-name.matches-path":
      return workspaceNameCriterion(definition, context);
    case "package.internal-dependencies.versioned":
      return internalDependencyCriterion(definition, context);
    case "package.test-evidence.present":
      return testEvidenceCriterion(definition, context, `${context.pkg.packageRoot}`);
    case "package.secret-source-scan.clean":
      return secretSourceScanCriterion(definition, context);
    case "platform-contracts.no-implementation-imports":
      return sourcePatternAbsenceCriterion(definition, context, /from\s+["']@deepseek\//, "PACKAGE_SCORECARD_CONTRACT_IMPORT");
    case "platform-contracts.no-host-api-imports":
      return sourcePatternAbsenceCriterion(definition, context, /from\s+["'](?:node:)?(?:fs|fs\/promises|child_process|process|vscode)["']|\bprocess\.(?:env|cwd|argv|exit|stdin|stdout|stderr|platform|version|versions)\b|\bBuffer\.(?:from|alloc|byteLength)\b/, "PACKAGE_SCORECARD_HOST_API_IMPORT");
    case "platform-contracts.contract-tests-present":
      return fileExistsCriterion(definition, context, context.platform.resolvePath(context.pkg.packageRoot, "test", "dependency-boundary.test.ts"));
    case "model-gateway.tool-call-protocol-tests":
      return fileContainsCriterion(definition, context, context.platform.resolvePath(context.pkg.packageRoot, "test", "deepseek-provider.test.ts"), "tool_call_id");
    case "model-gateway.no-runtime-imports":
      return sourcePatternAbsenceCriterion(definition, context, /from\s+["']@deepseek\/runtime["']/, "PACKAGE_SCORECARD_MODEL_GATEWAY_RUNTIME_IMPORT");
    case "model-gateway.partial-tool-call-tests":
      return fileContainsCriterion(definition, context, context.platform.resolvePath(context.pkg.packageRoot, "test", "deepseek-partial-tool-calls.test.ts"), "partial tool-call");
    case "runtime.tool-feedback-tests":
      return fileContainsCriterion(definition, context, context.platform.resolvePath(context.pkg.packageRoot, "test", "runtime-tool-feedback.test.ts"), "tool feedback");
    case "runtime.preflight-policy-integration":
      return sourceContainsAllCriterion(definition, context, context.platform.resolvePath(context.pkg.packageRoot, "src", "agent-loop.ts"), ["toolIntentPreflight", "preflight.status"]);
    case "runtime.replayable-events":
      return sourceContainsAllCriterion(definition, context, context.platform.resolvePath(context.pkg.packageRoot, "test", "runtime.test.ts"), ["agent.loop.started", "agent.loop.completed"]);
    default:
      return criterionResult(definition, "not_assessed", context, [evidence("catalog", packageScorecardCatalog.catalogVersion, "not_assessed")], [diagnostic("PACKAGE_SCORECARD_CRITERION_NOT_IMPLEMENTED", "warn", `${criterionId} is not automated in v1.`)]);
  }
}

function coreToolExecutionCoverageCriterion(
  definition: PackageScorecardCriterionDefinition,
  context: EvaluationContext,
  toolId: string,
  liveToolCoverage: Awaited<ReturnType<typeof readLiveToolCoverageEvidence>> | undefined
): PackageScorecardCriterionResult {
  const record = liveToolCoverageRecordFor(liveToolCoverage, toolId);
  if (!record) return missingLiveToolCoverageCriterion(definition, context, toolId);
  const pass = record.status === "pass";
  return criterionResult(
    definition,
    pass ? "pass" : "fail",
    context,
    [evidence("command", liveToolCoverageEvidencePath, pass ? "pass" : "fail")],
    pass ? [] : [diagnostic("PACKAGE_SCORECARD_LIVE_TOOL_EXECUTION_FAILED", "warn", `${context.pkg.packageName} live model/tool coverage failed for ${toolId}.`, { toolId, diagnostics: record.diagnostics as unknown as JsonObject })]
  );
}

function toolIntentPreflightCoverageCriterion(
  definition: PackageScorecardCriterionDefinition,
  context: EvaluationContext,
  toolId: string,
  liveToolCoverage: Awaited<ReturnType<typeof readLiveToolCoverageEvidence>> | undefined
): PackageScorecardCriterionResult {
  const record = liveToolCoverageRecordFor(liveToolCoverage, toolId);
  if (!record) return missingLiveToolCoverageCriterion(definition, context, toolId);
  const preflightStatus = typeof record.preflight.status === "string" ? record.preflight.status : "";
  const pass = record.model.called === true && (preflightStatus === "accepted" || preflightStatus === "repaired");
  return criterionResult(
    definition,
    pass ? "pass" : "fail",
    context,
    [evidence("command", liveToolCoverageEvidencePath, pass ? "pass" : "fail")],
    pass ? [] : [diagnostic("PACKAGE_SCORECARD_LIVE_TOOL_PREFLIGHT_FAILED", "warn", `${context.pkg.packageName} live model/preflight coverage failed for ${toolId}.`, { toolId, diagnostics: record.diagnostics as unknown as JsonObject })]
  );
}

function missingLiveToolCoverageCriterion(
  definition: PackageScorecardCriterionDefinition,
  context: EvaluationContext,
  toolId: string
): PackageScorecardCriterionResult {
  return criterionResult(
    definition,
    "not_assessed",
    context,
    [evidence("command", liveToolCoverageEvidencePath, "not_assessed")],
    [diagnostic("PACKAGE_SCORECARD_LIVE_TOOL_COVERAGE_MISSING", "warn", `${context.pkg.packageName} has no DeepSeek live model/tool coverage evidence for ${toolId}.`, { toolId, evidencePath: liveToolCoverageEvidencePath })]
  );
}

function publicExportCriterion(definition: PackageScorecardCriterionDefinition, context: EvaluationContext): PackageScorecardCriterionResult {
  const rootExport = context.pkg.manifest.exports?.["."];
  const exportObject = isJsonObject(rootExport) ? rootExport : {};
  const ok = exportObject.types === "./src/index.ts" && exportObject.default === "./src/index.ts";
  return criterionResult(
    definition,
    ok ? "pass" : "fail",
    context,
    [evidence("package-manifest", context.pkg.manifestPath, ok ? "pass" : "fail")],
    ok ? [] : [diagnostic("PACKAGE_SCORECARD_PUBLIC_EXPORT_INVALID", "error", `${context.pkg.packageName} must expose ./src/index.ts through exports[\".\"].`)]
  );
}

async function fileExistsCriterion(definition: PackageScorecardCriterionDefinition, context: EvaluationContext, filePath: string): Promise<PackageScorecardCriterionResult> {
  const exists = await context.platform.readFile(filePath).then(() => true, () => false);
  return criterionResult(
    definition,
    exists ? "pass" : definition.required ? "fail" : "not_assessed",
    context,
    [evidence("file", filePath, exists ? "pass" : "fail")],
    exists ? [] : [diagnostic("PACKAGE_SCORECARD_FILE_MISSING", definition.required ? "error" : "warn", `${basename(filePath)} evidence is missing for ${context.pkg.packageName}.`, { filePath: toPosix(filePath) })]
  );
}

function workspaceNameCriterion(definition: PackageScorecardCriterionDefinition, context: EvaluationContext): PackageScorecardCriterionResult {
  const expected = expectedPackageNameForRole(context.pkg.role);
  const ok = context.pkg.packageName === expected;
  return criterionResult(
    definition,
    ok ? "pass" : "fail",
    context,
    [evidence("package-manifest", context.pkg.manifestPath, ok ? "pass" : "fail")],
    ok ? [] : [diagnostic("PACKAGE_SCORECARD_WORKSPACE_NAME_MISMATCH", "error", `${context.pkg.packageName} must be named ${expected}.`, { expected, actual: context.pkg.packageName })]
  );
}

function expectedPackageNameForRole(role: string): string {
  if (role === "builtin") return "@deepseek/builtin-plugins";
  return `@deepseek/${role}`;
}

function internalDependencyCriterion(definition: PackageScorecardCriterionDefinition, context: EvaluationContext): PackageScorecardCriterionResult {
  const dependencies = { ...(context.pkg.manifest.dependencies ?? {}), ...(context.pkg.manifest.devDependencies ?? {}) };
  const invalid = Object.entries(dependencies).filter(([name, version]) => name.startsWith("@deepseek/") && version !== "0.1.0");
  return criterionResult(
    definition,
    invalid.length === 0 ? "pass" : "fail",
    context,
    [evidence("package-manifest", context.pkg.manifestPath, invalid.length === 0 ? "pass" : "fail")],
    invalid.length === 0 ? [] : [diagnostic("PACKAGE_SCORECARD_INTERNAL_DEP_VERSION", "error", `${context.pkg.packageName} has internal dependencies that do not use local version 0.1.0.`, { invalidDependencyCount: invalid.length })]
  );
}

async function testEvidenceCriterion(definition: PackageScorecardCriterionDefinition, context: EvaluationContext, root: string): Promise<PackageScorecardCriterionResult> {
  const tests = await context.platform.findFiles(".test.ts", root);
  if (tests.length > 0) return criterionResult(definition, "pass", context, tests.map((testPath) => evidence("test", testPath, "pass")));
  const externalEvidence = await existingRoleAcceptanceEvidence(context);
  if (externalEvidence.length > 0) return criterionResult(definition, "pass", context, externalEvidence.map((testPath) => evidence("test", testPath, "pass")));
  return criterionResult(definition, "not_assessed", context, [evidence("test", root, "not_assessed")], [diagnostic("PACKAGE_SCORECARD_TEST_EVIDENCE_MISSING", "warn", `${context.pkg.packageName} has no package-local *.test.ts evidence in v1.`)]);
}

async function roleAcceptanceCriterion(definition: PackageScorecardCriterionDefinition, context: EvaluationContext): Promise<PackageScorecardCriterionResult> {
  const refs = roleAcceptanceEvidenceByRole[context.pkg.role] ?? [];
  const existing = await existingRoleAcceptanceEvidence(context);
  const complete = refs.length > 0 && existing.length === refs.length;
  return criterionResult(
    definition,
    complete ? "pass" : "not_assessed",
    context,
    (existing.length > 0 ? existing : refs).map((ref) => evidence("test", ref, complete ? "pass" : "not_assessed")),
    complete ? [] : [diagnostic("PACKAGE_SCORECARD_ROLE_ACCEPTANCE_EVIDENCE_MISSING", "warn", `${context.pkg.packageName} is missing package delivery acceptance evidence.`, { expectedEvidenceCount: refs.length, existingEvidenceCount: existing.length })]
  );
}

async function existingRoleAcceptanceEvidence(context: EvaluationContext): Promise<readonly string[]> {
  const refs = roleAcceptanceEvidenceByRole[context.pkg.role] ?? [];
  const results = await Promise.all(refs.map(async (ref) => {
    const absolute = context.platform.resolvePath(context.workspaceRoot, ref);
    return await context.platform.readFile(absolute).then(() => ref, () => undefined);
  }));
  return results.filter((ref): ref is string => typeof ref === "string");
}

async function secretSourceScanCriterion(definition: PackageScorecardCriterionDefinition, context: EvaluationContext): Promise<PackageScorecardCriterionResult> {
  const sourceFiles = await packageSourceFiles(context);
  const matches = await matchingFiles(context.platform, sourceFiles, /=\s*["']sk-[A-Za-z0-9_-]{8,}["']|Bearer\s+sk-[A-Za-z0-9_-]{8,}/);
  return criterionResult(
    definition,
    matches.length === 0 ? "pass" : "fail",
    context,
    [evidence("static-scan", context.pkg.packageRoot, matches.length === 0 ? "pass" : "fail")],
    matches.length === 0 ? [] : [diagnostic("PACKAGE_SCORECARD_SECRET_LITERAL", "error", `${context.pkg.packageName} source contains literal secret-like values.`, { matchCount: matches.length })]
  );
}

async function sourcePatternAbsenceCriterion(
  definition: PackageScorecardCriterionDefinition,
  context: EvaluationContext,
  pattern: RegExp,
  diagnosticCode: string
): Promise<PackageScorecardCriterionResult> {
  const sourceFiles = await packageSourceFiles(context);
  const matches = await matchingFiles(context.platform, sourceFiles, pattern);
  return criterionResult(
    definition,
    matches.length === 0 ? "pass" : "fail",
    context,
    [evidence("static-scan", context.pkg.packageRoot, matches.length === 0 ? "pass" : "fail")],
    matches.length === 0 ? [] : [diagnostic(diagnosticCode, "error", `${context.pkg.packageName} source matched a forbidden package scorecard pattern.`, { matchCount: matches.length })]
  );
}

async function fileContainsCriterion(
  definition: PackageScorecardCriterionDefinition,
  context: EvaluationContext,
  filePath: string,
  needle: string
): Promise<PackageScorecardCriterionResult> {
  const content = await context.platform.readFile(filePath).catch(() => "");
  const ok = content.includes(needle);
  return criterionResult(
    definition,
    ok ? "pass" : "not_assessed",
    context,
    [evidence("test", filePath, ok ? "pass" : "not_assessed")],
    ok ? [] : [diagnostic("PACKAGE_SCORECARD_ROLE_EVIDENCE_MISSING", "warn", `${context.pkg.packageName} is missing role evidence for ${definition.criterionId}.`, { filePath: toPosix(filePath) })]
  );
}

async function sourceContainsAllCriterion(
  definition: PackageScorecardCriterionDefinition,
  context: EvaluationContext,
  filePath: string,
  needles: readonly string[]
): Promise<PackageScorecardCriterionResult> {
  const content = await context.platform.readFile(filePath).catch(() => "");
  const missing = needles.filter((needle) => !content.includes(needle));
  return criterionResult(
    definition,
    missing.length === 0 ? "pass" : "not_assessed",
    context,
    [evidence("file", filePath, missing.length === 0 ? "pass" : "not_assessed")],
    missing.length === 0 ? [] : [diagnostic("PACKAGE_SCORECARD_ROLE_EVIDENCE_MISSING", "warn", `${context.pkg.packageName} is missing role evidence for ${definition.criterionId}.`, { missingCount: missing.length })]
  );
}

function criterionResult(
  definition: PackageScorecardCriterionDefinition,
  status: PackageScorecardCriterionStatus,
  context: EvaluationContext,
  evidenceRefs: readonly PackageScorecardEvidenceRef[],
  diagnostics: readonly PackageScorecardDiagnostic[] = []
): PackageScorecardCriterionResult {
  const score = scoreForStatus(status);
  return {
    criterionId: definition.criterionId,
    title: definition.title,
    category: definition.category,
    status,
    ...(score !== undefined ? { score } : {}),
    weight: definition.weight,
    required: definition.required,
    hardGate: definition.hardGate,
    evidence: evidenceRefs.length > 0 ? evidenceRefs : [evidence("catalog", packageScorecardCatalog.catalogVersion, status)],
    diagnostics,
    redaction: { class: "internal", fields: ["evidence.ref", "diagnostics.metadata"] }
  };
}

function hardGateFromCriterion(criterionResult: PackageScorecardCriterionResult): PackageScorecardHardGateResult {
  const status: PackageScorecardHardGateStatus = criterionResult.status === "fail"
    ? "fail"
    : criterionResult.status === "not_assessed"
      ? "not_assessed"
      : "pass";
  return {
    gateId: criterionResult.criterionId,
    status,
    message: `${criterionResult.title}: ${status}`,
    evidence: criterionResult.evidence,
    diagnostics: criterionResult.diagnostics,
    redaction: { class: "internal", fields: ["evidence.ref", "diagnostics.metadata"] }
  };
}

function packageReadiness(
  hardGateStatus: PackageScorecardHardGateStatus,
  objectiveScore: number | undefined
): ReadinessStatus {
  if (hardGateStatus === "fail") return "fail";
  if (hardGateStatus === "not_assessed") return "warn";
  if ((objectiveScore ?? 0) < 0.8) return "warn";
  return "pass";
}

async function packageSourceFiles(context: EvaluationContext): Promise<readonly string[]> {
  const sourceRoot = context.platform.resolvePath(context.pkg.packageRoot, "src");
  const files = await context.platform.findFiles(".ts", sourceRoot);
  return files.filter((file) => !file.endsWith(".test.ts") && !file.includes(".test."));
}

async function matchingFiles(platform: PlatformRuntime, files: readonly string[], pattern: RegExp): Promise<readonly string[]> {
  const matches: string[] = [];
  for (const file of files) {
    const content = await platform.readFile(file).catch(() => "");
    if (pattern.test(content)) matches.push(file);
  }
  return matches;
}

function rubric(rubricId: string, role: string, criterionIds: readonly string[]): PackageScorecardRubric {
  return { rubricId, role, criterionIds, redaction: { class: "internal" } };
}

function roleAcceptanceRubrics(): readonly PackageScorecardRubric[] {
  const existingRoleRubricRoles = new Set(["platform-contracts", "model-gateway", "runtime", "core-coding-tools", "tool-intent-preflight"]);
  return Object.keys(roleAcceptanceEvidenceByRole)
    .filter((role) => !existingRoleRubricRoles.has(role))
    .sort()
    .map((role) => rubric(`rubric.package.${role}.v1`, role, [roleAcceptanceCriterionId(role)]));
}

function roleAcceptanceCriterionDefinitions(): readonly PackageScorecardCriterionDefinition[] {
  return Object.keys(roleAcceptanceEvidenceByRole)
    .sort()
    .map((role) => criterion(roleAcceptanceCriterionId(role), `${role} package delivery acceptance evidence`, "role", 3, true, false, [role], roleAcceptanceEvidenceByRole[role]?.join(", ") ?? ""));
}

function roleAcceptanceCriterionId(role: string): string {
  return `package.delivery.${role}.acceptance-evidence`;
}

function criterion(
  criterionId: string,
  title: string,
  category: PackageScorecardCriterionDefinition["category"],
  weight: number,
  required: boolean,
  hardGate: boolean,
  appliesToRoles: readonly string[],
  evidenceHint: string
): PackageScorecardCriterionDefinition {
  return {
    criterionId,
    title,
    category,
    weight,
    required,
    hardGate,
    appliesToRoles,
    evidenceHint,
    redaction: { class: "internal", fields: ["evidenceHint"] }
  };
}

function rubricIdsForRole(role: string): readonly string[] {
  const ids = [packageScorecardCatalog.sharedRubricId];
  const roleRubric = packageScorecardCatalog.rubrics.find((rubric) => rubric.role === role);
  return roleRubric ? [...ids, roleRubric.rubricId] : ids;
}

function definitionFor(criterionId: string): PackageScorecardCriterionDefinition | undefined {
  return packageScorecardCatalog.criteria.find((item) => item.criterionId === criterionId);
}

function fallbackDefinition(criterionId: string): PackageScorecardCriterionDefinition {
  return criterion(criterionId, criterionId, "maintainability", 1, false, false, ["*"], "unknown criterion");
}

function appliesToRole(definition: PackageScorecardCriterionDefinition, role: string): boolean {
  return definition.appliesToRoles.includes("*") || definition.appliesToRoles.includes(role);
}

function rubricCoverageFor(
  rubricIds: readonly string[],
  criteria: readonly PackageScorecardCriterionResult[],
  applicable: readonly PackageScorecardCriterionResult[]
): number {
  if (criteria.length === 0) return 0;
  const knownCriterionIds = new Set(packageScorecardCatalog.criteria.map((item) => item.criterionId));
  if (criteria.some((item) => !knownCriterionIds.has(item.criterionId))) return roundRatio(applicable.length / criteria.length);

  const explicitRoleRubricIds = rubricIds.filter((rubricId) => rubricId !== packageScorecardCatalog.sharedRubricId);
  if (explicitRoleRubricIds.length === 0) return roundRatio(applicable.length / packageScorecardCatalog.criteria.length);

  const selectedCriterionIds = new Set(
    packageScorecardCatalog.rubrics
      .filter((rubric) => rubricIds.includes(rubric.rubricId))
      .flatMap((rubric) => rubric.criterionIds)
  );
  if (selectedCriterionIds.size === 0) return roundRatio(applicable.length / criteria.length);
  const selectedApplicableCount = applicable.filter((item) => selectedCriterionIds.has(item.criterionId)).length;
  return roundRatio(selectedApplicableCount / selectedCriterionIds.size);
}

function scoreForStatus(status: PackageScorecardCriterionStatus): number | undefined {
  if (status === "not_applicable") return undefined;
  return strictScoreForStatus(status);
}

function strictScoreForStatus(status: PackageScorecardCriterionStatus): number {
  return status === "pass" ? 1 : 0;
}

function diagnostic(code: string, severity: PackageScorecardDiagnostic["severity"], message: string, metadata?: JsonObject): PackageScorecardDiagnostic {
  return {
    code,
    severity,
    message,
    ...(metadata ? { metadata } : {}),
    redaction: { class: "internal", fields: ["metadata"] }
  };
}

function evidence(kind: PackageScorecardEvidenceKind, ref: string, status?: PackageScorecardEvidenceRef["status"]): PackageScorecardEvidenceRef {
  return {
    kind,
    ref: toPosix(ref),
    ...(status ? { status } : {}),
    redaction: { class: "internal", fields: ["ref"] }
  };
}

function workspaceRole(manifestPath: string): string {
  return toPosix(dirname(manifestPath)).split("/").at(-1) ?? basename(dirname(manifestPath));
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function roundRatio(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function average(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const packageDeliveryCapabilityTargetScore = 0.9;
