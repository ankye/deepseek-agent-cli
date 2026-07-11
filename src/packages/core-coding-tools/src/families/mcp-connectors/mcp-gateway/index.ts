import type {
  CapabilityExecutionContext,
  CoreCodingToolName,
  CoreToolResult,
  JsonObject,
  McpGateway,
  McpOperationStatus,
  SerializableResult
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { requireDeps } from "../../../shared/workspace.js";

interface McpGatewayToolDeps extends CoreCodingToolsDependencies {
  readonly mcp?: McpGateway;
}

export function defineMcpToolCallTool(deps: McpGatewayToolDeps | undefined) {
  return defineToolManifest(
    "mcp.tool.call",
    coreToolIds.mcpToolCall,
    "MCP Tool Call",
    "none",
    ["mcp:call"],
    objectSchema(["serverId", "name"], {
      serverId: { type: "string" },
      name: { type: "string" },
      input: { type: "object" },
      timeoutMs: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => mcpToolCall(input, context, ready as McpGatewayToolDeps))
  );
}

export function defineMcpResourceListTool(deps: McpGatewayToolDeps | undefined) {
  return defineToolManifest(
    "mcp.resource.list",
    coreToolIds.mcpResourceList,
    "MCP Resource List",
    "read",
    ["mcp:read"],
    objectSchema([], {
      namespace: { type: "string" },
      includeInert: { type: "boolean" },
      limit: { type: "number" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => mcpResourceList(input, context, ready as McpGatewayToolDeps))
  );
}

export function defineMcpResourceReadTool(deps: McpGatewayToolDeps | undefined) {
  return defineToolManifest(
    "mcp.resource.read",
    coreToolIds.mcpResourceRead,
    "MCP Resource Read",
    "read",
    ["mcp:read"],
    objectSchema(["serverId", "uri"], {
      serverId: { type: "string" },
      uri: { type: "string" },
      timeoutMs: { type: "number" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => mcpResourceRead(input, context, ready as McpGatewayToolDeps))
  );
}

async function mcpToolCall(input: JsonObject, context: CapabilityExecutionContext, deps: McpGatewayToolDeps): Promise<SerializableResult<CoreToolResult>> {
  if (!deps.mcp) return mcpUnavailable("mcp.tool.call");
  const serverId = stringValue(input.serverId);
  const name = stringValue(input.name);
  if (!serverId || !name) return failure("mcp.tool.call", "MCP_TOOL_INPUT_REQUIRED", "serverId and name are required.", []);
  const result = await deps.mcp.callTool({
    schemaVersion: "1.0.0",
    serverId: asId<"mcpServer">(serverId),
    name,
    input: isJsonObject(input.input) ? input.input : {},
    caller: "model",
    ...(context.envelope.sessionId ? { sessionId: context.envelope.sessionId } : {}),
    ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
    trace: context.trace
  });
  return success("mcp.tool.call", [serverId], {
    preview: boundedText(JSON.stringify(result.output ?? result.diagnostics, null, 2), 8_000),
    metadata: {
      status: result.status,
      serverId: result.serverId,
      name: result.name,
      qualifiedName: result.qualifiedName,
      output: result.output,
      diagnostics: result.diagnostics as unknown as JsonObject
    },
    replay: replay(context),
    status: coreStatus(result.status)
  });
}

async function mcpResourceList(input: JsonObject, context: CapabilityExecutionContext, deps: McpGatewayToolDeps): Promise<SerializableResult<CoreToolResult>> {
  if (!deps.mcp) return mcpUnavailable("mcp.resource.list");
  const resources = (await deps.mcp.listResources({
    schemaVersion: "1.0.0",
    ...(typeof input.namespace === "string" ? { namespace: input.namespace } : {}),
    includeInert: input.includeInert === true,
    ...(context.envelope.sessionId ? { sessionId: context.envelope.sessionId } : {}),
    trace: context.trace
  })).slice(0, boundedCount(input.limit, 50, 500));
  return success("mcp.resource.list", resources.map((resource) => resource.uri), {
    preview: boundedText(resources.map((resource) => `${resource.namespace} ${resource.uri} ${resource.mimeType}`).join("\n"), typeof input.limitBytes === "number" ? input.limitBytes : 8_000),
    metadata: {
      count: resources.length,
      resources: resources as unknown as JsonObject
    },
    replay: replay(context)
  });
}

async function mcpResourceRead(input: JsonObject, context: CapabilityExecutionContext, deps: McpGatewayToolDeps): Promise<SerializableResult<CoreToolResult>> {
  if (!deps.mcp) return mcpUnavailable("mcp.resource.read");
  const serverId = stringValue(input.serverId);
  const uri = stringValue(input.uri);
  if (!serverId || !uri) return failure("mcp.resource.read", "MCP_RESOURCE_INPUT_REQUIRED", "serverId and uri are required.", []);
  const result = await deps.mcp.readResource({
    schemaVersion: "1.0.0",
    serverId: asId<"mcpServer">(serverId),
    uri,
    caller: "model",
    ...(context.envelope.sessionId ? { sessionId: context.envelope.sessionId } : {}),
    ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
    trace: context.trace
  });
  return success("mcp.resource.read", [uri], {
    preview: boundedText(result.content ?? result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"), typeof input.limitBytes === "number" ? input.limitBytes : 8_000),
    metadata: {
      status: result.status,
      serverId: result.serverId,
      uri: result.uri,
      mimeType: result.mimeType,
      cachePolicy: result.cachePolicy,
      diagnostics: result.diagnostics as unknown as JsonObject
    },
    replay: replay(context),
    status: coreStatus(result.status)
  });
}

function mcpUnavailable(toolName: CoreCodingToolName): SerializableResult<CoreToolResult> {
  return failure(toolName, "MCP_GATEWAY_UNAVAILABLE", "McpGateway is required for MCP connector tools.", []);
}

function coreStatus(status: McpOperationStatus): "completed" | "failed" | "rejected" {
  if (status === "completed") return "completed";
  if (status === "rejected") return "rejected";
  return "failed";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedCount(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : fallback;
}
