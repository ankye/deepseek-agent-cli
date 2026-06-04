import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STAGED_TASK_COMPATIBILITY,
  STAGED_TASK_SCHEMA_VERSION,
  type RedactedError,
  type StagedTaskGraph,
  type StagedTaskRef,
  type StagedTaskStageEvent
} from "@deepseek/platform-contracts";
import {
  applyStagedTaskEvent,
  createStagedTaskRunState,
  readyStagedTaskStages,
  replayStagedTaskRun,
  runReadyStage,
  validateStagedTaskGraph,
  type StageExecutor
} from "../src/index.js";

describe("staged task runtime state machine", () => {
  it("derives ready stages and replay state from typed events", () => {
    const graph = graphFixture();
    const validation = validateStagedTaskGraph(graph);
    const initial = createStagedTaskRunState(graph, { taskRunId: "task-run:unit" });
    const prepareRef = refFixture("ref:prepare-evidence", "stage:prepare", "evidence");
    const successEvent: StagedTaskStageEvent = {
      schemaVersion: STAGED_TASK_SCHEMA_VERSION,
      eventId: "event:prepare-succeeded",
      kind: "stage.succeeded",
      taskRunId: initial.taskRunId,
      graphId: graph.graphId,
      stageId: "stage:prepare",
      at: "2026-06-04T00:00:00.000Z",
      outputRefs: [prepareRef],
      diagnostics: [],
      compatibility: STAGED_TASK_COMPATIBILITY,
      redaction: { class: "internal" }
    };

    const advanced = applyStagedTaskEvent(graph, initial, successEvent);
    const replayed = replayStagedTaskRun(graph, [successEvent], { taskRunId: initial.taskRunId });

    assert.equal(validation.ok, true);
    assert.deepEqual(readyStagedTaskStages(graph, initial).map((stage) => stage.stageId), ["stage:prepare"]);
    assert.equal(advanced.stageStates.find((stage) => stage.stageId === "stage:prepare")?.status, "succeeded");
    assert.equal(advanced.stageStates.find((stage) => stage.stageId === "stage:produce")?.status, "ready");
    assert.equal(advanced.refs[0]?.refId, prepareRef.refId);
    assert.deepEqual(replayed.stageStates, advanced.stageStates);
  });

  it("dispatches a ready stage through injected executors without exposing mutable state", async () => {
    const graph = graphFixture();
    const initial = createStagedTaskRunState(graph, { taskRunId: "task-run:executor" });
    let executorContextKeys: readonly string[] = [];
    const executor: StageExecutor = {
      kind: "process-check",
      async run(stage, context) {
        executorContextKeys = Object.keys(context).sort();
        return {
          schemaVersion: STAGED_TASK_SCHEMA_VERSION,
          status: "succeeded",
          outputRefs: [refFixture(stage.expectedOutputRefs[0]!, stage.stageId, "evidence")],
          diagnostics: [],
          compatibility: STAGED_TASK_COMPATIBILITY,
          redaction: { class: "internal" }
        };
      }
    };

    const result = await runReadyStage(graph, initial, "stage:prepare", {
      executors: [executor],
      now: () => "2026-06-04T00:00:00.000Z"
    });

    assert.deepEqual(result.events.map((event) => event.kind), ["stage.started", "stage.succeeded"]);
    assert.equal(result.state.stageStates.find((stage) => stage.stageId === "stage:prepare")?.status, "succeeded");
    assert.equal(executorContextKeys.includes("state"), false);
    assert.equal(executorContextKeys.includes("stateSnapshot"), false);
  });

  it("fails closed through a failure event when executor kind is not registered", async () => {
    const graph = graphFixture();
    const initial = createStagedTaskRunState(graph, { taskRunId: "task-run:missing-executor" });

    const result = await runReadyStage(graph, initial, "stage:prepare", {
      executors: [],
      now: () => "2026-06-04T00:00:00.000Z"
    });

    assert.deepEqual(result.events.map((event) => event.kind), ["stage.failed"]);
    assert.equal(result.state.stageStates.find((stage) => stage.stageId === "stage:prepare")?.status, "failed");
    assert.equal(result.events[0]?.diagnostics[0]?.code, "STAGED_TASK_EXECUTOR_NOT_REGISTERED");
  });
});

function graphFixture(): StagedTaskGraph {
  return {
    schemaVersion: STAGED_TASK_SCHEMA_VERSION,
    graphId: "graph:runtime-unit",
    profileId: "test/runtime-unit.v1",
    stages: [
      {
        schemaVersion: STAGED_TASK_SCHEMA_VERSION,
        stageId: "stage:prepare",
        kind: "collect-evidence",
        executorKind: "process-check",
        dependsOn: [],
        inputRefs: [],
        expectedOutputRefs: ["ref:prepare-evidence"],
        compatibility: STAGED_TASK_COMPATIBILITY,
        redaction: { class: "internal" }
      },
      {
        schemaVersion: STAGED_TASK_SCHEMA_VERSION,
        stageId: "stage:produce",
        kind: "produce",
        executorKind: "agent-loop",
        dependsOn: ["stage:prepare"],
        inputRefs: ["ref:prepare-evidence"],
        expectedOutputRefs: ["ref:generated-artifact"],
        compatibility: STAGED_TASK_COMPATIBILITY,
        redaction: { class: "internal" }
      },
      {
        schemaVersion: STAGED_TASK_SCHEMA_VERSION,
        stageId: "stage:verify",
        kind: "verify",
        executorKind: "artifact-scan",
        dependsOn: ["stage:produce"],
        inputRefs: ["ref:generated-artifact"],
        expectedOutputRefs: ["ref:verification"],
        compatibility: STAGED_TASK_COMPATIBILITY,
        redaction: { class: "internal" }
      }
    ],
    refs: [],
    compatibility: STAGED_TASK_COMPATIBILITY,
    redaction: { class: "internal" }
  };
}

function refFixture(refId: string, producerStageId: string, type: StagedTaskRef["type"]): StagedTaskRef {
  return {
    schemaVersion: STAGED_TASK_SCHEMA_VERSION,
    refId,
    type,
    producerStageId,
    scope: "task",
    fingerprint: `fnv1a:${refId}`,
    compatibility: STAGED_TASK_COMPATIBILITY,
    redaction: { class: "internal" }
  };
}
