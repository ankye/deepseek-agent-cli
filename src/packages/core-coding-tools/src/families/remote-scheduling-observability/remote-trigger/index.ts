import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  RemoteBinding,
  RemoteRuntimeConnectivity,
  SerializableResult,
  SessionId
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { requireDeps } from "../../../shared/workspace.js";

interface RemoteTriggerToolDeps extends CoreCodingToolsDependencies {
  readonly remote?: RemoteRuntimeConnectivity;
}

type RemoteAction = "bind" | "connect" | "reconnect" | "cancel" | "disconnect";

export function defineRemoteTriggerTool(deps: RemoteTriggerToolDeps | undefined) {
  return defineToolManifest(
    "remote.trigger",
    coreToolIds.remoteTrigger,
    "Remote Trigger",
    "none",
    ["remote:connect"],
    objectSchema([], {
      action: { type: "string" },
      id: { type: "string" },
      sessionId: { type: "string" },
      transport: { type: "string" },
      trustedDevice: { type: "object" },
      reason: { type: "string" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => remoteTriggerTool(input, context, ready as RemoteTriggerToolDeps))
  );
}

async function remoteTriggerTool(input: JsonObject, context: CapabilityExecutionContext, deps: RemoteTriggerToolDeps): Promise<SerializableResult<CoreToolResult>> {
  if (!deps.remote) return failure("remote.trigger", "REMOTE_RUNTIME_UNAVAILABLE", "RemoteRuntimeConnectivity is required for remote.trigger.", []);
  const action = remoteAction(input.action);
  const id = stringValue(input.id) ?? `remote:${context.envelope.invocationId}`;
  if (action === "bind" || action === "connect") {
    const binding: RemoteBinding = {
      id,
      sessionId: sessionIdFor(input, context),
      transport: remoteTransport(input.transport),
      trustedDevice: isJsonObject(input.trustedDevice) ? input.trustedDevice : { kind: "core-tool", trusted: true }
    };
    await deps.remote.bind(binding);
    return remoteSuccess("bound", action, id, binding, context);
  }
  if (action === "cancel" || action === "disconnect") {
    const reason = stringValue(input.reason) ?? "remote-trigger";
    await deps.remote.cancelRemote(id, reason);
    return remoteSuccess("cancelled", action, id, { reason }, context);
  }
  const binding = await deps.remote.reconnect(id);
  return remoteSuccess(binding ? "connected" : "missing", action, id, binding ?? null, context);
}

function remoteSuccess(status: string, action: RemoteAction, id: string, result: JsonObject | RemoteBinding | null, context: CapabilityExecutionContext): SerializableResult<CoreToolResult> {
  return success("remote.trigger", [id], {
    preview: boundedText(`${action} ${id}: ${status}`, 2_000),
    metadata: {
      action,
      id,
      status,
      result: result as JsonObject | null
    },
    replay: replay(context),
    status: status === "missing" ? "failed" : "completed"
  });
}

function sessionIdFor(input: JsonObject, context: CapabilityExecutionContext): SessionId {
  const sessionId = stringValue(input.sessionId);
  return sessionId ? asId<"session">(sessionId) : context.envelope.sessionId ?? asId<"session">("session-remote-trigger");
}

function remoteAction(value: unknown): RemoteAction {
  if (value === "bind" || value === "connect" || value === "cancel" || value === "disconnect") return value;
  return "reconnect";
}

function remoteTransport(value: unknown): RemoteBinding["transport"] {
  if (value === "relay" || value === "ide-bridge") return value;
  return "local-server";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
