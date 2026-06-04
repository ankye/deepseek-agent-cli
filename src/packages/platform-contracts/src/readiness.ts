import type { JsonObject, RedactionMetadata } from "./common.js";
import type { CommandId, CredentialRef } from "./ids.js";
import type { ModelProviderProtocol } from "./model.js";
import type { IndexProviderDiagnosticsSummary } from "./index-provider.js";
import type { ModelLiveVerificationResult } from "./model.js";
import type { PackageScorecardReleaseAdvisory } from "./package-scorecard.js";

export const DIAGNOSTICS_READINESS_SCHEMA_VERSION = "1.0.0";

export type ReadinessStatus = "pass" | "warn" | "fail";
export type ReleaseVerificationSummaryStatus = "ready" | "warn" | "blocked";
export type AcceptanceEvidenceRefreshMode = "default" | "full";
export type GovernanceDiagnosticsSectionId =
  | "governance.kernel-boundary"
  | "governance.uapi-compatibility"
  | "governance.context-cache-health"
  | "governance.bus-pressure"
  | "governance.policy-gates"
  | "governance.agent-scopes"
  | "governance.module-status"
  | "governance.roadmap-drift"
  | "governance.evidence-matrix";
export type GovernanceFindingSeverity = "info" | "warning" | "release-blocking";
export type GovernanceMaturityState =
  | "implemented"
  | "partial"
  | "rollout-gated"
  | "deferred"
  | "placeholder"
  | "evidence-missing"
  | "unsupported"
  | "product-ready";
export type GovernanceEvidenceType =
  | "contract"
  | "integration"
  | "golden"
  | "matrix"
  | "e2e"
  | "live-smoke"
  | "acceptance"
  | "readiness";
export type GovernanceEvidenceRiskTier = "critical" | "product" | "platform" | "extension" | "support";
export type GovernanceEvidenceStatus = "present" | "missing" | "not-required";
export type GovernanceEvidenceProductReadinessStatus = "ready" | "gated" | "not-product-scope";

export type ReadinessCommandName = "init" | "config" | "auth" | "doctor" | "privacy" | "verify-install";
export type DiagnosticsCommandName = "bundle" | "release" | "doctor" | "verify" | "refresh" | "evaluate";

export interface ReleasePackageSurface extends JsonObject {
  readonly schemaVersion: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly executableName: string;
  readonly binEntry: string;
  readonly buildOutputPath: string;
  readonly buildOutputExists?: boolean;
  readonly sourcePackageManifestFound?: boolean;
  readonly publishAccess: "public" | "restricted" | "private";
  readonly expectedPackageFiles: readonly string[];
  readonly packageSurfaceFiles?: readonly string[];
  readonly unexpectedPackageFiles?: readonly string[];
  readonly excludedFromSource: readonly string[];
  readonly generatedBundlePath: string;
  readonly generatedBundleIgnored: boolean;
  readonly redaction: RedactionMetadata;
}

export interface ReleaseEvidenceFileStatus extends JsonObject {
  readonly path: string;
  readonly exists: boolean;
  readonly required: boolean;
  readonly redaction: RedactionMetadata;
}

export interface ReleaseLiveEvidenceFileStatus extends JsonObject {
  readonly path: string;
  readonly exists: boolean;
  readonly required: boolean;
  readonly status: ReadinessStatus;
  readonly message: string;
  readonly redaction: RedactionMetadata;
}

export interface ReleaseLiveEvidenceSummary extends JsonObject {
  readonly schemaVersion: string;
  readonly status: ReadinessStatus;
  readonly requiredEvidencePaths: readonly string[];
  readonly files: readonly ReleaseLiveEvidenceFileStatus[];
  readonly providerParityEvidence?: readonly ReleaseLiveEvidenceFileStatus[];
  readonly missingEvidencePaths: readonly string[];
  readonly invalidEvidencePaths: readonly string[];
  readonly overallDeliveryCapabilityScore?: number;
  readonly overallDeliveryCapabilityStatus?: string;
  readonly liveToolCoveredFamilyCount?: number;
  readonly redaction: RedactionMetadata;
}

export interface ReleasePublishDryRunEvidence extends JsonObject {
  readonly path: string;
  readonly exists: boolean;
  readonly command: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly status: ReadinessStatus;
  readonly versionMatches: boolean;
  readonly collisionDetected: boolean;
  readonly npmErrorDetected: boolean;
  readonly message: string;
  readonly preview: string;
  readonly redaction: RedactionMetadata;
}

export interface ReleaseVerificationEvidence extends JsonObject {
  readonly schemaVersion: string;
  readonly requiredCommands: readonly string[];
  readonly acceptanceEvidencePaths: readonly string[];
  readonly acceptanceEvidenceFiles?: readonly ReleaseEvidenceFileStatus[];
  readonly missingAcceptanceEvidencePaths?: readonly string[];
  readonly publishDryRunEvidence?: ReleasePublishDryRunEvidence;
  readonly liveEvidence?: ReleaseLiveEvidenceSummary;
  readonly referencePitFixtureIds: readonly string[];
  readonly dryRunCommand: string;
  readonly rollbackGuidance: string;
  readonly redaction: RedactionMetadata;
}

export interface SupportBundlePolicyEvidence extends JsonObject {
  readonly schemaVersion: string;
  readonly localDiagnosticsAvailable: boolean;
  readonly externalExportAllowed: boolean;
  readonly externalExportReasonCode: string;
  readonly visibleReasoningPolicy: "redacted-summary-and-projection-fingerprint-only";
  readonly visibleReasoningRawProviderReasoningAllowed: boolean;
  readonly visibleReasoningExportFields: readonly string[];
  readonly referencePitFixtureIds: readonly string[];
  readonly redaction: RedactionMetadata;
}

export interface FirstPartyPluginPackReadinessEvidence extends JsonObject {
  readonly schemaVersion: string;
  readonly status: ReadinessStatus;
  readonly packId: string;
  readonly packVersion: string;
  readonly pluginCount: number;
  readonly commandCount: number;
  readonly paletteEntryCount: number;
  readonly resultListProviderCount: number;
  readonly keymapCount: number;
  readonly rendererHintCount: number;
  readonly manifestIds: readonly string[];
  readonly diagnostics: readonly JsonObject[];
  readonly referencePitFixtureIds: readonly string[];
  readonly redaction: RedactionMetadata;
}

export interface DiagnosticsReleaseReadinessEvidence extends JsonObject {
  readonly schemaVersion: string;
  readonly status: ReadinessStatus;
  readonly packageSurface: ReleasePackageSurface;
  readonly verification: ReleaseVerificationEvidence;
  readonly supportBundle: SupportBundlePolicyEvidence;
  readonly firstPartyPluginPack?: FirstPartyPluginPackReadinessEvidence;
  readonly packageScorecardAdvisory?: PackageScorecardReleaseAdvisory;
  readonly governanceEvidenceMatrix?: GovernanceEvidenceMatrixSummary;
  readonly governanceDiagnostics?: GovernanceDiagnosticsSummary;
  readonly checks: readonly ReadinessCheck[];
  readonly redaction: RedactionMetadata;
}

export interface GovernanceProductReadyClaim extends JsonObject {
  readonly capability: string;
  readonly ownerPackage?: string;
  readonly claimedState: "product-ready";
  readonly evidenceIds?: readonly string[];
  readonly redaction: RedactionMetadata;
}

export interface GovernanceDiagnosticsFilter extends JsonObject {
  readonly severities?: readonly GovernanceFindingSeverity[];
  readonly ownerPackages?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly redaction: RedactionMetadata;
}

export interface GovernanceDiagnosticFinding extends JsonObject {
  readonly id: string;
  readonly sectionId: GovernanceDiagnosticsSectionId;
  readonly capability: string;
  readonly ownerPackage: string;
  readonly affectedPackages: readonly string[];
  readonly affectedCapabilities: readonly string[];
  readonly severity: GovernanceFindingSeverity;
  readonly maturityState: GovernanceMaturityState;
  readonly status: ReadinessStatus;
  readonly message: string;
  readonly evidenceIds: readonly string[];
  readonly sourceCheckId?: string;
  readonly nextAction: string;
  readonly releaseBlocking: boolean;
  readonly redaction: RedactionMetadata;
}

export interface GovernanceDiagnosticsSection extends JsonObject {
  readonly sectionId: GovernanceDiagnosticsSectionId;
  readonly label: string;
  readonly ownerPackage: string;
  readonly capability: string;
  readonly status: ReadinessStatus;
  readonly maturityState: GovernanceMaturityState;
  readonly findings: readonly GovernanceDiagnosticFinding[];
  readonly summary: string;
  readonly redaction: RedactionMetadata;
}

export interface GovernanceDiagnosticsSummary extends JsonObject {
  readonly schemaVersion: string;
  readonly status: ReadinessStatus;
  readonly sections: readonly GovernanceDiagnosticsSection[];
  readonly findings: readonly GovernanceDiagnosticFinding[];
  readonly filters?: GovernanceDiagnosticsFilter;
  readonly redaction: RedactionMetadata;
}

export interface GovernanceEvidenceItem extends JsonObject {
  readonly type: GovernanceEvidenceType;
  readonly status: GovernanceEvidenceStatus;
  readonly evidenceIds: readonly string[];
  readonly required: boolean;
  readonly redaction: RedactionMetadata;
}

export interface GovernanceEvidenceMatrixRecord extends JsonObject {
  readonly id: string;
  readonly packageName: string;
  readonly capability: string;
  readonly ownerPackage: string;
  readonly riskTier: GovernanceEvidenceRiskTier;
  readonly maturityState: GovernanceMaturityState;
  readonly hostSurface?: "cli" | "vscode" | "server" | "api" | "browser" | "native" | "none";
  readonly productReadiness: GovernanceEvidenceProductReadinessStatus;
  readonly requiredEvidenceTypes: readonly GovernanceEvidenceType[];
  readonly evidence: readonly GovernanceEvidenceItem[];
  readonly missingEvidenceTypes: readonly GovernanceEvidenceType[];
  readonly severity: GovernanceFindingSeverity;
  readonly promotionBlocker: boolean;
  readonly nextAction: string;
  readonly redaction: RedactionMetadata;
}

export interface GovernanceEvidenceMatrixSummary extends JsonObject {
  readonly schemaVersion: string;
  readonly kind: "governance.evidence-matrix";
  readonly status: ReadinessStatus;
  readonly records: readonly GovernanceEvidenceMatrixRecord[];
  readonly recordCount: number;
  readonly readyCount: number;
  readonly gatedCount: number;
  readonly promotionBlockerCount: number;
  readonly evidenceTypes: readonly GovernanceEvidenceType[];
  readonly riskTiers: readonly GovernanceEvidenceRiskTier[];
  readonly findings: readonly GovernanceDiagnosticFinding[];
  readonly redaction: RedactionMetadata;
}

export interface ReleaseVerificationSummary extends JsonObject {
  readonly schemaVersion: string;
  readonly kind: "release.verification.summary";
  readonly status: ReleaseVerificationSummaryStatus;
  readonly releaseStatus: ReadinessStatus;
  readonly blockingChecks: readonly ReadinessCheck[];
  readonly warningChecks: readonly ReadinessCheck[];
  readonly missingAcceptanceEvidencePaths: readonly string[];
  readonly requiredCommands: readonly string[];
  readonly nextAction: string;
  readonly dryRunCommand: string;
  readonly publishDryRunReady: boolean;
  readonly referencePitFixtureIds: readonly string[];
  readonly redaction: RedactionMetadata;
}

export interface AcceptanceEvidenceRefreshStep extends JsonObject {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly outputPath: string;
  readonly required: boolean;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly status: ReadinessStatus;
  readonly redaction: RedactionMetadata;
}

export interface AcceptanceEvidenceRefreshSummary extends JsonObject {
  readonly schemaVersion: string;
  readonly kind: "acceptance.evidence.refresh.summary";
  readonly mode: AcceptanceEvidenceRefreshMode;
  readonly dryRun: boolean;
  readonly status: ReadinessStatus;
  readonly steps: readonly AcceptanceEvidenceRefreshStep[];
  readonly refreshedPaths: readonly string[];
  readonly failedStepIds: readonly string[];
  readonly diagnostics: readonly ReadinessCheck[];
  readonly nextAction: string;
  readonly referencePitFixtureIds: readonly string[];
  readonly redaction: RedactionMetadata;
}

export interface ReadinessCheck extends JsonObject {
  readonly id: string;
  readonly label: string;
  readonly status: ReadinessStatus;
  readonly message: string;
  readonly metadata?: JsonObject;
  readonly suggestedActions?: readonly string[];
  readonly redaction: RedactionMetadata;
}

export type ReadinessModelProviderName = "deepseek" | "glm";

export interface ReadinessModelProviderMetadata extends JsonObject {
  readonly provider: ReadinessModelProviderName;
  readonly protocol: ModelProviderProtocol;
  readonly model: string;
  readonly label: string;
}

export interface ReadinessCredentialReference extends JsonObject {
  readonly ref: CredentialRef;
  readonly provider: ReadinessModelProviderName;
  readonly source: "process-env" | "env-file" | "secure-storage" | "fake-storage" | "missing";
  readonly available: boolean;
  readonly redaction: RedactionMetadata;
}

export interface ReadinessCommandResult extends JsonObject {
  readonly commandId: CommandId;
  readonly command: ReadinessCommandName;
  readonly status: ReadinessStatus;
  readonly checks: readonly ReadinessCheck[];
  readonly warnings: readonly string[];
  readonly metadata: JsonObject;
  readonly suggestedActions: readonly string[];
  readonly credential?: ReadinessCredentialReference;
  readonly live?: ModelLiveVerificationResult;
  readonly indexProviders?: IndexProviderDiagnosticsSummary;
  readonly redaction: RedactionMetadata;
}

export interface ReadinessLiveCheckInput extends JsonObject {
  readonly enabled: boolean;
  readonly timeoutMs?: number;
}
