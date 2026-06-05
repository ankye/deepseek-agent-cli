import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEvaluationProgressObserver, progressLineFromChildJsonl } from "./evaluation-progress.js";

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
});
