import type { CliOptions, CliRunOptions } from "../types.js";
import { createCliAgentRuntime } from "../host/runtime.js";
import { resolveCliWorkspaceRoot } from "../host/workspace-root.js";
import { cliAgentProfilePolicyMetadata, resolveCliAgentProfilePolicy, resolveCliModelProfile } from "../host/model-selection.js";
import { collectCliProjectRuleEvidence } from "../host/project-rules.js";
import type { CliTerminalCapabilityProfile } from "../host/terminal-profile.js";
import { emitAgentLoop, finalAgentLoopEvent, renderFinalJsonIfNeeded, resumeHint } from "../renderers/runtime-events.js";
import type { AgentLoopProfilePolicyMetadata, StagedTaskRef, StagedTaskRunState, StagedTaskStageContract, StagedTaskStageState } from "@deepseek/platform-contracts";

export async function runOneShotCommand(
  options: CliOptions,
  write: (line: string) => Promise<void>,
  writeInline: (chunk: string) => Promise<void>,
  bufferedInline: boolean,
  terminalProfile: CliTerminalCapabilityProfile,
  runOptions: CliRunOptions
): Promise<void> {
  const workspaceRoot = await resolveCliWorkspaceRoot(runOptions);
  const profilePolicy = resolveCliAgentProfilePolicy({
    prompt: options.prompt,
    ...(options.toolProjection ? { explicitToolProjection: options.toolProjection } : {})
  });
  const effectiveToolProjection = profilePolicy.toolProjection;
  const runtime = await createCliAgentRuntime({ live: options.live, workspaceRoot, ...(effectiveToolProjection ? { toolProjection: effectiveToolProjection } : {}), ...(options.toolOptIns ? { toolOptIns: options.toolOptIns } : {}), ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}), ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}), ...(options.model ? { model: options.model } : {}) }, runOptions);
  const reasoning = options.reasoning ?? (options.live ? { enabled: false } : undefined);
  const projectRules = await collectCliProjectRuleEvidence(runtime.deps.platform, workspaceRoot);
  const profile = resolveCliModelProfile(options);
  const supervisorWorkflowState = options.supervisorWorkflowStatePath
    ? await readSupervisorWorkflowState(runtime.deps.platform, workspaceRoot, options.supervisorWorkflowStatePath)
    : undefined;
  const additionalUserContext = options.additionalUserContextFile
    ? await readAdditionalUserContext(runtime.deps.platform, workspaceRoot, options.additionalUserContextFile)
    : undefined;
  const baseProfilePolicyMetadata = cliAgentProfilePolicyMetadata(profilePolicy);
  const profilePolicyMetadata = mergeSupervisorWorkflowState(baseProfilePolicyMetadata, supervisorWorkflowState);
  try {
    const events = await emitAgentLoop(runtime.deps, runtime.kernel, {
      prompt: options.prompt,
      outputMode: options.output,
      workspaceRoot,
      caller: "cli.run",
      profile,
      live: options.live,
      ...(reasoning ? { reasoning } : {}),
      projectRules,
      ...(additionalUserContext ? { initialMessages: [{ role: "user", content: additionalUserContext }] } : {}),
      ...(options.outputContract ? { outputContract: options.outputContract } : {}),
      selfRepair: {
        enabled: true,
        maxAttempts: 1,
        requireCheckpointForWrites: true,
        verificationMode: "targeted"
      },
      ...(effectiveToolProjection ? { toolProjection: effectiveToolProjection } : {}),
      ...(options.toolOptIns ? { toolOptIns: options.toolOptIns } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(profilePolicy.contextPipeline ? { contextPipeline: profilePolicy.contextPipeline } : {}),
      profilePolicy: profilePolicyMetadata,
      ...(profilePolicy.limits ? { limits: profilePolicy.limits } : {})
    }, write, writeInline, bufferedInline, undefined, terminalProfile);
    await renderFinalJsonIfNeeded(options.output, events, write);
    if (options.output === "text") {
      const finalSessionId = finalAgentLoopEvent(events)?.sessionId ?? events.at(-1)?.sessionId;
      if (finalSessionId) await write(resumeHint(finalSessionId));
    }
  } finally {
    await runtime.kernel.shutdown("cli-run-completed");
  }
}

function mergeSupervisorWorkflowState(
  policy: AgentLoopProfilePolicyMetadata,
  supervisorWorkflowState: StagedTaskRunState | undefined
): AgentLoopProfilePolicyMetadata {
  if (!supervisorWorkflowState) return policy;
  const workflow = policy.stagedTaskWorkflow;
  if (!workflow) return { ...policy, supervisorWorkflowState };
  const graphStageIds = new Set(workflow.graph.stages.map((stage) => stage.stageId));
  const normalizedStages = supervisorWorkflowState.stageStates
    .map((stage) => normalizeSupervisorStageState(stage, graphStageIds))
    .filter((stage): stage is StagedTaskStageState => stage !== undefined);
  if (normalizedStages.length === 0) return { ...policy, supervisorWorkflowState };
  const supervisorStagesById = new Map(normalizedStages.map((stage) => [stage.stageId, stage]));
  const stageStates = markSupervisorReadyStages(
    workflow.graph.stages,
    workflow.runState.stageStates.map((stage) => supervisorStagesById.get(stage.stageId) ?? stage)
  );
  const normalizedRefs = supervisorWorkflowState.refs.map((ref) => normalizeSupervisorRef(ref, graphStageIds));
  return {
    ...policy,
    supervisorWorkflowState,
    stagedTaskWorkflow: {
      ...workflow,
      runState: {
        ...workflow.runState,
        taskRunId: supervisorWorkflowState.taskRunId,
        stageStates,
        refs: normalizedRefs,
        events: supervisorWorkflowState.events
      }
    }
  };
}

function normalizeSupervisorStageState(
  stage: StagedTaskStageState,
  graphStageIds: ReadonlySet<string>
): StagedTaskStageState | undefined {
  const stageId = normalizeSupervisorStageId(stage.stageId, graphStageIds);
  if (!stageId) return undefined;
  return {
    ...stage,
    stageId,
    inputRefs: stage.inputRefs.map((ref) => normalizeSupervisorRefId(ref)),
    outputRefs: stage.outputRefs.map((ref) => normalizeSupervisorRefId(ref))
  };
}

function normalizeSupervisorRef(ref: StagedTaskRef, graphStageIds: ReadonlySet<string>): StagedTaskRef {
  return {
    ...ref,
    refId: normalizeSupervisorRefId(ref.refId),
    producerStageId: normalizeSupervisorStageId(ref.producerStageId, graphStageIds) ?? ref.producerStageId
  };
}

function normalizeSupervisorStageId(stageId: string, graphStageIds: ReadonlySet<string>): string | undefined {
  if (graphStageIds.has(stageId)) return stageId;
  const prefixed = stageId.startsWith("stage:") ? stageId : `stage:${stageId}`;
  return graphStageIds.has(prefixed) ? prefixed : undefined;
}

function normalizeSupervisorRefId(refId: string): string {
  return refId;
}

function markSupervisorReadyStages(
  graphStages: readonly StagedTaskStageContract[],
  stageStates: readonly StagedTaskStageState[]
): readonly StagedTaskStageState[] {
  const states = new Map(stageStates.map((stage) => [stage.stageId, stage]));
  return stageStates.map((stage) => {
    if (stage.status !== "pending") return stage;
    const contract = graphStages.find((candidate) => candidate.stageId === stage.stageId);
    if (!contract) return stage;
    const dependenciesSatisfied = contract.dependsOn.every((dependencyStageId) => {
      const dependencyStatus = states.get(dependencyStageId)?.status;
      return dependencyStatus === "succeeded" || dependencyStatus === "skipped";
    });
    return dependenciesSatisfied ? { ...stage, status: "ready" } : stage;
  });
}

async function readAdditionalUserContext(
  platform: import("@deepseek/platform-contracts").PlatformRuntime,
  workspaceRoot: string,
  path: string
): Promise<string | undefined> {
  const resolvedPath = platform.resolvePath(workspaceRoot, path);
  const raw = await platform.readFile(resolvedPath);
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function readSupervisorWorkflowState(
  platform: import("@deepseek/platform-contracts").PlatformRuntime,
  workspaceRoot: string,
  path: string
): Promise<StagedTaskRunState | undefined> {
  const resolvedPath = platform.resolvePath(workspaceRoot, path);
  const raw = await platform.readFile(resolvedPath);
  const parsed = JSON.parse(raw) as StagedTaskRunState;
  if (!parsed || parsed.schemaVersion !== "1.0.0" || typeof parsed.taskRunId !== "string" || typeof parsed.graphId !== "string" || typeof parsed.profileId !== "string" || !Array.isArray(parsed.stageStates) || !Array.isArray(parsed.refs) || !Array.isArray(parsed.events)) {
    throw new Error(`Invalid supervisor workflow state: ${path}`);
  }
  return parsed;
}
