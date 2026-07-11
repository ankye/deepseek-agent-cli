import type { AgentLoopBudget, JsonObject, SessionEvent, SessionForkResult, SessionId, SessionResumeResult } from "@deepseek/platform-contracts";
import type { CliOptions, CliRunOptions } from "../types.js";
import { resolveSessionDependencies } from "../host/runtime.js";

interface SessionBoardStep extends JsonObject {
  readonly sequence: number;
  readonly kind: string;
  readonly label: string;
  readonly status: "running" | "completed" | "failed" | "blocked" | "planned" | "info";
  readonly at: string;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

interface SessionBoardResult extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly sessionId: SessionId;
  readonly status: "empty" | "running" | "completed" | "failed" | "cancelled" | "blocked";
  readonly summary: {
    readonly totalSteps: number;
    readonly toolCallCount: number;
    readonly verificationCount: number;
    readonly terminalStatus: string;
  };
  readonly steps: readonly SessionBoardStep[];
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export async function runSessionCommand(options: CliOptions, write: (line: string) => Promise<void>, runOptions: CliRunOptions): Promise<void> {
  const deps = await resolveSessionDependencies(runOptions);
  if (options.sessionAction === "board") {
    const result = options.sessionId
      ? await sessionBoard(deps.sessions, options.sessionId)
      : { ok: false, error: cliSessionError("SESSION_ID_REQUIRED", "session board requires a session id") };
    if (options.output !== "text") {
      await write(JSON.stringify(result));
      return;
    }
    if (!result.ok || !result.value) {
      await write(`[session failed] ${String(result.error?.message ?? "session board")}`);
      return;
    }
    for (const line of renderBoardText(result.value)) await write(line);
    return;
  }
  let result: { ok: boolean; value?: SessionResumeResult | SessionForkResult; error?: JsonObject };
  if (options.sessionAction === "fork") {
    result = options.parentSessionId
      ? await deps.sessions.fork({ parentSessionId: options.parentSessionId, reason: "cli session fork" })
      : { ok: false, error: cliSessionError("SESSION_ID_REQUIRED", "session fork requires a parent session id") };
  } else {
    result = options.sessionId
      ? await deps.sessions.resume(options.sessionId)
      : { ok: false, error: cliSessionError("SESSION_ID_REQUIRED", "session resume requires a session id") };
  }
  if (options.output !== "text") {
    await write(JSON.stringify(result));
    return;
  }
  if (!result.ok || !result.value) {
    await write(`[session failed] ${String(result.error?.message ?? options.sessionAction ?? "session")}`);
    return;
  }
  if (isForkResult(result.value)) {
    for (const line of renderForkText(result.value)) await write(line);
    return;
  }
  for (const line of renderResumeText(result.value)) await write(line);
}

async function sessionBoard(
  sessions: {
    readonly metadata: (sessionId: SessionId) => Promise<{ readonly ok: boolean; readonly value?: JsonObject; readonly error?: JsonObject }>;
    readonly events: (sessionId: SessionId) => Promise<readonly SessionEvent[]>;
  },
  sessionId: SessionId
): Promise<{ readonly ok: boolean; readonly value?: SessionBoardResult; readonly error?: JsonObject }> {
  const metadata = await sessions.metadata(sessionId);
  if (!metadata.ok) return { ok: false, error: metadata.error ?? cliSessionError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`) };
  const events = await sessions.events(sessionId);
  const steps = events.map(sessionBoardStep);
  const terminal = [...events].reverse().find((event) => event.kind === "agent.loop.completed" || event.kind === "agent.loop.failed" || event.kind === "agent.loop.cancelled");
  const terminalStatus = terminalStatusFromEvent(terminal);
  return {
    ok: true,
    value: {
      schemaVersion: "1.0.0",
      sessionId,
      status: terminalStatus === "none" ? steps.length === 0 ? "empty" : "running" : terminalStatus,
      summary: {
        totalSteps: steps.length,
        toolCallCount: events.filter((event) => event.kind === "model.tool.intent").length,
        verificationCount: events.filter((event) => event.kind === "agent.verifier.verdict" || event.kind === "agent.output-contract.verified").length,
        terminalStatus
      },
      steps,
      redaction: { class: "internal", fields: ["steps.label"] }
    }
  };
}

function sessionBoardStep(event: SessionEvent): SessionBoardStep {
  return {
    sequence: event.sequence,
    kind: event.kind,
    label: sessionBoardLabel(event),
    status: sessionBoardStepStatus(event),
    at: event.at,
    redaction: { class: "internal", fields: ["label"] }
  };
}

function sessionBoardLabel(event: SessionEvent): string {
  const payload = event.payload;
  if (event.kind === "agent.loop.started") return `started ${stringField(payload, "caller") || "agent loop"}`;
  if (event.kind === "agent.phase.plan.created") {
    const phases = Array.isArray(payload.phases)
      ? payload.phases.map((phase) => isJsonObject(phase) ? stringField(phase, "phase") : undefined).filter(Boolean).join(",")
      : "";
    return `plan ${stringField(payload, "agentMode") || "agent"} phases=${phases || "none"}`;
  }
  if (event.kind === "model.requested") return `model ${stringField(payload, "model") || "requested"}`;
  if (event.kind === "model.tool.intent") return `tool ${stringField(payload, "name") || stringField(payload, "capabilityId") || "requested"}`;
  if (event.kind === "model.tool.result") return `tool result ${stringField(payload, "terminalKind") || stringField(payload, "status") || "unknown"}`;
  if (event.kind === "capability.completed") return `capability ${stringField(payload, "capabilityId") || "completed"}`;
  if (event.kind === "agent.verifier.verdict") return `verify ${stringField(payload, "verdict") || "verdict"}`;
  if (event.kind === "agent.output-contract.verified") return `output contract ${stringField(payload, "status") || "checked"}`;
  if (event.kind === "workflow.step") return `workflow ${stringField(payload, "stageId") || stringField(payload, "status") || "step"}`;
  if (event.kind === "agent.loop.completed") return `completed ${stringField(payload, "status") || "completed"}`;
  if (event.kind === "agent.loop.failed") return `failed ${stringField(payload, "reason") || stringField(payload, "status") || "failed"}`;
  if (event.kind === "agent.loop.cancelled") return `cancelled ${stringField(payload, "reason") || "cancelled"}`;
  return event.kind;
}

function sessionBoardStepStatus(event: SessionEvent): SessionBoardStep["status"] {
  if (event.kind.includes("failed") || event.kind.includes("rejected")) return "failed";
  if (event.kind.includes("denied") || event.kind.includes("missed")) return "blocked";
  if (event.kind === "agent.loop.started" || event.kind === "turn.started") return "running";
  if (event.kind === "agent.phase.plan.created") return "planned";
  if (event.kind === "agent.loop.completed" || event.kind.endsWith(".completed") || event.kind === "model.tool.result") return "completed";
  return "info";
}

function terminalStatusFromEvent(event: SessionEvent | undefined): SessionBoardResult["status"] | "none" {
  if (!event) return "none";
  if (event.kind === "agent.loop.completed") return "completed";
  if (event.kind === "agent.loop.cancelled") return "cancelled";
  return "failed";
}

function cliSessionError(code: string, message: string): JsonObject {
  return { code, message, retryable: false, redaction: { class: "public" } };
}

function isForkResult(value: SessionResumeResult | SessionForkResult): value is SessionForkResult {
  return typeof (value as { readonly childSessionId?: unknown }).childSessionId === "string";
}

function renderForkText(result: SessionForkResult): readonly string[] {
  const forkPoint = result.lineage.modeForkPoint;
  const phaseCount = forkPoint?.agentMode?.phaseStatuses.length ?? 0;
  const workerResultCount = forkPoint?.agentMode?.workerResults.length ?? 0;
  const verifierResultCount = forkPoint?.agentMode?.verifierResults.length ?? 0;
  const delegationCount = forkPoint?.agentMode?.delegationDecisions.length ?? 0;
  return [
    `forked ${result.parentSessionId} -> ${result.childSessionId}`,
    `  fork_point sequence=${result.forkPointSequence} inherited_events=${result.inheritedEventCount}`,
    `  mode interaction=${forkPoint?.interactionMode?.mode ?? "unknown"} agent=${forkPoint?.agentMode?.agentMode ?? "unknown"} phase_plan=${forkPoint?.agentMode?.phasePlanId ?? "none"}`,
    `  active_workers policy=${forkPoint?.activeWorkerPolicy ?? "detach"} worker_results=${workerResultCount} delegation_lineage=${delegationCount}`,
    `  phase_summary phases=${phaseCount} budgets=${budgetText(forkPoint?.agentMode?.budgets ?? [])} verifier_results=${verifierResultCount}`
  ];
}

function renderResumeText(result: SessionResumeResult): readonly string[] {
  const mode = result.mode;
  return [
    `resumed ${result.sessionId} (${result.eventCount} events)`,
    `  mode interaction=${mode?.interactionMode?.mode ?? "unknown"} agent=${mode?.agentMode?.agentMode ?? "unknown"} phase_plan=${mode?.agentMode?.phasePlanId ?? "none"}`,
    `  replay budgets=${budgetText(mode?.agentMode?.budgets ?? [])} reasoning_effort=${mode?.agentMode?.reasoningEffort?.providerEffort ?? "none"}`
  ];
}

function renderBoardText(result: SessionBoardResult): readonly string[] {
  return [
    `session board ${result.sessionId}: status=${result.status} steps=${result.summary.totalSteps} tools=${result.summary.toolCallCount} verifications=${result.summary.verificationCount}`,
    ...result.steps.map((step) => `  #${step.sequence} ${step.status} ${step.kind}: ${step.label}`)
  ];
}

function budgetText(budgets: readonly AgentLoopBudget[]): string {
  if (budgets.length === 0) return "none";
  return budgets.map((budget) => `${budget.kind}=${budget.consumed}/${budget.allowed}`).join(",");
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: JsonObject, field: string): string | undefined {
  const item = value[field];
  return typeof item === "string" ? item : undefined;
}
