import type {
  DeepSeekChatPrefixCompletionRequest,
  DeepSeekFimCompletionRequest,
  DeepSeekJsonOutputValidationResult,
  DeepSeekStrictToolSchemaValidationResult,
  JsonObject,
  JsonValue,
  ModelFinishReason,
  ModelProviderConfig,
  ModelProviderRequest,
  ModelRequest,
  ModelReasoningEffort,
  ModelReasoningProviderEffort,
  ModelToolChoice,
  RedactedError
} from "@deepseek/platform-contracts";
import {
  isJsonObject,
  numberValue,
  providerError,
  stringValue
} from "../../../shared/common.js";

export interface DeepSeekJsonOutputParseResult extends JsonObject {
  readonly ok: boolean;
  readonly value?: JsonValue;
  readonly retryable: boolean;
  readonly diagnostics: readonly RedactedError[];
}

export function buildDeepSeekOpenAIProviderRequest(
  request: ModelRequest,
  credentialValue: string,
  timeoutMs: number | undefined,
  config: ModelProviderConfig
): ModelProviderRequest {
  const reasoningEffort = request.reasoning?.enabled === false
    ? undefined
    : deepSeekReasoningEffort(request.reasoning?.providerEffort ?? request.reasoning?.effort);
  const providerCacheControl = providerCacheControlFor(request, config);
  const body: JsonObject = {
    model: request.profile.model,
    messages: providerMessagesFrom(request),
    stream: true,
    temperature: request.profile.temperature ?? 0,
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
    ...(request.toolChoice !== undefined ? { tool_choice: formatToolChoice(request.toolChoice) } : {}),
    ...(request.reasoning ? { thinking: { type: request.reasoning.enabled === false ? "disabled" : "enabled" } } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(validateDeepSeekJsonOutputRequest(request).ok && request.output?.format === "json_object" ? { response_format: { type: "json_object" } } : {}),
    ...(providerCacheControl ? { cache_control: providerCacheControl } : {}),
    ...(request.profile.providerOptions ? request.profile.providerOptions : {})
  };
  const effectiveTimeoutMs = request.timeoutMs ?? timeoutMs;

  return {
    url: `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(credentialValue ? { authorization: `Bearer ${credentialValue}` } : {}),
      ...(config.defaultHeaders ?? {})
    },
    body,
    ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {})
  };
}

export function buildDeepSeekStrictToolSchemaProviderRequest(
  request: ModelRequest,
  credentialValue: string,
  timeoutMs: number | undefined,
  config: ModelProviderConfig
): {
  readonly request?: ModelProviderRequest;
  readonly validation: DeepSeekStrictToolSchemaValidationResult;
} {
  const validation = validateDeepSeekStrictToolSchema(request.tools ?? []);
  if (!validation.ok) return { validation };
  const providerRequest = buildDeepSeekOpenAIProviderRequest(request, credentialValue, timeoutMs, config);
  return {
    validation,
    request: {
      ...providerRequest,
      url: `${config.baseUrl.replace(/\/$/, "")}/beta/chat/completions`,
      body: {
        ...providerRequest.body,
        tools: (request.tools ?? []).map((tool) => withStrictToolFlag(tool))
      }
    }
  };
}

export function buildDeepSeekChatPrefixCompletionProviderRequest(
  request: DeepSeekChatPrefixCompletionRequest,
  credentialValue: string,
  timeoutMs: number | undefined,
  config: ModelProviderConfig
): ModelProviderRequest {
  const reasoningEffort = request.reasoning?.enabled === false
    ? undefined
    : deepSeekReasoningEffort(request.reasoning?.providerEffort ?? request.reasoning?.effort);
  const effectiveTimeoutMs = request.timeoutMs ?? timeoutMs;
  return {
    url: `${config.baseUrl.replace(/\/$/, "")}/beta/chat/completions`,
    method: "POST",
    headers: headers(config, credentialValue),
    body: {
      model: request.profile.model,
      messages: [
        ...providerMessagesFrom({
          profile: request.profile,
          prompt: request.prompt,
          ...(request.messages ? { messages: request.messages } : {})
        }),
        {
          role: "assistant",
          content: request.prefix,
          prefix: true
        }
      ],
      stream: true,
      temperature: request.profile.temperature ?? 0,
      ...(request.reasoning ? { thinking: { type: request.reasoning.enabled === false ? "disabled" : "enabled" } } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(request.profile.providerOptions ? request.profile.providerOptions : {})
    },
    ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {})
  };
}

export function buildDeepSeekFimCompletionProviderRequest(
  request: DeepSeekFimCompletionRequest,
  credentialValue: string,
  timeoutMs: number | undefined,
  config: ModelProviderConfig
): ModelProviderRequest {
  const effectiveTimeoutMs = request.timeoutMs ?? timeoutMs;
  return {
    url: `${config.baseUrl.replace(/\/$/, "")}/beta/completions`,
    method: "POST",
    headers: headers(config, credentialValue),
    body: {
      model: request.profile.model,
      prompt: request.prompt,
      ...(request.suffix !== undefined ? { suffix: request.suffix } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      temperature: request.temperature ?? request.profile.temperature ?? 0,
      ...(request.profile.providerOptions ? request.profile.providerOptions : {})
    },
    ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {})
  };
}

export function validateDeepSeekJsonOutputRequest(request: Pick<ModelRequest, "prompt" | "messages" | "output">): DeepSeekJsonOutputValidationResult {
  if (request.output?.format !== "json_object") return { ok: true, mode: "request", retryable: false, diagnostics: [] };
  const content = [
    request.prompt,
    ...(request.messages ?? []).map((message) => message.content)
  ].join("\n");
  const diagnostics: RedactedError[] = [];
  if (!/\bjson\b/i.test(content)) {
    diagnostics.push(providerError("DEEPSEEK_JSON_PROMPT_GUARDRAIL_MISSING", "DeepSeek JSON output mode requires prompt or messages to explicitly mention JSON.", false));
  }
  if (request.output.maxParseRetries !== undefined && (!Number.isInteger(request.output.maxParseRetries) || request.output.maxParseRetries < 0)) {
    diagnostics.push(providerError("DEEPSEEK_JSON_RETRY_BUDGET_INVALID", "JSON output maxParseRetries must be a non-negative integer.", false));
  }
  return { ok: diagnostics.length === 0, mode: "request", retryable: false, diagnostics };
}

export function parseDeepSeekJsonOutputResponse(text: string, finishReason: ModelFinishReason = "stop"): DeepSeekJsonOutputParseResult {
  const trimmed = text.trim();
  const diagnostics: RedactedError[] = [];
  if (finishReason === "length") {
    diagnostics.push(providerError("DEEPSEEK_JSON_RESPONSE_TRUNCATED", "DeepSeek JSON output ended with finish_reason=length.", true));
  }
  if (!trimmed) {
    diagnostics.push(providerError("DEEPSEEK_JSON_RESPONSE_EMPTY", "DeepSeek JSON output was empty.", true));
    return { ok: false, retryable: true, diagnostics };
  }
  try {
    const value = JSON.parse(trimmed) as JsonValue;
    if (!isJsonObject(value)) {
      diagnostics.push(providerError("DEEPSEEK_JSON_RESPONSE_NOT_OBJECT", "DeepSeek JSON output must parse to a JSON object.", true));
      return { ok: false, retryable: true, diagnostics };
    }
    if (diagnostics.length > 0) return { ok: false, value, retryable: true, diagnostics };
    return { ok: true, value, retryable: false, diagnostics };
  } catch (error) {
    diagnostics.push(providerError("DEEPSEEK_JSON_RESPONSE_PARSE_FAILED", error instanceof Error ? error.message : "DeepSeek JSON output parse failed.", true));
    return { ok: false, retryable: true, diagnostics };
  }
}

export function validateDeepSeekStrictToolSchema(tools: readonly JsonObject[]): DeepSeekStrictToolSchemaValidationResult {
  const unsupportedKeywordPaths: string[] = [];
  const diagnostics: RedactedError[] = [];
  for (const [index, tool] of tools.entries()) {
    if (tool.type !== "function" || !isJsonObject(tool.function)) {
      diagnostics.push(providerError("DEEPSEEK_STRICT_TOOL_SHAPE_INVALID", `Tool at index ${index} must be an OpenAI function tool.`, false));
      continue;
    }
    const fn = tool.function;
    if (typeof fn.name !== "string" || !fn.name) {
      diagnostics.push(providerError("DEEPSEEK_STRICT_TOOL_NAME_INVALID", `Tool at index ${index} must include function.name.`, false));
    }
    if (!isJsonObject(fn.parameters)) {
      diagnostics.push(providerError("DEEPSEEK_STRICT_TOOL_PARAMETERS_INVALID", `Tool at index ${index} must include object function.parameters.`, false));
      continue;
    }
    collectUnsupportedJsonSchemaKeywords(fn.parameters, `tools[${index}].function.parameters`, unsupportedKeywordPaths);
  }
  if (unsupportedKeywordPaths.length > 0) {
    diagnostics.push(providerError("DEEPSEEK_STRICT_TOOL_SCHEMA_UNSUPPORTED_KEYWORD", "Strict DeepSeek tool schemas cannot use unsupported JSON Schema composition/reference keywords.", false, { unsupportedKeywordPaths }));
  }
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    unsupportedKeywordPaths
  };
}

export function formatToolChoice(choice: ModelToolChoice): JsonValue {
  if (choice === "auto" || choice === "required" || choice === "none") return choice;
  return { type: "function", function: { name: choice.name } };
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

function providerMessagesFrom(request: ModelRequest): readonly JsonObject[] {
  const sourceMessages = request.messages && request.messages.length > 0
    ? request.messages
    : [{ role: "user" as const, content: request.prompt }];
  const pendingToolCallIds = new Set<string>();
  const messages: JsonObject[] = [];
  for (const message of sourceMessages) {
    if (message.role === "tool") {
      const toolCallId = message.toolCallId ?? "";
      if (toolCallId && pendingToolCallIds.has(toolCallId)) {
        pendingToolCallIds.delete(toolCallId);
        messages.push({
          role: "tool",
          content: message.content,
          tool_call_id: toolCallId
        });
      } else {
        messages.push({
          role: "user",
          content: `Internal tool feedback (${message.toolName ?? "tool"}):\n${message.content}`
        });
      }
      continue;
    }
    const toolCalls = message.toolCalls?.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.input)
      }
    }));
    for (const toolCall of message.toolCalls ?? []) pendingToolCallIds.add(toolCall.id);
    const reasoningContent = typeof (message as { reasoningContent?: unknown }).reasoningContent === "string"
      ? (message as { reasoningContent: string }).reasoningContent
      : undefined;
    messages.push({
      role: message.role,
      content: toolCalls && toolCalls.length > 0 && message.content.length === 0 ? null : message.content,
      ...(reasoningContent && reasoningContent.length > 0 ? { reasoning_content: reasoningContent } : {}),
      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    });
  }
  return messages;
}

function providerCacheControlFor(request: ModelRequest, config: ModelProviderConfig): JsonObject | undefined {
  const capability = request.profile.cacheHints ?? config.cacheHints;
  if (!capability?.explicitPrefixCacheHints) return undefined;
  const pipeline = isJsonObject(request.metadata?.contextPipeline) ? request.metadata.contextPipeline : undefined;
  const pipelineFingerprint = stringValue(pipeline?.pipelineFingerprint);
  const cacheHintSummary = isJsonObject(pipeline?.cacheHintSummary) ? pipeline.cacheHintSummary : undefined;
  if (!pipelineFingerprint || !cacheHintSummary) return undefined;
  return {
    type: "deepseek-prefix-cache",
    pipeline_fingerprint: pipelineFingerprint,
    stable_blocks: numberValue(cacheHintSummary.stable) ?? 0,
    ephemeral_blocks: numberValue(cacheHintSummary.ephemeral) ?? 0,
    no_store_blocks: numberValue(cacheHintSummary.noStore) ?? 0,
    ttl_blocks: numberValue(cacheHintSummary.ttlBound) ?? 0,
    ...(capability.maxCacheHintBlocks !== undefined ? { max_hint_blocks: capability.maxCacheHintBlocks } : {})
  };
}

function headers(config: ModelProviderConfig, credentialValue = ""): JsonObject {
  return {
    "content-type": "application/json",
    ...(credentialValue ? { authorization: `Bearer ${credentialValue}` } : {}),
    ...(config.defaultHeaders ?? {})
  };
}

function withStrictToolFlag(tool: JsonObject): JsonObject {
  if (tool.type !== "function" || !isJsonObject(tool.function)) return tool;
  return {
    ...tool,
    function: {
      ...tool.function,
      strict: true
    }
  };
}

function collectUnsupportedJsonSchemaKeywords(value: JsonValue | undefined, path: string, paths: string[]): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) collectUnsupportedJsonSchemaKeywords(item, `${path}[${index}]`, paths);
    return;
  }
  if (!isJsonObject(value)) return;
  const unsupported = new Set(["$ref", "oneOf", "anyOf", "allOf", "not", "if", "then", "else", "dependentRequired", "dependentSchemas", "patternProperties", "unevaluatedProperties", "unevaluatedItems", "contains"]);
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (unsupported.has(key)) paths.push(childPath);
    collectUnsupportedJsonSchemaKeywords(child, childPath, paths);
  }
}
