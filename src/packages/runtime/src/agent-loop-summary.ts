import type {
  AgentLoopRequest,
  AgentLoopOutputContractVerification,
  AgentLoopSummary,
  AgentModeSessionSummary,
  AgentPhasePlan,
  AgentReasoningEffortMapping,
  InteractionModeState,
  InteractionModeTransition,
  JsonObject,
  RedactedError,
  SelfRepairOutcomeSummary,
  SessionId,
  ToolFeedbackStatus,
  TraceContext,
  TurnId,
  VisibleReasoningProjection
} from "@deepseek/platform-contracts";
import { boundedModelText } from "./model-tooling.js";
import { defaultAgentLoopLimits } from "./agent-loop.js";

export interface AgentLoopModeSummaryInput {
  readonly phasePlan?: AgentPhasePlan | undefined;
  readonly modeSummary?: AgentModeSessionSummary | undefined;
  readonly interactionModeState?: InteractionModeState | undefined;
  readonly interactionModeTransitions?: readonly InteractionModeTransition[] | undefined;
  readonly reasoningEffortMapping?: AgentReasoningEffortMapping | undefined;
  readonly outputContract?: AgentLoopOutputContractVerification | undefined;
  readonly selfRepair?: SelfRepairOutcomeSummary | undefined;
  readonly visibleReasoning?: VisibleReasoningProjection | undefined;
  readonly taskDeliveryFlow?: JsonObject | undefined;
}

export function referenceContextSummary(request: AgentLoopRequest): JsonObject {
  const context = request.referenceContext;
  if (!context) return {};
  return {
    schemaVersion: context.schemaVersion,
    source: context.source,
    activeSetId: context.activeSetId,
    activeItemId: context.activeItemId,
    setCount: context.setCount,
    itemCount: context.itemCount,
    targets: context.sets.flatMap((set) => set.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      targetId: item.target.id,
      targetKind: item.target.kind,
      order: item.order
    }))),
    redaction: { class: "internal", fields: ["targets.targetId"] }
  };
}

export function summarizeAgentLoop(
  status: AgentLoopSummary["status"],
  request: AgentLoopRequest,
  sessionId: SessionId,
  turnId: TurnId,
  trace: TraceContext,
  assistantText: string,
  iterations: number,
  toolCalls: number,
  diagnostics: readonly RedactedError[],
  mode?: AgentLoopModeSummaryInput
): AgentLoopSummary {
  return {
    schemaVersion: "1.0.0",
    status,
    sessionId,
    turnId,
    traceId: String(trace.traceId),
    assistantText: boundedModelText(assistantText, request.limits?.maxOutputBytes ?? defaultAgentLoopLimits.maxOutputBytes),
    iterations,
    toolCalls,
    ...(mode?.phasePlan?.interactionMode ? { interactionMode: mode.phasePlan.interactionMode } : request.interactionMode ? { interactionMode: request.interactionMode } : {}),
    ...(mode?.phasePlan?.agentMode ? { agentMode: mode.phasePlan.agentMode } : request.agentMode ? { agentMode: request.agentMode } : {}),
    ...(mode?.modeSummary ? { modeSummary: mode.modeSummary } : {}),
    ...(mode?.phasePlan ? { phasePlan: mode.phasePlan } : {}),
    ...(mode?.interactionModeState ? { interactionModeState: mode.interactionModeState } : {}),
    ...(mode?.interactionModeTransitions ? { interactionModeTransitions: mode.interactionModeTransitions } : {}),
    ...(mode?.reasoningEffortMapping ? { reasoningEffortMapping: mode.reasoningEffortMapping } : {}),
    modelProvider: request.profile.providerId,
    modelProfile: request.profile.id,
    ...(mode?.outputContract ? { outputContract: mode.outputContract } : {}),
    ...(mode?.selfRepair ? { selfRepair: mode.selfRepair } : {}),
    ...(mode?.visibleReasoning ? { visibleReasoning: mode.visibleReasoning } : {}),
    ...(mode?.taskDeliveryFlow ? { taskDeliveryFlow: mode.taskDeliveryFlow } : {}),
    diagnostics,
    redaction: { class: "internal", fields: ["assistantText", "diagnostics.details", "selfRepair.classifications.diagnostics", "selfRepair.attempts.diagnostics"] }
  };
}

export function executionFeedbackStatus(terminal: import("@deepseek/platform-contracts").RuntimeEvent | undefined): ToolFeedbackStatus {
  if (!terminal) return "failed";
  if (terminal.kind === "capability.completed") {
    return completedCapabilityEvidenceStatus(terminal) === "failed" ? "failed" : "success";
  }
  if (terminal.kind === "capability.cancelled") {
    return terminal.error?.code === "KERNEL_SCHEDULER_TIMEOUT" ? "timeout" : "cancelled";
  }
  if (terminal.kind === "execution.rejected") {
    return terminal.error?.code === "KERNEL_POLICY_DENIED" ? "denied" : "rejected";
  }
  if (terminal.error?.code === "KERNEL_SCHEDULER_TIMEOUT") return "timeout";
  return "failed";
}

function completedCapabilityEvidenceStatus(terminal: import("@deepseek/platform-contracts").RuntimeEvent): string | undefined {
  const output = terminal.data.output;
  if (!isJsonObject(output)) return undefined;
  const evidence = output.evidence;
  if (!isJsonObject(evidence)) return undefined;
  return typeof evidence.status === "string" ? evidence.status : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
