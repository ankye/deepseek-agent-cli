import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STAGED_TASK_COMPATIBILITY, STAGED_TASK_SCHEMA_VERSION, type StagedTaskProfileRecord } from "@deepseek/platform-contracts";
import { compileTaskProfile, softwareEngineerProfile, webpageGenerationProfile } from "../src/index.js";

describe("task profile compiler", () => {
  it("compiles catalog profiles into replayable staged graphs", () => {
    const compiled = compileTaskProfile(webpageGenerationProfile);

    assert.equal(compiled.profileId, "evaluation/webpage-generation.v1");
    assert.equal(compiled.graph.stages.some((stage) => stage.executorKind === "agent-loop"), true);
    assert.equal(compiled.graph.refs.every((ref) => ref.producerStageId.startsWith("stage:")), true);
    assert.match(compiled.fingerprint, /^fnv1a:/);
  });

  it("keeps software engineering repair profiles grounded in boundary regression coverage", () => {
    const compiled = compileTaskProfile(softwareEngineerProfile);
    const plan = compiled.graph.stages.find((stage) => stage.stageId === "stage:plan");
    const change = compiled.graph.stages.find((stage) => stage.stageId === "stage:change");
    const verify = compiled.graph.stages.find((stage) => stage.stageId === "stage:verify");

    assert.equal(stringArray(plan?.parameters?.successCriteria).some((criterion) => criterion.includes("observed failure") && criterion.includes("boundary and negative cases")), true);
    assert.equal(stringArray(change?.parameters?.successCriteria).some((criterion) => criterion.includes("observed failure") && criterion.includes("edge cases")), true);
    assert.equal(stringArray(verify?.parameters?.successCriteria).some((criterion) => criterion.includes("happy path") && criterion.includes("negative regression cases")), true);
  });

  it("admits dynamic profiles as data while rejecting unknown executor mechanisms", () => {
    const dynamicProfile: StagedTaskProfileRecord = {
      schemaVersion: STAGED_TASK_SCHEMA_VERSION,
      profileId: "dynamic/unit/small-task.v1",
      title: "Small Dynamic Task",
      domain: "unit",
      source: "dynamic",
      scope: "task-run",
      provenance: { createdBy: "model", reason: "unit coverage for dynamic task profile admission" },
      fragments: [],
      overlays: [],
      stagePatches: [{
        stageId: "stage:produce",
        kind: "produce",
        executorKind: "agent-loop",
        dependsOn: [],
        expectedOutputRefs: ["ref:artifact"]
      }],
      compatibility: STAGED_TASK_COMPATIBILITY,
      redaction: { class: "internal", fields: ["provenance.reason"] }
    };

    const compiled = compileTaskProfile(dynamicProfile);

    assert.equal(compiled.sourceProfile.source, "dynamic");
    assert.throws(
      () => compileTaskProfile({
        ...dynamicProfile,
        profileId: "dynamic/unit/bad-executor.v1",
        stagePatches: [{
          stageId: "stage:raw",
          kind: "produce",
          executorKind: "raw-shell" as never,
          dependsOn: []
        }]
      }),
      /unsupported executor/i
    );
  });
});

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
