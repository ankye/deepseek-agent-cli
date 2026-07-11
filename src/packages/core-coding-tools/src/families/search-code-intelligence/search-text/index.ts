import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SearchTextInput,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { isModelVisibleWorkspaceRelativePath, requireDeps, workspaceRelativePath } from "../../../shared/workspace.js";

export function defineSearchTextTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "search.text",
    coreToolIds.searchText,
    "Search Text",
    "read",
    ["workspace:read"],
    objectSchema(["pattern"], {
      pattern: { type: "string" },
      workspaceRoot: { type: "string" },
      limit: { type: "number" },
      limitBytes: { type: "number" },
      contextLines: { type: "number" },
      multiline: { type: "boolean" },
      glob: { type: "string" },
      caseInsensitive: { type: "boolean" },
      outputMode: { type: "string" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => searchTextTool(input, context, ready))
  );
}

async function searchTextTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as SearchTextInput;
  const root = parsed.workspaceRoot ?? deps.workspaceRoot;
  let regex: RegExp;
  try {
    const flags = `${parsed.caseInsensitive ? "i" : ""}${parsed.multiline ? "s" : ""}`;
    regex = new RegExp(parsed.pattern, flags);
  } catch (error) {
    return failure("search.text", "SEARCH_PATTERN_INVALID", error instanceof Error ? error.message : "Invalid pattern.", []);
  }

  const outputMode = parsed.outputMode ?? "files_with_matches";
  const contextLines = Math.max(0, parsed.contextLines ?? 0);
  const glob = parsed.glob ?? "";
  const limit = parsed.limit ?? 50;
  const limitBytes = parsed.limitBytes ?? 16_000;

  const platformAsRegex = deps.platform as unknown as {
    readFile?: (path: string) => Promise<string>;
    findFiles: (pattern: string, root: string) => Promise<readonly string[]>;
    searchText: (pattern: string, root: string) => Promise<readonly { path: string; line: number; text: string; metadata?: import("@deepseek/platform-contracts").PlatformProviderResultMetadata }[]>;
  };

  if (outputMode === "files_with_matches" && !glob && contextLines === 0 && !parsed.multiline && !parsed.caseInsensitive) {
    const results = (await platformAsRegex.searchText(parsed.pattern, root))
      .map((result) => ({ ...result, displayPath: workspaceRelativePath(root, result.path) }))
      .filter((result) => isModelVisibleWorkspaceRelativePath(result.displayPath))
      .slice(0, limit);
    return success("search.text", results.map((result) => result.path), {
      preview: boundedText(results.map((result) => `${result.displayPath}:${result.line}: ${result.text}`).join("\n"), limitBytes),
      provider: results[0]?.metadata,
      metadata: { pattern: parsed.pattern, count: results.length, outputMode },
      replay: replay(context)
    });
  }

  const candidateFiles = [...await platformAsRegex.findFiles("", root)]
    .map((path) => ({ path, displayPath: workspaceRelativePath(root, path) }))
    .filter((file) => isModelVisibleWorkspaceRelativePath(file.displayPath))
    .filter((file) => matchesGlob(file.displayPath, glob))
    .sort();
  const matchesPerFile: Array<{ path: string; displayPath: string; hits: Array<{ line: number; text: string }> }> = [];
  for (const filePath of candidateFiles) {
    const content = await platformAsRegex.readFile?.(filePath.path).catch(() => undefined);
    if (typeof content !== "string") continue;
    const hits = parsed.multiline ? matchMultiline(content, regex) : matchLineByLine(content, regex);
    if (hits.length > 0) matchesPerFile.push({ path: filePath.path, displayPath: filePath.displayPath, hits });
    if (matchesPerFile.length >= limit && outputMode === "files_with_matches") break;
  }

  const limited = matchesPerFile.slice(0, limit);
  if (outputMode === "count") {
    const preview = limited.map((file) => `${file.displayPath}: ${file.hits.length}`).join("\n");
    return success("search.text", limited.map((file) => file.path), {
      preview: boundedText(preview, limitBytes),
      metadata: { pattern: parsed.pattern, count: limited.length, outputMode, totalHits: limited.reduce((acc, file) => acc + file.hits.length, 0) },
      replay: replay(context)
    });
  }
  if (outputMode === "content") {
    const segments: string[] = [];
    for (const file of limited) {
      const lines = (await platformAsRegex.readFile?.(file.path).catch(() => ""))?.split(/\r?\n/) ?? [];
      for (const hit of file.hits) {
        const start = Math.max(0, hit.line - 1 - contextLines);
        const end = Math.min(lines.length, hit.line + contextLines);
        const slice = lines.slice(start, end).map((text, index) => `${file.displayPath}:${start + index + 1}: ${text}`);
        segments.push(slice.join("\n"));
      }
    }
    return success("search.text", limited.map((file) => file.path), {
      preview: boundedText(segments.join("\n--\n"), limitBytes),
      metadata: { pattern: parsed.pattern, count: limited.length, outputMode, contextLines },
      replay: replay(context)
    });
  }
  return success("search.text", limited.map((file) => file.path), {
    preview: boundedText(limited.map((file) => file.displayPath).join("\n"), limitBytes),
    metadata: { pattern: parsed.pattern, count: limited.length, outputMode },
    replay: replay(context)
  });
}

function matchLineByLine(content: string, regex: RegExp): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    if (regex.test(text)) hits.push({ line: index + 1, text });
  }
  return hits;
}

function matchMultiline(content: string, regex: RegExp): Array<{ line: number; text: string }> {
  const global = new RegExp(regex.source, `${regex.flags.includes("g") ? regex.flags : `${regex.flags}g`}`);
  const hits: Array<{ line: number; text: string }> = [];
  const lines = content.split(/\r?\n/);
  let match: RegExpExecArray | null;
  while ((match = global.exec(content)) !== null) {
    const upto = content.slice(0, match.index);
    const line = upto.split(/\r?\n/).length;
    hits.push({ line, text: lines[line - 1] ?? match[0] });
    if (match.index === global.lastIndex) global.lastIndex += 1;
  }
  return hits;
}

function matchesGlob(filePath: string, glob: string): boolean {
  if (!glob) return true;
  const normalized = filePath.replace(/\\/g, "/");
  const regex = new RegExp(`^${globToRegexSource(glob)}$`);
  return regex.test(normalized) || regex.test(normalized.split("/").pop() ?? "");
}

function globToRegexSource(glob: string): string {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === "*" && next === "*" && glob[index + 2] === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegexChar(char);
  }
  return source;
}

function escapeRegexChar(char: string | undefined): string {
  if (!char) return "";
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}
