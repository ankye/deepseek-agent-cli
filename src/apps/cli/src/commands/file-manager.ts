import type { AgentLoopOutputMode, CliReferenceItem, CliResultList, CliResultListItem, CliTargetRef, JsonObject, PlatformRuntime, RedactedError } from "@deepseek/platform-contracts";
import { CLI_PALETTE_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import type { CliOptions, CliRunOptions } from "../types.js";
import { createCliAgentRuntime } from "../host/runtime.js";
import { resolveCliWorkspaceRoot } from "../host/workspace-root.js";

export type FileManagerAction = "list" | "preview" | "references";

export interface FileManagerResult extends JsonObject {
  readonly schemaVersion: string;
  readonly kind: "file.manager";
  readonly action: FileManagerAction;
  readonly status: "completed" | "failed";
  readonly query: string;
  readonly summary: string;
  readonly data: JsonObject;
  readonly resultList?: CliResultList;
  readonly referenceTargets: readonly CliTargetRef[];
  readonly referenceItems: readonly CliReferenceItem[];
  readonly diagnostics: readonly RedactedError[];
  readonly suggestedActions: readonly string[];
  readonly redaction: JsonObject;
}

export async function runFileManagerCommand(options: CliOptions, write: (line: string) => Promise<void>, runOptions: CliRunOptions): Promise<void> {
  const workspaceRoot = await resolveCliWorkspaceRoot(runOptions);
  const runtime = await createCliAgentRuntime({ live: options.live, workspaceRoot }, runOptions);
  try {
    const input = fileInput(options);
    const result = await resolveFileManager(runtime.deps.platform, workspaceRoot, input.action, input.query);
    for (const line of renderFileManagerResult(result, options.output)) await write(line);
  } finally {
    await runtime.kernel.shutdown("cli-file-manager-completed");
  }
}

export async function resolveFileManager(platform: PlatformRuntime, workspaceRoot: string, action: FileManagerAction, query: string): Promise<FileManagerResult> {
  const normalized = query.trim();
  if (!normalized) {
    return fileManagerResult(action, "failed", "", "file manager requires a file query or path", { provider: "none", itemCount: 0 }, undefined, [], [diagnostic("FILE_MANAGER_QUERY_REQUIRED", "Provide a file query or path.")], ["Run /file list <query> or /file preview <path>."]);
  }
  if (action === "preview") {
    const path = await resolvePreviewPath(platform, workspaceRoot, normalized);
    if (!path) return fileManagerResult(action, "failed", normalized, `no file matched ${preview(normalized)}`, { provider: "platform.findFiles", itemCount: 0 }, undefined, [], [diagnostic("FILE_MANAGER_FILE_NOT_FOUND", `No file matched ${normalized}.`)], ["Run /file list with a broader query."]);
    const content = await platform.readFile(path).catch(() => "");
    const resultList = previewResultList(path, content, workspaceRoot);
    return fileManagerResult(action, "completed", normalized, `preview=${displayPath(path, workspaceRoot)} bytes=${content.length}`, { provider: "platform.readFile", path: normalizePath(path), bytes: content.length, previewLineCount: previewLines(content).length }, resultList);
  }
  const files = [...await platform.findFiles(normalized, workspaceRoot)].sort(compareString).slice(0, 100);
  const resultList = fileResultList(action, files, workspaceRoot);
  const references = action === "references" ? referenceItems(files, workspaceRoot) : [];
  return fileManagerResult(action, "completed", normalized, `files=${files.length}`, { provider: "platform.findFiles", itemCount: files.length, workspaceBoundary: "workspace-root" }, resultList, references);
}

export function renderFileManagerResult(result: FileManagerResult, output: AgentLoopOutputMode): readonly string[] {
  if (output === "json") return [JSON.stringify(result)];
  if (output === "jsonl") {
    return [
      JSON.stringify({ kind: "file.manager.summary", result: summaryRecord(result) }),
      ...(result.resultList ? result.resultList.items.map((item) => JSON.stringify({ kind: "file.manager.item", item })) : []),
      ...result.diagnostics.map((entry) => JSON.stringify({ kind: "file.manager.diagnostic", diagnostic: entry }))
    ];
  }
  const lines = [`file ${result.action}: ${result.status} - ${result.summary}`];
  for (const item of result.resultList?.items.slice(0, 20) ?? []) lines.push(`  ${item.order + 1} ${item.label}`);
  for (const entry of result.diagnostics) lines.push(`  diagnostic ${entry.code}: ${entry.message}`);
  for (const action of result.suggestedActions) lines.push(`  next: ${action}`);
  return lines;
}

async function resolvePreviewPath(platform: PlatformRuntime, workspaceRoot: string, query: string): Promise<string | undefined> {
  const resolved = platform.resolveWorkspacePath(workspaceRoot, query);
  const direct = resolved.ok && resolved.value ? resolved.value.path : undefined;
  const directContent = direct ? await platform.readFile(direct).then(() => direct, () => undefined) : undefined;
  if (directContent) return directContent;
  const matches = [...await platform.findFiles(query, workspaceRoot)].sort(compareString);
  return matches[0];
}

function fileInput(options: CliOptions): { readonly action: FileManagerAction; readonly query: string } {
  const action = options.fileAction ?? "list";
  const query = typeof options.fileInput?.query === "string" ? options.fileInput.query : "";
  return { action, query };
}

function fileManagerResult(
  action: FileManagerAction,
  status: FileManagerResult["status"],
  query: string,
  summary: string,
  data: JsonObject,
  resultList?: CliResultList,
  referenceItemsInput: readonly CliReferenceItem[] = [],
  diagnostics: readonly RedactedError[] = [],
  suggestedActions: readonly string[] = []
): FileManagerResult {
  const referenceTargets = referenceItemsInput.length > 0 ? referenceItemsInput.map((item) => item.target) : resultList?.items.map((item) => item.target) ?? [];
  return {
    schemaVersion: CLI_PALETTE_SCHEMA_VERSION,
    kind: "file.manager",
    action,
    status,
    query,
    summary,
    data,
    ...(resultList ? { resultList } : {}),
    referenceTargets,
    referenceItems: referenceItemsInput,
    diagnostics,
    suggestedActions,
    redaction: { class: "internal", fields: ["query", "data", "resultList.items.metadata", "referenceItems.target.metadata", "referenceTargets.metadata"] }
  };
}

function fileResultList(action: FileManagerAction, files: readonly string[], workspaceRoot: string): CliResultList {
  const items = files.map((path, order): CliResultListItem => fileItem(path, order, `file.manager.${action}`, workspaceRoot));
  return { id: `result-list:file-manager.${action}`, kind: "search", sourceCommand: `file.${action}`, label: `File manager ${action}`, items, ...(items[0] ? { activeItemId: items[0].id } : {}) };
}

function previewResultList(path: string, content: string, workspaceRoot: string): CliResultList {
  const lines = previewLines(content);
  const labelPath = displayPath(path, workspaceRoot);
  const items: CliResultListItem[] = lines.map((line, order) => ({
    id: `file-preview:${stableId(`${path}:${order}`)}`,
    target: { kind: "file", id: `file:${stableId(path)}`, label: `${labelPath}:${order + 1}`, path: normalizePath(path), metadata: { line: order + 1, preview: line } },
    label: `${labelPath}:${order + 1}: ${line}`,
    order,
    metadata: { source: "file.manager.preview", line: order + 1 }
  }));
  if (items.length === 0) items.push(fileItem(path, 0, "file.manager.preview", workspaceRoot));
  return { id: "result-list:file-manager.preview", kind: "search", sourceCommand: "file.preview", label: `File preview ${labelPath}`, items, ...(items[0] ? { activeItemId: items[0].id } : {}) };
}

function fileItem(path: string, order: number, source: string, workspaceRoot: string): CliResultListItem {
  const label = displayPath(path, workspaceRoot);
  return {
    id: `${source}:file:${stableId(path)}`,
    target: { kind: "file", id: `file:${stableId(path)}`, label, path: normalizePath(path) },
    label,
    order,
    metadata: { source }
  };
}

function referenceItems(files: readonly string[], workspaceRoot: string): readonly CliReferenceItem[] {
  return files.slice(0, 40).map((path, order): CliReferenceItem => ({
    id: `file-ref:${stableId(path)}`,
    kind: "file",
    target: { kind: "file", id: `file:${stableId(path)}`, label: displayPath(path, workspaceRoot), path: normalizePath(path) },
    label: displayPath(path, workspaceRoot),
    provenance: { source: "file.manager.references" },
    order
  }));
}

function previewLines(content: string): readonly string[] {
  return content.split(/\r?\n/).slice(0, 20).map((line) => preview(line)).filter((line) => line.length > 0);
}

function summaryRecord(result: FileManagerResult): JsonObject {
  return {
    schemaVersion: result.schemaVersion,
    action: result.action,
    status: result.status,
    query: result.query,
    summary: result.summary,
    data: result.data,
    itemCount: result.resultList?.items.length ?? 0,
    referenceCount: result.referenceTargets.length,
    suggestedActions: result.suggestedActions,
    redaction: result.redaction
  };
}

function diagnostic(code: string, message: string): RedactedError {
  return { code, message, retryable: false, redaction: { class: "public" } };
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
