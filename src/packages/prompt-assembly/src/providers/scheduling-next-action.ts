import { PROMPT_ASSEMBLY_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import type { PromptSchedulingNextAction } from "@deepseek/platform-contracts";
import type { PromptSectionProviderRegistration } from "../assembler.js";
import { createPromptSection, stableHash } from "../sections.js";

export function createSchedulingNextActionProvider(): PromptSectionProviderRegistration {
  return {
    id: "core.scheduling-next-action",
    version: "1.0.0",
    kind: "system.scheduling-next-action",
    source: "runtime",
    priority: 370,
    budgetClass: "required",
    trust: "system",
    required: true,
    compatibility: { schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION },
    provide(input) {
      const nextAction = input.schedulingNextAction;
      if (!nextAction) return [];
      return [createPromptSection({
        id: "section.scheduling-next-action",
        providerId: "core.scheduling-next-action",
        kind: "system.scheduling-next-action",
        source: "runtime",
        role: "system",
        content: schedulingNextActionContent(nextAction),
        priority: 370,
        budgetClass: "required",
        trust: "system",
        required: true,
        provenance: {
          actionClass: nextAction.actionClass,
          stageId: nextAction.stageId,
          requiredNextAction: nextAction.requiredNextAction,
          allowedCapabilityIds: nextAction.allowedCapabilityIds,
          evidenceRefCount: nextAction.acceptedEvidenceRefs.length,
          nextActionFingerprint: schedulingNextActionFingerprint(nextAction)
        }
      })];
    }
  };
}

function schedulingNextActionContent(nextAction: PromptSchedulingNextAction): string {
  return [
    "Scheduling next action:",
    `Action class: ${nextAction.actionClass}`,
    nextAction.stageId ? `Stage: ${nextAction.stageId}` : undefined,
    `Required next action: ${nextAction.requiredNextAction}`,
    nextAction.allowedCapabilityIds.length > 0
      ? `Allowed capabilities: ${nextAction.allowedCapabilityIds.join(", ")}`
      : "Allowed capabilities: none",
    nextAction.acceptedEvidenceRefs.length > 0
      ? `Evidence refs: ${nextAction.acceptedEvidenceRefs.join(", ")}`
      : "Evidence refs: none",
    ...schedulingActionShapeLines(nextAction),
    nextAction.correctionText ? `Correction: ${nextAction.correctionText}` : undefined,
    "Provider tool schemas may include additional workflow tools for cache stability; only the allowed capabilities above are executable for this next action.",
    "Calling any other tool will be rejected before execution.",
    "Use one visible tool that satisfies this action. Do not broaden discovery unless this action explicitly allows evidence collection."
  ].filter(Boolean).join("\n");
}

function schedulingActionShapeLines(nextAction: PromptSchedulingNextAction): readonly string[] {
  if (nextAction.actionClass === "mutation" && requiresOnlyMutationProgress(nextAction.requiredNextAction)) {
    return [
      "Required next action overrides broader allowed capability lists.",
      "Mutation-only stage: do not call read, search, list, glob, shell, or test tools.",
      "Use core.file.edit or core.patch.apply now, based on the accepted evidence refs."
    ];
  }
  if (nextAction.requiredNextAction === "core.test.run") {
    return [
      "Required next action overrides broader allowed capability lists.",
      "Verification-only stage: call core.test.run with a standard repository test command now.",
      "Do not call read, search, list, glob, shell, git diff, or mutation tools for this verification action."
    ];
  }
  if (nextAction.actionClass === "focused-evidence" && nextAction.allowedCapabilityIds.includes("core.file.read")) {
    return [
      "Preferred evidence shape: one bounded focused source read.",
      "Use offset/limit when reading source files; avoid broad listing/search first when the target path is already known or strongly implied."
    ];
  }
  return [];
}

function requiresOnlyMutationProgress(requiredNextAction: string): boolean {
  const alternatives = requiredNextAction.split("|").map((part) => part.trim()).filter(Boolean);
  return alternatives.length > 0 &&
    alternatives.every((capabilityId) => capabilityId === "core.file.edit" || capabilityId === "core.patch.apply");
}

function schedulingNextActionFingerprint(nextAction: PromptSchedulingNextAction): string {
  return stableHash(JSON.stringify({
    actionClass: nextAction.actionClass,
    stageId: nextAction.stageId,
    requiredNextAction: nextAction.requiredNextAction,
    allowedCapabilityIds: nextAction.allowedCapabilityIds,
    acceptedEvidenceRefs: nextAction.acceptedEvidenceRefs,
    correctionText: nextAction.correctionText
  }));
}
