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
    const diagnostic = diag("EDIT_PRECONDITION_FAILED", `Expected text must appear exactly once; found ${occurrences}.`);
    const transaction = editTransaction(context, path.value.path, "exact-match", before, before, false, [diagnostic]);
    return failure("file.edit", diagnostic.code, diagnostic.message, [path.value.path], { transaction });
  }
  const after = before.replace(parsed.expected, parsed.replacement);
  if (after === before) {
    const diagnostic = diag("EDIT_NOOP", "Replacement would leave the file unchanged.");
    const transaction = editTransaction(context, path.value.path, "exact-match", before, before, false, [diagnostic]);
    return failure("file.edit", diagnostic.code, diagnostic.message, [path.value.path], { transaction });
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
