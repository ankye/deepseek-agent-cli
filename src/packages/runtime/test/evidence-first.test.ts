import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EVIDENCE_FIRST_COMPATIBILITY, EVIDENCE_FIRST_SCHEMA_VERSION, type EvidenceFirstRuntimeContext, type EvidenceItem, type EvidenceTaskClassification } from "@deepseek/platform-contracts";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";
import { explainEvidenceCandidateSelection, groundStrictClaims } from "../src/index.js";
import { asId } from "@deepseek/platform-contracts";

const trace = {
  traceId: asId<"trace">("trace-evidence-first-unit"),
  spanId: asId<"span">("span-evidence-first-unit"),
  correlationId: asId<"correlation">("corr-evidence-first-unit")
};

describe("evidence-first runtime helpers", () => {
  it("records structured evidence candidate exclusions without leaking raw content", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "DeepSeek CLI product evidence.\n");
    await deps.platform.writeFile("/workspace/src/apps/cli/package.json", "DEEPSEEK_API_KEY=sk-live-super-secret\n");
    await deps.platform.writeFile("/workspace/src/apps/cli/README.md", "Deprecated stale CLI copy.\n");
    await deps.platform.writeFile("/workspace/docs/product/product-roadmap.md", "Roadmap evidence.\n");
    await deps.platform.writeFile("/workspace/src/apps/cli/src/commands/parse.ts", "export const command = 'deepseek run';\n");
    await deps.platform.writeFile("/workspace/src/apps/cli/src/types.ts", "export interface CliCommand {}\n");
    await deps.platform.writeFile("/workspace/src/apps/cli/test/cli.test.ts", "test command evidence\n");

    const projection = await explainEvidenceCandidateSelection(deps, {
      prompt: "Generate DeepSeek CLI product website with commands, package, docs, architecture, roadmap, and evaluation details",
      workspaceRoot: "/workspace",
      trace
    });
    const outOfScopeDeps = createDeterministicRuntimeDependencies();
    const outOfScopePlatform = Object.create(outOfScopeDeps.platform) as typeof outOfScopeDeps.platform;
    const resolveWorkspacePath = outOfScopeDeps.platform.resolveWorkspacePath.bind(outOfScopeDeps.platform);
    outOfScopePlatform.resolveWorkspacePath = (workspaceRoot, inputPath) => inputPath === "README.md"
      ? {
        ok: false,
        error: {
          code: "TEST_OUT_OF_SCOPE",
          message: "Test candidate resolved outside the workspace.",
          retryable: false,
          redaction: { class: "public" as const }
        }
      }
      : resolveWorkspacePath(workspaceRoot, inputPath);
    const outOfScopeProjection = await explainEvidenceCandidateSelection({ platform: outOfScopePlatform }, {
      prompt: "Summarize current repository docs",
      workspaceRoot: "/workspace",
      trace
    });

    const overBudgetDeps = createDeterministicRuntimeDependencies();
    for (const path of [
      "/workspace/README.md",
      "/workspace/src/apps/cli/package.json",
      "/workspace/src/apps/cli/README.md",
      "/workspace/docs/reference/command-index.md",
      "/workspace/docs/product/product-roadmap.md",
      "/workspace/openspec/changes/evidence-first-agent-workflow/design.md",
      "/workspace/openspec/changes/evidence-first-agent-workflow/specs/evidence-first-agent-workflow/spec.md",
      "/workspace/src/apps/cli/src/commands/parse.ts",
      "/workspace/src/apps/cli/src/types.ts",
      "/workspace/src/apps/cli/test/cli.test.ts"
    ]) {
      await overBudgetDeps.platform.writeFile(path, `Current evidence for ${path}.\n`);
    }
    const overBudgetProjection = await explainEvidenceCandidateSelection(overBudgetDeps, {
      prompt: "Generate DeepSeek CLI product website with commands, package, docs, architecture, roadmap, and evaluation details",
      workspaceRoot: "/workspace",
      trace
    });
    const reasons = [
      ...projection.excludedCandidates,
      ...outOfScopeProjection.excludedCandidates,
      ...overBudgetProjection.excludedCandidates
    ].map((item) => item.reason);
    const serialized = JSON.stringify(projection);

    assert.equal(projection.selectedEvidence.length <= 8, true);
    assert.equal(reasons.includes("secret-like"), true);
    assert.equal(reasons.includes("stale"), true);
    assert.equal(reasons.includes("missing"), true);
    assert.equal(reasons.includes("out-of-scope"), true);
    assert.equal(reasons.includes("over-budget"), true);
    assert.equal(serialized.includes("sk-live-super-secret"), false);
    assert.equal(projection.excludedCandidates.every((item) => item.schemaVersion === EVIDENCE_FIRST_SCHEMA_VERSION), true);
  });

  it("separates verified inferred assumption and unsupported strict claims in grounding", () => {
    const context = evidenceContext();
    const result = groundStrictClaims([
      "Package name is deepseek-agent-cli.",
      "The architecture uses a runtime kernel with host adapters.",
      "Assumption: DeepSeek CLI may add cloud sync later.",
      "Run npx deepseek-cli init to start."
    ].join("\n"), context, "report");
    const certainties = result.claimGroundings.map((claim) => claim.certainty);

    assert.equal(certainties.includes("verified"), true);
    assert.equal(certainties.includes("inferred"), true);
    assert.equal(certainties.includes("assumption"), true);
    assert.equal(certainties.includes("unsupported"), true);
    assert.equal(result.unsupportedClaims.some((claim) => claim.code === "unsupported-command"), true);
    assert.equal(result.summary.claimGroundingRate > 0, true);
  });

  it("allows docs evidence to infer non-direct architecture claims", () => {
    const context = {
      ...evidenceContext(),
      selectedEvidence: [{
        ...evidenceContext().selectedEvidence[0]!,
        evidenceId: "evidence:readme",
        sourceGroup: "readme" as const,
        sourcePath: "README.md",
        sourceLabel: "README",
        factClasses: ["docs"] as const,
        preview: "DeepSeek CLI is a contract-first platform with one governed runtime kernel serving Terminal CLI, VSCode Extension, Local Server / SDK, Native Host, and Browser Bridge through one protocol."
      }]
    };

    const result = groundStrictClaims(
      "DeepSeek CLI is a contract-first platform governed by a single runtime kernel that serves multiple host surfaces including Terminal CLI, VSCode Extension, Local Server/SDK, Native Host, and Browser Bridge.",
      context,
      "summary"
    );

    assert.equal(result.unsupportedClaims.length, 0);
    assert.equal(result.claimGroundings[0]?.certainty, "inferred");
  });

  it("grounds markdown pass-list claims from tool-result pass evidence", () => {
    const toolResultEvidence: EvidenceItem = {
      schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
      evidenceId: "evidence:tool-result-tests",
      sourceGroup: "tests",
      sourcePath: "runtime-record:tool-result",
      sourceLabel: "core.shell.run result",
      factClasses: ["feature"],
      preview: [
        "test_coord_matrix: PASS",
        "test_cdot: PASS",
        "test_cstack: PASS",
        "test_arith_oper: PASS",
        "test_separable[cm1]: PASS",
        "test_separable[cm2]: PASS",
        "test_separable[cm3]: PASS",
        "test_separable[cm4]: PASS",
        "test_separable[cm5]: PASS",
        "test_separable[cm6]: PASS",
        "test_separable[cm7]: PASS",
        "test_custom_model_separable: PASS"
      ].join("\n"),
      fingerprint: "fnv1a:tool-result-tests",
      freshness: { status: "current" },
      trace: {},
      compatibility: EVIDENCE_FIRST_COMPATIBILITY,
      redaction: { class: "internal", fields: ["preview"] }
    };
    const context = {
      ...evidenceContext(),
      selectedEvidence: [toolResultEvidence]
    };

    const result = groundStrictClaims([
      "- `test_cdot` ✅",
      "- `test_separable[cm1]` ~ `test_separable[cm7]` ✅（6 个参数化用例）"
    ].join("\n"), context, "agent.loop.answer");

    assert.equal(result.unsupportedClaims.length, 0);
    assert.equal(result.claimGroundings.every((claim) => claim.certainty !== "unsupported"), true);
  });
});

function evidenceContext(): EvidenceFirstRuntimeContext {
  const classification: EvidenceTaskClassification = {
    schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
    classificationId: "evidence-classification:unit",
    sensitivity: "fact-sensitive" as const,
    intents: ["product", "evaluation"] as const,
    factClasses: ["package", "architecture", "feature", "command"] as const,
    evidenceRequired: true,
    reason: "unit",
    trace: {},
    compatibility: EVIDENCE_FIRST_COMPATIBILITY,
    redaction: { class: "internal" as const }
  };
  return {
    schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
    classification,
    selectedEvidence: [
      {
        schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
        evidenceId: "evidence:package",
        sourceGroup: "package-metadata",
        sourcePath: "src/apps/cli/package.json",
        sourceLabel: "package",
        factClasses: ["package", "command"],
        preview: "name deepseek-agent-cli bin deepseek command deepseek run",
        fingerprint: "fnv1a:package",
        freshness: { status: "current" },
        trace: {},
        compatibility: EVIDENCE_FIRST_COMPATIBILITY,
        redaction: { class: "internal", fields: ["preview"] }
      },
      {
        schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
        evidenceId: "evidence:architecture",
        sourceGroup: "openspec",
        sourcePath: "openspec/specs/agent-loop/spec.md",
        sourceLabel: "architecture",
        factClasses: ["architecture"],
        preview: "DeepSeek CLI has a runtime kernel and thin host adapters for CLI and VSCode.",
        fingerprint: "fnv1a:architecture",
        freshness: { status: "current" },
        trace: {},
        compatibility: EVIDENCE_FIRST_COMPATIBILITY,
        redaction: { class: "internal", fields: ["preview"] }
      }
    ],
    sourceCoverage: [],
    summary: {
      schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
      summaryId: "evidence-summary:unit",
      classification,
      manifestStatus: "missing",
      evidenceItemCount: 2,
      sourceCoverageRate: 1,
      claimGroundingRate: 0,
      unsupportedClaimCount: 0,
      assumptionCount: 0,
      hallucinatedCommandCount: 0,
      trace: {},
      compatibility: EVIDENCE_FIRST_COMPATIBILITY,
      redaction: { class: "internal" }
    },
    compatibility: EVIDENCE_FIRST_COMPATIBILITY,
    redaction: { class: "internal" }
  };
}
