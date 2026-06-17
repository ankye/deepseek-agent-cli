import { defaultDeepSeekProfile, defaultGlmAnthropicProfile } from "@deepseek/model-gateway";
import {
  STAGED_TASK_COMPATIBILITY,
  STAGED_TASK_SCHEMA_VERSION,
  type AgentLoopLimits,
  type AgentLoopProfilePolicyMetadata,
  type AgentLoopProfileStagedTaskWorkflowMetadata,
  type AgentLoopProfileWorkflowStageMetadata,
  type AgentLoopToolProjection,
  type JsonObject,
  type ModelProfile,
  type StagedTaskProfileRecord,
  type StagedTaskStageKind,
  type StagedTaskStagePatch
} from "@deepseek/platform-contracts";
import { createStagedTaskRunState } from "@deepseek/runtime";
import { compileTaskProfile } from "@deepseek/task-profiles";
import type { CliOptions } from "../types.js";

const GLM_EXPANDED_TASK_MAX_TOKENS = 8192;

export const EXPANDED_TASK_AGENT_LOOP_LIMITS = {
  maxModelIterations: 24,
  maxToolCalls: 64,
  maxOutputBytes: 96_000
} as const;

export const SWE_BENCH_AGENT_LOOP_LIMITS = {
  ...EXPANDED_TASK_AGENT_LOOP_LIMITS,
  maxModelIterations: 48,
  maxToolCalls: 96,
  toolTimeoutMs: 600_000
} as const;

export interface CliAgentProfilePolicy {
  readonly id: "coding/general.v1" | "evaluation/swe-bench-lite.v1";
  readonly role: "general-agent" | "evaluation-workflow";
  readonly toolProjection?: AgentLoopToolProjection;
  readonly toolProjectionSource: "default" | "profile" | "user";
  readonly contextPipeline?: {
    readonly enabled: true;
  };
  readonly limits?: Partial<AgentLoopLimits>;
  readonly workflow: {
    readonly graphId: string;
    readonly priority: "primary" | "advisory";
    readonly orchestrationMode: "staged-capability-workflow";
    readonly capabilityIds: readonly string[];
    readonly stages: readonly CliAgentProfileWorkflowStage[];
  };
  readonly governance: {
    readonly antiTailoring: boolean;
    readonly executionBoundary: "governed-capabilities";
  };
}

export interface CliAgentProfileWorkflowStage extends AgentLoopProfileWorkflowStageMetadata {
  readonly id: string;
  readonly objective: string;
  readonly capabilityIds: readonly string[];
  readonly entryCriteria: readonly string[];
  readonly exitCriteria: readonly string[];
}

export interface ResolveCliAgentProfilePolicyOptions {
  readonly prompt: string;
  readonly explicitToolProjection?: AgentLoopToolProjection;
}

export function resolveCliModelProfile(options: Pick<CliOptions, "modelProvider" | "model" | "prompt">, env: Readonly<Record<string, string | undefined>> = {}): ModelProfile {
  const provider = options.modelProvider ?? parseProvider(env.DEEPSEEK_MODEL_PROVIDER ?? env.MODEL_PROVIDER) ?? "deepseek";
  if (provider === "glm") {
    const envMaxTokens = positiveInteger(env.GLM_ANTHROPIC_MAX_TOKENS);
    const expandedMaxTokens = usesExpandedTaskBudget(options.prompt) ? GLM_EXPANDED_TASK_MAX_TOKENS : undefined;
    const maxTokens = envMaxTokens ?? expandedMaxTokens;
    return {
      ...defaultGlmAnthropicProfile,
      model: options.model ?? env.GLM_ANTHROPIC_MODEL ?? defaultGlmAnthropicProfile.model,
      ...(maxTokens ? {
        providerOptions: {
          ...(defaultGlmAnthropicProfile.providerOptions ?? {}),
          max_tokens: maxTokens
        }
      } : {})
    };
  }
  return {
    ...defaultDeepSeekProfile,
    model: options.model ?? env.DEEPSEEK_MODEL ?? defaultDeepSeekProfile.model
  };
}

export function resolveCliAgentLoopLimits(prompt: string): Partial<AgentLoopLimits> | undefined {
  const policy = resolveCliAgentProfilePolicy({ prompt });
  if (policy.limits) return policy.limits;
  return usesExpandedTaskBudget(prompt) ? EXPANDED_TASK_AGENT_LOOP_LIMITS : undefined;
}

export function resolveCliAgentProfilePolicy(options: ResolveCliAgentProfilePolicyOptions): CliAgentProfilePolicy {
  const lowerPrompt = options.prompt.toLowerCase();
  if (isSweBenchPrompt(lowerPrompt)) {
    const workflow = isManagedSweBenchChildPrompt(lowerPrompt)
      ? sweBenchChildWorkflow()
      : sweBenchDispatchWorkflow();
    return {
      id: "evaluation/swe-bench-lite.v1",
      role: "evaluation-workflow",
      toolProjection: options.explicitToolProjection ?? "all",
      toolProjectionSource: options.explicitToolProjection ? "user" : "profile",
      contextPipeline: { enabled: true },
      limits: SWE_BENCH_AGENT_LOOP_LIMITS,
      workflow,
      governance: {
        antiTailoring: true,
        executionBoundary: "governed-capabilities"
      }
    };
  }
  return {
    id: "coding/general.v1",
    role: "general-agent",
    toolProjectionSource: options.explicitToolProjection ? "user" : "default",
    ...(options.explicitToolProjection ? { toolProjection: options.explicitToolProjection } : {}),
    workflow: {
      graphId: "workflow/coding.general.v1",
      priority: "primary",
      orchestrationMode: "staged-capability-workflow",
      capabilityIds: [
        "core.file.read",
        "core.file.list",
        "core.file.write",
        "core.file.edit",
        "core.patch.apply",
        "core.search.text",
        "core.workspace.glob",
        "core.shell.run",
        "core.git.diff",
        "core.test.run"
      ],
      stages: [
        {
          id: "understand",
          objective: "Gather enough repository evidence to choose a scoped path.",
          capabilityIds: ["core.file.read", "core.file.list", "core.search.text", "core.workspace.glob"],
          entryCriteria: ["user request is available"],
          exitCriteria: ["relevant files or missing information identified"]
        },
        {
          id: "change",
          objective: "Make the smallest useful change through governed capabilities.",
          capabilityIds: ["core.file.read", "core.file.write", "core.file.edit", "core.patch.apply", "core.shell.run"],
          entryCriteria: ["relevant files or missing information identified"],
          exitCriteria: ["change applied or blocker recorded"]
        },
        {
          id: "verify",
          objective: "Collect proof before reporting completion.",
          capabilityIds: ["core.test.run", "core.git.diff"],
          entryCriteria: ["change applied or blocker recorded"],
          exitCriteria: ["verification evidence or residual risk recorded"]
        }
      ]
    },
    governance: {
      antiTailoring: false,
      executionBoundary: "governed-capabilities"
    }
  };
}

function sweBenchDispatchWorkflow(): CliAgentProfilePolicy["workflow"] {
  return {
    graphId: "workflow/evaluation.swe-bench-lite.v1",
    priority: "primary",
    orchestrationMode: "staged-capability-workflow",
    capabilityIds: ["core.swe.bench.run"],
    stages: [
      {
        id: "dispatch",
        objective: "Dispatch the numbered user request to the governed SWE-bench run capability. Do not call core.env.prepare in the parent dispatch loop; environment preparation belongs inside the managed child run created by core.swe.bench.run.",
        capabilityIds: ["core.swe.bench.run"],
        entryCriteria: ["user-level SWE-bench request is available"],
        exitCriteria: ["governed harness result or classified blocker recorded"]
      }
    ]
  };
}

function sweBenchChildWorkflow(): CliAgentProfilePolicy["workflow"] {
  return {
    graphId: "workflow/evaluation.swe-bench-lite.child.v1",
    priority: "primary",
    orchestrationMode: "staged-capability-workflow",
    capabilityIds: [
      "core.env.prepare",
      "core.file.read",
      "core.file.list",
      "core.file.write",
      "core.file.edit",
      "core.patch.apply",
      "core.search.text",
      "core.workspace.glob",
      "core.shell.run",
      "core.test.run",
      "core.git.diff"
    ],
    stages: [
      {
        id: "understand",
        objective: "Collect repository, problem, and test-entry evidence before editing.",
        capabilityIds: ["core.env.prepare", "core.file.read", "core.file.list", "core.search.text", "core.workspace.glob"],
        entryCriteria: ["workspace is available"],
        exitCriteria: ["repository and problem evidence collected", "relevant files identified"]
      },
      {
        id: "change",
        objective: "Apply the smallest general source change that follows repository rules.",
        capabilityIds: ["core.file.read", "core.file.write", "core.file.edit", "core.patch.apply", "core.shell.run"],
        entryCriteria: ["relevant files identified"],
        exitCriteria: ["minimal source changes applied", "no benchmark-instance tailoring introduced"]
      },
      {
        id: "verify",
        objective: "Run focused tests and inspect the patch before returning control to the governed harness.",
        capabilityIds: ["core.test.run", "core.shell.run", "core.git.diff"],
        entryCriteria: ["minimal source changes applied"],
        exitCriteria: ["focused regression evidence collected", "patch diff reviewed"]
      }
    ]
  };
}

export function cliAgentProfilePolicyMetadata(policy: CliAgentProfilePolicy): AgentLoopProfilePolicyMetadata {
  const stagedTaskWorkflow = compileCliProfileWorkflow(policy);
  return {
    schemaVersion: "1.0.0",
    profileId: policy.id,
    role: policy.role,
    workflowGraphId: policy.workflow.graphId,
    workflowPriority: policy.workflow.priority,
    orchestrationMode: policy.workflow.orchestrationMode,
    workflowCapabilityIds: policy.workflow.capabilityIds,
    workflowStages: policy.workflow.stages,
    stagedTaskWorkflow,
    ...(policy.toolProjection ? { toolProjection: policy.toolProjection } : {}),
    toolProjectionSource: policy.toolProjectionSource,
    ...(policy.contextPipeline ? { contextPipelineEnabled: policy.contextPipeline.enabled } : {}),
    ...(policy.limits ? { loopLimits: policy.limits } : {}),
    antiTailoring: policy.governance.antiTailoring,
    executionBoundary: policy.governance.executionBoundary,
    redaction: { class: "internal" }
  };
}

function compileCliProfileWorkflow(policy: CliAgentProfilePolicy): AgentLoopProfileStagedTaskWorkflowMetadata {
  const profile: StagedTaskProfileRecord = {
    schemaVersion: STAGED_TASK_SCHEMA_VERSION,
    profileId: policy.id,
    title: `${policy.role} workflow`,
    domain: policy.role,
    source: "dynamic",
    scope: "task-run",
    provenance: {
      createdBy: "controller",
      reason: "Compile CLI profile workflow role into replayable staged-task metadata.",
      taskIntentFingerprint: policy.workflow.graphId
    },
    fragments: [],
    overlays: [],
    stagePatches: workflowStagePatches(policy.workflow.stages),
    parameters: {
      workflowGraphId: policy.workflow.graphId,
      workflowPriority: policy.workflow.priority,
      orchestrationMode: policy.workflow.orchestrationMode,
      role: policy.role,
      executionBoundary: policy.governance.executionBoundary,
      antiTailoring: policy.governance.antiTailoring
    },
    compatibility: STAGED_TASK_COMPATIBILITY,
    redaction: { class: "internal", fields: ["provenance.reason", "parameters"] }
  };
  const compiled = compileTaskProfile(profile);
  const runState = createStagedTaskRunState(compiled.graph, { taskRunId: `staged:${compiled.graph.graphId}` });
  const executorKinds = [...new Set(compiled.graph.stages.map((stage) => stage.executorKind))].sort();
  return {
    schemaVersion: "1.0.0",
    profileId: compiled.profileId,
    graphId: compiled.graph.graphId,
    fingerprint: compiled.fingerprint,
    stageCount: compiled.graph.stages.length,
    refCount: compiled.graph.refs.length,
    executorKinds,
    graph: compiled.graph,
    runState,
    redaction: {
      class: "internal",
      fields: ["graph.refs.preview", "runState.refs.preview", "runState.stageStates.diagnostics", "fingerprint"]
    }
  };
}

function workflowStagePatches(stages: readonly CliAgentProfileWorkflowStage[]): readonly StagedTaskStagePatch[] {
  return stages.map((stage, index) => {
    const stageToken = workflowStageToken(stage.id);
    const previousStage = stages[index - 1];
    const previousToken = previousStage ? workflowStageToken(previousStage.id) : "";
    const expectedOutputRef = workflowStageEvidenceRef(stageToken);
    const inputRefs = previousStage ? [workflowStageEvidenceRef(previousToken)] : [];
    return {
      stageId: `stage:${stageToken}`,
      kind: workflowStageKind(stage, index, stages.length),
      executorKind: "agent-loop",
      dependsOn: previousStage ? [`stage:${previousToken}`] : [],
      inputRefs,
      expectedOutputRefs: [expectedOutputRef],
      allowedTools: stage.capabilityIds,
      parameters: {
        workflowStageId: stage.id,
        objective: stage.objective,
        entryCriteria: stage.entryCriteria,
        exitCriteria: stage.exitCriteria
      } satisfies JsonObject
    };
  });
}

function workflowStageEvidenceRef(stageToken: string): string {
  return `ref:workflow-${stageToken}-evidence`;
}

function workflowStageKind(stage: CliAgentProfileWorkflowStage, index: number, total: number): StagedTaskStageKind {
  if (stage.id === "understand" || index === 0) return "collect-evidence";
  if (stage.id === "verify") return "verify";
  if (stage.id === "submit" || index === total - 1) return "synthesize";
  return "produce";
}

function workflowStageToken(value: string): string {
  const token = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return token || "stage";
}

export function usesExpandedTaskBudget(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return (
    lower.includes("evaluation task id:") ||
    isSweBenchPrompt(lower) ||
    lower.includes("website") ||
    lower.includes("webpage") ||
    lower.includes("html") ||
    lower.includes("网页") ||
    lower.includes("网站") ||
    lower.includes("页面")
  );
}

export function usesSweBenchProfile(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return isSweBenchPrompt(lower);
}

function isSweBenchPrompt(lower: string): boolean {
  return (
    lower.includes("swe-bench") ||
    lower.includes("swebench") ||
    lower.includes("swe bench")
  );
}

function isManagedSweBenchChildPrompt(lower: string): boolean {
  return lower.includes("managed swe-bench execution profile:");
}

function parseProvider(value: string | undefined): "deepseek" | "glm" | undefined {
  return value === "deepseek" || value === "glm" ? value : undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
