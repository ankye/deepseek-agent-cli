import type {
  ModelCredentialProvider,
  ModelGateway,
  ModelLiveVerificationRequest,
  ModelLiveVerificationResult,
  ModelProfile,
  ModelProviderConfig,
  ModelProviderEventMetadata,
  ModelProviderTransport,
  ModelRequest,
  ModelStreamEvent,
  ModelUsageCacheMetadata
} from "@deepseek/platform-contracts";
import {
  attachPipelineCacheEvidence,
  countWhitespaceTokens,
  isJsonObject,
  providerError,
  requestPipelineFingerprint,
  verifyByStreaming
} from "../../../shared/common.js";
import { glmAnthropicProviderConfig } from "./config.js";
import { createGlmAnthropicChunkNormalizer } from "./normalizer.js";
import { buildGlmAnthropicProviderRequest } from "./request.js";

export interface GlmAnthropicProviderOptions {
  readonly config?: ModelProviderConfig;
  readonly transport?: ModelProviderTransport;
  readonly credentials?: ModelCredentialProvider;
  readonly timeoutMs?: number;
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
    const explicitPrefixCacheHint = explicitPrefixCacheHintEvidence(request, providerRequest, this.config);
    const breakpointShape = anthropicCacheBreakpointShape(providerRequest.body);
    const normalize = createGlmAnthropicChunkNormalizer();
    let emittedDone = false;
    try {
      for await (const chunk of this.options.transport.stream(providerRequest, request.signal ? { signal: request.signal } : undefined)) {
        for (const event of normalize(chunk, provider)) {
          if (event.kind === "done") emittedDone = true;
          yield attachPipelineCacheEvidence(event, pipelineFingerprint, explicitPrefixCacheHint, breakpointShape);
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

  buildProviderRequest(request: ModelRequest, credentialValue = "") {
    return buildGlmAnthropicProviderRequest(request, credentialValue, this.options.timeoutMs, this.config);
  }

  private providerMetadata(profile: ModelProfile): ModelProviderEventMetadata {
    return {
      provider: this.config.provider,
      protocol: this.config.protocol,
      model: profile.model
    };
  }
}

function explicitPrefixCacheHintEvidence(
  request: ModelRequest,
  providerRequest: { readonly body: { readonly system?: unknown; readonly messages?: unknown; readonly tools?: unknown } },
  config: ModelProviderConfig
): ModelUsageCacheMetadata["explicitPrefixCacheHint"] | undefined {
  const pipeline = isJsonObject(request.metadata?.contextPipeline) ? request.metadata.contextPipeline : undefined;
  if (typeof pipeline?.pipelineFingerprint !== "string" || pipeline.pipelineFingerprint.length === 0) return undefined;
  if (!isJsonObject(pipeline.cacheHintSummary)) return undefined;
  const capability = request.profile.cacheHints ?? config.cacheHints;
  if (!capability?.explicitPrefixCacheHints) {
    return {
      status: "unsupported",
      reasonCode: "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_UNSUPPORTED",
      redaction: { class: "internal" }
    };
  }
  const sent = hasAnthropicCacheControl(providerRequest.body.system)
    || hasAnthropicCacheControl(providerRequest.body.messages)
    || hasAnthropicCacheControl(providerRequest.body.tools);
  return {
    status: sent ? "sent" : "missing",
    reasonCode: sent ? "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_SENT" : "PROVIDER_EXPLICIT_PREFIX_CACHE_HINT_MISSING",
    redaction: { class: "internal" }
  };
}

function hasAnthropicCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasAnthropicCacheControl(entry));
  if (!isJsonObject(value)) return false;
  if (isJsonObject(value.cache_control)) return true;
  return hasAnthropicCacheControl(value.content);
}

function anthropicCacheBreakpointShape(body: { readonly system?: unknown; readonly messages?: unknown; readonly tools?: unknown }): ModelUsageCacheMetadata["breakpointShape"] {
  const systemCacheControlCount = countAnthropicCacheControls(body.system);
  const messageCacheControlCount = countAnthropicCacheControls(body.messages);
  const toolCacheControlCount = countAnthropicCacheControls(body.tools);
  const messageCacheControlPositions = anthropicMessageCacheControlPositions(body.messages);
  return {
    systemCacheControlCount,
    messageCacheControlCount,
    toolCacheControlCount,
    totalCacheControlCount: systemCacheControlCount + messageCacheControlCount + toolCacheControlCount,
    ...(messageCacheControlPositions.length > 0 ? { messageCacheControlPositions } : {}),
    redaction: { class: "internal" }
  };
}

function anthropicMessageCacheControlPositions(messages: unknown): readonly ("first-message" | "middle-message" | "last-message")[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message, index) => {
    if (!hasAnthropicCacheControl(message)) return [];
    if (index === 0) return ["first-message" as const];
    if (index === messages.length - 1) return ["last-message" as const];
    return ["middle-message" as const];
  });
}

function countAnthropicCacheControls(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((total, entry) => total + countAnthropicCacheControls(entry), 0);
  if (!isJsonObject(value)) return 0;
  return (isJsonObject(value.cache_control) ? 1 : 0) + countAnthropicCacheControls(value.content);
}
