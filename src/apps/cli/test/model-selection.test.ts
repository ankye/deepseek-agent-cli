import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cliAgentProfilePolicyMetadata,
  resolveCliAgentLoopLimits,
  resolveCliAgentProfilePolicy,
  resolveCliModelProfile,
  SWE_BENCH_AGENT_LOOP_LIMITS,
  usesSweBenchProfile
} from "../src/host/model-selection.js";

describe("cli model selection", () => {
  it("uses a larger GLM Anthropic output budget for expanded webpage tasks", () => {
    const profile = resolveCliModelProfile({
      modelProvider: "glm",
      model: "glm-5.1",
      prompt: "Evaluation task id: eval.webpage.generation\nCreate a responsive webpage."
    });

    assert.equal(profile.providerOptions?.max_tokens, 8192);
  });

  it("does not add GLM provider token overrides for simple prompts", () => {
    const profile = resolveCliModelProfile({
      modelProvider: "glm",
      model: "glm-5.1",
      prompt: "Reply with ok."
    });

    assert.equal(profile.providerOptions, undefined);
  });

  it("widens one-shot agent loop limits for expanded webpage tasks", () => {
    assert.deepEqual(resolveCliAgentLoopLimits("Create a polished product webpage."), {
      maxModelIterations: 24,
      maxToolCalls: 64,
      maxOutputBytes: 96_000
    });
  });

  it("widens GLM budgets for user-realistic SWE-bench prompts", () => {
    const prompt = "给我完成 SWE-bench Lite 第 1 题测试，跑通并告诉我结果。";
    const profile = resolveCliModelProfile({
      modelProvider: "glm",
      model: "glm-5.1",
      prompt
    });

    assert.equal(profile.providerOptions?.max_tokens, 8192);
    assert.deepEqual(resolveCliAgentLoopLimits(prompt), SWE_BENCH_AGENT_LOOP_LIMITS);
  });

  it("recognizes governed SWE-bench child prompts as SWE-bench profile runs", () => {
    const prompt = [
      "Resolve SWE-bench instance django__django-11019.",
      "",
      "Managed SWE-bench execution profile:",
      "- Work only inside the current repository checkout.",
      "",
      "Problem statement:",
      "Demo issue.",
      "",
      "Task:",
      "- Run a focused relevant standard test command."
    ].join("\n");

    assert.equal(usesSweBenchProfile(prompt), true);
    assert.deepEqual(resolveCliAgentLoopLimits(prompt), SWE_BENCH_AGENT_LOOP_LIMITS);
  });

  it("keeps governed SWE-bench child prompts on source-edit workflow capabilities", () => {
    const prompt = [
      "Resolve SWE-bench instance django__django-11019.",
      "",
      "Managed SWE-bench execution profile:",
      "- Work only inside the current repository checkout.",
      "",
      "Problem statement:",
      "Demo issue.",
      "",
      "Task:",
      "- Run a focused relevant standard test command."
    ].join("\n");

    const policy = resolveCliAgentProfilePolicy({ prompt });

    assert.equal(policy.id, "evaluation/swe-bench-lite.v1");
    assert.deepEqual(policy.workflow.stages.map((stage) => stage.id), [
      "understand",
      "change",
      "verify"
    ]);
    assert.equal(policy.workflow.capabilityIds.includes("core.swe.bench.run"), false);
    assert.equal(policy.workflow.stages[0]?.capabilityIds.includes("core.file.read"), true);
    assert.equal(policy.workflow.stages[1]?.capabilityIds.includes("core.file.edit"), true);
    assert.equal(policy.workflow.stages[2]?.capabilityIds.includes("core.test.run"), true);
  });

  it("represents SWE-bench CLI profile as a workflow role over generic capabilities", () => {
    const policy = resolveCliAgentProfilePolicy({
      prompt: "给我完成 SWE-bench Lite 第 1 题测试，跑通并告诉我结果。"
    });

    assert.equal(policy.id, "evaluation/swe-bench-lite.v1");
    assert.equal(policy.role, "evaluation-workflow");
    assert.equal(policy.workflow.graphId, "workflow/evaluation.swe-bench-lite.v1");
    assert.equal(policy.workflow.priority, "primary");
    assert.equal(policy.workflow.orchestrationMode, "staged-capability-workflow");
    assert.deepEqual(policy.toolProjection, "all");
    assert.deepEqual(policy.contextPipeline, { enabled: true });
    assert.deepEqual(policy.limits, SWE_BENCH_AGENT_LOOP_LIMITS);
    assert.deepEqual(policy.workflow.capabilityIds, [
      "core.swe.bench.run"
    ]);
    assert.deepEqual(policy.workflow.stages.map((stage) => ({
      id: stage.id,
      objective: stage.objective,
      capabilityIds: stage.capabilityIds,
      exitCriteria: stage.exitCriteria
    })), [
      {
        id: "dispatch",
        objective: "Dispatch the numbered user request to the governed SWE-bench run capability. Do not call core.env.prepare in the parent dispatch loop; environment preparation belongs inside the managed child run created by core.swe.bench.run.",
        capabilityIds: ["core.swe.bench.run"],
        exitCriteria: ["governed harness result or classified blocker recorded"]
      }
    ]);
    assert.equal(policy.workflow.stages[0]?.objective.includes("Do not call core.env.prepare in the parent dispatch loop"), true);
    assert.equal(policy.governance.antiTailoring, true);
    assert.equal(policy.governance.executionBoundary, "governed-capabilities");
  });

  it("keeps explicit tool projection as user policy while preserving profile workflow metadata", () => {
    const policy = resolveCliAgentProfilePolicy({
      prompt: "Resolve SWE-bench instance astropy__astropy-12907.",
      explicitToolProjection: "read-only"
    });

    assert.equal(policy.id, "evaluation/swe-bench-lite.v1");
    assert.equal(policy.toolProjection, "read-only");
    assert.equal(policy.toolProjectionSource, "user");
    assert.equal(policy.workflow.capabilityIds.includes("core.swe.bench.run"), true);
  });

  it("compiles SWE-bench profile workflow into replayable staged-task metadata", () => {
    const policy = resolveCliAgentProfilePolicy({
      prompt: "给我完成 SWE-bench Lite 第 8 题测试，跑通并告诉我结果。"
    });

    const metadata = cliAgentProfilePolicyMetadata(policy);
    assert.equal(metadata.workflowPriority, "primary");
    assert.equal(metadata.orchestrationMode, "staged-capability-workflow");
    const workflow = metadata.stagedTaskWorkflow as {
      readonly profileId?: string;
      readonly graphId?: string;
      readonly fingerprint?: string;
      readonly executorKinds?: readonly string[];
      readonly graph?: {
        readonly stages?: readonly {
          readonly stageId?: string;
          readonly kind?: string;
          readonly executorKind?: string;
          readonly dependsOn?: readonly string[];
          readonly allowedTools?: readonly string[];
          readonly expectedOutputRefs?: readonly string[];
        }[];
        readonly metadata?: { readonly profileSource?: string; readonly profileScope?: string };
      };
      readonly runState?: {
        readonly taskRunId?: string;
        readonly stageStates?: readonly { readonly stageId?: string; readonly status?: string }[];
      };
    } | undefined;
    const stages = workflow?.graph?.stages ?? [];

    assert.equal(workflow?.profileId, "evaluation/swe-bench-lite.v1");
    assert.match(workflow?.fingerprint ?? "", /^fnv1a:/);
    assert.equal(workflow?.graph?.metadata?.profileSource, "dynamic");
    assert.equal(workflow?.graph?.metadata?.profileScope, "task-run");
    assert.deepEqual(stages.map((stage) => stage.stageId), [
      "stage:dispatch"
    ]);
    assert.deepEqual(stages.map((stage) => stage.executorKind), [
      "agent-loop"
    ]);
    assert.deepEqual(stages[0]?.allowedTools, ["core.swe.bench.run"]);
    assert.deepEqual(stages[0]?.dependsOn, []);
    assert.equal(stages.every((stage) => (stage.expectedOutputRefs ?? []).some((ref) => ref.includes("evidence"))), true);
    assert.deepEqual(workflow?.executorKinds, ["agent-loop"]);
    assert.equal(workflow?.runState?.taskRunId, `staged:${workflow?.graphId}`);
    assert.deepEqual(workflow?.runState?.stageStates?.map((stage) => `${stage.stageId}:${stage.status}`), [
      "stage:dispatch:ready"
    ]);
  });
});
