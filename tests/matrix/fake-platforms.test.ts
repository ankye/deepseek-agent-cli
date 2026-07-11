import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryCapabilityRegistry } from "@deepseek/capability-registry";
import { coreToolIds, registerCoreCodingTools } from "@deepseek/core-coding-tools";
import { NodePlatformRuntime } from "@deepseek/platform-abstraction";
import { asId } from "@deepseek/platform-contracts";
import type { CapabilityExecutionContext, ExecutionEnvelope, TraceContext } from "@deepseek/platform-contracts";
import { analyzeResourceScope, createSandboxAuditEvidence, createSandboxRequirement, createSecretRedactionDecision } from "@deepseek/policy-sandbox";
import { createFakePlatformMatrix, getReferencePitFixture } from "@deepseek/testing-regression";
import { InMemoryWorkspaceStateManager } from "@deepseek/workspace-state-management";

describe("fake platform matrix", () => {
  it("covers macOS, Windows, Linux, WSL, CI, and remote host modes", async () => {
    const matrix = createFakePlatformMatrix();
    const descriptors = await Promise.all(matrix.map((platform) => platform.descriptor()));

    assert.deepEqual(descriptors.map((descriptor) => `${descriptor.os}:${descriptor.environmentKind}`), [
      "macos:local",
      "windows:local",
      "linux:local",
      "linux:wsl",
      "linux:ci",
      "linux:remote",
      "linux:local",
      "linux:local"
    ]);
    assert.equal(descriptors.some((descriptor) => descriptor.environmentKind === "remote" && descriptor.processProvider.status === "unavailable"), true);
    assert.equal(descriptors.some((descriptor) => descriptor.environmentKind === "ci" && descriptor.secureStorage.status === "unavailable"), true);
    assert.equal(descriptors.some((descriptor) => descriptor.sandbox.filesystem.readOnly), true);
    assert.equal(descriptors.some((descriptor) => descriptor.sandbox.network.providerStatus === "unavailable"), true);
  });

  it("covers config paths, workspace metadata paths, and atomic write behavior", async () => {
    const matrix = createFakePlatformMatrix();
    const userPaths = matrix.map((platform) => platform.userConfigPath("deepseek"));

    assert.equal(userPaths.some((path) => path.includes("AppData")), true);
    assert.equal(userPaths.some((path) => path.includes("Application Support")), true);
    assert.equal(userPaths.some((path) => path.includes(".config")), true);

    for (const platform of matrix) {
      const metadata = platform.workspaceMetadataPath("/repo", "deepseek");
      assert.equal(metadata.ok, true);
      assert.equal(metadata.value?.includes(".deepseek"), true);
      const write = await platform.atomicWriteFile(metadata.value ?? "/repo/.deepseek/config.json", "{}");
      assert.equal(write.ok, (await platform.descriptor()).sandbox.filesystem.readOnly ? false : true);
      assert.equal((await platform.permissionDiagnostics(metadata.value ?? "")).length > 0, true);
    }
  });

  it("covers path rejection, WSL translation, search fallback, and unavailable providers", async () => {
    const matrix = createFakePlatformMatrix();
    const wsl = matrix.find((platform) => platform.environmentKind === "wsl");
    const ci = matrix.find((platform) => platform.environmentKind === "ci");
    const remote = matrix.find((platform) => platform.environmentKind === "remote");

    assert.ok(wsl);
    assert.ok(ci);
    assert.ok(remote);

    assert.equal(wsl.resolveWorkspacePath("/repo", "../escape").ok, false);
    assert.equal(wsl.translatePath("/mnt/c/Users/dev/repo", "local").value?.translatedPath.includes("C:"), true);

    const ciSearch = await ci.selectSearchProvider();
    assert.equal(ciSearch.provider, "js");
    assert.equal(ciSearch.status, "degraded");

    assert.equal((await remote.resolveShell("bash")).ok, false);
    assert.equal((await remote.runProcess("echo", ["ok"])).exitCode, 126);
    assert.equal((await ci.secureStorageCapability()).status, "unavailable");
    assert.equal((await ci.probeNativeCapability("clipboard")).status, "unavailable");
  });

  it("rejects reference pit path canonicalization bypass syntaxes", () => {
    const fixture = getReferencePitFixture("pit.path-canonicalization.unsafe-syntax");
    assert.equal(fixture?.evidenceIds.includes("platform:path-unsafe-syntax"), true);
    const platform = createFakePlatformMatrix().find((candidate) => candidate.os === "windows");
    assert.ok(platform);

    const unsafePaths = [
      "~/.deepseek/config.json",
      "C:relative.txt",
      "\\\\server\\share\\repo\\file.txt",
      "../escape.txt",
      "dir/trailing. /file.txt",
      "dir/trailing-space /file.txt",
      "$(pwd)/file.txt",
      "src/*.ts",
      "src/[secret].ts",
      "null\0byte.txt"
    ];

    for (const path of unsafePaths) {
      const resolved = platform.resolveWorkspacePath("C:/workspace/windows", path);
      assert.equal(resolved.ok, false, `${path} should be rejected`);
      assert.equal(resolved.error?.code === "PLATFORM_PATH_REJECTED" || resolved.error?.code === "PLATFORM_PATH_OUTSIDE_ROOT", true);
    }

    const safe = platform.resolveWorkspacePath("C:/workspace/windows", "src/index.ts");
    assert.equal(safe.ok, true);
    assert.equal(safe.value?.relativePath.replace(/\\/g, "/"), "src/index.ts");
  });

  it("canonicalizes workspace relative paths according to platform filesystem semantics", () => {
    const windows = createFakePlatformMatrix().find((platform) => platform.os === "windows");
    const linux = createFakePlatformMatrix().find((platform) => platform.os === "linux" && platform.environmentKind === "local");
    assert.ok(windows);
    assert.ok(linux);

    const windowsPath = windows.resolveWorkspacePath("C:/Workspace/Repo", "Src/Readme.MD");
    const linuxPath = linux.resolveWorkspacePath("/workspace/linux", "Src/Readme.MD");

    assert.equal(windowsPath.ok, true);
    assert.equal(windowsPath.value?.relativePath.replace(/\\/g, "/"), "src/readme.md");
    assert.equal(linuxPath.ok, true);
    assert.equal(linuxPath.value?.relativePath.replace(/\\/g, "/"), "Src/Readme.MD");
  });

  it("resolves Node platform workspace paths with declared OS semantics", () => {
    const windows = new NodePlatformRuntime("windows", { environmentKind: "local", noLocalShell: true });
    const linux = new NodePlatformRuntime("linux", { environmentKind: "local", noLocalShell: true });

    const windowsContained = windows.resolveWorkspacePath("C:/Workspace/Repo", "C:/workspace/repo/Src/Readme.MD");
    const windowsOutsideDrive = windows.resolveWorkspacePath("C:/Workspace/Repo", "D:/workspace/repo/Src/Readme.MD");
    const linuxContained = linux.resolveWorkspacePath("/workspace/repo", "/workspace/repo/Src/Readme.MD");
    const linuxCaseMismatch = linux.resolveWorkspacePath("/Workspace/Repo", "/workspace/repo/Src/Readme.MD");

    assert.equal(windowsContained.ok, true);
    assert.equal(windowsContained.value?.relativePath.replace(/\\/g, "/"), "src/readme.md");
    assert.equal(windowsOutsideDrive.ok, false);
    assert.equal(linuxContained.ok, true);
    assert.equal(linuxContained.value?.relativePath.replace(/\\/g, "/"), "Src/Readme.MD");
    assert.equal(linuxCaseMismatch.ok, false);
  });

  it("resolves Node macOS case-equivalent absolute paths without parent traversal", () => {
    const macos = new NodePlatformRuntime("macos", { environmentKind: "local", noLocalShell: true });
    const resolved = macos.resolveWorkspacePath("/Workspace/Repo", "/workspace/repo/Src/Readme.MD");

    assert.equal(resolved.ok, true);
    assert.equal(resolved.value?.relativePath.replace(/\\/g, "/"), "src/readme.md");
    assert.equal(resolved.value?.relativePath.includes(".."), false);
  });

  it("covers core tool path, search, process, and output bounding behavior across the fake matrix", async () => {
    const matrix = createFakePlatformMatrix();

    for (const platform of matrix) {
      if ((await platform.descriptor()).sandbox.filesystem.readOnly) continue;
      const workspaceRoot = platform.os === "windows" ? "C:/workspace/windows" : `/workspace/${platform.environmentKind}`;
      await platform.writeFile(`${workspaceRoot}/README.md`, `matrix ${platform.environmentKind}\n${"x".repeat(80)}`);
      const registry = new InMemoryCapabilityRegistry();
      await registerCoreCodingTools(registry, { platform, workspaceState: new InMemoryWorkspaceStateManager(), workspaceRoot });

      const read = await (await registry.resolveExecutable(coreToolIds.fileRead))?.execute(
        { path: "README.md", workspaceRoot, limitBytes: 10 },
        context(coreToolIds.fileRead)
      );
      assert.equal(read?.ok, true);
      assert.equal((read?.value as { evidence?: { preview?: { truncated?: boolean } } } | undefined)?.evidence?.preview?.truncated, true);

      const rejected = await (await registry.resolveExecutable(coreToolIds.fileRead))?.execute(
        { path: "../escape.txt", workspaceRoot },
        context(coreToolIds.fileRead)
      );
      assert.equal(rejected?.ok, false);

      const search = await (await registry.resolveExecutable(coreToolIds.searchText))?.execute(
        { pattern: "matrix", workspaceRoot },
        context(coreToolIds.searchText)
      );
      assert.equal(search?.ok, true);

      const test = await (await registry.resolveExecutable(coreToolIds.testRun))?.execute(
        { command: "npm", args: ["test"], workspaceRoot },
        context(coreToolIds.testRun)
      );
      assert.equal(test?.ok, platform.environmentKind !== "remote");
      if (platform.environmentKind === "remote") {
        assert.equal(test?.error?.code, "PROCESS_UNAVAILABLE");
      }
    }
  });
});

function context(capabilityId: (typeof coreToolIds)[keyof typeof coreToolIds]): CapabilityExecutionContext {
  const trace: TraceContext = {
    traceId: asId<"trace">("trace-matrix"),
    spanId: asId<"span">("span-matrix"),
    correlationId: asId<"correlation">("corr-matrix"),
    sessionId: asId<"session">("session-matrix")
  };
  return {
    envelope: {
      invocationId: "invocation-matrix",
      capabilityId,
      capabilityVersion: "1.0.0",
      kind: "capability",
      caller: "matrix",
      sessionId: asId<"session">("session-matrix"),
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
      reasonCode: "test.matrix-context",
      subject: "matrix",
      resource: String(capabilityId),
      sandboxProfile: sandboxRequirements.profile
    })
  };
}
