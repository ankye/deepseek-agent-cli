import type {
  DeepSeekAnthropicMessagesRequest,
  DeepSeekChatPrefixCompletionRequest,
  DeepSeekFimCompletionRequest,
  DeepSeekStrictToolSchemaValidationResult,
  ModelCredentialProvider,
  ModelGateway,
  ModelLiveVerificationRequest,
  ModelLiveVerificationResult,
  ModelProfile,
  ModelProviderConfig,
  ModelProviderEventMetadata,
  ModelProviderRequest,
  ModelProviderTransport,
  ModelRequest,
  ModelStreamEvent
} from "@deepseek/platform-contracts";
import { buildDeepSeekAnthropicMessagesProviderRequest } from "../anthropic/index.js";
import {
  attachPipelineCacheEvidence,
  countWhitespaceTokens,
  providerError,
  requestPipelineFingerprint,
  verifyByStreaming
} from "../../../shared/common.js";
import { deepSeekOpenAIProviderConfig } from "./config.js";
import {
  createToolCallAccumulator,
  normalizeDeepSeekChunk
} from "./normalizer.js";
import {
  buildDeepSeekChatPrefixCompletionProviderRequest,
  buildDeepSeekFimCompletionProviderRequest,
  buildDeepSeekOpenAIProviderRequest,
  buildDeepSeekStrictToolSchemaProviderRequest
} from "./request.js";

export interface DeepSeekOpenAIProviderOptions {
  readonly config?: ModelProviderConfig;
  readonly transport?: ModelProviderTransport;
  readonly credentials?: ModelCredentialProvider;
  readonly timeoutMs?: number;
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
    return buildDeepSeekOpenAIProviderRequest(request, credentialValue, this.options.timeoutMs, this.config);
  }

  buildStrictToolSchemaProviderRequest(request: ModelRequest, credentialValue = ""): {
    readonly request?: ModelProviderRequest;
    readonly validation: DeepSeekStrictToolSchemaValidationResult;
  } {
    return buildDeepSeekStrictToolSchemaProviderRequest(request, credentialValue, this.options.timeoutMs, this.config);
  }

  buildChatPrefixCompletionProviderRequest(request: DeepSeekChatPrefixCompletionRequest, credentialValue = ""): ModelProviderRequest {
    return buildDeepSeekChatPrefixCompletionProviderRequest(request, credentialValue, this.options.timeoutMs, this.config);
  }

  buildFimCompletionProviderRequest(request: DeepSeekFimCompletionRequest, credentialValue = ""): ModelProviderRequest {
    return buildDeepSeekFimCompletionProviderRequest(request, credentialValue, this.options.timeoutMs, this.config);
  }

  buildAnthropicMessagesProviderRequest(request: DeepSeekAnthropicMessagesRequest, credentialValue = ""): {
    readonly request?: ModelProviderRequest;
    readonly validation: DeepSeekStrictToolSchemaValidationResult;
  } {
    return buildDeepSeekAnthropicMessagesProviderRequest(request, credentialValue, this.options.timeoutMs, this.config);
  }

  private providerMetadata(profile: ModelProfile): ModelProviderEventMetadata {
    return {
      provider: this.config.provider,
      protocol: this.config.protocol,
      model: profile.model
    };
  }
}
