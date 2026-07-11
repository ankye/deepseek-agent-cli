import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ProcessResult, ProcessRunOptions } from "@deepseek/platform-contracts";
import { DeterministicCodeIntelligenceService } from "@deepseek/code-intelligence";
import { FakePlatformRuntime } from "@deepseek/platform-abstraction";
import { resolveDevCheck } from "../../src/apps/cli/src/commands/dev-check.js";
import { resolveFileManager } from "../../src/apps/cli/src/commands/file-manager.js";
import { resolveGitReview } from "../../src/apps/cli/src/commands/git-review.js";
import { resolveJumpNavigator } from "../../src/apps/cli/src/commands/jump-navigator.js";
import { resolveRepoNavigator } from "../../src/apps/cli/src/commands/repo.js";

describe("first-party developer workflow command adapters", () => {
  it("rejects dev-check unsupported arguments and shell fragments without process execution", async () => {
    const platform = new RecordingPlatform();

    const unsupported = await resolveDevCheck(platform, "/workspace", "typecheck", ["--watch"]);
    const shell = await resolveDevCheck(platform, "/workspace", "lint", ["npm run lint && rm -rf ."]);

    assert.equal(unsupported.status, "denied");
    assert.equal(unsupported.diagnostics[0]?.code, "DEV_CHECK_ARGS_UNSUPPORTED");
    assert.equal(shell.status, "denied");
    assert.equal(shell.diagnostics[0]?.code, "DEV_CHECK_FREE_FORM_SHELL_DENIED");
    assert.equal(platform.runs.length, 0);
  });

  it("resolves supported dev checks to fixed governed descriptors", async () => {
    const platform = new RecordingPlatform();

    const result = await resolveDevCheck(platform, "/workspace", "lint");

    assert.equal(result.status, "completed");
    assert.equal(result.descriptor?.commandId, "checks.lint");
    assert.deepEqual(result.descriptor?.args, ["run", "lint"]);
    assert.equal(platform.runs.length, 1);
    assert.equal(platform.runs[0]?.command, "npm");
    assert.deepEqual(platform.runs[0]?.args, ["run", "lint"]);
  });

  it("returns repo file and grep result lists through workspace read boundaries", async () => {
    const platform = new RecordingPlatform();
    await platform.writeFile("/workspace/src/index.ts", "export const needle = true;\n");
    await platform.writeFile("/workspace/README.md", "needle docs\n");

    const files = await resolveRepoNavigator(platform, "/workspace", "files", "src");
    const grep = await resolveRepoNavigator(platform, "/workspace", "grep", "needle");

    assert.equal(files.status, "completed");
    assert.equal(files.data.workspaceBoundary, "workspace-root");
    assert.equal(files.resultList?.items[0]?.target.kind, "file");
    assert.equal(files.resultList?.items[0]?.label, "src/index.ts");
    assert.equal(files.resultList?.items[0]?.target.path, "/workspace/src/index.ts");
    assert.equal(grep.status, "completed");
    assert.equal(grep.resultList?.items.length, 2);
    assert.equal(grep.resultList?.items.some((item) => item.label.startsWith("src/index.ts:1:")), true);
    assert.equal(grep.referenceTargets.length, 2);
  });

  it("returns file manager list, preview, and reference targets through read-only workspace boundaries", async () => {
    const platform = new RecordingPlatform();
    await platform.writeFile("/workspace/src/index.ts", "export const needle = true;\n");
    await platform.writeFile("/workspace/docs/guide.md", "needle docs\n");

    const list = await resolveFileManager(platform, "/workspace", "list", "src");
    const preview = await resolveFileManager(platform, "/workspace", "preview", "/workspace/src/index.ts");
    const references = await resolveFileManager(platform, "/workspace", "references", ".md");

    assert.equal(list.status, "completed");
    assert.equal(list.resultList?.id, "result-list:file-manager.list");
    assert.equal(list.resultList?.items[0]?.target.kind, "file");
    assert.equal(list.resultList?.items[0]?.label, "src/index.ts");
    assert.equal(preview.status, "completed");
    assert.equal(preview.data.path, "/workspace/src/index.ts");
    assert.equal(preview.resultList?.id, "result-list:file-manager.preview");
    assert.equal(preview.resultList?.items[0]?.label.startsWith("src/index.ts:1:"), true);
    assert.equal(preview.referenceTargets[0]?.path, "/workspace/src/index.ts");
    assert.equal(references.status, "completed");
    assert.equal(references.referenceItems.length, 1);
    assert.equal(references.referenceTargets[0]?.path, "/workspace/docs/guide.md");
  });

  it("resolves relative file previews against the workspace root before reading", async () => {
    const platform = new RecordingPlatform();
    await platform.writeFile("src/index.ts", "export const wrongRoot = true;\n");
    await platform.writeFile("/workspace/src/index.ts", "export const workspaceRoot = true;\n");

    const preview = await resolveFileManager(platform, "/workspace", "preview", "src/index.ts");

    assert.equal(preview.status, "completed");
    assert.equal(preview.data.path, "/workspace/src/index.ts");
    assert.equal(preview.resultList?.items[0]?.target.metadata?.preview, "export const workspaceRoot = true;");
  });

  it("returns jump navigator file/text/symbol result lists through workspace boundaries", async () => {
    const platform = new RecordingPlatform();
    await platform.writeFile("/workspace/src/index.ts", "export const needle = true;\n");
    await platform.writeFile("/workspace/docs/guide.md", "needle docs\n");
    const codeIntelligence = new DeterministicCodeIntelligenceService(platform);

    const file = await resolveJumpNavigator(platform, "/workspace", "file", "src");
    const text = await resolveJumpNavigator(platform, "/workspace", "text", "needle");
    const symbol = await resolveJumpNavigator(platform, "/workspace", "symbol", "needle", codeIntelligence);

    assert.equal(file.status, "completed");
    assert.equal(file.resultList?.id, "result-list:jump.file");
    assert.equal(file.resultList?.items[0]?.label, "src/index.ts");
    assert.equal(file.activeTarget?.kind, "file");
    assert.equal(text.status, "completed");
    assert.equal(text.resultList?.id, "result-list:jump.text");
    assert.equal(text.resultList?.items.some((item) => item.label.startsWith("src/index.ts:1:")), true);
    assert.equal(text.referenceTargets.length, 2);
    assert.equal(symbol.status, "completed");
    assert.equal(symbol.resultList?.id, "result-list:jump.symbol");
    assert.equal(symbol.resultList?.items[0]?.target.kind, "file");
    assert.equal(symbol.resultList?.items[0]?.label.startsWith("src/index.ts:1:"), true);
    assert.equal(symbol.resultList?.items[0]?.metadata?.symbolName, "needle");
    assert.equal(symbol.activeTarget?.kind, "file");
    assert.equal(symbol.diagnostics.length, 0);
    assert.equal(platform.runs.length, 0);
  });

  it("keeps successful symbol jumps quiet when the background index is truncated", async () => {
    const platform = new RecordingPlatform();
    await platform.writeFile("/workspace/src/index.ts", "export const quietSymbol = true;\n");
    await platform.writeFile("/workspace/docs/guide.md", "quiet docs\n");
    const codeIntelligence = new DeterministicCodeIntelligenceService(platform, { maxFiles: 1 });

    const symbol = await resolveJumpNavigator(platform, "/workspace", "symbol", "quietSymbol", codeIntelligence);
    const index = symbol.data.index as { readonly truncated?: boolean; readonly providerDiagnostics?: readonly { readonly code?: string }[] } | undefined;

    assert.equal(symbol.status, "completed");
    assert.equal(symbol.resultList?.items[0]?.metadata?.symbolName, "quietSymbol");
    assert.equal(symbol.diagnostics.length, 0);
    assert.equal(index?.truncated, true);
    assert.equal(index?.providerDiagnostics?.some((entry) => entry.code === "CODE_INTELLIGENCE_FILE_LIMIT"), true);
  });

  it("defers repo recall and project index to existing chat/index providers with typed diagnostics", async () => {
    const platform = new RecordingPlatform();

    const recall = await resolveRepoNavigator(platform, "/workspace", "recall", "old decision");
    const projectIndex = await resolveRepoNavigator(platform, "/workspace", "project-index", "symbol");

    assert.equal(recall.status, "deferred");
    assert.equal(recall.diagnostics[0]?.code, "REPO_NAVIGATOR_DEFERRED");
    assert.equal(recall.resultList?.items[0]?.target.kind, "diagnostic");
    assert.equal(projectIndex.status, "deferred");
    assert.equal(projectIndex.suggestedActions[0]?.includes("index-provider"), true);
    assert.equal(platform.runs.length, 0);
  });

  it("runs git review only with read-only status, diff, and review commands", async () => {
    const platform = new RecordingPlatform();

    const status = await resolveGitReview(platform, "/workspace", "status");
    const diff = await resolveGitReview(platform, "/workspace", "diff");
    const review = await resolveGitReview(platform, "/workspace", "review");

    assert.equal(status.status, "completed");
    assert.equal(status.resultList?.items[0]?.target.kind, "file");
    assert.equal(diff.status, "completed");
    assert.equal(diff.resultList?.items[0]?.target.kind, "diff");
    assert.equal(review.status, "completed");
    assert.deepEqual(platform.runs.map((run) => [run.command, run.args]), [
      ["git", ["status", "--short"]],
      ["git", ["diff", "--stat"]],
      ["git", ["status", "--short"]],
      ["git", ["diff", "--stat"]]
    ]);
  });

  it("rejects destructive git operations and extra arguments without process execution", async () => {
    const destructive = ["commit", "checkout", "reset", "clean", "merge", "rebase", "push", "branch-delete"];
    for (const action of destructive) {
      const platform = new RecordingPlatform();
      const result = await resolveGitReview(platform, "/workspace", action);
      assert.equal(result.status, "denied", action);
      assert.equal(result.diagnostics[0]?.code, "GIT_REVIEW_DESTRUCTIVE_DENIED");
      assert.equal(platform.runs.length, 0, action);
    }

    const branch = new RecordingPlatform();
    const branchDelete = await resolveGitReview(branch, "/workspace", "branch", ["-D", "main"]);
    assert.equal(branchDelete.status, "denied");
    assert.equal(branchDelete.diagnostics[0]?.code, "GIT_REVIEW_DESTRUCTIVE_DENIED");
    assert.equal(branch.runs.length, 0);

    const extra = new RecordingPlatform();
    const unsupportedArgs = await resolveGitReview(extra, "/workspace", "status", ["--porcelain"]);
    assert.equal(unsupportedArgs.status, "denied");
    assert.equal(unsupportedArgs.diagnostics[0]?.code, "GIT_REVIEW_ARGS_UNSUPPORTED");
    assert.equal(extra.runs.length, 0);
  });
});

class RecordingPlatform extends FakePlatformRuntime {
  readonly runs: { readonly command: string; readonly args: readonly string[]; readonly options: ProcessRunOptions }[] = [];

  constructor() {
    super("fake", "/workspace");
  }

  override async runProcess(command: string, args: readonly string[], options: ProcessRunOptions = {}): Promise<ProcessResult> {
    this.runs.push({ command, args, options });
    if (command === "git" && args[0] === "status") {
      return { exitCode: 0, stdout: " M src/index.ts\n?? tests/new.test.ts\n", stderr: "" };
    }
    if (command === "git" && args[0] === "diff") {
      return { exitCode: 0, stdout: " src/index.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "ok\n", stderr: "" };
  }
}
