import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  PluginInstallResult,
  PluginManifest,
  PluginManager,
  SerializableResult
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { requireDeps } from "../../../shared/workspace.js";

export interface PluginInstallVerifyToolDeps extends CoreCodingToolsDependencies {
  readonly plugins?: PluginManager;
}

interface PluginInput extends JsonObject {
  readonly manifest?: JsonObject;
}

export function definePluginInstallTool(deps: PluginInstallVerifyToolDeps | undefined) {
  return defineToolManifest(
    "plugin.install",
    coreToolIds.pluginInstall,
    "Plugin Install",
    "write",
    ["plugin:install", "plugin:verify"],
    objectSchema(["manifest"], { manifest: { type: "object" } }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => pluginInstallTool(input, context, ready as PluginInstallVerifyToolDeps))
  );
}

export function definePluginVerifyTool(deps: PluginInstallVerifyToolDeps | undefined) {
  return defineToolManifest(
    "plugin.verify",
    coreToolIds.pluginVerify,
    "Plugin Verify",
    "read",
    ["plugin:verify"],
    objectSchema(["manifest"], { manifest: { type: "object" } }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => pluginVerifyTool(input, context, ready as PluginInstallVerifyToolDeps))
  );
}

async function pluginVerifyTool(input: JsonObject, context: CapabilityExecutionContext, deps: PluginInstallVerifyToolDeps): Promise<SerializableResult<CoreToolResult>> {
  if (!deps.plugins) {
    return failure("plugin.verify", "PLUGIN_MANAGER_UNAVAILABLE", "No PluginManager registered in runtime dependencies.", []);
  }
  const manifest = normalizeManifest((input as PluginInput).manifest);
  const verdict = await deps.plugins.verify(manifest);
  const ok = verdict.ok === true;
  return success("plugin.verify", [manifest.id], {
    preview: boundedText(ok ? `verified ${manifest.id}` : `integrity ${verdict.reason} for ${manifest.id}`, 2_000),
    metadata: {
      pluginId: manifest.id,
      verificationOk: ok,
      ...(ok ? {} : { reason: verdict.reason, expected: verdict.expected, actual: verdict.actual })
    },
    replay: replay(context),
    status: ok ? "completed" : "failed"
  });
}

async function pluginInstallTool(input: JsonObject, context: CapabilityExecutionContext, deps: PluginInstallVerifyToolDeps): Promise<SerializableResult<CoreToolResult>> {
  if (!deps.plugins) {
    return failure("plugin.install", "PLUGIN_MANAGER_UNAVAILABLE", "No PluginManager registered in runtime dependencies.", []);
  }
  const manifest = normalizeManifest((input as PluginInput).manifest);
  const verdict = await deps.plugins.verify(manifest);
  if (!verdict.ok) {
    return failure("plugin.install", "PLUGIN_INTEGRITY_INVALID", `Plugin integrity ${verdict.reason}: expected ${verdict.expected}, actual ${verdict.actual}.`, [manifest.id], {
      pluginId: manifest.id,
      verificationOk: false,
      reason: verdict.reason,
      expected: verdict.expected,
      actual: verdict.actual
    });
  }
  const install = await deps.plugins.install(manifest);
  const snapshot = await deps.plugins.snapshot();
  return success("plugin.install", [manifest.id], {
    preview: boundedText(`installed ${manifest.id} permissions +${install.diff.added.length}/-${install.diff.removed.length}`, 2_000),
    metadata: {
      pluginId: manifest.id,
      verificationOk: true,
      changedPluginId: install.lockEntry.pluginId,
      permissionDiff: toJson(install.diff),
      lockEntry: toJson(install.lockEntry),
      lockfileEntryCount: snapshot.entries.length
    },
    replay: replay(context)
  });
}

function normalizeManifest(value: JsonObject | undefined): PluginManifest {
  const manifest = value ?? {};
  const id = typeof manifest.id === "string" ? manifest.id : "plugin-fake";
  return {
    id: asId<"plugin">(id),
    name: typeof manifest.name === "string" ? manifest.name : id,
    version: typeof manifest.version === "string" ? manifest.version : "1.0.0",
    source: typeof manifest.source === "string" ? manifest.source : "workspace",
    integrity: typeof manifest.integrity === "string" ? manifest.integrity : "",
    permissions: Array.isArray(manifest.permissions) ? manifest.permissions.filter((item): item is string => typeof item === "string") : [],
    contributions: isJsonObject(manifest.contributions) ? manifest.contributions : {}
  };
}

function toJson(value: PluginInstallResult["diff"] | PluginInstallResult["lockEntry"]): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
