import type {
  CapabilityId,
  JsonObject,
  PlatformRuntime,
  ToolIntent,
  ToolIntentDiagnostic,
  ToolIntentPreflightRequest,
  ToolIntentPreflightResult,
  ToolIntentPreflightService,
  ToolIntentProviderProfile,
  ToolIntentRepairAction
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import { deepSeekToolIntentProfile } from "./provider-profiles.js";

const defaultPathFields = ["path", "file", "filePath", "sourcePath", "targetPath", "target", "cwd"];
const workspaceExecutionTools = new Set(["core.shell.run", "core.test.run", "core.repl.execute", "core.package.manager", "core.env.prepare"]);
const workspaceScopedTools = new Set([
  "core.file.read",
  "core.file.write",
  "core.file.edit",
  "core.text.replace",
  "core.file.copy",
  "core.file.move",
  "core.file.delete",
  "core.directory.create",
  "core.file.touch",
  "core.file.stat",
  "core.json.read",
  "core.json.patch",
  "core.checksum.hash",
  "core.path.resolve",
  "core.archive.create",
  "core.archive.extract",
  "core.file.list",
  "core.workspace.glob",
  "core.asset.view-local",
  "core.search.text",
  "core.code.diagnostics",
  "core.notebook.read",
  "core.notebook.edit",
  "core.patch.apply",
  "core.revert.undo",
  "core.git.status",
  "core.git.diff",
  "core.git.history-branch",
  ...workspaceExecutionTools
]);
const literalMutationPathTools = new Set([
  "core.file.write",
  "core.file.edit",
  "core.text.replace",
  "core.file.copy",
  "core.file.move",
  "core.file.delete",
  "core.directory.create",
  "core.file.touch",
  "core.json.patch",
  "core.archive.create",
  "core.archive.extract",
  "core.patch.apply"
]);

export type WorkspacePathResolver = PlatformRuntime["resolveWorkspacePath"];

export interface ToolIntentPreflightOptions {
  readonly resolveWorkspacePath?: WorkspacePathResolver;
}

export { deepSeekProviderId, deepSeekToolIntentProfile } from "./provider-profiles.js";

export class DeterministicToolIntentPreflight implements ToolIntentPreflightService {
  constructor(
    private readonly profiles: readonly ToolIntentProviderProfile[] = [deepSeekToolIntentProfile],
    private readonly options: ToolIntentPreflightOptions = {}
  ) {}

  async check(request: ToolIntentPreflightRequest): Promise<ToolIntentPreflightResult> {
    const repairs: ToolIntentRepairAction[] = [];
    const diagnostics: ToolIntentDiagnostic[] = [];
    const profile = this.profileFor(request);
    const providerPrepared = prepareProviderIntent(request.intent, profile);
    repairs.push(...providerPrepared.repairs);
    diagnostics.push(...providerPrepared.diagnostics);
    let preparedIntent = providerPrepared.intent;
    const visibleNames = request.modelVisibleCapabilities.map(String);
    const visible = new Set<string>(visibleNames);
    const visibleAlias = visibleNames.find((name) => providerSafeToolName(name) === preparedIntent.name);
    if (visibleAlias && visibleAlias !== preparedIntent.name) {
      repairs.push(repair("provider-tool-alias-normalized", "name", preparedIntent.name, visibleAlias));
      preparedIntent = { ...preparedIntent, name: visibleAlias };
    }
    const capabilityId = asId<"capability">(preparedIntent.name);
    if (!visible.has(String(capabilityId))) {
      diagnostics.push(diagnostic("TOOL_INTENT_UNKNOWN_TOOL", `Tool is not model-visible: ${preparedIntent.name}`, "name"));
      return result("rejected", request, diagnostics, repairs, undefined, capabilityId, profile);
    }

    const repairedInput: Record<string, unknown> = { ...preparedIntent.input };
    for (const field of request.pathFields ?? profile?.pathFields ?? defaultPathFields) {
      const value = repairedInput[field];
      if (typeof value !== "string") continue;
      const preserveLiteralExecutorPath = literalMutationPathTools.has(String(capabilityId)) && field !== "cwd";
      const normalized = normalizeWorkspacePath(value, request.workspaceRoot, request.platform, field, this.options.resolveWorkspacePath, preserveLiteralExecutorPath);
      diagnostics.push(...normalized.diagnostics);
      repairs.push(...normalized.repairs);
      if (normalized.value) repairedInput[field] = normalized.value.executorValue;
    }
    if (shouldDefaultWorkspaceRoot(capabilityId, repairedInput, request.workspaceRoot, Boolean(this.options.resolveWorkspacePath))) {
      const workspaceRoot = repairedInput.workspaceRoot;
      if (workspaceRoot !== request.workspaceRoot) {
        repairedInput.workspaceRoot = request.workspaceRoot;
        repairs.push(repair("workspace-root-defaulted", "workspaceRoot", typeof workspaceRoot === "string" ? workspaceRoot : "", request.workspaceRoot));
      }
    }
    if (workspaceExecutionTools.has(String(capabilityId))) {
      const cwd = repairedInput.cwd;
      if (typeof cwd !== "string" || cwd.trim().length === 0) {
        repairedInput.cwd = ".";
        repairs.push(repair("workspace-cwd-defaulted", "cwd", typeof cwd === "string" ? cwd : "", "."));
      }
    }
    if (diagnostics.length > 0) {
      return result("rejected", request, diagnostics, repairs, undefined, capabilityId, profile);
    }

    const repaired: ToolIntent = {
      ...preparedIntent,
      input: repairedInput as JsonObject
    };
    return result(repairs.length > 0 ? "repaired" : "accepted", request, diagnostics, repairs, repaired, capabilityId, profile);
  }

  private profileFor(request: ToolIntentPreflightRequest): ToolIntentProviderProfile | undefined {
    if (!request.providerId) return undefined;
    return this.profiles.find((profile) => {
      if (profile.providerId !== request.providerId) return false;
      return !profile.profileId || !request.profileId || profile.profileId === request.profileId;
    });
  }
}

function shouldDefaultWorkspaceRoot(
  capabilityId: CapabilityId,
  input: Record<string, unknown>,
  workspaceRoot: string,
  hasPlatformResolver: boolean
): boolean {
  return (workspaceExecutionTools.has(String(capabilityId)) || hasPlatformResolver) &&
    workspaceRoot.length > 0 &&
    workspaceScopedTools.has(String(capabilityId)) &&
    input.workspaceRoot !== workspaceRoot;
}

export function prepareProviderIntent(
  intent: ToolIntent,
  profile?: ToolIntentProviderProfile
): { readonly intent: ToolIntent; readonly repairs: readonly ToolIntentRepairAction[]; readonly diagnostics: readonly ToolIntentDiagnostic[] } {
  if (!profile) return { intent, repairs: [], diagnostics: [] };
  const repairs: ToolIntentRepairAction[] = [];
  const diagnostics: ToolIntentDiagnostic[] = [];
  let name = intent.name;
  const alias = toolNameAliasFromProfile(profile, name);
  if (alias && alias !== name) {
    repairs.push(repair("provider-tool-alias-normalized", "name", name, alias));
    name = alias;
  }

  let input: JsonObject = intent.input;
  if (profile.unwrapArgumentsField) {
    const raw = input[profile.unwrapArgumentsField];
    if (typeof raw === "string") {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isJsonObject(parsed)) {
          input = parsed;
          repairs.push(repair("provider-arguments-unwrapped", profile.unwrapArgumentsField, raw, JSON.stringify(parsed)));
        } else if (profile.strictJsonArguments) {
          diagnostics.push(diagnostic("TOOL_INTENT_PROVIDER_ARGUMENTS_NOT_OBJECT", "Provider arguments JSON must decode to an object", profile.unwrapArgumentsField));
        }
      } catch {
        diagnostics.push(diagnostic("TOOL_INTENT_PROVIDER_ARGUMENTS_INVALID_JSON", "Provider arguments are not valid JSON", profile.unwrapArgumentsField));
      }
    }
  }

  return {
    intent: { ...intent, name, input },
    repairs,
    diagnostics
  };
}

function toolNameAliasFromProfile(profile: ToolIntentProviderProfile, name: string): string | undefined {
  const exact = stringFromJsonObject(profile.toolNameAliases, name);
  if (exact) return exact;
  const aliases = profile.toolNameAliases;
  if (!aliases) return undefined;
  const normalizedName = name.toLowerCase();
  for (const [alias, capabilityId] of Object.entries(aliases)) {
    if (alias.toLowerCase() === normalizedName && typeof capabilityId === "string") return capabilityId;
  }
  return undefined;
}

export function normalizeWorkspacePath(
  value: string,
  workspaceRoot: string,
  platform: ToolIntentPreflightRequest["platform"],
  field = "path",
  resolveWorkspacePath?: WorkspacePathResolver,
  preserveLiteralExecutorPath = false
): { readonly value?: { readonly modelValue: string; readonly executorValue: string }; readonly repairs: readonly ToolIntentRepairAction[]; readonly diagnostics: readonly ToolIntentDiagnostic[] } {
  const repairs: ToolIntentRepairAction[] = [];
  const diagnostics: ToolIntentDiagnostic[] = [];
  const trimmed = value.trim();
  if (!trimmed) {
    diagnostics.push(diagnostic("TOOL_INTENT_EMPTY_PATH", "Path must not be empty", field));
    return { diagnostics, repairs };
  }
  if (isHomePath(trimmed)) {
    diagnostics.push(diagnostic("TOOL_INTENT_HOME_PATH_REJECTED", "Home-directory paths are not workspace-safe", field));
    return { diagnostics, repairs };
  }
  const unsafeSyntaxDiagnostic = unsafeWorkspacePathSyntaxDiagnostic(trimmed, field);
  if (unsafeSyntaxDiagnostic) {
    diagnostics.push(unsafeSyntaxDiagnostic);
    return { diagnostics, repairs };
  }
  if (resolveWorkspacePath) {
    return normalizeWorkspacePathWithPlatform(trimmed, value, workspaceRoot, platform, field, resolveWorkspacePath, preserveLiteralExecutorPath);
  }
  let next = trimmed;
  if (isAbsolutePath(trimmed)) {
    const contained = workspaceRelativeFromAbsolute(trimmed, workspaceRoot, platform);
    if (!contained) {
      diagnostics.push(diagnostic("TOOL_INTENT_ABSOLUTE_PATH_REJECTED", "Absolute paths must not come from model tool intent", field));
      return { diagnostics, repairs };
    }
    next = contained.executorValue;
    repairs.push(repair("path-normalized", field, value, contained.modelValue, contained.executorValue));
  }
  if (/\0/.test(next)) {
    diagnostics.push(diagnostic("TOOL_INTENT_NULL_BYTE_REJECTED", "Null bytes are not allowed in workspace paths", field));
    return { diagnostics, repairs };
  }
  if (next.startsWith("./") || next.startsWith(".\\")) {
    const before = next;
    next = next.slice(2);
    repairs.push(repair("path-prefix-removed", field, before, next));
  }

  const separator = platform === "windows" ? "\\" : "/";
  const alternate = platform === "windows" ? /\//g : /\\/g;
  if (alternate.test(next)) {
    const before = next;
    next = next.replace(alternate, separator);
    repairs.push(repair("path-separator-normalized", field, before, next));
  }

  const parts = next.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 1 && parts[0] === ".") {
    const normalizedRoot = workspaceRoot.replace(/[\\/]+$/, "");
    const modelValue = normalizedRoot ? `${normalizedRoot}${separator}.` : ".";
    return {
      value: { modelValue, executorValue: "." },
      diagnostics,
      repairs: normalizedRoot ? [...repairs, repair("path-normalized", field, value, modelValue, ".")] : repairs
    };
  }
  if (parts.some((part) => part === "..")) {
    diagnostics.push(diagnostic("TOOL_INTENT_PARENT_TRAVERSAL_REJECTED", "Parent traversal is not workspace-safe", field));
    return { diagnostics, repairs };
  }
  if (parts.some((part) => part === ".")) {
    const before = next;
    next = parts.filter((part) => part !== ".").join(separator);
    repairs.push(repair("path-normalized", field, before, next));
  }
  if (looksLikeWindowsDriveRelative(next)) {
    diagnostics.push(diagnostic("TOOL_INTENT_AMBIGUOUS_PLATFORM_PATH", "Drive-relative paths are ambiguous and rejected", field));
    return { diagnostics, repairs };
  }

  const normalizedRoot = workspaceRoot.replace(/[\\/]+$/, "");
  const modelValue = normalizedRoot ? `${normalizedRoot}${separator}${next}` : next;
  return {
    value: { modelValue, executorValue: next },
    diagnostics,
    repairs: normalizedRoot ? [...repairs, repair("path-normalized", field, value, modelValue, next)] : repairs
  };
}

function normalizeWorkspacePathWithPlatform(
  trimmed: string,
  originalValue: string,
  workspaceRoot: string,
  platform: ToolIntentPreflightRequest["platform"],
  field: string,
  resolveWorkspacePath: WorkspacePathResolver,
  preserveLiteralExecutorPath: boolean
): { readonly value?: { readonly modelValue: string; readonly executorValue: string }; readonly repairs: readonly ToolIntentRepairAction[]; readonly diagnostics: readonly ToolIntentDiagnostic[] } {
  const resolved = resolveWorkspacePath(workspaceRoot, trimmed);
  if (!resolved.ok || !resolved.value) {
    const code = resolved.error?.code === "PLATFORM_PATH_OUTSIDE_ROOT" && isAbsolutePath(trimmed)
      ? "TOOL_INTENT_ABSOLUTE_PATH_REJECTED"
      : "TOOL_INTENT_PLATFORM_PATH_REJECTED";
    return {
      diagnostics: [diagnostic(code, resolved.error?.message ?? "Path was rejected by platform workspace resolution.", field)],
      repairs: []
    };
  }
  const literalExecutorValue = (!isAbsolutePath(trimmed) || preserveLiteralExecutorPath)
    ? literalWorkspaceExecutorPath(trimmed, workspaceRoot, platform)
    : undefined;
  const executorValue = literalExecutorValue ?? (resolved.value.relativePath.length > 0 ? resolved.value.relativePath : ".");
  return {
    value: {
      modelValue: resolved.value.path,
      executorValue
    },
    diagnostics: [],
    repairs: [repair("path-normalized", field, originalValue, resolved.value.path, executorValue)]
  };
}

function literalWorkspaceExecutorPath(
  value: string,
  workspaceRoot: string,
  platform: ToolIntentPreflightRequest["platform"]
): string | undefined {
  if (isAbsolutePath(value)) return workspaceRelativeFromAbsolute(value, workspaceRoot, platform)?.executorValue;
  const prefixTrimmed = value.startsWith("./") || value.startsWith(".\\") ? value.slice(2) : value;
  const parts = prefixTrimmed.split(/[\\/]+/).filter((part) => part.length > 0 && part !== ".");
  return parts.length > 0 ? parts.join("/") : ".";
}

function result(
  status: ToolIntentPreflightResult["status"],
  request: ToolIntentPreflightRequest,
  diagnostics: readonly ToolIntentDiagnostic[],
  repairs: readonly ToolIntentRepairAction[],
  repaired?: ToolIntent,
  capabilityId?: CapabilityId,
  profile?: ToolIntentProviderProfile
): ToolIntentPreflightResult {
  return {
    status,
    original: request.intent,
    ...(repaired ? { repaired } : {}),
    ...(capabilityId ? { capabilityId } : {}),
    repairs,
    diagnostics,
    platform: {
      os: request.platform,
      pathFields: request.pathFields ?? profile?.pathFields ?? defaultPathFields
    },
    ...(profile || request.providerId ? { provider: { providerId: request.providerId ?? profile?.providerId ?? "", profileId: request.profileId ?? profile?.profileId ?? "", matched: Boolean(profile) } } : {}),
    workspaceRoot: request.workspaceRoot,
    redaction: { class: "internal" }
  };
}

function diagnostic(code: string, message: string, field: string): ToolIntentDiagnostic {
  return {
    code,
    message,
    field,
    retryable: false,
    redaction: { class: "public" }
  };
}

function repair(kind: ToolIntentRepairAction["kind"], field: string, before: string, after: string, executorValue?: string): ToolIntentRepairAction {
  return {
    kind,
    field,
    before,
    after,
    confidence: 1,
    ...(executorValue ? { modelValue: after, executorValue } : {})
  };
}

function stringFromJsonObject(value: JsonObject | undefined, key: string): string | undefined {
  const found = value?.[key];
  return typeof found === "string" ? found : undefined;
}

function providerSafeToolName(value: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(value) ? value : value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHomePath(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\");
}

function unsafeWorkspacePathSyntaxDiagnostic(value: string, field: string): ToolIntentDiagnostic | undefined {
  if (/\0/.test(value)) {
    return diagnostic("TOOL_INTENT_NULL_BYTE_REJECTED", "Null bytes are not allowed in workspace paths", field);
  }
  if (looksLikeWindowsDriveRelative(value)) {
    return diagnostic("TOOL_INTENT_AMBIGUOUS_PLATFORM_PATH", "Drive-relative paths are ambiguous and rejected", field);
  }
  if (value.split(/[\\/]+/).some((part) => part === "..")) {
    return diagnostic("TOOL_INTENT_PARENT_TRAVERSAL_REJECTED", "Parent traversal is not workspace-safe", field);
  }
  return undefined;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(value);
}

function workspaceRelativeFromAbsolute(
  value: string,
  workspaceRoot: string,
  platform: ToolIntentPreflightRequest["platform"]
): { readonly modelValue: string; readonly executorValue: string } | undefined {
  const separator = platform === "windows" ? "\\" : "/";
  const root = normalizeAbsolutePathForPlatform(workspaceRoot, separator);
  const candidate = normalizeAbsolutePathForPlatform(value, separator);
  const compareRoot = platform === "windows" ? root.toLowerCase() : root;
  const compareCandidate = platform === "windows" ? candidate.toLowerCase() : candidate;
  if (compareCandidate === compareRoot) {
    return { modelValue: root, executorValue: "." };
  }
  const prefix = compareRoot.endsWith(separator) ? compareRoot : `${compareRoot}${separator}`;
  if (!compareCandidate.startsWith(prefix)) return undefined;
  const relative = candidate.slice(prefix.length);
  if (!relative || relative.startsWith("..")) return undefined;
  return {
    modelValue: candidate,
    executorValue: relative
  };
}

function normalizeAbsolutePathForPlatform(value: string, separator: "\\" | "/"): string {
  const normalized = value.trim().replace(/[\\/]+/g, separator);
  if (/^[a-zA-Z]:[\\/]?$/.test(normalized)) return normalized;
  return normalized.replace(/[\\/]+$/, "");
}

function looksLikeWindowsDriveRelative(value: string): boolean {
  return /^[a-zA-Z]:($|[^\\/])/.test(value);
}
