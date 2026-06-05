import { dirname, join } from "node:path";
import type { JsonObject, PlatformRuntime } from "@deepseek/platform-contracts";
import { NodePlatformRuntime } from "@deepseek/platform-abstraction";
import { evaluationLiveCredentialEnv, evaluationModelSelectionArgs } from "./evaluation-provider-selection.js";

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
  readonly invocation: JsonObject;
  readonly predictions: readonly SweBenchPredictionRecord[];
  readonly commandPlan: readonly JsonObject[];
  readonly executedCommands: readonly JsonObject[];
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
  if (options.action !== "predict") {
    diagnostics.push(diagnostic("SWE_BENCH_PREDICTION_INVALID_ACTION", "error", `Unsupported SWE-bench action: ${options.action || "unknown"}.`));
  }
  if (!nonEmpty(options.instanceFile) || !nonEmpty(options.repoDir) || !nonEmpty(options.outputPath) || options.extraArgs.length > 0) {
    diagnostics.push(diagnostic("SWE_BENCH_PREDICTION_INVALID_INPUT", "error", "SWE-bench prediction requires --instance-file, --repo-dir, --output-path, and no unsupported extra arguments.", { extraArgCount: options.extraArgs.length }));
  }
  if (diagnostics.some((entry) => entry.severity === "error")) return summary(options, diagnostics, [], [], [], undefined);

  const instance = await readInstance(platform, options.instanceFile as string).catch((error: unknown) => {
    diagnostics.push(diagnostic("SWE_BENCH_INSTANCE_READ_FAILED", "error", error instanceof Error ? error.message : String(error)));
    return undefined;
  });
  if (!instance) return summary(options, diagnostics, [], [], [], undefined);

  const modelName = options.model ?? (options.modelProvider === "glm" ? "glm-5.1" : "deepseek-cli");
  const repoDir = options.repoDir as string;
  const commandPlan = [childCommandPlan(instance, options, modelName), gitDiffCommandPlan(repoDir)];
  const executedCommands: JsonObject[] = [];

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
  }

  const patch = options.dryRun ? "" : await collectGitDiff(platform, repoDir, diagnostics, executedCommands);
  const prediction = predictionRecord(instance.instanceId, modelName, patch);
  if (!options.dryRun) {
    await platform.ensureDirectory(dirname(options.outputPath as string));
    await platform.writeFile(options.outputPath as string, `${JSON.stringify(prediction)}\n`);
  }
  if (!options.dryRun && patch.trim().length === 0) {
    diagnostics.push(diagnostic("SWE_BENCH_EMPTY_PATCH", "warn", "SWE-bench prediction patch is empty after the agent run."));
  }

  return summary(options, diagnostics, [prediction], commandPlan, executedCommands, instance);
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
  for (const prediction of summary.predictions) {
    lines.push(`- ${prediction.instance_id}: patchBytes=${prediction.model_patch.length} model=${prediction.model_name_or_path}`);
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
  instance: SweBenchInstance | undefined
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
    invocation: {
      provider: options.modelProvider ?? "deepseek",
      providerSource: options.modelProvider ? "explicit" : "default",
      model: options.model ?? (options.modelProvider === "glm" ? "glm-5.1" : "deepseek-cli"),
      live: options.live,
      dryRun: options.dryRun,
      action: options.action
    },
    predictions,
    commandPlan,
    executedCommands,
    diagnostics,
    redaction: { class: "internal", fields: ["repoDir", "outputPath", "predictions.model_patch", "diagnostics.metadata", "commandPlan.args", "executedCommands.args"] }
  };
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

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
