import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProjectionRequest, InMemoryContextEngine } from "@deepseek/context-engine";
import { asId, CONTEXT_PROJECTION_SCHEMA_VERSION } from "@deepseek/platform-contracts";

describe("context projection matrix", () => {
  it("covers empty, large, secret, stale-cache, hard-budget, and degraded-memory scenarios", async () => {
    const cases: ReadonlyArray<{ readonly name: string; readonly prompt: string; readonly hard: number; readonly soft?: number; readonly expectedStatus: string }> = [
      { name: "empty", prompt: "", hard: 10, expectedStatus: "degraded" },
      { name: "large", prompt: "one two three four five", hard: 3, expectedStatus: "rejected" },
      { name: "secret", prompt: "sk-live-secret-value", hard: 10, expectedStatus: "degraded" },
      { name: "memory-unavailable", prompt: "memory missing but prompt works", hard: 10, expectedStatus: "completed" },
      { name: "soft-degraded", prompt: "one two three", hard: 10, soft: 1, expectedStatus: "degraded" }
    ];

    for (const item of cases) {
      const engine = new InMemoryContextEngine();
      const sessionId = asId<"session">(`session-projection-${item.name}`);
      const result = await engine.projectGraph(createProjectionRequest({
        sessionId,
        prompt: item.prompt,
        hardLimitTokens: item.hard,
        ...(item.soft !== undefined ? { softLimitTokens: item.soft } : {})
      }));
      assert.equal(result.status, item.expectedStatus, item.name);
      assert.equal(result.prompt.includes("sk-live-secret-value"), false);
    }

    const cacheEngine = new InMemoryContextEngine();
    const sessionId = asId<"session">("session-projection-stale-cache");
    const request = {
      ...createProjectionRequest({ sessionId, prompt: "stale cache", hardLimitTokens: 10 }),
      candidateNodes: [{
        schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION,
        id: asId<"contextNode">("ctx-cache-matrix-stable"),
        kind: "file" as const,
        source: "workspace" as const,
        lifecycle: "session" as const,
        scope: { sessionId },
        priority: 100,
        content: "stable matrix context",
        estimatedTokens: 3,
        redaction: { class: "internal" as const },
        provenance: { source: "matrix" },
        dependencyFingerprints: ["matrix:stable-context"],
        compatibility: { schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION },
        createdAt: "1970-01-01T00:00:00.000Z"
      }]
    };
    const first = await cacheEngine.projectGraph(request);
    const second = await cacheEngine.projectGraph(request);
    assert.equal(first.cache.hit, false);
    assert.equal(second.cache.hit, true);
  });
});
