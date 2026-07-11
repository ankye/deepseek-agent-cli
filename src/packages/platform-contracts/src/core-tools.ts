import type { JsonObject, RedactedError, RedactionMetadata } from "./common.js";
import type { AgentId, AgentInstanceId, CapabilityId, SessionId, TurnId } from "./ids.js";
import type { AgentNamespace } from "./agent.js";
import type { AgentDelegationReasonCode, AgentModeName, AgentVerifierVerdict, AgentWorkerResult, AgentWorkerStopReason, AgentWorkOrder } from "./agent-mode.js";
import type { PlatformProviderResultMetadata, ProcessExecutionProfile } from "./platform.js";

export type CoreCodingToolName =
  | "file.read"
  | "file.write"
  | "file.edit"
  | "text.replace"
  | "file.copy"
  | "file.move"
  | "file.delete"
  | "directory.create"
  | "file.touch"
  | "file.stat"
  | "json.read"
  | "json.patch"
  | "checksum.hash"
  | "path.resolve"
  | "env.inspect"
  | "command.lookup"
  | "archive.create"
  | "archive.extract"
  | "session.resume"
  | "session.fork"
  | "memory.write"
  | "memory.read"
  | "compact.summary"
  | "file.list"
  | "workspace.glob"
  | "asset.view-local"
  | "search.text"
  | "code.diagnostics"
  | "notebook.read"
  | "patch.apply"
  | "revert.undo"
  | "shell.run"
  | "shell.output"
  | "shell.kill"
  | "repl.execute"
  | "git.status"
  | "git.diff"
  | "git.history-branch"
  | "test.run"
  | "package.manager"
  | "env.prepare"
  | "todo.plan"
  | "user.input"
  | "mode.plan.enter"
  | "mode.plan.exit"
  | "config.manage"
  | "web.fetch"
  | "web.search"
  | "mcp.tool.call"
  | "mcp.resource.list"
  | "mcp.resource.read"
  | "notebook.edit"
  | "agent.spawn"
  | "agent.continue"
  | "agent.stop"
  | "task.create"
  | "task.get"
  | "task.list"
  | "task.update"
  | "task.output"
  | "team.create"
  | "team.delete"
  | "worktree.enter"
  | "worktree.exit"
  | "tool.search"
  | "schedule.cron"
  | "remote.trigger"
  | "brief.package"
  | "synthetic.output"
  | "hook.list"
  | "hook.run"
  | "plugin.install"
  | "plugin.verify"
  | "command.palette"
  | "skill.list"
  | "skill.activate";

export type CoreCodingToolStatus = "completed" | "failed" | "rejected";
export type PlanItemStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface CoreToolDiagnostic extends RedactedError {
  readonly field?: string;
}

export interface BoundedText extends JsonObject {
  readonly text: string;
  readonly byteLength: number;
  readonly lineCount: number;
  readonly truncated: boolean;
  readonly limitBytes: number;
  readonly redaction: RedactionMetadata;
}

export interface CoreToolEvidence extends JsonObject {
  readonly tool: CoreCodingToolName;
  readonly status: CoreCodingToolStatus;
  readonly affectedPaths: readonly string[];
  readonly preview?: BoundedText;
  readonly provider?: PlatformProviderResultMetadata;
  readonly diagnostics: readonly CoreToolDiagnostic[];
  readonly metadata: JsonObject;
  readonly replay: JsonObject;
  readonly redaction: RedactionMetadata;
}

export interface CoreToolResult extends JsonObject {
  readonly evidence: CoreToolEvidence;
}

export interface FileReadInput extends JsonObject {
  readonly path: string;
  readonly workspaceRoot?: string;
  readonly limitBytes?: number;
  readonly offset?: number;
  readonly limit?: number;
  readonly pages?: string;
}

export interface FileWriteInput extends JsonObject {
  readonly path: string;
  readonly content: string;
  readonly workspaceRoot?: string;
  readonly limitBytes?: number;
}

export interface FileEditInput extends JsonObject {
  readonly path: string;
  readonly expected: string;
  readonly replacement: string;
  readonly workspaceRoot?: string;
  readonly limitBytes?: number;
}

export interface TextReplaceInput extends JsonObject {
  readonly path: string;
  readonly pattern: string;
  readonly replacement: string;
  readonly workspaceRoot?: string;
  readonly limitBytes?: number;
  readonly regex?: boolean;
  readonly caseInsensitive?: boolean;
  readonly multiline?: boolean;
  readonly maxReplacements?: number;
  readonly dryRun?: boolean;
}

export interface FileListInput extends JsonObject {
  readonly pattern?: string;
  readonly path?: string;
  readonly workspaceRoot?: string;
  readonly limit?: number;
  readonly limitBytes?: number;
  readonly sort?: "alpha" | "mtime-desc";
}

export type SearchTextOutputMode = "content" | "files_with_matches" | "count";

export interface SearchTextInput extends JsonObject {
  readonly pattern: string;
  readonly workspaceRoot?: string;
  readonly limit?: number;
  readonly limitBytes?: number;
  readonly contextLines?: number;
  readonly multiline?: boolean;
  readonly glob?: string;
  readonly caseInsensitive?: boolean;
  readonly outputMode?: SearchTextOutputMode;
}

export interface ShellRunInput extends JsonObject {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly workspaceRoot?: string;
  readonly timeoutMs?: number;
  readonly limitBytes?: number;
  readonly shellProfile?: string;
  readonly executionProfile?: ProcessExecutionProfile;
  readonly runInBackground?: boolean;
}

export interface ShellOutputInput extends JsonObject {
  readonly taskId: string;
  readonly offsetBytes?: number;
  readonly limitBytes?: number;
}

export interface ShellKillInput extends JsonObject {
  readonly taskId: string;
}

export interface BackgroundTaskSummary extends JsonObject {
  readonly taskId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly startedAt: string;
  readonly status: "running" | "exited" | "killed" | "failed";
  readonly exitCode?: number;
  readonly done: boolean;
}

export interface BackgroundTaskOutput extends JsonObject {
  readonly taskId: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutOffset: number;
  readonly stderrOffset: number;
  readonly done: boolean;
  readonly exitCode?: number;
  readonly status: BackgroundTaskSummary["status"];
}

export interface BackgroundTaskManager {
  start(input: { readonly command: string; readonly args: readonly string[]; readonly cwd: string }): Promise<BackgroundTaskSummary>;
  output(input: { readonly taskId: string; readonly stdoutOffset?: number; readonly stderrOffset?: number }): Promise<BackgroundTaskOutput>;
  kill(input: { readonly taskId: string }): Promise<BackgroundTaskSummary>;
  list(): Promise<readonly BackgroundTaskSummary[]>;
  disposeAll(): Promise<void>;
}

export interface GitEvidenceInput extends JsonObject {
  readonly workspaceRoot?: string;
  readonly limitBytes?: number;
}

export interface TestRunInput extends JsonObject {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly workspaceRoot?: string;
  readonly timeoutMs?: number;
  readonly limitBytes?: number;
  readonly intent?: string;
  readonly executionProfile?: ProcessExecutionProfile;
}

export interface TodoPlanItem extends JsonObject {
  readonly id: string;
  readonly title: string;
  readonly status: PlanItemStatus;
}

export interface TodoPlanInput extends JsonObject {
  readonly items: readonly TodoPlanItem[];
}

export interface WorkspaceEditTransactionEvidence extends JsonObject {
  readonly id: string;
  readonly sessionId?: SessionId;
  readonly turnId?: TurnId;
  readonly capabilityId: CapabilityId;
  readonly path: string;
  readonly precondition: "exact-match" | "full-write" | "pattern-match";
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly rollback: JsonObject;
  readonly metadata?: JsonObject;
  readonly applied: boolean;
  readonly diagnostics: readonly CoreToolDiagnostic[];
  readonly redaction: RedactionMetadata;
}

export interface WebFetchInput extends JsonObject {
  readonly url: string;
  readonly prompt?: string;
  readonly summarize?: boolean;
  readonly limitBytes?: number;
  readonly followRedirects?: number;
}

export interface WebSearchInput extends JsonObject {
  readonly query: string;
  readonly limit?: number;
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
}

export interface WebSearchResultItem extends JsonObject {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface WebFetchResponseMetadata extends JsonObject {
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly truncated: boolean;
  readonly byteLength: number;
  readonly summarized: boolean;
  readonly redirects: number;
  readonly cached: boolean;
}

export interface WebFetchProvider {
  readonly name: string;
  fetch(input: WebFetchInput): Promise<{
    readonly metadata: WebFetchResponseMetadata;
    readonly markdown: string;
    readonly summary?: string;
  }>;
}

export interface WebSearchProvider {
  readonly name: string;
  search(input: WebSearchInput): Promise<readonly WebSearchResultItem[]>;
}

export type AgentSpawnToolProjection = "read-only" | "read-write" | "safe-all" | "all";

export interface AgentSpawnRequest extends JsonObject {
  readonly prompt: string;
  readonly workOrder?: AgentWorkOrder;
  readonly agentMode?: AgentModeName;
  readonly toolProjection?: AgentSpawnToolProjection;
  readonly toolScope?: JsonObject;
  readonly contextScope?: JsonObject;
  readonly namespace?: AgentNamespace;
  readonly timeoutMs?: number;
  readonly maxIterations?: number;
  readonly parentSessionId?: SessionId;
  readonly parentAgentId?: AgentId;
  readonly parentAgentInstanceId?: AgentInstanceId;
  readonly workOrderId?: string;
  readonly delegationDecisionId?: string;
  readonly reason?: string;
}

export interface AgentSpawnResult extends JsonObject {
  readonly childSessionId: SessionId;
  readonly workerAgentId?: AgentId;
  readonly workerInstanceId?: AgentInstanceId;
  readonly workOrderId?: string;
  readonly agentMode?: AgentModeName;
  readonly terminalStatus: "completed" | "failed" | "cancelled" | "timed-out" | "rejected";
  readonly assistantText: string;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly usage: JsonObject;
  readonly resultProvenance: JsonObject;
  readonly workerResult?: AgentWorkerResult;
  readonly verifierStatus?: AgentVerifierVerdict | "not-run";
  readonly diagnostics: readonly RedactedError[];
}

export interface AgentContinueRequest extends JsonObject {
  readonly workerInstanceId: AgentInstanceId;
  readonly prompt: string;
  readonly workOrder?: AgentWorkOrder;
  readonly workOrderId?: string;
  readonly parentSessionId?: SessionId;
  readonly parentAgentId?: AgentId;
  readonly parentAgentInstanceId?: AgentInstanceId;
  readonly toolProjection?: AgentSpawnToolProjection;
  readonly toolScope?: JsonObject;
  readonly contextScope?: JsonObject;
  readonly namespace?: AgentNamespace;
  readonly timeoutMs?: number;
  readonly maxIterations?: number;
  readonly contextOverlapScore?: number;
  readonly evidenceIds?: readonly string[];
  readonly reasonCode?: AgentDelegationReasonCode;
  readonly reason?: string;
}

export interface AgentContinueResult extends JsonObject {
  readonly childSessionId: SessionId;
  readonly workerAgentId?: AgentId;
  readonly workerInstanceId: AgentInstanceId;
  readonly continuationOf: AgentInstanceId;
  readonly workOrderId?: string;
  readonly agentMode?: AgentModeName;
  readonly terminalStatus: AgentSpawnResult["terminalStatus"];
  readonly assistantText: string;
  readonly iterations: number;
  readonly toolCalls: number;
  readonly usage: JsonObject;
  readonly resultProvenance: JsonObject;
  readonly workerResult?: AgentWorkerResult;
  readonly verifierStatus?: AgentVerifierVerdict | "not-run";
  readonly diagnostics: readonly RedactedError[];
}

export interface AgentStopRequest extends JsonObject {
  readonly workerInstanceId: AgentInstanceId;
  readonly parentSessionId?: SessionId;
  readonly parentAgentId?: AgentId;
  readonly workOrderId?: string;
  readonly stopReason?: AgentWorkerStopReason;
  readonly reason?: string;
}

export interface AgentStopResult extends JsonObject {
  readonly workerInstanceId: AgentInstanceId;
  readonly workerSessionId: SessionId;
  readonly workerAgentId?: AgentId;
  readonly workOrderId?: string;
  readonly lifecycleState: "stopped";
  readonly status: "stopped";
  readonly stopReason: AgentWorkerStopReason;
  readonly usage: JsonObject;
  readonly resultProvenance: JsonObject;
  readonly workerResult: AgentWorkerResult;
  readonly diagnostics: readonly RedactedError[];
}

export interface AgentSpawner {
  spawn(input: AgentSpawnRequest): Promise<AgentSpawnResult>;
  continue?(input: AgentContinueRequest): Promise<AgentContinueResult>;
  stop?(input: AgentStopRequest): Promise<AgentStopResult>;
}
