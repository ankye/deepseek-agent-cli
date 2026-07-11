import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "@deepseek/platform-contracts";
import { collectRuntimeEvents, createDefaultRuntimeKernel, registerRuntimeCoreTools, runAgentLoop } from "@deepseek/runtime";
import { defaultDeepSeekProfile } from "@deepseek/model-gateway";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";

describe("self-repair agent loop golden replay", () => {
  it("replays repair event ordering and stop decisions", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new RepairOnceModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const runtime = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "recover from provider failure",
      caller: "golden.self-repair",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      selfRepair: { enabled: true, maxAttempts: 1, requireCheckpointForWrites: false, verificationMode: "minimal" },
      limits: { maxModelIterations: 3, maxRepairAttempts: 1 }
    }));
    const sessionId = runtime[0]?.sessionId;
    assert.ok(sessionId);

    const trace = await deps.regression.normalize({
      name: "self-repair-agent-loop",
      schemaVersion: "1.0.0",
      protocol: [],
      bus: deps.bus.getReplayRecords(sessionId),
      runtime,
      sessions: await deps.sessions.events(sessionId),
      assertions: [
        { expectedKind: "agent.repair.started" },
        { expectedKind: "agent.repair.classified" },
        { expectedKind: "agent.repair.plan.created" },
        { expectedKind: "agent.repair.attempt.started" },
        { expectedKind: "agent.repair.verification.completed" },
        { expectedKind: "agent.loop.completed" }
      ]
    });
    const replay = await deps.regression.replay(trace);
    const kinds = runtime.map((event) => event.kind);
    const repairKinds = kinds.filter((kind) => kind.startsWith("agent.repair."));
    const terminal = runtime.at(-1)?.data as { selfRepair?: { stopReason?: string; attemptCount?: number; successCount?: number } } | undefined;

    assert.equal(replay.ok, true, replay.failures.join("\n"));
    assert.deepEqual(repairKinds, [
      "agent.repair.started",
      "agent.repair.classified",
      "agent.repair.plan.created",
      "agent.repair.verification.started",
      "agent.repair.attempt.started",
      "agent.repair.attempt.completed",
      "agent.repair.verification.completed",
      "agent.repair.stopped"
    ]);
    assert.equal(terminal?.selfRepair?.stopReason, "completed");
    assert.equal(terminal?.selfRepair?.attemptCount, 1);
    assert.equal(terminal?.selfRepair?.successCount, 1);
    assert.equal(hasSelfRepairFeedback(gateway.requests[1]), true);
    await kernel.shutdown();
  });
});

class RepairOnceModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (hasSelfRepairFeedback(request)) {
      yield { kind: "delta", text: "Recovered after bounded repair feedback." };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield {
      kind: "error",
      error: {
        code: "MODEL_FAILED",
        message: "provider failed once",
        retryable: true,
        redaction: { class: "public" }
      }
    };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

function hasSelfRepairFeedback(request: ModelRequest | undefined): boolean {
  return request?.messages?.some((message) =>
    (message.role === "tool" && message.toolName === "agent.self-repair") ||
    (message.role === "system" && message.content.includes("Self-repair failure evidence"))
  ) ?? false;
}
