import type {
  CapabilityExecutionContext,
  CodeIntelligenceService,
  CoreCodingToolName,
  CoreToolDiagnostic,
  CoreToolResult,
  JsonObject,
  PlatformRuntime,
  ProcessResult,
  SerializableResult,
  WorkspaceEditTransaction,
  WorkspaceEditTransactionEvidence,
  WorkspaceStateManager,
  WorkspaceTransactionResult
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import { redactSecretText } from "@deepseek/policy-sandbox";
import { boundedText, replay, success } from "./tool-kit.js";

export interface CoreCodingToolsDependencies {
  readonly platform: PlatformRuntime;
  readonly workspaceState: WorkspaceStateManager;
  readonly workspaceRoot: string;
  readonly codeIntelligence?: CodeIntelligenceService;
}

export async function requireDeps(deps: CoreCodingToolsDependencies | undefined): Promise<CoreCodingToolsDependencies> {
  if (!deps) throw new Error("CORE_TOOL_DEPENDENCIES_REQUIRED");
  return deps;
}

export function resolveToolPath(deps: CoreCodingToolsDependencies, workspaceRoot: string | undefined, path: string) {
  return deps.platform.resolveWorkspacePath(workspaceRoot ?? deps.workspaceRoot, path);
}

export function isModelVisibleWorkspaceRelativePath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path).replace(/^\.\//, "");
  if (hasHiddenModelVisibleSegment(normalized)) return false;
  if (!normalized.startsWith(".deepseek/")) return true;
  return !isInternalEvaluationArtifactPath(normalized);
}

export function workspaceRelativePath(root: string, path: string): string {
  const normalizedRoot = normalizeWorkspacePath(root).replace(/\/$/, "");
  const normalizedPath = normalizeWorkspacePath(path);
  if (normalizedPath === normalizedRoot) return "";
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath;
}

function isInternalEvaluationArtifactPath(path: string): boolean {
  return (
    path === ".deepseek/evaluation-boundary-runs" ||
    path.startsWith(".deepseek/evaluation-boundary-runs/") ||
    path === ".deepseek/swebench-predictions" ||
    path.startsWith(".deepseek/swebench-predictions/") ||
    path === ".deepseek/swebench-reports" ||
    path.startsWith(".deepseek/swebench-reports/") ||
    path === ".deepseek/swebench-runs" ||
    path.startsWith(".deepseek/swebench-runs/") ||
    path === ".deepseek/swebench-venv" ||
    path.startsWith(".deepseek/swebench-venv/") ||
    path === ".deepseek/swe-lite-runs" ||
    path.startsWith(".deepseek/swe-lite-runs/")
  );
}

function hasHiddenModelVisibleSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === ".pytest_cache" || segment === ".venv" || segment === "__pycache__");
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

export function countOccurrences(content: string, expected: string): number {
  if (expected.length === 0) return 0;
  let count = 0;
  let index = 0;
  while ((index = content.indexOf(expected, index)) >= 0) {
    count += 1;
    index += expected.length;
  }
  return count;
}

export function editTransaction(
  context: CapabilityExecutionContext,
  path: string,
  precondition: WorkspaceEditTransactionEvidence["precondition"],
  before: string,
  after: string,
  applied: boolean,
  diagnostics: readonly CoreToolDiagnostic[]
): WorkspaceEditTransactionEvidence {
  return {
    id: `${context.envelope.invocationId}:${path}`,
    ...(context.envelope.sessionId ? { sessionId: context.envelope.sessionId } : {}),
    ...(context.envelope.turnId ? { turnId: context.envelope.turnId } : {}),
    capabilityId: context.envelope.capabilityId,
    path,
    precondition,
    beforeHash: hashText(before),
    afterHash: hashText(after),
    rollback: { content: redactSecretText(before), contentHash: hashText(before) },
    applied,
    diagnostics,
    redaction: { class: "internal", fields: ["path", "rollback.content"] }
  };
}

export function toWorkspaceTransaction(evidence: WorkspaceEditTransactionEvidence, rollbackContent: string): WorkspaceEditTransaction {
  return {
    id: evidence.id,
    sessionId: evidence.sessionId ?? asId<"session">("session-unbound"),
    ...(evidence.turnId ? { turnId: evidence.turnId } : {}),
    requestId: evidence.id,
    edits: [{
      path: evidence.path,
      precondition: evidence.precondition,
      applied: evidence.applied,
      beforeHash: evidence.beforeHash,
      afterHash: evidence.afterHash
    }],
    rollback: {
      content: rollbackContent,
      contentHash: evidence.rollback.contentHash,
      redaction: { class: "sensitive", fields: ["content"] }
    }
  };
}

export function publicTransactionEvidence(evidence: WorkspaceEditTransactionEvidence, result: WorkspaceTransactionResult): WorkspaceEditTransactionEvidence {
  return {
    ...evidence,
    rollback: { contentHash: evidence.rollback.contentHash },
    metadata: {
      checkpointIds: result.checkpoints.map((checkpoint) => checkpoint.checkpointId)
    },
    redaction: { class: "internal", fields: ["path", "rollback.content"] }
  };
}

export function hashText(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function invalidateCodeIntelligence(deps: CoreCodingToolsDependencies, path: string): void {
  void deps.codeIntelligence?.invalidate(path).catch(() => undefined);
}

export function processResultToEvidence(
  toolName: CoreCodingToolName,
  result: ProcessResult,
  cwd: string,
  context: CapabilityExecutionContext,
  limitBytes = 8_000,
  metadata: JsonObject = {}
): SerializableResult<CoreToolResult> {
  const output = result.stdout || result.stderr;
  return success(toolName, [cwd], {
    preview: boundedText(output, limitBytes),
    provider: result.metadata,
    metadata: { ...metadata, cwd, exitCode: result.exitCode, stderrPreview: boundedText(result.stderr, limitBytes) },
    replay: replay(context),
    status: result.exitCode === 0 ? "completed" : "failed"
  });
}
