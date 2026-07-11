import { createHash } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalDecisionKind,
  ApprovalAuditReference,
  ApprovalId,
  ApprovalRequest,
  CapabilityExecutionContext,
  CapabilityExecutor,
  CapabilityId,
  CapabilityManifest,
  JsonObject,
  RedactedError,
  RuntimeDependencies,
  SerializableResult,
  SessionEvent,
  SessionId,
  ToolFamilyId,
  ToolFamilyPipelineRecord,
  TraceContext
} from "@deepseek/platform-contracts";
import {
  APPROVAL_SCHEMA_VERSION,
  TOOL_FAMILY_CATALOG_SCHEMA_VERSION,
  asId
} from "@deepseek/platform-contracts";
import {
  analyzeResourceScope,
  createSandboxAuditEvidence,
  createSandboxRequirement,
  createSecretRedactionDecision,
  redactJsonSecrets
} from "@deepseek/policy-sandbox";
import { executePipeline } from "./family-pipeline-capabilities.js";

const RUNTIME_FAMILY_CATALOG_VERSION = "2026.05.runtime";
const RUNTIME_CREATED_AT = new Date(0).toISOString();
const MAX_PIPELINE_STEPS = 16;

export interface RuntimeFamilyCapabilityHost {
  requestInput?(request: RuntimeUserInputRequest): Promise<RuntimeUserInputDecision>;
}

export interface RuntimeUserInputRequest extends JsonObject {
  readonly prompt: string;
  readonly inputType: "text" | "confirm" | "choice";
  readonly choices: readonly string[];
  readonly required: boolean;
  readonly trace: TraceContext;
  readonly sessionId?: SessionId;
}

export interface RuntimeUserInputDecision extends JsonObject {
  readonly status: "answered" | "cancelled" | "timeout";
  readonly value?: string | boolean;
  readonly source: "interactive-host" | "scripted" | "test";
  readonly reason?: string;
}

export interface RuntimeFamilyCapabilityDependencies extends Pick<
RuntimeDependencies,
"capabilities" | "toolIntentPreflight" | "policy" | "approvals" | "sessions" | "agents" | "platform"
> {
  readonly userInput?: RuntimeFamilyCapabilityHost;
}

interface RuntimeFamilyDefinition {
  readonly id: CapabilityId;
  readonly name: string;
  readonly description: string;
  readonly familyId: ToolFamilyId;
  readonly domainId: "planning-control" | "pipeline-composition" | "agents-tasks";
  readonly sideEffect: CapabilityManifest["sideEffect"];
  readonly permissions: readonly string[];
  readonly hostRequirements: readonly string[];
  readonly operationProfiles: readonly import("@deepseek/platform-contracts").ToolFamilyOperationProfile[];
  readonly connectorProfile: import("@deepseek/platform-contracts").ToolFamilyConnectorKind;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly timeoutMs: number;
}

interface RuntimeFamilyTool {
  readonly manifest: CapabilityManifest;
  readonly execute: CapabilityExecutor;
}

export const runtimeFamilyCapabilityIds = {
  modePlanAutoReview: asId<"capability">("runtime.mode.plan-auto-review"),
  userInput: asId<"capability">("runtime.user.input"),
  approvalPermission: asId<"capability">("runtime.approval.permission"),
  pipelineSequence: asId<"capability">("runtime.pipeline.sequence"),
  pipelineParallel: asId<"capability">("runtime.pipeline.parallel"),
  pipelineArtifactRouting: asId<"capability">("runtime.pipeline.artifact-routing"),
  pipelineStream: asId<"capability">("runtime.pipeline.stream"),
  agentWaitResult: asId<"capability">("runtime.agent.wait-result")
} as const;

export async function registerRuntimeFamilyCapabilities(
  deps: RuntimeFamilyCapabilityDependencies,
  workspaceRoot: string
): Promise<void> {
  for (const tool of runtimeFamilyCapabilities(deps, workspaceRoot)) {
    if (await deps.capabilities.get(tool.manifest.id)) continue;
    await deps.capabilities.register(tool.manifest, tool.execute);
  }
}

export function runtimeFamilyManifests(): readonly CapabilityManifest[] {
  const noopDeps = undefined as unknown as RuntimeFamilyCapabilityDependencies;
  return runtimeFamilyCapabilities(noopDeps, "/workspace").map((tool) => tool.manifest);
}

function runtimeFamilyCapabilities(
  deps: RuntimeFamilyCapabilityDependencies,
  workspaceRoot: string
): readonly RuntimeFamilyTool[] {
  return [
    defineRuntimeFamilyCapability({
      id: runtimeFamilyCapabilityIds.modePlanAutoReview,
      name: "Plan Auto Review Mode",
      description: "Switch or report deterministic plan, auto, and review runtime mode state.",
      familyId: "mode.plan-auto-review",
      domainId: "planning-control",
      sideEffect: "none",
      permissions: ["runtime:mode"],
      hostRequirements: ["session-store"],
      operationProfiles: ["model-feedback"],
      connectorProfile: "host",
      timeoutMs: 5_000,
      inputSchema: objectSchema([], {
        mode: { type: "string", enum: ["plan", "auto", "review", "status"] },
        reason: { type: "string" }
      }),
      outputSchema: objectSchema(["status", "mode"], {
        status: { type: "string" },
        mode: { type: "string" },
        evidence: { type: "object" }
      })
    }, (input, context) => executeModePlanAutoReview(input, context, deps)),
    defineRuntimeFamilyCapability({
      id: runtimeFamilyCapabilityIds.userInput,
      name: "User Input",
      description: "Request bounded user input through an interactive host and fail closed in headless mode.",
      familyId: "user.input",
      domainId: "planning-control",
      sideEffect: "none",
      permissions: ["host:user-input"],
      hostRequirements: ["interactive-host"],
      operationProfiles: ["approval", "model-feedback"],
      connectorProfile: "host",
      timeoutMs: 30_000,
      inputSchema: objectSchema(["prompt"], {
        prompt: { type: "string" },
        inputType: { type: "string", enum: ["text", "confirm", "choice"] },
        choices: { type: "array", items: { type: "string" } },
        required: { type: "boolean" },
        defaultValue: { type: ["string", "boolean"] }
      }),
      outputSchema: objectSchema(["status"], {
        status: { type: "string" },
        value: {},
        evidence: { type: "object" }
      })
    }, (input, context) => executeUserInput(input, context, deps)),
    defineRuntimeFamilyCapability({
      id: runtimeFamilyCapabilityIds.approvalPermission,
      name: "Approval Permission",
      description: "Request approval and return auditable allow, deny, or cancel evidence.",
      familyId: "approval.permission",
      domainId: "planning-control",
      sideEffect: "none",
      permissions: ["approval:request"],
      hostRequirements: ["policy"],
      operationProfiles: ["approval"],
      connectorProfile: "host",
      timeoutMs: 30_000,
      inputSchema: objectSchema(["prompt", "action", "resource"], {
        prompt: { type: "string" },
        action: { type: "string" },
        resource: { type: "string" },
        targetKind: { type: "string" },
        riskKind: { type: "string" },
        severity: { type: "string" },
        allowedDecisions: { type: "array", items: { type: "string" } },
        metadata: { type: "object" }
      }),
      outputSchema: objectSchema(["status", "decision"], {
        status: { type: "string" },
        decision: { type: "object" },
        evidence: { type: "object" }
      })
    }, (input, context) => executeApprovalPermission(input, context, deps)),
    definePipelineCapability(runtimeFamilyCapabilityIds.pipelineSequence, "Pipeline Sequence", "pipeline.sequence", "sequence", deps, workspaceRoot),
    definePipelineCapability(runtimeFamilyCapabilityIds.pipelineParallel, "Pipeline Parallel", "pipeline.parallel", "parallel", deps, workspaceRoot),
    definePipelineCapability(runtimeFamilyCapabilityIds.pipelineArtifactRouting, "Pipeline Artifact Routing", "pipeline.artifact-routing", "artifact-routing", deps, workspaceRoot),
    definePipelineCapability(runtimeFamilyCapabilityIds.pipelineStream, "Pipeline Stream", "pipeline.stream", "stream", deps, workspaceRoot),
    defineRuntimeFamilyCapability({
      id: runtimeFamilyCapabilityIds.agentWaitResult,
      name: "Agent Wait Result",
      description: "Wait for a worker result with deterministic timeout and cancellation evidence.",
      familyId: "agent.wait-result",
      domainId: "agents-tasks",
      sideEffect: "none",
      permissions: ["agent:wait"],
      hostRequirements: ["runtime", "agent-manager"],
      operationProfiles: ["model-feedback"],
      connectorProfile: "built-in",
      timeoutMs: 30_000,
      inputSchema: objectSchema([], {
        workerInstanceId: { type: "string" },
        workerSessionId: { type: "string" },
        parentSessionId: { type: "string" },
        timeoutMs: { type: "number" }
      }),
      outputSchema: objectSchema(["status"], {
        status: { type: "string" },
        workerResult: { type: "object" },
        evidence: { type: "object" }
      })
    }, (input, context) => executeAgentWaitResult(input, context, deps))
  ];
}

function definePipelineCapability(
  id: CapabilityId,
  name: string,
  familyId: ToolFamilyId,
  kind: ToolFamilyPipelineRecord["kind"],
  deps: RuntimeFamilyCapabilityDependencies,
  workspaceRoot: string
): RuntimeFamilyTool {
  return defineRuntimeFamilyCapability({
    id,
    name,
    description: `Execute a bounded ${kind} runtime pipeline through the capability registry.`,
    familyId,
    domainId: "pipeline-composition",
    sideEffect: "none",
    permissions: ["pipeline:execute"],
    hostRequirements: kind === "parallel" || kind === "stream" ? ["runtime", "scheduler"] : ["runtime"],
    operationProfiles: kind === "artifact-routing" || kind === "stream" ? ["pipeline", "artifact"] : ["pipeline"],
    connectorProfile: "built-in",
    timeoutMs: kind === "stream" ? 30_000 : 60_000,
    inputSchema: objectSchema(["steps"], {
      steps: { type: "array", items: { type: "object" }, maxItems: MAX_PIPELINE_STEPS },
      pipelineId: { type: "string" },
      artifactLimitBytes: { type: "number" },
      chunks: { type: "array" },
      stream: { type: "string" }
    }),
    outputSchema: objectSchema(["record", "evidence"], {
      record: { type: "object" },
      artifacts: { type: "array" },
      evidence: { type: "object" }
    })
  }, (input, context) => executePipeline(input, context, deps, workspaceRoot, familyId, kind));
}

function defineRuntimeFamilyCapability(definition: RuntimeFamilyDefinition, execute: CapabilityExecutor): RuntimeFamilyTool {
  const resourceScope = analyzeResourceScope({}, definition.sideEffect);
  const sandboxRequirements = createSandboxRequirement({
    sideEffect: definition.sideEffect,
    resourceScope,
    timeoutMs: definition.timeoutMs,
    permissions: definition.permissions
  });
  const manifest: CapabilityManifest = {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    source: "builtin",
    version: "1.0.0",
    trust: "trusted",
    sideEffect: definition.sideEffect,
    permissions: definition.permissions,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    enabled: true,
    timeoutMs: definition.timeoutMs,
    replayPolicy: { replayable: true, snapshot: `runtime-family:${definition.familyId}`, deterministic: true },
    projection: {
      modelVisible: true,
      hostVisible: true,
      executorVisible: false,
      outputBounded: true,
      connectorTrust: "trusted",
      providerSupport: definition.connectorProfile === "host" ? "connector" : "not_applicable",
      policyTags: ["runtime-family", `family:${definition.familyId}`, `domain:${definition.domainId}`],
      agentScopeIds: ["default", definition.familyId]
    },
    toolFamily: {
      schemaVersion: TOOL_FAMILY_CATALOG_SCHEMA_VERSION,
      catalogVersion: RUNTIME_FAMILY_CATALOG_VERSION,
      domainId: definition.domainId,
      familyId: definition.familyId,
      toolId: String(definition.id),
      implementationState: "implemented",
      maturity: "baseline",
      riskClass: "orchestration",
      operationProfiles: definition.operationProfiles,
      hostRequirements: definition.hostRequirements,
      connectorProfile: definition.connectorProfile,
      scorecardRubricId: `rubric.${definition.familyId}.baseline`,
      redaction: { class: "internal" }
    },
    compatibility: { schemaVersion: "1.0.0", requiresRuntime: true },
    secretExposure: createSecretRedactionDecision("", { class: "public" }),
    resourceScope,
    sandboxRequirements,
    audit: createSandboxAuditEvidence({
      decision: "manifest",
      reasonCode: `manifest.${definition.familyId}`,
      subject: "runtime",
      resource: String(definition.id),
      sandboxProfile: sandboxRequirements.profile
    }),
    security: {
      modelVisible: true,
      hostVisible: true,
      executorVisible: false,
      outputRedaction: "secret-aware"
    }
  };
  return { manifest, execute };
}

async function executeModePlanAutoReview(
  input: JsonObject,
  context: CapabilityExecutionContext,
  deps: RuntimeFamilyCapabilityDependencies
): Promise<SerializableResult> {
  const requestedMode = stringValue(input.mode) ?? "status";
  if (!["plan", "auto", "review", "status"].includes(requestedMode)) {
    return failure("MODE_INVALID", "mode must be one of plan, auto, review, or status.");
  }
  const state = modeStateFor(requestedMode);
  await appendSessionEvent(deps, context, "mode.plan-auto-review.changed", {
    requestedMode,
    state,
    reason: stringValue(input.reason) ?? "capability-requested"
  });
  return success({
    status: requestedMode === "status" ? "reported" : "changed",
    mode: state.mode,
    evidence: {
      familyId: "mode.plan-auto-review",
      requestedMode,
      state,
      replay: replay(context),
      redaction: { class: "internal" }
    }
  });
}

async function executeUserInput(
  input: JsonObject,
  context: CapabilityExecutionContext,
  deps: RuntimeFamilyCapabilityDependencies
): Promise<SerializableResult> {
  const prompt = stringValue(input.prompt);
  if (!prompt) return failure("USER_INPUT_PROMPT_REQUIRED", "prompt is required.");
  const choices = stringArray(input.choices).slice(0, 20);
  const request: RuntimeUserInputRequest = {
    prompt: boundText(prompt, 2_000).text,
    inputType: input.inputType === "confirm" || input.inputType === "choice" ? input.inputType : "text",
    choices,
    required: input.required !== false,
    trace: context.trace,
    ...(context.envelope.sessionId ? { sessionId: context.envelope.sessionId } : {})
  };
  const decision = await deps.userInput?.requestInput?.(request);
  if (!decision) {
    return failure("USER_INPUT_HEADLESS_UNAVAILABLE", "Interactive user input is unavailable in headless runtime.", {
      status: "cancelled",
      source: "headless-default",
      evidence: {
        familyId: "user.input",
        promptBytes: request.prompt.length,
        replay: replay(context),
        redaction: { class: "internal", fields: ["prompt"] }
      }
    });
  }
  if (decision.status !== "answered") {
    return failure(`USER_INPUT_${decision.status.toUpperCase()}`, decision.reason ?? `User input ${decision.status}.`, {
      status: decision.status,
      decision
    });
  }
  return success({
    status: "answered",
    value: typeof decision.value === "string" ? boundText(decision.value, 8_000).text : decision.value,
    evidence: {
      familyId: "user.input",
      source: decision.source,
      inputType: request.inputType,
      choiceCount: choices.length,
      replay: replay(context),
      redaction: { class: "internal", fields: ["value"] }
    }
  });
}

async function executeApprovalPermission(
  input: JsonObject,
  context: CapabilityExecutionContext,
  deps: RuntimeFamilyCapabilityDependencies
): Promise<SerializableResult> {
  const prompt = stringValue(input.prompt);
  const action = stringValue(input.action);
  const resource = stringValue(input.resource);
  if (!prompt || !action || !resource) {
    return failure("APPROVAL_PERMISSION_INPUT_REQUIRED", "prompt, action, and resource are required.");
  }
  const allowedDecisions = decisionOptions(input.allowedDecisions);
  const request = approvalRequestFromInput(input, context, prompt, action, resource, allowedDecisions);
  const decision = await deps.approvals.requestApproval(request);
  await appendSessionEvent(deps, context, `approval.permission.${decision.decision}`, {
    approvalId: decision.approvalId,
    decision,
    request: request.summary
  });
  const value = {
    status: decision.decision,
    decision,
    evidence: {
      familyId: "approval.permission",
      approvalId: decision.approvalId,
      approved: decision.approved,
      source: decision.source,
      auditReference: decision.auditReference,
      replay: replay(context),
      redaction: { class: "internal", fields: ["decision.reason"] }
    }
  };
  return decision.decision === "allow" ? success(value) : { ok: false, value, error: diag(`APPROVAL_${decision.decision.toUpperCase()}`, decision.reason) };
}

async function executeAgentWaitResult(
  input: JsonObject,
  context: CapabilityExecutionContext,
  deps: RuntimeFamilyCapabilityDependencies
): Promise<SerializableResult> {
  const workerInstanceId = stringValue(input.workerInstanceId);
  const timeoutMs = boundedPositiveInteger(input.timeoutMs, 0, 1_000);
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (context.signal.aborted) return failure("AGENT_WAIT_CANCELLED", context.cancellationReason ?? "Agent wait cancelled.");
    const found = await findWorkerResult(input, deps, workerInstanceId);
    if (found) {
      return success({
        status: found.status,
        workerResult: found.result,
        evidence: {
          familyId: "agent.wait-result",
          workerInstanceId: found.workerInstanceId,
          workerSessionId: found.workerSessionId,
          eventSequence: found.event.sequence,
          replay: replay(context),
          redaction: { class: "internal", fields: ["workerResult.summary"] }
        }
      });
    }
    if (timeoutMs === 0) break;
    await delay(Math.min(25, timeoutMs));
  }
  return failure("AGENT_WAIT_TIMEOUT", "Worker result was not available before timeout.", {
    status: "timed-out",
    evidence: {
      familyId: "agent.wait-result",
      ...(workerInstanceId ? { workerInstanceId } : {}),
      timeoutMs,
      replay: replay(context),
      redaction: { class: "internal" }
    }
  });
}

async function findWorkerResult(
  input: JsonObject,
  deps: RuntimeFamilyCapabilityDependencies,
  workerInstanceId: string | undefined
): Promise<{ readonly event: SessionEvent; readonly result: JsonObject; readonly status: string; readonly workerInstanceId?: string; readonly workerSessionId?: string } | undefined> {
  const explicitSessions = [stringValue(input.parentSessionId), stringValue(input.workerSessionId)].filter((value): value is string => Boolean(value));
  const instance = workerInstanceId ? await deps.agents.getInstance(asId<"agentInstance">(workerInstanceId)) : undefined;
  const sessionIds = [...new Set([
    ...explicitSessions,
    instance?.parentSessionId ? String(instance.parentSessionId) : undefined,
    instance?.sessionId ? String(instance.sessionId) : undefined
  ].filter((value): value is string => Boolean(value)))];
  for (const sessionId of sessionIds) {
    const events = await deps.sessions.events(asId<"session">(sessionId));
    const resultEvent = [...events].reverse().find((event) => {
      if (event.kind !== "agent.worker.result") return false;
      const payload = event.payload as JsonObject;
      return !workerInstanceId || payload.workerInstanceId === workerInstanceId;
    });
    if (resultEvent) {
      const result = resultEvent.payload as JsonObject;
      const found = {
        event: resultEvent,
        result,
        status: stringValue(result.status) ?? "completed"
      };
      const foundWorkerInstanceId = stringValue(result.workerInstanceId);
      const foundWorkerSessionId = stringValue(result.workerSessionId);
      return {
        ...found,
        ...(foundWorkerInstanceId ? { workerInstanceId: foundWorkerInstanceId } : {}),
        ...(foundWorkerSessionId ? { workerSessionId: foundWorkerSessionId } : {})
      };
    }
  }
  if (instance && ["completed", "failed", "stopped"].includes(instance.lifecycleState)) {
    return {
      event: {
        sessionId: instance.sessionId,
        sequence: 0,
        kind: "agent.worker.result",
        at: RUNTIME_CREATED_AT,
        payload: {
          workerInstanceId: instance.id,
          workerSessionId: instance.sessionId,
          status: instance.lifecycleState,
          summary: `Worker ${instance.lifecycleState}.`,
          redaction: { class: "internal" }
        },
        redaction: { class: "internal" }
      },
      result: {
        workerInstanceId: instance.id,
        workerSessionId: instance.sessionId,
        status: instance.lifecycleState,
        summary: `Worker ${instance.lifecycleState}.`,
        redaction: { class: "internal" }
      },
      status: instance.lifecycleState,
      workerInstanceId: String(instance.id),
      workerSessionId: String(instance.sessionId)
    };
  }
  return undefined;
}

function approvalRequestFromInput(
  input: JsonObject,
  context: CapabilityExecutionContext,
  prompt: string,
  action: string,
  resource: string,
  allowedDecisions: readonly ApprovalDecisionKind[]
): ApprovalRequest {
  const approvalId = `approval-runtime-${hash(`${context.envelope.invocationId}:${action}:${resource}`)}` as ApprovalId;
  const auditReference: ApprovalAuditReference = {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    traceId: context.trace.traceId,
    correlationId: context.trace.correlationId,
    policyDecision: "capability-requested",
    reasonCodes: ["runtime.approval.permission"],
    redaction: { class: "internal" as const, fields: ["reasonCodes"] }
  };
  const targetKind = stringValue(input.targetKind) ?? "capability";
  const riskKind = stringValue(input.riskKind) ?? "capability";
  return {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    approvalId,
    subject: context.envelope.caller,
    action,
    resource,
    metadata: redactJsonSecrets((input.metadata as JsonObject | undefined) ?? {}) as JsonObject,
    prompt: boundText(prompt, 2_000).text,
    decisionOptions: allowedDecisions,
    summary: {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      title: "Approval requested",
      subject: context.envelope.caller,
      action,
      resource,
      capability: String(context.envelope.capabilityId),
      targetKind: targetKind as ApprovalRequest["summary"]["targetKind"],
      targetLabel: resource,
      riskSummaries: [{
        schemaVersion: APPROVAL_SCHEMA_VERSION,
        kind: riskKind as ApprovalRequest["summary"]["riskSummaries"][number]["kind"],
        severity: severity(input.severity),
        title: "Runtime approval request",
        detail: boundText(prompt, 2_000).text,
        reasonCodes: ["runtime.approval.permission"],
        referencePitFixtureIds: ["pit.headless-trust.fail-closed"],
        redaction: { class: "internal", fields: ["detail"] },
        metadata: {}
      }],
      allowedDecisions,
      referencePitFixtureIds: ["pit.headless-trust.fail-closed"],
      redaction: { class: "internal", fields: ["targetLabel", "riskSummaries.detail"] },
      metadata: {}
    },
    auditReference,
    trace: context.trace,
    ...(context.envelope.sessionId ? { sessionId: context.envelope.sessionId } : {}),
    compatibility: { schemaVersion: APPROVAL_SCHEMA_VERSION, minReaderVersion: "1.0.0" }
  };
}

async function appendSessionEvent(
  deps: RuntimeFamilyCapabilityDependencies,
  context: CapabilityExecutionContext,
  kind: string,
  payload: JsonObject
): Promise<void> {
  if (!context.envelope.sessionId) return;
  const events = await deps.sessions.events(context.envelope.sessionId);
  await deps.sessions.append({
    sessionId: context.envelope.sessionId,
    sequence: events.length + 1,
    kind,
    at: RUNTIME_CREATED_AT,
    payload: redactJsonSecrets(payload) as JsonObject,
    redaction: { class: "internal" }
  });
}

function modeStateFor(requestedMode: string): JsonObject {
  switch (requestedMode) {
    case "plan":
      return { mode: "plan", agentMode: "planner", toolProjection: "read-only", reviewRequired: false };
    case "auto":
      return { mode: "auto", agentMode: "implementer", toolProjection: "safe-all", reviewRequired: false };
    case "review":
      return { mode: "review", agentMode: "verifier", toolProjection: "read-only", reviewRequired: true };
    case "status":
    default:
      return { mode: "status", agentMode: "default", toolProjection: "read-only", reviewRequired: false };
  }
}

function decisionOptions(value: unknown): readonly ApprovalDecisionKind[] {
  const values = stringArray(value).filter((item): item is ApprovalDecisionKind => item === "allow" || item === "deny" || item === "cancel");
  return values.length > 0 ? values : ["allow", "deny", "cancel"];
}

function severity(value: unknown): ApprovalRequest["summary"]["riskSummaries"][number]["severity"] {
  return value === "info" || value === "low" || value === "medium" || value === "high" || value === "critical" ? value : "medium";
}

function objectSchema(required: readonly string[], properties: JsonObject): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties
  };
}

function success(value: JsonObject): SerializableResult {
  return { ok: true, value: redactJsonSecrets(value) as JsonObject };
}

function failure(code: string, message: string, value?: JsonObject): SerializableResult {
  return {
    ok: false,
    ...(value ? { value: redactJsonSecrets(value) as JsonObject } : {}),
    error: diag(code, message)
  };
}

function diag(code: string, message: string): RedactedError {
  return {
    code,
    message,
    retryable: false,
    redaction: { class: "internal" }
  };
}

function replay(context: CapabilityExecutionContext): JsonObject {
  return {
    envelopeId: context.envelope.invocationId,
    traceId: context.trace.traceId,
    snapshot: "runtime-family-capability"
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function boundedPositiveInteger(value: unknown, fallback: number, max: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(0, Math.min(max, numeric));
}

function boundText(text: string, limitBytes: number): { readonly text: string; readonly byteLength: number; readonly truncated: boolean } {
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength <= limitBytes) return { text, byteLength, truncated: false };
  let bytes = 0;
  const chunks: string[] = [];
  for (const character of text) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > limitBytes) break;
    chunks.push(character);
    bytes += nextBytes;
  }
  return { text: chunks.join(""), byteLength, truncated: true };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
