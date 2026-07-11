import type {
  ConcurrencyOrchestrator,
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult,
  TaskEvent,
  TaskId
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { requireDeps } from "../../../shared/workspace.js";

interface ScheduleToolDeps extends CoreCodingToolsDependencies {
  readonly scheduler?: ConcurrencyOrchestrator;
}

export function defineScheduleCronTool(deps: ScheduleToolDeps | undefined) {
  return defineToolManifest(
    "schedule.cron",
    coreToolIds.scheduleCron,
    "Schedule Cron",
    "none",
    ["schedule:run"],
    objectSchema(["action"], {
      action: { type: "string" },
      taskId: { type: "string" },
      name: { type: "string" },
      deadlineMs: { type: "number" },
      metadata: { type: "object" },
      reason: { type: "string" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => scheduleCron(input, context, ready as ScheduleToolDeps))
  );
}

async function scheduleCron(input: JsonObject, context: CapabilityExecutionContext, deps: ScheduleToolDeps): Promise<SerializableResult<CoreToolResult>> {
  if (!deps.scheduler) return failure("schedule.cron", "SCHEDULER_UNAVAILABLE", "ConcurrencyOrchestrator is required for schedule.cron.", []);
  const action = stringValue(input.action) ?? "run-once";
  const taskId = asId<"task">(stringValue(input.taskId) ?? `task:${context.envelope.invocationId}`);
  if (action === "cancel") {
    await deps.scheduler.cancel(taskId, stringValue(input.reason) ?? "schedule.cancel");
    return scheduleSuccess(context, action, taskId, deps.scheduler.events().filter((event) => event.taskId === taskId));
  }
  if (action === "list") {
    return scheduleSuccess(context, action, taskId, deps.scheduler.events());
  }
  if (action !== "run-once") return failure("schedule.cron", "SCHEDULE_ACTION_UNSUPPORTED", "action must be run-once, list, or cancel.", [], { action });
  await deps.scheduler.run({
    id: taskId,
    name: stringValue(input.name) ?? "scheduled task",
    ...(typeof input.deadlineMs === "number" ? { deadlineMs: input.deadlineMs } : {}),
    trace: context.trace,
    metadata: jsonObject(input.metadata)
  }, async () => ({ status: "completed" }));
  return scheduleSuccess(context, action, taskId, deps.scheduler.events().filter((event) => event.taskId === taskId));
}

function scheduleSuccess(
  context: CapabilityExecutionContext,
  action: string,
  taskId: TaskId,
  events: readonly TaskEvent[]
): SerializableResult<CoreToolResult> {
  const eventObjects = events.map((event) => ({
    taskId: event.taskId,
    status: event.status,
    at: event.at,
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.metadata ? { metadata: event.metadata } : {})
  }));
  return success("schedule.cron", [], {
    preview: boundedText(eventObjects.map((event) => `${event.taskId}:${event.status}`).join("\n")),
    metadata: {
      familyId: "schedule.sleep-cron",
      action,
      taskId,
      events: eventObjects,
      eventCount: eventObjects.length
    },
    replay: replay(context)
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function jsonObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}
