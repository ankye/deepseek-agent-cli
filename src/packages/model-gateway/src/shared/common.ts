import type {
  JsonObject,
  JsonValue,
  ModelFinishReason,
  ModelGateway,
  ModelLiveVerificationRequest,
  ModelLiveVerificationResult,
  ModelProviderEventMetadata,
  ModelRequest,
  ModelStreamEvent,
  ModelToolChoice,
  ModelUsageMetadata,
  RedactedError
} from "@deepseek/platform-contracts";

export function providerError(code: string, message: string, retryable: boolean, details: JsonObject = {}): RedactedError {
  return {
    code,
    message,
    retryable,
    redaction: { class: "public" },
    ...(Object.keys(details).length > 0 ? { details } : {})
  };
}

export function attachPipelineCacheEvidence(event: ModelStreamEvent, pipelineFingerprint: string | undefined): ModelStreamEvent {
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

export function requestPipelineFingerprint(metadata: JsonObject | undefined): string | undefined {
  const direct = metadata?.pipelineFingerprint;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const pipeline = metadata?.contextPipeline;
  if (isJsonObject(pipeline) && typeof pipeline.pipelineFingerprint === "string" && pipeline.pipelineFingerprint.length > 0) {
    return pipeline.pipelineFingerprint;
  }
  return undefined;
}

export async function verifyByStreaming(gateway: ModelGateway, request: ModelLiveVerificationRequest): Promise<ModelLiveVerificationResult> {
  const started = Date.now();
  const eventKinds: string[] = [];
  const diagnostics: RedactedError[] = [];
  let usage: ModelLiveVerificationResult["usage"];
  let providerMetadata: ModelProviderEventMetadata | undefined;
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
    const eventProvider = event.kind === "usage" ? event.metadata?.provider : event.provider;
    providerMetadata = providerMetadata ?? eventProvider;
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
    provider: providerMetadata ?? { provider: "deepseek", protocol: "openai-chat-completions", model: request.profile.model },
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

export function redactProviderError(error: RedactedError): RedactedError {
  return {
    ...error,
    message: error.message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]").replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]"),
    redaction: { class: "public" }
  };
}

export function countWhitespaceTokens(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseToolInput(value: unknown): JsonObject {
  if (isJsonObject(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonObject(parsed) ? parsed : { value: parsed as JsonValue };
  } catch {
    return { raw: value };
  }
}

export function normalizeAnthropicStopReason(value: unknown): ModelFinishReason | undefined {
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

export function formatAnthropicToolChoice(choice: ModelToolChoice): JsonValue {
  if (choice === "auto" || choice === "none") return { type: choice };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
}

export function usageEvent(inputTokens: number, outputTokens: number, cacheReadInputTokens: number | undefined, provider: ModelProviderEventMetadata): ModelStreamEvent {
  const metadata: ModelUsageMetadata = {
    inputTokens,
    outputTokens,
    ...(cacheReadInputTokens !== undefined ? { cache: { hitTokens: cacheReadInputTokens } } : {}),
    provider
  };
  return {
    kind: "usage",
    inputTokens,
    outputTokens,
    metadata
  };
}
