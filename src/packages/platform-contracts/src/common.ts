import type { CorrelationId, SessionId, SpanId, TraceId } from "./ids.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue | undefined };

export interface CompatibilityMetadata extends JsonObject {
  readonly schemaVersion: string;
  readonly minReaderVersion?: string;
  readonly migrationId?: string;
  readonly deprecated?: boolean;
}

export interface TraceContext extends JsonObject {
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly parentSpanId?: SpanId;
  readonly correlationId: CorrelationId;
  readonly sessionId?: SessionId;
}

export type RedactionClass = "public" | "internal" | "sensitive" | "secret";

export interface RedactionMetadata extends JsonObject {
  readonly class: RedactionClass;
  readonly fields?: readonly string[];
}

export interface VersionedEnvelope<TType extends string, TPayload extends JsonValue | undefined = JsonObject> {
  readonly protocolVersion: string;
  readonly schemaVersion: string;
  readonly id: string;
  readonly type: TType;
  readonly createdAt: string;
  readonly trace: TraceContext;
  readonly redaction: RedactionMetadata;
  readonly compatibility: CompatibilityMetadata;
  readonly payload: TPayload;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly cursor?: string;
}

export interface SerializableResult<T extends JsonValue = JsonObject> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: RedactedError;
}

export interface RedactedError extends JsonObject {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly suggestedActions?: readonly string[];
  readonly redaction: RedactionMetadata;
  readonly details?: JsonObject;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly RedactedError[];
}

export interface Clock {
  now(): Date;
}

export interface Disposable {
  dispose(): Promise<void> | void;
}

export interface AsyncEventSource<T> {
  events(): AsyncIterable<T>;
}
