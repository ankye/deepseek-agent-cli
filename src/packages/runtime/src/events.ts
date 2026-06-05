import type {
  AgentId,
  JsonObject,
  ModelUsageMetadata,
  RuntimeDependencies,
  RuntimeEvent,
  SessionId,
  TraceContext
} from "@deepseek/platform-contracts";
import { redactJsonSecrets } from "@deepseek/policy-sandbox";
import { stableHash } from "./trace.js";

const DETERMINISTIC_EVENT_CREATED_AT = new Date(0).toISOString();

export async function collectRuntimeEvents(iterable: AsyncIterable<RuntimeEvent>): Promise<readonly RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

export function lastRuntimeEvent(events: readonly RuntimeEvent[], predicate: (event: RuntimeEvent) => boolean): RuntimeEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && predicate(event)) return event;
  }
  return undefined;
}

export function projectionRuntimeEvent(
  kind: Extract<RuntimeEvent["kind"], `context.projection.${string}`>,
  sessionId: SessionId,
  trace: TraceContext,
  data: JsonObject,
  agentId?: AgentId,
  error?: import("@deepseek/platform-contracts").RedactedError
): RuntimeEvent {
  return {
    kind,
    sessionId,
    ...(agentId ? { agentId } : {}),
    createdAt: DETERMINISTIC_EVENT_CREATED_AT,
    trace,
    data: redactJsonSecrets(data) as JsonObject,
    ...(error ? { error } : {})
  };
}

export function agentLoopEvent(
  kind: RuntimeEvent["kind"],
  sessionId: SessionId,
  turnId: import("@deepseek/platform-contracts").TurnId,
  trace: TraceContext,
  data: JsonObject,
  agentId?: AgentId,
  error?: import("@deepseek/platform-contracts").RedactedError
): RuntimeEvent {
  return {
    kind,
    sessionId,
    turnId,
    ...(agentId ? { agentId } : {}),
    createdAt: DETERMINISTIC_EVENT_CREATED_AT,
    trace,
    data: redactJsonSecrets(data) as JsonObject,
    ...(error ? { error } : {})
  };
}

export async function recordRuntimeAdapterEvent(deps: RuntimeDependencies, event: RuntimeEvent): Promise<void> {
  const events = await deps.sessions.events(event.sessionId);
  await deps.sessions.append({
    sessionId: event.sessionId,
    sequence: events.length + 1,
    kind: event.kind,
    at: event.createdAt,
    payload: event.data,
    redaction: { class: "internal" }
  });
  await deps.bus.publish({
    protocolVersion: "1",
    schemaVersion: "1.0.0",
    id: `bus-${stableHash(`${event.kind}:${event.sessionId}:${events.length + 1}`)}`,
    type: "event",
    createdAt: event.createdAt,
    trace: event.trace,
    redaction: { class: "internal" },
    compatibility: { schemaVersion: "1.0.0" },
    payload: {
      kind: event.kind,
      data: event.data,
      ...(event.error ? { error: event.error } : {})
    },
    topic: { name: "runtime.event", owner: "runtime", trustBoundary: "core" },
    producer: "runtime-context-projection",
    correlationId: event.trace.correlationId,
    sessionId: event.sessionId,
    replayable: true
  });
  await deps.observability.emit({
    kind: event.kind.startsWith("agent.repair.") ? "repair" : event.kind === "context.projection.rejected" ? "audit" : "trace",
    at: event.createdAt,
    name: event.kind,
    fields: event.data
  });
}

export async function recordRuntimeModelRequestAudit(
  deps: RuntimeDependencies,
  event: RuntimeEvent,
  metadata: {
    readonly phase: string;
    readonly requestCount: number;
    readonly providerId?: string;
    readonly model: string;
    readonly promptAssemblyFingerprint?: string;
    readonly taskDeliveryFlow?: JsonObject;
  }
): Promise<void> {
  await deps.observability.emit({
    kind: "audit",
    at: event.createdAt,
    name: "model.request.audit",
    trace: event.trace,
    dataPrivacyClass: "local",
    fields: {
      schemaVersion: "1.0.0",
      sessionId: event.sessionId,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      phase: metadata.phase,
      requestCount: metadata.requestCount,
      ...(metadata.providerId ? { providerId: metadata.providerId } : {}),
      model: metadata.model,
      ...(metadata.promptAssemblyFingerprint ? { promptAssemblyFingerprint: metadata.promptAssemblyFingerprint } : {}),
      ...(metadata.taskDeliveryFlow ? { taskDeliveryFlow: metadata.taskDeliveryFlow } : {}),
      redaction: { class: "internal", fields: ["promptAssemblyFingerprint"] }
    },
    redaction: { class: "internal", fields: ["fields.promptAssemblyFingerprint"] }
  });
}

export async function recordRuntimeModelUsageAudit(
  deps: RuntimeDependencies,
  event: RuntimeEvent,
  usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly metadata?: ModelUsageMetadata;
  }
): Promise<void> {
  await deps.usage.record({
    sessionId: event.sessionId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costMicros: 0,
    elapsedMs: 0
  });
  const provider = usage.metadata?.provider;
  const cache = usage.metadata?.cache;
  const totalTokens = usage.inputTokens + usage.outputTokens;
  await deps.observability.emit({
    kind: "audit",
    at: event.createdAt,
    name: "model.usage.audit",
    trace: event.trace,
    dataPrivacyClass: "local",
    fields: {
      schemaVersion: "1.0.0",
      sessionId: event.sessionId,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens,
      usageStatus: "provider-reported",
      ...(usage.metadata?.reasoningTokens !== undefined ? { reasoningTokens: usage.metadata.reasoningTokens } : {}),
      ...(cache ? { cache } : {}),
      ...(provider?.provider ? { provider: provider.provider } : {}),
      ...(provider?.protocol ? { protocol: provider.protocol } : {}),
      ...(provider?.model ? { model: provider.model } : {}),
      ...(provider?.requestId ? { providerRequestId: provider.requestId } : {}),
      redaction: { class: "internal", fields: ["cache"] }
    },
    redaction: { class: "internal", fields: ["fields.cache"] }
  });
}
