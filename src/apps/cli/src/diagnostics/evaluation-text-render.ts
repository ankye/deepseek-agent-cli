import type { CliEvaluationTaskRunRecord } from "@deepseek/platform-contracts";

export function evaluationRunMetricText(run: CliEvaluationTaskRunRecord): string {
  const repair = run.metrics.repairMetricsAvailability
    ? ` repair=${run.metrics.repairMetricsAvailability}:${run.metrics.repairActivationCount ?? 0}/${run.metrics.repairSuccessCount ?? 0}${run.metrics.repairStopReason ? ` stop=${run.metrics.repairStopReason}` : ""}`
    : "";
  const evidence = run.metrics.evidenceManifestStatus
    ? ` evidence=${run.metrics.evidenceManifestStatus} grounding=${run.metrics.claimGroundingRate ?? 0} unsupported=${run.metrics.unsupportedClaimCount ?? 0} assumptions=${run.metrics.assumptionCount ?? 0}`
    : "";
  return repair || evidence ? ` [${[repair.trim(), evidence.trim()].filter(Boolean).join(" ")}]` : "";
}

export function evaluationRunTraceText(run: CliEvaluationTaskRunRecord): readonly string[] {
  const events = [...run.instrumentationEvents].sort((left, right) => left.sequence - right.sequence);
  const eventKinds = events.map((event) => event.kind);
  const lastEvent = eventKinds[eventKinds.length - 1] ?? "none";
  const lines = [
    eventKinds.length > 0
      ? `trace: ${eventKinds.join(" -> ")} last=${lastEvent}`
      : "trace: none last=none"
  ];
  if (run.stagedTask) {
    const state = run.stagedTask.runState;
    lines.push(`staged: ${state.status} current=${inlineList(state.currentNodeIds)} failed=${inlineList(state.failedNodeIds)} executors=${inlineList(run.stagedTask.executorKinds, ", ")}`);
  }
  for (const check of run.checks) {
    lines.push(`check: ${check.status}${typeof check.exitCode === "number" ? ` exit=${check.exitCode}` : ""} command=${boundedInline(check.command)}`);
  }
  return lines;
}

function inlineList(values: unknown, separator = ","): string {
  if (!Array.isArray(values) || values.length === 0) return "none";
  return values.map((value) => String(value)).join(separator);
}

function boundedInline(value: string, limit = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}
