import { PROMPT_ASSEMBLY_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import type { ToolDecisionRecord, ToolProjectionDecision } from "@deepseek/platform-contracts";
import type { PromptSectionProviderRegistration } from "../assembler.js";
import { createPromptSection } from "../sections.js";

export function createToolDecisionBoardProvider(): PromptSectionProviderRegistration {
  return {
    id: "core.tool-decision-board",
    version: "1.0.0",
    kind: "repair.diagnostics",
    source: "runtime",
    priority: 305,
    budgetClass: "normal",
    trust: "system",
    required: false,
    compatibility: { schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION },
    provide(input) {
      const board = input.toolDecisionBoard;
      if (!board || board.records.length === 0) return [];
      if (input.schedulingNextAction) {
        return [createPromptSection({
          id: "section.tool-decision-board",
          providerId: "core.tool-decision-board",
          kind: "repair.diagnostics",
          source: "runtime",
          role: "system",
          content: [
            "Tool decision board summary:",
            `Board: ${board.boardId}`,
            "Authoritative scheduling next action is projected separately.",
            "Detailed board records, rejected stale actions, cache diagnostics, residual-risk commentary, and raw tool output are hidden from this child prompt."
          ].join("\n"),
          priority: 305,
          budgetClass: "normal",
          trust: "system",
          required: false,
          provenance: {
            boardId: board.boardId,
            recordCount: board.records.length,
            projectedBy: "core.scheduling-next-action"
          }
        })];
      }
      const rejected = board.previousRejectedIntents.slice(-5);
      const recentRecords = rejected.length > 0 ? rejected : board.records.slice(-5);
      const projectionIssues = board.projectionSummaries
        .filter((summary) => summary.status !== "visible")
        .slice(0, 8);
      return [createPromptSection({
        id: "section.tool-decision-board",
        providerId: "core.tool-decision-board",
        kind: "repair.diagnostics",
        source: "runtime",
        role: "system",
        content: [
          "Tool decision board summary:",
          `Board: ${board.boardId}`,
          `Repeated rejected intent count: ${board.repeatedRejectedIntentCount}`,
          `Decision loop failure candidate: ${board.decisionLoopFailureCandidate ? "yes" : "no"}`,
          board.recommendedNextActions.length > 0
            ? `Recommended next actions: ${board.recommendedNextActions.join("; ")}`
            : "Recommended next actions: none",
          "Recent tool decisions:",
          ...recentRecords.map(recordSummary),
          projectionIssues.length > 0 ? "Projection evidence:" : "Projection evidence: none",
          ...projectionIssues.map(projectionSummary)
        ].join("\n"),
        priority: 305,
        budgetClass: "normal",
        trust: "system",
        required: false,
        provenance: {
          boardId: board.boardId,
          recordIds: recentRecords.map((record) => record.recordId),
          recommendedNextActions: board.recommendedNextActions,
          repeatedRejectedIntentCount: board.repeatedRejectedIntentCount,
          decisionLoopFailureCandidate: board.decisionLoopFailureCandidate,
          projectionIssueCapabilityIds: projectionIssues.map((summary) => summary.capabilityId)
        }
      })];
    }
  };
}

function projectionSummary(summary: ToolProjectionDecision): string {
  const stage = summary.stageId ? ` stage=${summary.stageId}` : "";
  const source = summary.policySource ? ` source=${summary.policySource}` : "";
  return `- ${summary.capabilityId} ${summary.status} ${summary.reasonCode}${stage}${source}`;
}

function recordSummary(record: ToolDecisionRecord): string {
  const reason = record.reasonCode ?? record.status;
  const tool = record.toolName ?? record.capabilityId ?? "unknown-tool";
  const next = record.recommendedNextAction ?? record.correctiveAction ?? "no recommended next action";
  return `- ${reason} ${tool} -> ${next}`;
}
