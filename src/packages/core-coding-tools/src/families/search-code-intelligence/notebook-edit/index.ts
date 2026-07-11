import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { editTransaction, invalidateCodeIntelligence, publicTransactionEvidence, requireDeps, resolveToolPath, toWorkspaceTransaction } from "../../../shared/workspace.js";

interface NotebookEditInput extends JsonObject {
  readonly path: string;
  readonly workspaceRoot?: string;
  readonly cellIndex: number;
  readonly source: string;
  readonly limitBytes?: number;
}

interface NotebookCell {
  readonly source?: unknown;
}

export function defineNotebookEditTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "notebook.edit",
    coreToolIds.notebookEdit,
    "Notebook Edit",
    "write",
    ["workspace:write"],
    objectSchema(["path", "cellIndex", "source"], {
      path: { type: "string" },
      workspaceRoot: { type: "string" },
      cellIndex: { type: "number" },
      source: { type: "string" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => notebookEditTool(input, context, ready))
  );
}

async function notebookEditTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as NotebookEditInput;
  if (typeof parsed.path !== "string" || typeof parsed.source !== "string" || !Number.isInteger(parsed.cellIndex)) {
    return failure("notebook.edit", "NOTEBOOK_EDIT_INPUT_INVALID", "notebook.edit requires path, integer cellIndex, and source.", []);
  }
  const path = resolveToolPath(deps, parsed.workspaceRoot, parsed.path);
  if (!path.ok || !path.value) return failure("notebook.edit", "PATH_REJECTED", path.error?.message ?? "Path rejected.", [String(parsed.path ?? "")]);
  if (!path.value.path.toLowerCase().endsWith(".ipynb")) return failure("notebook.edit", "NOTEBOOK_EXTENSION_UNSUPPORTED", "Notebook editor only accepts .ipynb files.", [path.value.path]);

  const before = await deps.platform.readFile(path.value.path).catch((error: unknown) => error instanceof Error ? error : new Error("Notebook read failed."));
  if (before instanceof Error) return failure("notebook.edit", "NOTEBOOK_READ_FAILED", before.message, [path.value.path]);
  const notebook = parseNotebook(before);
  if (notebook instanceof Error) return failure("notebook.edit", "NOTEBOOK_MALFORMED", notebook.message, [path.value.path], { byteLength: Buffer.byteLength(before, "utf8") });
  const cells = notebook.cells as unknown as readonly NotebookCell[];
  const cell = cells[parsed.cellIndex];
  if (!cell) return failure("notebook.edit", "NOTEBOOK_CELL_NOT_FOUND", "cellIndex is outside the notebook cells array.", [path.value.path], { cellIndex: parsed.cellIndex, cellCount: cells.length });

  const nextCell = { ...cell, source: sourceLike(cell.source, parsed.source) };
  const nextNotebook = { ...notebook, cells: cells.map((candidate, index) => index === parsed.cellIndex ? nextCell : candidate) };
  const after = `${JSON.stringify(nextNotebook, null, 2)}\n`;
  if (after === before) return failure("notebook.edit", "NOTEBOOK_EDIT_UNCHANGED", "Notebook edit would leave the file unchanged.", [path.value.path], { cellIndex: parsed.cellIndex });

  await deps.platform.writeFile(path.value.path, after);
  const transaction = editTransaction(context, path.value.path, "full-write", before, after, true, []);
  const workspaceTransaction = await deps.workspaceState.transact(toWorkspaceTransaction(transaction, before));
  invalidateCodeIntelligence(deps, path.value.path);
  return success("notebook.edit", [path.value.path], {
    preview: boundedText(parsed.source, parsed.limitBytes ?? 8_000),
    metadata: {
      path: path.value.path,
      relativePath: path.value.relativePath,
      cellIndex: parsed.cellIndex,
      cellCount: cells.length,
      transaction: publicTransactionEvidence(transaction, workspaceTransaction),
      checkpoint: workspaceTransaction.checkpoints[0]
    },
    replay: replay(context)
  });
}

function parseNotebook(raw: string): JsonObject | Error {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || !Array.isArray((value as { cells?: unknown }).cells)) {
      return new Error("Notebook JSON must contain a cells array.");
    }
    return value as JsonObject;
  } catch (error) {
    return error instanceof Error ? error : new Error("Notebook JSON parse failed.");
  }
}

function sourceLike(previous: unknown, source: string): string | readonly string[] {
  if (Array.isArray(previous)) return sourceToLines(source);
  return source;
}

function sourceToLines(source: string): readonly string[] {
  if (source.length === 0) return [];
  const matches = source.match(/[^\n]*\n|[^\n]+$/g);
  return matches ?? [source];
}
