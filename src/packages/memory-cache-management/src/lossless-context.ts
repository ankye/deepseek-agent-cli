import type {
  JsonObject,
  LosslessContextDescribeRequest,
  LosslessContextDescribeResult,
  LosslessContextEdge,
  LosslessContextExpandRequest,
  LosslessContextExpandResult,
  LosslessContextGrepRequest,
  LosslessContextGrepResult,
  LosslessContextManager,
  LosslessContextMatch,
  LosslessContextNode,
  LosslessContextSourceClass,
  LosslessContextRecordInput,
  LosslessContextRecordResult,
  LosslessContextSummarizeRequest,
  LosslessContextSummarizeResult,
  RedactedError,
  SessionId,
  PlatformRuntime
} from "@deepseek/platform-contracts";
import { LOSSLESS_CONTEXT_SCHEMA_VERSION } from "@deepseek/platform-contracts";

const deterministicTime = new Date(0).toISOString();
const DEFAULT_FRESH_TAIL_COUNT = 32;
const DEFAULT_SUMMARY_THRESHOLD = 64;
const DEFAULT_SUMMARY_CHARS = 8_000;
const DEFAULT_EXPAND_LIMIT = 100;

export interface LosslessContextManagerOptions {
  readonly ignoreSessionPatterns?: readonly string[];
}

export class InMemoryLosslessContextManager implements LosslessContextManager {
  protected readonly nodes = new Map<string, LosslessContextNode>();
  protected readonly edges: LosslessContextEdge[] = [];
  private readonly ignoreSessionPatterns: readonly string[];

  constructor(options: LosslessContextManagerOptions = {}) {
    this.ignoreSessionPatterns = options.ignoreSessionPatterns ?? [];
  }

  async recordNode(input: LosslessContextRecordInput): Promise<LosslessContextRecordResult> {
    const node = normalizeNode(input.node);
    if (this.isIgnoredSession(node.sessionId)) {
      return recordResult("ignored", node, 0, []);
    }
    if (this.nodes.has(node.nodeId)) {
      return recordResult("duplicate", node, 0, []);
    }
    const edges = (input.edges ?? []).map((edge) => normalizeEdge(edge)).filter((edge) => edge.fromNodeId !== edge.toNodeId);
    this.nodes.set(node.nodeId, node);
    const acceptedEdges = this.appendEdges(edges);
    try {
      await this.persistRecord(node, acceptedEdges);
    } catch (error) {
      return recordResult("failed", node, acceptedEdges.length, [diagnostic("LOSSLESS_CONTEXT_PERSIST_FAILED", error instanceof Error ? error.message : "Lossless context persistence failed.")]);
    }
    return recordResult("recorded", node, acceptedEdges.length, []);
  }

  async grep(request: LosslessContextGrepRequest): Promise<LosslessContextGrepResult> {
    const query = request.query.trim();
    if (!query) {
      return grepResult("rejected", query, [], [diagnostic("LOSSLESS_CONTEXT_QUERY_REQUIRED", "query is required.")]);
    }
    const matcher = createMatcher(query, request.regex === true);
    if (!matcher.ok) {
      return grepResult("rejected", query, [], [matcher.error]);
    }
    const limit = boundedInteger(request.limit, 20, 0, 100);
    const matches = [...this.nodes.values()]
      .filter((node) => !request.sessionId || node.sessionId === request.sessionId)
      .map((node) => matchNode(node, matcher.match))
      .filter((match): match is LosslessContextMatch => Boolean(match))
      .sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId))
      .slice(0, limit);
    return grepResult("completed", query, matches, []);
  }

  async describe(request: LosslessContextDescribeRequest): Promise<LosslessContextDescribeResult> {
    const node = this.nodes.get(request.nodeId);
    const inboundEdges = this.edges.filter((edge) => edge.toNodeId === request.nodeId);
    const outboundEdges = this.edges.filter((edge) => edge.fromNodeId === request.nodeId);
    return {
      schemaVersion: LOSSLESS_CONTEXT_SCHEMA_VERSION,
      status: node ? "completed" : "missing",
      ...(node ? { node } : {}),
      inboundEdges,
      outboundEdges,
      diagnostics: node ? [] : [diagnostic("LOSSLESS_CONTEXT_NODE_MISSING", `Lossless context node not found: ${request.nodeId}`)],
      replayFingerprint: `lossless.describe:${stableHash(JSON.stringify({ nodeId: request.nodeId, found: Boolean(node), inbound: inboundEdges.length, outbound: outboundEdges.length }))}`,
      redaction: { class: "internal", fields: ["node.content"] }
    };
  }

  async expand(request: LosslessContextExpandRequest): Promise<LosslessContextExpandResult> {
    const limit = boundedInteger(request.limit, DEFAULT_EXPAND_LIMIT, 0, 500);
    const sourceNodeIds = request.nodeId
      ? [request.nodeId]
      : request.query
        ? (await this.grep({ query: request.query, ...(request.sessionId ? { sessionId: request.sessionId } : {}), limit })).matches.map((match) => match.nodeId)
        : [];
    if (sourceNodeIds.length === 0) {
      return expandResult("rejected", [], [], [diagnostic("LOSSLESS_CONTEXT_EXPAND_TARGET_REQUIRED", "nodeId or query is required for expansion.")]);
    }
    const expanded: LosslessContextNode[] = [];
    const seen = new Set<string>();
    for (const nodeId of sourceNodeIds) {
      const node = this.nodes.get(nodeId);
      if (!node) continue;
      const targets = node.kind === "summary" && node.coversNodeIds.length > 0
        ? node.coversNodeIds.map((coveredNodeId) => this.nodes.get(coveredNodeId)).filter((value): value is LosslessContextNode => Boolean(value))
        : [node];
      for (const target of targets) {
        if (seen.has(target.nodeId)) continue;
        seen.add(target.nodeId);
        expanded.push(target);
        if (expanded.length >= limit) break;
      }
      if (expanded.length >= limit) break;
    }
    const missing = expanded.length === 0;
    return expandResult(missing ? "missing" : "completed", sourceNodeIds, expanded, missing ? [diagnostic("LOSSLESS_CONTEXT_EXPAND_MISSING", "No expandable lossless context nodes were found.")] : []);
  }

  async summarize(request: LosslessContextSummarizeRequest): Promise<LosslessContextSummarizeResult> {
    const freshTailCount = boundedInteger(request.freshTailCount, DEFAULT_FRESH_TAIL_COUNT, 0, 10_000);
    const thresholdNodeCount = boundedInteger(request.thresholdNodeCount, DEFAULT_SUMMARY_THRESHOLD, 1, 100_000);
    const maxSummaryChars = boundedInteger(request.maxSummaryChars, DEFAULT_SUMMARY_CHARS, 256, 1_000_000);
    const sessionNodes = [...this.nodes.values()]
      .filter((node) => node.sessionId === request.sessionId && node.kind !== "summary")
      .sort(compareNodes);
    if (sessionNodes.length <= thresholdNodeCount) {
      return summarizeResult("skipped", request.sessionId, undefined, 0, freshTailCount, []);
    }
    const alreadyCovered = new Set([...this.nodes.values()].flatMap((node) => node.kind === "summary" ? node.coversNodeIds : []));
    const candidates = sessionNodes
      .slice(0, Math.max(0, sessionNodes.length - freshTailCount))
      .filter((node) => !alreadyCovered.has(node.nodeId));
    if (candidates.length === 0) {
      return summarizeResult("skipped", request.sessionId, undefined, 0, freshTailCount, []);
    }
    const summaryContent = boundedText([
      `Lossless context summary for ${request.sessionId}`,
      `Covered nodes: ${candidates.length}`,
      ...candidates.map((node) => `- ${node.role} ${node.nodeId} ${node.contentHash}: ${previewText(node.content, 180)}`)
    ].join("\n"), maxSummaryChars);
    const summaryNodeId = `lcm-summary-${request.sessionId}-${stableHash(candidates.map((node) => node.nodeId).join("|"))}`;
    const summaryNode = normalizeNode({
      schemaVersion: LOSSLESS_CONTEXT_SCHEMA_VERSION,
      nodeId: summaryNodeId,
      sessionId: request.sessionId,
      kind: "summary",
      role: "summary",
      sourceClass: "summary",
      content: summaryContent,
      contentHash: stableHash(summaryContent),
      createdAt: deterministicTime,
      coversNodeIds: candidates.map((node) => node.nodeId),
      metadata: {
        source: "lossless-context.summarize",
        freshTailCount,
        thresholdNodeCount,
        reversible: true
      },
      redaction: { class: "internal", fields: ["content"] }
    });
    const edges = candidates.map((node) => normalizeEdge({
      schemaVersion: LOSSLESS_CONTEXT_SCHEMA_VERSION,
      fromNodeId: summaryNode.nodeId,
      toNodeId: node.nodeId,
      kind: "summarizes",
      createdAt: deterministicTime,
      metadata: { source: "lossless-context.summarize" },
      redaction: { class: "internal" }
    }));
    const recorded = await this.recordNode({ node: summaryNode, edges });
    if (recorded.status === "failed") {
      return summarizeResult("failed", request.sessionId, summaryNode.nodeId, candidates.length, freshTailCount, recorded.diagnostics);
    }
    return summarizeResult(recorded.status === "recorded" ? "recorded" : "skipped", request.sessionId, summaryNode.nodeId, candidates.length, freshTailCount, []);
  }

  protected appendEdges(edges: readonly LosslessContextEdge[]): readonly LosslessContextEdge[] {
    const accepted: LosslessContextEdge[] = [];
    for (const edge of edges) {
      if (this.edges.some((existing) => existing.fromNodeId === edge.fromNodeId && existing.toNodeId === edge.toNodeId && existing.kind === edge.kind)) continue;
      this.edges.push(edge);
      accepted.push(edge);
    }
    return accepted;
  }

  protected async persistRecord(_node: LosslessContextNode, _edges: readonly LosslessContextEdge[]): Promise<void> {
    return Promise.resolve();
  }

  protected hydrateRecord(record: LosslessContextJsonlRecord): void {
    if (record.recordType === "node") {
      this.nodes.set(record.node.nodeId, normalizeNode(record.node));
      return;
    }
    this.appendEdges([normalizeEdge(record.edge)]);
  }

  private isIgnoredSession(sessionId: SessionId): boolean {
    return this.ignoreSessionPatterns.some((pattern) => globMatch(pattern, sessionId));
  }
}

export class PersistentJsonlLosslessContextManager extends InMemoryLosslessContextManager {
  private readonly logPath: string;
  private hydrated = false;

  constructor(private readonly platform: PlatformRuntime, private readonly root: string, options: LosslessContextManagerOptions = {}) {
    super(options);
    this.logPath = platform.resolvePath(root, "lossless-context.jsonl");
  }

  override async recordNode(input: LosslessContextRecordInput): Promise<LosslessContextRecordResult> {
    await this.ensureHydrated();
    return super.recordNode(input);
  }

  override async grep(request: LosslessContextGrepRequest): Promise<LosslessContextGrepResult> {
    await this.ensureHydrated();
    return super.grep(request);
  }

  override async describe(request: LosslessContextDescribeRequest): Promise<LosslessContextDescribeResult> {
    await this.ensureHydrated();
    return super.describe(request);
  }

  override async expand(request: LosslessContextExpandRequest): Promise<LosslessContextExpandResult> {
    await this.ensureHydrated();
    return super.expand(request);
  }

  override async summarize(request: LosslessContextSummarizeRequest): Promise<LosslessContextSummarizeResult> {
    await this.ensureHydrated();
    return super.summarize(request);
  }

  protected override async persistRecord(node: LosslessContextNode, edges: readonly LosslessContextEdge[]): Promise<void> {
    await this.platform.ensureDirectory(this.root);
    const lines = [
      JSON.stringify({ schemaVersion: LOSSLESS_CONTEXT_SCHEMA_VERSION, recordType: "node", node } satisfies LosslessContextJsonlRecord),
      ...edges.map((edge) => JSON.stringify({ schemaVersion: LOSSLESS_CONTEXT_SCHEMA_VERSION, recordType: "edge", edge } satisfies LosslessContextJsonlRecord))
    ].join("\n");
    await this.platform.appendFile(this.logPath, `${lines}\n`);
  }

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    let raw = "";
    try {
      raw = await this.platform.readFile(this.logPath);
    } catch {
      return;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as LosslessContextJsonlRecord;
        if (isLosslessContextJsonlRecord(parsed)) this.hydrateRecord(parsed);
      } catch {
        continue;
      }
    }
  }
}

type LosslessContextJsonlRecord =
  | { readonly schemaVersion: string; readonly recordType: "node"; readonly node: LosslessContextNode }
  | { readonly schemaVersion: string; readonly recordType: "edge"; readonly edge: LosslessContextEdge };

function normalizeNode(node: LosslessContextNode): LosslessContextNode {
  const content = redactLosslessText(String(node.content ?? ""));
  return {
    schemaVersion: LOSSLESS_CONTEXT_SCHEMA_VERSION,
    nodeId: String(node.nodeId),
    sessionId: node.sessionId,
    ...(node.turnId ? { turnId: node.turnId } : {}),
    kind: node.kind === "tool-result" || node.kind === "summary" ? node.kind : "message",
    role: node.role === "assistant" || node.role === "tool" || node.role === "system" || node.role === "summary" ? node.role : "user",
    sourceClass: sourceClassValue(node.sourceClass, node.role, node.kind, node.metadata),
    content,
    contentHash: stableHash(content),
    createdAt: typeof node.createdAt === "string" && node.createdAt ? node.createdAt : deterministicTime,
    coversNodeIds: Array.isArray(node.coversNodeIds) ? node.coversNodeIds.map(String) : [],
    metadata: isJsonObject(node.metadata) ? node.metadata : {},
    redaction: node.redaction ?? { class: "internal", fields: ["content"] }
  };
}

function normalizeEdge(edge: LosslessContextEdge): LosslessContextEdge {
  return {
    schemaVersion: LOSSLESS_CONTEXT_SCHEMA_VERSION,
    fromNodeId: String(edge.fromNodeId),
    toNodeId: String(edge.toNodeId),
    kind: edge.kind === "responds-to" || edge.kind === "tool-result-for" || edge.kind === "summarizes" || edge.kind === "references" ? edge.kind : "follows",
    createdAt: typeof edge.createdAt === "string" && edge.createdAt ? edge.createdAt : deterministicTime,
    metadata: isJsonObject(edge.metadata) ? edge.metadata : {},
    redaction: edge.redaction ?? { class: "internal" }
  };
}

function recordResult(
  status: LosslessContextRecordResult["status"],
  node: LosslessContextNode,
  edgeCount: number,
  diagnostics: readonly RedactedError[]
): LosslessContextRecordResult {
  return {
    schemaVersion: LOSSLESS_CONTEXT_SCHEMA_VERSION,
    status,
    nodeId: node.nodeId,
    sessionId: node.sessionId,
    edgeCount,
    contentHash: node.contentHash,
    diagnostics,
    replayFingerprint: `lossless.record:${stableHash(JSON.stringify({ status, nodeId: node.nodeId, edgeCount, diagnostics: diagnostics.map((entry) => entry.code) }))}`,
    redaction: { class: "internal", fields: ["diagnostics.details"] }
  };
}

function grepResult(
  status: LosslessContextGrepResult["status"],
  query: string,
  matches: readonly LosslessContextMatch[],
  diagnostics: readonly RedactedError[]
): LosslessContextGrepResult {
  return {
    schemaVersion: LOSSLESS_CONTEXT_SCHEMA_VERSION,
    status,
    query,
    matchCount: matches.length,
    matches,
    diagnostics,
    replayFingerprint: `lossless.grep:${stableHash(JSON.stringify({ status, query, matches: matches.map((match) => match.nodeId), diagnostics: diagnostics.map((entry) => entry.code) }))}`,
    redaction: { class: "internal", fields: ["matches.preview", "diagnostics.details"] }
  };
}

function expandResult(
  status: LosslessContextExpandResult["status"],
  sourceNodeIds: readonly string[],
  expandedNodes: readonly LosslessContextNode[],
  diagnostics: readonly RedactedError[]
): LosslessContextExpandResult {
  return {
    schemaVersion: LOSSLESS_CONTEXT_SCHEMA_VERSION,
    status,
    sourceNodeIds,
    expandedNodes,
    diagnostics,
    replayFingerprint: `lossless.expand:${stableHash(JSON.stringify({ status, sourceNodeIds, expanded: expandedNodes.map((node) => node.nodeId), diagnostics: diagnostics.map((entry) => entry.code) }))}`,
    redaction: { class: "internal", fields: ["expandedNodes.content", "diagnostics.details"] }
  };
}

function summarizeResult(
  status: LosslessContextSummarizeResult["status"],
  sessionId: SessionId,
  summaryNodeId: string | undefined,
  coveredNodeCount: number,
  freshTailCount: number,
  diagnostics: readonly RedactedError[]
): LosslessContextSummarizeResult {
  return {
    schemaVersion: LOSSLESS_CONTEXT_SCHEMA_VERSION,
    status,
    sessionId,
    ...(summaryNodeId ? { summaryNodeId } : {}),
    coveredNodeCount,
    freshTailCount,
    diagnostics,
    replayFingerprint: `lossless.summary:${stableHash(JSON.stringify({ status, sessionId, summaryNodeId: summaryNodeId ?? "", coveredNodeCount, freshTailCount, diagnostics: diagnostics.map((entry) => entry.code) }))}`,
    redaction: { class: "internal", fields: ["diagnostics.details"] }
  };
}

function createMatcher(query: string, regex: boolean): { readonly ok: true; readonly match: (value: string) => number } | { readonly ok: false; readonly error: RedactedError } {
  if (!regex) {
    const needle = query.toLowerCase();
    return {
      ok: true,
      match: (value) => occurrences(value.toLowerCase(), needle)
    };
  }
  try {
    const expression = new RegExp(query, "gi");
    return {
      ok: true,
      match: (value) => {
        const matches = value.match(expression);
        return matches?.length ?? 0;
      }
    };
  } catch (error) {
    return { ok: false, error: diagnostic("LOSSLESS_CONTEXT_REGEX_INVALID", error instanceof Error ? error.message : "Invalid regular expression.") };
  }
}

function matchNode(node: LosslessContextNode, matcher: (value: string) => number): LosslessContextMatch | undefined {
  const score = matcher(node.content);
  if (score <= 0) return undefined;
  return {
    nodeId: node.nodeId,
    sessionId: node.sessionId,
    ...(node.turnId ? { turnId: node.turnId } : {}),
    kind: node.kind,
    role: node.role,
    sourceClass: node.sourceClass,
    score,
    preview: previewText(node.content, 240),
    contentHash: node.contentHash,
    coveredNodeCount: node.coversNodeIds.length,
    redaction: { class: "internal", fields: ["preview"] }
  };
}

function sourceClassValue(value: unknown, role: LosslessContextNode["role"], kind: LosslessContextNode["kind"], metadata: unknown): LosslessContextSourceClass {
  if (
    value === "user-prompt" ||
    value === "assistant-output" ||
    value === "model-facing-tool-result" ||
    value === "mcp-result" ||
    value === "web-result" ||
    value === "connector-result" ||
    value === "browser-screen-context" ||
    value === "imported-transcript" ||
    value === "summary" ||
    value === "unknown"
  ) return value;
  const source = isJsonObject(metadata) ? String(metadata.source ?? "") : "";
  if (kind === "summary" || role === "summary" || source.includes("summarize")) return "summary";
  if (kind === "tool-result" || role === "tool") return "model-facing-tool-result";
  if (role === "assistant") return "assistant-output";
  if (role === "user") return "user-prompt";
  return "unknown";
}

function diagnostic(code: string, message: string): RedactedError {
  return {
    code,
    message,
    retryable: code.endsWith("_FAILED"),
    redaction: { class: "internal" }
  };
}

function compareNodes(a: LosslessContextNode, b: LosslessContextNode): number {
  const time = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (Number.isFinite(time) && time !== 0) return time;
  return a.nodeId.localeCompare(b.nodeId);
}

function isLosslessContextJsonlRecord(value: unknown): value is LosslessContextJsonlRecord {
  if (!isJsonObject(value) || value.schemaVersion !== LOSSLESS_CONTEXT_SCHEMA_VERSION) return false;
  if (value.recordType === "node") return isJsonObject(value.node);
  if (value.recordType === "edge") return isJsonObject(value.edge);
  return false;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function occurrences(value: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = value.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = value.indexOf(needle, index + Math.max(1, needle.length));
  }
  return count;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, numeric));
}

function boundedText(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

function previewText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 3))}...` : normalized;
}

function redactLosslessText(content: string): string {
  return content
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g, "Bearer [REDACTED:token]")
    .replace(/\b(?:sk|ds)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:api-key]")
    .replace(/\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s"',;]+/gi, (match) => {
      const [key] = match.split("=");
      return `${key}=[REDACTED:secret]`;
    });
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^:]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `h${(hash >>> 0).toString(16)}`;
}
