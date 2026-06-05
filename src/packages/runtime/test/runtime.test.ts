import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoopReferenceContext, JsonObject, ModelGateway, ModelRequest, ModelStreamEvent, PolicyDecision, PolicyEngine, PolicyRequest, PromptAssembler, PromptAssemblyInput, PromptAssemblyResult } from "@deepseek/platform-contracts";
import { collectRuntimeEvents, createDefaultRuntimeKernel, createHeadlessRuntime, registerRuntimeCoreTools, runAgentLoop, runtimeEchoCapability } from "../src/index.js";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";
import { defaultDeepSeekProfile } from "@deepseek/model-gateway";
import { DurablePermanentMemoryProvider, InMemoryPermanentMemoryStorageAdapter, InMemoryLosslessContextManager, PersistentJsonlLosslessContextManager, TOOL_RESULT_EVIDENCE_CACHE_NAMESPACE } from "@deepseek/memory-cache-management";
import { InMemoryUsageBudgetManager } from "@deepseek/usage-budget-management";
import { PersistentFilesystemSessionStore } from "@deepseek/session-store";
import { NodePlatformRuntime } from "@deepseek/platform-abstraction";
import { asId } from "@deepseek/platform-contracts";

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
    assert.equal(typeof promptAssembled?.data.trace === "object", true);
    assert.equal(typeof (promptAssembled?.data.trace as { pipeline?: { pipelineFingerprint?: string } } | undefined)?.pipeline?.pipelineFingerprint, "string");
    assert.equal(typeof gateway.requests[0]?.metadata?.contextPipeline, "object");
    assert.equal((gateway.requests[0]?.metadata?.contextPipeline as { pipelineFingerprint?: string } | undefined)?.pipelineFingerprint?.startsWith("pipeline:"), true);
    assert.equal(typeof (modelRequested?.data.contextPipeline as { pipelineFingerprint?: string } | undefined)?.pipelineFingerprint, "string");
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

class SingleToolCallModelGateway implements ModelGateway {
  constructor(private readonly name: string, private readonly input: JsonObject) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
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

class DenyAllPolicyEngine implements PolicyEngine {
  async decide(_request: PolicyRequest): Promise<PolicyDecision> {
    return {
      action: "deny",
      reason: "Denied by runtime test policy",
      audit: { policy: "deny-all-test" }
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
