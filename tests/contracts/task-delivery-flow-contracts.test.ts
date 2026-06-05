import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TASK_DELIVERY_FLOW_COMPATIBILITY,
  TASK_DELIVERY_FLOW_SCHEMA_VERSION,
  type DecisionInvalidation,
  type TaskAcceptanceReview,
  type TaskBrief,
  type TaskDecisionEnvelope,
  type TaskDecisionRequest,
  type TaskDeliveryPlan,
  type TaskGuidanceEvent,
  type TaskGoal
} from "@deepseek/platform-contracts";

describe("task delivery flow contracts", () => {
  it("declares intake, decision, goal, plan, acceptance, and guidance DTOs", () => {
    const brief: TaskBrief = {
      schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
      briefId: "task-brief:continue",
      rawInput: "继续",
      normalizedIntent: "continue current task",
      intentKind: "coding",
      confidence: 0.72,
      contextRequirements: ["active-task"],
      assumptions: ["Continue the active task if one exists."],
      missingInfo: [],
      needsUserConfirmation: false,
      compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
      redaction: { class: "internal", fields: ["rawInput"] }
    };
    const goal: TaskGoal = {
      schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
      goalId: "task-goal:continue",
      briefId: brief.briefId,
      statement: "Continue the active coding task and prove acceptance before delivery.",
      taskKind: "coding",
      riskLevel: "medium",
      acceptanceCriteria: [{
        criterionId: "criterion:proof",
        description: "Required proof evidence exists before delivery.",
        required: true,
        evidenceRefs: ["ref:proof"]
      }],
      nonGoals: ["Do not mutate unrelated files."],
      compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
      redaction: { class: "internal" }
    };
    const decisionRequest: TaskDecisionRequest = {
      schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
      requestId: "task-decision-request:continue",
      brief,
      evidenceRefs: ["ref:project-rules"],
      constraints: ["Use prompt assembly for model-bound decisions."],
      allowedTools: ["workspace.read"],
      riskLevel: "medium",
      candidateProfiles: ["coding/general.v1"],
      acceptanceDraft: goal.acceptanceCriteria,
      compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
      redaction: { class: "internal", fields: ["brief.rawInput"] }
    };
    const decisionEnvelope: TaskDecisionEnvelope = {
      schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
      decisionId: "task-decision:continue",
      requestId: decisionRequest.requestId,
      intentDecision: "continue_existing_task",
      goalProposal: goal,
      acceptanceCriteria: goal.acceptanceCriteria,
      planSteps: [{
        stepId: "task-step:verify",
        phase: "proof",
        description: "Collect proof evidence before acceptance.",
        expectedRefs: ["ref:proof"]
      }],
      profileSelection: "coding/general.v1",
      toolStrategy: ["Use read-only evidence first."],
      verificationPlan: ["Run focused checks."],
      repairPolicy: ["Repair only failed acceptance criteria."],
      stopConditions: ["Budget exhausted."],
      questionsForUser: [],
      confidence: 0.8,
      assumptions: ["Active task is still current."],
      compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
      redaction: { class: "internal" }
    };
    const plan: TaskDeliveryPlan = {
      schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
      planId: "task-plan:continue",
      goalId: goal.goalId,
      decisionId: decisionEnvelope.decisionId,
      planningMode: "catalog-profile",
      selectedProfileId: "coding/general.v1",
      candidateProfileIds: ["coding/general.v1"],
      requiresDynamicProfile: false,
      requiresUserInput: false,
      steps: decisionEnvelope.planSteps,
      compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
      redaction: { class: "internal" }
    };
    const guidance: TaskGuidanceEvent = {
      schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
      guidanceEventId: "task-guidance:provider-change",
      rawInput: "改成 GLM",
      guidanceKind: "provider_change",
      targetDecisionId: decisionEnvelope.decisionId,
      confidence: 0.92,
      compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
      redaction: { class: "internal", fields: ["rawInput"] }
    };
    const invalidation: DecisionInvalidation = {
      schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
      invalidationId: "decision-invalidation:provider-change",
      guidanceEventId: guidance.guidanceEventId,
      previousDecisionId: decisionEnvelope.decisionId,
      preservedFields: ["goalProposal", "acceptanceCriteria"],
      invalidatedFields: ["profileSelection", "toolStrategy"],
      preservedEvidenceRefs: ["ref:project-rules"],
      replanScope: "replan",
      reason: "Provider changed from user guidance.",
      recommendedReturnPhase: "planning",
      compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
      redaction: { class: "internal" }
    };
    const acceptance: TaskAcceptanceReview = {
      schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
      reviewId: "task-acceptance:proof",
      goalId: goal.goalId,
      decision: "verify_required",
      failedCriteriaIds: ["criterion:proof"],
      evidenceRefs: [],
      recommendedReturnPhase: "proof",
      failureCode: "TASK_ACCEPTANCE_EVIDENCE_MISSING",
      repairBudgetRemaining: 1,
      compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
      redaction: { class: "internal" }
    };

    assert.equal(brief.schemaVersion, "1.0.0");
    assert.equal(decisionRequest.brief.briefId, brief.briefId);
    assert.equal(decisionEnvelope.goalProposal.goalId, goal.goalId);
    assert.equal(plan.selectedProfileId, "coding/general.v1");
    assert.equal(guidance.guidanceKind, "provider_change");
    assert.equal(invalidation.recommendedReturnPhase, "planning");
    assert.equal(acceptance.decision, "verify_required");
  });
});
