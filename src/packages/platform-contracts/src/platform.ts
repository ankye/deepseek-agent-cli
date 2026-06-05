import type { JsonObject, RedactedError, RedactionMetadata, SerializableResult } from "./common.js";
import type { ResourceScope, SandboxCapabilityMatrix, SandboxRequirement } from "./security.js";

export type PlatformOsFamily = "macos" | "windows" | "linux" | "fake";
export type PlatformEnvironmentKind = "local" | "wsl" | "ci" | "remote" | "test";
export type PlatformProviderStatus = "available" | "degraded" | "unavailable";
export type PlatformProviderName = "argv" | "bash" | "cmd" | "powershell" | "rg" | "grep" | "select-string" | "js" | "none";
export type ShellProfile = "none" | "bash" | "cmd" | "powershell" | "sh";
export type NativeCapabilityName = "voice" | "clipboard" | "url-handler" | "image-processing" | "file-watcher" | "secure-storage";

export interface PlatformDiagnostic extends JsonObject {
  readonly code: string;
  readonly severity: "info" | "warn" | "error";
  readonly message: string;
  readonly suggestedActions: readonly string[];
  readonly redaction: RedactionMetadata;
  readonly details?: JsonObject;
}

export interface PlatformProviderResultMetadata extends JsonObject {
  readonly selectedProvider: PlatformProviderName;
  readonly status: PlatformProviderStatus;
  readonly fallbackChain: readonly PlatformProviderName[];
  readonly fallbackReason?: string;
  readonly timeoutMs?: number;
  readonly degradedReasons: readonly string[];
  readonly diagnostics: readonly PlatformDiagnostic[];
  readonly redaction: RedactionMetadata;
}

export interface ShellProviderDescriptor extends JsonObject {
  readonly profile: ShellProfile;
  readonly provider: PlatformProviderName;
  readonly available: boolean;
  readonly status: PlatformProviderStatus;
  readonly command?: string;
  readonly args: readonly string[];
  readonly requiresShellSyntax: boolean;
  readonly diagnostics: readonly PlatformDiagnostic[];
  readonly redaction: RedactionMetadata;
}

export interface SearchProviderDescriptor extends JsonObject {
  readonly provider: PlatformProviderName;
  readonly available: boolean;
  readonly status: PlatformProviderStatus;
  readonly timeoutMs: number;
  readonly fallbackChain: readonly PlatformProviderName[];
  readonly diagnostics: readonly PlatformDiagnostic[];
  readonly redaction: RedactionMetadata;
}

export interface ProcessProviderDescriptor extends JsonObject {
  readonly provider: PlatformProviderName;
  readonly available: boolean;
  readonly status: PlatformProviderStatus;
  readonly shell: false;
  readonly diagnostics: readonly PlatformDiagnostic[];
  readonly redaction: RedactionMetadata;
}

export interface FilesystemSemantics extends JsonObject {
  readonly caseSensitive: boolean;
  readonly pathSeparator: "/" | "\\";
  readonly homeExpansionAllowed: boolean;
  readonly driveLetters: boolean;
  readonly symlinkAware: boolean;
}

export interface PlatformResolvedPath extends JsonObject {
  readonly path: string;
  readonly root: string;
  readonly relativePath: string;
  readonly safe: boolean;
  readonly diagnostics: readonly PlatformDiagnostic[];
  readonly redaction: RedactionMetadata;
}

export interface PlatformPathTranslation extends JsonObject {
  readonly sourcePath: string;
  readonly translatedPath: string;
  readonly sourceEnvironment: PlatformEnvironmentKind;
  readonly targetEnvironment: PlatformEnvironmentKind;
  readonly metadata: PlatformProviderResultMetadata;
  readonly redaction: RedactionMetadata;
}

export interface SecureStorageCapability extends JsonObject {
  readonly status: PlatformProviderStatus;
  readonly provider: "environment" | "os-keychain" | "fake-storage" | "none";
  readonly scopedReferences: boolean;
  readonly diagnostics: readonly PlatformDiagnostic[];
  readonly redaction: RedactionMetadata;
}

export interface NativeCapabilityProbe extends JsonObject {
  readonly capability: NativeCapabilityName;
  readonly status: PlatformProviderStatus;
  readonly provider: string;
  readonly diagnostics: readonly PlatformDiagnostic[];
  readonly redaction: RedactionMetadata;
}

export interface WatcherCapability extends JsonObject {
  readonly status: PlatformProviderStatus;
  readonly provider: "native" | "polling" | "none";
  readonly recursive: boolean;
  readonly diagnostics: readonly PlatformDiagnostic[];
  readonly redaction: RedactionMetadata;
}

export interface PlatformDescriptor extends JsonObject {
  readonly os: PlatformOsFamily;
  readonly environmentKind: PlatformEnvironmentKind;
  readonly architecture: string;
  readonly shell: ShellProviderDescriptor;
  readonly processProvider: ProcessProviderDescriptor;
  readonly search: SearchProviderDescriptor;
  readonly secureStorage: SecureStorageCapability;
  readonly nativeCapabilities: readonly NativeCapabilityProbe[];
  readonly watcher: WatcherCapability;
  readonly filesystem: FilesystemSemantics;
  readonly sandbox: SandboxCapabilityMatrix;
  readonly degraded: boolean;
  readonly degradedReasons: readonly string[];
  readonly diagnostics: readonly PlatformDiagnostic[];
  readonly redaction: RedactionMetadata;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly metadata?: PlatformProviderResultMetadata;
}

export type ProcessExecutionProfile = "default" | "noninteractive";
export type ProcessStdinMode = "pipe" | "ignore";

export interface ProcessRunObserver {
  readonly onStdoutChunk?: (chunk: string) => void;
  readonly onStderrChunk?: (chunk: string) => void;
}

export interface ProcessRunOptions extends JsonObject {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: JsonObject;
  readonly executionProfile?: ProcessExecutionProfile;
  readonly stdin?: ProcessStdinMode;
  readonly outputLimitBytes?: number;
}

export interface SearchResult {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly engine: "rg" | "grep" | "select-string" | "js";
  readonly fallbackReason?: string;
  readonly metadata?: PlatformProviderResultMetadata;
}

export interface PlatformRuntime {
  readonly os: PlatformOsFamily;
  descriptor(): Promise<PlatformDescriptor>;
  resolveShell(profile?: ShellProfile): Promise<SerializableResult<ShellProviderDescriptor>>;
  selectSearchProvider(preferred?: PlatformProviderName): Promise<SearchProviderDescriptor>;
  resolveProcessProvider(): Promise<ProcessProviderDescriptor>;
  resolveWorkspacePath(workspaceRoot: string, inputPath: string): SerializableResult<PlatformResolvedPath>;
  translatePath(path: string, targetEnvironment: PlatformEnvironmentKind): SerializableResult<PlatformPathTranslation>;
  secureStorageCapability(): Promise<SecureStorageCapability>;
  probeNativeCapability(capability: NativeCapabilityName): Promise<NativeCapabilityProbe>;
  watcherCapability(root: string): Promise<WatcherCapability>;
  resolvePath(...parts: readonly string[]): string;
  createTempDirectory(prefix: string): Promise<string>;
  userConfigPath(appName: string): string;
  workspaceMetadataPath(workspaceRoot: string, appName: string): SerializableResult<string>;
  ensureDirectory(path: string): Promise<void>;
  atomicWriteFile(path: string, content: string): Promise<SerializableResult<PlatformPersistenceMetadata>>;
  permissionDiagnostics(path: string): Promise<readonly PlatformPersistenceDiagnostic[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  findFiles(pattern: string, root: string): Promise<readonly string[]>;
  searchText(pattern: string, root: string): Promise<readonly SearchResult[]>;
  runProcess(command: string, args: readonly string[], options?: ProcessRunOptions, observer?: ProcessRunObserver): Promise<ProcessResult>;
  availability(): Promise<JsonObject>;
}

export type PlatformPathKind = "user-config" | "workspace-metadata" | "credential-storage" | "cache";

export interface PlatformPersistenceMetadata extends JsonObject {
  readonly path: string;
  readonly pathKind: PlatformPathKind;
  readonly os: PlatformOsFamily;
  readonly atomic: boolean;
  readonly redaction: RedactionMetadata;
}

export interface PlatformPersistenceDiagnostic extends JsonObject {
  readonly code: string;
  readonly severity: "info" | "warn" | "error";
  readonly message: string;
  readonly path?: string;
  readonly os: PlatformOsFamily;
  readonly suggestedActions: readonly string[];
  readonly redaction: RedactionMetadata;
}

export interface AtomicWriteFailure extends RedactedError {
  readonly details?: JsonObject;
}

export interface PlatformExecutionContext extends JsonObject {
  readonly descriptor: PlatformDescriptor;
  readonly shell?: ShellProviderDescriptor;
  readonly processProvider?: ProcessProviderDescriptor;
  readonly search?: PlatformProviderResultMetadata;
  readonly secureStorage?: SecureStorageCapability;
  readonly nativeCapability?: NativeCapabilityProbe;
  readonly cwd?: string;
  readonly environmentScope?: "none" | "inherited" | "scoped";
  readonly timeoutMs?: number;
  readonly resourceLocks: readonly string[];
  readonly sandboxProfile?: string;
  readonly sandboxCapabilities: SandboxCapabilityMatrix;
  readonly resourceScope?: ResourceScope;
  readonly sandboxRequirements?: SandboxRequirement;
  readonly redaction: RedactionMetadata;
}
