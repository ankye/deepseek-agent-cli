import type { JsonObject, SerializableResult, TraceContext } from "./common.js";
import type { CapabilityId } from "./ids.js";
import type { ExecutionEnvelope } from "./runtime.js";
import type { ResourceScope, SandboxAuditEvidence, SandboxRequirement, SecretRedactionDecision } from "./security.js";
import type { CapabilityToolFamilyMetadata, ToolFamilyProjectionFilter } from "./tool-family.js";

export type SideEffectLevel = "none" | "read" | "write" | "network" | "process";
export type TrustStatus = "trusted" | "workspace" | "untrusted" | "quarantined";

export type CapabilityRiskClass =
  | "none"
  | "read-only"
  | "workspace-write"
  | "process-run"
  | "test-process"
  | "network"
  | "memory"
  | "orchestration";

export interface CapabilityRiskMetadata extends JsonObject {
  readonly riskClass: CapabilityRiskClass;
  readonly mutatesWorkspace: boolean;
  readonly policyHooks: readonly string[];
}

export interface CapabilityManifest {
  readonly id: CapabilityId;
  readonly name: string;
  readonly description?: string;
  readonly source: string;
  readonly version: string;
  readonly trust: TrustStatus;
  readonly sideEffect: SideEffectLevel;
  readonly permissions: readonly string[];
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly enabled: boolean;
  readonly timeoutMs?: number;
  readonly replayPolicy?: JsonObject;
  readonly projection?: JsonObject;
  readonly toolFamily?: CapabilityToolFamilyMetadata;
  readonly compatibility?: JsonObject;
  readonly secretExposure?: SecretRedactionDecision;
  readonly resourceScope?: ResourceScope;
  readonly sandboxRequirements?: SandboxRequirement;
  readonly audit?: SandboxAuditEvidence;
  readonly security?: JsonObject;
  readonly risk?: CapabilityRiskMetadata;
}

export interface CapabilityExecutionContext {
  readonly envelope: ExecutionEnvelope;
  readonly trace: TraceContext;
  readonly signal: AbortSignal;
  readonly cancellationReason?: string;
  readonly metadata: JsonObject;
}

export type CapabilityExecutor = (
  input: JsonObject,
  context: CapabilityExecutionContext
) => Promise<SerializableResult>;

export interface CapabilityExecutorBinding {
  readonly manifest: CapabilityManifest;
  readonly execute: CapabilityExecutor;
}

export interface CapabilityRegistry {
  register(manifest: CapabilityManifest, executor?: CapabilityExecutor): Promise<void>;
  get(id: CapabilityId): Promise<CapabilityManifest | undefined>;
  listHostVisible(): Promise<readonly CapabilityManifest[]>;
  listModelVisible(filter?: ToolFamilyProjectionFilter): Promise<readonly CapabilityManifest[]>;
  resolveExecutable(id: CapabilityId): Promise<CapabilityExecutorBinding | undefined>;
  execute(id: CapabilityId, input: JsonObject, context?: CapabilityExecutionContext): Promise<SerializableResult>;
}
