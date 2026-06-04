import type {
  IndexProviderActivationEvidence,
  IndexProviderActivationEvidenceKind,
  IndexProviderActivationEvidenceStatus,
  IndexProviderManifest,
  IndexProviderManifestEntry,
  IndexProviderStatus,
  JsonObject,
  ModelLiveVerificationResult,
  ModelProfile,
  ReadinessCommandResult
} from "@deepseek/platform-contracts";
import { INDEX_PROVIDER_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import { invokeLocalReadinessCommand } from "@deepseek/command-system";
import type { LocalReadinessEnvironment } from "@deepseek/command-system";
import { PersistentConfigService } from "@deepseek/config";
import {
  createDeepSeekCredentialAuthServiceFromEnv,
  createDeepSeekCredentialPresenceEnv,
  CredentialAuthModelCredentialProvider,
  deepSeekLiveCredentialProcessEnv,
  glmAnthropicLiveCredentialProcessEnv
} from "@deepseek/credential-auth-management";
import { resolveIndexProviderDiagnostics } from "@deepseek/index-provider";
import { DeepSeekOpenAIProvider, DeterministicMockModelGateway, FetchModelProviderTransport, GlmAnthropicProvider, OpenAIModelProviderTransport, StaticCredentialProvider, defaultDeepSeekProfile, defaultGlmAnthropicProfile, glmAnthropicCredentialRef } from "@deepseek/model-gateway";
import { NodePlatformRuntime } from "@deepseek/platform-abstraction";
import type { CliOptions } from "../types.js";
import { collectReleaseReadinessEvidence } from "../diagnostics/release-evidence.js";
import { resolveCliModelProfile } from "../host/model-selection.js";

export function renderReadinessText(result: ReadinessCommandResult): readonly string[] {
  const lines = [`${result.command}: ${result.status}`];
  for (const check of result.checks) {
    lines.push(`- ${check.id}: ${check.status} - ${check.message}`);
  }
  for (const action of result.suggestedActions) {
    lines.push(`next: ${action}`);
  }
  return lines;
}

export async function runReadinessCommand(options: CliOptions, write: (line: string) => Promise<void>): Promise<void> {
  if (!options.readinessCommand) return;
  const environment = await createCliReadinessEnvironment(options);
  const result = await invokeLocalReadinessCommand(options.readinessCommand, options.readinessInput ?? {}, environment);
  if (!result.ok || !result.value) {
    await write(options.output === "text" ? `[readiness failed] ${result.error?.message ?? options.readinessCommand}` : JSON.stringify(result));
    return;
  }
  if (options.output !== "text") {
    await write(JSON.stringify(result.value));
    return;
  }
  for (const line of renderReadinessText(result.value)) await write(line);
}

export async function createCliReadinessEnvironment(options: CliOptions): Promise<LocalReadinessEnvironment> {
  const platform = new NodePlatformRuntime();
  const workspaceRoot = process.cwd();
  const config = new PersistentConfigService({
    platform,
    workspaceRoot,
    defaults: {
      model: defaultDeepSeekProfile.model,
      profile: "default",
      telemetry: "disabled",
      privacy: "local",
      output: "text",
      sandbox: "ask"
    }
  });
  const deepSeekCredentialEnv = await deepSeekLiveCredentialProcessEnv(platform, workspaceRoot);
  const glmCredentialEnv = await glmAnthropicLiveCredentialProcessEnv(platform, workspaceRoot);
  const credentialAuth = await createDeepSeekCredentialAuthServiceFromEnv(deepSeekCredentialEnv);
  const selectedProfile = resolveCliModelProfile(options);
  const selectedProvider = selectedProviderName(options, selectedProfile.providerId);
  const selectedProviderMetadata = {
    provider: selectedProvider,
    protocol: selectedProvider === "glm" ? "anthropic-messages" as const : "openai-chat-completions" as const,
    model: selectedProfile.model,
    label: selectedProvider === "glm" ? "GLM" : "DeepSeek"
  };
  const existingWorkspaceDocument = await config.document("workspace");
  let initializedThisRun = false;
  if (options.readinessCommand === "init" && (!existingWorkspaceDocument || options.readinessInput?.force === true)) {
    await config.set({ scope: "workspace", key: "model", value: defaultDeepSeekProfile.model });
    await config.set({ scope: "workspace", key: "profile", value: "default" });
    await config.set({ scope: "workspace", key: "telemetry", value: "disabled" });
    await config.set({ scope: "workspace", key: "privacy", value: "local" });
    await config.set({ scope: "workspace", key: "output", value: "text" });
    await config.set({ scope: "workspace", key: "sandbox", value: "ask" });
    initializedThisRun = true;
  }
  if (options.readinessCommand === "config" && typeof options.readinessInput?.setKey === "string") {
    await config.set({
      scope: options.readinessInput.scope === "user" ? "user" : "workspace",
      key: options.readinessInput.setKey,
      value: options.readinessInput.setValue ?? ""
    });
  }
  if (options.readinessCommand === "auth" && options.readinessInput?.logout === true) {
    await credentialAuth.deleteDeepSeekCredential();
  }

  const resolvedConfig = await config.resolve();
  const release = await collectReleaseReadinessEvidence();
  const workspaceDocument = await config.document("workspace");
  const credentials = await credentialAuth.listDeepSeekCredentials();
  const workspaceMetadata = platform.workspaceMetadataPath(workspaceRoot, "deepseek");
  const platformDescriptor = await platform.descriptor();
  const liveVerifier = options.readinessInput?.live === true
    ? async () => {
        const glmToken = firstNonEmpty(glmCredentialEnv.GLM_ANTHROPIC_API_KEY, glmCredentialEnv.ZHIPU_API_KEY);
        const gateway = selectedProvider === "glm"
          ? new GlmAnthropicProvider({
              ...(options.readinessInput?.fakeLive === true ? {} : { transport: new FetchModelProviderTransport() }),
              timeoutMs: 90000,
              ...(glmToken
                ? { credentials: new StaticCredentialProvider(glmToken, glmAnthropicCredentialRef) }
                : {})
            })
          : options.readinessInput?.fakeLive === true
            ? new DeterministicMockModelGateway()
            : new DeepSeekOpenAIProvider({
                credentials: new CredentialAuthModelCredentialProvider(credentialAuth),
                transport: new OpenAIModelProviderTransport(),
                timeoutMs: 90000
              });
        return gateway.verify
          ? gateway.verify({ profile: selectedProfile, prompt: "Reply with exactly this text: ok", timeoutMs: 90000 })
          : missingLiveVerifierResult(selectedProfile);
      }
    : undefined;

  return {
    cwd: workspaceRoot,
    nodeVersion: process.version,
    platform: `${platformDescriptor.os}:${platformDescriptor.environmentKind}`,
    packageName: "deepseek-agent-cli",
    packageVersion: "0.1.3",
    env: {
      ...createDeepSeekCredentialPresenceEnv(deepSeekCredentialEnv),
      ...createGlmCredentialPresenceEnv(glmCredentialEnv)
    },
    ignoredPaths: [".env", ".env.*", "参考/"],
    availableCommands: ["node", "npm"],
    platformDescriptor,
    config: Object.fromEntries(resolvedConfig.values.map((value) => [value.key, value.redactedValue])),
    resolvedConfig,
    releasePackageSurface: release.packageSurface,
    releaseVerification: release.verification,
    supportBundlePolicy: release.supportBundle,
    indexProviderDiagnostics: resolveIndexProviderDiagnostics(indexProviderManifestFromConfig(resolvedConfig.values.find((value) => value.key === "indexProviders")?.redactedValue)),
    credentialReferences: credentials,
    modelProvider: selectedProviderMetadata,
    ...(liveVerifier ? { liveVerifier } : {}),
    ...(workspaceMetadata.ok && workspaceMetadata.value ? { workspaceMetadataPath: workspaceMetadata.value } : {}),
    initialized: Boolean(existingWorkspaceDocument),
    initializedThisRun: initializedThisRun && Boolean(workspaceDocument)
  };
}

function indexProviderManifestFromConfig(value: unknown): IndexProviderManifest | undefined {
  if (!isJsonObject(value)) return undefined;
  const providers = Array.isArray(value.providers) ? value.providers.filter(isJsonObject) : [];
  const defaultProviderId = typeof value.defaultProviderId === "string" ? value.defaultProviderId : undefined;
  return {
    schemaVersion: typeof value.schemaVersion === "string" ? value.schemaVersion : INDEX_PROVIDER_SCHEMA_VERSION,
    kind: "index-provider.manifest",
    ...(defaultProviderId ? { defaultProviderId } : {}),
    source: {
      scope: value.scope === "user" || value.scope === "profile" || value.scope === "runtime" ? value.scope : "workspace",
      sourceId: typeof value.sourceId === "string" ? value.sourceId : "config.indexProviders",
      description: "Resolved CLI config indexProviders value.",
      redaction: { class: "internal", fields: ["sourceId", "description"] }
    },
    providers: providers.map(indexProviderManifestEntryFromConfig),
    metadata: isJsonObject(value.metadata) ? value.metadata : {},
    redaction: { class: "internal", fields: ["providers.metadata", "providers.activationEvidence.metadata", "source"] }
  };
}

function indexProviderManifestEntryFromConfig(provider: JsonObject): IndexProviderManifestEntry {
  const status = indexProviderStatus(provider.status);
  const scope = Array.isArray(provider.scope) ? provider.scope.filter((item): item is "session" | "workspace" | "global" => item === "session" || item === "workspace" || item === "global") : [];
  const ranking = Array.isArray(provider.ranking) ? provider.ranking.filter((item): item is "deterministic-text" | "semantic" | "hybrid" => item === "deterministic-text" || item === "semantic" || item === "hybrid") : [];
  return {
    providerId: typeof provider.providerId === "string" ? provider.providerId : "",
    kind: provider.kind === "zvec" || provider.kind === "code-index" ? provider.kind : "pageindex",
    ...(status ? { status } : {}),
    ...(scope.length > 0 ? { scope } : {}),
    ...(ranking.length > 0 ? { ranking } : {}),
    implementationStatus: provider.implementationStatus === "available" || provider.implementationStatus === "missing" ? provider.implementationStatus : "unknown",
    activationEvidence: activationEvidenceFromConfig(provider.activationEvidence),
    metadata: isJsonObject(provider.metadata) ? provider.metadata : {},
    redaction: { class: "internal", fields: ["metadata"] }
  };
}

function activationEvidenceFromConfig(value: unknown): readonly IndexProviderActivationEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isJsonObject).flatMap((item) => {
    const kind = activationEvidenceKind(item.kind);
    const status = activationEvidenceStatus(item.status);
    if (!kind || !status) return [];
    return [{
      kind,
      status,
      sourceId: typeof item.sourceId === "string" && item.sourceId.length > 0 ? item.sourceId : `config.indexProviders.${kind}`,
      metadata: isJsonObject(item.metadata) ? item.metadata : {},
      redaction: { class: "internal", fields: ["metadata"] }
    }];
  });
}

function indexProviderStatus(value: unknown): IndexProviderStatus | undefined {
  return value === "enabled" || value === "deferred" || value === "disabled" || value === "unavailable" || value === "degraded" ? value : undefined;
}

function activationEvidenceKind(value: unknown): IndexProviderActivationEvidenceKind | undefined {
  return value === "implementation-module" || value === "embedding-provider" || value === "vector-store" || value === "code-analyzer" || value === "pageindex-provenance" ? value : undefined;
}

function activationEvidenceStatus(value: unknown): IndexProviderActivationEvidenceStatus | undefined {
  return value === "present" || value === "missing" || value === "unknown" ? value : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function missingLiveVerifierResult(profile: ModelProfile): ModelLiveVerificationResult {
  return {
    ok: false,
    provider: profile.providerId === defaultGlmAnthropicProfile.providerId
      ? { provider: "glm", protocol: "anthropic-messages", model: profile.model }
      : { provider: "deepseek", protocol: "openai-chat-completions", model: profile.model },
    reachable: false,
    terminalStatus: "failed",
    eventKinds: [],
    diagnostics: [],
    redaction: { class: "internal" }
  };
}

function selectedProviderName(options: CliOptions, providerId: ModelProfile["providerId"]): "deepseek" | "glm" {
  if (options.modelProvider === "glm" || providerId === defaultGlmAnthropicProfile.providerId) return "glm";
  return "deepseek";
}

function createGlmCredentialPresenceEnv(env: Readonly<Record<"GLM_ANTHROPIC_API_KEY" | "ZHIPU_API_KEY", string | undefined>>): Readonly<Record<"GLM_ANTHROPIC_API_KEY" | "ZHIPU_API_KEY", string | undefined>> {
  return {
    GLM_ANTHROPIC_API_KEY: hasValue(env.GLM_ANTHROPIC_API_KEY) ? "present" : undefined,
    ZHIPU_API_KEY: hasValue(env.ZHIPU_API_KEY) ? "present" : undefined
  };
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => hasValue(value))?.trim();
}

function hasValue(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
