import {
  STAGED_TASK_COMPATIBILITY,
  STAGED_TASK_SCHEMA_VERSION,
  type JsonObject,
  type RedactedError,
  type StagedTaskCompiledProfile,
  type StagedTaskExecutorKind,
  type StagedTaskGraph,
  type StagedTaskProfileRecord,
  type StagedTaskRef,
  type StagedTaskRefScope,
  type StagedTaskRefType,
  type StagedTaskStageContract,
  type StagedTaskStagePatch
} from "@deepseek/platform-contracts";

export interface CompileTaskProfileOptions {
  readonly overlays?: readonly string[];
  readonly parameters?: JsonObject;
}

interface ProfileOverlay {
  readonly overlayId: string;
  readonly stagePatches: readonly StagedTaskStagePatch[];
}

const COMPILER_VERSION = "task-profile-compiler.v1";
const MAX_DYNAMIC_STAGE_COUNT = 24;
const MAX_MODEL_ITERATIONS = 64;
const MAX_TOOL_CALLS = 512;
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const ALLOWED_EXECUTORS = new Set<StagedTaskExecutorKind>([
  "file-materialize",
  "agent-loop",
  "process-check",
  "artifact-scan",
  "manual"
]);

const FRAGMENT_STAGES: Readonly<Record<string, readonly StagedTaskStagePatch[]>> = {
  "fragment/materialize-workspace.v1": [{
    stageId: "stage:materialize-workspace",
    kind: "materialize",
    executorKind: "file-materialize",
    dependsOn: [],
    expectedOutputRefs: ["ref:workspace-root"]
  }],
  "fragment/collect-project-evidence.v1": [{
    stageId: "stage:collect-evidence",
    kind: "collect-evidence",
    executorKind: "process-check",
    dependsOn: [],
    inputRefs: ["ref:workspace-root"],
    expectedOutputRefs: ["ref:project-evidence"]
  }],
  "fragment/agent-produce-artifacts.v1": [{
    stageId: "stage:produce-artifacts",
    kind: "produce",
    executorKind: "agent-loop",
    dependsOn: ["stage:collect-evidence"],
    inputRefs: ["ref:project-evidence"],
    expectedOutputRefs: ["ref:generated-artifact"],
    allowedTools: ["workspace.read", "workspace.write", "process.exec"],
    budget: {
      maxModelIterations: 8,
      maxToolCalls: 24,
      maxOutputBytes: 200_000,
      timeoutMs: 600_000
    },
    acceptance: {
      requiredRefs: ["ref:generated-artifact"],
      requiredStatuses: ["succeeded"]
    },
    retryPolicy: {
      maxAttempts: 1,
      retryOn: ["checker-failed", "missing-artifact"]
    }
  }],
  "fragment/process-check.v1": [{
    stageId: "stage:run-check",
    kind: "verify",
    executorKind: "process-check",
    dependsOn: ["stage:produce-artifacts"],
    inputRefs: ["ref:generated-artifact"],
    expectedOutputRefs: ["ref:process-check"],
    budget: {
      timeoutMs: 120_000
    },
    acceptance: {
      requiredRefs: ["ref:process-check"],
      requiredStatuses: ["succeeded"]
    }
  }],
  "fragment/artifact-scan.v1": [{
    stageId: "stage:artifact-scan",
    kind: "artifact-scan",
    executorKind: "artifact-scan",
    dependsOn: ["stage:produce-artifacts"],
    inputRefs: ["ref:generated-artifact"],
    expectedOutputRefs: ["ref:artifact-scan"],
    acceptance: {
      requiredRefs: ["ref:artifact-scan"]
    }
  }],
  "fragment/score-task.v1": [{
    stageId: "stage:score-task",
    kind: "score",
    executorKind: "manual",
    dependsOn: ["stage:run-check", "stage:artifact-scan"],
    inputRefs: ["ref:process-check", "ref:artifact-scan"],
    expectedOutputRefs: ["ref:task-score"]
  }]
};

const OVERLAYS: Readonly<Record<string, ProfileOverlay>> = {
  "overlay/live-glm-expanded-budget.v1": {
    overlayId: "overlay/live-glm-expanded-budget.v1",
    stagePatches: [{
      stageId: "stage:produce-artifacts",
      budget: {
        maxModelIterations: 16,
        maxToolCalls: 48,
        maxOutputBytes: 500_000,
        timeoutMs: 1_200_000,
        modelProfileHint: "glm-5.1"
      }
    }]
  },
  "overlay/strict-evidence-manifest.v1": {
    overlayId: "overlay/strict-evidence-manifest.v1",
    stagePatches: [{
      stageId: "stage:artifact-scan",
      acceptance: {
        requiredRefs: ["ref:artifact-scan"],
        requiredChecks: ["evidence-manifest", "unsupported-claims-zero"]
      }
    }]
  },
  "overlay/no-remote-dependencies.v1": {
    overlayId: "overlay/no-remote-dependencies.v1",
    stagePatches: [{
      stageId: "stage:produce-artifacts",
      allowedTools: ["workspace.read", "workspace.write"]
    }]
  }
};

export function compileTaskProfile(
  profile: StagedTaskProfileRecord,
  options: CompileTaskProfileOptions = {}
): StagedTaskCompiledProfile {
  const appliedOverlays = uniqueStrings([...(profile.overlays ?? []), ...(options.overlays ?? [])]);
  const parameters = mergeJson(profile.parameters, options.parameters);
  const stages = buildStages(profile, appliedOverlays, parameters);
  validateGraphShape(profile, stages);
  const refs = buildRefs(stages);
  const profileSource = profile.source ?? "catalog";
  const fingerprint = createFingerprint({
    compilerVersion: COMPILER_VERSION,
    profileId: profile.profileId,
    baseProfileId: profile.baseProfileId,
    fragments: profile.fragments,
    overlays: appliedOverlays,
    parameters,
    stages,
    profileSource,
    scope: profile.scope ?? (profileSource === "dynamic" ? "task-run" : "catalog")
  });
  const graph: StagedTaskGraph = {
    schemaVersion: STAGED_TASK_SCHEMA_VERSION,
    graphId: `graph:${profile.profileId}:${fingerprint}`,
    profileId: profile.profileId,
    stages,
    refs,
    metadata: {
      compilerVersion: COMPILER_VERSION,
      profileSource,
      profileScope: profile.scope ?? (profileSource === "dynamic" ? "task-run" : "catalog"),
      fingerprint
    },
    compatibility: STAGED_TASK_COMPATIBILITY,
    redaction: { class: profileSource === "dynamic" ? "internal" : "public", fields: ["metadata.fingerprint"] }
  };

  return {
    schemaVersion: STAGED_TASK_SCHEMA_VERSION,
    profileId: profile.profileId,
    fingerprint,
    graph,
    sourceProfile: profileWithCompilationMetadata(profile, profileSource, parameters),
    appliedFragments: profile.fragments,
    appliedOverlays,
    compatibility: STAGED_TASK_COMPATIBILITY,
    redaction: { class: profileSource === "dynamic" ? "internal" : "public", fields: ["sourceProfile.provenance.reason"] }
  };
}

function buildStages(
  profile: StagedTaskProfileRecord,
  appliedOverlays: readonly string[],
  parameters: JsonObject | undefined
): readonly StagedTaskStageContract[] {
  const stages = new Map<string, StagedTaskStageContract>();
  for (const fragmentId of profile.fragments) {
    const fragmentStages = FRAGMENT_STAGES[fragmentId];
    if (!fragmentStages) {
      throw new Error(`unknown fragment: ${fragmentId}`);
    }
    for (const patch of fragmentStages) {
      addStage(stages, patch, `fragment ${fragmentId}`);
    }
  }

  for (const overlayId of appliedOverlays) {
    const overlay = OVERLAYS[overlayId];
    if (!overlay) {
      throw new Error(`unknown overlay: ${overlayId}`);
    }
    for (const patch of overlay.stagePatches) {
      applyStagePatch(stages, patch, `overlay ${overlayId}`);
    }
  }

  const seenLocalPatches = new Set<string>();
  for (const patch of profile.stagePatches ?? []) {
    if (seenLocalPatches.has(patch.stageId)) {
      throw new Error(`duplicate stage id in profile patch: ${patch.stageId}`);
    }
    seenLocalPatches.add(patch.stageId);
    applyStagePatch(stages, patch, `profile ${profile.profileId}`);
  }

  return [...stages.values()].map((stage) => {
    const stageParameters = mergeJson(stage.parameters, parameters);
    return stageParameters ? { ...stage, parameters: stageParameters } : stage;
  });
}

function addStage(
  stages: Map<string, StagedTaskStageContract>,
  patch: StagedTaskStagePatch,
  source: string
): void {
  if (stages.has(patch.stageId)) {
    throw new Error(`duplicate stage id from ${source}: ${patch.stageId}`);
  }
  stages.set(patch.stageId, createStageFromPatch(patch, source));
}

function applyStagePatch(
  stages: Map<string, StagedTaskStageContract>,
  patch: StagedTaskStagePatch,
  source: string
): void {
  const existing = stages.get(patch.stageId);
  if (!existing) {
    addStage(stages, patch, source);
    return;
  }
  const budget = mergeJson(existing.budget, patch.budget);
  const acceptance = mergeJson(existing.acceptance, patch.acceptance);
  const retryPolicy = mergeJson(existing.retryPolicy, patch.retryPolicy);
  const parameters = mergeJson(existing.parameters, patch.parameters);
  stages.set(patch.stageId, {
    ...existing,
    ...(patch.kind ? { kind: patch.kind } : {}),
    ...(patch.executorKind ? { executorKind: patch.executorKind } : {}),
    ...(patch.dependsOn ? { dependsOn: patch.dependsOn } : {}),
    ...(patch.inputRefs ? { inputRefs: patch.inputRefs } : {}),
    ...(patch.expectedOutputRefs ? { expectedOutputRefs: patch.expectedOutputRefs } : {}),
    ...(patch.allowedTools ? { allowedTools: patch.allowedTools } : {}),
    ...(budget ? { budget } : {}),
    ...(acceptance ? { acceptance } : {}),
    ...(retryPolicy ? { retryPolicy } : {}),
    ...(parameters ? { parameters } : {}),
    ...(patch.redaction ? { redaction: patch.redaction } : {})
  });
}

function createStageFromPatch(patch: StagedTaskStagePatch, source: string): StagedTaskStageContract {
  if (!patch.kind || !patch.executorKind) {
    throw new Error(`stage patch from ${source} must declare kind and executorKind: ${patch.stageId}`);
  }
  return {
    schemaVersion: STAGED_TASK_SCHEMA_VERSION,
    stageId: patch.stageId,
    kind: patch.kind,
    executorKind: patch.executorKind,
    dependsOn: patch.dependsOn ?? [],
    inputRefs: patch.inputRefs ?? [],
    expectedOutputRefs: patch.expectedOutputRefs ?? [],
    ...(patch.allowedTools ? { allowedTools: patch.allowedTools } : {}),
    ...(patch.budget ? { budget: patch.budget } : {}),
    ...(patch.acceptance ? { acceptance: patch.acceptance } : {}),
    ...(patch.retryPolicy ? { retryPolicy: patch.retryPolicy } : {}),
    ...(patch.parameters ? { parameters: patch.parameters } : {}),
    compatibility: STAGED_TASK_COMPATIBILITY,
    redaction: patch.redaction ?? { class: "internal", fields: ["parameters"] }
  };
}

function validateGraphShape(profile: StagedTaskProfileRecord, stages: readonly StagedTaskStageContract[]): void {
  if ((profile.source ?? "catalog") === "dynamic" && stages.length > MAX_DYNAMIC_STAGE_COUNT) {
    throw new Error(`dynamic profile exceeds stage-count cap: ${stages.length}`);
  }
  const stageIds = new Set(stages.map((stage) => stage.stageId));
  const outputRefs = new Set<string>();
  for (const stage of stages) {
    if (!ALLOWED_EXECUTORS.has(stage.executorKind)) {
      throw new Error(`unsupported executor kind: ${stage.executorKind}`);
    }
    validateBudget(stage);
    for (const dependency of stage.dependsOn) {
      if (!stageIds.has(dependency)) {
        throw new Error(`unknown stage dependency: ${stage.stageId} -> ${dependency}`);
      }
    }
    for (const refId of stage.expectedOutputRefs) {
      if (outputRefs.has(refId)) {
        throw new Error(`duplicate output ref: ${refId}`);
      }
      outputRefs.add(refId);
    }
  }
  assertNoDependencyCycle(stages);
}

function profileWithCompilationMetadata(
  profile: StagedTaskProfileRecord,
  profileSource: NonNullable<StagedTaskProfileRecord["source"]>,
  parameters: JsonObject | undefined
): StagedTaskProfileRecord {
  return {
    ...profile,
    source: profileSource,
    scope: profile.scope ?? (profileSource === "dynamic" ? "task-run" : "catalog"),
    ...(parameters ? { parameters } : {})
  };
}

function validateBudget(stage: StagedTaskStageContract): void {
  const budget = stage.budget;
  if (!budget) return;
  if (budget.maxModelIterations !== undefined && budget.maxModelIterations > MAX_MODEL_ITERATIONS) {
    throw new Error(`stage budget exceeds maxModelIterations cap: ${stage.stageId}`);
  }
  if (budget.maxToolCalls !== undefined && budget.maxToolCalls > MAX_TOOL_CALLS) {
    throw new Error(`stage budget exceeds maxToolCalls cap: ${stage.stageId}`);
  }
  if (budget.maxOutputBytes !== undefined && budget.maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw new Error(`stage budget exceeds maxOutputBytes cap: ${stage.stageId}`);
  }
  if (budget.timeoutMs !== undefined && budget.timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`stage budget exceeds timeoutMs cap: ${stage.stageId}`);
  }
}

function assertNoDependencyCycle(stages: readonly StagedTaskStageContract[]): void {
  const byId = new Map(stages.map((stage) => [stage.stageId, stage]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(stageId: string): void {
    if (visited.has(stageId)) return;
    if (visiting.has(stageId)) {
      throw new Error(`dependency cycle detected at ${stageId}`);
    }
    visiting.add(stageId);
    const stage = byId.get(stageId);
    if (stage) {
      for (const dependency of stage.dependsOn) {
        visit(dependency);
      }
    }
    visiting.delete(stageId);
    visited.add(stageId);
  }

  for (const stage of stages) {
    visit(stage.stageId);
  }
}

function buildRefs(stages: readonly StagedTaskStageContract[]): readonly StagedTaskRef[] {
  const refs: StagedTaskRef[] = [];
  for (const stage of stages) {
    for (const refId of stage.expectedOutputRefs) {
      const type = inferRefType(refId);
      refs.push({
        schemaVersion: STAGED_TASK_SCHEMA_VERSION,
        refId,
        type,
        producerStageId: stage.stageId,
        scope: inferRefScope(type),
        compatibility: STAGED_TASK_COMPATIBILITY,
        redaction: { class: type === "artifact" ? "internal" : "public", fields: type === "artifact" ? ["path", "preview"] : [] }
      });
    }
  }
  return refs;
}

function inferRefType(refId: string): StagedTaskRefType {
  if (refId.includes("evidence")) return "evidence";
  if (refId.includes("check")) return "check";
  if (refId.includes("score") || refId.includes("metric")) return "metric";
  if (refId.includes("scan") || refId.includes("diagnostic")) return "diagnostic";
  if (refId.includes("workspace") || refId.includes("state")) return "state";
  return "artifact";
}

function inferRefScope(type: StagedTaskRefType): StagedTaskRefScope {
  return type === "artifact" || type === "state" ? "workspace" : "task";
}

function mergeJson<T extends JsonObject>(base: T | undefined, overlay: T | undefined): T | undefined {
  if (!base && !overlay) return undefined;
  return { ...(base ?? {}), ...(overlay ?? {}) } as T;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function createFingerprint(value: JsonObject): string {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createStagedTaskDiagnostic(code: string, message: string): RedactedError {
  return {
    code,
    message,
    retryable: false,
    redaction: { class: "internal", fields: ["message"] }
  };
}
