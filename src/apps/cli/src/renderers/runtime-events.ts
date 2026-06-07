import type { AgentLoopOutputMode, AgentLoopSummary, ContextStatuslineTelemetry, JsonObject, RuntimeDependencies, RuntimeEvent, RuntimeKernel, VisibleReasoningProjection, VisibleReasoningRecord } from "@deepseek/platform-contracts";
import type { AgentLoopBudget, AgentPhasePlan, AgentPhasePlanItem, AgentVerifierResult, AgentWorkerLifecycleEvent, AgentWorkerResult } from "@deepseek/platform-contracts";
import { runAgentLoop } from "@deepseek/runtime";
import type { CliTerminalCapabilityProfile } from "../host/terminal-profile.js";
import { isApprovalEvent, renderApprovalJson, renderApprovalText } from "./approval.js";

interface TextStreamState {
  deltaOpen: boolean;
  reasoningOpen: boolean;
  inlineBuffer: string;
}

export async function emitAgentLoop(
  deps: RuntimeDependencies,
  kernel: RuntimeKernel,
  request: Parameters<typeof runAgentLoop>[2],
  write: (line: string) => Promise<void>,
  writeInline: (chunk: string) => Promise<void> = write,
  bufferedInline = false,
  signal?: AbortSignal,
  terminalProfile?: CliTerminalCapabilityProfile
): Promise<readonly RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  const stream: TextStreamState = { deltaOpen: false, reasoningOpen: false, inlineBuffer: "" };
  const inline = async (chunk: string): Promise<void> => {
    if (bufferedInline) {
      stream.inlineBuffer += chunk;
      return;
    }
    await writeInline(chunk);
  };
  const flushInline = async (): Promise<void> => {
    if (bufferedInline && stream.inlineBuffer.length > 0) {
      await write(stream.inlineBuffer);
      stream.inlineBuffer = "";
      return;
    }
    if (!bufferedInline) {
      await write("");
    }
  };
  for await (const event of runAgentLoop(deps, kernel, request, signal ? { signal } : {})) {
    events.push(event);
    if (request.outputMode === "jsonl") {
      await write(renderJsonLine(event));
      continue;
    }
    if (request.outputMode === "text") {
      await renderTextEvent(event, stream, write, inline, flushInline, terminalProfile);
    }
  }
  await closeOpenTextStreams(stream, flushInline);
  return events;
}

export function renderText(event: RuntimeEvent): string {
  if (isApprovalEvent(event)) return renderApprovalText(event);
  if (event.kind === "model.requested") return `[model] request iteration=${String(event.data.iteration ?? "")}`;
  if (event.kind === "evidence.classified") return `[evidence] required=${String(event.data.evidenceRequired ?? false)} intents=${eventDataList(event.data.intents)}`;
  if (event.kind === "evidence.plan.created") return `[evidence] plan sources=${eventDataCount(event.data.sources)} claims=${eventDataCount(event.data.claims)}`;
  if (event.kind === "evidence.selected") return `[evidence] selected=${String(event.data.selectedEvidenceCount ?? 0)}`;
  if (event.kind === "agent.phase.plan.created") return renderPhasePlan(event.data as unknown as AgentPhasePlan);
  if (event.kind === "agent.phase.skipped") return renderSkippedPhase(event.data as unknown as AgentPhasePlanItem);
  if (event.kind === "agent.loop.budget.consumed") return renderBudget(event.data as unknown as AgentLoopBudget);
  if (event.kind === "agent.worker.launched" || event.kind === "agent.worker.continued" || event.kind === "agent.worker.stopped") return renderWorkerLifecycle(event.data as unknown as AgentWorkerLifecycleEvent);
  if (event.kind === "agent.worker.result") return renderWorkerResult(event.data as unknown as AgentWorkerResult);
  if (event.kind === "agent.verifier.verdict") return renderVerifierVerdict(event.data as unknown as AgentVerifierResult);
  if (event.kind === "model.reasoning.effort.mapped") return `[model] reasoning requested=${String(event.data.requestedEffort ?? "none")} provider=${String(event.data.providerEffort ?? "none")} supported=${String(event.data.supported ?? true)}`;
  if (event.kind === "visible.reasoning.recorded") return renderVisibleReasoningText(event.data as unknown as VisibleReasoningRecord);
  if (event.kind === "visible.reasoning.projected") return renderVisibleReasoningProjectionText(event.data as unknown as VisibleReasoningProjection);
  if (event.kind === "model.tool.intent") return `[tool] ${String(event.data.name ?? "")}`;
  if (event.kind === "model.tool.repaired") return "[tool repaired]";
  if (event.kind === "model.tool.rejected") return `[tool rejected] ${event.error?.message ?? ""}`.trim();
  if (event.kind === "model.tool.result") return `[tool result] ${String(event.data.terminalKind ?? "")}`;
  if (event.kind === "agent.loop.completed") {
    const summary = event.data as AgentLoopSummary;
    return `[completed] trace=${summary.traceId} session=${summary.sessionId}`;
  }
  if (event.kind === "agent.loop.cancelled") {
    const summary = event.data as AgentLoopSummary;
    return `[cancelled] trace=${summary.traceId} session=${summary.sessionId}`;
  }
  if (event.kind === "agent.loop.failed") return `[failed] ${event.error?.message ?? ""}`.trim();
  if (event.kind === "runtime.error") return `[error] ${event.error?.message ?? ""}`.trim();
  return "";
}

function renderPhasePlan(plan: AgentPhasePlan): string {
  const required = plan.phases.filter((phase) => phase.required).map((phase) => phase.phase).join(",");
  const skipped = plan.phases.filter((phase) => phase.status === "skipped").map((phase) => `${phase.phase}:${phase.skipReason ?? "unknown"}`).join(",");
  return `[plan] mode=${plan.agentMode} required=${required || "none"} skipped=${skipped || "none"}`;
}

function renderSkippedPhase(phase: AgentPhasePlanItem): string {
  return `[phase skipped] ${phase.phase} reason=${phase.skipReason ?? "unknown"} mode=${phase.mode}`;
}

function renderBudget(budget: AgentLoopBudget): string {
  return `[budget] ${budget.kind} consumed=${budget.consumed}/${budget.allowed} remaining=${budget.remaining}${budget.stopReason ? ` stop=${budget.stopReason}` : ""}`;
}

function renderWorkerLifecycle(worker: AgentWorkerLifecycleEvent): string {
  return `[worker] ${worker.status} worker=${worker.workerAgentId ?? "unknown"} instance=${worker.workerInstanceId ?? "none"} work_order=${worker.workOrderId ?? "none"}`;
}

function renderWorkerResult(result: AgentWorkerResult): string {
  return `[worker] result=${result.resultId} status=${result.status} evidence=${result.evidenceIds.length} changed_scope=${result.changedScope.length}`;
}

function renderVerifierVerdict(result: AgentVerifierResult): string {
  return `[verify] verdict=${result.verdict} evidence=${result.evidenceIds.length} commands=${result.commandEvidenceIds.length} unchecked=${result.unverifiedAreas.length}`;
}

function renderVisibleReasoningText(record: VisibleReasoningRecord): string {
  const evidence = record.evidence.length > 0 ? ` evidence=${record.evidence.length}` : "";
  const certainty = record.certainty !== "inferred" ? ` certainty=${record.certainty}` : "";
  return `[reasoning:${record.stepKind}] ${record.status}${certainty}${evidence} id=${record.recordId} - ${record.summary}`;
}

function renderVisibleReasoningProjectionText(projection: VisibleReasoningProjection): string {
  return `[reasoning] records=${projection.summary.visibleRecords}/${projection.summary.totalRecords} evidence=${projection.summary.evidenceLinkCount} assumptions=${projection.summary.assumptionCount} unsupported=${projection.summary.unsupportedCount} fingerprint=${projection.replayFingerprint}`;
}

function eventDataList(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(",") || "none" : "none";
}

function eventDataCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function renderJsonLine(event: RuntimeEvent): string {
  const approval = renderApprovalJson(event);
  if (approval) {
    return JSON.stringify({
      ...event,
      data: {
        ...event.data,
        approval
      }
    });
  }
  return JSON.stringify(event);
}

export async function renderFinalJsonIfNeeded(output: AgentLoopOutputMode, events: readonly RuntimeEvent[], write: (line: string) => Promise<void>): Promise<void> {
  if (output !== "json") return;
  const terminal = finalAgentLoopEvent(events);
  const fallback = events.at(-1);
  const sessionId = terminal?.sessionId ?? fallback?.sessionId ?? "";
  const visibleReasoning = visibleReasoningProjectionFromEvents(events, terminal);
  await write(JSON.stringify({
    schemaVersion: "1.0.0",
    status: String(terminal?.data.status ?? (terminal?.kind === "agent.loop.completed" ? "completed" : "failed")),
    sessionId,
    turnId: terminal?.turnId ?? fallback?.turnId ?? "",
    traceId: String(terminal?.trace.traceId ?? fallback?.trace.traceId ?? ""),
    assistantText: String(terminal?.data.assistantText ?? ""),
    diagnostics: Array.isArray(terminal?.data.diagnostics) ? terminal?.data.diagnostics : [],
    ...(visibleReasoning ? { visibleReasoning } : {}),
    ...(terminal?.data.selfRepair && typeof terminal.data.selfRepair === "object" ? { selfRepair: terminal.data.selfRepair } : {}),
    resumeCommand: sessionId ? `deepseek session resume ${sessionId}` : "",
    redaction: terminal?.data.redaction ?? { class: "internal" }
  }));
}

export function visibleReasoningRecordsFromEvents(events: readonly RuntimeEvent[]): readonly VisibleReasoningRecord[] {
  return events
    .filter((event) => event.kind === "visible.reasoning.recorded")
    .map((event) => event.data as unknown as VisibleReasoningRecord);
}

export function visibleReasoningProjectionFromEvents(events: readonly RuntimeEvent[], terminal?: RuntimeEvent): VisibleReasoningProjection | undefined {
  const fromTerminal = terminal?.data.visibleReasoning;
  if (fromTerminal && typeof fromTerminal === "object" && !Array.isArray(fromTerminal)) return fromTerminal as unknown as VisibleReasoningProjection;
  const projected = [...events].reverse().find((event) => event.kind === "visible.reasoning.projected");
  return projected ? projected.data as unknown as VisibleReasoningProjection : undefined;
}

export function statusTelemetryFromEvents(events: readonly RuntimeEvent[]): ContextStatuslineTelemetry {
  const explicit = [...events].reverse().find((event) => event.kind === "runtime.status.telemetry");
  if (explicit) return explicit.data as unknown as ContextStatuslineTelemetry;
  const modelEvent = [...events].reverse().find((event) => event.kind === "model.requested");
  const reasoningEvent = [...events].reverse().find((event) => event.kind === "model.reasoning.effort.mapped");
  const contextEvent = [...events].reverse().find((event) => event.kind === "context.projection.completed" || event.kind === "context.projection.cache-hit" || event.kind === "context.projection.degraded");
  const usageEvent = [...events].reverse().find((event) => event.kind === "usage.updated");
  const aggregateCache = aggregateCacheTelemetry(events);
  const contextBudget = jsonObject(contextEvent?.data.budget) ?? jsonObject(jsonObject(modelEvent?.data.contextProjection)?.budget);
  const usageMetadata = jsonObject(usageEvent?.data.metadata);
  const cache = jsonObject(usageMetadata?.cache);
  const hitTokens = aggregateCache?.hitTokens ?? numberValue(cache?.hitTokens);
  const missTokens = aggregateCache?.missTokens ?? numberValue(cache?.missTokens);
  const derivedHitRate = hitTokens !== undefined || missTokens !== undefined
    ? ratio(hitTokens ?? 0, (hitTokens ?? 0) + (missTokens ?? 0))
    : undefined;
  const hitRate = aggregateCache?.hitRate ?? numberValue(cache?.hitRate) ?? derivedHitRate;
  const selectedTokens = numberValue(contextBudget?.selectedTokens) ?? numberValue(contextBudget?.selectedTokensEstimate) ?? numberValue(contextEvent?.data.estimatedTokens) ?? 0;
  const hardLimitTokens = numberValue(contextBudget?.hardLimitTokens) ?? numberValue(contextBudget?.hardLimit) ?? 0;
  const softLimitTokens = numberValue(contextBudget?.softLimitTokens);
  const pipeline = jsonObject(contextEvent?.data.pipeline) ?? jsonObject(jsonObject(modelEvent?.data.contextProjection)?.pipeline);
  const pipelineFingerprint = stringValue(cache?.pipelineFingerprint) ?? stringValue(pipeline?.pipelineFingerprint);
  const modelProfileId = stringValue(modelEvent?.data.modelProfileId);
  const prefixHashCount = Array.isArray(pipeline?.prefixHashes) ? pipeline.prefixHashes.length : 0;
  return {
    schemaVersion: "1.0.0",
    modelId: stringValue(modelEvent?.data.model) ?? "unknown",
    ...(modelProfileId ? { modelProfileId } : {}),
    thinkingMode: stringValue(reasoningEvent?.data.requestedEffort) ?? stringValue(reasoningEvent?.data.providerEffort) ?? "none",
    cache: {
      status: cacheStatus(cache, hitTokens, missTokens),
      ...(hitRate !== undefined ? { hitRate } : {}),
      ...(hitTokens !== undefined ? { hitTokens } : {}),
      ...(missTokens !== undefined ? { missTokens } : {})
    },
    context: {
      selectedTokens,
      hardLimitTokens,
      ...(softLimitTokens !== undefined ? { softLimitTokens } : {}),
      budgetPressure: budgetPressure(selectedTokens, hardLimitTokens, softLimitTokens)
    },
    prefix: {
      stability: pipelineFingerprint ? "stable" : "unavailable",
      stableLayerCount: prefixHashCount,
      changedLayerCount: 0,
      ...(pipelineFingerprint ? { pipelineFingerprint } : {})
    },
    redaction: { class: "internal" },
    compatibility: { schemaVersion: "1.0.0" }
  };
}

export function finalAgentLoopEvent(events: readonly RuntimeEvent[]): RuntimeEvent | undefined {
  return [...events].reverse().find((event) => event.kind === "agent.loop.completed" || event.kind === "agent.loop.failed" || event.kind === "agent.loop.cancelled");
}

function cacheStatus(cache: JsonObject | undefined, hitTokens: number | undefined, missTokens: number | undefined): ContextStatuslineTelemetry["cache"]["status"] {
  const explicit = stringValue(cache?.status);
  if (explicit === "available" || explicit === "estimated" || explicit === "unavailable") return explicit;
  return hitTokens !== undefined || missTokens !== undefined ? "available" : "unavailable";
}

function aggregateCacheTelemetry(events: readonly RuntimeEvent[]): { readonly hitTokens: number; readonly missTokens: number; readonly hitRate: number } | undefined {
  let hitTokens = 0;
  let missTokens = 0;
  let sawCache = false;
  for (const event of events) {
    if (event.kind !== "usage.updated") continue;
    const cache = jsonObject(jsonObject(event.data.metadata)?.cache);
    const hit = numberValue(cache?.hitTokens);
    const miss = numberValue(cache?.missTokens) ?? numberValue(event.data.inputTokens);
    if (hit === undefined && miss === undefined) continue;
    sawCache = true;
    hitTokens += hit ?? 0;
    missTokens += miss ?? 0;
  }
  if (!sawCache) return undefined;
  return {
    hitTokens,
    missTokens,
    hitRate: ratio(hitTokens, hitTokens + missTokens) ?? 0
  };
}

function budgetPressure(selectedTokens: number, hardLimitTokens: number, softLimitTokens: number | undefined): ContextStatuslineTelemetry["context"]["budgetPressure"] {
  if (hardLimitTokens > 0 && selectedTokens >= hardLimitTokens) return "hard";
  if (softLimitTokens !== undefined && selectedTokens >= softLimitTokens) return "soft";
  return "normal";
}

function ratio(numerator: number, denominator: number): number | undefined {
  return denominator > 0 ? numerator / denominator : undefined;
}

function jsonObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function resumeHint(sessionId: string): string {
  return `[session] deepseek session resume ${sessionId}`;
}

async function renderTextEvent(
  event: RuntimeEvent,
  stream: TextStreamState,
  write: (line: string) => Promise<void>,
  writeInline: (chunk: string) => Promise<void>,
  flushInline: () => Promise<void>,
  terminalProfile?: CliTerminalCapabilityProfile
): Promise<void> {
  if (event.kind === "model.delta") {
    if (stream.reasoningOpen) {
      await flushInline();
      stream.reasoningOpen = false;
    }
    stream.deltaOpen = true;
    await writeInline(String(event.data.text ?? ""));
    return;
  }
  if (event.kind === "model.reasoning") {
    if (stream.deltaOpen) {
      await flushInline();
      stream.deltaOpen = false;
    }
    if (!stream.reasoningOpen) {
      await writeInline("[reasoning] ");
      stream.reasoningOpen = true;
    }
    await writeInline(String(event.data.text ?? ""));
    return;
  }
  if (event.kind === "model.requested") {
    await closeOpenTextStreams(stream, flushInline);
    return;
  }
  await closeOpenTextStreams(stream, flushInline);
  const line = isApprovalEvent(event) ? renderApprovalText(event, terminalProfile) : renderText(event);
  if (line) await write(line);
}

async function closeOpenTextStreams(stream: TextStreamState, flushInline: () => Promise<void>): Promise<void> {
  if (stream.deltaOpen || stream.reasoningOpen) {
    await flushInline();
    stream.deltaOpen = false;
    stream.reasoningOpen = false;
  }
}
