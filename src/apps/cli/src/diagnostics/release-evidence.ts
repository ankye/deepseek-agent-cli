import { join } from "node:path";
import type {
  DiagnosticsReleaseReadinessEvidence,
  FirstPartyPluginPackReadinessEvidence,
  GovernanceEvidenceMatrixSummary,
  GovernanceProductReadyClaim,
  JsonObject,
  ReadinessCheck,
  ReleaseLiveEvidenceFileStatus,
  ReleaseLiveEvidenceSummary,
  ReleasePackageSurface,
  ReleasePublishDryRunEvidence,
  ReleaseVerificationEvidence,
  SupportBundlePolicyEvidence
} from "@deepseek/platform-contracts";
import { DIAGNOSTICS_READINESS_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import {
  FIRST_PARTY_PLUGIN_MANIFEST_BOUNDARY_PIT,
  FIRST_PARTY_PLUGIN_PERMISSION_DIFF_PIT,
  listFirstPartyDevPluginManifests,
  snapshotFirstPartyDevPluginPack,
  validateFirstPartyDevPluginPack
} from "@deepseek/first-party-dev-plugins";
import { InMemoryObservabilitySink } from "@deepseek/observability";
import { NodePlatformRuntime } from "@deepseek/platform-abstraction";
import { collectGovernanceEvidenceMatrix } from "@deepseek/testing-regression";
import { VISIBLE_REASONING_PROVIDER_REASONING_PIT, VISIBLE_REASONING_SECRET_REDACTION_PIT } from "@deepseek/platform-contracts";
import { collectPlatformContractsUapiGovernanceEvidence, platformContractsUapiGovernanceCheck } from "./uapi-governance.js";
import { collectRuntimeKernelGovernanceEvidence, runtimeKernelGovernanceCheck } from "./runtime-kernel-governance.js";
import { collectRuntimePipesGovernanceEvidence, runtimePipesGovernanceCheck } from "./runtime-pipes-governance.js";
import { collectPolicySandboxGateGovernanceEvidence, policySandboxGateGovernanceCheck } from "./policy-gates-governance.js";
import { agentNamespaceQuotaGovernanceCheck, collectAgentNamespaceQuotaGovernanceEvidence } from "./agent-namespace-governance.js";
import { collectPluginModuleBoundaryGovernanceEvidence, pluginModuleBoundaryGovernanceCheck } from "./module-governance.js";
import { collectGovernanceDiagnostics, governanceProductReadyClaimCheck } from "./governance-diagnostics.js";
import { architectureDriftGovernanceCheck, collectArchitectureDriftGovernanceEvidence } from "./architecture-drift-governance.js";

export const diagnosticsSchemaVersion = DIAGNOSTICS_READINESS_SCHEMA_VERSION;
export const diagnosticPitIds = [
  "pit.diagnostic-redaction.support-bundle",
  "pit.env-snapshot.immutable-startup",
  VISIBLE_REASONING_SECRET_REDACTION_PIT,
  VISIBLE_REASONING_PROVIDER_REASONING_PIT
] as const;

export interface ReleaseReadinessEvidenceOptions {
  readonly productReadyClaims?: readonly GovernanceProductReadyClaim[];
}

export async function collectReleaseReadinessEvidence(options: ReleaseReadinessEvidenceOptions = {}): Promise<DiagnosticsReleaseReadinessEvidence> {
  const packageSurface = await releasePackageSurface();
  const supportBundle = supportBundlePolicyEvidence();
  const verification = await releaseVerificationEvidence(packageSurface);
  const firstPartyPluginPack = firstPartyPluginPackReadinessEvidence();
  const platformContractsUapi = collectPlatformContractsUapiGovernanceEvidence();
  const runtimeKernel = collectRuntimeKernelGovernanceEvidence();
  const runtimePipes = collectRuntimePipesGovernanceEvidence();
  const policyGates = collectPolicySandboxGateGovernanceEvidence();
  const agentNamespaces = collectAgentNamespaceQuotaGovernanceEvidence();
  const moduleBoundaries = collectPluginModuleBoundaryGovernanceEvidence();
  const architectureDrift = collectArchitectureDriftGovernanceEvidence();
  const governanceEvidenceMatrix = collectGovernanceEvidenceMatrix({
    productReadyClaims: options.productReadyClaims ?? []
  });
  const baseChecks = releaseReadinessChecks(packageSurface, supportBundle, verification, firstPartyPluginPack, runtimeKernel, platformContractsUapi, runtimePipes, policyGates, agentNamespaces, moduleBoundaries, architectureDrift, governanceEvidenceMatrix);
  const governanceDiagnostics = collectGovernanceDiagnostics({
    checks: baseChecks,
    verification,
    productReadyClaims: options.productReadyClaims ?? []
  });
  const productReadyCheck = governanceProductReadyClaimCheck(governanceDiagnostics);
  const checks = productReadyCheck ? [...baseChecks, productReadyCheck] : baseChecks;
  const status = checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "warn") ? "warn" : "pass";
  return {
    schemaVersion: diagnosticsSchemaVersion,
    status,
    packageSurface,
    verification,
    supportBundle,
    firstPartyPluginPack,
    governanceEvidenceMatrix,
    governanceDiagnostics,
    checks,
    redaction: { class: "internal", fields: ["packageSurface.buildOutputPath", "verification.acceptanceEvidencePaths", "firstPartyPluginPack.diagnostics", "governanceEvidenceMatrix.records.evidence.evidenceIds", "governanceEvidenceMatrix.findings.message", "governanceEvidenceMatrix.findings.nextAction", "governanceDiagnostics.findings.message", "governanceDiagnostics.findings.nextAction", "checks.metadata.evidence.compatibilityShims", "checks.metadata.evidence.surfaces.exportedNames", "checks.metadata.evidence.streams.description", "checks.metadata.evidence.fixtureRecords.reason", "checks.metadata.evidence.fixtures.operation.path", "checks.metadata.evidence.fixtures.policyEvaluations.policyRequest"] }
  };
}

export async function releasePackageSurface(): Promise<ReleasePackageSurface> {
  const packageJson = await cliPackageJson();
  const sourcePackageManifestFound = await fileExists("src/apps/cli/package.json");
  const bin = packageJson.bin && typeof packageJson.bin === "object" ? packageJson.bin as Record<string, unknown> : {};
  const files = Array.isArray(packageJson.files) ? packageJson.files.filter((value): value is string => typeof value === "string") : [];
  const expectedPackageFiles = files.length > 0 ? files : ["dist", "README.md"];
  const binEntry = stringValue(bin.deepseek, "dist/index.js");
  const exportsEntry = typeof packageJson.exports === "string"
    ? packageJson.exports.replace(/^\.\//, "")
    : packageJson.exports && typeof packageJson.exports === "object"
      ? stringValue((packageJson.exports as Record<string, unknown>)["."], "").replace(/^\.\//, "")
      : "";
  const packageSurfaceFiles = [...new Set(["README.md", "package.json", binEntry, ...(exportsEntry ? [exportsEntry] : []), ...expectedPackageFiles])].sort();
  const unexpectedPackageFiles = packageSurfaceFiles.filter((file) => !isAllowedPackageSurfaceFile(file));
  const buildOutputPath = "src/apps/cli/dist/index.js";
  return {
    schemaVersion: diagnosticsSchemaVersion,
    packageName: stringValue(packageJson.name, "deepseek-agent-cli"),
    packageVersion: stringValue(packageJson.version, "0.0.0"),
    executableName: Object.keys(bin)[0] ?? "deepseek",
    binEntry,
    buildOutputPath,
    ...(sourcePackageManifestFound ? { buildOutputExists: await fileExists(buildOutputPath) } : {}),
    sourcePackageManifestFound,
    publishAccess: packageJson.publishConfig && typeof packageJson.publishConfig === "object" && (packageJson.publishConfig as Record<string, unknown>).access === "public" ? "public" : "private",
    expectedPackageFiles,
    packageSurfaceFiles,
    unexpectedPackageFiles,
    excludedFromSource: [".codex/", ".env", "node_modules/", "src/apps/cli/dist/", "参考/"],
    generatedBundlePath: "src/apps/cli/dist/",
    generatedBundleIgnored: true,
    redaction: { class: "internal", fields: ["buildOutputPath", "generatedBundlePath", "excludedFromSource"] }
  };
}

export async function releaseVerificationEvidence(packageSurface?: ReleasePackageSurface): Promise<ReleaseVerificationEvidence> {
  const acceptanceEvidencePaths = [
    ...baseAcceptanceEvidencePaths(),
    ...liveAcceptanceEvidencePaths()
  ];
  const dryRunCommand = "npm publish --dry-run --workspace deepseek-agent-cli --access public";
  const liveEvidence = await collectLiveReleaseEvidence();
  const publishDryRunEvidence = await collectPublishDryRunEvidence(packageSurface, dryRunCommand);
  return {
    schemaVersion: diagnosticsSchemaVersion,
    requiredCommands: [
      "openspec validate --specs --strict",
      "npm run typecheck",
      "npm run lint",
      "npm test",
      "node scripts/check-boundaries.mjs",
      "npm run build:cli",
      "npm run smoke:headless",
      "DEEPSEEK_LIVE_TESTS=1 npm run smoke:live:deepseek",
      "DEEPSEEK_LIVE_AGENT_LOOP_TESTS=1 npm run smoke:live:agent-loop",
      "DEEPSEEK_LIVE_AGENT_TOOL_TESTS=1 npm run smoke:live:agent-tools",
      "deepseek run --live --output jsonl",
      "deepseek doctor --live --output json",
      "npx tsx scripts/run-live-tool-coverage.ts",
      "deepseek diagnostics evaluate --full --execute-task all --live --output json",
      dryRunCommand
    ],
    acceptanceEvidencePaths,
    acceptanceEvidenceFiles: await Promise.all(acceptanceEvidencePaths.map(async (path) => ({
      path,
      exists: await fileExists(path),
      required: true,
      redaction: { class: "internal" as const, fields: ["path"] }
    }))),
    missingAcceptanceEvidencePaths: await missingPaths(acceptanceEvidencePaths),
    publishDryRunEvidence,
    liveEvidence,
    referencePitFixtureIds: [...diagnosticPitIds],
    dryRunCommand,
    rollbackGuidance: "Do not publish; fix failing readiness evidence and rerun diagnostics release.",
    redaction: { class: "internal", fields: ["acceptanceEvidencePaths", "liveEvidence.files.path", "liveEvidence.missingEvidencePaths", "liveEvidence.invalidEvidencePaths"] }
  };
}

function baseAcceptanceEvidencePaths(): readonly string[] {
  return [
    "tests/acceptance/acceptance-index.md",
    "tests/acceptance/latest/openspec-validation.txt",
    "tests/acceptance/latest/typecheck.txt",
    "tests/acceptance/latest/lint.txt",
    "tests/acceptance/latest/test-summary.txt",
    "tests/acceptance/latest/dependency-boundaries.txt",
    "tests/acceptance/latest/build-cli.txt",
    "tests/acceptance/latest/release-verify.txt",
    "tests/acceptance/latest/uapi-compatibility.txt",
    "tests/acceptance/latest/architecture-drift-guardrails.json",
    "tests/acceptance/latest/governance-evidence-matrix.json",
    "tests/acceptance/latest/smoke-headless.txt",
    "tests/acceptance/latest/reference-hygiene.txt",
    "tests/acceptance/latest/npm-publish-dry-run.txt"
  ];
}

function liveAcceptanceEvidencePaths(): readonly string[] {
  return [
    "tests/acceptance/latest/live-provider-smoke.txt",
    "tests/acceptance/latest/live-agent-loop-smoke.txt",
    "tests/acceptance/latest/live-agent-tool-smoke.txt",
    "tests/acceptance/latest/live-cli-run-smoke.txt",
    "tests/acceptance/latest/live-doctor-smoke.txt",
    "tests/acceptance/latest/live-tool-coverage.json",
    "tests/acceptance/latest/tool-family-delivery-capability-score.json",
    "tests/acceptance/latest/deepseek-provider-response-cache.json",
    "tests/acceptance/latest/overall-delivery-capability-score.json"
  ];
}

export function supportBundlePolicyEvidence(): SupportBundlePolicyEvidence {
  const sink = new InMemoryObservabilitySink();
  const decision = sink.decideExport("support-upload");
  return {
    schemaVersion: diagnosticsSchemaVersion,
    localDiagnosticsAvailable: true,
    externalExportAllowed: decision.exportAllowed,
    externalExportReasonCode: decision.reasonCode,
    visibleReasoningPolicy: "redacted-summary-and-projection-fingerprint-only",
    visibleReasoningRawProviderReasoningAllowed: false,
    visibleReasoningExportFields: ["recordId", "stepKind", "status", "certainty", "summary", "evidenceLinkCount", "evidenceFingerprints", "projectionId", "replayFingerprint", "summary"],
    referencePitFixtureIds: [...diagnosticPitIds],
    redaction: { class: "internal", fields: ["externalExportReasonCode", "visibleReasoningExportFields"] }
  };
}

export function releaseReadinessChecks(
  packageSurface: ReleasePackageSurface,
  supportBundle: SupportBundlePolicyEvidence,
  verification: ReleaseVerificationEvidence,
  firstPartyPluginPack?: FirstPartyPluginPackReadinessEvidence,
  runtimeKernel = collectRuntimeKernelGovernanceEvidence(),
  platformContractsUapi = collectPlatformContractsUapiGovernanceEvidence(),
  runtimePipes = collectRuntimePipesGovernanceEvidence(),
  policyGates = collectPolicySandboxGateGovernanceEvidence(),
  agentNamespaces = collectAgentNamespaceQuotaGovernanceEvidence(),
  moduleBoundaries = collectPluginModuleBoundaryGovernanceEvidence(),
  architectureDrift = collectArchitectureDriftGovernanceEvidence(),
  governanceEvidenceMatrix = collectGovernanceEvidenceMatrix()
): readonly ReadinessCheck[] {
  return [
    readinessCheck("release.package", "CLI package metadata", packageSurface.packageName === "deepseek-agent-cli" ? "pass" : "fail", `${packageSurface.packageName}@${packageSurface.packageVersion}`, [], { packageName: packageSurface.packageName, packageVersion: packageSurface.packageVersion }),
    readinessCheck("release.bin", "CLI executable", packageSurface.executableName === "deepseek" && packageSurface.binEntry === "dist/index.js" ? "pass" : "fail", `${packageSurface.executableName} -> ${packageSurface.binEntry}`, [], { executableName: packageSurface.executableName, binEntry: packageSurface.binEntry }),
    readinessCheck("release.build-output", "CLI build artifact", packageSurface.sourcePackageManifestFound === false ? "warn" : packageSurface.buildOutputExists === true ? "pass" : "fail", packageSurface.sourcePackageManifestFound === false ? "Source package manifest is unavailable from this working directory; build artifact check is deferred." : packageSurface.buildOutputExists === true ? `${packageSurface.buildOutputPath} exists.` : `${packageSurface.buildOutputPath} is missing.`, packageSurface.sourcePackageManifestFound === false ? ["Run diagnostics release from the repository root before publishing."] : packageSurface.buildOutputExists === true ? [] : ["Run npm run build:cli before publishing."], { buildOutputPath: packageSurface.buildOutputPath, buildOutputExists: packageSurface.buildOutputExists, sourcePackageManifestFound: packageSurface.sourcePackageManifestFound }),
    readinessCheck("release.package-files", "Package files", packageSurface.expectedPackageFiles.includes("dist") && packageSurface.expectedPackageFiles.includes("README.md") ? "pass" : "warn", `Expected package files: ${packageSurface.expectedPackageFiles.join(", ")}.`, ["Keep npm tarball limited to README.md, dist/index.js, and package metadata."], { expectedPackageFiles: packageSurface.expectedPackageFiles }),
    readinessCheck("release.package-surface", "Package surface safety", (packageSurface.unexpectedPackageFiles?.length ?? 0) === 0 ? "pass" : "fail", (packageSurface.unexpectedPackageFiles?.length ?? 0) === 0 ? `Package surface limited to ${packageSurface.packageSurfaceFiles?.join(", ")}.` : `Unexpected package files: ${packageSurface.unexpectedPackageFiles?.join(", ")}.`, (packageSurface.unexpectedPackageFiles?.length ?? 0) === 0 ? [] : ["Restrict src/apps/cli/package.json files/bin/exports to README.md and dist output."], { packageSurfaceFiles: packageSurface.packageSurfaceFiles ?? [], unexpectedPackageFiles: packageSurface.unexpectedPackageFiles ?? [] }),
    readinessCheck("release.generated-hygiene", "Generated bundle hygiene", packageSurface.generatedBundleIgnored ? "pass" : "fail", "Generated CLI dist bundle is treated as ignored local output.", [], { generatedBundlePath: packageSurface.generatedBundlePath }),
    readinessCheck("release.live-evidence", "DeepSeek live release evidence", verification.liveEvidence?.status ?? "fail", liveEvidenceMessage(verification.liveEvidence), liveEvidenceActions(verification.liveEvidence), { evidence: verification.liveEvidence ?? {} }),
    readinessCheck("release.publish-dry-run", "npm publish dry-run", verification.publishDryRunEvidence?.status ?? "fail", verification.publishDryRunEvidence?.message ?? "npm publish dry-run evidence is missing.", publishDryRunActions(verification.publishDryRunEvidence), { evidence: verification.publishDryRunEvidence ?? {} }),
    readinessCheck("release.support-bundle", "Support bundle policy", supportBundle.localDiagnosticsAvailable && !supportBundle.externalExportAllowed && !supportBundle.visibleReasoningRawProviderReasoningAllowed ? "pass" : "warn", `External export policy: ${supportBundle.externalExportReasonCode}; visible reasoning=${supportBundle.visibleReasoningPolicy}.`, [], { externalExportAllowed: supportBundle.externalExportAllowed, visibleReasoningPolicy: supportBundle.visibleReasoningPolicy, referencePitFixtureIds: supportBundle.referencePitFixtureIds }),
    platformContractsUapiGovernanceCheck(platformContractsUapi),
    runtimeKernelGovernanceCheck(runtimeKernel),
    runtimePipesGovernanceCheck(runtimePipes),
    policySandboxGateGovernanceCheck(policyGates),
    agentNamespaceQuotaGovernanceCheck(agentNamespaces),
    pluginModuleBoundaryGovernanceCheck(moduleBoundaries),
    architectureDriftGovernanceCheck(architectureDrift),
    governanceEvidenceMatrixCheck(governanceEvidenceMatrix),
    readinessCheck("release.first-party-dev-plugins", "First-party dev plugin pack", firstPartyPluginPack?.status ?? "fail", firstPartyPluginPack ? `${firstPartyPluginPack.pluginCount} plugin(s), ${firstPartyPluginPack.commandCount} command(s), diagnostics=${firstPartyPluginPack.diagnostics.length}.` : "First-party plugin pack evidence is missing.", firstPartyPluginPack?.status === "pass" ? [] : ["Fix first-party plugin manifest validation before release."], { firstPartyPluginPack: firstPartyPluginPack ?? {} }),
    readinessCheck("release.acceptance", "Acceptance evidence", (verification.missingAcceptanceEvidencePaths?.length ?? 0) === 0 ? "pass" : "warn", (verification.missingAcceptanceEvidencePaths?.length ?? 0) === 0 ? `${verification.acceptanceEvidencePaths.length} acceptance evidence files present.` : `Missing acceptance evidence: ${verification.missingAcceptanceEvidencePaths?.join(", ")}.`, (verification.missingAcceptanceEvidencePaths?.length ?? 0) === 0 ? [] : ["Refresh tests/acceptance/latest evidence before publishing."], { requiredCommands: verification.requiredCommands, acceptanceEvidencePaths: verification.acceptanceEvidencePaths, missingAcceptanceEvidencePaths: verification.missingAcceptanceEvidencePaths ?? [] })
  ];
}

export function governanceEvidenceMatrixCheck(matrix: GovernanceEvidenceMatrixSummary): ReadinessCheck {
  const blocking = matrix.findings.filter((finding) => finding.releaseBlocking);
  return readinessCheck(
    "governance.evidence-matrix",
    "Governance evidence matrix",
    blocking.length > 0 ? "fail" : "pass",
    `Evidence matrix records=${matrix.recordCount}, ready=${matrix.readyCount}, gated=${matrix.gatedCount}, blockers=${blocking.length}.`,
    blocking.length > 0
      ? ["Attach required evidence or downgrade product-ready claims before promotion."]
      : [],
    { evidence: matrix }
  );
}

function firstPartyPluginPackReadinessEvidence(): FirstPartyPluginPackReadinessEvidence {
  const manifests = listFirstPartyDevPluginManifests();
  const validation = validateFirstPartyDevPluginPack(manifests);
  const snapshot = snapshotFirstPartyDevPluginPack();
  const status: ReadinessCheck["status"] = validation.ok && snapshot.pluginCount === 6 && snapshot.commandCount === 26 ? "pass" : "fail";
  return {
    schemaVersion: diagnosticsSchemaVersion,
    status,
    packId: snapshot.packId,
    packVersion: snapshot.packVersion,
    pluginCount: snapshot.pluginCount,
    commandCount: snapshot.commandCount,
    paletteEntryCount: snapshot.paletteEntryCount,
    resultListProviderCount: snapshot.resultListProviderCount,
    keymapCount: snapshot.keymapCount,
    rendererHintCount: snapshot.rendererHintCount,
    manifestIds: manifests.map((manifest) => manifest.id),
    diagnostics: validation.errors as readonly JsonObject[],
    referencePitFixtureIds: [FIRST_PARTY_PLUGIN_MANIFEST_BOUNDARY_PIT, FIRST_PARTY_PLUGIN_PERMISSION_DIFF_PIT],
    redaction: { class: "internal", fields: ["diagnostics"] }
  };
}

async function collectLiveReleaseEvidence(): Promise<ReleaseLiveEvidenceSummary> {
  const files = await Promise.all(liveAcceptanceEvidencePaths().map((path) => liveEvidenceFileStatus(path)));
  const providerParityEvidence = await Promise.all(providerParityLiveEvidencePaths().map((path) => liveEvidenceFileStatus(path, false)));
  const missingEvidencePaths = files.filter((file) => !file.exists).map((file) => file.path);
  const invalidEvidencePaths = files.filter((file) => file.exists && file.status !== "pass").map((file) => file.path);
  const overall = await readJsonFile("tests/acceptance/latest/overall-delivery-capability-score.json");
  const toolCoverage = await readJsonFile("tests/acceptance/latest/live-tool-coverage.json");
  const overallDeliveryCapabilityScore = numberValue(overall?.score);
  const overallDeliveryCapabilityStatus = typeof overall?.status === "string" ? overall.status : undefined;
  const liveToolCoveredFamilyCount = numberValue(getNested(toolCoverage, ["summary", "passedToolCount"]));
  const status: ReadinessCheck["status"] = missingEvidencePaths.length > 0 || invalidEvidencePaths.length > 0 ? "fail" : "pass";
  return {
    schemaVersion: diagnosticsSchemaVersion,
    status,
    requiredEvidencePaths: liveAcceptanceEvidencePaths(),
    files,
    providerParityEvidence,
    missingEvidencePaths,
    invalidEvidencePaths,
    ...(overallDeliveryCapabilityScore !== undefined ? { overallDeliveryCapabilityScore } : {}),
    ...(overallDeliveryCapabilityStatus ? { overallDeliveryCapabilityStatus } : {}),
    ...(liveToolCoveredFamilyCount !== undefined ? { liveToolCoveredFamilyCount } : {}),
    redaction: { class: "internal", fields: ["files.path", "providerParityEvidence.path", "missingEvidencePaths", "invalidEvidencePaths"] }
  };
}

function providerParityLiveEvidencePaths(): readonly string[] {
  return [
    "tests/acceptance/latest/glm-live-provider-smoke.txt",
    "tests/acceptance/latest/glm-live-agent-tool-smoke.txt",
    "tests/acceptance/latest/glm-live-doctor-smoke.txt"
  ];
}

async function liveEvidenceFileStatus(path: string, required = true): Promise<ReleaseLiveEvidenceFileStatus> {
  const platform = new NodePlatformRuntime();
  const raw = await platform.readFile(join(process.cwd(), path)).catch(() => "");
  const exists = raw.length > 0;
  if (!exists) return liveFile(path, false, required, required ? "fail" : "warn", `${path} is missing.`);
  if (path.endsWith(".txt")) {
    const passed = liveTextEvidencePasses(path, raw);
    return liveFile(path, true, required, passed ? "pass" : "fail", passed ? `${path} contains passing live evidence.` : `${path} does not prove a non-skipped live pass.`);
  }
  if (path.endsWith("live-tool-coverage.json")) {
    const parsed = safeJson(raw);
    const passed = parsed?.kind === "deepseek.live-tool-coverage"
      && parsed.executionMode === "live"
      && parsed.replayOnly === false
      && getNested(parsed, ["summary", "passedToolCount"]) === 64
      && getNested(parsed, ["summary", "providerRequestMode"]) === "live";
    return liveFile(path, true, required, passed ? "pass" : "fail", passed ? `${path} proves live tool coverage.` : `${path} is missing live tool coverage proof.`);
  }
  if (path.endsWith("tool-family-delivery-capability-score.json")) {
    const parsed = safeJson(raw);
    const passed = parsed?.kind === "tool-family.delivery-capability-score.evidence"
      && parsed.deliveryCapabilityPassed === true
      && parsed.fakeCoveredFamilyCount === 0
      && parsed.replayedCoveredFamilyCount === 0
      && parsed.liveCoveredFamilyCount === 64;
    return liveFile(path, true, required, passed ? "pass" : "fail", passed ? `${path} proves live tool-family delivery capability.` : `${path} is missing strict live tool-family delivery proof.`);
  }
  if (path.endsWith("deepseek-provider-response-cache.json")) {
    const parsed = safeJson(raw);
    const entryCount = numberValue(parsed?.entryCount) ?? (Array.isArray(parsed?.entries) ? parsed.entries.length : 0);
    const passed = parsed?.kind === "deepseek.provider-response-cache"
      && entryCount > 0
      && parsed.sourceEvidencePath === "tests/acceptance/latest/live-tool-coverage.json";
    return liveFile(path, true, required, passed ? "pass" : "fail", passed ? `${path} contains cached live provider responses for regression.` : `${path} does not contain live provider response cache records.`);
  }
  if (path.endsWith("overall-delivery-capability-score.json")) {
    const parsed = safeJson(raw);
    const dimensionIds = Array.isArray(parsed?.dimensions) ? parsed.dimensions.map((dimension: unknown) => isJsonObject(dimension) ? dimension.dimensionId : "") : [];
    const passed = parsed?.kind === "cli.overall-delivery-capability-score.evidence"
      && parsed.status === "pass"
      && typeof parsed.score === "number"
      && parsed.score >= 0.9
      && dimensionIds.includes("deepseek-api")
      && dimensionIds.includes("memory")
      && dimensionIds.includes("cache-observability");
    return liveFile(path, true, required, passed ? "pass" : "fail", passed ? `${path} proves current-schema overall delivery capability.` : `${path} is stale or does not prove all current delivery dimensions.`);
  }
  return liveFile(path, true, required, "pass", `${path} exists.`);
}

function liveTextEvidencePasses(path: string, raw: string): boolean {
  const normalized = raw.toLowerCase();
  if (/# (fail|cancelled|todo) [1-9]/.test(normalized)) return false;
  if (/# skipped [1-9]/.test(normalized) || normalized.includes("testcontext.skip")) return false;
  if (path.endsWith("live-cli-run-smoke.txt")) return liveCliRunSmokePasses(raw);
  if (path.endsWith("glm-live-doctor-smoke.txt")) return glmLiveDoctorSmokePasses(raw);
  if (path.endsWith("live-doctor-smoke.txt")) return liveDoctorSmokePasses(raw);
  return /# pass [1-9]\d*/.test(normalized) && normalized.includes("# skipped 0");
}

function liveCliRunSmokePasses(raw: string): boolean {
  return !/DeepSeek mock response/i.test(raw)
    && jsonStringField(raw, "kind", "agent.loop.completed")
    && jsonStringField(raw, "kind", "model.finished")
    && jsonStringField(raw, "kind", "usage.updated")
    && jsonStringField(raw, "modelProvider", "provider-deepseek")
    && deepSeekProviderRequestEvidence(raw);
}

function liveDoctorSmokePasses(raw: string): boolean {
  return !/DeepSeek mock response/i.test(raw)
    && jsonBooleanField(raw, "liveRequested", true)
    && jsonBooleanField(raw, "reachable", true)
    && jsonStringField(raw, "id", "doctor.live")
    && deepSeekProviderRequestEvidence(raw);
}

function glmLiveDoctorSmokePasses(raw: string): boolean {
  return !/DeepSeek mock response/i.test(raw)
    && (jsonBooleanField(raw, "liveRequested", true) || jsonBooleanField(raw, "requested", true))
    && jsonBooleanField(raw, "reachable", true)
    && jsonStringField(raw, "id", "doctor.live")
    && glmProviderRequestEvidence(raw);
}

function deepSeekProviderRequestEvidence(raw: string): boolean {
  return jsonStringField(raw, "provider", "deepseek")
    && jsonStringField(raw, "protocol", "openai-chat-completions")
    && /"requestId"\s*:\s*"[^"]+"/.test(raw)
    && /"cache"\s*:\s*\{[^}]*"(hitTokens|missTokens)"\s*:\s*\d+/.test(raw);
}

function glmProviderRequestEvidence(raw: string): boolean {
  return jsonStringField(raw, "provider", "glm")
    && jsonStringField(raw, "protocol", "anthropic-messages")
    && (/"requestId"\s*:\s*"[^"]+"/.test(raw) || glmStreamCompletionEvidence(raw));
}

function glmStreamCompletionEvidence(raw: string): boolean {
  return jsonStringField(raw, "terminalStatus", "completed")
    && jsonArrayContains(raw, "eventKinds", "usage")
    && jsonArrayContains(raw, "eventKinds", "done");
}

function jsonStringField(raw: string, key: string, value: string): boolean {
  return new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"${escapeRegExp(value)}"`).test(raw);
}

function jsonBooleanField(raw: string, key: string, value: boolean): boolean {
  return new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*${value ? "true" : "false"}`).test(raw);
}

function jsonArrayContains(raw: string, key: string, value: string): boolean {
  return new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*\\[[^\\]]*"${escapeRegExp(value)}"`).test(raw);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function liveFile(path: string, exists: boolean, required: boolean, status: ReadinessCheck["status"], message: string): ReleaseLiveEvidenceFileStatus {
  return {
    path,
    exists,
    required,
    status,
    message,
    redaction: { class: "internal", fields: ["path"] }
  };
}

function liveEvidenceMessage(evidence: ReleaseLiveEvidenceSummary | undefined): string {
  if (!evidence) return "DeepSeek live release evidence is missing.";
  if (evidence.status === "pass") return `${evidence.files.length} live release evidence file(s) passed.`;
  const missing = evidence.missingEvidencePaths.length;
  const invalid = evidence.invalidEvidencePaths.length;
  return `DeepSeek live release evidence is not publish-ready: missing=${missing}, invalid=${invalid}.`;
}

function liveEvidenceActions(evidence: ReleaseLiveEvidenceSummary | undefined): readonly string[] {
  if (!evidence || evidence.status !== "pass") {
    return [
      "Run the live smoke commands, live tool coverage, and live full evaluation before npm publish dry-run.",
      "Refresh tests/acceptance/latest/overall-delivery-capability-score.json with current delivery dimensions."
    ];
  }
  return [];
}

async function collectPublishDryRunEvidence(packageSurface: ReleasePackageSurface | undefined, command: string): Promise<ReleasePublishDryRunEvidence> {
  const path = "tests/acceptance/latest/npm-publish-dry-run.txt";
  const packageName = packageSurface?.packageName ?? "deepseek-agent-cli";
  const packageVersion = packageSurface?.packageVersion ?? "0.0.0";
  const platform = new NodePlatformRuntime();
  const raw = await platform.readFile(join(process.cwd(), path)).catch(() => "");
  const exists = raw.length > 0;
  const preview = boundedPreview(raw);
  const packageToken = `${packageName}@${packageVersion}`;
  const versionMatches = exists && raw.includes(packageToken);
  const collisionDetected = /cannot publish over (the )?previously published versions|previously published versions/i.test(raw);
  const npmErrorDetected = /\bnpm\s+(ERR!|error)\b/i.test(raw);
  const tarballDetailsDetected = /Tarball Details|Tarball Contents/i.test(raw);
  const status: ReadinessCheck["status"] = !exists || collisionDetected || npmErrorDetected || !versionMatches ? "fail" : tarballDetailsDetected ? "pass" : "warn";
  const message = !exists
    ? `${path} is missing; run and save ${command}.`
    : collisionDetected
      ? `${packageToken} already exists on npm; publish dry-run is blocked.`
      : !versionMatches
        ? `${path} does not match ${packageToken}.`
        : npmErrorDetected
          ? `${path} contains npm error output.`
          : status === "pass"
            ? `${path} proves ${packageToken} publish dry-run packaging succeeds.`
            : `${path} exists but does not contain recognizable npm publish dry-run success evidence.`;
  return {
    path,
    exists,
    command,
    packageName,
    packageVersion,
    status,
    versionMatches,
    collisionDetected,
    npmErrorDetected,
    message,
    preview,
    redaction: { class: "internal", fields: ["preview"] }
  };
}

function publishDryRunActions(evidence: ReleasePublishDryRunEvidence | undefined): readonly string[] {
  if (!evidence?.exists) return [`Run ${evidence?.command ?? "npm publish --dry-run --workspace deepseek-agent-cli --access public"} and save output to tests/acceptance/latest/npm-publish-dry-run.txt.`];
  if (evidence.collisionDetected) return ["Bump src/apps/cli/package.json to an unpublished version, update package-lock.json, rebuild, and rerun npm publish --dry-run."];
  if (!evidence.versionMatches) return ["Refresh tests/acceptance/latest/npm-publish-dry-run.txt after the current package version changes."];
  if (evidence.npmErrorDetected) return ["Fix the npm publish dry-run error and refresh tests/acceptance/latest/npm-publish-dry-run.txt."];
  return evidence.status === "pass" ? [] : ["Refresh tests/acceptance/latest/npm-publish-dry-run.txt with a successful npm publish dry-run output."];
}

async function cliPackageJson(): Promise<Record<string, unknown>> {
  const platform = new NodePlatformRuntime();
  const raw = await platform.readFile(join(process.cwd(), "src/apps/cli/package.json")).catch(() => JSON.stringify({
    name: "deepseek-agent-cli",
    version: "0.0.0",
    exports: { ".": "./dist/index.js" },
    files: ["dist", "README.md"],
    bin: { deepseek: "dist/index.js" },
    publishConfig: { access: "public" }
  }));
  return JSON.parse(raw) as Record<string, unknown>;
}

async function readJsonFile(path: string): Promise<JsonObject | undefined> {
  const platform = new NodePlatformRuntime();
  const raw = await platform.readFile(join(process.cwd(), path)).catch(() => "");
  return safeJson(raw);
}

function safeJson(raw: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function getNested(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isJsonObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readinessCheck(id: string, label: string, status: ReadinessCheck["status"], message: string, suggestedActions: readonly string[] = [], metadata: JsonObject = {}): ReadinessCheck {
  return {
    id,
    label,
    status,
    message,
    metadata,
    suggestedActions,
    redaction: { class: "internal", fields: ["metadata"] }
  };
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedPackageSurfaceFile(file: string): boolean {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return normalized === "README.md" || normalized === "package.json" || normalized === "dist" || normalized === "dist/index.js";
}

async function fileExists(path: string): Promise<boolean> {
  const platform = new NodePlatformRuntime();
  try {
    await platform.statFile(join(process.cwd(), path));
    return true;
  } catch {
    return false;
  }
}

async function missingPaths(paths: readonly string[]): Promise<readonly string[]> {
  const statuses = await Promise.all(paths.map(async (path) => ({ path, exists: await fileExists(path) })));
  return statuses.filter((status) => !status.exists).map((status) => status.path);
}

function boundedPreview(value: string): string {
  const normalized = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  return normalized.length > 1000 ? `${normalized.slice(0, 1000)}...[truncated]` : normalized;
}
