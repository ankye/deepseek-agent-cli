import {
  STAGED_TASK_COMPATIBILITY,
  STAGED_TASK_SCHEMA_VERSION,
  type StagedTaskProfileRecord,
  type StagedTaskExecutorKind,
  type StagedTaskStageKind,
  type StagedTaskStagePatch,
  type ToolFamilyId
} from "@deepseek/platform-contracts";

const understandFamilies = [
  "file.read",
  "file.list",
  "file.stat",
  "json.read",
  "path.resolve",
  "workspace.glob",
  "search.text",
  "search.symbol",
  "code.diagnostics-lsp",
  "git.status-diff",
  "context.project-index"
] as const satisfies readonly ToolFamilyId[];

const planFamilies = [
  "plan.todo",
  "file.read",
  "search.text",
  "git.status-diff",
  "build.test-lint-typecheck",
  "package.manager"
] as const satisfies readonly ToolFamilyId[];

const changeFamilies = [
  "file.write",
  "file.edit",
  "file.copy",
  "file.move",
  "file.delete",
  "directory.create",
  "file.touch",
  "json.patch",
  "patch.apply",
  "revert.undo",
  "shell.run",
  "process.output",
  "git.status-diff"
] as const satisfies readonly ToolFamilyId[];

const verifyFamilies = [
  "shell.run",
  "process.output",
  "code.diagnostics-lsp",
  "build.test-lint-typecheck",
  "package.manager",
  "git.status-diff"
] as const satisfies readonly ToolFamilyId[];

const reportFamilies = [
  "git.status-diff",
  "observability.trace-budget",
  "plan.todo"
] as const satisfies readonly ToolFamilyId[];

function stageContract(input: {
  readonly stageId: string;
  readonly kind: StagedTaskStageKind;
  readonly executorKind: StagedTaskExecutorKind;
  readonly dependsOn: readonly string[];
  readonly inputRefs: readonly string[];
  readonly expectedOutputRefs: readonly string[];
  readonly families: readonly ToolFamilyId[];
  readonly successCriteria: readonly string[];
  readonly fallbackBlockerCriteria: readonly string[];
  readonly maxModelIterations?: number;
  readonly maxToolCalls?: number;
}): StagedTaskStagePatch {
  return {
    stageId: input.stageId,
    kind: input.kind,
    executorKind: input.executorKind,
    dependsOn: input.dependsOn,
    inputRefs: input.inputRefs,
    expectedOutputRefs: input.expectedOutputRefs,
    allowedTools: input.families,
    budget: {
      maxModelIterations: input.maxModelIterations ?? 8,
      maxToolCalls: input.maxToolCalls ?? 32,
      maxOutputBytes: 200_000,
      timeoutMs: 600_000
    },
    acceptance: {
      requiredRefs: input.expectedOutputRefs,
      requiredStatuses: ["succeeded"]
    },
    retryPolicy: {
      maxAttempts: 1,
      retryOn: ["missing-required-evidence", "stage-tool-family-unavailable"]
    },
    parameters: {
      requiredFamilyIds: input.families,
      successCriteria: input.successCriteria,
      requiredEvidenceRefs: input.expectedOutputRefs,
      fallbackBlockerCriteria: input.fallbackBlockerCriteria,
      decisionBoardProjection: {
        profileId: "engineering/software-engineer.v1",
        stageId: input.stageId,
        requiredFamilyIds: input.families
      }
    },
    redaction: { class: "internal", fields: ["parameters.successCriteria", "parameters.fallbackBlockerCriteria"] }
  };
}

export const softwareEngineerProfile: StagedTaskProfileRecord = {
  schemaVersion: STAGED_TASK_SCHEMA_VERSION,
  profileId: "engineering/software-engineer.v1",
  title: "Software Engineer",
  domain: "engineering",
  source: "catalog",
  scope: "catalog",
  provenance: {
    createdBy: "human",
    reason: "Reusable staged workflow for repository-grounded software engineering tasks."
  },
  fragments: [],
  overlays: [],
  parameters: {
    objective: "complete repository-grounded engineering work through evidence-backed stages",
    aliases: ["software-engineer"]
  },
  stagePatches: [
    stageContract({
      stageId: "stage:understand",
      kind: "collect-evidence",
      executorKind: "agent-loop",
      dependsOn: [],
      inputRefs: ["ref:workspace-root"],
      expectedOutputRefs: ["ref:engineering-understanding"],
      families: understandFamilies,
      successCriteria: [
        "Identify the relevant files, contracts, tests, commands, and constraints before proposing changes.",
        "Record evidence refs for inspected project context rather than relying on task text alone."
      ],
      fallbackBlockerCriteria: [
        "Required read/search capability is unavailable or hidden without projection reason.",
        "Workspace root or project context cannot be resolved."
      ],
      maxModelIterations: 6,
      maxToolCalls: 24
    }),
    stageContract({
      stageId: "stage:plan",
      kind: "synthesize",
      executorKind: "agent-loop",
      dependsOn: ["stage:understand"],
      inputRefs: ["ref:engineering-understanding"],
      expectedOutputRefs: ["ref:engineering-plan"],
      families: planFamilies,
      successCriteria: [
        "Produce a task-sized implementation plan tied to the inspected evidence.",
        "Name the verification commands or contract checks that will prove the change.",
        "For bug fixes, design regression coverage for the observed failure plus boundary and negative cases implied by the contract."
      ],
      fallbackBlockerCriteria: [
        "A safe plan cannot be formed from available evidence.",
        "Required planning or verification family is unavailable for the active profile."
      ],
      maxModelIterations: 4,
      maxToolCalls: 16
    }),
    stageContract({
      stageId: "stage:change",
      kind: "produce",
      executorKind: "agent-loop",
      dependsOn: ["stage:plan"],
      inputRefs: ["ref:engineering-plan"],
      expectedOutputRefs: ["ref:engineering-change"],
      families: changeFamilies,
      successCriteria: [
        "Apply the planned code or configuration change through governed mutation tools.",
        "Materialize focused regression coverage before implementation when practical, covering the observed failure and relevant edge cases.",
        "Preserve checkpoints or reversible evidence for workspace mutations."
      ],
      fallbackBlockerCriteria: [
        "Required mutation family is unavailable or policy-denied without corrective guidance.",
        "The requested change would destroy evidence or unrelated user work."
      ],
      maxModelIterations: 12,
      maxToolCalls: 96
    }),
    stageContract({
      stageId: "stage:verify",
      kind: "verify",
      executorKind: "agent-loop",
      dependsOn: ["stage:change"],
      inputRefs: ["ref:engineering-change"],
      expectedOutputRefs: ["ref:engineering-verification"],
      families: verifyFamilies,
      successCriteria: [
        "Run focused tests, type checks, linters, or equivalent deterministic validation for the change.",
        "Confirm verification evidence covers happy path, boundary, and negative regression cases before claiming the repair is complete when applicable.",
        "Classify failures as implementation, missing tool, environment, or model-planning issues."
      ],
      fallbackBlockerCriteria: [
        "Required verification family is unavailable or connector-backed execution is blocked.",
        "Validation cannot run because prerequisites are missing from the workspace."
      ],
      maxModelIterations: 8,
      maxToolCalls: 48
    }),
    stageContract({
      stageId: "stage:report",
      kind: "synthesize",
      executorKind: "agent-loop",
      dependsOn: ["stage:verify"],
      inputRefs: ["ref:engineering-verification"],
      expectedOutputRefs: ["ref:engineering-report"],
      families: reportFamilies,
      successCriteria: [
        "Summarize changed surfaces, evidence, verification outcome, and remaining risk.",
        "Do not claim completion when required evidence refs are missing."
      ],
      fallbackBlockerCriteria: [
        "Verification evidence is missing or contradicts the completion claim.",
        "Trace or budget evidence required by the profile is unavailable."
      ],
      maxModelIterations: 4,
      maxToolCalls: 12
    })
  ],
  compatibility: STAGED_TASK_COMPATIBILITY,
  redaction: { class: "public" }
};
