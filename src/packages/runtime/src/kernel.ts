import type {
  ApprovalDecision,
  ApprovalLifecycleRecord,
  ApprovalRequest,
  AgentId,
  BusEnvelope,
  ExecutionEnvelope,
  JsonObject,
  KernelError,
  PolicyDecision,
  RuntimeDependencies,
  RuntimeEvent,
  RuntimeKernel,
  RuntimeKernelDependencies,
  RuntimeKernelRequest,
  RuntimeKernelState,
  SessionId,
  TaskEvent,
  TaskId,
  TraceContext
} from "@deepseek/platform-contracts";
import { APPROVAL_SCHEMA_VERSION, asId } from "@deepseek/platform-contracts";
import type { PlatformExecutionContext } from "@deepseek/platform-contracts";
import {
  analyzeResourceScope,
  createSandboxRequirement,
  createPolicyDecisionRecord,
  redactJsonSecrets
} from "@deepseek/policy-sandbox";
import { DeterministicClock, DeterministicIdFactory, NoopRuntimeKernelLogger } from "./deterministic.js";
import { kernelError } from "./errors.js";
import {
  buildExecutionEnvelope,
  policyMetadataFor,
  validateExecutionEnvelope
} from "./envelope.js";
import { registerRuntimeBuiltins } from "./echo-capability.js";

export class InProcessRuntimeKernel implements RuntimeKernel {
  private lifecycle: RuntimeKernelState = "created";
  private readonly activeTasks = new Map<string, string>();
  private readonly cancelled = new Map<string, string>();

  constructor(private readonly deps: RuntimeKernelDependencies) {
    const missing = [
      "bus",
      "workflow",
      "scheduler",
      "capabilities",
      "policy",
      "approvals",
      "sandbox",
      "sessions",
      "observability",
      "platform",
      "clock",
      "ids",
      "logger"
    ].filter((key) => (deps as unknown as Record<string, unknown>)[key] === undefined);
    if (missing.length > 0) {
      throw new Error(kernelError("KERNEL_CONFIGURATION_ERROR", `Missing runtime kernel dependencies: ${missing.join(", ")}`).message);
    }
  }

  async start(): Promise<void> {
    if (this.lifecycle === "shutdown") {
      throw new Error("KERNEL_SHUTDOWN");
    }
    if (this.lifecycle === "running") return;
    this.lifecycle = "running";
    await this.publishLifecycle("started");
  }

  async *execute(request: RuntimeKernelRequest): AsyncIterable<RuntimeEvent> {
    if (this.lifecycle === "created") await this.start();
    if (this.lifecycle !== "running") {
      yield this.rejectedEvent(request, kernelError("KERNEL_NOT_RUNNING", `Runtime kernel is ${this.lifecycle}`));
      return;
    }

    const sessionId = request.sessionId ?? (await this.deps.sessions.create({ caller: request.caller }));
    const trace = request.trace ?? this.trace(sessionId, "kernel");
    const accepted = this.event("kernel.request.accepted", sessionId, trace, {
      capabilityId: request.capabilityId,
      caller: request.caller
    }, request.agentId);
    await this.recordEvent(accepted);
    yield accepted;

    const invocationId = String(this.deps.ids.create("invocation"));
    const binding = await this.deps.capabilities.resolveExecutable(request.capabilityId);
    if (!binding) {
      const rejected = this.event(
        "execution.rejected",
        sessionId,
        trace,
        { capabilityId: request.capabilityId, envelopeId: invocationId, reason: "capability-not-found" },
        request.agentId,
        undefined,
        kernelError("KERNEL_CAPABILITY_NOT_FOUND", `Capability not found: ${String(request.capabilityId)}`)
      );
      await this.recordEvent(rejected);
      yield rejected;
      return;
    }
    const workflow = await this.deps.workflow.openInvocation({
      sessionId,
      capabilityId: binding.manifest.id,
      envelopeId: invocationId,
      ...(request.agentId ? { ownerAgentId: request.agentId } : {}),
      completionCriteria: { terminalEvents: ["capability.completed", "capability.failed", "capability.cancelled"] }
    });
    const workflowOpened = this.event("workflow.opened", sessionId, trace, {
      workflowId: workflow.workflowId,
      taskId: workflow.taskId,
      stepId: workflow.stepId,
      capabilityId: workflow.capabilityId,
      envelopeId: workflow.envelopeId
    }, request.agentId, workflow.taskId);
    await this.recordEvent(workflowOpened);
    yield workflowOpened;

    const effectiveTimeoutMs = request.timeoutMs ?? binding.manifest.timeoutMs ?? 30_000;
    const envelope = buildExecutionEnvelope({
      request: { ...request, timeoutMs: effectiveTimeoutMs },
      manifest: binding.manifest,
      sessionId,
      workflowId: String(workflow.workflowId),
      taskId: String(workflow.taskId),
      invocationId,
      trace,
      createdAt: this.deps.clock.now().toISOString(),
      platformContext: await this.platformExecutionContext(binding.manifest.sideEffect, effectiveTimeoutMs, request.input)
    });
    const validationErrors = validateExecutionEnvelope(envelope);
    const envelopeEvent = this.event("execution.envelope.created", sessionId, trace, { envelope }, request.agentId, workflow.taskId);
    await this.recordEvent(envelopeEvent);
    yield envelopeEvent;
    if (validationErrors.length > 0) {
      const rejected = this.event("execution.rejected", sessionId, trace, { envelopeId: invocationId, errors: validationErrors }, request.agentId, workflow.taskId, validationErrors[0]);
      await this.recordEvent(rejected);
      yield rejected;
      yield await this.closeWorkflow(workflow, "rejected", { envelopeId: invocationId });
      return;
    }

    const platform = envelope.policyContext.platform as PlatformExecutionContext | undefined;
    const policyRequest = {
      subject: request.caller,
      action: `execute:${String(binding.manifest.id)}`,
      resource: String(binding.manifest.id),
      metadata: policyMetadataFor(envelope, request.input),
      ...(platform ? { platform } : {}),
      secret: envelope.secretExposure,
      resourceScope: envelope.resourceScope,
      sandbox: envelope.sandboxRequirements,
      auditEvidence: envelope.audit
    };
    let policyDecision: PolicyDecision;
    try {
      const decision = await this.deps.policy.decide(policyRequest);
      policyDecision = decision.record ? decision : { ...decision, record: createPolicyDecisionRecord(policyRequest, decision) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Policy evaluation failed.";
      const rejected = this.event("execution.rejected", sessionId, trace, { envelopeId: invocationId, policy: { action: "deny", reason: "Policy decision is missing because policy evaluation failed.", error: message } }, request.agentId, workflow.taskId, kernelError("KERNEL_POLICY_DECISION_MISSING", "Policy decision is required before execution."));
      await this.recordEvent(rejected);
      yield rejected;
      yield await this.closeWorkflow(workflow, "rejected", { envelopeId: invocationId, policy: "missing" });
      return;
    }
    for (const event of await this.policyEvents(policyDecision, sessionId, trace, envelope, request.agentId, workflow.taskId)) {
      await this.recordEvent(event);
      yield event;
    }
    if (policyDecision.action === "ask") {
      const approvalRequest = policyDecision.approvalRequest ?? this.fallbackApprovalRequest(policyDecision, request, sessionId, trace, envelope);
      const required = this.approvalLifecycleEvent(policyDecision.approval ?? this.requiredApprovalRecord(approvalRequest), sessionId, trace, request.agentId, workflow.taskId, envelope.invocationId);
      await this.recordEvent(required);
      yield required;

      const approvalDecision = await this.deps.approvals.requestApproval(approvalRequest);
      const decisionRecord = this.decisionApprovalRecord(approvalRequest, approvalDecision);
      const decided = this.approvalLifecycleEvent(decisionRecord, sessionId, approvalDecision.trace ?? trace, request.agentId, workflow.taskId, envelope.invocationId);
      await this.recordEvent(decided);
      yield decided;
      const auditLinked = this.approvalLifecycleEvent({ ...decisionRecord, kind: "approval.audit-linked" }, sessionId, approvalDecision.trace ?? trace, request.agentId, workflow.taskId, envelope.invocationId);
      await this.recordEvent(auditLinked);
      yield auditLinked;

      if (!approvalDecision.approved || approvalDecision.decision !== "allow") {
        const rejected = this.event(
          "execution.rejected",
          sessionId,
          approvalDecision.trace ?? trace,
          {
            envelopeId: invocationId,
            policy: {
              action: policyDecision.action,
              reason: policyDecision.reason,
              audit: policyDecision.audit ?? {},
              sandboxProfile: policyDecision.sandboxProfile ?? "",
              approval: approvalDecision
            }
          },
          request.agentId,
          workflow.taskId,
          kernelError("KERNEL_POLICY_DENIED", approvalDecision.reason, {
            reasonCode: approvalDecision.reasonCode,
            approvalId: approvalDecision.approvalId,
            decision: approvalDecision.decision
          })
        );
        await this.recordEvent(rejected);
        yield rejected;
        yield await this.closeWorkflow(workflow, "rejected", { envelopeId: invocationId, policy: policyDecision.action, approvalId: approvalDecision.approvalId });
        return;
      }
    }
    if (policyDecision.action !== "allow" && policyDecision.action !== "ask") {
      const rejected = this.event(
        "execution.rejected",
        sessionId,
        trace,
        {
          envelopeId: invocationId,
          policy: {
            action: policyDecision.action,
            reason: policyDecision.reason,
            audit: policyDecision.audit ?? {},
            sandboxProfile: policyDecision.sandboxProfile ?? ""
          }
        },
        request.agentId,
        workflow.taskId,
        kernelError("KERNEL_POLICY_DENIED", policyDecision.reason)
      );
      await this.recordEvent(rejected);
      yield rejected;
      yield await this.closeWorkflow(workflow, "rejected", { envelopeId: invocationId, policy: policyDecision.action });
      return;
    }

    this.activeTasks.set(invocationId, String(workflow.taskId));
    const schedulerEvents: RuntimeEvent[] = [];
    const unsubscribeScheduler = this.deps.scheduler.subscribe((event) => {
      if (event.taskId !== workflow.taskId) return;
      schedulerEvents.push(this.schedulerEventToRuntimeEvent(event, sessionId, trace, invocationId, request.agentId, workflow.taskId));
    });
    let drainedSchedulerEvents = 0;
    const drainSchedulerEvents = async function* (kernel: InProcessRuntimeKernel): AsyncIterable<RuntimeEvent> {
      while (drainedSchedulerEvents < schedulerEvents.length) {
        const event = schedulerEvents[drainedSchedulerEvents++];
        if (!event) continue;
        await kernel.recordEvent(event);
        yield event;
      }
    };
    try {
      const started = this.event("capability.started", sessionId, trace, { envelopeId: invocationId, capabilityId: binding.manifest.id }, request.agentId, workflow.taskId);
      await this.recordEvent(started);
      yield started;

      const scheduled = this.deps.scheduler.run(
        {
          id: workflow.taskId,
          name: String(binding.manifest.id),
          deadlineMs: envelope.timeoutMs,
          trace,
          metadata: { envelopeId: invocationId, capabilityId: binding.manifest.id }
        },
        (taskContext) => binding.execute(request.input, {
          envelope,
          trace,
          signal: taskContext.signal,
          ...(taskContext.cancellationReason ? { cancellationReason: taskContext.cancellationReason } : {}),
          metadata: {
            taskId: workflow.taskId,
            workflowId: workflow.workflowId,
            capabilityId: binding.manifest.id
          }
        })
      );
      await Promise.resolve();
      for await (const event of drainSchedulerEvents(this)) yield event;
      const result = await scheduled;
      for await (const event of drainSchedulerEvents(this)) yield event;

      if (result.ok) {
        const output = this.event("capability.output", sessionId, trace, { envelopeId: invocationId, output: result.value ?? {} }, request.agentId, workflow.taskId);
        const completed = this.event("capability.completed", sessionId, trace, {
          envelopeId: invocationId,
          capabilityId: binding.manifest.id,
          output: result.value ?? {},
          replay: {
            traceId: trace.traceId,
            snapshot: "normalized"
          }
        }, request.agentId, workflow.taskId);
        await this.recordEvent(output);
        yield output;
        await this.recordEvent(completed);
        yield completed;
        yield await this.closeWorkflow(workflow, "completed", { envelopeId: invocationId });
      } else {
        const failed = this.event("capability.failed", sessionId, trace, { envelopeId: invocationId, capabilityId: binding.manifest.id }, request.agentId, workflow.taskId, this.toKernelError(result.error));
        await this.recordEvent(failed);
        yield failed;
        yield await this.closeWorkflow(workflow, "failed", { envelopeId: invocationId });
      }
    } catch (error) {
      for await (const event of drainSchedulerEvents(this)) yield event;
      const reason = this.cancelled.get(invocationId);
      const message = error instanceof Error ? error.message : "Unknown executor failure";
      const schedulerTimeout = error instanceof Error && error.name === "SCHEDULER_TASK_TIMEOUT";
      const schedulerCancelled = error instanceof Error && error.name === "SCHEDULER_TASK_CANCELLED";
      const schedulerBackpressure = error instanceof Error && error.name === "SCHEDULER_QUEUE_BACKPRESSURE";
      const code = schedulerBackpressure
        ? "KERNEL_QUEUE_BACKPRESSURE"
        : schedulerTimeout || reason === "timeout"
          ? "KERNEL_SCHEDULER_TIMEOUT"
          : schedulerCancelled || reason
            ? "KERNEL_CANCELLED"
            : "KERNEL_EXECUTOR_FAILED";
      const terminalReason = schedulerTimeout ? "timeout" : reason ?? (schedulerCancelled ? "cancelled" : "executor-failed");
      const kind = schedulerCancelled || schedulerTimeout || reason ? "capability.cancelled" : "capability.failed";
      const failed = this.event(kind, sessionId, trace, { envelopeId: invocationId, capabilityId: binding.manifest.id, reason: terminalReason }, request.agentId, workflow.taskId, kernelError(code, message));
      await this.recordEvent(failed);
      yield failed;
      yield await this.closeWorkflow(workflow, schedulerTimeout || reason === "timeout" ? "timed-out" : schedulerCancelled || reason ? "cancelled" : "failed", { envelopeId: invocationId });
    } finally {
      for await (const event of drainSchedulerEvents(this)) yield event;
      unsubscribeScheduler();
      this.activeTasks.delete(invocationId);
    }
  }

  async cancel(invocationId: string, reason: string): Promise<void> {
    this.cancelled.set(invocationId, reason);
    const taskId = this.activeTasks.get(invocationId);
    if (taskId) {
      await this.deps.scheduler.cancel(asId<"task">(taskId), reason);
    }
  }

  async shutdown(reason = "shutdown"): Promise<void> {
    if (this.lifecycle === "shutdown") return;
    this.lifecycle = "shutting-down";
    for (const invocationId of this.activeTasks.keys()) {
      await this.cancel(invocationId, reason);
    }
    this.lifecycle = "shutdown";
    await this.publishLifecycle("shutdown");
  }

  state(): RuntimeKernelState {
    return this.lifecycle;
  }

  private async closeWorkflow(
    workflow: Awaited<ReturnType<RuntimeKernelDependencies["workflow"]["openInvocation"]>>,
    status: Parameters<RuntimeKernelDependencies["workflow"]["closeInvocation"]>[1],
    metadata: JsonObject
  ): Promise<RuntimeEvent> {
    const event = await this.deps.workflow.closeInvocation(workflow, status, metadata);
    await this.recordEvent(event);
    return event;
  }

  private async policyEvents(
    decision: PolicyDecision,
    sessionId: SessionId,
    trace: TraceContext,
    envelope: ExecutionEnvelope,
    agentId?: AgentId,
    taskId?: RuntimeEvent["taskId"]
  ): Promise<readonly RuntimeEvent[]> {
    const policy = this.event("policy.decided", sessionId, trace, {
      envelopeId: envelope.invocationId,
      action: decision.action,
      reason: decision.reason,
      audit: decision.audit ?? {},
      record: decision.record ?? {}
    }, agentId, taskId);
    const sandbox = this.event("sandbox.selected", sessionId, trace, {
      envelopeId: envelope.invocationId,
      profile: decision.sandboxProfile ?? "development"
    }, agentId, taskId);
    return [policy, sandbox];
  }

  private fallbackApprovalRequest(
    decision: PolicyDecision,
    request: RuntimeKernelRequest,
    sessionId: SessionId,
    trace: TraceContext,
    envelope: ExecutionEnvelope
  ): ApprovalRequest {
    const approvalId = `approval-${envelope.invocationId}` as ApprovalRequest["approvalId"];
    const auditReference: ApprovalRequest["auditReference"] = {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      traceId: trace.traceId,
      correlationId: trace.correlationId,
      policyDecision: decision.action,
      reasonCodes: ["policy.approval.required"],
      redaction: { class: "internal", fields: ["reasonCodes"] }
    };
    const summary: ApprovalRequest["summary"] = {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      title: "Approval required",
      subject: request.caller,
      action: `execute:${String(request.capabilityId)}`,
      resource: String(request.capabilityId),
      capability: String(request.capabilityId),
      targetKind: "capability",
      targetLabel: String(request.capabilityId),
      riskSummaries: [{
        schemaVersion: APPROVAL_SCHEMA_VERSION,
        kind: "policy",
        severity: "medium",
        title: "Runtime approval required",
        detail: decision.reason,
        reasonCodes: ["policy.approval.required"],
        referencePitFixtureIds: ["pit.headless-trust.fail-closed"],
        redaction: { class: "internal", fields: ["detail"] },
        metadata: { envelopeId: envelope.invocationId }
      }],
      allowedDecisions: ["allow", "deny", "cancel"],
      referencePitFixtureIds: ["pit.headless-trust.fail-closed"],
      redaction: { class: "internal", fields: ["targetLabel", "riskSummaries.detail"] },
      metadata: { envelopeId: envelope.invocationId }
    };
    return {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      approvalId,
      subject: request.caller,
      action: `execute:${String(request.capabilityId)}`,
      resource: String(request.capabilityId),
      metadata: {
        envelopeId: envelope.invocationId,
        sideEffect: envelope.sideEffect
      },
      prompt: `Approve execute:${String(request.capabilityId)}?`,
      decisionOptions: ["allow", "deny", "cancel"],
      summary,
      auditReference,
      trace,
      sessionId,
      compatibility: { schemaVersion: APPROVAL_SCHEMA_VERSION }
    };
  }

  private requiredApprovalRecord(request: ApprovalRequest): ApprovalLifecycleRecord {
    return {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      kind: "approval.required",
      approvalId: request.approvalId,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      trace: request.trace,
      summary: request.summary,
      auditReference: request.auditReference,
      redaction: { class: "internal", fields: ["summary.targetLabel", "summary.riskSummaries.detail"] },
      compatibility: request.compatibility
    };
  }

  private decisionApprovalRecord(request: ApprovalRequest, decision: ApprovalDecision): ApprovalLifecycleRecord {
    const kind: ApprovalLifecycleRecord["kind"] = decision.decision === "allow"
      ? "approval.decided"
      : decision.decision === "timeout"
        ? "approval.timeout"
        : decision.decision === "cancel"
          ? "approval.cancelled"
          : "approval.denied";
    return {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      kind,
      approvalId: request.approvalId,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      trace: decision.trace,
      summary: request.summary,
      decision,
      auditReference: decision.auditReference,
      redaction: { class: "internal", fields: ["summary.targetLabel", "summary.riskSummaries.detail", "decision.reason"] },
      compatibility: request.compatibility
    };
  }

  private approvalLifecycleEvent(
    record: ApprovalLifecycleRecord,
    sessionId: SessionId,
    trace: TraceContext,
    agentId: AgentId | undefined,
    taskId: RuntimeEvent["taskId"] | undefined,
    envelopeId: string
  ): RuntimeEvent {
    return this.event(record.kind, sessionId, trace, {
      envelopeId,
      approval: record,
      approvalId: record.approvalId,
      summary: record.summary,
      decision: record.decision ?? {}
    }, agentId, taskId);
  }

  private async platformExecutionContext(sideEffect: string, timeoutMs: number, input: JsonObject = {}): Promise<PlatformExecutionContext> {
    const descriptor = await this.deps.platform.descriptor();
    const requestedShell = typeof input.shellProfile === "string" ? input.shellProfile as Parameters<RuntimeKernelDependencies["platform"]["resolveShell"]>[0] : undefined;
    const shell = sideEffect === "process" ? (await this.deps.platform.resolveShell(requestedShell)).value : undefined;
    const processProvider = sideEffect === "process" ? await this.deps.platform.resolveProcessProvider() : undefined;
    const secureStorage = await this.deps.platform.secureStorageCapability();
    const normalizedSideEffect = sideEffect === "read" || sideEffect === "write" || sideEffect === "network" || sideEffect === "process" ? sideEffect : "none";
    const resourceScope = analyzeResourceScope(input, normalizedSideEffect);
    const sandboxRequirements = createSandboxRequirement({
      sideEffect: normalizedSideEffect,
      resourceScope,
      timeoutMs,
      permissions: []
    });
    return {
      descriptor,
      ...(shell ? { shell } : {}),
      ...(processProvider ? { processProvider } : {}),
      secureStorage,
      environmentScope: "scoped",
      timeoutMs,
      resourceLocks: [],
      sandboxProfile: "development",
      sandboxCapabilities: descriptor.sandbox,
      resourceScope,
      sandboxRequirements,
      redaction: { class: "internal", fields: ["descriptor.diagnostics", "secureStorage"] }
    };
  }

  private rejectedEvent(request: RuntimeKernelRequest, error: KernelError): RuntimeEvent {
    const sessionId = request.sessionId ?? asId<"session">("session-unbound");
    return this.event("execution.rejected", sessionId, request.trace ?? this.trace(sessionId, "rejected"), { capabilityId: request.capabilityId }, request.agentId, undefined, error);
  }

  private toKernelError(error?: import("@deepseek/platform-contracts").RedactedError): KernelError {
    if (!error) return kernelError("KERNEL_EXECUTOR_FAILED", "Executor returned failure");
    return kernelError("KERNEL_EXECUTOR_FAILED", error.message, {
      originalCode: error.code,
      retryable: error.retryable
    });
  }

  private async publishLifecycle(state: string): Promise<void> {
    const sessionId = asId<"session">("session-kernel");
    const trace = this.trace(sessionId, "lifecycle");
    await this.recordEvent(this.event("kernel.lifecycle", sessionId, trace, { state }));
  }

  private schedulerEventToRuntimeEvent(event: TaskEvent, sessionId: SessionId, trace: TraceContext, envelopeId: string, agentId?: AgentId, taskId?: TaskId): RuntimeEvent {
    const eventTrace = event.trace ?? trace;
    const kind = `scheduler.${event.status === "running" ? "started" : event.status}` as RuntimeEvent["kind"];
    return this.event(kind, sessionId, eventTrace, {
      envelopeId,
      taskId: event.taskId,
      status: event.status,
      reason: event.reason ?? ""
    }, agentId, taskId ?? event.taskId);
  }

  private async recordEvent(event: RuntimeEvent): Promise<void> {
    try {
      await this.appendSessionEvent(event);
      await this.deps.bus.publish(this.toBusEnvelope(event));
    } catch (error) {
      throw new Error(kernelError("KERNEL_EVENT_PERSISTENCE_FAILED", error instanceof Error ? error.message : "Replayable event persistence failed", {
        eventKind: event.kind
      }).message);
    }
    try {
      await this.deps.observability.emit({
        kind: event.kind.includes("failed") || event.kind.includes("rejected") ? "audit" : "trace",
        at: event.createdAt,
        name: event.kind,
        fields: event.data
      });
    } catch (error) {
      if (event.kind === "kernel.observability.degraded") return;
      const degraded = this.event(
        "kernel.observability.degraded",
        event.sessionId,
        event.trace,
        {
          sourceEventKind: event.kind,
          reason: error instanceof Error ? error.message : "Observability emit failed"
        },
        event.agentId,
        event.taskId,
        kernelError("KERNEL_OBSERVABILITY_DEGRADED", "Observability emit failed")
      );
      await this.appendSessionEvent(degraded);
      await this.deps.bus.publish(this.toBusEnvelope(degraded));
    }
  }

  private async appendSessionEvent(event: RuntimeEvent): Promise<void> {
    const events = await this.deps.sessions.events(event.sessionId);
    await this.deps.sessions.append({
      sessionId: event.sessionId,
      sequence: events.length + 1,
      kind: event.kind,
      at: event.createdAt,
      payload: event.data,
      redaction: { class: "internal" }
    });
  }

  private event(
    kind: RuntimeEvent["kind"],
    sessionId: SessionId,
    trace: TraceContext,
    data: JsonObject,
    agentId?: AgentId,
    taskId?: RuntimeEvent["taskId"],
    error?: KernelError
  ): RuntimeEvent {
    return {
      kind,
      sessionId,
      ...(taskId ? { taskId } : {}),
      ...(agentId ? { agentId } : {}),
      createdAt: this.deps.clock.now().toISOString(),
      trace,
      data: redactJsonSecrets(data) as JsonObject,
      ...(error ? { error } : {})
    };
  }

  private toBusEnvelope(event: RuntimeEvent): BusEnvelope {
    return {
      protocolVersion: "1",
      schemaVersion: "1.0.0",
      id: String(this.deps.ids.create("bus")),
      type: "event",
      createdAt: event.createdAt,
      trace: event.trace,
      redaction: { class: "internal" },
      compatibility: { schemaVersion: "1.0.0" },
      payload: {
        kind: event.kind,
        data: event.data,
        ...(event.error ? { error: event.error } : {})
      },
      topic: { name: "runtime.event", owner: "runtime", trustBoundary: "core" },
      producer: "runtime-kernel",
      correlationId: event.trace.correlationId,
      sessionId: event.sessionId,
      replayable: true
    };
  }

  private trace(sessionId: SessionId, scope: string): TraceContext {
    return {
      traceId: asId<"trace">(`trace-${scope}-${sessionId}`),
      spanId: asId<"span">(`span-${scope}-${sessionId}`),
      correlationId: asId<"correlation">(`corr-${scope}-${sessionId}`),
      sessionId
    };
  }
}

export function createRuntimeKernel(
  deps: RuntimeDependencies,
  options: Partial<Pick<RuntimeKernelDependencies, "clock" | "ids" | "logger">> = {}
): RuntimeKernel {
  return new InProcessRuntimeKernel({
    bus: deps.bus,
    workflow: deps.workflow,
    scheduler: deps.concurrency,
    capabilities: deps.capabilities,
    policy: deps.policy,
    approvals: deps.approvals,
    sandbox: deps.sandbox,
    sessions: deps.sessions,
    observability: deps.observability,
    platform: deps.platform,
    clock: options.clock ?? new DeterministicClock(),
    ids: options.ids ?? new DeterministicIdFactory(),
    logger: options.logger ?? new NoopRuntimeKernelLogger()
  });
}

export async function createDefaultRuntimeKernel(deps: RuntimeDependencies): Promise<RuntimeKernel> {
  await registerRuntimeBuiltins(deps);
  return createRuntimeKernel(deps);
}
