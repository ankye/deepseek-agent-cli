import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentLoopStageBudget } from "@deepseek/platform-contracts";
import { cliAgentProfilePolicyMetadata, resolveCliAgentProfilePolicy } from "./model-selection.js";

describe("CLI agent profile policy selection", () => {
  it("keeps ordinary coding prompts advisory so text-only runs are not blocked by required staged actions", () => {
    const policy = resolveCliAgentProfilePolicy({ prompt: "hello" });
    const metadata = cliAgentProfilePolicyMetadata(policy);

    assert.equal(metadata.profileId, "coding/general.v1");
    assert.equal(metadata.workflowPriority, "advisory");
    assert.equal(metadata.stagedTaskWorkflow, undefined);
  });

  it("compiles execution-bearing coding prompts into a primary engineering workflow", () => {
    const policy = resolveCliAgentProfilePolicy({ prompt: "修复这个仓库里的 CLI 调度缺陷，补测试并跑验证。" });
    const metadata = cliAgentProfilePolicyMetadata(policy);

    assert.equal(metadata.profileId, "engineering/coding.v1");
    assert.equal(metadata.role, "engineering-agent");
    assert.equal(metadata.workflowPriority, "primary");
    assert.equal(metadata.workflowGovernanceMode, "standard");
    assert.equal(metadata.stageAcceptanceMode, "automatic");
    assert.equal(metadata.workflowGraphId, "workflow/engineering.coding.v1");
    assert.deepEqual(metadata.workflowStages?.map((stage) => stage.id), [
      "understand",
      "plan",
      "implement",
      "verify",
      "report"
    ]);
    assert.deepEqual(metadata.stagedTaskWorkflow?.graph?.stages?.map((stage) => stage.stageId), [
      "stage:understand",
      "stage:plan",
      "stage:implement",
      "stage:verify",
      "stage:report"
    ]);
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.some((stage) => stage.stageId === "stage:test" && stage.kind === "produce"), false);
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.[2]?.stageId, "stage:implement");
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.[2]?.kind, "produce");
    assert.equal(metadata.stagedTaskWorkflow?.runState.stageStates.filter((stage) => stage.status === "ready").length, 1);
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.[0]?.allowedTools?.includes("core.file.read"), true);
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.[0]?.parameters?.requireNonHeaderSourceWindow, true);
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.[2]?.allowedTools?.includes("core.file.edit"), true);
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.[2]?.allowedTools?.includes("core.text.replace"), true);
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.[2]?.allowedTools?.includes("core.file.copy"), true);
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.[2]?.allowedTools?.includes("core.directory.create"), true);
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.[2]?.allowedTools?.includes("core.json.patch"), true);
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.[3]?.allowedTools?.includes("core.test.run"), true);
    assert.equal(metadata.workflowStages?.[1]?.exitCriteria.some((criterion) => criterion.includes("boundary") && criterion.includes("regression")), true);
    assert.equal(metadata.workflowStages?.[2]?.exitCriteria.some((criterion) => criterion.includes("observed failure") && criterion.includes("edge cases")), true);
    assert.equal(metadata.workflowStages?.[3]?.exitCriteria.some((criterion) => criterion.includes("boundary") && criterion.includes("negative")), true);
  });

  it("routes explicitly read-only analysis prompts to a read-only primary workflow", () => {
    const policy = resolveCliAgentProfilePolicy({
      prompt: "分析这个仓库的 CLI 调度缺陷。只读取 README、OpenSpec 和相关源码来定位问题，不要修改文件。"
    });
    const metadata = cliAgentProfilePolicyMetadata(policy);

    assert.equal(metadata.profileId, "analysis/read-only.v1");
    assert.equal(metadata.role, "analysis-agent");
    assert.equal(metadata.workflowPriority, "primary");
    assert.equal(metadata.workflowGovernanceMode, "standard");
    assert.equal(metadata.stageAcceptanceMode, "automatic");
    assert.equal(metadata.workflowGraphId, "workflow/analysis.read-only.v1");
    assert.deepEqual(metadata.workflowStages?.map((stage) => stage.id), [
      "evidence",
      "report"
    ]);
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.[0]?.kind, "collect-evidence");
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.[1]?.kind, "synthesize");
    assert.equal(metadata.workflowCapabilityIds.some((capabilityId) => capabilityId.includes("write") || capabilityId.includes("edit") || capabilityId.includes("patch")), false);
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.some((stage) => stage.allowedTools?.some((tool) => tool.includes("write") || tool.includes("edit") || tool.includes("patch"))), false);
  });

  it("routes capability-matrix read-only architecture prompts to a two-stage read-only workflow", () => {
    const policy = resolveCliAgentProfilePolicy({
      prompt: "分析这个仓库的 CLI 调度架构边界，指出意图识别、任务拆分、profile 拼装和工具编排在哪里落地，不要修改文件。"
    });
    const metadata = cliAgentProfilePolicyMetadata(policy);

    assert.equal(metadata.profileId, "analysis/read-only.v1");
    assert.deepEqual(metadata.stagedTaskWorkflow?.graph?.stages?.map((stage) => [stage.stageId, stage.kind]), [
      ["stage:evidence", "collect-evidence"],
      ["stage:report", "synthesize"]
    ]);
    assert.equal(metadata.workflowCapabilityIds.includes("core.workspace.glob"), true);
    assert.equal(metadata.workflowCapabilityIds.includes("core.search.text"), true);
    assert.equal(metadata.workflowCapabilityIds.includes("core.file.read"), true);
  });

  it("compiles SWE-bench prompts into a primary staged workflow", () => {
    const policy = resolveCliAgentProfilePolicy({ prompt: "Resolve SWE-bench instance astropy__astropy-12907." });
    const metadata = cliAgentProfilePolicyMetadata(policy);

    assert.equal(metadata.profileId, "evaluation/swe-bench-lite.v1");
    assert.equal(metadata.workflowPriority, "primary");
    assert.equal(metadata.workflowGovernanceMode, "evaluation");
    assert.equal(metadata.stageAcceptanceMode, "supervisor");
    assert.equal(metadata.workflowCapabilityIds.join(","), "core.swe.bench.run");
    assert.equal(metadata.workflowStages?.[0]?.id, "dispatch");
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.[0]?.stageId, "stage:dispatch");
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.[0]?.allowedTools?.join(","), "core.swe.bench.run");
    assert.equal(metadata.stagedTaskWorkflow?.runState.stageStates.filter((stage) => stage.status === "ready").length, 1);
  });

  it("compiles managed SWE-bench child prompts into the child staged workflow", () => {
    const policy = resolveCliAgentProfilePolicy({
      prompt: "Managed SWE-bench execution profile:\nResolve SWE-bench instance astropy__astropy-12907."
    });
    const metadata = cliAgentProfilePolicyMetadata(policy);

    assert.equal(metadata.profileId, "evaluation/swe-bench-lite.v1");
    assert.equal(metadata.workflowPriority, "primary");
    assert.equal(metadata.workflowGovernanceMode, "evaluation");
    assert.equal(metadata.stageAcceptanceMode, "supervisor");
    assert.deepEqual(metadata.workflowStages?.map((stage) => stage.id), ["understand", "change", "verify", "score", "package"]);
    assert.deepEqual(metadata.stagedTaskWorkflow?.graph?.stages?.map((stage) => stage.stageId), [
      "stage:understand",
      "stage:change",
      "stage:verify",
      "stage:score",
      "stage:package"
    ]);
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.[0]?.allowedTools?.includes("core.env.prepare"), false);
    assert.equal(metadata.stagedTaskWorkflow?.graph?.stages?.[0]?.allowedTools?.includes("core.file.read"), true);
  });

  it("assigns managed SWE-bench child stage budgets instead of one undifferentiated loop budget", () => {
    const policy = resolveCliAgentProfilePolicy({
      prompt: "Managed SWE-bench execution profile:\nResolve SWE-bench instance astropy__astropy-12907."
    });
    const metadata = cliAgentProfilePolicyMetadata(policy);
    const budgets = (metadata.loopLimits?.stageBudgets ?? []) as readonly AgentLoopStageBudget[];

    assert.deepEqual(budgets.map((budget) => budget.stageId), [
      "stage:understand",
      "stage:change",
      "stage:verify"
    ]);
    assert.equal(budgets.find((budget) => budget.stageId === "stage:understand")?.maxModelIterations, 8);
    assert.equal(budgets.find((budget) => budget.stageId === "stage:change")?.maxModelIterations, 16);
    assert.equal(budgets.find((budget) => budget.stageId === "stage:verify")?.maxModelIterations, 12);
    assert.equal(budgets.every((budget) => typeof budget.stopReason === "string" && budget.stopReason.includes("swe-bench-child-stage")), true);
  });
});
