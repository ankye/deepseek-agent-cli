import type { JsonObject, JsonValue, ModelChatMessage, ModelProviderConfig, ModelProviderRequest, ModelRequest } from "@deepseek/platform-contracts";
import { formatAnthropicToolChoice, isJsonObject, numberValue, stringValue } from "../../../shared/common.js";
import { glmAnthropicProviderConfig } from "./config.js";

export function buildGlmAnthropicProviderRequest(request: ModelRequest, credentialValue = "", timeoutMs: number | undefined, config = glmAnthropicProviderConfig): ModelProviderRequest {
  const providerOptions = request.profile.providerOptions ?? {};
  const maxTokens = numberValue(providerOptions.max_tokens) ?? numberValue(providerOptions.maxTokens) ?? 1024;
  const { max_tokens: _maxTokensSnake, maxTokens: _maxTokensCamel, ...passthroughProviderOptions } = providerOptions;
  const effectiveTimeoutMs = request.timeoutMs ?? timeoutMs;
  const system = glmAnthropicSystemFrom(request, config);
  const tools = glmAnthropicToolsFrom(request, config);
  const explicitPrefixHintsEnabled = supportsExplicitPrefixHints(request, config);
  return {
    url: `${config.baseUrl.replace(/\/$/, "")}/v1/messages`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(explicitPrefixHintsEnabled ? { "anthropic-beta": "prompt-caching-2024-07-31" } : {}),
      ...(credentialValue ? { "x-api-key": credentialValue } : {}),
      ...(config.defaultHeaders ?? {})
    },
    body: {
      model: request.profile.model,
      messages: glmAnthropicMessagesFrom(request, config),
      stream: true,
      ...(request.profile.temperature !== undefined ? { temperature: request.profile.temperature } : {}),
      ...(system ? { system } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(request.toolChoice !== undefined ? { tool_choice: formatAnthropicToolChoice(request.toolChoice) } : {}),
      ...passthroughProviderOptions,
      max_tokens: maxTokens
    },
    ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {})
  };
}

function glmAnthropicSystemFrom(request: ModelRequest, config: ModelProviderConfig): JsonValue | undefined {
  const messages = request.messages ?? [];
  const systemMessages = messages
    .filter((message) => message.role === "system")
    .map((message) => ({ message, text: message.content.trim() }))
    .filter((entry) => entry.text.length > 0);
  if (systemMessages.length === 0) return undefined;
  if (!supportsExplicitPrefixHints(request, config)) return systemMessages.map((entry) => entry.text).join("\n\n");

  const breakpoint = cacheableProviderPrefixBreakpoint(request.messages ?? []);
  const cacheableSystemMessages = breakpoint?.role === "user"
    ? systemMessages.filter((entry) => isCacheableSystemPrefixMessage(entry.message))
    : systemMessages;
  if (cacheableSystemMessages.length === 0) return undefined;

  const systemBlocks: JsonObject[] = cacheableSystemMessages.map((entry) => ({
    type: "text",
    text: entry.text
  }));
  if (breakpoint?.role === "system") {
    const cacheIndex = cacheableSystemMessages.findIndex((entry) => entry.message === breakpoint.message);
    if (cacheIndex >= 0) {
      systemBlocks[cacheIndex] = {
        ...systemBlocks[cacheIndex]!,
        cache_control: anthropicEphemeralCacheControl()
      };
    }
  } else if (breakpoint?.role !== "user") {
    const cacheIndex = lastCacheableSystemPrefixIndex(cacheableSystemMessages.map((entry) => entry.message));
    if (cacheIndex >= 0) {
      systemBlocks[cacheIndex] = {
        ...systemBlocks[cacheIndex]!,
        cache_control: anthropicEphemeralCacheControl()
      };
    }
  }
  return systemBlocks;
}

function glmAnthropicMessagesFrom(request: ModelRequest, config: ModelProviderConfig): readonly JsonObject[] {
  const sourceMessages = request.messages && request.messages.length > 0
    ? request.messages
    : [{ role: "user" as const, content: request.prompt }];
  const messages: JsonObject[] = [];
  const breakpoint = supportsExplicitPrefixHints(request, config)
    ? cacheableProviderPrefixBreakpoint(sourceMessages)
    : undefined;
  const pendingDynamicSystemMessages: JsonObject[] = [];
  for (const message of sourceMessages) {
    if (message.role === "system") {
      if (breakpoint?.role === "user" && !isCacheableSystemPrefixMessage(message)) {
        pendingDynamicSystemMessages.push({
          role: "user",
          content: `Runtime guidance:\n${message.content}`
        });
      }
      continue;
    }
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
      const providerMessage: JsonObject = {
        role: message.role,
        content: message.content
      };
      if (message === breakpoint?.message) {
        messages.push(withMessageCacheBreakpoint(providerMessage));
        messages.push(...pendingDynamicSystemMessages.splice(0));
      } else {
        messages.push(providerMessage);
      }
    }
  }
  messages.push(...pendingDynamicSystemMessages);
  const providerMessages = messages.length === 0 ? [{ role: "user", content: request.prompt }] : messages;
  if (!supportsExplicitPrefixHints(request, config)) return providerMessages;
  if (breakpoint?.role === "user") return providerMessages;
  return providerMessages.length > 0
    ? withMessageTailCacheBreakpoint(providerMessages)
    : providerMessages;
}

function withMessageCacheBreakpoint(message: JsonObject): JsonObject {
  const content = messageContentWithCacheBreakpoint(message.content);
  return content ? { ...message, content } : message;
}

function cacheableProviderPrefixBreakpoint(messages: readonly ModelChatMessage[]): { readonly role: "system" | "user"; readonly message: ModelChatMessage } | undefined {
  const stableTaskPrompt = cacheableStableTaskPrompt(messages);
  if (stableTaskPrompt) return { role: "user", message: stableTaskPrompt };
  let breakpoint: { readonly role: "system" | "user"; readonly message: ModelChatMessage } | undefined;
  for (const message of messages) {
    if (!isCacheableProviderPrefixMessage(message)) break;
    breakpoint = { role: message.role, message };
  }
  return breakpoint;
}

function cacheableStableTaskPrompt(messages: readonly ModelChatMessage[]): ModelChatMessage | undefined {
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user" && isCacheableSystemPrefixMessage(message)) return message;
    return undefined;
  }
  return undefined;
}

function isCacheableProviderPrefixMessage(message: ModelChatMessage): message is ModelChatMessage & { readonly role: "system" | "user" } {
  if (message.role !== "system" && message.role !== "user") return false;
  return isCacheableSystemPrefixMessage(message);
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

function glmAnthropicToolsFrom(request: ModelRequest, config: ModelProviderConfig): readonly JsonObject[] {
  const tools = request.tools?.map(glmAnthropicToolFrom).filter((tool): tool is JsonObject => Boolean(tool)) ?? [];
  if (tools.length === 0 || !supportsExplicitPrefixHints(request, config)) return tools;
  return withToolSchemaCacheBreakpoint(tools);
}

function supportsExplicitPrefixHints(request: ModelRequest, config: ModelProviderConfig): boolean {
  const capability = request.profile.cacheHints ?? config.cacheHints;
  if (!capability?.explicitPrefixCacheHints) return false;
  const pipeline = isJsonObject(request.metadata?.contextPipeline) ? request.metadata.contextPipeline : undefined;
  if (!stringValue(pipeline?.pipelineFingerprint)) return false;
  const cacheHintSummary = isJsonObject(pipeline?.cacheHintSummary) ? pipeline.cacheHintSummary : undefined;
  return (numberValue(cacheHintSummary?.stable) ?? 0) > 0;
}

function withToolSchemaCacheBreakpoint(tools: readonly JsonObject[]): readonly JsonObject[] {
  const output = tools.map((tool) => ({ ...tool }));
  const last = output.at(-1);
  if (!last) return output;
  output[output.length - 1] = {
    ...last,
    cache_control: anthropicEphemeralCacheControl()
  };
  return output;
}

function lastCacheableSystemPrefixIndex(messages: readonly ModelChatMessage[]): number {
  let lastCacheable = -1;
  for (const [index, message] of messages.entries()) {
    if (!isCacheableSystemPrefixMessage(message)) break;
    lastCacheable = index;
  }
  return lastCacheable;
}

function isCacheableSystemPrefixMessage(message: ModelChatMessage): boolean {
  const hint = isJsonObject(message.cacheHint) ? message.cacheHint : undefined;
  const policy = stringValue(hint?.policy);
  return policy === "stable";
}

function withMessageTailCacheBreakpoint(messages: readonly JsonObject[], startIndex = 0): readonly JsonObject[] {
  const output = messages.map((message) => ({ ...message }));
  for (let index = output.length - 1; index >= Math.max(0, startIndex); index -= 1) {
    const message = output[index];
    if (!message) continue;
    const content = messageContentWithCacheBreakpoint(message.content);
    if (!content) continue;
    output[index] = { ...message, content };
    return output;
  }
  return output;
}

function messageContentWithCacheBreakpoint(content: JsonObject["content"]): JsonValue | undefined {
  if (typeof content === "string" && content.trim().length > 0) {
    return [{
      type: "text",
      text: content,
      cache_control: anthropicEphemeralCacheControl()
    }];
  }
  if (!Array.isArray(content)) return undefined;
  const blocks = content.map((block) => isJsonObject(block) ? { ...block } : block);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!isJsonObject(block) || block.type !== "text" || !stringValue(block.text)) continue;
    blocks[index] = {
      ...block,
      cache_control: anthropicEphemeralCacheControl()
    };
    return blocks as readonly JsonValue[];
  }
  return undefined;
}

function anthropicEphemeralCacheControl(): JsonObject {
  return { type: "ephemeral" };
}
