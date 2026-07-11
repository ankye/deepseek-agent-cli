import type {
  AgentSpawnRequest,
  AgentSpawner,
  AgentStopRequest,
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { requireDeps } from "../../../shared/workspace.js";

interface TeamToolDeps extends CoreCodingToolsDependencies {
  readonly agentSpawner?: AgentSpawner;
}

interface TeamMemberInput extends JsonObject {
  readonly prompt?: string;
  readonly agentMode?: AgentSpawnRequest["agentMode"];
  readonly toolProjection?: AgentSpawnRequest["toolProjection"];
  readonly toolScope?: JsonObject;
  readonly contextScope?: JsonObject;
  readonly timeoutMs?: number;
  readonly maxIterations?: number;
  readonly workOrderId?: string;
  readonly reason?: string;
  readonly workerInstanceId?: string;
}

type TeamToolName = "team.create" | "team.delete";

export function defineTeamCreateTool(deps: TeamToolDeps | undefined) {
  return defineToolManifest(
    "team.create",
    coreToolIds.teamCreate,
    "Team Create",
    "process",
    ["agent:spawn"],
    objectSchema(["members"], {
      teamId: { type: "string" },
      members: { type: "array", items: { type: "object" } },
      reason: { type: "string" },
      parentSessionId: { type: "string" },
      parentAgentId: { type: "string" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => createTeam(input, context, ready as TeamToolDeps))
  );
}

export function defineTeamDeleteTool(deps: TeamToolDeps | undefined) {
  return defineToolManifest(
    "team.delete",
    coreToolIds.teamDelete,
    "Team Delete",
    "process",
    ["agent:stop"],
    objectSchema(["members"], {
      teamId: { type: "string" },
      members: { type: "array", items: { type: "object" } },
      workerInstanceIds: { type: "array", items: { type: "string" } },
      stopReason: { type: "string" },
      reason: { type: "string" },
      parentSessionId: { type: "string" },
      parentAgentId: { type: "string" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => deleteTeam(input, context, ready as TeamToolDeps))
  );
}

async function createTeam(input: JsonObject, context: CapabilityExecutionContext, deps: TeamToolDeps): Promise<SerializableResult<CoreToolResult>> {
  if (!deps.agentSpawner) return failure("team.create", "TEAM_AGENT_SPAWNER_UNAVAILABLE", "AgentSpawner is required for team.create.", []);
  const members = memberInputs(input.members);
  if (members.length === 0) return failure("team.create", "TEAM_MEMBERS_REQUIRED", "members must contain at least one worker prompt.", []);
  const teamId = stringValue(input.teamId) ?? `team:${hashText(`${context.envelope.invocationId}:${members.length}`)}`;
  const reason = stringValue(input.reason);
  const parentSessionId = stringValue(input.parentSessionId) ?? (context.envelope.sessionId ? String(context.envelope.sessionId) : undefined);
  const parentAgentId = stringValue(input.parentAgentId);
  const spawned = [];
  for (const [index, member] of members.entries()) {
    const prompt = stringValue(member.prompt);
    if (!prompt) return failure("team.create", "TEAM_MEMBER_PROMPT_REQUIRED", "Every team member requires a prompt.", []);
    const request: AgentSpawnRequest = {
      prompt,
      ...(member.agentMode ? { agentMode: member.agentMode } : {}),
      ...(member.toolProjection ? { toolProjection: member.toolProjection } : {}),
      ...(member.toolScope ? { toolScope: member.toolScope } : {}),
      ...(member.contextScope ? { contextScope: member.contextScope } : {}),
      ...(typeof member.timeoutMs === "number" ? { timeoutMs: member.timeoutMs } : {}),
      ...(typeof member.maxIterations === "number" ? { maxIterations: member.maxIterations } : {}),
      ...(parentSessionId ? { parentSessionId: asId<"session">(parentSessionId) } : {}),
      ...(parentAgentId ? { parentAgentId: asId<"agent">(parentAgentId) } : {}),
      workOrderId: stringValue(member.workOrderId) ?? `${teamId}:member:${index + 1}`,
      reason: stringValue(member.reason) ?? reason ?? "team.create"
    };
    const result = await deps.agentSpawner.spawn(request);
    spawned.push({
      memberIndex: index,
      prompt,
      childSessionId: String(result.childSessionId),
      ...(result.workerAgentId ? { workerAgentId: String(result.workerAgentId) } : {}),
      ...(result.workerInstanceId ? { workerInstanceId: String(result.workerInstanceId) } : {}),
      ...(result.workOrderId ? { workOrderId: result.workOrderId } : {}),
      terminalStatus: result.terminalStatus,
      iterations: result.iterations,
      toolCalls: result.toolCalls
    });
  }
  return teamSuccess("team.create", context, {
    teamId,
    members: spawned,
    memberCount: spawned.length
  }, spawned.map((member) => `${member.workerInstanceId ?? member.childSessionId}: ${member.terminalStatus}`).join("\n"));
}

async function deleteTeam(input: JsonObject, context: CapabilityExecutionContext, deps: TeamToolDeps): Promise<SerializableResult<CoreToolResult>> {
  if (!deps.agentSpawner?.stop) return failure("team.delete", "TEAM_AGENT_STOP_UNAVAILABLE", "AgentSpawner stop is required for team.delete.", []);
  const teamId = stringValue(input.teamId) ?? "team:unscoped";
  const workerInstanceIds = [
    ...stringArray(input.workerInstanceIds),
    ...memberInputs(input.members).flatMap((member) => stringValue(member.workerInstanceId) ? [stringValue(member.workerInstanceId) as string] : [])
  ];
  const uniqueWorkerInstanceIds = [...new Set(workerInstanceIds)];
  if (uniqueWorkerInstanceIds.length === 0) return failure("team.delete", "TEAM_WORKERS_REQUIRED", "team.delete requires workerInstanceIds or members with workerInstanceId.", []);
  const parentSessionId = stringValue(input.parentSessionId) ?? (context.envelope.sessionId ? String(context.envelope.sessionId) : undefined);
  const parentAgentId = stringValue(input.parentAgentId);
  const stopReason = stopReasonValue(input.stopReason);
  const stopped = [];
  for (const workerInstanceId of uniqueWorkerInstanceIds) {
    const request: AgentStopRequest = {
      workerInstanceId: asId<"agentInstance">(workerInstanceId),
      ...(parentSessionId ? { parentSessionId: asId<"session">(parentSessionId) } : {}),
      ...(parentAgentId ? { parentAgentId: asId<"agent">(parentAgentId) } : {}),
      ...(stopReason ? { stopReason } : {}),
      reason: stringValue(input.reason) ?? "team.delete"
    };
    const result = await deps.agentSpawner.stop(request);
    stopped.push({
      workerInstanceId: String(result.workerInstanceId),
      workerSessionId: String(result.workerSessionId),
      status: result.status,
      stopReason: result.stopReason
    });
  }
  return teamSuccess("team.delete", context, {
    teamId,
    stopped,
    stoppedCount: stopped.length
  }, stopped.map((member) => `${member.workerInstanceId}: ${member.status}`).join("\n"));
}

function teamSuccess(toolName: TeamToolName, context: CapabilityExecutionContext, metadata: JsonObject, preview: string): SerializableResult<CoreToolResult> {
  return success(toolName, [], {
    preview: boundedText(preview, 8_000),
    metadata,
    replay: replay(context)
  });
}

function memberInputs(value: unknown): readonly TeamMemberInput[] {
  return Array.isArray(value) ? value.filter((item): item is TeamMemberInput => typeof item === "object" && item !== null) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function stopReasonValue(value: unknown): AgentStopRequest["stopReason"] | undefined {
  return value === "user-changed-request" ||
    value === "wrong-direction" ||
    value === "budget-exhausted" ||
    value === "policy-denied" ||
    value === "superseded" ||
    value === "manual-stop" ||
    value === "unknown"
    ? value
    : undefined;
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
