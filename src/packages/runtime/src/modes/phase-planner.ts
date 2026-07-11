import type {
  AgentLoopRequest,
  AgentLoopLimits,
  AgentModeName,
  AgentPhaseName,
  AgentPhasePlan,
  AgentPhasePlanItem,
  AgentPhaseSkipReason,
  AgentPhaseStatus,
  EvidenceFirstRuntimeContext,
  InteractionModeName,
  SelfRepairConfig,
  SessionId,
  TraceContext,
  TurnId
} from "@deepseek/platform-contracts";
import { AGENT_MODE_COMPATIBILITY, AGENT_MODE_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import { stableHash } from "../trace.js";
import { createAgentLoopBudget } from "./budgets.js";

export interface RuntimeModePlan {
  readonly interactionMode: InteractionModeName;
  readonly agentMode: AgentModeName;
  readonly phasePlan: AgentPhasePlan;
  readonly skippedPhases: readonly AgentPhasePlanItem[];
}

export function createRuntimeModePlan(input: {
  readonly request: AgentLoopRequest;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly trace: TraceContext;
  readonly limits: AgentLoopLimits;
  readonly evidenceFirst: EvidenceFirstRuntimeContext;
  readonly selfRepair: SelfRepairConfig;
}): RuntimeModePlan {
  const interactionMode = input.request.interactionMode ?? interactionModeFor(input.request);
  const agentMode = input.request.agentMode ?? "default";
  const factSensitive = input.evidenceFirst.classification.evidenceRequired;
  const mutatingOrGenerated = taskLooksMutating(input.request.prompt) || input.evidenceFirst.classification.intents.includes("generated-artifact");
  const nonTrivial = factSensitive || mutatingOrGenerated || input.request.toolProjection === "read-write" || input.request.toolProjection === "safe-all" || input.request.toolProjection === "all";

  const evidenceBudget = createAgentLoopBudget({
    kind: "evidence",
    requested: factSensitive ? 1 : 0,
    allowed: factSensitive ? 1 : 0,
    consumed: input.evidenceFirst.selectedEvidence.length > 0 ? 1 : 0,
    policySource: "runtime.phase-planner"
  });
  const verificationBudget = createAgentLoopBudget({
    kind: "verification",
    requested: nonTrivial ? 1 : 0,
    allowed: nonTrivial ? 1 : 0,
    consumed: 0,
    policySource: "runtime.phase-planner"
  });
  const repairAttemptBudget = input.selfRepair.enabled ? input.selfRepair.maxAttempts : input.limits.maxRetries;
  const repairBudget = createAgentLoopBudget({
    kind: "repair",
    requested: repairAttemptBudget,
    allowed: repairAttemptBudget,
    consumed: 0,
    ...(repairAttemptBudget === 0 ? { stopReason: "user-disabled" } : {}),
    policySource: "runtime.phase-planner"
  });
  const delegationBudget = createAgentLoopBudget({
    kind: "delegation",
    requested: agentMode === "coordinator" ? 1 : 0,
    allowed: agentMode === "coordinator" ? 1 : 0,
    consumed: 0,
    ...(agentMode !== "coordinator" ? { stopReason: "not-coordinator-mode" } : {}),
    policySource: "runtime.phase-planner"
  });
  const modelIterationBudget = createAgentLoopBudget({
    kind: "model-iteration",
    requested: input.limits.maxModelIterations,
    allowed: input.limits.maxModelIterations,
    consumed: 0,
    policySource: "runtime.agent-loop-limits"
  });

  const phases: readonly AgentPhasePlanItem[] = [
    phase("classify", "completed", true, "default", []),
    factSensitive
      ? phase("evidence", input.evidenceFirst.selectedEvidence.length > 0 ? "completed" : "required", true, "evidence", [evidenceBudget])
      : phase("evidence", "skipped", false, "evidence", [evidenceBudget], "simple-task"),
    nonTrivial
      ? phase("plan", "required", true, "planner", [])
      : phase("plan", "skipped", false, "planner", [], "simple-task"),
    phase("execute", "required", true, agentMode === "coordinator" ? "coordinator" : "default", [modelIterationBudget]),
    nonTrivial
      ? phase("verify", "required", true, "verifier", [verificationBudget])
      : phase("verify", "skipped", false, "verifier", [verificationBudget], "low-risk"),
    repairAttemptBudget > 0
      ? phase("repair", "required", false, "repair", [repairBudget])
      : phase("repair", "skipped", false, "repair", [repairBudget], "user-disabled"),
    nonTrivial
      ? phase("synthesize", "required", true, "synthesis", [])
      : phase("synthesize", "skipped", false, "synthesis", [], "simple-task"),
    phase("complete", "required", true, "default", [])
  ];
  const budgets = [evidenceBudget, verificationBudget, repairBudget, delegationBudget, modelIterationBudget];
  const phasePlan: AgentPhasePlan = {
    schemaVersion: AGENT_MODE_SCHEMA_VERSION,
    planId: `agent-phase-plan:${stableHash(`${input.sessionId}:${input.turnId}:${input.request.prompt}`)}`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    interactionMode,
    agentMode,
    phases,
    budgets,
    reason: nonTrivial
      ? "Task is fact-sensitive, mutating, generated-artifact, or write-capable; evidence/plan/verification phases are explicit."
      : "Task is simple or low-risk; advanced phases are skipped with typed reasons.",
    diagnostics: [],
    trace: input.trace,
    redaction: { class: "internal", fields: ["reason", "diagnostics.details"] },
    compatibility: AGENT_MODE_COMPATIBILITY
  };

  return {
    interactionMode,
    agentMode,
    phasePlan,
    skippedPhases: phases.filter((item) => item.status === "skipped")
  };
}

function phase(
  phaseName: AgentPhaseName,
  status: AgentPhaseStatus,
  required: boolean,
  mode: AgentModeName,
  budgets: readonly import("@deepseek/platform-contracts").AgentLoopBudget[],
  skipReason?: AgentPhaseSkipReason
): AgentPhasePlanItem {
  return {
    schemaVersion: AGENT_MODE_SCHEMA_VERSION,
    phase: phaseName,
    status,
    required,
    ...(skipReason ? { skipReason } : {}),
    mode,
    budgets,
    diagnostics: [],
    redaction: { class: "internal" },
    compatibility: AGENT_MODE_COMPATIBILITY
  };
}

function interactionModeFor(request: AgentLoopRequest): InteractionModeName {
  if (request.caller.includes("chat")) return "chat";
  if (request.outputMode === "jsonl" || request.outputMode === "json") return "headless";
  return "one-shot";
}

function taskLooksMutating(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return [
    "edit",
    "write",
    "generate",
    "create",
    "fix",
    "refactor",
    "implement",
    "修改",
    "写入",
    "生成",
    "创建",
    "修复",
    "实现",
    "推进"
  ].some((needle) => lower.includes(needle));
}
