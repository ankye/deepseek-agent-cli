import type {
  CapabilityExecutionContext,
  CoreToolResult,
  FileEditInput,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, diag, failure, isDiagnostic, objectSchema, replay, success, undefinedError } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { countOccurrences, editTransaction, invalidateCodeIntelligence, publicTransactionEvidence, requireDeps, resolveToolPath, toWorkspaceTransaction } from "../../../shared/workspace.js";
import { pythonSyntaxDiagnostic } from "../../../shared/python-syntax.js";

export function defineFileEditTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "file.edit",
    coreToolIds.fileEdit,
    "File Edit",
    "write",
    ["workspace:write"],
    objectSchema(["path", "expected", "replacement"], { path: { type: "string" }, expected: { type: "string" }, replacement: { type: "string" }, workspaceRoot: { type: "string" }, limitBytes: { type: "number" } }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => editFileTool(input, context, ready))
  );
}

async function editFileTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as FileEditInput;
  const path = resolveToolPath(deps, parsed.workspaceRoot, parsed.path);
  if (!path.ok || !path.value) return failure("file.edit", "PATH_REJECTED", path.error?.message ?? "Path rejected.", [String(parsed.path ?? "")]);
  const before = await deps.platform.readFile(path.value.path).catch((error: unknown) => undefinedError(error, "READ_FAILED"));
  if (isDiagnostic(before)) return failure("file.edit", before.code, before.message, [path.value.path]);
  const occurrences = countOccurrences(before, parsed.expected);
  if (occurrences !== 1) {
    const nearestContext = nearestEditContext(before, parsed.expected);
    const diagnostic = {
      ...diag("EDIT_PRECONDITION_FAILED", `Expected text must appear exactly once; found ${occurrences}.`, editPreconditionSuggestedActions(nearestContext !== undefined)),
      details: {
        operation: "exact-match",
        occurrences,
        expectedLineCount: parsed.expected.split(/\r?\n/).length,
        expectedByteLength: Buffer.byteLength(parsed.expected, "utf8"),
        ...(nearestContext ? nearestContext : {})
      }
    };
    const transaction = editTransaction(context, path.value.path, "exact-match", before, before, false, [diagnostic]);
    return failure("file.edit", diagnostic.code, diagnostic.message, [path.value.path], { transaction, diagnostic });
  }
  const after = before.replace(parsed.expected, parsed.replacement);
  if (after === before) {
    const diagnostic = diag("EDIT_NOOP", "Replacement would leave the file unchanged.");
    const transaction = editTransaction(context, path.value.path, "exact-match", before, before, false, [diagnostic]);
    return failure("file.edit", diagnostic.code, diagnostic.message, [path.value.path], { transaction });
  }
  const syntaxDiagnostic = pythonSyntaxDiagnostic(path.value.path, after);
  if (syntaxDiagnostic) {
    const transaction = editTransaction(context, path.value.path, "exact-match", before, before, false, [syntaxDiagnostic]);
    return failure("file.edit", syntaxDiagnostic.code, syntaxDiagnostic.message, [path.value.path], { transaction, diagnostic: syntaxDiagnostic });
  }
  await deps.platform.writeFile(path.value.path, after);
  const transaction = editTransaction(context, path.value.path, "exact-match", before, after, true, []);
  const workspaceTransaction = await deps.workspaceState.transact(toWorkspaceTransaction(transaction, before));
  invalidateCodeIntelligence(deps, path.value.path);
  return success("file.edit", [path.value.path], {
    preview: boundedText(after, parsed.limitBytes),
    metadata: { transaction: publicTransactionEvidence(transaction, workspaceTransaction), checkpoint: workspaceTransaction.checkpoints[0], changedRanges: [{ start: before.indexOf(parsed.expected), oldLength: parsed.expected.length, newLength: parsed.replacement.length }] },
    replay: replay(context)
  });
}

function nearestEditContext(content: string, expected: string): JsonObject | undefined {
  const contentLines = content.split(/\r?\n/);
  const expectedLines = expected.split(/\r?\n/);
  const expectedTerms = termsForLines(expectedLines);
  if (expectedTerms.size === 0 || contentLines.length === 0) return undefined;
  const scanWindowSize = Math.min(Math.max(expectedLines.length, 3), 8);
  let bestStart = 0;
  let bestScore = 0;
  for (let start = 0; start < contentLines.length; start += 1) {
    const windowTerms = termsForLines(contentLines.slice(start, start + scanWindowSize));
    let score = 0;
    for (const term of expectedTerms) {
      if (windowTerms.has(term)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  if (bestScore === 0) return undefined;
  const contextStart = Math.max(0, bestStart - expectedLines.length);
  const contextEnd = Math.min(contentLines.length, bestStart + scanWindowSize + expectedLines.length);
  const nearestContext = boundedText(contentLines.slice(contextStart, contextEnd).join("\n"), 4_000).text;
  return {
    nearestContext,
    nearestContextStartLine: contextStart + 1,
    nearestContextLineCount: nearestContext.split(/\r?\n/).length,
    nearestContextScore: bestScore
  };
}

function editPreconditionSuggestedActions(hasNearestContext: boolean): readonly string[] {
  if (hasNearestContext) {
    return [
      "Use nearestContext as the current exact file context and retry file.edit with corrected expected text.",
      "If exact-match context is unstable, use patch.apply with matching surrounding context from nearestContext."
    ];
  }
  return [
    "Read the target file or a focused window around the intended function, copy the exact current text, then retry file.edit.",
    "If exact-match context is unstable, use patch.apply with matching surrounding context from the latest file contents."
  ];
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
