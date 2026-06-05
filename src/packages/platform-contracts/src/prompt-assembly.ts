import type { CapabilityManifest } from "./capability.js";
import type { CompatibilityMetadata, JsonObject, RedactedError, RedactionMetadata, TraceContext } from "./common.js";
import type { ContextPipelineManifest, ContextProjectionResult } from "./context.js";
import type { EvidenceFirstRuntimeContext } from "./evidence-first.js";
import type { SelfRepairOutcomeSummary } from "./self-repair.js";
import type { AgentLoopOutputContract, AgentLoopProjectRuleEvidence, AgentLoopReferenceContext, AgentLoopToolProjection } from "./runtime.js";
import type { AgentModeName, AgentPhasePlan, AgentReasoningEffortMapping, AgentVerifierResult, AgentWorkOrder } from "./agent-mode.js";
import type { InteractionModeName } from "./interaction-mode.js";
import type { ModelChatMessage, ModelProfile, ModelReasoningOptions, ModelToolChoice } from "./model.js";
import type { AgentId, SessionId, TurnId } from "./ids.js";
import type { TaskDecisionRequest } from "./task-delivery-flow.js";

export const PROMPT_ASSEMBLY_SCHEMA_VERSION = "1.0.0";

export type PromptAssemblyMode = "chat" | "coding" | "webpage-generation" | "review" | "revert";
export type PromptAssemblyStage = "normalize" | "collect-sections" | "order-sections" | "budget" | "weave-messages" | "project-tools" | "trace";
export type PromptSectionKind =
  | "system.identity"
  | "system.operating-rules"
  | "system.mode"
  | "project.instructions"
  | "task.intent"
  | "task.decision-request"
  | "task.output-contract"
  | "task.work-order"
  | "context.projected"
  | "context.pipeline"
  | "context.pageindex-recall"
  | "context.semantic-recall"
  | "context.file-reference"
  | "context.code-intelligence"
  | "context.tool-result"
  | "context.skill"
  | "repair.diagnostics"
  | "repair.verification"
  | "tools.policy"
  | "tools.available"
  | "safety.redaction";
export type PromptSectionSource =
  | "runtime"
  | "user"
  | "project"
  | "context-engine"
  | "pageindex"
  | "zvec"
  | "code-intelligence"
  | "tool-result"
  | "skill-system"
  | "self-repair"
  | "task-delivery-flow"
  | "capability-registry";
export type PromptSectionBudgetClass = "required" | "high" | "normal" | "low" | "optional";
export type PromptSectionTrust = "system" | "trusted" | "workspace" | "semantic" | "untrusted";
export type PromptSectionExclusionReason =
  | "budget-exceeded"
  | "duplicate-fingerprint"
  | "policy-excluded"
  | "stale-suppressed"
  | "provider-incompatible"
  | "invalid-section"
  | "provider-failed"
  | "required-provider-failed";
export type PromptAssemblyStatus = "assembled" | "rejected";

export interface PromptSectionProviderMetadata extends JsonObject {
  readonly id: string;
  readonly version: string;
  readonly kind: PromptSectionKind;
  readonly source: PromptSectionSource;
  readonly priority: number;
  readonly budgetClass: PromptSectionBudgetClass;
  readonly trust: PromptSectionTrust;
  readonly required: boolean;
  readonly compatibility: CompatibilityMetadata;
}

export interface PromptSection extends JsonObject {
  readonly id: string;
  readonly providerId: string;
  readonly kind: PromptSectionKind;
  readonly source: PromptSectionSource;
  readonly role: ModelChatMessage["role"];
  readonly content: string;
  readonly priority: number;
  readonly budgetClass: PromptSectionBudgetClass;
  readonly trust: PromptSectionTrust;
  readonly required: boolean;
  readonly estimatedTokens: number;
  readonly evidenceFingerprint: string;
  readonly provenance: JsonObject;
  readonly stale?: boolean;
  readonly redaction: RedactionMetadata;
  readonly compatibility: CompatibilityMetadata;
}

export interface PromptSectionTrace extends JsonObject {
  readonly id: string;
  readonly providerId: string;
  readonly kind: PromptSectionKind;
  readonly source: PromptSectionSource;
  readonly priority: number;
  readonly budgetClass: PromptSectionBudgetClass;
  readonly trust: PromptSectionTrust;
  readonly required: boolean;
  readonly estimatedTokens: number;
  readonly evidenceFingerprint: string;
  readonly included: boolean;
  readonly exclusionReason?: PromptSectionExclusionReason;
  readonly preview?: string;
  readonly redaction: RedactionMetadata;
  readonly compatibility: CompatibilityMetadata;
}

export interface PromptBudgetConfig extends JsonObject {
  readonly hardLimitTokens: number;
  readonly softLimitTokens?: number;
  readonly reservedOutputTokens?: number;
}

export interface PromptBudgetReport extends JsonObject {
  readonly status: "within-budget" | "degraded" | "rejected";
  readonly hardLimitTokens: number;
  readonly softLimitTokens?: number;
  readonly reservedOutputTokens: number;
  readonly selectedTokens: number;
  readonly excludedTokens: number;
  readonly includedSectionCount: number;
  readonly excludedSectionCount: number;
  readonly exclusions: readonly PromptSectionTrace[];
  readonly redaction: RedactionMetadata;
}

export interface PromptToolPlan extends JsonObject {
  readonly policy: AgentLoopToolProjection;
  readonly visibleToolCount: number;
  readonly excludedToolCount: number;
  readonly visibleTools: readonly JsonObject[];
  readonly excludedTools: readonly JsonObject[];
  readonly toolChoice?: ModelToolChoice;
  readonly redaction: RedactionMetadata;
}

export interface PromptAssemblyTrace extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly stageOrder: readonly PromptAssemblyStage[];
  readonly providerIds: readonly string[];
  readonly sections: readonly PromptSectionTrace[];
  readonly projectRules: readonly AgentLoopProjectRuleEvidence[];
  readonly diagnostics: readonly RedactedError[];
  readonly replay: PromptAssemblyReplayEvidence;
  readonly pipeline?: PromptAssemblyPipelineEvidence;
  readonly redaction: RedactionMetadata;
  readonly compatibility: CompatibilityMetadata;
}

export interface PromptAssemblyPipelineEvidence extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly pipelineFingerprint: string;
  readonly layerPrefixHashes: readonly string[];
  readonly includedBlockIds: readonly string[];
  readonly excludedBlockIds: readonly string[];
  readonly cacheHintSummary: JsonObject;
  readonly redaction: RedactionMetadata;
}

export interface PromptAssemblyReplayEvidence extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly packageVersion: string;
  readonly inputFingerprint: string;
  readonly registryFingerprint: string;
  readonly sectionOrderFingerprint: string;
  readonly budgetFingerprint: string;
  readonly toolPlanFingerprint: string;
  readonly messageRoles: readonly ModelChatMessage["role"][];
  readonly redaction: RedactionMetadata;
}

export interface PromptAssemblyInput {
  readonly schemaVersion: "1.0.0";
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly agentId?: AgentId;
  readonly prompt: string;
  readonly mode: PromptAssemblyMode;
  readonly caller: string;
  readonly workspaceRoot?: string;
  readonly outputMode?: string;
  readonly profile: ModelProfile;
  readonly reasoning?: ModelReasoningOptions;
  readonly trace: TraceContext;
  readonly history: readonly ModelChatMessage[];
  readonly contextProjection?: ContextProjectionResult;
  readonly contextPipelineManifest?: ContextPipelineManifest;
  readonly taskDecision?: TaskDecisionRequest;
  readonly evidenceFirst?: EvidenceFirstRuntimeContext;
  readonly selfRepair?: SelfRepairOutcomeSummary;
  readonly projectRules?: readonly AgentLoopProjectRuleEvidence[];
  readonly interactionMode?: InteractionModeName;
  readonly agentMode?: AgentModeName;
  readonly phasePlan?: AgentPhasePlan;
  readonly workOrder?: AgentWorkOrder;
  readonly verifierResult?: AgentVerifierResult;
  readonly reasoningEffortMapping?: AgentReasoningEffortMapping;
  readonly referenceContext?: AgentLoopReferenceContext;
  readonly outputContract?: AgentLoopOutputContract;
  readonly availableTools: readonly CapabilityManifest[];
  readonly toolPolicy: AgentLoopToolProjection;
  readonly budget: PromptBudgetConfig;
  readonly compatibility: CompatibilityMetadata;
}

export interface PromptAssemblyResult extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly status: PromptAssemblyStatus;
  readonly messages: readonly ModelChatMessage[];
  readonly promptText: string;
  readonly sections: readonly PromptSectionTrace[];
  readonly toolPlan: PromptToolPlan;
  readonly budget: PromptBudgetReport;
  readonly trace: PromptAssemblyTrace;
  readonly fingerprint: string;
  readonly diagnostics: readonly RedactedError[];
  readonly redaction: RedactionMetadata;
  readonly compatibility: CompatibilityMetadata;
}

export interface PromptAssemblyEventPayload extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly status: PromptAssemblyStatus;
  readonly fingerprint: string;
  readonly messageCount: number;
  readonly sectionCount: number;
  readonly includedSectionCount: number;
  readonly excludedSectionCount: number;
  readonly budget: PromptBudgetReport;
  readonly toolPlan: Omit<PromptToolPlan, "visibleTools" | "excludedTools">;
  readonly providerTarget: JsonObject;
  readonly trace: PromptAssemblyTrace;
  readonly projectRules: readonly JsonObject[];
  readonly diagnostics: readonly RedactedError[];
  readonly redaction: RedactionMetadata;
  readonly compatibility: CompatibilityMetadata;
}

export interface PromptAssemblyReplayDrift extends JsonObject {
  readonly kind: "provider-version" | "section-fingerprint" | "budget-estimate" | "ordering-rule" | "tool-projection" | "missing-evidence" | "fingerprint";
  readonly message: string;
  readonly captured?: JsonObject;
  readonly replayed?: JsonObject;
  readonly redaction: RedactionMetadata;
}

export interface PromptAssemblyReplayReport extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly status: "matched" | "drifted";
  readonly capturedFingerprint: string;
  readonly replayedFingerprint: string;
  readonly firstDrift?: PromptAssemblyReplayDrift;
  readonly redaction: RedactionMetadata;
}

export interface PromptAssembler {
  assemble(input: PromptAssemblyInput): Promise<PromptAssemblyResult>;
}
