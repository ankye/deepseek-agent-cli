import type {
  CapabilityExecutionContext,
  CoreToolResult,
  FileWriteInput,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { dirname } from "node:path";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { editTransaction, invalidateCodeIntelligence, publicTransactionEvidence, requireDeps, resolveToolPath, toWorkspaceTransaction } from "../../../shared/workspace.js";

export function defineFileWriteTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "file.write",
    coreToolIds.fileWrite,
    "File Write",
    "write",
    ["workspace:write"],
    objectSchema(["path", "content"], { path: { type: "string" }, content: { type: "string" }, workspaceRoot: { type: "string" }, limitBytes: { type: "number" } }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => writeFileTool(input, context, ready))
  );
}

async function writeFileTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as FileWriteInput;
  if (typeof parsed.path !== "string" || typeof parsed.content !== "string" || (parsed.workspaceRoot !== undefined && typeof parsed.workspaceRoot !== "string")) {
    return failure("file.write", "FILE_WRITE_INPUT_INVALID", "file.write requires string path and content fields.", [], {
      receivedKeys: Object.keys(input).sort()
    });
  }
  const path = resolveToolPath(deps, parsed.workspaceRoot, parsed.path);
  if (!path.ok || !path.value) return failure("file.write", "PATH_REJECTED", path.error?.message ?? "Path rejected.", [String(parsed.path ?? "")]);
  const before = await deps.platform.readFile(path.value.path).catch(() => "");
  await deps.platform.ensureDirectory(dirname(path.value.path));
  await deps.platform.writeFile(path.value.path, parsed.content);
  const transaction = editTransaction(context, path.value.path, "full-write", before, parsed.content, true, []);
  const workspaceTransaction = await deps.workspaceState.transact(toWorkspaceTransaction(transaction, before));
  invalidateCodeIntelligence(deps, path.value.path);
  return success("file.write", [path.value.path], {
    preview: boundedText(parsed.content, parsed.limitBytes),
    metadata: { transaction: publicTransactionEvidence(transaction, workspaceTransaction), checkpoint: workspaceTransaction.checkpoints[0] },
    replay: replay(context)
  });
}
