import type { BackgroundTaskManager, BackgroundTaskOutput, BackgroundTaskSummary, ModelCredentialProvider, ModelProviderTransport, PlatformRuntime, PolicyDecision, PolicyEngine, PolicyRequest, RuntimeDependencies } from "@deepseek/platform-contracts";
import { InMemoryAgentManager } from "@deepseek/agent-management";
import { InMemoryCapabilityRegistry } from "@deepseek/capability-registry";
import { DeterministicCodeIntelligenceService } from "@deepseek/code-intelligence";
import { InMemoryCommandSystem } from "@deepseek/command-system";
import { PipelineProtocolRouter } from "@deepseek/communication-protocol";
import { DeterministicScheduler } from "@deepseek/concurrency-orchestration";
import { InMemoryConfigStore } from "@deepseek/config";
import { registerCoreCodingToolsForRuntime } from "@deepseek/core-coding-tools";
import { InMemoryContextEngine } from "@deepseek/context-engine";
import { FakeCredentialManager } from "@deepseek/credential-auth-management";
import { DeepSeekOpenAIProvider } from "@deepseek/model-gateway";
import {
  FakePlatformRuntime,
  InMemoryEvolutionEngine,
  InMemoryExtensionManager,
  InMemoryPluginManager,
  NodeBackgroundTaskManager,
  NodePlatformRuntime,
  NoopRemoteRuntimeConnectivity,
  StaticDistributionUpdateManager
} from "@deepseek/platform-abstraction";
import { InMemoryHookSystem } from "@deepseek/hook-system";
import { FakeMcpGateway } from "@deepseek/mcp-gateway";
import { InMemoryCacheManager, InMemoryMemoryManager, PersistentJsonlLosslessContextManager } from "@deepseek/memory-cache-management";
import { DeterministicMockModelGateway } from "@deepseek/model-gateway";
import { DeterministicToolIntentPreflight } from "@deepseek/tool-intent-preflight";
import { InMemoryObservabilitySink } from "@deepseek/observability";
import { DefaultPolicyEngine, DevelopmentSandboxRuntime, HeadlessApprovalBroker, selectSandboxDecision } from "@deepseek/policy-sandbox";
import { createDefaultPromptAssembler } from "@deepseek/prompt-assembly";
import { InMemoryRuntimeMessageBus } from "@deepseek/runtime-message-bus";
import { InMemorySessionStore, PersistentFilesystemSessionStore, userSessionsDirectory } from "@deepseek/session-store";
import { InMemorySkillSystem } from "@deepseek/skill-system";
import { InMemoryUsageBudgetManager } from "@deepseek/usage-budget-management";
import { SingleTurnWorkflowOrchestrator } from "@deepseek/workflow-orchestration";
import { InMemoryWorkspaceStateManager } from "@deepseek/workspace-state-management";
import { DeterministicRegressionHarness } from "../harness/index.js";
export * from "./extension-auth.js";

export class FakeBackgroundTaskManager implements BackgroundTaskManager {
  private readonly tasks = new Map<string, { summary: BackgroundTaskSummary; stdout: string; stderr: string; status: BackgroundTaskSummary["status"]; exitCode?: number; done: boolean }>();
  private counter = 0;
  injectedStdout = "";
  injectedStderr = "";
  injectedExitCode = 0;

  async start(input: { readonly command: string; readonly args: readonly string[]; readonly cwd: string }): Promise<BackgroundTaskSummary> {
    this.counter += 1;
    const taskId = `fake-bg-${this.counter}`;
    const summary: BackgroundTaskSummary = {
      taskId,
      command: input.command,
      args: [...input.args],
      cwd: input.cwd,
      startedAt: new Date(0).toISOString(),
      status: "exited",
      exitCode: this.injectedExitCode,
      done: true
    };
    this.tasks.set(taskId, {
      summary,
      stdout: this.injectedStdout,
      stderr: this.injectedStderr,
      status: "exited",
      exitCode: this.injectedExitCode,
      done: true
    });
    return summary;
  }

  async output(input: { readonly taskId: string; readonly stdoutOffset?: number; readonly stderrOffset?: number }): Promise<BackgroundTaskOutput> {
    const entry = this.tasks.get(input.taskId);
    if (!entry) throw new Error(`FAKE_BACKGROUND_TASK_NOT_FOUND: ${input.taskId}`);
    const stdoutOffset = Math.max(0, input.stdoutOffset ?? 0);
    const stderrOffset = Math.max(0, input.stderrOffset ?? 0);
    return {
      taskId: input.taskId,
      stdout: entry.stdout.slice(stdoutOffset),
      stderr: entry.stderr.slice(stderrOffset),
      stdoutOffset: entry.stdout.length,
      stderrOffset: entry.stderr.length,
      done: entry.done,
      ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
      status: entry.status
    };
  }

  async kill(input: { readonly taskId: string }): Promise<BackgroundTaskSummary> {
    const entry = this.tasks.get(input.taskId);
    if (!entry) throw new Error(`FAKE_BACKGROUND_TASK_NOT_FOUND: ${input.taskId}`);
    entry.status = "killed";
    entry.done = true;
    return { ...entry.summary, status: "killed", done: true };
  }

  async list(): Promise<readonly BackgroundTaskSummary[]> {
    return [...this.tasks.values()].map((entry) => entry.summary);
  }

  async disposeAll(): Promise<void> {
    this.tasks.clear();
  }
}

export interface DeterministicRuntimeDependencyOptions {
  readonly platform?: PlatformRuntime;
}

export function createDeterministicRuntimeDependencies(options: DeterministicRuntimeDependencyOptions = {}): RuntimeDependencies {
  const runtimePlaceholder = async () => ({
    envelope: {} as never,
    ok: false,
    error: {
      code: "ROUTER_NOT_BOUND",
      message: "Protocol router is not bound to runtime in deterministic dependencies",
      retryable: false,
      redaction: { class: "public" as const }
    }
  });

  const platform = options.platform ?? new FakePlatformRuntime();
  const cache = new InMemoryCacheManager();
  const codeIntelligence = new DeterministicCodeIntelligenceService(platform);
  const dependencies: RuntimeDependencies = {
    protocol: new PipelineProtocolRouter([], runtimePlaceholder),
    bus: new InMemoryRuntimeMessageBus(),
    workflow: new SingleTurnWorkflowOrchestrator(),
    concurrency: new DeterministicScheduler(),
    agents: new InMemoryAgentManager(),
    models: new DeterministicMockModelGateway(),
    toolIntentPreflight: new DeterministicToolIntentPreflight(),
    capabilities: new InMemoryCapabilityRegistry(),
    commands: new InMemoryCommandSystem(),
    skills: new InMemorySkillSystem(),
    hooks: new InMemoryHookSystem(),
    mcp: new FakeMcpGateway(),
    plugins: new InMemoryPluginManager(),
    extensions: new InMemoryExtensionManager(),
    context: new InMemoryContextEngine({ cache, codeIntelligence }),
    memory: new InMemoryMemoryManager(),
    cache,
    credentials: new FakeCredentialManager(),
    usage: new InMemoryUsageBudgetManager(),
    workspaceState: new InMemoryWorkspaceStateManager(platform),
    policy: new DefaultPolicyEngine(),
    approvals: new HeadlessApprovalBroker(false),
    sandbox: new DevelopmentSandboxRuntime(),
    sessions: new InMemorySessionStore(),
    platform,
    evolution: new InMemoryEvolutionEngine(),
    codeIntelligence,
    remote: new NoopRemoteRuntimeConnectivity(),
    distribution: new StaticDistributionUpdateManager(),
    config: new InMemoryConfigStore(),
    observability: new InMemoryObservabilitySink(),
    regression: new DeterministicRegressionHarness(),
    promptAssembler: createDefaultPromptAssembler(),
    backgroundTasks: new FakeBackgroundTaskManager()
  };
  return dependencies;
}

export async function registerDeterministicCoreTools(deps: RuntimeDependencies, workspaceRoot = "/workspace"): Promise<void> {
  await registerCoreCodingToolsForRuntime(deps, workspaceRoot);
}

export interface LiveCliDependencyOptions {
  readonly workspaceRoot?: string;
  readonly credentials?: ModelCredentialProvider;
  readonly transport?: ModelProviderTransport;
  readonly timeoutMs?: number;
  readonly sessionsDirectory?: string;
  readonly allowWorkspaceWrites?: boolean;
  readonly allowWorkspaceProcesses?: boolean;
}

export function createLiveCliDependencies(options: LiveCliDependencyOptions = {}): RuntimeDependencies {
  const platform = new NodePlatformRuntime();
  const base = createDeterministicRuntimeDependencies({ platform });
  const modelOptions = {
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
    timeoutMs: options.timeoutMs ?? 90_000
  };
  const sessionsDir = options.sessionsDirectory ?? userSessionsDirectory();
  const losslessContextDir = platform.resolvePath(platform.userConfigPath("deepseek"), "..", "lossless-context");
  const sessions = (() => {
    try {
      return new PersistentFilesystemSessionStore(sessionsDir);
    } catch (error) {
      console.warn(`deepseek: falling back to in-memory sessions because ${sessionsDir} could not be initialized:`, error instanceof Error ? error.message : String(error));
      return new InMemorySessionStore();
    }
  })();
  return {
    ...base,
    platform,
    losslessContext: new PersistentJsonlLosslessContextManager(platform, losslessContextDir),
    models: new DeepSeekOpenAIProvider(modelOptions),
    policy: options.allowWorkspaceWrites || options.allowWorkspaceProcesses ? new WorkspaceWritePolicyEngine({ allowWorkspaceProcesses: options.allowWorkspaceProcesses === true }) : base.policy,
    sessions,
    backgroundTasks: new NodeBackgroundTaskManager()
  };
}

class WorkspaceWritePolicyEngine implements PolicyEngine {
  private readonly fallback = new DefaultPolicyEngine();

  constructor(private readonly options: { readonly allowWorkspaceProcesses: boolean }) {}

  async decide(request: PolicyRequest): Promise<PolicyDecision> {
    if (request.metadata.sideEffect === "write" && request.resourceScope?.kind === "filesystem") {
      const sandbox = selectSandboxDecision(request);
      if (sandbox.action !== "allow") return this.fallback.decide(request);
      return {
        action: "allow",
        reason: "Live CLI policy allows workspace-scoped file writes.",
        audit: request.auditEvidence ?? { policy: "live-cli-workspace-write" },
        sandboxProfile: sandbox.profile,
        sandbox: { ...sandbox, reasonCodes: [...sandbox.reasonCodes, "policy.live-cli.workspace-write.allow"] },
        ...(request.secret ? { secret: request.secret } : {}),
        ...(request.auditEvidence ? { auditEvidence: request.auditEvidence } : {})
      };
    }
    if (this.options.allowWorkspaceProcesses && request.metadata.sideEffect === "process" && request.resourceScope?.kind === "process") {
      const sandbox = selectSandboxDecision(request);
      if (sandbox.action !== "allow") return this.fallback.decide(request);
      return {
        action: "allow",
        reason: "Live CLI policy allows workspace-scoped process execution.",
        audit: request.auditEvidence ?? { policy: "live-cli-workspace-process" },
        sandboxProfile: sandbox.profile,
        sandbox: { ...sandbox, reasonCodes: [...sandbox.reasonCodes, "policy.live-cli.workspace-process.allow"] },
        ...(request.secret ? { secret: request.secret } : {}),
        ...(request.auditEvidence ? { auditEvidence: request.auditEvidence } : {})
      };
    }
    return this.fallback.decide(request);
  }
}
