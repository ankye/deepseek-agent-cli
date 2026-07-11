import type { AgentLoopOutputMode, CliResultList, CliResultListItem, CliTargetRef, JsonObject, PlatformRuntime, ProcessResult, RedactedError } from "@deepseek/platform-contracts";
import { CLI_PALETTE_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import type { CliOptions, CliRunOptions } from "../types.js";
import { createCliAgentRuntime } from "../host/runtime.js";
import { resolveCliWorkspaceRoot } from "../host/workspace-root.js";

export type GitReviewAction = "status" | "diff" | "review";

export interface GitReviewResult extends JsonObject {
  readonly schemaVersion: string;
  readonly kind: "git.review";
  readonly action: GitReviewAction;
  readonly requestedAction: string;
  readonly status: "completed" | "failed" | "denied";
  readonly summary: string;
  readonly data: JsonObject;
  readonly exitCode?: number;
  readonly stdoutPreview?: string;
  readonly stderrPreview?: string;
  readonly resultList?: CliResultList;
  readonly referenceTargets: readonly CliTargetRef[];
  readonly diagnostics: readonly RedactedError[];
  readonly suggestedActions: readonly string[];
  readonly redaction: JsonObject;
}

const destructiveGitActions = new Set(["commit", "checkout", "reset", "clean", "merge", "rebase", "push", "switch", "restore", "branch-delete", "delete-branch"]);

export async function runGitReviewCommand(options: CliOptions, write: (line: string) => Promise<void>, runOptions: CliRunOptions): Promise<void> {
  const workspaceRoot = await resolveCliWorkspaceRoot(runOptions);
  const runtime = await createCliAgentRuntime({ live: options.live, workspaceRoot }, runOptions);
  try {
    const input = gitInput(options);
    const result = await resolveGitReview(runtime.deps.platform, workspaceRoot, input.action, input.args);
    for (const line of renderGitReviewResult(result, options.output)) await write(line);
  } finally {
    await runtime.kernel.shutdown("cli-git-review-completed");
  }
}

export async function resolveGitReview(platform: PlatformRuntime, workspaceRoot: string, action: string, args: readonly string[] = []): Promise<GitReviewResult> {
  const normalized = action.trim() || "status";
  if (isDestructiveGitAction(normalized, args)) {
    return gitResult(actionKind(normalized), normalized, "denied", `destructive git action denied: ${normalized}`, { denied: true, argsRejected: args.length }, undefined, [diagnostic("GIT_REVIEW_DESTRUCTIVE_DENIED", `Destructive git action is not allowed: ${normalized}`)], ["Use git status, git diff, or git review for read-only evidence."]);
  }
  if (args.length > 0) {
    return gitResult(actionKind(normalized), normalized, "denied", `unsupported git review arguments for ${normalized}`, { denied: true, argsRejected: args.length }, undefined, [diagnostic("GIT_REVIEW_ARGS_UNSUPPORTED", "Git review commands use fixed read-only arguments.")], ["Rerun without extra git arguments."]);
  }
  if (normalized === "status") return runGit(platform, workspaceRoot, "status", "status", ["status", "--short"]);
  if (normalized === "diff") return runGit(platform, workspaceRoot, "diff", "diff", ["diff", "--stat"]);
  if (normalized === "review") {
    const status = await platform.runProcess("git", ["status", "--short"], processOptions(workspaceRoot));
    const diff = await platform.runProcess("git", ["diff", "--stat"], processOptions(workspaceRoot));
    const summary = `statusExit=${status.exitCode} diffExit=${diff.exitCode} statusLines=${lineCount(status.stdout)} diffLines=${lineCount(diff.stdout)}`;
    return gitResult("review", "review", status.exitCode === 0 && diff.exitCode === 0 ? "completed" : "failed", summary, {
      statusExitCode: status.exitCode,
      diffExitCode: diff.exitCode,
      statusLineCount: lineCount(status.stdout),
      diffLineCount: lineCount(diff.stdout),
      readOnly: true
    }, mergeProcessResult(status, diff));
  }
  return gitResult("status", normalized, "failed", `unsupported git review action: ${normalized}`, { readOnly: true }, undefined, [diagnostic("GIT_REVIEW_ACTION_UNSUPPORTED", "Use git status, git diff, or git review.")], ["Use git status, git diff, or git review."]);
}

export function renderGitReviewResult(result: GitReviewResult, output: AgentLoopOutputMode): readonly string[] {
  if (output === "json") return [JSON.stringify(result)];
  if (output === "jsonl") {
    return [
      JSON.stringify({ kind: "git.review.summary", result: summaryRecord(result) }),
      ...(result.resultList ? result.resultList.items.map((item) => JSON.stringify({ kind: "git.review.item", item })) : []),
      ...result.diagnostics.map((entry) => JSON.stringify({ kind: "git.review.diagnostic", diagnostic: entry }))
    ];
  }
  return [
    `git ${result.requestedAction}: ${result.status} - ${result.summary}`,
    ...(result.resultList ? result.resultList.items.slice(0, 20).map((item) => `  ${item.order + 1} ${item.label}`) : []),
    ...(result.stdoutPreview ? [`  stdout: ${result.stdoutPreview}`] : []),
    ...(result.stderrPreview ? [`  stderr: ${result.stderrPreview}`] : []),
    ...result.diagnostics.map((entry) => `  diagnostic ${entry.code}: ${entry.message}`),
    ...result.suggestedActions.map((action) => `  next: ${action}`)
  ];
}

async function runGit(platform: PlatformRuntime, workspaceRoot: string, action: GitReviewAction, requestedAction: string, args: readonly string[]): Promise<GitReviewResult> {
  const result = await platform.runProcess("git", args, processOptions(workspaceRoot));
  return gitResult(action, requestedAction, result.exitCode === 0 ? "completed" : "failed", `${args.join(" ")} exit=${result.exitCode}`, { readOnly: true, args }, result);
}

function gitInput(options: CliOptions): { readonly action: string; readonly args: readonly string[] } {
  return {
    action: typeof options.gitInput?.action === "string" ? options.gitInput.action : "status",
    args: Array.isArray(options.gitInput?.args) ? options.gitInput.args.filter((item): item is string => typeof item === "string") : []
  };
}

function gitResult(
  action: GitReviewAction,
  requestedAction: string,
  status: GitReviewResult["status"],
  summary: string,
  data: JsonObject,
  process?: ProcessResult,
  diagnostics: readonly RedactedError[] = [],
  suggestedActions: readonly string[] = status === "completed" ? [] : ["Use read-only git review commands and inspect diagnostics."]
): GitReviewResult {
  const resultList = gitResultList(action, process, diagnostics);
  return {
    schemaVersion: CLI_PALETTE_SCHEMA_VERSION,
    kind: "git.review",
    action,
    requestedAction,
    status,
    summary,
    data,
    ...(process ? { exitCode: process.exitCode, stdoutPreview: preview(process.stdout), stderrPreview: preview(process.stderr) } : {}),
    ...(resultList ? { resultList } : {}),
    referenceTargets: resultList?.items.map((item) => item.target) ?? [],
    diagnostics,
    suggestedActions,
    redaction: { class: "internal", fields: ["data", "stdoutPreview", "stderrPreview", "resultList.items.metadata", "referenceTargets.metadata"] }
  };
}

function actionKind(action: string): GitReviewAction {
  return action === "diff" || action === "review" ? action : "status";
}

function processOptions(cwd: string): { readonly cwd: string; readonly timeoutMs: number; readonly executionProfile: "noninteractive"; readonly stdin: "ignore"; readonly outputLimitBytes: number } {
  return { cwd, timeoutMs: 30_000, executionProfile: "noninteractive", stdin: "ignore", outputLimitBytes: 32_000 };
}

function isDestructiveGitAction(action: string, args: readonly string[]): boolean {
  if (destructiveGitActions.has(action)) return true;
  if (action === "branch" && args.some((arg) => arg === "-D" || arg === "-d" || arg === "--delete")) return true;
  return false;
}

function gitResultList(action: GitReviewAction, process: ProcessResult | undefined, diagnostics: readonly RedactedError[]): CliResultList | undefined {
  const items: CliResultListItem[] = [];
  if (process) {
    const lines = process.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 100);
    lines.forEach((line, order) => {
      const target = action === "diff" || line.includes("|")
        ? diffTarget(line)
        : statusTarget(line);
      items.push({
        id: `git-${action}:${stableId(line)}:${order}`,
        target,
        label: line,
        order,
        metadata: { source: "git.review", action, line }
      });
    });
  }
  const offset = items.length;
  diagnostics.forEach((entry, index) => {
    items.push({
      id: `git-diagnostic:${entry.code}`,
      target: { kind: "diagnostic", id: `diagnostic:${entry.code}`, label: entry.message, metadata: { source: "git.review", action, code: entry.code } },
      label: `${entry.code}: ${entry.message}`,
      order: offset + index,
      severity: "error",
      metadata: { source: "git.review", action, code: entry.code }
    });
  });
  if (items.length === 0) return undefined;
  return { id: `result-list:git.${action}`, kind: action === "status" ? "search" : "code-intelligence", sourceCommand: `git.${action}`, label: `Git ${action}`, items, ...(items[0] ? { activeItemId: items[0].id } : {}) };
}

function statusTarget(line: string): CliTargetRef {
  const path = line.replace(/^[A-Z? ][A-Z? ]\s+/, "").trim();
  return { kind: "file", id: `git-file:${stableId(path || line)}`, label: line, ...(path ? { path } : {}), metadata: { source: "git.status", statusCode: line.slice(0, 2).trim() } };
}

function diffTarget(line: string): CliTargetRef {
  const path = line.split("|")[0]?.trim() ?? line;
  return { kind: "diff", id: `git-diff:${stableId(line)}`, label: line, ...(path ? { path } : {}), metadata: { source: "git.diff" } };
}

function summaryRecord(result: GitReviewResult): JsonObject {
  return {
    schemaVersion: result.schemaVersion,
    action: result.action,
    requestedAction: result.requestedAction,
    status: result.status,
    summary: result.summary,
    data: result.data,
    exitCode: result.exitCode,
    itemCount: result.resultList?.items.length ?? 0,
    diagnosticCount: result.diagnostics.length,
    suggestedActions: result.suggestedActions,
    redaction: result.redaction
  };
}

function mergeProcessResult(status: ProcessResult, diff: ProcessResult): ProcessResult {
  const metadata = diff.metadata ?? status.metadata;
  return {
    exitCode: status.exitCode === 0 ? diff.exitCode : status.exitCode,
    stdout: `${status.stdout}\n${diff.stdout}`.trim(),
    stderr: `${status.stderr}\n${diff.stderr}`.trim(),
    ...(metadata ? { metadata } : {})
  };
}

function diagnostic(code: string, message: string): RedactedError {
  return { code, message, retryable: false, redaction: { class: "public" } };
}

function lineCount(value: string): number {
  return value.trim() ? value.trim().split(/\r?\n/).length : 0;
}

function preview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
