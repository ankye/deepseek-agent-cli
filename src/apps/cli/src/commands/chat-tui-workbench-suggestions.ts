import type { CliCompositionSnapshot, CliInteractionContribution } from "@deepseek/platform-contracts";
import type { ChatTuiCommandSuggestion, ChatTuiCommandSuggestionKind } from "./chat-tui-workbench.js";

const CORE_COMMANDS: readonly ChatTuiCommandSuggestion[] = [
  described(suggestion("control.help", "/help", "control", "builtin", 0, "/help"), "Show commands and shortcuts"),
  described(suggestion("control.exit", "/exit", "control", "builtin", 1, "/exit"), "Leave the chat safely"),
  described(suggestion("control.palette", "/palette", "palette", "builtin", 1, "/palette"), "Open the command palette"),
  described(suggestion("control.context", "/context status", "context", "builtin", 2, "/context status"), "Review context usage"),
  described(suggestion("control.refs", "/palette refs list", "reference", "builtin", 3, "/palette refs list"), "List available references"),
  described(suggestion("view.reasoning", "Reasoning: focus rail", "reasoning-view", "builtin", 4, "reasoning.focus"), "Inspect reasoning updates"),
  described(suggestion("view.inspector", "Inspector: active evidence", "reasoning-view", "builtin", 5, "inspector.focus"), "Review targets and evidence"),
  described(suggestion("control.history", "/history", "history", "builtin", 6, "/history"), "Show recent turns"),
  described(suggestion("control.revert", "/revert preview current", "history", "builtin", 7, "/revert preview current"), "Preview reverting the current turn"),
  described(suggestion("control.mode", "/mode status", "control", "builtin", 8, "/mode status"), "Show the active chat mode"),
  described(suggestion("control.model", "/model", "control", "builtin", 9, "/model"), "Switch or inspect the model"),
  described(suggestion("control.cost", "/cost", "control", "builtin", 10, "/cost"), "Show usage and cost"),
  described(suggestion("control.cancel", "/cancel", "control", "builtin", 11, "/cancel"), "Cancel the current turn"),
  described(suggestion("navigation.file.list", "/file list <query>", "navigation", "builtin", 20, "/file list"), "Find workspace files"),
  described(suggestion("navigation.file.preview", "/file preview <path|query>", "navigation", "builtin", 21, "/file preview"), "Preview a file"),
  described(suggestion("navigation.file.refs", "/file refs <query>", "navigation", "builtin", 22, "/file refs"), "Find file references"),
  described(suggestion("navigation.jump.file", "/jump file <query>", "navigation", "builtin", 23, "/jump file"), "Jump to a file"),
  described(suggestion("navigation.jump.text", "/jump text <query>", "navigation", "builtin", 24, "/jump text"), "Search text in files"),
  described(suggestion("navigation.jump.symbol", "/jump symbol <query>", "navigation", "builtin", 25, "/jump symbol"), "Jump to a symbol")
];

export function commandSuggestions(composition: CliCompositionSnapshot, query: string): readonly ChatTuiCommandSuggestion[] {
  const pluginSuggestions = composition.contributions.flatMap((contribution) => contributionSuggestion(contribution));
  const normalizedQuery = query.trim().toLocaleLowerCase("en");
  return [...CORE_COMMANDS, ...pluginSuggestions]
    .filter((entry) => normalizedQuery.length === 0 || `${entry.title} ${entry.description ?? ""} ${entry.commandName ?? ""} ${entry.kind}`.toLocaleLowerCase("en").includes(normalizedQuery))
    .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title, "en") || a.id.localeCompare(b.id, "en"));
}

function contributionSuggestion(contribution: CliInteractionContribution): readonly ChatTuiCommandSuggestion[] {
  const sourceRank = contribution.source === "core" ? 100 : contribution.source === "user" ? 200 : 300;
  if (contribution.kind === "command") {
    const commandName = contribution.commandName ?? contribution.id;
    return [suggestion(
      `contribution:${contribution.id}`,
      commandSuggestionTitle(commandName, contribution),
      contribution.source === "plugin" ? "plugin-action" : "control",
      contribution.source,
      commandSuggestionRank(commandName, sourceRank, contribution.priority),
      commandName,
      contribution.targetKind,
      contribution.pluginId
    )];
  }
  if (contribution.kind === "palette-entry" && contribution.paletteEntry) {
    return [suggestion(
      `palette:${contribution.id}`,
      contribution.paletteEntry.title,
      contribution.source === "plugin" ? "plugin-action" : "palette",
      contribution.source,
      sourceRank + 25,
      contribution.commandName,
      contribution.paletteEntry.targetKind,
      contribution.pluginId
    )];
  }
  if (contribution.kind === "result-list-provider" || contribution.kind === "render-hint") {
    return [suggestion(
      `metadata:${contribution.id}`,
      readableContributionTitle(contribution),
      contribution.source === "plugin" ? "plugin-action" : "palette",
      contribution.source,
      sourceRank + 75,
      contribution.commandName,
      contribution.targetKind,
      contribution.pluginId
    )];
  }
  return [];
}

function commandSuggestionTitle(commandName: string, contribution: CliInteractionContribution): string {
  if (!commandName.startsWith("/")) return commandName;
  const placeholders = ownerRoutePlaceholders(contribution.metadata);
  if (placeholders.length === 0) return commandName;
  return `${commandName} ${placeholders.join(" ")}`;
}

function commandSuggestionRank(commandName: string, sourceRank: number, priority: number | undefined): number {
  const normalizedPriority = priority ?? 0;
  if (commandName.startsWith("/")) return 80 + Math.max(0, 50 - normalizedPriority);
  return sourceRank + (100 - normalizedPriority);
}

function ownerRoutePlaceholders(metadata: CliInteractionContribution["metadata"]): readonly string[] {
  const ownerRoute = isJsonObject(metadata?.ownerRoute) ? metadata.ownerRoute : undefined;
  const fallbackCommand = typeof ownerRoute?.fallbackCommand === "string" ? ownerRoute.fallbackCommand : undefined;
  const placeholders = fallbackCommand?.match(/<[^>]+>/g) ?? [];
  return [...new Set(placeholders)];
}

function readableContributionTitle(contribution: CliInteractionContribution): string {
  const placement = typeof contribution.metadata?.placement === "string" ? contribution.metadata.placement : contribution.kind;
  return `${contribution.pluginId ?? contribution.source}: ${placement}`;
}

function suggestion(
  id: string,
  title: string,
  kind: ChatTuiCommandSuggestionKind,
  source: ChatTuiCommandSuggestion["source"],
  rank: number,
  commandName?: string,
  targetKind?: string,
  pluginId?: string
): ChatTuiCommandSuggestion {
  return {
    id,
    title,
    kind,
    source,
    ...(commandName ? { commandName } : {}),
    ...(targetKind ? { targetKind } : {}),
    ...(pluginId ? { pluginId } : {}),
    rank
  };
}

function described(entry: ChatTuiCommandSuggestion, description: string): ChatTuiCommandSuggestion {
  return { ...entry, description };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
