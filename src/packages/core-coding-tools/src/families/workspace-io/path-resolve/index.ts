import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { requireDeps, resolveToolPath } from "../../../shared/workspace.js";

interface PathResolveInput extends JsonObject {
  readonly path: string;
  readonly workspaceRoot?: string;
  readonly limitBytes?: number;
}

export function definePathResolveTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "path.resolve",
    coreToolIds.pathResolve,
    "Path Resolve",
    "read",
    ["workspace:read"],
    objectSchema(["path"], {
      path: { type: "string" },
      workspaceRoot: { type: "string" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => pathResolveTool(input, context, ready))
  );
}

async function pathResolveTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as PathResolveInput;
  const resolved = resolveToolPath(deps, parsed.workspaceRoot, parsed.path);
  if (!resolved.ok || !resolved.value) return failure("path.resolve", "PATH_REJECTED", resolved.error?.message ?? "Path rejected.", [String(parsed.path ?? "")]);
  const descriptor = await deps.platform.descriptor();
  return success("path.resolve", [resolved.value.path], {
    preview: boundedText(`${resolved.value.relativePath} -> ${resolved.value.path}`, parsed.limitBytes),
    metadata: {
      inputPath: parsed.path,
      path: resolved.value.path,
      root: resolved.value.root,
      relativePath: resolved.value.relativePath,
      safe: resolved.value.safe,
      filesystem: descriptor.filesystem,
      diagnostics: resolved.value.diagnostics
    },
    replay: replay(context)
  });
}
