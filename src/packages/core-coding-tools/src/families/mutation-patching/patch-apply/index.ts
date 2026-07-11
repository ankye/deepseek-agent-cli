import type {
  CapabilityExecutionContext,
  CoreCodingToolName,
  CoreToolDiagnostic,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, diag, failure, objectSchema, replay, success, undefinedError, isDiagnostic } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { editTransaction, invalidateCodeIntelligence, publicTransactionEvidence, requireDeps, resolveToolPath, toWorkspaceTransaction } from "../../../shared/workspace.js";
import { pythonSyntaxDiagnostic } from "../../../shared/python-syntax.js";

const TOOL_NAME = "patch.apply" as CoreCodingToolName;

interface PatchApplyInput extends JsonObject {
  readonly patch: string;
  readonly workspaceRoot?: string;
  readonly dryRun?: boolean;
  readonly limitBytes?: number;
}

interface ParsedPatchFile {
  readonly path: string;
  readonly hunks: readonly ParsedHunk[];
}

interface ParsedHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly string[];
}

interface PlannedPatch {
  readonly file: ParsedPatchFile;
  readonly absolutePath: string;
  readonly before: string;
  readonly after: string;
}

interface PatchApplyFailure {
  readonly message: string;
  readonly hunk?: ParsedHunk;
  readonly details?: JsonObject;
}

export function definePatchApplyTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    TOOL_NAME,
    coreToolIds.patchApply,
    "Patch Apply",
    "write",
    ["workspace:write"],
    objectSchema(["patch"], {
      patch: { type: "string" },
      workspaceRoot: { type: "string" },
      dryRun: { type: "boolean" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => patchApplyTool(input, context, ready))
  );
}

async function patchApplyTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as PatchApplyInput;
  const files = parseUnifiedPatch(parsed.patch);
  if (files instanceof Error) {
    const diagnostic = patchParseDiagnostic(files.message, parsed.patch);
    return failure(TOOL_NAME, "PATCH_PARSE_FAILED", files.message, [], {
      diagnostic,
      patchBytes: Buffer.byteLength(parsed.patch ?? "", "utf8")
    });
  }
  const plans: PlannedPatch[] = [];
  const diagnostics: CoreToolDiagnostic[] = [];

  for (const file of files) {
    const path = resolveToolPath(deps, parsed.workspaceRoot, file.path);
    if (!path.ok || !path.value) return failure(TOOL_NAME, "PATH_REJECTED", path.error?.message ?? "Path rejected.", [file.path]);
    const before = await deps.platform.readFile(path.value.path).catch((error: unknown) => undefinedError(error, "PATCH_READ_FAILED"));
    if (isDiagnostic(before)) return failure(TOOL_NAME, before.code, before.message, [path.value.path]);
    const after = applyHunks(before, file.hunks);
    if (isPatchApplyFailure(after)) {
      diagnostics.push({
        ...diag("PATCH_PRECONDITION_FAILED", `${file.path}: ${after.message}`, patchPreconditionSuggestedActions(after.details !== undefined)),
        ...(after.details ? { details: { path: file.path, ...after.details } } : { details: { path: file.path } })
      });
      continue;
    }
    if (after === before || codePatchOnlyChangesTrailingWhitespace(file.path, before, after)) {
      diagnostics.push({
        ...diag("PATCH_NOOP", `${file.path}: Patch would leave the file unchanged.`),
        details: { path: file.path }
      });
      continue;
    }
    const syntaxDiagnostic = pythonSyntaxDiagnostic(path.value.path, after);
    if (syntaxDiagnostic) {
      diagnostics.push({
        ...syntaxDiagnostic,
        details: {
          ...(syntaxDiagnostic.details ?? {}),
          path: file.path
        }
      });
      continue;
    }
    plans.push({ file, absolutePath: path.value.path, before, after });
  }

  if (diagnostics.length > 0) {
    return failure(TOOL_NAME, diagnostics[0]?.code ?? "PATCH_PRECONDITION_FAILED", diagnostics[0]?.message ?? "Patch precondition failed.", plans.map((plan) => plan.absolutePath), {
      ...(diagnostics[0] ? { diagnostic: diagnostics[0] } : {}),
      diagnostics: diagnostics.slice(0, 20),
      affectedFileCount: files.length,
      applied: false
    });
  }

  if (parsed.dryRun === true) {
    return success(TOOL_NAME, plans.map((plan) => plan.absolutePath), {
      preview: boundedText(plans.map((plan) => `${plan.file.path}: ${plan.file.hunks.length} hunks`).join("\n"), parsed.limitBytes),
      metadata: { dryRun: true, affectedFileCount: plans.length, hunkCount: plans.reduce((count, plan) => count + plan.file.hunks.length, 0), applied: false },
      replay: replay(context),
      status: "completed"
    });
  }

  const transactions: JsonObject[] = [];
  const checkpoints: JsonObject[] = [];
  for (const plan of plans) {
    await deps.platform.writeFile(plan.absolutePath, plan.after);
    const transaction = editTransaction(context, plan.absolutePath, "full-write", plan.before, plan.after, true, []);
    const workspaceTransaction = await deps.workspaceState.transact(toWorkspaceTransaction(transaction, plan.before));
    transactions.push(publicTransactionEvidence(transaction, workspaceTransaction));
    if (workspaceTransaction.checkpoints[0]) checkpoints.push(workspaceTransaction.checkpoints[0]);
    invalidateCodeIntelligence(deps, plan.absolutePath);
  }

  return success(TOOL_NAME, plans.map((plan) => plan.absolutePath), {
    preview: boundedText(plans.map((plan) => `${plan.file.path}: ${plan.file.hunks.length} hunks applied`).join("\n"), parsed.limitBytes),
    metadata: {
      dryRun: false,
      applied: true,
      affectedFileCount: plans.length,
      hunkCount: plans.reduce((count, plan) => count + plan.file.hunks.length, 0),
      transactions,
      checkpoints
    },
    replay: replay(context)
  });
}

function codePatchOnlyChangesTrailingWhitespace(path: string, before: string, after: string): boolean {
  if (!/\.(?:c|cc|cpp|cxx|cs|css|go|h|hpp|hxx|html|htm|java|js|jsx|json|jsonc|kt|kts|less|php|ps1|py|rb|rs|sass|scala|scss|sh|sql|svelte|swift|toml|ts|tsx|vue|xml|yaml|yml)$/i.test(path)) {
    return false;
  }
  return stripTrailingWhitespace(before) === stripTrailingWhitespace(after);
}

function stripTrailingWhitespace(value: string): string {
  return value.replace(/[ \t]+(?=\r?\n|$)/g, "");
}

function parseUnifiedPatch(patch: string): readonly ParsedPatchFile[] | Error {
  if (typeof patch !== "string" || patch.trim().length === 0) return new Error("Patch input is empty.");
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: ParsedPatchFile[] = [];
  let index = 0;
  while (index < lines.length) {
    while (index < lines.length && !lines[index]!.startsWith("--- ")) index += 1;
    if (index >= lines.length) break;
    const oldHeader = lines[index++]!;
    if (index >= lines.length || !lines[index]!.startsWith("+++ ")) return new Error("Unified patch file header must contain +++ after ---.");
    const newHeader = lines[index++]!;
    const path = normalizePatchPath(newHeader.slice(4).trim()) || normalizePatchPath(oldHeader.slice(4).trim());
    if (!path || path === "/dev/null") return new Error("Patch target path is unsupported.");
    const hunks: ParsedHunk[] = [];
    while (index < lines.length && !lines[index]!.startsWith("--- ")) {
      if (!lines[index]!.startsWith("@@ ")) {
        index += 1;
        continue;
      }
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index++]!);
      if (!header) return new Error("Patch hunk header is malformed.");
      const hunkLines: string[] = [];
      while (index < lines.length && !lines[index]!.startsWith("@@ ") && !lines[index]!.startsWith("--- ")) {
        const line = lines[index++]!;
        if (line === "") break;
        if (line.startsWith("\\ No newline")) continue;
        if (!/^[ +\-]/.test(line)) return new Error("Patch hunk line must start with space, +, or -.");
        hunkLines.push(line);
      }
      hunks.push({
        oldStart: Number(header[1]),
        oldCount: Number(header[2] ?? "1"),
        newStart: Number(header[3]),
        newCount: Number(header[4] ?? "1"),
        lines: hunkLines
      });
    }
    if (hunks.length === 0) return new Error(`Patch file ${path} does not contain hunks.`);
    files.push({ path, hunks });
  }
  return files.length > 0 ? files : new Error("No unified patch file entries were found.");
}

function applyHunks(content: string, hunks: readonly ParsedHunk[]): string | PatchApplyFailure {
  const hadFinalNewline = content.endsWith("\n");
  const sourceLines = hadFinalNewline ? content.slice(0, -1).split("\n") : content.split("\n");
  const result: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const oldLines = hunk.lines.filter((line) => line.startsWith(" ") || line.startsWith("-")).map((line) => line.slice(1));
    const newLines = hunk.lines.filter((line) => line.startsWith(" ") || line.startsWith("+")).map((line) => line.slice(1));
    const declaredStart = Math.max(0, hunk.oldStart - 1);
    const resolvedStart = resolveHunkStart(sourceLines, oldLines, declaredStart, cursor);
    if (isPatchApplyFailure(resolvedStart)) return resolvedStart;
    const start = resolvedStart;
    const actual = sourceLines.slice(start, start + oldLines.length);
    if (actual.join("\n") !== oldLines.join("\n")) {
      return {
        message: `hunk at -${hunk.oldStart},${hunk.oldCount} did not match target content`,
        hunk,
        details: hunkMismatchDetails(sourceLines, hunk, oldLines, actual)
      };
    }
    result.push(...sourceLines.slice(cursor, start), ...newLines);
    cursor = start + oldLines.length;
  }
  result.push(...sourceLines.slice(cursor));
  return `${result.join("\n")}${hadFinalNewline ? "\n" : ""}`;
}

function resolveHunkStart(
  sourceLines: readonly string[],
  oldLines: readonly string[],
  declaredStart: number,
  cursor: number
): number | PatchApplyFailure {
  if (oldLines.length === 0) {
    if (declaredStart < cursor) return { message: `hunk at -${declaredStart + 1} overlaps a previous hunk` };
    return declaredStart;
  }
  const declaredActual = sourceLines.slice(declaredStart, declaredStart + oldLines.length);
  if (declaredStart >= cursor && declaredActual.join("\n") === oldLines.join("\n")) return declaredStart;
  const matches: number[] = [];
  const expected = oldLines.join("\n");
  for (let start = cursor; start <= sourceLines.length - oldLines.length; start += 1) {
    if (sourceLines.slice(start, start + oldLines.length).join("\n") === expected) {
      matches.push(start);
      if (matches.length > 1) break;
    }
  }
  if (matches.length === 1) return matches[0]!;
  if (declaredStart < cursor) return { message: `hunk at -${declaredStart + 1} overlaps a previous hunk` };
  if (matches.length > 1) return { message: `hunk at -${declaredStart + 1} has ambiguous context matches` };
  return declaredStart;
}

function isPatchApplyFailure(value: unknown): value is PatchApplyFailure {
  return typeof value === "object" && value !== null && "message" in value;
}

function hunkMismatchDetails(
  sourceLines: readonly string[],
  hunk: ParsedHunk,
  expectedLines: readonly string[],
  actualLines: readonly string[]
): JsonObject {
  const nearest = nearestPatchContext(sourceLines, expectedLines, hunk.oldStart);
  return {
    operation: "unified-patch",
    hunkOldStart: hunk.oldStart,
    hunkOldCount: hunk.oldCount,
    hunkNewStart: hunk.newStart,
    hunkNewCount: hunk.newCount,
    expectedContext: boundedText(expectedLines.join("\n"), 4_000).text,
    actualAtDeclaredLocation: boundedText(actualLines.join("\n"), 4_000).text,
    ...nearest
  };
}

function nearestPatchContext(
  sourceLines: readonly string[],
  expectedLines: readonly string[],
  declaredOldStart: number
): JsonObject {
  const expectedTerms = termsForLines(expectedLines);
  const scanWindowSize = Math.min(Math.max(expectedLines.length, 3), 12);
  let bestStart = Math.max(0, declaredOldStart - 1);
  let bestScore = 0;
  for (let start = 0; start < sourceLines.length; start += 1) {
    const windowTerms = termsForLines(sourceLines.slice(start, start + scanWindowSize));
    let score = 0;
    for (const term of expectedTerms) {
      if (windowTerms.has(term)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  const contextStart = Math.max(0, bestStart - 3);
  const contextEnd = Math.min(sourceLines.length, bestStart + scanWindowSize + 3);
  const nearestContext = boundedText(sourceLines.slice(contextStart, contextEnd).join("\n"), 4_000).text;
  return {
    nearestContext,
    nearestContextStartLine: contextStart + 1,
    nearestContextLineCount: nearestContext.length > 0 ? nearestContext.split(/\r?\n/).length : 0,
    nearestContextScore: bestScore
  };
}

function patchPreconditionSuggestedActions(hasNearestContext: boolean): readonly string[] {
  if (hasNearestContext) {
    return [
      "Use actualAtDeclaredLocation as the current source context at the declared hunk location; retry patch.apply with corrected context or use file.edit for a small exact change.",
      "Use nearestContext only if the intended target is elsewhere, and verify it against current source evidence before retrying."
    ];
  }
  return [
    "Correct the unified patch hunk headers and context lines, then retry patch.apply.",
    "If the target context is uncertain, use file.edit with exact expected text from prior file evidence."
  ];
}

function patchParseDiagnostic(message: string, patch: string): CoreToolDiagnostic {
  return {
    ...diag("PATCH_PARSE_FAILED", message, [
      "Retry patch.apply with a complete unified diff, including --- a/<workspace-relative-path> and +++ b/<workspace-relative-path> file headers.",
      "Include at least one @@ -oldStart,oldCount +newStart,newCount @@ hunk under each file header.",
      "For a single-file change, reuse the workspace-relative path from prior file evidence in both file headers."
    ]),
    details: {
      operation: "unified-patch-parse",
      requiredPatchShape: [
        "--- a/<workspace-relative-path>",
        "+++ b/<workspace-relative-path>",
        "@@ -oldStart,oldCount +newStart,newCount @@",
        " context line",
        "-old line",
        "+new line"
      ].join("\n"),
      receivedPatchPrefix: boundedText(patch ?? "", 1_200).text
    }
  };
}

function termsForLines(lines: readonly string[]): Set<string> {
  const terms = new Set<string>();
  for (const line of lines) {
    for (const token of line.match(/[A-Za-z_][A-Za-z0-9_]{2,}|[0-9]+/g) ?? []) {
      terms.add(token);
    }
  }
  return terms;
}

function normalizePatchPath(headerPath: string): string | undefined {
  const path = headerPath.split(/\s+/)[0] ?? "";
  if (path === "/dev/null") return path;
  return path.replace(/^[ab]\//, "").replace(/\\/g, "/");
}
