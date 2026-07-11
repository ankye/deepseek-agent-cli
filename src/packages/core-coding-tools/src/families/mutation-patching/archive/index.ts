import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { invalidateCodeIntelligence, requireDeps, resolveToolPath } from "../../../shared/workspace.js";
import { coreToolIds } from "../../../shared/ids.js";

interface ArchiveCreateInput extends JsonObject {
  readonly format?: "json";
  readonly outputPath: string;
  readonly entries: readonly string[];
  readonly workspaceRoot?: string;
  readonly limitBytes?: number;
}

interface ArchiveExtractInput extends JsonObject {
  readonly format?: "json";
  readonly archivePath: string;
  readonly targetDirectory: string;
  readonly workspaceRoot?: string;
  readonly overwrite?: boolean;
  readonly limitBytes?: number;
}

interface JsonArchive extends JsonObject {
  readonly schemaVersion: "deepseek.archive.v1";
  readonly format: "json";
  readonly entries: readonly JsonArchiveEntry[];
}

interface JsonArchiveEntry extends JsonObject {
  readonly path: string;
  readonly content: string;
}

export function defineArchiveCreateTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "archive.create",
    coreToolIds.archiveCreate,
    "Archive Create",
    "write",
    ["workspace:write"],
    objectSchema(["outputPath", "entries"], {
      format: { type: "string" },
      outputPath: { type: "string" },
      entries: { type: "array" },
      workspaceRoot: { type: "string" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => archiveCreateTool(input, context, ready))
  );
}

export function defineArchiveExtractTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "archive.extract",
    coreToolIds.archiveExtract,
    "Archive Extract",
    "write",
    ["workspace:write"],
    objectSchema(["archivePath", "targetDirectory"], {
      format: { type: "string" },
      archivePath: { type: "string" },
      targetDirectory: { type: "string" },
      workspaceRoot: { type: "string" },
      overwrite: { type: "boolean" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => archiveExtractTool(input, context, ready))
  );
}

async function archiveCreateTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as ArchiveCreateInput;
  if ((parsed.format ?? "json") !== "json") return failure("archive.create", "ARCHIVE_FORMAT_UNSUPPORTED", "Only deterministic json archives are currently supported by archive.create.", [String(parsed.outputPath ?? "")]);
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) return failure("archive.create", "ARCHIVE_ENTRIES_EMPTY", "archive.create requires at least one entry.", [String(parsed.outputPath ?? "")]);
  const output = resolveToolPath(deps, parsed.workspaceRoot, parsed.outputPath);
  if (!output.ok || !output.value) return failure("archive.create", "OUTPUT_PATH_REJECTED", output.error?.message ?? "Output path rejected.", [String(parsed.outputPath ?? "")]);
  const entries: JsonArchiveEntry[] = [];
  for (const entryPath of parsed.entries.map(String)) {
    const entry = resolveToolPath(deps, parsed.workspaceRoot, entryPath);
    if (!entry.ok || !entry.value) return failure("archive.create", "ENTRY_PATH_REJECTED", entry.error?.message ?? "Entry path rejected.", [entryPath]);
    const stat = await deps.platform.statPath(entry.value.path).catch((error: unknown) => error instanceof Error ? error : new Error("Archive stat failed."));
    if (stat instanceof Error) return failure("archive.create", "ARCHIVE_ENTRY_STAT_FAILED", stat.message, [entry.value.path]);
    if (stat.kind !== "file") return failure("archive.create", "ARCHIVE_ENTRY_NOT_FILE", "archive.create currently accepts file entries only.", [entry.value.path], { kind: stat.kind });
    const content = await deps.platform.readFile(entry.value.path).catch((error: unknown) => error instanceof Error ? error : new Error("Archive entry read failed."));
    if (content instanceof Error) return failure("archive.create", "ARCHIVE_ENTRY_READ_FAILED", content.message, [entry.value.path]);
    entries.push({ path: entry.value.relativePath, content });
  }
  const archive: JsonArchive = { schemaVersion: "deepseek.archive.v1", format: "json", entries };
  await deps.platform.ensureDirectory(parentPath(deps, output.value.path));
  await deps.platform.writeFile(output.value.path, `${JSON.stringify(archive, null, 2)}\n`);
  invalidateCodeIntelligence(deps, output.value.path);
  return success("archive.create", [output.value.path, ...entries.map((entry) => entry.path)], {
    preview: boundedText(entries.map((entry) => entry.path).join("\n"), parsed.limitBytes),
    metadata: {
      format: "json",
      outputPath: output.value.path,
      relativePath: output.value.relativePath,
      entryCount: entries.length,
      entries: entries.map((entry) => ({ path: entry.path, byteLength: Buffer.byteLength(entry.content, "utf8") }))
    },
    replay: replay(context)
  });
}

async function archiveExtractTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as ArchiveExtractInput;
  if ((parsed.format ?? "json") !== "json") return failure("archive.extract", "ARCHIVE_FORMAT_UNSUPPORTED", "Only deterministic json archives are currently supported by archive.extract.", [String(parsed.archivePath ?? "")]);
  const archivePath = resolveToolPath(deps, parsed.workspaceRoot, parsed.archivePath);
  if (!archivePath.ok || !archivePath.value) return failure("archive.extract", "ARCHIVE_PATH_REJECTED", archivePath.error?.message ?? "Archive path rejected.", [String(parsed.archivePath ?? "")]);
  const target = resolveToolPath(deps, parsed.workspaceRoot, parsed.targetDirectory);
  if (!target.ok || !target.value) return failure("archive.extract", "TARGET_PATH_REJECTED", target.error?.message ?? "Target directory rejected.", [String(parsed.targetDirectory ?? "")]);
  const raw = await deps.platform.readFile(archivePath.value.path).catch((error: unknown) => error instanceof Error ? error : new Error("Archive read failed."));
  if (raw instanceof Error) return failure("archive.extract", "ARCHIVE_READ_FAILED", raw.message, [archivePath.value.path]);
  const archive = parseArchive(raw);
  if (archive instanceof Error) return failure("archive.extract", "ARCHIVE_PARSE_FAILED", archive.message, [archivePath.value.path]);
  const affected: string[] = [archivePath.value.path];
  for (const entry of archive.entries) {
    const output = resolveToolPath(deps, parsed.workspaceRoot, `${target.value.relativePath}/${entry.path}`);
    if (!output.ok || !output.value) return failure("archive.extract", "ARCHIVE_ENTRY_TARGET_REJECTED", output.error?.message ?? "Archive entry target rejected.", [entry.path]);
    if (parsed.overwrite !== true) {
      const existing = await deps.platform.statPath(output.value.path).catch(() => undefined);
      if (existing) return failure("archive.extract", "ARCHIVE_TARGET_EXISTS", "Archive target exists; set overwrite: true when replacement is intended.", [output.value.path]);
    }
    await deps.platform.ensureDirectory(parentPath(deps, output.value.path));
    await deps.platform.writeFile(output.value.path, entry.content);
    affected.push(output.value.path);
    invalidateCodeIntelligence(deps, output.value.path);
  }
  return success("archive.extract", affected, {
    preview: boundedText(archive.entries.map((entry) => entry.path).join("\n"), parsed.limitBytes),
    metadata: {
      format: "json",
      archivePath: archivePath.value.path,
      targetDirectory: target.value.path,
      entryCount: archive.entries.length,
      entries: archive.entries.map((entry) => ({ path: entry.path, byteLength: Buffer.byteLength(entry.content, "utf8") }))
    },
    replay: replay(context)
  });
}

function parseArchive(raw: string): JsonArchive | Error {
  try {
    const value = JSON.parse(raw) as Partial<JsonArchive>;
    if (value.schemaVersion !== "deepseek.archive.v1" || value.format !== "json" || !Array.isArray(value.entries)) {
      return new Error("Archive is not a deepseek.archive.v1 JSON archive.");
    }
    for (const entry of value.entries) {
      if (typeof entry?.path !== "string" || typeof entry.content !== "string" || entry.path.includes("..") || entry.path.startsWith("/")) {
        return new Error("Archive contains an invalid entry path or content.");
      }
    }
    return value as JsonArchive;
  } catch (error) {
    return error instanceof Error ? error : new Error("Archive parse failed.");
  }
}

function parentPath(_deps: CoreCodingToolsDependencies, path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "." : path.slice(0, index);
}
