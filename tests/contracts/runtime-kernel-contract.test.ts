import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_SCHEMA_VERSION, asId } from "@deepseek/platform-contracts";
import type { ApprovalBroker, ApprovalId, ApprovalRequest, CapabilityManifest, JsonObject, PolicyDecision, PolicyEngine, PolicyRequest, SessionEvent } from "@deepseek/platform-contracts";
import {
  buildExecutionEnvelope,
  collectRuntimeEvents,
  createDefaultRuntimeKernel,
  createRuntimeKernel,
  runtimeEchoCapability,
  validateExecutionEnvelope
} from "@deepseek/runtime";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("runtime kernel contracts", () => {
  it("constructs the kernel and validates execution envelopes", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.capabilities.register(runtimeEchoCapability, async (_input, context) => ({
      ok: true,
      value: { envelopeId: context.envelope.invocationId }
    }));
    const envelope = buildExecutionEnvelope({
      request: {
        capabilityId: runtimeEchoCapability.id,
        caller: "contract-test",
        input: {}
      },
      manifest: runtimeEchoCapability,
      sessionId: asId<"session">("session-contract"),
      workflowId: "workflow-contract",
      taskId: "task-contract",
      invocationId: "invocation-contract",
      trace: {
        traceId: asId<"trace">("trace-contract"),
        spanId: asId<"span">("span-contract"),
        correlationId: asId<"correlation">("corr-contract"),
        sessionId: asId<"session">("session-contract")
      },
      createdAt: new Date(0).toISOString()
    });

    assert.deepEqual(validateExecutionEnvelope(envelope), []);
    assert.equal(validateExecutionEnvelope({}).some((error) => error.code === "KERNEL_ENVELOPE_INVALID"), true);
    assert.equal((await deps.capabilities.listHostVisible()).some((manifest) => manifest.id === runtimeEchoCapability.id), true);
    assert.equal((await deps.capabilities.resolveExecutable(runtimeEchoCapability.id))?.manifest.id, runtimeEchoCapability.id);
  });

  it("returns typed rejection events for unknown capabilities", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: asId<"capability">("runtime.missing"),
      caller: "contract-test",
      input: {}
    }));

    const rejected = events.find((event) => event.kind === "execution.rejected");
    assert.equal(rejected?.error?.code, "KERNEL_CAPABILITY_NOT_FOUND");
    await kernel.shutdown();
  });

  it("rejects invalid timeout and malformed trace before policy or scheduler submission", async () => {
    const deps = createDeterministicRuntimeDependencies();
    let policyCalls = 0;
    let schedulerCalls = 0;
    deps.policy.decide = async () => {
      policyCalls += 1;
      return { action: "allow", reason: "should not be called" };
    };
    deps.concurrency.run = async () => {
      schedulerCalls += 1;
      throw new Error("should not be scheduled");
    };
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeEchoCapability.id,
      caller: "contract-test",
      input: {},
      timeoutMs: 0,
      trace: {
        traceId: asId<"trace">("trace-bad"),
        spanId: asId<"span">("span-bad"),
        correlationId: asId<"correlation">("corr-bad")
      }
    }));

    assert.equal(policyCalls, 0);
    assert.equal(schedulerCalls, 0);
    assert.equal(events.some((event) => event.kind === "execution.rejected" && event.error?.code === "KERNEL_INVALID_TIMEOUT"), true);
    await kernel.shutdown();
  });

  it("validates governance metadata shape directly", () => {
    const envelope = buildExecutionEnvelope({
      request: {
        capabilityId: runtimeEchoCapability.id,
        caller: "contract-test",
        input: {},
        timeoutMs: 30_000
      },
      manifest: runtimeEchoCapability,
      sessionId: asId<"session">("session-contract"),
      workflowId: "workflow-contract",
      taskId: "task-contract",
      invocationId: "invocation-contract",
      trace: {
        traceId: asId<"trace">("trace-contract"),
        spanId: asId<"span">("span-contract"),
        correlationId: asId<"correlation">("corr-contract"),
        sessionId: asId<"session">("session-contract")
      },
      createdAt: new Date(0).toISOString()
    });
    const missingGovernance = clone(envelope) as Record<string, unknown>;
    delete missingGovernance.cancellation;
    delete missingGovernance.replayPolicy;
    delete missingGovernance.idempotency;
    assert.equal(validateExecutionEnvelope(missingGovernance).some((error) => error.code === "KERNEL_ENVELOPE_INVALID"), true);

    const malformedTrace = clone(envelope) as Record<string, unknown>;
    malformedTrace.trace = { traceId: "trace-only" };
    assert.equal(validateExecutionEnvelope(malformedTrace).some((error) => error.code === "KERNEL_MALFORMED_TRACE"), true);
  });

  it("prevents denied policy invocations from reaching the scheduler", async () => {
    const deps = createDeterministicRuntimeDependencies();
    let schedulerCalls = 0;
    deps.concurrency.run = async () => {
      schedulerCalls += 1;
      throw new Error("should not run");
    };
    const manifest: CapabilityManifest = {
      ...runtimeEchoCapability,
      id: asId<"capability">("runtime.write"),
      sideEffect: "write"
    };
    await deps.capabilities.register(manifest, async (_input, context) => ({
      ok: true,
      value: { envelopeId: context.envelope.invocationId }
    }));
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: manifest.id,
      caller: "contract-test",
      input: {},
      timeoutMs: 30_000
    }));

    assert.equal(schedulerCalls, 0);
    assert.equal(events.some((event) => event.kind === "execution.rejected" && event.error?.code === "KERNEL_POLICY_DENIED"), true);
    assert.equal(events.some((event) => event.kind === "policy.decided" && typeof event.data.record === "object"), true);
    assert.equal(events.some((event) => event.kind === "scheduler.queued"), false);
    await kernel.shutdown();
  });

  it("propagates request metadata into capability execution context", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.capabilities.register(runtimeEchoCapability, async (_input, context) => ({
      ok: true,
      value: {
        activeModel: context.metadata.activeModel,
        activeModelProvider: context.metadata.activeModelProvider,
        capabilityId: context.metadata.capabilityId
      }
    }));
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeEchoCapability.id,
      caller: "contract-test",
      input: {},
      timeoutMs: 30_000,
      metadata: {
        activeModel: "glm-5.2",
        activeModelProvider: "glm"
      }
    } as Parameters<typeof kernel.execute>[0]));

    const output = events.find((event) => event.kind === "capability.output")?.data.output as JsonObject | undefined;
    assert.equal(output?.activeModel, "glm-5.2");
    assert.equal(output?.activeModelProvider, "glm");
    assert.equal(output?.capabilityId, runtimeEchoCapability.id);
    await kernel.shutdown();
  });

  it("fails closed when policy decision evaluation throws", async () => {
    const deps = createDeterministicRuntimeDependencies();
    let schedulerCalls = 0;
    deps.policy.decide = async () => {
      throw new Error("policy unavailable");
    };
    deps.concurrency.run = async () => {
      schedulerCalls += 1;
      throw new Error("should not run without policy");
    };
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeEchoCapability.id,
      caller: "contract-test",
      input: {},
      timeoutMs: 30_000
    }));

    assert.equal(schedulerCalls, 0);
    assert.equal(events.some((event) => event.kind === "execution.rejected" && event.error?.code === "KERNEL_POLICY_DECISION_MISSING"), true);
    assert.equal(events.some((event) => event.kind === "scheduler.queued"), false);
    await kernel.shutdown();
  });

  it("routes approval-required work through broker before scheduler submission", async () => {
    const deps = {
      ...createDeterministicRuntimeDependencies(),
      policy: new AskApprovalPolicyEngine()
    };
    let schedulerCalls = 0;
    deps.concurrency.run = async () => {
      schedulerCalls += 1;
      throw new Error("should not run before approval");
    };
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeEchoCapability.id,
      caller: "contract-test",
      input: {},
      timeoutMs: 30_000
    }));

    assert.equal(schedulerCalls, 0);
    assert.equal(events.some((event) => event.kind === "approval.required"), true);
    assert.equal(events.some((event) => event.kind === "approval.denied"), true);
    assert.equal(events.some((event) => event.kind === "approval.audit-linked"), true);
    assert.equal(events.some((event) => event.kind === "execution.rejected" && event.error?.details?.reasonCode === "headless.fail_closed"), true);
    assert.equal(events.some((event) => event.kind === "scheduler.queued"), false);
    const denied = events.find((event) => event.kind === "approval.denied");
    assert.equal(JSON.stringify(denied).includes("pit.headless-trust.fail-closed"), true);
    await kernel.shutdown();
  });

  it("continues approval-required work only after an injected broker allow decision", async () => {
    const approvals: ApprovalBroker = {
      async requestApproval(request: ApprovalRequest) {
        return {
          schemaVersion: APPROVAL_SCHEMA_VERSION,
          approvalId: request.approvalId,
          approved: true,
          decision: "allow",
          source: "test",
          reason: "approved by contract test",
          reasonCode: "test.approved",
          auditReference: request.auditReference,
          trace: request.trace,
          redaction: { class: "internal", fields: ["reason"] },
          metadata: { referencePitFixtureIds: [] }
        };
      }
    };
    const deps = {
      ...createDeterministicRuntimeDependencies(),
      policy: new AskApprovalPolicyEngine(),
      approvals
    };
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeEchoCapability.id,
      caller: "contract-test",
      input: { text: "approved" },
      timeoutMs: 30_000
    }));

    assert.equal(events.some((event) => event.kind === "approval.required"), true);
    assert.equal(events.some((event) => event.kind === "approval.decided"), true);
    assert.equal(events.some((event) => event.kind === "scheduler.queued"), true);
    assert.equal(events.some((event) => event.kind === "capability.completed"), true);
    await kernel.shutdown();
  });

  it("fails closed when replayable session or bus event persistence fails", async () => {
    const deps = createDeterministicRuntimeDependencies();
    deps.sessions.append = async (_event: SessionEvent) => {
      throw new Error("session append failed");
    };
    const kernel = await createDefaultRuntimeKernel(deps);
    await assert.rejects(
      () => collectRuntimeEvents(kernel.execute({
        capabilityId: runtimeEchoCapability.id,
        caller: "contract-test",
        input: {}
      })),
      /session append failed/
    );

    const busDeps = createDeterministicRuntimeDependencies();
    busDeps.bus.publish = async () => {
      throw new Error("bus publish failed");
    };
    const busKernel = await createDefaultRuntimeKernel(busDeps);
    await assert.rejects(
      () => collectRuntimeEvents(busKernel.execute({
        capabilityId: runtimeEchoCapability.id,
        caller: "contract-test",
        input: {}
      })),
      /bus publish failed/
    );
  });

  it("records explicit degraded observability events without failing successful execution", async () => {
    const deps = createDeterministicRuntimeDependencies();
    deps.observability.emit = async () => {
      throw new Error("observability down");
    };
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(kernel.execute({
      capabilityId: runtimeEchoCapability.id,
      caller: "contract-test",
      input: { text: "observability" }
    }));
    const sessionId = events[0]?.sessionId;
    assert.ok(sessionId);
    assert.equal(events.some((event) => event.kind === "capability.completed"), true);
    assert.equal((await deps.sessions.events(sessionId)).some((event) => event.kind === "kernel.observability.degraded"), true);
    assert.equal(deps.bus.getReplayRecords(sessionId).some((record) => record.payload.kind === "kernel.observability.degraded"), true);
    await kernel.shutdown();
  });
});

class AskApprovalPolicyEngine implements PolicyEngine {
  async decide(request: PolicyRequest): Promise<PolicyDecision> {
    const trace = request.auditEvidence?.trace ?? {
      traceId: asId<"trace">("trace-approval-kernel-contract"),
      spanId: asId<"span">("span-approval-kernel-contract"),
      correlationId: asId<"correlation">("corr-approval-kernel-contract")
    };
    const approval: ApprovalRequest = {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      approvalId: "approval:kernel-contract" as ApprovalId,
      subject: request.subject,
      action: request.action,
      resource: request.resource,
      metadata: request.metadata,
      prompt: "Approve runtime echo?",
      decisionOptions: ["allow", "deny", "cancel"],
      summary: {
        schemaVersion: APPROVAL_SCHEMA_VERSION,
        title: "Approval required",
        subject: request.subject,
        action: request.action,
        resource: request.resource,
        capability: request.resource,
        targetKind: "capability",
        targetLabel: request.resource,
        riskSummaries: [{
          schemaVersion: APPROVAL_SCHEMA_VERSION,
          kind: "policy",
          severity: "medium",
          title: "Approval required",
          detail: "Contract test requires approval before scheduling.",
          reasonCodes: ["policy.approval.required"],
          referencePitFixtureIds: ["pit.headless-trust.fail-closed"],
          redaction: { class: "internal", fields: ["detail"] },
          metadata: {}
        }],
        allowedDecisions: ["allow", "deny", "cancel"],
        referencePitFixtureIds: ["pit.headless-trust.fail-closed"],
        redaction: { class: "internal", fields: ["targetLabel"] },
        metadata: {}
      },
      auditReference: {
        schemaVersion: APPROVAL_SCHEMA_VERSION,
        traceId: trace.traceId,
        correlationId: trace.correlationId,
        policyDecision: "ask",
        reasonCodes: ["policy.approval.required"],
        redaction: { class: "internal", fields: ["reasonCodes"] }
      },
      trace,
      compatibility: { schemaVersion: APPROVAL_SCHEMA_VERSION }
    };
    return {
      action: "ask",
      reason: "Approval required by contract test policy",
      audit: { policy: "ask-test" },
      sandboxProfile: "development",
      approvalRequest: approval,
      approvalSummary: approval.summary,
      approval: {
        schemaVersion: APPROVAL_SCHEMA_VERSION,
        kind: "approval.required",
        approvalId: approval.approvalId,
        trace,
        summary: approval.summary,
        auditReference: approval.auditReference,
        redaction: { class: "internal" },
        compatibility: { schemaVersion: APPROVAL_SCHEMA_VERSION }
      }
    };
  }
}
