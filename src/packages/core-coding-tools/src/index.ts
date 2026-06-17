import type { AgentSpawner, BackgroundTaskManager, CapabilityManifest, CapabilityRegistry, HookSystem, PlatformRuntime, RuntimeDependencies, SkillSystem, WebFetchProvider, WebSearchProvider, WorkspaceStateManager } from "@deepseek/platform-contracts";
import type { CoreCodingToolsDependencies } from "./shared/workspace.js";
import type { ToolDefinition } from "./shared/tool-kit.js";
import { defineAgentContinueTool } from "./families/agents-tasks/agent-message-continue/index.js";
import { defineAgentSpawnTool } from "./families/agents-tasks/agent-spawn/index.js";
import { defineAgentStopTool } from "./families/agents-tasks/agent-stop-close/index.js";
import { defineHookListTool } from "./families/extensions-local-commands/hook-list/index.js";
import { defineSkillActivateTool } from "./families/extensions-local-commands/skill-activate/index.js";
import { defineSkillListTool } from "./families/extensions-local-commands/skill-list/index.js";
import { defineGitDiffTool } from "./families/git-build/git-diff/index.js";
import { defineGitHistoryBranchTool } from "./families/git-build/git-history-branch/index.js";
import { defineGitStatusTool } from "./families/git-build/git-status-diff/index.js";
import { definePackageManagerTool } from "./families/git-build/package-manager/index.js";
import { defineTestRunTool } from "./families/git-build/test-run/index.js";
import { defineFileEditTool } from "./families/mutation-patching/file-edit/index.js";
import { definePatchApplyTool } from "./families/mutation-patching/patch-apply/index.js";
import { defineFileWriteTool } from "./families/mutation-patching/file-write/index.js";
import { defineRevertUndoTool } from "./families/mutation-patching/revert-undo/index.js";
import { defineTodoPlanTool } from "./families/planning-control/todo-plan/index.js";
import { defineNotebookReadTool } from "./families/search-code-intelligence/notebook-read/index.js";
import { defineSearchTextTool } from "./families/search-code-intelligence/search-text/index.js";
import { defineShellKillTool } from "./families/shell-process/process-kill/index.js";
import { defineShellOutputTool } from "./families/shell-process/process-output/index.js";
import { defineReplExecuteTool } from "./families/shell-process/repl-execute/index.js";
import { defineShellRunTool } from "./families/shell-process/shell-run/index.js";
import { defineWebFetchTool } from "./families/web-public-data/web-fetch/index.js";
import { defineWebSearchTool } from "./families/web-public-data/web-search/index.js";
import { defineAssetViewLocalTool } from "./families/workspace-io/asset-view-local/index.js";
import { defineFileListTool } from "./families/workspace-io/file-list/index.js";
import { defineFileReadTool } from "./families/workspace-io/file-read/index.js";
import { defineWorkspaceGlobTool } from "./families/workspace-io/workspace-glob/index.js";

export { coreToolIds } from "./shared/ids.js";
export {
  buildToolFamilyParityMatrix,
  coreCapabilityFamilyMappings,
  toolFamilyCatalog,
  toolFamilyCatalogVersion,
  validateToolFamilyCatalog
} from "./catalog/index.js";
export type { ToolFamilyCoverageEvidence } from "./catalog/index.js";
export type { CoreCodingToolsDependencies } from "./shared/workspace.js";
export type { ToolDefinition } from "./shared/tool-kit.js";
export { boundedText, defineToolManifest, objectSchema, replay } from "./shared/tool-kit.js";
export { isPythonTestLikeCommand, isStandardTestCommand } from "./shared/process-command.js";

export interface ExtendedCoreCodingToolsDependencies extends CoreCodingToolsDependencies {
  readonly webFetch?: WebFetchProvider;
  readonly webSearch?: WebSearchProvider;
  readonly backgroundTasks?: BackgroundTaskManager;
  readonly agentSpawner?: AgentSpawner;
  readonly hooks?: HookSystem;
  readonly skills?: SkillSystem;
}

export async function registerCoreCodingTools(registry: CapabilityRegistry, deps: ExtendedCoreCodingToolsDependencies): Promise<void> {
  for (const definition of coreToolDefinitions(deps)) {
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
  readonly agentSpawner?: RuntimeDependencies["agentSpawner"];
  readonly hooks?: RuntimeDependencies["hooks"];
  readonly skills?: RuntimeDependencies["skills"];
  readonly codeIntelligence?: RuntimeDependencies["codeIntelligence"];
}, workspaceRoot: string): Promise<void> {
  await registerCoreCodingTools(deps.capabilities, {
    platform: deps.platform,
    workspaceState: deps.workspaceState,
    workspaceRoot,
    ...(deps.webFetch ? { webFetch: deps.webFetch } : {}),
    ...(deps.webSearch ? { webSearch: deps.webSearch } : {}),
    ...(deps.backgroundTasks ? { backgroundTasks: deps.backgroundTasks } : {}),
    ...(deps.agentSpawner ? { agentSpawner: deps.agentSpawner } : {}),
    ...(deps.hooks ? { hooks: deps.hooks } : {}),
    ...(deps.skills ? { skills: deps.skills } : {}),
    ...(deps.codeIntelligence ? { codeIntelligence: deps.codeIntelligence } : {})
  });
}

export function coreToolManifests(): readonly CapabilityManifest[] {
  return coreToolDefinitions(undefined).map((definition) => definition.manifest);
}

function coreToolDefinitions(deps: ExtendedCoreCodingToolsDependencies | undefined): readonly ToolDefinition[] {
  return [
    defineFileReadTool(deps),
    defineFileWriteTool(deps),
    defineFileEditTool(deps),
    defineFileListTool(deps),
    defineWorkspaceGlobTool(deps),
    defineAssetViewLocalTool(deps),
    defineSearchTextTool(deps),
    defineNotebookReadTool(deps),
    definePatchApplyTool(deps),
    defineRevertUndoTool(deps),
    defineShellRunTool(deps),
    defineShellOutputTool(deps),
    defineShellKillTool(deps),
    defineReplExecuteTool(deps),
    defineGitStatusTool(deps),
    defineGitDiffTool(deps),
    defineGitHistoryBranchTool(deps),
    defineTestRunTool(deps),
    definePackageManagerTool(deps),
    defineTodoPlanTool(),
    defineWebFetchTool(deps),
    defineWebSearchTool(deps),
    defineAgentSpawnTool(deps),
    defineAgentContinueTool(deps),
    defineAgentStopTool(deps),
    defineHookListTool(deps),
    defineSkillListTool(deps),
    defineSkillActivateTool(deps)
  ];
}
