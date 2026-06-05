import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createTaskBrief,
  createTaskDecisionRequest,
  createTaskDeliveryFlowSummary,
  createTaskDeliveryPlan,
  createTaskGoal,
  classifyTaskGuidance,
  invalidateTaskDecision,
  reviewTaskAcceptance
} from "../src/index.js";

describe("task delivery flow runtime controller", () => {
  it("turns short input into a decision request, goal, plan, and acceptance return state", () => {
    const brief = createTaskBrief({ rawInput: "继续", activeTaskAvailable: true });
    const request = createTaskDecisionRequest(brief, {
      evidenceRefs: ["ref:project-rules"],
      candidateProfiles: ["coding/general.v1"],
      allowedTools: ["workspace.read"]
    });
    const goal = createTaskGoal(brief, {
      statement: "Continue the active task and verify acceptance before delivery."
    });
    const plan = createTaskDeliveryPlan(goal, {
      decisionId: "task-decision:continue",
      selectedProfileId: "coding/general.v1"
    });
    const acceptance = reviewTaskAcceptance(goal, {
      evidenceRefs: [],
      completedCheckIds: [],
      repairBudgetRemaining: 1
    });

    assert.equal(brief.intentKind, "coding");
    assert.equal(brief.needsUserConfirmation, false);
    assert.equal(request.brief.briefId, brief.briefId);
    assert.equal(request.allowedTools[0], "workspace.read");
    assert.equal(goal.acceptanceCriteria.some((criterion) => criterion.required), true);
    assert.equal(plan.planningMode, "catalog-profile");
    assert.equal(acceptance.decision, "verify_required");
    assert.equal(acceptance.recommendedReturnPhase, "proof");
  });

  it("invalidates only planning when user guidance changes provider", () => {
    const summary = createTaskDeliveryFlowSummary({ rawInput: "跑分", activeTaskAvailable: true });
    const guidance = classifyTaskGuidance("改成 GLM", summary.decisionEnvelope.decisionId);
    const invalidation = invalidateTaskDecision(guidance, summary.decisionEnvelope, {
      preservedEvidenceRefs: summary.decisionRequest.evidenceRefs
    });

    assert.equal(guidance.guidanceKind, "provider_change");
    assert.equal(invalidation.replanScope, "replan");
    assert.equal(invalidation.recommendedReturnPhase, "planning");
    assert.equal(invalidation.preservedFields.includes("goalProposal"), true);
    assert.equal(invalidation.invalidatedFields.includes("profileSelection"), true);
  });
});
