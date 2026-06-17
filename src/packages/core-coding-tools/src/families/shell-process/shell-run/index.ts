import type {
  BackgroundTaskManager,
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult,
  ShellProfile,
  ShellRunInput
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { isModelVisibleWorkspaceRelativePath, processResultToEvidence, requireDeps, resolveToolPath, workspaceRelativePath } from "../../../shared/workspace.js";
import {
  bindSweLiteCheckoutVirtualEnv,
  classifyPythonTestFailure,
  currentSweLiteCheckoutRoot,
  defaultSweLiteCheckoutProcessTimeoutMs,
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
  const sweBenchViolation = sweBenchBoundaryViolation(parsed.command, parsedArgs, cwd, workspaceRoot);
  if (sweBenchViolation) {
    return failure(
      "shell.run",
      "SWE_BENCH_BOUNDARY_REJECTED",
      "SWE-bench commands must verify the selected checkout without mining upstream history or replacing it with the same package from an index.",
      [cwd],
      { violation: sweBenchViolation }
    );
  }
  const currentSweLiteCheckout = currentSweLiteCheckoutRoot(cwd, workspaceRoot);
  const packageInstallViolation = hostPackageInstallViolation(parsed.command, parsedArgs, currentSweLiteCheckout);
  if (packageInstallViolation) {
    return failure("shell.run", "HOST_PACKAGE_INSTALL_REJECTED", "Model-authored package installs must use a project-local virtual environment or an explicit local install target.", [cwd], {
      violation: packageInstallViolation
    });
  }

  const shellProfile = typeof parsed.shellProfile === "string" ? parsed.shellProfile as ShellProfile : undefined;
  const invocation = await resolveShellInvocation(deps, parsed.command, parsedArgs, shellProfile);
  if (!invocation.ok) {
    return failure("shell.run", invocation.code, invocation.message, [cwd]);
  }
  const resolvedInvocation = currentSweLiteCheckout ? bindSweLiteCheckoutVirtualEnv(invocation.value, currentSweLiteCheckout) : invocation.value;

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
        ...(resolvedInvocation.sweLiteVenvBound ? { sweLiteVenvBound: true } : {}),
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
    timeoutMs: parsed.timeoutMs ?? defaultSweLiteCheckoutProcessTimeoutMs(parsed.command, parsedArgs, currentSweLiteCheckout),
    executionProfile: parsed.executionProfile ?? "noninteractive",
    stdin: "ignore",
    outputLimitBytes: parsed.limitBytes ?? 16_000
  });
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
    ...(resolvedInvocation.sweLiteVenvBound ? { sweLiteVenvBound: true } : {})
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
  if (/^\.deepseek\/swebench-workspaces\/[^/]+\/repo\/\.venv(?:\/|$)/.test(normalized)) return true;
  if (isCurrentSweLiteCheckoutReference(normalized, cwd, workspaceRoot)) return true;
  return isModelVisibleWorkspaceRelativePath(normalized);
}

function isCurrentSweLiteCheckoutReference(path: string, cwd: string, workspaceRoot: string): boolean {
  const match = path.match(/^\.deepseek\/swe-lite-runs\/[^/]+\/repo(?:\/|$)/);
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

function sweBenchBoundaryViolation(command: string, args: readonly string[], cwd: string, workspaceRoot: string): string | undefined {
  if (directHistoricalSweBenchWorkspaceTraversal(command, args, cwd, workspaceRoot)) {
    return "direct traversal into historical SWE-bench workspace";
  }
  const shellText = [cwd, command, ...args].join(" ").toLowerCase();
  const benchmark = sweBenchContext(shellText);
  if (!benchmark) return undefined;
  if (usesGitHistoryMining(shellText)) return "git history mining in benchmark workspace";
  if (installsBenchmarkPackageFromIndex(shellText, benchmark.repoName)) {
    return `pip install benchmark package ${benchmark.repoName} from index`;
  }
  return undefined;
}

function directHistoricalSweBenchWorkspaceTraversal(command: string, args: readonly string[], cwd: string, workspaceRoot: string): boolean {
  if (cwdInsideSweBenchCheckout(cwd, workspaceRoot)) return false;
  const shellText = [command, ...args].join(" ").toLowerCase().replace(/\\/g, "/").replace(/\/+/g, "/");
  return /(?:^|[/"'\s])\.deepseek\/swebench-workspaces\/[^/"'\s]+\/repo(?:$|[/"'\s])/.test(shellText);
}

function cwdInsideSweBenchCheckout(cwd: string, workspaceRoot: string): boolean {
  const relative = workspaceRelativePath(workspaceRoot, cwd).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.?\//, "").replace(/\/$/, "");
  return /^\.?deepseek\/swebench-workspaces\/[^/]+\/repo(?:\/|$)/.test(relative);
}

function sweBenchContext(shellText: string): { readonly instanceId: string; readonly repoName: string } | undefined {
  const match = shellText.match(/(?:^|[/"'\s])\.deepseek\/swebench-workspaces\/([^/"'\s]+)\/repo(?:$|[/"'\s])/);
  const instanceId = match?.[1];
  if (!instanceId) return undefined;
  const repoMatch = instanceId.match(/^[^_]+__(.+)-\d+$/);
  const repoName = repoMatch?.[1];
  return repoName ? { instanceId, repoName } : undefined;
}

function usesGitHistoryMining(shellText: string): boolean {
  return /(?:^|[;&|]\s*|\s)git\s+(?:log|show|blame|reflog)(?:\s|$)/.test(shellText);
}

function installsBenchmarkPackageFromIndex(shellText: string, repoName: string): boolean {
  const normalizedRepoName = normalizePackageName(repoName);
  for (const segment of pipInstallArgumentSegments(shellText)) {
    let skipEditableTarget = false;
    for (const rawToken of segment.split(/\s+/)) {
      const token = rawToken.trim().replace(/^['"]|['"]$/g, "");
      if (!token || isShellRedirectionToken(token)) continue;
      if (token === "-e" || token === "--editable") {
        skipEditableTarget = true;
        continue;
      }
      if (skipEditableTarget) {
        skipEditableTarget = false;
        continue;
      }
      if (token.startsWith("-") || isLocalInstallTarget(token)) continue;
      const packageName = normalizePackageName(token.split(/[<>=!~\[]/, 1)[0] ?? "");
      if (packageName === normalizedRepoName) return true;
    }
  }
  return false;
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
    token.includes(".deepseek/swebench-workspaces/") ||
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
    /(?:^|\s)(?:--target|-t|--prefix|--root)\s+(?:\.|\.\/|\w[^/\s]*|\.deepseek\/swebench-workspaces\/)/.test(shellText)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
