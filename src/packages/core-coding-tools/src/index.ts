import type { AgentSpawner, BackgroundTaskManager, CapabilityManifest, CapabilityRegistry, CommandSystem, ConfigStore, ConcurrencyOrchestrator, HookSystem, JsonObject, McpGateway, MemoryManager, PlatformRuntime, PluginManager, RemoteRuntimeConnectivity, RuntimeDependencies, SessionStore, SkillSystem, WebFetchProvider, WebSearchProvider, WorkspaceStateManager } from "@deepseek/platform-contracts";
import type { CoreCodingToolsDependencies } from "./shared/workspace.js";
import type { ToolDefinition } from "./shared/tool-kit.js";
import { InMemoryWorktreeEnvironment } from "@deepseek/workspace-state-management";
import { defineAgentContinueTool } from "./families/agents-tasks/agent-message-continue/index.js";
import { defineAgentSpawnTool } from "./families/agents-tasks/agent-spawn/index.js";
import { defineAgentStopTool } from "./families/agents-tasks/agent-stop-close/index.js";
import { defineTaskCreateTool, defineTaskGetTool, defineTaskListTool, defineTaskOutputTool, defineTaskUpdateTool } from "./families/agents-tasks/task-board/index.js";
import { defineTeamCreateTool, defineTeamDeleteTool } from "./families/agents-tasks/team/index.js";
import { defineCommandPaletteTool } from "./families/extensions-local-commands/command-palette/index.js";
import { defineConfigManageTool } from "./families/extensions-local-commands/config-manage/index.js";
import { defineHookListTool } from "./families/extensions-local-commands/hook-list/index.js";
import { defineHookRunTool } from "./families/extensions-local-commands/hook-run/index.js";
import { definePluginInstallTool, definePluginVerifyTool } from "./families/extensions-local-commands/plugin-install-verify/index.js";
import { defineSkillActivateTool } from "./families/extensions-local-commands/skill-activate/index.js";
import { defineSkillListTool } from "./families/extensions-local-commands/skill-list/index.js";
import { defineGitDiffTool } from "./families/git-build/git-diff/index.js";
import { defineGitHistoryBranchTool } from "./families/git-build/git-history-branch/index.js";
import { defineGitStatusTool } from "./families/git-build/git-status-diff/index.js";
import { definePackageManagerTool } from "./families/git-build/package-manager/index.js";
import { defineTestRunTool } from "./families/git-build/test-run/index.js";
import { defineArchiveCreateTool, defineArchiveExtractTool } from "./families/mutation-patching/archive/index.js";
import { defineFileEditTool } from "./families/mutation-patching/file-edit/index.js";
import { defineFileCopyTool, defineFileDeleteTool, defineFileMoveTool } from "./families/mutation-patching/file-path-mutation/index.js";
import { defineDirectoryCreateTool, defineFileTouchTool } from "./families/mutation-patching/filesystem-structure/index.js";
import { definePatchApplyTool } from "./families/mutation-patching/patch-apply/index.js";
import { defineJsonPatchTool } from "./families/mutation-patching/json-patch/index.js";
import { defineTextReplaceTool } from "./families/mutation-patching/text-replace/index.js";
import { defineFileWriteTool } from "./families/mutation-patching/file-write/index.js";
import { defineRevertUndoTool } from "./families/mutation-patching/revert-undo/index.js";
import { defineMcpResourceListTool, defineMcpResourceReadTool, defineMcpToolCallTool } from "./families/mcp-connectors/mcp-gateway/index.js";
import { defineMemoryReadTool, defineMemoryWriteTool } from "./families/memory-context-session/memory-read-write/index.js";
import { defineCompactSummaryTool } from "./families/memory-context-session/compact-summary/index.js";
import { defineSessionForkTool, defineSessionResumeTool } from "./families/memory-context-session/session-resume-fork/index.js";
import { defineToolSearchTool } from "./families/memory-context-session/tool-search/index.js";
import { defineBriefPackageTool, defineSyntheticOutputTool } from "./families/pipeline-composition/artifacts/index.js";
import { defineModePlanEnterTool, defineModePlanExitTool } from "./families/planning-control/mode-plan/index.js";
import { defineTodoPlanTool } from "./families/planning-control/todo-plan/index.js";
import { defineUserInputTool } from "./families/planning-control/user-input/index.js";
import type { CoreUserInputDecision, CoreUserInputRequest } from "./families/planning-control/user-input/index.js";
import { defineRemoteTriggerTool } from "./families/remote-scheduling-observability/remote-trigger/index.js";
import { defineScheduleCronTool } from "./families/remote-scheduling-observability/schedule-cron/index.js";
import { defineWorktreeEnterTool, defineWorktreeExitTool } from "./families/remote-scheduling-observability/worktree/index.js";
import { defineCodeDiagnosticsTool } from "./families/search-code-intelligence/code-diagnostics/index.js";
import { defineNotebookEditTool } from "./families/search-code-intelligence/notebook-edit/index.js";
import { defineNotebookReadTool } from "./families/search-code-intelligence/notebook-read/index.js";
import { defineSearchTextTool } from "./families/search-code-intelligence/search-text/index.js";
import { defineShellKillTool } from "./families/shell-process/process-kill/index.js";
import { defineShellOutputTool } from "./families/shell-process/process-output/index.js";
import { defineReplExecuteTool } from "./families/shell-process/repl-execute/index.js";
import { defineCommandLookupTool } from "./families/shell-process/command-lookup/index.js";
import { defineEnvInspectTool } from "./families/shell-process/env-inspect/index.js";
import { defineShellRunTool } from "./families/shell-process/shell-run/index.js";
import { defineWebFetchTool } from "./families/web-public-data/web-fetch/index.js";
import { defineWebSearchTool } from "./families/web-public-data/web-search/index.js";
import { defineAssetViewLocalTool } from "./families/workspace-io/asset-view-local/index.js";
import { defineChecksumHashTool } from "./families/workspace-io/checksum-hash/index.js";
import { defineFileListTool } from "./families/workspace-io/file-list/index.js";
import { defineFileReadTool } from "./families/workspace-io/file-read/index.js";
import { defineFileStatTool } from "./families/workspace-io/file-stat/index.js";
import { defineJsonReadTool } from "./families/workspace-io/json-read/index.js";
import { definePathResolveTool } from "./families/workspace-io/path-resolve/index.js";
import { defineWorkspaceGlobTool } from "./families/workspace-io/workspace-glob/index.js";

export { coreToolIds } from "./shared/ids.js";
export {
  buildToolFamilyParityMatrix,
  buildReferenceToolArsenalReadiness,
  buildReferenceToolArsenalReport,
  coreCapabilityFamilyMappings,
  referenceToolArsenalMatrix,
  toolFamilyCatalog,
  toolFamilyCatalogVersion,
  validateToolFamilyCatalog
} from "./catalog/index.js";
export type { ReferenceToolArsenalMapping, ReferenceToolArsenalReadiness, ReferenceToolArsenalReadinessBlocker, ReferenceToolArsenalReport, ReferenceToolArsenalReportEntry, ReferenceToolCompletionState, ToolFamilyCoverageEvidence } from "./catalog/index.js";
export type { CoreCodingToolsDependencies } from "./shared/workspace.js";
export type { ToolDefinition } from "./shared/tool-kit.js";
export { boundedText, defineToolManifest, objectSchema, replay } from "./shared/tool-kit.js";
export { isPythonTestLikeCommand, isStandardTestCommand } from "./shared/process-command.js";

export interface ExtendedCoreCodingToolsDependencies extends CoreCodingToolsDependencies {
  readonly capabilities?: CapabilityRegistry;
  readonly webFetch?: WebFetchProvider;
  readonly webSearch?: WebSearchProvider;
  readonly backgroundTasks?: BackgroundTaskManager;
  readonly scheduler?: ConcurrencyOrchestrator;
  readonly agentSpawner?: AgentSpawner;
  readonly sessions?: SessionStore;
  readonly memory?: MemoryManager;
  readonly worktrees?: InMemoryWorktreeEnvironment;
  readonly hooks?: HookSystem;
  readonly plugins?: PluginManager;
  readonly skills?: SkillSystem;
  readonly commands?: CommandSystem;
  readonly userInput?: {
    requestInput(request: CoreUserInputRequest): Promise<CoreUserInputDecision>;
  };
  readonly config?: ConfigStore;
  readonly mcp?: McpGateway;
  readonly remote?: RemoteRuntimeConnectivity;
}

export async function registerCoreCodingTools(registry: CapabilityRegistry, deps: ExtendedCoreCodingToolsDependencies): Promise<void> {
  for (const definition of coreToolDefinitions({ ...deps, capabilities: deps.capabilities ?? registry })) {
    if (await registry.get(definition.manifest.id)) continue;
    await registry.register(definition.manifest, definition.execute);
  }
}

export async function registerCoreCodingToolsForRuntime(deps: {
  readonly capabilities: CapabilityRegistry;
  readonly platform: PlatformRuntime;
  readonly workspaceState: WorkspaceStateManager;
  readonly webFetch?: RuntimeDependencies["webFetch"];
  readonly webSearch?: RuntimeDependencies["webSearch"];
  readonly backgroundTasks?: RuntimeDependencies["backgroundTasks"];
  readonly concurrency?: RuntimeDependencies["concurrency"];
  readonly agentSpawner?: RuntimeDependencies["agentSpawner"];
  readonly sessions?: RuntimeDependencies["sessions"];
  readonly memory?: RuntimeDependencies["memory"];
  readonly worktrees?: InMemoryWorktreeEnvironment;
  readonly hooks?: RuntimeDependencies["hooks"];
  readonly skills?: RuntimeDependencies["skills"];
  readonly commands?: RuntimeDependencies["commands"];
  readonly codeIntelligence?: RuntimeDependencies["codeIntelligence"];
  readonly config?: RuntimeDependencies["config"];
  readonly mcp?: RuntimeDependencies["mcp"];
  readonly remote?: RuntimeDependencies["remote"];
  readonly plugins?: RuntimeDependencies["plugins"];
}, workspaceRoot: string): Promise<void> {
  await registerCoreCodingTools(deps.capabilities, {
    capabilities: deps.capabilities,
    platform: deps.platform,
    workspaceState: deps.workspaceState,
    workspaceRoot,
    ...(deps.webFetch ? { webFetch: deps.webFetch } : {}),
    ...(deps.webSearch ? { webSearch: deps.webSearch } : {}),
    ...(deps.backgroundTasks ? { backgroundTasks: deps.backgroundTasks } : {}),
    ...(deps.concurrency ? { scheduler: deps.concurrency } : {}),
    ...(deps.agentSpawner ? { agentSpawner: deps.agentSpawner } : {}),
    ...(deps.sessions ? { sessions: deps.sessions } : {}),
    ...(deps.memory ? { memory: deps.memory } : {}),
    ...(deps.worktrees ? { worktrees: deps.worktrees } : {}),
    ...(deps.hooks ? { hooks: deps.hooks } : {}),
    ...(deps.skills ? { skills: deps.skills } : {}),
    ...(deps.commands ? { commands: deps.commands } : {}),
    ...(deps.codeIntelligence ? { codeIntelligence: deps.codeIntelligence } : {}),
    ...(deps.config ? { config: deps.config } : {}),
    ...(deps.mcp ? { mcp: deps.mcp } : {}),
    ...(deps.remote ? { remote: deps.remote } : {}),
    ...(deps.plugins ? { plugins: deps.plugins } : {})
  });
}

export function coreToolManifests(): readonly CapabilityManifest[] {
  return coreToolDefinitions(undefined).map((definition) => definition.manifest);
}

function coreToolDefinitions(deps: ExtendedCoreCodingToolsDependencies | undefined): readonly ToolDefinition[] {
  const effectiveDeps = deps
    ? { ...deps, worktrees: deps.worktrees ?? new InMemoryWorktreeEnvironment() }
    : undefined;
  return [
    defineFileReadTool(effectiveDeps),
    defineFileWriteTool(effectiveDeps),
    defineFileEditTool(effectiveDeps),
    defineTextReplaceTool(effectiveDeps),
    defineFileListTool(effectiveDeps),
    defineFileStatTool(effectiveDeps),
    defineJsonReadTool(effectiveDeps),
    defineChecksumHashTool(effectiveDeps),
    definePathResolveTool(effectiveDeps),
    defineWorkspaceGlobTool(effectiveDeps),
    defineAssetViewLocalTool(effectiveDeps),
    defineSearchTextTool(effectiveDeps),
    defineCodeDiagnosticsTool(effectiveDeps),
    defineNotebookReadTool(effectiveDeps),
    defineNotebookEditTool(effectiveDeps),
    definePatchApplyTool(effectiveDeps),
    defineJsonPatchTool(effectiveDeps),
    defineArchiveCreateTool(effectiveDeps),
    defineArchiveExtractTool(effectiveDeps),
    defineSessionResumeTool(effectiveDeps),
    defineSessionForkTool(effectiveDeps),
    defineMemoryWriteTool(effectiveDeps),
    defineMemoryReadTool(effectiveDeps),
    defineCompactSummaryTool(effectiveDeps),
    defineRevertUndoTool(effectiveDeps),
    defineFileCopyTool(effectiveDeps),
    defineFileMoveTool(effectiveDeps),
    defineFileDeleteTool(effectiveDeps),
    defineDirectoryCreateTool(effectiveDeps),
    defineFileTouchTool(effectiveDeps),
    defineToolSearchTool(effectiveDeps),
    defineShellRunTool(effectiveDeps),
    defineShellOutputTool(effectiveDeps),
    defineShellKillTool(effectiveDeps),
    defineReplExecuteTool(effectiveDeps),
    defineEnvInspectTool(effectiveDeps),
    defineCommandLookupTool(effectiveDeps),
    defineGitStatusTool(effectiveDeps),
    defineGitDiffTool(effectiveDeps),
    defineGitHistoryBranchTool(effectiveDeps),
    defineTestRunTool(effectiveDeps),
    definePackageManagerTool(effectiveDeps),
    defineTodoPlanTool(),
    defineUserInputTool(effectiveDeps),
    defineModePlanEnterTool(effectiveDeps),
    defineModePlanExitTool(effectiveDeps),
    defineConfigManageTool(effectiveDeps),
    defineBriefPackageTool(),
    defineSyntheticOutputTool(),
    defineWebFetchTool(effectiveDeps),
    defineWebSearchTool(effectiveDeps),
    defineMcpToolCallTool(effectiveDeps),
    defineMcpResourceListTool(effectiveDeps),
    defineMcpResourceReadTool(effectiveDeps),
    defineAgentSpawnTool(effectiveDeps),
    defineAgentContinueTool(effectiveDeps),
    defineAgentStopTool(effectiveDeps),
    defineTaskCreateTool(effectiveDeps),
    defineTaskGetTool(effectiveDeps),
    defineTaskListTool(effectiveDeps),
    defineTaskUpdateTool(effectiveDeps),
    defineTaskOutputTool(effectiveDeps),
    defineTeamCreateTool(effectiveDeps),
    defineTeamDeleteTool(effectiveDeps),
    defineWorktreeEnterTool(effectiveDeps),
    defineWorktreeExitTool(effectiveDeps),
    defineScheduleCronTool(effectiveDeps),
    defineRemoteTriggerTool(effectiveDeps),
    defineHookListTool(effectiveDeps),
    defineHookRunTool(effectiveDeps),
    definePluginInstallTool(effectiveDeps),
    definePluginVerifyTool(effectiveDeps),
    defineSkillListTool(effectiveDeps),
    defineSkillActivateTool(effectiveDeps),
    defineCommandPaletteTool(effectiveDeps)
  ];
}
