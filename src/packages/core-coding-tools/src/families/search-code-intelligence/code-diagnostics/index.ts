import type {
  CapabilityExecutionContext,
  CodeIntelligenceService,
  CoreToolResult,
  Diagnostic,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { isModelVisibleWorkspaceRelativePath, requireDeps, workspaceRelativePath } from "../../../shared/workspace.js";

interface CodeDiagnosticsToolDeps extends CoreCodingToolsDependencies {
  readonly codeIntelligence?: CodeIntelligenceService;
}

interface CodeDiagnosticsInput extends JsonObject {
  readonly workspaceRoot?: string;
  readonly limit?: number;
  readonly limitBytes?: number;
  readonly severity?: "error" | "warning" | "info";
}

interface NormalizedDiagnostic extends JsonObject {
  readonly path: string;
  readonly relativePath: string;
  readonly message: string;
  readonly severity: string;
}

export function defineCodeDiagnosticsTool(deps: CodeDiagnosticsToolDeps | undefined) {
  return defineToolManifest(
    "code.diagnostics",
    coreToolIds.codeDiagnostics,
    "Code Diagnostics",
    "read",
    ["code:diagnostics"],
    objectSchema([], {
      workspaceRoot: { type: "string" },
      limit: { type: "number" },
      limitBytes: { type: "number" },
      severity: { type: "string" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => codeDiagnosticsTool(input, context, ready as CodeDiagnosticsToolDeps))
  );
}

async function codeDiagnosticsTool(input: JsonObject, context: CapabilityExecutionContext, deps: CodeDiagnosticsToolDeps): Promise<SerializableResult<CoreToolResult>> {
  if (!deps.codeIntelligence) return failure("code.diagnostics", "CODE_INTELLIGENCE_UNAVAILABLE", "CodeIntelligenceService is required for code diagnostics.", []);
  const parsed = input as CodeDiagnosticsInput;
  const root = parsed.workspaceRoot ?? deps.workspaceRoot;
  const limit = boundedCount(parsed.limit, 50, 500);
  const limitBytes = parsed.limitBytes ?? 16_000;
  const diagnostics = (await deps.codeIntelligence.diagnostics(root))
    .filter((diagnostic) => !parsed.severity || diagnostic.severity === parsed.severity)
    .map((diagnostic) => normalizeDiagnostic(root, diagnostic))
    .filter((diagnostic) => isModelVisibleWorkspaceRelativePath(diagnostic.relativePath))
    .slice(0, limit);
  return success("code.diagnostics", diagnostics.map((diagnostic) => diagnostic.path), {
    preview: boundedText(diagnostics.map(formatDiagnostic).join("\n"), limitBytes),
    metadata: {
      root,
      count: diagnostics.length,
      severity: parsed.severity,
      diagnostics
    },
    replay: replay(context)
  });
}

function normalizeDiagnostic(root: string, diagnostic: Diagnostic): NormalizedDiagnostic {
  return {
    path: diagnostic.path,
    relativePath: workspaceRelativePath(root, diagnostic.path),
    message: diagnostic.message,
    severity: diagnostic.severity,
    line: diagnostic.line,
    source: diagnostic.source,
    code: diagnostic.code,
    range: diagnostic.range
  };
}

function formatDiagnostic(diagnostic: JsonObject): string {
  const path = String(diagnostic.relativePath ?? diagnostic.path ?? "");
  const line = typeof diagnostic.line === "number" ? `:${diagnostic.line}` : "";
  const severity = String(diagnostic.severity ?? "info");
  const code = typeof diagnostic.code === "string" ? ` ${diagnostic.code}` : "";
  const message = String(diagnostic.message ?? "");
  return `${path}${line} ${severity}${code} ${message}`;
}

function boundedCount(value: number | undefined, fallback: number, max: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value ?? fallback))) : fallback;
}
