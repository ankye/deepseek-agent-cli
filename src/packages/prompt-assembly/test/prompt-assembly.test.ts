import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentLoopBudget, AgentLoopProjectRuleEvidence, AgentPhasePlan, AgentReasoningEffortMapping, AgentWorkOrder, CapabilityManifest, ContextPipelineManifest, EvidenceFirstRuntimeContext, EvidenceItem, EvidenceSourceCoverage, EvidenceTaskClassification, JsonObject, ModelChatMessage, PromptAssemblyInput, PromptSchedulingNextAction, PromptSection, SelfRepairAttemptRecord, SelfRepairFailureClassification, SelfRepairOutcomeSummary, SelfRepairVerificationSummary, TaskDecisionRequest, ToolDecisionRecord } from "@deepseek/platform-contracts";
import { AGENT_MODE_COMPATIBILITY, AGENT_MODE_SCHEMA_VERSION, CONTEXT_PIPELINE_SCHEMA_VERSION, EVIDENCE_FIRST_COMPATIBILITY, EVIDENCE_FIRST_SCHEMA_VERSION, SELF_REPAIR_COMPATIBILITY, SELF_REPAIR_SCHEMA_VERSION, TASK_DELIVERY_FLOW_COMPATIBILITY, TASK_DELIVERY_FLOW_SCHEMA_VERSION, asId } from "@deepseek/platform-contracts";
import { coreToolManifests } from "@deepseek/core-coding-tools";
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
    assert.equal(pipelineText.includes("Current turn block"), false);
    assert.equal(result.trace.pipeline?.pipelineFingerprint.startsWith("pipeline:"), true);
    assert.equal(result.trace.pipeline?.layerPrefixHashes.includes("project:prefix-project"), true);
    assert.equal((result.trace.pipeline?.providerPrefixMessageCount ?? 0) > 0, true);
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
    assert.equal(result.trace.pipeline?.pipelineFingerprint.startsWith("pipeline:"), true);
    assert.equal(result.trace.pipeline?.layerPrefixHashes.includes("project:prefix-project"), true);
    assert.equal((result.trace.pipeline?.providerPrefixMessageCount ?? 0) > 0, true);
    assert.equal(typeof decisionSection.evidenceFingerprint, "string");
    assert.equal(decisionSection.evidenceFingerprint.length > 0, true);
    assert.equal(result.messages.at(-1)?.content, "继续");
  });

  it("keeps stable runtime framework sections in the explicit provider prefix", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "fix issue",
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan(),
      evidenceFirst: evidenceFirstContext(),
      reasoningEffortMapping: reasoningMapping(),
      availableTools: [capability("core.file.read"), capability("core.shell.run", "process")]
    }));
    const modeContext = result.messages.find((message) => message.content.includes("Runtime mode context:"));
    const phasePlan = result.messages.find((message) => message.content.includes("Agent phase plan:"));
    const toolPolicy = result.messages.find((message) => message.content.includes("Tool visibility policy:"));

    assert.equal(modeContext?.cacheHint?.policy, "stable");
    assert.equal(phasePlan?.cacheHint?.policy, "stable");
    assert.equal(toolPolicy?.cacheHint?.policy, "ephemeral");
    assert.equal(result.trace.pipeline?.providerPrefixMessageCount, result.messages.findIndex((message) => message.cacheHint?.policy !== "stable"));
    assert.equal(result.trace.pipeline?.cacheHintSummary.stable, result.trace.pipeline?.providerPrefixMessageCount);
    assert.equal((result.trace.pipeline?.providerPrefixTokenEstimate ?? 0) > 300, true);
  });

  it("keeps dynamic tool projection guidance out of the provider stable prefix", async () => {
    const assembler = createDefaultPromptAssembler();
    const common = {
      prompt: "fix issue",
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan(),
      reasoningEffortMapping: reasoningMapping()
    };
    const readStage = await assembler.assemble(input({
      ...common,
      availableTools: [capability("core.file.read"), capability("core.workspace.glob")]
    }));
    const editStage = await assembler.assemble(input({
      ...common,
      availableTools: [capability("core.file.edit", "write"), capability("core.test.run", "process")]
    }));
    const readToolPolicyIndex = readStage.messages.findIndex((message) => message.content.includes("Tool visibility policy:"));
    const editToolPolicyIndex = editStage.messages.findIndex((message) => message.content.includes("Tool visibility policy:"));

    assert.equal(readStage.trace.pipeline?.providerPrefixFingerprint, editStage.trace.pipeline?.providerPrefixFingerprint);
    assert.equal(readToolPolicyIndex >= (readStage.trace.pipeline?.providerPrefixMessageCount ?? 0), true);
    assert.equal(editToolPolicyIndex >= (editStage.trace.pipeline?.providerPrefixMessageCount ?? 0), true);
    assert.notEqual(readStage.trace.replay.toolPlanFingerprint, editStage.trace.replay.toolPlanFingerprint);
  });

  it("keeps dynamic file mutation output contracts out of the provider stable prefix", async () => {
    const assembler = createDefaultPromptAssembler();
    const common = {
      prompt: "Update README.md and openspec/spec.md with bilingual guidance",
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan()
    };
    const writeStage = await assembler.assemble(input({
      ...common,
      availableTools: [capability("core.file.read"), capability("core.file.write", "write")]
    }));
    const editStage = await assembler.assemble(input({
      ...common,
      availableTools: [capability("core.file.read"), capability("core.file.edit", "write"), capability("core.patch.apply", "write")]
    }));
    const writeContract = writeStage.messages.find((message) => message.content.includes("File mutation output contract:"));
    const editContract = editStage.messages.find((message) => message.content.includes("File mutation output contract:"));
    const writeContractIndex = writeStage.messages.findIndex((message) => message.content.includes("File mutation output contract:"));
    const editContractIndex = editStage.messages.findIndex((message) => message.content.includes("File mutation output contract:"));

    assert.equal(writeStage.trace.pipeline?.providerPrefixFingerprint, editStage.trace.pipeline?.providerPrefixFingerprint);
    assert.equal(writeContract?.cacheHint?.policy, "ephemeral");
    assert.equal(editContract?.cacheHint?.policy, "ephemeral");
    assert.equal(writeContractIndex >= (writeStage.trace.pipeline?.providerPrefixMessageCount ?? 0), true);
    assert.equal(editContractIndex >= (editStage.trace.pipeline?.providerPrefixMessageCount ?? 0), true);
    assert.notEqual(writeContract?.content, editContract?.content);
  });

  it("keeps task intent and profile contracts stable across tool projection changes", async () => {
    const assembler = createDefaultPromptAssembler();
    const common = {
      prompt: "Resolve SWE-bench instance demo__repo-1.",
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan(),
      profilePolicy: profileWorkflowPolicy()
    };
    const readOnly = await assembler.assemble(input({
      ...common,
      toolPolicy: "read-only",
      availableTools: [capability("core.file.read", "read")]
    }));
    const safeAll = await assembler.assemble(input({
      ...common,
      toolPolicy: "safe-all",
      availableTools: [
        capability("core.file.read", "read"),
        capability("core.swe.bench.run", "process"),
        capability("core.file.edit", "write")
      ]
    }));
    const readOnlyProfile = readOnly.messages.find((message) => message.content.includes("Agent profile workflow:"));
    const safeAllProfile = safeAll.messages.find((message) => message.content.includes("Agent profile workflow:"));
    const readOnlyIntent = readOnly.messages.find((message) => message.content.includes("Task intent contract:"));
    const safeAllIntent = safeAll.messages.find((message) => message.content.includes("Task intent contract:"));

    assert.equal(readOnly.trace.pipeline?.providerPrefixFingerprint, safeAll.trace.pipeline?.providerPrefixFingerprint);
    assert.equal(readOnlyProfile?.content, safeAllProfile?.content);
    assert.equal(readOnlyIntent?.content, safeAllIntent?.content);
    assert.equal(readOnlyProfile?.content.includes("Model-visible workflow capabilities:"), false);
    assert.equal(readOnlyIntent?.content.includes("Model-visible route capabilities:"), false);
    assert.notEqual(readOnly.trace.replay.toolPlanFingerprint, safeAll.trace.replay.toolPlanFingerprint);
  });

  it("projects every manifest-declared semantic alias into the tool policy guidance", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "inspect tool guidance",
      toolPolicy: "safe-all",
      availableTools: coreToolManifests().filter((manifest) => manifest.projection?.modelVisible !== false)
    }));
    const toolPolicy = result.messages.find((message) => message.content.includes("Tool visibility policy: safe-all"));
    const visibleCapabilityIds = new Set(result.toolPlan.visibleTools.map((tool) => {
      const metadata = tool.metadata;
      return typeof metadata === "object" && metadata !== null ? String((metadata as { capabilityId?: unknown }).capabilityId ?? "") : "";
    }));
    const aliases = coreToolManifests()
      .filter((manifest) => visibleCapabilityIds.has(String(manifest.id)))
      .flatMap((manifest) => stringArray(manifest.projection?.modelAliases));

    assert.ok(toolPolicy);
    assert.equal(aliases.length > 0, true);
    for (const alias of aliases) {
      assert.equal(toolPolicy?.content.includes(`${alias} ->`), true, alias);
    }
  });

  it("keeps tool policy guidance names identical to projected tool schema names", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "inspect tool schema names",
      toolPolicy: "safe-all",
      toolOptIns: ["network"],
      availableTools: coreToolManifests().filter((manifest) => manifest.projection?.modelVisible !== false)
    }));
    const toolPolicy = result.messages.find((message) => message.content.includes("Tool visibility policy: safe-all"));
    const projected = result.toolPlan.visibleTools.map((tool) => {
      const fn = tool.function;
      const metadata = tool.metadata;
      return {
        name: typeof fn === "object" && fn !== null ? String((fn as { name?: unknown }).name ?? "") : "",
        capabilityId: typeof metadata === "object" && metadata !== null ? String((metadata as { capabilityId?: unknown }).capabilityId ?? "") : ""
      };
    });

    assert.ok(toolPolicy);
    assert.equal(projected.length > 0, true);
    for (const tool of projected) {
      assert.equal(tool.name.length > 0, true, tool.capabilityId);
      assert.equal(toolPolicy?.content.includes(`${tool.name} (capability ${tool.capabilityId})`), true, `${tool.name} should match guidance for ${tool.capabilityId}`);
    }
  });

  it("uses provider-safe names that DeepSeek preflight can repair back to capability ids", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "inspect preflight-compatible tool names",
      toolPolicy: "safe-all",
      toolOptIns: ["network"],
      availableTools: coreToolManifests().filter((manifest) => manifest.projection?.modelVisible !== false)
    }));

    assert.equal(result.toolPlan.visibleToolCount > 0, true);
    for (const tool of result.toolPlan.visibleTools) {
      const fn = tool.function;
      const metadata = tool.metadata;
      const name = typeof fn === "object" && fn !== null ? String((fn as { name?: unknown }).name ?? "") : "";
      const capabilityId = typeof metadata === "object" && metadata !== null ? String((metadata as { capabilityId?: unknown }).capabilityId ?? "") : "";

      assert.equal(name, capabilityId.replace(/[^A-Za-z0-9_-]/g, "_"), capabilityId);
    }
  });

  it("projects web fetch only when the host explicitly opts into network tools", async () => {
    const assembler = createDefaultPromptAssembler();
    const webFetch = coreToolManifests().find((manifest) => String(manifest.id) === "core.web.fetch");
    assert.ok(webFetch);

    const defaultProjection = await assembler.assemble(input({
      prompt: "fetch docs",
      toolPolicy: "safe-all",
      availableTools: [webFetch]
    }));
    assert.equal(defaultProjection.toolPlan.visibleToolCount, 0);

    const networkProjection = await assembler.assemble(input({
      prompt: "fetch docs",
      toolPolicy: "safe-all",
      toolOptIns: ["network"],
      availableTools: [webFetch]
    }));
    const toolPolicy = networkProjection.messages.find((message) => message.content.includes("Tool visibility policy: safe-all"));

    assert.equal(networkProjection.toolPlan.visibleToolCount, 1);
    assert.equal(toolPolicy?.content.includes("Tool opt-ins: network."), true);
    assert.equal(toolPolicy?.content.includes("WebFetch -> core_web_fetch"), true);
  });

  it("allows governed test execution but not arbitrary shell execution in read-write tool policy", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "edit and verify",
      toolPolicy: "read-write",
      availableTools: [
        capability("core.file.read", "read"),
        capability("core.file.edit", "write"),
        capability("core.test.run", "process", ["process:test"]),
        capability("core.shell.run", "process", ["process:run"])
      ]
    }));

    const names = result.toolPlan.visibleTools.map((tool) => {
      const fn = tool.function;
      return typeof fn === "object" && fn !== null ? String((fn as { name?: unknown }).name ?? "") : "";
    });
    const toolPolicy = result.messages.find((message) => message.content.includes("Tool visibility policy: read-write"));
    assert.equal(names.includes("core_test_run"), true);
    assert.equal(names.includes("core_shell_run"), false);
    assert.equal(toolPolicy?.content.includes("core_test_run"), true);
    assert.equal(toolPolicy?.content.includes("core_shell_run"), false);
  });

  it("keeps external connector tools hidden from all projection unless host policy opts them in", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "edit and inspect",
      toolPolicy: "safe-all",
      availableTools: [
        capability("core.file.edit", "write"),
        capability("core.test.run", "process", ["process:test"]),
        capability("core.web.search", "network", ["network"]),
        capability("mcp.browser.inspect", "read", ["browser"]),
        capability("provider.image.generate", "network", ["media"])
      ]
    }));

    const names = result.toolPlan.visibleTools.map((tool) => {
      const fn = tool.function;
      return typeof fn === "object" && fn !== null ? String((fn as { name?: unknown }).name ?? "") : "";
    });
    assert.equal(names.includes("core_file_edit"), true);
    assert.equal(names.includes("core_test_run"), true);
    assert.equal(names.includes("core_web_search"), false);
    assert.equal(names.includes("mcp_browser_inspect"), false);
    assert.equal(names.includes("provider_image_generate"), false);
  });

  it("surfaces profile workflow policy as stable orchestration guidance", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "Resolve SWE-bench instance demo__repo-1.",
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan(),
      profilePolicy: profileWorkflowPolicy()
    }));
    const profileSection = result.sections.find((section) => section.providerId === "core.profile-workflow" && section.included);
    const profileMessage = result.messages.find((message) => message.content.includes("Agent profile workflow:"));
    const providerIds = result.sections
      .filter((section) => section.included && section.providerId !== "core.user-prompt")
      .map((section) => section.providerId);

    assert.ok(profileSection);
    assert.equal(profileMessage?.cacheHint?.policy, "stable");
    assert.equal(profileMessage?.content.includes("Role: evaluation-workflow"), true);
    assert.equal(profileMessage?.content.includes("Workflow priority: primary"), true);
    assert.equal(profileMessage?.content.includes("Orchestration mode: staged-capability-workflow"), true);
    assert.equal(profileMessage?.content.includes("Primary orchestration capabilities: core.env.prepare, core.swe.bench.run"), true);
    assert.equal(profileMessage?.content.includes("Required capability families: package.manager, benchmark.run, file.read"), true);
    assert.equal(profileMessage?.content.includes("Capability compiler status: ready"), true);
    assert.equal(profileSection?.provenance?.capabilityCompilerStatus, "ready");
    assert.deepEqual(profileSection?.provenance?.requiredFamilyIds, ["package.manager", "benchmark.run", "file.read"]);
    assert.deepEqual(providerIds.slice(0, 4), [
      "core.mode-context",
      "core.profile-workflow",
      "core.task-intent-contract",
      "core.phase-plan"
    ]);
  });

  it("shows which profile workflow capabilities are actually model-visible", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "Resolve SWE-bench instance demo__repo-1.",
      phasePlan: agentPhasePlan(),
      profilePolicy: profileWorkflowPolicy(),
      toolPolicy: "read-only",
      availableTools: [
        capability("core.file.read", "read"),
        capability("core.swe.bench.run", "process")
      ]
    }));
    const profileMessage = result.messages.find((message) => message.content.includes("Agent profile workflow:"));

    assert.equal(profileMessage?.content.includes("Primary orchestration capabilities: core.env.prepare, core.swe.bench.run, core.file.read"), true);
    assert.equal(profileMessage?.content.includes("Resolved compiler capabilities: core.env.prepare, core.swe.bench.run, core.file.read"), true);
    assert.equal(profileMessage?.content.includes("Model-visible workflow capabilities:"), false);
    assert.equal(profileMessage?.content.includes("Projection-limited workflow capabilities:"), false);
    assert.equal(profileMessage?.content.includes("Unregistered workflow capabilities:"), false);
  });

  it("does not report compiler-resolved workflow capabilities as unregistered when the active projection hides them", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "Fix the fixture and verify it.",
      phasePlan: agentPhasePlan(),
      profilePolicy: {
        ...profileWorkflowPolicy(),
        role: "engineering-agent",
        workflowGraphId: "workflow/engineering.coding.v1",
        workflowCapabilityIds: ["core.file.read", "core.shell.run", "core.file.edit"],
        requiredFamilyIds: ["file.read", "shell.run", "file.edit"],
        capabilityAffordanceCompiler: {
          schemaVersion: "1.0.0",
          compilerId: "cli.profile.capability-affordance.compiler.v1",
          status: "ready",
          profileId: "engineering/coding.v1",
          workflowGraphId: "workflow/engineering.coding.v1",
          requiredFamilyIds: ["file.read", "shell.run", "file.edit"],
          resolvedCapabilityIds: ["core.file.read", "core.shell.run", "core.file.edit"],
          missingCapabilityIds: [],
          projectionStatus: "ready",
          source: "core-coding-tools.catalog",
          redaction: { class: "internal" }
        },
        antiTailoring: false
      },
      toolPolicy: "read-only",
      availableTools: [
        capability("core.file.read", "read")
      ]
    }));
    const profileMessage = result.messages.find((message) => message.content.includes("Agent profile workflow:"));

    assert.equal(profileMessage?.content.includes("Resolved compiler capabilities: core.file.read, core.shell.run, core.file.edit"), true);
    assert.equal(profileMessage?.content.includes("Model-visible workflow capabilities:"), false);
    assert.equal(profileMessage?.content.includes("Projection-limited workflow capabilities:"), false);
    assert.equal(profileMessage?.content.includes("Unregistered workflow capabilities:"), false);
  });

  it("surfaces profile workflow stages as stable orchestration guidance", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "Resolve SWE-bench instance demo__repo-1.",
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan(),
      profilePolicy: profileWorkflowPolicy()
    }));
    const profileMessage = result.messages.find((message) => message.content.includes("Agent profile workflow:"));
    const profileSection = result.sections.find((section) => section.providerId === "core.profile-workflow" && section.included);

    assert.equal(profileMessage?.cacheHint?.policy, "stable");
    assert.equal(profileMessage?.content.includes("Workflow stages:"), true);
    assert.equal(profileMessage?.content.includes("1. understand: Collect repository evidence."), true);
    assert.equal(profileMessage?.content.includes("capabilities=core.env.prepare, core.file.read"), true);
    assert.equal(profileMessage?.content.includes("exit=repository evidence collected"), true);
    assert.deepEqual(profileSection?.provenance?.workflowStageIds, ["understand", "verify"]);
  });

  it("surfaces engineering repair criteria for boundary and negative regression coverage", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "Fix the string normalization bug and verify it.",
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan(),
      profilePolicy: {
        ...profileWorkflowPolicy(),
        profileId: "engineering/coding.v1",
        role: "engineering-agent",
        workflowGraphId: "workflow/engineering.coding.v1",
        workflowCapabilityIds: ["core.file.read", "core.file.edit", "core.test.run", "core.git.diff"],
        requiredFamilyIds: ["file.read", "file.edit", "build.test-lint-typecheck", "git.status-diff"],
        workflowStages: [
          {
            id: "plan",
            objective: "Plan a repository-grounded repair.",
            capabilityIds: ["core.file.read"],
            entryCriteria: ["repository evidence identified"],
            exitCriteria: [
              "regression test plan names the observed failure plus boundary and negative cases implied by the contract"
            ]
          },
          {
            id: "implement",
            objective: "Apply the governed repair.",
            capabilityIds: ["core.file.edit"],
            entryCriteria: ["test plan recorded"],
            exitCriteria: [
              "focused regression coverage materialized before implementation for the observed failure and edge cases"
            ]
          },
          {
            id: "verify",
            objective: "Verify the repair evidence.",
            capabilityIds: ["core.test.run", "core.git.diff"],
            entryCriteria: ["repair applied"],
            exitCriteria: [
              "verification evidence covers happy path, boundary, and negative regression cases before completion"
            ]
          }
        ],
        capabilityAffordanceCompiler: {
          schemaVersion: "1.0.0",
          compilerId: "cli.profile.capability-affordance.compiler.v1",
          status: "ready",
          profileId: "engineering/coding.v1",
          workflowGraphId: "workflow/engineering.coding.v1",
          requiredFamilyIds: ["file.read", "file.edit", "build.test-lint-typecheck", "git.status-diff"],
          resolvedCapabilityIds: ["core.file.read", "core.file.edit", "core.test.run", "core.git.diff"],
          missingCapabilityIds: [],
          projectionStatus: "ready",
          source: "core-coding-tools.catalog",
          redaction: { class: "internal" }
        },
        antiTailoring: false
      }
    }));
    const profileMessage = result.messages.find((message) => message.content.includes("Agent profile workflow:"));

    assert.equal(profileMessage?.cacheHint?.policy, "stable");
    assert.equal(profileMessage?.content.includes("observed failure plus boundary and negative cases implied by the contract"), true);
    assert.equal(profileMessage?.content.includes("observed failure and edge cases"), true);
    assert.equal(profileMessage?.content.includes("happy path, boundary, and negative regression cases"), true);
  });

  it("surfaces dynamic profile workflow run state outside the stable provider prefix", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "Resolve SWE-bench instance demo__repo-1.",
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan(),
      profilePolicy: profileWorkflowPolicyWithRunState()
    }));
    const profileMessage = result.messages.find((message) => message.content.includes("Agent profile workflow:"));
    const stateMessage = result.messages.find((message) => message.content.includes("Agent profile workflow state:"));

    assert.equal(profileMessage?.cacheHint?.policy, "stable");
    assert.equal(stateMessage?.cacheHint?.policy, "ephemeral");
    assert.equal(stateMessage?.content.includes("stage:understand:succeeded refs=ref:workflow-understand-evidence attempts=1"), true);
    assert.equal(stateMessage?.content.includes("stage:verify:ready refs=none attempts=0"), true);
    assert.equal(result.trace.pipeline?.providerPrefixMessageCount, result.messages.filter((message) => message.cacheHint?.policy === "stable" && message.role === "system").length);
  });

  it("surfaces dynamic tool decision board guidance outside the stable provider prefix", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "Read outside workspace again.",
      contextPipelineManifest: pipelineManifest(),
      toolDecisionBoard: toolDecisionBoard()
    }));
    const boardMessage = result.messages.find((message) => message.content.includes("Tool decision board summary:"));
    const boardSection = result.sections.find((section) => section.providerId === "core.tool-decision-board" && section.included);

    assert.equal(boardMessage?.cacheHint?.policy, "ephemeral");
    assert.equal(boardMessage?.content.includes("Repeated rejected intent count: 2"), true);
    assert.equal(boardMessage?.content.includes("preflight.rejected core.file.read -> corrected input or different projected tool"), true);
    assert.equal(boardMessage?.content.includes("Projection evidence:"), true);
    assert.equal(boardMessage?.content.includes("core.file.edit hidden stage-boundary"), true);
    assert.equal(boardMessage?.content.includes("core.test.run unavailable workflow-capability-unregistered"), true);
    assert.deepEqual(boardSection?.provenance?.recommendedNextActions, ["corrected input or different projected tool"]);
    assert.equal(result.trace.pipeline?.providerPrefixMessageCount, result.messages.filter((message) => message.cacheHint?.policy === "stable" && message.role === "system").length);
  });

  it("keeps shared board cache contract stable while dynamic board records stay in the tail", async () => {
    const assembler = createDefaultPromptAssembler();
    const first = await assembler.assemble(input({
      prompt: "Read outside workspace again.",
      contextPipelineManifest: pipelineManifest(),
      toolDecisionBoard: toolDecisionBoard()
    }));
    const dynamicRecord: ToolDecisionRecord = {
      ...toolDecisionBoard().records[0],
      kind: "feedback",
      status: "rejected",
      recordId: "tool-decision:dynamic",
      reasonCode: "stage.repair-requested",
      recommendedNextAction: "return-to-change-stage",
      timestamp: new Date(0).toISOString(),
      metadata: {}
    };
    const secondBoard = {
      ...toolDecisionBoard(),
      boardId: "tool-decision-board:other",
      iteration: 9,
      repeatedRejectedIntentCount: 7,
      recommendedNextActions: ["return-to-change-stage"],
      records: [
        ...toolDecisionBoard().records,
        dynamicRecord
      ]
    };
    const second = await assembler.assemble(input({
      prompt: "Read outside workspace again.",
      contextPipelineManifest: pipelineManifest(),
      toolDecisionBoard: secondBoard
    }));
    const contract = first.messages.find((message) => message.content.includes("Shared board cache contract:"));
    const dynamic = first.messages.find((message) => message.content.includes("Tool decision board summary:"));

    assert.equal(contract?.cacheHint?.policy, "stable");
    assert.equal(contract?.content.includes("stable-prefix partition"), true);
    assert.equal(contract?.content.includes("dynamic-tail partition"), true);
    assert.equal(contract?.content.includes("tool-decision-board:test"), false);
    assert.equal(dynamic?.cacheHint?.policy, "ephemeral");
    assert.equal(first.trace.pipeline?.providerPrefixFingerprint, second.trace.pipeline?.providerPrefixFingerprint);
    assert.equal(first.trace.pipeline?.providerPrefixTokenEstimate, second.trace.pipeline?.providerPrefixTokenEstimate);
  });

  it("bounds provider dynamic history after the stable task prompt", async () => {
    const assembler = createDefaultPromptAssembler();
    const prompt = "Resolve SWE-bench instance demo__repo-1.";
    const history: ModelChatMessage[] = [{ role: "user", content: prompt }];
    for (let index = 0; index < 10; index += 1) {
      const id = `tool-${index}`;
      history.push({
        role: "assistant",
        content: "",
        toolCalls: [{ id, name: "core_file_read", input: { path: `file-${index}.py`, offset: index, limit: 40 } }]
      });
      history.push({
        role: "tool",
        toolCallId: id,
        toolName: "core.file.read",
        content: `tool result ${index}\n${"line\n".repeat(40)}`
      });
    }
    history.push({ role: "user", content: "Use the latest evidence and mutate next.", cacheHint: { policy: "no-store" } });

    const result = await assembler.assemble(input({
      prompt,
      history,
      contextPipelineManifest: pipelineManifest(),
      availableTools: [capability("core.file.read"), capability("core.file.edit", "write")]
    }));
    const stablePromptIndex = result.messages.findIndex((message) => message.role === "user" && message.content === prompt);
    const dynamicTail = result.messages.slice(stablePromptIndex + 1);

    assert.equal(stablePromptIndex >= 0, true);
    assert.equal(dynamicTail.length <= 8, true);
    assert.equal(dynamicTail.some((message) => message.content.includes("tool result 9")), true);
    assert.equal(dynamicTail.some((message) => message.content.includes("tool result 0")), false);
  });

  it("preserves the two latest successful source inspection windows", async () => {
    const assembler = createDefaultPromptAssembler();
    const prompt = "Resolve SWE-bench instance demo__repo-1.";
    const source = (marker: string) => [
      "def target():",
      "    " + "leading context ".repeat(280),
      `    ${marker}`,
      "    " + "trailing context ".repeat(280)
    ].join("\n");
    const history: ModelChatMessage[] = [{ role: "user", content: prompt }];
    for (let index = 1; index <= 3; index += 1) {
      const id = `read-${index}`;
      history.push({
        role: "assistant",
        content: "",
        toolCalls: [{ id, name: "core_file_read", input: { path: `file-${index}.py`, offset: 0, limit: 400 } }]
      });
      history.push({
        role: "tool",
        toolCallId: id,
        toolName: "core.file.read",
        content: source(`TARGET_MARKER_${index}`)
      });
    }

    const result = await assembler.assemble(input({
      prompt,
      history,
      contextPipelineManifest: pipelineManifest(),
      availableTools: [capability("core.file.read"), capability("core.file.edit", "write")]
    }));
    const toolMessages = result.messages.filter((message) => message.role === "tool");
    const first = toolMessages.find((message) => message.toolCallId === "read-1");
    const second = toolMessages.find((message) => message.toolCallId === "read-2");
    const third = toolMessages.find((message) => message.toolCallId === "read-3");

    assert.equal(first?.content.startsWith("compacted source tool result"), true);
    assert.equal(second?.content.startsWith("compacted source tool result"), false);
    assert.equal(third?.content.startsWith("compacted source tool result"), false);
    assert.equal(second?.content.includes("TARGET_MARKER_2"), true);
    assert.equal(third?.content.includes("TARGET_MARKER_3"), true);
  });

  it("surfaces a deterministic task intent contract in the stable provider prefix", async () => {
    const assembler = createDefaultPromptAssembler();
    const first = await assembler.assemble(input({
      prompt: "Resolve SWE-bench instance demo__repo-1.",
      sessionId: "session-one",
      turnId: "turn-one",
      contextPipelineManifest: pipelineManifest({ sessionId: "session-one", turnId: "turn-one" }),
      phasePlan: agentPhasePlan({ planId: "agent-phase-plan:first", sessionId: "session-one", turnId: "turn-one" }),
      profilePolicy: profileWorkflowPolicyWithRunState()
    }));
    const second = await assembler.assemble(input({
      prompt: "Resolve SWE-bench instance demo__repo-1.",
      sessionId: "session-two",
      turnId: "turn-two",
      contextPipelineManifest: pipelineManifest({ sessionId: "session-two", turnId: "turn-two" }),
      phasePlan: agentPhasePlan({ planId: "agent-phase-plan:second", sessionId: "session-two", turnId: "turn-two" }),
      profilePolicy: profileWorkflowPolicyWithRunState({
        taskRunId: "staged:workflow:second",
        verifyAttempts: 2
      })
    }));
    const firstIntent = first.messages.find((message) => message.content.includes("Task intent contract:"));
    const secondIntent = second.messages.find((message) => message.content.includes("Task intent contract:"));
    const stateIndex = first.messages.findIndex((message) => message.content.includes("Agent profile workflow state:"));
    const intentIndex = first.messages.findIndex((message) => message.content.includes("Task intent contract:"));

    assert.ok(firstIntent);
    assert.ok(secondIntent);
    assert.equal(firstIntent.cacheHint?.policy, "stable");
    assert.equal(firstIntent.content, secondIntent.content);
    assert.equal(firstIntent.content.includes("session-one"), false);
    assert.equal(firstIntent.content.includes("turn-one"), false);
    assert.equal(firstIntent.content.includes("staged:workflow"), false);
    assert.equal(firstIntent.content.includes("stage:verify:ready"), false);
    assert.equal(intentIndex >= 0 && stateIndex >= 0 && intentIndex < stateIndex, true);
    assert.equal(first.trace.pipeline?.providerPrefixMessageCount, first.messages.filter((message) => message.cacheHint?.policy === "stable" && message.role === "system").length);
  });

  it("makes ready produce stages prefer mutation-grade progress over repeated inspection", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "Resolve SWE-bench instance demo__repo-1.",
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan(),
      profilePolicy: profileWorkflowPolicyWithProduceRunState()
    }));
    const stateMessage = result.messages.find((message) => message.content.includes("Agent profile workflow state:"));

    assert.equal(stateMessage?.cacheHint?.policy, "ephemeral");
    assert.equal(stateMessage?.content.includes("stage:understand:succeeded"), true);
    assert.equal(stateMessage?.content.includes("stage:change:ready"), true);
    assert.equal(stateMessage?.content.includes("progress=core.file.edit, core.patch.apply"), true);
    assert.equal(stateMessage?.content.includes("required=core.file.edit|core.patch.apply"), true);
    assert.equal(stateMessage?.content.includes("primary=mutation-grade edit/patch or bounded blocker"), true);
    assert.equal(stateMessage?.content.includes("read/search/list-only exploration is supporting evidence, not completion-grade progress"), true);
  });

  it("surfaces gate-enforced next actions in workflow state guidance", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "Resolve SWE-bench instance demo__repo-1.",
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan(),
      profilePolicy: {
        ...profileWorkflowPolicyWithProduceRunState(),
        workflowGateOverride: {
          gate: "SWE_BENCH_SOURCE_INSPECTION_DUPLICATE_GATE",
          requiredNextAction: "source-edit-or-test-or-bounded-blocker",
          rejectedToolName: "core.file.read",
          terminalKind: "swe-bench-source-inspection-duplicate.rejected",
          toolCallId: "call-guidance-duplicate-read-2"
        }
      }
    }));
    const stateMessage = result.messages.find((message) => message.content.includes("Agent profile workflow state:"));

    assert.equal(stateMessage?.cacheHint?.policy, "ephemeral");
    assert.equal(stateMessage?.content.includes("Gate-enforced next action: source-edit-or-test-or-bounded-blocker."), true);
    assert.equal(stateMessage?.content.includes("tools=core.file.edit, core.patch.apply"), true);
    assert.equal(stateMessage?.content.includes("tools=core.file.read, core.search.text"), false);
  });

  it("includes the stable task prompt in provider prefix evidence before growing history", async () => {
    const assembler = createDefaultPromptAssembler();
    const stableTaskPrompt = [
      "Resolve SWE-bench instance astropy__astropy-14365.",
      "Repository: astropy/astropy",
      "Base commit: 7269fa3e33e8d02485a647da91a5a2a60a06af61",
      "",
      "Managed SWE-bench execution profile:",
      "- Work on the checked-out repository.",
      "- Add or update focused regression coverage before implementation.",
      "- Do not manually bypass the governed harness.",
      "- Return control when source edit, test evidence, and patch evidence are ready.",
      "",
      "Problem statement:",
      "QDP command parsing should be case-insensitive. Lowercase and mixed-case READ SERR commands should parse the same as uppercase commands."
    ].join("\n");
    const result = await assembler.assemble(input({
      prompt: stableTaskPrompt,
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan(),
      evidenceFirst: evidenceFirstContext(),
      reasoningEffortMapping: reasoningMapping(),
      availableTools: [capability("core.file.read"), capability("core.shell.run", "process")]
    }));

    assert.equal(result.messages.at(-1)?.role, "user");
    assert.equal(result.messages.at(-1)?.cacheHint?.policy, "stable");
    assert.equal(result.trace.pipeline?.providerPrefixMessageCount, result.messages.findIndex((message) => message.cacheHint?.policy !== "stable"));
    assert.equal(result.trace.pipeline?.cacheHintSummary.stable, result.trace.pipeline?.providerPrefixMessageCount);
    assert.equal(
      (result.trace.pipeline?.providerPrefixTokenEstimate ?? 0) > stableTaskPrompt.split(/\s+/).length,
      true
    );
  });

  it("keeps volatile self-repair sections from truncating later stable provider-prefix sections", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "fix issue",
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan(),
      evidenceFirst: evidenceFirstContext(),
      selfRepair: selfRepairOutcome(),
      reasoningEffortMapping: reasoningMapping(),
      availableTools: [capability("core.file.read"), capability("core.shell.run", "process")]
    }));
    const firstVolatileSystemIndex = result.messages.findIndex((message) => message.role === "system" && message.cacheHint?.policy !== "stable");
    const stableSystemAfterVolatile = result.messages
      .slice(firstVolatileSystemIndex + 1)
      .find((message) => message.role === "system" && message.cacheHint?.policy === "stable");

    assert.equal(firstVolatileSystemIndex >= 0, true);
    assert.equal(stableSystemAfterVolatile, undefined);
    assert.equal(result.messages.some((message) => message.role === "system" && message.content.includes("Self-repair operating rules:")), true);
    assert.equal(result.trace.pipeline?.providerPrefixMessageCount, result.messages.filter((message) => message.role === "system" && message.cacheHint?.policy === "stable").length);
  });

  it("bounds dynamic provider history while preserving recent tool-call pairs", async () => {
    const assembler = createDefaultPromptAssembler();
    const prompt = "Resolve SWE task.";
    const history: ModelChatMessage[] = [{ role: "user", content: prompt }];
    for (let index = 1; index <= 8; index += 1) {
      history.push(
        { role: "assistant", content: "", toolCalls: [{ id: `tool-${index}`, name: "core_file_read", input: { path: `file-${index}.py` } }] },
        { role: "tool", toolCallId: `tool-${index}`, toolName: "core.file.read", content: `tool result ${index}` },
        { role: "assistant", content: `inspection note ${index}` }
      );
    }
    const result = await assembler.assemble(input({
      prompt,
      history,
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan()
    }));
    const dynamicHistory = result.messages.slice(result.messages.findIndex((message) => message.content === prompt) + 1);

    assert.equal(result.messages.find((message) => message.content === prompt)?.cacheHint?.policy, "stable");
    assert.equal(dynamicHistory.length <= 6, true);
    assert.equal(dynamicHistory.some((message) => message.content === "tool result 1"), false);
    assert.equal(dynamicHistory.some((message) => message.content.includes("tool result 8")), true);
    assert.equal(
      dynamicHistory.filter((message) => message.role === "assistant").reduce((count, message) => count + (message.toolCalls?.length ?? 0), 0),
      dynamicHistory.filter((message) => message.role === "tool").length
    );
  });

  it("preserves the middle of the latest bounded source window for mutation decisions", async () => {
    const assembler = createDefaultPromptAssembler();
    const prompt = "Resolve SWE task.";
    const targetContext = "cright[-right.shape[0]:, -right.shape[1]:] = right";
    const sourceWindow = [
      "def _cstack(left, right):",
      "    " + "leading source context ".repeat(30),
      `    ${targetContext}`,
      "    " + "trailing source context ".repeat(30)
    ].join("\n");
    const history: ModelChatMessage[] = [
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "source-window",
          name: "core_file_read",
          input: { path: "astropy/modeling/separable.py", offset: 100, limit: 200 }
        }]
      },
      {
        role: "tool",
        toolCallId: "source-window",
        toolName: "core.file.read",
        content: sourceWindow
      }
    ];

    const result = await assembler.assemble(input({
      prompt,
      history,
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan()
    }));
    const sourceMessage = result.messages.find((message) => message.toolCallId === "source-window");

    assert.equal(sourceWindow.length > 360, true);
    assert.equal(sourceMessage?.content.includes(targetContext), true);
  });

  it("retains the latest successful source inspection pair through mutation retries", async () => {
    const assembler = createDefaultPromptAssembler();
    const prompt = "Resolve SWE task.";
    const targetContext = "cright[-right.shape[0]:, -right.shape[1]:] = right";
    const history: ModelChatMessage[] = [
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "source-window",
          name: "core_file_read",
          input: { path: "astropy/modeling/separable.py", offset: 100, limit: 200 }
        }]
      },
      {
        role: "tool",
        toolCallId: "source-window",
        toolName: "core.file.read",
        content: targetContext
      }
    ];
    for (let index = 1; index <= 3; index += 1) {
      history.push(
        {
          role: "assistant",
          content: "",
          toolCalls: [{
            id: `failed-edit-${index}`,
            name: "core_file_edit",
            input: { path: "astropy/modeling/separable.py", expected: `stale ${index}`, replacement: `replacement ${index}` }
          }]
        },
        {
          role: "tool",
          toolCallId: `failed-edit-${index}`,
          toolName: "core.file.edit",
          content: "EDIT_PRECONDITION_FAILED: expected text was not found."
        },
        {
          role: "user",
          content: `Mutation retry ${index}: use the exact source window already collected.`
        }
      );
    }

    const result = await assembler.assemble(input({
      prompt,
      history,
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan()
    }));
    const dynamicHistory = result.messages.slice(result.messages.findIndex((message) => message.content === prompt) + 1);

    assert.equal(dynamicHistory.length <= 8, true);
    assert.equal(dynamicHistory.some((message) => message.toolCallId === "source-window"), true);
    assert.equal(dynamicHistory.some((message) => message.content.includes(targetContext)), true);
  });

  it("keeps source evidence and the latest failed mutation while tightening provider history", async () => {
    const assembler = createDefaultPromptAssembler();
    const prompt = "Resolve SWE task.";
    const targetContext = "cright[-right.shape[0]:, -right.shape[1]:] = right";
    const history: ModelChatMessage[] = [
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "source-window",
          name: "core_file_read",
          input: { path: "astropy/modeling/separable.py", offset: 100, limit: 120 }
        }]
      },
      {
        role: "tool",
        toolCallId: "source-window",
        toolName: "core.file.read",
        content: targetContext
      },
      { role: "assistant", content: "The source evidence is sufficient for mutation." },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "failed-edit",
          name: "core_file_edit",
          input: { path: "astropy/modeling/separable.py", expected: "stale", replacement: "replacement" }
        }]
      },
      {
        role: "tool",
        toolCallId: "failed-edit",
        toolName: "core.file.edit",
        content: "EDIT_PRECONDITION_FAILED: expected text was not found.\nnearestContext=cright[-right.shape[0]:, -right.shape[1]:] = right"
      },
      {
        role: "user",
        content: "Mutation retry: use the nearestContext from the failed edit and the retained source evidence."
      }
    ];

    const result = await assembler.assemble(input({
      prompt,
      history,
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan()
    }));
    const dynamicHistory = result.messages.slice(result.messages.findIndex((message) => message.content === prompt) + 1);

    assert.equal(dynamicHistory.length <= 6, true);
    assert.equal(dynamicHistory.some((message) => message.toolCallId === "source-window"), true);
    assert.equal(dynamicHistory.some((message) => message.toolCallId === "failed-edit"), true);
    assert.equal(dynamicHistory.some((message) => message.content.includes("Mutation retry:")), true);
    assert.equal(dynamicHistory.some((message) => message.content.includes(targetContext)), true);
  });

  it("bounds append-only provider history for provider prefix cache reuse", async () => {
    const assembler = createDefaultPromptAssembler();
    const prompt = "Resolve SWE task.";
    const history: ModelChatMessage[] = [{ role: "user", content: prompt }];
    for (let index = 1; index <= 10; index += 1) {
      history.push(
        { role: "assistant", content: "", toolCalls: [{ id: `tool-${index}`, name: "core_file_read", input: { path: `file-${index}.py` } }] },
        { role: "tool", toolCallId: `tool-${index}`, toolName: "core.file.read", content: `tool result ${index}` },
        { role: "assistant", content: `analysis ${index}` }
      );
    }
    const result = await assembler.assemble(input({
      prompt,
      history,
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan()
    }));
    const dynamicHistory = result.messages.slice(result.messages.findIndex((message) => message.content === prompt) + 1);

    assert.equal(dynamicHistory.length <= 8, true);
    assert.equal(dynamicHistory.some((message) => message.content === "tool result 1"), false);
    assert.equal(dynamicHistory.some((message) => message.content.includes("tool result 10")), true);
    assert.equal(dynamicHistory.at(-1)?.content, "analysis 10");
  });

  it("compacts older tool results in provider history while preserving the latest tool result", async () => {
    const assembler = createDefaultPromptAssembler();
    const prompt = "Resolve SWE task.";
    const longOutput = Array.from({ length: 160 }, (_, index) => `traceback line ${index}: repeated failure context`).join("\n");
    const history: ModelChatMessage[] = [{ role: "user", content: prompt }];
    for (let index = 1; index <= 5; index += 1) {
      history.push(
        { role: "assistant", content: "", toolCalls: [{ id: `tool-${index}`, name: "core_test_run", input: { command: "pytest", args: [`test_${index}.py`] } }] },
        { role: "tool", toolCallId: `tool-${index}`, toolName: "core.test.run", content: `tool result ${index}\n${longOutput}` },
        { role: "assistant", content: `analysis ${index}` }
      );
    }
    const result = await assembler.assemble(input({
      prompt,
      history,
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan()
    }));
    const dynamicHistory = result.messages.slice(result.messages.findIndex((message) => message.content === prompt) + 1);
    const toolMessages = dynamicHistory.filter((message) => message.role === "tool");
    const dynamicChars = dynamicHistory.reduce((count, message) => count + message.content.length, 0);

    assert.equal(toolMessages.some((message) => message.content.includes("tool result 5")), true);
    assert.equal(toolMessages.some((message) => message.content.includes("traceback line 159")), true);
    assert.equal(toolMessages.some((message) => message.content.includes("tool result 4") && message.content.includes("traceback line 159")), false);
    assert.equal(toolMessages.some((message) => message.content.includes("compacted older tool result")), true);
    assert.equal(dynamicChars < 2_200, true);
  });

  it("drops orphaned assistant tool-call messages when bounding provider history", async () => {
    const assembler = createDefaultPromptAssembler();
    const prompt = "Resolve SWE task.";
    const history: ModelChatMessage[] = [
      { role: "user", content: prompt },
      { role: "assistant", content: "", toolCalls: [{ id: "tool-old", name: "core_file_read", input: { path: "old.py" } }] },
      { role: "tool", toolCallId: "tool-old", toolName: "core.file.read", content: "old tool result" }
    ];
    for (let index = 1; index <= 11; index += 1) history.push({ role: "assistant", content: `newer note ${index}` });
    const result = await assembler.assemble(input({
      prompt,
      history,
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan()
    }));
    const dynamicHistory = result.messages.slice(result.messages.findIndex((message) => message.content === prompt) + 1);
    const toolIds = new Set(dynamicHistory.filter((message) => message.role === "tool").map((message) => message.toolCallId));

    for (const message of dynamicHistory) {
      for (const toolCall of message.toolCalls ?? []) {
        assert.equal(toolIds.has(toolCall.id), true);
      }
    }
  });

  it("preserves recent runtime correction messages when bounding provider history", async () => {
    const assembler = createDefaultPromptAssembler();
    const prompt = "Resolve SWE task.";
    const history: ModelChatMessage[] = [{ role: "user", content: prompt }];
    for (let index = 1; index <= 22; index += 1) {
      history.push(
        { role: "assistant", content: "", toolCalls: [{ id: `tool-${index}`, name: "core_file_read", input: { path: `file-${index}.py` } }] },
        { role: "tool", toolCallId: `tool-${index}`, toolName: "core.file.read", content: `tool result ${index}` },
        { role: "assistant", content: `inspection note ${index}` }
      );
    }
    history.push(
      { role: "assistant", content: "", toolCalls: [{ id: "bad-edit", name: "core_file_edit", input: { path: "target.py", expected: "same", replacement: "same" } }] },
      { role: "tool", toolCallId: "bad-edit", toolName: "core.file.edit", content: "WORKFLOW_INVALID_MUTATION_INTENT: expected and replacement are identical." },
      { role: "user", content: "WORKFLOW_INVALID_MUTATION_INTENT_REJECTED.\nRejected mutation input:\n{\n  \"expected\": \"same\",\n  \"replacement\": \"same\"\n}\nNext action: use a real diff." },
      { role: "assistant", content: "", toolCalls: [{ id: "refresh", name: "core_search_text", input: { pattern: "target", glob: "target.py" } }] },
      { role: "tool", toolCallId: "refresh", toolName: "core.search.text", content: "target.py:10: target evidence" }
    );

    const result = await assembler.assemble(input({
      prompt,
      history,
      contextPipelineManifest: pipelineManifest(),
      phasePlan: agentPhasePlan()
    }));
    const dynamicHistory = result.messages.slice(result.messages.findIndex((message) => message.content === prompt) + 1);

    assert.equal(dynamicHistory.length <= 64, true);
    assert.equal(dynamicHistory.some((message) => message.content.includes("WORKFLOW_INVALID_MUTATION_INTENT_REJECTED")), true);
    assert.equal(dynamicHistory.some((message) => message.content.includes("\"expected\": \"same\"")), true);
    assert.equal(dynamicHistory.some((message) => message.toolCallId === "refresh"), true);
  });

  it("keeps provider stable-prefix fingerprints stable across session and turn ids", async () => {
    const assembler = createDefaultPromptAssembler();
    const first = await assembler.assemble(input({
      prompt: "fix issue",
      sessionId: "session-one",
      turnId: "turn-one",
      contextPipelineManifest: pipelineManifest({ sessionId: "session-one", turnId: "turn-one" }),
      phasePlan: agentPhasePlan({ planId: "agent-phase-plan:first", sessionId: "session-one", turnId: "turn-one" }),
      taskDecision: taskDecisionRequest({ requestId: "task-decision-request:first", briefId: "task-brief:first" }),
      profilePolicy: profileWorkflowPolicy(),
      evidenceFirst: evidenceFirstContext({
        classificationId: "evidence-classification:first",
        planId: "evidence-plan:first",
        summaryId: "evidence-summary:first"
      }),
      reasoningEffortMapping: reasoningMapping(),
      availableTools: [capability("core.file.read"), capability("core.shell.run", "process")]
    }));
    const second = await assembler.assemble(input({
      prompt: "fix issue",
      sessionId: "session-two",
      turnId: "turn-two",
      contextPipelineManifest: pipelineManifest({ sessionId: "session-two", turnId: "turn-two" }),
      phasePlan: agentPhasePlan({ planId: "agent-phase-plan:second", sessionId: "session-two", turnId: "turn-two" }),
      taskDecision: taskDecisionRequest({ requestId: "task-decision-request:second", briefId: "task-brief:second" }),
      profilePolicy: profileWorkflowPolicy(),
      evidenceFirst: evidenceFirstContext({
        classificationId: "evidence-classification:second",
        planId: "evidence-plan:second",
        summaryId: "evidence-summary:second"
      }),
      reasoningEffortMapping: reasoningMapping(),
      availableTools: [capability("core.file.read"), capability("core.shell.run", "process")]
    }));
    const firstProfileWorkflow = first.sections.find((section) => section.providerId === "core.profile-workflow" && section.included);
    const secondProfileWorkflow = second.sections.find((section) => section.providerId === "core.profile-workflow" && section.included);

    assert.equal(first.trace.pipeline?.providerPrefixFingerprint, second.trace.pipeline?.providerPrefixFingerprint);
    assert.equal(first.trace.pipeline?.providerPrefixMessageCount, second.trace.pipeline?.providerPrefixMessageCount);
    assert.equal(first.trace.pipeline?.providerPrefixTokenEstimate, second.trace.pipeline?.providerPrefixTokenEstimate);
    assert.equal(firstProfileWorkflow?.evidenceFingerprint, secondProfileWorkflow?.evidenceFingerprint);
    assert.deepEqual(firstProfileWorkflow?.provenance?.workflowStageIds, ["understand", "verify"]);
    assert.equal(first.messages.some((message) => message.content.includes("task-decision-request:first")), false);
    assert.equal(first.messages.some((message) => message.content.includes("task-brief:first")), false);
  });

  it("projects only the authoritative scheduling next action instead of board noise", async () => {
    const assembler = createDefaultPromptAssembler();
    const noisyBoard = noisyToolDecisionBoard();
    const result = await assembler.assemble(input({
      prompt: "fix issue",
      schedulingNextAction: schedulingNextAction({
        actionClass: "mutation",
        stageId: "change",
        requiredNextAction: "core.patch.apply",
        allowedCapabilityIds: ["core.patch.apply"],
        acceptedEvidenceRefs: ["evidence:focused-read"]
      }),
      toolDecisionBoard: noisyBoard,
      availableTools: [capability("core.patch.apply", "write"), capability("core.file.read")]
    }));
    const visible = result.messages.map((message) => message.content).join("\n");
    const section = result.sections.find((candidate) => candidate.providerId === "core.scheduling-next-action");

    assert.equal(section?.included, true);
    assert.equal(visible.includes("Scheduling next action:"), true);
    assert.equal(visible.includes("Action class: mutation"), true);
    assert.equal(visible.includes("Required next action: core.patch.apply"), true);
    assert.equal(visible.includes("Allowed capabilities: core.patch.apply"), true);
    assert.equal(visible.includes("Provider tool schemas may include additional workflow tools for cache stability; only the allowed capabilities above are executable for this next action."), true);
    assert.equal(visible.includes("Calling any other tool will be rejected before execution."), true);
    assert.equal(visible.includes("Evidence refs: evidence:focused-read"), true);
    assert.equal(visible.includes("cache hit rate collapsed to 12%"), false);
    assert.equal(visible.includes("technical director residual risk should not be visible"), false);
    assert.equal(visible.includes("stale rejected action should not be visible"), false);
    assert.equal(visible.includes("RAW_SECRET_TOOL_OUTPUT_SHOULD_NOT_LEAK"), false);
    assert.equal(section?.provenance?.nextActionFingerprint !== undefined, true);
  });

  it("tells mutation-only stages not to continue source inspection", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "apply the accepted source fix",
      schedulingNextAction: schedulingNextAction({
        actionClass: "mutation",
        stageId: "change",
        requiredNextAction: "core.file.edit|core.patch.apply",
        allowedCapabilityIds: ["core.file.read", "core.file.edit", "core.patch.apply", "core.shell.run"],
        acceptedEvidenceRefs: ["evidence:focused-read"]
      }),
      availableTools: [
        capability("core.file.edit", "write"),
        capability("core.patch.apply", "write"),
        capability("core.file.read"),
        capability("core.shell.run", "process")
      ]
    }));
    const visible = result.messages.map((message) => message.content).join("\n");

    assert.equal(visible.includes("Mutation-only stage: do not call read, search, list, glob, shell, or test tools."), true);
    assert.equal(visible.includes("Use core.file.edit or core.patch.apply now, based on the accepted evidence refs."), true);
  });

  it("tells verification stages to run the required test tool instead of inspecting or diffing", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "verify the accepted source fix",
      schedulingNextAction: schedulingNextAction({
        actionClass: "standard-verification",
        stageId: "verify",
        requiredNextAction: "core.test.run",
        allowedCapabilityIds: ["core.test.run", "core.shell.run", "core.git.diff"],
        acceptedEvidenceRefs: ["evidence:patch"]
      }),
      availableTools: [
        capability("core.test.run", "process"),
        capability("core.shell.run", "process"),
        capability("core.git.diff"),
        capability("core.file.read")
      ]
    }));
    const visible = result.messages.map((message) => message.content).join("\n");

    assert.equal(visible.includes("Required next action overrides broader allowed capability lists."), true);
    assert.equal(visible.includes("Verification-only stage: call core_test_run (capability core.test.run) with a standard repository test command now."), true);
    assert.equal(visible.includes("Do not call core_shell_run, read, search, list, glob, git diff, or mutation tools for this verification action."), true);
  });

  it("maps standard test command gates to the model-visible test function", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "verify the accepted source fix",
      schedulingNextAction: schedulingNextAction({
        actionClass: "standard-verification",
        stageId: "verify",
        requiredNextAction: "standard-test-command",
        allowedCapabilityIds: ["core.test.run"],
        acceptedEvidenceRefs: ["evidence:patch"]
      }),
      availableTools: [
        capability("core.test.run", "process"),
        capability("core.shell.run", "process"),
        capability("core.file.read")
      ]
    }));
    const visible = result.messages.map((message) => message.content).join("\n");

    assert.equal(visible.includes("Verification-only stage: call core_test_run (capability core.test.run) with a standard repository test command now."), true);
    assert.equal(visible.includes("Do not call core_shell_run, read, search, list, glob, git diff, or mutation tools for this verification action."), true);
  });

  it("tells focused-evidence stages to prefer bounded focused reads", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "inspect the target file",
      schedulingNextAction: schedulingNextAction({
        actionClass: "focused-evidence",
        stageId: "understand",
        requiredNextAction: "core.file.read",
        allowedCapabilityIds: ["core.file.read"],
        acceptedEvidenceRefs: []
      }),
      availableTools: [capability("core.file.read"), capability("core.search.text")]
    }));
    const visible = result.messages.map((message) => message.content).join("\n");

    assert.equal(visible.includes("Preferred evidence shape: one bounded focused source read"), true);
    assert.equal(visible.includes("Use offset/limit when reading source files"), true);
  });

  it("keeps generic mutation tool contracts in the stable prefix", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "apply the smallest source change",
      schedulingNextAction: schedulingNextAction({
        actionClass: "mutation",
        stageId: "change",
        requiredNextAction: "core.file.edit|core.patch.apply",
        allowedCapabilityIds: ["core.file.edit", "core.patch.apply"],
        acceptedEvidenceRefs: ["evidence:focused-read"]
      }),
      profilePolicy: {
        ...profileWorkflowPolicyWithProduceRunState(),
        workflowCapabilityIds: ["core.file.read", "core.file.edit", "core.patch.apply"]
      },
      availableTools: [capability("core.file.edit", "write"), capability("core.patch.apply", "write")]
    }));
    const visible = result.messages.map((message) => message.content).join("\n");
    const contract = result.messages.find((message) => message.content.includes("Mutation tool contract:"));
    const scheduling = result.messages.find((message) => message.content.includes("Scheduling next action:"));

    assert.equal(contract?.cacheHint?.policy, "stable");
    assert.equal(visible.includes("Mutation shape: make one real source change using current accepted evidence"), true);
    assert.equal(visible.includes("For core.file.edit, copy exact current expected text from accepted evidence"), true);
    assert.equal(visible.includes("For core.patch.apply, provide a complete unified diff with file headers and at least one hunk"), true);
    assert.equal(visible.includes("Do not send empty patches, no-op edits, placeholder hunks, or stale context"), true);
    assert.equal(scheduling?.content.includes("Mutation shape:"), false);
  });

  it("keeps stable project instructions from truncating the provider prefix", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "fix issue",
      contextPipelineManifest: pipelineManifest(),
      projectRules: [projectRule("AGENTS.md", "Keep platform contracts stable.")],
      phasePlan: agentPhasePlan()
    }));
    const projectInstructions = result.messages.find((message) => message.content.includes("Project repository instructions:"));
    const modeContext = result.messages.find((message) => message.content.includes("Runtime mode context:"));
    const phasePlan = result.messages.find((message) => message.content.includes("Agent phase plan:"));

    assert.equal(result.messages[0], projectInstructions);
    assert.equal(projectInstructions?.cacheHint?.policy, "stable");
    assert.equal(modeContext?.cacheHint?.policy, "stable");
    assert.equal(phasePlan?.cacheHint?.policy, "stable");
    assert.equal(result.trace.pipeline?.providerPrefixMessageCount, result.messages.findIndex((message) => message.cacheHint?.policy !== "stable"));
    assert.equal(result.trace.pipeline?.cacheHintSummary.stable, result.trace.pipeline?.providerPrefixMessageCount);
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
    assert.equal(contract.content.includes("Preserve any requested path literals exactly, including case."), true);
    assert.equal(contract.content.includes("Requested path literals: README.md, openspec/spec.md."), true);
    assert.equal(contract.content.includes("core_file_write"), true);
    assert.equal(result.messages.at(-1)?.content, "Update README.md and openspec/spec.md with bilingual guidance");
  });

  it("adds the file mutation output contract for chat-mode staged engineering writes", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      mode: "chat",
      prompt: "生成 docs/USAGE.md 和 examples/config.json",
      availableTools: [capability("core.file.read")],
      profilePolicy: {
        ...profileWorkflowPolicy(),
        profileId: "engineering/coding.v1",
        role: "engineering-agent",
        workflowGraphId: "workflow/engineering.coding.v1",
        workflowCapabilityIds: ["core.file.read", "core.file.write", "core.file.edit", "core.patch.apply"],
        requiredFamilyIds: ["file.read", "file.write", "file.edit", "patch.apply"]
      }
    }));

    const contract = result.messages.find((message) => message.role === "system" && message.content.includes("File mutation output contract:"));
    assert.ok(contract);
    assert.equal(contract.content.includes("Preserve any requested path literals exactly, including case."), true);
    assert.equal(contract.content.includes("Requested path literals: docs/USAGE.md, examples/config.json."), true);
  });

  it("does not add file mutation contracts for read-only parent-path boundary prompts", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "检查当前任务目录，说明为什么不应该修改 ../outside-scope.txt，并给出安全替代方案，不要修改任何文件。",
      availableTools: [
        capability("core.file.read"),
        capability("core.file.list")
      ]
    }));

    const contract = result.messages.find((message) => message.role === "system" && message.content.includes("File mutation output contract:"));
    assert.equal(contract, undefined);
  });

  it("makes file mutation contracts stage-aware after evidence collection", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      mode: "chat",
      prompt: "生成 docs/USAGE.md 和 examples/config.json",
      availableTools: [
        capability("core.file.read"),
        capability("core.file.write", "write"),
        capability("core.file.edit", "write"),
        capability("core.patch.apply", "write")
      ],
      profilePolicy: profileWorkflowPolicyWithProduceRunState()
    }));

    const contract = result.messages.find((message) => message.role === "system" && message.content.includes("File mutation output contract:"));
    assert.ok(contract);
    assert.equal(contract.content.includes("Current ready stage requires mutation progress: core.file.edit or core.patch.apply."), true);
    assert.equal(contract.content.includes("Do not continue with read/search/list-only inspection unless a mutation tool is blocked."), true);
    assert.equal(contract.content.includes("Inspect the relevant files first"), false);
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

  it("projects cross-platform semantic tool aliases instead of platform command habits", async () => {
    const assembler = createDefaultPromptAssembler();
    const result = await assembler.assemble(input({
      prompt: "search and edit README",
      toolPolicy: "read-write",
      availableTools: [
        capability("core.file.read", "read", [], ["Read"]),
        capability("core.search.text", "read", [], ["Grep"]),
        capability("core.workspace.glob", "read", [], ["Glob"]),
        capability("core.file.edit", "write", [], ["Edit"]),
        capability("core.file.write", "write", [], ["Write"]),
        capability("core.file.copy", "write", [], ["Copy"]),
        capability("core.file.move", "write", [], ["Move"]),
        capability("core.file.delete", "write", [], ["Delete"]),
        capability("core.directory.create", "write", [], ["Mkdir"]),
        capability("core.file.touch", "write", [], ["Touch"]),
        capability("core.file.stat", "read", [], ["Stat"]),
        capability("core.json.read", "read", [], ["JsonRead"]),
        capability("core.json.patch", "write", [], ["JsonPatch"]),
        capability("core.checksum.hash", "read", [], ["Hash"]),
        capability("core.path.resolve", "read", [], ["PathResolve"]),
        capability("core.env.inspect", "read", [], ["Env"]),
        capability("core.command.lookup", "read", [], ["Which"]),
        capability("core.archive.create", "write", [], ["ArchiveCreate"]),
        capability("core.archive.extract", "write", [], ["ArchiveExtract"]),
        capability("core.asset.view-local", "read", [], ["ViewImage"]),
        capability("core.code.diagnostics", "read", [], ["Diagnostics"]),
        capability("core.notebook.read", "read", [], ["NotebookRead"]),
        capability("core.notebook.edit", "write", [], ["NotebookEdit"]),
        capability("core.patch.apply", "write", [], ["ApplyPatch"]),
        capability("core.revert.undo", "write", [], ["Revert"]),
        capability("core.test.run", "process", ["process:test"], ["Test"]),
        capability("core.task.create", "none", [], ["TaskCreate"]),
        capability("core.task.update", "none", [], ["TaskUpdate"]),
        capability("core.skill.activate", "none", [], ["Skill"]),
        capability("core.shell.run", "process", ["process:run"], ["Bash", "PowerShell"])
      ]
    }));

    const policy = result.messages.find((message) => message.role === "system" && message.content.includes("Tool visibility policy:"))?.content ?? "";
    assert.equal(policy.includes("Read -> core_file_read"), true);
    assert.equal(policy.includes("Grep -> core_search_text"), true);
    assert.equal(policy.includes("Glob -> core_workspace_glob"), true);
    assert.equal(policy.includes("Edit -> core_file_edit"), true);
    assert.equal(policy.includes("Write -> core_file_write"), true);
    assert.equal(policy.includes("Copy -> core_file_copy"), true);
    assert.equal(policy.includes("Move -> core_file_move"), true);
    assert.equal(policy.includes("Delete -> core_file_delete"), true);
    assert.equal(policy.includes("Mkdir -> core_directory_create"), true);
    assert.equal(policy.includes("Touch -> core_file_touch"), true);
    assert.equal(policy.includes("Stat -> core_file_stat"), true);
    assert.equal(policy.includes("JsonRead -> core_json_read"), true);
    assert.equal(policy.includes("JsonPatch -> core_json_patch"), true);
    assert.equal(policy.includes("Hash -> core_checksum_hash"), true);
    assert.equal(policy.includes("PathResolve -> core_path_resolve"), true);
    assert.equal(policy.includes("Env -> core_env_inspect"), true);
    assert.equal(policy.includes("Which -> core_command_lookup"), true);
    assert.equal(policy.includes("ArchiveCreate -> core_archive_create"), true);
    assert.equal(policy.includes("ArchiveExtract -> core_archive_extract"), true);
    assert.equal(policy.includes("ViewImage -> core_asset_view-local"), true);
    assert.equal(policy.includes("Diagnostics -> core_code_diagnostics"), true);
    assert.equal(policy.includes("NotebookRead -> core_notebook_read"), true);
    assert.equal(policy.includes("NotebookEdit -> core_notebook_edit"), true);
    assert.equal(policy.includes("ApplyPatch -> core_patch_apply"), true);
    assert.equal(policy.includes("Revert -> core_revert_undo"), true);
    assert.equal(policy.includes("Test -> core_test_run"), true);
    assert.equal(policy.includes("TaskCreate -> core_task_create"), true);
    assert.equal(policy.includes("TaskUpdate -> core_task_update"), true);
    assert.equal(policy.includes("Skill -> core_skill_activate"), true);
    assert.equal(policy.includes("Bash -> core_shell_run"), false);
    assert.deepEqual(result.sections.find((section) => section.providerId === "core.tool-policy")?.provenance?.semanticAliases, [
      "Read",
      "Grep",
      "Glob",
      "Edit",
      "Write",
      "Copy",
      "Move",
      "Delete",
      "Mkdir",
      "Touch",
      "Stat",
      "JsonRead",
      "JsonPatch",
      "Hash",
      "PathResolve",
      "Env",
      "Which",
      "ArchiveCreate",
      "ArchiveExtract",
      "ViewImage",
      "Diagnostics",
      "NotebookRead",
      "NotebookEdit",
      "ApplyPatch",
      "Revert",
      "Test",
      "TaskCreate",
      "TaskUpdate",
      "Skill"
    ]);
    assert.equal(policy.includes("Use semantic workspace tools before platform commands"), true);
    assert.equal(policy.includes("Use ApplyPatch for unified diffs, Revert for checkpoint rollback, and Test for governed verification before falling back to shell commands"), true);
    assert.equal(policy.includes("Use Edit, JsonPatch, ArchiveCreate, ArchiveExtract, Write, Copy, Move, Delete, Mkdir, or Touch for mutations instead of sed/jq/tar/zip/unzip/cp/mv/rm/mkdir/touch/echo redirection"), true);
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
  readonly sessionId?: string;
  readonly turnId?: string;
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
  readonly toolOptIns?: PromptAssemblyInput["toolOptIns"];
  readonly projectRules?: readonly AgentLoopProjectRuleEvidence[];
  readonly contextPipelineManifest?: ContextPipelineManifest;
  readonly taskDecision?: TaskDecisionRequest;
  readonly schedulingNextAction?: PromptSchedulingNextAction;
  readonly profilePolicy?: PromptAssemblyInput["profilePolicy"];
  readonly toolDecisionBoard?: PromptAssemblyInput["toolDecisionBoard"];
  readonly history?: readonly ModelChatMessage[];
}): PromptAssemblyInput {
  const sessionId = asId<"session">(options.sessionId ?? "session-prompt-assembly");
  const turnId = asId<"turn">(options.turnId ?? "turn-prompt-assembly");
  const selectedNodes = options.projectionNodes ?? (options.contextContent ? [
    projectionNode("context-node-1", "memory-ref", "memory", options.contextContent, { memoryId: "memory-1", scope: "session" })
  ] : []);
  return {
    schemaVersion: "1.0.0",
    sessionId,
    turnId,
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
    history: options.history ?? [{ role: "user", content: options.prompt }],
    ...(options.projectRules ? { projectRules: options.projectRules } : {}),
    ...(options.contextPipelineManifest ? { contextPipelineManifest: options.contextPipelineManifest } : {}),
    ...(options.taskDecision ? { taskDecision: options.taskDecision } : {}),
    ...(options.schedulingNextAction ? { schedulingNextAction: options.schedulingNextAction } : {}),
    ...(options.profilePolicy ? { profilePolicy: options.profilePolicy } : {}),
    ...(options.toolDecisionBoard ? { toolDecisionBoard: options.toolDecisionBoard } : {}),
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
        sessionId,
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
    toolPolicy: options.toolPolicy ?? "safe-all",
    ...(options.toolOptIns ? { toolOptIns: options.toolOptIns } : {}),
    budget: { hardLimitTokens: options.hardLimitTokens ?? 1024, reservedOutputTokens: 0 },
    compatibility: { schemaVersion: "1.0.0" }
  };
}

function schedulingNextAction(options: {
  readonly actionClass: PromptSchedulingNextAction["actionClass"];
  readonly stageId?: string;
  readonly requiredNextAction: string;
  readonly allowedCapabilityIds: readonly string[];
  readonly acceptedEvidenceRefs: readonly string[];
  readonly correctionText?: string;
}): PromptSchedulingNextAction {
  return {
    schemaVersion: "1.0.0",
    ...options,
    redaction: { class: "internal", fields: ["acceptedEvidenceRefs", "correctionText"] }
  };
}

function toolDecisionBoard(): NonNullable<PromptAssemblyInput["toolDecisionBoard"]> {
  return {
    boardId: "tool-decision-board:test",
    sessionId: asId<"session">("session-prompt-assembly"),
    turnId: asId<"turn">("turn-prompt-assembly"),
    iteration: 2,
    visibleToolIds: ["core.file.read"],
    projectionSummaries: [{
      capabilityId: "core.file.read",
      status: "visible",
      visible: true,
      reason: "required stage capability is model-visible",
      reasonCode: "stage-required-visible",
      policySource: "software-engineer-profile",
      profileId: "engineering/coding.v1",
      stageId: "change",
      requiredByStage: true,
      issueClass: "none",
      aliases: ["Read"],
      sideEffect: "read"
    }, {
      capabilityId: "core.file.edit",
      status: "hidden",
      visible: false,
      reason: "capability is outside the current stage or projection boundary",
      reasonCode: "stage-boundary",
      policySource: "software-engineer-profile",
      profileId: "engineering/coding.v1",
      stageId: "change",
      requiredByStage: false,
      issueClass: "deliberate-boundary",
      aliases: ["Edit"],
      sideEffect: "write"
    }, {
      capabilityId: "core.test.run",
      status: "unavailable",
      visible: false,
      reason: "workflow capability is not registered or has no executable provider",
      reasonCode: "workflow-capability-unregistered",
      policySource: "software-engineer-profile",
      profileId: "engineering/coding.v1",
      stageId: "change",
      requiredByStage: true,
      issueClass: "cli-capability-gap",
      unavailableBecause: "capability-not-registered",
      aliases: [],
      sideEffect: "none"
    }],
    hiddenToolSummaries: [],
    records: [{
      recordId: "tool-decision:1",
      kind: "feedback",
      status: "rejected",
      toolCallId: "call-1",
      toolName: "core.file.read",
      capabilityId: "core.file.read",
      normalizedInputHash: "hash-input",
      reasonCode: "preflight.rejected",
      correctiveAction: "Correct the tool input or choose a different projected tool.",
      recommendedNextAction: "corrected input or different projected tool",
      iteration: 1,
      timestamp: new Date(0).toISOString(),
      metadata: { repeatedRejectedIntentCount: 2 }
    }],
    previousRejectedIntents: [{
      recordId: "tool-decision:1",
      kind: "feedback",
      status: "rejected",
      toolCallId: "call-1",
      toolName: "core.file.read",
      capabilityId: "core.file.read",
      normalizedInputHash: "hash-input",
      reasonCode: "preflight.rejected",
      correctiveAction: "Correct the tool input or choose a different projected tool.",
      recommendedNextAction: "corrected input or different projected tool",
      iteration: 1,
      timestamp: new Date(0).toISOString(),
      metadata: { repeatedRejectedIntentCount: 2 }
    }],
    repeatedRejectedIntentCount: 2,
    decisionLoopFailureCandidate: false,
    recommendedNextActions: ["corrected input or different projected tool"],
    sharedSchedulingEvidence: {
      lineageIds: [],
      failureAnalysisRecords: [],
      acceptedEvidenceRefs: [],
      redaction: { class: "internal" }
    },
    counters: { visibleToolCount: 1, hiddenToolCount: 0, recordCount: 1, rejectedIntentKeyCount: 1 },
    redaction: { class: "internal", fields: ["records.metadata"] }
  };
}

function noisyToolDecisionBoard(): NonNullable<PromptAssemblyInput["toolDecisionBoard"]> {
  const board = toolDecisionBoard();
  const noisyRecord: ToolDecisionRecord = {
    recordId: "tool-decision:noisy",
    kind: "feedback",
    status: "rejected",
    toolCallId: "call-noisy",
    toolName: "core.shell.run",
    capabilityId: "core.shell.run",
    normalizedInputHash: "hash-noisy",
    reasonCode: "cache hit rate collapsed to 12%",
    correctiveAction: "technical director residual risk should not be visible",
    recommendedNextAction: "stale rejected action should not be visible",
    iteration: 1,
    timestamp: new Date(0).toISOString(),
    metadata: {
      rawToolOutput: "RAW_SECRET_TOOL_OUTPUT_SHOULD_NOT_LEAK"
    }
  };
  return {
    ...board,
    records: [...board.records, noisyRecord],
    previousRejectedIntents: [noisyRecord],
    recommendedNextActions: [noisyRecord.recommendedNextAction ?? ""],
    sharedSchedulingEvidence: {
      lineageIds: [],
      failureAnalysisRecords: [{
        recordId: "failure-analysis:noisy",
        attemptId: "attempt-noisy",
        terminalKind: "failed",
        failureClass: "cache hit rate collapsed to 12%",
        attribution: "cache",
        proofStatus: "unproven",
        evidenceQueries: ["technical director residual risk should not be visible"],
        acceptedEvidenceRefs: ["RAW_SECRET_TOOL_OUTPUT_SHOULD_NOT_LEAK"],
        nextAllowedAction: "search-evidence",
        rerunAllowed: false,
        modelOwnedAttributionAllowed: false,
        residualRisk: "technical director residual risk should not be visible",
        timestamp: new Date(0).toISOString(),
        redaction: { class: "internal", fields: ["acceptedEvidenceRefs"] }
      }],
      acceptedEvidenceRefs: ["RAW_SECRET_TOOL_OUTPUT_SHOULD_NOT_LEAK"],
      nextAllowedAction: "stale rejected action should not be visible",
      redaction: { class: "internal" }
    },
    counters: {
      ...board.counters,
      cacheDiagnostic: "cache hit rate collapsed to 12%"
    }
  };
}

function taskDecisionRequest(options: { readonly requestId?: string; readonly briefId?: string } = {}): TaskDecisionRequest {
  const requestId = options.requestId ?? "task-decision-request:prompt-assembly";
  const briefId = options.briefId ?? "task-brief:prompt-assembly";
  return {
    schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
    requestId,
    brief: {
      schemaVersion: TASK_DELIVERY_FLOW_SCHEMA_VERSION,
      briefId,
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

function profileWorkflowPolicy(): NonNullable<PromptAssemblyInput["profilePolicy"]> {
  return {
    schemaVersion: "1.0.0",
    profileId: "evaluation/swe-bench-lite.v1",
    role: "evaluation-workflow",
    workflowGraphId: "workflow/evaluation.swe-bench-lite.v1",
    workflowCapabilityIds: [
      "core.env.prepare",
      "core.swe.bench.run",
      "core.file.read"
    ],
    requiredFamilyIds: ["package.manager", "benchmark.run", "file.read"],
    capabilityAffordanceCompiler: {
      schemaVersion: "1.0.0",
      compilerId: "cli.profile.capability-affordance.compiler.v1",
      status: "ready",
      profileId: "evaluation/swe-bench-lite.v1",
      workflowGraphId: "workflow/evaluation.swe-bench-lite.v1",
      requiredFamilyIds: ["package.manager", "benchmark.run", "file.read"],
      resolvedCapabilityIds: ["core.env.prepare", "core.swe.bench.run", "core.file.read"],
      missingCapabilityIds: [],
      projectionStatus: "ready",
      source: "core-coding-tools.catalog",
      redaction: { class: "internal" }
    },
    workflowPriority: "primary",
    orchestrationMode: "staged-capability-workflow",
    toolProjection: "all",
    toolProjectionSource: "profile",
    contextPipelineEnabled: true,
    loopLimits: { maxModelIterations: 48, maxToolCalls: 96 },
    workflowStages: [
      {
        id: "understand",
        objective: "Collect repository evidence.",
        capabilityIds: ["core.env.prepare", "core.file.read"],
        entryCriteria: ["workspace ready"],
        exitCriteria: ["repository evidence collected"]
      },
      {
        id: "verify",
        objective: "Verify patch evidence.",
        capabilityIds: ["core.test.run", "core.git.diff"],
        entryCriteria: ["patch ready"],
        exitCriteria: ["test evidence collected", "diff reviewed"]
      }
    ],
    antiTailoring: true,
    executionBoundary: "governed-capabilities",
    redaction: { class: "internal" }
  };
}

function profileWorkflowPolicyWithRunState(options: {
  readonly taskRunId?: string;
  readonly verifyAttempts?: number;
} = {}): NonNullable<PromptAssemblyInput["profilePolicy"]> {
  return {
    ...profileWorkflowPolicy(),
    stagedTaskWorkflow: {
      schemaVersion: "1.0.0",
      profileId: "evaluation/swe-bench-lite.v1",
      graphId: "workflow/evaluation.swe-bench-lite.v1",
      fingerprint: "workflow:test",
      stageCount: 2,
      refCount: 2,
      executorKinds: ["agent-loop"],
      graph: {
        schemaVersion: "1.0.0",
        graphId: "workflow/evaluation.swe-bench-lite.v1",
        profileId: "evaluation/swe-bench-lite.v1",
        stages: [
          {
            schemaVersion: "1.0.0",
            stageId: "stage:understand",
            kind: "collect-evidence",
            executorKind: "agent-loop",
            dependsOn: [],
            inputRefs: [],
            expectedOutputRefs: ["ref:workflow-understand-evidence"],
            allowedTools: ["core.file.read"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            stageId: "stage:verify",
            kind: "verify",
            executorKind: "agent-loop",
            dependsOn: ["stage:understand"],
            inputRefs: ["ref:workflow-understand-evidence"],
            expectedOutputRefs: ["ref:workflow-verify-evidence"],
            allowedTools: ["core.test.run"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          }
        ],
        refs: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      runState: {
        schemaVersion: "1.0.0",
        taskRunId: options.taskRunId ?? "staged:workflow:test",
        graphId: "workflow/evaluation.swe-bench-lite.v1",
        profileId: "evaluation/swe-bench-lite.v1",
        stageStates: [
          {
            stageId: "stage:understand",
            status: "succeeded",
            attempts: 1,
            inputRefs: [],
            outputRefs: ["ref:workflow-understand-evidence"],
            diagnostics: []
          },
          {
            stageId: "stage:verify",
            status: "ready",
            attempts: options.verifyAttempts ?? 0,
            inputRefs: ["ref:workflow-understand-evidence"],
            outputRefs: [],
            diagnostics: []
          }
        ],
        refs: [],
        events: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal", fields: ["stageStates.diagnostics", "refs.preview"] }
      },
      redaction: { class: "internal" }
    }
  };
}

function profileWorkflowPolicyWithProduceRunState(): NonNullable<PromptAssemblyInput["profilePolicy"]> {
  return {
    ...profileWorkflowPolicy(),
    workflowStages: [
      {
        id: "understand",
        objective: "Collect repository evidence.",
        capabilityIds: ["core.file.read", "core.search.text"],
        entryCriteria: ["workspace ready"],
        exitCriteria: ["repository evidence collected"]
      },
      {
        id: "change",
        objective: "Apply a source change.",
        capabilityIds: ["core.file.read", "core.search.text", "core.file.edit", "core.patch.apply"],
        entryCriteria: ["repository evidence collected"],
        exitCriteria: ["mutation-grade source change produced"]
      },
      {
        id: "verify",
        objective: "Verify patch evidence.",
        capabilityIds: ["core.test.run", "core.git.diff"],
        entryCriteria: ["patch ready"],
        exitCriteria: ["test evidence collected", "diff reviewed"]
      }
    ],
    stagedTaskWorkflow: {
      schemaVersion: "1.0.0",
      profileId: "evaluation/swe-bench-lite.v1",
      graphId: "workflow/evaluation.swe-bench-lite.v1",
      fingerprint: "workflow:test-produce",
      stageCount: 3,
      refCount: 3,
      executorKinds: ["agent-loop"],
      graph: {
        schemaVersion: "1.0.0",
        graphId: "workflow/evaluation.swe-bench-lite.v1",
        profileId: "evaluation/swe-bench-lite.v1",
        stages: [
          {
            schemaVersion: "1.0.0",
            stageId: "stage:understand",
            kind: "collect-evidence",
            executorKind: "agent-loop",
            dependsOn: [],
            inputRefs: [],
            expectedOutputRefs: ["ref:workflow-understand-evidence"],
            allowedTools: ["core.file.read", "core.search.text"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            stageId: "stage:change",
            kind: "produce",
            executorKind: "agent-loop",
            dependsOn: ["stage:understand"],
            inputRefs: ["ref:workflow-understand-evidence"],
            expectedOutputRefs: ["ref:workflow-source-change"],
            allowedTools: ["core.file.read", "core.search.text", "core.file.edit", "core.patch.apply"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            stageId: "stage:verify",
            kind: "verify",
            executorKind: "agent-loop",
            dependsOn: ["stage:change"],
            inputRefs: ["ref:workflow-source-change"],
            expectedOutputRefs: ["ref:workflow-verify-evidence"],
            allowedTools: ["core.test.run", "core.git.diff"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          }
        ],
        refs: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      runState: {
        schemaVersion: "1.0.0",
        taskRunId: "staged:workflow:produce",
        graphId: "workflow/evaluation.swe-bench-lite.v1",
        profileId: "evaluation/swe-bench-lite.v1",
        stageStates: [
          {
            stageId: "stage:understand",
            status: "succeeded",
            attempts: 1,
            inputRefs: [],
            outputRefs: ["ref:workflow-understand-evidence"],
            diagnostics: []
          },
          {
            stageId: "stage:change",
            status: "ready",
            attempts: 0,
            inputRefs: ["ref:workflow-understand-evidence"],
            outputRefs: [],
            diagnostics: []
          },
          {
            stageId: "stage:verify",
            status: "pending",
            attempts: 0,
            inputRefs: ["ref:workflow-source-change"],
            outputRefs: [],
            diagnostics: []
          }
        ],
        refs: [],
        events: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal", fields: ["stageStates.diagnostics", "refs.preview"] }
      },
      redaction: { class: "internal" }
    }
  };
}

function pipelineManifest(options: { readonly sessionId?: string; readonly turnId?: string } = {}): ContextPipelineManifest {
  const sessionId = asId<"session">(options.sessionId ?? "session-prompt-assembly");
  const turnId = asId<"turn">(options.turnId ?? "turn-prompt-assembly");
  const dynamicCurrentTurn = options.sessionId !== undefined || options.turnId !== undefined;
  const currentBlockId = dynamicCurrentTurn ? `context-block:current-turn:${sessionId}:${turnId}` : "block-current";
  const currentLayerHash = dynamicCurrentTurn ? `layer-current-${sessionId}` : "layer-current";
  const currentPrefixHash = dynamicCurrentTurn ? `prefix-current-${sessionId}-${turnId}` : "prefix-current";
  return {
    schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION,
    manifestId: "context-pipeline:manifest-test",
    sessionId,
    turnId,
    layers: [
      { id: "kernel", order: 0, blockIds: ["block-kernel"], blockHashes: ["hash-kernel"], layerHash: "layer-kernel", prefixHash: "prefix-kernel", estimatedTokens: 2 },
      { id: "project", order: 1, blockIds: ["block-project"], blockHashes: ["hash-project"], layerHash: "layer-project", prefixHash: "prefix-project", estimatedTokens: 2 },
      { id: "session", order: 2, blockIds: ["block-session"], blockHashes: ["hash-session"], layerHash: "layer-session", prefixHash: "prefix-session", estimatedTokens: 2 },
      { id: "current-turn", order: 3, blockIds: [currentBlockId], blockHashes: [`hash-${currentBlockId}`], layerHash: currentLayerHash, prefixHash: currentPrefixHash, estimatedTokens: 3 }
    ],
    blocks: [
      pipelineBlock("block-kernel", "kernel", 0, "Kernel block"),
      pipelineBlock("block-project", "project", 1, "Project block"),
      pipelineBlock("block-session", "session", 2, "Session block"),
      pipelineBlock(currentBlockId, "current-turn", 3, "Current turn block")
    ],
    excludedBlocks: [],
    prefixHashes: [
      { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION, id: "prefix:kernel", layer: "kernel", order: 0, blockIds: ["block-kernel"], blockHashes: ["hash-kernel"], layerHash: "layer-kernel", prefixHash: "prefix-kernel", estimatedTokens: 2, redaction: { class: "internal" }, compatibility: { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION } },
      { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION, id: "prefix:project", layer: "project", order: 1, blockIds: ["block-project"], blockHashes: ["hash-project"], layerHash: "layer-project", prefixHash: "prefix-project", estimatedTokens: 2, redaction: { class: "internal" }, compatibility: { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION } },
      { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION, id: "prefix:session", layer: "session", order: 2, blockIds: ["block-session"], blockHashes: ["hash-session"], layerHash: "layer-session", prefixHash: "prefix-session", estimatedTokens: 2, redaction: { class: "internal" }, compatibility: { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION } },
      { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION, id: "prefix:current-turn", layer: "current-turn", order: 3, blockIds: [currentBlockId], blockHashes: [`hash-${currentBlockId}`], layerHash: currentLayerHash, prefixHash: currentPrefixHash, estimatedTokens: 3, redaction: { class: "internal" }, compatibility: { schemaVersion: CONTEXT_PIPELINE_SCHEMA_VERSION } }
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

function capability(id: string, sideEffect: CapabilityManifest["sideEffect"] = "read", permissions: readonly string[] = [], modelAliases: readonly string[] = []): CapabilityManifest {
  return {
    id: asId<"capability">(id),
    name: id,
    source: "test",
    version: "1.0.0",
    trust: "trusted",
    sideEffect,
    permissions,
    inputSchema: {},
    outputSchema: {},
    enabled: true,
    ...(modelAliases.length > 0 ? { projection: { modelAliases } } : {})
  };
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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

function agentPhasePlan(options: { readonly planId?: string; readonly sessionId?: string; readonly turnId?: string } = {}): AgentPhasePlan {
  const sessionId = asId<"session">(options.sessionId ?? "session-prompt-assembly");
  const turnId = asId<"turn">(options.turnId ?? "turn-prompt-assembly");
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
    planId: options.planId ?? "agent-phase-plan:test",
    sessionId,
    turnId,
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

function evidenceFirstContext(options: { readonly classificationId?: string; readonly planId?: string; readonly summaryId?: string } = {}): EvidenceFirstRuntimeContext {
  const classification: EvidenceTaskClassification = {
    schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
    classificationId: options.classificationId ?? "evidence-classification:test",
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
    planId: options.planId ?? "evidence-plan:test",
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
      summaryId: options.summaryId ?? "evidence-summary:test",
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
