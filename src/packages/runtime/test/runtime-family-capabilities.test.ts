import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ApprovalBroker, ApprovalRequest, JsonObject, PolicyEngine, PolicyRequest } from "@deepseek/platform-contracts";
import { asId, APPROVAL_SCHEMA_VERSION, TOOL_FAMILY_IDS } from "@deepseek/platform-contracts";
import {
  collectRuntimeEvents,
  createDefaultRuntimeKernel,
  platformFamilyCapabilityIds,
  registerRuntimeCoreTools,
  registerRuntimeFamilyCapabilities,
  runtimeEchoCapability,
  runtimeFamilyCapabilityIds
} from "../src/index.js";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";
import { FakePlatformRuntime } from "@deepseek/platform-abstraction";
import { buildReferenceToolArsenalReport } from "@deepseek/core-coding-tools";

describe("runtime family capabilities", () => {
  const hostAdapterOnlyFamilyIds = new Set<typeof TOOL_FAMILY_IDS[number]>(["benchmark.run"]);

  it("registers runtime-owned family tools as model-visible executable capabilities", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    const visible = await deps.capabilities.listModelVisible({
      allowedFamilyIds: [
        "mode.plan-auto-review",
        "user.input",
        "approval.permission",
        "pipeline.sequence",
        "pipeline.parallel",
        "pipeline.artifact-routing",
        "pipeline.stream",
        "agent.wait-result"
      ]
    });

    assert.deepEqual(
      [...new Set(visible.flatMap((manifest) => manifest.toolFamily?.familyId ? [manifest.toolFamily.familyId] : []))].sort(),
      [
        "agent.wait-result",
        "approval.permission",
        "mode.plan-auto-review",
        "pipeline.artifact-routing",
        "pipeline.parallel",
        "pipeline.sequence",
        "pipeline.stream",
        "user.input"
      ].sort()
    );
    assert.equal(Boolean(await deps.capabilities.resolveExecutable(runtimeFamilyCapabilityIds.pipelineSequence)), true);
  });

  it("registers at least one model-visible executable capability for every runtime-owned first-version family", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    const visible = await deps.capabilities.listModelVisible();
    const visibleFamilyIds = new Set(visible.map((manifest) => manifest.toolFamily?.familyId).filter((familyId): familyId is typeof TOOL_FAMILY_IDS[number] => typeof familyId === "string"));
    const runtimeOwnedFamilyIds = TOOL_FAMILY_IDS.filter((familyId) => !hostAdapterOnlyFamilyIds.has(familyId));

    assert.deepEqual([...visibleFamilyIds].sort(), [...runtimeOwnedFamilyIds].sort());
    for (const familyId of runtimeOwnedFamilyIds) {
      const manifest = visible.find((candidate) => candidate.toolFamily?.familyId === familyId);
      assert.ok(manifest, `${familyId} should be model-visible`);
      assert.equal(Boolean(await deps.capabilities.resolveExecutable(manifest.id)), true, `${familyId} should be executable`);
    }
    for (const familyId of hostAdapterOnlyFamilyIds) {
      assert.equal(visibleFamilyIds.has(familyId), false, `${familyId} should be registered by a host adapter, not the runtime package`);
    }
  });

  it("registers external adapter reference tools as model-visible executable runtime capabilities", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    const visible = await deps.capabilities.listModelVisible();
    const visibleIds = new Set(visible.map((manifest) => String(manifest.id)));
    const externalEntries = buildReferenceToolArsenalReport().entries.filter((entry) => entry.executionBoundary === "external-adapter");

    assert.equal(externalEntries.length > 0, true);
    for (const entry of externalEntries) {
      assert.equal(entry.coreExecutableCapabilityIds.length, 0, entry.referenceTool);
      assert.equal(entry.externalAdapterCapabilityIds.length > 0, true, entry.referenceTool);
      for (const capabilityId of entry.externalAdapterCapabilityIds) {
        assert.equal(visibleIds.has(capabilityId), true, `${entry.referenceTool} should register ${capabilityId}`);
        assert.equal(Boolean(await deps.capabilities.resolveExecutable(asId<"capability">(capabilityId))), true, `${capabilityId} should resolve executable`);
      }
    }
  });

  it("executes platform family wrappers for memory, remote runtime, schedule, and observability", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);

    const memory = await collectRuntimeEvents(kernel.execute({
      capabilityId: platformFamilyCapabilityIds.memoryReadWrite,
      caller: "runtime-family.test",
      input: { action: "write", scope: "session", content: "remember fixture fact" },
      timeoutMs: 5_000
    }));
    assert.equal(memory.some((event) => event.kind === "capability.completed"), true);

    const remote = await collectRuntimeEvents(kernel.execute({
      capabilityId: platformFamilyCapabilityIds.remoteRuntime,
      caller: "runtime-family.test",
      input: { action: "bind", id: "remote-test" },
      timeoutMs: 5_000
    }));
    assert.equal(remote.some((event) => event.kind === "capability.completed"), true);

    const schedule = await collectRuntimeEvents(kernel.execute({
      capabilityId: platformFamilyCapabilityIds.scheduleSleepCron,
      caller: "runtime-family.test",
      input: { action: "sleep", delayMs: 0 },
      timeoutMs: 5_000
    }));
    assert.equal(schedule.some((event) => event.kind === "capability.completed"), true);

    const observability = await collectRuntimeEvents(kernel.execute({
      capabilityId: platformFamilyCapabilityIds.observabilityTraceBudget,
      caller: "runtime-family.test",
      input: { reason: "runtime family test", maxRecords: 5 },
      timeoutMs: 5_000
    }));
    assert.equal(observability.some((event) => event.kind === "capability.completed"), true);
    await kernel.shutdown();
  });

  it("updates plan/auto/review mode state with replayable session evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.modePlanAutoReview,
      caller: "runtime-family.test",
      input: { mode: "review", reason: "verify before finish" },
      timeoutMs: 5_000
    }));

    const completed = events.find((event) => event.kind === "capability.completed");
    const output = completed?.data.output as { mode?: string; evidence?: { state?: { agentMode?: string } } } | undefined;
    assert.equal(output?.mode, "review");
    assert.equal(output?.evidence?.state?.agentMode, "verifier");
    const sessionId = events[0]?.sessionId;
    assert.ok(sessionId);
    assert.equal((await deps.sessions.events(sessionId)).some((event) => event.kind === "mode.plan-auto-review.changed"), true);
    await kernel.shutdown();
  });

  it("fails closed for headless user input and accepts a fake interactive host", async () => {
    const headlessDeps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(headlessDeps, "/workspace");
    const headlessKernel = await createDefaultRuntimeKernel(headlessDeps);
    const denied = await collectRuntimeEvents(headlessKernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.userInput,
      caller: "runtime-family.test",
      input: { prompt: "Continue?", inputType: "confirm" },
      timeoutMs: 5_000
    }));
    assert.equal(denied.some((event) => event.kind === "capability.failed" && event.error?.code === "KERNEL_EXECUTOR_FAILED"), true);
    await headlessKernel.shutdown();

    const interactiveDeps = {
      ...createDeterministicRuntimeDependencies(),
      userInput: {
        async requestInput() {
          return { status: "answered", value: "approved", source: "test" } as const;
        }
      }
    };
    await registerRuntimeFamilyCapabilities(interactiveDeps, "/workspace");
    const interactiveKernel = await createDefaultRuntimeKernel(interactiveDeps);
    const answered = await collectRuntimeEvents(interactiveKernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.userInput,
      caller: "runtime-family.test",
      input: { prompt: "Name?", inputType: "text" },
      timeoutMs: 5_000
    }));
    const completed = answered.find((event) => event.kind === "capability.completed");
    assert.equal((completed?.data.output as { status?: string; value?: string } | undefined)?.status, "answered");
    assert.equal((completed?.data.output as { status?: string; value?: string } | undefined)?.value, "approved");
    await interactiveKernel.shutdown();
  });

  it("records approval allow and deny decisions through the runtime approval broker", async () => {
    const approvals: ApprovalBroker = {
      async requestApproval(request: ApprovalRequest) {
        const allow = request.resource === "safe-resource";
        return {
          schemaVersion: APPROVAL_SCHEMA_VERSION,
          approvalId: request.approvalId,
          approved: allow,
          decision: allow ? "allow" : "deny",
          source: "test",
          reason: allow ? "allowed by test" : "denied by test",
          reasonCode: allow ? "test.allow" : "test.deny",
          auditReference: request.auditReference,
          trace: request.trace,
          redaction: { class: "internal" },
          metadata: { resource: request.resource }
        };
      }
    };
    const deps = { ...createDeterministicRuntimeDependencies(), approvals };
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);

    const allowed = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.approvalPermission,
      caller: "runtime-family.test",
      input: { prompt: "Approve safe?", action: "use", resource: "safe-resource" },
      timeoutMs: 5_000
    }));
    assert.equal(allowed.some((event) => event.kind === "capability.completed"), true);

    const denied = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.approvalPermission,
      caller: "runtime-family.test",
      input: { prompt: "Approve risky?", action: "use", resource: "risky-resource" },
      timeoutMs: 5_000
    }));
    assert.equal(denied.some((event) => event.kind === "capability.failed"), true);
    await kernel.shutdown();
  });

  it("executes sequential pipelines through registered capabilities and emits replayable artifact records", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.pipelineSequence,
      caller: "runtime-family.test",
      input: {
        pipelineId: "pipeline:test-sequence",
        steps: [
          { stepId: "read", capabilityId: runtimeEchoCapability.id, input: { text: "read" } },
          { stepId: "test", capabilityId: runtimeEchoCapability.id, input: { text: "test" }, inputArtifactIds: ["pipeline:test-sequence:read:output"] }
        ]
      },
      timeoutMs: 30_000
    }));

    const output = events.find((event) => event.kind === "capability.completed")?.data.output as { record?: { status?: string; steps?: readonly JsonObject[]; artifacts?: readonly JsonObject[] } } | undefined;
    assert.equal(output?.record?.status, "completed");
    assert.equal(output?.record?.steps?.length, 2);
    assert.equal(output?.record?.artifacts?.length, 2);
    assert.equal(output?.record?.steps?.every((step) => step.policyDecision === "allow"), true);
    await kernel.shutdown();
  });

  it("rejects parallel pipelines with overlapping write/resource locks", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.pipelineParallel,
      caller: "runtime-family.test",
      input: {
        pipelineId: "pipeline:test-conflict",
        steps: [
          { stepId: "a", capabilityId: runtimeEchoCapability.id, input: { text: "a" }, resourceLocks: ["path:README.md"] },
          { stepId: "b", capabilityId: runtimeEchoCapability.id, input: { text: "b" }, resourceLocks: ["path:README.md"] }
        ]
      },
      timeoutMs: 30_000
    }));
    assert.equal(events.some((event) => event.kind === "capability.failed"), true);
    await kernel.shutdown();
  });

  it("rejects parallel pipelines that depend on sibling step artifacts", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    let executions = 0;
    const capability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.parallel-artifact-dependency"),
      name: "Test Parallel Artifact Dependency",
      sideEffect: "none" as const
    };
    await deps.capabilities.register(capability, async () => {
      executions += 1;
      return { ok: true, value: { status: "executed" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.pipelineParallel,
      caller: "runtime-family.test",
      input: {
        pipelineId: "pipeline:test-parallel-artifact-dependency",
        steps: [
          { stepId: "producer", capabilityId: capability.id, input: { text: "producer" } },
          {
            stepId: "consumer",
            capabilityId: capability.id,
            input: { text: "consumer" },
            inputFromArtifacts: { previous: "pipeline:test-parallel-artifact-dependency:producer:output" }
          }
        ]
      },
      timeoutMs: 30_000
    }));

    assert.equal(events.some((event) => event.kind === "capability.failed" && (event.error?.details as JsonObject | undefined)?.originalCode === "PIPELINE_PARALLEL_ARTIFACT_DEPENDENCY"), true);
    assert.equal(executions, 0);
    await kernel.shutdown();
  });

  it("rejects parallel pipelines with equivalent explicit resource locks", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    let executions = 0;
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.explicit-equivalent-lock"),
      name: "Test Explicit Equivalent Lock",
      sideEffect: "write" as const
    };
    await deps.capabilities.register(writeCapability, async () => {
      executions += 1;
      return { ok: true, value: { status: "written" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.pipelineParallel,
      caller: "runtime-family.test",
      input: {
        pipelineId: "pipeline:test-equivalent-explicit-conflict",
        steps: [
          { stepId: "a", capabilityId: writeCapability.id, input: { text: "a" }, resourceLocks: ["path:src/index.ts"] },
          { stepId: "b", capabilityId: writeCapability.id, input: { text: "b" }, resourceLocks: ["path:./src/index.ts"] }
        ]
      },
      timeoutMs: 30_000
    }));
    assert.equal(events.some((event) => event.kind === "capability.failed"), true);
    assert.equal(executions, 0);
    await kernel.shutdown();
  });

  it("rejects parallel pipelines when write steps infer the same resource lock", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    let writes = 0;
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.write-file"),
      name: "Test Write File",
      sideEffect: "write" as const
    };
    await deps.capabilities.register(writeCapability, async () => {
      writes += 1;
      return { ok: true, value: { status: "written" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.pipelineParallel,
      caller: "runtime-family.test",
      input: {
        pipelineId: "pipeline:test-inferred-conflict",
        steps: [
          { stepId: "a", capabilityId: writeCapability.id, input: { path: "src/index.ts", content: "a" } },
          { stepId: "b", capabilityId: writeCapability.id, input: { path: "src/index.ts", content: "b" } }
        ]
      },
      timeoutMs: 30_000
    }));

    assert.equal(events.some((event) => event.kind === "capability.failed" && (event.error?.details as JsonObject | undefined)?.originalCode === "PIPELINE_LOCK_CONFLICT"), true);
    assert.equal(writes, 0);
    await kernel.shutdown();
  });

  it("rejects parallel pipelines when equivalent write paths infer the same resource lock", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    let writes = 0;
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.write-equivalent-file"),
      name: "Test Write Equivalent File",
      sideEffect: "write" as const
    };
    await deps.capabilities.register(writeCapability, async () => {
      writes += 1;
      return { ok: true, value: { status: "written" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.pipelineParallel,
      caller: "runtime-family.test",
      input: {
        pipelineId: "pipeline:test-equivalent-inferred-conflict",
        steps: [
          { stepId: "a", capabilityId: writeCapability.id, input: { path: "src/index.ts", content: "a" } },
          { stepId: "b", capabilityId: writeCapability.id, input: { path: "./src/index.ts", content: "b" } }
        ]
      },
      timeoutMs: 30_000
    }));

    assert.equal(events.some((event) => event.kind === "capability.failed" && (event.error?.details as JsonObject | undefined)?.originalCode === "PIPELINE_LOCK_CONFLICT"), true);
    assert.equal(writes, 0);
    await kernel.shutdown();
  });

  it("rejects parallel pipelines with case-equivalent paths on case-insensitive platforms", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FakePlatformRuntime("macos") });
    await registerRuntimeCoreTools(deps, "/workspace");
    let writes = 0;
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.write-case-equivalent-file"),
      name: "Test Write Case Equivalent File",
      sideEffect: "write" as const
    };
    await deps.capabilities.register(writeCapability, async () => {
      writes += 1;
      return { ok: true, value: { status: "written" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.pipelineParallel,
      caller: "runtime-family.test",
      input: {
        pipelineId: "pipeline:test-case-equivalent-inferred-conflict",
        steps: [
          { stepId: "a", capabilityId: writeCapability.id, input: { path: "README.md", content: "a" } },
          { stepId: "b", capabilityId: writeCapability.id, input: { path: "readme.md", content: "b" } }
        ]
      },
      timeoutMs: 30_000
    }));

    assert.equal(events.some((event) => event.kind === "capability.failed" && (event.error?.details as JsonObject | undefined)?.originalCode === "PIPELINE_LOCK_CONFLICT"), true);
    assert.equal(writes, 0);
    await kernel.shutdown();
  });

  it("rejects parallel pipelines with case-equivalent explicit locks on case-insensitive platforms", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FakePlatformRuntime("macos") });
    await registerRuntimeCoreTools(deps, "/workspace");
    let writes = 0;
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.write-case-equivalent-explicit-lock"),
      name: "Test Write Case Equivalent Explicit Lock",
      sideEffect: "write" as const
    };
    await deps.capabilities.register(writeCapability, async () => {
      writes += 1;
      return { ok: true, value: { status: "written" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.pipelineParallel,
      caller: "runtime-family.test",
      input: {
        pipelineId: "pipeline:test-case-equivalent-explicit-conflict",
        steps: [
          { stepId: "a", capabilityId: writeCapability.id, input: { text: "a" }, resourceLocks: ["path:README.md"] },
          { stepId: "b", capabilityId: writeCapability.id, input: { text: "b" }, resourceLocks: ["path:readme.md"] }
        ]
      },
      timeoutMs: 30_000
    }));

    assert.equal(events.some((event) => event.kind === "capability.failed" && (event.error?.details as JsonObject | undefined)?.originalCode === "PIPELINE_LOCK_CONFLICT"), true);
    assert.equal(writes, 0);
    await kernel.shutdown();
  });

  it("rejects parallel pipelines when explicit path locks overlap inferred workspace locks", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    let writes = 0;
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.write-path-workspace-overlap"),
      name: "Test Write Path Workspace Overlap",
      sideEffect: "write" as const
    };
    await deps.capabilities.register(writeCapability, async () => {
      writes += 1;
      return { ok: true, value: { status: "written" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.pipelineParallel,
      caller: "runtime-family.test",
      input: {
        pipelineId: "pipeline:test-path-workspace-overlap",
        steps: [
          { stepId: "a", capabilityId: writeCapability.id, input: { text: "a" }, resourceLocks: ["path:src/index.ts"] },
          { stepId: "b", capabilityId: writeCapability.id, input: { path: "src/index.ts", content: "b" } }
        ]
      },
      timeoutMs: 30_000
    }));

    assert.equal(events.some((event) => event.kind === "capability.failed" && (event.error?.details as JsonObject | undefined)?.originalCode === "PIPELINE_LOCK_CONFLICT"), true);
    assert.equal(writes, 0);
    await kernel.shutdown();
  });

  it("rejects parallel pipelines when absolute explicit locks overlap inferred workspace locks", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    let writes = 0;
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.write-absolute-path-workspace-overlap"),
      name: "Test Write Absolute Path Workspace Overlap",
      sideEffect: "write" as const
    };
    await deps.capabilities.register(writeCapability, async () => {
      writes += 1;
      return { ok: true, value: { status: "written" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.pipelineParallel,
      caller: "runtime-family.test",
      input: {
        pipelineId: "pipeline:test-absolute-path-workspace-overlap",
        steps: [
          { stepId: "a", capabilityId: writeCapability.id, input: { text: "a" }, resourceLocks: ["path:/workspace/src/index.ts"] },
          { stepId: "b", capabilityId: writeCapability.id, input: { path: "src/index.ts", workspaceRoot: "/workspace", content: "b" } }
        ]
      },
      timeoutMs: 30_000
    }));

    assert.equal(events.some((event) => event.kind === "capability.failed" && (event.error?.details as JsonObject | undefined)?.originalCode === "PIPELINE_LOCK_CONFLICT"), true);
    assert.equal(writes, 0);
    await kernel.shutdown();
  });

  it("rejects parallel pipelines when a directory lock overlaps a child file lock", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    let writes = 0;
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.write-directory-child-overlap"),
      name: "Test Write Directory Child Overlap",
      sideEffect: "write" as const
    };
    await deps.capabilities.register(writeCapability, async () => {
      writes += 1;
      return { ok: true, value: { status: "written" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.pipelineParallel,
      caller: "runtime-family.test",
      input: {
        pipelineId: "pipeline:test-directory-child-overlap",
        steps: [
          { stepId: "a", capabilityId: writeCapability.id, input: { text: "a" }, resourceLocks: ["path:src"] },
          { stepId: "b", capabilityId: writeCapability.id, input: { path: "src/index.ts", content: "b" } }
        ]
      },
      timeoutMs: 30_000
    }));

    assert.equal(events.some((event) => event.kind === "capability.failed" && (event.error?.details as JsonObject | undefined)?.originalCode === "PIPELINE_LOCK_CONFLICT"), true);
    assert.equal(writes, 0);
    await kernel.shutdown();
  });

  it("rejects parallel pipelines when a process cwd overlaps a workspace write", async () => {
    const deps = {
      ...createDeterministicRuntimeDependencies(),
      policy: {
        async decide() {
          return {
            action: "allow",
            reason: "test policy",
            audit: {},
            sandboxProfile: "none"
          };
        }
      } satisfies PolicyEngine
    };
    await registerRuntimeCoreTools(deps, "/workspace");
    let processRuns = 0;
    let writes = 0;
    const processCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.pipeline-process-root"),
      name: "Test Pipeline Process Root",
      sideEffect: "process" as const
    };
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.pipeline-write-during-process"),
      name: "Test Pipeline Write During Process",
      sideEffect: "write" as const
    };
    await deps.capabilities.register(processCapability, async () => {
      processRuns += 1;
      return { ok: true, value: { status: "process" } };
    });
    await deps.capabilities.register(writeCapability, async () => {
      writes += 1;
      return { ok: true, value: { status: "written" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.pipelineParallel,
      caller: "runtime-family.test",
      input: {
        pipelineId: "pipeline:test-process-write-overlap",
        steps: [
          { stepId: "test", capabilityId: processCapability.id, input: { cwd: ".", workspaceRoot: "/workspace" } },
          { stepId: "write", capabilityId: writeCapability.id, input: { path: "src/index.ts", content: "b", workspaceRoot: "/workspace" } }
        ]
      },
      timeoutMs: 30_000
    }));

    assert.equal(events.some((event) => event.kind === "capability.failed" && (event.error?.details as JsonObject | undefined)?.originalCode === "PIPELINE_LOCK_CONFLICT"), true);
    assert.equal(processRuns, 0);
    assert.equal(writes, 0);
    await kernel.shutdown();
  });

  it("rejects parallel pipelines when a process step relies on the pipeline workspace root", async () => {
    const deps = {
      ...createDeterministicRuntimeDependencies(),
      policy: {
        async decide() {
          return {
            action: "allow",
            reason: "test policy",
            audit: {},
            sandboxProfile: "none"
          };
        }
      } satisfies PolicyEngine
    };
    await registerRuntimeCoreTools(deps, "/workspace");
    let processRuns = 0;
    let writes = 0;
    const processCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.pipeline-default-root-process"),
      name: "Test Pipeline Default Root Process",
      sideEffect: "process" as const
    };
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.pipeline-default-root-write"),
      name: "Test Pipeline Default Root Write",
      sideEffect: "write" as const
    };
    await deps.capabilities.register(processCapability, async () => {
      processRuns += 1;
      return { ok: true, value: { status: "process" } };
    });
    await deps.capabilities.register(writeCapability, async () => {
      writes += 1;
      return { ok: true, value: { status: "written" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.pipelineParallel,
      caller: "runtime-family.test",
      input: {
        pipelineId: "pipeline:test-default-root-process-write-overlap",
        steps: [
          { stepId: "test", capabilityId: processCapability.id, input: {} },
          { stepId: "write", capabilityId: writeCapability.id, input: { path: "src/index.ts", content: "b" } }
        ]
      },
      timeoutMs: 30_000
    }));

    assert.equal(events.some((event) => event.kind === "capability.failed" && (event.error?.details as JsonObject | undefined)?.originalCode === "PIPELINE_LOCK_CONFLICT"), true);
    assert.equal(processRuns, 0);
    assert.equal(writes, 0);
    await kernel.shutdown();
  });

  it("allows a single pipeline step to hold overlapping explicit and inferred locks", async () => {
    const deps = {
      ...createDeterministicRuntimeDependencies(),
      policy: {
        async decide() {
          return {
            action: "allow",
            reason: "test policy",
            audit: {},
            sandboxProfile: "none"
          };
        }
      } satisfies PolicyEngine
    };
    await registerRuntimeCoreTools(deps, "/workspace");
    let writes = 0;
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.write-overlapping-self-locks"),
      name: "Test Write Overlapping Self Locks",
      sideEffect: "write" as const
    };
    await deps.capabilities.register(writeCapability, async () => {
      writes += 1;
      return { ok: true, value: { status: "written" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.pipelineParallel,
      caller: "runtime-family.test",
      input: {
        pipelineId: "pipeline:test-overlapping-self-locks",
        steps: [
          { stepId: "write", capabilityId: writeCapability.id, input: { path: "src/index.ts", content: "x" }, resourceLocks: ["path:src"] }
        ]
      },
      timeoutMs: 30_000
    }));

    assert.equal(events.some((event) => event.kind === "capability.completed"), true);
    assert.equal(writes, 1);
    await kernel.shutdown();
  });

  it("passes step side-effect metadata into pipeline policy decisions", async () => {
    const policyRequests: PolicyRequest[] = [];
    const deps = {
      ...createDeterministicRuntimeDependencies(),
      policy: {
        async decide(request: PolicyRequest) {
          policyRequests.push(request);
          return {
            action: "allow",
            reason: "test policy",
            audit: {},
            sandboxProfile: "none"
          };
        }
      } satisfies PolicyEngine
    };
    await registerRuntimeCoreTools(deps, "/workspace");
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.write-policy"),
      name: "Test Write Policy",
      sideEffect: "write" as const
    };
    await deps.capabilities.register(writeCapability, async () => ({ ok: true, value: { status: "written" } }));
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.pipelineSequence,
      caller: "runtime-family.test",
      input: {
        pipelineId: "pipeline:test-step-policy",
        steps: [
          { stepId: "write", capabilityId: writeCapability.id, input: { path: "src/index.ts", content: "x" } }
        ]
      },
      timeoutMs: 30_000
    }));

    assert.equal(events.some((event) => event.kind === "capability.completed"), true);
    const stepPolicyRequest = policyRequests.find((request) => request.subject === "runtime.pipeline" && request.resource === String(writeCapability.id));
    assert.equal(stepPolicyRequest?.metadata.sideEffect, "write");
    assert.deepEqual(stepPolicyRequest?.metadata.resourceLocks, ["workspace:src/index.ts"]);
    assert.equal(stepPolicyRequest?.resourceScope?.kind, "filesystem");
    assert.equal(stepPolicyRequest?.sandbox?.capabilities.includes("filesystem-write"), true);
    await kernel.shutdown();
  });

  it("routes bounded stream artifacts with truncation metadata", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.pipelineStream,
      caller: "runtime-family.test",
      input: {
        pipelineId: "pipeline:test-stream",
        artifactLimitBytes: 5,
        chunks: ["hello", " world"]
      },
      timeoutMs: 30_000
    }));
    const output = events.find((event) => event.kind === "capability.completed")?.data.output as { record?: { artifacts?: readonly { truncated?: boolean; byteLength?: number }[] } } | undefined;
    assert.equal(output?.record?.artifacts?.[0]?.truncated, true);
    assert.equal(output?.record?.artifacts?.[0]?.byteLength, 11);
    await kernel.shutdown();
  });

  it("waits for a fake worker result from replayable session events", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    const parentSessionId = await deps.sessions.create({ caller: "runtime-family.test" });
    const workerSessionId = await deps.sessions.create({ caller: "worker" });
    const definition = await deps.agents.getDefault();
    const worker = await deps.agents.createInstance(definition.id, workerSessionId, {
      mode: "worker",
      parentSessionId
    });
    await deps.agents.transitionInstance(worker.id, { transition: "complete", reason: "fake complete" });
    await deps.sessions.append({
      sessionId: parentSessionId,
      sequence: 1,
      kind: "agent.worker.result",
      at: "1970-01-01T00:00:00.000Z",
      payload: {
        workerInstanceId: worker.id,
        workerSessionId,
        status: "completed",
        summary: "fake worker complete",
        redaction: { class: "internal" }
      },
      redaction: { class: "internal" }
    });

    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.agentWaitResult,
      caller: "runtime-family.test",
      sessionId: parentSessionId,
      input: { workerInstanceId: worker.id, parentSessionId, timeoutMs: 0 },
      timeoutMs: 5_000
    }));
    const output = events.find((event) => event.kind === "capability.completed")?.data.output as { status?: string; workerResult?: { summary?: string } } | undefined;
    assert.equal(output?.status, "completed");
    assert.equal(output?.workerResult?.summary, "fake worker complete");
    await kernel.shutdown();
  });

  it("times out agent wait-result deterministically when no worker result is available", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeFamilyCapabilityIds.agentWaitResult,
      caller: "runtime-family.test",
      input: { workerInstanceId: asId<"agentInstance">("missing-worker"), timeoutMs: 0 },
      timeoutMs: 5_000
    }));
    assert.equal(events.some((event) => event.kind === "capability.failed"), true);
    await kernel.shutdown();
  });
});
