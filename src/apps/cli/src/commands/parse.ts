import type { AgentLoopOutputContract, AgentLoopOutputContractKind, AgentLoopOutputMode, CliKeymapProfileName, CliTuiProfile, DiagnosticsCommandName, ExtensionManagementCommandKind, JsonObject, JsonValue, ModelReasoningEffort, ModelReasoningOptions, ModelReasoningProviderEffort, ReadinessCommandName, WorkspaceRevertRequestTarget } from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import type { CliOptions, CliTerminalFlags } from "../types.js";
import { defaultTerminalFlags } from "../host/terminal.js";

const readinessCommands = new Set<ReadinessCommandName>(["init", "config", "auth", "doctor", "privacy", "verify-install"]);
const diagnosticsCommands = new Set<DiagnosticsCommandName>(["bundle", "release", "doctor", "verify", "refresh", "evaluate", "env", "flow"]);
const defaultOutputMode: AgentLoopOutputMode = "text";

export function parseCliArgs(args: readonly string[], _terminal: CliTerminalFlags = defaultTerminalFlags): CliOptions {
  const output = parseOutputMode(args);
  const timeoutMs = parsePositiveNumberFlag(args, "--timeout-ms");
  const live = args.includes("--live");
  const toolProjection = parseToolProjection(args);
  const reasoning = parseReasoningOptions(args);
  const outputContract = parseOutputContract(args);
  const tuiProfile = parseTuiProfile(args);
  const modelProvider = parseModelProvider(args);
  const model = readFlagValue(args, "--model");
  const first = args[0];
  if (!first || first === "help" || first === "--help" || first === "-h") {
    return { command: "help", prompt: "", output, live };
  }
  if (first === "run") {
    return { command: "run", prompt: promptFromArgs(args.slice(1)), output, live, ...(outputContract ? { outputContract } : {}), ...(timeoutMs ? { timeoutMs } : {}), ...(toolProjection ? { toolProjection } : {}), ...(reasoning ? { reasoning } : {}), ...(modelProvider ? { modelProvider } : {}), ...(model ? { model } : {}) };
  }
  if (first === "chat") {
    const sessionId = readFlagValue(args, "--session");
    return {
      command: "chat",
      prompt: "",
      output,
      live,
      ...(tuiProfile ? { tuiProfile } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(modelProvider ? { modelProvider } : {}),
      ...(model ? { model } : {}),
      ...(sessionId ? { sessionId: asId<"session">(sessionId) } : {})
    };
  }
  if (first === "tools-smoke") {
    return { command: "tools-smoke", prompt: "", output, live };
  }
  if (first === "session") {
    const action = args[1] === "fork" ? "fork" : "resume";
    const sessionId = args[2] && !args[2].startsWith("-") ? asId<"session">(args[2]) : undefined;
    const base: CliOptions = {
      command: "session",
      prompt: "",
      output,
      live,
      sessionAction: action
    };
    if (action === "fork" && sessionId) return { ...base, parentSessionId: sessionId };
    if (action === "resume" && sessionId) return { ...base, sessionId };
    return base;
  }
  if (first === "mcp") {
    const manifestPath = args[2] && !args[2].startsWith("-") ? args[2] : undefined;
    const callTool = readFlagValue(args, "--call");
    const callInput = readFlagValue(args, "--input");
    return {
      command: "mcp",
      prompt: "",
      output,
      live,
      mcpAction: "test",
      ...(manifestPath ? { mcpManifestPath: manifestPath } : {}),
      ...(callTool ? { mcpCallTool: callTool } : {}),
      ...(callInput ? { mcpCallInput: callInput } : {}),
      enableRealMcp: args.includes("--enable-real-mcp")
    };
  }
  if (first === "index-provider") {
    return {
      command: "index-provider",
      prompt: "",
      output,
      live,
      indexProviderAction: args[1] === "set" ? "set" : "status",
      ...(args[2] ? { indexProviderId: args[2] } : {}),
      ...(args[3] ? { indexProviderStatus: args[3] } : {}),
      indexProviderScope: args.includes("--user") ? "user" : "workspace"
    };
  }
  if (first === "mode") {
    const action = parseModeAction(args[1]);
    return {
      command: "mode",
      prompt: "",
      output,
      live,
      modeAction: action,
      ...(args[2] && !args[2].startsWith("-") ? { modeRequestedTransition: args[2] } : {})
    };
  }
  if (first === "memory") {
    return {
      command: "memory",
      prompt: "",
      output,
      live,
      memoryAction: parseMemoryAction(args[1]),
      memoryInput: parseMemoryInput(args)
    };
  }
  if (first === "context") {
    const sessionId = readFlagValue(args, "--session");
    return {
      command: "context",
      prompt: "",
      output,
      live,
      contextInput: parseContextInput(args),
      ...(sessionId ? { sessionId: asId<"session">(sessionId) } : {})
    };
  }
  if (first === "checks") {
    return {
      command: "checks",
      prompt: "",
      output,
      live,
      checkAction: parseCheckAction(args[1]),
      checkInput: parseCheckInput(args)
    };
  }
  if (first === "file") {
    const action = parseFileAction(args[1]);
    return {
      command: "file",
      prompt: "",
      output,
      live,
      fileAction: action,
      fileInput: parseFileInput(args, action)
    };
  }
  if (first === "repo") {
    const action = parseRepoAction(args[1]);
    return {
      command: "repo",
      prompt: "",
      output,
      live,
      repoAction: action,
      repoInput: parseRepoInput(args, action)
    };
  }
  if (first === "git") {
    return {
      command: "git",
      prompt: "",
      output,
      live,
      gitInput: parseGitInput(args)
    };
  }
  if (first === "jump") {
    const action = parseJumpAction(args[1]);
    return {
      command: "jump",
      prompt: "",
      output,
      live,
      jumpAction: action,
      jumpInput: parseJumpInput(args, action)
    };
  }
  if (first === "diagnostics") {
    const diagnosticsCommand = parseDiagnosticsCommand(args[1]);
    return {
      command: "diagnostics",
      diagnosticsCommand,
      prompt: "",
      output,
      live,
      ...(modelProvider ? { modelProvider } : {}),
      ...(model ? { model } : {}),
      ...(toolProjection ? { toolProjection } : {}),
      diagnosticsInput: parseDiagnosticsInput(diagnosticsCommand, args)
    };
  }
  if (first === "extension") {
    return {
      command: "extension",
      extensionCommand: parseExtensionCommand(args),
      prompt: "",
      output,
      live,
      extensionInput: parseExtensionInput(args)
    };
  }
  if (first === "palette") {
    const paletteAction = parsePaletteAction(args);
    return {
      command: "palette",
      ...(paletteAction ? { paletteAction } : {}),
      paletteKeymapProfile: parsePaletteKeymapProfile(args[2]),
      ...(args[2] ? { paletteActionName: args[2] } : {}),
      ...(args[3] ? { paletteTargetId: args[3] } : {}),
      prompt: "",
      output,
      live
    };
  }
  if (first === "revert") {
    const reason = readFlagValue(args, "--reason");
    const action = args[1] === "apply" ? "apply" : "preview";
    return {
      command: "revert",
      prompt: "",
      output,
      live,
      revertAction: action,
      revertTarget: parseRevertTarget(args),
      ...(reason ? { revertReason: reason } : {})
    };
  }
  if (isReadinessCommand(first)) {
    return { command: "readiness", readinessCommand: first, prompt: "", output, live, readinessInput: parseReadinessInput(first, args) };
  }
  return { command: "help", prompt: "", output, live };
}

export function cliUsageLines(): readonly string[] {
  return [
    "DeepSeek CLI",
    "Usage:",
    "  deepseek run \"<task>\" [--output text|json|jsonl] [--live] [--provider deepseek|glm] [--model <model>] [--thinking off|low|medium|high|xhigh|max] [--tool-projection none|read-only|read-write|all] [--no-tools] [--timeout-ms <ms>] [--output-contract json-object|json-file|file|command-plan]",
    "  deepseek chat [--session <session-id>] [--output text|json|jsonl] [--live] [--provider deepseek|glm] [--model <model>] [--thinking off|low|medium|high|xhigh|max] [--tui auto|line|full-screen|off] [--timeout-ms <ms>]",
    "  deepseek session resume <session-id> [--output text|json]",
    "  deepseek session fork <session-id> [--output text|json]",
    "  deepseek mcp test <manifest.json> [--enable-real-mcp] [--call <tool> --input <json>] [--output text|json]",
    "  deepseek index-provider status [--output text|json|jsonl]",
    "  deepseek index-provider set <pageindex|zvec|code-index> <enabled|deferred|disabled> [--user] [--output text|json|jsonl]",
    "  deepseek mode [status|agent|workers|verify|plan] [--output text|json|jsonl]",
    "  deepseek memory status|list|candidates|remember|approve|reject|edit|delete|enable|disable|export|explain [args] [--output text|json]",
    "  deepseek context status|grep|describe|summarize|expand|budget|pin [args] [--session <session-id>] [--output text|json|jsonl]",
    "  deepseek checks openspec|typecheck|lint|test|boundaries|build-cli [--output text|json|jsonl]",
    "  deepseek file list|preview|refs <query> [--output text|json|jsonl]",
    "  deepseek repo files|grep|recall|project-index <query> [--output text|json|jsonl]",
    "  deepseek git status|diff|review [--output text|json|jsonl]",
    "  deepseek jump file|text|symbol <query> [--output text|json|jsonl]",
    "  deepseek extension list [--output text|json|jsonl]",
    "  deepseek extension plugin install|verify|snapshot|apply-lockfile <file.json> [--output text|json|jsonl]",
    "  deepseek extension plugin contributions [--output text|json|jsonl]",
    "  deepseek extension skill list|activate [name] [--output text|json|jsonl]",
    "  deepseek extension auth scopes [--output text|json|jsonl]",
    "  deepseek extension mcp test <manifest.json> [--enable-real-mcp] [--call <tool> --input <json>] [--output text|json|jsonl]",
    "  deepseek palette list [--output text|json|jsonl]",
    "  deepseek palette keymap [core|vi-minimal|vi-professional] [--output text|json|jsonl]",
    "  deepseek palette action <action> <target-id> [--output text|json|jsonl]",
    "  deepseek revert preview --request <id>|--turn <id>|--session <id> [--path <path>] [--output text|json|jsonl]",
    "  deepseek revert apply --request <id>|--turn <id>|--session <id> [--path <path>] [--output text|json|jsonl]",
    "  deepseek diagnostics bundle|release|doctor|verify|refresh|evaluate|env|flow [prepare|inspect] [--prompt <text>] [--profile <id>] [--execute] [--baseline <id>] [--severity info|warning|release-blocking] [--package <name>] [--capability <id>] [--product-ready <capability>] [--full] [--dry-run] [--live] [--output text|json|jsonl]",
    "  deepseek tools-smoke [--output text|jsonl]",
    "  deepseek <init|config|auth|doctor|privacy|verify-install> [--output text|json]",
    "Notes:",
    "  fact-sensitive run/chat turns classify and select bounded local evidence before model dispatch",
    "  one-shot run turns use bounded self-repair for repairable failures and emit redacted repair evidence"
  ];
}

function parseContextInput(args: readonly string[]): JsonObject {
  const filtered: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (value === "--output" || value === "--session") {
      index += 1;
      continue;
    }
    filtered.push(value);
  }
  return { raw: filtered.join(" ").trim() };
}

function parseCheckAction(value: string | undefined): NonNullable<CliOptions["checkAction"]> {
  if (value === "openspec" || value === "lint" || value === "test" || value === "boundaries" || value === "build-cli") return value;
  return "typecheck";
}

function parseCheckInput(args: readonly string[]): JsonObject {
  const action = args[1] && !args[1].startsWith("-") ? args[1] : "typecheck";
  return {
    action,
    args: commandArguments(args, 2, new Set(["--output"]))
  };
}

function parseFileAction(value: string | undefined): NonNullable<CliOptions["fileAction"]> {
  if (value === "preview") return "preview";
  if (value === "refs" || value === "references") return "references";
  return "list";
}

function parseFileInput(args: readonly string[], action: NonNullable<CliOptions["fileAction"]>): JsonObject {
  return {
    action,
    query: commandArguments(args, 2, new Set(["--output"])).join(" ").trim()
  };
}

function parseRepoAction(value: string | undefined): NonNullable<CliOptions["repoAction"]> {
  if (value === "grep" || value === "recall" || value === "project-index" || value === "index") return value === "index" ? "project-index" : value;
  return "files";
}

function parseRepoInput(args: readonly string[], action: NonNullable<CliOptions["repoAction"]>): JsonObject {
  return {
    action,
    query: commandArguments(args, 2, new Set(["--output"])).join(" ").trim()
  };
}

function parseGitInput(args: readonly string[]): JsonObject {
  const action = args[1] && !args[1].startsWith("-") ? args[1] : "status";
  return {
    action,
    args: commandArguments(args, 2, new Set(["--output"]))
  };
}

function parseJumpAction(value: string | undefined): NonNullable<CliOptions["jumpAction"]> {
  if (value === "text" || value === "symbol") return value;
  return "file";
}

function parseJumpInput(args: readonly string[], action: NonNullable<CliOptions["jumpAction"]>): JsonObject {
  return {
    action,
    query: commandArguments(args, 2, new Set(["--output"])).join(" ").trim()
  };
}

function commandArguments(args: readonly string[], start: number, valueFlags: ReadonlySet<string>): readonly string[] {
  const values: string[] = [];
  for (let index = start; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (valueFlags.has(value)) {
      index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}

function parseModeAction(value: string | undefined): NonNullable<CliOptions["modeAction"]> {
  if (value === "agent" || value === "workers" || value === "verify" || value === "plan") return value;
  return "status";
}

function parseMemoryAction(value: string | undefined): NonNullable<CliOptions["memoryAction"]> {
  if (value === "list" || value === "candidates" || value === "remember" || value === "approve" || value === "reject" || value === "edit" || value === "delete" || value === "enable" || value === "disable" || value === "export" || value === "explain") return value;
  return "status";
}

function parseMemoryInput(args: readonly string[]): JsonObject {
  const action = parseMemoryAction(args[1]);
  const input: Record<string, unknown> = { action };
  const id = args[2] && !args[2].startsWith("-") && action !== "remember" ? args[2] : readFlagValue(args, "--id");
  const content = readFlagValue(args, "--content") ?? (action === "remember" ? memoryFreeText(args) : undefined);
  const scope = readFlagValue(args, "--scope");
  const query = readFlagValue(args, "--query");
  const tags = readFlagValue(args, "--tags");
  const reason = readFlagValue(args, "--reason");
  if (id) input.id = id;
  if (content) input.content = content;
  if (scope) input.scope = scope;
  if (query) input.query = query;
  if (tags) input.tags = tags.split(",").map((value) => value.trim()).filter(Boolean);
  if (reason) input.reason = reason;
  if (args.includes("--include-dismissed")) input.includeDismissed = true;
  if (args.includes("--include-candidates")) input.includeCandidates = true;
  return input as JsonObject;
}

function memoryFreeText(args: readonly string[]): string | undefined {
  const values: string[] = [];
  const valueFlags = new Set(["--id", "--content", "--scope", "--query", "--tags", "--reason", "--output"]);
  for (let index = 2; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (valueFlags.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("--")) continue;
    values.push(value);
  }
  return values.join(" ").trim() || undefined;
}

function parseRevertTarget(args: readonly string[]): WorkspaceRevertRequestTarget {
  const requestId = readFlagValue(args, "--request");
  const turnId = readFlagValue(args, "--turn");
  const sessionId = readFlagValue(args, "--session");
  const path = readFlagValue(args, "--path");
  const target: Record<string, unknown> = {};
  if (requestId) target.requestId = requestId;
  if (turnId) target.turnId = asId<"turn">(turnId);
  if (sessionId) target.sessionId = asId<"session">(sessionId);
  if (path) target.path = path;
  return target as WorkspaceRevertRequestTarget;
}

function parsePaletteAction(args: readonly string[]): CliOptions["paletteAction"] {
  const action = args[1];
  if (action === "keymap") return "keymap";
  if (action === "action") return "action";
  return "list";
}

function parsePaletteKeymapProfile(value: string | undefined): CliKeymapProfileName {
  if (value === "core" || value === "vi-professional") return value;
  return "vi-minimal";
}

function parseTuiProfile(args: readonly string[]): CliTuiProfile | undefined {
  const value = readFlagValue(args, "--tui");
  if (value === "auto" || value === "line" || value === "full-screen" || value === "off") return value;
  return undefined;
}

function parseExtensionCommand(args: readonly string[]): ExtensionManagementCommandKind {
  const domain = args[1];
  const action = args[2];
  if (domain === "plugin") {
    if (action === "install") return "extension.plugin.install";
    if (action === "verify") return "extension.plugin.verify";
    if (action === "snapshot") return "extension.plugin.snapshot";
    if (action === "apply-lockfile") return "extension.plugin.apply-lockfile";
    if (action === "contributions") return "extension.plugin.contributions";
  }
  if (domain === "skill") {
    if (action === "activate") return "extension.skill.activate";
    return "extension.skill.list";
  }
  if (domain === "auth") return "extension.auth.scopes";
  if (domain === "mcp") return "extension.mcp.test";
  return "extension.list";
}

function parseExtensionInput(args: readonly string[]): JsonObject {
  const input: Record<string, unknown> = {};
  const domain = args[1];
  const action = args[2];
  if (domain === "plugin") {
    const path = args[3] && !args[3].startsWith("-") ? args[3] : undefined;
    if (path) input.path = path;
  }
  if (domain === "skill") {
    const name = args[3] && !args[3].startsWith("-") ? args[3] : undefined;
    if (name) input.name = name;
  }
  if (domain === "mcp") {
    const manifestPath = args[3] && !args[3].startsWith("-") ? args[3] : undefined;
    if (manifestPath) input.manifestPath = manifestPath;
    const callTool = readFlagValue(args, "--call");
    const callInput = readFlagValue(args, "--input");
    if (callTool) input.callTool = callTool;
    if (callInput) input.callInput = callInput;
    if (args.includes("--enable-real-mcp")) input.enableRealMcp = true;
  }
  if (domain === "auth") {
    const manifestPath = readFlagValue(args, "--manifest");
    if (manifestPath) input.manifestPath = manifestPath;
  }
  input.domain = domain ?? "list";
  input.action = action ?? "list";
  return input as JsonObject;
}

function parseReadinessInput(command: ReadinessCommandName, args: readonly string[]): JsonObject {
  const input: Record<string, unknown> = {};
  if (args.includes("--force")) input.force = true;
  if (command === "doctor" && args.includes("--live")) input.live = true;
  if (command === "doctor" && args.includes("--fake-live")) {
    input.live = true;
    input.fakeLive = true;
  }
  if (command === "auth" && args.includes("logout")) input.logout = true;
  if (command === "config" && args[1] === "set") {
    input.setKey = args[2] ?? "";
    input.setValue = parseConfigValue(args[3] ?? "");
    input.scope = args.includes("--user") ? "user" : "workspace";
  }
  return input as JsonObject;
}

function parseDiagnosticsCommand(value: string | undefined): DiagnosticsCommandName {
  return isDiagnosticsCommand(value) ? value : "bundle";
}

function parseDiagnosticsInput(command: DiagnosticsCommandName, args: readonly string[]): JsonObject {
  const input: Record<string, unknown> = { command };
  const maxRecords = parsePositiveNumberFlag(args, "--max-records");
  if (maxRecords) input.maxRecords = maxRecords;
  if (args.includes("--external")) input.external = true;
  if (args.includes("--fake-secret")) input.fakeSecret = true;
  if (args.includes("--live")) input.live = true;
  const provider = parseModelProvider(args);
  if (provider) input.provider = provider;
  const model = readFlagValue(args, "--model");
  if (model) input.model = model;
  const severities = readRepeatedFlagValues(args, "--severity");
  if (severities.length > 0) input.severities = severities;
  const packages = readRepeatedFlagValues(args, "--package");
  if (packages.length > 0) input.packages = packages;
  const capabilities = readRepeatedFlagValues(args, "--capability");
  if (capabilities.length > 0) input.capabilities = capabilities;
  const productReadyClaims = readRepeatedFlagValues(args, "--product-ready");
  if (productReadyClaims.length > 0) input.productReadyClaims = productReadyClaims;
  if (command === "refresh") {
    input.full = args.includes("--full");
    input.dryRun = args.includes("--dry-run");
    input.extraArgs = extraDiagnosticsArgs(args, new Set(["--full", "--dry-run"]));
  }
  if (command === "env") {
    const rawAction = args[2];
    const execute = args.includes("--execute") && !args.includes("--dry-run");
    input.action = rawAction && !rawAction.startsWith("--") ? rawAction : "prepare";
    input.profile = readFlagValue(args, "--profile") ?? "swe-bench-lite";
    input.dryRun = !execute;
    input.execute = execute;
    input.extraArgs = extraDiagnosticsArgs(args, new Set(["--execute", "--dry-run"]), new Set(["prepare"]));
  }
  if (command === "flow") {
    const rawAction = args[2];
    input.action = rawAction && !rawAction.startsWith("--") ? rawAction : "inspect";
    input.prompt = readFlagValue(args, "--prompt") ?? "";
    input.extraArgs = extraDiagnosticsArgs(args, new Set(), new Set(["inspect"]));
  }
  if (command === "evaluate") {
    input.full = args.includes("--full");
    input.smoke = args.includes("--smoke");
    input.dryRun = args.includes("--dry-run");
    input.baseline = readFlagValue(args, "--baseline") ?? "deepseek-cli";
    const compareBaselines = readRepeatedFlagValues(args, "--compare-baseline");
    if (compareBaselines.length > 0) input.compareBaselines = compareBaselines;
    input.allowExternalBaseline = args.includes("--allow-external-baseline");
    const baselineCommand = readFlagValue(args, "--baseline-command");
    if (baselineCommand) input.baselineCommand = baselineCommand;
    const codexCommand = readFlagValue(args, "--codex-command");
    if (codexCommand) input.codexCommand = codexCommand;
    const claudeCommand = readFlagValue(args, "--claude-command");
    if (claudeCommand) input.claudeCommand = claudeCommand;
    const executeTask = readFlagValue(args, "--execute-task");
    if (executeTask) input.executeTask = executeTask;
    input.baselineArgs = readRepeatedFlagValues(args, "--baseline-arg");
    input.extraArgs = extraDiagnosticsArgs(args, new Set(["--full", "--smoke", "--dry-run"]));
  }
  return input as JsonObject;
}

function extraDiagnosticsArgs(args: readonly string[], knownBooleanFlags: ReadonlySet<string>, knownPositionals: ReadonlySet<string> = new Set()): readonly string[] {
  const extras: string[] = [];
  for (let index = 2; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (knownPositionals.has(value)) continue;
    if (
      value === "--output" ||
      value === "--max-records" ||
      value === "--tool-projection" ||
      value === "--provider" ||
      value === "--model-provider" ||
      value === "--model" ||
      value === "--profile" ||
      value === "--prompt" ||
      value === "--baseline" ||
      value === "--compare-baseline" ||
      value === "--baseline-command" ||
      value === "--codex-command" ||
      value === "--claude-command" ||
      value === "--baseline-arg" ||
      value === "--execute-task" ||
      value === "--severity" ||
      value === "--package" ||
      value === "--capability" ||
      value === "--product-ready"
    ) {
      index += 1;
      continue;
    }
    if (value === "--allow-external-baseline") continue;
    if (value === "--live") continue;
    if (value === "--external" || value === "--fake-secret" || knownBooleanFlags.has(value)) continue;
    extras.push(value);
  }
  return extras;
}

function parseConfigValue(value: string): string | boolean | number {
  if (value === "true") return true;
  if (value === "false") return false;
  const numberValue = Number(value);
  return value.trim() !== "" && Number.isFinite(numberValue) ? numberValue : value;
}

function parseOutputMode(args: readonly string[]): AgentLoopOutputMode {
  const index = args.indexOf("--output");
  const value = index >= 0 ? args[index + 1] : undefined;
  return value === "json" || value === "jsonl" || value === "text" ? value : defaultOutputMode;
}

function parseOutputContract(args: readonly string[]): AgentLoopOutputContract | undefined {
  const kind = parseOutputContractKind(readFlagValue(args, "--output-contract"));
  if (!kind) return undefined;
  const schema = parseJsonObjectFlag(args, "--output-schema");
  const path = readFlagValue(args, "--output-contract-path");
  const description = readFlagValue(args, "--output-contract-description");
  return {
    schemaVersion: "1.0.0",
    kind,
    required: !args.includes("--output-contract-optional"),
    ...(description ? { description } : {}),
    ...(path ? { path } : {}),
    ...(schema ? { schema } : {}),
    redaction: { class: "internal" }
  };
}

function parseOutputContractKind(value: string | undefined): AgentLoopOutputContractKind | undefined {
  if (value === "json-object" || value === "json-file" || value === "file" || value === "command-plan") return value;
  return undefined;
}

function parseJsonObjectFlag(args: readonly string[], name: string): JsonObject | undefined {
  const value = readFlagValue(args, name);
  if (!value) return undefined;
  return jsonObjectFromString(value);
}

function jsonObjectFromString(value: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(value) as JsonValue;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : undefined;
  } catch {
    return undefined;
  }
}

function parseToolProjection(args: readonly string[]): CliOptions["toolProjection"] {
  if (args.includes("--no-tools")) return "none";
  const value = readFlagValue(args, "--tool-projection");
  if (value === "none" || value === "read-only" || value === "read-write" || value === "all") return value;
  return undefined;
}

function parseModelProvider(args: readonly string[]): CliOptions["modelProvider"] {
  const value = readFlagValue(args, "--provider") ?? readFlagValue(args, "--model-provider");
  if (value === "deepseek" || value === "glm") return value;
  return undefined;
}

function parseReasoningOptions(args: readonly string[]): ModelReasoningOptions | undefined {
  const value = readFlagValue(args, "--thinking") ?? readFlagValue(args, "--reasoning-effort");
  if (!value) return undefined;
  if (value === "off" || value === "disabled" || value === "none" || value === "false") return { enabled: false };
  if (value === "on" || value === "enabled" || value === "true") return { enabled: true };
  const providerEffort = parseProviderEffort(value);
  if (providerEffort) return { enabled: true, providerEffort };
  const effort = parseReasoningEffort(value);
  return effort ? { enabled: true, effort } : undefined;
}

function parseReasoningEffort(value: string): ModelReasoningEffort | undefined {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  return undefined;
}

function parseProviderEffort(value: string): ModelReasoningProviderEffort | undefined {
  if (value === "max") return "max";
  return undefined;
}

function parsePositiveNumberFlag(args: readonly string[], name: string): number | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function readFlagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return typeof value === "string" && !value.startsWith("-") ? value : undefined;
}

function readRepeatedFlagValues(args: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (typeof value === "string") values.push(value);
  }
  return values;
}

function promptFromArgs(args: readonly string[]): string {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (
      value === "--output" ||
      value === "--timeout-ms" ||
      value === "--tool-projection" ||
      value === "--tui" ||
      value === "--thinking" ||
      value === "--reasoning-effort" ||
      value === "--provider" ||
      value === "--model-provider" ||
      value === "--model" ||
      value === "--output-contract" ||
      value === "--output-contract-path" ||
      value === "--output-schema" ||
      value === "--output-schema-file" ||
      value === "--output-contract-description"
    ) {
      index += 1;
      continue;
    }
    if (value === "--palette") continue;
    if (value === "--live") continue;
    if (value === "--no-tools") continue;
    if (value === "--output-contract-optional") continue;
    filtered.push(value);
  }
  return filtered.join(" ").trim();
}

function isReadinessCommand(value: string | undefined): value is ReadinessCommandName {
  return typeof value === "string" && readinessCommands.has(value as ReadinessCommandName);
}

function isDiagnosticsCommand(value: string | undefined): value is DiagnosticsCommandName {
  return typeof value === "string" && diagnosticsCommands.has(value as DiagnosticsCommandName);
}
