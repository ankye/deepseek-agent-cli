import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, PlatformProviderResultMetadata, ProcessResult, ProcessRunOptions } from "@deepseek/platform-contracts";
import { FakePlatformRuntime } from "@deepseek/platform-abstraction";
import { collectSweBenchPrediction, sweBenchPredictionJsonLines } from "./swe-bench-prediction.js";

class FakeSweBenchPlatform extends FakePlatformRuntime {
  readonly executedCommands: { readonly command: string; readonly args: readonly string[]; readonly cwd?: string; readonly env?: JsonObject }[] = [];

  override async runProcess(command: string, args: readonly string[], options: ProcessRunOptions = {}): Promise<ProcessResult> {
    this.executedCommands.push({
      command,
      args,
      ...(typeof options.cwd === "string" ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {})
    });
    if (command === "git" && args[0] === "diff") {
      return {
        exitCode: 0,
        stdout: [
          "diff --git a/src/example.py b/src/example.py",
          "--- a/src/example.py",
          "+++ b/src/example.py",
          "@@ -1,2 +1,2 @@",
          "-result = old_value",
          "+result = new_value",
          ""
        ].join("\n"),
        stderr: "",
        metadata: fakeProviderMetadata()
      };
    }
    return {
      exitCode: 0,
      stdout: "{\"kind\":\"agent.loop.completed\"}\n",
      stderr: "",
      metadata: fakeProviderMetadata()
    };
  }
}

describe("SWE-bench prediction adapter", () => {
  it("runs the selected CLI provider and writes official prediction JSONL", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/instance.json", JSON.stringify({
      instance_id: "demo__repo-1",
      repo: "demo/repo",
      base_commit: "0123456789abcdef0123456789abcdef01234567",
      problem_statement: "Demo issue should update the placeholder value."
    }));

    const summary = await collectSweBenchPrediction({
      action: "predict",
      dryRun: false,
      live: true,
      instanceFile: "/workspace/instance.json",
      repoDir: "/workspace/repo",
      outputPath: "/workspace/predictions/glm.jsonl",
      modelProvider: "glm",
      model: "glm-5.1",
      extraArgs: [],
      platform
    });

    const prediction = summary.predictions[0];
    const written = JSON.parse(await platform.readFile("/workspace/predictions/glm.jsonl")) as JsonObject;
    const child = platform.executedCommands.find((entry) => entry.command === process.execPath);

    assert.equal(summary.status, "pass");
    assert.equal(prediction?.instance_id, "demo__repo-1");
    assert.equal(prediction?.model_name_or_path, "glm-5.1");
    assert.equal(prediction?.model_patch.includes("result = new_value"), true);
    assert.equal(written.instance_id, "demo__repo-1");
    assert.equal(child?.cwd, "/workspace/repo");
    assert.equal(child?.args.includes("--provider"), true);
    assert.equal(child?.args.includes("glm"), true);
    assert.equal(child?.args.includes("--model"), true);
    assert.equal(child?.args.includes("glm-5.1"), true);
    assert.equal(child?.args.includes("--tool-projection"), true);
    assert.equal(child?.args.includes("all"), true);
    assert.equal(JSON.stringify(summary).includes("GLM_ANTHROPIC_API_KEY"), false);
  });

  it("fails before execution when required inputs are missing", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    const summary = await collectSweBenchPrediction({
      action: "predict",
      dryRun: false,
      live: true,
      instanceFile: "",
      repoDir: "/workspace/repo",
      outputPath: "/workspace/predictions/glm.jsonl",
      modelProvider: "glm",
      model: "glm-5.1",
      extraArgs: ["--surprise"],
      platform
    });

    assert.equal(summary.status, "fail");
    assert.equal(summary.diagnostics.some((diagnostic) => diagnostic.code === "SWE_BENCH_PREDICTION_INVALID_INPUT"), true);
    assert.equal(platform.executedCommands.length, 0);
  });

  it("renders structured JSONL records for predictions and diagnostics", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/instance.json", JSON.stringify({
      instance_id: "demo__repo-1",
      problem_statement: "Demo issue should update the placeholder value."
    }));
    const summary = await collectSweBenchPrediction({
      action: "predict",
      dryRun: true,
      live: false,
      instanceFile: "/workspace/instance.json",
      repoDir: "/workspace/repo",
      outputPath: "/workspace/predictions/glm.jsonl",
      modelProvider: "glm",
      model: "glm-5.1",
      extraArgs: [],
      platform
    });

    const records = sweBenchPredictionJsonLines(summary);

    assert.equal(records[0]?.kind, "diagnostics.swe-bench.summary");
    assert.equal(records.some((record) => {
      const prediction = record.prediction;
      return record.kind === "diagnostics.swe-bench.prediction"
        && isRecord(prediction)
        && prediction.instance_id === "demo__repo-1";
    }), true);
  });
});

function fakeProviderMetadata(): PlatformProviderResultMetadata {
  return {
    selectedProvider: "argv",
    status: "available",
    fallbackChain: [],
    degradedReasons: [],
    diagnostics: [],
    redaction: { class: "internal" }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
