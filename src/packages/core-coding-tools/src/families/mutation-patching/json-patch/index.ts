import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  JsonValue,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success, undefinedError, isDiagnostic } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { editTransaction, invalidateCodeIntelligence, publicTransactionEvidence, requireDeps, resolveToolPath, toWorkspaceTransaction } from "../../../shared/workspace.js";

interface JsonPatchInput extends JsonObject {
  readonly path: string;
  readonly operations: readonly JsonPatchOperation[];
  readonly workspaceRoot?: string;
  readonly limitBytes?: number;
}

interface JsonPatchOperation extends JsonObject {
  readonly op: "add" | "replace" | "remove";
  readonly path: string;
  readonly value?: JsonValue;
}

export function defineJsonPatchTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "json.patch",
    coreToolIds.jsonPatch,
    "JSON Patch",
    "write",
    ["workspace:write"],
    objectSchema(["path", "operations"], {
      path: { type: "string" },
      operations: { type: "array" },
      workspaceRoot: { type: "string" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => jsonPatchTool(input, context, ready))
  );
}

async function jsonPatchTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as JsonPatchInput;
  const path = resolveToolPath(deps, parsed.workspaceRoot, parsed.path);
  if (!path.ok || !path.value) return failure("json.patch", "PATH_REJECTED", path.error?.message ?? "Path rejected.", [String(parsed.path ?? "")]);
  if (!Array.isArray(parsed.operations) || parsed.operations.length === 0) return failure("json.patch", "JSON_PATCH_EMPTY", "JSON patch requires at least one operation.", [path.value.path]);
  const before = await deps.platform.readFile(path.value.path).catch((error: unknown) => undefinedError(error, "JSON_READ_FAILED"));
  if (isDiagnostic(before)) return failure("json.patch", before.code, before.message, [path.value.path]);
  const parsedJson = parseJson(before);
  if (parsedJson instanceof Error) return failure("json.patch", "JSON_PARSE_FAILED", parsedJson.message, [path.value.path]);
  const patched = applyOperations(parsedJson, parsed.operations);
  if (patched instanceof Error) return failure("json.patch", "JSON_PATCH_FAILED", patched.message, [path.value.path], { operationCount: parsed.operations.length });
  const after = `${JSON.stringify(patched, null, 2)}\n`;
  if (after === before) return failure("json.patch", "JSON_PATCH_NOOP", "JSON patch would leave the file unchanged.", [path.value.path]);
  await deps.platform.writeFile(path.value.path, after);
  const transaction = editTransaction(context, path.value.path, "full-write", before, after, true, []);
  const workspaceTransaction = await deps.workspaceState.transact(toWorkspaceTransaction(transaction, before));
  invalidateCodeIntelligence(deps, path.value.path);
  return success("json.patch", [path.value.path], {
    preview: boundedText(after, parsed.limitBytes),
    metadata: {
      path: path.value.path,
      relativePath: path.value.relativePath,
      operationCount: parsed.operations.length,
      checkpoint: publicTransactionEvidence(transaction, workspaceTransaction)
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

function applyOperations(root: JsonValue, operations: readonly JsonPatchOperation[]): JsonValue | Error {
  const clone = JSON.parse(JSON.stringify(root)) as JsonValue;
  for (const operation of operations) {
    const result = applyOperation(clone, operation);
    if (result instanceof Error) return result;
  }
  return clone;
}

function applyOperation(root: JsonValue, operation: JsonPatchOperation): true | Error {
  if (!["add", "replace", "remove"].includes(operation.op)) return new Error(`Unsupported JSON patch operation '${String(operation.op)}'.`);
  if (!operation.path.startsWith("/")) return new Error("JSON patch operation path must start with '/'.");
  const tokens = operation.path.slice(1).split("/").map(unescapePointerToken);
  const key = tokens.pop();
  if (key === undefined) return new Error("JSON patch operation path is empty.");
  const parent = resolveParent(root, tokens);
  if (parent instanceof Error) return parent;
  if (Array.isArray(parent)) return applyArrayOperation(parent, key, operation);
  if (typeof parent === "object" && parent !== null) return applyObjectOperation(parent as Record<string, JsonValue>, key, operation);
  return new Error("JSON patch parent is not an object or array.");
}

function resolveParent(root: JsonValue, tokens: readonly string[]): JsonValue | Error {
  let current: JsonValue = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return new Error(`Array index '${token}' does not exist.`);
      current = current[index] as JsonValue;
    } else if (typeof current === "object" && current !== null && token in current) {
      current = (current as Record<string, JsonValue>)[token] as JsonValue;
    } else {
      return new Error(`Object key '${token}' does not exist.`);
    }
  }
  return current;
}

function applyObjectOperation(parent: Record<string, JsonValue>, key: string, operation: JsonPatchOperation): true | Error {
  if (operation.op === "remove") {
    if (!(key in parent)) return new Error(`Object key '${key}' does not exist.`);
    delete parent[key];
    return true;
  }
  if (operation.op === "replace" && !(key in parent)) return new Error(`Object key '${key}' does not exist.`);
  parent[key] = operation.value ?? null;
  return true;
}

function applyArrayOperation(parent: JsonValue[], key: string, operation: JsonPatchOperation): true | Error {
  const index = key === "-" ? parent.length : Number(key);
  if (!Number.isInteger(index) || index < 0 || index > parent.length) return new Error(`Array index '${key}' is invalid.`);
  if (operation.op === "remove") {
    if (index >= parent.length) return new Error(`Array index '${key}' does not exist.`);
    parent.splice(index, 1);
    return true;
  }
  if (operation.op === "replace") {
    if (index >= parent.length) return new Error(`Array index '${key}' does not exist.`);
    parent[index] = operation.value ?? null;
    return true;
  }
  parent.splice(index, 0, operation.value ?? null);
  return true;
}

function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}
