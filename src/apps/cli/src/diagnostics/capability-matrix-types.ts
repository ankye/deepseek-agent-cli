import type {
  CliEvaluationOutcomeGate,
  JsonObject,
  PlatformRuntime,
  ToolFamilyId
} from "@deepseek/platform-contracts";
import type { CapabilityMatrixDecisionQuality } from "./capability-matrix-decision-quality.js";

export type CapabilityMatrixClassification =
  | "pass"
  | "partial"
  | "blocked-by-model"
  | "blocked-by-cli-capability-gap"
  | "blocked-by-cli-bug"
  | "invalid-test-environment";

export type CapabilityMatrixOwnerLayer =
  | "evaluation-supervisor"
  | "model-behavior"
  | "prompt-profile"
  | "tool-projection"
  | "tool-implementation"
  | "tool-policy"
  | "policy-sandbox"
  | "credentials"
  | "test-environment"
  | "task-design"
  | "unknown";

export interface CapabilityMatrixGuidance extends JsonObject {
  readonly ownerLayer: CapabilityMatrixOwnerLayer;
  readonly rootCause: string;
  readonly recommendedAction: string;
  readonly rerunCondition: string;
  readonly evidenceGaps: readonly string[];
  readonly confidence: "low" | "medium" | "high";
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface CapabilityMatrixTask extends JsonObject {
  readonly taskId: string;
  readonly title: string;
  readonly capabilityArea: string;
  readonly workspaceMode: "project-read-only" | "disposable-write" | "disposable-read-only";
  readonly toolProjection: "read-only" | "read-write" | "safe-all";
  readonly prompt: string;
  readonly successCriteria: readonly string[];
  readonly evidenceArtifacts: readonly string[];
  readonly requiredFamilyIds?: readonly ToolFamilyId[];
  readonly fixtureKind: "none" | "typescript-package" | "permission-boundary" | "broken-command" | "multi-file-artifact";
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface CapabilityMatrixTaskRun extends JsonObject {
  readonly taskId: string;
  readonly status: "planned" | "completed";
  readonly classification: CapabilityMatrixClassification;
  readonly reason: string;
  readonly guidance: CapabilityMatrixGuidance;
  readonly outcomeGate: CliEvaluationOutcomeGate;
  readonly decisionQuality: CapabilityMatrixDecisionQuality;
  readonly reportDir: string;
  readonly evidencePaths: {
    readonly prompt: string;
    readonly trace: string;
    readonly summary: string;
    readonly diff: string;
    readonly classification: string;
  };
  readonly cliCommand: readonly string[];
  readonly supervisorBoundary: "evaluate-only-no-help";
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface CapabilityMatrixSummary extends JsonObject {
  readonly schemaVersion: string;
  readonly kind: "cli.capability-matrix";
  readonly dryRun: boolean;
  readonly live: boolean;
  readonly action: string;
  readonly reportDir: string;
  readonly supervisorBoundary: "evaluate-only-no-help";
  readonly tasks: readonly CapabilityMatrixTask[];
  readonly runs: readonly CapabilityMatrixTaskRun[];
  readonly aggregate: {
    readonly totalTaskCount: number;
    readonly plannedRunCount: number;
    readonly classificationCounts: Record<CapabilityMatrixClassification, number>;
    readonly decisionQuality: {
      readonly averageScore: number;
      readonly boardSnapshotRunCount: number;
      readonly repeatedRejectionRunCount: number;
      readonly gapCounts: Record<string, number>;
    };
  };
  readonly nextAction: string;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface CapabilityMatrixOptions {
  readonly action?: string;
  readonly dryRun: boolean;
  readonly live: boolean;
  readonly taskIds?: readonly string[];
  readonly reportDir?: string;
  readonly cliCommand?: string;
  readonly modelProvider?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly platform?: PlatformRuntime;
}
