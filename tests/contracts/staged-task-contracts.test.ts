import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STAGED_TASK_COMPATIBILITY,
  STAGED_TASK_SCHEMA_VERSION,
  type StagedTaskExecutionResult,
  type StagedTaskGraph,
  type StagedTaskProfileRecord,
  type StagedTaskRef,
  type StagedTaskStageContract,
  type StagedTaskStageEvent,
  type StagedTaskRunState
} from "@deepseek/platform-contracts";

describe("staged task contracts", () => {
  it("declares host-neutral staged task DTOs with typed DAG refs", () => {
    const artifactRef: StagedTaskRef = {
      schemaVersion: STAGED_TASK_SCHEMA_VERSION,
      refId: "ref:webpage-artifact",
      type: "artifact",
      producerStageId: "stage:produce",
      scope: "workspace",
      path: "generated-webpage/index.html",
      fingerprint: "sha256:artifact",
      compatibility: STAGED_TASK_COMPATIBILITY,
      redaction: { class: "internal", fields: ["path"] }
    };
    const produceStage: StagedTaskStageContract = {
      schemaVersion: STAGED_TASK_SCHEMA_VERSION,
      stageId: "stage:produce",
      kind: "produce",
      executorKind: "agent-loop",
      dependsOn: ["stage:evidence"],
      inputRefs: ["ref:project-evidence"],
      expectedOutputRefs: [artifactRef.refId],
      allowedTools: ["workspace.read", "workspace.write"],
      budget: { maxModelIterations: 8, maxToolCalls: 16 },
      acceptance: { requiredRefs: [artifactRef.refId], requiredStatuses: ["succeeded"] },
      compatibility: STAGED_TASK_COMPATIBILITY,
      redaction: { class: "internal", fields: ["parameters.prompt"] }
    };
    const graph: StagedTaskGraph = {
      schemaVersion: STAGED_TASK_SCHEMA_VERSION,
      graphId: "graph:evaluation-webpage",
      profileId: "evaluation/webpage-generation.v1",
      stages: [produceStage],
      refs: [artifactRef],
      compatibility: STAGED_TASK_COMPATIBILITY,
      redaction: { class: "internal", fields: ["refs.path"] }
    };
    const runState: StagedTaskRunState = {
      schemaVersion: STAGED_TASK_SCHEMA_VERSION,
      taskRunId: "task-run:evaluation-webpage",
      graphId: graph.graphId,
      profileId: graph.profileId,
      stageStates: [{
        stageId: produceStage.stageId,
        status: "pending",
        attempts: 0,
        inputRefs: produceStage.inputRefs,
        outputRefs: [],
        diagnostics: []
      }],
      refs: [],
      events: [],
      compatibility: STAGED_TASK_COMPATIBILITY,
      redaction: { class: "internal", fields: ["diagnostics.details"] }
    };
    const event: StagedTaskStageEvent = {
      schemaVersion: STAGED_TASK_SCHEMA_VERSION,
      eventId: "event:stage-produce-succeeded",
      kind: "stage.succeeded",
      taskRunId: runState.taskRunId,
      graphId: graph.graphId,
      stageId: produceStage.stageId,
      at: "2026-06-04T00:00:00.000Z",
      outputRefs: [artifactRef],
      diagnostics: [],
      compatibility: STAGED_TASK_COMPATIBILITY,
      redaction: { class: "internal", fields: ["diagnostics.details"] }
    };
    const executionResult: StagedTaskExecutionResult = {
      schemaVersion: STAGED_TASK_SCHEMA_VERSION,
      status: "succeeded",
      outputRefs: [artifactRef],
      diagnostics: [],
      compatibility: STAGED_TASK_COMPATIBILITY,
      redaction: { class: "internal", fields: ["diagnostics.details"] }
    };

    assert.equal(graph.schemaVersion, "1.0.0");
    assert.equal(graph.stages[0]?.executorKind, "agent-loop");
    assert.equal(graph.refs[0]?.producerStageId, "stage:produce");
    assert.equal(runState.stageStates[0]?.status, "pending");
    assert.equal(event.outputRefs?.[0]?.type, "artifact");
    assert.equal(executionResult.status, "succeeded");
  });

  it("declares composable task profile records without executor-per-profile coupling", () => {
    const profile: StagedTaskProfileRecord = {
      schemaVersion: STAGED_TASK_SCHEMA_VERSION,
      profileId: "evaluation/webpage-generation.v1",
      title: "Evaluation Webpage Generation",
      domain: "evaluation",
      baseProfileId: "base/evidence-grounded-task.v1",
      fragments: [
        "fragment/materialize-workspace.v1",
        "fragment/collect-project-evidence.v1",
        "fragment/agent-produce-artifacts.v1",
        "fragment/process-check.v1",
        "fragment/artifact-scan.v1"
      ],
      overlays: ["overlay/live-glm-expanded-budget.v1"],
      parameters: { objective: "generate a verifiable webpage artifact" },
      compatibility: STAGED_TASK_COMPATIBILITY,
      redaction: { class: "public" }
    };

    assert.equal(profile.profileId, "evaluation/webpage-generation.v1");
    assert.equal(profile.fragments.length, 5);
    assert.equal(profile.overlays[0], "overlay/live-glm-expanded-budget.v1");
  });
});
