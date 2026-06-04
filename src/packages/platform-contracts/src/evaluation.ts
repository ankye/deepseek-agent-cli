import type { JsonObject, RedactionMetadata } from "./common.js";
import type { AgentLoopBudgetKind, AgentPhaseName } from "./agent-mode.js";
import type { EvidenceManifestStatus } from "./evidence-first.js";
import type { PackageScorecardAggregate, PackageScorecardSummary } from "./package-scorecard.js";
import type { ReadinessStatus } from "./readiness.js";
import type { StagedTaskGraph, StagedTaskRunState } from "./staged-task.js";
import type { ToolFamilyParityMatrix } from "./tool-family.js";

export const CLI_TASK_EVALUATION_SCHEMA_VERSION = "1.0.0";

export type CliEvaluationMode = "smoke" | "full";
export type CliEvaluationBaselineKind = "deepseek-cli" | "external-cli" | "manual-import";
export type CliEvaluationBaselineStatus = "available" | "deferred" | "unavailable";
export type CliEvaluationOutcome = "solved" | "partial" | "failed" | "invalid" | "planned" | "deferred";
export type CliEvaluationCheckStatus = "pass" | "fail" | "skipped";
export type CliEvaluationMetricAvailabilityStatus = "instrumented" | "inferred" | "unavailable";
export type CliEvaluationQualityStatus = "pass" | "partial" | "fail" | "missing" | "unavailable";
export type CliEvaluationInstrumentationEventKind =
  | "run_started"
  | "workspace_created"
  | "prompt_written"
  | "prompt_sent"
  | "command_started"
  | "command_finished"
  | "checker_started"
  | "checker_finished"
  | "artifact_scan_started"
  | "artifact_scan_finished"
  | "evidence_written"
  | "run_finished";

export interface CliEvaluationMetricAvailability extends JsonObject {
  readonly metric: string;
  readonly status: CliEvaluationMetricAvailabilityStatus;
  readonly reason: string;
  readonly redaction: RedactionMetadata;
}

export interface CliEvaluationPhaseUsageMetric extends JsonObject {
  readonly phase: AgentPhaseName | string;
  readonly used: boolean;
  readonly required?: boolean;
  readonly skipped?: boolean;
  readonly evidenceSource: "runtime-event" | "checker" | "inferred" | "unavailable";
  readonly redaction: RedactionMetadata;
}

export interface CliEvaluationLoopBudgetMetric extends JsonObject {
  readonly kind: AgentLoopBudgetKind | string;
  readonly requested?: number;
  readonly allowed?: number;
  readonly consumed?: number;
  readonly remaining?: number;
  readonly stopReason?: string;
  readonly evidenceSource: "runtime-event" | "inferred" | "unavailable";
  readonly redaction: RedactionMetadata;
}

export interface CliEvaluationTaskDefinition extends JsonObject {
  readonly schemaVersion: string;
  readonly taskId: string;
  readonly title: string;
  readonly category: string;
  readonly fixtureId: string;
  readonly workspaceSnapshotId: string;
  readonly promptDigest: string;
  readonly promptSummary: string;
  readonly allowedCapabilityProfile: string;
  readonly timeBudgetMs: number;
  readonly checkCommands: readonly string[];
  readonly scoringRubricId: string;
  readonly mode: CliEvaluationMode;
  readonly redaction: RedactionMetadata;
}

export interface CliEvaluationBaselineDefinition extends JsonObject {
  readonly baselineId: string;
  readonly label: string;
  readonly kind: CliEvaluationBaselineKind;
  readonly status: CliEvaluationBaselineStatus;
  readonly versionCommand?: string;
  readonly commandFingerprint?: string;
  readonly probeExitCode?: number;
  readonly probeOutputPreview?: string;
  readonly configured: boolean;
  readonly diagnostics: readonly CliEvaluationDiagnostic[];
  readonly redaction: RedactionMetadata;
}

export interface CliEvaluationCheckResult extends JsonObject {
  readonly command: string;
  readonly status: CliEvaluationCheckStatus;
  readonly exitCode?: number;
  readonly evidencePath?: string;
  readonly stdoutPreview?: string;
  readonly stderrPreview?: string;
  readonly redaction: RedactionMetadata;
}

export interface CliEvaluationRunMetrics extends JsonObject {
  readonly elapsedMs?: number;
  readonly firstRunSuccess?: boolean;
  readonly checkPassRate?: number;
  readonly retryCount: number;
  readonly userInterventionCount: number;
  readonly safetyViolationCount: number;
  readonly correctionCount?: number;
  readonly commandRunCount?: number;
  readonly commandSuccessCount?: number;
  readonly commandSuccessRate?: number;
  readonly commandFailureCount?: number;
  readonly patchFileCount?: number;
  readonly patchLineDelta?: number;
  readonly generatedFileCount?: number;
  readonly generatedHtmlFileCount?: number;
  readonly generatedCssFileCount?: number;
  readonly generatedJsFileCount?: number;
  readonly generatedByteTotal?: number;
  readonly largestGeneratedFileBytes?: number;
  readonly codeStructureScore?: number;
  readonly contextRecallQuality?: "good" | "partial" | "missing" | "not-applicable";
  readonly recoveryUsed: boolean;
  readonly firstPassSuccess?: boolean;
  readonly repairActivationCount?: number;
  readonly repairSuccessCount?: number;
  readonly repairSuccessRate?: number;
  readonly failedVerificationCount?: number;
  readonly correctedVerificationCount?: number;
  readonly repeatedIneffectiveAttemptCount?: number;
  readonly repairStopReason?: string;
  readonly repairMetricsAvailability?: "available" | "unavailable" | "inferred";
  readonly estimatedCostUsd?: number;
  readonly promptAssemblyAvailable?: boolean;
  readonly promptAssemblySectionCount?: number;
  readonly promptAssemblyExcludedSectionCount?: number;
  readonly promptAssemblyBudgetStatus?: string;
  readonly promptAssemblyVisibleToolCount?: number;
  readonly promptAssemblyFingerprint?: string;
  readonly promptAssemblyGapReason?: "missing-output-contract" | "dropped-context" | "insufficient-tool-visibility" | "provider-readiness-failure" | "post-assembly-model-failure" | "not-applicable";
  readonly phaseUsage?: readonly CliEvaluationPhaseUsageMetric[];
  readonly loopBudgets?: readonly CliEvaluationLoopBudgetMetric[];
  readonly workerFanOut?: number;
  readonly overDelegationFlag?: boolean;
  readonly overDelegationReason?: string;
  readonly verifierQuality?: CliEvaluationQualityStatus;
  readonly repairQuality?: CliEvaluationQualityStatus;
  readonly reasoningEffort?: string;
  readonly providerMappedEffort?: string;
  readonly evidenceCredit?: boolean;
  readonly verificationCredit?: boolean;
  readonly repairCredit?: boolean;
  readonly reconciliationCredit?: boolean;
  readonly metricAvailability?: readonly CliEvaluationMetricAvailability[];
  readonly evidencePlanPresent?: boolean;
  readonly evidenceItemCount?: number;
  readonly evidenceSourceCoverageRate?: number;
  readonly claimGroundingRate?: number;
  readonly unsupportedClaimCount?: number;
  readonly assumptionCount?: number;
  readonly hallucinatedCommandCount?: number;
  readonly evidenceManifestStatus?: EvidenceManifestStatus;
  readonly redaction: RedactionMetadata;
}

export interface CliEvaluationDiagnostic extends JsonObject {
  readonly code: string;
  readonly severity: "info" | "warn" | "error";
  readonly message: string;
  readonly metadata?: JsonObject;
  readonly redaction: RedactionMetadata;
}

export interface CliEvaluationInstrumentationEvent extends JsonObject {
  readonly schemaVersion: string;
  readonly eventId: string;
  readonly kind: CliEvaluationInstrumentationEventKind;
  readonly runId: string;
  readonly baselineId: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly metadata: JsonObject;
  readonly redaction: RedactionMetadata;
}

export interface CliEvaluationStagedTaskSnapshot extends JsonObject {
  readonly schemaVersion: string;
  readonly profileId: string;
  readonly graphId: string;
  readonly profileFingerprint: string;
  readonly stageCount: number;
  readonly refCount: number;
  readonly executorKinds: readonly string[];
  readonly graph: StagedTaskGraph;
  readonly runState: StagedTaskRunState;
  readonly redaction: RedactionMetadata;
}

export interface CliEvaluationTaskRunRecord extends JsonObject {
  readonly schemaVersion: string;
  readonly kind: "cli.evaluation.task-run";
  readonly runId: string;
  readonly task: CliEvaluationTaskDefinition;
  readonly baseline: CliEvaluationBaselineDefinition;
  readonly dryRun: boolean;
  readonly outcome: CliEvaluationOutcome;
  readonly checks: readonly CliEvaluationCheckResult[];
  readonly metrics: CliEvaluationRunMetrics;
  readonly stagedTask?: CliEvaluationStagedTaskSnapshot;
  readonly instrumentationEvents: readonly CliEvaluationInstrumentationEvent[];
  readonly diagnostics: readonly CliEvaluationDiagnostic[];
  readonly evidencePaths: readonly string[];
  readonly redaction: RedactionMetadata;
}

export interface CliEvaluationPublicBenchmarkReference extends JsonObject {
  readonly name: string;
  readonly url?: string;
  readonly observedAt: string;
  readonly note: string;
  readonly advisoryOnly: boolean;
  readonly redaction: RedactionMetadata;
}

export interface CliEvaluationBaselineAggregate extends JsonObject {
  readonly baselineId: string;
  readonly taskRunCount: number;
  readonly executedRunCount: number;
  readonly solvedRunCount: number;
  readonly failedRunCount: number;
  readonly deferredRunCount: number;
  readonly invalidRunCount: number;
  readonly successRate?: number;
  readonly firstRunSuccessRate?: number;
  readonly checkPassRate?: number;
  readonly correctionRate?: number;
  readonly commandRunCount?: number;
  readonly commandSuccessCount?: number;
  readonly commandSuccessRate?: number;
  readonly averageStructureScore?: number;
  readonly averageElapsedMs?: number;
  readonly repairActivationCount?: number;
  readonly repairSuccessCount?: number;
  readonly repairSuccessRate?: number;
  readonly evidenceCreditRate?: number;
  readonly verificationCreditRate?: number;
  readonly repairCreditRate?: number;
  readonly reconciliationCreditRate?: number;
  readonly overDelegationRate?: number;
  readonly averageWorkerFanOut?: number;
  readonly unavailableMetricCount?: number;
  readonly inferredMetricCount?: number;
  readonly redaction: RedactionMetadata;
}

export interface CliEvaluationGapFinding extends JsonObject {
  readonly code: string;
  readonly severity: "info" | "warn" | "error";
  readonly baselineId: string;
  readonly comparedBaselineId?: string;
  readonly metric: string;
  readonly message: string;
  readonly delta?: number;
  readonly redaction: RedactionMetadata;
}

export interface CliEvaluationComparisonSummary extends JsonObject {
  readonly schemaVersion: string;
  readonly kind: "cli.evaluation.comparison.summary";
  readonly status: ReadinessStatus;
  readonly mode: CliEvaluationMode;
  readonly dryRun: boolean;
  readonly taskCatalogVersion: string;
  readonly reportTimestamp: string;
  readonly baselines: readonly CliEvaluationBaselineDefinition[];
  readonly taskRuns: readonly CliEvaluationTaskRunRecord[];
  readonly baselineAggregates: readonly CliEvaluationBaselineAggregate[];
  readonly packageScorecardCatalogVersion?: string;
  readonly packageScorecards?: readonly PackageScorecardSummary[];
  readonly packageScorecardAggregate?: PackageScorecardAggregate;
  readonly toolFamilyParityMatrix?: ToolFamilyParityMatrix;
  readonly gapFindings: readonly CliEvaluationGapFinding[];
  readonly publicBenchmarkReferences: readonly CliEvaluationPublicBenchmarkReference[];
  readonly evidencePaths: readonly string[];
  readonly diagnostics: readonly CliEvaluationDiagnostic[];
  readonly nextAction: string;
  readonly redaction: RedactionMetadata;
}
