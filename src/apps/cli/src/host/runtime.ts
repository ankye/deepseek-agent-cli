import type { RuntimeDependencies, RuntimeKernel } from "@deepseek/platform-contracts";
import {
  CredentialAuthModelCredentialProvider,
  createDeepSeekCredentialAuthServiceFromEnv,
  deepSeekLiveCredentialResolution,
  glmAnthropicLiveCredentialResolution
} from "@deepseek/credential-auth-management";
import { FetchModelProviderTransport, GlmAnthropicProvider, OpenAIModelProviderTransport, StaticCredentialProvider, glmAnthropicCredentialRef } from "@deepseek/model-gateway";
import { DurablePermanentMemoryProvider, FilesystemPermanentMemoryStorageAdapter, PersistentJsonlLosslessContextManager } from "@deepseek/memory-cache-management";
import { NodePlatformRuntime } from "@deepseek/platform-abstraction";
import { HeadlessApprovalBroker } from "@deepseek/policy-sandbox";
import { createDefaultRuntimeKernel, loadUserHooks, registerRuntimeCoreTools } from "@deepseek/runtime";
import { PersistentFilesystemSessionStore, userSessionsDirectory } from "@deepseek/session-store";
import { createDeterministicRuntimeDependencies, createLiveCliDependencies } from "@deepseek/testing-regression";
import type { CliRunOptions, CliRuntimeFactoryOptions } from "../types.js";
import { registerCliEnvironmentCapabilities } from "./environment-capabilities.js";
import { registerCliSweBenchRunCapabilities } from "./swe-bench-run-capabilities.js";
import { resolveCliWorkspaceRoot } from "./workspace-root.js";

export { registerCliEnvironmentCapabilities } from "./environment-capabilities.js";
export { registerCliSweBenchRunCapabilities } from "./swe-bench-run-capabilities.js";

export async function createCliAgentRuntime(options: CliRuntimeFactoryOptions, runOptions: CliRunOptions): Promise<{ readonly deps: RuntimeDependencies; readonly kernel: RuntimeKernel }> {
  if (runOptions.createRuntime) return runOptions.createRuntime(options);
  const platform = new NodePlatformRuntime();
  const liveCredential = options.live && options.modelProvider !== "glm" ? await deepSeekLiveCredentialResolution(platform, options.workspaceRoot) : undefined;
  const baseDeps: RuntimeDependencies = options.live
    ? await createLiveRuntimeDependencies(options, platform, liveCredential)
    : createCliSessionDependenciesBase(platform);
  const deps = applyCliApprovalMode(baseDeps, options);
  await loadUserHooks(options.workspaceRoot, deps, platform).catch((error: unknown) => {
    console.warn(`deepseek: user hook loading failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  await registerRuntimeCoreTools(deps, options.workspaceRoot);
  await registerCliEnvironmentCapabilities(deps, options.workspaceRoot);
  await registerCliSweBenchRunCapabilities(deps, options.workspaceRoot);
  return { deps, kernel: await createDefaultRuntimeKernel(deps) };
}

async function createLiveRuntimeDependencies(
  options: CliRuntimeFactoryOptions,
  platform: NodePlatformRuntime,
  deepSeekCredential: Awaited<ReturnType<typeof deepSeekLiveCredentialResolution>> | undefined
): Promise<RuntimeDependencies> {
  const allowWorkspaceWrites = options.toolProjection === "read-write" || options.toolProjection === "safe-all" || options.toolProjection === "all";
  const allowWorkspaceProcesses = options.toolProjection === "read-write" || options.toolProjection === "safe-all" || options.toolProjection === "all";
  if (options.modelProvider === "glm") {
    const glmCredential = await glmAnthropicLiveCredentialResolution(platform, options.workspaceRoot);
    const glmEnv = glmCredential.env;
    const token = firstNonEmpty(glmEnv.GLM_ANTHROPIC_API_KEY, glmEnv.ZHIPU_API_KEY);
    const deps = withCliPermanentMemory({
      ...createLiveCliDependencies({
        workspaceRoot: options.workspaceRoot,
        timeoutMs: 90_000,
        allowWorkspaceWrites,
        allowWorkspaceProcesses
      }),
      models: new GlmAnthropicProvider({
        transport: new FetchModelProviderTransport(),
        timeoutMs: 90_000,
        ...(token ? { credentials: new StaticCredentialProvider(token, glmAnthropicCredentialRef) } : {})
      })
    });
    await recordCredentialResolution(deps, glmCredential.summary);
    return deps;
  }
  const credential = deepSeekCredential ?? await deepSeekLiveCredentialResolution(platform, options.workspaceRoot);
  const deps = withCliPermanentMemory(createLiveCliDependencies({
    workspaceRoot: options.workspaceRoot,
    credentials: new CredentialAuthModelCredentialProvider(await createDeepSeekCredentialAuthServiceFromEnv(credential.env)),
    transport: new OpenAIModelProviderTransport(),
    timeoutMs: 90_000,
    allowWorkspaceWrites,
    allowWorkspaceProcesses
  }));
  await recordCredentialResolution(deps, credential.summary);
  return deps;
}

async function recordCredentialResolution(
  deps: RuntimeDependencies,
  summary: Awaited<ReturnType<typeof deepSeekLiveCredentialResolution>>["summary"]
): Promise<void> {
  await deps.observability.emit({
    kind: "audit",
    at: new Date(0).toISOString(),
    name: "credential.resolution",
    fields: { ...summary },
    dataPrivacyClass: "secret",
    redaction: { class: "secret", fields: ["fields.env"] },
    persistence: { scope: "local-diagnostics", retainLocal: true, allowExport: false }
  });
}

export async function resolveSessionDependencies(runOptions: CliRunOptions, workspaceRoot?: string): Promise<RuntimeDependencies> {
  const resolvedWorkspaceRoot = workspaceRoot ?? await resolveCliWorkspaceRoot(runOptions);
  if (runOptions.createRuntime) {
    const runtime = await runOptions.createRuntime({ live: false, workspaceRoot: resolvedWorkspaceRoot });
    return runtime.deps;
  }
  return createCliSessionDependencies(resolvedWorkspaceRoot);
}

async function createCliSessionDependencies(workspaceRoot = process.cwd()): Promise<RuntimeDependencies> {
  const deps = createCliSessionDependenciesBase();
  await registerRuntimeCoreTools(deps, workspaceRoot);
  await registerCliEnvironmentCapabilities(deps, workspaceRoot);
  await registerCliSweBenchRunCapabilities(deps, workspaceRoot);
  return deps;
}

function createCliSessionDependenciesBase(platform = new NodePlatformRuntime()): RuntimeDependencies {
  const deps = createDeterministicRuntimeDependencies({ platform });
  const persistentSessionsDirectory = userSessionsDirectory();
  const persistentLosslessContextDirectory = platform.resolvePath(platform.userConfigPath("deepseek"), "..", "lossless-context");
  const losslessContext = new PersistentJsonlLosslessContextManager(platform, persistentLosslessContextDirectory);
  const permanentMemory = createPersistentPermanentMemoryProvider();
  try {
    const persistentSessions = new PersistentFilesystemSessionStore(persistentSessionsDirectory);
    return { ...deps, sessions: persistentSessions, losslessContext, memory: permanentMemory };
  } catch (error) {
    console.warn(`deepseek: falling back to in-memory sessions because ${persistentSessionsDirectory} could not be initialized:`, error instanceof Error ? error.message : String(error));
    return { ...deps, losslessContext, memory: permanentMemory };
  }
}

function withCliPermanentMemory(deps: RuntimeDependencies): RuntimeDependencies {
  return { ...deps, memory: createPersistentPermanentMemoryProvider() };
}

function applyCliApprovalMode(deps: RuntimeDependencies, options: CliRuntimeFactoryOptions): RuntimeDependencies {
  if (options.approvalMode !== "trusted") return deps;
  return {
    ...deps,
    approvals: new HeadlessApprovalBroker({
      defaultApproved: true,
      defaultSource: "automation"
    })
  };
}

function createPersistentPermanentMemoryProvider(): DurablePermanentMemoryProvider {
  const platform = new NodePlatformRuntime();
  const path = platform.resolvePath(platform.userConfigPath("deepseek"), "..", "permanent-memory", "memory.json");
  return new DurablePermanentMemoryProvider({
    adapter: new FilesystemPermanentMemoryStorageAdapter(platform, path),
    providerId: "permanent-memory.cli-json"
  });
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}
