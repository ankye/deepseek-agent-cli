import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_SCHEMA_VERSION, asId, type ApprovalId, type ApprovalRequest, type PolicyRequest, type SandboxCapabilityMatrix } from "@deepseek/platform-contracts";
import { getReferencePitFixture } from "@deepseek/testing-regression";
import {
  analyzeResourceScope,
  classifySecretText,
  createSandboxRequirement,
  collectPolicyGateCoverageRecords,
  createPolicyDecisionRecord,
  createPolicyGateFixtureRecords,
  createSecretRedactionDecision,
  DefaultPolicyEngine,
  HeadlessApprovalBroker,
  listRiskyOperationTaxonomy,
  redactJsonSecrets,
  redactSecretText,
  selectSandboxDecision
} from "./index.js";

describe("secret and sandbox policy helpers", () => {
  it("defines mandatory policy taxonomy and coverage for risky operation families", () => {
    const taxonomy = listRiskyOperationTaxonomy();
    const coverage = collectPolicyGateCoverageRecords();
    const families = new Set(taxonomy.map((entry) => entry.family));

    for (const family of ["file", "shell", "mcp", "plugin", "credential", "remote", "sandbox", "workspace-mutation"]) {
      assert.equal(families.has(family as never), true);
    }
    assert.equal(taxonomy.every((entry) => entry.schemaVersion === "1.0.0" && entry.requiredDecision === "mandatory"), true);
    assert.equal(taxonomy.some((entry) => entry.operationId === "plugin.execution" && entry.examples.includes("module.contribution.invoke")), true);
    assert.equal(coverage.some((record) => record.operationFamily === "remote" && record.coverage === "deferred"), true);
    assert.equal(coverage.some((record) => record.operationId === "plugin.execution" && record.entrypoints.includes("module.permission.evaluate")), true);
    assert.equal(coverage.filter((record) => record.releaseGate === "release-blocking").every((record) => record.coverage === "covered"), true);
  });

  it("creates redacted replay-safe policy decision records for every required outcome", () => {
    const fixtures = createPolicyGateFixtureRecords();
    const decisions = new Set(fixtures.map((record) => record.decision));
    const record = createPolicyDecisionRecord({
      subject: "user sk-live-1234567890",
      action: "execute:file.write",
      resource: "core.file.write",
      metadata: { sideEffect: "write", permissionMode: "bypass" },
      resourceScope: analyzeResourceScope({ path: "../secret.txt", workspaceRoot: "/workspace" }, "write")
    }, {
      action: "deny",
      reason: "Denied sk-live-1234567890"
    });

    for (const decision of ["allow", "deny", "prompt", "redact", "audit-only", "bypass-detected"]) {
      assert.equal(decisions.has(decision as never), true);
    }
    assert.equal(record.decision, "bypass-detected");
    assert.equal(record.replayBehavior, "fail-closed");
    assert.equal(JSON.stringify([fixtures, record]).includes("sk-live-1234567890"), false);
  });

  it("classifies and redacts common secret fixtures deterministically", () => {
    const fixtures = [
      ["sk-live-1234567890", "api-key"],
      ["ds-1234567890abcdef", "api-key"],
      ["deepseek-1234567890abcdef12345678", "api-key"],
      ["Authorization: Bearer abcdefghijklmnop", "bearer-token"],
      ["-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", "private-key"],
      ["DEEPSEEK_API_KEY=secret-value", "env-credential"],
      ["credentialRef:deepseek/default", "credential-ref"]
    ] as const;

    for (const [text, kind] of fixtures) {
      const classification = classifySecretText(text);
      assert.equal(classification.detected, true);
      assert.equal(classification.kind, kind);
      assert.equal(redactSecretText(text).includes("secret-value"), false);
    }
  });

  it("does not redact provider model identifiers as api keys", () => {
    const model = "deepseek-v4-flash";

    assert.equal(classifySecretText(model).detected, false);
    assert.equal(redactSecretText(model), model);
    assert.deepEqual(redactJsonSecrets({ model }), { model });
  });

  it("does not classify human-readable DeepSeek report directory slugs as api keys", () => {
    const path = "/workspace/.deepseek/capability-matrix/live-20260623-deepseek-t08-after-implement-stage/T08/workspace";

    assert.equal(classifySecretText(path).detected, false);
    assert.equal(redactSecretText(path), path);
  });

  it("does not classify product copy mentioning credential packages as a secret", () => {
    const copy = "Governance packages include config, credential-auth-management, and usage-budget-management.";

    assert.equal(classifySecretText(copy).detected, false);
  });

  it("redacts nested JSON values and credential-like fields", () => {
    const redacted = redactJsonSecrets({
      apiKey: "plain-value",
      nested: { token: "another-value", note: "safe text" },
      output: "Bearer abcdefghijklmnop"
    }) as { apiKey?: string; nested?: { token?: string; note?: string }; output?: string };

    assert.equal(redacted.apiKey, "[REDACTED:secret]");
    assert.equal(redacted.nested?.token, "[REDACTED:secret]");
    assert.equal(redacted.nested?.note, "safe text");
    assert.equal(redacted.output, "[REDACTED:bearer-token]");
  });

  it("selects deterministic sandbox decisions for degraded platform states", async () => {
    const capabilities: SandboxCapabilityMatrix = {
      schemaVersion: "1.0.0",
      filesystem: { read: true, write: false, readOnly: true, traversalPolicy: "workspace-root", rollback: false },
      processExecution: { execute: true, providerStatus: "available" },
      shell: { execute: false, profile: "none", providerStatus: "unavailable" },
      network: { access: true, providerStatus: "available", hostScopes: [] },
      environment: { access: "scoped" },
      native: { access: false, providerStatuses: {} },
      secureStorage: { status: "degraded", scopedReferences: true },
      degraded: true,
      degradedReasons: ["FILESYSTEM_READ_ONLY"],
      redaction: { class: "internal" }
    };
    const resourceScope = analyzeResourceScope({ path: "a.txt", workspaceRoot: "/workspace" }, "write");
    const request: PolicyRequest = {
      subject: "unit",
      action: "execute:write",
      resource: "core.file.write",
      metadata: {
        sideEffect: "write",
        timeoutMs: 30_000,
        permissions: ["workspace:write"]
      },
      platform: {
        descriptor: { sandbox: capabilities, degradedReasons: capabilities.degradedReasons } as never,
        sandboxCapabilities: capabilities,
        resourceLocks: [],
        timeoutMs: 30_000,
        environmentScope: "scoped",
        redaction: { class: "internal" }
      },
      secret: createSecretRedactionDecision("", { class: "public" }),
      resourceScope,
      sandbox: createSandboxRequirement({ sideEffect: "write", resourceScope, timeoutMs: 30_000, permissions: ["workspace:write"] })
    };

    const decision = selectSandboxDecision(request);
    assert.equal(decision.action, "deny");
    assert.equal(decision.reasonCodes.includes("filesystem.read-only"), true);
  });

  it("allows governed long-running process timeouts within the platform maximum", () => {
    const resourceScope = analyzeResourceScope({ cwd: "/workspace", workspaceRoot: "/workspace" }, "process");
    const decision = selectSandboxDecision({
      subject: "unit",
      action: "execute:core.swe.bench.run",
      resource: "core.swe.bench.run",
      metadata: {
        sideEffect: "process",
        timeoutMs: 7_200_000,
        permissions: ["process:run", "evaluation:swe-bench"]
      },
      secret: createSecretRedactionDecision("", { class: "public" }),
      resourceScope,
      sandbox: createSandboxRequirement({
        sideEffect: "process",
        resourceScope,
        timeoutMs: 7_200_000,
        permissions: ["process:run", "evaluation:swe-bench"]
      })
    });

    assert.equal(decision.reasonCodes.includes("timeout.invalid"), false);
    assert.equal(decision.action, "allow");
  });

  it("rewrites raw secret exposure before execution", () => {
    const resourceScope = analyzeResourceScope({ prompt: "sk-live-1234567890" }, "none");
    const decision = selectSandboxDecision({
      subject: "unit",
      action: "execute:echo",
      resource: "runtime.echo",
      metadata: { sideEffect: "none", timeoutMs: 30_000 },
      secret: createSecretRedactionDecision({ prompt: "sk-live-1234567890" }),
      resourceScope,
      sandbox: createSandboxRequirement({ sideEffect: "none", resourceScope, timeoutMs: 30_000, permissions: [] })
    });

    assert.equal(decision.action, "rewrite");
    assert.equal(decision.reasonCodes.includes("secret.raw-exposure"), true);
  });

  it("keeps hard safety active when bypass metadata is present", async () => {
    const fixture = getReferencePitFixture("pit.permission-bypass.hard-safety");
    assert.equal(fixture?.evidenceIds.includes("policy:bypass-hard-safety"), true);
    const policy = new DefaultPolicyEngine();
    const resourceScope = analyzeResourceScope({ path: "../escape.txt", workspaceRoot: "/workspace" }, "write");
    const decision = await policy.decide({
      subject: "unit",
      action: "execute:file.write",
      resource: "core.file.write",
      metadata: {
        permissionMode: "bypass",
        breakGlass: true,
        sideEffect: "write",
        prompt: "sk-live-1234567890"
      },
      secret: createSecretRedactionDecision({ prompt: "sk-live-1234567890" }),
      resourceScope,
      sandbox: createSandboxRequirement({ sideEffect: "write", resourceScope, timeoutMs: 30_000, permissions: ["workspace:write"] })
    });

    assert.notEqual(decision.action, "allow");
    assert.equal(decision.action, "rewrite");
    assert.equal(decision.sandbox?.reasonCodes.includes("filesystem.path-scope.rejected"), true);
    assert.equal(decision.approval?.kind, "approval.denied");
    assert.equal(decision.approvalSummary?.referencePitFixtureIds.includes("pit.permission-bypass.hard-safety"), true);
    assert.equal(decision.approvalSummary?.referencePitFixtureIds.includes("pit.path-canonicalization.unsafe-syntax"), true);
    assert.equal(decision.approvalRequest?.auditReference.reasonCodes.includes("secret.api-key"), true);
    assert.equal(JSON.stringify(decision).includes("sk-live-1234567890"), false);
  });

  it("adds renderable approval evidence for policy ask decisions", async () => {
    const policy = new DefaultPolicyEngine();
    const resourceScope = analyzeResourceScope({ query: "delete cached context" }, "read");
    const decision = await policy.decide({
      subject: "unit",
      action: "inspect:delete-cache",
      resource: "runtime.cache",
      metadata: {
        sideEffect: "read",
        timeoutMs: 30_000
      },
      secret: createSecretRedactionDecision(""),
      resourceScope,
      sandbox: createSandboxRequirement({ sideEffect: "read", resourceScope, timeoutMs: 30_000, permissions: [] })
    });

    assert.equal(decision.action, "ask");
    assert.equal(decision.approval?.kind, "approval.required");
    assert.equal(decision.approvalRequest?.decisionOptions.includes("allow"), true);
    assert.equal(decision.approvalSummary?.allowedDecisions.includes("cancel"), true);
    assert.equal(decision.approvalSummary?.referencePitFixtureIds.includes("pit.headless-trust.fail-closed"), true);
  });

  it("denies headless approval by default", async () => {
    const fixture = getReferencePitFixture("pit.headless-trust.fail-closed");
    assert.equal(fixture?.evidenceIds.includes("policy:headless-fail-closed"), true);
    const broker = new HeadlessApprovalBroker(false);
    const approval = buildApprovalRequest("Write workspace file?");
    const decision = await broker.requestApproval(approval);

    assert.equal(decision.approved, false);
    assert.equal(decision.schemaVersion, APPROVAL_SCHEMA_VERSION);
    assert.equal(decision.approvalId, approval.approvalId);
    assert.equal(decision.reasonCode, "headless.fail_closed");
    assert.equal((decision.metadata.referencePitFixtureIds as readonly string[]).includes("pit.headless-trust.fail-closed"), true);
    assert.match(decision.reason, /Denied by headless default/);
  });

  it("classifies shell parser fallback risks as manually reviewable or sandbox-required", () => {
    const fixture = getReferencePitFixture("pit.shell-parser.fallback-risk");
    assert.equal(fixture?.evidenceIds.includes("policy:shell-fallback-risk"), true);
    const resourceScope = analyzeResourceScope({
      command: "bash",
      args: ["-lc", "cd /tmp && npm test | tee out.log"],
      cwd: "/workspace"
    }, "process");
    const decision = selectSandboxDecision({
      subject: "unit",
      action: "execute:shell",
      resource: "core.shell.run",
      metadata: {
        sideEffect: "process",
        shellProfile: "bash",
        shellAnalysisStatus: "manually-reviewable",
        timeoutMs: 30_000
      },
      resourceScope,
      sandbox: createSandboxRequirement({
        sideEffect: "process",
        resourceScope,
        timeoutMs: 30_000,
        permissions: ["process:test", "shell-execute"],
        requireEnforcement: true
      })
    });

    assert.equal(decision.action, "require-sandbox");
    assert.equal(decision.requirements.requireEnforcement, true);
  });

  it("exposes shell fallback evidence for policy decisions", async () => {
    const policy = new DefaultPolicyEngine();
    const resourceScope = analyzeResourceScope({
      command: "bash",
      args: ["-lc", "cd /tmp && npm test | tee out.log"],
      cwd: "/workspace"
    }, "process");
    const decision = await policy.decide({
      subject: "unit",
      action: "execute:shell",
      resource: "core.shell.run",
      metadata: {
        sideEffect: "process",
        shellProfile: "bash",
        shellAnalysisStatus: "manually-reviewable",
        timeoutMs: 30_000
      },
      resourceScope,
      sandbox: createSandboxRequirement({
        sideEffect: "process",
        resourceScope,
        timeoutMs: 30_000,
        permissions: ["process:test", "shell-execute"],
        requireEnforcement: true
      })
    });

    assert.equal(decision.action, "require-sandbox");
    assert.equal(decision.approval?.kind, "approval.denied");
    assert.equal(decision.approvalSummary?.referencePitFixtureIds.includes("pit.shell-parser.fallback-risk"), true);
    assert.equal(decision.approvalSummary?.riskSummaries.some((summary) => summary.kind === "shell"), true);
  });
});

function buildApprovalRequest(prompt: string): ApprovalRequest {
  const trace = {
    traceId: asId<"trace">("trace-approval-test"),
    spanId: asId<"span">("span-approval-test"),
    correlationId: asId<"correlation">("correlation-approval-test")
  };
  const auditReference: ApprovalRequest["auditReference"] = {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    traceId: trace.traceId,
    correlationId: trace.correlationId,
    policyDecision: "ask",
    reasonCodes: ["policy.side-effect.ask"],
    redaction: { class: "internal" as const }
  };
  return {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    approvalId: "approval:test" as ApprovalId,
    subject: "unit",
    action: "execute:file.write",
    resource: "core.file.write",
    metadata: { sideEffect: "write" },
    prompt,
    decisionOptions: ["allow", "deny", "cancel"],
    summary: {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      title: "Approval required",
      subject: "unit",
      action: "execute:file.write",
      resource: "core.file.write",
      targetKind: "capability",
      targetLabel: "core.file.write",
      riskSummaries: [],
      allowedDecisions: ["allow", "deny", "cancel"],
      referencePitFixtureIds: ["pit.headless-trust.fail-closed"],
      redaction: { class: "internal", fields: ["resource", "targetLabel"] },
      metadata: {}
    },
    auditReference,
    trace,
    compatibility: { schemaVersion: APPROVAL_SCHEMA_VERSION }
  };
}
