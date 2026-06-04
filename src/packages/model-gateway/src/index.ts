import type {
  CredentialRef,
  DeepSeekAnthropicMessagesRequest,
  DeepSeekChatPrefixCompletionRequest,
  DeepSeekFimCompletionRequest,
  DeepSeekJsonOutputValidationResult,
  DeepSeekStrictToolSchemaValidationResult,
  JsonObject,
  JsonValue,
  ModelCredentialValue,
  ModelCredentialProvider,
  ModelChatMessage,
  ModelFinishReason,
  ModelGateway,
  ModelLiveVerificationRequest,
  ModelLiveVerificationResult,
  ModelMetadataCatalogEntry,
  ModelMetadataCatalogSource,
  ModelMetadataFreshness,
  ModelMetadataResolution,
  ModelPricingMetadata,
  ModelProfile,
  ModelProviderConfig,
  ModelProviderEventMetadata,
  ModelProviderRequest,
  ModelProviderResponseChunk,
  ModelProviderTransport,
  ModelRequest,
  ModelReasoningEffort,
  ModelReasoningProviderEffort,
  ModelStreamEvent,
  ModelToolChoice,
  ModelUsageCostEstimate,
  ModelUsageMetadata,
  RedactedError
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import OpenAI from "openai";
export { createModelGatewayFamilyCapabilities } from "./family-capabilities.js";
export type { ModelGatewayFamilyCapabilityOptions } from "./family-capabilities.js";

const deepSeekProviderId = asId<"modelProvider">("provider-deepseek");
const deepSeekCredentialRef = asId<"credentialRef">("credential-deepseek-api-key");
const glmAnthropicProviderId = asId<"modelProvider">("provider-glm-anthropic");
export const glmAnthropicCredentialRef = asId<"credentialRef">("credential-glm-anthropic-api-key");

export const deepSeekOpenAIProviderConfig: ModelProviderConfig = {
  providerId: deepSeekProviderId,
  provider: "deepseek",
  protocol: "openai-chat-completions",
  baseUrl: "https://api.deepseek.com",
  credentialRef: deepSeekCredentialRef
};

export const defaultDeepSeekProfile: ModelProfile = {
  id: asId<"modelProfile">("model-deepseek-default"),
  providerId: deepSeekProviderId,
  model: "deepseek-v4-flash",
  temperature: 0
};

export const glmAnthropicProviderConfig: ModelProviderConfig = {
  providerId: glmAnthropicProviderId,
  provider: "glm",
  protocol: "anthropic-messages",
  baseUrl: "https://open.bigmodel.cn/api/anthropic",
  credentialRef: glmAnthropicCredentialRef
};

export const defaultGlmAnthropicProfile: ModelProfile = {
  id: asId<"modelProfile">("model-glm-anthropic-default"),
  providerId: glmAnthropicProviderId,
  model: "glm-5.1",
  temperature: 0
};

export const pinnedDeepSeekModelMetadataCatalog: readonly ModelMetadataCatalogEntry[] = [
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    source: "pinned",
    fetchedAt: "2026-05-17T00:00:00.000Z"
  }
];

export interface ModelMetadataResolverOptions {
  readonly provider: string;
  readonly model: string;
  readonly remoteCatalog?: () => Promise<readonly ModelMetadataCatalogEntry[]>;
  readonly lastKnownGoodCatalog?: readonly ModelMetadataCatalogEntry[];
  readonly pinnedCatalog?: readonly ModelMetadataCatalogEntry[];
  readonly now?: Date;
}

export interface DeepSeekOpenAIProviderOptions {
  readonly config?: ModelProviderConfig;
  readonly transport?: ModelProviderTransport;
  readonly credentials?: ModelCredentialProvider;
  readonly timeoutMs?: number;
}

export interface GlmAnthropicProviderOptions {
  readonly config?: ModelProviderConfig;
  readonly transport?: ModelProviderTransport;
  readonly credentials?: ModelCredentialProvider;
  readonly timeoutMs?: number;
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

export class DeepSeekOpenAIProvider implements ModelGateway {
  private readonly config: ModelProviderConfig;

  constructor(private readonly options: DeepSeekOpenAIProviderOptions = {}) {
    this.config = options.config ?? deepSeekOpenAIProviderConfig;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const provider = this.providerMetadata(request.profile);
    const pipelineFingerprint = requestPipelineFingerprint(request.metadata);
    if (!this.options.transport) {
      yield { kind: "error", error: providerError("PROVIDER_TRANSPORT_NOT_CONFIGURED", "DeepSeek provider transport is not configured.", false), provider };
      return;
    }

    const credentialRef = request.credentialRef ?? this.config.credentialRef;
    const credential = credentialRef ? await this.options.credentials?.resolve(credentialRef, request) : undefined;
    if (credentialRef && !credential) {
      yield { kind: "error", error: providerError("PROVIDER_CREDENTIAL_MISSING", "DeepSeek provider credential is missing.", false, { credentialRef }), provider };
      return;
    }

    const providerRequest = this.buildProviderRequest(request, credential?.value);
    const accumulator = createToolCallAccumulator();
    try {
      for await (const chunk of this.options.transport.stream(providerRequest, request.signal ? { signal: request.signal } : undefined)) {
        for (const event of normalizeDeepSeekChunk(chunk, provider, accumulator)) {
          yield attachPipelineCacheEvidence(event, pipelineFingerprint);
        }
      }
      for (const event of accumulator.flush(provider)) yield attachPipelineCacheEvidence(event, pipelineFingerprint);
      yield { kind: "done", provider };
    } catch (error) {
      yield {
        kind: "error",
        error: providerError("PROVIDER_TRANSPORT_FAILED", error instanceof Error ? error.message : "DeepSeek provider transport failed.", true),
        provider
      };
    }
  }

  async countTokens(text: string, _profile?: ModelProfile): Promise<number> {
    return countWhitespaceTokens(text);
  }

  async verify(request: ModelLiveVerificationRequest): Promise<ModelLiveVerificationResult> {
    return verifyByStreaming(this, request);
  }

  buildProviderRequest(request: ModelRequest, credentialValue = ""): ModelProviderRequest {
    const reasoningEffort = request.reasoning?.enabled === false
      ? undefined
      : deepSeekReasoningEffort(request.reasoning?.providerEffort ?? request.reasoning?.effort);
    const providerCacheControl = providerCacheControlFor(request, this.config);
    const body: JsonObject = {
      model: request.profile.model,
      messages: providerMessagesFrom(request),
      stream: true,
      temperature: request.profile.temperature ?? 0,
      ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
      ...(request.toolChoice !== undefined ? { tool_choice: formatToolChoice(request.toolChoice) } : {}),
      ...(request.reasoning ? { thinking: { type: request.reasoning.enabled === false ? "disabled" : "enabled" } } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(validateDeepSeekJsonOutputRequest(request).ok && request.output?.format === "json_object" ? { response_format: { type: "json_object" } } : {}),
      ...(providerCacheControl ? { cache_control: providerCacheControl } : {}),
      ...(request.profile.providerOptions ? request.profile.providerOptions : {})
    };

    return {
      url: `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credentialValue ? { authorization: `Bearer ${credentialValue}` } : {}),
        ...(this.config.defaultHeaders ?? {})
      },
      body,
      ...(request.timeoutMs ?? this.options.timeoutMs ? { timeoutMs: request.timeoutMs ?? this.options.timeoutMs } : {})
    };
  }

  buildStrictToolSchemaProviderRequest(request: ModelRequest, credentialValue = ""): {
    readonly request?: ModelProviderRequest;
    readonly validation: DeepSeekStrictToolSchemaValidationResult;
  } {
    const validation = validateDeepSeekStrictToolSchema(request.tools ?? []);
    if (!validation.ok) return { validation };
    const providerRequest = this.buildProviderRequest(request, credentialValue);
    return {
      validation,
      request: {
        ...providerRequest,
        url: `${this.config.baseUrl.replace(/\/$/, "")}/beta/chat/completions`,
        body: {
          ...providerRequest.body,
          tools: (request.tools ?? []).map((tool) => withStrictToolFlag(tool))
        }
      }
    };
  }

  buildChatPrefixCompletionProviderRequest(request: DeepSeekChatPrefixCompletionRequest, credentialValue = ""): ModelProviderRequest {
    const reasoningEffort = request.reasoning?.enabled === false
      ? undefined
      : deepSeekReasoningEffort(request.reasoning?.providerEffort ?? request.reasoning?.effort);
    return {
      url: `${this.config.baseUrl.replace(/\/$/, "")}/beta/chat/completions`,
      method: "POST",
      headers: this.headers(credentialValue),
      body: {
        model: request.profile.model,
        messages: [
          ...providerMessagesFrom({
            profile: request.profile,
            prompt: request.prompt,
            ...(request.messages ? { messages: request.messages } : {})
          }),
          {
            role: "assistant",
            content: request.prefix,
            prefix: true
          }
        ],
        stream: true,
        temperature: request.profile.temperature ?? 0,
        ...(request.reasoning ? { thinking: { type: request.reasoning.enabled === false ? "disabled" : "enabled" } } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(request.profile.providerOptions ? request.profile.providerOptions : {})
      },
      ...(request.timeoutMs ?? this.options.timeoutMs ? { timeoutMs: request.timeoutMs ?? this.options.timeoutMs } : {})
    };
  }

  buildFimCompletionProviderRequest(request: DeepSeekFimCompletionRequest, credentialValue = ""): ModelProviderRequest {
    return {
      url: `${this.config.baseUrl.replace(/\/$/, "")}/beta/completions`,
      method: "POST",
      headers: this.headers(credentialValue),
      body: {
        model: request.profile.model,
        prompt: request.prompt,
        ...(request.suffix !== undefined ? { suffix: request.suffix } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        temperature: request.temperature ?? request.profile.temperature ?? 0,
        ...(request.profile.providerOptions ? request.profile.providerOptions : {})
      },
      ...(request.timeoutMs ?? this.options.timeoutMs ? { timeoutMs: request.timeoutMs ?? this.options.timeoutMs } : {})
    };
  }

  buildAnthropicMessagesProviderRequest(request: DeepSeekAnthropicMessagesRequest, credentialValue = ""): {
    readonly request?: ModelProviderRequest;
    readonly validation: DeepSeekStrictToolSchemaValidationResult;
  } {
    const validation = validateDeepSeekAnthropicMessagesRequest(request);
    if (!validation.ok) return { validation };
    const reasoningEffort = request.reasoning?.enabled === false
      ? undefined
      : deepSeekReasoningEffort(request.reasoning?.providerEffort ?? request.reasoning?.effort);
    return {
      validation,
      request: {
        url: `${this.config.baseUrl.replace(/\/$/, "")}/anthropic/messages`,
        method: "POST",
        headers: {
          ...this.headers(credentialValue),
          "anthropic-version": "2023-06-01"
        },
        body: {
          model: request.profile.model,
          max_tokens: request.maxTokens,
          messages: anthropicMessagesFrom(request.messages),
          ...(request.system ? { system: request.system } : {}),
          ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
          ...(request.toolChoice !== undefined ? { tool_choice: formatAnthropicToolChoice(request.toolChoice) } : {}),
          ...(reasoningEffort ? { output_config: { effort: reasoningEffort } } : {}),
          ...(request.profile.providerOptions ? request.profile.providerOptions : {})
        },
        ...(request.timeoutMs ?? this.options.timeoutMs ? { timeoutMs: request.timeoutMs ?? this.options.timeoutMs } : {})
      }
    };
  }

  private providerMetadata(profile: ModelProfile): ModelProviderEventMetadata {
    return {
      provider: this.config.provider,
      protocol: this.config.protocol,
      model: profile.model
    };
  }

  private headers(credentialValue = ""): JsonObject {
    return {
      "content-type": "application/json",
      ...(credentialValue ? { authorization: `Bearer ${credentialValue}` } : {}),
      ...(this.config.defaultHeaders ?? {})
    };
  }
}

export class GlmAnthropicProvider implements ModelGateway {
  private readonly config: ModelProviderConfig;

  constructor(private readonly options: GlmAnthropicProviderOptions = {}) {
    this.config = options.config ?? glmAnthropicProviderConfig;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const provider = this.providerMetadata(request.profile);
    const pipelineFingerprint = requestPipelineFingerprint(request.metadata);
    if (!this.options.transport) {
      yield { kind: "error", error: providerError("PROVIDER_TRANSPORT_NOT_CONFIGURED", "GLM Anthropic-compatible provider transport is not configured.", false), provider };
      return;
    }

    const credentialRef = request.credentialRef ?? this.config.credentialRef;
    const credential = credentialRef ? await this.options.credentials?.resolve(credentialRef, request) : undefined;
    if (credentialRef && !credential) {
      yield { kind: "error", error: providerError("PROVIDER_CREDENTIAL_MISSING", "GLM Anthropic-compatible provider credential is missing.", false, { credentialRef }), provider };
      return;
    }

    const providerRequest = this.buildProviderRequest(request, credential?.value);
    const normalize = createGlmAnthropicChunkNormalizer();
    let emittedDone = false;
    try {
      for await (const chunk of this.options.transport.stream(providerRequest, request.signal ? { signal: request.signal } : undefined)) {
        for (const event of normalize(chunk, provider)) {
          if (event.kind === "done") emittedDone = true;
          yield attachPipelineCacheEvidence(event, pipelineFingerprint);
        }
      }
      if (!emittedDone) yield { kind: "done", provider };
    } catch (error) {
      yield {
        kind: "error",
        error: providerError("PROVIDER_TRANSPORT_FAILED", error instanceof Error ? error.message : "GLM Anthropic-compatible provider transport failed.", true),
        provider
      };
    }
  }

  async countTokens(text: string, _profile?: ModelProfile): Promise<number> {
    return countWhitespaceTokens(text);
  }

  async verify(request: ModelLiveVerificationRequest): Promise<ModelLiveVerificationResult> {
    return verifyByStreaming(this, request);
  }

  buildProviderRequest(request: ModelRequest, credentialValue = ""): ModelProviderRequest {
    const providerOptions = request.profile.providerOptions ?? {};
    const maxTokens = numberValue(providerOptions.max_tokens) ?? numberValue(providerOptions.maxTokens) ?? 1024;
    const { max_tokens: _maxTokensSnake, maxTokens: _maxTokensCamel, ...passthroughProviderOptions } = providerOptions;
    return {
      url: `${this.config.baseUrl.replace(/\/$/, "")}/v1/messages`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(credentialValue ? { "x-api-key": credentialValue } : {}),
        ...(this.config.defaultHeaders ?? {})
      },
      body: {
        model: request.profile.model,
        messages: glmAnthropicMessagesFrom(request),
        stream: true,
        ...(request.profile.temperature !== undefined ? { temperature: request.profile.temperature } : {}),
        ...(glmAnthropicSystemFrom(request) ? { system: glmAnthropicSystemFrom(request) } : {}),
        ...(request.tools && request.tools.length > 0 ? { tools: request.tools.map(glmAnthropicToolFrom).filter((tool): tool is JsonObject => Boolean(tool)) } : {}),
        ...(request.toolChoice !== undefined ? { tool_choice: formatAnthropicToolChoice(request.toolChoice) } : {}),
        ...passthroughProviderOptions,
        max_tokens: maxTokens
      },
      ...(request.timeoutMs ?? this.options.timeoutMs ? { timeoutMs: request.timeoutMs ?? this.options.timeoutMs } : {})
    };
  }

  private providerMetadata(profile: ModelProfile): ModelProviderEventMetadata {
    return {
      provider: this.config.provider,
      protocol: this.config.protocol,
      model: profile.model
    };
  }
}

export interface DeepSeekJsonOutputParseResult extends JsonObject {
  readonly ok: boolean;
  readonly value?: JsonValue;
  readonly retryable: boolean;
  readonly diagnostics: readonly RedactedError[];
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

export function validateDeepSeekJsonOutputRequest(request: Pick<ModelRequest, "prompt" | "messages" | "output">): DeepSeekJsonOutputValidationResult {
  if (request.output?.format !== "json_object") return { ok: true, mode: "request", retryable: false, diagnostics: [] };
  const content = [
    request.prompt,
    ...(request.messages ?? []).map((message) => message.content)
  ].join("\n");
  const diagnostics: RedactedError[] = [];
  if (!/\bjson\b/i.test(content)) {
    diagnostics.push(providerError("DEEPSEEK_JSON_PROMPT_GUARDRAIL_MISSING", "DeepSeek JSON output mode requires prompt or messages to explicitly mention JSON.", false));
  }
  if (request.output.maxParseRetries !== undefined && (!Number.isInteger(request.output.maxParseRetries) || request.output.maxParseRetries < 0)) {
    diagnostics.push(providerError("DEEPSEEK_JSON_RETRY_BUDGET_INVALID", "JSON output maxParseRetries must be a non-negative integer.", false));
  }
  return { ok: diagnostics.length === 0, mode: "request", retryable: false, diagnostics };
}

export function parseDeepSeekJsonOutputResponse(text: string, finishReason: ModelFinishReason = "stop"): DeepSeekJsonOutputParseResult {
  const trimmed = text.trim();
  const diagnostics: RedactedError[] = [];
  if (finishReason === "length") {
    diagnostics.push(providerError("DEEPSEEK_JSON_RESPONSE_TRUNCATED", "DeepSeek JSON output ended with finish_reason=length.", true));
  }
  if (!trimmed) {
    diagnostics.push(providerError("DEEPSEEK_JSON_RESPONSE_EMPTY", "DeepSeek JSON output was empty.", true));
    return { ok: false, retryable: true, diagnostics };
  }
  try {
    const value = JSON.parse(trimmed) as JsonValue;
    if (!isJsonObject(value)) {
      diagnostics.push(providerError("DEEPSEEK_JSON_RESPONSE_NOT_OBJECT", "DeepSeek JSON output must parse to a JSON object.", true));
      return { ok: false, retryable: true, diagnostics };
    }
    if (diagnostics.length > 0) return { ok: false, value, retryable: true, diagnostics };
    return { ok: true, value, retryable: false, diagnostics };
  } catch (error) {
    diagnostics.push(providerError("DEEPSEEK_JSON_RESPONSE_PARSE_FAILED", error instanceof Error ? error.message : "DeepSeek JSON output parse failed.", true));
    return { ok: false, retryable: true, diagnostics };
  }
}

export function validateDeepSeekStrictToolSchema(tools: readonly JsonObject[]): DeepSeekStrictToolSchemaValidationResult {
  const unsupportedKeywordPaths: string[] = [];
  const diagnostics: RedactedError[] = [];
  for (const [index, tool] of tools.entries()) {
    if (tool.type !== "function" || !isJsonObject(tool.function)) {
      diagnostics.push(providerError("DEEPSEEK_STRICT_TOOL_SHAPE_INVALID", `Tool at index ${index} must be an OpenAI function tool.`, false));
      continue;
    }
    const fn = tool.function;
    if (typeof fn.name !== "string" || !fn.name) {
      diagnostics.push(providerError("DEEPSEEK_STRICT_TOOL_NAME_INVALID", `Tool at index ${index} must include function.name.`, false));
    }
    if (!isJsonObject(fn.parameters)) {
      diagnostics.push(providerError("DEEPSEEK_STRICT_TOOL_PARAMETERS_INVALID", `Tool at index ${index} must include object function.parameters.`, false));
      continue;
    }
    collectUnsupportedJsonSchemaKeywords(fn.parameters, `tools[${index}].function.parameters`, unsupportedKeywordPaths);
  }
  if (unsupportedKeywordPaths.length > 0) {
    diagnostics.push(providerError("DEEPSEEK_STRICT_TOOL_SCHEMA_UNSUPPORTED_KEYWORD", "Strict DeepSeek tool schemas cannot use unsupported JSON Schema composition/reference keywords.", false, { unsupportedKeywordPaths }));
  }
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    unsupportedKeywordPaths
  };
}

export function validateDeepSeekAnthropicMessagesRequest(request: DeepSeekAnthropicMessagesRequest): DeepSeekStrictToolSchemaValidationResult {
  const diagnostics: RedactedError[] = [];
  const unsupportedKeywordPaths: string[] = [];
  if (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0) {
    diagnostics.push(providerError("DEEPSEEK_ANTHROPIC_MAX_TOKENS_INVALID", "DeepSeek Anthropic-compatible messages require a positive integer maxTokens.", false));
  }
  for (const [index, message] of request.messages.entries()) {
    if (message.role !== "user" && message.role !== "assistant") {
      unsupportedKeywordPaths.push(`messages[${index}].role`);
    }
    if (message.toolCalls && message.toolCalls.length > 0) {
      unsupportedKeywordPaths.push(`messages[${index}].toolCalls`);
    }
  }
  if (unsupportedKeywordPaths.length > 0) {
    diagnostics.push(providerError("DEEPSEEK_ANTHROPIC_UNSUPPORTED_FIELD", "DeepSeek Anthropic-compatible lane only accepts string user/assistant messages in this adapter.", false, { unsupportedKeywordPaths }));
  }
  return { ok: diagnostics.length === 0, diagnostics, unsupportedKeywordPaths };
}

function deepSeekReasoningEffort(effort: ModelReasoningEffort | ModelReasoningProviderEffort | undefined): "high" | "max" | undefined {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
      return "high";
    case "xhigh":
    case "max":
      return "max";
    case undefined:
      return undefined;
  }
}

function providerMessagesFrom(request: ModelRequest): readonly JsonObject[] {
  const sourceMessages = request.messages && request.messages.length > 0
    ? request.messages
    : [{ role: "user" as const, content: request.prompt }];
  const pendingToolCallIds = new Set<string>();
  const messages: JsonObject[] = [];
  for (const message of sourceMessages) {
    if (message.role === "tool") {
      const toolCallId = message.toolCallId ?? "";
      if (toolCallId && pendingToolCallIds.has(toolCallId)) {
        pendingToolCallIds.delete(toolCallId);
        messages.push({
          role: "tool",
          content: message.content,
          tool_call_id: toolCallId
        });
      } else {
        messages.push({
          role: "user",
          content: `Internal tool feedback (${message.toolName ?? "tool"}):\n${message.content}`
        });
      }
      continue;
    }
    const toolCalls = message.toolCalls?.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.input)
      }
    }));
    for (const toolCall of message.toolCalls ?? []) pendingToolCallIds.add(toolCall.id);
    const reasoningContent = typeof (message as { reasoningContent?: unknown }).reasoningContent === "string"
      ? (message as { reasoningContent: string }).reasoningContent
      : undefined;
    messages.push({
      role: message.role,
      content: toolCalls && toolCalls.length > 0 && message.content.length === 0 ? null : message.content,
      ...(reasoningContent && reasoningContent.length > 0 ? { reasoning_content: reasoningContent } : {}),
      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    });
  }
  return messages;
}

function anthropicMessagesFrom(messages: readonly ModelChatMessage[]): readonly JsonObject[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: message.content
    }));
}

function glmAnthropicSystemFrom(request: ModelRequest): string | undefined {
  const messages = request.messages ?? [];
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0)
    .join("\n\n");
  return system.length > 0 ? system : undefined;
}

function glmAnthropicMessagesFrom(request: ModelRequest): readonly JsonObject[] {
  const sourceMessages = request.messages && request.messages.length > 0
    ? request.messages
    : [{ role: "user" as const, content: request.prompt }];
  const messages: JsonObject[] = [];
  for (const message of sourceMessages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      messages.push({
        role: "user",
        content: `Internal tool feedback (${message.toolName ?? "tool"}):\n${message.content}`
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...message.toolCalls.map((toolCall) => ({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input
          }))
        ]
      });
      continue;
    }
    if (message.role === "user" || message.role === "assistant") {
      messages.push({
        role: message.role,
        content: message.content
      });
    }
  }
  if (messages.length === 0) return [{ role: "user", content: request.prompt }];
  return messages;
}

function glmAnthropicToolFrom(tool: JsonObject): JsonObject | undefined {
  if (tool.type !== "function" || !isJsonObject(tool.function)) return undefined;
  const fn = tool.function;
  const name = stringValue(fn.name);
  if (!name) return undefined;
  const inputSchema = isJsonObject(fn.parameters) ? fn.parameters : { type: "object" };
  return {
    name,
    ...(typeof fn.description === "string" && fn.description.length > 0 ? { description: fn.description } : {}),
    input_schema: inputSchema
  };
}

export class StaticCredentialProvider implements ModelCredentialProvider {
  constructor(private readonly value: string, private readonly ref: CredentialRef = deepSeekCredentialRef) {}

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

export interface ToolCallAccumulator {
  ingest(value: unknown, provider: ModelProviderEventMetadata): ModelStreamEvent[];
  flush(provider: ModelProviderEventMetadata): ModelStreamEvent[];
}

interface ToolCallFragment {
  id?: string;
  name?: string;
  argumentsBuffer: string;
  argumentsIsString: boolean;
  argumentsObject?: JsonObject;
}

export function createToolCallAccumulator(): ToolCallAccumulator {
  const fragments = new Map<number, ToolCallFragment>();
  let fallbackIndex = 0;

  function ingest(value: unknown, _provider: ModelProviderEventMetadata): ModelStreamEvent[] {
    if (!isJsonObject(value)) return [];
    const rawIndex = numberValue(value.index);
    const index = rawIndex !== undefined ? rawIndex : fallbackIndex;
    if (rawIndex === undefined) fallbackIndex += 1;

    let fragment = fragments.get(index);
    if (!fragment) {
      fragment = { argumentsBuffer: "", argumentsIsString: false };
      fragments.set(index, fragment);
    }
    if (typeof value.id === "string" && value.id) fragment.id = value.id;
    const fn = isJsonObject(value.function) ? value.function : undefined;
    const name = stringValue(fn?.name) ?? stringValue(value.name);
    if (name) fragment.name = name;
    const rawArguments = fn?.arguments ?? value.arguments ?? value.input;
    if (typeof rawArguments === "string") {
      fragment.argumentsBuffer += rawArguments;
      fragment.argumentsIsString = true;
    } else if (isJsonObject(rawArguments)) {
      fragment.argumentsObject = rawArguments;
    }
    return [];
  }

  function flush(provider: ModelProviderEventMetadata): ModelStreamEvent[] {
    const events: ModelStreamEvent[] = [];
    const indices = [...fragments.keys()].sort((a, b) => a - b);
    for (const index of indices) {
      const fragment = fragments.get(index);
      if (!fragment || !fragment.name) continue;
      const input = fragment.argumentsObject
        ? fragment.argumentsObject
        : fragment.argumentsIsString
          ? parseToolInput(fragment.argumentsBuffer)
          : {};
      events.push({
        kind: "tool-call",
        ...(fragment.id ? { id: fragment.id } : {}),
        name: fragment.name,
        input,
        provider
      });
    }
    fragments.clear();
    fallbackIndex = 0;
    return events;
  }

  return { ingest, flush };
}

export function normalizeDeepSeekChunk(
  chunk: ModelProviderResponseChunk,
  provider: ModelProviderEventMetadata,
  accumulator?: ToolCallAccumulator
): readonly ModelStreamEvent[] {
  const data = chunk.data;
  if (typeof data.error === "object" && data.error !== null) {
    const error = data.error as JsonObject;
    return [{ kind: "error", error: providerError(String(error.code ?? "PROVIDER_ERROR"), String(error.message ?? "DeepSeek provider error."), Boolean(error.retryable ?? false)), provider }];
  }

  const events: ModelStreamEvent[] = [];
  const requestProvider = typeof data.id === "string" ? { ...provider, requestId: data.id } : provider;
  const choices = Array.isArray(data.choices) ? data.choices : [];
  for (const choice of choices) {
    if (!isJsonObject(choice)) continue;
    const delta = isJsonObject(choice.delta) ? choice.delta : isJsonObject(choice.message) ? choice.message : undefined;
    if (delta) {
      const reasoningText = stringValue(delta.reasoning_content) ?? stringValue(delta.reasoning) ?? stringValue(delta.thinking);
      if (reasoningText) {
        events.push({ kind: "reasoning", text: reasoningText, redaction: { class: "internal" }, provider: requestProvider });
      }
      const text = stringValue(delta.content);
      if (text) {
        events.push({ kind: "delta", text, provider: requestProvider });
      }
      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const toolCall of toolCalls) {
        if (accumulator) {
          events.push(...accumulator.ingest(toolCall, requestProvider));
        } else {
          const event = normalizeToolCall(toolCall, requestProvider);
          if (event) events.push(event);
        }
      }
    }
    const finishReason = normalizeFinishReason(choice.finish_reason);
    if (finishReason) {
      if (accumulator && (finishReason === "tool-call" || finishReason === "stop" || finishReason === "length")) {
        events.push(...accumulator.flush(requestProvider));
      }
      events.push({ kind: "finish", reason: finishReason, provider: requestProvider });
    }
  }

  const usage = normalizeUsage(data.usage, requestProvider);
  if (usage) {
    events.push({
      kind: "usage",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      metadata: usage
    });
  }

  return events;
}

export function createGlmAnthropicChunkNormalizer(): (chunk: ModelProviderResponseChunk, provider: ModelProviderEventMetadata) => readonly ModelStreamEvent[] {
  const toolBlocks = new Map<number, ToolCallFragment>();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadInputTokens: number | undefined;
  let usageEmitted = false;
  let requestId: string | undefined;

  function requestProvider(provider: ModelProviderEventMetadata): ModelProviderEventMetadata {
    return requestId ? { ...provider, requestId } : provider;
  }

  function reset(): void {
    toolBlocks.clear();
    inputTokens = undefined;
    outputTokens = undefined;
    cacheReadInputTokens = undefined;
    usageEmitted = false;
    requestId = undefined;
  }

  function updateUsage(value: unknown): void {
    if (!isJsonObject(value)) return;
    inputTokens = numberValue(value.input_tokens) ?? inputTokens;
    outputTokens = numberValue(value.output_tokens) ?? outputTokens;
    cacheReadInputTokens = numberValue(value.cache_read_input_tokens) ?? cacheReadInputTokens;
  }

  return (chunk: ModelProviderResponseChunk, provider: ModelProviderEventMetadata): readonly ModelStreamEvent[] => {
    const data = chunk.data;
    const error = isJsonObject(data.error) ? data.error : data.type === "error" && isJsonObject(data.error) ? data.error : undefined;
    if (error) {
      return [{ kind: "error", error: providerError(String(error.code ?? error.type ?? "PROVIDER_ERROR"), String(error.message ?? "GLM Anthropic-compatible provider error."), Boolean(error.retryable ?? false)), provider: requestProvider(provider) }];
    }

    const events: ModelStreamEvent[] = [];
    if (data.type === "message_start" && isJsonObject(data.message)) {
      const message = data.message;
      if (typeof message.id === "string" && message.id.length > 0) requestId = message.id;
      updateUsage(message.usage);
    }

    if (data.type === "content_block_start") {
      const index = numberValue(data.index) ?? 0;
      const block = isJsonObject(data.content_block) ? data.content_block : undefined;
      if (block?.type === "tool_use") {
        toolBlocks.set(index, {
          ...(typeof block.id === "string" ? { id: block.id } : {}),
          ...(typeof block.name === "string" ? { name: block.name } : {}),
          argumentsBuffer: "",
          argumentsIsString: false,
          ...(isJsonObject(block.input) ? { argumentsObject: block.input } : {})
        });
      }
    }

    if (data.type === "content_block_delta") {
      const delta = isJsonObject(data.delta) ? data.delta : undefined;
      if (delta?.type === "text_delta") {
        const text = stringValue(delta.text);
        if (text) events.push({ kind: "delta", text, provider: requestProvider(provider) });
      }
      if (delta?.type === "input_json_delta") {
        const index = numberValue(data.index) ?? 0;
        let block = toolBlocks.get(index);
        if (!block) {
          block = { argumentsBuffer: "", argumentsIsString: true };
          toolBlocks.set(index, block);
        }
        const partial = stringValue(delta.partial_json);
        if (partial) {
          block.argumentsBuffer += partial;
          block.argumentsIsString = true;
        }
      }
    }

    if (data.type === "content_block_stop") {
      const index = numberValue(data.index) ?? 0;
      const block = toolBlocks.get(index);
      if (block?.name) {
        const input = block.argumentsIsString
          ? parseToolInput(block.argumentsBuffer)
          : block.argumentsObject ?? {};
        events.push({
          kind: "tool-call",
          ...(block.id ? { id: block.id } : {}),
          name: block.name,
          input,
          provider: requestProvider(provider)
        });
      }
      toolBlocks.delete(index);
    }

    if (data.type === "message_delta") {
      const delta = isJsonObject(data.delta) ? data.delta : undefined;
      const finishReason = normalizeAnthropicStopReason(delta?.stop_reason);
      if (finishReason) events.push({ kind: "finish", reason: finishReason, provider: requestProvider(provider) });
      updateUsage(data.usage);
    }

    if (!usageEmitted && data.type === "message_delta" && inputTokens !== undefined && outputTokens !== undefined) {
      usageEmitted = true;
      const metadata: ModelUsageMetadata = {
        inputTokens,
        outputTokens,
        ...(cacheReadInputTokens !== undefined ? { cache: { hitTokens: cacheReadInputTokens } } : {}),
        provider: requestProvider(provider)
      };
      events.push({
        kind: "usage",
        inputTokens,
        outputTokens,
        metadata
      });
    }

    if (data.type === "message_stop") {
      events.push({ kind: "done", provider: requestProvider(provider) });
      reset();
    }

    return events;
  };
}

const defaultGlmAnthropicChunkNormalizer = createGlmAnthropicChunkNormalizer();

export function normalizeGlmAnthropicChunk(chunk: ModelProviderResponseChunk, provider: ModelProviderEventMetadata): readonly ModelStreamEvent[] {
  return defaultGlmAnthropicChunkNormalizer(chunk, provider);
}

function normalizeToolCall(value: unknown, provider: ModelProviderEventMetadata): ModelStreamEvent | undefined {
  if (!isJsonObject(value)) return undefined;
  const fn = isJsonObject(value.function) ? value.function : undefined;
  const name = stringValue(fn?.name) ?? stringValue(value.name);
  if (!name) return undefined;
  const rawArguments = fn?.arguments ?? value.arguments ?? value.input ?? {};
  return {
    kind: "tool-call",
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    name,
    input: parseToolInput(rawArguments),
    provider
  };
}

function normalizeUsage(value: unknown, provider: ModelProviderEventMetadata): ModelUsageMetadata | undefined {
  if (!isJsonObject(value)) return undefined;
  const inputTokens = numberValue(value.prompt_tokens) ?? numberValue(value.input_tokens);
  const outputTokens = numberValue(value.completion_tokens) ?? numberValue(value.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const details = isJsonObject(value.completion_tokens_details) ? value.completion_tokens_details : {};
  const promptDetails = isJsonObject(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const reasoningTokens = numberValue(details.reasoning_tokens);
  const hitTokens = numberValue(value.prompt_cache_hit_tokens) ?? numberValue(promptDetails.cached_tokens);
  const missTokens = numberValue(value.prompt_cache_miss_tokens);
  return {
    inputTokens,
    outputTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(hitTokens !== undefined || missTokens !== undefined ? { cache: { ...(hitTokens !== undefined ? { hitTokens } : {}), ...(missTokens !== undefined ? { missTokens } : {}) } } : {}),
    provider
  };
}

function attachPipelineCacheEvidence(event: ModelStreamEvent, pipelineFingerprint: string | undefined): ModelStreamEvent {
  if (!pipelineFingerprint || event.kind !== "usage") return event;
  const metadata = event.metadata ?? { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
  const cache = metadata.cache;
  const hitTokens = cache?.hitTokens;
  const missTokens = cache?.missTokens;
  const denominator = (hitTokens ?? 0) + (missTokens ?? 0);
  return {
    ...event,
    metadata: {
      ...metadata,
      cache: {
        ...(cache ?? {}),
        status: hitTokens !== undefined || missTokens !== undefined ? "available" : "unavailable",
        ...(denominator > 0 ? { hitRate: (hitTokens ?? 0) / denominator } : {}),
        pipelineFingerprint
      }
    }
  };
}

function requestPipelineFingerprint(metadata: JsonObject | undefined): string | undefined {
  const direct = metadata?.pipelineFingerprint;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const pipeline = metadata?.contextPipeline;
  if (isJsonObject(pipeline) && typeof pipeline.pipelineFingerprint === "string" && pipeline.pipelineFingerprint.length > 0) {
    return pipeline.pipelineFingerprint;
  }
  return undefined;
}

function providerCacheControlFor(request: ModelRequest, config: ModelProviderConfig): JsonObject | undefined {
  const capability = request.profile.cacheHints ?? config.cacheHints;
  if (!capability?.explicitPrefixCacheHints) return undefined;
  const pipeline = isJsonObject(request.metadata?.contextPipeline) ? request.metadata.contextPipeline : undefined;
  const pipelineFingerprint = stringValue(pipeline?.pipelineFingerprint);
  const cacheHintSummary = isJsonObject(pipeline?.cacheHintSummary) ? pipeline.cacheHintSummary : undefined;
  if (!pipelineFingerprint || !cacheHintSummary) return undefined;
  return {
    type: "deepseek-prefix-cache",
    pipeline_fingerprint: pipelineFingerprint,
    stable_blocks: numberValue(cacheHintSummary.stable) ?? 0,
    ephemeral_blocks: numberValue(cacheHintSummary.ephemeral) ?? 0,
    no_store_blocks: numberValue(cacheHintSummary.noStore) ?? 0,
    ttl_blocks: numberValue(cacheHintSummary.ttlBound) ?? 0,
    ...(capability.maxCacheHintBlocks !== undefined ? { max_hint_blocks: capability.maxCacheHintBlocks } : {})
  };
}

function normalizeFinishReason(value: unknown): ModelFinishReason | undefined {
  if (value === undefined || value === null) return undefined;
  switch (String(value)) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "tool_call":
      return "tool-call";
    case "content_filter":
      return "content-filter";
    default:
      return "unknown";
  }
}

function normalizeAnthropicStopReason(value: unknown): ModelFinishReason | undefined {
  if (value === undefined || value === null) return undefined;
  switch (String(value)) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool-call";
    default:
      return "unknown";
  }
}

function parseToolInput(value: unknown): JsonObject {
  if (isJsonObject(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonObject(parsed) ? parsed : { value: parsed as JsonValue };
  } catch {
    return { raw: value };
  }
}

export function formatToolChoice(choice: ModelToolChoice): JsonValue {
  if (choice === "auto" || choice === "required" || choice === "none") return choice;
  return { type: "function", function: { name: choice.name } };
}

function formatAnthropicToolChoice(choice: ModelToolChoice): JsonValue {
  if (choice === "auto" || choice === "none") return { type: choice };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
}

function withStrictToolFlag(tool: JsonObject): JsonObject {
  if (tool.type !== "function" || !isJsonObject(tool.function)) return tool;
  return {
    ...tool,
    function: {
      ...tool.function,
      strict: true
    }
  };
}

function collectUnsupportedJsonSchemaKeywords(value: JsonValue | undefined, path: string, paths: string[]): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) collectUnsupportedJsonSchemaKeywords(item, `${path}[${index}]`, paths);
    return;
  }
  if (!isJsonObject(value)) return;
  const unsupported = new Set(["$ref", "oneOf", "anyOf", "allOf", "not", "if", "then", "else", "dependentRequired", "dependentSchemas", "patternProperties", "unevaluatedProperties", "unevaluatedItems", "contains"]);
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (unsupported.has(key)) paths.push(childPath);
    collectUnsupportedJsonSchemaKeywords(child, childPath, paths);
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

function providerError(code: string, message: string, retryable: boolean, details: JsonObject = {}): RedactedError {
  return {
    code,
    message,
    retryable,
    redaction: { class: "public" },
    ...(Object.keys(details).length > 0 ? { details } : {})
  };
}

export async function verifyByStreaming(gateway: ModelGateway, request: ModelLiveVerificationRequest): Promise<ModelLiveVerificationResult> {
  const started = Date.now();
  const eventKinds: string[] = [];
  const diagnostics: RedactedError[] = [];
  let usage: ModelLiveVerificationResult["usage"];
  let terminalStatus: ModelLiveVerificationResult["terminalStatus"] = "failed";
  let reachable = false;

  for await (const event of gateway.stream({
    profile: request.profile,
    prompt: request.prompt,
    ...(request.credentialRef ? { credentialRef: request.credentialRef } : {}),
    ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
    metadata: { liveVerification: true, ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}) }
  } as ModelRequest)) {
    eventKinds.push(event.kind);
    if (event.kind === "delta" || event.kind === "reasoning" || event.kind === "finish" || event.kind === "usage" || event.kind === "done") reachable = true;
    if (event.kind === "usage") usage = event.metadata;
    if (event.kind === "error") {
      diagnostics.push(redactProviderError(event.error));
      terminalStatus = event.error.code === "PROVIDER_CREDENTIAL_MISSING" ? "missing-credential" : "failed";
    }
    if (event.kind === "done" || event.kind === "finish") terminalStatus = diagnostics.length === 0 ? "completed" : terminalStatus;
  }

  return {
    ok: terminalStatus === "completed",
    provider: { provider: "deepseek", protocol: "openai-chat-completions", model: request.profile.model },
    reachable,
    terminalStatus,
    latencyMs: Date.now() - started,
    eventKinds,
    ...(usage ? { usage } : {}),
    ...(diagnostics[0] ? { error: diagnostics[0] } : {}),
    diagnostics,
    redaction: { class: "internal" }
  };
}

function redactProviderError(error: RedactedError): RedactedError {
  return {
    ...error,
    message: error.message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]").replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]"),
    redaction: { class: "public" }
  };
}

function countWhitespaceTokens(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
