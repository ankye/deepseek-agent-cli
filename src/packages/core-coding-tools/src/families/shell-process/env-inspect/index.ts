import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { requireDeps } from "../../../shared/workspace.js";
import { coreToolIds } from "../../../shared/ids.js";

interface EnvInspectInput extends JsonObject {
  readonly names?: readonly string[];
  readonly env?: JsonObject;
  readonly revealValues?: boolean;
  readonly limitBytes?: number;
}

export function defineEnvInspectTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "env.inspect",
    coreToolIds.envInspect,
    "Environment Inspect",
    "read",
    ["process:read"],
    objectSchema([], {
      names: { type: "array" },
      env: { type: "object" },
      revealValues: { type: "boolean" },
      workspaceRoot: { type: "string" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => envInspectTool(input, context, ready))
  );
}

async function envInspectTool(input: JsonObject, context: CapabilityExecutionContext, _deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as EnvInspectInput;
  const names = Array.isArray(parsed.names) && parsed.names.length > 0
    ? parsed.names.map(String)
    : ["PATH", "HOME", "SHELL", "COMSPEC", "SystemRoot", "PWD", "CI"];
  const scopedEnv = isJsonObject(parsed.env) ? parsed.env : {};
  const revealValues = parsed.revealValues === true;
  const variables = names.map((name) => {
    const rawValue = scopedEnv[name];
    const value = typeof rawValue === "string" ? rawValue : undefined;
    return {
      name,
      present: value !== undefined,
      ...(value !== undefined ? { valueLength: value.length } : {}),
      ...(value !== undefined && revealValues && isSafeToReveal(name) ? { value } : {})
    };
  });
  const preview = variables.map((variable) => `${variable.name}=${variable.present ? "present" : "absent"}`).join("\n");
  return success("env.inspect", [], {
    preview: boundedText(preview, parsed.limitBytes),
    metadata: {
      revealValues,
      variables
    },
    replay: replay(context)
  });
}

function isSafeToReveal(name: string): boolean {
  return !/(secret|token|key|password|credential|auth)/i.test(name);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
