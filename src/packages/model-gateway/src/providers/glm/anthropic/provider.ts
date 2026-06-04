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
  ModelStreamEvent
} from "@deepseek/platform-contracts";
import {
  attachPipelineCacheEvidence,
  countWhitespaceTokens,
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
