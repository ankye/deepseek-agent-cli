import type { AgentLoopToolProjection, CapabilityManifest } from "@deepseek/platform-contracts";
import { PROMPT_ASSEMBLY_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import type { PromptSectionProviderRegistration } from "../assembler.js";
import { createPromptSection } from "../sections.js";
import { isCapabilityVisibleForProjection } from "../tool-projection.js";

export function createToolPolicyProvider(): PromptSectionProviderRegistration {
  return {
    id: "core.tool-policy",
    version: "1.0.0",
    kind: "tools.policy",
    source: "capability-registry",
    priority: 300,
    budgetClass: "optional",
    trust: "system",
    required: false,
    compatibility: { schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION },
    provide(input) {
      if (input.availableTools.length === 0) return [];
      const policyLabel = toolPolicyLabel(input.toolPolicy);
      const projection = toolVisibilityProjection(input.availableTools, input.toolPolicy, input.toolOptIns ?? []);
      return [createPromptSection({
        id: "section.tool-policy",
        providerId: "core.tool-policy",
        kind: "tools.policy",
        source: "capability-registry",
        role: "system",
        content: [
          `Tool visibility policy: ${policyLabel}. Visible tools: ${projection.visible.length}; excluded tools: ${projection.excluded}.`,
          `Tool opt-ins: ${(input.toolOptIns ?? []).length > 0 ? (input.toolOptIns ?? []).join(", ") : "none"}.`,
          `Use only these exact model-visible tool function names: ${projection.visible.map((tool) => `${tool.safeName} (capability ${tool.capabilityId})`).join(", ")}.`,
          commandHabitAliasGuidance(projection.aliases),
          projection.aliases.length > 0
            ? `Cross-platform semantic aliases: ${projection.aliases.map((alias) => `${alias.alias} -> ${alias.safeName}`).join(", ")}.`
            : "Cross-platform semantic aliases: none.",
          "Use semantic workspace tools before platform commands: Read for file reads, Stat for file metadata, JsonRead for structured JSON reads, Hash for file digests, PathResolve for path normalization, Env for environment visibility, Which for command availability, Grep for text search, Glob for file discovery, Edit for exact mutations, JsonPatch for structured JSON mutations, ArchiveCreate/ArchiveExtract for archive operations, Write for literal artifact creation, Copy for duplication, Move for relocation, Delete for removal, Mkdir for directory creation, and Touch for empty file creation.",
          "Use ApplyPatch for unified diffs, Revert for checkpoint rollback, and Test for governed verification before falling back to shell commands.",
          "Use Edit, JsonPatch, ArchiveCreate, ArchiveExtract, Write, Copy, Move, Delete, Mkdir, or Touch for mutations instead of sed/jq/tar/zip/unzip/cp/mv/rm/mkdir/touch/echo redirection; use Hash, PathResolve, Env, and Which instead of platform-specific checksum, path, env, or command lookup commands; use shell/process tools only when no governed semantic tool fits.",
          "Do not invent unlisted tool function names. For text search use core_search_text, not core_file_search."
        ].join("\n"),
        priority: 300,
        budgetClass: "optional",
        trust: "system",
        required: false,
        provenance: {
          policy: input.toolPolicy,
          policyLabel,
          toolOptIns: input.toolOptIns ?? [],
          visibleToolCount: projection.visible.length,
          excludedToolCount: projection.excluded,
          visibleToolNames: projection.visible.map((tool) => tool.safeName),
          semanticAliases: projection.aliases.map((alias) => alias.alias)
        }
      })];
    }
  };
}

function toolPolicyLabel(policy: AgentLoopToolProjection): string {
  return policy === "all" ? "safe-all" : policy;
}

function toolVisibilityProjection(tools: readonly CapabilityManifest[], policy: AgentLoopToolProjection, toolOptIns: readonly string[] = []): {
  readonly visible: readonly { readonly safeName: string; readonly capabilityId: string }[];
  readonly aliases: readonly { readonly alias: string; readonly safeName: string; readonly capabilityId: string }[];
  readonly excluded: number;
} {
  const visible: Array<{ readonly safeName: string; readonly capabilityId: string }> = [];
  const aliases: Array<{ readonly alias: string; readonly safeName: string; readonly capabilityId: string }> = [];
  let excluded = 0;
  for (const tool of tools) {
    if (isToolVisible(tool, policy, toolOptIns)) {
      const safeName = toSafeToolName(String(tool.id));
      const capabilityId = String(tool.id);
      visible.push({ safeName, capabilityId });
      for (const alias of modelAliases(tool)) aliases.push({ alias, safeName, capabilityId });
    } else {
      excluded += 1;
    }
  }
  return { visible, aliases, excluded };
}

function isToolVisible(tool: CapabilityManifest, policy: AgentLoopToolProjection, toolOptIns: readonly string[]): boolean {
  return isCapabilityVisibleForProjection(tool, policy, toolOptIns);
}

function toSafeToolName(capabilityId: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(capabilityId) ? capabilityId : capabilityId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function modelAliases(tool: CapabilityManifest): readonly string[] {
  const aliases = tool.projection?.modelAliases;
  return Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === "string" && alias.length > 0) : [];
}

function commandHabitAliasGuidance(aliases: readonly { readonly alias: string; readonly safeName: string }[]): string {
  const commandHabits = new Set([
    "cat",
    "ls",
    "grep",
    "rg",
    "sed",
    "cp",
    "mv",
    "rm",
    "mkdir",
    "touch",
    "stat",
    "env",
    "printenv",
    "which",
    "where",
    "bash",
    "sh",
    "powershell",
    "pwsh",
    "npm",
    "yarn",
    "pnpm",
    "tar",
    "unzip"
  ]);
  const visible = aliases
    .filter((alias) => commandHabits.has(alias.alias))
    .map((alias) => `${alias.alias} -> ${alias.safeName}`);
  return visible.length > 0
    ? `Common command-habit aliases route to governed tools: ${visible.join(", ")}.`
    : "Common command-habit aliases route to governed tools: none visible under this policy.";
}
