import type {
  AgentLoopOutputMode,
  IndexProviderManifest,
  IndexProviderManifestEntry,
  IndexProviderDiagnosticRecord,
  IndexProviderStatus,
  JsonObject,
  JsonValue
} from "@deepseek/platform-contracts";
import { INDEX_PROVIDER_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import { createDefaultIndexProviderManifest, resolveIndexProviderDiagnostics } from "@deepseek/index-provider";
import { PersistentConfigService } from "@deepseek/config";
import { NodePlatformRuntime } from "@deepseek/platform-abstraction";
import type { CliOptions, CliRunOptions } from "../types.js";
import { resolveCliWorkspaceRoot } from "../host/workspace-root.js";

export interface CliIndexProviderResult extends JsonObject {
  readonly kind: "index-provider.status" | "index-provider.set";
  readonly ok: boolean;
  readonly action: "status" | "set";
  readonly summary?: ReturnType<typeof resolveIndexProviderDiagnostics>;
  readonly written?: boolean;
  readonly diagnostics: readonly JsonObject[];
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export async function runIndexProviderCommand(options: CliOptions, write: (line: string) => Promise<void>, runOptions: CliRunOptions = {}): Promise<void> {
  const result = await collectIndexProviderResult(options, runOptions);
  for (const line of renderIndexProviderResult(result, options.output)) await write(line);
}

export async function collectIndexProviderResult(options: CliOptions, runOptions: CliRunOptions = {}): Promise<CliIndexProviderResult> {
  const workspaceRoot = await resolveCliWorkspaceRoot(runOptions);
  const config = createConfig(workspaceRoot);
  const resolved = await config.resolve();
  const currentManifest = manifestFromConfigValue(resolved.values.find((value) => value.key === "indexProviders")?.redactedValue);
  if (options.indexProviderAction === "set") {
    const providerId = options.indexProviderId ?? "";
    const requestedStatus = providerStatus(options.indexProviderStatus);
    if (!isKnownProvider(providerId) || !requestedStatus) {
      return failure("index-provider.set", "set", "INDEX_PROVIDER_CLI_INVALID_ARGUMENT", `Invalid provider or status: ${providerId} ${options.indexProviderStatus ?? ""}.`);
    }
    const manifest = upsertProviderIntent(currentManifest ?? createDefaultIndexProviderManifest(), providerId, requestedStatus, options.indexProviderScope ?? "workspace");
    const write = await config.set({ scope: options.indexProviderScope ?? "workspace", key: "indexProviders", value: manifest });
    const summary = resolveIndexProviderDiagnostics(manifest);
    return {
      kind: "index-provider.set",
      ok: write.ok,
      action: "set",
      summary,
      written: write.ok,
      diagnostics: write.diagnostics.map((diagnostic) => ({ code: diagnostic.code, severity: diagnostic.severity, message: diagnostic.message })),
      redaction: { class: "internal", fields: ["summary.providers.metadata", "summary.providers.activationEvidence.metadata", "summary.providers.diagnostics.details"] }
    };
  }
  return {
    kind: "index-provider.status",
    ok: true,
    action: "status",
    summary: resolveIndexProviderDiagnostics(currentManifest),
    diagnostics: [],
    redaction: { class: "internal", fields: ["summary.providers.metadata", "summary.providers.activationEvidence.metadata", "summary.providers.diagnostics.details"] }
  };
}

export function renderIndexProviderResult(result: CliIndexProviderResult, output: AgentLoopOutputMode): readonly string[] {
  if (output === "json") return [JSON.stringify(result)];
  if (output === "jsonl") {
    const lines = [JSON.stringify({ kind: result.kind, ok: result.ok, action: result.action, written: result.written ?? false, redaction: result.redaction })];
    if (result.summary) {
      lines.push(JSON.stringify({ kind: "index-provider.summary", summary: result.summary, redaction: result.summary.redaction }));
      for (const provider of result.summary.providers) lines.push(JSON.stringify({ kind: "index-provider.provider", provider, redaction: provider.redaction }));
    }
    for (const diagnostic of result.diagnostics) lines.push(JSON.stringify({ kind: "index-provider.diagnostic", diagnostic, redaction: { class: "internal" } }));
    return lines;
  }
  if (!result.ok) return [`${result.kind}: fail`, ...result.diagnostics.map((diagnostic) => `- ${diagnostic.code}: ${diagnostic.message}`)];
  const lines = [`${result.kind}: ${result.ok ? "pass" : "fail"}`];
  if (result.written) lines.push("- config: written");
  if (result.summary) {
    lines.push(`- source: ${result.summary.source.scope}:${result.summary.source.sourceId}`);
    lines.push(`- enabled: ${result.summary.enabledProviderIds.join(", ") || "none"}`);
    lines.push(`- deferred: ${result.summary.deferredProviderIds.join(", ") || "none"}`);
    for (const provider of result.summary.providers) {
      const requested = provider.requestedStatus && provider.requestedStatus !== provider.status ? ` requested=${provider.requestedStatus}` : "";
      lines.push(`- ${provider.providerId}: effective=${provider.status}${requested} implementation=${provider.implementationStatus}`);
      lines.push(`  evidence=${activationEvidenceText(provider)}`);
      const missing = missingActivationEvidence(provider);
      if (missing.length > 0) lines.push(`  missing-evidence=${missing.join(", ")}`);
      if (provider.diagnostics.length > 0) lines.push(`  diagnostics=${provider.diagnostics.map((diagnostic) => diagnostic.code).join(", ")}`);
    }
    for (const diagnostic of result.summary.diagnostics) lines.push(`- diagnostic: ${diagnostic.code}`);
  }
  return lines;
}

export function activationEvidenceText(provider: IndexProviderDiagnosticRecord): string {
  if (provider.activationEvidence.length === 0) return "none";
  return provider.activationEvidence.map((evidence) => `${evidence.kind}:${evidence.status}`).join(", ");
}

export function missingActivationEvidence(provider: IndexProviderDiagnosticRecord): readonly string[] {
  const metadataMissing = provider.metadata.missingActivationEvidence;
  if (Array.isArray(metadataMissing)) return metadataMissing.filter((value): value is string => typeof value === "string");
  return provider.activationEvidence.filter((evidence) => evidence.status !== "present").map((evidence) => evidence.kind);
}

function createConfig(workspaceRoot: string): PersistentConfigService {
  const platform = new NodePlatformRuntime();
  return new PersistentConfigService({
    platform,
    workspaceRoot,
    defaults: {
      indexProviders: createDefaultIndexProviderManifest()
    }
  });
}

function upsertProviderIntent(manifest: IndexProviderManifest, providerId: "pageindex" | "zvec" | "code-index", status: IndexProviderStatus, scope: "workspace" | "user"): IndexProviderManifest {
  const providers = manifest.providers.filter((provider) => provider.providerId !== providerId);
  providers.push(providerIntentEntry(providerId, status));
  return {
    schemaVersion: INDEX_PROVIDER_SCHEMA_VERSION,
    kind: "index-provider.manifest",
    defaultProviderId: "pageindex",
    source: {
      scope,
      sourceId: "config.indexProviders",
      description: "CLI index-provider command intent.",
      redaction: { class: "internal", fields: ["sourceId", "description"] }
    },
    providers,
    metadata: { updatedBy: "cli.index-provider" },
    redaction: { class: "internal", fields: ["providers.metadata", "providers.activationEvidence.metadata", "source"] }
  };
}

function providerIntentEntry(providerId: "pageindex" | "zvec" | "code-index", status: IndexProviderStatus): IndexProviderManifestEntry {
  return {
    providerId,
    kind: providerId,
    status,
    implementationStatus: providerId === "pageindex" ? "available" : "missing",
    metadata: { requestedBy: "cli.index-provider" },
    redaction: { class: "internal", fields: ["metadata"] }
  };
}

function manifestFromConfigValue(value: JsonValue | undefined): IndexProviderManifest | undefined {
  if (!isJsonObject(value) || value.kind !== "index-provider.manifest") return undefined;
  return value as unknown as IndexProviderManifest;
}

function providerStatus(value: string | undefined): IndexProviderStatus | undefined {
  return value === "enabled" || value === "deferred" || value === "disabled" ? value : undefined;
}

function isKnownProvider(value: string): value is "pageindex" | "zvec" | "code-index" {
  return value === "pageindex" || value === "zvec" || value === "code-index";
}

function failure(kind: CliIndexProviderResult["kind"], action: CliIndexProviderResult["action"], code: string, message: string): CliIndexProviderResult {
  return {
    kind,
    ok: false,
    action,
    diagnostics: [{ code, message }],
    redaction: { class: "internal" }
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
