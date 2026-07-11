import type {
  AgentContinueRequest,
  AgentContinueResult,
  AgentDelegationDecision,
  AgentDelegationReasonCode,
  AgentNamespace,
  AgentSpawnRequest,
  AgentSpawnResult,
  AgentSpawner,
  AgentStopRequest,
  AgentStopResult,
  AgentScopeDiagnostic,
  AgentScopeEvaluationResult,
  AgentWorkerLifecycleEvent,
  AgentWorkerResult,
  JsonObject,
  PolicyRequest,
  RuntimeDependencies,
  RuntimeEvent,
  RuntimeKernel
} from "@deepseek/platform-contracts";
import { AGENT_MODE_COMPATIBILITY, AGENT_MODE_SCHEMA_VERSION, asId } from "@deepseek/platform-contracts";
import { defaultDeepSeekProfile } from "@deepseek/model-gateway";
import { runAgentLoop, defaultAgentLoopLimits } from "./agent-loop.js";
import { agentLoopEvent, recordRuntimeAdapterEvent } from "./events.js";
import { runtimeTrace, stableHash } from "./trace.js";

export function createAgentSpawner(deps: RuntimeDependencies, kernel: RuntimeKernel, workspaceRoot: string): AgentSpawner {
  return {
    async spawn(request: AgentSpawnRequest): Promise<AgentSpawnResult> {
      const definition = await deps.agents.getDefault();
      const mode = request.agentMode ?? request.workOrder?.mode ?? "worker";
      const workOrderId = request.workOrderId ?? request.workOrder?.workOrderId;
      const run = await runWorkerRequest({
        deps,
        kernel,
        workspaceRoot,
        request,
        source: "core.agent.spawn",
        lifecycleTransitionReasonPrefix: "agent.spawn",
        mode,
        ...(workOrderId ? { workOrderId } : {}),
        prompt: request.workOrder ? workerPromptFromWorkOrder(request.workOrder) : request.prompt,
        delegationDecision: createDelegationDecision({
          kind: "spawn",
          reasonCode: request.agentMode === "verifier" || request.workOrder?.mode === "verifier" ? "fresh-verification" : "parallel-independent-work",
          parentSessionId: request.parentSessionId,
          parentAgentId: request.parentAgentId,
          workOrderId,
          evidenceIds: request.workOrder?.evidenceIds ?? []
        })
      });

      return {
        childSessionId: run.childSessionId,
        workerAgentId: run.workerAgentId,
        workerInstanceId: run.workerInstanceId,
        ...(run.workOrderId ? { workOrderId: run.workOrderId } : {}),
        agentMode: run.agentMode,
        terminalStatus: run.terminalStatus,
        assistantText: run.assistantText,
        iterations: run.iterations,
        toolCalls: run.toolCalls,
        usage: run.usage,
        resultProvenance: run.resultProvenance,
        workerResult: run.workerResult,
        verifierStatus: run.workerResult.verifierVerdict ?? "not-run",
        diagnostics: run.diagnostics
      };
    },

    async continue(request: AgentContinueRequest): Promise<AgentContinueResult> {
      const previous = await deps.agents.getInstance(request.workerInstanceId);
      if (!previous) {
        throw new Error(`Unknown worker instance: ${request.workerInstanceId}`);
      }
      const workOrderId = request.workOrderId ?? request.workOrder?.workOrderId;
      const run = await runWorkerRequest({
        deps,
        kernel,
        workspaceRoot,
        request: {
          prompt: request.prompt,
          ...(request.workOrder ? { workOrder: request.workOrder } : {}),
          agentMode: request.workOrder?.mode ?? previous.mode,
          toolProjection: request.toolProjection ?? "read-only",
          ...(request.toolScope ? { toolScope: request.toolScope } : {}),
          ...(request.contextScope ? { contextScope: request.contextScope } : {}),
          ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
          ...(request.maxIterations ? { maxIterations: request.maxIterations } : {}),
          parentSessionId: request.parentSessionId ?? previous.parentSessionId ?? previous.sessionId,
          parentAgentId: request.parentAgentId ?? previous.parentAgentId ?? previous.definition.id,
          parentAgentInstanceId: request.parentAgentInstanceId ?? previous.id,
          ...(workOrderId ? { workOrderId } : {}),
          delegationDecisionId: `agent-delegation:${stableHash(`${previous.id}:${workOrderId ?? request.prompt}:continue`)}`,
          reason: request.reason ?? request.reasonCode ?? "high-context-overlap"
        },
        source: "core.agent.continue",
        lifecycleTransitionReasonPrefix: "agent.continue",
        mode: request.workOrder?.mode ?? previous.mode,
        ...(workOrderId ? { workOrderId } : {}),
        continuationOf: previous.id,
        prompt: request.workOrder ? workerPromptFromWorkOrder(request.workOrder) : request.prompt,
        continuationDecision: {
          contextOverlapScore: request.contextOverlapScore ?? 1,
          reasonCode: request.reasonCode ?? "high-context-overlap",
          evidenceIds: request.evidenceIds ?? request.workOrder?.evidenceIds ?? []
        },
        delegationDecision: createDelegationDecision({
          kind: "continue",
          reasonCode: request.reasonCode ?? "high-context-overlap",
          parentSessionId: request.parentSessionId ?? previous.parentSessionId ?? previous.sessionId,
          parentAgentId: request.parentAgentId ?? previous.parentAgentId ?? previous.definition.id,
          workOrderId,
          contextOverlapScore: request.contextOverlapScore ?? 1,
          evidenceIds: request.evidenceIds ?? request.workOrder?.evidenceIds ?? []
        })
      });

      await deps.agents.transitionInstance(previous.id, {
        transition: "continue",
        ...(workOrderId ? { workOrderId } : {}),
        reason: request.reason ?? request.reasonCode ?? "high-context-overlap",
        metadata: {
          continuedBy: run.workerInstanceId,
          contextOverlapScore: request.contextOverlapScore ?? 1
        }
      });

      return {
        childSessionId: run.childSessionId,
        workerAgentId: run.workerAgentId,
        workerInstanceId: run.workerInstanceId,
        continuationOf: previous.id,
        ...(run.workOrderId ? { workOrderId: run.workOrderId } : {}),
        agentMode: run.agentMode,
        terminalStatus: run.terminalStatus,
        assistantText: run.assistantText,
        iterations: run.iterations,
        toolCalls: run.toolCalls,
        usage: run.usage,
        resultProvenance: run.resultProvenance,
        workerResult: run.workerResult,
        verifierStatus: run.workerResult.verifierVerdict ?? "not-run",
        diagnostics: run.diagnostics
      };
    },

    async stop(request: AgentStopRequest): Promise<AgentStopResult> {
      const previous = await deps.agents.getInstance(request.workerInstanceId);
      if (!previous) {
        throw new Error(`Unknown worker instance: ${request.workerInstanceId}`);
      }
      const workOrderId = request.workOrderId ?? previous.workOrderId;
      const stopReason = request.stopReason ?? "manual-stop";
      const stopped = await deps.agents.transitionInstance(previous.id, {
        transition: "stop",
        ...(workOrderId ? { workOrderId } : {}),
        reason: request.reason ?? stopReason
      });
      const usage = emptyUsage();
      const delegationDecision = createDelegationDecision({
        kind: "stop",
        reasonCode: stopReason === "wrong-direction" ? "wrong-approach-retry" : "high-context-overlap",
        parentSessionId: request.parentSessionId ?? stopped.parentSessionId,
        parentAgentId: request.parentAgentId ?? stopped.parentAgentId,
        workerAgentId: stopped.definition.id,
        workerInstanceId: stopped.id,
        workOrderId,
        evidenceIds: []
      });
      const workerResult = createStoppedWorkerResult({
        instance: stopped,
        parentSessionId: request.parentSessionId ?? stopped.parentSessionId,
        stopReason,
        usage
      });
      await emitWorkerLifecycleEvent({
        deps,
        parentSessionId: request.parentSessionId ?? stopped.parentSessionId,
        parentAgentId: request.parentAgentId ?? stopped.parentAgentId,
        workerSessionId: stopped.sessionId,
        workerAgentId: stopped.definition.id,
        workerInstanceId: stopped.id,
        workOrderId,
        status: "stopped",
        stopReason,
        delegationDecision
      });
      await emitParentWorkerResult({
        deps,
        parentSessionId: request.parentSessionId ?? stopped.parentSessionId,
        parentAgentId: request.parentAgentId ?? stopped.parentAgentId,
        workerResult
      });
      return {
        workerInstanceId: stopped.id,
        workerSessionId: stopped.sessionId,
        workerAgentId: stopped.definition.id,
        ...(workOrderId ? { workOrderId } : {}),
        lifecycleState: "stopped",
        status: "stopped",
        stopReason,
        usage,
        resultProvenance: {
          source: "core.agent.stop",
          workerResultId: workerResult.resultId,
          delegationDecision,
          lifecycleEventCount: stopped.lifecycleEvents.length
        },
        workerResult,
        diagnostics: []
      };
    }
  };
}

async function runWorkerRequest(input: {
  readonly deps: RuntimeDependencies;
  readonly kernel: RuntimeKernel;
  readonly workspaceRoot: string;
  readonly request: AgentSpawnRequest;
  readonly source: string;
  readonly lifecycleTransitionReasonPrefix: string;
  readonly mode: import("@deepseek/platform-contracts").AgentModeName;
  readonly workOrderId?: string;
  readonly prompt: string;
  readonly continuationOf?: import("@deepseek/platform-contracts").AgentInstanceId;
  readonly continuationDecision?: {
    readonly contextOverlapScore: number;
    readonly reasonCode: string;
    readonly evidenceIds: readonly string[];
  };
  readonly delegationDecision: AgentDelegationDecision;
}) {
  const parentSessionId = input.request.parentSessionId;
  let forkedSessionId = parentSessionId;
  if (parentSessionId) {
    const forked = await input.deps.sessions.fork({
      parentSessionId,
      reason: input.request.reason ?? input.source
    });
    if (forked.ok && forked.value) forkedSessionId = forked.value.childSessionId;
  }

  const definition = await input.deps.agents.getDefault();
  const selectedMode = definition.supportedAgentModes.includes(input.mode) ? input.mode : definition.defaultAgentMode;
  const scopeProjection = await input.deps.agents.projectScopes(definition.id, selectedMode);
  const sessionId = forkedSessionId ?? await input.deps.sessions.create({ caller: input.source, workspaceRoot: input.workspaceRoot });
  const namespace = input.request.namespace ?? await input.deps.agents.projectNamespace(definition.id, selectedMode, {
    ...(input.request.parentAgentId ? { parentAgentId: input.request.parentAgentId } : {}),
    ...(input.request.parentAgentInstanceId ? { parentAgentInstanceId: input.request.parentAgentInstanceId } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    childSessionId: sessionId,
    ...(input.workOrderId ? { workOrderId: input.workOrderId } : {}),
    delegatedPaths: delegatedPathsFrom(input.request),
    delegatedTools: delegatedToolsFrom(input.request)
  });
  const scopeEvaluation = await enforceAgentScopeHandoff({
    deps: input.deps,
    source: input.source,
    sessionId,
    parentSessionId,
    parentAgentId: input.request.parentAgentId,
    request: input.request,
    namespace
  });
  const instance = await input.deps.agents.createInstance(definition.id, sessionId, {
    mode: selectedMode,
    ...(input.request.parentAgentId ? { parentAgentId: input.request.parentAgentId } : {}),
    ...(input.request.parentAgentInstanceId ? { parentAgentInstanceId: input.request.parentAgentInstanceId } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    childSessionId: sessionId,
    ...(input.workOrderId ? { workOrderId: input.workOrderId } : {}),
    ...(input.request.delegationDecisionId ? { delegationDecisionId: input.request.delegationDecisionId } : {}),
    ...(input.continuationOf ? { continuationOf: input.continuationOf } : {}),
    scopeProjection,
    namespace,
    metadata: {
      source: input.source,
      toolProjection: input.request.toolProjection ?? "read-only",
      namespaceId: namespace.namespaceId,
      scopeEvaluation,
      ...(input.request.toolScope ? { toolScope: input.request.toolScope } : {}),
      ...(input.request.contextScope ? { contextScope: input.request.contextScope } : {}),
      delegationDecision: input.delegationDecision,
      ...(input.continuationDecision ? { continuationDecision: input.continuationDecision } : {})
    }
  });

  await emitWorkerLifecycleEvent({
    deps: input.deps,
    parentSessionId,
    parentAgentId: input.request.parentAgentId,
    workerSessionId: instance.sessionId,
    workerAgentId: definition.id,
    workerInstanceId: instance.id,
    workOrderId: input.workOrderId,
    status: input.continuationOf ? "continued" : "spawned",
    delegationDecision: {
      ...input.delegationDecision,
      workerAgentId: definition.id,
      workerInstanceId: instance.id
    }
  });

  const limits = {
    ...defaultAgentLoopLimits,
    maxModelIterations: Math.min(input.request.maxIterations ?? 8, quotaLimit(namespace, "retries", defaultAgentLoopLimits.maxModelIterations * 2) + defaultAgentLoopLimits.maxModelIterations),
    maxToolCalls: Math.min(defaultAgentLoopLimits.maxToolCalls, quotaLimit(namespace, "tool-calls", defaultAgentLoopLimits.maxToolCalls)),
    turnTimeoutMs: Math.min(input.request.timeoutMs ?? defaultAgentLoopLimits.turnTimeoutMs, quotaLimit(namespace, "wall-clock-ms", defaultAgentLoopLimits.turnTimeoutMs))
  };

  const events: RuntimeEvent[] = [];
  for await (const event of runAgentLoop(input.deps, input.kernel, {
    prompt: input.prompt,
    sessionId: instance.sessionId,
    agentId: definition.id,
    agentMode: instance.mode,
    caller: input.source,
    workspaceRoot: input.workspaceRoot,
    outputMode: "jsonl",
    profile: defaultDeepSeekProfile,
    toolProjection: input.request.toolProjection ?? "read-only",
    ...(input.request.timeoutMs ? { timeoutMs: input.request.timeoutMs } : {}),
    limits
  })) {
    events.push(event);
  }

  const terminal = [...events].reverse().find((event) =>
    event.kind === "agent.loop.completed" || event.kind === "agent.loop.failed" || event.kind === "agent.loop.cancelled"
  );
  const summary = (terminal?.data as import("@deepseek/platform-contracts").AgentLoopSummary | undefined);
  const terminalStatus = (summary?.status ?? "failed") as AgentSpawnResult["terminalStatus"];
  const lifecycleTransition = terminalStatus === "completed" ? "complete" : terminalStatus === "cancelled" ? "stop" : "fail";
  const finalInstance = await input.deps.agents.transitionInstance(instance.id, {
    transition: lifecycleTransition,
    ...(input.workOrderId ? { workOrderId: input.workOrderId } : {}),
    reason: `${input.lifecycleTransitionReasonPrefix}.${terminalStatus}`
  });
  const workerResult = createWorkerResult({
    request: input.request,
    childSessionId: finalInstance.sessionId,
    workerAgentId: definition.id,
    workerInstanceId: finalInstance.id,
    terminalStatus,
    summary,
    events
  });
  await emitParentWorkerResult({
    deps: input.deps,
    parentSessionId,
    parentAgentId: input.request.parentAgentId,
    workerResult,
    ...(summary?.turnId ? { turnId: summary.turnId } : {})
  });

  return {
    childSessionId: summary?.sessionId ?? finalInstance.sessionId,
    workerAgentId: definition.id,
    workerInstanceId: finalInstance.id,
    workOrderId: input.workOrderId,
    agentMode: finalInstance.mode,
    terminalStatus,
    assistantText: String(summary?.assistantText ?? ""),
    iterations: Number(summary?.iterations ?? 0),
    toolCalls: Number(summary?.toolCalls ?? 0),
    usage: summarizeUsage(events),
    resultProvenance: {
      source: input.source,
      eventCount: events.length,
      terminalEventKind: terminal?.kind ?? "missing",
      workerResultId: workerResult.resultId,
      delegationDecision: {
        ...input.delegationDecision,
        workerAgentId: definition.id,
        workerInstanceId: finalInstance.id
      },
      workerLaunchEvent: input.continuationOf ? "agent.worker.continued" : "agent.worker.launched"
    },
    workerResult,
    diagnostics: summary?.diagnostics ?? []
  };
}

function workOrderIdFrom(request: AgentSpawnRequest): string | undefined {
  return request.workOrderId ?? request.workOrder?.workOrderId;
}

class AgentScopeEnforcementError extends Error {
  readonly code: string;
  readonly diagnostics: readonly AgentScopeDiagnostic[];
  readonly result: AgentScopeEvaluationResult;

  constructor(result: AgentScopeEvaluationResult) {
    const diagnostic = result.diagnostics[0];
    super(diagnostic?.message ?? `Agent scope enforcement failed: ${result.status}`);
    this.name = "AgentScopeEnforcementError";
    this.code = diagnostic?.code ?? "AGENT_SCOPE_DENIED";
    this.diagnostics = result.diagnostics;
    this.result = result;
  }
}

export function isAgentScopeEnforcementError(error: unknown): error is AgentScopeEnforcementError {
  return error instanceof AgentScopeEnforcementError;
}

async function enforceAgentScopeHandoff(input: {
  readonly deps: RuntimeDependencies;
  readonly source: string;
  readonly sessionId: import("@deepseek/platform-contracts").SessionId;
  readonly parentSessionId: import("@deepseek/platform-contracts").SessionId | undefined;
  readonly parentAgentId: import("@deepseek/platform-contracts").AgentId | undefined;
  readonly request: AgentSpawnRequest;
  readonly namespace: AgentNamespace;
}): Promise<AgentScopeEvaluationResult> {
  let result = await input.deps.agents.evaluateScope({ namespace: input.namespace, operation: "namespace.expand" });
  const parentInstance = input.request.parentAgentInstanceId ? await input.deps.agents.getInstance(input.request.parentAgentInstanceId) : undefined;

  if (parentInstance?.namespace) {
    const expansion = await input.deps.agents.evaluateScope({
      namespace: input.namespace,
      operation: "namespace.expand",
      parentNamespace: parentInstance.namespace,
      requestedNamespace: input.namespace
    });
    if (expansion.policyRequired) {
      const policyRequest = agentNamespacePolicyRequest(input, parentInstance.namespace);
      const policyDecision = await input.deps.policy.decide(policyRequest);
      if (!policyDecision.record) {
        result = {
          ...expansion,
          status: "denied",
          allowed: false,
          policyRequired: true,
          diagnostics: [scopeDiagnostic("AGENT_NAMESPACE_POLICY_RECORD_MISSING", "release-blocking", "policy", "Policy decision for namespace expansion did not include an audit record.", input.namespace.namespaceId)]
        };
      } else {
        result = await input.deps.agents.evaluateScope({
          namespace: input.namespace,
          operation: "namespace.expand",
          parentNamespace: parentInstance.namespace,
          requestedNamespace: input.namespace,
          policyDecision: policyDecision.record
        });
      }
      await emitAgentScopeResult(input, result);
      if (!result.allowed) throw new AgentScopeEnforcementError(result);
    } else {
      result = expansion;
      if (!result.allowed) {
        await emitAgentScopeResult(input, result);
        throw new AgentScopeEnforcementError(result);
      }
    }
  }

  const writePaths = requestedWritePaths(input.request);
  if (writePaths.length > 0) {
    result = await input.deps.agents.evaluateScope({
      namespace: input.namespace,
      operation: "quota.consume",
      quotaKind: "file-mutations",
      requested: writePaths.length
    });
    if (!result.allowed) {
      await emitAgentScopeResult(input, result);
      throw new AgentScopeEnforcementError(result);
    }
  }

  for (const path of writePaths) {
    result = await input.deps.agents.evaluateScope({ namespace: input.namespace, operation: "file.write", path });
    if (!result.allowed) {
      await emitAgentScopeResult(input, result);
      throw new AgentScopeEnforcementError(result);
    }
  }

  await emitAgentScopeResult(input, result);
  return result;
}

async function emitAgentScopeResult(input: {
  readonly deps: RuntimeDependencies;
  readonly sessionId: import("@deepseek/platform-contracts").SessionId;
  readonly parentSessionId: import("@deepseek/platform-contracts").SessionId | undefined;
  readonly parentAgentId: import("@deepseek/platform-contracts").AgentId | undefined;
  readonly namespace: AgentNamespace;
}, result: AgentScopeEvaluationResult): Promise<void> {
  const sessionId = input.parentSessionId ?? input.sessionId;
  const trace = runtimeTrace(sessionId, `agent-scope-${result.status}`);
  const kind = result.status === "quota-exhausted"
    ? "agent.quota.exhausted"
    : result.allowed ? "agent.scope.evaluated" : "agent.scope.denied";
  const event = agentLoopEvent(kind, sessionId, asId<"turn">(`turn-${stableHash(`${input.namespace.namespaceId}:${result.operation}:${result.status}`)}`), trace, {
    namespaceId: input.namespace.namespaceId,
    operation: result.operation,
    status: result.status,
    policyRequired: result.policyRequired,
    diagnostics: result.diagnostics,
    result
  }, input.parentAgentId, result.allowed ? undefined : {
    code: result.diagnostics[0]?.code ?? "AGENT_SCOPE_DENIED",
    message: result.diagnostics[0]?.message ?? "Agent scope denied.",
    retryable: false,
    redaction: { class: "internal" }
  });
  await recordRuntimeAdapterEvent(input.deps, event);
}

function agentNamespacePolicyRequest(input: {
  readonly source: string;
  readonly namespace: AgentNamespace;
  readonly request: AgentSpawnRequest;
}, parentNamespace: AgentNamespace): PolicyRequest {
  return {
    subject: input.source,
    action: "agent.namespace.expand",
    resource: input.namespace.namespaceId,
    metadata: {
      sideEffect: "none",
      operationFamily: "sandbox",
      parentNamespaceId: parentNamespace.namespaceId,
      requestedNamespaceId: input.namespace.namespaceId,
      workOrderId: input.request.workOrderId ?? input.request.workOrder?.workOrderId ?? "",
      reason: input.request.reason ?? "child-agent-namespace-expansion"
    }
  };
}

function requestedWritePaths(request: AgentSpawnRequest): readonly string[] {
  const projection = request.toolProjection ?? "read-only";
  const workOrderProjection = stringValue(request.workOrder?.permissionScope.toolProjection);
  const writeRequested = projection === "read-write" || projection === "safe-all" || projection === "all" || workOrderProjection === "read-write" || workOrderProjection === "safe-all" || workOrderProjection === "all" || (request.workOrder?.allowedTools ?? []).some((tool) => tool === "file.write" || tool === "file.edit");
  return writeRequested ? delegatedPathsFrom(request) : [];
}

function delegatedPathsFrom(request: AgentSpawnRequest): readonly string[] {
  const scoped = stringArrayValue((request.toolScope as JsonObject | undefined)?.writeScope)
    ?? stringArrayValue(request.workOrder?.permissionScope.writeScope)
    ?? targetPathsFrom(request);
  return scoped.length > 0 ? scoped : [];
}

function delegatedToolsFrom(request: AgentSpawnRequest): readonly string[] {
  return request.workOrder?.allowedTools && request.workOrder.allowedTools.length > 0
    ? request.workOrder.allowedTools
    : request.toolProjection === "read-write" || request.toolProjection === "safe-all" || request.toolProjection === "all"
      ? ["file.read", "file.list", "search.text", "git.status", "git.diff", "file.edit", "file.write", "test.run"]
      : ["file.read", "file.list", "search.text", "git.status", "git.diff"];
}

function targetPathsFrom(request: AgentSpawnRequest): readonly string[] {
  return (request.workOrder?.targets ?? []).map((target) => target.path).filter((path): path is string => typeof path === "string" && path.length > 0);
}

function stringArrayValue(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function quotaLimit(namespace: AgentNamespace, kind: "tool-calls" | "wall-clock-ms" | "retries", fallback: number): number {
  const quota = namespace.quotas.find((item) => item.kind === kind);
  return quota && quota.limit > 0 ? quota.limit : fallback;
}

function scopeDiagnostic(
  code: string,
  severity: AgentScopeDiagnostic["severity"],
  category: AgentScopeDiagnostic["category"],
  message: string,
  namespaceId: string
): AgentScopeDiagnostic {
  return {
    code,
    severity,
    category,
    message,
    namespaceId,
    releaseBlocking: severity === "release-blocking",
    redaction: { class: "internal", fields: ["message"] }
  };
}

function createDelegationDecision(input: {
  readonly kind: AgentDelegationDecision["kind"];
  readonly reasonCode: AgentDelegationReasonCode;
  readonly parentSessionId: import("@deepseek/platform-contracts").SessionId | undefined;
  readonly parentAgentId: import("@deepseek/platform-contracts").AgentId | undefined;
  readonly workerAgentId?: import("@deepseek/platform-contracts").AgentId;
  readonly workerInstanceId?: import("@deepseek/platform-contracts").AgentInstanceId;
  readonly workOrderId: string | undefined;
  readonly contextOverlapScore?: number;
  readonly evidenceIds: readonly string[];
}): AgentDelegationDecision {
  const fingerprint = [
    input.kind,
    input.reasonCode,
    input.parentSessionId ?? "",
    input.parentAgentId ?? "",
    input.workerInstanceId ?? "",
    input.workOrderId ?? "",
    input.evidenceIds.join(",")
  ].join(":");
  return {
    schemaVersion: AGENT_MODE_SCHEMA_VERSION,
    decisionId: `agent-delegation:${stableHash(fingerprint)}`,
    kind: input.kind,
    reasonCode: input.reasonCode,
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
    ...(input.workerAgentId ? { workerAgentId: input.workerAgentId } : {}),
    ...(input.workerInstanceId ? { workerInstanceId: input.workerInstanceId } : {}),
    ...(input.workOrderId ? { workOrderId: input.workOrderId } : {}),
    ...(typeof input.contextOverlapScore === "number" ? { contextOverlapScore: input.contextOverlapScore } : {}),
    evidenceIds: input.evidenceIds,
    diagnostics: [],
    redaction: { class: "internal" },
    compatibility: AGENT_MODE_COMPATIBILITY
  };
}

async function emitWorkerLifecycleEvent(input: {
  readonly deps: RuntimeDependencies;
  readonly parentSessionId: import("@deepseek/platform-contracts").SessionId | undefined;
  readonly parentAgentId: import("@deepseek/platform-contracts").AgentId | undefined;
  readonly workerSessionId: import("@deepseek/platform-contracts").SessionId;
  readonly workerAgentId: import("@deepseek/platform-contracts").AgentId;
  readonly workerInstanceId: import("@deepseek/platform-contracts").AgentInstanceId;
  readonly workOrderId: string | undefined;
  readonly status: AgentWorkerLifecycleEvent["status"];
  readonly stopReason?: AgentWorkerLifecycleEvent["stopReason"];
  readonly delegationDecision?: AgentDelegationDecision;
}): Promise<void> {
  const eventSessionId = input.parentSessionId ?? input.workerSessionId;
  const trace = runtimeTrace(eventSessionId, `agent-worker-${input.status}`);
  const lifecycle: AgentWorkerLifecycleEvent = {
    schemaVersion: AGENT_MODE_SCHEMA_VERSION,
    workerEventId: `agent-worker:${input.status}:${stableHash(`${input.workerInstanceId}:${input.workOrderId ?? ""}`)}`,
    status: input.status,
    sessionId: eventSessionId,
    workerSessionId: input.workerSessionId,
    ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
    workerAgentId: input.workerAgentId,
    workerInstanceId: input.workerInstanceId,
    ...(input.workOrderId ? { workOrderId: input.workOrderId } : {}),
    ...(input.stopReason ? { stopReason: input.stopReason } : {}),
    ...(input.delegationDecision ? { delegationDecision: input.delegationDecision } : {}),
    at: new Date(0).toISOString(),
    diagnostics: [],
    trace,
    redaction: { class: "internal" },
    compatibility: AGENT_MODE_COMPATIBILITY
  };
  const kind = input.status === "continued" ? "agent.worker.continued" : input.status === "stopped" ? "agent.worker.stopped" : "agent.worker.launched";
  const event = agentLoopEvent(kind, eventSessionId, asId<"turn">(`turn-${stableHash(lifecycle.workerEventId)}`), trace, lifecycle, input.parentAgentId);
  await recordRuntimeAdapterEvent(input.deps, event);
}

async function emitParentWorkerResult(input: {
  readonly deps: RuntimeDependencies;
  readonly parentSessionId: import("@deepseek/platform-contracts").SessionId | undefined;
  readonly parentAgentId: import("@deepseek/platform-contracts").AgentId | undefined;
  readonly workerResult: AgentWorkerResult;
  readonly turnId?: import("@deepseek/platform-contracts").TurnId;
}): Promise<void> {
  if (!input.parentSessionId) return;
  const trace = runtimeTrace(input.parentSessionId, "agent-worker-result");
  const event = agentLoopEvent(
    "agent.worker.result",
    input.parentSessionId,
    input.turnId ?? asId<"turn">(`turn-${stableHash(input.workerResult.resultId)}`),
    trace,
    input.workerResult,
    input.parentAgentId
  );
  await recordRuntimeAdapterEvent(input.deps, event);
}

function workerPromptFromWorkOrder(workOrder: NonNullable<AgentSpawnRequest["workOrder"]>): string {
  return [
    workOrder.originalUserGoal,
    "",
    "Structured worker task:",
    workOrder.taskSummary,
    "",
    `Purpose: ${workOrder.purpose}`,
    `Targets: ${workOrder.targets.map((target) => target.path ?? target.id).join(", ") || "none"}`,
    `Done criteria: ${workOrder.doneCriteria.join("; ")}`
  ].join("\n");
}

function createStoppedWorkerResult(input: {
  readonly instance: import("@deepseek/platform-contracts").AgentInstance;
  readonly parentSessionId: import("@deepseek/platform-contracts").SessionId | undefined;
  readonly stopReason: NonNullable<AgentStopRequest["stopReason"]>;
  readonly usage: ReturnType<typeof emptyUsage>;
}): AgentWorkerResult {
  const summary = `Worker stopped: ${input.stopReason}`;
  return {
    schemaVersion: AGENT_MODE_SCHEMA_VERSION,
    resultId: `agent-worker-result:${stableHash(`${input.instance.sessionId}:${input.instance.id}:stopped:${input.stopReason}`)}`,
    workerSessionId: input.instance.sessionId,
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    workerAgentId: input.instance.definition.id,
    workerInstanceId: input.instance.id,
    ...(input.instance.workOrderId ? { workOrderId: input.instance.workOrderId } : {}),
    status: "stopped",
    summary,
    evidenceIds: [],
    changedScope: [],
    usage: input.usage,
    diagnostics: [],
    redaction: { class: "internal", fields: ["summary"] },
    compatibility: AGENT_MODE_COMPATIBILITY
  };
}

function createWorkerResult(input: {
  readonly request: AgentSpawnRequest;
  readonly childSessionId: import("@deepseek/platform-contracts").SessionId;
  readonly workerAgentId: import("@deepseek/platform-contracts").AgentId;
  readonly workerInstanceId: import("@deepseek/platform-contracts").AgentInstanceId;
  readonly terminalStatus: AgentSpawnResult["terminalStatus"];
  readonly summary: import("@deepseek/platform-contracts").AgentLoopSummary | undefined;
  readonly events: readonly RuntimeEvent[];
}): AgentWorkerResult {
  const workOrderId = workOrderIdFrom(input.request);
  const verifierVerdict = input.summary?.phasePlan?.phases.some((phase) => phase.phase === "verify" && phase.status === "required") ? "partial" : undefined;
  return {
    schemaVersion: AGENT_MODE_SCHEMA_VERSION,
    resultId: `agent-worker-result:${stableHash(`${input.childSessionId}:${input.request.workOrderId ?? input.request.workOrder?.workOrderId ?? input.request.prompt}`)}`,
    workerSessionId: input.childSessionId,
    ...(input.request.parentSessionId ? { parentSessionId: input.request.parentSessionId } : {}),
    workerAgentId: input.workerAgentId,
    workerInstanceId: input.workerInstanceId,
    ...(workOrderId ? { workOrderId } : {}),
    status: input.terminalStatus,
    summary: String(input.summary?.assistantText ?? ""),
    evidenceIds: evidenceIdsFrom(input.request),
    changedScope: [],
    usage: summarizeUsage(input.events),
    ...(verifierVerdict ? { verifierVerdict } : {}),
    diagnostics: input.summary?.diagnostics ?? [],
    redaction: { class: "internal", fields: ["summary", "diagnostics.details"] },
    compatibility: AGENT_MODE_COMPATIBILITY
  };
}

function evidenceIdsFrom(request: AgentSpawnRequest): readonly string[] {
  return request.workOrder?.evidenceIds ?? [];
}

function summarizeUsage(events: readonly RuntimeEvent[]) {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of events) {
    if (event.kind !== "usage.updated") continue;
    inputTokens += typeof event.data.inputTokens === "number" ? event.data.inputTokens : 0;
    outputTokens += typeof event.data.outputTokens === "number" ? event.data.outputTokens : 0;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens
  };
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
}
