import type { AgentLoopOutputMode, CliResultList, CliResultListItem, CliTargetRef, JsonObject, PlatformRuntime, SearchResult, RedactedError } from "@deepseek/platform-contracts";
import { CLI_PALETTE_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import type { CliOptions, CliRunOptions } from "../types.js";
import { createCliAgentRuntime } from "../host/runtime.js";
import { resolveCliWorkspaceRoot } from "../host/workspace-root.js";

export type RepoNavigatorAction = "files" | "grep" | "recall" | "project-index";

export interface RepoNavigatorResult extends JsonObject {
  readonly schemaVersion: string;
  readonly kind: "repo.navigator";
  readonly action: RepoNavigatorAction;
  readonly status: "completed" | "failed" | "deferred";
  readonly query: string;
  readonly summary: string;
  readonly data: JsonObject;
  readonly resultList?: CliResultList;
  readonly referenceTargets: readonly CliTargetRef[];
  readonly diagnostics: readonly RedactedError[];
  readonly suggestedActions: readonly string[];
  readonly redaction: JsonObject;
}

export async function runRepoNavigatorCommand(options: CliOptions, write: (line: string) => Promise<void>, runOptions: CliRunOptions): Promise<void> {
  const workspaceRoot = await resolveCliWorkspaceRoot(runOptions);
  const runtime = await createCliAgentRuntime({ live: options.live, workspaceRoot }, runOptions);
  try {
    const input = repoInput(options);
    const result = await resolveRepoNavigator(runtime.deps.platform, workspaceRoot, input.action, input.query);
    for (const line of renderRepoNavigatorResult(result, options.output)) await write(line);
  } finally {
    await runtime.kernel.shutdown("cli-repo-navigator-completed");
  }
}

export async function resolveRepoNavigator(platform: PlatformRuntime, workspaceRoot: string, action: RepoNavigatorAction, query: string): Promise<RepoNavigatorResult> {
  const normalized = query.trim();
  if (!normalized) {
    return repoResult(action, "failed", "", "repo navigator requires a query", { provider: "none", itemCount: 0 }, undefined, [diagnostic("REPO_NAVIGATOR_QUERY_REQUIRED", "Provide a search query.")], ["Run repo files <query> or repo grep <query>."]);
  }
  if (action === "files") {
    const files = [...await platform.findFiles(normalized, workspaceRoot)].sort(compareString).slice(0, 100);
    const resultList = fileResultList(files, workspaceRoot);
    return repoResult(action, "completed", normalized, `files=${files.length}`, { provider: "platform.findFiles", itemCount: files.length, workspaceBoundary: "workspace-root" }, resultList);
  }
  if (action === "grep") {
    const matches = [...await platform.searchText(normalized, workspaceRoot)].sort(compareSearchResult).slice(0, 100);
    const resultList = grepResultList(matches, workspaceRoot);
    return repoResult(action, "completed", normalized, `matches=${matches.length}`, { provider: "platform.searchText", itemCount: matches.length, workspaceBoundary: "workspace-root" }, resultList);
  }
  return repoResult(
    action,
    "deferred",
    normalized,
    `${action} uses existing chat/index projection and is deferred in scriptable CLI`,
    { provider: action === "recall" ? "PageIndex recall" : "project index", workspaceBoundary: "workspace-root", deferred: true },
    deferredResultList(action, normalized),
    [diagnostic("REPO_NAVIGATOR_DEFERRED", `Use /palette recall or index-provider status for ${action}.`)],
    action === "recall" ? ["Open chat and use /palette recall with the same query."] : ["Run deepseek index-provider status to inspect project index availability."]
  );
}

export function renderRepoNavigatorResult(result: RepoNavigatorResult, output: AgentLoopOutputMode): readonly string[] {
  if (output === "json") return [JSON.stringify(result)];
  if (output === "jsonl") {
    return [
      JSON.stringify({ kind: "repo.navigator.summary", result: summaryRecord(result) }),
      ...(result.resultList ? result.resultList.items.map((item) => JSON.stringify({ kind: "repo.navigator.item", item })) : []),
      ...result.diagnostics.map((entry) => JSON.stringify({ kind: "repo.navigator.diagnostic", diagnostic: entry }))
    ];
  }
  const lines = [`repo ${result.action}: ${result.status} - ${result.summary}`];
  for (const item of result.resultList?.items.slice(0, 20) ?? []) lines.push(`  ${item.order + 1} ${item.label}`);
  for (const entry of result.diagnostics) lines.push(`  diagnostic ${entry.code}: ${entry.message}`);
  for (const action of result.suggestedActions) lines.push(`  next: ${action}`);
  return lines;
}

function repoInput(options: CliOptions): { readonly action: RepoNavigatorAction; readonly query: string } {
  const action = options.repoAction ?? "files";
  const query = typeof options.repoInput?.query === "string" ? options.repoInput.query : "";
  return { action, query };
}

function repoResult(
  action: RepoNavigatorAction,
  status: RepoNavigatorResult["status"],
  query: string,
  summary: string,
  data: JsonObject,
  resultList?: CliResultList,
  diagnostics: readonly RedactedError[] = [],
  suggestedActions: readonly string[] = []
): RepoNavigatorResult {
  return {
    schemaVersion: CLI_PALETTE_SCHEMA_VERSION,
    kind: "repo.navigator",
    action,
    status,
    query,
    summary,
    data,
    ...(resultList ? { resultList } : {}),
    referenceTargets: resultList?.items.map((item) => item.target) ?? [],
    diagnostics,
    suggestedActions,
    redaction: { class: "internal", fields: ["query", "data", "resultList.items.metadata", "referenceTargets.metadata"] }
  };
}

function fileResultList(files: readonly string[], workspaceRoot: string): CliResultList {
  const items = files.map((path, order): CliResultListItem => ({
    id: `repo-file:${stableId(path)}`,
    target: { kind: "file", id: `file:${stableId(path)}`, label: displayPath(path, workspaceRoot), path: normalizePath(path) },
    label: displayPath(path, workspaceRoot),
    order,
    metadata: { source: "repo.navigator.files" }
  }));
  return { id: "result-list:repo.files", kind: "search", sourceCommand: "repo.files", label: "Repo files", items, ...(items[0] ? { activeItemId: items[0].id } : {}) };
}

function deferredResultList(action: RepoNavigatorAction, query: string): CliResultList {
  const item: CliResultListItem = {
    id: `repo-${action}:deferred`,
    target: {
      kind: "diagnostic",
      id: `repo:${action}:deferred`,
      label: `${action} deferred`,
      metadata: { source: "repo.navigator", action, query, deferred: true }
    },
    label: `${action} deferred for query ${preview(query)}`,
    order: 0,
    severity: "warning",
    metadata: { source: "repo.navigator", action, query, deferred: true }
  };
  return { id: `result-list:repo.${action}`, kind: "code-intelligence", sourceCommand: `repo.${action}`, label: `Repo ${action}`, items: [item], activeItemId: item.id };
}

function grepResultList(matches: readonly SearchResult[], workspaceRoot: string): CliResultList {
  const items = matches.map((match, order): CliResultListItem => {
    const label = `${displayPath(match.path, workspaceRoot)}:${match.line}: ${preview(match.text)}`;
    return {
      id: `repo-grep:${stableId(label)}`,
      target: { kind: "file", id: `file:${stableId(match.path)}`, label, path: normalizePath(match.path), metadata: { line: match.line, preview: preview(match.text), engine: match.engine } },
      label,
      order,
      metadata: { source: "repo.navigator.grep", line: match.line, engine: match.engine }
    };
  });
  return { id: "result-list:repo.grep", kind: "search", sourceCommand: "repo.grep", label: "Repo grep", items, ...(items[0] ? { activeItemId: items[0].id } : {}) };
}

function summaryRecord(result: RepoNavigatorResult): JsonObject {
  return {
    schemaVersion: result.schemaVersion,
    action: result.action,
    status: result.status,
    query: result.query,
    summary: result.summary,
    data: result.data,
    itemCount: result.resultList?.items.length ?? 0,
    suggestedActions: result.suggestedActions,
    redaction: result.redaction
  };
}

function diagnostic(code: string, message: string): RedactedError {
  return { code, message, retryable: false, redaction: { class: "public" } };
}

function compareSearchResult(a: SearchResult, b: SearchResult): number {
  return compareString(a.path, b.path) || a.line - b.line || a.text.localeCompare(b.text, "en");
}

function compareString(a: string, b: string): number {
  return a.localeCompare(b, "en");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function displayPath(path: string, workspaceRoot: string): string {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(workspaceRoot).replace(/\/+$/, "");
  if (!normalizedRoot) return normalizedPath;
  if (normalizedPath === normalizedRoot) return ".";
  return normalizedPath.startsWith(`${normalizedRoot}/`) ? normalizedPath.slice(normalizedRoot.length + 1) : normalizedPath;
}

function preview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
