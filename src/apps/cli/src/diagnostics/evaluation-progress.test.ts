import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEvaluationProgressObserver, progressLineFromChildJsonl, progressLineFromInstrumentationEvent } from "./evaluation-progress.js";

describe("diagnostics evaluation progress", () => {
  it("flushes a final child JSONL progress line when the child exits without a trailing newline", () => {
    const lines: string[] = [];
    const observer = createEvaluationProgressObserver("eval.test", { emit: (line) => lines.push(line) });

    observer?.onStdoutChunk?.(JSON.stringify({ kind: "model.tool.intent", data: { name: "core.file.read" } }));
    (observer as { readonly onProcessExit?: () => void } | undefined)?.onProcessExit?.();

    assert.deepEqual(lines, ["progress eval.test: tool core.file.read started"]);
  });

  it("rejects unsafe child progress field values instead of rendering raw payload text", () => {
    const line = progressLineFromChildJsonl("eval.test", JSON.stringify({
      kind: "model.tool.result",
      data: {
        name: "core.file.read\nsk-secret-value",
        status: "success\nraw provider body"
      }
    }));

    assert.equal(line, "progress eval.test: tool unknown completed");
    assert.equal(line?.includes("\n"), false);
    assert.equal(line?.includes("sk-secret-value"), false);
    assert.equal(line?.includes("raw provider body"), false);
  });

  it("rejects unsafe repair reasons instead of appending untrusted free text", () => {
    const line = progressLineFromChildJsonl("eval.test", JSON.stringify({
      kind: "agent.loop.failed",
      data: { reason: "failed\nBearer secret-token" }
    }));

    assert.equal(line, "progress eval.test: loop failed");
  });

  it("sanitizes public progress identifiers and outcome labels", () => {
    const childLine = progressLineFromChildJsonl("eval.test\nsk-secret", JSON.stringify({
      kind: "model.tool.intent",
      data: { name: "core.file.read" }
    }));
    const phaseLine = progressLineFromInstrumentationEvent("eval.test\nsk-secret", "deepseek-cli\nsecret", "run_started", {});
    const outcomeLine = progressLineFromInstrumentationEvent("eval.test", "deepseek-cli", "run_finished", { outcome: "solved\nsecret" });

    assert.equal(childLine, "progress unknown: tool core.file.read started");
    assert.equal(phaseLine, "progress unknown: task started baseline=unknown");
    assert.equal(outcomeLine, "progress eval.test: task finished");
  });
});
