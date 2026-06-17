import type { JsonObject, RedactedError, RedactionMetadata } from "./common.js";
import type { ContextCacheHint } from "./context.js";
import type { CredentialRef, ModelProfileId, ModelProviderId } from "./ids.js";
import type { AgentLoopToolProjection } from "./runtime.js";

export type ModelProviderProtocol = "openai-chat-completions" | "anthropic-messages";

export interface ModelProviderConfig extends JsonObject {
  readonly providerId: ModelProviderId;
  readonly provider: string;
  readonly protocol: ModelProviderProtocol;
  readonly baseUrl: string;
  readonly defaultHeaders?: JsonObject;
  readonly credentialRef?: CredentialRef;
  readonly cacheHints?: ModelCacheHintCapabilityMetadata;
}

export interface ModelProfile extends JsonObject {
  readonly id: ModelProfileId;
  readonly providerId: ModelProviderId;
  readonly model: string;
  readonly temperature?: number;
  readonly cacheHints?: ModelCacheHintCapabilityMetadata;
  readonly providerOptions?: JsonObject;
}

export interface ModelCacheHintCapabilityMetadata extends JsonObject {
  readonly explicitPrefixCacheHints: boolean;
  readonly supportedPolicies?: readonly ("stable" | "ephemeral" | "no-store" | "ttl")[];
  readonly maxCacheHintBlocks?: number;
}

export type ModelReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ModelReasoningProviderEffort = "low" | "medium" | "high" | "max";

export interface ModelReasoningOptions extends JsonObject {
  readonly enabled?: boolean;
  readonly effort?: ModelReasoningEffort;
  readonly providerEffort?: ModelReasoningProviderEffort;
  readonly providerMapping?: JsonObject;
}

export type ModelOutputFormat = "text" | "json_object";

export interface ModelOutputOptions extends JsonObject {
  readonly format: ModelOutputFormat;
  readonly schema?: JsonObject;
  readonly description?: string;
  readonly strict?: boolean;
  readonly maxParseRetries?: number;
}

export type ModelChatMessageRole = "system" | "user" | "assistant" | "tool";

export interface ModelChatToolCall extends JsonObject {
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

export interface ModelChatMessage extends JsonObject {
  readonly role: ModelChatMessageRole;
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolCalls?: readonly ModelChatToolCall[];
  readonly cacheHint?: ContextCacheHint;
  readonly reasoningContent?: string;
  readonly reasoningRedaction?: RedactionMetadata;
}

export type ModelToolChoice =
  | "auto"
  | "required"
  | "none"
  | { readonly type: "function"; readonly name: string };

export interface ModelRequest {
  readonly profile: ModelProfile;
  readonly prompt: string;
  readonly messages?: readonly ModelChatMessage[];
  readonly credentialRef?: CredentialRef;
  readonly timeoutMs?: number;
  readonly tools?: readonly JsonObject[];
  readonly toolChoice?: ModelToolChoice;
  readonly toolProjection?: AgentLoopToolProjection;
  readonly reasoning?: ModelReasoningOptions;
  readonly output?: ModelOutputOptions;
  readonly metadata?: JsonObject;
  readonly signal?: AbortSignal;
}

export interface ModelProviderRequest extends JsonObject {
  readonly url: string;
  readonly method: "POST";
  readonly headers: JsonObject;
  readonly body: JsonObject;
  readonly timeoutMs?: number;
}

export interface ModelProviderResponseChunk extends JsonObject {
  readonly data: JsonObject;
}

export interface ModelProviderTransportOptions {
  readonly signal?: AbortSignal;
}

export interface ModelProviderTransport {
  stream(request: ModelProviderRequest, options?: ModelProviderTransportOptions): AsyncIterable<ModelProviderResponseChunk>;
}

export interface ModelCredentialValue extends JsonObject {
  readonly ref: CredentialRef;
  readonly value: string;
  readonly redaction: RedactionMetadata;
}

export interface ModelCredentialProvider {
  resolve(ref: CredentialRef, request: ModelRequest): Promise<ModelCredentialValue | undefined>;
}

export interface ModelProviderEventMetadata extends JsonObject {
  readonly provider: string;
  readonly protocol: ModelProviderProtocol;
  readonly model: string;
  readonly requestId?: string;
}

export interface ModelUsageCacheMetadata extends JsonObject {
  readonly status?: "available" | "unavailable";
  readonly hitTokens?: number;
  readonly missTokens?: number;
  readonly writeTokens?: number;
  readonly hitRate?: number;
  readonly pipelineFingerprint?: string;
  readonly breakpointShape?: {
    readonly systemCacheControlCount: number;
    readonly messageCacheControlCount: number;
    readonly toolCacheControlCount: number;
    readonly totalCacheControlCount: number;
    readonly messageCacheControlPositions?: readonly ("first-message" | "middle-message" | "last-message")[];
    readonly redaction: RedactionMetadata;
  };
  readonly explicitPrefixCacheHint?: {
    readonly status: "sent" | "unsupported" | "missing";
    readonly reasonCode: string;
    readonly redaction: RedactionMetadata;
  };
}

export type ModelMetadataCatalogSource = "remote" | "last-known-good" | "pinned" | "user-config";
export type ModelMetadataFreshness = "fresh" | "cached" | "pinned" | "stale" | "unavailable";
export type ModelMetadataResolutionStatus = "resolved" | "fallback" | "unavailable";
export type ModelUsageCostReliability = "priced" | "stale-estimate" | "unknown";

export interface ModelPricingMetadata extends JsonObject {
  readonly inputCostMicrosPerMillionTokens?: number;
  readonly outputCostMicrosPerMillionTokens?: number;
  readonly cacheHitCostMicrosPerMillionTokens?: number;
  readonly cacheMissCostMicrosPerMillionTokens?: number;
}

export interface ModelMetadataCatalogEntry extends JsonObject {
  readonly provider: string;
  readonly model: string;
  readonly source: ModelMetadataCatalogSource;
  readonly fetchedAt?: string;
  readonly expiresAt?: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly pricing?: ModelPricingMetadata;
}

export interface ModelMetadataResolution extends JsonObject {
  readonly status: ModelMetadataResolutionStatus;
  readonly freshness: ModelMetadataFreshness;
  readonly provider: string;
  readonly model: string;
  readonly entry?: ModelMetadataCatalogEntry;
  readonly diagnostics: readonly RedactedError[];
  readonly redaction: RedactionMetadata;
}

export interface ModelUsageCostEstimate extends JsonObject {
  readonly reliability: ModelUsageCostReliability;
  readonly costMicros?: number;
  readonly source?: ModelMetadataCatalogSource;
  readonly diagnostics: readonly RedactedError[];
}

export interface ModelUsageMetadata extends JsonObject {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
  readonly cache?: ModelUsageCacheMetadata;
  readonly cost?: ModelUsageCostEstimate;
  readonly provider?: ModelProviderEventMetadata;
}

export interface DeepSeekJsonOutputValidationResult extends JsonObject {
  readonly ok: boolean;
  readonly mode: "request" | "response";
  readonly retryable: boolean;
  readonly diagnostics: readonly RedactedError[];
}

export interface DeepSeekStrictToolSchemaValidationResult extends JsonObject {
  readonly ok: boolean;
  readonly diagnostics: readonly RedactedError[];
  readonly unsupportedKeywordPaths: readonly string[];
}

export interface DeepSeekChatPrefixCompletionRequest extends JsonObject {
  readonly profile: ModelProfile;
  readonly prompt: string;
  readonly prefix: string;
  readonly messages?: readonly ModelChatMessage[];
  readonly credentialRef?: CredentialRef;
  readonly timeoutMs?: number;
  readonly reasoning?: ModelReasoningOptions;
  readonly metadata?: JsonObject;
}

export interface DeepSeekFimCompletionRequest extends JsonObject {
  readonly profile: ModelProfile;
  readonly prompt: string;
  readonly suffix?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly credentialRef?: CredentialRef;
  readonly timeoutMs?: number;
  readonly metadata?: JsonObject;
}

export interface DeepSeekAnthropicMessagesRequest extends JsonObject {
  readonly profile: ModelProfile;
  readonly messages: readonly ModelChatMessage[];
  readonly system?: string;
  readonly maxTokens: number;
  readonly credentialRef?: CredentialRef;
  readonly timeoutMs?: number;
  readonly tools?: readonly JsonObject[];
  readonly toolChoice?: ModelToolChoice;
  readonly reasoning?: ModelReasoningOptions;
  readonly metadata?: JsonObject;
}

export type ModelFinishReason = "stop" | "length" | "tool-call" | "content-filter" | "error" | "unknown";

export type ModelStreamEvent =
  | { readonly kind: "delta"; readonly text: string; readonly provider?: ModelProviderEventMetadata }
  | { readonly kind: "reasoning"; readonly text: string; readonly redaction: RedactionMetadata; readonly provider?: ModelProviderEventMetadata }
  | { readonly kind: "tool-call"; readonly id?: string; readonly name: string; readonly input: JsonObject; readonly provider?: ModelProviderEventMetadata }
  | { readonly kind: "usage"; readonly inputTokens: number; readonly outputTokens: number; readonly metadata?: ModelUsageMetadata }
  | { readonly kind: "finish"; readonly reason: ModelFinishReason; readonly provider?: ModelProviderEventMetadata }
  | { readonly kind: "error"; readonly error: RedactedError; readonly provider?: ModelProviderEventMetadata }
  | { readonly kind: "done"; readonly provider?: ModelProviderEventMetadata };

export interface ModelGateway {
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
  countTokens(text: string, profile?: ModelProfile): Promise<number>;
  verify?(request: ModelLiveVerificationRequest): Promise<ModelLiveVerificationResult>;
}

export interface ModelLiveVerificationRequest {
  readonly profile: ModelProfile;
  readonly credentialRef?: CredentialRef;
  readonly prompt: string;
  readonly timeoutMs?: number;
}

export interface ModelLiveVerificationResult extends JsonObject {
  readonly ok: boolean;
  readonly provider: ModelProviderEventMetadata;
  readonly reachable: boolean;
  readonly terminalStatus: "completed" | "failed" | "missing-credential" | "unsupported";
  readonly latencyMs?: number;
  readonly eventKinds: readonly string[];
  readonly usage?: ModelUsageMetadata;
  readonly error?: RedactedError;
  readonly diagnostics: readonly RedactedError[];
  readonly redaction: RedactionMetadata;
}
