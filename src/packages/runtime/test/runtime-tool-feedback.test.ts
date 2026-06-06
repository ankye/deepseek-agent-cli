import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  CapabilityExecutionContext,
  JsonObject,
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
  PolicyDecision,
  PolicyEngine,
  PolicyRequest,
  RuntimeEvent,
  ToolResultFeedback
} from "@deepseek/platform-contracts";
import {
  collectRuntimeEvents,
  createDefaultRuntimeKernel,
  registerRuntimeCoreTools,
  runtimeEchoCapability,
  runAgentLoop
} from "../src/index.js";
import { boundedModelText, toolFeedbackPreview } from "../src/model-tooling.js";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";
import { defaultDeepSeekProfile } from "@deepseek/model-gateway";

describe("agent loop typed tool feedback", () => {
  it("bounds model-facing tool text without splitting Unicode surrogate pairs", () => {
    const text = `${"a".repeat(7999)}🧠tail`;
    const bounded = boundedModelText(text, 8000);
    const preview = toolFeedbackPreview(text, 8000);

    assert.equal(Buffer.byteLength(bounded, "utf8") <= 8000, true);
    assert.equal(Buffer.byteLength(preview.text, "utf8") <= 8000, true);
    assert.equal(preview.truncated, true);
    assert.equal(hasLoneSurrogate(bounded), false);
    assert.equal(hasLoneSurrogate(preview.text), false);
  });

  it("emits a success feedback DTO when a tool execution completes", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "feedback success\n");
    const loopDeps = { ...deps, models: new OneToolThenFinishModelGateway("core.file.read", { path: "README.md" }) };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "read readme",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const feedback = readFeedback(events);
    assert.ok(feedback, "model.tool.result event should carry a typed feedback payload");
    assert.equal(feedback.schemaVersion, "1.0.0");
    assert.equal(feedback.status, "success");
    assert.equal(feedback.continuation, "continue");
    assert.equal(feedback.toolCallId, "call-runtime");
    assert.equal(feedback.toolName, "core.file.read");
    assert.equal(feedback.preview.limitBytes > 0, true);
    assert.equal(feedback.trace.traceId.length > 0, true);
    assert.equal(feedback.trace.correlationId.length > 0, true);
    await kernel.shutdown();
  });

  it("emits failed feedback when a completed capability reports failed evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.capabilities.register({
      ...runtimeEchoCapability,
      id: "runtime.failed-evidence" as typeof runtimeEchoCapability.id,
      name: "Runtime Failed Evidence",
      sideEffect: "none",
      permissions: []
    }, async () => ({
      ok: true,
      value: {
        evidence: {
          tool: "test.run",
          status: "failed",
          affectedPaths: ["/workspace"],
          preview: {
            text: "exit code 2\nmissing test file\n",
            byteLength: 30,
            lineCount: 2,
            truncated: false,
            limitBytes: 8000,
            redaction: { class: "internal" }
          },
          diagnostics: [],
          metadata: { exitCode: 2 },
          replay: {},
          redaction: { class: "internal", fields: ["preview.text", "affectedPaths"] }
        }
      }
    }));
    const loopDeps = { ...deps, models: new OneToolThenFinishModelGateway("runtime.failed-evidence", {}) };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "run a failing test",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const feedback = readFeedback(events);
    assert.ok(feedback);
    assert.equal(feedback.status, "failed");
    assert.equal(feedback.continuation, "continue");
    assert.match(feedback.preview.text, /Tool runtime\.failed-evidence reported failed/);
    assert.match(feedback.preview.text, /exit code 2/);
    await kernel.shutdown();
  });

  it("passes bounded model-requested tool timeouts into the kernel envelope", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.capabilities.register({
      ...runtimeEchoCapability,
      id: "runtime.timeout-observer" as typeof runtimeEchoCapability.id,
      name: "Runtime Timeout Observer",
      inputSchema: {
        type: "object",
        properties: {
          timeoutMs: { type: "number" }
        }
      }
    }, async (_input: JsonObject, context: CapabilityExecutionContext) => ({
      ok: true,
      value: {
        evidence: {
          tool: "timeout.observer",
          status: "completed",
          affectedPaths: [],
          preview: {
            text: `observed timeout ${context.envelope.timeoutMs}`,
            byteLength: 22,
            lineCount: 1,
            truncated: false,
            limitBytes: 8000,
            redaction: { class: "internal" }
          },
          diagnostics: [],
          metadata: { observedTimeoutMs: context.envelope.timeoutMs },
          replay: {},
          redaction: { class: "internal", fields: ["preview.text"] }
        }
      }
    }));
    const loopDeps = { ...deps, models: new OneToolThenFinishModelGateway("runtime.timeout-observer", { timeoutMs: 90_000 }) };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "run a longer tool",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { toolTimeoutMs: 120_000 }
    }));

    const completed = events.find((event) => event.kind === "capability.completed");
    const output = completed?.data.output as { evidence?: { metadata?: { observedTimeoutMs?: number } } } | undefined;
    assert.equal(output?.evidence?.metadata?.observedTimeoutMs, 90_000);
    await kernel.shutdown();
  });

  it("emits a terminal failed event when a repairable tool error happens on the final model iteration", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.capabilities.register({
      ...runtimeEchoCapability,
      id: "runtime.throwing-tool" as typeof runtimeEchoCapability.id,
      name: "Runtime Throwing Tool"
    }, async () => {
      throw new Error("simulated tool failure");
    });
    const loopDeps = { ...deps, models: new OneToolThenFinishModelGateway("runtime.throwing-tool", {}) };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "trigger a repairable tool failure",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      selfRepair: { enabled: true, maxAttempts: 1, requireCheckpointForWrites: false, verificationMode: "minimal" },
      limits: { maxModelIterations: 1, maxRepairAttempts: 1 }
    }));

    assert.equal(events.some((event) => event.kind === "agent.repair.attempt.completed"), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.failed");
    assert.equal(events.at(-1)?.data.reason, "tool-terminal-error");
    await kernel.shutdown();
  });

  it("emits a denied feedback DTO when policy rejects the tool execution", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "feedback deny\n");
    const loopDeps = { ...deps, models: new OneToolThenFinishModelGateway("core.file.read", { path: "README.md" }), policy: new DenyAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "policy denies this",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const feedback = readFeedback(events);
    assert.ok(feedback);
    assert.equal(feedback.status, "denied");
    assert.equal(feedback.diagnostics.length >= 1, true);
    assert.equal(feedback.diagnostics[0]?.code, "KERNEL_POLICY_DENIED");
    await kernel.shutdown();
  });

  it("emits a rejected feedback DTO when preflight rejects an unsafe path", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const loopDeps = { ...deps, models: new OneToolThenFinishModelGateway("core.file.read", { path: "../outside.txt" }) };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "unsafe path",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 1 }
    }));

    const feedback = readFeedback(events);
    assert.ok(feedback, "preflight rejection must still produce a typed feedback record");
    assert.equal(feedback.status, "rejected");
    assert.equal(feedback.continuation, "continue");
    assert.equal(feedback.preview.truncated, false);
    await kernel.shutdown();
  });

  it("continues after a structured tool policy failure so the model can choose a safer command", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const loopDeps = {
      ...deps,
      models: new OneToolThenFinishModelGateway("core.shell.run", {
        command: "pip3 install --break-system-packages 'numpy<2' 2>&1 | tail -5"
      }),
      policy: new AllowAllPolicyEngine()
    };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "try unsafe host package install and recover",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      live: true,
      toolProjection: "all",
      limits: { maxModelIterations: 2 }
    }));

    const feedback = readFeedback(events);
    assert.ok(feedback);
    assert.equal(feedback.status, "failed");
    assert.equal(feedback.continuation, "continue");
    assert.equal(feedback.diagnostics[0]?.details?.originalCode, "HOST_PACKAGE_INSTALL_REJECTED");
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    await kernel.shutdown();
  });

  it("continues after a tool scheduler timeout so the model can degrade or report partial verification", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.capabilities.register({
      ...runtimeEchoCapability,
      id: "runtime.timeout-tool" as typeof runtimeEchoCapability.id,
      name: "Runtime Timeout Tool"
    }, async () => {
      const error = new Error("Task cancelled: timeout");
      error.name = "SCHEDULER_TASK_TIMEOUT";
      throw error;
    });
    const loopDeps = { ...deps, models: new OneToolThenFinishModelGateway("runtime.timeout-tool", {}) };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "run a slow verification and continue",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxModelIterations: 2 }
    }));

    const feedback = readFeedback(events);
    assert.ok(feedback);
    assert.equal(feedback.status, "timeout");
    assert.equal(feedback.continuation, "continue");
    assert.equal(feedback.diagnostics[0]?.code, "KERNEL_SCHEDULER_TIMEOUT");
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    await kernel.shutdown();
  });

  it("emits a rejected feedback DTO when the tool-call limit is exceeded", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "limit test\n");
    const loopDeps = { ...deps, models: new LoopingToolCallModelGateway("core.file.read", { path: "README.md" }) };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "looping tool",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxToolCalls: 1, maxModelIterations: 3 }
    }));

    const rejectedEvent = events.find((event) => event.kind === "model.tool.rejected" && (event.data as JsonObject).reason === "tool-call-limit");
    assert.ok(rejectedEvent, "tool-call-limit rejection event is expected");
    const feedback = (rejectedEvent!.data as { feedback?: ToolResultFeedback }).feedback;
    assert.ok(feedback, "tool-call-limit rejection must include a typed feedback record");
    assert.equal(feedback.status, "rejected");
    assert.equal(feedback.continuation, "terminate");
    assert.equal(events.at(-1)?.kind, "agent.loop.failed");
    await kernel.shutdown();
  });

  it("projects only read-only tools to the model when live=true is set", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "projection\n");
    const recorder = new ToolSchemaRecordingGateway();
    const loopDeps = { ...deps, models: recorder };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "tell me a file",
      caller: "runtime.projection.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      live: true,
      limits: { maxModelIterations: 1 }
    }));

    const sideEffects = new Set(recorder.observedSideEffects);
    assert.equal(sideEffects.has("read"), true);
    assert.equal(sideEffects.has("write"), false);
    assert.equal(sideEffects.has("process"), false);
    assert.equal(sideEffects.has("network"), false);
    await kernel.shutdown();
  });

  it("projects all tools when toolProjection is explicitly set to all", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const recorder = new ToolSchemaRecordingGateway();
    const loopDeps = { ...deps, models: recorder };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "anything",
      caller: "runtime.projection.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      live: true,
      toolProjection: "all",
      limits: { maxModelIterations: 1 }
    }));

    const sideEffects = new Set(recorder.observedSideEffects);
    assert.equal(sideEffects.has("write"), true);
    assert.equal(sideEffects.has("process"), true);
    await kernel.shutdown();
  });

  it("projects no tools when toolProjection is explicitly set to none", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const recorder = new ToolSchemaRecordingGateway();
    const loopDeps = { ...deps, models: recorder };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "return a command plan as plain JSON",
      caller: "runtime.projection.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      live: true,
      toolProjection: "none",
      limits: { maxModelIterations: 1 }
    }));

    assert.deepEqual(recorder.observedToolNames, []);
    assert.deepEqual(recorder.observedSideEffects, []);
    await kernel.shutdown();
  });

  it("continues the model loop after a denied tool feedback instead of terminating", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "deny\n");
    const loopDeps = { ...deps, models: new SingleToolCallModelGateway("core.file.read", { path: "README.md" }), policy: new DenyAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "retry please",
      caller: "runtime.feedback.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const feedback = readFeedback(events);
    assert.ok(feedback);
    assert.equal(feedback.status, "denied");
    assert.equal(feedback.continuation, "continue");
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    await kernel.shutdown();
  });

  it("projects tool manifest names through the OpenAI-safe pattern while keeping capability ids on kernel events", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "safe names\n");
    const recorder = new ToolSchemaRecordingGateway();
    const loopDeps = { ...deps, models: recorder };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "observe tool schema",
      caller: "runtime.safe-name.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      live: true,
      limits: { maxModelIterations: 1 }
    }));

    for (const name of recorder.observedToolNames) {
      assert.match(name, /^[A-Za-z0-9_-]+$/, `tool name ${name} must match OpenAI pattern`);
    }
    assert.equal(recorder.observedToolNames.includes("core_file_read"), true);
    assert.equal(recorder.observedToolNames.includes("core.file.read"), false);
    await kernel.shutdown();
  });

  it("resolves a sanitized tool-call name returned by the provider back to the real capability id", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "resolve back\n");
    const loopDeps = { ...deps, models: new SingleToolCallModelGateway("core_file_read", { path: "README.md" }) };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "sanitized name",
      caller: "runtime.safe-name.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const intent = events.find((event) => event.kind === "model.tool.intent");
    assert.equal((intent?.data as JsonObject).name, "core.file.read");
    const feedback = readFeedback(events);
    assert.equal(feedback?.status, "success");
    await kernel.shutdown();
  });

  it("keeps the provider-returned tool name in continuation history", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "provider name\n");
    const gateway = new RecordingSingleToolCallModelGateway("core_file_read", { path: "README.md" });
    const loopDeps = { ...deps, models: gateway };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "provider safe name",
      caller: "runtime.safe-name.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const intent = events.find((event) => event.kind === "model.tool.intent");
    const assistant = gateway.requests[1]?.messages?.find((message) => message.role === "assistant");
    assert.equal((intent?.data as JsonObject).name, "core.file.read");
    assert.equal(assistant?.toolCalls?.[0]?.name, "core_file_read");
    assert.equal(readFeedback(events)?.status, "success");
    await kernel.shutdown();
  });

  it("resolves mixed separator tool-call names returned by the provider back to the real capability id", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "mixed separator name\n");
    const loopDeps = { ...deps, models: new SingleToolCallModelGateway("core.file_read", { path: "README.md" }) };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "mixed separator name",
      caller: "runtime.safe-name.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const intent = events.find((event) => event.kind === "model.tool.intent");
    assert.equal((intent?.data as JsonObject).name, "core.file.read");
    const feedback = readFeedback(events);
    assert.equal(feedback?.status, "success");
    await kernel.shutdown();
  });
});

function readFeedback(events: readonly RuntimeEvent[]): ToolResultFeedback | undefined {
  const resultEvent = events.find((event) => event.kind === "model.tool.result");
  return resultEvent ? (resultEvent.data as { feedback?: ToolResultFeedback }).feedback : undefined;
}

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

class OneToolThenFinishModelGateway implements ModelGateway {
  constructor(private readonly name: string, private readonly input: JsonObject) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.messages?.some((message) => message.role === "tool")) {
      yield { kind: "delta", text: "tool turn resolved" };
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

class LoopingToolCallModelGateway implements ModelGateway {
  constructor(private readonly name: string, private readonly input: JsonObject) {}

  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { kind: "tool-call", id: "call-a", name: this.name, input: this.input };
    yield { kind: "tool-call", id: "call-b", name: this.name, input: this.input };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SingleToolCallModelGateway implements ModelGateway {
  constructor(private readonly name: string, private readonly input: JsonObject) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.messages?.some((message) => message.role === "tool")) {
      yield { kind: "delta", text: "tool outcome acknowledged" };
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

class RecordingSingleToolCallModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly name: string, private readonly input: JsonObject) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (this.requests.length > 1) {
      yield { kind: "delta", text: "tool outcome acknowledged" };
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

class DenyAllPolicyEngine implements PolicyEngine {
  async decide(_request: PolicyRequest): Promise<PolicyDecision> {
    return {
      action: "deny",
      reason: "Denied by runtime feedback test policy",
      audit: { policy: "deny-all-feedback-test" }
    };
  }
}

class AllowAllPolicyEngine implements PolicyEngine {
  async decide(request: PolicyRequest): Promise<PolicyDecision> {
    return {
      action: "allow",
      reason: "Allowed by runtime feedback test policy",
      audit: request.auditEvidence ?? { policy: "allow-all-feedback-test" }
    };
  }
}

class ToolSchemaRecordingGateway implements ModelGateway {
  readonly observedSideEffects: string[] = [];
  readonly observedToolNames: string[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    for (const tool of request.tools ?? []) {
      const fn = (tool as JsonObject).function as JsonObject | undefined;
      if (fn && typeof fn.name === "string") this.observedToolNames.push(fn.name);
      const metadata = (tool as JsonObject).metadata as JsonObject | undefined;
      const sideEffect = metadata && typeof metadata.sideEffect === "string" ? metadata.sideEffect : undefined;
      if (sideEffect) this.observedSideEffects.push(sideEffect);
    }
    yield { kind: "delta", text: "noop" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}
