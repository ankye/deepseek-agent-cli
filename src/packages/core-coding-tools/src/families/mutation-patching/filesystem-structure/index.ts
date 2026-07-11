import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { dirname } from "node:path";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { invalidateCodeIntelligence, requireDeps, resolveToolPath } from "../../../shared/workspace.js";

interface DirectoryCreateInput extends JsonObject {
  readonly path: string;
  readonly workspaceRoot?: string;
  readonly limitBytes?: number;
}

interface FileTouchInput extends JsonObject {
  readonly path: string;
  readonly workspaceRoot?: string;
  readonly limitBytes?: number;
}

export function defineDirectoryCreateTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "directory.create",
    coreToolIds.directoryCreate,
    "Directory Create",
    "write",
    ["workspace:write"],
    objectSchema(["path"], { path: { type: "string" }, workspaceRoot: { type: "string" }, limitBytes: { type: "number" } }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => directoryCreateTool(input, context, ready))
  );
}

export function defineFileTouchTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "file.touch",
    coreToolIds.fileTouch,
    "File Touch",
    "write",
    ["workspace:write"],
    objectSchema(["path"], { path: { type: "string" }, workspaceRoot: { type: "string" }, limitBytes: { type: "number" } }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => fileTouchTool(input, context, ready))
  );
}

async function directoryCreateTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as DirectoryCreateInput;
  const path = resolveToolPath(deps, parsed.workspaceRoot, parsed.path);
  if (!path.ok || !path.value) return failure("directory.create", "PATH_REJECTED", path.error?.message ?? "Path rejected.", [String(parsed.path ?? "")]);
  await deps.platform.ensureDirectory(path.value.path);
  invalidateCodeIntelligence(deps, path.value.path);
  return success("directory.create", [path.value.path], {
    preview: boundedText(`mkdir ${path.value.path}`, parsed.limitBytes),
    metadata: { operation: "directory.create" },
    replay: replay(context)
  });
}

async function fileTouchTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as FileTouchInput;
  const path = resolveToolPath(deps, parsed.workspaceRoot, parsed.path);
  if (!path.ok || !path.value) return failure("file.touch", "PATH_REJECTED", path.error?.message ?? "Path rejected.", [String(parsed.path ?? "")]);
  const before = await deps.platform.readFile(path.value.path).catch(() => undefined);
  if (before === undefined) {
    await deps.platform.ensureDirectory(dirname(path.value.path));
    await deps.platform.writeFile(path.value.path, "");
  }
  invalidateCodeIntelligence(deps, path.value.path);
  return success("file.touch", [path.value.path], {
    preview: boundedText(`touch ${path.value.path}`, parsed.limitBytes),
    metadata: { operation: "touch", created: before === undefined },
    replay: replay(context)
  });
}
