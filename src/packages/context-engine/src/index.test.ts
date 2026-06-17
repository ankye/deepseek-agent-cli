import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asId, CONTEXT_PROJECTION_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import type { ContextGraphNode, ContextProjectionRequest, SessionId } from "@deepseek/platform-contracts";
import { compareContextPipelineManifests, createProjectionRequest, deriveContextPipelineManifest, DeterministicProjectIndex, InMemoryContextEngine } from "./index.js";

describe("InMemoryContextEngine", () => {
  it("filters, orders, budgets, redacts, and freezes projection results", async () => {
    const engine = new InMemoryContextEngine();
    const sessionId = asId<"session">("session-context-unit");
    await engine.addNode(sessionId, {
      id: asId<"contextNode">("ctx-low"),
      kind: "file",
      content: "low priority file",
      metadata: {
        priority: 10,
        source: "workspace",
        redactionClass: "internal",
        dependencyFingerprints: ["file:a"]
      }
    });
    await engine.addNode(sessionId, {
      id: asId<"contextNode">("ctx-secret"),
      kind: "file",
      content: "sk-live-secret-value",
      metadata: {
        priority: 100,
        source: "workspace",
        redactionClass: "secret",
        dependencyFingerprints: ["file:secret"]
      }
    });
    await engine.addNode(sessionId, {
      id: asId<"contextNode">("ctx-stale"),
      kind: "summary",
      content: "stale summary",
      metadata: {
        stale: true,
        priority: 200,
        source: "system",
        dependencyFingerprints: ["summary:old"]
      }
    });

    const result = await engine.projectGraph(createProjectionRequest({
      sessionId,
      prompt: "current prompt",
      hardLimitTokens: 5,
      softLimitTokens: 2,
      availableRedactionClasses: ["public", "internal"]
    }));

    assert.equal(result.schemaVersion, CONTEXT_PROJECTION_SCHEMA_VERSION);
    assert.equal(result.status, "degraded");
    assert.deepEqual(result.selectedNodes.map((node) => String(node.id)), ["context-current-session-context-unit-turn", "ctx-low"]);
    assert.equal(result.excludedNodes.some((node) => node.reason === "policy-denied"), true);
    assert.equal(result.excludedNodes.some((node) => node.reason === "stale"), true);
    assert.equal(result.redaction.secretLikeBlocked, 1);
    assert.equal(result.prompt.includes("sk-live-secret-value"), false);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.selectedNodes), true);
  });

  it("returns deterministic cache-hit metadata for unchanged projection dependencies", async () => {
    const engine = new InMemoryContextEngine();
    const sessionId = asId<"session">("session-cache-unit");
    const request = createProjectionRequest({
      sessionId,
      prompt: "cache prompt",
      hardLimitTokens: 10
    });

    const first = await engine.projectGraph({
      ...request,
      candidateNodes: [graphNode(sessionId, "ctx-cache-stable", "stable context", 100)]
    });
    const second = await engine.projectGraph({
      ...request,
      candidateNodes: [graphNode(sessionId, "ctx-cache-stable", "stable context", 100)]
    });

    assert.equal(first.cache.hit, false);
    assert.equal(second.cache.hit, true);
    assert.equal(second.cache.key, first.cache.key);
  });

  it("rejects unsupported projection schema versions", async () => {
    const engine = new InMemoryContextEngine();
    const sessionId = asId<"session">("session-schema-unit");
    const request = {
      ...createProjectionRequest({ sessionId, prompt: "schema", hardLimitTokens: 10 }),
      schemaVersion: "999.0.0"
    } satisfies ContextProjectionRequest;

    const result = await engine.projectGraph(request);
    assert.equal(result.status, "rejected");
    assert.equal(result.error?.code, "CONTEXT_PROJECTION_REJECTED");
    assert.equal(result.budget.reason, "unsupported-schema");
  });

  it("keeps context nodes scoped to the requested session", async () => {
    const engine = new InMemoryContextEngine();
    const sessionId = asId<"session">("session-scope-unit");
    const otherSessionId = asId<"session">("session-other-unit");
    const outside = graphNode(otherSessionId, "outside", "outside scope", 500);
    const request: ContextProjectionRequest = {
      ...createProjectionRequest({ sessionId, prompt: "inside scope", hardLimitTokens: 10 }),
      candidateNodes: [outside]
    };

    const result = await engine.projectGraph(request);
    assert.equal(result.excludedNodes.some((node) => node.id === outside.id && node.reason === "outside-scope"), true);
  });

  it("refreshes and queries deterministic context.project-index evidence with stale diagnostics", () => {
    const sessionId = asId<"session">("session-project-index-unit");
    const index = new DeterministicProjectIndex();
    const refresh = index.refresh({
      sessionId,
      workspaceRoot: "/workspace",
      documents: [
        { path: "/workspace/src/app.ts", content: "export const answer = 42", language: "typescript" },
        { path: "/workspace/README.md", content: "Project index readme" }
      ]
    });

    const query = index.query({
      sessionId,
      workspaceRoot: "/workspace",
      query: "answer",
      documentsFingerprint: refresh.documentsFingerprint
    });
    const stale = index.query({
      sessionId,
      workspaceRoot: "/workspace",
      query: "answer",
      documentsFingerprint: "changed"
    });

    assert.equal(refresh.familyId, "context.project-index");
    assert.equal(query.status, "completed");
    assert.equal(query.resultCount, 1);
    assert.equal(query.contextNodes[0]?.provenance.source, "context.project-index");
    assert.equal(stale.status, "degraded");
    assert.equal(stale.diagnostics.includes("context.project-index.stale-index"), true);
  });

  it("derives stable layered pipeline manifests from existing projection results", async () => {
    const engine = new InMemoryContextEngine();
    const sessionId = asId<"session">("session-pipeline-unit");
    const stableNodes = [
      graphNode(sessionId, "ctx-kernel", "runtime contract v1", 950, { pipelineLayer: "kernel" }),
      graphNode(sessionId, "ctx-project", "AGENTS.md says keep contracts host neutral", 900, { pipelineLayer: "project" }),
      graphNode(sessionId, "ctx-session", "previous turn summary", 100, { pipelineLayer: "session" })
    ];
    const first = await engine.projectGraph({
      ...createProjectionRequest({ sessionId, prompt: "first user input", hardLimitTokens: 64 }),
      candidateNodes: stableNodes
    });
    const second = await engine.projectGraph({
      ...createProjectionRequest({ sessionId, prompt: "second user input", hardLimitTokens: 64 }),
      candidateNodes: stableNodes
    });

    const firstManifest = deriveContextPipelineManifest(first);
    const secondManifest = deriveContextPipelineManifest(second);

    assert.deepEqual(firstManifest.layers.map((layer) => layer.id), ["kernel", "project", "session", "current-turn"]);
    assert.deepEqual(firstManifest.blocks.map((block) => block.layer), ["kernel", "project", "session", "current-turn"]);
    assert.equal(prefixFor(firstManifest, "kernel"), prefixFor(secondManifest, "kernel"));
    assert.equal(prefixFor(firstManifest, "project"), prefixFor(secondManifest, "project"));
    assert.notEqual(prefixFor(firstManifest, "current-turn"), prefixFor(secondManifest, "current-turn"));
    assert.equal(firstManifest.blocks.at(-1)?.content, "first user input");
  });

  it("pinpoints prefix drift without inspecting raw context content", async () => {
    const engine = new InMemoryContextEngine();
    const sessionId = asId<"session">("session-pipeline-drift");
    const kernel = graphNode(sessionId, "ctx-kernel-drift", "runtime contract v1", 950, { pipelineLayer: "kernel" });
    const projectV1 = graphNode(sessionId, "ctx-project-drift", "package map v1", 900, { pipelineLayer: "project", dependencyFingerprints: ["project:v1"] });
    const projectV2 = graphNode(sessionId, "ctx-project-drift", "package map v2", 900, { pipelineLayer: "project", dependencyFingerprints: ["project:v2"] });
    const first = deriveContextPipelineManifest(await engine.projectGraph({
      ...createProjectionRequest({ sessionId, prompt: "same prompt", hardLimitTokens: 64 }),
      candidateNodes: [kernel, projectV1]
    }));
    const second = deriveContextPipelineManifest(await engine.projectGraph({
      ...createProjectionRequest({ sessionId, prompt: "same prompt", hardLimitTokens: 64 }),
      candidateNodes: [kernel, projectV2]
    }));

    const comparison = compareContextPipelineManifests(first, second);

    assert.equal(prefixFor(first, "kernel"), prefixFor(second, "kernel"));
    assert.notEqual(prefixFor(first, "project"), prefixFor(second, "project"));
    assert.equal(comparison.firstChangedLayer, "project");
    assert.equal(comparison.rawContentInspected, false);
    assert.equal(comparison.affectedTokens > 0, true);
    assert.equal(comparison.diagnostics.some((diagnostic) => diagnostic.code === "CONTEXT_PIPELINE_PREFIX_CHANGED" && diagnostic.layer === "project"), true);
  });

  it("reports high-priority exclusions as bounded pipeline diagnostics", async () => {
    const engine = new InMemoryContextEngine();
    const sessionId = asId<"session">("session-pipeline-excluded");
    const projection = await engine.projectGraph({
      ...createProjectionRequest({ sessionId, prompt: "tiny", hardLimitTokens: 4 }),
      candidateNodes: [
        graphNode(
          sessionId,
          "ctx-high-priority-excluded",
          "critical project evidence with many words that cannot fit into the current hard budget",
          950,
          { pipelineLayer: "project", dependencyFingerprints: ["project:critical"] }
        )
      ]
    });

    const manifest = deriveContextPipelineManifest(projection);

    assert.equal(manifest.excludedBlocks.some((block) => block.sourceNodeId === "ctx-high-priority-excluded"), true);
    assert.equal(manifest.diagnostics.some((diagnostic) => diagnostic.code === "CONTEXT_PIPELINE_HIGH_PRIORITY_BLOCK_EXCLUDED" && diagnostic.layer === "project"), true);
    assert.equal(JSON.stringify(manifest.diagnostics).includes("critical project evidence"), false);
  });

  it("summarizes oversized tool results out of stable prefix layers", async () => {
    const engine = new InMemoryContextEngine();
    const sessionId = asId<"session">("session-pipeline-tool");
    const rawToolOutput = `${Array.from({ length: 80 }, (_, index) => `line-${index}`).join(" ")} RAW_END`;
    const projection = await engine.projectGraph({
      ...createProjectionRequest({ sessionId, prompt: "inspect tool output", hardLimitTokens: 256 }),
      candidateNodes: [
        graphNode(sessionId, "ctx-tool-large", rawToolOutput, 800, {
          pipelineLayer: "session",
          source: "tool",
          kind: "tool-result",
          dependencyFingerprints: ["tool:large-output"]
        })
      ]
    });

    const manifest = deriveContextPipelineManifest(projection, { maxStableToolResultTokens: 12 });
    const stableContent = manifest.blocks
      .filter((block) => block.layer !== "current-turn")
      .map((block) => block.content ?? "")
      .join("\n");

    assert.equal(stableContent.includes("RAW_END"), false);
    assert.equal(manifest.blocks.some((block) => block.layer === "session" && block.provenance.summaryOf === "ctx-tool-large"), true);
    assert.equal(manifest.blocks.some((block) => block.layer === "current-turn" && block.content?.includes("RAW_END")), true);
  });

  it("compacts contiguous session ranges while recording source block hashes", async () => {
    const engine = new InMemoryContextEngine();
    const sessionId = asId<"session">("session-pipeline-compact");
    const projection = await engine.projectGraph({
      ...createProjectionRequest({ sessionId, prompt: "continue", hardLimitTokens: 256 }),
      candidateNodes: [
        graphNode(sessionId, "ctx-session-1", "first stable session summary", 300, { pipelineLayer: "session" }),
        graphNode(sessionId, "ctx-session-2", "second stable session summary", 299, { pipelineLayer: "session" }),
        graphNode(sessionId, "ctx-session-3", "third stable session summary", 298, { pipelineLayer: "session" })
      ]
    });

    const uncompacted = deriveContextPipelineManifest(projection);
    const compacted = deriveContextPipelineManifest(projection, { maxSessionBlocksBeforeCompaction: 2 });
    const sessionBlocks = compacted.blocks.filter((block) => block.layer === "session");
    const compactionBlock = sessionBlocks[0];

    assert.equal(uncompacted.blocks.filter((block) => block.layer === "session").length, 3);
    assert.equal(sessionBlocks.length, 1);
    assert.equal(compactionBlock?.provenance.compactedRange, "session:0-2");
    assert.deepEqual(compactionBlock?.replay.sourceBlockHashes, uncompacted.blocks.filter((block) => block.layer === "session").map((block) => block.hash));
    assert.equal((compactionBlock?.content ?? "").includes("first stable session summary"), false);
  });
});

function graphNode(
  sessionId: SessionId,
  id: string,
  content: string,
  priority: number,
  overrides: {
    readonly pipelineLayer?: "kernel" | "project" | "session" | "current-turn";
    readonly source?: ContextGraphNode["source"];
    readonly kind?: ContextGraphNode["kind"];
    readonly dependencyFingerprints?: readonly string[];
  } = {}
): ContextGraphNode {
  return {
    schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION,
    id: asId<"contextNode">(id),
    kind: overrides.kind ?? "file",
    source: overrides.source ?? "workspace",
    lifecycle: "session",
    scope: { sessionId },
    priority,
    content,
    estimatedTokens: content.split(/\s+/).length,
    redaction: { class: "internal" },
    provenance: { fixture: true, ...(overrides.pipelineLayer ? { pipelineLayer: overrides.pipelineLayer } : {}) },
    dependencyFingerprints: overrides.dependencyFingerprints ?? [`fixture:${id}`],
    compatibility: { schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION },
    createdAt: new Date(0).toISOString()
  };
}

function prefixFor(manifest: ReturnType<typeof deriveContextPipelineManifest>, layer: "kernel" | "project" | "session" | "current-turn"): string {
  return manifest.prefixHashes.find((entry) => entry.layer === layer)?.prefixHash ?? "";
}
