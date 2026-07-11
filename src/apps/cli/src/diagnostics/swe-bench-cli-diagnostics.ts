import type { JsonObject, RedactedError, RuntimeEvent, SerializableResult, TraceContext } from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import type { CliOptions, CliRunOptions } from "../types.js";
import { createCliAgentRuntime } from "../host/runtime.js";
import type { CliDiagnosticsResult } from "./index.js";
import { diagnosticPitIds, diagnosticsSchemaVersion } from "./release-evidence.js";
import { collectSweBenchPrediction } from "./swe-bench-prediction.js";
import type { SweBenchPredictionDiagnostic, SweBenchPredictionSummary } from "./swe-bench-prediction.js";

export async function collectSweBenchCliDiagnostics(options: CliOptions, runOptions: CliRunOptions = {}): Promise<CliDiagnosticsResult> {
  const action = typeof options.diagnosticsInput?.action === "string" ? options.diagnosticsInput.action : "predict";
  if (action === "run") return collectSweBenchRunDiagnostics(options, runOptions);
  const sweBench = await collectSweBenchPrediction({
    action,
    dryRun: options.diagnosticsInput?.dryRun === true,
    live: options.live === true,
    ...(typeof options.diagnosticsInput?.instanceFile === "string" ? { instanceFile: options.diagnosticsInput.instanceFile } : {}),
    ...(typeof options.diagnosticsInput?.repoDir === "string" ? { repoDir: options.diagnosticsInput.repoDir } : {}),
    ...(typeof options.diagnosticsInput?.outputPath === "string" ? { outputPath: options.diagnosticsInput.outputPath } : {}),
    ...(typeof options.diagnosticsInput?.predictionsPath === "string" ? { outputPath: options.diagnosticsInput.predictionsPath } : {}),
    ...(typeof options.diagnosticsInput?.traceOutputPath === "string" ? { traceOutputPath: options.diagnosticsInput.traceOutputPath } : {}),
    ...(options.diagnosticsInput?.appendOutput === true ? { appendOutput: true } : {}),
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
    redaction: { class: "internal", fields: ["sweBench.repoDir", "sweBench.outputPath", "sweBench.traceOutputPath", "sweBench.evaluation.cache.tracePath", "sweBench.predictions.model_patch", "sweBench.commandPlan.args", "sweBench.executedCommands.args", "sweBench.diagnostics.metadata"] }
  };
}

async function collectSweBenchRunDiagnostics(options: CliOptions, runOptions: CliRunOptions): Promise<CliDiagnosticsResult> {
  const extraArgs = Array.isArray(options.diagnosticsInput?.extraArgs)
    ? options.diagnosticsInput.extraArgs.filter((item): item is string => typeof item === "string")
    : [];
  const diagnostics: SweBenchPredictionDiagnostic[] = [];
  const taskNumber = taskNumberFromInput(options.diagnosticsInput);
  if (taskNumber === undefined) diagnostics.push(runDiagnostic("SWE_BENCH_RUN_TASK_REQUIRED", "error", "SWE-bench run requires --task with a positive task number."));
  if (extraArgs.length > 0) diagnostics.push(runDiagnostic("SWE_BENCH_RUN_INVALID_INPUT", "error", "SWE-bench run received unsupported extra arguments.", { extraArgCount: extraArgs.length }));
  const workspaceRoot = options.workspaceRoot ?? runOptions.workspaceRoot ?? process.cwd();
  const input = {
    ...(taskNumber !== undefined ? { taskNumber } : {}),
    execute: options.diagnosticsInput?.execute === true && options.diagnosticsInput?.dryRun !== true,
    dryRun: options.diagnosticsInput?.dryRun === true || options.diagnosticsInput?.execute !== true,
    ...(options.modelProvider ? { provider: options.modelProvider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(typeof options.diagnosticsInput?.runId === "string" ? { runId: options.diagnosticsInput.runId } : {}),
    ...(typeof options.diagnosticsInput?.timeoutMs === "number" ? { timeoutMs: options.diagnosticsInput.timeoutMs } : {}),
    workspaceRoot,
    cwd: workspaceRoot
  };
  let run: SerializableResult | undefined;
  if (!diagnostics.some((entry) => entry.severity === "error")) {
    const runtime = await createCliAgentRuntime({
      live: options.live === true,
      workspaceRoot,
      ...(options.toolProjection ? { toolProjection: options.toolProjection } : {}),
      ...(options.toolOptIns ? { toolOptIns: options.toolOptIns } : {}),
      ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
      ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
      ...(options.model ? { model: options.model } : {})
    }, runOptions);
    run = resultFromKernelEvents(await collectKernelEvents(runtime.kernel.execute({
      capabilityId: asId<"capability">("core.swe.bench.run"),
      input,
      caller: "cli.diagnostics.swe-bench.run",
      trace: sweBenchRunTrace(),
      metadata: {
        ...(options.modelProvider ? { activeModelProvider: options.modelProvider } : {}),
        ...(options.model ? { activeModel: options.model } : {})
      }
    })));
    if (!run.ok) {
      diagnostics.push(runDiagnostic(run.error?.code ?? "SWE_BENCH_RUN_FAILED", "error", run.error?.message ?? "SWE-bench run capability failed.", run.error?.details));
    }
  }
  const sweBench: SweBenchPredictionSummary = {
    schemaVersion: "1.0.0",
    kind: "diagnostics.swe-bench.run.summary",
    status: diagnostics.some((entry) => entry.severity === "error") ? "fail" : "pass",
    action: "run",
    dryRun: input.dryRun,
    live: options.live === true,
    invocation: input,
    predictions: [],
    commandPlan: [],
    executedCommands: [],
    ...(run ? { run: serializableResultJson(run) } : {}),
    diagnostics,
    redaction: { class: "internal", fields: ["invocation", "run.value.evidence.metadata", "run.value.evidence.replay", "diagnostics.metadata"] }
  };
  return {
    schemaVersion: diagnosticsSchemaVersion,
    kind: "diagnostics.swe-bench",
    status: sweBench.status,
    command: "swe-bench",
    sweBench,
    referencePitFixtureIds: [...diagnosticPitIds],
    redaction: { class: "internal", fields: ["sweBench.invocation", "sweBench.run.value.evidence.metadata", "sweBench.run.value.evidence.replay", "sweBench.diagnostics.metadata"] }
  };
}

function taskNumberFromInput(input: CliOptions["diagnosticsInput"]): number | undefined {
  const raw = input?.task;
  if (typeof raw !== "string") return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function runDiagnostic(code: string, severity: "info" | "warn" | "error", message: string, metadata: JsonObject = {}): SweBenchPredictionDiagnostic {
  return {
    code,
    severity,
    message,
    metadata,
    redaction: { class: "internal", fields: ["metadata"] }
  };
}

function serializableResultJson(result: SerializableResult): JsonObject {
  return {
    ok: result.ok,
    ...(result.value ? { value: result.value as JsonObject } : {}),
    ...(result.error ? { error: result.error } : {})
  };
}

async function collectKernelEvents(events: AsyncIterable<RuntimeEvent>): Promise<readonly RuntimeEvent[]> {
  const collected: RuntimeEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function resultFromKernelEvents(events: readonly RuntimeEvent[]): SerializableResult {
  const completed = findLastEvent(events, (event) => event.kind === "capability.completed");
  if (completed) {
    const output = completed.data.output;
    return { ok: true, value: isJsonObject(output) ? output : {} };
  }
  const failed = findLastEvent(events, (event) => event.kind === "capability.failed" || event.kind === "execution.rejected");
  return {
    ok: false,
    error: failed?.error ?? {
      code: "SWE_BENCH_RUN_FAILED",
      message: "SWE-bench run capability did not produce a completed kernel event.",
      retryable: false,
      redaction: { class: "internal" }
    } satisfies RedactedError
  };
}

function findLastEvent(events: readonly RuntimeEvent[], predicate: (event: RuntimeEvent) => boolean): RuntimeEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && predicate(event)) return event;
  }
  return undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sweBenchRunTrace(): TraceContext {
  return {
    traceId: asId<"trace">("trace-cli-diagnostics-swe-bench-run"),
    spanId: asId<"span">("span-cli-diagnostics-swe-bench-run"),
    correlationId: asId<"correlation">("corr-cli-diagnostics-swe-bench-run"),
    sessionId: asId<"session">("session-cli-diagnostics-swe-bench-run")
  };
}
