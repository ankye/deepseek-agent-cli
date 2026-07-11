import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import type { InMemoryWorktreeEnvironment, WorktreeEnvironmentResult } from "@deepseek/workspace-state-management";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { requireDeps } from "../../../shared/workspace.js";

interface WorktreeToolDeps extends CoreCodingToolsDependencies {
  readonly worktrees?: InMemoryWorktreeEnvironment;
}

type WorktreeToolName = "worktree.enter" | "worktree.exit";

export function defineWorktreeEnterTool(deps: WorktreeToolDeps | undefined) {
  return defineToolManifest(
    "worktree.enter",
    coreToolIds.worktreeEnter,
    "Worktree Enter",
    "write",
    ["workspace:worktree"],
    objectSchema(["worktreeId"], {
      workspaceRoot: { type: "string" },
      worktreeId: { type: "string" },
      branch: { type: "string" },
      path: { type: "string" },
      writeScope: { type: "array", items: { type: "string" } }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => enterWorktree(input, context, ready as WorktreeToolDeps))
  );
}

export function defineWorktreeExitTool(deps: WorktreeToolDeps | undefined) {
  return defineToolManifest(
    "worktree.exit",
    coreToolIds.worktreeExit,
    "Worktree Exit",
    "write",
    ["workspace:worktree"],
    objectSchema(["worktreeId"], {
      workspaceRoot: { type: "string" },
      worktreeId: { type: "string" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => exitWorktree(input, context, ready as WorktreeToolDeps))
  );
}

function enterWorktree(input: JsonObject, context: CapabilityExecutionContext, deps: WorktreeToolDeps): SerializableResult<CoreToolResult> {
  if (!deps.worktrees) return failure("worktree.enter", "WORKTREE_ENVIRONMENT_UNAVAILABLE", "Worktree environment is required for worktree.enter.", []);
  const worktreeId = stringValue(input.worktreeId);
  if (!worktreeId) return failure("worktree.enter", "WORKTREE_ID_REQUIRED", "worktreeId is required.", []);
  const workspaceRoot = stringValue(input.workspaceRoot) ?? deps.workspaceRoot;
  const path = stringValue(input.path) ?? `${workspaceRoot}/.worktrees/${worktreeId}`;
  const result = deps.worktrees.execute({
    action: "create",
    workspaceRoot,
    worktreeId,
    branch: stringValue(input.branch) ?? `worktree/${worktreeId}`,
    path,
    writeScope: stringArray(input.writeScope)
  });
  return worktreeResult("worktree.enter", context, result);
}

function exitWorktree(input: JsonObject, context: CapabilityExecutionContext, deps: WorktreeToolDeps): SerializableResult<CoreToolResult> {
  if (!deps.worktrees) return failure("worktree.exit", "WORKTREE_ENVIRONMENT_UNAVAILABLE", "Worktree environment is required for worktree.exit.", []);
  const worktreeId = stringValue(input.worktreeId);
  if (!worktreeId) return failure("worktree.exit", "WORKTREE_ID_REQUIRED", "worktreeId is required.", []);
  const result = deps.worktrees.execute({
    action: "cleanup",
    workspaceRoot: stringValue(input.workspaceRoot) ?? deps.workspaceRoot,
    worktreeId
  });
  return worktreeResult("worktree.exit", context, result);
}

function worktreeResult(toolName: WorktreeToolName, context: CapabilityExecutionContext, result: WorktreeEnvironmentResult): SerializableResult<CoreToolResult> {
  const worktree = result.worktrees[0];
  const metadata = {
    result,
    ...(worktree ? { worktree } : {}),
    diagnostics: result.diagnostics,
    replayFingerprint: result.replayFingerprint
  };
  if (result.status !== "completed") {
    return failure(toolName, "WORKTREE_ENVIRONMENT_REJECTED", result.diagnostics.join("; ") || "Worktree environment operation was rejected.", [], metadata);
  }
  return success(toolName, worktree ? [worktree.path] : [], {
    preview: boundedText(worktree ? `${worktree.worktreeId}: ${worktree.status} ${worktree.path}` : result.action, 8_000),
    metadata,
    replay: replay(context)
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}
