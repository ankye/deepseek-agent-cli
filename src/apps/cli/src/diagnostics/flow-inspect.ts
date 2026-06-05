import type { JsonObject, RedactedError, TaskDeliveryFlowSummary } from "@deepseek/platform-contracts";
import { createTaskDeliveryFlowSummary } from "@deepseek/runtime";

export interface DiagnosticsFlowInspectResult {
  readonly status: "pass" | "warn" | "fail";
  readonly flow: TaskDeliveryFlowSummary;
}

export function collectDiagnosticsFlowInspect(input: JsonObject | undefined): DiagnosticsFlowInspectResult {
  const prompt = typeof input?.prompt === "string" && input.prompt.trim().length > 0 ? input.prompt : "continue";
  const action = typeof input?.action === "string" ? input.action : "inspect";
  const extraArgs = Array.isArray(input?.extraArgs) ? input.extraArgs.filter((item): item is string => typeof item === "string") : [];
  const flow = createTaskDeliveryFlowSummary({ rawInput: prompt, activeTaskAvailable: true });
  const invalidDiagnostics = [
    ...(action === "inspect" ? [] : [diagnostic("DIAGNOSTICS_FLOW_INVALID_ACTION", `diagnostics flow only supports inspect, received ${action}.`, { action })]),
    ...(extraArgs.length === 0 ? [] : [diagnostic("DIAGNOSTICS_FLOW_INVALID_ARGS", `diagnostics flow inspect received ${extraArgs.length} unsupported argument(s).`, { extraArgs })])
  ];
  const flowWithDiagnostics: TaskDeliveryFlowSummary = invalidDiagnostics.length === 0
    ? flow
    : {
      ...flow,
      diagnostics: [...flow.diagnostics, ...invalidDiagnostics],
      delivery: {
        ...flow.delivery,
        status: "blocked",
        reason: "Diagnostics flow input was rejected before execution."
      }
    };
  return {
    status: invalidDiagnostics.length > 0 ? "fail" : flow.delivery.status === "delivered" ? "pass" : "warn",
    flow: flowWithDiagnostics
  };
}

export function diagnosticsFlowInspectJsonLines(schemaVersion: string, flow: TaskDeliveryFlowSummary): readonly JsonObject[] {
  return [
    {
      schemaVersion,
      kind: "diagnostics.flow.inspect.summary",
      summary: {
        briefId: flow.brief.briefId,
        goalId: flow.goal.goalId,
        planId: flow.plan.planId,
        deliveryStatus: flow.delivery.status,
        acceptanceDecision: flow.acceptance.decision
      },
      redaction: { class: "internal" }
    },
    ...flow.phases.map((phase) => ({
      schemaVersion,
      kind: "diagnostics.flow.inspect.phase",
      phase,
      redaction: phase.redaction
    })),
    {
      schemaVersion,
      kind: "diagnostics.flow.inspect.acceptance",
      acceptance: flow.acceptance,
      redaction: flow.acceptance.redaction
    },
    {
      schemaVersion,
      kind: "diagnostics.flow.inspect.delivery",
      delivery: flow.delivery,
      redaction: flow.delivery.redaction
    }
  ];
}

function diagnostic(code: string, message: string, details: JsonObject = {}): RedactedError {
  return {
    code,
    message,
    retryable: false,
    ...(Object.keys(details).length > 0 ? { details } : {}),
    redaction: { class: "internal", fields: ["details"] }
  };
}
