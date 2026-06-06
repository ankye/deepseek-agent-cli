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
import { isModelVisibleWorkspaceRelativePath, processResultToEvidence, requireDeps, resolveToolPath } from "../../../shared/workspace.js";

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
  const cwdPath = resolveToolPath(deps, parsed.workspaceRoot, parsed.cwd ?? ".");
  if (!cwdPath.ok || !cwdPath.value) return failure("shell.run", "PATH_REJECTED", cwdPath.error?.message ?? "Path rejected.", [String(parsed.cwd ?? ".")]);
  const cwd = cwdPath.value.path;
  const internalArtifactReference = internalArtifactPathReference(parsed.command, parsedArgs);
  if (internalArtifactReference) {
    return failure("shell.run", "INTERNAL_ARTIFACT_REJECTED", "Internal evaluation artifacts are not model-visible through shell.run.", [cwd], {
      reference: internalArtifactReference
    });
  }
  const sweBenchViolation = sweBenchBoundaryViolation(parsed.command, parsedArgs, cwd);
  if (sweBenchViolation) {
    return failure(
      "shell.run",
      "SWE_BENCH_BOUNDARY_REJECTED",
      "SWE-bench commands must verify the selected checkout without mining upstream history or replacing it with the same package from an index.",
      [cwd],
      { violation: sweBenchViolation }
    );
  }
  const packageInstallViolation = hostPackageInstallViolation(parsed.command, parsedArgs);
  if (packageInstallViolation) {
    return failure("shell.run", "HOST_PACKAGE_INSTALL_REJECTED", "Model-authored package installs must use a project-local virtual environment or an explicit local install target.", [cwd], {
      violation: packageInstallViolation
    });
  }

  const shellProfile = typeof parsed.shellProfile === "string" ? parsed.shellProfile as ShellProfile : undefined;
  const invocation = await shellInvocation(deps, parsed.command, parsedArgs, shellProfile);
  if (!invocation.ok) {
    return failure("shell.run", invocation.code, invocation.message, [cwd]);
  }

  if (parsed.runInBackground === true) {
    if (!deps.backgroundTasks) {
      return failure("shell.run", "BACKGROUND_TASKS_UNAVAILABLE", "BackgroundTaskManager is not registered in runtime dependencies.", [cwd]);
    }
    const summary = await deps.backgroundTasks.start({ command: invocation.value.command, args: invocation.value.args, cwd });
    return success("shell.run", [cwd], {
      preview: boundedText(`[background] ${summary.taskId} ${invocation.value.command}`, parsed.limitBytes ?? 8_000),
      metadata: { background: true, taskId: summary.taskId, shellSyntax: invocation.value.shellSyntax, summary: summary as unknown as JsonObject },
      replay: replay(context),
      status: "completed"
    });
  }

  const processProvider = await deps.platform.resolveProcessProvider();
  if (!processProvider.available) {
    return failure("shell.run", "PROCESS_UNAVAILABLE", processProvider.diagnostics[0]?.message ?? "Process unavailable.", [cwd], { processProvider });
  }
  const result = await deps.platform.runProcess(invocation.value.command, invocation.value.args, {
    cwd,
    timeoutMs: parsed.timeoutMs ?? 30_000,
    executionProfile: parsed.executionProfile ?? "noninteractive",
    stdin: "ignore",
    outputLimitBytes: parsed.limitBytes ?? 16_000
  });
  return processResultToEvidence("shell.run", result, cwd, context, parsed.limitBytes, {
    shellSyntax: invocation.value.shellSyntax,
    ...(invocation.value.shellProfile ? { shellProfile: invocation.value.shellProfile } : {})
  });
}

interface ShellInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly shellSyntax: boolean;
  readonly shellProfile?: ShellProfile;
}

type ShellInvocationResult = { readonly ok: true; readonly value: ShellInvocation } | { readonly ok: false; readonly code: string; readonly message: string };

async function shellInvocation(
  deps: ShellRunToolDeps,
  command: string,
  args: readonly string[],
  shellProfile: ShellProfile | undefined
): Promise<ShellInvocationResult> {
  if (!shouldUseShellSyntax(command, args, shellProfile)) {
    return { ok: true, value: { command, args, shellSyntax: false } };
  }
  const shell = await deps.platform.resolveShell(shellProfile);
  if (!shell.ok) {
    return {
      ok: false,
      code: shell.error?.code ?? "SHELL_UNAVAILABLE",
      message: shell.error?.message ?? "Shell unavailable."
    };
  }
  if (!shell.value?.command) {
    return {
      ok: false,
      code: "SHELL_UNAVAILABLE",
      message: "Resolved shell does not provide an executable command."
    };
  }
  const shellCommand = args.length === 0 ? command : [command, ...args.map(shellQuote)].join(" ");
  return {
    ok: true,
    value: {
      command: shell.value.command,
      args: [...shell.value.args, shellCommand],
      shellSyntax: true,
      shellProfile: shell.value.profile
    }
  };
}

function shouldUseShellSyntax(command: string, args: readonly string[], shellProfile: ShellProfile | undefined): boolean {
  if (shellProfile) return true;
  if (args.length > 0) return false;
  return /\s/.test(command.trim()) || /[;&|<>`$(){}[\]*?~]/.test(command);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function internalArtifactPathReference(command: string, args: readonly string[]): string | undefined {
  return [command, ...args]
    .flatMap((value) => String(value).split(/\s+/))
    .map((value) => value.replace(/^['"]|['"]$/g, ""))
    .find((value) => value.includes(".deepseek/") && !isShellAccessibleDeepseekPath(value.slice(value.indexOf(".deepseek/"))));
}

function isShellAccessibleDeepseekPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  if (/^\.deepseek\/swebench-workspaces\/[^/]+\/repo\/\.venv(?:\/|$)/.test(normalized)) return true;
  return isModelVisibleWorkspaceRelativePath(normalized);
}

function hostPackageInstallViolation(command: string, args: readonly string[]): string | undefined {
  const shellText = [command, ...args].join(" ").toLowerCase();
  if (/\s--break-system-packages(?:\s|$)/.test(shellText)) return "--break-system-packages";
  if (!isPipInstallCommand(shellText)) return undefined;
  if (targetsProjectLocalPythonEnvironment(shellText)) return undefined;
  return "pip install without project-local environment";
}

function sweBenchBoundaryViolation(command: string, args: readonly string[], cwd: string): string | undefined {
  const shellText = [cwd, command, ...args].join(" ").toLowerCase();
  const benchmark = sweBenchContext(shellText);
  if (!benchmark) return undefined;
  if (usesGitHistoryMining(shellText)) return "git history mining in benchmark workspace";
  if (installsBenchmarkPackageFromIndex(shellText, benchmark.repoName)) {
    return `pip install benchmark package ${benchmark.repoName} from index`;
  }
  return undefined;
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

function targetsProjectLocalPythonEnvironment(shellText: string): boolean {
  return (
    /(?:^|\s)(?:source\s+)?(?:\.\/)?\.venv\/bin\/activate(?:\s|$)/.test(shellText) ||
    /(?:^|\s)(?:\.\/)?\.venv\/bin\/pip(?:3(?:\.\d+)?)?\s+install(?:\s|$)/.test(shellText) ||
    /(?:^|\s)(?:\.\/)?venv\/bin\/activate(?:\s|$)/.test(shellText) ||
    /(?:^|\s)(?:\.\/)?venv\/bin\/pip(?:3(?:\.\d+)?)?\s+install(?:\s|$)/.test(shellText) ||
    /(?:^|\s)(?:--target|-t|--prefix|--root)\s+(?:\.|\.\/|\w[^/\s]*|\.deepseek\/swebench-workspaces\/)/.test(shellText)
  );
}
