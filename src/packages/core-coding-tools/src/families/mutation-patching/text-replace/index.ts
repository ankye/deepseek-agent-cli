import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult,
  TextReplaceInput
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, isDiagnostic, objectSchema, replay, success, undefinedError } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { editTransaction, invalidateCodeIntelligence, publicTransactionEvidence, requireDeps, resolveToolPath, toWorkspaceTransaction } from "../../../shared/workspace.js";

export function defineTextReplaceTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "text.replace",
    coreToolIds.textReplace,
    "Text Replace",
    "write",
    ["workspace:write"],
    objectSchema(["path", "pattern", "replacement"], {
      path: { type: "string" },
      pattern: { type: "string" },
      replacement: { type: "string" },
      workspaceRoot: { type: "string" },
      limitBytes: { type: "number" },
      regex: { type: "boolean" },
      caseInsensitive: { type: "boolean" },
      multiline: { type: "boolean" },
      maxReplacements: { type: "number" },
      dryRun: { type: "boolean" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => replaceTextTool(input, context, ready))
  );
}

async function replaceTextTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as TextReplaceInput;
  if (typeof parsed.path !== "string" || typeof parsed.pattern !== "string" || typeof parsed.replacement !== "string") {
    return failure("text.replace", "TEXT_REPLACE_INPUT_INVALID", "text.replace requires string path, pattern, and replacement fields.", [], {
      receivedKeys: Object.keys(input).sort()
    });
  }
  if (parsed.pattern.length === 0) {
    return failure("text.replace", "TEXT_REPLACE_PATTERN_EMPTY", "pattern must not be empty.", [parsed.path]);
  }
  const path = resolveToolPath(deps, parsed.workspaceRoot, parsed.path);
  if (!path.ok || !path.value) return failure("text.replace", "PATH_REJECTED", path.error?.message ?? "Path rejected.", [String(parsed.path ?? "")]);

  const before = await deps.platform.readFile(path.value.path).catch((error: unknown) => undefinedError(error, "READ_FAILED"));
  if (isDiagnostic(before)) return failure("text.replace", before.code, before.message, [path.value.path]);

  const replacement = replaceContent(before, parsed);
  if (!replacement.ok) return failure("text.replace", replacement.code, replacement.message, [path.value.path], replacement.metadata);

  const changed = replacement.after !== before;
  const dryRun = parsed.dryRun === true;
  if (!changed) {
    return failure("text.replace", "TEXT_REPLACE_NO_MATCH", "No replacement was applied because the pattern did not match.", [path.value.path], {
      path: path.value.path,
      relativePath: path.value.relativePath,
      matchCount: replacement.matchCount,
      replacementCount: replacement.replacementCount,
      changed: false,
      dryRun,
      regex: parsed.regex === true,
      maxReplacements: normalizedMaxReplacements(parsed.maxReplacements)
    });
  }

  if (dryRun) {
    return success("text.replace", [path.value.path], {
      preview: boundedText(replacement.after, parsed.limitBytes),
      metadata: {
        path: path.value.path,
        relativePath: path.value.relativePath,
        matchCount: replacement.matchCount,
        replacementCount: replacement.replacementCount,
        changed: false,
        dryRun,
        regex: parsed.regex === true,
        maxReplacements: normalizedMaxReplacements(parsed.maxReplacements)
      },
      replay: replay(context)
    });
  }

  await deps.platform.writeFile(path.value.path, replacement.after);
  const transaction = editTransaction(context, path.value.path, "pattern-match", before, replacement.after, true, []);
  const workspaceTransaction = await deps.workspaceState.transact(toWorkspaceTransaction(transaction, before));
  invalidateCodeIntelligence(deps, path.value.path);
  return success("text.replace", [path.value.path], {
    preview: boundedText(replacement.after, parsed.limitBytes),
    metadata: {
      path: path.value.path,
      relativePath: path.value.relativePath,
      matchCount: replacement.matchCount,
      replacementCount: replacement.replacementCount,
      changed: true,
      dryRun: false,
      regex: parsed.regex === true,
      maxReplacements: normalizedMaxReplacements(parsed.maxReplacements),
      transaction: publicTransactionEvidence(transaction, workspaceTransaction),
      checkpoint: workspaceTransaction.checkpoints[0]
    },
    replay: replay(context)
  });
}

function replaceContent(content: string, parsed: TextReplaceInput): {
  readonly ok: true;
  readonly after: string;
  readonly matchCount: number;
  readonly replacementCount: number;
} | {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly metadata: JsonObject;
} {
  const max = normalizedMaxReplacements(parsed.maxReplacements);
  if (parsed.regex === true) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(parsed.pattern, `${parsed.caseInsensitive ? "i" : ""}${parsed.multiline ? "s" : ""}g`);
    } catch (error) {
      return {
        ok: false,
        code: "TEXT_REPLACE_PATTERN_INVALID",
        message: error instanceof Error ? error.message : "Invalid replacement pattern.",
        metadata: { regex: true }
      };
    }
    let seen = 0;
    let replaced = 0;
    const after = content.replace(pattern, (...args: unknown[]) => {
      seen += 1;
      if (max !== undefined && replaced >= max) return String(args[0]);
      replaced += 1;
      return parsed.replacement;
    });
    return { ok: true, after, matchCount: seen, replacementCount: replaced };
  }

  let index = 0;
  let matchCount = 0;
  let replacementCount = 0;
  let after = "";
  const source = parsed.caseInsensitive ? content.toLowerCase() : content;
  const needle = parsed.caseInsensitive ? parsed.pattern.toLowerCase() : parsed.pattern;
  while (index < content.length) {
    const next = source.indexOf(needle, index);
    if (next < 0) {
      after += content.slice(index);
      break;
    }
    matchCount += 1;
    after += content.slice(index, next);
    if (max === undefined || replacementCount < max) {
      after += parsed.replacement;
      replacementCount += 1;
    } else {
      after += content.slice(next, next + parsed.pattern.length);
    }
    index = next + parsed.pattern.length;
  }
  return { ok: true, after, matchCount, replacementCount };
}

function normalizedMaxReplacements(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}
