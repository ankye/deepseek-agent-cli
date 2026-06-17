import type { JsonObject, RedactionMetadata } from "./common.js";
import type { CapabilityId } from "./ids.js";

export const TOOL_FAMILY_CATALOG_SCHEMA_VERSION = "1.0.0";

export const TOOL_FAMILY_DOMAIN_IDS = [
  "workspace-io",
  "search-code-intelligence",
  "mutation-patching",
  "shell-process",
  "git-build",
  "planning-control",
  "pipeline-composition",
  "agents-tasks",
  "web-public-data",
  "browser-automation",
  "mcp-connectors",
  "extensions-local-commands",
  "media-images",
  "design-canvas",
  "memory-context-session",
  "remote-scheduling-observability"
] as const;

export type ToolFamilyDomainId = typeof TOOL_FAMILY_DOMAIN_IDS[number];

export const TOOL_FAMILY_IDS = [
  "file.read",
  "file.list",
  "workspace.glob",
  "asset.view-local",
  "search.text",
  "search.symbol",
  "code.diagnostics-lsp",
  "notebook.read",
  "file.write",
  "file.edit",
  "patch.apply",
  "revert.undo",
  "shell.run",
  "process.output",
  "process.kill",
  "repl.execute",
  "git.status-diff",
  "git.history-branch",
  "build.test-lint-typecheck",
  "package.manager",
  "benchmark.run",
  "plan.todo",
  "mode.plan-auto-review",
  "user.input",
  "approval.permission",
  "pipeline.sequence",
  "pipeline.parallel",
  "pipeline.artifact-routing",
  "pipeline.stream",
  "agent.spawn",
  "agent.message-continue",
  "agent.wait-result",
  "agent.stop-close",
  "web.search",
  "web.fetch",
  "web.extract",
  "web.data-lookup",
  "browser.navigate",
  "browser.interact",
  "browser.inspect",
  "browser.screenshot",
  "mcp.server-lifecycle",
  "mcp.tool-call",
  "mcp.resource-read",
  "mcp.prompt",
  "skill.list-activate",
  "hook.list-run",
  "plugin.install-verify",
  "command.palette-slash",
  "image.generate",
  "image.edit",
  "image.search-stock",
  "image.inspect",
  "design.document-state",
  "design.node-query",
  "design.batch-edit",
  "design.export-snapshot",
  "memory.read-write",
  "context.project-index",
  "session.resume-fork",
  "compact.summary",
  "remote.runtime",
  "worktree.environment",
  "schedule.sleep-cron",
  "observability.trace-budget"
] as const;

export type ToolFamilyId = typeof TOOL_FAMILY_IDS[number];

export type ToolFamilyImplementationState =
  | "implemented"
  | "planned"
  | "absent"
  | "unavailable"
  | "deprecated"
  | "not_applicable";

export type ToolFamilyMaturity = "baseline" | "parity" | "advanced" | "experimental";

export type ToolFamilyRiskClass =
  | "read"
  | "write"
  | "process"
  | "network"
  | "external-connector"
  | "orchestration"
  | "media"
  | "design"
  | "memory"
  | "remote"
  | "observability";

export const TOOL_FAMILY_RISK_CLASSES = [
  "read",
  "write",
  "process",
  "network",
  "external-connector",
  "orchestration",
  "media",
  "design",
  "memory",
  "remote",
  "observability"
] as const satisfies readonly ToolFamilyRiskClass[];

export type ToolFamilyOperationProfile =
  | "read"
  | "write"
  | "process"
  | "network"
  | "model-feedback"
  | "artifact"
  | "approval"
  | "pipeline"
  | "connector"
  | "media"
  | "browser"
  | "design"
  | "memory"
  | "remote"
  | "schedule"
  | "observe";

export type ToolFamilyConnectorKind = "built-in" | "mcp" | "provider" | "host" | "catalog";

export type ToolFamilyConnectorTrust = "trusted" | "workspace" | "untrusted" | "fake" | "unknown";

export type ToolFamilyProviderSupportStatus =
  | "native"
  | "connector"
  | "fake"
  | "unsupported"
  | "unknown"
  | "not_applicable";

export type ToolFamilyExecutionEvidenceMode = "none" | "fake" | "replayed" | "live";

export type ToolFamilyArtifactKind =
  | "text"
  | "json"
  | "file"
  | "image"
  | "screenshot"
  | "design-export"
  | "trace"
  | "stream"
  | "other";

export interface ToolFamilyArtifactRef extends JsonObject {
  readonly artifactId: string;
  readonly familyId: ToolFamilyId;
  readonly kind: ToolFamilyArtifactKind;
  readonly uri?: string;
  readonly mimeType?: string;
  readonly byteLength?: number;
  readonly sha256?: string;
  readonly preview?: string;
  readonly truncated: boolean;
  readonly createdAt: string;
  readonly redaction: RedactionMetadata;
}

export interface ToolFamilyConnectorProfileEvidence extends JsonObject {
  readonly profileId: string;
  readonly connectorKind: ToolFamilyConnectorKind;
  readonly trust: ToolFamilyConnectorTrust;
  readonly providerSupport: ToolFamilyProviderSupportStatus;
  readonly fakeFirst: boolean;
  readonly enabled: boolean;
  readonly health: "ok" | "degraded" | "unavailable" | "unknown";
  readonly permissions: readonly string[];
  readonly familyIds: readonly ToolFamilyId[];
  readonly metadata: JsonObject;
  readonly redaction: RedactionMetadata;
}

export interface ToolFamilyPipelineStepRecord extends JsonObject {
  readonly stepId: string;
  readonly capabilityId: CapabilityId;
  readonly familyId: ToolFamilyId;
  readonly sequence: number;
  readonly status: "planned" | "preflight_passed" | "executed" | "failed" | "skipped" | "cancelled";
  readonly inputArtifactIds: readonly string[];
  readonly outputArtifacts: readonly ToolFamilyArtifactRef[];
  readonly policyDecision?: string;
  readonly replayRef?: string;
  readonly diagnostics: readonly string[];
  readonly redaction: RedactionMetadata;
}

export interface ToolFamilyPipelineRecord extends JsonObject {
  readonly pipelineId: string;
  readonly kind: "sequence" | "parallel" | "artifact-routing" | "stream";
  readonly familyId: ToolFamilyId;
  readonly status: "planned" | "running" | "completed" | "failed" | "cancelled";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly steps: readonly ToolFamilyPipelineStepRecord[];
  readonly artifacts: readonly ToolFamilyArtifactRef[];
  readonly replayRef?: string;
  readonly redaction: RedactionMetadata;
}

export interface ToolFamilyProjectionFilter extends JsonObject {
  readonly allowedFamilyIds?: readonly ToolFamilyId[];
  readonly deniedFamilyIds?: readonly ToolFamilyId[];
  readonly allowedDomainIds?: readonly ToolFamilyDomainId[];
  readonly deniedDomainIds?: readonly ToolFamilyDomainId[];
  readonly allowedRiskClasses?: readonly ToolFamilyRiskClass[];
  readonly deniedRiskClasses?: readonly ToolFamilyRiskClass[];
  readonly requiredHostRequirements?: readonly string[];
  readonly deniedHostRequirements?: readonly string[];
  readonly allowedConnectorTrust?: readonly ToolFamilyConnectorTrust[];
  readonly deniedConnectorTrust?: readonly ToolFamilyConnectorTrust[];
  readonly allowedProviderSupport?: readonly ToolFamilyProviderSupportStatus[];
  readonly deniedProviderSupport?: readonly ToolFamilyProviderSupportStatus[];
  readonly allowedPolicyTags?: readonly string[];
  readonly deniedPolicyTags?: readonly string[];
  readonly allowedAgentScopeIds?: readonly string[];
  readonly deniedAgentScopeIds?: readonly string[];
  readonly redaction?: RedactionMetadata;
}

export interface ToolFamilyTaskEvidence extends JsonObject {
  readonly taskId: string;
  readonly requiredFamilyIds: readonly ToolFamilyId[];
  readonly availableFamilyIds: readonly ToolFamilyId[];
  readonly usedFamilyIds: readonly ToolFamilyId[];
  readonly unsupportedFamilyIds: readonly ToolFamilyId[];
  readonly failedFamilyIds: readonly ToolFamilyId[];
  readonly outcome: "solved" | "failed" | "invalid" | "deferred" | "planned";
  readonly evidenceMode: ToolFamilyExecutionEvidenceMode;
  readonly artifacts: readonly ToolFamilyArtifactRef[];
  readonly connectorProfiles: readonly ToolFamilyConnectorProfileEvidence[];
  readonly pipelineRecords: readonly ToolFamilyPipelineRecord[];
  readonly diagnostics: readonly string[];
  readonly redaction: RedactionMetadata;
}

export interface ToolFamilyImplementationReadiness extends JsonObject {
  readonly familyId: ToolFamilyId;
  readonly domainId: ToolFamilyDomainId;
  readonly implementationState: ToolFamilyImplementationState;
  readonly toolCount: number;
  readonly executableToolCount: number;
  readonly modelVisibleToolCount: number;
  readonly hasManifest: boolean;
  readonly hasExecutor: boolean;
  readonly hasProjection: boolean;
  readonly hasOutputBounds: boolean;
  readonly hasTimeoutPolicy: boolean;
  readonly hasSecurityMetadata: boolean;
  readonly hasStaticContractEvidence: boolean;
  readonly hasReplayOrLiveEvidence: boolean;
  readonly hasTaskEvidence: boolean;
  readonly hasSafetyEvidence: boolean;
  readonly providerSupport: ToolFamilyProviderSupportStatus;
  readonly connectorProfiles: readonly ToolFamilyConnectorProfileEvidence[];
  readonly diagnostics: readonly string[];
  readonly redaction: RedactionMetadata;
}

export interface ToolFamilyToolDefinition extends JsonObject {
  readonly toolId: string;
  readonly title: string;
  readonly capabilityId?: CapabilityId;
  readonly coreToolName?: string;
  readonly connectorKind: ToolFamilyConnectorKind;
  readonly implementationState: ToolFamilyImplementationState;
  readonly modelVisible: boolean;
  readonly executable: boolean;
  readonly redaction: RedactionMetadata;
}

export interface ToolFamilyDefinition extends JsonObject {
  readonly familyId: ToolFamilyId;
  readonly domainId: ToolFamilyDomainId;
  readonly title: string;
  readonly implementationState: ToolFamilyImplementationState;
  readonly maturity: ToolFamilyMaturity;
  readonly riskClass: ToolFamilyRiskClass;
  readonly operationProfiles: readonly ToolFamilyOperationProfile[];
  readonly hostRequirements: readonly string[];
  readonly connectorProfile: ToolFamilyConnectorKind;
  readonly scorecardRubricId: string;
  readonly tools: readonly ToolFamilyToolDefinition[];
  readonly redaction: RedactionMetadata;
}

export interface ToolFamilyDomainDefinition extends JsonObject {
  readonly domainId: ToolFamilyDomainId;
  readonly title: string;
  readonly familyIds: readonly ToolFamilyId[];
  readonly redaction: RedactionMetadata;
}

export interface ToolFamilyCatalog extends JsonObject {
  readonly schemaVersion: typeof TOOL_FAMILY_CATALOG_SCHEMA_VERSION;
  readonly catalogVersion: string;
  readonly domains: readonly ToolFamilyDomainDefinition[];
  readonly families: readonly ToolFamilyDefinition[];
  readonly redaction: RedactionMetadata;
}

export interface CapabilityToolFamilyMetadata extends JsonObject {
  readonly schemaVersion: typeof TOOL_FAMILY_CATALOG_SCHEMA_VERSION;
  readonly catalogVersion: string;
  readonly domainId: ToolFamilyDomainId;
  readonly familyId: ToolFamilyId;
  readonly toolId: string;
  readonly implementationState: ToolFamilyImplementationState;
  readonly maturity: ToolFamilyMaturity;
  readonly riskClass: ToolFamilyRiskClass;
  readonly operationProfiles: readonly ToolFamilyOperationProfile[];
  readonly hostRequirements: readonly string[];
  readonly connectorProfile: ToolFamilyConnectorKind;
  readonly scorecardRubricId: string;
  readonly redaction: RedactionMetadata;
}

export type ToolFamilyScoreCriterionStatus =
  | "pass"
  | "partial"
  | "fail"
  | "not_assessed"
  | "planned"
  | "absent"
  | "unavailable"
  | "not_applicable";

export type ToolFamilyScoreLayerId =
  | "implementation"
  | "static_contract"
  | "execution"
  | "task_outcome"
  | "safety"
  | "provider_native_support";

export interface ToolFamilyScoreEvidenceRef extends JsonObject {
  readonly kind: "manifest" | "executor" | "test" | "fake-run" | "replay-run" | "live-run" | "task-run" | "policy" | "provider-native" | "diagnostic" | "artifact" | "connector-profile" | "pipeline-record";
  readonly ref: string;
  readonly status: ToolFamilyScoreCriterionStatus;
  readonly redaction: RedactionMetadata;
}

export interface ToolFamilyScoreCriterionResult extends JsonObject {
  readonly layerId: ToolFamilyScoreLayerId;
  readonly status: ToolFamilyScoreCriterionStatus;
  readonly score: 0 | 1;
  readonly denominator: 0 | 1;
  readonly evidence: readonly ToolFamilyScoreEvidenceRef[];
  readonly redaction: RedactionMetadata;
}

export interface ToolFamilyScorecard extends JsonObject {
  readonly schemaVersion: typeof TOOL_FAMILY_CATALOG_SCHEMA_VERSION;
  readonly catalogVersion: string;
  readonly domainId: ToolFamilyDomainId;
  readonly familyId: ToolFamilyId;
  readonly title: string;
  readonly implementationState: ToolFamilyImplementationState;
  readonly toolCount: number;
  readonly executableToolCount: number;
  readonly modelVisibleToolCount: number;
  readonly executionEvidenceMode: ToolFamilyExecutionEvidenceMode;
  readonly providerSupport: ToolFamilyProviderSupportStatus;
  readonly criteria: readonly ToolFamilyScoreCriterionResult[];
  readonly objectiveScore: number;
  readonly passed: boolean;
  readonly redaction: RedactionMetadata;
}

export interface ToolFamilyParityMatrix extends JsonObject {
  readonly schemaVersion: typeof TOOL_FAMILY_CATALOG_SCHEMA_VERSION;
  readonly kind: "tool-family.parity-matrix";
  readonly catalogVersion: string;
  readonly totalFamilyCount: number;
  readonly implementedFamilyCount: number;
  readonly executionCoveredFamilyCount: number;
  readonly fakeCoveredFamilyCount: number;
  readonly replayedCoveredFamilyCount: number;
  readonly liveCoveredFamilyCount: number;
  readonly providerNativeSupportedFamilyCount: number;
  readonly taskCoveredFamilyCount: number;
  readonly safetyCoveredFamilyCount: number;
  readonly absentFamilyCount: number;
  readonly plannedFamilyCount: number;
  readonly unavailableFamilyCount: number;
  readonly notApplicableFamilyCount: number;
  readonly passedFamilyCount: number;
  readonly objectiveScore: number;
  readonly deliveryCapabilityScore: number;
  readonly deliveryCapabilityTargetScore: number;
  readonly deliveryCapabilityTargetFamilyCount: number;
  readonly deliveryCapabilityPassedFamilyCount: number;
  readonly deliveryCapabilityPassed: boolean;
  readonly deliveryCapabilityBlockingFamilyIds: readonly ToolFamilyId[];
  readonly scorecards: readonly ToolFamilyScorecard[];
  readonly redaction: RedactionMetadata;
}
