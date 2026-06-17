import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type {
  CapabilityExecutionContext,
  JsonObject,
  PlatformProviderResultMetadata,
  ProcessResult,
  ProcessRunOptions,
  TraceContext
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import { FakePlatformRuntime } from "@deepseek/platform-abstraction";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";
import { analyzeResourceScope, createSandboxAuditEvidence, createSandboxRequirement, createSecretRedactionDecision } from "@deepseek/policy-sandbox";
import { registerCliSweBenchRunCapabilities } from "./swe-bench-run-capabilities.js";

class FakeSweBenchRunPlatform extends FakePlatformRuntime {
  readonly executedCommands: { readonly command: string; readonly args: readonly string[]; readonly cwd?: string; readonly timeoutMs?: number; readonly env?: JsonObject }[] = [];
  readonly writes: { readonly path: string; readonly content: string }[] = [];
  readonly datasetInstances = new Map<number, Partial<SweBenchDatasetFixture>>();
  private readonly fileMtimeMs = new Map<string, number>();
  private fileClock = 0;
  agentStdout = JSON.stringify({ kind: "agent.loop.completed", data: { status: "completed" } }) + "\n";
  agentStdouts: string[] = [];
  resolveOnSecondHarness = false;
  resolvedTaskNumbers = new Set<number>();
  harnessTestOutputByInstanceId = new Map<string, string>();
  checkoutEditableInstallExitCode = 0;
  skipHarnessReportWrite = false;
  repoAlreadyExists = false;
  checkoutRequiresPreClean = false;
  gitIndexLockExists = false;
  harnessRunCount = 0;
  agentRunCount = 0;
  datasetRequests: number[] = [];
  private preCheckoutCleanSeen = false;

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

  override async runProcess(command: string, args: readonly string[], options: ProcessRunOptions = {}): Promise<ProcessResult> {
    this.executedCommands.push({
      command,
      args: [...args],
      ...(typeof options.cwd === "string" ? { cwd: options.cwd } : {}),
      ...(typeof options.timeoutMs === "number" ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.env ? { env: options.env } : {})
    });
    if (args[0] === "-c" && String(command).includes(".deepseek/swebench-venv/bin/python")) {
      const taskNumber = Number(args[2] ?? 2);
      const fixture = this.datasetInstances.get(taskNumber);
      this.datasetRequests.push(taskNumber);
      return result(JSON.stringify({
        instance_id: fixture?.instanceId ?? `demo__repo-${taskNumber}`,
        repo: fixture?.repo ?? "demo/repo",
        base_commit: fixture?.baseCommit ?? "abcdef0123456789abcdef0123456789abcdef01",
        problem_statement: fixture?.problemStatement ?? "SECRET_PROBLEM_STATEMENT_SHOULD_NOT_LEAK"
      }) + "\n");
    }
    if (command === process.execPath && args[0] === "-e" && String(args[1]).includes("rmSync") && String(args[2]).endsWith("/.git/index.lock")) {
      this.gitIndexLockExists = false;
      return result("removed\n");
    }
    if (command === "git" && args[0] === "-C" && args[2] === "rev-parse") return this.repoAlreadyExists ? result("true\n") : result("", 1);
    if (command === "git" && args[0] === "-C" && this.gitIndexLockExists && (args[2] === "reset" || args[2] === "checkout" || args[2] === "clean")) {
      return result("fatal: Unable to create '.git/index.lock': File exists.\n", 128);
    }
    if (command === "git" && args[0] === "clone") return result("cloned\n");
    if (command === "git" && args[0] === "-C" && args[2] === "clean") {
      if (!this.executedCommands.some((entry) => entry.command === "git" && entry.args[2] === "checkout")) {
        this.preCheckoutCleanSeen = true;
      }
      return result("cleaned\n");
    }
    if (command === "git" && args[0] === "-C" && args[2] === "checkout") {
      if (this.checkoutRequiresPreClean && !this.preCheckoutCleanSeen) return result("working tree would be overwritten\n", 1);
      return result("checked out\n");
    }
    if (String(command).endsWith("/.venv/bin/python") && args[0] === "-m" && args[1] === "pip" && args[2] === "install" && args[3] === "-e") {
      return result(this.checkoutEditableInstallExitCode === 0 ? "installed\n" : "editable install failed\n", this.checkoutEditableInstallExitCode);
    }
    if (command === "docker" && args[0] === "context" && args[1] === "inspect") return result("\"unix:///workspace/.colima/default/docker.sock\"\n");
    if (args.includes("swebench.harness.run_evaluation")) {
      this.harnessRunCount += 1;
      const cwd = typeof options.cwd === "string" ? options.cwd : "/workspace/.deepseek/swe-lite-runs/unit-run/harness";
      const runId = argAfter(args, "--run_id") ?? "unit-run-evaluation";
      const predictionPath = argAfter(args, "--predictions_path") ?? "/workspace/.deepseek/swe-lite-runs/unit-run/prediction.jsonl";
      const predictions = (await this.readFile(predictionPath)).split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as JsonObject);
      const modelName = typeof predictions[0]?.model_name_or_path === "string" ? predictions[0].model_name_or_path : "glm-5.1";
      const instanceId = typeof predictions[0]?.instance_id === "string" ? predictions[0].instance_id : "demo__repo-2";
      const taskNumber = Number(instanceId.replace(/^demo__repo-/, ""));
      const resolved = this.resolvedTaskNumbers.has(taskNumber) || (this.resolveOnSecondHarness && this.harnessRunCount >= 2);
      if (!this.skipHarnessReportWrite) {
        await this.writeFile(`${cwd}/logs/run_evaluation/${runId}/${modelName}/${instanceId}/report.json`, JSON.stringify({
          [instanceId]: {
            resolved,
            tests_status: {
              FAIL_TO_PASS: { success: resolved ? ["tests/test_demo.py::test_expected_fix"] : [], failure: resolved ? [] : ["tests/test_demo.py::test_expected_fix"] },
              PASS_TO_PASS: { success: ["tests/test_demo.py::test_existing"], failure: resolved ? [] : ["tests/test_demo.py::test_regressed"] }
            }
          }
        }));
        const testOutput = this.harnessTestOutputByInstanceId.get(instanceId);
        if (testOutput) await this.writeFile(`${cwd}/logs/run_evaluation/${runId}/${modelName}/${instanceId}/test_output.txt`, testOutput);
      }
      return result("Evaluation complete\n");
    }
    if (command === "git" && args[0] === "diff") {
      return result([
        "diff --git a/src/example.py b/src/example.py",
        "--- a/src/example.py",
        "+++ b/src/example.py",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        ""
      ].join("\n"));
    }
    if (command === process.execPath) {
      this.agentRunCount += 1;
      return result(this.agentStdouts[this.agentRunCount - 1] ?? this.agentStdout);
    }
    return result("ok\n");
  }
}

interface SweBenchDatasetFixture {
  readonly instanceId: string;
  readonly repo: string;
  readonly baseCommit: string;
  readonly problemStatement: string;
}

describe("CLI SWE-bench run capability", () => {
  it("keeps checkout environment selection free of benchmark repo or instance allowlists", async () => {
    const source = await readFile(new URL("./swe-bench-run-capabilities.ts", import.meta.url), "utf8");

    assert.equal(source.includes("astropy/astropy"), false);
    assert.equal(source.includes("astropy__"), false);
  });

  it("prepares a run-scoped prediction flow from only a numbered task input", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const manifest = await deps.capabilities.get(asId<"capability">("core.swe.bench.run"));
    const visibleTools = await deps.capabilities.listModelVisible();
    assert.equal(manifest?.projection?.modelVisible, true);
    assert.equal(manifest?.toolFamily?.familyId, "benchmark.run");
    assert.equal(Boolean(await deps.capabilities.resolveExecutable(asId<"capability">("core.swe.bench.run"))), true);
    assert.equal(visibleTools.some((tool) => tool.id === "core.swe.bench.run" && tool.toolFamily?.familyId === "benchmark.run"), true);

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { status?: string; preview?: { text?: string }; metadata?: JsonObject } };
    const serialized = JSON.stringify(value);
    const preview = value.evidence?.preview?.text ?? "";
    const child = platform.executedCommands.find(isAgentRunCommand);

    assert.equal(preview.includes("taskNumber=2"), true);
    assert.equal(preview.includes("instance=demo__repo-2"), true);
    assert.equal(preview.includes("patchBytes="), true);
    assert.equal(serialized.includes("fixture-secret-value"), false);
    assert.equal(serialized.includes("SECRET_PROBLEM_STATEMENT_SHOULD_NOT_LEAK"), false);
    assert.equal(serialized.includes(".deepseek/swebench-workspaces"), false);
    assert.equal(child?.cwd, "/workspace/.deepseek/swe-lite-runs/unit-run/repo");
    assert.equal(platform.executedCommands.some((entry) => entry.command === "git" && entry.args[0] === "clone"), true);
    assert.equal(platform.executedCommands.some((entry) => entry.command === "git" && entry.args.includes("checkout")), true);
  });

  it("normalizes explicit low SWE-bench run timeouts before launching the child CLI", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-low-timeout",
      timeoutMs: 600_000
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const child = platform.executedCommands.find(isAgentRunCommand);
    assert.equal(argAfter(child?.args ?? [], "--timeout-ms"), "7200000");
  });

  it("uses fresh default run ids so repeated live probes do not mix trace evidence", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const first = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1"
    }, capabilityContext());
    const second = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1"
    }, capabilityContext());

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    const firstRunId = ((first.value as { evidence?: { metadata?: JsonObject } }).evidence?.metadata?.runId);
    const secondRunId = ((second.value as { evidence?: { metadata?: JsonObject } }).evidence?.metadata?.runId);
    assert.equal(typeof firstRunId, "string");
    assert.equal(typeof secondRunId, "string");
    assert.notEqual(firstRunId, secondRunId);
    assert.equal(String(firstRunId).startsWith("swe-lite-task-2-"), true);
    assert.equal(String(secondRunId).startsWith("swe-lite-task-2-"), true);
  });

  it("uses a stable default batch run id when resume is requested without an explicit run id", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.resolvedTaskNumbers.add(3);
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/swe-lite-batch-2-4-task-2/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 2,
      status: "pass",
      evaluationResolved: true
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [2, 3, 4],
      provider: "glm",
      model: "glm-5.1",
      resume: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;

    assert.equal(value.evidence?.metadata?.runId, "swe-lite-batch-2-4");
    assert.deepEqual(batch?.skippedTaskNumbers, [2]);
    assert.deepEqual(platform.datasetRequests, [3, 4]);
  });

  it("resumes past terminal unresolved child summaries so a batch can continue scoring later tasks", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.resolvedTaskNumbers.add(3);
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/swe-lite-batch-2-4-task-2/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 2,
      runId: "swe-lite-batch-2-4-task-2",
      status: "fail",
      evaluationResolved: false,
      evaluationStatus: "warn",
      attemptCount: 2,
      commandCount: 17,
      diagnostics: []
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [2, 3, 4],
      provider: "glm",
      model: "glm-5.1",
      resume: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;

    assert.deepEqual(platform.datasetRequests, [3, 4]);
    assert.deepEqual(batch?.skippedTaskNumbers, [2]);
    assert.deepEqual(batch?.failedTaskNumbers, [2]);
    assert.deepEqual(batch?.resolvedTaskNumbers, [3]);
    assert.equal(batch?.completedTasks, 3);
  });

  it("retries infrastructure-only child failures when resuming a batch", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.resolvedTaskNumbers.add(4);
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-infra-task-3/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 3,
      runId: "unit-batch-infra-task-3",
      status: "fail",
      instanceId: "demo__repo-3",
      diagnostics: [
        {
          code: "SWE_BENCH_CHECKOUT_FAILED",
          severity: "error",
          message: "git checkout exited with code 1",
          redaction: { class: "internal" }
        }
      ]
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [3, 4],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-infra",
      resume: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    assert.deepEqual(platform.datasetRequests, [3, 4]);
    assert.equal(platform.executedCommands.filter(isAgentRunCommand).length >= 2, true);
  });

  it("retries stale harness report failures when resuming after the environment is fixed", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.resolvedTaskNumbers.add(10);
    platform.resolvedTaskNumbers.add(11);
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-harness-retry-task-10/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 10,
      runId: "unit-batch-harness-retry-task-10",
      status: "fail",
      evaluationStatus: "fail",
      instanceId: "demo__repo-10",
      commandCount: 12,
      diagnostics: [
        {
          code: "SWE_BENCH_REPORT_READ_FAILED",
          severity: "error",
          message: "report missing",
          redaction: { class: "internal" }
        }
      ]
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [10, 11],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-harness-retry",
      resume: true
    }, capabilityContext());

    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;

    assert.equal(execution.ok, true);
    assert.deepEqual(platform.datasetRequests, [10, 11]);
    assert.deepEqual(batch?.skippedTaskNumbers, []);
    assert.deepEqual(batch?.resolvedTaskNumbers, [10, 11]);
    assert.equal(platform.executedCommands.filter(isAgentRunCommand).length, 2);
  });

  it("imports recovered harness sidecar evidence instead of preserving stale report failures on resume", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-recovered-task-10/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 10,
      runId: "unit-batch-recovered-task-10",
      status: "fail",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "fail",
      instanceId: "demo__repo-10",
      commandCount: 12,
      diagnostics: [
        {
          code: "SWE_BENCH_REPORT_READ_FAILED",
          severity: "error",
          message: "report missing",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-recovered-task-10/local-build-evaluate.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "diagnostics.swe-bench",
      status: "warn",
      sweBench: {
        schemaVersion: "1.0.0",
        kind: "diagnostics.swe-bench.prediction.summary",
        status: "warn",
        action: "evaluate",
        dryRun: false,
        live: false,
        predictions: [],
        commandPlan: [],
        executedCommands: [],
        evaluation: {
          completed: true,
          resolved: false,
          runId: "unit-batch-recovered-task-10-evaluation-local-build",
          predictionsPath: "/workspace/.deepseek/swe-lite-runs/unit-batch-recovered-task-10/prediction.jsonl",
          reportDir: "/workspace/.deepseek/swe-lite-runs/unit-batch-recovered-task-10/harness",
          reportPath: "/workspace/.deepseek/swe-lite-runs/unit-batch-recovered-task-10/harness/report.json",
          modelName: "glm-5.1",
          instanceId: "demo__repo-10",
          tests: {
            failToPass: { success: 0, failure: 16, successTests: [], failureTests: ["tests/test_demo.py::test_expected_fix"] },
            passToPass: { success: 58, failure: 0, successTests: [], failureTests: [] }
          },
          instances: [],
          batch: {
            totalInstances: 1,
            resolvedInstances: 0,
            unresolvedInstanceIds: ["demo__repo-10"],
            errorInstanceIds: [],
            resolvedRate: 0
          }
        },
        diagnostics: [
          {
            code: "SWE_BENCH_EVALUATION_UNRESOLVED",
            severity: "warn",
            message: "official unresolved",
            metadata: {},
            redaction: { class: "internal" }
          }
        ],
        redaction: { class: "internal" }
      }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-recovered-task-11/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 11,
      runId: "unit-batch-recovered-task-11",
      status: "pass",
      evaluationStatus: "pass",
      evaluationResolved: true,
      commandCount: 10,
      diagnostics: []
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [10, 11],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-recovered",
      resume: true
    }, capabilityContext());

    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const state = (batch?.taskStates as JsonObject[] | undefined)?.[0];
    const persisted = JSON.parse(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-batch-recovered-task-10/summary.json")) as JsonObject;

    assert.equal(execution.ok, true);
    assert.deepEqual(platform.datasetRequests, []);
    assert.equal(platform.executedCommands.filter(isAgentRunCommand).length, 0);
    assert.deepEqual(batch?.failedTaskNumbers, []);
    assert.deepEqual(batch?.unresolvedTaskNumbers, [10]);
    assert.equal(state?.primaryReasonCode, "MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR");
    assert.equal(state?.failureCategory, "model-patch");
    assert.equal(persisted.evaluationResolved, false);
    assert.equal(persisted.failToPassFailureCount, 16);
    assert.equal(value.evidence?.preview?.text?.includes("taskReview=10:MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), true);
  });

  it("refreshes only existing batch summaries when resumeOnly is requested", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-review-task-8/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 8,
      runId: "unit-batch-review-task-8",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      attemptCount: 2,
      commandCount: 20,
      diagnostics: [
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal" }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-review-task-8/trace.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole-prompt:first",
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
      ""
    ].join("\n"));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-review-task-9/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 9,
      runId: "unit-batch-review-task-9",
      status: "pass",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "pass",
      evaluationResolved: true,
      attemptCount: 2,
      commandCount: 18,
      diagnostics: [],
      redaction: { class: "internal" }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-review-task-10/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 10,
      runId: "unit-batch-review-task-10",
      status: "fail",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "fail",
      instanceId: "demo__repo-10",
      commandCount: 12,
      diagnostics: [
        {
          code: "SWE_BENCH_REPORT_READ_FAILED",
          severity: "error",
          message: "report missing",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal" }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-review-task-10/local-build-evaluate.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "diagnostics.swe-bench",
      status: "warn",
      sweBench: {
        schemaVersion: "1.0.0",
        kind: "diagnostics.swe-bench.prediction.summary",
        status: "warn",
        action: "evaluate",
        dryRun: false,
        live: false,
        predictions: [],
        commandPlan: [],
        executedCommands: [],
        evaluation: {
          completed: true,
          resolved: false,
          runId: "unit-batch-review-task-10-evaluation-local-build",
          predictionsPath: "/workspace/.deepseek/swe-lite-runs/unit-batch-review-task-10/prediction.jsonl",
          reportDir: "/workspace/.deepseek/swe-lite-runs/unit-batch-review-task-10/harness",
          reportPath: "/workspace/.deepseek/swe-lite-runs/unit-batch-review-task-10/harness/report.json",
          modelName: "glm-5.1",
          instanceId: "demo__repo-10",
          tests: {
            failToPass: { success: 0, failure: 16, successTests: [], failureTests: ["tests/test_demo.py::test_expected_fix"] },
            passToPass: { success: 58, failure: 0, successTests: [], failureTests: [] }
          },
          instances: [],
          batch: {
            totalInstances: 1,
            resolvedInstances: 0,
            unresolvedInstanceIds: ["demo__repo-10"],
            errorInstanceIds: [],
            resolvedRate: 0
          }
        },
        diagnostics: [
          {
            code: "SWE_BENCH_EVALUATION_UNRESOLVED",
            severity: "warn",
            message: "official unresolved",
            metadata: {},
            redaction: { class: "internal" }
          }
        ],
        redaction: { class: "internal" }
      }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [8, 9, 10, 11, 12],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-review",
      resume: true,
      resumeOnly: true
    }, capabilityContext());

    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const states = batch?.taskStates as JsonObject[] | undefined;
    const task8 = states?.find((state) => state.taskNumber === 8);
    const task9 = states?.find((state) => state.taskNumber === 9);
    const task10 = states?.find((state) => state.taskNumber === 10);
    const task11 = states?.find((state) => state.taskNumber === 11);
    const persistedTask8 = JSON.parse(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-batch-review-task-8/summary.json")) as JsonObject;
    const persistedTask10 = JSON.parse(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-batch-review-task-10/summary.json")) as JsonObject;

    assert.equal(execution.ok, true);
    assert.deepEqual(platform.datasetRequests, []);
    assert.equal(platform.executedCommands.length, 0);
    assert.deepEqual(batch?.resolvedTaskNumbers, [9]);
    assert.deepEqual(batch?.unresolvedTaskNumbers, [8, 10, 11, 12]);
    assert.deepEqual(batch?.failedTaskNumbers, []);
    assert.equal(batch?.skippedTasks, 0);
    assert.deepEqual(batch?.skippedTaskNumbers, []);
    assert.deepEqual(batch?.resumedTaskNumbers, [8, 9, 10]);
    assert.equal(batch?.completedResolvedRate, 1 / 3);
    assert.equal(task9?.status, "resolved");
    assert.equal(task9?.resumedFromSummary, true);
    assert.equal(task8?.primaryReasonCode, "CACHE_PROVIDER_BELOW_TARGET");
    assert.equal((task8?.reasonCodes as string[] | undefined)?.includes("CACHE_PROVIDER_BELOW_TARGET"), true);
    assert.equal((task8?.reasonCodes as string[] | undefined)?.includes("CACHE_PROVIDER_PIPELINE_TELEMETRY_ABSENT"), true);
    assert.equal((task8?.reasonCodes as string[] | undefined)?.includes("CACHE_PROVIDER_PIPELINE_MISSING"), false);
    assert.equal(task10?.primaryReasonCode, "MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR");
    assert.equal(task11?.status, "pending");
    assert.equal((persistedTask8.diagnostics as JsonObject[]).some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_PIPELINE_TELEMETRY_ABSENT"), true);
    assert.equal((persistedTask8.diagnostics as JsonObject[]).some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_PIPELINE_MISSING"), false);
    assert.equal((batch?.reviewCodes as string[] | undefined)?.includes("SWE_BENCH_PROVIDER_CACHE_PIPELINE_TELEMETRY_ABSENT"), true);
    assert.equal((batch?.reviewCodes as string[] | undefined)?.includes("SWE_BENCH_PROVIDER_CACHE_PIPELINE_MISSING"), false);
    assert.equal((batch?.reviewCodes as string[] | undefined)?.includes("SWE_BENCH_BATCH_BACKPRESSURE_ACTIVE"), true);
    assert.equal(persistedTask10.evaluationResolved, false);
    assert.equal(persistedTask10.failToPassFailureCount, 16);
    assert.equal(value.evidence?.preview?.text?.includes("reviewCodes=SWE_BENCH_BATCH_BACKPRESSURE_ACTIVE"), true);
    assert.equal(value.evidence?.preview?.text?.includes("resumed=3"), true);
    assert.equal(value.evidence?.preview?.text?.includes("taskReview=8:CACHE_PROVIDER_BELOW_TARGET;10:MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), true);
  });

  it("does not overwrite existing single-task evidence when execute is false", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    const summaryPath = "/workspace/.deepseek/swe-lite-runs/unit-run-dry-review/summary.json";
    await platform.writeFile(summaryPath, JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 3,
      runId: "unit-run-dry-review",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      primaryReasonCode: "FLOW_POST_EDIT_VERIFICATION_MISSING",
      reasonCodes: ["FLOW_POST_EDIT_VERIFICATION_MISSING", "CACHE_PROVIDER_BELOW_TARGET"],
      providerCacheHitRate: 0.77,
      childTerminalKind: "agent.loop.budget.consumed",
      childTerminalReason: "swe-bench-environment-blocker",
      childTestCommandCount: 1,
      commandCount: 16,
      diagnostics: [],
      redaction: { class: "internal" }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 3,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-dry-review",
      execute: false
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const persisted = JSON.parse(await platform.readFile(summaryPath)) as JsonObject;
    assert.equal(persisted.execute, true);
    assert.equal(persisted.primaryReasonCode, "FLOW_POST_EDIT_VERIFICATION_MISSING");
    assert.deepEqual(persisted.reasonCodes, ["FLOW_POST_EDIT_VERIFICATION_MISSING", "CACHE_PROVIDER_BELOW_TARGET"]);
    assert.equal(persisted.providerCacheHitRate, 0.77);
    assert.equal(persisted.childTerminalKind, "agent.loop.budget.consumed");
  });

  it("runs the official harness after prediction and exposes unresolved scores as capability evidence", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-evaluation"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { status?: string; preview?: { text?: string }; metadata?: JsonObject } };
    const metadata = value.evidence?.metadata;
    const preview = value.evidence?.preview?.text ?? "";
    const harness = platform.executedCommands.find((entry) => entry.args.includes("swebench.harness.run_evaluation"));

    assert.ok(harness);
    assert.equal(harness.command, "/workspace/.deepseek/swebench-venv/bin/python");
    assert.equal(harness.cwd, "/workspace/.deepseek/swe-lite-runs/unit-run-evaluation/harness");
    assert.equal(metadata?.status, "warn");
    assert.equal(metadata?.evaluationStatus, "warn");
    assert.equal(metadata?.evaluationResolved, false);
    assert.equal(metadata?.evaluationResolvedRate, 0);
    assert.equal(metadata?.failToPassFailureCount, 1);
    assert.equal(metadata?.passToPassFailureCount, 1);
    assert.equal(metadata?.primaryReasonCode, "REPAIR_FEEDBACK_LOW_FIDELITY");
    assert.equal(metadata?.failureCategory, "repair-feedback");
    assert.equal(metadata?.actionability, "repair-feedback-fix");
    assert.deepEqual(metadata?.reasonCodes, ["REPAIR_FEEDBACK_LOW_FIDELITY", "OFFICIAL_UNRESOLVED_AFTER_REPAIR"]);
    assert.equal(value.evidence?.status, "failed");
    assert.equal(preview.includes("status=warn"), true);
    assert.equal(preview.includes("evaluation=warn resolved=false rate=0.0%"), true);
    assert.equal(preview.includes("failure=REPAIR_FEEDBACK_LOW_FIDELITY action=repair-feedback-fix"), true);
  });

  it("runs a numbered task batch with resume and reports aggregate scores", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.resolvedTaskNumbers.add(3);
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-task-2/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 2,
      status: "pass",
      evaluationResolved: true
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [2, 3, 4],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch",
      resume: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { status?: string; preview?: { text?: string }; metadata?: JsonObject } };
    const metadata = value.evidence?.metadata;
    const batch = metadata?.batch as JsonObject | undefined;
    const childRuns = platform.executedCommands.filter(isAgentRunCommand);

    assert.equal(metadata?.kind, "capability.swe-bench.run.summary");
    assert.equal(metadata?.taskNumber, 0);
    assert.deepEqual(metadata?.taskNumbers, [2, 3, 4]);
    assert.equal(batch?.totalTasks, 3);
    assert.equal(batch?.resolvedTasks, 2);
    assert.equal(batch?.unresolvedTasks, 1);
    assert.equal(Array.isArray(batch?.taskStates), true);
    assert.deepEqual((batch?.taskStates as JsonObject[]).map((state) => state.taskNumber), [2, 3, 4]);
    assert.deepEqual((batch?.taskStates as JsonObject[]).map((state) => state.status), ["skipped", "resolved", "unresolved"]);
    assert.deepEqual(batch?.skippedTaskNumbers, [2]);
    assert.deepEqual(batch?.unresolvedTaskNumbers, [4]);
    assert.equal(batch?.resolvedRate, 2 / 3);
    assert.equal(batch?.completedResolvedRate, 2 / 3);
    assert.equal(childRuns.length, 3);
    assert.deepEqual(platform.datasetRequests, [3, 4]);
    assert.equal(value.evidence?.status, "failed");
    assert.equal(value.evidence?.preview?.text?.includes("batch tasks=3 resolved=2 unresolved=1 skipped=1 rate=66.7%"), true);
    assert.equal(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-batch/batch-summary.json").then((content) => JSON.parse(content) as JsonObject).then((summary) => (summary.batch as JsonObject).resolvedTasks), 2);
  });

  it("holds pending batch tasks when completed success or provider cache is below the review threshold", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-backpressure-task-8/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 8,
      runId: "unit-batch-backpressure-task-8",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      providerCacheHitRate: 0.78,
      providerCacheRequestCount: 10,
      attemptCount: 2,
      commandCount: 20,
      diagnostics: [
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_PROVIDER_CACHE_HISTORY_TAIL_MISS",
          severity: "warn",
          message: "history tail miss",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal" }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-backpressure-task-9/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 9,
      runId: "unit-batch-backpressure-task-9",
      status: "pass",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "pass",
      evaluationResolved: true,
      providerCacheHitRate: 0.79,
      providerCacheRequestCount: 10,
      attemptCount: 1,
      commandCount: 12,
      diagnostics: [],
      redaction: { class: "internal" }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-backpressure-task-10/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 10,
      runId: "unit-batch-backpressure-task-10",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      providerCacheHitRate: 0.77,
      providerCacheRequestCount: 10,
      attemptCount: 1,
      commandCount: 14,
      diagnostics: [
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal" }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [8, 9, 10, 11, 12],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-backpressure",
      resume: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const states = batch?.taskStates as JsonObject[];
    const diagnostics = value.evidence?.metadata?.diagnostics as JsonObject[] | undefined;
    const backpressure = diagnostics?.find((entry) => entry.code === "SWE_BENCH_BATCH_BACKPRESSURE_ACTIVE");
    const backpressureMetadata = backpressure?.metadata as JsonObject | undefined;

    assert.deepEqual(platform.datasetRequests, []);
    assert.equal(platform.executedCommands.filter(isAgentRunCommand).length, 0);
    assert.equal(batch?.completedResolvedRate, 1 / 3);
    assert.equal(batch?.providerCacheHitRate, 0.78);
    assert.equal(states.find((state) => state.taskNumber === 11)?.status, "pending");
    assert.equal(states.find((state) => state.taskNumber === 12)?.status, "pending");
    assert.equal(diagnostics?.some((entry) => entry.code === "SWE_BENCH_BATCH_BACKPRESSURE_ACTIVE"), true);
    assert.equal(backpressureMetadata?.rampStatus, "blocked");
    assert.deepEqual(backpressureMetadata?.blockedExpansionTaskNumbers, [11, 12]);
    assert.deepEqual(backpressureMetadata?.canaryCandidateTaskNumbers, [8, 10]);
    assert.deepEqual(backpressureMetadata?.nextAllowedActions, [
      "review-only-evidence-refresh",
      "framework-cache-environment-fix",
      "single-failed-task-canary-after-fix"
    ]);
    assert.equal(value.evidence?.preview?.text?.includes("reviewCodes=SWE_BENCH_BATCH_BACKPRESSURE_ACTIVE"), true);
  });

  it("blocks direct single-task expansion when latest batch backpressure lists the task as paused", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-backpressure/batch-summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 0,
      taskNumbers: [8, 9, 10, 11, 12],
      runId: "unit-batch-backpressure",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationResolved: false,
      evaluationResolvedRate: 0.2,
      commandCount: 46,
      batch: {
        totalTasks: 5,
        completedTasks: 3,
        resolvedTasks: 1,
        unresolvedTasks: 4,
        failedTasks: 0,
        skippedTasks: 0,
        resolvedRate: 0.2,
        completedResolvedRate: 1 / 3,
        taskNumbers: [8, 9, 10, 11, 12],
        resolvedTaskNumbers: [9],
        unresolvedTaskNumbers: [8, 10, 11, 12],
        failedTaskNumbers: [],
        skippedTaskNumbers: [],
        providerCacheHitRate: 0.78,
        providerCacheRequestCount: 30,
        reviewCodes: ["SWE_BENCH_BATCH_BACKPRESSURE_ACTIVE"],
        taskStates: [
          { taskNumber: 8, runId: "unit-batch-backpressure-task-8", status: "unresolved" },
          { taskNumber: 9, runId: "unit-batch-backpressure-task-9", status: "resolved" },
          { taskNumber: 10, runId: "unit-batch-backpressure-task-10", status: "unresolved" },
          {
            taskNumber: 11,
            runId: "",
            status: "pending",
            primaryReasonCode: "BATCH_PENDING_GOVERNANCE_BACKPRESSURE",
            reasonCodes: ["BATCH_PENDING_GOVERNANCE_BACKPRESSURE"],
            failureCategory: "batch-resume",
            actionability: "pending-review"
          },
          {
            taskNumber: 12,
            runId: "",
            status: "pending",
            primaryReasonCode: "BATCH_PENDING_GOVERNANCE_BACKPRESSURE",
            reasonCodes: ["BATCH_PENDING_GOVERNANCE_BACKPRESSURE"],
            failureCategory: "batch-resume",
            actionability: "pending-review"
          }
        ]
      },
      diagnostics: [
        {
          code: "SWE_BENCH_BATCH_BACKPRESSURE_ACTIVE",
          severity: "warn",
          message: "SWE-bench batch scheduling paused pending tasks because completed success rate or provider cache hit rate is below the review threshold.",
          metadata: {
            completedTasks: 3,
            resolvedTasks: 1,
            completedResolvedRate: 1 / 3,
            providerCacheHitRate: 0.78,
            providerCacheRequestCount: 30,
            pendingTaskNumbers: [11, 12],
            blockedExpansionTaskNumbers: [11, 12],
            canaryCandidateTaskNumbers: [8, 10],
            nextAllowedActions: [
              "review-only-evidence-refresh",
              "framework-cache-environment-fix",
              "single-failed-task-canary-after-fix"
            ],
            rampStatus: "blocked"
          },
          redaction: { class: "internal", fields: ["metadata"] }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 11,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-direct-blocked-expansion"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const diagnostics = value.evidence?.metadata?.diagnostics as JsonObject[] | undefined;
    const blocker = diagnostics?.find((entry) => entry.code === "SWE_BENCH_RAMP_BACKPRESSURE_EXPANSION_BLOCKED");
    const metadata = blocker?.metadata as JsonObject | undefined;

    assert.deepEqual(platform.datasetRequests, []);
    assert.equal(platform.executedCommands.filter(isAgentRunCommand).length, 0);
    assert.equal(value.evidence?.metadata?.status, "warn");
    assert.equal(value.evidence?.metadata?.primaryReasonCode, "BATCH_PENDING_GOVERNANCE_BACKPRESSURE");
    assert.equal(value.evidence?.metadata?.failureCategory, "batch-resume");
    assert.equal(value.evidence?.metadata?.actionability, "pending-review");
    assert.equal(blocker?.severity, "warn");
    assert.equal(metadata?.sourceRunId, "unit-batch-backpressure");
    assert.deepEqual(metadata?.blockedExpansionTaskNumbers, [11, 12]);
    assert.deepEqual(metadata?.canaryCandidateTaskNumbers, [8, 10]);
    assert.equal(value.evidence?.preview?.text?.includes("failure=BATCH_PENDING_GOVERNANCE_BACKPRESSURE action=pending-review"), true);
  });

  it("holds pending batch tasks when provider cache is below the 90 percent governance gate even if success is healthy", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    for (const taskNumber of [8, 9, 10]) {
      await platform.writeFile(`/workspace/.deepseek/swe-lite-runs/unit-batch-cache-gate-task-${taskNumber}/summary.json`, JSON.stringify({
        schemaVersion: "1.0.0",
        kind: "capability.swe-bench.run.summary",
        taskNumber,
        runId: `unit-batch-cache-gate-task-${taskNumber}`,
        status: "pass",
        dryRun: false,
        execute: true,
        provider: "glm",
        model: "glm-5.1",
        evaluationStatus: "pass",
        evaluationResolved: true,
        providerCacheHitRate: 0.85,
        providerCacheRequestCount: 10,
        attemptCount: 1,
        commandCount: 12,
        diagnostics: [],
        redaction: { class: "internal" }
      }));
    }
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [8, 9, 10, 11],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-cache-gate",
      resume: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const states = batch?.taskStates as JsonObject[];
    const diagnostics = value.evidence?.metadata?.diagnostics as JsonObject[] | undefined;
    const backpressure = diagnostics?.find((entry) => entry.code === "SWE_BENCH_BATCH_BACKPRESSURE_ACTIVE");
    const backpressureMetadata = backpressure?.metadata as JsonObject | undefined;

    assert.deepEqual(platform.datasetRequests, []);
    assert.equal(platform.executedCommands.filter(isAgentRunCommand).length, 0);
    assert.equal(batch?.completedResolvedRate, 1);
    assert.equal(batch?.providerCacheHitRate, 0.85);
    const task11 = states.find((state) => state.taskNumber === 11);
    assert.equal(task11?.status, "pending");
    assert.equal(task11?.primaryReasonCode, "BATCH_PENDING_GOVERNANCE_BACKPRESSURE");
    assert.equal(task11?.failureCategory, "batch-resume");
    assert.equal(task11?.actionability, "pending-review");
    assert.equal((task11?.reasonCodes as string[] | undefined)?.includes("BATCH_PENDING_GOVERNANCE_BACKPRESSURE"), true);
    assert.equal(diagnostics?.some((entry) => entry.code === "SWE_BENCH_BATCH_BACKPRESSURE_ACTIVE"), true);
    assert.equal(backpressureMetadata?.rampStatus, "blocked");
    assert.deepEqual(backpressureMetadata?.blockedExpansionTaskNumbers, [11]);
    assert.deepEqual(backpressureMetadata?.nextAllowedActions, [
      "review-only-evidence-refresh",
      "framework-cache-environment-fix",
      "single-failed-task-canary-after-fix"
    ]);
    assert.equal(value.evidence?.preview?.text?.includes("reviewCodes=SWE_BENCH_BATCH_BACKPRESSURE_ACTIVE"), true);
  });

  it("persists batch progress after each child task so interrupted campaigns remain resumable", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.resolvedTaskNumbers.add(2);
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [2, 3],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-progress",
      resume: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const progressWrites = platform.writes.filter((write) => write.path === "/workspace/.deepseek/swe-lite-runs/unit-batch-progress/batch-summary.json");
    assert.equal(progressWrites.length >= 2, true);
    const firstProgress = JSON.parse(progressWrites[0]?.content ?? "{}") as JsonObject;
    const firstBatch = firstProgress.batch as JsonObject;
    assert.equal(firstBatch.completedTasks, 1);
    assert.deepEqual(firstBatch.taskNumbers, [2, 3]);
  });

  it("surfaces provider cache metrics from child traces in run evidence", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.resolvedTaskNumbers.add(2);
    platform.agentStdout = [
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 1_000,
          metadata: {
            cache: {
              hitTokens: 900,
              missTokens: 100,
              hitRate: 0.9
            }
          }
        }
      }),
      JSON.stringify({ kind: "agent.loop.completed", data: { status: "completed" } }),
      ""
    ].join("\n");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-cache"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { preview?: { text?: string }; metadata?: JsonObject } };

    assert.equal(value.evidence?.metadata?.providerCacheHitRate, 0.9);
    assert.equal(value.evidence?.metadata?.providerCacheRequestCount, 1);
    assert.equal(value.evidence?.preview?.text?.includes("providerCache hitRate=90.0% requests=1"), true);
  });

  it("gates run evidence when provider cache misses the 90 percent target", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.agentStdout = [
      JSON.stringify({ kind: "prompt.assembled", data: { trace: { replay: { sectionOrderFingerprint: "sections:stable", budgetFingerprint: "budget:stable", toolPlanFingerprint: "tools:stable" } } } }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:stable" },
          providerRequestReplay: {
            selectedHistoryMessageCount: 8,
            historyMessageCount: 8,
            toolCallLinkage: { assistantToolCallCount: 1, toolResultCount: 1 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 1_000,
          metadata: {
            cache: {
              hitTokens: 700,
              missTokens: 300,
              hitRate: 0.7,
              explicitPrefixCacheHint: { status: "unsupported" }
            }
          }
        }
      }),
      JSON.stringify({ kind: "agent.loop.completed", data: { status: "completed" } }),
      ""
    ].join("\n");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-cache-target"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;

    assert.equal(metadata?.providerCacheHitRate, 0.7);
    assert.equal(metadata?.providerCacheRequestCount, 1);
    assert.equal(metadata?.providerCachePassed, false);
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("CACHE_PROVIDER_BELOW_TARGET"), true);
    assert.equal(value.evidence?.preview?.text?.includes("providerCache hitRate=70.0% requests=1"), true);
  });

  it("aggregates cache review codes across batch child summaries", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.resolvedTaskNumbers.add(2);
    platform.resolvedTaskNumbers.add(3);
    platform.agentStdout = [
      JSON.stringify({
        kind: "context.projection.completed",
        data: {
          cache: {
            namespace: "context.projection",
            key: "context.projection:unit",
            hit: false,
            dependencyFingerprints: ["workspace:hunit"]
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
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
          trace: {
            replay: {
              sectionOrderFingerprint: "stable-sections",
              budgetFingerprint: "stable-budget"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 1_000,
          metadata: {
            cache: {
              hitTokens: 950,
              missTokens: 50,
              hitRate: 0.95
            }
          }
        }
      }),
      JSON.stringify({ kind: "agent.loop.completed", data: { status: "completed" } }),
      ""
    ].join("\n");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [2, 3],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-cache-review"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { preview?: { text?: string }; metadata?: JsonObject } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;

    assert.equal(batch?.providerCacheHitRate, 0.95);
    assert.equal(batch?.providerCacheRequestCount, 2);
    assert.equal(batch?.contextProjectionCacheHitRate, 0);
    assert.equal(batch?.contextProjectionCacheRequestCount, 2);
    assert.deepEqual(batch?.reviewCodes, [
      "SWE_BENCH_CACHE_METRIC_SCOPE_MISMATCH",
      "SWE_BENCH_CONTEXT_PROJECTION_CACHE_NO_HIT"
    ]);
    assert.equal(value.evidence?.preview?.text?.includes("contextProjectionCache hitRate=0.0% requests=2"), true);
    assert.equal(value.evidence?.preview?.text?.includes("reviewCodes=SWE_BENCH_CACHE_METRIC_SCOPE_MISMATCH,SWE_BENCH_CONTEXT_PROJECTION_CACHE_NO_HIT"), true);
  });

  it("does not aggregate non-cache review codes from resolved child summaries into batch review", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-resolved-review-task-2/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 2,
      runId: "unit-batch-resolved-review-task-2",
      status: "pass",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "pass",
      evaluationResolved: true,
      providerCacheHitRate: 0.86,
      providerCacheRequestCount: 10,
      attemptCount: 2,
      commandCount: 20,
      diagnostics: [
        {
          code: "SWE_BENCH_READY_FOR_HARNESS_GATE_MISSING",
          severity: "warn",
          message: "old flow diagnostic from a run that official harness eventually resolved",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET",
          severity: "warn",
          message: "cache remains below target even though the patch resolved",
          redaction: { class: "internal" }
        }
      ],
      reviewCodes: [
        "SWE_BENCH_READY_FOR_HARNESS_GATE_MISSING",
        "SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET"
      ],
      redaction: { class: "internal" }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-resolved-review-task-3/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 3,
      runId: "unit-batch-resolved-review-task-3",
      status: "pass",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "pass",
      evaluationResolved: true,
      providerCacheHitRate: 0.95,
      providerCacheRequestCount: 10,
      attemptCount: 1,
      commandCount: 12,
      diagnostics: [],
      redaction: { class: "internal" }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [2, 3],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-resolved-review",
      resume: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const reviewCodes = batch?.reviewCodes as string[] | undefined;

    assert.deepEqual(platform.datasetRequests, []);
    assert.deepEqual(reviewCodes, ["SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET"]);
    assert.equal(value.evidence?.preview?.text?.includes("SWE_BENCH_READY_FOR_HARNESS_GATE_MISSING"), false);
  });

  it("does not carry legacy prompt-only projection cache misses into resume-only task attribution", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-legacy-context-task-8/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 8,
      runId: "unit-batch-legacy-context-task-8",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      contextProjectionCacheHitRate: 0,
      contextProjectionCacheRequestCount: 1,
      attemptCount: 1,
      commandCount: 10,
      diagnostics: [
        {
          code: "SWE_BENCH_CONTEXT_PROJECTION_CACHE_NO_HIT",
          severity: "warn",
          message: "old context projection no hit",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_CONTEXT_PROJECTION_KEY_WHOLE_PROMPT_DYNAMIC",
          severity: "warn",
          message: "old prompt dynamic key",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-legacy-context-task-8/trace.jsonl", [
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
          inputTokens: 100,
          metadata: { cache: { hitTokens: 900, missTokens: 100, hitRate: 0.9 } }
        }
      }),
      ""
    ].join("\n"));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [8, 9],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-legacy-context",
      resume: true,
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const state = (batch?.taskStates as JsonObject[]).find((taskState) => taskState.taskNumber === 8);
    const persisted = JSON.parse(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-batch-legacy-context-task-8/summary.json")) as JsonObject;

    assert.equal(persisted.contextProjectionCacheRequestCount, 0);
    assert.equal(persisted.contextProjectionCacheHitRate, undefined);
    assert.equal(value.evidence?.preview?.text?.includes("contextProjectionCache hitRate=unknown requests=0"), true);
    assert.equal(value.evidence?.preview?.text?.includes("contextProjectionCache hitRate=0.0% requests=0"), false);
    assert.equal((persisted.reviewCodes as string[] | undefined)?.includes("SWE_BENCH_CONTEXT_PROJECTION_CACHE_NO_HIT"), false);
    assert.equal((persisted.reviewCodes as string[] | undefined)?.includes("SWE_BENCH_CONTEXT_PROJECTION_KEY_WHOLE_PROMPT_DYNAMIC"), false);
    assert.equal((state?.reasonCodes as string[] | undefined)?.includes("CACHE_CONTEXT_PROJECTION_NO_HIT"), false);
    assert.equal((state?.reasonCodes as string[] | undefined)?.includes("CACHE_CONTEXT_KEY_WHOLE_PROMPT_DYNAMIC"), false);
    assert.equal(state?.primaryReasonCode, "MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR");
  });

  it("classifies non-resolved batch task states with actionable reason codes", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-attribution-task-2/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 2,
      runId: "unit-batch-attribution-task-2",
      status: "warn",
      evaluationStatus: "warn",
      evaluationResolved: false,
      attemptCount: 2,
      repairAttempted: true,
      commandCount: 12,
      diagnostics: [
        {
          code: "SWE_BENCH_REPAIR_ATTEMPT_REQUESTED",
          severity: "info",
          message: "repair requested",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ]
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-attribution-task-3/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 3,
      runId: "unit-batch-attribution-task-3",
      status: "fail",
      evaluationStatus: "fail",
      evaluationResolved: false,
      attemptCount: 1,
      commandCount: 9,
      diagnostics: [
        {
          code: "SWE_BENCH_DOCKER_CONTEXT_UNAVAILABLE",
          severity: "error",
          message: "docker context unavailable",
          redaction: { class: "internal" }
        }
      ]
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-attribution-task-4/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 4,
      runId: "unit-batch-attribution-task-4",
      status: "warn",
      evaluationStatus: "warn",
      evaluationResolved: false,
      attemptCount: 2,
      childShellCommandCount: 3,
      childTestCommandCount: 0,
      providerCacheHitRate: 0.62,
      providerCacheRequestCount: 4,
      commandCount: 15,
      diagnostics: [
        {
          code: "SWE_BENCH_CHILD_TRACE_VERIFICATION_MISSING",
          severity: "warn",
          message: "verification missing",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET",
          severity: "error",
          message: "cache below target",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_CONTEXT_PROJECTION_CACHE_NO_HIT",
          severity: "warn",
          message: "context projection no hit",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_PROVIDER_CACHE_HISTORY_TAIL_MISS",
          severity: "warn",
          message: "history tail cache miss",
          redaction: { class: "internal" }
        },
        {
          code: "PROMPT_CACHE_PREFIX_BUSTED",
          severity: "warn",
          message: "prompt prefix changed",
          redaction: { class: "internal" }
        }
      ]
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [2, 3, 4],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-attribution",
      resume: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { preview?: { text?: string }; metadata?: JsonObject } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const states = new Map((batch?.taskStates as JsonObject[]).map((state) => [state.taskNumber, state]));

    assert.deepEqual(platform.datasetRequests, []);
    assert.deepEqual(batch?.skippedTaskNumbers, [2, 3, 4]);
    assert.deepEqual(batch?.unresolvedTaskNumbers, [2, 4]);
    assert.deepEqual(batch?.failedTaskNumbers, [3]);
    assert.equal(states.get(2)?.status, "unresolved");
    assert.equal(states.get(2)?.primaryReasonCode, "MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR");
    assert.equal(states.get(2)?.failureCategory, "model-patch");
    assert.equal(states.get(2)?.actionability, "model-feedback");
    assert.equal((states.get(2)?.reasonCodes as string[]).includes("OFFICIAL_UNRESOLVED_AFTER_REPAIR"), true);
    assert.equal((states.get(2)?.blockerIds as string[]).includes("agentic.blocker.061.official-harness-unresolved"), true);
    assert.equal(states.get(3)?.status, "failed");
    assert.equal(states.get(3)?.primaryReasonCode, "ENV_DOCKER_CONTEXT_UNAVAILABLE");
    assert.equal(states.get(3)?.failureCategory, "environment");
    assert.equal(states.get(3)?.actionability, "environment-fix");
    assert.equal((states.get(3)?.blockerIds as string[]).includes("agentic.blocker.036.docker-unavailable"), true);
    assert.equal(states.get(4)?.status, "unresolved");
    assert.equal(states.get(4)?.primaryReasonCode, "GATE_VERIFICATION_PRESSURE");
    assert.equal(states.get(4)?.failureCategory, "verification");
    assert.equal(states.get(4)?.actionability, "framework-fix");
    assert.equal((states.get(4)?.reasonCodes as string[]).includes("CACHE_PROVIDER_BELOW_TARGET"), true);
    assert.equal((states.get(4)?.reasonCodes as string[]).includes("CACHE_PROVIDER_HISTORY_TAIL_MISS"), true);
    assert.equal((states.get(4)?.reasonCodes as string[]).includes("CACHE_PROMPT_PREFIX_BUSTED"), true);
    assert.equal((states.get(4)?.reasonCodes as string[]).includes("CACHE_CONTEXT_PROJECTION_NO_HIT"), true);
    assert.equal((states.get(4)?.blockerIds as string[]).includes("agentic.blocker.041.verification-command-missing"), true);
    assert.equal(value.evidence?.preview?.text?.includes("taskReview=2:MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR;3:ENV_DOCKER_CONTEXT_UNAVAILABLE;4:GATE_VERIFICATION_PRESSURE"), true);
  });

  it("classifies history-tail cache misses as immediately actionable framework work", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-cache-action-task-8/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 8,
      runId: "unit-batch-cache-action-task-8",
      status: "fail",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      providerCacheHitRate: 0.78,
      providerCacheRequestCount: 4,
      commandCount: 15,
      diagnostics: [
        {
          code: "SWE_BENCH_PROVIDER_CACHE_HISTORY_TAIL_MISS",
          severity: "warn",
          message: "history tail cache miss",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [8, 9],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-cache-action",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const state = (batch?.taskStates as JsonObject[]).find((taskState) => taskState.taskNumber === 8);

    assert.equal(state?.primaryReasonCode, "CACHE_PROVIDER_HISTORY_TAIL_MISS");
    assert.equal(state?.failureCategory, "cache-economics");
    assert.equal(state?.actionability, "framework-fix");
    assert.equal((state?.reasonCodes as string[]).includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
    assert.equal((state?.blockerIds as string[]).includes("agentic.blocker.103.provider-cache-history-tail-miss"), true);
  });

  it("classifies dynamic provider cache tails after effective stable hits as immediately actionable framework work", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-dynamic-tail-task-8/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 8,
      runId: "unit-batch-dynamic-tail-task-8",
      status: "fail",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      providerCacheHitRate: 0.43,
      providerCacheRequestCount: 12,
      commandCount: 15,
      diagnostics: [
        {
          code: "SWE_BENCH_PROVIDER_CACHE_DYNAMIC_TAIL_MISS",
          severity: "warn",
          message: "dynamic tail cache miss",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [8, 9],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-dynamic-tail",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const state = (batch?.taskStates as JsonObject[]).find((taskState) => taskState.taskNumber === 8);

    assert.equal(state?.primaryReasonCode, "CACHE_PROVIDER_DYNAMIC_TAIL_MISS");
    assert.equal(state?.failureCategory, "cache-economics");
    assert.equal(state?.actionability, "framework-fix");
    assert.equal((state?.reasonCodes as string[]).includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
    assert.equal((state?.blockerIds as string[]).includes("agentic.blocker.118.provider-cache-dynamic-tail-miss"), true);
  });

  it("classifies multiple provider message cache breakpoints as immediately actionable framework work", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-multi-breakpoint-task-8/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 8,
      runId: "unit-batch-multi-breakpoint-task-8",
      status: "fail",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      providerCacheHitRate: 0.53,
      providerCacheRequestCount: 8,
      commandCount: 15,
      diagnostics: [
        {
          code: "SWE_BENCH_PROVIDER_CACHE_MULTI_MESSAGE_BREAKPOINT",
          severity: "warn",
          message: "multiple message cache breakpoints",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [8, 9],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-multi-breakpoint",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const state = (batch?.taskStates as JsonObject[]).find((taskState) => taskState.taskNumber === 8);

    assert.equal(state?.primaryReasonCode, "CACHE_PROVIDER_MULTI_MESSAGE_BREAKPOINT");
    assert.equal(state?.failureCategory, "cache-economics");
    assert.equal(state?.actionability, "framework-fix");
    assert.equal((state?.reasonCodes as string[]).includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
    assert.equal((state?.blockerIds as string[]).includes("agentic.blocker.120.provider-cache-multi-message-breakpoint"), true);
  });

  it("classifies missing provider breakpoint-shape telemetry as framework evidence work", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-shape-telemetry-task-8/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 8,
      runId: "unit-batch-shape-telemetry-task-8",
      status: "fail",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      providerCacheHitRate: 0.53,
      providerCacheRequestCount: 8,
      commandCount: 15,
      diagnostics: [
        {
          code: "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_TELEMETRY_MISSING",
          severity: "warn",
          message: "breakpoint-shape telemetry missing",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [8, 9],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-shape-telemetry",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const state = (batch?.taskStates as JsonObject[]).find((taskState) => taskState.taskNumber === 8);

    assert.equal(state?.primaryReasonCode, "CACHE_PROVIDER_BREAKPOINT_SHAPE_TELEMETRY_MISSING");
    assert.equal(state?.failureCategory, "cache-economics");
    assert.equal(state?.actionability, "framework-fix");
    assert.equal((state?.reasonCodes as string[]).includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
    assert.equal((state?.blockerIds as string[]).includes("agentic.blocker.121.provider-cache-breakpoint-shape-telemetry-missing"), true);
  });

  it("classifies unbounded provider history after framework gates as cache framework work", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-gate-history-task-8/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 8,
      runId: "unit-batch-gate-history-task-8",
      status: "fail",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      providerCacheHitRate: 0.64,
      providerCacheRequestCount: 12,
      commandCount: 18,
      diagnostics: [
        {
          code: "SWE_BENCH_PROVIDER_HISTORY_UNBOUNDED_AFTER_GATE",
          severity: "warn",
          message: "provider history grew after framework gate",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [8, 9],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-gate-history",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const state = (batch?.taskStates as JsonObject[]).find((taskState) => taskState.taskNumber === 8);

    assert.equal(state?.primaryReasonCode, "CACHE_PROVIDER_HISTORY_UNBOUNDED_AFTER_GATE");
    assert.equal(state?.failureCategory, "cache-economics");
    assert.equal(state?.actionability, "framework-fix");
    assert.equal((state?.reasonCodes as string[]).includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
    assert.equal((state?.blockerIds as string[]).includes("agentic.blocker.108.provider-history-unbounded-after-gate"), true);
  });

  it("projects legacy over-budget child request counts into request-budget blockers on resume", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-legacy-budget-task-3/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 3,
      runId: "unit-batch-legacy-budget-task-3",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      childTerminalReason: "swe-bench-environment-blocker",
      childModelRequestCount: 18,
      childIterationCount: 18,
      providerCacheHitRate: 0.78,
      providerCacheRequestCount: 12,
      commandCount: 24,
      diagnostics: [
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [3, 4],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-legacy-budget",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const state = (batch?.taskStates as JsonObject[]).find((taskState) => taskState.taskNumber === 3);

    assert.equal(state?.primaryReasonCode, "FLOW_REQUEST_BUDGET_EXCEEDED");
    assert.equal(state?.failureCategory, "flow-control");
    assert.equal(state?.actionability, "framework-fix");
    assert.equal((state?.blockerIds as string[]).includes("agentic.blocker.102.swe-bench-request-budget-exceeded"), true);
  });

  it("treats twelve child model requests as suspicious budget evidence on resume", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-budget-threshold-task-3/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 3,
      runId: "unit-batch-budget-threshold-task-3",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      childTerminalReason: "completed",
      childModelRequestCount: 12,
      childIterationCount: 12,
      providerCacheHitRate: 0.95,
      providerCacheRequestCount: 12,
      commandCount: 16,
      diagnostics: [
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [3, 4],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-budget-threshold",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const state = (batch?.taskStates as JsonObject[]).find((taskState) => taskState.taskNumber === 3);

    assert.equal(state?.primaryReasonCode, "FLOW_REQUEST_BUDGET_EXCEEDED");
    assert.equal(state?.failureCategory, "flow-control");
    assert.equal(state?.actionability, "framework-fix");
    assert.equal((state?.blockerIds as string[]).includes("agentic.blocker.102.swe-bench-request-budget-exceeded"), true);
    assert.equal(value.evidence?.preview?.text?.includes("taskReview=3:FLOW_REQUEST_BUDGET_EXCEEDED"), true);
  });

  it("uses source-inspection pressure before generic request-budget attribution on resume", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-source-inspection-budget-task-3/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 3,
      runId: "unit-batch-source-inspection-budget-task-3",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      childTerminalReason: "swe-bench-request-budget-exceeded",
      childModelRequestCount: 12,
      childIterationCount: 12,
      providerCacheHitRate: 0.95,
      providerCacheRequestCount: 12,
      commandCount: 16,
      diagnostics: [
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-source-inspection-budget-task-3/trace.jsonl", [
      ...Array.from({ length: 12 }, (_, index) => JSON.stringify({
        kind: "model.requested",
        data: { iteration: index + 1 }
      })),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-source-inspection-budget"
          },
          gate: "SWE_BENCH_SOURCE_INSPECTION_GATE",
          sourceInspectionToolCount: 10,
          sourceMutationCount: 0,
          shellCommandCount: 0,
          testCommandCount: 0,
          iterationCount: 10,
          toolCallCount: 10
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "model-iteration",
            consumed: 12,
            allowed: 12,
            remaining: 0,
            stopReason: "swe-bench-request-budget-exceeded"
          },
          gate: "SWE_BENCH_REQUEST_BUDGET_GATE",
          modelRequestCount: 12,
          toolCallCount: 12,
          sourceInspectionToolCount: 12,
          sourceMutationCount: 0,
          shellCommandCount: 0,
          testCommandCount: 0
        }
      }),
      ""
    ].join("\n"));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [3, 4],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-source-inspection-budget",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const state = (batch?.taskStates as JsonObject[]).find((taskState) => taskState.taskNumber === 3);

    assert.equal(state?.primaryReasonCode, "GATE_SOURCE_INSPECTION_PRESSURE");
    assert.equal(state?.failureCategory, "framework");
    assert.equal(state?.actionability, "framework-fix");
    assert.equal((state?.reasonCodes as string[] | undefined)?.includes("FLOW_REQUEST_BUDGET_EXCEEDED"), true);
    assert.equal((state?.blockerIds as string[] | undefined)?.includes("agentic.blocker.021.source-inspection-loop"), true);
    assert.equal((state?.blockerIds as string[] | undefined)?.includes("agentic.blocker.102.swe-bench-request-budget-exceeded"), true);
    assert.equal(value.evidence?.preview?.text?.includes("taskReview=3:GATE_SOURCE_INSPECTION_PRESSURE"), true);
  });

  it("uses source-inspection defiance before generic source-pressure attribution on resume", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-source-inspection-defiance-task-3/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 3,
      runId: "unit-batch-source-inspection-defiance-task-3",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      childTerminalReason: "swe-bench-source-inspection-defiance",
      childModelRequestCount: 10,
      childIterationCount: 10,
      providerCacheHitRate: 0.95,
      providerCacheRequestCount: 10,
      commandCount: 16,
      diagnostics: [
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-source-inspection-defiance-task-3/trace.jsonl", [
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-source-inspection-budget"
          },
          gate: "SWE_BENCH_SOURCE_INSPECTION_GATE",
          sourceInspectionToolCount: 8,
          sourceMutationCount: 0,
          shellCommandCount: 0,
          testCommandCount: 0,
          iterationCount: 8,
          toolCallCount: 8
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            consumed: 2,
            allowed: 2,
            remaining: 0,
            stopReason: "swe-bench-source-inspection-defiance"
          },
          gate: "SWE_BENCH_SOURCE_INSPECTION_DEFIANCE_GATE",
          sourceInspectionGate: "SWE_BENCH_SOURCE_INSPECTION_GATE",
          modelRequestCount: 10,
          toolCallCount: 10,
          defianceCount: 2,
          sourceInspectionToolCount: 10,
          sourceMutationCount: 0,
          shellCommandCount: 0,
          testCommandCount: 0
        }
      }),
      JSON.stringify({
        kind: "agent.loop.failed",
        data: {
          status: "rejected",
          reason: "swe-bench-source-inspection-defiance"
        }
      }),
      ""
    ].join("\n"));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [3, 4],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-source-inspection-defiance",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const state = (batch?.taskStates as JsonObject[]).find((taskState) => taskState.taskNumber === 3);

    assert.equal(state?.primaryReasonCode, "GATE_SOURCE_INSPECTION_DEFIANCE");
    assert.equal(state?.failureCategory, "framework");
    assert.equal(state?.actionability, "framework-fix");
    assert.equal((state?.reasonCodes as string[] | undefined)?.includes("GATE_SOURCE_INSPECTION_PRESSURE"), true);
    assert.equal((state?.reasonCodes as string[] | undefined)?.includes("FLOW_REQUEST_BUDGET_EXCEEDED"), false);
    assert.equal((state?.blockerIds as string[] | undefined)?.includes("agentic.blocker.021.source-inspection-loop"), true);
    assert.equal(value.evidence?.preview?.text?.includes("taskReview=3:GATE_SOURCE_INSPECTION_DEFIANCE"), true);
  });

  it("uses resumed child environment blocker gates before derived request-budget attribution", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-env-gate-task-3/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 3,
      runId: "unit-batch-env-gate-task-3",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      childTerminalReason: "swe-bench-environment-blocker",
      childModelRequestCount: 18,
      childIterationCount: 18,
      providerCacheHitRate: 0.92,
      providerCacheRequestCount: 18,
      commandCount: 24,
      diagnostics: [
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-env-gate-task-3/trace.jsonl", [
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-environment-blocker"
          },
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          modelRequestCount: 18,
          toolCallCount: 20,
          shellCommandCount: 10,
          postVerificationShellCommandCount: 2,
          testCommandCount: 2,
          sourceMutationCount: 1,
          iterationCount: 18
        }
      }),
      ""
    ].join("\n"));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [3, 4],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-env-gate",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const state = (batch?.taskStates as JsonObject[]).find((taskState) => taskState.taskNumber === 3);
    const persisted = JSON.parse(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-batch-env-gate-task-3/summary.json")) as JsonObject;

    assert.equal(state?.primaryReasonCode, "ENV_POST_VERIFICATION_BLOCKER");
    assert.equal(state?.failureCategory, "environment");
    assert.equal(state?.actionability, "environment-fix");
    assert.equal((state?.reasonCodes as string[]).includes("FLOW_REQUEST_BUDGET_EXCEEDED"), true);
    assert.equal((state?.blockerIds as string[]).includes("agentic.blocker.049.post-test-setup-loop"), true);
    assert.equal((persisted.diagnostics as JsonObject[]).some((entry) => entry.code === "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"), true);
    assert.equal(value.evidence?.preview?.text?.includes("taskReview=3:ENV_POST_VERIFICATION_BLOCKER"), true);
  });

  it("classifies missing provider prefix hints as immediately actionable framework work", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-cache-prefix-action-task-8/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 8,
      runId: "unit-batch-cache-prefix-action-task-8",
      status: "fail",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      providerCacheHitRate: 0.78,
      providerCacheRequestCount: 4,
      commandCount: 15,
      diagnostics: [
        {
          code: "SWE_BENCH_PROVIDER_CACHE_PREFIX_HINT_MISSING",
          severity: "warn",
          message: "prefix hint missing",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [8, 9],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-cache-prefix-action",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const state = (batch?.taskStates as JsonObject[]).find((taskState) => taskState.taskNumber === 8);

    assert.equal(state?.primaryReasonCode, "CACHE_PROVIDER_PREFIX_HINT_MISSING");
    assert.equal(state?.failureCategory, "cache-economics");
    assert.equal(state?.actionability, "framework-fix");
    assert.equal((state?.reasonCodes as string[]).includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
    assert.equal((state?.blockerIds as string[]).includes("agentic.blocker.104.provider-cache-prefix-hint-missing"), true);
  });

  it("classifies provider prefix drift and breakpoint shape misses as actionable framework work", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-cache-shape-action-task-8/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 8,
      runId: "unit-batch-cache-shape-action-task-8",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      providerCacheHitRate: 0.42,
      providerCacheRequestCount: 7,
      commandCount: 12,
      diagnostics: [
        {
          code: "SWE_BENCH_PROVIDER_CACHE_PREFIX_DRIFT",
          severity: "warn",
          message: "provider prefix drift",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_MISS",
          severity: "warn",
          message: "breakpoint shape miss",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [8, 9],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-cache-shape-action",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const state = (batch?.taskStates as JsonObject[]).find((taskState) => taskState.taskNumber === 8);
    const reasonCodes = state?.reasonCodes as string[];

    assert.equal(state?.primaryReasonCode, "CACHE_PROVIDER_PREFIX_DRIFT");
    assert.equal(reasonCodes.includes("CACHE_PROVIDER_PREFIX_DRIFT"), true);
    assert.equal(reasonCodes.includes("CACHE_PROVIDER_BREAKPOINT_SHAPE_MISS"), true);
    assert.equal((state?.blockerIds as string[]).includes("agentic.blocker.111.provider-cache-prefix-drift"), true);
    assert.equal((state?.blockerIds as string[]).includes("agentic.blocker.112.provider-cache-breakpoint-shape-miss"), true);
    assert.equal(reasonCodes.includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
  });

  it("does not keep satisfied post-edit verification gates primary after ready-for-harness", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-ready-cache-task-3/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 3,
      runId: "unit-batch-ready-cache-task-3",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      childTerminalKind: "agent.loop.completed",
      childTerminalReason: "swe-bench-ready-for-harness",
      childModelRequestCount: 12,
      childTestCommandCount: 2,
      providerCacheHitRate: 0.54,
      providerCacheRequestCount: 12,
      commandCount: 16,
      diagnostics: [
        {
          code: "SWE_BENCH_POST_EDIT_VERIFICATION_GATE",
          severity: "warn",
          message: "prior post-edit gate",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET",
          severity: "warn",
          message: "cache below target",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [3, 4],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-ready-cache",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const state = (batch?.taskStates as JsonObject[]).find((taskState) => taskState.taskNumber === 3);

    assert.equal(state?.primaryReasonCode, "CACHE_PROVIDER_BELOW_TARGET");
    assert.equal(state?.failureCategory, "cache-economics");
    assert.equal(state?.actionability, "framework-fix");
    assert.equal((state?.reasonCodes as string[]).includes("FLOW_POST_EDIT_VERIFICATION_MISSING"), false);
    assert.equal((state?.reasonCodes as string[]).includes("FLOW_REQUEST_BUDGET_EXCEEDED"), false);
    assert.equal((state?.reasonCodes as string[]).includes("VERIFICATION_ORACLE_GAP"), true);
    assert.equal((state?.reasonCodes as string[]).includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
    assert.equal((state?.blockerIds as string[]).includes("agentic.blocker.110.verification-oracle-gap"), true);
  });

  it("does not keep a stale post-edit gate primary after completed repair verification", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-completed-repair-cache/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 3,
      runId: "unit-single-completed-repair-cache",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      childTerminalKind: "agent.loop.completed",
      childModelRequestCount: 8,
      childTestCommandCount: 2,
      providerCacheHitRate: 0.2862029326828721,
      providerCacheRequestCount: 8,
      commandCount: 16,
      diagnostics: [
        {
          code: "SWE_BENCH_POST_EDIT_VERIFICATION_GATE",
          severity: "warn",
          message: "prior post-edit gate",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET",
          severity: "warn",
          message: "cache below target",
          redaction: { class: "internal" }
        },
        {
          code: "PROMPT_WHOLE_FINGERPRINT_DYNAMIC_WITH_STABLE_PREFIX",
          severity: "warn",
          message: "stable prefix dynamic tail",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 3,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-single-completed-repair-cache",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;

    assert.equal(metadata?.primaryReasonCode, "CACHE_PROVIDER_BELOW_TARGET");
    assert.equal(metadata?.failureCategory, "cache-economics");
    assert.equal(metadata?.actionability, "framework-fix");
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("FLOW_POST_EDIT_VERIFICATION_MISSING"), false);
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("FLOW_REQUEST_BUDGET_EXCEEDED"), false);
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("CACHE_WHOLE_PROMPT_DYNAMIC_PREFIX_STABLE"), true);
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("VERIFICATION_ORACLE_GAP"), true);
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
    assert.equal(value.evidence?.preview?.text?.includes("failure=CACHE_PROVIDER_BELOW_TARGET action=framework-fix"), true);
  });

  it("refreshes a single existing task summary when resumeOnly is requested", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-ready-cache/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 3,
      runId: "unit-single-ready-cache",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      childTerminalKind: "agent.loop.completed",
      childTerminalReason: "swe-bench-ready-for-harness",
      childModelRequestCount: 12,
      childTestCommandCount: 1,
      providerCacheHitRate: 0.41,
      providerCacheRequestCount: 12,
      commandCount: 16,
      diagnostics: [
        {
          code: "SWE_BENCH_POST_EDIT_VERIFICATION_GATE",
          severity: "warn",
          message: "prior post-edit gate",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET",
          severity: "warn",
          message: "cache below target",
          redaction: { class: "internal" }
        },
        {
          code: "PROMPT_WHOLE_FINGERPRINT_DYNAMIC_WITH_STABLE_PREFIX",
          severity: "warn",
          message: "stable prefix dynamic tail",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      reasonCodes: [
        "FLOW_REQUEST_BUDGET_EXCEEDED",
        "CACHE_PROVIDER_BELOW_TARGET",
        "CACHE_WHOLE_PROMPT_DYNAMIC_PREFIX_STABLE",
        "OFFICIAL_UNRESOLVED_AFTER_REPAIR",
        "FLOW_POST_EDIT_VERIFICATION_MISSING"
      ],
      primaryReasonCode: "FLOW_REQUEST_BUDGET_EXCEEDED",
      failureCategory: "flow-control",
      actionability: "framework-fix",
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 3,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-single-ready-cache",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;
    const persisted = JSON.parse(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-single-ready-cache/summary.json")) as JsonObject;

    assert.deepEqual(platform.datasetRequests, []);
    assert.equal(platform.executedCommands.filter(isAgentRunCommand).length, 0);
    assert.equal(metadata?.primaryReasonCode, "CACHE_PROVIDER_BELOW_TARGET");
    assert.equal(metadata?.failureCategory, "cache-economics");
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("FLOW_REQUEST_BUDGET_EXCEEDED"), false);
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("VERIFICATION_ORACLE_GAP"), true);
    assert.equal(persisted.primaryReasonCode, "CACHE_PROVIDER_BELOW_TARGET");
    assert.equal(value.evidence?.preview?.text?.includes("failure=CACHE_PROVIDER_BELOW_TARGET action=framework-fix"), true);
  });

  it("reconstructs provider cache below-target diagnostics while refreshing single task traces", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-cache-refresh/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 3,
      runId: "unit-single-cache-refresh",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      childTerminalKind: "agent.loop.completed",
      childTerminalReason: "swe-bench-ready-for-harness",
      childModelRequestCount: 12,
      childTestCommandCount: 1,
      commandCount: 16,
      diagnostics: [
        {
          code: "SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET",
          severity: "warn",
          message: "stale cache below target",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-cache-refresh/trace.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:1",
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
            selectedHistoryMessageCount: 14,
            historyMessageCount: 0,
            toolCallLinkage: { assistantToolCallCount: 0, toolResultCount: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 1000,
          metadata: {
            cache: {
              hitTokens: 400,
              missTokens: 600,
              hitRate: 0.4,
              pipelineFingerprint: "pipeline:test"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.completed",
        data: {
          status: "completed",
          reason: "swe-bench-ready-for-harness",
          iterations: 12
        }
      }),
      ""
    ].join("\n"));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 3,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-single-cache-refresh",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const metadata = value.evidence?.metadata;
    const persisted = JSON.parse(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-single-cache-refresh/summary.json")) as JsonObject;

    assert.equal(metadata?.providerCacheHitRate, 0.4);
    assert.equal((metadata?.reviewCodes as string[] | undefined)?.includes("SWE_BENCH_EVALUATION_UNRESOLVED"), true);
    assert.equal((metadata?.reviewCodes as string[] | undefined)?.includes("SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET"), true);
    assert.equal((metadata?.diagnostics as JsonObject[]).some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET"), true);
    assert.equal(metadata?.primaryReasonCode, "CACHE_PROVIDER_BELOW_TARGET");
    assert.equal((persisted.diagnostics as JsonObject[]).some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET"), true);
  });

  it("removes stale cache-shape diagnostics when refreshed single task traces no longer support them", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-cache-stale-refresh/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 3,
      runId: "unit-single-cache-stale-refresh",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      childTerminalKind: "agent.loop.completed",
      childTerminalReason: "swe-bench-ready-for-harness",
      childModelRequestCount: 12,
      childTestCommandCount: 1,
      commandCount: 16,
      diagnostics: [
        {
          code: "SWE_BENCH_PROVIDER_CACHE_PREFIX_DRIFT",
          severity: "warn",
          message: "stale provider prefix drift",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_MISS",
          severity: "warn",
          message: "stale breakpoint shape miss",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_PROVIDER_TOOL_SCHEMA_CACHE_GAP",
          severity: "warn",
          message: "stale tool schema cache gap",
          redaction: { class: "internal" }
        },
        {
          code: "PROMPT_WHOLE_FINGERPRINT_DYNAMIC_WITH_STABLE_PREFIX",
          severity: "warn",
          message: "stale whole prompt churn",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-cache-stale-refresh/trace.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:stable",
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
          contextPipeline: { pipelineFingerprint: "pipeline:fresh" },
          providerRequestReplay: {
            selectedHistoryMessageCount: 4,
            historyMessageCount: 4,
            toolCallLinkage: { assistantToolCallCount: 0, toolResultCount: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 1000,
          metadata: {
            cache: {
              hitTokens: 400,
              missTokens: 600,
              hitRate: 0.4,
              pipelineFingerprint: "pipeline:fresh"
            }
          }
        }
      }),
      ""
    ].join("\n"));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 3,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-single-cache-stale-refresh",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const metadata = value.evidence?.metadata;
    const persisted = JSON.parse(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-single-cache-stale-refresh/summary.json")) as JsonObject;
    const diagnostics = metadata?.diagnostics as JsonObject[];
    const reviewCodes = metadata?.reviewCodes as string[];
    const reasonCodes = metadata?.reasonCodes as string[];
    const persistedDiagnostics = persisted.diagnostics as JsonObject[];

    assert.equal(diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_DRIFT"), false);
    assert.equal(diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_MISS"), false);
    assert.equal(diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_TOOL_SCHEMA_CACHE_GAP"), false);
    assert.equal(diagnostics.some((entry) => entry.code === "PROMPT_WHOLE_FINGERPRINT_DYNAMIC_WITH_STABLE_PREFIX"), false);
    assert.equal(reviewCodes.includes("SWE_BENCH_PROVIDER_CACHE_PREFIX_DRIFT"), false);
    assert.equal(reasonCodes.includes("CACHE_PROVIDER_PREFIX_DRIFT"), false);
    assert.equal(metadata?.primaryReasonCode, "CACHE_PROVIDER_BELOW_TARGET");
    assert.equal(persistedDiagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_DRIFT"), false);
    assert.equal(persisted.primaryReasonCode, "CACHE_PROVIDER_BELOW_TARGET");
  });

  it("enriches legacy missing-pytest traces with repo-local runner evidence during resumeOnly refresh", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-legacy-pytest-runner/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 8,
      runId: "unit-single-legacy-pytest-runner",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      attemptCount: 1,
      evaluationStatus: "warn",
      evaluationResolved: false,
      diagnostics: [],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-legacy-pytest-runner/repo/tests/runtests.py", "#!/usr/bin/env python\n");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-legacy-pytest-runner/trace.jsonl", [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.shell.run",
          input: {
            command: "python -m pytest tests/invalid_models_tests/test_ordinary_fields.py::FilePathFieldTests -xvs 2>&1 | tail -30"
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.shell.run",
          result: "Tool core.shell.run reported failed:\n/workspace/repo/.venv/bin/python: No module named pytest",
          evidence: {
            status: "failed",
            metadata: { exitCode: 1 }
          },
          feedback: { status: "failed" }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-environment-blocker"
          },
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          sourceMutationCount: 1,
          shellCommandCount: 1,
          testCommandCount: 1
        }
      }),
      ""
    ].join("\n"));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 8,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-single-legacy-pytest-runner",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;
    const persisted = JSON.parse(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-single-legacy-pytest-runner/summary.json")) as JsonObject;
    const dependencyDiagnostic = (metadata?.diagnostics as JsonObject[] | undefined)?.find((entry) => entry.code === "SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING");
    const testFailureDetails = dependencyDiagnostic?.metadata && typeof dependencyDiagnostic.metadata === "object"
      ? (dependencyDiagnostic.metadata as JsonObject).testFailureDetails as JsonObject[] | undefined
      : undefined;

    assert.equal(metadata?.primaryReasonCode, "VERIFICATION_REPO_LOCAL_RUNNER_AVAILABLE");
    assert.equal(metadata?.failureCategory, "verification");
    assert.equal(metadata?.actionability, "verification-fix");
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("ENV_TEST_DEPENDENCY_MISSING"), true);
    assert.equal(testFailureDetails?.some((detail) => detail.alternateCommand === "python tests/runtests.py" && detail.alternateRunnerPath === "tests/runtests.py" && detail.suggestedCommand === "python tests/runtests.py"), true);
    assert.equal(persisted.primaryReasonCode, "VERIFICATION_REPO_LOCAL_RUNNER_AVAILABLE");
    assert.equal(value.evidence?.preview?.text?.includes("failure=VERIFICATION_REPO_LOCAL_RUNNER_AVAILABLE action=verification-fix"), true);
  });

  it("enriches legacy missing Python test launcher traces with repo-local runner evidence during resumeOnly refresh", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-legacy-launcher-runner/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 8,
      runId: "unit-single-legacy-launcher-runner",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      attemptCount: 1,
      evaluationStatus: "warn",
      evaluationResolved: false,
      diagnostics: [],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-legacy-launcher-runner/repo/tests/runtests.py", "#!/usr/bin/env python\n");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-legacy-launcher-runner/trace.jsonl", [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.shell.run",
          input: {
            command: "python -m nose tests/test_demo.py"
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.shell.run",
          result: "Tool core.shell.run reported failed:\n/workspace/repo/.venv/bin/python: No module named nose",
          evidence: {
            status: "failed",
            metadata: { exitCode: 1 }
          },
          feedback: { status: "failed" }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-environment-blocker"
          },
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          sourceMutationCount: 1,
          shellCommandCount: 1,
          testCommandCount: 1
        }
      }),
      ""
    ].join("\n"));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 8,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-single-legacy-launcher-runner",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const metadata = value.evidence?.metadata;
    const persisted = JSON.parse(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-single-legacy-launcher-runner/summary.json")) as JsonObject;
    const dependencyDiagnostic = (metadata?.diagnostics as JsonObject[] | undefined)?.find((entry) => entry.code === "SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING");
    const testFailureDetails = dependencyDiagnostic?.metadata && typeof dependencyDiagnostic.metadata === "object"
      ? (dependencyDiagnostic.metadata as JsonObject).testFailureDetails as JsonObject[] | undefined
      : undefined;

    assert.equal(metadata?.primaryReasonCode, "VERIFICATION_REPO_LOCAL_RUNNER_AVAILABLE");
    assert.equal(testFailureDetails?.some((detail) => detail.moduleName === "nose" && detail.alternateCommand === "python tests/runtests.py" && detail.suggestedCommand === "python tests/runtests.py"), true);
    assert.equal(testFailureDetails?.some((detail) => detail.moduleName === "nose" && detail.suggestedCommand === "python -m pip install nose"), false);
    assert.equal(persisted.primaryReasonCode, "VERIFICATION_REPO_LOCAL_RUNNER_AVAILABLE");
  });

  it("removes stale Python setup blockers when refreshed traces show later successful tests", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-stale-python-setup-refresh/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 3,
      runId: "unit-single-stale-python-setup-refresh",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      childTerminalKind: "agent.loop.budget.consumed",
      childTerminalReason: "swe-bench-environment-blocker",
      childTestCommandCount: 2,
      childSuccessfulTestCommandCount: 0,
      providerCacheHitRate: 0.41,
      providerCacheRequestCount: 2,
      commandCount: 16,
      diagnostics: [
        {
          code: "SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING",
          severity: "warn",
          message: "stale Python dependency failure",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          severity: "warn",
          message: "stale environment blocker gate",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      reasonCodes: [
        "ENV_TEST_DEPENDENCY_MISSING",
        "ENV_POST_VERIFICATION_BLOCKER",
        "OFFICIAL_UNRESOLVED_AFTER_REPAIR"
      ],
      primaryReasonCode: "ENV_TEST_DEPENDENCY_MISSING",
      failureCategory: "environment",
      actionability: "environment-fix",
      blockerIds: [
        "agentic.blocker.119.test-env-dependency-missing",
        "agentic.blocker.049.post-test-setup-loop"
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-stale-python-setup-refresh/trace.jsonl", [
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole:stable",
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
            selectedHistoryMessageCount: 14,
            historyMessageCount: 0,
            toolCallLinkage: { assistantToolCallCount: 0, toolResultCount: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 1000,
          metadata: {
            cache: {
              hitTokens: 400,
              missTokens: 600,
              hitRate: 0.4,
              pipelineFingerprint: "pipeline:test"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-missing-dep",
          name: "core.test.run",
          input: {
            command: "python",
            args: ["-m", "django", "test", "forms_tests.tests.test_media"]
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-missing-dep",
          toolName: "core.test.run",
          result: [
            "Tool core.test.run reported failed:",
            "PYTHON_TEST_DEPENDENCY_MISSING: Python test environment is missing module 'forms_tests'."
          ].join("\n"),
          evidence: {
            status: "failed",
            metadata: { exitCode: 1 }
          }
        }
      }),
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-focused-test",
          name: "core.shell.run",
          input: {
            command: "python tests/runtests.py forms_tests.tests.test_media -v 2"
          },
          iteration: 2
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-focused-test",
          toolName: "core.shell.run",
          result: "Ran 17 tests in 0.012s\n\nOK",
          evidence: {
            status: "success",
            metadata: { exitCode: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-environment-blocker"
          },
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          sourceMutationCount: 1,
          shellCommandCount: 2,
          testCommandCount: 2,
          successfulTestCommandCount: 1
        }
      }),
      ""
    ].join("\n"));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 3,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-single-stale-python-setup-refresh",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const metadata = value.evidence?.metadata;
    const persisted = JSON.parse(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-single-stale-python-setup-refresh/summary.json")) as JsonObject;
    const diagnostics = metadata?.diagnostics as JsonObject[];
    const persistedDiagnostics = persisted.diagnostics as JsonObject[];
    const reviewCodes = metadata?.reviewCodes as string[];
    const reasonCodes = metadata?.reasonCodes as string[];
    const blockerIds = metadata?.blockerIds as string[];

    assert.equal(metadata?.childSuccessfulTestCommandCount, 1);
    assert.equal(diagnostics.some((entry) => entry.code === "SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING"), false);
    assert.equal(diagnostics.some((entry) => entry.code === "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"), false);
    assert.equal(persistedDiagnostics.some((entry) => entry.code === "SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING"), false);
    assert.equal(persistedDiagnostics.some((entry) => entry.code === "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"), false);
    assert.equal(reviewCodes.includes("SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING"), false);
    assert.equal(reviewCodes.includes("SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"), false);
    assert.equal(reasonCodes.includes("ENV_TEST_DEPENDENCY_MISSING"), false);
    assert.equal(reasonCodes.includes("ENV_POST_VERIFICATION_BLOCKER"), false);
    assert.equal(blockerIds.includes("agentic.blocker.119.test-env-dependency-missing"), false);
    assert.equal(blockerIds.includes("agentic.blocker.049.post-test-setup-loop"), false);
    assert.equal(metadata?.primaryReasonCode, "CACHE_PROVIDER_BELOW_TARGET");
    assert.equal(persisted.primaryReasonCode, "CACHE_PROVIDER_BELOW_TARGET");
  });

  it("replaces stale breakpoint-shape misses with telemetry-missing evidence during resumeOnly refresh", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-cache-telemetry-refresh/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 3,
      runId: "unit-single-cache-telemetry-refresh",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      childTerminalKind: "agent.loop.completed",
      childTerminalReason: "swe-bench-ready-for-harness",
      childModelRequestCount: 12,
      childTestCommandCount: 1,
      commandCount: 16,
      diagnostics: [
        {
          code: "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_MISS",
          severity: "warn",
          message: "stale breakpoint shape miss",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      reasonCodes: [
        "CACHE_PROVIDER_BREAKPOINT_SHAPE_MISS",
        "OFFICIAL_UNRESOLVED_AFTER_REPAIR"
      ],
      primaryReasonCode: "CACHE_PROVIDER_BREAKPOINT_SHAPE_MISS",
      failureCategory: "cache-economics",
      actionability: "framework-fix",
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-cache-telemetry-refresh/trace.jsonl", [
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
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 3,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-single-cache-telemetry-refresh",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const metadata = value.evidence?.metadata;
    const persisted = JSON.parse(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-single-cache-telemetry-refresh/summary.json")) as JsonObject;
    const diagnostics = metadata?.diagnostics as JsonObject[];
    const reasonCodes = metadata?.reasonCodes as string[];
    const blockerIds = metadata?.blockerIds as string[];
    const persistedDiagnostics = persisted.diagnostics as JsonObject[];

    assert.equal(diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_MISS"), false);
    assert.equal(diagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_TELEMETRY_MISSING"), true);
    assert.equal(reasonCodes.includes("CACHE_PROVIDER_BREAKPOINT_SHAPE_MISS"), false);
    assert.equal(reasonCodes.includes("CACHE_PROVIDER_BREAKPOINT_SHAPE_TELEMETRY_MISSING"), true);
    assert.equal(blockerIds.includes("agentic.blocker.112.provider-cache-breakpoint-shape-miss"), false);
    assert.equal(blockerIds.includes("agentic.blocker.121.provider-cache-breakpoint-shape-telemetry-missing"), true);
    assert.equal(metadata?.primaryReasonCode, "CACHE_PROVIDER_BELOW_TARGET");
    assert.equal(persistedDiagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_MISS"), false);
    assert.equal(persistedDiagnostics.some((entry) => entry.code === "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_TELEMETRY_MISSING"), true);
  });

  it("maps whole-prompt churn with stable prefixes into cache reason attribution", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-batch-whole-prompt-task-8/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 8,
      runId: "unit-batch-whole-prompt-task-8",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      commandCount: 10,
      diagnostics: [
        {
          code: "PROMPT_WHOLE_FINGERPRINT_DYNAMIC_WITH_STABLE_PREFIX",
          severity: "warn",
          message: "whole prompt dynamic",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal" }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumbers: [8, 9],
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-batch-whole-prompt",
      resume: true,
      resumeOnly: true
    }, capabilityContext());

    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const batch = value.evidence?.metadata?.batch as JsonObject | undefined;
    const state = (batch?.taskStates as JsonObject[] | undefined)?.[0];

    assert.equal(execution.ok, true);
    assert.equal(state?.primaryReasonCode, "CACHE_WHOLE_PROMPT_DYNAMIC_PREFIX_STABLE");
    assert.equal((state?.reasonCodes as string[] | undefined)?.includes("CACHE_WHOLE_PROMPT_DYNAMIC_PREFIX_STABLE"), true);
    assert.equal((state?.blockerIds as string[]).includes("agentic.blocker.107.whole-prompt-dynamic-prefix-stable"), true);
  });

  it("returns structured failed evidence instead of executor failure when harness report output is missing", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.skipHarnessReportWrite = true;
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-run-stale/harness/logs/run_evaluation/unit-run-stale-evaluation/glm-5.1/demo__repo-2/report.json", JSON.stringify({
      "demo__repo-2": {
        resolved: false,
        tests_status: {
          FAIL_TO_PASS: { success: [], failure: ["tests/test_demo.py::test_expected_fix"] },
          PASS_TO_PASS: { success: ["tests/test_demo.py::test_existing"], failure: [] }
        }
      }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-stale"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { status?: string; preview?: { text?: string }; metadata?: JsonObject } };
    const metadata = value.evidence?.metadata;
    const diagnostics = Array.isArray(metadata?.diagnostics) ? metadata.diagnostics as JsonObject[] : [];

    assert.equal(value.evidence?.status, "failed");
    assert.equal(metadata?.status, "fail");
    assert.equal(metadata?.evaluationStatus, "fail");
    assert.equal(diagnostics.some((entry) => entry.code === "SWE_BENCH_REPORT_STAT_FAILED" || entry.code === "SWE_BENCH_REPORT_READ_FAILED"), true);
    assert.equal(value.evidence?.preview?.text?.includes("evaluation=fail resolved=unknown rate=unknown"), true);
  });

  it("keeps child request budget primary when an empty patch causes missing harness report diagnostics", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.skipHarnessReportWrite = true;
    platform.agentStdout = [
      ...Array.from({ length: 12 }, (_, index) => JSON.stringify({
        kind: "model.requested",
        data: { iteration: index + 1 }
      })),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "model-iteration",
            consumed: 12,
            allowed: 12,
            remaining: 0,
            stopReason: "swe-bench-request-budget-exceeded"
          },
          gate: "SWE_BENCH_REQUEST_BUDGET_GATE",
          modelRequestCount: 12,
          toolCallCount: 12,
          sourceInspectionToolCount: 11,
          sourceMutationCount: 0,
          shellCommandCount: 0,
          testCommandCount: 0
        }
      }),
      ""
    ].join("\n");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-budget-empty-patch"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;
    const reasonCodes = metadata?.reasonCodes as string[] | undefined;

    assert.equal(metadata?.childTerminalReason, "swe-bench-request-budget-exceeded");
    assert.equal(metadata?.childModelRequestCount, 12);
    assert.equal(metadata?.primaryReasonCode, "FLOW_REQUEST_BUDGET_EXCEEDED");
    assert.equal(metadata?.failureCategory, "flow-control");
    assert.equal(metadata?.actionability, "framework-fix");
    assert.equal(reasonCodes?.includes("HARNESS_INSTANCE_REPORT_MISSING"), true);
    assert.equal(reasonCodes?.includes("FLOW_REQUEST_BUDGET_EXCEEDED"), true);
    assert.equal(value.evidence?.preview?.text?.includes("failure=FLOW_REQUEST_BUDGET_EXCEEDED action=framework-fix"), true);
  });

  it("classifies official empty-patch harness skips without treating them as missing reports", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-empty-patch/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 2,
      runId: "unit-single-empty-patch",
      status: "fail",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "fail",
      evaluationResolved: false,
      patchBytes: 0,
      attemptCount: 1,
      commandCount: 12,
      diagnostics: [
        {
          code: "SWE_BENCH_HARNESS_EMPTY_PATCH",
          severity: "error",
          message: "official harness skipped empty patch",
          redaction: { class: "internal" }
        },
        {
          code: "SWE_BENCH_EMPTY_PATCH",
          severity: "warn",
          message: "prediction patch was empty",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-single-empty-patch",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;
    const reasonCodes = metadata?.reasonCodes as string[] | undefined;

    assert.equal(metadata?.primaryReasonCode, "PREDICTION_EMPTY_PATCH");
    assert.equal(metadata?.failureCategory, "prediction-output");
    assert.equal(metadata?.actionability, "framework-fix");
    assert.equal(reasonCodes?.includes("PREDICTION_EMPTY_PATCH"), true);
    assert.equal(reasonCodes?.includes("HARNESS_INSTANCE_REPORT_MISSING"), false);
    assert.equal(reasonCodes?.includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
    assert.equal(value.evidence?.preview?.text?.includes("failure=PREDICTION_EMPTY_PATCH action=framework-fix"), true);
  });

  it("uses unique official harness run ids across repeated executions of the same run root", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    for (let run = 0; run < 2; run += 1) {
      const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
        taskNumber: 2,
        provider: "glm",
        model: "glm-5.1",
        runId: "unit-run-repeat"
      }, capabilityContext());
      assert.equal(execution.ok, true);
    }

    const harnessRunIds = platform.executedCommands
      .filter((entry) => entry.args.includes("swebench.harness.run_evaluation"))
      .map((entry) => argAfter(entry.args, "--run_id"));

    assert.equal(harnessRunIds.length >= 2, true);
    assert.equal(new Set(harnessRunIds).size, harnessRunIds.length);
  });

  it("surfaces child trace verification gaps in capability evidence", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.agentStdout = [
      JSON.stringify({ kind: "model.requested", data: { iteration: 1 } }),
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          name: "core.shell.run",
          input: { command: "python -c \"print('probe only')\"" },
          iteration: 1
        }
      }),
      JSON.stringify({ kind: "agent.loop.completed", data: { status: "completed" } }),
      ""
    ].join("\n");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-verification-gap"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { status?: string; preview?: { text?: string }; metadata?: JsonObject } };
    const metadata = value.evidence?.metadata;
    const diagnostics = Array.isArray(metadata?.diagnostics) ? metadata.diagnostics as JsonObject[] : [];
    const verificationDiagnostic = diagnostics.find((entry) => entry.code === "SWE_BENCH_CHILD_TRACE_VERIFICATION_MISSING");

    assert.equal(value.evidence?.status, "failed");
    assert.equal(metadata?.childShellCommandCount, 1);
    assert.equal(metadata?.childTestCommandCount, 0);
    assert.equal(metadata?.verificationCommandMissing, true);
    assert.equal(verificationDiagnostic?.metadata && (verificationDiagnostic.metadata as JsonObject).shellCommandCount, 1);
    assert.equal(value.evidence?.preview?.text?.includes("shell=1 tests=0 successfulTests=0 verification=missing"), true);
  });

  it("classifies model iteration limit ahead of cache misses when the child flow runs away", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.agentStdout = [
      JSON.stringify({ kind: "prompt.assembled", data: { trace: { replay: { sectionOrderFingerprint: "sections:stable", budgetFingerprint: "budget:stable", toolPlanFingerprint: "tools:stable" } } } }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          iteration: 1,
          contextPipeline: { pipelineFingerprint: "pipeline:stable" },
          providerRequestReplay: {
            selectedHistoryMessageCount: 8,
            historyMessageCount: 8,
            toolCallLinkage: { assistantToolCallCount: 1, toolResultCount: 1 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 1_000,
          metadata: {
            cache: {
              hitTokens: 200,
              missTokens: 800,
              hitRate: 0.2,
              explicitPrefixCacheHint: { status: "unsupported" }
            }
          }
        }
      }),
      JSON.stringify({ kind: "prompt.assembled", data: { trace: { replay: { sectionOrderFingerprint: "sections:stable", budgetFingerprint: "budget:stable", toolPlanFingerprint: "tools:stable" } } } }),
      JSON.stringify({ kind: "agent.loop.failed", data: { status: "rejected", reason: "model-iteration-limit", iterations: 48, toolCalls: 48 } }),
      ""
    ].join("\n");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-flow-limit"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;

    assert.equal(metadata?.childTerminalReason, "model-iteration-limit");
    assert.equal(metadata?.childIterationCount, 48);
    assert.equal(metadata?.primaryReasonCode, "FLOW_MODEL_ITERATION_LIMIT");
    assert.equal(metadata?.failureCategory, "flow-control");
    assert.equal(metadata?.actionability, "framework-fix");
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("CACHE_PROVIDER_PREFIX_HINT_UNSUPPORTED"), true);
    assert.equal((metadata?.blockerIds as string[] | undefined)?.includes("agentic.blocker.105.provider-cache-prefix-hint-unsupported"), true);
    assert.equal(value.evidence?.preview?.text?.includes("failure=FLOW_MODEL_ITERATION_LIMIT action=framework-fix"), true);
  });

  it("classifies SWE-bench request budget terminal failures ahead of model patch feedback", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.agentStdout = [
      ...Array.from({ length: 12 }, (_, index) => JSON.stringify({
        kind: "model.requested",
        data: { iteration: index + 1 }
      })),
      JSON.stringify({
        kind: "agent.loop.failed",
        data: {
          status: "rejected",
          reason: "swe-bench-request-budget-exceeded",
          iterations: 12,
          toolCalls: 12
        }
      }),
      ""
    ].join("\n");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-request-budget"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;

    assert.equal(metadata?.childTerminalReason, "swe-bench-request-budget-exceeded");
    assert.equal(metadata?.childIterationCount, 12);
    assert.equal(metadata?.childModelRequestCount, 12);
    assert.equal(metadata?.primaryReasonCode, "FLOW_REQUEST_BUDGET_EXCEEDED");
    assert.equal(metadata?.failureCategory, "flow-control");
    assert.equal(metadata?.actionability, "framework-fix");
    assert.equal((metadata?.blockerIds as string[] | undefined)?.includes("agentic.blocker.102.swe-bench-request-budget-exceeded"), true);
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
    assert.equal(value.evidence?.preview?.text?.includes("failure=FLOW_REQUEST_BUDGET_EXCEEDED action=framework-fix"), true);
  });

  it("classifies managed request-budget events from repaired child traces", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.agentStdout = [
      ...Array.from({ length: 12 }, (_, index) => JSON.stringify({
        kind: "model.requested",
        data: { iteration: index + 1 }
      })),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "model-iteration",
            consumed: 12,
            allowed: 12,
            remaining: 0,
            stopReason: "swe-bench-request-budget-exceeded"
          },
          gate: "SWE_BENCH_REQUEST_BUDGET_GATE",
          modelRequestCount: 12,
          toolCallCount: 13,
          sourceInspectionToolCount: 12,
          sourceMutationCount: 1,
          shellCommandCount: 0,
          testCommandCount: 0
        }
      }),
      JSON.stringify({ kind: "agent.repair.stopped", data: { stopReason: "completed" } }),
      ""
    ].join("\n");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-budget-consumed"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;

    assert.equal(metadata?.childTerminalKind, "agent.loop.budget.consumed");
    assert.equal(metadata?.childTerminalReason, "swe-bench-request-budget-exceeded");
    assert.equal(metadata?.childModelRequestCount, 12);
    assert.equal(metadata?.childToolIntentCount, 13);
    assert.equal(metadata?.childTestCommandCount, 0);
    assert.equal(metadata?.primaryReasonCode, "FLOW_REQUEST_BUDGET_EXCEEDED");
    assert.equal((metadata?.blockerIds as string[] | undefined)?.includes("agentic.blocker.102.swe-bench-request-budget-exceeded"), true);
    assert.equal(value.evidence?.preview?.text?.includes("childTrace terminal=swe-bench-request-budget-exceeded"), true);
  });

  it("keeps request budget as primary when a prior post-edit gate was later satisfied by tests", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.agentStdout = [
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-post-edit-test-command-missing"
          },
          gate: "SWE_BENCH_POST_EDIT_VERIFICATION_GATE",
          sourceInspectionToolCount: 9,
          sourceMutationCount: 1,
          shellCommandCount: 0,
          testCommandCount: 0
        }
      }),
      ...Array.from({ length: 12 }, (_, index) => JSON.stringify({
        kind: "model.requested",
        data: { iteration: index + 1 }
      })),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "model-iteration",
            consumed: 12,
            allowed: 12,
            remaining: 0,
            stopReason: "swe-bench-request-budget-exceeded"
          },
          gate: "SWE_BENCH_REQUEST_BUDGET_GATE",
          modelRequestCount: 12,
          toolCallCount: 13,
          sourceInspectionToolCount: 9,
          sourceMutationCount: 1,
          shellCommandCount: 0,
          testCommandCount: 2
        }
      }),
      ""
    ].join("\n");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-request-budget-after-post-edit-gate"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;

    assert.equal(metadata?.childTerminalReason, "swe-bench-request-budget-exceeded");
    assert.equal(metadata?.childTestCommandCount, 2);
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("FLOW_POST_EDIT_VERIFICATION_MISSING"), false);
    assert.equal(metadata?.primaryReasonCode, "FLOW_REQUEST_BUDGET_EXCEEDED");
    assert.equal(metadata?.failureCategory, "flow-control");
    assert.equal(metadata?.actionability, "framework-fix");
    assert.equal(value.evidence?.preview?.text?.includes("failure=FLOW_REQUEST_BUDGET_EXCEEDED action=framework-fix"), true);
  });

  it("classifies missing ready-for-harness return ahead of request budget after successful tests", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.agentStdout = [
      ...Array.from({ length: 12 }, (_, index) => JSON.stringify({
        kind: "model.requested",
        data: { iteration: index + 1 }
      })),
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-edit",
          name: "core.file.edit",
          input: { path: "src/example.py", expected: "old", replacement: "new" },
          iteration: 4
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-edit",
          toolName: "core.file.edit",
          terminalKind: "capability.completed",
          feedback: { status: "success" },
          result: "edited"
        }
      }),
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.test.run",
          input: { command: "python", args: ["tests/runtests.py", "forms_tests.tests.test_media", "-v", "2"] },
          iteration: 9
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.test.run",
          terminalKind: "capability.completed",
          feedback: { status: "success" },
          result: "Ran 17 tests in 0.012s\n\nOK",
          evidence: {
            status: "success",
            metadata: { exitCode: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-environment-blocker"
          },
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          modelRequestCount: 12,
          toolCallCount: 12,
          sourceMutationCount: 1,
          testCommandCount: 1,
          shellCommandCount: 1
        }
      }),
      ""
    ].join("\n");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-ready-gate-missing-after-success"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;
    const reasonCodes = metadata?.reasonCodes as string[] | undefined;

    assert.equal(metadata?.childSuccessfulTestCommandCount, 1);
    assert.equal(reasonCodes?.includes("FLOW_READY_FOR_HARNESS_GATE_MISSING"), true);
    assert.equal(reasonCodes?.includes("FLOW_REQUEST_BUDGET_EXCEEDED"), false);
    assert.equal(metadata?.primaryReasonCode, "FLOW_READY_FOR_HARNESS_GATE_MISSING");
    assert.equal(metadata?.failureCategory, "flow-control");
    assert.equal(metadata?.actionability, "framework-fix");
    assert.equal((metadata?.blockerIds as string[] | undefined)?.includes("agentic.blocker.124.ready-for-harness-gate-missing"), true);
    assert.equal(value.evidence?.preview?.text?.includes("failure=FLOW_READY_FOR_HARNESS_GATE_MISSING action=framework-fix"), true);
  });

  it("classifies post-edit verification gates as framework flow work", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.agentStdout = [
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-post-edit-test-command-missing"
          },
          gate: "SWE_BENCH_POST_EDIT_VERIFICATION_GATE",
          sourceInspectionToolCount: 8,
          sourceMutationCount: 1,
          shellCommandCount: 0,
          testCommandCount: 0
        }
      }),
      JSON.stringify({ kind: "agent.loop.completed", data: { status: "completed" } }),
      ""
    ].join("\n");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-post-edit-gate"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;

    assert.equal(metadata?.primaryReasonCode, "FLOW_POST_EDIT_VERIFICATION_MISSING");
    assert.equal(metadata?.failureCategory, "flow-control");
    assert.equal(metadata?.actionability, "framework-fix");
    assert.equal((metadata?.blockerIds as string[] | undefined)?.includes("agentic.blocker.106.post-edit-verification-missing"), true);
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
  });

  it("classifies child pytest dependency API mismatches as environment work before model blame", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
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
          budget: {
            kind: "verification",
            stopReason: "swe-bench-environment-blocker"
          },
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          sourceMutationCount: 1,
          shellCommandCount: 0,
          testCommandCount: 1
        }
      }),
      ""
    ].join("\n");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-test-env-dependency"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;

    assert.equal(metadata?.primaryReasonCode, "ENV_TEST_DEPENDENCY_INCOMPATIBLE");
    assert.equal(metadata?.failureCategory, "environment");
    assert.equal(metadata?.actionability, "environment-fix");
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
    assert.equal((metadata?.blockerIds as string[] | undefined)?.includes("agentic.blocker.109.test-env-dependency-incompatible"), true);
    assert.equal(value.evidence?.preview?.text?.includes("failure=ENV_TEST_DEPENDENCY_INCOMPATIBLE action=environment-fix"), true);
  });

  it("classifies missing Python test dependencies as environment work before model blame", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.agentStdout = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.shell.run",
          input: {
            command: "python -m pytest astropy/io/ascii/tests/test_rst.py -x -v"
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.shell.run",
          result: [
            "Tool core.shell.run reported failed:",
            "PYTHON_TEST_DEPENDENCY_MISSING: Python test environment is missing module 'pytest'.",
            "Do not repeat the same pytest command until the checkout environment is repaired."
          ].join("\n"),
          feedback: { status: "failed" }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-environment-blocker"
          },
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          sourceMutationCount: 1,
          shellCommandCount: 1,
          testCommandCount: 1
        }
      }),
      ""
    ].join("\n");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-test-env-dependency-missing"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;

    assert.equal(metadata?.primaryReasonCode, "ENV_TEST_DEPENDENCY_MISSING");
    assert.equal(metadata?.failureCategory, "environment");
    assert.equal(metadata?.actionability, "environment-fix");
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
    assert.equal((metadata?.reviewCodes as string[] | undefined)?.includes("SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING"), true);
    assert.equal((metadata?.blockerIds as string[] | undefined)?.includes("agentic.blocker.119.test-env-dependency-missing"), true);
    const dependencyDiagnostic = (metadata?.diagnostics as JsonObject[] | undefined)?.find((entry) => entry.code === "SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING");
    const testFailureDetails = dependencyDiagnostic?.metadata && typeof dependencyDiagnostic.metadata === "object"
      ? (dependencyDiagnostic.metadata as JsonObject).testFailureDetails as JsonObject[] | undefined
      : undefined;
    assert.equal(testFailureDetails?.some((detail) => detail.moduleName === "pytest" && detail.suggestedCommand === "python -m pip install pytest"), true);
    assert.equal(value.evidence?.preview?.text?.includes("failure=ENV_TEST_DEPENDENCY_MISSING action=environment-fix"), true);
  });

  it("classifies missing pytest with a repo-local alternate runner as verification command work", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.agentStdout = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.shell.run",
          input: {
            command: "python -m pytest tests/model_fields/test_jsonfield.py -x -v"
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.shell.run",
          result: [
            "Tool core.shell.run reported failed:",
            "PYTHON_TEST_DEPENDENCY_MISSING: Python test environment is missing module 'pytest'.",
            "Next action: rerun the focused test through the repo-local runner from the checkout root, for example: python tests/runtests.py <focused-test-module> -v 2."
          ].join("\n"),
          evidence: {
            status: "failed",
            metadata: {
              testFailure: {
                kind: "python-missing-module",
                moduleName: "pytest",
                suggestedAction: "use-repo-local-python-test-runner",
                suggestedCommand: "python -m pip install pytest",
                alternateCommand: "python tests/runtests.py",
                alternateRunnerPath: "tests/runtests.py"
              }
            }
          },
          feedback: { status: "failed" }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-environment-blocker"
          },
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          sourceMutationCount: 1,
          shellCommandCount: 1,
          testCommandCount: 1
        }
      }),
      ""
    ].join("\n");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 8,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-test-runner-alternate"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;

    assert.equal(metadata?.primaryReasonCode, "VERIFICATION_REPO_LOCAL_RUNNER_AVAILABLE");
    assert.equal(metadata?.failureCategory, "verification");
    assert.equal(metadata?.actionability, "verification-fix");
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("ENV_TEST_DEPENDENCY_MISSING"), true);
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
    const dependencyDiagnostic = (metadata?.diagnostics as JsonObject[] | undefined)?.find((entry) => entry.code === "SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING");
    const testFailureDetails = dependencyDiagnostic?.metadata && typeof dependencyDiagnostic.metadata === "object"
      ? (dependencyDiagnostic.metadata as JsonObject).testFailureDetails as JsonObject[] | undefined
      : undefined;
    assert.equal(testFailureDetails?.some((detail) => detail.alternateCommand === "python tests/runtests.py" && detail.alternateRunnerPath === "tests/runtests.py" && detail.suggestedCommand === "python tests/runtests.py"), true);
    assert.equal(value.evidence?.preview?.text?.includes("failure=VERIFICATION_REPO_LOCAL_RUNNER_AVAILABLE action=verification-fix"), true);
  });

  it("classifies missing Python test entrypoints as verification command work before model blame", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.agentStdout = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.test.run",
          input: {
            command: "python",
            args: ["runtests.py", "forms_tests.tests.test_media"]
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.test.run",
          result: [
            "Tool core.test.run reported failed:",
            "PYTHON_TEST_ENTRYPOINT_MISSING: Python could not open test runner file '/workspace/repo/runtests.py'.",
            "Find the repo-local test runner before retrying; do not repeat the same command from the wrong directory."
          ].join("\n"),
          feedback: { status: "failed" }
        }
      }),
      ""
    ].join("\n");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-test-entrypoint-missing"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;

    assert.equal(metadata?.primaryReasonCode, "VERIFICATION_TEST_ENTRYPOINT_MISSING");
    assert.equal(metadata?.failureCategory, "verification");
    assert.equal(metadata?.actionability, "verification-fix");
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("VERIFICATION_LOCAL_TEST_UNSUCCESSFUL"), true);
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
    assert.equal((metadata?.reviewCodes as string[] | undefined)?.includes("SWE_BENCH_TEST_ENTRYPOINT_MISSING"), true);
    assert.equal((metadata?.blockerIds as string[] | undefined)?.includes("agentic.blocker.116.test-entrypoint-missing"), true);
    assert.equal(value.evidence?.preview?.text?.includes("failure=VERIFICATION_TEST_ENTRYPOINT_MISSING action=verification-fix"), true);
  });

  it("classifies unsupported Python test arguments as verification command work before model blame", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.agentStdout = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.test.run",
          input: {
            command: "python",
            args: ["tests/runtests.py", "forms_tests.tests.test_media", "--no-input"]
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.test.run",
          result: [
            "Tool core.test.run reported failed:",
            "PYTHON_TEST_ARGUMENT_UNSUPPORTED: Python test runner rejected option '--no-input'.",
            "Use '--noinput' instead of '--no-input' before retrying."
          ].join("\n"),
          feedback: { status: "failed" }
        }
      }),
      ""
    ].join("\n");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-test-argument-unsupported"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;

    assert.equal(metadata?.primaryReasonCode, "VERIFICATION_TEST_ARGUMENT_UNSUPPORTED");
    assert.equal(metadata?.failureCategory, "verification");
    assert.equal(metadata?.actionability, "verification-fix");
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("VERIFICATION_LOCAL_TEST_UNSUCCESSFUL"), true);
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
    assert.equal((metadata?.reviewCodes as string[] | undefined)?.includes("SWE_BENCH_TEST_ARGUMENT_UNSUPPORTED"), true);
    assert.equal((metadata?.blockerIds as string[] | undefined)?.includes("agentic.blocker.117.test-argument-unsupported"), true);
    assert.equal(value.evidence?.preview?.text?.includes("failure=VERIFICATION_TEST_ARGUMENT_UNSUPPORTED action=verification-fix"), true);
  });

  it("classifies Python test command environment scope failures as verification work before model blame", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.agentStdout = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.shell.run",
          input: {
            command: "python -m django test tests.invalid_models_tests.test_ordinary_fields.FilePathFieldTests --settings=test_sqlite --verbosity=2"
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.shell.run",
          result: [
            "Tool core.shell.run reported failed:",
            "PYTHON_TEST_COMMAND_ENV_MISSCOPED: Python test command could not import local test module/settings 'test_sqlite'.",
            "Use the repo-local test runner, cwd, module path, or settings module before retrying."
          ].join("\n"),
          feedback: { status: "failed" }
        }
      }),
      ""
    ].join("\n");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-test-command-env-misscoped"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;

    assert.equal(metadata?.primaryReasonCode, "VERIFICATION_TEST_COMMAND_ENV_MISSCOPED");
    assert.equal(metadata?.failureCategory, "verification");
    assert.equal(metadata?.actionability, "verification-fix");
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("VERIFICATION_LOCAL_TEST_UNSUCCESSFUL"), true);
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("ENV_TEST_DEPENDENCY_MISSING"), false);
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR"), false);
    assert.equal((metadata?.reviewCodes as string[] | undefined)?.includes("SWE_BENCH_TEST_COMMAND_ENV_MISSCOPED"), true);
    assert.equal((metadata?.blockerIds as string[] | undefined)?.includes("agentic.blocker.122.test-command-env-misscoped"), true);
    assert.equal(value.evidence?.preview?.text?.includes("failure=VERIFICATION_TEST_COMMAND_ENV_MISSCOPED action=verification-fix"), true);
  });

  it("recovers a structured single-task review from trace and prediction artifacts when summary is missing", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-summaryless/prediction.jsonl", JSON.stringify({
      instance_id: "demo__repo-3",
      model_name_or_path: "glm-5.1",
      model_patch: "diff --git a/src/example.py b/src/example.py\n--- a/src/example.py\n+++ b/src/example.py\n@@ -1 +1 @@\n-old\n+new\n"
    }) + "\n");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-summaryless/trace.jsonl", [
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
              providerPrefixFingerprint: "provider:stable",
              providerPrefixMessageCount: 13,
              providerPrefixTokenEstimate: 2200
            }
          }
        }
      }),
      JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "whole-prompt:second",
          trace: {
            replay: {
              sectionOrderFingerprint: "sections:stable",
              budgetFingerprint: "budget:stable",
              toolPlanFingerprint: "tools:stable"
            },
            pipeline: {
              providerPrefixFingerprint: "provider:stable",
              providerPrefixMessageCount: 13,
              providerPrefixTokenEstimate: 2200
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.requested",
        data: {
          contextPipeline: { pipelineFingerprint: "pipeline:stable" },
          providerRequestReplay: {
            selectedHistoryMessageCount: 32,
            historyMessageCount: 32,
            visibleToolSchemaCount: 9,
            toolCallLinkage: { assistantToolCallCount: 5, toolResultCount: 5 }
          }
        }
      }),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 10_000,
          metadata: {
            cache: {
              hitTokens: 4_000,
              missTokens: 6_000,
              hitRate: 0.4,
              explicitPrefixCacheHint: { status: "sent" },
              pipelineFingerprint: "pipeline:stable"
            }
          }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-environment-blocker"
          },
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          modelRequestCount: 12,
          toolCallCount: 13,
          sourceMutationCount: 1,
          shellCommandCount: 5,
          testCommandCount: 3,
          successfulTestCommandCount: 0
        }
      }),
      ""
    ].join("\n"));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 3,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-single-summaryless",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;
    const diagnostics = metadata?.diagnostics as JsonObject[] | undefined;
    const persisted = JSON.parse(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-single-summaryless/summary.json")) as JsonObject;

    assert.deepEqual(platform.datasetRequests, []);
    assert.equal(platform.executedCommands.length, 0);
    assert.equal(metadata?.status, "warn");
    assert.equal(metadata?.instanceId, "demo__repo-3");
    assert.equal(metadata?.patchBytes, 109);
    assert.equal(metadata?.providerCacheHitRate, 0.4);
    assert.equal(metadata?.childTerminalReason, "swe-bench-environment-blocker");
    assert.equal(metadata?.childTestCommandCount, 3);
    assert.equal(metadata?.childSuccessfulTestCommandCount, 0);
    assert.equal(diagnostics?.some((entry) => entry.code === "SWE_BENCH_PARTIAL_RUN_RECOVERED"), true);
    assert.equal((metadata?.reviewCodes as string[] | undefined)?.includes("SWE_BENCH_PROVIDER_CACHE_DYNAMIC_TAIL_MISS"), true);
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("VERIFICATION_LOCAL_TEST_UNSUCCESSFUL"), true);
    assert.equal(metadata?.primaryReasonCode, "VERIFICATION_LOCAL_TEST_UNSUCCESSFUL");
    assert.equal(persisted.primaryReasonCode, "VERIFICATION_LOCAL_TEST_UNSUCCESSFUL");
    assert.equal(value.evidence?.preview?.text?.includes("tests=3 successfulTests=0"), true);
  });

  it("recovers empty-patch and cache evidence from historical trace artifacts without rerunning solving", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-empty-summaryless/prediction.jsonl", JSON.stringify({
      instance_id: "demo__repo-3",
      model_name_or_path: "glm-5.1",
      model_patch: ""
    }) + "\n");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-empty-summaryless/trace.jsonl", [
      ...Array.from({ length: 12 }, (_, index) => JSON.stringify({
        kind: "model.requested",
        data: { iteration: index + 1 }
      })),
      JSON.stringify({
        kind: "usage.updated",
        data: {
          inputTokens: 120,
          metadata: {
            cache: { hitTokens: 1880, missTokens: 120, hitRate: 0.94 }
          }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "model-iteration",
            consumed: 12,
            allowed: 12,
            remaining: 0,
            stopReason: "swe-bench-request-budget-exceeded"
          },
          gate: "SWE_BENCH_REQUEST_BUDGET_GATE",
          modelRequestCount: 12,
          toolCallCount: 12,
          sourceMutationCount: 0,
          shellCommandCount: 0,
          testCommandCount: 0
        }
      }),
      ""
    ].join("\n"));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 3,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-single-empty-summaryless",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject; preview?: { text?: string } } };
    const metadata = value.evidence?.metadata;
    const reasonCodes = metadata?.reasonCodes as string[] | undefined;
    const persisted = JSON.parse(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-single-empty-summaryless/summary.json")) as JsonObject;

    assert.deepEqual(platform.datasetRequests, []);
    assert.equal(platform.executedCommands.length, 0);
    assert.equal(metadata?.patchBytes, 0);
    assert.equal(metadata?.providerCacheHitRate, 0.94);
    assert.equal(metadata?.providerCachePassed, true);
    assert.equal(metadata?.childTerminalReason, "swe-bench-request-budget-exceeded");
    assert.equal(metadata?.primaryReasonCode, "FLOW_REQUEST_BUDGET_EXCEEDED");
    assert.equal(reasonCodes?.includes("PREDICTION_EMPTY_PATCH"), true);
    assert.equal(reasonCodes?.includes("FLOW_REQUEST_BUDGET_EXCEEDED"), true);
    assert.equal(reasonCodes?.includes("HARNESS_INSTANCE_REPORT_MISSING"), false);
    assert.equal(persisted.providerCacheHitRate, 0.94);
    assert.equal(persisted.primaryReasonCode, "FLOW_REQUEST_BUDGET_EXCEEDED");
    assert.equal(value.evidence?.preview?.text?.includes("providerCache hitRate=94.0% requests=1"), true);
  });

  it("classifies attempted local tests with no successful run before environment or model blame", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-tests-unsuccessful/summary.json", JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "capability.swe-bench.run.summary",
      taskNumber: 3,
      runId: "unit-single-tests-unsuccessful",
      status: "warn",
      dryRun: false,
      execute: true,
      provider: "glm",
      model: "glm-5.1",
      evaluationStatus: "warn",
      evaluationResolved: false,
      commandCount: 16,
      diagnostics: [
        {
          code: "SWE_BENCH_EVALUATION_UNRESOLVED",
          severity: "warn",
          message: "official unresolved",
          redaction: { class: "internal" }
        }
      ],
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    }));
    await platform.writeFile("/workspace/.deepseek/swe-lite-runs/unit-single-tests-unsuccessful/trace.jsonl", [
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-environment-blocker"
          },
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          modelRequestCount: 12,
          toolCallCount: 13,
          sourceMutationCount: 1,
          shellCommandCount: 5,
          testCommandCount: 3,
          successfulTestCommandCount: 0
        }
      }),
      ""
    ].join("\n"));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 3,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-single-tests-unsuccessful",
      resumeOnly: true
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const metadata = value.evidence?.metadata;

    assert.equal(metadata?.primaryReasonCode, "VERIFICATION_LOCAL_TEST_UNSUCCESSFUL");
    assert.equal(metadata?.failureCategory, "verification");
    assert.equal(metadata?.actionability, "verification-fix");
    assert.equal((metadata?.reasonCodes as string[] | undefined)?.includes("ENV_POST_VERIFICATION_BLOCKER"), true);
    assert.equal((metadata?.blockerIds as string[] | undefined)?.includes("agentic.blocker.115.local-test-unsuccessful"), true);
  });

  it("persists single-task run summaries for later resume and review", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-summary-persist"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const persisted = JSON.parse(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-run-summary-persist/summary.json")) as JsonObject;

    assert.equal(persisted.kind, "capability.swe-bench.run.summary");
    assert.equal(persisted.taskNumber, 2);
    assert.equal(persisted.runId, "unit-run-summary-persist");
    assert.equal(persisted.instanceId, "demo__repo-2");
  });

  it("persists single-task run progress records before and after major phases", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-progress"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const progressWrites = platform.writes.filter((write) => write.path === "/workspace/.deepseek/swe-lite-runs/unit-run-progress/run-progress.jsonl");
    const latestProgress = progressWrites.at(-1)?.content ?? "";
    const stages = latestProgress
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as JsonObject)
      .map((entry) => `${entry.stage}:${entry.status}`);

    assert.equal(progressWrites.length >= 5, true);
    assert.equal(stages.includes("environment.prepare:completed"), true);
    assert.equal(stages.includes("dataset.resolve:completed"), true);
    assert.equal(stages.includes("checkout.prepare:completed"), true);
    assert.equal(stages.includes("checkout.env:completed"), true);
    assert.equal(stages.includes("attempt.predict.start:started"), true);
    assert.equal(stages.includes("attempt.evaluate.completed:completed"), true);
    assert.equal(stages.includes("summary.persisted:completed"), true);
  });

  it("returns single-task evidence when host context omits an execution envelope", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });
    const context = capabilityContext();
    const envelopeLessContext = {
      trace: context.trace,
      signal: context.signal,
      metadata: {}
    } as CapabilityExecutionContext;

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-envelope-less-context"
    }, envelopeLessContext);

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { replay?: JsonObject; metadata?: JsonObject } };
    assert.equal(value.evidence?.metadata?.runId, "unit-run-envelope-less-context");
    assert.equal(value.evidence?.replay?.traceId, "trace-swe-bench-run-test");
    assert.equal(value.evidence?.replay?.snapshot, "cli-swe-bench-run-evidence");
  });

  it("runs a supervised repair attempt when the first official harness result is unresolved", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.resolveOnSecondHarness = true;
    platform.harnessTestOutputByInstanceId.set("demo__repo-2", [
      "tests/test_demo.py::test_expected_fix FAILED",
      "tests/test_demo.py:42: in test_expected_fix",
      "    parse_value('no')",
      "E   ValueError: could not convert string to float: 'no'",
      "FAILED tests/test_demo.py::test_expected_fix - ValueError: could not convert string to float: 'no'",
      ""
    ].join("\n"));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-repair"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { status?: string; preview?: { text?: string }; metadata?: JsonObject } };
    const childRuns = platform.executedCommands.filter(isAgentRunCommand);
    const secondPrompt = childRuns[1]?.args[childRuns[1].args.indexOf("run") + 1] ?? "";

    assert.equal(platform.harnessRunCount, 2);
    assert.equal(childRuns.length, 2);
    assert.equal(secondPrompt.includes("Previous supervised attempt feedback"), true);
    assert.equal(secondPrompt.includes("tests/test_demo.py::test_expected_fix"), true);
    assert.equal(secondPrompt.includes("Official harness failure excerpts"), true);
    assert.equal(secondPrompt.includes("ValueError: could not convert string to float: 'no'"), true);
    assert.equal(value.evidence?.status, "completed");
    assert.equal(value.evidence?.metadata?.attemptCount, 2);
    assert.equal(value.evidence?.metadata?.repairAttempted, true);
    assert.equal(value.evidence?.metadata?.evaluationResolved, true);
    assert.equal(value.evidence?.preview?.text?.includes("attempts=2 repair=true"), true);
  });

  it("diagnoses low-fidelity repair feedback when official failure excerpts are unavailable", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.resolveOnSecondHarness = true;
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-repair-low-fidelity"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { metadata?: JsonObject } };
    const diagnostics = value.evidence?.metadata?.diagnostics as JsonObject[] | undefined;

    assert.equal(diagnostics?.some((entry) => entry.code === "REPAIR_FEEDBACK_LOW_FIDELITY"), true);
  });

  it("preserves separate child traces for each supervised attempt", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.resolveOnSecondHarness = true;
    platform.agentStdouts = [
      JSON.stringify({ kind: "agent.loop.completed", data: { status: "completed", attempt: 1 } }) + "\n",
      JSON.stringify({ kind: "agent.loop.completed", data: { status: "completed", attempt: 2 } }) + "\n"
    ];
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-traces"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    assert.equal(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-run-traces/trace-attempt-1.jsonl"), platform.agentStdouts[0]);
    assert.equal(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-run-traces/trace-attempt-2.jsonl"), platform.agentStdouts[1]);
    assert.equal(await platform.readFile("/workspace/.deepseek/swe-lite-runs/unit-run-traces/trace.jsonl"), platform.agentStdouts[1]);
  });

  it("resets an existing run-scoped checkout before predicting", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-existing"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const checkout = platform.executedCommands.find((entry) => entry.command === "git" && entry.args.includes("checkout"));
    const reset = platform.executedCommands.find((entry) => entry.command === "git" && entry.args.includes("reset"));
    const clean = platform.executedCommands.find((entry) => entry.command === "git" && entry.args.includes("clean"));
    const childIndex = platform.executedCommands.findIndex(isAgentRunCommand);

    assert.ok(checkout);
    assert.ok(reset);
    assert.ok(clean);
    assert.deepEqual(reset.args.slice(2), ["reset", "--hard", "abcdef0123456789abcdef0123456789abcdef01"]);
    assert.deepEqual(clean.args.slice(2), ["clean", "-fdx", "-e", ".venv"]);
    assert.equal(platform.executedCommands.findIndex((entry) => entry === reset) < childIndex, true);
    assert.equal(platform.executedCommands.findIndex((entry) => entry === clean) < childIndex, true);
  });

  it("pre-cleans a reused run-scoped checkout before switching to the base commit", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.repoAlreadyExists = true;
    platform.checkoutRequiresPreClean = true;
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-reused-dirty"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const checkoutIndex = platform.executedCommands.findIndex((entry) => entry.command === "git" && entry.args.includes("checkout"));
    const preCleanIndex = platform.executedCommands.findIndex((entry) => entry.command === "git" && entry.args.includes("clean"));
    const childIndex = platform.executedCommands.findIndex(isAgentRunCommand);

    assert.equal(platform.executedCommands.some((entry) => entry.command === "git" && entry.args[0] === "clone"), false);
    assert.equal(preCleanIndex >= 0, true);
    assert.equal(checkoutIndex >= 0, true);
    assert.equal(preCleanIndex < checkoutIndex, true);
    assert.equal(checkoutIndex < childIndex, true);
  });

  it("clears stale git index locks before resetting a reused run-scoped checkout", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.repoAlreadyExists = true;
    platform.gitIndexLockExists = true;
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 3,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-stale-git-lock"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const cleanupIndex = platform.executedCommands.findIndex((entry) =>
      entry.command === process.execPath &&
      entry.args[0] === "-e" &&
      String(entry.args[2]).endsWith("/.deepseek/swe-lite-runs/unit-run-stale-git-lock/repo/.git/index.lock")
    );
    const resetIndex = platform.executedCommands.findIndex((entry) => entry.command === "git" && entry.args[2] === "reset");
    const checkoutIndex = platform.executedCommands.findIndex((entry) => entry.command === "git" && entry.args[2] === "checkout");

    assert.equal(cleanupIndex >= 0, true);
    assert.equal(resetIndex >= 0, true);
    assert.equal(checkoutIndex >= 0, true);
    assert.equal(cleanupIndex < resetIndex, true);
    assert.equal(cleanupIndex < checkoutIndex, true);
    assert.equal(platform.gitIndexLockExists, false);
  });

  it("prepares the run-scoped checkout virtualenv before launching the child agent", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-checkout-env"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const childIndex = platform.executedCommands.findIndex(isAgentRunCommand);
    const repoDir = "/workspace/.deepseek/swe-lite-runs/unit-run-checkout-env/repo";
    const venvCreateIndex = platform.executedCommands.findIndex((entry) =>
      entry.command === "python3.12" &&
      entry.args.join(" ") === `-m venv --clear ${repoDir}/.venv`
    );
    const editableInstallIndex = platform.executedCommands.findIndex((entry) =>
      entry.command === `${repoDir}/.venv/bin/python` &&
      entry.args.join(" ") === "-m pip install -e ."
    );

    assert.equal(venvCreateIndex >= 0, true);
    assert.equal(editableInstallIndex >= 0, true);
    assert.equal(venvCreateIndex < childIndex, true);
    assert.equal(editableInstallIndex < childIndex, true);
  });

  it("uses package metadata to select legacy checkout Python and test extras before launching the child agent", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.datasetInstances.set(2, {
      instanceId: "demo__legacy-python-1",
      repo: "demo/legacy-python",
      baseCommit: "a5917978be39d13cd90b517e1de4e7a539ffaa48",
      problemStatement: "Legacy Python package fixture"
    });
    const repoDir = "/workspace/.deepseek/swe-lite-runs/unit-run-legacy-python-checkout-env/repo";
    await platform.writeFile(`${repoDir}/pyproject.toml`, [
      "[project]",
      "requires-python = \">=3.8\"",
      "dependencies = [\"numpy\"]",
      "",
      "[project.optional-dependencies]",
      "test = [\"pytest\"]",
      ""
    ].join("\n"));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-legacy-python-checkout-env"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const childIndex = platform.executedCommands.findIndex(isAgentRunCommand);
    const venvCreateIndex = platform.executedCommands.findIndex((entry) =>
      entry.command === "python3.9" &&
      entry.args.join(" ") === `-m venv --clear ${repoDir}/.venv`
    );
    const editableInstall = platform.executedCommands.find((entry) =>
      entry.command === `${repoDir}/.venv/bin/python` &&
      entry.args.join(" ") === "-m pip install -e .[test]"
    );
    const constraints = platform.writes.find((entry) =>
      entry.path.endsWith("/checkout-constraints.txt") &&
      entry.content.includes("setuptools==68.0.0")
    );

    assert.equal(venvCreateIndex >= 0, true);
    assert.equal(venvCreateIndex < childIndex, true);
    assert.equal(Boolean(editableInstall), true);
    assert.equal(editableInstall?.env?.PIP_CONSTRAINT, constraints?.path);
    assert.equal(editableInstall?.env?.PIP_BUILD_CONSTRAINT, constraints?.path);
    assert.equal(String(constraints?.content).includes("numpy<2"), true);
    assert.equal(String(constraints?.content).includes("Cython<3"), false);
  });

  it("uses package metadata to add legacy compile constraints for Cython-based checkouts", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.datasetInstances.set(6, {
      instanceId: "demo__legacy-cython-1",
      repo: "demo/legacy-cython",
      baseCommit: "d5bd3f68bb6d5ce3a61bdce9883ee750d1afade5",
      problemStatement: "Legacy Cython package fixture"
    });
    const repoDir = "/workspace/.deepseek/swe-lite-runs/unit-run-legacy-cython-checkout-env/repo";
    await platform.writeFile(`${repoDir}/pyproject.toml`, [
      "[build-system]",
      "requires = [\"setuptools\", \"wheel\", \"Cython\"]",
      "",
      "[project]",
      "requires-python = \">=3.8,<3.10\"",
      "dependencies = [\"numpy\"]",
      "",
      "[project.optional-dependencies]",
      "test = [\"pytest\"]",
      ""
    ].join("\n"));
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 6,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-legacy-cython-checkout-env"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const editableInstall = platform.executedCommands.find((entry) =>
      entry.command === `${repoDir}/.venv/bin/python` &&
      entry.args.join(" ") === "-m pip install -e .[test]"
    );
    const constraints = platform.writes.find((entry) =>
      entry.path.endsWith("/checkout-constraints.txt") &&
      entry.content.includes("numpy<2") &&
      entry.content.includes("Cython<3")
    );

    assert.equal(platform.executedCommands.some((entry) =>
      entry.command === "python3.9" &&
      entry.args.join(" ") === `-m venv --clear ${repoDir}/.venv`
    ), true);
    assert.equal(Boolean(editableInstall), true);
    assert.equal(editableInstall?.env?.PIP_CONSTRAINT, constraints?.path);
    assert.equal(editableInstall?.env?.PIP_BUILD_CONSTRAINT, constraints?.path);
    assert.equal(editableInstall?.env?.CFLAGS, "-Wno-error=implicit-function-declaration");
  });

  it("keeps nonfatal checkout editable install warnings from failing structured runs", async () => {
    const platform = new FakeSweBenchRunPlatform("fake", "/workspace");
    platform.checkoutEditableInstallExitCode = 1;
    platform.resolvedTaskNumbers.add(2);
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerCliSweBenchRunCapabilities(deps, "/workspace", {
      env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" }
    });

    const execution = await deps.capabilities.execute(asId<"capability">("core.swe.bench.run"), {
      taskNumber: 2,
      provider: "glm",
      model: "glm-5.1",
      runId: "unit-run-checkout-env-warning"
    }, capabilityContext());

    assert.equal(execution.ok, true);
    const value = execution.value as { evidence?: { status?: string; metadata?: JsonObject } };
    const diagnostics = Array.isArray(value.evidence?.metadata?.diagnostics)
      ? value.evidence?.metadata?.diagnostics as JsonObject[]
      : [];
    const checkoutWarning = diagnostics.find((entry) => entry.code === "SWE_BENCH_CHECKOUT_ENV_WARN");
    const repoDir = "/workspace/.deepseek/swe-lite-runs/unit-run-checkout-env-warning/repo";

    assert.equal(value.evidence?.status, "failed");
    assert.equal(value.evidence?.metadata?.status, "warn");
    assert.equal(value.evidence?.metadata?.evaluationResolved, true);
    assert.equal(checkoutWarning?.severity, "warn");
    assert.deepEqual(checkoutWarning?.metadata, {
      command: `${repoDir}/.venv/bin/python`,
      args: ["-m", "pip", "install", "-e", "."],
      cwd: repoDir,
      exitCode: 1,
      stdoutPreview: "editable install failed\n",
      stderrPreview: ""
    });
  });
});

function capabilityContext(): CapabilityExecutionContext {
  const trace: TraceContext = {
    traceId: asId<"trace">("trace-swe-bench-run-test"),
    spanId: asId<"span">("span-swe-bench-run-test"),
    correlationId: asId<"correlation">("corr-swe-bench-run-test")
  };
  const resourceScope = analyzeResourceScope({}, "process");
  const sandboxRequirements = createSandboxRequirement({
    sideEffect: "process",
    resourceScope,
    timeoutMs: 600_000,
    permissions: ["process:run", "evaluation:swe-bench"]
  });
  return {
    envelope: {
      invocationId: "invocation-swe-bench-run-test",
      capabilityId: asId<"capability">("core.swe.bench.run"),
      capabilityVersion: "1.0.0",
      kind: "capability",
      caller: "unit",
      inputSchema: {},
      outputSchema: {},
      redactionClass: "internal",
      provenance: {},
      trust: "trusted",
      permissions: [],
      sideEffect: "process",
      policyContext: {},
      approvalRequired: false,
      resourceLocks: [],
      timeoutMs: 600_000,
      cancellation: {},
      retryPolicy: {},
      idempotency: {},
      trace,
      telemetry: {},
      replayPolicy: {},
      secretExposure: createSecretRedactionDecision("", { class: "public" }),
      resourceScope,
      sandboxRequirements,
      audit: createSandboxAuditEvidence({
        decision: "allow",
        reasonCode: "unit",
        subject: "unit",
        resource: "core.swe.bench.run",
        sandboxProfile: sandboxRequirements.profile,
        trace
      }),
      createdAt: new Date(0).toISOString()
    },
    trace,
    signal: new AbortController().signal,
    metadata: {}
  };
}

function result(stdout: string, exitCode = 0): ProcessResult {
  return { exitCode, stdout, stderr: "", metadata: fakeProviderMetadata() };
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

function argAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function isAgentRunCommand(entry: { readonly command: string; readonly args: readonly string[] }): boolean {
  return entry.command === process.execPath && entry.args.includes("run");
}
