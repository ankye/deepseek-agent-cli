import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CliEvaluationTaskDefinition } from "@deepseek/platform-contracts";
import { buildEvaluationStageGraph, buildEvaluationStagedTaskSnapshot } from "../src/diagnostics/evaluation-stage-graph.js";

describe("CLI evaluation staged graph adapter", () => {
  it("builds a generic staged graph for webpage generation tasks", () => {
    const graph = buildEvaluationStageGraph(task("eval.webpage.generation"));
    const stageIds = graph.stages.map((stage) => stage.stageId);
    const executorKinds = graph.stages.map((stage) => stage.executorKind);

    assert.equal(graph.profileId, "evaluation/webpage-generation.v1");
    assert.equal(graph.metadata?.taskId, "eval.webpage.generation");
    assert.equal(executorKinds.includes("agent-loop"), true);
    assert.equal(executorKinds.includes("process-check"), true);
    assert.equal(executorKinds.includes("artifact-scan"), true);
    assert.equal(stageIds.some((stageId) => /html|css|javascript|js/i.test(stageId)), false);
    assert.equal(graph.refs.every((ref) => stageIds.includes(ref.producerStageId)), true);
  });

  it("builds a replayable staged task snapshot for evaluation task runs", () => {
    const snapshot = buildEvaluationStagedTaskSnapshot(task("eval.webpage.generation"), "eval:deepseek-cli:eval.webpage.generation");

    assert.equal(snapshot.profileId, "evaluation/webpage-generation.v1");
    assert.equal(snapshot.graph.profileId, snapshot.profileId);
    assert.equal(snapshot.runState.taskRunId, "staged:eval:deepseek-cli:eval.webpage.generation");
    assert.equal(snapshot.runState.events.length, 0);
    assert.equal(snapshot.stageCount, snapshot.graph.stages.length);
    assert.equal(snapshot.executorKinds.includes("agent-loop"), true);
    assert.equal(snapshot.runState.stageStates.some((stage) => stage.status === "ready"), true);
    assert.equal(snapshot.runState.stageStates.some((stage) => stage.status === "pending"), true);
  });
});

function task(taskId: string): CliEvaluationTaskDefinition {
  return {
    schemaVersion: "1.0.0",
    taskId,
    title: "Generate webpage",
    category: "webpage-generation",
    fixtureId: "fixture.web",
    workspaceSnapshotId: "snapshot.web",
    promptDigest: "sha256:web",
    promptSummary: "Create local webpage files.",
    allowedCapabilityProfile: "local-create-web-assets",
    timeBudgetMs: 1000,
    checkCommands: ["node scripts/check-webpage-generation.mjs tests/evaluation/generated-webpage"],
    scoringRubricId: "rubric.web",
    mode: "full",
    redaction: { class: "internal", fields: ["promptDigest", "workspaceSnapshotId"] }
  };
}
