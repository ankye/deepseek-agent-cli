import { PROMPT_ASSEMBLY_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import type { TaskAcceptanceCriterion, TaskDecisionRequest } from "@deepseek/platform-contracts";
import type { PromptSectionProviderRegistration } from "../assembler.js";
import { createPromptSection } from "../sections.js";

export function createTaskDecisionProvider(): PromptSectionProviderRegistration {
  return {
    id: "core.task-decision-request",
    version: "1.0.0",
    kind: "task.decision-request",
    source: "task-delivery-flow",
    priority: 976,
    budgetClass: "required",
    trust: "system",
    required: true,
    compatibility: { schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION },
    provide(input) {
      const request = input.taskDecision;
      if (!request) return [];
      return [createPromptSection({
        id: `section.task-decision-request.${request.requestId}`,
        providerId: "core.task-decision-request",
        kind: "task.decision-request",
        source: "task-delivery-flow",
        role: "system",
        content: taskDecisionContent(request),
        priority: 976,
        budgetClass: "required",
        trust: "system",
        required: true,
        provenance: {
          requestId: request.requestId,
          briefId: request.brief.briefId,
          evidenceRefs: request.evidenceRefs,
          candidateProfiles: request.candidateProfiles,
          acceptanceCriteria: request.acceptanceDraft.map((criterion) => criterion.criterionId)
        }
      })];
    }
  };
}

function taskDecisionContent(request: TaskDecisionRequest): string {
  return [
    "Task decision request:",
    `- Request id: ${request.requestId}`,
    `- Brief id: ${request.brief.briefId}`,
    `- Raw intent: ${request.brief.rawInput}`,
    `- Normalized intent: ${request.brief.normalizedIntent}`,
    `- Intent kind: ${request.brief.intentKind}`,
    `- Confidence: ${request.brief.confidence}`,
    `- Needs user confirmation: ${request.brief.needsUserConfirmation ? "yes" : "no"}`,
    `- Missing info: ${request.brief.missingInfo.join(", ") || "none"}`,
    `- Risk: ${request.riskLevel}`,
    `- Evidence refs: ${request.evidenceRefs.join(", ") || "none"}`,
    listBlock("Constraints", request.constraints),
    listBlock("Allowed tools", request.allowedTools),
    listBlock("Candidate profiles", request.candidateProfiles),
    acceptanceBlock(request.acceptanceDraft),
    `- Output schema: ${JSON.stringify(request.outputSchema ?? { kind: "TaskDecisionEnvelope" })}`,
    "- Return a TaskDecisionEnvelope as structured data.",
    "- Include goal, acceptance criteria, plan steps, profile/tool strategy, verification plan, repair policy, stop conditions, user questions, confidence, and assumptions.",
    "- Do not claim task completion; runtime acceptance decides delivery."
  ].join("\n");
}

function listBlock(label: string, values: readonly string[]): string {
  if (values.length === 0) return `- ${label}: none`;
  return [`- ${label}:`, ...values.map((value) => `  - ${value}`)].join("\n");
}

function acceptanceBlock(criteria: readonly TaskAcceptanceCriterion[]): string {
  if (criteria.length === 0) return "- Acceptance draft: none";
  return [
    "- Acceptance draft:",
    ...criteria.map((criterion) => [
      `  - ${criterion.criterionId}: ${criterion.description}`,
      `    required=${criterion.required ? "yes" : "no"}`,
      `    evidence=${criterion.evidenceRefs?.join(", ") || "none"}`,
      `    checks=${criterion.checkIds?.join(", ") || "none"}`
    ].join("\n"))
  ].join("\n");
}
