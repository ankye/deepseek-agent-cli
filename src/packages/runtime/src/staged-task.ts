import {
  STAGED_TASK_COMPATIBILITY,
  STAGED_TASK_SCHEMA_VERSION,
  type JsonObject,
  type RedactedError,
  type StagedTaskExecutionResult,
  type StagedTaskExecutorKind,
  type StagedTaskGraph,
  type StagedTaskRef,
  type StagedTaskRunState,
  type StagedTaskEvaluationResult,
  type StagedTaskStageContract,
  type StagedTaskStageEvent,
  type StagedTaskStageState,
  type StagedTaskStageStatus,
  type StagedTaskTechnicalDirectorAcceptance,
  type ValidationResult
} from "@deepseek/platform-contracts";

export interface CreateStagedTaskRunStateOptions {
  readonly taskRunId: string;
}

export interface ReplayStagedTaskRunOptions {
  readonly taskRunId: string;
}

export interface StageExecutionContext extends JsonObject {
  readonly taskRunId: string;
  readonly graphId: string;
  readonly profileId: string;
  readonly inputRefs: readonly StagedTaskRef[];
  readonly expectedOutputRefIds: readonly string[];
}

export interface StageExecutor {
  readonly kind: StagedTaskExecutorKind;
  run(
    stage: StagedTaskStageContract,
    context: StageExecutionContext
  ): Promise<StagedTaskExecutionResult> | StagedTaskExecutionResult;
}

export interface RunReadyStageOptions {
  readonly executors: readonly StageExecutor[];
  readonly now?: () => string;
}

export interface RunReadyStageResult {
  readonly state: StagedTaskRunState;
  readonly events: readonly StagedTaskStageEvent[];
  readonly result?: StagedTaskExecutionResult;
}

export function validateStagedTaskGraph(graph: StagedTaskGraph): ValidationResult {
  const errors: RedactedError[] = [];
  const stageIds = new Set<string>();
  const outputRefs = new Set<string>();

  for (const stage of graph.stages) {
    if (stageIds.has(stage.stageId)) {
      errors.push(diagnostic("STAGED_TASK_DUPLICATE_STAGE", `Duplicate stage id: ${stage.stageId}`));
    }
    stageIds.add(stage.stageId);
    for (const refId of stage.expectedOutputRefs) {
      if (outputRefs.has(refId)) {
        errors.push(diagnostic("STAGED_TASK_DUPLICATE_REF", `Duplicate output ref id: ${refId}`));
      }
      outputRefs.add(refId);
    }
  }

  for (const stage of graph.stages) {
    for (const dependency of stage.dependsOn) {
      if (!stageIds.has(dependency)) {
        errors.push(diagnostic("STAGED_TASK_UNKNOWN_DEPENDENCY", `Unknown dependency ${dependency} for ${stage.stageId}`));
      }
    }
  }

  const cycle = findDependencyCycle(graph);
  if (cycle) {
    errors.push(diagnostic("STAGED_TASK_DEPENDENCY_CYCLE", `Dependency cycle detected at ${cycle}`));
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export function createStagedTaskRunState(
  graph: StagedTaskGraph,
  options: CreateStagedTaskRunStateOptions
): StagedTaskRunState {
  const validation = validateStagedTaskGraph(graph);
  if (!validation.ok) {
    throw new Error(validation.errors.map((error) => error.message).join("; "));
  }
  return {
    schemaVersion: STAGED_TASK_SCHEMA_VERSION,
    taskRunId: options.taskRunId,
    graphId: graph.graphId,
    profileId: graph.profileId,
    stageStates: graph.stages.map((stage) => ({
      stageId: stage.stageId,
      status: stage.dependsOn.length === 0 ? "ready" : "pending",
      attempts: 0,
      inputRefs: stage.inputRefs,
      outputRefs: [],
      diagnostics: []
    })),
    refs: [],
    events: [],
    compatibility: STAGED_TASK_COMPATIBILITY,
    redaction: { class: "internal", fields: ["stageStates.diagnostics", "refs.preview"] }
  };
}

export function readyStagedTaskStages(
  graph: StagedTaskGraph,
  state: StagedTaskRunState
): readonly StagedTaskStageContract[] {
  const states = new Map(state.stageStates.map((stageState) => [stageState.stageId, stageState]));
  return graph.stages.filter((stage) => states.get(stage.stageId)?.status === "ready");
}

export function applyStagedTaskEvent(
  graph: StagedTaskGraph,
  state: StagedTaskRunState,
  event: StagedTaskStageEvent
): StagedTaskRunState {
  const nextRefs = event.outputRefs?.length ? appendUniqueRefs(state.refs, event.outputRefs) : state.refs;
  const nextStageStates = state.stageStates.map((stageState) => updateStageState(stageState, event));
  const withReady = recomputeReadyStages(graph, nextStageStates);
  return {
    ...state,
    stageStates: withReady,
    refs: nextRefs,
    events: [...state.events, event]
  };
}

export function replayStagedTaskRun(
  graph: StagedTaskGraph,
  events: readonly StagedTaskStageEvent[],
  options: ReplayStagedTaskRunOptions
): StagedTaskRunState {
  return events.reduce(
    (state, event) => applyStagedTaskEvent(graph, state, event),
    createStagedTaskRunState(graph, { taskRunId: options.taskRunId })
  );
}

export async function runReadyStage(
  graph: StagedTaskGraph,
  state: StagedTaskRunState,
  stageId: string,
  options: RunReadyStageOptions
): Promise<RunReadyStageResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const stage = graph.stages.find((candidate) => candidate.stageId === stageId);
  if (!stage) {
    throw new Error(`Unknown stage: ${stageId}`);
  }
  const stageState = state.stageStates.find((candidate) => candidate.stageId === stageId);
  if (stageState?.status !== "ready") {
    throw new Error(`Stage is not ready: ${stageId}`);
  }

  const executor = options.executors.find((candidate) => candidate.kind === stage.executorKind);
  if (!executor) {
    const event = createStageEvent({
      kind: "stage.failed",
      taskRunId: state.taskRunId,
      graphId: graph.graphId,
      stageId,
      at: now(),
      diagnostics: [
        diagnostic("STAGED_TASK_EXECUTOR_NOT_REGISTERED", `No executor registered for kind: ${stage.executorKind}`)
      ]
    });
    return {
      state: applyStagedTaskEvent(graph, state, event),
      events: [event]
    };
  }

  const started = createStageEvent({
    kind: "stage.started",
    taskRunId: state.taskRunId,
    graphId: graph.graphId,
    stageId,
    at: now(),
    diagnostics: []
  });
  const runningState = applyStagedTaskEvent(graph, state, started);
  const result = await executor.run(stage, {
    taskRunId: state.taskRunId,
    graphId: graph.graphId,
    profileId: graph.profileId,
    inputRefs: runningState.refs.filter((ref) => stage.inputRefs.includes(ref.refId)),
    expectedOutputRefIds: stage.expectedOutputRefs
  });
  const completedAt = now();
  const evaluation = stageEvaluationForResult(stage, result, completedAt);
  const technicalDirectorAcceptance = technicalDirectorAcceptanceForResult(result, stage);
  const completed = createStageEvent({
    kind: resultKindToEventKind(stage, result),
    taskRunId: state.taskRunId,
    graphId: graph.graphId,
    stageId,
    at: completedAt,
    outputRefs: result.outputRefs,
    ...(evaluation ? { evaluation } : {}),
    ...(technicalDirectorAcceptance ? { technicalDirectorAcceptance } : {}),
    diagnostics: result.status === "succeeded"
      ? [...result.diagnostics, technicalDirectorAcceptanceRequiredDiagnostic()]
      : result.diagnostics
  });

  return {
    state: applyStagedTaskEvent(graph, runningState, completed),
    events: [started, completed],
    result
  };
}

function updateStageState(
  stageState: StagedTaskStageState,
  event: StagedTaskStageEvent
): StagedTaskStageState {
  if (stageState.stageId !== event.stageId) return stageState;
  const status = eventKindToStatus(event.kind);
  const outputRefs = event.outputRefs?.map((ref) => ref.refId) ?? stageState.outputRefs;
  return {
    ...stageState,
    status,
    attempts: event.kind === "stage.started" ? stageState.attempts + 1 : stageState.attempts,
    outputRefs,
    ...(event.evaluation ? { evaluation: event.evaluation } : {}),
    ...(event.technicalDirectorAcceptance ? { technicalDirectorAcceptance: event.technicalDirectorAcceptance } : {}),
    diagnostics: event.diagnostics,
    ...(event.kind === "stage.started" ? { startedAt: event.at } : {}),
    ...(isTerminalStatus(status) ? { completedAt: event.at } : {})
  };
}

function recomputeReadyStages(
  graph: StagedTaskGraph,
  stageStates: readonly StagedTaskStageState[]
): readonly StagedTaskStageState[] {
  const states = new Map(stageStates.map((state) => [state.stageId, state]));
  return stageStates.map((state) => {
    if (state.status !== "pending") return state;
    const stage = graph.stages.find((candidate) => candidate.stageId === state.stageId);
    if (!stage) return state;
    const dependenciesSatisfied = stage.dependsOn.every((dependency) => {
      const dependencyStatus = states.get(dependency)?.status;
      return dependencyStatus === "succeeded" || dependencyStatus === "skipped";
    });
    return dependenciesSatisfied ? { ...state, status: "ready" } : state;
  });
}

function createStageEvent(input: {
  readonly kind: StagedTaskStageEvent["kind"];
  readonly taskRunId: string;
  readonly graphId: string;
  readonly stageId: string;
  readonly at: string;
  readonly outputRefs?: readonly StagedTaskRef[];
  readonly evaluation?: StagedTaskEvaluationResult;
  readonly technicalDirectorAcceptance?: StagedTaskTechnicalDirectorAcceptance;
  readonly diagnostics: readonly RedactedError[];
}): StagedTaskStageEvent {
  return {
    schemaVersion: STAGED_TASK_SCHEMA_VERSION,
    eventId: `event:${input.stageId}:${input.kind}:${input.at}`,
    kind: input.kind,
    taskRunId: input.taskRunId,
    graphId: input.graphId,
    stageId: input.stageId,
    at: input.at,
    ...(input.outputRefs ? { outputRefs: input.outputRefs } : {}),
    ...(input.evaluation ? { evaluation: input.evaluation } : {}),
    ...(input.technicalDirectorAcceptance ? { technicalDirectorAcceptance: input.technicalDirectorAcceptance } : {}),
    diagnostics: input.diagnostics,
    compatibility: STAGED_TASK_COMPATIBILITY,
    redaction: { class: "internal", fields: ["diagnostics.details", "outputRefs.preview", "evaluation.reason", "technicalDirectorAcceptance.reason"] }
  };
}

function eventKindToStatus(kind: StagedTaskStageEvent["kind"]): StagedTaskStageStatus {
  switch (kind) {
    case "stage.ready":
      return "ready";
    case "stage.started":
      return "running";
    case "stage.evaluation.required":
      return "running";
    case "stage.succeeded":
      return "succeeded";
    case "stage.failed":
      return "failed";
    case "stage.skipped":
      return "skipped";
  }
}

function resultKindToEventKind(
  stage: StagedTaskStageContract,
  result: StagedTaskExecutionResult
): StagedTaskStageEvent["kind"] {
  switch (result.status) {
    case "succeeded":
      return technicalDirectorAcceptanceAccepted(result, stage) ? "stage.succeeded" : "stage.evaluation.required";
    case "failed":
      return "stage.failed";
    case "skipped":
      return "stage.skipped";
  }
}

function technicalDirectorAcceptanceAccepted(
  result: StagedTaskExecutionResult,
  stage: StagedTaskStageContract
): boolean {
  const typedAcceptance = technicalDirectorAcceptanceForResult(result, stage);
  if (typedAcceptance) {
    return typedAcceptance.decision === "accepted" &&
      typedAcceptance.criteriaApplicable &&
      typedAcceptance.evidenceSufficient;
  }
  const acceptedByDiagnostic = result.diagnostics.some((entry) =>
    entry.code === "STAGED_TASK_TECHNICAL_DIRECTOR_ACCEPTED" ||
    entry.code === `STAGED_TASK_TECHNICAL_DIRECTOR_ACCEPTED:${stage.stageId}`
  );
  const acceptedByMetadata = Boolean(result.metadata && typeof result.metadata === "object" &&
    (result.metadata as { readonly technicalDirectorAcceptance?: unknown }).technicalDirectorAcceptance === "accepted");
  return acceptedByDiagnostic || acceptedByMetadata;
}

function stageEvaluationForResult(
  stage: StagedTaskStageContract,
  result: StagedTaskExecutionResult,
  evaluatedAt: string
): StagedTaskEvaluationResult | undefined {
  if (result.evaluation) return result.evaluation;
  if (result.status !== "succeeded") return undefined;
  const evidenceRefs = result.outputRefs.map((ref) => ref.refId);
  return {
    schemaVersion: STAGED_TASK_SCHEMA_VERSION,
    evaluationId: `evaluation:${stage.stageId}:${evaluatedAt}`,
    stageId: stage.stageId,
    evaluatorId: "runtime:staged-task-default-evaluator",
    status: "needs-review",
    reason: "Stage output requires evaluation before success can be accepted.",
    evidenceRefs,
    evaluatedAt,
    compatibility: STAGED_TASK_COMPATIBILITY,
    redaction: { class: "internal", fields: ["reason"] }
  };
}

function technicalDirectorAcceptanceForResult(
  result: StagedTaskExecutionResult,
  stage: StagedTaskStageContract
): StagedTaskTechnicalDirectorAcceptance | undefined {
  if (result.technicalDirectorAcceptance) return result.technicalDirectorAcceptance;
  const acceptedByDiagnostic = result.diagnostics.some((entry) =>
    entry.code === "STAGED_TASK_TECHNICAL_DIRECTOR_ACCEPTED" ||
    entry.code === `STAGED_TASK_TECHNICAL_DIRECTOR_ACCEPTED:${stage.stageId}`
  );
  const acceptedByMetadata = Boolean(result.metadata && typeof result.metadata === "object" &&
    (result.metadata as { readonly technicalDirectorAcceptance?: unknown }).technicalDirectorAcceptance === "accepted");
  if (!acceptedByDiagnostic && !acceptedByMetadata) return undefined;
  return {
    schemaVersion: STAGED_TASK_SCHEMA_VERSION,
    acceptanceId: `technical-director-acceptance:${stage.stageId}:${result.evaluation?.evaluationId ?? "diagnostic"}`,
    stageId: stage.stageId,
    reviewerId: "runtime:technical-director",
    decision: "accepted",
    criteriaApplicable: true,
    evidenceSufficient: true,
    reason: "Technical-director acceptance was provided by execution result diagnostics or metadata.",
    ...(result.evaluation?.evaluationId ? { evaluationId: result.evaluation.evaluationId } : {}),
    acceptedAt: result.evaluation?.evaluatedAt ?? new Date(0).toISOString(),
    compatibility: STAGED_TASK_COMPATIBILITY,
    redaction: { class: "internal", fields: ["reason"] }
  };
}

function technicalDirectorAcceptanceRequiredDiagnostic(): RedactedError {
  return diagnostic(
    "STAGED_TASK_TECHNICAL_DIRECTOR_ACCEPTANCE_REQUIRED",
    "Stage produced output, but final success requires technical-director acceptance of criteria applicability and evidence sufficiency."
  );
}

function isTerminalStatus(status: StagedTaskStageStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped";
}

function appendUniqueRefs(
  existing: readonly StagedTaskRef[],
  outputRefs: readonly StagedTaskRef[]
): readonly StagedTaskRef[] {
  const refs = new Map(existing.map((ref) => [ref.refId, ref]));
  for (const ref of outputRefs) {
    refs.set(ref.refId, ref);
  }
  return [...refs.values()];
}

function findDependencyCycle(graph: StagedTaskGraph): string | undefined {
  const byId = new Map(graph.stages.map((stage) => [stage.stageId, stage]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(stageId: string): string | undefined {
    if (visited.has(stageId)) return undefined;
    if (visiting.has(stageId)) return stageId;
    visiting.add(stageId);
    const stage = byId.get(stageId);
    if (stage) {
      for (const dependency of stage.dependsOn) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    visiting.delete(stageId);
    visited.add(stageId);
    return undefined;
  }

  for (const stage of graph.stages) {
    const cycle = visit(stage.stageId);
    if (cycle) return cycle;
  }
  return undefined;
}

function diagnostic(code: string, message: string): RedactedError {
  return {
    code,
    message,
    retryable: false,
    redaction: { class: "internal", fields: ["message"] }
  };
}
