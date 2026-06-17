import { dirname } from "node:path";
import { MAX_EXECUTION_TIMEOUT_MS, asId } from "@deepseek/platform-contracts";
import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  PlatformRuntime,
  ProcessResult,
  RuntimeDependencies,
  SerializableResult
} from "@deepseek/platform-contracts";
import { createDiagnosticsEnvironmentPresenceEnv } from "@deepseek/credential-auth-management";
import { redactJsonSecrets } from "@deepseek/policy-sandbox";
import { boundedText, defineToolManifest, objectSchema, replay } from "@deepseek/core-coding-tools";
import { prepareDiagnosticsEnvironment } from "../diagnostics/environment-prepare.js";
import type { DiagnosticsEnvironmentPrepareSummary } from "../diagnostics/environment-prepare.js";
import { evaluateAgenticEvaluationBlockers } from "../diagnostics/agentic-evaluation-blockers.js";
import { readSweBenchCacheTrace } from "../diagnostics/swe-bench-cache-trace.js";
import type { SweBenchEvaluationCacheSummary } from "../diagnostics/swe-bench-cache-trace.js";
import { summarizeSweBenchChildTrace } from "../diagnostics/swe-bench-child-trace.js";
import type { SweBenchChildTraceSummary } from "../diagnostics/swe-bench-child-trace.js";
import { collectSweBenchPrediction, sweBenchCacheDiagnostics } from "../diagnostics/swe-bench-prediction.js";
import type { SweBenchHarnessFailureExcerpt, SweBenchPredictionSummary, SweBenchRepairContext } from "../diagnostics/swe-bench-prediction.js";

export interface CliSweBenchRunCapabilityOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: PlatformRuntime;
}

interface SweBenchDatasetInstance {
  readonly instanceId: string;
  readonly repo: string;
  readonly baseCommit: string;
  readonly problemStatement: string;
}

interface SweBenchRunSummary extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly kind: "capability.swe-bench.run.summary";
  readonly status: "pass" | "warn" | "fail";
  readonly taskNumber: number;
  readonly taskNumbers?: readonly number[];
  readonly runId: string;
  readonly dryRun: boolean;
  readonly execute: boolean;
  readonly provider: "deepseek" | "glm";
  readonly model: string;
  readonly instanceId?: string;
  readonly environmentStatus?: string;
  readonly predictionStatus?: string;
  readonly evaluationStatus?: string;
  readonly evaluationResolved?: boolean;
  readonly evaluationResolvedRate?: number;
  readonly failToPassFailureCount?: number;
  readonly passToPassFailureCount?: number;
  readonly providerCacheHitRate?: number;
  readonly providerCacheRequestCount?: number;
  readonly providerCachePassed?: boolean;
  readonly contextProjectionCacheHitRate?: number;
  readonly contextProjectionCacheRequestCount?: number;
  readonly reviewCodes?: readonly string[];
  readonly reasonCodes?: readonly string[];
  readonly primaryReasonCode?: string;
  readonly failureCategory?: string;
  readonly actionability?: string;
  readonly blockerIds?: readonly string[];
  readonly childTerminalKind?: string;
  readonly childTerminalStatus?: string;
  readonly childTerminalReason?: string;
  readonly childIterationCount?: number;
  readonly childModelRequestCount?: number;
  readonly childToolIntentCount?: number;
  readonly childSourceInspectionToolCount?: number;
  readonly childSourceMutationCount?: number;
  readonly childShellCommandCount?: number;
  readonly childTestCommandCount?: number;
  readonly childSuccessfulTestCommandCount?: number;
  readonly verificationCommandMissing?: boolean;
  readonly patchBytes?: number;
  readonly attemptCount?: number;
  readonly repairAttempted?: boolean;
  readonly batch?: SweBenchRunBatchSummary;
  readonly children?: readonly SweBenchRunSummary[];
  readonly commandCount: number;
  readonly diagnostics: readonly JsonObject[];
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

interface SweBenchRunBatchSummary extends JsonObject {
  readonly totalTasks: number;
  readonly completedTasks: number;
  readonly resolvedTasks: number;
  readonly unresolvedTasks: number;
  readonly failedTasks: number;
  readonly skippedTasks: number;
  readonly resolvedRate: number;
  readonly completedResolvedRate: number;
  readonly taskNumbers: readonly number[];
  readonly resolvedTaskNumbers: readonly number[];
  readonly unresolvedTaskNumbers: readonly number[];
  readonly failedTaskNumbers: readonly number[];
  readonly skippedTaskNumbers: readonly number[];
  readonly resumedTaskNumbers?: readonly number[];
  readonly taskStates: readonly SweBenchRunTaskState[];
  readonly providerCacheHitRate?: number;
  readonly providerCacheRequestCount?: number;
  readonly providerCachePassed?: boolean;
  readonly contextProjectionCacheHitRate?: number;
  readonly contextProjectionCacheRequestCount?: number;
  readonly reviewCodes?: readonly string[];
}

interface SweBenchRunTaskState extends JsonObject {
  readonly taskNumber: number;
  readonly runId: string;
  readonly status: "pending" | "resolved" | "unresolved" | "failed" | "skipped";
  readonly evaluationResolved?: boolean;
  readonly attemptCount?: number;
  readonly resumedFromSummary?: boolean;
  readonly reasonCodes?: readonly string[];
  readonly primaryReasonCode?: string;
  readonly failureCategory?: string;
  readonly actionability?: string;
  readonly blockerIds?: readonly string[];
}

type SweBenchFailureAttribution = Pick<
  SweBenchRunTaskState,
  "reasonCodes" | "primaryReasonCode" | "failureCategory" | "actionability" | "blockerIds"
>;

const SWE_BENCH_BATCH_SUCCESS_THRESHOLD = 0.8;
const SWE_BENCH_PROVIDER_CACHE_THRESHOLD = 0.9;
const SWE_BENCH_BATCH_BACKPRESSURE_MIN_COMPLETED = 3;
const SWE_BENCH_FLOW_MODEL_REQUEST_BUDGET = 12;
const SWE_BENCH_BATCH_BACKPRESSURE_NEXT_ALLOWED_ACTIONS = [
  "review-only-evidence-refresh",
  "framework-cache-environment-fix",
  "single-failed-task-canary-after-fix"
] as const;
const sweBenchRunCapabilityId = asId<"capability">("core.swe.bench.run");
let sweBenchHarnessRunSequence = 0;

export async function registerCliSweBenchRunCapabilities(
  deps: Pick<RuntimeDependencies, "capabilities" | "platform">,
  workspaceRoot: string,
  options: CliSweBenchRunCapabilityOptions = {}
): Promise<void> {
  if (await deps.capabilities.get(sweBenchRunCapabilityId)) return;
  const platform = options.platform ?? deps.platform;
  const env = createDiagnosticsEnvironmentPresenceEnv(options.env);
  const definition = defineToolManifest(
    "swe.bench.run",
    sweBenchRunCapabilityId,
    "SWE-bench Run",
    "process",
    ["process:run", "evaluation:swe-bench"],
    objectSchema([], {
      taskNumber: { type: "number" },
      taskNumbers: { type: "array" },
      execute: { type: "boolean" },
      dryRun: { type: "boolean" },
      resume: { type: "boolean" },
      resumeOnly: { type: "boolean" },
      provider: { type: "string", enum: ["deepseek", "glm"] },
      model: { type: "string" },
      runId: { type: "string" },
      timeoutMs: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    async (input, context) => {
      const taskNumbers = taskNumbersFromInput(input);
      if (taskNumbers.length === 0) return invalidResult(input, context);
      const execute = input.dryRun === true || input.execute === false ? false : true;
      const dryRun = input.dryRun === true || !execute;
      const provider = input.provider === "deepseek" ? "deepseek" : "glm";
      const model = stringField(input, "model") ?? (provider === "glm" ? "glm-5.1" : "deepseek-cli");
      const explicitRunId = stringField(input, "runId");
      const resumeOnly = input.resumeOnly === true;
      const resume = input.resume === true || resumeOnly;
      const runId = sanitizeRunId(explicitRunId ?? defaultRunIdForInvocation(taskNumbers, resume));
      const timeoutMs = governedSweBenchRunTimeout();
      const common: {
        readonly platform: PlatformRuntime;
        readonly workspaceRoot: string;
        readonly env: Readonly<Record<string, string | undefined>>;
        readonly runId: string;
        readonly dryRun: boolean;
        readonly execute: boolean;
        readonly provider: "deepseek" | "glm";
        readonly model: string;
        readonly timeoutMs: number;
      } = {
        platform,
        workspaceRoot,
        env,
        runId,
        dryRun,
        execute,
        provider,
        model,
        timeoutMs
      };
      if (taskNumbers.length === 1 && resumeOnly) {
        const summary = await runSweBenchSingleReviewOnlyCapability({
          ...common,
          taskNumber: taskNumbers[0] as number
        });
        return resultFromSummary(summary, context);
      }
      const summary = taskNumbers.length === 1
        ? await runSweBenchSingleExecutionCapability({ ...common, taskNumber: taskNumbers[0] as number })
        : await runSweBenchBatchCapability({
            ...common,
            taskNumbers,
            resume,
            resumeOnly
          });
      return resultFromSummary(summary, context);
    },
    { timeoutMs: 7_200_000, replayPolicy: { replayable: false, snapshot: "swe-bench-run-evidence", deterministic: false } }
  );
  await deps.capabilities.register({
    ...definition.manifest,
    description: "Run a governed SWE-bench Lite numbered task through run-scoped environment preparation, checkout binding, prediction, trace, and redacted evidence. Provide only taskNumber and execute/dryRun intent."
  }, definition.execute);
}

async function runSweBenchSingleExecutionCapability(input: {
  readonly platform: PlatformRuntime;
  readonly workspaceRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly taskNumber: number;
  readonly runId: string;
  readonly dryRun: boolean;
  readonly execute: boolean;
  readonly provider: "deepseek" | "glm";
  readonly model: string;
  readonly timeoutMs: number;
}): Promise<SweBenchRunSummary> {
  if (!input.dryRun && input.execute) {
    const blocked = await singleTaskBackpressureBlockSummary(input);
    if (blocked) return blocked;
  }
  return runSweBenchCapability(input);
}

interface SingleTaskBackpressureEvidence {
  readonly sourceRunId: string;
  readonly sourceSummaryPath: string;
  readonly sourceSummaryMtimeMs: number;
  readonly blockedExpansionTaskNumbers: readonly number[];
  readonly canaryCandidateTaskNumbers: readonly number[];
  readonly nextAllowedActions: readonly string[];
  readonly rampStatus?: string;
  readonly completedTasks?: number;
  readonly resolvedTasks?: number;
  readonly completedResolvedRate?: number;
  readonly providerCacheHitRate?: number;
  readonly providerCacheRequestCount?: number;
}

async function singleTaskBackpressureBlockSummary(input: {
  readonly platform: PlatformRuntime;
  readonly workspaceRoot: string;
  readonly taskNumber: number;
  readonly runId: string;
  readonly dryRun: boolean;
  readonly execute: boolean;
  readonly provider: "deepseek" | "glm";
  readonly model: string;
}): Promise<SweBenchRunSummary | undefined> {
  const evidence = await latestRelevantBatchBackpressureEvidence(input.platform, input.workspaceRoot, input.taskNumber);
  if (!evidence) return undefined;
  const primaryReasonCode = "BATCH_PENDING_GOVERNANCE_BACKPRESSURE";
  const diagnostics: JsonObject[] = [
    {
      code: "SWE_BENCH_RAMP_BACKPRESSURE_EXPANSION_BLOCKED",
      severity: "warn",
      message: "Direct single-task SWE-bench execution was paused because the latest relevant governed batch backpressure evidence lists this task as blocked expansion.",
      metadata: {
        taskNumber: input.taskNumber,
        sourceRunId: evidence.sourceRunId,
        sourceSummaryPath: evidence.sourceSummaryPath,
        sourceSummaryMtimeMs: evidence.sourceSummaryMtimeMs,
        ...(evidence.completedTasks !== undefined ? { completedTasks: evidence.completedTasks } : {}),
        ...(evidence.resolvedTasks !== undefined ? { resolvedTasks: evidence.resolvedTasks } : {}),
        ...(evidence.completedResolvedRate !== undefined ? { completedResolvedRate: evidence.completedResolvedRate } : {}),
        ...(evidence.providerCacheHitRate !== undefined ? { providerCacheHitRate: evidence.providerCacheHitRate } : {}),
        ...(evidence.providerCacheRequestCount !== undefined ? { providerCacheRequestCount: evidence.providerCacheRequestCount } : {}),
        blockedExpansionTaskNumbers: evidence.blockedExpansionTaskNumbers,
        canaryCandidateTaskNumbers: evidence.canaryCandidateTaskNumbers,
        nextAllowedActions: evidence.nextAllowedActions,
        rampStatus: evidence.rampStatus ?? "blocked"
      },
      redaction: { class: "internal", fields: ["metadata"] }
    }
  ];
  const runRoot = input.platform.resolvePath(input.workspaceRoot, ".deepseek", "swe-lite-runs", input.runId);
  await input.platform.ensureDirectory(runRoot);
  const runSummary: SweBenchRunSummary = {
    schemaVersion: "1.0.0",
    kind: "capability.swe-bench.run.summary",
    status: "warn",
    taskNumber: input.taskNumber,
    runId: input.runId,
    dryRun: input.dryRun,
    execute: false,
    provider: input.provider,
    model: input.model,
    evaluationResolved: false,
    ...(evidence.providerCacheHitRate !== undefined ? { providerCacheHitRate: evidence.providerCacheHitRate } : {}),
    ...(evidence.providerCacheRequestCount !== undefined ? { providerCacheRequestCount: evidence.providerCacheRequestCount } : {}),
    reviewCodes: ["SWE_BENCH_BATCH_BACKPRESSURE_ACTIVE", "SWE_BENCH_RAMP_BACKPRESSURE_EXPANSION_BLOCKED"],
    reasonCodes: [primaryReasonCode],
    primaryReasonCode,
    failureCategory: failureCategoryForReasonCode(primaryReasonCode),
    actionability: actionabilityForReasonCode(primaryReasonCode),
    commandCount: 0,
    diagnostics,
    redaction: { class: "internal", fields: ["diagnostics.metadata"] }
  };
  await persistSummary(input.platform, runSummaryPath(input.platform, input.workspaceRoot, input.runId), runSummary, diagnostics);
  return runSummary;
}

async function latestRelevantBatchBackpressureEvidence(
  platform: PlatformRuntime,
  workspaceRoot: string,
  taskNumber: number
): Promise<SingleTaskBackpressureEvidence | undefined> {
  const runRoot = platform.resolvePath(workspaceRoot, ".deepseek", "swe-lite-runs");
  const files = await platform.findFiles("batch-summary.json", runRoot).catch(() => []);
  const candidates = await Promise.all(files
    .filter((path) => normalizedPath(path).endsWith("/batch-summary.json"))
    .map(async (path) => ({
      path,
      mtimeMs: await statFileMtimeMs(platform, path)
    })));
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
  for (const candidate of candidates) {
    const content = await platform.readFile(candidate.path).catch(() => "");
    const parsed = parseJsonObject(content);
    if (!parsed || !batchSummaryMentionsTask(parsed, taskNumber)) continue;
    return backpressureEvidenceFromBatchSummary(parsed, candidate.path, candidate.mtimeMs, taskNumber);
  }
  return undefined;
}

function backpressureEvidenceFromBatchSummary(
  summary: JsonObject,
  sourceSummaryPath: string,
  sourceSummaryMtimeMs: number,
  taskNumber: number
): SingleTaskBackpressureEvidence | undefined {
  for (const diagnostic of diagnosticsFromSummary(summary)) {
    if (diagnostic.code !== "SWE_BENCH_BATCH_BACKPRESSURE_ACTIVE") continue;
    const metadata = isJsonObject(diagnostic.metadata) ? diagnostic.metadata : {};
    const blockedExpansionTaskNumbers = nonEmptyNumberArrayField(metadata, "blockedExpansionTaskNumbers")
      ?? nonEmptyNumberArrayField(metadata, "pendingTaskNumbers")
      ?? [];
    if (!blockedExpansionTaskNumbers.includes(taskNumber)) return undefined;
    const rampStatus = stringField(metadata, "rampStatus");
    const completedTasks = numberField(metadata, "completedTasks");
    const resolvedTasks = numberField(metadata, "resolvedTasks");
    const completedResolvedRate = numberField(metadata, "completedResolvedRate");
    const providerCacheHitRate = numberField(metadata, "providerCacheHitRate");
    const providerCacheRequestCount = numberField(metadata, "providerCacheRequestCount");
    return {
      sourceRunId: stringField(summary, "runId") ?? runIdFromBatchSummaryPath(sourceSummaryPath),
      sourceSummaryPath,
      sourceSummaryMtimeMs,
      blockedExpansionTaskNumbers,
      canaryCandidateTaskNumbers: nonEmptyNumberArrayField(metadata, "canaryCandidateTaskNumbers") ?? [],
      nextAllowedActions: stringArrayField(metadata, "nextAllowedActions"),
      ...(rampStatus !== undefined ? { rampStatus } : {}),
      ...(completedTasks !== undefined ? { completedTasks } : {}),
      ...(resolvedTasks !== undefined ? { resolvedTasks } : {}),
      ...(completedResolvedRate !== undefined ? { completedResolvedRate } : {}),
      ...(providerCacheHitRate !== undefined ? { providerCacheHitRate } : {}),
      ...(providerCacheRequestCount !== undefined ? { providerCacheRequestCount } : {})
    };
  }
  return undefined;
}

function batchSummaryMentionsTask(summary: JsonObject, taskNumber: number): boolean {
  const batch = isJsonObject(summary.batch) ? summary.batch : {};
  const summaryTaskNumbers = [
    ...numberArrayField(summary, "taskNumbers"),
    ...numberArrayField(batch, "taskNumbers")
  ];
  if (summaryTaskNumbers.includes(taskNumber)) return true;
  for (const diagnostic of diagnosticsFromSummary(summary)) {
    const metadata = isJsonObject(diagnostic.metadata) ? diagnostic.metadata : {};
    if (numberArrayField(metadata, "blockedExpansionTaskNumbers").includes(taskNumber)) return true;
    if (numberArrayField(metadata, "pendingTaskNumbers").includes(taskNumber)) return true;
  }
  return false;
}

async function runSweBenchSingleReviewOnlyCapability(input: {
  readonly platform: PlatformRuntime;
  readonly workspaceRoot: string;
  readonly taskNumber: number;
  readonly runId: string;
  readonly dryRun: boolean;
  readonly execute: boolean;
  readonly provider: "deepseek" | "glm";
  readonly model: string;
}): Promise<SweBenchRunSummary> {
  const diagnostics: JsonObject[] = [];
  const summaryPath = runSummaryPath(input.platform, input.workspaceRoot, input.runId);
  const existing = await readExistingResumableSummary(input.platform, summaryPath, diagnostics);
  if (existing) return existing;
  const recovered = await recoverPartialRunSummaryFromArtifacts({
    platform: input.platform,
    workspaceRoot: input.workspaceRoot,
    summaryPath,
    taskNumber: input.taskNumber,
    runId: input.runId,
    dryRun: input.dryRun,
    execute: input.execute,
    provider: input.provider,
    model: input.model,
    diagnostics
  });
  if (recovered) {
    await persistSummary(input.platform, summaryPath, recovered, diagnostics);
    return recovered;
  }
  return {
    schemaVersion: "1.0.0",
    kind: "capability.swe-bench.run.summary",
    status: "fail",
    taskNumber: input.taskNumber,
    runId: input.runId,
    dryRun: input.dryRun,
    execute: false,
    provider: input.provider,
    model: input.model,
    commandCount: 0,
    diagnostics: [
      ...diagnostics,
      {
        code: "SWE_BENCH_RESUME_ONLY_SUMMARY_MISSING",
        severity: "error",
        message: "Single-task resumeOnly review requested an existing SWE-bench summary, but no resumable summary was found.",
        metadata: { summaryPath },
        redaction: { class: "internal", fields: ["metadata"] }
      }
    ],
    redaction: { class: "internal", fields: ["diagnostics.metadata"] }
  };
}

async function runSweBenchBatchCapability(input: {
  readonly platform: PlatformRuntime;
  readonly workspaceRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly taskNumbers: readonly number[];
  readonly runId: string;
  readonly dryRun: boolean;
  readonly execute: boolean;
  readonly provider: "deepseek" | "glm";
  readonly model: string;
  readonly timeoutMs: number;
  readonly resume: boolean;
  readonly resumeOnly: boolean;
}): Promise<SweBenchRunSummary> {
  const diagnostics: JsonObject[] = [];
  const runRoot = input.platform.resolvePath(input.workspaceRoot, ".deepseek", "swe-lite-runs", input.runId);
  await input.platform.ensureDirectory(runRoot);

  if (input.dryRun) {
    const batch = batchSummary(input.taskNumbers, [], [], []);
    return batchRunSummary(input, diagnostics, batch, [], 0, "warn");
  }

  const children: SweBenchRunSummary[] = [];
  const skippedTaskNumbers: number[] = [];
  let commandCount = 0;
  for (const taskNumber of input.taskNumbers) {
    const childRunId = batchTaskRunId(input.runId, taskNumber);
    const childSummaryPath = runSummaryPath(input.platform, input.workspaceRoot, childRunId);
    if (input.resume) {
      const existing = await readExistingResumableSummary(input.platform, childSummaryPath, diagnostics);
      if (existing) {
        children.push(existing);
        skippedTaskNumbers.push(taskNumber);
        continue;
      }
    }
    if (input.resumeOnly) continue;
    const progress = batchSummary(input.taskNumbers, children, skippedTaskNumbers, diagnostics, input.resumeOnly);
    const backpressure = batchBackpressureFinding(progress);
    if (backpressure) {
      diagnostics.push(backpressure);
      await persistBatchProgress(input.platform, runRoot, input, diagnostics, children, skippedTaskNumbers, commandCount);
      break;
    }
    const child = await runSweBenchCapability({
      platform: input.platform,
      workspaceRoot: input.workspaceRoot,
      env: input.env,
      taskNumber,
      runId: childRunId,
      dryRun: input.dryRun,
      execute: input.execute,
      provider: input.provider,
      model: input.model,
      timeoutMs: input.timeoutMs
    });
    children.push(child);
    commandCount += child.commandCount;
    await persistSummary(input.platform, childSummaryPath, child, diagnostics);
    await persistBatchProgress(input.platform, runRoot, input, diagnostics, children, skippedTaskNumbers, commandCount);
  }

  let batch = batchSummary(input.taskNumbers, children, skippedTaskNumbers, diagnostics, input.resumeOnly);
  const finalBackpressure = batchBackpressureFinding(batch);
  if (finalBackpressure && !diagnostics.some((entry) => entry.code === "SWE_BENCH_BATCH_BACKPRESSURE_ACTIVE")) {
    diagnostics.push(finalBackpressure);
    batch = batchSummary(input.taskNumbers, children, skippedTaskNumbers, diagnostics, input.resumeOnly);
  }
  if (batch.unresolvedTasks > 0 || batch.failedTasks > 0) {
    diagnostics.push({
      code: "SWE_BENCH_BATCH_UNRESOLVED",
      severity: batch.failedTasks > 0 ? "error" : "warn",
      message: "SWE-bench batch did not resolve every requested task.",
      metadata: {
        totalTasks: batch.totalTasks,
        resolvedTasks: batch.resolvedTasks,
        unresolvedTaskNumbers: batch.unresolvedTaskNumbers,
        failedTaskNumbers: batch.failedTaskNumbers,
        skippedTaskNumbers: batch.skippedTaskNumbers,
        resolvedRate: batch.resolvedRate
      },
      redaction: { class: "internal", fields: ["metadata"] }
    });
  }
  const status = batch.failedTasks > 0 || diagnostics.some((entry) => entry.severity === "error")
    ? "fail"
    : batch.unresolvedTasks > 0 || diagnostics.some((entry) => entry.severity === "warn")
      ? "warn"
      : "pass";
  const summary = batchRunSummary(input, diagnostics, batch, children, commandCount, status);
  await persistSummary(input.platform, input.platform.resolvePath(runRoot, "batch-summary.json"), summary, diagnostics);
  return summary;
}

async function runSweBenchCapability(input: {
  readonly platform: PlatformRuntime;
  readonly workspaceRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly taskNumber: number;
  readonly runId: string;
  readonly dryRun: boolean;
  readonly execute: boolean;
  readonly provider: "deepseek" | "glm";
  readonly model: string;
  readonly timeoutMs: number;
}): Promise<SweBenchRunSummary> {
  const diagnostics: JsonObject[] = [];
  const runRoot = input.platform.resolvePath(input.workspaceRoot, ".deepseek", "swe-lite-runs", input.runId);
  const persistAndReturn = async (runSummary: SweBenchRunSummary): Promise<SweBenchRunSummary> => {
    await persistSummary(input.platform, runSummaryPath(input.platform, input.workspaceRoot, input.runId), runSummary, diagnostics);
    await persistRunProgress(input.platform, runRoot, input.runId, input.taskNumber, "summary.persisted", "completed", diagnostics);
    return runSummary;
  };
  if (input.dryRun) {
    return summary({
      input,
      diagnostics,
      commandCount: 0,
      status: "warn"
    });
  }

  await input.platform.ensureDirectory(runRoot);
  await persistRunProgress(input.platform, runRoot, input.runId, input.taskNumber, "environment.prepare", "started", diagnostics);
  const environment = await prepareDiagnosticsEnvironment({
    profileId: "swe-bench-lite",
    action: "prepare",
    dryRun: false,
    execute: true,
    extraArgs: [],
    platform: input.platform,
    cwd: input.workspaceRoot,
    env: input.env
  });
  pushEnvironmentDiagnostics(diagnostics, environment);
  await persistRunProgress(input.platform, runRoot, input.runId, input.taskNumber, "environment.prepare", environment.status === "fail" ? "failed" : "completed", diagnostics);
  if (environment.status === "fail") {
    return persistAndReturn(summary({
      input,
      diagnostics,
      environmentStatus: environment.status,
      commandCount: environment.executedSteps.length,
      status: "fail"
    }));
  }

  const repoDir = input.platform.resolvePath(runRoot, "repo");
  const instanceFile = input.platform.resolvePath(runRoot, "instance.json");
  const outputPath = input.platform.resolvePath(runRoot, "prediction.jsonl");
  const latestTraceOutputPath = input.platform.resolvePath(runRoot, "trace.jsonl");
  const reportDir = input.platform.resolvePath(runRoot, "harness");
  await persistRunProgress(input.platform, runRoot, input.runId, input.taskNumber, "dataset.resolve", "started", diagnostics);
  const instance = await resolveDatasetInstance(input.platform, input.workspaceRoot, input.taskNumber).catch((error: unknown) => {
    diagnostics.push(diagnostic("SWE_BENCH_INSTANCE_RESOLVE_FAILED", error instanceof Error ? error.message : String(error)));
    return undefined;
  });
  if (!instance) {
    await persistRunProgress(input.platform, runRoot, input.runId, input.taskNumber, "dataset.resolve", "failed", diagnostics);
    return persistAndReturn(summary({
      input,
      diagnostics,
      environmentStatus: environment.status,
      commandCount: environment.executedSteps.length,
      status: "fail"
    }));
  }
  await persistRunProgress(input.platform, runRoot, input.runId, input.taskNumber, "dataset.resolve", "completed", diagnostics, { instanceId: instance.instanceId });

  await input.platform.writeFile(instanceFile, JSON.stringify({
    instance_id: instance.instanceId,
    repo: instance.repo,
    base_commit: instance.baseCommit,
    problem_statement: instance.problemStatement
  }, null, 2));

  await persistRunProgress(input.platform, runRoot, input.runId, input.taskNumber, "checkout.prepare", "started", diagnostics, { instanceId: instance.instanceId });
  const checkoutCommands = await prepareCheckout(input.platform, runRoot, repoDir, instance, diagnostics, input.timeoutMs);
  if (diagnostics.some((entry) => entry.code === "SWE_BENCH_CHECKOUT_FAILED")) {
    await persistRunProgress(input.platform, runRoot, input.runId, input.taskNumber, "checkout.prepare", "failed", diagnostics, { instanceId: instance.instanceId });
    return persistAndReturn(summary({
      input,
      diagnostics,
      environmentStatus: environment.status,
      instanceId: instance.instanceId,
      commandCount: environment.executedSteps.length + checkoutCommands,
      status: "fail"
    }));
  }
  await persistRunProgress(input.platform, runRoot, input.runId, input.taskNumber, "checkout.prepare", "completed", diagnostics, { instanceId: instance.instanceId });
  await persistRunProgress(input.platform, runRoot, input.runId, input.taskNumber, "checkout.env", "started", diagnostics, { instanceId: instance.instanceId });
  const checkoutEnvironmentCommands = await prepareRunScopedCheckoutEnvironment(input.platform, runRoot, repoDir, diagnostics, input.timeoutMs);
  if (diagnostics.some((entry) => entry.code === "SWE_BENCH_CHECKOUT_ENV_FAILED" && entry.severity === "error")) {
    await persistRunProgress(input.platform, runRoot, input.runId, input.taskNumber, "checkout.env", "failed", diagnostics, { instanceId: instance.instanceId });
    return persistAndReturn(summary({
      input,
      diagnostics,
      environmentStatus: environment.status,
      instanceId: instance.instanceId,
      commandCount: environment.executedSteps.length + checkoutCommands + checkoutEnvironmentCommands,
      status: "fail"
    }));
  }
  await persistRunProgress(input.platform, runRoot, input.runId, input.taskNumber, "checkout.env", "completed", diagnostics, { instanceId: instance.instanceId });

  const maxAttempts = 2;
  let prediction: SweBenchPredictionSummary | undefined;
  let evaluation: SweBenchPredictionSummary | undefined;
  let repairContext: SweBenchRepairContext | undefined;
  let attemptCommandCount = 0;
  let attemptCount = 0;
  let repairAttempted = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptCount = attempt;
    const attemptTraceOutputPath = input.platform.resolvePath(runRoot, `trace-attempt-${attempt}.jsonl`);
    await persistRunProgress(input.platform, runRoot, input.runId, input.taskNumber, "attempt.predict.start", "started", diagnostics, { attempt, instanceId: instance.instanceId });
    prediction = await collectSweBenchPrediction({
      action: "predict",
      dryRun: false,
      live: true,
      instanceFile,
      repoDir,
      outputPath,
      traceOutputPath: attemptTraceOutputPath,
      modelProvider: input.provider,
      model: input.model,
      timeoutMs: input.timeoutMs,
      ...(repairContext ? { repairContext } : {}),
      extraArgs: [],
      platform: input.platform
    });
    await persistRunProgress(input.platform, runRoot, input.runId, input.taskNumber, "attempt.predict.completed", prediction.status === "fail" ? "failed" : "completed", diagnostics, { attempt, instanceId: instance.instanceId });
    await copyAttemptTraceToLatest(input.platform, attemptTraceOutputPath, latestTraceOutputPath, diagnostics);
    const runId = uniqueHarnessEvaluationRunId(input.runId, attempt);
    await persistRunProgress(input.platform, runRoot, input.runId, input.taskNumber, "attempt.evaluate.start", "started", diagnostics, { attempt, instanceId: instance.instanceId });
    evaluation = await collectSweBenchPrediction({
      action: "evaluate",
      dryRun: false,
      live: false,
      outputPath,
      reportDir,
      runId,
      instanceIds: [instance.instanceId],
      harnessPython: harnessPythonPath(input.platform, input.workspaceRoot),
      traceOutputPath: attemptTraceOutputPath,
      cacheTracePath: attemptTraceOutputPath,
      timeoutMs: input.timeoutMs,
      extraArgs: [],
      platform: input.platform
    });
    await persistRunProgress(input.platform, runRoot, input.runId, input.taskNumber, "attempt.evaluate.completed", evaluation.status === "fail" ? "failed" : "completed", diagnostics, { attempt, instanceId: instance.instanceId });
    attemptCommandCount += prediction.executedCommands.length + evaluation.executedCommands.length;
    if (evaluation.evaluation?.resolved !== false || attempt === maxAttempts) break;
    repairAttempted = true;
    const failingTests = failingTestsFromEvaluation(evaluation).slice(0, 12);
    const failureExcerpts = failureExcerptsFromEvaluation(evaluation).slice(0, 6);
    diagnostics.push({
      code: "SWE_BENCH_REPAIR_ATTEMPT_REQUESTED",
      severity: "info",
      message: "Official SWE-bench harness was unresolved; launching a supervised repair attempt in the same checkout.",
      metadata: {
        attempt,
        nextAttempt: attempt + 1,
        unresolvedInstanceIds: evaluation.evaluation.batch.unresolvedInstanceIds,
        failingTests,
        failureExcerptCount: failureExcerpts.length
      },
      redaction: { class: "internal", fields: ["metadata"] }
    });
    if (failingTests.length > 0 && failureExcerpts.length === 0) {
      diagnostics.push({
        code: "REPAIR_FEEDBACK_LOW_FIDELITY",
        severity: "warn",
        message: "Supervised repair was requested with failing test ids but without official harness failure excerpts.",
        metadata: {
          attempt,
          nextAttempt: attempt + 1,
          failingTestCount: failingTests.length
        },
        redaction: { class: "internal", fields: ["metadata"] }
      });
    }
    repairContext = repairContextFromEvaluation(evaluation, attempt + 1, prediction.predictions[0]?.model_patch.length);
  }
  if (!prediction || !evaluation) {
    return persistAndReturn(summary({
      input,
      diagnostics,
      environmentStatus: environment.status,
      instanceId: instance.instanceId,
      commandCount: environment.executedSteps.length + checkoutCommands + checkoutEnvironmentCommands,
      status: "fail"
    }));
  }
  for (const item of prediction.diagnostics) diagnostics.push(predictionDiagnostic(item));
  for (const item of evaluation.diagnostics) diagnostics.push(predictionDiagnostic(item));
  return persistAndReturn(summary({
    input,
    diagnostics,
    environmentStatus: environment.status,
    prediction,
    evaluation,
    instanceId: instance.instanceId,
    attemptCount,
    repairAttempted,
    commandCount: environment.executedSteps.length + checkoutCommands + checkoutEnvironmentCommands + attemptCommandCount,
    status: combinedStatus(prediction.status, evaluation.status, diagnostics)
  }));
}

function batchSummary(
  taskNumbers: readonly number[],
  children: readonly SweBenchRunSummary[],
  skippedTaskNumbers: readonly number[],
  diagnostics: readonly JsonObject[],
  resumeOnly = false
): SweBenchRunBatchSummary {
  const childTaskNumbers = new Set(children.map((child) => child.taskNumber));
  const effectiveSkippedTaskNumbers = resumeOnly
    ? skippedTaskNumbers.filter((taskNumber) => !childTaskNumbers.has(taskNumber))
    : skippedTaskNumbers;
  const resumedTaskNumbers = resumeOnly
    ? skippedTaskNumbers.filter((taskNumber) => childTaskNumbers.has(taskNumber))
    : [];
  const failedTaskNumbers = children
    .filter((child) => child.status === "fail" || child.evaluationStatus === "fail")
    .map((child) => child.taskNumber)
    .filter((taskNumber) => taskNumber > 0);
  const resolvedTaskNumbers = children
    .filter((child) => child.evaluationResolved === true)
    .map((child) => child.taskNumber)
    .filter((taskNumber) => taskNumber > 0);
  const unresolvedTaskNumbers = taskNumbers.filter((taskNumber) => {
    if (effectiveSkippedTaskNumbers.includes(taskNumber) && !childTaskNumbers.has(taskNumber)) return false;
    if (resolvedTaskNumbers.includes(taskNumber)) return false;
    return !failedTaskNumbers.includes(taskNumber);
  });
  const resolvedTasks = resolvedTaskNumbers.length;
  const completedTasks = children.length;
  const failedTasks = failedTaskNumbers.length + diagnostics.filter((entry) => entry.severity === "error").length;
  return {
    totalTasks: taskNumbers.length,
    completedTasks,
    resolvedTasks,
    unresolvedTasks: unresolvedTaskNumbers.length,
    failedTasks,
    skippedTasks: effectiveSkippedTaskNumbers.length,
    resolvedRate: taskNumbers.length > 0 ? resolvedTasks / taskNumbers.length : 0,
    completedResolvedRate: completedTasks > 0 ? resolvedTasks / completedTasks : 0,
    taskNumbers,
    resolvedTaskNumbers,
    unresolvedTaskNumbers,
    failedTaskNumbers,
    skippedTaskNumbers: effectiveSkippedTaskNumbers,
    ...(resumedTaskNumbers.length > 0 ? { resumedTaskNumbers } : {}),
    taskStates: taskNumbers.map((taskNumber) => taskState(taskNumber, children, skippedTaskNumbers, diagnostics, resumeOnly)),
    ...batchProviderCache(children),
    ...batchContextProjectionCache(children),
    ...batchReviewCodes(children, diagnostics)
  };
}

function batchRunSummary(input: {
  readonly taskNumbers: readonly number[];
  readonly runId: string;
  readonly dryRun: boolean;
  readonly execute: boolean;
  readonly provider: "deepseek" | "glm";
  readonly model: string;
}, diagnostics: readonly JsonObject[], batch: SweBenchRunBatchSummary, children: readonly SweBenchRunSummary[], commandCount: number, status: "pass" | "warn" | "fail"): SweBenchRunSummary {
  return {
    schemaVersion: "1.0.0",
    kind: "capability.swe-bench.run.summary",
    status,
    taskNumber: 0,
    taskNumbers: input.taskNumbers,
    runId: input.runId,
    dryRun: input.dryRun,
    execute: input.execute && !input.dryRun,
    provider: input.provider,
    model: input.model,
    evaluationResolved: batch.totalTasks > 0 && batch.resolvedTasks === batch.totalTasks,
    evaluationResolvedRate: batch.resolvedRate,
    batch,
    children,
    commandCount,
    diagnostics,
    redaction: { class: "internal", fields: ["diagnostics.metadata", "children.diagnostics.metadata"] }
  };
}

function taskState(
  taskNumber: number,
  children: readonly SweBenchRunSummary[],
  skippedTaskNumbers: readonly number[],
  diagnostics: readonly JsonObject[],
  resumeOnly = false
): SweBenchRunTaskState {
  const child = children.find((item) => item.taskNumber === taskNumber);
  const resumedFromSummary = skippedTaskNumbers.includes(taskNumber);
  if (!child) {
    const status: SweBenchRunTaskState["status"] = resumedFromSummary ? "skipped" : "pending";
    return {
      taskNumber,
      runId: "",
      status,
      ...(status === "pending" ? pendingTaskAttribution(taskNumber, diagnostics) : {})
    };
  }
  const childStatus: SweBenchRunTaskState["status"] = child.status === "fail" || child.evaluationStatus === "fail"
    ? "failed"
    : child.evaluationResolved === true
      ? "resolved"
      : "unresolved";
  const status: SweBenchRunTaskState["status"] = !resumeOnly && resumedFromSummary && childStatus === "resolved" ? "skipped" : childStatus;
  const attribution = status === "failed" || status === "unresolved" ? taskFailureAttribution(child) : {};
  return {
    taskNumber,
    runId: child.runId,
    status,
    ...(child.evaluationResolved !== undefined ? { evaluationResolved: child.evaluationResolved } : {}),
    ...(child.attemptCount !== undefined ? { attemptCount: child.attemptCount } : {}),
    ...(resumedFromSummary ? { resumedFromSummary: true } : {}),
    ...attribution
  };
}

function pendingTaskAttribution(taskNumber: number, diagnostics: readonly JsonObject[]): SweBenchFailureAttribution {
  if (!pendingTaskIsPausedByBackpressure(taskNumber, diagnostics)) return {};
  const primaryReasonCode = "BATCH_PENDING_GOVERNANCE_BACKPRESSURE";
  return {
    reasonCodes: [primaryReasonCode],
    primaryReasonCode,
    failureCategory: failureCategoryForReasonCode(primaryReasonCode),
    actionability: actionabilityForReasonCode(primaryReasonCode)
  };
}

function pendingTaskIsPausedByBackpressure(taskNumber: number, diagnostics: readonly JsonObject[]): boolean {
  return diagnostics.some((entry) => {
    if (entry.code !== "SWE_BENCH_BATCH_BACKPRESSURE_ACTIVE") return false;
    const metadata = isJsonObject(entry.metadata) ? entry.metadata : {};
    const pendingTaskNumbers = Array.isArray(metadata.pendingTaskNumbers) ? metadata.pendingTaskNumbers : [];
    return pendingTaskNumbers.includes(taskNumber);
  });
}

function taskFailureAttribution(child: SweBenchRunSummary): SweBenchFailureAttribution {
  const diagnosticCodes = diagnosticCodesFromSummary(child).filter((code) =>
    !(code === "SWE_BENCH_POST_EDIT_VERIFICATION_GATE" && postEditVerificationGateWasSatisfied(child))
  );
  const reasonCodes = new Set<string>();
  for (const diagnostic of child.diagnostics) {
    for (const code of failureReasonCodesFromDiagnostic(diagnostic)) {
      if (code === "FLOW_POST_EDIT_VERIFICATION_MISSING" && postEditVerificationGateWasSatisfied(child)) continue;
      reasonCodes.add(code);
    }
  }
  for (const code of failureReasonCodesFromChildTrace(child)) {
    if (code === "FLOW_REQUEST_BUDGET_EXCEEDED" && reasonCodes.has("FLOW_READY_FOR_HARNESS_GATE_MISSING")) continue;
    reasonCodes.add(code);
  }
  if (child.evaluationResolved === false || diagnosticCodes.includes("SWE_BENCH_EVALUATION_UNRESOLVED")) {
    reasonCodes.add("OFFICIAL_UNRESOLVED_AFTER_REPAIR");
    if ((child.childTestCommandCount ?? 0) > 0) reasonCodes.add("VERIFICATION_ORACLE_GAP");
  }
  if (isModelPatchInsufficient(child, reasonCodes)) {
    reasonCodes.add("MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR");
  }
  const orderedReasonCodes = [...reasonCodes].sort((a, b) => failureReasonPriority(a, child) - failureReasonPriority(b, child) || a.localeCompare(b));
  const primaryReasonCode = orderedReasonCodes[0];
  const findings = evaluateAgenticEvaluationBlockers({
    diagnosticCodes: [...new Set([...diagnosticCodes, ...orderedReasonCodes])],
    ...(child.evaluationResolved !== undefined ? { evaluationResolved: child.evaluationResolved } : {}),
    ...(child.childTerminalReason !== undefined ? { terminalReason: child.childTerminalReason } : {}),
    ...(child.childModelRequestCount !== undefined ? { modelRequestCount: child.childModelRequestCount } : {}),
    ...(child.childSourceInspectionToolCount !== undefined ? { sourceInspectionToolCount: child.childSourceInspectionToolCount } : {}),
    ...(child.childSourceMutationCount !== undefined ? { sourceMutationCount: child.childSourceMutationCount } : {}),
    ...(child.childShellCommandCount !== undefined ? { shellCommandCount: child.childShellCommandCount } : {}),
    ...(child.childTestCommandCount !== undefined ? { testCommandCount: child.childTestCommandCount } : {}),
    ...(child.childSuccessfulTestCommandCount !== undefined ? { successfulTestCommandCount: child.childSuccessfulTestCommandCount } : {}),
    ...(child.providerCacheHitRate !== undefined ? { providerCacheHitRate: child.providerCacheHitRate } : {}),
    ...(child.providerCacheRequestCount !== undefined ? { providerCacheRequestCount: child.providerCacheRequestCount } : {})
  });
  const blockerIds = [...new Set(findings.map((finding) => finding.blocker.id))];
  return {
    ...(orderedReasonCodes.length > 0 ? { reasonCodes: orderedReasonCodes } : {}),
    ...(primaryReasonCode ? { primaryReasonCode } : {}),
    ...(primaryReasonCode ? { failureCategory: failureCategoryForReasonCode(primaryReasonCode) } : {}),
    ...(primaryReasonCode ? { actionability: actionabilityForReasonCode(primaryReasonCode) } : {}),
    ...(blockerIds.length > 0 ? { blockerIds } : {})
  };
}

function diagnosticCodesFromSummary(child: SweBenchRunSummary): readonly string[] {
  return child.diagnostics
    .map((entry) => typeof entry.code === "string" ? entry.code : undefined)
    .filter((code): code is string => typeof code === "string");
}

function failureReasonCodesFromDiagnostic(diagnostic: JsonObject): readonly string[] {
  const code = typeof diagnostic.code === "string" ? diagnostic.code : "";
  const message = typeof diagnostic.message === "string" ? diagnostic.message : "";
  if (code === "SWE_BENCH_CHILD_TRACE_TERMINAL_FAILED") {
    return failureReasonCodesFromChildTraceLike(isJsonObject(diagnostic.metadata) ? diagnostic.metadata : {});
  }
  if (code === "SWE_BENCH_DOCKER_CONTEXT_UNAVAILABLE") return ["ENV_DOCKER_CONTEXT_UNAVAILABLE"];
  if (code === "SWE_BENCH_DOCKER_CONTEXT_EMPTY") return ["ENV_DOCKER_CONTEXT_EMPTY"];
  if (code === "SWE_BENCH_DOCKER_IMAGE_NOT_FOUND") return ["ENV_DOCKER_IMAGE_NOT_FOUND"];
  if (code === "SWE_BENCH_TEST_ENV_DEPENDENCY_INCOMPATIBLE") return ["ENV_TEST_DEPENDENCY_INCOMPATIBLE"];
  if (code === "SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING") {
    return diagnosticHasRepoLocalAlternateRunner(diagnostic)
      ? ["VERIFICATION_REPO_LOCAL_RUNNER_AVAILABLE", "ENV_TEST_DEPENDENCY_MISSING"]
      : ["ENV_TEST_DEPENDENCY_MISSING"];
  }
  if (code === "SWE_BENCH_TEST_ENTRYPOINT_MISSING") return ["VERIFICATION_TEST_ENTRYPOINT_MISSING"];
  if (code === "SWE_BENCH_TEST_ARGUMENT_UNSUPPORTED") return ["VERIFICATION_TEST_ARGUMENT_UNSUPPORTED"];
  if (code === "SWE_BENCH_TEST_COMMAND_ENV_MISSCOPED") return ["VERIFICATION_TEST_COMMAND_ENV_MISSCOPED"];
  if (code === "SWE_BENCH_HARNESS_INSTANCE_ERROR") return ["HARNESS_TOPLEVEL_ERROR_ONLY"];
  if (code === "SWE_BENCH_HARNESS_EMPTY_PATCH" || code === "SWE_BENCH_EMPTY_PATCH") return ["PREDICTION_EMPTY_PATCH"];
  if (code === "SWE_BENCH_REPORT_READ_FAILED" || code === "SWE_BENCH_REPORT_STAT_FAILED") return ["HARNESS_INSTANCE_REPORT_MISSING"];
  if (code === "SWE_BENCH_CACHE_HIT_TARGET_MISSED" || code === "SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET") return ["CACHE_PROVIDER_BELOW_TARGET"];
  if (code === "SWE_BENCH_PROVIDER_CACHE_PIPELINE_TELEMETRY_ABSENT") return ["CACHE_PROVIDER_PIPELINE_TELEMETRY_ABSENT"];
  if (code === "SWE_BENCH_PROVIDER_CACHE_PIPELINE_MISSING") return ["CACHE_PROVIDER_PIPELINE_MISSING"];
  if (code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_HINT_UNSUPPORTED") return ["CACHE_PROVIDER_PREFIX_HINT_UNSUPPORTED"];
  if (code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_HINT_MISSING") return ["CACHE_PROVIDER_PREFIX_HINT_MISSING"];
  if (code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_TOO_SMALL") return ["CACHE_PROVIDER_PREFIX_TOO_SMALL"];
  if (code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_COVERAGE_LOW") return ["CACHE_PROVIDER_PREFIX_COVERAGE_LOW"];
  if (code === "SWE_BENCH_PROVIDER_CACHE_DYNAMIC_TAIL_MISS") return ["CACHE_PROVIDER_DYNAMIC_TAIL_MISS"];
  if (code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_DRIFT") return ["CACHE_PROVIDER_PREFIX_DRIFT"];
  if (code === "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_MISS") return ["CACHE_PROVIDER_BREAKPOINT_SHAPE_MISS"];
  if (code === "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_TELEMETRY_MISSING") return ["CACHE_PROVIDER_BREAKPOINT_SHAPE_TELEMETRY_MISSING"];
  if (code === "SWE_BENCH_PROVIDER_CACHE_MULTI_MESSAGE_BREAKPOINT") return ["CACHE_PROVIDER_MULTI_MESSAGE_BREAKPOINT"];
  if (code === "SWE_BENCH_PROVIDER_TOOL_SCHEMA_CACHE_GAP") return ["CACHE_PROVIDER_TOOL_SCHEMA_CACHE_GAP"];
  if (code === "SWE_BENCH_PROVIDER_CACHE_HISTORY_TAIL_MISS") return ["CACHE_PROVIDER_HISTORY_TAIL_MISS"];
  if (code === "SWE_BENCH_PROVIDER_HISTORY_UNBOUNDED_AFTER_GATE") return ["CACHE_PROVIDER_HISTORY_UNBOUNDED_AFTER_GATE"];
  if (code === "PROMPT_CACHE_PREFIX_BUSTED") return ["CACHE_PROMPT_PREFIX_BUSTED"];
  if (code === "PROMPT_WHOLE_FINGERPRINT_DYNAMIC_WITH_STABLE_PREFIX") return ["CACHE_WHOLE_PROMPT_DYNAMIC_PREFIX_STABLE"];
  if (code === "SWE_BENCH_CONTEXT_PROJECTION_CACHE_NO_HIT") return ["CACHE_CONTEXT_PROJECTION_NO_HIT"];
  if (code === "SWE_BENCH_CONTEXT_PROJECTION_KEY_WHOLE_PROMPT_DYNAMIC") return ["CACHE_CONTEXT_KEY_WHOLE_PROMPT_DYNAMIC"];
  if (code === "SWE_BENCH_CACHE_METRIC_SCOPE_MISMATCH") return ["CACHE_METRIC_SCOPE_MISMATCH"];
  if (code === "SWE_BENCH_READY_FOR_HARNESS_GATE_MISSING") return ["FLOW_READY_FOR_HARNESS_GATE_MISSING"];
  if (code === "SWE_BENCH_POST_EDIT_VERIFICATION_GATE") return ["FLOW_POST_EDIT_VERIFICATION_MISSING"];
  if (code === "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE") return ["ENV_POST_VERIFICATION_BLOCKER"];
  if (code === "SWE_BENCH_CHILD_TRACE_TEST_UNSUCCESSFUL") return ["VERIFICATION_LOCAL_TEST_UNSUCCESSFUL"];
  if (code === "SWE_BENCH_CHILD_TRACE_VERIFICATION_MISSING" || code === "SWE_BENCH_VERIFICATION_GATE_SOFT" || code === "SWE_BENCH_VERIFICATION_GATE_ENFORCED") return ["GATE_VERIFICATION_PRESSURE"];
  if (code === "SWE_BENCH_SOURCE_INSPECTION_DEFIANCE_GATE") return ["GATE_SOURCE_INSPECTION_DEFIANCE"];
  if (code === "SWE_BENCH_SOURCE_INSPECTION_GATE" || code === "SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED") return ["GATE_SOURCE_INSPECTION_PRESSURE"];
  if (code === "SWE_BENCH_CHECKOUT_ENV_WARN" && message.toLowerCase().includes("editable install")) return ["CHECKOUT_EDITABLE_INSTALL_WARN"];
  if (code === "REPAIR_FEEDBACK_LOW_FIDELITY") return ["REPAIR_FEEDBACK_LOW_FIDELITY"];
  if (code === "SWE_BENCH_REPAIR_FEEDBACK_INSUFFICIENT" || code === "SWE_BENCH_REPAIR_DIFF_MISSING") return ["REPAIR_FEEDBACK_INSUFFICIENT"];
  if (code === "SWE_BENCH_EVALUATION_UNRESOLVED") return ["OFFICIAL_UNRESOLVED_AFTER_REPAIR"];
  return [];
}

function diagnosticHasRepoLocalAlternateRunner(diagnostic: JsonObject): boolean {
  const metadata = isJsonObject(diagnostic.metadata) ? diagnostic.metadata : undefined;
  const details = Array.isArray(metadata?.testFailureDetails) ? metadata.testFailureDetails : [];
  return details.some((detail) => {
    if (!isJsonObject(detail)) return false;
    const alternateCommand = stringField(detail, "alternateCommand");
    const alternateRunnerPath = stringField(detail, "alternateRunnerPath");
    return Boolean(alternateCommand && alternateRunnerPath);
  });
}

function failureReasonCodesFromChildTrace(child: SweBenchRunSummary): readonly string[] {
  return failureReasonCodesFromChildTraceLike({
    terminalReason: child.childTerminalReason,
    iterationCount: child.childIterationCount,
    modelRequestCount: child.childModelRequestCount
  });
}

function failureReasonCodesFromChildTraceLike(input: JsonObject): readonly string[] {
  const codes: string[] = [];
  const terminalReason = typeof input.terminalReason === "string" ? input.terminalReason : "";
  if (terminalReason === "model-iteration-limit") codes.push("FLOW_MODEL_ITERATION_LIMIT");
  if (terminalReason === "tool-call-limit") codes.push("FLOW_TOOL_CALL_LIMIT");
  if (terminalReason === "swe-bench-request-budget-exceeded") codes.push("FLOW_REQUEST_BUDGET_EXCEEDED");
  if (terminalReason === "swe-bench-source-inspection-defiance") codes.push("GATE_SOURCE_INSPECTION_DEFIANCE");
  const modelRequestCount = numberField(input, "modelRequestCount");
  if (
    modelRequestCount !== undefined &&
    modelRequestCount >= SWE_BENCH_FLOW_MODEL_REQUEST_BUDGET &&
    terminalReason !== "swe-bench-ready-for-harness"
  ) {
    codes.push("FLOW_REQUEST_BUDGET_EXCEEDED");
  }
  return codes;
}

function isModelPatchInsufficient(child: SweBenchRunSummary, reasonCodes: ReadonlySet<string>): boolean {
  if (child.evaluationResolved !== false) return false;
  for (const code of reasonCodes) {
    if (code !== "OFFICIAL_UNRESOLVED_AFTER_REPAIR" && code !== "MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR") return false;
  }
  return true;
}

function failureReasonPriority(code: string, child?: SweBenchRunSummary): number {
  if (code === "HARNESS_INSTANCE_REPORT_MISSING" && childHasRequestBudgetEvidence(child)) return 38;
  if (code === "FLOW_POST_EDIT_VERIFICATION_MISSING" && postEditVerificationGateWasSatisfied(child)) return 132;
  const priorities: Readonly<Record<string, number>> = {
    ENV_DOCKER_CONTEXT_UNAVAILABLE: 5,
    ENV_DOCKER_CONTEXT_EMPTY: 6,
    ENV_DOCKER_IMAGE_NOT_FOUND: 10,
    ENV_TEST_DEPENDENCY_INCOMPATIBLE: 12,
    VERIFICATION_REPO_LOCAL_RUNNER_AVAILABLE: 12.02,
    ENV_TEST_DEPENDENCY_MISSING: 12.05,
    VERIFICATION_TEST_ENTRYPOINT_MISSING: 12.1,
    VERIFICATION_TEST_ARGUMENT_UNSUPPORTED: 12.2,
    VERIFICATION_TEST_COMMAND_ENV_MISSCOPED: 12.3,
    VERIFICATION_LOCAL_TEST_UNSUCCESSFUL: 12.5,
    ENV_POST_VERIFICATION_BLOCKER: 13,
    HARNESS_TOPLEVEL_ERROR_ONLY: 20,
    HARNESS_INSTANCE_REPORT_MISSING: 30,
    FLOW_MODEL_ITERATION_LIMIT: 34,
    FLOW_TOOL_CALL_LIMIT: 35,
    FLOW_READY_FOR_HARNESS_GATE_MISSING: 35.25,
    FLOW_POST_EDIT_VERIFICATION_MISSING: 35.5,
    GATE_SOURCE_INSPECTION_DEFIANCE: 35.7,
    GATE_SOURCE_INSPECTION_PRESSURE: 35.75,
    FLOW_REQUEST_BUDGET_EXCEEDED: 36,
    GATE_VERIFICATION_PRESSURE: 40,
    CACHE_PROVIDER_BELOW_TARGET: 60,
    CACHE_PROVIDER_PIPELINE_TELEMETRY_ABSENT: 60.5,
    CACHE_PROVIDER_PIPELINE_MISSING: 61,
    CACHE_PROVIDER_PREFIX_HINT_UNSUPPORTED: 62,
    CACHE_PROVIDER_PREFIX_HINT_MISSING: 63,
    CACHE_PROVIDER_PREFIX_DRIFT: 63.25,
    CACHE_PROVIDER_PREFIX_TOO_SMALL: 63.5,
    CACHE_PROVIDER_PREFIX_COVERAGE_LOW: 63.55,
    CACHE_PROVIDER_DYNAMIC_TAIL_MISS: 63.6,
    CACHE_PROVIDER_TOOL_SCHEMA_CACHE_GAP: 63.65,
    CACHE_PROVIDER_BREAKPOINT_SHAPE_TELEMETRY_MISSING: 63.68,
    CACHE_PROVIDER_MULTI_MESSAGE_BREAKPOINT: 63.7,
    CACHE_PROVIDER_BREAKPOINT_SHAPE_MISS: 63.75,
    CACHE_WHOLE_PROMPT_DYNAMIC_PREFIX_STABLE: 64,
    CACHE_PROMPT_PREFIX_BUSTED: 65,
    CACHE_PROVIDER_HISTORY_UNBOUNDED_AFTER_GATE: 66,
    CACHE_PROVIDER_HISTORY_TAIL_MISS: 68,
    CACHE_CONTEXT_KEY_WHOLE_PROMPT_DYNAMIC: 70,
    CACHE_CONTEXT_PROJECTION_NO_HIT: 80,
    CACHE_METRIC_SCOPE_MISMATCH: 90,
    CHECKOUT_EDITABLE_INSTALL_WARN: 100,
    REPAIR_FEEDBACK_LOW_FIDELITY: 105,
    REPAIR_FEEDBACK_INSUFFICIENT: 110,
    VERIFICATION_ORACLE_GAP: 115,
    PREDICTION_EMPTY_PATCH: 118,
    MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR: 120,
    OFFICIAL_UNRESOLVED_AFTER_REPAIR: 130,
    BATCH_PENDING_GOVERNANCE_BACKPRESSURE: 140
  };
  return priorities[code] ?? 1_000;
}

function postEditVerificationGateWasSatisfied(child: SweBenchRunSummary | undefined): boolean {
  return (child?.childTestCommandCount ?? 0) > 0;
}

function childHasRequestBudgetEvidence(child: SweBenchRunSummary | undefined): boolean {
  return child?.childTerminalReason === "swe-bench-request-budget-exceeded" ||
    (child?.childModelRequestCount !== undefined && child.childModelRequestCount >= SWE_BENCH_FLOW_MODEL_REQUEST_BUDGET);
}

function failureCategoryForReasonCode(code: string): string {
  if (code === "ENV_DOCKER_CONTEXT_UNAVAILABLE" || code === "ENV_DOCKER_CONTEXT_EMPTY" || code === "ENV_DOCKER_IMAGE_NOT_FOUND" || code === "ENV_TEST_DEPENDENCY_INCOMPATIBLE" || code === "ENV_TEST_DEPENDENCY_MISSING" || code === "ENV_POST_VERIFICATION_BLOCKER" || code === "CHECKOUT_EDITABLE_INSTALL_WARN") return "environment";
  if (code === "HARNESS_TOPLEVEL_ERROR_ONLY" || code === "HARNESS_INSTANCE_REPORT_MISSING") return "harness";
  if (code.startsWith("FLOW_")) return "flow-control";
  if (code === "GATE_VERIFICATION_PRESSURE" || code === "VERIFICATION_LOCAL_TEST_UNSUCCESSFUL" || code === "VERIFICATION_ORACLE_GAP" || code === "VERIFICATION_REPO_LOCAL_RUNNER_AVAILABLE" || code === "VERIFICATION_TEST_ENTRYPOINT_MISSING" || code === "VERIFICATION_TEST_ARGUMENT_UNSUPPORTED" || code === "VERIFICATION_TEST_COMMAND_ENV_MISSCOPED") return "verification";
  if (code === "REPAIR_FEEDBACK_LOW_FIDELITY") return "repair-feedback";
  if (code === "GATE_SOURCE_INSPECTION_DEFIANCE" || code === "GATE_SOURCE_INSPECTION_PRESSURE" || code === "REPAIR_FEEDBACK_INSUFFICIENT") return "framework";
  if (code.startsWith("CACHE_")) return "cache-economics";
  if (code.startsWith("BATCH_")) return "batch-resume";
  if (code === "PREDICTION_EMPTY_PATCH") return "prediction-output";
  if (code === "MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR" || code === "OFFICIAL_UNRESOLVED_AFTER_REPAIR") return "model-patch";
  return "unknown";
}

function actionabilityForReasonCode(code: string): string {
  if (code === "ENV_DOCKER_CONTEXT_UNAVAILABLE" || code === "ENV_DOCKER_CONTEXT_EMPTY" || code === "ENV_DOCKER_IMAGE_NOT_FOUND" || code === "ENV_TEST_DEPENDENCY_INCOMPATIBLE" || code === "ENV_TEST_DEPENDENCY_MISSING" || code === "ENV_POST_VERIFICATION_BLOCKER" || code === "CHECKOUT_EDITABLE_INSTALL_WARN") return "environment-fix";
  if (code === "MODEL_PATCH_INSUFFICIENT_AFTER_GOVERNED_REPAIR" || code === "OFFICIAL_UNRESOLVED_AFTER_REPAIR") return "model-feedback";
  if (code === "REPAIR_FEEDBACK_LOW_FIDELITY") return "repair-feedback-fix";
  if (code === "VERIFICATION_LOCAL_TEST_UNSUCCESSFUL" || code === "VERIFICATION_ORACLE_GAP" || code === "VERIFICATION_REPO_LOCAL_RUNNER_AVAILABLE" || code === "VERIFICATION_TEST_ENTRYPOINT_MISSING" || code === "VERIFICATION_TEST_ARGUMENT_UNSUPPORTED" || code === "VERIFICATION_TEST_COMMAND_ENV_MISSCOPED") return "verification-fix";
  if (code === "PREDICTION_EMPTY_PATCH") return "framework-fix";
  if (code.startsWith("FLOW_")) return "framework-fix";
  if (code.startsWith("CACHE_")) return "framework-fix";
  if (code.startsWith("BATCH_PENDING_")) return "pending-review";
  if (failureCategoryForReasonCode(code) !== "unknown") return "framework-fix";
  return "unknown-needs-triage";
}

function batchProviderCache(children: readonly SweBenchRunSummary[]): Pick<SweBenchRunBatchSummary, "providerCacheHitRate" | "providerCacheRequestCount" | "providerCachePassed"> {
  let weightedHitRate = 0;
  let requestCount = 0;
  let passed = true;
  let hasPassedSignal = false;
  for (const child of children) {
    const childRequests = child.providerCacheRequestCount ?? 0;
    if (childRequests > 0 && child.providerCacheHitRate !== undefined) {
      weightedHitRate += child.providerCacheHitRate * childRequests;
      requestCount += childRequests;
    }
    if (child.providerCachePassed !== undefined) {
      hasPassedSignal = true;
      passed = passed && child.providerCachePassed;
    }
  }
  if (requestCount === 0) return {};
  return {
    providerCacheHitRate: weightedHitRate / requestCount,
    providerCacheRequestCount: requestCount,
    ...(hasPassedSignal ? { providerCachePassed: passed } : {})
  };
}

function batchContextProjectionCache(children: readonly SweBenchRunSummary[]): Pick<SweBenchRunBatchSummary, "contextProjectionCacheHitRate" | "contextProjectionCacheRequestCount"> {
  let weightedHitRate = 0;
  let requestCount = 0;
  for (const child of children) {
    const childRequests = child.contextProjectionCacheRequestCount ?? 0;
    if (childRequests > 0 && child.contextProjectionCacheHitRate !== undefined) {
      weightedHitRate += child.contextProjectionCacheHitRate * childRequests;
      requestCount += childRequests;
    }
  }
  if (requestCount === 0) return {};
  return {
    contextProjectionCacheHitRate: weightedHitRate / requestCount,
    contextProjectionCacheRequestCount: requestCount
  };
}

function batchReviewCodes(children: readonly SweBenchRunSummary[], diagnostics: readonly JsonObject[]): Pick<SweBenchRunBatchSummary, "reviewCodes"> {
  const codes = new Set<string>();
  for (const child of children) {
    for (const code of child.reviewCodes ?? []) {
      if (child.evaluationResolved === true && !isCacheGovernanceReviewCode(code)) continue;
      codes.add(code);
    }
  }
  for (const diagnostic of diagnostics) {
    const code = typeof diagnostic.code === "string" ? diagnostic.code : "";
    if (code === "SWE_BENCH_BATCH_BACKPRESSURE_ACTIVE") codes.add(code);
  }
  return codes.size > 0 ? { reviewCodes: [...codes].sort() } : {};
}

function isCacheGovernanceReviewCode(code: string): boolean {
  return code.includes("CACHE") ||
    code.includes("CONTEXT_PROJECTION") ||
    code.startsWith("PROMPT_");
}

function batchBackpressureFinding(batch: SweBenchRunBatchSummary): JsonObject | undefined {
  if (batch.completedTasks < SWE_BENCH_BATCH_BACKPRESSURE_MIN_COMPLETED) return undefined;
  const pendingTaskNumbers = batch.taskStates
    .filter((state) => state.status === "pending")
    .map((state) => state.taskNumber);
  if (pendingTaskNumbers.length === 0) return undefined;
  const successBelowThreshold = batch.completedResolvedRate < SWE_BENCH_BATCH_SUCCESS_THRESHOLD;
  const cacheBelowThreshold = batch.providerCacheRequestCount !== undefined &&
    batch.providerCacheRequestCount > 0 &&
    batch.providerCacheHitRate !== undefined &&
    batch.providerCacheHitRate < SWE_BENCH_PROVIDER_CACHE_THRESHOLD;
  if (!successBelowThreshold && !cacheBelowThreshold) return undefined;
  return {
    code: "SWE_BENCH_BATCH_BACKPRESSURE_ACTIVE",
    severity: "warn",
    message: "SWE-bench batch scheduling paused pending tasks because completed success rate or provider cache hit rate is below the review threshold.",
    metadata: {
      successThreshold: SWE_BENCH_BATCH_SUCCESS_THRESHOLD,
      providerCacheThreshold: SWE_BENCH_PROVIDER_CACHE_THRESHOLD,
      minimumCompletedTasks: SWE_BENCH_BATCH_BACKPRESSURE_MIN_COMPLETED,
      completedTasks: batch.completedTasks,
      resolvedTasks: batch.resolvedTasks,
      completedResolvedRate: batch.completedResolvedRate,
      providerCacheHitRate: batch.providerCacheHitRate,
      providerCacheRequestCount: batch.providerCacheRequestCount,
      pendingTaskNumbers,
      rampStatus: "blocked",
      blockedExpansionTaskNumbers: pendingTaskNumbers,
      nextAllowedActions: SWE_BENCH_BATCH_BACKPRESSURE_NEXT_ALLOWED_ACTIONS,
      canaryCandidateTaskNumbers: batch.taskStates
        .filter((state) => (state.status === "unresolved" || state.status === "failed") && Boolean(state.runId))
        .map((state) => state.taskNumber),
      reasonCodes: [
        ...(successBelowThreshold ? ["SWE_BENCH_COMPLETED_SUCCESS_RATE_BELOW_THRESHOLD"] : []),
        ...(cacheBelowThreshold ? ["SWE_BENCH_PROVIDER_CACHE_RATE_BELOW_THRESHOLD"] : [])
      ]
    },
    redaction: { class: "internal", fields: ["metadata"] }
  };
}

async function readExistingResumableSummary(platform: PlatformRuntime, path: string, diagnostics: JsonObject[]): Promise<SweBenchRunSummary | undefined> {
  const content = await platform.readFile(path).catch(() => "");
  if (!content.trim()) return undefined;
  try {
    const parsed = JSON.parse(content) as JsonObject;
    const recovered = await recoveredHarnessSidecarSummary(platform, path, parsed, diagnostics);
    if (recovered) {
      await persistSummary(platform, path, recovered, diagnostics);
      return recovered;
    }
    if (isResumableTerminalSummary(parsed)) {
      const refreshed = await refreshResumableSummaryFromTrace(platform, path, parsed as SweBenchRunSummary, diagnostics);
      await persistSummary(platform, path, refreshed, diagnostics);
      return refreshed;
    }
  } catch (error) {
    diagnostics.push({
      code: "SWE_BENCH_RESUME_SUMMARY_INVALID",
      severity: "warn",
      message: error instanceof Error ? error.message : String(error),
      redaction: { class: "internal" }
    });
  }
  return undefined;
}

async function refreshResumableSummaryFromTrace(
  platform: PlatformRuntime,
  summaryPath: string,
  summary: SweBenchRunSummary,
  diagnostics: JsonObject[]
): Promise<SweBenchRunSummary> {
  const tracePath = `${dirname(summaryPath)}/trace.jsonl`;
  const cache = await readSweBenchCacheTrace(platform, tracePath, SWE_BENCH_PROVIDER_CACHE_THRESHOLD).catch(() => undefined);
  const childTrace = await platform.readFile(tracePath)
    .then(async (content) => enrichChildTraceWithRepoLocalPythonRunner(platform, summaryPath, summarizeSweBenchChildTrace(content, tracePath)))
    .catch(() => undefined);
  if (!cache && !childTrace) return refreshFailureAttribution(summary);
  const childTraceFields = childTrace ? childTraceSummaryFields(childTrace) : {};
  const childDiagnostics = childTrace ? childTraceDiagnostics(childTrace) : [];
  if (!cache) {
    const refreshedDiagnostics = mergeDiagnostics(withoutRefreshableChildTraceDiagnostics(summary.diagnostics), childDiagnostics);
    const refreshed: SweBenchRunSummary = {
      ...summary,
      ...childTraceFields,
      diagnostics: refreshedDiagnostics,
      ...(() => {
        const reviewCodes = reviewCodesFromDiagnostics(refreshedDiagnostics);
        return reviewCodes.length > 0 ? { reviewCodes } : {};
      })()
    };
    diagnostics.push({
      code: "SWE_BENCH_RESUME_TRACE_DIAGNOSTICS_REFRESHED",
      severity: "info",
      message: "Refreshed existing SWE-bench summary diagnostics from preserved child trace during resume.",
      metadata: { summaryPath, tracePath },
      redaction: { class: "internal", fields: ["metadata"] }
    });
    return refreshFailureAttribution(refreshed);
  }
  const refreshedDiagnostics = mergeDiagnostics(
    mergeDiagnostics(withoutRefreshableResumeTraceDiagnostics(summary.diagnostics), childDiagnostics),
    sweBenchCacheDiagnostics({ cache, cacheHitTarget: SWE_BENCH_PROVIDER_CACHE_THRESHOLD }).map(predictionDiagnostic)
  );
  const {
    contextProjectionCacheHitRate: _staleContextProjectionCacheHitRate,
    contextProjectionCacheRequestCount: _staleContextProjectionCacheRequestCount,
    ...summaryWithoutContextProjectionCache
  } = summary;
  const refreshed: SweBenchRunSummary = {
    ...summaryWithoutContextProjectionCache,
    ...childTraceFields,
    providerCacheHitRate: cache.provider.hitRate,
    providerCacheRequestCount: cache.provider.requestCount,
    contextProjectionCacheRequestCount: cache.contextProjection.requestCount,
    ...(cache.contextProjection.requestCount > 0 ? { contextProjectionCacheHitRate: cache.contextProjection.hitRate } : {}),
    diagnostics: refreshedDiagnostics,
    ...(() => {
      const reviewCodes = reviewCodesFromDiagnostics(refreshedDiagnostics);
      return reviewCodes.length > 0 ? { reviewCodes } : {};
    })()
  };
  diagnostics.push({
    code: "SWE_BENCH_RESUME_TRACE_DIAGNOSTICS_REFRESHED",
    severity: "info",
    message: "Refreshed existing SWE-bench summary diagnostics from preserved child trace during resume.",
    metadata: { summaryPath, tracePath },
    redaction: { class: "internal", fields: ["metadata"] }
  });
  return refreshFailureAttribution(refreshed);
}

async function enrichChildTraceWithRepoLocalPythonRunner(
  platform: PlatformRuntime,
  summaryPath: string,
  childTrace: SweBenchChildTraceSummary
): Promise<SweBenchChildTraceSummary> {
  const details = childTrace.testFailureDetails ?? [];
  if (!details.some((detail) => detail.kind === "python-missing-module" && isPythonTestLauncherModule(detail.moduleName) && !detail.alternateCommand)) {
    return childTrace;
  }
  const runner = await findRepoLocalPythonRunner(platform, dirname(summaryPath));
  if (!runner) return childTrace;
  const alternateCommand = `python ${runner}`;
  return {
    ...childTrace,
    testFailureDetails: details.map((detail) => {
      if (detail.kind !== "python-missing-module" || !isPythonTestLauncherModule(detail.moduleName) || detail.alternateCommand) return detail;
      return {
        ...detail,
        suggestedAction: "use-repo-local-python-test-runner",
        suggestedCommand: alternateCommand,
        alternateCommand,
        alternateRunnerPath: runner
      };
    })
  };
}

function isPythonTestLauncherModule(moduleName: string | undefined): boolean {
  return /^(?:pytest|nose|nose2)$/.test(moduleName ?? "");
}

async function findRepoLocalPythonRunner(platform: PlatformRuntime, runRoot: string): Promise<string | undefined> {
  for (const runner of ["tests/runtests.py", "runtests.py"]) {
    const path = platform.resolvePath(runRoot, "repo", runner);
    const content = await platform.readFile(path).catch(() => "");
    if (content.length > 0) return runner;
  }
  return undefined;
}

async function recoverPartialRunSummaryFromArtifacts(input: {
  readonly platform: PlatformRuntime;
  readonly workspaceRoot: string;
  readonly summaryPath: string;
  readonly taskNumber: number;
  readonly runId: string;
  readonly dryRun: boolean;
  readonly execute: boolean;
  readonly provider: "deepseek" | "glm";
  readonly model: string;
  readonly diagnostics: JsonObject[];
}): Promise<SweBenchRunSummary | undefined> {
  const runRoot = dirname(input.summaryPath);
  const tracePath = `${runRoot}/trace.jsonl`;
  const predictionPath = `${runRoot}/prediction.jsonl`;
  const [traceContent, predictionContent] = await Promise.all([
    input.platform.readFile(tracePath).catch(() => ""),
    input.platform.readFile(predictionPath).catch(() => "")
  ]);
  if (!traceContent.trim() && !predictionContent.trim()) return undefined;
  const childTrace = traceContent.trim()
    ? summarizeSweBenchChildTrace(traceContent, tracePath)
    : undefined;
  const cache = traceContent.trim()
    ? await readSweBenchCacheTrace(input.platform, tracePath, SWE_BENCH_PROVIDER_CACHE_THRESHOLD).catch(() => undefined)
    : undefined;
  const prediction = firstPredictionFromJsonl(predictionContent);
  const diagnostics = mergeDiagnostics(
    mergeDiagnostics(input.diagnostics, [
      {
        code: "SWE_BENCH_PARTIAL_RUN_RECOVERED",
        severity: "warn",
        message: "Recovered partial SWE-bench run evidence from trace and prediction artifacts because summary.json was missing.",
        metadata: { summaryPath: input.summaryPath, tracePath, predictionPath },
        redaction: { class: "internal", fields: ["metadata"] }
      },
      ...predictionDiagnosticsFromRecoveredArtifact(prediction),
      ...(childTrace ? childTraceDiagnostics(childTrace) : [])
    ]),
    cache ? sweBenchCacheDiagnostics({ cache, cacheHitTarget: SWE_BENCH_PROVIDER_CACHE_THRESHOLD }).map(predictionDiagnostic) : []
  );
  const reviewCodes = reviewCodesFromDiagnostics(diagnostics);
  const partial: SweBenchRunSummary = {
    schemaVersion: "1.0.0",
    kind: "capability.swe-bench.run.summary",
    status: "warn",
    taskNumber: input.taskNumber,
    runId: input.runId,
    dryRun: input.dryRun,
    execute: input.execute && !input.dryRun,
    provider: input.provider,
    model: input.model,
    evaluationStatus: "warn",
    evaluationResolved: false,
    ...(typeof prediction?.instance_id === "string" ? { instanceId: prediction.instance_id } : {}),
    ...(typeof prediction?.model_patch === "string" ? { patchBytes: Buffer.byteLength(prediction.model_patch, "utf8") } : {}),
    ...(cache ? { providerCacheHitRate: cache.provider.hitRate } : {}),
    ...(cache ? { providerCacheRequestCount: cache.provider.requestCount } : {}),
    ...(cache ? { providerCachePassed: cache.provider.requestCount > 0 && cache.provider.hitRate >= SWE_BENCH_PROVIDER_CACHE_THRESHOLD } : {}),
    ...(cache ? { contextProjectionCacheRequestCount: cache.contextProjection.requestCount } : {}),
    ...(cache && cache.contextProjection.requestCount > 0 ? { contextProjectionCacheHitRate: cache.contextProjection.hitRate } : {}),
    ...(reviewCodes.length > 0 ? { reviewCodes } : {}),
    ...(childTrace ? childTraceSummaryFields(childTrace) : {}),
    attemptCount: 1,
    commandCount: 0,
    diagnostics,
    redaction: { class: "internal", fields: ["diagnostics.metadata"] }
  };
  return refreshFailureAttribution(partial);
}

function firstPredictionFromJsonl(content: string): JsonObject | undefined {
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isJsonObject(parsed)) return parsed;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function predictionDiagnosticsFromRecoveredArtifact(prediction: JsonObject | undefined): readonly JsonObject[] {
  const patch = typeof prediction?.model_patch === "string" ? prediction.model_patch : undefined;
  if (patch === undefined || patch.trim().length > 0) return [];
  return [
    {
      code: "SWE_BENCH_EMPTY_PATCH",
      severity: "warn",
      message: "Recovered SWE-bench prediction patch is empty.",
      metadata: {
        instanceId: typeof prediction?.instance_id === "string" ? prediction.instance_id : undefined,
        modelName: typeof prediction?.model_name_or_path === "string" ? prediction.model_name_or_path : undefined
      },
      redaction: { class: "internal", fields: ["metadata"] }
    }
  ];
}

function refreshFailureAttribution(summary: SweBenchRunSummary): SweBenchRunSummary {
  const attribution = summary.status === "fail" || summary.evaluationResolved === false ? taskFailureAttribution(summary) : {};
  const { reasonCodes: _reasonCodes, primaryReasonCode: _primaryReasonCode, failureCategory: _failureCategory, actionability: _actionability, blockerIds: _blockerIds, ...base } = summary;
  return {
    ...base,
    ...attribution
  };
}

function mergeDiagnostics(existing: readonly JsonObject[], extra: readonly JsonObject[]): readonly JsonObject[] {
  const seen = new Set(existing.map(diagnosticIdentity));
  const merged = [...existing];
  for (const item of extra) {
    const key = diagnosticIdentity(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function withoutRefreshableCacheDiagnostics(diagnostics: readonly JsonObject[]): readonly JsonObject[] {
  return diagnostics.filter((entry) => {
    const code = typeof entry.code === "string" ? entry.code : "";
    return !refreshableCacheDiagnosticCodes.has(code);
  });
}

function withoutRefreshableChildTraceDiagnostics(diagnostics: readonly JsonObject[]): readonly JsonObject[] {
  return diagnostics.filter((entry) => {
    const code = typeof entry.code === "string" ? entry.code : "";
    return !refreshableChildTraceDiagnosticCodes.has(code);
  });
}

function withoutRefreshableResumeTraceDiagnostics(diagnostics: readonly JsonObject[]): readonly JsonObject[] {
  return withoutRefreshableChildTraceDiagnostics(withoutRefreshableCacheDiagnostics(diagnostics));
}

const refreshableCacheDiagnosticCodes = new Set([
  "SWE_BENCH_CACHE_HIT_TARGET_MISSED",
  "SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET",
  "SWE_BENCH_PROVIDER_CACHE_PIPELINE_TELEMETRY_ABSENT",
  "SWE_BENCH_PROVIDER_CACHE_PIPELINE_MISSING",
  "SWE_BENCH_PROVIDER_CACHE_PREFIX_HINT_UNSUPPORTED",
  "SWE_BENCH_PROVIDER_CACHE_PREFIX_HINT_MISSING",
  "SWE_BENCH_PROVIDER_CACHE_PREFIX_TOO_SMALL",
  "SWE_BENCH_PROVIDER_CACHE_PREFIX_COVERAGE_LOW",
  "SWE_BENCH_PROVIDER_CACHE_DYNAMIC_TAIL_MISS",
  "SWE_BENCH_PROVIDER_CACHE_PREFIX_DRIFT",
  "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_MISS",
  "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_TELEMETRY_MISSING",
  "SWE_BENCH_PROVIDER_CACHE_MULTI_MESSAGE_BREAKPOINT",
  "SWE_BENCH_PROVIDER_TOOL_SCHEMA_CACHE_GAP",
  "SWE_BENCH_PROVIDER_CACHE_HISTORY_TAIL_MISS",
  "SWE_BENCH_PROVIDER_HISTORY_UNBOUNDED_AFTER_GATE",
  "PROMPT_CACHE_PREFIX_BUSTED",
  "PROMPT_WHOLE_FINGERPRINT_DYNAMIC_WITH_STABLE_PREFIX",
  "SWE_BENCH_CONTEXT_PROJECTION_CACHE_NO_HIT",
  "SWE_BENCH_CONTEXT_PROJECTION_KEY_WHOLE_PROMPT_DYNAMIC",
  "SWE_BENCH_CACHE_METRIC_SCOPE_MISMATCH",
  "SWE_BENCH_CHILD_TRACE_TEST_UNSUCCESSFUL"
]);

const refreshableChildTraceDiagnosticCodes = new Set([
  "SWE_BENCH_CHILD_TRACE_TERMINAL_FAILED",
  "SWE_BENCH_CHILD_TRACE_VERIFICATION_MISSING",
  "SWE_BENCH_TEST_ENV_DEPENDENCY_INCOMPATIBLE",
  "SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING",
  "SWE_BENCH_TEST_ENTRYPOINT_MISSING",
  "SWE_BENCH_TEST_ARGUMENT_UNSUPPORTED",
  "SWE_BENCH_TEST_COMMAND_ENV_MISSCOPED",
  "SWE_BENCH_CHILD_TRACE_TEST_UNSUCCESSFUL",
  "SWE_BENCH_POST_EDIT_VERIFICATION_GATE",
  "SWE_BENCH_SOURCE_INSPECTION_GATE",
  "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"
]);

function diagnosticIdentity(item: JsonObject): string {
  const code = typeof item.code === "string" ? item.code : "";
  const message = typeof item.message === "string" ? item.message : "";
  return `${code}\n${message}`;
}

async function recoveredHarnessSidecarSummary(platform: PlatformRuntime, summaryPath: string, parsed: JsonObject, diagnostics: JsonObject[]): Promise<SweBenchRunSummary | undefined> {
  if (!hasRetryableFrameworkFailureDiagnostics(parsed)) return undefined;
  if (!isSweBenchRunSummaryShape(parsed)) return undefined;
  const sidecarPath = `${dirname(summaryPath)}/local-build-evaluate.json`;
  const content = await platform.readFile(sidecarPath).catch(() => "");
  if (!content.trim()) return undefined;
  try {
    const wrapper = JSON.parse(content) as JsonObject;
    const sweBench = isJsonObject(wrapper.sweBench) ? wrapper.sweBench : wrapper;
    const evaluation = isJsonObject(sweBench.evaluation) ? sweBench.evaluation : undefined;
    if (!evaluation) return undefined;
    const diagnosticsFromSidecar = Array.isArray(sweBench.diagnostics)
      ? sweBench.diagnostics.filter(isJsonObject).map((entry) => predictionDiagnostic(entry as SweBenchPredictionSummary["diagnostics"][number]))
      : [];
    diagnosticsFromSidecar.push({
      code: "SWE_BENCH_RECOVERED_HARNESS_SIDECAR_IMPORTED",
      severity: "info",
      message: "Recovered SWE-bench harness sidecar evidence replaced a stale framework report failure during resume.",
      metadata: { sidecarPath },
      redaction: { class: "internal", fields: ["metadata"] }
    });
    return {
      ...parsed,
      status: evaluation.resolved === true ? "pass" : "warn",
      evaluationStatus: typeof sweBench.status === "string" ? sweBench.status : evaluation.resolved === true ? "pass" : "warn",
      evaluationResolved: evaluation.resolved === true,
      evaluationResolvedRate: isJsonObject(evaluation.batch) && typeof evaluation.batch.resolvedRate === "number" ? evaluation.batch.resolvedRate : evaluation.resolved === true ? 1 : 0,
      ...(isJsonObject(evaluation.tests) && isJsonObject(evaluation.tests.failToPass) && typeof evaluation.tests.failToPass.failure === "number" ? { failToPassFailureCount: evaluation.tests.failToPass.failure } : {}),
      ...(isJsonObject(evaluation.tests) && isJsonObject(evaluation.tests.passToPass) && typeof evaluation.tests.passToPass.failure === "number" ? { passToPassFailureCount: evaluation.tests.passToPass.failure } : {}),
      diagnostics: diagnosticsFromSidecar,
      redaction: { class: "internal", fields: ["diagnostics.metadata"] }
    };
  } catch (error) {
    diagnostics.push({
      code: "SWE_BENCH_RECOVERED_HARNESS_SIDECAR_INVALID",
      severity: "warn",
      message: error instanceof Error ? error.message : String(error),
      metadata: { sidecarPath },
      redaction: { class: "internal", fields: ["metadata"] }
    });
  }
  return undefined;
}

function isSweBenchRunSummaryShape(value: JsonObject): value is SweBenchRunSummary {
  return value.schemaVersion === "1.0.0" &&
    value.kind === "capability.swe-bench.run.summary" &&
    (value.status === "pass" || value.status === "warn" || value.status === "fail") &&
    typeof value.taskNumber === "number" &&
    typeof value.runId === "string" &&
    typeof value.dryRun === "boolean" &&
    typeof value.execute === "boolean" &&
    (value.provider === "deepseek" || value.provider === "glm") &&
    typeof value.model === "string" &&
    typeof value.commandCount === "number" &&
    Array.isArray(value.diagnostics) &&
    isJsonObject(value.redaction);
}

function isResumableTerminalSummary(parsed: JsonObject): boolean {
  if (parsed.kind !== "capability.swe-bench.run.summary") return false;
  if (typeof parsed.taskNumber !== "number" || parsed.taskNumber <= 0) return false;
  if (parsed.evaluationResolved === true) return true;
  if (hasRetryableFrameworkFailureDiagnostics(parsed)) return false;
  if (parsed.status !== "pass" && parsed.status !== "warn" && parsed.status !== "fail") return false;
  return typeof parsed.evaluationStatus === "string" ||
    (typeof parsed.attemptCount === "number" && parsed.attemptCount > 0);
}

function hasRetryableFrameworkFailureDiagnostics(summary: JsonObject): boolean {
  const diagnostics = Array.isArray(summary.diagnostics) ? summary.diagnostics : [];
  return diagnostics.some((entry) => {
    if (!isJsonObject(entry)) return false;
    const code = typeof entry.code === "string" ? entry.code : "";
    return code === "SWE_BENCH_REPORT_READ_FAILED" ||
      code === "SWE_BENCH_REPORT_STAT_FAILED" ||
      code === "SWE_BENCH_REPORT_STALE" ||
      code === "SWE_BENCH_HARNESS_INSTANCE_ERROR" ||
      code === "SWE_BENCH_DOCKER_IMAGE_NOT_FOUND" ||
      code === "SWE_BENCH_HARNESS_FAILED" ||
      code === "SWE_BENCH_CACHE_TRACE_READ_FAILED";
  });
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function persistSummary(platform: PlatformRuntime, path: string, summary: SweBenchRunSummary, diagnostics: JsonObject[]): Promise<void> {
  await platform.writeFile(path, JSON.stringify(redactJsonSecrets(summary), null, 2) + "\n").catch((error: unknown) => {
    diagnostics.push({
      code: "SWE_BENCH_SUMMARY_WRITE_FAILED",
      severity: "warn",
      message: error instanceof Error ? error.message : String(error),
      redaction: { class: "internal" }
    });
  });
}

async function persistBatchProgress(
  platform: PlatformRuntime,
  runRoot: string,
  input: {
    readonly taskNumbers: readonly number[];
    readonly runId: string;
    readonly dryRun: boolean;
    readonly execute: boolean;
    readonly provider: "deepseek" | "glm";
    readonly model: string;
    readonly resumeOnly: boolean;
  },
  diagnostics: JsonObject[],
  children: readonly SweBenchRunSummary[],
  skippedTaskNumbers: readonly number[],
  commandCount: number
): Promise<void> {
  const batch = batchSummary(input.taskNumbers, children, skippedTaskNumbers, diagnostics, input.resumeOnly);
  const progress = batchRunSummary(input, diagnostics, batch, children, commandCount, "warn");
  await persistSummary(platform, platform.resolvePath(runRoot, "batch-summary.json"), progress, diagnostics);
}

async function persistRunProgress(
  platform: PlatformRuntime,
  runRoot: string,
  runId: string,
  taskNumber: number,
  stage: string,
  status: "started" | "completed" | "failed",
  diagnostics: JsonObject[],
  metadata: JsonObject = {}
): Promise<void> {
  const path = platform.resolvePath(runRoot, "run-progress.jsonl");
  const existing = await platform.readFile(path).catch(() => "");
  const record = {
    schemaVersion: "1.0.0",
    kind: "capability.swe-bench.run.progress",
    runId,
    taskNumber,
    stage,
    status,
    metadata,
    redaction: { class: "internal", fields: ["metadata"] }
  };
  await platform.writeFile(path, `${existing}${JSON.stringify(record)}\n`).catch((error: unknown) => {
    diagnostics.push({
      code: "SWE_BENCH_PROGRESS_WRITE_FAILED",
      severity: "warn",
      message: error instanceof Error ? error.message : String(error),
      metadata: { stage, path },
      redaction: { class: "internal", fields: ["metadata"] }
    });
  });
}

function runSummaryPath(platform: PlatformRuntime, workspaceRoot: string, runId: string): string {
  return platform.resolvePath(workspaceRoot, ".deepseek", "swe-lite-runs", runId, "summary.json");
}

function harnessPythonPath(platform: PlatformRuntime, workspaceRoot: string): string {
  return platform.resolvePath(workspaceRoot, ".deepseek", "swebench-venv", platform.os === "windows" ? "Scripts/python.exe" : "bin/python");
}

function uniqueHarnessEvaluationRunId(runId: string, attempt: number): string {
  sweBenchHarnessRunSequence = (sweBenchHarnessRunSequence % Number.MAX_SAFE_INTEGER) + 1;
  const suffix = `${Date.now().toString(36)}-${sweBenchHarnessRunSequence.toString(36)}`;
  return attempt === 1 ? `${runId}-evaluation-${suffix}` : `${runId}-evaluation-attempt-${attempt}-${suffix}`;
}

async function copyAttemptTraceToLatest(
  platform: PlatformRuntime,
  attemptTraceOutputPath: string,
  latestTraceOutputPath: string,
  diagnostics: JsonObject[]
): Promise<void> {
  try {
    await platform.writeFile(latestTraceOutputPath, await platform.readFile(attemptTraceOutputPath));
  } catch (error) {
    diagnostics.push(diagnostic(
      "SWE_BENCH_TRACE_LATEST_COPY_FAILED",
      error instanceof Error ? error.message : String(error)
    ));
  }
}

async function resolveDatasetInstance(platform: PlatformRuntime, workspaceRoot: string, taskNumber: number): Promise<SweBenchDatasetInstance> {
  const python = platform.resolvePath(workspaceRoot, ".deepseek", "swebench-venv", "bin", "python");
  const code = [
    "import json, sys",
    "from datasets import load_dataset",
    "idx = int(sys.argv[1]) - 1",
    "ds = load_dataset('SWE-bench/SWE-bench_Lite', split='test')",
    "row = ds[idx]",
    "print(json.dumps({",
    "  'instance_id': row['instance_id'],",
    "  'repo': row['repo'],",
    "  'base_commit': row['base_commit'],",
    "  'problem_statement': row['problem_statement'],",
    "}))"
  ].join("\n");
  const result = await platform.runProcess(python, ["-c", code, String(taskNumber)], {
    cwd: workspaceRoot,
    timeoutMs: 120_000,
    outputLimitBytes: 128_000,
    executionProfile: "noninteractive"
  });
  if (result.exitCode !== 0) throw new Error(`dataset resolver exited with code ${result.exitCode}`);
  const parsed = JSON.parse(result.stdout) as JsonObject;
  const instanceId = stringField(parsed, "instance_id");
  const repo = stringField(parsed, "repo");
  const baseCommit = stringField(parsed, "base_commit");
  const problemStatement = stringField(parsed, "problem_statement");
  if (!instanceId || !repo || !baseCommit || !problemStatement) throw new Error("dataset resolver returned incomplete instance metadata");
  return { instanceId, repo, baseCommit, problemStatement };
}

async function prepareCheckout(
  platform: PlatformRuntime,
  runRoot: string,
  repoDir: string,
  instance: SweBenchDatasetInstance,
  diagnostics: JsonObject[],
  timeoutMs: number
): Promise<number> {
  let commandCount = 0;
  const probe = await platform.runProcess("git", ["-C", repoDir, "rev-parse", "--is-inside-work-tree"], {
    cwd: runRoot,
    timeoutMs: 15_000,
    outputLimitBytes: 4096,
    executionProfile: "noninteractive"
  });
  commandCount += 1;
  if (probe.exitCode !== 0) {
    await platform.ensureDirectory(dirname(repoDir));
    const clone = await platform.runProcess("git", ["clone", `https://github.com/${instance.repo}.git`, repoDir], {
      cwd: runRoot,
      timeoutMs,
      outputLimitBytes: 16_384,
      executionProfile: "noninteractive"
    });
    commandCount += 1;
    if (clone.exitCode !== 0) {
      diagnostics.push(diagnostic("SWE_BENCH_CHECKOUT_FAILED", `git clone exited with code ${clone.exitCode}`));
      return commandCount;
    }
  } else {
    commandCount += await clearStaleGitIndexLock(platform, runRoot, repoDir, diagnostics);
    const preReset = await platform.runProcess("git", ["-C", repoDir, "reset", "--hard", instance.baseCommit], {
      cwd: runRoot,
      timeoutMs: 120_000,
      outputLimitBytes: 16_384,
      executionProfile: "noninteractive"
    });
    commandCount += 1;
    if (preReset.exitCode !== 0) {
      diagnostics.push(diagnostic("SWE_BENCH_CHECKOUT_FAILED", `git pre-checkout reset exited with code ${preReset.exitCode}`));
      return commandCount;
    }

    const preClean = await platform.runProcess("git", ["-C", repoDir, "clean", "-fdx", "-e", ".venv"], {
      cwd: runRoot,
      timeoutMs: 120_000,
      outputLimitBytes: 16_384,
      executionProfile: "noninteractive"
    });
    commandCount += 1;
    if (preClean.exitCode !== 0) {
      diagnostics.push(diagnostic("SWE_BENCH_CHECKOUT_FAILED", `git pre-checkout clean exited with code ${preClean.exitCode}`));
      return commandCount;
    }
  }
  const checkout = await platform.runProcess("git", ["-C", repoDir, "checkout", "-f", instance.baseCommit], {
    cwd: runRoot,
    timeoutMs: 120_000,
    outputLimitBytes: 16_384,
    executionProfile: "noninteractive"
  });
  commandCount += 1;
  if (checkout.exitCode !== 0) {
    diagnostics.push(diagnostic("SWE_BENCH_CHECKOUT_FAILED", `git checkout exited with code ${checkout.exitCode}`));
    return commandCount;
  }

  const reset = await platform.runProcess("git", ["-C", repoDir, "reset", "--hard", instance.baseCommit], {
    cwd: runRoot,
    timeoutMs: 120_000,
    outputLimitBytes: 16_384,
    executionProfile: "noninteractive"
  });
  commandCount += 1;
  if (reset.exitCode !== 0) {
    diagnostics.push(diagnostic("SWE_BENCH_CHECKOUT_FAILED", `git reset exited with code ${reset.exitCode}`));
    return commandCount;
  }

  const clean = await platform.runProcess("git", ["-C", repoDir, "clean", "-fdx", "-e", ".venv"], {
    cwd: runRoot,
    timeoutMs: 120_000,
    outputLimitBytes: 16_384,
    executionProfile: "noninteractive"
  });
  commandCount += 1;
  if (clean.exitCode !== 0) diagnostics.push(diagnostic("SWE_BENCH_CHECKOUT_FAILED", `git clean exited with code ${clean.exitCode}`));
  return commandCount;
}

async function clearStaleGitIndexLock(platform: PlatformRuntime, runRoot: string, repoDir: string, diagnostics: JsonObject[]): Promise<number> {
  const lockPath = platform.resolvePath(repoDir, ".git", "index.lock");
  const result = await platform.runProcess(process.execPath, [
    "-e",
    "require('node:fs').rmSync(process.argv[1], { force: true });",
    lockPath
  ], {
    cwd: runRoot,
    timeoutMs: 15_000,
    outputLimitBytes: 4096,
    executionProfile: "noninteractive"
  });
  if (result.exitCode !== 0) {
    diagnostics.push(diagnostic("SWE_BENCH_GIT_LOCK_CLEANUP_WARN", `stale git index lock cleanup exited with code ${result.exitCode}`, "warn"));
  }
  return 1;
}

async function prepareRunScopedCheckoutEnvironment(
  platform: PlatformRuntime,
  runRoot: string,
  repoDir: string,
  diagnostics: JsonObject[],
  timeoutMs: number
): Promise<number> {
  let commandCount = 0;
  const venvDir = platform.resolvePath(repoDir, ".venv");
  const venvPython = checkoutVenvPythonPath(platform, repoDir);
  const profile = await checkoutEnvironmentProfile(platform, repoDir);
  const create = await platform.runProcess(profile.pythonCommand, ["-m", "venv", "--clear", venvDir], {
    cwd: runRoot,
    timeoutMs: 120_000,
    outputLimitBytes: 16_384,
    executionProfile: "noninteractive"
  });
  commandCount += 1;
  if (create.exitCode !== 0) {
    diagnostics.push({
      ...diagnostic("SWE_BENCH_CHECKOUT_ENV_FAILED", `checkout virtualenv creation exited with code ${create.exitCode}`),
      severity: "error"
    });
    return commandCount;
  }

  const constraintPath = platform.resolvePath(runRoot, "checkout-constraints.txt");
  await platform.writeFile(constraintPath, `${profile.constraints.join("\n")}\n`);
  const pipEnv: JsonObject = {
    PIP_CONSTRAINT: constraintPath,
    PIP_BUILD_CONSTRAINT: constraintPath,
    ...profile.env
  };

  const bootstrap = await platform.runProcess(venvPython, ["-m", "pip", "install", "setuptools==68.0.0", "wheel"], {
    cwd: repoDir,
    env: pipEnv,
    timeoutMs: Math.max(120_000, Math.min(timeoutMs, 900_000)),
    outputLimitBytes: 32_768,
    executionProfile: "noninteractive"
  });
  commandCount += 1;
  if (bootstrap.exitCode !== 0) {
    diagnostics.push(processDiagnostic({
      code: "SWE_BENCH_CHECKOUT_ENV_WARN",
      message: `checkout virtualenv bootstrap exited with code ${bootstrap.exitCode}`,
      severity: "warn",
      command: venvPython,
      args: ["-m", "pip", "install", "setuptools==68.0.0", "wheel"],
      cwd: repoDir,
      result: bootstrap
    }));
  }

  const editableArgs = ["-m", "pip", "install", "-e", profile.editableTarget];
  const editable = await platform.runProcess(venvPython, editableArgs, {
    cwd: repoDir,
    env: pipEnv,
    timeoutMs: Math.max(120_000, Math.min(timeoutMs, 1_800_000)),
    outputLimitBytes: 32_768,
    executionProfile: "noninteractive"
  });
  commandCount += 1;
  if (editable.exitCode !== 0) {
    diagnostics.push(processDiagnostic({
      code: "SWE_BENCH_CHECKOUT_ENV_WARN",
      message: `checkout editable install exited with code ${editable.exitCode}`,
      severity: "warn",
      command: venvPython,
      args: editableArgs,
      cwd: repoDir,
      result: editable
    }));
  }
  return commandCount;
}

async function checkoutEnvironmentProfile(platform: PlatformRuntime, repoDir: string): Promise<{
  readonly pythonCommand: string;
  readonly editableTarget: string;
  readonly constraints: readonly string[];
  readonly env: JsonObject;
}> {
  const metadata = await readCheckoutPackageMetadata(platform, repoDir);
  const lowerMetadata = metadata.toLowerCase();
  const legacyPython = prefersLegacyPython(metadata);
  const needsNumpyApiCap = legacyPython && lowerMetadata.includes("numpy");
  const needsCythonApiCap = legacyPython && lowerMetadata.includes("cython");
  const constraints = [
    "setuptools==68.0.0",
    ...(needsNumpyApiCap ? ["numpy<2"] : []),
    ...(needsCythonApiCap ? ["Cython<3"] : [])
  ];
  return {
    pythonCommand: legacyPython ? "python3.9" : "python3.12",
    editableTarget: hasTestExtra(metadata) ? ".[test]" : ".",
    constraints,
    env: needsCythonApiCap ? { CFLAGS: "-Wno-error=implicit-function-declaration" } : {}
  };
}

async function readCheckoutPackageMetadata(platform: PlatformRuntime, repoDir: string): Promise<string> {
  const candidates = ["pyproject.toml", "setup.cfg", "setup.py"];
  const contents: string[] = [];
  for (const file of candidates) {
    const content = await platform.readFile(platform.resolvePath(repoDir, file)).catch(() => "");
    if (content.trim()) contents.push(content);
  }
  return contents.join("\n");
}

function prefersLegacyPython(metadata: string): boolean {
  const requiresPython = pythonRequirement(metadata);
  if (!requiresPython) return false;
  const minimum = minimumPythonVersion(requiresPython);
  const maximum = maximumPythonVersion(requiresPython);
  if (maximum !== undefined && maximum <= 9) return true;
  return minimum !== undefined && minimum <= 9;
}

function pythonRequirement(metadata: string): string {
  const pyprojectMatch = /requires-python\s*=\s*["']([^"']+)["']/i.exec(metadata);
  if (pyprojectMatch?.[1]) return pyprojectMatch[1];
  const setupCfgMatch = /python_requires\s*=\s*([^\n]+)/i.exec(metadata);
  if (setupCfgMatch?.[1]) return setupCfgMatch[1].trim();
  const setupPyMatch = /python_requires\s*=\s*["']([^"']+)["']/i.exec(metadata);
  return setupPyMatch?.[1] ?? "";
}

function minimumPythonVersion(requirement: string): number | undefined {
  const matches = [...requirement.matchAll(/(?:^|[, ]+)>==?\s*3\.(\d+)/g)];
  const minors = matches.map((match) => Number(match[1])).filter((value) => Number.isFinite(value));
  return minors.length > 0 ? Math.min(...minors) : undefined;
}

function maximumPythonVersion(requirement: string): number | undefined {
  const matches = [...requirement.matchAll(/(?:^|[, ]+)<\s*3\.(\d+)/g)];
  const minors = matches.map((match) => Number(match[1]) - 1).filter((value) => Number.isFinite(value));
  return minors.length > 0 ? Math.min(...minors) : undefined;
}

function hasTestExtra(metadata: string): boolean {
  return (
    /\[project\.optional-dependencies\][\s\S]*?\btest\s*=/i.test(metadata)
    || /\[options\.extras_require\][\s\S]*?\btest\s*=/i.test(metadata)
    || /extras_require\s*=\s*\{[\s\S]*?["']test["']\s*:/i.test(metadata)
  );
}

function checkoutVenvPythonPath(platform: PlatformRuntime, repoDir: string): string {
  return platform.resolvePath(repoDir, ".venv", platform.os === "windows" ? "Scripts/python.exe" : "bin/python");
}

function summary(input: {
  readonly input: {
    readonly taskNumber: number;
    readonly runId: string;
    readonly dryRun: boolean;
    readonly execute: boolean;
    readonly provider: "deepseek" | "glm";
    readonly model: string;
  };
  readonly diagnostics: readonly JsonObject[];
  readonly environmentStatus?: string;
  readonly prediction?: SweBenchPredictionSummary;
  readonly evaluation?: SweBenchPredictionSummary;
  readonly instanceId?: string;
  readonly attemptCount?: number;
  readonly repairAttempted?: boolean;
  readonly commandCount: number;
  readonly status: "pass" | "warn" | "fail";
}): SweBenchRunSummary {
  const prediction = input.prediction;
  const evaluation = input.evaluation;
  const score = evaluation?.evaluation;
  const childTrace = prediction?.childTrace;
  const patchBytes = prediction?.predictions[0]?.model_patch.length;
  const diagnostics = runSummaryDiagnostics(
    mergeDiagnostics(input.diagnostics, childTrace ? childTraceDiagnostics(childTrace) : []),
    score?.cache
  );
  const reviewCodes = reviewCodesFromDiagnostics(diagnostics);
  const base: SweBenchRunSummary = {
    schemaVersion: "1.0.0",
    kind: "capability.swe-bench.run.summary",
    status: input.status,
    taskNumber: input.input.taskNumber,
    runId: input.input.runId,
    dryRun: input.input.dryRun,
    execute: input.input.execute && !input.input.dryRun,
    provider: input.input.provider,
    model: input.input.model,
    ...(input.instanceId ? { instanceId: input.instanceId } : {}),
    ...(input.environmentStatus ? { environmentStatus: input.environmentStatus } : {}),
    ...(prediction ? { predictionStatus: prediction.status } : {}),
    ...(evaluation ? { evaluationStatus: evaluation.status } : {}),
    ...(score ? { evaluationResolved: score.resolved } : {}),
    ...(score ? { evaluationResolvedRate: score.batch.resolvedRate } : {}),
    ...(score ? { failToPassFailureCount: score.tests.failToPass.failure } : {}),
    ...(score ? { passToPassFailureCount: score.tests.passToPass.failure } : {}),
    ...(score?.cache ? { providerCacheHitRate: score.cache.provider.hitRate } : {}),
    ...(score?.cache ? { providerCacheRequestCount: score.cache.provider.requestCount } : {}),
    ...(score?.cache ? { providerCachePassed: score.cache.provider.requestCount > 0 && score.cache.provider.hitRate >= SWE_BENCH_PROVIDER_CACHE_THRESHOLD } : {}),
    ...(score?.cache ? { contextProjectionCacheRequestCount: score.cache.contextProjection.requestCount } : {}),
    ...(score?.cache && score.cache.contextProjection.requestCount > 0 ? { contextProjectionCacheHitRate: score.cache.contextProjection.hitRate } : {}),
    ...(reviewCodes.length > 0 ? { reviewCodes } : {}),
    ...(childTrace ? childTraceSummaryFields(childTrace) : {}),
    ...(childTrace ? { childShellCommandCount: childTrace.shellCommandCount } : {}),
    ...(childTrace ? { verificationCommandMissing: childTrace.shellCommandCount > 0 && childTrace.testCommandCount === 0 } : {}),
    ...(patchBytes !== undefined ? { patchBytes } : {}),
    ...(input.attemptCount !== undefined ? { attemptCount: input.attemptCount } : {}),
    ...(input.repairAttempted !== undefined ? { repairAttempted: input.repairAttempted } : {}),
    commandCount: input.commandCount,
    diagnostics,
    redaction: { class: "internal", fields: ["diagnostics.metadata"] }
  };
  const attribution = base.status === "fail" || base.evaluationResolved === false ? taskFailureAttribution(base) : {};
  return {
    ...base,
    ...attribution
  };
}

function runSummaryDiagnostics(
  diagnostics: readonly JsonObject[],
  cache: SweBenchEvaluationCacheSummary | undefined
): readonly JsonObject[] {
  if (!cache || cache.provider.requestCount === 0 || cache.provider.hitRate >= SWE_BENCH_PROVIDER_CACHE_THRESHOLD) return diagnostics;
  return mergeDiagnostics(diagnostics, [
    predictionDiagnostic({
      code: "SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET",
      severity: "warn",
      message: "SWE-bench provider token cache hit rate is below the 90% readiness target.",
      metadata: {
        targetHitRate: SWE_BENCH_PROVIDER_CACHE_THRESHOLD,
        hitRate: cache.provider.hitRate,
        hitTokens: cache.provider.hitTokens,
        missTokens: cache.provider.missTokens,
        requestCount: cache.provider.requestCount,
        lowHitRequestCount: cache.provider.lowHitRequestCount
      },
      redaction: { class: "internal", fields: ["metadata"] }
    })
  ]);
}

function resultFromSummary(summary: SweBenchRunSummary, context: CapabilityExecutionContext): SerializableResult<CoreToolResult> {
  const value: CoreToolResult = {
      evidence: {
        tool: "swe.bench.run",
        status: summary.status === "pass" ? "completed" : "failed",
      affectedPaths: [],
      preview: boundedText(previewText(summary), 4_000),
      diagnostics: [],
      metadata: redactJsonSecrets(summary) as JsonObject,
      replay: { ...replay(context), snapshot: "cli-swe-bench-run-evidence" },
      redaction: { class: "internal", fields: ["metadata"] }
    }
  };
  if (summary.status === "fail" && !hasStructuredRunEvidence(summary)) {
    return {
      ok: false,
      value,
      error: {
        code: "CLI_SWE_BENCH_RUN_FAILED",
        message: "SWE-bench run capability failed before producing a successful prediction.",
        retryable: true,
        redaction: { class: "internal" }
      }
    };
  }
  return { ok: true, value };
}

function hasStructuredRunEvidence(summary: SweBenchRunSummary): boolean {
  return Boolean(summary.predictionStatus || summary.evaluationStatus || summary.instanceId || summary.batch);
}

function invalidResult(input: JsonObject, context: CapabilityExecutionContext): SerializableResult<CoreToolResult> {
  return resultFromSummary({
    schemaVersion: "1.0.0",
    kind: "capability.swe-bench.run.summary",
    status: "fail",
    taskNumber: 0,
    runId: "invalid",
    dryRun: true,
    execute: false,
    provider: input.provider === "deepseek" ? "deepseek" : "glm",
    model: stringField(input, "model") ?? "glm-5.1",
    commandCount: 0,
    diagnostics: [diagnostic("SWE_BENCH_RUN_INVALID_INPUT", "taskNumber must be a positive integer")],
    redaction: { class: "internal", fields: ["diagnostics.metadata"] }
  }, context);
}

function previewText(summary: SweBenchRunSummary): string {
  if (summary.batch) {
    return [
      `core.swe.bench.run batch runId=${summary.runId} status=${summary.status} execute=${summary.execute}`,
      `batch tasks=${summary.batch.totalTasks} resolved=${summary.batch.resolvedTasks} unresolved=${summary.batch.unresolvedTasks} skipped=${summary.batch.skippedTasks}${resumedTaskCount(summary.batch) > 0 ? ` resumed=${resumedTaskCount(summary.batch)}` : ""} rate=${formatRate(summary.batch.resolvedRate)}`,
      `completedRate=${formatRate(summary.batch.completedResolvedRate)} completed=${summary.batch.completedTasks}`,
      `failed=${summary.batch.failedTasks} completed=${summary.batch.completedTasks}`,
      summary.batch.providerCacheHitRate !== undefined ? `providerCache hitRate=${formatRate(summary.batch.providerCacheHitRate)} requests=${summary.batch.providerCacheRequestCount ?? 0}` : "providerCache hitRate=unknown requests=0",
      summary.batch.contextProjectionCacheHitRate !== undefined ? `contextProjectionCache hitRate=${formatRate(summary.batch.contextProjectionCacheHitRate)} requests=${summary.batch.contextProjectionCacheRequestCount ?? 0}` : "contextProjectionCache hitRate=unknown requests=0",
      summary.batch.reviewCodes && summary.batch.reviewCodes.length > 0 ? `reviewCodes=${summary.batch.reviewCodes.join(",")}` : "reviewCodes=none",
      `taskReview=${batchTaskReviewPreview(summary.batch.taskStates)}`,
      `taskNumbers=${summary.batch.taskNumbers.join(",")}`,
      `unresolved=${summary.batch.unresolvedTaskNumbers.join(",") || "none"}`,
      `commands=${summary.commandCount} diagnostics=${summary.diagnostics.length}`
    ].join("\n");
  }
  return [
    `core.swe.bench.run taskNumber=${summary.taskNumber} runId=${summary.runId} status=${summary.status} execute=${summary.execute}`,
    summary.instanceId ? `instance=${summary.instanceId}` : "instance=pending",
    `environment=${summary.environmentStatus ?? "not-run"} prediction=${summary.predictionStatus ?? "not-run"} patchBytes=${summary.patchBytes ?? 0}`,
    `evaluation=${summary.evaluationStatus ?? "not-run"} resolved=${summary.evaluationResolved === true ? "true" : summary.evaluationResolved === false ? "false" : "unknown"} rate=${formatRate(summary.evaluationResolvedRate)}`,
    summary.providerCacheHitRate !== undefined ? `providerCache hitRate=${formatRate(summary.providerCacheHitRate)} requests=${summary.providerCacheRequestCount ?? 0}` : "providerCache hitRate=unknown requests=0",
    summary.contextProjectionCacheHitRate !== undefined ? `contextProjectionCache hitRate=${formatRate(summary.contextProjectionCacheHitRate)} requests=${summary.contextProjectionCacheRequestCount ?? 0}` : "contextProjectionCache hitRate=unknown requests=0",
    summary.reviewCodes && summary.reviewCodes.length > 0 ? `reviewCodes=${summary.reviewCodes.join(",")}` : "reviewCodes=none",
    summary.primaryReasonCode ? `failure=${summary.primaryReasonCode} action=${summary.actionability ?? "unknown"}` : "failure=none action=none",
    `failToPassFailure=${summary.failToPassFailureCount ?? 0} passToPassFailure=${summary.passToPassFailureCount ?? 0}`,
    `childTrace terminal=${summary.childTerminalReason ?? summary.childTerminalKind ?? "unknown"} iterations=${summary.childIterationCount ?? 0} modelRequests=${summary.childModelRequestCount ?? 0} shell=${summary.childShellCommandCount ?? 0} tests=${summary.childTestCommandCount ?? 0} successfulTests=${summary.childSuccessfulTestCommandCount ?? 0} verification=${summary.verificationCommandMissing === true ? "missing" : summary.childShellCommandCount === undefined ? "unknown" : "seen"}`,
    `attempts=${summary.attemptCount ?? 0} repair=${summary.repairAttempted === true ? "true" : "false"}`,
    `commands=${summary.commandCount} diagnostics=${summary.diagnostics.length}`
  ].join("\n");
}

function resumedTaskCount(batch: SweBenchRunBatchSummary): number {
  return batch.resumedTaskNumbers?.length ?? 0;
}

function childTraceSummaryFields(childTrace: NonNullable<SweBenchPredictionSummary["childTrace"]>): Partial<SweBenchRunSummary> {
  return {
    ...(childTrace.terminalKind ? { childTerminalKind: childTrace.terminalKind } : {}),
    ...(childTrace.terminalStatus ? { childTerminalStatus: childTrace.terminalStatus } : {}),
    ...(childTrace.terminalReason ? { childTerminalReason: childTrace.terminalReason } : {}),
    childIterationCount: childTrace.iterationCount,
    childModelRequestCount: childTrace.modelRequestCount,
    childToolIntentCount: childTrace.toolIntentCount,
    childSourceInspectionToolCount: childTrace.sourceInspectionToolCount,
    childSourceMutationCount: childTrace.sourceMutationCount,
    childShellCommandCount: childTrace.shellCommandCount,
    childTestCommandCount: childTrace.testCommandCount,
    childSuccessfulTestCommandCount: childTrace.successfulTestCommandCount,
    verificationCommandMissing: childTrace.shellCommandCount > 0 && childTrace.testCommandCount === 0
  };
}

function childTraceDiagnostics(childTrace: SweBenchChildTraceSummary): readonly JsonObject[] {
  const codes = new Set(childTrace.diagnosticCodes);
  const diagnostics: JsonObject[] = [];
  if (codes.has("SWE_BENCH_CHILD_TRACE_TERMINAL_FAILED")) {
    diagnostics.push(predictionDiagnostic({
      code: "SWE_BENCH_CHILD_TRACE_TERMINAL_FAILED",
      severity: "warn",
      message: "SWE-bench child CLI trace did not end with a clean completed event.",
      metadata: {
        terminalKind: childTrace.terminalKind ?? "",
        terminalStatus: childTrace.terminalStatus ?? "",
        terminalReason: childTrace.terminalReason ?? "",
        iterationCount: childTrace.iterationCount,
        modelRequestCount: childTrace.modelRequestCount,
        toolIntentCount: childTrace.toolIntentCount
      },
      redaction: { class: "internal", fields: ["metadata"] }
    }));
  }
  if (codes.has("SWE_BENCH_CHILD_TRACE_VERIFICATION_MISSING")) {
    diagnostics.push(predictionDiagnostic({
      code: "SWE_BENCH_CHILD_TRACE_VERIFICATION_MISSING",
      severity: "warn",
      message: "SWE-bench child CLI trace did not include a model-authored test command before prediction collation.",
      metadata: {
        shellCommandCount: childTrace.shellCommandCount,
        testCommandCount: childTrace.testCommandCount,
        iterationCount: childTrace.iterationCount,
        modelRequestCount: childTrace.modelRequestCount,
        toolIntentCount: childTrace.toolIntentCount
      },
      redaction: { class: "internal", fields: ["metadata"] }
    }));
  }
  if (codes.has("SWE_BENCH_TEST_ENV_DEPENDENCY_INCOMPATIBLE")) {
    diagnostics.push(predictionDiagnostic({
      code: "SWE_BENCH_TEST_ENV_DEPENDENCY_INCOMPATIBLE",
      severity: "warn",
      message: "SWE-bench child test command failed during pytest setup because the checkout dependency set is incompatible.",
      metadata: {
        terminalKind: childTrace.terminalKind ?? "",
        terminalReason: childTrace.terminalReason ?? "",
        testCommandCount: childTrace.testCommandCount,
        ...pythonTestFailureMetadata(childTrace)
      },
      redaction: { class: "internal", fields: ["metadata"] }
    }));
  }
  if (codes.has("SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING")) {
    diagnostics.push(predictionDiagnostic({
      code: "SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING",
      severity: "warn",
      message: "SWE-bench child test command failed because a checkout-local Python test dependency is missing.",
      metadata: {
        terminalKind: childTrace.terminalKind ?? "",
        terminalReason: childTrace.terminalReason ?? "",
        testCommandCount: childTrace.testCommandCount,
        ...pythonTestFailureMetadata(childTrace)
      },
      redaction: { class: "internal", fields: ["metadata"] }
    }));
  }
  if (codes.has("SWE_BENCH_TEST_ENTRYPOINT_MISSING")) {
    diagnostics.push(predictionDiagnostic({
      code: "SWE_BENCH_TEST_ENTRYPOINT_MISSING",
      severity: "warn",
      message: "SWE-bench child invoked a Python test runner path that does not exist in the checkout.",
      metadata: {
        terminalKind: childTrace.terminalKind ?? "",
        terminalReason: childTrace.terminalReason ?? "",
        testCommandCount: childTrace.testCommandCount,
        ...pythonTestFailureMetadata(childTrace)
      },
      redaction: { class: "internal", fields: ["metadata"] }
    }));
  }
  if (codes.has("SWE_BENCH_TEST_ARGUMENT_UNSUPPORTED")) {
    diagnostics.push(predictionDiagnostic({
      code: "SWE_BENCH_TEST_ARGUMENT_UNSUPPORTED",
      severity: "warn",
      message: "SWE-bench child invoked a Python test runner with unsupported arguments.",
      metadata: {
        terminalKind: childTrace.terminalKind ?? "",
        terminalReason: childTrace.terminalReason ?? "",
        testCommandCount: childTrace.testCommandCount,
        ...pythonTestFailureMetadata(childTrace)
      },
      redaction: { class: "internal", fields: ["metadata"] }
    }));
  }
  if (codes.has("SWE_BENCH_TEST_COMMAND_ENV_MISSCOPED")) {
    diagnostics.push(predictionDiagnostic({
      code: "SWE_BENCH_TEST_COMMAND_ENV_MISSCOPED",
      severity: "warn",
      message: "SWE-bench child invoked a Python test command from the wrong cwd, settings, or module scope.",
      metadata: {
        terminalKind: childTrace.terminalKind ?? "",
        terminalReason: childTrace.terminalReason ?? "",
        testCommandCount: childTrace.testCommandCount,
        ...pythonTestFailureMetadata(childTrace)
      },
      redaction: { class: "internal", fields: ["metadata"] }
    }));
  }
  if (codes.has("SWE_BENCH_CHILD_TRACE_TEST_UNSUCCESSFUL")) {
    diagnostics.push(predictionDiagnostic({
      code: "SWE_BENCH_CHILD_TRACE_TEST_UNSUCCESSFUL",
      severity: "warn",
      message: "SWE-bench child trace included local test attempts but no successful test command.",
      metadata: {
        terminalKind: childTrace.terminalKind ?? "",
        terminalReason: childTrace.terminalReason ?? "",
        shellCommandCount: childTrace.shellCommandCount,
        testCommandCount: childTrace.testCommandCount,
        successfulTestCommandCount: childTrace.successfulTestCommandCount,
        sourceMutationCount: childTrace.sourceMutationCount
      },
      redaction: { class: "internal", fields: ["metadata"] }
    }));
  }
  if (codes.has("SWE_BENCH_READY_FOR_HARNESS_GATE_MISSING")) {
    diagnostics.push(predictionDiagnostic({
      code: "SWE_BENCH_READY_FOR_HARNESS_GATE_MISSING",
      severity: "warn",
      message: "SWE-bench child had source mutation and successful local test evidence but did not return through the ready-for-harness gate.",
      metadata: {
        terminalKind: childTrace.terminalKind ?? "",
        terminalReason: childTrace.terminalReason ?? "",
        modelRequestCount: childTrace.modelRequestCount,
        sourceMutationCount: childTrace.sourceMutationCount,
        testCommandCount: childTrace.testCommandCount,
        successfulTestCommandCount: childTrace.successfulTestCommandCount
      },
      redaction: { class: "internal", fields: ["metadata"] }
    }));
  }
  if (childTrace.blockerFindings.some((finding) => finding.blockerId === "agentic.blocker.106.post-edit-verification-missing")) {
    diagnostics.push(predictionDiagnostic({
      code: "SWE_BENCH_POST_EDIT_VERIFICATION_GATE",
      severity: "warn",
      message: "SWE-bench child edited source after heavy inspection but did not run a model-authored standard test command before more exploration.",
      metadata: {
        terminalKind: childTrace.terminalKind ?? "",
        terminalReason: childTrace.terminalReason ?? "",
        sourceInspectionToolCount: childTrace.sourceInspectionToolCount,
        sourceMutationCount: childTrace.sourceMutationCount,
        testCommandCount: childTrace.testCommandCount
      },
      redaction: { class: "internal", fields: ["metadata"] }
    }));
  }
  if (codes.has("SWE_BENCH_SOURCE_INSPECTION_GATE") || codes.has("SWE_BENCH_SOURCE_INSPECTION_GATE_ENFORCED")) {
    diagnostics.push(predictionDiagnostic({
      code: "SWE_BENCH_SOURCE_INSPECTION_GATE",
      severity: "warn",
      message: "SWE-bench child spent the source-inspection budget on read/search/list tools without source mutation or test progress.",
      metadata: {
        terminalKind: childTrace.terminalKind ?? "",
        terminalReason: childTrace.terminalReason ?? "",
        sourceInspectionToolCount: childTrace.sourceInspectionToolCount,
        sourceMutationCount: childTrace.sourceMutationCount,
        testCommandCount: childTrace.testCommandCount,
        blockerIds: childTrace.blockerFindings.map((finding) => finding.blockerId)
      },
      redaction: { class: "internal", fields: ["metadata"] }
    }));
  }
  if (codes.has("SWE_BENCH_SOURCE_INSPECTION_DEFIANCE_GATE")) {
    diagnostics.push(predictionDiagnostic({
      code: "SWE_BENCH_SOURCE_INSPECTION_DEFIANCE_GATE",
      severity: "warn",
      message: "SWE-bench child repeatedly requested source inspection after the source-inspection gate required edit, test, or bounded blocker progress.",
      metadata: {
        terminalKind: childTrace.terminalKind ?? "",
        terminalReason: childTrace.terminalReason ?? "",
        sourceInspectionToolCount: childTrace.sourceInspectionToolCount,
        sourceMutationCount: childTrace.sourceMutationCount,
        testCommandCount: childTrace.testCommandCount,
        blockerIds: childTrace.blockerFindings.map((finding) => finding.blockerId)
      },
      redaction: { class: "internal", fields: ["metadata"] }
    }));
  }
  if (codes.has("SWE_BENCH_ENVIRONMENT_BLOCKER_GATE")) {
    diagnostics.push(predictionDiagnostic({
      code: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
      severity: "warn",
      message: "SWE-bench child reached the environment blocker gate after local verification or setup evidence.",
      metadata: {
        terminalKind: childTrace.terminalKind ?? "",
        terminalReason: childTrace.terminalReason ?? "",
        shellCommandCount: childTrace.shellCommandCount,
        testCommandCount: childTrace.testCommandCount,
        sourceMutationCount: childTrace.sourceMutationCount,
        blockerIds: childTrace.blockerFindings.map((finding) => finding.blockerId),
        ...pythonTestFailureMetadata(childTrace)
      },
      redaction: { class: "internal", fields: ["metadata"] }
    }));
  }
  return diagnostics;
}

function pythonTestFailureMetadata(childTrace: SweBenchChildTraceSummary): JsonObject {
  const details = childTrace.testFailureDetails ?? [];
  return details.length > 0 ? {
    testFailureDetailCount: details.length,
    testFailureDetails: details as unknown as JsonObject[]
  } : {};
}

function combinedStatus(
  predictionStatus: "pass" | "warn" | "fail",
  evaluationStatus: "pass" | "warn" | "fail",
  diagnostics: readonly JsonObject[]
): "pass" | "warn" | "fail" {
  if (predictionStatus === "fail" || evaluationStatus === "fail" || diagnostics.some((entry) => entry.severity === "error")) return "fail";
  if (predictionStatus === "warn" || evaluationStatus === "warn" || diagnostics.some((entry) => entry.severity === "warn")) return "warn";
  return "pass";
}

function reviewCodesFromDiagnostics(diagnostics: readonly JsonObject[]): readonly string[] {
  const codes = diagnostics
    .map((entry) => typeof entry.code === "string" ? entry.code : undefined)
    .filter((code): code is string => typeof code === "string" && (
      code === "SWE_BENCH_CACHE_HIT_TARGET_MISSED"
      || code === "SWE_BENCH_PROVIDER_CACHE_BELOW_TARGET"
      || code === "SWE_BENCH_PROVIDER_CACHE_PIPELINE_TELEMETRY_ABSENT"
      || code === "SWE_BENCH_PROVIDER_CACHE_PIPELINE_MISSING"
      || code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_HINT_UNSUPPORTED"
      || code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_HINT_MISSING"
      || code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_TOO_SMALL"
      || code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_COVERAGE_LOW"
      || code === "SWE_BENCH_PROVIDER_CACHE_DYNAMIC_TAIL_MISS"
      || code === "SWE_BENCH_PROVIDER_CACHE_PREFIX_DRIFT"
      || code === "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_MISS"
      || code === "SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_TELEMETRY_MISSING"
      || code === "SWE_BENCH_PROVIDER_CACHE_MULTI_MESSAGE_BREAKPOINT"
      || code === "SWE_BENCH_PROVIDER_TOOL_SCHEMA_CACHE_GAP"
      || code === "SWE_BENCH_PROVIDER_CACHE_HISTORY_TAIL_MISS"
      || code === "SWE_BENCH_PROVIDER_HISTORY_UNBOUNDED_AFTER_GATE"
      || code === "PROMPT_CACHE_PREFIX_BUSTED"
      || code === "SWE_BENCH_CONTEXT_PROJECTION_CACHE_NO_HIT"
      || code === "SWE_BENCH_CONTEXT_PROJECTION_KEY_WHOLE_PROMPT_DYNAMIC"
      || code === "SWE_BENCH_CACHE_METRIC_SCOPE_MISMATCH"
      || code === "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"
      || code === "SWE_BENCH_HARNESS_INSTANCE_ERROR"
      || code === "SWE_BENCH_HARNESS_LOCAL_BUILD_RETRY"
      || code === "SWE_BENCH_DOCKER_IMAGE_NOT_FOUND"
      || code === "SWE_BENCH_TEST_ENV_DEPENDENCY_INCOMPATIBLE"
      || code === "SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING"
      || code === "SWE_BENCH_TEST_ENTRYPOINT_MISSING"
      || code === "SWE_BENCH_TEST_ARGUMENT_UNSUPPORTED"
      || code === "SWE_BENCH_TEST_COMMAND_ENV_MISSCOPED"
      || code === "SWE_BENCH_READY_FOR_HARNESS_GATE_MISSING"
      || code === "SWE_BENCH_CHILD_TRACE_TEST_UNSUCCESSFUL"
      || code === "SWE_BENCH_REPORT_STAT_FAILED"
      || code === "SWE_BENCH_REPORT_READ_FAILED"
      || code === "SWE_BENCH_CHILD_TRACE_VERIFICATION_MISSING"
      || code === "REPAIR_FEEDBACK_LOW_FIDELITY"
      || code === "SWE_BENCH_EVALUATION_UNRESOLVED"
    ));
  return [...new Set(codes)].sort();
}

function formatRate(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  return `${(value * 100).toFixed(1)}%`;
}

function batchTaskReviewPreview(taskStates: readonly SweBenchRunTaskState[]): string {
  const entries = taskStates
    .filter((state) => state.primaryReasonCode)
    .map((state) => `${state.taskNumber}:${state.primaryReasonCode}`);
  return entries.length > 0 ? entries.join(";") : "none";
}

function pushEnvironmentDiagnostics(diagnostics: JsonObject[], environment: DiagnosticsEnvironmentPrepareSummary): void {
  for (const item of environment.diagnostics) diagnostics.push({ code: item.id, severity: item.status === "fail" ? "error" : "warn", message: item.message, redaction: item.redaction });
  for (const dependency of environment.dependencies) {
    if (dependency.required && (dependency.status === "missing" || dependency.status === "blocked")) {
      diagnostics.push({
        code: `SWE_BENCH_ENV_${dependency.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`,
        severity: dependency.status === "blocked" ? "error" : "warn",
        message: dependency.message,
        redaction: { class: "internal", fields: ["metadata"] }
      });
    }
  }
}

function repairContextFromEvaluation(evaluation: SweBenchPredictionSummary, attemptNumber: number, previousPatchBytes: number | undefined): SweBenchRepairContext {
  const failureExcerpts = failureExcerptsFromEvaluation(evaluation).slice(0, 6);
  return {
    attemptNumber,
    previousRunId: evaluation.evaluation?.runId ?? "unknown",
    failingTests: failingTestsFromEvaluation(evaluation).slice(0, 12),
    ...(failureExcerpts.length > 0 ? { failureExcerpts } : {}),
    ...(previousPatchBytes !== undefined ? { previousPatchBytes } : {}),
    redaction: { class: "internal", fields: ["failingTests", "failureExcerpts"] }
  };
}

function failingTestsFromEvaluation(evaluation: SweBenchPredictionSummary): readonly string[] {
  return (evaluation.evaluation?.instances ?? [])
    .flatMap((instance) => [
      ...instance.tests.failToPass.failureTests,
      ...instance.tests.passToPass.failureTests
    ]);
}

function failureExcerptsFromEvaluation(evaluation: SweBenchPredictionSummary): readonly SweBenchHarnessFailureExcerpt[] {
  return (evaluation.evaluation?.instances ?? [])
    .flatMap((instance) => instance.failureExcerpts ?? []);
}

function predictionDiagnostic(item: { readonly code: string; readonly severity: string; readonly message: string; readonly metadata?: JsonObject; readonly redaction: JsonObject }): JsonObject {
  return {
    code: item.code,
    severity: item.severity,
    message: item.message,
    ...(item.metadata ? { metadata: item.metadata } : {}),
    redaction: item.redaction
  };
}

function diagnostic(code: string, message: string, severity: "error" | "warn" | "info" = "error"): JsonObject {
  return { code, severity, message, redaction: { class: "internal" } };
}

function processDiagnostic(input: {
  readonly code: string;
  readonly message: string;
  readonly severity: "error" | "warn" | "info";
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly result: ProcessResult;
}): JsonObject {
  return {
    code: input.code,
    severity: input.severity,
    message: input.message,
    metadata: {
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      exitCode: input.result.exitCode,
      stdoutPreview: boundedProcessOutput(input.result.stdout),
      stderrPreview: boundedProcessOutput(input.result.stderr)
    },
    redaction: { class: "internal", fields: ["metadata.command", "metadata.args", "metadata.cwd", "metadata.stdoutPreview", "metadata.stderrPreview"] }
  };
}

function boundedProcessOutput(value: string): string {
  return value.length > 2_000 ? `${value.slice(0, 2_000)}\n[truncated]` : value;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function taskNumbersFromInput(input: JsonObject): readonly number[] {
  const values = Array.isArray(input.taskNumbers) ? input.taskNumbers : [input.taskNumber];
  const unique = new Set<number>();
  for (const value of values) {
    const taskNumber = positiveInteger(value);
    if (taskNumber) unique.add(taskNumber);
  }
  return [...unique].sort((a, b) => a - b);
}

function defaultRunId(taskNumbers: readonly number[]): string {
  if (taskNumbers.length === 1) return `swe-lite-task-${taskNumbers[0]}`;
  return `swe-lite-batch-${taskNumbers[0]}-${taskNumbers[taskNumbers.length - 1]}`;
}

function defaultRunIdForInvocation(taskNumbers: readonly number[], resume: boolean): string {
  return resume ? defaultRunId(taskNumbers) : freshDefaultRunId(taskNumbers);
}

function freshDefaultRunId(taskNumbers: readonly number[]): string {
  sweBenchHarnessRunSequence = (sweBenchHarnessRunSequence % Number.MAX_SAFE_INTEGER) + 1;
  return `${defaultRunId(taskNumbers)}-${Date.now().toString(36)}-${sweBenchHarnessRunSequence.toString(36)}`;
}

function batchTaskRunId(runId: string, taskNumber: number): string {
  return sanitizeRunId(`${runId}-task-${taskNumber}`);
}

function governedSweBenchRunTimeout(): number {
  return MAX_EXECUTION_TIMEOUT_MS;
}

function parseJsonObject(content: string): JsonObject | undefined {
  if (!content.trim()) return undefined;
  try {
    const parsed = JSON.parse(content) as unknown;
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function diagnosticsFromSummary(summary: JsonObject): readonly JsonObject[] {
  return Array.isArray(summary.diagnostics)
    ? summary.diagnostics.filter(isJsonObject)
    : [];
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function runIdFromBatchSummaryPath(path: string): string {
  const normalized = normalizedPath(path);
  const parts = normalized.split("/");
  return parts.length >= 2 ? parts[parts.length - 2] as string : "unknown-batch-run";
}

async function statFileMtimeMs(platform: PlatformRuntime, path: string): Promise<number> {
  const statFile = (platform as PlatformRuntime & { statFile?: (path: string) => Promise<{ readonly mtimeMs?: number }> }).statFile;
  if (!statFile) return 0;
  const stat = await statFile.call(platform, path).catch(() => undefined);
  return typeof stat?.mtimeMs === "number" && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
}

function stringField(value: JsonObject, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
}

function numberField(value: JsonObject, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function numberArrayField(value: JsonObject, key: string): number[] {
  const field = value[key];
  return Array.isArray(field)
    ? field.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    : [];
}

function nonEmptyNumberArrayField(value: JsonObject, key: string): number[] | undefined {
  const numbers = numberArrayField(value, key);
  return numbers.length > 0 ? numbers : undefined;
}

function stringArrayField(value: JsonObject, key: string): string[] {
  const field = value[key];
  return Array.isArray(field)
    ? field.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function sanitizeRunId(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean.length > 0 ? clean.slice(0, 80) : "swe-lite-run";
}
