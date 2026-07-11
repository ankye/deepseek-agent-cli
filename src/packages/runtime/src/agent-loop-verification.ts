import type {
  AgentLoopOutputContract,
  AgentLoopOutputContractVerification,
  AgentLoopRequest,
  AgentLoopVerificationExpectation,
  AgentModeSessionSummary,
  AgentPhasePlan,
  AgentVerifierResult,
  JsonObject,
  RedactedError,
  RuntimeDependencies,
  RuntimeEvent,
  SessionId,
  TraceContext,
  TurnId
} from "@deepseek/platform-contracts";
import { agentLoopEvent, recordRuntimeAdapterEvent } from "./events.js";
import { evaluateVerifierPolicy } from "./modes/verifier-policy.js";

export interface FinalVerificationInput {
  readonly deps: RuntimeDependencies;
  readonly request: AgentLoopRequest;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly trace: TraceContext;
  readonly phasePlan?: AgentPhasePlan | undefined;
  readonly modeSummary?: AgentModeSessionSummary | undefined;
  readonly assistantText: string;
  readonly toolEvents: readonly RuntimeEvent[];
  readonly diagnostics: RedactedError[];
  readonly iteration: number;
}

export interface FinalVerificationResult {
  readonly modeSummary?: AgentModeSessionSummary;
  readonly terminalStatus: "completed" | "failed";
  readonly events: readonly RuntimeEvent[];
  readonly repairRequested?: boolean;
  readonly verifierResult?: AgentVerifierResult;
  readonly outputContract?: AgentLoopOutputContractVerification;
}

export async function runFinalVerification(input: FinalVerificationInput): Promise<FinalVerificationResult> {
  const events: RuntimeEvent[] = [];
  const outputContract = await verifyOutputContract(input);
  if (outputContract) {
    await appendEvent(events, input, "agent.output-contract.verified", outputContract);
    if (outputContract.status === "fail" && outputContract.contract.required) {
      input.diagnostics.push(...outputContract.diagnostics);
      return {
        ...(input.modeSummary ? { modeSummary: input.modeSummary } : {}),
        terminalStatus: "failed",
        events,
        repairRequested: true,
        outputContract
      };
    }
  }
  if (!input.phasePlan || !input.modeSummary) {
    return {
      ...(input.modeSummary ? { modeSummary: input.modeSummary } : {}),
      terminalStatus: "completed",
      events,
      ...(outputContract ? { outputContract } : {})
    };
  }
  const verifierPolicy = await evaluateVerifierPolicy({
    deps: input.deps,
    request: input.request,
    sessionId: input.sessionId,
    turnId: input.turnId,
    trace: input.trace,
    phasePlan: input.phasePlan,
    modeSummary: input.modeSummary,
    assistantText: input.assistantText,
    toolEvents: input.toolEvents,
    existingDiagnostics: input.diagnostics,
    iteration: input.iteration
  });
  if (!verifierPolicy) return { modeSummary: input.modeSummary, terminalStatus: "completed", events, ...(outputContract ? { outputContract } : {}) };

  input.diagnostics.push(...verifierPolicy.diagnostics);
  const modeSummary = {
    ...input.modeSummary,
    budgets: input.modeSummary.budgets.map((budget) => {
      if (budget.kind === "verification" && verifierPolicy.verificationBudget) return verifierPolicy.verificationBudget;
      if (budget.kind === "repair" && verifierPolicy.repairBudget) return verifierPolicy.repairBudget;
      return budget;
    }),
    verifierResults: [...input.modeSummary.verifierResults, verifierPolicy.verdict]
  };
  await appendEvent(events, input, "agent.verifier.verdict", verifierPolicy.verdict);
  if (verifierPolicy.verificationBudget) await appendEvent(events, input, "agent.loop.budget.consumed", verifierPolicy.verificationBudget);
  if (verifierPolicy.repairBudget?.consumed) await appendEvent(events, input, "agent.loop.budget.consumed", verifierPolicy.repairBudget);
  for (const repair of verifierPolicy.repairEvents) {
    await appendEvent(events, input, "agent.repair.attempted", repair);
    if (repair.status === "attempted") {
      await appendEvent(events, input, "agent.repair.rerun", {
        schemaVersion: "1.0.0",
        sessionId: input.sessionId,
        turnId: input.turnId,
        verifierResultId: verifierPolicy.verdict.verifierResultId,
        status: "deferred",
        reason: "repair-rerun-recorded-for-replay",
        trace: input.trace,
        redaction: { class: "internal" }
      });
    }
  }
  await appendEvent(events, input, "agent.result.reconciled", verifierPolicy.reconciliation);
  const repairRequested = verifierPolicy.verdict.verdict === "fail" && verifierPolicy.repairEvents.some((repair) => repair.status === "attempted");
  return {
    modeSummary,
    terminalStatus: verifierPolicy.terminalStatus,
    events,
    repairRequested,
    verifierResult: verifierPolicy.verdict,
    ...(outputContract ? { outputContract } : {})
  };
}

async function verifyOutputContract(input: FinalVerificationInput): Promise<AgentLoopOutputContractVerification | undefined> {
  const contract = input.request.outputContract ?? inferredFileArtifactOutputContract(input.request.prompt);
  if (!contract) return undefined;
  const base = contract.kind === "json-object"
    ? verifyJsonObjectContract(contract, input.assistantText)
    : contract.kind === "command-plan"
      ? verifyCommandPlanContract(contract, input.assistantText)
      : contract.kind === "json-file"
        ? await verifyJsonFileContract(input, contract)
        : await verifyFileContract(input, contract);
  const expectations = await verifyOutputContractExpectations(input, contract);
  if (expectations.diagnostics.length === 0 && expectations.checkedPaths.length === 0 && expectations.evidenceIds.length === 0) return base;
  return mergeOutputContractResults(contract, base, expectations);
}

interface ExpectationVerificationResult {
  readonly checkedPaths: readonly string[];
  readonly diagnostics: readonly RedactedError[];
  readonly evidenceIds: readonly string[];
  readonly requiredFailure: boolean;
}

function verifyJsonObjectContract(contract: AgentLoopOutputContract, assistantText: string): AgentLoopOutputContractVerification {
  const diagnostics: RedactedError[] = [];
  const parsed = parseStrictJsonObject(assistantText);
  if (parsed instanceof Error) {
    diagnostics.push(contractDiagnostic("OUTPUT_JSON_PARSE_FAILED", parsed.message));
  } else {
    diagnostics.push(...validateJsonSchema(parsed, contract.schema));
  }
  const status = diagnostics.length === 0 ? "pass" : contract.required ? "fail" : "not_applicable";
  return outputContractResult(contract, status, [], diagnostics, ["assistant-response"]);
}

function verifyCommandPlanContract(contract: AgentLoopOutputContract, assistantText: string): AgentLoopOutputContractVerification {
  const diagnostics: RedactedError[] = [];
  const parsed = parseStrictJsonObject(assistantText);
  if (parsed instanceof Error) {
    diagnostics.push(contractDiagnostic("OUTPUT_COMMAND_PLAN_PARSE_FAILED", parsed.message));
  } else {
    if (!Array.isArray(parsed.commands)) {
      diagnostics.push(contractDiagnostic("OUTPUT_COMMAND_PLAN_COMMANDS_MISSING", "Command plan requires a commands array."));
    } else if (!parsed.commands.every((command) => typeof command === "string")) {
      diagnostics.push(contractDiagnostic("OUTPUT_COMMAND_PLAN_COMMANDS_INVALID", "Command plan commands must be strings."));
    }
    if (typeof parsed.done !== "boolean") {
      diagnostics.push(contractDiagnostic("OUTPUT_COMMAND_PLAN_DONE_MISSING", "Command plan requires a done boolean."));
    }
    diagnostics.push(...validateJsonSchema(parsed, contract.schema));
  }
  const status = diagnostics.length === 0 ? "pass" : contract.required ? "fail" : "not_applicable";
  return outputContractResult(contract, status, [], diagnostics, ["assistant-response:command-plan"]);
}

async function verifyJsonFileContract(input: FinalVerificationInput, contract: AgentLoopOutputContract): Promise<AgentLoopOutputContractVerification> {
  const resolved = resolveContractPath(input, contract);
  if (resolved instanceof Error) return outputContractResult(contract, contract.required ? "fail" : "not_applicable", [], [contractDiagnostic("OUTPUT_PATH_REJECTED", resolved.message)], []);
  const exactPath = await verifyCaseExactWorkspacePath(input, contract.path ?? "", resolved);
  if (exactPath.diagnostics.length > 0) {
    return outputContractResult(contract, contract.required ? "fail" : "not_applicable", [resolved], exactPath.diagnostics, []);
  }
  const content = await input.deps.platform.readFile(resolved).catch((error: unknown) => error instanceof Error ? error : new Error("Unable to read output JSON file."));
  if (content instanceof Error) {
    return outputContractResult(contract, contract.required ? "fail" : "not_applicable", [resolved], [contractDiagnostic("OUTPUT_FILE_READ_FAILED", content.message)], []);
  }
  const parsed = parseStrictJsonObject(content);
  const diagnostics = parsed instanceof Error
    ? [contractDiagnostic("OUTPUT_JSON_PARSE_FAILED", parsed.message)]
    : validateJsonSchema(parsed, contract.schema);
  return outputContractResult(contract, diagnostics.length === 0 ? "pass" : "fail", [resolved], diagnostics, [resolved]);
}

async function verifyFileContract(input: FinalVerificationInput, contract: AgentLoopOutputContract): Promise<AgentLoopOutputContractVerification> {
  const resolved = resolveContractPath(input, contract);
  if (resolved instanceof Error) return outputContractResult(contract, contract.required ? "fail" : "not_applicable", [], [contractDiagnostic("OUTPUT_PATH_REJECTED", resolved.message)], []);
  const exactPath = await verifyCaseExactWorkspacePath(input, contract.path ?? "", resolved);
  if (exactPath.diagnostics.length > 0) {
    return outputContractResult(contract, contract.required ? "fail" : "not_applicable", [resolved], exactPath.diagnostics, []);
  }
  const content = await input.deps.platform.readFile(resolved).catch((error: unknown) => error instanceof Error ? error : new Error("Unable to read output file."));
  if (content instanceof Error) {
    return outputContractResult(contract, contract.required ? "fail" : "not_applicable", [resolved], [contractDiagnostic("OUTPUT_FILE_READ_FAILED", content.message)], []);
  }
  return outputContractResult(contract, "pass", [resolved], [], [`file:${resolved}:${content.length}`]);
}

async function verifyOutputContractExpectations(input: FinalVerificationInput, contract: AgentLoopOutputContract): Promise<ExpectationVerificationResult> {
  const expectations = contract.verificationExpectations ?? [];
  if (expectations.length === 0) return { checkedPaths: [], diagnostics: [], evidenceIds: [], requiredFailure: false };
  const checkedPaths: string[] = [];
  const diagnostics: RedactedError[] = [];
  const evidenceIds: string[] = [];
  let requiredFailure = false;
  for (let index = 0; index < expectations.length; index += 1) {
    const expectation = expectations[index];
    if (!expectation) continue;
    const result = await verifySingleExpectation(input, expectation, index);
    checkedPaths.push(...result.checkedPaths);
    diagnostics.push(...result.diagnostics);
    evidenceIds.push(...result.evidenceIds);
    requiredFailure ||= expectation.required && result.diagnostics.length > 0;
  }
  return { checkedPaths, diagnostics, evidenceIds, requiredFailure };
}

async function verifySingleExpectation(input: FinalVerificationInput, expectation: AgentLoopVerificationExpectation, index: number): Promise<ExpectationVerificationResult> {
  if (expectation.kind === "artifact") return verifyArtifactExpectation(input, expectation, index);
  if (expectation.kind === "check-command") return verifyCheckCommandExpectation(input, expectation, index);
  if (expectation.kind === "generated-output") return verifyGeneratedOutputExpectation(input, expectation, index);
  return verifySchemaExpectation(input, expectation, index);
}

async function verifySchemaExpectation(input: FinalVerificationInput, expectation: AgentLoopVerificationExpectation, index: number): Promise<ExpectationVerificationResult> {
  if (!expectation.schema) {
    return expectationResult(expectation, index, [], [contractDiagnostic("OUTPUT_EXPECTATION_SCHEMA_MISSING", "Schema verification expectation requires a schema.")], []);
  }
  const target = await expectationContentTarget(input, expectation);
  if (target instanceof Error) return expectationResult(expectation, index, [], [contractDiagnostic("OUTPUT_EXPECTATION_TARGET_READ_FAILED", target.message)], []);
  const parsed = parseStrictJsonObject(target.content);
  const diagnostics = parsed instanceof Error
    ? [contractDiagnostic("OUTPUT_EXPECTATION_JSON_PARSE_FAILED", parsed.message)]
    : validateJsonSchema(parsed, expectation.schema);
  return expectationResult(expectation, index, target.path ? [target.path] : [], diagnostics, [`expectation:${index}:schema`]);
}

async function verifyArtifactExpectation(input: FinalVerificationInput, expectation: AgentLoopVerificationExpectation, index: number): Promise<ExpectationVerificationResult> {
  if (!expectation.path) {
    return expectationResult(expectation, index, [], [contractDiagnostic("OUTPUT_EXPECTATION_PATH_MISSING", "Artifact verification expectation requires a path.")], []);
  }
  const resolved = resolveExpectationPath(input, expectation.path);
  if (resolved instanceof Error) return expectationResult(expectation, index, [], [contractDiagnostic("OUTPUT_EXPECTATION_PATH_REJECTED", resolved.message)], []);
  const exactPath = await verifyCaseExactWorkspacePath(input, expectation.path, resolved);
  if (exactPath.diagnostics.length > 0) return expectationResult(expectation, index, [resolved], exactPath.diagnostics, []);
  const content = await input.deps.platform.readFile(resolved).catch((error: unknown) => error instanceof Error ? error : new Error("Unable to read expected artifact."));
  if (content instanceof Error) {
    return expectationResult(expectation, index, [resolved], [contractDiagnostic("OUTPUT_EXPECTATION_ARTIFACT_MISSING", content.message)], []);
  }
  return expectationResult(expectation, index, [resolved], [], [`artifact:${resolved}:${content.length}`]);
}

async function verifyGeneratedOutputExpectation(input: FinalVerificationInput, expectation: AgentLoopVerificationExpectation, index: number): Promise<ExpectationVerificationResult> {
  const target = expectation.path ? await expectationContentTarget(input, expectation) : { content: input.assistantText };
  if (target instanceof Error) return expectationResult(expectation, index, [], [contractDiagnostic("OUTPUT_EXPECTATION_TARGET_READ_FAILED", target.message)], []);
  const diagnostics = target.content.trim() ? [] : [contractDiagnostic("OUTPUT_EXPECTATION_OUTPUT_EMPTY", "Generated output expectation requires non-empty output.")];
  return expectationResult(expectation, index, "path" in target && target.path ? [target.path] : [], diagnostics, [`expectation:${index}:generated-output`]);
}

async function verifyCheckCommandExpectation(input: FinalVerificationInput, expectation: AgentLoopVerificationExpectation, index: number): Promise<ExpectationVerificationResult> {
  if (!expectation.command) {
    return expectationResult(expectation, index, [], [contractDiagnostic("OUTPUT_EXPECTATION_COMMAND_MISSING", "Check-command verification expectation requires a command.")], []);
  }
  const parsed = splitCommandLine(expectation.command);
  if (parsed instanceof Error || parsed.length === 0) {
    return expectationResult(expectation, index, [], [contractDiagnostic("OUTPUT_EXPECTATION_COMMAND_INVALID", parsed instanceof Error ? parsed.message : "Check command is empty.")], []);
  }
  const cwd = resolveExpectationPath(input, ".");
  if (cwd instanceof Error) return expectationResult(expectation, index, [], [contractDiagnostic("OUTPUT_EXPECTATION_CWD_REJECTED", cwd.message)], []);
  const [command, ...args] = parsed;
  const result = await input.deps.platform.runProcess(command ?? "", args, {
    cwd,
    timeoutMs: 30_000,
    executionProfile: "noninteractive",
    stdin: "ignore",
    outputLimitBytes: 16_000
  });
  const diagnostics = result.exitCode === 0
    ? []
    : [contractDiagnostic("OUTPUT_EXPECTATION_COMMAND_FAILED", `Check command exited with ${result.exitCode}.`, {
        exitCode: result.exitCode,
        stdoutPreview: result.stdout.slice(-1000),
        stderrPreview: result.stderr.slice(-1000)
      })];
  return expectationResult(expectation, index, [cwd], diagnostics, [`check-command:${index}:${result.exitCode}`]);
}

async function expectationContentTarget(input: FinalVerificationInput, expectation: AgentLoopVerificationExpectation): Promise<{ readonly content: string; readonly path?: string } | Error> {
  if (!expectation.path) return { content: input.assistantText };
  const resolved = resolveExpectationPath(input, expectation.path);
  if (resolved instanceof Error) return resolved;
  const exactPath = await verifyCaseExactWorkspacePath(input, expectation.path, resolved);
  if (exactPath.diagnostics.length > 0) return new Error(exactPath.diagnostics[0]?.message ?? "Expected path casing did not match.");
  const content = await input.deps.platform.readFile(resolved).catch((error: unknown) => error instanceof Error ? error : new Error("Unable to read expectation target."));
  if (content instanceof Error) return content;
  return { content, path: resolved };
}

function inferredFileArtifactOutputContract(prompt: string): AgentLoopOutputContract | undefined {
  if (!fileMutationRequested(prompt)) return undefined;
  const paths = requestedPathLiterals(prompt);
  if (paths.length === 0) return undefined;
  return {
    schemaVersion: "1.0.0",
    kind: "file",
    required: true,
    description: "Requested workspace artifact paths must exist exactly as written by the user.",
    ...(paths[0] ? { path: paths[0] } : {}),
    verificationExpectations: paths.map((path) => ({
      schemaVersion: "1.0.0",
      kind: "artifact",
      required: true,
      description: `Requested artifact path must exist exactly: ${path}`,
      path,
      redaction: { class: "internal", fields: ["path", "description"] }
    })),
    redaction: { class: "internal", fields: ["path", "verificationExpectations.path", "verificationExpectations.description"] }
  };
}

function fileMutationRequested(prompt: string): boolean {
  if (/不要(?:修改|写入|编辑|删除|创建|生成)|不应(?:修改|写入|编辑|删除|创建|生成)|不应该(?:修改|写入|编辑|删除|创建|生成)|do not (?:modify|write|edit|delete|create|generate)/i.test(prompt)) {
    return false;
  }
  return /\b(update|write|edit|create|modify|fix|repair|refactor|add|remove|delete)\b/i.test(prompt)
    || /更新|写入|编辑|修改|修复|新增|创建|删除|补齐|生成/.test(prompt);
}

function requestedPathLiterals(prompt: string): readonly string[] {
  const paths = new Set<string>();
  for (const match of prompt.matchAll(/(?:^|[\s"'`，。；：、,;:(（])((?:\.\/)?(?:(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9][A-Za-z0-9_.-]*))(?=$|[\s"'`，。；：、,;:)）])/g)) {
    const path = match[1]?.replace(/^\.\//, "");
    if (path && isWorkspaceArtifactPathLiteral(path)) paths.add(path);
  }
  return [...paths];
}

function isWorkspaceArtifactPathLiteral(path: string): boolean {
  if (path.includes("://") || path.startsWith("../") || path.includes("/../")) return false;
  if (/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+){2,}$/.test(path)) return false;
  if (/^(?:core|runtime|workflow|agent|model|tool|capability|diagnostics|rubric)\./i.test(path)) return false;
  return true;
}

async function verifyCaseExactWorkspacePath(input: FinalVerificationInput, requestedPath: string, resolvedPath: string): Promise<{ readonly diagnostics: readonly RedactedError[] }> {
  if (!requestedPath) return { diagnostics: [] };
  const workspace = resolveExpectationPath(input, ".");
  if (workspace instanceof Error) return { diagnostics: [contractDiagnostic("OUTPUT_EXPECTATION_CWD_REJECTED", workspace.message)] };
  const actualPaths = await input.deps.platform.findFiles("", workspace).catch(() => []);
  const normalizedExpected = normalizePathForContract(resolvedPath);
  if (actualPaths.some((path) => normalizePathForContract(path) === normalizedExpected)) return { diagnostics: [] };
  const caseMismatch = actualPaths.find((path) => normalizePathForContract(path).toLowerCase() === normalizedExpected.toLowerCase());
  if (caseMismatch) {
    return {
      diagnostics: [contractDiagnostic(
        "OUTPUT_EXPECTATION_ARTIFACT_CASE_MISMATCH",
        `Expected artifact path ${requestedPath} exactly, but found ${relativeContractPath(workspace, caseMismatch)} with different casing.`,
        { expectedPath: requestedPath, actualPath: relativeContractPath(workspace, caseMismatch) }
      )]
    };
  }
  return {
    diagnostics: [contractDiagnostic(
      "OUTPUT_EXPECTATION_ARTIFACT_MISSING",
      `Expected artifact path ${requestedPath} was not found exactly.`,
      { expectedPath: requestedPath }
    )]
  };
}

function normalizePathForContract(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function relativeContractPath(root: string, path: string): string {
  const normalizedRoot = normalizePathForContract(root);
  const normalizedPath = normalizePathForContract(path);
  return normalizedPath.startsWith(`${normalizedRoot}/`) ? normalizedPath.slice(normalizedRoot.length + 1) : normalizedPath;
}

function expectationResult(
  expectation: AgentLoopVerificationExpectation,
  index: number,
  checkedPaths: readonly string[],
  diagnostics: readonly RedactedError[],
  evidenceIds: readonly string[]
): ExpectationVerificationResult {
  return {
    checkedPaths,
    diagnostics: diagnostics.map((diagnostic) => ({
      ...diagnostic,
      details: {
        ...(isJsonObject(diagnostic.details) ? diagnostic.details : {}),
        expectationIndex: index,
        expectationKind: expectation.kind,
        required: expectation.required
      }
    })),
    evidenceIds,
    requiredFailure: expectation.required && diagnostics.length > 0
  };
}

function mergeOutputContractResults(contract: AgentLoopOutputContract, base: AgentLoopOutputContractVerification, expectations: ExpectationVerificationResult): AgentLoopOutputContractVerification {
  const diagnostics = [...base.diagnostics, ...expectations.diagnostics];
  const requiredFailure = base.status === "fail" || expectations.requiredFailure;
  const status = requiredFailure
    ? contract.required ? "fail" : "not_applicable"
    : base.status === "not_applicable" ? "not_applicable" : "pass";
  return outputContractResult(
    contract,
    status,
    [...base.checkedPaths, ...expectations.checkedPaths],
    diagnostics,
    [...base.evidenceIds, ...expectations.evidenceIds]
  );
}

function resolveContractPath(input: FinalVerificationInput, contract: AgentLoopOutputContract): string | Error {
  if (!contract.path) return new Error("Output contract requires a path.");
  return resolveExpectationPath(input, contract.path);
}

function resolveExpectationPath(input: FinalVerificationInput, path: string): string | Error {
  const resolved = input.deps.platform.resolveWorkspacePath(input.request.workspaceRoot, path);
  if (!resolved.ok || !resolved.value) return new Error(resolved.error?.message ?? "Output path rejected.");
  return resolved.value.path;
}

function outputContractResult(
  contract: AgentLoopOutputContract,
  status: AgentLoopOutputContractVerification["status"],
  checkedPaths: readonly string[],
  diagnostics: readonly RedactedError[],
  evidenceIds: readonly string[]
): AgentLoopOutputContractVerification {
  return {
    schemaVersion: "1.0.0",
    contract,
    status,
    checkedPaths,
    diagnostics,
    evidenceIds,
    redaction: { class: "internal", fields: ["contract.schema", "checkedPaths", "diagnostics.details"] }
  };
}

function parseStrictJsonObject(value: string): JsonObject | Error {
  try {
    const parsed = JSON.parse(value.trim()) as unknown;
    if (!isJsonObject(parsed)) return new Error("Output must be a JSON object.");
    return parsed;
  } catch (error) {
    return error instanceof Error ? error : new Error("Output is not parseable JSON.");
  }
}

function validateJsonSchema(value: JsonObject, schema: JsonObject | undefined): readonly RedactedError[] {
  if (!schema) return [];
  return validateSchemaAt(value, schema, "$");
}

function validateSchemaAt(value: unknown, schema: JsonObject, path: string): readonly RedactedError[] {
  const diagnostics: RedactedError[] = [];
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type && !matchesJsonType(value, type)) diagnostics.push(contractDiagnostic("OUTPUT_SCHEMA_TYPE_MISMATCH", `${path} must be ${type}.`, { path, expected: type }));
  if (type === "object" && isJsonObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) {
      if (!(key in value)) diagnostics.push(contractDiagnostic("OUTPUT_SCHEMA_REQUIRED_MISSING", `${path}.${key} is required.`, { path, key }));
    }
    const properties = isJsonObject(schema.properties) ? schema.properties : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in value) || !isJsonObject(childSchema)) continue;
      diagnostics.push(...validateSchemaAt(value[key], childSchema, `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) diagnostics.push(contractDiagnostic("OUTPUT_SCHEMA_ADDITIONAL_PROPERTY", `${path}.${key} is not allowed.`, { path, key }));
      }
    }
  }
  if (type === "array" && Array.isArray(value) && isJsonObject(schema.items)) {
    value.forEach((item, index) => diagnostics.push(...validateSchemaAt(item, schema.items as JsonObject, `${path}[${index}]`)));
  }
  return diagnostics;
}

function matchesJsonType(value: unknown, type: string): boolean {
  if (type === "object") return isJsonObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return true;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitCommandLine(value: string): string[] | Error {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaping = false;
  for (const char of value.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (quote) return new Error("Check command contains an unterminated quoted argument.");
  if (current) args.push(current);
  return args;
}

function contractDiagnostic(code: string, message: string, details: JsonObject = {}): RedactedError {
  return {
    code,
    message,
    retryable: true,
    redaction: { class: "internal", fields: ["details"] },
    details
  };
}

async function appendEvent(
  events: RuntimeEvent[],
  input: FinalVerificationInput,
  kind: RuntimeEvent["kind"],
  data: RuntimeEvent["data"]
): Promise<void> {
  const event = agentLoopEvent(kind, input.sessionId, input.turnId, input.trace, data, input.request.agentId);
  await recordRuntimeAdapterEvent(input.deps, event);
  events.push(event);
}
