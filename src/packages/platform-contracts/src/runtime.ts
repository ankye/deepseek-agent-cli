import type { Clock, JsonObject, RedactedError, TraceContext } from "./common.js";
import type { AgentId, CapabilityId, CredentialRef, IdFactory, ModelProviderId, ModelProfileId, SessionId, TaskId, TurnId, WorkflowId } from "./ids.js";
import type { CliReferenceKind, CliTargetRef } from "./cli-composition.js";
import type { AgentModeName, AgentModeSessionSummary, AgentPhasePlan, AgentReasoningEffortMapping } from "./agent-mode.js";
import type { AgentManager } from "./agent.js";
import type { CapabilityRegistry } from "./capability.js";
import type { CacheManager, MemoryManager } from "./memory.js";
import type { MemoryScope } from "./memory.js";
import type { CodeIntelligenceService } from "./code-intelligence.js";
import type { CommandSystem } from "./command.js";
import type { ConcurrencyOrchestrator } from "./concurrency.js";
import type { ConfigStore } from "./config.js";
import type { ContextEngine } from "./context.js";
import type { LosslessContextManager } from "./lossless-context.js";
import type { CredentialManager } from "./credential.js";
import type { DistributionUpdateManager } from "./distribution.js";
import type { EvolutionEngine } from "./evolution.js";
import type { ExtensionManager } from "./extension.js";
import type { HookSystem } from "./hook.js";
import type { McpGateway } from "./mcp.js";
import type { ModelGateway, ModelProfile, ModelReasoningOptions } from "./model.js";
import type { PromptAssembler } from "./prompt-assembly.js";
import type { StagedTaskGraph, StagedTaskRunState } from "./staged-task.js";
import type { VisibleReasoningProjection } from "./visible-reasoning.js";
import type { SelfRepairConfig, SelfRepairOutcomeSummary } from "./self-repair.js";
import type { InteractionModeName, InteractionModeState, InteractionModeTransition } from "./interaction-mode.js";
import type { ToolFeedbackStatus, ToolIntentPreflightService } from "./tool-intent.js";
import type { ObservabilitySink } from "./observability.js";
import type { PlatformRuntime } from "./platform.js";
import type { PluginManager } from "./plugin.js";
import type { ApprovalBroker } from "./approval.js";
import type { PolicyEngine, SandboxRuntime } from "./policy.js";
import type { ResourceScope, SandboxAuditEvidence, SandboxRequirement, SecretRedactionDecision } from "./security.js";
import type { ProtocolRouter } from "./protocol.js";
import type { RemoteRuntimeConnectivity } from "./remote.js";
import type { RuntimeMessageBus } from "./bus.js";
import type { RegressionHarness } from "./testing.js";
import type { SessionStore } from "./session.js";
import type { SkillSystem } from "./skill.js";
import type { UsageBudgetManager } from "./usage.js";
import type { WorkflowOrchestrator } from "./workflow.js";
import type { WorkspaceStateManager } from "./workspace.js";

export type RuntimeEventKind =
  | "kernel.lifecycle"
  | "kernel.request.accepted"
  | "execution.envelope.created"
  | "execution.rejected"
  | "workflow.opened"
  | "workflow.closed"
  | "policy.decided"
  | "approval.required"
  | "approval.decided"
  | "approval.denied"
  | "approval.timeout"
  | "approval.cancelled"
  | "approval.audit-linked"
  | "sandbox.selected"
  | "scheduler.queued"
  | "scheduler.started"
  | "scheduler.completed"
  | "scheduler.failed"
  | "scheduler.cancelled"
  | "scheduler.timed-out"
  | "kernel.observability.degraded"
  | "capability.started"
  | "capability.output"
  | "capability.completed"
  | "capability.failed"
  | "capability.cancelled"
  | "session.started"
  | "turn.started"
  | "agent.loop.started"
  | "agent.loop.completed"
  | "agent.loop.failed"
  | "agent.loop.cancelled"
  | "agent.repair.started"
  | "agent.repair.classified"
  | "agent.repair.plan.created"
  | "agent.repair.attempt.started"
  | "agent.repair.attempt.completed"
  | "agent.repair.verification.started"
  | "agent.repair.verification.completed"
  | "agent.repair.stopped"
  | "mode.interaction.changed"
  | "mode.interaction.degraded"
  | "mode.agent.bound"
  | "agent.phase.plan.created"
  | "agent.phase.skipped"
  | "agent.loop.budget.consumed"
  | "agent.scope.evaluated"
  | "agent.scope.denied"
  | "agent.quota.exhausted"
  | "agent.worker.launched"
  | "agent.worker.continued"
  | "agent.worker.stopped"
  | "agent.worker.result"
  | "agent.verifier.verdict"
  | "agent.output-contract.verified"
  | "agent.repair.attempted"
  | "agent.repair.rerun"
  | "agent.result.reconciled"
  | "task.decision.received"
  | "model.reasoning.effort.mapped"
  | "evidence.classified"
  | "evidence.plan.created"
  | "evidence.selected"
  | "evidence.claims.grounded"
  | "evidence.manifest.created"
  | "evidence.unsupported-claim"
  | "prompt.assembled"
  | "visible.reasoning.recorded"
  | "visible.reasoning.projected"
  | "model.requested"
  | "context.projection.started"
  | "context.projection.cache-hit"
  | "context.projection.degraded"
  | "context.projection.rejected"
  | "context.projection.completed"
  | "context.memory.collected"
  | "context.compact.boundary"
  | "context.lcm.node-recorded"
  | "context.lcm.summary-recorded"
  | "context.lcm.degraded"
  | "memory.permanent.candidate.proposed"
  | "memory.permanent.promoted"
  | "memory.permanent.injected"
  | "memory.permanent.stale"
  | "memory.permanent.conflict"
  | "memory.permanent.deleted"
  | "memory.permanent.provider.switched"
  | "memory.permanent.disabled"
  | "memory.permanent.hook.started"
  | "memory.permanent.hook.completed"
  | "memory.permanent.hook.failed"
  | "workflow.step"
  | "bus.recorded"
  | "model.delta"
  | "model.reasoning"
  | "model.reasoning.persisted"
  | "model.tool.intent"
  | "model.tool.repaired"
  | "model.tool.rejected"
  | "model.tool.result"
  | "model.finished"
  | "model.done"
  | "model.blocked"
  | "usage.updated"
  | "runtime.status.telemetry"
  | "turn.completed"
  | "hooks.invoked"
  | "skill.activated"
  | "runtime.error"
  | "runtime.disposed";

export type ExecutionInvocationKind =
  | "capability"
  | "model"
  | "command"
  | "skill"
  | "hook"
  | "mcp"
  | "sandbox"
  | "plugin"
  | "subagent";

export type ExecutionOutcomeStatus = "completed" | "failed" | "cancelled" | "timed-out" | "rejected";

export type RuntimeKernelState = "created" | "running" | "shutting-down" | "shutdown";

export type KernelErrorCode =
  | "KERNEL_CONFIGURATION_ERROR"
  | "KERNEL_NOT_RUNNING"
  | "KERNEL_SHUTDOWN"
  | "KERNEL_CAPABILITY_NOT_FOUND"
  | "KERNEL_ENVELOPE_INVALID"
  | "KERNEL_INVALID_TIMEOUT"
  | "KERNEL_MALFORMED_TRACE"
  | "KERNEL_POLICY_DENIED"
  | "KERNEL_POLICY_DECISION_MISSING"
  | "KERNEL_SCHEDULER_TIMEOUT"
  | "KERNEL_QUEUE_BACKPRESSURE"
  | "KERNEL_CANCELLED"
  | "KERNEL_EXECUTOR_FAILED"
  | "KERNEL_EVENT_PERSISTENCE_FAILED"
  | "KERNEL_OBSERVABILITY_DEGRADED"
  | "KERNEL_LEGACY_EXECUTION_REJECTED";

export interface KernelError extends RedactedError {
  readonly code: KernelErrorCode;
}

export interface ExecutionEnvelope extends JsonObject {
  readonly invocationId: string;
  readonly capabilityId: CapabilityId;
  readonly capabilityVersion: string;
  readonly kind: ExecutionInvocationKind;
  readonly caller: string;
  readonly parentInvocationId?: string;
  readonly sessionId?: SessionId;
  readonly turnId?: TurnId;
  readonly workflowId?: WorkflowId;
  readonly taskId?: TaskId;
  readonly agentId?: AgentId;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly redactionClass: string;
  readonly provenance: JsonObject;
  readonly trust: string;
  readonly permissions: readonly string[];
  readonly sideEffect: string;
  readonly policyContext: JsonObject;
  readonly approvalRequired: boolean;
  readonly sandboxProfile?: string;
  readonly resourceLocks: readonly string[];
  readonly timeoutMs: number;
  readonly deadlineAt?: string;
  readonly cancellation: JsonObject;
  readonly retryPolicy: JsonObject;
  readonly idempotency: JsonObject;
  readonly trace: TraceContext;
  readonly telemetry: JsonObject;
  readonly replayPolicy: JsonObject;
  readonly secretExposure: SecretRedactionDecision;
  readonly resourceScope: ResourceScope;
  readonly sandboxRequirements: SandboxRequirement;
  readonly audit: SandboxAuditEvidence;
  readonly createdAt: string;
}

export interface RuntimeKernelRequest {
  readonly capabilityId: CapabilityId;
  readonly input: JsonObject;
  readonly caller: string;
  readonly sessionId?: SessionId;
  readonly turnId?: TurnId;
  readonly agentId?: AgentId;
  readonly parentInvocationId?: string;
  readonly timeoutMs?: number;
  readonly trace?: TraceContext;
}

export interface RuntimeKernelResult extends JsonObject {
  readonly envelope: ExecutionEnvelope;
  readonly status: ExecutionOutcomeStatus;
  readonly output?: JsonObject;
  readonly error?: KernelError;
}

export interface RuntimeKernelLogger {
  debug(message: string, metadata?: JsonObject): void;
  error(message: string, error: KernelError, metadata?: JsonObject): void;
}

export interface RuntimeKernelDependencies {
  readonly bus: RuntimeMessageBus;
  readonly workflow: WorkflowOrchestrator;
  readonly scheduler: ConcurrencyOrchestrator;
  readonly capabilities: CapabilityRegistry;
  readonly policy: PolicyEngine;
  readonly approvals: ApprovalBroker;
  readonly sandbox: SandboxRuntime;
  readonly sessions: SessionStore;
  readonly observability: ObservabilitySink;
  readonly platform: PlatformRuntime;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly logger: RuntimeKernelLogger;
}

export interface RuntimeKernel {
  start(): Promise<void>;
  execute(request: RuntimeKernelRequest): AsyncIterable<RuntimeEvent>;
  cancel(invocationId: string, reason: string): Promise<void>;
  shutdown(reason?: string): Promise<void>;
  state(): RuntimeKernelState;
}

export interface RuntimeRequest extends JsonObject {
  readonly prompt: string;
  readonly sessionId?: SessionId;
  readonly agentId?: AgentId;
}

export type AgentLoopOutputMode = "text" | "json" | "jsonl";
export type AgentLoopTerminalStatus = "completed" | "failed" | "cancelled" | "timed-out" | "rejected";

export interface AgentLoopLimits extends JsonObject {
  readonly maxModelIterations: number;
  readonly maxToolCalls: number;
  readonly turnTimeoutMs: number;
  readonly toolTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxRetries: number;
  readonly maxRepairAttempts: number;
}

export type AgentLoopToolProjection = "none" | "read-only" | "read-write" | "all";

export type AgentLoopProjectRuleSource = "agents-md" | "claude-md" | "host-policy" | "repository-guidance";
export type AgentLoopProjectRuleStatus = "included" | "missing" | "excluded" | "degraded";

export interface AgentLoopProjectRuleEvidence extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly source: AgentLoopProjectRuleSource;
  readonly status: AgentLoopProjectRuleStatus;
  readonly priority: number;
  readonly path?: string;
  readonly content?: string;
  readonly bytes?: number;
  readonly fingerprint?: string;
  readonly diagnostics: readonly RedactedError[];
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export type AgentLoopVerificationExpectationKind = "schema" | "artifact" | "check-command" | "generated-output";

export interface AgentLoopVerificationExpectation extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly kind: AgentLoopVerificationExpectationKind;
  readonly required: boolean;
  readonly description: string;
  readonly path?: string;
  readonly command?: string;
  readonly schema?: JsonObject;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export type AgentLoopOutputContractKind = "json-object" | "json-file" | "file" | "command-plan";
export type AgentLoopOutputContractStatus = "pass" | "fail" | "not_applicable";

export interface AgentLoopOutputContract extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly kind: AgentLoopOutputContractKind;
  readonly required: boolean;
  readonly description?: string;
  readonly path?: string;
  readonly schema?: JsonObject;
  readonly verificationExpectations?: readonly AgentLoopVerificationExpectation[];
  readonly maxParseRetries?: number;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface AgentLoopOutputContractVerification extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly contract: AgentLoopOutputContract;
  readonly status: AgentLoopOutputContractStatus;
  readonly checkedPaths: readonly string[];
  readonly diagnostics: readonly RedactedError[];
  readonly evidenceIds: readonly string[];
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface AgentLoopReferenceContextItem extends JsonObject {
  readonly id: string;
  readonly kind: CliReferenceKind;
  readonly target: CliTargetRef;
  readonly label: string;
  readonly provenance: JsonObject;
  readonly order: number;
  readonly budget?: {
    readonly estimatedTokens?: number;
    readonly bytes?: number;
  };
  readonly redaction: JsonObject;
}

export interface AgentLoopReferenceContextSet extends JsonObject {
  readonly id: string;
  readonly label: string;
  readonly activeItemId?: string;
  readonly items: readonly AgentLoopReferenceContextItem[];
  readonly provenance: JsonObject;
  readonly redaction: JsonObject;
}

export interface AgentLoopReferenceContext extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly source: "cli.palette.references";
  readonly activeSetId?: string;
  readonly activeItemId?: string;
  readonly setCount: number;
  readonly itemCount: number;
  readonly sets: readonly AgentLoopReferenceContextSet[];
  readonly redaction: JsonObject;
}

export interface AgentLoopProfilePolicyMetadata extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly profileId: string;
  readonly role: string;
  readonly workflowGraphId: string;
  readonly workflowPriority: "primary" | "advisory";
  readonly orchestrationMode: "staged-capability-workflow";
  readonly workflowCapabilityIds: readonly string[];
  readonly workflowStages?: readonly AgentLoopProfileWorkflowStageMetadata[];
  readonly stagedTaskWorkflow?: AgentLoopProfileStagedTaskWorkflowMetadata;
  readonly toolProjection?: AgentLoopToolProjection;
  readonly toolProjectionSource: string;
  readonly contextPipelineEnabled?: boolean;
  readonly loopLimits?: JsonObject;
  readonly workflowGateOverride?: AgentLoopProfileWorkflowGateOverride;
  readonly antiTailoring: boolean;
  readonly executionBoundary: string;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface AgentLoopProfileWorkflowGateOverride extends JsonObject {
  readonly gate: string;
  readonly requiredNextAction: string;
  readonly rejectedToolName?: string;
  readonly rejectedCapabilityId?: string;
  readonly terminalKind: string;
  readonly toolCallId: string;
}

export interface AgentLoopProfileStagedTaskWorkflowMetadata extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly profileId: string;
  readonly graphId: string;
  readonly fingerprint: string;
  readonly stageCount: number;
  readonly refCount: number;
  readonly executorKinds: readonly string[];
  readonly graph: StagedTaskGraph;
  readonly runState: StagedTaskRunState;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface AgentLoopProfileWorkflowStageMetadata extends JsonObject {
  readonly id: string;
  readonly objective: string;
  readonly capabilityIds: readonly string[];
  readonly entryCriteria: readonly string[];
  readonly exitCriteria: readonly string[];
}

export interface AgentLoopRequest extends JsonObject {
  readonly prompt: string;
  readonly sessionId?: SessionId;
  readonly agentId?: AgentId;
  readonly interactionMode?: InteractionModeName;
  readonly agentMode?: AgentModeName;
  readonly caller: string;
  readonly workspaceRoot: string;
  readonly outputMode: AgentLoopOutputMode;
  readonly profile: ModelProfile;
  readonly credentialRef?: CredentialRef;
  readonly reasoning?: ModelReasoningOptions;
  readonly reasoningEffortMapping?: AgentReasoningEffortMapping;
  readonly timeoutMs?: number;
  readonly limits?: Partial<AgentLoopLimits>;
  readonly live?: boolean;
  readonly toolProjection?: AgentLoopToolProjection;
  readonly selfRepair?: Partial<SelfRepairConfig>;
  readonly evidenceFirst?: { readonly enabled?: boolean };
  readonly projectRules?: readonly AgentLoopProjectRuleEvidence[];
  readonly outputContract?: AgentLoopOutputContract;
  readonly referenceContext?: AgentLoopReferenceContext;
  readonly trace?: TraceContext;
  readonly contextPipeline?: {
    readonly enabled?: boolean;
  };
  readonly profilePolicy?: AgentLoopProfilePolicyMetadata;
}

export interface AgentLoopControl {
  readonly signal?: AbortSignal;
}

export interface AgentLoopSummary extends JsonObject {
  readonly schemaVersion: string;
  readonly status: AgentLoopTerminalStatus;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly traceId: string;
  readonly assistantText: string;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly interactionMode?: InteractionModeName;
  readonly agentMode?: AgentModeName;
  readonly modeSummary?: AgentModeSessionSummary;
  readonly phasePlan?: AgentPhasePlan;
  readonly interactionModeState?: InteractionModeState;
  readonly interactionModeTransitions?: readonly InteractionModeTransition[];
  readonly reasoningEffortMapping?: AgentReasoningEffortMapping;
  readonly modelProvider?: ModelProviderId;
  readonly modelProfile?: ModelProfileId;
  readonly outputContract?: AgentLoopOutputContractVerification;
  readonly selfRepair?: SelfRepairOutcomeSummary;
  readonly visibleReasoning?: VisibleReasoningProjection;
  readonly taskDeliveryFlow?: JsonObject;
  readonly diagnostics: readonly RedactedError[];
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface RuntimeMemoryCollectionEvidence extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly status: "completed" | "degraded";
  readonly scopes: readonly MemoryScope[];
  readonly scopeCounts: JsonObject;
  readonly candidateCount: number;
  readonly degradedScopes: readonly MemoryScope[];
  readonly permanentMemory?: JsonObject;
  readonly diagnostics: readonly RedactedError[];
  readonly replayFingerprint: string;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface RuntimeCompactBoundaryEvidence extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly fingerprint: string;
  readonly projectionFingerprint: string;
  readonly pressure: "soft" | "hard";
  readonly selectedNodeCount: number;
  readonly excludedNodeCount: number;
  readonly selectedTokens: number;
  readonly excludedTokens: number;
  readonly hardLimitTokens: number;
  readonly softLimitTokens?: number;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface RuntimeToolResultEvidence extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly capabilityId?: string;
  readonly status: ToolFeedbackStatus;
  readonly terminalKind: string;
  readonly previewHash: string;
  readonly previewBytes: number;
  readonly previewTruncated: boolean;
  readonly diagnosticCount: number;
  readonly replayHash: string;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface RuntimeEvent extends JsonObject {
  readonly kind: RuntimeEventKind;
  readonly sessionId: SessionId;
  readonly turnId?: TurnId;
  readonly taskId?: TaskId;
  readonly agentId?: AgentId;
  readonly createdAt: string;
  readonly trace: TraceContext;
  readonly data: JsonObject;
  readonly error?: RedactedError;
}

export interface StartSessionRequest {
  readonly workspaceRoot?: string;
  readonly agentId?: AgentId;
}

export interface RunTurnRequest {
  readonly sessionId?: SessionId;
  readonly prompt: string;
  readonly agentId?: AgentId;
  readonly contextPipeline?: {
    readonly enabled?: boolean;
  };
}

export interface RunAgentLoopRequest extends AgentLoopRequest {}

export interface RuntimeDependencies {
  readonly protocol: ProtocolRouter;
  readonly bus: RuntimeMessageBus;
  readonly workflow: WorkflowOrchestrator;
  readonly concurrency: ConcurrencyOrchestrator;
  readonly agents: AgentManager;
  readonly models: ModelGateway;
  readonly toolIntentPreflight: ToolIntentPreflightService;
  readonly capabilities: CapabilityRegistry;
  readonly commands: CommandSystem;
  readonly skills: SkillSystem;
  readonly hooks: HookSystem;
  readonly mcp: McpGateway;
  readonly plugins: PluginManager;
  readonly extensions: ExtensionManager;
  readonly context: ContextEngine;
  readonly losslessContext?: LosslessContextManager;
  readonly memory: MemoryManager;
  readonly cache: CacheManager;
  readonly credentials: CredentialManager;
  readonly usage: UsageBudgetManager;
  readonly workspaceState: WorkspaceStateManager;
  readonly policy: PolicyEngine;
  readonly approvals: ApprovalBroker;
  readonly sandbox: SandboxRuntime;
  readonly sessions: SessionStore;
  readonly platform: PlatformRuntime;
  readonly evolution: EvolutionEngine;
  readonly codeIntelligence: CodeIntelligenceService;
  readonly remote: RemoteRuntimeConnectivity;
  readonly distribution: DistributionUpdateManager;
  readonly config: ConfigStore;
  readonly observability: ObservabilitySink;
  readonly regression: RegressionHarness;
  readonly promptAssembler?: PromptAssembler;
  readonly webFetch?: import("./core-tools.js").WebFetchProvider;
  readonly webSearch?: import("./core-tools.js").WebSearchProvider;
  readonly backgroundTasks?: import("./core-tools.js").BackgroundTaskManager;
  readonly agentSpawner?: import("./core-tools.js").AgentSpawner;
}

export interface AgentRuntime {
  startSession(request?: StartSessionRequest): Promise<SessionId>;
  runTurn(request: RunTurnRequest): AsyncIterable<RuntimeEvent>;
  interrupt(sessionId: SessionId, reason: string): Promise<void>;
  dispose(): Promise<void>;
}
