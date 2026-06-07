import { asId } from "@deepseek/platform-contracts";
import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  PlatformRuntime,
  RuntimeDependencies,
  SerializableResult
} from "@deepseek/platform-contracts";
import { redactJsonSecrets } from "@deepseek/policy-sandbox";
import { boundedText, defineToolManifest, objectSchema, replay } from "@deepseek/core-coding-tools";
import { createDiagnosticsEnvironmentPresenceEnv } from "@deepseek/credential-auth-management";
import { prepareDiagnosticsEnvironment } from "../diagnostics/environment-prepare.js";
import type { DiagnosticsEnvironmentPrepareSummary } from "../diagnostics/environment-prepare.js";

export interface CliEnvironmentCapabilityOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: PlatformRuntime;
}

const envPrepareCapabilityId = asId<"capability">("core.env.prepare");

export async function registerCliEnvironmentCapabilities(
  deps: Pick<RuntimeDependencies, "capabilities" | "platform">,
  workspaceRoot: string,
  options: CliEnvironmentCapabilityOptions = {}
): Promise<void> {
  if (await deps.capabilities.get(envPrepareCapabilityId)) return;
  const platform = options.platform ?? deps.platform;
  const env = createDiagnosticsEnvironmentPresenceEnv(options.env);
  const definition = defineToolManifest(
    "env.prepare",
    envPrepareCapabilityId,
    "Environment Prepare",
    "process",
    ["process:run", "environment:prepare"],
    objectSchema([], {
      profile: { type: "string", enum: ["swe-bench-lite"] },
      execute: { type: "boolean" },
      dryRun: { type: "boolean" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    async (input, context) => {
      const profile = stringField(input, "profile") ?? "swe-bench-lite";
      const execute = input.execute === true;
      const dryRun = input.dryRun === true || !execute;
      const summary = await prepareDiagnosticsEnvironment({
        profileId: profile,
        action: "prepare",
        dryRun,
        execute,
        extraArgs: [],
        platform,
        cwd: workspaceRoot,
        env
      });
      return resultFromSummary(summary, context);
    },
    { timeoutMs: 600_000, replayPolicy: { replayable: false, snapshot: "environment-preparation-evidence", deterministic: false } }
  );
  await deps.capabilities.register({
    ...definition.manifest,
    description: "Discover and optionally execute governed DeepSeek CLI environment preparation profiles, including SWE-bench Lite prerequisites. The agent decides when to call it."
  }, definition.execute);
}

function resultFromSummary(summary: DiagnosticsEnvironmentPrepareSummary, context: CapabilityExecutionContext): SerializableResult<CoreToolResult> {
  const metadata = {
    profileId: summary.profileId,
    status: summary.status,
    dryRun: summary.dryRun,
    execute: summary.execute,
    dependencyCounts: dependencyCounts(summary),
    executedStepCount: summary.executedSteps.length,
    diagnosticCount: summary.diagnostics.length,
    redaction: { class: "internal" as const }
  };
  const evidenceStatus: "completed" | "failed" = summary.status === "fail" ? "failed" : "completed";
  const value: CoreToolResult = {
    evidence: {
      tool: "env.prepare",
      status: evidenceStatus,
      affectedPaths: [],
      preview: boundedText(previewText(summary), 4_000),
      diagnostics: [],
      metadata: redactJsonSecrets(metadata) as JsonObject,
      replay: { ...replay(context), snapshot: "cli-env-prepare-evidence" },
      redaction: { class: "internal", fields: ["metadata"] }
    }
  };
  if (summary.status === "fail") {
    return {
      ok: false,
      value,
      error: {
        code: "CLI_ENV_PREPARE_FAILED",
        message: `CLI environment preparation failed for profile ${summary.profileId}.`,
        retryable: true,
        redaction: { class: "internal" }
      }
    };
  }
  return { ok: true, value };
}

function previewText(summary: DiagnosticsEnvironmentPrepareSummary): string {
  const counts = dependencyCounts(summary);
  const missingOrBlocked = summary.dependencies
    .filter((dependency) => dependency.status === "missing" || dependency.status === "blocked")
    .map((dependency) => dependency.id)
    .slice(0, 8);
  return [
    `core.env.prepare profile=${summary.profileId} status=${summary.status} dryRun=${summary.dryRun} execute=${summary.execute}`,
    `dependencies detected=${counts.detected} missing=${counts.missing} fixed=${counts.fixed} blocked=${counts.blocked} skipped=${counts.skipped}`,
    missingOrBlocked.length > 0 ? `attention=${missingOrBlocked.join(",")}` : "attention=none",
    `recommendation=${recommendation(summary)}`
  ].join("\n");
}

function dependencyCounts(summary: DiagnosticsEnvironmentPrepareSummary): JsonObject {
  const counts: Record<string, number> = { detected: 0, missing: 0, fixed: 0, blocked: 0, skipped: 0 };
  for (const dependency of summary.dependencies) counts[dependency.status] = (counts[dependency.status] ?? 0) + 1;
  return counts;
}

function recommendation(summary: DiagnosticsEnvironmentPrepareSummary): string {
  if (summary.status === "pass") return "environment-ready";
  if (summary.dryRun) return "agent-may-request-execution-after-review";
  return "blocked-dependencies-require-resolution";
}

function stringField(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
