import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryCapabilityRegistry } from "@deepseek/capability-registry";
import { coreToolIds, coreToolManifests, registerCoreCodingTools } from "@deepseek/core-coding-tools";
import { FakePlatformRuntime } from "@deepseek/platform-abstraction";
import { asId } from "@deepseek/platform-contracts";
import type { CapabilityExecutionContext, CoreToolResult, ExecutionEnvelope, SerializableResult, TraceContext } from "@deepseek/platform-contracts";
import { analyzeResourceScope, createSandboxAuditEvidence, createSandboxRequirement, createSecretRedactionDecision } from "@deepseek/policy-sandbox";
import { InMemoryWorkspaceStateManager } from "@deepseek/workspace-state-management";

const workspaceRoot = "/workspace";

describe("core coding tool contracts", () => {
  it("defines stable manifests with schema, replay, timeout, projection, and compatibility metadata", () => {
    const manifests = coreToolManifests();
    const ids = manifests.map((manifest) => String(manifest.id));

    assert.deepEqual(ids, [
      "core.file.read",
      "core.file.write",
      "core.file.edit",
      "core.text.replace",
      "core.file.list",
      "core.file.stat",
      "core.json.read",
      "core.checksum.hash",
      "core.path.resolve",
      "core.workspace.glob",
      "core.asset.view-local",
      "core.search.text",
      "core.code.diagnostics",
      "core.notebook.read",
      "core.notebook.edit",
      "core.patch.apply",
      "core.json.patch",
      "core.archive.create",
      "core.archive.extract",
      "core.session.resume",
      "core.session.fork",
      "core.memory.write",
      "core.memory.read",
      "core.compact.summary",
      "core.revert.undo",
      "core.file.copy",
      "core.file.move",
      "core.file.delete",
      "core.directory.create",
      "core.file.touch",
      "core.tool.search",
      "core.shell.run",
      "core.shell.output",
      "core.shell.kill",
      "core.repl.execute",
      "core.env.inspect",
      "core.command.lookup",
      "core.git.status",
      "core.git.diff",
      "core.git.history-branch",
      "core.test.run",
      "core.package.manager",
      "core.todo.plan",
      "core.user.input",
      "core.mode.plan.enter",
      "core.mode.plan.exit",
      "core.config.manage",
      "core.brief.package",
      "core.synthetic.output",
      "core.web.fetch",
      "core.web.search",
      "core.mcp.tool.call",
      "core.mcp.resource.list",
      "core.mcp.resource.read",
      "core.agent.spawn",
      "core.agent.continue",
      "core.agent.stop",
      "core.task.create",
      "core.task.get",
      "core.task.list",
      "core.task.update",
      "core.task.output",
      "core.team.create",
      "core.team.delete",
      "core.worktree.enter",
      "core.worktree.exit",
      "core.schedule.cron",
      "core.remote.trigger",
      "core.hook.list",
      "core.hook.run",
      "core.plugin.install",
      "core.plugin.verify",
      "core.skill.list",
      "core.skill.activate",
      "core.command.palette"
    ]);
    for (const manifest of manifests) {
      assert.equal(manifest.enabled, true);
      assert.equal(typeof manifest.description, "string");
      assert.equal(typeof manifest.inputSchema.type, "string");
      assert.equal(typeof manifest.outputSchema.type, "string");
      assert.equal(typeof manifest.timeoutMs, "number");
      assert.equal(manifest.replayPolicy?.replayable, true);
      assert.equal(manifest.projection?.modelVisible, true);
      assert.equal(manifest.projection?.executorVisible, false);
      assert.equal(manifest.compatibility?.schemaVersion, "1.0.0");
    }
  });

  it("projects model-visible schemas while executor bindings remain registry-only", async () => {
    const registry = new InMemoryCapabilityRegistry();
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    await registerCoreCodingTools(registry, { platform, workspaceState: new InMemoryWorkspaceStateManager(), workspaceRoot });

    const modelVisible = await registry.listModelVisible();
    assert.equal(modelVisible.some((manifest) => manifest.id === coreToolIds.fileRead), true);
    assert.equal("execute" in modelVisible[0]!, false);
    const direct = await registry.execute(coreToolIds.fileRead, { path: "README.md", workspaceRoot });
    assert.equal(direct.ok, false);
    assert.equal(direct.error?.code, "CAPABILITY_CONTEXT_REQUIRED");
    assert.equal(typeof (await registry.resolveExecutable(coreToolIds.fileRead))?.execute, "function");
  });

  it("keeps workspace edit transaction evidence replay-safe and records only successful mutations", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);
    const registry = new InMemoryCapabilityRegistry();
    await platform.writeFile(`${workspaceRoot}/app.ts`, "before");
    await registerCoreCodingTools(registry, { platform, workspaceState, workspaceRoot });

    const binding = await registry.resolveExecutable(coreToolIds.fileEdit);
    assert.ok(binding);
    const result = await binding.execute(
      { path: "app.ts", expected: "before", replacement: "after", workspaceRoot },
      context(coreToolIds.fileEdit)
    ) as SerializableResult<CoreToolResult>;

    assert.equal(result.ok, true);
    const transaction = result.value?.evidence.metadata.transaction as { beforeHash?: string; afterHash?: string; rollback?: { content?: string; contentHash?: string }; redaction?: { fields?: readonly string[] } } | undefined;
    const checkpoint = result.value?.evidence.metadata.checkpoint as { checkpointId?: string; beforeHash?: string; afterHash?: string } | undefined;
    assert.ok(transaction);
    assert.equal(transaction.beforeHash !== transaction.afterHash, true);
    assert.equal(transaction.rollback?.content, undefined);
    assert.equal(typeof transaction.rollback?.contentHash, "string");
    assert.equal(transaction.redaction?.fields?.includes("rollback.content"), true);
    assert.equal(typeof checkpoint?.checkpointId, "string");
    assert.equal(workspaceState.records().length, 1);
    assert.equal(workspaceState.checkpoints().length, 1);

    const failed = await binding.execute(
      { path: "app.ts", expected: "missing", replacement: "bad", workspaceRoot },
      context(coreToolIds.fileEdit)
    ) as SerializableResult<CoreToolResult>;
    assert.equal(failed.ok, false);
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "after");
    assert.equal(workspaceState.records().length, 1);
  });

  it("runs process tools with the governed noninteractive execution profile", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const registry = new InMemoryCapabilityRegistry();
    await registerCoreCodingTools(registry, { platform, workspaceState: new InMemoryWorkspaceStateManager(), workspaceRoot });

    const binding = await registry.resolveExecutable(coreToolIds.shellRun);
    assert.ok(binding);
    const result = await binding.execute(
      { command: "echo", args: ["ok"], workspaceRoot, cwd: "." },
      context(coreToolIds.shellRun)
    ) as SerializableResult<CoreToolResult>;

    assert.equal(result.ok, true);
    const preview = result.value?.evidence.preview?.text ?? "{}";
    const parsed = JSON.parse(preview) as { executionProfile?: string; stdin?: string };
    assert.equal(parsed.executionProfile, "noninteractive");
    assert.equal(parsed.stdin, "ignore");
    assert.equal(result.value?.evidence.provider?.diagnostics.some((diagnostic) => diagnostic.code === "PROCESS_NONINTERACTIVE_PROFILE"), true);
  });
});

function context(capabilityId: (typeof coreToolIds)[keyof typeof coreToolIds]): CapabilityExecutionContext {
  const trace: TraceContext = {
    traceId: asId<"trace">("trace-contract"),
    spanId: asId<"span">("span-contract"),
    correlationId: asId<"correlation">("corr-contract"),
    sessionId: asId<"session">("session-contract")
  };
  return {
    envelope: {
      invocationId: "invocation-contract",
      capabilityId,
      capabilityVersion: "1.0.0",
      kind: "capability",
      caller: "contract",
      sessionId: asId<"session">("session-contract"),
      inputSchema: {},
      outputSchema: {},
      redactionClass: "internal",
      provenance: {},
      trust: "trusted",
      permissions: [],
      sideEffect: "write",
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
  const resourceScope = analyzeResourceScope({}, "write");
  const sandboxRequirements = createSandboxRequirement({ sideEffect: "write", resourceScope, timeoutMs: 30_000, permissions: [] });
  return {
    secretExposure: createSecretRedactionDecision("", { class: "public" }),
    resourceScope,
    sandboxRequirements,
    audit: createSandboxAuditEvidence({
      decision: "test",
      reasonCode: "test.core-tool-contract",
      subject: "contract",
      resource: String(capabilityId),
      sandboxProfile: sandboxRequirements.profile
    })
  };
}
