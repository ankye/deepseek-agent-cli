import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult,
  SessionId,
  SessionStore
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";

interface SessionToolDeps {
  readonly sessions?: SessionStore;
}

interface SessionResumeInput extends JsonObject {
  readonly sessionId: string;
  readonly limitBytes?: number;
}

interface SessionForkInput extends JsonObject {
  readonly parentSessionId: string;
  readonly forkPointSequence?: number;
  readonly reason?: string;
  readonly metadata?: JsonObject;
  readonly limitBytes?: number;
}

export function defineSessionResumeTool(deps: SessionToolDeps | undefined) {
  return defineToolManifest(
    "session.resume",
    coreToolIds.sessionResume,
    "Session Resume",
    "read",
    ["session:read"],
    objectSchema(["sessionId"], { sessionId: { type: "string" }, limitBytes: { type: "number" } }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => resumeSessionTool(input, context, deps)
  );
}

export function defineSessionForkTool(deps: SessionToolDeps | undefined) {
  return defineToolManifest(
    "session.fork",
    coreToolIds.sessionFork,
    "Session Fork",
    "write",
    ["session:read", "session:write"],
    objectSchema(["parentSessionId"], {
      parentSessionId: { type: "string" },
      forkPointSequence: { type: "number" },
      reason: { type: "string" },
      metadata: { type: "object" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => forkSessionTool(input, context, deps)
  );
}

async function resumeSessionTool(input: JsonObject, context: CapabilityExecutionContext, deps: SessionToolDeps | undefined): Promise<SerializableResult<CoreToolResult>> {
  if (!deps?.sessions) return failure("session.resume", "SESSION_STORE_UNAVAILABLE", "SessionStore is required for session.resume.", []);
  const parsed = input as SessionResumeInput;
  if (typeof parsed.sessionId !== "string" || parsed.sessionId.trim().length === 0) {
    return failure("session.resume", "SESSION_ID_REQUIRED", "sessionId is required.", []);
  }
  const sessionId = asId<"session">(parsed.sessionId);
  const result = await deps.sessions.resume(sessionId);
  if (!result.ok || !result.value) {
    return failure("session.resume", result.error?.code ?? "SESSION_RESUME_REJECTED", result.error?.message ?? "Session resume rejected.", [sessionId]);
  }
  const metadata = {
    familyId: "session.resume-fork",
    action: "resume",
    sessionId,
    eventCount: result.value.eventCount,
    latestSequence: result.value.latestSequence,
    lineage: result.value.lineage,
    hasSnapshot: Boolean(result.value.snapshot)
  };
  return success("session.resume", [sessionId], {
    preview: boundedText(JSON.stringify(result.value.preview ?? metadata), parsed.limitBytes),
    metadata,
    replay: replay(context)
  });
}

async function forkSessionTool(input: JsonObject, context: CapabilityExecutionContext, deps: SessionToolDeps | undefined): Promise<SerializableResult<CoreToolResult>> {
  if (!deps?.sessions) return failure("session.fork", "SESSION_STORE_UNAVAILABLE", "SessionStore is required for session.fork.", []);
  const parsed = input as SessionForkInput;
  if (typeof parsed.parentSessionId !== "string" || parsed.parentSessionId.trim().length === 0) {
    return failure("session.fork", "PARENT_SESSION_ID_REQUIRED", "parentSessionId is required.", []);
  }
  const parentSessionId = asId<"session">(parsed.parentSessionId);
  const result = await deps.sessions.fork({
    parentSessionId,
    ...(typeof parsed.forkPointSequence === "number" ? { forkPointSequence: parsed.forkPointSequence } : {}),
    ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
    ...(isJsonObject(parsed.metadata) ? { metadata: parsed.metadata } : {})
  });
  if (!result.ok || !result.value) {
    return failure("session.fork", result.error?.code ?? "SESSION_FORK_REJECTED", result.error?.message ?? "Session fork rejected.", [parentSessionId]);
  }
  const metadata = {
    familyId: "session.resume-fork",
    action: "fork",
    parentSessionId: result.value.parentSessionId,
    childSessionId: result.value.childSessionId,
    forkPointSequence: result.value.forkPointSequence,
    inheritedEventCount: result.value.inheritedEventCount,
    lineage: result.value.lineage
  };
  return success("session.fork", [result.value.parentSessionId, result.value.childSessionId], {
    preview: boundedText(JSON.stringify(metadata), parsed.limitBytes),
    metadata,
    replay: replay(context)
  });
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
