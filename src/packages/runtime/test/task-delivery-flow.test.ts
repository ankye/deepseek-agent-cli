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

  it("keeps benchmark-named prompts generic unless an external evaluation profile selects them", () => {
    const benchmarkNamed = createTaskDeliveryFlowSummary({
      rawInput: "给我完成 Benchmark Lite 第 1 题测试，跑通并告诉我结果。",
      activeTaskAvailable: true
    });

    assert.equal(benchmarkNamed.brief.intentKind, "unknown");
    assert.equal(benchmarkNamed.brief.needsUserConfirmation, true);
    assert.equal(benchmarkNamed.decisionRequest.candidateProfiles[0], "coding/general.v1");

    const summary = createTaskDeliveryFlowSummary({
      rawInput: "跑分并收集验收证据。",
      activeTaskAvailable: true
    });

    assert.equal(summary.brief.intentKind, "evaluation");
    assert.equal(summary.brief.normalizedIntent, "run evaluation score");
    assert.equal(summary.brief.needsUserConfirmation, false);
    assert.equal(summary.decisionRequest.candidateProfiles[0], "evaluation/dynamic.v1");
    assert.equal(summary.decisionEnvelope.profileSelection, "evaluation/dynamic.v1");
    assert.equal(summary.decisionRequest.allowedTools.includes("workspace.write"), true);
    assert.equal(summary.decisionRequest.allowedTools.includes("shell.run"), true);
    const modelFacingGuidance = [
      ...summary.decisionRequest.constraints,
      ...summary.decisionEnvelope.toolStrategy,
      ...summary.decisionEnvelope.verificationPlan
    ].join("\n");
    assert.equal(modelFacingGuidance.includes(".deepseek/evaluation-workspaces"), false);
    assert.equal(modelFacingGuidance.includes("historical"), false);
    assert.equal(modelFacingGuidance.includes("Benchmark Lite"), false);
    assert.equal(summary.decisionRequest.constraints.some((constraint) => constraint.includes("prompt assembly")), true);
    assert.equal(summary.decisionEnvelope.toolStrategy.some((step) => step.includes("governed tools")), true);
    assert.equal(summary.decisionEnvelope.verificationPlan.some((step) => step.includes("focused checks")), true);
    assert.equal(summary.plan.planningMode, "catalog-profile");
    assert.equal(summary.delivery.status, "returned");
  });

  it("classifies read-only CLI architecture analysis as executable diagnostics work", () => {
    const summary = createTaskDeliveryFlowSummary({
      rawInput: "分析这个仓库的 CLI 调度架构边界，指出意图识别、任务拆分、profile 拼装和工具编排在哪里落地，不要修改文件。",
      activeTaskAvailable: true
    });

    assert.equal(summary.brief.intentKind, "diagnostics");
    assert.equal(summary.brief.needsUserConfirmation, false);
    assert.equal(summary.brief.missingInfo.length, 0);
    assert.equal(summary.decisionRequest.candidateProfiles[0], "analysis/read-only.v1");
    assert.equal(summary.decisionEnvelope.profileSelection, "analysis/read-only.v1");
    assert.equal(summary.plan.planningMode, "catalog-profile");
    assert.equal(summary.decisionRequest.allowedTools.includes("workspace.read"), true);
    assert.equal(summary.decisionRequest.allowedTools.includes("search.text"), true);
    assert.equal(summary.decisionRequest.allowedTools.includes("workspace.write"), false);
  });

  it("preserves path literal casing in default normalized intents", () => {
    const summary = createTaskDeliveryFlowSummary({
      rawInput: "生成 docs/USAGE.md 和 examples/config.json。",
      activeTaskAvailable: true
    });

    assert.equal(summary.brief.intentKind, "unknown");
    assert.equal(summary.brief.normalizedIntent.includes("docs/USAGE.md"), true);
    assert.equal(summary.brief.normalizedIntent.includes("docs/usage.md"), false);
  });
});
