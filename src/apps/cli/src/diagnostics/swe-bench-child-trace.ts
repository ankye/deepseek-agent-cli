import type { JsonObject } from "@deepseek/platform-contracts";
import { isStandardTestCommand } from "@deepseek/core-coding-tools";
import { evaluateAgenticEvaluationBlockers } from "./agentic-evaluation-blockers.js";
import type { AgenticEvaluationBlockerFinding, AgenticEvaluationBlockerPhase, AgenticEvaluationBlockerSeverity } from "./agentic-evaluation-blockers.js";

export interface SweBenchChildTraceBlockerFinding extends JsonObject {
  readonly blockerId: string;
  readonly phase: AgenticEvaluationBlockerPhase;
  readonly severity: AgenticEvaluationBlockerSeverity;
  readonly evidence: string;
}

export interface SweBenchChildTraceTestFailureDetail extends JsonObject {
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly kind: string;
  readonly moduleName?: string;
  readonly dependencyName?: string;
  readonly missingPath?: string;
  readonly unsupportedOption?: string;
  readonly suggestedOption?: string;
  readonly suggestedAction?: string;
  readonly suggestedCommand?: string;
  readonly alternateCommand?: string;
  readonly alternateRunnerPath?: string;
}

export interface SweBenchChildTraceSummary extends JsonObject {
  readonly tracePath?: string;
  readonly lineCount: number;
  readonly invalidLineCount: number;
  readonly diagnosticCodes: readonly string[];
  readonly terminalKind?: string;
  readonly terminalStatus?: string;
  readonly terminalReason?: string;
  readonly iterationCount: number;
  readonly modelRequestCount: number;
  readonly usageEventCount: number;
  readonly toolIntentCount: number;
  readonly sourceInspectionToolCount: number;
  readonly sourceMutationCount: number;
  readonly shellCommandCount: number;
  readonly testCommandCount: number;
  readonly successfulTestCommandCount: number;
  readonly testFailureDetails?: readonly SweBenchChildTraceTestFailureDetail[];
  readonly blockerFindings: readonly SweBenchChildTraceBlockerFinding[];
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export function summarizeSweBenchChildTrace(stdout: string, traceOutputPath: string | undefined): SweBenchChildTraceSummary {
  let lineCount = 0;
  let invalidLineCount = 0;
  let terminalKind = "";
  let terminalStatus = "";
  let terminalReason = "";
  let terminalLockedByManagedBudget = false;
  let iterationCount = 0;
  let modelRequestCount = 0;
  let usageEventCount = 0;
  let toolIntentCount = 0;
  let sourceInspectionToolCount = 0;
  let sourceMutationCount = 0;
  let shellCommandCount = 0;
  let testCommandCount = 0;
  let successfulTestCommandCount = 0;
  let testSuccessEvidenceKnown = false;
  const gateCodes = new Set<string>();
  const outputCodes = new Set<string>();
  const countedSourceMutationToolCallIds = new Set<string>();
  const testToolCallIds = new Set<string>();
  const testFailureDetails = new Map<string, SweBenchChildTraceTestFailureDetail>();
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    lineCount += 1;
    let parsed: JsonObject;
    try {
      parsed = JSON.parse(line) as JsonObject;
    } catch {
      invalidLineCount += 1;
      continue;
    }
    const event = isJsonObject(parsed.event) ? parsed.event : parsed;
    const kind = stringField(event, "kind");
    const data = isJsonObject(event.data) ? event.data : {};
    const iteration = numberField(data, "iteration") ?? numberField(data, "iterations");
    if (iteration !== undefined) iterationCount = Math.max(iterationCount, iteration);
    if (kind === "model.requested") modelRequestCount += 1;
    if (kind === "agent.loop.budget.consumed") {
      const gate = stringField(data, "gate");
      const readyForHarnessGate = gate === "SWE_BENCH_READY_FOR_HARNESS_GATE";
      const locksTerminal = isTerminalManagedBudgetGate(gate);
      if (!terminalLockedByManagedBudget || locksTerminal) {
        terminalKind = kind;
        terminalStatus = readyForHarnessGate ? "completed" : "rejected";
        terminalReason = stringField(isJsonObject(data.budget) ? data.budget : {}, "stopReason");
        terminalLockedByManagedBudget = locksTerminal;
      }
      if (gate) gateCodes.add(gate);
      const budgetModelRequests = numberField(data, "modelRequestCount");
      const budgetToolCalls = numberField(data, "toolCallCount");
      const budgetSourceInspection = numberField(data, "sourceInspectionToolCount");
      const budgetSourceMutation = numberField(data, "sourceMutationCount");
      const budgetShellCommands = numberField(data, "shellCommandCount");
      const budgetTestCommands = numberField(data, "testCommandCount");
      const budgetSuccessfulTestCommands = numberField(data, "successfulTestCommandCount");
      if (budgetModelRequests !== undefined) modelRequestCount = Math.max(modelRequestCount, budgetModelRequests);
      if (budgetToolCalls !== undefined) toolIntentCount = Math.max(toolIntentCount, budgetToolCalls);
      if (budgetSourceInspection !== undefined) sourceInspectionToolCount = Math.max(sourceInspectionToolCount, budgetSourceInspection);
      if (budgetSourceMutation !== undefined) sourceMutationCount = Math.max(sourceMutationCount, budgetSourceMutation);
      if (budgetShellCommands !== undefined) shellCommandCount = Math.max(shellCommandCount, budgetShellCommands);
      if (budgetTestCommands !== undefined) testCommandCount = Math.max(testCommandCount, budgetTestCommands);
      if (budgetSuccessfulTestCommands !== undefined) {
        testSuccessEvidenceKnown = true;
        successfulTestCommandCount = Math.max(successfulTestCommandCount, budgetSuccessfulTestCommands);
      }
    }
    if (kind === "usage.updated") usageEventCount += 1;
    if (kind === "model.tool.intent") {
      toolIntentCount += 1;
      const toolCallId = stringField(data, "toolCallId");
      const toolName = toolNameFromToolIntent(data);
      if (isSourceInspectionTool(toolName)) sourceInspectionToolCount += 1;
      const shellCommand = shellCommandFromToolIntent(data, toolName);
      if (shellCommand) {
        shellCommandCount += 1;
        if (isStandardTestCommand(shellCommand.command, shellCommand.args)) {
          testCommandCount += 1;
          if (toolCallId) testToolCallIds.add(toolCallId);
        }
      } else if (isTestRunTool(toolName) && commandFromToolIntent(data)) {
        testCommandCount += 1;
        if (toolCallId) testToolCallIds.add(toolCallId);
      }
    }
    if (kind === "model.tool.result") {
      const toolName = toolNameFromToolResult(data);
      const toolCallId = stringField(data, "toolCallId");
      recordTestFailureDetail(testFailureDetails, testFailureDetailFromToolResult(data, toolCallId, toolName));
      if (isSourceMutationTool(toolName) && stringField(data, "terminalKind") === "capability.completed") {
        const sourceMutationToolCallId = toolCallId || `source-mutation-result:${lineCount}`;
        if (!countedSourceMutationToolCallIds.has(sourceMutationToolCallId)) {
          countedSourceMutationToolCallIds.add(sourceMutationToolCallId);
          sourceMutationCount += 1;
        }
      }
      const isKnownTestResult = isTestRunTool(toolName) || (toolCallId.length > 0 && testToolCallIds.has(toolCallId));
      if (isKnownTestResult) {
        const succeeded = testToolResultSucceeded(data);
        if (succeeded !== undefined) {
          testSuccessEvidenceKnown = true;
          if (succeeded) {
            successfulTestCommandCount += 1;
            clearStalePythonSetupCodes(outputCodes);
          }
        }
        for (const code of diagnosticCodesFromToolResultOutput(data)) outputCodes.add(code);
      }
    }
    if (kind === "capability.completed") {
      recordTestFailureDetail(testFailureDetails, testFailureDetailFromCapabilityCompleted(data));
    }
    if ((kind === "agent.loop.completed" || kind === "agent.loop.failed" || kind === "agent.loop.cancelled") && !terminalLockedByManagedBudget) {
      terminalKind = kind;
      terminalStatus = stringField(data, "status");
      terminalReason = stringField(data, "reason");
    }
  }
  const diagnosticCodes = childTraceDiagnosticCodes({
    invalidLineCount,
    terminalKind,
    gateCodes: [...gateCodes],
    outputCodes: [...outputCodes],
    modelRequestCount,
    sourceMutationCount,
    shellCommandCount,
    testCommandCount,
    successfulTestCommandCount,
    testSuccessEvidenceKnown
  });
  return {
    ...(traceOutputPath ? { tracePath: traceOutputPath } : {}),
    lineCount,
    invalidLineCount,
    diagnosticCodes,
    ...(terminalKind ? { terminalKind } : {}),
    ...(terminalStatus ? { terminalStatus } : {}),
    ...(terminalReason ? { terminalReason } : {}),
    iterationCount,
    modelRequestCount,
    usageEventCount,
    toolIntentCount,
    sourceInspectionToolCount,
    sourceMutationCount,
    shellCommandCount,
    testCommandCount,
    successfulTestCommandCount,
    ...(testFailureDetails.size > 0 ? { testFailureDetails: [...testFailureDetails.values()] } : {}),
    blockerFindings: childTraceBlockerFindings(evaluateAgenticEvaluationBlockers({
      diagnosticCodes,
      terminalReason,
      modelRequestCount,
      sourceInspectionToolCount,
      sourceMutationCount,
      shellCommandCount,
      testCommandCount,
      successfulTestCommandCount
    })),
    redaction: { class: "internal", fields: ["tracePath"] }
  };
}

function recordTestFailureDetail(details: Map<string, SweBenchChildTraceTestFailureDetail>, detail: SweBenchChildTraceTestFailureDetail | undefined): void {
  if (!detail) return;
  const normalized = normalizeTestFailureDetail(detail);
  const key = [
    normalized.toolName ?? "",
    normalized.kind,
    normalized.moduleName ?? "",
    normalized.dependencyName ?? "",
    normalized.missingPath ?? "",
    normalized.unsupportedOption ?? "",
    normalized.suggestedAction ?? "",
    normalized.suggestedCommand ?? "",
    normalized.alternateCommand ?? "",
    normalized.alternateRunnerPath ?? ""
  ].join("\0");
  const existing = details.get(key);
  if (!existing || (!existing.toolCallId && normalized.toolCallId)) details.set(key, normalized);
}

function normalizeTestFailureDetail(detail: SweBenchChildTraceTestFailureDetail): SweBenchChildTraceTestFailureDetail {
  if (
    detail.kind === "python-missing-module" &&
    isPythonTestLauncherModule(detail.moduleName ?? "") &&
    detail.alternateCommand &&
    detail.alternateRunnerPath
  ) {
    return {
      ...detail,
      suggestedAction: "use-repo-local-python-test-runner",
      suggestedCommand: detail.alternateCommand
    };
  }
  return detail;
}

function isPythonTestLauncherModule(moduleName: string): boolean {
  return /^(?:pytest|nose|nose2)$/.test(moduleName);
}

function testFailureDetailFromToolResult(data: JsonObject, toolCallId: string, toolName: string): SweBenchChildTraceTestFailureDetail | undefined {
  const evidence = isJsonObject(data.evidence) ? data.evidence : undefined;
  const metadata = evidence && isJsonObject(evidence.metadata) ? evidence.metadata : undefined;
  return testFailureDetailFromMetadata(metadata, { toolCallId, toolName }) ??
    testFailureDetailFromOutput(toolResultOutputText(data), { toolCallId, toolName });
}

function testFailureDetailFromCapabilityCompleted(data: JsonObject): SweBenchChildTraceTestFailureDetail | undefined {
  const output = isJsonObject(data.output) ? data.output : undefined;
  const evidence = output && isJsonObject(output.evidence) ? output.evidence : undefined;
  const metadata = evidence && isJsonObject(evidence.metadata) ? evidence.metadata : undefined;
  return testFailureDetailFromMetadata(metadata, { toolName: stringField(data, "capabilityId") });
}

function testFailureDetailFromMetadata(metadata: JsonObject | undefined, context: { readonly toolCallId?: string; readonly toolName?: string }): SweBenchChildTraceTestFailureDetail | undefined {
  const testFailure = metadata && isJsonObject(metadata.testFailure) ? metadata.testFailure : undefined;
  const kind = testFailure ? stringField(testFailure, "kind") : "";
  if (!testFailure || !kind) return undefined;
  return {
    ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
    ...(context.toolName ? { toolName: context.toolName } : {}),
    kind,
    ...copyStringField(testFailure, "moduleName"),
    ...copyStringField(testFailure, "dependencyName"),
    ...copyStringField(testFailure, "missingPath"),
    ...copyStringField(testFailure, "unsupportedOption"),
    ...copyStringField(testFailure, "suggestedOption"),
    ...copyStringField(testFailure, "suggestedAction"),
    ...copyStringField(testFailure, "suggestedCommand"),
    ...copyStringField(testFailure, "alternateCommand"),
    ...copyStringField(testFailure, "alternateRunnerPath")
  };
}

function testFailureDetailFromOutput(output: string, context: { readonly toolCallId?: string; readonly toolName?: string }): SweBenchChildTraceTestFailureDetail | undefined {
  if (!output.trim()) return undefined;
  const missingModule =
    output.match(/PYTHON_TEST_DEPENDENCY_MISSING:\s+Python test environment is missing module ['"]([^'"]+)['"]/i) ??
    output.match(/(?:^|\n)[^\n]*python(?:\d+(?:\.\d+)?)?(?:\.exe)?:\s+No module named\s+([A-Za-z0-9_.-]+)/i);
  if (missingModule?.[1]) {
    const moduleName = missingModule[1].trim();
    return {
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
      ...(context.toolName ? { toolName: context.toolName } : {}),
      kind: "python-missing-module",
      moduleName,
      suggestedAction: "install-python-test-dependency",
      suggestedCommand: `python -m pip install ${moduleName}`
    };
  }
  const missingPath = output.match(/PYTHON_TEST_ENTRYPOINT_MISSING:\s+Python could not open test runner file ['"]([^'"]+)['"]/i);
  if (missingPath?.[1]) {
    return {
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
      ...(context.toolName ? { toolName: context.toolName } : {}),
      kind: "python-test-entrypoint-missing",
      missingPath: missingPath[1].trim(),
      suggestedAction: "locate-python-test-entrypoint"
    };
  }
  const unsupportedOption = output.match(/PYTHON_TEST_ARGUMENT_UNSUPPORTED:\s+Python test runner rejected option ['"]([^'"]+)['"]/i);
  if (unsupportedOption?.[1]) {
    const suggested = output.match(/Use ['"]([^'"]+)['"] instead of ['"][^'"]+['"]/i)?.[1]?.trim();
    return {
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
      ...(context.toolName ? { toolName: context.toolName } : {}),
      kind: "python-test-argument-unsupported",
      unsupportedOption: unsupportedOption[1].trim(),
      ...(suggested ? { suggestedOption: suggested } : {}),
      suggestedAction: "rewrite-python-test-arguments"
    };
  }
  const misscopedModule = output.match(/PYTHON_TEST_COMMAND_ENV_MISSCOPED:\s+Python test command could not import local test module\/settings ['"]([^'"]+)['"]/i);
  if (misscopedModule?.[1]) {
    return {
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
      ...(context.toolName ? { toolName: context.toolName } : {}),
      kind: "python-test-command-env-misscoped",
      moduleName: misscopedModule[1].trim(),
      suggestedAction: "repair-python-test-command-environment-scope"
    };
  }
  if (/PYTHON_TEST_DEPENDENCY_INCOMPATIBLE/i.test(output) || /module ['"]numpy['"] has no attribute ['"]product['"]/i.test(output)) {
    return {
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
      ...(context.toolName ? { toolName: context.toolName } : {}),
      kind: "python-dependency-incompatible",
      dependencyName: "numpy",
      suggestedAction: "install-compatible-python-test-dependency",
      suggestedCommand: "python -m pip install 'numpy<2'"
    };
  }
  return undefined;
}

function copyStringField(value: JsonObject, key: keyof SweBenchChildTraceTestFailureDetail): JsonObject {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? { [key]: field } : {};
}

function toolResultOutputText(data: JsonObject): string {
  return [
    stringField(data, "result"),
    stringField(data, "stdout"),
    stringField(data, "stderr"),
    previewText(data.feedback),
    previewText(data.evidence)
  ].join("\n");
}

function childTraceBlockerFindings(findings: readonly AgenticEvaluationBlockerFinding[]): readonly SweBenchChildTraceBlockerFinding[] {
  return findings.map((finding) => ({
    blockerId: finding.blocker.id,
    phase: finding.blocker.phase,
    severity: finding.blocker.severity,
    evidence: finding.evidence
  }));
}

function toolNameFromToolIntent(data: JsonObject): string {
  return stringField(data, "name") || stringField(data, "toolName") || stringField(data, "capabilityId");
}

function toolNameFromToolResult(data: JsonObject): string {
  return stringField(data, "toolName") || stringField(data, "name") || stringField(data, "capabilityId");
}

function shellCommandFromToolIntent(data: JsonObject, toolName: string): { readonly command: string; readonly args: readonly string[] } | undefined {
  if (toolName !== "core.shell.run" && toolName !== "shell.run") return undefined;
  return commandFromToolIntent(data);
}

function commandFromToolIntent(data: JsonObject): { readonly command: string; readonly args: readonly string[] } | undefined {
  const input = isJsonObject(data.input) ? data.input : {};
  const command = stringField(input, "command");
  if (!command) return undefined;
  const args = Array.isArray(input.args) ? input.args.filter((item): item is string => typeof item === "string") : [];
  return { command, args };
}

function isTestRunTool(toolName: string): boolean {
  return toolName === "core.test.run" || toolName === "test.run";
}

function isSourceInspectionTool(toolName: string): boolean {
  return toolName === "core.file.read" || toolName === "core.file.list" || toolName === "core.search.text" || toolName === "core.workspace.glob";
}

function isSourceMutationTool(toolName: string): boolean {
  return toolName === "core.file.edit" || toolName === "core.file.write" || toolName === "core.patch.apply";
}

function isTerminalManagedBudgetGate(gate: string): boolean {
  return gate === "SWE_BENCH_REQUEST_BUDGET_GATE" ||
    gate === "SWE_BENCH_RUN_CAPABILITY_ROUTING_REQUEST_BUDGET_GATE" ||
    gate === "SWE_BENCH_SOURCE_INSPECTION_DEFIANCE_GATE" ||
    gate === "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE";
}

function childTraceDiagnosticCodes(input: {
  readonly invalidLineCount: number;
  readonly terminalKind: string;
  readonly gateCodes: readonly string[];
  readonly outputCodes: readonly string[];
  readonly modelRequestCount: number;
  readonly sourceMutationCount: number;
  readonly shellCommandCount: number;
  readonly testCommandCount: number;
  readonly successfulTestCommandCount: number;
  readonly testSuccessEvidenceKnown: boolean;
}): readonly string[] {
  const codes: string[] = [];
  if (input.invalidLineCount > 0) codes.push("SWE_BENCH_CHILD_TRACE_INVALID_JSONL");
  if (input.terminalKind === "agent.loop.failed") codes.push("SWE_BENCH_CHILD_TRACE_TERMINAL_FAILED");
  if (
    input.modelRequestCount >= 12 &&
    input.sourceMutationCount > 0 &&
    input.successfulTestCommandCount > 0 &&
    input.terminalKind !== "agent.loop.completed" &&
    !input.gateCodes.includes("SWE_BENCH_READY_FOR_HARNESS_GATE")
  ) {
    codes.push("SWE_BENCH_READY_FOR_HARNESS_GATE_MISSING");
  }
  if (input.shellCommandCount > 0 && input.testCommandCount === 0) codes.push("SWE_BENCH_CHILD_TRACE_VERIFICATION_MISSING");
  if (input.testSuccessEvidenceKnown && input.testCommandCount > 0 && input.successfulTestCommandCount === 0) codes.push("SWE_BENCH_CHILD_TRACE_TEST_UNSUCCESSFUL");
  for (const gateCode of input.gateCodes) {
    if (gateCode === "SWE_BENCH_POST_EDIT_VERIFICATION_GATE" && input.testCommandCount > 0) continue;
    if (
      gateCode === "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE" &&
      input.successfulTestCommandCount > 0 &&
      !input.outputCodes.some(isPythonSetupDiagnosticCode)
    ) continue;
    codes.push(gateCode);
  }
  for (const outputCode of input.outputCodes) codes.push(outputCode);
  return [...new Set(codes)];
}

function clearStalePythonSetupCodes(codes: Set<string>): void {
  for (const code of [...codes]) {
    if (isPythonSetupDiagnosticCode(code)) codes.delete(code);
  }
}

function isPythonSetupDiagnosticCode(code: string): boolean {
  return code === "SWE_BENCH_TEST_ENV_DEPENDENCY_INCOMPATIBLE" ||
    code === "SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING" ||
    code === "SWE_BENCH_TEST_ENTRYPOINT_MISSING" ||
    code === "SWE_BENCH_TEST_ARGUMENT_UNSUPPORTED" ||
    code === "SWE_BENCH_TEST_COMMAND_ENV_MISSCOPED";
}

function testToolResultSucceeded(data: JsonObject): boolean | undefined {
  const evidence = isJsonObject(data.evidence) ? data.evidence : undefined;
  const evidenceStatus = evidence ? stringField(evidence, "status") : "";
  if (evidenceStatus) return evidenceStatus === "success" || evidenceStatus === "completed";
  const metadata = evidence && isJsonObject(evidence.metadata) ? evidence.metadata : undefined;
  const exitCode = metadata ? numberField(metadata, "exitCode") : undefined;
  if (exitCode !== undefined) return exitCode === 0;
  const feedback = isJsonObject(data.feedback) ? data.feedback : undefined;
  const feedbackStatus = feedback ? stringField(feedback, "status") : "";
  if (feedbackStatus) return feedbackStatus === "success" || feedbackStatus === "completed";
  return undefined;
}

function diagnosticCodesFromToolResultOutput(data: JsonObject): readonly string[] {
  const output = [
    stringField(data, "result"),
    stringField(data, "stdout"),
    stringField(data, "stderr"),
    previewText(data.feedback),
    previewText(data.evidence)
  ].join("\n").toLowerCase();
  if (!output) return [];
  if (
    output.includes("internalerror")
    && output.includes("attributeerror")
    && output.includes("module 'numpy' has no attribute 'product'")
  ) {
    return ["SWE_BENCH_TEST_ENV_DEPENDENCY_INCOMPATIBLE"];
  }
  if (output.includes("python_test_command_env_misscoped")) {
    return ["SWE_BENCH_TEST_COMMAND_ENV_MISSCOPED"];
  }
  if (output.includes("python_test_dependency_missing") || /(?:^|\n)[^\n]*python(?:\d+(?:\.\d+)?)?(?:\.exe)?:\s+no module named\s+[a-z0-9_.-]+/.test(output)) {
    return ["SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING"];
  }
  if (output.includes("python_test_entrypoint_missing")) {
    return ["SWE_BENCH_TEST_ENTRYPOINT_MISSING"];
  }
  if (output.includes("python_test_argument_unsupported")) {
    return ["SWE_BENCH_TEST_ARGUMENT_UNSUPPORTED"];
  }
  return [];
}

function previewText(value: unknown): string {
  const object = isJsonObject(value) ? value : {};
  const preview = isJsonObject(object.preview) ? object.preview : {};
  return stringField(preview, "text");
}

function stringField(value: JsonObject, key: string): string {
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function numberField(value: JsonObject, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
