import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("notifies the optional process observer when the process exits", async () => {
    const platform = new NodePlatformRuntime();
    let exited = false;

    const result = await platform.runProcess(
      process.execPath,
      ["-e", "process.stdout.write('done')"],
      {},
      { onProcessExit: () => { exited = true; } }
    );

    assert.equal(result.exitCode, 0);
    assert.equal(exited, true);
  });

  it("kills descendant processes when a process times out", async () => {
    const platform = new NodePlatformRuntime();
    const dir = await mkdtemp(join(tmpdir(), "deepseek-process-timeout-"));
    const marker = join(dir, "child-survived.txt");
    const childCode = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 600); setTimeout(() => {}, 5000);`;
    const parentCode = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" }); setTimeout(() => {}, 5000);`;

    try {
      const result = await platform.runProcess(process.execPath, ["-e", parentCode], { timeoutMs: 100 });
      assert.equal(result.exitCode, 124);
      await new Promise((resolve) => setTimeout(resolve, 900));
      await assert.rejects(access(marker));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
