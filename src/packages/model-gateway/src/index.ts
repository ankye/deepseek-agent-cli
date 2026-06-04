import type {
  CredentialRef,
  JsonObject,
  JsonValue,
  ModelCredentialValue,
  ModelCredentialProvider,
  ModelGateway,
  ModelLiveVerificationRequest,
  ModelLiveVerificationResult,
  ModelMetadataCatalogEntry,
  ModelMetadataCatalogSource,
  ModelMetadataFreshness,
  ModelMetadataResolution,
  ModelPricingMetadata,
  ModelProfile,
  ModelProviderRequest,
  ModelProviderResponseChunk,
  ModelProviderTransport,
  ModelRequest,
  ModelStreamEvent,
  ModelUsageCostEstimate,
  ModelUsageMetadata,
  RedactedError
} from "@deepseek/platform-contracts";
import OpenAI from "openai";
export { createModelGatewayFamilyCapabilities } from "./family-capabilities.js";
export type { ModelGatewayFamilyCapabilityOptions } from "./family-capabilities.js";
import {
  attachPipelineCacheEvidence,
  countWhitespaceTokens,
  isJsonObject,
  providerError,
  requestPipelineFingerprint,
  verifyByStreaming
} from "./shared/common.js";
export { verifyByStreaming } from "./shared/common.js";
export { validateDeepSeekAnthropicMessagesRequest } from "./providers/deepseek/anthropic/index.js";
export * from "./providers/deepseek/openai/index.js";
import {
  deepSeekOpenAICredentialRef,
  pinnedDeepSeekModelMetadataCatalog
} from "./providers/deepseek/openai/index.js";
export {
  GlmAnthropicProvider,
  createGlmAnthropicChunkNormalizer,
  defaultGlmAnthropicProfile,
  glmAnthropicCredentialRef,
  glmAnthropicProviderConfig,
  normalizeGlmAnthropicChunk
} from "./providers/glm/anthropic/index.js";
export type { GlmAnthropicProviderOptions } from "./providers/glm/anthropic/index.js";

export interface ModelMetadataResolverOptions {
  readonly provider: string;
  readonly model: string;
  readonly remoteCatalog?: () => Promise<readonly ModelMetadataCatalogEntry[]>;
  readonly lastKnownGoodCatalog?: readonly ModelMetadataCatalogEntry[];
  readonly pinnedCatalog?: readonly ModelMetadataCatalogEntry[];
  readonly now?: Date;
}

export class DeterministicMockModelGateway implements ModelGateway {
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const pipelineFingerprint = requestPipelineFingerprint(request.metadata);
    yield { kind: "delta", text: `DeepSeek mock response: ${lastUserMessageContent(request)}` };
    yield attachPipelineCacheEvidence({
      kind: "usage",
      inputTokens: await this.countTokens(request.prompt, request.profile),
      outputTokens: 6,
      metadata: {
        inputTokens: await this.countTokens(request.prompt, request.profile),
        outputTokens: 6
      }
    }, pipelineFingerprint);
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string, _profile?: ModelProfile): Promise<number> {
    return countWhitespaceTokens(text);
  }

  async verify(request: ModelLiveVerificationRequest): Promise<ModelLiveVerificationResult> {
    return verifyByStreaming(this, request);
  }
}

function lastUserMessageContent(request: ModelRequest): string {
  const messages = request.messages ?? [];
  const user = [...messages].reverse().find((message) => message.role === "user");
  return user?.content ?? request.prompt;
}

export class DeepSeekModelGatewaySkeleton implements ModelGateway {
  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield {
      kind: "error",
      error: providerError("LIVE_PROVIDER_NOT_CONFIGURED", "DeepSeek live provider adapter is intentionally deferred behind credentials and policy.", false)
    };
  }

  async countTokens(text: string, _profile?: ModelProfile): Promise<number> {
    return countWhitespaceTokens(text);
  }

  async verify(request: ModelLiveVerificationRequest): Promise<ModelLiveVerificationResult> {
    return verifyByStreaming(this, request);
  }
}

export async function resolveModelMetadata(options: ModelMetadataResolverOptions): Promise<ModelMetadataResolution> {
  const diagnostics: RedactedError[] = [];
  const now = options.now ?? new Date();
  if (options.remoteCatalog) {
    try {
      const remoteEntry = findCatalogEntry(await options.remoteCatalog(), options.provider, options.model);
      if (remoteEntry) {
        return modelMetadataResolution("resolved", "fresh", options.provider, options.model, withCatalogSource(remoteEntry, "remote"), diagnostics);
      }
      diagnostics.push(providerError("MODEL_METADATA_REMOTE_MODEL_MISSING", "Remote model metadata catalog did not include the requested model.", false, {
        provider: options.provider,
        model: options.model
      }));
    } catch (error) {
      diagnostics.push(providerError("MODEL_METADATA_REMOTE_UNAVAILABLE", "Remote model metadata catalog is unavailable; using local fallback evidence when present.", true, {
        provider: options.provider,
        model: options.model,
        cause: error instanceof Error ? error.name : "unknown"
      }));
    }
  }

  const lastKnownGoodEntry = findCatalogEntry(options.lastKnownGoodCatalog ?? [], options.provider, options.model);
  if (lastKnownGoodEntry) {
    const freshness: ModelMetadataFreshness = isCatalogEntryStale(lastKnownGoodEntry, now) ? "stale" : "cached";
    return modelMetadataResolution("fallback", freshness, options.provider, options.model, withCatalogSource(lastKnownGoodEntry, "last-known-good"), diagnostics);
  }

  const pinnedEntry = findCatalogEntry(options.pinnedCatalog ?? pinnedDeepSeekModelMetadataCatalog, options.provider, options.model);
  if (pinnedEntry) {
    return modelMetadataResolution("fallback", "pinned", options.provider, options.model, withCatalogSource(pinnedEntry, "pinned"), diagnostics);
  }

  diagnostics.push(providerError("MODEL_METADATA_UNAVAILABLE", "No model metadata catalog entry is available; token usage remains real but cost and context metadata are unknown.", false, {
    provider: options.provider,
    model: options.model
  }));
  return modelMetadataResolution("unavailable", "unavailable", options.provider, options.model, undefined, diagnostics);
}

export function estimateModelUsageCostMicros(usage: ModelUsageMetadata, metadata: ModelMetadataResolution): ModelUsageCostEstimate {
  const diagnostics: RedactedError[] = [];
  const pricing = metadata.entry?.pricing;
  if (!pricing) {
    diagnostics.push(providerError("MODEL_USAGE_COST_UNKNOWN", "Model usage cost cannot be estimated without explicit pricing metadata.", false, {
      provider: metadata.provider,
      model: metadata.model,
      metadataStatus: metadata.status
    }));
    return { reliability: "unknown", diagnostics };
  }

  const inputCost = estimateInputCostMicros(usage, pricing);
  const outputRate = pricing.outputCostMicrosPerMillionTokens;
  const outputCost = outputRate === undefined && usage.outputTokens > 0
    ? undefined
    : (usage.outputTokens * (outputRate ?? 0)) / 1_000_000;
  if (inputCost === undefined || outputCost === undefined) {
    diagnostics.push(providerError("MODEL_USAGE_COST_PRICING_INCOMPLETE", "Model pricing metadata is incomplete for the reported token usage.", false, {
      provider: metadata.provider,
      model: metadata.model,
      metadataStatus: metadata.status
    }));
    return { reliability: "unknown", source: metadata.entry.source, diagnostics };
  }

  return {
    reliability: metadata.freshness === "stale" ? "stale-estimate" : "priced",
    costMicros: Math.round(inputCost + outputCost),
    source: metadata.entry.source,
    diagnostics
  };
}

export class StaticCredentialProvider implements ModelCredentialProvider {
  constructor(private readonly value: string, private readonly ref: CredentialRef = deepSeekOpenAICredentialRef) {}

  async resolve(): Promise<ModelCredentialValue> {
    return {
      ref: this.ref,
      value: this.value,
      redaction: { class: "secret" }
    };
  }
}

export class FixtureModelProviderTransport implements ModelProviderTransport {
  readonly requests: ModelProviderRequest[] = [];

  constructor(private readonly chunks: readonly ModelProviderResponseChunk[] = [], private readonly failure?: Error) {}

  async *stream(request: ModelProviderRequest): AsyncIterable<ModelProviderResponseChunk> {
    this.requests.push(request);
    if (this.failure) throw this.failure;
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }
}

export class FetchModelProviderTransport implements ModelProviderTransport {
  async *stream(request: ModelProviderRequest, options?: { signal?: AbortSignal }): AsyncIterable<ModelProviderResponseChunk> {
    const init: RequestInit = {
      method: request.method,
      headers: request.headers as Record<string, string>,
      body: JSON.stringify(request.body)
    };
    const signals: AbortSignal[] = [];
    if (request.timeoutMs) signals.push(AbortSignal.timeout(request.timeoutMs));
    if (options?.signal) signals.push(options.signal);
    if (signals.length === 1) {
      const only = signals[0];
      if (only) init.signal = only;
    } else if (signals.length > 1) {
      init.signal = AbortSignal.any(signals);
    }
    const response = await fetch(request.url, init);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`DeepSeek provider HTTP ${response.status}: ${redactProviderErrorBody(body)}`);
    }

    if (!response.body) {
      throw new Error("DeepSeek provider response body is empty.");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseServerSentEventLine(line);
        if (parsed) yield parsed;
      }
    }

    buffer += decoder.decode();
    for (const line of buffer.split(/\r?\n/)) {
      const parsed = parseServerSentEventLine(line);
      if (parsed) yield parsed;
    }
  }
}

export class OpenAIModelProviderTransport implements ModelProviderTransport {
  async *stream(request: ModelProviderRequest, options?: { signal?: AbortSignal }): AsyncIterable<ModelProviderResponseChunk> {
    const apiKey = authorizationBearerToken(request.headers.authorization);
    if (!apiKey) {
      throw new Error("DeepSeek provider credential is missing.");
    }

    const client = new OpenAI({
      apiKey,
      baseURL: baseUrlFromRequestUrl(request.url),
      timeout: request.timeoutMs
    });

    const createParams = options?.signal
      ? await client.chat.completions.create(request.body as never, { signal: options.signal })
      : await client.chat.completions.create(request.body as never);
    if (isAsyncIterable(createParams)) {
      for await (const chunk of createParams) {
        yield { data: chunk as unknown as JsonObject };
      }
      return;
    }

    yield { data: createParams as unknown as JsonObject };
  }
}

function findCatalogEntry(catalog: readonly ModelMetadataCatalogEntry[], provider: string, model: string): ModelMetadataCatalogEntry | undefined {
  return catalog.find((entry) => entry.provider.toLowerCase() === provider.toLowerCase() && entry.model === model);
}

function withCatalogSource(entry: ModelMetadataCatalogEntry, source: ModelMetadataCatalogSource): ModelMetadataCatalogEntry {
  return {
    ...entry,
    source
  };
}

function modelMetadataResolution(
  status: ModelMetadataResolution["status"],
  freshness: ModelMetadataFreshness,
  provider: string,
  model: string,
  entry: ModelMetadataCatalogEntry | undefined,
  diagnostics: readonly RedactedError[]
): ModelMetadataResolution {
  return {
    status,
    freshness,
    provider,
    model,
    ...(entry ? { entry } : {}),
    diagnostics,
    redaction: { class: "internal", fields: ["diagnostics.details"] }
  };
}

function isCatalogEntryStale(entry: ModelMetadataCatalogEntry, now: Date): boolean {
  if (!entry.expiresAt) return false;
  const expiresAtMs = Date.parse(entry.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs < now.getTime();
}

function estimateInputCostMicros(usage: ModelUsageMetadata, pricing: ModelPricingMetadata): number | undefined {
  const inputRate = pricing.inputCostMicrosPerMillionTokens;
  const hitTokens = usage.cache?.hitTokens;
  const missTokens = usage.cache?.missTokens;
  const hasCacheBreakdown = hitTokens !== undefined || missTokens !== undefined;
  const hasCachePricing = pricing.cacheHitCostMicrosPerMillionTokens !== undefined || pricing.cacheMissCostMicrosPerMillionTokens !== undefined;

  if (hasCacheBreakdown && hasCachePricing) {
    let coveredTokens = 0;
    let costMicros = 0;
    if (hitTokens !== undefined) {
      const rate = pricing.cacheHitCostMicrosPerMillionTokens ?? inputRate;
      if (rate === undefined) return undefined;
      coveredTokens += hitTokens;
      costMicros += (hitTokens * rate) / 1_000_000;
    }
    if (missTokens !== undefined) {
      const rate = pricing.cacheMissCostMicrosPerMillionTokens ?? inputRate;
      if (rate === undefined) return undefined;
      coveredTokens += missTokens;
      costMicros += (missTokens * rate) / 1_000_000;
    }
    const remainderTokens = Math.max(0, usage.inputTokens - coveredTokens);
    if (remainderTokens > 0) {
      if (inputRate === undefined) return undefined;
      costMicros += (remainderTokens * inputRate) / 1_000_000;
    }
    return costMicros;
  }

  if (inputRate === undefined && usage.inputTokens > 0) return undefined;
  return (usage.inputTokens * (inputRate ?? 0)) / 1_000_000;
}

function authorizationBearerToken(value: JsonValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim();
}

function baseUrlFromRequestUrl(url: string): string {
  return url.replace(/\/chat\/completions$/, "");
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function parseServerSentEventLine(line: string): ModelProviderResponseChunk | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return undefined;
  const payload = trimmed.slice("data:".length).trim();
  if (payload === "" || payload === "[DONE]") return undefined;
  try {
    const data: unknown = JSON.parse(payload);
    if (!isJsonObject(data)) {
      throw new Error("SSE payload is not a JSON object.");
    }
    return { data };
  } catch (error) {
    throw new Error(error instanceof Error ? `DeepSeek provider SSE parse failed: ${error.message}` : "DeepSeek provider SSE parse failed.");
  }
}

function redactProviderErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "empty response";
  return trimmed.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]").slice(0, 500);
}
