import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { glmAnthropicLiveCredentialProcessEnv } from "@deepseek/credential-auth-management";
import { FetchModelProviderTransport, GlmAnthropicProvider, StaticCredentialProvider, defaultGlmAnthropicProfile, glmAnthropicCredentialRef } from "@deepseek/model-gateway";
import type { RuntimeEvent, ToolResultFeedback } from "@deepseek/platform-contracts";
import { NodePlatformRuntime } from "@deepseek/platform-abstraction";
import { createDefaultRuntimeKernel, registerRuntimeCoreTools, runAgentLoop } from "@deepseek/runtime";
import { createLiveCliDependencies } from "@deepseek/testing-regression";

describe("GLM Anthropic-compatible live agent tool-loop smoke", () => {
  it("runs a live GLM tool turn only when explicitly enabled", async (testContext) => {
    if (process.env.GLM_ANTHROPIC_LIVE_AGENT_TOOL_TESTS !== "1") {
      testContext.skip("Set GLM_ANTHROPIC_LIVE_AGENT_TOOL_TESTS=1 to run live GLM agent-tool smoke.");
      return;
    }

    const platform = new NodePlatformRuntime();
    const env = await glmAnthropicLiveCredentialProcessEnv(platform);
    const token = firstNonEmpty(env.GLM_ANTHROPIC_API_KEY, env.ZHIPU_API_KEY);
    if (!token) {
      testContext.skip("Set GLM_ANTHROPIC_API_KEY or ZHIPU_API_KEY in environment or .env to run live GLM agent-tool smoke.");
      return;
    }

    const workspaceRoot = process.cwd();
    const deps = {
      ...createLiveCliDependencies({
        workspaceRoot,
        timeoutMs: 90_000
      }),
      models: new GlmAnthropicProvider({
        credentials: new StaticCredentialProvider(token, glmAnthropicCredentialRef),
        transport: new FetchModelProviderTransport(),
        timeoutMs: 90_000
      })
    };
    await registerRuntimeCoreTools(deps, workspaceRoot);
    const kernel = await createDefaultRuntimeKernel(deps);
    const events: RuntimeEvent[] = [];

    try {
      for await (const event of runAgentLoop(deps, kernel, {
        prompt: "You must call core_file_read with path README.md before answering. Then reply with one short sentence.",
        caller: "live.glm-agent-tool.test",
        workspaceRoot,
        outputMode: "jsonl",
        profile: {
          ...defaultGlmAnthropicProfile,
          providerOptions: { max_tokens: 512 }
        },
        reasoning: { enabled: false },
        live: true,
        timeoutMs: 90_000,
        limits: { maxModelIterations: 3, maxToolCalls: 3 }
      })) {
        events.push(event);
      }
    } finally {
      await kernel.shutdown("live-glm-agent-tool-smoke");
    }

    const kinds = events.map((event) => event.kind);
    const feedback = events
      .find((event) => event.kind === "model.tool.result")
      ?.data as { feedback?: ToolResultFeedback } | undefined;
    const redactedKinds = JSON.stringify(kinds);

    assert.equal(kinds.includes("model.requested"), true, redactedKinds);
    assert.equal(kinds.includes("model.tool.intent"), true, JSON.stringify(redactEvents(events)));
    assert.equal(kinds.includes("model.tool.result"), true, JSON.stringify(redactEvents(events)));
    assert.equal(kinds.includes("agent.loop.completed"), true, JSON.stringify(redactEvents(events)));
    assert.equal(feedback?.feedback?.schemaVersion, "1.0.0");
    assert.equal(feedback?.feedback.status, "success", JSON.stringify(redactEvents(events)));

    const serialized = JSON.stringify(redactEvents(events));
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes("x-api-key"), false);
    assert.equal(serialized.includes("Bearer "), false);
    assert.equal(serialized.includes("Fake file not found"), false, "live smoke must run against the real filesystem, not the fake platform");
  });
});

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

function redactEvents(events: readonly RuntimeEvent[]): readonly unknown[] {
  return events.map((event) => {
    if (event.kind === "model.delta") return { kind: event.kind, textLength: String(event.data.delta ?? "").length };
    if (event.kind === "model.tool.intent") return { kind: event.kind, name: event.data.name };
    if (event.kind === "model.tool.result") return { kind: event.kind, terminalKind: event.data.terminalKind };
    if (event.kind === "agent.loop.completed") return { kind: event.kind, status: event.data.status };
    if (event.kind === "agent.loop.failed") return { kind: event.kind };
    return { kind: event.kind };
  });
}
