import type { AgentLoopOutputContract, AgentLoopProfileWorkflowGateOverride, JsonObject, RedactedError, ToolFeedbackStatus, ToolResultFeedback, TraceContext } from "@deepseek/platform-contracts";
import { kernelError } from "./errors.js";
import { buildToolResultFeedback } from "./model-tooling.js";

export type DispatchTerminalStatus = "completed" | "failed" | "rejected" | "cancelled" | "timed-out" | "abandoned";

export interface DispatchTerminalSummary extends JsonObject {
  readonly batchId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly capabilityId: string;
  readonly terminalStatus: DispatchTerminalStatus;
  readonly inProgressToolCallIds: readonly string[];
  readonly elapsedMs: number;
  readonly evidenceIds: readonly string[];
  readonly diagnostics: readonly RedactedError[];
  readonly convergence: JsonObject;
}

export function toolTimeoutFor(input: unknown, maxToolTimeoutMs: number, manifestTimeoutMs?: number, callerTimeoutMs?: number): number {
  const manifestBound = typeof manifestTimeoutMs === "number" && Number.isFinite(manifestTimeoutMs) && manifestTimeoutMs > 0
    ? Math.floor(manifestTimeoutMs)
    : maxToolTimeoutMs;
  const requested = jsonObjectValue(input)?.timeoutMs;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return manifestBound;
  const upperBound = typeof callerTimeoutMs === "number" && Number.isFinite(callerTimeoutMs) && callerTimeoutMs > 0
    ? Math.min(manifestBound, Math.floor(callerTimeoutMs))
    : manifestBound;
  return Math.min(Math.floor(requested), upperBound);
}

interface OutputContractArtifactPathRejectionInput {
  readonly outputContract?: AgentLoopOutputContract;
  readonly workflowGateOverride?: AgentLoopProfileWorkflowGateOverride;
  readonly toolName: string;
  readonly toolInput: JsonObject;
}

export function outputContractArtifactPathRejection(input: OutputContractArtifactPathRejectionInput): { readonly error: RedactedError; readonly terminalKind: string } | undefined {
  const requiredPath = input.outputContract?.path?.trim();
  if (!requiredPath) return undefined;
  if (input.outputContract?.kind !== "file" && input.outputContract?.kind !== "json-file") return undefined;
  if (!isWorkspaceMutationTool(input.toolName)) return undefined;
  const path = stringField(input.toolInput, "path");
  if (!path || normalizeRelativePath(path) === normalizeRelativePath(requiredPath)) return undefined;
  return {
    terminalKind: "output-contract.path.rejected",
    error: kernelError("KERNEL_POLICY_DENIED", `OUTPUT_CONTRACT_PATH_ENFORCED: write the required artifact path ${requiredPath}.`, {
      requiredPath,
      rejectedPath: path,
      rejectedToolName: input.toolName,
      ...(input.workflowGateOverride ? { workflowGateOverride: input.workflowGateOverride } : {})
    })
  };
}

export function isRecoverableToolError(error: RedactedError | undefined): boolean {
  if (!error) return false;
  if (error.code === "KERNEL_SCHEDULER_TIMEOUT") return true;
  if (error.code !== "KERNEL_EXECUTOR_FAILED") return false;
  const details = jsonObjectValue(error.details);
  return typeof details?.originalCode === "string" && details.originalCode.length > 0;
}

export function correctiveActionForToolFeedback(status: ToolFeedbackStatus): string | undefined {
  if (status === "denied") return "Request permission, choose a different projected tool, or report a bounded blocker.";
  if (status === "rejected") return "Correct the tool input or choose a different projected tool.";
  if (status === "failed") return "Inspect the typed diagnostics, correct the input or environment, then retry only with new evidence.";
  if (status === "timeout") return "Reduce scope, use a focused command, or report a bounded timeout blocker.";
  if (status === "cancelled") return "Confirm cancellation state before retrying or report the blocker.";
  return undefined;
}

export function recommendedNextActionForToolFeedback(status: ToolFeedbackStatus): string | undefined {
  if (status === "denied") return "permission change, different projected tool, or bounded blocker";
  if (status === "rejected") return "corrected input or different projected tool";
  if (status === "failed") return "diagnostic-driven correction or bounded blocker";
  if (status === "timeout") return "focused retry or bounded timeout blocker";
  if (status === "cancelled") return "confirm cancellation or bounded blocker";
  return undefined;
}

export function buildRejectedDispatchFeedback(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly capabilityId?: string;
  readonly text: string;
  readonly diagnostics: readonly RedactedError[];
  readonly correctiveAction?: string;
  readonly recommendedNextAction?: string;
  readonly trace: TraceContext;
  readonly limitBytes: number;
  readonly continuation?: "continue" | "terminate";
}): ToolResultFeedback {
  return buildToolResultFeedback({
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
    status: "rejected",
    text: input.text,
    diagnostics: input.diagnostics,
    ...(input.correctiveAction ? { correctiveAction: input.correctiveAction } : {}),
    ...(input.recommendedNextAction ? { recommendedNextAction: input.recommendedNextAction } : {}),
    trace: input.trace,
    limitBytes: input.limitBytes,
    ...(input.continuation ? { continuation: input.continuation } : {})
  });
}

export function buildRejectedDispatchResult(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly capabilityId?: string;
  readonly normalizedInputHash: string;
  readonly terminalKind: string;
  readonly text: string;
  readonly diagnostics: readonly RedactedError[];
  readonly correctiveAction?: string;
  readonly recommendedNextAction?: string;
  readonly trace: TraceContext;
  readonly limitBytes: number;
  readonly continuation?: "continue" | "terminate";
  readonly iteration: number;
  readonly metadata?: JsonObject;
}): {
  readonly feedback: ToolResultFeedback;
  readonly eventData: JsonObject;
  readonly evidenceInput: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly capabilityId?: string;
    readonly terminalKind: string;
    readonly feedback: ToolResultFeedback;
  };
  readonly decisionRecord: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly capabilityId?: string;
    readonly normalizedInputHash: string;
    readonly terminalKind: string;
    readonly correctiveAction?: string;
    readonly recommendedNextAction?: string;
    readonly iteration: number;
    readonly metadata?: JsonObject;
  };
} {
  const feedback = buildRejectedDispatchFeedback(input);
  const base = {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
    terminalKind: input.terminalKind,
    feedback
  };
  return {
    feedback,
    eventData: {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      result: feedback.preview.text,
      terminalKind: input.terminalKind,
      feedback
    },
    evidenceInput: base,
    decisionRecord: {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
      normalizedInputHash: input.normalizedInputHash,
      terminalKind: input.terminalKind,
      ...(feedback.correctiveAction ? { correctiveAction: feedback.correctiveAction } : {}),
      ...(feedback.recommendedNextAction ? { recommendedNextAction: feedback.recommendedNextAction } : {}),
      iteration: input.iteration,
      ...(input.metadata ? { metadata: input.metadata } : {})
    }
  };
}

export function buildDeniedDispatchFeedback(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly capabilityId?: string;
  readonly text: string;
  readonly diagnostics: readonly RedactedError[];
  readonly correctiveAction?: string;
  readonly recommendedNextAction?: string;
  readonly trace: TraceContext;
  readonly limitBytes: number;
  readonly continuation?: "continue" | "terminate";
}): ToolResultFeedback {
  return buildToolResultFeedback({
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
    status: "denied",
    text: input.text,
    diagnostics: input.diagnostics,
    ...(input.correctiveAction ? { correctiveAction: input.correctiveAction } : {}),
    ...(input.recommendedNextAction ? { recommendedNextAction: input.recommendedNextAction } : {}),
    trace: input.trace,
    limitBytes: input.limitBytes,
    ...(input.continuation ? { continuation: input.continuation } : {})
  });
}

export function buildDeniedDispatchResult(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly capabilityId?: string;
  readonly normalizedInputHash: string;
  readonly terminalKind: string;
  readonly text: string;
  readonly diagnostics: readonly RedactedError[];
  readonly correctiveAction?: string;
  readonly recommendedNextAction?: string;
  readonly trace: TraceContext;
  readonly limitBytes: number;
  readonly continuation?: "continue" | "terminate";
  readonly iteration: number;
  readonly metadata?: JsonObject;
}): {
  readonly feedback: ToolResultFeedback;
  readonly eventData: JsonObject;
  readonly evidenceInput: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly capabilityId?: string;
    readonly terminalKind: string;
    readonly feedback: ToolResultFeedback;
  };
  readonly decisionRecord: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly capabilityId?: string;
    readonly normalizedInputHash: string;
    readonly terminalKind: string;
    readonly correctiveAction?: string;
    readonly recommendedNextAction?: string;
    readonly iteration: number;
    readonly metadata?: JsonObject;
  };
} {
  const feedback = buildDeniedDispatchFeedback(input);
  const base = {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
    terminalKind: input.terminalKind,
    feedback
  };
  return {
    feedback,
    eventData: {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      result: feedback.preview.text,
      terminalKind: input.terminalKind,
      feedback
    },
    evidenceInput: base,
    decisionRecord: {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
      normalizedInputHash: input.normalizedInputHash,
      terminalKind: input.terminalKind,
      ...(feedback.correctiveAction ? { correctiveAction: feedback.correctiveAction } : {}),
      ...(feedback.recommendedNextAction ? { recommendedNextAction: feedback.recommendedNextAction } : {}),
      iteration: input.iteration,
      ...(input.metadata ? { metadata: input.metadata } : {})
    }
  };
}

export function buildDispatchTerminalSummary(input: DispatchTerminalSummary): DispatchTerminalSummary {
  return input;
}

export function shouldQuarantineStaleToolResult(input: {
  readonly toolCallId: string;
  readonly summary: DispatchTerminalSummary;
}): boolean {
  return input.summary.terminalStatus !== "completed" && input.summary.inProgressToolCallIds.includes(input.toolCallId);
}

function isWorkspaceMutationTool(toolName: string): boolean {
  const normalized = toolName.replace(/_/g, ".");
  return normalized === "core.file.write" || normalized === "core.file.edit" || normalized === "core.patch.apply";
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function stringField(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function jsonObjectValue(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}
