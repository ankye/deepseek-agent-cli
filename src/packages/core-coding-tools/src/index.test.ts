import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryCapabilityRegistry } from "@deepseek/capability-registry";
import { FakePlatformRuntime } from "@deepseek/platform-abstraction";
import { InMemoryWorkspaceStateManager } from "@deepseek/workspace-state-management";
import { asId, TOOL_FAMILY_DOMAIN_IDS, TOOL_FAMILY_IDS } from "@deepseek/platform-contracts";
import type {
  CapabilityExecutionContext,
  CoreToolResult,
  ExecutionEnvelope,
  JsonObject,
  ProcessResult,
  ProcessRunObserver,
  ProcessRunOptions,
  SerializableResult,
  ShellProfile,
  ShellProviderDescriptor,
  TraceContext
} from "@deepseek/platform-contracts";
import { analyzeResourceScope, createSandboxAuditEvidence, createSandboxRequirement, createSecretRedactionDecision } from "@deepseek/policy-sandbox";
import {
  buildToolFamilyParityMatrix,
  coreCapabilityFamilyMappings,
  coreToolIds,
  coreToolManifests,
  isStandardTestCommand,
  registerCoreCodingTools,
  toolFamilyCatalog,
  validateToolFamilyCatalog
} from "./index.js";

const workspaceRoot = "/workspace";

class ShellCapableFakePlatform extends FakePlatformRuntime {
  readonly executedCommands: { readonly command: string; readonly args: readonly string[]; readonly cwd?: string }[] = [];
  readonly commandTimeouts: number[] = [];
  nextProcessResult: ProcessResult | undefined;

  override async resolveShell(profile: ShellProfile = "bash"): Promise<SerializableResult<ShellProviderDescriptor>> {
    return super.resolveShell(profile);
  }

  override async runProcess(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
    observer?: ProcessRunObserver
  ): Promise<ProcessResult> {
    this.commandTimeouts.push(options.timeoutMs ?? 0);
    this.executedCommands.push({ command, args: [...args], ...(options.cwd ? { cwd: options.cwd } : {}) });
    if (this.nextProcessResult) {
      const result = this.nextProcessResult;
      this.nextProcessResult = undefined;
      return result;
    }
    return super.runProcess(command, args, options, observer);
  }
}

async function invoke(
  id: (typeof coreToolIds)[keyof typeof coreToolIds],
  input: JsonObject,
  options: { readonly platform?: FakePlatformRuntime; readonly workspaceState?: InMemoryWorkspaceStateManager } = {}
): Promise<SerializableResult<CoreToolResult>> {
  const platform = options.platform ?? new FakePlatformRuntime("fake", workspaceRoot);
  const workspaceState = options.workspaceState ?? new InMemoryWorkspaceStateManager();
  const registry = new InMemoryCapabilityRegistry();
  await registerCoreCodingTools(registry, { platform, workspaceState, workspaceRoot });
  const binding = await registry.resolveExecutable(id);
  assert.ok(binding);
  return binding.execute(input, context(id)) as Promise<SerializableResult<CoreToolResult>>;
}

function context(capabilityId: (typeof coreToolIds)[keyof typeof coreToolIds]): CapabilityExecutionContext {
  const trace: TraceContext = {
    traceId: asId<"trace">("trace-core-tool"),
    spanId: asId<"span">("span-core-tool"),
    correlationId: asId<"correlation">("corr-core-tool"),
    sessionId: asId<"session">("session-core-tool")
  };
  return {
    envelope: {
      invocationId: "invocation-core-tool",
      capabilityId,
      capabilityVersion: "1.0.0",
      kind: "capability",
      caller: "unit",
      sessionId: asId<"session">("session-core-tool"),
      inputSchema: {},
      outputSchema: {},
      redactionClass: "internal",
      provenance: {},
      trust: "trusted",
      permissions: [],
      sideEffect: "read",
      policyContext: {},
      approvalRequired: false,
      resourceLocks: [],
      timeoutMs: 30_000,
      cancellation: {},
      retryPolicy: {},
      idempotency: {},
      trace,
      telemetry: {},
      replayPolicy: {},
      ...securityFields(capabilityId),
      createdAt: new Date(0).toISOString()
    } satisfies ExecutionEnvelope,
    trace,
    signal: new AbortController().signal,
    metadata: {}
  };
}

function securityFields(capabilityId: (typeof coreToolIds)[keyof typeof coreToolIds]) {
  const resourceScope = analyzeResourceScope({}, "read");
  const sandboxRequirements = createSandboxRequirement({ sideEffect: "read", resourceScope, timeoutMs: 30_000, permissions: [] });
  return {
    secretExposure: createSecretRedactionDecision("", { class: "public" }),
    resourceScope,
    sandboxRequirements,
    audit: createSandboxAuditEvidence({
      decision: "test",
      reasonCode: "test.core-tool-context",
      subject: "unit",
      resource: String(capabilityId),
      sandboxProfile: sandboxRequirements.profile
    })
  };
}

describe("core coding tool executors", () => {
  it("defines the first tool-family catalog without placeholder tools", () => {
    assert.deepEqual(validateToolFamilyCatalog(), []);
    assert.equal(toolFamilyCatalog.domains.length, TOOL_FAMILY_DOMAIN_IDS.length);
    assert.equal(toolFamilyCatalog.families.length, TOOL_FAMILY_IDS.length);
    assert.deepEqual(toolFamilyCatalog.domains.map((domain) => domain.domainId), TOOL_FAMILY_DOMAIN_IDS);
    assert.deepEqual(toolFamilyCatalog.families.map((family) => family.familyId), TOOL_FAMILY_IDS);
    assert.equal(new Set(toolFamilyCatalog.families.map((family) => family.familyId)).size, TOOL_FAMILY_IDS.length);
    for (const family of toolFamilyCatalog.families) {
      if (family.implementationState === "implemented") {
        assert.equal(family.tools.length > 0, true, `${family.familyId} should have concrete tool implementations`);
      } else {
        assert.equal(family.tools.length, 0, `${family.familyId} should not use placeholder tools`);
      }
      assert.equal(family.tools.some((tool) => tool.toolId.startsWith("catalog.")), false);
    }
  });

  it("attaches family metadata to every implemented core tool manifest", () => {
    const manifests = coreToolManifests();
    const mappedCapabilities = new Set(coreCapabilityFamilyMappings().map((item) => item.capabilityId));
    assert.equal(manifests.length, Object.values(coreToolIds).length);

    for (const manifest of manifests) {
      assert.ok(manifest.toolFamily, `${manifest.id} should include tool family metadata`);
      assert.equal(manifest.toolFamily.catalogVersion, toolFamilyCatalog.catalogVersion);
      assert.equal(mappedCapabilities.has(manifest.id), true);
    }
  });

  it("declares REPL governance fields used by process sandbox preflight", () => {
    const manifest = coreToolManifests().find((candidate) => candidate.id === coreToolIds.replExecute);

    assert.ok(manifest);
    assert.equal(((manifest.inputSchema.properties as JsonObject).cwd as JsonObject | undefined)?.type, "string");
    assert.equal(((manifest.inputSchema.properties as JsonObject).workspaceRoot as JsonObject | undefined)?.type, "string");
  });

  it("scores planned or unassessed families as zero instead of giving catalog credit", () => {
    const matrix = buildToolFamilyParityMatrix();
    const implemented = toolFamilyCatalog.families.filter((family) => family.implementationState === "implemented").length;

    assert.equal(matrix.totalFamilyCount, TOOL_FAMILY_IDS.length);
    assert.equal(matrix.implementedFamilyCount, implemented);
    assert.equal(matrix.plannedFamilyCount, TOOL_FAMILY_IDS.length - implemented);
    assert.equal(matrix.liveCoveredFamilyCount, 0);
    assert.equal(matrix.taskCoveredFamilyCount, 0);
    assert.equal(matrix.passedFamilyCount, 0);
    assert.equal(matrix.objectiveScore, 0);
    assert.equal(matrix.deliveryCapabilityScore, 0);
    assert.equal(matrix.deliveryCapabilityTargetScore, 0.9);
    assert.equal(matrix.deliveryCapabilityTargetFamilyCount, Math.ceil(matrix.totalFamilyCount * matrix.deliveryCapabilityTargetScore));
    assert.equal(matrix.deliveryCapabilityPassed, false);

    const patch = matrix.scorecards.find((scorecard) => scorecard.familyId === "patch.apply");
    assert.equal(patch?.implementationState, "implemented");
    assert.equal(patch?.toolCount, 1);
    assert.equal(patch?.objectiveScore, 0.4);

    const withEvidence = buildToolFamilyParityMatrix({
      liveCoveredFamilyIds: ["file.read"],
      taskCoveredFamilyIds: ["file.read"],
      safetyCoveredFamilyIds: ["file.read"]
    });
    assert.equal(withEvidence.passedFamilyCount, 1);
    assert.equal(withEvidence.objectiveScore, Math.round((1 / withEvidence.totalFamilyCount) * 1000) / 1000);
    assert.equal(withEvidence.deliveryCapabilityPassedFamilyCount, 1);
    assert.equal(withEvidence.deliveryCapabilityScore, Math.round((1 / withEvidence.totalFamilyCount) * 1000) / 1000);
    assert.equal(withEvidence.scorecards.find((scorecard) => scorecard.familyId === "file.read")?.objectiveScore, 1);

    const fakeEvidence = buildToolFamilyParityMatrix({
      fakeCoveredFamilyIds: ["file.read"],
      taskCoveredFamilyIds: ["file.read"],
      safetyCoveredFamilyIds: ["file.read"]
    });
    assert.equal(fakeEvidence.passedFamilyCount, 1);
    assert.equal(fakeEvidence.objectiveScore, Math.round((1 / fakeEvidence.totalFamilyCount) * 1000) / 1000);
    assert.equal(fakeEvidence.deliveryCapabilityPassedFamilyCount, 0);
    assert.equal(fakeEvidence.deliveryCapabilityScore, 0);
    assert.equal(fakeEvidence.deliveryCapabilityBlockingFamilyIds.includes("file.read"), true);

    const replayEvidence = buildToolFamilyParityMatrix({
      replayedCoveredFamilyIds: ["file.read"],
      taskCoveredFamilyIds: ["file.read"],
      safetyCoveredFamilyIds: ["file.read"]
    });
    assert.equal(replayEvidence.passedFamilyCount, 1);
    assert.equal(replayEvidence.deliveryCapabilityPassedFamilyCount, 0);
    assert.equal(replayEvidence.deliveryCapabilityScore, 0);

    const providerBlocked = buildToolFamilyParityMatrix({
      liveCoveredFamilyIds: ["web.search"],
      taskCoveredFamilyIds: ["web.search"],
      safetyCoveredFamilyIds: ["web.search"]
    });
    assert.equal(providerBlocked.passedFamilyCount, 0);
    assert.equal(providerBlocked.deliveryCapabilityScore, 0);

    const providerNative = buildToolFamilyParityMatrix({
      liveCoveredFamilyIds: ["web.search"],
      taskCoveredFamilyIds: ["web.search"],
      safetyCoveredFamilyIds: ["web.search"],
      providerNativeSupportedFamilyIds: ["web.search"]
    });
    assert.equal(providerNative.passedFamilyCount, 1);
    assert.equal(providerNative.deliveryCapabilityPassedFamilyCount, 1);
  });

  it("reads, lists, searches, and bounds file evidence", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot, { searchProvider: "js" });
    await platform.writeFile(`${workspaceRoot}/README.md`, `alpha\n${"x".repeat(64)}`);

    const read = await invoke(coreToolIds.fileRead, { path: "README.md", workspaceRoot, limitBytes: 12 }, { platform });
    assert.equal(read.ok, true);
    assert.equal(read.value?.evidence.preview?.truncated, true);
    assert.deepEqual(read.value?.evidence.affectedPaths, [`${workspaceRoot}/README.md`]);

    const list = await invoke(coreToolIds.fileList, { pattern: "README", workspaceRoot }, { platform });
    assert.equal(list.ok, true);
    assert.match(list.value?.evidence.preview?.text ?? "", /README\.md/);

    const search = await invoke(coreToolIds.searchText, { pattern: "alpha", workspaceRoot }, { platform });
    assert.equal(search.ok, true);
    assert.equal(search.value?.evidence.provider?.selectedProvider, "js");
    assert.match(search.value?.evidence.preview?.text ?? "", /README\.md:1/);
    assert.equal((search.value?.evidence.preview?.text ?? "").includes(workspaceRoot), false);
  });

  it("keeps internal evaluation artifacts out of model-visible read, list, glob, and search tools", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot, { searchProvider: "js" });
    await platform.writeFile(`${workspaceRoot}/src/swe-task.ts`, "export const safe = 'swe-bench';");
    await platform.writeFile(`${workspaceRoot}/.deepseek/evaluation-boundary-runs/run.jsonl`, "hidden old trace swe-bench");
    await platform.writeFile(`${workspaceRoot}/.deepseek/swebench-runs/probe/patch.diff`, "hidden old patch swe-bench");
    await platform.writeFile(`${workspaceRoot}/.deepseek/swebench-venv/lib/python/site.py`, "hidden env package swe-bench");
    await platform.writeFile(`${workspaceRoot}/.deepseek/swebench-workspaces/astropy__astropy-12907/repo/.pytest_cache/v/cache/lastfailed`, "hidden pytest cache swe-bench");
    await platform.writeFile(`${workspaceRoot}/.deepseek/swebench-workspaces/astropy__astropy-12907/repo/.venv/lib/python/site.py`, "hidden local venv swe-bench");
    await platform.writeFile(`${workspaceRoot}/.deepseek/swebench-workspaces/astropy__astropy-12907/repo/__pycache__/separable.pyc`, "hidden bytecode swe-bench");

    const read = await invoke(coreToolIds.fileRead, {
      path: ".deepseek/evaluation-boundary-runs/run.jsonl",
      workspaceRoot
    }, { platform });
    assert.equal(read.ok, false);
    assert.equal(read.error?.code, "INTERNAL_ARTIFACT_REJECTED");

    const envRead = await invoke(coreToolIds.fileRead, {
      path: ".deepseek/swebench-venv/lib/python/site.py",
      workspaceRoot
    }, { platform });
    assert.equal(envRead.ok, false);
    assert.equal(envRead.error?.code, "INTERNAL_ARTIFACT_REJECTED");

    const list = await invoke(coreToolIds.fileList, { pattern: "swe", workspaceRoot }, { platform });
    assert.equal(list.ok, true);
    assert.match(list.value?.evidence.preview?.text ?? "", /src\/swe-task\.ts/);
    assert.equal((list.value?.evidence.preview?.text ?? "").includes("evaluation-boundary-runs"), false);
    assert.equal((list.value?.evidence.preview?.text ?? "").includes("swebench-runs"), false);
    assert.equal((list.value?.evidence.preview?.text ?? "").includes("swebench-venv"), false);
    assert.equal((list.value?.evidence.preview?.text ?? "").includes(".pytest_cache"), false);
    assert.equal((list.value?.evidence.preview?.text ?? "").includes(".venv"), false);
    assert.equal((list.value?.evidence.preview?.text ?? "").includes("__pycache__"), false);

    const glob = await invoke(coreToolIds.workspaceGlob, { pattern: "**/*swe*", workspaceRoot }, { platform });
    assert.equal(glob.ok, true);
    assert.match(glob.value?.evidence.preview?.text ?? "", /src\/swe-task\.ts/);
    assert.equal((glob.value?.evidence.preview?.text ?? "").includes("evaluation-boundary-runs"), false);
    assert.equal((glob.value?.evidence.preview?.text ?? "").includes("swebench-runs"), false);
    assert.equal((glob.value?.evidence.preview?.text ?? "").includes("swebench-venv"), false);
    assert.equal((glob.value?.evidence.preview?.text ?? "").includes(".pytest_cache"), false);
    assert.equal((glob.value?.evidence.preview?.text ?? "").includes(".venv"), false);
    assert.equal((glob.value?.evidence.preview?.text ?? "").includes("__pycache__"), false);

    const search = await invoke(coreToolIds.searchText, {
      pattern: "swe-bench",
      workspaceRoot,
      outputMode: "files_with_matches"
    }, { platform });
    assert.equal(search.ok, true);
    assert.match(search.value?.evidence.preview?.text ?? "", /src\/swe-task\.ts/);
    assert.equal((search.value?.evidence.preview?.text ?? "").includes("patch.diff"), false);
    assert.equal((search.value?.evidence.preview?.text ?? "").includes("swebench-venv"), false);
    assert.equal((search.value?.evidence.preview?.text ?? "").includes(".pytest_cache"), false);
    assert.equal((search.value?.evidence.preview?.text ?? "").includes(".venv"), false);
    assert.equal((search.value?.evidence.preview?.text ?? "").includes("__pycache__"), false);
  });

  it("rejects shell commands that directly reference internal evaluation artifacts", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    await platform.writeFile(`${workspaceRoot}/.deepseek/evaluation-boundary-runs/run.jsonl`, "hidden trace");

    const result = await invoke(coreToolIds.shellRun, {
      command: "cat",
      args: [".deepseek/evaluation-boundary-runs/run.jsonl"],
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "INTERNAL_ARTIFACT_REJECTED");
  });

  it("allows shell commands inside a governed SWE-bench Lite checkout to reference that checkout", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/swe-lite-runs/unit-run/repo`;
    await platform.writeFile(`${repoRoot}/astropy/io/ascii/core.py`, "header_rows = []");

    const outerTraversal = await invoke(coreToolIds.shellRun, {
      command: `grep -rn "header_rows" ${repoRoot}/astropy/io/ascii/ | head -50`,
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(outerTraversal.ok, false);
    assert.equal(outerTraversal.error?.code, "INTERNAL_ARTIFACT_REJECTED");

    const currentCheckout = await invoke(coreToolIds.shellRun, {
      command: `grep -rn "header_rows" ${repoRoot}/astropy/io/ascii/ | head -50`,
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(currentCheckout.ok, true);
    assert.deepEqual(platform.executedCommands.at(-1), {
      command: "bash",
      args: ["-lc", `set -o pipefail; PATH=${repoRoot}/.venv/bin:$PATH; export PATH; grep -rn "header_rows" ${repoRoot}/astropy/io/ascii/ | head -50`],
      cwd: repoRoot
    });
  });

  it("runs model-authored shell command strings through the host shell", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    const shellString = await invoke(coreToolIds.shellRun, {
      command: "echo hello && pwd",
      workspaceRoot
    }, { platform });

    assert.equal(shellString.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", "set -o pipefail; echo hello && pwd"],
      cwd: workspaceRoot
    });
    assert.equal(shellString.value?.evidence.metadata.shellSyntax, true);

    const argv = await invoke(coreToolIds.shellRun, {
      command: "echo",
      args: ["hello"],
      workspaceRoot
    }, { platform });

    assert.equal(argv.ok, true);
    assert.deepEqual(platform.executedCommands[1], {
      command: "echo",
      args: ["hello"],
      cwd: workspaceRoot
    });
  });

  it("rejects model-authored host pip installs unless they target a local virtual environment", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    const rejected = await invoke(coreToolIds.shellRun, {
      command: "pip3 install --break-system-packages 'numpy<2' 2>&1 | tail -5",
      workspaceRoot
    }, { platform });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "HOST_PACKAGE_INSTALL_REJECTED");
    assert.equal(platform.executedCommands.length, 0);

    const localVenv = await invoke(coreToolIds.shellRun, {
      command: "source .venv/bin/activate && pip install numpy",
      cwd: ".deepseek/swebench-workspaces/astropy__astropy-12907/repo",
      workspaceRoot
    }, { platform });

    assert.equal(localVenv.ok, true);
    assert.equal(platform.executedCommands.length, 1);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", "set -o pipefail; source .venv/bin/activate && pip install numpy"],
      cwd: `${workspaceRoot}/.deepseek/swebench-workspaces/astropy__astropy-12907/repo`
    });
  });

  it("binds governed SWE-bench Lite checkout shell commands to the checkout-local virtualenv", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/swe-lite-runs/unit-run/repo`;

    const result = await invoke(coreToolIds.shellRun, {
      command: `cd ${repoRoot} && pip install -e . 2>&1 | tail -20`,
      timeoutMs: 300_000,
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", `set -o pipefail; PATH=${repoRoot}/.venv/bin:$PATH; export PATH; cd ${repoRoot} && python -m pip install -e . 2>&1 | tail -20`],
      cwd: repoRoot
    });
  });

  it("rewrites common container checkout aliases inside governed SWE-bench Lite shell commands", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/swe-lite-runs/unit-run/repo`;

    const result = await invoke(coreToolIds.shellRun, {
      command: "cd /home/user && python -m pytest astropy/io/ascii/tests/test_qdp.py -x -v --no-header -q 2>&1 | head -80",
      timeoutMs: 120_000,
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", `set -o pipefail; PATH=${repoRoot}/.venv/bin:$PATH; export PATH; cd ${repoRoot} && python -m pytest astropy/io/ascii/tests/test_qdp.py -x -v --no-header -q 2>&1 | head -80`],
      cwd: repoRoot
    });
    assert.equal(result.value?.evidence.metadata.sweLiteVenvBound, true);
  });

  it("binds governed SWE-bench Lite checkout argv pip commands through the checkout python", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/swe-lite-runs/unit-run/repo`;

    const result = await invoke(coreToolIds.shellRun, {
      command: "pip",
      args: ["install", "hypothesis"],
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: `${repoRoot}/.venv/bin/python`,
      args: ["-m", "pip", "install", "hypothesis"],
      cwd: repoRoot
    });
  });

  it("allows governed SWE-bench Lite checkout package installs after binding PATH to the checkout-local virtualenv", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/swe-lite-runs/unit-run/repo`;

    const result = await invoke(coreToolIds.shellRun, {
      command: `cd ${repoRoot} && pip install setuptools==68.0.0 2>&1 | tail -5`,
      timeoutMs: 300_000,
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", `set -o pipefail; PATH=${repoRoot}/.venv/bin:$PATH; export PATH; cd ${repoRoot} && python -m pip install setuptools==68.0.0 2>&1 | tail -5`],
      cwd: repoRoot
    });
  });

  it("gives governed SWE-bench Lite checkout package installs a long default timeout", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/swe-lite-runs/unit-run/repo`;

    const result = await invoke(coreToolIds.shellRun, {
      command: "pip install -e . 2>&1 | tail -5",
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(platform.commandTimeouts[0], 600_000);
  });

  it("runs model-authored test command strings through the host shell", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    const result = await invoke(coreToolIds.testRun, {
      command: "python -m pytest tests/unit -x -v 2>&1 | tail -40",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", "set -o pipefail; python -m pytest tests/unit -x -v 2>&1 | tail -40"],
      cwd: workspaceRoot
    });
    assert.equal(result.value?.evidence.metadata.shellSyntax, true);
  });

  it("runs test command strings with args through the host shell", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    const result = await invoke(coreToolIds.testRun, {
      command: "python -m pytest",
      args: ["astropy/io/ascii/tests/test_rst.py::test_rst_with_header_rows", "-xvs"],
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", "set -o pipefail; python -m pytest astropy/io/ascii/tests/test_rst.py::test_rst_with_header_rows -xvs"],
      cwd: workspaceRoot
    });
  });

  it("classifies standard test commands through shared ecosystem patterns", () => {
    assert.equal(isStandardTestCommand("python tests/runtests.py forms_tests.tests.test_media -v 2"), true);
    assert.equal(isStandardTestCommand("cd repo && python tests/runtests.py forms_tests.tests.test_media -v 2 | head -100"), true);
    assert.equal(isStandardTestCommand("python", ["-m", "django", "test", "forms_tests.tests.test_media"]), true);
    assert.equal(isStandardTestCommand("bash", ["-lc", "cd /mnt/c/repo && python tests/runtests.py forms_tests.tests.test_media -v 2 | head -100"]), true);
    assert.equal(isStandardTestCommand("wsl.exe", ["bash", "-lc", "cd /mnt/c/repo && python tests/runtests.py forms_tests.tests.test_media -v 2"]), true);
    assert.equal(isStandardTestCommand("wsl", ["-e", "bash", "-lc", "python tests/runtests.py forms_tests.tests.test_media -v 2"]), true);
    assert.equal(isStandardTestCommand("wsl.exe", ["--shell-type", "standard", "--cd", "/mnt/c/repo", "--", "bash", "-lc", "python -m pytest tests/test_demo.py"]), true);
    assert.equal(isStandardTestCommand("wsl.exe --cd /mnt/c/repo python -m pytest tests/test_demo.py"), true);
    assert.equal(isStandardTestCommand("pwsh", ["-NoProfile", "-Command", "cd repo; python .\\tests\\runtests.py forms_tests.tests.test_media -v 2 | Select-Object -First 100"]), true);
    assert.equal(isStandardTestCommand("cmd.exe", ["/d", "/s", "/c", "python tests\\runtests.py forms_tests.tests.test_media -v 2"]), true);
    assert.equal(isStandardTestCommand("C:\\Python311\\python.exe .\\tests\\runtests.py forms_tests.tests.test_media -v 2"), true);
    assert.equal(isStandardTestCommand("npm run test -- --watch=false"), true);
    assert.equal(isStandardTestCommand("go test ./..."), true);
    assert.equal(isStandardTestCommand("cargo test --workspace"), true);
    assert.equal(isStandardTestCommand("python -c \"import django\""), false);
  });

  it("does not duplicate python -c when the command string already includes it", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    const result = await invoke(coreToolIds.testRun, {
      command: "python -c",
      args: ["-c", "print(123)"],
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", "set -o pipefail; python -c 'print(123)'"],
      cwd: workspaceRoot
    });
  });

  it("binds governed SWE-bench Lite checkout test commands to the checkout-local virtualenv", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/swe-lite-runs/unit-run/repo`;

    const result = await invoke(coreToolIds.testRun, {
      command: "python -m pytest",
      args: ["astropy/io/ascii/tests/test_rst.py", "-x", "-v"],
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", `set -o pipefail; PATH=${repoRoot}/.venv/bin:$PATH; export PATH; python -m pytest astropy/io/ascii/tests/test_rst.py -x -v`],
      cwd: repoRoot
    });
    assert.equal(platform.commandTimeouts[0], 600_000);
    assert.equal(result.value?.evidence.metadata.sweLiteVenvBound, true);
  });

  it("classifies missing Python test dependencies instead of returning an opaque pytest failure", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 4,
      stdout: "",
      stderr: [
        "ImportError while loading conftest '/workspace/conftest.py'.",
        "conftest.py:9: in <module>",
        "    import hypothesis",
        "E   ModuleNotFoundError: No module named 'hypothesis'"
      ].join("\n")
    };

    const result = await invoke(coreToolIds.testRun, {
      command: "python -m pytest",
      args: ["astropy/io/ascii/tests/test_rst.py", "-x", "-v"],
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_DEPENDENCY_MISSING/);
    assert.match(result.value?.evidence.preview?.text ?? "", /python -m pip install hypothesis/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.kind, "python-missing-module");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.moduleName, "hypothesis");
  });

  it("classifies Python interpreter no-module output as a missing test dependency", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 1,
      stdout: "",
      stderr: "/workspace/.deepseek/swe-lite-runs/unit-run/repo/.venv/bin/python: No module named pytest"
    };

    const result = await invoke(coreToolIds.testRun, {
      command: "python -m pytest",
      args: ["astropy/io/ascii/tests/test_rst.py", "-x", "-v"],
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_DEPENDENCY_MISSING/);
    assert.match(result.value?.evidence.preview?.text ?? "", /python -m pip install pytest/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.kind, "python-missing-module");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.moduleName, "pytest");
  });

  it("points pytest-missing SWE-bench checks at repo-local Python test runners when present", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/swe-lite-runs/unit-run/repo`;
    await platform.writeFile(`${repoRoot}/tests/runtests.py`, "# repo-local test runner\n");
    platform.nextProcessResult = {
      exitCode: 1,
      stdout: "",
      stderr: `${repoRoot}/.venv/bin/python: No module named pytest`
    };

    const result = await invoke(coreToolIds.testRun, {
      command: "python -m pytest",
      args: ["tests/invalid_models_tests/test_ordinary_fields.py", "-xvs"],
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_DEPENDENCY_MISSING/);
    assert.match(result.value?.evidence.preview?.text ?? "", /Repo-local Python test runner is available at 'tests\/runtests.py'/);
    assert.match(result.value?.evidence.preview?.text ?? "", /python tests\/runtests.py/);
    assert.doesNotMatch(result.value?.evidence.preview?.text ?? "", /python -m pip install pytest/);
    const testFailure = result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string; suggestedCommand?: string; alternateCommand?: string } | undefined;
    assert.equal(testFailure?.kind, "python-missing-module");
    assert.equal(testFailure?.moduleName, "pytest");
    assert.equal(testFailure?.suggestedCommand, "python tests/runtests.py");
    assert.equal(testFailure?.alternateCommand, "python tests/runtests.py");
  });

  it("points missing Python test launchers at repo-local runners without dependency-install advice", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/swe-lite-runs/unit-run/repo`;
    await platform.writeFile(`${repoRoot}/tests/runtests.py`, "# repo-local test runner\n");
    platform.nextProcessResult = {
      exitCode: 1,
      stdout: "",
      stderr: `${repoRoot}/.venv/bin/python: No module named nose`
    };

    const result = await invoke(coreToolIds.testRun, {
      command: "python",
      args: ["-m", "nose", "tests/test_demo.py"],
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_DEPENDENCY_MISSING/);
    assert.match(result.value?.evidence.preview?.text ?? "", /Repo-local Python test runner is available at 'tests\/runtests.py'/);
    assert.match(result.value?.evidence.preview?.text ?? "", /python tests\/runtests.py/);
    assert.doesNotMatch(result.value?.evidence.preview?.text ?? "", /python -m pip install nose/);
    const testFailure = result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string; suggestedCommand?: string; alternateCommand?: string; suggestedAction?: string } | undefined;
    assert.equal(testFailure?.kind, "python-missing-module");
    assert.equal(testFailure?.moduleName, "nose");
    assert.equal(testFailure?.suggestedAction, "use-repo-local-python-test-runner");
    assert.equal(testFailure?.suggestedCommand, "python tests/runtests.py");
    assert.equal(testFailure?.alternateCommand, "python tests/runtests.py");
  });

  it("adds repo-local runner hints to shell pytest failures inside SWE-bench checkouts", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/swe-lite-runs/unit-run/repo`;
    await platform.writeFile(`${repoRoot}/tests/runtests.py`, "# repo-local test runner\n");
    platform.nextProcessResult = {
      exitCode: 1,
      stdout: "",
      stderr: `${repoRoot}/.venv/bin/python: No module named pytest`
    };

    const result = await invoke(coreToolIds.shellRun, {
      command: "python -m pytest tests/invalid_models_tests/test_ordinary_fields.py -xvs 2>&1 | tail -30",
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /Repo-local Python test runner is available at 'tests\/runtests.py'/);
    assert.doesNotMatch(result.value?.evidence.preview?.text ?? "", /python -m pip install pytest/);
    assert.equal((result.value?.evidence.metadata.testFailure as { suggestedCommand?: string; alternateCommand?: string } | undefined)?.suggestedCommand, "python tests/runtests.py");
    assert.equal((result.value?.evidence.metadata.testFailure as { alternateCommand?: string } | undefined)?.alternateCommand, "python tests/runtests.py");
  });

  it("classifies legacy numpy API pytest crashes as checkout dependency incompatibility", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 3,
      stdout: [
        "INTERNALERROR> Traceback (most recent call last):",
        "INTERNALERROR>   File \"/workspace/repo/.venv/lib/python3.9/site-packages/_pytest/main.py\", line 285, in wrap_session",
        "INTERNALERROR>     config._do_configure()",
        "INTERNALERROR> AttributeError: module 'numpy' has no attribute 'product'"
      ].join("\n"),
      stderr: ""
    };

    const result = await invoke(coreToolIds.testRun, {
      command: "python -m pytest",
      args: ["astropy/wcs/tests/test_wcs.py", "-x", "-v"],
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_DEPENDENCY_INCOMPATIBLE/);
    assert.match(result.value?.evidence.preview?.text ?? "", /python -m pip install 'numpy<2'/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; dependencyName?: string } | undefined)?.kind, "python-dependency-incompatible");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; dependencyName?: string } | undefined)?.dependencyName, "numpy");
  });

  it("classifies missing Python test runner files as invalid test command feedback", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 2,
      stdout: "",
      stderr: "python: can't open file '/workspace/repo/runtests.py': [Errno 2] No such file or directory"
    };

    const result = await invoke(coreToolIds.testRun, {
      command: "python",
      args: ["runtests.py", "forms_tests.tests.test_media"],
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_ENTRYPOINT_MISSING/);
    assert.match(result.value?.evidence.preview?.text ?? "", /Find the repo-local test runner before retrying/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; missingPath?: string } | undefined)?.kind, "python-test-entrypoint-missing");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; missingPath?: string } | undefined)?.missingPath, "/workspace/repo/runtests.py");
  });

  it("classifies unsupported Python test runner flags and suggests the accepted spelling", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 2,
      stdout: [
        "usage: runtests.py [-h] [-v {0,1,2,3}] [--noinput] [--failfast]",
        "runtests.py: error: unrecognized arguments: --no-input"
      ].join("\n"),
      stderr: ""
    };

    const result = await invoke(coreToolIds.testRun, {
      command: "python",
      args: ["tests/runtests.py", "forms_tests.tests.test_media", "--no-input"],
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_ARGUMENT_UNSUPPORTED/);
    assert.match(result.value?.evidence.preview?.text ?? "", /Use '--noinput' instead of '--no-input'/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; unsupportedOption?: string; suggestedOption?: string } | undefined)?.kind, "python-test-argument-unsupported");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; unsupportedOption?: string; suggestedOption?: string } | undefined)?.unsupportedOption, "--no-input");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; unsupportedOption?: string; suggestedOption?: string } | undefined)?.suggestedOption, "--noinput");
  });

  it("classifies Python test command environment scope failures without suggesting package installs", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 1,
      stdout: "",
      stderr: [
        "Traceback (most recent call last):",
        "  File \"<frozen importlib._bootstrap>\", line 1147, in _find_and_load_unlocked",
        "ModuleNotFoundError: No module named 'test_sqlite'"
      ].join("\n")
    };

    const result = await invoke(coreToolIds.shellRun, {
      command: "python -m django test tests.invalid_models_tests.test_ordinary_fields.FilePathFieldTests --settings=test_sqlite --verbosity=2",
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_COMMAND_ENV_MISSCOPED/);
    assert.doesNotMatch(result.value?.evidence.preview?.text ?? "", /pip install test_sqlite/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.kind, "python-test-command-env-misscoped");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.moduleName, "test_sqlite");
  });

  it("classifies dotted Django settings module scope failures without suggesting package installs", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 1,
      stdout: "",
      stderr: [
        "Traceback (most recent call last):",
        "  File \"<frozen importlib._bootstrap>\", line 1147, in _find_and_load_unlocked",
        "ModuleNotFoundError: No module named 'test_sqlite'"
      ].join("\n")
    };

    const result = await invoke(coreToolIds.shellRun, {
      command: "python -m django test tests.invalid_models_tests.test_ordinary_fields.FilePathFieldTests --settings=tests.test_sqlite --verbosity=2",
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_COMMAND_ENV_MISSCOPED/);
    assert.doesNotMatch(result.value?.evidence.preview?.text ?? "", /pip install test_sqlite/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.kind, "python-test-command-env-misscoped");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.moduleName, "test_sqlite");
  });

  it("classifies checkout-local Python test module scope failures without suggesting package installs", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 1,
      stdout: "",
      stderr: [
        "Traceback (most recent call last):",
        "  File \"<frozen importlib._bootstrap>\", line 1147, in _find_and_load_unlocked",
        "ModuleNotFoundError: No module named 'invalid_models_tests'"
      ].join("\n")
    };

    const result = await invoke(coreToolIds.shellRun, {
      command: "DJANGO_SETTINGS_MODULE=tests.test_sqlite python -m unittest tests.invalid_models_tests.test_ordinary_fields.FilePathFieldTests",
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_COMMAND_ENV_MISSCOPED/);
    assert.doesNotMatch(result.value?.evidence.preview?.text ?? "", /pip install invalid_models_tests/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.kind, "python-test-command-env-misscoped");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.moduleName, "invalid_models_tests");
  });

  it("classifies model-authored shell Python test failures with the same feedback as test.run", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 4,
      stdout: "",
      stderr: [
        "ImportError while loading conftest '/workspace/conftest.py'.",
        "conftest.py:9: in <module>",
        "    import hypothesis",
        "E   ModuleNotFoundError: No module named 'hypothesis'"
      ].join("\n")
    };

    const result = await invoke(coreToolIds.shellRun, {
      command: "python -m pytest astropy/io/ascii/tests/test_rst.py -x -v 2>&1 | tail -40",
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_DEPENDENCY_MISSING/);
    assert.match(result.value?.evidence.preview?.text ?? "", /python -m pip install hypothesis/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.kind, "python-missing-module");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.moduleName, "hypothesis");
  });

  it("allows governed SWE-bench Lite checkout installs through an absolute checkout-local virtualenv", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/swe-lite-runs/unit-run/repo`;

    const result = await invoke(coreToolIds.shellRun, {
      command: `python3 -m venv ${repoRoot}/.venv && source ${repoRoot}/.venv/bin/activate && pip install pytest numpy 2>&1 | tail -5`,
      timeoutMs: 300_000,
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", `set -o pipefail; PATH=${repoRoot}/.venv/bin:$PATH; export PATH; python3 -m venv ${repoRoot}/.venv && source ${repoRoot}/.venv/bin/activate && python -m pip install pytest numpy 2>&1 | tail -5`],
      cwd: repoRoot
    });
  });

  it("allows SWE-bench shell commands to invoke the benchmark-local virtualenv by absolute path", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    const result = await invoke(coreToolIds.shellRun, {
      command: `${workspaceRoot}/.deepseek/swebench-workspaces/astropy__astropy-12907/repo/.venv/bin/python3 test_regression_separability.py`,
      cwd: ".deepseek/swebench-workspaces/astropy__astropy-12907/repo",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", `set -o pipefail; ${workspaceRoot}/.deepseek/swebench-workspaces/astropy__astropy-12907/repo/.venv/bin/python3 test_regression_separability.py`],
      cwd: `${workspaceRoot}/.deepseek/swebench-workspaces/astropy__astropy-12907/repo`
    });
  });

  it("rejects SWE-bench commands that replace the checkout with the same package from an index", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    const rejected = await invoke(coreToolIds.shellRun, {
      command: "source .venv/bin/activate && pip install astropy 2>&1 | tail -10",
      cwd: ".deepseek/swebench-workspaces/astropy__astropy-12907/repo",
      workspaceRoot
    }, { platform });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "SWE_BENCH_BOUNDARY_REJECTED");
    assert.equal(platform.executedCommands.length, 0);

    const editableLocal = await invoke(coreToolIds.shellRun, {
      command: "source .venv/bin/activate && pip install -e .[test]",
      cwd: ".deepseek/swebench-workspaces/astropy__astropy-12907/repo",
      workspaceRoot
    }, { platform });

    assert.equal(editableLocal.ok, true);
    assert.equal(platform.executedCommands.length, 1);
  });

  it("rejects SWE-bench shell history mining while keeping workspace status commands available", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    const rejected = await invoke(coreToolIds.shellRun, {
      command: "git log --all --oneline -- astropy/modeling/separable.py | head -10",
      cwd: ".deepseek/swebench-workspaces/astropy__astropy-12907/repo",
      workspaceRoot
    }, { platform });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "SWE_BENCH_BOUNDARY_REJECTED");
    assert.equal(platform.executedCommands.length, 0);

    const status = await invoke(coreToolIds.shellRun, {
      command: "git status --short",
      cwd: ".deepseek/swebench-workspaces/astropy__astropy-12907/repo",
      workspaceRoot
    }, { platform });

    assert.equal(status.ok, true);
    assert.equal(platform.executedCommands.length, 1);
  });

  it("rejects direct traversal into historical SWE-bench workspaces from the CLI workspace root", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    const rejected = await invoke(coreToolIds.shellRun, {
      command: "cd .deepseek/swebench-workspaces/astropy__astropy-12907/repo && source .venv/bin/activate && python -m pytest astropy/modeling/tests/test_separable.py -v",
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "SWE_BENCH_BOUNDARY_REJECTED");
    assert.equal(platform.executedCommands.length, 0);
  });

  it("globs workspace files, views local assets, and reads bounded notebooks", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    await platform.writeFile(`${workspaceRoot}/src/app.ts`, "export const value = 1;");
    await platform.writeFile(`${workspaceRoot}/README.txt`, "hello asset");
    await platform.writeFile(`${workspaceRoot}/analysis.ipynb`, JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      cells: [
        { cell_type: "markdown", source: ["# Title\n", "body"], metadata: { safe: true, token: "redacted" } },
        { cell_type: "code", source: "print('x')", execution_count: 1, outputs: [{ output_type: "stream" }] }
      ]
    }));

    const glob = await invoke(coreToolIds.workspaceGlob, { pattern: "**/*.ts", workspaceRoot }, { platform });
    assert.equal(glob.ok, true);
    assert.match(glob.value?.evidence.preview?.text ?? "", /src\/app\.ts/);

    const asset = await invoke(coreToolIds.assetViewLocal, { path: "README.txt", workspaceRoot, limitBytes: 20 }, { platform });
    assert.equal(asset.ok, true);
    assert.equal(asset.value?.evidence.metadata.mime, "text/plain");
    assert.match(asset.value?.evidence.preview?.text ?? "", /hello asset/);

    const notebook = await invoke(coreToolIds.notebookRead, { path: "analysis.ipynb", workspaceRoot, maxCells: 1, maxSourceBytes: 8 }, { platform });
    assert.equal(notebook.ok, true);
    assert.equal(notebook.value?.evidence.metadata.cellCount, 2);
    assert.equal(notebook.value?.evidence.metadata.truncatedCells, true);

    const malformed = await invoke(coreToolIds.notebookRead, { path: "README.txt", workspaceRoot }, { platform });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error?.code, "NOTEBOOK_EXTENSION_UNSUPPORTED");

    const rejected = await invoke(coreToolIds.workspaceGlob, { pattern: "../**/*.ts", workspaceRoot }, { platform });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "GLOB_PATTERN_REJECTED");
  });

  it("bounds file evidence without splitting Unicode surrogate pairs", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    await platform.writeFile(`${workspaceRoot}/README.md`, `${"a".repeat(7999)}🧠tail`);

    const read = await invoke(coreToolIds.fileRead, { path: "README.md", workspaceRoot, limitBytes: 8000 }, { platform });
    const preview = read.value?.evidence.preview?.text ?? "";

    assert.equal(read.ok, true);
    assert.equal(read.value?.evidence.preview?.truncated, true);
    assert.equal(Buffer.byteLength(preview, "utf8") <= 8000, true);
    assert.equal(hasLoneSurrogate(preview), false);
  });

  it("writes and exact-edits with transactions, then rejects ambiguous edits without mutation", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);

    const write = await invoke(coreToolIds.fileWrite, { path: "app.ts", content: "one two one", workspaceRoot }, { platform, workspaceState });
    assert.equal(write.ok, true);

    const nestedWrite = await invoke(coreToolIds.fileWrite, { path: "generated-webpage/index.html", content: "<h1>ok</h1>", workspaceRoot }, { platform, workspaceState });
    assert.equal(nestedWrite.ok, true);
    assert.equal(await platform.readFile(`${workspaceRoot}/generated-webpage/index.html`), "<h1>ok</h1>");

    const rejected = await invoke(coreToolIds.fileEdit, { path: "app.ts", expected: "one", replacement: "three", workspaceRoot }, { platform, workspaceState });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "EDIT_PRECONDITION_FAILED");
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "one two one");

    const edited = await invoke(coreToolIds.fileEdit, { path: "app.ts", expected: "two", replacement: "three", workspaceRoot }, { platform, workspaceState });
    assert.equal(edited.ok, true);
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "one three one");
    assert.equal(workspaceState.records().length, 3);
    const checkpoint = edited.value?.evidence.metadata.checkpoint as { checkpointId?: string; beforeHash?: string; afterHash?: string } | undefined;
    assert.equal(typeof checkpoint?.checkpointId, "string");
    assert.notEqual(checkpoint?.beforeHash, checkpoint?.afterHash);
    const undo = await workspaceState.undoLatest({ path: `${workspaceRoot}/app.ts` });
    assert.equal(undo.ok, true);
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "one two one");
  });

  it("rejects exact file edits that would leave the file unchanged", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);
    await platform.writeFile(`${workspaceRoot}/app.ts`, "one two");

    const result = await invoke(coreToolIds.fileEdit, { path: "app.ts", expected: "two", replacement: "two", workspaceRoot }, { platform, workspaceState });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "EDIT_NOOP");
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "one two");
    assert.equal(workspaceState.records().length, 0);
    assert.equal(workspaceState.checkpoints().length, 0);
  });

  it("applies multi-hunk patches transactionally and reverts checkpoints safely", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);
    await platform.writeFile(`${workspaceRoot}/app.ts`, "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");

    const patch = [
      "--- a/app.ts",
      "+++ b/app.ts",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "@@ -5,3 +5,3 @@",
      " five",
      "-six",
      "+SIX",
      " seven",
      ""
    ].join("\n");
    const applied = await invoke(coreToolIds.patchApply, { patch, workspaceRoot }, { platform, workspaceState });
    assert.equal(applied.ok, true);
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "one\nTWO\nthree\nfour\nfive\nSIX\nseven\n");
    assert.equal(workspaceState.checkpoints().length, 1);

    const preview = await invoke(coreToolIds.revertUndo, { path: "app.ts", workspaceRoot, dryRun: true }, { platform, workspaceState });
    assert.equal(preview.ok, true);
    assert.match(preview.value?.evidence.preview?.text ?? "", /checkpoint-/);

    const undone = await invoke(coreToolIds.revertUndo, { path: "app.ts", workspaceRoot }, { platform, workspaceState });
    assert.equal(undone.ok, true);
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  });

  it("rejects failed patches without mutating target files and rejects stale undo", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);
    await platform.writeFile(`${workspaceRoot}/app.ts`, "alpha\nbeta\n");

    const failed = await invoke(coreToolIds.patchApply, { patch: "--- a/app.ts\n+++ b/app.ts\n@@ -1,1 +1,1 @@\n-missing\n+changed\n", workspaceRoot }, { platform, workspaceState });
    assert.equal(failed.ok, false);
    assert.equal(failed.error?.code, "PATCH_PRECONDITION_FAILED");
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "alpha\nbeta\n");

    const applied = await invoke(coreToolIds.patchApply, { patch: "--- a/app.ts\n+++ b/app.ts\n@@ -1,1 +1,1 @@\n-alpha\n+ALPHA\n", workspaceRoot }, { platform, workspaceState });
    assert.equal(applied.ok, true);
    await platform.writeFile(`${workspaceRoot}/app.ts`, "stale\n");
    const stale = await invoke(coreToolIds.revertUndo, { path: "app.ts", workspaceRoot }, { platform, workspaceState });
    assert.equal(stale.ok, false);
    assert.equal(stale.error?.code, "CHECKPOINT_STALE_FILE");
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "stale\n");
  });

  it("rejects path escapes before reading or mutating", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    await platform.writeFile(`${workspaceRoot}/safe.txt`, "safe");

    const read = await invoke(coreToolIds.fileRead, { path: "../secret.txt", workspaceRoot }, { platform });
    assert.equal(read.ok, false);
    assert.equal(read.error?.code, "PATH_REJECTED");

    const write = await invoke(coreToolIds.fileWrite, { path: "../secret.txt", content: "bad", workspaceRoot }, { platform });
    assert.equal(write.ok, false);
    await assert.rejects(() => platform.readFile("/secret.txt"));
  });

  it("runs shell, git, test, and todo tools with structured evidence", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    await platform.writeFile(`${workspaceRoot}/package.json`, JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }));

    const shell = await invoke(coreToolIds.shellRun, { command: "echo", args: ["ok"], workspaceRoot }, { platform });
    assert.equal(shell.ok, true);
    assert.equal(shell.value?.evidence.provider?.selectedProvider, "argv");

    const git = await invoke(coreToolIds.gitStatus, { workspaceRoot }, { platform });
    assert.equal(git.ok, true);
    assert.equal(git.value?.evidence.metadata.gitMode, "status");

    const history = await invoke(coreToolIds.gitHistoryBranch, { workspaceRoot, checkoutBranch: "feature/x" }, { platform });
    assert.equal(history.ok, true);
    assert.equal((history.value?.evidence.metadata.checkoutPreview as { applied?: boolean } | undefined)?.applied, false);

    const test = await invoke(coreToolIds.testRun, { command: "npm", args: ["test"], workspaceRoot, intent: "unit" }, { platform });
    assert.equal(test.ok, true);
    assert.equal(test.value?.evidence.metadata.intent, "unit");

    const absoluteWorkspaceTest = await invoke(coreToolIds.testRun, { command: "npm", args: ["test"], cwd: workspaceRoot, workspaceRoot, intent: "unit" }, { platform });
    assert.equal(absoluteWorkspaceTest.ok, true);
    assert.equal(platform.executedCommands.at(-1)?.cwd, workspaceRoot);

    const outsideWorkspaceTest = await invoke(coreToolIds.testRun, { command: "npm", args: ["test"], cwd: "/tmp/outside", workspaceRoot }, { platform });
    assert.equal(outsideWorkspaceTest.ok, false);
    assert.equal(outsideWorkspaceTest.error?.code, "PATH_REJECTED");

    const scripts = await invoke(coreToolIds.packageManager, { operation: "scripts", workspaceRoot }, { platform });
    assert.equal(scripts.ok, true);
    assert.equal(scripts.value?.evidence.metadata.scriptCount, 2);

    const install = await invoke(coreToolIds.packageManager, { operation: "install", packages: ["left-pad"], manager: "pnpm", workspaceRoot }, { platform });
    assert.equal(install.ok, true);
    assert.equal(install.value?.evidence.metadata.dryRun, true);

    const repl = await invoke(coreToolIds.replExecute, { code: "const a = 2; a + 3", workspaceRoot }, { platform });
    assert.equal(repl.ok, true);
    assert.match(repl.value?.evidence.preview?.text ?? "", /=> 5/);

    const plan = await invoke(coreToolIds.todoPlan, { items: [{ id: "1", title: "ship", status: "completed" }] }, { platform });
    assert.equal(plan.ok, true);
    assert.equal(plan.value?.evidence.metadata.count, 1);

    const repairedPlan = await invoke(coreToolIds.todoPlan, { items: [{ description: "write html", done: false }] }, { platform });
    assert.equal(repairedPlan.ok, true);
    assert.match(repairedPlan.value?.evidence.preview?.text ?? "", /pending: write html/);
  });

  it("reports platform-unavailable process diagnostics", async () => {
    const platform = new FakePlatformRuntime("linux", workspaceRoot, { environmentKind: "remote", noLocalShell: true });
    const result = await invoke(coreToolIds.shellRun, { command: "echo", args: ["ok"], workspaceRoot }, { platform });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "PROCESS_UNAVAILABLE");
  });
});

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
