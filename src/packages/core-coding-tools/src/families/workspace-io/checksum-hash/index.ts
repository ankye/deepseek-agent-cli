import { createHash } from "node:crypto";
import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { isModelVisibleWorkspaceRelativePath, requireDeps, resolveToolPath } from "../../../shared/workspace.js";

type HashAlgorithm = "sha256" | "sha1" | "md5";

interface ChecksumHashInput extends JsonObject {
  readonly path: string;
  readonly algorithm?: HashAlgorithm;
  readonly workspaceRoot?: string;
  readonly limitBytes?: number;
}

export function defineChecksumHashTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "checksum.hash",
    coreToolIds.checksumHash,
    "Checksum Hash",
    "read",
    ["workspace:read"],
    objectSchema(["path"], {
      path: { type: "string" },
      algorithm: { type: "string" },
      workspaceRoot: { type: "string" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => checksumHashTool(input, context, ready))
  );
}

async function checksumHashTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as ChecksumHashInput;
  const algorithm = parsed.algorithm ?? "sha256";
  if (!["sha256", "sha1", "md5"].includes(algorithm)) return failure("checksum.hash", "HASH_ALGORITHM_UNSUPPORTED", "Supported hash algorithms are sha256, sha1, and md5.", [String(parsed.path ?? "")], { algorithm: String(algorithm) });
  const path = resolveToolPath(deps, parsed.workspaceRoot, parsed.path);
  if (!path.ok || !path.value) return failure("checksum.hash", "PATH_REJECTED", path.error?.message ?? "Path rejected.", [String(parsed.path ?? "")]);
  if (!isModelVisibleWorkspaceRelativePath(path.value.relativePath)) {
    return failure("checksum.hash", "INTERNAL_ARTIFACT_REJECTED", "Internal evaluation artifacts are not model-visible through checksum.hash.", [path.value.path]);
  }
  const content = await deps.platform.readFile(path.value.path).catch((error: unknown) => error instanceof Error ? error : new Error("File hash read failed."));
  if (content instanceof Error) return failure("checksum.hash", "HASH_READ_FAILED", content.message, [path.value.path]);
  const digest = createHash(algorithm).update(content, "utf8").digest("hex");
  return success("checksum.hash", [path.value.path], {
    preview: boundedText(`${algorithm} ${digest} ${path.value.relativePath}`, parsed.limitBytes),
    metadata: {
      path: path.value.path,
      relativePath: path.value.relativePath,
      algorithm,
      digest,
      byteLength: Buffer.byteLength(content, "utf8")
    },
    replay: replay(context)
  });
}
