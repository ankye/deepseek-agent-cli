import { dirname, isAbsolute, join } from "node:path";
import type { JsonObject, PlatformRuntime } from "@deepseek/platform-contracts";
import { NodePlatformRuntime } from "@deepseek/platform-abstraction";
import { evaluationLiveCredentialEnv, evaluationModelSelectionArgs } from "./evaluation-provider-selection.js";
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
    readonly failToPass: { readonly success: number; readonly failure: number };
    readonly passToPass: { readonly success: number; readonly failure: number };
  };
  readonly instances: readonly SweBenchEvaluationInstanceSummary[];
  readonly batch: {
    readonly totalInstances: number;
    readonly resolvedInstances: number;
    readonly unresolvedInstanceIds: readonly string[];
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
  readonly tests: {
    readonly failToPass: { readonly success: number; readonly failure: number };
    readonly passToPass: { readonly success: number; readonly failure: number };
  };
}

export interface SweBenchEvaluationCacheSummary extends JsonObject {
  readonly tracePath: string;
  readonly targetHitRate?: number;
  readonly hitTokens: number;
  readonly missTokens: number;
  readonly hitRate: number;
  readonly requestCount: number;
  readonly lowHitRequestCount: number;
  readonly passed?: boolean;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface SweBenchPredictionSummary extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly kind: "diagnostics.swe-bench.prediction.summary";
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
  readonly childTrace?: SweBenchChildTraceSummary;
  readonly evaluation?: SweBenchEvaluationSummary;
  readonly diagnostics: readonly SweBenchPredictionDiagnostic[];
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
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

  const modelName = options.model ?? (options.modelProvider === "glm" ? "glm-5.1" : "deepseek-cli");
  const repoDir = options.repoDir as string;
  const commandPlan = [childCommandPlan(instance, options, modelName), gitDiffCommandPlan(repoDir)];
  const executedCommands: JsonObject[] = [];
  let childTrace: SweBenchChildTraceSummary | undefined;

  if (options.live && !options.dryRun) {
    const command = await childCommand(platform, instance, options, modelName);
    executedCommands.push(commandRecord("agent", command.command, command.args, repoDir));
    const result = await platform.runProcess(command.command, command.args, {
      cwd: repoDir,
      timeoutMs: options.timeoutMs ?? 15 * 60 * 1000,
      ...(command.env ? { env: command.env } : {})
    });
    if (result.exitCode !== 0) {
      diagnostics.push(diagnostic("SWE_BENCH_AGENT_RUN_FAILED", "warn", `SWE-bench agent run exited with code ${result.exitCode}.`, {
        exitCode: result.exitCode,
        stdoutBytes: result.stdout.length,
        stderrBytes: result.stderr.length
      }));
    }
    if (nonEmpty(options.traceOutputPath)) {
      await writeChildTrace(platform, options.traceOutputPath as string, result.stdout);
    }
    childTrace = summarizeSweBenchChildTrace(result.stdout, options.traceOutputPath);
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
  }

  const patch = options.dryRun ? "" : await collectGitDiff(platform, repoDir, diagnostics, executedCommands);
  const prediction = predictionRecord(instance.instanceId, modelName, patch);
  if (!options.dryRun) {
    await writePredictionRecord(platform, options.outputPath as string, prediction, options.appendOutput === true);
  }
  if (!options.dryRun && patch.trim().length === 0) {
    diagnostics.push(diagnostic("SWE_BENCH_EMPTY_PATCH", "warn", "SWE-bench prediction patch is empty after the agent run."));
  }

  return summary(options, diagnostics, [prediction], commandPlan, executedCommands, instance, undefined, childTrace);
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
      model: options.model ?? (options.modelProvider === "glm" ? "glm-5.1" : "deepseek-cli"),
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
  const args = [
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
    reportDir
  ];
  const executedCommands = [commandRecord("swe-bench.harness", command, args, reportDir)];
  const commandPlan = [harnessCommandPlan(options, command, args, reportDir)];

  if (!options.dryRun) {
    await platform.ensureDirectory(reportDir);
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
      return summary(options, diagnostics, [], commandPlan, executedCommands, undefined, undefined);
    }
  }

  const instances: SweBenchEvaluationInstanceSummary[] = [];
  for (const instanceId of instanceIds) {
    const prediction = predictionsByInstanceId.get(instanceId);
    if (!prediction) continue;
    const reportPath = platform.resolvePath(reportDir, "logs", "run_evaluation", runId, sanitizeHarnessModelName(prediction.modelName), instanceId, "report.json");
    const instance = await readHarnessInstanceReport(platform, reportPath, prediction).catch((error: unknown) => {
      diagnostics.push(diagnostic("SWE_BENCH_REPORT_READ_FAILED", "error", error instanceof Error ? error.message : String(error), { reportPath, instanceId }));
      return undefined;
    });
    if (instance) instances.push(instance);
  }
  if (instances.length === 0) return summary(options, diagnostics, [], commandPlan, executedCommands, undefined, undefined);

  const cache = options.cacheTracePath
    ? await readCacheTrace(platform, absolutePath(platform, options.cacheTracePath), options.cacheHitTarget).catch((error: unknown) => {
        diagnostics.push(diagnostic("SWE_BENCH_CACHE_TRACE_READ_FAILED", "error", error instanceof Error ? error.message : String(error), { cacheTracePath: options.cacheTracePath }));
        return undefined;
      })
    : undefined;
  if (cache && options.cacheHitTarget !== undefined) {
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
    }
  }
  const evaluation = evaluationSummary(predictionsPath, reportDir, runId, instances, cache);
  return summary(options, diagnostics, [], commandPlan, executedCommands, undefined, evaluation);
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
  return {
    completed: true,
    resolved: instanceReport.resolved === true,
    reportPath,
    modelName: prediction.modelName,
    instanceId: prediction.instanceId,
    tests: { failToPass, passToPass }
  };
}

function evaluationSummary(
  predictionsPath: string,
  reportDir: string,
  runId: string,
  instances: readonly SweBenchEvaluationInstanceSummary[],
  cache: SweBenchEvaluationCacheSummary | undefined
): SweBenchEvaluationSummary {
  const first = instances[0] as SweBenchEvaluationInstanceSummary;
  const unresolvedInstanceIds = instances.filter((instance) => !instance.resolved).map((instance) => instance.instanceId);
  const resolvedInstances = instances.length - unresolvedInstanceIds.length;
  const batch = {
    totalInstances: instances.length,
    resolvedInstances,
    unresolvedInstanceIds,
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

async function readCacheTrace(
  platform: PlatformRuntime,
  cacheTracePath: string,
  targetHitRate: number | undefined
): Promise<SweBenchEvaluationCacheSummary> {
  const content = await platform.readFile(cacheTracePath);
  let hitTokens = 0;
  let missTokens = 0;
  let requestCount = 0;
  let lowHitRequestCount = 0;
  const lowHitThreshold = targetHitRate ?? 0.9;
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as JsonObject;
    const data = usageData(parsed);
    if (!data) continue;
    const cache = usageCache(data);
    if (!cache) continue;
    const hit = numberField(cache, "hitTokens") ?? 0;
    const miss = numberField(cache, "missTokens") ?? numberField(data, "inputTokens") ?? numberField(data, "input_tokens") ?? 0;
    const total = hit + miss;
    if (total <= 0) continue;
    const rate = hit / total;
    requestCount += 1;
    hitTokens += hit;
    missTokens += miss;
    if (rate < lowHitThreshold) lowHitRequestCount += 1;
  }
  const totalTokens = hitTokens + missTokens;
  const hitRate = totalTokens > 0 ? hitTokens / totalTokens : 0;
  return {
    tracePath: cacheTracePath,
    ...(targetHitRate !== undefined ? { targetHitRate } : {}),
    hitTokens,
    missTokens,
    hitRate,
    requestCount,
    lowHitRequestCount,
    ...(targetHitRate !== undefined ? { passed: requestCount > 0 && hitRate >= targetHitRate } : {}),
    redaction: { class: "internal", fields: ["tracePath"] }
  };
}

function usageData(record: JsonObject): JsonObject | undefined {
  if (record.kind === "usage.updated" && isJsonObject(record.data)) return record.data;
  const event = record.event;
  if (isJsonObject(event) && event.kind === "usage.updated" && isJsonObject(event.data)) return event.data;
  return undefined;
}

function usageCache(data: JsonObject): JsonObject | undefined {
  const metadata = data.metadata;
  if (isJsonObject(metadata) && isJsonObject(metadata.cache)) return metadata.cache;
  return isJsonObject(data.cache) ? data.cache : undefined;
}

function countHarnessStatus(value: unknown): { readonly success: number; readonly failure: number } {
  if (!isJsonObject(value)) return { success: 0, failure: 0 };
  return {
    success: Array.isArray(value.success) ? value.success.length : 0,
    failure: Array.isArray(value.failure) ? value.failure.length : 0
  };
}

function harnessCommandPlan(options: CollectSweBenchPredictionOptions, command: string, args: readonly string[], reportDir: string): JsonObject {
  return {
    id: "swe-bench.harness",
    action: "run-official-harness",
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
  const args = [
    join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
    "--tsconfig",
    join(process.cwd(), "tsconfig.json"),
    join(process.cwd(), "src/apps/cli/src/index.ts"),
    "run",
    sweBenchPrompt(instance),
    "--output",
    "jsonl",
    "--live",
    "--tool-projection",
    "all",
    "--timeout-ms",
    String(options.timeoutMs ?? 15 * 60 * 1000),
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
    toolProjection: "all",
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
    "Problem statement:",
    instance.problemStatement,
    "",
    "Task:",
    "- Inspect the current repository checkout.",
    "- Make the smallest source change needed to resolve the problem.",
    "- Do not edit benchmark tests unless the repository already requires updating generated fixtures.",
    "- Run a focused relevant check if feasible.",
    "- Leave the repository with the fix applied.",
    "- Final answer exactly: SWE patch ready"
  ].filter((line): line is string => line !== undefined).join("\n");
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

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
