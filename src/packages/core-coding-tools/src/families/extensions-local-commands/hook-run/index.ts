import type {
  CapabilityExecutionContext,
  CoreToolResult,
  HookLifecyclePoint,
  HookSystem,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { HOOK_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { requireDeps } from "../../../shared/workspace.js";

export interface HookRunToolDeps extends CoreCodingToolsDependencies {
  readonly hooks?: HookSystem;
}

interface HookRunInput extends JsonObject {
  readonly point: HookLifecyclePoint;
  readonly input?: JsonObject;
  readonly timeoutMs?: number;
}

export function defineHookRunTool(deps: HookRunToolDeps | undefined) {
  return defineToolManifest(
    "hook.run",
    coreToolIds.hookRun,
    "Hook Run",
    "write",
    ["hook:run"],
    objectSchema(["point"], { point: { type: "string" }, input: { type: "object" }, timeoutMs: { type: "number" } }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => hookRunTool(input, context, ready as HookRunToolDeps))
  );
}

async function hookRunTool(input: JsonObject, context: CapabilityExecutionContext, deps: HookRunToolDeps): Promise<SerializableResult<CoreToolResult>> {
  if (!deps.hooks) {
    return failure("hook.run", "HOOK_SYSTEM_UNAVAILABLE", "No HookSystem registered in runtime dependencies.", []);
  }
  const parsed = input as HookRunInput;
  if (!parsed.point) {
    return failure("hook.run", "HOOK_POINT_REQUIRED", "hook.run requires a lifecycle point.", []);
  }
  try {
    const result = await deps.hooks.invokeHooks({
      schemaVersion: HOOK_SCHEMA_VERSION,
      point: parsed.point,
      input: parsed.input ?? {},
      ...(context.envelope.sessionId ? { sessionId: context.envelope.sessionId } : {}),
      ...(context.trace ? { trace: context.trace } : {}),
      ...(typeof parsed.timeoutMs === "number" ? { timeoutMs: parsed.timeoutMs } : {})
    });
    const preview = `${result.point} ${result.status} hooks=${result.orderedHookIds.length} executions=${result.executions.length}`;
    return success("hook.run", result.orderedHookIds.map(String), {
      preview: boundedText(preview, 2_000),
      metadata: {
        point: result.point,
        status: result.status,
        orderedHookIds: result.orderedHookIds,
        executionCount: result.executions.length,
        diagnosticCount: result.diagnostics.length,
        replayFingerprint: result.replayFingerprint
      },
      replay: replay(context),
      status: result.status === "completed" || result.status === "skipped" ? "completed" : "failed"
    });
  } catch (error) {
    return failure("hook.run", "HOOK_RUN_FAILED", error instanceof Error ? error.message : "Hook run failed.", [parsed.point]);
  }
}
