import type {
  AgentLoopOutputMode,
  CliResultList,
  CliResultListItem,
  CliTargetRef,
  JsonObject,
  LosslessContextDescribeResult,
  LosslessContextExpandResult,
  LosslessContextGrepResult,
  LosslessContextManager,
  LosslessContextMatch,
  LosslessContextNode,
  LosslessContextSummarizeResult,
  RedactedError,
  SessionId
} from "@deepseek/platform-contracts";
import { CLI_PALETTE_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import type { CliOptions, CliRunOptions } from "../types.js";
import { createCliAgentRuntime } from "../host/runtime.js";
import { resolveCliWorkspaceRoot } from "../host/workspace-root.js";
import type { ChatSessionState } from "./chat-state.js";
import { ensureChatPaletteState } from "./palette-state.js";

export type ContextCompactorAction = "status" | "grep" | "describe" | "summarize" | "expand" | "budget" | "pin";
export type ContextCompactorStatus = "completed" | "failed" | "skipped" | "unavailable";

export interface ContextCompactorInput extends JsonObject {
  readonly action: ContextCompactorAction;
  readonly query?: string;
  readonly target?: string;
  readonly limit?: number;
  readonly sessionId?: SessionId;
}

export interface ContextCompactorResult extends JsonObject {
  readonly schemaVersion: string;
  readonly kind: "context.compactor";
  readonly action: ContextCompactorAction;
  readonly status: ContextCompactorStatus;
  readonly summary: string;
  readonly data: JsonObject;
  readonly diagnostics: readonly RedactedError[];
  readonly resultList?: CliResultList;
  readonly referenceTarget?: CliTargetRef;
  readonly redaction: JsonObject;
}

const CONTEXT_DEFAULT_LIMIT = 40;

export function parseContextCompactorInput(raw: string, sessionId: SessionId | undefined): ContextCompactorInput {
  const tokens = raw.split(/\s+/).filter(Boolean);
  const action = contextAction(tokens[0]);
  const limit = parseLimit(tokens);
  const rest = tokens.filter((token, index) => index > 0 && token !== "--limit" && tokens[index - 1] !== "--limit").join(" ").trim();
  const base = {
    action,
    ...(sessionId ? { sessionId } : {}),
    ...(limit ? { limit } : {})
  };
  if (action === "grep") return { ...base, query: rest };
  if (action === "describe" || action === "expand" || action === "pin") return { ...base, target: rest };
  return base;
}

export async function runContextCompactorCommand(manager: LosslessContextManager | undefined, input: ContextCompactorInput): Promise<ContextCompactorResult> {
  if (!manager) {
    return contextResult(input.action, "unavailable", "context compactor: lossless context manager unavailable", {
      available: false,
      reason: "lossless-context-manager-unavailable"
    }, [diagnostic("CONTEXT_COMPACTOR_UNAVAILABLE", "Lossless context manager is unavailable.")]);
  }
  try {
    if (input.action === "status") return contextStatus(manager, input);
    if (input.action === "budget") return contextBudget(manager, input);
    if (input.action === "grep") return contextGrep(manager, input);
    if (input.action === "describe") return contextDescribe(manager, input);
    if (input.action === "expand") return contextExpand(manager, input);
    if (input.action === "summarize") return contextSummarize(manager, input);
    return contextPin(input);
  } catch (error) {
    return contextResult(input.action, "failed", `context compactor: failed action=${input.action}`, {}, [
      diagnostic("CONTEXT_COMPACTOR_FAILED", error instanceof Error ? error.message : "Context compactor command failed.")
    ]);
  }
}

export async function runContextCommand(options: CliOptions, write: (line: string) => Promise<void>, runOptions: CliRunOptions): Promise<void> {
  const workspaceRoot = await resolveCliWorkspaceRoot(runOptions);
  const runtime = await createCliAgentRuntime({ live: options.live, workspaceRoot }, runOptions);
  try {
    const raw = typeof options.contextInput?.raw === "string" ? options.contextInput.raw : "";
    const input = parseContextCompactorInput(raw, options.sessionId);
    const result = await runContextCompactorCommand(runtime.deps.losslessContext, input);
    for (const line of renderContextCompactorResult(result, options.output)) await write(line);
  } finally {
    await runtime.kernel.shutdown("cli-context-completed");
  }
}

export async function handleChatContextSlashCommand(
  raw: string,
  options: CliOptions,
  state: ChatSessionState,
  writeLocalLines: (kind: string, lines: readonly string[]) => Promise<void>
): Promise<void> {
  const input = parseContextCompactorInput(raw, state.sessionId);
  const result = await runContextCompactorCommand(state.workspaceDeps?.losslessContext, input);
  if (result.resultList) {
    const palette = ensureChatPaletteState(state.palette);
    const activeItem = result.resultList.items.find((item) => item.id === result.resultList?.activeItemId) ?? result.resultList.items[0];
    state.palette = {
      ...palette,
      snapshot: {
        ...palette.snapshot,
        mode: "result-list",
        ...(activeItem ? { activeTarget: activeItem.target } : {}),
        resultLists: [result.resultList, ...palette.snapshot.resultLists.filter((list) => list.id !== result.resultList?.id)]
      }
    };
  }
  await writeLocalLines("chat.command.context", renderContextCompactorResult(result, options.output));
}

export function renderContextCompactorResult(result: ContextCompactorResult, output: AgentLoopOutputMode): readonly string[] {
  if (output === "json") return [JSON.stringify(result)];
  if (output === "jsonl") {
    return [
      JSON.stringify({ kind: "context.compactor.summary", result: summaryRecord(result) }),
      ...(result.resultList ? result.resultList.items.map((item) => JSON.stringify({ kind: "context.compactor.item", resultListId: result.resultList?.id, active: result.resultList?.activeItemId === item.id, item })) : []),
      ...result.diagnostics.map((entry) => JSON.stringify({ kind: "context.compactor.diagnostic", diagnostic: entry }))
    ];
  }
  const lines = [`context ${result.action}: ${result.status} - ${result.summary}`];
  const items = result.resultList?.items ?? [];
  if (items.length > 0) {
    lines.push(`  results=${items.length} active=${result.resultList?.activeItemId ?? "none"}`);
    for (const item of items.slice(0, 12)) lines.push(`  ${result.resultList?.activeItemId === item.id ? "*" : " "} ${item.order + 1} ${item.label}`);
  }
  if (result.referenceTarget) lines.push(`  pin target=${result.referenceTarget.id}`);
  for (const entry of result.diagnostics) lines.push(`  diagnostic ${entry.code}: ${entry.message}`);
  return lines;
}

async function contextStatus(manager: LosslessContextManager, input: ContextCompactorInput): Promise<ContextCompactorResult> {
  const all = await grepAll(manager, input);
  const summaryCount = all.matches.filter((match) => match.kind === "summary").length;
  const data = {
    available: true,
    sessionId: input.sessionId,
    sampledNodeCount: all.matches.length,
    sampledSummaryCount: summaryCount,
    freshTailCount: 32,
    sampleLimit: boundedLimit(input.limit),
    diagnostics: all.diagnostics.map((entry) => entry.code)
  };
  return contextResult("status", all.status === "completed" ? "completed" : "skipped", `sampled=${all.matches.length} summaries=${summaryCount} freshTail=32`, data, all.diagnostics, matchesResultList("context.status", all.matches));
}

async function contextBudget(manager: LosslessContextManager, input: ContextCompactorInput): Promise<ContextCompactorResult> {
  const all = await grepAll(manager, input);
  const pressure = all.matches.length > 48 ? "tight" : all.matches.length > 24 ? "watch" : "ok";
  const data = {
    pressure,
    sampledNodeCount: all.matches.length,
    freshTailCount: 32,
    sampleLimit: boundedLimit(input.limit),
    excludedReasonCounts: {},
    diagnostics: all.diagnostics.map((entry) => entry.code)
  };
  return contextResult("budget", all.status === "completed" ? "completed" : "skipped", `pressure=${pressure} sampled=${all.matches.length}`, data, all.diagnostics, matchesResultList("context.budget", all.matches));
}

async function contextGrep(manager: LosslessContextManager, input: ContextCompactorInput): Promise<ContextCompactorResult> {
  const query = input.query?.trim();
  if (!query) return contextResult("grep", "failed", "context grep requires a query", {}, [diagnostic("CONTEXT_GREP_QUERY_REQUIRED", "Usage: /context grep <query>")]);
  const result = await manager.grep({ query, ...(input.sessionId ? { sessionId: input.sessionId } : {}), limit: boundedLimit(input.limit) });
  return contextResult("grep", result.status === "completed" ? "completed" : "failed", `matches=${result.matchCount} query=${query}`, grepData(result), result.diagnostics, matchesResultList("context.grep", result.matches));
}

async function contextDescribe(manager: LosslessContextManager, input: ContextCompactorInput): Promise<ContextCompactorResult> {
  const nodeId = input.target?.trim();
  if (!nodeId) return contextResult("describe", "failed", "context describe requires a node id", {}, [diagnostic("CONTEXT_DESCRIBE_TARGET_REQUIRED", "Usage: /context describe <node-id>")]);
  const result = await manager.describe({ nodeId });
  const resultList = result.node ? nodesResultList("context.describe", [result.node]) : undefined;
  return contextResult("describe", result.status === "completed" ? "completed" : "failed", result.node ? `node=${result.node.nodeId} inbound=${result.inboundEdges.length} outbound=${result.outboundEdges.length}` : `missing node=${nodeId}`, describeData(result), result.diagnostics, resultList);
}

async function contextExpand(manager: LosslessContextManager, input: ContextCompactorInput): Promise<ContextCompactorResult> {
  const target = input.target?.trim();
  if (!target) return contextResult("expand", "failed", "context expand requires a node id or query", {}, [diagnostic("CONTEXT_EXPAND_TARGET_REQUIRED", "Usage: /context expand <node-id|query>")]);
  const request = looksLikeNodeId(target)
    ? { nodeId: target, ...(input.sessionId ? { sessionId: input.sessionId } : {}), limit: boundedLimit(input.limit) }
    : { query: target, ...(input.sessionId ? { sessionId: input.sessionId } : {}), limit: boundedLimit(input.limit) };
  const result = await manager.expand(request);
  return contextResult("expand", result.status === "completed" ? "completed" : result.status === "missing" ? "skipped" : "failed", `expanded=${result.expandedNodes.length}`, expandData(result), result.diagnostics, nodesResultList("context.expand", result.expandedNodes));
}

async function contextSummarize(manager: LosslessContextManager, input: ContextCompactorInput): Promise<ContextCompactorResult> {
  if (!input.sessionId) return contextResult("summarize", "failed", "context summarize requires an active session", {}, [diagnostic("CONTEXT_SUMMARIZE_SESSION_REQUIRED", "Run chat in a session before summarizing context.")]);
  const result = await manager.summarize({ sessionId: input.sessionId });
  const status = result.status === "recorded" ? "completed" : result.status === "skipped" ? "skipped" : "failed";
  return contextResult("summarize", status, `summary=${result.summaryNodeId ?? "none"} covered=${result.coveredNodeCount} freshTail=${result.freshTailCount}`, summarizeData(result), result.diagnostics);
}

function contextPin(input: ContextCompactorInput): ContextCompactorResult {
  const target = input.target?.trim();
  if (!target) return contextResult("pin", "failed", "context pin requires a target", {}, [diagnostic("CONTEXT_PIN_TARGET_REQUIRED", "Usage: /context pin <node-id|target-id>")]);
  const referenceTarget: CliTargetRef = {
    kind: "tool-evidence",
    id: contextTargetId(target),
    label: target,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    metadata: { source: "context.compactor.pin", target }
  };
  return contextResult("pin", "completed", `pinned ${target}`, { target, referenceTarget }, [], undefined, referenceTarget);
}

function contextResult(
  action: ContextCompactorAction,
  status: ContextCompactorStatus,
  summary: string,
  data: JsonObject,
  diagnostics: readonly RedactedError[],
  resultList?: CliResultList,
  referenceTarget?: CliTargetRef
): ContextCompactorResult {
  return {
    schemaVersion: CLI_PALETTE_SCHEMA_VERSION,
    kind: "context.compactor",
    action,
    status,
    summary: redactSecretText(summary),
    data,
    diagnostics,
    ...(resultList ? { resultList } : {}),
    ...(referenceTarget ? { referenceTarget } : {}),
    redaction: { class: "internal", fields: ["data", "resultList.items.metadata", "referenceTarget.metadata"] }
  };
}

async function grepAll(manager: LosslessContextManager, input: ContextCompactorInput): Promise<LosslessContextGrepResult> {
  return manager.grep({ query: ".", regex: true, ...(input.sessionId ? { sessionId: input.sessionId } : {}), limit: boundedLimit(input.limit) });
}

function matchesResultList(sourceCommand: string, matches: readonly LosslessContextMatch[]): CliResultList {
  const items = matches.map(matchResultListItem);
  return {
    id: `result-list:${sourceCommand}`,
    kind: "search",
    sourceCommand,
    label: sourceCommand,
    items,
    ...(items[0] ? { activeItemId: items[0].id } : {}),
    metadata: { sourceCommand, renderedCount: items.length }
  };
}

function nodesResultList(sourceCommand: string, nodes: readonly LosslessContextNode[]): CliResultList {
  const items = nodes.map(nodeResultListItem);
  return {
    id: `result-list:${sourceCommand}`,
    kind: "tool-results",
    sourceCommand,
    label: sourceCommand,
    items,
    ...(items[0] ? { activeItemId: items[0].id } : {}),
    metadata: { sourceCommand, renderedCount: items.length }
  };
}

function matchResultListItem(match: LosslessContextMatch, order: number): CliResultListItem {
  const label = `${match.role} ${match.nodeId} ${previewText(match.preview, 140)}`;
  return {
    id: `context-result:${stableReferenceId(match.nodeId)}`,
    target: contextTarget(match.nodeId, label, match.sessionId, match.turnId, {
      sourceClass: match.sourceClass,
      kind: match.kind,
      contentHash: match.contentHash,
      coveredNodeCount: match.coveredNodeCount,
      score: match.score
    }),
    label,
    order,
    metadata: { source: "context.compactor", nodeId: match.nodeId, sourceClass: match.sourceClass, contentHash: match.contentHash, preview: match.preview }
  };
}

function nodeResultListItem(node: LosslessContextNode, order: number): CliResultListItem {
  const label = `${node.role} ${node.nodeId} ${previewText(node.content, 140)}`;
  return {
    id: `context-node:${stableReferenceId(node.nodeId)}`,
    target: contextTarget(node.nodeId, label, node.sessionId, node.turnId, {
      sourceClass: node.sourceClass,
      kind: node.kind,
      contentHash: node.contentHash,
      coveredNodeCount: node.coversNodeIds.length
    }),
    label,
    order,
    metadata: { source: "context.compactor", nodeId: node.nodeId, sourceClass: node.sourceClass, contentHash: node.contentHash, coveredNodeCount: node.coversNodeIds.length }
  };
}

function contextTarget(nodeId: string, label: string, sessionId: SessionId, turnId: LosslessContextNode["turnId"] | LosslessContextMatch["turnId"], metadata: JsonObject): CliTargetRef {
  return {
    kind: "tool-evidence",
    id: contextTargetId(nodeId),
    label,
    sessionId,
    ...(turnId ? { turnId } : {}),
    metadata
  };
}

function contextTargetId(target: string): string {
  return `context:${stableReferenceId(target)}:${target}`;
}

function summaryRecord(result: ContextCompactorResult): JsonObject {
  return {
    schemaVersion: result.schemaVersion,
    action: result.action,
    status: result.status,
    summary: result.summary,
    itemCount: result.resultList?.items.length ?? 0,
    diagnosticCount: result.diagnostics.length,
    redaction: result.redaction
  };
}

function grepData(result: LosslessContextGrepResult): JsonObject {
  return { status: result.status, query: result.query, matchCount: result.matchCount, replayFingerprint: result.replayFingerprint };
}

function describeData(result: LosslessContextDescribeResult): JsonObject {
  return {
    status: result.status,
    nodeId: result.node?.nodeId,
    kind: result.node?.kind,
    sourceClass: result.node?.sourceClass,
    inboundEdgeCount: result.inboundEdges.length,
    outboundEdgeCount: result.outboundEdges.length,
    replayFingerprint: result.replayFingerprint
  };
}

function expandData(result: LosslessContextExpandResult): JsonObject {
  return {
    status: result.status,
    sourceNodeIds: result.sourceNodeIds,
    expandedNodeCount: result.expandedNodes.length,
    replayFingerprint: result.replayFingerprint
  };
}

function summarizeData(result: LosslessContextSummarizeResult): JsonObject {
  return {
    status: result.status,
    sessionId: result.sessionId,
    summaryNodeId: result.summaryNodeId,
    coveredNodeCount: result.coveredNodeCount,
    freshTailCount: result.freshTailCount,
    replayFingerprint: result.replayFingerprint
  };
}

function contextAction(value: string | undefined): ContextCompactorAction {
  if (value === "grep" || value === "describe" || value === "summarize" || value === "expand" || value === "budget" || value === "pin") return value;
  return "status";
}

function parseLimit(tokens: readonly string[]): number | undefined {
  const index = tokens.indexOf("--limit");
  if (index < 0) return undefined;
  const value = Number(tokens[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function boundedLimit(value: number | undefined): number {
  return Math.min(100, Math.max(1, value ?? CONTEXT_DEFAULT_LIMIT));
}

function looksLikeNodeId(value: string): boolean {
  return value.startsWith("lcm-") || value.startsWith("context:") || value.includes("summary");
}

function diagnostic(code: string, message: string): RedactedError {
  return {
    code,
    message: redactSecretText(message),
    retryable: false,
    redaction: { class: "public" }
  };
}

function previewText(value: string, limit: number): string {
  const normalized = redactSecretText(value).replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 3))}...` : normalized;
}

function redactSecretText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g, "Bearer [REDACTED:token]")
    .replace(/\b(?:sk|ds)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:api-key]")
    .replace(/\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s"',;]+/gi, (match) => {
      const [key] = match.split("=");
      return `${key}=[REDACTED:secret]`;
    });
}

function stableReferenceId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
