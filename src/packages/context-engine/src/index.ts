import type {
  CacheManager,
  CodeIntelligenceService,
  ContextBlock,
  ContextPipelineDiagnostic,
  ContextPipelineLayer,
  ContextPipelineLayerId,
  ContextPipelineManifest,
  ContextPipelineManifestComparison,
  ContextPrefixHash,
  ContextEngine,
  ContextGraphNode,
  ContextNode,
  ContextNodeExclusionReason,
  ContextNodeId,
  ContextProjection,
  ContextProjectionBudgetDecision,
  ContextProjectionCacheMetadata,
  ContextProjectionRedactionSummary,
  ContextProjectionRequest,
  ContextProjectionResult,
  ExcludedContextNode,
  JsonObject,
  ProjectedContextNode,
  RedactionClass,
  RedactionMetadata,
  SessionId
} from "@deepseek/platform-contracts";
import {
  CONTEXT_PIPELINE_COMPATIBILITY,
  CONTEXT_PIPELINE_LAYER_ORDER,
  CONTEXT_PIPELINE_SCHEMA_VERSION,
  CONTEXT_PROJECTION_SCHEMA_VERSION,
  asId,
  contextPipelineBlockStableId,
  contextPipelineLayerOrder,
  contextPipelinePrefixStableId
} from "@deepseek/platform-contracts";
import { PROJECTION_CACHE_NAMESPACE, createProjectionCacheEntry, projectionCacheKey } from "@deepseek/memory-cache-management";
import type { ProjectionCacheInput } from "@deepseek/memory-cache-management";
import { createSecretRedactionDecision, redactSecretText } from "@deepseek/policy-sandbox";

export const CONTEXT_PROJECTION_CACHE_NAMESPACE = PROJECTION_CACHE_NAMESPACE;
const CONTEXT_PROJECTION_NO_STORE_CACHE_KEY = asId<"cacheKey">(`${CONTEXT_PROJECTION_CACHE_NAMESPACE}:no-store`);

export interface InMemoryContextEngineOptions {
  readonly cache?: CacheManager;
  readonly codeIntelligence?: CodeIntelligenceService;
}

export class InMemoryContextEngine implements ContextEngine {
  private readonly nodes = new Map<string, ContextGraphNode[]>();
  private readonly projectionCache = new Map<string, ContextProjectionResult>();
  private readonly cache?: CacheManager;
  private readonly codeIntelligence?: CodeIntelligenceService;

  constructor(options: InMemoryContextEngineOptions = {}) {
    if (options.cache) this.cache = options.cache;
    if (options.codeIntelligence) this.codeIntelligence = options.codeIntelligence;
  }

  async addNode(sessionId: SessionId, node: ContextNode): Promise<void> {
    const current = this.nodes.get(sessionId) ?? [];
    current.push(normalizeStoredNode(sessionId, node));
    this.nodes.set(sessionId, current);
  }

  async project(sessionId: SessionId, prompt: string): Promise<ContextProjection> {
    const request = createProjectionRequest({
      sessionId,
      prompt,
      hardLimitTokens: 8192,
      softLimitTokens: 6144,
      availableRedactionClasses: ["public", "internal", "sensitive"]
    });
    const projection = await this.projectGraph(request);
    return {
      prompt: projection.prompt,
      nodes: projection.selectedNodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        content: node.content,
        metadata: {
          source: node.source,
          priority: node.priority,
          estimatedTokens: node.estimatedTokens,
          redactionClass: node.redaction.class
        }
      }))
    };
  }

  async projectGraph(request: ContextProjectionRequest): Promise<ContextProjectionResult> {
    if (request.schemaVersion !== CONTEXT_PROJECTION_SCHEMA_VERSION) {
      return rejectedProjection(request, "unsupported-schema", "Unsupported context projection schema version");
    }

    const baseCandidates = this.candidatesFor(request);
    const candidates = await this.enrichCandidates(request, baseCandidates);
    const cacheCandidates = projectionCacheCandidates(candidates);
    const cacheInput = cacheCandidates.length > 0 ? buildProjectionCacheInput(request, cacheCandidates) : undefined;
    const cacheKey = cacheInput ? projectionCacheKey(cacheInput) : CONTEXT_PROJECTION_NO_STORE_CACHE_KEY;
    if (cacheInput && this.cache) {
      const cached = await this.cache.get<ContextProjectionResult>(cacheKey);
      if (cached) {
        return buildProjectionResult(request, candidates, cacheCandidates, cacheKey, true);
      }
    } else if (cacheInput) {
      const local = this.projectionCache.get(cacheKey);
      if (local) {
        return buildProjectionResult(request, candidates, cacheCandidates, cacheKey, true);
      }
    }

    const frozen = buildProjectionResult(request, candidates, cacheCandidates, cacheKey, false);
    if (frozen.status !== "rejected" && cacheInput) {
      if (this.cache) {
        await this.cache.set(createProjectionCacheEntry(cacheInput, frozen, new Date(0).toISOString()));
      } else {
        this.projectionCache.set(cacheKey, frozen);
      }
    }
    return frozen;
  }

  private candidatesFor(request: ContextProjectionRequest): readonly ContextGraphNode[] {
    const stored = this.nodes.get(request.sessionId) ?? [];
    const promptNode = normalizeGraphNode(request.sessionId, {
      schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION,
      id: asId<"contextNode">(`context-current-${request.sessionId}-${request.turnId ?? "turn"}`),
      kind: "user",
      source: "user",
      lifecycle: "turn",
      scope: {
        sessionId: request.sessionId,
        ...(request.turnId ? { turnId: request.turnId } : {}),
        ...(request.scope.agentId ? { agentId: request.scope.agentId } : {}),
        ...(request.scope.workspaceRoot ? { workspaceRoot: request.scope.workspaceRoot } : {}),
        ...(request.scope.host ? { host: request.scope.host } : {})
      },
      priority: 1000,
      content: request.prompt,
      estimatedTokens: countTokens(request.prompt),
      redaction: classifyRedaction(request.prompt, { class: "public" }),
      provenance: { source: "runtime.prompt" },
      dependencyFingerprints: [`prompt:${stableHash(request.prompt)}`],
      compatibility: { schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION },
      createdAt: "1970-01-01T00:00:00.000Z"
    });
    const requested = request.candidateNodes ?? [];
    return [...stored, ...requested.map((node) => normalizeGraphNode(request.sessionId, node)), promptNode];
  }

  private async enrichCandidates(
    request: ContextProjectionRequest,
    candidates: readonly ContextGraphNode[]
  ): Promise<readonly ContextGraphNode[]> {
    if (!this.codeIntelligence) return candidates;
    try {
      const enrich = await this.codeIntelligence.contextNodes({
        sessionId: request.sessionId,
        root: request.scope.workspaceRoot ?? "/workspace",
        includeDiagnostics: true,
        includeSymbols: true
      });
      if (!enrich.ok || !enrich.value) return candidates;
      const seen = new Set(candidates.map((node) => String(node.id)));
      const extras: ContextGraphNode[] = [];
      for (const node of enrich.value.nodes) {
        const id = String(node.id);
        if (seen.has(id)) continue;
        seen.add(id);
        extras.push(normalizeGraphNode(request.sessionId, node));
      }
      return extras.length > 0 ? [...candidates, ...extras] : candidates;
    } catch {
      return candidates;
    }
  }
}

export interface ProjectionRequestInput {
  readonly sessionId: SessionId;
  readonly prompt: string;
  readonly hardLimitTokens: number;
  readonly softLimitTokens?: number;
  readonly availableRedactionClasses?: readonly RedactionClass[];
}

export function createProjectionRequest(input: ProjectionRequestInput): ContextProjectionRequest {
  return {
    schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION,
    sessionId: input.sessionId,
    purpose: "model-request",
    prompt: input.prompt,
    budget: {
      hardLimitTokens: input.hardLimitTokens,
      ...(input.softLimitTokens !== undefined ? { softLimitTokens: input.softLimitTokens } : {}),
      reservedOutputTokens: 1024
    },
    scope: {
      sessionId: input.sessionId,
      availableRedactionClasses: input.availableRedactionClasses ?? ["public", "internal"]
    },
    trace: {
      traceId: asId<"trace">(`trace-context-${input.sessionId}`),
      spanId: asId<"span">(`span-context-${input.sessionId}`),
      correlationId: asId<"correlation">(`corr-context-${input.sessionId}`),
      sessionId: input.sessionId
    },
    policy: { redaction: "fail-closed" },
    compatibility: { schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION }
  };
}

export interface ProjectIndexDocumentInput {
  readonly path: string;
  readonly content: string;
  readonly language?: string;
  readonly redactionClass?: RedactionClass;
}

export interface DeriveContextPipelineManifestOptions {
  readonly maxStableToolResultTokens?: number;
  readonly maxSessionBlocksBeforeCompaction?: number;
}

const DEFAULT_STABLE_TOOL_RESULT_TOKENS = 96;

export function deriveContextPipelineManifest(
  projection: ContextProjectionResult,
  options: DeriveContextPipelineManifestOptions = {}
): ContextPipelineManifest {
  const maxStableToolResultTokens = Math.max(1, options.maxStableToolResultTokens ?? DEFAULT_STABLE_TOOL_RESULT_TOKENS);
  const blocks: ContextBlock[] = [];
  const excludedBlocks = projection.excludedNodes.map((node) => ({
    id: `context-excluded:${node.id}:${node.reason}`,
    sourceNodeId: node.id,
    layer: layerForProjectedLike(node),
    reason: node.reason,
    estimatedTokens: node.estimatedTokens,
    dependencyFingerprints: [],
    redaction: node.redaction
  }));
  const diagnostics = diagnosticsForExcludedNodes(projection.excludedNodes, excludedBlocks);

  let order = 0;
  for (const node of projection.selectedNodes) {
    const layer = layerForProjectedNode(node);
    if (isOversizedToolResult(node, maxStableToolResultTokens) && layer !== "current-turn") {
      const summary = summaryBlockFor(node, order, maxStableToolResultTokens, projection.replayFingerprint);
      order += 1;
      const raw = blockForProjectedNode(node, "current-turn", order, projection.replayFingerprint, {
        cachePolicy: "ephemeral",
        provenance: {
          ...node.provenance,
          volatileTailFor: String(node.id)
        }
      });
      order += 1;
      blocks.push(summary, raw);
      continue;
    }
    blocks.push(blockForProjectedNode(node, layer, order, projection.replayFingerprint));
    order += 1;
  }

  const layerOrderedBlocks = [...blocks].sort((left, right) => {
    const layerDelta = contextPipelineLayerOrder(left.layer) - contextPipelineLayerOrder(right.layer);
    return layerDelta !== 0 ? layerDelta : left.order - right.order;
  });
  const orderedBlocks = compactSessionBlocks(layerOrderedBlocks, projection.replayFingerprint, options.maxSessionBlocksBeforeCompaction);
  const layers = buildPipelineLayers(orderedBlocks);
  const prefixHashes = layers.map((layer) => prefixHashForLayer(layer));
  const cacheHintSummary = summarizeCacheHints(orderedBlocks);
  const pipelineFingerprint = `pipeline:${stableHash(JSON.stringify(prefixHashes.map((entry) => [entry.layer, entry.prefixHash])))}`;
  return Object.freeze({
    schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION,
    manifestId: `context-pipeline:${pipelineFingerprint}`,
    sessionId: projection.sessionId,
    ...(projection.turnId ? { turnId: projection.turnId } : {}),
    layers,
    blocks: orderedBlocks,
    excludedBlocks,
    prefixHashes,
    tokenTotals: {
      selectedTokens: projection.budget.selectedTokens,
      excludedTokens: projection.budget.excludedTokens,
      hardLimitTokens: projection.budget.hardLimitTokens,
      ...(projection.budget.softLimitTokens !== undefined ? { softLimitTokens: projection.budget.softLimitTokens } : {})
    },
    cacheHintSummary,
    pipelineFingerprint,
    diagnostics,
    redaction: { class: "internal" as const, fields: ["blocks.content", "blocks.contentPreview", "excludedBlocks"] },
    compatibility: CONTEXT_PIPELINE_COMPATIBILITY
  });
}

export function compareContextPipelineManifests(
  previous: ContextPipelineManifest,
  current: ContextPipelineManifest
): ContextPipelineManifestComparison {
  let firstChangedLayer: ContextPipelineLayerId | undefined;
  let firstChangedBlockId: string | undefined;
  let affectedTokens = 0;
  let stableLayerCount = 0;
  let changedLayerCount = 0;
  const diagnostics: ContextPipelineDiagnostic[] = [];
  for (const layerId of CONTEXT_PIPELINE_LAYER_ORDER) {
    const previousLayer = previous.layers.find((layer) => layer.id === layerId);
    const currentLayer = current.layers.find((layer) => layer.id === layerId);
    if (previousLayer?.prefixHash === currentLayer?.prefixHash) {
      stableLayerCount += 1;
      continue;
    }
    changedLayerCount += 1;
    if (!firstChangedLayer) {
      firstChangedLayer = layerId;
      affectedTokens = currentLayer?.estimatedTokens ?? 0;
      firstChangedBlockId = firstChangedBlock(previousLayer, currentLayer);
    }
    const changedBlockId = firstChangedBlock(previousLayer, currentLayer);
    diagnostics.push({
      code: "CONTEXT_PIPELINE_PREFIX_CHANGED",
      message: "Context pipeline prefix hash changed for this layer.",
      layer: layerId,
      ...(changedBlockId ? { blockId: changedBlockId } : {}),
      affectedTokens: currentLayer?.estimatedTokens ?? 0,
      redaction: { class: "internal", fields: ["message", "blockId"] }
    });
  }
  return {
    schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION,
    status: changedLayerCount > 0 ? "changed" : "stable",
    previousFingerprint: previous.pipelineFingerprint,
    currentFingerprint: current.pipelineFingerprint,
    ...(firstChangedLayer ? { firstChangedLayer } : {}),
    ...(firstChangedBlockId ? { firstChangedBlockId } : {}),
    affectedTokens,
    stableLayerCount,
    changedLayerCount,
    rawContentInspected: false,
    diagnostics,
    redaction: { class: "internal", fields: ["previousFingerprint", "currentFingerprint"] },
    compatibility: CONTEXT_PIPELINE_COMPATIBILITY
  };
}

export interface ProjectIndexRefreshRequest {
  readonly sessionId: SessionId;
  readonly workspaceRoot: string;
  readonly documents: readonly ProjectIndexDocumentInput[];
  readonly indexId?: string;
}

export interface ProjectIndexQueryRequest {
  readonly sessionId: SessionId;
  readonly workspaceRoot: string;
  readonly query: string;
  readonly limit?: number;
  readonly indexId?: string;
  readonly documentsFingerprint?: string;
}

export interface ProjectIndexEntry extends JsonObject {
  readonly path: string;
  readonly language: string;
  readonly contentHash: string;
  readonly excerpt: string;
  readonly estimatedTokens: number;
  readonly redaction: RedactionMetadata;
}

export interface ProjectIndexRefreshResult extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly familyId: "context.project-index";
  readonly status: "completed";
  readonly indexId: string;
  readonly sessionId: SessionId;
  readonly workspaceRoot: string;
  readonly documentCount: number;
  readonly documentsFingerprint: string;
  readonly replayFingerprint: string;
  readonly diagnostics: readonly string[];
  readonly redaction: { readonly class: "internal"; readonly fields: readonly string[] };
}

export interface ProjectIndexQueryResult extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly familyId: "context.project-index";
  readonly status: "completed" | "degraded";
  readonly indexId: string;
  readonly sessionId: SessionId;
  readonly workspaceRoot: string;
  readonly query: string;
  readonly resultCount: number;
  readonly entries: readonly ProjectIndexEntry[];
  readonly contextNodes: readonly ContextGraphNode[];
  readonly stale: boolean;
  readonly diagnostics: readonly string[];
  readonly replayFingerprint: string;
  readonly redaction: { readonly class: "internal"; readonly fields: readonly string[] };
}

export class DeterministicProjectIndex {
  private readonly indexes = new Map<string, { readonly refresh: ProjectIndexRefreshResult; readonly documents: readonly ProjectIndexEntry[] }>();

  refresh(request: ProjectIndexRefreshRequest): ProjectIndexRefreshResult {
    const documents = request.documents
      .map((document) => indexEntry(document))
      .sort((left, right) => left.path.localeCompare(right.path));
    const documentsFingerprint = stableHash(JSON.stringify(documents.map((document) => [document.path, document.contentHash])));
    const indexId = request.indexId ?? `project-index-${stableHash(`${request.sessionId}:${request.workspaceRoot}`)}`;
    const refresh: ProjectIndexRefreshResult = {
      schemaVersion: "1.0.0",
      familyId: "context.project-index",
      status: "completed",
      indexId,
      sessionId: request.sessionId,
      workspaceRoot: request.workspaceRoot,
      documentCount: documents.length,
      documentsFingerprint,
      replayFingerprint: `context.project-index.refresh:${stableHash(JSON.stringify({
        indexId,
        sessionId: request.sessionId,
        workspaceRoot: request.workspaceRoot,
        documentsFingerprint
      }))}`,
      diagnostics: [],
      redaction: { class: "internal", fields: ["workspaceRoot", "documents.path", "documents.excerpt"] }
    };
    this.indexes.set(indexKey(request.sessionId, request.workspaceRoot, indexId), { refresh, documents });
    return refresh;
  }

  query(request: ProjectIndexQueryRequest): ProjectIndexQueryResult {
    const indexId = request.indexId ?? `project-index-${stableHash(`${request.sessionId}:${request.workspaceRoot}`)}`;
    const index = this.indexes.get(indexKey(request.sessionId, request.workspaceRoot, indexId));
    const stale = Boolean(index && request.documentsFingerprint && request.documentsFingerprint !== index.refresh.documentsFingerprint);
    const diagnostics: string[] = [];
    if (!index) diagnostics.push("context.project-index.missing-index");
    if (stale) diagnostics.push("context.project-index.stale-index");
    const limit = Math.max(0, request.limit ?? 20);
    const query = request.query.trim().toLowerCase();
    const entries = (index?.documents ?? [])
      .filter((entry) => query.length === 0 || entry.path.toLowerCase().includes(query) || entry.excerpt.toLowerCase().includes(query))
      .slice(0, limit);
    if (index && entries.length === limit && limit > 0) diagnostics.push("context.project-index.output-bounded");
    const contextNodes = entries.map((entry, position) => projectIndexNode(request.sessionId, request.workspaceRoot, entry, position, index?.refresh.documentsFingerprint ?? "missing"));
    return {
      schemaVersion: "1.0.0",
      familyId: "context.project-index",
      status: diagnostics.length > 0 ? "degraded" : "completed",
      indexId,
      sessionId: request.sessionId,
      workspaceRoot: request.workspaceRoot,
      query: request.query,
      resultCount: entries.length,
      entries,
      contextNodes,
      stale,
      diagnostics,
      replayFingerprint: `context.project-index.query:${stableHash(JSON.stringify({
        indexId,
        sessionId: request.sessionId,
        workspaceRoot: request.workspaceRoot,
        query: request.query,
        entries: entries.map((entry) => [entry.path, entry.contentHash]),
        stale,
        diagnostics
      }))}`,
      redaction: { class: "internal", fields: ["workspaceRoot", "entries.path", "entries.excerpt", "contextNodes.content"] }
    };
  }
}

function layerForProjectedNode(node: ProjectedContextNode): ContextPipelineLayerId {
  return layerForProjectedLike(node);
}

function layerForProjectedLike(node: Pick<ProjectedContextNode, "id" | "kind" | "source"> & { readonly provenance?: JsonObject }): ContextPipelineLayerId {
  const provenance = node.provenance ?? {};
  const hinted = stringValue(provenance.pipelineLayer);
  if (isPipelineLayer(hinted)) return hinted;
  const lifecycle = stringValue(provenance.lifecycle);
  if (lifecycle === "global") return "kernel";
  if (lifecycle === "project") return "project";
  if (lifecycle === "turn") return "current-turn";
  if (String(node.id).startsWith("context-current-") || node.source === "user") return "current-turn";
  if (node.source === "system" && (node.kind === "rule" || node.kind === "summary")) return "kernel";
  if (node.source === "workspace" || node.kind === "file" || node.kind === "rule") return "project";
  if (node.source === "memory" && (provenance.scope === "project" || provenance.memoryScope === "project")) return "project";
  if (node.source === "tool" || node.kind === "tool-result") return "current-turn";
  return "session";
}

function blockForProjectedNode(
  node: ProjectedContextNode,
  layer: ContextPipelineLayerId,
  order: number,
  projectionFingerprint: string,
  overrides: {
    readonly cachePolicy?: ContextBlock["cacheHint"]["policy"];
    readonly provenance?: JsonObject;
    readonly content?: string;
    readonly estimatedTokens?: number;
  } = {}
): ContextBlock {
  const cacheHint = {
    policy: overrides.cachePolicy ?? cachePolicyForLayer(layer),
    freshness: freshnessForLayer(layer)
  } satisfies ContextBlock["cacheHint"];
  const content = overrides.content ?? node.content;
  const estimatedTokens = overrides.estimatedTokens ?? node.estimatedTokens;
  const provenance = overrides.provenance ?? node.provenance;
  const hash = `block:${stableHash(JSON.stringify({
    layer,
    kind: node.kind,
    source: node.source,
    content,
    dependencyFingerprints: [...node.dependencyFingerprints].sort(),
    redaction: node.redaction,
    cacheHint,
    provenance
  }))}`;
  return Object.freeze({
    schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION,
    id: contextPipelineBlockStableId(layer, String(node.id), hash),
    layer,
    order,
    sourceNodeId: node.id,
    kind: node.kind,
    source: node.source,
    hash,
    content,
    contentPreview: firstWords(content, 24),
    estimatedTokens,
    dependencyFingerprints: [...node.dependencyFingerprints].sort(),
    provenance,
    cacheHint,
    replay: {
      fingerprint: `context-block-replay:${stableHash(`${projectionFingerprint}:${hash}`)}`,
      sourceProjectionFingerprint: projectionFingerprint
    },
    redaction: { class: node.redaction.class, fields: ["content", "contentPreview"] },
    compatibility: CONTEXT_PIPELINE_COMPATIBILITY
  });
}

function summaryBlockFor(
  node: ProjectedContextNode,
  order: number,
  maxTokens: number,
  projectionFingerprint: string
): ContextBlock {
  const summaryContent = [
    "Tool result summary:",
    firstWords(node.content, maxTokens),
    `[raw output kept in current-turn tail; source=${String(node.id)}]`
  ].join(" ");
  return blockForProjectedNode(node, "session", order, projectionFingerprint, {
    cachePolicy: "stable",
    content: summaryContent,
    estimatedTokens: countTokens(summaryContent),
    provenance: {
      ...node.provenance,
      summaryOf: String(node.id),
      boundedSummary: true
    }
  });
}

function compactSessionBlocks(
  blocks: readonly ContextBlock[],
  projectionFingerprint: string,
  maxSessionBlocksBeforeCompaction: number | undefined
): readonly ContextBlock[] {
  if (maxSessionBlocksBeforeCompaction === undefined || maxSessionBlocksBeforeCompaction <= 0) return blocks;
  const sessionBlocks = blocks.filter((block) => block.layer === "session");
  if (sessionBlocks.length <= maxSessionBlocksBeforeCompaction) return blocks;
  const sourceBlockHashes = sessionBlocks.map((block) => block.hash);
  const order = sessionBlocks[0]?.order ?? 0;
  const content = `Session compaction summary: ${sessionBlocks.length} contiguous session blocks compacted. Source block hashes are recorded in replay metadata.`;
  const hash = `block:${stableHash(JSON.stringify({
    layer: "session",
    kind: "summary",
    source: "system",
    content,
    sourceBlockHashes
  }))}`;
  const compacted: ContextBlock = Object.freeze({
    schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION,
    id: contextPipelineBlockStableId("session", `session-compaction-${stableHash(sourceBlockHashes.join("|"))}`, hash),
    layer: "session",
    order,
    kind: "summary",
    source: "system",
    hash,
    content,
    contentPreview: firstWords(content, 24),
    estimatedTokens: countTokens(content),
    dependencyFingerprints: sourceBlockHashes,
    provenance: {
      compactedRange: `session:0-${sessionBlocks.length - 1}`,
      sourceBlockCount: sessionBlocks.length
    },
    cacheHint: {
      policy: "stable" as const,
      freshness: "session" as const
    },
    replay: {
      fingerprint: `context-block-replay:${stableHash(`${projectionFingerprint}:${hash}`)}`,
      sourceProjectionFingerprint: projectionFingerprint,
      sourceBlockHashes
    },
    redaction: { class: "internal" as const, fields: ["content", "contentPreview", "replay.sourceBlockHashes"] },
    compatibility: CONTEXT_PIPELINE_COMPATIBILITY
  });
  const firstSessionIndex = blocks.findIndex((block) => block.layer === "session");
  const withoutSession = blocks.filter((block) => block.layer !== "session");
  return [
    ...withoutSession.slice(0, firstSessionIndex),
    compacted,
    ...withoutSession.slice(firstSessionIndex)
  ];
}

function buildPipelineLayers(blocks: readonly ContextBlock[]): readonly ContextPipelineLayer[] {
  let cumulative = "";
  return CONTEXT_PIPELINE_LAYER_ORDER.map((layerId, order) => {
    const layerBlocks = blocks.filter((block) => block.layer === layerId);
    const blockHashes = layerBlocks.map((block) => block.hash);
    const layerHash = `layer:${stableHash(blockHashes.join("|"))}`;
    cumulative = `prefix:${stableHash(`${cumulative}|${layerId}|${layerHash}`)}`;
    return Object.freeze({
      id: layerId,
      order,
      blockIds: layerBlocks.map((block) => block.id),
      blockHashes,
      layerHash,
      prefixHash: cumulative,
      estimatedTokens: layerBlocks.reduce((total, block) => total + block.estimatedTokens, 0)
    });
  });
}

function prefixHashForLayer(layer: ContextPipelineLayer): ContextPrefixHash {
  return Object.freeze({
    schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION,
    id: contextPipelinePrefixStableId(layer.id, layer.prefixHash),
    layer: layer.id,
    order: layer.order,
    blockIds: layer.blockIds,
    blockHashes: layer.blockHashes,
    layerHash: layer.layerHash,
    prefixHash: layer.prefixHash,
    estimatedTokens: layer.estimatedTokens,
    redaction: { class: "internal" as const, fields: ["blockIds", "blockHashes"] },
    compatibility: CONTEXT_PIPELINE_COMPATIBILITY
  });
}

function summarizeCacheHints(blocks: readonly ContextBlock[]): ContextPipelineManifest["cacheHintSummary"] {
  return {
    stable: blocks.filter((block) => block.cacheHint.policy === "stable").length,
    ephemeral: blocks.filter((block) => block.cacheHint.policy === "ephemeral").length,
    noStore: blocks.filter((block) => block.cacheHint.policy === "no-store").length,
    ttlBound: blocks.filter((block) => block.cacheHint.policy === "ttl").length
  };
}

function diagnosticsForExcludedNodes(
  excludedNodes: readonly ExcludedContextNode[],
  excludedBlocks: readonly { readonly id: string; readonly layer?: ContextPipelineLayerId; readonly estimatedTokens: number }[]
): readonly ContextPipelineDiagnostic[] {
  return excludedNodes.flatMap((node, index) => {
    if (node.priority < 900) return [];
    const block = excludedBlocks[index];
    return [{
      code: "CONTEXT_PIPELINE_HIGH_PRIORITY_BLOCK_EXCLUDED",
      message: "High-priority context evidence was excluded from the pipeline manifest.",
      ...(block?.layer ? { layer: block.layer } : {}),
      ...(block?.id ? { blockId: block.id } : {}),
      affectedTokens: block?.estimatedTokens ?? node.estimatedTokens,
      redaction: { class: "internal", fields: ["message", "blockId"] }
    }];
  });
}

function firstChangedBlock(previous: ContextPipelineLayer | undefined, current: ContextPipelineLayer | undefined): string | undefined {
  const max = Math.max(previous?.blockHashes.length ?? 0, current?.blockHashes.length ?? 0);
  for (let index = 0; index < max; index += 1) {
    if (previous?.blockHashes[index] !== current?.blockHashes[index]) return current?.blockIds[index] ?? previous?.blockIds[index];
  }
  return current?.blockIds[0] ?? previous?.blockIds[0];
}

function cachePolicyForLayer(layer: ContextPipelineLayerId): ContextBlock["cacheHint"]["policy"] {
  return layer === "current-turn" ? "ephemeral" : "stable";
}

function freshnessForLayer(layer: ContextPipelineLayerId): NonNullable<ContextBlock["cacheHint"]["freshness"]> {
  if (layer === "kernel") return "static";
  if (layer === "project") return "session";
  if (layer === "session") return "session";
  return "volatile";
}

function isOversizedToolResult(node: ProjectedContextNode, maxStableToolResultTokens: number): boolean {
  return (node.kind === "tool-result" || node.source === "tool") && node.estimatedTokens > maxStableToolResultTokens;
}

function isPipelineLayer(value: string | undefined): value is ContextPipelineLayerId {
  return value === "kernel" || value === "project" || value === "session" || value === "current-turn";
}

function normalizeStoredNode(sessionId: SessionId, node: ContextNode): ContextGraphNode {
  return normalizeGraphNode(sessionId, {
    schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION,
    id: node.id,
    kind: node.kind,
    source: stringField(node.metadata, "source", "host") as ContextGraphNode["source"],
    lifecycle: stringField(node.metadata, "lifecycle", "session") as ContextGraphNode["lifecycle"],
    scope: {
      sessionId,
      ...(typeof node.metadata.workspaceRoot === "string" ? { workspaceRoot: node.metadata.workspaceRoot } : {})
    },
    priority: numberField(node.metadata, "priority", 100),
    content: node.content,
    ...(typeof node.metadata.contentRef === "string" ? { contentRef: node.metadata.contentRef } : {}),
    ...(typeof node.metadata.estimatedTokens === "number" ? { estimatedTokens: node.metadata.estimatedTokens } : {}),
    redaction: { class: stringField(node.metadata, "redactionClass", "internal") as RedactionClass },
    provenance: isJsonObject(node.metadata.provenance) ? node.metadata.provenance : { source: "context.addNode" },
    dependencyFingerprints: stringArrayField(node.metadata, "dependencyFingerprints", [`node:${node.id}`]),
    compatibility: { schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION },
    createdAt: stringField(node.metadata, "createdAt", "1970-01-01T00:00:00.000Z"),
    secretDecision: createSecretRedactionDecision(node.content, { class: stringField(node.metadata, "redactionClass", "internal") as RedactionClass }),
    ...(node.metadata.stale === true ? { stale: true } : {}),
    ...(node.metadata.invalidated === true ? { invalidated: true } : {})
  });
}

function normalizeGraphNode(sessionId: SessionId, node: ContextGraphNode): ContextGraphNode {
  const content = String(node.content ?? "");
  const redaction = classifyRedaction(content, node.redaction);
  const secretDecision = node.secretDecision ?? createSecretRedactionDecision(content, redaction);
  return {
    ...node,
    schemaVersion: node.schemaVersion || CONTEXT_PROJECTION_SCHEMA_VERSION,
    scope: {
      ...node.scope,
      sessionId: node.scope.sessionId ?? sessionId
    },
    priority: Number.isFinite(node.priority) ? node.priority : 0,
    content,
    estimatedTokens: node.estimatedTokens ?? countTokens(content),
    redaction,
    secretDecision,
    dependencyFingerprints: node.dependencyFingerprints.length > 0 ? node.dependencyFingerprints : [`node:${node.id}`],
    compatibility: node.compatibility ?? { schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION },
    createdAt: node.createdAt || "1970-01-01T00:00:00.000Z"
  };
}

function filterCandidates(request: ContextProjectionRequest, candidates: readonly ContextGraphNode[]): {
  readonly eligible: ContextGraphNode[];
  readonly excluded: ExcludedContextNode[];
  readonly secretLikeBlocked: number;
} {
  const eligible: ContextGraphNode[] = [];
  const excluded: ExcludedContextNode[] = [];
  const seen = new Set<string>();
  let secretLikeBlocked = 0;
  for (const node of candidates) {
    const reason = exclusionReason(request, node, seen);
    if (reason) {
      if (reason === "unsafe-secret" || reason === "policy-denied") secretLikeBlocked++;
      excluded.push(excludedNode(node, reason));
      continue;
    }
    seen.add(String(node.id));
    eligible.push(node);
  }
  return { eligible, excluded, secretLikeBlocked };
}

function exclusionReason(request: ContextProjectionRequest, node: ContextGraphNode, seen: Set<string>): ContextNodeExclusionReason | undefined {
  if (seen.has(String(node.id))) return "duplicate";
  if (node.schemaVersion !== CONTEXT_PROJECTION_SCHEMA_VERSION) return "unsupported-schema";
  if (node.content.trim().length === 0) return "empty-content";
  if (node.stale) return "stale";
  if (node.invalidated) return "invalidated";
  if (node.scope.sessionId && node.scope.sessionId !== request.sessionId) return "outside-scope";
  if (node.scope.agentId && request.scope.agentId && node.scope.agentId !== request.scope.agentId) return "outside-scope";
  if (node.secretDecision && ["deny", "exclude", "rewrite"].includes(node.secretDecision.action)) return "policy-denied";
  if (isSecretLike(node.content) || node.redaction.class === "secret") return "unsafe-secret";
  if (!request.scope.availableRedactionClasses.includes(node.redaction.class)) return "redaction-unavailable";
  return undefined;
}

function compareNodes(left: ContextGraphNode, right: ContextGraphNode): number {
  if (right.priority !== left.priority) return right.priority - left.priority;
  const rightTime = Date.parse(right.createdAt);
  const leftTime = Date.parse(left.createdAt);
  if (rightTime !== leftTime) return rightTime - leftTime;
  return String(left.id).localeCompare(String(right.id));
}

function projectedNode(node: ContextGraphNode, estimatedTokens = estimateNodeTokens(node)): ProjectedContextNode {
  return {
    id: node.id,
    kind: node.kind,
    source: node.source,
    content: redactContent(node.content, node.redaction),
    estimatedTokens,
    priority: node.priority,
    redaction: node.redaction,
    provenance: node.provenance,
    dependencyFingerprints: node.dependencyFingerprints,
    ...(node.secretDecision ? { secretDecision: node.secretDecision } : {}),
    ...(node.auditEvidence ? { auditEvidence: node.auditEvidence } : {})
  };
}

function excludedNode(node: ContextGraphNode, reason: ContextNodeExclusionReason, estimatedTokens = estimateNodeTokens(node)): ExcludedContextNode {
  return {
    id: node.id,
    kind: node.kind,
    source: node.source,
    estimatedTokens,
    priority: node.priority,
    reason,
    redaction: { class: node.redaction.class },
    ...(node.secretDecision ? { secretDecision: node.secretDecision } : {}),
    ...(node.auditEvidence ? { auditEvidence: node.auditEvidence } : {})
  };
}

function budgetDecision(request: ContextProjectionRequest, selectedTokens: number, excludedTokens: number): ContextProjectionBudgetDecision {
  const softLimit = request.budget.softLimitTokens;
  const reservedOutputTokens = request.budget.reservedOutputTokens ?? 0;
  const status = selectedTokens > request.budget.hardLimitTokens ? "rejected" : softLimit !== undefined && selectedTokens > softLimit ? "degraded" : "allowed";
  return {
    status,
    hardLimitTokens: request.budget.hardLimitTokens,
    ...(softLimit !== undefined ? { softLimitTokens: softLimit } : {}),
    reservedOutputTokens,
    selectedTokens,
    excludedTokens,
    reason: status === "allowed" ? "within-budget" : status === "degraded" ? "soft-budget-exceeded" : "hard-budget-exceeded"
  };
}

function redactionSummary(selected: readonly ProjectedContextNode[], excluded: readonly ExcludedContextNode[], secretLikeBlocked: number): ContextProjectionRedactionSummary {
  const classes = [...new Set([...selected.map((node) => node.redaction.class), ...excluded.map((node) => node.redaction.class)])].sort() as RedactionClass[];
  return {
    selected: selected.length,
    redacted: selected.filter((node) => node.content.includes("[REDACTED]")).length,
    excluded: excluded.length,
    classes,
    secretLikeBlocked
  };
}

function buildProjectionResult(
  request: ContextProjectionRequest,
  candidates: readonly ContextGraphNode[],
  cacheCandidates: readonly ContextGraphNode[],
  cacheKey: string,
  cacheHit: boolean
): ContextProjectionResult {
  const filtered = filterCandidates(request, candidates);
  const ordered = filtered.eligible.sort(compareNodes);
  const selected: ProjectedContextNode[] = [];
  const excluded: ExcludedContextNode[] = [...filtered.excluded];
  let selectedTokens = 0;
  let excludedTokens = excluded.reduce((total, node) => total + node.estimatedTokens, 0);
  const hardLimit = Math.max(0, request.budget.hardLimitTokens);

  for (const node of ordered) {
    const estimatedTokens = estimateNodeTokens(node);
    if (selectedTokens + estimatedTokens > hardLimit) {
      excluded.push(excludedNode(node, "budget-exceeded", estimatedTokens));
      excludedTokens += estimatedTokens;
      continue;
    }
    selected.push(projectedNode(node, estimatedTokens));
    selectedTokens += estimatedTokens;
  }

  const budget = budgetDecision(request, selectedTokens, excludedTokens);
  const rejectedByBudget = selected.length === 0 && candidates.length > 0 && excluded.some((node) => node.reason === "budget-exceeded");
  const status = rejectedByBudget ? "rejected" : budget.status === "degraded" || excluded.length > 0 ? "degraded" : "completed";
  const redaction = redactionSummary(selected, excluded, filtered.secretLikeBlocked);
  const cache: ContextProjectionCacheMetadata = {
    namespace: CONTEXT_PROJECTION_CACHE_NAMESPACE,
    key: cacheKey,
    hit: cacheHit,
    dependencyFingerprints: dependencyFingerprints(cacheCandidates)
  };
  const prompt = selected.map((node) => node.content).join("\n");
  const resultBase: ContextProjectionResult = {
    schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION,
    status,
    sessionId: request.sessionId,
    ...(request.turnId ? { turnId: request.turnId } : {}),
    prompt,
    selectedNodes: selected,
    excludedNodes: excluded,
    estimatedTokens: selectedTokens,
    budget: rejectedByBudget ? { ...budget, status: "rejected", reason: "hard-budget-exceeded" } : budget,
    redaction,
    cache,
    ordering: {
      strategy: "priority-recency-stable",
      tieBreak: ["priority", "createdAt", "id"]
    },
    replayFingerprint: replayFingerprint(request, selected, excluded) + (cacheHit ? ":cache-hit" : ""),
    ...(rejectedByBudget ? { error: projectionError("CONTEXT_PROJECTION_BUDGET_EXCEEDED", "Context projection exceeded hard budget") } : {})
  };
  return freezeProjection({
    ...resultBase,
    ...(request.pipeline?.enabled ? { pipeline: deriveContextPipelineManifest(resultBase) } : {})
  });
}

function rejectedProjection(request: ContextProjectionRequest, reason: ContextNodeExclusionReason, message: string): ContextProjectionResult {
  return freezeProjection({
    schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION,
    status: "rejected",
    sessionId: request.sessionId,
    ...(request.turnId ? { turnId: request.turnId } : {}),
    prompt: "",
    selectedNodes: [],
    excludedNodes: [],
    estimatedTokens: 0,
    budget: {
      status: "rejected",
      hardLimitTokens: request.budget.hardLimitTokens,
      ...(request.budget.softLimitTokens !== undefined ? { softLimitTokens: request.budget.softLimitTokens } : {}),
      reservedOutputTokens: request.budget.reservedOutputTokens ?? 0,
      selectedTokens: 0,
      excludedTokens: 0,
      reason
    },
    redaction: { selected: 0, redacted: 0, excluded: 0, classes: [], secretLikeBlocked: 0 },
    cache: {
      namespace: CONTEXT_PROJECTION_CACHE_NAMESPACE,
      key: "projection-rejected",
      hit: false,
      dependencyFingerprints: [],
      invalidationReason: reason
    },
    ordering: {
      strategy: "priority-recency-stable",
      tieBreak: ["priority", "createdAt", "id"]
    },
    replayFingerprint: `rejected:${reason}:${request.sessionId}`,
    error: projectionError("CONTEXT_PROJECTION_REJECTED", message, { reason })
  });
}

function projectionError(code: string, message: string, details: JsonObject = {}): import("@deepseek/platform-contracts").RedactedError {
  return {
    code,
    message,
    retryable: false,
    redaction: { class: "public" },
    details
  };
}

function freezeProjection(result: ContextProjectionResult): ContextProjectionResult {
  for (const node of result.selectedNodes) Object.freeze(node);
  for (const node of result.excludedNodes) Object.freeze(node);
  Object.freeze(result.selectedNodes);
  Object.freeze(result.excludedNodes);
  Object.freeze(result.budget);
  Object.freeze(result.redaction);
  Object.freeze(result.cache);
  Object.freeze(result.ordering);
  return Object.freeze(result);
}

function estimateNodeTokens(node: ContextGraphNode): number {
  return node.estimatedTokens ?? countTokens(node.content);
}

function countTokens(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
}

function dependencyFingerprints(nodes: readonly ContextGraphNode[]): readonly string[] {
  return [...new Set(nodes.flatMap((node) => node.dependencyFingerprints))].sort();
}

function projectionCacheCandidates(candidates: readonly ContextGraphNode[]): readonly ContextGraphNode[] {
  return candidates.filter((node) => !isCurrentPromptNode(node));
}

function isCurrentPromptNode(node: ContextGraphNode): boolean {
  return node.kind === "user"
    && node.source === "user"
    && String(node.id).startsWith("context-current-")
    && node.dependencyFingerprints.some((fingerprint) => fingerprint.startsWith("prompt:"));
}

function buildProjectionCacheInput(request: ContextProjectionRequest, candidates: readonly ContextGraphNode[]): ProjectionCacheInput {
  const requestFingerprint = stableHash(JSON.stringify({
    schemaVersion: request.schemaVersion,
    sessionId: request.sessionId,
    purpose: request.purpose,
    budget: request.budget,
    scope: request.scope,
    candidates: candidates.map((node) => ({
      id: node.id,
      priority: node.priority,
      createdAt: node.createdAt,
      stale: node.stale === true,
      invalidated: node.invalidated === true,
      content: stableHash(node.content)
    }))
  }));
  return {
    requestFingerprint,
    dependencyFingerprints: dependencyFingerprints(candidates)
  };
}

function replayFingerprint(request: ContextProjectionRequest, selected: readonly ProjectedContextNode[], excluded: readonly ExcludedContextNode[]): string {
  return stableHash(JSON.stringify({
    sessionId: request.sessionId,
    purpose: request.purpose,
    selected: selected.map((node) => [node.id, node.estimatedTokens]),
    excluded: excluded.map((node) => [node.id, node.reason])
  }));
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `h${(hash >>> 0).toString(16)}`;
}

function classifyRedaction(content: string, redaction: RedactionMetadata): RedactionMetadata {
  const decision = createSecretRedactionDecision(content, redaction);
  if (decision.classification.detected) return { class: "secret", fields: ["content"] };
  return redaction;
}

function isSecretLike(value: string): boolean {
  return createSecretRedactionDecision(value).classification.detected;
}

function redactContent(value: string, redaction: RedactionMetadata): string {
  if (redaction.class !== "secret") return value;
  return redactSecretText(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(metadata: JsonObject, key: string, fallback: string): string {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(metadata: JsonObject, key: string, fallback: number): number {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArrayField(metadata: JsonObject, key: string, fallback: readonly string[]): readonly string[] {
  const value = metadata[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : fallback;
}

function indexEntry(document: ProjectIndexDocumentInput): ProjectIndexEntry {
  const redaction = { class: document.redactionClass ?? "internal" } satisfies RedactionMetadata;
  const excerpt = redactContent(firstWords(document.content, 40), redaction);
  return {
    path: document.path,
    language: document.language ?? languageForPath(document.path),
    contentHash: stableHash(document.content),
    excerpt,
    estimatedTokens: countTokens(document.content),
    redaction
  };
}

function projectIndexNode(sessionId: SessionId, workspaceRoot: string, entry: ProjectIndexEntry, position: number, documentsFingerprint: string): ContextGraphNode {
  return normalizeGraphNode(sessionId, {
    schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION,
    id: asId<"contextNode">(`project-index-${stableHash(`${workspaceRoot}:${entry.path}`)}`),
    kind: "file",
    source: "workspace",
    lifecycle: "session",
    scope: { sessionId, workspaceRoot },
    priority: 900 - position,
    content: `${entry.path}\n${entry.excerpt}`,
    estimatedTokens: entry.estimatedTokens,
    redaction: entry.redaction,
    provenance: {
      source: "context.project-index",
      path: entry.path,
      language: entry.language,
      contentHash: entry.contentHash
    },
    dependencyFingerprints: [`project-index:${documentsFingerprint}`, `file:${entry.contentHash}`],
    compatibility: { schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION },
    createdAt: new Date(0).toISOString()
  });
}

function indexKey(sessionId: SessionId, workspaceRoot: string, indexId: string): string {
  return `${sessionId}:${workspaceRoot}:${indexId}`;
}

function firstWords(content: string, maxWords: number): string {
  const words = content.trim().split(/\s+/).filter((word) => word.length > 0);
  return words.slice(0, maxWords).join(" ");
}

function languageForPath(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension === "ts" || extension === "tsx") return "typescript";
  if (extension === "js" || extension === "jsx") return "javascript";
  if (extension === "json") return "json";
  if (extension === "md") return "markdown";
  return "text";
}
