import type {
  DeepSeekAnthropicMessagesRequest,
  DeepSeekStrictToolSchemaValidationResult,
  JsonObject,
  JsonValue,
  ModelProviderConfig,
  ModelProviderRequest,
  ModelReasoningEffort,
  ModelReasoningProviderEffort,
  ModelToolChoice,
  RedactedError
} from "@deepseek/platform-contracts";
import { providerError } from "../../../shared/common.js";

export function buildDeepSeekAnthropicMessagesProviderRequest(
  request: DeepSeekAnthropicMessagesRequest,
  credentialValue: string,
  timeoutMs: number | undefined,
  config: ModelProviderConfig
): {
  readonly request?: ModelProviderRequest;
  readonly validation: DeepSeekStrictToolSchemaValidationResult;
} {
  const validation = validateDeepSeekAnthropicMessagesRequest(request);
  if (!validation.ok) return { validation };
  const reasoningEffort = request.reasoning?.enabled === false
    ? undefined
    : deepSeekReasoningEffort(request.reasoning?.providerEffort ?? request.reasoning?.effort);
  const effectiveTimeoutMs = request.timeoutMs ?? timeoutMs;
  return {
    validation,
    request: {
      url: `${config.baseUrl.replace(/\/$/, "")}/anthropic/messages`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(credentialValue ? { authorization: `Bearer ${credentialValue}` } : {}),
        ...(config.defaultHeaders ?? {}),
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
      ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {})
    }
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

function anthropicMessagesFrom(messages: DeepSeekAnthropicMessagesRequest["messages"]): readonly JsonObject[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: message.content
    }));
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

function formatAnthropicToolChoice(choice: ModelToolChoice): JsonValue {
  if (choice === "auto" || choice === "none") return { type: choice };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
}
