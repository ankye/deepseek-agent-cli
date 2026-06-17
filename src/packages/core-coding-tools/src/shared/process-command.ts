import type { JsonObject, ShellProfile } from "@deepseek/platform-contracts";
import type { CoreCodingToolsDependencies } from "./workspace.js";

export interface ShellInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly shellSyntax: boolean;
  readonly shellProfile?: ShellProfile;
  readonly sweLiteVenvBound?: boolean;
}

export type ShellInvocationResult =
  | { readonly ok: true; readonly value: ShellInvocation }
  | { readonly ok: false; readonly code: string; readonly message: string };

const SWE_LITE_CHECKOUT_SLOW_PROCESS_TIMEOUT_MS = 600_000;

export async function resolveShellInvocation(
  deps: Pick<CoreCodingToolsDependencies, "platform">,
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
  const shellArgs = normalizeShellSyntaxArgs(command, args);
  const shellCommand = normalizeShellCommand(shell.value.profile, shellArgs.length === 0 ? command : [command, ...shellArgs.map(shellQuote)].join(" "));
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

export function currentSweLiteCheckoutRoot(cwd: string, workspaceRoot: string): string | undefined {
  return sweLiteCheckoutRootFromPath(cwd) ?? sweLiteCheckoutRootFromPath(workspaceRoot);
}

export function bindSweLiteCheckoutVirtualEnv(invocation: ShellInvocation, checkoutRoot: string): ShellInvocation {
  const venvBin = `${checkoutRoot}/.venv/bin`;
  if (invocation.shellSyntax) {
    const args = [...invocation.args];
    const shellCommand = args.pop() ?? "";
    return {
      ...invocation,
      args: [...args, bindPathAfterShellPrelude(shellCommand, venvBin, checkoutRoot)],
      sweLiteVenvBound: true
    };
  }
  const executable = sweLiteCheckoutVirtualEnvExecutable(invocation.command, checkoutRoot);
  if (!executable) return invocation;
  if (executable.kind === "pip") {
    return {
      ...invocation,
      command: `${checkoutRoot}/.venv/bin/python`,
      args: ["-m", "pip", ...invocation.args],
      sweLiteVenvBound: true
    };
  }
  return { ...invocation, command: `${checkoutRoot}/.venv/bin/${executable.name}`, sweLiteVenvBound: true };
}

export function defaultSweLiteCheckoutProcessTimeoutMs(command: string, args: readonly string[], currentCheckoutRoot?: string): number {
  if (currentCheckoutRoot && isSweLiteCheckoutSlowCommand(command, args)) {
    return SWE_LITE_CHECKOUT_SLOW_PROCESS_TIMEOUT_MS;
  }
  return 30_000;
}

export interface PythonTestFailureClassification {
  readonly feedback: string;
  readonly metadata: JsonObject;
}

export interface PythonTestFailureInvocationContext {
  readonly command: string;
  readonly args?: readonly string[];
}

export async function withRepoLocalPythonRunnerHint(
  classification: PythonTestFailureClassification | undefined,
  deps: Pick<CoreCodingToolsDependencies, "platform">,
  cwd: string
): Promise<PythonTestFailureClassification | undefined> {
  if (!classification) return undefined;
  const moduleName = typeof classification.metadata.moduleName === "string" ? classification.metadata.moduleName : "";
  if (classification.metadata.kind !== "python-missing-module" || !isPythonTestLauncherModule(moduleName)) return classification;
  const runner = await repoLocalPythonTestRunner(deps, cwd);
  if (!runner) return classification;
  const alternateCommand = `python ${runner}`;
  return {
    feedback: [
      `PYTHON_TEST_DEPENDENCY_MISSING: Python test environment is missing module '${moduleName}'.`,
      `Python test launcher '${moduleName}' is unavailable in this checkout, but a repo-local Python test runner is available.`,
      `Repo-local Python test runner is available at '${runner}'.`,
      `Next action: rerun the focused test through the repo-local runner from the checkout root, for example: ${alternateCommand} <focused-test-module> -v 2.`,
      `Do not install ${moduleName} or repeat that launcher before trying the repo-local runner once.`
    ].join("\n"),
    metadata: {
      ...classification.metadata,
      suggestedCommand: alternateCommand,
      alternateCommand,
      alternateRunnerPath: runner,
      suggestedAction: "use-repo-local-python-test-runner"
    }
  };
}

function isPythonTestLauncherModule(moduleName: string): boolean {
  return /^(?:pytest|nose|nose2)$/.test(moduleName);
}

export function isStandardTestCommand(command: string, args: readonly string[] = []): boolean {
  return commandSegments(command, args).some((segment) =>
    isPythonTestSegment(segment)
    || isJavaScriptTestSegment(segment)
    || isGoTestSegment(segment)
    || isRustTestSegment(segment)
    || isJavaTestSegment(segment)
  );
}

export function isPythonTestLikeCommand(command: string, args: readonly string[]): boolean {
  return commandSegments(command, args).some(isPythonTestSegment);
}

function commandSegments(command: string, args: readonly string[]): readonly string[] {
  return shellPayloadText(command, args)
    .toLowerCase()
    .split(/&&|\|\||[;|]/)
    .map(normalizeCommandSegment)
    .filter((segment) => segment.length > 0);
}

function shellPayloadText(command: string, args: readonly string[]): string {
  const executable = shellExecutableName(command);
  if (executable === "wsl") {
    return wslPayloadText(args);
  }
  const payloadIndex = shellPayloadArgIndex(executable, args);
  if (payloadIndex >= 0) {
    return args.slice(payloadIndex + 1).join(" ");
  }
  return [command, ...args].join(" ");
}

function normalizeCommandSegment(segment: string): string {
  let normalized = segment.replace(/\\/g, "/").trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const before = normalized;
    normalized = stripWslCommandPrefix(normalized);
    normalized = normalized.replace(/^(?:cmd(?:\.exe)?)\s+(?:(?:\/d|\/s)\s+)*\/c\s+/, "").trim();
    normalized = normalized.replace(/^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-[a-z]+\s+)*-(?:command|c)\s+/, "").trim();
    normalized = normalized.replace(/^(?:bash|sh|zsh)\s+-(?:lc|c)\s+/, "").trim();
    if (normalized === before) break;
  }
  normalized = normalized.replace(/^(?:set\s+-[A-Za-z]+\s+\S+\s*)+/, "").trim();
  normalized = normalized.replace(/^env\s+/, "").trim();
  normalized = stripEnvironmentAssignments(normalized);
  normalized = normalized.replace(/^time\s+/, "").trim();
  normalized = normalized.replace(/^timeout\s+\S+\s+/, "").trim();
  return stripEnvironmentAssignments(normalized);
}

function stripWslCommandPrefix(segment: string): string {
  let normalized = segment.replace(/^wsl(?:\.exe)?(?:\s+|$)/i, "");
  if (normalized === segment) return segment;
  normalized = normalized.trim();
  while (normalized.length > 0) {
    if (normalized.startsWith("-- ")) return normalized.slice(3).trim();
    const exec = normalized.match(/^(?:-e|--exec)\s+/i);
    if (exec) return normalized.slice(exec[0].length).trim();
    const optionWithValue = normalized.match(/^(?:-d|--distribution|--distribution-id|--vm-id|-u|--user|--cd|--shell-type)\s+(?:"[^"]*"|'[^']*'|\S+)\s*/i);
    if (optionWithValue) {
      normalized = normalized.slice(optionWithValue[0].length).trim();
      continue;
    }
    const flag = normalized.match(/^(?:-[A-Za-z][\w-]*|--[A-Za-z][\w-]*(?:=\S+)?)(?:\s+|$)/);
    if (flag) {
      normalized = normalized.slice(flag[0].length).trim();
      continue;
    }
    break;
  }
  return normalized;
}

function shellExecutableName(command: string): string {
  return (command.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? command.toLowerCase()).replace(/\.exe$/, "");
}

function shellPayloadArgIndex(executable: string, args: readonly string[]): number {
  if (/^(?:bash|sh|zsh)$/.test(executable)) {
    return args.findIndex((arg) => arg === "-lc" || arg === "-c");
  }
  if (/^(?:powershell|pwsh)$/.test(executable)) {
    return args.findIndex((arg) => /^-(?:command|c)$/i.test(arg));
  }
  if (executable === "cmd") {
    return args.findIndex((arg) => /^\/c$/i.test(arg));
  }
  return -1;
}

function wslPayloadText(args: readonly string[]): string {
  let index = 0;
  while (index < args.length) {
    const arg = args[index]?.toLowerCase();
    if (!arg) break;
    if (arg === "--") {
      index += 1;
      break;
    }
    if (arg === "-e" || arg === "--exec") {
      index += 1;
      break;
    }
    if (isWslOptionWithValue(arg)) {
      index += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  const nestedCommand = args[index];
  if (!nestedCommand) return args.join(" ");
  return shellPayloadText(nestedCommand, args.slice(index + 1));
}

function isWslOptionWithValue(arg: string): boolean {
  return (
    arg === "-d" ||
    arg === "--distribution" ||
    arg === "--distribution-id" ||
    arg === "--vm-id" ||
    arg === "-u" ||
    arg === "--user" ||
    arg === "--cd" ||
    arg === "--shell-type"
  );
}

function stripEnvironmentAssignments(segment: string): string {
  let normalized = segment;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(normalized)) {
    const next = normalized.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s*/, "").trim();
    if (next === normalized) break;
    normalized = next;
  }
  return normalized;
}

function isPythonTestSegment(segment: string): boolean {
  return (
    /^(?:(?:[\w./:-]*coverage)\s+run\s+(?:-m\s+)?)?(?:[\w./:-]*python[\w./:-]*\s+-m\s+)?(?:pytest|py\.test|nose2?)(?:\s|$)/.test(segment)
    || /^[\w./:-]*python[\w./:-]*\s+-m\s+unittest(?:\s|$)/.test(segment)
    || /^[\w./:-]*python[\w./:-]*\s+-m\s+django\s+test(?:\s|$)/.test(segment)
    || /^(?:[\w./:-]*django-admin)\s+test(?:\s|$)/.test(segment)
    || /^[\w./:-]*python[\w./:-]*\s+(?:[\w./:-]*\/)?runtests\.py(?:\s|$)/.test(segment)
    || /^[\w./:-]*python[\w./:-]*\s+(?:[\w./:-]*\/)?manage\.py\s+test(?:\s|$)/.test(segment)
    || /^(?:tox|nox)(?:\s|$)/.test(segment)
    || /^[\w./:-]*setup\.py\s+test(?:\s|$)/.test(segment)
  );
}

function isJavaScriptTestSegment(segment: string): boolean {
  return (
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)?(?:\s|$)/.test(segment)
    || /^(?:npx\s+)?(?:jest|vitest|mocha|ava)(?:\s|$)/.test(segment)
  );
}

function isGoTestSegment(segment: string): boolean {
  return /^go\s+test(?:\s|$)/.test(segment);
}

function isRustTestSegment(segment: string): boolean {
  return /^(?:cargo\s+(?:[\w-]+\s+)*test|cargo\s+nextest\s+run)(?:\s|$)/.test(segment);
}

function isJavaTestSegment(segment: string): boolean {
  return (
    /^mvn(?:\s+-[\w.=-]+)*\s+(?:test|verify)(?:\s|$)/.test(segment)
    || /^(?:gradle|\.\/gradlew)(?:\s+[-\w.=:]+)*\s+test(?:\s|$)/.test(segment)
  );
}

export function classifyPythonTestFailure(
  result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
  invocation?: PythonTestFailureInvocationContext
): PythonTestFailureClassification | undefined {
  if (result.exitCode === 0) return undefined;
  const output = `${result.stdout}\n${result.stderr}`;
  const missingEntrypoint = output.match(/can't open file ['"]([^'"]+)['"]:\s+\[Errno 2\]\s+No such file or directory/i);
  if (missingEntrypoint?.[1]) {
    const missingPath = missingEntrypoint[1];
    return {
      feedback: [
        `PYTHON_TEST_ENTRYPOINT_MISSING: Python could not open test runner file '${missingPath}'.`,
        "Find the repo-local test runner before retrying; do not repeat the same command from the wrong directory.",
        "Next action: inspect the checkout root for the correct test entrypoint, then rerun the focused test command from that directory."
      ].join("\n"),
      metadata: {
        kind: "python-test-entrypoint-missing",
        missingPath,
        suggestedAction: "locate-python-test-entrypoint"
      }
    };
  }
  const unsupportedArgument = output.match(/unrecognized arguments?:\s+([^\r\n]+)/i);
  const unsupportedOption = unsupportedArgument?.[1]?.trim().split(/\s+/)[0];
  if (unsupportedOption) {
    const suggestedOption = suggestedPythonTestOption(unsupportedOption, output);
    return {
      feedback: [
        `PYTHON_TEST_ARGUMENT_UNSUPPORTED: Python test runner rejected option '${unsupportedOption}'.`,
        suggestedOption ? `Use '${suggestedOption}' instead of '${unsupportedOption}' before retrying.` : "Inspect the runner usage text and retry with a supported option spelling.",
        "Do not spend another iteration repeating the same unsupported test command."
      ].join("\n"),
      metadata: {
        kind: "python-test-argument-unsupported",
        unsupportedOption,
        ...(suggestedOption ? { suggestedOption } : {}),
        suggestedAction: "rewrite-python-test-arguments"
      }
    };
  }
  if (isNumpyLegacyApiFailure(output)) {
    const installCommand = "python -m pip install 'numpy<2'";
    return {
      feedback: [
        "PYTHON_TEST_DEPENDENCY_INCOMPATIBLE: Python test environment uses numpy>=2 but this checkout expects the legacy numpy.product API.",
        "Do not keep retrying pytest until the checkout-local dependency set is repaired.",
        `Next action: install a compatible dependency in the checkout-local virtualenv, for example: ${installCommand}`,
        "After the dependency repair, rerun the same focused test once."
      ].join("\n"),
      metadata: {
        kind: "python-dependency-incompatible",
        dependencyName: "numpy",
        incompatibleApi: "numpy.product",
        suggestedAction: "install-compatible-python-test-dependency",
        suggestedCommand: installCommand
      }
    };
  }
  const missingModule = output.match(/ModuleNotFoundError:\s+No module named ['"]([^'"]+)['"]/) ??
    output.match(/(?:^|\n)[^\n]*python(?:\d+(?:\.\d+)?)?(?:\.exe)?:\s+No module named\s+([A-Za-z0-9_.-]+)/);
  const moduleName = missingModule?.[1]?.trim();
  if (!moduleName) return undefined;
  if (isPythonTestCommandEnvMisscopedModule(moduleName, invocation)) {
    return {
      feedback: [
        `PYTHON_TEST_COMMAND_ENV_MISSCOPED: Python test command could not import local test module/settings '${moduleName}'.`,
        "Use the repo-local test runner, cwd, module path, or settings module before retrying.",
        "Do not install the missing name as a package unless separate dependency evidence proves it is external."
      ].join("\n"),
      metadata: {
        kind: "python-test-command-env-misscoped",
        moduleName,
        suggestedAction: "repair-python-test-command-environment-scope"
      }
    };
  }
  const installCommand = `python -m pip install ${moduleName}`;
  return {
    feedback: [
      `PYTHON_TEST_DEPENDENCY_MISSING: Python test environment is missing module '${moduleName}'.`,
      "Do not repeat the same pytest command until the checkout environment is repaired.",
      `Next action: install or prepare the missing test dependency in the checkout-local virtualenv, for example: ${installCommand}`,
      "After the install/preparation step, rerun the same focused test once."
    ].join("\n"),
    metadata: {
      kind: "python-missing-module",
      moduleName,
      suggestedAction: "install-python-test-dependency",
      suggestedCommand: installCommand
    }
  };
}

function isPythonTestCommandEnvMisscopedModule(moduleName: string, invocation: PythonTestFailureInvocationContext | undefined): boolean {
  if (!invocation) return false;
  const commandText = commandTextForFailureContext(invocation).replace(/\\/g, "/");
  if (!commandText.trim()) return false;
  const escapedModule = escapeRegExp(moduleName);
  const dottedModule = moduleName.replace(/-/g, "_");
  const escapedDotted = escapeRegExp(dottedModule);
  return (
    new RegExp(`(?:^|\\s)--settings(?:=|\\s+)(?:[A-Za-z0-9_]+\\.)*${escapedModule}(?:\\s|$)`).test(commandText) ||
    new RegExp(`(?:^|\\s)DJANGO_SETTINGS_MODULE=(?:[A-Za-z0-9_]+\\.)*${escapedModule}(?:\\s|$)`).test(commandText) ||
    new RegExp(`(?:^|\\s)tests\\.${escapedDotted}(?:\\.|\\s|$)`).test(commandText)
  );
}

async function repoLocalPythonTestRunner(
  deps: Pick<CoreCodingToolsDependencies, "platform">,
  cwd: string
): Promise<string | undefined> {
  for (const candidate of ["tests/runtests.py", "runtests.py"]) {
    try {
      await deps.platform.readFile(joinPath(cwd, candidate));
      return candidate;
    } catch {
      // Missing or unreadable runners are not failures for test-output classification.
    }
  }
  return undefined;
}

function joinPath(root: string, relative: string): string {
  return `${root.replace(/[\\\/]+$/, "")}/${relative.replace(/^[\\\/]+/, "")}`;
}

function commandTextForFailureContext(invocation: PythonTestFailureInvocationContext): string {
  return [invocation.command, ...(invocation.args ?? [])].join(" ");
}

export function withModelFacingTestFailure<T extends { readonly stdout: string; readonly stderr: string }>(result: T, feedback: string): T {
  const originalOutput = [result.stdout, result.stderr].filter((value) => value.trim().length > 0).join("\n");
  return {
    ...result,
    stdout: "",
    stderr: `${feedback}\n\nOriginal test output:\n${originalOutput}`
  };
}

function normalizeShellCommand(profile: ShellProfile, command: string): string {
  if (profile === "bash" && !command.trimStart().startsWith("set -o pipefail;")) {
    return `set -o pipefail; ${command}`;
  }
  return command;
}

function shouldUseShellSyntax(command: string, args: readonly string[], shellProfile: ShellProfile | undefined): boolean {
  if (shellProfile) return true;
  if (hasShellSyntax(command)) return true;
  if (args.length > 0) return false;
  return false;
}

function normalizeShellSyntaxArgs(command: string, args: readonly string[]): readonly string[] {
  if (args[0] !== "-c") return args;
  const commandWords = command.trim().split(/\s+/).filter(Boolean);
  if (commandWords[commandWords.length - 1] !== "-c") return args;
  const executable = commandWords[0]?.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (!/^(?:python|python3|python3\.\d+|bash|sh|zsh|node|perl|ruby)$/.test(executable)) return args;
  return args.slice(1);
}

function hasShellSyntax(command: string): boolean {
  return /\s/.test(command.trim()) || /[;&|<>`$(){}[\]*?~]/.test(command);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sweLiteCheckoutRootFromPath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  const match = /(?:^|\/)\.deepseek\/swe-lite-runs\/[^/]+\/repo(?:\/|$)/.exec(normalized);
  if (!match) return undefined;
  return normalized.slice(0, match.index + match[0].length).replace(/\/$/, "");
}

function sweLiteCheckoutVirtualEnvExecutable(command: string, checkoutRoot: string): { readonly kind: "pip" | "python"; readonly name: string } | undefined {
  const normalized = command.replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  if (/^(?:pip|pip3|pip3\.\d+)$/.test(name)) return { kind: "pip", name };
  if (/^(?:python|python3|python3\.\d+)$/.test(name)) return { kind: "python", name };
  return undefined;
}

function bindPathAfterShellPrelude(command: string, venvBin: string, checkoutRoot: string): string {
  const pathBinding = `PATH=${shellQuote(venvBin)}:$PATH; export PATH;`;
  const pipefailPrelude = "set -o pipefail;";
  const rewrittenCommand = rewritePipInstallCommands(rewriteSweLiteCheckoutAliases(command, checkoutRoot));
  if (command.startsWith(pipefailPrelude)) {
    return `${pipefailPrelude} ${pathBinding} ${rewritePipInstallCommands(rewriteSweLiteCheckoutAliases(command.slice(pipefailPrelude.length).trimStart(), checkoutRoot))}`;
  }
  return `${pathBinding} ${rewrittenCommand}`;
}

function rewriteSweLiteCheckoutAliases(command: string, checkoutRoot: string): string {
  return command.replace(/\/home\/user(?=\/|\s|$|[;&|])/g, shellQuote(checkoutRoot));
}

function rewritePipInstallCommands(command: string): string {
  return command.replace(
    /(^|[;&|]\s*|\s)((?:[A-Za-z0-9_./-]*\/)?pip(?:3(?:\.\d+)?)?)\s+install(?=\s|$)/g,
    (match: string, prefix: string, pipCommand: string, offset: number, fullCommand: string) => {
      const beforeCommand = fullCommand.slice(0, offset + prefix.length);
      if (/\bpython(?:3(?:\.\d+)?)?\s+-m\s+$/.test(beforeCommand)) return match;
      const pythonCommand = pipCommand.includes("/") ? pipCommand.replace(/pip(?:3(?:\.\d+)?)?$/, "python") : "python";
      return `${prefix}${pythonCommand} -m pip install`;
    }
  );
}

function isSweLiteCheckoutSlowCommand(command: string, args: readonly string[]): boolean {
  const shellText = [command, ...args].join(" ").toLowerCase();
  return (
    isPipInstallCommand(shellText) ||
    /(?:^|[;&|]\s*|\s)python(?:3(?:\.\d+)?)?\s+setup\.py\s+(?:build|build_ext|develop|install)(?:\s|$)/.test(shellText) ||
    /(?:^|[;&|]\s*|\s)(?:tox|nox|pytest|nose2?|python(?:3(?:\.\d+)?)?\s+-m\s+(?:pytest|nose2?))(?:\s|$)/.test(shellText)
  );
}

function isPipInstallCommand(shellText: string): boolean {
  return (
    /(?:^|[;&|]\s*|\s)(?:[a-z0-9_./-]*\/)?pip(?:3(?:\.\d+)?)?\s+install(?:\s|$)/.test(shellText) ||
    /(?:^|[;&|]\s*|\s)python(?:3(?:\.\d+)?)?\s+-m\s+pip\s+install(?:\s|$)/.test(shellText)
  );
}

function suggestedPythonTestOption(unsupportedOption: string, output: string): string | undefined {
  if (unsupportedOption === "--no-input" && output.includes("--noinput")) return "--noinput";
  return undefined;
}

function isNumpyLegacyApiFailure(output: string): boolean {
  return /AttributeError:\s+module ['"]numpy['"] has no attribute ['"]product['"]/i.test(output) ||
    /module ['"]numpy['"] has no attribute ['"]product['"]/i.test(output);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
