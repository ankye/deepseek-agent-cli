import type {
  CapabilityExecutionContext,
  CoreCodingToolName,
  CoreToolResult,
  JsonObject,
  SerializableResult,
  SessionEvent,
  SessionId,
  SessionStore
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { requireDeps } from "../../../shared/workspace.js";

type PlanModeOperation = "enter" | "exit";

export interface ModePlanToolDeps extends CoreCodingToolsDependencies {
  readonly sessions?: SessionStore;
}

export function defineModePlanEnterTool(deps: ModePlanToolDeps | undefined) {
  return modePlanTool("mode.plan.enter", coreToolIds.modePlanEnter, "Mode Plan Enter", "enter", deps);
}

export function defineModePlanExitTool(deps: ModePlanToolDeps | undefined) {
  return modePlanTool("mode.plan.exit", coreToolIds.modePlanExit, "Mode Plan Exit", "exit", deps);
}

function modePlanTool(
  toolName: "mode.plan.enter" | "mode.plan.exit",
  id: typeof coreToolIds[keyof typeof coreToolIds],
  name: string,
  operation: PlanModeOperation,
  deps: ModePlanToolDeps | undefined
) {
  return defineToolManifest(
    toolName,
    id,
    name,
    "none",
    ["runtime:mode"],
    objectSchema([], {
      reason: { type: "string" },
      sessionId: { type: "string" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => modePlan(input, context, toolName, operation, ready as ModePlanToolDeps))
  );
}

async function modePlan(
  input: JsonObject,
  context: CapabilityExecutionContext,
  toolName: CoreCodingToolName,
  operation: PlanModeOperation,
  deps: ModePlanToolDeps
): Promise<SerializableResult<CoreToolResult>> {
  if (!deps.sessions) return failure(toolName, "MODE_PLAN_SESSION_STORE_UNAVAILABLE", "SessionStore is required for mode control tools.", []);
  const sessionId = sessionIdFor(input, context);
  if (!sessionId) return failure(toolName, "MODE_PLAN_SESSION_REQUIRED", "A sessionId is required for mode control tools.", []);
  const mode = operation === "enter" ? "plan" : "auto";
  const previousMode = operation === "enter" ? "auto" : "plan";
  const reason = stringValue(input.reason) ?? "capability-requested";
  await deps.sessions.append({
    sessionId,
    sequence: 0,
    kind: toolName,
    at: new Date(0).toISOString(),
    payload: {
      mode,
      previousMode,
      reason,
      traceId: context.trace.traceId
    },
    redaction: { class: "internal" }
  } satisfies SessionEvent);
  return success(toolName, [], {
    preview: boundedText(`${previousMode} -> ${mode}: ${reason}`, 2_000),
    metadata: {
      mode,
      previousMode,
      reason,
      sessionId
    },
    replay: replay(context)
  });
}

function sessionIdFor(input: JsonObject, context: CapabilityExecutionContext): SessionId | undefined {
  const raw = stringValue(input.sessionId);
  if (raw) return asId<"session">(raw);
  return context.envelope.sessionId;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
