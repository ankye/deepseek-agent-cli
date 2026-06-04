import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  InMemoryCommandSystem,
  readinessCommandNames,
  readinessManifest,
  registerLocalReadinessCommands,
  runLocalReadinessCommand
} from "@deepseek/command-system";
import { createDefaultIndexProviderDiagnostics, createDefaultIndexProviderManifest, resolveIndexProviderDiagnostics } from "@deepseek/index-provider";
import type { LocalReadinessEnvironment } from "@deepseek/command-system";
import type { ReadinessCommandResult } from "@deepseek/platform-contracts";
import { collectReleaseReadinessEvidence } from "../../src/apps/cli/src/diagnostics/release-evidence.js";
import { releaseVerificationSummary } from "../../src/apps/cli/src/diagnostics/index.js";

const fakeSecret = "sk-live-secret-value";

function fakeEnv(): LocalReadinessEnvironment {
  return {
    cwd: "D:/work/deepseek",
    nodeVersion: "v22.0.0",
    platform: "win32",
    packageName: "deepseek-cli-platform",
    packageVersion: "0.1.0",
    env: { DEEPSEEK_API_KEY: fakeSecret },
    ignoredPaths: [".env", ".env.*", "参考/"],
    availableCommands: ["node", "npm", "git", "rg"],
    config: { model: "deepseek-v4-flash" },
    indexProviderDiagnostics: createDefaultIndexProviderDiagnostics(),
    initialized: true
  };
}

function assertNoSecret(value: unknown): void {
  assert.equal(JSON.stringify(value).includes(fakeSecret), false);
}

describe("local readiness contracts", () => {
  it("defines stable manifests for every readiness command", () => {
    const manifests = readinessCommandNames.map(readinessManifest);

    assert.deepEqual(manifests.map((manifest) => manifest.name), ["init", "config", "auth", "doctor", "privacy", "verify-install"]);
    assert.equal(manifests.every((manifest) => manifest.id.startsWith("readiness.")), true);
    assert.equal(manifests.every((manifest) => manifest.inputSchema.type === "object"), true);
  });

  it("runs every readiness command through the command registry", async () => {
    const commandSystem = new InMemoryCommandSystem();
    await registerLocalReadinessCommands(commandSystem, fakeEnv());

    for (const command of readinessCommandNames) {
      const result = await commandSystem.invoke(command, {});
      assert.equal(result.ok, true);
      const value = result.value as ReadinessCommandResult;
      assert.equal(value.command, command);
      assert.equal(Array.isArray(value.checks), true);
      assertNoSecret(value);
    }
  });

  it("reports credential references without raw secret fields", async () => {
    const result = await runLocalReadinessCommand("auth", {}, fakeEnv());

    assert.equal(result.credential?.available, true);
    assert.equal(result.credential?.source, "process-env");
    assert.equal(result.credential?.redaction.class, "secret");
    assertNoSecret(result);
  });

  it("includes release and support bundle evidence when provided by the CLI host", async () => {
    const release = await collectReleaseReadinessEvidence();
    const environment: LocalReadinessEnvironment = {
      ...fakeEnv(),
      releasePackageSurface: release.packageSurface,
      releaseVerification: release.verification,
      supportBundlePolicy: release.supportBundle
    };
    const result = await runLocalReadinessCommand("verify-install", {}, environment);

    assert.equal(result.checks.some((check) => check.id === "release.package"), true);
    assert.equal(result.checks.some((check) => check.id === "release.verification"), true);
    assert.equal(result.metadata.release && typeof result.metadata.release === "object", true);
    assert.equal(release.verification.acceptanceEvidencePaths.includes("tests/acceptance/acceptance-index.md"), true);
    assert.equal(release.firstPartyPluginPack?.pluginCount, 6);
    assert.equal(release.checks.some((check) => check.id === "release.first-party-dev-plugins" && check.status === "pass"), true);
    assert.equal(release.checks.some((check) => check.id === "governance.runtime-pipes" && check.status === "pass"), true);
    assert.equal(release.checks.some((check) => check.id === "governance.policy-sandbox-gates" && check.status === "pass"), true);
    assert.equal(release.checks.some((check) => check.id === "governance.agent-namespace-quotas" && check.status === "pass"), true);
    assert.equal(release.checks.some((check) => check.id === "governance.plugin-module-boundaries" && check.status === "pass"), true);
    assert.equal(release.checks.some((check) => check.id === "governance.architecture-drift" && check.status === "pass"), true);
    assert.equal(release.checks.some((check) => check.id === "governance.evidence-matrix" && check.status === "pass"), true);
    const architectureDrift = release.checks.find((check) => check.id === "governance.architecture-drift");
    assert.equal((architectureDrift?.metadata?.evidence as { aliasCount?: number } | undefined)?.aliasCount, 4);
    assert.equal(JSON.stringify(architectureDrift).includes("@deepseek/remote-runtime-connectivity"), true);
    assert.equal(release.governanceEvidenceMatrix?.kind, "governance.evidence-matrix");
    assert.equal(release.governanceEvidenceMatrix?.records.some((record) => record.packageName === "deepseek-agent-cli" && record.productReadiness === "ready"), true);
    assert.equal(release.governanceEvidenceMatrix?.records.some((record) => record.capability === "remote-runtime-connectivity" && record.productReadiness === "gated"), true);
    assert.equal((release.governanceDiagnostics?.sections.length ?? 0) >= 9, true);
    assert.equal(release.governanceDiagnostics?.findings.some((finding) => finding.id === "governance.finding.remote-runtime-connectivity-placeholder" && finding.maturityState === "placeholder"), true);
    assert.equal(release.governanceDiagnostics?.findings.some((finding) => finding.id === "governance.finding.distribution-update-management-placeholder" && finding.maturityState === "placeholder"), true);
    assert.equal(release.governanceDiagnostics?.findings.some((finding) => finding.id === "governance.finding.semantic-indexing-deferred" && finding.maturityState === "deferred"), true);
    assert.equal(release.governanceDiagnostics?.findings.some((finding) => finding.id === "governance.finding.vscode-host-adapter-skeleton" && finding.ownerPackage === "vscode-extension"), true);
    assert.equal(release.governanceDiagnostics?.findings.some((finding) => finding.id === "governance.finding.multi-agent-rollout-gated-defaults" && finding.maturityState === "rollout-gated"), true);
    assert.equal(release.governanceDiagnostics?.sections.find((section) => section.sectionId === "governance.roadmap-drift")?.findings.some((finding) => finding.sourceCheckId === "governance.architecture-drift"), true);
    assert.equal(release.governanceDiagnostics?.findings.every((finding) => (
      typeof finding.id === "string"
      && typeof finding.ownerPackage === "string"
      && typeof finding.capability === "string"
      && typeof finding.severity === "string"
      && typeof finding.maturityState === "string"
      && Array.isArray(finding.evidenceIds)
      && Boolean(finding.redaction)
      && typeof finding.nextAction === "string"
    )), true);
    assert.equal(JSON.stringify(result).includes("npm publish --dry-run"), true);
    assert.equal(JSON.stringify(result).includes(fakeSecret), false);
  });

  it("blocks product-ready claims that conflict with governance maturity", async () => {
    const release = await collectReleaseReadinessEvidence({
      productReadyClaims: [{
        capability: "agent-namespace-quotas",
        claimedState: "product-ready",
        evidenceIds: ["tests/acceptance/product-ready-claim.fixture"],
        redaction: { class: "internal" }
      }, {
        capability: "remote-runtime-connectivity",
        claimedState: "product-ready",
        evidenceIds: ["tests/acceptance/product-ready-remote.fixture"],
        redaction: { class: "internal" }
      }]
    });
    const claimFinding = release.governanceDiagnostics?.findings.find((finding) => finding.id === "governance.product-ready-claim.agent-namespace-quotas.conflict");
    const remoteClaimFinding = release.governanceDiagnostics?.findings.find((finding) => finding.id === "governance.product-ready-claim.remote-runtime-connectivity.conflict");

    assert.equal(release.status, "fail");
    assert.equal(release.checks.some((check) => check.id === "governance.product-ready-claims" && check.status === "fail"), true);
    assert.equal(claimFinding?.severity, "release-blocking");
    assert.equal(claimFinding?.releaseBlocking, true);
    assert.equal(claimFinding?.evidenceIds.includes("tests/acceptance/product-ready-claim.fixture"), true);
    assert.equal(remoteClaimFinding?.severity, "release-blocking");
    assert.equal(remoteClaimFinding?.maturityState, "placeholder");
    assert.equal(remoteClaimFinding?.evidenceIds.includes("tests/acceptance/product-ready-remote.fixture"), true);
  });

  it("derives release readiness from concrete local evidence gates", async () => {
    await withTempRepo(async () => {
      const missingBuild = await collectReleaseReadinessEvidence();
      const blockedSummary = releaseVerificationSummary(missingBuild);
      assert.equal(missingBuild.status, "fail");
      assert.equal(missingBuild.packageSurface.buildOutputExists, false);
      assert.equal(missingBuild.checks.find((check) => check.id === "release.build-output")?.status, "fail");
      assert.equal(missingBuild.verification.missingAcceptanceEvidencePaths?.length, 0);
      assert.equal(blockedSummary.status, "blocked");
      assert.equal(blockedSummary.publishDryRunReady, false);
      assert.equal(blockedSummary.blockingChecks.some((check) => check.id === "release.build-output"), true);

      await writeFile("src/apps/cli/dist/index.js", "#!/usr/bin/env node\n", "utf8");
      const ready = await collectReleaseReadinessEvidence();
      const readySummary = releaseVerificationSummary(ready);
      assert.equal(ready.status, "pass");
      assert.equal(ready.packageSurface.buildOutputExists, true);
      assert.equal(ready.checks.find((check) => check.id === "release.package-surface")?.status, "pass");
      assert.equal(readySummary.status, "ready");
      assert.equal(readySummary.publishDryRunReady, true);
      assert.equal(readySummary.nextAction, "npm publish --dry-run --workspace deepseek-agent-cli --access public");
      assert.equal(JSON.stringify(ready).includes(fakeSecret), false);
    });
  });

  it("warns on missing historical acceptance evidence without marking package metadata failed", async () => {
    await withTempRepo(async () => {
      await rm("tests/acceptance/latest/typecheck.txt", { force: true });
      await writeFile("src/apps/cli/dist/index.js", "#!/usr/bin/env node\n", "utf8");

      const release = await collectReleaseReadinessEvidence();
      const summary = releaseVerificationSummary(release);

      assert.equal(release.status, "warn");
      assert.equal(release.verification.missingAcceptanceEvidencePaths?.includes("tests/acceptance/latest/typecheck.txt"), true);
      assert.equal(release.checks.find((check) => check.id === "release.package")?.status, "pass");
      assert.equal(release.checks.find((check) => check.id === "release.acceptance")?.status, "warn");
      assert.equal(summary.status, "warn");
      assert.equal(summary.warningChecks.some((check) => check.id === "release.acceptance"), true);
      assert.equal(summary.missingAcceptanceEvidencePaths.includes("tests/acceptance/latest/typecheck.txt"), true);
    });
  });

  it("blocks release readiness when live CLI evidence comes from the mock gateway", async () => {
    await withTempRepo(async () => {
      await writeFile("src/apps/cli/dist/index.js", "#!/usr/bin/env node\n", "utf8");
      await writeFile("tests/acceptance/latest/live-cli-run-smoke.txt", [
        JSON.stringify({ kind: "agent.loop.completed", data: { modelProvider: "provider-deepseek", assistantText: "DeepSeek mock response: smoke" } }),
        ""
      ].join("\n"), "utf8");

      const release = await collectReleaseReadinessEvidence();
      const summary = releaseVerificationSummary(release);

      assert.equal(release.status, "fail");
      assert.equal(release.verification.liveEvidence?.status, "fail");
      assert.equal(release.verification.liveEvidence?.invalidEvidencePaths.includes("tests/acceptance/latest/live-cli-run-smoke.txt"), true);
      assert.equal(release.checks.find((check) => check.id === "release.live-evidence")?.status, "fail");
      assert.equal(summary.publishDryRunReady, false);
    });
  });

  it("blocks release readiness when npm dry-run evidence shows a published version collision", async () => {
    await withTempRepo(async () => {
      await writeFile("src/apps/cli/dist/index.js", "#!/usr/bin/env node\n", "utf8");
      await writeFile("tests/acceptance/latest/npm-publish-dry-run.txt", [
        "npm notice package: deepseek-agent-cli@0.1.3",
        "npm error You cannot publish over the previously published versions: 0.1.3.",
        ""
      ].join("\n"), "utf8");

      const release = await collectReleaseReadinessEvidence();
      const summary = releaseVerificationSummary(release);

      assert.equal(release.status, "fail");
      assert.equal(release.verification.publishDryRunEvidence?.collisionDetected, true);
      assert.equal(release.checks.find((check) => check.id === "release.publish-dry-run")?.status, "fail");
      assert.equal(summary.status, "blocked");
      assert.equal(summary.publishDryRunReady, false);
      assert.equal(summary.blockingChecks.some((check) => check.id === "release.publish-dry-run"), true);
    });
  });

  it("reports GLM live evidence as provider parity without adding default release blockers", async () => {
    await withTempRepo(async () => {
      await writeFile("src/apps/cli/dist/index.js", "#!/usr/bin/env node\n", "utf8");

      const release = await collectReleaseReadinessEvidence();
      const parityEvidence = Array.isArray(release.verification.liveEvidence?.providerParityEvidence)
        ? release.verification.liveEvidence.providerParityEvidence.filter(isRecord)
        : [];
      const parityPaths = parityEvidence.map((file) => String(file.path));

      assert.equal(release.status, "pass");
      assert.equal(release.verification.liveEvidence?.requiredEvidencePaths.some((path) => path.includes("glm-live")), false);
      assert.equal(release.verification.acceptanceEvidencePaths.some((path) => path.includes("glm-live")), false);
      assert.equal(parityPaths.includes("tests/acceptance/latest/glm-live-provider-smoke.txt"), true);
      assert.equal(parityPaths.includes("tests/acceptance/latest/glm-live-agent-tool-smoke.txt"), true);
      assert.equal(parityPaths.includes("tests/acceptance/latest/glm-live-doctor-smoke.txt"), true);
      assert.equal(parityEvidence.every((file) => file.required === false), true);
    });
  });

  it("accepts GLM diagnostics doctor JSON as provider parity evidence", async () => {
    await withTempRepo(async () => {
      await writeFile("src/apps/cli/dist/index.js", "#!/usr/bin/env node\n", "utf8");
      await writeFile("tests/acceptance/latest/glm-live-provider-smoke.txt", "# pass 2\n# skipped 0\n", "utf8");
      await writeFile("tests/acceptance/latest/glm-live-agent-tool-smoke.txt", "# pass 1\n# skipped 0\n", "utf8");
      await writeFile("tests/acceptance/latest/glm-live-doctor-smoke.txt", glmLiveDoctorSmokeEvidenceForTest(), "utf8");

      const release = await collectReleaseReadinessEvidence();
      const parityEvidence = Array.isArray(release.verification.liveEvidence?.providerParityEvidence)
        ? release.verification.liveEvidence.providerParityEvidence.filter(isRecord)
        : [];
      const doctorEvidence = parityEvidence.find((file) => file.path === "tests/acceptance/latest/glm-live-doctor-smoke.txt");

      assert.equal(doctorEvidence?.status, "pass");
      assert.equal(doctorEvidence?.required, false);
    });
  });

  it("lists GLM live provider parity in the acceptance index", async () => {
    const index = await readFile("tests/acceptance/acceptance-index.md", "utf8");

    assert.equal(index.includes("GLM live provider smoke"), true);
    assert.equal(index.includes("GLM_ANTHROPIC_LIVE_TESTS=1 npm run smoke:live:glm"), true);
    assert.equal(index.includes("latest/glm-live-provider-smoke.txt"), true);
    assert.equal(index.includes("GLM live agent tool smoke"), true);
    assert.equal(index.includes("GLM_ANTHROPIC_LIVE_AGENT_TOOL_TESTS=1 npm run smoke:live:glm-agent-tools"), true);
    assert.equal(index.includes("latest/glm-live-agent-tool-smoke.txt"), true);
    assert.equal(index.includes("GLM live doctor smoke"), true);
    assert.equal(index.includes("latest/glm-live-doctor-smoke.txt"), true);
  });

  it("surfaces index provider diagnostics in doctor without raw provider material", async () => {
    const result = await runLocalReadinessCommand("doctor", { live: false }, fakeEnv());

    assert.equal(result.indexProviders?.enabledProviderIds.includes("pageindex"), true);
    assert.equal(result.indexProviders?.deferredProviderIds.includes("zvec"), true);
    assert.equal(result.checks.some((check) => check.id === "index-provider.pageindex" && check.status === "pass"), true);
    assert.equal(result.checks.some((check) => check.id === "index-provider.zvec" && check.status === "warn"), true);
    assert.equal(JSON.stringify(result).includes(fakeSecret), false);
  });

  it("reports selected GLM credential and provider metadata in doctor", async () => {
    const environment = {
      ...fakeEnv(),
      env: { GLM_ANTHROPIC_API_KEY: fakeSecret },
      modelProvider: {
        provider: "glm",
        protocol: "anthropic-messages",
        model: "glm-5.1",
        label: "GLM"
      }
    } as LocalReadinessEnvironment;
    const result = await runLocalReadinessCommand("doctor", { live: false }, environment);
    const credentialCheck = result.checks.find((check) => check.id === "auth.glm");

    assert.equal(result.credential?.provider, "glm");
    assert.equal(result.credential?.available, true);
    assert.equal(result.metadata.provider && typeof result.metadata.provider === "object", true);
    assert.equal((result.metadata.provider as { provider?: string }).provider, "glm");
    assert.equal((result.metadata.provider as { model?: string }).model, "glm-5.1");
    assert.equal(credentialCheck?.status, "pass");
    assert.equal(credentialCheck?.metadata?.provider, "glm");
    assert.equal(JSON.stringify(result).includes(fakeSecret), false);
  });

  it("renders live doctor messages from the verified provider instead of hardcoded DeepSeek", async () => {
    const environment = {
      ...fakeEnv(),
      env: { GLM_ANTHROPIC_API_KEY: fakeSecret },
      modelProvider: {
        provider: "glm",
        protocol: "anthropic-messages",
        model: "glm-5.1",
        label: "GLM"
      },
      liveVerifier: async () => ({
        ok: true,
        provider: {
          provider: "glm",
          protocol: "anthropic-messages",
          model: "glm-5.1",
          requestId: "req-glm-contract"
        },
        reachable: true,
        terminalStatus: "completed",
        latencyMs: 12,
        eventKinds: ["delta", "finish", "done"],
        diagnostics: [],
        redaction: { class: "internal" }
      })
    } as LocalReadinessEnvironment;
    const result = await runLocalReadinessCommand("doctor", { live: true }, environment);
    const liveCheck = result.checks.find((check) => check.id === "doctor.live");

    assert.equal(result.live?.provider.provider, "glm");
    assert.equal(liveCheck?.status, "pass");
    assert.equal(liveCheck?.message.includes("GLM live verification completed for glm-5.1"), true);
    assert.equal(liveCheck?.metadata?.provider, "glm");
    assert.equal(liveCheck?.metadata?.protocol, "anthropic-messages");
    assert.equal(JSON.stringify(result).includes(fakeSecret), false);
  });

  it("reports configured provider manifest downgrades in doctor metadata", async () => {
    const environment: LocalReadinessEnvironment = {
      ...fakeEnv(),
      indexProviderDiagnostics: resolveIndexProviderDiagnostics({
        ...createDefaultIndexProviderManifest(),
        source: {
          scope: "workspace",
          sourceId: "config.indexProviders",
          redaction: { class: "internal", fields: ["sourceId"] }
        },
        providers: [{
          providerId: "zvec",
          kind: "zvec",
          status: "enabled",
          implementationStatus: "missing",
          metadata: { configured: true },
          redaction: { class: "internal", fields: ["metadata"] }
        }]
      })
    };
    const result = await runLocalReadinessCommand("doctor", { live: false }, environment);
    const zvec = result.indexProviders?.providers.find((provider) => provider.providerId === "zvec");
    const zvecCheck = result.checks.find((check) => check.id === "index-provider.zvec");

    assert.equal(result.indexProviders?.source.scope, "workspace");
    assert.equal(zvec?.status, "deferred");
    assert.equal(zvec?.requestedStatus, "enabled");
    assert.equal(zvec?.implementationStatus, "missing");
    assert.equal(zvecCheck?.metadata?.requestedStatus, "enabled");
    assert.equal(result.indexProviders?.diagnostics.some((diagnostic) => diagnostic.code === "INDEX_PROVIDER_UNSUPPORTED_ENABLED"), true);
    assert.equal(JSON.stringify(result).includes(fakeSecret), false);
  });

  it("reports missing activation evidence in doctor metadata", async () => {
    const environment: LocalReadinessEnvironment = {
      ...fakeEnv(),
      indexProviderDiagnostics: resolveIndexProviderDiagnostics({
        ...createDefaultIndexProviderManifest(),
        source: {
          scope: "workspace",
          sourceId: "config.indexProviders",
          redaction: { class: "internal", fields: ["sourceId"] }
        },
        providers: [{
          providerId: "zvec",
          kind: "zvec",
          status: "enabled",
          implementationStatus: "available",
          metadata: { configured: true },
          redaction: { class: "internal", fields: ["metadata"] }
        }]
      })
    };
    const result = await runLocalReadinessCommand("doctor", { live: false }, environment);
    const indexProviderMetadata = result.metadata.indexProviders;
    const providerMetadataRecords = isRecord(indexProviderMetadata) && Array.isArray(indexProviderMetadata.providers) ? indexProviderMetadata.providers.filter(isRecord) : [];
    const zvecMetadata = providerMetadataRecords.find((provider) => provider.providerId === "zvec");
    const zvecCheck = result.checks.find((check) => check.id === "index-provider.zvec");
    const diagnosticCodes = Array.isArray(zvecCheck?.metadata?.diagnosticCodes) ? zvecCheck.metadata.diagnosticCodes : [];
    const activationEvidence = Array.isArray(zvecMetadata?.activationEvidence) ? zvecMetadata.activationEvidence.filter(isRecord) : [];

    assert.equal(zvecCheck?.status, "warn");
    assert.equal(zvecCheck?.metadata?.requestedStatus, "enabled");
    assert.equal(zvecCheck?.metadata?.implementationStatus, "available");
    assert.equal(diagnosticCodes.includes("INDEX_PROVIDER_ACTIVATION_EVIDENCE_MISSING"), true);
    assert.equal(activationEvidence.every((evidence) => evidence.status === "missing"), true);
    assert.equal(result.indexProviders?.diagnostics.some((diagnostic) => diagnostic.code === "INDEX_PROVIDER_ACTIVATION_EVIDENCE_MISSING"), true);
    assert.equal(JSON.stringify(result).includes(fakeSecret), false);
  });
});

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withTempRepo(run: () => Promise<void>): Promise<void> {
  const previousCwd = process.cwd();
  const cwd = await mkdtemp(join(tmpdir(), "deepseek-release-evidence-"));
  try {
    process.chdir(cwd);
    await mkdir("src/apps/cli", { recursive: true });
    await mkdir("src/apps/cli/dist", { recursive: true });
    await mkdir("tests/acceptance/latest", { recursive: true });
    await writeFile("src/apps/cli/package.json", JSON.stringify({
      name: "deepseek-agent-cli",
      version: "0.1.3",
      type: "module",
      exports: { ".": "./dist/index.js" },
      files: ["dist", "README.md"],
      bin: { deepseek: "dist/index.js" },
      publishConfig: { access: "public" }
    }), "utf8");
    await writeFile("tests/acceptance/acceptance-index.md", "# Acceptance Evidence Index\n", "utf8");
    for (const file of [
      "openspec-validation.txt",
      "typecheck.txt",
      "lint.txt",
      "test-summary.txt",
      "dependency-boundaries.txt",
      "build-cli.txt",
      "release-verify.txt",
      "uapi-compatibility.txt",
      "architecture-drift-guardrails.json",
      "governance-evidence-matrix.json",
      "smoke-headless.txt",
      "reference-hygiene.txt",
      "npm-publish-dry-run.txt",
      "live-provider-smoke.txt",
      "live-agent-loop-smoke.txt",
      "live-agent-tool-smoke.txt",
      "live-cli-run-smoke.txt",
      "live-doctor-smoke.txt",
      "live-tool-coverage.json",
      "tool-family-delivery-capability-score.json",
      "deepseek-provider-response-cache.json",
      "overall-delivery-capability-score.json"
    ]) {
      await writeFile(join("tests/acceptance/latest", file), acceptanceEvidenceContentForTest(file), "utf8");
    }
    await run();
  } finally {
    process.chdir(previousCwd);
    await rm(cwd, { recursive: true, force: true });
  }
}

function acceptanceEvidenceContentForTest(file: string): string {
  if (file === "npm-publish-dry-run.txt") return "npm notice package: deepseek-agent-cli@0.1.3\nnpm notice Tarball Details\n";
  if (file.startsWith("live-") && file.endsWith("-smoke.txt") && file !== "live-cli-run-smoke.txt" && file !== "live-doctor-smoke.txt") return "# pass 1\n# skipped 0\n";
  if (file === "live-cli-run-smoke.txt") return liveCliRunSmokeEvidenceForTest();
  if (file === "live-doctor-smoke.txt") return liveDoctorSmokeEvidenceForTest();
  if (file === "live-tool-coverage.json") return JSON.stringify({ kind: "deepseek.live-tool-coverage", executionMode: "live", replayOnly: false, summary: { passedToolCount: 64, providerRequestMode: "live" } });
  if (file === "tool-family-delivery-capability-score.json") return JSON.stringify({ kind: "tool-family.delivery-capability-score.evidence", deliveryCapabilityPassed: true, fakeCoveredFamilyCount: 0, replayedCoveredFamilyCount: 0, liveCoveredFamilyCount: 64 });
  if (file === "architecture-drift-guardrails.json") return JSON.stringify({ kind: "governance.architecture-drift", status: "pass", aliasCount: 4 });
  if (file === "governance-evidence-matrix.json") return JSON.stringify({ kind: "governance.evidence-matrix", status: "pass", recordCount: 1 });
  if (file === "deepseek-provider-response-cache.json") return JSON.stringify({
    schemaVersion: "1.0.0",
    kind: "deepseek.provider-response-cache",
    replayOnly: true,
    provider: "deepseek",
    sourceEvidencePath: "tests/acceptance/latest/live-tool-coverage.json",
    entryCount: 1,
    entries: [{ executionMode: "live" }]
  });
  if (file === "overall-delivery-capability-score.json") return JSON.stringify({ kind: "cli.overall-delivery-capability-score.evidence", status: "pass", score: 1, dimensions: [{ dimensionId: "deepseek-api" }, { dimensionId: "memory" }, { dimensionId: "cache-observability" }] });
  return "ok\n";
}

function liveCliRunSmokeEvidenceForTest(): string {
  return [
    JSON.stringify({ kind: "model.finished", data: { provider: { provider: "deepseek", protocol: "openai-chat-completions", model: "deepseek-v4-flash", requestId: "req-live-cli-test" } } }),
    JSON.stringify({ kind: "usage.updated", data: { metadata: { provider: { provider: "deepseek", protocol: "openai-chat-completions", model: "deepseek-v4-flash", requestId: "req-live-cli-test" }, cache: { hitTokens: 0, missTokens: 12 } } } }),
    JSON.stringify({ kind: "agent.loop.completed", data: { modelProvider: "provider-deepseek", status: "completed" } }),
    ""
  ].join("\n");
}

function liveDoctorSmokeEvidenceForTest(): string {
  return `${JSON.stringify({
    command: "doctor",
    metadata: { liveRequested: true },
    checks: [{ id: "doctor.live", status: "pass" }],
    live: {
      reachable: true,
      usage: {
        provider: { provider: "deepseek", protocol: "openai-chat-completions", model: "deepseek-v4-flash", requestId: "req-live-doctor-test" },
        cache: { hitTokens: 0, missTokens: 8 }
      }
    }
  })}\n`;
}

function glmLiveDoctorSmokeEvidenceForTest(): string {
  return `${JSON.stringify({
    schemaVersion: "1.0.0",
    kind: "diagnostics.doctor",
    command: "doctor",
    status: "warn",
    readiness: {
      command: "doctor",
      status: "warn",
      checks: [{
        id: "doctor.live",
        status: "pass",
        message: "GLM live verification completed for glm-5.1.",
        metadata: {
          requested: true,
          provider: "glm",
          protocol: "anthropic-messages",
          model: "glm-5.1",
          terminalStatus: "completed",
          eventKinds: ["delta", "finish", "usage", "done"],
          reachable: true
        }
      }]
    }
  })}\n`;
}
