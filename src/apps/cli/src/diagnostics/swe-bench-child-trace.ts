import type { JsonObject } from "@deepseek/platform-contracts";

export interface SweBenchChildTraceSummary extends JsonObject {
  readonly tracePath?: string;
  readonly lineCount: number;
  readonly invalidLineCount: number;
  readonly terminalKind?: string;
  readonly terminalStatus?: string;
  readonly terminalReason?: string;
  readonly iterationCount: number;
  readonly modelRequestCount: number;
  readonly usageEventCount: number;
  readonly toolIntentCount: number;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export function summarizeSweBenchChildTrace(stdout: string, traceOutputPath: string | undefined): SweBenchChildTraceSummary {
  let lineCount = 0;
  let invalidLineCount = 0;
  let terminalKind = "";
  let terminalStatus = "";
  let terminalReason = "";
  let iterationCount = 0;
  let modelRequestCount = 0;
  let usageEventCount = 0;
  let toolIntentCount = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    lineCount += 1;
    let parsed: JsonObject;
    try {
      parsed = JSON.parse(line) as JsonObject;
    } catch {
      invalidLineCount += 1;
      continue;
    }
    const event = isJsonObject(parsed.event) ? parsed.event : parsed;
    const kind = stringField(event, "kind");
    const data = isJsonObject(event.data) ? event.data : {};
    const iteration = numberField(data, "iteration") ?? numberField(data, "iterations");
    if (iteration !== undefined) iterationCount = Math.max(iterationCount, iteration);
    if (kind === "model.requested") modelRequestCount += 1;
    if (kind === "usage.updated") usageEventCount += 1;
    if (kind === "model.tool.intent") toolIntentCount += 1;
    if (kind === "agent.loop.completed" || kind === "agent.loop.failed" || kind === "agent.loop.cancelled") {
      terminalKind = kind;
      terminalStatus = stringField(data, "status");
      terminalReason = stringField(data, "reason");
    }
  }
  return {
    ...(traceOutputPath ? { tracePath: traceOutputPath } : {}),
    lineCount,
    invalidLineCount,
    ...(terminalKind ? { terminalKind } : {}),
    ...(terminalStatus ? { terminalStatus } : {}),
    ...(terminalReason ? { terminalReason } : {}),
    iterationCount,
    modelRequestCount,
    usageEventCount,
    toolIntentCount,
    redaction: { class: "internal", fields: ["tracePath"] }
  };
}

function stringField(value: JsonObject, key: string): string {
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function numberField(value: JsonObject, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
