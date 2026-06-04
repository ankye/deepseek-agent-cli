import {
  STAGED_TASK_COMPATIBILITY,
  STAGED_TASK_SCHEMA_VERSION,
  type StagedTaskProfileRecord
} from "@deepseek/platform-contracts";

export const webpageGenerationProfile: StagedTaskProfileRecord = {
  schemaVersion: STAGED_TASK_SCHEMA_VERSION,
  profileId: "evaluation/webpage-generation.v1",
  title: "Evaluation Webpage Generation",
  domain: "evaluation",
  source: "catalog",
  scope: "catalog",
  provenance: {
    createdBy: "human",
    reason: "Reusable baseline for live webpage generation evaluation."
  },
  baseProfileId: "base/evidence-grounded-task.v1",
  fragments: [
    "fragment/materialize-workspace.v1",
    "fragment/collect-project-evidence.v1",
    "fragment/agent-produce-artifacts.v1",
    "fragment/process-check.v1",
    "fragment/artifact-scan.v1",
    "fragment/score-task.v1"
  ],
  overlays: ["overlay/live-glm-expanded-budget.v1"],
  parameters: {
    objective: "generate a repository-grounded webpage artifact with checkable evidence"
  },
  compatibility: STAGED_TASK_COMPATIBILITY,
  redaction: { class: "public" }
};
