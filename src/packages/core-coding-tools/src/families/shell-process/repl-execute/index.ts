import type {
  CapabilityExecutionContext,
  CoreCodingToolName,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { Script, createContext } from "node:vm";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { requireDeps } from "../../../shared/workspace.js";

const TOOL_NAME = "repl.execute" as CoreCodingToolName;

interface ReplExecuteInput extends JsonObject {
  readonly code: string;
  readonly language?: "javascript" | "typescript";
  readonly cwd?: string;
  readonly workspaceRoot?: string;
  readonly timeoutMs?: number;
  readonly limitBytes?: number;
}

export function defineReplExecuteTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    TOOL_NAME,
    coreToolIds.replExecute,
    "REPL Execute",
    "process",
    ["process:repl"],
    objectSchema(["code"], {
      code: { type: "string" },
      language: { type: "string" },
      cwd: { type: "string" },
      workspaceRoot: { type: "string" },
      timeoutMs: { type: "number" },
      limitBytes: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then(() => replExecuteTool(input, context))
  );
}

async function replExecuteTool(input: JsonObject, context: CapabilityExecutionContext): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as ReplExecuteInput;
  const language = parsed.language ?? "javascript";
  if (language !== "javascript" && language !== "typescript") {
    return failure(TOOL_NAME, "REPL_LANGUAGE_UNSUPPORTED", "Only JavaScript and TypeScript snippets are supported by the local REPL executor.", []);
  }
  if (language === "typescript" && /:\s*[A-Za-z_$][\w$]*(?=\s*[=,)])/u.test(parsed.code)) {
    return failure(TOOL_NAME, "REPL_TYPESCRIPT_TRANSPILE_UNAVAILABLE", "TypeScript syntax requiring transpilation is not available in the isolated first-version REPL.", []);
  }

  const logs: string[] = [];
  const sandbox = createContext({
    console: {
      log: (...values: readonly unknown[]) => logs.push(values.map(formatValue).join(" ")),
      error: (...values: readonly unknown[]) => logs.push(values.map(formatValue).join(" "))
    },
    Math,
    JSON,
    Date,
    URL,
    URLSearchParams
  });
  try {
    const script = new Script(parsed.code, { filename: "deepseek-repl-snippet.js" });
    const value = script.runInContext(sandbox, { timeout: boundedTimeout(parsed.timeoutMs) });
    const output = [...logs, `=> ${formatValue(value)}`].join("\n");
    return success(TOOL_NAME, [], {
      preview: boundedText(output, parsed.limitBytes ?? 4_000),
      metadata: { language, timeoutMs: boundedTimeout(parsed.timeoutMs), sandbox: "node:vm isolated context", logCount: logs.length },
      replay: replay(context)
    });
  } catch (error) {
    return failure(TOOL_NAME, error instanceof Error && error.message.includes("Script execution timed out") ? "REPL_TIMEOUT" : "REPL_EXECUTION_FAILED", error instanceof Error ? error.message : "REPL execution failed.", [], { language, timeoutMs: boundedTimeout(parsed.timeoutMs) });
  }
}

function boundedTimeout(timeoutMs: number | undefined): number {
  return Number.isFinite(timeoutMs) ? Math.max(10, Math.min(1_000, Math.floor(timeoutMs ?? 250))) : 250;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
