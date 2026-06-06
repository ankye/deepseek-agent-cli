import type {
  CapabilityExecutionContext,
  CoreToolResult,
  FileReadInput,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, isDiagnostic, objectSchema, replay, success, undefinedError } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { isModelVisibleWorkspaceRelativePath, requireDeps, resolveToolPath } from "../../../shared/workspace.js";

const IMAGE_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"]
]);

const IMAGE_MAX_BYTES = 10_000_000;

export function defineFileReadTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "file.read",
    coreToolIds.fileRead,
    "File Read",
    "read",
    ["workspace:read"],
    objectSchema(["path"], {
      path: { type: "string" },
      workspaceRoot: { type: "string" },
      limitBytes: { type: "number" },
      offset: { type: "number" },
      limit: { type: "number" },
      pages: { type: "string" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => readFileTool(input, context, ready))
  );
}

async function readFileTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as FileReadInput;
  const path = resolveToolPath(deps, parsed.workspaceRoot, parsed.path);
  if (!path.ok || !path.value) return failure("file.read", "PATH_REJECTED", path.error?.message ?? "Path rejected.", [String(parsed.path ?? "")]);
  const absolutePath = path.value.path;
  if (!isModelVisibleWorkspaceRelativePath(path.value.relativePath)) {
    return failure("file.read", "INTERNAL_ARTIFACT_REJECTED", "Internal evaluation artifacts are not model-visible through file.read.", [absolutePath]);
  }

  const imageMime = detectImageMime(absolutePath);
  if (imageMime) {
    return readImage(parsed, absolutePath, imageMime, path.value.relativePath, context, deps);
  }

  if (absolutePath.toLowerCase().endsWith(".pdf")) {
    return failure("file.read", "PDF_READER_UNAVAILABLE", "PDF reader not configured for this platform.", [absolutePath]);
  }

  const content = await deps.platform.readFile(absolutePath).catch((error: unknown) => undefinedError(error, "READ_FAILED"));
  if (isDiagnostic(content)) return failure("file.read", content.code, content.message, [absolutePath]);

  const { snippet, startLine, endLine, totalLines, truncatedLines } = sliceLines(content, parsed.offset, parsed.limit);
  return success("file.read", [absolutePath], {
    preview: boundedText(snippet, parsed.limitBytes),
    metadata: {
      path: absolutePath,
      relativePath: path.value.relativePath,
      startLine,
      endLine,
      totalLines,
      nextOffset: truncatedLines ? endLine : totalLines,
      truncatedLines
    },
    replay: replay(context)
  });
}

function detectImageMime(path: string): string | undefined {
  const lower = path.toLowerCase();
  for (const [ext, mime] of IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext)) return mime;
  }
  return undefined;
}

async function readImage(
  parsed: FileReadInput,
  absolutePath: string,
  mime: string,
  relativePath: string,
  context: CapabilityExecutionContext,
  deps: CoreCodingToolsDependencies
): Promise<SerializableResult<CoreToolResult>> {
  const platform = deps.platform as unknown as { readBinaryFile?: (path: string) => Promise<Uint8Array> };
  if (!platform.readBinaryFile) {
    return failure("file.read", "IMAGE_READER_UNAVAILABLE", "Platform does not expose readBinaryFile for image reads.", [absolutePath]);
  }
  try {
    const bytes = await platform.readBinaryFile(absolutePath);
    if (bytes.byteLength > IMAGE_MAX_BYTES) {
      return failure("file.read", "IMAGE_TOO_LARGE", `Image exceeds ${IMAGE_MAX_BYTES} bytes (${bytes.byteLength}).`, [absolutePath]);
    }
    const base64 = Buffer.from(bytes).toString("base64");
    return success("file.read", [absolutePath], {
      preview: boundedText(`[image] ${mime} ${bytes.byteLength}B`, parsed.limitBytes),
      metadata: {
        path: absolutePath,
        relativePath,
        kind: "image",
        mime,
        base64,
        sizeBytes: bytes.byteLength
      },
      replay: replay(context)
    });
  } catch (error) {
    return failure("file.read", "IMAGE_READ_FAILED", error instanceof Error ? error.message : "Image read failed.", [absolutePath]);
  }
}

function sliceLines(content: string, offset: number | undefined, limit: number | undefined): {
  readonly snippet: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly truncatedLines: boolean;
} {
  if (offset === undefined && limit === undefined) {
    const totalLines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
    return { snippet: content, startLine: 0, endLine: totalLines, totalLines, truncatedLines: false };
  }
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  const startLine = Math.max(0, offset ?? 0);
  const effectiveLimit = limit === undefined ? totalLines - startLine : Math.max(0, limit);
  const endLine = Math.min(totalLines, startLine + effectiveLimit);
  const snippet = lines.slice(startLine, endLine).join("\n");
  return { snippet, startLine, endLine, totalLines, truncatedLines: endLine < totalLines };
}
