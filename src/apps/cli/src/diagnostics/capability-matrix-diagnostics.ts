import type { JsonObject } from "@deepseek/platform-contracts";
import type { CliOptions } from "../types.js";
import type { CliDiagnosticsResult } from "./index.js";
import { diagnosticPitIds, diagnosticsSchemaVersion } from "./release-evidence.js";
import { collectCapabilityMatrix } from "./capability-matrix.js";
import type { CapabilityMatrixSummary } from "./capability-matrix-types.js";

export async function capabilityMatrixDiagnostics(options: CliOptions): Promise<CliDiagnosticsResult> {
  const capabilityMatrix = await collectCapabilityMatrix({
    action: typeof options.diagnosticsInput?.action === "string" ? options.diagnosticsInput.action : "run",
    dryRun: options.diagnosticsInput?.dryRun === true,
    live: options.live === true,
    taskIds: Array.isArray(options.diagnosticsInput?.taskIds)
      ? options.diagnosticsInput.taskIds.filter((item): item is string => typeof item === "string")
      : [],
    ...(typeof options.diagnosticsInput?.reportDir === "string" ? { reportDir: options.diagnosticsInput.reportDir } : {}),
    ...(typeof options.diagnosticsInput?.cliCommand === "string" ? { cliCommand: options.diagnosticsInput.cliCommand } : {}),
    ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(typeof options.diagnosticsInput?.timeoutMs === "number" ? { timeoutMs: options.diagnosticsInput.timeoutMs } : {})
  });
  return {
    schemaVersion: diagnosticsSchemaVersion,
    kind: "diagnostics.capability-matrix",
    status: capabilityMatrix.aggregate.classificationCounts.pass === capabilityMatrix.aggregate.totalTaskCount ? "pass" : "warn",
    command: "capability-matrix",
    capabilityMatrix,
    referencePitFixtureIds: [...diagnosticPitIds],
    redaction: { class: "internal", fields: ["capabilityMatrix.tasks.prompt", "capabilityMatrix.runs.cliCommand", "capabilityMatrix.runs.evidencePaths"] }
  };
}

export function renderCapabilityMatrixText(capabilityMatrix: CapabilityMatrixSummary): readonly string[] {
  return [
    `- capability matrix: tasks=${capabilityMatrix.aggregate.totalTaskCount} dry-run=${String(capabilityMatrix.dryRun)} boundary=${capabilityMatrix.supervisorBoundary}`,
    `- report dir: ${capabilityMatrix.reportDir}`,
    `- classifications: ${Object.entries(capabilityMatrix.aggregate.classificationCounts).map(([classification, count]) => `${classification}=${count}`).join(", ")}`,
    `- decision quality: avg=${capabilityMatrix.aggregate.decisionQuality.averageScore} board-runs=${capabilityMatrix.aggregate.decisionQuality.boardSnapshotRunCount} repeated-rejection-runs=${capabilityMatrix.aggregate.decisionQuality.repeatedRejectionRunCount} gaps=${Object.entries(capabilityMatrix.aggregate.decisionQuality.gapCounts).map(([gap, count]) => `${gap}=${count}`).join(", ") || "none"}`,
    ...capabilityMatrix.tasks.map((task) => `- ${task.taskId}: ${task.title} (${task.capabilityArea}, ${task.workspaceMode}, ${task.toolProjection})`),
    ...capabilityMatrix.runs.map((run) => `- ${run.taskId} repair: owner=${run.guidance.ownerLayer} confidence=${run.guidance.confidence}; action=${run.guidance.recommendedAction}; rerun=${run.guidance.rerunCondition}`),
    `- next action: ${capabilityMatrix.nextAction}`
  ];
}

export function capabilityMatrixJsonLines(schemaVersion: string, capabilityMatrix: CapabilityMatrixSummary): readonly JsonObject[] {
  return [
    {
      schemaVersion,
      kind: "diagnostics.capability-matrix.summary",
      summary: capabilityMatrix,
      redaction: capabilityMatrix.redaction
    },
    ...capabilityMatrix.tasks.map((task) => ({
      schemaVersion,
      kind: "diagnostics.capability-matrix.task",
      task,
      redaction: task.redaction
    })),
    ...capabilityMatrix.runs.map((run) => ({
      schemaVersion,
      kind: "diagnostics.capability-matrix.run",
      run,
      redaction: run.redaction
    }))
  ];
}
