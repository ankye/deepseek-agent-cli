import type { CliEvaluationInstrumentationEvent, JsonObject, ProcessRunObserver } from "@deepseek/platform-contracts";

export interface EvaluationProgressSink {
  readonly emit: (line: string) => void;
}

export function createEvaluationProgressObserver(taskId: string, sink?: EvaluationProgressSink): ProcessRunObserver | undefined {
  if (!sink) return undefined;
  let buffer = "";
  const emitLine = (line: string) => {
    const progressLine = progressLineFromChildJsonl(taskId, line);
    if (progressLine) sink.emit(progressLine);
  };
  return {
    onStdoutChunk(chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      if (buffer.length > 64 * 1024) buffer = buffer.slice(-64 * 1024);
      for (const line of lines) emitLine(line);
    },
    onProcessExit() {
      const finalLine = buffer;
      buffer = "";
      if (finalLine.trim()) emitLine(finalLine);
    }
  };
}

export function progressLineFromChildJsonl(taskId: string, line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const parsed = parseJsonObject(trimmed);
  if (!parsed) return undefined;
  const kind = stringField(parsed, "kind");
  const data = jsonObjectField(parsed, "data") ?? {};
  if (kind === "model.tool.intent") {
    return `progress ${taskId}: tool ${toolName(data)} started`;
  }
  if (kind === "model.tool.result") {
    return `progress ${taskId}: tool ${toolName(data)} ${toolStatus(data)}`;
  }
  if (kind === "agent.repair.started") {
    return `progress ${taskId}: repair started`;
  }
  if (kind === "agent.repair.stopped") {
    return `progress ${taskId}: repair stopped${reasonSuffix(repairStopReason(data))}`;
  }
  if (kind === "agent.loop.completed") {
    return `progress ${taskId}: loop completed${reasonSuffix(repairStopReason(data))}`;
  }
  if (kind === "agent.loop.failed") {
    return `progress ${taskId}: loop failed${reasonSuffix(stringField(data, "reason") ?? repairStopReason(data))}`;
  }
  return undefined;
}

export function emitEvaluationInstrumentationProgress(
  sink: EvaluationProgressSink | undefined,
  taskId: string,
  baselineId: string,
  kind: CliEvaluationInstrumentationEvent["kind"],
  metadata?: JsonObject
): void {
  const line = progressLineFromInstrumentationEvent(taskId, baselineId, kind, metadata ?? {});
  if (line) sink?.emit(line);
}

export function progressLineFromInstrumentationEvent(
  taskId: string,
  baselineId: string,
  kind: CliEvaluationInstrumentationEvent["kind"],
  metadata: JsonObject
): string | undefined {
  if (kind === "run_started") return `progress ${taskId}: task started baseline=${baselineId}`;
  if (kind === "workspace_created") return `progress ${taskId}: workspace ready`;
  if (kind === "command_started") return `progress ${taskId}: agent command started`;
  if (kind === "command_finished") return `progress ${taskId}: agent command exit=${numericField(metadata, "exitCode") ?? "unknown"}`;
  if (kind === "checker_started") return `progress ${taskId}: checker started`;
  if (kind === "checker_finished") return `progress ${taskId}: checker ${numericField(metadata, "exitCode") === 0 ? "pass" : "fail"} exit=${numericField(metadata, "exitCode") ?? "unknown"}`;
  if (kind === "artifact_scan_started") return `progress ${taskId}: artifact scan started`;
  if (kind === "artifact_scan_finished") return `progress ${taskId}: artifact scan finished files=${numericField(metadata, "fileCount") ?? "unknown"}`;
  if (kind === "run_finished") return `progress ${taskId}: task ${stringField(metadata, "outcome") ?? "finished"}`;
  return undefined;
}

function parseJsonObject(value: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toolName(data: JsonObject): string {
  return stringField(data, "name") ?? stringField(data, "toolName") ?? stringField(data, "capabilityId") ?? "unknown";
}

function toolStatus(data: JsonObject): string {
  const feedback = jsonObjectField(data, "feedback");
  return stringField(data, "status") ?? stringField(feedback, "status") ?? stringField(data, "terminalKind") ?? "completed";
}

function repairStopReason(data: JsonObject): string | undefined {
  const selfRepair = jsonObjectField(data, "selfRepair");
  return stringField(data, "stopReason") ?? stringField(selfRepair, "stopReason");
}

function reasonSuffix(reason: string | undefined): string {
  return reason ? ` reason=${reason}` : "";
}

function jsonObjectField(value: JsonObject | undefined, key: string): JsonObject | undefined {
  if (!value) return undefined;
  const field = value[key];
  return isJsonObject(field) ? field : undefined;
}

function stringField(value: JsonObject | undefined, key: string): string | undefined {
  if (!value) return undefined;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numericField(value: JsonObject | undefined, key: string): number | undefined {
  if (!value) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
