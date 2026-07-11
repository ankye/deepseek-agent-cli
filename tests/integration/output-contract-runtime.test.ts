import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ModelGateway, ModelRequest, ModelStreamEvent } from "@deepseek/platform-contracts";
import { collectRuntimeEvents, createDefaultRuntimeKernel, runAgentLoop } from "@deepseek/runtime";
import { defaultDeepSeekProfile } from "@deepseek/model-gateway";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";

describe("output contract runtime verification", () => {
  it("feeds required JSON contract failures into bounded self-repair", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new JsonRepairGateway();
    const loopDeps = { ...deps, models: gateway };
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Return a JSON object indicating success.",
      caller: "integration.output-contract",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      outputContract: {
        schemaVersion: "1.0.0",
        kind: "json-object",
        required: true,
        description: "success flag",
        schema: {
          type: "object",
          required: ["ok"],
          additionalProperties: false,
          properties: {
            ok: { type: "boolean" }
          }
        },
        redaction: { class: "internal", fields: ["schema"] }
      },
      selfRepair: { enabled: true, maxAttempts: 1, requireCheckpointForWrites: false, verificationMode: "minimal" },
      limits: { maxModelIterations: 3, maxRepairAttempts: 1 }
    }));

    const contractEvents = events.filter((event) => event.kind === "agent.output-contract.verified");
    const terminal = events.at(-1)?.data as { status?: string; outputContract?: { status?: string } } | undefined;

    assert.equal(contractEvents.length, 2);
    assert.equal((contractEvents[0]?.data as { status?: string }).status, "fail");
    assert.equal((contractEvents[1]?.data as { status?: string }).status, "pass");
    assert.equal(events.some((event) => event.kind === "agent.repair.started"), true);
    assert.equal(terminal?.status, "completed");
    assert.equal(terminal?.outputContract?.status, "pass");
    assert.equal(gateway.requests[0]?.prompt.includes("Task output contract:"), true);
    assert.equal(gateway.requests[0]?.output?.format, "json_object");
    assert.equal(gateway.requests[0]?.output?.strict, true);
    assert.equal(hasSelfRepairFeedback(gateway.requests[1]), true);
    await kernel.shutdown();
  });

  it("verifies file artifacts and expectations through the final verifier path", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/out.json", "{\"ok\":true}");
    await deps.platform.writeFile("/workspace/out.txt", "artifact ready");
    const loopDeps = { ...deps, models: new StaticTextGateway("done") };
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const jsonFileEvents = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Create a JSON artifact.",
      caller: "integration.output-contract",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      outputContract: {
        schemaVersion: "1.0.0",
        kind: "json-file",
        required: true,
        path: "out.json",
        schema: {
          type: "object",
          required: ["ok"],
          additionalProperties: false,
          properties: { ok: { type: "boolean" } }
        },
        verificationExpectations: [
          { schemaVersion: "1.0.0", kind: "artifact", required: true, description: "artifact exists", path: "out.json", redaction: { class: "internal" } },
          {
            schemaVersion: "1.0.0",
            kind: "schema",
            required: true,
            description: "artifact matches schema",
            path: "out.json",
            schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
            redaction: { class: "internal", fields: ["schema"] }
          },
          { schemaVersion: "1.0.0", kind: "generated-output", required: true, description: "artifact is non-empty", path: "out.json", redaction: { class: "internal" } },
          { schemaVersion: "1.0.0", kind: "check-command", required: true, description: "independent checker exits zero", command: "node --version", redaction: { class: "internal", fields: ["command"] } }
        ],
        redaction: { class: "internal", fields: ["schema", "verificationExpectations"] }
      },
      selfRepair: { enabled: true, maxAttempts: 1, requireCheckpointForWrites: false, verificationMode: "minimal" },
      limits: { maxModelIterations: 2, maxRepairAttempts: 1 }
    }));

    const jsonContract = jsonFileEvents.find((event) => event.kind === "agent.output-contract.verified")?.data as { status?: string; evidenceIds?: readonly string[] } | undefined;
    assert.equal(jsonContract?.status, "pass");
    assert.equal(jsonContract?.evidenceIds?.some((id) => id.startsWith("artifact:/workspace/out.json")), true);
    assert.equal(jsonContract?.evidenceIds?.some((id) => id.startsWith("check-command:")), true);

    const fileEvents = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "Create a text artifact.",
      caller: "integration.output-contract",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      outputContract: {
        schemaVersion: "1.0.0",
        kind: "file",
        required: true,
        path: "out.txt",
        verificationExpectations: [
          { schemaVersion: "1.0.0", kind: "generated-output", required: true, description: "text artifact is non-empty", path: "out.txt", redaction: { class: "internal" } }
        ],
        redaction: { class: "internal", fields: ["verificationExpectations"] }
      },
      selfRepair: { enabled: true, maxAttempts: 1, requireCheckpointForWrites: false, verificationMode: "minimal" },
      limits: { maxModelIterations: 2, maxRepairAttempts: 1 }
    }));

    const fileContract = fileEvents.find((event) => event.kind === "agent.output-contract.verified")?.data as { status?: string; evidenceIds?: readonly string[] } | undefined;
    assert.equal(fileContract?.status, "pass");
    assert.equal(fileContract?.evidenceIds?.some((id) => id.startsWith("file:/workspace/out.txt")), true);
    assert.equal(fileEvents.at(-1)?.kind, "agent.loop.completed");
    await kernel.shutdown("output-contract-expectations-test");
  });
});

class JsonRepairGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield { kind: "delta", text: "not json" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: "{\"ok\":true}" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class StaticTextGateway implements ModelGateway {
  constructor(private readonly text: string) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    void request;
    yield { kind: "delta", text: this.text };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
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
