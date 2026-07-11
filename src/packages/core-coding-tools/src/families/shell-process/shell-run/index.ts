import type {
  BackgroundTaskManager,
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  PlatformOsFamily,
  SerializableResult,
  ShellProfile,
  ShellRunInput
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { isModelVisibleWorkspaceRelativePath, processResultToEvidence, requireDeps, resolveToolPath, workspaceRelativePath } from "../../../shared/workspace.js";
import {
  bindManagedCheckoutVirtualEnv,
  classifyPythonTestFailure,
  currentManagedCheckoutRoot,
  defaultManagedCheckoutProcessTimeoutMs,
  isPythonTestLikeCommand,
  resolveShellInvocation,
  withRepoLocalPythonRunnerHint,
  withModelFacingTestFailure
} from "../../../shared/process-command.js";

export interface ShellRunToolDeps extends CoreCodingToolsDependencies {
  readonly backgroundTasks?: BackgroundTaskManager;
}

export function defineShellRunTool(deps: ShellRunToolDeps | undefined) {
  return defineToolManifest(
    "shell.run",
    coreToolIds.shellRun,
    "Shell Run",
    "process",
    ["process:run"],
    objectSchema(["command"], {
      command: { type: "string" },
      args: { type: "array" },
      cwd: { type: "string" },
      workspaceRoot: { type: "string" },
      timeoutMs: { type: "number" },
      limitBytes: { type: "number" },
      shellProfile: { type: "string" },
      executionProfile: { type: "string" },
      runInBackground: { type: "boolean" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => shellRunTool(input, context, ready as ShellRunToolDeps))
  );
}

async function shellRunTool(input: JsonObject, context: CapabilityExecutionContext, deps: ShellRunToolDeps): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as ShellRunInput;
  const parsedArgs = Array.isArray(parsed.args) ? parsed.args.map(String) : [];
  const workspaceRoot = parsed.workspaceRoot ?? deps.workspaceRoot;
  const cwdPath = resolveToolPath(deps, workspaceRoot, parsed.cwd ?? ".");
  if (!cwdPath.ok || !cwdPath.value) return failure("shell.run", "PATH_REJECTED", cwdPath.error?.message ?? "Path rejected.", [String(parsed.cwd ?? ".")]);
  const cwd = cwdPath.value.path;
  const internalArtifactReference = internalArtifactPathReference(parsed.command, parsedArgs, cwd, workspaceRoot);
  if (internalArtifactReference) {
    return failure("shell.run", "INTERNAL_ARTIFACT_REJECTED", "Internal evaluation artifacts are not model-visible through shell.run.", [cwd], {
      reference: internalArtifactReference
    });
  }
  const currentManagedCheckout = currentManagedCheckoutRoot(cwd, workspaceRoot);
  const packageInstallViolation = hostPackageInstallViolation(parsed.command, parsedArgs, currentManagedCheckout);
  if (packageInstallViolation) {
    return failure("shell.run", "HOST_PACKAGE_INSTALL_REJECTED", "Model-authored package installs must use a project-local virtual environment or an explicit local install target.", [cwd], {
      violation: packageInstallViolation
    });
  }
  const shellProfile = typeof parsed.shellProfile === "string" ? parsed.shellProfile as ShellProfile : undefined;
  const shellMatching = shellCommandMatching(deps.platform.os, shellProfile);
  const evidenceDestruction = shellEvidenceDestructionGuidance(parsed.command, parsedArgs, shellMatching);
  if (evidenceDestruction) {
    return failure(
      "shell.run",
      "SHELL_EVIDENCE_DESTRUCTION_REJECTED",
      evidenceDestruction.message,
      [cwd],
      {
        rejectedCommand: [parsed.command, ...parsedArgs].join(" "),
        correctiveAction: evidenceDestruction.correctiveAction
      }
    );
  }
  const shellMutation = shellWorkspaceMutationGuidance(parsed.command, parsedArgs, shellMatching);
  if (shellMutation) {
    return failure(
      "shell.run",
      "SHELL_WORKSPACE_MUTATION_REJECTED",
      shellMutation.message,
      [cwd],
      {
        rejectedCommand: [parsed.command, ...parsedArgs].join(" "),
        recommendedTool: shellMutation.recommendedTool,
        correctiveAction: shellMutation.correctiveAction
      }
    );
  }

  const invocation = await resolveShellInvocation(deps, parsed.command, parsedArgs, shellProfile);
  if (!invocation.ok) {
    return failure("shell.run", invocation.code, invocation.message, [cwd]);
  }
  const resolvedInvocation = currentManagedCheckout ? bindManagedCheckoutVirtualEnv(invocation.value, currentManagedCheckout) : invocation.value;

  if (parsed.runInBackground === true) {
    if (!deps.backgroundTasks) {
      return failure("shell.run", "BACKGROUND_TASKS_UNAVAILABLE", "BackgroundTaskManager is not registered in runtime dependencies.", [cwd]);
    }
    const summary = await deps.backgroundTasks.start({ command: resolvedInvocation.command, args: resolvedInvocation.args, cwd });
    return success("shell.run", [cwd], {
      preview: boundedText(`[background] ${summary.taskId} ${resolvedInvocation.command}`, parsed.limitBytes ?? 8_000),
      metadata: {
        background: true,
        taskId: summary.taskId,
        shellSyntax: resolvedInvocation.shellSyntax,
        ...(resolvedInvocation.managedCheckoutVenvBound ? { managedCheckoutVenvBound: true } : {}),
        summary: summary as unknown as JsonObject
      },
      replay: replay(context),
      status: "completed"
    });
  }

  const processProvider = await deps.platform.resolveProcessProvider();
  if (!processProvider.available) {
    return failure("shell.run", "PROCESS_UNAVAILABLE", processProvider.diagnostics[0]?.message ?? "Process unavailable.", [cwd], { processProvider });
  }
  const result = await deps.platform.runProcess(resolvedInvocation.command, resolvedInvocation.args, {
    cwd,
    timeoutMs: parsed.timeoutMs ?? defaultManagedCheckoutProcessTimeoutMs(parsed.command, parsedArgs, currentManagedCheckout),
    executionProfile: parsed.executionProfile ?? "noninteractive",
    stdin: "ignore",
    outputLimitBytes: parsed.limitBytes ?? 16_000
  }, undefined, { signal: context.signal });
  const testFailure = await withRepoLocalPythonRunnerHint(
    isPythonTestLikeCommand(parsed.command, parsedArgs) ? classifyPythonTestFailure(result, { command: parsed.command, args: parsedArgs }) : undefined,
    deps,
    cwd
  );
  const evidenceResult = testFailure ? withModelFacingTestFailure(result, testFailure.feedback) : result;
  return processResultToEvidence("shell.run", evidenceResult, cwd, context, parsed.limitBytes, {
    shellSyntax: resolvedInvocation.shellSyntax,
    ...(testFailure ? { testFailure: testFailure.metadata } : {}),
    ...(resolvedInvocation.shellProfile ? { shellProfile: resolvedInvocation.shellProfile } : {}),
    ...(resolvedInvocation.managedCheckoutVenvBound ? { managedCheckoutVenvBound: true } : {})
  });
}

function internalArtifactPathReference(command: string, args: readonly string[], cwd: string, workspaceRoot: string): string | undefined {
  return [command, ...args]
    .flatMap((value) => String(value).split(/\s+/))
    .map((value) => value.replace(/^['"]|['"]$/g, ""))
    .find((value) => {
      const deepseekPath = deepseekPathFragment(value);
      return deepseekPath !== undefined && !isShellAccessibleDeepseekPath(deepseekPath, cwd, workspaceRoot);
    });
}

function deepseekPathFragment(value: string): string | undefined {
  const index = value.indexOf(".deepseek/");
  return index >= 0 ? value.slice(index) : undefined;
}

function isShellAccessibleDeepseekPath(path: string, cwd: string, workspaceRoot: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  if (/^\.deepseek\/evaluation-runs\/[^/]+\/repo\/\.venv(?:\/|$)/.test(normalized)) return true;
  if (isCurrentManagedCheckoutReference(normalized, cwd, workspaceRoot)) return true;
  return isModelVisibleWorkspaceRelativePath(normalized);
}

function isCurrentManagedCheckoutReference(path: string, cwd: string, workspaceRoot: string): boolean {
  const match = path.match(/^\.deepseek\/evaluation-runs\/[^/]+\/repo(?:\/|$)/);
  if (!match) return false;
  const checkoutRoot = match[0].replace(/\/$/, "");
  return pathInsideCheckout(cwd, checkoutRoot) || pathInsideCheckout(workspaceRoot, checkoutRoot);
}

function pathInsideCheckout(path: string, checkoutRoot: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized === checkoutRoot || normalized.endsWith(`/${checkoutRoot}`) || normalized.includes(`/${checkoutRoot}/`);
}

function hostPackageInstallViolation(command: string, args: readonly string[], currentCheckoutRoot?: string): string | undefined {
  const shellText = [command, ...args].join(" ").toLowerCase();
  if (/\s--break-system-packages(?:\s|$)/.test(shellText)) return "--break-system-packages";
  if (!isPipInstallCommand(shellText)) return undefined;
  if (currentCheckoutRoot && pipInstallTargetsAreLocal(shellText)) return undefined;
  if (currentCheckoutRoot && pipInstallIsSafeForCheckoutBoundVenv(shellText)) return undefined;
  if (targetsProjectLocalPythonEnvironment(shellText, currentCheckoutRoot)) return undefined;
  return "pip install without project-local environment";
}

interface ShellCommandMatching {
  readonly caseSensitive: boolean;
}

function shellCommandMatching(os: PlatformOsFamily, shellProfile: ShellProfile | undefined): ShellCommandMatching {
  if (shellProfile === "cmd" || shellProfile === "powershell") return { caseSensitive: false };
  if (shellProfile === "bash" || shellProfile === "sh") return { caseSensitive: true };
  return { caseSensitive: os !== "windows" };
}

function shellCommandMatcher(command: string, args: readonly string[], matching: ShellCommandMatching) {
  const shellText = [command, ...args].join(" ").trim();
  const comparableText = comparableShellText(shellText, matching);
  const directCommand = comparableShellText(firstShellToken(command), matching);
  const tokens = [directCommand, ...args.map((arg) => comparableShellText(firstShellToken(arg), matching))].filter(Boolean);
  return {
    shellText,
    comparableText,
    hasCommand(name: string) {
      const comparableName = comparableShellText(name, matching);
      return tokens.includes(comparableName) || new RegExp(`(?:^|[;&|()\\s])${escapeRegExp(comparableName)}(?:\\s|$)`).test(comparableText);
    }
  };
}

function comparableShellText(value: string, matching: ShellCommandMatching): string {
  return matching.caseSensitive ? value : value.toLowerCase();
}

function shellEvidenceDestructionGuidance(command: string, args: readonly string[], matching: ShellCommandMatching): {
  readonly correctiveAction: string;
  readonly message: string;
} | undefined {
  const { hasCommand } = shellCommandMatcher(command, args, matching);

  if (hasCommand("clear") || hasCommand("cls") || hasCommand("reset") || hasCommand("clear-host") || hasCommand("clear-screen")) {
    return {
      correctiveAction: "Do not clear terminal evidence; inspect existing output or run the next verification command with bounded output.",
      message: "Terminal evidence destruction commands are rejected so the CLI can preserve auditable command output and recovery context."
    };
  }
  return undefined;
}

function shellWorkspaceMutationGuidance(command: string, args: readonly string[], matching: ShellCommandMatching): {
  readonly recommendedTool: string;
  readonly correctiveAction: string;
  readonly message: string;
} | undefined {
  const { shellText, comparableText, hasCommand } = shellCommandMatcher(command, args, matching);

  if (hasCommand("cp") || hasCommand("copy") || hasCommand("xcopy") || hasCommand("robocopy")) {
    return shellMutation("file.copy", "Use file.copy for cross-platform workspace copy operations.");
  }
  if (hasCommand("mv") || hasCommand("move") || hasCommand("ren") || hasCommand("rename")) {
    return shellMutation("file.move", "Use file.move for cross-platform workspace move or rename operations.");
  }
  if (hasCommand("rm") || hasCommand("del") || hasCommand("erase") || hasCommand("rmdir") || hasCommand("remove-item")) {
    return shellMutation("file.delete", "Use file.delete for cross-platform workspace delete operations.");
  }
  if (hasCommand("mkdir") || hasCommand("md") || hasCommand("new-item")) {
    return shellMutation("directory.create", "Use directory.create for cross-platform workspace directory creation.");
  }
  if (hasCommand("touch")) {
    return shellMutation("file.touch", "Use file.touch for cross-platform empty file creation or existence checks.");
  }
  if (hasCommand("jq")) {
    return shellMutation("json.read", "Use json.read for cross-platform structured JSON reads; use json.patch for governed JSON mutations.");
  }
  if (hasCommand("sha256sum") || hasCommand("shasum") || hasCommand("md5sum") || hasCommand("certutil") || hasCommand("get-filehash")) {
    return shellMutation("checksum.hash", "Use checksum.hash for cross-platform file digest calculation.");
  }
  if (hasCommand("realpath") || hasCommand("readlink") || hasCommand("resolve-path")) {
    return shellMutation("path.resolve", "Use path.resolve for governed cross-platform workspace path normalization.");
  }
  if (hasCommand("env") || hasCommand("printenv") || hasCommand("set") || hasCommand("get-childitem")) {
    return shellMutation("env.inspect", "Use env.inspect for governed environment visibility without leaking secret values by default.");
  }
  if (hasCommand("which") || hasCommand("where") || hasCommand("where.exe") || hasCommand("get-command")) {
    return shellMutation("command.lookup", "Use command.lookup for cross-platform command availability checks.");
  }
  if (hasCommand("zip") || hasCommand("tar")) {
    return shellMutation("archive.create", "Use archive.create for governed workspace archive creation.");
  }
  if (hasCommand("unzip")) {
    return shellMutation("archive.extract", "Use archive.extract for governed workspace archive extraction.");
  }
  if (/\bsed\s+(?:-[^\s]*i[^\s]*|--in-place)(?:\s|$)/.test(comparableText) || /\bperl\s+-(?:[^\s]*i[^\s]*)(?:\s|$)/.test(comparableText)) {
    return shellMutation("file.edit", "Use file.edit for exact cross-platform workspace text mutations.");
  }
  if (usesInlineScriptFileWrite(comparableText)) {
    return shellMutation("file.write", "Use file.write or file.edit for governed cross-platform workspace file mutations.");
  }
  if (/(^|[^<>])(?:>|>>)\s*[^&\s]/.test(shellText) || /\b(?:tee|out-file|set-content|add-content)\b/.test(comparableText)) {
    return shellMutation("file.write", "Use file.write for cross-platform workspace file creation or replacement.");
  }
  return undefined;
}

function usesInlineScriptFileWrite(shellText: string): boolean {
  if (
    /(?:^|[;&|()]\s*|\s)python(?:3(?:\.\d+)?)?(?:\s|$)/.test(shellText) &&
    (/\bopen\s*\([^)]*,\s*["'][^"']*[wax+][^"']*["']/.test(shellText) || /\.(?:write_text|write_bytes)\s*\(/.test(shellText))
  ) {
    return true;
  }
  if (
    /(?:^|[;&|()]\s*|\s)node(?:\s|$)/.test(shellText) &&
    /\b(?:writefilesync|writefile|appendfilesync|appendfile)\s*\(/.test(shellText)
  ) {
    return true;
  }
  if (
    /(?:^|[;&|()]\s*|\s)ruby(?:\s|$)/.test(shellText) &&
    /\bfile\.(?:write|open)\s*\(/.test(shellText)
  ) {
    return true;
  }
  if (
    /(?:^|[;&|()]\s*|\s)perl(?:\s|$)/.test(shellText) &&
    /\bopen\s*\([^)]*,\s*["'][^"']*[>+][^"']*["']/.test(shellText)
  ) {
    return true;
  }
  return false;
}

function shellMutation(recommendedTool: string, correctiveAction: string) {
  return {
    recommendedTool,
    correctiveAction,
    message: "Shell workspace mutation commands are rejected so the CLI can preserve cross-platform behavior, workspace policy, and structured evidence."
  };
}

function firstShellToken(value: string): string {
  return value.trim().split(/\s+/)[0]?.replace(/^['"]|['"]$/g, "") ?? "";
}

function usesGitHistoryMining(shellText: string): boolean {
  return /(?:^|[;&|]\s*|\s)git\s+(?:log|show|blame|reflog)(?:\s|$)/.test(shellText);
}

function pipInstallArgumentSegments(shellText: string): string[] {
  const segments: string[] = [];
  const pipPattern = /(?:^|[;&|]\s*|\s)(?:[a-z0-9_./-]*\/)?pip(?:3(?:\.\d+)?)?\s+install\s+([^;&|]+)/g;
  const pythonPattern = /(?:^|[;&|]\s*|\s)python(?:3(?:\.\d+)?)?\s+-m\s+pip\s+install\s+([^;&|]+)/g;
  for (const pattern of [pipPattern, pythonPattern]) {
    for (const match of shellText.matchAll(pattern)) {
      if (match[1]) segments.push(match[1]);
    }
  }
  return segments;
}

function pipInstallTargetsAreLocal(shellText: string): boolean {
  let sawTarget = false;
  for (const segment of pipInstallArgumentSegments(shellText)) {
    let expectsLocalTarget = false;
    for (const rawToken of segment.split(/\s+/)) {
      const token = rawToken.trim().replace(/^['"]|['"]$/g, "");
      if (!token || isShellRedirectionToken(token)) continue;
      if (token === "-e" || token === "--editable" || token === "-r" || token === "--requirement") {
        expectsLocalTarget = true;
        continue;
      }
      if (expectsLocalTarget) {
        expectsLocalTarget = false;
        if (!isLocalInstallTarget(token)) return false;
        sawTarget = true;
        continue;
      }
      if (token.startsWith("--editable=") || token.startsWith("--requirement=")) {
        const target = token.slice(token.indexOf("=") + 1);
        if (!isLocalInstallTarget(target)) return false;
        sawTarget = true;
        continue;
      }
      if (token.startsWith("-")) continue;
      if (!isLocalInstallTarget(token)) return false;
      sawTarget = true;
    }
    if (expectsLocalTarget) return false;
  }
  return sawTarget;
}

function pipInstallIsSafeForCheckoutBoundVenv(shellText: string): boolean {
  for (const segment of pipInstallArgumentSegments(shellText)) {
    const tokens = segment
      .split(/\s+/)
      .map((token) => token.trim().replace(/^['"]|['"]$/g, ""))
      .filter((token) => token && !isShellRedirectionToken(token));
    if (tokens.some((token) => token === "--user" || token === "--system")) return false;
    if (tokens.some((token) => token === "--root" || token === "--prefix" || token === "--target" || token === "-t")) return false;
    if (tokens.some((token) => token.startsWith("--root=") || token.startsWith("--prefix=") || token.startsWith("--target="))) return false;
  }
  return true;
}

function isShellRedirectionToken(token: string): boolean {
  return /^(?:\d?>|&?>|2>&1)/.test(token);
}

function isLocalInstallTarget(token: string): boolean {
  return (
    token === "." ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("/") ||
    token.includes(".deepseek/evaluation-runs/") ||
    token.endsWith(".whl") ||
    token.endsWith(".tar.gz") ||
    token.endsWith(".zip")
  );
}

function normalizePackageName(value: string): string {
  return value.toLowerCase().replace(/[_]+/g, "-");
}

function isPipInstallCommand(shellText: string): boolean {
  return (
    /(?:^|[;&|]\s*|\s)(?:[a-z0-9_./-]*\/)?pip(?:3(?:\.\d+)?)?\s+install(?:\s|$)/.test(shellText) ||
    /(?:^|[;&|]\s*|\s)python(?:3(?:\.\d+)?)?\s+-m\s+pip\s+install(?:\s|$)/.test(shellText)
  );
}

function targetsProjectLocalPythonEnvironment(shellText: string, currentCheckoutRoot?: string): boolean {
  const normalizedCheckoutRoot = currentCheckoutRoot?.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase();
  if (normalizedCheckoutRoot) {
    const checkoutRootPattern = escapeRegExp(normalizedCheckoutRoot);
    if (
      new RegExp(`(?:^|\\s)(?:source\\s+)?${checkoutRootPattern}/\\.venv/bin/activate(?:\\s|$)`).test(shellText) ||
      new RegExp(`(?:^|\\s)${checkoutRootPattern}/\\.venv/bin/pip(?:3(?:\\.\\d+)?)?\\s+install(?:\\s|$)`).test(shellText) ||
      new RegExp(`(?:^|\\s)${checkoutRootPattern}/\\.venv/bin/python(?:3(?:\\.\\d+)?)?\\s+-m\\s+pip\\s+install(?:\\s|$)`).test(shellText)
    ) {
      return true;
    }
  }
  return (
    /(?:^|\s)(?:source\s+)?(?:\.\/)?\.venv\/bin\/activate(?:\s|$)/.test(shellText) ||
    /(?:^|\s)(?:\.\/)?\.venv\/bin\/pip(?:3(?:\.\d+)?)?\s+install(?:\s|$)/.test(shellText) ||
    /(?:^|\s)(?:\.\/)?venv\/bin\/activate(?:\s|$)/.test(shellText) ||
    /(?:^|\s)(?:\.\/)?venv\/bin\/pip(?:3(?:\.\d+)?)?\s+install(?:\s|$)/.test(shellText) ||
    /(?:^|\s)(?:--target|-t|--prefix|--root)\s+(?:\.|\.\/|\w[^/\s]*|\.deepseek\/evaluation-runs\/)/.test(shellText)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
