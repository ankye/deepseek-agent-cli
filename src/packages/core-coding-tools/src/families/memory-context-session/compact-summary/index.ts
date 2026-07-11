import type { CapabilityExecutionContext, CoreToolResult, JsonObject, SerializableResult } from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";

interface CompactSummaryInput extends JsonObject {
  readonly sessionId: string;
  readonly segments: readonly string[];
  readonly maxTokens: number;
  readonly reservedOutputTokens?: number;
  readonly limitBytes?: number;
}

export function defineCompactSummaryTool(_deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "compact.summary",
    coreToolIds.compactSummary,
    "Compact Summary",
    "read",
    ["context:summary"],
    objectSchema(["sessionId", "segments", "maxTokens"], {
      sessionId: { type: "string" },
      segments: { type: "array" },
      maxTokens: { type: "number" },
      reservedOutputTokens: { type: "number" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => compactSummaryTool(input, context)
  );
}

async function compactSummaryTool(input: JsonObject, context: CapabilityExecutionContext): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as CompactSummaryInput;
  if (typeof parsed.sessionId !== "string" || parsed.sessionId.trim().length === 0) return failure("compact.summary", "COMPACT_SESSION_ID_REQUIRED", "sessionId is required.", []);
  if (!Array.isArray(parsed.segments)) return failure("compact.summary", "COMPACT_SEGMENTS_INVALID", "segments must be an array of strings.", []);
  if (typeof parsed.maxTokens !== "number" || !Number.isFinite(parsed.maxTokens)) return failure("compact.summary", "COMPACT_MAX_TOKENS_REQUIRED", "maxTokens is required.", []);
  if (!parsed.segments.every((segment) => typeof segment === "string")) return failure("compact.summary", "COMPACT_SEGMENTS_INVALID", "segments must be an array of strings.", []);

  const result = createCompactSummary({
    sessionId: asId<"session">(parsed.sessionId),
    segments: parsed.segments,
    maxTokens: parsed.maxTokens,
    ...(typeof parsed.reservedOutputTokens === "number" ? { reservedOutputTokens: parsed.reservedOutputTokens } : {})
  });
  return success("compact.summary", [parsed.sessionId], {
    preview: boundedText(result.summary, parsed.limitBytes),
    metadata: {
      familyId: result.familyId,
      status: result.status,
      sessionId: result.sessionId,
      selectedSegmentCount: result.selectedSegmentCount,
      excludedSegmentCount: result.excludedSegmentCount,
      selectedTokens: result.selectedTokens,
      excludedTokens: result.excludedTokens,
      maxTokens: result.maxTokens,
      reservedOutputTokens: result.reservedOutputTokens,
      diagnostics: result.diagnostics
    },
    replay: replay(context)
  });
}

function createCompactSummary(input: {
  readonly sessionId: ReturnType<typeof asId<"session">>;
  readonly segments: readonly string[];
  readonly maxTokens: number;
  readonly reservedOutputTokens?: number;
}) {
  const maxTokens = Math.max(0, input.maxTokens);
  const reservedOutputTokens = Math.max(0, input.reservedOutputTokens ?? 0);
  const budget = Math.max(0, maxTokens - reservedOutputTokens);
  const selected: string[] = [];
  let selectedTokens = 0;
  let excludedTokens = 0;
  for (const segment of input.segments) {
    const redacted = redactCompactContent(segment);
    const tokens = countTokens(redacted);
    if (selectedTokens + tokens > budget) {
      excludedTokens += tokens;
      continue;
    }
    selected.push(redacted);
    selectedTokens += tokens;
  }
  const summary = selected.join("\n").trim();
  const diagnostics = selected.length < input.segments.length ? ["compact.summary.budget-excluded-segments"] : [];
  return {
    familyId: "compact.summary",
    status: diagnostics.length > 0 ? "degraded" : "completed",
    sessionId: input.sessionId,
    summary,
    selectedSegmentCount: selected.length,
    excludedSegmentCount: input.segments.length - selected.length,
    selectedTokens,
    excludedTokens,
    maxTokens,
    reservedOutputTokens,
    diagnostics
  } as const;
}

function redactCompactContent(content: string): string {
  return content
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g, "Bearer [REDACTED:token]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:api-key]")
    .replace(/\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s"',;]+/gi, (match) => {
      const [key] = match.split("=");
      return `${key}=[REDACTED:secret]`;
    });
}

function countTokens(content: string): number {
  const trimmed = content.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}
