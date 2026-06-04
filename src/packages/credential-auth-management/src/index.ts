import type {
  CredentialAuthService,
  CredentialAuditMetadata,
  CredentialManager,
  CredentialRecord,
  CredentialRef,
  CredentialSecretResult,
  CredentialScope,
  CredentialSecretInput,
  CredentialStorageAdapter,
  CredentialStorageDiagnostic,
  ModelCredentialProvider,
  ModelCredentialValue,
  ModelRequest,
  PlatformRuntime,
  SerializableResult,
  StoredCredentialReference
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import { join } from "node:path";

export type DeepSeekCredentialEnv = Readonly<Record<"DEEPSEEK_API_KEY" | "DEEPSEEK_TOKEN", string | undefined>>;
export type GlmAnthropicCredentialEnv = Readonly<Record<"GLM_ANTHROPIC_API_KEY" | "ZHIPU_API_KEY", string | undefined>>;
export type DiagnosticsEnvironmentPresenceEnv = Readonly<Record<
  "DOCKER_HOST" |
  "HOME" |
  "PATH" |
  "GLM_ANTHROPIC_API_KEY" |
  "ZHIPU_API_KEY" |
  "HF_TOKEN" |
  "HUGGINGFACE_HUB_TOKEN",
  string | undefined
>>;

const defaultDeepSeekCredentialRef = asId<"credentialRef">("credential-deepseek-api-key");
export const liveCredentialLaunchCwdEnvKey = "DEEPSEEK_CLI_LAUNCH_CWD";

export * from "./extension-auth.js";

export function createDeepSeekCredentialPresenceEnv(env: Readonly<Record<string, string | undefined>> = process.env): DeepSeekCredentialEnv {
  return {
    DEEPSEEK_API_KEY: hasValue(env.DEEPSEEK_API_KEY) ? "present" : undefined,
    DEEPSEEK_TOKEN: hasValue(env.DEEPSEEK_TOKEN) ? "present" : undefined
  };
}

export function createDiagnosticsEnvironmentPresenceEnv(env: Readonly<Record<string, string | undefined>> = process.env): DiagnosticsEnvironmentPresenceEnv {
  return {
    DOCKER_HOST: env.DOCKER_HOST,
    HOME: env.HOME,
    PATH: env.PATH,
    GLM_ANTHROPIC_API_KEY: hasValue(env.GLM_ANTHROPIC_API_KEY) ? "present" : undefined,
    ZHIPU_API_KEY: hasValue(env.ZHIPU_API_KEY) ? "present" : undefined,
    HF_TOKEN: hasValue(env.HF_TOKEN) ? "present" : undefined,
    HUGGINGFACE_HUB_TOKEN: hasValue(env.HUGGINGFACE_HUB_TOKEN) ? "present" : undefined
  };
}

export class FakeCredentialManager implements CredentialManager {
  private readonly records = new Map<string, CredentialRecord>();

  async resolve(ref: CredentialRef): Promise<CredentialRecord | undefined> {
    return this.records.get(ref);
  }

  async put(record: CredentialRecord): Promise<void> {
    this.records.set(record.ref, record);
  }

  redact(value: string): string {
    return redactSecret(value);
  }
}

export class InMemoryCredentialStorageAdapter implements CredentialStorageAdapter {
  private readonly secrets = new Map<string, CredentialSecretInput>();
  private readonly refs = new Map<string, StoredCredentialReference>();

  constructor(private readonly storageStatus: CredentialStorageDiagnostic = availableDiagnostic()) {}

  async status(): Promise<CredentialStorageDiagnostic> {
    return this.storageStatus;
  }

  async store(scope: CredentialScope, secret: CredentialSecretInput): Promise<SerializableResult<StoredCredentialReference>> {
    if ((await this.status()).status === "unavailable") {
      return { ok: false, error: { code: "CREDENTIAL_STORAGE_UNAVAILABLE", message: "Credential storage is unavailable.", retryable: false, redaction: { class: "public" } } };
    }
    const ref = credentialRefForScope(scope);
    const reference = storedReference(ref, scope, "fake-storage", true, "store");
    this.secrets.set(ref, secret);
    this.refs.set(ref, reference);
    return { ok: true, value: reference };
  }

  async resolve(ref: CredentialRef): Promise<CredentialSecretResult> {
    const secret = this.secrets.get(ref);
    if (!secret) {
      return { ok: false, error: { code: "CREDENTIAL_NOT_FOUND", message: "Credential reference was not found.", retryable: false, redaction: { class: "public" }, details: { ref } } };
    }
    return { ok: true, value: secret };
  }

  async delete(scope: CredentialScope): Promise<SerializableResult<StoredCredentialReference>> {
    const ref = credentialRefForScope(scope);
    const existing = this.refs.get(ref) ?? storedReference(ref, scope, "missing", false, "delete");
    this.secrets.delete(ref);
    this.refs.delete(ref);
    return { ok: true, value: { ...existing, available: false, audit: audit("delete", scope) } };
  }

  async list(scope?: Partial<CredentialScope>): Promise<readonly StoredCredentialReference[]> {
    return [...this.refs.values()].filter((ref) => matchesScope(ref.scope, scope));
  }
}

export class UnavailableCredentialStorageAdapter implements CredentialStorageAdapter {
  async status(): Promise<CredentialStorageDiagnostic> {
    return {
      code: "CREDENTIAL_STORAGE_UNAVAILABLE",
      status: "unavailable",
      message: "Secure credential storage is unavailable on this host.",
      suggestedActions: ["Use environment credentials for this session or configure a secure storage adapter."],
      redaction: { class: "public" }
    };
  }

  async store(): Promise<SerializableResult<StoredCredentialReference>> {
    return { ok: false, error: { code: "CREDENTIAL_STORAGE_UNAVAILABLE", message: "Secure credential storage is unavailable.", retryable: false, redaction: { class: "public" } } };
  }

  async resolve(): Promise<CredentialSecretResult> {
    return { ok: false, error: { code: "CREDENTIAL_STORAGE_UNAVAILABLE", message: "Secure credential storage is unavailable.", retryable: false, redaction: { class: "public" } } };
  }

  async delete(scope: CredentialScope): Promise<SerializableResult<StoredCredentialReference>> {
    return { ok: true, value: storedReference(credentialRefForScope(scope), scope, "missing", false, "delete") };
  }

  async list(): Promise<readonly StoredCredentialReference[]> {
    return [];
  }
}

export class DeepSeekCredentialAuthService implements CredentialAuthService {
  constructor(private readonly storage: CredentialStorageAdapter = new InMemoryCredentialStorageAdapter(), private readonly defaultScope: CredentialScope = defaultDeepSeekScope()) {}

  async storeDeepSeekCredential(secret: CredentialSecretInput, scope: Partial<CredentialScope> = {}): Promise<SerializableResult<StoredCredentialReference>> {
    return this.storage.store(this.scope(scope), secret);
  }

  async resolveDeepSeekCredential(ref: CredentialRef): Promise<CredentialSecretResult> {
    return this.storage.resolve(ref);
  }

  async deleteDeepSeekCredential(scope: Partial<CredentialScope> = {}): Promise<SerializableResult<StoredCredentialReference>> {
    return this.storage.delete(this.scope(scope));
  }

  async listDeepSeekCredentials(scope: Partial<CredentialScope> = {}): Promise<readonly StoredCredentialReference[]> {
    return this.storage.list(this.scope(scope));
  }

  async status(): Promise<CredentialStorageDiagnostic> {
    return this.storage.status();
  }

  private scope(scope: Partial<CredentialScope>): CredentialScope {
    return { ...this.defaultScope, ...scope, provider: "deepseek" };
  }
}

export class CredentialAuthModelCredentialProvider implements ModelCredentialProvider {
  constructor(private readonly auth: CredentialAuthService) {}

  async resolve(ref: CredentialRef, _request: ModelRequest): Promise<ModelCredentialValue | undefined> {
    const resolved = await this.auth.resolveDeepSeekCredential(ref);
    if (!resolved.ok || !resolved.value) return undefined;
    return {
      ref,
      value: resolved.value.value,
      redaction: { class: "secret" }
    };
  }
}

export async function createDeepSeekCredentialAuthServiceFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): Promise<CredentialAuthService> {
  const storage = new InMemoryCredentialStorageAdapter();
  const service = new DeepSeekCredentialAuthService(storage);
  const value = firstNonEmpty(env.DEEPSEEK_API_KEY, env.DEEPSEEK_TOKEN);
  if (value) {
    await service.storeDeepSeekCredential({ value, source: "environment" });
  }
  return service;
}

export async function deepSeekLiveCredentialProcessEnv(platform: Pick<PlatformRuntime, "readFile">, cwd = process.cwd(), env: Readonly<Record<string, string | undefined>> = process.env): Promise<DeepSeekCredentialEnv> {
  const envFile = await readDeepSeekCredentialEnvFile(platform, join(cwd, ".env"));
  const launchEnvFile = await readLaunchCredentialEnvFile(platform, cwd, env, readDeepSeekCredentialEnvFile, { DEEPSEEK_API_KEY: undefined, DEEPSEEK_TOKEN: undefined });
  return {
    DEEPSEEK_API_KEY: firstNonEmpty(env.DEEPSEEK_API_KEY, envFile.DEEPSEEK_API_KEY, launchEnvFile.DEEPSEEK_API_KEY),
    DEEPSEEK_TOKEN: firstNonEmpty(env.DEEPSEEK_TOKEN, envFile.DEEPSEEK_TOKEN, launchEnvFile.DEEPSEEK_TOKEN)
  };
}

export async function glmAnthropicLiveCredentialProcessEnv(platform: Pick<PlatformRuntime, "readFile">, cwd = process.cwd(), env: Readonly<Record<string, string | undefined>> = process.env): Promise<GlmAnthropicCredentialEnv> {
  const envFile = await readGlmAnthropicCredentialEnvFile(platform, join(cwd, ".env"));
  const launchEnvFile = await readLaunchCredentialEnvFile(platform, cwd, env, readGlmAnthropicCredentialEnvFile, { GLM_ANTHROPIC_API_KEY: undefined, ZHIPU_API_KEY: undefined });
  return {
    GLM_ANTHROPIC_API_KEY: firstNonEmpty(env.GLM_ANTHROPIC_API_KEY, envFile.GLM_ANTHROPIC_API_KEY, launchEnvFile.GLM_ANTHROPIC_API_KEY),
    ZHIPU_API_KEY: firstNonEmpty(env.ZHIPU_API_KEY, envFile.ZHIPU_API_KEY, launchEnvFile.ZHIPU_API_KEY)
  };
}

async function readLaunchCredentialEnvFile<TEnv extends Record<string, string | undefined>>(
  platform: Pick<PlatformRuntime, "readFile">,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  readEnvFile: (platform: Pick<PlatformRuntime, "readFile">, path: string) => Promise<TEnv>,
  empty: TEnv
): Promise<TEnv> {
  const launchCwd = firstNonEmpty(env[liveCredentialLaunchCwdEnvKey]);
  if (!launchCwd || launchCwd === cwd) return empty;
  return readEnvFile(platform, join(launchCwd, ".env"));
}

async function readDeepSeekCredentialEnvFile(platform: Pick<PlatformRuntime, "readFile">, path: string): Promise<DeepSeekCredentialEnv> {
  try {
    const text = await platform.readFile(path);
    const values: Record<string, string | undefined> = {};
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      if (key !== "DEEPSEEK_API_KEY" && key !== "DEEPSEEK_TOKEN") continue;
      values[key] = unquoteEnvValue(trimmed.slice(index + 1).trim());
    }
    return {
      DEEPSEEK_API_KEY: firstNonEmpty(values.DEEPSEEK_API_KEY),
      DEEPSEEK_TOKEN: firstNonEmpty(values.DEEPSEEK_TOKEN)
    };
  } catch {
    return { DEEPSEEK_API_KEY: undefined, DEEPSEEK_TOKEN: undefined };
  }
}

async function readGlmAnthropicCredentialEnvFile(platform: Pick<PlatformRuntime, "readFile">, path: string): Promise<GlmAnthropicCredentialEnv> {
  try {
    const text = await platform.readFile(path);
    const values: Record<string, string | undefined> = {};
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      const key = trimmed.slice(0, index).trim();
      if (key !== "GLM_ANTHROPIC_API_KEY" && key !== "ZHIPU_API_KEY") continue;
      values[key] = unquoteEnvValue(trimmed.slice(index + 1).trim());
    }
    return {
      GLM_ANTHROPIC_API_KEY: firstNonEmpty(values.GLM_ANTHROPIC_API_KEY),
      ZHIPU_API_KEY: firstNonEmpty(values.ZHIPU_API_KEY)
    };
  } catch {
    return { GLM_ANTHROPIC_API_KEY: undefined, ZHIPU_API_KEY: undefined };
  }
}

export function credentialRefForScope(scope: CredentialScope): CredentialRef {
  if (scope.provider === "deepseek" && scope.profile === "default" && !scope.workspace) return defaultDeepSeekCredentialRef;
  return asId<"credentialRef">(`credential-${scope.provider}-${scope.profile}${scope.workspace ? `-${scope.workspace}` : ""}`);
}

export function redactSecret(value: string): string {
  return value.length <= 4 ? "****" : `${value.slice(0, 2)}****${value.slice(-2)}`;
}

function defaultDeepSeekScope(): CredentialScope {
  return { provider: "deepseek", profile: "default" };
}

function storedReference(ref: CredentialRef, scope: CredentialScope, source: StoredCredentialReference["source"], available: boolean, operation: CredentialAuditMetadata["operation"]): StoredCredentialReference {
  return {
    ref,
    scope,
    source,
    available,
    rotation: { createdBy: "local-auth" },
    audit: audit(operation, scope),
    redaction: { class: "secret" }
  };
}

function audit(operation: CredentialAuditMetadata["operation"], scope: CredentialScope): CredentialAuditMetadata {
  return {
    operation,
    scope,
    at: "1970-01-01T00:00:00.000Z",
    redaction: { class: "internal" }
  };
}

function matchesScope(scope: CredentialScope, filter: Partial<CredentialScope> | undefined): boolean {
  if (!filter) return true;
  return (!filter.provider || filter.provider === scope.provider) && (!filter.profile || filter.profile === scope.profile) && (!filter.workspace || filter.workspace === scope.workspace);
}

function availableDiagnostic(): CredentialStorageDiagnostic {
  return {
    code: "CREDENTIAL_STORAGE_AVAILABLE",
    status: "available",
    message: "Credential storage is available.",
    suggestedActions: [],
    redaction: { class: "public" }
  };
}

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find(hasValue)?.trim();
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
