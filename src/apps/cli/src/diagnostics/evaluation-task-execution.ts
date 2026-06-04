import { join } from "node:path";
import type {
  CliEvaluationBaselineDefinition,
  CliEvaluationDiagnostic,
  CliEvaluationInstrumentationEvent,
  CliEvaluationTaskDefinition,
  CliEvaluationTaskRunRecord,
  JsonObject,
  PlatformRuntime
} from "@deepseek/platform-contracts";
import { CLI_TASK_EVALUATION_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import { evaluationLiveCredentialEnv, evaluationModelSelectionArgs } from "./evaluation-provider-selection.js";
import { generatedArtifactMetrics } from "./generated-artifacts.js";
import {
  emptyMetrics,
  evidenceCredit,
  extractRuntimeSignals,
  loopBudgetMetrics,
  metricAvailabilityForRun,
  overDelegationFlag,
  phaseUsageMetrics,
  reconciliationCredit,
  repairCredit,
  repairMetricsFromStdout,
  repairQuality,
  roundRatio,
  verificationCredit,
  verifierQuality
} from "./evaluation-metrics.js";
import type { CliEvaluationOptions } from "./evaluation.js";
import { promptAssemblyMetricsFromJsonl } from "./prompt-assembly-metrics.js";
import { checkerDiagnostics, evidenceManifestStatus, parseCheckerOutput, webpageProjectEvidence } from "./webpage-evidence.js";
import { webpageTaskPrompt } from "./webpage-task.js";

interface EvaluationEventRecorder {
  readonly events: () => readonly CliEvaluationInstrumentationEvent[];
  readonly record: (kind: CliEvaluationInstrumentationEvent["kind"], metadata?: JsonObject) => void;
}

export async function executeEvaluationTask(
  platform: PlatformRuntime,
  task: CliEvaluationTaskDefinition,
  baseline: CliEvaluationBaselineDefinition,
  options: CliEvaluationOptions
): Promise<CliEvaluationTaskRunRecord> {
  return isWebpageEvaluationTask(task)
    ? executeWebpageTask(platform, task, baseline, options)
    : executeStructuredTask(platform, task, baseline, options);
}

export function shouldRetryEvaluationTask(
  run: CliEvaluationTaskRunRecord,
  baseline: CliEvaluationBaselineDefinition,
  options: CliEvaluationOptions
): boolean {
  return options.live === true &&
    baseline.baselineId === "deepseek-cli" &&
    run.outcome !== "solved" &&
    (run.metrics.retryCount ?? 0) === 0;
}

async function executeWebpageTask(
  platform: PlatformRuntime,
  task: CliEvaluationTaskDefinition,
  baseline: CliEvaluationBaselineDefinition,
  options: CliEvaluationOptions
): Promise<CliEvaluationTaskRunRecord> {
  const runId = `eval:${baseline.baselineId}:${task.taskId}`;
  const events = createEventRecorder(runId, baseline.baselineId, task.taskId);
  events.record("run_started", { dryRun: false });
  const workspaceRoot = await isolatedWorkspaceRoot(platform, runId);
  events.record("workspace_created", { workspaceRoot });
  const generatedDir = platform.resolvePath(workspaceRoot, "generated-webpage");
  await platform.ensureDirectory(generatedDir);
  if (task.taskId === "eval.webpage.failing-first-repair") await writeFailingWebpageFixture(platform, generatedDir);
  const projectEvidencePath = platform.resolvePath(workspaceRoot, "PROJECT-EVIDENCE.md");
  await platform.writeFile(projectEvidencePath, await webpageProjectEvidence(platform));
  events.record("evidence_written", { path: projectEvidencePath, purpose: "webpage-project-evidence" });
  await platform.writeFile(platform.resolvePath(workspaceRoot, "TASK.md"), webpageTaskPrompt(task));
  events.record("prompt_written", { path: platform.resolvePath(workspaceRoot, "TASK.md") });

  const started = Date.now();
  const command = await baselineCommandForExecution(platform, baseline.baselineId, options, workspaceRoot, webpageTaskPrompt(task));
  if (!command) return invalidRun(platform, task, baseline, events, workspaceRoot, started);

  events.record("prompt_sent", { adapter: baseline.baselineId });
  events.record("command_started", { command: command.command, argCount: command.args.length });
  const runResult = await platform.runProcess(command.command, command.args, {
    cwd: workspaceRoot,
    timeoutMs: task.timeBudgetMs,
    ...(command.env ? { env: command.env } : {})
  });
  events.record("command_finished", { exitCode: runResult.exitCode, stdoutBytes: byteLength(runResult.stdout), stderrBytes: byteLength(runResult.stderr) });
  const promptAssembly = baseline.baselineId === "deepseek-cli" ? promptAssemblyMetricsFromJsonl(runResult.stdout) : { available: false, gapReason: "not-applicable" as const };
  const runtimeSignals = extractRuntimeSignals(runResult.stdout);
  const checkCommand = task.checkCommands[0] ?? "node scripts/check-webpage-generation.mjs tests/evaluation/generated-webpage";
  events.record("checker_started", { command: checkCommand });
  const checkerResult = await platform.runProcess(process.execPath, [join(process.cwd(), "scripts/check-webpage-generation.mjs"), generatedDir], { cwd: process.cwd(), timeoutMs: 60_000 });
  events.record("checker_finished", { exitCode: checkerResult.exitCode, stdoutBytes: byteLength(checkerResult.stdout), stderrBytes: byteLength(checkerResult.stderr) });
  const checkerOutput = parseCheckerOutput(checkerResult.stdout);
  events.record("artifact_scan_started", { generatedDir });
  const artifactMetrics = await generatedArtifactMetrics(platform, generatedDir);
  events.record("artifact_scan_finished", {
    fileCount: artifactMetrics.fileCount,
    byteTotal: artifactMetrics.byteTotal,
    structureScore: artifactMetrics.structureScore
  });
  const elapsedMs = Date.now() - started;
  const checkPassed = checkerResult.exitCode === 0;
  const commandFailed = runResult.exitCode !== 0;
  const commandFailureCount = (commandFailed ? 1 : 0) + (checkPassed ? 0 : 1);
  const commandRunCount = 2;
  const commandSuccessCount = (commandFailed ? 0 : 1) + (checkPassed ? 1 : 0);
  const correctionCount = correctionSignalCount([runResult.stdout, runResult.stderr].join("\n"));
  const outcome = checkPassed ? "solved" : commandFailed ? "failed" : "invalid";
  const stdoutPreview = boundedPreview(runResult.stdout);
  const stderrPreview = boundedPreview(runResult.stderr);
  const repairMetrics = repairMetricsFromStdout(runResult.stdout);
  await platform.writeFile(platform.resolvePath(workspaceRoot, "baseline-output.txt"), [
    `# ${baseline.baselineId}`,
    "",
    `Command: ${command.command} ${command.args.map(redactPromptArg).join(" ")}`,
    `Exit Code: ${runResult.exitCode}`,
    "",
    "## stdout",
    stdoutPreview,
    "",
    "## stderr",
    stderrPreview,
    ""
  ].join("\n"));
  events.record("evidence_written", { path: platform.resolvePath(workspaceRoot, "baseline-output.txt") });
  events.record("run_finished", { outcome, elapsedMs });

  return {
    schemaVersion: CLI_TASK_EVALUATION_SCHEMA_VERSION,
    kind: "cli.evaluation.task-run",
    runId,
    task,
    baseline,
    dryRun: false,
    outcome,
    checks: [{
      command: checkCommand,
      status: checkPassed ? "pass" : "fail",
      exitCode: checkerResult.exitCode,
      evidencePath: generatedDir,
      stdoutPreview: boundedPreview(checkerResult.stdout),
      stderrPreview: boundedPreview(checkerResult.stderr),
      redaction: { class: "internal", fields: ["command", "evidencePath", "stdoutPreview", "stderrPreview"] }
    }],
    metrics: {
      elapsedMs,
      firstRunSuccess: checkPassed && !commandFailed,
      checkPassRate: checkPassed ? 1 : 0,
      retryCount: 0,
      userInterventionCount: 0,
      safetyViolationCount: 0,
      correctionCount,
      commandRunCount,
      commandSuccessCount,
      commandSuccessRate: roundRatio(commandSuccessCount / commandRunCount),
      commandFailureCount,
      generatedFileCount: artifactMetrics.fileCount,
      generatedHtmlFileCount: artifactMetrics.htmlFileCount,
      generatedCssFileCount: artifactMetrics.cssFileCount,
      generatedJsFileCount: artifactMetrics.jsFileCount,
      generatedByteTotal: artifactMetrics.byteTotal,
      largestGeneratedFileBytes: artifactMetrics.largestFileBytes,
      codeStructureScore: artifactMetrics.structureScore,
      contextRecallQuality: "not-applicable",
      firstPassSuccess: checkPassed && !commandFailed,
      repairActivationCount: repairMetrics.repairActivationCount,
      repairSuccessCount: repairMetrics.repairSuccessCount,
      ...(repairMetrics.repairActivationCount > 0 ? { repairSuccessRate: roundRatio(repairMetrics.repairSuccessCount / repairMetrics.repairActivationCount) } : {}),
      failedVerificationCount: 0,
      correctedVerificationCount: correctionCount > 0 && checkPassed ? 1 : 0,
      repeatedIneffectiveAttemptCount: 0,
      ...(repairMetrics.repairStopReason ? { repairStopReason: repairMetrics.repairStopReason } : {}),
      repairMetricsAvailability: baseline.baselineId === "deepseek-cli" ? "available" : "unavailable",
      promptAssemblyAvailable: promptAssembly.available,
      ...(promptAssembly.fingerprint ? { promptAssemblyFingerprint: promptAssembly.fingerprint } : {}),
      ...(promptAssembly.sectionCount !== undefined ? { promptAssemblySectionCount: promptAssembly.sectionCount } : {}),
      ...(promptAssembly.excludedSectionCount !== undefined ? { promptAssemblyExcludedSectionCount: promptAssembly.excludedSectionCount } : {}),
      ...(promptAssembly.budgetStatus ? { promptAssemblyBudgetStatus: promptAssembly.budgetStatus } : {}),
      ...(promptAssembly.visibleToolCount !== undefined ? { promptAssemblyVisibleToolCount: promptAssembly.visibleToolCount } : {}),
      ...(promptAssembly.gapReason ? { promptAssemblyGapReason: promptAssembly.gapReason } : {}),
      evidencePlanPresent: true,
      evidenceItemCount: checkerOutput?.evidence?.evidenceItemCount ?? 0,
      evidenceSourceCoverageRate: checkerOutput?.evidence?.sourceCoverageRate ?? 0,
      claimGroundingRate: checkerOutput?.evidence?.claimGroundingRate ?? 0,
      unsupportedClaimCount: checkerOutput?.evidence?.unsupportedClaimCount ?? 0,
      assumptionCount: checkerOutput?.evidence?.assumptionCount ?? 0,
      hallucinatedCommandCount: checkerOutput?.evidence?.hallucinatedCommandCount ?? 0,
      evidenceManifestStatus: evidenceManifestStatus(checkerOutput),
      phaseUsage: phaseUsageMetrics(checkerOutput, runtimeSignals, checkPassed),
      loopBudgets: loopBudgetMetrics(runtimeSignals),
      workerFanOut: runtimeSignals.workerFanOut,
      overDelegationFlag: overDelegationFlag(runtimeSignals, commandRunCount, task),
      ...(overDelegationFlag(runtimeSignals, commandRunCount, task) ? { overDelegationReason: "worker fan-out exceeded useful parallelism for the scenario." } : {}),
      verifierQuality: verifierQuality(checkerOutput, runtimeSignals, checkPassed),
      repairQuality: repairQuality(runtimeSignals, correctionCount),
      ...(runtimeSignals.reasoningEffort ? { reasoningEffort: runtimeSignals.reasoningEffort } : {}),
      ...(runtimeSignals.providerMappedEffort ? { providerMappedEffort: runtimeSignals.providerMappedEffort } : {}),
      evidenceCredit: evidenceCredit(checkerOutput),
      verificationCredit: verificationCredit(checkerOutput, runtimeSignals, checkPassed),
      repairCredit: repairCredit(runtimeSignals, correctionCount),
      reconciliationCredit: reconciliationCredit(runtimeSignals, checkPassed),
      metricAvailability: metricAvailabilityForRun(baseline, runtimeSignals, checkerOutput),
      recoveryUsed: correctionCount > 0,
      redaction: { class: "internal", fields: ["estimatedCostUsd"] }
    },
    instrumentationEvents: events.events(),
    diagnostics: [
      ...(commandFailed ? [diagnostic("CLI_EVALUATION_BASELINE_COMMAND_FAILED", "warn", `${baseline.baselineId} exited with code ${runResult.exitCode}.`)] : []),
      ...(checkPassed ? [] : [diagnostic("CLI_EVALUATION_WEBPAGE_CHECK_FAILED", "warn", `${baseline.baselineId} generated webpage failed local artifact checks.`)]),
      ...checkerDiagnostics(checkerOutput, diagnostic),
      ...(baseline.baselineId === "deepseek-cli" && !promptAssembly.available ? [diagnostic("CLI_EVALUATION_PROMPT_ASSEMBLY_MISSING", "warn", "DeepSeek CLI run did not expose prompt assembly evidence.")] : []),
      ...(baseline.baselineId === "deepseek-cli" && !checkPassed && promptAssembly.gapReason && promptAssembly.gapReason !== "not-applicable" ? [diagnostic(`CLI_EVALUATION_PROMPT_ASSEMBLY_${promptAssembly.gapReason.toUpperCase().replace(/-/g, "_")}`, "warn", `DeepSeek CLI webpage failure categorized as ${promptAssembly.gapReason}.`)] : [])
    ],
    evidencePaths: [workspaceRoot, generatedDir, projectEvidencePath, platform.resolvePath(workspaceRoot, "baseline-output.txt")],
    redaction: { class: "internal", fields: ["task.promptDigest", "checks.command", "checks.evidencePath", "checks.stdoutPreview", "checks.stderrPreview", "instrumentationEvents.metadata", "evidencePaths", "diagnostics.metadata"] }
  };
}

async function executeStructuredTask(
  platform: PlatformRuntime,
  task: CliEvaluationTaskDefinition,
  baseline: CliEvaluationBaselineDefinition,
  options: CliEvaluationOptions
): Promise<CliEvaluationTaskRunRecord> {
  const runId = `eval:${baseline.baselineId}:${task.taskId}`;
  const events = createEventRecorder(runId, baseline.baselineId, task.taskId);
  events.record("run_started", { dryRun: false });
  const workspaceRoot = await isolatedWorkspaceRoot(platform, runId);
  events.record("workspace_created", { workspaceRoot });
  await prepareStructuredEvaluationWorkspace(platform, task, workspaceRoot);
  const prompt = structuredTaskPrompt(task);
  const taskPath = platform.resolvePath(workspaceRoot, "TASK.md");
  await platform.writeFile(taskPath, prompt);
  events.record("prompt_written", { path: taskPath });

  const started = Date.now();
  const command = await baselineCommandForExecution(platform, baseline.baselineId, options, workspaceRoot, prompt);
  if (!command) return invalidRun(platform, task, baseline, events, workspaceRoot, started);

  events.record("prompt_sent", { adapter: baseline.baselineId });
  events.record("command_started", { command: command.command, argCount: command.args.length });
  const runResult = await platform.runProcess(command.command, command.args, {
    cwd: workspaceRoot,
    timeoutMs: task.timeBudgetMs,
    ...(command.env ? { env: command.env } : {})
  });
  events.record("command_finished", { exitCode: runResult.exitCode, stdoutBytes: byteLength(runResult.stdout), stderrBytes: byteLength(runResult.stderr) });
  const checkerCommand = `node scripts/check-evaluation-task.mjs ${task.taskId} ${workspaceRoot}`;
  events.record("checker_started", { command: checkerCommand });
  const checkerResult = await platform.runProcess(process.execPath, [join(process.cwd(), "scripts/check-evaluation-task.mjs"), task.taskId, workspaceRoot], { cwd: process.cwd(), timeoutMs: 60_000 });
  events.record("checker_finished", { exitCode: checkerResult.exitCode, stdoutBytes: byteLength(checkerResult.stdout), stderrBytes: byteLength(checkerResult.stderr) });
  const promptAssembly = baseline.baselineId === "deepseek-cli" ? promptAssemblyMetricsFromJsonl(runResult.stdout) : { available: false, gapReason: "not-applicable" as const };
  const runtimeSignals = extractRuntimeSignals(runResult.stdout);
  const elapsedMs = Date.now() - started;
  const checkPassed = checkerResult.exitCode === 0;
  const commandFailed = runResult.exitCode !== 0;
  const commandRunCount = 2;
  const commandSuccessCount = (commandFailed ? 0 : 1) + (checkPassed ? 1 : 0);
  const commandFailureCount = commandRunCount - commandSuccessCount;
  const correctionCount = correctionSignalCount([runResult.stdout, runResult.stderr].join("\n"));
  const outcome = checkPassed ? "solved" : commandFailed ? "failed" : "invalid";
  const repairMetrics = repairMetricsFromStdout(runResult.stdout);
  const baselineOutputPath = platform.resolvePath(workspaceRoot, "baseline-output.txt");
  await platform.writeFile(baselineOutputPath, [
    `# ${baseline.baselineId}`,
    "",
    `Task: ${task.taskId}`,
    `Command: ${command.command} ${command.args.map(redactPromptArg).join(" ")}`,
    `Exit Code: ${runResult.exitCode}`,
    "",
    "## stdout",
    boundedPreview(runResult.stdout),
    "",
    "## stderr",
    boundedPreview(runResult.stderr),
    "",
    "## checker",
    boundedPreview(checkerResult.stdout || checkerResult.stderr),
    ""
  ].join("\n"));
  events.record("evidence_written", { path: baselineOutputPath });
  events.record("run_finished", { outcome, elapsedMs });

  return {
    schemaVersion: CLI_TASK_EVALUATION_SCHEMA_VERSION,
    kind: "cli.evaluation.task-run",
    runId,
    task,
    baseline,
    dryRun: false,
    outcome,
    checks: [{
      command: checkerCommand,
      status: checkPassed ? "pass" : "fail",
      exitCode: checkerResult.exitCode,
      evidencePath: workspaceRoot,
      stdoutPreview: boundedPreview(checkerResult.stdout),
      stderrPreview: boundedPreview(checkerResult.stderr),
      redaction: { class: "internal", fields: ["command", "evidencePath", "stdoutPreview", "stderrPreview"] }
    }],
    metrics: {
      ...emptyMetrics(),
      elapsedMs,
      firstRunSuccess: checkPassed && !commandFailed,
      firstPassSuccess: checkPassed && !commandFailed,
      checkPassRate: checkPassed ? 1 : 0,
      correctionCount,
      commandRunCount,
      commandSuccessCount,
      commandSuccessRate: roundRatio(commandSuccessCount / commandRunCount),
      commandFailureCount,
      contextRecallQuality: task.taskId === "eval.context.recall" ? (checkPassed ? "good" : "missing") : "not-applicable",
      recoveryUsed: task.taskId === "eval.revert.recovery" || correctionCount > 0,
      repairActivationCount: repairMetrics.repairActivationCount,
      repairSuccessCount: repairMetrics.repairSuccessCount,
      ...(repairMetrics.repairActivationCount > 0 ? { repairSuccessRate: roundRatio(repairMetrics.repairSuccessCount / repairMetrics.repairActivationCount) } : {}),
      ...(repairMetrics.repairStopReason ? { repairStopReason: repairMetrics.repairStopReason } : {}),
      repairMetricsAvailability: baseline.baselineId === "deepseek-cli" ? "available" : "unavailable",
      promptAssemblyAvailable: promptAssembly.available,
      ...(promptAssembly.fingerprint ? { promptAssemblyFingerprint: promptAssembly.fingerprint } : {}),
      ...(promptAssembly.sectionCount !== undefined ? { promptAssemblySectionCount: promptAssembly.sectionCount } : {}),
      ...(promptAssembly.excludedSectionCount !== undefined ? { promptAssemblyExcludedSectionCount: promptAssembly.excludedSectionCount } : {}),
      ...(promptAssembly.budgetStatus ? { promptAssemblyBudgetStatus: promptAssembly.budgetStatus } : {}),
      ...(promptAssembly.visibleToolCount !== undefined ? { promptAssemblyVisibleToolCount: promptAssembly.visibleToolCount } : {}),
      ...(promptAssembly.gapReason ? { promptAssemblyGapReason: promptAssembly.gapReason } : {}),
      phaseUsage: phaseUsageMetrics(undefined, runtimeSignals, checkPassed),
      loopBudgets: loopBudgetMetrics(runtimeSignals),
      workerFanOut: runtimeSignals.workerFanOut,
      overDelegationFlag: overDelegationFlag(runtimeSignals, commandRunCount, task),
      verifierQuality: verifierQuality(undefined, runtimeSignals, checkPassed),
      repairQuality: repairQuality(runtimeSignals, correctionCount),
      ...(runtimeSignals.reasoningEffort ? { reasoningEffort: runtimeSignals.reasoningEffort } : {}),
      ...(runtimeSignals.providerMappedEffort ? { providerMappedEffort: runtimeSignals.providerMappedEffort } : {}),
      evidenceCredit: checkPassed,
      verificationCredit: checkPassed,
      repairCredit: repairCredit(runtimeSignals, correctionCount),
      reconciliationCredit: reconciliationCredit(runtimeSignals, checkPassed),
      metricAvailability: metricAvailabilityForRun(baseline, runtimeSignals, undefined),
      evidenceManifestStatus: checkPassed ? "passed" : "failed",
      redaction: { class: "internal", fields: ["estimatedCostUsd"] }
    },
    instrumentationEvents: events.events(),
    diagnostics: [
      ...(commandFailed ? [diagnostic("CLI_EVALUATION_BASELINE_COMMAND_FAILED", "warn", `${baseline.baselineId} exited with code ${runResult.exitCode}.`)] : []),
      ...(checkPassed ? [] : [diagnostic("CLI_EVALUATION_STRUCTURED_CHECK_FAILED", "warn", `${baseline.baselineId} failed deterministic checks for ${task.taskId}.`)]),
      ...(baseline.baselineId === "deepseek-cli" && !promptAssembly.available ? [diagnostic("CLI_EVALUATION_PROMPT_ASSEMBLY_MISSING", "warn", "DeepSeek CLI run did not expose prompt assembly evidence.")] : [])
    ],
    evidencePaths: [workspaceRoot, taskPath, baselineOutputPath],
    redaction: { class: "internal", fields: ["task.promptDigest", "checks.command", "checks.evidencePath", "checks.stdoutPreview", "checks.stderrPreview", "instrumentationEvents.metadata", "evidencePaths", "diagnostics.metadata"] }
  };
}

async function baselineCommandForExecution(
  platform: PlatformRuntime,
  baselineId: string,
  options: CliEvaluationOptions,
  workspaceRoot: string,
  prompt: string
): Promise<{ readonly command: string; readonly args: readonly string[]; readonly env?: JsonObject } | undefined> {
  if (baselineId === "deepseek-cli") {
    const args = [
      join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
      "--tsconfig",
      join(process.cwd(), "tsconfig.json"),
      join(process.cwd(), "src/apps/cli/src/index.ts"),
      "run",
      prompt,
      "--output",
      "jsonl",
      "--timeout-ms",
      String(15 * 60 * 1000)
    ];
    if (options.live) {
      args.push("--live", "--tool-projection", "read-write");
    }
    args.push(...evaluationModelSelectionArgs(options));
    return {
      command: process.execPath,
      args,
      ...(options.live ? { env: await evaluationLiveCredentialEnv(platform, options.modelProvider) } : {})
    };
  }
  if (baselineId === "codex") {
    const command = externalBaselineCommand(options, baselineId);
    if (!command || !options.allowExternalBaseline) return undefined;
    return {
      command,
      args: [
        "exec",
        "--cd",
        workspaceRoot,
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "--ephemeral",
        "--color",
        "never",
        prompt
      ]
    };
  }
  if (baselineId === "claude-code") {
    const command = externalBaselineCommand(options, baselineId);
    if (!command || !options.allowExternalBaseline) return undefined;
    return {
      command,
      args: [
        "-p",
        "--output-format",
        "json",
        "--permission-mode",
        "acceptEdits",
        "--no-session-persistence",
        prompt
      ]
    };
  }
  return undefined;
}

function externalBaselineCommand(options: CliEvaluationOptions, baselineId: string): string | undefined {
  if (baselineId === "codex") return options.codexCommand ?? options.baselineCommand;
  if (baselineId === "claude-code") return options.claudeCommand ?? options.baselineCommand;
  return options.baselineCommand;
}

function isWebpageEvaluationTask(task: CliEvaluationTaskDefinition): boolean {
  return task.taskId === "eval.webpage.generation" || task.taskId === "eval.webpage.failing-first-repair";
}

async function prepareStructuredEvaluationWorkspace(
  platform: PlatformRuntime,
  task: CliEvaluationTaskDefinition,
  workspaceRoot: string
): Promise<void> {
  switch (task.taskId) {
    case "eval.bugfix.failing-test":
      await writeBugfixFixture(platform, workspaceRoot);
      return;
    case "eval.refactor.multifile":
      await writeRefactorFixture(platform, workspaceRoot);
      return;
    case "eval.docs.spec-update":
      await writeDocsSpecFixture(platform, workspaceRoot);
      return;
    case "eval.context.recall":
      await writeContextRecallFixture(platform, workspaceRoot);
      return;
    case "eval.revert.recovery":
      await writeRevertRecoveryFixture(platform, workspaceRoot);
      return;
    case "eval.release.evidence":
      await writeReleaseEvidenceFixture(platform, workspaceRoot);
      return;
    case "eval.coding.failing-first-typecheck":
      await writeCodingRepairFixture(platform, workspaceRoot);
      return;
    default:
      await platform.writeFile(platform.resolvePath(workspaceRoot, "README.md"), `Unsupported task fixture: ${task.taskId}\n`);
  }
}

function structuredTaskPrompt(task: CliEvaluationTaskDefinition): string {
  const common = [
    `Evaluation task id: ${task.taskId}`,
    `Title: ${task.title}`,
    `Prompt summary: ${task.promptSummary}`,
    "",
    "Use the available local file and shell tools in the current working directory.",
    "Inspect the fixture files before editing. Make the smallest changes needed for the deterministic checker to pass.",
    "Do not only describe the answer; write the requested files and run the relevant local check when useful.",
    ""
  ];
  const taskSpecific: Record<string, readonly string[]> = {
    "eval.bugfix.failing-test": [
      "Fix the bug in lib/calculator.js. Do not edit test/calculator.test.mjs.",
      "The checker runs node --test test/calculator.test.mjs."
    ],
    "eval.refactor.multifile": [
      "Move the duplicated normalizeLabel logic from src/alpha.js and src/beta.js into src/shared/normalize-label.js.",
      "Update alpha and beta to import the shared helper. Preserve behavior and do not leave duplicate normalizeLabel functions behind."
    ],
    "eval.docs.spec-update": [
      "Update README.md and openspec/changes/eval-streaming-retry/specs/runtime/spec.md.",
      "Both files must include English and Chinese guidance for the streaming retry budget.",
      "Keep the OpenSpec text about this project only; do not copy any external implementation detail."
    ],
    "eval.context.recall": [
      "Use memory/pageindex.json as prior recall evidence and src/config.json as fresh workspace state.",
      "Write answer.json with decisionId, chosenTransport, currentRetryBudget, stale=false, and evidencePaths."
    ],
    "eval.revert.recovery": [
      "Preview and apply a scoped revert in app.txt.",
      "Do not use git and do not leave the generated block in place. Directly edit app.txt.",
      "The final app.txt content must be exactly:",
      "stable setting: on",
      "USER CHANGE: keep this line",
      "final setting: on",
      "",
      "Write revert-preview.json as valid JSON with schemaVersion=\"1.0.0\", applied=true, requestId=\"request-42\", removedGeneratedChange=true, and preservedUserChange=true."
    ],
    "eval.release.evidence": [
      "Refresh release evidence without claiming publish readiness.",
      "Do not execute the deepseek diagnostics commands in this fixture; release/checks.json is the provided command evidence.",
      "Read release/checks.json, then write release/evidence-summary.json as valid JSON with schemaVersion=\"1.0.0\", status=\"pass\", publishDryRunReady=false, and commands containing both provided diagnostics commands.",
      "Update release/acceptance-index.md so it explicitly mentions diagnostics refresh and diagnostics verify evidence."
    ],
    "eval.coding.failing-first-typecheck": [
      "Repair src/formatter.js so node --check src/formatter.js and node --test test/formatter.test.mjs pass.",
      "Do not edit the test file."
    ]
  };
  return [...common, ...(taskSpecific[task.taskId] ?? ["Complete the fixture according to TASK.md and make the checker pass."])].join("\n");
}

async function writeBugfixFixture(platform: PlatformRuntime, root: string): Promise<void> {
  await platform.ensureDirectory(platform.resolvePath(root, "lib"));
  await platform.ensureDirectory(platform.resolvePath(root, "test"));
  await platform.writeFile(platform.resolvePath(root, "lib", "calculator.js"), [
    "export function add(a, b) {",
    "  return a - b;",
    "}",
    "",
    "export function multiply(a, b) {",
    "  return a * b;",
    "}",
    ""
  ].join("\n"));
  await platform.writeFile(platform.resolvePath(root, "test", "calculator.test.mjs"), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add, multiply } from '../lib/calculator.js';",
    "",
    "test('add returns the sum for positive and negative numbers', () => {",
    "  assert.equal(add(2, 3), 5);",
    "  assert.equal(add(-4, 9), 5);",
    "});",
    "",
    "test('multiply still works', () => {",
    "  assert.equal(multiply(4, 5), 20);",
    "});",
    ""
  ].join("\n"));
  await platform.writeFile(platform.resolvePath(root, "package.json"), "{\"type\":\"module\",\"scripts\":{\"test\":\"node --test test/calculator.test.mjs\"}}\n");
}

async function writeRefactorFixture(platform: PlatformRuntime, root: string): Promise<void> {
  await platform.ensureDirectory(platform.resolvePath(root, "src"));
  await platform.ensureDirectory(platform.resolvePath(root, "test"));
  await platform.writeFile(platform.resolvePath(root, "src", "alpha.js"), [
    "function normalizeLabel(value) {",
    "  return String(value).trim().toLowerCase().replace(/\\s+/g, '-');",
    "}",
    "",
    "export function alphaLabel(value) {",
    "  return `alpha:${normalizeLabel(value)}`;",
    "}",
    ""
  ].join("\n"));
  await platform.writeFile(platform.resolvePath(root, "src", "beta.js"), [
    "function normalizeLabel(value) {",
    "  return String(value).trim().toLowerCase().replace(/\\s+/g, '-');",
    "}",
    "",
    "export function betaLabel(value) {",
    "  return `beta:${normalizeLabel(value)}`;",
    "}",
    ""
  ].join("\n"));
  await platform.writeFile(platform.resolvePath(root, "test", "refactor.test.mjs"), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { alphaLabel } from '../src/alpha.js';",
    "import { betaLabel } from '../src/beta.js';",
    "import { normalizeLabel } from '../src/shared/normalize-label.js';",
    "",
    "test('labels preserve behavior through the shared helper', () => {",
    "  assert.equal(normalizeLabel(' Hello   World '), 'hello-world');",
    "  assert.equal(alphaLabel(' Hello   World '), 'alpha:hello-world');",
    "  assert.equal(betaLabel(' Hello   World '), 'beta:hello-world');",
    "});",
    ""
  ].join("\n"));
  await platform.writeFile(platform.resolvePath(root, "package.json"), "{\"type\":\"module\",\"scripts\":{\"test\":\"node --test test/refactor.test.mjs\"}}\n");
}

async function writeDocsSpecFixture(platform: PlatformRuntime, root: string): Promise<void> {
  const specDir = platform.resolvePath(root, "openspec", "changes", "eval-streaming-retry", "specs", "runtime");
  await platform.ensureDirectory(specDir);
  await platform.writeFile(platform.resolvePath(root, "README.md"), [
    "# Eval Runtime",
    "",
    "The runtime streams model responses and records retry attempts.",
    "",
    "TODO: add bilingual streaming retry budget guidance.",
    ""
  ].join("\n"));
  await platform.writeFile(platform.resolvePath(specDir, "spec.md"), [
    "### Requirement: Streaming Retry Budget",
    "",
    "The runtime SHALL keep retry attempts bounded.",
    "",
    "#### Scenario: Retry budget is reported",
    "- **WHEN** a streaming provider response fails",
    "- **THEN** diagnostics report retry budget state",
    ""
  ].join("\n"));
}

async function writeContextRecallFixture(platform: PlatformRuntime, root: string): Promise<void> {
  await platform.ensureDirectory(platform.resolvePath(root, "memory"));
  await platform.ensureDirectory(platform.resolvePath(root, "src"));
  await platform.writeFile(platform.resolvePath(root, "memory", "pageindex.json"), JSON.stringify({
    schemaVersion: "1.0.0",
    decisions: [{
      decisionId: "decision:transport-stdio",
      chosenTransport: "stdio",
      reason: "The local MCP gateway uses stdio for deterministic fixture transport.",
      recordedAt: "2026-05-15T00:00:00.000Z"
    }]
  }, null, 2));
  await platform.writeFile(platform.resolvePath(root, "src", "config.json"), JSON.stringify({
    schemaVersion: "1.0.0",
    transport: "stdio",
    retryBudget: 2
  }, null, 2));
}

async function writeRevertRecoveryFixture(platform: PlatformRuntime, root: string): Promise<void> {
  await platform.writeFile(platform.resolvePath(root, "app.txt"), [
    "stable setting: on",
    "USER CHANGE: keep this line",
    "BEGIN GENERATED CHANGE request-42",
    "experimental generated setting: remove me",
    "END GENERATED CHANGE request-42",
    "final setting: on",
    ""
  ].join("\n"));
  await platform.writeFile(platform.resolvePath(root, "revert-request.json"), JSON.stringify({
    schemaVersion: "1.0.0",
    requestId: "request-42",
    targetFile: "app.txt",
    preserve: ["USER CHANGE: keep this line"]
  }, null, 2));
}

async function writeReleaseEvidenceFixture(platform: PlatformRuntime, root: string): Promise<void> {
  await platform.ensureDirectory(platform.resolvePath(root, "release"));
  await platform.writeFile(platform.resolvePath(root, "release", "checks.json"), JSON.stringify({
    schemaVersion: "1.0.0",
    commands: [
      "deepseek diagnostics refresh --dry-run --output json",
      "deepseek diagnostics verify --output json"
    ],
    results: [
      { id: "refresh", status: "pass" },
      { id: "verify", status: "pass" }
    ],
    publishDryRunReady: false
  }, null, 2));
  await platform.writeFile(platform.resolvePath(root, "release", "acceptance-index.md"), "# Acceptance Index\n\nTODO\n");
}

async function writeCodingRepairFixture(platform: PlatformRuntime, root: string): Promise<void> {
  await platform.ensureDirectory(platform.resolvePath(root, "src"));
  await platform.ensureDirectory(platform.resolvePath(root, "test"));
  await platform.writeFile(platform.resolvePath(root, "src", "formatter.js"), [
    "export function formatName(input) {",
    "  const value = String(input ?? '').trim();",
    "  return value.toUpperCase(;",
    "}",
    ""
  ].join("\n"));
  await platform.writeFile(platform.resolvePath(root, "test", "formatter.test.mjs"), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { formatName } from '../src/formatter.js';",
    "",
    "test('formatName trims and uppercases names', () => {",
    "  assert.equal(formatName(' deepseek '), 'DEEPSEEK');",
    "  assert.equal(formatName(null), '');",
    "});",
    ""
  ].join("\n"));
  await platform.writeFile(platform.resolvePath(root, "package.json"), "{\"type\":\"module\",\"scripts\":{\"test\":\"node --test test/formatter.test.mjs\"}}\n");
}

async function writeFailingWebpageFixture(platform: PlatformRuntime, generatedDir: string): Promise<void> {
  await platform.writeFile(platform.resolvePath(generatedDir, "index.html"), [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"><title>Broken</title></head>",
    "<body><h1>Broken generated page</h1><script src=\"https://cdn.example.invalid/app.js\"></script></body></html>",
    ""
  ].join("\n"));
}

async function invalidRun(
  platform: PlatformRuntime,
  task: CliEvaluationTaskDefinition,
  baseline: CliEvaluationBaselineDefinition,
  events: EvaluationEventRecorder,
  workspaceRoot: string,
  started: number
): Promise<CliEvaluationTaskRunRecord> {
  return {
    schemaVersion: CLI_TASK_EVALUATION_SCHEMA_VERSION,
    kind: "cli.evaluation.task-run",
    runId: `eval:${baseline.baselineId}:${task.taskId}`,
    task,
    baseline,
    dryRun: false,
    outcome: "invalid",
    checks: [],
    metrics: { ...emptyMetrics(), elapsedMs: Date.now() - started },
    instrumentationEvents: withRecordedEvent(events, "run_finished", { outcome: "invalid" }),
    diagnostics: [diagnostic("CLI_EVALUATION_EXECUTION_ADAPTER_UNAVAILABLE", "error", `${baseline.baselineId} has no execution adapter for ${task.taskId}.`)],
    evidencePaths: [workspaceRoot],
    redaction: { class: "internal", fields: ["task.promptDigest", "checks.command", "evidencePaths", "diagnostics.metadata"] }
  };
}

async function isolatedWorkspaceRoot(platform: PlatformRuntime, runId: string): Promise<string> {
  return platform.createTempDirectory(`${sanitizePathSegment(runId)}-`);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
}

function correctionSignalCount(value: string): number {
  const normalized = value.toLowerCase();
  const matches = normalized.match(/\b(retry|retried|again|fix|fixed|correct|corrected|repair|repaired|failed|error)\b/g);
  return Math.min(matches?.length ?? 0, 20);
}

function redactPromptArg(value: string): string {
  return value.includes("\n") || value.length > 80 ? "[PROMPT]" : value;
}

function createEventRecorder(runId: string, baselineId: string, taskId: string): EvaluationEventRecorder {
  const events: CliEvaluationInstrumentationEvent[] = [];
  return {
    events: () => events,
    record(kind, metadata) {
      const sequence = events.length + 1;
      events.push({
        schemaVersion: CLI_TASK_EVALUATION_SCHEMA_VERSION,
        eventId: `${runId}:event:${sequence}`,
        kind,
        runId,
        baselineId,
        taskId,
        sequence,
        recordedAt: "1970-01-01T00:00:00.000Z",
        metadata: metadata ?? {},
        redaction: { class: "internal", fields: ["metadata.workspaceRoot", "metadata.path", "metadata.command"] }
      });
    }
  };
}

function withRecordedEvent(
  recorder: EvaluationEventRecorder,
  kind: CliEvaluationInstrumentationEvent["kind"],
  metadata?: JsonObject
): readonly CliEvaluationInstrumentationEvent[] {
  recorder.record(kind, metadata);
  return recorder.events();
}

function diagnostic(code: string, severity: CliEvaluationDiagnostic["severity"], message: string): CliEvaluationDiagnostic {
  return {
    code,
    severity,
    message,
    redaction: { class: "public" }
  };
}

function boundedPreview(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n");
  return normalized.length <= 1200 ? normalized : `${normalized.slice(0, 1200)}...[truncated]`;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
