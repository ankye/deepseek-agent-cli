import type { RuntimeDependencies, RuntimeKernel } from "@deepseek/platform-contracts";
import {
  CredentialAuthModelCredentialProvider,
  createDeepSeekCredentialAuthServiceFromEnv,
  deepSeekLiveCredentialProcessEnv,
  glmAnthropicLiveCredentialProcessEnv
} from "@deepseek/credential-auth-management";
import { FetchModelProviderTransport, GlmAnthropicProvider, OpenAIModelProviderTransport, StaticCredentialProvider, glmAnthropicCredentialRef } from "@deepseek/model-gateway";
import { DurablePermanentMemoryProvider, FilesystemPermanentMemoryStorageAdapter, PersistentJsonlLosslessContextManager } from "@deepseek/memory-cache-management";
import { NodePlatformRuntime } from "@deepseek/platform-abstraction";
import { createDefaultRuntimeKernel, loadUserHooks, registerRuntimeCoreTools } from "@deepseek/runtime";
import { PersistentFilesystemSessionStore, userSessionsDirectory } from "@deepseek/session-store";
import { createDeterministicRuntimeDependencies, createLiveCliDependencies } from "@deepseek/testing-regression";
import type { CliRunOptions, CliRuntimeFactoryOptions } from "../types.js";
import { registerCliEnvironmentCapabilities } from "./environment-capabilities.js";
import { registerCliSweBenchRunCapabilities } from "./swe-bench-run-capabilities.js";

export { registerCliEnvironmentCapabilities } from "./environment-capabilities.js";
export { registerCliSweBenchRunCapabilities } from "./swe-bench-run-capabilities.js";

export async function createCliAgentRuntime(options: CliRuntimeFactoryOptions, runOptions: CliRunOptions): Promise<{ readonly deps: RuntimeDependencies; readonly kernel: RuntimeKernel }> {
  if (runOptions.createRuntime) return runOptions.createRuntime(options);
  const platform = new NodePlatformRuntime();
  const liveCredentialEnv = options.live && options.modelProvider !== "glm" ? await deepSeekLiveCredentialProcessEnv(platform, options.workspaceRoot) : undefined;
  const deps: RuntimeDependencies = options.live
    ? await createLiveRuntimeDependencies(options, platform, liveCredentialEnv)
    : createCliSessionDependenciesBase(platform);
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
  deepSeekEnv: Awaited<ReturnType<typeof deepSeekLiveCredentialProcessEnv>> | undefined
): Promise<RuntimeDependencies> {
  const allowWorkspaceWrites = options.toolProjection === "read-write" || options.toolProjection === "all";
  const allowWorkspaceProcesses = options.toolProjection === "all";
  if (options.modelProvider === "glm") {
    const glmEnv = await glmAnthropicLiveCredentialProcessEnv(platform, options.workspaceRoot);
    const token = firstNonEmpty(glmEnv.GLM_ANTHROPIC_API_KEY, glmEnv.ZHIPU_API_KEY);
    return withCliPermanentMemory({
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
  }
  return withCliPermanentMemory(createLiveCliDependencies({
    workspaceRoot: options.workspaceRoot,
    credentials: new CredentialAuthModelCredentialProvider(await createDeepSeekCredentialAuthServiceFromEnv(deepSeekEnv)),
    transport: new OpenAIModelProviderTransport(),
    timeoutMs: 90_000,
    allowWorkspaceWrites,
    allowWorkspaceProcesses
  }));
}

export async function resolveSessionDependencies(runOptions: CliRunOptions, workspaceRoot = process.cwd()): Promise<RuntimeDependencies> {
  if (runOptions.createRuntime) {
    const runtime = await runOptions.createRuntime({ live: false, workspaceRoot });
    return runtime.deps;
  }
  return createCliSessionDependencies(workspaceRoot);
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
