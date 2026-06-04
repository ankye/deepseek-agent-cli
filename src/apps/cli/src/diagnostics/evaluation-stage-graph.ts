import type { CliEvaluationStagedTaskSnapshot, CliEvaluationTaskDefinition, StagedTaskGraph } from "@deepseek/platform-contracts";
import { CLI_TASK_EVALUATION_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import { createStagedTaskRunState } from "@deepseek/runtime";
import { compileTaskProfile, webpageGenerationProfile } from "@deepseek/task-profiles";

export function buildEvaluationStageGraph(task: CliEvaluationTaskDefinition): StagedTaskGraph {
  const compiled = compileTaskProfile(webpageGenerationProfile, {
    parameters: {
      taskId: task.taskId,
      category: task.category,
      allowedCapabilityProfile: task.allowedCapabilityProfile,
      promptDigest: task.promptDigest,
      promptSummary: task.promptSummary,
      checkCommands: task.checkCommands,
      timeBudgetMs: task.timeBudgetMs
    }
  });

  return {
    ...compiled.graph,
    metadata: {
      ...compiled.graph.metadata,
      taskId: task.taskId,
      taskCategory: task.category,
      compiledProfileFingerprint: compiled.fingerprint
    }
  };
}

export function buildOptionalEvaluationStagedTaskSnapshot(
  task: CliEvaluationTaskDefinition,
  runId: string
): CliEvaluationStagedTaskSnapshot | undefined {
  return hasEvaluationStageProfile(task)
    ? buildEvaluationStagedTaskSnapshot(task, runId)
    : undefined;
}

export function buildEvaluationStagedTaskSnapshot(
  task: CliEvaluationTaskDefinition,
  runId: string
): CliEvaluationStagedTaskSnapshot {
  const graph = buildEvaluationStageGraph(task);
  const profileFingerprint = String(graph.metadata?.compiledProfileFingerprint ?? "unknown");
  const runState = createStagedTaskRunState(graph, { taskRunId: `staged:${runId}` });
  const executorKinds = [...new Set(graph.stages.map((stage) => stage.executorKind))].sort();
  return {
    schemaVersion: CLI_TASK_EVALUATION_SCHEMA_VERSION,
    profileId: graph.profileId,
    graphId: graph.graphId,
    profileFingerprint,
    stageCount: graph.stages.length,
    refCount: graph.refs.length,
    executorKinds,
    graph,
    runState,
    redaction: {
      class: "internal",
      fields: ["graph.refs.preview", "runState.refs.preview", "runState.stageStates.diagnostics", "profileFingerprint"]
    }
  };
}

function hasEvaluationStageProfile(task: CliEvaluationTaskDefinition): boolean {
  return task.taskId === "eval.webpage.generation" || task.taskId === "eval.webpage.failing-first-repair";
}
