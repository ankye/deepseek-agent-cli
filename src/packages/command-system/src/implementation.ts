import type {
  CommandId,
  CommandCompositionRecord,
  CommandManifest,
  CommandSystem,
  IndexProviderDiagnosticsSummary,
  JsonObject,
  JsonValue,
  ModelLiveVerificationResult,
  PlatformDescriptor,
  ReadinessCheck,
  ReadinessCommandName,
  ReadinessCommandResult,
  ReadinessCredentialReference,
  ReadinessModelProviderMetadata,
  ReleasePackageSurface,
  ReleaseVerificationEvidence,
  ResolvedConfig,
  SerializableResult
} from "@deepseek/platform-contracts";
import type { StoredCredentialReference } from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import { commandManifestToCompositionRecord, projectModelVisible } from "./composition.js";

export type InteractiveControlCommandName = "help" | "exit" | "quit" | "clear" | "cancel" | "resume" | "fork";
export type InteractiveControlAction = "help" | "exit" | "clear" | "cancel" | "resume" | "fork";

export interface InteractiveControlResult extends JsonObject {
  readonly action: InteractiveControlAction;
  readonly command: InteractiveControlCommandName;
  readonly message: string;
  readonly terminal: boolean;
  readonly controls?: readonly JsonObject[];
  readonly sessionId?: string;
  readonly parentSessionId?: string;
}

export class InMemoryCommandSystem implements CommandSystem {
  private readonly manifests = new Map<string, CommandManifest>();
  private readonly aliases = new Map<string, string>();
  private readonly handlers = new Map<string, (input: JsonObject) => Promise<SerializableResult>>();

  async register(manifest: CommandManifest, handler?: (input: JsonObject) => Promise<SerializableResult>): Promise<void> {
    this.manifests.set(manifest.id, manifest);
    this.aliases.set(manifest.name, manifest.id);
    for (const alias of manifest.aliases) this.aliases.set(alias, manifest.id);
    if (handler) this.handlers.set(manifest.id, handler);
  }

  async invoke(nameOrAlias: string, input: JsonObject): Promise<SerializableResult> {
    const id = this.aliases.get(nameOrAlias);
    const handler = id ? this.handlers.get(id) : undefined;
    if (!handler) {
      return { ok: false, error: { code: "COMMAND_NOT_FOUND", message: nameOrAlias, retryable: false, redaction: { class: "public" } } };
    }
    return handler(input);
  }

  async help(): Promise<readonly CommandManifest[]> {
    return [...this.manifests.values()];
  }
}

export interface LocalReadinessEnvironment {
  readonly cwd: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly envFile?: Readonly<Record<string, string | undefined>>;
  readonly ignoredPaths: readonly string[];
  readonly availableCommands: readonly string[];
  readonly platformDescriptor?: PlatformDescriptor;
  readonly config?: JsonObject;
  readonly resolvedConfig?: ResolvedConfig;
  readonly credentialReferences?: readonly StoredCredentialReference[];
  readonly workspaceMetadataPath?: string;
  readonly modelProvider?: ReadinessModelProviderMetadata;
  readonly liveVerifier?: () => Promise<ModelLiveVerificationResult>;
  readonly initialized?: boolean;
  readonly initializedThisRun?: boolean;
  readonly releasePackageSurface?: ReleasePackageSurface;
  readonly releaseVerification?: ReleaseVerificationEvidence;
  readonly supportBundlePolicy?: JsonObject;
  readonly indexProviderDiagnostics?: IndexProviderDiagnosticsSummary;
}

export function createDefaultReadinessEnvironment(env: Readonly<Record<string, string | undefined>>): LocalReadinessEnvironment {
  return {
    cwd: ".",
    nodeVersion: "unknown",
    platform: "unknown",
    packageName: "deepseek-cli-platform",
    packageVersion: "0.1.0",
    env,
    ignoredPaths: [".env", ".env.*", "参考/"],
    availableCommands: ["node", "npm"],
    config: {},
    initialized: false
  };
}

export async function registerLocalReadinessCommands(commandSystem: CommandSystem, environment: LocalReadinessEnvironment): Promise<void> {
  for (const command of readinessCommandNames) {
    await commandSystem.register(readinessManifest(command), async (input) => ({
      ok: true,
      value: await runLocalReadinessCommand(command, input, environment)
    }));
  }
}

export async function runLocalReadinessCommand(command: ReadinessCommandName, input: JsonObject, environment: LocalReadinessEnvironment): Promise<ReadinessCommandResult> {
  switch (command) {
    case "init":
      return readinessResult(command, environment, initChecks(environment, input), { initialized: Boolean(environment.initialized), initializedThisRun: Boolean(environment.initializedThisRun), force: Boolean(input.force), workspaceMetadataPath: environment.workspaceMetadataPath });
    case "config":
      return readinessResult(command, environment, configChecks(environment), { configKeys: Object.keys(environment.config ?? {}).sort(), resolvedConfig: redactedResolvedConfig(environment.resolvedConfig) });
    case "auth": {
      const provider = selectedModelProvider(environment);
      const credential = credentialReference(environment, provider);
      return readinessResult(command, environment, authChecks(credential, provider), { provider, credentialCount: environment.credentialReferences?.length ?? 0 }, credential);
    }
    case "doctor": {
      const provider = selectedModelProvider(environment);
      const credential = credentialReference(environment, provider);
      const live = input.live === true && environment.liveVerifier ? await environment.liveVerifier() : undefined;
      return readinessResult(command, environment, [...platformChecks(environment), ...configChecks(environment), ...authChecks(credential, provider), ignoredPathCheck(environment), ...indexProviderChecks(environment), ...releaseReadinessChecks(environment), ...liveChecks(live, input.live === true, provider)], {
        checkGroup: "doctor",
        provider,
        liveRequested: input.live === true,
        indexProviders: indexProviderMetadata(environment.indexProviderDiagnostics),
        release: releaseMetadata(environment),
        supportBundle: supportBundleMetadata(environment)
      }, credential, live, environment.indexProviderDiagnostics);
    }
    case "privacy":
      return readinessResult(command, environment, privacyChecks(environment), { telemetryExport: resolvedValue(environment, "telemetry") ?? "disabled", diagnosticsPersistence: "local-redacted", privacy: resolvedValue(environment, "privacy") ?? "local", supportBundle: supportBundleMetadata(environment) });
    case "verify-install":
      return readinessResult(command, environment, [...verifyInstallChecks(environment), ...releaseReadinessChecks(environment)], { packageName: environment.packageName, packageVersion: environment.packageVersion, release: releaseMetadata(environment), supportBundle: supportBundleMetadata(environment) });
  }
}

export async function invokeLocalReadinessCommand(command: ReadinessCommandName, input: JsonObject, environment: LocalReadinessEnvironment): Promise<SerializableResult<ReadinessCommandResult>> {
  const commandSystem = new InMemoryCommandSystem();
  await registerLocalReadinessCommands(commandSystem, environment);
  const result = await commandSystem.invoke(command, input);
  if (!result.ok || !isReadinessResult(result.value)) {
    return { ok: false, error: result.error ?? { code: "READINESS_COMMAND_FAILED", message: command, retryable: false, redaction: { class: "public" } } };
  }
  return { ok: true, value: result.value };
}

export const readinessCommandNames = ["init", "config", "auth", "doctor", "privacy", "verify-install"] as const satisfies readonly ReadinessCommandName[];
export const interactiveControlCommandNames = ["help", "exit", "quit", "clear", "cancel", "resume", "fork"] as const satisfies readonly InteractiveControlCommandName[];
const registeredInteractiveControlCommandNames = ["help", "exit", "clear", "cancel", "resume", "fork"] as const satisfies readonly InteractiveControlCommandName[];

export async function registerInteractiveControlCommands(commandSystem: CommandSystem): Promise<void> {
  for (const command of registeredInteractiveControlCommandNames) {
    await commandSystem.register(interactiveControlManifest(command), async (input) => runInteractiveControlCommand(command, input));
  }
}

export async function invokeInteractiveControlCommand(command: InteractiveControlCommandName, input: JsonObject = {}): Promise<SerializableResult<InteractiveControlResult>> {
  return invokeInteractiveCommand(command, input);
}

export async function invokeInteractiveCommand(nameOrAlias: string, input: JsonObject = {}): Promise<SerializableResult<InteractiveControlResult>> {
  const commandSystem = new InMemoryCommandSystem();
  await registerInteractiveControlCommands(commandSystem);
  const result = await commandSystem.invoke(nameOrAlias, input);
  if (!result.ok || !isInteractiveControlResult(result.value)) {
    return { ok: false, error: result.error ?? { code: "INTERACTIVE_COMMAND_FAILED", message: nameOrAlias, retryable: false, redaction: { class: "public" } } };
  }
  return { ok: true, value: result.value };
}

export function interactiveControlManifest(command: InteractiveControlCommandName): CommandManifest {
  const registeredCommand = command === "quit" ? "exit" : command;
  return {
    id: interactiveCommandId(registeredCommand),
    name: registeredCommand,
    aliases: registeredCommand === "exit" ? ["quit"] : [],
    modes: ["user", "host"],
    hostSupport: ["cli"],
    sideEffect: interactiveControlSideEffect(registeredCommand),
    ownerSubsystem: "command-system",
    source: { kind: "built-in", id: "interactive-controls", trust: "trusted" },
    permissions: [],
    target: { kind: "command", id: `command:interactive.${registeredCommand}` },
    projection: {
      userVisible: true,
      hostVisible: true,
      modelVisible: false,
      resultListVisible: true,
      hostOnly: interactiveControlAction(registeredCommand) !== "help",
      group: "interactive-controls"
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      required: ["action", "command", "message", "terminal"],
      properties: {
        action: { type: "string" },
        command: { type: "string" },
        message: { type: "string" },
        terminal: { type: "boolean" }
      }
    },
    redaction: { class: "public" },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { type: "string" },
        sessionId: { type: "string" },
        parentSessionId: { type: "string" }
      }
    }
  };
}

export function readinessManifest(command: ReadinessCommandName): CommandManifest {
  return {
    id: commandId(command),
    name: command,
    aliases: command === "verify-install" ? ["verify"] : [],
    modes: ["user", "host"],
    hostSupport: ["cli", "vscode", "server"],
    sideEffect: command === "init" ? "workspace-metadata" : "none",
    ownerSubsystem: "command-system",
    source: { kind: "built-in", id: "local-readiness", trust: "trusted" },
    permissions: command === "init" ? ["workspace:metadata"] : [],
    target: { kind: "command", id: `command:readiness.${command}` },
    projection: {
      userVisible: true,
      hostVisible: true,
      modelVisible: false,
      resultListVisible: true,
      hostOnly: false,
      group: "readiness"
    },
    outputSchema: {
      type: "object",
      additionalProperties: true,
      required: ["commandId", "command", "status", "checks"],
      properties: {
        commandId: { type: "string" },
        command: { type: "string" },
        status: { type: "string" },
        checks: { type: "array" }
      }
    },
    redaction: { class: "internal", fields: ["credential", "metadata.env"] },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: command === "init" ? { force: { type: "boolean" } } : {}
    }
  };
}

function runInteractiveControlCommand(command: InteractiveControlCommandName, input: JsonObject): SerializableResult<InteractiveControlResult> {
  const action = interactiveControlAction(command);
  return {
    ok: true,
    value: {
      action,
      command,
      terminal: action === "exit",
      message: interactiveControlMessage(command, input),
      ...(typeof input.sessionId === "string" ? { sessionId: input.sessionId } : {}),
      ...(typeof input.parentSessionId === "string" ? { parentSessionId: input.parentSessionId } : {}),
      ...(action === "help" ? { controls: interactiveHelpProjection() } : {})
    }
  };
}

function interactiveControlAction(command: InteractiveControlCommandName): InteractiveControlAction {
  if (command === "quit") return "exit";
  return command;
}

function interactiveControlSideEffect(command: InteractiveControlCommandName): string {
  const action = interactiveControlAction(command);
  if (action === "cancel") return "runtime-control";
  if (action === "exit") return "host-lifecycle";
  if (action === "clear") return "host-render";
  if (action === "resume" || action === "fork") return "session-control";
  return "none";
}

function interactiveControlMessage(command: InteractiveControlCommandName, input: JsonObject): string {
  const action = interactiveControlAction(command);
  if (action === "help") return "Interactive controls are available.";
  if (action === "exit") return "Interactive session closing.";
  if (action === "clear") return "Interactive display cleared.";
  if (action === "resume") return typeof input.sessionId === "string" ? `Resume requested: ${input.sessionId}` : "Resume requires a session id.";
  if (action === "fork") return typeof input.parentSessionId === "string" ? `Fork requested: ${input.parentSessionId}` : "Fork requires a parent session id.";
  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : "user requested cancellation";
  return `Cancellation requested: ${reason}`;
}

export function interactiveHelpProjection(): readonly JsonObject[] {
  return interactiveControlCompositionRecords().map((record) => ({
    id: record.id,
    target: record.target,
    name: `/${record.displayName}`,
    aliases: record.aliases.map((alias) => `/${alias}`),
    action: interactiveControlAction(record.displayName as InteractiveControlCommandName),
    sideEffect: record.sideEffect,
    hostSupport: record.hostSupport ?? [],
    redaction: record.redaction
  }));
}

export function interactiveControlCompositionRecords(): readonly CommandCompositionRecord[] {
  return registeredInteractiveControlCommandNames.map((command) => commandManifestToCompositionRecord(interactiveControlManifest(command)));
}

export function readinessCompositionRecords(): readonly CommandCompositionRecord[] {
  return readinessCommandNames.map((command) => commandManifestToCompositionRecord(readinessManifest(command)));
}

export function modelVisibleInteractiveControlProjection(): readonly CommandCompositionRecord[] {
  return projectModelVisible(interactiveControlCompositionRecords()).records;
}

export function renderInteractiveControlText(result: InteractiveControlResult): readonly string[] {
  if (result.action === "help") {
    const lines: string[] = ["Chat controls:"];
    for (const entry of interactiveHelpProjection()) {
      const name = String(entry.name ?? "");
      const aliases = Array.isArray(entry.aliases) ? (entry.aliases as readonly string[]) : [];
      const aliasSuffix = aliases.length > 0 ? ` (aliases: ${aliases.join(", ")})` : "";
      lines.push(`  ${name}${aliasSuffix} — ${String(entry.sideEffect ?? "")}`);
    }
    lines.push("  /cost — show accumulated token usage for the current session");
    lines.push("  /model — show the active model profile");
    lines.push("  /mode|/agent|/workers|/verify|/plan — show local mode, agent, worker, verifier, and phase-plan status");
    lines.push("  tui — DeepSeek Workbench with transcript, command bar, reasoning rail, inspector, activity feed, and plugin shelf");
    lines.push("  focus keys — Tab/Shift+Tab move panels; / opens command search; r/i/a/p focus reasoning, inspector, activity, plugins");
    lines.push("  reasoning — visible summaries show intent, evidence, actions, verification, outcome, ids, and fingerprints without raw provider reasoning");
    lines.push("  plugins — native metadata shelf; declarative command/action/keymap/palette/result-list/render-hint contributions only");
    lines.push("  first-party plugins — dev-checks, repo-navigator, file-manager, jump-navigator, git-review, context-compactor metadata enabled");
    lines.push("  /context status|grep|describe|summarize|expand|budget|pin — inspect and compact lossless context");
    lines.push("  /file list|preview|refs <query> — run local file manager workflows and attach active file results");
    lines.push("  /jump file|text|symbol <query> — run local jump navigator workflows backed by host-owned workspace search and code intelligence");
    lines.push("  /palette — show local command palette entries");
    lines.push("  /palette next|previous|first|last — move local palette result focus");
    lines.push("  /palette back|forward — traverse local palette jump history");
    lines.push("  /palette recall <query> — search completed chat turns in the local PageIndex");
    lines.push("  /palette refs add <target-id|current> — add a palette result to the active reference set");
    lines.push("  /palette refs list — show active reference sets and items");
    lines.push("  /palette refs focus <ref-id|index|target-id|current> — switch active reference focus");
    lines.push("  /palette state — show local palette focus, jumps, and references");
    lines.push("  /palette action <action> <target-id> — preview a local palette action");
    lines.push("  /keymap [core|vi-minimal] — show local keymap bindings");
    lines.push("  /revert preview --request <id>|--turn <id>|--session <id> [--path <path>] — preview request/turn rollback impact");
    lines.push("  /revert preview current — preview rollback impact for the selected chat history turn");
    lines.push("  /revert review current — create a local rollback review for the selected chat history turn");
    lines.push("  /revert confirm <review-id|current> — apply a previously reviewed rollback target");
    lines.push("  /revert apply current — apply rollback for the selected chat history turn through checkpoint safety checks");
    lines.push("  /history — show local completed chat turns");
    lines.push("  /history select <turn-id|index|current|last> — select a chat history turn");
    lines.push("Ctrl+C once cancels an active turn; Ctrl+C twice within 2s exits.");
    return lines;
  }
  if (result.action === "clear") {
    return ["\x1B[2J\x1B[H", ""];
  }
  if (result.action === "exit") {
    return [`[chat] ${result.message || "exit requested"}`];
  }
  if (result.action === "cancel") {
    return [`[chat] ${result.message || "cancellation requested"}`];
  }
  return [`[chat] ${result.action}: ${result.message}`];
}

function readinessResult(
  command: ReadinessCommandName,
  environment: LocalReadinessEnvironment,
  checks: readonly ReadinessCheck[],
  metadata: JsonObject,
  credential?: ReadinessCredentialReference,
  live?: ModelLiveVerificationResult,
  indexProviders?: IndexProviderDiagnosticsSummary
): ReadinessCommandResult {
  const warnings = checks.filter((check) => check.status === "warn").map((check) => check.message);
  const status = checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "warn") ? "warn" : "pass";
  return {
    commandId: commandId(command),
    command,
    status,
    checks,
    warnings,
    metadata: {
      cwd: environment.cwd,
      platform: environment.platform,
      nodeVersion: environment.nodeVersion,
      ...metadata
    },
    suggestedActions: [...new Set(checks.flatMap((check) => check.suggestedActions ?? []))],
    ...(credential ? { credential } : {}),
    ...(live ? { live } : {}),
    ...(indexProviders ? { indexProviders } : {}),
    redaction: { class: "internal", fields: ["credential", "metadata.env", "indexProviders.providers.metadata", "indexProviders.providers.activationEvidence.metadata", "indexProviders.providers.diagnostics.details"] }
  };
}

function initChecks(environment: LocalReadinessEnvironment, input: JsonObject): readonly ReadinessCheck[] {
  const alreadyInitialized = Boolean(environment.initialized);
  const initializedThisRun = Boolean(environment.initializedThisRun);
  return [
    check("workspace.access", "Workspace access", "pass", `Workspace is available at ${environment.cwd}.`),
    check(
      "init.state",
      "Initialization state",
      alreadyInitialized && !input.force ? "warn" : "pass",
      alreadyInitialized && !input.force
        ? "Workspace already has readiness metadata; no files were rewritten."
        : initializedThisRun
          ? "Workspace readiness metadata was initialized."
          : "Workspace can be initialized.",
      alreadyInitialized && !input.force ? ["Use --force only when you intend to refresh generated metadata."] : []
    )
  ];
}

function configChecks(environment: LocalReadinessEnvironment): readonly ReadinessCheck[] {
  const config = environment.config ?? {};
  const keys = Object.keys(config);
  const unknownKeys = keys.filter((key) => !knownConfigKeys.has(key));
  const diagnostics = environment.resolvedConfig?.diagnostics ?? [];
  return [
    check("config.loaded", "Config loaded", "pass", keys.length === 0 ? "No local config values found; defaults will be used." : `${keys.length} local config value(s) found.`, [], { keys }),
    check(
      "config.known-keys",
      "Config known keys",
      unknownKeys.length > 0 || diagnostics.some((diagnostic) => diagnostic.severity === "warn") ? "warn" : diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "fail" : "pass",
      unknownKeys.length > 0 ? `Unknown config key(s): ${unknownKeys.join(", ")}.` : diagnostics.length > 0 ? `${diagnostics.length} config diagnostic(s) found.` : "All config keys are known.",
      diagnostics.flatMap((diagnostic) => diagnostic.suggestedActions ?? []),
      { unknownKeys, diagnosticCodes: diagnostics.map((diagnostic) => diagnostic.code) }
    )
  ];
}

function authChecks(credential: ReadinessCredentialReference, provider: ReadinessModelProviderMetadata): readonly ReadinessCheck[] {
  const envAction = provider.provider === "glm"
    ? "Set GLM_ANTHROPIC_API_KEY or ZHIPU_API_KEY in an untracked local environment source."
    : "Set DEEPSEEK_API_KEY or DEEPSEEK_TOKEN in an untracked local environment source.";
  return [
    check(
      `auth.${provider.provider}`,
      `${provider.label} credential`,
      credential.available ? "pass" : "warn",
      credential.available ? `${provider.label} credential reference ${credential.ref} is available from ${credential.source}.` : `${provider.label} credential was not found.`,
      credential.available ? [] : [envAction],
      { provider: credential.provider, protocol: provider.protocol, model: provider.model, source: credential.source, available: credential.available }
    )
  ];
}

function platformChecks(environment: LocalReadinessEnvironment): readonly ReadinessCheck[] {
  const descriptor = environment.platformDescriptor;
  if (descriptor) {
    return [
      check("platform.descriptor", "Platform descriptor", descriptor.degraded ? "warn" : "pass", `Platform ${descriptor.os}/${descriptor.environmentKind} (${descriptor.architecture}) detected.`, [], {
        os: descriptor.os,
        environmentKind: descriptor.environmentKind,
        architecture: descriptor.architecture,
        degraded: descriptor.degraded,
        degradedReasons: descriptor.degradedReasons
      }),
      check("platform.shell", "Shell provider", descriptor.shell.available ? "pass" : "warn", descriptor.shell.available ? `Shell provider ${descriptor.shell.provider} is available.` : "Shell provider is unavailable.", descriptor.shell.diagnostics.flatMap((diagnostic) => diagnostic.suggestedActions), {
        profile: descriptor.shell.profile,
        provider: descriptor.shell.provider,
        status: descriptor.shell.status,
        diagnostics: descriptor.shell.diagnostics.map((diagnostic) => diagnostic.code)
      }),
      check("platform.search", "Search provider", descriptor.search.status === "available" ? "pass" : "warn", `Search provider ${descriptor.search.provider} selected.`, descriptor.search.diagnostics.flatMap((diagnostic) => diagnostic.suggestedActions), {
        provider: descriptor.search.provider,
        status: descriptor.search.status,
        fallbackChain: descriptor.search.fallbackChain,
        timeoutMs: descriptor.search.timeoutMs,
        diagnostics: descriptor.search.diagnostics.map((diagnostic) => diagnostic.code)
      }),
      check("platform.secure-storage", "Secure storage", descriptor.secureStorage.status === "available" ? "pass" : "warn", `Secure storage provider: ${descriptor.secureStorage.provider}.`, descriptor.secureStorage.diagnostics.flatMap((diagnostic) => diagnostic.suggestedActions), {
        provider: descriptor.secureStorage.provider,
        status: descriptor.secureStorage.status,
        diagnostics: descriptor.secureStorage.diagnostics.map((diagnostic) => diagnostic.code)
      }),
      check("platform.native", "Native capabilities", descriptor.nativeCapabilities.every((capability) => capability.status !== "unavailable") ? "pass" : "warn", `${descriptor.nativeCapabilities.filter((capability) => capability.status === "unavailable").length} native capability probe(s) unavailable.`, descriptor.nativeCapabilities.flatMap((capability) => capability.diagnostics.flatMap((diagnostic) => diagnostic.suggestedActions)), {
        capabilities: descriptor.nativeCapabilities.map((capability) => ({ name: capability.capability, status: capability.status, provider: capability.provider }))
      })
    ];
  }
  return [
    check("platform.os", "Platform", "pass", `Platform detected: ${environment.platform}.`, [], { platform: environment.platform }),
    check("platform.node", "Node.js", environment.nodeVersion.startsWith("v") ? "pass" : "warn", `Node version: ${environment.nodeVersion}.`, [], { nodeVersion: environment.nodeVersion }),
    check("platform.commands", "Command availability", environment.availableCommands.includes("node") ? "pass" : "warn", `Available commands: ${environment.availableCommands.join(", ") || "none"}.`, [], { commands: environment.availableCommands })
  ];
}

function privacyChecks(environment: LocalReadinessEnvironment): readonly ReadinessCheck[] {
  const telemetry = resolvedValue(environment, "telemetry") ?? "disabled";
  const privacy = resolvedValue(environment, "privacy") ?? "local";
  return [
    check("privacy.telemetry", "Telemetry export", telemetry === "enabled" ? "warn" : "pass", `Telemetry export policy: ${telemetry}.`, telemetry === "enabled" ? ["Review telemetry policy before sharing diagnostics."] : [], { export: telemetry }),
    check("privacy.diagnostics", "Diagnostics persistence", "pass", "Diagnostics are local and redacted by default.", [], { persistence: "local-redacted", privacy })
  ];
}

function verifyInstallChecks(environment: LocalReadinessEnvironment): readonly ReadinessCheck[] {
  return [
    check("install.package", "Package metadata", "pass", `${environment.packageName}@${environment.packageVersion} is available.`, [], { packageName: environment.packageName, packageVersion: environment.packageVersion }),
    check("install.executable", "Executable", "pass", "CLI executable surface is available through the current workspace.", [], { command: "deepseek" }),
    ignoredPathCheck(environment)
  ];
}

function releaseReadinessChecks(environment: LocalReadinessEnvironment): readonly ReadinessCheck[] {
  const release = environment.releasePackageSurface;
  const verification = environment.releaseVerification;
  if (!release || !verification) {
    return [check("release.readiness", "Release readiness", "warn", "Release readiness metadata was not provided by the host adapter.", ["Run deepseek diagnostics release from the CLI host."], { available: false })];
  }
  return [
    check("release.package", "CLI package metadata", release.packageName === "deepseek-agent-cli" ? "pass" : "fail", `${release.packageName}@${release.packageVersion}.`, [], { packageName: release.packageName, packageVersion: release.packageVersion }),
    check("release.bin", "CLI executable", release.executableName === "deepseek" && release.binEntry === "dist/index.js" ? "pass" : "fail", `${release.executableName} -> ${release.binEntry}.`, [], { executableName: release.executableName, binEntry: release.binEntry }),
    check("release.package-files", "Package files", release.expectedPackageFiles.includes("dist") && release.expectedPackageFiles.includes("README.md") ? "pass" : "warn", `Expected package files: ${release.expectedPackageFiles.join(", ")}.`, [], { expectedPackageFiles: release.expectedPackageFiles }),
    check("release.publish-dry-run", "npm publish dry-run", verification.publishDryRunEvidence?.status ?? "fail", verification.publishDryRunEvidence?.message ?? "npm publish dry-run evidence is missing.", publishDryRunActions(verification), { evidence: verification.publishDryRunEvidence ?? {} }),
    check("release.verification", "Verification commands", verification.requiredCommands.length > 0 ? "pass" : "warn", `${verification.requiredCommands.length} verification command(s) declared.`, [], { requiredCommands: verification.requiredCommands, acceptanceEvidencePaths: verification.acceptanceEvidencePaths })
  ];
}

function publishDryRunActions(verification: ReleaseVerificationEvidence): readonly string[] {
  const evidence = verification.publishDryRunEvidence;
  if (!evidence?.exists) return [`Run ${verification.dryRunCommand} and save output to tests/acceptance/latest/npm-publish-dry-run.txt.`];
  if (evidence.collisionDetected) return ["Bump the CLI package version, update the lockfile, rebuild, and rerun npm publish --dry-run."];
  if (!evidence.versionMatches) return ["Refresh npm publish dry-run evidence after the package version changes."];
  if (evidence.npmErrorDetected) return ["Fix the npm publish dry-run error and refresh the evidence file."];
  return evidence.status === "pass" ? [] : ["Refresh npm publish dry-run evidence with a successful dry-run output."];
}

function indexProviderChecks(environment: LocalReadinessEnvironment): readonly ReadinessCheck[] {
  const summary = environment.indexProviderDiagnostics;
  if (!summary) {
    return [check("index-provider.summary", "Index provider diagnostics", "warn", "Index provider diagnostics were not provided by the host adapter.", ["Run doctor from a host that wires shared index provider diagnostics."], { available: false })];
  }
  return [
    check(
      "index-provider.summary",
      "Index provider diagnostics",
      summary.providers.some((provider) => provider.status === "enabled") ? "pass" : "warn",
      `${summary.providerCount} index provider(s) declared; enabled: ${summary.enabledProviderIds.join(", ") || "none"}.`,
      summary.enabledProviderIds.length > 0 ? [] : ["Enable PageIndex deterministic recall before relying on semantic providers."],
      indexProviderMetadata(summary)
    ),
    ...summary.providers.map((provider) => check(
      `index-provider.${provider.providerId}`,
      `Index provider ${provider.providerId}`,
      provider.status === "enabled" ? "pass" : provider.status === "degraded" || provider.status === "deferred" ? "warn" : "warn",
      `${provider.providerId} (${provider.kind}) is ${provider.status}; ranking=${provider.ranking.join(", ")}; scope=${provider.scope.join(", ")}.`,
      provider.diagnostics.flatMap((diagnostic) => {
        const suggestedActions = diagnostic.details?.suggestedActions;
        return Array.isArray(suggestedActions) ? suggestedActions.map(String) : [];
      }),
      {
        providerId: provider.providerId,
        kind: provider.kind,
        status: provider.status,
        requestedStatus: provider.requestedStatus ?? provider.status,
        implementationStatus: provider.implementationStatus,
        activationEvidence: provider.activationEvidence.map((evidence) => ({ kind: evidence.kind, status: evidence.status, sourceId: evidence.sourceId })),
        scope: provider.scope,
        ranking: provider.ranking,
        diagnosticCodes: provider.diagnostics.map((diagnostic) => diagnostic.code)
      }
    ))
  ];
}

function ignoredPathCheck(environment: LocalReadinessEnvironment): ReadinessCheck {
  const required = [".env", "参考/"];
  const missing = required.filter((path) => !environment.ignoredPaths.includes(path));
  return check(
    "install.ignored-paths",
    "Ignored local paths",
    missing.length > 0 ? "warn" : "pass",
    missing.length > 0 ? `Missing ignore entries: ${missing.join(", ")}.` : "Local secret and reference paths are ignored.",
    missing.length > 0 ? ["Update .gitignore before committing."] : [],
    { required, missing }
  );
}

function releaseMetadata(environment: LocalReadinessEnvironment): JsonObject {
  return {
    packageSurface: environment.releasePackageSurface ?? {},
    verification: environment.releaseVerification ?? {}
  };
}

function supportBundleMetadata(environment: LocalReadinessEnvironment): JsonObject {
  return environment.supportBundlePolicy ?? {
    schemaVersion: "1.0.0",
    localDiagnosticsAvailable: true,
    externalExportAllowed: false,
    externalExportReasonCode: "privacy.external-export-disabled",
    visibleReasoningPolicy: "redacted-summary-and-projection-fingerprint-only",
    visibleReasoningRawProviderReasoningAllowed: false,
    visibleReasoningExportFields: ["recordId", "stepKind", "status", "certainty", "summary", "evidenceLinkCount", "evidenceFingerprints", "projectionId", "replayFingerprint", "summary"],
    referencePitFixtureIds: ["pit.diagnostic-redaction.support-bundle"],
    redaction: { class: "internal", fields: ["externalExportReasonCode", "visibleReasoningExportFields"] }
  };
}

function indexProviderMetadata(summary: IndexProviderDiagnosticsSummary | undefined): JsonObject {
  if (!summary) return { available: false };
  return {
    schemaVersion: summary.schemaVersion,
    kind: summary.kind,
    defaultProviderId: summary.defaultProviderId,
    source: summary.source,
    providerCount: summary.providerCount,
    enabledProviderIds: summary.enabledProviderIds,
    deferredProviderIds: summary.deferredProviderIds,
    providers: summary.providers.map((provider) => ({
      providerId: provider.providerId,
      kind: provider.kind,
      status: provider.status,
      requestedStatus: provider.requestedStatus ?? provider.status,
      implementationStatus: provider.implementationStatus,
      activationEvidence: provider.activationEvidence.map((evidence) => ({ kind: evidence.kind, status: evidence.status, sourceId: evidence.sourceId })),
      scope: provider.scope,
      ranking: provider.ranking,
      diagnosticCodes: provider.diagnostics.map((diagnostic) => diagnostic.code)
    })),
    diagnostics: summary.diagnostics.map((diagnostic) => diagnostic.code),
    redaction: summary.redaction
  };
}

function selectedModelProvider(environment: LocalReadinessEnvironment): ReadinessModelProviderMetadata {
  return environment.modelProvider ?? {
    provider: "deepseek",
    protocol: "openai-chat-completions",
    model: typeof resolvedValue(environment, "model") === "string" ? String(resolvedValue(environment, "model")) : "deepseek-v4-flash",
    label: "DeepSeek"
  };
}

function credentialReference(environment: LocalReadinessEnvironment, provider: ReadinessModelProviderMetadata): ReadinessCredentialReference {
  const stored = environment.credentialReferences?.find((reference) => reference.available && reference.scope.provider === provider.provider);
  if (stored) {
    return { ref: stored.ref, provider: provider.provider, source: stored.source, available: true, redaction: { class: "secret" } };
  }
  if (provider.provider === "glm") {
    if (hasValue(environment.env.GLM_ANTHROPIC_API_KEY) || hasValue(environment.env.ZHIPU_API_KEY)) {
      return { ref: asId<"credentialRef">("credential-glm-anthropic-api-key"), provider: "glm", source: "process-env", available: true, redaction: { class: "secret" } };
    }
    if (hasValue(environment.envFile?.GLM_ANTHROPIC_API_KEY) || hasValue(environment.envFile?.ZHIPU_API_KEY)) {
      return { ref: asId<"credentialRef">("credential-glm-anthropic-api-key"), provider: "glm", source: "env-file", available: true, redaction: { class: "secret" } };
    }
    return { ref: asId<"credentialRef">("credential-glm-anthropic-api-key"), provider: "glm", source: "missing", available: false, redaction: { class: "secret" } };
  }
  if (hasValue(environment.env.DEEPSEEK_API_KEY) || hasValue(environment.env.DEEPSEEK_TOKEN)) {
    return { ref: asId<"credentialRef">("credential-deepseek-api-key"), provider: "deepseek", source: "process-env", available: true, redaction: { class: "secret" } };
  }
  if (hasValue(environment.envFile?.DEEPSEEK_API_KEY) || hasValue(environment.envFile?.DEEPSEEK_TOKEN)) {
    return { ref: asId<"credentialRef">("credential-deepseek-api-key"), provider: "deepseek", source: "env-file", available: true, redaction: { class: "secret" } };
  }
  return { ref: asId<"credentialRef">("credential-deepseek-api-key"), provider: "deepseek", source: "missing", available: false, redaction: { class: "secret" } };
}

function liveChecks(live: ModelLiveVerificationResult | undefined, requested: boolean, provider: ReadinessModelProviderMetadata): readonly ReadinessCheck[] {
  if (!requested) {
    return [check("doctor.live", "Live provider verification", "pass", "Live provider verification was not requested; doctor stayed offline.", [], { requested: false, provider: provider.provider, protocol: provider.protocol, model: provider.model })];
  }
  if (!live) {
    return [check("doctor.live", "Live provider verification", "warn", "Live provider verification was requested but no live verifier was configured.", ["Configure a model gateway live verifier."], { requested: true, provider: provider.provider, protocol: provider.protocol, model: provider.model })];
  }
  const liveLabel = live.provider.provider === "glm" ? "GLM" : live.provider.provider === "deepseek" ? "DeepSeek" : live.provider.provider;
  return [
    check(
      "doctor.live",
      "Live provider verification",
      live.ok ? "pass" : "warn",
      live.ok ? `${liveLabel} live verification completed for ${live.provider.model}.` : `${liveLabel} live verification did not complete: ${live.terminalStatus}.`,
      live.ok ? [] : live.diagnostics.flatMap((diagnostic) => (Array.isArray(diagnostic.details?.suggestedActions) ? diagnostic.details.suggestedActions.map(String) : [])),
      { requested: true, provider: live.provider.provider, protocol: live.provider.protocol, model: live.provider.model, terminalStatus: live.terminalStatus, eventKinds: live.eventKinds, reachable: live.reachable }
    )
  ];
}

function resolvedValue(environment: LocalReadinessEnvironment, key: string): JsonValue | undefined {
  return environment.resolvedConfig?.values.find((value) => value.key === key)?.redactedValue ?? environment.config?.[key];
}

function redactedResolvedConfig(config: ResolvedConfig | undefined): JsonObject {
  if (!config) return {};
  return {
    schemaVersion: config.schemaVersion,
    profile: config.profile,
    values: config.values.map((value) => ({ key: value.key, value: value.redactedValue, source: value.source.scope, shadowedSources: value.shadowedSources.map((source) => source.scope) })),
    diagnostics: config.diagnostics.map((diagnostic) => ({ code: diagnostic.code, severity: diagnostic.severity, keyPath: diagnostic.keyPath, message: diagnostic.message }))
  };
}

function check(id: string, label: string, status: ReadinessCheck["status"], message: string, suggestedActions: readonly string[] = [], metadata: JsonObject = {}): ReadinessCheck {
  return {
    id,
    label,
    status,
    message,
    metadata,
    suggestedActions,
    redaction: { class: "internal" }
  };
}

function commandId(command: ReadinessCommandName): CommandId {
  return asId<"command">(`readiness.${command}`);
}

function interactiveCommandId(command: InteractiveControlCommandName): CommandId {
  return asId<"command">(`interactive.${command}`);
}

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

const knownConfigKeys = new Set(["model", "profile", "telemetry", "privacy", "sandbox", "output"]);

export function isReadinessResult(value: JsonValue | undefined): value is ReadinessCommandResult {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "command" in value && "checks" in value;
}

export function isInteractiveControlCommandName(value: string | undefined): value is InteractiveControlCommandName {
  return typeof value === "string" && interactiveControlCommandNames.includes(value as InteractiveControlCommandName);
}

export function isInteractiveControlResult(value: JsonValue | undefined): value is InteractiveControlResult {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "action" in value && "command" in value && "terminal" in value;
}
