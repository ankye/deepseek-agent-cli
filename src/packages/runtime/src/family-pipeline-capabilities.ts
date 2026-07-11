import { createHash } from "node:crypto";
import type {
  CapabilityExecutionContext,
  CapabilityId,
  CapabilityManifest,
  ExecutionEnvelope,
  JsonObject,
  RedactedError,
  SerializableResult,
  ToolFamilyArtifactRef,
  ToolFamilyId,
  ToolFamilyPipelineRecord,
  ToolFamilyPipelineStepRecord
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import {
  analyzeResourceScope,
  createSandboxAuditEvidence,
  createSandboxRequirement,
  createSecretRedactionDecision
} from "@deepseek/policy-sandbox";
import type { RuntimeFamilyCapabilityDependencies } from "./family-capabilities.js";
import { runtimeFamilyCapabilityIds } from "./family-capabilities.js";
import { resourceLocksFor } from "./envelope.js";
import { normalizeResourceLockStrings, resourceLockStringsConflict } from "./resource-locks.js";
import type { ResourceLockNormalizationOptions } from "./resource-locks.js";

const MAX_PIPELINE_STEPS = 16;
const DEFAULT_ARTIFACT_LIMIT_BYTES = 16_000;
const RUNTIME_CREATED_AT = new Date(0).toISOString();

interface PipelineStepInput extends JsonObject {
  readonly stepId?: string;
  readonly capabilityId?: string;
  readonly input?: JsonObject;
  readonly inputArtifactIds?: readonly string[];
  readonly inputFromArtifacts?: JsonObject;
  readonly resourceLocks?: readonly string[];
  readonly lockScope?: readonly string[];
}

interface PipelineStepFields {
  readonly stepId?: string;
  readonly capabilityId?: string;
  readonly input?: JsonObject;
  readonly inputArtifactIds?: readonly string[];
  readonly inputFromArtifacts?: JsonObject;
  readonly resourceLocks?: readonly string[];
  readonly lockScope?: readonly string[];
}

interface ResolvedPipelineStep extends PipelineStepFields {
  readonly manifest?: CapabilityManifest;
  readonly inferredResourceLocks: readonly string[];
}

interface PipelineExecutionState {
  readonly deps: RuntimeFamilyCapabilityDependencies;
  readonly context: CapabilityExecutionContext;
  readonly pipelineId: string;
  readonly pipelineFamilyId: ToolFamilyId;
  readonly artifactLimitBytes: number;
  readonly workspaceRoot: string;
  readonly artifactsById: Map<string, ToolFamilyArtifactRef>;
  readonly artifactValuesById: Map<string, JsonObject>;
}

export async function executePipeline(
  input: JsonObject,
  context: CapabilityExecutionContext,
  deps: RuntimeFamilyCapabilityDependencies,
  workspaceRoot: string,
  familyId: ToolFamilyId,
  kind: ToolFamilyPipelineRecord["kind"]
): Promise<SerializableResult> {
  if (context.signal.aborted) return failure("PIPELINE_CANCELLED", context.cancellationReason ?? "Pipeline cancelled.");
  const pipelineId = stringValue(input.pipelineId) ?? `pipeline:${hash(`${context.envelope.invocationId}:${familyId}`)}`;
  const artifactLimitBytes = boundedPositiveInteger(input.artifactLimitBytes, DEFAULT_ARTIFACT_LIMIT_BYTES, 64_000);
  const steps = stepInputs(input.steps);
  if (steps.length > MAX_PIPELINE_STEPS) {
    return failure("PIPELINE_TOO_MANY_STEPS", `Pipeline is limited to ${MAX_PIPELINE_STEPS} steps.`);
  }
  if (kind === "stream" && steps.length === 0) {
    return success(executeStreamOnly(input, context, pipelineId, familyId, artifactLimitBytes));
  }
  if (steps.length === 0) return failure("PIPELINE_STEPS_REQUIRED", "Pipeline must contain at least one step.");
  const resolvedSteps = await resolvePipelineSteps(deps, steps, workspaceRoot);
  const platformDescriptor = await deps.platform.descriptor();
  if (kind === "parallel") {
    const artifactDependency = firstParallelArtifactDependency(resolvedSteps);
    if (artifactDependency) return failure("PIPELINE_PARALLEL_ARTIFACT_DEPENDENCY", `Parallel pipeline step depends on sibling artifact input: ${artifactDependency}. Use pipeline.sequence or pipeline.artifact-routing for ordered artifact flow.`);
    const conflict = firstLockConflict(resolvedSteps, {
      workspaceRoot,
      caseSensitive: platformDescriptor.filesystem.caseSensitive
    });
    if (conflict) return failure("PIPELINE_LOCK_CONFLICT", `Parallel pipeline has overlapping resource lock: ${conflict}.`);
  }

  const state: PipelineExecutionState = {
    deps,
    context,
    pipelineId,
    pipelineFamilyId: familyId,
    artifactLimitBytes,
    workspaceRoot,
    artifactsById: new Map(),
    artifactValuesById: new Map()
  };

  const records = kind === "parallel"
    ? await Promise.all(resolvedSteps.map((step, index) => executePipelineStep(state, step, index)))
    : await executeStepsInOrder(state, resolvedSteps);
  const status = records.every((record) => record.status === "executed") ? "completed" : records.some((record) => record.status === "cancelled") ? "cancelled" : "failed";
  const record: ToolFamilyPipelineRecord = {
    pipelineId,
    kind,
    familyId,
    status,
    startedAt: RUNTIME_CREATED_AT,
    finishedAt: RUNTIME_CREATED_AT,
    steps: records,
    artifacts: [...state.artifactsById.values()],
    replayRef: `replay:${hash(`${pipelineId}:${JSON.stringify(records.map((record) => record.status))}`)}`,
    redaction: { class: "internal", fields: ["artifacts.preview"] }
  };
  const value = {
    record,
    artifacts: record.artifacts,
    evidence: {
      familyId,
      pipelineRecords: [record],
      replay: replay(context),
      redaction: { class: "internal", fields: ["record.artifacts.preview"] }
    }
  };
  return status === "completed" ? success(value) : { ok: false, value, error: diag("PIPELINE_STEP_FAILED", "One or more pipeline steps failed.") };
}

async function executeStepsInOrder(state: PipelineExecutionState, steps: readonly ResolvedPipelineStep[]): Promise<readonly ToolFamilyPipelineStepRecord[]> {
  const records: ToolFamilyPipelineStepRecord[] = [];
  for (let index = 0; index < steps.length; index += 1) {
    const record = await executePipelineStep(state, steps[index] ?? { inferredResourceLocks: [] }, index);
    records.push(record);
    if (record.status !== "executed") break;
  }
  return records;
}

async function executePipelineStep(
  state: PipelineExecutionState,
  step: ResolvedPipelineStep,
  index: number
): Promise<ToolFamilyPipelineStepRecord> {
  const stepId = stringValue(step.stepId) ?? `step-${index + 1}`;
  const capabilityId = stringValue(step.capabilityId);
  if (!capabilityId) {
    return stepRecord(state, stepId, runtimeFamilyCapabilityIds.pipelineSequence, index, "failed", [], [], "missing capabilityId");
  }
  if (state.context.signal.aborted) {
    return stepRecord(state, stepId, asId<"capability">(capabilityId), index, "cancelled", artifactIds(step.inputArtifactIds), [], state.context.cancellationReason ?? "cancelled");
  }
  const manifest = step.manifest ?? await state.deps.capabilities.get(asId<"capability">(capabilityId));
  if (!manifest) {
    return stepRecord(state, stepId, asId<"capability">(capabilityId), index, "failed", artifactIds(step.inputArtifactIds), [], "capability not found");
  }
  const stepInput = withWorkspaceRootDefault(materializeStepInput(step, state), state.workspaceRoot);
  const visible = await state.deps.capabilities.listModelVisible();
  const descriptor = await state.deps.platform.descriptor();
  const preflight = await state.deps.toolIntentPreflight.check({
    intent: { toolCallId: stepId, name: capabilityId, input: stepInput, source: "host" },
    workspaceRoot: state.workspaceRoot,
    platform: descriptor.os,
    modelVisibleCapabilities: visible.map((visibleManifest) => visibleManifest.id)
  });
  if (preflight.status === "rejected" || !preflight.capabilityId) {
    return stepRecord(state, stepId, manifest.id, index, "failed", artifactIds(step.inputArtifactIds), [], preflight.diagnostics[0]?.message ?? "preflight rejected", "rejected");
  }
  const effectiveStepInput = withWorkspaceRootDefault(preflight.repaired?.input ?? stepInput, state.workspaceRoot);
  const stepResourceScope = analyzeResourceScope(effectiveStepInput, manifest.sideEffect);
  const stepSecretExposure = createSecretRedactionDecision(effectiveStepInput, { class: "internal" });
  const stepSandboxRequirements = createSandboxRequirement({
    sideEffect: manifest.sideEffect,
    resourceScope: stepResourceScope,
    timeoutMs: manifest.timeoutMs ?? 30_000,
    permissions: manifest.permissions
  });
  const stepAudit = createSandboxAuditEvidence({
    decision: "pending",
    reasonCode: "pipeline.step.policy",
    subject: "runtime.pipeline",
    resource: String(preflight.capabilityId),
    sandboxProfile: stepSandboxRequirements.profile,
    trace: state.context.trace,
    metadata: {
      pipelineId: state.pipelineId,
      stepId,
      parentInvocationId: state.context.envelope.invocationId,
      capabilityId: preflight.capabilityId,
      sideEffect: manifest.sideEffect
    }
  });
  const policy = await state.deps.policy.decide({
    subject: "runtime.pipeline",
    action: `execute:${String(preflight.capabilityId)}`,
    resource: String(preflight.capabilityId),
    metadata: {
      sideEffect: manifest.sideEffect,
      permissions: manifest.permissions,
      timeoutMs: manifest.timeoutMs ?? 30_000,
      resourceLocks: resourceLocksFor(manifest.sideEffect, effectiveStepInput, { resolveWorkspacePath: state.deps.platform.resolveWorkspacePath.bind(state.deps.platform) }),
      secretExposure: stepSecretExposure,
      resourceScope: stepResourceScope,
      sandboxRequirements: stepSandboxRequirements,
      audit: stepAudit,
      pipelineId: state.pipelineId,
      stepId,
      parentInvocationId: state.context.envelope.invocationId
    },
    secret: stepSecretExposure,
    resourceScope: stepResourceScope,
    sandbox: stepSandboxRequirements,
    auditEvidence: stepAudit
  });
  if (policy.action !== "allow") {
    return stepRecord(state, stepId, manifest.id, index, "failed", artifactIds(step.inputArtifactIds), [], `policy ${policy.action}: ${policy.reason}`, policy.action);
  }
  const result = await state.deps.capabilities.execute(preflight.capabilityId, effectiveStepInput, childExecutionContext(state.context, manifest.id, stepId));
  const artifact = artifactFromValue(state, stepId, manifest.toolFamily?.familyId ?? state.pipelineFamilyId, result.ok ? result.value ?? {} : { error: result.error ?? diag("CAPABILITY_FAILED", "Capability failed.") });
  state.artifactsById.set(artifact.artifactId, artifact);
  state.artifactValuesById.set(artifact.artifactId, result.ok ? result.value ?? {} : { error: result.error ?? diag("CAPABILITY_FAILED", "Capability failed.") });
  return stepRecord(
    state,
    stepId,
    manifest.id,
    index,
    result.ok ? "executed" : "failed",
    artifactIds(step.inputArtifactIds),
    [artifact],
    result.ok ? undefined : result.error?.message ?? "capability failed",
    policy.action
  );
}

function executeStreamOnly(
  input: JsonObject,
  context: CapabilityExecutionContext,
  pipelineId: string,
  familyId: ToolFamilyId,
  artifactLimitBytes: number
): JsonObject {
  const rawChunks = Array.isArray(input.chunks) ? input.chunks : typeof input.stream === "string" ? [input.stream] : [];
  const text = rawChunks.map((chunk) => typeof chunk === "string" ? chunk : JSON.stringify(chunk)).join("");
  const bounded = boundText(text, artifactLimitBytes);
  const artifact = artifactRef({
    familyId,
    artifactId: `${pipelineId}:stream`,
    kind: "stream",
    text: bounded.text,
    byteLength: bounded.byteLength,
    truncated: bounded.truncated
  });
  const record: ToolFamilyPipelineRecord = {
    pipelineId,
    kind: "stream",
    familyId,
    status: context.signal.aborted ? "cancelled" : "completed",
    startedAt: RUNTIME_CREATED_AT,
    finishedAt: RUNTIME_CREATED_AT,
    steps: [],
    artifacts: [artifact],
    replayRef: `replay:${hash(`${pipelineId}:${bounded.text}`)}`,
    redaction: { class: "internal", fields: ["artifacts.preview"] }
  };
  return {
    record,
    artifacts: [artifact],
    evidence: {
      familyId,
      pipelineRecords: [record],
      chunkCount: rawChunks.length,
      backpressure: { limitBytes: artifactLimitBytes, truncated: bounded.truncated },
      replay: replay(context),
      redaction: { class: "internal", fields: ["record.artifacts.preview"] }
    }
  };
}

function childExecutionContext(parent: CapabilityExecutionContext, capabilityId: CapabilityId, stepId: string): CapabilityExecutionContext {
  const envelope: ExecutionEnvelope = {
    ...parent.envelope,
    invocationId: `${parent.envelope.invocationId}:${stepId}`,
    capabilityId,
    parentInvocationId: parent.envelope.invocationId
  };
  return {
    envelope,
    trace: parent.trace,
    signal: parent.signal,
    ...(parent.cancellationReason ? { cancellationReason: parent.cancellationReason } : {}),
    metadata: {
      ...parent.metadata,
      parentInvocationId: parent.envelope.invocationId,
      pipelineStepId: stepId
    }
  };
}

function materializeStepInput(step: PipelineStepFields, state: PipelineExecutionState): JsonObject {
  const fromArtifacts = step.inputFromArtifacts && typeof step.inputFromArtifacts === "object" ? step.inputFromArtifacts : {};
  const artifactFields: Record<string, JsonObject> = {};
  for (const [field, artifactId] of Object.entries(fromArtifacts)) {
    if (typeof artifactId !== "string") continue;
    const value = state.artifactValuesById.get(artifactId);
    if (value) artifactFields[field] = value;
  }
  return {
    ...artifactFields,
    ...((step.input && typeof step.input === "object") ? step.input : {})
  };
}

function stepRecord(
  state: PipelineExecutionState,
  stepId: string,
  capabilityId: CapabilityId,
  index: number,
  status: ToolFamilyPipelineStepRecord["status"],
  inputArtifactIds: readonly string[],
  outputArtifacts: readonly ToolFamilyArtifactRef[],
  diagnostic?: string,
  policyDecision?: string
): ToolFamilyPipelineStepRecord {
  return {
    stepId,
    capabilityId,
    familyId: outputArtifacts[0]?.familyId ?? state.pipelineFamilyId,
    sequence: index + 1,
    status,
    inputArtifactIds,
    outputArtifacts,
    ...(policyDecision ? { policyDecision } : {}),
    replayRef: `replay:${hash(`${state.pipelineId}:${stepId}:${status}`)}`,
    diagnostics: diagnostic ? [diagnostic] : [],
    redaction: { class: "internal" }
  };
}

function artifactFromValue(
  state: PipelineExecutionState,
  stepId: string,
  familyId: ToolFamilyId,
  value: JsonObject
): ToolFamilyArtifactRef {
  const text = JSON.stringify(value);
  const bounded = boundText(text, state.artifactLimitBytes);
  return artifactRef({
    familyId,
    artifactId: `${state.pipelineId}:${stepId}:output`,
    kind: "json",
    text: bounded.text,
    byteLength: bounded.byteLength,
    truncated: bounded.truncated
  });
}

function artifactRef(input: {
  readonly familyId: ToolFamilyId;
  readonly artifactId: string;
  readonly kind: ToolFamilyArtifactRef["kind"];
  readonly text: string;
  readonly byteLength: number;
  readonly truncated: boolean;
}): ToolFamilyArtifactRef {
  return {
    artifactId: input.artifactId,
    familyId: input.familyId,
    kind: input.kind,
    mimeType: input.kind === "json" ? "application/json" : "text/plain",
    byteLength: input.byteLength,
    sha256: hash(input.text),
    preview: input.text,
    truncated: input.truncated,
    createdAt: RUNTIME_CREATED_AT,
    redaction: { class: "internal", fields: ["preview"] }
  };
}

async function resolvePipelineSteps(
  deps: RuntimeFamilyCapabilityDependencies,
  steps: readonly PipelineStepInput[],
  workspaceRoot: string
): Promise<readonly ResolvedPipelineStep[]> {
  return Promise.all(steps.map(async (step): Promise<ResolvedPipelineStep> => {
    const capabilityId = stringValue(step.capabilityId);
    const manifest = capabilityId ? await deps.capabilities.get(asId<"capability">(capabilityId)) : undefined;
    const stepInput = withWorkspaceRootDefault(step.input && typeof step.input === "object" ? step.input : {}, workspaceRoot);
    return {
      ...step,
      input: stepInput,
      ...(manifest ? { manifest } : {}),
      inferredResourceLocks: manifest ? resourceLocksFor(manifest.sideEffect, stepInput, { resolveWorkspacePath: deps.platform.resolveWorkspacePath.bind(deps.platform) }) : []
    };
  }));
}

function withWorkspaceRootDefault(input: JsonObject, workspaceRoot: string): JsonObject {
  return typeof input.workspaceRoot === "string" ? input : { ...input, workspaceRoot };
}

function firstLockConflict(steps: readonly ResolvedPipelineStep[], lockOptions: ResourceLockNormalizationOptions): string | undefined {
  const previousStepLocks: string[] = [];
  for (const step of steps) {
    const stepLocks = normalizeResourceLockStrings([...stringArray(step.resourceLocks), ...stringArray(step.lockScope), ...step.inferredResourceLocks], lockOptions);
    for (const lock of stepLocks) {
      if (previousStepLocks.some((previous) => resourceLockStringsConflict(previous, lock))) return lock;
    }
    previousStepLocks.push(...stepLocks);
  }
  return undefined;
}

function firstParallelArtifactDependency(steps: readonly ResolvedPipelineStep[]): string | undefined {
  for (const step of steps) {
    const fromArtifacts = step.inputFromArtifacts && typeof step.inputFromArtifacts === "object" ? step.inputFromArtifacts : {};
    const dependency = Object.entries(fromArtifacts).find((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
    if (dependency) return `${stringValue(step.stepId) ?? "unnamed-step"}.${dependency[0]} -> ${dependency[1]}`;
  }
  return undefined;
}

function stepInputs(value: unknown): readonly PipelineStepInput[] {
  return Array.isArray(value) ? value.filter((item): item is PipelineStepInput => typeof item === "object" && item !== null) : [];
}

function artifactIds(value: unknown): readonly string[] {
  return stringArray(value).slice(0, MAX_PIPELINE_STEPS);
}

function success(value: JsonObject): SerializableResult {
  return { ok: true, value };
}

function failure(code: string, message: string, value?: JsonObject): SerializableResult {
  return {
    ok: false,
    ...(value ? { value } : {}),
    error: diag(code, message)
  };
}

function diag(code: string, message: string): RedactedError {
  return {
    code,
    message,
    retryable: false,
    redaction: { class: "internal" }
  };
}

function replay(context: CapabilityExecutionContext): JsonObject {
  return {
    envelopeId: context.envelope.invocationId,
    traceId: context.trace.traceId,
    snapshot: "runtime-family-capability"
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function boundedPositiveInteger(value: unknown, fallback: number, max: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(0, Math.min(max, numeric));
}

function boundText(text: string, limitBytes: number): { readonly text: string; readonly byteLength: number; readonly truncated: boolean } {
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength <= limitBytes) return { text, byteLength, truncated: false };
  let bytes = 0;
  const chunks: string[] = [];
  for (const character of text) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > limitBytes) break;
    chunks.push(character);
    bytes += nextBytes;
  }
  return { text: chunks.join(""), byteLength, truncated: true };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
