import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CliEvaluationTaskDefinition } from "@deepseek/platform-contracts";
import { webpageTaskPrompt } from "../src/diagnostics/webpage-task.js";

describe("webpage evaluation task prompt", () => {
  it("requires a short fixed final response so evidence-first validation stays on artifacts", () => {
    const prompt = webpageTaskPrompt(task("eval.webpage.generation"));

    assert.equal(prompt.includes("Final response rules:"), true);
    assert.equal(prompt.includes("generated-webpage complete"), true);
    assert.equal(prompt.includes("Do not include product copy, package names, executable names, commands, file tables, markdown bullets, or verification details in the final answer."), true);
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
