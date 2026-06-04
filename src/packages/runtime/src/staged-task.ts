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
  type StagedTaskStageContract,
  type StagedTaskStageEvent,
  type StagedTaskStageState,
  type StagedTaskStageStatus,
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
  const completed = createStageEvent({
    kind: resultKindToEventKind(result.status),
    taskRunId: state.taskRunId,
    graphId: graph.graphId,
    stageId,
    at: now(),
    outputRefs: result.outputRefs,
    diagnostics: result.diagnostics
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
    diagnostics: input.diagnostics,
    compatibility: STAGED_TASK_COMPATIBILITY,
    redaction: { class: "internal", fields: ["diagnostics.details", "outputRefs.preview"] }
  };
}

function eventKindToStatus(kind: StagedTaskStageEvent["kind"]): StagedTaskStageStatus {
  switch (kind) {
    case "stage.ready":
      return "ready";
    case "stage.started":
      return "running";
    case "stage.succeeded":
      return "succeeded";
    case "stage.failed":
      return "failed";
    case "stage.skipped":
      return "skipped";
  }
}

function resultKindToEventKind(status: StagedTaskExecutionResult["status"]): StagedTaskStageEvent["kind"] {
  switch (status) {
    case "succeeded":
      return "stage.succeeded";
    case "failed":
      return "stage.failed";
    case "skipped":
      return "stage.skipped";
  }
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
