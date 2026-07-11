import type { AgentLoopProfileWorkflowGateOverride, JsonObject, ModelChatMessage, RedactedError } from "@deepseek/platform-contracts";
import { isMutationCapabilityId, progressCapabilityIdsForWorkflowStage } from "./workflow-capability-policy.js";

export const READY_STAGE_REQUIRED_ACTION_CORRECTION_LIMIT = 3;

export function readyStageRequiredActionMissKey(control: JsonObject | undefined): string {
  const stage = control ?? {};
  return [
    String(stage.profileId ?? ""),
    String(stage.graphId ?? stage.workflowGraphId ?? ""),
    String(stage.stageId ?? ""),
    String(stage.requiredNextAction ?? "")
  ].join(":");
}

export function readyStageRequiredActionCorrectionMessage(
  control: JsonObject | undefined,
  correctionAttempt: number,
  error: RedactedError
): ModelChatMessage {
  const stage = control ?? {};
  const allowedCapabilityIds = Array.isArray(stage.allowedCapabilityIds)
    ? stage.allowedCapabilityIds.map(String).join(", ")
    : "";
  const progressCapabilityIds = Array.isArray(stage.progressCapabilityIds)
    ? stage.progressCapabilityIds.map(String).join(", ")
    : "";
  const visibleFunctionNames = Array.isArray(stage.progressCapabilityIds)
    ? stage.progressCapabilityIds.map((capabilityId) => safeToolFunctionName(String(capabilityId))).join(", ")
    : "";
  const actionMeaning = readyStageRequiredActionMeaning(control);
  const antiLoopInstruction = readyStageAntiLoopInstruction(control);
  return {
    role: "user",
    content: [
      "WORKFLOW_REQUIRED_ACTION_MISSED.",
      `Correction attempt: ${correctionAttempt}/${READY_STAGE_REQUIRED_ACTION_CORRECTION_LIMIT}.`,
      `Active stage: ${String(stage.stageId ?? "unknown")}.`,
      `Required next action: ${String(stage.requiredNextAction ?? "unknown")}.`,
      actionMeaning,
      allowedCapabilityIds ? `Allowed capabilities: ${allowedCapabilityIds}.` : "Allowed capabilities: unavailable.",
      progressCapabilityIds ? `Progress capabilities: ${progressCapabilityIds}.` : "Progress capabilities: unavailable.",
      visibleFunctionNames ? `Visible function names: ${visibleFunctionNames}.` : "Visible function names: unavailable.",
      antiLoopInstruction,
      `Diagnostic: ${error.code}: ${error.message}`,
      "Call one visible governed tool that satisfies the required next action. Do not answer with text-only output for this stage."
    ].join("\n")
  };
}

export function readyStageRequiredActionMeaning(control: JsonObject | undefined): string {
  const stage = control ?? {};
  const stageKind = String(stage.stageKind ?? "");
  if (stageKind === "produce" || stageKind === "materialize" || stageKind === "repair") {
    return "Required action meaning: call one visible workspace mutation tool that creates, edits, patches, moves, copies, deletes, touches, archives, reverts, or JSON-patches workspace files.";
  }
  if (stageKind === "verify" || stageKind === "score") {
    return "Required action meaning: call one visible verification tool such as a test, shell verification command, benchmark, score, or git diff capability.";
  }
  return "Required action meaning: call one visible governed tool from the progress capability set.";
}

export function readyStageAntiLoopInstruction(control: JsonObject | undefined): string {
  const stage = control ?? {};
  const stageKind = String(stage.stageKind ?? "");
  if (stageKind === "produce" || stageKind === "materialize" || stageKind === "repair") {
    return "Do not call read/search/list tools again for this produce stage unless no mutation is possible; if blocked, report the blocker instead of repeating inspection.";
  }
  if (stageKind === "verify" || stageKind === "score") {
    return "Do not call read/search/list tools again for this verification stage unless they are listed as progress capabilities; run a verification or report the blocker.";
  }
  return "Do not repeat the same non-progress tool call; choose a progress capability or report the blocker.";
}

export function safeToolFunctionName(capabilityId: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(capabilityId) ? capabilityId : capabilityId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function readyStageNonProgressCapabilityMiss(
  capabilityId: string,
  control: JsonObject | undefined
): boolean {
  if (!control) return false;
  const stage = control ?? {};
  const stageKind = String(stage.stageKind ?? "");
  const progressCapabilityIds = Array.isArray(stage.progressCapabilityIds)
    ? stage.progressCapabilityIds.map(String)
    : [];
  if (stageKind === "produce" || stageKind === "materialize" || stageKind === "repair") {
    return progressCapabilityIds.length > 0
      ? !progressCapabilityIds.includes(capabilityId) && !isMutationCapabilityId(capabilityId)
      : !isMutationCapabilityId(capabilityId);
  }
  if (stageKind === "verify" || stageKind === "score") {
    return progressCapabilityIds.length > 0
      ? !progressCapabilityIds.includes(capabilityId)
      : true;
  }
  return false;
}

export function readyStageProgressCapabilitySatisfied(
  capabilityId: string,
  control: JsonObject | undefined
): boolean {
  if (!control) return false;
  const stage = control ?? {};
  const progressCapabilityIds = Array.isArray(stage.progressCapabilityIds)
    ? stage.progressCapabilityIds.map(String)
    : [];
  return progressCapabilityIds.includes(capabilityId);
}
