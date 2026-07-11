import type {
  CapabilityExecutionContext,
  CoreToolResult,
  FileListInput,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { isModelVisibleWorkspaceRelativePath, requireDeps, resolveToolPath, workspaceRelativePath } from "../../../shared/workspace.js";

export function defineFileListTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "file.list",
    coreToolIds.fileList,
    "File List",
    "read",
    ["workspace:read"],
    objectSchema([], {
      pattern: { type: "string" },
      path: { type: "string" },
      workspaceRoot: { type: "string" },
      limit: { type: "number" },
      limitBytes: { type: "number" },
      sort: { type: "string" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => listFilesTool(input, context, ready))
  );
}

async function listFilesTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as FileListInput;
  const listRoot = resolveToolPath(deps, parsed.workspaceRoot, parsed.path ?? ".");
  if (!listRoot.ok || !listRoot.value) return failure("file.list", "PATH_REJECTED", listRoot.error?.message ?? "Path rejected.", [String(parsed.path ?? ".")]);
  const root = listRoot.value.path;
  const pattern = parsed.pattern ?? "";
  const limit = parsed.limit ?? 200;
  const sort = parsed.sort ?? "mtime-desc";
  const activeWorkspaceRoot = parsed.workspaceRoot ?? deps.workspaceRoot;
  const files = (await findListedFiles(deps, root, pattern))
    .filter((path) => isModelVisibleWorkspaceRelativePath(workspaceRelativePath(activeWorkspaceRoot, path)));
  const ordered = await orderFiles(deps.platform as unknown as { statFile?: (path: string) => Promise<{ mtimeMs: number }> }, files, sort);
  const limited = ordered.slice(0, limit);
  return success("file.list", limited, {
    preview: boundedText(limited.join("\n"), parsed.limitBytes ?? 8_000),
    metadata: { pattern, count: limited.length, root, relativePath: listRoot.value.relativePath, sort },
    replay: replay(context)
  });
}

async function findListedFiles(deps: CoreCodingToolsDependencies, root: string, pattern: string): Promise<readonly string[]> {
  if (!hasGlobMeta(pattern)) return deps.platform.findFiles(pattern, root);
  const matcher = globToRegExp(pattern);
  const normalizedRoot = normalizePath(root);
  const files = await deps.platform.findFiles("", root);
  return files.filter((file) => {
    const relative = normalizePath(file).slice(normalizedRoot.length).replace(/^\//, "");
    return isModelVisibleWorkspaceRelativePath(relative) && matcher.test(relative);
  });
}

function hasGlobMeta(pattern: string): boolean {
  return /[*?[\]]/.test(pattern);
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(character);
  }
  return new RegExp(`${source}$`);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

async function orderFiles(platform: { statFile?: (path: string) => Promise<{ mtimeMs: number }> }, files: readonly string[], sort: "alpha" | "mtime-desc"): Promise<string[]> {
  if (sort === "alpha" || !platform.statFile) return [...files].sort();
  const stats = await Promise.all(files.map(async (file) => {
    try {
      const stat = await platform.statFile!(file);
      return { file, mtime: stat.mtimeMs };
    } catch {
      return { file, mtime: 0 };
    }
  }));
  stats.sort((a, b) => b.mtime - a.mtime);
  return stats.map((entry) => entry.file);
}
