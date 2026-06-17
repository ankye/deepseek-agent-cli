import type { JsonObject, RedactionClass, RedactionMetadata, TraceContext } from "./common.js";

export const SECRET_SANDBOX_SCHEMA_VERSION = "1.0.0";
export const MAX_EXECUTION_TIMEOUT_MS = 7_200_000;

export type SecretKind =
  | "none"
  | "api-key"
  | "bearer-token"
  | "private-key"
  | "env-credential"
  | "credential-ref"
  | "redaction-class"
  | "generic-secret";

export type SecretExposureLevel = "none" | "reference" | "redacted" | "raw" | "unsafe";
export type SecretRedactionAction = "allow" | "redact" | "exclude" | "rewrite" | "deny";

export interface SecretClassification extends JsonObject {
  readonly schemaVersion: string;
  readonly detected: boolean;
  readonly kind: SecretKind;
  readonly exposure: SecretExposureLevel;
  readonly reasonCode: string;
  readonly occurrences: number;
  readonly fingerprint?: string;
  readonly redactionClass: RedactionClass;
  readonly evidence: JsonObject;
}

export interface SecretRedactionDecision extends JsonObject {
  readonly schemaVersion: string;
  readonly action: SecretRedactionAction;
  readonly reasonCode: string;
  readonly classification: SecretClassification;
  readonly redactedText?: string;
  readonly redaction: RedactionMetadata;
}

export type ResourceScopeKind = "none" | "workspace" | "filesystem" | "process" | "network" | "environment" | "native";

export interface ResourcePathScope extends JsonObject {
  readonly path: string;
  readonly normalizedPath?: string;
  readonly workspaceRoot?: string;
  readonly traversal: "safe" | "rejected" | "unknown";
  readonly access: "read" | "write" | "execute";
}

export interface ResourceScope extends JsonObject {
  readonly schemaVersion: string;
  readonly kind: ResourceScopeKind;
  readonly paths: readonly ResourcePathScope[];
  readonly cwd?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly environment: "none" | "scoped" | "inherited";
  readonly networkHosts: readonly string[];
  readonly nativeCapabilities: readonly string[];
  readonly rollbackAvailable: boolean;
  readonly redaction: RedactionMetadata;
}

export type SandboxCapabilityName =
  | "filesystem-read"
  | "filesystem-write"
  | "process-execute"
  | "shell-execute"
  | "network-access"
  | "environment-read"
  | "native-access"
  | "secure-storage";

export interface SandboxFilesystemCapabilities extends JsonObject {
  readonly read: boolean;
  readonly write: boolean;
  readonly readOnly: boolean;
  readonly traversalPolicy: "workspace-root" | "none";
  readonly rollback: boolean;
}

export interface SandboxProcessCapabilities extends JsonObject {
  readonly execute: boolean;
  readonly providerStatus: "available" | "degraded" | "unavailable";
}

export interface SandboxShellCapabilities extends JsonObject {
  readonly execute: boolean;
  readonly profile: string;
  readonly providerStatus: "available" | "degraded" | "unavailable";
}

export interface SandboxNetworkCapabilities extends JsonObject {
  readonly access: boolean;
  readonly providerStatus: "available" | "degraded" | "unavailable";
  readonly hostScopes: readonly string[];
}

export interface SandboxEnvironmentCapabilities extends JsonObject {
  readonly access: "none" | "scoped" | "inherited";
}

export interface SandboxNativeCapabilities extends JsonObject {
  readonly access: boolean;
  readonly providerStatuses: JsonObject;
}

export interface SandboxSecureStorageCapabilities extends JsonObject {
  readonly status: "available" | "degraded" | "unavailable";
  readonly scopedReferences: boolean;
}

export interface SandboxCapabilityMatrix extends JsonObject {
  readonly schemaVersion: string;
  readonly filesystem: SandboxFilesystemCapabilities;
  readonly processExecution: SandboxProcessCapabilities;
  readonly shell: SandboxShellCapabilities;
  readonly network: SandboxNetworkCapabilities;
  readonly environment: SandboxEnvironmentCapabilities;
  readonly native: SandboxNativeCapabilities;
  readonly secureStorage: SandboxSecureStorageCapabilities;
  readonly degraded: boolean;
  readonly degradedReasons: readonly string[];
  readonly redaction: RedactionMetadata;
}

export interface SandboxRequirement extends JsonObject {
  readonly schemaVersion: string;
  readonly profile: string;
  readonly capabilities: readonly SandboxCapabilityName[];
  readonly resourceScope: ResourceScope;
  readonly timeoutMs: number;
  readonly environment: "none" | "scoped" | "inherited";
  readonly outputRedaction: RedactionMetadata;
  readonly requireEnforcement: boolean;
}

export interface SandboxDecision extends JsonObject {
  readonly schemaVersion: string;
  readonly action: "allow" | "ask" | "deny" | "rewrite" | "require-sandbox" | "quarantine";
  readonly profile: string;
  readonly reasonCodes: readonly string[];
  readonly requirements: SandboxRequirement;
  readonly capabilities: SandboxCapabilityMatrix;
  readonly degraded: boolean;
  readonly redaction: RedactionMetadata;
}

export interface SandboxAuditEvidence extends JsonObject {
  readonly schemaVersion: string;
  readonly decision: string;
  readonly reasonCode: string;
  readonly subject: string;
  readonly resource: string;
  readonly redactedSubject: string;
  readonly redactedResource: string;
  readonly sandboxProfile: string;
  readonly trace?: TraceContext;
  readonly metadata: JsonObject;
  readonly redaction: RedactionMetadata;
}
