import type {
  CapabilityId,
  CapabilityToolFamilyMetadata,
  JsonObject,
  ToolFamilyCatalog,
  ToolFamilyConnectorKind,
  ToolFamilyDefinition,
  ToolFamilyDomainDefinition,
  ToolFamilyDomainId,
  ToolFamilyId,
  ToolFamilyOperationProfile,
  ToolFamilyRiskClass,
  ToolFamilyToolDefinition
} from "@deepseek/platform-contracts";
import {
  TOOL_FAMILY_CATALOG_SCHEMA_VERSION,
  TOOL_FAMILY_DOMAIN_IDS,
  TOOL_FAMILY_IDS,
  asId
} from "@deepseek/platform-contracts";
import { coreToolIds } from "../shared/ids.js";

export const toolFamilyCatalogVersion = "2026-05-15.v1";

const familyCapabilityIds = {
  searchSymbol: asId<"capability">("code-intelligence.search-symbol"),
  codeDiagnosticsLsp: asId<"capability">("code-intelligence.diagnostics-lsp"),
  modePlanAutoReview: asId<"capability">("runtime.mode.plan-auto-review"),
  userInput: asId<"capability">("runtime.user.input"),
  approvalPermission: asId<"capability">("runtime.approval.permission"),
  pipelineSequence: asId<"capability">("runtime.pipeline.sequence"),
  pipelineParallel: asId<"capability">("runtime.pipeline.parallel"),
  pipelineArtifactRouting: asId<"capability">("runtime.pipeline.artifact-routing"),
  pipelineStream: asId<"capability">("runtime.pipeline.stream"),
  agentWaitResult: asId<"capability">("runtime.agent.wait-result"),
  webExtract: asId<"capability">("model-gateway.web-extract"),
  webDataLookup: asId<"capability">("model-gateway.web-data-lookup"),
  browserNavigate: asId<"capability">("mcp-gateway.browser-navigate"),
  browserInteract: asId<"capability">("mcp-gateway.browser-interact"),
  browserInspect: asId<"capability">("mcp-gateway.browser-inspect"),
  browserScreenshot: asId<"capability">("mcp-gateway.browser-screenshot"),
  mcpServerLifecycle: asId<"capability">("mcp-gateway.mcp-server-lifecycle"),
  mcpToolCall: asId<"capability">("mcp-gateway.mcp-tool-call"),
  mcpResourceRead: asId<"capability">("mcp-gateway.mcp-resource-read"),
  mcpPrompt: asId<"capability">("mcp-gateway.mcp-prompt"),
  hookListRun: asId<"capability">("hook-system.list-run"),
  pluginInstallVerify: asId<"capability">("skill-system.plugin-install-verify"),
  commandPaletteSlash: asId<"capability">("command-system.palette-slash"),
  envPrepare: asId<"capability">("core.env.prepare"),
  sweBenchRun: asId<"capability">("core.swe.bench.run"),
  imageGenerate: asId<"capability">("model-gateway.image-generate"),
  imageEdit: asId<"capability">("model-gateway.image-edit"),
  imageSearchStock: asId<"capability">("model-gateway.image-search-stock"),
  imageInspect: asId<"capability">("model-gateway.image-inspect"),
  designDocumentState: asId<"capability">("mcp-gateway.design-document-state"),
  designNodeQuery: asId<"capability">("mcp-gateway.design-node-query"),
  designBatchEdit: asId<"capability">("mcp-gateway.design-batch-edit"),
  designExportSnapshot: asId<"capability">("mcp-gateway.design-export-snapshot"),
  memoryReadWrite: asId<"capability">("memory-cache-management.memory-read-write"),
  contextProjectIndex: asId<"capability">("context-engine.project-index"),
  sessionResumeFork: asId<"capability">("session-store.resume-fork"),
  compactSummary: asId<"capability">("memory-cache-management.compact-summary"),
  remoteRuntime: asId<"capability">("platform-abstraction.remote-runtime"),
  worktreeEnvironment: asId<"capability">("workspace-state-management.worktree-environment"),
  scheduleSleepCron: asId<"capability">("concurrency-orchestration.sleep-cron"),
  observabilityTraceBudget: asId<"capability">("observability.trace-budget")
} as const;

const domains = [
  domain("workspace-io", "Workspace I/O", ["file.read", "file.list", "workspace.glob", "asset.view-local"]),
  domain("search-code-intelligence", "Search and code intelligence", ["search.text", "search.symbol", "code.diagnostics-lsp", "notebook.read"]),
  domain("mutation-patching", "Mutation and patching", ["file.write", "file.edit", "patch.apply", "revert.undo"]),
  domain("shell-process", "Shell and process", ["shell.run", "process.output", "process.kill", "repl.execute"]),
  domain("git-build", "Git and build", ["git.status-diff", "git.history-branch", "build.test-lint-typecheck", "package.manager", "benchmark.run"]),
  domain("planning-control", "Planning and control", ["plan.todo", "mode.plan-auto-review", "user.input", "approval.permission"]),
  domain("pipeline-composition", "Pipeline and composition", ["pipeline.sequence", "pipeline.parallel", "pipeline.artifact-routing", "pipeline.stream"]),
  domain("agents-tasks", "Agents and tasks", ["agent.spawn", "agent.message-continue", "agent.wait-result", "agent.stop-close"]),
  domain("web-public-data", "Web and public data", ["web.search", "web.fetch", "web.extract", "web.data-lookup"]),
  domain("browser-automation", "Browser automation", ["browser.navigate", "browser.interact", "browser.inspect", "browser.screenshot"]),
  domain("mcp-connectors", "MCP connectors", ["mcp.server-lifecycle", "mcp.tool-call", "mcp.resource-read", "mcp.prompt"]),
  domain("extensions-local-commands", "Extensions and local commands", ["skill.list-activate", "hook.list-run", "plugin.install-verify", "command.palette-slash"]),
  domain("media-images", "Media and images", ["image.generate", "image.edit", "image.search-stock", "image.inspect"]),
  domain("design-canvas", "Design and canvas", ["design.document-state", "design.node-query", "design.batch-edit", "design.export-snapshot"]),
  domain("memory-context-session", "Memory, context, and session", ["memory.read-write", "context.project-index", "session.resume-fork", "compact.summary"]),
  domain("remote-scheduling-observability", "Remote, scheduling, and observability", ["remote.runtime", "worktree.environment", "schedule.sleep-cron", "observability.trace-budget"])
] satisfies readonly ToolFamilyDomainDefinition[];

const families = [
  family("workspace-io", "file.read", "File read", "read", ["read"], ["filesystem"], "built-in", [
    implementedTool("core.file.read", "Core file read", coreToolIds.fileRead, "file.read")
  ]),
  family("workspace-io", "file.list", "File list", "read", ["read"], ["filesystem"], "built-in", [
    implementedTool("core.file.list", "Core file list", coreToolIds.fileList, "file.list")
  ]),
  family("workspace-io", "workspace.glob", "Workspace glob", "read", ["read"], ["filesystem"], "built-in", [
    implementedTool("core.workspace.glob", "Core workspace glob", coreToolIds.workspaceGlob, "workspace.glob")
  ]),
  family("workspace-io", "asset.view-local", "Local asset view", "read", ["read", "artifact"], ["filesystem", "image-processing"], "built-in", [
    implementedTool("core.asset.view-local", "Core local asset view", coreToolIds.assetViewLocal, "asset.view-local")
  ]),

  family("search-code-intelligence", "search.text", "Text search", "read", ["read"], ["filesystem", "search-provider"], "built-in", [
    implementedTool("core.search.text", "Core text search", coreToolIds.searchText, "search.text")
  ]),
  family("search-code-intelligence", "search.symbol", "Symbol search", "read", ["read"], ["code-index"], "built-in", [
    implementedTool("code.search.symbol", "Code intelligence symbol search", familyCapabilityIds.searchSymbol)
  ]),
  family("search-code-intelligence", "code.diagnostics-lsp", "Code diagnostics and LSP", "read", ["read"], ["code-index", "lsp"], "host", [
    implementedTool("code.diagnostics.lsp", "Code diagnostics projection", familyCapabilityIds.codeDiagnosticsLsp, undefined, "host")
  ]),
  family("search-code-intelligence", "notebook.read", "Notebook read", "read", ["read"], ["filesystem", "notebook"], "built-in", [
    implementedTool("core.notebook.read", "Core notebook read", coreToolIds.notebookRead, "notebook.read")
  ]),

  family("mutation-patching", "file.write", "File write", "write", ["write", "artifact"], ["filesystem"], "built-in", [
    implementedTool("core.file.write", "Core file write", coreToolIds.fileWrite, "file.write")
  ]),
  family("mutation-patching", "file.edit", "File edit", "write", ["write", "artifact"], ["filesystem"], "built-in", [
    implementedTool("core.file.edit", "Core exact file edit", coreToolIds.fileEdit, "file.edit")
  ]),
  family("mutation-patching", "patch.apply", "Patch apply", "write", ["write", "artifact", "pipeline"], ["filesystem"], "built-in", [
    implementedTool("core.patch.apply", "Core patch apply", coreToolIds.patchApply, "patch.apply")
  ]),
  family("mutation-patching", "revert.undo", "Revert and undo", "write", ["write", "artifact"], ["filesystem", "session-store"], "built-in", [
    implementedTool("core.revert.undo", "Core revert undo", coreToolIds.revertUndo, "revert.undo")
  ]),

  family("shell-process", "shell.run", "Shell run", "process", ["process"], ["process", "shell"], "built-in", [
    implementedTool("core.shell.run", "Core shell run", coreToolIds.shellRun, "shell.run")
  ]),
  family("shell-process", "process.output", "Process output", "process", ["process", "read"], ["process"], "built-in", [
    implementedTool("core.shell.output", "Core process output", coreToolIds.shellOutput, "shell.output")
  ]),
  family("shell-process", "process.kill", "Process kill", "process", ["process"], ["process"], "built-in", [
    implementedTool("core.shell.kill", "Core process kill", coreToolIds.shellKill, "shell.kill")
  ]),
  family("shell-process", "repl.execute", "REPL execute", "process", ["process"], ["process", "repl"], "built-in", [
    implementedTool("core.repl.execute", "Core REPL execute", coreToolIds.replExecute, "repl.execute")
  ]),

  family("git-build", "git.status-diff", "Git status and diff", "read", ["read", "process"], ["git"], "built-in", [
    implementedTool("core.git.status", "Core git status", coreToolIds.gitStatus, "git.status"),
    implementedTool("core.git.diff", "Core git diff", coreToolIds.gitDiff, "git.diff")
  ]),
  family("git-build", "git.history-branch", "Git history and branch", "read", ["read", "process"], ["git"], "built-in", [
    implementedTool("core.git.history-branch", "Core git history and branch", coreToolIds.gitHistoryBranch, "git.history-branch")
  ]),
  family("git-build", "build.test-lint-typecheck", "Build, test, lint, and typecheck", "process", ["process"], ["process", "package-manager"], "built-in", [
    implementedTool("core.test.run", "Core test run", coreToolIds.testRun, "test.run")
  ]),
  family("git-build", "package.manager", "Package manager", "process", ["process", "write"], ["package-manager"], "built-in", [
    implementedTool("core.env.prepare", "Core environment prepare", familyCapabilityIds.envPrepare, "env.prepare"),
    implementedTool("core.package.manager", "Core package manager", coreToolIds.packageManager, "package.manager")
  ]),
  family("git-build", "benchmark.run", "Benchmark run", "process", ["process", "artifact"], ["process", "git", "benchmark"], "host", [
    implementedTool("core.swe.bench.run", "Core SWE-bench run", familyCapabilityIds.sweBenchRun, "swe.bench.run", "host")
  ]),

  family("planning-control", "plan.todo", "Todo plan", "orchestration", ["model-feedback"], ["session-store"], "built-in", [
    implementedTool("core.todo.plan", "Core todo plan", coreToolIds.todoPlan, "todo.plan")
  ]),
  family("planning-control", "mode.plan-auto-review", "Plan, auto, and review modes", "orchestration", ["approval", "model-feedback"], ["session-store"], "host", [
    implementedTool("runtime.mode.plan-auto-review", "Runtime plan auto review mode", familyCapabilityIds.modePlanAutoReview, undefined, "host")
  ]),
  family("planning-control", "user.input", "User input request", "orchestration", ["approval", "model-feedback"], ["interactive-host"], "host", [
    implementedTool("runtime.user.input", "Runtime user input", familyCapabilityIds.userInput, undefined, "host")
  ]),
  family("planning-control", "approval.permission", "Approval and permission", "orchestration", ["approval"], ["policy"], "host", [
    implementedTool("runtime.approval.permission", "Runtime approval permission", familyCapabilityIds.approvalPermission, undefined, "host")
  ]),

  family("pipeline-composition", "pipeline.sequence", "Sequential tool pipeline", "orchestration", ["pipeline"], ["runtime"], "built-in", [
    implementedTool("runtime.pipeline.sequence", "Runtime sequential pipeline", familyCapabilityIds.pipelineSequence)
  ]),
  family("pipeline-composition", "pipeline.parallel", "Parallel tool pipeline", "orchestration", ["pipeline"], ["runtime", "scheduler"], "built-in", [
    implementedTool("runtime.pipeline.parallel", "Runtime parallel pipeline", familyCapabilityIds.pipelineParallel)
  ]),
  family("pipeline-composition", "pipeline.artifact-routing", "Artifact routing pipeline", "orchestration", ["pipeline", "artifact"], ["runtime", "session-store"], "built-in", [
    implementedTool("runtime.pipeline.artifact-routing", "Runtime artifact routing pipeline", familyCapabilityIds.pipelineArtifactRouting)
  ]),
  family("pipeline-composition", "pipeline.stream", "Stream pipeline", "orchestration", ["pipeline", "artifact"], ["runtime", "scheduler"], "built-in", [
    implementedTool("runtime.pipeline.stream", "Runtime stream pipeline", familyCapabilityIds.pipelineStream)
  ]),

  family("agents-tasks", "agent.spawn", "Agent spawn", "orchestration", ["model-feedback"], ["runtime", "agent-manager"], "built-in", [
    implementedTool("core.agent.spawn", "Core agent spawn", coreToolIds.agentSpawn, "agent.spawn")
  ]),
  family("agents-tasks", "agent.message-continue", "Agent continue", "orchestration", ["model-feedback"], ["runtime", "agent-manager"], "built-in", [
    implementedTool("core.agent.continue", "Core agent continue", coreToolIds.agentContinue, "agent.continue")
  ]),
  family("agents-tasks", "agent.wait-result", "Agent wait result", "orchestration", ["model-feedback"], ["runtime", "agent-manager"], "built-in", [
    implementedTool("runtime.agent.wait-result", "Runtime agent wait result", familyCapabilityIds.agentWaitResult)
  ]),
  family("agents-tasks", "agent.stop-close", "Agent stop and close", "orchestration", ["model-feedback"], ["runtime", "agent-manager"], "built-in", [
    implementedTool("core.agent.stop", "Core agent stop", coreToolIds.agentStop, "agent.stop")
  ]),

  family("web-public-data", "web.search", "Web search", "network", ["network", "read"], ["network"], "provider", [
    implementedTool("core.web.search", "Core web search", coreToolIds.webSearch, "web.search")
  ]),
  family("web-public-data", "web.fetch", "Web fetch", "network", ["network", "read"], ["network"], "provider", [
    implementedTool("core.web.fetch", "Core web fetch", coreToolIds.webFetch, "web.fetch")
  ]),
  family("web-public-data", "web.extract", "Web extract", "network", ["network", "read"], ["network"], "provider", [
    implementedTool("provider.web.extract", "Provider web extract", familyCapabilityIds.webExtract, undefined, "provider")
  ]),
  family("web-public-data", "web.data-lookup", "Web data lookup", "network", ["network", "read"], ["network"], "provider", [
    implementedTool("provider.web.data-lookup", "Provider web data lookup", familyCapabilityIds.webDataLookup, undefined, "provider")
  ]),

  family("browser-automation", "browser.navigate", "Browser navigate", "external-connector", ["browser", "network"], ["browser"], "mcp", [
    implementedTool("mcp.browser.navigate", "MCP browser navigate", familyCapabilityIds.browserNavigate, undefined, "mcp")
  ]),
  family("browser-automation", "browser.interact", "Browser interact", "external-connector", ["browser"], ["browser"], "mcp", [
    implementedTool("mcp.browser.interact", "MCP browser interact", familyCapabilityIds.browserInteract, undefined, "mcp")
  ]),
  family("browser-automation", "browser.inspect", "Browser inspect", "external-connector", ["browser", "read"], ["browser"], "mcp", [
    implementedTool("mcp.browser.inspect", "MCP browser inspect", familyCapabilityIds.browserInspect, undefined, "mcp")
  ]),
  family("browser-automation", "browser.screenshot", "Browser screenshot", "external-connector", ["browser", "artifact"], ["browser"], "mcp", [
    implementedTool("mcp.browser.screenshot", "MCP browser screenshot", familyCapabilityIds.browserScreenshot, undefined, "mcp")
  ]),

  family("mcp-connectors", "mcp.server-lifecycle", "MCP server lifecycle", "external-connector", ["connector"], ["mcp"], "mcp", [
    implementedTool("mcp.server.lifecycle", "MCP server lifecycle", familyCapabilityIds.mcpServerLifecycle, undefined, "mcp")
  ]),
  family("mcp-connectors", "mcp.tool-call", "MCP tool call", "external-connector", ["connector"], ["mcp"], "mcp", [
    implementedTool("mcp.tool.call", "MCP tool call", familyCapabilityIds.mcpToolCall, undefined, "mcp")
  ]),
  family("mcp-connectors", "mcp.resource-read", "MCP resource read", "external-connector", ["connector", "read"], ["mcp"], "mcp", [
    implementedTool("mcp.resource.read", "MCP resource read", familyCapabilityIds.mcpResourceRead, undefined, "mcp")
  ]),
  family("mcp-connectors", "mcp.prompt", "MCP prompt", "external-connector", ["connector", "model-feedback"], ["mcp"], "mcp", [
    implementedTool("mcp.prompt.render", "MCP prompt render", familyCapabilityIds.mcpPrompt, undefined, "mcp")
  ]),

  family("extensions-local-commands", "skill.list-activate", "Skill list and activate", "orchestration", ["model-feedback"], ["skill-system"], "built-in", [
    implementedTool("core.skill.list", "Core skill list", coreToolIds.skillList, "skill.list"),
    implementedTool("core.skill.activate", "Core skill activate", coreToolIds.skillActivate, "skill.activate")
  ]),
  family("extensions-local-commands", "hook.list-run", "Hook list and run", "orchestration", ["model-feedback"], ["hook-system"], "built-in", [
    implementedTool("core.hook.list", "Core hook list", coreToolIds.hookList, "hook.list"),
    implementedTool("hook.list-run", "Hook system list and run", familyCapabilityIds.hookListRun, undefined, "host")
  ]),
  family("extensions-local-commands", "plugin.install-verify", "Plugin install and verify", "external-connector", ["connector", "write"], ["plugin-system"], "host", [
    implementedTool("plugin.install-verify", "Plugin install and verify", familyCapabilityIds.pluginInstallVerify, undefined, "host")
  ]),
  family("extensions-local-commands", "command.palette-slash", "Command palette and slash controls", "orchestration", ["approval", "model-feedback"], ["command-system"], "host", [
    implementedTool("command.palette-slash", "Command palette and slash projection", familyCapabilityIds.commandPaletteSlash, undefined, "host")
  ]),

  family("media-images", "image.generate", "Image generate", "media", ["media", "artifact"], ["image-provider"], "provider", [
    implementedTool("provider.image.generate", "Provider image generate", familyCapabilityIds.imageGenerate, undefined, "provider")
  ]),
  family("media-images", "image.edit", "Image edit", "media", ["media", "artifact", "write"], ["image-provider"], "provider", [
    implementedTool("provider.image.edit", "Provider image edit", familyCapabilityIds.imageEdit, undefined, "provider")
  ]),
  family("media-images", "image.search-stock", "Image search stock", "media", ["media", "network", "read"], ["network"], "provider", [
    implementedTool("provider.image.search-stock", "Provider image stock search", familyCapabilityIds.imageSearchStock, undefined, "provider")
  ]),
  family("media-images", "image.inspect", "Image inspect", "media", ["media", "read"], ["image-processing"], "host", [
    implementedTool("provider.image.inspect", "Provider image inspect", familyCapabilityIds.imageInspect, undefined, "provider")
  ]),

  family("design-canvas", "design.document-state", "Design document state", "design", ["design", "read"], ["design-provider"], "mcp", [
    implementedTool("mcp.design.document-state", "MCP design document state", familyCapabilityIds.designDocumentState, undefined, "mcp")
  ]),
  family("design-canvas", "design.node-query", "Design node query", "design", ["design", "read"], ["design-provider"], "mcp", [
    implementedTool("mcp.design.node-query", "MCP design node query", familyCapabilityIds.designNodeQuery, undefined, "mcp")
  ]),
  family("design-canvas", "design.batch-edit", "Design batch edit", "design", ["design", "write"], ["design-provider"], "mcp", [
    implementedTool("mcp.design.batch-edit", "MCP design batch edit", familyCapabilityIds.designBatchEdit, undefined, "mcp")
  ]),
  family("design-canvas", "design.export-snapshot", "Design export snapshot", "design", ["design", "artifact"], ["design-provider"], "mcp", [
    implementedTool("mcp.design.export-snapshot", "MCP design export snapshot", familyCapabilityIds.designExportSnapshot, undefined, "mcp")
  ]),

  family("memory-context-session", "memory.read-write", "Memory read and write", "memory", ["memory", "read", "write"], ["memory-store"], "built-in", [
    implementedTool("memory.read-write", "Memory scoped read and write", familyCapabilityIds.memoryReadWrite)
  ]),
  family("memory-context-session", "context.project-index", "Project context index", "memory", ["memory", "read"], ["context-index"], "built-in", [
    implementedTool("context.project-index", "Context project index", familyCapabilityIds.contextProjectIndex)
  ]),
  family("memory-context-session", "session.resume-fork", "Session resume and fork", "memory", ["memory", "model-feedback"], ["session-store"], "built-in", [
    implementedTool("session.resume-fork", "Session resume and fork", familyCapabilityIds.sessionResumeFork)
  ]),
  family("memory-context-session", "compact.summary", "Compact summary", "memory", ["memory", "model-feedback"], ["session-store"], "built-in", [
    implementedTool("compact.summary", "Compact summary", familyCapabilityIds.compactSummary)
  ]),

  family("remote-scheduling-observability", "remote.runtime", "Remote runtime", "remote", ["remote", "connector"], ["remote-runtime"], "host", [
    implementedTool("remote.runtime", "Remote runtime binding", familyCapabilityIds.remoteRuntime, undefined, "host")
  ]),
  family("remote-scheduling-observability", "worktree.environment", "Worktree environment", "remote", ["remote", "write"], ["filesystem", "git"], "host", [
    implementedTool("worktree.environment", "Worktree environment", familyCapabilityIds.worktreeEnvironment, undefined, "host")
  ]),
  family("remote-scheduling-observability", "schedule.sleep-cron", "Schedule, sleep, and cron", "orchestration", ["schedule"], ["scheduler"], "built-in", [
    implementedTool("schedule.sleep-cron", "Schedule sleep and cron", familyCapabilityIds.scheduleSleepCron)
  ]),
  family("remote-scheduling-observability", "observability.trace-budget", "Observability trace and budget", "observability", ["observe"], ["observability"], "built-in", [
    implementedTool("observability.trace-budget", "Observability trace and budget", familyCapabilityIds.observabilityTraceBudget)
  ])
] satisfies readonly ToolFamilyDefinition[];

export const toolFamilyCatalog: ToolFamilyCatalog = {
  schemaVersion: TOOL_FAMILY_CATALOG_SCHEMA_VERSION,
  catalogVersion: toolFamilyCatalogVersion,
  domains,
  families,
  redaction: { class: "internal" }
};

export function capabilityToolFamilyMetadata(capabilityId: CapabilityId): CapabilityToolFamilyMetadata | undefined {
  for (const entry of toolFamilyCatalog.families) {
    const tool = entry.tools.find((item) => item.capabilityId === capabilityId);
    if (!tool) continue;
    return {
      schemaVersion: TOOL_FAMILY_CATALOG_SCHEMA_VERSION,
      catalogVersion: toolFamilyCatalog.catalogVersion,
      domainId: entry.domainId,
      familyId: entry.familyId,
      toolId: tool.toolId,
      implementationState: tool.implementationState,
      maturity: entry.maturity,
      riskClass: entry.riskClass,
      operationProfiles: entry.operationProfiles,
      hostRequirements: entry.hostRequirements,
      connectorProfile: entry.connectorProfile,
      scorecardRubricId: entry.scorecardRubricId,
      redaction: { class: "internal" }
    };
  }
  return undefined;
}

export function validateToolFamilyCatalog(catalog: ToolFamilyCatalog = toolFamilyCatalog): readonly string[] {
  const errors: string[] = [];
  const domainIds = new Set(catalog.domains.map((item) => item.domainId));
  const familyIds = new Set(catalog.families.map((item) => item.familyId));
  if (catalog.domains.length !== TOOL_FAMILY_DOMAIN_IDS.length) errors.push(`domain-count:${catalog.domains.length}`);
  if (catalog.families.length !== TOOL_FAMILY_IDS.length) errors.push(`family-count:${catalog.families.length}`);
  for (const id of TOOL_FAMILY_DOMAIN_IDS) {
    if (!domainIds.has(id)) errors.push(`missing-domain:${id}`);
  }
  for (const id of TOOL_FAMILY_IDS) {
    if (!familyIds.has(id)) errors.push(`missing-family:${id}`);
  }
  const domainFamilyIds = new Set<ToolFamilyId>();
  for (const domainEntry of catalog.domains) {
    for (const familyId of domainEntry.familyIds) {
      if (domainFamilyIds.has(familyId)) errors.push(`duplicate-domain-family:${familyId}`);
      domainFamilyIds.add(familyId);
    }
  }
  for (const familyEntry of catalog.families) {
    if (!domainIds.has(familyEntry.domainId)) errors.push(`family-domain-missing:${familyEntry.familyId}`);
    if (!domainFamilyIds.has(familyEntry.familyId)) errors.push(`family-not-in-domain:${familyEntry.familyId}`);
    if (familyEntry.implementationState === "implemented" && familyEntry.tools.length < 1) {
      errors.push(`implemented-family-without-tool:${familyEntry.familyId}`);
    }
    if (familyEntry.implementationState !== "implemented" && familyEntry.tools.length > 0) {
      errors.push(`nonimplemented-family-with-tool:${familyEntry.familyId}`);
    }
    if (familyEntry.operationProfiles.length < 1) errors.push(`family-without-operation-profile:${familyEntry.familyId}`);
    if (familyEntry.hostRequirements.length < 1) errors.push(`family-without-host-requirement:${familyEntry.familyId}`);
    if (familyEntry.scorecardRubricId.length === 0) errors.push(`family-without-rubric:${familyEntry.familyId}`);
    for (const tool of familyEntry.tools) {
      if (!tool.capabilityId) errors.push(`tool-without-capability:${familyEntry.familyId}:${tool.toolId}`);
      if (!tool.executable) errors.push(`tool-not-executable:${familyEntry.familyId}:${tool.toolId}`);
      if (!tool.modelVisible) errors.push(`tool-not-model-visible:${familyEntry.familyId}:${tool.toolId}`);
      if (tool.implementationState !== "implemented") errors.push(`tool-not-implemented:${familyEntry.familyId}:${tool.toolId}`);
      if (tool.toolId.startsWith("catalog.")) errors.push(`catalog-placeholder-tool:${familyEntry.familyId}:${tool.toolId}`);
    }
  }
  const mappedCapabilityIds = new Set<string>();
  for (const familyEntry of catalog.families) {
    for (const tool of familyEntry.tools) {
      if (tool.capabilityId) mappedCapabilityIds.add(tool.capabilityId);
    }
  }
  for (const capabilityId of Object.values(coreToolIds)) {
    if (!mappedCapabilityIds.has(capabilityId)) errors.push(`core-capability-unmapped:${capabilityId}`);
  }
  return errors;
}

export function coreCapabilityFamilyMappings(): readonly JsonObject[] {
  return toolFamilyCatalog.families.flatMap((entry) => entry.tools
    .filter((tool) => tool.capabilityId !== undefined)
    .map((tool) => ({
      capabilityId: tool.capabilityId,
      familyId: entry.familyId,
      domainId: entry.domainId,
      toolId: tool.toolId,
      implementationState: tool.implementationState
    })));
}

function domain(domainId: ToolFamilyDomainId, title: string, familyIds: readonly ToolFamilyId[]): ToolFamilyDomainDefinition {
  return {
    domainId,
    title,
    familyIds,
    redaction: { class: "internal" }
  };
}

function family(
  domainId: ToolFamilyDomainId,
  familyId: ToolFamilyId,
  title: string,
  riskClass: ToolFamilyRiskClass,
  operationProfiles: readonly ToolFamilyOperationProfile[],
  hostRequirements: readonly string[],
  connectorProfile: ToolFamilyConnectorKind,
  tools: readonly ToolFamilyToolDefinition[]
): ToolFamilyDefinition {
  return {
    familyId,
    domainId,
    title,
    implementationState: tools.length > 0 ? "implemented" : "planned",
    maturity: "baseline",
    riskClass,
    operationProfiles,
    hostRequirements,
    connectorProfile,
    scorecardRubricId: `rubric.tool-family.${safeId(familyId)}.v1`,
    tools,
    redaction: { class: "internal" }
  };
}

function implementedTool(
  toolId: string,
  title: string,
  capabilityId: CapabilityId,
  coreToolName?: string,
  connectorKind: ToolFamilyConnectorKind = "built-in"
): ToolFamilyToolDefinition {
  return {
    toolId,
    title,
    capabilityId,
    ...(coreToolName ? { coreToolName } : {}),
    connectorKind,
    implementationState: "implemented",
    modelVisible: true,
    executable: true,
    redaction: { class: "internal" }
  };
}

function safeId(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}
