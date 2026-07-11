import type {
  AgentLoopOutputMode,
  CliResultList,
  CliResultListItem,
  CliTargetRef,
  CodeIntelligenceProviderMetadata,
  CodeIntelligenceService,
  JsonObject,
  PlatformRuntime,
  RedactedError,
  SearchResult,
  SymbolReference
} from "@deepseek/platform-contracts";
import { CLI_PALETTE_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import type { CliOptions, CliRunOptions } from "../types.js";
import { createCliAgentRuntime } from "../host/runtime.js";
import { resolveCliWorkspaceRoot } from "../host/workspace-root.js";

export type JumpNavigatorAction = "file" | "text" | "symbol";

export interface JumpNavigatorResult extends JsonObject {
  readonly schemaVersion: string;
  readonly kind: "jump.navigator";
  readonly action: JumpNavigatorAction;
  readonly status: "completed" | "failed" | "deferred";
  readonly query: string;
  readonly summary: string;
  readonly data: JsonObject;
  readonly resultList?: CliResultList;
  readonly activeTarget?: CliTargetRef;
  readonly referenceTargets: readonly CliTargetRef[];
  readonly diagnostics: readonly RedactedError[];
  readonly suggestedActions: readonly string[];
  readonly redaction: JsonObject;
}

export async function runJumpNavigatorCommand(options: CliOptions, write: (line: string) => Promise<void>, runOptions: CliRunOptions): Promise<void> {
  const workspaceRoot = await resolveCliWorkspaceRoot(runOptions);
  const runtime = await createCliAgentRuntime({ live: options.live, workspaceRoot }, runOptions);
  try {
    const input = jumpInput(options);
    const result = await resolveJumpNavigator(runtime.deps.platform, workspaceRoot, input.action, input.query, runtime.deps.codeIntelligence);
    for (const line of renderJumpNavigatorResult(result, options.output)) await write(line);
  } finally {
    await runtime.kernel.shutdown("cli-jump-navigator-completed");
  }
}

export async function resolveJumpNavigator(
  platform: PlatformRuntime,
  workspaceRoot: string,
  action: JumpNavigatorAction,
  query: string,
  codeIntelligence?: CodeIntelligenceService
): Promise<JumpNavigatorResult> {
  const normalized = query.trim();
  if (!normalized) {
    return jumpResult(action, "failed", "", "jump navigator requires a query", { provider: "none", itemCount: 0 }, undefined, undefined, [diagnostic("JUMP_NAVIGATOR_QUERY_REQUIRED", "Provide a file, text, or symbol query.")], ["Run /jump file <query>, /jump text <query>, or /jump symbol <query>."]);
  }
  if (action === "file") {
    const files = [...await platform.findFiles(normalized, workspaceRoot)].sort(compareString).slice(0, 50);
    const resultList = fileJumpResultList(files, workspaceRoot);
    return jumpResult(action, "completed", normalized, `files=${files.length}`, { provider: "platform.findFiles", itemCount: files.length, workspaceBoundary: "workspace-root" }, resultList, activeTarget(resultList), noMatchDiagnostics("file", files.length), noMatchSuggestions("file", files.length));
  }
  if (action === "text") {
    const matches = [...await platform.searchText(normalized, workspaceRoot)].sort(compareSearchResult).slice(0, 50);
    const resultList = textJumpResultList(matches, workspaceRoot);
    return jumpResult(action, "completed", normalized, `matches=${matches.length}`, { provider: "platform.searchText", itemCount: matches.length, workspaceBoundary: "workspace-root" }, resultList, activeTarget(resultList), noMatchDiagnostics("text", matches.length), noMatchSuggestions("text", matches.length));
  }
  return resolveSymbolJump(workspaceRoot, normalized, codeIntelligence);
}

function jumpInput(options: CliOptions): { readonly action: JumpNavigatorAction; readonly query: string } {
  const action = options.jumpAction ?? "file";
  const query = typeof options.jumpInput?.query === "string" ? options.jumpInput.query : "";
  return { action, query };
}

export function renderJumpNavigatorResult(result: JumpNavigatorResult, output: AgentLoopOutputMode): readonly string[] {
  if (output === "json") return [JSON.stringify(result)];
  if (output === "jsonl") {
    return [
      JSON.stringify({ kind: "jump.navigator.summary", result: summaryRecord(result) }),
      ...(result.resultList ? result.resultList.items.map((item) => JSON.stringify({ kind: "jump.navigator.item", item })) : []),
      ...result.diagnostics.map((entry) => JSON.stringify({ kind: "jump.navigator.diagnostic", diagnostic: entry }))
    ];
  }
  const lines = [`jump ${result.action}: ${result.status} - ${result.summary}`];
  for (const item of result.resultList?.items.slice(0, 20) ?? []) lines.push(`  ${item.order + 1} ${item.label}`);
  for (const entry of result.diagnostics) lines.push(`  diagnostic ${entry.code}: ${entry.message}`);
  for (const action of result.suggestedActions) lines.push(`  next: ${action}`);
  return lines;
}

function jumpResult(
  action: JumpNavigatorAction,
  status: JumpNavigatorResult["status"],
  query: string,
  summary: string,
  data: JsonObject,
  resultList?: CliResultList,
  active?: CliTargetRef,
  diagnostics: readonly RedactedError[] = [],
  suggestedActions: readonly string[] = []
): JumpNavigatorResult {
  return {
    schemaVersion: CLI_PALETTE_SCHEMA_VERSION,
    kind: "jump.navigator",
    action,
    status,
    query,
    summary,
    data,
    ...(resultList ? { resultList } : {}),
    ...(active ? { activeTarget: active } : {}),
    referenceTargets: resultList?.items.map((item) => item.target) ?? [],
    diagnostics,
    suggestedActions,
    redaction: { class: "internal", fields: ["query", "data", "resultList.items.metadata", "referenceTargets.metadata"] }
  };
}

function fileJumpResultList(files: readonly string[], workspaceRoot: string): CliResultList {
  const items = files.map((path, order): CliResultListItem => ({
    id: `jump-file:${stableId(path)}`,
    target: { kind: "file", id: `file:${stableId(path)}`, label: displayPath(path, workspaceRoot), path: normalizePath(path), metadata: { source: "jump.navigator.file" } },
    label: displayPath(path, workspaceRoot),
    order,
    metadata: { source: "jump.navigator.file" }
  }));
  return { id: "result-list:jump.file", kind: "search", sourceCommand: "jump.file", label: "Jump files", items, ...(items[0] ? { activeItemId: items[0].id } : {}) };
}

function textJumpResultList(matches: readonly SearchResult[], workspaceRoot: string): CliResultList {
  const items = matches.map((match, order): CliResultListItem => {
    const label = `${displayPath(match.path, workspaceRoot)}:${match.line}: ${preview(match.text)}`;
    return {
      id: `jump-text:${stableId(label)}`,
      target: { kind: "file", id: `file:${stableId(match.path)}`, label, path: normalizePath(match.path), metadata: { line: match.line, preview: preview(match.text), engine: match.engine, source: "jump.navigator.text" } },
      label,
      order,
      metadata: { source: "jump.navigator.text", line: match.line, engine: match.engine }
    };
  });
  return { id: "result-list:jump.text", kind: "search", sourceCommand: "jump.text", label: "Jump text", items, ...(items[0] ? { activeItemId: items[0].id } : {}) };
}

async function resolveSymbolJump(
  workspaceRoot: string,
  query: string,
  codeIntelligence: CodeIntelligenceService | undefined
): Promise<JumpNavigatorResult> {
  if (!codeIntelligence) {
    const missing = diagnostic("JUMP_NAVIGATOR_CODE_INTELLIGENCE_UNAVAILABLE", "Symbol jump requires an injected code-intelligence service.");
    const resultList = symbolDiagnosticResultList(query, missing, "error");
    return jumpResult("symbol", "failed", query, "code intelligence unavailable", { provider: "codeIntelligence.symbols", itemCount: 0, workspaceBoundary: "workspace-root", available: false }, resultList, activeTarget(resultList), [missing], ["Use /jump text <symbol> until code intelligence is available."]);
  }

  let indexed: Awaited<ReturnType<CodeIntelligenceService["index"]>>;
  try {
    indexed = await codeIntelligence.index(workspaceRoot);
  } catch (error) {
    indexed = {
      ok: false,
      error: diagnostic("JUMP_NAVIGATOR_SYMBOL_INDEX_FAILED", error instanceof Error ? error.message : "Code intelligence index failed.")
    };
  }
  if (!indexed.ok || !indexed.value) {
    const indexError = indexed.error ?? diagnostic("JUMP_NAVIGATOR_SYMBOL_INDEX_FAILED", "Code intelligence index failed.");
    const resultList = symbolDiagnosticResultList(query, indexError, "error");
    return jumpResult("symbol", "failed", query, "symbol index failed", { provider: "codeIntelligence.index", itemCount: 0, workspaceBoundary: "workspace-root" }, resultList, activeTarget(resultList), [indexError], ["Use /jump text <symbol> while code intelligence recovers."]);
  }

  const provider = indexed.value.metadata.provider;
  const symbols = [...await codeIntelligence.symbols(query)].sort(compareSymbolReference).slice(0, 50);
  const resultList = symbolJumpResultList(symbols, query, provider, workspaceRoot);
  const diagnostics = symbols.length === 0
    ? [...provider.diagnostics, diagnostic("JUMP_NAVIGATOR_SYMBOL_NO_MATCH", "No symbols matched the query in the indexed workspace.")]
    : [];
  return jumpResult(
    "symbol",
    "completed",
    query,
    `symbols=${symbols.length}`,
    {
      provider: "codeIntelligence.symbols",
      itemCount: symbols.length,
      workspaceBoundary: "workspace-root",
      index: {
        provider: provider.provider,
        providerStatus: provider.status,
        indexedFileCount: provider.indexedFileCount,
        truncated: provider.truncated,
        providerDiagnostics: provider.diagnostics
      }
    },
    resultList,
    activeTarget(resultList),
    diagnostics,
    symbols.length === 0 ? ["Run /jump text <query> to search raw text.", "Try a broader symbol query."] : []
  );
}

function noMatchDiagnostics(action: Extract<JumpNavigatorAction, "file" | "text">, itemCount: number): readonly RedactedError[] {
  if (itemCount > 0) return [];
  if (action === "file") return [diagnostic("JUMP_NAVIGATOR_FILE_NO_MATCH", "No files matched the query in the current workspace.")];
  return [diagnostic("JUMP_NAVIGATOR_TEXT_NO_MATCH", "No text matches were found in the current workspace.")];
}

function noMatchSuggestions(action: Extract<JumpNavigatorAction, "file" | "text">, itemCount: number): readonly string[] {
  if (itemCount > 0) return [];
  if (action === "file") return ["Run /jump text <query> to search file contents.", "Try a broader file query."];
  return ["Run /jump file <query> to search paths.", "Try a broader text query."];
}

function symbolJumpResultList(symbols: readonly SymbolReference[], query: string, provider: CodeIntelligenceProviderMetadata, workspaceRoot: string): CliResultList {
  const items = symbols.map((symbol, order): CliResultListItem => {
    const path = normalizePath(symbol.path);
    const labelPath = displayPath(symbol.path, workspaceRoot);
    const line = symbol.line ?? symbol.range?.startLine ?? 1;
    const kind = symbol.kind ?? "unknown";
    const label = `${labelPath}:${line}: ${kind} ${symbol.name}`;
    const metadata: JsonObject = {
      source: "jump.navigator.symbol",
      symbolName: symbol.name,
      symbolKind: kind,
      symbolSource: symbol.source ?? "definition",
      line,
      provider: provider.provider,
      providerStatus: provider.status,
      provenance: symbol.provenance,
      range: symbol.range,
      redaction: { class: "internal", fields: ["provenance"] }
    };
    return {
      id: `jump-symbol:${stableId(`${symbol.name}:${path}:${line}:${order}`)}`,
      target: { kind: "file", id: `file:${stableId(path)}`, label, path, metadata },
      label,
      order,
      metadata
    };
  });
  return {
    id: "result-list:jump.symbol",
    kind: "code-intelligence",
    sourceCommand: "jump.symbol",
    label: "Jump symbols",
    items,
    ...(items[0] ? { activeItemId: items[0].id } : {}),
    metadata: {
      source: "jump.navigator.symbol",
      query,
      provider: provider.provider,
      providerStatus: provider.status,
      indexedFileCount: provider.indexedFileCount,
      truncated: provider.truncated,
      redaction: { class: "internal", fields: ["query"] }
    }
  };
}

function symbolDiagnosticResultList(query: string, entry: RedactedError, severity: NonNullable<CliResultListItem["severity"]>): CliResultList {
  const item: CliResultListItem = {
    id: `jump-symbol:diagnostic:${entry.code}`,
    target: {
      kind: "diagnostic",
      id: `jump:symbol:${entry.code}`,
      label: entry.message,
      metadata: { source: "jump.navigator.symbol", query, diagnosticCode: entry.code }
    },
    label: `${entry.code}: ${preview(query)}`,
    order: 0,
    severity,
    metadata: { source: "jump.navigator.symbol", query, diagnosticCode: entry.code }
  };
  return { id: "result-list:jump.symbol", kind: "code-intelligence", sourceCommand: "jump.symbol", label: "Jump symbols", items: [item], activeItemId: item.id };
}

function activeTarget(resultList: CliResultList | undefined): CliTargetRef | undefined {
  const item = resultList?.items.find((candidate) => candidate.id === resultList.activeItemId) ?? resultList?.items[0];
  return item?.target;
}

function summaryRecord(result: JumpNavigatorResult): JsonObject {
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

function compareSymbolReference(a: SymbolReference, b: SymbolReference): number {
  return compareString(a.path, b.path) || (a.line ?? 0) - (b.line ?? 0) || a.name.localeCompare(b.name, "en");
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
