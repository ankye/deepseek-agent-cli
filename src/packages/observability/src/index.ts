import type {
  DiagnosticBundle,
  DiagnosticBundleExporter,
  DiagnosticBundleRequest,
  JsonObject,
  ObservabilityDataPrivacyClass,
  ObservabilityEvent,
  ObservabilityExportPolicy,
  ObservabilityExportTarget,
  ObservabilityPersistencePolicy,
  ObservabilityPrivacyDecision,
  ObservabilityRecord,
  ObservabilityRedactionSummary,
  ObservabilitySink,
  PrivacySettings,
  RedactionMetadata,
  SessionId,
  UsageBudgetManager,
  UsageRecord
} from "@deepseek/platform-contracts";
import { OBSERVABILITY_SCHEMA_VERSION } from "@deepseek/platform-contracts";

export const defaultPrivacySettings: PrivacySettings = {
  schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
  localDiagnosticsEnabled: true,
  telemetryEnabled: false,
  allowExternalExport: false,
  maxLocalRecords: 1000,
  redaction: { class: "internal", fields: ["fields", "trace"] }
};

const MAX_OBSERVABILITY_TEXT_CHARS = 1200;

const localBundlePolicy: ObservabilityExportPolicy = {
  target: "local-bundle",
  allowSensitive: true,
  allowSecret: false,
  requireTelemetryEnabled: false,
  requireExplicitExternalExport: false
};

const externalTelemetryPolicy: ObservabilityExportPolicy = {
  target: "external-telemetry",
  allowSensitive: false,
  allowSecret: false,
  requireTelemetryEnabled: true,
  requireExplicitExternalExport: true
};

export class InMemoryObservabilitySink implements ObservabilitySink, DiagnosticBundleExporter {
  private readonly records: ObservabilityRecord[] = [];
  private nextRecord = 1;

  constructor(private readonly settings: PrivacySettings = defaultPrivacySettings) {}

  async emit(event: ObservabilityEvent): Promise<void> {
    if (!this.settings.localDiagnosticsEnabled) return;
    if (this.records.length >= this.settings.maxLocalRecords) {
      this.records.shift();
    }
    this.records.push(this.toRecord(event));
  }

  async drain(): Promise<readonly ObservabilityRecord[]> {
    return [...this.records];
  }

  async createDiagnosticBundle(request: DiagnosticBundleRequest): Promise<DiagnosticBundle> {
    const target = request.target;
    const policy = request.exportPolicy ?? policyFor(target);
    const decision = this.decideExport(target, policy);
    const maxRecords = Math.max(0, request.maxRecords ?? this.records.length);
    const selected = target === "local-bundle" || decision.exportAllowed ? this.records.slice(-maxRecords) : [];
    const redactionSummary = summarizeRecords(selected);
    return {
      schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
      bundleId: `diagnostic-bundle-${stableHash(`${target}:${request.reason}:${this.records.length}:${maxRecords}`)}`,
      generatedAt: new Date(0).toISOString(),
      target,
      reason: redactSecretText(request.reason),
      records: selected,
      selectedRecordCount: selected.length,
      totalRecordCount: this.records.length,
      truncated: selected.length < this.records.length,
      privacyDecision: decision,
      redactionSummary,
      compatibility: { schemaVersion: OBSERVABILITY_SCHEMA_VERSION },
      redaction: { class: redactionClassForSummary(redactionSummary), fields: ["records", "reason"] }
    };
  }

  decideExport(target: ObservabilityExportTarget, policy: ObservabilityExportPolicy = policyFor(target)): ObservabilityPrivacyDecision {
    if (target === "local-bundle") {
      return privacyDecision("allow-local", target, "privacy.local-diagnostics", true, false);
    }
    if (policy.requireTelemetryEnabled && !this.settings.telemetryEnabled) {
      return privacyDecision("deny-export", target, "privacy.telemetry-disabled", this.settings.localDiagnosticsEnabled, false);
    }
    if (policy.requireExplicitExternalExport && !this.settings.allowExternalExport) {
      return privacyDecision("deny-export", target, "privacy.external-export-disabled", this.settings.localDiagnosticsEnabled, false);
    }
    return privacyDecision("allow-export", target, "privacy.export-allowed", this.settings.localDiagnosticsEnabled, true);
  }

  private toRecord(event: ObservabilityEvent): ObservabilityRecord {
    const redactedFields = redactJson(observabilityFields(event));
    const summary = summarizeRedactedJson(redactedFields);
    const declaredPrivacyClass = event.dataPrivacyClass ?? privacyClassFromSummary(summary);
    const redaction = event.redaction ?? redactionFor(declaredPrivacyClass, summary);
    const persistence = event.persistence ?? persistenceFor(declaredPrivacyClass, this.settings);
    const privacyDecisionForRecord = persistence.retainLocal
      ? privacyDecision("allow-local", "local-bundle", "privacy.local-record-retained", true, false)
      : privacyDecision("drop", "local-bundle", "privacy.local-diagnostics-disabled", false, false);
    return {
      ...event,
      schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
      recordId: `observability-record-${this.nextRecord++}`,
      fields: redactedFields.value,
      dataPrivacyClass: declaredPrivacyClass,
      redaction,
      persistence,
      compatibility: event.compatibility ?? { schemaVersion: OBSERVABILITY_SCHEMA_VERSION },
      privacyDecision: privacyDecisionForRecord,
      redactionSummary: summary
    };
  }
}

function observabilityFields(event: ObservabilityEvent): JsonObject {
  if (event.name === "visible.reasoning.recorded") return visibleReasoningRecordBundleFields(event.fields);
  if (event.name === "visible.reasoning.projected") return visibleReasoningProjectionBundleFields(event.fields);
  return event.fields;
}

function visibleReasoningRecordBundleFields(fields: JsonObject): JsonObject {
  const evidence = arrayField(fields.evidence);
  return {
    schemaVersion: stringField(fields.schemaVersion),
    recordId: stringField(fields.recordId),
    sessionId: stringField(fields.sessionId),
    turnId: stringField(fields.turnId),
    trace: traceBundleFields(objectField(fields.trace)),
    actor: stringField(fields.actor),
    stepKind: stringField(fields.stepKind),
    status: stringField(fields.status),
    certainty: stringField(fields.certainty),
    summary: stringField(fields.summary),
    evidenceLinkCount: evidence.length,
    evidenceFingerprints: evidence.map(evidenceFingerprint).filter((value): value is string => typeof value === "string"),
    order: objectField(fields.order),
    privacyClass: stringField(fields.privacyClass),
    redaction: objectField(fields.redaction),
    pitFixtureIds: stringArrayField(fields.pitFixtureIds)
  };
}

function visibleReasoningProjectionBundleFields(fields: JsonObject): JsonObject {
  return {
    schemaVersion: stringField(fields.schemaVersion),
    projectionId: stringField(fields.projectionId),
    renderer: stringField(fields.renderer),
    detailLevel: stringField(fields.detailLevel),
    sessionId: stringField(fields.sessionId),
    turnId: stringField(fields.turnId),
    activeRecordId: stringField(fields.activeRecordId),
    summary: objectField(fields.summary),
    replayFingerprint: stringField(fields.replayFingerprint),
    recordSummaries: arrayField(fields.records).map((record) => objectField(record)).map(visibleReasoningRecordBundleFields),
    redaction: objectField(fields.redaction)
  };
}

function traceBundleFields(trace: JsonObject): JsonObject {
  return {
    traceId: stringField(trace.traceId),
    spanId: stringField(trace.spanId),
    correlationId: stringField(trace.correlationId)
  };
}

function evidenceFingerprint(value: unknown): string | undefined {
  const link = objectField(value);
  return stringField(link.fingerprint) ?? `${stringField(link.kind) ?? "evidence"}:${stringField(objectField(link.target).id) ?? "unknown"}`;
}

function objectField(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function arrayField(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArrayField(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function redactObservabilityArtifact<T>(value: T): T {
  return redactJson(value).value as T;
}

export interface TraceBudgetEvidenceRequest {
  readonly sessionId: SessionId;
  readonly reason: string;
  readonly maxRecords?: number;
  readonly proposedUsage?: Partial<UsageRecord>;
}

export interface TraceBudgetUsageTotal extends JsonObject {
  readonly sessionId: SessionId;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  readonly elapsedMs: number;
}

export interface TraceBudgetEvidence extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly familyId: "observability.trace-budget";
  readonly status: "completed" | "degraded";
  readonly sessionId: SessionId;
  readonly diagnosticBundle: DiagnosticBundle;
  readonly usageTotal: TraceBudgetUsageTotal;
  readonly budgetAllowed: boolean;
  readonly budgetWarning?: string;
  readonly budgetHardLimit?: string;
  readonly diagnostics: readonly string[];
  readonly replayFingerprint: string;
  readonly redaction: { readonly class: "internal"; readonly fields: readonly string[] };
}

export async function createTraceBudgetEvidence(
  sink: DiagnosticBundleExporter,
  usage: UsageBudgetManager,
  request: TraceBudgetEvidenceRequest
): Promise<TraceBudgetEvidence> {
  const diagnosticBundle = await sink.createDiagnosticBundle({
    target: "local-bundle",
    reason: request.reason,
    ...(request.maxRecords !== undefined ? { maxRecords: request.maxRecords } : {})
  });
  const usageTotal = usageTotalEvidence(await usage.total(request.sessionId));
  const budget = await usage.check(request.sessionId, request.proposedUsage ?? {});
  const diagnostics = [
    ...(diagnosticBundle.truncated ? ["observability.trace-budget.bundle-truncated"] : []),
    ...(budget.allowed ? [] : ["observability.trace-budget.budget-denied"])
  ];
  return {
    schemaVersion: "1.0.0",
    familyId: "observability.trace-budget",
    status: diagnostics.length > 0 ? "degraded" : "completed",
    sessionId: request.sessionId,
    diagnosticBundle,
    usageTotal,
    budgetAllowed: budget.allowed,
    ...(budget.warning ? { budgetWarning: budget.warning } : {}),
    ...(budget.hardLimit ? { budgetHardLimit: budget.hardLimit } : {}),
    diagnostics,
    replayFingerprint: `observability.trace-budget:${stableHash(JSON.stringify({
      sessionId: request.sessionId,
      bundleId: diagnosticBundle.bundleId,
      usageTotal,
      budget,
      diagnostics
    }))}`,
    redaction: { class: "internal", fields: ["diagnosticBundle.records", "usageTotal"] }
  };
}

function usageTotalEvidence(record: UsageRecord): TraceBudgetUsageTotal {
  return {
    sessionId: record.sessionId,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    costMicros: record.costMicros,
    elapsedMs: record.elapsedMs
  };
}

function policyFor(target: ObservabilityExportTarget): ObservabilityExportPolicy {
  return target === "local-bundle" ? localBundlePolicy : externalTelemetryPolicy;
}

function persistenceFor(dataPrivacyClass: ObservabilityDataPrivacyClass, settings: PrivacySettings): ObservabilityPersistencePolicy {
  return {
    scope: settings.localDiagnosticsEnabled ? "local-diagnostics" : "none",
    retainLocal: settings.localDiagnosticsEnabled,
    allowExport: settings.telemetryEnabled && settings.allowExternalExport && dataPrivacyClass !== "secret"
  };
}

function privacyDecision(
  action: ObservabilityPrivacyDecision["action"],
  target: ObservabilityExportTarget,
  reasonCode: string,
  localDiagnosticsRetained: boolean,
  exportAllowed: boolean
): ObservabilityPrivacyDecision {
  return {
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    action,
    target,
    reasonCode,
    localDiagnosticsRetained,
    exportAllowed,
    redaction: { class: "internal", fields: ["reasonCode"] }
  };
}

function redactionFor(dataPrivacyClass: ObservabilityDataPrivacyClass, summary: ObservabilityRedactionSummary): RedactionMetadata {
  if (dataPrivacyClass === "secret" || summary.highestPrivacyClass === "secret") return { class: "secret", fields: summary.redactedFields };
  if (dataPrivacyClass === "sensitive" || dataPrivacyClass === "regulated") return { class: "sensitive", fields: summary.redactedFields };
  if (dataPrivacyClass === "local") return { class: "internal", fields: summary.redactedFields };
  return { class: "public", fields: summary.redactedFields };
}

function privacyClassFromSummary(summary: ObservabilityRedactionSummary): ObservabilityDataPrivacyClass {
  return summary.highestPrivacyClass === "secret" ? "secret" : summary.redactedValueCount > 0 ? "sensitive" : "local";
}

function redactionClassForSummary(summary: ObservabilityRedactionSummary): RedactionMetadata["class"] {
  if (summary.highestPrivacyClass === "secret") return "secret";
  return summary.redactedValueCount > 0 ? "sensitive" : "internal";
}

function summarizeRecords(records: readonly ObservabilityRecord[]): ObservabilityRedactionSummary {
  const fields = new Set<string>();
  const secretFields = new Set<string>();
  let redactedValueCount = 0;
  let highestPrivacyClass: ObservabilityDataPrivacyClass = "none";
  for (const record of records) {
    for (const field of record.redactionSummary.redactedFields) fields.add(field);
    for (const field of record.redactionSummary.secretLikeFields) secretFields.add(field);
    redactedValueCount += record.redactionSummary.redactedValueCount;
    highestPrivacyClass = maxPrivacyClass(highestPrivacyClass, record.redactionSummary.highestPrivacyClass);
  }
  return {
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    redactedFields: [...fields].sort(),
    secretLikeFields: [...secretFields].sort(),
    redactedValueCount,
    highestPrivacyClass,
    redaction: { class: redactionClassForPrivacy(highestPrivacyClass), fields: [...fields].sort() }
  };
}

interface RedactedJsonResult {
  readonly value: JsonObject;
  readonly redactedFields: readonly string[];
  readonly secretLikeFields: readonly string[];
  readonly redactedValueCount: number;
}

function redactJson(value: unknown, path = "fields"): RedactedJsonResult {
  const redactedFields: string[] = [];
  const secretLikeFields: string[] = [];
  let redactedValueCount = 0;

  const visit = (input: unknown, currentPath: string): unknown => {
    if (typeof input === "string") {
      const redacted = redactSecretText(input);
      const bounded = boundObservabilityText(redacted);
      if (redacted !== input || bounded !== redacted) {
        redactedFields.push(currentPath);
        if (redacted !== input) secretLikeFields.push(currentPath);
        redactedValueCount += 1;
      }
      return bounded;
    }
    if (Array.isArray(input)) {
      return input.map((item, index) => visit(item, `${currentPath}[${index}]`));
    }
    if (input && typeof input === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input)) {
        const childPath = `${currentPath}.${key}`;
        if (isSecretKey(key)) {
          output[key] = "[REDACTED:secret]";
          redactedFields.push(childPath);
          secretLikeFields.push(childPath);
          redactedValueCount += 1;
        } else if (isProviderReasoningKey(key)) {
          output[key] = "[REDACTED:provider-reasoning]";
          redactedFields.push(childPath);
          redactedValueCount += 1;
        } else {
          output[key] = visit(item, childPath);
        }
      }
      return output;
    }
    return input;
  };

  return {
    value: visit(value, path) as JsonObject,
    redactedFields,
    secretLikeFields,
    redactedValueCount
  };
}

function summarizeRedactedJson(redacted: RedactedJsonResult): ObservabilityRedactionSummary {
  const highestPrivacyClass: ObservabilityDataPrivacyClass = redacted.secretLikeFields.length > 0
    ? "secret"
    : redacted.redactedValueCount > 0
      ? "sensitive"
      : "local";
  return {
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    redactedFields: redacted.redactedFields,
    secretLikeFields: redacted.secretLikeFields,
    redactedValueCount: redacted.redactedValueCount,
    highestPrivacyClass,
    redaction: { class: redactionClassForPrivacy(highestPrivacyClass), fields: redacted.redactedFields }
  };
}

function boundObservabilityText(value: string): string {
  return value.length > MAX_OBSERVABILITY_TEXT_CHARS ? `${value.slice(0, MAX_OBSERVABILITY_TEXT_CHARS)}... [truncated]` : value;
}

function redactSecretText(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g, "Bearer [REDACTED:token]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED:api-key]")
    .replace(/\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s"',;]+/gi, (match) => {
      const [key] = match.split("=");
      return `${key}=[REDACTED:secret]`;
    });
}

function isSecretKey(key: string): boolean {
  if (isUsageTokenCountKey(key)) return false;
  return /api[_-]?key|token|secret|password|credential/i.test(key);
}

function isUsageTokenCountKey(key: string): boolean {
  return new Set([
    "inputtokens",
    "outputtokens",
    "totaltokens",
    "reasoningtokens",
    "hittokens",
    "misstokens",
    "cachedtokens",
    "cachereadinputtokens"
  ]).has(key.toLowerCase());
}

function isProviderReasoningKey(key: string): boolean {
  return /providerReasoning|rawReasoning|reasoningTrace/i.test(key);
}

function redactionClassForPrivacy(dataPrivacyClass: ObservabilityDataPrivacyClass): RedactionMetadata["class"] {
  if (dataPrivacyClass === "secret") return "secret";
  if (dataPrivacyClass === "sensitive" || dataPrivacyClass === "regulated") return "sensitive";
  if (dataPrivacyClass === "local") return "internal";
  return "public";
}

function maxPrivacyClass(left: ObservabilityDataPrivacyClass, right: ObservabilityDataPrivacyClass): ObservabilityDataPrivacyClass {
  return privacyRank(right) > privacyRank(left) ? right : left;
}

function privacyRank(value: ObservabilityDataPrivacyClass): number {
  return ["none", "local", "sensitive", "secret", "regulated"].indexOf(value);
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `h${(hash >>> 0).toString(16)}`;
}
