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

  it("classifies short SWE-bench Lite prompts as executable evaluation tasks", () => {
    const summary = createTaskDeliveryFlowSummary({
      rawInput: "给我完成 SWE-bench Lite 第 1 题测试，跑通并告诉我结果。",
      activeTaskAvailable: true
    });

    assert.equal(summary.brief.intentKind, "evaluation");
    assert.equal(summary.brief.normalizedIntent, "run swe-bench lite task");
    assert.equal(summary.brief.needsUserConfirmation, false);
    assert.equal(summary.decisionRequest.candidateProfiles[0], "evaluation/swe-bench-lite.v1");
    assert.equal(summary.decisionEnvelope.profileSelection, "evaluation/swe-bench-lite.v1");
    assert.equal(summary.decisionRequest.allowedTools.includes("workspace.write"), true);
    assert.equal(summary.decisionRequest.allowedTools.includes("shell.run"), true);
    assert.equal(summary.decisionRequest.constraints.some((constraint) => constraint.includes("benchmark workspace")), true);
    assert.equal(summary.decisionRequest.constraints.some((constraint) => constraint.includes(".deepseek/swebench-workspaces")), true);
    assert.equal(summary.decisionRequest.constraints.some((constraint) => constraint.includes("repo/")), true);
    assert.equal(summary.decisionRequest.constraints.some((constraint) => constraint.includes("minimal failing regression")), true);
    assert.equal(summary.decisionRequest.constraints.some((constraint) => constraint.includes("full dependency installation")), true);
    assert.equal(summary.decisionRequest.constraints.some((constraint) => constraint.includes("project-local virtual environment")), true);
    assert.equal(summary.decisionRequest.constraints.some((constraint) => constraint.includes("host/global package installers")), true);
    assert.equal(summary.decisionRequest.constraints.some((constraint) => constraint.includes("same package from a package index")), true);
    assert.equal(summary.decisionRequest.constraints.some((constraint) => constraint.includes("upstream git history")), true);
    assert.equal(summary.decisionRequest.constraints.some((constraint) => constraint.includes("After a focused regression fails")), true);
    assert.equal(summary.decisionRequest.constraints.some((constraint) => constraint.includes("After focused verification passes")), true);
    assert.equal(summary.decisionEnvelope.toolStrategy.some((step) => step.includes("benchmark instance")), true);
    assert.equal(summary.decisionEnvelope.toolStrategy.some((step) => step.includes("repo root")), true);
    assert.equal(summary.decisionEnvelope.toolStrategy.some((step) => step.includes("minimal reproduction")), true);
    assert.equal(summary.decisionEnvelope.toolStrategy.some((step) => step.includes("one dependency setup attempt")), true);
    assert.equal(summary.decisionEnvelope.toolStrategy.some((step) => step.includes("patch the checkout directly")), true);
    assert.equal(summary.decisionEnvelope.toolStrategy.some((step) => step.includes("do not keep installing dependencies")), true);
    assert.equal(summary.decisionEnvelope.verificationPlan.some((step) => step.includes("focused benchmark")), true);
    assert.equal(summary.decisionEnvelope.verificationPlan.some((step) => step.includes("full dependency installation")), true);
    assert.equal(summary.plan.planningMode, "catalog-profile");
    assert.equal(summary.delivery.status, "returned");
  });
});
