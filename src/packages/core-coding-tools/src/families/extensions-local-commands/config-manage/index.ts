import type {
  CapabilityExecutionContext,
  ConfigStore,
  CoreToolResult,
  JsonObject,
  JsonValue,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { requireDeps } from "../../../shared/workspace.js";

export interface ConfigManageToolDeps extends CoreCodingToolsDependencies {
  readonly config?: ConfigStore;
}

export function defineConfigManageTool(deps: ConfigManageToolDeps | undefined) {
  return defineToolManifest(
    "config.manage",
    coreToolIds.configManage,
    "Config Manage",
    "none",
    ["config:read", "config:write"],
    objectSchema([], {
      action: { type: "string", enum: ["inspect", "get", "set"] },
      key: { type: "string" },
      value: {}
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => configManageTool(input, context, ready as ConfigManageToolDeps))
  );
}

async function configManageTool(input: JsonObject, context: CapabilityExecutionContext, deps: ConfigManageToolDeps): Promise<SerializableResult<CoreToolResult>> {
  if (!deps.config) return failure("config.manage", "CONFIG_STORE_UNAVAILABLE", "ConfigStore is required for config.manage.", []);
  const action = actionValue(input.action);
  if (action === "inspect") {
    const profile = await deps.config.profile();
    const profileEvidence = { name: profile.name, values: profile.values } satisfies JsonObject;
    return success("config.manage", [], {
      preview: boundedText(Object.entries(profile.values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n"), 8_000),
      metadata: { action, profile: profileEvidence },
      replay: replay(context)
    });
  }
  const key = stringValue(input.key);
  if (!key) return failure("config.manage", "CONFIG_KEY_REQUIRED", "key is required for config get/set.", []);
  if (action === "get") {
    const value = await deps.config.get(key);
    return success("config.manage", [], {
      metadata: { action, key, value },
      replay: replay(context)
    });
  }
  if (!isJsonValue(input.value)) return failure("config.manage", "CONFIG_VALUE_INVALID", "value must be JSON serializable for config set.", []);
  await deps.config.set(key, input.value);
  return success("config.manage", [], {
    metadata: { action, key, value: input.value },
    replay: replay(context)
  });
}

function actionValue(value: unknown): "inspect" | "get" | "set" {
  if (value === "get" || value === "set") return value;
  return "inspect";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return Number.isFinite(value) || typeof value !== "number";
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}
