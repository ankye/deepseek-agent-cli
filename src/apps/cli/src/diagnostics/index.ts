import { join } from "node:path";
import { createDiagnosticsEnvironmentPresenceEnv } from "@deepseek/credential-auth-management";
import type {
  AgentLoopOutputMode,
  CliEvaluationComparisonSummary,
  DiagnosticBundle,
  DiagnosticsCommandName,
  DiagnosticsReleaseReadinessEvidence,
  AcceptanceEvidenceRefreshSummary,
  GovernanceDiagnosticsFilter,
  JsonObject,
  ObservabilityPrivacyDecision,
  IndexProviderDiagnosticsSummary,
  ReadinessCheck,
  ReadinessCommandResult,
  ReleaseVerificationSummary
} from "@deepseek/platform-contracts";
import type { TaskDeliveryFlowSummary } from "@deepseek/platform-contracts";
import { invokeLocalReadinessCommand } from "@deepseek/command-system";
import { InMemoryObservabilitySink } from "@deepseek/observability";
import { NodePlatformRuntime } from "@deepseek/platform-abstraction";
import type { CliOptions, CliRunOptions } from "../types.js";
import { createCliReadinessEnvironment, renderReadinessText } from "../commands/readiness.js";
import { activationEvidenceText, missingActivationEvidence } from "../commands/index-provider.js";
import { collectReleaseReadinessEvidence, diagnosticPitIds, diagnosticsSchemaVersion } from "./release-evidence.js";
import { refreshAcceptanceEvidence, refreshStepRecord } from "./refresh-evidence.js";
import { environmentPrepareJsonLines, prepareDiagnosticsEnvironment } from "./environment-prepare.js";
import type { DiagnosticsEnvironmentPrepareSummary } from "./environment-prepare.js";
import { collectCliEvaluation, evaluationJsonLines } from "./evaluation.js";
import type { CliEvaluationOptions } from "./evaluation.js";
import type { EvaluationProgressSink } from "./evaluation-progress.js";
import { buildEvaluationDeliveryCapabilityEvidence } from "./evaluation-delivery-evidence.js";
import { evaluationRunMetricText, evaluationRunTraceText } from "./evaluation-text-render.js";
import { collectModeMatrix } from "./mode-matrix.js";
import type { CliModeMatrixSummary } from "./mode-matrix.js";
import { collectDeliveryCapabilitySummary } from "./delivery-capability.js";
import type { CliDeliveryCapabilitySummary } from "./delivery-capability.js";
import { collectPackageScorecards, releasePackageScorecardAdvisory } from "./package-scorecard.js";
import {
  filterGovernanceDiagnostics,
  governanceFilterFromInput,
  productReadyClaimsFromInput
} from "./governance-diagnostics.js";
import { governanceEvidenceMatrixJsonLines, renderGovernanceEvidenceMatrixText } from "./governance-evidence-render.js";
import { collectDiagnosticsFlowInspect, diagnosticsFlowInspectJsonLines } from "./flow-inspect.js";
import { collectSweBenchCliDiagnostics } from "./swe-bench-cli-diagnostics.js";
import { renderSweBenchPredictionText, sweBenchPredictionJsonLines } from "./swe-bench-prediction.js";
import type { SweBenchPredictionSummary } from "./swe-bench-prediction.js";
import type { CapabilityMatrixSummary } from "./capability-matrix-types.js";
import { capabilityMatrixDiagnostics, capabilityMatrixJsonLines, renderCapabilityMatrixText } from "./capability-matrix-diagnostics.js";

export interface CliDiagnosticNotice {
  readonly code: string;
  readonly message: string;
}

export interface CliDiagnosticsResult extends JsonObject {
  readonly schemaVersion: string;
  readonly kind: "diagnostics.bundle" | "diagnostics.release" | "diagnostics.doctor" | "diagnostics.verify" | "diagnostics.refresh" | "diagnostics.evaluate" | "diagnostics.env.prepare" | "diagnostics.flow.inspect" | "diagnostics.swe-bench" | "diagnostics.capability-matrix";
  readonly status: "pass" | "warn" | "fail";
  readonly command: DiagnosticsCommandName;
  readonly bundle?: DiagnosticBundle;
  readonly externalExportDecision?: ObservabilityPrivacyDecision;
  readonly readiness?: ReadinessCommandResult;
  readonly release?: DiagnosticsReleaseReadinessEvidence;
  readonly verificationSummary?: ReleaseVerificationSummary;
  readonly refresh?: AcceptanceEvidenceRefreshSummary;
  readonly environment?: DiagnosticsEnvironmentPrepareSummary;
  readonly flow?: TaskDeliveryFlowSummary;
  readonly sweBench?: SweBenchPredictionSummary;
  readonly capabilityMatrix?: CapabilityMatrixSummary;
  readonly evaluation?: CliEvaluationComparisonSummary;
  readonly indexProviders?: IndexProviderDiagnosticsSummary;
  readonly modeMatrix?: CliModeMatrixSummary;
  readonly overallDeliveryCapability?: CliDeliveryCapabilitySummary;
  readonly referencePitFixtureIds: readonly string[];
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export async function runDiagnosticsCommand(options: CliOptions, write: (line: string) => Promise<void>, runOptions: CliRunOptions = {}): Promise<void> {
  const command = options.diagnosticsCommand ?? "bundle";
  let progressWrites = Promise.resolve();
  const progressSink: EvaluationProgressSink | undefined = command === "evaluate" && options.output === "text"
    ? {
        emit(line) {
          progressWrites = progressWrites.then(() => write(line));
        }
      }
    : undefined;
  const result = await collectCliDiagnostics(command, options, progressSink, runOptions);
  await progressWrites;
  for (const line of renderDiagnosticsResult(result, options.output)) await write(line);
}

export async function collectCliDiagnostics(command: DiagnosticsCommandName, options: CliOptions, progressSink?: EvaluationProgressSink, runOptions: CliRunOptions = {}): Promise<CliDiagnosticsResult> {
  if (command === "release") return releaseDiagnostics(options);
  if (command === "verify") return verifyDiagnostics(options);
  if (command === "refresh") return refreshDiagnostics(options);
  if (command === "env") return environmentDiagnostics(options);
  if (command === "flow") return flowDiagnostics(options);
  if (command === "swe-bench") return collectSweBenchCliDiagnostics(options, runOptions);
  if (command === "capability-matrix") return capabilityMatrixDiagnostics(options);
  if (command === "evaluate") return evaluateDiagnostics(options, progressSink);
  if (command === "doctor") return doctorDiagnostics(options, runOptions);
  return bundleDiagnostics(options);
}

export function renderDiagnosticsResult(result: CliDiagnosticsResult, output: AgentLoopOutputMode): readonly string[] {
  if (output === "json") return [JSON.stringify(result)];
  if (output === "jsonl") return diagnosticsJsonLines(result).map((entry) => JSON.stringify(entry));
  const lines = [`${result.kind}: ${result.status}`];
  if (result.bundle) {
    lines.push(`- bundle: ${result.bundle.bundleId}`);
    lines.push(`- records: ${result.bundle.selectedRecordCount}/${result.bundle.totalRecordCount}${result.bundle.truncated ? " truncated" : ""}`);
    lines.push(`- privacy: ${result.bundle.privacyDecision.action} (${result.bundle.privacyDecision.reasonCode})`);
    lines.push(`- redactions: ${result.bundle.redactionSummary.redactedValueCount}`);
  }
  if (result.externalExportDecision) {
    lines.push(`- external export: ${result.externalExportDecision.action} (${result.externalExportDecision.reasonCode})`);
  }
  if (result.readiness) {
    lines.push(...renderReadinessText(result.readiness).map((line) => `- ${line}`));
  }
  if (result.indexProviders) {
    lines.push(`- index providers: enabled=${result.indexProviders.enabledProviderIds.join(", ") || "none"} deferred=${result.indexProviders.deferredProviderIds.join(", ") || "none"}`);
    for (const provider of result.indexProviders.providers) {
      lines.push(`- index provider ${provider.providerId}: ${provider.status} (${provider.kind}, ${provider.ranking.join(", ")})`);
      lines.push(`  evidence=${activationEvidenceText(provider)}`);
      const missing = missingActivationEvidence(provider);
      if (missing.length > 0) lines.push(`  missing-evidence=${missing.join(", ")}`);
      if (provider.diagnostics.length > 0) lines.push(`  diagnostics=${provider.diagnostics.map((diagnostic) => diagnostic.code).join(", ")}`);
    }
  }
  if (result.release) {
    lines.push(`- package: ${result.release.packageSurface.packageName}@${result.release.packageSurface.packageVersion}`);
    lines.push(`- bin: ${result.release.packageSurface.executableName} -> ${result.release.packageSurface.binEntry}`);
    lines.push(`- build artifact: ${result.release.packageSurface.buildOutputPath} ${result.release.packageSurface.buildOutputExists === true ? "present" : result.release.packageSurface.sourcePackageManifestFound === false ? "deferred" : "missing"}`);
    lines.push(`- package files: ${result.release.packageSurface.expectedPackageFiles.join(", ")}`);
    lines.push(`- package surface: ${result.release.packageSurface.unexpectedPackageFiles?.length ? `unexpected=${result.release.packageSurface.unexpectedPackageFiles.join(", ")}` : "safe"}`);
    lines.push(`- generated bundle ignored: ${String(result.release.packageSurface.generatedBundleIgnored)}`);
    lines.push(`- verify: ${result.release.verification.requiredCommands.join(" && ")}`);
    lines.push(`- evidence: ${result.release.verification.acceptanceEvidencePaths.join(", ")}`);
    if (result.release.verification.liveEvidence) {
      const evidence = result.release.verification.liveEvidence;
      lines.push(`- live release evidence: ${evidence.status} missing=${evidence.missingEvidencePaths.length} invalid=${evidence.invalidEvidencePaths.length}`);
    }
    if (result.release.verification.publishDryRunEvidence) {
      const evidence = result.release.verification.publishDryRunEvidence;
      lines.push(`- publish dry-run evidence: ${evidence.status} (${evidence.path})`);
    }
    if (result.release.firstPartyPluginPack) {
      const pack = result.release.firstPartyPluginPack;
      lines.push(`- first-party plugins: ${pack.status} plugins=${pack.pluginCount} commands=${pack.commandCount} manifests=${pack.manifestIds.join(", ")}`);
    }
    if ((result.release.verification.missingAcceptanceEvidencePaths?.length ?? 0) > 0) {
      lines.push(`- missing evidence: ${result.release.verification.missingAcceptanceEvidencePaths?.join(", ")}`);
    }
    if (result.release.packageScorecardAdvisory) {
      const aggregate = result.release.packageScorecardAdvisory.aggregate;
      lines.push(`- package delivery capability: advisory ${result.release.packageScorecardAdvisory.status} score=${aggregate.averageDeliveryCapabilityScore ?? "n/a"} target=${aggregate.deliveryCapabilityTargetScore} passed=${aggregate.deliveryCapabilityPassedPackageCount}/${aggregate.deliveryCapabilityTotalPackageCount} gate=${aggregate.deliveryCapabilityPassed ? "pass" : "blocked"}`);
      lines.push(`- package scorecards: packages=${aggregate.totalPackageCount} pass=${aggregate.passPackageCount} warn=${aggregate.warnPackageCount} fail=${aggregate.failPackageCount} delivery=${aggregate.averageDeliveryCapabilityScore ?? "n/a"} quality=${aggregate.averageWeightedScore ?? "n/a"} assessed=${aggregate.averageAssessmentCoverage} rubric=${aggregate.averageRubricCoverage}`);
    }
    if (result.release.governanceEvidenceMatrix) {
      lines.push(...renderGovernanceEvidenceMatrixText(result.release.governanceEvidenceMatrix));
    }
    if (result.release.governanceDiagnostics) {
      const governance = result.release.governanceDiagnostics;
      lines.push(`- governance diagnostics: ${governance.status} sections=${governance.sections.length} findings=${governance.findings.length}`);
      for (const section of governance.sections) {
        lines.push(`- /proc/deepseek/${section.sectionId}: ${section.status} maturity=${section.maturityState} owner=${section.ownerPackage} capability=${section.capability}`);
        const severityGroups = [...new Set(section.findings.map((finding) => finding.severity))].sort();
        lines.push(`  severities=${severityGroups.join(", ") || "none"}`);
        for (const finding of section.findings) {
          lines.push(`  finding ${finding.id}: severity=${finding.severity} state=${finding.maturityState} evidence=${finding.evidenceIds.join(", ") || "none"} next=${finding.nextAction}`);
        }
      }
    }
    for (const check of result.release.checks) lines.push(`- ${check.id}: ${check.status} - ${check.message}`);
  }
  if (result.verificationSummary) {
    const summary = result.verificationSummary;
    lines.push(`- verification: ${summary.status}`);
    lines.push(`- publish dry-run ready: ${String(summary.publishDryRunReady)}`);
    lines.push(`- next action: ${summary.nextAction}`);
    if (summary.blockingChecks.length > 0) lines.push(`- blocking checks: ${summary.blockingChecks.map((check) => check.id).join(", ")}`);
    if (summary.warningChecks.length > 0) lines.push(`- warning checks: ${summary.warningChecks.map((check) => check.id).join(", ")}`);
    if (summary.missingAcceptanceEvidencePaths.length > 0) lines.push(`- missing evidence: ${summary.missingAcceptanceEvidencePaths.join(", ")}`);
    lines.push(`- command plan: ${summary.requiredCommands.join(" && ")}`);
  }
  if (result.refresh) {
    lines.push(`- mode: ${result.refresh.mode}`);
    lines.push(`- dry-run: ${String(result.refresh.dryRun)}`);
    lines.push(`- refreshed: ${result.refresh.refreshedPaths.length}`);
    lines.push(`- failed: ${result.refresh.failedStepIds.join(", ") || "none"}`);
    lines.push(`- next action: ${result.refresh.nextAction}`);
    for (const step of result.refresh.steps) {
      lines.push(`- ${step.id}: ${step.status}${typeof step.exitCode === "number" ? ` exit=${step.exitCode}` : ""} -> ${step.outputPath}`);
    }
    for (const diagnostic of result.refresh.diagnostics) {
      lines.push(`- ${diagnostic.id}: ${diagnostic.status} - ${diagnostic.message}`);
    }
  }
  if (result.environment) {
    lines.push(`- env profile: ${result.environment.profileId}`);
    lines.push(`- env action: ${result.environment.action}`);
    lines.push(`- dry-run: ${String(result.environment.dryRun)}`);
    lines.push(`- execute: ${String(result.environment.execute)}`);
    lines.push(`- next action: ${result.environment.nextAction}`);
    for (const dependency of result.environment.dependencies) {
      lines.push(`- env dependency ${dependency.id}: ${dependency.status} - ${dependency.message}`);
      if (dependency.commandPlan.length > 0) lines.push(`  plan=${dependency.commandPlan.map((step) => step.id).join(", ")}`);
    }
    for (const diagnostic of result.environment.diagnostics) {
      lines.push(`- ${diagnostic.id}: ${diagnostic.status} - ${diagnostic.message}`);
    }
  }
  if (result.flow) {
    lines.push(`- flow brief: ${result.flow.brief.briefId} intent=${result.flow.brief.normalizedIntent}`);
    lines.push(`- flow goal: ${result.flow.goal.goalId} risk=${result.flow.goal.riskLevel}`);
    lines.push(`- flow plan: ${result.flow.plan.planningMode} steps=${result.flow.plan.steps.length}`);
    lines.push(`- flow acceptance: ${result.flow.acceptance.decision} return=${result.flow.acceptance.recommendedReturnPhase}`);
    lines.push(`- flow delivery: ${result.flow.delivery.status}${result.flow.delivery.nextPhase ? ` next=${result.flow.delivery.nextPhase}` : ""}`);
    for (const diagnostic of result.flow.diagnostics) {
      lines.push(`- ${diagnostic.code}: ${diagnostic.message}`);
    }
  }
  if (result.sweBench) {
    lines.push(...renderSweBenchPredictionText(result.sweBench));
  }
  if (result.capabilityMatrix) {
    lines.push(...renderCapabilityMatrixText(result.capabilityMatrix));
  }
  if (result.evaluation) {
    lines.push(`- mode: ${result.evaluation.mode}`);
    lines.push(`- dry-run: ${String(result.evaluation.dryRun)}`);
    lines.push(`- catalog: ${result.evaluation.taskCatalogVersion}`);
    lines.push(`- baselines: ${result.evaluation.baselines.map((baseline) => `${baseline.baselineId}:${baseline.status}`).join(", ")}`);
    lines.push(`- task runs: ${result.evaluation.taskRuns.length}`);
    if (result.evaluation.packageScorecardAggregate) {
      const aggregate = result.evaluation.packageScorecardAggregate;
      lines.push(`- package delivery capability: score=${aggregate.averageDeliveryCapabilityScore ?? "n/a"} target=${aggregate.deliveryCapabilityTargetScore} passed=${aggregate.deliveryCapabilityPassedPackageCount}/${aggregate.deliveryCapabilityTotalPackageCount} gate=${aggregate.deliveryCapabilityPassed ? "pass" : "blocked"}`);
      lines.push(`- package scorecards: packages=${aggregate.totalPackageCount} pass=${aggregate.passPackageCount} warn=${aggregate.warnPackageCount} fail=${aggregate.failPackageCount} delivery=${aggregate.averageDeliveryCapabilityScore ?? "n/a"} quality=${aggregate.averageWeightedScore ?? "n/a"} assessed=${aggregate.averageAssessmentCoverage} rubric=${aggregate.averageRubricCoverage}`);
    }
    if (result.evaluation.toolFamilyParityMatrix) {
      const matrix = result.evaluation.toolFamilyParityMatrix;
      lines.push(`- tool family delivery capability: score=${matrix.deliveryCapabilityScore} target=${matrix.deliveryCapabilityTargetScore} passed=${matrix.deliveryCapabilityPassedFamilyCount}/${matrix.totalFamilyCount} gate=${matrix.deliveryCapabilityPassed ? "pass" : "blocked"}`);
      lines.push(`- tool family parity: families=${matrix.totalFamilyCount} implemented=${matrix.implementedFamilyCount} execution=${matrix.executionCoveredFamilyCount} fake=${matrix.fakeCoveredFamilyCount} replayed=${matrix.replayedCoveredFamilyCount} live=${matrix.liveCoveredFamilyCount} task=${matrix.taskCoveredFamilyCount} safety=${matrix.safetyCoveredFamilyCount} provider-native=${matrix.providerNativeSupportedFamilyCount} planned=${matrix.plannedFamilyCount} absent=${matrix.absentFamilyCount} unavailable=${matrix.unavailableFamilyCount} delivery=${matrix.objectiveScore}`);
    }
    lines.push(`- next action: ${result.evaluation.nextAction}`);
    for (const run of result.evaluation.taskRuns) {
      lines.push(`- ${run.task.taskId}: ${run.outcome} (${run.baseline.baselineId})${evaluationRunMetricText(run)}`);
      lines.push(...evaluationRunTraceText(run).map((line) => `  ${line}`));
    }
    for (const diagnostic of result.evaluation.diagnostics) {
      lines.push(`- ${diagnostic.code}: ${diagnostic.severity} - ${diagnostic.message}`);
    }
  }
  if (result.modeMatrix) {
    lines.push(`- mode delivery capability: score=${result.modeMatrix.modeDeliveryCapabilityScore} target=${result.modeMatrix.modeDeliveryCapabilityTargetScore} complete=${result.modeMatrix.modeDeliveryCapabilityCompletedCount}/${result.modeMatrix.modeDeliveryCapabilityTotalCount} gate=${result.modeMatrix.modeDeliveryCapabilityPassed ? "pass" : "blocked"}`);
    lines.push(`- interaction modes: ${modeMatrixStatusText(result.modeMatrix.interactionModes)}`);
    lines.push(`- agent modes: ${modeMatrixStatusText(result.modeMatrix.agentModes)}`);
    if (result.modeMatrix.missingAcceptanceEvidence.length > 0) lines.push(`- missing mode evidence: ${result.modeMatrix.missingAcceptanceEvidence.join(", ")}`);
    if (result.modeMatrix.nextTasks.length > 0) lines.push(`- mode next tasks: ${result.modeMatrix.nextTasks.join(", ")}`);
  }
  if (result.overallDeliveryCapability) {
    const delivery = result.overallDeliveryCapability;
    lines.push(`- overall delivery capability: score=${delivery.score} target=${delivery.targetScore} unfinished=${delivery.unfinishedTargetCount} penalty=${delivery.unfinishedPenaltyPerItem} gate=${delivery.status}`);
    if (typeof delivery.evaluationTaskScore === "number") lines.push(`- evaluation task delivery capability: score=${delivery.evaluationTaskScore} target=1 solved=${delivery.evaluationTaskSolvedCount}/${delivery.evaluationTaskTotalCount} gate=${delivery.evaluationTaskGatePassed ? "pass" : "blocked"}`);
    lines.push(`- deepseek api delivery capability: score=${delivery.deepSeekApiScore} target=${delivery.targetScore} passed=${delivery.deepSeekApiPassedCount}/${delivery.deepSeekApiTotalCount} gate=${delivery.deepSeekApiGatePassed ? "pass" : "blocked"}`);
    lines.push(`- memory delivery capability: score=${delivery.memoryScore} target=${delivery.targetScore} passed=${delivery.memoryPassedCount}/${delivery.memoryTotalCount} gate=${delivery.memoryGatePassed ? "pass" : "blocked"}`);
    lines.push(`- cache observability delivery capability: score=${delivery.cacheObservabilityScore} target=${delivery.targetScore} passed=${delivery.cacheObservabilityPassedCount}/${delivery.cacheObservabilityTotalCount} gate=${delivery.cacheObservabilityGatePassed ? "pass" : "blocked"}`);
    if (delivery.blockingFamilyIds.length > 0) lines.push(`- blocking tool families: ${delivery.blockingFamilyIds.join(", ")}`);
    if (delivery.blockingModeIds.length > 0) lines.push(`- blocking modes: ${delivery.blockingModeIds.join(", ")}`);
    if (delivery.blockingPackageIds.length > 0) lines.push(`- blocking packages: ${delivery.blockingPackageIds.join(", ")}`);
    if (delivery.blockingEvaluationTaskIds.length > 0) lines.push(`- blocking evaluation tasks: ${delivery.blockingEvaluationTaskIds.join(", ")}`);
    if (delivery.blockingCapabilityIds.length > 0) lines.push(`- blocking capabilities: ${delivery.blockingCapabilityIds.join(", ")}`);
  }
  lines.push(`- reference pits: ${result.referencePitFixtureIds.join(", ")}`);
  return lines;
}

async function bundleDiagnostics(options: CliOptions): Promise<CliDiagnosticsResult> {
  const sink = new InMemoryObservabilitySink();
  await seedDiagnosticRecords(sink, options);
  const maxRecords = typeof options.diagnosticsInput?.maxRecords === "number" ? options.diagnosticsInput.maxRecords : 10;
  const bundle = await sink.createDiagnosticBundle({ target: "local-bundle", reason: "cli diagnostics bundle", maxRecords });
  const externalExportDecision = sink.decideExport("support-upload");
  const modeMatrix = await collectModeMatrix();
  return {
    schemaVersion: diagnosticsSchemaVersion,
    kind: "diagnostics.bundle",
    status: bundle.privacyDecision.action === "allow-local" ? "pass" : "warn",
    command: "bundle",
    bundle,
    externalExportDecision,
    modeMatrix,
    referencePitFixtureIds: [...diagnosticPitIds],
    redaction: { class: "internal", fields: ["bundle.records", "externalExportDecision", "modeMatrix.missingAcceptanceEvidence"] }
  };
}

async function releaseDiagnostics(options: CliOptions): Promise<CliDiagnosticsResult> {
  const release = await collectReleaseReadinessEvidence({
    productReadyClaims: productReadyClaimsFromInput(options.diagnosticsInput)
  });
  const packageScorecards = await collectPackageScorecards();
  const governanceFilter = governanceFilterFromInput(options.diagnosticsInput);
  const releaseWithAdvisory: DiagnosticsReleaseReadinessEvidence = {
    ...release,
    ...filteredGovernance(release, governanceFilter),
    ...(packageScorecards.scorecards.length > 0 ? {
      packageScorecardAdvisory: releasePackageScorecardAdvisory(packageScorecards.aggregate, packageScorecards.scorecards)
    } : {})
  };
  return {
    schemaVersion: diagnosticsSchemaVersion,
    kind: "diagnostics.release",
    status: release.status,
    command: "release",
    release: releaseWithAdvisory,
    referencePitFixtureIds: [...diagnosticPitIds],
    redaction: { class: "internal", fields: ["release.packageSurface.buildOutputPath", "release.governanceDiagnostics.findings.message", "release.governanceDiagnostics.findings.nextAction"] }
  };
}

async function verifyDiagnostics(options: CliOptions): Promise<CliDiagnosticsResult> {
  const releaseRaw = await collectReleaseReadinessEvidence({
    productReadyClaims: productReadyClaimsFromInput(options.diagnosticsInput)
  });
  const release = {
    ...releaseRaw,
    ...filteredGovernance(releaseRaw, governanceFilterFromInput(options.diagnosticsInput))
  };
  const verificationSummary = releaseVerificationSummary(release);
  const modeMatrix = await collectModeMatrix();
  return {
    schemaVersion: diagnosticsSchemaVersion,
    kind: "diagnostics.verify",
    status: verificationSummary.status === "blocked" ? "fail" : verificationSummary.status === "warn" ? "warn" : "pass",
    command: "verify",
    release,
    verificationSummary,
    modeMatrix,
    referencePitFixtureIds: [...diagnosticPitIds],
    redaction: { class: "internal", fields: ["release", "verificationSummary.missingAcceptanceEvidencePaths", "modeMatrix.missingAcceptanceEvidence"] }
  };
}

async function refreshDiagnostics(options: CliOptions): Promise<CliDiagnosticsResult> {
  const refresh = await refreshAcceptanceEvidence({
    mode: options.diagnosticsInput?.full === true ? "full" : "default",
    dryRun: options.diagnosticsInput?.dryRun === true,
    extraArgs: Array.isArray(options.diagnosticsInput?.extraArgs)
      ? options.diagnosticsInput.extraArgs.filter((item): item is string => typeof item === "string")
      : []
  });
  return {
    schemaVersion: diagnosticsSchemaVersion,
    kind: "diagnostics.refresh",
    status: refresh.status,
    command: "refresh",
    refresh,
    referencePitFixtureIds: [...diagnosticPitIds],
    redaction: { class: "internal", fields: ["refresh.steps.args", "refresh.steps.outputPath", "refresh.refreshedPaths"] }
  };
}

async function environmentDiagnostics(options: CliOptions): Promise<CliDiagnosticsResult> {
  const environment = await prepareDiagnosticsEnvironment({
    profileId: typeof options.diagnosticsInput?.profile === "string" ? options.diagnosticsInput.profile : "swe-bench-lite",
    action: typeof options.diagnosticsInput?.action === "string" ? options.diagnosticsInput.action : "prepare",
    dryRun: options.diagnosticsInput?.dryRun !== false,
    execute: options.diagnosticsInput?.execute === true,
    extraArgs: Array.isArray(options.diagnosticsInput?.extraArgs)
      ? options.diagnosticsInput.extraArgs.filter((item): item is string => typeof item === "string")
      : [],
    env: createDiagnosticsEnvironmentPresenceEnv()
  });
  return {
    schemaVersion: diagnosticsSchemaVersion,
    kind: "diagnostics.env.prepare",
    status: environment.status,
    command: "env",
    environment,
    referencePitFixtureIds: [...diagnosticPitIds],
    redaction: { class: "internal", fields: ["environment.dependencies.commandPlan.args", "environment.dependencies.secretRef", "environment.dependencies.metadata", "environment.executedSteps.args", "environment.executedSteps.stdoutPreview", "environment.executedSteps.stderrPreview", "environment.diagnostics.metadata"] }
  };
}

async function flowDiagnostics(options: CliOptions): Promise<CliDiagnosticsResult> {
  const inspected = collectDiagnosticsFlowInspect(options.diagnosticsInput);
  return {
    schemaVersion: diagnosticsSchemaVersion,
    kind: "diagnostics.flow.inspect",
    status: inspected.status,
    command: "flow",
    flow: inspected.flow,
    referencePitFixtureIds: [...diagnosticPitIds],
    redaction: { class: "internal", fields: ["flow.brief.rawInput", "flow.diagnostics.details"] }
  };
}

async function evaluateDiagnostics(options: CliOptions, progressSink?: EvaluationProgressSink): Promise<CliDiagnosticsResult> {
  const evaluationOptions: CliEvaluationOptions = {
    mode: options.diagnosticsInput?.full === true ? "full" : "smoke",
    dryRun: options.diagnosticsInput?.dryRun === true,
    live: options.live === true,
    baselineId: typeof options.diagnosticsInput?.baseline === "string" ? options.diagnosticsInput.baseline : "deepseek-cli",
    compareBaselineIds: Array.isArray(options.diagnosticsInput?.compareBaselines)
      ? options.diagnosticsInput.compareBaselines.filter((item): item is string => typeof item === "string")
      : [],
    allowExternalBaseline: options.diagnosticsInput?.allowExternalBaseline === true,
    ...(typeof options.diagnosticsInput?.baselineCommand === "string" ? { baselineCommand: options.diagnosticsInput.baselineCommand } : {}),
    ...(typeof options.diagnosticsInput?.codexCommand === "string" ? { codexCommand: options.diagnosticsInput.codexCommand } : {}),
    ...(typeof options.diagnosticsInput?.claudeCommand === "string" ? { claudeCommand: options.diagnosticsInput.claudeCommand } : {}),
    ...(typeof options.diagnosticsInput?.executeTask === "string" ? { executeTaskId: options.diagnosticsInput.executeTask } : {}),
    ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
    ...(options.model ? { model: options.model } : {}),
    baselineArgs: Array.isArray(options.diagnosticsInput?.baselineArgs)
      ? options.diagnosticsInput.baselineArgs.filter((item): item is string => typeof item === "string")
      : [],
    extraArgs: Array.isArray(options.diagnosticsInput?.extraArgs)
      ? options.diagnosticsInput.extraArgs.filter((item): item is string => typeof item === "string")
      : [],
    ...(progressSink ? { progressSink } : {})
  };
  const evaluation = await collectCliEvaluation(evaluationOptions);
  const modeMatrix = await collectModeMatrix();
  const overallDeliveryCapability = collectDeliveryCapabilitySummary(evaluation, modeMatrix);
  if (
    options.live === true &&
    options.diagnosticsInput?.dryRun !== true &&
    options.diagnosticsInput?.executeTask === "all" &&
    overallDeliveryCapability
  ) {
    await writeEvaluationDeliveryCapabilityEvidence(evaluation, overallDeliveryCapability, evaluationOptions, options.output);
  }
  return {
    schemaVersion: diagnosticsSchemaVersion,
    kind: "diagnostics.evaluate",
    status: evaluation.status,
    command: "evaluate",
    evaluation,
    modeMatrix,
    ...(overallDeliveryCapability ? { overallDeliveryCapability } : {}),
    referencePitFixtureIds: [...diagnosticPitIds],
    redaction: { class: "internal", fields: ["evaluation.taskRuns.task.promptDigest", "evaluation.evidencePaths", "modeMatrix.missingAcceptanceEvidence", "overallDeliveryCapability.blockingFamilyIds", "overallDeliveryCapability.blockingModeIds", "overallDeliveryCapability.blockingPackageIds", "overallDeliveryCapability.blockingEvaluationTaskIds", "overallDeliveryCapability.blockingCapabilityIds"] }
  };
}

async function writeEvaluationDeliveryCapabilityEvidence(
  evaluation: CliEvaluationComparisonSummary,
  overallDeliveryCapability: CliDeliveryCapabilitySummary,
  evaluationOptions: CliEvaluationOptions,
  outputMode: AgentLoopOutputMode
): Promise<void> {
  const outputPath = join(process.cwd(), "tests", "acceptance", "latest", "overall-delivery-capability-score.json");
  const evidence = buildEvaluationDeliveryCapabilityEvidence(evaluation, overallDeliveryCapability, evaluationOptions, outputMode);
  const platform = new NodePlatformRuntime();
  await platform.ensureDirectory(join(process.cwd(), "tests", "acceptance", "latest"));
  await platform.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
}

async function doctorDiagnostics(options: CliOptions, runOptions: CliRunOptions): Promise<CliDiagnosticsResult> {
  const live = options.live === true;
  const environment = await createCliReadinessEnvironment({ ...options, readinessCommand: "doctor", readinessInput: { live } }, runOptions);
  const readiness = await invokeLocalReadinessCommand("doctor", { live }, environment);
  const releaseRaw = await collectReleaseReadinessEvidence({
    productReadyClaims: productReadyClaimsFromInput(options.diagnosticsInput)
  });
  const release = {
    ...releaseRaw,
    ...filteredGovernance(releaseRaw, governanceFilterFromInput(options.diagnosticsInput))
  };
  const modeMatrix = await collectModeMatrix();
  const status = readiness.value?.status === "fail" || release.status === "fail" ? "fail" : readiness.value?.status === "warn" || release.status === "warn" ? "warn" : "pass";
  return {
    schemaVersion: diagnosticsSchemaVersion,
    kind: "diagnostics.doctor",
    status,
    command: "doctor",
    ...(readiness.value ? { readiness: readiness.value } : {}),
    release,
    ...(readiness.value?.indexProviders ? { indexProviders: readiness.value.indexProviders } : {}),
    modeMatrix,
    referencePitFixtureIds: [...diagnosticPitIds],
    redaction: { class: "internal", fields: ["readiness", "release", "indexProviders.providers.metadata", "indexProviders.providers.activationEvidence.metadata", "indexProviders.providers.diagnostics.details", "modeMatrix.missingAcceptanceEvidence"] }
  };
}

export function releaseVerificationSummary(release: DiagnosticsReleaseReadinessEvidence): ReleaseVerificationSummary {
  const blockingChecks = release.checks.filter((check) => check.status === "fail");
  const warningChecks = release.checks.filter((check) => check.status === "warn");
  const status = blockingChecks.length > 0 ? "blocked" : warningChecks.length > 0 ? "warn" : "ready";
  const nextAction = nextReleaseVerificationAction(release, blockingChecks, warningChecks);
  return {
    schemaVersion: diagnosticsSchemaVersion,
    kind: "release.verification.summary",
    status,
    releaseStatus: release.status,
    blockingChecks,
    warningChecks,
    missingAcceptanceEvidencePaths: release.verification.missingAcceptanceEvidencePaths ?? [],
    requiredCommands: release.verification.requiredCommands,
    nextAction,
    dryRunCommand: release.verification.dryRunCommand,
    publishDryRunReady: status === "ready",
    referencePitFixtureIds: release.verification.referencePitFixtureIds,
    redaction: { class: "internal", fields: ["blockingChecks.metadata", "warningChecks.metadata", "missingAcceptanceEvidencePaths"] }
  };
}

function nextReleaseVerificationAction(
  release: DiagnosticsReleaseReadinessEvidence,
  blockingChecks: readonly ReadinessCheck[],
  warningChecks: readonly ReadinessCheck[]
): string {
  const firstBlockingAction = blockingChecks.flatMap((check) => check.suggestedActions ?? [])[0];
  if (firstBlockingAction) return firstBlockingAction;
  const firstWarningAction = warningChecks.flatMap((check) => check.suggestedActions ?? [])[0];
  if (firstWarningAction) return firstWarningAction;
  return release.verification.dryRunCommand;
}

async function seedDiagnosticRecords(sink: InMemoryObservabilitySink, options: CliOptions): Promise<void> {
  const platform = new NodePlatformRuntime();
  const descriptor = await platform.descriptor();
  const fakeSecret = options.diagnosticsInput?.fakeSecret === true ? "sk-diagnostics-secret-123456" : "[REDACTED:synthetic]";
  await sink.emit({
    kind: "audit",
    at: new Date(0).toISOString(),
    name: "cli.diagnostics.snapshot",
    fields: {
      command: "diagnostics",
      package: await safePackageSummary(),
      platform: { os: descriptor.os, environmentKind: descriptor.environmentKind, degraded: descriptor.degraded },
      env: { DEEPSEEK_API_KEY: fakeSecret },
      authHeader: `Bearer ${fakeSecret}`,
      plugin: { authMaterial: fakeSecret, path: "C:/Users/dev/private/project" },
      mcp: { authMaterial: fakeSecret },
      visibleReasoning: {
        projection: {
          projectionId: "visible-reasoning:diagnostics",
          replayFingerprint: "visible:hdiagnostics",
          summary: { totalRecords: 2, visibleRecords: 2, evidenceLinkCount: 1 },
          rawProviderReasoning: "hidden chain-of-thought diagnostics payload"
        },
        records: [
          {
            recordId: "visible-reasoning:diagnostics:1",
            stepKind: "verification",
            status: "completed",
            summary: `Diagnostics inspected DEEPSEEK_API_KEY=${fakeSecret} through redaction policy.`,
            detail: `Private detail containing ${fakeSecret} must not leave local diagnostics.`,
            rawProviderReasoning: "raw provider reasoning is excluded"
          }
        ]
      },
      referencePitFixtureIds: [...diagnosticPitIds]
    },
    dataPrivacyClass: "secret",
    redaction: { class: "secret", fields: ["fields.env", "fields.authHeader", "fields.plugin", "fields.mcp", "fields.visibleReasoning.records.summary", "fields.visibleReasoning.projection.replayFingerprint"] }
  });
}

function diagnosticsJsonLines(result: CliDiagnosticsResult): readonly JsonObject[] {
  const entries: JsonObject[] = [{
    schemaVersion: result.schemaVersion,
    kind: result.kind,
    status: result.status,
    command: result.command,
    referencePitFixtureIds: result.referencePitFixtureIds,
    redaction: result.redaction
  }];
  if (result.bundle) {
    entries.push({
      schemaVersion: result.schemaVersion,
      kind: "diagnostics.bundle.summary",
      bundleId: result.bundle.bundleId,
      selectedRecordCount: result.bundle.selectedRecordCount,
      totalRecordCount: result.bundle.totalRecordCount,
      privacyDecision: result.bundle.privacyDecision,
      redactionSummary: result.bundle.redactionSummary,
      redaction: { class: "internal", fields: ["privacyDecision", "redactionSummary"] }
    });
  }
  if (result.externalExportDecision) {
    entries.push({
      schemaVersion: result.schemaVersion,
      kind: "diagnostics.export.decision",
      decision: result.externalExportDecision,
      redaction: { class: "internal", fields: ["decision"] }
    });
  }
  if (result.readiness) {
    for (const check of result.readiness.checks) {
      entries.push({
        schemaVersion: result.schemaVersion,
        kind: "diagnostics.readiness.check",
        check,
        redaction: { class: "internal", fields: ["check.metadata"] }
      });
    }
  }
  if (result.indexProviders) {
    entries.push({
      schemaVersion: result.schemaVersion,
      kind: "diagnostics.index-provider.summary",
      summary: result.indexProviders,
      redaction: result.indexProviders.redaction
    });
    for (const provider of result.indexProviders.providers) {
      entries.push({
        schemaVersion: result.schemaVersion,
        kind: "diagnostics.index-provider.provider",
        provider,
        redaction: provider.redaction
      });
    }
  }
  if (result.release) {
    entries.push({
      schemaVersion: result.schemaVersion,
      kind: "diagnostics.release.summary",
      status: result.release.status,
      packageSurface: result.release.packageSurface,
      verification: result.release.verification,
      supportBundle: result.release.supportBundle,
      firstPartyPluginPack: result.release.firstPartyPluginPack,
      governanceEvidenceMatrix: result.release.governanceEvidenceMatrix,
      governanceDiagnostics: result.release.governanceDiagnostics,
      packageScorecardAdvisory: result.release.packageScorecardAdvisory,
      redaction: result.release.redaction
    });
    if (result.release.firstPartyPluginPack) {
      entries.push({
        schemaVersion: result.schemaVersion,
        kind: "diagnostics.release.first-party-plugin-pack",
        firstPartyPluginPack: result.release.firstPartyPluginPack,
        redaction: result.release.firstPartyPluginPack.redaction
      });
    }
    if (result.release.packageScorecardAdvisory) {
      entries.push({
        schemaVersion: result.schemaVersion,
        kind: "diagnostics.release.package-scorecard-advisory",
        advisory: result.release.packageScorecardAdvisory,
        redaction: result.release.packageScorecardAdvisory.redaction
      });
    }
    for (const check of result.release.checks) {
      entries.push({
        schemaVersion: result.schemaVersion,
        kind: "diagnostics.release.check",
        check,
        redaction: { class: "internal", fields: ["check.metadata"] }
      });
    }
    entries.push(...governanceEvidenceMatrixJsonLines(result.schemaVersion, result.release.governanceEvidenceMatrix));
    if (result.release.governanceDiagnostics) {
      entries.push({
        schemaVersion: result.schemaVersion,
        kind: "diagnostics.governance.summary",
        governanceDiagnostics: result.release.governanceDiagnostics,
        redaction: result.release.governanceDiagnostics.redaction
      });
      for (const section of result.release.governanceDiagnostics.sections) {
        entries.push({
          schemaVersion: result.schemaVersion,
          kind: "diagnostics.governance.section",
          section,
          redaction: section.redaction
        });
      }
      for (const finding of result.release.governanceDiagnostics.findings) {
        entries.push({
          schemaVersion: result.schemaVersion,
          kind: "diagnostics.governance.finding",
          finding,
          redaction: finding.redaction
        });
      }
    }
  }
  if (result.verificationSummary) {
    entries.push({
      schemaVersion: result.schemaVersion,
      kind: "diagnostics.verify.summary",
      summary: result.verificationSummary,
      redaction: result.verificationSummary.redaction
    });
    for (const check of result.verificationSummary.blockingChecks) {
      entries.push({
        schemaVersion: result.schemaVersion,
        kind: "diagnostics.verify.blocker",
        status: "fail",
        check,
        redaction: { class: "internal", fields: ["check.metadata"] }
      });
    }
    for (const check of result.verificationSummary.warningChecks) {
      entries.push({
        schemaVersion: result.schemaVersion,
        kind: "diagnostics.verify.warning",
        status: "warn",
        check,
        redaction: { class: "internal", fields: ["check.metadata"] }
      });
    }
  }
  if (result.refresh) {
    entries.push({
      schemaVersion: result.schemaVersion,
      kind: "diagnostics.refresh.summary",
      summary: result.refresh,
      redaction: result.refresh.redaction
    });
    for (const step of result.refresh.steps) {
      entries.push(refreshStepRecord(step));
    }
    for (const diagnostic of result.refresh.diagnostics) {
      entries.push({
        schemaVersion: result.schemaVersion,
        kind: "diagnostics.refresh.diagnostic",
        diagnostic,
        redaction: diagnostic.redaction
      });
    }
  }
  if (result.environment) {
    entries.push(...environmentPrepareJsonLines(result.environment));
  }
  if (result.flow) {
    entries.push(...diagnosticsFlowInspectJsonLines(result.schemaVersion, result.flow));
  }
  if (result.capabilityMatrix) {
    entries.push(...capabilityMatrixJsonLines(result.schemaVersion, result.capabilityMatrix));
  }
  if (result.sweBench) {
    entries.push(...sweBenchPredictionJsonLines(result.sweBench));
  }
  if (result.evaluation) {
    entries.push(...evaluationJsonLines(result.evaluation));
  }
  if (result.modeMatrix) {
    entries.push({
      schemaVersion: result.schemaVersion,
      kind: "diagnostics.mode-matrix.summary",
      matrix: result.modeMatrix,
      redaction: result.modeMatrix.redaction
    });
    for (const mode of result.modeMatrix.interactionModes) {
      entries.push({
        schemaVersion: result.schemaVersion,
        kind: "diagnostics.mode-matrix.interaction",
        mode,
        redaction: mode.redaction
      });
    }
    for (const mode of result.modeMatrix.agentModes) {
      entries.push({
        schemaVersion: result.schemaVersion,
        kind: "diagnostics.mode-matrix.agent",
        mode,
        redaction: mode.redaction
      });
    }
  }
  if (result.overallDeliveryCapability) {
    entries.push({
      schemaVersion: result.schemaVersion,
      kind: "diagnostics.delivery-capability.summary",
      deliveryCapability: result.overallDeliveryCapability,
      redaction: result.overallDeliveryCapability.redaction
    });
  }
  return entries;
}

function filteredGovernance(release: DiagnosticsReleaseReadinessEvidence, filter: GovernanceDiagnosticsFilter | undefined): Pick<DiagnosticsReleaseReadinessEvidence, "governanceDiagnostics"> {
  const governanceDiagnostics = filterGovernanceDiagnostics(release.governanceDiagnostics, filter);
  return governanceDiagnostics ? { governanceDiagnostics } : {};
}

function modeMatrixStatusText(entries: readonly { readonly status: string }[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  return [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(" ");
}

async function safePackageSummary(): Promise<JsonObject> {
  const release = await collectReleaseReadinessEvidence();
  return {
    name: release.packageSurface.packageName,
    version: release.packageSurface.packageVersion
  };
}
