import type {
  AgentLoopLimits,
  AgentLoopRequest,
  AgentLoopToolProjection,
  CapabilityManifest,
  ContextProjectionResult,
  AgentPhasePlan,
  AgentReasoningEffortMapping,
  JsonObject,
  ModelChatMessage,
  PromptSchedulingNextAction,
  PromptAssemblyMode,
  PromptAssemblyResult,
  RuntimeDependencies,
  SessionId,
  TaskDecisionRequest,
  ToolDecisionBoard,
  TraceContext,
  TurnId
} from "@deepseek/platform-contracts";
import { createDefaultPromptAssembler } from "@deepseek/prompt-assembly";

export async function assemblePromptForIteration(
  deps: RuntimeDependencies,
  request: AgentLoopRequest,
  sessionId: SessionId,
  turnId: TurnId,
  trace: TraceContext,
  messages: readonly ModelChatMessage[],
  contextProjection: ContextProjectionResult | undefined,
  availableCapabilities: readonly CapabilityManifest[],
  limits: AgentLoopLimits,
  evidenceFirst: import("@deepseek/platform-contracts").EvidenceFirstRuntimeContext | undefined,
  selfRepair: import("@deepseek/platform-contracts").SelfRepairOutcomeSummary | undefined,
  mode?: {
    readonly phasePlan?: AgentPhasePlan | undefined;
    readonly reasoningEffortMapping?: AgentReasoningEffortMapping | undefined;
    readonly taskDecision?: TaskDecisionRequest | undefined;
    readonly toolDecisionBoard?: ToolDecisionBoard | undefined;
    readonly schedulingNextAction?: PromptSchedulingNextAction | undefined;
  }
): Promise<PromptAssemblyResult> {
  const assembler = deps.promptAssembler ?? createDefaultPromptAssembler();
  return assembler.assemble({
    schemaVersion: "1.0.0",
    sessionId,
    turnId,
    ...(request.agentId ? { agentId: request.agentId } : {}),
    prompt: request.prompt,
    mode: promptAssemblyModeFor(request),
    caller: request.caller,
    workspaceRoot: request.workspaceRoot,
    outputMode: request.outputMode,
    profile: request.profile,
    ...(request.reasoning ? { reasoning: request.reasoning } : {}),
    trace,
    history: messages,
    ...(contextProjection ? { contextProjection } : {}),
    ...(contextProjection?.pipeline ? { contextPipelineManifest: contextProjection.pipeline } : {}),
    ...(mode?.taskDecision ? { taskDecision: mode.taskDecision } : {}),
    ...(mode?.schedulingNextAction ? { schedulingNextAction: mode.schedulingNextAction } : {}),
    ...(mode?.toolDecisionBoard ? { toolDecisionBoard: mode.toolDecisionBoard } : {}),
    ...(request.profilePolicy ? { profilePolicy: request.profilePolicy } : {}),
    ...(evidenceFirst ? { evidenceFirst } : {}),
    ...(selfRepair ? { selfRepair } : {}),
    ...(request.projectRules ? { projectRules: request.projectRules } : {}),
    ...(mode?.phasePlan ? {
      interactionMode: mode.phasePlan.interactionMode,
      agentMode: mode.phasePlan.agentMode,
      phasePlan: mode.phasePlan
    } : {}),
    ...(mode?.reasoningEffortMapping ? { reasoningEffortMapping: mode.reasoningEffortMapping } : {}),
    ...(request.referenceContext ? { referenceContext: request.referenceContext } : {}),
    ...(request.outputContract ? { outputContract: request.outputContract } : {}),
    availableTools: availableCapabilities,
    toolPolicy: toolProjectionPolicy(request),
    ...(request.toolOptIns ? { toolOptIns: request.toolOptIns } : {}),
    budget: {
      hardLimitTokens: limits.maxOutputBytes,
      reservedOutputTokens: 0
    },
    compatibility: { schemaVersion: "1.0.0" }
  });
}

export function promptAssemblyEventPayload(assembly: PromptAssemblyResult, request: AgentLoopRequest): JsonObject {
  const { visibleTools: _visibleTools, excludedTools: _excludedTools, ...toolPlanSummary } = assembly.toolPlan;
  return {
    schemaVersion: assembly.schemaVersion,
    status: assembly.status,
    fingerprint: assembly.fingerprint,
    messageCount: assembly.messages.length,
    sectionCount: assembly.sections.length,
    includedSectionCount: assembly.budget.includedSectionCount,
    excludedSectionCount: assembly.budget.excludedSectionCount,
    budget: assembly.budget,
    toolPlan: toolPlanSummary,
    providerTarget: {
      providerId: request.profile.providerId,
      profileId: request.profile.id,
      model: request.profile.model
    },
    trace: assembly.trace,
    projectRules: assembly.trace.projectRules.map((rule) => ({
      source: rule.source,
      status: rule.status,
      priority: rule.priority,
      ...(rule.path ? { path: rule.path } : {}),
      ...(rule.fingerprint ? { fingerprint: rule.fingerprint } : {}),
      bytes: rule.bytes ?? 0,
      diagnosticCount: rule.diagnostics.length,
      redaction: rule.redaction
    })),
    diagnostics: assembly.diagnostics,
    redaction: assembly.redaction,
    compatibility: assembly.compatibility
  };
}

export function toolProjectionPolicy(request: AgentLoopRequest): AgentLoopToolProjection {
  return request.toolProjection ?? (request.live ? "read-only" : "safe-all");
}

function promptAssemblyModeFor(request: AgentLoopRequest): PromptAssemblyMode {
  const lower = request.prompt.toLowerCase();
  if (lower.includes("html") || lower.includes("webpage") || lower.includes("网页")) return "webpage-generation";
  return "coding";
}
