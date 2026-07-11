import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  JsonObject,
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
  RuntimeEvent,
  ToolResultFeedback
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import { collectRuntimeEvents, createDefaultRuntimeKernel, registerRuntimeCoreTools, runAgentLoop } from "@deepseek/runtime";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";
import { defaultDeepSeekProfile } from "@deepseek/model-gateway";

const canonicalToolLoopKinds = [
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
  "model.tool.intent",
  "visible.reasoning.recorded",
  "model.tool.repaired",
  "hooks.invoked",
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
  "workflow.closed",
  "model.tool.result",
  "visible.reasoning.recorded",
  "hooks.invoked",
  "model.finished",
  "model.done",
  "hooks.invoked",
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
];

describe("live tool execution golden replay", () => {
  it("emits the canonical tool turn event order with typed feedback and trace correlation", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "golden replay content\n");
    const loopDeps = { ...deps, models: new OneToolThenFinishModelGateway("core.file.read", { path: "README.md" }) };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "tool golden",
      caller: "cli.tool-golden",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    assert.deepEqual(events.map((event) => event.kind), canonicalToolLoopKinds);

    const toolResult = events.find((event) => event.kind === "model.tool.result");
    assert.ok(toolResult);
    const feedback = (toolResult!.data as { feedback?: ToolResultFeedback }).feedback;
    assert.ok(feedback, "tool result must carry typed feedback");
    assert.equal(feedback.schemaVersion, "1.0.0");
    assert.equal(feedback.status, "success");
    assert.equal(feedback.continuation, "continue");
    assert.equal(feedback.preview.redaction.class, "internal");
    assert.equal(feedback.trace.traceId.length > 0, true);
    assert.equal(feedback.trace.correlationId.length > 0, true);

    const toolIntent = events.find((event) => event.kind === "model.tool.intent");
    assert.equal(feedback.trace.traceId, String(toolIntent!.trace.traceId));
    assert.equal(feedback.trace.correlationId, String(toolIntent!.trace.correlationId));

    const sessionId = events[0]?.sessionId ? asId<"session">(events[0].sessionId) : undefined;
    assert.ok(sessionId);
    const trace = await loopDeps.regression.normalize({
      name: "live-tool-execution",
      schemaVersion: "1.0.0",
      protocol: [],
      bus: loopDeps.bus.getReplayRecords(sessionId),
      runtime: events as readonly RuntimeEvent[],
      sessions: await loopDeps.sessions.events(sessionId),
      assertions: [
        { expectedKind: "agent.loop.completed" },
        { expectedKind: "model.tool.result" }
      ]
    });
    const replay = await loopDeps.regression.replay(trace);
    assert.equal(replay.ok, true, replay.failures.join("\n"));
    await kernel.shutdown();
  });

  it("captures a denied tool outcome with terminated continuation? false in the replay stream", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "denied replay content\n");
    const loopDeps = {
      ...deps,
      models: new OneToolThenFinishModelGateway("core.file.read", { path: "README.md" }),
      policy: {
        async decide() {
          return {
            action: "deny" as const,
            reason: "Denied by replay test policy",
            audit: { policy: "deny-all-golden" }
          };
        }
      }
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "tool golden deny",
      caller: "cli.tool-golden",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const toolResult = events.find((event) => event.kind === "model.tool.result");
    assert.ok(toolResult);
    const feedback = (toolResult!.data as { feedback?: ToolResultFeedback }).feedback;
    assert.ok(feedback);
    assert.equal(feedback.schemaVersion, "1.0.0");
    assert.equal(feedback.status, "denied");
    assert.equal(feedback.continuation, "continue");
    assert.equal(feedback.diagnostics[0]?.code, "KERNEL_POLICY_DENIED");
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    await kernel.shutdown();
  });
});

class OneToolThenFinishModelGateway implements ModelGateway {
  constructor(private readonly name: string, private readonly input: JsonObject) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.messages?.some((message) => message.role === "tool")) {
      yield { kind: "delta", text: "tool turn resolved" };
      yield { kind: "usage", inputTokens: 3, outputTokens: 4 };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "tool-call", id: "call-golden", name: this.name, input: this.input };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}
