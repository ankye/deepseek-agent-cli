import type {
  CapabilityManifest,
  ExecutionEnvelope,
  JsonObject,
  KernelError,
  RuntimeKernelRequest,
  SessionId,
  TraceContext
} from "@deepseek/platform-contracts";
import { MAX_EXECUTION_TIMEOUT_MS, asId } from "@deepseek/platform-contracts";
import type { PlatformExecutionContext } from "@deepseek/platform-contracts";
import {
  analyzeResourceScope,
  createSandboxAuditEvidence,
  createSandboxRequirement,
  createSecretRedactionDecision
} from "@deepseek/policy-sandbox";
import { kernelError } from "./errors.js";
import { normalizeResourceLockKey, normalizeWorkspaceResourceLockKey } from "./resource-locks.js";

export interface ExecutionEnvelopeBuildInput {
  readonly request: RuntimeKernelRequest;
  readonly manifest: CapabilityManifest;
  readonly sessionId: SessionId;
  readonly workflowId?: string;
  readonly taskId?: string;
  readonly invocationId: string;
  readonly trace: TraceContext;
  readonly createdAt: string;
  readonly platformContext?: PlatformExecutionContext;
  readonly resolveWorkspacePath?: WorkspacePathResolver;
}

export function buildExecutionEnvelope(input: ExecutionEnvelopeBuildInput): ExecutionEnvelope {
  const timeoutMs = input.request.timeoutMs ?? input.manifest.timeoutMs ?? 30_000;
  const resourceLockOptions = input.resolveWorkspacePath ? { resolveWorkspacePath: input.resolveWorkspacePath } : {};
  const resourceLocks = resourceLocksFor(input.manifest.sideEffect, input.request.input, resourceLockOptions);
  const resourceScope = analyzeResourceScope(input.request.input, input.manifest.sideEffect);
  const secretExposure = createSecretRedactionDecision(input.request.input, { class: "internal" });
  const requestedSandboxProfile = input.platformContext?.sandboxProfile ?? input.manifest.sandboxRequirements?.profile;
  const sandboxRequirements = createSandboxRequirement({
    sideEffect: input.manifest.sideEffect,
    resourceScope,
    timeoutMs,
    permissions: input.manifest.permissions,
    ...(requestedSandboxProfile ? { profile: requestedSandboxProfile } : {})
  });
  const audit = createSandboxAuditEvidence({
    decision: "pending",
    reasonCode: "execution.envelope.created",
    subject: input.request.caller,
    resource: String(input.manifest.id),
    sandboxProfile: sandboxRequirements.profile,
    trace: input.trace,
    metadata: {
      capabilityId: input.manifest.id,
      sideEffect: input.manifest.sideEffect
    }
  });
  return {
    invocationId: input.invocationId,
    capabilityId: input.manifest.id,
    capabilityVersion: input.manifest.version,
    kind: "capability" as const,
    caller: input.request.caller,
    ...(input.request.parentInvocationId ? { parentInvocationId: input.request.parentInvocationId } : {}),
    sessionId: input.sessionId,
    ...(input.request.turnId ? { turnId: input.request.turnId } : {}),
    ...(input.workflowId ? { workflowId: asId<"workflow">(input.workflowId) } : {}),
    ...(input.taskId ? { taskId: asId<"task">(input.taskId) } : {}),
    ...(input.request.agentId ? { agentId: input.request.agentId } : {}),
    inputSchema: input.manifest.inputSchema,
    outputSchema: input.manifest.outputSchema,
    redactionClass: "internal",
    provenance: { source: input.manifest.source },
    trust: input.manifest.trust,
    permissions: input.manifest.permissions,
    sideEffect: input.manifest.sideEffect,
    policyContext: {
      caller: input.request.caller,
      capabilityId: input.manifest.id,
      sideEffect: input.manifest.sideEffect,
      secretExposure,
      resourceScope,
      sandboxRequirements,
      audit,
      ...(input.platformContext ? { platform: input.platformContext } : {})
    },
    approvalRequired: input.manifest.sideEffect !== "none" && input.manifest.sideEffect !== "read",
    resourceLocks,
    timeoutMs,
    deadlineAt: new Date(new Date(input.createdAt).getTime() + timeoutMs).toISOString(),
    cancellation: {
      cancellable: true,
      propagation: "abort-signal",
      reasonSchema: { type: "string" }
    },
    retryPolicy: { maxAttempts: 1, strategy: "none" },
    idempotency: { key: `${input.invocationId}:${input.manifest.version}`, scope: "invocation" },
    trace: input.trace,
    telemetry: { eventSchemaVersion: "1.0.0", traceRequired: true },
    replayPolicy: { replayable: true, snapshot: "normalized", deterministic: true },
    secretExposure,
    resourceScope,
    sandboxRequirements,
    audit,
    createdAt: input.createdAt
  };
}

export function validateExecutionEnvelope(envelope: unknown): readonly KernelError[] {
  const errors: KernelError[] = [];
  if (!envelope || typeof envelope !== "object") {
    return [kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope must be an object")];
  }
  const candidate = envelope as Record<string, unknown>;
  for (const key of [
    "invocationId",
    "capabilityId",
    "capabilityVersion",
    "kind",
    "caller",
    "sessionId",
    "workflowId",
    "taskId",
    "inputSchema",
    "outputSchema",
    "redactionClass",
    "provenance",
    "trust",
    "permissions",
    "sideEffect",
    "policyContext",
    "approvalRequired",
    "resourceLocks",
    "timeoutMs",
    "deadlineAt",
    "cancellation",
    "retryPolicy",
    "idempotency",
    "trace",
    "telemetry",
    "replayPolicy",
    "secretExposure",
    "resourceScope",
    "sandboxRequirements",
    "audit",
    "createdAt"
  ]) {
    if (candidate[key] === undefined || candidate[key] === null || candidate[key] === "") {
      errors.push(kernelError("KERNEL_ENVELOPE_INVALID", `Execution envelope missing ${key}`, { key }));
    }
  }
  if (candidate.kind !== "capability") {
    errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope kind must be capability", { kind: String(candidate.kind) }));
  }
  if (!["none", "read", "write", "network", "process"].includes(String(candidate.sideEffect))) {
    errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope has unsupported sideEffect", { sideEffect: String(candidate.sideEffect) }));
  }
  if (typeof candidate.timeoutMs !== "number" || !Number.isFinite(candidate.timeoutMs) || candidate.timeoutMs <= 0 || candidate.timeoutMs > MAX_EXECUTION_TIMEOUT_MS) {
    errors.push(kernelError("KERNEL_INVALID_TIMEOUT", `Execution envelope timeoutMs must be between 1 and ${MAX_EXECUTION_TIMEOUT_MS}`, {
      timeoutMs: typeof candidate.timeoutMs === "number" ? candidate.timeoutMs : String(candidate.timeoutMs)
    }));
  }
  if (typeof candidate.deadlineAt !== "string" || Number.isNaN(Date.parse(candidate.deadlineAt))) {
    errors.push(kernelError("KERNEL_INVALID_TIMEOUT", "Execution envelope deadlineAt must be a valid ISO date"));
  }
  const trace = candidate.trace as Record<string, unknown> | undefined;
  if (!trace || typeof trace !== "object" || typeof trace.traceId !== "string" || typeof trace.spanId !== "string" || typeof trace.correlationId !== "string" || typeof trace.sessionId !== "string") {
    errors.push(kernelError("KERNEL_MALFORMED_TRACE", "Execution envelope trace must include traceId, spanId, correlationId, and sessionId"));
  }
  if (!candidate.inputSchema || typeof candidate.inputSchema !== "object") {
    errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope inputSchema must be an object"));
  }
  if (!candidate.outputSchema || typeof candidate.outputSchema !== "object") {
    errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope outputSchema must be an object"));
  }
  if (!Array.isArray(candidate.permissions)) {
    errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope permissions must be an array"));
  }
  if (!Array.isArray(candidate.resourceLocks)) {
    errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope resourceLocks must be an array"));
  }
  if (!candidate.policyContext || typeof candidate.policyContext !== "object" || typeof (candidate.policyContext as Record<string, unknown>).caller !== "string") {
    errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope policyContext must include caller"));
  }
  if (!candidate.secretExposure || typeof candidate.secretExposure !== "object" || typeof (candidate.secretExposure as Record<string, unknown>).action !== "string") {
    errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope secretExposure decision is required"));
  }
  const resourceScope = candidate.resourceScope as Record<string, unknown> | undefined;
  if (!resourceScope || typeof resourceScope !== "object" || typeof resourceScope.schemaVersion !== "string" || !Array.isArray(resourceScope.paths)) {
    errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope resourceScope metadata is required"));
  }
  const sandboxRequirements = candidate.sandboxRequirements as Record<string, unknown> | undefined;
  if (!sandboxRequirements || typeof sandboxRequirements !== "object" || typeof sandboxRequirements.schemaVersion !== "string" || !Array.isArray(sandboxRequirements.capabilities)) {
    errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope sandboxRequirements metadata is required"));
  }
  if (!candidate.audit || typeof candidate.audit !== "object" || typeof (candidate.audit as Record<string, unknown>).reasonCode !== "string") {
    errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope audit metadata is required"));
  }
  if (["write", "network", "process"].includes(String(candidate.sideEffect))) {
    if (!sandboxRequirements || !Array.isArray(sandboxRequirements.capabilities) || sandboxRequirements.capabilities.length === 0) {
      errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Side-effecting envelope must declare sandbox capabilities"));
    }
    if (!resourceScope || !Array.isArray(resourceScope.paths)) {
      errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Side-effecting envelope must declare resource paths"));
    }
  }
  const cancellation = candidate.cancellation as Record<string, unknown> | undefined;
  if (!cancellation || typeof cancellation !== "object" || cancellation.cancellable !== true || cancellation.propagation !== "abort-signal") {
    errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope cancellation metadata must require abort-signal propagation"));
  }
  const retryPolicy = candidate.retryPolicy as Record<string, unknown> | undefined;
  if (!retryPolicy || typeof retryPolicy.maxAttempts !== "number" || retryPolicy.maxAttempts < 1) {
    errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope retryPolicy.maxAttempts must be positive"));
  }
  const idempotency = candidate.idempotency as Record<string, unknown> | undefined;
  if (!idempotency || typeof idempotency.key !== "string" || !idempotency.key) {
    errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope idempotency.key is required"));
  }
  const replayPolicy = candidate.replayPolicy as Record<string, unknown> | undefined;
  if (!replayPolicy || replayPolicy.replayable !== true || replayPolicy.snapshot !== "normalized") {
    errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope replayPolicy must be replayable normalized metadata"));
  }
  const telemetry = candidate.telemetry as Record<string, unknown> | undefined;
  if (!telemetry || typeof telemetry.eventSchemaVersion !== "string") {
    errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope telemetry.eventSchemaVersion is required"));
  }
  if (typeof candidate.createdAt !== "string" || Number.isNaN(Date.parse(candidate.createdAt))) {
    errors.push(kernelError("KERNEL_ENVELOPE_INVALID", "Execution envelope createdAt must be a valid ISO date"));
  }
  return errors;
}

export type WorkspacePathResolver = (workspaceRoot: string, inputPath: string) => { readonly ok: boolean; readonly value?: { readonly relativePath: string } };

export function resourceLocksFor(sideEffect: CapabilityManifest["sideEffect"], input: JsonObject, options: { readonly resolveWorkspacePath?: WorkspacePathResolver } = {}): readonly string[] {
  const locks: string[] = [];
  const path = typeof input.path === "string" ? input.path : undefined;
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.workspaceRoot === "string" ? input.workspaceRoot : undefined;
  const workspaceRoot = typeof input.workspaceRoot === "string" ? input.workspaceRoot : undefined;
  if (sideEffect === "write" && path) locks.push(`workspace:${workspaceLockKey(path, workspaceRoot, options.resolveWorkspacePath)}`);
  if (sideEffect === "write" && typeof input.patch === "string") {
    for (const patchPath of unifiedPatchTargetPaths(input.patch)) {
      locks.push(`workspace:${workspaceLockKey(patchPath, workspaceRoot, options.resolveWorkspacePath)}`);
    }
  }
  if (sideEffect === "write" && locks.length === 0) locks.push("workspace:.");
  if (sideEffect === "process") locks.push(`process:${workspaceLockKey(cwd ?? ".", workspaceRoot, options.resolveWorkspacePath)}`);
  return locks;
}

function workspaceLockKey(path: string, workspaceRoot: string | undefined, resolveWorkspacePath: WorkspacePathResolver | undefined): string {
  if (workspaceRoot && resolveWorkspacePath) {
    const resolved = resolveWorkspacePath(workspaceRoot, path);
    if (resolved.ok) return resolved.value?.relativePath || ".";
  }
  return normalizeWorkspaceResourceLockKey(path, workspaceRoot);
}

function unifiedPatchTargetPaths(patch: string): readonly string[] {
  const paths: string[] = [];
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    const oldHeader = lines[index];
    const newHeader = lines[index + 1];
    if (!oldHeader?.startsWith("--- ") || !newHeader?.startsWith("+++ ")) continue;
    const path = normalizeUnifiedPatchPath(newHeader.slice(4).trim()) ?? normalizeUnifiedPatchPath(oldHeader.slice(4).trim());
    if (path) paths.push(path);
  }
  return [...new Set(paths)];
}

function normalizeUnifiedPatchPath(headerPath: string): string | undefined {
  const path = headerPath.split(/\s+/)[0]?.replace(/\\/g, "/") ?? "";
  if (!path || path === "/dev/null") return undefined;
  return path.replace(/^[ab]\//, "");
}

export function policyMetadataFor(envelope: ExecutionEnvelope, input: JsonObject): JsonObject {
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof input.workspaceRoot === "string" ? input.workspaceRoot : undefined;
  return {
    envelopeId: envelope.invocationId,
    sideEffect: envelope.sideEffect,
    permissions: envelope.permissions,
    capabilityId: envelope.capabilityId,
    timeoutMs: envelope.timeoutMs,
    resourceLocks: envelope.resourceLocks,
    secretExposure: envelope.secretExposure,
    resourceScope: envelope.resourceScope,
    sandboxRequirements: envelope.sandboxRequirements,
    audit: envelope.audit,
    ...(typeof input.command === "string" ? { command: input.command, args: Array.isArray(input.args) ? input.args.map(String) : [] } : {}),
    ...(cwd ? { cwd } : {}),
    ...(typeof input.workspaceRoot === "string" ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(typeof input.shellProfile === "string" ? { shellProfile: input.shellProfile } : {}),
    ...(input.requireSandbox === true ? { requireSandbox: true } : {})
  };
}
