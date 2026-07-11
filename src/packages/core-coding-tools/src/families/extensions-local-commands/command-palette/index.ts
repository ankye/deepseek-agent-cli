import type {
  CapabilityExecutionContext,
  CommandManifest,
  CommandSystem,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { requireDeps } from "../../../shared/workspace.js";

export interface CommandPaletteToolDeps extends CoreCodingToolsDependencies {
  readonly commands?: CommandSystem;
}

interface CommandPaletteInput extends JsonObject {
  readonly query?: string;
  readonly limit?: number;
  readonly includeHidden?: boolean;
}

export function defineCommandPaletteTool(deps: CommandPaletteToolDeps | undefined) {
  return defineToolManifest(
    "command.palette",
    coreToolIds.commandPalette,
    "Command Palette",
    "read",
    ["command:read"],
    objectSchema([], { query: { type: "string" }, limit: { type: "number" }, includeHidden: { type: "boolean" } }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => commandPaletteTool(input, context, ready as CommandPaletteToolDeps))
  );
}

async function commandPaletteTool(input: JsonObject, context: CapabilityExecutionContext, deps: CommandPaletteToolDeps): Promise<SerializableResult<CoreToolResult>> {
  if (!deps.commands) {
    return failure("command.palette", "COMMAND_SYSTEM_UNAVAILABLE", "No CommandSystem registered in runtime dependencies.", []);
  }
  const parsed = input as CommandPaletteInput;
  const query = (parsed.query ?? "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, parsed.limit ?? 50));
  const manifests = await deps.commands.help();
  const projected = manifests
    .map((manifest) => commandProjection(manifest))
    .filter((entry) => parsed.includeHidden === true || entry.visible)
    .filter((entry) => !query || entry.searchText.includes(query))
    .slice(0, limit);
  const slashCommands = projected.map((entry) => ({
    id: entry.id,
    title: slashTitle(entry.title),
    aliases: entry.aliases.map(slashTitle),
    sideEffect: entry.sideEffect,
    permissions: entry.permissions,
    target: entry.target,
    visible: entry.visible,
    modelVisible: entry.modelVisible,
    redaction: entry.redaction
  }));
  const preview = slashCommands.map((command) => `${command.title} ${command.sideEffect}`).join("\n");
  return success("command.palette", slashCommands.map((command) => command.id), {
    preview: boundedText(preview, 8_000),
    metadata: {
      query,
      count: slashCommands.length,
      totalCommandCount: manifests.length,
      truncated: manifests.length > limit,
      slashCommands: slashCommands as unknown as JsonObject,
      paletteEntries: projected.map(({ searchText: _searchText, ...entry }) => entry) as unknown as JsonObject
    },
    replay: replay(context)
  });
}

function commandProjection(manifest: CommandManifest) {
  const aliases = unique([manifest.name, ...manifest.aliases]);
  const modelVisible = manifest.projection?.modelVisible === true;
  const visible = manifest.projection?.hostOnly !== true
    && manifest.projection?.hidden !== true
    && manifest.projection?.disabled !== true;
  return {
    id: String(manifest.id),
    title: manifest.name,
    aliases,
    sideEffect: manifest.compositionSideEffect ?? manifest.sideEffect,
    permissions: manifest.permissions ?? [],
    target: manifest.target ?? { kind: "command", id: String(manifest.id) },
    source: manifest.source,
    visible,
    modelVisible,
    redaction: manifest.redaction ?? { class: "internal" },
    searchText: [manifest.name, ...aliases, manifest.description ?? "", manifest.source?.id ?? ""].join(" ").toLowerCase()
  };
}

function slashTitle(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
