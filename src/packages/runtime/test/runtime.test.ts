import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentLoopProfilePolicyMetadata, AgentLoopReferenceContext, JsonObject, ModelChatMessage, ModelGateway, ModelRequest, ModelStreamEvent, PolicyDecision, PolicyEngine, PolicyRequest, ProcessResult, ProcessRunObserver, ProcessRunOptions, PromptAssembler, PromptAssemblyInput, PromptAssemblyResult, StagedTaskRef, ToolIntentPreflightRequest, ToolIntentPreflightResult, ToolIntentPreflightService } from "@deepseek/platform-contracts";
import { collectRuntimeEvents, createDefaultRuntimeKernel, createHeadlessRuntime, registerRuntimeCoreTools, runAgentLoop, runtimeEchoCapability } from "../src/index.js";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";
import { DeterministicScheduler } from "@deepseek/concurrency-orchestration";
import { defaultDeepSeekProfile } from "@deepseek/model-gateway";
import { DurablePermanentMemoryProvider, InMemoryPermanentMemoryStorageAdapter, InMemoryLosslessContextManager, PersistentJsonlLosslessContextManager, TOOL_RESULT_EVIDENCE_CACHE_NAMESPACE } from "@deepseek/memory-cache-management";
import { InMemoryUsageBudgetManager } from "@deepseek/usage-budget-management";
import { PersistentFilesystemSessionStore } from "@deepseek/session-store";
import { FakePlatformRuntime, NodePlatformRuntime } from "@deepseek/platform-abstraction";
import { asId } from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, objectSchema, replay } from "@deepseek/core-coding-tools";
import { HeadlessApprovalBroker } from "@deepseek/policy-sandbox";

describe("headless runtime", () => {
  it("delegates turns to the runtime kernel without direct model execution", async () => {
    const deps = createDeterministicRuntimeDependencies();
    let modelStreamCalled = false;
    deps.models.stream = () => {
      modelStreamCalled = true;
      throw new Error("model stream must not be called by headless runtime");
    };
    const runtime = createHeadlessRuntime(deps);
    const events = await collectRuntimeEvents(runtime.runTurn({ prompt: "hello" }));
    assert.equal(modelStreamCalled, false);
    assert.equal(events.some((event) => event.kind === "kernel.request.accepted"), true);
    assert.equal(events.some((event) => event.kind === "scheduler.completed"), true);
    assert.equal(events.some((event) => event.kind === "capability.completed"), true);
    assert.equal(events.some((event) => event.kind === "model.delta"), false);
    assert.ok(events.every((event) => event.sessionId));
    await runtime.dispose();
  });

  it("executes deterministic built-in capabilities through the runtime kernel", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeEchoCapability.id,
      caller: "test",
      input: { text: "kernel" },
      timeoutMs: 30_000
    }));

    assert.deepEqual(
      events.map((event) => event.kind),
      [
        "kernel.request.accepted",
        "workflow.opened",
        "execution.envelope.created",
        "policy.decided",
        "sandbox.selected",
        "capability.started",
        "scheduler.queued",
        "scheduler.started",
        "scheduler.completed",
        "capability.output",
        "capability.completed",
        "workflow.closed"
      ]
    );
    assert.equal(events.some((event) => event.kind === "capability.output" && (event.data.output as { text?: string }).text === "kernel"), true);
    assert.equal(deps.concurrency.events().some((event) => event.status === "queued"), true);
    assert.equal(deps.bus.getReplayRecords(events[0]?.sessionId).length >= events.length, true);
    await kernel.shutdown();
  });

  it("serializes concurrent kernel executions that infer the same resource lock", async () => {
    const deps = {
      ...createDeterministicRuntimeDependencies(),
      concurrency: new DeterministicScheduler({ maxConcurrency: 2 }),
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
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.kernel-write"),
      name: "Test Kernel Write",
      sideEffect: "write" as const
    };
    let active = 0;
    let maxActive = 0;
    await deps.capabilities.register(writeCapability, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(25);
      active -= 1;
      return { ok: true, value: { status: "written" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);

    const [first, second] = await Promise.all([
      collectRuntimeEvents(kernel.execute({
        capabilityId: writeCapability.id,
        caller: "test",
        input: { path: "src/index.ts", content: "a" },
        timeoutMs: 30_000
      })),
      collectRuntimeEvents(kernel.execute({
        capabilityId: writeCapability.id,
        caller: "test",
        input: { path: "src/index.ts", content: "b" },
        timeoutMs: 30_000
      }))
    ]);

    assert.equal(first.some((event) => event.kind === "capability.completed"), true);
    assert.equal(second.some((event) => event.kind === "capability.completed"), true);
    assert.equal(maxActive, 1);
    await kernel.shutdown();
  });

  it("serializes concurrent kernel executions that infer equivalent resource locks", async () => {
    const deps = {
      ...createDeterministicRuntimeDependencies(),
      concurrency: new DeterministicScheduler({ maxConcurrency: 2 }),
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
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.kernel-equivalent-write"),
      name: "Test Kernel Equivalent Write",
      sideEffect: "write" as const
    };
    let active = 0;
    let maxActive = 0;
    await deps.capabilities.register(writeCapability, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(25);
      active -= 1;
      return { ok: true, value: { status: "written" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);

    const [first, second] = await Promise.all([
      collectRuntimeEvents(kernel.execute({
        capabilityId: writeCapability.id,
        caller: "test",
        input: { path: "src/index.ts", content: "a" },
        timeoutMs: 30_000
      })),
      collectRuntimeEvents(kernel.execute({
        capabilityId: writeCapability.id,
        caller: "test",
        input: { path: "./src/index.ts", content: "b" },
        timeoutMs: 30_000
      }))
    ]);

    assert.equal(first.some((event) => event.kind === "capability.completed"), true);
    assert.equal(second.some((event) => event.kind === "capability.completed"), true);
    assert.equal(maxActive, 1);
    await kernel.shutdown();
  });

  it("serializes concurrent kernel writes when absolute paths are inside the same workspace root", async () => {
    const deps = {
      ...createDeterministicRuntimeDependencies(),
      concurrency: new DeterministicScheduler({ maxConcurrency: 2 }),
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
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.kernel-workspace-absolute-write"),
      name: "Test Kernel Workspace Absolute Write",
      sideEffect: "write" as const
    };
    let active = 0;
    let maxActive = 0;
    await deps.capabilities.register(writeCapability, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(25);
      active -= 1;
      return { ok: true, value: { status: "written" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);

    const [first, second] = await Promise.all([
      collectRuntimeEvents(kernel.execute({
        capabilityId: writeCapability.id,
        caller: "test",
        input: { path: "src/index.ts", workspaceRoot: "/workspace", content: "a" },
        timeoutMs: 30_000
      })),
      collectRuntimeEvents(kernel.execute({
        capabilityId: writeCapability.id,
        caller: "test",
        input: { path: "/workspace/src/index.ts", workspaceRoot: "/workspace", content: "b" },
        timeoutMs: 30_000
      }))
    ]);

    assert.equal(first.some((event) => event.kind === "capability.completed"), true);
    assert.equal(second.some((event) => event.kind === "capability.completed"), true);
    assert.equal(maxActive, 1);
    await kernel.shutdown();
  });

  it("serializes equivalent workspace paths on case-insensitive platforms", async () => {
    const deps = {
      ...createDeterministicRuntimeDependencies({ platform: new FakePlatformRuntime("macos") }),
      concurrency: new DeterministicScheduler({ maxConcurrency: 2 }),
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
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.kernel-case-insensitive-write"),
      name: "Test Kernel Case Insensitive Write",
      sideEffect: "write" as const
    };
    let active = 0;
    let maxActive = 0;
    await deps.capabilities.register(writeCapability, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(25);
      active -= 1;
      return { ok: true, value: { status: "written" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);

    const [first, second] = await Promise.all([
      collectRuntimeEvents(kernel.execute({
        capabilityId: writeCapability.id,
        caller: "test",
        input: { path: "README.md", workspaceRoot: "/workspace", content: "a" },
        timeoutMs: 30_000
      })),
      collectRuntimeEvents(kernel.execute({
        capabilityId: writeCapability.id,
        caller: "test",
        input: { path: "readme.md", workspaceRoot: "/workspace", content: "b" },
        timeoutMs: 30_000
      }))
    ]);

    assert.equal(first.some((event) => event.kind === "capability.completed"), true);
    assert.equal(second.some((event) => event.kind === "capability.completed"), true);
    assert.equal(maxActive, 1);
    await kernel.shutdown();
  });

  it("serializes concurrent kernel writes when a directory path overlaps a child file path", async () => {
    const deps = {
      ...createDeterministicRuntimeDependencies(),
      concurrency: new DeterministicScheduler({ maxConcurrency: 2 }),
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
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.kernel-directory-child-overlap"),
      name: "Test Kernel Directory Child Overlap",
      sideEffect: "write" as const
    };
    let active = 0;
    let maxActive = 0;
    await deps.capabilities.register(writeCapability, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(25);
      active -= 1;
      return { ok: true, value: { status: "written" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);

    const [first, second] = await Promise.all([
      collectRuntimeEvents(kernel.execute({
        capabilityId: writeCapability.id,
        caller: "test",
        input: { path: "src", content: "a" },
        timeoutMs: 30_000
      })),
      collectRuntimeEvents(kernel.execute({
        capabilityId: writeCapability.id,
        caller: "test",
        input: { path: "src/index.ts", content: "b" },
        timeoutMs: 30_000
      }))
    ]);

    assert.equal(first.some((event) => event.kind === "capability.completed"), true);
    assert.equal(second.some((event) => event.kind === "capability.completed"), true);
    assert.equal(maxActive, 1);
    await kernel.shutdown();
  });

  it("serializes process executions against overlapping workspace writes", async () => {
    const deps = {
      ...createDeterministicRuntimeDependencies(),
      concurrency: new DeterministicScheduler({ maxConcurrency: 2 }),
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
    const processCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.kernel-process-root"),
      name: "Test Kernel Process Root",
      sideEffect: "process" as const
    };
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.kernel-write-during-process"),
      name: "Test Kernel Write During Process",
      sideEffect: "write" as const
    };
    let active = 0;
    let maxActive = 0;
    const trackExecution = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(25);
      active -= 1;
      return { ok: true, value: { status: "done" } };
    };
    await deps.capabilities.register(processCapability, trackExecution);
    await deps.capabilities.register(writeCapability, trackExecution);
    const kernel = await createDefaultRuntimeKernel(deps);

    const [processEvents, writeEvents] = await Promise.all([
      collectRuntimeEvents(kernel.execute({
        capabilityId: processCapability.id,
        caller: "test",
        input: { cwd: ".", workspaceRoot: "/workspace" },
        timeoutMs: 30_000
      })),
      collectRuntimeEvents(kernel.execute({
        capabilityId: writeCapability.id,
        caller: "test",
        input: { path: "src/index.ts", content: "b", workspaceRoot: "/workspace" },
        timeoutMs: 30_000
      }))
    ]);

    assert.equal(processEvents.some((event) => event.kind === "capability.completed"), true);
    assert.equal(writeEvents.some((event) => event.kind === "capability.completed"), true);
    assert.equal(maxActive, 1);
    await kernel.shutdown();
  });

  it("serializes process executions even when cwd and workspaceRoot are omitted", async () => {
    const deps = {
      ...createDeterministicRuntimeDependencies(),
      concurrency: new DeterministicScheduler({ maxConcurrency: 2 }),
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
    const processCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.kernel-process-default-lock"),
      name: "Test Kernel Process Default Lock",
      sideEffect: "process" as const
    };
    let active = 0;
    let maxActive = 0;
    await deps.capabilities.register(processCapability, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(25);
      active -= 1;
      return { ok: true, value: { status: "process" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);

    const [first, second] = await Promise.all([
      collectRuntimeEvents(kernel.execute({
        capabilityId: processCapability.id,
        caller: "test",
        input: {},
        timeoutMs: 30_000
      })),
      collectRuntimeEvents(kernel.execute({
        capabilityId: processCapability.id,
        caller: "test",
        input: {},
        timeoutMs: 30_000
      }))
    ]);

    assert.equal(first.some((event) => event.kind === "capability.completed"), true);
    assert.equal(second.some((event) => event.kind === "capability.completed"), true);
    assert.equal(maxActive, 1);
    await kernel.shutdown();
  });

  it("does not deadlock one execution that infers overlapping self locks", async () => {
    const deps = {
      ...createDeterministicRuntimeDependencies(),
      concurrency: new DeterministicScheduler({ maxConcurrency: 2 }),
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
    const writeCapability = {
      ...runtimeEchoCapability,
      id: asId<"capability">("test.kernel-overlapping-self-locks"),
      name: "Test Kernel Overlapping Self Locks",
      sideEffect: "write" as const
    };
    let writes = 0;
    await deps.capabilities.register(writeCapability, async () => {
      writes += 1;
      return { ok: true, value: { status: "written" } };
    });
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: writeCapability.id,
      caller: "test",
      input: {
        path: "src",
        workspaceRoot: "/workspace",
        patch: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n"
      },
      timeoutMs: 250
    }));

    assert.equal(events.some((event) => event.kind === "capability.completed"), true);
    assert.equal(writes, 1);
    await kernel.shutdown();
  });

  it("runs the first usable agent loop without tool calls", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: "hello agent loop",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    assert.deepEqual(events.map((event) => event.kind), [
      "agent.loop.started",
      "turn.started",
      "visible.reasoning.recorded",
      "hooks.invoked",
      "mode.interaction.changed",
      "mode.agent.bound",
      "agent.phase.plan.created",
      "visible.reasoning.recorded",
      "agent.phase.skipped",
      "agent.phase.skipped",
      "agent.phase.skipped",
      "agent.phase.skipped",
      "agent.phase.skipped",
      "model.reasoning.effort.mapped",
      "evidence.classified",
      "visible.reasoning.recorded",
      "context.projection.started",
      "context.memory.collected",
      "context.projection.completed",
      "visible.reasoning.recorded",
      "tool.decision-board.snapshot",
      "hooks.invoked",
      "prompt.assembled",
      "visible.reasoning.recorded",
      "model.requested",
      "model.delta",
      "usage.updated",
      "model.finished",
      "model.done",
      "hooks.invoked",
      "visible.reasoning.recorded",
      "visible.reasoning.projected",
      "turn.completed",
      "agent.loop.completed"
    ]);
    assert.equal(events.at(-1)?.data.status, "completed");
    await kernel.shutdown();
  });

  it("attaches task delivery flow lineage to ordinary agent loop turns", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: "继续",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const startedFlow = events.find((event) => event.kind === "agent.loop.started")?.data.taskDeliveryFlow as JsonObject | undefined;
    const requestedFlow = events.find((event) => event.kind === "model.requested")?.data.taskDeliveryFlow as JsonObject | undefined;
    assert.equal(typeof startedFlow?.summaryId, "string");
    assert.equal(String(startedFlow?.summaryId).startsWith("task-flow:"), true);
    assert.equal(String(startedFlow?.briefId).startsWith("task-brief:"), true);
    assert.equal(String(startedFlow?.decisionRequestId).startsWith("task-decision-request:"), true);
    assert.equal(String(startedFlow?.goalId).startsWith("task-goal:"), true);
    assert.equal(String(startedFlow?.planId).startsWith("task-plan:"), true);
    assert.equal(startedFlow?.intentKind, "coding");
    assert.equal(startedFlow?.normalizedIntent, "continue current task");
    assert.equal(startedFlow?.deliveryStatus, "returned");
    assert.equal(requestedFlow?.summaryId, startedFlow?.summaryId);
    assert.equal(requestedFlow?.planId, startedFlow?.planId);
    assert.equal(JSON.stringify(startedFlow).includes("继续"), false);
    const requestAudit = (await deps.observability.drain())
      .filter((record) => record.kind === "audit")
      .find((record) => record.name === "model.request.audit");
    const auditFlow = requestAudit?.fields.taskDeliveryFlow as JsonObject | undefined;
    assert.equal(auditFlow?.summaryId, startedFlow?.summaryId);
    assert.equal(auditFlow?.planId, startedFlow?.planId);
    assert.equal(JSON.stringify(auditFlow).includes("继续"), false);
    await kernel.shutdown();
  });

  it("passes task decision requests through prompt assembly without extra model requests", async () => {
    const deps = createDeterministicRuntimeDependencies();
    if (!deps.promptAssembler) throw new Error("expected deterministic prompt assembler");
    const promptAssembler = new CapturingPromptAssembler(deps.promptAssembler);
    const loopDeps = { ...deps, promptAssembler };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "跑分",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    assert.equal(promptAssembler.inputs.length, 1);
    const taskDecision = promptAssembler.inputs[0]?.taskDecision;
    assert.equal(taskDecision?.brief.normalizedIntent, "run evaluation score");
    assert.equal(taskDecision?.riskLevel, "medium");
    assert.equal(taskDecision?.outputSchema?.kind, "TaskDecisionEnvelope");
    assert.equal(events.filter((event) => event.kind === "model.requested").length, 1);
    const requestedFlow = events.find((event) => event.kind === "model.requested")?.data.taskDeliveryFlow as JsonObject | undefined;
    assert.equal(requestedFlow?.decisionRequestId, taskDecision?.requestId);
    await kernel.shutdown();
  });

  it("records model-returned task decision envelopes in the agent loop summary", async () => {
    const deps = { ...createDeterministicRuntimeDependencies(), models: new TaskDecisionEnvelopeModelGateway() };
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: "跑分",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const decisionReceived = events.find((event) => event.kind === "task.decision.received");
    const completed = events.find((event) => event.kind === "agent.loop.completed");
    assert.equal(events.filter((event) => event.kind === "model.requested").length, 1);
    assert.equal(decisionReceived?.data.decisionId, "task-decision:model-evaluation");
    const receivedFlow = decisionReceived?.data.taskDeliveryFlow as JsonObject | undefined;
    const completedFlow = completed?.data.taskDeliveryFlow as JsonObject | undefined;
    const receivedGoal = decisionReceived?.data.goal as JsonObject | undefined;
    const receivedPlan = decisionReceived?.data.plan as JsonObject | undefined;
    assert.equal(decisionReceived?.data.requestId, receivedFlow?.decisionRequestId);
    assert.equal(receivedGoal?.goalId, "task-goal:model-evaluation");
    assert.deepEqual(receivedGoal?.acceptanceCriterionIds, ["criterion:model-proof"]);
    assert.equal(receivedPlan?.planningMode, "catalog-profile");
    assert.deepEqual(receivedPlan?.stepIds, ["task-step:model-evaluate"]);
    assert.deepEqual(receivedPlan?.phases, ["runtime"]);
    assert.equal(completedFlow?.decisionId, "task-decision:model-evaluation");
    assert.equal(completedFlow?.decisionSource, "model");
    assert.equal(completedFlow?.goalId, "task-goal:model-evaluation");
    assert.deepEqual(completedFlow?.planStepIds, ["task-step:model-evaluate"]);
    assert.deepEqual(completedFlow?.planPhases, ["runtime"]);
    assert.equal(String(completed?.data.assistantText).includes("task-decision:model-evaluation"), false);
    assert.match(String(completed?.data.assistantText), /Task decision recorded/i);
    await kernel.shutdown();
  });

  it("records model request counts and token usage through unified audit evidence", async () => {
    const deps = { ...createDeterministicRuntimeDependencies(), models: new UsageAuditingGateway() };
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: "audit usage",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      sessionId: asId<"session">("session-usage-audit"),
      turnId: asId<"turn">("turn-usage-audit"),
      profile: defaultDeepSeekProfile
    }));
    const usageTotal = await deps.usage.total(asId<"session">("session-usage-audit"));
    const auditRecords = (await deps.observability.drain()).filter((record) => record.kind === "audit");
    const requestAudit = auditRecords.find((record) => record.name === "model.request.audit");
    const usageAudit = auditRecords.find((record) => record.name === "model.usage.audit");

    assert.equal(events.some((event) => event.kind === "model.requested"), true);
    assert.equal(events.some((event) => event.kind === "usage.updated"), true);
    assert.equal(usageTotal.inputTokens, 11);
    assert.equal(usageTotal.outputTokens, 7);
    assert.equal(requestAudit?.fields.requestCount, 1);
    assert.equal(requestAudit?.fields.model, "deepseek-v4-flash");
    assert.equal(usageAudit?.fields.inputTokens, 11);
    assert.equal(usageAudit?.fields.outputTokens, 7);
    assert.equal(usageAudit?.fields.totalTokens, 18);
    assert.equal(usageAudit?.fields.providerRequestId, "req-usage-audit");
    assert.equal(/\bsk-[A-Za-z0-9_-]{8,}\b/.test(JSON.stringify(auditRecords)), false);
    await kernel.shutdown();
  });

  it("preserves provider cache breakpoint telemetry in runtime usage evidence", async () => {
    const deps = { ...createDeterministicRuntimeDependencies(), models: new CacheTelemetryUsageGateway() };
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: "audit cache telemetry",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      sessionId: asId<"session">("session-cache-telemetry"),
      turnId: asId<"turn">("turn-cache-telemetry"),
      profile: defaultDeepSeekProfile
    }));
    const usage = events.find((event) => event.kind === "usage.updated");
    const usageCache = (usage?.data.metadata as { cache?: JsonObject } | undefined)?.cache;
    const auditRecords = (await deps.observability.drain()).filter((record) => record.kind === "audit");
    const usageAudit = auditRecords.find((record) => record.name === "model.usage.audit");
    const auditCache = usageAudit?.fields.cache as JsonObject | undefined;

    assert.deepEqual(usageCache?.breakpointShape, runtimeCacheBreakpointShape());
    assert.equal((usageCache?.explicitPrefixCacheHint as { status?: string } | undefined)?.status, "sent");
    assert.deepEqual(auditCache?.breakpointShape, runtimeCacheBreakpointShape());
    assert.equal((auditCache?.explicitPrefixCacheHint as { status?: string } | undefined)?.status, "sent");
    await kernel.shutdown();
  });

  it("carries context pipeline evidence into prompt assembly and model metadata when enabled", async () => {
    const gateway = new CapturingModelGateway();
    const deps = { ...createDeterministicRuntimeDependencies(), models: gateway };
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: "hello pipeline",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      contextPipeline: { enabled: true }
    }));

    const promptAssembled = events.find((event) => event.kind === "prompt.assembled");
    const modelRequested = events.find((event) => event.kind === "model.requested");
    const promptPipeline = (promptAssembled?.data.trace as { pipeline?: { cacheHintSummary?: { stable?: number; ephemeral?: number }; providerPrefixMessageCount?: number } } | undefined)?.pipeline;
    const modelPipeline = gateway.requests[0]?.metadata?.contextPipeline as { pipelineFingerprint?: string; cacheHintSummary?: { stable?: number; ephemeral?: number }; providerPrefixMessageCount?: number } | undefined;
    const firstSystem = gateway.requests[0]?.messages?.find((message) => message.role === "system") as { cacheHint?: { policy?: string } } | undefined;
    const contextPipelineMessage = gateway.requests[0]?.messages?.find((message) => message.role === "system" && message.content.includes("Context pipeline manifest:")) as { cacheHint?: { policy?: string }; content?: string } | undefined;
    assert.equal(typeof promptAssembled?.data.trace === "object", true);
    assert.equal(typeof (promptAssembled?.data.trace as { pipeline?: { pipelineFingerprint?: string } } | undefined)?.pipeline?.pipelineFingerprint, "string");
    assert.equal(typeof gateway.requests[0]?.metadata?.contextPipeline, "object");
    assert.equal(modelPipeline?.pipelineFingerprint?.startsWith("pipeline:"), true);
    assert.equal(typeof (modelRequested?.data.contextPipeline as { pipelineFingerprint?: string } | undefined)?.pipelineFingerprint, "string");
    assert.equal((promptPipeline?.cacheHintSummary?.stable ?? 0) > 0, true);
    assert.equal((modelPipeline?.cacheHintSummary?.stable ?? 0) > 0, true);
    assert.equal((promptPipeline?.providerPrefixMessageCount ?? 0) > 0, true);
    assert.equal((modelPipeline?.providerPrefixMessageCount ?? 0) > 0, true);
    assert.equal(firstSystem?.cacheHint?.policy, "stable");
    if (contextPipelineMessage) {
      assert.equal(contextPipelineMessage.cacheHint?.policy, "stable");
      assert.equal(contextPipelineMessage.content?.includes("cache=ephemeral"), false);
    }
    await kernel.shutdown();
  });

  it("records lossless context nodes when a manager is configured", async () => {
    const deps = { ...createDeterministicRuntimeDependencies(), losslessContext: new InMemoryLosslessContextManager() };
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const prompt = "critical approval rule: never delete mail without explicit confirmation";
    const events = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt,
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    assert.equal(events.some((event) => event.kind === "context.lcm.node-recorded"), true);
    assert.equal(events.some((event) => event.kind === "context.lcm.node-recorded" && event.data.sourceClass === "user-prompt"), true);
    const recalled = await deps.losslessContext.grep({ query: "approval rule" });
    assert.equal(recalled.matchCount >= 1, true);
    const nodeId = recalled.matches.find((match) => match.role === "user")?.nodeId;
    if (!nodeId) throw new Error("expected lossless context node id");
    assert.equal(recalled.matches.find((match) => match.nodeId === nodeId)?.sourceClass, "user-prompt");
    const expanded = await deps.losslessContext.expand({ nodeId });
    assert.equal(expanded.expandedNodes[0]?.content, prompt);
    await kernel.shutdown();
  });

  it("rebuilds resumed session history from lossless context and emits replay evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-runtime-resume-"));
    try {
      const nodePlatform = new NodePlatformRuntime();
      const sessionsDir = join(root, "sessions");
      const losslessDir = join(root, "lossless");
      const firstDeps = {
        ...createDeterministicRuntimeDependencies(),
        sessions: new PersistentFilesystemSessionStore(sessionsDir),
        losslessContext: new PersistentJsonlLosslessContextManager(nodePlatform, losslessDir),
        models: new CapturingModelGateway()
      };
      await registerRuntimeCoreTools(firstDeps, "/workspace");
      const firstKernel = await createDefaultRuntimeKernel(firstDeps);
      const firstEvents = await collectRuntimeEvents(runAgentLoop(firstDeps, firstKernel, {
        prompt: "durable context fact: release gate requires real DeepSeek evidence",
        caller: "runtime.test",
        workspaceRoot: "/workspace",
        outputMode: "jsonl",
        profile: defaultDeepSeekProfile
      }));
      await firstKernel.shutdown();
      const sessionId = firstEvents[0]?.sessionId;
      if (!sessionId) throw new Error("expected session id");

      const secondGateway = new CapturingModelGateway();
      const secondDeps = {
        ...createDeterministicRuntimeDependencies(),
        sessions: new PersistentFilesystemSessionStore(sessionsDir),
        losslessContext: new PersistentJsonlLosslessContextManager(nodePlatform, losslessDir),
        models: secondGateway
      };
      await registerRuntimeCoreTools(secondDeps, "/workspace");
      const secondKernel = await createDefaultRuntimeKernel(secondDeps);
      const secondEvents = await collectRuntimeEvents(runAgentLoop(secondDeps, secondKernel, {
        sessionId,
        prompt: "Use the prior durable context fact.",
        caller: "runtime.test",
        workspaceRoot: "/workspace",
        outputMode: "jsonl",
        profile: defaultDeepSeekProfile
      }));

      const restoredRequest = secondGateway.requests[0];
      assert.equal(restoredRequest?.messages?.some((message) => message.role === "user" && message.content.includes("release gate requires real DeepSeek evidence")), true);
      const modelRequested = secondEvents.find((event) => event.kind === "model.requested");
      const replay = modelRequested?.data.providerRequestReplay as { status?: string; restoredMessageCount?: number; sessionEventCount?: number; losslessSourceClasses?: readonly string[] } | undefined;
      assert.equal(replay?.status, "restored");
      assert.equal((replay?.sessionEventCount ?? 0) > 0, true);
      assert.equal((replay?.restoredMessageCount ?? 0) >= 2, true);
      assert.equal(replay?.losslessSourceClasses?.includes("user-prompt"), true);
      assert.equal(replay?.losslessSourceClasses?.includes("assistant-output"), true);
      await secondKernel.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores inherited parent history when an agent loop resumes a forked child session", async () => {
    const gateway = new CapturingModelGateway();
    const deps = {
      ...createDeterministicRuntimeDependencies(),
      losslessContext: new InMemoryLosslessContextManager(),
      models: gateway
    };
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const parentEvents = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: "parent fork context fact: use blue-green release gates",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));
    const parentSessionId = parentEvents[0]?.sessionId;
    if (!parentSessionId) throw new Error("expected parent session id");

    const forked = await deps.sessions.fork({ parentSessionId, reason: "parallel child branch" });
    assert.equal(forked.ok, true, forked.error?.message);
    const childSessionId = forked.value?.childSessionId;
    if (!childSessionId) throw new Error("expected child session id");

    await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      sessionId: childSessionId,
      prompt: "Use the inherited parent fork context.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const childRequest = gateway.requests.at(-1);
    assert.equal(childRequest?.messages?.some((message) => message.role === "user" && message.content.includes("blue-green release gates")), true);
    await kernel.shutdown();
  });

  it("does not restore parent history recorded after the child fork point", async () => {
    const gateway = new CapturingModelGateway();
    const deps = {
      ...createDeterministicRuntimeDependencies(),
      losslessContext: new InMemoryLosslessContextManager(),
      models: gateway
    };
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const parentEvents = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: "parent fork stable context: keep canary rollout notes",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));
    const parentSessionId = parentEvents[0]?.sessionId;
    if (!parentSessionId) throw new Error("expected parent session id");

    const forked = await deps.sessions.fork({ parentSessionId, reason: "parallel branch before parent moves on" });
    assert.equal(forked.ok, true, forked.error?.message);
    const childSessionId = forked.value?.childSessionId;
    if (!childSessionId) throw new Error("expected child session id");

    await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      sessionId: parentSessionId,
      prompt: "parent-only post-fork fact: do not leak this rollback token",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      sessionId: childSessionId,
      prompt: "Use only inherited fork-point context.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const childRequest = gateway.requests.at(-1);
    assert.equal(childRequest?.messages?.some((message) => message.role === "user" && message.content.includes("canary rollout notes")), true);
    assert.equal(childRequest?.messages?.some((message) => message.role === "user" && message.content.includes("do not leak this rollback token")), false);
    await kernel.shutdown();
  });

  it("restores ancestor history through nested fork lineage", async () => {
    const gateway = new CapturingModelGateway();
    const deps = {
      ...createDeterministicRuntimeDependencies(),
      losslessContext: new InMemoryLosslessContextManager(),
      models: gateway
    };
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const rootEvents = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: "root fork durable context: keep database savepoint protocol",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));
    const rootSessionId = rootEvents[0]?.sessionId;
    if (!rootSessionId) throw new Error("expected root session id");

    const child = await deps.sessions.fork({ parentSessionId: rootSessionId, reason: "first branch" });
    assert.equal(child.ok, true, child.error?.message);
    const childSessionId = child.value?.childSessionId;
    if (!childSessionId) throw new Error("expected child session id");
    const grandchild = await deps.sessions.fork({ parentSessionId: childSessionId, reason: "nested branch" });
    assert.equal(grandchild.ok, true, grandchild.error?.message);
    const grandchildSessionId = grandchild.value?.childSessionId;
    if (!grandchildSessionId) throw new Error("expected grandchild session id");

    await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      sessionId: grandchildSessionId,
      prompt: "Use the nested inherited fork context.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const grandchildRequest = gateway.requests.at(-1);
    assert.equal(grandchildRequest?.messages?.some((message) => message.role === "user" && message.content.includes("database savepoint protocol")), true);
    await kernel.shutdown();
  });

  it("restores the newest lossless history when resumed sessions exceed the provider history limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-runtime-resume-tail-"));
    try {
      const nodePlatform = new NodePlatformRuntime();
      const sessionsDir = join(root, "sessions");
      const losslessDir = join(root, "lossless");
      const firstDeps = {
        ...createDeterministicRuntimeDependencies(),
        sessions: new PersistentFilesystemSessionStore(sessionsDir),
        losslessContext: new PersistentJsonlLosslessContextManager(nodePlatform, losslessDir),
        models: new ManyEchoToolCallsModelGateway(14)
      };
      await registerRuntimeCoreTools(firstDeps, "/workspace");
      const firstKernel = await createDefaultRuntimeKernel(firstDeps);
      const firstEvents = await collectRuntimeEvents(runAgentLoop(firstDeps, firstKernel, {
        prompt: "Generate many durable tool results for resume history ordering.",
        caller: "runtime.test",
        workspaceRoot: "/workspace",
        outputMode: "jsonl",
        profile: defaultDeepSeekProfile,
        limits: {
          maxModelIterations: 16,
          maxToolCalls: 16
        }
      }));
      await firstKernel.shutdown();
      const sessionId = firstEvents[0]?.sessionId;
      if (!sessionId) throw new Error("expected session id");

      const secondGateway = new CapturingModelGateway();
      const secondDeps = {
        ...createDeterministicRuntimeDependencies(),
        sessions: new PersistentFilesystemSessionStore(sessionsDir),
        losslessContext: new PersistentJsonlLosslessContextManager(nodePlatform, losslessDir),
        models: secondGateway
      };
      await registerRuntimeCoreTools(secondDeps, "/workspace");
      const secondKernel = await createDefaultRuntimeKernel(secondDeps);
      const secondEvents = await collectRuntimeEvents(runAgentLoop(secondDeps, secondKernel, {
        sessionId,
        prompt: "Use the newest durable tool result.",
        caller: "runtime.test",
        workspaceRoot: "/workspace",
        outputMode: "jsonl",
        profile: defaultDeepSeekProfile
      }));

      const restoredRequest = secondGateway.requests[0];
      const restoredText = JSON.stringify(restoredRequest?.messages ?? []);
      const modelRequested = secondEvents.find((event) => event.kind === "model.requested");
      const replay = modelRequested?.data.providerRequestReplay as { restoredMessageCount?: number; losslessContextReferences?: readonly string[] } | undefined;

      assert.equal(restoredText.includes("echo-result-14-newest"), true);
      assert.equal(restoredText.includes("echo-result-1-oldest"), false);
      assert.equal((replay?.restoredMessageCount ?? 0) <= 12, true);
      assert.equal((replay?.losslessContextReferences?.length ?? 0) <= 12, true);
      await secondKernel.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });it("runs evidence discovery before fact-sensitive model dispatch and preserves prompt boundary", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new CapturingModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await loopDeps.platform.writeFile("/workspace/README.md", "DeepSeek CLI repository evidence\n");
    await loopDeps.platform.writeFile("/workspace/src/apps/cli/package.json", JSON.stringify({ name: "deepseek-agent-cli", bin: { deepseek: "dist/index.js" } }));
    await loopDeps.platform.writeFile("/workspace/src/apps/cli/README.md", "DeepSeek CLI host adapter\n");
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const prompt = "生成 DeepSeek CLI 产品 website 到 @website 目录";
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt,
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const kinds = events.map((event) => event.kind);
    assert.equal(kinds.indexOf("evidence.classified") < kinds.indexOf("model.requested"), true);
    assert.equal(kinds.indexOf("evidence.plan.created") < kinds.indexOf("model.requested"), true);
    assert.equal(kinds.indexOf("evidence.selected") < kinds.indexOf("model.requested"), true);
    const classification = events.find((event) => event.kind === "evidence.classified")?.data as { evidenceRequired?: boolean; sensitivity?: string } | undefined;
    assert.equal(classification?.evidenceRequired, true);
    assert.equal(classification?.sensitivity, "fact-sensitive");
    const userMessage = gateway.requests[0]?.messages?.find((message) => message.role === "user");
    assert.equal(userMessage?.content, prompt);
    assert.equal(gateway.requests[0]?.messages?.some((message) => message.role === "system" && message.content.includes("Selected local project evidence:")), true);
    assert.equal(gateway.requests[0]?.messages?.some((message) => message.role === "system" && message.content.includes("deepseek-agent-cli")), true);
    await kernel.shutdown();
  });

  it("revises unsupported evidence-first claims once before completing", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new EvidenceRevisionModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await loopDeps.platform.writeFile("/workspace/README.md", "DeepSeek CLI repository evidence\n");
    await loopDeps.platform.writeFile("/workspace/src/apps/cli/package.json", JSON.stringify({ name: "deepseek-agent-cli", bin: { deepseek: "dist/index.js" } }));
    await loopDeps.platform.writeFile("/workspace/docs/reference/command-index.md", "deepseek run <prompt>\n");
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "生成 DeepSeek CLI 产品介绍",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 3 }
    }));

    assert.equal(events.some((event) => event.kind === "evidence.claims.grounded"), true);
    assert.equal(events.some((event) => event.kind === "evidence.unsupported-claim"), true);
    assert.equal(gateway.requests.length >= 2, true);
    assert.equal(gateway.requests[1]?.messages?.some(isEvidenceFirstGroundingFeedback), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal(String(events.at(-1)?.data.assistantText).includes("npx deepseek-cli init"), false);
    await kernel.shutdown();
  });

  it("fails closed when unsupported evidence-first claims remain after revision", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const loopDeps = { ...deps, models: new StubbornUnsupportedClaimModelGateway() };
    await loopDeps.platform.writeFile("/workspace/README.md", "DeepSeek CLI repository evidence\n");
    await loopDeps.platform.writeFile("/workspace/src/apps/cli/package.json", JSON.stringify({ name: "deepseek-agent-cli", bin: { deepseek: "dist/index.js" } }));
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "生成 DeepSeek CLI 产品介绍",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 3 }
    }));

    assert.equal(events.filter((event) => event.kind === "evidence.unsupported-claim").length >= 1, true);
    assert.equal(events.at(-1)?.kind, "agent.loop.failed");
    assert.equal(events.at(-1)?.data.reason, "evidence-unsupported-claim");
    await kernel.shutdown();
  });

  it("grounds final strict claims with runtime tool-result evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new ToolEvidenceGroundingModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await loopDeps.platform.writeFile("/workspace/README.md", "DeepSeek CLI repository evidence\n");
    await loopDeps.platform.writeFile("/workspace/src/source.py", "cright[-right.shape[0]:, -right.shape[1]:] = 1\n");
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Inspect repository code and report the exact code change.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 3 }
    }));

    assert.equal(events.some((event) => event.kind === "model.tool.result"), true);
    assert.equal(events.some((event) => event.kind === "evidence.unsupported-claim"), false);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal(gateway.requests.length >= 2, true);
    await kernel.shutdown();
  });

  it("classifies speculative tasks without mandatory evidence discovery", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new CapturingModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "头脑风暴一个虚构 CLI 名字",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const classification = events.find((event) => event.kind === "evidence.classified")?.data as { evidenceRequired?: boolean; sensitivity?: string } | undefined;
    assert.equal(classification?.evidenceRequired, false);
    assert.equal(classification?.sensitivity, "speculative");
    assert.equal(events.some((event) => event.kind === "evidence.plan.created"), false);
    assert.equal(events.some((event) => event.kind === "evidence.selected"), false);
    await kernel.shutdown();
  });

  it("rejects malformed model tool calls through preflight", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const loopDeps = { ...deps, models: new SingleToolCallModelGateway("core.file.read", { path: "../outside.txt" }) };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "read unsafe",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 1 }
    }));

    assert.equal(events.some((event) => event.kind === "model.tool.intent"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.rejected" && event.error?.details?.code === "TOOL_INTENT_PARENT_TRAVERSAL_REJECTED"), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.failed");
    assert.equal(events.at(-1)?.data.status, "rejected");
    await kernel.shutdown();
  });
it("rejects model tools outside the primary profile workflow capability boundary", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SingleToolCallModelGateway("core.shell.run", { command: "echo outside-workflow" });
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the current workflow.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: workflowBoundaryProfilePolicy(["core.file.read"]),
      limits: { maxModelIterations: 2 }
    }));

    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.name === "core.shell.run"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.terminalKind === "workflow-capability-boundary.rejected"), true);
    assert.equal(events.some((event) => event.kind === "capability.started"), false);
    assert.equal(events.some((event) => event.kind === "kernel.request.accepted"), false);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => String(message.content ?? "").includes("WORKFLOW_CAPABILITY_BOUNDARY_ENFORCED"))), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    await kernel.shutdown();
  });
  it("projects governed test execution but not arbitrary shell execution for read-write stages", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new CapturingModelGateway();
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Run the focused test.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowShellTestProfilePolicy(),
      toolProjection: "read-write",
      limits: { maxModelIterations: 1 }
    }));

    assert.deepEqual(visibleToolNames(gateway.requests[0] as ModelRequest), ["core_test_run"]);
    assert.equal(events.some((event) => event.kind === "prompt.assembled" && jsonObjectRecord(event.data.toolPlan)?.visibleToolCount === 1), true);
    await kernel.shutdown();
  });

  it("projects produce ready stages to mutation progress tools instead of supporting read tools", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-understand-read", name: "core.file.read", input: { path: "package.json" } }
    ]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/package.json", "{\"type\":\"module\"}\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "生成 docs/USAGE.md 和 examples/config.json",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: engineeringArtifactDeliveryProfilePolicy(),
      toolProjection: "read-write",
      limits: { maxModelIterations: 2 }
    }));

    const promptAssembled = events.filter((event) => event.kind === "prompt.assembled");

    assert.equal(events.some((event) => event.kind === "workflow.step" && event.data.stageId === "stage:understand" && event.data.status === "succeeded"), true);
    assert.equal(Number(jsonObjectRecord(promptAssembled[1]?.data.toolPlan)?.visibleToolCount ?? 0) > 0, true);
    await kernel.shutdown();
  });

  it("keeps provider request tool schemas aligned with staged workflow projection changes", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-understand-read", name: "core.file.read", input: { path: "package.json" } }
    ]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/package.json", "{\"type\":\"module\"}\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "生成 docs/USAGE.md 和 examples/config.json",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: engineeringArtifactDeliveryProfilePolicy(),
      toolProjection: "read-write",
      contextPipeline: { enabled: true },
      limits: { maxModelIterations: 2 }
    }));

    const firstPipeline = contextPipelineMetadata(gateway.requests[0] as ModelRequest);
    const secondPipeline = contextPipelineMetadata(gateway.requests[1] as ModelRequest);

    assert.deepEqual(visibleToolNames(gateway.requests[0] as ModelRequest), ["core_file_read"]);
    assert.deepEqual(visibleToolNames(gateway.requests[1] as ModelRequest), ["core_file_edit", "core_patch_apply"]);
    assert.equal(firstPipeline.providerPrefixFingerprint?.startsWith("provider-prefix:"), true);
    assert.equal(firstPipeline.providerPrefixFingerprint, secondPipeline.providerPrefixFingerprint);
    assert.equal(firstPipeline.pipelineFingerprint, secondPipeline.pipelineFingerprint);
    assert.equal(providerMessageText(gateway.requests[1] as ModelRequest).includes("Agent profile workflow state:"), true);
    assert.equal(providerMessageText(gateway.requests[1] as ModelRequest).includes("Tool decision board summary:"), true);
    assert.equal(providerMessageText(gateway.requests[1] as ModelRequest).includes("Tool visibility policy:"), true);
    await kernel.shutdown();
  });

  it("compacts long source inspection results before provider dispatch to reduce dynamic cache tails", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-read-one", name: "core.file.read", input: { path: "src/one.py", limitBytes: 7_000 } },
      { id: "call-read-two", name: "core.file.read", input: { path: "src/two.py", limitBytes: 7_000 } },
      { id: "call-read-three", name: "core.file.read", input: { path: "src/three.py", limitBytes: 7_000 } }
    ]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const longSource = (marker: string) => [
      "def target():",
      "    " + "leading source context ".repeat(120),
      `    ${marker}`,
      "    " + "trailing source context ".repeat(120)
    ].join("\n");
    await loopDeps.platform.writeFile("/workspace/src/one.py", longSource("TARGET_MARKER_1"));
    await loopDeps.platform.writeFile("/workspace/src/two.py", longSource("TARGET_MARKER_2"));
    await loopDeps.platform.writeFile("/workspace/src/three.py", longSource("TARGET_MARKER_3"));
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Resolve source issue with focused reads.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "read-only",
      contextPipeline: { enabled: true },
      limits: { maxModelIterations: 4 }
    }));

    const finalProviderRequest = gateway.requests[3] as ModelRequest;
    const dynamicToolMessages = (finalProviderRequest.messages ?? []).filter((message) => message.role === "tool");
    const dynamicToolChars = dynamicToolMessages.reduce((total, message) => total + message.content.length, 0);
    const providerText = providerMessageText(finalProviderRequest);
    const secondLatestSourceMessage = dynamicToolMessages.find((message) => message.toolCallId === "call-read-two");
    const latestSourceMessage = dynamicToolMessages.find((message) => message.toolCallId === "call-read-three");

    assert.equal(providerText.includes("compacted source tool result"), true);
    assert.equal(providerText.includes("TARGET_MARKER_2"), true);
    assert.equal(providerText.includes("TARGET_MARKER_3"), true);
    assert.equal(secondLatestSourceMessage?.content.startsWith("compacted source tool result"), false);
    assert.equal(latestSourceMessage?.content.startsWith("compacted source tool result"), false);
    assert.equal(dynamicToolChars < 16_000, true);
    await kernel.shutdown();
  });

  it("keeps the implement stage on mutation tools after the plan stage succeeds", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-understand-read", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-plan-search", name: "core.search.text", input: { pattern: "artifact", glob: "**/*.md", outputMode: "files" } }
    ]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "artifact delivery evidence\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "生成 docs/USAGE.md 和 examples/config.json",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: engineeringArtifactDeliveryWithPlanAndImplementProfilePolicy(),
      toolProjection: "read-write",
      limits: { maxModelIterations: 3 }
    }));

    const promptAssembled = events.filter((event) => event.kind === "prompt.assembled");

    assert.equal(events.some((event) => event.kind === "workflow.step" && event.data.stageId === "stage:plan" && event.data.status === "succeeded"), true);
    assert.equal(Number(jsonObjectRecord(promptAssembled[2]?.data.toolPlan)?.visibleToolCount ?? 0) > 0, true);
    await kernel.shutdown();
  });

  it("rejects non-progress implement-stage tools before execution and corrects with exact function names", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-understand-read", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-plan-search", name: "core.search.text", input: { pattern: "artifact", glob: "**/*.md", outputMode: "files" } },
      { id: "call-implement-glob", name: "core.workspace.glob", input: { pattern: "package.json" } },
      { id: "call-implement-write", name: "core.file.write", input: { path: "README.md", content: "usage\n" } }
    ]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "artifact delivery evidence\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "生成 docs/USAGE.md 和 examples/config.json",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: engineeringArtifactDeliveryWithPlanAndImplementProfilePolicy(),
      toolProjection: "read-write",
      limits: { maxModelIterations: 4 }
    }));
    const correctionMessage = gateway.requests[3]?.messages?.at(-1);
    const correctionContent = String(correctionMessage?.content ?? "");

    assert.equal(events.some((event) => event.kind === "capability.started" && event.data.capabilityId === "core.workspace.glob"), true);
    assert.equal(events.some((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.requestedCapabilityId === "core.workspace.glob"
    ), true);
    assert.equal(correctionContent.includes("Visible function names: core_file_edit, core_patch_apply."), true);
    await kernel.shutdown();
  });

  it("checks requested artifact path casing independently of platform filesystem semantics", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FakePlatformRuntime("macos") });
    const gateway = new SequentialToolCallModelGateway([]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "artifact delivery evidence\n");
    await loopDeps.platform.writeFile("/workspace/docs/usage.md", "# Usage\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "生成 docs/USAGE.md 和 examples/config.json",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      outputContract: {
        schemaVersion: "1.0.0",
        kind: "file",
        required: true,
        path: "docs/USAGE.md",
        verificationExpectations: [{
          schemaVersion: "1.0.0",
          kind: "artifact",
          required: true,
          description: "Requested artifact path must exist exactly as written.",
          path: "docs/USAGE.md",
          redaction: { class: "internal", fields: ["path", "description"] }
        }],
        redaction: { class: "internal", fields: ["path", "verificationExpectations.path", "verificationExpectations.description"] }
      },
      limits: { maxModelIterations: 2 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.loop.completed" && event.data.reason === "workflow-stages-completed"), false);
    assert.equal(events.some((event) => event.kind === "agent.output-contract.verified" && event.data.status === "fail"), true);
    assert.equal(events.some((event) => event.kind === "agent.repair.started"), true);
    await kernel.shutdown();
  });

  it("does not infer artifact delivery from read-only parent-path boundary prompts", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FakePlatformRuntime("macos") });
    const gateway = new SequentialToolCallModelGateway([]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "检查当前任务目录，说明为什么不应该修改 ../outside-scope.txt，并给出安全替代方案，不要修改任何文件。",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 1 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.output-contract.verified"), false);
    assert.equal(events.some((event) => event.kind === "agent.loop.failed" && event.error?.code === "KERNEL_ENVELOPE_INVALID"), false);
    await kernel.shutdown();
  });

  it("does not infer artifact expectations from tool capability ids in continuation feedback", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FakePlatformRuntime("macos") });
    const gateway = new SequentialToolCallModelGateway([]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/docs/USAGE.md", "# Usage\n");
    await loopDeps.platform.writeFile("/workspace/examples/config.json", "{}\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "在临时项目中生成一个 docs/USAGE.md 和 examples/config.json。",
        "Supervisor rubric feedback: use core.file.write, core.file.edit, core.text.replace, then verify with core.test.run or core.git.diff."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 2 }
    }));

    const outputContract = events.find((event) => event.kind === "agent.output-contract.verified")?.data;
    const diagnostics = outputContract?.diagnostics as readonly { readonly details?: { readonly expectedPath?: string } }[] | undefined;
    const expectedPaths = diagnostics?.map((diagnostic) => diagnostic.details?.expectedPath).filter(Boolean) ?? [];

    assert.equal(expectedPaths.includes("core.file.write"), false);
    assert.equal(expectedPaths.includes("core.test.run"), false);
    assert.equal(expectedPaths.includes("core.git.diff"), false);
    await kernel.shutdown();
  });

  it("projects exact workflow gate alternatives to mutation tools", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new CapturingModelGateway();
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "生成 docs/USAGE.md",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: {
        ...workflowBoundaryProfilePolicy(["core.file.read", "core.file.write", "core.file.edit", "core.patch.apply", "core.workspace.glob"]),
        workflowGateOverride: {
          gate: "output-contract-artifact-repair",
          requiredNextAction: "core.file.write|core.file.edit|core.patch.apply",
          rejectedToolName: "agent.self-repair",
          rejectedCapabilityId: "runtime.output-contract",
          terminalKind: "output-contract.repair-gate.inserted",
          toolCallId: "repair-gate:test"
        }
      },
      toolProjection: "read-write",
      limits: { maxModelIterations: 1 }
    }));

    assert.equal(events.some((event) => event.kind === "model.requested"), true);
    assert.deepEqual(visibleToolNames(gateway.requests[0] as ModelRequest), [
      "core_file_edit",
      "core_file_read",
      "core_file_write",
      "core_patch_apply",
      "core_workspace_glob"
    ]);
    await kernel.shutdown();
  });

  it("rejects case-mismatched artifact repair writes before execution", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FakePlatformRuntime("macos") });
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-wrong-case-write", name: "core_file_write", input: { path: "docs/usage.md", content: "# Usage\n" } }
    ]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "生成 docs/USAGE.md",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      outputContract: {
        schemaVersion: "1.0.0",
        kind: "file",
        required: true,
        path: "docs/USAGE.md",
        verificationExpectations: [{
          schemaVersion: "1.0.0",
          kind: "artifact",
          required: true,
          description: "Requested artifact path must exist exactly as written.",
          path: "docs/USAGE.md",
          redaction: { class: "internal", fields: ["path", "description"] }
        }],
        redaction: { class: "internal", fields: ["path", "verificationExpectations.path", "verificationExpectations.description"] }
      },
      profilePolicy: {
        ...workflowBoundaryProfilePolicy(["core.file.write", "core.file.edit", "core.patch.apply"]),
        workflowGateOverride: {
          gate: "output-contract-artifact-repair",
          requiredNextAction: "core.file.write|core.file.edit|core.patch.apply",
          rejectedToolName: "runtime.workflow-gate",
          rejectedCapabilityId: "runtime.workflow-gate",
          terminalKind: "output-contract.repair-gate.inserted",
          toolCallId: "repair-gate:test"
        }
      },
      toolProjection: "read-write",
      limits: { maxModelIterations: 1 }
    }));

    assert.equal(events.some((event) => event.kind === "capability.started" && event.data.capabilityId === "core.file.write"), false);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.terminalKind === "output-contract.path.rejected"), true);
    const rejection = events.find((event) => event.kind === "model.tool.result" && event.data.terminalKind === "output-contract.path.rejected");
    assert.equal(String(rejection?.data.result ?? "").includes("docs/USAGE.md"), true);
    await kernel.shutdown();
  });

  it("fails closed before model dispatch when the ready engineering stage has no executable tools", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new CapturingModelGateway();
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Edit the fixture and run the focused test.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowEngineeringMissingToolsProfilePolicy(),
      toolProjection: "read-only",
      limits: { maxModelIterations: 1 }
    }));

    assert.equal(gateway.requests.length, 0);
    assert.equal(events.some((event) => event.kind === "model.requested"), false);
    assert.equal(events.at(-1)?.kind, "agent.loop.failed");
    assert.equal(events.at(-1)?.data.reason, "workflow-capability-projection-empty");
    assert.equal(events.at(-1)?.error?.code, "KERNEL_CONFIGURATION_ERROR");
    const details = events.at(-1)?.error?.details as JsonObject | undefined;
    assert.equal(details?.classification, "blocked-by-cli-capability-gap");
    assert.deepEqual(details?.missingCapabilityIds, ["core.file.edit", "core.test.run"]);
    await kernel.shutdown();
  });

  it("classifies workflow projection gaps as unregistered or policy-hidden before model dispatch", async () => {
    const absentDeps = createDeterministicRuntimeDependencies();
    const absentGateway = new CapturingModelGateway();
    const absentLoopDeps = { ...absentDeps, models: absentGateway };
    const absentKernel = await createDefaultRuntimeKernel(absentLoopDeps);
    const absentEvents = await collectRuntimeEvents(runAgentLoop(absentLoopDeps, absentKernel, {
      prompt: "Edit the fixture and run the focused test.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowEngineeringMissingToolsProfilePolicy(),
      toolProjection: "read-write",
      limits: { maxModelIterations: 1 }
    }));
    const absentDetails = absentEvents.at(-1)?.error?.details as JsonObject | undefined;

    assert.equal(absentGateway.requests.length, 0);
    assert.equal(absentDetails?.diagnosticKind, "absent-implementation");
    assert.deepEqual(absentDetails?.unregisteredWorkflowCapabilityIds, ["core.file.edit", "core.test.run"]);
    assert.deepEqual(absentDetails?.policyHiddenCapabilityIds, []);
    await absentKernel.shutdown();

    const hiddenDeps = createDeterministicRuntimeDependencies();
    const hiddenGateway = new CapturingModelGateway();
    const hiddenLoopDeps = { ...hiddenDeps, models: hiddenGateway };
    await registerRuntimeCoreTools(hiddenLoopDeps, "/workspace");
    const hiddenKernel = await createDefaultRuntimeKernel(hiddenLoopDeps);
    const hiddenEvents = await collectRuntimeEvents(runAgentLoop(hiddenLoopDeps, hiddenKernel, {
      prompt: "Edit the fixture and run the focused test.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowEngineeringMissingToolsProfilePolicy(),
      toolProjection: "read-only",
      limits: { maxModelIterations: 1 }
    }));
    const hiddenDetails = hiddenEvents.at(-1)?.error?.details as JsonObject | undefined;

    assert.equal(hiddenGateway.requests.length, 0);
    assert.equal(hiddenDetails?.diagnosticKind, "disabled-by-policy");
    assert.deepEqual(hiddenDetails?.unregisteredWorkflowCapabilityIds, []);
    assert.deepEqual(hiddenDetails?.policyHiddenCapabilityIds, ["core.file.edit", "core.test.run"]);
    await hiddenKernel.shutdown();
  });

  it("emits ready-stage workflow control before model dispatch for primary staged workflows", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new CapturingModelGateway();
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the staged workflow.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: {
        ...stagedWorkflowReadOnlyProfilePolicy(),
        stageAcceptanceMode: "supervisor"
      },
      limits: { maxModelIterations: 1 }
    }));
    const controlIndex = events.findIndex((event) => event.kind === "workflow.ready-stage.control");
    const modelIndex = events.findIndex((event) => event.kind === "model.requested");
    const control = events.find((event) => event.kind === "workflow.ready-stage.control")?.data as JsonObject | undefined;
    const requestedControl = events.find((event) => event.kind === "model.requested")?.data.workflowReadyStageControl as JsonObject | undefined;

    assert.equal(controlIndex >= 0, true);
    assert.equal(modelIndex >= 0, true);
    assert.equal(controlIndex < modelIndex, true);
    assert.equal(control?.stageId, "stage:understand");
    assert.deepEqual(control?.allowedCapabilityIds, ["core.file.read"]);
    assert.equal(control?.requiredNextAction, "core.file.read");
    assert.equal(requestedControl?.stageId, "stage:understand");
    assert.equal(requestedControl?.requiredNextAction, "core.file.read");
    await kernel.shutdown();
  });

  it("passes the authoritative ready-stage next action through prompt assembly", async () => {
    const deps = createDeterministicRuntimeDependencies();
    if (!deps.promptAssembler) throw new Error("expected deterministic prompt assembler");
    const promptAssembler = new CapturingPromptAssembler(deps.promptAssembler);
    const loopDeps = {
      ...deps,
      promptAssembler,
      models: new SingleToolCallModelGateway("core.file.read", { path: "README.md" })
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "workflow evidence\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the staged workflow.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowReadOnlyProfilePolicy(),
      limits: { maxModelIterations: 1 }
    }));
    const nextAction = promptAssembler.inputs[0]?.schedulingNextAction;

    assert.equal(nextAction?.actionClass, "focused-evidence");
    assert.equal(nextAction?.stageId, "stage:understand");
    assert.equal(nextAction?.requiredNextAction, "core.file.read");
    assert.deepEqual(nextAction?.allowedCapabilityIds, ["core.file.read"]);
    assert.deepEqual(nextAction?.acceptedEvidenceRefs, []);
    await kernel.shutdown();
  });

  it("routes a staged workflow through review after the configured ready-stage model budget is spent", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new ReadyStageBudgetReviewModelGateway();
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "workflow evidence\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the staged workflow.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowReadOnlyProfilePolicy(),
      limits: {
        maxModelIterations: 6,
        maxToolCalls: 6,
        stageBudgets: [{
          stageKind: "collect-evidence",
          maxModelIterations: 2,
          maxToolCalls: 2
        }]
      }
    }));

    const controlEvents = events.filter((event) => event.kind === "workflow.ready-stage.control");
    const budgetEvent = events.find((event) => event.kind === "agent.loop.budget.consumed" && event.data.kind === "ready-stage-model-iterations");
    assert.equal(controlEvents.length >= 1, true);
    assert.ok(budgetEvent);
    assert.equal((budgetEvent.data.workflowReadyStageControl as JsonObject | undefined)?.stageKind, "collect-evidence");
    assert.equal((budgetEvent.data.allowed as number | undefined), 2);
    assert.equal((budgetEvent.data.consumed as number | undefined), 2);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("WORKFLOW_STAGE_BUDGET_REVIEW_REQUIRED"))), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.failed" && event.data.reason === "workflow-stage-budget-exceeded"), false);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    await kernel.shutdown();
  });

  it("treats semantic mutation tools as ready-stage progress in engineering produce stages", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SemanticMutationToolCallModelGateway();
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.ts", "export const value = 'old';\n");
    const profilePolicy = engineeringArtifactDeliveryWithPlanAndImplementProfilePolicy();
    const workflow = profilePolicy.stagedTaskWorkflow;
    assert.ok(workflow);
    const implementReadyProfilePolicy: AgentLoopProfilePolicyMetadata = {
      ...profilePolicy,
      workflowCapabilityIds: [
        ...profilePolicy.workflowCapabilityIds,
        "core.text.replace",
        "core.file.copy",
        "core.file.move",
        "core.file.delete",
        "core.directory.create",
        "core.file.touch",
        "core.json.patch",
        "core.archive.create",
        "core.archive.extract",
        "core.revert.undo"
      ],
      stagedTaskWorkflow: {
        ...workflow,
        graph: {
          ...workflow.graph,
          stages: workflow.graph.stages.map((stage) => stage.stageId === "stage:implement"
            ? {
                ...stage,
                allowedTools: [
                  "core.file.read",
                  "core.file.write",
                  "core.file.edit",
                  "core.text.replace",
                  "core.file.copy",
                  "core.file.move",
                  "core.file.delete",
                  "core.directory.create",
                  "core.file.touch",
                  "core.json.patch",
                  "core.archive.create",
                  "core.archive.extract",
                  "core.revert.undo",
                  "core.patch.apply",
                  "core.shell.run"
                ]
              }
            : stage)
        },
        runState: {
          ...workflow.runState,
          stageStates: [
            workflowStageStateForTest("stage:understand", "succeeded", [], ["ref:workflow-understand-evidence"]),
            workflowStageStateForTest("stage:plan", "succeeded", ["ref:workflow-understand-evidence"], ["ref:workflow-plan-evidence"]),
            workflowStageStateForTest("stage:implement", "ready", ["ref:workflow-plan-evidence"]),
            workflowStageStateForTest("stage:verify", "pending", ["ref:workflow-implementation-evidence"]),
            workflowStageStateForTest("stage:report", "pending", ["ref:workflow-verify-evidence"])
          ]
        }
      }
    };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use semantic editing to implement the change.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: implementReadyProfilePolicy,
      limits: { maxModelIterations: 1 }
    }));
    const control = events.find((event) => event.kind === "workflow.ready-stage.control")?.data as JsonObject | undefined;

    assert.equal(control?.stageId, "stage:implement");
    assert.ok((control?.progressCapabilityIds as string[] | undefined)?.includes("core.text.replace"));
    assert.equal(events.some((event) => event.kind === "workflow.required-action.missed"), false);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.name === "core.text.replace"), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.failed" && event.data.reason === "workflow-required-action-missed"), false);
    await kernel.shutdown();
  });

  it("explains produce-stage required-action misses as workspace mutation choices", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-repeat-read-1", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-repeat-read-2", name: "core.file.read", input: { path: "README.md" } }
    ]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "workflow evidence\n");
    const profilePolicy = engineeringArtifactDeliveryWithPlanAndImplementProfilePolicy();
    const workflow = profilePolicy.stagedTaskWorkflow;
    assert.ok(workflow);
    const implementReadyProfilePolicy: AgentLoopProfilePolicyMetadata = {
      ...profilePolicy,
      workflowCapabilityIds: [
        ...profilePolicy.workflowCapabilityIds,
        "core.text.replace",
        "core.file.copy",
        "core.file.move",
        "core.file.delete",
        "core.directory.create",
        "core.file.touch",
        "core.json.patch",
        "core.archive.create",
        "core.archive.extract",
        "core.revert.undo"
      ],
      stagedTaskWorkflow: {
        ...workflow,
        graph: {
          ...workflow.graph,
          stages: workflow.graph.stages.map((stage) => stage.stageId === "stage:implement"
            ? {
                ...stage,
                allowedTools: [
                  "core.file.read",
                  "core.file.write",
                  "core.file.edit",
                  "core.text.replace",
                  "core.file.copy",
                  "core.file.move",
                  "core.file.delete",
                  "core.directory.create",
                  "core.file.touch",
                  "core.json.patch",
                  "core.archive.create",
                  "core.archive.extract",
                  "core.revert.undo",
                  "core.patch.apply",
                  "core.shell.run"
                ]
              }
            : stage)
        },
        runState: {
          ...workflow.runState,
          stageStates: [
            workflowStageStateForTest("stage:understand", "succeeded", [], ["ref:workflow-understand-evidence"]),
            workflowStageStateForTest("stage:plan", "succeeded", ["ref:workflow-understand-evidence"], ["ref:workflow-plan-evidence"]),
            workflowStageStateForTest("stage:implement", "ready", ["ref:workflow-plan-evidence"]),
            workflowStageStateForTest("stage:verify", "pending", ["ref:workflow-implementation-evidence"]),
            workflowStageStateForTest("stage:report", "pending", ["ref:workflow-verify-evidence"])
          ]
        }
      }
    };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use mutation tools to implement the change.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: implementReadyProfilePolicy,
      limits: { maxModelIterations: 2 }
    }));
    const correctionMessage = gateway.requests.at(1)?.messages?.at(-1);
    const correctionContent = String(correctionMessage?.content ?? "");

    assert.equal(correctionMessage?.role, "user");
    assert.equal(correctionContent.includes("Required action meaning: call one visible workspace mutation tool"), true);
    assert.equal(correctionContent.includes("Do not call read/search/list tools again for this produce stage"), true);
    assert.equal(correctionContent.includes("core_text_replace"), true);
    assert.equal(events.some((event) => event.kind === "workflow.required-action.missed"), true);
    await kernel.shutdown();
  });

  it("keeps supervisor-reviewed produce stages on mutation progress tools", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SingleToolCallModelGateway("core.file.edit", {
      path: "README.md",
      expected: "old",
      replacement: "new"
    });
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "old\n");
    const profilePolicy = engineeringArtifactDeliveryWithPlanAndImplementProfilePolicy();
    const workflow = profilePolicy.stagedTaskWorkflow;
    assert.ok(workflow);
    const reviewedProducePolicy: AgentLoopProfilePolicyMetadata = {
      ...profilePolicy,
      stageAcceptanceMode: "supervisor",
      stagedTaskWorkflow: {
        ...workflow,
        runState: {
          ...workflow.runState,
          stageStates: [
            workflowStageStateForTest("stage:understand", "succeeded", [], ["ref:workflow-understand-evidence"]),
            workflowStageStateForTest("stage:plan", "succeeded", ["ref:workflow-understand-evidence"], ["ref:workflow-plan-evidence"]),
            {
              ...workflowStageStateForTest("stage:implement", "running", ["ref:workflow-plan-evidence"]),
              evaluation: {
                schemaVersion: "1.0.0",
                evaluationId: "evaluation:stage:implement:test-needs-review",
                stageId: "stage:implement",
                evaluatorId: "runtime:test",
                status: "needs-review",
                reason: "Test fixture keeps the produce stage under supervisor review without output evidence.",
                evidenceRefs: [],
                evaluatedAt: "1970-01-01T00:00:00.000Z",
                compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
                redaction: { class: "internal", fields: ["reason"] }
              }
            },
            workflowStageStateForTest("stage:verify", "pending", ["ref:workflow-implementation-evidence"]),
            workflowStageStateForTest("stage:report", "pending", ["ref:workflow-verify-evidence"])
          ]
        }
      }
    };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "continue the active implementation stage",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: reviewedProducePolicy,
      limits: { maxModelIterations: 1 }
    }));
    const control = events.find((event) => event.kind === "workflow.ready-stage.control")?.data as JsonObject | undefined;
    const visibleTools = events.find((event) => event.kind === "tool.decision-board.snapshot")?.data.visibleToolIds as string[] | undefined;

    assert.equal(control?.stageId, "stage:implement");
    assert.deepEqual(control?.progressCapabilityIds, ["core.file.edit", "core.patch.apply"]);
    assert.equal(visibleTools?.includes("core.file.edit"), true);
    assert.equal(visibleTools?.includes("core.test.run"), true);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.edit" &&
      event.data.terminalKind === "workflow-capability-boundary.rejected"
    ), false);
    await kernel.shutdown();
  });

  it("fails closed when a reviewed ready-stage model budget is exhausted again without progress", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-read-1", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-read-2", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-read-3", name: "core.file.read", input: { path: "README.md" } }
    ]);
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "budget\n");
    const profilePolicy = engineeringArtifactDeliveryWithPlanAndImplementProfilePolicy();
    const workflow = profilePolicy.stagedTaskWorkflow;
    assert.ok(workflow);
    const implementReadyProfilePolicy: AgentLoopProfilePolicyMetadata = {
      ...profilePolicy,
      stagedTaskWorkflow: {
        ...workflow,
        runState: {
          ...workflow.runState,
          stageStates: [
            workflowStageStateForTest("stage:understand", "succeeded", [], ["ref:workflow-understand-evidence"]),
            workflowStageStateForTest("stage:plan", "succeeded", ["ref:workflow-understand-evidence"], ["ref:workflow-plan-evidence"]),
            workflowStageStateForTest("stage:implement", "ready", ["ref:workflow-plan-evidence"]),
            workflowStageStateForTest("stage:verify", "pending", ["ref:workflow-implementation-evidence"]),
            workflowStageStateForTest("stage:report", "pending", ["ref:workflow-verify-evidence"])
          ]
        }
      }
    };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "keep spending implementation budget without mutation",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: implementReadyProfilePolicy,
      limits: {
        maxModelIterations: 8,
        stageBudgets: [{
          stageId: "stage:implement",
          maxModelIterations: 1,
          stopReason: "test-implement-budget"
        }]
      }
    }));

    const budgetEvents = events.filter((event) => event.kind === "agent.loop.budget.consumed");
    const failed = events.find((event) => event.kind === "agent.loop.failed");
    assert.equal(budgetEvents.length, 2);
    assert.equal(failed?.data.reason, "test-implement-budget");
    assert.equal(events.filter((event) => event.kind === "model.requested").length <= 2, true);
    await kernel.shutdown();
  });

  it("does not exhaust correction budget on multiple non-progress tool calls from one model response", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new MultiReadThenMutationModelGateway([
      { id: "call-repeat-read-1", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-repeat-read-2", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-repeat-read-3", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-repeat-read-4", name: "core.file.read", input: { path: "README.md" } }
    ], { id: "call-mutation-after-correction", name: "core.text.replace", input: { path: "README.md", oldText: "old", newText: "new" } });
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "old\n");
    const profilePolicy = engineeringArtifactDeliveryWithPlanAndImplementProfilePolicy();
    const workflow = profilePolicy.stagedTaskWorkflow;
    assert.ok(workflow);
    const implementReadyProfilePolicy: AgentLoopProfilePolicyMetadata = {
      ...profilePolicy,
      workflowCapabilityIds: [...profilePolicy.workflowCapabilityIds, "core.text.replace"],
      stagedTaskWorkflow: {
        ...workflow,
        graph: {
          ...workflow.graph,
          stages: workflow.graph.stages.map((stage) => stage.stageId === "stage:implement"
            ? { ...stage, allowedTools: ["core.file.read", "core.file.write", "core.file.edit", "core.text.replace", "core.patch.apply"] }
            : stage)
        },
        runState: {
          ...workflow.runState,
          stageStates: [
            workflowStageStateForTest("stage:understand", "succeeded", [], ["ref:workflow-understand-evidence"]),
            workflowStageStateForTest("stage:plan", "succeeded", ["ref:workflow-understand-evidence"], ["ref:workflow-plan-evidence"]),
            workflowStageStateForTest("stage:implement", "ready", ["ref:workflow-plan-evidence"]),
            workflowStageStateForTest("stage:verify", "pending", ["ref:workflow-implementation-evidence"]),
            workflowStageStateForTest("stage:report", "pending", ["ref:workflow-verify-evidence"])
          ]
        }
      }
    };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use mutation tools to implement the change.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: implementReadyProfilePolicy,
      limits: { maxModelIterations: 3 }
    }));
    const misses = events.filter((event) => event.kind === "workflow.required-action.missed" && event.data.stageId === "stage:implement");

    assert.equal(misses.length < 3, true);
    assert.equal(gateway.requests.length >= 2, true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.name === "core.text.replace"), true);
    assert.equal(events.filter((event) => event.kind === "model.tool.intent" && event.data.name === "core.file.read").length < 4, true);
    await kernel.shutdown();
  });

  it("gives one bounded correction when a required ready-stage action receives no model tool call", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new NoToolThenToolCallModelGateway("core.file.read", { path: "README.md" });
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "workflow evidence\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the staged workflow.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowReadOnlyProfilePolicy(),
      limits: { maxModelIterations: 2 }
    }));
    const missed = events.find((event) => event.kind === "workflow.required-action.missed");
    const correctedRequest = gateway.requests.at(1);

    assert.equal(events.filter((event) => event.kind === "model.requested").length, 2);
    assert.equal(missed?.data.stageId, "stage:understand");
    assert.equal(missed?.data.requiredNextAction, "core.file.read");
    assert.equal(missed?.data.retryPolicy, "correct-bounded");
    const correctionMessage = correctedRequest?.messages?.at(-1);
    const correctionContent = String(correctionMessage?.content ?? "");
    assert.equal(correctionMessage?.role, "user");
    assert.equal(correctionContent.includes("WORKFLOW_REQUIRED_ACTION_MISSED"), true);
    assert.equal(correctionContent.includes("Correction attempt: 1/3"), true);
    assert.equal(correctionContent.includes("Active stage: stage:understand"), true);
    assert.equal(correctionContent.includes("Required next action: core.file.read"), true);
    assert.equal(correctionContent.includes("Allowed capabilities: core.file.read"), true);
    assert.equal(correctionContent.includes("Do not answer with text-only output for this stage"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.name === "core.file.read"), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.failed" && event.data.reason === "workflow-required-action-missed"), false);
    await kernel.shutdown();
  });

  it("fails closed when a required ready-stage action exhausts the correction budget", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new CapturingModelGateway();
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the staged workflow.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowReadOnlyProfilePolicy(),
      limits: { maxModelIterations: 5 }
    }));
    const misses = events.filter((event) => event.kind === "workflow.required-action.missed");

    assert.equal(events.filter((event) => event.kind === "model.requested").length, 4);
    assert.equal(misses.length, 4);
    assert.equal(misses[0]?.data.retryPolicy, "correct-bounded");
    assert.equal(misses[1]?.data.retryPolicy, "correct-bounded");
    assert.equal(misses[2]?.data.retryPolicy, "correct-bounded");
    assert.equal(misses[3]?.data.retryPolicy, "fail-closed");
    assert.equal(misses[3]?.data.stageId, "stage:understand");
    assert.equal(misses[3]?.data.requiredNextAction, "core.file.read");
    assert.equal(events.at(-1)?.kind, "agent.loop.failed");
    assert.equal(events.at(-1)?.data.reason, "workflow-required-action-missed");
    await kernel.shutdown();
  });

  it("fails closed when model repeats a non-progress tool for the ready workflow stage", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-understand-read", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-plan-search", name: "core.search.text", input: { pattern: "workflow", glob: "**/*.md", outputMode: "files" } },
      { id: "call-verify-read-1", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-verify-read-2", name: "core.file.read", input: { path: "README.md" } }
    ]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "workflow evidence\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the engineering staged workflow and verify with a test.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: engineeringStagedWorkflowWithPlanProfilePolicy(),
      limits: { maxModelIterations: 8 }
    }));
    const misses = events.filter((event) => event.kind === "workflow.required-action.missed");

    assert.equal(misses.length, 4);
    assert.equal(misses[0]?.data.stageId, "stage:verify");
    assert.equal(misses[0]?.data.requestedCapabilityId, "core.file.read");
    assert.equal(misses[0]?.data.requiredNextAction, "core.test.run");
    assert.equal(misses[3]?.data.retryPolicy, "fail-closed");
    assert.equal(events.at(-1)?.kind, "agent.loop.failed");
    assert.equal(events.at(-1)?.data.reason, "workflow-required-action-missed");
    assert.equal(events.some((event) => event.kind === "agent.loop.failed" && event.data.reason === "model-iteration-limit"), false);
    await kernel.shutdown();
  });

  it("closes a terminal staged workflow capability exactly once from generic ready-stage control", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SingleToolCallModelGateway("core.test.run", {
      command: "python",
      args: ["-m", "pytest", "tests/test_demo.py"],
      intent: "unit"
    });
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the generic terminal staged workflow.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowTerminalScoreProfilePolicy(),
      limits: { maxModelIterations: 3 }
    }));
    const control = events.find((event) => event.kind === "workflow.ready-stage.control")?.data as JsonObject | undefined;

    assert.equal(control?.terminalClosePolicy, "close-on-progress-capability");
    assert.equal(events.some((event) => event.kind === "capability.completed" && event.data.capabilityId === "core.test.run"), true);
    assert.equal(events.filter((event) => event.kind === "agent.loop.completed").length, 1);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal(events.at(-1)?.data.reason, "terminal-tool-completed");
    assert.equal(gateway.requests.length, 1);
    await kernel.shutdown();
  });

  it("closes a terminal staged workflow capability failure instead of asking the model to retry", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SingleToolCallModelGateway("core.workflow.terminal", { status: "failed" });
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.capabilities.register({
      ...runtimeEchoCapability,
      id: asId<"capability">("core.workflow.terminal"),
      name: "Workflow Terminal",
      sideEffect: "none",
      permissions: []
    }, async () => ({
      ok: false,
      error: {
        code: "WORKFLOW_TERMINAL_FAILED",
        message: "Terminal workflow capability failed.",
        retryable: false,
        redaction: { class: "public" }
      }
    }));
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the generic terminal staged workflow and report the failing test.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowTerminalFailureProfilePolicy(),
      limits: { maxModelIterations: 3 }
    }));

    assert.equal(events.some((event) => event.kind === "capability.failed" && event.data.capabilityId === "core.workflow.terminal"), true);
    assert.equal(events.filter((event) => event.kind === "model.tool.intent").length, 1);
    assert.equal(events.filter((event) => event.kind === "model.requested").length, 1);
    assert.equal(events.filter((event) => event.kind === "agent.loop.failed").length, 1);
    assert.equal(events.at(-1)?.kind, "agent.loop.failed");
    assert.equal(events.at(-1)?.data.reason, "terminal-tool-failed");
    const terminalTool = events.at(-1)?.data.terminalTool as JsonObject | undefined;
    assert.equal(terminalTool?.terminalKind, "capability.failed");
    assert.equal(gateway.requests.length, 1);
    await kernel.shutdown();
  });

  it("closes a terminal collect-evidence workflow capability with warning evidence instead of re-running it", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SingleToolCallModelGateway("core.workflow.terminal", { status: "warn" });
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.capabilities.register({
      ...runtimeEchoCapability,
      id: asId<"capability">("core.workflow.terminal"),
      name: "Workflow Terminal",
      sideEffect: "none",
      permissions: []
    }, async () => ({
      ok: true,
      value: {
        evidence: {
          status: "warn",
          metadata: {
            resolved: false
          }
        }
      }
    }));
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the generic terminal staged workflow and report the unresolved score.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowTerminalCollectEvidenceProfilePolicy(),
      limits: { maxModelIterations: 3 }
    }));

    assert.equal(events.some((event) => event.kind === "capability.completed" && event.data.capabilityId === "core.workflow.terminal"), true);
    assert.equal(events.filter((event) => event.kind === "model.tool.intent").length, 1);
    assert.equal(events.filter((event) => event.kind === "model.requested").length, 1);
    assert.equal(events.filter((event) => event.kind === "agent.loop.completed").length, 1);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal(events.at(-1)?.data.reason, "terminal-tool-completed");
    const terminalTool = events.at(-1)?.data.terminalTool as JsonObject | undefined;
    assert.equal(terminalTool?.terminalKind, "capability.completed");
    assert.equal(terminalTool?.feedbackStatus, "success");
    assert.equal(gateway.requests.length, 1);
    await kernel.shutdown();
  });

  it("requires stage evaluation before successful tool evidence can advance downstream workflow stages", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SingleToolCallModelGateway("core.file.read", { path: "README.md" });
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "workflow evidence\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the staged workflow.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowProgressProfilePolicy(),
      limits: { maxModelIterations: 2 }
    }));
    const secondModelRequest = events
      .filter((event) => event.kind === "model.requested")
      .at(1);
    const secondDecisionBoard = events
      .filter((event) => event.kind === "tool.decision-board.snapshot")
      .at(1);
    const progressed = secondModelRequest?.data.profilePolicy as AgentLoopProfilePolicyMetadata | undefined;
    const stageStates = progressed?.stagedTaskWorkflow?.runState.stageStates.map((stage) => `${stage.stageId}:${stage.status}:${stage.outputRefs.join(",")}`) ?? [];
    const workflowStep = events.find((event) => event.kind === "workflow.step" && event.data.stageId === "stage:understand" && event.data.status === "evaluation-required");
    const workflowStageEvent = jsonObjectRecord(workflowStep?.data.stageEvent);
    const workflowStageEvaluation = jsonObjectRecord(workflowStageEvent?.evaluation);

    assert.equal(events.some((event) => event.kind === "workflow.step" && event.data.stageId === "stage:understand" && event.data.status === "running"), true);
    assert.equal(workflowStep?.data.status, "evaluation-required");
    assert.equal(workflowStageEvaluation?.status, "needs-review");
    assert.deepEqual(stageStates, [
      "stage:understand:running:ref:workflow-understand-evidence",
      "stage:verify:pending:"
    ]);
    assert.equal(jsonObjectRecord(secondModelRequest?.data.workflowReadyStageControl)?.stageId, "stage:verify");
    assert.equal(secondModelRequest?.data.visibleToolCount, 3);
    assert.deepEqual(secondDecisionBoard?.data.visibleToolIds, ["core.file.read", "core.git.diff", "core.test.run"]);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => String(message.content ?? "").includes("stage:understand:running"))), true);
    await kernel.shutdown();
  });

  it("advances ordinary engineering workflows without technical director acceptance", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SingleToolCallModelGateway("core.file.read", { path: "README.md" });
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "workflow evidence\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the engineering staged workflow.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: engineeringStagedWorkflowProgressProfilePolicy(),
      limits: { maxModelIterations: 2 }
    }));
    const secondModelRequest = events
      .filter((event) => event.kind === "model.requested")
      .at(1);
    const progressed = secondModelRequest?.data.profilePolicy as AgentLoopProfilePolicyMetadata | undefined;
    const stageStates = progressed?.stagedTaskWorkflow?.runState.stageStates.map((stage) => `${stage.stageId}:${stage.status}:${stage.outputRefs.join(",")}`) ?? [];

    assert.equal(events.some((event) => event.kind === "workflow.step" && event.data.stageId === "stage:understand" && event.data.status === "succeeded"), true);
    assert.equal(events.some((event) => event.kind === "workflow.step" && event.data.stageId === "stage:understand" && event.data.status === "evaluation-required"), false);
    assert.deepEqual(stageStates, [
      "stage:understand:succeeded:ref:workflow-understand-evidence",
      "stage:verify:ready:"
    ]);
    assert.equal(events.some((event) => event.kind === "workflow.ready-stage.control" && event.data.stageId === "stage:verify"), true);
    assert.equal(jsonObjectRecord(secondModelRequest?.data.workflowReadyStageControl)?.stageId, "stage:verify");
    assert.equal(secondModelRequest?.data.visibleToolCount, 3);
    await kernel.shutdown();
  });

  it("advances ordinary engineering plan stages from declared planning evidence without reopening completed stages", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-understand-read", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-plan-search", name: "core.search.text", input: { pattern: "workflow", glob: "**/*.md", outputMode: "files" } }
    ]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "workflow evidence\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the engineering staged workflow and create a plan from repository evidence.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: engineeringStagedWorkflowWithPlanProfilePolicy(),
      limits: { maxModelIterations: 3 }
    }));
    const thirdModelRequest = events
      .filter((event) => event.kind === "model.requested")
      .at(2);
    const progressed = thirdModelRequest?.data.profilePolicy as AgentLoopProfilePolicyMetadata | undefined;
    const stageStates = progressed?.stagedTaskWorkflow?.runState.stageStates.map((stage) => `${stage.stageId}:${stage.status}:${stage.outputRefs.join(",")}`) ?? [];

    assert.equal(events.filter((event) => event.kind === "workflow.step" && event.data.stageId === "stage:understand" && event.data.status === "succeeded").length, 1);
    assert.equal(events.some((event) => event.kind === "workflow.step" && event.data.stageId === "stage:plan" && event.data.status === "succeeded"), true);
    assert.deepEqual(stageStates, [
      "stage:understand:succeeded:ref:workflow-understand-evidence",
      "stage:plan:succeeded:ref:workflow-plan-evidence",
      "stage:verify:ready:"
    ]);
    assert.equal(jsonObjectRecord(thirdModelRequest?.data.workflowReadyStageControl)?.stageId, "stage:verify");
    assert.equal(thirdModelRequest?.data.visibleToolCount, 4);
    await kernel.shutdown();
  });

  it("uses latest workflow state between multiple tool calls in the same model response", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new MultiToolCallModelGateway([
      { id: "call-same-response-understand", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-same-response-plan", name: "core.search.text", input: { pattern: "workflow", glob: "**/*.md", outputMode: "files" } }
    ]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "workflow evidence\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the engineering staged workflow with multiple evidence calls.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: engineeringStagedWorkflowWithPlanProfilePolicy(),
      limits: { maxModelIterations: 2 }
    }));
    const workflowSteps = events.filter((event) => event.kind === "workflow.step");

    assert.equal(workflowSteps.filter((event) => event.data.stageId === "stage:understand" && event.data.status === "succeeded").length, 1);
    assert.equal(workflowSteps.filter((event) => event.data.stageId === "stage:plan" && event.data.status === "succeeded").length, 1);
    assert.equal(events.some((event) => event.kind === "workflow.ready-stage.control" && event.data.stageId === "stage:verify"), true);
    await kernel.shutdown();
  });

  it("advances read-only analysis workflows through inspection and report stages without mutation tools", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-analysis-understand-read", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-analysis-inspect-search", name: "core.search.text", input: { pattern: "workflow", glob: "**/*.md", outputMode: "files" } },
      { id: "call-analysis-report-diff", name: "core.git.diff", input: {} }
    ]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "workflow evidence\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the read-only analysis staged workflow.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: readOnlyAnalysisStagedWorkflowProfilePolicy(),
      limits: { maxModelIterations: 4 }
    }));
    const finalWorkflowStep = events
      .filter((event) => event.kind === "workflow.step")
      .at(-1);
    const progressed = jsonObjectRecord(finalWorkflowStep?.data.runState);
    const progressedStageStates = Array.isArray(progressed?.stageStates) ? progressed.stageStates : [];
    const stageStates = progressedStageStates
      .map((stage) => jsonObjectRecord(stage))
      .map((stage) => `${stage?.stageId}:${stage?.status}:${Array.isArray(stage?.outputRefs) ? stage.outputRefs.join(",") : ""}`);
    const visibleCounts = events
      .filter((event) => event.kind === "model.requested")
      .map((event) => event.data.visibleToolCount)
      .filter((count): count is number => typeof count === "number");

    assert.deepEqual(stageStates, [
      "stage:understand:succeeded:ref:workflow-understand-evidence",
      "stage:inspect:succeeded:ref:workflow-inspect-evidence",
      "stage:report:succeeded:ref:workflow-report-evidence"
    ]);
    assert.equal(events.some((event) => event.kind === "workflow.step" && event.data.stageId === "stage:inspect" && event.data.status === "succeeded"), true);
    assert.equal(events.some((event) => event.kind === "workflow.step" && event.data.stageId === "stage:report" && event.data.status === "succeeded"), true);
    assert.equal(Math.max(...visibleCounts), 4);
    await kernel.shutdown();
  });

  it("completes automatic primary staged workflows when every stage has succeeded", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-complete-understand", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-complete-inspect", name: "core.search.text", input: { pattern: "workflow", glob: "**/*.md", outputMode: "files" } },
      { id: "call-complete-report", name: "core.git.diff", input: {} }
    ]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "workflow evidence\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the read-only analysis staged workflow and stop after report.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: readOnlyAnalysisStagedWorkflowProfilePolicy(),
      limits: { maxModelIterations: 8 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.loop.completed" && event.data.reason === "workflow-stages-completed"), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.failed" && event.data.reason === "model-iteration-limit"), false);
    assert.equal(events.filter((event) => event.kind === "model.requested").length, 3);
    await kernel.shutdown();
  });

  it("does not complete change workflow stages from read-only evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-understand-read", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-change-read-only", name: "core.file.read", input: { path: "src/example.py" } }
    ]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "workflow evidence\n");
    await loopDeps.platform.writeFile("/workspace/src/example.py", "value = 1\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the staged edit workflow.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowChangeReadProfilePolicy(),
      limits: { maxModelIterations: 3 }
    }));
    const latestModelRequest = events
      .filter((event) => event.kind === "model.requested")
      .at(-1);
    const progressed = latestModelRequest?.data.profilePolicy as AgentLoopProfilePolicyMetadata | undefined;
    const stageStates = progressed?.stagedTaskWorkflow?.runState.stageStates.map((stage) => `${stage.stageId}:${stage.status}:${stage.outputRefs.join(",")}`) ?? [];

    assert.equal(events.some((event) => event.kind === "workflow.step" && event.data.status === "evaluation-required" && event.data.stageId === "stage:understand"), true);
    assert.equal(events.some((event) => event.kind === "workflow.step" && event.data.status === "succeeded" && event.data.stageId === "stage:change"), false);
    assert.deepEqual(stageStates, [
      "stage:understand:running:ref:workflow-understand-evidence",
      "stage:change:pending:",
      "stage:verify:pending:"
    ]);
    await kernel.shutdown();
  });

  it("does not advance workflow stages from failed tool evidence", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FailedTestFakePlatformRuntime() });
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-workflow-understand-read", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-workflow-failed-test", name: "core.test.run", input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"], intent: "unit" } }
    ]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "workflow evidence\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the staged workflow.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowProgressProfilePolicy(),
      limits: { maxModelIterations: 3 }
    }));
    const latestModelRequest = events
      .filter((event) => event.kind === "model.requested")
      .at(-1);
    const progressed = latestModelRequest?.data.profilePolicy as AgentLoopProfilePolicyMetadata | undefined;
    const stageStates = progressed?.stagedTaskWorkflow?.runState.stageStates.map((stage) => `${stage.stageId}:${stage.status}:${stage.outputRefs.join(",")}`) ?? [];

    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-workflow-failed-test" && event.data.terminalKind === "capability.completed"), true);
    assert.equal(events.some((event) => event.kind === "workflow.step" && event.data.status === "succeeded" && event.data.stageId === "stage:verify"), false);
    assert.deepEqual(stageStates, [
      "stage:understand:running:ref:workflow-understand-evidence",
      "stage:verify:pending:"
    ]);
    await kernel.shutdown();
  });

  it("continues after a failed standard verify command instead of consuming required-action miss budget", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FailedTestFakePlatformRuntime() });
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-workflow-understand-read", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-workflow-failed-test", name: "core.test.run", input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"], intent: "unit" } },
      { id: "call-workflow-verify-diff", name: "core.git.diff", input: {} }
    ]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "workflow evidence\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the staged workflow and recover from failing tests.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowProgressProfilePolicy(),
      limits: { maxModelIterations: 3 }
    }));

    assert.equal(events.some((event) => event.kind === "workflow.required-action.missed" && event.data.failedProgressCapability === true), false);
    assert.equal(events.filter((event) => event.kind === "model.requested").length, 3);
    assert.equal(
      gateway.requests[2]?.messages?.some((message) => message.role === "tool" && message.toolCallId === "call-workflow-failed-test" && message.content.includes("failed")),
      true
    );
    await kernel.shutdown();
  });

  it("allows repeated focused source reads after a failed projected verify command", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FailedTestFakePlatformRuntime() });
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-workflow-understand-read", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-workflow-failed-test", name: "core.test.run", input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"], intent: "unit" } },
      { id: "call-workflow-refresh-read", name: "core.file.read", input: { path: "src/example.py" } },
      { id: "call-workflow-second-refresh-read", name: "core.file.read", input: { path: "src/example.py", offset: 1, limit: 20 } }
    ]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "workflow evidence\n");
    await loopDeps.platform.writeFile("/workspace/src/example.py", "value = 1\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the staged workflow and repair after the failing test.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowProgressProfilePolicy(),
      limits: { maxModelIterations: 6 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.requestedCapabilityId === "core.file.read" &&
      event.data.stageId === "stage:verify"
    ), false);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolCallId === "call-workflow-second-refresh-read" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    await kernel.shutdown();
  });

  it("does not advance verify workflow stages from non-test core.test.run evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-workflow-understand-read", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-workflow-source-probe-test-tool", name: "core.test.run", input: { command: "sed", args: ["-n", "1,20p", "README.md"], intent: "source inspection" } }
    ]);
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/README.md", "workflow evidence\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the staged workflow.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowProgressProfilePolicy(),
      limits: { maxModelIterations: 3 }
    }));
    const latestModelRequest = events
      .filter((event) => event.kind === "model.requested")
      .at(-1);
    const progressed = latestModelRequest?.data.profilePolicy as AgentLoopProfilePolicyMetadata | undefined;
    const stageStates = progressed?.stagedTaskWorkflow?.runState.stageStates.map((stage) => `${stage.stageId}:${stage.status}:${stage.outputRefs.join(",")}`) ?? [];

    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolCallId === "call-workflow-source-probe-test-tool" &&
      event.data.terminalKind === "workflow-capability-boundary.rejected" &&
      event.error?.code === "WORKFLOW_STANDARD_TEST_REQUIRED"
    ), true);
    assert.equal(events.some((event) => event.kind === "workflow.step" && event.data.status === "succeeded" && event.data.stageId === "stage:verify"), false);
    assert.deepEqual(stageStates, [
      "stage:understand:running:ref:workflow-understand-evidence",
      "stage:verify:pending:"
    ]);
    await kernel.shutdown();
  });

  it("fails the agent loop on provider errors", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const loopDeps = { ...deps, models: new ErrorModelGateway() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "provider failure",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    assert.equal(events.some((event) => event.kind === "runtime.error" && event.error?.code === "MODEL_FAILED"), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.failed");
    assert.equal(events.at(-1)?.data.status, "failed");
    await kernel.shutdown();
  });

  it("classifies failures without activating repair when self-repair is disabled", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const loopDeps = { ...deps, models: new ErrorModelGateway() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "provider failure",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    assert.equal(events.some((event) => event.kind === "agent.repair.classified"), true);
    assert.equal(events.some((event) => event.kind === "agent.repair.plan.created"), false);
    const terminalData = events.at(-1)?.data as { selfRepair?: { enabled?: boolean; activated?: boolean } } | undefined;
    assert.equal(terminalData?.selfRepair?.enabled, false);
    assert.equal(terminalData?.selfRepair?.activated, false);
    await kernel.shutdown();
  });

  it("runs one bounded self-repair model-feedback attempt before terminal failure", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new RepairingProviderErrorModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "provider failure then repair",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      selfRepair: { enabled: true, maxAttempts: 1, requireCheckpointForWrites: false, verificationMode: "minimal" },
      limits: { maxModelIterations: 3, maxRepairAttempts: 1 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.repair.started"), true);
    assert.equal(events.some((event) => event.kind === "agent.repair.plan.created"), true);
    assert.equal(events.some((event) => event.kind === "agent.repair.attempt.completed"), true);
    assert.equal(gateway.requests.length, 2);
    assert.equal(gateway.requests[1]?.messages?.some(isSelfRepairFeedback), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    const terminalData = events.at(-1)?.data as { selfRepair?: { activated?: boolean; attemptCount?: number } } | undefined;
    assert.equal(terminalData?.selfRepair?.activated, true);
    assert.equal(terminalData?.selfRepair?.attemptCount, 1);
    await kernel.shutdown();
  });

  it("stops write-capable self-repair when checkpoint evidence is unavailable", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const loopDeps = { ...deps, models: new TypecheckErrorModelGateway() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "typecheck failure needing repair",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      selfRepair: { enabled: true, maxAttempts: 1, requireCheckpointForWrites: true, verificationMode: "targeted" },
      limits: { maxModelIterations: 3, maxRepairAttempts: 1 }
    }));

    const stopped = events.find((event) => event.kind === "agent.repair.stopped")?.data as { stopReason?: string } | undefined;
    const terminalData = events.at(-1)?.data as { selfRepair?: { stopReason?: string; attemptCount?: number; classifications?: readonly { failureSource?: string }[] } } | undefined;
    assert.equal(events.some((event) => event.kind === "agent.repair.plan.created"), true);
    assert.equal(events.some((event) => event.kind === "agent.repair.attempt.started"), false);
    assert.equal(stopped?.stopReason, "checkpoint-unavailable");
    assert.equal(events.at(-1)?.kind, "agent.loop.failed");
    assert.equal(terminalData?.selfRepair?.stopReason, "checkpoint-unavailable");
    assert.equal(terminalData?.selfRepair?.attemptCount, 0);
    assert.equal(terminalData?.selfRepair?.classifications?.[0]?.failureSource, "build-test-error");
    await kernel.shutdown();
  });

  it("stops self-repair without mutation for non-repairable credential failures", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const loopDeps = { ...deps, models: new MissingCredentialModelGateway() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "provider credential failure",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      selfRepair: { enabled: true, maxAttempts: 1, requireCheckpointForWrites: false, verificationMode: "minimal" }
    }));

    const stopped = events.find((event) => event.kind === "agent.repair.stopped")?.data as { stopReason?: string; classification?: { repairability?: string } } | undefined;
    const terminalData = events.at(-1)?.data as { selfRepair?: { stopReason?: string; attemptCount?: number } } | undefined;
    assert.equal(stopped?.stopReason, "not-repairable");
    assert.equal(stopped?.classification?.repairability, "not-repairable");
    assert.equal(events.some((event) => event.kind === "agent.repair.attempt.started"), false);
    assert.equal(terminalData?.selfRepair?.stopReason, "not-repairable");
    assert.equal(terminalData?.selfRepair?.attemptCount, 0);
    await kernel.shutdown();
  });

  it("fails closed when a bounded self-repair attempt does not clear the failure", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new PersistentRepairFailureModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "provider failure persists after repair",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      selfRepair: { enabled: true, maxAttempts: 1, requireCheckpointForWrites: false, verificationMode: "minimal" },
      limits: { maxModelIterations: 3, maxRepairAttempts: 1 }
    }));

    const stops = events.filter((event) => event.kind === "agent.repair.stopped").map((event) => event.data as { stopReason?: string });
    const terminalData = events.at(-1)?.data as { selfRepair?: { stopReason?: string; attemptCount?: number; successCount?: number } } | undefined;
    assert.deepEqual(stops.map((stop) => stop.stopReason), ["completed", "budget-exhausted"]);
    assert.equal(events.at(-1)?.kind, "agent.loop.failed");
    assert.equal(terminalData?.selfRepair?.stopReason, "budget-exhausted");
    assert.equal(terminalData?.selfRepair?.attemptCount, 1);
    assert.equal(terminalData?.selfRepair?.successCount, 0);
    assert.equal(gateway.requests.length, 2);
    await kernel.shutdown();
  });

  it("sends denied tool feedback back to the model when policy denies execution", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const loopDeps = { ...deps, models: new SingleToolCallModelGateway("core.file.read", { path: "README.md" }), policy: new DenyAllPolicyEngine() };
    await loopDeps.platform.writeFile("/workspace/README.md", "policy denied\n");
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "read with deny",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    assert.equal(events.some((event) => event.kind === "execution.rejected" && event.error?.code === "KERNEL_POLICY_DENIED"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.error?.code === "KERNEL_POLICY_DENIED"), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal(events.at(-1)?.data.status, "completed");
    await kernel.shutdown();
  });

  it("caps model-requested tool timeout by the caller deadline", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SingleToolCallModelGateway("core.shell.run", { command: "echo timeout", timeoutMs: 60_000 });
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "capture timeout",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      timeoutMs: 5_000,
      limits: { maxModelIterations: 1, toolTimeoutMs: 90_000 }
    }));

    const envelope = events.find((event) => event.kind === "execution.envelope.created" && (event.data.envelope as JsonObject | undefined)?.capabilityId === "core.shell.run");
    assert.equal((envelope?.data.envelope as JsonObject | undefined)?.timeoutMs, 5_000);
    await kernel.shutdown();
  });

  it("uses caller timeout as the outer turn timeout when it exceeds profile defaults", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SingleToolCallModelGateway("core.file.read", { path: "README.md" });
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "capture outer timeout",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      timeoutMs: 600_000,
      limits: { maxModelIterations: 1, turnTimeoutMs: 120_000 }
    }));

    const started = events.find((event) => event.kind === "agent.loop.started");
    assert.equal((started?.data.limits as JsonObject | undefined)?.turnTimeoutMs, 600_000);
    await kernel.shutdown();
  });

  it("emits agent.loop.cancelled when the signal is already aborted", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const controller = new AbortController();
    controller.abort();
    const events = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: "cancel me",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }, { signal: controller.signal }));

    assert.deepEqual(events.map((event) => event.kind), [
      "agent.loop.started",
      "visible.reasoning.recorded",
      "visible.reasoning.projected",
      "agent.loop.cancelled"
    ]);
    const cancelled = events.at(-1);
    assert.equal(cancelled?.data.status, "cancelled");
    assert.equal(cancelled?.data.reason, "user-cancelled");
    assert.equal(cancelled?.data.iterations, 0);
    await kernel.shutdown();
  });

  it("cancels mid-stream between model events when the signal aborts", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const controller = new AbortController();
    const loopDeps = { ...deps, models: new AbortAfterDeltaModelGateway(controller) };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "mid cancel",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }, { signal: controller.signal }));

    const kinds = events.map((event) => event.kind);
    assert.equal(kinds.includes("model.delta"), true, `expected at least one delta, got ${JSON.stringify(kinds)}`);
    assert.equal(kinds.at(-1), "agent.loop.cancelled");
    assert.equal(kinds.includes("agent.loop.completed"), false);
    const cancelled = events.at(-1);
    assert.equal(cancelled?.data.reason, "user-cancelled");
    assert.equal(typeof cancelled?.data.assistantText, "string");
    await kernel.shutdown();
  });

  it("projects file references into a runtime-owned model context message", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new CapturingModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await loopDeps.platform.writeFile("/workspace/docs/plan.md", "reference plan detail\n");
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "use projected context",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      referenceContext: fileReferenceContext("docs/plan.md")
    }));

    const completed = events.find((event) => event.kind === "context.projection.completed");
    assert.equal(completed?.data.selectedNodeCount, 2);
    assert.equal(events.find((event) => event.kind === "model.requested")?.data.contextProjection !== undefined, true);
    assert.equal(gateway.requests.length, 1);
    assert.equal(gateway.requests[0]?.messages?.some((message) => message.role === "system" && message.content.includes("reference plan detail")), true);
    const userMessage = gateway.requests[0]?.messages?.find((message) => message.role === "user");
    assert.equal(userMessage?.content, "use projected context");
    assert.equal(gateway.requests[0]?.prompt.includes("user: use projected context"), true);
    await kernel.shutdown();
  });

  it("projects PageIndex turn references into bounded runtime-owned summary context", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new CapturingModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "continue with recalled decision",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      referenceContext: pageIndexTurnReferenceContext()
    }));

    const completed = events.find((event) => event.kind === "context.projection.completed");
    const modelRequested = events.find((event) => event.kind === "model.requested");
    const projection = modelRequested?.data.contextProjection as { selectedNodeCount?: number; referenceEvidence?: { resolvedReferenceCount?: number; unresolvedReferences?: readonly unknown[] } } | undefined;
    assert.equal(completed?.data.selectedNodeCount, 2);
    assert.equal(projection?.referenceEvidence?.resolvedReferenceCount, 1);
    assert.equal(projection?.referenceEvidence?.unresolvedReferences?.length, 0);
    assert.equal(gateway.requests.length, 1);
    assert.equal(gateway.requests[0]?.messages?.some((message) => message.role === "system" && message.content.includes("PageIndex recall page:1:test")), true);
    assert.equal(gateway.requests[0]?.messages?.some((message) => message.role === "system" && message.content.includes("User prompt preview: database auth decision")), true);
    assert.equal(gateway.requests[0]?.messages?.some((message) => message.role === "system" && message.content.includes("Assistant preview: use token exchange")), true);
    const userMessage = gateway.requests[0]?.messages?.find((message) => message.role === "user");
    assert.equal(userMessage?.content, "continue with recalled decision");
    await kernel.shutdown();
  });

  it("projects scoped memory entries into runtime-owned model context", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new CapturingModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await loopDeps.memory.put({
      id: asId<"memory">("memory-runtime-decision"),
      scope: "session",
      content: "Use token exchange for database auth.",
      provenance: { source: "runtime.test" },
      redaction: { class: "internal", fields: ["content"] },
      confidence: 0.9
    });
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "continue implementation",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const memoryEvent = events.find((event) => event.kind === "context.memory.collected");
    assert.equal((memoryEvent?.data as { candidateCount?: number }).candidateCount, 1);
    assert.equal(events.find((event) => event.kind === "model.requested")?.data.contextProjection !== undefined, true);
    assert.equal(gateway.requests[0]?.messages?.some((message) => message.role === "system" && message.content.includes("Use token exchange for database auth.")), true);
    await kernel.shutdown();
  });

  it("injects governed permanent memory with lower priority than current instructions", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new CapturingModelGateway();
    const permanentMemory = new DurablePermanentMemoryProvider({
      adapter: new InMemoryPermanentMemoryStorageAdapter(),
      requirePromotionApproval: false
    });
    await permanentMemory.putCandidate({
      scope: "project",
      content: "Decision: use adapter-backed permanent memory.",
      promotionMode: "auto"
    });
    const loopDeps = { ...deps, models: gateway, memory: permanentMemory };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "continue implementation",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const memoryEvent = events.find((event) => event.kind === "context.memory.collected");
    const permanent = memoryEvent?.data.permanentMemory as { promotedFreshCount?: number; configured?: boolean } | undefined;
    assert.equal(permanent?.configured, true);
    assert.equal(permanent?.promotedFreshCount, 1);
    assert.equal(gateway.requests[0]?.messages?.some((message) => message.content.includes("Permanent memory")), true);
    assert.equal(gateway.requests[0]?.messages?.some((message) => message.content.includes("lower priority than current user instructions")), true);
    await kernel.shutdown();
  });

  it("proposes permanent memory candidates from explicit remember requests", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const permanentMemory = new DurablePermanentMemoryProvider({ adapter: new InMemoryPermanentMemoryStorageAdapter() });
    const loopDeps = { ...deps, models: new CapturingModelGateway(), memory: permanentMemory };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "remember that this project stores durable memory behind provider contracts",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const proposed = events.find((event) => event.kind === "memory.permanent.candidate.proposed");
    assert.equal(proposed?.data.status, "completed");
    assert.equal((await permanentMemory.queryPermanent({ includeCandidates: true, query: "provider contracts" })).length, 1);
    await kernel.shutdown();
  });

  it("emits compact boundary evidence when projection crosses soft budget pressure", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new CapturingModelGateway();
    const loopDeps = {
      ...deps,
      models: gateway,
      usage: new InMemoryUsageBudgetManager({ contextHardLimitTokens: 200, contextSoftLimitTokens: 8 })
    };
    await loopDeps.memory.put({
      id: asId<"memory">("memory-compact-pressure"),
      scope: "session",
      content: "memory pressure one two three four five six",
      provenance: { source: "runtime.test" },
      redaction: { class: "internal", fields: ["content"] }
    });
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "compact pressure prompt",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const compact = events.find((event) => event.kind === "context.compact.boundary");
    assert.ok(compact);
    assert.equal(typeof compact.data.fingerprint, "string");
    assert.equal(compact.data.pressure, "soft");
    assert.equal(events.findIndex((event) => event.kind === "context.compact.boundary") < events.findIndex((event) => event.kind === "model.requested"), true);
    await kernel.shutdown();
  });

  it("records bounded tool-result evidence and caches it without raw preview text", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "tool evidence content\n");
    const loopDeps = { ...deps, models: new SingleToolCallModelGateway("core.file.read", { path: "README.md" }) };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "read evidence",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const result = events.find((event) => event.kind === "model.tool.result");
    const evidence = result?.data.evidence as { replayHash?: string; previewHash?: string } | undefined;
    assert.ok(evidence?.replayHash);
    assert.equal(JSON.stringify(evidence).includes("tool evidence content"), false);
    const cached = await loopDeps.cache.get(`${TOOL_RESULT_EVIDENCE_CACHE_NAMESPACE}:${evidence.replayHash}` as import("@deepseek/platform-contracts").CacheKey);
    assert.ok(cached);
    assert.equal(JSON.stringify(cached.value).includes("tool evidence content"), false);
    await kernel.shutdown();
  });

  it("keeps non-PageIndex turn references unresolved evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new CapturingModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "continue without page metadata",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      referenceContext: plainTurnReferenceContext()
    }));

    const projectionEvent = events.find((event) => event.kind === "model.requested")?.data.contextProjection as { referenceEvidence?: { resolvedReferenceCount?: number; unresolvedReferences?: readonly { reason?: string; targetKind?: string }[] } } | undefined;
    assert.equal(projectionEvent?.referenceEvidence?.resolvedReferenceCount, 0);
    assert.equal(projectionEvent?.referenceEvidence?.unresolvedReferences?.[0]?.reason, "pageindex-metadata-incomplete");
    assert.equal(projectionEvent?.referenceEvidence?.unresolvedReferences?.[0]?.targetKind, "turn");
    assert.equal(gateway.requests[0]?.messages?.some((message) => message.role === "system" && message.content.includes("Projected runtime context:")), false);
    await kernel.shutdown();
  });

  it("excludes secret-like referenced file content before model dispatch", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new CapturingModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await loopDeps.platform.writeFile("/workspace/.env", "DEEPSEEK_API_KEY=sk-live-secret-value\n");
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "check referenced env",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      referenceContext: fileReferenceContext(".env")
    }));

    assert.equal(events.some((event) => event.kind === "context.projection.degraded"), true);
    assert.equal(events.some((event) => event.kind === "context.compact.boundary"), false);
    assert.equal(JSON.stringify(events).includes("sk-live-secret-value"), false);
    assert.equal(JSON.stringify(gateway.requests).includes("sk-live-secret-value"), false);
    assert.equal(gateway.requests[0]?.messages?.some((message) => message.role === "system" && message.content.includes("Projected runtime context:")), false);
    await kernel.shutdown();
  });

  it("completes supervised repair workflows after mutation and standard test evidence", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FakePlatformRuntime("macos") });
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-supervised-understand", name: "core.file.read", input: { path: "src/example.py", offset: 0, limit: 20 } },
      {
        id: "call-supervised-change",
        name: "core.file.edit",
        input: { path: "src/example.py", expected: "value = 1\n", replacement: "value = 2\n" }
      },
      { id: "call-supervised-verify", name: "core.test.run", input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"] } }
    ]);
    const loopDeps = {
      ...deps,
      approvals: new HeadlessApprovalBroker(true),
      policy: allowAllPolicyEngine(),
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", "value = 1\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Use the supervised repair workflow.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: supervisedRepairWorkflowProfilePolicy(),
      limits: { maxModelIterations: 8, maxToolCalls: 8 }
    }));

    const workflowSteps = events.filter((event) => event.kind === "workflow.step");
    const finalLoopEvent = events.find((event) => event.kind === "agent.loop.completed");

    assert.equal(workflowSteps.some((event) => event.data.stageId === "stage:understand" && event.data.status === "succeeded"), true);
    assert.equal(workflowSteps.some((event) => event.data.stageId === "stage:change" && event.data.status === "succeeded"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolName === "core.test.run" && event.data.terminalKind === "capability.completed"), true);
    assert.equal(finalLoopEvent?.data.reason, "terminal-tool-completed");
    assert.equal(events.filter((event) => event.kind === "model.requested").length, 3);
    await kernel.shutdown();
  });

  it("keeps diagnostic repair review on evidence tools before downstream mutation", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new CapturingModelGateway();
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Review official harness failure evidence before editing.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: supervisedRepairWorkflowWithDiagnosticReviewProfilePolicy(),
      toolProjection: "read-write",
      limits: { maxModelIterations: 1 }
    }));

    const control = events.find((event) => event.kind === "model.requested")?.data.workflowReadyStageControl as JsonObject | undefined;

    assert.equal(control?.stageId, "stage:understand");
    assert.equal(control?.stageKind, "collect-evidence");
    assert.equal(String(control?.requiredNextAction).includes("core.file.read"), true);
    assert.deepEqual(visibleToolNames(gateway.requests[0] as ModelRequest), ["core_file_read"]);
    await kernel.shutdown();
  });

  it("advances diagnostic repair review after source evidence is collected", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SequentialToolCallModelGateway([
      {
        id: "call-diagnostic-review-read",
        name: "core.file.read",
        input: { path: "src/example.py", offset: 0, limit: 20 }
      }
    ]);
    const loopDeps = {
      ...deps,
      approvals: new HeadlessApprovalBroker(true),
      policy: allowAllPolicyEngine(),
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", "value = 1\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const diagnosticReviewPolicy = supervisedRepairWorkflowWithDiagnosticReviewProfilePolicy();
    const diagnosticReviewWorkflow = diagnosticReviewPolicy.stagedTaskWorkflow!;
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Review official harness failure evidence before editing.",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: {
        ...diagnosticReviewPolicy,
        stagedTaskWorkflow: {
          ...diagnosticReviewWorkflow,
          runState: {
            ...diagnosticReviewWorkflow.runState,
            stageStates: diagnosticReviewWorkflow.runState.stageStates.map((stage) =>
              stage.stageId === "stage:understand"
                ? {
                    stageId: stage.stageId,
                    status: "ready" as const,
                    attempts: 0,
                    inputRefs: stage.inputRefs,
                    outputRefs: [],
                    diagnostics: []
                  }
                : stage
            )
          }
        }
      },
      limits: { maxModelIterations: 2, maxToolCalls: 4 }
    }));

    const nextControl = events
      .filter((event) => event.kind === "model.requested")[1]
      ?.data.workflowReadyStageControl as JsonObject | undefined;

    assert.equal(nextControl?.stageId, "stage:change");
    assert.equal(nextControl?.projectedFromReviewedStage, true);
    await kernel.shutdown();
  });
});function workflowBoundaryProfilePolicy(capabilityIds: readonly string[]): AgentLoopProfilePolicyMetadata {
  return {
    schemaVersion: "1.0.0",
    profileId: "test/workflow-boundary.v1",
    role: "evaluation-workflow",
    workflowGraphId: "workflow/test.boundary.v1",
    workflowPriority: "primary",
    orchestrationMode: "staged-capability-workflow",
    workflowCapabilityIds: capabilityIds,
    workflowStages: [{
      id: "understand",
      objective: "Collect bounded workflow evidence.",
      capabilityIds,
      entryCriteria: ["workflow started"],
      exitCriteria: ["workflow evidence collected"]
    }],
    toolProjectionSource: "profile",
    antiTailoring: true,
    executionBoundary: "governed-capabilities",
    redaction: { class: "internal" }
  };
}

function stagedWorkflowReadOnlyProfilePolicy(): AgentLoopProfilePolicyMetadata {
  return {
    ...workflowBoundaryProfilePolicy(["core.file.read"]),
    stagedTaskWorkflow: {
      schemaVersion: "1.0.0",
      profileId: "test/workflow-boundary.v1",
      graphId: "graph:test.workflow-read-only",
      fingerprint: "fnv1a:test-read-only",
      stageCount: 1,
      refCount: 1,
      executorKinds: ["agent-loop"],
      graph: {
        schemaVersion: "1.0.0",
        graphId: "graph:test.workflow-read-only",
        profileId: "test/workflow-boundary.v1",
        stages: [{
          schemaVersion: "1.0.0",
          stageId: "stage:understand",
          kind: "collect-evidence",
          executorKind: "agent-loop",
          dependsOn: [],
          inputRefs: [],
          expectedOutputRefs: ["ref:workflow-understand-evidence"],
          allowedTools: ["core.file.read"],
          compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
          redaction: { class: "internal" }
        }],
        refs: [{
          schemaVersion: "1.0.0",
          refId: "ref:workflow-understand-evidence",
          type: "evidence",
          producerStageId: "stage:understand",
          scope: "task",
          compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
          redaction: { class: "internal" }
        }],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      runState: {
        schemaVersion: "1.0.0",
        taskRunId: "staged:graph:test.workflow-read-only",
        graphId: "graph:test.workflow-read-only",
        profileId: "test/workflow-boundary.v1",
        stageStates: [{
          stageId: "stage:understand",
          status: "ready",
          attempts: 0,
          inputRefs: [],
          outputRefs: [],
          diagnostics: []
        }],
        refs: [],
        events: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      redaction: { class: "internal" }
    }
  };
}

function allowAllPolicyEngine(): PolicyEngine {
  return {
    async decide(request: PolicyRequest): Promise<PolicyDecision> {
      return {
        action: "allow",
        reason: "test policy",
        audit: { capabilityId: request.capabilityId }
      };
    }
  };
}

function stagedWorkflowEngineeringMissingToolsProfilePolicy(): AgentLoopProfilePolicyMetadata {
  return {
    ...workflowBoundaryProfilePolicy(["core.file.edit", "core.test.run"]),
    profileId: "test/engineering-missing-tools.v1",
    role: "engineering-agent",
    workflowGraphId: "workflow/test.engineering-missing-tools.v1",
    stagedTaskWorkflow: {
      schemaVersion: "1.0.0",
      profileId: "test/engineering-missing-tools.v1",
      graphId: "graph:test.engineering-missing-tools",
      fingerprint: "fnv1a:test-engineering-missing-tools",
      stageCount: 1,
      refCount: 1,
      executorKinds: ["agent-loop"],
      graph: {
        schemaVersion: "1.0.0",
        graphId: "graph:test.engineering-missing-tools",
        profileId: "test/engineering-missing-tools.v1",
        stages: [{
          schemaVersion: "1.0.0",
          stageId: "stage:implement",
          kind: "produce",
          executorKind: "agent-loop",
          dependsOn: [],
          inputRefs: [],
          expectedOutputRefs: ["ref:workflow-implementation-evidence"],
          allowedTools: ["core.file.edit", "core.test.run"],
          compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
          outputRefs: [],
          diagnostics: [],
          redaction: { class: "internal" }
        }],
        refs: [{
          schemaVersion: "1.0.0",
          refId: "ref:workflow-implementation-evidence",
          type: "evidence",
          producerStageId: "stage:implement",
          scope: "task",
          compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
          redaction: { class: "internal" }
        }],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      runState: {
        schemaVersion: "1.0.0",
        taskRunId: "staged:graph:test.engineering-missing-tools",
        graphId: "graph:test.engineering-missing-tools",
        profileId: "test/engineering-missing-tools.v1",
        stageStates: [{
          stageId: "stage:implement",
          status: "ready",
          attempts: 0,
          inputRefs: [],
          outputRefs: [],
          diagnostics: []
        }],
        refs: [],
        events: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      redaction: { class: "internal" }
    }
  };
}

function stagedWorkflowShellTestProfilePolicy(): AgentLoopProfilePolicyMetadata {
  return {
    ...workflowBoundaryProfilePolicy(["core.shell.run", "core.test.run"]),
    stagedTaskWorkflow: {
      schemaVersion: "1.0.0",
      profileId: "test/workflow-boundary.v1",
      graphId: "graph:test.workflow-shell-test",
      fingerprint: "fnv1a:test-shell-test",
      stageCount: 1,
      refCount: 1,
      executorKinds: ["agent-loop"],
      graph: {
        schemaVersion: "1.0.0",
        graphId: "graph:test.workflow-shell-test",
        profileId: "test/workflow-boundary.v1",
        stages: [{
          schemaVersion: "1.0.0",
          stageId: "stage:verify",
          kind: "verify",
          executorKind: "agent-loop",
          dependsOn: [],
          inputRefs: [],
          expectedOutputRefs: ["ref:workflow-verify-evidence"],
          allowedTools: ["core.shell.run", "core.test.run"],
          compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
          redaction: { class: "internal" }
        }],
        refs: [{
          schemaVersion: "1.0.0",
          refId: "ref:workflow-verify-evidence",
          type: "check",
          producerStageId: "stage:verify",
          scope: "task",
          compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
          redaction: { class: "internal" }
        }],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      runState: {
        schemaVersion: "1.0.0",
        taskRunId: "staged:graph:test.workflow-shell-test",
        graphId: "graph:test.workflow-shell-test",
        profileId: "test/workflow-boundary.v1",
        stageStates: [{
          stageId: "stage:verify",
          status: "ready",
          attempts: 0,
          inputRefs: [],
          outputRefs: [],
          diagnostics: []
        }],
        refs: [],
        events: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      redaction: { class: "internal" }
    }
  };
}
function stagedWorkflowProgressProfilePolicy(): AgentLoopProfilePolicyMetadata {
  return {
    ...workflowBoundaryProfilePolicy(["core.file.read", "core.test.run"]),
    stagedTaskWorkflow: {
      schemaVersion: "1.0.0",
      profileId: "test/workflow-boundary.v1",
      graphId: "graph:test.workflow-boundary",
      fingerprint: "fnv1a:test",
      stageCount: 2,
      refCount: 2,
      executorKinds: ["agent-loop"],
      graph: {
        schemaVersion: "1.0.0",
        graphId: "graph:test.workflow-boundary",
        profileId: "test/workflow-boundary.v1",
        stages: [
          {
            schemaVersion: "1.0.0",
            stageId: "stage:understand",
            kind: "collect-evidence",
            executorKind: "agent-loop",
            dependsOn: [],
            inputRefs: [],
            expectedOutputRefs: ["ref:workflow-understand-evidence"],
            allowedTools: ["core.file.read"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            stageId: "stage:verify",
            kind: "verify",
            executorKind: "agent-loop",
            dependsOn: ["stage:understand"],
            inputRefs: ["ref:workflow-understand-evidence"],
            expectedOutputRefs: ["ref:workflow-verify-evidence"],
            allowedTools: ["core.test.run", "core.git.diff"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          }
        ],
        refs: [
          {
            schemaVersion: "1.0.0",
            refId: "ref:workflow-understand-evidence",
            type: "evidence",
            producerStageId: "stage:understand",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            refId: "ref:workflow-verify-evidence",
            type: "evidence",
            producerStageId: "stage:verify",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          }
        ],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      runState: {
        schemaVersion: "1.0.0",
        taskRunId: "staged:graph:test.workflow-boundary",
        graphId: "graph:test.workflow-boundary",
        profileId: "test/workflow-boundary.v1",
        stageStates: [
          {
            stageId: "stage:understand",
            status: "ready",
            attempts: 0,
            inputRefs: [],
            outputRefs: [],
            diagnostics: []
          },
          {
            stageId: "stage:verify",
            status: "pending",
            attempts: 0,
            inputRefs: ["ref:workflow-understand-evidence"],
            outputRefs: [],
            diagnostics: []
          }
        ],
        refs: [],
        events: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      redaction: { class: "internal" }
    }
  };
}

function supervisedRepairWorkflowProfilePolicy(): AgentLoopProfilePolicyMetadata {
  const policy = stagedWorkflowProgressProfilePolicy();
  assert.ok(policy.stagedTaskWorkflow);
  const graph = policy.stagedTaskWorkflow.graph;
  const understandStage = graph.stages[0];
  assert.ok(understandStage);
  return {
    ...policy,
    workflowCapabilityIds: ["core.file.read", "core.file.edit", "core.test.run"],
    workflowGovernanceMode: "evaluation",
    stageAcceptanceMode: "supervisor",
    antiTailoring: true,
    stagedTaskWorkflow: {
      ...policy.stagedTaskWorkflow,
      graph: {
        ...graph,
        stages: [
          understandStage,
          {
            schemaVersion: "1.0.0",
            stageId: "stage:change",
            kind: "produce",
            executorKind: "agent-loop",
            dependsOn: ["stage:understand"],
            inputRefs: ["ref:workflow-understand-evidence"],
            expectedOutputRefs: ["ref:workflow-change-evidence"],
            allowedTools: ["core.file.edit"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            stageId: "stage:verify",
            kind: "verify",
            executorKind: "agent-loop",
            dependsOn: ["stage:change"],
            inputRefs: ["ref:workflow-change-evidence"],
            expectedOutputRefs: ["ref:workflow-verify-evidence"],
            allowedTools: ["core.test.run"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          }
        ],
        refs: [
          ...graph.refs,
          {
            schemaVersion: "1.0.0",
            refId: "ref:workflow-change-evidence",
            type: "evidence",
            producerStageId: "stage:change",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          }
        ]
      },
      runState: {
        ...policy.stagedTaskWorkflow.runState,
        stageStates: [
          {
            stageId: "stage:understand",
            status: "ready",
            attempts: 0,
            inputRefs: [],
            outputRefs: [],
            diagnostics: []
          },
          {
            stageId: "stage:change",
            status: "pending",
            attempts: 0,
            inputRefs: ["ref:workflow-understand-evidence"],
            outputRefs: [],
            diagnostics: []
          },
          {
            stageId: "stage:verify",
            status: "pending",
            attempts: 0,
            inputRefs: ["ref:workflow-change-evidence"],
            outputRefs: [],
            diagnostics: []
          }
        ]
      }
    }
  };
}

function supervisedRepairWorkflowWithDiagnosticReviewProfilePolicy(): AgentLoopProfilePolicyMetadata {
  const policy = supervisedRepairWorkflowProfilePolicy();
  const workflow = policy.stagedTaskWorkflow;
  assert.ok(workflow);
  const diagnosticRef: StagedTaskRef = {
    schemaVersion: "1.0.0",
    refId: "ref:runner:official-repair-feedback",
    type: "diagnostic",
    producerStageId: "stage:understand",
    scope: "task",
    metadata: { failingTestCount: 2 },
    compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
    redaction: { class: "internal", fields: ["metadata"] }
  };
  return {
    ...policy,
    stagedTaskWorkflow: {
      ...workflow,
      runState: {
        ...workflow.runState,
        stageStates: [
          {
            stageId: "stage:understand",
            status: "running",
            attempts: 1,
            inputRefs: [diagnosticRef.refId],
            outputRefs: [],
            diagnostics: [],
            evaluation: {
              schemaVersion: "1.0.0",
              evaluationId: "evaluation:runner:repair-feedback",
              stageId: "stage:understand",
              evaluatorId: "swe-bench-runner",
              status: "needs-review",
              reason: "Official harness failures require focused local evidence review.",
              evidenceRefs: [diagnosticRef.refId],
              evaluatedAt: "1970-01-01T00:00:00.000Z",
              compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
              redaction: { class: "internal" }
            }
          },
          {
            stageId: "stage:change",
            status: "pending",
            attempts: 0,
            inputRefs: ["ref:workflow-understand-evidence"],
            outputRefs: [],
            diagnostics: []
          },
          {
            stageId: "stage:verify",
            status: "pending",
            attempts: 0,
            inputRefs: ["ref:workflow-change-evidence"],
            outputRefs: [],
            diagnostics: []
          }
        ],
        refs: [diagnosticRef]
      }
    }
  };
}

function engineeringStagedWorkflowProgressProfilePolicy(): AgentLoopProfilePolicyMetadata {
  const policy = stagedWorkflowProgressProfilePolicy();
  assert.ok(policy.stagedTaskWorkflow);
  return {
    ...policy,
    profileId: "engineering/coding.v1",
    role: "engineering-agent",
    workflowGraphId: "workflow/engineering.coding.v1",
    antiTailoring: false,
    workflowGovernanceMode: "standard",
    stageAcceptanceMode: "automatic",
    stagedTaskWorkflow: {
      ...policy.stagedTaskWorkflow,
      profileId: "engineering/coding.v1",
      graph: {
        ...policy.stagedTaskWorkflow.graph,
        profileId: "engineering/coding.v1"
      },
      runState: {
        ...policy.stagedTaskWorkflow.runState,
        profileId: "engineering/coding.v1"
      }
    }
  };
}

function engineeringStagedWorkflowWithPlanProfilePolicy(): AgentLoopProfilePolicyMetadata {
  return {
    ...workflowBoundaryProfilePolicy(["core.file.read", "core.search.text", "core.git.diff", "core.test.run"]),
    profileId: "engineering/coding.v1",
    role: "engineering-agent",
    workflowGraphId: "workflow/engineering.coding.v1",
    antiTailoring: false,
    workflowGovernanceMode: "standard",
    stageAcceptanceMode: "automatic",
    stagedTaskWorkflow: {
      schemaVersion: "1.0.0",
      profileId: "engineering/coding.v1",
      graphId: "graph:test.engineering-plan-workflow",
      fingerprint: "fnv1a:test-engineering-plan",
      stageCount: 3,
      refCount: 3,
      executorKinds: ["agent-loop"],
      graph: {
        schemaVersion: "1.0.0",
        graphId: "graph:test.engineering-plan-workflow",
        profileId: "engineering/coding.v1",
        stages: [
          {
            schemaVersion: "1.0.0",
            stageId: "stage:understand",
            kind: "collect-evidence",
            executorKind: "agent-loop",
            dependsOn: [],
            inputRefs: [],
            expectedOutputRefs: ["ref:workflow-understand-evidence"],
            allowedTools: ["core.file.read"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            stageId: "stage:plan",
            kind: "produce",
            executorKind: "agent-loop",
            dependsOn: ["stage:understand"],
            inputRefs: ["ref:workflow-understand-evidence"],
            expectedOutputRefs: ["ref:workflow-plan-evidence"],
            allowedTools: ["core.file.read", "core.search.text", "core.git.diff"],
            parameters: {
              workflowStageId: "plan",
              objective: "Create an implementation plan from bounded repository evidence.",
              entryCriteria: ["understanding evidence exists"],
              exitCriteria: ["plan evidence exists"]
            },
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            stageId: "stage:verify",
            kind: "verify",
            executorKind: "agent-loop",
            dependsOn: ["stage:plan"],
            inputRefs: ["ref:workflow-plan-evidence"],
            expectedOutputRefs: ["ref:workflow-verify-evidence"],
            allowedTools: ["core.test.run", "core.git.diff"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          }
        ],
        refs: [
          {
            schemaVersion: "1.0.0",
            refId: "ref:workflow-understand-evidence",
            type: "evidence",
            producerStageId: "stage:understand",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            refId: "ref:workflow-plan-evidence",
            type: "evidence",
            producerStageId: "stage:plan",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            refId: "ref:workflow-verify-evidence",
            type: "check",
            producerStageId: "stage:verify",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          }
        ],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      runState: {
        schemaVersion: "1.0.0",
        taskRunId: "staged:graph:test.engineering-plan-workflow",
        graphId: "graph:test.engineering-plan-workflow",
        profileId: "engineering/coding.v1",
        stageStates: [
          {
            stageId: "stage:understand",
            status: "ready",
            attempts: 0,
            inputRefs: [],
            outputRefs: [],
            diagnostics: []
          },
          {
            stageId: "stage:plan",
            status: "pending",
            attempts: 0,
            inputRefs: ["ref:workflow-understand-evidence"],
            outputRefs: [],
            diagnostics: []
          },
          {
            stageId: "stage:verify",
            status: "pending",
            attempts: 0,
            inputRefs: ["ref:workflow-plan-evidence"],
            outputRefs: [],
            diagnostics: []
          }
        ],
        refs: [],
        events: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      redaction: { class: "internal" }
    }
  };
}

function engineeringArtifactDeliveryProfilePolicy(): AgentLoopProfilePolicyMetadata {
  const policy = engineeringStagedWorkflowWithPlanProfilePolicy();
  const workflow = policy.stagedTaskWorkflow;
  assert.ok(workflow);
  return {
    ...policy,
    workflowCapabilityIds: ["core.file.read", "core.search.text", "core.workspace.glob", "core.file.write", "core.file.edit", "core.patch.apply"],
    stagedTaskWorkflow: {
      ...workflow,
      graph: {
        ...workflow.graph,
        stages: workflow.graph.stages.map((stage) => stage.stageId === "stage:plan"
          ? { ...stage, allowedTools: ["core.file.read", "core.search.text", "core.workspace.glob", "core.file.write", "core.file.edit", "core.patch.apply"] }
          : stage)
      }
    }
  };
}

function engineeringArtifactDeliveryWithPlanAndImplementProfilePolicy(): AgentLoopProfilePolicyMetadata {
  return {
    ...workflowBoundaryProfilePolicy([
      "core.file.read",
      "core.file.list",
      "core.search.text",
      "core.workspace.glob",
      "core.shell.run",
      "core.test.run",
      "core.file.write",
      "core.file.edit",
      "core.patch.apply",
      "core.git.diff"
    ]),
    profileId: "engineering/coding.v1",
    role: "engineering-agent",
    workflowGraphId: "workflow/engineering.coding.v1",
    antiTailoring: false,
    workflowGovernanceMode: "standard",
    stageAcceptanceMode: "automatic",
    stagedTaskWorkflow: {
      schemaVersion: "1.0.0",
      profileId: "engineering/coding.v1",
      graphId: "graph:test.engineering-artifact-delivery",
      fingerprint: "fnv1a:test-engineering-artifact-delivery",
      stageCount: 5,
      refCount: 5,
      executorKinds: ["agent-loop"],
      graph: {
        schemaVersion: "1.0.0",
        graphId: "graph:test.engineering-artifact-delivery",
        profileId: "engineering/coding.v1",
        stages: [
          {
            schemaVersion: "1.0.0",
            stageId: "stage:understand",
            kind: "collect-evidence",
            executorKind: "agent-loop",
            dependsOn: [],
            inputRefs: [],
            expectedOutputRefs: ["ref:workflow-understand-evidence"],
            allowedTools: ["core.file.read", "core.file.list", "core.search.text", "core.workspace.glob", "core.shell.run"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            stageId: "stage:plan",
            kind: "produce",
            executorKind: "agent-loop",
            dependsOn: ["stage:understand"],
            inputRefs: ["ref:workflow-understand-evidence"],
            expectedOutputRefs: ["ref:workflow-plan-evidence"],
            allowedTools: ["core.file.read", "core.search.text", "core.git.diff"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            stageId: "stage:implement",
            kind: "produce",
            executorKind: "agent-loop",
            dependsOn: ["stage:plan"],
            inputRefs: ["ref:workflow-plan-evidence"],
            expectedOutputRefs: ["ref:workflow-implementation-evidence"],
            allowedTools: ["core.file.read", "core.file.write", "core.file.edit", "core.patch.apply", "core.shell.run"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            stageId: "stage:verify",
            kind: "verify",
            executorKind: "agent-loop",
            dependsOn: ["stage:implement"],
            inputRefs: ["ref:workflow-implementation-evidence"],
            expectedOutputRefs: ["ref:workflow-verify-evidence"],
            allowedTools: ["core.test.run", "core.shell.run", "core.git.diff", "core.file.read"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            stageId: "stage:report",
            kind: "score",
            executorKind: "agent-loop",
            dependsOn: ["stage:verify"],
            inputRefs: ["ref:workflow-verify-evidence"],
            expectedOutputRefs: ["ref:workflow-report-evidence"],
            allowedTools: ["core.git.diff", "core.file.read"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          }
        ],
        refs: [
          workflowEvidenceRefForTest("ref:workflow-understand-evidence", "stage:understand", "evidence"),
          workflowEvidenceRefForTest("ref:workflow-plan-evidence", "stage:plan", "evidence"),
          workflowEvidenceRefForTest("ref:workflow-implementation-evidence", "stage:implement", "artifact"),
          workflowEvidenceRefForTest("ref:workflow-verify-evidence", "stage:verify", "check"),
          workflowEvidenceRefForTest("ref:workflow-report-evidence", "stage:report", "evidence")
        ],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      runState: {
        schemaVersion: "1.0.0",
        taskRunId: "staged:graph:test.engineering-artifact-delivery",
        graphId: "graph:test.engineering-artifact-delivery",
        profileId: "engineering/coding.v1",
        stageStates: [
          workflowStageStateForTest("stage:understand", "ready", []),
          workflowStageStateForTest("stage:plan", "pending", ["ref:workflow-understand-evidence"]),
          workflowStageStateForTest("stage:implement", "pending", ["ref:workflow-plan-evidence"]),
          workflowStageStateForTest("stage:verify", "pending", ["ref:workflow-implementation-evidence"]),
          workflowStageStateForTest("stage:report", "pending", ["ref:workflow-verify-evidence"])
        ],
        refs: [],
        events: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      redaction: { class: "internal" }
    }
  };
}

function workflowEvidenceRefForTest(refId: string, producerStageId: string, type: "artifact" | "check" | "evidence"): StagedTaskRef {
  return {
    schemaVersion: "1.0.0",
    refId,
    type,
    producerStageId,
    scope: "task",
    compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
    redaction: { class: "internal" }
  };
}

function workflowStageStateForTest(
  stageId: string,
  status: "pending" | "ready" | "running" | "succeeded" | "failed" | "skipped",
  inputRefs: readonly string[],
  outputRefs: readonly string[] = []
) {
  return {
    stageId,
    status,
    attempts: 0,
    inputRefs,
    outputRefs,
    diagnostics: []
  };
}

function readOnlyAnalysisStagedWorkflowProfilePolicy(): AgentLoopProfilePolicyMetadata {
  return {
    ...workflowBoundaryProfilePolicy(["core.file.read", "core.search.text", "core.workspace.glob", "core.git.diff"]),
    profileId: "analysis/read-only.v1",
    role: "analysis-agent",
    workflowGraphId: "workflow/analysis.read-only.v1",
    antiTailoring: false,
    workflowGovernanceMode: "standard",
    stageAcceptanceMode: "automatic",
    stagedTaskWorkflow: {
      schemaVersion: "1.0.0",
      profileId: "analysis/read-only.v1",
      graphId: "graph:test.read-only-analysis",
      fingerprint: "fnv1a:test-read-only-analysis",
      stageCount: 3,
      refCount: 3,
      executorKinds: ["agent-loop"],
      graph: {
        schemaVersion: "1.0.0",
        graphId: "graph:test.read-only-analysis",
        profileId: "analysis/read-only.v1",
        stages: [
          {
            schemaVersion: "1.0.0",
            stageId: "stage:understand",
            kind: "collect-evidence",
            executorKind: "agent-loop",
            dependsOn: [],
            inputRefs: [],
            expectedOutputRefs: ["ref:workflow-understand-evidence"],
            allowedTools: ["core.file.read"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            stageId: "stage:inspect",
            kind: "produce",
            executorKind: "agent-loop",
            dependsOn: ["stage:understand"],
            inputRefs: ["ref:workflow-understand-evidence"],
            expectedOutputRefs: ["ref:workflow-inspect-evidence"],
            allowedTools: ["core.file.read", "core.search.text", "core.workspace.glob", "core.git.diff"],
            parameters: {
              workflowStageId: "inspect",
              objective: "Inspect read-only evidence.",
              entryCriteria: ["understanding evidence exists"],
              exitCriteria: ["inspection evidence exists"]
            },
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            stageId: "stage:report",
            kind: "synthesize",
            executorKind: "agent-loop",
            dependsOn: ["stage:inspect"],
            inputRefs: ["ref:workflow-inspect-evidence"],
            expectedOutputRefs: ["ref:workflow-report-evidence"],
            allowedTools: ["core.file.read", "core.git.diff"],
            parameters: {
              workflowStageId: "report",
              objective: "Report read-only findings.",
              entryCriteria: ["inspection evidence exists"],
              exitCriteria: ["report evidence exists"]
            },
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          }
        ],
        refs: [
          {
            schemaVersion: "1.0.0",
            refId: "ref:workflow-understand-evidence",
            type: "evidence",
            producerStageId: "stage:understand",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            refId: "ref:workflow-inspect-evidence",
            type: "evidence",
            producerStageId: "stage:inspect",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            refId: "ref:workflow-report-evidence",
            type: "evidence",
            producerStageId: "stage:report",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          }
        ],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      runState: {
        schemaVersion: "1.0.0",
        taskRunId: "staged:graph:test.read-only-analysis",
        graphId: "graph:test.read-only-analysis",
        profileId: "analysis/read-only.v1",
        stageStates: [
          {
            stageId: "stage:understand",
            status: "ready",
            attempts: 0,
            inputRefs: [],
            outputRefs: [],
            diagnostics: []
          },
          {
            stageId: "stage:inspect",
            status: "pending",
            attempts: 0,
            inputRefs: ["ref:workflow-understand-evidence"],
            outputRefs: [],
            diagnostics: []
          },
          {
            stageId: "stage:report",
            status: "pending",
            attempts: 0,
            inputRefs: ["ref:workflow-inspect-evidence"],
            outputRefs: [],
            diagnostics: []
          }
        ],
        refs: [],
        events: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      redaction: { class: "internal" }
    }
  };
}

function stagedWorkflowTerminalScoreProfilePolicy(): AgentLoopProfilePolicyMetadata {
  return {
    ...workflowBoundaryProfilePolicy(["core.test.run"]),
    stagedTaskWorkflow: {
      schemaVersion: "1.0.0",
      profileId: "test/workflow-terminal-score.v1",
      graphId: "graph:test.workflow-terminal-score",
      fingerprint: "fnv1a:test-terminal-score",
      stageCount: 1,
      refCount: 1,
      executorKinds: ["agent-loop"],
      graph: {
        schemaVersion: "1.0.0",
        graphId: "graph:test.workflow-terminal-score",
        profileId: "test/workflow-terminal-score.v1",
        stages: [{
          schemaVersion: "1.0.0",
          stageId: "stage:score",
          kind: "score",
          executorKind: "agent-loop",
          dependsOn: [],
          inputRefs: [],
          expectedOutputRefs: ["ref:workflow-score-evidence"],
          allowedTools: ["core.test.run"],
          compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
          redaction: { class: "internal" }
        }],
        refs: [{
          schemaVersion: "1.0.0",
          refId: "ref:workflow-score-evidence",
          type: "evidence",
          producerStageId: "stage:score",
          scope: "task",
          compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
          redaction: { class: "internal" }
        }],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      runState: {
        schemaVersion: "1.0.0",
        taskRunId: "staged:graph:test.workflow-terminal-score",
        graphId: "graph:test.workflow-terminal-score",
        profileId: "test/workflow-terminal-score.v1",
        stageStates: [{
          stageId: "stage:score",
          status: "ready",
          attempts: 0,
          inputRefs: [],
          outputRefs: [],
          diagnostics: []
        }],
        refs: [],
        events: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      redaction: { class: "internal" }
    }
  };
}

function stagedWorkflowTerminalFailureProfilePolicy(): AgentLoopProfilePolicyMetadata {
  return {
    ...workflowBoundaryProfilePolicy(["core.workflow.terminal"]),
    stagedTaskWorkflow: {
      schemaVersion: "1.0.0",
      profileId: "test/workflow-terminal-failure.v1",
      graphId: "graph:test.workflow-terminal-failure",
      fingerprint: "fnv1a:test-terminal-failure",
      stageCount: 1,
      refCount: 1,
      executorKinds: ["agent-loop"],
      graph: {
        schemaVersion: "1.0.0",
        graphId: "graph:test.workflow-terminal-failure",
        profileId: "test/workflow-terminal-failure.v1",
        stages: [{
          schemaVersion: "1.0.0",
          stageId: "stage:terminal",
          kind: "score",
          executorKind: "agent-loop",
          dependsOn: [],
          inputRefs: [],
          expectedOutputRefs: ["ref:workflow-terminal-evidence"],
          allowedTools: ["core.workflow.terminal"],
          compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
          redaction: { class: "internal" }
        }],
        refs: [{
          schemaVersion: "1.0.0",
          refId: "ref:workflow-terminal-evidence",
          type: "evidence",
          producerStageId: "stage:terminal",
          scope: "task",
          compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
          redaction: { class: "internal" }
        }],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      runState: {
        schemaVersion: "1.0.0",
        taskRunId: "staged:graph:test.workflow-terminal-failure",
        graphId: "graph:test.workflow-terminal-failure",
        profileId: "test/workflow-terminal-failure.v1",
        stageStates: [{
          stageId: "stage:terminal",
          status: "ready",
          attempts: 0,
          inputRefs: [],
          outputRefs: [],
          diagnostics: []
        }],
        refs: [],
        events: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      redaction: { class: "internal" }
    }
  };
}

function stagedWorkflowTerminalCollectEvidenceProfilePolicy(): AgentLoopProfilePolicyMetadata {
  return {
    ...workflowBoundaryProfilePolicy(["core.workflow.terminal"]),
    stagedTaskWorkflow: {
      schemaVersion: "1.0.0",
      profileId: "test/workflow-terminal-collect-evidence.v1",
      graphId: "graph:test.workflow-terminal-collect-evidence",
      fingerprint: "fnv1a:test-terminal-collect-evidence",
      stageCount: 1,
      refCount: 1,
      executorKinds: ["agent-loop"],
      graph: {
        schemaVersion: "1.0.0",
        graphId: "graph:test.workflow-terminal-collect-evidence",
        profileId: "test/workflow-terminal-collect-evidence.v1",
        stages: [{
          schemaVersion: "1.0.0",
          stageId: "stage:dispatch",
          kind: "collect-evidence",
          executorKind: "agent-loop",
          dependsOn: [],
          inputRefs: [],
          expectedOutputRefs: ["ref:workflow-dispatch-evidence"],
          allowedTools: ["core.workflow.terminal"],
          compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
          redaction: { class: "internal" }
        }],
        refs: [{
          schemaVersion: "1.0.0",
          refId: "ref:workflow-dispatch-evidence",
          type: "evidence",
          producerStageId: "stage:dispatch",
          scope: "task",
          compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
          redaction: { class: "internal" }
        }],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      runState: {
        schemaVersion: "1.0.0",
        taskRunId: "staged:graph:test.workflow-terminal-collect-evidence",
        graphId: "graph:test.workflow-terminal-collect-evidence",
        profileId: "test/workflow-terminal-collect-evidence.v1",
        stageStates: [{
          stageId: "stage:dispatch",
          status: "ready",
          attempts: 0,
          inputRefs: [],
          outputRefs: [],
          diagnostics: []
        }],
        refs: [],
        events: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      redaction: { class: "internal" }
    }
  };
}
function stagedWorkflowChangeReadProfilePolicy(): AgentLoopProfilePolicyMetadata {
  return {
    ...workflowBoundaryProfilePolicy(["core.file.read", "core.file.edit", "core.test.run"]),
    stagedTaskWorkflow: {
      schemaVersion: "1.0.0",
      profileId: "test/workflow-boundary.v1",
      graphId: "graph:test.workflow-change-read",
      fingerprint: "fnv1a:test-change-read",
      stageCount: 3,
      refCount: 3,
      executorKinds: ["agent-loop"],
      graph: {
        schemaVersion: "1.0.0",
        graphId: "graph:test.workflow-change-read",
        profileId: "test/workflow-boundary.v1",
        stages: [
          {
            schemaVersion: "1.0.0",
            stageId: "stage:understand",
            kind: "collect-evidence",
            executorKind: "agent-loop",
            dependsOn: [],
            inputRefs: [],
            expectedOutputRefs: ["ref:workflow-understand-evidence"],
            allowedTools: ["core.file.read"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            stageId: "stage:change",
            kind: "produce",
            executorKind: "agent-loop",
            dependsOn: ["stage:understand"],
            inputRefs: ["ref:workflow-understand-evidence"],
            expectedOutputRefs: ["ref:workflow-change-evidence"],
            allowedTools: ["core.file.read", "core.file.edit"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            stageId: "stage:verify",
            kind: "verify",
            executorKind: "agent-loop",
            dependsOn: ["stage:change"],
            inputRefs: ["ref:workflow-change-evidence"],
            expectedOutputRefs: ["ref:workflow-verify-evidence"],
            allowedTools: ["core.test.run"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          }
        ],
        refs: [
          {
            schemaVersion: "1.0.0",
            refId: "ref:workflow-understand-evidence",
            type: "evidence",
            producerStageId: "stage:understand",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            refId: "ref:workflow-change-evidence",
            type: "artifact",
            producerStageId: "stage:change",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            refId: "ref:workflow-verify-evidence",
            type: "check",
            producerStageId: "stage:verify",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          }
        ],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      runState: {
        schemaVersion: "1.0.0",
        taskRunId: "staged:graph:test.workflow-change-read",
        graphId: "graph:test.workflow-change-read",
        profileId: "test/workflow-boundary.v1",
        stageStates: [
          {
            stageId: "stage:understand",
            status: "ready",
            attempts: 0,
            inputRefs: [],
            outputRefs: [],
            diagnostics: []
          },
          {
            stageId: "stage:change",
            status: "pending",
            attempts: 0,
            inputRefs: ["ref:workflow-understand-evidence"],
            outputRefs: [],
            diagnostics: []
          },
          {
            stageId: "stage:verify",
            status: "pending",
            attempts: 0,
            inputRefs: ["ref:workflow-change-evidence"],
            outputRefs: [],
            diagnostics: []
          }
        ],
        refs: [],
        events: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      redaction: { class: "internal" }
    }
  };
}

class SingleToolCallModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly name: string, private readonly input: JsonObject) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (request.messages?.some((message) => message.role === "tool")) {
      yield { kind: "delta", text: "tool response handled" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "tool-call", id: "call-runtime", name: this.name, input: this.input };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SequentialToolCallModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly calls: readonly { readonly id: string; readonly name: string; readonly input: JsonObject }[]) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const call = this.calls[this.requests.length - 1];
    if (!call) {
      yield { kind: "delta", text: "sequential tool calls completed" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "tool-call", id: call.id, name: call.name, input: call.input };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class ReadyStageBudgetReviewModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private reviewSeen = false;
  private completionIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const reviewSeen = request.messages?.some((message) => message.content.includes("WORKFLOW_STAGE_BUDGET_REVIEW_REQUIRED")) === true;
    if (reviewSeen && !this.completionIssued) {
      this.reviewSeen = true;
      this.completionIssued = true;
      yield {
        kind: "tool-call",
        id: "call-stage-budget-read-after-review",
        name: "core.file.read",
        input: { path: "README.md" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.completionIssued) {
      yield { kind: "delta", text: "budget review converted into stage progress" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: "not ready to call the required workflow tool yet" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class MultiToolCallModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly calls: readonly { readonly id: string; readonly name: string; readonly input: JsonObject }[]) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (this.requests.length > 1) {
      yield { kind: "delta", text: "multi tool calls completed" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    for (const call of this.calls) {
      yield { kind: "tool-call", id: call.id, name: call.name, input: call.input };
    }
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class MultiReadThenMutationModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly firstCalls: readonly { readonly id: string; readonly name: string; readonly input: JsonObject }[],
    private readonly secondCall: { readonly id: string; readonly name: string; readonly input: JsonObject }
  ) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      for (const call of this.firstCalls) {
        yield { kind: "tool-call", id: call.id, name: call.name, input: call.input };
      }
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.requests.length === 2) {
      yield { kind: "tool-call", id: this.secondCall.id, name: this.secondCall.name, input: this.secondCall.input };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: "multi-read correction completed" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class CapturingToolIntentPreflight implements ToolIntentPreflightService {
  readonly requests: ToolIntentPreflightRequest[] = [];

  constructor(private readonly delegate: ToolIntentPreflightService) {}

  async check(request: ToolIntentPreflightRequest): Promise<ToolIntentPreflightResult> {
    this.requests.push(request);
    return this.delegate.check(request);
  }
}
class ManyEchoToolCallsModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly toolCallTarget: number) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (this.requests.length > this.toolCallTarget) {
      yield { kind: "delta", text: "many echo calls completed" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    const index = this.requests.length;
    yield {
      kind: "tool-call",
      id: `call-resume-tail-${index}`,
      name: "runtime.echo",
      input: {
        text: index === 1
          ? "echo-result-1-oldest"
          : index === this.toolCallTarget
            ? "echo-result-14-newest"
            : `echo-result-${index}`
      }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}


class FocusedReadFailurePlatform extends FakePlatformRuntime {
  private focusedReadCount = 0;

  constructor() {
    super("linux", "/workspace");
  }

  override async readFile(path: string): Promise<string> {
    if (path.replace(/\\/g, "/").endsWith("/src/focused.py")) {
      this.focusedReadCount += 1;
    }
    if (this.focusedReadCount === 2 && path.replace(/\\/g, "/").endsWith("/src/focused.py")) {
      this.focusedReadCount += 1;
      throw new Error("Transient focused read failure");
    }
    return super.readFile(path);
  }
}function visibleToolNames(request: ModelRequest): readonly string[] {
  return (request.tools ?? [])
    .map((tool) => {
      const fn = jsonObjectRecord(tool.function);
      return typeof fn?.name === "string" ? fn.name : "";
    })
    .filter(Boolean)
    .sort();
}

function contextPipelineMetadata(request: ModelRequest): {
  readonly pipelineFingerprint?: string;
  readonly providerPrefixFingerprint?: string;
} {
  return jsonObjectRecord(request.metadata?.contextPipeline) as {
    readonly pipelineFingerprint?: string;
    readonly providerPrefixFingerprint?: string;
  };
}

function providerMessageText(request: ModelRequest): string {
  return (request.messages ?? []).map((message) => message.content).join("\n");
}

function isSelfRepairFeedback(message: ModelChatMessage): boolean {
  return (
    (message.role === "tool" && message.toolName === "agent.self-repair") ||
    String(message.content ?? "").includes("agent.self-repair") ||
    (message.role === "system" && String(message.content ?? "").includes("Self-repair failure evidence"))
  );
}

function isEvidenceFirstGroundingFeedback(message: ModelChatMessage): boolean {
  return message.toolName === "evidence-first.claim-grounding" || String(message.content ?? "").includes("evidence-first.claim-grounding");
}




class FailedTestFakePlatformRuntime extends FakePlatformRuntime {
  override async runProcess(command: string, args: readonly string[], options: ProcessRunOptions = {}, observer?: ProcessRunObserver): Promise<ProcessResult> {
    if (isFakePytestInvocation(command, args)) {
      const stdout = "FAILED tests/test_demo.py::test_expected_fix";
      observer?.onStdoutChunk?.(stdout);
      observer?.onProcessExit?.();
      return {
        exitCode: 1,
        stdout,
        stderr: "",
        metadata: {
          selectedProvider: "argv",
          status: "available",
          fallbackChain: [],
          degradedReasons: [],
          diagnostics: [],
          redaction: { class: "internal" }
        }
      };
    }
    return super.runProcess(command, args, options, observer);
  }
}

function isFakePytestInvocation(command: string, args: readonly string[]): boolean {
  const commandLine = [command, ...args].join(" ").toLowerCase();
  return /\b(?:python\s+-m\s+)?pytest\b/.test(commandLine);
}

class MissingPytestThenRepoLocalRunnerPlatform extends FakePlatformRuntime {
  constructor() {
    super("linux", "/workspace");
  }

  override async runProcess(command: string, args: readonly string[], options: ProcessRunOptions = {}, observer?: ProcessRunObserver): Promise<ProcessResult> {
    const commandLine = [command, ...args].join(" ");
    if (isFakePytestInvocation(command, args)) {
      const stderr = "/workspace/.venv/bin/python: No module named pytest";
      observer?.onStderrChunk?.(stderr);
      observer?.onProcessExit?.();
      return {
        exitCode: 1,
        stdout: "",
        stderr,
        metadata: {
          selectedProvider: "argv",
          status: "available",
          fallbackChain: [],
          degradedReasons: [],
          diagnostics: [],
          redaction: { class: "internal" }
        }
      };
    }
    if (/\bpython\s+tests\/runtests\.py\b/.test(commandLine)) {
      const stdout = "Ran 1 test in 0.01s\n\nOK";
      observer?.onStdoutChunk?.(stdout);
      observer?.onProcessExit?.();
      return {
        exitCode: 0,
        stdout,
        stderr: "",
        metadata: {
          selectedProvider: "argv",
          status: "available",
          fallbackChain: [],
          degradedReasons: [],
          diagnostics: [],
          redaction: { class: "internal" }
        }
      };
    }
    return super.runProcess(command, args, options, observer);
  }
}


class UsageAuditingGateway implements ModelGateway {
  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { kind: "delta", text: "audited" };
    yield {
      kind: "usage",
      inputTokens: 11,
      outputTokens: 7,
      metadata: {
        inputTokens: 11,
        outputTokens: 7,
        provider: {
          provider: "deepseek",
          protocol: "openai-chat-completions",
          model: "deepseek-v4-flash",
          requestId: "req-usage-audit"
        },
        cache: { hitTokens: 3, missTokens: 8 },
        reasoningTokens: 2
      }
    };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class CacheTelemetryUsageGateway implements ModelGateway {
  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { kind: "delta", text: "cache telemetry" };
    yield {
      kind: "usage",
      inputTokens: 120,
      outputTokens: 9,
      metadata: {
        inputTokens: 120,
        outputTokens: 9,
        provider: {
          provider: "glm",
          protocol: "anthropic-messages",
          model: "glm-5.1",
          requestId: "req-cache-telemetry"
        },
        cache: {
          hitTokens: 100,
          missTokens: 20,
          hitRate: 100 / 120,
          pipelineFingerprint: "pipeline:runtime-cache-telemetry",
          breakpointShape: runtimeCacheBreakpointShape(),
          explicitPrefixCacheHint: {
            status: "sent",
            reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT",
            redaction: { class: "internal" }
          }
        }
      }
    };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

function runtimeCacheBreakpointShape() {
  return {
    systemCacheControlCount: 1,
    messageCacheControlCount: 1,
    toolCacheControlCount: 1,
    totalCacheControlCount: 3,
    redaction: { class: "internal" as const }
  };
}

class ErrorModelGateway implements ModelGateway {
  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield {
      kind: "error",
      error: {
        code: "MODEL_FAILED",
        message: "model failed",
        retryable: false,
        redaction: { class: "public" }
      }
    };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class RepairingProviderErrorModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (request.messages?.some(isSelfRepairFeedback)) {
      yield { kind: "delta", text: "Recovered after repair feedback." };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield {
      kind: "error",
      error: {
        code: "MODEL_FAILED",
        message: "model failed once",
        retryable: true,
        redaction: { class: "public" }
      }
    };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class PersistentRepairFailureModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    yield {
      kind: "error",
      error: {
        code: "MODEL_FAILED",
        message: request.messages?.some(isSelfRepairFeedback)
          ? "model still failed after repair"
          : "model failed before repair",
        retryable: true,
        redaction: { class: "public" }
      }
    };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class MissingCredentialModelGateway implements ModelGateway {
  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield {
      kind: "error",
      error: {
        code: "MISSING_CREDENTIAL",
        message: "credential is unavailable",
        retryable: false,
        redaction: { class: "public" }
      }
    };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class TypecheckErrorModelGateway implements ModelGateway {
  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield {
      kind: "error",
      error: {
        code: "TYPECHECK_FAILED",
        message: "typecheck failed",
        retryable: true,
        redaction: { class: "public" }
      }
    };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class EvidenceRevisionModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (request.messages?.some(isEvidenceFirstGroundingFeedback)) {
      yield { kind: "delta", text: "DeepSeek CLI package is deepseek-agent-cli." };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: "Run npx deepseek-cli init to start." };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class StubbornUnsupportedClaimModelGateway implements ModelGateway {
  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { kind: "delta", text: "Run npx deepseek-cli init to start." };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class ToolEvidenceGroundingModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const hasToolResult = request.messages?.some((message) => message.role === "tool" && message.toolName === "core.file.read");
    if (!hasToolResult) {
      yield { kind: "tool-call", id: "call-read-source", name: "core.file.read", input: { path: "src/source.py" } };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: "```diff\n- cright[-right.shape[0]:, -right.shape[1]:] = 1\n```\n" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class DenyAllPolicyEngine implements PolicyEngine {
  async decide(_request: PolicyRequest): Promise<PolicyDecision> {
    return {
      action: "deny",
      reason: "Denied by runtime test policy",
      audit: { policy: "deny-all-test" }
    };
  }
}

class AllowAllPolicyEngine implements PolicyEngine {
  async decide(request: PolicyRequest): Promise<PolicyDecision> {
    return {
      action: "allow",
      reason: "Allowed by runtime test policy",
      audit: request.auditEvidence ?? { policy: "allow-all-test" }
    };
  }
}

class AbortAfterDeltaModelGateway implements ModelGateway {
  constructor(private readonly controller: AbortController) {}

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { kind: "delta", text: "partial " };
    this.controller.abort();
    yield { kind: "delta", text: "after-abort" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class CapturingModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    yield { kind: "delta", text: "captured" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class NoToolThenToolCallModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly name: string, private readonly input: JsonObject) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield { kind: "delta", text: "I need to inspect first." };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "tool-call", id: "call-after-workflow-correction", name: this.name, input: this.input };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SemanticMutationToolCallModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    yield {
      kind: "tool-call",
      id: "call-semantic-mutation",
      name: "core.text.replace",
      input: { path: "src/example.ts", oldText: "old", newText: "new" }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class TaskDecisionEnvelopeModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const flow = request.metadata?.taskDeliveryFlow as JsonObject | undefined;
    const acceptance = [{
      criterionId: "criterion:model-proof",
      description: "Model-selected proof evidence exists before delivery.",
      required: true,
      evidenceRefs: ["ref:model-proof"]
    }];
    const envelope = {
      schemaVersion: "1.0.0",
      decisionId: "task-decision:model-evaluation",
      requestId: String(flow?.decisionRequestId ?? "task-decision-request:missing"),
      intentDecision: "run_evaluation_score",
      goalProposal: {
        schemaVersion: "1.0.0",
        goalId: "task-goal:model-evaluation",
        briefId: String(flow?.briefId ?? "task-brief:missing"),
        statement: "Run the evaluation flow and collect proof before delivery.",
        taskKind: "evaluation",
        riskLevel: "medium",
        acceptanceCriteria: acceptance,
        nonGoals: ["Do not claim score without evidence."],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      acceptanceCriteria: acceptance,
      planSteps: [{
        stepId: "task-step:model-evaluate",
        phase: "runtime",
        description: "Run the model-selected evaluation path.",
        expectedRefs: ["ref:model-proof"],
        status: "required"
      }],
      profileSelection: "coding/general.v1",
      toolStrategy: ["Use governed diagnostics tools."],
      verificationPlan: ["Collect score evidence."],
      repairPolicy: ["Return to proof when evidence is missing."],
      stopConditions: ["Budget exhausted."],
      questionsForUser: [],
      confidence: 0.88,
      assumptions: ["Evaluation target is the active CLI."],
      compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
      redaction: { class: "internal" }
    };
    yield { kind: "delta", text: JSON.stringify(envelope) };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class CapturingPromptAssembler implements PromptAssembler {
  readonly inputs: PromptAssemblyInput[] = [];

  constructor(private readonly delegate: PromptAssembler) {}

  async assemble(input: PromptAssemblyInput): Promise<PromptAssemblyResult> {
    this.inputs.push(input);
    return this.delegate.assemble(input);
  }
}

function fileReferenceContext(path: string): AgentLoopReferenceContext {
  return {
    schemaVersion: "1.0.0",
    source: "cli.palette.references",
    activeSetId: "refset:active",
    activeItemId: `ref:file:${path}`,
    setCount: 1,
    itemCount: 1,
    sets: [{
      id: "refset:active",
      label: "Active references",
      activeItemId: `ref:file:${path}`,
      items: [{
        id: `ref:file:${path}`,
        kind: "file",
        target: { kind: "file", id: `file:${path}`, label: path, path },
        label: path,
        provenance: { source: "runtime.test" },
        order: 0,
        redaction: { class: "internal", fields: ["target", "label"] }
      }],
      provenance: { source: "runtime.test" },
      redaction: { class: "internal", fields: ["items.target"] }
    }],
    redaction: { class: "internal", fields: ["sets.items.target"] }
  };
}

function pageIndexTurnReferenceContext(): AgentLoopReferenceContext {
  return {
    schemaVersion: "1.0.0",
    source: "cli.palette.references",
    activeSetId: "refs:active",
    activeItemId: "ref:pageindex-result:test",
    setCount: 1,
    itemCount: 1,
    sets: [{
      id: "refs:active",
      label: "Active references",
      activeItemId: "ref:pageindex-result:test",
      items: [{
        id: "ref:pageindex-result:test",
        kind: "turn",
        target: {
          kind: "turn",
          id: "turn-source",
          label: "Turn 1",
          sessionId: "session-source" as import("@deepseek/platform-contracts").SessionId,
          turnId: "turn-source" as import("@deepseek/platform-contracts").TurnId,
          metadata: {
            pageId: "page:1:test",
            sequence: 1,
            status: "completed",
            traceId: "trace-source",
            promptPreview: "database auth decision",
            assistantPreview: "use token exchange",
            deterministicScore: 12,
            ranking: "deterministic-text",
            semantic: { status: "deferred" },
            redaction: { class: "internal", fields: ["promptPreview", "assistantPreview"] }
          }
        },
        label: "#1 completed: database auth decision",
        provenance: { source: "result-list", resultListItemId: "pageindex-result:test" },
        order: 0,
        redaction: { class: "internal", fields: ["target", "label"] }
      }],
      provenance: { source: "runtime.test" },
      redaction: { class: "internal", fields: ["items.target"] }
    }],
    redaction: { class: "internal", fields: ["sets.items.target"] }
  };
}

function plainTurnReferenceContext(): AgentLoopReferenceContext {
  return {
    schemaVersion: "1.0.0",
    source: "cli.palette.references",
    activeSetId: "refs:active",
    activeItemId: "ref:turn:plain",
    setCount: 1,
    itemCount: 1,
    sets: [{
      id: "refs:active",
      label: "Active references",
      activeItemId: "ref:turn:plain",
      items: [{
        id: "ref:turn:plain",
        kind: "turn",
        target: {
          kind: "turn",
          id: "turn-plain",
          label: "Plain turn",
          turnId: "turn-plain" as import("@deepseek/platform-contracts").TurnId
        },
        label: "Plain turn",
        provenance: { source: "runtime.test" },
        order: 0,
        redaction: { class: "internal", fields: ["target", "label"] }
      }],
      provenance: { source: "runtime.test" },
      redaction: { class: "internal", fields: ["items.target"] }
    }],
    redaction: { class: "internal", fields: ["sets.items.target"] }
  };
}

function jsonObjectRecord(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}
