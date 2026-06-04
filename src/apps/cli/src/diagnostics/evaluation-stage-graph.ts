import type { CliEvaluationTaskDefinition, StagedTaskGraph } from "@deepseek/platform-contracts";
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
