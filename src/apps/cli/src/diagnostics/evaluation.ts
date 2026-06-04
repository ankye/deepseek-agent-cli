import { join } from "node:path";
import type {
  CliEvaluationBaselineDefinition,
  CliEvaluationComparisonSummary,
  CliEvaluationDiagnostic,
  CliEvaluationMode,
  CliEvaluationPublicBenchmarkReference,
  CliEvaluationTaskDefinition,
  CliEvaluationTaskRunRecord,
  JsonObject,
  PlatformRuntime
} from "@deepseek/platform-contracts";
import type { ToolFamilyId, ToolFamilyParityMatrix } from "@deepseek/platform-contracts";
import { CLI_TASK_EVALUATION_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import { NodePlatformRuntime } from "@deepseek/platform-abstraction";
import { buildToolFamilyParityMatrix, coreCapabilityFamilyMappings } from "@deepseek/core-coding-tools";
import {
  aggregateBaselines,
  deriveGapFindings,
  emptyMetrics
} from "./evaluation-metrics.js";
import { executeEvaluationTask, shouldRetryEvaluationTask } from "./evaluation-task-execution.js";
import { collectPackageScorecards } from "./package-scorecard.js";
import { readLiveToolCoverageEvidence, type LiveToolCoverageRecord } from "./tool-live-coverage.js";

interface CatalogFile extends JsonObject {
  readonly catalogVersion?: string;
  readonly tasks?: readonly JsonObject[];
}

export interface CliEvaluationOptions {
  readonly mode: CliEvaluationMode;
  readonly dryRun: boolean;
  readonly live: boolean;
  readonly baselineId: string;
  readonly compareBaselineIds: readonly string[];
  readonly allowExternalBaseline: boolean;
  readonly baselineCommand?: string;
  readonly codexCommand?: string;
  readonly claudeCommand?: string;
  readonly executeTaskId?: string;
  readonly modelProvider?: "deepseek" | "glm";
  readonly model?: string;
  readonly baselineArgs: readonly string[];
  readonly extraArgs: readonly string[];
  readonly platform?: PlatformRuntime;
}

export const defaultEvaluationCatalogPath = "tests/evaluation/task-catalog.json";

export async function collectCliEvaluation(options: CliEvaluationOptions): Promise<CliEvaluationComparisonSummary> {
  const platform = options.platform ?? new NodePlatformRuntime();
  const catalog = await loadCatalog(platform);
  const requestedBaselineIds = requestedBaselines(options);
  const baselines = await Promise.all(requestedBaselineIds.map((baselineId) => baselineDefinition(platform, { ...options, baselineId })));
  if (options.extraArgs.length > 0) {
    return comparisonSummary(options, catalog.catalogVersion, baselines, [], [diagnostic("CLI_EVALUATION_INVALID_ARGS", "error", `diagnostics evaluate received ${options.extraArgs.length} unsupported argument(s).`)]);
  }
  const selectedTasks = catalog.tasks.filter((task) => options.mode === "full" || task.mode === "smoke");
  const runs: CliEvaluationTaskRunRecord[] = [];
  for (const baseline of baselines) {
    for (const task of selectedTasks) {
      runs.push(await taskRun(platform, task, baseline, options));
    }
  }
  const packageScorecards = await collectPackageScorecards(platform);
  const toolFamilyParityMatrix = await collectToolFamilyParityMatrix(platform);
  const diagnostics = [
    ...baselines
      .filter((baseline) => baseline.status !== "available")
      .map((baseline) => diagnostic("CLI_EVALUATION_BASELINE_DEFERRED", "warn", `${baseline.baselineId} baseline is ${baseline.status}; configure an adapter before comparing live task completion.`)),
    ...(options.executeTaskId && options.executeTaskId !== "all" && !selectedTasks.some((task) => task.taskId === options.executeTaskId)
      ? [diagnostic("CLI_EVALUATION_EXECUTE_TASK_NOT_SELECTED", "error", `${options.executeTaskId} is not selected by ${options.mode} evaluation mode.`)]
      : [])
  ];
  return comparisonSummary(options, catalog.catalogVersion, baselines, runs, diagnostics, packageScorecards, toolFamilyParityMatrix);
}

export function evaluationJsonLines(summary: CliEvaluationComparisonSummary): readonly JsonObject[] {
  return [
    {
      schemaVersion: summary.schemaVersion,
      kind: "diagnostics.evaluate.summary",
      summary,
      redaction: summary.redaction
    },
    ...summary.taskRuns.map((run) => ({
      schemaVersion: summary.schemaVersion,
      kind: "diagnostics.evaluate.task-run",
      run,
      redaction: run.redaction
    })),
    ...summary.taskRuns.flatMap((run) => run.instrumentationEvents.map((event) => ({
      schemaVersion: summary.schemaVersion,
      kind: "diagnostics.evaluate.instrumentation-event",
      event,
      redaction: event.redaction
    }))),
    ...summary.baselineAggregates.map((aggregate) => ({
      schemaVersion: summary.schemaVersion,
      kind: "diagnostics.evaluate.baseline-aggregate",
      aggregate,
      redaction: aggregate.redaction
    })),
    ...(summary.packageScorecardAggregate ? [{
      schemaVersion: summary.schemaVersion,
      kind: "diagnostics.evaluate.package-scorecard-aggregate",
      aggregate: summary.packageScorecardAggregate,
      redaction: summary.packageScorecardAggregate.redaction
    }] : []),
    ...(summary.packageScorecards ?? []).map((scorecard) => ({
      schemaVersion: summary.schemaVersion,
      kind: "diagnostics.evaluate.package-scorecard",
      scorecard,
      redaction: scorecard.redaction
    })),
    ...(summary.toolFamilyParityMatrix ? [{
      schemaVersion: summary.schemaVersion,
      kind: "diagnostics.evaluate.tool-family-parity",
      matrix: summary.toolFamilyParityMatrix,
      redaction: summary.toolFamilyParityMatrix.redaction
    }] : []),
    ...summary.gapFindings.map((finding) => ({
      schemaVersion: summary.schemaVersion,
      kind: "diagnostics.evaluate.gap-finding",
      finding,
      redaction: finding.redaction
    })),
    ...summary.diagnostics.map((item) => ({
      schemaVersion: summary.schemaVersion,
      kind: "diagnostics.evaluate.diagnostic",
      diagnostic: item,
      redaction: item.redaction
    }))
  ];
}

async function loadCatalog(platform: PlatformRuntime): Promise<{ readonly catalogVersion: string; readonly tasks: readonly CliEvaluationTaskDefinition[] }> {
  const raw = await platform.readFile(join(process.cwd(), defaultEvaluationCatalogPath)).catch(() => JSON.stringify(fallbackCatalog()));
  const parsed = JSON.parse(raw) as CatalogFile;
  const tasks = (parsed.tasks ?? []).map(taskDefinition);
  return {
    catalogVersion: typeof parsed.catalogVersion === "string" ? parsed.catalogVersion : "unknown",
    tasks
  };
}

function fallbackCatalog(): CatalogFile {
  return {
    schemaVersion: CLI_TASK_EVALUATION_SCHEMA_VERSION,
    catalogVersion: "fallback.missing-catalog",
    tasks: [{
      taskId: "eval.catalog.missing",
      title: "Evaluation catalog unavailable",
      category: "diagnostic",
      fixtureId: "fixture.eval.catalog.missing",
      workspaceSnapshotId: "snapshot.eval.missing",
      promptDigest: "sha256:eval-catalog-missing",
      promptSummary: "Run diagnostics evaluate from the repository root so tests/evaluation/task-catalog.json can be loaded.",
      allowedCapabilityProfile: "none",
      timeBudgetMs: 0,
      checkCommands: [],
      scoringRubricId: "rubric.eval.catalog-required",
      mode: "smoke"
    }]
  };
}

function taskDefinition(input: JsonObject): CliEvaluationTaskDefinition {
  return {
    schemaVersion: CLI_TASK_EVALUATION_SCHEMA_VERSION,
    taskId: stringField(input, "taskId"),
    title: stringField(input, "title"),
    category: stringField(input, "category"),
    fixtureId: stringField(input, "fixtureId"),
    workspaceSnapshotId: stringField(input, "workspaceSnapshotId"),
    promptDigest: stringField(input, "promptDigest"),
    promptSummary: stringField(input, "promptSummary"),
    allowedCapabilityProfile: stringField(input, "allowedCapabilityProfile"),
    timeBudgetMs: numberField(input, "timeBudgetMs"),
    checkCommands: stringArrayField(input, "checkCommands"),
    scoringRubricId: stringField(input, "scoringRubricId"),
    mode: input.mode === "full" ? "full" : "smoke",
    redaction: { class: "internal", fields: ["promptDigest", "workspaceSnapshotId"] }
  };
}

async function baselineDefinition(platform: PlatformRuntime, options: CliEvaluationOptions): Promise<CliEvaluationBaselineDefinition> {
  const baselineId = options.baselineId;
  if (baselineId === "deepseek-cli") {
    return {
      baselineId,
      label: "DeepSeek CLI",
      kind: "deepseek-cli",
      status: "available",
      versionCommand: "deepseek --version",
      configured: true,
      diagnostics: [],
      redaction: { class: "internal", fields: ["versionCommand"] }
    };
  }
  const knownExternal = baselineId === "claude-code" || baselineId === "codex";
  const command = externalBaselineCommand(options, baselineId);
  if (options.allowExternalBaseline && command) {
    return probeExternalBaseline(platform, baselineId, knownExternal, command, probeArgsFor(options, baselineId));
  }
  return {
    baselineId,
    label: knownExternal ? (baselineId === "claude-code" ? "Claude Code" : "Codex") : baselineId,
    kind: knownExternal ? "external-cli" : "manual-import",
    status: "deferred",
    configured: false,
    diagnostics: [diagnostic("CLI_EVALUATION_EXTERNAL_BASELINE_NOT_CONFIGURED", "warn", `${baselineId} is opt-in and has no configured adapter.`)],
    redaction: { class: "internal", fields: ["diagnostics.metadata"] }
  };
}

function requestedBaselines(options: CliEvaluationOptions): readonly string[] {
  const ids = options.compareBaselineIds.length > 0 ? options.compareBaselineIds : [options.baselineId];
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function externalBaselineCommand(options: CliEvaluationOptions, baselineId: string): string | undefined {
  if (baselineId === "codex") return options.codexCommand ?? options.baselineCommand;
  if (baselineId === "claude-code") return options.claudeCommand ?? options.baselineCommand;
  return options.baselineCommand;
}

function probeArgsFor(options: CliEvaluationOptions, baselineId: string): readonly string[] {
  if (options.baselineArgs.length > 0) return options.baselineArgs;
  return baselineId === "claude-code" ? ["--version"] : ["--version"];
}

async function probeExternalBaseline(
  platform: PlatformRuntime,
  baselineId: string,
  knownExternal: boolean,
  command: string,
  args: readonly string[]
): Promise<CliEvaluationBaselineDefinition> {
  const probeArgs = args.length > 0 ? args : ["--version"];
  const result = await platform.runProcess(command, probeArgs, { cwd: process.cwd() });
  const ok = result.exitCode === 0;
  const probeOutputPreview = boundedPreview([result.stdout, result.stderr].filter(Boolean).join("\n"));
  const diagnostics = ok
    ? [diagnostic("CLI_EVALUATION_EXTERNAL_BASELINE_PROBED", "info", `${baselineId} external baseline probe completed.`)]
    : [diagnostic("CLI_EVALUATION_EXTERNAL_BASELINE_PROBE_FAILED", "warn", `${baselineId} external baseline probe failed with exit code ${result.exitCode}.`)];
  return {
    baselineId,
    label: knownExternal ? (baselineId === "claude-code" ? "Claude Code" : "Codex") : baselineId,
    kind: knownExternal ? "external-cli" : "manual-import",
    status: ok ? "available" : "unavailable",
    versionCommand: [command, ...probeArgs].join(" "),
    commandFingerprint: commandFingerprint(command, probeArgs),
    probeExitCode: result.exitCode,
    probeOutputPreview,
    configured: true,
    diagnostics,
    redaction: { class: "internal", fields: ["versionCommand", "commandFingerprint", "probeOutputPreview", "diagnostics.metadata"] }
  };
}

function plannedRun(task: CliEvaluationTaskDefinition, baseline: CliEvaluationBaselineDefinition, dryRun: boolean): CliEvaluationTaskRunRecord {
  const deferred = baseline.status !== "available";
  return {
    schemaVersion: CLI_TASK_EVALUATION_SCHEMA_VERSION,
    kind: "cli.evaluation.task-run",
    runId: `eval:${baseline.baselineId}:${task.taskId}`,
    task,
    baseline,
    dryRun,
    outcome: deferred ? "deferred" : "planned",
    checks: task.checkCommands.map((command) => ({
      command,
      status: "skipped",
      redaction: { class: "internal", fields: ["command"] }
    })),
    metrics: emptyMetrics(),
    instrumentationEvents: [],
    diagnostics: deferred ? baseline.diagnostics : [],
    evidencePaths: [],
    redaction: { class: "internal", fields: ["task.promptDigest", "checks.command", "evidencePaths"] }
  };
}

async function taskRun(
  platform: PlatformRuntime,
  task: CliEvaluationTaskDefinition,
  baseline: CliEvaluationBaselineDefinition,
  options: CliEvaluationOptions
): Promise<CliEvaluationTaskRunRecord> {
  const shouldExecute = !options.dryRun && (options.executeTaskId === task.taskId || options.executeTaskId === "all") && baseline.status === "available";
  if (!shouldExecute) return plannedRun(task, baseline, options.dryRun);
  const execute = () => executeEvaluationTask(platform, task, baseline, options);
  const first = await execute();
  if (!shouldRetryEvaluationTask(first, baseline, options)) return first;
  const second = await execute();
  return {
    ...second,
    metrics: {
      ...second.metrics,
      retryCount: (first.metrics.retryCount ?? 0) + (second.metrics.retryCount ?? 0) + 1
    },
    diagnostics: [
      diagnostic("CLI_EVALUATION_TASK_RETRIED", "info", `${baseline.baselineId} retried ${task.taskId} after first attempt outcome ${first.outcome}.`),
      ...second.diagnostics
    ],
    evidencePaths: [...first.evidencePaths, ...second.evidencePaths],
    redaction: { class: "internal", fields: ["task.promptDigest", "checks.command", "checks.evidencePath", "checks.stdoutPreview", "checks.stderrPreview", "instrumentationEvents.metadata", "evidencePaths", "diagnostics.metadata"] }
  };
}

function comparisonSummary(
  options: CliEvaluationOptions,
  taskCatalogVersion: string,
  baselines: readonly CliEvaluationBaselineDefinition[],
  taskRuns: readonly CliEvaluationTaskRunRecord[],
  diagnostics: readonly CliEvaluationDiagnostic[],
  packageScorecards?: Awaited<ReturnType<typeof collectPackageScorecards>>,
  toolFamilyParityMatrix?: ToolFamilyParityMatrix
): CliEvaluationComparisonSummary {
  const hasError = diagnostics.some((item) => item.severity === "error");
  const hasWarn = diagnostics.some((item) => item.severity === "warn") || baselines.some((baseline) => baseline.status !== "available");
  const baselineAggregates = aggregateBaselines(taskRuns);
  const gapFindings = deriveGapFindings(baselineAggregates);
  return {
    schemaVersion: CLI_TASK_EVALUATION_SCHEMA_VERSION,
    kind: "cli.evaluation.comparison.summary",
    status: hasError ? "fail" : hasWarn ? "warn" : "pass",
    mode: options.mode,
    dryRun: options.dryRun,
    taskCatalogVersion,
    reportTimestamp: "1970-01-01T00:00:00.000Z",
    baselines,
    taskRuns,
    baselineAggregates,
    ...(packageScorecards ? {
      packageScorecardCatalogVersion: packageScorecards.catalogVersion,
      packageScorecards: packageScorecards.scorecards,
      packageScorecardAggregate: packageScorecards.aggregate
    } : {}),
    ...(toolFamilyParityMatrix ? { toolFamilyParityMatrix } : {}),
    gapFindings,
    publicBenchmarkReferences: publicBenchmarkReferences(),
    evidencePaths: [],
    diagnostics,
    nextAction: hasError
      ? "Remove unsupported arguments, then rerun diagnostics evaluate."
      : hasWarn
        ? "Configure opt-in external baseline adapters before making competitive claims."
        : options.executeTaskId
          ? "Inspect baseline gap findings, then expand the task catalog before making product claims."
          : "Run diagnostics evaluate --full --execute-task all --live to prove all delivery evaluation tasks.",
    redaction: { class: "internal", fields: ["taskRuns.task.promptDigest", "publicBenchmarkReferences.url", "evidencePaths", "gapFindings.message"] }
  };
}

export async function collectToolFamilyParityMatrix(platform: PlatformRuntime): Promise<ToolFamilyParityMatrix> {
  const liveCoverage = await readLiveToolCoverageEvidence(platform, process.cwd());
  const familyByCapability = new Map(
    coreCapabilityFamilyMappings().map((mapping) => [String(mapping.capabilityId), mapping.familyId as ToolFamilyId])
  );
  const passedRecords = (liveCoverage?.records ?? []).filter((record) => record.status === "pass");
  const liveCoveredFamilyIds = passedRecords
    .map((record) => liveCoverageFamilyId(record, familyByCapability))
    .filter((familyId): familyId is ToolFamilyId => familyId !== undefined);
  const taskCoveredFamilyIds = passedRecords
    .filter((record) => evidenceStatus(record.taskOutcome) === "pass")
    .map((record) => liveCoverageFamilyId(record, familyByCapability))
    .filter((familyId): familyId is ToolFamilyId => familyId !== undefined);
  const safetyCoveredFamilyIds = passedRecords
    .filter((record) => evidenceStatus(record.safetyOutcome) === "pass")
    .map((record) => liveCoverageFamilyId(record, familyByCapability))
    .filter((familyId): familyId is ToolFamilyId => familyId !== undefined);
  const providerNativeSupportedFamilyIds = passedRecords
    .filter((record) => evidenceStatus(record.providerNative) === "native")
    .map((record) => liveCoverageFamilyId(record, familyByCapability))
    .filter((familyId): familyId is ToolFamilyId => familyId !== undefined);
  return buildToolFamilyParityMatrix({
    liveCoveredFamilyIds,
    taskCoveredFamilyIds,
    safetyCoveredFamilyIds,
    providerNativeSupportedFamilyIds
  });
}

function liveCoverageFamilyId(
  record: LiveToolCoverageRecord,
  familyByCapability: ReadonlyMap<string, ToolFamilyId>
): ToolFamilyId | undefined {
  return record.familyId ?? familyByCapability.get(record.toolId);
}

function evidenceStatus(value: JsonObject | undefined): string {
  return typeof value?.status === "string" ? value.status : "";
}

function publicBenchmarkReferences(): readonly CliEvaluationPublicBenchmarkReference[] {
  return [
    {
      name: "SWE-bench Verified",
      url: "https://www.swebench.com/",
      observedAt: "2026-05-13",
      note: "Advisory public benchmark reference; not a substitute for DeepSeek-owned CLI product evidence.",
      advisoryOnly: true,
      redaction: { class: "public" }
    },
    {
      name: "Terminal-Bench",
      url: "https://www.tbench.ai/",
      observedAt: "2026-05-13",
      note: "Advisory terminal-agent benchmark reference; local product claims require replayable internal evidence.",
      advisoryOnly: true,
      redaction: { class: "public" }
    }
  ];
}

function diagnostic(code: string, severity: CliEvaluationDiagnostic["severity"], message: string): CliEvaluationDiagnostic {
  return {
    code,
    severity,
    message,
    metadata: {},
    redaction: { class: "internal", fields: ["metadata"] }
  };
}

function commandFingerprint(command: string, args: readonly string[]): string {
  return `cmd:${hashText([command, ...args].join("\u0000"))}`;
}

function hashText(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

function boundedPreview(value: string): string {
  const normalized = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  return normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
}

function stringField(input: JsonObject, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function numberField(input: JsonObject, key: string): number {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringArrayField(input: JsonObject, key: string): readonly string[] {
  const value = input[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
