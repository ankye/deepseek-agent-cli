import type {
  JsonObject,
  RuntimeEvent,
  StagedTaskStageContract
} from "@deepseek/platform-contracts";
import { isStandardTestCommand } from "@deepseek/core-coding-tools";

export function terminalEvidenceCompleted(terminal: RuntimeEvent): boolean {
  const output = terminal.data.output;
  if (!output || typeof output !== "object") return false;
  const evidence = (output as { readonly evidence?: unknown }).evidence;
  if (!evidence || typeof evidence !== "object") return false;
  return (evidence as { readonly status?: unknown }).status === "completed";
}

export function terminalEvidenceSatisfiesStageProgress(
  stage: StagedTaskStageContract,
  capabilityId: string,
  terminal: RuntimeEvent
): boolean {
  if (!isMutationStageKind(stage.kind) || !isMutationCapability(capabilityId.toLowerCase())) return true;
  const metadata = terminalEvidenceMetadata(terminal);
  if (metadata?.dryRun === true || metadata?.applied === false || metadata?.changed === false) return false;
  const transaction = metadata?.transaction;
  if (transaction && typeof transaction === "object" && (transaction as { readonly changed?: unknown }).changed === false) return false;
  return true;
}

export function stageCanCompleteFromToolEvidence(
  stage: StagedTaskStageContract,
  capabilityId: string,
  toolInput: JsonObject,
  terminal?: RuntimeEvent
): boolean {
  const normalized = capabilityId.toLowerCase();
  switch (stage.kind) {
    case "collect-evidence":
      return isFocusedEvidenceCapability(normalized, toolInput, terminal, stage);
    case "materialize":
    case "repair":
      return isMutationCapability(normalized);
    case "produce":
      return isPlanningStage(stage) || isReadOnlyEvidenceStage(stage)
        ? isPlanningEvidenceCapability(normalized)
        : isMutationCapability(normalized);
    case "verify":
    case "score":
      return isVerificationCapability(normalized, toolInput);
    case "artifact-scan":
      return isArtifactScanCapability(normalized);
    case "synthesize":
      return true;
  }
}

export function toolCommandText(input: JsonObject): string {
  const command = typeof input.command === "string" ? input.command : "";
  const args = Array.isArray(input.args) ? input.args.filter((value): value is string => typeof value === "string") : [];
  return [command, ...args].filter(Boolean).join(" ");
}

function terminalEvidenceMetadata(terminal: RuntimeEvent | undefined): JsonObject | undefined {
  if (!terminal) return undefined;
  const output = terminal.data.output;
  if (!output || typeof output !== "object") return undefined;
  const evidence = (output as { readonly evidence?: unknown }).evidence;
  if (!evidence || typeof evidence !== "object") return undefined;
  const metadata = (evidence as { readonly metadata?: unknown }).metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as JsonObject : undefined;
}

function isMutationStageKind(stageKind: string): boolean {
  return stageKind === "produce" || stageKind === "materialize" || stageKind === "repair";
}

function isFocusedEvidenceCapability(
  capabilityId: string,
  toolInput: JsonObject,
  terminal?: RuntimeEvent,
  stage?: StagedTaskStageContract
): boolean {
  if (!isPlanningEvidenceCapability(capabilityId)) return false;
  if (capabilityId === "core.git.diff" || capabilityId.endsWith(".diff")) return true;
  if (capabilityId === "core.file.read" || capabilityId.endsWith(".read")) {
    return hasFocusedPath(toolInput) &&
      !terminalEvidenceTruncatedForRead(toolInput, terminal) &&
      !stageRejectsHeaderOnlySourceWindow(stage, toolInput, terminal);
  }
  if (capabilityId === "core.file.list" || capabilityId.endsWith(".list")) return false;
  if (capabilityId === "core.search.text" || capabilityId.endsWith(".search")) {
    return hasFocusedSearchInput(toolInput) && !terminalEvidenceEmpty(terminal);
  }
  if (capabilityId === "core.workspace.glob" || capabilityId.endsWith(".glob")) return false;
  return true;
}

function stageRejectsHeaderOnlySourceWindow(
  stage: StagedTaskStageContract | undefined,
  toolInput: JsonObject,
  terminal: RuntimeEvent | undefined
): boolean {
  if (stage?.parameters?.requireNonHeaderSourceWindow !== true) return false;
  const metadata = terminalEvidenceMetadata(terminal);
  const startLine = typeof metadata?.startLine === "number" ? metadata.startLine : undefined;
  const totalLines = typeof metadata?.totalLines === "number" ? metadata.totalLines : undefined;
  const truncatedLines = metadata?.truncatedLines === true;
  const offset = nonNegativeNumberField(toolInput, "offset");
  if (!truncatedLines || totalLines === undefined || totalLines <= 0) return false;
  const startsAtHeader = (startLine !== undefined && startLine <= 5) || (offset !== undefined && offset <= 5);
  return startsAtHeader;
}

function hasFocusedPath(input: JsonObject): boolean {
  const path = stringField(input, "path") ?? stringField(input, "filePath") ?? stringField(input, "targetPath");
  if (!path) return false;
  return !isBroadWorkspacePath(path);
}

function hasFocusedSearchInput(input: JsonObject): boolean {
  const query = stringField(input, "query") ?? stringField(input, "pattern") ?? stringField(input, "text");
  if (!query || query.trim().length < 2) return false;
  const path = stringField(input, "path") ?? stringField(input, "root") ?? stringField(input, "cwd");
  return path === undefined || !isBroadWorkspacePath(path);
}

function terminalEvidenceTruncatedForRead(toolInput: JsonObject, terminal: RuntimeEvent | undefined): boolean {
  if (!terminal) return false;
  const output = terminal.data.output;
  if (!output || typeof output !== "object") return false;
  const evidence = (output as { readonly evidence?: unknown }).evidence;
  if (!evidence || typeof evidence !== "object") return false;
  const record = evidence as { readonly preview?: unknown; readonly metadata?: unknown };
  if (record.preview && typeof record.preview === "object" && (record.preview as { readonly truncated?: unknown }).truncated === true) {
    return !boundedReadPreviewCoversRequestedWindow(toolInput, record.preview);
  }
  if (!boundedReadRequested(toolInput) || !terminalEvidencePreviewHasContent(record.preview)) {
    return record.metadata !== undefined &&
      typeof record.metadata === "object" &&
      (record.metadata as { readonly truncatedLines?: unknown }).truncatedLines === true;
  }
  return false;
}

function boundedReadRequested(input: JsonObject): boolean {
  return nonNegativeNumberField(input, "offset") !== undefined || nonNegativeNumberField(input, "limit") !== undefined;
}

function boundedReadPreviewCoversRequestedWindow(input: JsonObject, preview: unknown): boolean {
  const limit = nonNegativeNumberField(input, "limit");
  if (limit === undefined || limit === 0) return false;
  if (!preview || typeof preview !== "object") return false;
  const lineCount = (preview as { readonly lineCount?: unknown }).lineCount;
  return typeof lineCount === "number" && Number.isFinite(lineCount) && lineCount >= limit;
}

function nonNegativeNumberField(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function terminalEvidencePreviewHasContent(preview: unknown): boolean {
  if (!preview || typeof preview !== "object") return false;
  const record = preview as {
    readonly text?: unknown;
    readonly lineCount?: unknown;
    readonly byteLength?: unknown;
  };
  if (typeof record.text === "string" && record.text.trim().length > 0) return true;
  if (typeof record.lineCount === "number" && record.lineCount > 0) return true;
  if (typeof record.byteLength === "number" && record.byteLength > 0) return true;
  return false;
}

function terminalEvidenceEmpty(terminal: RuntimeEvent | undefined): boolean {
  if (!terminal) return false;
  const output = terminal.data.output;
  if (!output || typeof output !== "object") return false;
  const evidence = (output as { readonly evidence?: unknown }).evidence;
  if (!evidence || typeof evidence !== "object") return false;
  const record = evidence as { readonly preview?: unknown; readonly metadata?: unknown };
  if (record.preview && typeof record.preview === "object") {
    const preview = record.preview as {
      readonly text?: unknown;
      readonly lineCount?: unknown;
      readonly byteLength?: unknown;
    };
    if (typeof preview.text === "string" && preview.text.trim().length === 0) return true;
    if (preview.lineCount === 0 || preview.byteLength === 0) return true;
  }
  if (record.metadata && typeof record.metadata === "object") {
    const metadata = record.metadata as {
      readonly lineCount?: unknown;
      readonly resultCount?: unknown;
      readonly matchCount?: unknown;
      readonly byteLength?: unknown;
    };
    if (metadata.lineCount === 0 || metadata.resultCount === 0 || metadata.matchCount === 0 || metadata.byteLength === 0) return true;
  }
  return false;
}

function stringField(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function isBroadWorkspacePath(path: string): boolean {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized === "" || normalized === "." || normalized === "./" || normalized === "/" || normalized === "**" || normalized === "**/*";
}

function isPlanningStage(stage: StagedTaskStageContract): boolean {
  const workflowStageId = stage.parameters?.workflowStageId;
  return workflowStageId === "plan" || stage.stageId.toLowerCase() === "stage:plan";
}

function isReadOnlyEvidenceStage(stage: StagedTaskStageContract): boolean {
  const allowedTools = stage.allowedTools ?? [];
  return allowedTools.length > 0 && allowedTools.every((tool) => isPlanningEvidenceCapability(String(tool).toLowerCase()));
}

function isPlanningEvidenceCapability(capabilityId: string): boolean {
  return capabilityId === "core.file.read"
    || capabilityId === "core.file.list"
    || capabilityId === "core.search.text"
    || capabilityId === "core.workspace.glob"
    || capabilityId === "core.git.diff"
    || capabilityId.endsWith(".read")
    || capabilityId.endsWith(".list")
    || capabilityId.endsWith(".search")
    || capabilityId.endsWith(".glob")
    || capabilityId.endsWith(".diff");
}

function isMutationCapability(capabilityId: string): boolean {
  return (
    capabilityId === "core.file.write" ||
    capabilityId === "core.file.edit" ||
    capabilityId === "core.patch.apply" ||
    capabilityId.endsWith(".write") ||
    capabilityId.endsWith(".edit") ||
    capabilityId.endsWith(".apply") ||
    capabilityId.includes("patch.apply")
  );
}

function isVerificationCapability(capabilityId: string, toolInput: JsonObject): boolean {
  if (
    capabilityId === "core.test.run" ||
    capabilityId === "test.run" ||
    capabilityId.endsWith(".test.run")
  ) {
    return isStandardTestCommand(shellCommandText(toolInput));
  }
  if (
    capabilityId === "core.git.diff" ||
    capabilityId.endsWith(".diff") ||
    capabilityId.endsWith(".test")
  ) {
    return true;
  }
  if (capabilityId !== "core.shell.run") return false;
  const command = shellCommandText(toolInput);
  return isStandardTestCommand(command) || /\bgit\s+diff\b/i.test(command);
}

function isArtifactScanCapability(capabilityId: string): boolean {
  return capabilityId === "core.git.diff" || capabilityId.includes("artifact-scan") || capabilityId.endsWith(".diff");
}

function shellCommandText(input: JsonObject): string {
  const command = typeof input.command === "string" ? input.command : "";
  if (!command) return "";
  const args = Array.isArray(input.args) ? input.args.filter((item): item is string => typeof item === "string") : [];
  return [command, ...args].join(" ");
}
