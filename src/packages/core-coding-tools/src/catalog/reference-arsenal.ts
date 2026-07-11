import type { JsonObject, ToolFamilyCatalog, ToolFamilyId } from "@deepseek/platform-contracts";
import { toolFamilyCatalog } from "./families.js";
import { coreToolIds } from "../shared/ids.js";

export type ReferenceToolCompletionState =
  | "executable"
  | "adapter-unavailable-with-diagnostics"
  | "not-yet-implemented";

export interface ReferenceToolArsenalMapping extends JsonObject {
  readonly referenceTool: string;
  readonly referenceCapability: string;
  readonly deepSeekFamilyId: ToolFamilyId;
  readonly owner: string;
  readonly projectionPolicy: string;
  readonly verificationCommand: string;
  readonly completionState: ReferenceToolCompletionState;
}

export interface ReferenceToolArsenalReportEntry extends ReferenceToolArsenalMapping {
  readonly familyPresent: boolean;
  readonly executableCapabilityIds: readonly string[];
  readonly coreExecutableCapabilityIds: readonly string[];
  readonly externalAdapterCapabilityIds: readonly string[];
  readonly executionBoundary: "builtin-core" | "external-adapter" | "unavailable";
  readonly missingEvidence: readonly string[];
  readonly nextAction: string;
}

export interface ReferenceToolArsenalReport extends JsonObject {
  readonly totalReferenceToolCount: number;
  readonly executableReferenceToolCount: number;
  readonly builtinExecutableReferenceToolCount: number;
  readonly externalAdapterExecutableReferenceToolCount: number;
  readonly adapterUnavailableReferenceToolCount: number;
  readonly notYetImplementedReferenceToolCount: number;
  readonly unmappedReferenceToolCount: number;
  readonly entries: readonly ReferenceToolArsenalReportEntry[];
  readonly nextActions: readonly string[];
  readonly redaction: { readonly class: "internal" };
}

export interface ReferenceToolArsenalReadinessBlocker extends JsonObject {
  readonly familyId: ToolFamilyId;
  readonly reason: ReferenceToolCompletionState | "family-not-mapped";
  readonly referenceTools: readonly string[];
  readonly nextAction: string;
}

export interface ReferenceToolArsenalReadiness extends JsonObject {
  readonly profileId: string;
  readonly ready: boolean;
  readonly requiredFamilyIds: readonly ToolFamilyId[];
  readonly readyFamilyIds: readonly ToolFamilyId[];
  readonly blockingFamilyIds: readonly ToolFamilyId[];
  readonly blockers: readonly ReferenceToolArsenalReadinessBlocker[];
  readonly redaction: { readonly class: "internal" };
}

export const referenceToolArsenalMatrix: readonly ReferenceToolArsenalMapping[] = [
  mapping("AgentTool", "spawn and supervise subagents", "agent.spawn", "runtime.agent-manager", "stage/projected orchestration", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("AskUserQuestionTool", "request structured user input", "user.input", "runtime.host-adapter", "interactive host with headless diagnostics", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("BashTool", "run POSIX shell commands", "shell.run", "core-coding-tools", "read-write/process profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("PowerShellTool", "run PowerShell commands", "shell.run", "platform-abstraction", "platform shell profile", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("FileReadTool", "read bounded workspace files and assets", "file.read", "core-coding-tools", "read/read-write profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("FileWriteTool", "write literal workspace artifacts", "file.write", "core-coding-tools", "write/artifact stages", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("FileEditTool", "apply exact file edits", "file.edit", "core-coding-tools", "mutation stages", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("SedTool", "replace text across workspace files", "file.edit", "core-coding-tools", "governed cross-platform text replacement", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("GlobTool", "glob workspace files", "workspace.glob", "core-coding-tools", "read/search stages", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("GrepTool", "search workspace text", "search.text", "core-coding-tools", "read/search stages", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("LSPTool", "query diagnostics and symbols", "code.diagnostics-lsp", "code-intelligence", "code intelligence diagnostics provider", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("NotebookEditTool", "read and mutate notebooks", "notebook.read", "core-coding-tools", "notebook-capable stages", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("MCPTool", "call MCP tools", "mcp.tool-call", "mcp-gateway", "connector projected when configured", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("McpAuthTool", "authenticate MCP servers", "mcp.server-lifecycle", "mcp-gateway", "connector auth flow", "npx tsx --test src/packages/mcp-gateway/src/index.test.ts", "executable"),
  mapping("McpPromptTool", "render MCP prompts", "mcp.prompt", "mcp-gateway", "connector projected when configured", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("ListMcpResourcesTool", "list MCP resources", "mcp.resource-read", "mcp-gateway", "connector projected when configured", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("ReadMcpResourceTool", "read MCP resources", "mcp.resource-read", "mcp-gateway", "connector projected when configured", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("WebFetchTool", "fetch public web content", "web.fetch", "core-coding-tools", "network opt-in", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("WebSearchTool", "search public web data", "web.search", "core-coding-tools", "network opt-in", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("WebExtractTool", "extract public web content", "web.extract", "model-gateway", "provider projected when configured", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("WebDataLookupTool", "lookup public web data", "web.data-lookup", "model-gateway", "provider projected when configured", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("BrowserNavigateTool", "navigate browser pages", "browser.navigate", "mcp-gateway", "browser connector profile", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("BrowserInteractTool", "interact with browser pages", "browser.interact", "mcp-gateway", "browser connector profile", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("BrowserInspectTool", "inspect browser pages", "browser.inspect", "mcp-gateway", "browser connector profile", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("BrowserScreenshotTool", "capture browser screenshots", "browser.screenshot", "mcp-gateway", "browser connector profile", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("ImageGenerateTool", "generate images", "image.generate", "model-gateway", "media provider profile", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("ImageEditTool", "edit images", "image.edit", "model-gateway", "media provider profile", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("ImageSearchStockTool", "search stock images", "image.search-stock", "model-gateway", "media provider profile", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("ImageInspectTool", "inspect images", "image.inspect", "model-gateway", "media provider profile", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("DesignDocumentStateTool", "read design document state", "design.document-state", "mcp-gateway", "design connector profile", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("DesignNodeQueryTool", "query design nodes", "design.node-query", "mcp-gateway", "design connector profile", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("DesignBatchEditTool", "batch edit designs", "design.batch-edit", "mcp-gateway", "design connector profile", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("DesignExportSnapshotTool", "export design snapshots", "design.export-snapshot", "mcp-gateway", "design connector profile", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("TodoWriteTool", "update structured todo plan", "plan.todo", "core-coding-tools", "all engineering profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("TaskCreateTool", "create task-board item", "agent.wait-result", "runtime.agent-manager", "task-board profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("TaskGetTool", "read task-board item", "agent.wait-result", "runtime.agent-manager", "task-board profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("TaskListTool", "list task-board items", "agent.wait-result", "runtime.agent-manager", "task-board profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("TaskUpdateTool", "update task-board item", "agent.wait-result", "runtime.agent-manager", "task-board profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("TaskOutputTool", "package task output", "agent.wait-result", "runtime.agent-manager", "terminal task stages", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("TaskStopTool", "stop or close task", "agent.stop-close", "runtime.agent-manager", "orchestration stages", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("TeamCreateTool", "create agent team", "agent.spawn", "runtime.agent-manager", "parallel orchestration profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("TeamDeleteTool", "delete agent team", "agent.stop-close", "runtime.agent-manager", "parallel orchestration profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("SkillTool", "activate skills", "skill.list-activate", "core-coding-tools", "skill-capable profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("ToolSearchTool", "discover deferred tools", "context.project-index", "context-engine", "large tool pool profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("ConfigTool", "inspect or update config", "command.palette-slash", "command-system", "config store projection", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("EnterPlanModeTool", "enter plan mode", "mode.plan-auto-review", "runtime.workflow", "session-scoped planning profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("ExitPlanModeTool", "exit plan mode", "mode.plan-auto-review", "runtime.workflow", "session-scoped planning profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("EnterWorktreeTool", "enter isolated worktree", "worktree.environment", "workspace-state-management", "worktree profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("ExitWorktreeTool", "exit isolated worktree", "worktree.environment", "workspace-state-management", "worktree profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("ScheduleCronTool", "create/list/delete schedules", "schedule.sleep-cron", "concurrency-orchestration", "scheduler profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("RemoteTriggerTool", "trigger remote runtime work", "remote.runtime", "platform-abstraction", "remote connector profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("BriefTool", "package a brief artifact", "pipeline.artifact-routing", "runtime.pipeline", "artifact/report stages", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable"),
  mapping("SyntheticOutputTool", "enforce structured output", "pipeline.artifact-routing", "runtime.pipeline", "structured output profiles", "npx tsx --test src/packages/core-coding-tools/src/index.test.ts", "executable")
] as const;

export function buildReferenceToolArsenalReport(
  catalog: ToolFamilyCatalog = toolFamilyCatalog,
  matrix: readonly ReferenceToolArsenalMapping[] = referenceToolArsenalMatrix
): ReferenceToolArsenalReport {
  const families = new Map(catalog.families.map((family) => [family.familyId, family]));
  const coreCapabilityIds = new Set<string>(Object.values(coreToolIds).map(String));
  const entries = matrix.map((entry): ReferenceToolArsenalReportEntry => {
    const family = families.get(entry.deepSeekFamilyId);
    const executableCapabilityIds = family?.tools.filter((tool) => tool.executable).map((tool) => String(tool.capabilityId)) ?? [];
    const coreExecutableCapabilityIds = executableCapabilityIds.filter((id) => coreCapabilityIds.has(id));
    const externalAdapterCapabilityIds = executableCapabilityIds.filter((id) => !coreCapabilityIds.has(id));
    const executionBoundary = coreExecutableCapabilityIds.length > 0
      ? "builtin-core"
      : externalAdapterCapabilityIds.length > 0
        ? "external-adapter"
        : "unavailable";
    const missingEvidence = [
      ...(family ? [] : ["family-not-registered"]),
      ...(entry.completionState === "executable" && executableCapabilityIds.length === 0 ? ["no-executable-capability"] : []),
      ...(entry.completionState === "adapter-unavailable-with-diagnostics" ? ["adapter-diagnostic-required"] : []),
      ...(entry.completionState === "not-yet-implemented" ? ["implementation-required"] : [])
    ];
    return {
      ...entry,
      familyPresent: Boolean(family),
      executableCapabilityIds,
      coreExecutableCapabilityIds,
      externalAdapterCapabilityIds,
      executionBoundary,
      missingEvidence,
      nextAction: nextAction(entry, Boolean(family), executableCapabilityIds)
    };
  });

  return {
    totalReferenceToolCount: entries.length,
    executableReferenceToolCount: entries.filter((entry) => entry.completionState === "executable").length,
    builtinExecutableReferenceToolCount: entries.filter((entry) => entry.completionState === "executable" && entry.executionBoundary === "builtin-core").length,
    externalAdapterExecutableReferenceToolCount: entries.filter((entry) => entry.completionState === "executable" && entry.executionBoundary === "external-adapter").length,
    adapterUnavailableReferenceToolCount: entries.filter((entry) => entry.completionState === "adapter-unavailable-with-diagnostics").length,
    notYetImplementedReferenceToolCount: entries.filter((entry) => entry.completionState === "not-yet-implemented").length,
    unmappedReferenceToolCount: entries.filter((entry) => !entry.familyPresent).length,
    entries,
    nextActions: entries.filter((entry) => entry.nextAction.length > 0).map((entry) => entry.nextAction),
    redaction: { class: "internal" }
  };
}

export function buildReferenceToolArsenalReadiness(input: {
  readonly profileId: string;
  readonly requiredFamilyIds: readonly ToolFamilyId[];
  readonly availableCapabilityIds?: readonly string[];
  readonly report?: ReferenceToolArsenalReport;
  readonly catalog?: ToolFamilyCatalog;
}): ReferenceToolArsenalReadiness {
  const report = input.report ?? buildReferenceToolArsenalReport();
  const catalog = input.catalog ?? toolFamilyCatalog;
  const coreCapabilityIds = new Set<string>(Object.values(coreToolIds).map(String));
  const availableCapabilityIds = new Set<string>([
    ...coreCapabilityIds,
    ...(input.availableCapabilityIds ?? [])
  ]);
  const entriesByFamily = new Map<ToolFamilyId, ReferenceToolArsenalReportEntry[]>();
  for (const entry of report.entries) {
    const list = entriesByFamily.get(entry.deepSeekFamilyId) ?? [];
    list.push(entry);
    entriesByFamily.set(entry.deepSeekFamilyId, list);
  }

  const readyFamilyIds: ToolFamilyId[] = [];
  const blockers: ReferenceToolArsenalReadinessBlocker[] = [];
  for (const familyId of input.requiredFamilyIds) {
    const entries = entriesByFamily.get(familyId) ?? [];
    const executable = entries.filter((entry) =>
      entry.completionState === "executable"
      && entry.executableCapabilityIds.some((capabilityId) => availableCapabilityIds.has(capabilityId))
    );
    if (executable.length > 0) {
      readyFamilyIds.push(familyId);
      continue;
    }
    const catalogFamily = catalog.families.find((family) => family.familyId === familyId);
    if (entries.length === 0 && catalogFamily?.tools.some((tool) => tool.executable && availableCapabilityIds.has(String(tool.capabilityId)))) {
      readyFamilyIds.push(familyId);
      continue;
    }
    const first = entries[0];
    const anyExecutable = entries.some((entry) => entry.completionState === "executable");
    blockers.push({
      familyId,
      reason: anyExecutable ? "adapter-unavailable-with-diagnostics" : first?.completionState ?? "family-not-mapped",
      referenceTools: entries.map((entry) => entry.referenceTool),
      nextAction:
        (anyExecutable ? `Configure or project executable adapter capability for ${familyId}` : entries.map((entry) => entry.nextAction).filter(Boolean).join("; "))
        || (catalogFamily?.tools.some((tool) => tool.executable && availableCapabilityIds.has(String(tool.capabilityId)))
          ? `Add reference coverage for ${familyId} and keep the executable catalog family projected`
          : `Map and implement required family ${familyId}`)
    });
  }

  return {
    profileId: input.profileId,
    ready: blockers.length === 0,
    requiredFamilyIds: input.requiredFamilyIds,
    readyFamilyIds,
    blockingFamilyIds: blockers.map((blocker) => blocker.familyId),
    blockers,
    redaction: { class: "internal" }
  };
}

function mapping(
  referenceTool: string,
  referenceCapability: string,
  deepSeekFamilyId: ToolFamilyId,
  owner: string,
  projectionPolicy: string,
  verificationCommand: string,
  completionState: ReferenceToolCompletionState
): ReferenceToolArsenalMapping {
  return { referenceTool, referenceCapability, deepSeekFamilyId, owner, projectionPolicy, verificationCommand, completionState };
}

function nextAction(entry: ReferenceToolArsenalMapping, familyPresent: boolean, executableCapabilityIds: readonly string[]): string {
  if (!familyPresent) return `${entry.referenceTool}: register family ${entry.deepSeekFamilyId}`;
  if (entry.completionState === "not-yet-implemented") return `${entry.referenceTool}: implement ${entry.deepSeekFamilyId} executor and tests`;
  if (entry.completionState === "adapter-unavailable-with-diagnostics") return `${entry.referenceTool}: add typed unavailable diagnostics and connector smoke tests for ${entry.deepSeekFamilyId}`;
  if (executableCapabilityIds.length === 0) return `${entry.referenceTool}: add executable capability for ${entry.deepSeekFamilyId}`;
  return "";
}
