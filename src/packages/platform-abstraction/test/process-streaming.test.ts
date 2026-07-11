import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("preserves workspace path case and recursively finds files in real checkouts", async () => {
    const platform = new NodePlatformRuntime("macos");
    const dir = await mkdtemp(join(tmpdir(), "deepseek-platform-paths-"));

    try {
      await mkdir(join(dir, "astropy", "modeling"), { recursive: true });
      await writeFile(join(dir, "README.rst"), "root readme\n", "utf8");
      await writeFile(join(dir, "astropy", "modeling", "separable.py"), "def separability_matrix(): pass\n", "utf8");

      const readme = platform.resolveWorkspacePath(dir, "README.rst");
      assert.equal(readme.ok, true);
      assert.equal(readme.value?.relativePath, "README.rst");

      const files = await platform.findFiles("separable.py", dir);
      assert.equal(files.some((file) => file.endsWith("astropy/modeling/separable.py")), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  it("kills descendant processes when the caller aborts a process run", async () => {
    const platform = new NodePlatformRuntime();
    const dir = await mkdtemp(join(tmpdir(), "deepseek-process-abort-"));
    const marker = join(dir, "child-survived.txt");
    const childCode = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "alive"), 600); setTimeout(() => {}, 5000);`;
    const parentCode = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: "ignore" }); setTimeout(() => {}, 5000);`;
    const controller = new AbortController();

    try {
      const pending = platform.runProcess(process.execPath, ["-e", parentCode], {}, undefined, { signal: controller.signal });
      setTimeout(() => controller.abort("test-abort"), 100);
      const result = await pending;
      assert.equal(result.exitCode, 130);
      await new Promise((resolve) => setTimeout(resolve, 900));
      await assert.rejects(access(marker));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
