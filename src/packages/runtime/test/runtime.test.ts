import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoopProfilePolicyMetadata, AgentLoopReferenceContext, JsonObject, ModelGateway, ModelRequest, ModelStreamEvent, PolicyDecision, PolicyEngine, PolicyRequest, ProcessResult, ProcessRunObserver, ProcessRunOptions, PromptAssembler, PromptAssemblyInput, PromptAssemblyResult, ToolIntentPreflightRequest, ToolIntentPreflightResult, ToolIntentPreflightService } from "@deepseek/platform-contracts";
import { collectRuntimeEvents, createDefaultRuntimeKernel, createHeadlessRuntime, registerRuntimeCoreTools, runAgentLoop, runtimeEchoCapability } from "../src/index.js";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";
import { defaultDeepSeekProfile } from "@deepseek/model-gateway";
import { DurablePermanentMemoryProvider, InMemoryPermanentMemoryStorageAdapter, InMemoryLosslessContextManager, PersistentJsonlLosslessContextManager, TOOL_RESULT_EVIDENCE_CACHE_NAMESPACE } from "@deepseek/memory-cache-management";
import { InMemoryUsageBudgetManager } from "@deepseek/usage-budget-management";
import { PersistentFilesystemSessionStore } from "@deepseek/session-store";
import { FakePlatformRuntime, NodePlatformRuntime } from "@deepseek/platform-abstraction";
import { asId } from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, objectSchema, replay } from "@deepseek/core-coding-tools";

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
  });

  it("keeps SWE-bench continuation history within a minimal provider tool tail", async () => {
    const gateway = new SweBenchHistoryTailModelGateway(11);
    const deps = { ...createDeterministicRuntimeDependencies(), models: gateway };
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "",
        "Managed SWE-bench execution profile:",
        "- keep provider cache stable while using governed tools."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: {
        maxModelIterations: 16,
        maxToolCalls: 16
      }
    }));

    const lastRequest = gateway.requests.at(-1);
    const lastReplay = events
      .filter((event) => event.kind === "model.requested")
      .at(-1)?.data.providerRequestReplay as { historyMessageCount?: number; selectedHistoryMessageCount?: number; providerMessageCount?: number; toolCallLinkage?: { assistantToolCallCount?: number; toolResultCount?: number } } | undefined;
    const toolMessages = lastRequest?.messages?.filter((message) => message.role === "tool") ?? [];
    const assistantToolMessages = lastRequest?.messages?.filter((message) => (message.toolCalls?.length ?? 0) > 0) ?? [];

    assert.equal(events.at(-1)?.data.status, "completed");
    assert.equal(toolMessages.length, 1);
    assert.equal(assistantToolMessages.length, 1);
    assert.equal(toolMessages[0]?.content.includes("history tail 11"), true);
    assert.equal(toolMessages[0]?.content.includes("history tail 10"), false);
    assert.equal((lastReplay?.selectedHistoryMessageCount ?? 0) <= 4, true);
    assert.equal((lastReplay?.providerMessageCount ?? 0) > (lastReplay?.selectedHistoryMessageCount ?? 0), true);
    assert.equal((lastReplay?.historyMessageCount ?? 0) <= 2, true);
    assert.equal((lastReplay?.toolCallLinkage?.toolResultCount ?? 0), 1);
    assert.equal((lastReplay?.toolCallLinkage?.assistantToolCallCount ?? 0), 1);
    await kernel.shutdown();
  });

  it("compacts large SWE-bench tool feedback only in provider-facing history", async () => {
    const gateway = new SweBenchLargeToolFeedbackModelGateway();
    const deps = { ...createDeterministicRuntimeDependencies(), models: gateway };
    await registerRuntimeCoreTools(deps, "/workspace");
    await deps.platform.writeFile("/workspace/large.txt", Array.from({ length: 600 }, (_, index) => `line ${index}: provider cache should not replay this full file`).join("\n"));
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "",
        "Managed SWE-bench execution profile:",
        "- keep provider cache stable while using governed tools."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: {
        maxModelIterations: 4,
        maxToolCalls: 4,
        maxOutputBytes: 24_000
      }
    }));

    const modelToolResult = events.find((event) => event.kind === "model.tool.result");
    const providerToolMessage = gateway.requests.at(1)?.messages?.find((message) => message.role === "tool");
    const fullPreviewBytes = Number((modelToolResult?.data.feedback as { preview?: { byteLength?: number } } | undefined)?.preview?.byteLength ?? 0);
    const providerBytes = Buffer.byteLength(providerToolMessage?.content ?? "", "utf8");

    assert.equal(events.at(-1)?.data.status, "completed");
    assert.equal(fullPreviewBytes > 12_000, true);
    assert.equal(providerBytes <= 1_400, true);
    assert.equal(providerToolMessage?.content.includes("Provider-visible tool feedback truncated"), true);
    assert.equal(providerToolMessage?.content.includes("line 0: provider cache"), true);
    assert.equal(providerToolMessage?.content.includes("line 599:"), false);
    await kernel.shutdown();
  });

  it("keeps SWE-bench history bounded after framework gate user messages", async () => {
    const gateway = new SweBenchGateHistoryTailModelGateway();
    const deps = { ...createDeterministicRuntimeDependencies(), models: gateway };
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "",
        "Managed SWE-bench execution profile:",
        "- keep provider cache stable while using governed tools."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: {
        maxModelIterations: 16,
        maxToolCalls: 16
      }
    }));

    const gateReplay = events
      .filter((event) => event.kind === "model.requested")
      .map((event) => event.data.providerRequestReplay as { selectedHistoryMessageCount?: number; historyMessageCount?: number; providerMessageCount?: number; toolCallLinkage?: { assistantToolCallCount?: number; toolResultCount?: number }; messageRoleSequence?: readonly string[] })
      .at(-1);

    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_SOURCE_INSPECTION_GATE"), true);
    assert.equal((gateReplay?.selectedHistoryMessageCount ?? 0) <= 6, true);
    assert.equal((gateReplay?.providerMessageCount ?? 0) > (gateReplay?.selectedHistoryMessageCount ?? 0), true);
    assert.equal((gateReplay?.historyMessageCount ?? 0) <= 4, true);
    assert.equal((gateReplay?.toolCallLinkage?.toolResultCount ?? 0), 2);
    assert.equal((gateReplay?.toolCallLinkage?.assistantToolCallCount ?? 0), 2);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED"))), true);
    await kernel.shutdown();
  });

  it("runs evidence discovery before fact-sensitive model dispatch and preserves prompt boundary", async () => {
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
    assert.equal(gateway.requests.length, 2);
    assert.equal(gateway.requests[1]?.messages?.some((message) => message.role === "tool" && message.toolName === "evidence-first.claim-grounding"), true);
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
    assert.equal(gateway.requests.length, 2);
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

  it("blocks stale SWE-bench workspace tool access at the task-scope guard before kernel execution", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const loopDeps = {
      ...deps,
      models: new SingleToolCallModelGateway("core.file.list", { path: ".deepseek/swebench-workspaces" })
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "给我完成 SWE-bench Lite 第 2 题测试，跑通并告诉我结果。",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 2 }
    }));

    assert.equal(events.some((event) => event.kind === "model.tool.intent"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.terminalKind === "task-scope.rejected"), true);
    assert.equal(events.some((event) => event.kind === "kernel.request.accepted"), false);
    assert.equal(events.some((event) => event.kind === "capability.started"), false);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && String(event.data.result).includes("stale SWE-bench workspace")), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
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

  it("projects governed profile workflow boundaries into provider-visible tools before model choice", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new CapturingModelGateway();
    const loopDeps = {
      ...deps,
      models: gateway
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await registerFakeSweBenchRunCapability(loopDeps);
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "给我完成 SWE-bench Lite 第 2 题测试，跑通并告诉我结果。",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: workflowBoundaryProfilePolicy(["core.swe.bench.run"]),
      limits: { maxModelIterations: 1 }
    }));

    assert.deepEqual(visibleToolNames(gateway.requests[0] as ModelRequest), ["core_swe_bench_run"]);
    assert.equal(events.some((event) => event.kind === "prompt.assembled" && jsonObjectRecord(event.data.toolPlan)?.visibleToolCount === 1), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    await kernel.shutdown();
  });

  it("advances primary profile workflow stages from successful tool evidence", async () => {
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
    const progressed = secondModelRequest?.data.profilePolicy as AgentLoopProfilePolicyMetadata | undefined;
    const stageStates = progressed?.stagedTaskWorkflow?.runState.stageStates.map((stage) => `${stage.stageId}:${stage.status}:${stage.outputRefs.join(",")}`) ?? [];

    assert.equal(events.some((event) => event.kind === "workflow.step" && event.data.status === "succeeded" && event.data.stageId === "stage:understand"), true);
    assert.deepEqual(stageStates, [
      "stage:understand:succeeded:ref:workflow-understand-evidence",
      "stage:verify:ready:"
    ]);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => String(message.content ?? "").includes("stage:understand:succeeded"))), true);
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

    assert.equal(events.some((event) => event.kind === "workflow.step" && event.data.status === "succeeded" && event.data.stageId === "stage:understand"), true);
    assert.equal(events.some((event) => event.kind === "workflow.step" && event.data.status === "succeeded" && event.data.stageId === "stage:change"), false);
    assert.deepEqual(stageStates, [
      "stage:understand:succeeded:ref:workflow-understand-evidence",
      "stage:change:ready:",
      "stage:verify:pending:"
    ]);
    await kernel.shutdown();
  });

  it("treats governed SWE-bench run capability completion as terminal for the outer loop", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchRunThenTakeoverModelGateway();
    const loopDeps = {
      ...deps,
      models: gateway,
      policy: new AllowAllPolicyEngine()
    };
    await loopDeps.capabilities.register({
      ...runtimeEchoCapability,
      id: asId<"capability">("core.swe.bench.run"),
      name: "SWE-bench Run",
      sideEffect: "process",
      permissions: ["process:run", "evaluation:swe-bench"]
    }, async () => ({
      ok: true,
      value: {
        evidence: {
          tool: "swe.bench.run",
          status: "completed",
          affectedPaths: [],
          preview: {
            text: "core.swe.bench.run taskNumber=2 status=warn patchBytes=554",
            byteLength: 58,
            lineCount: 1,
            truncated: false,
            limitBytes: 4_000,
            redaction: { class: "internal" }
          },
          diagnostics: [],
          metadata: {
            status: "warn",
            patchBytes: 554,
            predictionStatus: "warn"
          },
          replay: {},
          redaction: { class: "internal", fields: ["metadata"] }
        }
      }
    }));
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "给我完成 SWE-bench Lite 第 2 题测试，跑通并告诉我结果。",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 3 }
    }));

    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.name === "core.swe.bench.run"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.name === "core.file.read"), false);
    assert.equal(events.some((event) => event.kind === "capability.completed" && event.data.capabilityId === "core.swe.bench.run"), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal(events.at(-1)?.data.reason, "terminal-tool-completed");
    assert.equal(gateway.requests.length, 1);
    await kernel.shutdown();
  });

  it("routes user-level SWE-bench task prompts back to the governed run capability", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchOuterRoutingGateModelGateway();
    const loopDeps = {
      ...deps,
      models: gateway,
      policy: new AllowAllPolicyEngine()
    };
    await loopDeps.capabilities.register({
      ...runtimeEchoCapability,
      id: asId<"capability">("core.swe.bench.run"),
      name: "SWE-bench Run",
      sideEffect: "process",
      permissions: ["process:run", "evaluation:swe-bench"]
    }, async () => ({
      ok: true,
      value: {
        evidence: {
          tool: "swe.bench.run",
          status: "completed",
          affectedPaths: [],
          preview: {
            text: "core.swe.bench.run taskNumber=3 status=warn patchBytes=0",
            byteLength: 56,
            lineCount: 1,
            truncated: false,
            limitBytes: 4_000,
            redaction: { class: "internal" }
          },
          diagnostics: [],
          metadata: { status: "warn", patchBytes: 0 },
          replay: {},
          redaction: { class: "internal", fields: ["metadata"] }
        }
      }
    }));
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "给我完成 SWE-bench Lite 第 3 题测试，跑通并告诉我结果。",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 8, maxToolCalls: 12 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_RUN_CAPABILITY_ROUTING_GATE"), true);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_RUN_CAPABILITY_ROUTING_GATE"))), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.name === "core.swe.bench.run"), true);
    assert.equal(events.some((event) => event.kind === "capability.completed" && event.data.capabilityId === "core.swe.bench.run"), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal(events.at(-1)?.data.reason, "terminal-tool-completed");
    await kernel.shutdown();
  });

  it("passes the original prompt into SWE-bench tool preflight for range normalization", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const preflight = new CapturingToolIntentPreflight(deps.toolIntentPreflight);
    const loopDeps = {
      ...deps,
      models: new SweBenchRunThenTakeoverModelGateway(),
      toolIntentPreflight: preflight,
      policy: new AllowAllPolicyEngine()
    };
    await loopDeps.capabilities.register({
      ...runtimeEchoCapability,
      id: asId<"capability">("core.swe.bench.run"),
      name: "SWE-bench Run",
      sideEffect: "process",
      permissions: ["process:run", "evaluation:swe-bench"]
    }, async (_input) => ({
      ok: true,
      value: {
        evidence: {
          tool: "swe.bench.run",
          status: "completed",
          affectedPaths: [],
          preview: {
            text: "core.swe.bench.run batch status=warn",
            byteLength: 36,
            lineCount: 1,
            truncated: false,
            limitBytes: 4_000,
            redaction: { class: "internal" }
          },
          diagnostics: [],
          metadata: { status: "warn" },
          replay: {},
          redaction: { class: "internal", fields: ["metadata"] }
        }
      }
    }));
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "给我完成 SWE-bench Lite 第 2 到第 4 题测试，能继续就 resume，跑通并告诉我总体通过率。",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 3 }
    }));

    const sweRequest = preflight.requests.find((request) => request.intent.name === "core.swe.bench.run");
    const repaired = events.find((event) => event.kind === "model.tool.repaired" && event.data.capabilityId === "core.swe.bench.run")?.data.repaired as { input?: JsonObject } | undefined;
    assert.equal(sweRequest?.providerHints?.userPrompt, "给我完成 SWE-bench Lite 第 2 到第 4 题测试，能继续就 resume，跑通并告诉我总体通过率。");
    assert.deepEqual(repaired?.input?.taskNumbers, [2, 3, 4]);
    await kernel.shutdown();
  });

  it("repairs model-supplied dryRun before executing live SWE-bench run capability", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const preflight = new CapturingToolIntentPreflight(deps.toolIntentPreflight);
    const gateway = new SingleToolCallModelGateway("core.swe.bench.run", { taskNumber: 10, dryRun: true });
    let executedInput: JsonObject | undefined;
    const loopDeps = {
      ...deps,
      models: gateway,
      toolIntentPreflight: preflight,
      policy: new AllowAllPolicyEngine()
    };
    await loopDeps.capabilities.register({
      ...runtimeEchoCapability,
      id: asId<"capability">("core.swe.bench.run"),
      name: "SWE-bench Run",
      sideEffect: "process",
      permissions: ["process:run", "evaluation:swe-bench"]
    }, async (input) => {
      executedInput = input;
      return {
        ok: true,
        value: {
          evidence: {
            tool: "swe.bench.run",
            status: "completed",
            affectedPaths: [],
            preview: {
              text: "core.swe.bench.run taskNumber=10 status=warn patchBytes=0",
              byteLength: 57,
              lineCount: 1,
              truncated: false,
              limitBytes: 4_000,
              redaction: { class: "internal" }
            },
            diagnostics: [],
            metadata: { status: "warn", patchBytes: 0 },
            replay: {},
            redaction: { class: "internal", fields: ["metadata"] }
          }
        }
      };
    });
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "给我完成 SWE-bench Lite 第 10 题测试，修复后做单题 canary，跑通并告诉我 cache 命中率。",
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 2 }
    }));
    const repaired = events.find((event) => event.kind === "model.tool.repaired" && event.data.capabilityId === "core.swe.bench.run")?.data.repaired as { input?: JsonObject } | undefined;

    assert.equal(repaired?.input?.dryRun, false);
    assert.equal(repaired?.input?.execute, true);
    assert.equal(executedInput?.dryRun, false);
    assert.equal(executedInput?.execute, true);
    assert.equal(preflight.requests[0]?.providerHints?.userPrompt, "给我完成 SWE-bench Lite 第 10 题测试，修复后做单题 canary，跑通并告诉我 cache 命中率。");
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    await kernel.shutdown();
  });

  it("injects a SWE-bench verification gate when the managed child loop keeps shelling without tests", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchVerificationGateModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Before final answer, run at least one model-authored standard test command."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 12, maxToolCalls: 20 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_VERIFICATION_GATE"), true);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_VERIFICATION_GATE"))), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.name === "core.shell.run" && String((event.data.input as JsonObject).command).includes("python -m pytest")), true);
    await kernel.shutdown();
  });

  it("rejects non-test shell commands after the SWE-bench verification gate until test evidence exists", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchVerificationGateDefiantModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Before final answer, run at least one model-authored standard test command."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 14, maxToolCalls: 24 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_VERIFICATION_GATE"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-defiant-install"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-defiant-install" && event.data.terminalKind === "swe-bench-verification-gate.rejected"), true);
    assert.equal(events.some((event) => event.kind === "capability.started" && (event.data.input as JsonObject | undefined)?.command === "python -m pip install numpy"), false);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_VERIFICATION_GATE_ENFORCED"))), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-swe-test-after-rejection"), true);
    await kernel.shutdown();
  });

  it("rejects more source inspection after the SWE-bench inspection gate until edit or test progress exists", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchSourceInspectionDefiantModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect the relevant source briefly, then make the smallest source edit and verify it."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 18, maxToolCalls: 30 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_SOURCE_INSPECTION_GATE"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-defiant-source-search"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-defiant-source-search" && event.data.terminalKind === "swe-bench-source-inspection-gate.rejected"), true);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED"))), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-source-edit-after-rejection"), true);
    await kernel.shutdown();
  });

  it("terminates a SWE-bench child run after repeated source-inspection gate defiance", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchSourceInspectionPersistentDefiantModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect the relevant source briefly, then make the smallest source edit and verify it."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 18, maxToolCalls: 30 }
    }));

    const terminalData = events.at(-1)?.data as JsonObject | undefined;

    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_SOURCE_INSPECTION_GATE"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-persistent-defiant-source-search-1" && event.data.terminalKind === "swe-bench-source-inspection-gate.rejected"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-persistent-defiant-source-search-2" && event.data.terminalKind === "swe-bench-source-inspection-gate.rejected"), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_SOURCE_INSPECTION_DEFIANCE_GATE"), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_REQUEST_BUDGET_GATE"), false);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-persistent-edit-after-defiance"), false);
    assert.equal(events.at(-1)?.kind, "agent.loop.failed");
    assert.equal(terminalData?.reason, "swe-bench-source-inspection-defiance");
    assert.equal(gateway.requests.length, 10);
    await kernel.shutdown();
  });

  it("leaves enough request budget after the SWE-bench inspection gate to edit and test", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchSourceInspectionRecoveryBudgetModelGateway();
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect the relevant source briefly, then make the smallest source edit and verify it."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 12, maxToolCalls: 24 }
    }));

    const sourceGate = events.find((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_SOURCE_INSPECTION_GATE");
    assert.ok(sourceGate);
    assert.equal((sourceGate.data.sourceInspectionToolCount as number) <= 8, true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-recovery-defiant-search" && event.data.terminalKind === "swe-bench-source-inspection-gate.rejected"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-recovery-edit-after-rejection"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-recovery-test-after-edit"), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal(events.at(-1)?.data.reason, "swe-bench-ready-for-harness");
    await kernel.shutdown();
  });

  it("counts workspace glob as SWE-bench source inspection and enforces the inspection gate", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchSourceInspectionGlobDefiantModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    await loopDeps.platform.writeFile("/workspace/src/other.py", "VALUE = 1\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect the relevant source briefly, then make the smallest source edit and verify it."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 18, maxToolCalls: 30 }
    }));

    const gate = events.find((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_SOURCE_INSPECTION_GATE");
    assert.ok(gate);
    assert.equal(gate.data.sourceInspectionToolCount, 8);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-defiant-source-glob"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-defiant-source-glob" && event.data.terminalKind === "swe-bench-source-inspection-gate.rejected"), true);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED"))), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-source-edit-after-glob-rejection"), true);
    await kernel.shutdown();
  });

  it("allows focused same-file reads after the SWE-bench inspection gate", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchSourceInspectionFocusedReadModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "Previous supervised attempt feedback:",
        "- Attempt 1 official harness did not resolve the instance.",
        "- Failing tests:",
        "  - tests/test_example.py::test_roundtrip",
        "- Inspect the relevant source briefly, then make the smallest source edit and verify it."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 18, maxToolCalls: 30 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_SOURCE_INSPECTION_GATE"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-focused-source-read"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-focused-source-read" && event.data.terminalKind === "swe-bench-source-inspection-gate.rejected"), false);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-focused-source-read" && event.data.terminalKind === "capability.completed"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-focused-edit-after-read"), true);
    await kernel.shutdown();
  });

  it("rejects duplicate source-inspection evidence before spending the SWE-bench inspection budget", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchDuplicateSourceInspectionModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect the relevant source briefly, then make the smallest source edit and verify it."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 10, maxToolCalls: 20 }
    }));

    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-duplicate-source-read-2" && event.data.terminalKind === "swe-bench-source-inspection-duplicate.rejected"), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_SOURCE_INSPECTION_GATE"), false);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-edit-after-duplicate-source-read"), true);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_DUPLICATE_GATE_ENFORCED"))), true);
    await kernel.shutdown();
  });

  it("keeps recent successful source evidence visible after duplicate source-inspection rejection", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchDuplicateGateContinuityModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", [
      "def merge_assets(left, right):",
      "    unique_source_evidence_for_duplicate_gate = True",
      "    return left + right"
    ].join("\n"));
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect the relevant source briefly, then make the smallest source edit and verify it."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 6, maxToolCalls: 8 }
    }));

    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-continuity-duplicate-read-2" && event.data.terminalKind === "swe-bench-source-inspection-duplicate.rejected"), true);
    assert.equal(gateway.duplicateGateRequestIncludedSuccessfulSourceEvidence, true);
    await kernel.shutdown();
  });

  it("does not present read-only workflow actions as active next steps after source-inspection duplicate rejection", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchDuplicateGateWorkflowGuidanceModelGateway();
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect the relevant source briefly, then make the smallest source edit and verify it."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      profilePolicy: stagedWorkflowChangeReadProfilePolicy(),
      limits: { maxModelIterations: 5, maxToolCalls: 8 }
    }));

    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-duplicate-source-read-2" && event.data.terminalKind === "swe-bench-source-inspection-duplicate.rejected"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-edit-after-duplicate-source-read" && event.data.terminalKind === "capability.completed"), true);
    assert.equal(gateway.workflowStateAfterDuplicate?.includes("Gate-enforced next action: source-edit-or-test-or-bounded-blocker"), true);
    assert.equal(gateway.workflowStateAfterDuplicate?.includes("stage:change kind=produce tools=core.file.read"), false);
    assert.deepEqual(gateway.visibleToolsAfterDuplicate, ["core_file_edit", "core_test_run"]);
    assert.equal(gateway.workflowStateAfterEdit?.includes("Gate-enforced next action"), false);
    assert.deepEqual(gateway.workflowGateOverrideAfterEdit, undefined);
    await kernel.shutdown();
  });

  it("rejects overlapping source-inspection read windows before spending the SWE-bench inspection budget", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchOverlappingSourceInspectionModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect the relevant source briefly, then make the smallest source edit and verify it."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 10, maxToolCalls: 20 }
    }));

    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-overlapping-source-read-2" && event.data.terminalKind === "swe-bench-source-inspection-duplicate.rejected"), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_SOURCE_INSPECTION_GATE"), false);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-edit-after-overlapping-source-read"), true);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_DUPLICATE_GATE_ENFORCED"))), true);
    await kernel.shutdown();
  });

  it("rejects further source inspection after duplicate evidence until edit or test progress", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchDuplicateThenSearchSourceInspectionModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect the relevant source briefly, then make the smallest source edit and verify it."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 12, maxToolCalls: 24 }
    }));

    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-search-after-duplicate-source-read" && event.data.terminalKind === "swe-bench-source-inspection-duplicate.rejected"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-search-after-duplicate-source-read" && event.data.terminalKind === "capability.completed"), false);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-edit-after-duplicate-source-search"), true);
    await kernel.shutdown();
  });

  it("rejects additional focused source read windows after the SWE-bench inspection gate", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchSourceInspectionSecondFocusedReadModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect the relevant source briefly, then make the smallest source edit and verify it."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 18, maxToolCalls: 30 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_SOURCE_INSPECTION_GATE"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-first-focused-source-read" && event.data.terminalKind === "capability.completed"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-second-focused-source-read" && event.data.terminalKind === "swe-bench-source-inspection-gate.rejected"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-second-focused-edit-after-rejection"), true);
    await kernel.shutdown();
  });

  it("rejects repeated focused same-file read windows after the SWE-bench inspection gate", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchSourceInspectionRepeatedFocusedReadModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect the relevant source briefly, then make the smallest source edit and verify it."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 18, maxToolCalls: 30 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_SOURCE_INSPECTION_GATE"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-repeated-focused-source-read"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-repeated-focused-source-read" && event.data.terminalKind === "swe-bench-source-inspection-gate.rejected"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-repeated-focused-source-read" && event.data.terminalKind === "capability.completed"), false);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-repeated-focused-edit-after-rejection"), true);
    await kernel.shutdown();
  });

  it("rejects whole-file same-file reads after the SWE-bench inspection gate", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchSourceInspectionWholeFileReadModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect the relevant source briefly, then make the smallest source edit and verify it."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 18, maxToolCalls: 30 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_SOURCE_INSPECTION_GATE"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-whole-file-read-after-gate"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-whole-file-read-after-gate" && event.data.terminalKind === "swe-bench-source-inspection-gate.rejected"), true);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED"))), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-edit-after-whole-file-read-rejection"), true);
    await kernel.shutdown();
  });

  it("rejects non-test shell commands after the SWE-bench inspection gate until edit or test progress exists", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchSourceInspectionShellDefiantModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect the relevant source briefly, then make the smallest source edit and verify it."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 18, maxToolCalls: 30 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_SOURCE_INSPECTION_GATE"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-defiant-source-shell"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-defiant-source-shell" && event.data.terminalKind === "swe-bench-source-inspection-gate.rejected"), true);
    assert.equal(events.some((event) => event.kind === "capability.started" && (event.data.input as JsonObject | undefined)?.command === "python -m pip install numpy"), false);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED"))), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-source-edit-after-shell-rejection"), true);
    await kernel.shutdown();
  });

  it("does not count failed no-op edits as SWE-bench source mutation progress", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchNoopEditAfterInspectionGateModelGateway();
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect the relevant source briefly, then make the smallest source edit and verify it."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 14, maxToolCalls: 24 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_SOURCE_INSPECTION_GATE"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-noop-edit"), true);
    assert.equal(events.some((event) => event.kind === "capability.failed" && (event.error?.details as JsonObject | undefined)?.originalCode === "EDIT_NOOP"), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_POST_EDIT_VERIFICATION_GATE"), false);
    await kernel.shutdown();
  });

  it("rejects post-edit source inspection until a SWE-bench test command exists", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchPostEditVerificationDefiantModelGateway();
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect the relevant source briefly, then make the smallest source edit and verify it."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 18, maxToolCalls: 30 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_POST_EDIT_VERIFICATION_GATE"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-post-edit-read"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-post-edit-read" && event.data.terminalKind === "swe-bench-post-edit-verification-gate.rejected"), true);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_POST_EDIT_VERIFICATION_GATE_ENFORCED"))), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-post-edit-test"), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_REQUEST_BUDGET_GATE"), false);
    await kernel.shutdown();
  });

  it("inserts post-edit verification gate immediately after material SWE-bench edits", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchEarlyEditThenReadModelGateway();
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect, edit, verify, and return control for official harness scoring."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 8, maxToolCalls: 16 }
    }));

    const postEditGate = events.find((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_POST_EDIT_VERIFICATION_GATE");
    const postEditReadResult = events.find((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-early-post-edit-read") as { readonly data: JsonObject } | undefined;

    assert.equal(Boolean(postEditGate), true);
    assert.equal(postEditGate?.data.sourceInspectionToolCount, 1);
    assert.equal(postEditGate?.data.sourceMutationCount, 1);
    assert.equal(postEditGate?.data.testCommandCount, 0);
    assert.equal(postEditReadResult?.data.terminalKind, "swe-bench-post-edit-verification-gate.rejected");
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_POST_EDIT_VERIFICATION_GATE"))), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-early-post-edit-test"), true);
    await kernel.shutdown();
  });

  it("does not inject the SWE-bench verification gate after core.test.run verification", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchCoreTestRunVerificationModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Before final answer, run at least one model-authored standard test command."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 12, maxToolCalls: 20 }
    }));

    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.name === "core.test.run"), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_VERIFICATION_GATE"), false);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_VERIFICATION_GATE"))), false);
    await kernel.shutdown();
  });

  it("terminates a SWE-bench child run after the environment blocker gate", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FailedTestFakePlatformRuntime() });
    const gateway = new SweBenchEnvironmentBlockerModelGateway();
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Before final answer, run at least one model-authored standard test command."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 24, maxToolCalls: 32 }
    }));

    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.name === "core.file.edit"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.name === "core.test.run"), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"), true);
    assert.equal(events.filter((event) => event.kind === "model.tool.intent" && String(event.data.toolCallId ?? "").startsWith("call-env-probe-")).length, 2);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"))), false);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal((events.at(-1)?.data as JsonObject | undefined)?.reason, "swe-bench-environment-blocker");
    await kernel.shutdown();
  });

  it("routes missing-pytest verification to the repo-local runner before environment blocking", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new MissingPytestThenRepoLocalRunnerPlatform() });
    const gateway = new SweBenchRepoLocalRunnerRoutingModelGateway();
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    await loopDeps.platform.writeFile("/workspace/tests/runtests.py", "# repo-local test runner\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect, edit, verify, and route test-command setup failures through repo-local runners when available."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 16, maxToolCalls: 24 }
    }));

    const terminalData = events.at(-1)?.data as JsonObject | undefined;

    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-repo-local-routing-test"), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_REPO_LOCAL_RUNNER_GATE"), true);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_REPO_LOCAL_RUNNER_GATE") && message.content.includes("python tests/runtests.py"))), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-repo-local-routing-runner"), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"), false);
    assert.equal(terminalData?.reason, "swe-bench-ready-for-harness");
    await kernel.shutdown();
  });

  it("rejects core.test.run pytest retries after the repo-local runner gate", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new MissingPytestThenRepoLocalRunnerPlatform() });
    const gateway = new SweBenchRepoLocalRunnerCoreTestRetryModelGateway();
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    await loopDeps.platform.writeFile("/workspace/tests/runtests.py", "# repo-local test runner\n");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect, edit, verify, and route test-command setup failures through repo-local runners when available."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 18, maxToolCalls: 28 }
    }));

    const retryResult = events.find((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolCallId === "call-repo-local-core-test-retry"
    );
    const terminalData = events.at(-1)?.data as JsonObject | undefined;

    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_REPO_LOCAL_RUNNER_GATE"), true);
    assert.equal(retryResult?.data.terminalKind, "swe-bench-repo-local-runner-gate.rejected");
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-repo-local-core-test-runner"), true);
    assert.equal(terminalData?.reason, "swe-bench-ready-for-harness");
    await kernel.shutdown();
  });

  it("returns control to the SWE-bench harness immediately after successful test evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchReadyForHarnessAfterPostVerificationProbeModelGateway();
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect, edit, verify, and return control for official harness scoring."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 12, maxToolCalls: 20 }
    }));

    const terminalData = events.at(-1)?.data as JsonObject | undefined;

    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-ready-probe-edit"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-ready-probe-test"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-ready-probe-diff"), false);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-ready-probe-shell-4"), false);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-ready-probe-shell-5"), false);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_READY_FOR_HARNESS_GATE"), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"), false);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal(terminalData?.reason, "swe-bench-ready-for-harness");
    await kernel.shutdown();
  });

  it("returns control after a successful repo-local Django runner invoked through shell", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FakePlatformRuntime("linux", "/workspace") });
    const gateway = new SweBenchRepoLocalDjangoRunnerShellModelGateway();
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect, edit, verify with the repo-local Django runner, and return control for official harness scoring."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 12, maxToolCalls: 20 }
    }));

    const terminalData = events.at(-1)?.data as JsonObject | undefined;

    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-django-runner-edit"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-django-runner-test"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-django-runner-extra-probe"), false);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_READY_FOR_HARNESS_GATE"), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"), false);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal(terminalData?.reason, "swe-bench-ready-for-harness");
    await kernel.shutdown();
  });

  it("terminates a SWE-bench repair child run after the environment blocker gate when a patch is inherited", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FailedTestFakePlatformRuntime() });
    const gateway = new SweBenchInheritedPatchEnvironmentBlockerModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "Previous supervised attempt feedback:",
        "- Attempt 1 official harness did not resolve the instance.",
        "- Previous patch status: non-empty patchBytes=624.",
        "- Failing tests:",
        "  - tests/test_demo.py::test_expected_fix",
        "- Repair the current checkout based on local source and these test failures."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 14, maxToolCalls: 24 }
    }));

    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.name === "core.file.edit"), false);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.name === "core.test.run"), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"), true);
    assert.equal(events.filter((event) => event.kind === "model.tool.intent" && String(event.data.toolCallId ?? "").startsWith("call-inherited-env-probe-")).length, 2);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"))), false);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal((events.at(-1)?.data as JsonObject | undefined)?.reason, "swe-bench-environment-blocker");
    await kernel.shutdown();
  });

  it("does not ask the model for another environment setup command after the SWE-bench environment blocker gate", async () => {
    const deps = createDeterministicRuntimeDependencies({ platform: new FailedTestFakePlatformRuntime() });
    const gateway = new SweBenchEnvironmentBlockerDefiantModelGateway();
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Before final answer, run at least one model-authored standard test command."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 24, maxToolCalls: 32 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-defiant-env-install"), false);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-defiant-env-install"), false);
    assert.equal(events.some((event) => event.kind === "capability.started" && (event.data.input as JsonObject | undefined)?.command === "python -m pip install pyerfa pyyaml numpy"), false);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"))), false);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal((events.at(-1)?.data as JsonObject | undefined)?.reason, "swe-bench-environment-blocker");
    await kernel.shutdown();
  });

  it("returns control before broad source reads after successful SWE-bench test evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchPostTestBroadReadDefiantModelGateway();
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect, edit, verify, and return control for official harness scoring."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 10, maxToolCalls: 16 }
    }));

    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-post-test-broad-read"), false);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-post-test-broad-read"), false);
    assert.equal(gateway.requests.some((request) => request.messages?.some((message) => message.content.includes("SWE_BENCH_POST_TEST_CONVERGENCE_GATE_ENFORCED"))), false);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_READY_FOR_HARNESS_GATE"), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    await kernel.shutdown();
  });

  it("returns control before focused source reads after successful SWE-bench test evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchPostTestFocusedReadModelGateway();
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect, edit, verify, and return control for official harness scoring."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 10, maxToolCalls: 16 }
    }));

    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.toolCallId === "call-post-test-focused-read"), false);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && event.data.toolCallId === "call-post-test-focused-read"), false);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_READY_FOR_HARNESS_GATE"), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    await kernel.shutdown();
  });

  it("stops a SWE-bench child run before issuing a thirteenth model request", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchRequestBudgetRunawayModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect, edit, verify, and return control for official harness scoring."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 20, maxToolCalls: 30 }
    }));

    const terminalData = events.at(-1)?.data as JsonObject | undefined;

    assert.equal(gateway.requests.length, 12);
    assert.equal(events.filter((event) => event.kind === "model.requested").length, 12);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_REQUEST_BUDGET_GATE"), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.failed");
    assert.equal(terminalData?.reason, "swe-bench-request-budget-exceeded");
    assert.equal(terminalData?.iterations, 12);
    await kernel.shutdown();
  });

  it("returns control to the harness instead of failing budget after edit test and diff evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchReadyForHarnessAtBudgetModelGateway();
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    await loopDeps.platform.writeFile("/workspace/src/example.py", sweBenchExampleSource());
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: [
        "Resolve SWE-bench instance demo__repo-1.",
        "Managed SWE-bench execution profile:",
        "- Inspect, edit, verify, inspect git diff, and return control for official harness scoring."
      ].join("\n"),
      caller: "runtime.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 20, maxToolCalls: 30 }
    }));

    const terminalData = events.at(-1)?.data as JsonObject | undefined;

    assert.equal(gateway.requests.length, 2);
    assert.equal(events.filter((event) => event.kind === "model.requested").length, 2);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data.name === "core.git.diff"), false);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_REQUEST_BUDGET_GATE"), false);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.gate === "SWE_BENCH_READY_FOR_HARNESS_GATE"), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal(terminalData?.reason, "swe-bench-ready-for-harness");
    assert.equal(terminalData?.iterations, 2);
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
    assert.equal(gateway.requests[1]?.messages?.some((message) => message.role === "tool" && message.toolName === "agent.self-repair"), true);
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
});

function sweBenchExampleSource(): string {
  return [
    "# synthetic SWE-bench runtime fixture",
    "VALUE = 'old'",
    ...Array.from({ length: 80 }, (_, index) => `line_${index} = ${index}`)
  ].join("\n");
}

function sweBenchExampleEditInput(): JsonObject {
  return {
    path: "src/example.py",
    expected: "VALUE = 'old'",
    replacement: "VALUE = 'new'"
  };
}

function workflowBoundaryProfilePolicy(capabilityIds: readonly string[]): AgentLoopProfilePolicyMetadata {
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

async function registerFakeSweBenchRunCapability(
  deps: Pick<ReturnType<typeof createDeterministicRuntimeDependencies>, "capabilities">
): Promise<void> {
  const definition = defineToolManifest(
    "swe.bench.run",
    asId<"capability">("core.swe.bench.run"),
    "Fake SWE-bench Run",
    "process",
    ["process:run", "evaluation:swe-bench"],
    objectSchema([], {
      taskNumber: { type: "number" },
      execute: { type: "boolean" },
      dryRun: { type: "boolean" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    async (_input, context) => ({
      ok: true,
      value: {
        evidence: {
          tool: "swe.bench.run",
          status: "completed",
          affectedPaths: [],
          preview: boundedText("fake swe-bench run", 4_000),
          diagnostics: [],
          metadata: { redaction: { class: "internal" as const } },
          replay: replay(context),
          redaction: { class: "internal" as const, fields: ["metadata"] }
        }
      }
    }),
    { timeoutMs: 30_000, replayPolicy: { replayable: false, snapshot: "fake-swe-bench-run", deterministic: true } }
  );
  await deps.capabilities.register(definition.manifest, definition.execute);
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

class CapturingToolIntentPreflight implements ToolIntentPreflightService {
  readonly requests: ToolIntentPreflightRequest[] = [];

  constructor(private readonly delegate: ToolIntentPreflightService) {}

  async check(request: ToolIntentPreflightRequest): Promise<ToolIntentPreflightResult> {
    this.requests.push(request);
    return this.delegate.check(request);
  }
}

class SweBenchRunThenTakeoverModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (this.requests.length > 1) {
      yield { kind: "tool-call", id: "call-takeover", name: "core.file.read", input: { path: "README.md" } };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "tool-call", id: "call-swe-run", name: "core.swe.bench.run", input: { taskNumber: 2, execute: true } };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchOuterRoutingGateModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (request.messages?.some((message) => message.content.includes("SWE_BENCH_RUN_CAPABILITY_ROUTING_GATE"))) {
      yield {
        kind: "tool-call",
        id: "call-swe-run-after-routing-gate",
        name: "core.swe.bench.run",
        input: { taskNumber: 3, execute: true, runId: "unit-routing-gate" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield {
      kind: "tool-call",
      id: `call-pre-run-search-${this.requests.length}`,
      name: "core.search.text",
      input: { pattern: "swe-bench", glob: "src/**/*.ts", outputMode: "files" }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchHistoryTailModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly toolCallTarget: number) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (this.requests.length > this.toolCallTarget) {
      yield { kind: "delta", text: "history tail bounded" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield {
      kind: "tool-call",
      id: `call-history-tail-${this.requests.length}`,
      name: "runtime.echo",
      input: { text: `history tail ${this.requests.length}` }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchLargeToolFeedbackModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (this.requests.length > 1) {
      yield { kind: "delta", text: "large feedback compacted" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield {
      kind: "tool-call",
      id: "call-large-feedback",
      name: "core.file.read",
      input: { path: "large.txt", limitBytes: 24_000 }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
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

class SweBenchGateHistoryTailModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const gateSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE")) === true;
    if (gateSeen && this.step >= 11) {
      yield { kind: "delta", text: "gate history observed" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    yield {
      kind: "tool-call",
      id: `call-gate-history-${this.step}`,
      name: "core.search.text",
      input: { pattern: `history_gate_${this.step}`, glob: "*.ts", workspaceRoot: "." }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchVerificationGateModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private probeCount = 0;
  private testIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const gateSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_VERIFICATION_GATE")) === true;
    if (gateSeen && !this.testIssued) {
      this.testIssued = true;
      yield { kind: "tool-call", id: "call-swe-test", name: "core.shell.run", input: { command: "python -m pytest tests/test_demo.py" } };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.testIssued) {
      yield { kind: "delta", text: "verification evidence captured" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    this.probeCount += 1;
    yield {
      kind: "tool-call",
      id: `call-probe-${this.probeCount}`,
      name: "core.shell.run",
      input: { command: `python -c \"print('probe ${this.probeCount}')\"` }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchVerificationGateDefiantModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private probeCount = 0;
  private installRejected = false;
  private testIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const gateSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_VERIFICATION_GATE")) === true;
    const enforcedSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_VERIFICATION_GATE_ENFORCED")) === true;
    if (enforcedSeen && !this.testIssued) {
      this.testIssued = true;
      yield { kind: "tool-call", id: "call-swe-test-after-rejection", name: "core.shell.run", input: { command: "python -m pytest tests/test_demo.py" } };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.testIssued) {
      yield { kind: "delta", text: "verification evidence captured after enforced gate" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    if (gateSeen && !this.installRejected) {
      this.installRejected = true;
      yield { kind: "tool-call", id: "call-defiant-install", name: "core.shell.run", input: { command: "python -m pip install numpy" } };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    this.probeCount += 1;
    yield {
      kind: "tool-call",
      id: `call-defiant-probe-${this.probeCount}`,
      name: "core.shell.run",
      input: { command: `python -c \"print('probe ${this.probeCount}')\"` }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchSourceInspectionDefiantModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;
  private inspectionRejected = false;
  private editIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const gateSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE")) === true;
    const enforcedSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED")) === true;
    if (enforcedSeen && !this.editIssued) {
      this.editIssued = true;
      yield {
        kind: "tool-call",
        id: "call-source-edit-after-rejection",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.editIssued) {
      yield { kind: "delta", text: "source edit issued after enforced inspection gate" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    if (gateSeen && !this.inspectionRejected) {
      this.inspectionRejected = true;
      yield {
        kind: "tool-call",
        id: "call-defiant-source-search",
        name: "core.search.text",
        input: { pattern: "header_rows", glob: "*.py", workspaceRoot: "." }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    const toolName = this.step % 3 === 0 ? "core.file.read" : this.step % 3 === 1 ? "core.search.text" : "core.file.list";
    const input = toolName === "core.file.read"
      ? { path: "src/example.py" }
      : toolName === "core.file.list"
        ? { path: "src" }
        : { pattern: `needle_${this.step}`, glob: "*.py", workspaceRoot: "." };
    yield {
      kind: "tool-call",
      id: `call-source-inspect-${this.step}`,
      name: toolName,
      input
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchSourceInspectionPersistentDefiantModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;
  private defiantSearchCount = 0;
  private editIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const gateSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE")) === true;
    if (gateSeen && this.defiantSearchCount < 2) {
      this.defiantSearchCount += 1;
      yield {
        kind: "tool-call",
        id: `call-persistent-defiant-source-search-${this.defiantSearchCount}`,
        name: "core.search.text",
        input: { pattern: `persistent_${this.defiantSearchCount}`, glob: "*.py", workspaceRoot: "." }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (gateSeen && !this.editIssued) {
      this.editIssued = true;
      yield {
        kind: "tool-call",
        id: "call-persistent-edit-after-defiance",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    const toolName = this.step % 3 === 0 ? "core.file.read" : this.step % 3 === 1 ? "core.search.text" : "core.file.list";
    const input = toolName === "core.file.read"
      ? { path: "src/example.py", offset: 0, limit: 20 }
      : toolName === "core.file.list"
        ? { path: "src" }
        : { pattern: `persistent_probe_${this.step}`, glob: "*.py", workspaceRoot: "." };
    yield {
      kind: "tool-call",
      id: `call-persistent-source-inspect-${this.step}`,
      name: toolName,
      input
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchSourceInspectionRecoveryBudgetModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;
  private inspectionRejected = false;
  private editIssued = false;
  private testIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const sourceGateSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE")) === true;
    const sourceGateEnforcedSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED")) === true;
    const postEditGateSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_POST_EDIT_VERIFICATION_GATE")) === true;
    if (postEditGateSeen && !this.testIssued) {
      this.testIssued = true;
      yield {
        kind: "tool-call",
        id: "call-recovery-test-after-edit",
        name: "core.test.run",
        input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"], intent: "unit" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (sourceGateEnforcedSeen && !this.editIssued) {
      this.editIssued = true;
      yield {
        kind: "tool-call",
        id: "call-recovery-edit-after-rejection",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.testIssued) {
      yield { kind: "delta", text: "source inspection recovery completed with edit and test" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    if (sourceGateSeen && !this.inspectionRejected) {
      this.inspectionRejected = true;
      yield {
        kind: "tool-call",
        id: "call-recovery-defiant-search",
        name: "core.search.text",
        input: { pattern: "header_rows", glob: "*.py", workspaceRoot: "." }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    const toolName = this.step % 3 === 0 ? "core.file.read" : this.step % 3 === 1 ? "core.search.text" : "core.file.list";
    const input = toolName === "core.file.read"
      ? { path: "src/example.py", offset: 0, limit: 20 }
      : toolName === "core.file.list"
        ? { path: "src" }
        : { pattern: `recovery_${this.step}`, glob: "*.py", workspaceRoot: "." };
    yield {
      kind: "tool-call",
      id: `call-recovery-inspect-${this.step}`,
      name: toolName,
      input
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchSourceInspectionGlobDefiantModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;
  private globRejected = false;
  private editIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const gateSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE")) === true;
    const enforcedSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED")) === true;
    if (enforcedSeen && !this.editIssued) {
      this.editIssued = true;
      yield {
        kind: "tool-call",
        id: "call-source-edit-after-glob-rejection",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.editIssued) {
      yield { kind: "delta", text: "source edit issued after enforced glob inspection gate" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    if (gateSeen && !this.globRejected) {
      this.globRejected = true;
      yield {
        kind: "tool-call",
        id: "call-defiant-source-glob",
        name: "core.workspace.glob",
        input: { pattern: "src/**/*.py", workspaceRoot: "." }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    yield {
      kind: "tool-call",
      id: `call-source-glob-${this.step}`,
      name: "core.workspace.glob",
      input: { pattern: "src/**/*.py", workspaceRoot: "." }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchSourceInspectionFocusedReadModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;
  private focusedReadIssued = false;
  private editIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const gateSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE")) === true;
    if (this.focusedReadIssued && !this.editIssued) {
      this.editIssued = true;
      yield {
        kind: "tool-call",
        id: "call-focused-edit-after-read",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.editIssued) {
      yield { kind: "delta", text: "focused read allowed before edit" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    if (gateSeen && !this.focusedReadIssued) {
      this.focusedReadIssued = true;
      yield {
        kind: "tool-call",
        id: "call-focused-source-read",
        name: "core.file.read",
        input: { path: "src/example.py", offset: 40, limit: 20 }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    const toolName = this.step % 3 === 0 ? "core.file.read" : this.step % 3 === 1 ? "core.search.text" : "core.file.list";
    const input = toolName === "core.file.read"
      ? { path: "src/example.py", offset: 0, limit: 20 }
      : toolName === "core.file.list"
        ? { path: "src" }
        : { pattern: `needle_${this.step}`, glob: "*.py", workspaceRoot: "." };
    yield {
      kind: "tool-call",
      id: `call-focused-inspect-${this.step}`,
      name: toolName,
      input
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchDuplicateSourceInspectionModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;
  private editIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const duplicateRejectedSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_DUPLICATE_GATE_ENFORCED")) === true;
    if (duplicateRejectedSeen && !this.editIssued) {
      this.editIssued = true;
      yield {
        kind: "tool-call",
        id: "call-edit-after-duplicate-source-read",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.editIssued) {
      yield { kind: "delta", text: "duplicate source read rejected before edit" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    if (this.step <= 2) {
      yield {
        kind: "tool-call",
        id: `call-duplicate-source-read-${this.step}`,
        name: "core.file.read",
        input: { path: "src/example.py", offset: 1, limit: 80 }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: "duplicate source read was not rejected" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchDuplicateGateWorkflowGuidanceModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  workflowStateAfterDuplicate: string | undefined;
  workflowStateAfterEdit: string | undefined;
  workflowGateOverrideAfterEdit: JsonObject | undefined;
  visibleToolsAfterDuplicate: readonly string[] = [];
  private step = 0;
  private editIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const stateMessage = request.messages?.filter((message) => message.content.includes("Agent profile workflow state:")).at(-1)?.content;
    const profilePolicy = jsonObjectRecord(request.metadata?.profilePolicy);
    const duplicateRejectedSeen = profilePolicy?.workflowGateOverride !== undefined;
    if (duplicateRejectedSeen && !this.editIssued) {
      this.editIssued = true;
      this.workflowStateAfterDuplicate = stateMessage;
      this.visibleToolsAfterDuplicate = visibleToolNames(request);
      yield {
        kind: "tool-call",
        id: "call-edit-after-duplicate-source-read",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.editIssued) {
      this.workflowStateAfterEdit = stateMessage;
      this.workflowGateOverrideAfterEdit = jsonObjectRecord(profilePolicy?.workflowGateOverride);
      yield { kind: "delta", text: "duplicate workflow guidance checked" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    if (this.step <= 2) {
      yield {
        kind: "tool-call",
        id: `call-duplicate-source-read-${this.step}`,
        name: "core.file.read",
        input: { path: "src/example.py", offset: 1, limit: 80 }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: "duplicate source read was not rejected" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

function visibleToolNames(request: ModelRequest): readonly string[] {
  return (request.tools ?? [])
    .map((tool) => {
      const fn = jsonObjectRecord(tool.function);
      return typeof fn?.name === "string" ? fn.name : "";
    })
    .filter(Boolean)
    .sort();
}

class SweBenchDuplicateGateContinuityModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  duplicateGateRequestIncludedSuccessfulSourceEvidence = false;
  private step = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const messageText = JSON.stringify(request.messages ?? []);
    if (messageText.includes("SWE_BENCH_SOURCE_INSPECTION_DUPLICATE_GATE_ENFORCED")) {
      this.duplicateGateRequestIncludedSuccessfulSourceEvidence = messageText.includes("unique_source_evidence_for_duplicate_gate");
      yield { kind: "delta", text: "duplicate gate continuity checked" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    if (this.step <= 2) {
      yield {
        kind: "tool-call",
        id: `call-continuity-duplicate-read-${this.step}`,
        name: "core.file.read",
        input: { path: "src/example.py", offset: 1, limit: 80 }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: "duplicate gate was not visible" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchOverlappingSourceInspectionModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;
  private editIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const duplicateRejectedSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_DUPLICATE_GATE_ENFORCED")) === true;
    if (duplicateRejectedSeen && !this.editIssued) {
      this.editIssued = true;
      yield {
        kind: "tool-call",
        id: "call-edit-after-overlapping-source-read",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.editIssued) {
      yield { kind: "delta", text: "overlapping source read rejected before edit" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    if (this.step <= 2) {
      yield {
        kind: "tool-call",
        id: `call-overlapping-source-read-${this.step}`,
        name: "core.file.read",
        input: this.step === 1
          ? { path: "src/example.py", offset: 100, limit: 120 }
          : { path: "src/example.py", offset: 115, limit: 80 }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: "overlapping source read was not rejected" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchDuplicateThenSearchSourceInspectionModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;
  private searchIssued = false;
  private editIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const duplicateRejectedSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_DUPLICATE_GATE_ENFORCED")) === true;
    if (duplicateRejectedSeen && this.searchIssued && !this.editIssued) {
      this.editIssued = true;
      yield {
        kind: "tool-call",
        id: "call-edit-after-duplicate-source-search",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.editIssued) {
      yield { kind: "delta", text: "duplicate search gate routed to edit" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    if (duplicateRejectedSeen && !this.searchIssued) {
      this.searchIssued = true;
      yield {
        kind: "tool-call",
        id: "call-search-after-duplicate-source-read",
        name: "core.search.text",
        input: { pattern: "def merge", glob: "src/example.py", outputMode: "content", contextLines: 20 }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    if (this.step <= 2) {
      yield {
        kind: "tool-call",
        id: `call-duplicate-then-search-read-${this.step}`,
        name: "core.file.read",
        input: { path: "src/example.py", offset: 1, limit: 80 }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: "duplicate source search was not rejected" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchSourceInspectionSecondFocusedReadModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;
  private firstFocusedReadIssued = false;
  private secondFocusedReadIssued = false;
  private editIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const gateSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE")) === true;
    const enforcedSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED")) === true;
    if (enforcedSeen && !this.editIssued) {
      this.editIssued = true;
      yield {
        kind: "tool-call",
        id: "call-second-focused-edit-after-rejection",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.editIssued || this.secondFocusedReadIssued) {
      yield { kind: "delta", text: "second focused read handled" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    if (gateSeen && this.firstFocusedReadIssued && !this.secondFocusedReadIssued) {
      this.secondFocusedReadIssued = true;
      yield {
        kind: "tool-call",
        id: "call-second-focused-source-read",
        name: "core.file.read",
        input: { path: "src/example.py", offset: 80, limit: 20 }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (gateSeen && !this.firstFocusedReadIssued) {
      this.firstFocusedReadIssued = true;
      yield {
        kind: "tool-call",
        id: "call-first-focused-source-read",
        name: "core.file.read",
        input: { path: "src/example.py", offset: 40, limit: 20 }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    const toolName = this.step % 3 === 0 ? "core.file.read" : this.step % 3 === 1 ? "core.search.text" : "core.file.list";
    const input = toolName === "core.file.read"
      ? { path: "src/example.py", offset: 0, limit: 20 }
      : toolName === "core.file.list"
        ? { path: "src" }
        : { pattern: `second_focused_${this.step}`, glob: "*.py", workspaceRoot: "." };
    yield {
      kind: "tool-call",
      id: `call-second-focused-inspect-${this.step}`,
      name: toolName,
      input
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchSourceInspectionRepeatedFocusedReadModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;
  private repeatedFocusedReadIssued = false;
  private editIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const gateSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE")) === true;
    const enforcedSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED")) === true;
    if (enforcedSeen && !this.editIssued) {
      this.editIssued = true;
      yield {
        kind: "tool-call",
        id: "call-repeated-focused-edit-after-rejection",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.editIssued) {
      yield { kind: "delta", text: "repeated focused read rejected before edit" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    if (gateSeen && !this.repeatedFocusedReadIssued) {
      this.repeatedFocusedReadIssued = true;
      yield {
        kind: "tool-call",
        id: "call-repeated-focused-source-read",
        name: "core.file.read",
        input: { path: "src/example.py", offset: 1, limit: 120 }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    const toolName = this.step % 2 === 0 ? "core.search.text" : "core.file.read";
    const input = toolName === "core.file.read"
      ? {
          path: "src/example.py",
          offset: this.step === 1 ? 1 : 200 + this.step * 20,
          limit: this.step === 1 ? 120 : 20
        }
      : { pattern: `needle_${this.step}`, glob: "*.py", workspaceRoot: "." };
    yield {
      kind: "tool-call",
      id: `call-repeated-focused-inspect-${this.step}`,
      name: toolName,
      input
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchSourceInspectionWholeFileReadModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;
  private wholeFileReadIssued = false;
  private editIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const gateSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE")) === true;
    const enforcedSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED")) === true;
    if (enforcedSeen && !this.editIssued) {
      this.editIssued = true;
      yield {
        kind: "tool-call",
        id: "call-edit-after-whole-file-read-rejection",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.editIssued) {
      yield { kind: "delta", text: "source edit issued after whole-file read rejection" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    if (gateSeen && !this.wholeFileReadIssued) {
      this.wholeFileReadIssued = true;
      yield {
        kind: "tool-call",
        id: "call-whole-file-read-after-gate",
        name: "core.file.read",
        input: { path: "src/example.py" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    const toolName = this.step % 3 === 0 ? "core.file.read" : this.step % 3 === 1 ? "core.search.text" : "core.file.list";
    const input = toolName === "core.file.read"
      ? { path: "src/example.py", offset: 0, limit: 20 }
      : toolName === "core.file.list"
        ? { path: "src" }
        : { pattern: `needle_${this.step}`, glob: "*.py", workspaceRoot: "." };
    yield {
      kind: "tool-call",
      id: `call-whole-file-inspect-${this.step}`,
      name: toolName,
      input
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchSourceInspectionShellDefiantModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;
  private shellRejected = false;
  private editIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const gateSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE")) === true;
    const enforcedSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED")) === true;
    if (enforcedSeen && !this.editIssued) {
      this.editIssued = true;
      yield {
        kind: "tool-call",
        id: "call-source-edit-after-shell-rejection",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.editIssued) {
      yield { kind: "delta", text: "source edit issued after enforced inspection shell gate" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    if (gateSeen && !this.shellRejected) {
      this.shellRejected = true;
      yield {
        kind: "tool-call",
        id: "call-defiant-source-shell",
        name: "core.shell.run",
        input: { command: "python -m pip install numpy" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    const toolName = this.step % 3 === 0 ? "core.file.read" : this.step % 3 === 1 ? "core.search.text" : "core.file.list";
    const input = toolName === "core.file.read"
      ? { path: "src/example.py" }
      : toolName === "core.file.list"
        ? { path: "src" }
        : { pattern: `needle_${this.step}`, glob: "*.py", workspaceRoot: "." };
    yield {
      kind: "tool-call",
      id: `call-source-shell-inspect-${this.step}`,
      name: toolName,
      input
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchNoopEditAfterInspectionGateModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;
  private noopIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const gateSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_SOURCE_INSPECTION_GATE")) === true;
    if (this.noopIssued) {
      yield { kind: "delta", text: "noop edit failed; stopping without mutation" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    if (gateSeen) {
      this.noopIssued = true;
      yield {
        kind: "tool-call",
        id: "call-noop-edit",
        name: "core.file.edit",
        input: {
          path: "src/example.py",
          expected: "VALUE = 'old'",
          replacement: "VALUE = 'old'"
        }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    yield {
      kind: "tool-call",
      id: `call-noop-preedit-inspect-${this.step}`,
      name: this.step % 2 === 0 ? "core.file.read" : "core.search.text",
      input: this.step % 2 === 0
        ? { path: "src/example.py", offset: this.step * 10, limit: 20 }
        : { pattern: `needle_${this.step}`, glob: "*.py", workspaceRoot: "." }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchPostEditVerificationDefiantModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;
  private editIssued = false;
  private postEditReadRejected = false;
  private testIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const enforcedSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_POST_EDIT_VERIFICATION_GATE_ENFORCED")) === true;
    if (enforcedSeen && !this.testIssued) {
      this.testIssued = true;
      yield {
        kind: "tool-call",
        id: "call-post-edit-test",
        name: "core.shell.run",
        input: { command: "python -m pytest tests/test_demo.py" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.testIssued) {
      yield { kind: "delta", text: "post-edit verification captured" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    if (this.editIssued && !this.postEditReadRejected) {
      this.postEditReadRejected = true;
      yield {
        kind: "tool-call",
        id: "call-post-edit-read",
        name: "core.file.read",
        input: { path: "src/example.py", offset: 40, limit: 40 }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (!this.editIssued && this.step >= 8) {
      this.editIssued = true;
      yield {
        kind: "tool-call",
        id: "call-post-edit-source-edit",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    const toolName = this.step % 2 === 0 ? "core.file.read" : "core.search.text";
    const input = toolName === "core.file.read"
      ? { path: "src/example.py", offset: this.step * 10, limit: 20 }
      : { pattern: `needle_${this.step}`, glob: "*.py", workspaceRoot: "." };
    yield {
      kind: "tool-call",
      id: `call-post-edit-inspect-${this.step}`,
      name: toolName,
      input
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchEarlyEditThenReadModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;
  private testIssued = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const enforcedSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_POST_EDIT_VERIFICATION_GATE_ENFORCED")) === true;
    if (enforcedSeen && !this.testIssued) {
      this.testIssued = true;
      yield {
        kind: "tool-call",
        id: "call-early-post-edit-test",
        name: "core.test.run",
        input: {
          command: "python -m pytest",
          args: ["tests/test_demo.py", "-q"]
        }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    if (this.step === 1) {
      yield {
        kind: "tool-call",
        id: "call-early-inspect",
        name: "core.file.read",
        input: { path: "src/example.py", offset: 0, limit: 20 }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.step === 2) {
      yield {
        kind: "tool-call",
        id: "call-early-edit",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.step === 3) {
      yield {
        kind: "tool-call",
        id: "call-early-post-edit-read",
        name: "core.file.read",
        input: { path: "src/example.py", offset: 20, limit: 20 }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: "done" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchCoreTestRunVerificationModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (request.messages?.some((message) => message.content.includes("SWE_BENCH_VERIFICATION_GATE"))) {
      yield { kind: "delta", text: "unexpected verification gate" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    if (this.step <= 7) {
      yield {
        kind: "tool-call",
        id: `call-probe-${this.step}`,
        name: "core.shell.run",
        input: { command: `python -c \"print('probe ${this.step}')\"` }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.step === 8) {
      yield {
        kind: "tool-call",
        id: "call-core-test-run",
        name: "core.test.run",
        input: { command: "node", args: ["--version"], intent: "unit" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.step <= 10) {
      yield {
        kind: "tool-call",
        id: `call-post-test-probe-${this.step}`,
        name: "core.shell.run",
        input: { command: `python -c \"print('post-test probe ${this.step}')\"` }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: "core.test.run verification evidence captured" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchEnvironmentBlockerModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (request.messages?.some((message) => message.content.includes("SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"))) {
      yield { kind: "delta", text: "environment blocker acknowledged; patch ready for harness" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    if (this.step === 1) {
      yield {
        kind: "tool-call",
        id: "call-edit",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.step === 2) {
      yield {
        kind: "tool-call",
        id: "call-test",
        name: "core.test.run",
        input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"], intent: "unit" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield {
      kind: "tool-call",
      id: `call-env-probe-${this.step}`,
      name: "core.shell.run",
      input: { command: "python -c \"import erfa; import yaml; import numpy\" 2>&1 || python -m pip install pyerfa pyyaml numpy" }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
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

class SweBenchRepoLocalRunnerRoutingModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (request.messages?.some((message) => message.content.includes("SWE_BENCH_REPO_LOCAL_RUNNER_GATE"))) {
      yield {
        kind: "tool-call",
        id: "call-repo-local-routing-runner",
        name: "core.shell.run",
        input: { command: "python tests/runtests.py tests.test_demo -v 2" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    if (this.step === 1) {
      yield {
        kind: "tool-call",
        id: "call-repo-local-routing-edit",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.step === 2) {
      yield {
        kind: "tool-call",
        id: "call-repo-local-routing-test",
        name: "core.test.run",
        input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"], intent: "unit" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield {
      kind: "tool-call",
      id: `call-repo-local-routing-probe-${this.step}`,
      name: "core.shell.run",
      input: { command: "python -c \"import pytest\" 2>&1 || python -m pip install pytest" }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchRepoLocalRunnerCoreTestRetryModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;
  private retriedPytestAfterGate = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const messageText = request.messages?.map((message) => message.content).join("\n") ?? "";
    if (messageText.includes("SWE_BENCH_REPO_LOCAL_RUNNER_GATE_ENFORCED")) {
      yield {
        kind: "tool-call",
        id: "call-repo-local-core-test-runner",
        name: "core.shell.run",
        input: { command: "python tests/runtests.py tests.test_demo -v 2" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (messageText.includes("SWE_BENCH_REPO_LOCAL_RUNNER_GATE") && !this.retriedPytestAfterGate) {
      this.retriedPytestAfterGate = true;
      yield {
        kind: "tool-call",
        id: "call-repo-local-core-test-retry",
        name: "core.test.run",
        input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"], intent: "unit" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    if (this.step === 1) {
      yield {
        kind: "tool-call",
        id: "call-repo-local-core-test-edit",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield {
      kind: "tool-call",
      id: "call-repo-local-core-test-initial",
      name: "core.test.run",
      input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"], intent: "unit" }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchReadyForHarnessAfterPostVerificationProbeModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    this.step += 1;
    if (this.step === 1) {
      yield {
        kind: "tool-call",
        id: "call-ready-probe-edit",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.step === 2) {
      yield {
        kind: "tool-call",
        id: "call-ready-probe-test",
        name: "core.test.run",
        input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"], intent: "unit" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.step === 3) {
      yield {
        kind: "tool-call",
        id: "call-ready-probe-diff",
        name: "core.git.diff",
        input: { workspaceRoot: ".", limitBytes: 4_000 }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield {
      kind: "tool-call",
      id: `call-ready-probe-shell-${this.step}`,
      name: "core.shell.run",
      input: { command: "python -c \"import numpy\" 2>&1 || python -m pip install numpy" }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchRepoLocalDjangoRunnerShellModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    this.step += 1;
    if (this.step === 1) {
      yield {
        kind: "tool-call",
        id: "call-django-runner-edit",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.step === 2) {
      yield {
        kind: "tool-call",
        id: "call-django-runner-test",
        name: "core.shell.run",
        input: { command: "python tests/runtests.py forms_tests.tests.test_media -v 2" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield {
      kind: "tool-call",
      id: "call-django-runner-extra-probe",
      name: "core.shell.run",
      input: { command: "python -c \"import django\"" }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchInheritedPatchEnvironmentBlockerModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (request.messages?.some((message) => message.content.includes("SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"))) {
      yield { kind: "delta", text: "inherited patch environment blocker acknowledged; returning patch for harness" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    if (this.step === 1) {
      yield {
        kind: "tool-call",
        id: "call-inherited-test",
        name: "core.test.run",
        input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"], intent: "unit" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield {
      kind: "tool-call",
      id: `call-inherited-env-probe-${this.step}`,
      name: "core.shell.run",
      input: { command: "python -c \"import numpy\" 2>&1 || python -m pip install 'numpy<2'" }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchEnvironmentBlockerDefiantModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;
  private installRejected = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const blockerSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_ENVIRONMENT_BLOCKER_GATE")) === true;
    const enforcedSeen = request.messages?.some((message) => message.content.includes("SWE_BENCH_ENVIRONMENT_BLOCKER_GATE_ENFORCED")) === true;
    if (enforcedSeen) {
      yield { kind: "delta", text: "environment blocker enforcement acknowledged; returning patch for harness" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    if (blockerSeen && !this.installRejected) {
      this.installRejected = true;
      yield {
        kind: "tool-call",
        id: "call-defiant-env-install",
        name: "core.shell.run",
        input: { command: "python -m pip install pyerfa pyyaml numpy" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    if (this.step === 1) {
      yield {
        kind: "tool-call",
        id: "call-env-defiant-edit",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.step === 2) {
      yield {
        kind: "tool-call",
        id: "call-env-defiant-test",
        name: "core.test.run",
        input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"], intent: "unit" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield {
      kind: "tool-call",
      id: `call-env-defiant-probe-${this.step}`,
      name: "core.shell.run",
      input: { command: "python -c \"import erfa; import yaml; import numpy\" 2>&1 || python -m pip install pyerfa pyyaml numpy" }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchPostTestBroadReadDefiantModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (request.messages?.some((message) => message.content.includes("SWE_BENCH_POST_TEST_CONVERGENCE_GATE_ENFORCED"))) {
      yield { kind: "delta", text: "post-test broad read rejected; returning control for harness" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    this.step += 1;
    if (this.step === 1) {
      yield {
        kind: "tool-call",
        id: "call-post-test-edit",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.step === 2) {
      yield {
        kind: "tool-call",
        id: "call-post-test-test",
        name: "core.test.run",
        input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"], intent: "unit" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield {
      kind: "tool-call",
      id: "call-post-test-broad-read",
      name: "core.file.read",
      input: { path: "src/example.py" }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchPostTestFocusedReadModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    this.step += 1;
    if (this.step === 1) {
      yield {
        kind: "tool-call",
        id: "call-post-test-focused-edit",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.step === 2) {
      yield {
        kind: "tool-call",
        id: "call-post-test-focused-test",
        name: "core.test.run",
        input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"], intent: "unit" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.step === 3) {
      yield {
        kind: "tool-call",
        id: "call-post-test-focused-read",
        name: "core.file.read",
        input: { path: "src/example.py", offset: 10, limit: 20 }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: "post-test focused read allowed" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchRequestBudgetRunawayModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    this.step += 1;
    if (this.step === 1) {
      yield {
        kind: "tool-call",
        id: "call-budget-edit",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.step % 4 === 0) {
      yield {
        kind: "tool-call",
        id: `call-budget-test-${this.step}`,
        name: "core.test.run",
        input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"], intent: "unit" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield {
      kind: "tool-call",
      id: `call-budget-read-${this.step}`,
      name: "core.file.read",
      input: { path: "src/example.py" }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchReadyForHarnessAtBudgetModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private step = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    this.step += 1;
    if (this.step === 1) {
      yield {
        kind: "tool-call",
        id: "call-ready-edit",
        name: "core.file.edit",
        input: sweBenchExampleEditInput()
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.step === 2) {
      yield {
        kind: "tool-call",
        id: "call-ready-test",
        name: "core.test.run",
        input: { command: "python", args: ["-m", "pytest", "tests/test_demo.py"], intent: "unit" }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (this.step === 12) {
      yield {
        kind: "tool-call",
        id: "call-ready-diff",
        name: "core.git.diff",
        input: { workspaceRoot: ".", limitBytes: 4_000 }
      };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield {
      kind: "tool-call",
      id: `call-ready-focused-read-${this.step}`,
      name: "core.file.read",
      input: { path: "src/example.py", offset: Math.min(180, this.step * 10), limit: 20 }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
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
    if (request.messages?.some((message) => message.role === "tool" && message.toolName === "agent.self-repair")) {
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
        message: request.messages?.some((message) => message.role === "tool" && message.toolName === "agent.self-repair")
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
    if (request.messages?.some((message) => message.role === "tool" && message.toolName === "evidence-first.claim-grounding")) {
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
