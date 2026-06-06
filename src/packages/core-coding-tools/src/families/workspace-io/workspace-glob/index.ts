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
import { isModelVisibleWorkspaceRelativePath, requireDeps, resolveToolPath } from "../../../shared/workspace.js";

const TOOL_NAME = "workspace.glob" as CoreCodingToolName;
const DEFAULT_LIMIT = 200;

interface WorkspaceGlobInput extends JsonObject {
  readonly pattern: string;
  readonly path?: string;
  readonly workspaceRoot?: string;
  readonly limit?: number;
  readonly limitBytes?: number;
}

export function defineWorkspaceGlobTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    TOOL_NAME,
    coreToolIds.workspaceGlob,
    "Workspace Glob",
    "read",
    ["workspace:read"],
    objectSchema(["pattern"], {
      pattern: { type: "string" },
      path: { type: "string" },
      workspaceRoot: { type: "string" },
      limit: { type: "number" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => workspaceGlobTool(input, context, ready))
  );
}

async function workspaceGlobTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as WorkspaceGlobInput;
  const rootPath = resolveToolPath(deps, parsed.workspaceRoot, parsed.path ?? ".");
  if (!rootPath.ok || !rootPath.value) return failure(TOOL_NAME, "PATH_REJECTED", rootPath.error?.message ?? "Path rejected.", [String(parsed.path ?? ".")]);
  const pattern = parsed.pattern;
  if (!isSafeGlobPattern(pattern)) return failure(TOOL_NAME, "GLOB_PATTERN_REJECTED", "Glob pattern contains an unsafe absolute, traversal, shell, null-byte, or drive-relative segment.", [rootPath.value.path], { pattern });

  const files = await deps.platform.findFiles("", rootPath.value.path);
  const matcher = globToRegExp(pattern);
  const root = normalizePath(rootPath.value.path);
  const matches = files
    .map((file) => ({ absolute: normalizePath(file), relative: normalizePath(file).slice(root.length).replace(/^\//, "") }))
    .filter((file) => isModelVisibleWorkspaceRelativePath(file.relative))
    .filter((file) => matcher.test(file.relative))
    .sort((a, b) => a.relative.localeCompare(b.relative));
  const limit = boundedLimit(parsed.limit);
  const limited = matches.slice(0, limit);
  return success(TOOL_NAME, limited.map((file) => file.absolute), {
    preview: boundedText(limited.map((file) => file.relative).join("\n"), parsed.limitBytes),
    metadata: {
      pattern,
      root: rootPath.value.path,
      relativeRoot: rootPath.value.relativePath,
      count: limited.length,
      totalMatches: matches.length,
      truncated: matches.length > limited.length,
      limit
    },
    replay: replay(context)
  });
}

function boundedLimit(limit: number | undefined): number {
  return Number.isFinite(limit) ? Math.max(0, Math.min(1_000, Math.floor(limit ?? DEFAULT_LIMIT))) : DEFAULT_LIMIT;
}

function isSafeGlobPattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.includes("\0") || pattern.startsWith("~") || /(^|[^\\])[$`]/.test(pattern)) return false;
  const slashPattern = normalizePath(pattern);
  if (slashPattern.startsWith("/") || /^[a-zA-Z]:/.test(slashPattern) || slashPattern.startsWith("//")) return false;
  return !slashPattern.split("/").some((segment) => segment === ".." || /[. ]$/.test(segment));
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
