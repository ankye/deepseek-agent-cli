import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult,
  SessionEvent,
  SessionId,
  SessionStore
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { requireDeps } from "../../../shared/workspace.js";

type TaskStatus = "pending" | "in_progress" | "completed" | "blocked";
type TaskOperation = "create" | "get" | "list" | "update" | "output";
type TaskToolName = "task.create" | "task.get" | "task.list" | "task.update" | "task.output";

interface TaskBoardToolDeps extends CoreCodingToolsDependencies {
  readonly sessions?: SessionStore;
}

interface TaskBoardItem extends JsonObject {
  readonly taskId: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly assignedTo?: string;
  readonly tags: readonly string[];
  readonly notes: readonly string[];
  readonly outputs: readonly TaskBoardOutput[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface TaskBoardOutput extends JsonObject {
  readonly outputId: string;
  readonly summary: string;
  readonly artifacts: readonly string[];
  readonly createdAt: string;
}

export function defineTaskCreateTool(deps: TaskBoardToolDeps | undefined) {
  return taskTool("task.create", coreToolIds.taskCreate, "Task Create", "create", ["title"], deps);
}

export function defineTaskGetTool(deps: TaskBoardToolDeps | undefined) {
  return taskTool("task.get", coreToolIds.taskGet, "Task Get", "get", ["taskId"], deps);
}

export function defineTaskListTool(deps: TaskBoardToolDeps | undefined) {
  return taskTool("task.list", coreToolIds.taskList, "Task List", "list", [], deps);
}

export function defineTaskUpdateTool(deps: TaskBoardToolDeps | undefined) {
  return taskTool("task.update", coreToolIds.taskUpdate, "Task Update", "update", ["taskId"], deps);
}

export function defineTaskOutputTool(deps: TaskBoardToolDeps | undefined) {
  return taskTool("task.output", coreToolIds.taskOutput, "Task Output", "output", ["taskId", "summary"], deps);
}

function taskTool(
  toolName: "task.create" | "task.get" | "task.list" | "task.update" | "task.output",
  id: typeof coreToolIds[keyof typeof coreToolIds],
  name: string,
  operation: TaskOperation,
  required: readonly string[],
  deps: TaskBoardToolDeps | undefined
) {
  return defineToolManifest(
    toolName,
    id,
    name,
    "none",
    ["agent:task-board"],
    objectSchema(required, {
      taskId: { type: "string" },
      title: { type: "string" },
      status: { type: "string" },
      assignedTo: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      note: { type: "string" },
      summary: { type: "string" },
      artifacts: { type: "array", items: { type: "string" } },
      sessionId: { type: "string" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => taskBoardTool(toolName, operation, input, context, ready as TaskBoardToolDeps))
  );
}

async function taskBoardTool(
  toolName: TaskToolName,
  operation: TaskOperation,
  input: JsonObject,
  context: CapabilityExecutionContext,
  deps: TaskBoardToolDeps
): Promise<SerializableResult<CoreToolResult>> {
  if (!deps.sessions) return failure(toolName, "TASK_BOARD_SESSION_STORE_UNAVAILABLE", "SessionStore is required for task-board tools.", []);
  const sessionId = sessionIdFor(input, context);
  if (!sessionId) return failure(toolName, "TASK_BOARD_SESSION_REQUIRED", "A sessionId is required for task-board tools.", []);
  const board = await readBoard(deps.sessions, sessionId);
  const now = new Date(0).toISOString();

  if (operation === "create") return createTask(toolName, input, context, deps.sessions, sessionId, board, now);
  if (operation === "get") return getTask(toolName, input, context, board);
  if (operation === "list") return listTasks(toolName, input, context, board);
  if (operation === "update") return updateTask(toolName, input, context, deps.sessions, sessionId, board, now);
  return outputTask(toolName, input, context, deps.sessions, sessionId, board, now);
}

async function createTask(
  toolName: TaskToolName,
  input: JsonObject,
  context: CapabilityExecutionContext,
  sessions: SessionStore,
  sessionId: SessionId,
  board: readonly TaskBoardItem[],
  now: string
): Promise<SerializableResult<CoreToolResult>> {
  const title = stringValue(input.title);
  if (!title) return failure(toolName, "TASK_TITLE_REQUIRED", "title is required.", []);
  const assignedTo = stringValue(input.assignedTo);
  const task: TaskBoardItem = {
    taskId: stringValue(input.taskId) ?? `task:${hashText(`${sessionId}:${title}:${board.length}`)}`,
    title,
    status: statusValue(input.status) ?? "pending",
    ...(assignedTo ? { assignedTo } : {}),
    tags: stringArray(input.tags),
    notes: [],
    outputs: [],
    createdAt: now,
    updatedAt: now
  };
  await appendTaskEvent(sessions, sessionId, "task-board.created", { task });
  return taskSuccess(toolName, context, { task, totalCount: board.length + 1 }, title);
}

function getTask(
  toolName: TaskToolName,
  input: JsonObject,
  context: CapabilityExecutionContext,
  board: readonly TaskBoardItem[]
): SerializableResult<CoreToolResult> {
  const taskId = stringValue(input.taskId);
  const task = board.find((candidate) => candidate.taskId === taskId);
  if (!task) return failure(toolName, "TASK_NOT_FOUND", "Task was not found in the session task board.", []);
  return taskSuccess(toolName, context, { task }, task.title);
}

function listTasks(
  toolName: TaskToolName,
  input: JsonObject,
  context: CapabilityExecutionContext,
  board: readonly TaskBoardItem[]
): SerializableResult<CoreToolResult> {
  const status = statusValue(input.status);
  const tasks = status ? board.filter((task) => task.status === status) : board;
  return taskSuccess(toolName, context, { tasks, totalCount: tasks.length }, tasks.map((task) => `${task.status} ${task.title}`).join("\n"));
}

async function updateTask(
  toolName: TaskToolName,
  input: JsonObject,
  context: CapabilityExecutionContext,
  sessions: SessionStore,
  sessionId: SessionId,
  board: readonly TaskBoardItem[],
  now: string
): Promise<SerializableResult<CoreToolResult>> {
  const taskId = stringValue(input.taskId);
  const existing = board.find((task) => task.taskId === taskId);
  if (!existing) return failure(toolName, "TASK_NOT_FOUND", "Task was not found in the session task board.", []);
  const title = stringValue(input.title);
  const status = statusValue(input.status);
  const assignedTo = stringValue(input.assignedTo);
  const note = stringValue(input.note);
  const task: TaskBoardItem = {
    ...existing,
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(assignedTo ? { assignedTo } : {}),
    ...(Array.isArray(input.tags) ? { tags: stringArray(input.tags) } : {}),
    notes: note ? [...existing.notes, note] : existing.notes,
    updatedAt: now
  };
  await appendTaskEvent(sessions, sessionId, "task-board.updated", { task });
  return taskSuccess(toolName, context, { task }, task.title);
}

async function outputTask(
  toolName: TaskToolName,
  input: JsonObject,
  context: CapabilityExecutionContext,
  sessions: SessionStore,
  sessionId: SessionId,
  board: readonly TaskBoardItem[],
  now: string
): Promise<SerializableResult<CoreToolResult>> {
  const taskId = stringValue(input.taskId);
  const existing = board.find((task) => task.taskId === taskId);
  const summary = stringValue(input.summary);
  if (!existing) return failure(toolName, "TASK_NOT_FOUND", "Task was not found in the session task board.", []);
  if (!summary) return failure(toolName, "TASK_OUTPUT_SUMMARY_REQUIRED", "summary is required.", []);
  const output: TaskBoardOutput = {
    outputId: `task-output:${hashText(`${taskId}:${summary}:${existing.outputs.length}`)}`,
    summary,
    artifacts: stringArray(input.artifacts),
    createdAt: now
  };
  const task: TaskBoardItem = {
    ...existing,
    outputs: [...existing.outputs, output],
    updatedAt: now
  };
  await appendTaskEvent(sessions, sessionId, "task-board.output", { task, output });
  return taskSuccess(toolName, context, { task, output }, summary);
}

async function readBoard(sessions: SessionStore, sessionId: SessionId): Promise<readonly TaskBoardItem[]> {
  const tasks = new Map<string, TaskBoardItem>();
  for (const event of await sessions.events(sessionId)) {
    if (!event.kind.startsWith("task-board.")) continue;
    const task = taskFromPayload(event.payload);
    if (task) tasks.set(task.taskId, task);
  }
  return [...tasks.values()];
}

async function appendTaskEvent(sessions: SessionStore, sessionId: SessionId, kind: string, payload: JsonObject): Promise<void> {
  const sequence = (await sessions.events(sessionId)).length + 1;
  await sessions.append({
    sessionId,
    sequence,
    kind,
    at: new Date(0).toISOString(),
    payload,
    redaction: { class: "internal", fields: ["payload.task.notes", "payload.output.summary"] }
  });
}

function taskSuccess(
  toolName: TaskToolName,
  context: CapabilityExecutionContext,
  metadata: JsonObject,
  preview: string
): SerializableResult<CoreToolResult> {
  return success(toolName, [], {
    preview: boundedText(preview, 8_000),
    metadata,
    replay: replay(context)
  });
}

function sessionIdFor(input: JsonObject, context: CapabilityExecutionContext): SessionId | undefined {
  const raw = stringValue(input.sessionId) ?? (context.envelope.sessionId ? String(context.envelope.sessionId) : undefined);
  return raw ? asId<"session">(raw) : undefined;
}

function taskFromPayload(payload: JsonObject): TaskBoardItem | undefined {
  const task = payload.task as TaskBoardItem | undefined;
  return task?.taskId && task.title ? task : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function statusValue(value: unknown): TaskStatus | undefined {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "blocked" ? value : undefined;
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
