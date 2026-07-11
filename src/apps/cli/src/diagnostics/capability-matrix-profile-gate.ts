import { buildReferenceToolArsenalReadiness } from "@deepseek/core-coding-tools";
import type { CliEvaluationOutcomeGate, ToolFamilyId } from "@deepseek/platform-contracts";
import { guidance } from "./capability-matrix-guidance.js";
import type {
  CapabilityMatrixClassification,
  CapabilityMatrixGuidance,
  CapabilityMatrixTask
} from "./capability-matrix-types.js";
import type { CapabilityMatrixDecisionQuality } from "./capability-matrix-decision-quality.js";

export function requiredFamilyIdsForCapabilityArea(capabilityArea: string): readonly ToolFamilyId[] {
  const ids: Record<string, readonly string[]> = {
    "intent-profile-readonly-analysis": ["file.read", "search.text", "context.project-index"],
    "workspace-edit": ["file.read", "file.edit", "file.write", "build.test-lint-typecheck"],
    "test-first-repair": ["file.read", "file.edit", "file.write", "build.test-lint-typecheck"],
    "search-context-selection": ["file.read", "search.text", "workspace.glob"],
    "policy-sandbox-boundary": ["file.read"],
    "tool-error-recovery": ["shell.run", "file.read", "file.edit", "build.test-lint-typecheck"],
    "task-decomposition": ["plan.todo", "file.read", "json.read", "json.patch", "build.test-lint-typecheck"],
    "artifact-delivery": ["file.write", "file.edit", "file.read"]
  };
  return (ids[capabilityArea] ?? []).map((id) => id as ToolFamilyId);
}

export function profileCapabilityGate(
  task: Partial<Pick<CapabilityMatrixTask, "requiredFamilyIds" | "prompt">>,
  decisionQuality: CapabilityMatrixDecisionQuality,
  outcomeGate: CliEvaluationOutcomeGate
): {
  readonly classification: CapabilityMatrixClassification;
  readonly reason: string;
  readonly guidance: CapabilityMatrixGuidance;
  readonly outcomeGate: CliEvaluationOutcomeGate;
  readonly decisionQuality: CapabilityMatrixDecisionQuality;
} | undefined {
  const requiredFamilyIds = task.requiredFamilyIds ?? [];
  if (requiredFamilyIds.length === 0) return undefined;
  const readiness = buildReferenceToolArsenalReadiness({
    profileId: "capability-matrix.profile",
    requiredFamilyIds,
    availableCapabilityIds: decisionQuality.visibleCapabilityIds
  });
  if (readiness.blockers.length > 0) {
    const blockerSummary = readiness.blockers
      .map((blocker) => `${blocker.familyId}:${blocker.reason}`)
      .join(", ");
    return {
      classification: "blocked-by-cli-capability-gap",
      reason: `Profile required non-executable or missing arsenal families before semantic task scoring: ${blockerSummary}.`,
      guidance: guidance(
        "tool-implementation",
        "The selected profile requires one or more tool families that are missing, adapter-unavailable, or not executable in the reference arsenal.",
        "Implement or connect the required general-purpose tool family and keep it visible through the profile capability compiler before attributing this task to model behavior.",
        "Rerun after reference arsenal readiness reports all required family ids ready and executable.",
        readiness.blockers.map((blocker) => `family:${blocker.familyId}:${blocker.reason}`),
        "high"
      ),
      outcomeGate,
      decisionQuality
    };
  }
  if (decisionQuality.gaps.includes("projection-evidence:missing-reasons")) {
    return {
      classification: "blocked-by-cli-capability-gap",
      reason: "Profile projection evidence hid one or more required capabilities without a reasonCode; required tools must be visible or hidden with an actionable reason.",
      guidance: guidance(
        "tool-projection",
        "The tool projection board emitted hidden capability evidence without explaining the policy, stage, host opt-in, or availability reason.",
        "Fix stage-aware projection evidence so every hidden required capability has a reasonCode and policy source before judging model tool choice.",
        "Rerun after decisionQuality.projectionReasonCoverage is 1 for the required profile.",
        ["projection-evidence:missing-reasons", "tool.decision-board.snapshot"],
        "high"
      ),
      outcomeGate,
      decisionQuality
    };
  }
  return undefined;
}
