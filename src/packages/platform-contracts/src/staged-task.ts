import type { CompatibilityMetadata, JsonObject, RedactedError, RedactionMetadata } from "./common.js";

export const STAGED_TASK_SCHEMA_VERSION = "1.0.0";

export interface StagedTaskCompatibility extends CompatibilityMetadata {
  readonly schemaVersion: typeof STAGED_TASK_SCHEMA_VERSION;
  readonly minReaderVersion: "1.0.0";
}

export const STAGED_TASK_COMPATIBILITY: StagedTaskCompatibility = {
  schemaVersion: STAGED_TASK_SCHEMA_VERSION,
  minReaderVersion: "1.0.0"
};

export type StagedTaskStageStatus = "pending" | "ready" | "running" | "succeeded" | "failed" | "skipped";

export type StagedTaskStageKind =
  | "materialize"
  | "collect-evidence"
  | "produce"
  | "verify"
  | "repair"
  | "artifact-scan"
  | "score"
  | "synthesize";

export type StagedTaskExecutorKind =
  | "file-materialize"
  | "agent-loop"
  | "process-check"
  | "artifact-scan"
  | "manual";

export type StagedTaskRefType = "artifact" | "evidence" | "check" | "metric" | "state" | "diagnostic";

export type StagedTaskRefScope = "workspace" | "session" | "task" | "external";

export type StagedTaskEventKind =
  | "stage.ready"
  | "stage.started"
  | "stage.evaluation.required"
  | "stage.succeeded"
  | "stage.failed"
  | "stage.skipped";

export type StagedTaskProfileSource = "catalog" | "dynamic";

export type StagedTaskProfileScope = "catalog" | "session" | "task-run";

export interface StagedTaskProfileProvenance extends JsonObject {
  readonly createdBy: "human" | "model" | "controller" | "test";
  readonly reason: string;
  readonly parentProfileId?: string;
  readonly taskIntentFingerprint?: string;
}

export interface StagedTaskRef extends JsonObject {
  readonly schemaVersion: typeof STAGED_TASK_SCHEMA_VERSION;
  readonly refId: string;
  readonly type: StagedTaskRefType;
  readonly producerStageId: string;
  readonly scope: StagedTaskRefScope;
  readonly path?: string;
  readonly fingerprint?: string;
  readonly preview?: string;
  readonly metadata?: JsonObject;
  readonly compatibility: StagedTaskCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface StagedTaskBudgetPolicy extends JsonObject {
  readonly maxModelIterations?: number;
  readonly maxToolCalls?: number;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
  readonly modelProfileHint?: string;
}

export interface StagedTaskAcceptancePolicy extends JsonObject {
  readonly requiredRefs?: readonly string[];
  readonly requiredStatuses?: readonly StagedTaskStageStatus[];
  readonly requiredChecks?: readonly string[];
  readonly scoreThreshold?: number;
}

export type StagedTaskEvaluationStatus = "passed" | "needs-review" | "failed" | "blocked";

export interface StagedTaskEvaluationResult extends JsonObject {
  readonly schemaVersion: typeof STAGED_TASK_SCHEMA_VERSION;
  readonly evaluationId: string;
  readonly stageId: string;
  readonly evaluatorId: string;
  readonly status: StagedTaskEvaluationStatus;
  readonly score?: number;
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
  readonly evaluatedAt: string;
  readonly compatibility: StagedTaskCompatibility;
  readonly redaction: RedactionMetadata;
}

export type StagedTaskTechnicalDirectorDecision = "accepted" | "rejected" | "needs-review";

export interface StagedTaskTechnicalDirectorAcceptance extends JsonObject {
  readonly schemaVersion: typeof STAGED_TASK_SCHEMA_VERSION;
  readonly acceptanceId: string;
  readonly stageId: string;
  readonly reviewerId: string;
  readonly decision: StagedTaskTechnicalDirectorDecision;
  readonly criteriaApplicable: boolean;
  readonly evidenceSufficient: boolean;
  readonly reason: string;
  readonly evaluationId?: string;
  readonly acceptedAt: string;
  readonly compatibility: StagedTaskCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface StagedTaskRetryPolicy extends JsonObject {
  readonly maxAttempts?: number;
  readonly retryOn?: readonly string[];
  readonly repairStageId?: string;
}

export interface StagedTaskStageContract extends JsonObject {
  readonly schemaVersion: typeof STAGED_TASK_SCHEMA_VERSION;
  readonly stageId: string;
  readonly kind: StagedTaskStageKind;
  readonly executorKind: StagedTaskExecutorKind;
  readonly dependsOn: readonly string[];
  readonly inputRefs: readonly string[];
  readonly expectedOutputRefs: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly budget?: StagedTaskBudgetPolicy;
  readonly acceptance?: StagedTaskAcceptancePolicy;
  readonly retryPolicy?: StagedTaskRetryPolicy;
  readonly parameters?: JsonObject;
  readonly compatibility: StagedTaskCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface StagedTaskStagePatch extends JsonObject {
  readonly stageId: string;
  readonly kind?: StagedTaskStageKind;
  readonly executorKind?: StagedTaskExecutorKind;
  readonly dependsOn?: readonly string[];
  readonly inputRefs?: readonly string[];
  readonly expectedOutputRefs?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly budget?: StagedTaskBudgetPolicy;
  readonly acceptance?: StagedTaskAcceptancePolicy;
  readonly retryPolicy?: StagedTaskRetryPolicy;
  readonly parameters?: JsonObject;
  readonly redaction?: RedactionMetadata;
}

export interface StagedTaskGraph extends JsonObject {
  readonly schemaVersion: typeof STAGED_TASK_SCHEMA_VERSION;
  readonly graphId: string;
  readonly profileId: string;
  readonly stages: readonly StagedTaskStageContract[];
  readonly refs: readonly StagedTaskRef[];
  readonly metadata?: JsonObject;
  readonly compatibility: StagedTaskCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface StagedTaskStageState extends JsonObject {
  readonly stageId: string;
  readonly status: StagedTaskStageStatus;
  readonly attempts: number;
  readonly inputRefs: readonly string[];
  readonly outputRefs: readonly string[];
  readonly evaluation?: StagedTaskEvaluationResult;
  readonly technicalDirectorAcceptance?: StagedTaskTechnicalDirectorAcceptance;
  readonly diagnostics: readonly RedactedError[];
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly redaction?: RedactionMetadata;
}

export interface StagedTaskRunState extends JsonObject {
  readonly schemaVersion: typeof STAGED_TASK_SCHEMA_VERSION;
  readonly taskRunId: string;
  readonly graphId: string;
  readonly profileId: string;
  readonly stageStates: readonly StagedTaskStageState[];
  readonly refs: readonly StagedTaskRef[];
  readonly events: readonly StagedTaskStageEvent[];
  readonly diagnostics?: readonly RedactedError[];
  readonly compatibility: StagedTaskCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface StagedTaskStageEvent extends JsonObject {
  readonly schemaVersion: typeof STAGED_TASK_SCHEMA_VERSION;
  readonly eventId: string;
  readonly kind: StagedTaskEventKind;
  readonly taskRunId: string;
  readonly graphId: string;
  readonly stageId: string;
  readonly at: string;
  readonly outputRefs?: readonly StagedTaskRef[];
  readonly evaluation?: StagedTaskEvaluationResult;
  readonly technicalDirectorAcceptance?: StagedTaskTechnicalDirectorAcceptance;
  readonly diagnostics: readonly RedactedError[];
  readonly compatibility: StagedTaskCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface StagedTaskExecutionResult extends JsonObject {
  readonly schemaVersion: typeof STAGED_TASK_SCHEMA_VERSION;
  readonly status: "succeeded" | "failed" | "skipped";
  readonly outputRefs: readonly StagedTaskRef[];
  readonly evaluation?: StagedTaskEvaluationResult;
  readonly technicalDirectorAcceptance?: StagedTaskTechnicalDirectorAcceptance;
  readonly diagnostics: readonly RedactedError[];
  readonly compatibility: StagedTaskCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface StagedTaskProfileRecord extends JsonObject {
  readonly schemaVersion: typeof STAGED_TASK_SCHEMA_VERSION;
  readonly profileId: string;
  readonly title: string;
  readonly domain: string;
  readonly source?: StagedTaskProfileSource;
  readonly scope?: StagedTaskProfileScope;
  readonly provenance?: StagedTaskProfileProvenance;
  readonly baseProfileId?: string;
  readonly fragments: readonly string[];
  readonly overlays: readonly string[];
  readonly parameters?: JsonObject;
  readonly stagePatches?: readonly StagedTaskStagePatch[];
  readonly compatibility: StagedTaskCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface StagedTaskCompiledProfile extends JsonObject {
  readonly schemaVersion: typeof STAGED_TASK_SCHEMA_VERSION;
  readonly profileId: string;
  readonly fingerprint: string;
  readonly graph: StagedTaskGraph;
  readonly sourceProfile: StagedTaskProfileRecord;
  readonly appliedFragments: readonly string[];
  readonly appliedOverlays: readonly string[];
  readonly compatibility: StagedTaskCompatibility;
  readonly redaction: RedactionMetadata;
}
