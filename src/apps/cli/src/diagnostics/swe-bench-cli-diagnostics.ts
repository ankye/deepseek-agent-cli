import type { CliOptions } from "../types.js";
import type { CliDiagnosticsResult } from "./index.js";
import { diagnosticPitIds, diagnosticsSchemaVersion } from "./release-evidence.js";
import { collectSweBenchPrediction } from "./swe-bench-prediction.js";

export async function collectSweBenchCliDiagnostics(options: CliOptions): Promise<CliDiagnosticsResult> {
  const sweBench = await collectSweBenchPrediction({
    action: typeof options.diagnosticsInput?.action === "string" ? options.diagnosticsInput.action : "predict",
    dryRun: options.diagnosticsInput?.dryRun === true,
    live: options.live === true,
    ...(typeof options.diagnosticsInput?.instanceFile === "string" ? { instanceFile: options.diagnosticsInput.instanceFile } : {}),
    ...(typeof options.diagnosticsInput?.repoDir === "string" ? { repoDir: options.diagnosticsInput.repoDir } : {}),
    ...(typeof options.diagnosticsInput?.outputPath === "string" ? { outputPath: options.diagnosticsInput.outputPath } : {}),
    ...(typeof options.diagnosticsInput?.predictionsPath === "string" ? { outputPath: options.diagnosticsInput.predictionsPath } : {}),
    ...(typeof options.diagnosticsInput?.reportDir === "string" ? { reportDir: options.diagnosticsInput.reportDir } : {}),
    ...(typeof options.diagnosticsInput?.runId === "string" ? { runId: options.diagnosticsInput.runId } : {}),
    ...(Array.isArray(options.diagnosticsInput?.instanceIds) ? { instanceIds: options.diagnosticsInput.instanceIds.filter((item): item is string => typeof item === "string") } : {}),
    ...(typeof options.diagnosticsInput?.datasetName === "string" ? { datasetName: options.diagnosticsInput.datasetName } : {}),
    ...(typeof options.diagnosticsInput?.split === "string" ? { split: options.diagnosticsInput.split } : {}),
    ...(typeof options.diagnosticsInput?.harnessPython === "string" ? { harnessPython: options.diagnosticsInput.harnessPython } : {}),
    ...(typeof options.diagnosticsInput?.cacheTracePath === "string" ? { cacheTracePath: options.diagnosticsInput.cacheTracePath } : {}),
    ...(typeof options.diagnosticsInput?.cacheHitTarget === "number" ? { cacheHitTarget: options.diagnosticsInput.cacheHitTarget } : {}),
    ...(typeof options.diagnosticsInput?.timeoutMs === "number" ? { timeoutMs: options.diagnosticsInput.timeoutMs } : {}),
    ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
    ...(options.model ? { model: options.model } : {}),
    extraArgs: Array.isArray(options.diagnosticsInput?.extraArgs)
      ? options.diagnosticsInput.extraArgs.filter((item): item is string => typeof item === "string")
      : []
  });
  return {
    schemaVersion: diagnosticsSchemaVersion,
    kind: "diagnostics.swe-bench",
    status: sweBench.status,
    command: "swe-bench",
    sweBench,
    referencePitFixtureIds: [...diagnosticPitIds],
    redaction: { class: "internal", fields: ["sweBench.repoDir", "sweBench.outputPath", "sweBench.evaluation.cache.tracePath", "sweBench.predictions.model_patch", "sweBench.commandPlan.args", "sweBench.executedCommands.args", "sweBench.diagnostics.metadata"] }
  };
}
