import type {
  CapabilityId,
  JsonObject,
  ToolIntent,
  ToolIntentDiagnostic,
  ToolIntentPreflightRequest,
  ToolIntentPreflightResult,
  ToolIntentPreflightService,
  ToolIntentProviderProfile,
  ToolIntentRepairAction
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";

const defaultPathFields = ["path", "file", "filePath", "target", "cwd"];
const deepSeekProviderId = asId<"modelProvider">("provider-deepseek");
const workspaceExecutionTools = new Set(["core.shell.run", "core.test.run"]);

export const deepSeekToolIntentProfile: ToolIntentProviderProfile = {
  providerId: deepSeekProviderId,
  pathFields: ["path", "file", "filePath", "target", "cwd"],
  toolNameAliases: {
    readFile: "core.file.read",
    read_file: "core.file.read",
    "fs.readFile": "core.file.read",
    core_file_read: "core.file.read",
    core_file_write: "core.file.write",
    core_file_edit: "core.file.edit",
    core_file_list: "core.file.list",
    core_file_search: "core.search.text",
    file_search: "core.search.text",
    search_file: "core.search.text",
    search_files: "core.search.text",
    searchText: "core.search.text",
    search_text: "core.search.text",
    grep: "core.search.text",
    core_search_text: "core.search.text",
    core_shell_run: "core.shell.run",
    shell_run: "core.shell.run",
    run_shell: "core.shell.run",
    core_shell_output: "core.shell.output",
    shell_output: "core.shell.output",
    core_shell_kill: "core.shell.kill",
    shell_kill: "core.shell.kill",
    core_git_status: "core.git.status",
    git_status: "core.git.status",
    core_git_diff: "core.git.diff",
    git_diff: "core.git.diff",
    core_test_run: "core.test.run",
    test_run: "core.test.run",
    core_todo_plan: "core.todo.plan",
    todo_plan: "core.todo.plan",
    core_web_fetch: "core.web.fetch",
    web_fetch: "core.web.fetch",
    core_web_search: "core.web.search",
    web_search: "core.web.search",
    core_agent_spawn: "core.agent.spawn",
    agent_spawn: "core.agent.spawn",
    core_agent_continue: "core.agent.continue",
    agent_continue: "core.agent.continue",
    core_agent_stop: "core.agent.stop",
    agent_stop: "core.agent.stop",
    core_hook_list: "core.hook.list",
    hook_list: "core.hook.list",
    core_skill_list: "core.skill.list",
    skill_list: "core.skill.list",
    core_skill_activate: "core.skill.activate",
    skill_activate: "core.skill.activate"
  },
  unwrapArgumentsField: "arguments",
  strictJsonArguments: false
};

export class DeterministicToolIntentPreflight implements ToolIntentPreflightService {
  constructor(private readonly profiles: readonly ToolIntentProviderProfile[] = [deepSeekToolIntentProfile]) {}

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
      const normalized = normalizeWorkspacePath(value, request.workspaceRoot, request.platform, field);
      diagnostics.push(...normalized.diagnostics);
      repairs.push(...normalized.repairs);
      if (normalized.value) repairedInput[field] = normalized.value.executorValue;
    }
    if (workspaceExecutionTools.has(String(capabilityId))) {
      const cwd = repairedInput.cwd;
      if (typeof cwd !== "string" || cwd.trim().length === 0) {
        repairedInput.cwd = ".";
        repairs.push(repair("workspace-cwd-defaulted", "cwd", typeof cwd === "string" ? cwd : "", "."));
      }
      const workspaceRoot = repairedInput.workspaceRoot;
      if (workspaceRoot !== request.workspaceRoot) {
        repairedInput.workspaceRoot = request.workspaceRoot;
        repairs.push(repair("workspace-root-defaulted", "workspaceRoot", typeof workspaceRoot === "string" ? workspaceRoot : "", request.workspaceRoot));
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

export function prepareProviderIntent(
  intent: ToolIntent,
  profile?: ToolIntentProviderProfile
): { readonly intent: ToolIntent; readonly repairs: readonly ToolIntentRepairAction[]; readonly diagnostics: readonly ToolIntentDiagnostic[] } {
  if (!profile) return { intent, repairs: [], diagnostics: [] };
  const repairs: ToolIntentRepairAction[] = [];
  const diagnostics: ToolIntentDiagnostic[] = [];
  let name = intent.name;
  const alias = stringFromJsonObject(profile.toolNameAliases, name);
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

export function normalizeWorkspacePath(
  value: string,
  workspaceRoot: string,
  platform: ToolIntentPreflightRequest["platform"],
  field = "path"
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
  if (isAbsolutePath(trimmed)) {
    diagnostics.push(diagnostic("TOOL_INTENT_ABSOLUTE_PATH_REJECTED", "Absolute paths must not come from model tool intent", field));
    return { diagnostics, repairs };
  }

  let next = trimmed;
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

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(value);
}

function looksLikeWindowsDriveRelative(value: string): boolean {
  return /^[a-zA-Z]:($|[^\\/])/.test(value);
}
