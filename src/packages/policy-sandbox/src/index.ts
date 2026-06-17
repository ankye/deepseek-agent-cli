import type {
  ApprovalAuditReference,
  ApprovalBroker,
  ApprovalDecision,
  ApprovalDecisionSource,
  ApprovalId,
  ApprovalLifecycleRecord,
  ApprovalRequest,
  ApprovalRenderSummary,
  ApprovalRiskSummary,
  JsonObject,
  PolicyAction,
  PolicyDecision,
  PolicyDecisionRecord,
  PolicyEngine,
  PolicyGateCoverageRecord,
  PolicyGateDecision,
  PolicyGateDiagnostic,
  PolicyRequest,
  RiskyOperationFamily,
  RiskyOperationTaxonomyEntry,
  RedactedError,
  RedactionMetadata,
  ResourceScope,
  SandboxAuditEvidence,
  SandboxCapabilityMatrix,
  SandboxCapabilityName,
  SandboxDecision,
  SandboxEvent,
  SandboxRequirement,
  SandboxRequest,
  SandboxRuntime,
  SecretClassification,
  SecretKind,
  SecretRedactionDecision,
  SideEffectLevel,
  TraceContext
} from "@deepseek/platform-contracts";
import { APPROVAL_SCHEMA_VERSION, MAX_EXECUTION_TIMEOUT_MS, POLICY_GATE_SCHEMA_VERSION, RISKY_OPERATION_TAXONOMY, SECRET_SANDBOX_SCHEMA_VERSION, asId } from "@deepseek/platform-contracts";

export const SECRET_REDACTION_TOKEN = "[REDACTED:secret]";

const credentialKeyPattern = /(api[_-]?key|secret|token|password|credential|auth)/i;
const providerApiKeyPattern = /\b(?:sk|ds)-[A-Za-z0-9_-]{8,}\b|\bdeepseek-[A-Za-z0-9_-]{24,}\b/g;

const secretPatterns: readonly {
  readonly kind: Exclude<SecretKind, "none" | "redaction-class">;
  readonly pattern: RegExp;
  readonly replacement: string;
  readonly reasonCode: string;
  readonly exposure: SecretClassification["exposure"];
}[] = [
  {
    kind: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-key]",
    reasonCode: "secret.private-key",
    exposure: "raw"
  },
  {
    kind: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replacement: "[REDACTED:bearer-token]",
    reasonCode: "secret.bearer-token",
    exposure: "raw"
  },
  {
    kind: "env-credential",
    pattern: /\b[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*=\s*["']?[^"'\s]+/gi,
    replacement: "[REDACTED:env-credential]",
    reasonCode: "secret.env-credential",
    exposure: "raw"
  },
  {
    kind: "credential-ref",
    pattern: /\b(?:credentialRef|credential_ref|credential):[A-Za-z0-9._:/@-]+|\bcredentialRef\s*=\s*["']?[A-Za-z0-9._:/@-]+/gi,
    replacement: "[REDACTED:credential-ref]",
    reasonCode: "secret.credential-ref",
    exposure: "reference"
  },
  {
    kind: "api-key",
    pattern: providerApiKeyPattern,
    replacement: "[REDACTED:api-key]",
    reasonCode: "secret.api-key",
    exposure: "raw"
  }
];

export function classifySecretText(text: string, redaction: RedactionMetadata = { class: "public" }): SecretClassification {
  if (redaction.class === "secret") {
    return secretClassification("redaction-class", "unsafe", "secret.redaction-class", 1, stableFingerprint(text), redaction.class);
  }
  for (const candidate of secretPatterns) {
    const matches = [...text.matchAll(new RegExp(candidate.pattern.source, candidate.pattern.flags))];
    if (matches.length === 0) continue;
    return secretClassification(candidate.kind, candidate.exposure, candidate.reasonCode, matches.length, stableFingerprint(matches[0]?.[0] ?? text), "secret");
  }
  if (hasBareSecretKeywordRisk(text)) {
    return secretClassification("generic-secret", "unsafe", "secret.keyword", 1, stableFingerprint(text), "secret");
  }
  return secretClassification("none", "none", "secret.none", 0, undefined, redaction.class);
}

export function createSecretRedactionDecision(value: unknown, redaction: RedactionMetadata = { class: "public" }): SecretRedactionDecision {
  const text = stringifyForClassification(value);
  const classification = classifySecretText(text, redaction);
  if (!classification.detected) {
    return {
      schemaVersion: SECRET_SANDBOX_SCHEMA_VERSION,
      action: "allow",
      reasonCode: "secret.none",
      classification,
      redaction: { class: redaction.class }
    };
  }
  if (classification.kind === "credential-ref" && classification.exposure === "reference") {
    return {
      schemaVersion: SECRET_SANDBOX_SCHEMA_VERSION,
      action: "allow",
      reasonCode: classification.reasonCode,
      classification,
      redactedText: redactSecretText(text),
      redaction: { class: "sensitive", fields: ["redactedText"] }
    };
  }
  return {
    schemaVersion: SECRET_SANDBOX_SCHEMA_VERSION,
    action: classification.exposure === "raw" ? "rewrite" : "deny",
    reasonCode: classification.reasonCode,
    classification,
    redactedText: redactSecretText(text),
    redaction: { class: "secret", fields: ["redactedText", "classification.evidence"] }
  };
}

export function redactSecretText(text: string): string {
  let redacted = text;
  for (const candidate of secretPatterns) {
    redacted = redacted.replace(new RegExp(candidate.pattern.source, candidate.pattern.flags), candidate.replacement);
  }
  redacted = redacted.replace(/\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\b/gi, "$1");
  return redacted;
}

export function redactJsonSecrets<T>(value: T): T {
  return redactUnknown(value, "") as T;
}

export function analyzeResourceScope(input: JsonObject, sideEffect: SideEffectLevel): ResourceScope {
  const path = typeof input.path === "string" ? input.path : undefined;
  const workspaceRoot = typeof input.workspaceRoot === "string" ? input.workspaceRoot : undefined;
  const cwd = typeof input.cwd === "string" ? input.cwd : workspaceRoot;
  const command = typeof input.command === "string" ? input.command : undefined;
  const args = Array.isArray(input.args) ? input.args.map(String) : undefined;
  const access: "read" | "write" | "execute" = sideEffect === "write" ? "write" : sideEffect === "process" ? "execute" : "read";
  const paths = path || workspaceRoot || cwd
    ? [{
        path: path ?? cwd ?? workspaceRoot ?? ".",
        ...(workspaceRoot ? { workspaceRoot } : {}),
        traversal: path && (path.includes("..") || path.startsWith("~") || path.includes("\0")) ? "rejected" as const : "unknown" as const,
        access
      }]
    : [];
  return {
    schemaVersion: SECRET_SANDBOX_SCHEMA_VERSION,
    kind: sideEffect === "write" ? "filesystem" : sideEffect === "process" ? "process" : sideEffect === "network" ? "network" : sideEffect === "read" ? "workspace" : "none",
    paths,
    ...(cwd ? { cwd } : {}),
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    environment: sideEffect === "process" ? "scoped" : "none",
    networkHosts: typeof input.host === "string" ? [input.host] : [],
    nativeCapabilities: typeof input.nativeCapability === "string" ? [input.nativeCapability] : [],
    rollbackAvailable: sideEffect === "write",
    redaction: { class: "internal", fields: ["paths.path", "paths.workspaceRoot", "cwd"] }
  };
}

export function createSandboxRequirement(input: {
  readonly sideEffect: SideEffectLevel;
  readonly resourceScope: ResourceScope;
  readonly timeoutMs: number;
  readonly permissions?: readonly string[];
  readonly profile?: string;
  readonly requireEnforcement?: boolean;
}): SandboxRequirement {
  return {
    schemaVersion: SECRET_SANDBOX_SCHEMA_VERSION,
    profile: input.profile ?? defaultSandboxProfile(input.sideEffect, input.permissions ?? []),
    capabilities: requiredCapabilities(input.sideEffect, input.resourceScope, input.permissions ?? []),
    resourceScope: input.resourceScope,
    timeoutMs: input.timeoutMs,
    environment: input.resourceScope.environment,
    outputRedaction: { class: "internal", fields: ["stdout", "stderr", "preview"] },
    requireEnforcement: input.requireEnforcement ?? input.sideEffect !== "none"
  };
}

export function createSandboxAuditEvidence(input: {
  readonly decision: string;
  readonly reasonCode: string;
  readonly subject: string;
  readonly resource: string;
  readonly sandboxProfile: string;
  readonly metadata?: JsonObject;
  readonly trace?: SandboxAuditEvidence["trace"];
}): SandboxAuditEvidence {
  return {
    schemaVersion: SECRET_SANDBOX_SCHEMA_VERSION,
    decision: input.decision,
    reasonCode: input.reasonCode,
    subject: redactSecretText(input.subject),
    resource: redactSecretText(input.resource),
    redactedSubject: redactSecretText(input.subject),
    redactedResource: redactSecretText(input.resource),
    sandboxProfile: input.sandboxProfile,
    ...(input.trace ? { trace: input.trace } : {}),
    metadata: redactJsonSecrets(input.metadata ?? {}) as JsonObject,
    redaction: { class: "internal", fields: ["subject", "resource", "metadata"] }
  };
}

export function listRiskyOperationTaxonomy(): readonly RiskyOperationTaxonomyEntry[] {
  return RISKY_OPERATION_TAXONOMY;
}

export function createPolicyDecisionRecord(
  request: PolicyRequest,
  decision: PolicyDecision,
  operationFamily: RiskyOperationFamily = operationFamilyFromPolicyRequest(request)
): PolicyDecisionRecord {
  const reasonCodes = policyRecordReasonCodes(request, decision);
  const bypassAttempted = hasBypassMetadata(request);
  const gateDecision = policyGateDecisionFor(request, decision, bypassAttempted);
  const scope = request.resourceScope ?? resourceScopeFromMetadata(request.metadata, sideEffectFrom(request.metadata));
  const fingerprint = stableFingerprint(JSON.stringify({
    actor: request.subject,
    operation: request.action,
    resource: request.resource,
    operationFamily,
    decision: gateDecision,
    reasonCodes
  })) ?? "unknown";
  const sandboxProfile = decision.sandboxProfile ?? decision.sandbox?.profile;
  return {
    schemaVersion: POLICY_GATE_SCHEMA_VERSION,
    recordId: `policy-decision:${fingerprint}`,
    actor: redactSecretText(request.subject),
    operation: request.action,
    operationFamily,
    scope,
    decision: gateDecision,
    reason: redactSecretText(decision.reason),
    reasonCodes,
    auditId: asId<"audit">(`audit:${fingerprint}`),
    replayBehavior: replayBehaviorFor(gateDecision),
    ...(sandboxProfile ? { sandboxProfile } : {}),
    bypassAttempted,
    redaction: { class: "internal", fields: ["actor", "scope", "reason"] }
  };
}

export function withPolicyDecisionRecord(request: PolicyRequest, decision: PolicyDecision): PolicyDecision {
  return decision.record ? decision : { ...decision, record: createPolicyDecisionRecord(request, decision) };
}

export function collectPolicyGateCoverageRecords(): readonly PolicyGateCoverageRecord[] {
  return POLICY_GATE_COVERAGE_RECORDS;
}

export function createPolicyGateFixtureRecords(): readonly PolicyDecisionRecord[] {
  const base = {
    subject: "fixture",
    resource: "policy.fixture",
    resourceScope: analyzeResourceScope({ path: "fixture.txt", workspaceRoot: "/workspace" }, "read"),
    sandbox: undefined,
    auditEvidence: undefined
  };
  const fixtures: readonly { readonly action: string; readonly metadata: JsonObject; readonly decision: PolicyDecision }[] = [
    { action: "execute:file.read", metadata: { sideEffect: "read" }, decision: { action: "allow", reason: "Allowed fixture." } },
    { action: "execute:file.write", metadata: { sideEffect: "write" }, decision: { action: "deny", reason: "Denied fixture." } },
    { action: "execute:plugin", metadata: { sideEffect: "process" }, decision: { action: "ask", reason: "Prompt fixture." } },
    { action: "execute:credential", metadata: { sideEffect: "none", prompt: "sk-live-1234567890" }, decision: { action: "rewrite", reason: "Secret fixture." } },
    { action: "inspect:mcp.resource", metadata: { sideEffect: "read", auditOnly: true }, decision: { action: "allow", reason: "Audit fixture." } },
    { action: "execute:shell", metadata: { sideEffect: "process", permissionMode: "bypass", breakGlass: true }, decision: { action: "deny", reason: "Bypass fixture." } }
  ];
  return fixtures.map((fixture) => createPolicyDecisionRecord({
    subject: base.subject,
    action: fixture.action,
    resource: base.resource,
    metadata: fixture.metadata,
    resourceScope: base.resourceScope
  }, fixture.decision));
}

export function selectSandboxDecision(request: PolicyRequest): SandboxDecision {
  const sideEffect = sideEffectFrom(request.metadata);
  const capabilities = request.platform?.sandboxCapabilities ?? request.platform?.descriptor.sandbox ?? fallbackCapabilities(request.platform?.descriptor.degradedReasons ?? []);
  const resourceScope = request.resourceScope ?? resourceScopeFromMetadata(request.metadata, sideEffect);
  const requirements = request.sandbox ?? sandboxRequirementFromMetadata(request.metadata, sideEffect, resourceScope);
  const reasonCodes = sandboxReasonCodes(request, sideEffect, requirements, capabilities);
  const denied = reasonCodes.some((reason) => reason.endsWith(".unavailable") || reason.endsWith(".missing") || reason.endsWith(".rejected") || reason.endsWith(".read-only") || reason === "secret.raw-exposure" || reason === "secret.unsafe-exposure" || reason === "timeout.invalid");
  const requireSandbox = request.metadata.requireSandbox === true || reasonCodes.some((reason) => reason.startsWith("shell.analysis."));
  const action: PolicyAction = denied
    ? reasonCodes.some((reason) => reason.startsWith("secret.")) ? "rewrite" : "deny"
    : requireSandbox
      ? "require-sandbox"
      : "allow";
  const profile = denied ? "platform-denied" : requireSandbox ? "enforced-required" : defaultSandboxProfile(sideEffect, permissionsFrom(request.metadata));
  return {
    schemaVersion: SECRET_SANDBOX_SCHEMA_VERSION,
    action,
    profile,
    reasonCodes: reasonCodes.length > 0 ? reasonCodes : ["sandbox.allow"],
    requirements: { ...requirements, profile },
    capabilities,
    degraded: capabilities.degraded,
    redaction: { class: "internal", fields: ["requirements.resourceScope", "capabilities.degradedReasons"] }
  };
}

const POLICY_GATE_COVERAGE_RECORDS: readonly PolicyGateCoverageRecord[] = [
  coverageRecord("file.mutation", "file", "core-coding-tools", ["core.file.write", "checkpoint.restore"], "covered", "release-blocking", ["tests/integration/secret-sandbox-policy-runtime.test.ts", "tests/contracts/runtime-kernel-contract.test.ts"]),
  coverageRecord("shell.execution", "shell", "core-coding-tools", ["core.shell.run", "core.test.run", "deepseek checks"], "covered", "release-blocking", ["tests/integration/secret-sandbox-policy-runtime.test.ts", "tests/golden/secret-sandbox-audit-replay.test.ts"]),
  coverageRecord("mcp.invocation", "mcp", "mcp-gateway", ["mcp.tool.call", "mcp.resource.read"], "covered", "release-blocking", ["tests/contracts/mcp-gateway-contracts.test.ts", "tests/integration/mcp-gateway-invocation.test.ts"]),
  coverageRecord("plugin.execution", "plugin", "plugin-system", ["plugin.command", "plugin.lifecycle", "module.permission.evaluate"], "covered", "release-blocking", ["tests/contracts/plugin-platform-foundation.test.ts", "tests/contracts/plugin-manager.test.ts"]),
  coverageRecord("credential.access", "credential", "credential-auth-management", ["credentialRef", "secure-storage"], "covered", "release-blocking", ["tests/contracts/extension-auth-boundaries.test.ts", "src/packages/policy-sandbox/src/index.test.ts"]),
  coverageRecord("remote.operation", "remote", "remote-runtime-connectivity", ["remote-runtime-connectivity"], "deferred", "warning", ["openspec/changes/enforce-policy-sandbox-gates"], [policyGateDiagnostic("POLICY_GATE_REMOTE_DEFERRED", "warning", "remote.operation", "remote", "Remote runtime is not product-ready; policy gate remains a release gate before promotion.", false)]),
  coverageRecord("sandbox.selection", "sandbox", "policy-sandbox", ["sandbox.profile", "platform-capability"], "covered", "release-blocking", ["src/packages/policy-sandbox/src/index.test.ts", "tests/golden/secret-sandbox-audit-replay.test.ts"]),
  coverageRecord("workspace.mutation", "workspace-mutation", "workspace-state-management", ["workspace.edit", "session.checkpoint"], "covered", "release-blocking", ["tests/integration/checkpoint-undo-runtime.test.ts", "tests/integration/secret-sandbox-policy-runtime.test.ts"])
];

export class DefaultPolicyEngine implements PolicyEngine {
  async decide(request: PolicyRequest): Promise<PolicyDecision> {
    const secret = request.secret ?? secretDecisionFromMetadata(request.metadata);
    const sandbox = selectSandboxDecision({
      ...request,
      secret,
      resourceScope: request.resourceScope ?? resourceScopeFromMetadata(request.metadata, sideEffectFrom(request.metadata)),
      sandbox: request.sandbox ?? sandboxRequirementFromMetadata(request.metadata, sideEffectFrom(request.metadata), request.resourceScope ?? resourceScopeFromMetadata(request.metadata, sideEffectFrom(request.metadata)))
    });
    const auditEvidence = createSandboxAuditEvidence({
      decision: sandbox.action,
      reasonCode: sandbox.reasonCodes[0] ?? "sandbox.allow",
      subject: request.subject,
      resource: request.resource,
      sandboxProfile: sandbox.profile,
      metadata: {
        policy: "deterministic-development",
        secret,
        sandbox,
        platform: request.platform?.descriptor
      }
    });
    const finalize = (decision: PolicyDecision): PolicyDecision => withPolicyDecisionRecord(request, decision);

    if (secret.action === "deny" || secret.action === "rewrite" || secret.action === "exclude") {
      return finalize(withApprovalEvidence(request, {
        action: secret.action === "rewrite" ? "rewrite" : "deny",
        reason: `Secret exposure rejected by policy: ${secret.reasonCode}`,
        rewritten: { redacted: secret.redactedText ?? SECRET_REDACTION_TOKEN },
        audit: auditEvidence,
        sandboxProfile: sandbox.profile,
        secret,
        sandbox,
        auditEvidence
      }));
    }

    if (sandbox.action === "deny" || sandbox.action === "rewrite" || sandbox.action === "require-sandbox") {
      return finalize(withApprovalEvidence(request, {
        action: sandbox.action,
        reason: `Sandbox policy ${sandbox.action}: ${sandbox.reasonCodes.join(", ")}`,
        audit: auditEvidence,
        sandboxProfile: sandbox.profile,
        secret,
        sandbox,
        auditEvidence
      }));
    }

    const sideEffect = sideEffectFrom(request.metadata);
    const permissions = permissionsFrom(request.metadata);
    if (sideEffect === "process" && permissions.includes("process:test")) {
      return finalize({
        action: "allow",
        reason: "Deterministic policy allows declared test execution",
        audit: auditEvidence,
        sandboxProfile: "development-test",
        secret,
        sandbox: { ...sandbox, profile: "development-test" },
        auditEvidence: { ...auditEvidence, sandboxProfile: "development-test" }
      });
    }
    if (sideEffect === "write" || sideEffect === "network" || sideEffect === "process") {
      return finalize(withApprovalEvidence(request, {
        action: "deny",
        reason: `Side effect ${String(sideEffect)} is not allowed by deterministic policy`,
        audit: auditEvidence,
        sandboxProfile: "development-denied",
        secret,
        sandbox: { ...sandbox, action: "deny", profile: "development-denied", reasonCodes: [...sandbox.reasonCodes, "policy.side-effect.denied"] },
        auditEvidence: { ...auditEvidence, decision: "deny", reasonCode: "policy.side-effect.denied", sandboxProfile: "development-denied" }
      }));
    }
    if (request.action.includes("delete") || request.action.includes("secret")) {
      return finalize(withApprovalEvidence(request, {
        action: "ask",
        reason: "Potentially sensitive action requires approval",
        audit: auditEvidence,
        sandboxProfile: "development",
        secret,
        sandbox: { ...sandbox, action: "ask" },
        auditEvidence
      }));
    }
    if (request.resource.includes("untrusted")) {
      return finalize(withApprovalEvidence(request, {
        action: "quarantine",
        reason: "Untrusted resource",
        audit: auditEvidence,
        sandboxProfile: "development-quarantine",
        secret,
        sandbox: { ...sandbox, action: "quarantine", profile: "development-quarantine" },
        auditEvidence
      }));
    }
    return finalize({
      action: "allow",
      reason: "Default development policy",
      audit: auditEvidence,
      sandboxProfile: sandbox.profile,
      secret,
      sandbox,
      auditEvidence
    });
  }
}

export type HeadlessApprovalDecisionProvider = (request: ApprovalRequest) => ApprovalDecision | undefined | Promise<ApprovalDecision | undefined>;

export interface HeadlessApprovalBrokerOptions {
  readonly defaultApproved?: boolean;
  readonly defaultSource?: ApprovalDecisionSource;
  readonly decisionProvider?: HeadlessApprovalDecisionProvider;
}

export class HeadlessApprovalBroker implements ApprovalBroker {
  private readonly defaultApproved: boolean;
  private readonly defaultSource: ApprovalDecisionSource;
  private readonly decisionProvider: HeadlessApprovalDecisionProvider | undefined;

  constructor(options: boolean | HeadlessApprovalBrokerOptions = false) {
    if (typeof options === "boolean") {
      this.defaultApproved = options;
      this.defaultSource = "headless-default";
      return;
    }
    this.defaultApproved = options.defaultApproved ?? false;
    this.defaultSource = options.defaultSource ?? "headless-default";
    this.decisionProvider = options.decisionProvider;
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const auditReference = request.auditReference ?? approvalAuditReferenceFromRequest(request);
    const provided = await this.decisionProvider?.(request);
    if (provided) {
      return {
        ...provided,
        schemaVersion: APPROVAL_SCHEMA_VERSION,
        approvalId: request.approvalId,
        approved: provided.approved && provided.decision === "allow",
        auditReference: provided.auditReference ?? auditReference,
        trace: provided.trace ?? request.trace,
        redaction: provided.redaction ?? { class: "internal", fields: ["reason", "metadata.prompt"] },
        metadata: {
          summary: approvalSummaryFromRequest(request),
          ...provided.metadata
        }
      };
    }
    return {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      approvalId: request.approvalId ?? approvalIdFromPrompt(request.prompt),
      approved: this.defaultApproved,
      decision: this.defaultApproved ? "allow" : "deny",
      source: this.defaultSource,
      reason: this.defaultApproved ? `Approved: ${request.prompt}` : `Denied by headless default: ${request.prompt}`,
      reasonCode: this.defaultApproved ? "headless.default_allow" : "headless.fail_closed",
      auditReference,
      trace: request.trace ?? auditReference.trace as ApprovalDecision["trace"],
      redaction: { class: "internal", fields: ["reason", "metadata.prompt"] },
      metadata: {
        prompt: request.prompt,
        summary: approvalSummaryFromRequest(request),
        referencePitFixtureIds: this.defaultApproved ? [] : ["pit.headless-trust.fail-closed"]
      }
    };
  }
}

export class DevelopmentSandboxRuntime implements SandboxRuntime {
  async *run(request: SandboxRequest): AsyncIterable<SandboxEvent> {
    yield {
      kind: "recorded",
      mode: "development",
      metadata: redactJsonSecrets({
        command: request.command,
        args: request.args,
        controls: request.controls,
        enforcement: "not-production"
      }) as JsonObject
    };
  }
}

function coverageRecord(
  operationId: string,
  operationFamily: RiskyOperationFamily,
  ownerPackage: string,
  entrypoints: readonly string[],
  coverage: PolicyGateCoverageRecord["coverage"],
  releaseGate: PolicyGateCoverageRecord["releaseGate"],
  evidenceIds: readonly string[],
  diagnostics: readonly PolicyGateDiagnostic[] = []
): PolicyGateCoverageRecord {
  return {
    schemaVersion: POLICY_GATE_SCHEMA_VERSION,
    operationId,
    operationFamily,
    ownerPackage,
    entrypoints,
    coverage,
    releaseGate,
    evidenceIds,
    diagnostics,
    redaction: { class: "internal", fields: ["entrypoints", "evidenceIds", "diagnostics.message"] }
  };
}

function policyGateDiagnostic(
  code: string,
  severity: PolicyGateDiagnostic["severity"],
  operationId: string,
  operationFamily: RiskyOperationFamily,
  message: string,
  releaseBlocking: boolean
): PolicyGateDiagnostic {
  return {
    code,
    severity,
    operationId,
    operationFamily,
    message,
    releaseBlocking,
    redaction: { class: "internal", fields: ["message"] }
  };
}

function policyGateDecisionFor(
  request: PolicyRequest,
  decision: PolicyDecision,
  bypassAttempted: boolean
): PolicyGateDecision {
  if (bypassAttempted && decision.action !== "allow") return "bypass-detected";
  if (request.metadata.auditOnly === true && decision.action === "allow") return "audit-only";
  if (decision.action === "ask") return "prompt";
  if (decision.action === "rewrite") return "redact";
  return decision.action;
}

function replayBehaviorFor(decision: PolicyGateDecision): PolicyDecisionRecord["replayBehavior"] {
  if (decision === "audit-only") return "audit-only";
  if (decision === "redact") return "redacted-replay";
  if (decision === "deny" || decision === "bypass-detected" || decision === "quarantine") return "fail-closed";
  return "deterministic";
}

function operationFamilyFromPolicyRequest(request: PolicyRequest): RiskyOperationFamily {
  const explicit = request.metadata.riskyOperationFamily;
  if (isRiskyOperationFamily(explicit)) return explicit;
  const haystack = `${request.action} ${request.resource} ${JSON.stringify(request.metadata)}`.toLowerCase();
  if (haystack.includes("mcp")) return "mcp";
  if (haystack.includes("plugin") || haystack.includes("extension")) return "plugin";
  if (haystack.includes("credential") || haystack.includes("secure-storage") || haystack.includes("secret")) return "credential";
  if (haystack.includes("remote")) return "remote";
  if (haystack.includes("sandbox")) return "sandbox";
  if (haystack.includes("workspace") && (haystack.includes("mutation") || haystack.includes("edit"))) return "workspace-mutation";
  if (haystack.includes("shell") || haystack.includes("process") || haystack.includes("command") || sideEffectFrom(request.metadata) === "process") return "shell";
  if (haystack.includes("file") || haystack.includes("checkpoint") || sideEffectFrom(request.metadata) === "write") return "file";
  return "sandbox";
}

function isRiskyOperationFamily(value: unknown): value is RiskyOperationFamily {
  return value === "file"
    || value === "shell"
    || value === "mcp"
    || value === "plugin"
    || value === "credential"
    || value === "remote"
    || value === "sandbox"
    || value === "workspace-mutation";
}

function policyRecordReasonCodes(request: PolicyRequest, decision: PolicyDecision): readonly string[] {
  const codes = new Set<string>(approvalReasonCodes(request, decision));
  if (decision.action === "allow" && request.metadata.auditOnly === true) codes.add("policy.audit-only");
  if (hasBypassMetadata(request)) codes.add("policy.bypass.detected");
  if (codes.size === 0) codes.add(`policy.${decision.action}`);
  return [...codes].sort();
}

function sandboxReasonCodes(
  request: PolicyRequest,
  sideEffect: SideEffectLevel,
  requirements: SandboxRequirement,
  capabilities: SandboxCapabilityMatrix
): readonly string[] {
  const reasons: string[] = [];
  const secret = request.secret ?? secretDecisionFromMetadata(request.metadata);
  if (secret.classification.exposure === "raw") reasons.push("secret.raw-exposure");
  if (secret.classification.exposure === "unsafe") reasons.push("secret.unsafe-exposure");
  if (!Number.isFinite(requirements.timeoutMs) || requirements.timeoutMs <= 0 || requirements.timeoutMs > MAX_EXECUTION_TIMEOUT_MS) reasons.push("timeout.invalid");
  if (sideEffect === "write" && !capabilities.filesystem.write) reasons.push(capabilities.filesystem.readOnly ? "filesystem.read-only" : "filesystem.write.unavailable");
  if (sideEffect === "write" && requirements.resourceScope.paths.length === 0) reasons.push("filesystem.path-scope.missing");
  if (requirements.resourceScope.paths.some((path) => path.traversal === "rejected")) reasons.push("filesystem.path-scope.rejected");
  if (sideEffect === "process" && !capabilities.processExecution.execute) reasons.push("process.unavailable");
  if (sideEffect === "process" && !capabilities.shell.execute && (requirements.capabilities.includes("shell-execute") || typeof request.metadata.shellProfile === "string")) reasons.push("shell.unavailable");
  if (sideEffect === "process" && typeof request.metadata.shellAnalysisStatus === "string" && request.metadata.shellAnalysisStatus !== "safe") {
    reasons.push(`shell.analysis.${request.metadata.shellAnalysisStatus}`);
  }
  if (sideEffect === "process" && !requirements.resourceScope.cwd) reasons.push("process.cwd.missing");
  if (sideEffect === "network" && !capabilities.network.access) reasons.push("network.unavailable");
  if (requirements.capabilities.includes("secure-storage") && capabilities.secureStorage.status === "unavailable") reasons.push("secure-storage.unavailable");
  if (requirements.capabilities.includes("native-access") && !capabilities.native.access) reasons.push("native.unavailable");
  return reasons;
}

function secretDecisionFromMetadata(metadata: JsonObject): SecretRedactionDecision {
  const existing = metadata.secretExposure;
  if (isJsonObject(existing) && typeof existing.action === "string" && isJsonObject(existing.classification)) {
    return existing as unknown as SecretRedactionDecision;
  }
  return createSecretRedactionDecision(metadata);
}

function resourceScopeFromMetadata(metadata: JsonObject, sideEffect: SideEffectLevel): ResourceScope {
  const existing = metadata.resourceScope;
  if (isJsonObject(existing) && typeof existing.schemaVersion === "string" && Array.isArray(existing.paths)) {
    return existing as unknown as ResourceScope;
  }
  return analyzeResourceScope(metadata, sideEffect);
}

function sandboxRequirementFromMetadata(metadata: JsonObject, sideEffect: SideEffectLevel, resourceScope: ResourceScope): SandboxRequirement {
  const existing = metadata.sandboxRequirements;
  if (isJsonObject(existing) && typeof existing.schemaVersion === "string" && Array.isArray(existing.capabilities)) {
    return existing as unknown as SandboxRequirement;
  }
  const timeoutMs = typeof metadata.timeoutMs === "number" ? metadata.timeoutMs : 30_000;
  return createSandboxRequirement({
    sideEffect,
    resourceScope,
    timeoutMs,
    permissions: permissionsFrom(metadata)
  });
}

function permissionsFrom(metadata: JsonObject): readonly string[] {
  return Array.isArray(metadata.permissions) ? metadata.permissions.map(String) : [];
}

function sideEffectFrom(metadata: JsonObject): SideEffectLevel {
  const sideEffect = String(metadata.sideEffect ?? "none");
  return sideEffect === "read" || sideEffect === "write" || sideEffect === "network" || sideEffect === "process" ? sideEffect : "none";
}

function requiredCapabilities(sideEffect: SideEffectLevel, scope: ResourceScope, permissions: readonly string[]): readonly SandboxCapabilityName[] {
  const capabilities = new Set<SandboxCapabilityName>();
  if (sideEffect === "read") capabilities.add("filesystem-read");
  if (sideEffect === "write") {
    capabilities.add("filesystem-read");
    capabilities.add("filesystem-write");
  }
  if (sideEffect === "process") {
    capabilities.add("process-execute");
    capabilities.add("environment-read");
  }
  if (sideEffect === "network") capabilities.add("network-access");
  if (scope.nativeCapabilities.length > 0 || permissions.some((permission) => permission.startsWith("native:"))) capabilities.add("native-access");
  if (permissions.some((permission) => permission.includes("credential") || permission.includes("secret"))) capabilities.add("secure-storage");
  return [...capabilities].sort();
}

function defaultSandboxProfile(sideEffect: SideEffectLevel, permissions: readonly string[]): string {
  if (sideEffect === "none") return "none";
  if (sideEffect === "read") return "read-only";
  if (sideEffect === "process" && permissions.includes("process:test")) return "development-test";
  return `development-${sideEffect}`;
}

function fallbackCapabilities(degradedReasons: readonly string[] = []): SandboxCapabilityMatrix {
  return {
    schemaVersion: SECRET_SANDBOX_SCHEMA_VERSION,
    filesystem: { read: true, write: true, readOnly: false, traversalPolicy: "workspace-root", rollback: true },
    processExecution: { execute: true, providerStatus: "available" },
    shell: { execute: true, profile: "unknown", providerStatus: "available" },
    network: { access: true, providerStatus: "available", hostScopes: [] },
    environment: { access: "scoped" },
    native: { access: false, providerStatuses: {} },
    secureStorage: { status: "degraded", scopedReferences: true },
    degraded: degradedReasons.length > 0,
    degradedReasons,
    redaction: { class: "internal" }
  };
}

function secretClassification(
  kind: SecretKind,
  exposure: SecretClassification["exposure"],
  reasonCode: string,
  occurrences: number,
  fingerprint: string | undefined,
  redactionClass: SecretClassification["redactionClass"]
): SecretClassification {
  return {
    schemaVersion: SECRET_SANDBOX_SCHEMA_VERSION,
    detected: kind !== "none",
    kind,
    exposure,
    reasonCode,
    occurrences,
    ...(fingerprint ? { fingerprint } : {}),
    redactionClass,
    evidence: {
      detected: kind !== "none",
      kind,
      fingerprint: fingerprint ?? "",
      redaction: { class: redactionClass === "secret" ? "secret" : "internal" }
    }
  };
}

function redactUnknown(value: unknown, key: string): unknown {
  if (typeof value === "string") {
    if (credentialKeyPattern.test(key) && value.length > 0) return SECRET_REDACTION_TOKEN;
    return redactSecretText(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, key));
  if (isJsonObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      result[entryKey] = credentialKeyPattern.test(entryKey) && typeof entryValue === "string"
        ? SECRET_REDACTION_TOKEN
        : redactUnknown(entryValue, entryKey);
    }
    return result;
  }
  return value;
}

function hasBareSecretKeywordRisk(text: string): boolean {
  if (!/\b(?:api[_-]?key|password|credential)\b/i.test(text)) return false;
  if (/credential-auth-management/i.test(text)) return false;
  return /(?:^|[\s"'`{[,;])(?:api[_-]?key|password|credential)(?:\s*[:=]|["'`}\],;])/i.test(text);
}

function stringifyForClassification(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, (_key, nested) => typeof nested === "bigint" ? String(nested) : nested) ?? "";
}

function stableFingerprint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `secret:${(hash >>> 0).toString(16)}`;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withApprovalEvidence(request: PolicyRequest, decision: PolicyDecision): PolicyDecision {
  if (decision.action === "allow") return decision;
  const trace = approvalTraceFromRequest(request);
  const reasonCodes = approvalReasonCodes(request, decision);
  const referencePitFixtureIds = referencePitIdsForDecision(request, decision, reasonCodes);
  const auditReference = approvalAuditReferenceFromPolicy(request, decision, trace, reasonCodes);
  const summary = approvalSummaryFromPolicy(request, decision, reasonCodes, referencePitFixtureIds);
  const approvalRequest = approvalRequestFromPolicy(request, decision, trace, auditReference, summary);
  const lifecycle: ApprovalLifecycleRecord = {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    kind: decision.action === "ask" ? "approval.required" : "approval.denied",
    approvalId: approvalRequest.approvalId,
    ...(trace.sessionId ? { sessionId: trace.sessionId } : {}),
    trace,
    summary,
    auditReference,
    redaction: { class: "internal", fields: ["summary.resource", "summary.targetLabel", "auditReference.reasonCodes"] },
    compatibility: { schemaVersion: APPROVAL_SCHEMA_VERSION }
  };
  return {
    ...decision,
    approval: lifecycle,
    approvalRequest,
    approvalSummary: summary
  };
}

function approvalRequestFromPolicy(
  request: PolicyRequest,
  decision: PolicyDecision,
  trace: TraceContext,
  auditReference: ApprovalAuditReference,
  summary: ApprovalRenderSummary
): ApprovalRequest {
  return {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    approvalId: approvalIdFromPolicy(request, decision),
    subject: redactSecretText(request.subject),
    action: request.action,
    resource: redactSecretText(request.resource),
    metadata: approvalMetadataFromPolicy(request, decision),
    ...(request.platform ? { platform: request.platform } : {}),
    ...(request.secret ? { secret: request.secret } : {}),
    ...(request.resourceScope ? { resourceScope: request.resourceScope } : {}),
    ...(request.sandbox ? { sandbox: request.sandbox } : {}),
    ...(request.auditEvidence ? { auditEvidence: request.auditEvidence } : {}),
    prompt: approvalPromptFromPolicy(request, decision),
    decisionOptions: decision.action === "ask" ? ["allow", "deny", "cancel"] : ["deny", "cancel"],
    summary,
    auditReference,
    trace,
    ...(trace.sessionId ? { sessionId: trace.sessionId } : {}),
    compatibility: { schemaVersion: APPROVAL_SCHEMA_VERSION }
  };
}

function approvalLifecycleFromDecision(request: ApprovalRequest, decision: ApprovalDecision): ApprovalLifecycleRecord {
  const summary = approvalSummaryFromRequest(request);
  return {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    kind: decision.decision === "allow"
      ? "approval.decided"
      : decision.decision === "timeout"
        ? "approval.timeout"
        : decision.decision === "cancel"
          ? "approval.cancelled"
          : "approval.denied",
    approvalId: request.approvalId,
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    trace: decision.trace,
    summary,
    decision,
    auditReference: decision.auditReference,
    redaction: { class: "internal", fields: ["summary.resource", "summary.targetLabel", "decision.reason"] },
    compatibility: { schemaVersion: APPROVAL_SCHEMA_VERSION }
  };
}

function approvalSummaryFromPolicy(
  request: PolicyRequest,
  decision: PolicyDecision,
  reasonCodes: readonly string[],
  referencePitFixtureIds: readonly string[]
): ApprovalRenderSummary {
  const targetLabel = approvalTargetLabel(request);
  return {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    title: decision.action === "ask" ? "Approval required" : "Policy decision requires attention",
    subject: redactSecretText(request.subject),
    action: request.action,
    resource: redactSecretText(request.resource),
    capability: typeof request.metadata.capabilityId === "string" ? request.metadata.capabilityId : request.resource,
    targetKind: "capability",
    targetLabel,
    riskSummaries: approvalRiskSummaries(request, decision, reasonCodes, referencePitFixtureIds),
    allowedDecisions: decision.action === "ask" ? ["allow", "deny", "cancel"] : ["deny", "cancel"],
    referencePitFixtureIds,
    redaction: { class: "internal", fields: ["resource", "targetLabel", "riskSummaries.detail", "metadata"] },
    metadata: {
      action: decision.action,
      reason: redactSecretText(decision.reason),
      sandboxProfile: decision.sandboxProfile ?? "",
      reasonCodes
    }
  };
}

function approvalRiskSummaries(
  request: PolicyRequest,
  decision: PolicyDecision,
  reasonCodes: readonly string[],
  referencePitFixtureIds: readonly string[]
): readonly ApprovalRiskSummary[] {
  const summaries: ApprovalRiskSummary[] = [];
  const shellReasons = reasonCodes.filter((reason) => reason.startsWith("shell.") || reason.startsWith("process."));
  if (shellReasons.length > 0) {
    summaries.push(approvalRiskSummary("shell", "high", "Shell execution requires review", "Shell analysis is degraded, wrapped, unavailable, or requires sandbox enforcement.", shellReasons, referencePitFixtureIdsForKind(referencePitFixtureIds, "pit.shell-parser.fallback-risk"), {
      shellProfile: typeof request.metadata.shellProfile === "string" ? request.metadata.shellProfile : "",
      shellAnalysisStatus: typeof request.metadata.shellAnalysisStatus === "string" ? request.metadata.shellAnalysisStatus : ""
    }));
  }

  const fileReasons = reasonCodes.filter((reason) => reason.startsWith("filesystem.") || reason.startsWith("path."));
  if (fileReasons.length > 0 || request.resourceScope?.kind === "filesystem") {
    summaries.push(approvalRiskSummary("file", fileReasons.some((reason) => reason.endsWith(".rejected")) ? "critical" : "medium", "Filesystem scope requires review", "The filesystem scope, path syntax, or rollback coverage requires policy attention.", fileReasons.length > 0 ? fileReasons : ["filesystem.scope.review"], referencePitFixtureIdsForKind(referencePitFixtureIds, "pit.path-canonicalization.unsafe-syntax"), {
      pathCount: request.resourceScope?.paths.length ?? 0,
      rollbackAvailable: request.resourceScope?.rollbackAvailable ?? false
    }));
  }

  const secretReasons = reasonCodes.filter((reason) => reason.startsWith("secret."));
  if (secretReasons.length > 0) {
    summaries.push(approvalRiskSummary("redaction", "critical", "Secret exposure blocked or rewritten", "Raw or unsafe credential material was detected and only redacted evidence is available.", secretReasons, referencePitFixtureIdsForKind(referencePitFixtureIds, "pit.permission-bypass.hard-safety"), {
      secretAction: decision.secret?.action ?? request.secret?.action ?? "",
      secretKind: decision.secret?.classification.kind ?? request.secret?.classification.kind ?? ""
    }));
  }

  const platformReasons = reasonCodes.filter((reason) => reason.endsWith(".unavailable") || reason.endsWith(".missing") || reason.endsWith(".read-only") || reason === "timeout.invalid");
  if (platformReasons.length > 0) {
    summaries.push(approvalRiskSummary("platform", "high", "Platform capability is degraded", "A required platform or sandbox capability is unavailable, missing, or read-only.", platformReasons, referencePitFixtureIdsForKind(referencePitFixtureIds, "pit.permission-bypass.hard-safety"), {
      sandboxProfile: decision.sandboxProfile ?? "",
      degraded: decision.sandbox?.degraded ?? false
    }));
  }

  if (decision.action === "ask") {
    summaries.push(approvalRiskSummary("policy", "medium", "Approval required before execution", "Policy requires an explicit decision before the scheduler can run this invocation.", reasonCodes.length > 0 ? reasonCodes : ["policy.approval.required"], referencePitFixtureIds, {
      decisionOptions: ["allow", "deny", "cancel"]
    }));
  }

  if (summaries.length === 0) {
    summaries.push(approvalRiskSummary("policy", decision.action === "deny" ? "high" : "medium", "Policy decision", redactSecretText(decision.reason), reasonCodes.length > 0 ? reasonCodes : [`policy.${decision.action}`], referencePitFixtureIds, {
      action: decision.action
    }));
  }

  return summaries;
}

function approvalRiskSummary(
  kind: ApprovalRiskSummary["kind"],
  severity: ApprovalRiskSummary["severity"],
  title: string,
  detail: string,
  reasonCodes: readonly string[],
  referencePitFixtureIds: readonly string[],
  metadata: JsonObject
): ApprovalRiskSummary {
  return {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    kind,
    severity,
    title,
    detail: redactSecretText(detail),
    reasonCodes,
    referencePitFixtureIds,
    redaction: { class: "internal", fields: ["detail", "metadata"] },
    metadata: redactJsonSecrets(metadata) as JsonObject
  };
}

function approvalAuditReferenceFromPolicy(
  request: PolicyRequest,
  decision: PolicyDecision,
  trace: TraceContext,
  reasonCodes: readonly string[]
): ApprovalAuditReference {
  const audit = decision.auditEvidence ?? request.auditEvidence;
  const auditId = audit && typeof audit.metadata.auditId === "string" ? audit.metadata.auditId as ApprovalAuditReference["auditId"] : undefined;
  return {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    traceId: trace.traceId,
    correlationId: trace.correlationId,
    policyDecision: decision.action,
    reasonCodes,
    ...(auditId ? { auditId } : {}),
    redaction: { class: "internal", fields: ["reasonCodes"] }
  };
}

function approvalIdFromPolicy(request: PolicyRequest, decision: PolicyDecision): ApprovalId {
  const envelopeId = typeof request.metadata.envelopeId === "string" ? request.metadata.envelopeId : undefined;
  return `approval:${stableFingerprint(`${request.subject}:${request.action}:${request.resource}:${decision.action}:${envelopeId ?? ""}`) ?? "policy"}` as ApprovalId;
}

function approvalTraceFromRequest(request: PolicyRequest): TraceContext {
  const trace = request.auditEvidence?.trace;
  if (trace?.traceId && trace.spanId && trace.correlationId) {
    return trace;
  }
  const envelopeId = typeof request.metadata.envelopeId === "string" ? request.metadata.envelopeId : "policy";
  return {
    traceId: `trace-approval-${stableFingerprint(envelopeId) ?? "policy"}` as TraceContext["traceId"],
    spanId: `span-approval-${stableFingerprint(`${envelopeId}:span`) ?? "policy"}` as TraceContext["spanId"],
    correlationId: `corr-approval-${stableFingerprint(`${envelopeId}:corr`) ?? "policy"}` as TraceContext["correlationId"]
  };
}

function approvalReasonCodes(request: PolicyRequest, decision: PolicyDecision): readonly string[] {
  const codes = new Set<string>();
  for (const reason of decision.sandbox?.reasonCodes ?? []) codes.add(reason);
  if (decision.secret?.reasonCode) codes.add(decision.secret.reasonCode);
  if (request.secret?.reasonCode) codes.add(request.secret.reasonCode);
  if (decision.auditEvidence?.reasonCode) codes.add(decision.auditEvidence.reasonCode);
  if (request.auditEvidence?.reasonCode) codes.add(request.auditEvidence.reasonCode);
  if (typeof decision.audit?.reasonCode === "string") codes.add(decision.audit.reasonCode);
  if (decision.action === "ask") codes.add("policy.approval.required");
  if (decision.action !== "allow" && codes.size === 0) codes.add(`policy.${decision.action}`);
  return [...codes].sort();
}

function referencePitIdsForDecision(request: PolicyRequest, decision: PolicyDecision, reasonCodes: readonly string[]): readonly string[] {
  const ids = new Set<string>();
  if (decision.action === "ask") ids.add("pit.headless-trust.fail-closed");
  if (hasBypassMetadata(request) || reasonCodes.some((reason) => reason.startsWith("secret.") || reason.endsWith(".unavailable") || reason.endsWith(".missing") || reason.endsWith(".read-only"))) {
    ids.add("pit.permission-bypass.hard-safety");
  }
  if (reasonCodes.some((reason) => reason.startsWith("shell.analysis.") || reason === "shell.unavailable" || reason === "process.unavailable" || reason === "process.cwd.missing")) {
    ids.add("pit.shell-parser.fallback-risk");
  }
  if (reasonCodes.some((reason) => reason === "filesystem.path-scope.rejected" || reason === "filesystem.path-scope.missing" || reason.startsWith("path."))) {
    ids.add("pit.path-canonicalization.unsafe-syntax");
  }
  return [...ids].sort();
}

function referencePitFixtureIdsForKind(referencePitFixtureIds: readonly string[], id: string): readonly string[] {
  return referencePitFixtureIds.includes(id) ? [id] : [];
}

function hasBypassMetadata(request: PolicyRequest): boolean {
  return request.metadata.permissionMode === "bypass" || request.metadata.breakGlass === true || request.metadata.bypass === true;
}

function approvalTargetLabel(request: PolicyRequest): string {
  const command = typeof request.metadata.command === "string" ? request.metadata.command : undefined;
  const args = Array.isArray(request.metadata.args) ? request.metadata.args.map(String).join(" ") : "";
  if (command) return redactSecretText([command, args].filter(Boolean).join(" "));
  const path = request.resourceScope?.paths[0]?.path;
  if (path) return redactSecretText(path);
  return redactSecretText(request.resource);
}

function approvalPromptFromPolicy(request: PolicyRequest, decision: PolicyDecision): string {
  return `${decision.action === "ask" ? "Approve" : "Review"} ${request.action} on ${redactSecretText(request.resource)}: ${redactSecretText(decision.reason)}`;
}

function approvalMetadataFromPolicy(request: PolicyRequest, decision: PolicyDecision): JsonObject {
  return redactJsonSecrets({
    source: "policy-sandbox",
    policyAction: decision.action,
    reason: decision.reason,
    originalMetadata: request.metadata,
    sandboxProfile: decision.sandboxProfile ?? "",
    referencePitFixtureIds: decision.approvalSummary?.referencePitFixtureIds ?? []
  }) as JsonObject;
}

function approvalIdFromPrompt(prompt: string): ApprovalId {
  return `approval:${stableFingerprint(prompt) ?? "headless"}` as ApprovalId;
}

function approvalAuditReferenceFromRequest(request: ApprovalRequest): ApprovalAuditReference {
  const trace = request.trace ?? {
    traceId: "trace:approval-headless",
    spanId: "span:approval-headless",
    correlationId: "correlation:approval-headless"
  } as ApprovalDecision["trace"];
  return {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    traceId: trace.traceId,
    correlationId: trace.correlationId,
    policyDecision: request.action,
    reasonCodes: ["headless.fail_closed"],
    redaction: { class: "internal", fields: ["reasonCodes"] }
  };
}

function approvalSummaryFromRequest(request: ApprovalRequest): ApprovalRenderSummary {
  return request.summary ?? {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    title: "Approval required",
    subject: request.subject,
    action: request.action,
    resource: request.resource,
    targetKind: "capability",
    targetLabel: request.resource,
    riskSummaries: [],
    allowedDecisions: ["allow", "deny", "cancel"],
    referencePitFixtureIds: [],
    redaction: { class: "internal", fields: ["resource", "targetLabel"] },
    metadata: {}
  };
}

export function policyError(code: string, message: string, details: JsonObject = {}): RedactedError {
  return {
    code,
    message,
    retryable: false,
    redaction: { class: "internal", fields: ["details"] },
    details: redactJsonSecrets(details) as JsonObject
  };
}
