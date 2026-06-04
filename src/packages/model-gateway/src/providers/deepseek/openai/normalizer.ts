import type {
  JsonObject,
  ModelFinishReason,
  ModelProviderEventMetadata,
  ModelProviderResponseChunk,
  ModelStreamEvent,
  ModelUsageMetadata
} from "@deepseek/platform-contracts";
import {
  isJsonObject,
  numberValue,
  parseToolInput,
  providerError,
  stringValue
} from "../../../shared/common.js";

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
