import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NodePlatformRuntime } from "../src/index.js";

describe("platform process streaming", () => {
  it("streams stdout chunks through the optional process observer before completion", async () => {
    const platform = new NodePlatformRuntime();
    const chunks: string[] = [];

    const result = await platform.runProcess(
      process.execPath,
      ["-e", "process.stdout.write('one\\n'); setTimeout(() => process.stdout.write('two\\n'), 20);"],
      {},
      { onStdoutChunk: (chunk) => chunks.push(chunk) }
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.includes("one"), true);
    assert.equal(result.stdout.includes("two"), true);
    assert.equal(chunks.join("").includes("one"), true);
    assert.equal(chunks.join("").includes("two"), true);
  });
});
