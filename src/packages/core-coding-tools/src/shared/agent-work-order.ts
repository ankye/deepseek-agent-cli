import type { AgentSpawnRequest, AgentWorkOrder, CapabilityExecutionContext, CoreToolDiagnostic } from "@deepseek/platform-contracts";
import { diag } from "./tool-kit.js";

const lazyDelegationPatterns: readonly RegExp[] = [
  /\bbased on (the )?prior findings\b/i,
  /\bcontinue from (the )?(prior|previous) findings\b/i,
  /\bfix what (we )?(discussed|talked about)\b/i,
  /\binspect (the )?(recent|latest) changes\b/i,
  /基于(之前|上面|前面).*继续/,
  /修复(刚才|之前).*问题/,
  /检查(最近|刚才).*修改/
];

export function validateAgentWorkOrder(workOrder: AgentWorkOrder): readonly CoreToolDiagnostic[] {
  const diagnostics: CoreToolDiagnostic[] = [];
  if (!workOrder.purpose.trim()) diagnostics.push(diag("AGENT_WORK_ORDER_PURPOSE_REQUIRED", "Work order purpose is required."));
  if (!workOrder.originalUserGoal.trim()) diagnostics.push(diag("AGENT_WORK_ORDER_USER_GOAL_REQUIRED", "Original user goal is required."));
  if (!workOrder.taskSummary.trim()) diagnostics.push(diag("AGENT_WORK_ORDER_TASK_SUMMARY_REQUIRED", "Task summary is required."));
  if (workOrder.targets.length === 0) diagnostics.push(diag("AGENT_WORK_ORDER_TARGETS_REQUIRED", "At least one typed target is required."));
  if (workOrder.doneCriteria.length === 0) diagnostics.push(diag("AGENT_WORK_ORDER_DONE_CRITERIA_REQUIRED", "At least one done criterion is required."));
  if (workOrder.verificationExpectations.length === 0) diagnostics.push(diag("AGENT_WORK_ORDER_VERIFICATION_REQUIRED", "Verification expectations are required."));
  const lazyText = [workOrder.purpose, workOrder.taskSummary, ...workOrder.doneCriteria].join("\n");
  if (lazyDelegationPatterns.some((pattern) => pattern.test(lazyText))) {
    diagnostics.push(diag("AGENT_WORK_ORDER_LAZY_DELEGATION", "Work order must be self-contained and cannot rely on prior findings without structured context."));
  }
  return diagnostics;
}

export function synthesizeAgentWorkOrder(parsed: AgentSpawnRequest, context: CapabilityExecutionContext): AgentWorkOrder {
  const workOrderId = parsed.workOrderId ?? `work-order:${context.envelope.invocationId}`;
  return {
    schemaVersion: "1.0.0",
    workOrderId,
    ...(parsed.parentSessionId ?? context.envelope.sessionId ? { parentSessionId: parsed.parentSessionId ?? context.envelope.sessionId } : {}),
    ...(parsed.parentAgentId ? { parentAgentId: parsed.parentAgentId } : {}),
    mode: parsed.agentMode ?? "worker",
    purpose: parsed.reason ?? "Run delegated agent task.",
    originalUserGoal: parsed.prompt,
    taskSummary: parsed.prompt,
    evidenceIds: [],
    targets: [{
      kind: "task",
      id: `task:${context.envelope.invocationId}`,
      label: "Delegated prompt"
    }],
    allowedTools: allowedToolsFor(parsed.toolProjection ?? "read-only"),
    permissionScope: {
      toolProjection: parsed.toolProjection ?? "read-only",
      ...(parsed.toolScope ? { toolScope: parsed.toolScope } : {}),
      ...(parsed.contextScope ? { contextScope: parsed.contextScope } : {})
    },
    doneCriteria: ["Return a bounded structured result with status, summary, evidence ids, and diagnostics."],
    verificationExpectations: ["Parent runtime will decide whether independent verification is required."],
    redaction: { class: "internal" },
    compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" }
  };
}

function allowedToolsFor(toolProjection: NonNullable<AgentSpawnRequest["toolProjection"]>): readonly string[] {
  if (toolProjection === "safe-all" || toolProjection === "all") return ["*"];
  if (toolProjection === "read-write") return ["file.read", "file.list", "search.text", "git.status", "git.diff", "file.edit", "file.write", "test.run"];
  return ["file.read", "file.list", "search.text", "git.status", "git.diff"];
}
