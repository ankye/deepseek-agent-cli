import type {
  CapabilityExecutionContext,
  CapabilityManifest,
  CapabilityRiskClass,
  CoreCodingToolName,
  CoreToolDiagnostic,
  CoreToolEvidence,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import {
  analyzeResourceScope,
  createSandboxAuditEvidence,
  createSandboxRequirement,
  createSecretRedactionDecision,
  redactJsonSecrets,
  redactSecretText
} from "@deepseek/policy-sandbox";
import { capabilityToolFamilyMetadata } from "../catalog/families.js";

export type ToolManifestName = CoreCodingToolName | (string & {});

export interface ToolDefinition<TResult extends JsonObject = CoreToolResult> {
  readonly toolName: ToolManifestName;
  readonly manifest: CapabilityManifest;
  readonly execute: (input: JsonObject, context: CapabilityExecutionContext) => Promise<SerializableResult<TResult>>;
}

export function defineToolManifest<TResult extends JsonObject = CoreToolResult>(
  toolName: ToolManifestName,
  id: CapabilityManifest["id"],
  name: string,
  sideEffect: CapabilityManifest["sideEffect"],
  permissions: readonly string[],
  inputSchema: JsonObject,
  outputSchema: JsonObject,
  execute: (input: JsonObject, context: CapabilityExecutionContext) => Promise<SerializableResult<TResult>>,
  options: { readonly timeoutMs?: number; readonly replayPolicy?: JsonObject } = {}
): ToolDefinition<TResult> {
  const resourceScope = analyzeResourceScope({}, sideEffect);
  const toolFamily = capabilityToolFamilyMetadata(id);
  const timeoutMs = options.timeoutMs ?? (sideEffect === "process" ? 30_000 : 10_000);
  const sandboxRequirements = createSandboxRequirement({
    sideEffect,
    resourceScope,
    timeoutMs,
    permissions
  });
  const riskClass = capabilityRiskClass(toolName, sideEffect, permissions);
  const policyHooks = capabilityPolicyHooks(riskClass);
  return {
    toolName,
    manifest: {
      id,
      name,
      description: `Built-in governed ${toolName} coding tool.`,
      source: "builtin",
      version: "1.0.0",
      trust: "trusted" as const,
      sideEffect,
      permissions,
      inputSchema,
      outputSchema,
      enabled: true,
      timeoutMs,
      replayPolicy: options.replayPolicy ?? { replayable: true, snapshot: "core-tool-evidence", deterministic: true },
      projection: {
        modelVisible: true,
        hostVisible: true,
        executorVisible: false,
        outputBounded: true,
        modelAliases: modelAliasesFor(toolName),
        connectorTrust: "trusted",
        providerSupport: toolFamily?.connectorProfile === "provider" ? "connector" : "not_applicable",
        policyTags: [
          "core-tool",
          `family:${toolFamily?.familyId ?? toolName}`,
          `domain:${toolFamily?.domainId ?? "unknown"}`,
          `risk:${riskClass}`
        ],
        agentScopeIds: ["default"]
      },
      ...(toolFamily ? { toolFamily } : {}),
      compatibility: {
        schemaVersion: "1.0.0",
        requiresPlatform: true
      },
      secretExposure: createSecretRedactionDecision("", { class: "public" }),
      resourceScope,
      sandboxRequirements,
      audit: createSandboxAuditEvidence({
        decision: "manifest",
        reasonCode: `manifest.${toolName}`,
        subject: "core-coding-tools",
        resource: String(id),
        sandboxProfile: sandboxRequirements.profile
      }),
      security: {
        modelVisible: true,
        hostVisible: true,
        executorVisible: false,
        outputRedaction: "secret-aware"
      },
      risk: {
        riskClass,
        mutatesWorkspace: sideEffect === "write",
        policyHooks
      }
    },
    execute
  };
}

function modelAliasesFor(toolName: ToolManifestName): readonly string[] {
  switch (toolName) {
    case "file.read":
      return ["Read", "cat"];
    case "file.write":
      return ["Write"];
    case "file.edit":
      return ["Edit"];
    case "text.replace":
      return ["Sed", "sed", "Replace"];
    case "file.copy":
      return ["Copy", "cp"];
    case "file.move":
      return ["Move", "mv"];
    case "file.delete":
      return ["Delete", "rm"];
    case "directory.create":
      return ["Mkdir", "mkdir"];
    case "file.touch":
      return ["Touch", "touch"];
    case "file.stat":
      return ["Stat", "stat"];
    case "json.read":
      return ["JsonRead"];
    case "json.patch":
      return ["JsonPatch"];
    case "checksum.hash":
      return ["Hash"];
    case "path.resolve":
      return ["PathResolve"];
    case "env.inspect":
      return ["Env", "env", "printenv"];
    case "command.lookup":
      return ["Which", "which", "where"];
    case "archive.create":
      return ["ArchiveCreate", "tar"];
    case "archive.extract":
      return ["ArchiveExtract", "unzip"];
    case "session.resume":
      return ["SessionResume"];
    case "session.fork":
      return ["SessionFork"];
    case "memory.write":
      return ["MemoryWrite"];
    case "memory.read":
      return ["MemoryRead"];
    case "compact.summary":
      return ["CompactSummary"];
    case "asset.view-local":
      return ["ViewImage"];
    case "file.list":
      return ["List", "ls"];
    case "workspace.glob":
      return ["Glob", "glob"];
    case "search.text":
      return ["Grep", "grep", "rg"];
    case "code.diagnostics":
      return ["Diagnostics"];
    case "notebook.read":
      return ["NotebookRead"];
    case "notebook.edit":
      return ["NotebookEdit"];
    case "patch.apply":
      return ["ApplyPatch"];
    case "revert.undo":
      return ["Revert"];
    case "shell.run":
      return ["Bash", "bash", "sh", "PowerShell", "powershell", "pwsh"];
    case "shell.output":
      return ["ShellOutput"];
    case "shell.kill":
      return ["Kill"];
    case "repl.execute":
      return ["Repl"];
    case "git.status":
      return ["GitStatus"];
    case "git.diff":
      return ["GitDiff"];
    case "git.history-branch":
      return ["GitHistory"];
    case "test.run":
      return ["Test"];
    case "package.manager":
      return ["Npm", "npm", "yarn", "pnpm", "PackageManager"];
    case "todo.plan":
      return ["TodoWrite"];
    case "user.input":
      return ["AskUserQuestion"];
    case "mode.plan.enter":
      return ["EnterPlanMode"];
    case "mode.plan.exit":
      return ["ExitPlanMode"];
    case "config.manage":
      return ["Config"];
    case "web.fetch":
      return ["WebFetch"];
    case "web.search":
      return ["WebSearch"];
    case "mcp.tool.call":
      return ["MCP"];
    case "mcp.resource.list":
      return ["ListMcpResources"];
    case "mcp.resource.read":
      return ["ReadMcpResource"];
    case "agent.spawn":
      return ["Agent"];
    case "agent.continue":
      return ["AgentContinue"];
    case "agent.stop":
      return ["AgentStop"];
    case "task.create":
      return ["TaskCreate"];
    case "task.get":
      return ["TaskGet"];
    case "task.list":
      return ["TaskList"];
    case "task.update":
      return ["TaskUpdate"];
    case "task.output":
      return ["TaskOutput"];
    case "team.create":
      return ["TeamCreate"];
    case "team.delete":
      return ["TeamDelete"];
    case "worktree.enter":
      return ["EnterWorktree"];
    case "worktree.exit":
      return ["ExitWorktree"];
    case "tool.search":
      return ["ToolSearch"];
    case "schedule.cron":
      return ["Schedule"];
    case "remote.trigger":
      return ["RemoteTrigger"];
    case "brief.package":
      return ["Brief"];
    case "synthetic.output":
      return ["SyntheticOutput"];
    case "hook.list":
      return ["HookList"];
    case "hook.run":
      return ["HookRun"];
    case "plugin.install":
      return ["PluginInstall"];
    case "plugin.verify":
      return ["PluginVerify"];
    case "command.palette":
      return ["CommandPalette"];
    case "skill.list":
      return ["SkillList"];
    case "skill.activate":
      return ["Skill"];
    default:
      return [];
  }
}

function capabilityRiskClass(
  toolName: ToolManifestName,
  sideEffect: CapabilityManifest["sideEffect"],
  permissions: readonly string[]
): CapabilityRiskClass {
  if (permissions.includes("process:test") || toolName === "test.run") return "test-process";
  if (permissions.includes("process:run") || sideEffect === "process") return "process-run";
  if (sideEffect === "write") return "workspace-write";
  if (sideEffect === "network") return "network";
  if (sideEffect === "read") return "read-only";
  return "none";
}

function capabilityPolicyHooks(riskClass: CapabilityRiskClass): readonly string[] {
  if (riskClass === "workspace-write") return ["policy.preflight", "sandbox.scope", "workspace.checkpoint"];
  if (riskClass === "process-run" || riskClass === "test-process") return ["policy.preflight", "sandbox.scope", "process.output-limit"];
  if (riskClass === "network") return ["policy.preflight", "sandbox.scope", "network.redaction"];
  if (riskClass === "read-only") return ["policy.preflight", "sandbox.scope"];
  return ["policy.preflight"];
}

export function success(tool: CoreCodingToolName, affectedPaths: readonly string[], options: {
  readonly preview?: ReturnType<typeof boundedText>;
  readonly provider?: CoreToolEvidence["provider"];
  readonly metadata?: JsonObject;
  readonly replay?: JsonObject;
  readonly status?: CoreToolEvidence["status"];
}): SerializableResult<CoreToolResult> {
  return {
    ok: true,
    value: {
      evidence: {
        tool,
        status: options.status ?? "completed",
        affectedPaths: affectedPaths.map(redactSecretText),
        ...(options.preview ? { preview: options.preview } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        diagnostics: [],
        metadata: redactJsonSecrets(options.metadata ?? {}) as JsonObject,
        replay: options.replay ?? {},
        redaction: { class: "internal", fields: ["preview.text", "affectedPaths"] }
      }
    }
  };
}

export function failure(tool: CoreCodingToolName, code: string, message: string, affectedPaths: readonly string[], metadata: JsonObject = {}): SerializableResult<CoreToolResult> {
  const suppliedDiagnostic = isDiagnostic(metadata.diagnostic) ? metadata.diagnostic : undefined;
  const diagnostic = suppliedDiagnostic ?? diag(code, redactSecretText(message), suggestedActionsForFailure(code));
  return {
    ok: false,
    error: diagnostic,
    value: {
      evidence: {
        tool,
        status: "rejected",
        affectedPaths: affectedPaths.map(redactSecretText),
        diagnostics: [diagnostic],
        metadata: redactJsonSecrets(metadata) as JsonObject,
        replay: {},
        redaction: { class: "internal", fields: ["affectedPaths"] }
      }
    }
  };
}

export function boundedText(text: string, limitBytes = 8_000) {
  const safeText = redactSecretText(text);
  const truncated = Buffer.byteLength(safeText, "utf8") > limitBytes;
  const limited = truncated ? truncateUtf8Text(safeText, limitBytes) : safeText;
  return {
    text: limited,
    byteLength: Buffer.byteLength(safeText, "utf8"),
    lineCount: safeText.length === 0 ? 0 : safeText.split(/\r?\n/).length,
    truncated,
    limitBytes,
    redaction: { class: "internal" as const }
  };
}

function truncateUtf8Text(text: string, limitBytes: number): string {
  const limit = Number.isFinite(limitBytes) ? Math.max(0, Math.floor(limitBytes)) : 0;
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const chunks: string[] = [];
  let bytes = 0;
  for (const character of text) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > limit) break;
    chunks.push(character);
    bytes += nextBytes;
  }
  return chunks.join("");
}

export function diag(code: string, message: string, suggestedActions: readonly string[] = []): CoreToolDiagnostic {
  return {
    code,
    message,
    retryable: false,
    ...(suggestedActions.length > 0 ? { suggestedActions } : {}),
    redaction: { class: "internal" }
  };
}

function suggestedActionsForFailure(code: string): readonly string[] {
  if (code.endsWith("_UNAVAILABLE")) {
    return ["Register or enable the required runtime dependency, then retry the tool call."];
  }
  if (code === "PATH_REJECTED" || code.endsWith("_PATH_REJECTED") || code.endsWith("_TARGET_REJECTED")) {
    return ["Use a workspace-relative path inside the configured workspace root, then retry."];
  }
  if (code.endsWith("_INPUT_INVALID") || code.endsWith("_REQUIRED") || code.endsWith("_EMPTY")) {
    return ["Provide the required input fields in the tool schema, then retry."];
  }
  if (code.endsWith("_UNSUPPORTED")) {
    return ["Use a supported option or route the request through the matching semantic tool."];
  }
  if (code.endsWith("_NOT_FOUND")) {
    return ["List or inspect the available resources, choose an existing id or path, then retry."];
  }
  if (code.endsWith("_FAILED")) {
    return ["Inspect the bounded evidence and retry after correcting the reported failure cause."];
  }
  return ["Inspect the rejection diagnostic, correct the request, then retry."];
}

export function undefinedError(error: unknown, code: string): CoreToolDiagnostic {
  return diag(code, error instanceof Error ? error.message : "Operation failed.");
}

export function isDiagnostic(value: unknown): value is CoreToolDiagnostic {
  return typeof value === "object" && value !== null && "code" in value && "message" in value;
}

export function replay(context: CapabilityExecutionContext): JsonObject {
  const envelopeId = context.envelope?.invocationId ?? `trace:${context.trace.traceId}`;
  return {
    envelopeId,
    traceId: context.trace.traceId,
    snapshot: "core-tool-evidence"
  };
}

export function objectSchema(required: readonly string[], properties: JsonObject): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties
  };
}

export function evidenceSchema(): JsonObject {
  return objectSchema(["evidence"], { evidence: { type: "object" } });
}
