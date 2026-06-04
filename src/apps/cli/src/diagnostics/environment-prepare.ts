import { join } from "node:path";
import type { JsonObject, PlatformRuntime, ProcessResult, ReadinessCheck } from "@deepseek/platform-contracts";
import { NodePlatformRuntime } from "@deepseek/platform-abstraction";
import { glmAnthropicLiveCredentialProcessEnv } from "@deepseek/credential-auth-management";
import { diagnosticPitIds, diagnosticsSchemaVersion } from "./release-evidence.js";

export type DiagnosticsEnvironmentDependencyStatus = "detected" | "missing" | "fixed" | "blocked" | "skipped";

export interface DiagnosticsEnvironmentCommandPlan extends JsonObject {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: JsonObject;
  readonly mutatesHost: boolean;
  readonly autoExecute: boolean;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface DiagnosticsEnvironmentExecutedStep extends JsonObject {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly status: "pass" | "fail" | "skipped";
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly stdoutPreview?: string;
  readonly stderrPreview?: string;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface DiagnosticsEnvironmentDependency extends JsonObject {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly optional: boolean;
  readonly status: DiagnosticsEnvironmentDependencyStatus;
  readonly message: string;
  readonly suggestedActions: readonly string[];
  readonly commandPlan: readonly DiagnosticsEnvironmentCommandPlan[];
  readonly executedStepIds: readonly string[];
  readonly secretRef?: JsonObject;
  readonly metadata: JsonObject;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface DiagnosticsEnvironmentPrepareSummary extends JsonObject {
  readonly schemaVersion: string;
  readonly kind: "diagnostics.environment.prepare.summary";
  readonly profileId: string;
  readonly action: string;
  readonly dryRun: boolean;
  readonly execute: boolean;
  readonly status: ReadinessCheck["status"];
  readonly dependencies: readonly DiagnosticsEnvironmentDependency[];
  readonly executedSteps: readonly DiagnosticsEnvironmentExecutedStep[];
  readonly diagnostics: readonly ReadinessCheck[];
  readonly nextAction: string;
  readonly referencePitFixtureIds: readonly string[];
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface DiagnosticsEnvironmentPrepareOptions {
  readonly profileId: string;
  readonly action: string;
  readonly dryRun: boolean;
  readonly execute: boolean;
  readonly extraArgs: readonly string[];
  readonly platform?: PlatformRuntime;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface DependencyContext {
  readonly platform: PlatformRuntime;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

interface DependencyProbe {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly plan: (context: DependencyContext) => readonly DiagnosticsEnvironmentCommandPlan[];
  readonly detect: (context: DependencyContext) => Promise<DetectedDependency>;
}

interface DetectedDependency {
  readonly detected: boolean;
  readonly skipped?: boolean;
  readonly message: string;
  readonly metadata?: JsonObject;
  readonly secretRef?: JsonObject;
}

const supportedProfiles = new Set(["swe-bench-lite"]);
const prepareAction = "prepare";

export async function prepareDiagnosticsEnvironment(options: DiagnosticsEnvironmentPrepareOptions): Promise<DiagnosticsEnvironmentPrepareSummary> {
  if (options.action !== prepareAction) return invalidEnvironmentSummary(options, "diagnostics.env.invalid-action", `diagnostics env only supports the prepare action.`);
  if (!supportedProfiles.has(options.profileId)) return invalidEnvironmentSummary(options, "diagnostics.env.unsupported-profile", `diagnostics env prepare does not support profile '${options.profileId}'.`);
  if (options.extraArgs.length > 0) return invalidEnvironmentSummary(options, "diagnostics.env.invalid-args", `diagnostics env prepare received ${options.extraArgs.length} unsupported argument(s).`);

  const platform = options.platform ?? new NodePlatformRuntime();
  const context: DependencyContext = {
    platform,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? {}
  };
  const executedSteps: DiagnosticsEnvironmentExecutedStep[] = [];
  const dependencies: DiagnosticsEnvironmentDependency[] = [];
  for (const probe of sweBenchLiteProfile()) {
    dependencies.push(await dependencyFromProbe(probe, context, options, executedSteps));
  }
  return buildSummary(options, dependencies, executedSteps, []);
}

export function environmentPrepareJsonLines(summary: DiagnosticsEnvironmentPrepareSummary): readonly JsonObject[] {
  return [
    {
      schemaVersion: diagnosticsSchemaVersion,
      kind: "diagnostics.env.prepare.summary",
      summary,
      redaction: summary.redaction
    },
    ...summary.dependencies.map((dependency) => ({
      schemaVersion: diagnosticsSchemaVersion,
      kind: "diagnostics.env.prepare.dependency",
      dependency,
      redaction: dependency.redaction
    })),
    ...summary.executedSteps.map((step) => ({
      schemaVersion: diagnosticsSchemaVersion,
      kind: "diagnostics.env.prepare.step",
      step,
      redaction: step.redaction
    })),
    ...summary.diagnostics.map((diagnostic) => ({
      schemaVersion: diagnosticsSchemaVersion,
      kind: "diagnostics.env.prepare.diagnostic",
      diagnostic,
      redaction: diagnostic.redaction
    }))
  ];
}

async function dependencyFromProbe(
  probe: DependencyProbe,
  context: DependencyContext,
  options: DiagnosticsEnvironmentPrepareOptions,
  executedSteps: DiagnosticsEnvironmentExecutedStep[]
): Promise<DiagnosticsEnvironmentDependency> {
  const initial = await probe.detect(context);
  const commandPlan = probe.plan(context);
  if (initial.detected || initial.skipped || options.dryRun) {
    return dependencyRecord(probe, initial, initial.skipped ? "skipped" : initial.detected ? "detected" : "missing", commandPlan, []);
  }

  const eligiblePlan = commandPlan.filter((step) => step.autoExecute);
  if (eligiblePlan.length === 0) {
    return dependencyRecord(probe, initial, "blocked", commandPlan, []);
  }

  const stepIds: string[] = [];
  for (const step of eligiblePlan) {
    const executed = await executePlanStep(context, step);
    executedSteps.push(executed);
    stepIds.push(executed.id);
    if (executed.status === "fail") {
      return dependencyRecord(probe, {
        detected: false,
        message: `${probe.label} preparation failed at ${step.id}.`,
        metadata: { failedStepId: step.id }
      }, "blocked", commandPlan, stepIds);
    }
  }

  const after = await probe.detect(context);
  return dependencyRecord(probe, after, after.detected ? "fixed" : "blocked", commandPlan, stepIds);
}

function sweBenchLiteProfile(): readonly DependencyProbe[] {
  return [
    {
      id: "docker.cli",
      label: "Docker CLI",
      required: true,
      plan: () => [
        planStep("docker.install", "Install Docker CLI and Colima", "brew", ["install", "docker", "colima"], true, true)
      ],
      detect: async ({ platform }) => processDetector(platform, "docker", ["--version"], "Docker CLI is available.", "Docker CLI is missing.")
    },
    {
      id: "docker.daemon",
      label: "Docker daemon",
      required: true,
      plan: () => [
        planStep("docker.daemon.start-colima", "Start Colima Docker daemon", "colima", ["start", "--cpu", "4", "--memory", "8", "--disk", "80"], true, true)
      ],
      detect: async ({ platform }) => processDetector(platform, "docker", ["info", "--format", "{{json .ServerVersion}}"], "Docker daemon is reachable.", "Docker daemon is not reachable.")
    },
    {
      id: "docker.host",
      label: "Docker host wiring",
      required: true,
      plan: ({ env }) => [
        planStep("docker.host.export-colima", "Use Colima Docker socket for subprocesses", "env", [`DOCKER_HOST=${env.DOCKER_HOST ?? "unix://$HOME/.colima/default/docker.sock"}`], false, false)
      ],
      detect: async ({ platform, env, cwd }) => {
        if (hasValue(env.DOCKER_HOST)) {
          return { detected: true, message: "DOCKER_HOST is set for subprocesses.", metadata: { source: "process-env" } };
        }
        const context = await platform.runProcess(executableCommand(platform, "docker"), ["context", "show"], { cwd, timeoutMs: 2000, executionProfile: "noninteractive", outputLimitBytes: 4096 });
        const activeContext = context.stdout.trim();
        return {
          detected: context.exitCode === 0 && activeContext.length > 0,
          message: context.exitCode === 0 && activeContext.length > 0 ? `Docker context '${activeContext}' is active.` : "Docker host context is not detectable for subprocesses.",
          metadata: { source: hasValue(env.DOCKER_HOST) ? "process-env" : "docker-context", activeContext: activeContext || undefined }
        };
      }
    },
    {
      id: "python.venv",
      label: "SWE-bench Python virtualenv",
      required: true,
      plan: ({ cwd }) => [
        planStep("python.venv.create", "Create SWE-bench virtualenv", "python3.12", ["-m", "venv", join(cwd, ".deepseek", "swebench-venv")], true, true, cwd)
      ],
      detect: async ({ platform, cwd }) => processDetector(platform, venvPython(cwd), ["--version"], "SWE-bench virtualenv Python is available.", "SWE-bench virtualenv Python is missing.", cwd)
    },
    {
      id: "swebench.package",
      label: "SWE-bench package",
      required: true,
      plan: ({ cwd, env }) => [
        planStep("swebench.install", "Install SWE-bench package", venvPython(cwd), ["-m", "pip", "install", "swebench"], true, true, cwd, pathPrependedEnv(env))
      ],
      detect: async ({ platform, cwd }) => processDetector(platform, venvPython(cwd), ["-m", "pip", "show", "swebench"], "SWE-bench package is installed.", "SWE-bench package is missing.", cwd)
    },
    {
      id: "rust.toolchain",
      label: "Rust toolchain",
      required: true,
      plan: () => [
        planStep("rust.toolchain.install", "Install or update Rust toolchain through rustup", "rustup", ["toolchain", "install", "stable", "--profile", "minimal"], true, true)
      ],
      detect: async ({ platform }) => processDetector(platform, "rustc", ["--version"], "Rust compiler is available.", "Rust compiler is missing.")
    },
    {
      id: "credential.glm",
      label: "GLM Anthropic-compatible credential",
      required: true,
      plan: () => [
        planStep("credential.glm.set-env", "Set GLM credential in an untracked environment source", "env", ["GLM_ANTHROPIC_API_KEY=<redacted>"], false, false)
      ],
      detect: async ({ platform, cwd, env }) => {
        const credentialEnv = await glmAnthropicLiveCredentialProcessEnv(platform, cwd, env);
        const sourceClass = hasValue(env.GLM_ANTHROPIC_API_KEY) || hasValue(env.ZHIPU_API_KEY) ? "process-env" : hasValue(credentialEnv.GLM_ANTHROPIC_API_KEY) || hasValue(credentialEnv.ZHIPU_API_KEY) ? "env-file" : "missing";
        const present = sourceClass !== "missing";
        return {
          detected: present,
          message: present ? "GLM credential reference is present." : "GLM credential reference is missing.",
          secretRef: {
            provider: "glm",
            ref: "credential-glm-anthropic-api-key",
            present,
            sourceClass,
            redaction: { class: "secret" }
          },
          metadata: { provider: "glm", credentialRef: "credential-glm-anthropic-api-key" }
        };
      }
    },
    {
      id: "credential.huggingface",
      label: "Hugging Face token",
      required: false,
      plan: () => [
        planStep("credential.huggingface.set-env", "Set Hugging Face token for private or rate-limited dataset access", "env", ["HF_TOKEN=<redacted>"], false, false)
      ],
      detect: async ({ env }) => {
        const present = hasValue(env.HF_TOKEN) || hasValue(env.HUGGINGFACE_HUB_TOKEN);
        return {
          detected: present,
          skipped: !present,
          message: present ? "Hugging Face token reference is present." : "Hugging Face token is optional for public SWE-bench Lite metadata.",
          secretRef: {
            provider: "huggingface",
            present,
            sourceClass: present ? "process-env" : "missing",
            redaction: { class: "secret" }
          },
          metadata: { optional: true }
        };
      }
    }
  ];
}

async function executePlanStep(context: DependencyContext, step: DiagnosticsEnvironmentCommandPlan): Promise<DiagnosticsEnvironmentExecutedStep> {
  if (!step.autoExecute) {
    return {
      id: step.id,
      label: step.label,
      command: step.command,
      args: step.args,
      status: "skipped",
      redaction: { class: "internal", fields: ["args"] }
    };
  }
  const started = Date.now();
  const planEnv = envFromPlan(step, context.env);
  const runOptions = {
    cwd: step.cwd ?? context.cwd,
    timeoutMs: 600000,
    outputLimitBytes: 8192,
    executionProfile: "noninteractive" as const
  };
  const result = await context.platform.runProcess(executableCommand(context.platform, step.command), step.args, planEnv ? { ...runOptions, env: planEnv } : runOptions);
  const durationMs = Date.now() - started;
  return executedStep(step, result, durationMs);
}

function dependencyRecord(
  probe: DependencyProbe,
  detected: DetectedDependency,
  status: DiagnosticsEnvironmentDependencyStatus,
  commandPlan: readonly DiagnosticsEnvironmentCommandPlan[],
  executedStepIds: readonly string[]
): DiagnosticsEnvironmentDependency {
  return {
    id: probe.id,
    label: probe.label,
    required: probe.required,
    optional: !probe.required,
    status,
    message: detected.message,
    suggestedActions: suggestedActions(probe, status),
    commandPlan,
    executedStepIds,
    ...(detected.secretRef ? { secretRef: detected.secretRef } : {}),
    metadata: detected.metadata ?? {},
    redaction: { class: "internal", fields: ["commandPlan.args", "secretRef", "metadata"] }
  };
}

function buildSummary(
  options: DiagnosticsEnvironmentPrepareOptions,
  dependencies: readonly DiagnosticsEnvironmentDependency[],
  executedSteps: readonly DiagnosticsEnvironmentExecutedStep[],
  diagnostics: readonly ReadinessCheck[]
): DiagnosticsEnvironmentPrepareSummary {
  const failed = diagnostics.some((diagnostic) => diagnostic.status === "fail") || dependencies.some((dependency) => dependency.required && dependency.status === "blocked");
  const warned = dependencies.some((dependency) => dependency.required && dependency.status === "missing") || diagnostics.some((diagnostic) => diagnostic.status === "warn");
  const status = failed ? "fail" : warned ? "warn" : "pass";
  return {
    schemaVersion: diagnosticsSchemaVersion,
    kind: "diagnostics.environment.prepare.summary",
    profileId: options.profileId,
    action: options.action,
    dryRun: options.dryRun,
    execute: options.execute && !options.dryRun,
    status,
    dependencies,
    executedSteps,
    diagnostics,
    nextAction: nextAction(status, options.dryRun),
    referencePitFixtureIds: [...diagnosticPitIds],
    redaction: { class: "internal", fields: ["dependencies.commandPlan.args", "dependencies.secretRef", "dependencies.metadata", "executedSteps.args", "executedSteps.stdoutPreview", "executedSteps.stderrPreview", "diagnostics.metadata"] }
  };
}

function invalidEnvironmentSummary(options: DiagnosticsEnvironmentPrepareOptions, id: string, message: string): DiagnosticsEnvironmentPrepareSummary {
  const diagnostic = check(id, "Invalid diagnostics env prepare input", "fail", message, ["Use deepseek diagnostics env prepare --profile swe-bench-lite --dry-run to inspect the allowlisted plan."]);
  return buildSummary({ ...options, dryRun: true, execute: false }, [], [], [diagnostic]);
}

async function processDetector(platform: PlatformRuntime, command: string, args: readonly string[], successMessage: string, failureMessage: string, cwd = process.cwd()): Promise<DetectedDependency> {
  const result = await platform.runProcess(executableCommand(platform, command), args, { cwd, timeoutMs: 5000, outputLimitBytes: 4096, executionProfile: "noninteractive" });
  return {
    detected: result.exitCode === 0,
    message: result.exitCode === 0 ? successMessage : failureMessage,
    metadata: {
      command,
      exitCode: result.exitCode,
      stdoutPreview: preview(result.stdout),
      stderrPreview: preview(result.stderr)
    }
  };
}

function planStep(
  id: string,
  label: string,
  command: string,
  args: readonly string[],
  mutatesHost: boolean,
  autoExecute: boolean,
  cwd?: string,
  env?: JsonObject
): DiagnosticsEnvironmentCommandPlan {
  return {
    id,
    label,
    command,
    args,
    ...(cwd ? { cwd } : {}),
    ...(env ? { env } : {}),
    mutatesHost,
    autoExecute,
    redaction: { class: "internal", fields: ["args", "env", "cwd"] }
  };
}

function executedStep(step: DiagnosticsEnvironmentCommandPlan, result: ProcessResult, durationMs: number): DiagnosticsEnvironmentExecutedStep {
  return {
    id: step.id,
    label: step.label,
    command: step.command,
    args: step.args,
    status: result.exitCode === 0 ? "pass" : "fail",
    exitCode: result.exitCode,
    durationMs,
    stdoutPreview: preview(result.stdout),
    stderrPreview: preview(result.stderr),
    redaction: { class: "internal", fields: ["args", "stdoutPreview", "stderrPreview"] }
  };
}

function suggestedActions(probe: DependencyProbe, status: DiagnosticsEnvironmentDependencyStatus): readonly string[] {
  if (status === "detected" || status === "fixed" || status === "skipped") return [];
  if (status === "missing") return [`Run deepseek diagnostics env prepare --profile swe-bench-lite --execute to apply allowlisted preparation for ${probe.id}.`];
  return [`Fix ${probe.id}, then rerun deepseek diagnostics env prepare --profile swe-bench-lite --output json.`];
}

function nextAction(status: ReadinessCheck["status"], dryRun: boolean): string {
  if (dryRun) return "Run deepseek diagnostics env prepare --profile swe-bench-lite --execute --output json to apply allowlisted preparation.";
  if (status === "pass") return "Run SWE-bench Lite evaluation with the prepared environment.";
  return "Fix blocked environment dependencies, then rerun diagnostics env prepare.";
}

function check(id: string, label: string, status: ReadinessCheck["status"], message: string, suggestedActions: readonly string[]): ReadinessCheck {
  return {
    id,
    label,
    status,
    message,
    suggestedActions,
    metadata: {},
    redaction: { class: "internal", fields: ["metadata"] }
  };
}

function pathPrependedEnv(_env: Readonly<Record<string, string | undefined>>): JsonObject {
  return {
    PATH_PREPEND: "$HOME/.cargo/bin"
  };
}

function envFromPlan(step: DiagnosticsEnvironmentCommandPlan, baseEnv: Readonly<Record<string, string | undefined>>): Record<string, string> | undefined {
  if (!step.env) return undefined;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(step.env)) {
    if (key === "PATH_PREPEND" && typeof value === "string") {
      const path = baseEnv.PATH ?? "";
      const expanded = value.startsWith("$HOME/") && baseEnv.HOME ? join(baseEnv.HOME, value.slice("$HOME/".length)) : value;
      env.PATH = `${expanded}${path ? `:${path}` : ""}`;
      continue;
    }
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function venvPython(cwd: string): string {
  return join(cwd, ".deepseek", "swebench-venv", "bin", "python");
}

function executableCommand(platform: PlatformRuntime, command: string): string {
  if (platform.os === "windows" && (command === "npm" || command === "npx")) return `${command}.cmd`;
  return command;
}

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function preview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}
