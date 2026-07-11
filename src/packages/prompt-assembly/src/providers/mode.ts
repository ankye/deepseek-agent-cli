import { PROMPT_ASSEMBLY_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import type { AgentLoopToolProjection, CapabilityManifest, JsonObject, StagedTaskStageKind } from "@deepseek/platform-contracts";
import type { PromptSectionProviderRegistration } from "../assembler.js";
import { createPromptSection, stableHash } from "../sections.js";
import { isCapabilityVisibleForProjection } from "../tool-projection.js";

export function createModeProviders(): readonly PromptSectionProviderRegistration[] {
  return [
    createModeContextProvider(),
    createProfileWorkflowProvider(),
    createTaskIntentContractProvider(),
    createProfileWorkflowStateProvider(),
    createPhasePlanProvider(),
    createLoopBudgetProvider(),
    createWorkOrderProvider(),
    createVerifierExpectationsProvider(),
    createReasoningEffortPolicyProvider()
  ];
}

function createModeContextProvider(): PromptSectionProviderRegistration {
  return {
    id: "core.mode-context",
    version: "1.0.0",
    kind: "system.mode",
    source: "runtime",
    priority: 995,
    budgetClass: "required",
    trust: "system",
    required: true,
    compatibility: { schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION },
    provide(input) {
      if (!input.interactionMode && !input.agentMode && !input.phasePlan) return [];
      return [createPromptSection({
        id: "section.mode-context",
        providerId: "core.mode-context",
        kind: "system.mode",
        source: "runtime",
        role: "system",
        content: [
          "Runtime mode context:",
          `- Interaction mode: ${input.interactionMode ?? input.phasePlan?.interactionMode ?? "unspecified"}.`,
          `- Agent mode: ${input.agentMode ?? input.phasePlan?.agentMode ?? "default"}.`,
          "- Interaction mode controls rendering/input only; agent mode controls execution strategy.",
          "- Do not treat slash commands, mode names, or runtime-owned sections as user prompt text.",
          "- Preserve the exact user prompt boundary at the final user message."
        ].join("\n"),
        priority: 995,
        budgetClass: "required",
        trust: "system",
        required: true,
        provenance: {
          interactionMode: input.interactionMode ?? input.phasePlan?.interactionMode ?? "",
          agentMode: input.agentMode ?? input.phasePlan?.agentMode ?? ""
        }
      })];
    }
  };
}

function createProfileWorkflowProvider(): PromptSectionProviderRegistration {
  return {
    id: "core.profile-workflow",
    version: "1.0.0",
    kind: "system.mode",
    source: "runtime",
    priority: 993,
    budgetClass: "required",
    trust: "system",
    required: false,
    compatibility: { schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION },
    provide(input) {
      const policy = input.profilePolicy;
      if (!policy) return [];
      const compiler = capabilityAffordanceCompilerMetadata(policy);
      const workflowStageLines = profileWorkflowStageLines(policy.workflowStages ?? []);
      return [createPromptSection({
        id: "section.profile-workflow",
        providerId: "core.profile-workflow",
        kind: "system.mode",
        source: "runtime",
        role: "system",
        content: [
          "Agent profile workflow:",
          `- Profile id: ${policy.profileId}.`,
          `- Role: ${policy.role}.`,
          `- Workflow graph: ${policy.workflowGraphId}.`,
          `- Workflow priority: ${policy.workflowPriority}.`,
          `- Orchestration mode: ${policy.orchestrationMode}.`,
          `- Primary orchestration capabilities: ${policy.workflowCapabilityIds.join(", ") || "none"}.`,
          `- Required capability families: ${compiler.requiredFamilyIds.join(", ") || "none"}.`,
          `- Capability compiler status: ${compiler.status}.`,
          `- Resolved compiler capabilities: ${compiler.resolvedCapabilityIds.join(", ") || "none"}.`,
          `- Hidden or missing compiler capabilities: ${compiler.hiddenCapabilityIds.join(", ") || "none"}.`,
          ...(workflowStageLines.length > 0 ? [
            "Workflow stages:",
            ...workflowStageLines
          ] : []),
          `- Tool projection source: ${policy.toolProjectionSource}${policy.toolProjection ? ` (${policy.toolProjection})` : ""}.`,
          `- Context pipeline: ${policy.contextPipelineEnabled ? "enabled" : "default"}.`,
          `- Execution boundary: ${policy.executionBoundary}.`,
          policy.antiTailoring
            ? "- Use the workflow to compose generic capabilities; do not tailor behavior to a specific benchmark instance."
            : "- Use the workflow to compose generic capabilities for the current task."
        ].join("\n"),
        priority: 993,
        budgetClass: "required",
        trust: "system",
        required: true,
        provenance: {
          profileId: policy.profileId,
          role: policy.role,
          workflowGraphId: policy.workflowGraphId,
          workflowPriority: policy.workflowPriority,
          orchestrationMode: policy.orchestrationMode,
          workflowCapabilityIds: policy.workflowCapabilityIds,
          requiredFamilyIds: compiler.requiredFamilyIds,
          capabilityCompilerStatus: compiler.status,
          resolvedCapabilityIds: compiler.resolvedCapabilityIds,
          hiddenCapabilityIds: compiler.hiddenCapabilityIds,
          workflowStageIds: (policy.workflowStages ?? []).map((stage) => stage.id),
          toolProjectionSource: policy.toolProjectionSource,
          contextPipelineEnabled: policy.contextPipelineEnabled === true,
          antiTailoring: policy.antiTailoring
        }
      })];
    }
  };
}

function createTaskIntentContractProvider(): PromptSectionProviderRegistration {
  return {
    id: "core.task-intent-contract",
    version: "1.0.0",
    kind: "task.intent",
    source: "runtime",
    priority: 991,
    budgetClass: "required",
    trust: "system",
    required: false,
    compatibility: { schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION },
    provide(input) {
      const policy = input.profilePolicy;
      if (!policy) return [];
      const compiler = capabilityAffordanceCompilerMetadata(policy);
      const workflowStageIds = (policy.workflowStages ?? []).map((stage) => stage.id);
      const mutationContract = mutationToolContractLines(policy.workflowCapabilityIds);
      return [createPromptSection({
        id: "section.task-intent-contract",
        providerId: "core.task-intent-contract",
        kind: "task.intent",
        source: "runtime",
        role: "system",
        content: [
          "Task intent contract:",
          `- Intent family: ${taskIntentFamilyForPolicy(policy.role)}.`,
          "- Prompt boundary: the final user message is the immutable task input.",
          `- Selected profile role: ${policy.role}.`,
          `- Workflow route: ${policy.workflowGraphId} (${policy.orchestrationMode}, ${policy.workflowPriority}).`,
          `- Workflow stages: ${workflowStageIds.join(", ") || "none"}.`,
          `- Primary capability route: ${policy.workflowCapabilityIds.join(", ") || "none"}.`,
          `- Required family route: ${compiler.requiredFamilyIds.join(", ") || "none"}.`,
          `- Capability compiler status: ${compiler.status}.`,
          `- Resolved route capabilities: ${compiler.resolvedCapabilityIds.join(", ") || "none"}.`,
          "- Completion contract: follow the selected workflow's ready stage using completion-grade capability evidence, or report a bounded blocker.",
          ...mutationContract,
          "- Cache contract: this task intent is deterministic for the prompt/profile contract and excludes dynamic stage run state.",
          policy.antiTailoring
            ? "- Anti-tailoring: do not branch on benchmark repositories, instance ids, task numbers, expected patches, or known solutions."
            : "- Use the selected workflow as generic capability composition guidance."
        ].join("\n"),
        priority: 991,
        budgetClass: "required",
        trust: "system",
        required: true,
        provenance: {
          promptHash: stableHash(input.prompt),
          profileId: policy.profileId,
          role: policy.role,
          workflowGraphId: policy.workflowGraphId,
          workflowPriority: policy.workflowPriority,
          orchestrationMode: policy.orchestrationMode,
          workflowStageIds,
          workflowCapabilityIds: policy.workflowCapabilityIds,
          requiredFamilyIds: compiler.requiredFamilyIds,
          capabilityCompilerStatus: compiler.status,
          antiTailoring: policy.antiTailoring
        }
      })];
    }
  };
}

function mutationToolContractLines(capabilityIds: readonly string[]): readonly string[] {
  const hasMutationTool = capabilityIds.some((capabilityId) =>
    capabilityId === "core.file.edit" ||
    capabilityId === "core.patch.apply" ||
    capabilityId === "core.file.write"
  );
  if (!hasMutationTool) return [];
  return [
    "Mutation tool contract:",
    "- Mutation shape: make one real source change using current accepted evidence.",
    "- For core.file.edit, copy exact current expected text from accepted evidence and provide a different replacement.",
    "- For core.patch.apply, provide a complete unified diff with file headers and at least one hunk.",
    "- Do not send empty patches, no-op edits, placeholder hunks, or stale context."
  ];
}

function createProfileWorkflowStateProvider(): PromptSectionProviderRegistration {
  return {
    id: "core.profile-workflow-state",
    version: "1.0.0",
    kind: "system.mode",
    source: "runtime",
    priority: 992,
    budgetClass: "required",
    trust: "system",
    required: false,
    compatibility: { schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION },
    provide(input) {
      const policy = input.profilePolicy;
      const workflow = policy?.stagedTaskWorkflow;
      const supervisorWorkflowState = policy?.supervisorWorkflowState;
      if (!policy || (!workflow && !supervisorWorkflowState)) return [];
      const stageLines = workflow?.runState.stageStates
        .map((stage) => `- ${stage.stageId}:${stage.status} refs=${stage.outputRefs.join(",") || "none"} attempts=${stage.attempts}`);
      const stagesById = new Map((workflow?.graph.stages ?? []).map((stage) => [stage.stageId, stage]));
      const readyStageLines = (workflow?.runState.stageStates ?? [])
        .filter((stage) => stage.status === "ready")
        .map((stage) => {
          const stageContract = stagesById.get(stage.stageId);
          const allowedTools = gateAdjustedReadyStageTools(stageContract?.kind, stageContract?.allowedTools ?? [], policy.workflowGateOverride?.requiredNextAction);
          const progressTools = progressCapabilitiesForStage(stageContract?.kind, allowedTools);
          const requiredAction = progressTools.length > 0 ? progressTools.join("|") : allowedTools.join("|");
          return `- ${stage.stageId} kind=${stageContract?.kind ?? "unknown"} tools=${allowedTools.join(", ") || "none"} progress=${progressTools.join(", ") || "none"} required=${requiredAction || "none"} primary=${primaryNextActionForStage(stageContract?.kind, allowedTools)}`;
        });
      const readyStageGuidanceLines = workflow ? readyStageGuidanceFor(workflow.runState.stageStates, workflow.graph.stages) : [];
      const supervisorStageLines = supervisorWorkflowState?.stageStates
        .map((stage) => `- ${stage.stageId}:${stage.status} refs=${stage.outputRefs.join(",") || "none"} attempts=${stage.attempts}`) ?? [];
      return [createPromptSection({
        id: "section.profile-workflow-state",
        providerId: "core.profile-workflow-state",
        kind: "system.mode",
        source: "runtime",
        role: "system",
        content: [
          "Agent profile workflow state:",
          `- Profile id: ${policy.profileId}.`,
          ...(workflow ? [
            `- Task run: ${workflow.runState.taskRunId}.`,
            `- Graph: ${workflow.graphId}.`,
            "Current stage states:",
            ...(stageLines ?? [])
          ] : []),
          ...(supervisorWorkflowState ? [
            "Supervisor workflow state:",
            `- Task run: ${supervisorWorkflowState.taskRunId}.`,
            `- Graph: ${supervisorWorkflowState.graphId}.`,
            "Supervisor stage states:",
            ...supervisorStageLines
          ] : []),
          ...(policy.workflowGateOverride ? [
            `Gate-enforced next action: ${policy.workflowGateOverride.requiredNextAction}.`,
            `Gate: ${policy.workflowGateOverride.gate} rejected ${policy.workflowGateOverride.rejectedToolName ?? policy.workflowGateOverride.rejectedCapabilityId ?? "unknown"}; do not choose another tool from that rejected action family until the required next action has progress.`
          ] : []),
          ...(readyStageLines.length > 0 ? [
            "Ready stage capabilities:",
            ...readyStageLines,
            ...readyStageGuidanceLines
          ] : []),
          "- Treat succeeded stages as evidence-backed progress; choose the next ready stage capability or report a bounded blocker."
        ].join("\n"),
        priority: 992,
        budgetClass: "required",
        trust: "system",
        required: true,
        provenance: {
          profileId: policy.profileId,
          ...(workflow ? {
            graphId: workflow.graphId,
            taskRunId: workflow.runState.taskRunId,
            stageStates: workflow.runState.stageStates.map((stage) => `${stage.stageId}:${stage.status}`),
            readyStageIds: workflow.runState.stageStates.filter((stage) => stage.status === "ready").map((stage) => stage.stageId)
          } : {}),
          ...(supervisorWorkflowState ? {
            supervisorGraphId: supervisorWorkflowState.graphId,
            supervisorTaskRunId: supervisorWorkflowState.taskRunId,
            supervisorStageStates: supervisorWorkflowState.stageStates.map((stage) => `${stage.stageId}:${stage.status}`)
          } : {}),
          ...(policy.workflowGateOverride ? { workflowGateOverride: policy.workflowGateOverride } : {})
        }
      })];
    }
  };
}

function taskIntentFamilyForPolicy(role: string): string {
  if (role.includes("evaluation")) return "governed-evaluation-workflow";
  if (role.includes("review")) return "governed-review-workflow";
  if (role.includes("release")) return "governed-release-workflow";
  return "governed-capability-workflow";
}

function primaryNextActionForStage(kind: StagedTaskStageKind | undefined, allowedTools: readonly string[]): string {
  if (kind === "produce" || kind === "repair") {
    return progressMutationCapabilityIds(allowedTools).length > 0
      ? "mutation-grade edit/patch or bounded blocker"
      : "completion-grade production action or bounded blocker";
  }
  if (kind === "verify") return "standard test/diff evidence or bounded blocker";
  if (kind === "collect-evidence") return "focused bounded evidence collection or bounded blocker";
  if (kind === "score") return "governed scoring/evaluation action or bounded blocker";
  if (kind === "materialize") return "materialization action or bounded blocker";
  return "ready-stage capability or bounded blocker";
}

function progressCapabilitiesForStage(kind: StagedTaskStageKind | undefined, allowedTools: readonly string[]): readonly string[] {
  if (kind === "produce" || kind === "materialize" || kind === "repair") {
    const mutationTools = progressMutationCapabilityIds(allowedTools);
    return mutationTools.length > 0 ? mutationTools : allowedTools;
  }
  if (kind === "verify" || kind === "score") {
    const verificationTools = allowedTools.filter(isVerificationCapabilityId);
    return verificationTools.length > 0 ? verificationTools : allowedTools;
  }
  return allowedTools;
}

function gateAdjustedReadyStageTools(
  kind: StagedTaskStageKind | undefined,
  allowedTools: readonly string[],
  requiredNextAction: string | undefined
): readonly string[] {
  if (requiredNextAction !== "source-edit-or-test-or-blocker" && requiredNextAction !== "source-edit-or-test-or-bounded-blocker") return allowedTools;
  if (kind !== "produce" && kind !== "repair" && kind !== "verify") return allowedTools;
  const progressTools = allowedTools.filter((capabilityId) => isMutationCapabilityId(capabilityId) || isVerificationCapabilityId(capabilityId));
  return progressTools.length > 0 ? progressTools : allowedTools;
}

function readyStageGuidanceFor(
  stageStates: readonly { readonly stageId: string; readonly status: string }[],
  stageContracts: readonly { readonly stageId: string; readonly kind: StagedTaskStageKind; readonly allowedTools?: readonly string[] }[]
): readonly string[] {
  const succeededKinds = new Set(stageStates
    .filter((state) => state.status === "succeeded")
    .map((state) => stageContracts.find((stage) => stage.stageId === state.stageId)?.kind)
    .filter((kind): kind is StagedTaskStageKind => Boolean(kind)));
  const readyContracts = stageStates
    .filter((state) => state.status === "ready")
    .map((state) => stageContracts.find((stage) => stage.stageId === state.stageId))
    .filter((stage): stage is { readonly stageId: string; readonly kind: StagedTaskStageKind; readonly allowedTools?: readonly string[] } => Boolean(stage));
  const hasEvidenceSucceeded = succeededKinds.has("collect-evidence");
  const hasMutationReady = readyContracts.some((stage) => stage.kind === "produce" || stage.kind === "repair");
  if (!hasEvidenceSucceeded || !hasMutationReady) return [];
  return [
    "- Ready stage rule: read/search/list-only exploration is supporting evidence, not completion-grade progress for produce or repair stages after evidence collection.",
    "- Use mutation-grade edit/patch capability evidence for source-change progress when available; use whole-file write only when no surgical mutation tool can express the change, or report a bounded blocker."
  ];
}

function isMutationCapabilityId(capabilityId: string): boolean {
  return capabilityId.includes(".edit")
    || capabilityId.includes(".write")
    || capabilityId.includes(".patch")
    || capabilityId.includes("patch.apply")
    || capabilityId.includes("file-edit")
    || capabilityId.includes("file.write");
}

function progressMutationCapabilityIds(capabilityIds: readonly string[]): readonly string[] {
  const mutation = capabilityIds.filter(isMutationCapabilityId);
  const surgical = mutation.filter((capabilityId) => !capabilityId.endsWith(".write") && !capabilityId.includes("file.write"));
  return surgical.length > 0 ? surgical : mutation;
}

function isVerificationCapabilityId(capabilityId: string): boolean {
  return capabilityId.includes(".test")
    || capabilityId.includes(".diff")
    || capabilityId.includes("test.run")
    || capabilityId.includes("git.diff");
}

function profileWorkflowStageLines(stages: readonly {
  readonly id: string;
  readonly objective: string;
  readonly capabilityIds: readonly string[];
  readonly entryCriteria: readonly string[];
  readonly exitCriteria: readonly string[];
}[]): readonly string[] {
  return stages.map((stage, index) => [
    `${index + 1}. ${stage.id}: ${stage.objective}`,
    `capabilities=${stage.capabilityIds.join(", ") || "none"}`,
    `entry=${stage.entryCriteria.join("; ") || "none"}`,
    `exit=${stage.exitCriteria.join("; ") || "none"}`
  ].join(" | "));
}

function profileWorkflowCapabilityVisibility(
  capabilityIds: readonly string[],
  availableTools: readonly CapabilityManifest[],
  toolPolicy: AgentLoopToolProjection,
  compiler?: {
    readonly status: string;
    readonly resolvedCapabilityIds: readonly string[];
    readonly hiddenCapabilityIds: readonly string[];
  }
): {
  readonly modelVisible: readonly string[];
  readonly projectionLimited: readonly string[];
  readonly unregistered: readonly string[];
} {
  const availableById = new Map(availableTools.map((capability) => [String(capability.id), capability]));
  const resolved = new Set(compiler?.status === "ready" ? compiler.resolvedCapabilityIds : []);
  const hiddenOrMissing = new Set(compiler?.hiddenCapabilityIds ?? []);
  const modelVisible: string[] = [];
  const projectionLimited: string[] = [];
  const unregistered: string[] = [];
  for (const capabilityId of capabilityIds) {
    const capability = availableById.get(capabilityId);
    if (!capability && resolved.has(capabilityId) && !hiddenOrMissing.has(capabilityId)) {
      projectionLimited.push(capabilityId);
    } else if (!capability) {
      unregistered.push(capabilityId);
    } else if (isCapabilityVisibleForProjection(capability, toolPolicy)) {
      modelVisible.push(capabilityId);
    } else {
      projectionLimited.push(capabilityId);
    }
  }
  return { modelVisible, projectionLimited, unregistered };
}

function capabilityAffordanceCompilerMetadata(policy: {
  readonly workflowCapabilityIds: readonly string[];
  readonly requiredFamilyIds?: readonly string[];
  readonly capabilityAffordanceCompiler?: JsonObject;
}): {
  readonly status: string;
  readonly requiredFamilyIds: readonly string[];
  readonly resolvedCapabilityIds: readonly string[];
  readonly hiddenCapabilityIds: readonly string[];
} {
  const compiler = policy.capabilityAffordanceCompiler;
  const requiredFamilyIds = stringArray(compiler?.requiredFamilyIds) ?? policy.requiredFamilyIds ?? [];
  const resolvedCapabilityIds = stringArray(compiler?.resolvedCapabilityIds) ?? policy.workflowCapabilityIds;
  const missingCapabilityIds = stringArray(compiler?.missingCapabilityIds) ?? [];
  const hiddenCapabilityIds = stringArray(compiler?.hiddenCapabilityIds) ?? missingCapabilityIds;
  return {
    status: typeof compiler?.status === "string" ? compiler.status : "unavailable",
    requiredFamilyIds,
    resolvedCapabilityIds,
    hiddenCapabilityIds
  };
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function createPhasePlanProvider(): PromptSectionProviderRegistration {
  return {
    id: "core.phase-plan",
    version: "1.0.0",
    kind: "system.mode",
    source: "runtime",
    priority: 990,
    budgetClass: "required",
    trust: "system",
    required: true,
    compatibility: { schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION },
    provide(input) {
      const plan = input.phasePlan;
      if (!plan) return [];
      return [createPromptSection({
        id: "section.phase-plan",
        providerId: "core.phase-plan",
        kind: "system.mode",
        source: "runtime",
        role: "system",
        content: [
          "Agent phase plan:",
          `- Reason: ${plan.reason}`,
          ...plan.phases.map((phase) => `- ${phase.phase}: ${phase.status}${phase.required ? " required" : ""}${phase.skipReason ? ` skip=${phase.skipReason}` : ""} mode=${phase.mode}`)
        ].join("\n"),
        priority: 990,
        budgetClass: "required",
        trust: "system",
        required: true,
        provenance: {
          planId: plan.planId,
          requiredPhases: plan.phases.filter((phase) => phase.required).map((phase) => phase.phase),
          skippedPhases: plan.phases.filter((phase) => phase.status === "skipped").map((phase) => phase.phase)
        }
      })];
    }
  };
}

function createLoopBudgetProvider(): PromptSectionProviderRegistration {
  return {
    id: "core.loop-budget",
    version: "1.0.0",
    kind: "system.mode",
    source: "runtime",
    priority: 985,
    budgetClass: "required",
    trust: "system",
    required: true,
    compatibility: { schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION },
    provide(input) {
      const budgets = input.phasePlan?.budgets ?? [];
      if (budgets.length === 0) return [];
      return [createPromptSection({
        id: "section.loop-budget",
        providerId: "core.loop-budget",
        kind: "system.mode",
        source: "runtime",
        role: "system",
        content: [
          "External orchestration budgets:",
          ...budgets.map((budget) => `- ${budget.kind}: requested=${budget.requested} allowed=${budget.allowed} consumed=${budget.consumed} remaining=${budget.remaining}${budget.stopReason ? ` stop=${budget.stopReason}` : ""}`),
          "- These budgets are external proof/repair/delegation loops. They are separate from model reasoning effort."
        ].join("\n"),
        priority: 985,
        budgetClass: "required",
        trust: "system",
        required: true,
        provenance: {
          budgets: budgets.map((budget) => `${budget.kind}:${budget.requested}:${budget.consumed}`)
        }
      })];
    }
  };
}

function createWorkOrderProvider(): PromptSectionProviderRegistration {
  return {
    id: "core.work-order",
    version: "1.0.0",
    kind: "task.work-order",
    source: "runtime",
    priority: 982,
    budgetClass: "required",
    trust: "system",
    required: true,
    compatibility: { schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION },
    provide(input) {
      const workOrder = input.workOrder;
      if (!workOrder) return [];
      return [createPromptSection({
        id: "section.work-order",
        providerId: "core.work-order",
        kind: "task.work-order",
        source: "runtime",
        role: "system",
        content: [
          "Structured worker work order:",
          `- Work order id: ${workOrder.workOrderId}.`,
          `- Mode: ${workOrder.mode}.`,
          `- Purpose: ${workOrder.purpose}`,
          `- Original user goal: ${workOrder.originalUserGoal}`,
          `- Task summary: ${workOrder.taskSummary}`,
          `- Evidence ids: ${workOrder.evidenceIds.join(", ") || "none"}.`,
          `- Targets: ${workOrder.targets.map((target) => `${target.kind}:${target.path ?? target.id}`).join(", ") || "none"}.`,
          `- Allowed tools: ${workOrder.allowedTools.join(", ") || "none"}.`,
          `- Done criteria: ${workOrder.doneCriteria.join("; ") || "none"}.`,
          `- Verification expectations: ${workOrder.verificationExpectations.join("; ") || "none"}.`
        ].join("\n"),
        priority: 982,
        budgetClass: "required",
        trust: "system",
        required: true,
        provenance: {
          workOrderId: workOrder.workOrderId,
          targetCount: workOrder.targets.length,
          evidenceIds: workOrder.evidenceIds
        }
      })];
    }
  };
}

function createVerifierExpectationsProvider(): PromptSectionProviderRegistration {
  return {
    id: "core.verifier-expectations",
    version: "1.0.0",
    kind: "system.mode",
    source: "runtime",
    priority: 979,
    budgetClass: "high",
    trust: "system",
    required: false,
    compatibility: { schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION },
    provide(input) {
      const verifyPhase = input.phasePlan?.phases.find((phase) => phase.phase === "verify");
      if (!verifyPhase || verifyPhase.status === "skipped") return [];
      return [createPromptSection({
        id: "section.verifier-expectations",
        providerId: "core.verifier-expectations",
        kind: "system.mode",
        source: "runtime",
        role: "system",
        content: [
          "Verifier expectations:",
          "- Non-trivial task success requires independent proof or an explicit partial/skip status.",
          "- Cite command/evidence ids for pass, fail, or partial verdicts.",
          "- A worker or implementer's self-check is not independent verification.",
          input.verifierResult ? `- Current verifier verdict: ${input.verifierResult.verdict}; ${input.verifierResult.summary}` : "- Runtime verifier execution may still be pending; do not overstate completion without evidence."
        ].join("\n"),
        priority: 979,
        budgetClass: "high",
        trust: "system",
        required: false,
        provenance: {
          phase: verifyPhase.phase,
          status: verifyPhase.status,
          verifierResultId: input.verifierResult?.verifierResultId ?? ""
        }
      })];
    }
  };
}

function createReasoningEffortPolicyProvider(): PromptSectionProviderRegistration {
  return {
    id: "core.reasoning-effort-policy",
    version: "1.0.0",
    kind: "system.mode",
    source: "runtime",
    priority: 978,
    budgetClass: "high",
    trust: "system",
    required: false,
    compatibility: { schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION },
    provide(input) {
      const mapping = input.reasoningEffortMapping;
      if (!mapping) return [];
      return [createPromptSection({
        id: "section.reasoning-effort-policy",
        providerId: "core.reasoning-effort-policy",
        kind: "system.mode",
        source: "runtime",
        role: "system",
        content: [
          "Reasoning effort policy:",
          `- Requested effort: ${mapping.requestedEffort ?? "none"}.`,
          `- Provider mapped effort: ${mapping.providerEffort ?? "none"}.`,
          `- Provider/model: ${mapping.provider}/${mapping.model}.`,
          "- Reasoning effort is a model/provider parameter. It is not evidence, verification, repair, or delegation proof."
        ].join("\n"),
        priority: 978,
        budgetClass: "high",
        trust: "system",
        required: false,
        provenance: {
          requestedEffort: mapping.requestedEffort ?? "",
          providerEffort: mapping.providerEffort ?? ""
        }
      })];
    }
  };
}
