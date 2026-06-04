import type {
  JsonObject,
  ModelProviderEventMetadata,
  ModelProviderResponseChunk,
  ModelStreamEvent
} from "@deepseek/platform-contracts";
import {
  isJsonObject,
  normalizeAnthropicStopReason,
  numberValue,
  parseToolInput,
  providerError,
  stringValue,
  usageEvent
} from "../../../shared/common.js";

interface ToolCallFragment {
  id?: string;
  name?: string;
  argumentsBuffer: string;
  argumentsIsString: boolean;
  argumentsObject?: JsonObject;
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
      events.push(usageEvent(inputTokens, outputTokens, cacheReadInputTokens, requestProvider(provider)));
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
