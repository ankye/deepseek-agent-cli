import type {
  DecisionInvalidation,
  RedactedError,
  TaskAcceptanceReview,
  TaskBrief,
  TaskDecisionEnvelope,
  TaskDecisionRequest,
  TaskDeliveryDecision,
  TaskDeliveryFlowSummary,
  TaskDeliveryPhase,
  TaskDeliveryPhaseRecord,
  TaskDeliveryPhaseStatus,
  TaskDeliveryPlan,
  TaskDeliveryStatus,
  TaskGoal,
  TaskGuidanceEvent,
  TaskIntentKind,
  TaskRiskLevel,
  JsonObject
} from "@deepseek/platform-contracts";
import {
  TASK_DELIVERY_FLOW_COMPATIBILITY,
  TASK_DELIVERY_FLOW_SCHEMA_VERSION
} from "@deepseek/platform-contracts";
import { stableHash } from "./trace.js";

export interface CreateTaskBriefOptions {
  readonly rawInput: string;
  readonly activeTaskAvailable?: boolean;
}

export interface CreateTaskDecisionRequestOptions {
  readonly evidenceRefs?: readonly string[];
  readonly constraints?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly candidateProfiles?: readonly string[];
  readonly riskLevel?: TaskRiskLevel;
}

export interface CreateTaskGoalOptions {
  readonly statement?: string;
  readonly acceptanceEvidenceRefs?: readonly string[];
  readonly nonGoals?: readonly string[];
  readonly riskLevel?: TaskRiskLevel;
}

export interface CreateTaskDeliveryPlanOptions {
  readonly decisionId?: string;
  readonly selectedProfileId?: string;
  readonly candidateProfileIds?: readonly string[];
  readonly requiresDynamicProfile?: boolean;
  readonly requiresUserInput?: boolean;
}

export interface ReviewTaskAcceptanceOptions {
  readonly evidenceRefs: readonly string[];
  readonly completedCheckIds: readonly string[];
  readonly repairBudgetRemaining: number;
}

export interface InvalidateTaskDecisionOptions {
  readonly preservedEvidenceRefs?: readonly string[];
}

export interface CreateTaskDeliveryFlowSummaryOptions {
  readonly rawInput: string;
  readonly activeTaskAvailable?: boolean;
  readonly evidenceRefs?: readonly string[];
  readonly completedCheckIds?: readonly string[];
}

export type DeterministicTaskDeliveryFlowSummary = TaskDeliveryFlowSummary & {
  readonly decisionEnvelope: TaskDecisionEnvelope;
};

export function createTaskBrief(options: CreateTaskBriefOptions): TaskBrief {
  const rawInput = options.rawInput.trim();
  const lower = rawInput.toLowerCase();
  const activeTaskAvailable = options.activeTaskAvailable === true;
  const classification = classifyIntent(lower, activeTaskAvailable);
  return {
    schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
    briefId: `task-brief:${stableHash(`${rawInput}:${classification.normalizedIntent}`)}`,
    rawInput,
    normalizedIntent: classification.normalizedIntent,
    intentKind: classification.intentKind,
    confidence: classification.confidence,
    contextRequirements: classification.contextRequirements,
    assumptions: classification.assumptions,
    missingInfo: classification.missingInfo,
    needsUserConfirmation: classification.needsUserConfirmation,
    compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
    redaction: { class: "internal", fields: ["rawInput"] }
  };
}

export function createTaskDecisionRequest(brief: TaskBrief, options: CreateTaskDecisionRequestOptions = {}): TaskDecisionRequest {
  const riskLevel = options.riskLevel ?? riskForIntent(brief.intentKind);
  const acceptanceDraft = defaultAcceptanceCriteria(options.evidenceRefs ?? ["ref:proof"]);
  return {
    schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
    requestId: `task-decision-request:${stableHash(`${brief.briefId}:${brief.normalizedIntent}`)}`,
    brief,
    evidenceRefs: options.evidenceRefs ?? ["ref:project-rules", "ref:active-task"],
    constraints: options.constraints ?? [
      "Use prompt assembly for model-bound decisions.",
      "Return structured task decisions; do not claim completion."
    ],
    allowedTools: options.allowedTools ?? ["workspace.read", "process.check"],
    riskLevel,
    candidateProfiles: options.candidateProfiles ?? ["coding/general.v1"],
    acceptanceDraft,
    outputSchema: { kind: "TaskDecisionEnvelope" },
    compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
    redaction: { class: "internal", fields: ["brief.rawInput"] }
  };
}

export function createTaskGoal(brief: TaskBrief, options: CreateTaskGoalOptions = {}): TaskGoal {
  const riskLevel = options.riskLevel ?? riskForIntent(brief.intentKind);
  return {
    schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
    goalId: `task-goal:${stableHash(`${brief.briefId}:${options.statement ?? brief.normalizedIntent}`)}`,
    briefId: brief.briefId,
    statement: options.statement ?? defaultGoalStatement(brief),
    taskKind: brief.intentKind === "unknown" ? "coding" : brief.intentKind,
    riskLevel,
    acceptanceCriteria: defaultAcceptanceCriteria(options.acceptanceEvidenceRefs ?? ["ref:proof"]),
    nonGoals: options.nonGoals ?? ["Do not mutate unrelated files.", "Do not report delivery before acceptance evidence exists."],
    compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
    redaction: { class: "internal" }
  };
}

export function createTaskDeliveryPlan(goal: TaskGoal, options: CreateTaskDeliveryPlanOptions = {}): TaskDeliveryPlan {
  const selectedProfileId = options.selectedProfileId;
  const requiresDynamicProfile = options.requiresDynamicProfile ?? false;
  const requiresUserInput = options.requiresUserInput ?? false;
  return {
    schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
    planId: `task-plan:${stableHash(`${goal.goalId}:${selectedProfileId ?? "deterministic"}`)}`,
    goalId: goal.goalId,
    ...(options.decisionId ? { decisionId: options.decisionId } : {}),
    planningMode: requiresUserInput
      ? "ask-user"
      : requiresDynamicProfile
        ? "dynamic-profile"
        : selectedProfileId
          ? "catalog-profile"
          : "deterministic",
    ...(selectedProfileId ? { selectedProfileId } : {}),
    candidateProfileIds: options.candidateProfileIds ?? (selectedProfileId ? [selectedProfileId] : ["coding/general.v1"]),
    requiresDynamicProfile,
    requiresUserInput,
    steps: [
      {
        stepId: "task-step:runtime",
        phase: "runtime",
        description: "Run the selected runtime path with governed tools.",
        expectedRefs: ["ref:runtime-result"],
        status: "required"
      },
      {
        stepId: "task-step:proof",
        phase: "proof",
        description: "Collect proof evidence before acceptance.",
        expectedRefs: goal.acceptanceCriteria.flatMap((criterion) => criterion.evidenceRefs ?? []),
        status: "required",
        dependsOn: ["task-step:runtime"]
      },
      {
        stepId: "task-step:acceptance",
        phase: "acceptance",
        description: "Review required criteria before delivery.",
        expectedRefs: ["ref:acceptance-review"],
        status: "required",
        dependsOn: ["task-step:proof"]
      },
      {
        stepId: "task-step:delivery",
        phase: "delivery",
        description: "Deliver only after acceptance succeeds.",
        expectedRefs: ["ref:delivery"],
        status: "required",
        dependsOn: ["task-step:acceptance"]
      }
    ],
    compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
    redaction: { class: "internal" }
  };
}

export function reviewTaskAcceptance(goal: TaskGoal, options: ReviewTaskAcceptanceOptions): TaskAcceptanceReview {
  const failedCriteriaIds = goal.acceptanceCriteria
    .filter((criterion) => criterion.required)
    .filter((criterion) => !criterionAccepted(criterion.evidenceRefs ?? [], criterion.checkIds ?? [], options))
    .map((criterion) => criterion.criterionId);
  const accepted = failedCriteriaIds.length === 0;
  return {
    schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
    reviewId: `task-acceptance:${stableHash(`${goal.goalId}:${options.evidenceRefs.join(",")}:${options.completedCheckIds.join(",")}`)}`,
    goalId: goal.goalId,
    decision: accepted ? "accepted" : options.repairBudgetRemaining > 0 ? "verify_required" : "blocked",
    failedCriteriaIds,
    evidenceRefs: options.evidenceRefs,
    recommendedReturnPhase: accepted ? "delivery" : options.repairBudgetRemaining > 0 ? "proof" : "acceptance",
    ...(accepted ? {} : { failureCode: options.repairBudgetRemaining > 0 ? "TASK_ACCEPTANCE_EVIDENCE_MISSING" : "TASK_ACCEPTANCE_BUDGET_EXHAUSTED" }),
    repairBudgetRemaining: options.repairBudgetRemaining,
    compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
    redaction: { class: "internal" }
  };
}

export function classifyTaskGuidance(rawInput: string, targetDecisionId?: string): TaskGuidanceEvent {
  const text = rawInput.trim();
  const lower = text.toLowerCase();
  const guidanceKind = lower.includes("glm") || lower.includes("provider") || lower.includes("模型")
    ? "provider_change"
    : lower.includes("stop") || lower.includes("停止")
      ? "stop"
      : lower.includes("继续") || lower.includes("continue")
        ? "continue"
        : lower.includes("优先") || lower.includes("priority")
          ? "priority_change"
          : lower.includes("范围") || lower.includes("scope")
            ? "scope_change"
            : lower.includes("批准") || lower.includes("approval")
              ? "approval"
              : "correction";
  return {
    schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
    guidanceEventId: `task-guidance:${stableHash(`${text}:${targetDecisionId ?? "none"}`)}`,
    rawInput: text,
    guidanceKind,
    ...(targetDecisionId ? { targetDecisionId } : {}),
    confidence: guidanceKind === "provider_change" ? 0.92 : 0.72,
    compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
    redaction: { class: "internal", fields: ["rawInput"] }
  };
}

export function invalidateTaskDecision(
  guidance: TaskGuidanceEvent,
  decision: TaskDecisionEnvelope,
  options: InvalidateTaskDecisionOptions = {}
): DecisionInvalidation {
  const preservedEvidenceRefs = options.preservedEvidenceRefs ?? [];
  const invalidation = invalidationForGuidance(guidance.guidanceKind);
  return {
    schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
    invalidationId: `decision-invalidation:${stableHash(`${guidance.guidanceEventId}:${decision.decisionId}`)}`,
    guidanceEventId: guidance.guidanceEventId,
    previousDecisionId: decision.decisionId,
    preservedFields: invalidation.preservedFields,
    invalidatedFields: invalidation.invalidatedFields,
    preservedEvidenceRefs,
    replanScope: invalidation.replanScope,
    reason: invalidation.reason,
    recommendedReturnPhase: invalidation.recommendedReturnPhase,
    compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
    redaction: { class: "internal" }
  };
}

export function createTaskDeliveryFlowSummary(options: CreateTaskDeliveryFlowSummaryOptions): DeterministicTaskDeliveryFlowSummary {
  const brief = createTaskBrief({
    rawInput: options.rawInput,
    ...(options.activeTaskAvailable !== undefined ? { activeTaskAvailable: options.activeTaskAvailable } : {})
  });
  const decisionRequest = createTaskDecisionRequest(brief);
  const goal = createTaskGoal(brief);
  const decisionEnvelope = createDeterministicDecisionEnvelope(decisionRequest, goal);
  const plan = createTaskDeliveryPlan(goal, {
    decisionId: decisionEnvelope.decisionId,
    ...(decisionEnvelope.profileSelection ? { selectedProfileId: decisionEnvelope.profileSelection } : {}),
    candidateProfileIds: decisionRequest.candidateProfiles,
    requiresUserInput: brief.needsUserConfirmation
  });
  const acceptance = reviewTaskAcceptance(goal, {
    evidenceRefs: options.evidenceRefs ?? [],
    completedCheckIds: options.completedCheckIds ?? [],
    repairBudgetRemaining: 1
  });
  const deliveryStatus: TaskDeliveryStatus = acceptance.decision === "accepted"
    ? "delivered"
    : acceptance.decision === "blocked"
      ? "blocked"
      : "returned";
  const delivery: TaskDeliveryDecision = {
    schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
    decisionId: `task-delivery:${stableHash(`${acceptance.reviewId}:${deliveryStatus}`)}`,
    status: deliveryStatus,
    ...(deliveryStatus === "returned" ? { nextPhase: acceptance.recommendedReturnPhase } : {}),
    reason: deliveryStatus === "delivered" ? "Acceptance criteria passed." : "Acceptance review returned the task to the owning phase.",
    acceptanceReviewId: acceptance.reviewId,
    compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
    redaction: { class: "internal" as const }
  };
  return {
    schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
    summaryId: `task-flow:${stableHash(`${brief.briefId}:${delivery.decisionId}`)}`,
    brief,
    decisionRequest,
    decisionEnvelope,
    goal,
    plan,
    phases: createPhaseRecords(plan, acceptance),
    acceptance,
    delivery,
    diagnostics: brief.needsUserConfirmation ? [diagnostic("TASK_BRIEF_NEEDS_USER_CONFIRMATION", "Task brief requires user confirmation before execution.")] : [],
    compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
    redaction: { class: "internal", fields: ["brief.rawInput"] }
  };
}

export function taskDeliveryFlowEventData(summary: TaskDeliveryFlowSummary): JsonObject {
  return {
    schemaVersion: summary.schemaVersion,
    summaryId: summary.summaryId,
    briefId: summary.brief.briefId,
    decisionRequestId: summary.decisionRequest.requestId,
    ...(summary.decisionEnvelope ? { decisionId: summary.decisionEnvelope.decisionId } : {}),
    goalId: summary.goal.goalId,
    planId: summary.plan.planId,
    intentKind: summary.brief.intentKind,
    normalizedIntent: summary.brief.intentKind === "unknown" ? "unknown task input" : summary.brief.normalizedIntent,
    confidence: summary.brief.confidence,
    needsUserConfirmation: summary.brief.needsUserConfirmation,
    planningMode: summary.plan.planningMode,
    acceptanceDecision: summary.acceptance.decision,
    recommendedReturnPhase: summary.acceptance.recommendedReturnPhase,
    deliveryStatus: summary.delivery.status,
    ...(summary.delivery.nextPhase ? { nextPhase: summary.delivery.nextPhase } : {}),
    phaseCount: summary.phases.length,
    diagnosticCount: summary.diagnostics.length,
    compatibility: summary.compatibility,
    redaction: { class: "internal" }
  };
}

function classifyIntent(lower: string, activeTaskAvailable: boolean): {
  readonly normalizedIntent: string;
  readonly intentKind: TaskIntentKind;
  readonly confidence: number;
  readonly contextRequirements: readonly string[];
  readonly assumptions: readonly string[];
  readonly missingInfo: readonly string[];
  readonly needsUserConfirmation: boolean;
} {
  if (lower === "继续" || lower.includes("continue")) {
    return activeTaskAvailable
      ? {
        normalizedIntent: "continue current task",
        intentKind: "coding",
        confidence: 0.72,
        contextRequirements: ["active-task"],
        assumptions: ["Continue the active task if one exists."],
        missingInfo: [],
        needsUserConfirmation: false
      }
      : {
        normalizedIntent: "continue current task",
        intentKind: "unknown",
        confidence: 0.35,
        contextRequirements: ["active-task"],
        assumptions: [],
        missingInfo: ["active-task"],
        needsUserConfirmation: true
      };
  }
  if (lower.includes("跑分") || lower.includes("score") || lower.includes("evaluate")) {
    return {
      normalizedIntent: "run evaluation score",
      intentKind: "evaluation",
      confidence: 0.78,
      contextRequirements: ["evaluation-baseline", "acceptance-evidence"],
      assumptions: ["Use configured diagnostics/evaluation profile."],
      missingInfo: [],
      needsUserConfirmation: false
    };
  }
  if (lower.includes("openspec")) {
    return {
      normalizedIntent: "update openspec and implementation plan",
      intentKind: "coding",
      confidence: 0.82,
      contextRequirements: ["project-rules", "openspec-change"],
      assumptions: ["Use repository OpenSpec workflow."],
      missingInfo: [],
      needsUserConfirmation: false
    };
  }
  if (lower.includes("优化") || lower.includes("optimize")) {
    return {
      normalizedIntent: "optimize current implementation",
      intentKind: "coding",
      confidence: activeTaskAvailable ? 0.62 : 0.48,
      contextRequirements: ["active-task", "quality-target"],
      assumptions: activeTaskAvailable ? ["Optimize the active task target."] : [],
      missingInfo: activeTaskAvailable ? [] : ["optimization-target"],
      needsUserConfirmation: !activeTaskAvailable
    };
  }
  return {
    normalizedIntent: lower || "empty task input",
    intentKind: "unknown",
    confidence: 0.4,
    contextRequirements: ["user-intent"],
    assumptions: [],
    missingInfo: ["task-goal"],
    needsUserConfirmation: true
  };
}

function riskForIntent(intentKind: TaskIntentKind): TaskRiskLevel {
  if (intentKind === "release" || intentKind === "evaluation") return "medium";
  if (intentKind === "unknown") return "high";
  return "medium";
}

function defaultGoalStatement(brief: TaskBrief): string {
  if (brief.intentKind === "evaluation") return "Run the requested evaluation flow and collect acceptance evidence before delivery.";
  if (brief.intentKind === "unknown") return "Clarify the task goal before executing.";
  return "Continue the active coding task and prove acceptance before delivery.";
}

function defaultAcceptanceCriteria(evidenceRefs: readonly string[]) {
  return [{
    criterionId: "criterion:proof",
    description: "Required proof evidence exists before delivery.",
    required: true,
    evidenceRefs
  }];
}

function criterionAccepted(evidenceRefs: readonly string[], checkIds: readonly string[], options: ReviewTaskAcceptanceOptions): boolean {
  const hasEvidence = evidenceRefs.length > 0 && evidenceRefs.every((ref) => options.evidenceRefs.includes(ref));
  const hasChecks = checkIds.length > 0 && checkIds.every((checkId) => options.completedCheckIds.includes(checkId));
  return hasEvidence || hasChecks;
}

function createDeterministicDecisionEnvelope(request: TaskDecisionRequest, goal: TaskGoal): TaskDecisionEnvelope {
  return {
    schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
    decisionId: `task-decision:${stableHash(`${request.requestId}:${goal.goalId}`)}`,
    requestId: request.requestId,
    intentDecision: request.brief.normalizedIntent.replace(/\s+/g, "_"),
    goalProposal: goal,
    acceptanceCriteria: goal.acceptanceCriteria,
    planSteps: [{
      stepId: "task-step:proof",
      phase: "proof",
      description: "Collect proof evidence before acceptance.",
      expectedRefs: ["ref:proof"],
      status: "required"
    }],
    profileSelection: request.candidateProfiles[0] ?? "coding/general.v1",
    toolStrategy: ["Use read-only evidence first.", "Execute only governed tools."],
    verificationPlan: ["Collect proof evidence.", "Run focused checks before delivery."],
    repairPolicy: ["Return to the owning failed phase when acceptance fails."],
    stopConditions: ["Budget exhausted.", "User guidance requires clarification."],
    questionsForUser: request.brief.needsUserConfirmation ? request.brief.missingInfo : [],
    confidence: Math.min(0.9, request.brief.confidence + 0.08),
    assumptions: request.brief.assumptions,
    compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
    redaction: { class: "internal" }
  };
}

function createPhaseRecords(plan: TaskDeliveryPlan, acceptance: TaskAcceptanceReview): readonly TaskDeliveryPhaseRecord[] {
  return plan.steps.map((step) => ({
    schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
    phase: step.phase,
    status: phaseStatus(step.phase, acceptance),
    evidenceRefs: step.expectedRefs,
    diagnostics: step.phase === acceptance.recommendedReturnPhase && acceptance.decision !== "accepted"
      ? [diagnostic(acceptance.failureCode ?? "TASK_ACCEPTANCE_RETURNED", "Acceptance review returned this phase.")]
      : [],
    compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
    redaction: { class: "internal" }
  }));
}

function phaseStatus(phase: TaskDeliveryPhase, acceptance: TaskAcceptanceReview): TaskDeliveryPhaseStatus {
  if (acceptance.decision === "accepted") return "completed";
  if (phase === acceptance.recommendedReturnPhase) return "required";
  if (phase === "delivery") return "blocked";
  return "required";
}

function invalidationForGuidance(kind: TaskGuidanceEvent["guidanceKind"]): {
  readonly preservedFields: readonly string[];
  readonly invalidatedFields: readonly string[];
  readonly replanScope: DecisionInvalidation["replanScope"];
  readonly recommendedReturnPhase: TaskDeliveryPhase;
  readonly reason: string;
} {
  if (kind === "provider_change") {
    return {
      preservedFields: ["goalProposal", "acceptanceCriteria"],
      invalidatedFields: ["profileSelection", "toolStrategy"],
      replanScope: "replan",
      recommendedReturnPhase: "planning",
      reason: "Provider changed from user guidance."
    };
  }
  if (kind === "continue") {
    return {
      preservedFields: ["goalProposal", "acceptanceCriteria", "planSteps", "profileSelection"],
      invalidatedFields: [],
      replanScope: "none",
      recommendedReturnPhase: "runtime",
      reason: "Continue guidance does not invalidate the prior decision."
    };
  }
  if (kind === "stop") {
    return {
      preservedFields: ["goalProposal", "acceptanceCriteria"],
      invalidatedFields: ["planSteps", "toolStrategy", "verificationPlan"],
      replanScope: "none",
      recommendedReturnPhase: "delivery",
      reason: "User requested stop."
    };
  }
  return {
    preservedFields: ["acceptanceCriteria"],
    invalidatedFields: ["goalProposal", "planSteps", "profileSelection", "toolStrategy"],
    replanScope: "goal_refinement",
    recommendedReturnPhase: "goal",
    reason: "User guidance changes task interpretation."
  };
}

function diagnostic(code: string, message: string): RedactedError {
  return {
    code,
    message,
    retryable: false,
    redaction: { class: "internal" }
  };
}
