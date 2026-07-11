import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  JsonValue,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { isModelVisibleWorkspaceRelativePath, requireDeps, resolveToolPath } from "../../../shared/workspace.js";

interface JsonReadInput extends JsonObject {
  readonly path: string;
  readonly pointer?: string;
  readonly workspaceRoot?: string;
  readonly limitBytes?: number;
}

export function defineJsonReadTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "json.read",
    coreToolIds.jsonRead,
    "JSON Read",
    "read",
    ["workspace:read"],
    objectSchema(["path"], {
      path: { type: "string" },
      pointer: { type: "string" },
      workspaceRoot: { type: "string" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => jsonReadTool(input, context, ready))
  );
}

async function jsonReadTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as JsonReadInput;
  const path = resolveToolPath(deps, parsed.workspaceRoot, parsed.path);
  if (!path.ok || !path.value) return failure("json.read", "PATH_REJECTED", path.error?.message ?? "Path rejected.", [String(parsed.path ?? "")]);
  if (!isModelVisibleWorkspaceRelativePath(path.value.relativePath)) {
    return failure("json.read", "INTERNAL_ARTIFACT_REJECTED", "Internal evaluation artifacts are not model-visible through json.read.", [path.value.path]);
  }
  const raw = await deps.platform.readFile(path.value.path).catch((error: unknown) => error instanceof Error ? error : new Error("JSON read failed."));
  if (raw instanceof Error) return failure("json.read", "JSON_READ_FAILED", raw.message, [path.value.path]);
  const root = parseJson(raw);
  if (root instanceof Error) return failure("json.read", "JSON_PARSE_FAILED", root.message, [path.value.path]);
  const pointer = parsed.pointer ?? "";
  const value = getJsonPointer(root, pointer);
  if (value instanceof Error) return failure("json.read", "JSON_POINTER_NOT_FOUND", value.message, [path.value.path], { pointer });
  const text = JSON.stringify(value, null, 2) ?? "null";
  return success("json.read", [path.value.path], {
    preview: boundedText(text, parsed.limitBytes),
    metadata: {
      path: path.value.path,
      relativePath: path.value.relativePath,
      pointer,
      value: jsonValue(value)
    },
    replay: replay(context)
  });
}

function parseJson(raw: string): JsonValue | Error {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch (error) {
    return error instanceof Error ? error : new Error("Malformed JSON.");
  }
}

function getJsonPointer(root: JsonValue, pointer: string): JsonValue | Error {
  if (pointer === "" || pointer === "/") return pointer === "" ? root : pointerChild(root, "");
  if (!pointer.startsWith("/")) return new Error("JSON pointer must be empty or start with '/'.");
  let current: JsonValue = root;
  for (const part of pointer.slice(1).split("/").map(unescapePointerToken)) {
    const next = pointerChild(current, part);
    if (next instanceof Error) return next;
    current = next;
  }
  return current;
}

function pointerChild(value: JsonValue, token: string): JsonValue | Error {
  if (Array.isArray(value)) {
    const index = Number(token);
    if (!Number.isInteger(index) || index < 0 || index >= value.length) return new Error(`Array index '${token}' does not exist.`);
    return value[index] as JsonValue;
  }
  if (typeof value === "object" && value !== null && token in value) return (value as Record<string, JsonValue>)[token] as JsonValue;
  return new Error(`Object key '${token}' does not exist.`);
}

function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function jsonValue(value: JsonValue): JsonValue {
  return value;
}
