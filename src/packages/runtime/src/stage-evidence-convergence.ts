import type { JsonObject } from "@deepseek/platform-contracts";
import { stableHash } from "./trace.js";

export interface StageEvidenceReadRange extends JsonObject {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

export interface StageEvidenceWindowState {
  readonly stageKey: string;
  readonly targetPath?: string;
  readonly relatedTargetPaths: readonly string[];
  readonly acceptedOperations: number;
  readonly maxAcceptedOperations: number;
  readonly coveredReadRanges: readonly StageEvidenceReadRange[];
  readonly searchEvidenceFingerprints: readonly string[];
}

export type StageEvidenceRequestDecision = "allow" | "duplicate" | "wrong-target" | "exhausted";

export function createStageEvidenceWindow(input: {
  readonly stageKey: string;
  readonly capabilityId: string;
  readonly toolInput: JsonObject;
  readonly relatedTargetPaths?: readonly string[];
  readonly maxAcceptedOperations?: number;
}): StageEvidenceWindowState {
  const targetPath = evidenceTargetPath(input.capabilityId, input.toolInput);
  return {
    stageKey: input.stageKey,
    ...(targetPath ? { targetPath } : {}),
    relatedTargetPaths: [...new Set((input.relatedTargetPaths ?? []).map(normalizeEvidenceTarget))],
    acceptedOperations: 0,
    maxAcceptedOperations: input.maxAcceptedOperations ?? 2,
    coveredReadRanges: [],
    searchEvidenceFingerprints: []
  };
}

export function stageEvidenceRequestDecision(
  state: StageEvidenceWindowState,
  capabilityId: string,
  toolInput: JsonObject
): StageEvidenceRequestDecision {
  if (state.acceptedOperations >= state.maxAcceptedOperations) return "exhausted";
  const requestedPath = evidenceTargetPath(capabilityId, toolInput);
  if (
    state.targetPath &&
    requestedPath &&
    !sameEvidenceTarget(state.targetPath, requestedPath) &&
    !state.relatedTargetPaths.some((path) => sameEvidenceTarget(path, requestedPath)) &&
    !(capabilityId === "core.search.text" && isFocusedEvidenceSearchTarget(state, requestedPath, toolInput))
  ) return "wrong-target";
  if (capabilityId !== "core.file.read") return "allow";
  const requestedRange = readRange(toolInput);
  if (!requestedRange || !requestedPath) return "allow";
  const covered = state.coveredReadRanges.filter((range) => sameEvidenceTarget(range.path, requestedPath));
  return rangeAddsCoverage(requestedRange, covered) ? "allow" : "duplicate";
}

export function focusedStageEvidenceSearchGlob(
  state: StageEvidenceWindowState | undefined,
  toolInput: JsonObject
): string | undefined {
  if (typeof toolInput.glob === "string" && toolInput.glob.trim()) return toolInput.glob;
  if (typeof toolInput.path !== "string" || !toolInput.path.trim()) return undefined;
  const path = normalizeEvidenceTarget(toolInput.path);
  return state && isDirectEvidenceParent(state, path) ? `${path}/**/*` : path;
}

export function nextStageEvidenceReadOffset(
  state: StageEvidenceWindowState,
  path: string
): number {
  const covered = state.coveredReadRanges
    .filter((range) => sameEvidenceTarget(range.path, path))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let offset = 0;
  for (const range of covered) {
    if (range.start > offset) break;
    if (range.end >= offset) offset = range.end + 1;
  }
  return offset;
}

export function acceptStageEvidenceRead(
  state: StageEvidenceWindowState,
  toolInput: JsonObject,
  content?: string
): StageEvidenceWindowState {
  const path = evidenceTargetPath("core.file.read", toolInput);
  const range = readRange(toolInput);
  const relatedTargetPaths = path && content
    ? [...new Set([...state.relatedTargetPaths, ...directRelativeDependencyPaths(path, content)])]
    : state.relatedTargetPaths;
  if (!path || !range) {
    return { ...state, relatedTargetPaths, acceptedOperations: state.acceptedOperations + 1 };
  }
  return {
    ...state,
    relatedTargetPaths,
    acceptedOperations: state.acceptedOperations + 1,
    coveredReadRanges: mergeReadRanges([...state.coveredReadRanges, { path, ...range }])
  };
}

export function acceptStageEvidenceSearch(
  state: StageEvidenceWindowState,
  toolInput: JsonObject,
  content: string
): { readonly state: StageEvidenceWindowState; readonly duplicate: boolean; readonly fingerprint: string } {
  const fingerprint = searchEvidenceFingerprint(toolInput, content);
  if (state.searchEvidenceFingerprints.includes(fingerprint)) {
    return { state, duplicate: true, fingerprint };
  }
  return {
    state: {
      ...state,
      acceptedOperations: state.acceptedOperations + 1,
      searchEvidenceFingerprints: [...state.searchEvidenceFingerprints, fingerprint]
    },
    duplicate: false,
    fingerprint
  };
}

function searchEvidenceFingerprint(toolInput: JsonObject, content: string): string {
  const pattern = typeof toolInput.pattern === "string" ? toolInput.pattern : "";
  if (toolInput.multiline === true || !pattern) return `search:${stableHash(normalizeSearchEvidence(content))}`;
  let matcher: RegExp;
  try {
    matcher = new RegExp(pattern, toolInput.caseInsensitive === true ? "i" : "");
  } catch {
    return `search:${stableHash(normalizeSearchEvidence(content))}`;
  }
  const matches = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const parsed = /^(.*):(\d+):\s?(.*)$/.exec(line);
    if (!parsed) continue;
    const path = parsed[1] ?? "";
    const lineNumber = parsed[2] ?? "";
    const text = parsed[3] ?? "";
    if (matcher.test(text)) matches.add(`${normalizeEvidenceTarget(path)}:${lineNumber}:${text.trimEnd()}`);
  }
  const normalized = matches.size > 0 ? [...matches].sort().join("\n") : normalizeSearchEvidence(content);
  return `search:${stableHash(normalized)}`;
}

function normalizeSearchEvidence(content: string): string {
  return content.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line !== "--").join("\n").trim();
}

function directRelativeDependencyPaths(sourcePath: string, content: string): readonly string[] {
  const paths = new Set<string>();
  for (const match of content.matchAll(/^\s*from\s+(\.+)([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+/gm)) {
    const dots = match[1]?.length ?? 0;
    const moduleName = match[2] ?? "";
    const resolved = resolvePythonRelativeModule(sourcePath, dots, moduleName);
    if (resolved) paths.add(resolved);
  }
  for (const match of content.matchAll(/(?:\bfrom\s*|\brequire\s*\(|\bimport\s*\()(["'])(\.\.?\/[^"']+)\1/g)) {
    const reference = match[2] ?? "";
    for (const candidate of resolveScriptRelativeModule(sourcePath, reference)) paths.add(candidate);
  }
  return [...paths];
}

function resolvePythonRelativeModule(sourcePath: string, dots: number, moduleName: string): string | undefined {
  if (dots < 1 || !moduleName) return undefined;
  const base = normalizeEvidenceTarget(sourcePath).split("/").slice(0, -1);
  base.splice(Math.max(0, base.length - (dots - 1)));
  return normalizeEvidenceTarget([...base, ...moduleName.split(".")].join("/") + ".py");
}

function resolveScriptRelativeModule(sourcePath: string, reference: string): readonly string[] {
  const base = normalizeEvidenceTarget(sourcePath).split("/").slice(0, -1);
  for (const segment of reference.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") base.pop();
    else base.push(segment);
  }
  const resolved = normalizeEvidenceTarget(base.join("/"));
  if (/\.[A-Za-z0-9]+$/.test(resolved)) return [resolved];
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((extension) => resolved + extension);
}

export function stageEvidenceWindowShouldClose(
  state: StageEvidenceWindowState,
  _capabilityId: string
): boolean {
  return state.acceptedOperations >= state.maxAcceptedOperations;
}

function evidenceTargetPath(capabilityId: string, toolInput: JsonObject): string | undefined {
  const value = capabilityId === "core.search.text"
    ? typeof toolInput.path === "string" && toolInput.path.trim()
      ? toolInput.path
      : toolInput.glob
    : toolInput.path;
  return typeof value === "string" && value.trim() ? normalizeEvidenceTarget(value) : undefined;
}

function isDirectEvidenceParent(state: StageEvidenceWindowState, requestedPath: string): boolean {
  const requested = normalizeEvidenceTarget(requestedPath).replace(/\/$/, "");
  if (!requested || requested === "." || requested === "**" || requested === "**/*") return false;
  return [state.targetPath, ...state.relatedTargetPaths]
    .filter((path): path is string => Boolean(path))
    .some((path) => directParentPath(path) === requested);
}

function isFocusedEvidenceSearchTarget(
  state: StageEvidenceWindowState,
  requestedPath: string,
  toolInput: JsonObject
): boolean {
  if (isDirectEvidenceParent(state, requestedPath)) return true;
  if (typeof toolInput.glob !== "string" || !toolInput.glob.trim()) return false;
  const glob = toolInput.glob.replaceAll("\\", "/").replace(/^\.\//, "");
  const wildcardIndex = glob.search(/[?*]/);
  if (wildcardIndex < 0) return false;
  const parentSeparator = glob.lastIndexOf("/", wildcardIndex);
  const scopedParent = parentSeparator < 0 ? "" : normalizeEvidenceTarget(glob.slice(0, parentSeparator));
  if (!scopedParent || scopedParent === ".") return false;
  return [state.targetPath, ...state.relatedTargetPaths]
    .filter((path): path is string => typeof path === "string" && !/[?*]/.test(path))
    .some((path) => directParentPath(path) === scopedParent && matchesEvidenceGlob(path, glob));
}

function matchesEvidenceGlob(path: string, glob: string): boolean {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === "*" && next === "*" && glob[index + 2] === "/") {
      source += "(?:.*/)?";
      index += 2;
    } else if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += /[\\^$.*+?()[\]{}|]/.test(char ?? "") ? `\\${char}` : char;
    }
  }
  return new RegExp(`^${source}$`).test(normalizeEvidenceTarget(path));
}

function directParentPath(path: string): string {
  const segments = normalizeEvidenceTarget(path).split("/").filter(Boolean);
  return segments.slice(0, -1).join("/");
}

function normalizeEvidenceTarget(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\*\*\//, "");
}

function sameEvidenceTarget(left: string, right: string): boolean {
  return normalizeEvidenceTarget(left) === normalizeEvidenceTarget(right);
}

function readRange(toolInput: JsonObject): { readonly start: number; readonly end: number } | undefined {
  const offset = typeof toolInput.offset === "number" && Number.isFinite(toolInput.offset)
    ? Math.max(0, Math.floor(toolInput.offset))
    : undefined;
  const limit = typeof toolInput.limit === "number" && Number.isFinite(toolInput.limit)
    ? Math.max(1, Math.floor(toolInput.limit))
    : undefined;
  if (offset === undefined || limit === undefined) return undefined;
  return { start: offset, end: offset + limit - 1 };
}

function rangeAddsCoverage(
  requested: { readonly start: number; readonly end: number },
  covered: readonly StageEvidenceReadRange[]
): boolean {
  for (let line = requested.start; line <= requested.end; line += 1) {
    if (!covered.some((range) => line >= range.start && line <= range.end)) return true;
  }
  return false;
}

function mergeReadRanges(ranges: readonly StageEvidenceReadRange[]): readonly StageEvidenceReadRange[] {
  const grouped = new Map<string, StageEvidenceReadRange[]>();
  for (const range of ranges) {
    const existing = grouped.get(range.path) ?? [];
    existing.push(range);
    grouped.set(range.path, existing);
  }
  const merged: StageEvidenceReadRange[] = [];
  for (const [path, pathRanges] of grouped) {
    const sorted = [...pathRanges].sort((left, right) => left.start - right.start || left.end - right.end);
    for (const range of sorted) {
      const previous = merged.at(-1);
      if (previous?.path === path && range.start <= previous.end + 1) {
        merged[merged.length - 1] = { path, start: previous.start, end: Math.max(previous.end, range.end) };
      } else {
        merged.push(range);
      }
    }
  }
  return merged;
}
