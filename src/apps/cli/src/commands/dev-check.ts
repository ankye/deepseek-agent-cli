import type {
  AgentLoopOutputMode,
  CliResultList,
  CliResultListItem,
  JsonObject,
  PlatformRuntime,
  ProcessResult,
  RedactedError
} from "@deepseek/platform-contracts";
import { CLI_PALETTE_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import type { CliOptions, CliRunOptions } from "../types.js";
import { createCliAgentRuntime } from "../host/runtime.js";
import { resolveCliWorkspaceRoot } from "../host/workspace-root.js";

export type DevCheckAction = "openspec" | "typecheck" | "lint" | "test" | "boundaries" | "build-cli";
export type DevCheckStatus = "completed" | "failed" | "denied";

export interface DevCheckDescriptor extends JsonObject {
  readonly action: DevCheckAction;
  readonly commandId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly cwdPolicy: "workspace-root";
  readonly sideEffect: "process";
  readonly outputLimitBytes: number;
  readonly redaction: JsonObject;
}

export interface DevCheckResult extends JsonObject {
  readonly schemaVersion: string;
  readonly kind: "dev.check";
  readonly action: DevCheckAction;
  readonly requestedAction: string;
  readonly status: DevCheckStatus;
  readonly summary: string;
  readonly descriptor?: DevCheckDescriptor;
  readonly exitCode?: number;
  readonly stdoutPreview?: string;
  readonly stderrPreview?: string;
  readonly diagnostics: readonly RedactedError[];
  readonly suggestedActions: readonly string[];
  readonly resultList?: CliResultList;
  readonly redaction: JsonObject;
}

const descriptors: Record<DevCheckAction, DevCheckDescriptor> = {
  openspec: descriptor("openspec", "checks.openspec.validate", "openspec", ["validate", "--specs", "--strict"], 60_000),
  typecheck: descriptor("typecheck", "checks.typecheck", "npm", ["run", "typecheck"], 120_000),
  lint: descriptor("lint", "checks.lint", "npm", ["run", "lint"], 120_000),
  test: descriptor("test", "checks.test", "npm", ["test"], 180_000),
  boundaries: descriptor("boundaries", "checks.boundaries", "node", ["scripts/check-boundaries.mjs"], 60_000),
  "build-cli": descriptor("build-cli", "checks.build-cli", "npm", ["run", "build:cli"], 120_000)
};

const supportedActions = new Set(Object.keys(descriptors));
const shellFragmentPattern = /[;&|`$<>]|\b(?:rm|del|erase|rmdir|Remove-Item|git\s+(?:reset|checkout|clean|push|commit|merge|rebase))\b/i;

export async function runDevCheckCommand(options: CliOptions, write: (line: string) => Promise<void>, runOptions: CliRunOptions): Promise<void> {
  const workspaceRoot = await resolveCliWorkspaceRoot(runOptions);
  const runtime = await createCliAgentRuntime({ live: options.live, workspaceRoot }, runOptions);
  try {
    const input = checkInput(options);
    const result = await resolveDevCheck(runtime.deps.platform, workspaceRoot, input.action, input.args);
    for (const line of renderDevCheckResult(result, options.output)) await write(line);
  } finally {
    await runtime.kernel.shutdown("cli-dev-check-completed");
  }
}

export async function resolveDevCheck(platform: PlatformRuntime, workspaceRoot: string, action: string, args: readonly string[] = []): Promise<DevCheckResult> {
  const normalized = action.trim() || "typecheck";
  if (!isDevCheckAction(normalized)) {
    return deniedResult("typecheck", normalized, "unsupported dev check action", [
      diagnostic("DEV_CHECK_ACTION_UNSUPPORTED", "Use one of: openspec, typecheck, lint, test, boundaries, build-cli.")
    ]);
  }
  const fragment = args.find((arg) => shellFragmentPattern.test(arg));
  if (fragment) {
    return deniedResult(normalized, normalized, "free-form shell fragments are not allowed", [
      diagnostic("DEV_CHECK_FREE_FORM_SHELL_DENIED", `Unsupported shell fragment rejected for ${normalized}.`)
    ]);
  }
  if (args.length > 0) {
    return deniedResult(normalized, normalized, "dev checks use fixed arguments only", [
      diagnostic("DEV_CHECK_ARGS_UNSUPPORTED", `Unsupported argument(s) for ${normalized}: ${args.join(" ")}`)
    ]);
  }
  const resolved = descriptors[normalized];
  const result = await platform.runProcess(executableCommand(platform, resolved.command), resolved.args, {
    cwd: workspaceRoot,
    timeoutMs: resolved.timeoutMs,
    executionProfile: "noninteractive",
    stdin: "ignore",
    outputLimitBytes: resolved.outputLimitBytes
  });
  const status = result.exitCode === 0 ? "completed" : "failed";
  return checkResult(normalized, normalized, status, `${resolved.commandId} exit=${result.exitCode}`, resolved, result, status === "completed" ? [] : [
    diagnostic("DEV_CHECK_PROCESS_FAILED", `${resolved.commandId} exited with code ${result.exitCode}.`)
  ]);
}

export function renderDevCheckResult(result: DevCheckResult, output: AgentLoopOutputMode): readonly string[] {
  if (output === "json") return [JSON.stringify(result)];
  if (output === "jsonl") {
    return [
      JSON.stringify({ kind: "dev.check.summary", result: summaryRecord(result) }),
      ...(result.resultList ? result.resultList.items.map((item) => JSON.stringify({ kind: "dev.check.item", item })) : []),
      ...result.diagnostics.map((entry) => JSON.stringify({ kind: "dev.check.diagnostic", diagnostic: entry }))
    ];
  }
  return [
    `checks ${result.requestedAction}: ${result.status} - ${result.summary}`,
    ...(result.stdoutPreview ? [`  stdout: ${result.stdoutPreview}`] : []),
    ...(result.stderrPreview ? [`  stderr: ${result.stderrPreview}`] : []),
    ...result.diagnostics.map((entry) => `  diagnostic ${entry.code}: ${entry.message}`),
    ...result.suggestedActions.map((action) => `  next: ${action}`)
  ];
}

function checkInput(options: CliOptions): { readonly action: string; readonly args: readonly string[] } {
  const action = typeof options.checkInput?.action === "string" ? options.checkInput.action : options.checkAction ?? "typecheck";
  const args = Array.isArray(options.checkInput?.args) ? options.checkInput.args.filter((item): item is string => typeof item === "string") : [];
  return { action, args };
}

function deniedResult(action: DevCheckAction, requestedAction: string, summary: string, diagnostics: readonly RedactedError[]): DevCheckResult {
  return checkResult(action, requestedAction, "denied", summary, undefined, undefined, diagnostics, ["Run one of the predeclared checks without extra shell arguments."]);
}

function checkResult(
  action: DevCheckAction,
  requestedAction: string,
  status: DevCheckStatus,
  summary: string,
  descriptorValue: DevCheckDescriptor | undefined,
  process: ProcessResult | undefined,
  diagnostics: readonly RedactedError[],
  suggestedActions: readonly string[] = status === "completed" ? [] : ["Inspect diagnostics and rerun the same fixed check after the repo is repaired."]
): DevCheckResult {
  return {
    schemaVersion: CLI_PALETTE_SCHEMA_VERSION,
    kind: "dev.check",
    action,
    requestedAction,
    status,
    summary,
    ...(descriptorValue ? { descriptor: descriptorValue } : {}),
    ...(process ? { exitCode: process.exitCode, stdoutPreview: preview(process.stdout), stderrPreview: preview(process.stderr) } : {}),
    diagnostics,
    suggestedActions,
    resultList: diagnosticsResultList(action, diagnostics, process),
    redaction: { class: "internal", fields: ["descriptor.args", "stdoutPreview", "stderrPreview", "resultList.items.metadata"] }
  };
}

function diagnosticsResultList(action: DevCheckAction, diagnostics: readonly RedactedError[], process: ProcessResult | undefined): CliResultList {
  const items: CliResultListItem[] = diagnostics.map((entry, order) => ({
    id: `dev-check-diagnostic:${action}:${entry.code}`,
    target: { kind: "diagnostic", id: `diagnostic:${entry.code}`, label: entry.message, metadata: { source: "dev.check", action, code: entry.code } },
    label: `${entry.code}: ${entry.message}`,
    order,
    severity: "error",
    metadata: { source: "dev.check", action, code: entry.code }
  }));
  if (process && process.exitCode !== 0 && items.length === 0) {
    items.push({
      id: `dev-check-process:${action}`,
      target: { kind: "diagnostic", id: `process:${action}`, label: `${action} exited ${process.exitCode}`, metadata: { source: "dev.check", action, exitCode: process.exitCode } },
      label: `${action} exited ${process.exitCode}`,
      order: 0,
      severity: "error",
      metadata: { source: "dev.check", action, exitCode: process.exitCode }
    });
  }
  return { id: `result-list:dev-check:${action}`, kind: "diagnostics", sourceCommand: `checks.${action}`, label: `Dev check ${action}`, items, ...(items[0] ? { activeItemId: items[0].id } : {}) };
}

function summaryRecord(result: DevCheckResult): JsonObject {
  return {
    schemaVersion: result.schemaVersion,
    action: result.action,
    requestedAction: result.requestedAction,
    status: result.status,
    summary: result.summary,
    exitCode: result.exitCode,
    diagnosticCount: result.diagnostics.length,
    suggestedActions: result.suggestedActions,
    redaction: result.redaction
  };
}

function descriptor(action: DevCheckAction, commandId: string, command: string, args: readonly string[], timeoutMs: number): DevCheckDescriptor {
  return {
    action,
    commandId,
    command,
    args,
    timeoutMs,
    cwdPolicy: "workspace-root",
    sideEffect: "process",
    outputLimitBytes: 64_000,
    redaction: { class: "internal", fields: ["args"] }
  };
}

function executableCommand(platform: PlatformRuntime, command: string): string {
  if (platform.os === "windows" && command === "npm") return "npm.cmd";
  return command;
}

function isDevCheckAction(value: string): value is DevCheckAction {
  return supportedActions.has(value);
}

function diagnostic(code: string, message: string): RedactedError {
  return { code, message, retryable: false, redaction: { class: "public" } };
}

function preview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}
