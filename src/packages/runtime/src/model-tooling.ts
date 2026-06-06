import type {
  AgentLoopRequest,
  CapabilityManifest,
  JsonObject,
  ModelProviderEventMetadata,
  RedactedError,
  RuntimeEvent,
  ToolFeedbackPreview,
  ToolFeedbackStatus,
  ToolResultFeedback,
  TraceContext
} from "@deepseek/platform-contracts";
import { redactSecretTextForRuntime } from "./errors.js";

export function modelToolSchema(manifest: CapabilityManifest): JsonObject {
  const safeName = toSafeToolName(String(manifest.id));
  return {
    type: "function",
    function: {
      name: safeName,
      description: manifest.description ?? manifest.name,
      parameters: manifest.inputSchema
    },
    metadata: {
      capabilityId: manifest.id,
      version: manifest.version,
      sideEffect: manifest.sideEffect,
      permissions: manifest.permissions,
      timeoutMs: manifest.timeoutMs ?? 30_000,
      replayPolicy: manifest.replayPolicy ?? {}
    }
  };
}

const TOOL_NAME_SAFE_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function toSafeToolName(capabilityId: string): string {
  if (TOOL_NAME_SAFE_PATTERN.test(capabilityId)) return capabilityId;
  return capabilityId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function resolveCapabilityId(providerToolName: string, manifests: readonly CapabilityManifest[]): string {
  const normalizedProviderToolName = normalizeProviderToolName(providerToolName);
  for (const manifest of manifests) {
    const id = String(manifest.id);
    if (id === providerToolName) return id;
    if (toSafeToolName(id) === providerToolName) return id;
    if (normalizeProviderToolName(id) === normalizedProviderToolName) return id;
  }
  return providerToolName;
}

function normalizeProviderToolName(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

export function providerMetadata(request: AgentLoopRequest): ModelProviderEventMetadata {
  return {
    provider: String(request.profile.providerId),
    protocol: "openai-chat-completions",
    model: request.profile.model
  };
}

export function modelToolResultText(event: RuntimeEvent | undefined): string {
  if (!event) return "Tool execution produced no terminal event.";
  if (event.error) return `Tool execution failed: ${event.error.message}`;
  const output = event.data.output;
  if (isJsonObjectForRuntime(output)) {
    const evidence = output.evidence;
    if (isJsonObjectForRuntime(evidence)) {
      const preview = evidence.preview;
      const status = typeof evidence.status === "string" ? evidence.status : "completed";
      const capabilityId = typeof event.data.capabilityId === "string" ? event.data.capabilityId : "tool";
      if (isJsonObjectForRuntime(preview) && typeof preview.text === "string") {
        return status === "completed" ? preview.text : `Tool ${capabilityId} reported ${status}:\n${preview.text}`;
      }
      return JSON.stringify({
        status,
        tool: evidence.tool ?? "",
        affectedPaths: evidence.affectedPaths ?? []
      });
    }
  }
  return JSON.stringify(event.data);
}

export function boundedModelText(value: string, limitBytes: number): string {
  const safe = redactSecretTextForRuntime(value);
  return Buffer.byteLength(safe, "utf8") > limitBytes ? truncateUtf8Text(safe, limitBytes) : safe;
}

export function isJsonObjectForRuntime(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toolFeedbackPreview(text: string, limitBytes: number): ToolFeedbackPreview {
  const safe = redactSecretTextForRuntime(text);
  const byteLength = Buffer.byteLength(safe, "utf8");
  const truncated = byteLength > limitBytes;
  return {
    text: truncated ? truncateUtf8Text(safe, limitBytes) : safe,
    byteLength,
    truncated,
    limitBytes,
    redaction: { class: "internal", fields: ["text"] }
  };
}

function truncateUtf8Text(text: string, limitBytes: number): string {
  const limit = Number.isFinite(limitBytes) ? Math.max(0, Math.floor(limitBytes)) : 0;
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const chunks: string[] = [];
  let bytes = 0;
  for (const character of text) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > limit) break;
    chunks.push(character);
    bytes += nextBytes;
  }
  return chunks.join("");
}

export interface ToolFeedbackInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly capabilityId?: string;
  readonly status: ToolFeedbackStatus;
  readonly text: string;
  readonly diagnostics: readonly RedactedError[];
  readonly trace: TraceContext;
  readonly limitBytes: number;
  readonly continuation?: "continue" | "terminate";
}

export function buildToolResultFeedback(input: ToolFeedbackInput): ToolResultFeedback {
  const continuation = input.continuation ?? defaultContinuationFor(input.status);
  return {
    schemaVersion: "1.0.0",
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
    status: input.status,
    preview: toolFeedbackPreview(input.text, input.limitBytes),
    diagnostics: input.diagnostics,
    trace: {
      traceId: String(input.trace.traceId),
      correlationId: String(input.trace.correlationId)
    },
    continuation,
    redaction: { class: "internal", fields: ["preview.text", "diagnostics.details"] }
  };
}

function defaultContinuationFor(status: ToolFeedbackStatus): "continue" | "terminate" {
  if (status === "failed" || status === "timeout" || status === "cancelled") return "terminate";
  return "continue";
}
