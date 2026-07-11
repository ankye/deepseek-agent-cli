import type {
  CapabilityRegistry,
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { requireDeps } from "../../../shared/workspace.js";

interface ToolSearchDeps extends CoreCodingToolsDependencies {
  readonly capabilities?: CapabilityRegistry;
}

export function defineToolSearchTool(deps: ToolSearchDeps | undefined) {
  return defineToolManifest(
    "tool.search",
    coreToolIds.toolSearch,
    "Tool Search",
    "read",
    ["capability:read"],
    objectSchema(["query"], {
      query: { type: "string" },
      limit: { type: "number" },
      familyId: { type: "string" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => toolSearch(input, context, ready as ToolSearchDeps))
  );
}

async function toolSearch(input: JsonObject, context: CapabilityExecutionContext, deps: ToolSearchDeps): Promise<SerializableResult<CoreToolResult>> {
  if (!deps.capabilities) return failure("tool.search", "TOOL_SEARCH_REGISTRY_UNAVAILABLE", "CapabilityRegistry is required for tool.search.", []);
  const query = stringValue(input.query);
  if (!query) return failure("tool.search", "TOOL_SEARCH_QUERY_REQUIRED", "query is required.", []);
  const limit = boundedLimit(input.limit, 8, 50);
  const familyId = stringValue(input.familyId);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const manifests = await deps.capabilities.listModelVisible();
  const scored = manifests
    .map((manifest) => {
      const toolFamily = manifest.toolFamily;
      const haystack = [
        manifest.id,
        manifest.name,
        manifest.description,
        ...stringArray(manifest.permissions),
        ...stringArray(manifest.projection?.policyTags),
        toolFamily?.familyId,
        toolFamily?.domainId,
        toolFamily?.toolId
      ].filter(Boolean).join(" ").toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { manifest, score };
    })
    .filter((entry) => entry.score > 0 && (!familyId || entry.manifest.toolFamily?.familyId === familyId))
    .sort((left, right) => right.score - left.score || String(left.manifest.id).localeCompare(String(right.manifest.id)))
    .slice(0, limit);
  const tools = scored.map(({ manifest, score }) => ({
    capabilityId: String(manifest.id),
    name: manifest.name,
    familyId: manifest.toolFamily?.familyId,
    domainId: manifest.toolFamily?.domainId,
    toolId: manifest.toolFamily?.toolId,
    sideEffect: manifest.sideEffect,
    permissions: manifest.permissions,
    score
  }));
  return success("tool.search", [], {
    preview: boundedText(tools.map((tool) => `${tool.capabilityId} ${tool.familyId ?? ""} ${tool.name}`).join("\n")),
    metadata: {
      query,
      returnedCount: tools.length,
      tools
    },
    replay: replay(context)
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function boundedLimit(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(max, Math.floor(value))) : fallback;
}
