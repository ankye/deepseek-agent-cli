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
  bindSweLiteCheckoutVirtualEnv,
  classifyPythonTestFailure,
  currentSweLiteCheckoutRoot,
  defaultSweLiteCheckoutProcessTimeoutMs,
  resolveShellInvocation,
  withRepoLocalPythonRunnerHint,
  withModelFacingTestFailure
} from "../../../shared/process-command.js";

export function defineTestRunTool(deps: CoreCodingToolsDependencies | undefined) {
  return defineToolManifest(
    "test.run",
    coreToolIds.testRun,
    "Test Run",
    "process",
    ["process:test"],
    objectSchema(["command"], { command: { type: "string" }, args: { type: "array" }, cwd: { type: "string" }, workspaceRoot: { type: "string" }, timeoutMs: { type: "number" }, limitBytes: { type: "number" }, intent: { type: "string" }, executionProfile: { type: "string" }, shellProfile: { type: "string" } }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => requireDeps(deps).then((ready) => testRunTool(input, context, ready))
  );
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
  const currentSweLiteCheckout = currentSweLiteCheckoutRoot(cwd, workspaceRoot);
  const resolvedInvocation = currentSweLiteCheckout ? bindSweLiteCheckoutVirtualEnv(invocation.value, currentSweLiteCheckout) : invocation.value;
  const processProvider = await deps.platform.resolveProcessProvider();
  if (!processProvider.available) {
    return failure("test.run", "PROCESS_UNAVAILABLE", processProvider.diagnostics[0]?.message ?? "Process unavailable.", [cwd], { processProvider });
  }
  const result = await deps.platform.runProcess(resolvedInvocation.command, resolvedInvocation.args, {
    cwd,
    timeoutMs: parsed.timeoutMs ?? defaultSweLiteCheckoutProcessTimeoutMs(parsed.command, parsedArgs, currentSweLiteCheckout),
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
    ...(resolvedInvocation.sweLiteVenvBound ? { sweLiteVenvBound: true } : {})
  });
}
