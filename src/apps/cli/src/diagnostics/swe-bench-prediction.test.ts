import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, PlatformProviderResultMetadata, ProcessResult, ProcessRunObserver, ProcessRunOptions } from "@deepseek/platform-contracts";
import { FakePlatformRuntime } from "@deepseek/platform-abstraction";
import { collectSweBenchPrediction, renderSweBenchPredictionText, sweBenchPredictionJsonLines } from "./swe-bench-prediction.js";

class FakeSweBenchPlatform extends FakePlatformRuntime {
  readonly executedCommands: { readonly command: string; readonly args: readonly string[]; readonly cwd?: string; readonly env?: JsonObject }[] = [];
  readonly writes: { readonly path: string; readonly content: string }[] = [];
  private readonly fileMtimeMs = new Map<string, number>();
  private fileClock = 0;
  agentStdout = "{\"kind\":\"agent.loop.completed\"}\n";
  streamAgentStdout = false;
  skipHarnessReportWrite = false;
  harnessErrorIds: string[] = [];
  harnessErrorLogByInstanceId = new Map<string, string>();
  harnessTestOutputByInstanceId = new Map<string, string>();
  fallbackLocalBuildOnDockerImageMiss = false;

  override async writeFile(path: string, content: string): Promise<void> {
    this.writes.push({ path, content });
    this.fileMtimeMs.set(path, ++this.fileClock);
    await super.writeFile(path, content);
  }

  override async statFile(path: string): Promise<{ mtimeMs: number; size: number }> {
    const content = await this.readFile(path);
    return {
      mtimeMs: this.fileMtimeMs.get(path) ?? 0,
      size: Buffer.byteLength(content, "utf8")
    };
  }

  override async runProcess(command: string, args: readonly string[], options: ProcessRunOptions = {}, observer?: ProcessRunObserver): Promise<ProcessResult> {
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
      const localBuildFallback = args.includes("--namespace") && args.includes("none") && args.includes("--force_rebuild") && args.includes("true");
      const harnessErrorIds = this.fallbackLocalBuildOnDockerImageMiss && localBuildFallback ? [] : this.harnessErrorIds;
      const predictions = (await this.readFile(predictionPath)).split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as JsonObject);
      const modelName = typeof predictions[0]?.model_name_or_path === "string" ? predictions[0].model_name_or_path : "glm-5.1";
      const emptyPatchIds = selectedInstanceIds.filter((instanceId) =>
        predictions.some((prediction) =>
          prediction.instance_id === instanceId &&
          typeof prediction.model_patch === "string" &&
          prediction.model_patch.trim().length === 0
        )
      );
      await this.writeFile(`${cwd}/${modelName}.${runId}.json`, JSON.stringify({
        total_instances: selectedInstanceIds.length,
        submitted_instances: selectedInstanceIds.length,
        completed_instances: selectedInstanceIds.filter((instanceId) => !harnessErrorIds.includes(instanceId) && !emptyPatchIds.includes(instanceId)).length,
        resolved_instances: selectedInstanceIds.filter((instanceId) => instanceId !== "demo__repo-2" && !harnessErrorIds.includes(instanceId) && !emptyPatchIds.includes(instanceId)).length,
        unresolved_instances: selectedInstanceIds.filter((instanceId) => instanceId === "demo__repo-2" && !emptyPatchIds.includes(instanceId)).length,
        empty_patch_instances: emptyPatchIds.length,
        error_instances: harnessErrorIds.length,
        completed_ids: selectedInstanceIds.filter((instanceId) => !harnessErrorIds.includes(instanceId) && !emptyPatchIds.includes(instanceId)),
        submitted_ids: selectedInstanceIds,
        resolved_ids: selectedInstanceIds.filter((instanceId) => instanceId !== "demo__repo-2" && !harnessErrorIds.includes(instanceId) && !emptyPatchIds.includes(instanceId)),
        unresolved_ids: selectedInstanceIds.filter((instanceId) => instanceId === "demo__repo-2" && !emptyPatchIds.includes(instanceId)),
        empty_patch_ids: emptyPatchIds,
        error_ids: harnessErrorIds,
        schema_version: 2
      }));
      for (const instanceId of selectedInstanceIds) {
        if (emptyPatchIds.includes(instanceId)) continue;
        if (harnessErrorIds.includes(instanceId)) {
          const log = this.harnessErrorLogByInstanceId.get(instanceId);
          if (log) await this.writeFile(`${cwd}/logs/run_evaluation/${runId}/${modelName}/${instanceId}/run_instance.log`, log);
          continue;
        }
        const resolved = instanceId !== "demo__repo-2";
        if (!this.skipHarnessReportWrite) {
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
          const testOutput = this.harnessTestOutputByInstanceId.get(instanceId);
          if (testOutput) await this.writeFile(`${cwd}/logs/run_evaluation/${runId}/${modelName}/${instanceId}/test_output.txt`, testOutput);
        }
      }
      return {
        exitCode: 0,
        stdout: "Evaluation complete\n",
        stderr: "",
        metadata: fakeProviderMetadata()
      };
    }
    if (this.streamAgentStdout) {
      const midpoint = Math.max(1, Math.floor(this.agentStdout.length / 2));
      observer?.onStdoutChunk?.(this.agentStdout.slice(0, midpoint));
      await Promise.resolve();
      observer?.onStdoutChunk?.(this.agentStdout.slice(midpoint));
      await Promise.resolve();
      observer?.onProcessExit?.();
    }
    return {
      exitCode: 0,
      stdout: this.agentStdout,
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

  it("passes the managed SWE-bench execution profile to the child CLI", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/instance.json", JSON.stringify({
      instance_id: "demo__repo-1",
      repo: "demo/repo",
      base_commit: "0123456789abcdef0123456789abcdef01234567",
      problem_statement: "Demo issue should update the placeholder value."
    }));

    await collectSweBenchPrediction({
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

    const child = platform.executedCommands.find((entry) => entry.command === process.execPath);
    const runIndex = child?.args.indexOf("run") ?? -1;
    const prompt = runIndex >= 0 ? child?.args[runIndex + 1] ?? "" : "";

    assert.equal(prompt.includes("Managed SWE-bench execution profile"), true);
    assert.equal(prompt.includes("Phase budget"), true);
    assert.equal(prompt.includes("Before final answer, run at least one model-authored standard test command"), true);
    assert.equal(prompt.includes("pytest"), true);
    assert.equal(prompt.includes("If no standard test command has been attempted, do not answer SWE patch ready"), true);
    assert.equal(prompt.includes("Before trusting existing tests, derive the smallest reproduction from the Problem statement"), true);
    assert.equal(prompt.includes("After patch, run that reproduction or an equivalent focused regression"), true);
    assert.equal(prompt.includes("Verification cost budget: use the cheapest command that can falsify the patch first"), true);
    assert.equal(prompt.includes("After a passing focused standard test, stop local testing and leave broader scoring to the supervisor harness"), true);
  });

  it("passes previous patch status to supervised repair prompts", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/instance.json", JSON.stringify({
      instance_id: "demo__repo-1",
      repo: "demo/repo",
      base_commit: "0123456789abcdef0123456789abcdef01234567",
      problem_statement: "Demo issue should update the placeholder value."
    }));

    await collectSweBenchPrediction({
      action: "predict",
      dryRun: false,
      live: true,
      instanceFile: "/workspace/instance.json",
      repoDir: "/workspace/repo",
      outputPath: "/workspace/predictions/glm.jsonl",
      modelProvider: "glm",
      model: "glm-5.1",
      repairContext: {
        attemptNumber: 2,
        previousRunId: "unit-eval-1",
        failingTests: ["tests/test_demo.py::test_expected_fix"],
        failureExcerpts: [{
          testId: "tests/test_demo.py::test_expected_fix",
          excerpt: "E   ValueError: could not convert string to float: 'no'",
          redaction: { class: "internal", fields: ["excerpt"] }
        }],
        previousPatchBytes: 624,
        redaction: { class: "internal", fields: ["failingTests", "failureExcerpts"] }
      },
      extraArgs: [],
      platform
    });

    const child = platform.executedCommands.find((entry) => entry.command === process.execPath);
    const runIndex = child?.args.indexOf("run") ?? -1;
    const prompt = runIndex >= 0 ? child?.args[runIndex + 1] ?? "" : "";

    assert.equal(prompt.includes("Previous supervised attempt feedback"), true);
    assert.equal(prompt.includes("Previous patch status: non-empty patchBytes=624"), true);
    assert.equal(prompt.includes("tests/test_demo.py::test_expected_fix"), true);
    assert.equal(prompt.includes("Official harness failure excerpts"), true);
    assert.equal(prompt.includes("ValueError: could not convert string to float: 'no'"), true);
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
    assert.equal(summary.childTrace?.terminalKind, "agent.loop.completed");
    assert.equal(summary.childTrace?.modelRequestCount, 0);
    assert.equal(JSON.stringify(summary).includes("\"kind\":\"agent.loop.completed\""), false);
    assert.equal(summary.redaction.fields?.includes("traceOutputPath"), true);
  });

  it("streams child CLI trace chunks to the trace file before final prediction collation", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    platform.streamAgentStdout = true;
    platform.agentStdout = [
      JSON.stringify({ kind: "model.requested", data: { iteration: 1 } }),
      JSON.stringify({ kind: "model.delta", data: { text: "x".repeat(40_000) } }),
      JSON.stringify({ kind: "model.tool.intent", data: { toolName: "core.shell.run", iteration: 1 } }),
      JSON.stringify({ kind: "agent.loop.completed", data: { status: "completed" } }),
      ""
    ].join("\n");
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
      traceOutputPath: "/workspace/traces/demo__repo-1.jsonl",
      modelProvider: "glm",
      model: "glm-5.1",
      extraArgs: [],
      platform
    });

    const traceWrites = platform.writes.filter((write) => write.path === "/workspace/traces/demo__repo-1.jsonl");

    assert.equal(summary.status, "pass");
    assert.equal(traceWrites.length >= 2, true);
    assert.equal(traceWrites.at(-1)?.content, platform.agentStdout);
    assert.equal(traceWrites.some((write) => write.content.length > 0 && write.content.length < platform.agentStdout.length), true);
  });

  it("warns when the supervised child trace ends in a failed terminal event", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    platform.agentStdout = [
      JSON.stringify({ kind: "model.requested", data: { iteration: 1 } }),
      JSON.stringify({ kind: "model.delta", data: { text: "raw model body should stay in the trace file only" } }),
      JSON.stringify({ kind: "model.tool.intent", data: { toolName: "core.shell.run", iteration: 1 } }),
      JSON.stringify({ kind: "usage.updated", data: { inputTokens: 100, outputTokens: 10 } }),
      JSON.stringify({ kind: "agent.loop.failed", data: { status: "rejected", reason: "model-iteration-limit", iterations: 48, toolCalls: 48 } }),
      ""
    ].join("\n");
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
      traceOutputPath: "/workspace/traces/demo__repo-1.jsonl",
      modelProvider: "glm",
      model: "glm-5.1",
      extraArgs: [],
      platform
    });

    assert.equal(summary.status, "warn");
    assert.equal(summary.childTrace?.terminalKind, "agent.loop.failed");
    assert.equal(summary.childTrace?.terminalStatus, "rejected");
    assert.equal(summary.childTrace?.terminalReason, "model-iteration-limit");
    assert.equal(summary.childTrace?.iterationCount, 48);
    assert.equal(summary.childTrace?.modelRequestCount, 1);
    assert.equal(summary.childTrace?.usageEventCount, 1);
    assert.equal(summary.childTrace?.toolIntentCount, 1);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_CHILD_TRACE_TERMINAL_FAILED"), true);
    assert.equal(JSON.stringify(summary).includes("raw model body"), false);
  });

  it("warns when the supervised child trace has no model-authored SWE verification command", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    platform.agentStdout = [
      JSON.stringify({ kind: "model.requested", data: { iteration: 1 } }),
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          name: "core.shell.run",
          input: {
            command: "python -c \"print('manual probe only')\""
          },
          iteration: 1
        }
      }),
      JSON.stringify({ kind: "agent.loop.completed", data: { status: "completed" } }),
      ""
    ].join("\n");
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
      traceOutputPath: "/workspace/traces/demo__repo-1.jsonl",
      modelProvider: "glm",
      model: "glm-5.1",
      extraArgs: [],
      platform
    });

    assert.equal(summary.status, "warn");
    assert.equal(summary.childTrace?.shellCommandCount, 1);
    assert.equal(summary.childTrace?.testCommandCount, 0);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_CHILD_TRACE_VERIFICATION_MISSING"), true);
  });

  it("does not warn when the supervised child trace includes a model-authored SWE verification command", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    platform.agentStdout = [
      JSON.stringify({ kind: "model.requested", data: { iteration: 1 } }),
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          name: "core.shell.run",
          input: {
            command: "python -m pytest astropy/io/ascii/tests/test_rst.py -k header_rows"
          },
          iteration: 1
        }
      }),
      JSON.stringify({ kind: "agent.loop.completed", data: { status: "completed" } }),
      ""
    ].join("\n");
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
      traceOutputPath: "/workspace/traces/demo__repo-1.jsonl",
      modelProvider: "glm",
      model: "glm-5.1",
      extraArgs: [],
      platform
    });

    assert.equal(summary.status, "pass");
    assert.equal(summary.childTrace?.shellCommandCount, 1);
    assert.equal(summary.childTrace?.testCommandCount, 1);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_CHILD_TRACE_VERIFICATION_MISSING"), false);
  });

  it("does not warn when the supervised child trace verifies through core.test.run", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    platform.agentStdout = [
      JSON.stringify({ kind: "model.requested", data: { iteration: 1 } }),
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          name: "core.shell.run",
          input: {
            command: "python -c \"print('manual probe only')\""
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          name: "core.test.run",
          input: {
            command: "python",
            args: ["-m", "pytest", "astropy/io/ascii/tests/test_rst.py::test_rst_with_header_rows", "-q"]
          },
          iteration: 2
        }
      }),
      JSON.stringify({ kind: "agent.loop.completed", data: { status: "completed" } }),
      ""
    ].join("\n");
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
      traceOutputPath: "/workspace/traces/demo__repo-1.jsonl",
      modelProvider: "glm",
      model: "glm-5.1",
      extraArgs: [],
      platform
    });

    assert.equal(summary.status, "pass");
    assert.equal(summary.childTrace?.shellCommandCount, 1);
    assert.equal(summary.childTrace?.testCommandCount, 1);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_CHILD_TRACE_VERIFICATION_MISSING"), false);
  });

  it("diagnoses pytest internal dependency API mismatches from child test output", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    platform.agentStdout = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          name: "core.test.run",
          input: {
            command: "python -m pytest",
            args: ["astropy/io/ascii/tests/test_qdp.py", "-xvs"]
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolName: "core.test.run",
          result: [
            "Tool core.test.run reported failed:",
            "INTERNALERROR> Traceback (most recent call last):",
            "INTERNALERROR> AttributeError: module 'numpy' has no attribute 'product'"
          ].join("\n"),
          feedback: { status: "failed" }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: { kind: "verification", stopReason: "swe-bench-environment-blocker" },
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          shellCommandCount: 0,
          testCommandCount: 1,
          sourceMutationCount: 1
        }
      }),
      ""
    ].join("\n");
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
      traceOutputPath: "/workspace/traces/demo__repo-1.jsonl",
      modelProvider: "glm",
      model: "glm-5.1",
      extraArgs: [],
      platform
    });

    assert.equal(summary.status, "warn");
    assert.equal(summary.childTrace?.diagnosticCodes.includes("SWE_BENCH_TEST_ENV_DEPENDENCY_INCOMPATIBLE"), true);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_TEST_ENV_DEPENDENCY_INCOMPATIBLE"), true);
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

  it("warns when official harness reports unresolved SWE-bench instances", async () => {
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

    assert.equal(summary.status, "warn");
    assert.equal(summary.evaluation?.batch.totalInstances, 2);
    assert.equal(summary.evaluation?.batch.resolvedInstances, 1);
    assert.deepEqual(summary.evaluation?.batch.unresolvedInstanceIds, ["demo__repo-2"]);
    assert.equal(summary.evaluation?.batch.resolvedRate, 0.5);
    assert.equal(summary.evaluation?.instances.length, 2);
    assert.equal(summary.evaluation?.instances[1]?.resolved, false);
    assert.equal(summary.evaluation?.instances[1]?.tests.failToPass.failure, 1);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_EVALUATION_UNRESOLVED"), true);
  });

  it("extracts bounded official harness failure excerpts from test output", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    platform.harnessTestOutputByInstanceId.set("demo__repo-2", [
      "tests/test_demo.py::test_fixed FAILED",
      "",
      "=================================== FAILURES ===================================",
      "_______________________________ test_fixed __________________________________",
      "",
      "tests/test_demo.py:42: in test_fixed",
      "    parse_value('no')",
      "src/demo/parser.py:88: in parse_value",
      "    return float(value)",
      "E   ValueError: could not convert string to float: 'no'",
      "",
      "short test summary info",
      "FAILED tests/test_demo.py::test_fixed - ValueError: could not convert string to float: 'no'",
      ""
    ].join("\n"));
    await platform.writeFile("/workspace/predictions/glm.jsonl", [
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
      runId: "glm-unresolved",
      instanceIds: ["demo__repo-2"],
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    const instance = summary.evaluation?.instances[0];
    const excerpt = instance?.failureExcerpts?.[0] as JsonObject | undefined;
    const text = typeof excerpt?.excerpt === "string" ? excerpt.excerpt : "";

    assert.equal(summary.status, "warn");
    assert.equal(excerpt?.testId, "tests/test_demo.py::test_fixed");
    assert.equal(text.includes("tests/test_demo.py:42: in test_fixed"), true);
    assert.equal(text.includes("ValueError: could not convert string to float: 'no'"), true);
    assert.equal(text.length < 2_000, true);
  });

  it("preserves official top-level harness error ids when per-instance report is absent", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    platform.harnessErrorIds = ["demo__repo-error"];
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-error",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");

    const summary = await collectSweBenchPrediction({
      action: "evaluate",
      dryRun: false,
      live: false,
      outputPath: "/workspace/predictions/glm.jsonl",
      reportDir: "/workspace/harness",
      runId: "glm-error-run",
      instanceIds: ["demo__repo-error"],
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    assert.equal(summary.status, "fail");
    assert.equal(summary.evaluation?.completed, false);
    assert.equal(summary.evaluation?.resolved, false);
    assert.equal(summary.evaluation?.batch.totalInstances, 1);
    assert.equal(summary.evaluation?.batch.resolvedInstances, 0);
    assert.deepEqual(summary.evaluation?.batch.unresolvedInstanceIds, []);
    assert.deepEqual(summary.evaluation?.batch.errorInstanceIds, ["demo__repo-error"]);
    assert.equal(summary.evaluation?.instances[0]?.completed, false);
    assert.equal(summary.evaluation?.instances[0]?.errorKind, "harness-error");
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_HARNESS_INSTANCE_ERROR"), true);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_REPORT_STAT_FAILED" || entry.code === "SWE_BENCH_REPORT_READ_FAILED"), false);
  });

  it("diagnoses missing Docker images from harness error instance logs", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    platform.harnessErrorIds = ["demo__repo-error"];
    platform.harnessErrorLogByInstanceId.set(
      "demo__repo-error",
      "Error response from daemon: No such image: swebench/sweb.eval.x86_64.demo_repo-error:latest\n"
    );
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-error",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");

    const summary = await collectSweBenchPrediction({
      action: "evaluate",
      dryRun: false,
      live: false,
      outputPath: "/workspace/predictions/glm.jsonl",
      reportDir: "/workspace/harness",
      runId: "glm-error-run",
      instanceIds: ["demo__repo-error"],
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    const dockerDiagnostic = summary.diagnostics.find((entry) => entry.code === "SWE_BENCH_DOCKER_IMAGE_NOT_FOUND");

    assert.equal(summary.status, "fail");
    assert.ok(dockerDiagnostic);
    assert.equal(dockerDiagnostic.severity, "error");
    assert.equal((dockerDiagnostic.metadata as JsonObject | undefined)?.instanceId, "demo__repo-error");
    assert.equal(JSON.stringify(dockerDiagnostic).includes("swebench/sweb.eval.x86_64.demo_repo-error:latest"), true);
  });

  it("retries harness evaluation with local image build when the remote instance image is missing", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    platform.harnessErrorIds = ["demo__repo-error"];
    platform.fallbackLocalBuildOnDockerImageMiss = true;
    platform.harnessErrorLogByInstanceId.set(
      "demo__repo-error",
      "docker.errors.ImageNotFound: 404 Client Error: Not Found (\"No such image: swebench/sweb.eval.x86_64.demo_repo-error:latest\")\n"
    );
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-error",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");

    const summary = await collectSweBenchPrediction({
      action: "evaluate",
      dryRun: false,
      live: false,
      outputPath: "/workspace/predictions/glm.jsonl",
      reportDir: "/workspace/harness",
      runId: "glm-error-run",
      instanceIds: ["demo__repo-error"],
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    const harnessRuns = platform.executedCommands.filter((entry) => entry.args.includes("swebench.harness.run_evaluation"));
    const fallback = harnessRuns[1];

    assert.equal(summary.status, "pass");
    assert.equal(summary.evaluation?.resolved, true);
    assert.equal(harnessRuns.length, 2);
    assert.equal(argAfter(fallback?.args ?? [], "--namespace"), "none");
    assert.equal(argAfter(fallback?.args ?? [], "--force_rebuild"), "true");
    assert.equal(argAfter(fallback?.args ?? [], "--run_id"), "glm-error-run-local-build");
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_DOCKER_IMAGE_NOT_FOUND"), true);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_HARNESS_LOCAL_BUILD_RETRY"), true);
  });

  it("fails evaluation when the only harness report is stale from a previous run", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    platform.skipHarnessReportWrite = true;
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/harness/logs/run_evaluation/glm-run/glm-5.1/demo__repo-1/report.json", JSON.stringify({
      "demo__repo-1": {
        resolved: true,
        tests_status: {
          FAIL_TO_PASS: { success: ["tests/test_demo.py::test_old"], failure: [] },
          PASS_TO_PASS: { success: ["tests/test_demo.py::test_old_existing"], failure: [] }
        }
      }
    }));

    const summary = await collectSweBenchPrediction({
      action: "evaluate",
      dryRun: false,
      live: false,
      outputPath: "/workspace/predictions/glm.jsonl",
      reportDir: "/workspace/harness",
      runId: "glm-run",
      instanceIds: ["demo__repo-1"],
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    assert.equal(summary.status, "fail");
    assert.equal(summary.evaluation, undefined);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_REPORT_STALE"), true);
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
        kind: "context.projection.completed",
        data: {
          cache: { namespace: "context.projection", key: "context.projection:hit", hit: true }
        }
      }),
      JSON.stringify({
        kind: "context.projection.completed",
        data: {
          cache: { namespace: "context.projection", key: "context.projection:miss", hit: false }
        }
      }),
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
    assert.equal(summary.evaluation?.cache?.provider.hitRate, 900 / 1100);
    assert.equal(summary.evaluation?.cache?.provider.requestCount, 2);
    assert.equal(summary.evaluation?.cache?.contextProjection.requestCount, 2);
    assert.equal(summary.evaluation?.cache?.contextProjection.hitCount, 1);
    assert.equal(summary.evaluation?.cache?.contextProjection.missCount, 1);
    assert.equal(summary.evaluation?.cache?.contextProjection.hitRate, 0.5);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_CACHE_HIT_TARGET_MISSED"), true);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET"), true);
  });

  it("preserves cache gate evidence when the official harness skips an empty patch", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: ""
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-empty-patch.jsonl", [
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 100,
          metadata: {
            cache: { hitTokens: 900, missTokens: 100, hitRate: 0.9 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 20,
          metadata: {
            cache: { hitTokens: 980, missTokens: 20, hitRate: 0.98 }
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
      runId: "glm-empty-patch",
      instanceIds: ["demo__repo-1"],
      cacheTracePath: "/workspace/traces/glm-empty-patch.jsonl",
      cacheHitTarget: 0.9,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    assert.equal(summary.status, "fail");
    assert.equal(summary.evaluation?.completed, false);
    assert.equal(summary.evaluation?.resolved, false);
    assert.equal(summary.evaluation?.instances[0]?.errorKind, "empty-patch");
    assert.equal(summary.evaluation?.cache?.passed, true);
    assert.equal(summary.evaluation?.cache?.provider.hitRate, 1880 / 2000);
    assert.equal(summary.evaluation?.cache?.provider.requestCount, 2);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_HARNESS_EMPTY_PATCH"), true);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_REPORT_STAT_FAILED" || entry.code === "SWE_BENCH_REPORT_READ_FAILED"), false);
  });

  it("classifies low provider cache hits from a stable prompt with growing history tail", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:assembled",
              providerPrefixFingerprint: "provider-prefix:assembled",
              providerPrefixMessageCount: 2,
              providerPrefixTokenEstimate: 512
            }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:assembled",
              providerPrefixFingerprint: "provider-prefix:assembled",
              providerPrefixMessageCount: 2,
              providerPrefixTokenEstimate: 512
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          providerRequestReplay: {
            selectedHistoryMessageCount: 13,
            toolCallLinkage: { assistantToolCallCount: 0, toolResultCount: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 100,
          metadata: {
            cache: { hitTokens: 900, missTokens: 100, hitRate: 0.9 }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:assembled",
              providerPrefixFingerprint: "provider-prefix:assembled",
              providerPrefixMessageCount: 2,
              providerPrefixTokenEstimate: 512
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            selectedHistoryMessageCount: 31,
            toolCallLinkage: { assistantToolCallCount: 9, toolResultCount: 9 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 700,
          metadata: {
            cache: { hitTokens: 300, missTokens: 700, hitRate: 0.3 }
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
      cacheHitTarget: 0.8,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    const historyTailDiagnostic = summary.diagnostics.find((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_HISTORY_TAIL_MISS");
    const historyTailMetadata = historyTailDiagnostic?.metadata as JsonObject | undefined;

    assert.equal(summary.evaluation?.cache?.provider.lowHitHistoryTailCount, 1);
    assert.equal(summary.evaluation?.cache?.provider.maxSelectedHistoryMessageCount, 31);
    assert.equal(summary.evaluation?.cache?.provider.maxAssistantToolCallCount, 9);
    assert.equal(summary.evaluation?.cache?.provider.maxToolResultCount, 9);
    assert.equal(summary.evaluation?.cache?.provider.lowHitHistoryTailMaxSelectedHistoryMessageCount, 31);
    assert.equal(summary.evaluation?.cache?.provider.lowHitColdStartCount, 0);
    assert.equal(summary.evaluation?.cache?.promptAssembly.stableReplayFingerprint, true);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_HISTORY_TAIL_MISS"), true);
    assert.equal(historyTailMetadata?.lowHitHistoryTailMaxSelectedHistoryMessageCount, 31);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "PROMPT_CACHE_PREFIX_BUSTED"), false);
  });

  it("does not report whole-prompt churn when a stable-prefix miss is explained by history tail", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:first",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:assembled",
              providerPrefixFingerprint: "provider-prefix:assembled",
              providerPrefixMessageCount: 2,
              providerPrefixTokenEstimate: 512
            }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:second",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:assembled",
              providerPrefixFingerprint: "provider-prefix:assembled",
              providerPrefixMessageCount: 2,
              providerPrefixTokenEstimate: 512
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            selectedHistoryMessageCount: 31,
            toolCallLinkage: { assistantToolCallCount: 9, toolResultCount: 9 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 900,
          metadata: {
            cache: { hitTokens: 100, missTokens: 900, hitRate: 0.1 }
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
      cacheHitTarget: 0.8,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    assert.equal(summary.evaluation?.cache?.promptAssembly.wholePromptFingerprintDynamicWithStablePrefix, true);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_HISTORY_TAIL_MISS"), true);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "PROMPT_WHOLE_FINGERPRINT_DYNAMIC_WITH_STABLE_PREFIX"), false);
  });

  it("classifies repeated zero-hit provider requests on the same pipeline as cache breakpoint shape misses", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:first",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:assembled",
              providerPrefixFingerprint: "provider-prefix:assembled",
              providerPrefixMessageCount: 2,
              providerPrefixTokenEstimate: 512
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            selectedHistoryMessageCount: 14,
            historyMessageCount: 0,
            toolCallLinkage: { assistantToolCallCount: 0, toolResultCount: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 900,
          metadata: {
            cache: {
              hitTokens: 0,
              missTokens: 900,
              hitRate: 0,
              pipelineFingerprint: "pipeline:test",
              explicitPrefixCacheHint: {
                status: "sent",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
                redaction: { class: "internal" }
              },
              breakpointShape: {
                systemCacheControlCount: 1,
                messageCacheControlCount: 1,
                toolCacheControlCount: 1,
                totalCacheControlCount: 3,
                messageCacheControlPositions: ["last-message"]
              }
            }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:second",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            selectedHistoryMessageCount: 15,
            historyMessageCount: 1,
            toolCallLinkage: { assistantToolCallCount: 0, toolResultCount: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 900,
          metadata: {
            cache: {
              hitTokens: 0,
              missTokens: 900,
              hitRate: 0,
              pipelineFingerprint: "pipeline:test",
              explicitPrefixCacheHint: {
                status: "sent",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
                redaction: { class: "internal" }
              },
              breakpointShape: {
                systemCacheControlCount: 1,
                messageCacheControlCount: 1,
                toolCacheControlCount: 1,
                totalCacheControlCount: 3,
                messageCacheControlPositions: ["first-message"]
              }
            }
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
      cacheHitTarget: 0.8,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    const providerCacheDiagnostic = summary.diagnostics.find((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET");
    const breakpointDiagnostic = summary.diagnostics.find((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_MISS");

    assert.equal(summary.evaluation?.cache?.provider.lowHitColdStartCount, 1);
    assert.equal(summary.evaluation?.cache?.provider.lowHitRepeatedZeroHitWithPipelineCount, 1);
    assert.equal(summary.evaluation?.cache?.provider.requestWithBreakpointShapeCount, 2);
    assert.equal(summary.evaluation?.cache?.provider.lowHitFirstMessageCacheControlCount, 1);
    assert.equal(summary.evaluation?.cache?.provider.lowHitLastMessageCacheControlCount, 1);
    assert.equal(providerCacheDiagnostic?.metadata && (providerCacheDiagnostic.metadata as JsonObject).lowHitRepeatedZeroHitWithPipelineCount, 1);
    assert.equal(Boolean(breakpointDiagnostic), true);
    assert.equal(breakpointDiagnostic?.metadata && (breakpointDiagnostic.metadata as JsonObject).lowHitRepeatedZeroHitWithPipelineCount, 1);
    assert.equal(breakpointDiagnostic?.metadata && (breakpointDiagnostic.metadata as JsonObject).requestWithBreakpointShapeCount, 2);
    assert.equal(breakpointDiagnostic?.metadata && (breakpointDiagnostic.metadata as JsonObject).lowHitFirstMessageCacheControlCount, 1);
    assert.equal(breakpointDiagnostic?.metadata && (breakpointDiagnostic.metadata as JsonObject).lowHitLastMessageCacheControlCount, 1);
  });

  it("classifies low provider cache hits with multiple message cache breakpoints", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:first",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:test",
              providerPrefixFingerprint: "provider-prefix:stable",
              providerPrefixMessageCount: 13,
              providerPrefixTokenEstimate: 2265
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            visibleToolCount: 73,
            selectedHistoryMessageCount: 18,
            historyMessageCount: 6,
            toolCallLinkage: { assistantToolCallCount: 2, toolResultCount: 2 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 9000,
          metadata: {
            cache: {
              hitTokens: 500,
              missTokens: 9000,
              hitRate: 0.05263157894736842,
              pipelineFingerprint: "pipeline:test",
              explicitPrefixCacheHint: {
                status: "sent",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
                redaction: { class: "internal" }
              },
              breakpointShape: {
                systemCacheControlCount: 1,
                messageCacheControlCount: 2,
                toolCacheControlCount: 1,
                totalCacheControlCount: 4,
                redaction: { class: "internal" }
              }
            }
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

    const diagnostic = summary.diagnostics.find((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_MULTI_MESSAGE_BREAKPOINT");
    const metadata = diagnostic?.metadata as JsonObject | undefined;

    assert.equal(summary.evaluation?.cache?.provider.lowHitMultiMessageCacheControlCount, 1);
    assert.equal(summary.evaluation?.cache?.provider.maxMessageCacheControlCount, 2);
    assert.equal(Boolean(diagnostic), true);
    assert.equal(metadata?.lowHitMultiMessageCacheControlCount, 1);
    assert.equal(metadata?.maxMessageCacheControlCount, 2);
    assert.equal(metadata?.maxSystemCacheControlCount, 1);
    assert.equal(metadata?.maxToolCacheControlCount, 1);
    assert.equal(metadata?.maxTotalCacheControlCount, 4);
  });

  it("flags missing provider cache breakpoint-shape telemetry on low cache hits", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:first",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:test",
              providerPrefixFingerprint: "provider-prefix:stable",
              providerPrefixMessageCount: 13,
              providerPrefixTokenEstimate: 2265
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            visibleToolCount: 73,
            selectedHistoryMessageCount: 18,
            historyMessageCount: 6,
            toolCallLinkage: { assistantToolCallCount: 2, toolResultCount: 2 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 9000,
          metadata: {
            cache: {
              hitTokens: 500,
              missTokens: 9000,
              hitRate: 0.05263157894736842,
              pipelineFingerprint: "pipeline:test",
              explicitPrefixCacheHint: {
                status: "sent",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
                redaction: { class: "internal" }
              }
            }
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

    const diagnostic = summary.diagnostics.find((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_TELEMETRY_MISSING");
    const metadata = diagnostic?.metadata as JsonObject | undefined;

    assert.equal(summary.evaluation?.cache?.provider.lowHitBreakpointShapeTelemetryMissingCount, 1);
    assert.equal(summary.evaluation?.cache?.provider.requestWithBreakpointShapeCount, 0);
    assert.equal(Boolean(diagnostic), true);
    assert.equal(metadata?.lowHitBreakpointShapeTelemetryMissingCount, 1);
    assert.equal(metadata?.requestWithBreakpointShapeCount, 0);
    assert.equal(metadata?.lowHitRequestCount, 1);
  });

  it("does not infer provider breakpoint-shape misses when breakpoint-shape telemetry is missing", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:first",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:test",
              providerPrefixFingerprint: "provider-prefix:stable",
              providerPrefixMessageCount: 13,
              providerPrefixTokenEstimate: 2265
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            visibleToolCount: 73,
            selectedHistoryMessageCount: 16,
            historyMessageCount: 2,
            toolCallLinkage: { assistantToolCallCount: 1, toolResultCount: 1 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 9000,
          metadata: {
            cache: {
              hitTokens: 0,
              missTokens: 9000,
              hitRate: 0,
              pipelineFingerprint: "pipeline:test",
              explicitPrefixCacheHint: {
                status: "sent",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
                redaction: { class: "internal" }
              }
            }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:second",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:test",
              providerPrefixFingerprint: "provider-prefix:stable",
              providerPrefixMessageCount: 13,
              providerPrefixTokenEstimate: 2265
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            visibleToolCount: 73,
            selectedHistoryMessageCount: 16,
            historyMessageCount: 2,
            toolCallLinkage: { assistantToolCallCount: 1, toolResultCount: 1 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 9000,
          metadata: {
            cache: {
              hitTokens: 0,
              missTokens: 9000,
              hitRate: 0,
              pipelineFingerprint: "pipeline:test",
              explicitPrefixCacheHint: {
                status: "sent",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
                redaction: { class: "internal" }
              }
            }
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

    assert.equal(summary.evaluation?.cache?.provider.lowHitRepeatedZeroHitWithPipelineCount, 1);
    assert.equal(summary.evaluation?.cache?.provider.requestWithBreakpointShapeCount, 0);
    assert.equal(summary.evaluation?.cache?.provider.lowHitBreakpointShapeTelemetryMissingCount, 2);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_TELEMETRY_MISSING"), true);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_MISS"), false);
  });

  it("does not blame provider-prefix coverage when intermittent zero hits have effective stable-hit evidence", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      cacheTracePrompt("whole:first"),
      cacheTraceProviderRequest(),
      cacheTraceUsage({ hitTokens: 0, missTokens: 9650 }),
      cacheTracePrompt("whole:second"),
      cacheTraceProviderRequest(),
      cacheTraceUsage({ hitTokens: 9600, missTokens: 384 }),
      cacheTracePrompt("whole:third"),
      cacheTraceProviderRequest(),
      cacheTraceUsage({ hitTokens: 0, missTokens: 9697 }),
      cacheTracePrompt("whole:fourth"),
      cacheTraceProviderRequest(),
      cacheTraceUsage({ hitTokens: 9600, missTokens: 97 }),
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

    const provider = summary.evaluation?.cache?.provider;

    assert.equal(provider?.lowHitRepeatedZeroHitWithPipelineCount, 1);
    assert.equal(provider?.lowHitBreakpointShapeTelemetryMissingCount, 2);
    assert.equal(provider?.effectiveStableCacheHitTokens, 9600);
    assert.equal(provider?.lowHitProviderPrefixCoverageLowCount, 0);
    assert.equal(provider?.lowHitToolSchemaCacheGapCount, 0);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_TELEMETRY_MISSING"), true);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_COVERAGE_LOW"), false);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_TOOL_SCHEMA_CACHE_GAP"), false);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "PROMPT_WHOLE_FINGERPRINT_DYNAMIC_WITH_STABLE_PREFIX"), false);
  });

  it("surfaces provider-prefix drift when stable replay fingerprints hide dynamic prefix text", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:first",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:first",
              providerPrefixFingerprint: "provider-prefix:first",
              providerPrefixMessageCount: 12,
              providerPrefixTokenEstimate: 2200
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:first" },
          providerRequestReplay: {
            selectedHistoryMessageCount: 14,
            historyMessageCount: 0,
            toolCallLinkage: { assistantToolCallCount: 0, toolResultCount: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 900,
          metadata: {
            cache: {
              hitTokens: 0,
              missTokens: 900,
              hitRate: 0,
              pipelineFingerprint: "pipeline:first",
              explicitPrefixCacheHint: {
                status: "sent",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
                redaction: { class: "internal" }
              }
            }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:second",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:second",
              providerPrefixFingerprint: "provider-prefix:second",
              providerPrefixMessageCount: 12,
              providerPrefixTokenEstimate: 2200
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:second" },
          providerRequestReplay: {
            selectedHistoryMessageCount: 15,
            historyMessageCount: 1,
            toolCallLinkage: { assistantToolCallCount: 0, toolResultCount: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 900,
          metadata: {
            cache: {
              hitTokens: 0,
              missTokens: 900,
              hitRate: 0,
              pipelineFingerprint: "pipeline:second",
              explicitPrefixCacheHint: {
                status: "sent",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
                redaction: { class: "internal" }
              }
            }
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
      cacheHitTarget: 0.8,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    const driftDiagnostic = summary.diagnostics.find((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_DRIFT");
    const metadata = driftDiagnostic?.metadata as JsonObject | undefined;

    assert.equal(summary.evaluation?.cache?.promptAssembly.stableReplayFingerprint, true);
    assert.equal(summary.evaluation?.cache?.promptAssembly.stableProviderPrefixFingerprint, false);
    assert.equal(summary.evaluation?.cache?.promptAssembly.uniqueProviderPrefixFingerprintCount, 2);
    assert.equal(Boolean(driftDiagnostic), true);
    assert.equal(metadata?.uniqueProviderPrefixFingerprintCount, 2);
  });

  it("classifies stable visible tool schemas as a provider cache gap when low hits persist", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:first",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              providerPrefixFingerprint: "provider-prefix:stable",
              providerPrefixMessageCount: 13,
              providerPrefixTokenEstimate: 3200
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            visibleToolSchemaCount: 73,
            selectedHistoryMessageCount: 14,
            historyMessageCount: 0,
            toolCallLinkage: { assistantToolCallCount: 0, toolResultCount: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 900,
          metadata: {
            cache: {
              hitTokens: 0,
              missTokens: 900,
              hitRate: 0,
              pipelineFingerprint: "pipeline:test",
              explicitPrefixCacheHint: {
                status: "sent",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
                redaction: { class: "internal" }
              }
            }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:second",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              providerPrefixFingerprint: "provider-prefix:stable",
              providerPrefixMessageCount: 13,
              providerPrefixTokenEstimate: 3200
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            visibleToolSchemaCount: 73,
            selectedHistoryMessageCount: 15,
            historyMessageCount: 1,
            toolCallLinkage: { assistantToolCallCount: 0, toolResultCount: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 900,
          metadata: {
            cache: {
              hitTokens: 0,
              missTokens: 900,
              hitRate: 0,
              pipelineFingerprint: "pipeline:test",
              explicitPrefixCacheHint: {
                status: "sent",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
                redaction: { class: "internal" }
              }
            }
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
      cacheHitTarget: 0.8,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    const toolSchemaDiagnostic = summary.diagnostics.find((entry) => entry.code === "SWE_BENCH_PROVIDER_TOOL_SCHEMA_CACHE_GAP");
    const toolSchemaMetadata = toolSchemaDiagnostic?.metadata as JsonObject | undefined;

    assert.equal(summary.evaluation?.cache?.provider.lowHitToolSchemaCacheGapCount, 2);
    assert.equal(Boolean(toolSchemaDiagnostic), true);
    assert.equal(toolSchemaMetadata?.lowHitToolSchemaCacheGapCount, 2);
    assert.equal(toolSchemaMetadata?.uniqueToolPlanFingerprintCount, 1);
  });

  it("surfaces small provider-prefix evidence when low cache hits persist despite sent hints", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:first",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:test",
              providerPrefixFingerprint: "provider-prefix:tiny",
              providerPrefixMessageCount: 1,
              providerPrefixTokenEstimate: 49
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            selectedHistoryMessageCount: 14,
            historyMessageCount: 0,
            toolCallLinkage: { assistantToolCallCount: 0, toolResultCount: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 900,
          metadata: {
            cache: {
              hitTokens: 0,
              missTokens: 900,
              hitRate: 0,
              pipelineFingerprint: "pipeline:test",
              explicitPrefixCacheHint: {
                status: "sent",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
                redaction: { class: "internal" }
              }
            }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:second",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:test",
              providerPrefixFingerprint: "provider-prefix:tiny",
              providerPrefixMessageCount: 1,
              providerPrefixTokenEstimate: 49
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            selectedHistoryMessageCount: 15,
            historyMessageCount: 1,
            toolCallLinkage: { assistantToolCallCount: 0, toolResultCount: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 900,
          metadata: {
            cache: {
              hitTokens: 0,
              missTokens: 900,
              hitRate: 0,
              pipelineFingerprint: "pipeline:test",
              explicitPrefixCacheHint: {
                status: "sent",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
                redaction: { class: "internal" }
              }
            }
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
      cacheHitTarget: 0.8,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    const prefixDiagnostic = summary.diagnostics.find((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_TOO_SMALL");
    const metadata = prefixDiagnostic?.metadata as JsonObject | undefined;

    assert.equal(summary.evaluation?.cache?.promptAssembly.providerPrefixEventCount, 2);
    assert.equal(summary.evaluation?.cache?.promptAssembly.minProviderPrefixTokenEstimate, 49);
    assert.equal(summary.evaluation?.cache?.promptAssembly.maxProviderPrefixMessageCount, 1);
    assert.equal(summary.evaluation?.cache?.provider.lowHitProviderPrefixTooSmallCount, 2);
    assert.equal(Boolean(prefixDiagnostic), true);
    assert.equal(metadata?.maxProviderPrefixTokenEstimate, 49);
    assert.equal(metadata?.lowHitProviderPrefixTooSmallCount, 2);
  });

  it("surfaces stable provider-prefix coverage gaps when measured hits do not cover the estimated prefix", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:first",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:test",
              providerPrefixFingerprint: "provider-prefix:stable",
              providerPrefixMessageCount: 13,
              providerPrefixTokenEstimate: 2465
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            visibleToolCount: 73,
            selectedHistoryMessageCount: 22,
            historyMessageCount: 8,
            toolCallLinkage: { assistantToolCallCount: 4, toolResultCount: 4 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 9366,
          metadata: {
            cache: {
              hitTokens: 1200,
              missTokens: 9366,
              hitRate: 0.11357183418417566,
              pipelineFingerprint: "pipeline:test",
              explicitPrefixCacheHint: {
                status: "sent",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
                redaction: { class: "internal" }
              }
            }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:second",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:test",
              providerPrefixFingerprint: "provider-prefix:stable",
              providerPrefixMessageCount: 13,
              providerPrefixTokenEstimate: 2465
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            visibleToolCount: 73,
            selectedHistoryMessageCount: 22,
            historyMessageCount: 10,
            toolCallLinkage: { assistantToolCallCount: 5, toolResultCount: 5 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 12536,
          metadata: {
            cache: {
              hitTokens: 1600,
              missTokens: 12536,
              hitRate: 0.11318619128466327,
              pipelineFingerprint: "pipeline:test",
              explicitPrefixCacheHint: {
                status: "sent",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
                redaction: { class: "internal" }
              }
            }
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

    const diagnostic = summary.diagnostics.find((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_COVERAGE_LOW");
    const metadata = diagnostic?.metadata as JsonObject | undefined;

    assert.equal(summary.evaluation?.cache?.provider.lowHitProviderPrefixCoverageLowCount, 2);
    assert.equal(summary.evaluation?.cache?.provider.lowHitDynamicTailMissCount, 0);
    assert.equal(Boolean(diagnostic), true);
    assert.equal(metadata?.minProviderPrefixCoverageRatio, 2465 / (1600 + 12536));
    assert.equal(metadata?.maxProviderPrefixCoverageRatio, 2465 / (1200 + 9366));
  });

  it("classifies low total cache hit rate as dynamic tail miss when effective provider hits exceed the prompt prefix estimate", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:first",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:test",
              providerPrefixFingerprint: "provider-prefix:stable",
              providerPrefixMessageCount: 13,
              providerPrefixTokenEstimate: 2265
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            visibleToolCount: 73,
            selectedHistoryMessageCount: 22,
            historyMessageCount: 8,
            toolCallLinkage: { assistantToolCallCount: 4, toolResultCount: 4 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 18400,
          metadata: {
            cache: {
              hitTokens: 9600,
              missTokens: 13000,
              hitRate: 0.4247787610619469,
              pipelineFingerprint: "pipeline:test",
              explicitPrefixCacheHint: {
                status: "sent",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
                redaction: { class: "internal" }
              }
            }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:zero-hit",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:test",
              providerPrefixFingerprint: "provider-prefix:stable",
              providerPrefixMessageCount: 13,
              providerPrefixTokenEstimate: 2265
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            visibleToolCount: 73,
            selectedHistoryMessageCount: 22,
            historyMessageCount: 9,
            toolCallLinkage: { assistantToolCallCount: 4, toolResultCount: 4 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 22600,
          metadata: {
            cache: {
              hitTokens: 0,
              missTokens: 22600,
              hitRate: 0,
              pipelineFingerprint: "pipeline:test",
              explicitPrefixCacheHint: {
                status: "sent",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
                redaction: { class: "internal" }
              }
            }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:second",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:test",
              providerPrefixFingerprint: "provider-prefix:stable",
              providerPrefixMessageCount: 13,
              providerPrefixTokenEstimate: 2265
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            visibleToolCount: 73,
            selectedHistoryMessageCount: 22,
            historyMessageCount: 10,
            toolCallLinkage: { assistantToolCallCount: 4, toolResultCount: 4 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 20400,
          metadata: {
            cache: {
              hitTokens: 9700,
              missTokens: 15000,
              hitRate: 0.39271255060728744,
              pipelineFingerprint: "pipeline:test",
              explicitPrefixCacheHint: {
                status: "sent",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
                redaction: { class: "internal" }
              }
            }
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

    const dynamicTailDiagnostic = summary.diagnostics.find((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_DYNAMIC_TAIL_MISS");
    const prefixCoverageDiagnostic = summary.diagnostics.find((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_COVERAGE_LOW");
    const metadata = dynamicTailDiagnostic?.metadata as JsonObject | undefined;

    assert.equal(summary.evaluation?.cache?.provider.lowHitDynamicTailMissCount, 2);
    assert.equal(summary.evaluation?.cache?.provider.effectiveStableCacheHitTokens, 9700);
    assert.equal(summary.evaluation?.cache?.provider.maxPositiveHitTokens, 9700);
    assert.equal(summary.evaluation?.cache?.provider.lowHitRepeatedZeroHitWithPipelineCount, 1);
    assert.equal(summary.evaluation?.cache?.provider.lowHitProviderPrefixCoverageLowCount, 0);
    assert.equal(summary.evaluation?.cache?.provider.lowHitToolSchemaCacheGapCount, 0);
    assert.equal(Boolean(dynamicTailDiagnostic), true);
    assert.equal(Boolean(prefixCoverageDiagnostic), false);
    assert.equal(metadata?.lowHitDynamicTailMissCount, 2);
    assert.equal(metadata?.effectiveStableCacheHitTokens, 9700);
    assert.equal(metadata?.maxProviderPrefixTokenEstimate, 2265);
    assert.equal(metadata?.lowHitDynamicTailMissTokens, 28000);
  });

  it("classifies unbounded provider history after a framework gate", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            selectedHistoryMessageCount: 31,
            historyMessageCount: 0,
            messageRoleSequence: [
              "user",
              "assistant", "tool",
              "assistant", "tool",
              "assistant", "tool",
              "assistant", "tool",
              "assistant", "tool",
              "assistant", "tool",
              "assistant", "tool",
              "assistant", "tool",
              "assistant", "tool",
              "user"
            ],
            toolCallLinkage: { assistantToolCallCount: 9, toolResultCount: 9 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 700,
          metadata: {
            cache: { hitTokens: 300, missTokens: 700, hitRate: 0.3, pipelineFingerprint: "pipeline:test" }
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
      cacheHitTarget: 0.8,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    const diagnostic = summary.diagnostics.find((entry) => entry.code === "SWE_BENCH_PROVIDER_HISTORY_UNBOUNDED_AFTER_GATE");
    const metadata = diagnostic?.metadata as JsonObject | undefined;

    assert.equal(summary.evaluation?.cache?.provider.lowHitUnboundedAfterGateCount, 1);
    assert.equal(Boolean(diagnostic), true);
    assert.equal(metadata?.lowHitUnboundedAfterGateCount, 1);
    assert.equal(metadata?.lowHitUnboundedAfterGateMaxSelectedHistoryMessageCount, 31);
    assert.equal(metadata?.lowHitUnboundedAfterGateMaxAssistantToolCallCount, 9);
  });

  it("flags missing provider prefix hints when stable SWE-bench prompts have low cache hits", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            selectedHistoryMessageCount: 31,
            toolCallLinkage: { assistantToolCallCount: 9, toolResultCount: 9 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 700,
          metadata: {
            cache: { hitTokens: 300, missTokens: 700, hitRate: 0.3 }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            selectedHistoryMessageCount: 33,
            toolCallLinkage: { assistantToolCallCount: 10, toolResultCount: 10 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 50,
          metadata: {
            cache: { hitTokens: 950, missTokens: 50, hitRate: 0.95, pipelineFingerprint: "pipeline:test" }
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
      cacheHitTarget: 0.8,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    assert.equal(summary.evaluation?.cache?.provider.lowHitPrefixHintMissingCount, 1);
    assert.equal(summary.evaluation?.cache?.provider.requestWithPipelineCount, 2);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_HINT_MISSING"), true);
  });

  it("distinguishes missing context pipeline metadata from missing provider prefix hints", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:assembled",
              providerPrefixFingerprint: "provider-prefix:assembled",
              providerPrefixMessageCount: 2,
              providerPrefixTokenEstimate: 512
            }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:assembled",
              providerPrefixFingerprint: "provider-prefix:assembled",
              providerPrefixMessageCount: 2,
              providerPrefixTokenEstimate: 512
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          providerRequestReplay: {
            selectedHistoryMessageCount: 31,
            toolCallLinkage: { assistantToolCallCount: 9, toolResultCount: 9 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 700,
          metadata: {
            cache: { hitTokens: 300, missTokens: 700, hitRate: 0.3 }
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
      cacheHitTarget: 0.8,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    assert.equal(summary.evaluation?.cache?.provider.lowHitPipelineMissingCount, 1);
    assert.equal(summary.evaluation?.cache?.provider.lowHitPrefixHintMissingCount, 0);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_PIPELINE_MISSING"), true);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_HINT_MISSING"), false);
  });

  it("classifies legacy cache traces without pipeline telemetry separately from current provider pipeline failures", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:legacy",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:legacy-next",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          providerRequestReplay: {
            selectedHistoryMessageCount: 17,
            historyMessageCount: 17,
            toolCallLinkage: { assistantToolCallCount: 2, toolResultCount: 2 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 1000,
          metadata: {
            cache: { hitTokens: 300, missTokens: 700, hitRate: 0.3 }
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

    assert.equal(summary.evaluation?.cache?.provider.requestWithPipelineCount, 0);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_PIPELINE_TELEMETRY_ABSENT"), true);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_PIPELINE_MISSING"), false);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_HISTORY_TAIL_MISS"), false);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_HISTORY_UNBOUNDED_AFTER_GATE"), false);
  });

  it("flags unsupported provider prefix hints separately from missing hints", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:test" },
          providerRequestReplay: {
            selectedHistoryMessageCount: 31,
            toolCallLinkage: { assistantToolCallCount: 9, toolResultCount: 9 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 700,
          metadata: {
            cache: {
              hitTokens: 300,
              missTokens: 700,
              hitRate: 0.3,
              pipelineFingerprint: "pipeline:test",
              explicitPrefixCacheHint: {
                status: "unsupported",
                reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_UNSUPPORTED",
                redaction: { class: "internal" }
              }
            }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            }
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
      cacheHitTarget: 0.8,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    assert.equal(summary.evaluation?.cache?.provider.lowHitPrefixHintUnsupportedCount, 1);
    assert.equal(summary.evaluation?.cache?.provider.lowHitPrefixHintMissingCount, 0);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_HINT_UNSUPPORTED"), true);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_HINT_MISSING"), false);
  });

  it("classifies low provider cache hits with prompt assembly fingerprint drift", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:first",
              budgetFingerprint: "budget:first",
              toolPlanFingerprint: "tools:stable"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          providerRequestReplay: {
            selectedHistoryMessageCount: 13,
            toolCallLinkage: { assistantToolCallCount: 0, toolResultCount: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 900,
          metadata: {
            cache: { hitTokens: 100, missTokens: 900, hitRate: 0.1 }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:second",
              budgetFingerprint: "budget:second",
              toolPlanFingerprint: "tools:stable"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 900,
          metadata: {
            cache: { hitTokens: 100, missTokens: 900, hitRate: 0.1 }
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
      cacheHitTarget: 0.8,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    const diagnostic = summary.diagnostics.find((entry) => entry.code === "PROMPT_CACHE_PREFIX_BUSTED");

    assert.equal(summary.evaluation?.cache?.promptAssembly.stableReplayFingerprint, false);
    assert.equal(summary.evaluation?.cache?.promptAssembly.uniqueSectionOrderFingerprintCount, 2);
    assert.equal(summary.evaluation?.cache?.promptAssembly.uniqueBudgetFingerprintCount, 2);
    assert.equal(diagnostic?.metadata && (diagnostic.metadata as JsonObject).uniqueSectionOrderFingerprintCount, 2);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_HISTORY_TAIL_MISS"), false);
  });

  it("separates whole-prompt fingerprint churn from stable cacheable prompt prefixes", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:first",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 900,
          metadata: {
            cache: { hitTokens: 100, missTokens: 900, hitRate: 0.1 }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:second",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 900,
          metadata: {
            cache: { hitTokens: 100, missTokens: 900, hitRate: 0.1 }
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
      cacheHitTarget: 0.8,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    const diagnostic = summary.diagnostics.find((entry) => entry.code === "PROMPT_WHOLE_FINGERPRINT_DYNAMIC_WITH_STABLE_PREFIX");

    assert.equal(summary.evaluation?.cache?.promptAssembly.stableReplayFingerprint, true);
    assert.equal(summary.evaluation?.cache?.promptAssembly.uniqueWholePromptFingerprintCount, 2);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "PROMPT_CACHE_PREFIX_BUSTED"), false);
    assert.equal(Boolean(diagnostic), true);
    assert.equal(diagnostic?.metadata && (diagnostic.metadata as JsonObject).uniqueWholePromptFingerprintCount, 2);
  });

  it("does not report dynamic workflow state as prompt cache prefix drift when provider prefix is stable", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:first",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:workflow-state-ready",
              budgetFingerprint: "budget:workflow-state-ready",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:stable-provider-prefix",
              providerPrefixFingerprint: "provider-prefix:stable-framework",
              providerPrefixMessageCount: 13,
              providerPrefixTokenEstimate: 2089
            }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 900,
          metadata: {
            cache: {
              hitTokens: 100,
              missTokens: 900,
              hitRate: 0.1,
              pipelineFingerprint: "pipeline:stable-provider-prefix",
              explicitPrefixCacheHint: { status: "sent" }
            }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:second",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:workflow-state-succeeded",
              budgetFingerprint: "budget:workflow-state-succeeded",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              pipelineFingerprint: "pipeline:stable-provider-prefix",
              providerPrefixFingerprint: "provider-prefix:stable-framework",
              providerPrefixMessageCount: 13,
              providerPrefixTokenEstimate: 2089
            }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 900,
          metadata: {
            cache: {
              hitTokens: 100,
              missTokens: 900,
              hitRate: 0.1,
              pipelineFingerprint: "pipeline:stable-provider-prefix",
              explicitPrefixCacheHint: { status: "sent" }
            }
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
      cacheHitTarget: 0.8,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    assert.equal(summary.evaluation?.cache?.promptAssembly.stableReplayFingerprint, false);
    assert.equal(summary.evaluation?.cache?.promptAssembly.stableProviderPrefixFingerprint, true);
    assert.equal(summary.evaluation?.cache?.provider.lowHitPromptAssemblyDriftCount, 0);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "PROMPT_CACHE_PREFIX_BUSTED"), false);
  });

  it("separates stable prompt assembly from context projection cache misses", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "context.projection.completed",
        data: {
          cache: {
            namespace: "context.projection",
            key: "context.projection:first",
            hit: false,
            dependencyFingerprints: ["workspace:hfirst"]
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "assembled-first",
          trace: {
            replay: {
              sectionOrderFingerprint: "stable-sections",
              budgetFingerprint: "stable-budget"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "assembled-second",
          trace: {
            replay: {
              sectionOrderFingerprint: "stable-sections",
              budgetFingerprint: "stable-budget"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "context.projection.completed",
        data: {
          cache: {
            namespace: "context.projection",
            key: "context.projection:second",
            hit: false,
            dependencyFingerprints: ["workspace:hsecond"]
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 0,
          metadata: {
            cache: { hitTokens: 950, missTokens: 50, hitRate: 0.95 }
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
      cacheHitTarget: 0.8,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    assert.equal(summary.evaluation?.cache?.passed, true);
    assert.equal(summary.evaluation?.cache?.provider.hitRate, 0.95);
    assert.equal(summary.evaluation?.cache?.contextProjection.hitRate, 0);
    assert.equal(summary.evaluation?.cache?.contextProjection.requestCount, 2);
    assert.equal(summary.evaluation?.cache?.contextProjection.promptDependencyCount, 0);
    assert.equal(summary.evaluation?.cache?.promptAssembly.stableReplayFingerprint, true);
    assert.equal(summary.evaluation?.cache?.promptAssembly.eventCount, 2);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_CACHE_HIT_TARGET_MISSED"), false);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_CONTEXT_PROJECTION_CACHE_NO_HIT"), true);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_CONTEXT_PROJECTION_KEY_WHOLE_PROMPT_DYNAMIC"), false);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_CACHE_METRIC_SCOPE_MISMATCH"), true);
  });

  it("surfaces changing context projection prompt dependencies for cache review", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "context.projection.completed",
        data: {
          cache: {
            namespace: "context.projection",
            key: "context.projection:first",
            hit: false,
            dependencyFingerprints: ["prompt:task-alpha", "workspace:stable"]
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "context.projection.completed",
        data: {
          cache: {
            namespace: "context.projection",
            key: "context.projection:second",
            hit: false,
            dependencyFingerprints: ["prompt:task-beta", "workspace:stable"]
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 0,
          metadata: {
            cache: { hitTokens: 900, missTokens: 100, hitRate: 0.9 }
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
      cacheHitTarget: 0.8,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    const wholePromptDiagnostic = summary.diagnostics.find((entry) => entry.code === "SWE_BENCH_CONTEXT_PROJECTION_KEY_WHOLE_PROMPT_DYNAMIC");
    const diagnosticMetadata = wholePromptDiagnostic?.metadata as JsonObject | undefined;

    assert.equal(summary.evaluation?.cache?.contextProjection.uniquePromptDependencyCount, 2);
    assert.deepEqual(summary.evaluation?.cache?.contextProjection.samplePromptDependencyFingerprints, ["prompt:task-alpha", "prompt:task-beta"]);
    assert.deepEqual(diagnosticMetadata?.samplePromptDependencyFingerprints, ["prompt:task-alpha", "prompt:task-beta"]);
  });

  it("excludes no-store prompt-only projections from context cache hit-rate accounting", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "context.projection.completed",
        data: {
          cache: {
            namespace: "context.projection",
            key: "context.projection:no-store",
            hit: false,
            dependencyFingerprints: []
          }
        }
      }),
      JSON.stringify({
        kind: "context.projection.completed",
        data: {
          cache: {
            namespace: "context.projection",
            key: "context.projection:stable-miss",
            hit: false,
            dependencyFingerprints: ["workspace:stable"]
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 0,
          metadata: {
            cache: { hitTokens: 900, missTokens: 100, hitRate: 0.9 }
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
      cacheHitTarget: 0.8,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    assert.equal(summary.evaluation?.cache?.contextProjection.requestCount, 1);
    assert.equal(summary.evaluation?.cache?.contextProjection.missCount, 1);
    assert.equal(summary.evaluation?.cache?.contextProjection.noStoreCount, 1);
    assert.equal(summary.evaluation?.cache?.contextProjection.uniqueKeyCount, 1);
  });

  it("treats legacy prompt-only projection cache keys as no-store telemetry", async () => {
    const platform = new FakeSweBenchPlatform("fake");
    await platform.writeFile("/workspace/predictions/glm.jsonl", JSON.stringify({
      instance_id: "demo__repo-1",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n"
    }) + "\n");
    await platform.writeFile("/workspace/traces/glm-run.jsonl", [
      JSON.stringify({
        kind: "context.projection.completed",
        data: {
          cache: {
            namespace: "context.projection",
            key: "context.projection:legacy-prompt-only",
            hit: false,
            dependencyFingerprints: ["prompt:hvolatile"]
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 0,
          metadata: {
            cache: { hitTokens: 900, missTokens: 100, hitRate: 0.9 }
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
      cacheHitTarget: 0.8,
      harnessPython: "/workspace/.deepseek/swebench-venv/bin/python",
      extraArgs: [],
      platform
    });

    assert.equal(summary.evaluation?.cache?.contextProjection.requestCount, 0);
    assert.equal(summary.evaluation?.cache?.contextProjection.noStoreCount, 1);
    const textLines = renderSweBenchPredictionText(summary);
    assert.equal(textLines.some((line) => line.includes("context cache: hitRate=unknown requests=0")), true);
    assert.equal(textLines.some((line) => line.includes("context cache: hitRate=0.0% requests=0")), false);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_CONTEXT_PROJECTION_CACHE_NO_HIT"), false);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_CONTEXT_PROJECTION_KEY_WHOLE_PROMPT_DYNAMIC"), false);
    assert.equal(summary.diagnostics.some((entry) => entry.code === "SWE_BENCH_CACHE_METRIC_SCOPE_MISMATCH"), false);
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

function cacheTracePrompt(fingerprint: string): string {
  return JSON.stringify({
    kind: "prompt.assembled",
    data: {
      fingerprint,
      trace: {
        replay: {
          sectionOrderFingerprint: "sections:stable",
          budgetFingerprint: "budget:stable",
          toolPlanFingerprint: "tools:stable"
        },
        pipeline: {
          pipelineFingerprint: "pipeline:test",
          providerPrefixFingerprint: "provider-prefix:stable",
          providerPrefixMessageCount: 13,
          providerPrefixTokenEstimate: 2265
        }
      }
    }
  });
}

function cacheTraceProviderRequest(): string {
  return JSON.stringify({
    kind: "model.requested",
    data: {
      contextPipeline: { pipelineFingerprint: "pipeline:test" },
      providerRequestReplay: {
        visibleToolCount: 73,
        selectedHistoryMessageCount: 15,
        historyMessageCount: 2,
        toolCallLinkage: { assistantToolCallCount: 1, toolResultCount: 1 }
      }
    }
  });
}

function cacheTraceUsage(input: { readonly hitTokens: number; readonly missTokens: number }): string {
  const total = input.hitTokens + input.missTokens;
  return JSON.stringify({
    kind: "usage.updated",
    data: {
      inputTokens: input.missTokens,
      metadata: {
        cache: {
          hitTokens: input.hitTokens,
          missTokens: input.missTokens,
          hitRate: total > 0 ? input.hitTokens / total : 0,
          pipelineFingerprint: "pipeline:test",
          explicitPrefixCacheHint: {
            status: "sent",
            reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
            redaction: { class: "internal" }
          }
        }
      }
    }
  });
}

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
