import type { JsonObject, ModelProviderRequest, ModelRequest } from "@deepseek/platform-contracts";
import { formatAnthropicToolChoice, isJsonObject, numberValue, stringValue } from "../../../shared/common.js";
import { glmAnthropicProviderConfig } from "./config.js";

export function buildGlmAnthropicProviderRequest(request: ModelRequest, credentialValue = "", timeoutMs: number | undefined, config = glmAnthropicProviderConfig): ModelProviderRequest {
  const providerOptions = request.profile.providerOptions ?? {};
  const maxTokens = numberValue(providerOptions.max_tokens) ?? numberValue(providerOptions.maxTokens) ?? 1024;
  const { max_tokens: _maxTokensSnake, maxTokens: _maxTokensCamel, ...passthroughProviderOptions } = providerOptions;
  const effectiveTimeoutMs = request.timeoutMs ?? timeoutMs;
  return {
    url: `${config.baseUrl.replace(/\/$/, "")}/v1/messages`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(credentialValue ? { "x-api-key": credentialValue } : {}),
      ...(config.defaultHeaders ?? {})
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
    ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {})
  };
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
