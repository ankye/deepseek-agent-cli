import { dirname, isAbsolute, join } from "node:path";
import type { JsonObject, PlatformRuntime, ProcessRunObserver } from "@deepseek/platform-contracts";
import { NodePlatformRuntime } from "@deepseek/platform-abstraction";
import { evaluationLiveCredentialEnv, evaluationModelSelectionArgs } from "./evaluation-provider-selection.js";
import { cacheReviewThreshold, readSweBenchCacheTrace } from "./swe-bench-cache-trace.js";
import type { SweBenchEvaluationCacheSummary } from "./swe-bench-cache-trace.js";
import { summarizeSweBenchChildTrace } from "./swe-bench-child-trace.js";
import type { SweBenchChildTraceSummary } from "./swe-bench-child-trace.js";

export interface SweBenchPredictionDiagnostic extends JsonObject {
  readonly code: string;
  readonly severity: "info" | "warn" | "error";
  readonly message: string;
  readonly metadata: JsonObject;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface SweBenchPredictionRecord extends JsonObject {
  readonly instance_id: string;
  readonly model_name_or_path: string;
  readonly model_patch: string;
}

export interface SweBenchEvaluationSummary extends JsonObject {
  readonly completed: boolean;
  readonly resolved: boolean;
  readonly runId: string;
  readonly predictionsPath: string;
  readonly reportDir: string;
  readonly reportPath: string;
  readonly modelName: string;
  readonly instanceId: string;
  readonly tests: {
    readonly failToPass: SweBenchEvaluationTestStatus;
    readonly passToPass: SweBenchEvaluationTestStatus;
  };
  readonly instances: readonly SweBenchEvaluationInstanceSummary[];
  readonly batch: {
    readonly totalInstances: number;
    readonly resolvedInstances: number;
    readonly unresolvedInstanceIds: readonly string[];
    readonly errorInstanceIds: readonly string[];
    readonly resolvedRate: number;
  };
  readonly cache?: SweBenchEvaluationCacheSummary;
}

export interface SweBenchEvaluationInstanceSummary extends JsonObject {
  readonly completed: boolean;
  readonly resolved: boolean;
  readonly reportPath: string;
  readonly modelName: string;
  readonly instanceId: string;
  readonly errorKind?: "harness-error" | "empty-patch";
  readonly failureExcerpts?: readonly SweBenchHarnessFailureExcerpt[];
  readonly tests: {
    readonly failToPass: SweBenchEvaluationTestStatus;
    readonly passToPass: SweBenchEvaluationTestStatus;
  };
}

export interface SweBenchHarnessFailureExcerpt extends JsonObject {
  readonly testId: string;
  readonly excerpt: string;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface SweBenchLocalTestSourceExcerpt extends JsonObject {
  readonly testId: string;
  readonly filePath: string;
  readonly excerpt: string;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface SweBenchEvaluationTestStatus extends JsonObject {
  readonly success: number;
  readonly failure: number;
  readonly successTests: readonly string[];
  readonly failureTests: readonly string[];
}

export interface SweBenchRepairContext extends JsonObject {
  readonly attemptNumber: number;
  readonly previousRunId: string;
  readonly failureKind?: "official-harness-unresolved" | "pre-harness-generation";
  readonly failingTests: readonly string[];
  readonly failureExcerpts?: readonly SweBenchHarnessFailureExcerpt[];
  readonly localTestSourceExcerpts?: readonly SweBenchLocalTestSourceExcerpt[];
  readonly previousPatchBytes?: number;
  readonly problemStatement?: string;
  readonly previousPatchExcerpt?: string;
  readonly restoredFromAttempt?: number;
  readonly discardedRegressedAttempt?: number;
  readonly previousStageId?: string;
  readonly previousTerminalKind?: string;
  readonly previousTerminalReason?: string;
  readonly previousSourceMutationCount?: number;
  readonly previousTestCommandCount?: number;
  readonly requiredNextAction?: string;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

interface SweBenchHarnessAttemptResult {
  readonly ok: boolean;
  readonly reportFreshnessCutoffMs?: number;
}

interface SweBenchHarnessResult {
  readonly instances: readonly SweBenchEvaluationInstanceSummary[];
  readonly requestedHarnessErrorIds: readonly string[];
  readonly requestedEmptyPatchIds: readonly string[];
  readonly dockerImageMissing: boolean;
}

export interface SweBenchPredictionSummary extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly kind: "diagnostics.swe-bench.prediction.summary" | "diagnostics.swe-bench.run.summary";
  readonly status: "pass" | "warn" | "fail";
  readonly action: string;
  readonly dryRun: boolean;
  readonly live: boolean;
  readonly instanceId?: string;
  readonly repoDir?: string;
  readonly outputPath?: string;
  readonly traceOutputPath?: string;
  readonly invocation: JsonObject;
  readonly predictions: readonly SweBenchPredictionRecord[];
  readonly commandPlan: readonly JsonObject[];
  readonly executedCommands: readonly JsonObject[];
  readonly run?: JsonObject;
  readonly childTrace?: SweBenchChildTraceSummary;
  readonly evaluation?: SweBenchEvaluationSummary;
  readonly diagnostics: readonly SweBenchPredictionDiagnostic[];
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface SweBenchCacheDiagnosticsInput {
  readonly cache: SweBenchEvaluationCacheSummary;
  readonly cacheHitTarget?: number;
}

export interface CollectSweBenchPredictionOptions {
  readonly action: string;
  readonly dryRun: boolean;
  readonly live: boolean;
  readonly instanceFile?: string;
  readonly repoDir?: string;
  readonly outputPath?: string;
  readonly reportDir?: string;
  readonly runId?: string;
  readonly instanceIds?: readonly string[];
  readonly datasetName?: string;
  readonly split?: string;
  readonly harnessPython?: string;
  readonly cacheTracePath?: string;
  readonly cacheHitTarget?: number;
  readonly traceOutputPath?: string;
  readonly appendOutput?: boolean;
  readonly modelProvider?: "deepseek" | "glm";
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly repairContext?: SweBenchRepairContext;
  readonly supervisorWorkflowStatePath?: string;
  readonly extraArgs: readonly string[];
  readonly platform?: PlatformRuntime;
}

interface SweBenchInstance {
  readonly instanceId: string;
  readonly problemStatement: string;
  readonly repo?: string;
  readonly baseCommit?: string;
}

export async function collectSweBenchPrediction(options: CollectSweBenchPredictionOptions): Promise<SweBenchPredictionSummary> {
  const platform = options.platform ?? new NodePlatformRuntime();
  const diagnostics: SweBenchPredictionDiagnostic[] = [];
  if (options.action !== "predict" && options.action !== "evaluate") {
    diagnostics.push(diagnostic("SWE_BENCH_PREDICTION_INVALID_ACTION", "error", `Unsupported SWE-bench action: ${options.action || "unknown"}.`));
  }
  if (options.action === "predict" && (!nonEmpty(options.instanceFile) || !nonEmpty(options.repoDir) || !nonEmpty(options.outputPath) || options.extraArgs.length > 0)) {
    diagnostics.push(diagnostic("SWE_BENCH_PREDICTION_INVALID_INPUT", "error", "SWE-bench prediction requires --instance-file, --repo-dir, --output-path, and no unsupported extra arguments.", { extraArgCount: options.extraArgs.length }));
  }
  if (options.action === "evaluate" && (!nonEmpty(options.outputPath) || !nonEmpty(options.reportDir) || !nonEmpty(options.runId) || options.extraArgs.length > 0)) {
    diagnostics.push(diagnostic("SWE_BENCH_EVALUATION_INVALID_INPUT", "error", "SWE-bench evaluation requires --predictions-path, --report-dir, --run-id, and no unsupported extra arguments.", { extraArgCount: options.extraArgs.length }));
  }
  if (options.action === "evaluate" && options.cacheHitTarget !== undefined && (!Number.isFinite(options.cacheHitTarget) || options.cacheHitTarget <= 0 || options.cacheHitTarget > 1)) {
    diagnostics.push(diagnostic("SWE_BENCH_CACHE_TARGET_INVALID", "error", "SWE-bench cache hit target must be a number greater than 0 and less than or equal to 1."));
  }
  if (options.action === "evaluate" && options.cacheHitTarget !== undefined && !nonEmpty(options.cacheTracePath)) {
    diagnostics.push(diagnostic("SWE_BENCH_CACHE_TRACE_REQUIRED", "error", "SWE-bench cache hit target requires --cache-trace-path."));
  }
  if (diagnostics.some((entry) => entry.severity === "error")) return summary(options, diagnostics, [], [], [], undefined, undefined);

  if (options.action === "evaluate") {
    return collectSweBenchEvaluation(platform, options, diagnostics);
  }

  const instance = await readInstance(platform, options.instanceFile as string).catch((error: unknown) => {
    diagnostics.push(diagnostic("SWE_BENCH_INSTANCE_READ_FAILED", "error", error instanceof Error ? error.message : String(error)));
    return undefined;
  });
  if (!instance) return summary(options, diagnostics, [], [], [], undefined, undefined);

  const modelName = options.model ?? "default";
  const repoDir = options.repoDir as string;
  const commandPlan = [childCommandPlan(instance, options, modelName), gitDiffCommandPlan(repoDir)];
  const executedCommands: JsonObject[] = [];
  let childTrace: SweBenchChildTraceSummary | undefined;

  if (options.live && !options.dryRun) {
    const command = await childCommand(platform, instance, options, modelName);
    executedCommands.push(commandRecord("agent", command.command, command.args, repoDir));
    const traceWriter = nonEmpty(options.traceOutputPath)
      ? await createChildTraceStreamWriter(platform, options.traceOutputPath as string)
      : undefined;
    const result = await platform.runProcess(command.command, command.args, {
      cwd: repoDir,
      timeoutMs: options.timeoutMs ?? 15 * 60 * 1000,
      ...(command.env ? { env: command.env } : {})
    }, traceWriter?.observer);
    await traceWriter?.flush();
    if (result.exitCode !== 0) {
      diagnostics.push(diagnostic("SWE_BENCH_AGENT_RUN_FAILED", "warn", `SWE-bench agent run exited with code ${result.exitCode}.`, {
        exitCode: result.exitCode,
        stdoutBytes: result.stdout.length,
        stderrBytes: result.stderr.length
      }));
    }
    const childStdout = traceWriter && traceWriter.stdout.length > 0 ? traceWriter.stdout : result.stdout;
    if (nonEmpty(options.traceOutputPath) && !traceWriter?.hasWritten) {
      await writeChildTrace(platform, options.traceOutputPath as string, result.stdout);
    }
    childTrace = summarizeSweBenchChildTrace(childStdout, options.traceOutputPath);
    if (!childTrace.terminalKind) {
      diagnostics.push(diagnostic("SWE_BENCH_CHILD_TRACE_TERMINAL_MISSING", "warn", "SWE-bench child CLI trace did not include a terminal agent loop event.", {
        terminalKind: "",
        terminalStatus: "",
        terminalReason: "",
        iterationCount: childTrace.iterationCount,
        modelRequestCount: childTrace.modelRequestCount,
        toolIntentCount: childTrace.toolIntentCount,
        usageEventCount: childTrace.usageEventCount,
        tracePath: options.traceOutputPath ?? ""
      }));
    }
    if (childTrace.terminalKind === "agent.loop.failed" || childTrace.terminalKind === "agent.loop.cancelled") {
      diagnostics.push(diagnostic("SWE_BENCH_CHILD_TRACE_TERMINAL_FAILED", "warn", "SWE-bench child CLI trace did not end with a clean completed event.", {
        terminalKind: childTrace.terminalKind,
        terminalStatus: childTrace.terminalStatus,
        terminalReason: childTrace.terminalReason,
        iterationCount: childTrace.iterationCount,
        modelRequestCount: childTrace.modelRequestCount,
        toolIntentCount: childTrace.toolIntentCount
      }));
    }
    if (childTrace.shellCommandCount > 0 && childTrace.testCommandCount === 0) {
      diagnostics.push(diagnostic("SWE_BENCH_CHILD_TRACE_VERIFICATION_MISSING", "warn", "SWE-bench child CLI trace did not include a model-authored test command before prediction collation.", {
        shellCommandCount: childTrace.shellCommandCount,
        testCommandCount: childTrace.testCommandCount,
        iterationCount: childTrace.iterationCount,
        modelRequestCount: childTrace.modelRequestCount,
        toolIntentCount: childTrace.toolIntentCount
      }));
    }
    if (childTrace.diagnosticCodes.includes("SWE_BENCH_TEST_ENV_DEPENDENCY_INCOMPATIBLE")) {
      diagnostics.push(diagnostic("SWE_BENCH_TEST_ENV_DEPENDENCY_INCOMPATIBLE", "warn", "SWE-bench child test command failed during pytest setup because the checkout dependency set is incompatible.", {
        terminalKind: childTrace.terminalKind,
        terminalReason: childTrace.terminalReason,
        testCommandCount: childTrace.testCommandCount,
        ...pythonTestFailureMetadata(childTrace)
      }));
    }
    if (childTrace.diagnosticCodes.includes("SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING")) {
      diagnostics.push(diagnostic("SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING", "warn", "SWE-bench child test command failed because a checkout-local Python test dependency is missing.", {
        terminalKind: childTrace.terminalKind,
        terminalReason: childTrace.terminalReason,
        testCommandCount: childTrace.testCommandCount,
        ...pythonTestFailureMetadata(childTrace)
      }));
    }
    if (childTrace.diagnosticCodes.includes("SWE_BENCH_TEST_ENTRYPOINT_MISSING")) {
      diagnostics.push(diagnostic("SWE_BENCH_TEST_ENTRYPOINT_MISSING", "warn", "SWE-bench child invoked a Python test runner path that does not exist in the checkout.", {
        terminalKind: childTrace.terminalKind,
        terminalReason: childTrace.terminalReason,
        testCommandCount: childTrace.testCommandCount,
        ...pythonTestFailureMetadata(childTrace)
      }));
    }
    if (childTrace.diagnosticCodes.includes("SWE_BENCH_TEST_ARGUMENT_UNSUPPORTED")) {
      diagnostics.push(diagnostic("SWE_BENCH_TEST_ARGUMENT_UNSUPPORTED", "warn", "SWE-bench child invoked a Python test runner with unsupported arguments.", {
        terminalKind: childTrace.terminalKind,
        terminalReason: childTrace.terminalReason,
        testCommandCount: childTrace.testCommandCount,
        ...pythonTestFailureMetadata(childTrace)
      }));
    }
    if (childTrace.diagnosticCodes.includes("SWE_BENCH_TEST_COMMAND_ENV_MISSCOPED")) {
      diagnostics.push(diagnostic("SWE_BENCH_TEST_COMMAND_ENV_MISSCOPED", "warn", "SWE-bench child invoked a Python test command from the wrong cwd, settings, or module scope.", {
        terminalKind: childTrace.terminalKind,
        terminalReason: childTrace.terminalReason,
        testCommandCount: childTrace.testCommandCount,
        ...pythonTestFailureMetadata(childTrace)
      }));
    }
    if (childTrace.diagnosticCodes.includes("SWE_BENCH_CHILD_TRACE_TEST_UNSUCCESSFUL")) {
      diagnostics.push(diagnostic("SWE_BENCH_CHILD_TRACE_TEST_UNSUCCESSFUL", "warn", "SWE-bench child trace included local test attempts but no successful test command.", {
        terminalKind: childTrace.terminalKind,
        terminalReason: childTrace.terminalReason,
        shellCommandCount: childTrace.shellCommandCount,
        testCommandCount: childTrace.testCommandCount,
        successfulTestCommandCount: childTrace.successfulTestCommandCount,
        sourceMutationCount: childTrace.sourceMutationCount
      }));
    }
    if (childTrace.diagnosticCodes.includes("SWE_BENCH_INVALID_TEST_TOOL_COMMAND_GATE")) {
      diagnostics.push(diagnostic("SWE_BENCH_INVALID_TEST_TOOL_COMMAND_GATE", "warn", "SWE-bench child used a test tool for a non-test command, so the command was not counted as verification evidence.", {
        terminalKind: childTrace.terminalKind,
        terminalReason: childTrace.terminalReason,
        shellCommandCount: childTrace.shellCommandCount,
        testCommandCount: childTrace.testCommandCount,
        invalidTestToolCommandCount: childTrace.invalidTestToolCommandCount,
        sourceMutationCount: childTrace.sourceMutationCount
      }));
    }
    diagnostics.push(...childTraceGateDiagnostics(childTrace));
  }

  const patch = options.dryRun ? "" : await collectGitDiff(platform, repoDir, diagnostics, executedCommands);
  if (!options.dryRun) diagnostics.push(...patchQualityDiagnostics(patch));
  const prediction = predictionRecord(instance.instanceId, modelName, patch);
  const patchQualityFailed = diagnostics.some((entry) => entry.code === "SWE_BENCH_PATCH_QUALITY_FAILED" && entry.severity === "error");
  if (!options.dryRun && !patchQualityFailed) {
    await writePredictionRecord(platform, options.outputPath as string, prediction, options.appendOutput === true);
  }
  if (!options.dryRun && patch.trim().length === 0) {
    diagnostics.push(diagnostic("SWE_BENCH_EMPTY_PATCH", "warn", "SWE-bench prediction patch is empty after the agent run."));
  }

  return summary(options, diagnostics, [prediction], commandPlan, executedCommands, instance, undefined, childTrace);
}

function patchQualityDiagnostics(patch: string): readonly SweBenchPredictionDiagnostic[] {
  const debugLines = addedPatchLines(patch)
    .filter((line) => looksLikeDebugResidue(line))
    .slice(0, 20);
  if (debugLines.length === 0) return [];
  return [diagnostic("SWE_BENCH_PATCH_QUALITY_FAILED", "error", "SWE-bench candidate patch contains obvious debug residue and is not harness-ready.", {
    debugLineCount: debugLines.length,
    debugLines
  })];
}

function addedPatchLines(patch: string): readonly string[] {
  return patch.split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++") && line.length > 1)
    .map((line) => line.slice(1));
}

function looksLikeDebugResidue(line: string): boolean {
  const trimmed = line.trim();
  return /^print\s*\(.*\bDEBUG\b/i.test(trimmed) ||
    /^console\.log\s*\(.*\bDEBUG\b/i.test(trimmed) ||
    /^debugger\s*;?$/.test(trimmed) ||
    /\b(?:logger|logging)\.(?:debug|info|warning|warn|error)\s*\(.*\bDEBUG\b/i.test(trimmed);
}

function childTraceGateDiagnostics(childTrace: SweBenchChildTraceSummary): readonly SweBenchPredictionDiagnostic[] {
  return childTrace.blockerFindings
    .filter((finding) => finding.blockerId === "agentic.blocker.106.post-edit-verification-missing")
    .map((finding) => diagnostic("SWE_BENCH_POST_EDIT_VERIFICATION_GATE", "warn", "SWE-bench child edited source after heavy inspection but did not run a model-authored standard test command before more exploration.", {
      blockerId: finding.blockerId,
      phase: finding.phase,
      evidence: finding.evidence,
      terminalKind: childTrace.terminalKind,
      terminalReason: childTrace.terminalReason,
      sourceInspectionToolCount: childTrace.sourceInspectionToolCount,
      sourceMutationCount: childTrace.sourceMutationCount,
      testCommandCount: childTrace.testCommandCount
    }));
}

export function sweBenchPredictionJsonLines(summary: SweBenchPredictionSummary): readonly JsonObject[] {
  return [
    {
      schemaVersion: summary.schemaVersion,
      kind: "diagnostics.swe-bench.summary",
      summary,
      redaction: summary.redaction
    },
    ...summary.predictions.map((prediction) => ({
      schemaVersion: summary.schemaVersion,
      kind: "diagnostics.swe-bench.prediction",
      prediction,
      redaction: { class: "internal", fields: ["prediction.model_patch"] }
    })),
    ...(summary.evaluation ? [
      {
        schemaVersion: summary.schemaVersion,
        kind: "diagnostics.swe-bench.evaluation",
        evaluation: summary.evaluation,
        redaction: { class: "internal", fields: ["evaluation.predictionsPath", "evaluation.reportDir", "evaluation.reportPath", "evaluation.cache.tracePath"] }
      },
      ...summary.evaluation.instances.map((instance) => ({
        schemaVersion: summary.schemaVersion,
        kind: "diagnostics.swe-bench.evaluation.instance",
        instance,
        redaction: { class: "internal", fields: ["instance.reportPath"] }
      }))
    ] : []),
    ...summary.diagnostics.map((item) => ({
      schemaVersion: summary.schemaVersion,
      kind: "diagnostics.swe-bench.diagnostic",
      diagnostic: item,
      redaction: item.redaction
    }))
  ];
}

export function renderSweBenchPredictionText(summary: SweBenchPredictionSummary): readonly string[] {
  const lines = [
    `- swe-bench action: ${summary.action}`,
    `- dry-run: ${String(summary.dryRun)}`,
    `- live: ${String(summary.live)}`,
    `- predictions: ${summary.predictions.length}`
  ];
  if (summary.outputPath) lines.push(`- output: ${summary.outputPath}`);
  if (summary.childTrace) {
    lines.push(`- child trace: terminal=${summary.childTrace.terminalKind ?? "unknown"} reason=${summary.childTrace.terminalReason ?? "none"} iterations=${summary.childTrace.iterationCount} modelRequests=${summary.childTrace.modelRequestCount} toolIntents=${summary.childTrace.toolIntentCount}`);
  }
  for (const prediction of summary.predictions) {
    lines.push(`- ${prediction.instance_id}: patchBytes=${prediction.model_patch.length} model=${prediction.model_name_or_path}`);
  }
  if (summary.evaluation) {
    lines.push(`- evaluation: completed=${String(summary.evaluation.completed)} resolved=${String(summary.evaluation.resolved)} report=${summary.evaluation.reportPath}`);
    lines.push(`- evaluation batch: resolved=${summary.evaluation.batch.resolvedInstances}/${summary.evaluation.batch.totalInstances} rate=${formatRate(summary.evaluation.batch.resolvedRate)} unresolved=${summary.evaluation.batch.unresolvedInstanceIds.join(", ") || "none"}`);
    lines.push(`- FAIL_TO_PASS: success=${summary.evaluation.tests.failToPass.success} failure=${summary.evaluation.tests.failToPass.failure}`);
    lines.push(`- PASS_TO_PASS: success=${summary.evaluation.tests.passToPass.success} failure=${summary.evaluation.tests.passToPass.failure}`);
    if (summary.evaluation.cache) {
      const cache = summary.evaluation.cache;
      lines.push(`- cache SLO: hitRate=${formatRate(cache.hitRate)}${typeof cache.targetHitRate === "number" ? ` target=${formatRate(cache.targetHitRate)} gate=${cache.passed === true ? "pass" : "fail"}` : ""} requests=${cache.requestCount} lowHit=${cache.lowHitRequestCount} hit=${cache.hitTokens} miss=${cache.missTokens}`);
      lines.push(`- context cache: hitRate=${formatContextProjectionHitRate(cache.contextProjection)} requests=${cache.contextProjection.requestCount} hits=${cache.contextProjection.hitCount} misses=${cache.contextProjection.missCount}`);
    }
  }
  for (const diagnostic of summary.diagnostics) {
    lines.push(`- ${diagnostic.code}: ${diagnostic.severity} - ${diagnostic.message}`);
  }
  return lines;
}

function summary(
  options: CollectSweBenchPredictionOptions,
  diagnostics: readonly SweBenchPredictionDiagnostic[],
  predictions: readonly SweBenchPredictionRecord[],
  commandPlan: readonly JsonObject[],
  executedCommands: readonly JsonObject[],
  instance: SweBenchInstance | undefined,
  evaluation: SweBenchEvaluationSummary | undefined,
  childTrace: SweBenchChildTraceSummary | undefined = undefined
): SweBenchPredictionSummary {
  const hasError = diagnostics.some((entry) => entry.severity === "error");
  const hasWarn = diagnostics.some((entry) => entry.severity === "warn");
  return {
    schemaVersion: "1.0.0",
    kind: "diagnostics.swe-bench.prediction.summary",
    status: hasError ? "fail" : hasWarn ? "warn" : "pass",
    action: options.action,
    dryRun: options.dryRun,
    live: options.live,
    ...(instance ? { instanceId: instance.instanceId } : {}),
    ...(options.repoDir ? { repoDir: options.repoDir } : {}),
    ...(options.outputPath ? { outputPath: options.outputPath } : {}),
    ...(options.traceOutputPath ? { traceOutputPath: options.traceOutputPath } : {}),
    invocation: {
      provider: options.modelProvider ?? "deepseek",
      providerSource: options.modelProvider ? "explicit" : "default",
      model: options.model ?? "default",
      live: options.live,
      dryRun: options.dryRun,
      action: options.action,
      ...(options.appendOutput !== undefined ? { appendOutput: options.appendOutput } : {})
    },
    predictions,
    commandPlan,
    executedCommands,
    ...(childTrace ? { childTrace } : {}),
    ...(evaluation ? { evaluation } : {}),
    diagnostics,
    redaction: { class: "internal", fields: ["repoDir", "outputPath", "traceOutputPath", "childTrace.tracePath", "evaluation.predictionsPath", "evaluation.reportDir", "evaluation.reportPath", "evaluation.cache.tracePath", "predictions.model_patch", "diagnostics.metadata", "commandPlan.args", "executedCommands.args"] }
  };
}

async function collectSweBenchEvaluation(
  platform: PlatformRuntime,
  options: CollectSweBenchPredictionOptions,
  diagnostics: SweBenchPredictionDiagnostic[]
): Promise<SweBenchPredictionSummary> {
  const predictionsPath = absolutePath(platform, options.outputPath as string);
  const reportDir = absolutePath(platform, options.reportDir as string);
  const runId = options.runId as string;
  const predictions = await readPredictions(platform, predictionsPath).catch((error: unknown) => {
    diagnostics.push(diagnostic("SWE_BENCH_PREDICTION_READ_FAILED", "error", error instanceof Error ? error.message : String(error)));
    return undefined;
  });
  if (!predictions || predictions.length === 0) return summary(options, diagnostics, [], [], [], undefined, undefined);
  const predictionsByInstanceId = new Map(predictions.map((prediction) => [prediction.instanceId, prediction]));
  const instanceIds = options.instanceIds && options.instanceIds.length > 0
    ? options.instanceIds
    : predictions.map((prediction) => prediction.instanceId);
  const missingPredictionIds = instanceIds.filter((instanceId) => !predictionsByInstanceId.has(instanceId));
  if (instanceIds.length === 0 || missingPredictionIds.length > 0) {
    diagnostics.push(diagnostic("SWE_BENCH_PREDICTION_INSTANCE_MISSING", "error", "SWE-bench prediction JSONL must include every requested instance id.", { missingPredictionIds }));
    return summary(options, diagnostics, [], [], [], undefined, undefined);
  }

  const command = options.harnessPython ? absolutePath(platform, options.harnessPython) : defaultHarnessPython(platform);
  const args = sweBenchHarnessArgs(options, predictionsPath, reportDir, runId, instanceIds);
  const executedCommands: JsonObject[] = [commandRecord("swe-bench.harness", command, args, reportDir)];
  const commandPlan: JsonObject[] = [harnessCommandPlan(options, command, args, reportDir)];

  const firstAttempt = await runHarnessAttempt(platform, options, command, args, reportDir, runId, diagnostics, executedCommands);
  if (!firstAttempt.ok) return summary(options, diagnostics, [], commandPlan, executedCommands, undefined, undefined);
  let harness = await collectHarnessResult({
    platform,
    reportDir,
    runId,
    predictions,
    predictionsByInstanceId,
    instanceIds,
    diagnostics,
    diagnosticStartIndex: diagnostics.length,
    ...(firstAttempt.reportFreshnessCutoffMs !== undefined ? { reportFreshnessCutoffMs: firstAttempt.reportFreshnessCutoffMs } : {})
  });
  let effectiveRunId = runId;

  if (!options.dryRun && harness.dockerImageMissing) {
    const retryRunId = `${runId}-local-build`;
    const retryArgs = sweBenchHarnessArgs(options, predictionsPath, reportDir, retryRunId, instanceIds, {
      namespace: "none",
      forceRebuild: true
    });
    commandPlan.push(harnessCommandPlan(options, command, retryArgs, reportDir, {
      id: "swe-bench.harness.local-build",
      action: "run-official-harness-local-build"
    }));
    executedCommands.push(commandRecord("swe-bench.harness.local-build", command, retryArgs, reportDir));
    diagnostics.push(diagnostic("SWE_BENCH_HARNESS_LOCAL_BUILD_RETRY", "info", "SWE-bench harness remote image was missing; retrying with local image build.", {
      previousRunId: runId,
      retryRunId,
      errorInstanceIds: harness.requestedHarnessErrorIds
    }));
    const retryAttempt = await runHarnessAttempt(platform, options, command, retryArgs, reportDir, retryRunId, diagnostics, executedCommands);
    if (retryAttempt.ok) {
      harness = await collectHarnessResult({
        platform,
        reportDir,
        runId: retryRunId,
        predictions,
        predictionsByInstanceId,
        instanceIds,
        diagnostics,
        diagnosticStartIndex: diagnostics.length,
        ...(retryAttempt.reportFreshnessCutoffMs !== undefined ? { reportFreshnessCutoffMs: retryAttempt.reportFreshnessCutoffMs } : {})
      });
      if (harness.instances.length > 0 && !harness.dockerImageMissing) {
        downgradeRecoverableHarnessDiagnostics(diagnostics);
        effectiveRunId = retryRunId;
      }
    } else {
      return summary(options, diagnostics, [], commandPlan, executedCommands, undefined, undefined);
    }
  }

  const instances = harness.instances;
  if (instances.length === 0) return summary(options, diagnostics, [], commandPlan, executedCommands, undefined, undefined);

  const cache = options.cacheTracePath
    ? await readSweBenchCacheTrace(platform, absolutePath(platform, options.cacheTracePath), options.cacheHitTarget).catch((error: unknown) => {
        diagnostics.push(diagnostic("SWE_BENCH_CACHE_TRACE_READ_FAILED", "error", error instanceof Error ? error.message : String(error), { cacheTracePath: options.cacheTracePath }));
        return undefined;
      })
    : undefined;
  if (cache) diagnostics.push(...sweBenchCacheDiagnostics({
    cache,
    ...(options.cacheHitTarget !== undefined ? { cacheHitTarget: options.cacheHitTarget } : {})
  }));
  const evaluation = evaluationSummary(predictionsPath, reportDir, effectiveRunId, instances, cache);
  if (!evaluation.resolved) {
    diagnostics.push(diagnostic("SWE_BENCH_EVALUATION_UNRESOLVED", "warn", "SWE-bench official harness reported unresolved instances.", {
      totalInstances: evaluation.batch.totalInstances,
      resolvedInstances: evaluation.batch.resolvedInstances,
      unresolvedInstanceIds: evaluation.batch.unresolvedInstanceIds,
      resolvedRate: evaluation.batch.resolvedRate
    }));
  }
  return summary(options, diagnostics, [], commandPlan, executedCommands, undefined, evaluation);
}

export function sweBenchCacheDiagnostics(input: SweBenchCacheDiagnosticsInput): readonly SweBenchPredictionDiagnostic[] {
  const diagnostics: SweBenchPredictionDiagnostic[] = [];
  const cache = input.cache;
  const providerCacheTelemetryAbsent = cache.provider.requestWithPipelineCount === 0 && cache.promptAssembly.providerPrefixEventCount === 0;
  if (input.cacheHitTarget !== undefined) {
    if (cache.requestCount === 0) {
      diagnostics.push(diagnostic("SWE_BENCH_CACHE_TRACE_UNAVAILABLE", "error", "SWE-bench cache trace did not include measurable provider cache usage."));
    } else if (cache.passed === false) {
      diagnostics.push(diagnostic("SWE_BENCH_CACHE_HIT_TARGET_MISSED", "error", "SWE-bench cache hit rate is below the requested engineering target.", {
        targetHitRate: cache.targetHitRate,
        hitRate: cache.hitRate,
        hitTokens: cache.hitTokens,
        missTokens: cache.missTokens,
        requestCount: cache.requestCount,
        lowHitRequestCount: cache.lowHitRequestCount
      }));
      diagnostics.push(diagnostic("SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET", "error", "SWE-bench provider token cache hit rate is below the requested engineering target.", {
        targetHitRate: cache.targetHitRate,
        hitRate: cache.provider.hitRate,
        hitTokens: cache.provider.hitTokens,
        missTokens: cache.provider.missTokens,
        requestCount: cache.provider.requestCount,
        lowHitRequestCount: cache.provider.lowHitRequestCount,
        lowHitColdStartCount: cache.provider.lowHitColdStartCount,
        lowHitHistoryTailCount: cache.provider.lowHitHistoryTailCount,
        lowHitPromptAssemblyDriftCount: cache.provider.lowHitPromptAssemblyDriftCount,
        maxSelectedHistoryMessageCount: cache.provider.maxSelectedHistoryMessageCount,
        maxAssistantToolCallCount: cache.provider.maxAssistantToolCallCount,
        maxToolResultCount: cache.provider.maxToolResultCount,
        lowHitHistoryTailMaxSelectedHistoryMessageCount: cache.provider.lowHitHistoryTailMaxSelectedHistoryMessageCount,
        lowHitHistoryTailMaxAssistantToolCallCount: cache.provider.lowHitHistoryTailMaxAssistantToolCallCount,
        lowHitHistoryTailMaxToolResultCount: cache.provider.lowHitHistoryTailMaxToolResultCount,
        lowHitPipelineMissingCount: cache.provider.lowHitPipelineMissingCount,
        lowHitPrefixHintMissingCount: cache.provider.lowHitPrefixHintMissingCount,
        lowHitPrefixHintUnsupportedCount: cache.provider.lowHitPrefixHintUnsupportedCount,
        lowHitRepeatedZeroHitWithPipelineCount: cache.provider.lowHitRepeatedZeroHitWithPipelineCount,
        lowHitProviderPrefixTooSmallCount: cache.provider.lowHitProviderPrefixTooSmallCount,
        lowHitProviderPrefixCoverageLowCount: cache.provider.lowHitProviderPrefixCoverageLowCount,
        minProviderPrefixCoverageRatio: cache.provider.minProviderPrefixCoverageRatio,
        maxProviderPrefixCoverageRatio: cache.provider.maxProviderPrefixCoverageRatio,
        lowHitDynamicTailMissCount: cache.provider.lowHitDynamicTailMissCount,
        lowHitDynamicTailMissTokens: cache.provider.lowHitDynamicTailMissTokens,
        effectiveStableCacheHitTokens: cache.provider.effectiveStableCacheHitTokens,
        maxPositiveHitTokens: cache.provider.maxPositiveHitTokens,
        minPositiveHitTokens: cache.provider.minPositiveHitTokens,
        lowHitToolSchemaCacheGapCount: cache.provider.lowHitToolSchemaCacheGapCount,
        lowHitMultiMessageCacheControlCount: cache.provider.lowHitMultiMessageCacheControlCount,
        requestWithBreakpointShapeCount: cache.provider.requestWithBreakpointShapeCount,
        lowHitBreakpointShapeTelemetryMissingCount: cache.provider.lowHitBreakpointShapeTelemetryMissingCount,
        maxSystemCacheControlCount: cache.provider.maxSystemCacheControlCount,
        maxMessageCacheControlCount: cache.provider.maxMessageCacheControlCount,
        maxToolCacheControlCount: cache.provider.maxToolCacheControlCount,
        maxTotalCacheControlCount: cache.provider.maxTotalCacheControlCount,
        providerPrefixEventCount: cache.promptAssembly.providerPrefixEventCount,
        minProviderPrefixMessageCount: cache.promptAssembly.minProviderPrefixMessageCount,
        maxProviderPrefixMessageCount: cache.promptAssembly.maxProviderPrefixMessageCount,
        minProviderPrefixTokenEstimate: cache.promptAssembly.minProviderPrefixTokenEstimate,
        maxProviderPrefixTokenEstimate: cache.promptAssembly.maxProviderPrefixTokenEstimate,
        uniqueProviderPrefixFingerprintCount: cache.promptAssembly.uniqueProviderPrefixFingerprintCount,
        requestWithPipelineCount: cache.provider.requestWithPipelineCount
      }));
    }
  }
  if (
    cache.provider.lowHitPipelineMissingCount > 0
    && cacheablePromptPrefixIsStable(cache)
  ) {
    diagnostics.push(diagnostic(
      providerCacheTelemetryAbsent ? "SWE_BENCH_PROVIDER_CACHE_PIPELINE_TELEMETRY_ABSENT" : "SWE_BENCH_PROVIDER_CACHE_PIPELINE_MISSING",
      "warn",
      providerCacheTelemetryAbsent
        ? "SWE-bench provider cache trace predates context pipeline telemetry, so cache evidence must be refreshed before diagnosing current provider pipeline failures."
        : "SWE-bench provider cache misses occurred before context pipeline metadata reached the provider request.",
      {
      lowHitPipelineMissingCount: cache.provider.lowHitPipelineMissingCount,
      lowHitRequestCount: cache.provider.lowHitRequestCount,
      requestCount: cache.provider.requestCount,
      requestWithPipelineCount: cache.provider.requestWithPipelineCount,
      providerPrefixEventCount: cache.promptAssembly.providerPrefixEventCount,
      promptAssemblyEventCount: cache.promptAssembly.eventCount
      }
    ));
  }
  if (
    cache.provider.lowHitPrefixHintUnsupportedCount > 0
    && cacheablePromptPrefixIsStable(cache)
  ) {
    diagnostics.push(diagnostic("SWE_BENCH_PROVIDER_CACHE_PREFIX_HINT_UNSUPPORTED", "warn", "SWE-bench provider cache misses occurred while the selected provider did not support explicit prefix cache hints.", {
      lowHitPrefixHintUnsupportedCount: cache.provider.lowHitPrefixHintUnsupportedCount,
      lowHitRequestCount: cache.provider.lowHitRequestCount,
      requestCount: cache.provider.requestCount,
      requestWithPipelineCount: cache.provider.requestWithPipelineCount,
      promptAssemblyEventCount: cache.promptAssembly.eventCount
    }));
  }
  if (
    cache.provider.lowHitPrefixHintMissingCount > 0
    && cacheablePromptPrefixIsStable(cache)
  ) {
    diagnostics.push(diagnostic("SWE_BENCH_PROVIDER_CACHE_PREFIX_HINT_MISSING", "warn", "SWE-bench provider cache misses occurred while stable prompt assembly lacked context pipeline prefix hints.", {
      lowHitPrefixHintMissingCount: cache.provider.lowHitPrefixHintMissingCount,
      lowHitRequestCount: cache.provider.lowHitRequestCount,
      requestCount: cache.provider.requestCount,
      requestWithPipelineCount: cache.provider.requestWithPipelineCount,
      promptAssemblyEventCount: cache.promptAssembly.eventCount
    }));
  }
  if (
    cache.provider.lowHitHistoryTailCount > 0
    && cacheablePromptPrefixIsStable(cache)
    && !providerCacheTelemetryAbsent
  ) {
    diagnostics.push(diagnostic("SWE_BENCH_PROVIDER_CACHE_HISTORY_TAIL_MISS", "warn", "SWE-bench provider cache misses are concentrated after stable prompt assembly while conversation history/tool-result tail grows.", {
      lowHitHistoryTailCount: cache.provider.lowHitHistoryTailCount,
      lowHitRequestCount: cache.provider.lowHitRequestCount,
      requestCount: cache.provider.requestCount,
      maxSelectedHistoryMessageCount: cache.provider.maxSelectedHistoryMessageCount,
      maxAssistantToolCallCount: cache.provider.maxAssistantToolCallCount,
      maxToolResultCount: cache.provider.maxToolResultCount,
      lowHitHistoryTailMaxSelectedHistoryMessageCount: cache.provider.lowHitHistoryTailMaxSelectedHistoryMessageCount,
      lowHitHistoryTailMaxAssistantToolCallCount: cache.provider.lowHitHistoryTailMaxAssistantToolCallCount,
      lowHitHistoryTailMaxToolResultCount: cache.provider.lowHitHistoryTailMaxToolResultCount,
      promptAssemblyEventCount: cache.promptAssembly.eventCount
    }));
  }
  if (
    cache.provider.lowHitRepeatedZeroHitWithPipelineCount > 0
    && cacheablePromptPrefixIsStable(cache)
    && cache.provider.requestWithBreakpointShapeCount > 0
    && cache.provider.lowHitBreakpointShapeTelemetryMissingCount === 0
  ) {
    diagnostics.push(diagnostic("SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_MISS", "warn", "SWE-bench provider cache recorded repeated zero-hit requests for the same context pipeline despite explicit prefix cache hints.", {
      lowHitRepeatedZeroHitWithPipelineCount: cache.provider.lowHitRepeatedZeroHitWithPipelineCount,
      lowHitRequestCount: cache.provider.lowHitRequestCount,
      requestCount: cache.provider.requestCount,
      requestWithPipelineCount: cache.provider.requestWithPipelineCount,
      requestWithBreakpointShapeCount: cache.provider.requestWithBreakpointShapeCount,
      lowHitColdStartCount: cache.provider.lowHitColdStartCount,
      lowHitFirstMessageCacheControlCount: cache.provider.lowHitFirstMessageCacheControlCount,
      lowHitMiddleMessageCacheControlCount: cache.provider.lowHitMiddleMessageCacheControlCount,
      lowHitLastMessageCacheControlCount: cache.provider.lowHitLastMessageCacheControlCount,
      promptAssemblyEventCount: cache.promptAssembly.eventCount
    }));
  }
  if (
    cache.provider.lowHitToolSchemaCacheGapCount > 0
    && cacheablePromptPrefixIsStable(cache)
    && cache.promptAssembly.stableProviderPrefixFingerprint
  ) {
    diagnostics.push(diagnostic("SWE_BENCH_PROVIDER_TOOL_SCHEMA_CACHE_GAP", "warn", "SWE-bench provider cache stayed low while the prompt replay, provider prefix, and visible tool schema set were stable.", {
      lowHitToolSchemaCacheGapCount: cache.provider.lowHitToolSchemaCacheGapCount,
      lowHitRequestCount: cache.provider.lowHitRequestCount,
      requestCount: cache.provider.requestCount,
      requestWithPipelineCount: cache.provider.requestWithPipelineCount,
      uniqueToolPlanFingerprintCount: cache.promptAssembly.uniqueToolPlanFingerprintCount,
      uniqueProviderPrefixFingerprintCount: cache.promptAssembly.uniqueProviderPrefixFingerprintCount,
      promptAssemblyEventCount: cache.promptAssembly.eventCount
    }));
  }
  if (
    cache.provider.lowHitBreakpointShapeTelemetryMissingCount > 0
    && promptReplayHasNoDriftEvidence(cache)
  ) {
    diagnostics.push(diagnostic("SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_TELEMETRY_MISSING", "warn", "SWE-bench provider cache stayed low but usage evidence did not include provider-native cache breakpoint-shape telemetry.", {
      lowHitBreakpointShapeTelemetryMissingCount: cache.provider.lowHitBreakpointShapeTelemetryMissingCount,
      lowHitRequestCount: cache.provider.lowHitRequestCount,
      requestCount: cache.provider.requestCount,
      requestWithPipelineCount: cache.provider.requestWithPipelineCount,
      requestWithBreakpointShapeCount: cache.provider.requestWithBreakpointShapeCount,
      promptAssemblyEventCount: cache.promptAssembly.eventCount
    }));
  }
  if (
    cache.provider.lowHitMultiMessageCacheControlCount > 0
    && promptReplayHasNoDriftEvidence(cache)
  ) {
    diagnostics.push(diagnostic("SWE_BENCH_PROVIDER_CACHE_MULTI_MESSAGE_BREAKPOINT", "warn", "SWE-bench provider cache stayed low while GLM Anthropic requests carried multiple message-level cache breakpoints.", {
      lowHitMultiMessageCacheControlCount: cache.provider.lowHitMultiMessageCacheControlCount,
      lowHitRequestCount: cache.provider.lowHitRequestCount,
      requestCount: cache.provider.requestCount,
      requestWithPipelineCount: cache.provider.requestWithPipelineCount,
      maxSystemCacheControlCount: cache.provider.maxSystemCacheControlCount,
      maxMessageCacheControlCount: cache.provider.maxMessageCacheControlCount,
      maxToolCacheControlCount: cache.provider.maxToolCacheControlCount,
      maxTotalCacheControlCount: cache.provider.maxTotalCacheControlCount,
      lowHitFirstMessageCacheControlCount: cache.provider.lowHitFirstMessageCacheControlCount,
      lowHitMiddleMessageCacheControlCount: cache.provider.lowHitMiddleMessageCacheControlCount,
      lowHitLastMessageCacheControlCount: cache.provider.lowHitLastMessageCacheControlCount,
      promptAssemblyEventCount: cache.promptAssembly.eventCount
    }));
  }
  if (
    cache.provider.lowHitDynamicTailMissCount > 0
    && cacheablePromptPrefixIsStable(cache)
    && cache.promptAssembly.stableProviderPrefixFingerprint
  ) {
    diagnostics.push(diagnostic("SWE_BENCH_PROVIDER_CACHE_DYNAMIC_TAIL_MISS", "warn", "SWE-bench provider cache reused a stable prefix/tool-schema region but total cache rate stayed low because dynamic request tails dominated misses.", {
      lowHitDynamicTailMissCount: cache.provider.lowHitDynamicTailMissCount,
      lowHitDynamicTailMissTokens: cache.provider.lowHitDynamicTailMissTokens,
      lowHitRequestCount: cache.provider.lowHitRequestCount,
      requestCount: cache.provider.requestCount,
      requestWithPipelineCount: cache.provider.requestWithPipelineCount,
      effectiveStableCacheHitTokens: cache.provider.effectiveStableCacheHitTokens,
      maxPositiveHitTokens: cache.provider.maxPositiveHitTokens,
      minPositiveHitTokens: cache.provider.minPositiveHitTokens,
      maxSelectedHistoryMessageCount: cache.provider.maxSelectedHistoryMessageCount,
      maxAssistantToolCallCount: cache.provider.maxAssistantToolCallCount,
      maxToolResultCount: cache.provider.maxToolResultCount,
      providerPrefixEventCount: cache.promptAssembly.providerPrefixEventCount,
      minProviderPrefixTokenEstimate: cache.promptAssembly.minProviderPrefixTokenEstimate,
      maxProviderPrefixTokenEstimate: cache.promptAssembly.maxProviderPrefixTokenEstimate,
      uniqueProviderPrefixFingerprintCount: cache.promptAssembly.uniqueProviderPrefixFingerprintCount,
      uniqueToolPlanFingerprintCount: cache.promptAssembly.uniqueToolPlanFingerprintCount,
      promptAssemblyEventCount: cache.promptAssembly.eventCount
    }));
  }
  if (
    cache.provider.lowHitRequestCount > 0
    && cacheablePromptPrefixIsStable(cache)
    && cache.promptAssembly.providerPrefixEventCount > 1
    && !cache.promptAssembly.stableProviderPrefixFingerprint
  ) {
    diagnostics.push(diagnostic("SWE_BENCH_PROVIDER_CACHE_PREFIX_DRIFT", "warn", "SWE-bench provider cache misses occurred while provider-prefix fingerprints changed despite stable prompt replay fingerprints.", {
      lowHitRequestCount: cache.provider.lowHitRequestCount,
      requestCount: cache.provider.requestCount,
      requestWithPipelineCount: cache.provider.requestWithPipelineCount,
      providerPrefixEventCount: cache.promptAssembly.providerPrefixEventCount,
      uniqueProviderPrefixFingerprintCount: cache.promptAssembly.uniqueProviderPrefixFingerprintCount,
      minProviderPrefixMessageCount: cache.promptAssembly.minProviderPrefixMessageCount,
      maxProviderPrefixMessageCount: cache.promptAssembly.maxProviderPrefixMessageCount,
      minProviderPrefixTokenEstimate: cache.promptAssembly.minProviderPrefixTokenEstimate,
      maxProviderPrefixTokenEstimate: cache.promptAssembly.maxProviderPrefixTokenEstimate,
      promptAssemblyEventCount: cache.promptAssembly.eventCount
    }));
  }
  if (
    cache.provider.lowHitProviderPrefixTooSmallCount > 0
    && cacheablePromptPrefixIsStable(cache)
  ) {
    diagnostics.push(diagnostic("SWE_BENCH_PROVIDER_CACHE_PREFIX_TOO_SMALL", "warn", "SWE-bench provider cache misses persisted despite sent prefix hints because the stable provider prefix was too small for meaningful reuse.", {
      lowHitProviderPrefixTooSmallCount: cache.provider.lowHitProviderPrefixTooSmallCount,
      lowHitRequestCount: cache.provider.lowHitRequestCount,
      requestCount: cache.provider.requestCount,
      requestWithPipelineCount: cache.provider.requestWithPipelineCount,
      providerPrefixEventCount: cache.promptAssembly.providerPrefixEventCount,
      minProviderPrefixMessageCount: cache.promptAssembly.minProviderPrefixMessageCount,
      maxProviderPrefixMessageCount: cache.promptAssembly.maxProviderPrefixMessageCount,
      minProviderPrefixTokenEstimate: cache.promptAssembly.minProviderPrefixTokenEstimate,
      maxProviderPrefixTokenEstimate: cache.promptAssembly.maxProviderPrefixTokenEstimate,
      uniqueProviderPrefixFingerprintCount: cache.promptAssembly.uniqueProviderPrefixFingerprintCount,
      stableProviderPrefixFingerprint: cache.promptAssembly.stableProviderPrefixFingerprint,
      promptAssemblyEventCount: cache.promptAssembly.eventCount
    }));
  }
  if (
    cache.provider.lowHitProviderPrefixCoverageLowCount > 0
    && cacheablePromptPrefixIsStable(cache)
    && cache.promptAssembly.stableProviderPrefixFingerprint
  ) {
    diagnostics.push(diagnostic("SWE_BENCH_PROVIDER_CACHE_PREFIX_COVERAGE_LOW", "warn", "SWE-bench provider cache stayed low because the stable provider prefix covers too little of the growing provider request.", {
      lowHitProviderPrefixCoverageLowCount: cache.provider.lowHitProviderPrefixCoverageLowCount,
      lowHitRequestCount: cache.provider.lowHitRequestCount,
      requestCount: cache.provider.requestCount,
      requestWithPipelineCount: cache.provider.requestWithPipelineCount,
      minProviderPrefixCoverageRatio: cache.provider.minProviderPrefixCoverageRatio,
      maxProviderPrefixCoverageRatio: cache.provider.maxProviderPrefixCoverageRatio,
      minProviderPrefixTokenEstimate: cache.promptAssembly.minProviderPrefixTokenEstimate,
      maxProviderPrefixTokenEstimate: cache.promptAssembly.maxProviderPrefixTokenEstimate,
      maxSelectedHistoryMessageCount: cache.provider.maxSelectedHistoryMessageCount,
      maxAssistantToolCallCount: cache.provider.maxAssistantToolCallCount,
      maxToolResultCount: cache.provider.maxToolResultCount,
      promptAssemblyEventCount: cache.promptAssembly.eventCount
    }));
  }
  if (
    cache.provider.lowHitUnboundedAfterGateCount > 0
    && cacheablePromptPrefixIsStable(cache)
    && !providerCacheTelemetryAbsent
  ) {
    diagnostics.push(diagnostic("SWE_BENCH_PROVIDER_HISTORY_UNBOUNDED_AFTER_GATE", "warn", "SWE-bench provider history grew past the managed tail after a framework gate user message.", {
      lowHitUnboundedAfterGateCount: cache.provider.lowHitUnboundedAfterGateCount,
      lowHitRequestCount: cache.provider.lowHitRequestCount,
      requestCount: cache.provider.requestCount,
      maxSelectedHistoryMessageCount: cache.provider.maxSelectedHistoryMessageCount,
      maxAssistantToolCallCount: cache.provider.maxAssistantToolCallCount,
      maxToolResultCount: cache.provider.maxToolResultCount,
      lowHitUnboundedAfterGateMaxSelectedHistoryMessageCount: cache.provider.lowHitUnboundedAfterGateMaxSelectedHistoryMessageCount,
      lowHitUnboundedAfterGateMaxAssistantToolCallCount: cache.provider.lowHitUnboundedAfterGateMaxAssistantToolCallCount,
      lowHitUnboundedAfterGateMaxToolResultCount: cache.provider.lowHitUnboundedAfterGateMaxToolResultCount,
      promptAssemblyEventCount: cache.promptAssembly.eventCount
    }));
  }
  if (
    cache.provider.lowHitRequestCount > 0
    && cache.provider.lowHitPromptAssemblyDriftCount > 0
    && !cacheablePromptPrefixIsStable(cache)
  ) {
    diagnostics.push(diagnostic("PROMPT_CACHE_PREFIX_BUSTED", "warn", "SWE-bench prompt assembly changed cacheable prefix fingerprints during the run.", {
      lowHitPromptAssemblyDriftCount: cache.provider.lowHitPromptAssemblyDriftCount,
      uniqueSectionOrderFingerprintCount: cache.promptAssembly.uniqueSectionOrderFingerprintCount,
      uniqueBudgetFingerprintCount: cache.promptAssembly.uniqueBudgetFingerprintCount,
      uniqueToolPlanFingerprintCount: cache.promptAssembly.uniqueToolPlanFingerprintCount,
      promptAssemblyEventCount: cache.promptAssembly.eventCount
    }));
  }
  if (
    cache.provider.lowHitRequestCount > 0
    && cache.promptAssembly.wholePromptFingerprintDynamicWithStablePrefix
    && !effectiveStableProviderPrefixWasReused(cache)
    && !stablePrefixMissExplainedByDynamicTail(cache)
  ) {
    diagnostics.push(diagnostic("PROMPT_WHOLE_FINGERPRINT_DYNAMIC_WITH_STABLE_PREFIX", "warn", "SWE-bench whole prompt fingerprints changed while cacheable prompt prefix fingerprints remained stable.", {
      lowHitRequestCount: cache.provider.lowHitRequestCount,
      uniqueWholePromptFingerprintCount: cache.promptAssembly.uniqueWholePromptFingerprintCount,
      uniqueSectionOrderFingerprintCount: cache.promptAssembly.uniqueSectionOrderFingerprintCount,
      uniqueBudgetFingerprintCount: cache.promptAssembly.uniqueBudgetFingerprintCount,
      uniqueToolPlanFingerprintCount: cache.promptAssembly.uniqueToolPlanFingerprintCount,
      promptAssemblyEventCount: cache.promptAssembly.eventCount
    }));
  }
  if (cache.contextProjection.requestCount > 0 && cache.contextProjection.hitCount === 0) {
    diagnostics.push(diagnostic("SWE_BENCH_CONTEXT_PROJECTION_CACHE_NO_HIT", "warn", "SWE-bench context projection cache recorded no hits.", {
      requestCount: cache.contextProjection.requestCount,
      missCount: cache.contextProjection.missCount,
      hitRate: cache.contextProjection.hitRate
    }));
  }
  if (
    cache.contextProjection.requestCount > 0
    && cache.contextProjection.hitCount === 0
    && cache.contextProjection.promptDependencyCount === cache.contextProjection.requestCount
  ) {
    diagnostics.push(diagnostic("SWE_BENCH_CONTEXT_PROJECTION_KEY_WHOLE_PROMPT_DYNAMIC", "warn", "SWE-bench context projection cache keys are tied to prompt dependency fingerprints and should be reviewed separately from stable prompt prefix caching.", {
      requestCount: cache.contextProjection.requestCount,
      promptDependencyCount: cache.contextProjection.promptDependencyCount,
      uniquePromptDependencyCount: cache.contextProjection.uniquePromptDependencyCount,
      samplePromptDependencyFingerprints: cache.contextProjection.samplePromptDependencyFingerprints,
      uniqueKeyCount: cache.contextProjection.uniqueKeyCount,
      stablePromptAssemblyReplayFingerprint: cache.promptAssembly.stableReplayFingerprint
    }));
  }
  if (
    cache.provider.requestCount > 0
    && cache.contextProjection.requestCount > 0
    && cacheablePromptPrefixIsStable(cache)
    && cache.provider.hitRate >= cacheReviewThreshold(input.cacheHitTarget)
    && cache.contextProjection.hitRate < cacheReviewThreshold(input.cacheHitTarget)
  ) {
    diagnostics.push(diagnostic("SWE_BENCH_CACHE_METRIC_SCOPE_MISMATCH", "warn", "SWE-bench provider token cache met the target while context projection cache did not; do not treat the projection miss rate as unstable prompt prefix evidence.", {
      targetHitRate: cacheReviewThreshold(input.cacheHitTarget),
      providerHitRate: cache.provider.hitRate,
      contextProjectionHitRate: cache.contextProjection.hitRate,
      promptAssemblyEventCount: cache.promptAssembly.eventCount
    }));
  }
  return diagnostics;
}

function promptReplayHasNoDriftEvidence(cache: SweBenchEvaluationCacheSummary): boolean {
  return cache.promptAssembly.eventCount > 0 &&
    cache.promptAssembly.uniqueSectionOrderFingerprintCount <= 1 &&
    cache.promptAssembly.uniqueBudgetFingerprintCount <= 1 &&
    cache.promptAssembly.uniqueToolPlanFingerprintCount <= 1 &&
    cache.promptAssembly.uniqueProviderPrefixFingerprintCount <= 1;
}

function cacheablePromptPrefixIsStable(cache: SweBenchEvaluationCacheSummary): boolean {
  return cache.promptAssembly.eventCount > 0 &&
    (cache.promptAssembly.stableReplayFingerprint || cache.promptAssembly.stableProviderPrefixFingerprint);
}

function effectiveStableProviderPrefixWasReused(cache: SweBenchEvaluationCacheSummary): boolean {
  const tokenEstimate = cache.promptAssembly.maxProviderPrefixTokenEstimate;
  return tokenEstimate > 0 && cache.provider.effectiveStableCacheHitTokens > tokenEstimate;
}

function stablePrefixMissExplainedByDynamicTail(cache: SweBenchEvaluationCacheSummary): boolean {
  return cache.provider.lowHitHistoryTailCount > 0 ||
    cache.provider.lowHitUnboundedAfterGateCount > 0 ||
    cache.provider.lowHitDynamicTailMissCount > 0;
}

async function writeHarnessFreshnessMarker(
  platform: PlatformRuntime,
  reportDir: string,
  runId: string,
  diagnostics: SweBenchPredictionDiagnostic[]
): Promise<number | undefined> {
  const markerPath = platform.resolvePath(reportDir, `.deepseek-harness-freshness-${sanitizeHarnessModelName(runId)}.json`);
  await platform.writeFile(markerPath, JSON.stringify({ runId, createdAt: new Date().toISOString() }) + "\n").catch((error: unknown) => {
    diagnostics.push(diagnostic("SWE_BENCH_REPORT_FRESHNESS_MARKER_FAILED", "warn", error instanceof Error ? error.message : String(error), { markerPath }));
  });
  return statFileMtimeMs(platform, markerPath).catch((error: unknown) => {
    diagnostics.push(diagnostic("SWE_BENCH_REPORT_FRESHNESS_STAT_FAILED", "warn", error instanceof Error ? error.message : String(error), { markerPath }));
    return undefined;
  });
}

function sweBenchHarnessArgs(
  options: CollectSweBenchPredictionOptions,
  predictionsPath: string,
  reportDir: string,
  runId: string,
  instanceIds: readonly string[],
  retry: { readonly namespace?: "none"; readonly forceRebuild?: boolean } = {}
): readonly string[] {
  return [
    "-m",
    "swebench.harness.run_evaluation",
    "--dataset_name",
    options.datasetName ?? "SWE-bench/SWE-bench_Lite",
    "--split",
    options.split ?? "test",
    "--instance_ids",
    ...instanceIds,
    "--predictions_path",
    predictionsPath,
    "--max_workers",
    "1",
    "--run_id",
    runId,
    "--timeout",
    String(Math.ceil((options.timeoutMs ?? 1_800_000) / 1000)),
    "--cache_level",
    "instance",
    "--clean",
    "false",
    "--report_dir",
    reportDir,
    ...(retry.namespace ? ["--namespace", retry.namespace] : []),
    ...(retry.forceRebuild ? ["--force_rebuild", "true"] : [])
  ];
}

async function runHarnessAttempt(
  platform: PlatformRuntime,
  options: CollectSweBenchPredictionOptions,
  command: string,
  args: readonly string[],
  reportDir: string,
  runId: string,
  diagnostics: SweBenchPredictionDiagnostic[],
  executedCommands: JsonObject[]
): Promise<SweBenchHarnessAttemptResult> {
  if (options.dryRun) return { ok: true };
  await platform.ensureDirectory(reportDir);
  const reportFreshnessCutoffMs = await writeHarnessFreshnessMarker(platform, reportDir, runId, diagnostics);
  const dockerHost = await detectDockerHost(platform, reportDir, diagnostics, executedCommands);
  const result = await platform.runProcess(command, args, {
    cwd: reportDir,
    timeoutMs: options.timeoutMs ?? 2 * 60 * 60 * 1000,
    executionProfile: "noninteractive",
    ...(dockerHost ? { env: { DOCKER_HOST: dockerHost } } : {})
  });
  if (result.exitCode !== 0) {
    diagnostics.push(diagnostic("SWE_BENCH_HARNESS_FAILED", "error", `SWE-bench harness exited with code ${result.exitCode}.`, {
      exitCode: result.exitCode,
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length
    }));
    return { ok: false };
  }
  return {
    ok: true,
    ...(reportFreshnessCutoffMs !== undefined ? { reportFreshnessCutoffMs } : {})
  };
}

async function collectHarnessResult(input: {
  readonly platform: PlatformRuntime;
  readonly reportDir: string;
  readonly runId: string;
  readonly predictions: readonly { readonly instanceId: string; readonly modelName: string }[];
  readonly predictionsByInstanceId: ReadonlyMap<string, { readonly instanceId: string; readonly modelName: string }>;
  readonly instanceIds: readonly string[];
  readonly diagnostics: SweBenchPredictionDiagnostic[];
  readonly reportFreshnessCutoffMs?: number;
  readonly diagnosticStartIndex: number;
}): Promise<SweBenchHarnessResult> {
  const instances: SweBenchEvaluationInstanceSummary[] = [];
  const topLevelReports = await readHarnessTopLevelReports(input.platform, input.reportDir, input.runId, input.predictions);
  const harnessErrorIds = new Set(topLevelReports.flatMap((report) => report.errorIds));
  const emptyPatchIds = new Set(topLevelReports.flatMap((report) => report.emptyPatchIds));
  const requestedHarnessErrorIds = input.instanceIds.filter((instanceId) => harnessErrorIds.has(instanceId));
  const requestedEmptyPatchIds = input.instanceIds.filter((instanceId) => emptyPatchIds.has(instanceId));
  if (requestedHarnessErrorIds.length > 0) {
    input.diagnostics.push(diagnostic("SWE_BENCH_HARNESS_INSTANCE_ERROR", "error", "SWE-bench official harness reported errored instances.", {
      runId: input.runId,
      errorInstanceIds: requestedHarnessErrorIds,
      reportPaths: topLevelReports.map((report) => report.reportPath)
    }));
    await diagnoseHarnessErrorLogs(input.platform, input.reportDir, input.runId, input.predictionsByInstanceId, requestedHarnessErrorIds, input.diagnostics);
  }
  if (requestedEmptyPatchIds.length > 0) {
    input.diagnostics.push(diagnostic("SWE_BENCH_HARNESS_EMPTY_PATCH", "error", "SWE-bench official harness skipped instances whose prediction patch was empty.", {
      runId: input.runId,
      emptyPatchIds: requestedEmptyPatchIds,
      reportPaths: topLevelReports.map((report) => report.reportPath)
    }));
  }
  for (const instanceId of input.instanceIds) {
    const prediction = input.predictionsByInstanceId.get(instanceId);
    if (!prediction) continue;
    const reportPath = input.platform.resolvePath(input.reportDir, "logs", "run_evaluation", input.runId, sanitizeHarnessModelName(prediction.modelName), instanceId, "report.json");
    if (harnessErrorIds.has(instanceId)) {
      instances.push(harnessErrorInstanceSummary(topLevelReportPath(input.reportDir, input.runId, prediction.modelName), prediction));
      continue;
    }
    if (emptyPatchIds.has(instanceId)) {
      instances.push(emptyPatchInstanceSummary(topLevelReportPath(input.reportDir, input.runId, prediction.modelName), prediction));
      continue;
    }
    if (input.reportFreshnessCutoffMs !== undefined) {
      const reportMtimeMs = await statFileMtimeMs(input.platform, reportPath).catch((error: unknown) => {
        input.diagnostics.push(diagnostic("SWE_BENCH_REPORT_STAT_FAILED", "error", error instanceof Error ? error.message : String(error), { reportPath, instanceId }));
        return undefined;
      });
      if (reportMtimeMs !== undefined && reportMtimeMs < input.reportFreshnessCutoffMs) {
        input.diagnostics.push(diagnostic("SWE_BENCH_REPORT_STALE", "error", "SWE-bench harness report is older than the current evaluation run marker.", {
          reportPath,
          instanceId,
          reportMtimeMs,
          reportFreshnessCutoffMs: input.reportFreshnessCutoffMs
        }));
        continue;
      }
    }
    const instance = await readHarnessInstanceReport(input.platform, reportPath, prediction).catch((error: unknown) => {
      input.diagnostics.push(diagnostic("SWE_BENCH_REPORT_READ_FAILED", "error", error instanceof Error ? error.message : String(error), { reportPath, instanceId }));
      return undefined;
    });
    if (instance) instances.push(instance);
  }
  return {
    instances,
    requestedHarnessErrorIds,
    requestedEmptyPatchIds,
    dockerImageMissing: input.diagnostics.slice(input.diagnosticStartIndex).some((entry) => entry.code === "SWE_BENCH_DOCKER_IMAGE_NOT_FOUND" && entry.severity === "error")
  };
}

function downgradeRecoverableHarnessDiagnostics(diagnostics: SweBenchPredictionDiagnostic[]): void {
  const recoverableCodes = new Set(["SWE_BENCH_HARNESS_INSTANCE_ERROR", "SWE_BENCH_DOCKER_IMAGE_NOT_FOUND", "SWE_BENCH_EVALUATION_UNRESOLVED"]);
  for (let index = 0; index < diagnostics.length; index += 1) {
    const item = diagnostics[index];
    if (item && recoverableCodes.has(item.code)) {
      diagnostics[index] = {
        ...item,
        severity: "info",
        metadata: {
          ...item.metadata,
          recoveredBy: "SWE_BENCH_HARNESS_LOCAL_BUILD_RETRY"
        }
      };
    }
  }
}

async function statFileMtimeMs(platform: PlatformRuntime, path: string): Promise<number | undefined> {
  const statFile = (platform as PlatformRuntime & { readonly statFile?: (path: string) => Promise<{ readonly mtimeMs: number; readonly size: number }> }).statFile;
  if (typeof statFile !== "function") return undefined;
  const stat = await statFile.call(platform, path);
  return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : undefined;
}

async function readPredictions(platform: PlatformRuntime, predictionsPath: string): Promise<readonly { readonly instanceId: string; readonly modelName: string }[]> {
  const content = await platform.readFile(predictionsPath);
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("SWE-bench prediction file is empty.");
  return lines.map((line) => {
    const parsed = JSON.parse(line) as JsonObject;
    const instanceId = stringField(parsed, "instance_id");
    const modelName = stringField(parsed, "model_name_or_path");
    if (!instanceId || !modelName) throw new Error("SWE-bench prediction JSONL records must include instance_id and model_name_or_path.");
    return { instanceId, modelName };
  });
}

async function readHarnessInstanceReport(
  platform: PlatformRuntime,
  reportPath: string,
  prediction: { readonly instanceId: string; readonly modelName: string }
): Promise<SweBenchEvaluationInstanceSummary> {
  const parsed = JSON.parse(await platform.readFile(reportPath)) as JsonObject;
  const instanceReport = parsed[prediction.instanceId];
  if (!isJsonObject(instanceReport)) throw new Error(`SWE-bench report does not include ${prediction.instanceId}.`);
  const testsStatus = isJsonObject(instanceReport.tests_status) ? instanceReport.tests_status : {};
  const failToPass = countHarnessStatus(testsStatus.FAIL_TO_PASS);
  const passToPass = countHarnessStatus(testsStatus.PASS_TO_PASS);
  const failureExcerpts = await readHarnessFailureExcerpts(platform, reportPath, [
    ...failToPass.failureTests,
    ...passToPass.failureTests
  ]);
  return {
    completed: true,
    resolved: instanceReport.resolved === true,
    reportPath,
    modelName: prediction.modelName,
    instanceId: prediction.instanceId,
    ...(failureExcerpts.length > 0 ? { failureExcerpts } : {}),
    tests: { failToPass, passToPass }
  };
}

async function readHarnessFailureExcerpts(
  platform: PlatformRuntime,
  reportPath: string,
  failingTests: readonly string[]
): Promise<readonly SweBenchHarnessFailureExcerpt[]> {
  if (failingTests.length === 0) return [];
  const outputPath = join(dirname(reportPath), "test_output.txt");
  const output = await platform.readFile(outputPath).catch(() => "");
  if (!output.trim()) return [];
  const excerpts = failingTests
    .slice(0, 12)
    .map((testId) => harnessFailureExcerpt(testId, output))
    .filter((excerpt): excerpt is SweBenchHarnessFailureExcerpt => excerpt !== undefined);
  if (excerpts.length > 0) return excerpts;
  const generalExcerpt = harnessGeneralFailureExcerpt(output);
  if (!generalExcerpt) return [];
  return [{
    testId: failingTests[0] as string,
    excerpt: generalExcerpt,
    redaction: { class: "internal", fields: ["excerpt"] }
  }];
}

function harnessFailureExcerpt(testId: string, output: string): SweBenchHarnessFailureExcerpt | undefined {
  const lines = output.split(/\r?\n/).map((line) => stripAnsi(line).slice(0, 300));
  const index = findHarnessFailureLine(lines, testId);
  if (index < 0) return undefined;
  const start = Math.max(0, index - 4);
  const summaryOffset = lines.slice(index + 1).findIndex((line) => /short test summary info/i.test(line));
  const summaryBoundary = summaryOffset >= 0 ? index + 1 + summaryOffset : lines.length;
  const end = Math.min(lines.length, summaryBoundary, index + 80);
  const excerpt = boundedFailureExcerpt(lines.slice(start, end).join("\n"));
  return {
    testId,
    excerpt,
    redaction: { class: "internal", fields: ["excerpt"] }
  };
}

function findHarnessFailureLine(lines: readonly string[], testId: string): number {
  const testName = testId.split("::").at(-1);
  if (!testName) return -1;
  const failureStart = lines.findIndex((line) => /^=+\s*FAILURES\s*=+$/.test(line.trim()));
  if (failureStart >= 0) {
    const failureEndOffset = lines.slice(failureStart + 1).findIndex((line) => /short test summary info/i.test(line));
    const failureEnd = failureEndOffset >= 0 ? failureStart + 1 + failureEndOffset : lines.length;
    const detailedOffset = lines.slice(failureStart, failureEnd).findIndex((line) => line.includes(testName));
    if (detailedOffset >= 0) return failureStart + detailedOffset;
  }
  const exact = lines.findIndex((line) => line.includes(testId));
  if (exact >= 0) return exact;
  return lines.findIndex((line) => line.includes(testName));
}

function harnessGeneralFailureExcerpt(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => stripAnsi(line).slice(0, 300));
  const index = lines.findIndex((line) =>
    /\b(?:INTERNALERROR|Traceback|FAILED|ERROR)\b/.test(line) ||
    /\b(?:AssertionError|TypeError|ValueError|ImportError|IORegistryError)\b/.test(line)
  );
  if (index < 0) return undefined;
  const start = Math.max(0, index - 4);
  const end = Math.min(lines.length, index + 60);
  return boundedFailureExcerpt(lines.slice(start, end).join("\n"));
}

function boundedFailureExcerpt(value: string): string {
  return value.length <= 4_000 ? value : `${value.slice(0, 4_000)}\n... truncated ...`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function evaluationSummary(
  predictionsPath: string,
  reportDir: string,
  runId: string,
  instances: readonly SweBenchEvaluationInstanceSummary[],
  cache: SweBenchEvaluationCacheSummary | undefined
): SweBenchEvaluationSummary {
  const first = instances[0] as SweBenchEvaluationInstanceSummary;
  const errorInstanceIds = instances.filter((instance) => instance.errorKind === "harness-error" || instance.errorKind === "empty-patch").map((instance) => instance.instanceId);
  const unresolvedInstanceIds = instances.filter((instance) => instance.completed && !instance.resolved).map((instance) => instance.instanceId);
  const resolvedInstances = instances.filter((instance) => instance.resolved).length;
  const batch = {
    totalInstances: instances.length,
    resolvedInstances,
    unresolvedInstanceIds,
    errorInstanceIds,
    resolvedRate: instances.length > 0 ? resolvedInstances / instances.length : 0
  };
  return {
    completed: instances.every((instance) => instance.completed),
    resolved: batch.totalInstances > 0 && batch.resolvedInstances === batch.totalInstances,
    runId,
    predictionsPath,
    reportDir,
    reportPath: first.reportPath,
    modelName: first.modelName,
    instanceId: first.instanceId,
    tests: first.tests,
    instances,
    batch,
    ...(cache ? { cache } : {})
  };
}

interface HarnessTopLevelReport {
  readonly reportPath: string;
  readonly errorIds: readonly string[];
  readonly emptyPatchIds: readonly string[];
}

async function readHarnessTopLevelReports(
  platform: PlatformRuntime,
  reportDir: string,
  runId: string,
  predictions: readonly { readonly modelName: string }[]
): Promise<readonly HarnessTopLevelReport[]> {
  const reports: HarnessTopLevelReport[] = [];
  const modelNames = [...new Set(predictions.map((prediction) => prediction.modelName))];
  for (const modelName of modelNames) {
    const reportPath = topLevelReportPath(reportDir, runId, modelName);
    const content = await platform.readFile(reportPath).catch(() => "");
    if (!content.trim()) continue;
    const parsed = JSON.parse(content) as JsonObject;
    const errorIds = Array.isArray(parsed.error_ids) ? parsed.error_ids.filter((item): item is string => typeof item === "string") : [];
    const emptyPatchIds = Array.isArray(parsed.empty_patch_ids) ? parsed.empty_patch_ids.filter((item): item is string => typeof item === "string") : [];
    if (errorIds.length > 0 || emptyPatchIds.length > 0) reports.push({ reportPath, errorIds, emptyPatchIds });
  }
  return reports;
}

function topLevelReportPath(reportDir: string, runId: string, modelName: string): string {
  return join(reportDir, `${sanitizeHarnessModelName(modelName)}.${runId}.json`);
}

function harnessErrorInstanceSummary(
  reportPath: string,
  prediction: { readonly instanceId: string; readonly modelName: string }
): SweBenchEvaluationInstanceSummary {
  return {
    completed: false,
    resolved: false,
    errorKind: "harness-error",
    reportPath,
    modelName: prediction.modelName,
    instanceId: prediction.instanceId,
    tests: {
      failToPass: emptyHarnessStatus(),
      passToPass: emptyHarnessStatus()
    }
  };
}

function emptyPatchInstanceSummary(
  reportPath: string,
  prediction: { readonly instanceId: string; readonly modelName: string }
): SweBenchEvaluationInstanceSummary {
  return {
    completed: false,
    resolved: false,
    errorKind: "empty-patch",
    reportPath,
    modelName: prediction.modelName,
    instanceId: prediction.instanceId,
    tests: {
      failToPass: emptyHarnessStatus(),
      passToPass: emptyHarnessStatus()
    }
  };
}

async function diagnoseHarnessErrorLogs(
  platform: PlatformRuntime,
  reportDir: string,
  runId: string,
  predictionsByInstanceId: ReadonlyMap<string, { readonly instanceId: string; readonly modelName: string }>,
  errorInstanceIds: readonly string[],
  diagnostics: SweBenchPredictionDiagnostic[]
): Promise<void> {
  for (const instanceId of errorInstanceIds) {
    const prediction = predictionsByInstanceId.get(instanceId);
    if (!prediction) continue;
    const logPath = platform.resolvePath(reportDir, "logs", "run_evaluation", runId, sanitizeHarnessModelName(prediction.modelName), instanceId, "run_instance.log");
    const log = await platform.readFile(logPath).catch(() => "");
    if (!log.trim()) continue;
    const dockerImage = dockerImageNotFoundName(log);
    if (dockerImage) {
      diagnostics.push(diagnostic("SWE_BENCH_DOCKER_IMAGE_NOT_FOUND", "error", "SWE-bench harness could not find the required Docker evaluation image.", {
        instanceId,
        logPath,
        dockerImage
      }));
    }
  }
}

function dockerImageNotFoundName(log: string): string | undefined {
  const dockerImageNotFound = log.includes("docker.errors.ImageNotFound") || log.includes("No such image:");
  if (!dockerImageNotFound) return undefined;
  const quotedMatch = /No such image:\s*([^")\s]+)/.exec(log);
  if (quotedMatch?.[1]) return quotedMatch[1];
  const urlMatch = /\/images\/([^/\s]+(?::[^/\s]+)?)\/json/.exec(log);
  return urlMatch?.[1];
}

function countHarnessStatus(value: unknown): SweBenchEvaluationTestStatus {
  if (!isJsonObject(value)) return emptyHarnessStatus();
  const successTests = Array.isArray(value.success) ? value.success.filter((item): item is string => typeof item === "string") : [];
  const failureTests = Array.isArray(value.failure) ? value.failure.filter((item): item is string => typeof item === "string") : [];
  return {
    success: successTests.length,
    failure: failureTests.length,
    successTests,
    failureTests
  };
}

function emptyHarnessStatus(): SweBenchEvaluationTestStatus {
  return { success: 0, failure: 0, successTests: [], failureTests: [] };
}

function harnessCommandPlan(
  options: CollectSweBenchPredictionOptions,
  command: string,
  args: readonly string[],
  reportDir: string,
  override: { readonly id?: string; readonly action?: string } = {}
): JsonObject {
  return {
    id: override.id ?? "swe-bench.harness",
    action: override.action ?? "run-official-harness",
    datasetName: options.datasetName ?? "SWE-bench/SWE-bench_Lite",
    split: options.split ?? "test",
    dryRun: options.dryRun,
    command,
    argCount: args.length,
    reportDir,
    redaction: { class: "internal", fields: ["command", "args", "reportDir"] }
  };
}

async function detectDockerHost(
  platform: PlatformRuntime,
  cwd: string,
  diagnostics: SweBenchPredictionDiagnostic[],
  executedCommands: JsonObject[]
): Promise<string | undefined> {
  const args = ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"];
  executedCommands.push(commandRecord("docker-context", "docker", args, cwd));
  const result = await platform.runProcess("docker", args, { cwd, timeoutMs: 5000, outputLimitBytes: 4096, executionProfile: "noninteractive" });
  if (result.exitCode !== 0) {
    diagnostics.push(diagnostic("SWE_BENCH_DOCKER_CONTEXT_UNAVAILABLE", "warn", "Docker context host could not be detected before running the SWE-bench harness.", {
      exitCode: result.exitCode,
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length
    }));
    return undefined;
  }
  const parsed = parseDockerHost(result.stdout);
  if (!parsed) {
    diagnostics.push(diagnostic("SWE_BENCH_DOCKER_CONTEXT_EMPTY", "warn", "Docker context did not expose a Docker host value for subprocesses."));
    return undefined;
  }
  return parsed;
}

function parseDockerHost(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "string" && parsed.trim().length > 0 ? parsed : undefined;
  } catch {
    return trimmed;
  }
}

function defaultHarnessPython(platform: PlatformRuntime): string {
  return platform.resolvePath(process.cwd(), ".deepseek", "swebench-venv", platform.os === "windows" ? "Scripts/python.exe" : "bin/python");
}

function absolutePath(platform: PlatformRuntime, path: string): string {
  return isAbsolute(path) ? path : platform.resolvePath(process.cwd(), path);
}

function sanitizeHarnessModelName(modelName: string): string {
  return modelName.replace(/\//g, "__");
}

async function readInstance(platform: PlatformRuntime, path: string): Promise<SweBenchInstance> {
  const parsed = JSON.parse(await platform.readFile(path)) as JsonObject;
  const instanceId = stringField(parsed, "instance_id");
  const problemStatement = stringField(parsed, "problem_statement");
  if (!instanceId || !problemStatement) throw new Error("SWE-bench instance file must include instance_id and problem_statement.");
  return {
    instanceId,
    problemStatement,
    ...(stringField(parsed, "repo") ? { repo: stringField(parsed, "repo") } : {}),
    ...(stringField(parsed, "base_commit") ? { baseCommit: stringField(parsed, "base_commit") } : {})
  };
}

async function childCommand(
  platform: PlatformRuntime,
  instance: SweBenchInstance,
  options: CollectSweBenchPredictionOptions,
  modelName: string
): Promise<{ readonly command: string; readonly args: readonly string[]; readonly env?: JsonObject }> {
  const repairContextPath = options.repairContext
    ? await writeRepairContextFile(platform, options.repoDir as string, options.repairContext)
    : undefined;
  const args = [
    join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
    "--tsconfig",
    join(process.cwd(), "tsconfig.json"),
    join(process.cwd(), "src/apps/cli/src/index.ts"),
    "run",
    sweBenchPrompt(instance),
    "--workspace-root",
    options.repoDir as string,
    "--output",
    "jsonl",
    "--live",
    "--tool-projection",
    "all",
    "--timeout-ms",
    String(options.timeoutMs ?? 15 * 60 * 1000),
    ...(options.supervisorWorkflowStatePath ? [
      "--supervisor-workflow-state",
      options.supervisorWorkflowStatePath
    ] : []),
    ...(repairContextPath ? [
      "--additional-user-context-file",
      repairContextPath
    ] : []),
    ...evaluationModelSelectionArgs({
      ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
      model: options.model ?? modelName
    })
  ];
  return {
    command: process.execPath,
    args,
    env: await evaluationLiveCredentialEnv(platform, options.modelProvider)
  };
}

async function writeRepairContextFile(
  platform: PlatformRuntime,
  repoDir: string,
  repairContext: SweBenchRepairContext
): Promise<string> {
  const path = platform.resolvePath(repoDir, ".deepseek", "swe-bench-repair-context.md");
  await platform.ensureDirectory(dirname(path));
  await platform.writeFile(path, repairFeedbackContent(repairContext));
  return path;
}

async function collectGitDiff(
  platform: PlatformRuntime,
  repoDir: string,
  diagnostics: SweBenchPredictionDiagnostic[],
  executedCommands: JsonObject[]
): Promise<string> {
  executedCommands.push(commandRecord("git-diff", "git", ["diff", "--binary"], repoDir));
  const result = await platform.runProcess("git", ["diff", "--binary"], { cwd: repoDir, timeoutMs: 60_000, executionProfile: "noninteractive" });
  if (result.exitCode !== 0) {
    diagnostics.push(diagnostic("SWE_BENCH_GIT_DIFF_FAILED", "error", `git diff exited with code ${result.exitCode}.`, {
      exitCode: result.exitCode,
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length
    }));
    return "";
  }
  return result.stdout;
}

async function writeChildTrace(platform: PlatformRuntime, traceOutputPath: string, stdout: string): Promise<void> {
  await platform.ensureDirectory(dirname(traceOutputPath));
  await platform.writeFile(traceOutputPath, stdout);
}

interface ChildTraceStreamWriter {
  readonly observer: ProcessRunObserver;
  readonly stdout: string;
  readonly hasWritten: boolean;
  readonly flush: () => Promise<void>;
}

async function createChildTraceStreamWriter(platform: PlatformRuntime, traceOutputPath: string): Promise<ChildTraceStreamWriter> {
  await platform.ensureDirectory(dirname(traceOutputPath));
  let stdout = "";
  let flushedBytes = 0;
  let hasWritten = false;
  let writeChain = Promise.resolve();
  const queueFlush = (force = false) => {
    if (!force && stdout.length - flushedBytes < 16_384) return;
    if (stdout.length === 0 && !hasWritten) return;
    if (stdout.length === flushedBytes && hasWritten) return;
    const snapshot = stdout;
    flushedBytes = snapshot.length;
    hasWritten = true;
    writeChain = writeChain.then(() => platform.writeFile(traceOutputPath, snapshot));
  };
  const writer: ChildTraceStreamWriter = {
    observer: {
      onStdoutChunk(chunk: string) {
        stdout += chunk;
        queueFlush();
      },
      onProcessExit() {
        queueFlush(true);
      }
    },
    get stdout() {
      return stdout;
    },
    get hasWritten() {
      return hasWritten;
    },
    async flush() {
      queueFlush(true);
      await writeChain;
    }
  };
  return writer;
}

async function writePredictionRecord(
  platform: PlatformRuntime,
  outputPath: string,
  prediction: SweBenchPredictionRecord,
  appendOutput: boolean
): Promise<void> {
  await platform.ensureDirectory(dirname(outputPath));
  const line = `${JSON.stringify(prediction)}\n`;
  if (!appendOutput) {
    await platform.writeFile(outputPath, line);
    return;
  }
  const existing = await readExistingFileOrEmpty(platform, outputPath);
  const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  await platform.writeFile(outputPath, `${prefix}${line}`);
}

async function readExistingFileOrEmpty(platform: PlatformRuntime, path: string): Promise<string> {
  try {
    return await platform.readFile(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found") || message.includes("ENOENT")) return "";
    throw error;
  }
}

function childCommandPlan(instance: SweBenchInstance, options: CollectSweBenchPredictionOptions, modelName: string): JsonObject {
  return {
    id: "swe-bench.agent-run",
    action: "run-cli-in-repo",
    instanceId: instance.instanceId,
    provider: options.modelProvider ?? "deepseek",
    model: modelName,
    toolProjection: "safe-all",
    dryRun: options.dryRun,
    redaction: { class: "internal", fields: ["prompt", "args", "repoDir"] }
  };
}

function gitDiffCommandPlan(repoDir: string): JsonObject {
  return {
    id: "swe-bench.git-diff",
    action: "collect-patch",
    command: "git diff --binary",
    repoDir,
    redaction: { class: "internal", fields: ["repoDir"] }
  };
}

function commandRecord(id: string, command: string, args: readonly string[], cwd: string): JsonObject {
  return {
    id,
    command,
    argCount: args.length,
    cwd,
    redaction: { class: "internal", fields: ["command", "args", "cwd"] }
  };
}

function predictionRecord(instanceId: string, modelName: string, patch: string): SweBenchPredictionRecord {
  return {
    instance_id: instanceId,
    model_name_or_path: modelName,
    model_patch: patch
  };
}

function sweBenchPrompt(instance: SweBenchInstance): string {
  return [
    `Resolve SWE-bench instance ${instance.instanceId}.`,
    instance.repo ? `Repository: ${instance.repo}` : undefined,
    instance.baseCommit ? `Base commit: ${instance.baseCommit}` : undefined,
    "",
    "Managed SWE-bench execution profile:",
    "Managed child tool matrix:",
    "- environment: supervisor-prepared checkout; do not call core.env.prepare",
    "- source-inspection: core.file.read, core.file.list, core.search.text, core.workspace.glob",
    "- mutation: core.file.write, core.file.edit, core.patch.apply",
    "- command-execution: core.shell.run",
    "- verification: core.test.run",
    "- patch-review: core.git.diff",
    "- harness-scoring: supervisor-owned official harness after child returns",
    "- packaging: supervisor-owned prediction JSON and trace summary",
    "Runner stages: prepare -> understand -> change -> verify -> score -> package -> return",
    "- Work only inside the current repository checkout.",
    "- Do not search parent directories or system roots to discover the repository.",
    "- Do not clone or create another copy of the repository.",
    "- use pwd and ls once to verify the current checkout root, then stay inside it.",
    "- If a path is missing, re-check the current checkout root before broadening the search.",
    "- Phase budget: inspect source and local tests first; after at most 12 tool calls or one dependency setup attempt, make a minimal source edit or record why no edit is possible.",
    "- Phase budget: after the first source edit, switch to verification instead of continuing broad exploration.",
    "- Before trusting existing tests, derive the smallest reproduction from the Problem statement, reproduction notes, expected behavior, or failing test description.",
    "- After patch, run that reproduction or an equivalent focused regression before broad public tests.",
    "- Verification cost budget: use the cheapest command that can falsify the patch first.",
    "- Verification ladder: reproduction or changed-file focused test, then affected module or package subset, then broad suite only if focused evidence is inconclusive and request budget remains.",
    "- Modify the active code path that the failing API actually uses. Do not add unused parallel classes, alternate writers, or helper types unless the registered implementation calls them.",
    "- If the problem statement includes a traceback such as TypeError: ... unexpected keyword argument, update the receiving class/function on that call path to accept and implement that argument's behavior.",
    "- If the problem statement includes an executable example, construct and run a focused local reproduction from that example before relying on unrelated existing tests.",
    "- Before final answer, run at least one model-authored standard test command that exercises the checkout, such as pytest, python -m pytest, python -m unittest, tox, nox, or the repository package test runner.",
    "- Prefer the narrowest focused test or reproduction related to the changed files before broad suites.",
    "- After a passing focused standard test, stop local testing and leave broader scoring to the supervisor harness unless official repair feedback requires another focused check.",
    "- If no standard test command has been attempted, do not answer SWE patch ready; run the shortest feasible standard test command first or report why it cannot be started.",
    "- Capture the test result and leave the source diff in the checkout for the supervisor harness.",
    "",
    "Problem statement:",
    instance.problemStatement,
    "",
    "Task:",
    "- Inspect the current repository checkout.",
    "- Make the smallest source change needed to resolve the problem.",
    "- Do not edit benchmark tests unless the repository already requires updating generated fixtures.",
    "- Run a focused relevant standard test command.",
    "- Leave the repository with the fix applied.",
    "- Final answer exactly: SWE patch ready"
  ].filter((line): line is string => line !== undefined).join("\n");
}

function repairFeedbackContent(repairContext: SweBenchRepairContext): string {
  return [
    "Previous supervised attempt feedback:",
    `- Repair attempt number: ${repairContext.attemptNumber}.`,
    repairContext.failureKind === "pre-harness-generation"
      ? `- Attempt ${repairContext.attemptNumber - 1} stopped before official harness readiness.`
      : `- Attempt ${repairContext.attemptNumber - 1} official harness did not resolve the instance.`,
    `- Previous evaluation run: ${repairContext.previousRunId}.`,
    ...(repairContext.previousStageId ? [`- Failed stage: ${repairContext.previousStageId}.`] : []),
    ...(repairContext.previousTerminalKind ? [`- Terminal kind: ${repairContext.previousTerminalKind}.`] : []),
    ...(repairContext.previousTerminalReason ? [`- Terminal reason: ${repairContext.previousTerminalReason}.`] : []),
    ...(typeof repairContext.previousSourceMutationCount === "number" ? [
      `- Source mutation count: ${repairContext.previousSourceMutationCount}.`
    ] : []),
    ...(typeof repairContext.previousTestCommandCount === "number" ? [
      `- Standard test command count: ${repairContext.previousTestCommandCount}.`
    ] : []),
    ...(repairContext.requiredNextAction ? [`- Required next action: ${repairContext.requiredNextAction}.`] : []),
    ...(typeof repairContext.previousPatchBytes === "number" ? [
      `- Previous patch status: ${repairContext.previousPatchBytes > 0 ? "non-empty" : "empty"} patchBytes=${repairContext.previousPatchBytes}.`
    ] : []),
    ...(typeof repairContext.previousPatchBytes === "number" && repairContext.previousPatchBytes > 0 ? [
      "- The previous patch is already applied in the current checkout and is the baseline for this repair attempt.",
      "- Do not replay the previous patch. Diagnose the remaining failure and make only the incremental source change needed beyond that baseline.",
      "- If the previous patch delegates behavior to a base class or helper, inspect that exact symbol or direct dependency instead of rereading unrelated file prefixes."
    ] : []),
    ...(typeof repairContext.restoredFromAttempt === "number" ? [
      `- Restored best candidate from attempt ${repairContext.restoredFromAttempt}.`,
      `- Discarded regressed attempt ${repairContext.discardedRegressedAttempt ?? repairContext.attemptNumber - 1}.`
    ] : []),
    "- Failing tests:",
    ...repairContext.failingTests.slice(0, 12).map((test) => `  - ${test}`),
    ...(repairContext.failureExcerpts && repairContext.failureExcerpts.length > 0 ? [
      "- Official harness failure excerpts:",
      ...repairContext.failureExcerpts.slice(0, 6).flatMap(formatRepairFailureExcerpt)
    ] : []),
    ...(repairContext.localTestSourceExcerpts && repairContext.localTestSourceExcerpts.length > 0 ? [
      "- Local failing test source excerpts:",
      ...repairContext.localTestSourceExcerpts.slice(0, 6).flatMap(formatLocalTestSourceExcerpt)
    ] : []),
    ...(repairContext.problemStatement ? [
      "- Original problem statement:",
      ...repairContext.problemStatement.split(/\r?\n/).slice(0, 80).map((line) => `  ${line.slice(0, 240)}`)
    ] : []),
    ...(repairContext.previousPatchExcerpt ? [
      "- Previous patch excerpt:",
      ...repairContext.previousPatchExcerpt.split(/\r?\n/).slice(0, 80).map((line) => `  ${line.slice(0, 240)}`)
    ] : []),
    "- Low-fidelity official feedback handling:",
    "  - Official fail-to-pass tests may be hidden or injected by the harness; passing the existing public test file alone is not sufficient repair evidence.",
    "  - If the failing test is not present locally, construct and run a focused python -c reproduction from the official excerpt or original problem statement before trusting the patch.",
    "  - If no official failure excerpt is available, construct and run a focused local reproduction from the original problem statement before editing again.",
    "  - Modify the active code path used by the failing API. Do not add unused parallel classes or alternate implementations that are not registered or called.",
    "  - If the original traceback reports an unexpected keyword argument, update the receiving class/function to accept and implement that argument's behavior.",
    "- Repair the current checkout based on local source and these test failures; do not look up upstream fix commits.",
    ""
  ].join("\n");
}

function formatRepairFailureExcerpt(excerpt: SweBenchHarnessFailureExcerpt): readonly string[] {
  return [
    `  - ${excerpt.testId}:`,
    ...excerpt.excerpt
      .split(/\r?\n/)
      .slice(0, 80)
      .map((line) => `    ${line.slice(0, 240)}`)
  ];
}

function formatLocalTestSourceExcerpt(excerpt: SweBenchLocalTestSourceExcerpt): readonly string[] {
  return [
    `  - ${excerpt.testId} (${excerpt.filePath}):`,
    ...excerpt.excerpt
      .split(/\r?\n/)
      .slice(0, 80)
      .map((line) => `    ${line.slice(0, 240)}`)
  ];
}

function diagnostic(code: string, severity: SweBenchPredictionDiagnostic["severity"], message: string, metadata: JsonObject = {}): SweBenchPredictionDiagnostic {
  return {
    code,
    severity,
    message,
    metadata,
    redaction: { class: "internal", fields: ["metadata"] }
  };
}

function pythonTestFailureMetadata(childTrace: NonNullable<SweBenchPredictionSummary["childTrace"]>): JsonObject {
  const details = childTrace.testFailureDetails ?? [];
  return details.length > 0 ? {
    testFailureDetailCount: details.length,
    testFailureDetails: details as unknown as JsonObject[]
  } : {};
}

function stringField(value: JsonObject, key: string): string {
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function numberField(value: JsonObject, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatContextProjectionHitRate(contextProjection: SweBenchEvaluationCacheSummary["contextProjection"]): string {
  if (contextProjection.requestCount <= 0) return "unknown";
  return formatRate(contextProjection.hitRate);
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
