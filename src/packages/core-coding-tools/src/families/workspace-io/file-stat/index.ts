import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { isModelVisibleWorkspaceRelativePath, requireDeps, resolveToolPath } from "../../../shared/workspace.js";

interface FileStatInput extends JsonObject {
  readonly path: string;
  readonly workspaceRoot?: string;
  readonly limitBytes?: number;
}

export function defineFileStatTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "file.stat",
    coreToolIds.fileStat,
    "File Stat",
    "read",
    ["workspace:read"],
    objectSchema(["path"], { path: { type: "string" }, workspaceRoot: { type: "string" }, limitBytes: { type: "number" } }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => fileStatTool(input, context, ready))
  );
}

async function fileStatTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as FileStatInput;
  const path = resolveToolPath(deps, parsed.workspaceRoot, parsed.path);
  if (!path.ok || !path.value) return failure("file.stat", "PATH_REJECTED", path.error?.message ?? "Path rejected.", [String(parsed.path ?? "")]);
  if (!isModelVisibleWorkspaceRelativePath(path.value.relativePath)) {
    return failure("file.stat", "INTERNAL_ARTIFACT_REJECTED", "Internal evaluation artifacts are not model-visible through file.stat.", [path.value.path]);
  }
  try {
    const stat = await deps.platform.statPath(path.value.path);
    return success("file.stat", [path.value.path], {
      preview: boundedText(`${stat.kind} ${path.value.relativePath} ${stat.sizeBytes}B`, parsed.limitBytes),
      metadata: {
        path: path.value.path,
        relativePath: path.value.relativePath,
        kind: stat.kind,
        sizeBytes: stat.sizeBytes,
        mtimeMs: stat.mtimeMs
      },
      replay: replay(context)
    });
  } catch (error) {
    return failure("file.stat", "FILE_STAT_FAILED", error instanceof Error ? error.message : "File stat failed.", [path.value.path]);
  }
}
