import type { CapabilityMatrixGuidance, CapabilityMatrixOwnerLayer } from "./capability-matrix-types.js";

export function guidance(
  ownerLayer: CapabilityMatrixOwnerLayer,
  rootCause: string,
  recommendedAction: string,
  rerunCondition: string,
  evidenceGaps: readonly string[],
  confidence: CapabilityMatrixGuidance["confidence"]
): CapabilityMatrixGuidance {
  return {
    ownerLayer,
    rootCause,
    recommendedAction,
    rerunCondition,
    evidenceGaps,
    confidence,
    redaction: { class: "internal", fields: ["rootCause", "recommendedAction", "rerunCondition", "evidenceGaps"] }
  };
}
