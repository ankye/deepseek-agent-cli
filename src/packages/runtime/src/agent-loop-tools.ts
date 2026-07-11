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
  StagedTaskEvaluationResult,
  ToolResultFeedback
} from "@deepseek/platform-contracts";
import { STAGED_TASK_COMPATIBILITY, STAGED_TASK_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import { createToolResultEvidence, createToolResultEvidenceCacheEntry } from "@deepseek/memory-cache-management";
import { isStandardTestCommand, toolFamilyCatalog } from "@deepseek/core-coding-tools";
import { isCapabilityVisibleForProjection } from "@deepseek/prompt-assembly";
import { stageCanCompleteFromToolEvidence, terminalEvidenceCompleted, terminalEvidenceSatisfiesStageProgress, toolCommandText } from "./agent-loop-tool-evidence.js";
import { toolProjectionPolicy } from "./prompt-assembly-integration.js";
import { applyStagedTaskEvent, readyStagedTaskStages } from "./staged-task.js";
import { isMutationCapabilityId, isStandardTestExecutionCapabilityId, isTestCapabilityId, progressCapabilityIdsForWorkflowStage } from "./workflow-capability-policy.js";

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
    return capabilities.filter((manifest) => isCapabilityVisibleForProjection(manifest, policy, request.toolOptIns ?? []));
  })();
  if (shouldUseActiveWorkflowStageTools(request)) {
    return applyActiveWorkflowStageProviderProjection(projected, request.profilePolicy);
  }
  return applyWorkflowGateToolProjection(projected, request.profilePolicy);
}

export function projectProviderCacheToolSet(
  capabilities: readonly CapabilityManifest[],
  request: AgentLoopRequest
): readonly CapabilityManifest[] {
  const policy = toolProjectionPolicy(request);
  const projected = capabilities.filter((manifest) => isCapabilityVisibleForProjection(manifest, policy, request.toolOptIns ?? []));
  if (shouldUseExecutableProviderTools(request)) {
    const workflowReadyStageControl = (request as { readonly workflowReadyStageControl?: JsonObject }).workflowReadyStageControl;
    return applyActiveWorkflowStageProviderProjection(projected, request.profilePolicy, workflowReadyStageControl);
  }
  return applyProviderCacheToolProjection(projected, request.profilePolicy);
}

function applyActiveWorkflowStageProviderProjection(
  capabilities: readonly CapabilityManifest[],
  profilePolicy: AgentLoopProfilePolicyMetadata | undefined,
  workflowReadyStageControl?: JsonObject
): readonly CapabilityManifest[] {
  if (!profilePolicy) return capabilities;
  if (profilePolicy.workflowGateOverride) return projectProviderWorkflowGateOverrideTools(capabilities, profilePolicy);
  const activeStageAllowed = activeReadyStageControlCapabilityBoundary(profilePolicy, workflowReadyStageControl) ??
    activeReadyStageCapabilityBoundary(profilePolicy);
  const activeStageTools = capabilities.filter((manifest) => activeStageAllowed.has(String(manifest.id)));
  if (activeStageTools.length > 0) return activeStageTools;
  return applyWorkflowGateToolProjection(capabilities, profilePolicy);
}

function shouldUseExecutableProviderTools(request: AgentLoopRequest): boolean {
  if (!usesAutomaticPrefixCacheOnly(request)) return false;
  return shouldUseActiveProviderStageTools(request);
}

function shouldUseActiveWorkflowStageTools(request: AgentLoopRequest): boolean {
  const profilePolicy = request.profilePolicy;
  if (!profilePolicy) return false;
  return profilePolicy.workflowGovernanceMode === "evaluation";
}

function shouldUseActiveProviderStageTools(request: AgentLoopRequest): boolean {
  const profilePolicy = request.profilePolicy;
  if (!profilePolicy) return false;
  return profilePolicy.workflowGovernanceMode === "evaluation" || isPrimaryStagedWorkflow(profilePolicy);
}

function usesAutomaticPrefixCacheOnly(request: AgentLoopRequest): boolean {
  const explicitPrefixCacheHints = request.profile.cacheHints?.explicitPrefixCacheHints;
  if (explicitPrefixCacheHints === true) return false;
  if (explicitPrefixCacheHints === false) return true;
  const provider = String(request.profile.provider ?? "").toLowerCase();
  const model = String(request.profile.model ?? "").toLowerCase();
  return provider.includes("deepseek") || model.startsWith("deepseek-");
}

function applyProviderCacheToolProjection(
  capabilities: readonly CapabilityManifest[],
  profilePolicy: AgentLoopProfilePolicyMetadata | undefined
): readonly CapabilityManifest[] {
  if (!profilePolicy) return capabilities;
  const workflowBoundary = shouldProjectWorkflowBoundary(profilePolicy)
    ? workflowCapabilityBoundary(profilePolicy)
    : new Set<string>();
  if (profilePolicy.workflowGateOverride) {
    for (const capabilityId of canonicalWorkflowGateCapabilityIds(profilePolicy.workflowGateOverride.requiredNextAction)) {
      workflowBoundary.add(capabilityId);
    }
  }
  const workflowCapabilities = capabilities.filter((manifest) => workflowBoundary.has(String(manifest.id)));
  if (workflowCapabilities.length > 0) return workflowCapabilities;
  if (profilePolicy.workflowGateOverride?.gate === "runtime-convergence") {
    return projectWorkflowGateOverrideTools(capabilities, profilePolicy.workflowGateOverride, {
      preferCanonicalCoreActions: true,
      strict: true
    });
  }
  return capabilities;
}

function applyWorkflowGateToolProjection(
  capabilities: readonly CapabilityManifest[],
  profilePolicy: AgentLoopProfilePolicyMetadata | undefined
): readonly CapabilityManifest[] {
  if (!profilePolicy) return capabilities;
  const override = profilePolicy.workflowGateOverride;
  if (override) return projectWorkflowGateOverrideTools(capabilities, override);
  const workflowBoundary = shouldProjectWorkflowBoundary(profilePolicy)
    ? workflowCapabilityBoundary(profilePolicy)
    : new Set<string>();
  const workflowCapabilities = capabilities.filter((manifest) => workflowBoundary.has(String(manifest.id)));
  const candidates = workflowCapabilities.length > 0 ? workflowCapabilities : capabilities;
  return candidates;
}

export function projectWorkflowGateOverrideTools(
  capabilities: readonly CapabilityManifest[],
  override: AgentLoopProfilePolicyMetadata["workflowGateOverride"] | undefined,
  options: { readonly preferCanonicalCoreActions?: boolean; readonly strict?: boolean } = {}
): readonly CapabilityManifest[] {
  if (!override) return capabilities;
  const restricted = capabilities.filter((manifest) => workflowGateCapabilitySatisfies(String(manifest.id), override.requiredNextAction));
  if (options.preferCanonicalCoreActions && restricted.length > 0) {
    const canonical = restricted.filter((manifest) => canonicalWorkflowGateCapabilityIds(override.requiredNextAction).has(String(manifest.id)));
    if (canonical.length > 0) return canonical;
  }
  if (options.strict) return restricted;
  return restricted.length > 0 ? restricted : capabilities;
}

function projectProviderWorkflowGateOverrideTools(
  capabilities: readonly CapabilityManifest[],
  profilePolicy: AgentLoopProfilePolicyMetadata
): readonly CapabilityManifest[] {
  const override = profilePolicy.workflowGateOverride;
  if (!override) return capabilities;
  const preferred = new Set(canonicalWorkflowGateCapabilityIds(override.requiredNextAction));
  for (const capabilityId of providerWorkflowGateContextCapabilityIds(profilePolicy, override)) {
    preferred.add(capabilityId);
  }
  const projected = capabilities.filter((manifest) => preferred.has(String(manifest.id)));
  if (projected.length > 0) return projected;
  return projectWorkflowGateOverrideTools(capabilities, override, {
    preferCanonicalCoreActions: true,
    strict: true
  });
}

function providerWorkflowGateContextCapabilityIds(
  profilePolicy: AgentLoopProfilePolicyMetadata,
  override: NonNullable<AgentLoopProfilePolicyMetadata["workflowGateOverride"]>
): readonly string[] {
  const workflowBoundary = workflowCapabilityBoundary(profilePolicy);
  if (!providerGateNeedsWorkflowContext(profilePolicy, override, workflowBoundary)) return [];
  return [...workflowBoundary].filter((capabilityId) =>
    capabilityId === "core.file.read" ||
    capabilityId === "core.search.text" ||
    capabilityId === "core.file.edit" ||
    capabilityId === "core.git.diff" ||
    capabilityId === "core.test.run"
  );
}

function providerGateNeedsWorkflowContext(
  profilePolicy: AgentLoopProfilePolicyMetadata,
  override: NonNullable<AgentLoopProfilePolicyMetadata["workflowGateOverride"]>,
  workflowBoundary: ReadonlySet<string>
): boolean {
  const requiredNextAction = override.requiredNextAction;
  const isEvaluationWorkflow = profilePolicy.workflowGovernanceMode === "evaluation";
  const alternatives = requiredNextAction.split("|").map((part) => part.trim()).filter(Boolean);
  if (alternatives.length > 1) {
    if (!isEvaluationWorkflow && workflowBoundary.has("core.test.run") && alternatives.some((alternative) => isCanonicalSourceMutationAction(alternative))) {
      return true;
    }
    return alternatives.some((alternative) => providerGateNeedsWorkflowContext(profilePolicy, {
      ...override,
      requiredNextAction: alternative
    }, workflowBoundary));
  }
  if (!isEvaluationWorkflow && override.terminalKind === "workflow-required-action.rejected" && isCanonicalSourceMutationAction(requiredNextAction)) {
    return true;
  }
  return requiredNextAction === "standard-test-command" ||
    requiredNextAction === "standard-test-command-or-bounded-blocker" ||
    requiredNextAction === "focused-read-or-source-edit-or-test-or-return-control" ||
    requiredNextAction === "source-edit-or-test-or-bounded-blocker" ||
    requiredNextAction === "source-edit-or-test-or-blocker";
}

function isCanonicalSourceMutationAction(requiredNextAction: string): boolean {
  return requiredNextAction === "core.file.edit" || requiredNextAction === "core.patch.apply";
}

function shouldProjectWorkflowBoundary(profilePolicy: AgentLoopProfilePolicyMetadata): boolean {
  return profilePolicy.workflowGateOverride !== undefined || isGovernedWorkflowBoundary(profilePolicy) || isPrimaryStagedWorkflow(profilePolicy);
}

function isPrimaryStagedWorkflow(policy: AgentLoopProfilePolicyMetadata): boolean {
  return policy.workflowPriority === "primary" && policy.orchestrationMode === "staged-capability-workflow" && policy.stagedTaskWorkflow !== undefined;
}

function activeReadyStageCapabilityBoundary(policy: AgentLoopProfilePolicyMetadata): Set<string> {
  if (policy.workflowPriority !== "primary") return new Set();
  if (policy.orchestrationMode !== "staged-capability-workflow") return new Set();
  const workflow = policy.stagedTaskWorkflow;
  if (!workflow) return new Set();
  const mode = stageAcceptanceMode(policy);
  const readyState = workflow.runState.stageStates.find((stage) => stage.status === "ready") ??
    workflow.runState.stageStates.find((stage) =>
      mode === "supervisor" &&
      stage.status === "running" &&
      stage.evaluation?.status === "needs-review"
    );
  if (!readyState) return new Set();
  const stage = workflow.graph.stages.find((candidate) => candidate.stageId === readyState.stageId);
  const allowedToolIds = (stage?.allowedTools ?? []).map(String);
  const expandedCapabilityIds = expandAllowedToolIdsToCapabilityIds(allowedToolIds);
  const progress = new Set(progressCapabilityIdsForWorkflowStage(stage?.kind, expandedCapabilityIds));
  const workflowCapabilityIds = expandAllowedToolIdsToCapabilityIds((policy.workflowCapabilityIds ?? []).map(String));
  const supporting = supportingCapabilityIdsForWorkflowStage(stage?.kind, workflowCapabilityIds);
  if (
    mode === "supervisor" &&
    readyState.status === "running" &&
    readyState.evaluation?.status === "needs-review"
  ) {
    if (readyStageNeedsDiagnosticEvidenceReview(stage?.kind, readyState.inputRefs ?? [], workflow.runState.refs ?? [])) {
      return progress;
    }
    if (readyStageOwnProgressShouldWin(stage?.kind, progress) && readyState.outputRefs.length === 0) {
      return progress;
    }
    const downstream = downstreamWorkflowProgressCapabilityIds(workflow.graph.stages, readyState.stageId);
    if (downstream.length > 0 || stage?.kind === "collect-evidence") {
      return new Set(downstream);
    }
  }
  return progress;
}

function activeReadyStageControlCapabilityBoundary(
  policy: AgentLoopProfilePolicyMetadata,
  control: JsonObject | undefined
): Set<string> | undefined {
  if (!control) return undefined;
  const progress = Array.isArray(control.progressCapabilityIds)
    ? control.progressCapabilityIds.map(String)
    : [];
  if (progress.length === 0) return undefined;
  const stageKind = typeof control.stageKind === "string" ? control.stageKind : undefined;
  const projectedFromReviewedStage = control.projectedFromReviewedStage === true;
  if (
    projectedFromReviewedStage &&
    policy.antiTailoring === true &&
    policy.workflowGovernanceMode !== "evaluation" &&
    (stageKind === "produce" || stageKind === "materialize" || stageKind === "repair")
  ) {
    const workflowCapabilityIds = expandAllowedToolIdsToCapabilityIds((policy.workflowCapabilityIds ?? []).map(String));
    const supporting = supportingCapabilityIdsForWorkflowStage(stageKind, workflowCapabilityIds);
    return new Set([...progress, ...supporting]);
  }
  return new Set(progress);
}

function readyStageNeedsDiagnosticEvidenceReview(
  stageKind: string | undefined,
  inputRefs: readonly string[],
  refs: readonly { readonly refId: string; readonly type?: string }[]
): boolean {
  if (stageKind !== "collect-evidence") return false;
  const refsById = new Map(refs.map((ref) => [ref.refId, ref]));
  return inputRefs.some((refId) => refsById.get(refId)?.type === "diagnostic");
}

function supportingCapabilityIdsForWorkflowStage(
  stageKind: string | undefined,
  allowedCapabilityIds: readonly string[]
): readonly string[] {
  if (stageKind !== "produce" && stageKind !== "materialize" && stageKind !== "repair") return [];
  return allowedCapabilityIds.filter(isSourceInspectionSupportCapabilityId);
}

function isSourceInspectionSupportCapabilityId(capabilityId: string): boolean {
  return capabilityId === "core.file.read" ||
    capabilityId === "core.file.list" ||
    capabilityId === "core.search.text" ||
    capabilityId === "core.workspace.glob";
}

function downstreamWorkflowProgressCapabilityIds(
  stages: readonly { readonly stageId: string; readonly kind: string; readonly dependsOn?: readonly string[]; readonly allowedTools?: readonly string[] }[],
  stageId: string
): readonly string[] {
  const capabilityIds: string[] = [];
  for (const stage of stages) {
    if (!(stage.dependsOn ?? []).map(String).includes(stageId)) continue;
    const expanded = expandAllowedToolIdsToCapabilityIds((stage.allowedTools ?? []).map(String));
    capabilityIds.push(...progressCapabilityIdsForWorkflowStage(stage.kind, expanded));
  }
  return [...new Set(capabilityIds)];
}

function downstreamWorkflowSupportingCapabilityIds(
  stages: readonly { readonly stageId: string; readonly kind: string; readonly dependsOn?: readonly string[] }[],
  stageId: string,
  workflowCapabilityIds: readonly string[]
): readonly string[] {
  const capabilityIds: string[] = [];
  for (const stage of stages) {
    if (!(stage.dependsOn ?? []).map(String).includes(stageId)) continue;
    capabilityIds.push(...supportingCapabilityIdsForWorkflowStage(stage.kind, workflowCapabilityIds));
  }
  return [...new Set(capabilityIds)];
}

function readyStageOwnProgressShouldWin(stageKind: string | undefined, progressCapabilityIds: ReadonlySet<string>): boolean {
  if (stageKind !== "produce" && stageKind !== "materialize" && stageKind !== "repair") return false;
  for (const capabilityId of progressCapabilityIds) {
    if (isMutationCapabilityId(capabilityId)) return true;
  }
  return false;
}

function workflowGateCapabilitySatisfies(capabilityId: string, requiredNextAction: string): boolean {
  const alternatives = requiredNextAction.split("|").map((part) => part.trim()).filter(Boolean);
  if (alternatives.length > 1) {
    return alternatives.some((alternative) => workflowGateCapabilitySatisfies(capabilityId, alternative));
  }
  if (requiredNextAction === "source-edit-or-test-or-bounded-blocker" || requiredNextAction === "source-edit-or-test-or-blocker") {
    return isMutationCapabilityId(capabilityId) || isTestCapabilityId(capabilityId);
  }
  if (requiredNextAction.startsWith("core.")) {
    return capabilityId === requiredNextAction;
  }
  if (requiredNextAction === "standard-test-command") {
    return capabilityId === "core.test.run";
  }
  if (requiredNextAction === "standard-test-command-or-bounded-blocker") {
    return isStandardTestExecutionCapabilityId(capabilityId);
  }
  if (requiredNextAction === "repo-local-python-test-runner") {
    return capabilityId === "core.shell.run";
  }
  if (requiredNextAction === "focused-read-or-source-edit-or-test-or-return-control") {
    return isFocusedEvidenceRefreshCapabilityId(capabilityId) || isMutationCapabilityId(capabilityId) || isTestCapabilityId(capabilityId);
  }
  if (requiredNextAction === "focused-read-or-source-edit-or-bounded-blocker") {
    return isFocusedEvidenceRefreshCapabilityId(capabilityId) || isMutationCapabilityId(capabilityId);
  }
  return true;
}

function canonicalWorkflowGateCapabilityIds(requiredNextAction: string): ReadonlySet<string> {
  const alternatives = requiredNextAction.split("|").map((part) => part.trim()).filter(Boolean);
  if (alternatives.length > 1) {
    const canonical = new Set<string>();
    for (const alternative of alternatives) {
      for (const capabilityId of canonicalWorkflowGateCapabilityIds(alternative)) canonical.add(capabilityId);
    }
    return canonical;
  }
  if (requiredNextAction === "source-edit-or-test-or-bounded-blocker" || requiredNextAction === "source-edit-or-test-or-blocker") {
    return new Set(["core.file.edit", "core.patch.apply", "core.test.run"]);
  }
  if (requiredNextAction.startsWith("core.")) {
    return new Set([requiredNextAction]);
  }
  if (requiredNextAction === "standard-test-command") {
    return new Set(["core.test.run"]);
  }
  if (requiredNextAction === "standard-test-command-or-bounded-blocker") {
    return new Set(["core.test.run", "core.shell.run"]);
  }
  if (requiredNextAction === "repo-local-python-test-runner") {
    return new Set(["core.shell.run"]);
  }
  if (requiredNextAction === "focused-read-or-source-edit-or-test-or-return-control") {
    return new Set(["core.file.read", "core.search.text", "core.file.edit", "core.patch.apply", "core.test.run"]);
  }
  if (requiredNextAction === "focused-read-or-source-edit-or-bounded-blocker") {
    return new Set(["core.file.read", "core.search.text", "core.file.edit"]);
  }
  return new Set();
}

function isFocusedEvidenceRefreshCapabilityId(capabilityId: string): boolean {
  return capabilityId === "core.file.read" || capabilityId === "core.search.text";
}

const familyCapabilityIds = new Map(
  toolFamilyCatalog.families.map((family) => [
    String(family.familyId),
    family.tools.filter((tool) => tool.executable).map((tool) => String(tool.capabilityId))
  ])
);

export function workflowCapabilityBoundaryGuard(input: {
  readonly profilePolicy?: AgentLoopProfilePolicyMetadata;
  readonly workflowReadyStageControl?: JsonObject;
  readonly capabilityId: string;
  readonly toolName: string;
  readonly toolInput: JsonObject;
}): RedactedError | undefined {
  const policy = input.profilePolicy;
  if (!policy) return undefined;
  if (policy.workflowPriority !== "primary") return undefined;
  if (policy.orchestrationMode !== "staged-capability-workflow") return undefined;
  const activeStageKind = typeof input.workflowReadyStageControl?.stageKind === "string"
    ? input.workflowReadyStageControl.stageKind
    : activeReadyStageKind(policy);
  const commandText = toolCommandText(input.toolInput);
  const evaluationReproductionAllowed = isAllowedEvaluationReproductionToolInput({
    profilePolicy: policy,
    capabilityId: input.capabilityId,
    toolInput: input.toolInput
  });
  if (
    (activeStageKind === "verify" || activeStageKind === "score") &&
    (input.capabilityId === "core.test.run" || input.capabilityId === "core.shell.run") &&
    !isStandardTestCommand(commandText) &&
    !evaluationReproductionAllowed
  ) {
    return {
      code: "WORKFLOW_STANDARD_TEST_REQUIRED",
      message: `WORKFLOW_STANDARD_TEST_REQUIRED: ${input.capabilityId} in ${activeStageKind} must run a standard repository test command such as pytest, python -m pytest, python -m unittest, tox, nox, or the repository package test command.`,
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
        requiredNextAction: "standard-test-command"
      }
    };
  }
  if (!isGovernedWorkflowBoundary(policy)) return undefined;
  if (policy.workflowGateOverride && workflowGateCapabilitySatisfies(input.capabilityId, policy.workflowGateOverride.requiredNextAction)) return undefined;
  const activeStageAllowed = activeReadyStageCapabilityBoundary(policy);
  if (activeStageAllowed.size > 0 && !activeStageAllowed.has(input.capabilityId)) {
    return {
      code: "WORKFLOW_CAPABILITY_BOUNDARY_REJECTED",
      message: `WORKFLOW_CAPABILITY_BOUNDARY_ENFORCED: ${input.capabilityId} is outside the active workflow stage boundary for ${policy.profileId}. Use the current stage progress capability or report a bounded blocker.`,
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
        allowedCapabilityIds: [...activeStageAllowed].sort()
      }
    };
  }
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

export function isAllowedEvaluationReproductionToolInput(input: {
  readonly profilePolicy?: AgentLoopProfilePolicyMetadata;
  readonly capabilityId: string;
  readonly toolInput: JsonObject;
}): boolean {
  if (!input.profilePolicy) return false;
  return isAllowedEvaluationReproductionCommand(
    input.profilePolicy,
    input.capabilityId,
    input.toolInput,
    toolCommandText(input.toolInput)
  );
}

function isAllowedEvaluationReproductionCommand(
  policy: AgentLoopProfilePolicyMetadata,
  capabilityId: string,
  toolInput: JsonObject,
  commandText: string
): boolean {
  if (policy.workflowGovernanceMode !== "evaluation") return false;
  if (capabilityId !== "core.test.run") return false;
  const intent = typeof toolInput.intent === "string" ? toolInput.intent.toLowerCase() : "";
  if (intent && !/\b(?:reproduce|reproduction|regression|verify|verification)\b/.test(intent)) return false;
  const command = commandText.trim();
  if (command.length === 0 || command.length > 12_000 || command.includes("\0")) return false;
  if (!/^(?:python(?:3(?:\.\d+)?)?|py)\s+-c(?:\s|$)/i.test(command)) return false;
  if (/&&|\|\||`|\$\(/.test(command)) return false;
  return !hasMutationCapablePython(command);
}

function hasMutationCapablePython(command: string): boolean {
  return /\b(?:shutil|subprocess)\b/i.test(command) ||
    /\bos\.system\s*\(/i.test(command) ||
    /\bopen\s*\([^)]*,\s*["'][^"']*[wax+]/i.test(command) ||
    /\.(?:write|write_text|write_bytes|unlink|remove|rename|replace|chmod|mkdir|makedirs|rmdir|removedirs)\s*\(/i.test(command) ||
    /\b(?:rm|mv|cp|chmod|mkdir|touch)\s+(?:-[^\s]+\s+)*[^\s]/i.test(command);
}

function activeReadyStageKind(policy: AgentLoopProfilePolicyMetadata): string | undefined {
  const workflow = policy.stagedTaskWorkflow;
  if (!workflow) return undefined;
  const mode = stageAcceptanceMode(policy);
  const readyState = workflow.runState.stageStates.find((stage) => stage.status === "ready") ??
    workflow.runState.stageStates.find((stage) =>
      mode === "supervisor" &&
      stage.status === "running" &&
      stage.evaluation?.status === "needs-review"
    );
  if (!readyState) return undefined;
  return workflow.graph.stages.find((stage) => stage.stageId === readyState.stageId)?.kind;
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
  if (!terminalEvidenceCompleted(input.terminal)) return undefined;
  if (
    input.capabilityId === "core.shell.run" &&
    stageKindForCapability(workflow.graph.stages, input.capabilityId) === "verify" &&
    !isStandardTestCommand(toolCommandText(input.toolInput))
  ) {
    return undefined;
  }

  const supervisedDownstreamStage = supervisorDownstreamStageFromReviewedEvidence({
    policy,
    workflow,
    capabilityId: input.capabilityId,
    toolInput: input.toolInput
  });
  if (supervisedDownstreamStage) {
    const acceptedReview = workflowStageEvent({
      kind: "stage.succeeded",
      taskRunId: workflow.runState.taskRunId,
      graphId: workflow.graph.graphId,
      stageId: supervisedDownstreamStage.reviewStage.stageId,
      toolCallId: input.toolCallId,
      at: input.at,
      outputRefs: supervisedDownstreamStage.reviewStage.expectedOutputRefs
        .map((refId) => workflow.graph.refs.find((ref) => ref.refId === refId) ?? workflowEvidenceRef(refId, supervisedDownstreamStage.reviewStage.stageId)),
      evaluation: workflowStageEvaluation({
        stage: supervisedDownstreamStage.reviewStage,
        evidenceRefs: supervisedDownstreamStage.reviewStage.expectedOutputRefs,
        toolCallId: input.toolCallId,
        at: input.at,
        mode: "automatic"
      }),
      diagnostics: [{
        code: "STAGED_TASK_SUPERVISOR_STAGE_ACCEPTED_BY_DOWNSTREAM_EVIDENCE",
        message: "Completed downstream tool evidence satisfied the pending supervisor review stage.",
        retryable: false,
        redaction: { class: "internal", fields: ["message"] }
      }]
    });
    const reviewAcceptedState = applyStagedTaskEvent(workflow.graph, workflow.runState, acceptedReview);
    const started = workflowStageEvent({
      kind: "stage.started",
      taskRunId: workflow.runState.taskRunId,
      graphId: workflow.graph.graphId,
      stageId: supervisedDownstreamStage.stage.stageId,
      toolCallId: input.toolCallId,
      at: input.at,
      diagnostics: []
    });
    const startedState = applyStagedTaskEvent(workflow.graph, reviewAcceptedState, started);
    const downstreamHasDependents = workflow.graph.stages.some((stage) =>
      stage.dependsOn.includes(supervisedDownstreamStage.stage.stageId)
    );
    const downstreamCompletionEvent = workflowStageEvent({
      kind: downstreamHasDependents ? "stage.evaluation.required" : "stage.succeeded",
      taskRunId: workflow.runState.taskRunId,
      graphId: workflow.graph.graphId,
      stageId: supervisedDownstreamStage.stage.stageId,
      toolCallId: input.toolCallId,
      at: input.at,
      outputRefs: stageOutputRefs(workflow, supervisedDownstreamStage.stage, input.capabilityId, input.toolCallId),
      evaluation: workflowStageEvaluation({
        stage: supervisedDownstreamStage.stage,
        evidenceRefs: supervisedDownstreamStage.stage.expectedOutputRefs,
        toolCallId: input.toolCallId,
        at: input.at,
        mode: downstreamHasDependents ? "supervisor" : "automatic"
      }),
      diagnostics: [downstreamHasDependents
        ? {
          code: "STAGED_TASK_SUPERVISOR_DOWNSTREAM_STAGE_REVIEW_REQUIRED",
          message: "Runtime-accepted downstream tool evidence started the supervised stage; downstream completion still requires review or further evidence.",
          retryable: false,
          redaction: { class: "internal", fields: ["message"] }
        }
        : {
          code: "STAGED_TASK_SUPERVISOR_DOWNSTREAM_STAGE_ACCEPTED",
          message: "Runtime-accepted downstream tool evidence advanced the supervised workflow.",
          retryable: false,
          redaction: { class: "internal", fields: ["message"] }
        }]
    });
    const nextRunState = applyStagedTaskEvent(workflow.graph, startedState, downstreamCompletionEvent);
    return {
      profilePolicy: {
        ...policy,
        stagedTaskWorkflow: {
          ...workflow,
          runState: nextRunState
        }
      },
      stageEvents: [acceptedReview, started, downstreamCompletionEvent],
      stage: supervisedDownstreamStage.stage
    };
  }

  const readyStage = readyStagedTaskStages(workflow.graph, workflow.runState)
    .find((stage) => (stage.allowedTools ?? []).map(String).includes(input.capabilityId) && stageCanCompleteFromToolEvidence(stage, input.capabilityId, input.toolInput, input.terminal));
  if (!readyStage) return undefined;
  if (!terminalEvidenceSatisfiesStageProgress(readyStage, input.capabilityId, input.terminal)) return undefined;

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
  const evaluation = workflowStageEvaluation({
    stage: readyStage,
    evidenceRefs: outputRefs.map((ref) => ref.refId),
    toolCallId: input.toolCallId,
    at: input.at,
    mode: stageAcceptanceMode(policy)
  });
  if (stageAcceptanceMode(policy) === "automatic") {
    const succeeded = workflowStageEvent({
      kind: "stage.succeeded",
      taskRunId: workflow.runState.taskRunId,
      graphId: workflow.graph.graphId,
      stageId: readyStage.stageId,
      toolCallId: input.toolCallId,
      at: input.at,
      outputRefs,
      evaluation,
      diagnostics: [{
        code: "STAGED_TASK_AUTOMATIC_STAGE_ACCEPTED",
        message: "Runtime-accepted tool evidence satisfied the ordinary CLI stage acceptance policy.",
        retryable: false,
        redaction: { class: "internal", fields: ["message"] }
      }]
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
  const evaluationRequired = workflowStageEvent({
    kind: "stage.evaluation.required",
    taskRunId: workflow.runState.taskRunId,
    graphId: workflow.graph.graphId,
    stageId: readyStage.stageId,
    toolCallId: input.toolCallId,
    at: input.at,
    outputRefs,
    evaluation,
    diagnostics: [{
      code: "STAGED_TASK_TECHNICAL_DIRECTOR_ACCEPTANCE_REQUIRED",
      message: "Stage tool evidence produced output, but success requires stage evaluation and technical-director acceptance.",
      retryable: false,
      redaction: { class: "internal", fields: ["message"] }
    }]
  });
  const nextRunState = applyStagedTaskEvent(workflow.graph, startedState, evaluationRequired);
  return {
    profilePolicy: {
      ...policy,
      stagedTaskWorkflow: {
        ...workflow,
        runState: nextRunState
      }
    },
    stageEvents: [started, evaluationRequired],
    stage: readyStage
  };
}

function isGovernedWorkflowBoundary(policy: AgentLoopProfilePolicyMetadata): boolean {
  return policy.antiTailoring === true || policy.role.includes("evaluation");
}

function workflowCapabilityBoundary(policy: AgentLoopProfilePolicyMetadata): Set<string> {
  const allowed = new Set(expandAllowedToolIdsToCapabilityIds(policy.workflowCapabilityIds.map(String)));
  for (const stage of policy.stagedTaskWorkflow?.graph.stages ?? []) {
    for (const capabilityId of expandAllowedToolIdsToCapabilityIds((stage.allowedTools ?? []).map(String))) {
      allowed.add(String(capabilityId));
    }
  }
  return allowed;
}

function expandAllowedToolIdsToCapabilityIds(ids: readonly string[]): readonly string[] {
  const expanded = new Set<string>();
  for (const id of ids) {
    expanded.add(id);
    const familyCapabilities = familyCapabilityIds.get(id);
    if (!familyCapabilities) continue;
    for (const capabilityId of familyCapabilities) expanded.add(capabilityId);
  }
  return [...expanded];
}


function workflowStageEvent(input: {
  readonly kind: StagedTaskStageEvent["kind"];
  readonly taskRunId: string;
  readonly graphId: string;
  readonly stageId: string;
  readonly toolCallId: string;
  readonly at: string;
  readonly outputRefs?: readonly StagedTaskRef[];
  readonly evaluation?: StagedTaskEvaluationResult;
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
    ...(input.evaluation ? { evaluation: input.evaluation } : {}),
    diagnostics: input.diagnostics,
    compatibility: STAGED_TASK_COMPATIBILITY,
    redaction: { class: "internal", fields: ["diagnostics.details", "outputRefs.preview", "evaluation.reason"] }
  };
}

function stageOutputRefs(
  workflow: NonNullable<AgentLoopProfilePolicyMetadata["stagedTaskWorkflow"]>,
  stage: StagedTaskStageContract,
  capabilityId: string,
  toolCallId: string
): readonly StagedTaskRef[] {
  return stage.expectedOutputRefs
    .map((refId) => workflow.graph.refs.find((ref) => ref.refId === refId) ?? workflowEvidenceRef(refId, stage.stageId))
    .map((ref) => ({
      ...ref,
      metadata: {
        ...(ref.metadata ?? {}),
        capabilityId,
        toolCallId
      }
    }));
}

function supervisorDownstreamStageFromReviewedEvidence(input: {
  readonly policy: AgentLoopProfilePolicyMetadata;
  readonly workflow: NonNullable<AgentLoopProfilePolicyMetadata["stagedTaskWorkflow"]>;
  readonly capabilityId: string;
  readonly toolInput: JsonObject;
}): { readonly reviewStage: StagedTaskStageContract; readonly stage: StagedTaskStageContract } | undefined {
  if (stageAcceptanceMode(input.policy) !== "supervisor") return undefined;
  const reviewState = input.workflow.runState.stageStates.find((stage) =>
    stage.status === "running" &&
    stage.evaluation?.status === "needs-review"
  );
  if (!reviewState) return undefined;
  const reviewStage = input.workflow.graph.stages.find((stage) => stage.stageId === reviewState.stageId);
  if (!reviewStage) return undefined;
  if (readyStageNeedsDiagnosticEvidenceReview(reviewStage.kind, reviewState.inputRefs ?? [], input.workflow.runState.refs ?? [])) {
    return undefined;
  }
  const downstream = input.workflow.graph.stages.find((stage) =>
    stage.dependsOn.includes(reviewStage.stageId) &&
    (stage.allowedTools ?? []).map(String).includes(input.capabilityId) &&
    stageCanCompleteFromToolEvidence(stage, input.capabilityId, input.toolInput)
  );
  if (!downstream) return undefined;
  return { reviewStage, stage: downstream };
}

function workflowStageEvaluation(input: {
  readonly stage: StagedTaskStageContract;
  readonly evidenceRefs: readonly string[];
  readonly toolCallId: string;
  readonly at: string;
  readonly mode: "automatic" | "supervisor";
}): StagedTaskEvaluationResult {
  return {
    schemaVersion: STAGED_TASK_SCHEMA_VERSION,
    evaluationId: `evaluation:${input.stage.stageId}:${input.toolCallId}`,
    stageId: input.stage.stageId,
    evaluatorId: "runtime:tool-evidence-evaluator",
    status: input.mode === "automatic" ? "passed" : "needs-review",
    reason: input.mode === "automatic"
      ? "Runtime-accepted tool evidence satisfied the ordinary CLI stage acceptance policy."
      : "Tool evidence completed the stage action; supervisor acceptance is required before downstream expansion.",
    evidenceRefs: input.evidenceRefs,
    evaluatedAt: input.at,
    compatibility: STAGED_TASK_COMPATIBILITY,
    redaction: { class: "internal", fields: ["reason"] }
  };
}

function stageAcceptanceMode(policy: AgentLoopProfilePolicyMetadata): "automatic" | "supervisor" {
  if (policy.stageAcceptanceMode === "automatic" || policy.stageAcceptanceMode === "supervisor") return policy.stageAcceptanceMode;
  return isGovernedWorkflowBoundary(policy) ? "supervisor" : "automatic";
}

function stageKindForCapability(
  stages: readonly StagedTaskStageContract[],
  capabilityId: string
): string | undefined {
  return stages.find((stage) => (stage.allowedTools ?? []).map(String).includes(capabilityId))?.kind;
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
