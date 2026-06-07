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
    if (command === "docker" && args[0] === "context" && args[1] === "inspect") {
      return {
        exitCode: 0,
        stdout: "\"unix:///workspace/.colima/default/docker.sock\"\n",
        stderr: "",
        metadata: fakeProviderMetadata()
      };
    }
    if (args.includes("swebench.harness.run_evaluation")) {
      const cwd = typeof options.cwd === "string" ? options.cwd : "/workspace/harness";
      const runId = argAfter(args, "--run_id") ?? "glm-run";
      const instanceIds = argsAfterListFlag(args, "--instance_ids");
      const selectedInstanceIds = instanceIds.length > 0 ? instanceIds : ["demo__repo-1"];
      const predictionPath = argAfter(args, "--predictions_path") ?? "/workspace/predictions/glm.jsonl";
      const predictions = (await this.readFile(predictionPath)).split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as JsonObject);
      const modelName = typeof predictions[0]?.model_name_or_path === "string" ? predictions[0].model_name_or_path : "glm-5.1";
      for (const instanceId of selectedInstanceIds) {
        const resolved = instanceId !== "demo__repo-2";
        await this.writeFile(`${cwd}/logs/run_evaluation/${runId}/${modelName}/${instanceId}/report.json`, JSON.stringify({
          [instanceId]: {
            resolved,
            tests_status: {
              FAIL_TO_PASS: {
                success: resolved ? ["tests/test_demo.py::test_fixed"] : [],
                failure: resolved ? [] : ["tests/test_demo.py::test_fixed"]
              },
              PASS_TO_PASS: {
                success: ["tests/test_demo.py::test_existing"],
                failure: []
              }
            }
          }
        }));
      }
      return {
        exitCode: 0,
        stdout: "Evaluation complete\n",
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

  it("preserves child CLI traces and appends supervised prediction records", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/instance.json", JSON.stringify({
      instance_id: "demo__repo-1",
      repo: "demo/repo",
      base_commit: "0123456789abcdef0123456789abcdef01234567",
      problem_statement: "Demo issue should update the placeholder value."
    }));
    await platform.writeFile("/workspace/predictions/glm.jsonl", `${JSON.stringify({
      instance_id: "demo__repo-0",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/old b/old\n"
    })}\n`);

    const summary = await collectSweBenchPrediction({
      action: "predict",
      dryRun: false,
      live: true,
      instanceFile: "/workspace/instance.json",
      repoDir: "/workspace/repo",
      outputPath: "/workspace/predictions/glm.jsonl",
      traceOutputPath: "/workspace/traces/demo__repo-1.jsonl",
      appendOutput: true,
      modelProvider: "glm",
      model: "glm-5.1",
      extraArgs: [],
      platform
    });

    const trace = await platform.readFile("/workspace/traces/demo__repo-1.jsonl");
    const lines = (await platform.readFile("/workspace/predictions/glm.jsonl")).split(/\r?\n/).filter(Boolean);
    const appended = JSON.parse(lines[1] as string) as JsonObject;

    assert.equal(summary.status, "pass");
    assert.equal(trace, "{\"kind\":\"agent.loop.completed\"}\n");
    assert.equal(lines.length, 2);
    assert.equal(appended.instance_id, "demo__repo-1");
    assert.equal(typeof appended.model_patch === "string" && appended.model_patch.includes("result = new_value"), true);
    assert.equal(summary.traceOutputPath, "/workspace/traces/demo__repo-1.jsonl");
    assert.equal(JSON.stringify(summary).includes("agent.loop.completed"), false);
    assert.equal(summary.redaction.fields?.includes("traceOutputPath"), true);
  });

  it("runs the official harness for a prediction and records the resolved report", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");

    const summary = await collectSweBenchPrediction({
      action: "evaluate",
      dryRun: false,
      live: false,
      outputPath: "/workspace/predictions/glm.jsonl",
      reportDir: "/workspace/harness",
      runId: "glm-run",
      instanceIds: ["demo__repo-1"],
      datasetName: "SWE-bench/SWE-bench_Lite",
      split: "test",
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    const harness = platform.executedCommands.find((entry) => entry.args.includes("swebench.harness.run_evaluation"));

    assert.equal(summary.status, "pass");
    assert.equal(summary.evaluation?.resolved, true);
    assert.equal(summary.evaluation?.completed, true);
    assert.equal(summary.evaluation?.reportPath, "/workspace/harness/logs/run_evaluation/glm-run/glm-5.1/demo__repo-1/report.json");
    assert.equal(summary.evaluation?.tests.failToPass.success, 1);
    assert.equal(summary.evaluation?.tests.failToPass.failure, 0);
    assert.equal(summary.evaluation?.tests.passToPass.success, 1);
    assert.equal(summary.evaluation?.tests.passToPass.failure, 0);
    assert.equal(harness?.command, "/workspace/.deepseek/swebench-venv/bin/python");
    assert.equal(harness?.cwd, "/workspace/harness");
    assert.equal(harness?.args.includes("--predictions_path"), true);
    assert.equal(harness?.args.includes("/workspace/predictions/glm.jsonl"), true);
    assert.equal(harness?.args.includes("--instance_ids"), true);
    assert.equal(harness?.args.includes("demo__repo-1"), true);
    assert.equal(harness?.env?.DOCKER_HOST, "unix:///workspace/.colima/default/docker.sock");
  });

  it("aggregates official harness reports across a SWE-bench batch", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", [
      JSON.stringify({
        instance_id: "demo__repo-1",
        model_name_or_path: "glm-5.1",
        model_patch: "diff --git a/src/example.py b/src/example.py\n"
      }),
      JSON.stringify({
        instance_id: "demo__repo-2",
        model_name_or_path: "glm-5.1",
        model_patch: "diff --git a/src/example.py b/src/example.py\n"
      }),
      ""
    ].join("\n"));

    const summary = await collectSweBenchPrediction({
      action: "evaluate",
      dryRun: false,
      live: false,
      outputPath: "/workspace/predictions/glm.jsonl",
      reportDir: "/workspace/harness",
      runId: "glm-batch",
      instanceIds: ["demo__repo-1", "demo__repo-2"],
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    assert.equal(summary.status, "pass");
    assert.equal(summary.evaluation?.batch.totalInstances, 2);
    assert.equal(summary.evaluation?.batch.resolvedInstances, 1);
    assert.deepEqual(summary.evaluation?.batch.unresolvedInstanceIds, ["demo__repo-2"]);
    assert.equal(summary.evaluation?.batch.resolvedRate, 0.5);
    assert.equal(summary.evaluation?.instances.length, 2);
    assert.equal(summary.evaluation?.instances[1]?.resolved, false);
    assert.equal(summary.evaluation?.instances[1]?.tests.failToPass.failure, 1);
  });

  it("fails the engineering gate when cache trace hit rate is below the target", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 200,
          metadata: {
            cache: { hitTokens: 800, missTokens: 200, hitRate: 0.8 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 0,
          metadata: {
            cache: { hitTokens: 100, missTokens: 0, hitRate: 1 }
          }
        }
      }),
      ""
    ].join("\n"));

    const summary = await collectSweBenchPrediction({
      action: "evaluate",
      dryRun: false,
      live: false,
      outputPath: "/workspace/predictions/glm.jsonl",
      reportDir: "/workspace/harness",
      runId: "glm-run",
      instanceIds: ["demo__repo-1"],
      cacheTracePath: "/workspace/traces/glm-run.jsonl",
      cacheHitTarget: 0.9,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    assert.equal(summary.status, "fail");
    assert.equal(summary.evaluation?.cache?.passed, false);
    assert.equal(summary.evaluation?.cache?.targetHitRate, 0.9);
    assert.equal(summary.evaluation?.cache?.hitTokens, 900);
    assert.equal(summary.evaluation?.cache?.missTokens, 200);
    assert.equal(summary.evaluation?.cache?.requestCount, 2);
    assert.equal(summary.evaluation?.cache?.lowHitRequestCount, 1);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_CACHE_HIT_TARGET_MISSED"), true);
  });

  it("normalizes relative harness paths before changing into the report directory", async () => {
    const workspaceRoot = process.cwd();
    const platform = new FakeSweBenchPlatform("fake", workspaceRoot);
    const absolutePredictionPath = `${workspaceRoot}/.deepseek/predictions/glm.jsonl`;
    await platform.writeFile(".deepseek/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile(absolutePredictionPath, JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");

    const summary = await collectSweBenchPrediction({
      action: "evaluate",
      dryRun: false,
      live: false,
      outputPath: ".deepseek/predictions/glm.jsonl",
      reportDir: ".deepseek/harness",
      runId: "glm-run",
      instanceIds: ["demo__repo-1"],
      harnessPython: ".deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    const harness = platform.executedCommands.find((entry) => entry.args.includes("swebench.harness.run_evaluation"));

    assert.equal(summary.status, "pass");
    assert.equal(harness?.command, `${workspaceRoot}/.deepseek/swebench-venv/bin/python`);
    assert.equal(harness?.cwd, `${workspaceRoot}/.deepseek/harness`);
    assert.equal(harness?.args.includes("--predictions_path"), true);
    assert.equal(harness?.args.includes(absolutePredictionPath), true);
    assert.equal(summary.evaluation?.reportPath, `${workspaceRoot}/.deepseek/harness/logs/run_evaluation/glm-run/glm-5.1/demo__repo-1/report.json`);
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

function argAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function argsAfterListFlag(args: readonly string[], flag: string): readonly string[] {
  const index = args.indexOf(flag);
  if (index < 0) return [];
  const values: string[] = [];
  for (let cursor = index + 1; cursor < args.length; cursor += 1) {
    const value = args[cursor];
    if (!value || value.startsWith("--")) break;
    values.push(value);
  }
  return values;
}
