import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCapabilityRegistry } from "@deepseek/capability-registry";
import { DeterministicScheduler } from "@deepseek/concurrency-orchestration";
import { FakePlatformRuntime, NodePlatformRuntime } from "@deepseek/platform-abstraction";
import { InMemoryWorkspaceStateManager, InMemoryWorktreeEnvironment } from "@deepseek/workspace-state-management";
import { asId, TOOL_FAMILY_DOMAIN_IDS, TOOL_FAMILY_IDS } from "@deepseek/platform-contracts";
import type {
  CapabilityExecutionContext,
  CodeIntelligenceService,
  CodeIntelligenceContextRequest,
  CodeIntelligenceContextResult,
  CodeIntelligenceIndexResult,
  CodeIntelligenceProviderMetadata,
  CommandManifest,
  CommandSystem,
  CoreToolResult,
  Diagnostic,
  ExecutionEnvelope,
  HookInvocationRequest,
  HookLifecyclePoint,
  HookSummary,
  HookSystem,
  AgentSpawner,
  AgentSpawnRequest,
  AgentSpawnResult,
  AgentStopRequest,
  AgentStopResult,
  ConcurrencyOrchestrator,
  ConfigStore,
  JsonValue,
  JsonObject,
  MemoryEntry,
  MemoryManager,
  MemoryScope,
  McpGateway,
  McpListRequest,
  McpOperationStatus,
  McpResourceReadRequest,
  McpResourceReadResult,
  McpResourceSummary,
  McpServerManifest,
  McpServerSummary,
  McpToolCallRequest,
  McpToolCallResult,
  McpToolSummary,
  PlatformProviderResultMetadata,
  PluginContributionActivationRequest,
  PluginContributionActivationResult,
  PluginInstallResult,
  PluginLockfile,
  PluginManifest,
  PluginManager,
  ProcessResult,
  ProcessRunObserver,
  ProcessRunOptions,
  RemoteBinding,
  RemoteRuntimeConnectivity,
  SerializableResult,
  SessionEvent,
  SessionId,
  SessionStore,
  SkillActivationRequest,
  SkillActivationResult,
  SkillContextProjectionRequest,
  SkillContextProjectionResult,
  SkillManifest,
  SkillSummary,
  SkillSystem,
  SkillValidationResult,
  ShellProfile,
  ShellProviderDescriptor,
  TraceContext
} from "@deepseek/platform-contracts";
import { analyzeResourceScope, createSandboxAuditEvidence, createSandboxRequirement, createSecretRedactionDecision } from "@deepseek/policy-sandbox";
import {
  buildToolFamilyParityMatrix,
  coreCapabilityFamilyMappings,
  coreToolIds,
  coreToolManifests,
  buildReferenceToolArsenalReadiness,
  buildReferenceToolArsenalReport,
  isStandardTestCommand,
  referenceToolArsenalMatrix,
  registerCoreCodingTools,
  toolFamilyCatalog,
  validateToolFamilyCatalog
} from "./index.js";

const workspaceRoot = "/workspace";

class ShellCapableFakePlatform extends FakePlatformRuntime {
  readonly executedCommands: { readonly command: string; readonly args: readonly string[]; readonly cwd?: string }[] = [];
  readonly commandTimeouts: number[] = [];
  readonly resolvedShellProfiles: ShellProfile[] = [];
  nextProcessResult: ProcessResult | undefined;

  override async resolveShell(profile: ShellProfile = "bash"): Promise<SerializableResult<ShellProviderDescriptor>> {
    this.resolvedShellProfiles.push(profile);
    return super.resolveShell(profile);
  }

  override async runProcess(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions = {},
    observer?: ProcessRunObserver
  ): Promise<ProcessResult> {
    this.commandTimeouts.push(options.timeoutMs ?? 0);
    this.executedCommands.push({ command, args: [...args], ...(options.cwd ? { cwd: options.cwd } : {}) });
    if (this.nextProcessResult) {
      const result = this.nextProcessResult;
      this.nextProcessResult = undefined;
      return result;
    }
    return super.runProcess(command, args, options, observer);
  }
}

async function invoke(
  id: (typeof coreToolIds)[keyof typeof coreToolIds],
  input: JsonObject,
  options: {
    readonly platform?: FakePlatformRuntime;
    readonly workspaceState?: InMemoryWorkspaceStateManager;
    readonly sessions?: SessionStore;
    readonly memory?: MemoryManager;
    readonly agentSpawner?: AgentSpawner;
    readonly worktrees?: InMemoryWorktreeEnvironment;
    readonly scheduler?: ConcurrencyOrchestrator;
    readonly userInput?: CoreUserInputHost;
    readonly config?: ConfigStore;
    readonly codeIntelligence?: CodeIntelligenceService;
    readonly mcp?: McpGateway;
    readonly remote?: RemoteRuntimeConnectivity;
    readonly hooks?: HookSystem;
    readonly plugins?: PluginManager;
    readonly commands?: CommandSystem;
    readonly skills?: SkillSystem;
  } = {}
): Promise<SerializableResult<CoreToolResult>> {
  const platform = options.platform ?? new FakePlatformRuntime("fake", workspaceRoot);
  const workspaceState = options.workspaceState ?? new InMemoryWorkspaceStateManager();
  const registry = new InMemoryCapabilityRegistry();
  await registerCoreCodingTools(registry, {
    platform,
    workspaceState,
    workspaceRoot,
    ...(options.sessions ? { sessions: options.sessions } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.agentSpawner ? { agentSpawner: options.agentSpawner } : {}),
    ...(options.worktrees ? { worktrees: options.worktrees } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    ...(options.userInput ? { userInput: options.userInput } : {}),
    ...(options.config ? { config: options.config } : {}),
    ...(options.codeIntelligence ? { codeIntelligence: options.codeIntelligence } : {}),
    ...(options.mcp ? { mcp: options.mcp } : {}),
    ...(options.remote ? { remote: options.remote } : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.plugins ? { plugins: options.plugins } : {}),
    ...(options.commands ? { commands: options.commands } : {}),
    ...(options.skills ? { skills: options.skills } : {})
  });
  const binding = await registry.resolveExecutable(id);
  assert.ok(binding);
  return binding.execute(input, context(id)) as Promise<SerializableResult<CoreToolResult>>;
}

interface CoreUserInputRequest extends JsonObject {
  readonly prompt: string;
  readonly inputType: "text" | "confirm" | "choice";
  readonly choices: readonly string[];
  readonly required: boolean;
}

interface CoreUserInputHost {
  requestInput(request: CoreUserInputRequest): Promise<{
    readonly status: "answered" | "cancelled" | "timeout";
    readonly value?: string | boolean;
    readonly source: "interactive-host" | "scripted" | "test";
    readonly reason?: string;
  }>;
}

class MemoryConfigStore implements ConfigStore {
  readonly values = new Map<string, JsonValue>();

  async get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async set(key: string, value: JsonValue): Promise<void> {
    this.values.set(key, value);
  }

  async profile() {
    return {
      name: "unit",
      values: Object.fromEntries(this.values)
    };
  }
}

class RecordingCommandSystem implements CommandSystem {
  constructor(private readonly manifests: readonly CommandManifest[]) {}

  async register(): Promise<void> {}

  async invoke(): Promise<SerializableResult> {
    return { ok: false, error: { code: "COMMAND_EXECUTION_NOT_USED", message: "Command execution is not used by this test fake.", retryable: false, redaction: { class: "internal" } } };
  }

  async help(): Promise<readonly CommandManifest[]> {
    return this.manifests;
  }
}

class RecordingSkillSystem implements SkillSystem {
  readonly activationRequests: SkillActivationRequest[] = [];

  constructor(private readonly summaries: readonly SkillSummary[]) {}

  async validateManifest(manifest: SkillManifest): Promise<SkillValidationResult> {
    return {
      schemaVersion: "1.0.0",
      ok: Boolean(manifest.name),
      diagnostics: [],
      normalized: manifest,
      redaction: { class: "internal" }
    };
  }

  async registerSkill(manifest: SkillManifest): Promise<SkillSummary> {
    return skillSummary(String(manifest.id), manifest.name, manifest.version);
  }

  async listSummaries(): Promise<readonly SkillSummary[]> {
    return this.summaries;
  }

  async loadSkill(name: string): Promise<SkillActivationResult> {
    return this.activationResult(name, "activated");
  }

  async activateSkill(request: SkillActivationRequest): Promise<SkillActivationResult> {
    this.activationRequests.push(request);
    const known = this.summaries.some((summary) => summary.name === request.name);
    return this.activationResult(request.name, known ? "activated" : "not-found");
  }

  async projectContext(request: SkillContextProjectionRequest): Promise<SkillContextProjectionResult> {
    const summary = this.summaries.find((entry) => entry.name === request.name);
    return {
      schemaVersion: "1.0.0",
      status: summary ? "projected" : "not-found",
      ...(summary ? { summary } : {}),
      nodes: [],
      diagnostics: [],
      redaction: { class: "internal" },
      compatibility: { schemaVersion: "1.0.0" },
      replayFingerprint: `skill-project:${request.name}:${summary ? "projected" : "not-found"}`
    };
  }

  private activationResult(name: string, status: SkillActivationResult["status"]): SkillActivationResult {
    return {
      schemaVersion: "1.0.0",
      status,
      contentLoaded: status === "activated",
      loadingState: status === "activated" ? "loaded" : "inert",
      contextSegments: status === "activated"
        ? [{
          schemaVersion: "1.0.0",
          skillId: asId<"skill">(`skill:${name}`),
          segmentId: `${name}:instructions`,
          kind: "instruction",
          content: `Use ${name}`,
          priority: 1,
          estimatedTokens: 3,
          provenance: { source: "test" },
          dependencyFingerprints: [],
          compatibility: { schemaVersion: "1.0.0" },
          redaction: { class: "internal" }
        }]
        : [],
      diagnostics: [],
      redaction: { class: "internal" },
      compatibility: { schemaVersion: "1.0.0" },
      replayFingerprint: `skill:${name}:${status}`
    };
  }
}

function skillSummary(id: string, name: string, version = "1.0.0"): SkillSummary {
  return {
    schemaVersion: "1.0.0",
    id: asId<"skill">(id),
    name,
    version,
    source: "test",
    trust: "trusted",
    enabled: true,
    description: `${name} skill`,
    activation: [name],
    executionModes: ["context"],
    permissions: [],
    loadingState: "summary-only",
    compatibility: { schemaVersion: "1.0.0" },
    redaction: { class: "internal" }
  };
}

function commandManifest(id: string, name: string, aliases: readonly string[], sideEffect: string, modelVisible: boolean): CommandManifest {
  return {
    id: asId<"command">(id),
    name,
    aliases,
    modes: ["user", "host"],
    hostSupport: ["cli"],
    sideEffect,
    inputSchema: {},
    ownerSubsystem: "command-system",
    source: { kind: "built-in", id },
    permissions: ["command:read"],
    projection: { modelVisible, userVisible: true, hostVisible: true, group: "test" },
    target: { kind: "command", id },
    redaction: { class: "internal" },
    referencePitFixtureIds: [],
    compositionKind: "command",
    compositionSideEffect: sideEffect === "read" ? "read" : sideEffect === "runtime-control" ? "runtime-control" : "none",
    description: `${name} command`
  };
}

function hookSummary(id: string, name: string, point: HookLifecyclePoint): HookSummary {
  return {
    schemaVersion: "1.0.0",
    id: asId<"hook">(id),
    name,
    version: "1.0.0",
    point,
    source: "test",
    trust: "trusted",
    enabled: true,
    ordering: { priority: 5 },
    timeoutMs: 100,
    failurePolicy: "continue",
    isolation: "in-process-observe-only",
    permissions: [],
    compatibility: { schemaVersion: "1.0.0" },
    redaction: { class: "internal" }
  };
}

class RecordingHookSystem implements HookSystem {
  readonly invocations: HookInvocationRequest[] = [];
  readonly listRequests: (HookLifecyclePoint | undefined)[] = [];

  constructor(private readonly summaries: readonly HookSummary[] = []) {}

  async validateManifest() {
    return {
      schemaVersion: "1.0.0",
      ok: true,
      diagnostics: [],
      redaction: { class: "internal" as const }
    };
  }

  async registerHook() {
    return {
      schemaVersion: "1.0.0",
      id: asId<"hook">("hook-recording"),
      name: "recording",
      version: "1.0.0",
      point: "user-input.before" as const,
      source: "test",
      trust: "trusted" as const,
      enabled: true,
      ordering: { priority: 1 },
      timeoutMs: 100,
      failurePolicy: "continue" as const,
      isolation: "in-process-observe-only" as const,
      permissions: [] as readonly string[],
      compatibility: { schemaVersion: "1.0.0" },
      redaction: { class: "internal" as const }
    };
  }

  async listHooks(point?: HookLifecyclePoint) {
    this.listRequests.push(point);
    return point ? this.summaries.filter((summary) => summary.point === point) : this.summaries;
  }

  async projectOrder() {
    return {
      schemaVersion: "1.0.0",
      point: "user-input.before",
      ordered: [],
      diagnostics: [],
      redaction: { class: "internal" as const },
      compatibility: { schemaVersion: "1.0.0" },
      replayFingerprint: "hook-order:test"
    };
  }

  async invokeHooks(request: HookInvocationRequest) {
    this.invocations.push(request);
    return {
      schemaVersion: "1.0.0",
      point: request.point,
      status: "completed" as const,
      orderedHookIds: [asId<"hook">("hook-recording")],
      executions: [{
        schemaVersion: "1.0.0",
        hookId: asId<"hook">("hook-recording"),
        name: "recording",
        point: request.point,
        status: "completed" as const,
        startedAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString(),
        durationMs: 0,
        outputs: [],
        diagnostics: [],
        failurePolicy: "continue" as const,
        redaction: { class: "internal" as const },
        replayFingerprint: "hook-execution:test"
      }],
      diagnostics: [],
      redaction: { class: "internal" as const },
      compatibility: { schemaVersion: "1.0.0" },
      replayFingerprint: "hook-invocation:test"
    };
  }
}

class RecordingPluginManager implements PluginManager {
  readonly installed: PluginManifest[] = [];
  readonly verified: PluginManifest[] = [];
  readonly entries = new Map<string, PluginInstallResult["lockEntry"]>();
  nextVerifyOk = true;

  async install(manifest: PluginManifest): Promise<PluginInstallResult> {
    this.installed.push(manifest);
    const lockEntry = {
      pluginId: manifest.id,
      version: manifest.version,
      source: manifest.source,
      integrity: manifest.integrity,
      permissions: manifest.permissions,
      installedAt: "1970-01-01T00:00:00.000Z"
    };
    this.entries.set(manifest.id, lockEntry);
    return {
      diff: { added: manifest.permissions, removed: [] },
      lockEntry
    };
  }

  async uninstall(id: PluginManifest["id"]): Promise<void> {
    this.entries.delete(id);
  }

  async list(): Promise<readonly PluginManifest[]> {
    return [];
  }

  async verify(manifest: PluginManifest) {
    this.verified.push(manifest);
    if (this.nextVerifyOk && manifest.integrity.startsWith("sha256:")) return { ok: true as const };
    return {
      ok: false as const,
      reason: "mismatch" as const,
      expected: "sha256:*",
      actual: manifest.integrity
    };
  }

  async snapshot(): Promise<PluginLockfile> {
    return { version: 1, entries: [...this.entries.values()] };
  }

  async applyLockfile(lockfile: PluginLockfile): Promise<ReadonlyArray<PluginInstallResult>> {
    const results: PluginInstallResult[] = [];
    for (const entry of lockfile.entries) {
      results.push(await this.install({
        id: entry.pluginId,
        name: entry.pluginId,
        version: entry.version,
        source: entry.source,
        integrity: entry.integrity,
        permissions: entry.permissions,
        contributions: {}
      }));
    }
    return results;
  }

  async authorizeContributionActivation(request: PluginContributionActivationRequest): Promise<PluginContributionActivationResult> {
    return {
      pluginId: request.pluginId,
      contributionId: request.contributionId,
      contributionKind: request.contributionKind,
      ownerSubsystem: request.ownerSubsystem,
      status: "not-required",
      authorizations: [],
      diagnostics: [],
      referencePitFixtureIds: [],
      audit: {},
      redaction: { class: "internal" },
      replayFingerprint: "plugin-activation:test"
    };
  }
}

class RecordingCodeIntelligence implements CodeIntelligenceService {
  readonly diagnosticRoots: string[] = [];

  constructor(private readonly diagnosticItems: readonly Diagnostic[]) {}

  async status(root = workspaceRoot): Promise<CodeIntelligenceProviderMetadata> {
    return {
      schemaVersion: "1.0.0",
      provider: "lsp",
      status: "available",
      indexedFileCount: 1,
      truncated: false,
      diagnostics: [],
      redaction: { class: "internal" },
      compatibility: { schemaVersion: "1.0.0" }
    };
  }

  async index(_root: string): Promise<SerializableResult<CodeIntelligenceIndexResult>> {
    return {
      ok: false,
      error: {
        code: "TEST_INDEX_UNAVAILABLE",
        message: "index is not used by this test fake.",
        retryable: false,
        redaction: { class: "internal" }
      }
    };
  }

  async diagnostics(root: string): Promise<readonly Diagnostic[]> {
    this.diagnosticRoots.push(root);
    return this.diagnosticItems;
  }

  async symbols() {
    return [];
  }

  async definitions() {
    return [];
  }

  async references() {
    return [];
  }

  async contextNodes(_request: CodeIntelligenceContextRequest): Promise<SerializableResult<CodeIntelligenceContextResult>> {
    return {
      ok: false,
      error: {
        code: "TEST_CONTEXT_NODES_UNAVAILABLE",
        message: "context nodes are not used by this test fake.",
        retryable: false,
        redaction: { class: "internal" }
      }
    };
  }

  async invalidate(): Promise<void> {}
}

class RecordingMcpGateway implements McpGateway {
  readonly toolCalls: McpToolCallRequest[] = [];
  readonly resourceReads: McpResourceReadRequest[] = [];
  readonly listRequests: McpListRequest[] = [];

  async validateManifest(_manifest: McpServerManifest) {
    return { schemaVersion: "1.0.0", ok: true, diagnostics: [], redaction: { class: "internal" as const } };
  }

  async connectServer(manifest: McpServerManifest): Promise<McpServerSummary> {
    return {
      schemaVersion: "1.0.0",
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      namespace: manifest.namespace,
      source: String(manifest.source),
      trust: manifest.trust,
      transport: manifest.transport,
      permissions: manifest.permissions,
      timeoutMs: manifest.timeoutMs,
      enabled: true,
      health: "connected",
      toolCount: manifest.tools?.length ?? 0,
      resourceCount: manifest.resources?.length ?? 0,
      promptCount: manifest.prompts?.length ?? 0,
      compatibility: { schemaVersion: "1.0.0" },
      redaction: { class: "internal" }
    };
  }

  async listServers(): Promise<readonly McpServerSummary[]> {
    return [];
  }

  async listTools(_request: McpListRequest): Promise<readonly McpToolSummary[]> {
    return [];
  }

  async listResources(request: McpListRequest): Promise<readonly McpResourceSummary[]> {
    this.listRequests.push(request);
    return [{
      schemaVersion: "1.0.0",
      serverId: asId<"mcpServer">("mcp-demo"),
      namespace: "demo",
      uri: "file://README.md",
      name: "README",
      description: "Project readme",
      mimeType: "text/markdown",
      transport: { kind: "fake" },
      trust: "trusted",
      permissions: ["mcp:read"],
      cachePolicy: "session",
      redaction: { class: "internal" },
      provenance: {},
      compatibility: { schemaVersion: "1.0.0" }
    }];
  }

  async listPrompts(_request: McpListRequest) {
    return [];
  }

  async callTool(request: McpToolCallRequest): Promise<McpToolCallResult> {
    this.toolCalls.push(request);
    return mcpToolResult(request, "completed", { text: "pong" });
  }

  async readResource(request: McpResourceReadRequest): Promise<McpResourceReadResult> {
    this.resourceReads.push(request);
    return {
      schemaVersion: "1.0.0",
      status: "completed",
      serverId: request.serverId,
      namespace: "demo",
      uri: request.uri,
      caller: request.caller,
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString(),
      durationMs: 0,
      content: "# README",
      mimeType: "text/markdown",
      cachePolicy: "session",
      diagnostics: [],
      trust: "trusted",
      transport: { kind: "fake" },
      permissions: ["mcp:read"],
      timeoutMs: request.timeoutMs ?? 1_000,
      redaction: { class: "internal" },
      provenance: {},
      audit: {},
      compatibility: { schemaVersion: "1.0.0" },
      replayFingerprint: "mcp-resource-read:test"
    };
  }
}

class RecordingRemoteRuntime implements RemoteRuntimeConnectivity {
  readonly bindings = new Map<string, RemoteBinding>();
  readonly cancellations: { readonly id: string; readonly reason: string }[] = [];

  async bind(binding: RemoteBinding): Promise<void> {
    this.bindings.set(binding.id, binding);
  }

  async reconnect(id: string): Promise<RemoteBinding | undefined> {
    return this.bindings.get(id);
  }

  async cancelRemote(id: string, reason: string): Promise<void> {
    this.cancellations.push({ id, reason });
  }
}

function mcpToolResult(request: McpToolCallRequest, status: McpOperationStatus, output?: JsonObject): McpToolCallResult {
  return {
    schemaVersion: "1.0.0",
    status,
    serverId: request.serverId,
    namespace: "demo",
    name: request.name,
    qualifiedName: `demo.${request.name}`,
    caller: request.caller,
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(),
    durationMs: 0,
    ...(output ? { output } : {}),
    diagnostics: [],
    trust: "trusted",
    transport: { kind: "fake" },
    permissions: ["mcp:call"],
    timeoutMs: request.timeoutMs ?? 1_000,
    redaction: { class: "internal" },
    audit: {},
    compatibility: { schemaVersion: "1.0.0" },
    replayFingerprint: "mcp-tool-call:test"
  };
}

class RecordingAgentSpawner implements AgentSpawner {
  readonly spawned: AgentSpawnRequest[] = [];
  readonly stopped: AgentStopRequest[] = [];

  async spawn(input: AgentSpawnRequest): Promise<AgentSpawnResult> {
    this.spawned.push(input);
    const index = this.spawned.length;
    return {
      childSessionId: asId<"session">(`session-worker-${index}`),
      workerAgentId: asId<"agent">(`agent-worker-${index}`),
      workerInstanceId: asId<"agentInstance">(`agent-instance-${index}`),
      workOrderId: input.workOrderId ?? `work-order-${index}`,
      agentMode: input.agentMode ?? "worker",
      terminalStatus: "completed",
      assistantText: `worker ${index} completed`,
      iterations: 1,
      toolCalls: 0,
      usage: {},
      resultProvenance: {},
      diagnostics: []
    };
  }

  async stop(input: AgentStopRequest): Promise<AgentStopResult> {
    this.stopped.push(input);
    return {
      workerInstanceId: input.workerInstanceId,
      workerSessionId: asId<"session">(`session-${input.workerInstanceId}`),
      workerAgentId: asId<"agent">("agent-stopped"),
      ...(input.workOrderId ? { workOrderId: input.workOrderId } : {}),
      lifecycleState: "stopped",
      status: "stopped",
      stopReason: input.stopReason ?? "manual-stop",
      usage: {},
      resultProvenance: {},
      workerResult: {
        schemaVersion: "1.0.0",
        resultId: `result-${input.workerInstanceId}`,
        workerSessionId: asId<"session">(`session-${input.workerInstanceId}`),
        workerAgentId: asId<"agent">("agent-stopped"),
        workerInstanceId: input.workerInstanceId,
        status: "stopped",
        summary: "Worker stopped.",
        evidenceIds: [],
        changedScope: [],
        usage: {},
        diagnostics: [],
        compatibility: { schemaVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      diagnostics: []
    };
  }
}

class MemorySessionStore implements SessionStore {
  readonly bySession = new Map<string, SessionEvent[]>();
  private next = 1;

  async create(): Promise<SessionId> {
    const sessionId = asId<"session">(`session-core-tool-${this.next++}`);
    this.bySession.set(String(sessionId), []);
    return sessionId;
  }

  async append(event: SessionEvent): Promise<void> {
    const events = this.bySession.get(String(event.sessionId)) ?? [];
    events.push({ ...event, sequence: events.length + 1 });
    this.bySession.set(String(event.sessionId), events);
  }

  async events(sessionId: SessionId): Promise<readonly SessionEvent[]> {
    return this.bySession.get(String(sessionId)) ?? [];
  }

  async snapshot(sessionId: SessionId, payload: JsonObject) {
    return { schemaVersion: "1.0.0", sessionId, eventCount: (await this.events(sessionId)).length, payload, redaction: { class: "internal" as const } };
  }

  async metadata(sessionId: SessionId) {
    return {
      ok: true,
      value: {
        schemaVersion: "1.0.0",
        sessionId,
        createdAt: new Date(0).toISOString(),
        eventCount: (await this.events(sessionId)).length,
        latestSequence: (await this.events(sessionId)).length,
        metadata: {},
        lineage: {},
        redaction: { class: "internal" as const }
      }
    };
  }

  async resume(sessionId: SessionId) {
    const metadata = (await this.metadata(sessionId)).value;
    return {
      ok: true,
      value: {
        schemaVersion: "1.0.0",
        sessionId,
        eventCount: metadata.eventCount,
        latestSequence: metadata.latestSequence,
        metadata,
        lineage: {},
        preview: {},
        redaction: { class: "internal" as const }
      }
    };
  }

  async fork(request: import("@deepseek/platform-contracts").SessionForkRequest) {
    const parentEvents = await this.events(request.parentSessionId);
    const forkPointSequence = request.forkPointSequence ?? parentEvents.length;
    const inheritedEventCount = parentEvents.filter((event) => event.sequence <= forkPointSequence).length;
    const childSessionId = asId<"session">(`session-core-tool-${this.next++}`);
    const forkEvent: SessionEvent = {
      sessionId: childSessionId,
      sequence: 1,
      kind: "session.forked",
      at: new Date(0).toISOString(),
      payload: { parentSessionId: request.parentSessionId, forkPointSequence, inheritedEventCount, reason: request.reason ?? "" },
      redaction: { class: "internal" }
    };
    this.bySession.set(String(childSessionId), [forkEvent]);
    const metadata = (await this.metadata(childSessionId)).value;
    return {
      ok: true,
      value: {
        schemaVersion: "1.0.0",
        parentSessionId: request.parentSessionId,
        childSessionId,
        forkPointSequence,
        inheritedEventCount,
        metadata,
        lineage: { parentSessionId: request.parentSessionId, forkPointSequence, inheritedEventCount, ...(request.reason ? { reason: request.reason } : {}) },
        forkEvent,
        redaction: { class: "internal" as const }
      }
    };
  }
}

class MemoryToolStore implements MemoryManager {
  private readonly globalEntries = new Map<MemoryScope, MemoryEntry[]>();
  private readonly sessionEntries = new Map<string, Map<MemoryScope, MemoryEntry[]>>();

  async put(entry: MemoryEntry, sessionId?: SessionId): Promise<void> {
    if (sessionId) {
      const scoped = this.sessionEntries.get(String(sessionId)) ?? new Map<MemoryScope, MemoryEntry[]>();
      scoped.set(entry.scope, [...(scoped.get(entry.scope) ?? []), entry]);
      this.sessionEntries.set(String(sessionId), scoped);
      return;
    }
    this.globalEntries.set(entry.scope, [...(this.globalEntries.get(entry.scope) ?? []), entry]);
  }

  async query(scope: MemoryScope, sessionId?: SessionId): Promise<readonly MemoryEntry[]> {
    if (sessionId) return this.sessionEntries.get(String(sessionId))?.get(scope) ?? [];
    return this.globalEntries.get(scope) ?? [];
  }
}

function context(capabilityId: (typeof coreToolIds)[keyof typeof coreToolIds]): CapabilityExecutionContext {
  const trace: TraceContext = {
    traceId: asId<"trace">("trace-core-tool"),
    spanId: asId<"span">("span-core-tool"),
    correlationId: asId<"correlation">("corr-core-tool"),
    sessionId: asId<"session">("session-core-tool")
  };
  return {
    envelope: {
      invocationId: "invocation-core-tool",
      capabilityId,
      capabilityVersion: "1.0.0",
      kind: "capability",
      caller: "unit",
      sessionId: asId<"session">("session-core-tool"),
      inputSchema: {},
      outputSchema: {},
      redactionClass: "internal",
      provenance: {},
      trust: "trusted",
      permissions: [],
      sideEffect: "read",
      policyContext: {},
      approvalRequired: false,
      resourceLocks: [],
      timeoutMs: 30_000,
      cancellation: {},
      retryPolicy: {},
      idempotency: {},
      trace,
      telemetry: {},
      replayPolicy: {},
      ...securityFields(capabilityId),
      createdAt: new Date(0).toISOString()
    } satisfies ExecutionEnvelope,
    trace,
    signal: new AbortController().signal,
    metadata: {}
  };
}

function securityFields(capabilityId: (typeof coreToolIds)[keyof typeof coreToolIds]) {
  const resourceScope = analyzeResourceScope({}, "read");
  const sandboxRequirements = createSandboxRequirement({ sideEffect: "read", resourceScope, timeoutMs: 30_000, permissions: [] });
  return {
    secretExposure: createSecretRedactionDecision("", { class: "public" }),
    resourceScope,
    sandboxRequirements,
    audit: createSandboxAuditEvidence({
      decision: "test",
      reasonCode: "test.core-tool-context",
      subject: "unit",
      resource: String(capabilityId),
      sandboxProfile: sandboxRequirements.profile
    })
  };
}

function fakeProviderMetadata(): PlatformProviderResultMetadata {
  return {
    selectedProvider: "none",
    status: "available",
    fallbackChain: ["none"],
    degradedReasons: [],
    diagnostics: [],
    redaction: { class: "public" }
  };
}

describe("core coding tool executors", () => {
  it("defines the first tool-family catalog without placeholder tools", () => {
    assert.deepEqual(validateToolFamilyCatalog(), []);
    assert.equal(toolFamilyCatalog.domains.length, TOOL_FAMILY_DOMAIN_IDS.length);
    assert.equal(toolFamilyCatalog.families.length, TOOL_FAMILY_IDS.length);
    assert.deepEqual(toolFamilyCatalog.domains.map((domain) => domain.domainId), TOOL_FAMILY_DOMAIN_IDS);
    assert.deepEqual(toolFamilyCatalog.families.map((family) => family.familyId), TOOL_FAMILY_IDS);
    assert.equal(new Set(toolFamilyCatalog.families.map((family) => family.familyId)).size, TOOL_FAMILY_IDS.length);
    for (const family of toolFamilyCatalog.families) {
      if (family.implementationState === "implemented") {
        assert.equal(family.tools.length > 0, true, `${family.familyId} should have concrete tool implementations`);
      } else {
        assert.equal(family.tools.length, 0, `${family.familyId} should not use placeholder tools`);
      }
      assert.equal(family.tools.some((tool) => tool.toolId.startsWith("catalog.")), false);
    }
  });

  it("attaches family metadata to every implemented core tool manifest", () => {
    const manifests = coreToolManifests();
    const mappedCapabilities = new Set(coreCapabilityFamilyMappings().map((item) => item.capabilityId));
    assert.equal(manifests.length, Object.values(coreToolIds).length);

    for (const manifest of manifests) {
      assert.ok(manifest.toolFamily, `${manifest.id} should include tool family metadata`);
      assert.equal(manifest.toolFamily.catalogVersion, toolFamilyCatalog.catalogVersion);
      assert.equal(mappedCapabilities.has(manifest.id), true);
    }
  });

  it("declares cross-platform model aliases for common reference-style tool names and command habits", () => {
    const manifests = coreToolManifests();
    const aliasesByCapability = new Map(manifests.map((manifest) => [
      manifest.id,
      ((manifest.projection?.modelAliases ?? []) as readonly string[])
    ]));

    assert.deepEqual(aliasesByCapability.get(coreToolIds.fileRead), ["Read", "cat"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.fileList), ["List", "ls"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.searchText), ["Grep", "grep", "rg"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.textReplace), ["Sed", "sed", "Replace"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.workspaceGlob), ["Glob", "glob"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.fileEdit), ["Edit"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.fileWrite), ["Write"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.fileCopy), ["Copy", "cp"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.fileMove), ["Move", "mv"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.fileDelete), ["Delete", "rm"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.directoryCreate), ["Mkdir", "mkdir"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.fileTouch), ["Touch", "touch"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.fileStat), ["Stat", "stat"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.jsonRead), ["JsonRead"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.jsonPatch), ["JsonPatch"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.checksumHash), ["Hash"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.pathResolve), ["PathResolve"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.envInspect), ["Env", "env", "printenv"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.commandLookup), ["Which", "which", "where"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.archiveCreate), ["ArchiveCreate", "tar"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.archiveExtract), ["ArchiveExtract", "unzip"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.sessionResume), ["SessionResume"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.sessionFork), ["SessionFork"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.memoryWrite), ["MemoryWrite"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.memoryRead), ["MemoryRead"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.compactSummary), ["CompactSummary"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.assetViewLocal), ["ViewImage"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.codeDiagnostics), ["Diagnostics"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.notebookRead), ["NotebookRead"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.notebookEdit), ["NotebookEdit"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.patchApply), ["ApplyPatch"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.revertUndo), ["Revert"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.shellRun), ["Bash", "bash", "sh", "PowerShell", "powershell", "pwsh"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.shellOutput), ["ShellOutput"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.shellKill), ["Kill"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.replExecute), ["Repl"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.gitStatus), ["GitStatus"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.gitDiff), ["GitDiff"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.gitHistoryBranch), ["GitHistory"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.testRun), ["Test"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.packageManager), ["Npm", "npm", "yarn", "pnpm", "PackageManager"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.todoPlan), ["TodoWrite"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.userInput), ["AskUserQuestion"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.modePlanEnter), ["EnterPlanMode"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.modePlanExit), ["ExitPlanMode"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.configManage), ["Config"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.webFetch), ["WebFetch"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.webSearch), ["WebSearch"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.mcpToolCall), ["MCP"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.mcpResourceList), ["ListMcpResources"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.mcpResourceRead), ["ReadMcpResource"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.agentSpawn), ["Agent"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.agentContinue), ["AgentContinue"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.agentStop), ["AgentStop"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.taskCreate), ["TaskCreate"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.taskGet), ["TaskGet"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.taskList), ["TaskList"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.taskUpdate), ["TaskUpdate"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.taskOutput), ["TaskOutput"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.teamCreate), ["TeamCreate"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.teamDelete), ["TeamDelete"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.worktreeEnter), ["EnterWorktree"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.worktreeExit), ["ExitWorktree"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.toolSearch), ["ToolSearch"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.scheduleCron), ["Schedule"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.remoteTrigger), ["RemoteTrigger"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.briefPackage), ["Brief"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.syntheticOutput), ["SyntheticOutput"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.hookList), ["HookList"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.hookRun), ["HookRun"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.pluginInstall), ["PluginInstall"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.pluginVerify), ["PluginVerify"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.commandPalette), ["CommandPalette"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.skillList), ["SkillList"]);
    assert.deepEqual(aliasesByCapability.get(coreToolIds.skillActivate), ["Skill"]);
  });

  it("declares risk classes and policy hooks for Tier 1 mutating and process tools", () => {
    const manifests = coreToolManifests();
    const required = new Map([
      [coreToolIds.fileWrite, { riskClass: "workspace-write", hooks: ["policy.preflight", "sandbox.scope", "workspace.checkpoint"] }],
      [coreToolIds.fileEdit, { riskClass: "workspace-write", hooks: ["policy.preflight", "sandbox.scope", "workspace.checkpoint"] }],
      [coreToolIds.textReplace, { riskClass: "workspace-write", hooks: ["policy.preflight", "sandbox.scope", "workspace.checkpoint"] }],
      [coreToolIds.patchApply, { riskClass: "workspace-write", hooks: ["policy.preflight", "sandbox.scope", "workspace.checkpoint"] }],
      [coreToolIds.shellRun, { riskClass: "process-run", hooks: ["policy.preflight", "sandbox.scope", "process.output-limit"] }],
      [coreToolIds.testRun, { riskClass: "test-process", hooks: ["policy.preflight", "sandbox.scope", "process.output-limit"] }]
    ]);

    for (const [id, expectation] of required) {
      const manifest = manifests.find((candidate) => candidate.id === id);
      const risk = manifest?.risk as { riskClass?: string; mutatesWorkspace?: boolean; policyHooks?: readonly string[] } | undefined;
      assert.ok(manifest, `${id} should be registered`);
      assert.equal(risk?.riskClass, expectation.riskClass);
      assert.equal(risk?.mutatesWorkspace, id !== coreToolIds.shellRun && id !== coreToolIds.testRun);
      for (const hook of expectation.hooks) assert.equal(risk?.policyHooks?.includes(hook), true, `${id} should include ${hook}`);
      const policyTags = (manifest?.projection?.policyTags ?? []) as readonly string[];
      assert.equal(policyTags.includes(`risk:${expectation.riskClass}`), true);
    }
  });

  it("declares REPL governance fields used by process sandbox preflight", () => {
    const manifest = coreToolManifests().find((candidate) => candidate.id === coreToolIds.replExecute);

    assert.ok(manifest);
    assert.equal(((manifest.inputSchema.properties as JsonObject).cwd as JsonObject | undefined)?.type, "string");
    assert.equal(((manifest.inputSchema.properties as JsonObject).workspaceRoot as JsonObject | undefined)?.type, "string");
  });

  it("scores planned or unassessed families as zero instead of giving catalog credit", () => {
    const matrix = buildToolFamilyParityMatrix();
    const implemented = toolFamilyCatalog.families.filter((family) => family.implementationState === "implemented").length;

    assert.equal(matrix.totalFamilyCount, TOOL_FAMILY_IDS.length);
    assert.equal(matrix.implementedFamilyCount, implemented);
    assert.equal(matrix.plannedFamilyCount, TOOL_FAMILY_IDS.length - implemented);
    assert.equal(matrix.liveCoveredFamilyCount, 0);
    assert.equal(matrix.taskCoveredFamilyCount, 0);
    assert.equal(matrix.passedFamilyCount, 0);
    assert.equal(matrix.objectiveScore, 0);
    assert.equal(matrix.deliveryCapabilityScore, 0);
    assert.equal(matrix.deliveryCapabilityTargetScore, 0.9);
    assert.equal(matrix.deliveryCapabilityTargetFamilyCount, Math.ceil(matrix.totalFamilyCount * matrix.deliveryCapabilityTargetScore));
    assert.equal(matrix.deliveryCapabilityPassed, false);

    const patch = matrix.scorecards.find((scorecard) => scorecard.familyId === "patch.apply");
    assert.equal(patch?.implementationState, "implemented");
    assert.equal(patch?.toolCount, 1);
    assert.equal(patch?.objectiveScore, 0.4);

    const withEvidence = buildToolFamilyParityMatrix({
      liveCoveredFamilyIds: ["file.read"],
      taskCoveredFamilyIds: ["file.read"],
      safetyCoveredFamilyIds: ["file.read"]
    });
    assert.equal(withEvidence.passedFamilyCount, 1);
    assert.equal(withEvidence.objectiveScore, Math.round((1 / withEvidence.totalFamilyCount) * 1000) / 1000);
    assert.equal(withEvidence.deliveryCapabilityPassedFamilyCount, 1);
    assert.equal(withEvidence.deliveryCapabilityScore, Math.round((1 / withEvidence.totalFamilyCount) * 1000) / 1000);
    assert.equal(withEvidence.scorecards.find((scorecard) => scorecard.familyId === "file.read")?.objectiveScore, 1);

    const fakeEvidence = buildToolFamilyParityMatrix({
      fakeCoveredFamilyIds: ["file.read"],
      taskCoveredFamilyIds: ["file.read"],
      safetyCoveredFamilyIds: ["file.read"]
    });
    assert.equal(fakeEvidence.passedFamilyCount, 1);
    assert.equal(fakeEvidence.objectiveScore, Math.round((1 / fakeEvidence.totalFamilyCount) * 1000) / 1000);
    assert.equal(fakeEvidence.deliveryCapabilityPassedFamilyCount, 0);
    assert.equal(fakeEvidence.deliveryCapabilityScore, 0);
    assert.equal(fakeEvidence.deliveryCapabilityBlockingFamilyIds.includes("file.read"), true);

    const replayEvidence = buildToolFamilyParityMatrix({
      replayedCoveredFamilyIds: ["file.read"],
      taskCoveredFamilyIds: ["file.read"],
      safetyCoveredFamilyIds: ["file.read"]
    });
    assert.equal(replayEvidence.passedFamilyCount, 1);
    assert.equal(replayEvidence.deliveryCapabilityPassedFamilyCount, 0);
    assert.equal(replayEvidence.deliveryCapabilityScore, 0);

    const providerBlocked = buildToolFamilyParityMatrix({
      liveCoveredFamilyIds: ["web.search"],
      taskCoveredFamilyIds: ["web.search"],
      safetyCoveredFamilyIds: ["web.search"]
    });
    assert.equal(providerBlocked.passedFamilyCount, 0);
    assert.equal(providerBlocked.deliveryCapabilityScore, 0);

    const providerNative = buildToolFamilyParityMatrix({
      liveCoveredFamilyIds: ["web.search"],
      taskCoveredFamilyIds: ["web.search"],
      safetyCoveredFamilyIds: ["web.search"],
      providerNativeSupportedFamilyIds: ["web.search"]
    });
    assert.equal(providerNative.passedFamilyCount, 1);
    assert.equal(providerNative.deliveryCapabilityPassedFamilyCount, 1);
  });

  it("maps reference-class tools to DeepSeek families with actionable completion states", () => {
    const referenceToolNames = new Set(referenceToolArsenalMatrix.map((entry) => entry.referenceTool));
    const requiredReferenceTools = [
      "AgentTool",
      "AskUserQuestionTool",
      "BashTool",
      "PowerShellTool",
      "FileReadTool",
      "FileWriteTool",
      "FileEditTool",
      "SedTool",
      "GlobTool",
      "GrepTool",
      "LSPTool",
      "NotebookEditTool",
      "MCPTool",
      "McpAuthTool",
      "McpPromptTool",
      "ListMcpResourcesTool",
      "ReadMcpResourceTool",
      "WebFetchTool",
      "WebSearchTool",
      "WebExtractTool",
      "WebDataLookupTool",
      "BrowserNavigateTool",
      "BrowserInteractTool",
      "BrowserInspectTool",
      "BrowserScreenshotTool",
      "ImageGenerateTool",
      "ImageEditTool",
      "ImageSearchStockTool",
      "ImageInspectTool",
      "DesignDocumentStateTool",
      "DesignNodeQueryTool",
      "DesignBatchEditTool",
      "DesignExportSnapshotTool",
      "TodoWriteTool",
      "TaskCreateTool",
      "TaskGetTool",
      "TaskListTool",
      "TaskUpdateTool",
      "TaskOutputTool",
      "TaskStopTool",
      "TeamCreateTool",
      "TeamDeleteTool",
      "SkillTool",
      "ToolSearchTool",
      "ConfigTool",
      "EnterPlanModeTool",
      "ExitPlanModeTool",
      "EnterWorktreeTool",
      "ExitWorktreeTool",
      "ScheduleCronTool",
      "RemoteTriggerTool",
      "BriefTool",
      "SyntheticOutputTool"
    ];

    for (const tool of requiredReferenceTools) {
      assert.equal(referenceToolNames.has(tool), true, `${tool} should be mapped into the DeepSeek arsenal`);
    }

    const report = buildReferenceToolArsenalReport();
    assert.equal(report.totalReferenceToolCount, referenceToolArsenalMatrix.length);
    assert.equal(report.unmappedReferenceToolCount, 0);
    assert.equal(report.entries.every((entry) => entry.deepSeekFamilyId.length > 0), true);
    assert.equal(report.entries.every((entry) => ["executable", "adapter-unavailable-with-diagnostics", "not-yet-implemented"].includes(entry.completionState)), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "FileReadTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "SedTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "PowerShellTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "LSPTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "MCPTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "McpPromptTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "ListMcpResourcesTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "ReadMcpResourceTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "McpAuthTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "BrowserScreenshotTool" && entry.deepSeekFamilyId === "browser.screenshot" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "ImageGenerateTool" && entry.deepSeekFamilyId === "image.generate" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "DesignBatchEditTool" && entry.deepSeekFamilyId === "design.batch-edit" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "RemoteTriggerTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "TaskOutputTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "TeamCreateTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "EnterWorktreeTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "NotebookEditTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "ToolSearchTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "ScheduleCronTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "BriefTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "SyntheticOutputTool" && entry.completionState === "executable"), true);
    assert.equal(report.notYetImplementedReferenceToolCount, 0);
    assert.equal(report.adapterUnavailableReferenceToolCount, 0);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "AskUserQuestionTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "ConfigTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "EnterPlanModeTool" && entry.completionState === "executable"), true);
    assert.equal(report.entries.some((entry) => entry.referenceTool === "ExitPlanModeTool" && entry.completionState === "executable"), true);
  });

  it("separates built-in core tools from external adapter tools in the reference arsenal report", () => {
    const report = buildReferenceToolArsenalReport();

    assert.equal(report.builtinExecutableReferenceToolCount > 0, true);
    assert.equal(report.externalAdapterExecutableReferenceToolCount > 0, true);
    assert.equal(
      report.builtinExecutableReferenceToolCount + report.externalAdapterExecutableReferenceToolCount,
      report.executableReferenceToolCount
    );

    const fileRead = report.entries.find((entry) => entry.referenceTool === "FileReadTool");
    assert.equal(fileRead?.executionBoundary, "builtin-core");
    assert.equal(fileRead?.coreExecutableCapabilityIds.includes("core.file.read"), true);
    assert.equal(fileRead?.externalAdapterCapabilityIds.length, 0);

    const browserScreenshot = report.entries.find((entry) => entry.referenceTool === "BrowserScreenshotTool");
    assert.equal(browserScreenshot?.executionBoundary, "external-adapter");
    assert.equal(browserScreenshot?.coreExecutableCapabilityIds.length, 0);
    assert.equal(browserScreenshot?.externalAdapterCapabilityIds.includes("mcp-gateway.browser-screenshot"), true);
  });

  it("fails tool arsenal readiness when a profile requires non-executable families", () => {
    const engineering = buildReferenceToolArsenalReadiness({
      profileId: "software-engineer",
      requiredFamilyIds: [
        "file.read",
        "search.text",
        "file.edit",
        "shell.run",
        "git.status-diff",
        "build.test-lint-typecheck",
        "plan.todo"
      ]
    });
    assert.equal(engineering.ready, true);
    assert.deepEqual(engineering.blockingFamilyIds, []);

    const taskHeavy = buildReferenceToolArsenalReadiness({
      profileId: "software-engineer-with-task-board",
      requiredFamilyIds: ["agent.wait-result"]
    });
    assert.equal(taskHeavy.ready, true);
    assert.deepEqual(taskHeavy.blockingFamilyIds, []);

    const teamHeavy = buildReferenceToolArsenalReadiness({
      profileId: "software-engineer-with-teams",
      requiredFamilyIds: ["worktree.environment"]
    });
    assert.equal(teamHeavy.ready, true);
    assert.deepEqual(teamHeavy.blockingFamilyIds, []);
  });

  it("does not mark external adapter-only families ready unless the adapter capability is available", () => {
    const browserOnly = buildReferenceToolArsenalReadiness({
      profileId: "browser-agent",
      requiredFamilyIds: ["browser.screenshot"]
    });

    assert.equal(browserOnly.ready, false);
    assert.deepEqual(browserOnly.blockingFamilyIds, ["browser.screenshot"]);
    assert.equal(browserOnly.blockers[0]?.reason, "adapter-unavailable-with-diagnostics");
    assert.equal(browserOnly.blockers[0]?.referenceTools.includes("BrowserScreenshotTool"), true);

    const configuredBrowser = buildReferenceToolArsenalReadiness({
      profileId: "browser-agent",
      requiredFamilyIds: ["browser.screenshot"],
      availableCapabilityIds: ["mcp-gateway.browser-screenshot"]
    });

    assert.equal(configuredBrowser.ready, true);
    assert.deepEqual(configuredBrowser.blockingFamilyIds, []);
  });

  it("requests user input through a host adapter and fails closed when headless", async () => {
    const headless = await invoke(coreToolIds.userInput, {
      prompt: "Which branch should be used?",
      inputType: "choice",
      choices: ["main", "feature"]
    });
    assert.equal(headless.ok, false);
    assert.equal(headless.error?.code, "USER_INPUT_HEADLESS_UNAVAILABLE");
    assert.equal(headless.value?.evidence.tool, "user.input");

    const requests: CoreUserInputRequest[] = [];
    const answered = await invoke(coreToolIds.userInput, {
      prompt: "Continue?",
      inputType: "confirm",
      required: true
    }, {
      userInput: {
        async requestInput(request) {
          requests.push(request);
          return { status: "answered", value: true, source: "test" };
        }
      }
    });
    assert.equal(answered.ok, true);
    assert.deepEqual(requests.map((request) => request.inputType), ["confirm"]);
    assert.equal(answered.value?.evidence.metadata.status, "answered");
    assert.equal(answered.value?.evidence.metadata.value, true);
  });

  it("records plan mode enter and exit as session-scoped control evidence", async () => {
    const sessions = new MemorySessionStore();
    const enter = await invoke(coreToolIds.modePlanEnter, {
      reason: "inspect architecture before editing"
    }, { sessions });
    assert.equal(enter.ok, true);
    assert.equal(enter.value?.evidence.tool, "mode.plan.enter");
    assert.equal(enter.value?.evidence.metadata.mode, "plan");

    const exit = await invoke(coreToolIds.modePlanExit, {
      reason: "implementation plan accepted"
    }, { sessions });
    assert.equal(exit.ok, true);
    assert.equal(exit.value?.evidence.tool, "mode.plan.exit");
    assert.equal(exit.value?.evidence.metadata.mode, "auto");

    const events = await sessions.events(asId<"session">("session-core-tool"));
    assert.deepEqual(events.map((event) => event.kind), ["mode.plan.enter", "mode.plan.exit"]);
  });

  it("resumes and forks sessions through injected session store evidence", async () => {
    const sessions = new MemorySessionStore();
    const parentSessionId = await sessions.create();
    await sessions.append({
      sessionId: parentSessionId,
      sequence: 1,
      kind: "user.message",
      at: new Date(0).toISOString(),
      payload: { text: "continue the work" },
      redaction: { class: "internal" }
    });

    const resumed = await invoke(coreToolIds.sessionResume, { sessionId: parentSessionId }, { sessions });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.value?.evidence.tool, "session.resume");
    assert.equal(resumed.value?.evidence.metadata.familyId, "session.resume-fork");
    assert.equal(resumed.value?.evidence.metadata.action, "resume");
    assert.equal(resumed.value?.evidence.metadata.latestSequence, 1);

    const forked = await invoke(coreToolIds.sessionFork, {
      parentSessionId,
      reason: "try alternate implementation"
    }, { sessions });
    assert.equal(forked.ok, true);
    assert.equal(forked.value?.evidence.tool, "session.fork");
    assert.equal(forked.value?.evidence.metadata.action, "fork");
    assert.equal(typeof forked.value?.evidence.metadata.childSessionId, "string");

    const missing = await invoke(coreToolIds.sessionResume, { sessionId: "session-missing" });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, "SESSION_STORE_UNAVAILABLE");
  });

  it("reads and writes scoped memory through injected memory manager evidence", async () => {
    const memory = new MemoryToolStore();
    const sessionId = asId<"session">("session-memory-core-tool");
    const otherSessionId = asId<"session">("session-memory-other");

    const written = await invoke(coreToolIds.memoryWrite, {
      scope: "session",
      sessionId,
      content: "remember token=sk-core-memory-secret",
      provenance: { source: "unit" }
    }, { memory });
    assert.equal(written.ok, true);
    assert.equal(written.value?.evidence.tool, "memory.write");
    assert.equal(written.value?.evidence.metadata.familyId, "memory.read-write");
    assert.equal(written.value?.evidence.metadata.action, "write");

    await invoke(coreToolIds.memoryWrite, {
      scope: "session",
      sessionId: otherSessionId,
      content: "other session memory"
    }, { memory });

    const read = await invoke(coreToolIds.memoryRead, {
      scope: "session",
      sessionId,
      limit: 10
    }, { memory });
    assert.equal(read.ok, true);
    assert.equal(read.value?.evidence.tool, "memory.read");
    assert.equal(read.value?.evidence.metadata.recordCount, 1);
    assert.equal((read.value?.evidence.preview?.text ?? "").includes("sk-core-memory-secret"), false);

    const missing = await invoke(coreToolIds.memoryRead, { scope: "session", sessionId });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, "MEMORY_MANAGER_UNAVAILABLE");
  });

  it("creates compact summaries with bounded redacted evidence", async () => {
    const compact = await invoke(coreToolIds.compactSummary, {
      sessionId: "session-compact-core-tool",
      segments: [
        "keep this project decision",
        "DEEPSEEK_API_KEY=sk-core-compact-secret should redact",
        "this segment is over budget"
      ],
      maxTokens: 12,
      reservedOutputTokens: 2
    });

    assert.equal(compact.ok, true);
    assert.equal(compact.value?.evidence.tool, "compact.summary");
    assert.equal(compact.value?.evidence.metadata.familyId, "compact.summary");
    assert.equal(compact.value?.evidence.metadata.status, "degraded");
    assert.equal((compact.value?.evidence.preview?.text ?? "").includes("sk-core-compact-secret"), false);
    assert.equal((compact.value?.evidence.metadata.diagnostics as readonly string[] | undefined)?.includes("compact.summary.budget-excluded-segments"), true);

    const invalid = await invoke(coreToolIds.compactSummary, {
      sessionId: "session-compact-core-tool",
      segments: "not-array",
      maxTokens: 10
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error?.code, "COMPACT_SEGMENTS_INVALID");
  });

  it("replaces text across a workspace file through a governed cross-platform sed alternative", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    await platform.writeFile(`${workspaceRoot}/src/app.ts`, "const oldName = 'old';\nconsole.log(oldName);\n");

    const dryRun = await invoke(coreToolIds.textReplace, {
      path: "src/app.ts",
      pattern: "oldName",
      replacement: "newName",
      workspaceRoot,
      dryRun: true
    }, { platform });

    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.value?.evidence.tool, "text.replace");
    assert.equal(dryRun.value?.evidence.metadata.matchCount, 2);
    assert.equal(dryRun.value?.evidence.metadata.changed, false);
    assert.equal(await platform.readFile(`${workspaceRoot}/src/app.ts`), "const oldName = 'old';\nconsole.log(oldName);\n");

    const applied = await invoke(coreToolIds.textReplace, {
      path: "src/app.ts",
      pattern: "oldName",
      replacement: "newName",
      workspaceRoot
    }, { platform });

    assert.equal(applied.ok, true);
    assert.equal(applied.value?.evidence.metadata.matchCount, 2);
    assert.equal(applied.value?.evidence.metadata.changed, true);
    assert.equal(typeof applied.value?.evidence.metadata.checkpoint, "object");
    assert.equal(await platform.readFile(`${workspaceRoot}/src/app.ts`), "const newName = 'old';\nconsole.log(newName);\n");
  });

  it("inspects and updates runtime config through the injected config store", async () => {
    const config = new MemoryConfigStore();
    await config.set("model", "deepseek-chat");

    const inspect = await invoke(coreToolIds.configManage, { action: "inspect" }, { config });
    assert.equal(inspect.ok, true);
    assert.equal(inspect.value?.evidence.tool, "config.manage");
    const profile = inspect.value?.evidence.metadata.profile as { readonly name?: string; readonly values?: JsonObject } | undefined;
    assert.equal(profile?.name, "unit");
    assert.equal(profile?.values?.model, "deepseek-chat");

    const update = await invoke(coreToolIds.configManage, {
      action: "set",
      key: "profile",
      value: "software-engineer"
    }, { config });
    assert.equal(update.ok, true);
    assert.equal(await config.get("profile"), "software-engineer");
    assert.equal(update.value?.evidence.metadata.action, "set");
  });

  it("projects command palette and slash commands through the injected command system", async () => {
    const missing = await invoke(asId<"capability">("core.command.palette") as never, { query: "palette" });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, "COMMAND_SYSTEM_UNAVAILABLE");

    const commands = new RecordingCommandSystem([
      commandManifest("command:palette", "palette", ["palette", "/palette"], "inspect", true),
      commandManifest("command:exit", "exit", ["exit", "quit"], "runtime-control", false),
      commandManifest("command:repo-grep", "repo grep", ["repo grep", "/repo grep"], "read", true)
    ]);

    const projected = await invoke(asId<"capability">("core.command.palette") as never, {
      query: "repo",
      limit: 10
    }, { commands });

    assert.equal(projected.ok, true);
    assert.equal(projected.value?.evidence.tool, "command.palette");
    assert.equal(projected.value?.evidence.metadata.count, 1);
    assert.equal(projected.value?.evidence.metadata.truncated, false);
    const slashCommands = projected.value?.evidence.metadata.slashCommands as readonly { readonly title?: string; readonly aliases?: readonly string[] }[] | undefined;
    assert.equal(slashCommands?.[0]?.title, "/repo grep");
    assert.equal(slashCommands?.[0]?.aliases?.includes("/repo grep"), true);
  });

  it("lists and activates skills through the injected skill system", async () => {
    const missing = await invoke(asId<"capability">("core.skill.list") as never, {});
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, "SKILL_SYSTEM_UNAVAILABLE");

    const skills = new RecordingSkillSystem([skillSummary("skill:engineering", "software-engineer")]);
    const listed = await invoke(asId<"capability">("core.skill.list") as never, {}, { skills });

    assert.equal(listed.ok, true);
    assert.equal(listed.value?.evidence.tool, "skill.list");
    assert.equal(listed.value?.evidence.metadata.count, 1);

    const activated = await invoke(asId<"capability">("core.skill.activate") as never, {
      name: "software-engineer",
      context: { stage: "change" }
    }, { skills });

    assert.equal(activated.ok, true);
    assert.equal(activated.value?.evidence.tool, "skill.activate");
    assert.equal(activated.value?.evidence.metadata.status, "activated");
    assert.equal(activated.value?.evidence.metadata.segmentCount, 1);
    assert.equal(skills.activationRequests.length, 1);
    assert.equal(skills.activationRequests[0]?.trigger, "explicit");
    assert.deepEqual(skills.activationRequests[0]?.context, { stage: "change" });

    const notFound = await invoke(asId<"capability">("core.skill.activate") as never, {
      name: "missing-skill"
    }, { skills });
    assert.equal(notFound.ok, false);
    assert.equal(notFound.error?.code, "SKILL_NOT_FOUND");
  });

  it("lists hooks through the injected hook system with lifecycle point filtering", async () => {
    const missing = await invoke(asId<"capability">("core.hook.list") as never, {
      point: "tool-execution.before"
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, "HOOK_SYSTEM_UNAVAILABLE");

    const hooks = new RecordingHookSystem([
      hookSummary("hook:tool-before", "tool guard", "tool-execution.before"),
      hookSummary("hook:model-after", "model recorder", "model-call.after")
    ]);
    const listed = await invoke(asId<"capability">("core.hook.list") as never, {
      point: "tool-execution.before",
      limit: 10
    }, { hooks });

    assert.equal(listed.ok, true);
    assert.equal(listed.value?.evidence.tool, "hook.list");
    assert.equal(listed.value?.evidence.metadata.count, 1);
    const projected = listed.value?.evidence.metadata.hooks as readonly { readonly name?: string; readonly point?: string }[] | undefined;
    assert.equal(projected?.[0]?.name, "tool guard");
    assert.equal(projected?.[0]?.point, "tool-execution.before");
    assert.deepEqual(hooks.listRequests, ["tool-execution.before"]);
  });

  it("runs governed hooks through the injected hook system and fails closed without it", async () => {
    const missing = await invoke(asId<"capability">("core.hook.run") as never, {
      point: "user-input.before",
      input: { prompt: "hello" }
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, "HOOK_SYSTEM_UNAVAILABLE");

    const hooks = new RecordingHookSystem();
    const result = await invoke(asId<"capability">("core.hook.run") as never, {
      point: "user-input.before",
      input: { prompt: "hello" },
      timeoutMs: 250
    }, { hooks });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.tool, "hook.run");
    assert.equal(result.value?.evidence.metadata.status, "completed");
    assert.equal(result.value?.evidence.metadata.executionCount, 1);
    assert.equal(hooks.invocations[0]?.point, "user-input.before");
    assert.deepEqual(hooks.invocations[0]?.input, { prompt: "hello" });
    assert.equal(hooks.invocations[0]?.timeoutMs, 250);
  });

  it("verifies and installs plugins through an injected plugin manager", async () => {
    const manifest = {
      id: "plugin-demo",
      name: "Plugin Demo",
      version: "1.0.0",
      source: "workspace",
      integrity: "sha256:demo",
      permissions: ["skill:read"],
      contributions: {}
    };

    const missing = await invoke(asId<"capability">("core.plugin.verify") as never, { manifest });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, "PLUGIN_MANAGER_UNAVAILABLE");

    const plugins = new RecordingPluginManager();
    const verified = await invoke(asId<"capability">("core.plugin.verify") as never, { manifest }, { plugins });
    assert.equal(verified.ok, true);
    assert.equal(verified.value?.evidence.tool, "plugin.verify");
    assert.equal(verified.value?.evidence.metadata.verificationOk, true);
    assert.equal(plugins.verified.length, 1);
    assert.equal(plugins.installed.length, 0);

    const installed = await invoke(asId<"capability">("core.plugin.install") as never, { manifest }, { plugins });
    assert.equal(installed.ok, true);
    assert.equal(installed.value?.evidence.tool, "plugin.install");
    assert.equal(installed.value?.evidence.metadata.verificationOk, true);
    assert.equal(installed.value?.evidence.metadata.changedPluginId, "plugin-demo");
    assert.deepEqual(installed.value?.evidence.metadata.permissionDiff, { added: ["skill:read"], removed: [] });
    assert.equal(plugins.installed.length, 1);

    const rejected = await invoke(asId<"capability">("core.plugin.install") as never, {
      manifest: { ...manifest, id: "plugin-bad", integrity: "md5:bad" }
    }, { plugins });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "PLUGIN_INTEGRITY_INVALID");
    assert.equal(plugins.installed.length, 1);
  });

  it("routes PowerShell commands through the shell profile instead of a separate special-case tool", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 0,
      stdout: "pwsh ok",
      stderr: "",
      metadata: fakeProviderMetadata()
    };

    const result = await invoke(coreToolIds.shellRun, {
      command: "Write-Output 'pwsh ok'",
      shellProfile: "powershell",
      workspaceRoot
    }, { platform });
    assert.equal(result.ok, true);
    assert.deepEqual(platform.resolvedShellProfiles, ["powershell"]);
    assert.equal(platform.executedCommands[0]?.command, "pwsh");
    assert.equal(platform.executedCommands[0]?.args.includes("Write-Output 'pwsh ok'"), true);
    assert.equal(result.value?.evidence.metadata.shellProfile, "powershell");
  });

  it("reads LSP diagnostics through the code intelligence service and fails closed without it", async () => {
    const missing = await invoke(coreToolIds.codeDiagnostics, { workspaceRoot });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, "CODE_INTELLIGENCE_UNAVAILABLE");

    const codeIntelligence = new RecordingCodeIntelligence([{
      path: `${workspaceRoot}/src/index.ts`,
      message: "Unused variable",
      severity: "warning",
      line: 3,
      source: "tsserver",
      code: "6133"
    }]);
    const result = await invoke(coreToolIds.codeDiagnostics, {
      workspaceRoot,
      limit: 10
    }, { codeIntelligence });
    assert.equal(result.ok, true);
    assert.deepEqual(codeIntelligence.diagnosticRoots, [workspaceRoot]);
    assert.equal(result.value?.evidence.tool, "code.diagnostics");
    assert.match(result.value?.evidence.preview?.text ?? "", /src\/index\.ts:3 warning 6133 Unused variable/);
    const diagnostics = result.value?.evidence.metadata.diagnostics as readonly { readonly source?: string }[] | undefined;
    assert.equal(diagnostics?.[0]?.source, "tsserver");
  });

  it("adds corrective next actions to rejected tool diagnostics", async () => {
    const unavailable = await invoke(coreToolIds.codeDiagnostics, { workspaceRoot });
    assert.equal(unavailable.ok, false);
    assert.equal(Array.isArray(unavailable.error?.suggestedActions), true);
    assert.equal(unavailable.error?.suggestedActions?.some((action) => action.includes("runtime dependency")), true);
    assert.deepEqual(unavailable.value?.evidence.diagnostics[0]?.suggestedActions, unavailable.error?.suggestedActions);

    const invalidInput = await invoke(coreToolIds.fileWrite, {
      value: [{ path: "docs/USAGE.md", content: "# Usage\n" }],
      workspaceRoot
    });
    assert.equal(invalidInput.ok, false);
    assert.equal(invalidInput.error?.suggestedActions?.some((action) => action.includes("required input")), true);

    const pathRejected = await invoke(coreToolIds.fileRead, { path: "../secret.txt", workspaceRoot });
    assert.equal(pathRejected.ok, false);
    assert.equal(pathRejected.error?.suggestedActions?.some((action) => action.includes("workspace-relative path")), true);
  });

  it("calls MCP tools and reads MCP resources through the injected gateway", async () => {
    const missing = await invoke(coreToolIds.mcpToolCall, {
      serverId: "mcp-demo",
      name: "echo",
      input: {}
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, "MCP_GATEWAY_UNAVAILABLE");

    const mcp = new RecordingMcpGateway();
    const tool = await invoke(coreToolIds.mcpToolCall, {
      serverId: "mcp-demo",
      name: "echo",
      input: { text: "ping" }
    }, { mcp });
    assert.equal(tool.ok, true);
    assert.equal(mcp.toolCalls[0]?.name, "echo");
    assert.equal(tool.value?.evidence.metadata.status, "completed");

    const list = await invoke(coreToolIds.mcpResourceList, {
      namespace: "demo",
      includeInert: true
    }, { mcp });
    assert.equal(list.ok, true);
    assert.equal(mcp.listRequests[0]?.namespace, "demo");
    const resources = list.value?.evidence.metadata.resources as readonly { readonly uri?: string }[] | undefined;
    assert.equal(resources?.[0]?.uri, "file://README.md");

    const read = await invoke(coreToolIds.mcpResourceRead, {
      serverId: "mcp-demo",
      uri: "file://README.md"
    }, { mcp });
    assert.equal(read.ok, true);
    assert.equal(mcp.resourceReads[0]?.uri, "file://README.md");
    assert.match(read.value?.evidence.preview?.text ?? "", /# README/);
  });

  it("binds reconnects and cancels remote runtime connections through the remote connector", async () => {
    const missing = await invoke(coreToolIds.remoteTrigger, {
      action: "bind",
      id: "remote:test"
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, "REMOTE_RUNTIME_UNAVAILABLE");

    const remote = new RecordingRemoteRuntime();
    const bind = await invoke(coreToolIds.remoteTrigger, {
      action: "bind",
      id: "remote:test",
      transport: "relay",
      trustedDevice: { kind: "test", trusted: true }
    }, { remote });
    assert.equal(bind.ok, true);
    assert.equal(remote.bindings.get("remote:test")?.transport, "relay");
    assert.equal(bind.value?.evidence.metadata.status, "bound");

    const reconnect = await invoke(coreToolIds.remoteTrigger, {
      action: "reconnect",
      id: "remote:test"
    }, { remote });
    assert.equal(reconnect.ok, true);
    assert.equal(reconnect.value?.evidence.metadata.status, "connected");

    const cancel = await invoke(coreToolIds.remoteTrigger, {
      action: "cancel",
      id: "remote:test",
      reason: "unit-complete"
    }, { remote });
    assert.equal(cancel.ok, true);
    assert.deepEqual(remote.cancellations, [{ id: "remote:test", reason: "unit-complete" }]);
  });

  it("records session task-board create, update, output, get, and list evidence", async () => {
    const sessions = new MemorySessionStore();
    const create = await invoke(coreToolIds.taskCreate, {
      title: "Implement task board",
      status: "in_progress",
      assignedTo: "software-engineer",
      tags: ["tools"]
    }, { sessions });
    assert.equal(create.ok, true);
    const createdTask = create.value?.evidence.metadata.task as { readonly taskId?: string } | undefined;
    const createdTaskId = String(createdTask?.taskId ?? "");
    assert.match(createdTaskId, /^task:/);

    const update = await invoke(coreToolIds.taskUpdate, {
      taskId: createdTaskId,
      status: "completed",
      note: "Unit evidence is green."
    }, { sessions });
    assert.equal(update.ok, true);
    const updatedTask = update.value?.evidence.metadata.task as { readonly status?: string } | undefined;
    assert.equal(updatedTask?.status, "completed");

    const output = await invoke(coreToolIds.taskOutput, {
      taskId: createdTaskId,
      summary: "Task board tools completed.",
      artifacts: ["src/packages/core-coding-tools/src/index.test.ts"]
    }, { sessions });
    assert.equal(output.ok, true);
    const taskOutput = output.value?.evidence.metadata.output as { readonly summary?: string } | undefined;
    assert.equal(taskOutput?.summary, "Task board tools completed.");

    const get = await invoke(coreToolIds.taskGet, { taskId: createdTaskId }, { sessions });
    assert.equal(get.ok, true);
    const fetchedTask = get.value?.evidence.metadata.task as { readonly title?: string; readonly outputs?: readonly JsonObject[] } | undefined;
    assert.equal(fetchedTask?.title, "Implement task board");
    assert.equal(fetchedTask?.outputs?.length, 1);

    const list = await invoke(coreToolIds.taskList, { status: "completed" }, { sessions });
    assert.equal(list.ok, true);
    const tasks = list.value?.evidence.metadata.tasks as readonly { readonly taskId?: string }[] | undefined;
    assert.equal(tasks?.some((task) => task.taskId === createdTaskId), true);
    assert.equal(list.value?.evidence.metadata.totalCount, 1);
  });

  it("creates and deletes agent teams through the agent spawner without adding a parallel agent system", async () => {
    const agentSpawner = new RecordingAgentSpawner();
    const create = await invoke(coreToolIds.teamCreate, {
      teamId: "team:engineering",
      members: [
        { prompt: "Inspect architecture", agentMode: "worker", toolProjection: "read-only" },
        { prompt: "Implement tests", agentMode: "worker", toolProjection: "read-write" }
      ],
      reason: "parallel-independent-work"
    }, { agentSpawner });
    assert.equal(create.ok, true);
    assert.equal(agentSpawner.spawned.length, 2);
    assert.equal(agentSpawner.spawned[0]?.prompt, "Inspect architecture");
    assert.equal(agentSpawner.spawned[1]?.toolProjection, "read-write");
    const members = create.value?.evidence.metadata.members as readonly { readonly workerInstanceId?: string }[] | undefined;
    assert.equal(members?.length, 2);

    const del = await invoke(coreToolIds.teamDelete, {
      teamId: "team:engineering",
      members
    }, { agentSpawner });
    assert.equal(del.ok, true);
    assert.equal(agentSpawner.stopped.map((request) => String(request.workerInstanceId)).join(","), "agent-instance-1,agent-instance-2");
    assert.equal(del.value?.evidence.metadata.stoppedCount, 2);
  });

  it("enters and exits governed worktree environments through workspace-state management", async () => {
    const worktrees = new InMemoryWorktreeEnvironment();
    const enterId = asId<"capability">("core.worktree.enter") as (typeof coreToolIds)[keyof typeof coreToolIds];
    const exitId = asId<"capability">("core.worktree.exit") as (typeof coreToolIds)[keyof typeof coreToolIds];

    const enter = await invoke(enterId, {
      workspaceRoot,
      worktreeId: "wt-feature",
      branch: "feature/tools",
      path: `${workspaceRoot}/.worktrees/wt-feature`,
      writeScope: [`${workspaceRoot}/.worktrees/wt-feature/src`]
    }, { worktrees });
    assert.equal(enter.ok, true);
    const entered = enter.value?.evidence.metadata.worktree as { readonly status?: string; readonly path?: string } | undefined;
    assert.equal(entered?.status, "active");
    assert.equal(entered?.path, `${workspaceRoot}/.worktrees/wt-feature`);

    const exit = await invoke(exitId, { workspaceRoot, worktreeId: "wt-feature" }, { worktrees });
    assert.equal(exit.ok, true);
    const exited = exit.value?.evidence.metadata.worktree as { readonly status?: string } | undefined;
    assert.equal(exited?.status, "cleaned");
  });

  it("edits notebook cell source with workspace checkpoint evidence", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);
    const notebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { cell_type: "markdown", metadata: {}, source: ["# Title\n"] },
        { cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: ["print(1)\n"] }
      ]
    };
    await platform.writeFile(`${workspaceRoot}/analysis.ipynb`, `${JSON.stringify(notebook, null, 2)}\n`);
    const notebookEditId = asId<"capability">("core.notebook.edit") as (typeof coreToolIds)[keyof typeof coreToolIds];

    const edit = await invoke(notebookEditId, {
      path: "analysis.ipynb",
      workspaceRoot,
      cellIndex: 1,
      source: "print(2)\n"
    }, { platform, workspaceState });
    assert.equal(edit.ok, true);
    const updated = JSON.parse(await platform.readFile(`${workspaceRoot}/analysis.ipynb`)) as { cells?: readonly { source?: unknown }[] };
    assert.deepEqual(updated.cells?.[1]?.source, ["print(2)\n"]);
    assert.equal(edit.value?.evidence.metadata.cellIndex, 1);
    assert.ok(edit.value?.evidence.metadata.checkpoint);
  });

  it("discovers model-visible tools with actionable family metadata", async () => {
    const search = await invoke(coreToolIds.toolSearch, { query: "notebook edit", limit: 5 });
    assert.equal(search.ok, true);
    const tools = search.value?.evidence.metadata.tools as readonly { readonly capabilityId?: string; readonly familyId?: string }[] | undefined;
    assert.equal(tools?.some((tool) => tool.capabilityId === "core.notebook.edit" && tool.familyId === "notebook.read"), true);
    assert.match(search.value?.evidence.preview?.text ?? "", /core\.notebook\.edit/);
  });

  it("runs deterministic schedule jobs through the injected scheduler", async () => {
    const scheduler = new DeterministicScheduler();
    const scheduled = await invoke(coreToolIds.scheduleCron, {
      taskId: "task:schedule-core",
      name: "refresh index",
      action: "run-once",
      metadata: { reason: "unit" }
    }, { scheduler });
    assert.equal(scheduled.ok, true);
    assert.equal(scheduled.value?.evidence.metadata.taskId, "task:schedule-core");
    const events = scheduled.value?.evidence.metadata.events as readonly { readonly status?: string }[] | undefined;
    assert.deepEqual(events?.map((event) => event.status), ["queued", "running", "completed"]);
  });

  it("packages brief and synthetic output artifacts with schema evidence", async () => {
    const brief = await invoke(coreToolIds.briefPackage, {
      title: "Tool completion",
      summary: "Implemented core tools.",
      artifacts: ["src/packages/core-coding-tools/src/index.test.ts"],
      nextActions: ["run full tests"]
    });
    assert.equal(brief.ok, true);
    const packagedBrief = brief.value?.evidence.metadata.brief as { readonly title?: string } | undefined;
    assert.equal(packagedBrief?.title, "Tool completion");

    const synthetic = await invoke(coreToolIds.syntheticOutput, {
      schemaName: "tool-result",
      value: { status: "completed", count: 4 },
      requiredKeys: ["status", "count"]
    });
    assert.equal(synthetic.ok, true);
    assert.equal(synthetic.value?.evidence.metadata.valid, true);
    const syntheticOutput = synthetic.value?.evidence.metadata.output as { readonly status?: string } | undefined;
    assert.equal(syntheticOutput?.status, "completed");
  });

  it("reads, lists, searches, and bounds file evidence", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot, { searchProvider: "js" });
    await platform.writeFile(`${workspaceRoot}/README.md`, `alpha\n${"x".repeat(64)}`);

    const read = await invoke(coreToolIds.fileRead, { path: "README.md", workspaceRoot, limitBytes: 12 }, { platform });
    assert.equal(read.ok, true);
    assert.equal(read.value?.evidence.preview?.truncated, true);
    assert.deepEqual(read.value?.evidence.affectedPaths, [`${workspaceRoot}/README.md`]);

    const list = await invoke(coreToolIds.fileList, { pattern: "README", workspaceRoot }, { platform });
    assert.equal(list.ok, true);
    assert.match(list.value?.evidence.preview?.text ?? "", /README\.md/);

    const search = await invoke(coreToolIds.searchText, { pattern: "alpha", workspaceRoot }, { platform });
    assert.equal(search.ok, true);
    assert.equal(search.value?.evidence.provider?.selectedProvider, "js");
    assert.match(search.value?.evidence.preview?.text ?? "", /README\.md:1/);
    assert.equal((search.value?.evidence.preview?.text ?? "").includes(workspaceRoot), false);
  });

  it("returns typed bounded evidence previews for Tier 1 shell, test, patch, and file mutations", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    await platform.writeFile(`${workspaceRoot}/README.md`, "hello old\n");
    platform.nextProcessResult = {
      exitCode: 0,
      stdout: "x".repeat(64),
      stderr: "",
      metadata: fakeProviderMetadata()
    };

    const write = await invoke(coreToolIds.fileWrite, { path: "WRITE.md", content: "w".repeat(64), workspaceRoot, limitBytes: 10 }, { platform });
    const edit = await invoke(coreToolIds.fileEdit, { path: "README.md", expected: "old", replacement: "new", workspaceRoot, limitBytes: 10 }, { platform });
    const patch = await invoke(coreToolIds.patchApply, {
      workspaceRoot,
      limitBytes: 10,
      patch: "--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-hello new\n+hello patched\n"
    }, { platform });
    const shell = await invoke(coreToolIds.shellRun, { command: "echo", args: ["ok"], workspaceRoot, limitBytes: 10 }, { platform });
    platform.nextProcessResult = {
      exitCode: 0,
      stdout: "t".repeat(64),
      stderr: "",
      metadata: fakeProviderMetadata()
    };
    const test = await invoke(coreToolIds.testRun, { command: "npm", args: ["test"], workspaceRoot, limitBytes: 10 }, { platform });

    for (const result of [write, edit, patch, shell, test]) {
      assert.equal(result.ok, true);
      assert.equal(result.value?.evidence.status, "completed");
      assert.ok(result.value?.evidence.preview, "successful Tier 1 tools should provide preview evidence");
      assert.equal(result.value?.evidence.preview?.limitBytes, 10);
      assert.equal(Buffer.byteLength(result.value?.evidence.preview?.text ?? "", "utf8") <= 10, true);
      assert.equal(typeof result.value?.evidence.preview?.truncated, "boolean");
      assert.equal(Array.isArray(result.value?.evidence.affectedPaths), true);
      assert.equal(typeof result.value?.evidence.replay, "object");
    }
    assert.equal(shell.value?.evidence.preview?.truncated, true);
    assert.equal(test.value?.evidence.preview?.truncated, true);
  });

  it("keeps internal evaluation artifacts out of model-visible read, list, glob, and search tools", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot, { searchProvider: "js" });
    await platform.writeFile(`${workspaceRoot}/src/eval-task.ts`, "export const safe = 'evaluation';");
    await platform.writeFile(`${workspaceRoot}/.deepseek/evaluation-boundary-runs/run.jsonl`, "hidden old trace evaluation");
    await platform.writeFile(`${workspaceRoot}/.deepseek/evaluation-runs/probe/patch.diff`, "hidden old patch evaluation");
    await platform.writeFile(`${workspaceRoot}/.deepseek/evaluation-venv/lib/python/site.py`, "hidden env package evaluation");
    await platform.writeFile(`${workspaceRoot}/.deepseek/evaluation-runs/astropy-12907/repo/.pytest_cache/v/cache/lastfailed`, "hidden pytest cache evaluation");
    await platform.writeFile(`${workspaceRoot}/.deepseek/evaluation-runs/astropy-12907/repo/.venv/lib/python/site.py`, "hidden local venv evaluation");
    await platform.writeFile(`${workspaceRoot}/.deepseek/evaluation-runs/astropy-12907/repo/__pycache__/separable.pyc`, "hidden bytecode evaluation");

    const read = await invoke(coreToolIds.fileRead, {
      path: ".deepseek/evaluation-boundary-runs/run.jsonl",
      workspaceRoot
    }, { platform });
    assert.equal(read.ok, false);
    assert.equal(read.error?.code, "INTERNAL_ARTIFACT_REJECTED");

    const envRead = await invoke(coreToolIds.fileRead, {
      path: ".deepseek/evaluation-venv/lib/python/site.py",
      workspaceRoot
    }, { platform });
    assert.equal(envRead.ok, false);
    assert.equal(envRead.error?.code, "INTERNAL_ARTIFACT_REJECTED");

    const list = await invoke(coreToolIds.fileList, { pattern: "eval", workspaceRoot }, { platform });
    assert.equal(list.ok, true);
    assert.match(list.value?.evidence.preview?.text ?? "", /src\/eval-task\.ts/);
    assert.equal((list.value?.evidence.preview?.text ?? "").includes("evaluation-boundary-runs"), false);
    assert.equal((list.value?.evidence.preview?.text ?? "").includes("evaluation-runs"), false);
    assert.equal((list.value?.evidence.preview?.text ?? "").includes("evaluation-venv"), false);
    assert.equal((list.value?.evidence.preview?.text ?? "").includes(".pytest_cache"), false);
    assert.equal((list.value?.evidence.preview?.text ?? "").includes(".venv"), false);
    assert.equal((list.value?.evidence.preview?.text ?? "").includes("__pycache__"), false);

    const glob = await invoke(coreToolIds.workspaceGlob, { pattern: "**/*eval*", workspaceRoot }, { platform });
    assert.equal(glob.ok, true);
    assert.match(glob.value?.evidence.preview?.text ?? "", /src\/eval-task\.ts/);
    assert.equal((glob.value?.evidence.preview?.text ?? "").includes("evaluation-boundary-runs"), false);
    assert.equal((glob.value?.evidence.preview?.text ?? "").includes("evaluation-runs"), false);
    assert.equal((glob.value?.evidence.preview?.text ?? "").includes("evaluation-venv"), false);
    assert.equal((glob.value?.evidence.preview?.text ?? "").includes(".pytest_cache"), false);
    assert.equal((glob.value?.evidence.preview?.text ?? "").includes(".venv"), false);
    assert.equal((glob.value?.evidence.preview?.text ?? "").includes("__pycache__"), false);

    const search = await invoke(coreToolIds.searchText, {
      pattern: "evaluation",
      workspaceRoot,
      outputMode: "files_with_matches"
    }, { platform });
    assert.equal(search.ok, true);
    assert.match(search.value?.evidence.preview?.text ?? "", /src\/eval-task\.ts/);
    assert.equal((search.value?.evidence.preview?.text ?? "").includes("patch.diff"), false);
    assert.equal((search.value?.evidence.preview?.text ?? "").includes("evaluation-venv"), false);
    assert.equal((search.value?.evidence.preview?.text ?? "").includes(".pytest_cache"), false);
    assert.equal((search.value?.evidence.preview?.text ?? "").includes(".venv"), false);
    assert.equal((search.value?.evidence.preview?.text ?? "").includes("__pycache__"), false);
  });

  it("matches recursive glob filters when searching text content", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot, { searchProvider: "js" });
    await platform.writeFile(`${workspaceRoot}/astropy/modeling/separable.py`, "from .core import CompoundModel\n");
    await platform.writeFile(`${workspaceRoot}/astropy/modeling/other.py`, "from .core import CompoundModel\n");

    const search = await invoke(coreToolIds.searchText, {
      pattern: "CompoundModel",
      glob: "**/separable.py",
      workspaceRoot,
      outputMode: "content",
      contextLines: 0
    }, { platform });

    assert.equal(search.ok, true);
    assert.match(search.value?.evidence.preview?.text ?? "", /astropy\/modeling\/separable\.py:1:/);
    assert.equal((search.value?.evidence.preview?.text ?? "").includes("other.py"), false);
  });

  it("rejects shell commands that directly reference internal evaluation artifacts", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    await platform.writeFile(`${workspaceRoot}/.deepseek/evaluation-boundary-runs/run.jsonl`, "hidden trace");

    const result = await invoke(coreToolIds.shellRun, {
      command: "cat",
      args: [".deepseek/evaluation-boundary-runs/run.jsonl"],
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "INTERNAL_ARTIFACT_REJECTED");
  });

  it("rejects shell workspace mutation habits with semantic tool guidance", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    const copy = await invoke(coreToolIds.shellRun, {
      command: "cp README.md README.copy.md",
      cwd: ".",
      workspaceRoot
    }, { platform });
    assert.equal(copy.ok, false);
    assert.equal(copy.error?.code, "SHELL_WORKSPACE_MUTATION_REJECTED");
    assert.equal(copy.value?.evidence.metadata.recommendedTool, "file.copy");
    assert.equal(copy.value?.evidence.metadata.correctiveAction, "Use file.copy for cross-platform workspace copy operations.");
    assert.equal(platform.executedCommands.length, 0);

    const sed = await invoke(coreToolIds.shellRun, {
      command: "sed -i 's/old/new/g' README.md",
      cwd: ".",
      workspaceRoot
    }, { platform });
    assert.equal(sed.ok, false);
    assert.equal(sed.error?.code, "SHELL_WORKSPACE_MUTATION_REJECTED");
    assert.equal(sed.value?.evidence.metadata.recommendedTool, "file.edit");
    assert.equal(platform.executedCommands.length, 0);

    const pythonOpenWrite = await invoke(coreToolIds.shellRun, {
      command: "python3 -c \"with open('README.md', 'w') as f: f.write('changed')\"",
      cwd: ".",
      workspaceRoot
    }, { platform });
    assert.equal(pythonOpenWrite.ok, false);
    assert.equal(pythonOpenWrite.error?.code, "SHELL_WORKSPACE_MUTATION_REJECTED");
    assert.equal(pythonOpenWrite.value?.evidence.metadata.recommendedTool, "file.write");
    assert.equal(platform.executedCommands.length, 0);

    const pythonPathWriteText = await invoke(coreToolIds.shellRun, {
      command: "python -c \"from pathlib import Path; Path('README.md').write_text('changed')\"",
      cwd: ".",
      workspaceRoot
    }, { platform });
    assert.equal(pythonPathWriteText.ok, false);
    assert.equal(pythonPathWriteText.error?.code, "SHELL_WORKSPACE_MUTATION_REJECTED");
    assert.equal(pythonPathWriteText.value?.evidence.metadata.recommendedTool, "file.write");
    assert.equal(platform.executedCommands.length, 0);

    const mkdir = await invoke(coreToolIds.shellRun, {
      command: "mkdir -p docs/generated",
      cwd: ".",
      workspaceRoot
    }, { platform });
    assert.equal(mkdir.ok, false);
    assert.equal(mkdir.error?.code, "SHELL_WORKSPACE_MUTATION_REJECTED");
    assert.equal(mkdir.value?.evidence.metadata.recommendedTool, "directory.create");

    const touch = await invoke(coreToolIds.shellRun, {
      command: "touch docs/generated/empty.txt",
      cwd: ".",
      workspaceRoot
    }, { platform });
    assert.equal(touch.ok, false);
    assert.equal(touch.error?.code, "SHELL_WORKSPACE_MUTATION_REJECTED");
    assert.equal(touch.value?.evidence.metadata.recommendedTool, "file.touch");
    assert.equal(platform.executedCommands.length, 0);

    const json = await invoke(coreToolIds.shellRun, {
      command: "jq . package.json",
      cwd: ".",
      workspaceRoot
    }, { platform });
    assert.equal(json.ok, false);
    assert.equal(json.value?.evidence.metadata.recommendedTool, "json.read");

    const hash = await invoke(coreToolIds.shellRun, {
      command: "sha256sum package.json",
      cwd: ".",
      workspaceRoot
    }, { platform });
    assert.equal(hash.ok, false);
    assert.equal(hash.value?.evidence.metadata.recommendedTool, "checksum.hash");

    const path = await invoke(coreToolIds.shellRun, {
      command: "realpath package.json",
      cwd: ".",
      workspaceRoot
    }, { platform });
    assert.equal(path.ok, false);
    assert.equal(path.value?.evidence.metadata.recommendedTool, "path.resolve");

    const env = await invoke(coreToolIds.shellRun, {
      command: "printenv",
      cwd: ".",
      workspaceRoot
    }, { platform });
    assert.equal(env.ok, false);
    assert.equal(env.value?.evidence.metadata.recommendedTool, "env.inspect");

    const which = await invoke(coreToolIds.shellRun, {
      command: "which node",
      cwd: ".",
      workspaceRoot
    }, { platform });
    assert.equal(which.ok, false);
    assert.equal(which.value?.evidence.metadata.recommendedTool, "command.lookup");

    const archive = await invoke(coreToolIds.shellRun, {
      command: "unzip archive.zip",
      cwd: ".",
      workspaceRoot
    }, { platform });
    assert.equal(archive.ok, false);
    assert.equal(archive.value?.evidence.metadata.recommendedTool, "archive.extract");
    assert.equal(platform.executedCommands.length, 0);
  });

  it("rejects shell terminal evidence destruction commands with corrective guidance", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    for (const command of ["clear", "cls", "reset"]) {
      const result = await invoke(coreToolIds.shellRun, {
        command,
        cwd: ".",
        workspaceRoot
      }, { platform });

      assert.equal(result.ok, false);
      assert.equal(result.error?.code, "SHELL_EVIDENCE_DESTRUCTION_REJECTED");
      assert.equal(result.value?.evidence.metadata.rejectedCommand, command);
      assert.equal(result.value?.evidence.metadata.correctiveAction, "Do not clear terminal evidence; inspect existing output or run the next verification command with bounded output.");
    }
    assert.equal(platform.executedCommands.length, 0);
  });

  it("matches shell governance commands with platform shell case semantics", async () => {
    const linux = new ShellCapableFakePlatform("linux", workspaceRoot);
    const windows = new ShellCapableFakePlatform("windows", "C:/workspace/windows");

    const linuxUppercase = await invoke(coreToolIds.shellRun, {
      command: "CP README.md README.copy.md",
      cwd: ".",
      workspaceRoot
    }, { platform: linux });
    assert.equal(linuxUppercase.ok, true);
    assert.equal(linux.executedCommands.at(-1)?.command, "bash");
    assert.equal(linux.executedCommands.at(-1)?.args.at(-1)?.includes("CP README.md README.copy.md"), true);

    const linuxLowercase = await invoke(coreToolIds.shellRun, {
      command: "cp README.md README.copy.md",
      cwd: ".",
      workspaceRoot
    }, { platform: linux });
    assert.equal(linuxLowercase.ok, false);
    assert.equal(linuxLowercase.error?.code, "SHELL_WORKSPACE_MUTATION_REJECTED");

    const windowsUppercase = await invoke(coreToolIds.shellRun, {
      command: "COPY README.md README.copy.md",
      cwd: ".",
      workspaceRoot: "C:/workspace/windows"
    }, { platform: windows });
    assert.equal(windowsUppercase.ok, false);
    assert.equal(windowsUppercase.error?.code, "SHELL_WORKSPACE_MUTATION_REJECTED");
    assert.equal(windows.executedCommands.length, 0);
  });

  it("allows shell commands inside a managed evaluation checkout to reference that checkout", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/evaluation-runs/unit-run/repo`;
    await platform.writeFile(`${repoRoot}/astropy/io/ascii/core.py`, "header_rows = []");

    const outerTraversal = await invoke(coreToolIds.shellRun, {
      command: `grep -rn "header_rows" ${repoRoot}/astropy/io/ascii/ | head -50`,
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(outerTraversal.ok, false);
    assert.equal(outerTraversal.error?.code, "INTERNAL_ARTIFACT_REJECTED");

    const currentCheckout = await invoke(coreToolIds.shellRun, {
      command: `grep -rn "header_rows" ${repoRoot}/astropy/io/ascii/ | head -50`,
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(currentCheckout.ok, true);
    assert.deepEqual(platform.executedCommands.at(-1), {
      command: "bash",
      args: ["-lc", `set -o pipefail; PATH=${repoRoot}/.venv/bin:$PATH; export PATH; grep -rn "header_rows" ${repoRoot}/astropy/io/ascii/ | head -50`],
      cwd: repoRoot
    });
  });

  it("runs model-authored shell command strings through the host shell", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    const shellString = await invoke(coreToolIds.shellRun, {
      command: "echo hello && pwd",
      workspaceRoot
    }, { platform });

    assert.equal(shellString.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", "set -o pipefail; echo hello && pwd"],
      cwd: workspaceRoot
    });
    assert.equal(shellString.value?.evidence.metadata.shellSyntax, true);

    const argv = await invoke(coreToolIds.shellRun, {
      command: "echo",
      args: ["hello"],
      workspaceRoot
    }, { platform });

    assert.equal(argv.ok, true);
    assert.deepEqual(platform.executedCommands[1], {
      command: "echo",
      args: ["hello"],
      cwd: workspaceRoot
    });
  });

  it("rejects model-authored host pip installs unless they target a local virtual environment", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    const rejected = await invoke(coreToolIds.shellRun, {
      command: "pip3 install --break-system-packages 'numpy<2' 2>&1 | tail -5",
      workspaceRoot
    }, { platform });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "HOST_PACKAGE_INSTALL_REJECTED");
    assert.equal(platform.executedCommands.length, 0);

    const localVenv = await invoke(coreToolIds.shellRun, {
      command: "source .venv/bin/activate && pip install numpy",
      cwd: ".deepseek/evaluation-runs/astropy-12907/repo",
      workspaceRoot
    }, { platform });

    assert.equal(localVenv.ok, true);
    assert.equal(platform.executedCommands.length, 1);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", "set -o pipefail; PATH=/workspace/.deepseek/evaluation-runs/astropy-12907/repo/.venv/bin:$PATH; export PATH; source .venv/bin/activate && python -m pip install numpy"],
      cwd: `${workspaceRoot}/.deepseek/evaluation-runs/astropy-12907/repo`
    });
  });

  it("binds managed evaluation checkout shell commands to the checkout-local virtualenv", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/evaluation-runs/unit-run/repo`;

    const result = await invoke(coreToolIds.shellRun, {
      command: `cd ${repoRoot} && pip install -e . 2>&1 | tail -20`,
      timeoutMs: 300_000,
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", `set -o pipefail; PATH=${repoRoot}/.venv/bin:$PATH; export PATH; cd ${repoRoot} && python -m pip install -e . 2>&1 | tail -20`],
      cwd: repoRoot
    });
  });

  it("rewrites common container checkout aliases inside managed evaluation shell commands", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/evaluation-runs/unit-run/repo`;

    const result = await invoke(coreToolIds.shellRun, {
      command: "cd /home/user && python -m pytest astropy/io/ascii/tests/test_qdp.py -x -v --no-header -q 2>&1 | head -80",
      timeoutMs: 120_000,
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", `set -o pipefail; PATH=${repoRoot}/.venv/bin:$PATH; export PATH; cd ${repoRoot} && python -m pytest astropy/io/ascii/tests/test_qdp.py -x -v --no-header -q 2>&1 | head -80`],
      cwd: repoRoot
    });
    assert.equal(result.value?.evidence.metadata.managedCheckoutVenvBound, true);
  });

  it("binds managed evaluation checkout argv pip commands through the checkout python", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/evaluation-runs/unit-run/repo`;

    const result = await invoke(coreToolIds.shellRun, {
      command: "pip",
      args: ["install", "hypothesis"],
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: `${repoRoot}/.venv/bin/python`,
      args: ["-m", "pip", "install", "hypothesis"],
      cwd: repoRoot
    });
  });

  it("allows managed evaluation checkout package installs after binding PATH to the checkout-local virtualenv", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/evaluation-runs/unit-run/repo`;

    const result = await invoke(coreToolIds.shellRun, {
      command: `cd ${repoRoot} && pip install setuptools==68.0.0 2>&1 | tail -5`,
      timeoutMs: 300_000,
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", `set -o pipefail; PATH=${repoRoot}/.venv/bin:$PATH; export PATH; cd ${repoRoot} && python -m pip install setuptools==68.0.0 2>&1 | tail -5`],
      cwd: repoRoot
    });
  });

  it("gives managed evaluation checkout package installs a long default timeout", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/evaluation-runs/unit-run/repo`;

    const result = await invoke(coreToolIds.shellRun, {
      command: "pip install -e . 2>&1 | tail -5",
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(platform.commandTimeouts[0], 600_000);
  });

  it("runs model-authored test command strings through the host shell", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    const result = await invoke(coreToolIds.testRun, {
      command: "python -m pytest tests/unit -x -v 2>&1 | tail -40",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", "set -o pipefail; python -m pytest tests/unit -x -v 2>&1 | tail -40"],
      cwd: workspaceRoot
    });
    assert.equal(result.value?.evidence.metadata.shellSyntax, true);
  });

  it("runs test command strings with args through the host shell", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    const result = await invoke(coreToolIds.testRun, {
      command: "python -m pytest",
      args: ["astropy/io/ascii/tests/test_rst.py::test_rst_with_header_rows", "-xvs"],
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", "set -o pipefail; python -m pytest astropy/io/ascii/tests/test_rst.py::test_rst_with_header_rows -xvs"],
      cwd: workspaceRoot
    });
  });

  it("describes test.run as standard repository verification rather than ad-hoc reproduction", () => {
    const manifest = coreToolManifests().find((tool) => String(tool.id) === "core.test.run");
    assert.ok(manifest);

    const schemaText = JSON.stringify(manifest.inputSchema);
    assert.match(manifest.description ?? "", /standard repository test command/i);
    assert.match(schemaText, /pytest, python -m pytest, python -m unittest, tox, nox/i);
    assert.match(schemaText, /Do not use python -c/i);
    assert.match(schemaText, /Do not set cwd to \/workspace/i);
  });

  it("classifies standard test commands through shared ecosystem patterns", () => {
    assert.equal(isStandardTestCommand("python tests/runtests.py forms_tests.tests.test_media -v 2"), true);
    assert.equal(isStandardTestCommand("cd repo && python tests/runtests.py forms_tests.tests.test_media -v 2 | head -100"), true);
    assert.equal(isStandardTestCommand("python", ["-m", "django", "test", "forms_tests.tests.test_media"]), true);
    assert.equal(isStandardTestCommand("bash", ["-lc", "cd /mnt/c/repo && python tests/runtests.py forms_tests.tests.test_media -v 2 | head -100"]), true);
    assert.equal(isStandardTestCommand("wsl.exe", ["bash", "-lc", "cd /mnt/c/repo && python tests/runtests.py forms_tests.tests.test_media -v 2"]), true);
    assert.equal(isStandardTestCommand("wsl", ["-e", "bash", "-lc", "python tests/runtests.py forms_tests.tests.test_media -v 2"]), true);
    assert.equal(isStandardTestCommand("wsl.exe", ["--shell-type", "standard", "--cd", "/mnt/c/repo", "--", "bash", "-lc", "python -m pytest tests/test_demo.py"]), true);
    assert.equal(isStandardTestCommand("wsl.exe --cd /mnt/c/repo python -m pytest tests/test_demo.py"), true);
    assert.equal(isStandardTestCommand("pwsh", ["-NoProfile", "-Command", "cd repo; python .\\tests\\runtests.py forms_tests.tests.test_media -v 2 | Select-Object -First 100"]), true);
    assert.equal(isStandardTestCommand("cmd.exe", ["/d", "/s", "/c", "python tests\\runtests.py forms_tests.tests.test_media -v 2"]), true);
    assert.equal(isStandardTestCommand("C:\\Python311\\python.exe .\\tests\\runtests.py forms_tests.tests.test_media -v 2"), true);
    assert.equal(isStandardTestCommand("npm run test -- --watch=false"), true);
    assert.equal(isStandardTestCommand("go test ./..."), true);
    assert.equal(isStandardTestCommand("cargo test --workspace"), true);
    assert.equal(isStandardTestCommand("git checkout astropy/modeling/separable.py && python -m pytest astropy/modeling/tests/test_separable.py -q"), false);
    assert.equal(isStandardTestCommand("python -c \"import django\""), false);
  });

  it("does not duplicate python -c when the command string already includes it", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    const result = await invoke(coreToolIds.testRun, {
      command: "python -c",
      args: ["-c", "print(123)"],
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", "set -o pipefail; python -c 'print(123)'"],
      cwd: workspaceRoot
    });
  });

  it("binds managed evaluation checkout test commands to the checkout-local virtualenv", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/evaluation-runs/unit-run/repo`;

    const result = await invoke(coreToolIds.testRun, {
      command: "python -m pytest",
      args: ["astropy/io/ascii/tests/test_rst.py", "-x", "-v"],
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", `set -o pipefail; PATH=${repoRoot}/.venv/bin:$PATH; export PATH; python -m pytest astropy/io/ascii/tests/test_rst.py -x -v`],
      cwd: repoRoot
    });
    assert.equal(platform.commandTimeouts[0], 600_000);
    assert.equal(result.value?.evidence.metadata.managedCheckoutVenvBound, true);
  });

  it("binds run-scoped managed checkout python reproductions to the checkout-local virtualenv", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/managed-runs/unit-run/repo`;

    const result = await invoke(coreToolIds.testRun, {
      command: "python -c \"print(123)\"",
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", `set -o pipefail; PATH=${repoRoot}/.venv/bin:$PATH; export PATH; python -c \"print(123)\"`],
      cwd: repoRoot
    });
    assert.equal(result.value?.evidence.metadata.managedCheckoutVenvBound, true);
  });

  it("classifies missing Python test dependencies instead of returning an opaque pytest failure", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 4,
      stdout: "",
      stderr: [
        "ImportError while loading conftest '/workspace/conftest.py'.",
        "conftest.py:9: in <module>",
        "    import hypothesis",
        "E   ModuleNotFoundError: No module named 'hypothesis'"
      ].join("\n")
    };

    const result = await invoke(coreToolIds.testRun, {
      command: "python -m pytest",
      args: ["astropy/io/ascii/tests/test_rst.py", "-x", "-v"],
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_DEPENDENCY_MISSING/);
    assert.match(result.value?.evidence.preview?.text ?? "", /python -m pip install hypothesis/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.kind, "python-missing-module");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.moduleName, "hypothesis");
  });

  it("classifies Python interpreter no-module output as a missing test dependency", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 1,
      stdout: "",
      stderr: "/workspace/.deepseek/evaluation-runs/unit-run/repo/.venv/bin/python: No module named pytest"
    };

    const result = await invoke(coreToolIds.testRun, {
      command: "python -m pytest",
      args: ["astropy/io/ascii/tests/test_rst.py", "-x", "-v"],
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_DEPENDENCY_MISSING/);
    assert.match(result.value?.evidence.preview?.text ?? "", /python -m pip install pytest/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.kind, "python-missing-module");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.moduleName, "pytest");
  });

  it("points pytest-missing managed evaluation checks at repo-local Python test runners when present", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/evaluation-runs/unit-run/repo`;
    await platform.writeFile(`${repoRoot}/tests/runtests.py`, "# repo-local test runner\n");
    platform.nextProcessResult = {
      exitCode: 1,
      stdout: "",
      stderr: `${repoRoot}/.venv/bin/python: No module named pytest`
    };

    const result = await invoke(coreToolIds.testRun, {
      command: "python -m pytest",
      args: ["tests/invalid_models_tests/test_ordinary_fields.py", "-xvs"],
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_DEPENDENCY_MISSING/);
    assert.match(result.value?.evidence.preview?.text ?? "", /Repo-local Python test runner is available at 'tests\/runtests.py'/);
    assert.match(result.value?.evidence.preview?.text ?? "", /python tests\/runtests.py/);
    assert.doesNotMatch(result.value?.evidence.preview?.text ?? "", /python -m pip install pytest/);
    const testFailure = result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string; suggestedCommand?: string; alternateCommand?: string } | undefined;
    assert.equal(testFailure?.kind, "python-missing-module");
    assert.equal(testFailure?.moduleName, "pytest");
    assert.equal(testFailure?.suggestedCommand, "python tests/runtests.py");
    assert.equal(testFailure?.alternateCommand, "python tests/runtests.py");
  });

  it("points missing Python test launchers at repo-local runners without dependency-install advice", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/evaluation-runs/unit-run/repo`;
    await platform.writeFile(`${repoRoot}/tests/runtests.py`, "# repo-local test runner\n");
    platform.nextProcessResult = {
      exitCode: 1,
      stdout: "",
      stderr: `${repoRoot}/.venv/bin/python: No module named nose`
    };

    const result = await invoke(coreToolIds.testRun, {
      command: "python",
      args: ["-m", "nose", "tests/test_demo.py"],
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_DEPENDENCY_MISSING/);
    assert.match(result.value?.evidence.preview?.text ?? "", /Repo-local Python test runner is available at 'tests\/runtests.py'/);
    assert.match(result.value?.evidence.preview?.text ?? "", /python tests\/runtests.py/);
    assert.doesNotMatch(result.value?.evidence.preview?.text ?? "", /python -m pip install nose/);
    const testFailure = result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string; suggestedCommand?: string; alternateCommand?: string; suggestedAction?: string } | undefined;
    assert.equal(testFailure?.kind, "python-missing-module");
    assert.equal(testFailure?.moduleName, "nose");
    assert.equal(testFailure?.suggestedAction, "use-repo-local-python-test-runner");
    assert.equal(testFailure?.suggestedCommand, "python tests/runtests.py");
    assert.equal(testFailure?.alternateCommand, "python tests/runtests.py");
  });

  it("adds repo-local runner hints to shell pytest failures inside managed evaluation checkouts", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/evaluation-runs/unit-run/repo`;
    await platform.writeFile(`${repoRoot}/tests/runtests.py`, "# repo-local test runner\n");
    platform.nextProcessResult = {
      exitCode: 1,
      stdout: "",
      stderr: `${repoRoot}/.venv/bin/python: No module named pytest`
    };

    const result = await invoke(coreToolIds.shellRun, {
      command: "python -m pytest tests/invalid_models_tests/test_ordinary_fields.py -xvs 2>&1 | tail -30",
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /Repo-local Python test runner is available at 'tests\/runtests.py'/);
    assert.doesNotMatch(result.value?.evidence.preview?.text ?? "", /python -m pip install pytest/);
    assert.equal((result.value?.evidence.metadata.testFailure as { suggestedCommand?: string; alternateCommand?: string } | undefined)?.suggestedCommand, "python tests/runtests.py");
    assert.equal((result.value?.evidence.metadata.testFailure as { alternateCommand?: string } | undefined)?.alternateCommand, "python tests/runtests.py");
  });

  it("classifies legacy numpy API pytest crashes as checkout dependency incompatibility", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 3,
      stdout: [
        "INTERNALERROR> Traceback (most recent call last):",
        "INTERNALERROR>   File \"/workspace/repo/.venv/lib/python3.9/site-packages/_pytest/main.py\", line 285, in wrap_session",
        "INTERNALERROR>     config._do_configure()",
        "INTERNALERROR> AttributeError: module 'numpy' has no attribute 'product'"
      ].join("\n"),
      stderr: ""
    };

    const result = await invoke(coreToolIds.testRun, {
      command: "python -m pytest",
      args: ["astropy/wcs/tests/test_wcs.py", "-x", "-v"],
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_DEPENDENCY_INCOMPATIBLE/);
    assert.match(result.value?.evidence.preview?.text ?? "", /python -m pip install 'numpy<2'/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; dependencyName?: string } | undefined)?.kind, "python-dependency-incompatible");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; dependencyName?: string } | undefined)?.dependencyName, "numpy");
  });

  it("classifies missing Python test runner files as invalid test command feedback", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 2,
      stdout: "",
      stderr: "python: can't open file '/workspace/repo/runtests.py': [Errno 2] No such file or directory"
    };

    const result = await invoke(coreToolIds.testRun, {
      command: "python",
      args: ["runtests.py", "forms_tests.tests.test_media"],
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_ENTRYPOINT_MISSING/);
    assert.match(result.value?.evidence.preview?.text ?? "", /Find the repo-local test runner before retrying/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; missingPath?: string } | undefined)?.kind, "python-test-entrypoint-missing");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; missingPath?: string } | undefined)?.missingPath, "/workspace/repo/runtests.py");
  });

  it("classifies unsupported Python test runner flags and suggests the accepted spelling", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 2,
      stdout: [
        "usage: runtests.py [-h] [-v {0,1,2,3}] [--noinput] [--failfast]",
        "runtests.py: error: unrecognized arguments: --no-input"
      ].join("\n"),
      stderr: ""
    };

    const result = await invoke(coreToolIds.testRun, {
      command: "python",
      args: ["tests/runtests.py", "forms_tests.tests.test_media", "--no-input"],
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_ARGUMENT_UNSUPPORTED/);
    assert.match(result.value?.evidence.preview?.text ?? "", /Use '--noinput' instead of '--no-input'/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; unsupportedOption?: string; suggestedOption?: string } | undefined)?.kind, "python-test-argument-unsupported");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; unsupportedOption?: string; suggestedOption?: string } | undefined)?.unsupportedOption, "--no-input");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; unsupportedOption?: string; suggestedOption?: string } | undefined)?.suggestedOption, "--noinput");
  });

  it("classifies Python test command environment scope failures without suggesting package installs", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 1,
      stdout: "",
      stderr: [
        "Traceback (most recent call last):",
        "  File \"<frozen importlib._bootstrap>\", line 1147, in _find_and_load_unlocked",
        "ModuleNotFoundError: No module named 'test_sqlite'"
      ].join("\n")
    };

    const result = await invoke(coreToolIds.shellRun, {
      command: "python -m django test tests.invalid_models_tests.test_ordinary_fields.FilePathFieldTests --settings=test_sqlite --verbosity=2",
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_COMMAND_ENV_MISSCOPED/);
    assert.doesNotMatch(result.value?.evidence.preview?.text ?? "", /pip install test_sqlite/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.kind, "python-test-command-env-misscoped");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.moduleName, "test_sqlite");
  });

  it("classifies dotted Django settings module scope failures without suggesting package installs", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 1,
      stdout: "",
      stderr: [
        "Traceback (most recent call last):",
        "  File \"<frozen importlib._bootstrap>\", line 1147, in _find_and_load_unlocked",
        "ModuleNotFoundError: No module named 'test_sqlite'"
      ].join("\n")
    };

    const result = await invoke(coreToolIds.shellRun, {
      command: "python -m django test tests.invalid_models_tests.test_ordinary_fields.FilePathFieldTests --settings=tests.test_sqlite --verbosity=2",
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_COMMAND_ENV_MISSCOPED/);
    assert.doesNotMatch(result.value?.evidence.preview?.text ?? "", /pip install test_sqlite/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.kind, "python-test-command-env-misscoped");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.moduleName, "test_sqlite");
  });

  it("classifies checkout-local Python test module scope failures without suggesting package installs", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 1,
      stdout: "",
      stderr: [
        "Traceback (most recent call last):",
        "  File \"<frozen importlib._bootstrap>\", line 1147, in _find_and_load_unlocked",
        "ModuleNotFoundError: No module named 'invalid_models_tests'"
      ].join("\n")
    };

    const result = await invoke(coreToolIds.shellRun, {
      command: "DJANGO_SETTINGS_MODULE=tests.test_sqlite python -m unittest tests.invalid_models_tests.test_ordinary_fields.FilePathFieldTests",
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_COMMAND_ENV_MISSCOPED/);
    assert.doesNotMatch(result.value?.evidence.preview?.text ?? "", /pip install invalid_models_tests/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.kind, "python-test-command-env-misscoped");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.moduleName, "invalid_models_tests");
  });

  it("classifies model-authored shell Python test failures with the same feedback as test.run", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 4,
      stdout: "",
      stderr: [
        "ImportError while loading conftest '/workspace/conftest.py'.",
        "conftest.py:9: in <module>",
        "    import hypothesis",
        "E   ModuleNotFoundError: No module named 'hypothesis'"
      ].join("\n")
    };

    const result = await invoke(coreToolIds.shellRun, {
      command: "python -m pytest astropy/io/ascii/tests/test_rst.py -x -v 2>&1 | tail -40",
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.equal(result.value?.evidence.status, "failed");
    assert.match(result.value?.evidence.preview?.text ?? "", /PYTHON_TEST_DEPENDENCY_MISSING/);
    assert.match(result.value?.evidence.preview?.text ?? "", /python -m pip install hypothesis/);
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.kind, "python-missing-module");
    assert.equal((result.value?.evidence.metadata.testFailure as { kind?: string; moduleName?: string } | undefined)?.moduleName, "hypothesis");
  });

  it("allows managed evaluation checkout installs through an absolute checkout-local virtualenv", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    const repoRoot = `${workspaceRoot}/.deepseek/evaluation-runs/unit-run/repo`;

    const result = await invoke(coreToolIds.shellRun, {
      command: `python3 -m venv ${repoRoot}/.venv && source ${repoRoot}/.venv/bin/activate && pip install pytest numpy 2>&1 | tail -5`,
      timeoutMs: 300_000,
      cwd: ".",
      workspaceRoot: repoRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", `set -o pipefail; PATH=${repoRoot}/.venv/bin:$PATH; export PATH; python3 -m venv ${repoRoot}/.venv && source ${repoRoot}/.venv/bin/activate && python -m pip install pytest numpy 2>&1 | tail -5`],
      cwd: repoRoot
    });
  });

  it("allows managed evaluation shell commands to invoke the managed checkout virtualenv by absolute path", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    const result = await invoke(coreToolIds.shellRun, {
      command: `${workspaceRoot}/.deepseek/evaluation-runs/astropy-12907/repo/.venv/bin/python3 test_regression_separability.py`,
      cwd: ".deepseek/evaluation-runs/astropy-12907/repo",
      workspaceRoot
    }, { platform });

    assert.equal(result.ok, true);
    assert.deepEqual(platform.executedCommands[0], {
      command: "bash",
      args: ["-lc", `set -o pipefail; PATH=${workspaceRoot}/.deepseek/evaluation-runs/astropy-12907/repo/.venv/bin:$PATH; export PATH; ${workspaceRoot}/.deepseek/evaluation-runs/astropy-12907/repo/.venv/bin/python3 test_regression_separability.py`],
      cwd: `${workspaceRoot}/.deepseek/evaluation-runs/astropy-12907/repo`
    });
  });

  it("rejects direct traversal into historical managed evaluation workspaces from the CLI workspace root", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);

    const rejected = await invoke(coreToolIds.shellRun, {
      command: "cd .deepseek/evaluation-runs/astropy-12907/repo && source .venv/bin/activate && python -m pytest astropy/modeling/tests/test_separable.py -v",
      cwd: ".",
      workspaceRoot
    }, { platform });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "INTERNAL_ARTIFACT_REJECTED");
    assert.equal(platform.executedCommands.length, 0);
  });

  it("globs workspace files, views local assets, and reads bounded notebooks", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    await platform.writeFile(`${workspaceRoot}/src/app.ts`, "export const value = 1;");
    await platform.writeFile(`${workspaceRoot}/README.txt`, "hello asset");
    await platform.writeFile(`${workspaceRoot}/analysis.ipynb`, JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      cells: [
        { cell_type: "markdown", source: ["# Title\n", "body"], metadata: { safe: true, token: "redacted" } },
        { cell_type: "code", source: "print('x')", execution_count: 1, outputs: [{ output_type: "stream" }] }
      ]
    }));

    const glob = await invoke(coreToolIds.workspaceGlob, { pattern: "**/*.ts", workspaceRoot }, { platform });
    assert.equal(glob.ok, true);
    assert.match(glob.value?.evidence.preview?.text ?? "", /src\/app\.ts/);

    const asset = await invoke(coreToolIds.assetViewLocal, { path: "README.txt", workspaceRoot, limitBytes: 20 }, { platform });
    assert.equal(asset.ok, true);
    assert.equal(asset.value?.evidence.metadata.mime, "text/plain");
    assert.match(asset.value?.evidence.preview?.text ?? "", /hello asset/);

    const notebook = await invoke(coreToolIds.notebookRead, { path: "analysis.ipynb", workspaceRoot, maxCells: 1, maxSourceBytes: 8 }, { platform });
    assert.equal(notebook.ok, true);
    assert.equal(notebook.value?.evidence.metadata.cellCount, 2);
    assert.equal(notebook.value?.evidence.metadata.truncatedCells, true);

    const malformed = await invoke(coreToolIds.notebookRead, { path: "README.txt", workspaceRoot }, { platform });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error?.code, "NOTEBOOK_EXTENSION_UNSUPPORTED");

    const rejected = await invoke(coreToolIds.workspaceGlob, { pattern: "../**/*.ts", workspaceRoot }, { platform });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "GLOB_PATTERN_REJECTED");
  });

  it("bounds file evidence without splitting Unicode surrogate pairs", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    await platform.writeFile(`${workspaceRoot}/README.md`, `${"a".repeat(7999)}🧠tail`);

    const read = await invoke(coreToolIds.fileRead, { path: "README.md", workspaceRoot, limitBytes: 8000 }, { platform });
    const preview = read.value?.evidence.preview?.text ?? "";

    assert.equal(read.ok, true);
    assert.equal(read.value?.evidence.preview?.truncated, true);
    assert.equal(Buffer.byteLength(preview, "utf8") <= 8000, true);
    assert.equal(hasLoneSurrogate(preview), false);
  });

  it("lists files with model-authored glob patterns", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    await platform.writeFile(`${workspaceRoot}/astropy/modeling/separable.py`, "def separability_matrix(): pass\n");
    await platform.writeFile(`${workspaceRoot}/astropy/modeling/core.py`, "class Model: pass\n");

    const nested = await invoke(coreToolIds.fileList, { pattern: "**/separable.py", workspaceRoot }, { platform });
    assert.equal(nested.ok, true);
    assert.match(nested.value?.evidence.preview?.text ?? "", /astropy\/modeling\/separable\.py/);
    assert.equal(nested.value?.evidence.metadata.count, 1);

    const basename = await invoke(coreToolIds.fileList, { path: "astropy/modeling", pattern: "*separable*", workspaceRoot }, { platform });
    assert.equal(basename.ok, true);
    assert.match(basename.value?.evidence.preview?.text ?? "", /astropy\/modeling\/separable\.py/);
    assert.equal((basename.value?.evidence.preview?.text ?? "").includes("core.py"), false);
  });

  it("reads and discovers mixed-case files in a real checkout", async () => {
    const platform = new NodePlatformRuntime("macos");
    const root = await mkdtemp(join(tmpdir(), "deepseek-core-tools-checkout-"));

    try {
      await mkdir(join(root, "astropy", "modeling"), { recursive: true });
      await writeFile(join(root, "README.rst"), "root readme\n", "utf8");
      await writeFile(join(root, "astropy", "modeling", "separable.py"), "def separability_matrix(): pass\n", "utf8");

      const readme = await invoke(coreToolIds.fileRead, { path: "README.rst", workspaceRoot: root }, { platform: platform as unknown as FakePlatformRuntime });
      assert.equal(readme.ok, true);
      assert.equal(readme.value?.evidence.metadata.relativePath, "README.rst");
      assert.match(readme.value?.evidence.preview?.text ?? "", /root readme/);

      const list = await invoke(coreToolIds.fileList, { pattern: "**/separable.py", workspaceRoot: root }, { platform: platform as unknown as FakePlatformRuntime });
      assert.equal(list.ok, true);
      assert.match(list.value?.evidence.preview?.text ?? "", /astropy\/modeling\/separable\.py/);
      assert.equal(list.value?.evidence.metadata.count, 1);

      const glob = await invoke(coreToolIds.workspaceGlob, { pattern: "**/separable.py", workspaceRoot: root }, { platform: platform as unknown as FakePlatformRuntime });
      assert.equal(glob.ok, true);
      assert.equal(glob.value?.evidence.metadata.count, 1);
      assert.match(glob.value?.evidence.preview?.text ?? "", /astropy\/modeling\/separable\.py/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes and exact-edits with transactions, then rejects ambiguous edits without mutation", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);

    const write = await invoke(coreToolIds.fileWrite, { path: "app.ts", content: "one two one", workspaceRoot }, { platform, workspaceState });
    assert.equal(write.ok, true);

    const nestedWrite = await invoke(coreToolIds.fileWrite, { path: "generated-webpage/index.html", content: "<h1>ok</h1>", workspaceRoot }, { platform, workspaceState });
    assert.equal(nestedWrite.ok, true);
    assert.equal(await platform.readFile(`${workspaceRoot}/generated-webpage/index.html`), "<h1>ok</h1>");

    const rejected = await invoke(coreToolIds.fileEdit, { path: "app.ts", expected: "one", replacement: "three", workspaceRoot }, { platform, workspaceState });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "EDIT_PRECONDITION_FAILED");
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "one two one");

    const edited = await invoke(coreToolIds.fileEdit, { path: "app.ts", expected: "two", replacement: "three", workspaceRoot }, { platform, workspaceState });
    assert.equal(edited.ok, true);
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "one three one");
    assert.equal(workspaceState.records().length, 3);
    const checkpoint = edited.value?.evidence.metadata.checkpoint as { checkpointId?: string; beforeHash?: string; afterHash?: string } | undefined;
    assert.equal(typeof checkpoint?.checkpointId, "string");
    assert.notEqual(checkpoint?.beforeHash, checkpoint?.afterHash);
    const undo = await workspaceState.undoLatest({ path: `${workspaceRoot}/app.ts` });
    assert.equal(undo.ok, true);
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "one two one");
  });

  it("returns nearest current context when exact file edit preconditions fail", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);
    await platform.writeFile(`${workspaceRoot}/app.ts`, [
      "function alpha() {",
      "  return 1;",
      "}",
      "",
      "function beta() {",
      "  return 2;",
      "}"
    ].join("\n"));

    const result = await invoke(coreToolIds.fileEdit, {
      path: "app.ts",
      expected: [
        "function beta() {",
        "  return missing;",
        "}"
      ].join("\n"),
      replacement: "function beta() {\n  return 3;\n}",
      workspaceRoot
    }, { platform, workspaceState });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "EDIT_PRECONDITION_FAILED");
    const details = result.error?.details as JsonObject | undefined;
    assert.equal(typeof details?.nearestContext, "string");
    assert.match(String(details?.nearestContext), /function beta/);
    assert.match(String(details?.nearestContext), /return 2/);
    assert.equal(typeof details?.nearestContextStartLine, "number");
    assert.deepEqual(result.error?.suggestedActions, [
      "Use nearestContext as the current exact file context and retry file.edit with corrected expected text.",
      "If exact-match context is unstable, use patch.apply with matching surrounding context from nearestContext."
    ]);
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "function alpha() {\n  return 1;\n}\n\nfunction beta() {\n  return 2;\n}");
  });

  it("rejects exact file edits that would leave the file unchanged", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);
    await platform.writeFile(`${workspaceRoot}/app.ts`, "one two");

    const result = await invoke(coreToolIds.fileEdit, { path: "app.ts", expected: "two", replacement: "two", workspaceRoot }, { platform, workspaceState });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "EDIT_NOOP");
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "one two");
    assert.equal(workspaceState.records().length, 0);
    assert.equal(workspaceState.checkpoints().length, 0);
  });

  it("rejects exact Python file edits that would leave invalid syntax", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);
    const before = [
      "\"\"\"Module docstring.",
      "",
      "It steps through transforms.",
      "\"\"\"",
      "",
      "def ok():",
      "    return 1",
      ""
    ].join("\n");
    await platform.writeFile(`${workspaceRoot}/separable.py`, before);

    const result = await invoke(coreToolIds.fileEdit, {
      path: "separable.py",
      expected: "It steps through transforms.",
      replacement: "It st\n\"\"\"eps through transforms.",
      workspaceRoot
    }, { platform, workspaceState });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "PYTHON_SYNTAX_INVALID");
    assert.match(result.error?.message ?? "", /invalid Python syntax/i);
    assert.equal(await platform.readFile(`${workspaceRoot}/separable.py`), before);
    assert.equal(workspaceState.records().length, 0);
    assert.equal(workspaceState.checkpoints().length, 0);
  });

  it("copies, moves, and deletes workspace paths through semantic cross-platform tools", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    await platform.writeFile(`${workspaceRoot}/docs/source.txt`, "copy me");

    const copy = await invoke(coreToolIds.fileCopy, { sourcePath: "docs/source.txt", targetPath: "docs/copied.txt", workspaceRoot }, { platform });
    assert.equal(copy.ok, true);
    assert.equal(await platform.readFile(`${workspaceRoot}/docs/source.txt`), "copy me");
    assert.equal(await platform.readFile(`${workspaceRoot}/docs/copied.txt`), "copy me");
    assert.equal(copy.value?.evidence.metadata.operation, "copy");

    const move = await invoke(coreToolIds.fileMove, { sourcePath: "docs/copied.txt", targetPath: "archive/moved.txt", workspaceRoot }, { platform });
    assert.equal(move.ok, true);
    await assert.rejects(() => platform.readFile(`${workspaceRoot}/docs/copied.txt`));
    assert.equal(await platform.readFile(`${workspaceRoot}/archive/moved.txt`), "copy me");
    assert.equal(move.value?.evidence.metadata.operation, "move");

    const rejectedDelete = await invoke(coreToolIds.fileDelete, { path: "archive", workspaceRoot }, { platform });
    assert.equal(rejectedDelete.ok, false);
    assert.equal(rejectedDelete.error?.code, "FILE_DELETE_RECURSIVE_REQUIRED");

    const deletion = await invoke(coreToolIds.fileDelete, { path: "archive", recursive: true, workspaceRoot }, { platform });
    assert.equal(deletion.ok, true);
    await assert.rejects(() => platform.readFile(`${workspaceRoot}/archive/moved.txt`));
    assert.equal(deletion.value?.evidence.metadata.operation, "delete");
  });

  it("creates directories and touches files through semantic cross-platform tools", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);

    const directory = await invoke(coreToolIds.directoryCreate, { path: "docs/generated", workspaceRoot }, { platform });
    assert.equal(directory.ok, true);
    assert.equal(directory.value?.evidence.metadata.operation, "directory.create");

    const touch = await invoke(coreToolIds.fileTouch, { path: "docs/generated/empty.txt", workspaceRoot }, { platform });
    assert.equal(touch.ok, true);
    assert.equal(await platform.readFile(`${workspaceRoot}/docs/generated/empty.txt`), "");
    assert.equal(touch.value?.evidence.metadata.operation, "touch");
  });

  it("stats files and directories without shelling out to platform-specific commands", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    await platform.writeFile(`${workspaceRoot}/docs/generated/empty.txt`, "");

    const file = await invoke(coreToolIds.fileStat, { path: "docs/generated/empty.txt", workspaceRoot }, { platform });
    assert.equal(file.ok, true);
    assert.equal(file.value?.evidence.metadata.kind, "file");
    assert.equal(file.value?.evidence.metadata.sizeBytes, 0);

    const directory = await invoke(coreToolIds.fileStat, { path: "docs/generated", workspaceRoot }, { platform });
    assert.equal(directory.ok, true);
    assert.equal(directory.value?.evidence.metadata.kind, "directory");
  });

  it("reads and patches JSON through semantic structured tools", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);
    await platform.writeFile(`${workspaceRoot}/package.json`, JSON.stringify({
      name: "demo",
      scripts: { test: "node --test" },
      enabled: true
    }, null, 2));

    const read = await invoke(coreToolIds.jsonRead, { path: "package.json", pointer: "/scripts/test", workspaceRoot }, { platform });
    assert.equal(read.ok, true);
    assert.equal(read.value?.evidence.metadata.value, "node --test");
    assert.match(read.value?.evidence.preview?.text ?? "", /node --test/);

    const patch = await invoke(coreToolIds.jsonPatch, {
      path: "package.json",
      operations: [
        { op: "replace", path: "/scripts/test", value: "tsx --test" },
        { op: "add", path: "/scripts/typecheck", value: "tsc --noEmit" },
        { op: "remove", path: "/enabled" }
      ],
      workspaceRoot
    }, { platform, workspaceState });
    assert.equal(patch.ok, true);
    const updated = JSON.parse(await platform.readFile(`${workspaceRoot}/package.json`)) as { readonly scripts: Record<string, string>; readonly enabled?: boolean };
    assert.equal(updated.scripts.test, "tsx --test");
    assert.equal(updated.scripts.typecheck, "tsc --noEmit");
    assert.equal("enabled" in updated, false);
    assert.equal(workspaceState.records().length, 1);
    assert.equal(patch.value?.evidence.metadata.operationCount, 3);
  });

  it("hashes files and resolves paths without platform-specific shell commands", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    await platform.writeFile(`${workspaceRoot}/docs/hash.txt`, "hello");

    const hash = await invoke(coreToolIds.checksumHash, { path: "docs/hash.txt", algorithm: "sha256", workspaceRoot }, { platform });
    assert.equal(hash.ok, true);
    assert.equal(hash.value?.evidence.metadata.algorithm, "sha256");
    assert.equal(hash.value?.evidence.metadata.digest, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");

    const resolved = await invoke(coreToolIds.pathResolve, { path: "docs/../docs/hash.txt", workspaceRoot }, { platform });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.value?.evidence.metadata.relativePath, "docs/hash.txt");
    assert.equal(resolved.value?.evidence.metadata.safe, true);
  });

  it("inspects environment and command availability without platform-specific shell commands", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    platform.nextProcessResult = {
      exitCode: 0,
      stdout: "/usr/local/bin/node\n",
      stderr: "",
      metadata: fakeProviderMetadata()
    };

    const env = await invoke(coreToolIds.envInspect, {
      names: ["PATH", "DEEPSEEK_SECRET"],
      env: { PATH: "/workspace/.bin", DEEPSEEK_SECRET: "hidden" },
      revealValues: false,
      workspaceRoot
    }, { platform });
    assert.equal(env.ok, true);
    const variables = env.value?.evidence.metadata.variables as readonly { readonly name?: string; readonly present?: boolean; readonly value?: string }[] | undefined;
    assert.equal(variables?.some((variable) => variable.name === "PATH" && variable.present === true && variable.value === undefined), true);
    assert.equal(variables?.some((variable) => variable.name === "DEEPSEEK_SECRET" && variable.present === true && variable.value === undefined), true);

    const lookup = await invoke(coreToolIds.commandLookup, { command: "node", workspaceRoot }, { platform });
    assert.equal(lookup.ok, true);
    assert.equal(lookup.value?.evidence.metadata.command, "node");
    assert.equal(lookup.value?.evidence.metadata.available, true);
    assert.equal(platform.executedCommands.at(-1)?.command, "node");
  });

  it("creates and extracts workspace archives through governed semantic tools", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    await platform.writeFile(`${workspaceRoot}/docs/a.txt`, "alpha");
    await platform.writeFile(`${workspaceRoot}/docs/b.txt`, "beta");

    const created = await invoke(coreToolIds.archiveCreate, {
      format: "json",
      outputPath: "bundle.archive.json",
      entries: ["docs/a.txt", "docs/b.txt"],
      workspaceRoot
    }, { platform });
    assert.equal(created.ok, true);
    assert.equal(created.value?.evidence.metadata.entryCount, 2);

    const extracted = await invoke(coreToolIds.archiveExtract, {
      format: "json",
      archivePath: "bundle.archive.json",
      targetDirectory: "restored",
      workspaceRoot
    }, { platform });
    assert.equal(extracted.ok, true);
    assert.equal(await platform.readFile(`${workspaceRoot}/restored/docs/a.txt`), "alpha");
    assert.equal(await platform.readFile(`${workspaceRoot}/restored/docs/b.txt`), "beta");
    assert.equal(extracted.value?.evidence.metadata.entryCount, 2);
  });

  it("applies multi-hunk patches transactionally and reverts checkpoints safely", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);
    await platform.writeFile(`${workspaceRoot}/app.ts`, "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");

    const patch = [
      "--- a/app.ts",
      "+++ b/app.ts",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      "@@ -5,3 +5,3 @@",
      " five",
      "-six",
      "+SIX",
      " seven",
      ""
    ].join("\n");
    const applied = await invoke(coreToolIds.patchApply, { patch, workspaceRoot }, { platform, workspaceState });
    assert.equal(applied.ok, true);
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "one\nTWO\nthree\nfour\nfive\nSIX\nseven\n");
    assert.equal(workspaceState.checkpoints().length, 1);

    const preview = await invoke(coreToolIds.revertUndo, { path: "app.ts", workspaceRoot, dryRun: true }, { platform, workspaceState });
    assert.equal(preview.ok, true);
    assert.match(preview.value?.evidence.preview?.text ?? "", /checkpoint-/);

    const undone = await invoke(coreToolIds.revertUndo, { path: "app.ts", workspaceRoot }, { platform, workspaceState });
    assert.equal(undone.ok, true);
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  });

  it("applies patch hunks by unique context when declared line numbers drift", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);
    await platform.writeFile(`${workspaceRoot}/app.ts`, "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");

    const patch = [
      "--- a/app.ts",
      "+++ b/app.ts",
      "@@ -99,3 +99,3 @@",
      " five",
      "-six",
      "+SIX",
      " seven",
      ""
    ].join("\n");

    const applied = await invoke(coreToolIds.patchApply, { patch, workspaceRoot }, { platform, workspaceState });

    assert.equal(applied.ok, true);
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "one\ntwo\nthree\nfour\nfive\nSIX\nseven\n");
  });

  it("rejects context-only patches that leave target files unchanged", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);
    await platform.writeFile(`${workspaceRoot}/app.ts`, "alpha\nbeta\n");

    const patch = [
      "--- a/app.ts",
      "+++ b/app.ts",
      "@@ -1,2 +1,2 @@",
      " alpha",
      " beta",
      ""
    ].join("\n");

    const applied = await invoke(coreToolIds.patchApply, { patch, workspaceRoot }, { platform, workspaceState });

    assert.equal(applied.ok, false);
    assert.equal(applied.error?.code, "PATCH_NOOP");
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "alpha\nbeta\n");
    assert.equal(workspaceState.checkpoints().length, 0);
  });

  it("rejects patches that only change trailing whitespace", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);
    await platform.writeFile(`${workspaceRoot}/app.ts`, "alpha\nbeta\n");

    const patch = [
      "--- a/app.ts",
      "+++ b/app.ts",
      "@@ -1,2 +1,2 @@",
      "-alpha",
      "+alpha  ",
      " beta",
      ""
    ].join("\n");

    const applied = await invoke(coreToolIds.patchApply, { patch, workspaceRoot }, { platform, workspaceState });

    assert.equal(applied.ok, false);
    assert.equal(applied.error?.code, "PATCH_NOOP");
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "alpha\nbeta\n");
    assert.equal(workspaceState.checkpoints().length, 0);
  });

  it("allows Markdown patches that add trailing spaces for hard line breaks", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);
    await platform.writeFile(`${workspaceRoot}/README.md`, "alpha\nbeta\n");

    const patch = [
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,2 +1,2 @@",
      "-alpha",
      "+alpha  ",
      " beta",
      ""
    ].join("\n");

    const applied = await invoke(coreToolIds.patchApply, { patch, workspaceRoot }, { platform, workspaceState });

    assert.equal(applied.ok, true);
    assert.equal(await platform.readFile(`${workspaceRoot}/README.md`), "alpha  \nbeta\n");
    assert.equal(workspaceState.checkpoints().length, 1);
  });

  it("rejects failed patches without mutating target files and rejects stale undo", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);
    await platform.writeFile(`${workspaceRoot}/app.ts`, "alpha\nbeta\n");

    const malformed = await invoke(coreToolIds.patchApply, {
      patch: "@@ -1,1 +1,1 @@\n-alpha\n+ALPHA\n",
      workspaceRoot
    }, { platform, workspaceState });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error?.code, "PATCH_PARSE_FAILED");
    const malformedDetails = malformed.error?.details as JsonObject | undefined;
    assert.equal(malformedDetails?.operation, "unified-patch-parse");
    assert.match(String(malformedDetails?.requiredPatchShape), /--- a\/<workspace-relative-path>/);
    assert.match(String(malformedDetails?.receivedPatchPrefix), /@@ -1,1 \+1,1 @@/);
    assert.deepEqual(malformed.error?.suggestedActions, [
      "Retry patch.apply with a complete unified diff, including --- a/<workspace-relative-path> and +++ b/<workspace-relative-path> file headers.",
      "Include at least one @@ -oldStart,oldCount +newStart,newCount @@ hunk under each file header.",
      "For a single-file change, reuse the workspace-relative path from prior file evidence in both file headers."
    ]);
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "alpha\nbeta\n");

    const failed = await invoke(coreToolIds.patchApply, { patch: "--- a/app.ts\n+++ b/app.ts\n@@ -1,1 +1,1 @@\n-missing\n+changed\n", workspaceRoot }, { platform, workspaceState });
    assert.equal(failed.ok, false);
    assert.equal(failed.error?.code, "PATCH_PRECONDITION_FAILED");
    const failedDetails = failed.error?.details as JsonObject | undefined;
    assert.equal(typeof failedDetails?.nearestContext, "string");
    assert.match(String(failedDetails?.nearestContext), /alpha/);
    assert.match(String(failedDetails?.nearestContext), /beta/);
    assert.equal(failedDetails?.actualAtDeclaredLocation, "alpha");
    assert.deepEqual(failed.error?.suggestedActions, [
      "Use actualAtDeclaredLocation as the current source context at the declared hunk location; retry patch.apply with corrected context or use file.edit for a small exact change.",
      "Use nearestContext only if the intended target is elsewhere, and verify it against current source evidence before retrying."
    ]);
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "alpha\nbeta\n");

    const applied = await invoke(coreToolIds.patchApply, { patch: "--- a/app.ts\n+++ b/app.ts\n@@ -1,1 +1,1 @@\n-alpha\n+ALPHA\n", workspaceRoot }, { platform, workspaceState });
    assert.equal(applied.ok, true);
    await platform.writeFile(`${workspaceRoot}/app.ts`, "stale\n");
    const stale = await invoke(coreToolIds.revertUndo, { path: "app.ts", workspaceRoot }, { platform, workspaceState });
    assert.equal(stale.ok, false);
    assert.equal(stale.error?.code, "CHECKPOINT_STALE_FILE");
    assert.equal(await platform.readFile(`${workspaceRoot}/app.ts`), "stale\n");
  });

  it("rejects patches that would leave Python files with invalid syntax", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const workspaceState = new InMemoryWorkspaceStateManager(platform);
    const before = [
      "\"\"\"Module docstring.",
      "",
      "It steps through transforms.",
      "\"\"\"",
      "",
      "def ok():",
      "    return 1",
      ""
    ].join("\n");
    await platform.writeFile(`${workspaceRoot}/separable.py`, before);

    const patch = [
      "--- a/separable.py",
      "+++ b/separable.py",
      "@@ -3,1 +3,2 @@",
      "-It steps through transforms.",
      "+It st",
      "+\"\"\"eps through transforms.",
      ""
    ].join("\n");
    const result = await invoke(coreToolIds.patchApply, { patch, workspaceRoot }, { platform, workspaceState });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "PYTHON_SYNTAX_INVALID");
    assert.match(result.error?.message ?? "", /invalid Python syntax/i);
    assert.equal(await platform.readFile(`${workspaceRoot}/separable.py`), before);
    assert.equal(workspaceState.records().length, 0);
    assert.equal(workspaceState.checkpoints().length, 0);
  });

  it("rejects path escapes before reading or mutating", async () => {
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    await platform.writeFile(`${workspaceRoot}/safe.txt`, "safe");

    const read = await invoke(coreToolIds.fileRead, { path: "../secret.txt", workspaceRoot }, { platform });
    assert.equal(read.ok, false);
    assert.equal(read.error?.code, "PATH_REJECTED");

    const write = await invoke(coreToolIds.fileWrite, { path: "../secret.txt", content: "bad", workspaceRoot }, { platform });
    assert.equal(write.ok, false);
    await assert.rejects(() => platform.readFile("/secret.txt"));

    const malformedWrite = await invoke(coreToolIds.fileWrite, {
      value: [{ path: "docs/USAGE.md", content: "# Usage\n" }],
      workspaceRoot
    }, { platform });
    assert.equal(malformedWrite.ok, false);
    assert.equal(malformedWrite.error?.code, "FILE_WRITE_INPUT_INVALID");
    await assert.rejects(() => platform.readFile(`${workspaceRoot}/docs/USAGE.md`));
  });

  it("runs shell, git, test, and todo tools with structured evidence", async () => {
    const platform = new ShellCapableFakePlatform("fake", workspaceRoot);
    await platform.writeFile(`${workspaceRoot}/package.json`, JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }));

    const shell = await invoke(coreToolIds.shellRun, { command: "echo", args: ["ok"], workspaceRoot }, { platform });
    assert.equal(shell.ok, true);
    assert.equal(shell.value?.evidence.provider?.selectedProvider, "argv");

    const git = await invoke(coreToolIds.gitStatus, { workspaceRoot }, { platform });
    assert.equal(git.ok, true);
    assert.equal(git.value?.evidence.metadata.gitMode, "status");

    const diff = await invoke(coreToolIds.gitDiff, { workspaceRoot }, { platform });
    assert.equal(diff.ok, true);
    assert.equal(diff.value?.evidence.metadata.gitMode, "diff");

    const history = await invoke(coreToolIds.gitHistoryBranch, { workspaceRoot, checkoutBranch: "feature/x" }, { platform });
    assert.equal(history.ok, true);
    assert.equal((history.value?.evidence.metadata.checkoutPreview as { applied?: boolean } | undefined)?.applied, false);

    const test = await invoke(coreToolIds.testRun, { command: "npm", args: ["test"], workspaceRoot, intent: "unit" }, { platform });
    assert.equal(test.ok, true);
    assert.equal(test.value?.evidence.metadata.intent, "unit");

    const absoluteWorkspaceTest = await invoke(coreToolIds.testRun, { command: "npm", args: ["test"], cwd: workspaceRoot, workspaceRoot, intent: "unit" }, { platform });
    assert.equal(absoluteWorkspaceTest.ok, true);
    assert.equal(platform.executedCommands.at(-1)?.cwd, workspaceRoot);

    const outsideWorkspaceTest = await invoke(coreToolIds.testRun, { command: "npm", args: ["test"], cwd: "/tmp/outside", workspaceRoot }, { platform });
    assert.equal(outsideWorkspaceTest.ok, false);
    assert.equal(outsideWorkspaceTest.error?.code, "PATH_REJECTED");

    const scripts = await invoke(coreToolIds.packageManager, { operation: "scripts", workspaceRoot }, { platform });
    assert.equal(scripts.ok, true);
    assert.equal(scripts.value?.evidence.metadata.scriptCount, 2);

    const install = await invoke(coreToolIds.packageManager, { operation: "install", packages: ["left-pad"], manager: "pnpm", workspaceRoot }, { platform });
    assert.equal(install.ok, true);
    assert.equal(install.value?.evidence.metadata.dryRun, true);

    const repl = await invoke(coreToolIds.replExecute, { code: "const a = 2; a + 3", workspaceRoot }, { platform });
    assert.equal(repl.ok, true);
    assert.match(repl.value?.evidence.preview?.text ?? "", /=> 5/);

    const plan = await invoke(coreToolIds.todoPlan, { items: [{ id: "1", title: "ship", status: "completed" }] }, { platform });
    assert.equal(plan.ok, true);
    assert.equal(plan.value?.evidence.metadata.count, 1);

    const repairedPlan = await invoke(coreToolIds.todoPlan, { items: [{ description: "write html", done: false }] }, { platform });
    assert.equal(repairedPlan.ok, true);
    assert.match(repairedPlan.value?.evidence.preview?.text ?? "", /pending: write html/);
  });

  it("reports platform-unavailable process diagnostics", async () => {
    const platform = new FakePlatformRuntime("linux", workspaceRoot, { environmentKind: "remote", noLocalShell: true });
    const result = await invoke(coreToolIds.shellRun, { command: "echo", args: ["ok"], workspaceRoot }, { platform });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "PROCESS_UNAVAILABLE");
  });
});

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
