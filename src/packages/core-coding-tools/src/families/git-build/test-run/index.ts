import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult,
  ShellProfile,
  TestRunInput
} from "@deepseek/platform-contracts";
import { defineToolManifest, failure, objectSchema } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";
import type { CoreCodingToolsDependencies } from "../../../shared/workspace.js";
import { processResultToEvidence, requireDeps, resolveToolPath } from "../../../shared/workspace.js";
import {
  bindManagedCheckoutVirtualEnv,
  classifyPythonTestFailure,
  currentManagedCheckoutRoot,
  defaultManagedCheckoutProcessTimeoutMs,
  resolveShellInvocation,
  withRepoLocalPythonRunnerHint,
  withModelFacingTestFailure
} from "../../../shared/process-command.js";

const testRunDescription = [
  "Run a standard repository test command and return bounded verification evidence.",
  "Use this for pytest, python -m pytest, python -m unittest, tox, nox, npm test, go test, cargo test, or a repo-local test runner.",
  "Do not use python -c, inline scripts, print-only reproductions, source inspection commands, or shell discovery commands here.",
  "Use cwd only as a workspace-relative path inside the governed checkout; do not set cwd to /workspace."
].join(" ");

const testRunCommandDescription = [
  "Standard repository test command only.",
  "Supported standard commands include pytest, python -m pytest, python -m unittest, tox, nox, npm test, go test, cargo test, and repo-local test runners.",
  "Examples: pytest astropy/modeling/tests/test_separable.py -q; python -m pytest tests/test_demo.py; python -m unittest; tox -e py; nox -s tests; npm test.",
  "Do not use python -c, inline reproduction scripts, pwd, ls, cat, sed, grep, git diff, or package install commands."
].join(" ");

export function defineTestRunTool(deps: CoreCodingToolsDependencies | undefined) {
  const tool = defineToolManifest(
    "test.run",
    coreToolIds.testRun,
    "Test Run",
    "process",
    ["process:test"],
    objectSchema(["command"], {
      command: {
        type: "string",
        description: testRunCommandDescription,
        pattern: "^(?!\\s*(?:python(?:3(?:\\.\\d+)?)?|py)\\s+-c(?:\\s|$))(?!.*\\b(?:pwd|ls|cat|sed|grep|rg|git\\s+diff)\\b).*(?:\\bpytest\\b|\\bpython(?:3(?:\\.\\d+)?)?\\s+-m\\s+(?:pytest|unittest|django)\\b|\\btox\\b|\\bnox\\b|\\bnpm\\s+(?:test|run\\s+test)\\b|\\byarn\\s+test\\b|\\bpnpm\\s+test\\b|\\bgo\\s+test\\b|\\bcargo\\s+test\\b|\\bruntests\\.py\\b|\\btests?/[^\\s]*\\.py\\b).*$"
      },
      args: {
        type: "array",
        description: "Optional argv fragments for the standard test command; do not use this to pass inline python -c scripts.",
        items: { type: "string" }
      },
      cwd: {
        type: "string",
        description: "Optional workspace-relative test working directory. Do not set cwd to /workspace; omit cwd for the repository root."
      },
      workspaceRoot: { type: "string" },
      timeoutMs: { type: "number" },
      limitBytes: { type: "number" },
      intent: {
        type: "string",
        description: "Verification intent such as unit, regression, focused-test, or repository-test; not source inspection or reproduction."
      },
      executionProfile: { type: "string" },
      shellProfile: { type: "string" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => testRunTool(input, context, ready))
  );
  return {
    ...tool,
    manifest: {
      ...tool.manifest,
      description: testRunDescription
    }
  };
}

async function testRunTool(input: JsonObject, context: CapabilityExecutionContext, deps: CoreCodingToolsDependencies): Promise<SerializableResult<CoreToolResult>> {
  const parsed = input as TestRunInput;
  const parsedArgs = Array.isArray(parsed.args) ? parsed.args.map(String) : [];
  const workspaceRoot = parsed.workspaceRoot ?? deps.workspaceRoot;
  const cwdPath = resolveToolPath(deps, workspaceRoot, parsed.cwd ?? ".");
  if (!cwdPath.ok || !cwdPath.value) return failure("test.run", "PATH_REJECTED", cwdPath.error?.message ?? "Path rejected.", [String(parsed.cwd ?? ".")]);
  const cwd = cwdPath.value.path;
  const rawProfile = (parsed as unknown as { shellProfile?: unknown }).shellProfile;
  const shellProfile = typeof rawProfile === "string" ? rawProfile as ShellProfile : undefined;
  const invocation = await resolveShellInvocation(deps, parsed.command, parsedArgs, shellProfile);
  if (!invocation.ok) return failure("test.run", invocation.code, invocation.message, [cwd]);
  const currentManagedCheckout = currentManagedCheckoutRoot(cwd, workspaceRoot);
  const resolvedInvocation = currentManagedCheckout ? bindManagedCheckoutVirtualEnv(invocation.value, currentManagedCheckout) : invocation.value;
  const processProvider = await deps.platform.resolveProcessProvider();
  if (!processProvider.available) {
    return failure("test.run", "PROCESS_UNAVAILABLE", processProvider.diagnostics[0]?.message ?? "Process unavailable.", [cwd], { processProvider });
  }
  const result = await deps.platform.runProcess(resolvedInvocation.command, resolvedInvocation.args, {
    cwd,
    timeoutMs: parsed.timeoutMs ?? defaultManagedCheckoutProcessTimeoutMs(parsed.command, parsedArgs, currentManagedCheckout),
    executionProfile: parsed.executionProfile ?? "noninteractive",
    stdin: "ignore",
    outputLimitBytes: parsed.limitBytes ?? 16_000
  });
  const testFailure = await withRepoLocalPythonRunnerHint(
    classifyPythonTestFailure(result, { command: parsed.command, args: parsedArgs }),
    deps,
    cwd
  );
  const evidenceResult = testFailure ? withModelFacingTestFailure(result, testFailure.feedback) : result;
  return processResultToEvidence("test.run", evidenceResult, cwd, context, parsed.limitBytes, {
    intent: parsed.intent ?? "test",
    shellSyntax: resolvedInvocation.shellSyntax,
    ...(testFailure ? { testFailure: testFailure.metadata } : {}),
    ...(resolvedInvocation.shellProfile ? { shellProfile: resolvedInvocation.shellProfile } : {}),
    ...(resolvedInvocation.managedCheckoutVenvBound ? { managedCheckoutVenvBound: true } : {})
  });
}
