import type {
  AgentLoopRequest,
  AgentLoopProfilePolicyMetadata,
  CapabilityManifest,
  JsonObject,
  RedactedError,
  RuntimeDependencies,
  RuntimeEvent,
  StagedTaskRef,
  StagedTaskStageContract,
  StagedTaskStageEvent,
  RuntimeToolResultEvidence,
  ToolResultFeedback
} from "@deepseek/platform-contracts";
import { STAGED_TASK_COMPATIBILITY, STAGED_TASK_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import { createToolResultEvidence, createToolResultEvidenceCacheEntry } from "@deepseek/memory-cache-management";
import { isStandardTestCommand } from "@deepseek/core-coding-tools";
import { toolProjectionPolicy } from "./prompt-assembly-integration.js";
import { applyStagedTaskEvent, readyStagedTaskStages } from "./staged-task.js";

export async function recordToolResultEvidence(
  deps: RuntimeDependencies,
  input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly capabilityId?: string;
    readonly terminalKind: string;
    readonly feedback: ToolResultFeedback;
  }
): Promise<RuntimeToolResultEvidence> {
  const evidence = createToolResultEvidence(input);
  await deps.cache.set(createToolResultEvidenceCacheEntry(evidence));
  return evidence;
}

export function projectToolSet(
  capabilities: readonly CapabilityManifest[],
  request: AgentLoopRequest
): readonly CapabilityManifest[] {
  const policy = toolProjectionPolicy(request);
  const projected = (() => {
    if (policy === "all") return capabilities;
    if (policy === "read-write") {
      return capabilities.filter((manifest) => manifest.sideEffect === "none" || manifest.sideEffect === "read" || manifest.sideEffect === "write");
    }
    return capabilities.filter((manifest) => manifest.sideEffect === "none" || manifest.sideEffect === "read");
  })();
  return applyWorkflowGateToolProjection(projected, request.profilePolicy);
}

function applyWorkflowGateToolProjection(
  capabilities: readonly CapabilityManifest[],
  profilePolicy: AgentLoopProfilePolicyMetadata | undefined
): readonly CapabilityManifest[] {
  if (!profilePolicy) return capabilities;
  const override = profilePolicy.workflowGateOverride;
  const workflowBoundary = shouldProjectWorkflowBoundary(profilePolicy)
    ? workflowCapabilityBoundary(profilePolicy)
    : new Set<string>();
  const workflowCapabilities = capabilities.filter((manifest) => workflowBoundary.has(String(manifest.id)));
  const candidates = workflowCapabilities.length > 0 ? workflowCapabilities : capabilities;
  if (!override) return candidates;
  return projectWorkflowGateOverrideTools(candidates, override);
}

export function projectWorkflowGateOverrideTools(
  capabilities: readonly CapabilityManifest[],
  override: AgentLoopProfilePolicyMetadata["workflowGateOverride"] | undefined,
  options: { readonly preferCanonicalCoreActions?: boolean } = {}
): readonly CapabilityManifest[] {
  if (!override) return capabilities;
  const restricted = capabilities.filter((manifest) => workflowGateCapabilitySatisfies(String(manifest.id), override.requiredNextAction));
  if (options.preferCanonicalCoreActions && restricted.length > 0) {
    const canonical = restricted.filter((manifest) => canonicalWorkflowGateCapabilityIds(override.requiredNextAction).has(String(manifest.id)));
    if (canonical.length > 0) return canonical;
  }
  return restricted.length > 0 ? restricted : capabilities;
}

function shouldProjectWorkflowBoundary(profilePolicy: AgentLoopProfilePolicyMetadata): boolean {
  return profilePolicy.workflowGateOverride !== undefined || isGovernedWorkflowBoundary(profilePolicy);
}

function workflowGateCapabilitySatisfies(capabilityId: string, requiredNextAction: string): boolean {
  if (requiredNextAction === "source-edit-or-test-or-bounded-blocker" || requiredNextAction === "source-edit-or-test-or-blocker") {
    return isMutationCapabilityId(capabilityId) || isTestCapabilityId(capabilityId);
  }
  if (requiredNextAction === "standard-test-command-or-bounded-blocker" || requiredNextAction === "standard-test-command") {
    return isTestCapabilityId(capabilityId);
  }
  if (requiredNextAction === "core.swe.bench.run-or-bounded-blocker") {
    return capabilityId === "core.swe.bench.run";
  }
  return true;
}

function canonicalWorkflowGateCapabilityIds(requiredNextAction: string): ReadonlySet<string> {
  if (requiredNextAction === "source-edit-or-test-or-bounded-blocker" || requiredNextAction === "source-edit-or-test-or-blocker") {
    return new Set(["core.file.edit", "core.test.run"]);
  }
  if (requiredNextAction === "standard-test-command-or-bounded-blocker" || requiredNextAction === "standard-test-command") {
    return new Set(["core.test.run"]);
  }
  if (requiredNextAction === "core.swe.bench.run-or-bounded-blocker") {
    return new Set(["core.swe.bench.run"]);
  }
  return new Set();
}

function isMutationCapabilityId(capabilityId: string): boolean {
  return capabilityId.includes(".edit")
    || capabilityId.includes(".write")
    || capabilityId.includes(".patch")
    || capabilityId.includes("patch.apply")
    || capabilityId.includes("file-edit")
    || capabilityId.includes("file.write");
}

function isTestCapabilityId(capabilityId: string): boolean {
  return capabilityId === "core.test.run"
    || capabilityId === "test.run"
    || capabilityId.endsWith(".test.run")
    || capabilityId.includes("test-run");
}

export function taskScopedToolGuard(input: {
  readonly taskDeliveryFlow: JsonObject;
  readonly toolName: string;
  readonly toolInput: JsonObject;
}): RedactedError | undefined {
  if (!isSweBenchLiteEvaluation(input.taskDeliveryFlow)) return undefined;
  if (!containsHistoricalSweBenchWorkspace(input.toolInput)) return undefined;
  return {
    code: "TASK_SCOPE_TOOL_REJECTED",
    message: "SWE-bench task-scope guard rejected stale SWE-bench workspace access; use the governed run-scoped evaluation capability instead.",
    retryable: false,
    redaction: { class: "internal", fields: ["details"] },
    details: {
      toolName: input.toolName,
      reason: "stale-swe-bench-workspace",
      normalizedIntent: input.taskDeliveryFlow.normalizedIntent
    }
  };
}

export function workflowCapabilityBoundaryGuard(input: {
  readonly profilePolicy?: AgentLoopProfilePolicyMetadata;
  readonly capabilityId: string;
  readonly toolName: string;
  readonly toolInput: JsonObject;
}): RedactedError | undefined {
  const policy = input.profilePolicy;
  if (!policy) return undefined;
  if (policy.workflowPriority !== "primary") return undefined;
  if (policy.orchestrationMode !== "staged-capability-workflow") return undefined;
  if (!isGovernedWorkflowBoundary(policy)) return undefined;
  const allowed = workflowCapabilityBoundary(policy);
  if (allowed.size === 0 || allowed.has(input.capabilityId)) return undefined;
  return {
    code: "WORKFLOW_CAPABILITY_BOUNDARY_REJECTED",
    message: `WORKFLOW_CAPABILITY_BOUNDARY_ENFORCED: ${input.capabilityId} is outside the primary workflow capability boundary for ${policy.profileId}. Use one of the declared workflow capabilities or report a bounded blocker.`,
    retryable: false,
    redaction: { class: "internal", fields: ["details"] },
    details: {
      profileId: policy.profileId,
      workflowGraphId: policy.workflowGraphId,
      workflowPriority: policy.workflowPriority,
      orchestrationMode: policy.orchestrationMode,
      rejectedToolName: input.toolName,
      rejectedCapabilityId: input.capabilityId,
      rejectedInput: input.toolInput,
      allowedCapabilityIds: [...allowed].sort()
    }
  };
}

export interface WorkflowStageProgressResult {
  readonly profilePolicy: AgentLoopProfilePolicyMetadata;
  readonly stageEvents: readonly StagedTaskStageEvent[];
  readonly stage: StagedTaskStageContract;
}

export function advanceWorkflowStageFromToolEvidence(input: {
  readonly profilePolicy?: AgentLoopProfilePolicyMetadata;
  readonly capabilityId: string;
  readonly toolCallId: string;
  readonly toolInput: JsonObject;
  readonly terminal: RuntimeEvent | undefined;
  readonly at: string;
}): WorkflowStageProgressResult | undefined {
  const policy = input.profilePolicy;
  const workflow = policy?.stagedTaskWorkflow;
  if (!policy || !workflow) return undefined;
  if (policy.workflowPriority !== "primary") return undefined;
  if (policy.orchestrationMode !== "staged-capability-workflow") return undefined;
  if (input.terminal?.kind !== "capability.completed") return undefined;

  const readyStage = readyStagedTaskStages(workflow.graph, workflow.runState)
    .find((stage) => (stage.allowedTools ?? []).map(String).includes(input.capabilityId) && stageCanCompleteFromToolEvidence(stage, input.capabilityId, input.toolInput));
  if (!readyStage) return undefined;

  const started = workflowStageEvent({
    kind: "stage.started",
    taskRunId: workflow.runState.taskRunId,
    graphId: workflow.graph.graphId,
    stageId: readyStage.stageId,
    toolCallId: input.toolCallId,
    at: input.at,
    diagnostics: []
  });
  const startedState = applyStagedTaskEvent(workflow.graph, workflow.runState, started);
  const outputRefs = readyStage.expectedOutputRefs
    .map((refId) => workflow.graph.refs.find((ref) => ref.refId === refId) ?? workflowEvidenceRef(refId, readyStage.stageId))
    .map((ref) => ({
      ...ref,
      metadata: {
        ...(ref.metadata ?? {}),
        capabilityId: input.capabilityId,
        toolCallId: input.toolCallId
      }
    }));
  const succeeded = workflowStageEvent({
    kind: "stage.succeeded",
    taskRunId: workflow.runState.taskRunId,
    graphId: workflow.graph.graphId,
    stageId: readyStage.stageId,
    toolCallId: input.toolCallId,
    at: input.at,
    outputRefs,
    diagnostics: []
  });
  const nextRunState = applyStagedTaskEvent(workflow.graph, startedState, succeeded);
  return {
    profilePolicy: {
      ...policy,
      stagedTaskWorkflow: {
        ...workflow,
        runState: nextRunState
      }
    },
    stageEvents: [started, succeeded],
    stage: readyStage
  };
}

function isGovernedWorkflowBoundary(policy: AgentLoopProfilePolicyMetadata): boolean {
  return policy.antiTailoring === true || policy.role.includes("evaluation");
}

function workflowCapabilityBoundary(policy: AgentLoopProfilePolicyMetadata): Set<string> {
  const allowed = new Set(policy.workflowCapabilityIds.map(String));
  for (const stage of policy.stagedTaskWorkflow?.graph.stages ?? []) {
    for (const capabilityId of stage.allowedTools ?? []) {
      allowed.add(String(capabilityId));
    }
  }
  return allowed;
}

function workflowStageEvent(input: {
  readonly kind: StagedTaskStageEvent["kind"];
  readonly taskRunId: string;
  readonly graphId: string;
  readonly stageId: string;
  readonly toolCallId: string;
  readonly at: string;
  readonly outputRefs?: readonly StagedTaskRef[];
  readonly diagnostics: readonly RedactedError[];
}): StagedTaskStageEvent {
  return {
    schemaVersion: STAGED_TASK_SCHEMA_VERSION,
    eventId: `event:${input.stageId}:${input.kind}:${input.toolCallId}`,
    kind: input.kind,
    taskRunId: input.taskRunId,
    graphId: input.graphId,
    stageId: input.stageId,
    at: input.at,
    ...(input.outputRefs ? { outputRefs: input.outputRefs } : {}),
    diagnostics: input.diagnostics,
    compatibility: STAGED_TASK_COMPATIBILITY,
    redaction: { class: "internal", fields: ["diagnostics.details", "outputRefs.preview"] }
  };
}

function workflowEvidenceRef(refId: string, producerStageId: string): StagedTaskRef {
  return {
    schemaVersion: STAGED_TASK_SCHEMA_VERSION,
    refId,
    type: refId.includes("check") ? "check" : refId.includes("diagnostic") ? "diagnostic" : "evidence",
    producerStageId,
    scope: "task",
    compatibility: STAGED_TASK_COMPATIBILITY,
    redaction: { class: "internal" }
  };
}

function stageCanCompleteFromToolEvidence(stage: StagedTaskStageContract, capabilityId: string, toolInput: JsonObject): boolean {
  const normalized = capabilityId.toLowerCase();
  if (normalized === "core.swe.bench.run") return true;
  switch (stage.kind) {
    case "collect-evidence":
      return true;
    case "materialize":
    case "produce":
    case "repair":
      return isMutationCapability(normalized);
    case "verify":
    case "score":
      return isVerificationCapability(normalized, toolInput);
    case "artifact-scan":
      return isArtifactScanCapability(normalized);
    case "synthesize":
      return true;
  }
}

function isMutationCapability(capabilityId: string): boolean {
  return (
    capabilityId === "core.file.write" ||
    capabilityId === "core.file.edit" ||
    capabilityId === "core.patch.apply" ||
    capabilityId.endsWith(".write") ||
    capabilityId.endsWith(".edit") ||
    capabilityId.endsWith(".apply") ||
    capabilityId.includes("patch.apply")
  );
}

function isVerificationCapability(capabilityId: string, toolInput: JsonObject): boolean {
  if (
    capabilityId === "core.test.run" ||
    capabilityId === "test.run" ||
    capabilityId === "core.git.diff" ||
    capabilityId.endsWith(".test") ||
    capabilityId.endsWith(".diff")
  ) {
    return true;
  }
  if (capabilityId !== "core.shell.run") return false;
  const command = shellCommandText(toolInput);
  return isStandardTestCommand(command) || /\bgit\s+diff\b/i.test(command);
}

function isArtifactScanCapability(capabilityId: string): boolean {
  return capabilityId === "core.git.diff" || capabilityId.includes("artifact-scan") || capabilityId.endsWith(".diff");
}

function shellCommandText(input: JsonObject): string {
  const command = typeof input.command === "string" ? input.command : "";
  if (!command) return "";
  const args = Array.isArray(input.args) ? input.args.filter((item): item is string => typeof item === "string") : [];
  return [command, ...args].join(" ");
}

function isSweBenchLiteEvaluation(flow: JsonObject): boolean {
  return flow.intentKind === "evaluation" && flow.normalizedIntent === "run swe-bench lite task";
}

function containsHistoricalSweBenchWorkspace(value: unknown): boolean {
  if (typeof value === "string") return value.replace(/\\/g, "/").includes(".deepseek/swebench-workspaces");
  if (Array.isArray(value)) return value.some((item) => containsHistoricalSweBenchWorkspace(item));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).some((item) => containsHistoricalSweBenchWorkspace(item));
}

export interface SkillActivateTerminalMetadata {
  readonly name: string;
  readonly status: string;
  readonly segmentCount: number;
  readonly loadingState: string;
}

export function extractSkillActivateMetadata(terminal: RuntimeEvent): SkillActivateTerminalMetadata | undefined {
  const output = terminal.data?.output;
  if (!output || typeof output !== "object") return undefined;
  const evidence = (output as { evidence?: unknown }).evidence;
  if (!evidence || typeof evidence !== "object") return undefined;
  const metadata = (evidence as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const record = metadata as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : undefined;
  const status = typeof record.status === "string" ? record.status : undefined;
  const segmentCount = typeof record.segmentCount === "number" ? record.segmentCount : undefined;
  const loadingState = typeof record.loadingState === "string" ? record.loadingState : undefined;
  if (!name || !status || segmentCount === undefined || !loadingState) return undefined;
  return { name, status, segmentCount, loadingState };
}

export function asJsonObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}
