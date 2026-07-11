import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  MemoryEntry,
  MemoryManager,
  MemoryScope,
  SerializableResult,
  SessionId
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import { redactSecretText } from "@deepseek/policy-sandbox";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";

interface MemoryToolDeps {
  readonly memory?: MemoryManager;
}

interface MemoryWriteInput extends JsonObject {
  readonly scope: MemoryScope;
  readonly content: string;
  readonly sessionId?: string;
  readonly id?: string;
  readonly provenance?: JsonObject;
  readonly ttlMs?: number;
  readonly confidence?: number;
  readonly limitBytes?: number;
}

interface MemoryReadInput extends JsonObject {
  readonly scope: MemoryScope;
  readonly sessionId?: string;
  readonly limit?: number;
  readonly limitBytes?: number;
}

interface CoreMemoryRecord extends JsonObject {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly content: string;
  readonly provenance: JsonObject;
  readonly replayFingerprint: string;
  readonly redaction: { readonly class: "internal"; readonly fields: readonly string[] };
}

const memoryScopes: readonly MemoryScope[] = ["working", "session", "project", "user", "semantic", "skill"];

export function defineMemoryWriteTool(deps: MemoryToolDeps | undefined) {
  return defineToolManifest(
    "memory.write",
    coreToolIds.memoryWrite,
    "Memory Write",
    "write",
    ["memory:write"],
    objectSchema(["scope", "content"], {
      scope: { type: "string" },
      content: { type: "string" },
      sessionId: { type: "string" },
      id: { type: "string" },
      provenance: { type: "object" },
      ttlMs: { type: "number" },
      confidence: { type: "number" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => writeMemoryTool(input, context, deps)
  );
}

export function defineMemoryReadTool(deps: MemoryToolDeps | undefined) {
  return defineToolManifest(
    "memory.read",
    coreToolIds.memoryRead,
    "Memory Read",
    "read",
    ["memory:read"],
    objectSchema(["scope"], {
      scope: { type: "string" },
      sessionId: { type: "string" },
      limit: { type: "number" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => readMemoryTool(input, context, deps)
  );
}

async function writeMemoryTool(input: JsonObject, context: CapabilityExecutionContext, deps: MemoryToolDeps | undefined): Promise<SerializableResult<CoreToolResult>> {
  if (!deps?.memory) return failure("memory.write", "MEMORY_MANAGER_UNAVAILABLE", "MemoryManager is required for memory.write.", []);
  const parsed = input as MemoryWriteInput;
  const scope = parseScope(parsed.scope);
  if (!scope) return failure("memory.write", "MEMORY_SCOPE_INVALID", "scope must be one of working, session, project, user, semantic, or skill.", []);
  if (typeof parsed.content !== "string" || parsed.content.trim().length === 0) return failure("memory.write", "MEMORY_CONTENT_REQUIRED", "content is required.", []);
  const sessionId = typeof parsed.sessionId === "string" && parsed.sessionId ? asId<"session">(parsed.sessionId) : undefined;
  const content = redactSecretText(parsed.content);
  const entry: MemoryEntry = {
    id: asId<"memory">(typeof parsed.id === "string" && parsed.id ? parsed.id : `memory-${stableHash(`${scope}:${sessionId ?? ""}:${parsed.content}`)}`),
    scope,
    content,
    provenance: {
      source: "core.memory.write",
      contentHash: stableHash(parsed.content),
      ...(isJsonObject(parsed.provenance) ? parsed.provenance : {})
    },
    redaction: { class: "internal", fields: ["content", "provenance"] },
    ...(typeof parsed.ttlMs === "number" ? { ttlMs: parsed.ttlMs } : {}),
    ...(typeof parsed.confidence === "number" ? { confidence: parsed.confidence } : {})
  };
  await deps.memory.put(entry, sessionId);
  const record = memoryRecord(entry);
  return success("memory.write", [entry.id], {
    preview: boundedText(JSON.stringify(record), parsed.limitBytes),
    metadata: {
      familyId: "memory.read-write",
      action: "write",
      scope,
      ...(sessionId ? { sessionId } : {}),
      recordCount: 1,
      records: [record]
    },
    replay: replay(context)
  });
}

async function readMemoryTool(input: JsonObject, context: CapabilityExecutionContext, deps: MemoryToolDeps | undefined): Promise<SerializableResult<CoreToolResult>> {
  if (!deps?.memory) return failure("memory.read", "MEMORY_MANAGER_UNAVAILABLE", "MemoryManager is required for memory.read.", []);
  const parsed = input as MemoryReadInput;
  const scope = parseScope(parsed.scope);
  if (!scope) return failure("memory.read", "MEMORY_SCOPE_INVALID", "scope must be one of working, session, project, user, semantic, or skill.", []);
  const sessionId = typeof parsed.sessionId === "string" && parsed.sessionId ? asId<"session">(parsed.sessionId) : undefined;
  const limit = Math.max(0, Math.floor(parsed.limit ?? 50));
  const entries = (await deps.memory.query(scope, sessionId)).slice(0, limit);
  const records = entries.map(memoryRecord);
  return success("memory.read", records.map((record) => record.id), {
    preview: boundedText(JSON.stringify(records), parsed.limitBytes),
    metadata: {
      familyId: "memory.read-write",
      action: "read",
      scope,
      ...(sessionId ? { sessionId } : {}),
      recordCount: records.length,
      records,
      diagnostics: entries.length === limit && limit > 0 ? ["memory.read-write.output-bounded"] : []
    },
    replay: replay(context)
  });
}

function parseScope(value: unknown): MemoryScope | undefined {
  return typeof value === "string" && (memoryScopes as readonly string[]).includes(value) ? value as MemoryScope : undefined;
}

function memoryRecord(entry: MemoryEntry): CoreMemoryRecord {
  return {
    id: entry.id,
    scope: entry.scope,
    content: redactSecretText(entry.content),
    provenance: {
      ...entry.provenance,
      contentHash: typeof entry.provenance.contentHash === "string" ? entry.provenance.contentHash : stableHash(entry.content)
    },
    replayFingerprint: `memory.read-write:${stableHash(`${entry.id}:${entry.scope}:${entry.content}`)}`,
    redaction: { class: "internal", fields: ["content", "provenance"] }
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `h${(hash >>> 0).toString(16)}`;
}
