import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { requireDeps, resolveToolPath } from "../../../shared/workspace.js";
import { coreToolIds } from "../../../shared/ids.js";

interface CommandLookupInput extends JsonObject {
  readonly command: string;
  readonly cwd?: string;
  readonly workspaceRoot?: string;
  readonly limitBytes?: number;
  readonly timeoutMs?: number;
}

export function defineCommandLookupTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "command.lookup",
    coreToolIds.commandLookup,
    "Command Lookup",
    "read",
    ["process:read"],
    objectSchema(["command"], {
      command: { type: "string" },
      cwd: { type: "string" },
      workspaceRoot: { type: "string" },
      limitBytes: { type: "number" },
      timeoutMs: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => commandLookupTool(input, context, ready))
  );
}

async function commandLookupTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as CommandLookupInput;
  if (!/^[A-Za-z0-9._+-]+$/.test(parsed.command)) return failure("command.lookup", "COMMAND_LOOKUP_REJECTED", "Command lookup only accepts a bare executable name.", [String(parsed.command ?? "")]);
  const cwdPath = resolveToolPath(deps, parsed.workspaceRoot, parsed.cwd ?? ".");
  if (!cwdPath.ok || !cwdPath.value) return failure("command.lookup", "PATH_REJECTED", cwdPath.error?.message ?? "Path rejected.", [String(parsed.cwd ?? ".")]);
  const invocation = lookupInvocation(deps.platform.os, parsed.command);
  const result = await deps.platform.runProcess(invocation.command, invocation.args, {
    cwd: cwdPath.value.path,
    timeoutMs: parsed.timeoutMs ?? 5_000,
    executionProfile: "noninteractive",
    stdin: "ignore",
    outputLimitBytes: parsed.limitBytes ?? 4_000
  });
  const output = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return success("command.lookup", [cwdPath.value.path], {
    preview: boundedText(output.join("\n") || `${parsed.command}: not found`, parsed.limitBytes),
    provider: result.metadata,
    metadata: {
      command: parsed.command,
      available: result.exitCode === 0 && output.length > 0,
      paths: output,
      exitCode: result.exitCode,
      stderrPreview: boundedText(result.stderr, parsed.limitBytes)
    },
    replay: replay(context),
    status: "completed"
  });
}

function lookupInvocation(os: CoreCodingToolsDependencies["platform"]["os"], command: string): { readonly command: string; readonly args: readonly string[] } {
  if (os === "windows") return { command: "where.exe", args: [command] };
  return { command, args: ["-e", "console.log(process.execPath)"] };
}
