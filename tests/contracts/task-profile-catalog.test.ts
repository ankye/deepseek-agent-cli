import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compileTaskProfile,
  getTaskProfile,
  listTaskProfiles,
  softwareEngineerProfile,
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
      ["evaluation/webpage-generation.v1", "engineering/software-engineer.v1"]
    );
  });

  it("exposes software-engineer as a reusable staged engineering workflow contract", () => {
    assert.equal(getTaskProfile("software-engineer")?.profileId, softwareEngineerProfile.profileId);

    const compiled = compileTaskProfile(softwareEngineerProfile, {
      parameters: { workspaceRootRef: "ref:workspace-root" }
    });
    const stages = compiled.graph.stages;

    assert.equal(compiled.profileId, "engineering/software-engineer.v1");
    assert.deepEqual(
      stages.map((stage) => stage.stageId),
      ["stage:understand", "stage:plan", "stage:change", "stage:verify", "stage:report"]
    );
    assert.deepEqual(stages.map((stage) => stage.dependsOn), [
      [],
      ["stage:understand"],
      ["stage:plan"],
      ["stage:change"],
      ["stage:verify"]
    ]);

    for (const stage of stages) {
      const parameters = stage.parameters as {
        readonly requiredFamilyIds?: readonly string[];
        readonly successCriteria?: readonly string[];
        readonly requiredEvidenceRefs?: readonly string[];
        readonly fallbackBlockerCriteria?: readonly string[];
        readonly decisionBoardProjection?: { readonly profileId?: string; readonly stageId?: string };
      } | undefined;

      assert.ok(stage.allowedTools?.length, `${stage.stageId} should declare allowed tool families`);
      assert.ok(parameters?.requiredFamilyIds?.length, `${stage.stageId} should declare required tool families`);
      assert.ok(parameters?.successCriteria?.length, `${stage.stageId} should declare success criteria`);
      assert.ok(parameters?.requiredEvidenceRefs?.length, `${stage.stageId} should declare required evidence refs`);
      assert.ok(parameters?.fallbackBlockerCriteria?.length, `${stage.stageId} should declare blocker criteria`);
      assert.equal(parameters?.decisionBoardProjection?.profileId, "engineering/software-engineer.v1");
      assert.equal(parameters?.decisionBoardProjection?.stageId, stage.stageId);
      assert.deepEqual(stage.acceptance?.requiredRefs, parameters?.requiredEvidenceRefs);
    }

    assert.deepEqual(stages[0]?.allowedTools, [
      "file.read",
      "file.list",
      "file.stat",
      "json.read",
      "path.resolve",
      "workspace.glob",
      "search.text",
      "search.symbol",
      "code.diagnostics-lsp",
      "git.status-diff",
      "context.project-index"
    ]);
    assert.deepEqual(stages[2]?.allowedTools, [
      "file.write",
      "file.edit",
      "file.copy",
      "file.move",
      "file.delete",
      "directory.create",
      "file.touch",
      "json.patch",
      "patch.apply",
      "revert.undo",
      "shell.run",
      "process.output",
      "git.status-diff"
    ]);
    assert.deepEqual(stages[3]?.allowedTools, [
      "shell.run",
      "process.output",
      "code.diagnostics-lsp",
      "build.test-lint-typecheck",
      "package.manager",
      "git.status-diff"
    ]);
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
