import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FetchModelProviderTransport,
  GlmAnthropicProvider,
  StaticCredentialProvider,
  defaultGlmAnthropicProfile,
  glmAnthropicProviderConfig
} from "@deepseek/model-gateway";
import type { ModelStreamEvent } from "@deepseek/platform-contracts";

async function collect(iterable: AsyncIterable<ModelStreamEvent>): Promise<readonly ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function redactEvents(events: readonly ModelStreamEvent[]): readonly unknown[] {
  return events.map((event) => {
    if (event.kind === "delta") return { kind: event.kind, textLength: event.text.length, provider: event.provider?.provider, model: event.provider?.model };
    if (event.kind === "usage") return { kind: event.kind, inputTokens: event.inputTokens, outputTokens: event.outputTokens, provider: event.metadata?.provider?.provider };
    if (event.kind === "finish") return { kind: event.kind, reason: event.reason, provider: event.provider?.provider };
    if (event.kind === "error") return { kind: event.kind, code: event.error.code, retryable: event.error.retryable };
    return { kind: event.kind, provider: event.provider?.provider };
  });
}

function loadLiveToken(): string | undefined {
  return firstNonEmpty(process.env.GLM_ANTHROPIC_API_KEY, process.env.ZHIPU_API_KEY, readEnvFile(".env").GLM_ANTHROPIC_API_KEY, readEnvFile(".env").ZHIPU_API_KEY);
}

function readEnvFile(filePath: string): Record<string, string> {
  let content = "";
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return {};
  }

  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (key !== "GLM_ANTHROPIC_API_KEY" && key !== "ZHIPU_API_KEY") continue;
    values[key] = unquoteEnvValue(line.slice(separator + 1).trim());
  }
  return values;
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

describe("GLM Anthropic-compatible live provider smoke", () => {
  it("streams a real response only when explicitly enabled", async (testContext) => {
    if (process.env.GLM_ANTHROPIC_LIVE_TESTS !== "1") {
      testContext.skip("Set GLM_ANTHROPIC_LIVE_TESTS=1 to run live GLM Anthropic-compatible provider smoke.");
      return;
    }

    const token = loadLiveToken();
    if (!token) {
      testContext.skip("Set GLM_ANTHROPIC_API_KEY or ZHIPU_API_KEY in environment or .env to run live GLM smoke.");
      return;
    }

    const provider = new GlmAnthropicProvider({
      credentials: new StaticCredentialProvider(token, glmAnthropicProviderConfig.credentialRef),
      transport: new FetchModelProviderTransport(),
      timeoutMs: 90_000
    });

    const events = await collect(provider.stream({
      profile: {
        ...defaultGlmAnthropicProfile,
        providerOptions: { max_tokens: 8 }
      },
      prompt: "Reply with exactly this text: ok"
    }));
    const redacted = redactEvents(events);

    assert.equal(events.some((event) => event.kind === "delta" && event.text.trim().length > 0), true, JSON.stringify(redacted));
    assert.equal(events.some((event) => event.kind === "finish" || event.kind === "done"), true, JSON.stringify(redacted));
    assert.equal(events.some((event) => event.kind === "error"), false, JSON.stringify(redacted));
    assert.equal(JSON.stringify(redacted).includes("x-api-key"), false);
    assert.equal(JSON.stringify(redacted).includes(token), false);
  });

  it("streams a real tool-use response only when explicitly enabled", async (testContext) => {
    if (process.env.GLM_ANTHROPIC_LIVE_TESTS !== "1") {
      testContext.skip("Set GLM_ANTHROPIC_LIVE_TESTS=1 to run live GLM Anthropic-compatible provider smoke.");
      return;
    }

    const token = loadLiveToken();
    if (!token) {
      testContext.skip("Set GLM_ANTHROPIC_API_KEY or ZHIPU_API_KEY in environment or .env to run live GLM smoke.");
      return;
    }

    const provider = new GlmAnthropicProvider({
      credentials: new StaticCredentialProvider(token, glmAnthropicProviderConfig.credentialRef),
      transport: new FetchModelProviderTransport(),
      timeoutMs: 90_000
    });

    const events = await collect(provider.stream({
      profile: {
        ...defaultGlmAnthropicProfile,
        providerOptions: { max_tokens: 128 }
      },
      prompt: "Use the provided tool to read README.md. Do not answer from memory.",
      messages: [{ role: "user", content: "Use the provided tool to read README.md. Do not answer from memory." }],
      tools: [{
        type: "function",
        function: {
          name: "core_file_read",
          description: "Read a file from the current workspace by relative path.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { path: { type: "string" } },
            required: ["path"]
          }
        }
      }],
      toolChoice: { type: "function", name: "core_file_read" }
    }));
    const redacted = redactEvents(events);
    const toolCall = events.find((event) => event.kind === "tool-call");
    const usage = events.find((event) => event.kind === "usage");

    assert.equal(toolCall?.kind === "tool-call" ? toolCall.name : "", "core_file_read", JSON.stringify(redacted));
    assert.deepEqual(toolCall?.kind === "tool-call" ? toolCall.input : {}, { path: "README.md" });
    assert.equal(events.some((event) => event.kind === "finish" && event.reason === "tool-call"), true, JSON.stringify(redacted));
    assert.equal(usage?.kind === "usage" ? usage.inputTokens > 0 : false, true, JSON.stringify(redacted));
    assert.equal(usage?.kind === "usage" ? usage.outputTokens > 0 : false, true, JSON.stringify(redacted));
    assert.equal(events.some((event) => event.kind === "error"), false, JSON.stringify(redacted));
    assert.equal(JSON.stringify(redacted).includes(token), false);
  });
});
