import type { CompatibilityMetadata, JsonObject, RedactedError, RedactionMetadata } from "./common.js";
import type { StagedTaskBudgetPolicy } from "./staged-task.js";

export const TASK_DELIVERY_FLOW_SCHEMA_VERSION = "1.0.0";

export interface TaskDeliveryFlowCompatibility extends CompatibilityMetadata {
  readonly schemaVersion: typeof TASK_DELIVERY_FLOW_SCHEMA_VERSION;
  readonly minReaderVersion: "1.0.0";
}

export const TASK_DELIVERY_FLOW_COMPATIBILITY: TaskDeliveryFlowCompatibility = {
  schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
  minReaderVersion: "1.0.0"
};

export type TaskDeliveryPhase =
  | "intake"
  | "goal"
  | "planning"
  | "runtime"
  | "executor"
  | "proof"
  | "acceptance"
  | "delivery";

export type TaskIntentKind = "coding" | "evaluation" | "diagnostics" | "design" | "release" | "chat" | "unknown";
export type TaskRiskLevel = "low" | "medium" | "high";
export type TaskGuidanceKind = "correction" | "constraint" | "priority_change" | "scope_change" | "provider_change" | "approval" | "stop" | "continue";
export type TaskDecisionReturn = "accepted" | "repair_required" | "replan_required" | "goal_refinement_required" | "intake_required" | "verify_required" | "blocked";
export type TaskDeliveryPlanningMode = "catalog-profile" | "dynamic-profile" | "continue-existing" | "ask-user" | "deterministic";
export type TaskDecisionReplanScope = "none" | "plan_patch" | "replan" | "acceptance_refinement" | "goal_refinement" | "intake";
export type TaskDeliveryPhaseStatus = "required" | "running" | "completed" | "skipped" | "failed" | "blocked";
export type TaskDeliveryStatus = "ready" | "returned" | "blocked" | "delivered";

export interface TaskAcceptanceCriterion extends JsonObject {
  readonly criterionId: string;
  readonly description: string;
  readonly required: boolean;
  readonly evidenceRefs?: readonly string[];
  readonly checkIds?: readonly string[];
}

export interface TaskBrief extends JsonObject {
  readonly schemaVersion: typeof TASK_DELIVERY_FLOW_SCHEMA_VERSION;
  readonly briefId: string;
  readonly rawInput: string;
  readonly normalizedIntent: string;
  readonly intentKind: TaskIntentKind;
  readonly confidence: number;
  readonly contextRequirements: readonly string[];
  readonly assumptions: readonly string[];
  readonly missingInfo: readonly string[];
  readonly needsUserConfirmation: boolean;
  readonly compatibility: TaskDeliveryFlowCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface TaskGoal extends JsonObject {
  readonly schemaVersion: typeof TASK_DELIVERY_FLOW_SCHEMA_VERSION;
  readonly goalId: string;
  readonly briefId: string;
  readonly statement: string;
  readonly taskKind: TaskIntentKind;
  readonly riskLevel: TaskRiskLevel;
  readonly acceptanceCriteria: readonly TaskAcceptanceCriterion[];
  readonly nonGoals: readonly string[];
  readonly budgetPolicy?: StagedTaskBudgetPolicy;
  readonly compatibility: TaskDeliveryFlowCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface TaskDeliveryPlanStep extends JsonObject {
  readonly stepId: string;
  readonly phase: TaskDeliveryPhase;
  readonly description: string;
  readonly expectedRefs: readonly string[];
  readonly status?: TaskDeliveryPhaseStatus;
  readonly dependsOn?: readonly string[];
  readonly allowedTools?: readonly string[];
}

export interface TaskDecisionRequest extends JsonObject {
  readonly schemaVersion: typeof TASK_DELIVERY_FLOW_SCHEMA_VERSION;
  readonly requestId: string;
  readonly brief: TaskBrief;
  readonly evidenceRefs: readonly string[];
  readonly constraints: readonly string[];
  readonly allowedTools: readonly string[];
  readonly riskLevel: TaskRiskLevel;
  readonly candidateProfiles: readonly string[];
  readonly acceptanceDraft: readonly TaskAcceptanceCriterion[];
  readonly outputSchema?: JsonObject;
  readonly compatibility: TaskDeliveryFlowCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface TaskDecisionEnvelope extends JsonObject {
  readonly schemaVersion: typeof TASK_DELIVERY_FLOW_SCHEMA_VERSION;
  readonly decisionId: string;
  readonly requestId: string;
  readonly intentDecision: string;
  readonly goalProposal: TaskGoal;
  readonly acceptanceCriteria: readonly TaskAcceptanceCriterion[];
  readonly planSteps: readonly TaskDeliveryPlanStep[];
  readonly profileSelection?: string;
  readonly dynamicProfileProposal?: JsonObject;
  readonly toolStrategy: readonly string[];
  readonly verificationPlan: readonly string[];
  readonly repairPolicy: readonly string[];
  readonly stopConditions: readonly string[];
  readonly questionsForUser: readonly string[];
  readonly confidence: number;
  readonly assumptions: readonly string[];
  readonly compatibility: TaskDeliveryFlowCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface TaskDeliveryPlan extends JsonObject {
  readonly schemaVersion: typeof TASK_DELIVERY_FLOW_SCHEMA_VERSION;
  readonly planId: string;
  readonly goalId: string;
  readonly decisionId?: string;
  readonly planningMode: TaskDeliveryPlanningMode;
  readonly selectedProfileId?: string;
  readonly candidateProfileIds: readonly string[];
  readonly requiresDynamicProfile: boolean;
  readonly requiresUserInput: boolean;
  readonly steps: readonly TaskDeliveryPlanStep[];
  readonly compatibility: TaskDeliveryFlowCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface TaskGuidanceEvent extends JsonObject {
  readonly schemaVersion: typeof TASK_DELIVERY_FLOW_SCHEMA_VERSION;
  readonly guidanceEventId: string;
  readonly rawInput: string;
  readonly guidanceKind: TaskGuidanceKind;
  readonly targetDecisionId?: string;
  readonly confidence: number;
  readonly compatibility: TaskDeliveryFlowCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface DecisionInvalidation extends JsonObject {
  readonly schemaVersion: typeof TASK_DELIVERY_FLOW_SCHEMA_VERSION;
  readonly invalidationId: string;
  readonly guidanceEventId: string;
  readonly previousDecisionId?: string;
  readonly preservedFields: readonly string[];
  readonly invalidatedFields: readonly string[];
  readonly preservedEvidenceRefs: readonly string[];
  readonly replanScope: TaskDecisionReplanScope;
  readonly reason: string;
  readonly recommendedReturnPhase: TaskDeliveryPhase;
  readonly compatibility: TaskDeliveryFlowCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface TaskAcceptanceReview extends JsonObject {
  readonly schemaVersion: typeof TASK_DELIVERY_FLOW_SCHEMA_VERSION;
  readonly reviewId: string;
  readonly goalId: string;
  readonly decision: TaskDecisionReturn;
  readonly failedCriteriaIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly recommendedReturnPhase: TaskDeliveryPhase;
  readonly failureCode?: string;
  readonly repairBudgetRemaining: number;
  readonly diagnostics?: readonly RedactedError[];
  readonly compatibility: TaskDeliveryFlowCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface TaskDeliveryDecision extends JsonObject {
  readonly schemaVersion: typeof TASK_DELIVERY_FLOW_SCHEMA_VERSION;
  readonly decisionId: string;
  readonly status: TaskDeliveryStatus;
  readonly nextPhase?: TaskDeliveryPhase;
  readonly reason: string;
  readonly acceptanceReviewId: string;
  readonly compatibility: TaskDeliveryFlowCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface TaskDeliveryPhaseRecord extends JsonObject {
  readonly schemaVersion: typeof TASK_DELIVERY_FLOW_SCHEMA_VERSION;
  readonly phase: TaskDeliveryPhase;
  readonly status: TaskDeliveryPhaseStatus;
  readonly evidenceRefs: readonly string[];
  readonly diagnostics: readonly RedactedError[];
  readonly compatibility: TaskDeliveryFlowCompatibility;
  readonly redaction: RedactionMetadata;
}

export interface TaskDeliveryFlowSummary extends JsonObject {
  readonly schemaVersion: typeof TASK_DELIVERY_FLOW_SCHEMA_VERSION;
  readonly summaryId: string;
  readonly brief: TaskBrief;
  readonly decisionRequest: TaskDecisionRequest;
  readonly decisionEnvelope?: TaskDecisionEnvelope;
  readonly goal: TaskGoal;
  readonly plan: TaskDeliveryPlan;
  readonly phases: readonly TaskDeliveryPhaseRecord[];
  readonly acceptance: TaskAcceptanceReview;
  readonly delivery: TaskDeliveryDecision;
  readonly diagnostics: readonly RedactedError[];
  readonly compatibility: TaskDeliveryFlowCompatibility;
  readonly redaction: RedactionMetadata;
}
