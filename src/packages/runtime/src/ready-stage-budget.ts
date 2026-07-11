import type { AgentLoopLimits, JsonObject, ModelChatMessage } from "@deepseek/platform-contracts";

export type ReadyStageBudget = NonNullable<AgentLoopLimits["stageBudgets"]>[number];

export interface ReadyStageBudgetUsage {
  readonly modelIterations: number;
  readonly toolCalls: number;
  readonly modelIterationReviewInjected: boolean;
  readonly toolCallReviewInjected: boolean;
}

export function readyStageBudgetForControl(
  limits: AgentLoopLimits,
  control: JsonObject
): ReadyStageBudget | undefined {
  const budgets = limits.stageBudgets ?? [];
  const activeStageId = typeof control.stageId === "string" ? control.stageId : undefined;
  const activeStageKind = typeof control.stageKind === "string" ? control.stageKind : undefined;
  const budgetStageId = typeof control.budgetStageId === "string" ? control.budgetStageId : activeStageId;
  const budgetStageKind = typeof control.budgetStageKind === "string" ? control.budgetStageKind : activeStageKind;
  return findReadyStageBudget(budgets, activeStageId, activeStageKind) ??
    findReadyStageBudget(budgets, budgetStageId, budgetStageKind);
}

function findReadyStageBudget(
  budgets: readonly ReadyStageBudget[],
  stageId: string | undefined,
  stageKind: string | undefined
): ReadyStageBudget | undefined {
  return budgets.find((budget) => {
    const stageIdMatches = budget.stageId === undefined || budget.stageId === stageId;
    const stageKindMatches = budget.stageKind === undefined || budget.stageKind === stageKind;
    const hasBudget = budget.maxModelIterations !== undefined || budget.maxToolCalls !== undefined;
    return hasBudget && stageIdMatches && stageKindMatches;
  });
}

export function readyStageBudgetKey(control: JsonObject, budget: ReadyStageBudget): string {
  return [
    String(control.profileId ?? ""),
    String(control.graphId ?? control.workflowGraphId ?? ""),
    String(budget.stageId ?? control.budgetStageId ?? control.stageId ?? ""),
    String(budget.stageKind ?? control.budgetStageKind ?? control.stageKind ?? "")
  ].join(":");
}

export function createReadyStageBudgetUsage(): ReadyStageBudgetUsage {
  return {
    modelIterations: 0,
    toolCalls: 0,
    modelIterationReviewInjected: false,
    toolCallReviewInjected: false
  };
}

export function nextReadyStageBudgetUsage(
  usage: ReadyStageBudgetUsage,
  budget: ReadyStageBudget
): ReadyStageBudgetUsage {
  return {
    ...usage,
    ...(budget.maxModelIterations !== undefined ? { modelIterations: usage.modelIterations + 1 } : {}),
    ...(budget.maxToolCalls !== undefined ? { toolCalls: usage.toolCalls + 1 } : {})
  };
}

export function readyStageBudgetEventData(input: {
  readonly control: JsonObject;
  readonly budget: ReadyStageBudget;
  readonly kind: string;
  readonly allowed: number;
  readonly consumed: number;
  readonly remaining: number;
  readonly stopReason: string;
}): JsonObject {
  return {
    schemaVersion: "1.0.0",
    kind: input.kind,
    requested: input.allowed,
    allowed: input.allowed,
    consumed: input.consumed,
    remaining: input.remaining,
    stopReason: input.stopReason,
    policy: {
      source: "runtime.ready-stage-budget",
      ...(input.budget.policy ?? {})
    },
    workflowReadyStageControl: input.control,
    redaction: { class: "internal" },
    compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" }
  };
}

export function readyStageBudgetReviewMessage(control: JsonObject, budget: JsonObject): ModelChatMessage {
  return {
    role: "user",
    content: [
      "WORKFLOW_STAGE_BUDGET_REVIEW_REQUIRED.",
      `Active stage: ${String(control.stageId ?? "unknown")}.`,
      `Stage kind: ${String(control.stageKind ?? "unknown")}.`,
      `Budget kind: ${String(budget.kind ?? "unknown")}.`,
      `Allowed: ${String(budget.allowed ?? "unknown")}; consumed: ${String(budget.consumed ?? "unknown")}; remaining: ${String(budget.remaining ?? "unknown")}.`,
      `Required next action: ${String(control.requiredNextAction ?? "workflow-progress-capability-or-bounded-blocker")}.`,
      "Review the evidence already collected for this stage, decide whether the workflow can advance, and choose the next state-machine action.",
      "Do not continue spending the same stage budget on repeated discovery. If the stage cannot advance, report a bounded blocker."
    ].join("\n")
  };
}
