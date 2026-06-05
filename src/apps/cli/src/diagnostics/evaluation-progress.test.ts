import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEvaluationProgressObserver } from "./evaluation-progress.js";

describe("diagnostics evaluation progress", () => {
  it("flushes a final child JSONL progress line when the child exits without a trailing newline", () => {
    const lines: string[] = [];
    const observer = createEvaluationProgressObserver("eval.test", { emit: (line) => lines.push(line) });

    observer?.onStdoutChunk?.(JSON.stringify({ kind: "model.tool.intent", data: { name: "core.file.read" } }));
    (observer as { readonly onProcessExit?: () => void } | undefined)?.onProcessExit?.();

    assert.deepEqual(lines, ["progress eval.test: tool core.file.read started"]);
  });
});
