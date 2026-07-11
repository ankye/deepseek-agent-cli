import type {
  CapabilityExecutionContext,
  CoreCodingToolName,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { invalidateCodeIntelligence, requireDeps, resolveToolPath } from "../../../shared/workspace.js";

interface FileCopyInput extends JsonObject {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly workspaceRoot?: string;
  readonly overwrite?: boolean;
  readonly recursive?: boolean;
  readonly limitBytes?: number;
}

interface FileMoveInput extends JsonObject {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly workspaceRoot?: string;
  readonly overwrite?: boolean;
  readonly limitBytes?: number;
}

interface FileDeleteInput extends JsonObject {
  readonly path: string;
  readonly workspaceRoot?: string;
  readonly recursive?: boolean;
  readonly limitBytes?: number;
}

export function defineFileCopyTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "file.copy",
    coreToolIds.fileCopy,
    "File Copy",
    "write",
    ["workspace:write"],
    objectSchema(["sourcePath", "targetPath"], {
      sourcePath: { type: "string" },
      targetPath: { type: "string" },
      workspaceRoot: { type: "string" },
      overwrite: { type: "boolean" },
      recursive: { type: "boolean" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => copyFileTool(input, context, ready))
  );
}

export function defineFileMoveTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "file.move",
    coreToolIds.fileMove,
    "File Move",
    "write",
    ["workspace:write"],
    objectSchema(["sourcePath", "targetPath"], {
      sourcePath: { type: "string" },
      targetPath: { type: "string" },
      workspaceRoot: { type: "string" },
      overwrite: { type: "boolean" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => moveFileTool(input, context, ready))
  );
}

export function defineFileDeleteTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "file.delete",
    coreToolIds.fileDelete,
    "File Delete",
    "write",
    ["workspace:write"],
    objectSchema(["path"], {
      path: { type: "string" },
      workspaceRoot: { type: "string" },
      recursive: { type: "boolean" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => deleteFileTool(input, context, ready))
  );
}

async function copyFileTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as FileCopyInput;
  const paths = resolveSourceTarget(deps, parsed.workspaceRoot, parsed.sourcePath, parsed.targetPath, "file.copy");
  if (!paths.ok) return paths.result;
  try {
    await deps.platform.copyPath(paths.source, paths.target, { overwrite: parsed.overwrite === true, recursive: parsed.recursive === true });
    invalidateCodeIntelligence(deps, paths.target);
    return pathMutationSuccess("file.copy", context, paths.source, paths.target, "copy", parsed.limitBytes, { overwrite: parsed.overwrite === true, recursive: parsed.recursive === true });
  } catch (error) {
    return pathMutationFailure("file.copy", error, [paths.source, paths.target]);
  }
}

async function moveFileTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as FileMoveInput;
  const paths = resolveSourceTarget(deps, parsed.workspaceRoot, parsed.sourcePath, parsed.targetPath, "file.move");
  if (!paths.ok) return paths.result;
  try {
    await deps.platform.movePath(paths.source, paths.target, { overwrite: parsed.overwrite === true });
    invalidateCodeIntelligence(deps, paths.source);
    invalidateCodeIntelligence(deps, paths.target);
    return pathMutationSuccess("file.move", context, paths.source, paths.target, "move", parsed.limitBytes, { overwrite: parsed.overwrite === true });
  } catch (error) {
    return pathMutationFailure("file.move", error, [paths.source, paths.target]);
  }
}

async function deleteFileTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as FileDeleteInput;
  const path = resolveToolPath(deps, parsed.workspaceRoot, parsed.path);
  if (!path.ok || !path.value) return failure("file.delete", "PATH_REJECTED", path.error?.message ?? "Path rejected.", [String(parsed.path ?? "")]);
  try {
    await deps.platform.deletePath(path.value.path, { recursive: parsed.recursive === true });
    invalidateCodeIntelligence(deps, path.value.path);
    return success("file.delete", [path.value.path], {
      preview: boundedText(`delete ${path.value.path}`, parsed.limitBytes),
      metadata: { operation: "delete", recursive: parsed.recursive === true },
      replay: replay(context)
    });
  } catch (error) {
    return pathMutationFailure("file.delete", error, [path.value.path]);
  }
}

function resolveSourceTarget(
  deps: CoreCodingToolsDependencies,
  workspaceRoot: string | undefined,
  sourcePath: string,
  targetPath: string,
  tool: "file.copy" | "file.move"
): { readonly ok: true; readonly source: string; readonly target: string } | { readonly ok: false; readonly result: SerializableResult<CoreToolResult> } {
  const source = resolveToolPath(deps, workspaceRoot, sourcePath);
  if (!source.ok || !source.value) return { ok: false, result: failure(tool, "SOURCE_PATH_REJECTED", source.error?.message ?? "Source path rejected.", [String(sourcePath ?? "")]) };
  const target = resolveToolPath(deps, workspaceRoot, targetPath);
  if (!target.ok || !target.value) return { ok: false, result: failure(tool, "TARGET_PATH_REJECTED", target.error?.message ?? "Target path rejected.", [source.value.path, String(targetPath ?? "")]) };
  if (source.value.path === target.value.path) return { ok: false, result: failure(tool, "SOURCE_TARGET_SAME", "Source and target paths must be different.", [source.value.path]) };
  return { ok: true, source: source.value.path, target: target.value.path };
}

function pathMutationSuccess(
  tool: CoreCodingToolName,
  context: CapabilityExecutionContext,
  source: string,
  target: string,
  operation: "copy" | "move",
  limitBytes: number | undefined,
  metadata: JsonObject
): SerializableResult<CoreToolResult> {
  return success(tool, [source, target], {
    preview: boundedText(`${operation} ${source} -> ${target}`, limitBytes),
    metadata: { operation, sourcePath: source, targetPath: target, ...metadata },
    replay: replay(context)
  });
}

function pathMutationFailure(tool: CoreCodingToolName, error: unknown, affectedPaths: readonly string[]): SerializableResult<CoreToolResult> {
  const message = error instanceof Error ? error.message : "Path mutation failed.";
  const upper = message.toUpperCase();
  if (upper.includes("COPY_RECURSIVE_REQUIRED")) return failure(tool, "FILE_COPY_RECURSIVE_REQUIRED", "Copying a directory requires recursive: true.", affectedPaths);
  if (upper.includes("DELETE_RECURSIVE_REQUIRED")) return failure(tool, "FILE_DELETE_RECURSIVE_REQUIRED", "Deleting a directory requires recursive: true.", affectedPaths);
  if (upper.includes("TARGET_EXISTS") || upper.includes("EEXIST") || upper.includes("ENOTEMPTY")) return failure(tool, "FILE_TARGET_EXISTS", "Target path already exists; set overwrite: true when replacement is intended.", affectedPaths);
  if (upper.includes("NOT FOUND") || upper.includes("ENOENT")) return failure(tool, "FILE_PATH_NOT_FOUND", message, affectedPaths);
  return failure(tool, "FILE_PATH_MUTATION_FAILED", message, affectedPaths);
}
