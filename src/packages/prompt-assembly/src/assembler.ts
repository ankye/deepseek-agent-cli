import type {
  AgentLoopToolProjection,
  CapabilityManifest,
  ContextPipelineManifest,
  JsonObject,
  ModelChatMessage,
  PromptAssembler,
  PromptAssemblyInput,
  PromptAssemblyPipelineEvidence,
  PromptAssemblyReplayReport,
  PromptAssemblyResult,
  PromptAssemblyReplayEvidence,
  PromptAssemblyStage,
  PromptBudgetReport,
  PromptSection,
  PromptSectionBudgetClass,
  PromptSectionExclusionReason,
  PromptSectionKind,
  PromptSectionSource,
  PromptSectionTrace,
  PromptSectionTrust,
  PromptToolPlan,
  RedactedError
} from "@deepseek/platform-contracts";
import { PROMPT_ASSEMBLY_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import { defaultPromptSectionProviders } from "./providers.js";
import { estimateTokens, stableHash } from "./sections.js";
import { isCapabilityVisibleForProjection } from "./tool-projection.js";

export type PromptSectionProvider = (input: PromptAssemblyInput) => readonly PromptSection[] | Promise<readonly PromptSection[]>;

export interface PromptSectionProviderRegistration {
  readonly id: string;
  readonly version: string;
  readonly kind: PromptSectionKind;
  readonly source: PromptSectionSource;
  readonly priority: number;
  readonly budgetClass: PromptSectionBudgetClass;
  readonly trust: PromptSectionTrust;
  readonly required: boolean;
  readonly compatibility: import("@deepseek/platform-contracts").CompatibilityMetadata;
  readonly provide: PromptSectionProvider;
}

export interface PromptAssemblerOptions {
  readonly providers?: readonly PromptSectionProviderRegistration[];
  readonly packageVersion?: string;
  readonly previewChars?: number;
}

const DEFAULT_PACKAGE_VERSION = "0.1.0";
const DEFAULT_PREVIEW_CHARS = 160;
const STAGES: readonly PromptAssemblyStage[] = ["normalize", "collect-sections", "order-sections", "budget", "weave-messages", "project-tools", "trace"];
const PROVIDER_HISTORY_DYNAMIC_MESSAGE_LIMIT = 6;
const PROVIDER_HISTORY_COMPACT_TOOL_RESULT_CHARS = 360;
const PROVIDER_HISTORY_SOURCE_RESULT_CHARS = 12_000;
const EMPTY_REDACTION = { class: "internal" as const };

export function createDefaultPromptAssembler(options: PromptAssemblerOptions = {}): PromptAssembler {
  return new DefaultPromptAssembler(options);
}

export class DefaultPromptAssembler implements PromptAssembler {
  private readonly providers: readonly PromptSectionProviderRegistration[];
  private readonly packageVersion: string;
  private readonly previewChars: number;

  constructor(options: PromptAssemblerOptions = {}) {
    this.providers = options.providers ?? defaultPromptSectionProviders();
    this.packageVersion = options.packageVersion ?? DEFAULT_PACKAGE_VERSION;
    this.previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS;
  }

  async assemble(input: PromptAssemblyInput): Promise<PromptAssemblyResult> {
    const diagnostics: RedactedError[] = [];
    diagnostics.push(...validatePromptAssemblyInput(input));
    const rawSections = await collectProviderSections(input, this.providers, diagnostics);
    const ordered = orderSections(rawSections);
    const budgeted = applyBudget(ordered, input, this.previewChars);
    const messages = weaveMessages(budgeted.included, input.history, input.prompt);
    const toolPlan = projectTools(input.availableTools, input.toolPolicy, input.toolOptIns ?? []);
    const promptText = messages.map((message) => `${message.role}: ${message.content}`).join("\n");
    const registryFingerprint = stableHash(this.providers.map((provider) => providerFingerprint(provider)).join("|"));
    const replay = createReplayEvidence({
      input,
      packageVersion: this.packageVersion,
      registryFingerprint,
      included: budgeted.included,
      budget: budgeted.report,
      toolPlan,
      messages
    });
    const pipeline = input.contextPipelineManifest
      ? promptPipelineEvidence(input.contextPipelineManifest, messages)
      : undefined;
    const trace = {
      schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION,
      stageOrder: STAGES,
      providerIds: this.providers.map((provider) => provider.id),
      sections: [...budgeted.included.map((section) => sectionTrace(section, true, undefined, this.previewChars)), ...budgeted.report.exclusions],
      projectRules: input.projectRules ?? [],
      diagnostics,
      replay,
      ...(pipeline ? { pipeline } : {}),
      redaction: { class: "internal", fields: ["sections.preview", "diagnostics.details"] },
      compatibility: { schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION }
    } as const;
    const fingerprint = stableHash(JSON.stringify({
      schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION,
      replay,
      promptText,
      sectionFingerprints: budgeted.included.map((section) => section.evidenceFingerprint)
    }));
    return {
      schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION,
      status: budgeted.report.status === "rejected" ? "rejected" : "assembled",
      messages,
      promptText,
      sections: trace.sections,
      toolPlan,
      budget: budgeted.report,
      trace,
      fingerprint,
      diagnostics,
      redaction: { class: "internal", fields: ["promptText", "messages.content", "sections.preview", "diagnostics.details"] },
      compatibility: { schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION }
    };
  }
}

function validatePromptAssemblyInput(input: PromptAssemblyInput): readonly RedactedError[] {
  const diagnostics: RedactedError[] = [];
  if (input.workOrder) {
    const requiredTextFields = [
      ["purpose", input.workOrder.purpose],
      ["originalUserGoal", input.workOrder.originalUserGoal],
      ["taskSummary", input.workOrder.taskSummary]
    ] as const;
    for (const [field, value] of requiredTextFields) {
      if (!value.trim()) {
        diagnostics.push(providerDiagnostic("core.work-order", "PROMPT_WORK_ORDER_INCOMPLETE", `Work order ${field} is required.`));
      }
    }
    if (input.workOrder.targets.length === 0 || input.workOrder.doneCriteria.length === 0 || input.workOrder.verificationExpectations.length === 0) {
      diagnostics.push(providerDiagnostic("core.work-order", "PROMPT_WORK_ORDER_INCOMPLETE", "Work order must include targets, done criteria, and verification expectations."));
    }
    const lazyText = [input.workOrder.purpose, input.workOrder.taskSummary, ...input.workOrder.doneCriteria].join("\n");
    if (isLazyDelegation(lazyText)) {
      diagnostics.push(providerDiagnostic("core.work-order", "PROMPT_LAZY_DELEGATION_REJECTED", "Worker work order must be self-contained and cannot rely on prior findings without structured context."));
    }
  }
  return diagnostics;
}

function isLazyDelegation(value: string): boolean {
  return [
    /\bbased on (the )?prior findings\b/i,
    /\bcontinue from (the )?(prior|previous) findings\b/i,
    /\bfix what (we )?(discussed|talked about)\b/i,
    /\binspect (the )?(recent|latest) changes\b/i,
    /基于(之前|上面|前面).*继续/,
    /修复(刚才|之前).*问题/,
    /检查(最近|刚才).*修改/
  ].some((pattern) => pattern.test(value));
}

export function replayPromptAssembly(
  captured: Pick<PromptAssemblyResult, "fingerprint" | "trace">,
  replayed: PromptAssemblyResult
): PromptAssemblyReplayReport {
  if (captured.fingerprint === replayed.fingerprint) {
    return {
      schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION,
      status: "matched",
      capturedFingerprint: captured.fingerprint,
      replayedFingerprint: replayed.fingerprint,
      redaction: EMPTY_REDACTION
    };
  }
  const firstDrift = firstReplayDrift(captured.trace.replay, replayed.trace.replay, captured.fingerprint, replayed.fingerprint);
  return {
    schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION,
    status: "drifted",
    capturedFingerprint: captured.fingerprint,
    replayedFingerprint: replayed.fingerprint,
    ...(firstDrift ? { firstDrift } : {}),
    redaction: EMPTY_REDACTION
  };
}


async function collectProviderSections(
  input: PromptAssemblyInput,
  providers: readonly PromptSectionProviderRegistration[],
  diagnostics: RedactedError[]
): Promise<readonly PromptSection[]> {
  const sections: PromptSection[] = [];
  for (const provider of providers) {
    try {
      const provided = await provider.provide(input);
      for (const section of provided) {
        if (section.providerId !== provider.id || !section.content) {
          diagnostics.push(providerDiagnostic(provider.id, "PROMPT_SECTION_INVALID", "Prompt section provider returned invalid section data"));
          continue;
        }
        sections.push(section);
      }
    } catch (error) {
      diagnostics.push(providerDiagnostic(provider.id, provider.required ? "PROMPT_REQUIRED_PROVIDER_FAILED" : "PROMPT_PROVIDER_FAILED", error instanceof Error ? error.message : "Prompt section provider failed"));
    }
  }
  return sections;
}

function orderSections(sections: readonly PromptSection[]): readonly PromptSection[] {
  return [...sections].sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    if (left.providerId !== right.providerId) return left.providerId.localeCompare(right.providerId);
    return left.id.localeCompare(right.id);
  });
}

function applyBudget(
  sections: readonly PromptSection[],
  input: PromptAssemblyInput,
  previewChars: number
): { readonly included: readonly PromptSection[]; readonly report: PromptBudgetReport } {
  const seen = new Set<string>();
  const included: PromptSection[] = [];
  const exclusions: PromptSectionTrace[] = [];
  let selectedTokens = 0;
  let excludedTokens = 0;
  const hardLimit = Math.max(1, input.budget.hardLimitTokens);
  const reservedOutputTokens = input.budget.reservedOutputTokens ?? 0;
  const effectiveLimit = Math.max(1, hardLimit - reservedOutputTokens);

  for (const section of sections) {
    if (seen.has(section.evidenceFingerprint)) {
      excludedTokens += section.estimatedTokens;
      exclusions.push(sectionTrace(section, false, "duplicate-fingerprint", previewChars));
      continue;
    }
    seen.add(section.evidenceFingerprint);

    if (selectedTokens + section.estimatedTokens > effectiveLimit && !section.required) {
      excludedTokens += section.estimatedTokens;
      exclusions.push(sectionTrace(section, false, "budget-exceeded", previewChars));
      continue;
    }

    included.push(section);
    selectedTokens += section.estimatedTokens;
  }

  const requiredDropped = exclusions.some((trace) => trace.required && trace.exclusionReason !== "duplicate-fingerprint");
  const status = requiredDropped ? "rejected" : exclusions.length > 0 ? "degraded" : "within-budget";
  return {
    included,
    report: {
      status,
      hardLimitTokens: hardLimit,
      ...(input.budget.softLimitTokens !== undefined ? { softLimitTokens: input.budget.softLimitTokens } : {}),
      reservedOutputTokens,
      selectedTokens,
      excludedTokens,
      includedSectionCount: included.length,
      excludedSectionCount: exclusions.length,
      exclusions,
      redaction: { class: "internal", fields: ["exclusions.preview"] }
    }
  };
}

function weaveMessages(sections: readonly PromptSection[], history: readonly ModelChatMessage[], prompt: string): readonly ModelChatMessage[] {
  const messages: ModelChatMessage[] = [];
  for (const section of orderedSystemSectionsForProviderPrefix(sections)) {
    if (section.role === "user") continue;
    messages.push({
      role: section.role,
      content: section.content,
      cacheHint: cacheHintForSection(section)
    });
  }
  messages.push(...historyWithStableTaskPrompt(history, prompt));
  return messages;
}

function historyWithStableTaskPrompt(history: readonly ModelChatMessage[], prompt: string): readonly ModelChatMessage[] {
  let marked = false;
  const markedHistory: ModelChatMessage[] = history.map((message) => {
    if (marked || message.role !== "user" || message.content !== prompt || message.cacheHint) return message;
    marked = true;
    return {
      ...message,
      cacheHint: { policy: "stable", freshness: "turn" }
    };
  });
  return boundDynamicProviderHistory(markedHistory);
}

function boundDynamicProviderHistory(history: readonly ModelChatMessage[]): readonly ModelChatMessage[] {
  const stableTaskIndex = history.findIndex((message) => message.role === "user" && message.cacheHint?.policy === "stable");
  if (stableTaskIndex < 0) return history.slice(-PROVIDER_HISTORY_DYNAMIC_MESSAGE_LIMIT);
  const prefix = history.slice(0, stableTaskIndex + 1);
  const tail = history.slice(stableTaskIndex + 1);
  return [...prefix, ...boundedTailWithToolPairs(tail, PROVIDER_HISTORY_DYNAMIC_MESSAGE_LIMIT)];
}

function boundedTailWithToolPairs(tail: readonly ModelChatMessage[], limit: number): readonly ModelChatMessage[] {
  const sourceEvidence = latestSuccessfulSourceEvidencePair(tail);
  const recentLimit = Math.max(0, limit - (sourceEvidence ? 2 : 0));
  const selected: Array<{ readonly index: number; readonly message: ModelChatMessage }> = [];
  const selectedToolCallIds = new Set<string>();
  let recentToolResult = true;
  for (let index = tail.length - 1; index >= 0 && selected.length < recentLimit; index -= 1) {
    const message = tail[index];
    if (!message) continue;
    if (message.role === "tool") {
      if (message.toolCallId === sourceEvidence?.toolCallId) continue;
      const pair = toolPairFor(tail, index, selectedToolCallIds);
      if (pair && selected.length + 2 <= recentLimit) {
        const toolMessage = compactToolResultMessage(message, recentToolResult);
        recentToolResult = false;
        selected.push(
          { index: pair.intentIndex, message: pair.intent },
          { index, message: toolMessage }
        );
        selectedToolCallIds.add(pair.toolCallId);
      }
      continue;
    }
    if (message.toolCalls && message.toolCalls.length > 0) {
      const allSelected = message.toolCalls.every((toolCall) => selectedToolCallIds.has(toolCall.id));
      if (allSelected) continue;
      continue;
    }
    selected.push({ index, message });
  }
  if (sourceEvidence) {
    selected.push(
      { index: sourceEvidence.intentIndex, message: sourceEvidence.intent },
      { index: sourceEvidence.toolIndex, message: compactToolResultMessage(sourceEvidence.tool, false) }
    );
  }
  return selected
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.message);
}

function compactToolResultMessage(message: ModelChatMessage, recent: boolean): ModelChatMessage {
  if (message.role === "tool" && isSuccessfulSourceInspectionResult(message)) {
    return compactSourceInspectionResult(message);
  }
  if (message.role !== "tool" || message.content.length <= PROVIDER_HISTORY_COMPACT_TOOL_RESULT_CHARS) return message;
  const previewChars = Math.floor(PROVIDER_HISTORY_COMPACT_TOOL_RESULT_CHARS / 2);
  const head = message.content.slice(0, previewChars).replace(/\s+$/g, "");
  const tail = message.content.slice(-previewChars).replace(/^\s+/g, "");
  return {
    ...message,
    content: [
      `compacted ${recent ? "recent" : "older"} tool result: ${message.toolName ?? "tool"} ${message.toolCallId ?? ""}`.trim(),
      `originalChars=${message.content.length}`,
      "head:",
      head,
      ...(recent ? ["tail:", tail] : [])
    ].join("\n")
  };
}

function compactSourceInspectionResult(message: ModelChatMessage): ModelChatMessage {
  if (message.content.length <= PROVIDER_HISTORY_SOURCE_RESULT_CHARS) return message;
  const segmentChars = Math.floor(PROVIDER_HISTORY_SOURCE_RESULT_CHARS / 3);
  const middleStart = Math.max(0, Math.floor((message.content.length - segmentChars) / 2));
  return {
    ...message,
    content: [
      `compacted source tool result: ${message.toolName ?? "tool"} ${message.toolCallId ?? ""}`.trim(),
      `originalChars=${message.content.length}`,
      "head:",
      message.content.slice(0, segmentChars).replace(/\s+$/g, ""),
      "middle:",
      message.content.slice(middleStart, middleStart + segmentChars).replace(/^\s+|\s+$/g, ""),
      "tail:",
      message.content.slice(-segmentChars).replace(/^\s+/g, "")
    ].join("\n")
  };
}

function latestSuccessfulSourceEvidencePair(tail: readonly ModelChatMessage[]): {
  readonly intent: ModelChatMessage;
  readonly intentIndex: number;
  readonly tool: ModelChatMessage;
  readonly toolIndex: number;
  readonly toolCallId: string;
} | undefined {
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const message = tail[index];
    if (!message || message.role !== "tool" || !isSuccessfulSourceInspectionResult(message)) continue;
    const pair = toolPairFor(tail, index, new Set());
    if (!pair) continue;
    return {
      intent: pair.intent,
      intentIndex: pair.intentIndex,
      tool: message,
      toolIndex: index,
      toolCallId: pair.toolCallId
    };
  }
  return undefined;
}

function isSuccessfulSourceInspectionResult(message: ModelChatMessage): boolean {
  if (message.role !== "tool" || !isSourceInspectionToolName(message.toolName)) return false;
  const prefix = message.content.trimStart().slice(0, 160).toUpperCase();
  return !prefix.startsWith("WORKFLOW_")
    && !prefix.startsWith("TOOL EXECUTION FAILED")
    && !prefix.startsWith("ERROR CODE:");
}

function isSourceInspectionToolName(toolName: string | undefined): boolean {
  return toolName === "core.file.read"
    || toolName === "core.file.list"
    || toolName === "core.search.text"
    || toolName === "core.workspace.glob";
}

function toolPairFor(
  tail: readonly ModelChatMessage[],
  toolIndex: number,
  selectedToolCallIds: ReadonlySet<string>
): { readonly intent: ModelChatMessage; readonly intentIndex: number; readonly toolCallId: string } | undefined {
  const toolMessage = tail[toolIndex];
  const toolCallId = toolMessage?.toolCallId;
  if (!toolCallId || selectedToolCallIds.has(toolCallId)) return undefined;
  for (let index = toolIndex - 1; index >= 0; index -= 1) {
    const message = tail[index];
    if (!message?.toolCalls?.some((toolCall) => toolCall.id === toolCallId)) continue;
    return { intent: message, intentIndex: index, toolCallId };
  }
  return undefined;
}

function orderedSystemSectionsForProviderPrefix(sections: readonly PromptSection[]): readonly PromptSection[] {
  const stableSystem: PromptSection[] = [];
  const volatileSystem: PromptSection[] = [];
  for (const section of sections) {
    if (section.role !== "system") {
      volatileSystem.push(section);
      continue;
    }
    if (isStablePrefixSection(section)) stableSystem.push(section);
    else volatileSystem.push(section);
  }
  return [...stableSystem, ...volatileSystem];
}

function cacheHintForSection(section: PromptSection): NonNullable<ModelChatMessage["cacheHint"]> {
  return {
    policy: isStablePrefixSection(section) ? "stable" : "ephemeral",
    freshness: isStablePrefixSection(section) ? "static" : "turn"
  };
}

function isStablePrefixSection(section: PromptSection): boolean {
  if (section.source === "self-repair") return false;
  if (section.providerId === "core.task-output-contract") return false;
  if (section.providerId === "core.profile-workflow-state") return false;
  if (section.providerId === "core.scheduling-next-action") return false;
  if (section.providerId === "core.tool-policy") return false;
  if (section.providerId === "core.tool-decision-board") return false;
  if (section.providerId === "core.project-instructions") {
    return section.source === "project"
      && section.kind === "project.instructions";
  }
  if (section.providerId === "core.task-decision-request") {
    return section.kind === "task.decision-request"
      && section.trust === "system";
  }
  return section.role === "system"
    && (section.trust === "system" || section.trust === "trusted" || section.trust === "workspace")
    && (
      section.source === "runtime" ||
      section.source === "capability-registry" ||
      section.source === "context-engine"
    );
}

function projectTools(tools: readonly CapabilityManifest[], policy: AgentLoopToolProjection, toolOptIns: readonly string[] = []): PromptToolPlan {
  const visibleTools: JsonObject[] = [];
  const excludedTools: JsonObject[] = [];
  for (const tool of tools) {
    const schema = modelToolSchema(tool);
    if (isCapabilityVisibleForProjection(tool, policy, toolOptIns)) {
      visibleTools.push(schema);
    } else {
      excludedTools.push({
        capabilityId: tool.id,
        sideEffect: tool.sideEffect,
        reason: "tool-policy-excluded"
      });
    }
  }
  return {
    policy,
    visibleToolCount: visibleTools.length,
    excludedToolCount: excludedTools.length,
    visibleTools,
    excludedTools,
    redaction: { class: "internal", fields: ["visibleTools.function.parameters", "excludedTools"] }
  };
}

export function modelToolSchema(manifest: CapabilityManifest): JsonObject {
  const safeName = toSafeToolName(String(manifest.id));
  return {
    type: "function",
    function: {
      name: safeName,
      description: manifest.description ?? manifest.name,
      parameters: manifest.inputSchema
    },
    metadata: {
      capabilityId: manifest.id,
      version: manifest.version,
      sideEffect: manifest.sideEffect,
      permissions: manifest.permissions,
      timeoutMs: manifest.timeoutMs ?? 30_000,
      replayPolicy: manifest.replayPolicy ?? {}
    }
  };
}

function toSafeToolName(capabilityId: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(capabilityId) ? capabilityId : capabilityId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function sectionTrace(
  section: PromptSection,
  included: boolean,
  exclusionReason: PromptSectionExclusionReason | undefined,
  previewChars: number
): PromptSectionTrace {
  return {
    id: section.id,
    providerId: section.providerId,
    kind: section.kind,
    source: section.source,
    priority: section.priority,
    budgetClass: section.budgetClass,
    trust: section.trust,
    required: section.required,
    estimatedTokens: section.estimatedTokens,
    evidenceFingerprint: section.evidenceFingerprint,
    included,
    ...(exclusionReason ? { exclusionReason } : {}),
    provenance: section.provenance,
    preview: preview(section.content, previewChars),
    redaction: { class: "internal", fields: ["preview"] },
    compatibility: section.compatibility
  };
}

function createReplayEvidence(input: {
  readonly input: PromptAssemblyInput;
  readonly packageVersion: string;
  readonly registryFingerprint: string;
  readonly included: readonly PromptSection[];
  readonly budget: PromptBudgetReport;
  readonly toolPlan: PromptToolPlan;
  readonly messages: readonly ModelChatMessage[];
}): PromptAssemblyReplayEvidence {
  return {
    schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION,
    packageVersion: input.packageVersion,
      inputFingerprint: stableHash(JSON.stringify({
        schemaVersion: input.input.schemaVersion,
        sessionId: input.input.sessionId,
        turnId: input.input.turnId,
        prompt: input.input.prompt,
        mode: input.input.mode,
        profile: input.input.profile,
        toolPolicy: input.input.toolPolicy,
        budget: input.input.budget,
        projectRules: input.input.projectRules?.map((rule) => ({
          source: rule.source,
          status: rule.status,
          priority: rule.priority,
          path: rule.path,
          fingerprint: rule.fingerprint,
          bytes: rule.bytes
        })),
        outputContract: input.input.outputContract
          ? {
              kind: input.input.outputContract.kind,
              required: input.input.outputContract.required,
              path: input.input.outputContract.path,
              hasSchema: input.input.outputContract.schema !== undefined,
              expectationCount: input.input.outputContract.verificationExpectations?.length ?? 0
            }
          : undefined,
        contextFingerprint: input.input.contextProjection?.replayFingerprint,
        contextPipelineFingerprint: input.input.contextPipelineManifest?.pipelineFingerprint,
        evidenceFirst: input.input.evidenceFirst
          ? {
              summaryId: input.input.evidenceFirst.summary.summaryId,
              classificationId: input.input.evidenceFirst.classification.classificationId,
              evidenceFingerprints: input.input.evidenceFirst.selectedEvidence.map((item) => item.fingerprint)
            }
          : undefined
      })),
    registryFingerprint: input.registryFingerprint,
    sectionOrderFingerprint: stableHash(input.included.map((section) => `${section.id}:${section.evidenceFingerprint}`).join("|")),
    budgetFingerprint: stableHash(JSON.stringify({
      status: input.budget.status,
      selectedTokens: input.budget.selectedTokens,
      excludedTokens: input.budget.excludedTokens,
      exclusions: input.budget.exclusions.map((section) => `${section.id}:${section.exclusionReason}`)
    })),
    toolPlanFingerprint: stableHash(JSON.stringify({
      policy: input.toolPlan.policy,
      visibleToolCount: input.toolPlan.visibleToolCount,
      excludedToolCount: input.toolPlan.excludedToolCount,
      visibleTools: input.toolPlan.visibleTools.map((tool) => JSON.stringify(tool))
    })),
    messageRoles: input.messages.map((message) => message.role),
    redaction: EMPTY_REDACTION
  };
}

function promptPipelineEvidence(manifest: ContextPipelineManifest, messages: readonly ModelChatMessage[]): PromptAssemblyPipelineEvidence {
  const providerPrefix = providerStablePrefixEvidence(messages);
  return {
    schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION,
    pipelineFingerprint: providerPrefix.providerPrefixFingerprint
      ? `pipeline:${stableHash(JSON.stringify({
          context: manifest.pipelineFingerprint,
          providerPrefix: providerPrefix.providerPrefixFingerprint
        }))}`
      : manifest.pipelineFingerprint,
    layerPrefixHashes: manifest.prefixHashes.map((entry) => `${entry.layer}:${entry.prefixHash}`),
    includedBlockIds: manifest.blocks.map((block) => block.id),
    excludedBlockIds: manifest.excludedBlocks.map((block) => block.id),
    contextCacheHintSummary: manifest.cacheHintSummary,
    ...providerPrefix,
    cacheHintSummary: providerPrefix.providerPrefixCacheHintSummary ?? manifest.cacheHintSummary,
    redaction: { class: "internal", fields: ["layerPrefixHashes", "includedBlockIds", "excludedBlockIds", "providerPrefixFingerprint"] }
  };
}

function providerStablePrefixEvidence(messages: readonly ModelChatMessage[]): {
  readonly providerPrefixFingerprint?: string;
  readonly providerPrefixMessageCount: number;
  readonly providerPrefixTokenEstimate: number;
  readonly providerPrefixCacheHintSummary: JsonObject;
} {
  const prefix: ModelChatMessage[] = [];
  for (const message of messages) {
    if (!isProviderStablePrefixMessage(message)) break;
    prefix.push(message);
  }
  return {
    ...(prefix.length > 0
      ? {
          providerPrefixFingerprint: `provider-prefix:${stableHash(JSON.stringify(prefix.map((message) => ({
            role: message.role,
            content: message.content,
            policy: message.cacheHint?.policy,
            freshness: message.cacheHint?.freshness
          }))))}`
        }
      : {}),
    providerPrefixMessageCount: prefix.length,
    providerPrefixTokenEstimate: prefix.reduce((total, message) => total + estimateTokens(message.content), 0),
    providerPrefixCacheHintSummary: {
      stable: prefix.length,
      ephemeral: 0,
      noStore: 0,
      ttlBound: 0
    }
  };
}

function isProviderStablePrefixMessage(message: ModelChatMessage): boolean {
  return (message.role === "system" || message.role === "user")
    && message.cacheHint?.policy === "stable";
}

function firstReplayDrift(
  captured: PromptAssemblyReplayEvidence,
  replayed: PromptAssemblyReplayEvidence,
  capturedFingerprint: string,
  replayedFingerprint: string
): PromptAssemblyReplayReport["firstDrift"] {
  if (captured.packageVersion !== replayed.packageVersion) {
    return drift("provider-version", "Prompt assembly package version changed", { packageVersion: captured.packageVersion }, { packageVersion: replayed.packageVersion });
  }
  if (captured.registryFingerprint !== replayed.registryFingerprint) {
    return drift("provider-version", "Prompt section registry changed", { registryFingerprint: captured.registryFingerprint }, { registryFingerprint: replayed.registryFingerprint });
  }
  if (captured.sectionOrderFingerprint !== replayed.sectionOrderFingerprint) {
    return drift("section-fingerprint", "Prompt section order or evidence fingerprint changed", { sectionOrderFingerprint: captured.sectionOrderFingerprint }, { sectionOrderFingerprint: replayed.sectionOrderFingerprint });
  }
  if (captured.budgetFingerprint !== replayed.budgetFingerprint) {
    return drift("budget-estimate", "Prompt budget decisions changed", { budgetFingerprint: captured.budgetFingerprint }, { budgetFingerprint: replayed.budgetFingerprint });
  }
  if (captured.toolPlanFingerprint !== replayed.toolPlanFingerprint) {
    return drift("tool-projection", "Prompt tool projection changed", { toolPlanFingerprint: captured.toolPlanFingerprint }, { toolPlanFingerprint: replayed.toolPlanFingerprint });
  }
  return drift("fingerprint", "Prompt assembly fingerprint changed", { fingerprint: capturedFingerprint }, { fingerprint: replayedFingerprint });
}

function drift(kind: NonNullable<PromptAssemblyReplayReport["firstDrift"]>["kind"], message: string, captured: JsonObject, replayed: JsonObject): NonNullable<PromptAssemblyReplayReport["firstDrift"]> {
  return { kind, message, captured, replayed, redaction: EMPTY_REDACTION };
}

function providerFingerprint(provider: PromptSectionProviderRegistration): string {
  return JSON.stringify({
    id: provider.id,
    version: provider.version,
    kind: provider.kind,
    source: provider.source,
    priority: provider.priority,
    budgetClass: provider.budgetClass,
    trust: provider.trust,
    required: provider.required,
    compatibility: provider.compatibility
  });
}

function providerDiagnostic(providerId: string, code: string, message: string): RedactedError {
  return {
    code,
    message,
    retryable: false,
    details: { providerId },
    redaction: { class: "internal", fields: ["details"] }
  };
}

function preview(text: string, limit: number): string {
  const safe = redactSecretLikeText(text);
  return safe.length > limit ? safe.slice(0, limit) : safe;
}

function redactSecretLikeText(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-REDACTED");
}
