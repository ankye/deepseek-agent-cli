import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compileTaskProfile,
  getTaskProfile,
  listTaskProfiles,
  webpageGenerationProfile
} from "@deepseek/task-profiles";
import {
  STAGED_TASK_COMPATIBILITY,
  STAGED_TASK_SCHEMA_VERSION,
  type StagedTaskProfileRecord
} from "@deepseek/platform-contracts";

describe("task profile catalog", () => {
  it("exposes a host-neutral webpage generation profile", () => {
    const profile = getTaskProfile("evaluation/webpage-generation.v1");

    assert.equal(profile?.profileId, webpageGenerationProfile.profileId);
    assert.deepEqual(
      listTaskProfiles().map((entry) => entry.profileId),
      ["evaluation/webpage-generation.v1"]
    );
  });

  it("compiles base, fragments, overlays, and local params into a stable typed DAG", () => {
    const compiled = compileTaskProfile(webpageGenerationProfile, {
      overlays: ["overlay/live-glm-expanded-budget.v1", "overlay/strict-evidence-manifest.v1"],
      parameters: { modelProfileHint: "glm-5.1", workspaceRootRef: "ref:workspace-root" }
    });
    const secondPass = compileTaskProfile(webpageGenerationProfile, {
      overlays: ["overlay/live-glm-expanded-budget.v1", "overlay/strict-evidence-manifest.v1"],
      parameters: { modelProfileHint: "glm-5.1", workspaceRootRef: "ref:workspace-root" }
    });

    assert.equal(compiled.profileId, "evaluation/webpage-generation.v1");
    assert.equal(compiled.fingerprint, secondPass.fingerprint);
    assert.equal(compiled.graph.profileId, compiled.profileId);
    assert.ok(compiled.graph.stages.length >= 5);
    assert.equal(compiled.graph.stages.some((stage) => stage.executorKind === "agent-loop"), true);
    assert.equal(compiled.graph.stages.some((stage) => stage.executorKind === "process-check"), true);
    assert.equal(compiled.graph.stages.some((stage) => stage.executorKind === "artifact-scan"), true);
    assert.equal(new Set(compiled.graph.stages.map((stage) => stage.stageId)).size, compiled.graph.stages.length);
    assert.ok(compiled.graph.refs.every((ref) => ref.producerStageId.length > 0));
  });

  it("fails closed when profile composition creates duplicate stages or dependency cycles", () => {
    assert.throws(
      () => compileTaskProfile({
        ...webpageGenerationProfile,
        profileId: "evaluation/duplicate-stage.v1",
        stagePatches: [{
          stageId: "stage:duplicate",
          kind: "produce",
          executorKind: "agent-loop",
          dependsOn: []
        }, {
          stageId: "stage:duplicate",
          kind: "verify",
          executorKind: "process-check",
          dependsOn: []
        }]
      }),
      /duplicate stage/i
    );

    assert.throws(
      () => compileTaskProfile({
        ...webpageGenerationProfile,
        profileId: "evaluation/cyclic-stage.v1",
        stagePatches: [{
          stageId: "stage:collect-evidence",
          kind: "collect-evidence",
          executorKind: "process-check",
          dependsOn: ["stage:score-task"]
        }]
      }),
      /cycle/i
    );
  });

  it("admits AI-generated dynamic profiles as scoped data with stable fingerprints", () => {
    const dynamicProfile: StagedTaskProfileRecord = {
      schemaVersion: STAGED_TASK_SCHEMA_VERSION,
      profileId: "dynamic/evaluation/ad-hoc-webpage.v1",
      title: "Ad Hoc Webpage Evaluation",
      domain: "evaluation",
      source: "dynamic",
      scope: "task-run",
      provenance: {
        createdBy: "model",
        reason: "The task shape is close to webpage generation but uses a narrower checker."
      },
      fragments: [
        "fragment/collect-project-evidence.v1",
        "fragment/agent-produce-artifacts.v1",
        "fragment/process-check.v1"
      ],
      overlays: ["overlay/live-glm-expanded-budget.v1"],
      stagePatches: [{
        stageId: "stage:ad-hoc-score",
        kind: "score",
        executorKind: "manual",
        dependsOn: ["stage:run-check"],
        inputRefs: ["ref:process-check"],
        expectedOutputRefs: ["ref:ad-hoc-score"]
      }],
      parameters: { objective: "generate and check a small webpage artifact" },
      compatibility: STAGED_TASK_COMPATIBILITY,
      redaction: { class: "internal", fields: ["provenance.reason"] }
    };

    const compiled = compileTaskProfile(dynamicProfile);
    const secondPass = compileTaskProfile(dynamicProfile);

    assert.equal(compiled.sourceProfile.source, "dynamic");
    assert.equal(compiled.sourceProfile.scope, "task-run");
    assert.equal(compiled.fingerprint, secondPass.fingerprint);
    assert.equal(compiled.graph.metadata?.profileSource, "dynamic");
    assert.equal(compiled.graph.stages.some((stage) => stage.stageId === "stage:ad-hoc-score"), true);
  });

  it("rejects dynamic profiles that bypass executor admission or budget caps", () => {
    const baseDynamicProfile: StagedTaskProfileRecord = {
      schemaVersion: STAGED_TASK_SCHEMA_VERSION,
      profileId: "dynamic/evaluation/rejected.v1",
      title: "Rejected Dynamic Profile",
      domain: "evaluation",
      source: "dynamic",
      scope: "task-run",
      provenance: { createdBy: "model", reason: "negative admission coverage" },
      fragments: [],
      overlays: [],
      compatibility: STAGED_TASK_COMPATIBILITY,
      redaction: { class: "internal" }
    };

    assert.throws(
      () => compileTaskProfile({
        ...baseDynamicProfile,
        stagePatches: [{
          stageId: "stage:unknown",
          kind: "produce",
          executorKind: "raw-shell" as never,
          dependsOn: []
        }]
      }),
      /unsupported executor/i
    );

    assert.throws(
      () => compileTaskProfile({
        ...baseDynamicProfile,
        stagePatches: [{
          stageId: "stage:over-budget",
          kind: "produce",
          executorKind: "agent-loop",
          dependsOn: [],
          budget: { maxToolCalls: 10_000 }
        }]
      }),
      /budget/i
    );
  });
});
