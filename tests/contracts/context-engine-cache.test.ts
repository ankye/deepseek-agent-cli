import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryCacheManager } from "@deepseek/memory-cache-management";
import { InMemoryContextEngine, createProjectionRequest } from "@deepseek/context-engine";
import { asId } from "@deepseek/platform-contracts";
import type { ContextGraphNode, ContextProjectionRequest } from "@deepseek/platform-contracts";
import { CONTEXT_PROJECTION_SCHEMA_VERSION } from "@deepseek/platform-contracts";

function graphNode(id: string, fingerprint: string, content = "candidate body"): ContextGraphNode {
  return {
    schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION,
    id: asId<"contextNode">(id),
    kind: "rule",
    source: "host",
    lifecycle: "turn",
    scope: { sessionId: asId<"session">("session-ce-cache-contract") },
    priority: 500,
    content,
    estimatedTokens: 4,
    redaction: { class: "public" },
    provenance: { source: "test" },
    dependencyFingerprints: [fingerprint],
    compatibility: { schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION },
    createdAt: "1970-01-01T00:00:00.000Z"
  };
}

function buildRequest(overrides: { candidateNodes?: readonly ContextGraphNode[]; turnId?: string } = {}): ContextProjectionRequest {
  const base = createProjectionRequest({
    sessionId: asId<"session">("session-ce-cache-contract"),
    prompt: "stable cache prompt",
    hardLimitTokens: 128,
    availableRedactionClasses: ["public", "internal"]
  });
  return {
    ...base,
    ...(overrides.turnId ? { turnId: asId<"turn">(overrides.turnId) } : {}),
    ...(overrides.candidateNodes ? { candidateNodes: overrides.candidateNodes } : {})
  };
}

describe("context-engine projection cache", () => {
  it("returns cache.hit=true on the second projectGraph when a CacheManager is injected", async () => {
    const cache = new InMemoryCacheManager();
    const engine = new InMemoryContextEngine({ cache });
    const request = buildRequest({ candidateNodes: [graphNode("node-A", "fp-A")] });
    const first = await engine.projectGraph(request);
    assert.equal(first.cache.hit, false);
    const second = await engine.projectGraph(request);
    assert.equal(second.cache.hit, true);
    assert.deepEqual(
      second.selectedNodes.map((node) => node.id),
      first.selectedNodes.map((node) => node.id)
    );
    assert.ok(second.replayFingerprint.endsWith(":cache-hit"));
  });

  it("falls back to in-memory cache and still reports cache.hit=true on repeat when no CacheManager is injected", async () => {
    const engine = new InMemoryContextEngine();
    const request = buildRequest({ candidateNodes: [graphNode("node-fallback", "fp-fallback")] });
    const first = await engine.projectGraph(request);
    const second = await engine.projectGraph(request);
    assert.equal(first.cache.hit, false);
    assert.equal(second.cache.hit, true);
    assert.ok(second.replayFingerprint.endsWith(":cache-hit"));
  });

  it("changing a candidate dependency fingerprint invalidates the cached projection key", async () => {
    const cache = new InMemoryCacheManager();
    const engine = new InMemoryContextEngine({ cache });
    const first = await engine.projectGraph(buildRequest({ candidateNodes: [graphNode("node-dep", "fp-original")] }));
    const second = await engine.projectGraph(buildRequest({ candidateNodes: [graphNode("node-dep", "fp-rotated")] }));
    assert.notEqual(first.cache.key, second.cache.key);
    assert.equal(second.cache.hit, false);
  });

  it("keeps stable context cacheable across volatile current-turn prompts", async () => {
    const cache = new InMemoryCacheManager();
    const engine = new InMemoryContextEngine({ cache });
    const stableCandidate = graphNode("node-stable", "fp-stable", "stable project context");
    const first = await engine.projectGraph({
      ...buildRequest({ candidateNodes: [stableCandidate] }),
      prompt: "first volatile user prompt"
    });
    const second = await engine.projectGraph({
      ...buildRequest({ candidateNodes: [stableCandidate] }),
      prompt: "second volatile user prompt"
    });

    assert.equal(first.cache.hit, false);
    assert.equal(second.cache.hit, true);
    assert.equal(second.cache.key, first.cache.key);
    assert.deepEqual(second.cache.dependencyFingerprints, ["fp-stable"]);
    assert.equal(second.selectedNodes.some((node) => node.content === "second volatile user prompt"), true);
    assert.equal(second.selectedNodes.some((node) => node.content === "first volatile user prompt"), false);
  });

  it("marks prompt-only projections as no-store instead of cacheable context misses", async () => {
    const cache = new InMemoryCacheManager();
    const engine = new InMemoryContextEngine({ cache });
    const first = await engine.projectGraph({
      ...buildRequest(),
      prompt: "first volatile only prompt"
    });
    const second = await engine.projectGraph({
      ...buildRequest(),
      prompt: "second volatile only prompt"
    });

    assert.equal(first.cache.key, "context.projection:no-store");
    assert.equal(second.cache.key, "context.projection:no-store");
    assert.equal(first.cache.hit, false);
    assert.equal(second.cache.hit, false);
    assert.deepEqual(first.cache.dependencyFingerprints, []);
    assert.deepEqual(second.cache.dependencyFingerprints, []);
    assert.equal(second.selectedNodes.some((node) => node.content === "second volatile only prompt"), true);
    assert.equal(second.selectedNodes.some((node) => node.content === "first volatile only prompt"), false);
  });
});
