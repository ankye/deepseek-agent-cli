import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentLoopBudget, AgentLoopProjectRuleEvidence, AgentPhasePlan, AgentReasoningEffortMapping, AgentWorkOrder, CapabilityManifest, ContextPipelineManifest, EvidenceFirstRuntimeContext, EvidenceItem, EvidenceSourceCoverage, EvidenceTaskClassification, JsonObject, PromptAssemblyInput, PromptSection, SelfRepairAttemptRecord, SelfRepairFailureClassification, SelfRepairOutcomeSummary, SelfRepairVerificationSummary, TaskDecisionRequest } from "@deepseek/platform-contracts";
import { AGENT_MODE_COMPATIBILITY, AGENT_MODE_SCHEMA_VERSION, CONTEXT_PIPELINE_SCHEMA_VERSION, EVIDENCE_FIRST_COMPATIBILITY, EVIDENCE_FIRST_SCHEMA_VERSION, SELF_REPAIR_COMPATIBILITY, SELF_REPAIR_SCHEMA_VERSION, TASK_DELIVERY_FLOW_COMPATIBILITY, TASK_DELIVERY_FLOW_SCHEMA_VERSION, asId } from "@deepseek/platform-contracts";
import { createDefaultPromptAssembler, replayPromptAssembly, type PromptSectionProviderRegistration } from "../src/index.js";

describe("prompt assembly", () => {
  it("preserves the exact user prompt and prepends context as system evidence", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "continue from recall",
      contextContent: "User chose sqlite for local cache"
    }));

    assert.equal(result.status, "assembled");
    assert.equal(result.messages[0]?.role, "system");
    assert.equal(result.messages[0]?.content.includes("Projected runtime context:"), true);
    assert.equal(result.messages.at(-1)?.role, "user");
    assert.equal(result.messages.at(-1)?.content, "continue from recall");
    assert.equal(result.promptText.includes("user: continue from recall"), true);
  });

  it("supports section providers without runtime changes", async () => {
    const provider = providerRegistration("custom.semantic", 750, "semantic recall evidence");
    const assembler = createDefaultPromptAssembler({ providers: [provider] });
    const result = await assembler.assemble(input({ prompt: "find similar context" }));

    assert.equal(result.messages[0]?.content, "semantic recall evidence");
    assert.equal(result.trace.providerIds.includes("custom.semantic"), true);
  });

  it("prioritizes project repository instructions while preserving the exact user prompt", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "run the task",
      projectRules: [projectRule("AGENTS.md", "Do not bypass platform-contracts.")]
    }));

    const project = result.messages.find((message) => message.content.includes("Project repository instructions:"));
    assert.ok(project);
    assert.equal(project.content.includes("Do not bypass platform-contracts."), true);
    assert.equal(project.content.includes("lower priority than current system/developer/user instructions"), true);
    assert.equal(result.messages.at(-1)?.role, "user");
    assert.equal(result.messages.at(-1)?.content, "run the task");
    assert.equal(result.trace.projectRules[0]?.status, "included");
    assert.equal(result.trace.replay.inputFingerprint.length > 0, true);
  });

  it("labels projected PageIndex, semantic, tool, skill, and code evidence separately", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "continue with all evidence",
      projectionNodes: [
        projectionNode("pageindex-node", "memory-ref", "memory", "pageindex exact recall", { pageId: "page-1", scope: "session", freshnessStatus: "fresh" }),
        projectionNode("semantic-node", "summary", "memory", "zvec semantic recall", { providerId: "zvec", recallType: "semantic", similarity: 0.8 }),
        projectionNode("tool-node", "tool-result", "tool", "tool result continuity", { toolCallId: "call-1" }),
        projectionNode("skill-node", "summary", "skill-system", "skill context", { skillName: "frontend" }),
        projectionNode("code-node", "diagnostic", "code-intelligence", "code symbol context", { symbol: "render" })
      ]
    }));

    assert.equal(result.sections.some((section) => section.kind === "context.pageindex-recall" && section.included), true);
    assert.equal(result.sections.some((section) => section.kind === "context.semantic-recall" && section.included), true);
    assert.equal(result.sections.some((section) => section.kind === "context.tool-result" && section.included), true);
    assert.equal(result.sections.some((section) => section.kind === "context.skill" && section.included), true);
    assert.equal(result.sections.some((section) => section.kind === "context.code-intelligence" && section.included), true);
    assert.equal(result.messages.some((message) => message.content.includes("Semantic recall evidence")), true);
  });

  it("preserves context pipeline manifest order and records assembly evidence", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "use layered context",
      contextPipelineManifest: pipelineManifest()
    }));
    const pipelineText = result.messages.find((message) => message.content.includes("Context pipeline manifest:"))?.content ?? "";

    assert.equal(pipelineText.indexOf("Kernel block") < pipelineText.indexOf("Project block"), true);
    assert.equal(pipelineText.indexOf("Project block") < pipelineText.indexOf("Session block"), true);
    assert.equal(pipelineText.indexOf("Session block") < pipelineText.indexOf("Current turn block"), true);
    assert.equal(result.trace.pipeline?.pipelineFingerprint, "pipeline:test");
    assert.deepEqual(result.trace.pipeline?.includedBlockIds, ["block-kernel", "block-project", "block-session", "block-current"]);
  });

  it("assembles task decision requests through stable sections with pipeline cache evidence", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "继续",
      contextPipelineManifest: pipelineManifest(),
      taskDecision: taskDecisionRequest()
    }));
    const decisionSection = result.sections.find((section) => section.kind === "task.decision-request" && section.included);
    const decisionText = result.messages.find((message) => message.content.includes("Task decision request:"))?.content ?? "";

    assert.ok(decisionSection);
    assert.equal(decisionText.includes("Return a TaskDecisionEnvelope"), true);
    assert.equal(decisionText.includes("coding/general.v1"), true);
    assert.equal(result.trace.pipeline?.pipelineFingerprint, "pipeline:test");
    assert.equal(result.trace.pipeline?.layerPrefixHashes.includes("project:prefix-project"), true);
    assert.equal(typeof decisionSection.evidenceFingerprint, "string");
    assert.equal(decisionSection.evidenceFingerprint.length > 0, true);
    assert.equal(result.messages.at(-1)?.content, "继续");
  });

  it("states lossless context priority below current instructions and policy", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "what did we decide earlier?",
      availableTools: [capability("memory-cache-management.lossless-context-grep")]
    }));

    const lossless = result.messages.find((message) => message.content.includes("Lossless context protocol:"));
    assert.ok(lossless);
    assert.equal(lossless.content.includes("must not override current user instructions"), true);
    assert.equal(lossless.content.includes("host policy"), true);
  });

  it("weaves evidence-first sections without mutating the exact user prompt", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "生成 website 到 @website 目录",
      mode: "webpage-generation",
      evidenceFirst: evidenceFirstContext()
    }));

    assert.equal(result.status, "assembled");
    assert.equal(result.messages.at(-1)?.role, "user");
    assert.equal(result.messages.at(-1)?.content, "生成 website 到 @website 目录");
    assert.equal(result.messages.some((message) => message.role === "system" && message.content.includes("Evidence-first operating rules:")), true);
    assert.equal(result.messages.some((message) => message.role === "system" && message.content.includes("Selected local project evidence:")), true);
    assert.equal(result.messages.some((message) => message.role === "system" && message.content.includes("evidence.json")), true);
    assert.equal(result.messages.some((message) => message.role === "system" && message.content.includes("website/index.html")), true);
    assert.equal(result.messages.some((message) => message.role === "system" && message.content.includes("generated-webpage/index.html")), false);
  });

  it("adds a file mutation output contract for coding tasks that must write files", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "Update README.md and openspec/spec.md with bilingual guidance",
      availableTools: [
        capability("core.file.read"),
        capability("core.file.write", "write"),
        capability("core.file.edit", "write"),
        capability("core.shell.run", "write")
      ]
    }));

    const contract = result.messages.find((message) => message.role === "system" && message.content.includes("File mutation output contract:"));
    assert.ok(contract);
    assert.equal(contract.content.includes("text-only answer is incomplete"), true);
    assert.equal(contract.content.includes("core_file_write"), true);
    assert.equal(result.messages.at(-1)?.content, "Update README.md and openspec/spec.md with bilingual guidance");
  });

  it("can assemble with tool projection none without exposing model tools", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "Return only a JSON command plan",
      toolPolicy: "none",
      availableTools: [
        capability("core.file.read"),
        capability("core.file.write", "write"),
        capability("core.shell.run", "process")
      ]
    }));

    assert.equal(result.toolPlan.policy, "none");
    assert.equal(result.toolPlan.visibleToolCount, 0);
    assert.equal(result.toolPlan.excludedToolCount, 3);
    assert.deepEqual(result.toolPlan.visibleTools, []);
  });

  it("weaves self-repair sections without mutating the exact user prompt", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "fix failing test",
      selfRepair: selfRepairOutcome()
    }));

    assert.equal(result.status, "assembled");
    assert.equal(result.messages.at(-1)?.role, "user");
    assert.equal(result.messages.at(-1)?.content, "fix failing test");
    assert.equal(result.sections.some((section) => section.kind === "repair.diagnostics" && section.included), true);
    assert.equal(result.sections.some((section) => section.kind === "repair.verification" && section.included), true);
    assert.deepEqual(
      result.sections.filter((section) => section.source === "self-repair" && section.included).map((section) => section.id),
      [
        "section.self-repair-operating-rules",
        "section.self-repair-failure-evidence",
        "section.self-repair-attempts",
        "section.self-repair-verification"
      ]
    );
    assert.equal(result.messages.some((message) => message.role === "system" && message.content.includes("Self-repair operating rules:")), true);
    assert.equal(result.messages.some((message) => message.role === "system" && message.content.includes("TEST_FAILED")), true);
    assert.equal(result.messages.some((message) => message.role === "system" && message.content.includes("Evidence fingerprints: repair:h1")), true);
    assert.equal(result.messages.some((message) => message.role === "system" && message.content.includes("Allowed actions: model-feedback")), true);
    assert.equal(result.messages.some((message) => message.role === "system" && message.content.includes("Output digest: sha256:prompt")), true);
  });

  it("records self-repair prompt budget exclusions with replayable fingerprints", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "fix failing test",
      hardLimitTokens: 65,
      selfRepair: selfRepairOutcome()
    }));
    const excluded = result.budget.exclusions.filter((section) => section.source === "self-repair");

    assert.equal(result.budget.status, "degraded");
    assert.equal(excluded.length > 0, true);
    assert.equal(excluded.every((section) => section.exclusionReason === "budget-exceeded"), true);
    assert.equal(excluded.every((section) => typeof section.evidenceFingerprint === "string" && section.evidenceFingerprint.length > 0), true);
  });

  it("adds mode, phase, budget, verifier, and reasoning sections before evidence sections", async () => {
    const assembler = createDefaultPromptAssembler();
    const phasePlan = agentPhasePlan();
    const result = await assembler.assemble(input({
      prompt: "生成 website 到 @website 目录",
      mode: "webpage-generation",
      evidenceFirst: evidenceFirstContext(),
      phasePlan,
      reasoningEffortMapping: reasoningMapping()
    }));

    const providerIds = result.sections
      .filter((section) => section.included && section.providerId !== "core.user-prompt")
      .map((section) => section.providerId);
    assert.deepEqual(providerIds.slice(0, 6), [
      "core.mode-context",
      "core.phase-plan",
      "core.loop-budget",
      "core.evidence-first-operating-rules",
      "core.verifier-expectations",
      "core.reasoning-effort-policy"
    ]);
    assert.equal(result.messages.some((message) => message.content.includes("External orchestration budgets:")), true);
    assert.equal(result.messages.some((message) => message.content.includes("Requested effort: xhigh")), true);
    assert.equal(result.messages.at(-1)?.content, "生成 website 到 @website 目录");
  });

  it("renders self-contained work orders and rejects lazy delegation", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "worker task",
      phasePlan: agentPhasePlan(),
      workOrder: workOrder()
    }));
    const lazy = await assembler.assemble(input({
      prompt: "worker task",
      phasePlan: agentPhasePlan(),
      workOrder: workOrder({ taskSummary: "continue from prior findings" })
    }));

    assert.equal(result.messages.some((message) => message.content.includes("Structured worker work order:")), true);
    assert.equal(result.messages.some((message) => message.content.includes("Original user goal: Build a product page")), true);
    assert.equal(lazy.diagnostics.some((diagnostic) => diagnostic.code === "PROMPT_LAZY_DELEGATION_REJECTED"), true);
  });

  it("records budget exclusions", async () => {
    const assembler = createDefaultPromptAssembler({
      providers: [
        providerRegistration("required", 100, "required text", true),
        providerRegistration("optional", 90, "one two three four five six seven eight nine ten")
      ]
    });
    const result = await assembler.assemble(input({ prompt: "budget", hardLimitTokens: 4 }));

    assert.equal(result.budget.status, "degraded");
    assert.equal(result.budget.excludedSectionCount, 1);
    assert.equal(result.budget.exclusions[0]?.exclusionReason, "budget-exceeded");
  });

  it("deduplicates repeated evidence fingerprints", async () => {
    const assembler = createDefaultPromptAssembler({
      providers: [
        providerRegistration("duplicate-a", 100, "same content"),
        providerRegistration("duplicate-b", 90, "same content")
      ]
    });
    const result = await assembler.assemble(input({ prompt: "dedupe" }));

    assert.equal(result.budget.includedSectionCount, 1);
    assert.equal(result.budget.exclusions[0]?.exclusionReason, "duplicate-fingerprint");
  });

  it("replays matching assembly and reports first drift", async () => {
    const assembler = createDefaultPromptAssembler();
    const first = await assembler.assemble(input({ prompt: "stable" }));
    const second = await assembler.assemble(input({ prompt: "stable" }));
    const third = await assembler.assemble(input({ prompt: "changed" }));

    assert.equal(replayPromptAssembly(first, second).status, "matched");
    const drift = replayPromptAssembly(first, third);
    assert.equal(drift.status, "drifted");
    assert.ok(drift.firstDrift);
  });
});

function providerRegistration(id: string, priority: number, content: string, required = false): PromptSectionProviderRegistration {
  return {
    id,
    version: "1.0.0",
    kind: "context.semantic-recall",
    source: "zvec",
    priority,
    budgetClass: required ? "required" : "optional",
    trust: "semantic",
    required,
    compatibility: { schemaVersion: "1.0.0" },
    provide() {
      const section: PromptSection = {
        id: `section.${id}`,
        providerId: id,
        kind: "context.semantic-recall",
        source: "zvec",
        role: "system",
        content,
        priority,
        budgetClass: required ? "required" : "optional",
        trust: "semantic",
        required,
        estimatedTokens: content.split(/\s+/).length,
        evidenceFingerprint: content,
        provenance: {},
        redaction: { class: "internal", fields: ["content"] },
        compatibility: { schemaVersion: "1.0.0" }
      };
      return [section];
    }
  };
}

function input(options: {
  readonly prompt: string;
  readonly contextContent?: string;
  readonly projectionNodes?: readonly NonNullable<PromptAssemblyInput["contextProjection"]>["selectedNodes"][number][];
  readonly hardLimitTokens?: number;
  readonly mode?: PromptAssemblyInput["mode"];
  readonly evidenceFirst?: EvidenceFirstRuntimeContext;
  readonly selfRepair?: SelfRepairOutcomeSummary;
  readonly phasePlan?: AgentPhasePlan;
  readonly workOrder?: AgentWorkOrder;
  readonly reasoningEffortMapping?: AgentReasoningEffortMapping;
  readonly availableTools?: readonly CapabilityManifest[];
  readonly toolPolicy?: PromptAssemblyInput["toolPolicy"];
  readonly projectRules?: readonly AgentLoopProjectRuleEvidence[];
  readonly contextPipelineManifest?: ContextPipelineManifest;
  readonly taskDecision?: TaskDecisionRequest;
}): PromptAssemblyInput {
  const selectedNodes = options.projectionNodes ?? (options.contextContent ? [
    projectionNode("context-node-1", "memory-ref", "memory", options.contextContent, { memoryId: "memory-1", scope: "session" })
  ] : []);
  return {
    schemaVersion: "1.0.0",
    sessionId: asId<"session">("session-prompt-assembly"),
    turnId: asId<"turn">("turn-prompt-assembly"),
    prompt: options.prompt,
    mode: options.mode ?? "coding",
    caller: "test",
    workspaceRoot: "/workspace",
    profile: {
      id: asId<"modelProfile">("profile-test"),
      providerId: asId<"modelProvider">("provider-test"),
      model: "test-model"
    },
    trace: {
      traceId: asId<"trace">("trace-prompt-assembly"),
      spanId: asId<"span">("span-prompt-assembly"),
      correlationId: asId<"correlation">("corr-prompt-assembly")
    },
    history: [{ role: "user", content: options.prompt }],
    ...(options.projectRules ? { projectRules: options.projectRules } : {}),
    ...(options.contextPipelineManifest ? { contextPipelineManifest: options.contextPipelineManifest } : {}),
    ...(options.taskDecision ? { taskDecision: options.taskDecision } : {}),
    ...(options.evidenceFirst ? { evidenceFirst: options.evidenceFirst } : {}),
    ...(options.selfRepair ? { selfRepair: options.selfRepair } : {}),
    ...(options.phasePlan ? {
      interactionMode: options.phasePlan.interactionMode,
      agentMode: options.phasePlan.agentMode,
      phasePlan: options.phasePlan
    } : {}),
    ...(options.workOrder ? { workOrder: options.workOrder } : {}),
    ...(options.reasoningEffortMapping ? { reasoningEffortMapping: options.reasoningEffortMapping } : {}),
    ...(selectedNodes.length > 0 ? {
      contextProjection: {
        schemaVersion: "1.0.0",
        status: "completed",
        sessionId: asId<"session">("session-prompt-assembly"),
        prompt: options.prompt,
        selectedNodes,
        excludedNodes: [],
        estimatedTokens: selectedNodes.reduce((sum, node) => sum + node.estimatedTokens, 0),
        budget: {
          status: "allowed",
          hardLimitTokens: 128,
          reservedOutputTokens: 0,
          selectedTokens: selectedNodes.reduce((sum, node) => sum + node.estimatedTokens, 0),
          excludedTokens: 0,
          reason: "within-budget"
        },
        redaction: { selected: 1, redacted: 0, excluded: 0, classes: ["internal"], secretLikeBlocked: 0 },
        cache: { namespace: "test", key: "test", hit: false, dependencyFingerprints: selectedNodes.flatMap((node) => node.dependencyFingerprints) },
        ordering: { strategy: "priority-recency-stable", tieBreak: ["priority"] },
        replayFingerprint: "projection-1"
      }
    } : {}),
    availableTools: options.availableTools ?? [],
    toolPolicy: options.toolPolicy ?? "all",
    budget: { hardLimitTokens: options.hardLimitTokens ?? 1024, reservedOutputTokens: 0 },
    compatibility: { schemaVersion: "1.0.0" }
  };
}

function taskDecisionRequest(): TaskDecisionRequest {
  return {
    schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
    requestId: "task-decision-request:prompt-assembly",
    brief: {
      schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
      briefId: "task-brief:prompt-assembly",
      rawInput: "继续",
      normalizedIntent: "continue active task",
      intentKind: "coding",
      confidence: 0.8,
      contextRequirements: ["active-task", "project-rules"],
      assumptions: ["Continue the active task if present."],
      missingInfo: [],
      needsUserConfirmation: false,
      compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
      redaction: { class: "internal", fields: ["rawInput"] }
    },
    evidenceRefs: ["ref:project-rules", "ref:active-task"],
    constraints: ["Use prompt assembly for model-bound decisions."],
    allowedTools: ["workspace.read", "process.check"],
    riskLevel: "medium",
    candidateProfiles: ["coding/general.v1"],
    acceptanceDraft: [{
      criterionId: "criterion:proof",
      description: "Collect proof evidence before delivery.",
      required: true,
      evidenceRefs: ["ref:proof"]
    }],
    outputSchema: { kind: "TaskDecisionEnvelope" },
    compatibility: TASK_DELIVERY_FLOW_COMPATIBILITY,
    redaction: { class: "internal", fields: ["brief.rawInput"] }
  };
}

function pipelineManifest(): ContextPipelineManifest {
  const sessionId = asId<"session">("session-prompt-assembly");
  const turnId = asId<"turn">("turn-prompt-assembly");
  return {
    schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION,
    manifestId: "context-pipeline:manifest-test",
    sessionId,
    turnId,
    layers: [
      { id: "kernel", order: 0, blockIds: ["block-kernel"], blockHashes: ["hash-kernel"], layerHash: "layer-kernel", prefixHash: "prefix-kernel", estimatedTokens: 2 },
      { id: "project", order: 1, blockIds: ["block-project"], blockHashes: ["hash-project"], layerHash: "layer-project", prefixHash: "prefix-project", estimatedTokens: 2 },
      { id: "session", order: 2, blockIds: ["block-session"], blockHashes: ["hash-session"], layerHash: "layer-session", prefixHash: "prefix-session", estimatedTokens: 2 },
      { id: "current-turn", order: 3, blockIds: ["block-current"], blockHashes: ["hash-current"], layerHash: "layer-current", prefixHash: "prefix-current", estimatedTokens: 3 }
    ],
    blocks: [
      pipelineBlock("block-kernel", "kernel", 0, "Kernel block"),
      pipelineBlock("block-project", "project", 1, "Project block"),
      pipelineBlock("block-session", "session", 2, "Session block"),
      pipelineBlock("block-current", "current-turn", 3, "Current turn block")
    ],
    excludedBlocks: [],
    prefixHashes: [
      { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION, id: "prefix:kernel", layer: "kernel", order: 0, blockIds: ["block-kernel"], blockHashes: ["hash-kernel"], layerHash: "layer-kernel", prefixHash: "prefix-kernel", estimatedTokens: 2, redaction: { class: "internal" }, compatibility: { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION } },
      { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION, id: "prefix:project", layer: "project", order: 1, blockIds: ["block-project"], blockHashes: ["hash-project"], layerHash: "layer-project", prefixHash: "prefix-project", estimatedTokens: 2, redaction: { class: "internal" }, compatibility: { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION } },
      { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION, id: "prefix:session", layer: "session", order: 2, blockIds: ["block-session"], blockHashes: ["hash-session"], layerHash: "layer-session", prefixHash: "prefix-session", estimatedTokens: 2, redaction: { class: "internal" }, compatibility: { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION } },
      { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION, id: "prefix:current-turn", layer: "current-turn", order: 3, blockIds: ["block-current"], blockHashes: ["hash-current"], layerHash: "layer-current", prefixHash: "prefix-current", estimatedTokens: 3, redaction: { class: "internal" }, compatibility: { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION } }
    ],
    tokenTotals: { selectedTokens: 9, excludedTokens: 0, hardLimitTokens: 128 },
    cacheHintSummary: { stable: 3, ephemeral: 1, noStore: 0, ttlBound: 0 },
    pipelineFingerprint: "pipeline:test",
    diagnostics: [],
    redaction: { class: "internal", fields: ["blocks.content"] },
    compatibility: { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION }
  };
}

function pipelineBlock(id: string, layer: ContextPipelineManifest["blocks"][number]["layer"], order: number, content: string): ContextPipelineManifest["blocks"][number] {
  return {
    schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION,
    id,
    layer,
    order,
    kind: layer === "current-turn" ? "user" : "summary",
    source: layer === "current-turn" ? "user" : "system",
    hash: `hash-${id}`,
    content,
    estimatedTokens: content.split(/\s+/).length,
    dependencyFingerprints: [`dep:${id}`],
    provenance: { fixture: true },
    cacheHint: { policy: layer === "current-turn" ? "ephemeral" : "stable" },
    replay: { fingerprint: `replay:${id}` },
    redaction: { class: "internal", fields: ["content"] },
    compatibility: { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION }
  };
}

function projectRule(path: string, content: string): AgentLoopProjectRuleEvidence {
  return {
    schemaVersion: "1.0.0",
    source: "agents-md",
    status: "included",
    priority: 100,
    path,
    content,
    bytes: content.length,
    fingerprint: "sha256:project-rule",
    diagnostics: [],
    redaction: { class: "internal", fields: ["content"] }
  };
}

function capability(id: string, sideEffect: CapabilityManifest["sideEffect"] = "read"): CapabilityManifest {
  return {
    id: asId<"capability">(id),
    name: id,
    source: "test",
    version: "1.0.0",
    trust: "trusted",
    sideEffect,
    permissions: [],
    inputSchema: {},
    outputSchema: {},
    enabled: true
  };
}

function selfRepairOutcome(): SelfRepairOutcomeSummary {
  const trace = {
    traceId: asId<"trace">("trace-self-repair-prompt"),
    spanId: asId<"span">("span-self-repair-prompt"),
    correlationId: asId<"correlation">("corr-self-repair-prompt")
  };
  const classification: SelfRepairFailureClassification = {
    schemaVersion: SELF_REPAIR_SCHEMA_VERSION,
    classificationId: "repair-classification:prompt",
    failureSource: "build-test-error" as const,
    status: "classified" as const,
    repairability: "repairable" as const,
    safetyClass: "safe-write" as const,
    affectedScope: "test" as const,
    severity: "error" as const,
    evidenceFingerprints: ["repair:h1"],
    diagnostics: [{ code: "TEST_FAILED", message: "targeted test failed", retryable: true, redaction: { class: "internal" as const } }],
    trace,
    compatibility: SELF_REPAIR_COMPATIBILITY,
    redaction: { class: "internal" as const, fields: ["diagnostics.details"] }
  };
  const verification: SelfRepairVerificationSummary = {
    schemaVersion: SELF_REPAIR_SCHEMA_VERSION,
    verificationId: "repair-verification:prompt",
    command: "npm test -- target",
    status: "skipped" as const,
    decision: "escalate" as const,
    outputDigest: "sha256:prompt",
    compatibility: SELF_REPAIR_COMPATIBILITY,
    redaction: { class: "internal" as const, fields: ["command"] }
  };
  const attempt: SelfRepairAttemptRecord = {
    schemaVersion: SELF_REPAIR_SCHEMA_VERSION,
    attemptId: "repair-attempt:prompt",
    planId: "repair-plan:prompt",
    status: "completed" as const,
    actionType: "model-feedback" as const,
    toolIds: ["agent.self-repair"],
    touchedFiles: [],
    materialChangeFingerprint: "model-feedback",
    diagnostics: [],
    verification: [verification],
    trace,
    compatibility: SELF_REPAIR_COMPATIBILITY,
    redaction: { class: "internal" as const, fields: ["diagnostics.details", "verification.stdoutPreview"] }
  };
  return {
    schemaVersion: SELF_REPAIR_SCHEMA_VERSION,
    enabled: true,
    activated: true,
    attemptCount: 1,
    successCount: 1,
    repeatedNoopCount: 0,
    stopReason: "completed",
    classifications: [classification],
    attempts: [attempt],
    verification: [verification],
    compatibility: SELF_REPAIR_COMPATIBILITY,
    redaction: { class: "internal", fields: ["classifications.diagnostics"] }
  };
}

function agentPhasePlan(): AgentPhasePlan {
  const budget: AgentLoopBudget = {
    schemaVersion: AGENT_MODE_SCHEMA_VERSION,
    kind: "verification",
    requested: 1,
    allowed: 1,
    consumed: 0,
    remaining: 1,
    policy: { source: "test" },
    redaction: { class: "internal" },
    compatibility: AGENT_MODE_COMPATIBILITY
  };
  return {
    schemaVersion: AGENT_MODE_SCHEMA_VERSION,
    planId: "agent-phase-plan:test",
    sessionId: asId<"session">("session-prompt-assembly"),
    turnId: asId<"turn">("turn-prompt-assembly"),
    interactionMode: "headless",
    agentMode: "coordinator",
    phases: [
      {
        schemaVersion: AGENT_MODE_SCHEMA_VERSION,
        phase: "evidence",
        status: "completed",
        required: true,
        mode: "evidence",
        budgets: [],
        diagnostics: [],
        redaction: { class: "internal" },
        compatibility: AGENT_MODE_COMPATIBILITY
      },
      {
        schemaVersion: AGENT_MODE_SCHEMA_VERSION,
        phase: "verify",
        status: "required",
        required: true,
        mode: "verifier",
        budgets: [budget],
        diagnostics: [],
        redaction: { class: "internal" },
        compatibility: AGENT_MODE_COMPATIBILITY
      }
    ],
    budgets: [budget],
    reason: "test phase plan",
    diagnostics: [],
    redaction: { class: "internal" },
    compatibility: AGENT_MODE_COMPATIBILITY
  };
}

function workOrder(overrides: Partial<AgentWorkOrder> = {}): AgentWorkOrder {
  return {
    schemaVersion: AGENT_MODE_SCHEMA_VERSION,
    workOrderId: "work-order:test",
    parentSessionId: asId<"session">("session-parent"),
    parentAgentId: asId<"agent">("agent-parent"),
    targetAgentId: asId<"agent">("agent-worker"),
    mode: "worker",
    purpose: "Verify generated website files",
    originalUserGoal: "Build a product page",
    taskSummary: "Inspect website/index.html and evidence.json.",
    evidenceIds: ["evidence:package-json"],
    targets: [{ kind: "file", id: "file:website/index.html", path: "website/index.html" }],
    allowedTools: ["core.file.read", "core.test.run"],
    permissionScope: { toolProjection: "read-only" },
    doneCriteria: ["Report pass/fail with evidence ids."],
    verificationExpectations: ["Check generated artifact evidence."],
    redaction: { class: "internal" },
    compatibility: AGENT_MODE_COMPATIBILITY,
    ...overrides
  };
}

function reasoningMapping(): AgentReasoningEffortMapping {
  return {
    schemaVersion: AGENT_MODE_SCHEMA_VERSION,
    requestedEffort: "xhigh",
    providerEffort: "max",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    mapped: true,
    supported: true,
    diagnostics: [],
    redaction: { class: "internal" },
    compatibility: AGENT_MODE_COMPATIBILITY
  };
}

function evidenceFirstContext(): EvidenceFirstRuntimeContext {
  const classification: EvidenceTaskClassification = {
    schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
    classificationId: "evidence-classification:test",
    sensitivity: "fact-sensitive" as const,
    intents: ["product", "generated-artifact"] as const,
    factClasses: ["package", "command", "product-copy"] as const,
    evidenceRequired: true,
    reason: "test",
    trace: {},
    compatibility: EVIDENCE_FIRST_COMPATIBILITY,
    redaction: { class: "internal" as const, fields: ["reason"] }
  };
  const plan: NonNullable<EvidenceFirstRuntimeContext["plan"]> = {
    schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
    planId: "evidence-plan:test",
    classificationId: classification.classificationId,
    requiredFactClasses: classification.factClasses,
    candidateSourceGroups: [{
      sourceGroup: "package-metadata" as const,
      required: true,
      factClasses: ["package", "executable"] as const,
      minimumItemCount: 1
    }],
    minimumSourceCoverage: 1,
    freshnessPolicy: "local-current-worktree",
    redactionPolicy: "bounded-previews-and-fingerprints",
    stopConditions: ["unsupported strict command"],
    trace: {},
    compatibility: EVIDENCE_FIRST_COMPATIBILITY,
    redaction: { class: "internal" as const, fields: ["stopConditions"] }
  };
  const evidenceItem: EvidenceItem = {
    schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
    evidenceId: "evidence:package-json",
    sourceGroup: "package-metadata" as const,
    sourcePath: "src/apps/cli/package.json",
    sourceLabel: "CLI package metadata",
    factClasses: ["package", "executable"] as const,
    preview: "name deepseek-agent-cli, bin deepseek",
    fingerprint: "fnv1a:test",
    freshness: { status: "current" as const },
    trace: {},
    compatibility: EVIDENCE_FIRST_COMPATIBILITY,
    redaction: { class: "internal" as const, fields: ["preview"] }
  };
  const coverage: EvidenceSourceCoverage = {
    schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
    sourceGroup: "package-metadata" as const,
    covered: true,
    itemCount: 1,
    factClasses: ["package", "executable"] as const,
    fingerprints: ["fnv1a:test"],
    missingFactClasses: [],
    compatibility: EVIDENCE_FIRST_COMPATIBILITY,
    redaction: { class: "internal" as const, fields: ["fingerprints"] }
  };
  return {
    schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
    classification,
    plan,
    selectedEvidence: [evidenceItem],
    sourceCoverage: [coverage],
    summary: {
      schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
      summaryId: "evidence-summary:test",
      classification,
      plan,
      manifestStatus: "missing",
      evidenceItemCount: 1,
      sourceCoverageRate: 1,
      claimGroundingRate: 0,
      unsupportedClaimCount: 0,
      assumptionCount: 0,
      hallucinatedCommandCount: 0,
      trace: {},
      compatibility: EVIDENCE_FIRST_COMPATIBILITY,
      redaction: { class: "internal", fields: ["classification.reason"] }
    },
    compatibility: EVIDENCE_FIRST_COMPATIBILITY,
    redaction: { class: "internal", fields: ["selectedEvidence.preview"] }
  };
}

function projectionNode(
  id: string,
  kind: NonNullable<PromptAssemblyInput["contextProjection"]>["selectedNodes"][number]["kind"],
  source: NonNullable<PromptAssemblyInput["contextProjection"]>["selectedNodes"][number]["source"],
  content: string,
  provenance: JsonObject
): NonNullable<PromptAssemblyInput["contextProjection"]>["selectedNodes"][number] {
  return {
    id: asId<"contextNode">(id),
    kind,
    source,
    content,
    estimatedTokens: Math.max(1, content.split(/\s+/).length),
    priority: 10,
    redaction: { class: "internal" },
    provenance,
    dependencyFingerprints: [id]
  };
}
