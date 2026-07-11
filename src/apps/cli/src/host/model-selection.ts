import { defaultDeepSeekProfile, defaultGlmAnthropicProfile } from "@deepseek/model-gateway";
import { coreCapabilityFamilyMappings } from "@deepseek/core-coding-tools";
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
  type StagedTaskStagePatch,
  type ToolFamilyId
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
  toolTimeoutMs: 600_000,
  stageBudgets: [
    {
      stageId: "stage:understand",
      maxModelIterations: 8,
      maxToolCalls: 20,
      stopReason: "swe-bench-child-stage-understand-budget"
    },
    {
      stageId: "stage:change",
      maxModelIterations: 16,
      maxToolCalls: 36,
      stopReason: "swe-bench-child-stage-change-budget"
    },
    {
      stageId: "stage:verify",
      maxModelIterations: 12,
      maxToolCalls: 28,
      stopReason: "swe-bench-child-stage-verify-budget"
    }
  ]
} as const;

export interface CliAgentProfilePolicy {
  readonly id: "coding/general.v1" | "analysis/read-only.v1" | "engineering/coding.v1" | "evaluation/swe-bench-lite.v1";
  readonly role: "general-agent" | "analysis-agent" | "engineering-agent" | "evaluation-workflow";
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
    readonly workflowGovernanceMode: "standard" | "evaluation";
    readonly stageAcceptanceMode: "automatic" | "supervisor";
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
      toolProjection: options.explicitToolProjection ?? "safe-all",
      toolProjectionSource: options.explicitToolProjection ? "user" : "profile",
      contextPipeline: { enabled: true },
      limits: SWE_BENCH_AGENT_LOOP_LIMITS,
      workflow,
      governance: {
        antiTailoring: true,
        executionBoundary: "governed-capabilities",
        workflowGovernanceMode: "evaluation",
        stageAcceptanceMode: "supervisor"
      }
    };
  }
  if (isReadOnlyAnalysisPrompt(lowerPrompt)) {
    return {
      id: "analysis/read-only.v1",
      role: "analysis-agent",
      toolProjection: options.explicitToolProjection ?? "safe-all",
      toolProjectionSource: options.explicitToolProjection ? "user" : "profile",
      contextPipeline: { enabled: true },
      limits: EXPANDED_TASK_AGENT_LOOP_LIMITS,
      workflow: readOnlyAnalysisWorkflow(),
      governance: {
        antiTailoring: false,
        executionBoundary: "governed-capabilities",
        workflowGovernanceMode: "standard",
        stageAcceptanceMode: "automatic"
      }
    };
  }
  if (isEngineeringExecutionPrompt(lowerPrompt)) {
    return {
      id: "engineering/coding.v1",
      role: "engineering-agent",
      toolProjection: options.explicitToolProjection ?? "safe-all",
      toolProjectionSource: options.explicitToolProjection ? "user" : "profile",
      contextPipeline: { enabled: true },
      limits: EXPANDED_TASK_AGENT_LOOP_LIMITS,
      workflow: engineeringCodingWorkflow(),
      governance: {
        antiTailoring: false,
        executionBoundary: "governed-capabilities",
        workflowGovernanceMode: "standard",
        stageAcceptanceMode: "automatic"
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
      priority: "advisory",
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
      executionBoundary: "governed-capabilities",
      workflowGovernanceMode: "standard",
      stageAcceptanceMode: "automatic"
    }
  };
}

function readOnlyAnalysisWorkflow(): CliAgentProfilePolicy["workflow"] {
  return {
    graphId: "workflow/analysis.read-only.v1",
    priority: "primary",
    orchestrationMode: "staged-capability-workflow",
    capabilityIds: [
      "core.file.read",
      "core.file.list",
      "core.search.text",
      "core.workspace.glob",
      "core.git.diff"
    ],
    stages: [
      {
        id: "evidence",
        objective: "Collect bounded repository and specification evidence without changing workspace state.",
        capabilityIds: ["core.file.read", "core.file.list", "core.search.text", "core.workspace.glob", "core.git.diff"],
        entryCriteria: ["read-only analysis request is available"],
        exitCriteria: ["relevant repository or specification evidence identified", "root cause, boundary, or residual unknown recorded"]
      },
      {
        id: "report",
        objective: "Return a bounded analysis with evidence and next actions without claiming changes were made.",
        capabilityIds: ["core.file.read", "core.git.diff"],
        entryCriteria: ["analysis evidence recorded"],
        exitCriteria: ["bounded read-only report produced"]
      }
    ]
  };
}

function engineeringCodingWorkflow(): CliAgentProfilePolicy["workflow"] {
  return {
    graphId: "workflow/engineering.coding.v1",
    priority: "primary",
    orchestrationMode: "staged-capability-workflow",
    capabilityIds: [
      "core.file.read",
      "core.file.list",
      "core.search.text",
      "core.workspace.glob",
      "core.shell.run",
      "core.test.run",
      "core.file.write",
      "core.file.edit",
      "core.text.replace",
      "core.file.copy",
      "core.file.move",
      "core.file.delete",
      "core.directory.create",
      "core.file.touch",
      "core.json.patch",
      "core.archive.create",
      "core.archive.extract",
      "core.revert.undo",
      "core.patch.apply",
      "core.git.diff"
    ],
    stages: [
      {
        id: "understand",
        objective: "Collect local repository evidence, constraints, and relevant files before choosing a change path.",
        capabilityIds: ["core.file.read", "core.file.list", "core.search.text", "core.workspace.glob", "core.shell.run"],
        entryCriteria: ["execution-bearing engineering request is available"],
        exitCriteria: ["relevant files, constraints, or typed blocker identified"]
      },
      {
        id: "plan",
        objective: "State a scoped implementation path and acceptance criteria grounded in collected evidence.",
        capabilityIds: ["core.file.read", "core.search.text", "core.git.diff"],
        entryCriteria: ["repository evidence or typed blocker identified"],
        exitCriteria: [
          "implementation path, test plan, or blocker recorded",
          "regression test plan covers the observed failure plus boundary and negative cases implied by the contract"
        ]
      },
      {
        id: "implement",
        objective: "Apply the smallest governed workspace change that satisfies the scoped plan, including focused test materialization when practical.",
        capabilityIds: [
          "core.file.read",
          "core.file.write",
          "core.file.edit",
          "core.text.replace",
          "core.file.copy",
          "core.file.move",
          "core.file.delete",
          "core.directory.create",
          "core.file.touch",
          "core.json.patch",
          "core.archive.create",
          "core.archive.extract",
          "core.revert.undo",
          "core.patch.apply",
          "core.shell.run"
        ],
        entryCriteria: ["implementation path, test plan, or no-practical-test rationale recorded"],
        exitCriteria: [
          "focused regression coverage materialized before implementation for the observed failure and edge cases when practical",
          "material change applied or implementation blocker recorded"
        ]
      },
      {
        id: "verify",
        objective: "Run focused verification and inspect the resulting diff before reporting completion.",
        capabilityIds: ["core.test.run", "core.shell.run", "core.git.diff", "core.file.read"],
        entryCriteria: ["material change applied or implementation blocker recorded"],
        exitCriteria: [
          "verification result covers happy path, boundary, and negative regression cases before completion when applicable",
          "verification result, diff review, or residual risk recorded"
        ]
      },
      {
        id: "report",
        objective: "Return outcome, evidence, residual risks, and next blocker without inventing unverified success.",
        capabilityIds: ["core.git.diff", "core.file.read"],
        entryCriteria: ["verification result or residual risk recorded"],
        exitCriteria: ["bounded outcome report produced"]
      }
    ]
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
      "core.file.read",
      "core.file.list",
      "core.file.write",
      "core.file.edit",
      "core.patch.apply",
      "core.search.text",
      "core.workspace.glob",
      "core.shell.run",
      "core.test.run",
      "core.git.diff",
      "core.swe.harness.run",
      "core.swe.prediction.write"
    ],
    stages: [
      {
        id: "understand",
        objective: "Collect repository, problem, and test-entry evidence before editing.",
        capabilityIds: ["core.file.read", "core.file.list", "core.search.text", "core.workspace.glob"],
        entryCriteria: ["supervisor-prepared checkout is available"],
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
      },
      {
        id: "score",
        objective: "Run the governed SWE harness when local verification evidence is ready.",
        capabilityIds: ["core.swe.harness.run"],
        entryCriteria: ["focused regression evidence collected"],
        exitCriteria: ["governed harness result or typed blocker recorded"]
      },
      {
        id: "package",
        objective: "Write the SWE prediction artifact after patch and harness evidence are available.",
        capabilityIds: ["core.swe.prediction.write", "core.git.diff"],
        entryCriteria: ["patch diff reviewed"],
        exitCriteria: ["prediction artifact written"]
      }
    ]
  };
}

export function cliAgentProfilePolicyMetadata(policy: CliAgentProfilePolicy): AgentLoopProfilePolicyMetadata {
  const stagedTaskWorkflow = policy.workflow.priority === "primary"
    ? compileCliProfileWorkflow(policy)
    : undefined;
  const compiler = compileCapabilityAffordances(policy);
  return {
    schemaVersion: "1.0.0",
    profileId: policy.id,
    role: policy.role,
    workflowGraphId: policy.workflow.graphId,
    workflowPriority: policy.workflow.priority,
    orchestrationMode: policy.workflow.orchestrationMode,
    workflowCapabilityIds: policy.workflow.capabilityIds,
    workflowStages: policy.workflow.stages,
    requiredFamilyIds: compiler.requiredFamilyIds,
    capabilityAffordanceCompiler: compiler,
    ...(stagedTaskWorkflow ? { stagedTaskWorkflow } : {}),
    ...(policy.toolProjection ? { toolProjection: policy.toolProjection } : {}),
    toolProjectionSource: policy.toolProjectionSource,
    ...(policy.contextPipeline ? { contextPipelineEnabled: policy.contextPipeline.enabled } : {}),
    ...(policy.limits ? { loopLimits: policy.limits } : {}),
    workflowGovernanceMode: policy.governance.workflowGovernanceMode,
    stageAcceptanceMode: policy.governance.stageAcceptanceMode,
    antiTailoring: policy.governance.antiTailoring,
    executionBoundary: policy.governance.executionBoundary,
    redaction: { class: "internal" }
  };
}

function compileCapabilityAffordances(policy: CliAgentProfilePolicy): JsonObject {
  const familyByCapabilityId = capabilityFamilyMap();
  const resolved = policy.workflow.capabilityIds
    .map((capabilityId) => ({
      capabilityId,
      familyId: familyByCapabilityId.get(capabilityId)
    }));
  const requiredFamilyIds = uniqueSorted(resolved
    .map((item) => item.familyId)
    .filter((familyId): familyId is ToolFamilyId => familyId !== undefined));
  const missingCapabilityIds = uniqueSorted(resolved
    .filter((item) => item.familyId === undefined)
    .map((item) => item.capabilityId));
  return {
    schemaVersion: "1.0.0",
    compilerId: "cli.profile.capability-affordance.compiler.v1",
    status: missingCapabilityIds.length === 0 ? "ready" : "blocked-by-cli-capability-gap",
    profileId: policy.id,
    workflowGraphId: policy.workflow.graphId,
    requiredFamilyIds,
    resolvedCapabilityIds: uniqueSorted(policy.workflow.capabilityIds),
    missingCapabilityIds,
    projectionStatus: missingCapabilityIds.length === 0 ? "ready" : "blocked",
    source: "core-coding-tools.catalog",
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
      antiTailoring: policy.governance.antiTailoring,
      workflowGovernanceMode: policy.governance.workflowGovernanceMode,
      stageAcceptanceMode: policy.governance.stageAcceptanceMode
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
  const familyByCapabilityId = capabilityFamilyMap();
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
        exitCriteria: stage.exitCriteria,
        requiredFamilyIds: familyIdsForCapabilities(stage.capabilityIds, familyByCapabilityId),
        ...(stage.id === "understand" ? { requireNonHeaderSourceWindow: true } : {})
      } satisfies JsonObject
    };
  });
}

function capabilityFamilyMap(): Map<string, ToolFamilyId> {
  return new Map(coreCapabilityFamilyMappings()
    .map((mapping) => [String(mapping.capabilityId), mapping.familyId as ToolFamilyId]));
}

function familyIdsForCapabilities(
  capabilityIds: readonly string[],
  familyByCapabilityId: ReadonlyMap<string, ToolFamilyId>
): readonly ToolFamilyId[] {
  return uniqueSorted(capabilityIds
    .map((capabilityId) => familyByCapabilityId.get(capabilityId))
    .filter((familyId): familyId is ToolFamilyId => familyId !== undefined));
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort();
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

function isReadOnlyAnalysisPrompt(lower: string): boolean {
  const hasReadOnlyConstraint = [
    "只读",
    "只读取",
    "不要修改",
    "不修改",
    "不要写",
    "不要写入",
    "不要编辑",
    "no changes",
    "read-only",
    "readonly",
    "do not modify",
    "don't modify",
    "do not edit",
    "don't edit",
    "do not write",
    "don't write"
  ].some((marker) => lower.includes(marker));
  if (!hasReadOnlyConstraint) return false;
  return [
    "分析",
    "检查",
    "定位",
    "梳理",
    "看看",
    "review",
    "inspect",
    "analyze",
    "analyse",
    "diagnose"
  ].some((marker) => lower.includes(marker));
}

function isEngineeringExecutionPrompt(lower: string): boolean {
  return [
    "fix",
    "修复",
    "implement",
    "实现",
    "modify",
    "修改",
    "debug",
    "调试",
    "test",
    "测试",
    "verify",
    "验证",
    "refactor",
    "重构",
    "review",
    "审查",
    "检查",
    "跑测试",
    "补测试",
    "架构",
    "openspec",
    "代码",
    "仓库",
    "repo",
    "cli",
    "runtime",
    "调度",
    "工作流"
  ].some((marker) => lower.includes(marker));
}

function parseProvider(value: string | undefined): "deepseek" | "glm" | undefined {
  return value === "deepseek" || value === "glm" ? value : undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
