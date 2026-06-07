import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createModelGatewayFamilyCapabilities,
  DeepSeekOpenAIProvider,
  DeterministicMockModelGateway,
  FetchModelProviderTransport,
  FixtureModelProviderTransport,
  GlmAnthropicProvider,
  StaticCredentialProvider,
  defaultDeepSeekProfile,
  defaultGlmAnthropicProfile,
  deepSeekOpenAIProviderConfig,
  glmAnthropicProviderConfig,
  createGlmAnthropicChunkNormalizer,
  estimateModelUsageCostMicros,
  normalizeGlmAnthropicChunk,
  normalizeDeepSeekChunk,
  parseDeepSeekJsonOutputResponse,
  resolveModelMetadata,
  validateDeepSeekAnthropicMessagesRequest,
  validateDeepSeekJsonOutputRequest,
  validateDeepSeekStrictToolSchema
} from "../src/index.js";
import { asId } from "@deepseek/platform-contracts";
import { InMemoryCapabilityRegistry } from "@deepseek/capability-registry";
import type { CredentialRef, ModelRequest, ModelStreamEvent } from "@deepseek/platform-contracts";

async function collect(iterable: AsyncIterable<ModelStreamEvent>): Promise<readonly ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("DeepSeek OpenAI provider", () => {
  it("fails closed when transport is not configured", async () => {
    const provider = new DeepSeekOpenAIProvider({ credentials: new StaticCredentialProvider("sk-test") });
    const events = await collect(provider.stream({ profile: defaultDeepSeekProfile, prompt: "hello" }));

    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "error");
    assert.equal(events[0]?.kind === "error" ? events[0].error.code : "", "PROVIDER_TRANSPORT_NOT_CONFIGURED");
  });

  it("fails closed when credential is missing", async () => {
    const transport = new FixtureModelProviderTransport([]);
    const provider = new DeepSeekOpenAIProvider({ transport });
    const events = await collect(provider.stream({ profile: defaultDeepSeekProfile, prompt: "hello" }));

    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "error");
    assert.equal(events[0]?.kind === "error" ? events[0].error.code : "", "PROVIDER_CREDENTIAL_MISSING");
    assert.equal(transport.requests.length, 0);
  });

  it("builds a DeepSeek chat-completions request with injected credential and options", async () => {
    const transport = new FixtureModelProviderTransport([]);
    const provider = new DeepSeekOpenAIProvider({ transport, credentials: new StaticCredentialProvider("sk-test"), timeoutMs: 1234 });
    const events = await collect(provider.stream({
      profile: { ...defaultDeepSeekProfile, temperature: 0.2 },
      prompt: "write tests",
      reasoning: { enabled: true, effort: "high" },
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            parameters: { type: "object" }
          }
        }
      ]
    }));

    assert.equal(events.at(-1)?.kind, "done");
    assert.equal(transport.requests.length, 1);
    const request = transport.requests[0];
    assert.equal(request?.url, "https://api.deepseek.com/chat/completions");
    assert.equal(request?.method, "POST");
    assert.equal(request?.headers.authorization, "Bearer sk-test");
    assert.equal(request?.timeoutMs, 1234);
    assert.equal(request?.body.model, "deepseek-v4-flash");
    assert.equal(request?.body.temperature, 0.2);
    assert.equal(Array.isArray(request?.body.messages), true);
    assert.equal((request?.body.messages as readonly { readonly content: string }[])[0]?.content, "write tests");
    assert.equal(Array.isArray(request?.body.tools), true);
    assert.deepEqual(request?.body.thinking, { type: "enabled" });
    assert.equal(request?.body.reasoning_effort, "high");
  });

  it("normalizes DeepSeek thinking effort options to the provider-supported values", () => {
    const provider = new DeepSeekOpenAIProvider({
      transport: new FixtureModelProviderTransport([]),
      credentials: new StaticCredentialProvider("sk-test")
    });

    const low = provider.buildProviderRequest({
      profile: defaultDeepSeekProfile,
      prompt: "low",
      reasoning: { enabled: true, effort: "low" }
    }, "sk-test");
    const medium = provider.buildProviderRequest({
      profile: defaultDeepSeekProfile,
      prompt: "medium",
      reasoning: { enabled: true, effort: "medium" }
    }, "sk-test");
    const xhigh = provider.buildProviderRequest({
      profile: defaultDeepSeekProfile,
      prompt: "xhigh",
      reasoning: { enabled: true, effort: "xhigh" }
    }, "sk-test");
    const mapped = provider.buildProviderRequest({
      profile: defaultDeepSeekProfile,
      prompt: "mapped",
      reasoning: { enabled: true, effort: "xhigh", providerEffort: "max" }
    }, "sk-test");
    const disabled = provider.buildProviderRequest({
      profile: defaultDeepSeekProfile,
      prompt: "disabled",
      reasoning: { enabled: false, effort: "xhigh", providerEffort: "max" }
    }, "sk-test");

    assert.equal(low.body.reasoning_effort, "high");
    assert.equal(medium.body.reasoning_effort, "high");
    assert.equal(xhigh.body.reasoning_effort, "max");
    assert.equal(mapped.body.reasoning_effort, "max");
    assert.deepEqual(disabled.body.thinking, { type: "disabled" });
    assert.equal("reasoning_effort" in disabled.body, false);
  });

  it("adds DeepSeek JSON mode only when request guardrails are satisfied", () => {
    const provider = new DeepSeekOpenAIProvider({
      transport: new FixtureModelProviderTransport([]),
      credentials: new StaticCredentialProvider("sk-test")
    });
    const ok = provider.buildProviderRequest({
      profile: defaultDeepSeekProfile,
      prompt: "Return a JSON object with a single ok boolean.",
      output: { format: "json_object", maxParseRetries: 1 }
    }, "sk-test");
    const blocked = provider.buildProviderRequest({
      profile: defaultDeepSeekProfile,
      prompt: "Return a single ok boolean.",
      output: { format: "json_object" }
    }, "sk-test");

    assert.deepEqual(validateDeepSeekJsonOutputRequest({ prompt: "Return JSON.", output: { format: "json_object" } }).diagnostics, []);
    assert.equal(validateDeepSeekJsonOutputRequest({ prompt: "Return object.", output: { format: "json_object" } }).ok, false);
    assert.deepEqual(ok.body.response_format, { type: "json_object" });
    assert.equal("response_format" in blocked.body, false);
  });

  it("verifies DeepSeek JSON output parsing and retryable failure states", () => {
    const parsed = parseDeepSeekJsonOutputResponse("{\"ok\":true}", "stop");
    const invalid = parseDeepSeekJsonOutputResponse("not json", "stop");
    const truncated = parseDeepSeekJsonOutputResponse("{\"ok\":true}", "length");

    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.value, { ok: true });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.retryable, true);
    assert.equal(invalid.diagnostics[0]?.code, "DEEPSEEK_JSON_RESPONSE_PARSE_FAILED");
    assert.equal(truncated.ok, false);
    assert.equal(truncated.diagnostics[0]?.code, "DEEPSEEK_JSON_RESPONSE_TRUNCATED");
  });

  it("builds strict beta tool-schema requests only after schema validation", () => {
    const provider = new DeepSeekOpenAIProvider({
      transport: new FixtureModelProviderTransport([]),
      credentials: new StaticCredentialProvider("sk-test")
    });
    const tools = [{
      type: "function",
      function: {
        name: "search",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { query: { type: "string" } },
          required: ["query"]
        }
      }
    }];
    const strict = provider.buildStrictToolSchemaProviderRequest({
      profile: defaultDeepSeekProfile,
      prompt: "search",
      tools
    }, "sk-test");
    const invalid = validateDeepSeekStrictToolSchema([{
      type: "function",
      function: {
        name: "bad",
        parameters: { type: "object", oneOf: [{ required: ["a"] }, { required: ["b"] }] }
      }
    }]);

    assert.equal(strict.validation.ok, true);
    assert.equal(strict.request?.url, "https://api.deepseek.com/beta/chat/completions");
    const requestTools = strict.request?.body.tools as readonly { readonly function?: { readonly strict?: boolean } }[] | undefined;
    assert.equal(requestTools?.[0]?.function?.strict, true);
    assert.equal(invalid.ok, false);
    assert.deepEqual(invalid.unsupportedKeywordPaths, ["tools[0].function.parameters.oneOf"]);
  });

  it("builds DeepSeek beta prefix, FIM, and Anthropic-compatible request lanes", () => {
    const provider = new DeepSeekOpenAIProvider({
      transport: new FixtureModelProviderTransport([]),
      credentials: new StaticCredentialProvider("sk-test")
    });

    const prefix = provider.buildChatPrefixCompletionProviderRequest({
      profile: defaultDeepSeekProfile,
      prompt: "Write a JSON answer.",
      prefix: "{\"answer\":",
      reasoning: { enabled: true, providerEffort: "max" }
    }, "sk-test");
    const fim = provider.buildFimCompletionProviderRequest({
      profile: defaultDeepSeekProfile,
      prompt: "function add(a, b) {",
      suffix: "}",
      maxTokens: 64
    }, "sk-test");
    const anthropic = provider.buildAnthropicMessagesProviderRequest({
      profile: defaultDeepSeekProfile,
      maxTokens: 128,
      messages: [{ role: "user", content: "hello" }],
      reasoning: { enabled: true, effort: "xhigh" }
    }, "sk-test");

    assert.equal(prefix.url, "https://api.deepseek.com/beta/chat/completions");
    const prefixMessages = prefix.body.messages as readonly { readonly prefix?: boolean; readonly content?: string }[];
    assert.equal(prefixMessages.at(-1)?.prefix, true);
    assert.equal(prefixMessages.at(-1)?.content, "{\"answer\":");
    assert.equal(prefix.body.reasoning_effort, "max");
    assert.equal(fim.url, "https://api.deepseek.com/beta/completions");
    assert.equal(fim.body.suffix, "}");
    assert.equal(fim.body.max_tokens, 64);
    assert.equal(anthropic.validation.ok, true);
    assert.equal(anthropic.request?.url, "https://api.deepseek.com/anthropic/messages");
    assert.equal(anthropic.request?.headers["anthropic-version"], "2023-06-01");
    assert.deepEqual(anthropic.request?.body.output_config, { effort: "max" });
    assert.equal(validateDeepSeekAnthropicMessagesRequest({
      profile: defaultDeepSeekProfile,
      maxTokens: 0,
      messages: [{ role: "tool", content: "unsupported" }]
    }).ok, false);
  });

  it("preserves provider tool names and downgrades unpaired internal tool feedback", async () => {
    const transport = new FixtureModelProviderTransport([]);
    const provider = new DeepSeekOpenAIProvider({ transport, credentials: new StaticCredentialProvider("sk-test") });
    await collect(provider.stream({
      profile: defaultDeepSeekProfile,
      prompt: "read",
      messages: [
        { role: "user", content: "read" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "core_file_read", input: { path: "README.md" } }] },
        { role: "tool", content: "read result", toolCallId: "call-1", toolName: "core.file.read" },
        { role: "tool", content: "repair feedback", toolCallId: "repair-1", toolName: "agent.self-repair" }
      ]
    }));

    const messages = transport.requests[0]?.body.messages as readonly {
      readonly role: string;
      readonly content?: string | null;
      readonly tool_call_id?: string;
      readonly tool_calls?: readonly { readonly function?: { readonly name?: string } }[];
    }[] | undefined;
    assert.equal(messages?.[1]?.role, "assistant");
    assert.equal(messages?.[1]?.content, null);
    assert.equal(messages?.[1]?.tool_calls?.[0]?.function?.name, "core_file_read");
    assert.equal(messages?.[2]?.role, "tool");
    assert.equal(messages?.[2]?.tool_call_id, "call-1");
    assert.equal(messages?.[3]?.role, "user");
    assert.match(messages?.[3]?.content ?? "", /Internal tool feedback \(agent\.self-repair\)/);
  });

  it("normalizes reasoning, text, tool calls, usage/cache, finish, and done", async () => {
    const transport = new FixtureModelProviderTransport([
      {
        data: {
          id: "req-1",
          choices: [
            {
              delta: {
                reasoning_content: "I should inspect context.",
                content: "Done",
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: "{\"path\":\"package.json\"}"
                    }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            prompt_cache_hit_tokens: 7,
            prompt_cache_miss_tokens: 3,
            completion_tokens_details: {
              reasoning_tokens: 2
            }
          }
        }
      }
    ]);
    const provider = new DeepSeekOpenAIProvider({ transport, credentials: new StaticCredentialProvider("sk-test") });
    const events = await collect(provider.stream({ profile: defaultDeepSeekProfile, prompt: "hello" }));

    assert.deepEqual(events.map((event) => event.kind), ["reasoning", "delta", "tool-call", "finish", "usage", "done"]);
    const reasoning = events[0];
    assert.equal(reasoning?.kind === "reasoning" ? reasoning.text : "", "I should inspect context.");
    assert.equal(reasoning?.kind === "reasoning" ? reasoning.redaction.class : "", "internal");
    const delta = events[1];
    assert.equal(delta?.kind === "delta" ? delta.text : "", "Done");
    const toolCall = events[2];
    assert.equal(toolCall?.kind === "tool-call" ? toolCall.id : "", "call-1");
    assert.equal(toolCall?.kind === "tool-call" ? toolCall.name : "", "read_file");
    assert.deepEqual(toolCall?.kind === "tool-call" ? toolCall.input : {}, { path: "package.json" });
    const finish = events[3];
    assert.equal(finish?.kind === "finish" ? finish.reason : "", "tool-call");
    const usage = events[4];
    assert.equal(usage?.kind === "usage" ? usage.inputTokens : 0, 10);
    assert.equal(usage?.kind === "usage" ? usage.outputTokens : 0, 5);
    assert.deepEqual(usage?.kind === "usage" ? usage.metadata?.cache : undefined, { hitTokens: 7, missTokens: 3 });
    assert.equal(usage?.kind === "usage" ? usage.metadata?.reasoningTokens : undefined, 2);
    assert.equal(events.every((event) => event.kind !== "tool-call" || event.provider?.provider === "deepseek"), true);
  });

  it("attaches normalized cache usage to request pipeline fingerprints", async () => {
    const transport = new FixtureModelProviderTransport([
      {
        data: {
          choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            prompt_cache_hit_tokens: 7,
            prompt_cache_miss_tokens: 3
          }
        }
      }
    ]);
    const provider = new DeepSeekOpenAIProvider({ transport, credentials: new StaticCredentialProvider("sk-test") });
    const events = await collect(provider.stream({
      profile: defaultDeepSeekProfile,
      prompt: "hello",
      metadata: {
        contextPipeline: {
          pipelineFingerprint: "pipeline:test"
        }
      }
    }));

    const usage = events.find((event) => event.kind === "usage");
    assert.equal(usage?.kind === "usage" ? usage.metadata?.cache?.status : undefined, "available");
    assert.equal(usage?.kind === "usage" ? usage.metadata?.cache?.pipelineFingerprint : undefined, "pipeline:test");
    assert.equal(usage?.kind === "usage" ? usage.metadata?.cache?.hitRate : undefined, 0.7);
  });

  it("marks provider cache metrics unavailable when a fingerprint has no cache counts", async () => {
    const transport = new FixtureModelProviderTransport([
      {
        data: {
          choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2
          }
        }
      }
    ]);
    const provider = new DeepSeekOpenAIProvider({ transport, credentials: new StaticCredentialProvider("sk-test") });
    const events = await collect(provider.stream({
      profile: defaultDeepSeekProfile,
      prompt: "hello",
      metadata: { contextPipeline: { pipelineFingerprint: "pipeline:test" } }
    }));

    const usage = events.find((event) => event.kind === "usage");
    assert.equal(usage?.kind === "usage" ? usage.metadata?.cache?.status : undefined, "unavailable");
    assert.equal(usage?.kind === "usage" ? usage.metadata?.cache?.pipelineFingerprint : undefined, "pipeline:test");
    assert.equal(usage?.kind === "usage" ? usage.metadata?.cache?.hitTokens : undefined, undefined);
  });

  it("projects provider cache hints only when capability metadata supports them", async () => {
    const metadata = {
      contextPipeline: {
        pipelineFingerprint: "pipeline:test",
        cacheHintSummary: {
          stable: 2,
          ephemeral: 1,
          noStore: 0,
          ttlBound: 0
        }
      }
    };
    const unsupportedTransport = new FixtureModelProviderTransport([{ data: { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] } }]);
    const unsupported = new DeepSeekOpenAIProvider({ transport: unsupportedTransport, credentials: new StaticCredentialProvider("sk-test") });
    await collect(unsupported.stream({ profile: defaultDeepSeekProfile, prompt: "hello", metadata }));

    assert.equal(unsupportedTransport.requests[0]?.body.cache_control, undefined);

    const supportedTransport = new FixtureModelProviderTransport([{ data: { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] } }]);
    const supported = new DeepSeekOpenAIProvider({
      transport: supportedTransport,
      credentials: new StaticCredentialProvider("sk-test"),
      config: {
        ...deepSeekOpenAIProviderConfig,
        cacheHints: {
          explicitPrefixCacheHints: true,
          supportedPolicies: ["stable", "ephemeral"],
          maxCacheHintBlocks: 8
        }
      }
    });
    await collect(supported.stream({ profile: defaultDeepSeekProfile, prompt: "hello", metadata }));

    assert.deepEqual(supportedTransport.requests[0]?.body.cache_control, {
      type: "deepseek-prefix-cache",
      pipeline_fingerprint: "pipeline:test",
      stable_blocks: 2,
      ephemeral_blocks: 1,
      no_store_blocks: 0,
      ttl_blocks: 0,
      max_hint_blocks: 8
    });
  });

  it("normalizes provider error chunks and transport failures", async () => {
    const errorEvents = normalizeDeepSeekChunk(
      {
        data: {
          error: {
            code: "invalid_request_error",
            message: "bad request"
          }
        }
      },
      { provider: "deepseek", protocol: "openai-chat-completions", model: "deepseek-v4-flash" }
    );
    assert.equal(errorEvents[0]?.kind, "error");
    assert.equal(errorEvents[0]?.kind === "error" ? errorEvents[0].error.code : "", "invalid_request_error");

    const provider = new DeepSeekOpenAIProvider({
      transport: new FixtureModelProviderTransport([], new Error("network down")),
      credentials: new StaticCredentialProvider("sk-test")
    });
    const events = await collect(provider.stream({ profile: defaultDeepSeekProfile, prompt: "hello" }));
    assert.equal(events[0]?.kind, "error");
    assert.equal(events[0]?.kind === "error" ? events[0].error.code : "", "PROVIDER_TRANSPORT_FAILED");
  });

  it("parses OpenAI-style SSE chunks through fetch transport", async () => {
    const originalFetch = globalThis.fetch;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    globalThis.fetch = async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    try {
      const transport = new FetchModelProviderTransport();
      const chunks = [];
      for await (const chunk of transport.stream({
        url: "https://api.deepseek.com/chat/completions",
        method: "POST",
        headers: { authorization: "Bearer sk-test" },
        body: { model: "deepseek-v4-flash", messages: [] }
      })) {
        chunks.push(chunk);
      }

      assert.deepEqual(chunks, [{ data: { choices: [{ delta: { content: "Hi" } }] } }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes OpenAI SDK non-stream completion shape", () => {
    const events = normalizeDeepSeekChunk(
      {
        data: {
          id: "chatcmpl-sdk",
          choices: [
            {
              message: {
                content: "ok"
              },
              finish_reason: "stop"
            }
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1
          }
        }
      },
      { provider: "deepseek", protocol: "openai-chat-completions", model: "deepseek-v4-pro" }
    );

    assert.deepEqual(events.map((event) => event.kind), ["delta", "finish", "usage"]);
    assert.equal(events[0]?.kind === "delta" ? events[0].text : "", "ok");
  });

  it("resolves model metadata with audited fallback and no fabricated cost", async () => {
    const fresh = await resolveModelMetadata({
      provider: "deepseek",
      model: defaultDeepSeekProfile.model,
      remoteCatalog: async () => [{
        provider: "deepseek",
        model: defaultDeepSeekProfile.model,
        source: "remote",
        pricing: {
          inputCostMicrosPerMillionTokens: 20_000,
          outputCostMicrosPerMillionTokens: 60_000
        }
      }]
    });
    const priced = estimateModelUsageCostMicros({ inputTokens: 1_000, outputTokens: 500 }, fresh);

    assert.equal(fresh.status, "resolved");
    assert.equal(fresh.freshness, "fresh");
    assert.equal(fresh.diagnostics.length, 0);
    assert.equal(priced.reliability, "priced");
    assert.equal(priced.costMicros, 50);
    assert.equal(priced.source, "remote");

    const fallback = await resolveModelMetadata({
      provider: "deepseek",
      model: defaultDeepSeekProfile.model,
      remoteCatalog: async () => {
        throw new Error("metadata fetch failed");
      },
      pinnedCatalog: [{
        provider: "deepseek",
        model: defaultDeepSeekProfile.model,
        source: "pinned"
      }]
    });
    const unknown = estimateModelUsageCostMicros({ inputTokens: 10, outputTokens: 2 }, fallback);

    assert.equal(fallback.status, "fallback");
    assert.equal(fallback.freshness, "pinned");
    assert.equal(fallback.diagnostics[0]?.code, "MODEL_METADATA_REMOTE_UNAVAILABLE");
    assert.equal(unknown.reliability, "unknown");
    assert.equal(unknown.costMicros, undefined);
    assert.equal(unknown.diagnostics[0]?.code, "MODEL_USAGE_COST_UNKNOWN");
  });

  it("marks stale last-known-good model metadata as a stale estimate", async () => {
    const stale = await resolveModelMetadata({
      provider: "deepseek",
      model: "deepseek-stale",
      remoteCatalog: async () => [],
      lastKnownGoodCatalog: [{
        provider: "deepseek",
        model: "deepseek-stale",
        source: "last-known-good",
        expiresAt: "2026-01-01T00:00:00.000Z",
        pricing: {
          inputCostMicrosPerMillionTokens: 10_000,
          outputCostMicrosPerMillionTokens: 10_000
        }
      }],
      now: new Date("2026-05-17T00:00:00.000Z")
    });
    const estimate = estimateModelUsageCostMicros({ inputTokens: 100, outputTokens: 100 }, stale);

    assert.equal(stale.status, "fallback");
    assert.equal(stale.freshness, "stale");
    assert.equal(stale.diagnostics[0]?.code, "MODEL_METADATA_REMOTE_MODEL_MISSING");
    assert.equal(estimate.reliability, "stale-estimate");
    assert.equal(estimate.costMicros, 2);
  });

  it("keeps deterministic mock gateway behavior available", async () => {
    const gateway = new DeterministicMockModelGateway();
    const events = await collect(gateway.stream({ profile: defaultDeepSeekProfile, prompt: "hello world" }));

    assert.deepEqual(events.map((event) => event.kind), ["delta", "usage", "finish", "done"]);
    assert.equal(events[1]?.kind === "usage" ? events[1].inputTokens : 0, 2);
  });

  it("passes live verification credential and timeout controls to provider requests", async () => {
    const transport = new FixtureModelProviderTransport([{ data: { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] } }]);
    const requestedRef = asId<"credentialRef">("credential-deepseek-custom");
    const provider = new DeepSeekOpenAIProvider({
      transport,
      credentials: {
        async resolve(ref: CredentialRef, _request: ModelRequest) {
          return { ref, value: ref === requestedRef ? "sk-custom" : "sk-wrong", redaction: { class: "secret" } };
        }
      }
    });

    const result = await provider.verify?.({ profile: defaultDeepSeekProfile, credentialRef: requestedRef, prompt: "ok", timeoutMs: 4321 });

    assert.equal(result?.ok, true);
    assert.equal(transport.requests[0]?.headers.authorization, "Bearer sk-custom");
    assert.equal(transport.requests[0]?.timeoutMs, 4321);
  });

  it("exposes fake-first web/data and image family capabilities without provider-native claims", async () => {
    const capabilities = createModelGatewayFamilyCapabilities({ maxItems: 3 });
    const registry = new InMemoryCapabilityRegistry();
    for (const capability of capabilities) await registry.register(capability.manifest, capability.execute);

    const media = await registry.listModelVisible({ allowedDomainIds: ["media-images"], allowedProviderSupport: ["fake"] });
    assert.deepEqual(media.map((entry) => entry.toolFamily?.familyId).sort(), ["image.edit", "image.generate", "image.inspect", "image.search-stock"]);

    const extract = await capabilities.find((entry) => entry.manifest.toolFamily?.familyId === "web.extract")?.execute({
      url: "https://example.test",
      html: "<html><title>Docs</title><body><a href=\"/a\">A TOKEN=supersecret</a><p>Hello sk-testsecret</p></body></html>"
    }, {} as never);
    const serializedExtract = JSON.stringify(extract);
    assert.equal(extract?.ok, true);
    assert.equal(serializedExtract.includes("supersecret"), false);
    assert.match(serializedExtract, /REDACTED/);

    const data = await capabilities.find((entry) => entry.manifest.toolFamily?.familyId === "web.data-lookup")?.execute({ namespace: "weather", query: "seattle" }, {} as never);
    assert.equal(data?.value?.noNetwork, true);
    assert.equal((data?.value?.rows as readonly unknown[] | undefined)?.length, 1);

    const image = await capabilities.find((entry) => entry.manifest.toolFamily?.familyId === "image.generate")?.execute({ prompt: "logo", width: 64, height: 32 }, {} as never);
    assert.equal(image?.value?.providerNativeSupport, "unsupported");
    assert.match(String((image?.value?.artifact as { artifactId?: string } | undefined)?.artifactId), /^artifact:image\.generate:/);

    const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ";
    const inspect = await capabilities.find((entry) => entry.manifest.toolFamily?.familyId === "image.inspect")?.execute({ bytesBase64: png1x1 }, {} as never);
    assert.equal((inspect?.value?.metadata as { width?: number } | undefined)?.width, 1);
    assert.equal((inspect?.value?.metadata as { height?: number } | undefined)?.height, 1);
  });
});

describe("GLM Anthropic-compatible provider", () => {
  it("fails closed when credential is missing", async () => {
    const transport = new FixtureModelProviderTransport([]);
    const provider = new GlmAnthropicProvider({ transport });
    const events = await collect(provider.stream({ profile: defaultGlmAnthropicProfile, prompt: "hello" }));

    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "error");
    assert.equal(events[0]?.kind === "error" ? events[0].error.code : "", "PROVIDER_CREDENTIAL_MISSING");
    assert.equal(transport.requests.length, 0);
  });

  it("builds an Anthropic Messages request with GLM metadata and x-api-key credentials", async () => {
    const transport = new FixtureModelProviderTransport([]);
    const provider = new GlmAnthropicProvider({
      transport,
      credentials: new StaticCredentialProvider("glm-test", glmAnthropicProviderConfig.credentialRef),
      timeoutMs: 1234
    });
    const events = await collect(provider.stream({
      profile: { ...defaultGlmAnthropicProfile, providerOptions: { max_tokens: 32 } },
      prompt: "reply ok",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "reply ok" }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "core_file_read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
          }
        }
      ],
      toolChoice: { type: "function", name: "core_file_read" }
    }));

    assert.equal(events.at(-1)?.kind, "done");
    assert.equal(transport.requests.length, 1);
    const request = transport.requests[0];
    assert.equal(request?.url, "https://open.bigmodel.cn/api/anthropic/v1/messages");
    assert.equal(request?.method, "POST");
    assert.equal(request?.headers["x-api-key"], "glm-test");
    assert.equal(request?.headers["anthropic-version"], "2023-06-01");
    assert.equal(request?.timeoutMs, 1234);
    assert.equal(request?.body.model, "glm-5.1");
    assert.equal(request?.body.max_tokens, 32);
    assert.equal(request?.body.system, "Be brief.");
    assert.deepEqual(request?.body.messages, [{ role: "user", content: "reply ok" }]);
    assert.deepEqual(request?.body.tools, [{
      name: "core_file_read",
      description: "Read a file",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    }]);
    assert.deepEqual(request?.body.tool_choice, { type: "tool", name: "core_file_read" });
  });

  it("preserves GLM provider metadata in live verification results", async () => {
    const transport = new FixtureModelProviderTransport([
      { data: { type: "message_start", message: { usage: { input_tokens: 2, output_tokens: 0 } } } },
      { data: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } } },
      { data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } } },
      { data: { type: "message_stop" } }
    ]);
    const provider = new GlmAnthropicProvider({
      transport,
      credentials: new StaticCredentialProvider("glm-test", glmAnthropicProviderConfig.credentialRef)
    });

    const result = await provider.verify?.({ profile: defaultGlmAnthropicProfile, prompt: "ok", timeoutMs: 1234 });

    assert.equal(result?.ok, true);
    assert.equal(result?.provider.provider, "glm");
    assert.equal(result?.provider.protocol, "anthropic-messages");
    assert.equal(result?.provider.model, "glm-5.1");
  });

  it("normalizes Anthropic text, tool-use, usage, finish, and done events", () => {
    const provider = { provider: "glm", protocol: "anthropic-messages" as const, model: "glm-5.1" };
    const events = [
      ...normalizeGlmAnthropicChunk({ data: { type: "message_start", message: { id: "msg-1", usage: { input_tokens: 4 } } } }, provider),
      ...normalizeGlmAnthropicChunk({ data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } }, provider),
      ...normalizeGlmAnthropicChunk({ data: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool-1", name: "core_file_read", input: {} } } }, provider),
      ...normalizeGlmAnthropicChunk({ data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"README.md\"}" } } }, provider),
      ...normalizeGlmAnthropicChunk({ data: { type: "content_block_stop", index: 1 } }, provider),
      ...normalizeGlmAnthropicChunk({ data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } } }, provider),
      ...normalizeGlmAnthropicChunk({ data: { type: "message_stop" } }, provider)
    ];

    assert.deepEqual(events.map((event) => event.kind), ["delta", "tool-call", "finish", "usage", "done"]);
    assert.equal(events[0]?.kind === "delta" ? events[0].text : "", "ok");
    assert.equal(events[1]?.kind === "tool-call" ? events[1].id : "", "tool-1");
    assert.equal(events[1]?.kind === "tool-call" ? events[1].name : "", "core_file_read");
    assert.deepEqual(events[1]?.kind === "tool-call" ? events[1].input : {}, { path: "README.md" });
    assert.equal(events[2]?.kind === "finish" ? events[2].reason : "", "tool-call");
    assert.equal(events[3]?.kind === "usage" ? events[3].inputTokens : 0, 4);
    assert.equal(events[3]?.kind === "usage" ? events[3].outputTokens : 0, 2);
    assert.equal(events.every((event) => event.kind !== "tool-call" || event.provider?.provider === "glm"), true);
  });

  it("expands GLM raw JSON tool input wrappers before runtime policy sees them", () => {
    const provider = { provider: "glm", protocol: "anthropic-messages" as const, model: "glm-5.1" };
    const events = [
      ...normalizeGlmAnthropicChunk({ data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-raw", name: "core_file_write", input: {} } } }, provider),
      ...normalizeGlmAnthropicChunk({
        data: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: "{\"raw\":\"{\\\"path\\\":\\\"generated-webpage/index.html\\\",\\\"content\\\":\\\"<h1>ok</h1>\\\"}\"}"
          }
        }
      }, provider),
      ...normalizeGlmAnthropicChunk({ data: { type: "content_block_stop", index: 0 } }, provider)
    ];

    const toolCall = events.find((event) => event.kind === "tool-call");

    assert.equal(toolCall?.kind, "tool-call");
    assert.deepEqual(toolCall?.kind === "tool-call" ? toolCall.input : {}, {
      path: "generated-webpage/index.html",
      content: "<h1>ok</h1>"
    });
  });

  it("defers GLM placeholder zero usage until the real message delta usage arrives", () => {
    const normalize = createGlmAnthropicChunkNormalizer();
    const provider = { provider: "glm", protocol: "anthropic-messages" as const, model: "glm-5.1" };
    const events = [
      ...normalize({ data: { type: "message_start", message: { id: "msg-1", usage: { input_tokens: 0, output_tokens: 0 } } } }, provider),
      ...normalize({ data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "core_file_read", input: {} } } }, provider),
      ...normalize({ data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"README.md\"}" } } }, provider),
      ...normalize({ data: { type: "content_block_stop", index: 0 } }, provider),
      ...normalize({ data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 183, output_tokens: 13, cache_read_input_tokens: 0 } } }, provider),
      ...normalize({ data: { type: "message_stop" } }, provider)
    ];

    const usageEvents = events.filter((event) => event.kind === "usage");
    assert.equal(usageEvents.length, 1);
    assert.equal(usageEvents[0]?.kind === "usage" ? usageEvents[0].inputTokens : 0, 183);
    assert.equal(usageEvents[0]?.kind === "usage" ? usageEvents[0].outputTokens : 0, 13);
    assert.deepEqual(usageEvents[0]?.kind === "usage" ? usageEvents[0].metadata?.cache : undefined, { hitTokens: 0, missTokens: 183, hitRate: 0 });
  });
});
