import type {
  FailureAnalysisAttribution,
  FailureAnalysisNextAction,
  FailureAnalysisProofStatus,
  JsonObject
} from "@deepseek/platform-contracts";

export type AgentLoopConvergenceKind =
  | "continue"
  | "retry-with-feedback"
  | "analyze-failure"
  | "search-evidence"
  | "prove-attribution"
  | "review-required"
  | "repair-required"
  | "rerun-allowed"
  | "stop-with-classification"
  | "escalate-environment"
  | "bounded-blocker"
  | "terminal";

export interface AgentLoopConvergenceDecision {
  readonly kind: AgentLoopConvergenceKind;
  readonly reasonCode: string;
  readonly correctiveAction?: string;
  readonly recommendedNextAction?: string;
  readonly terminalKind?: string;
  readonly metadata?: JsonObject;
}

export function repeatedRejectedIntentConvergence(input: {
  readonly threshold: number;
  readonly count: number;
}): AgentLoopConvergenceDecision {
  return {
    kind: "retry-with-feedback",
    reasonCode: "decision-loop.rejected",
    terminalKind: "decision-loop.rejected",
    correctiveAction: "Use a different projected tool, corrected input, or explicit bounded blocker report.",
    recommendedNextAction: "different projected tool or corrected input or bounded blocker",
    metadata: {
      repeatedRejectedIntentCount: input.count,
      threshold: input.threshold
    }
  };
}

export function failureAnalysisConvergence(input: {
  readonly attemptId: string;
  readonly terminalKind: string;
  readonly proofStatus: FailureAnalysisProofStatus;
  readonly nextAllowedAction: FailureAnalysisNextAction;
  readonly attribution: FailureAnalysisAttribution;
  readonly acceptedEvidenceRefs?: readonly string[];
}): AgentLoopConvergenceDecision {
  const modelOwnedWithoutProof = input.attribution === "model-owned" && !modelOwnedExclusionsSatisfied(input.acceptedEvidenceRefs ?? []);
  if (input.proofStatus === "unproven" && input.nextAllowedAction === "prove-attribution" && !modelOwnedWithoutProof) {
    return failureDecision("prove-attribution", "failure-analysis.prove-attribution", input, "prove-attribution");
  }
  if (input.proofStatus === "unproven" || modelOwnedWithoutProof) {
    return failureDecision("analyze-failure", "failure-analysis.required", input, "search-evidence");
  }
  if (input.nextAllowedAction === "search-evidence" || input.nextAllowedAction === "focused-evidence-query") {
    return failureDecision("search-evidence", "failure-analysis.search-evidence", input, input.nextAllowedAction);
  }
  if (input.nextAllowedAction === "prove-attribution") {
    return failureDecision("prove-attribution", "failure-analysis.prove-attribution", input, input.nextAllowedAction);
  }
  if (input.nextAllowedAction === "repair") {
    return failureDecision("repair-required", "failure-analysis.repair-required", input, input.nextAllowedAction);
  }
  if (input.nextAllowedAction === "rerun") {
    return failureDecision("rerun-allowed", "failure-analysis.rerun-allowed", input, input.nextAllowedAction);
  }
  if (input.nextAllowedAction === "environment-escalation") {
    return failureDecision("escalate-environment", "failure-analysis.environment-escalation", input, input.nextAllowedAction);
  }
  if (input.nextAllowedAction === "bounded-blocker") {
    return failureDecision("bounded-blocker", "failure-analysis.bounded-blocker", input, input.nextAllowedAction);
  }
  return failureDecision("stop-with-classification", "failure-analysis.stop-with-classification", input, input.nextAllowedAction);
}

export function readyStageToolBudgetConvergence(input: {
  readonly workflowReadyStageControl: JsonObject;
  readonly budget: JsonObject;
}): AgentLoopConvergenceDecision {
  return {
    kind: "review-required",
    reasonCode: "workflow-stage-budget.review-required",
    terminalKind: "workflow-stage-budget.review-required",
    correctiveAction: "Review the active workflow stage budget and choose the next workflow action or report a bounded blocker.",
    recommendedNextAction: "workflow budget review or bounded blocker",
    metadata: {
      workflowReadyStageControl: input.workflowReadyStageControl,
      budget: input.budget
    }
  };
}

export function readyStageRequiredActionConvergence(input: {
  readonly missCount: number;
  readonly correctionLimit: number;
  readonly iteration: number;
  readonly maxModelIterations: number;
  readonly workflowReadyStageControl: JsonObject;
  readonly requestedCapabilityId?: string;
  readonly rejectedBeforeExecution?: boolean;
}): AgentLoopConvergenceDecision {
  const correctionAttempt = input.missCount + 1;
  const canCorrect = input.missCount < input.correctionLimit && input.iteration < input.maxModelIterations;
  return {
    kind: canCorrect ? "retry-with-feedback" : "terminal",
    reasonCode: "workflow-required-action.missed",
    terminalKind: "workflow-required-action.rejected",
    correctiveAction: "Use the required workflow next action for this stage or report a bounded blocker.",
    recommendedNextAction: "required workflow next action or bounded blocker",
    metadata: {
      workflowReadyStageControl: input.workflowReadyStageControl,
      correctionAttempt,
      retryPolicy: canCorrect ? "correct-bounded" : "fail-closed",
      ...(input.requestedCapabilityId ? { requestedCapabilityId: input.requestedCapabilityId } : {}),
      ...(input.rejectedBeforeExecution !== undefined ? { rejectedBeforeExecution: input.rejectedBeforeExecution } : {})
    }
  };
}

export function terminalToolConvergence(input: {
  readonly capabilityId: string;
  readonly toolName: string;
  readonly terminalKind: string;
  readonly feedbackStatus: string;
}): AgentLoopConvergenceDecision {
  const failed = input.terminalKind !== "capability.completed" || input.feedbackStatus !== "success";
  return {
    kind: "terminal",
    reasonCode: failed ? "terminal-tool-failed" : "terminal-tool-completed",
    terminalKind: input.terminalKind,
    metadata: {
      capabilityId: input.capabilityId,
      toolName: input.toolName,
      feedbackStatus: input.feedbackStatus
    }
  };
}

function failureDecision(
  kind: AgentLoopConvergenceKind,
  reasonCode: string,
  input: {
    readonly attemptId: string;
    readonly terminalKind: string;
    readonly proofStatus: FailureAnalysisProofStatus;
    readonly nextAllowedAction: FailureAnalysisNextAction;
    readonly attribution: FailureAnalysisAttribution;
    readonly acceptedEvidenceRefs?: readonly string[];
  },
  recommendedNextAction: FailureAnalysisNextAction
): AgentLoopConvergenceDecision {
  return {
    kind,
    reasonCode,
    terminalKind: input.terminalKind,
    recommendedNextAction,
    metadata: {
      attemptId: input.attemptId,
      proofStatus: input.proofStatus,
      attribution: input.attribution,
      acceptedEvidenceRefs: input.acceptedEvidenceRefs ?? []
    }
  };
}

function modelOwnedExclusionsSatisfied(evidenceRefs: readonly string[]): boolean {
  const text = evidenceRefs.join("\n").toLowerCase();
  return [
    "framework",
    "tool",
    "environment",
    "harness",
    "cache",
    "prompt",
    "repair"
  ].every((category) => text.includes(category));
}
