import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  AgentLoopProfilePolicyMetadata,
  JsonObject,
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
  PolicyDecision,
  PolicyEngine,
  PolicyRequest
} from "@deepseek/platform-contracts";
import { collectRuntimeEvents, createDefaultRuntimeKernel, registerRuntimeCoreTools, runAgentLoop } from "../src/index.js";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";
import { defaultDeepSeekProfile } from "@deepseek/model-gateway";

describe("mutation repair routing", () => {
  it("keeps mutation repair on source edits after a failed mutation precondition", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-edit-stale", name: "core.file.edit", input: { path: "README.md", expected: "missing evidence", replacement: "changed evidence" } },
      { id: "call-edit-fresh", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "repair stale edit context and then change the file",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy(),
      limits: { maxModelIterations: 5, maxToolCalls: 8 }
    }));

    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit", "core_file_read", "core_patch_apply"]);
    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "exact-target-refresh-or-source-edit-or-bounded-blocker");
    assert.equal(events.some((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.requestedCapabilityId === "core.file.read"
    ), false);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.edit" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("keeps source edit repair after a gated mutation precondition failure", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-edit-stale", name: "core.file.edit", input: { path: "README.md", expected: "missing evidence", replacement: "changed evidence" } },
      { id: "call-edit-fresh", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "recover after gated stale edit",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy(),
      limits: { maxModelIterations: 6, maxToolCalls: 8 }
    }));

    assert.deepEqual(gateway.visibleToolNamesForRequest(0), ["core_file_edit"]);
    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit", "core_file_read", "core_patch_apply"]);
    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "exact-target-refresh-or-source-edit-or-bounded-blocker");
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.edit" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("normalizes one exact-target evidence refresh after a failed mutation precondition", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-edit-stale", name: "core.file.edit", input: { path: "README.md", expected: "missing evidence", replacement: "changed evidence" } },
      { id: "call-refresh-read", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-edit-fresh", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "refresh exact context after stale edit and then change the file",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy({ includeFocusedSearch: true }),
      limits: { maxModelIterations: 6, maxToolCalls: 8 }
    }));

    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit", "core_file_read", "core_patch_apply"]);
    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "exact-target-refresh-or-source-edit-or-bounded-blocker");
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.read" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.read" &&
      event.data.terminalKind === "workflow-required-action.rejected"
    ), false);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("narrows provider-visible tools to the active mutation stage before a convergence gate", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-extra-read", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-extra-search", name: "core.search.text", input: { pattern: "stage", glob: "README.md", outputMode: "content", contextLines: 1 } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "read then change without broad discovery",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: readThenMutationPolicy(),
      limits: { maxModelIterations: 3, maxToolCalls: 5 }
    }));

    assert.deepEqual(gateway.visibleToolNamesForRequest(0), ["core_file_read"]);
    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit"]);
    await kernel.shutdown();
  });

  it("keeps a non-empty focused search open for a bounded source read", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\nmore local context\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-hidden-search", name: "core.search.text", input: { pattern: "stage evidence", glob: "README.md" } },
      { id: "call-focused-search", name: "core.search.text", input: { pattern: "stage evidence", glob: "README.md" } },
      { id: "call-focused-read", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 20 } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "use one focused search for missing mutation context, then edit",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: officialDiagnosticMutationPolicy(),
      limits: { maxModelIterations: 7, maxToolCalls: 9 }
    }));

    assert.deepEqual(gateway.visibleToolNamesForRequest(0), ["core_file_edit", "core_patch_apply"]);
    assert.equal(events.some((event) =>
      event.kind === "capability.started" &&
      event.data.toolCallId === "call-hidden-search"
    ), false);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolCallId === "call-hidden-search" &&
      String(event.data.terminalKind ?? "").endsWith(".rejected")
    ), true);
    assert.equal(events.some((event) =>
      event.kind === "workflow.stage-evidence.window.opened" &&
      event.data.targetPath === "README.md"
    ), true);
    assert.match(requestMessagesText(gateway.requests[1]), /WORKFLOW_FOCUSED_EVIDENCE_WINDOW_OPENED/);
    assert.match(requestMessagesText(gateway.requests[1]), /Target scope: README\.md/);
    assert.match(requestMessagesText(gateway.requests[1]), /reissue the rejected focused request/i);
    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit", "core_file_read", "core_patch_apply", "core_search_text"]);
    const focusedSearch = events.find((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolCallId === "call-focused-search"
    );
    assert.equal(focusedSearch?.data.terminalKind, "capability.completed");
    assert.match(String(focusedSearch?.data.result ?? ""), /README\.md:1:\s*stage evidence/);
    assert.equal(events.some((event) =>
      event.kind === "workflow.stage-evidence.accepted" &&
      event.data.capabilityId === "core.search.text"
    ), true);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolCallId === "call-focused-read" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.deepEqual(gateway.visibleToolNamesForRequest(2), ["core_file_edit", "core_file_read", "core_patch_apply", "core_search_text"]);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\nmore local context\n");
    await kernel.shutdown();
  });

  it("allows a third focused operation to refresh prior accepted source evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/src/entry.py", "from .dependency import transform\n\ndef run(value):\n    return value\n");
    await deps.platform.writeFile("/workspace/src/dependency.py", Array.from({ length: 260 }, (_, index) =>
      index === 220 ? "def transform(value):" : `# dependency line ${index + 1}`
    ).join("\n") + "\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-understand-entry", name: "core.file.read", input: { path: "src/entry.py", offset: 0, limit: 20 } },
      { id: "call-hidden-dependency", name: "core.file.read", input: { path: "src/dependency.py", offset: 0, limit: 120 } },
      { id: "call-dependency-first", name: "core.file.read", input: { path: "src/dependency.py", offset: 0, limit: 120 } },
      { id: "call-dependency-second", name: "core.file.read", input: { path: "src/dependency.py", offset: 120, limit: 120 } },
      { id: "call-entry-refresh", name: "core.file.read", input: { path: "src/entry.py", offset: 0, limit: 20 } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "src/entry.py", expected: "    return value", replacement: "    return transform(value)" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "inspect a dependency and refresh the accepted mutation target before editing",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: readThenMutationPolicy(),
      limits: { maxModelIterations: 9, maxToolCalls: 12 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolCallId === "call-entry-refresh" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.equal(events.some((event) =>
      event.kind === "workflow.stage-evidence.accepted" &&
      event.data.toolCallId === "call-entry-refresh" &&
      event.data.acceptedOperations === 3
    ), true);
    assert.match(await deps.platform.readFile("/workspace/src/entry.py"), /return transform\(value\)/);
    await kernel.shutdown();
  });

  it("keeps novel dependency evidence reachable after a path-scoped search and target refresh", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/astropy/io/ascii/rst.py", [
      "from .fixedwidth import FixedWidth, FixedWidthData",
      "",
      "class SimpleRSTData(FixedWidthData):",
      "    start_line = 3",
      "",
      "class RST(FixedWidth):",
      "    def __init__(self, header_rows=None):",
      "        super().__init__(header_rows=header_rows)",
      ""
    ].join("\n"));
    await deps.platform.writeFile("/workspace/astropy/io/ascii/fixedwidth.py", Array.from({ length: 490 }, (_, index) => {
      if (index === 344) return "        header_rows=None,";
      if (index === 346) return "        if header_rows is None:";
      if (index === 347) return "            header_rows = [\"name\"]";
      if (index === 355) return "        if self.data.start_line is None:";
      if (index === 356) return "            self.data.start_line = len(header_rows)";
      if (index === 476) return "        header_rows=None,";
      if (index === 486) return "            position_line = len(self.header.header_rows)";
      return `# fixedwidth line ${index + 1}`;
    }).join("\n") + "\n");
    await deps.platform.writeFile("/workspace/astropy/io/ascii/unrelated.py", "header_rows = ['unrelated']\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-understand-rst", name: "core.file.read", input: { path: "astropy/io/ascii/rst.py", offset: 0, limit: 200 } },
      { id: "call-hidden-dependency", name: "core.file.read", input: { path: "astropy/io/ascii/fixedwidth.py", offset: 0, limit: 200 } },
      { id: "call-dependency-prefix", name: "core.file.read", input: { path: "astropy/io/ascii/fixedwidth.py", offset: 0, limit: 200 } },
      { id: "call-focused-path-search", name: "core.search.text", input: { pattern: "header_rows", path: "astropy/io/ascii/fixedwidth.py" } },
      { id: "call-rst-refresh", name: "core.file.read", input: { path: "astropy/io/ascii/rst.py" } },
      { id: "call-dependency-continuation", name: "core.file.read", input: { path: "astropy/io/ascii/fixedwidth.py", limitBytes: 5_000 } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "astropy/io/ascii/rst.py", expected: "        super().__init__(header_rows=header_rows)", replacement: "        super().__init__(header_rows=header_rows)\n        self.data.start_line = 2 + len(self.header.header_rows)" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const basePolicy = readThenMutationPolicyWithPatch();

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "inspect the direct base class behavior before applying the incremental subclass repair",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: {
        ...basePolicy,
        workflowGovernanceMode: "evaluation",
        workflowCapabilityIds: [...(basePolicy.workflowCapabilityIds ?? []), "core.search.text"]
      },
      limits: {
        maxModelIterations: 10,
        maxToolCalls: 14,
        stageBudgets: [{ stageId: "stage:understand", maxModelIterations: 10, maxToolCalls: 12 }]
      }
    }));

    const focusedSearch = events.find((event) =>
      event.kind === "model.tool.result" && event.data.toolCallId === "call-focused-path-search"
    );
    assert.match(String(focusedSearch?.data.result ?? ""), /fixedwidth\.py:345:/);
    assert.doesNotMatch(String(focusedSearch?.data.result ?? ""), /unrelated\.py/);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolCallId === "call-dependency-continuation" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    const continuationRange = events
      .filter((event) => event.kind === "workflow.stage-evidence.accepted")
      .find((event) => event.data.toolCallId === "call-dependency-continuation")
      ?.data.coveredReadRanges as JsonObject[] | undefined;
    assert.equal(continuationRange?.some((range) => range.start === 0 && range.end === 399), true);
    assert.match(await deps.platform.readFile("/workspace/astropy/io/ascii/rst.py"), /self\.data\.start_line = 2 \+ len/);
    await kernel.shutdown();
  });

  it("allows a focused search in the direct parent directory of reviewed source targets", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/pkg/rst.py", "from .fixedwidth import FixedWidth\n\nclass RST(FixedWidth):\n    pass\n");
    await deps.platform.writeFile("/workspace/pkg/fixedwidth.py", "class FixedWidth:\n    pass\n");
    await deps.platform.writeFile("/workspace/other/unrelated.py", "class RST:\n    pass\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-understand-rst", name: "core.file.read", input: { path: "pkg/rst.py", offset: 0, limit: 20 } },
      { id: "call-hidden-dependency", name: "core.file.read", input: { path: "pkg/fixedwidth.py", offset: 0, limit: 20 } },
      { id: "call-dependency-read", name: "core.file.read", input: { path: "pkg/fixedwidth.py", offset: 0, limit: 20 } },
      { id: "call-parent-search", name: "core.search.text", input: { pattern: "class RST", path: "pkg" } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "pkg/rst.py", expected: "    pass", replacement: "    value = 1" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const basePolicy = readThenMutationPolicyWithPatch();

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "inspect a direct dependency and find the reviewed subclass in the same package before editing",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: {
        ...basePolicy,
        workflowGovernanceMode: "evaluation",
        workflowCapabilityIds: [...(basePolicy.workflowCapabilityIds ?? []), "core.search.text"]
      },
      limits: { maxModelIterations: 8, maxToolCalls: 12 }
    }));

    const parentSearch = events.find((event) =>
      event.kind === "model.tool.result" && event.data.toolCallId === "call-parent-search"
    );
    assert.equal(parentSearch?.data.terminalKind, "capability.completed");
    assert.match(String(parentSearch?.data.result ?? ""), /pkg\/rst\.py:3:/);
    assert.doesNotMatch(String(parentSearch?.data.result ?? ""), /other\/unrelated\.py/);
    assert.match(await deps.platform.readFile("/workspace/pkg/rst.py"), /value = 1/);
    await kernel.shutdown();
  });

  it("allows a direct-parent glob that covers a reviewed related source target", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/pkg/rst.py", "from .fixedwidth import FixedWidth\n\nclass RST(FixedWidth):\n    pass\n");
    await deps.platform.writeFile("/workspace/pkg/fixedwidth.py", "class FixedWidth:\n    pass\n");
    await deps.platform.writeFile("/workspace/other/unrelated.py", "class RST:\n    pass\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-understand-rst", name: "core.file.read", input: { path: "pkg/rst.py", offset: 0, limit: 20 } },
      { id: "call-hidden-dependency", name: "core.file.read", input: { path: "pkg/fixedwidth.py", offset: 0, limit: 20 } },
      { id: "call-dependency-read", name: "core.file.read", input: { path: "pkg/fixedwidth.py", offset: 0, limit: 20 } },
      { id: "call-related-glob-search", name: "core.search.text", input: { pattern: "class RST", glob: "pkg/**/*.py" } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "pkg/rst.py", expected: "    pass", replacement: "    value = 1" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const basePolicy = readThenMutationPolicyWithPatch();

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "find a reviewed subclass through a package-scoped glob before editing",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: {
        ...basePolicy,
        workflowGovernanceMode: "evaluation",
        workflowCapabilityIds: [...(basePolicy.workflowCapabilityIds ?? []), "core.search.text"]
      },
      limits: { maxModelIterations: 8, maxToolCalls: 12 }
    }));

    const relatedSearch = events.find((event) =>
      event.kind === "model.tool.result" && event.data.toolCallId === "call-related-glob-search"
    );
    assert.equal(relatedSearch?.data.terminalKind, "capability.completed");
    assert.match(String(relatedSearch?.data.result ?? ""), /pkg\/rst\.py:3:/);
    assert.doesNotMatch(String(relatedSearch?.data.result ?? ""), /other\/unrelated\.py/);
    assert.match(await deps.platform.readFile("/workspace/pkg/rst.py"), /value = 1/);
    await kernel.shutdown();
  });

  it("rejects a repository-wide glob during focused related-source evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/pkg/rst.py", "from .fixedwidth import FixedWidth\n\nclass RST(FixedWidth):\n    pass\n");
    await deps.platform.writeFile("/workspace/pkg/fixedwidth.py", "class FixedWidth:\n    pass\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-understand-rst", name: "core.file.read", input: { path: "pkg/rst.py", offset: 0, limit: 20 } },
      { id: "call-hidden-dependency", name: "core.file.read", input: { path: "pkg/fixedwidth.py", offset: 0, limit: 20 } },
      { id: "call-dependency-read", name: "core.file.read", input: { path: "pkg/fixedwidth.py", offset: 0, limit: 20 } },
      { id: "call-broad-glob-search", name: "core.search.text", input: { pattern: "class RST", glob: "**/*.py" } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "pkg/rst.py", expected: "    pass", replacement: "    value = 1" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const basePolicy = readThenMutationPolicyWithPatch();

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "reject repository-wide discovery and then edit the reviewed source",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: {
        ...basePolicy,
        workflowGovernanceMode: "evaluation",
        workflowCapabilityIds: [...(basePolicy.workflowCapabilityIds ?? []), "core.search.text"]
      },
      limits: { maxModelIterations: 8, maxToolCalls: 12 }
    }));

    const broadSearch = events.find((event) =>
      event.kind === "model.tool.result" && event.data.toolCallId === "call-broad-glob-search"
    );
    assert.equal(broadSearch?.data.terminalKind, "workflow-stage-evidence-wrong-target.rejected");
    assert.equal(events.some((event) =>
      event.kind === "capability.started" && event.data.toolCallId === "call-broad-glob-search"
    ), false);
    assert.match(await deps.platform.readFile("/workspace/pkg/rst.py"), /value = 1/);
    await kernel.shutdown();
  });

  it("closes focused evidence after glob variants return the same search matches", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/src/entry.py", "class Target:\n    value = 1\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-hidden-search", name: "core.search.text", input: { pattern: "class Target", glob: "src/*.py", contextLines: 0 } },
      { id: "call-first-search", name: "core.search.text", input: { pattern: "class Target", glob: "src/*.py", contextLines: 0 } },
      { id: "call-equivalent-search", name: "core.search.text", input: { pattern: "class Target", glob: "**/src/*.py", contextLines: 5 } },
      { id: "call-third-search", name: "core.search.text", input: { pattern: "class Target", glob: "src/*.py", contextLines: 10 } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "src/entry.py", expected: "    value = 1", replacement: "    value = 2" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "stop focused inspection when search variants return equivalent source evidence",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: officialDiagnosticMutationPolicy(),
      limits: { maxModelIterations: 8, maxToolCalls: 12 }
    }));

    assert.equal(events.filter((event) =>
      event.kind === "workflow.stage-evidence.accepted" && event.data.capabilityId === "core.search.text"
    ).length, 1);
    assert.equal(events.some((event) =>
      event.kind === "workflow.stage-evidence.window.closed" && event.data.reason === "duplicate"
    ), true);
    assert.equal(events.some((event) =>
      event.kind === "capability.started" && event.data.toolCallId === "call-third-search"
    ), false);
    assert.match(await deps.platform.readFile("/workspace/src/entry.py"), /value = 2/);
    await kernel.shutdown();
  });

  it("keeps the focused evidence window open for one same-target read range extension", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const source = Array.from({ length: 360 }, (_, index) =>
      index === 244 ? "target evidence" : `line ${index + 1}`
    ).join("\n") + "\n";
    await deps.platform.writeFile("/workspace/src/example.py", source);
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-hidden-read", name: "core.file.read", input: { path: "src/example.py", offset: 160, limit: 80 } },
      { id: "call-first-read", name: "core.file.read", input: { path: "src/example.py", offset: 160, limit: 80 } },
      { id: "call-extended-read", name: "core.file.read", input: { path: "src/example.py", offset: 160, limit: 200 } },
      { id: "call-duplicate-read", name: "core.file.read", input: { path: "src/example.py", offset: 160, limit: 200 } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "src/example.py", expected: "target evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "extend one bounded read to reach the mutation target, then edit",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: officialDiagnosticMutationPolicy(),
      limits: { maxModelIterations: 8, maxToolCalls: 10 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "capability.started" &&
      event.data.toolCallId === "call-hidden-read"
    ), false);
    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit", "core_file_read", "core_patch_apply", "core_search_text"]);
    assert.deepEqual(gateway.visibleToolNamesForRequest(2), ["core_file_edit", "core_file_read", "core_patch_apply", "core_search_text"]);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolCallId === "call-extended-read" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.deepEqual(gateway.visibleToolNamesForRequest(3), ["core_file_edit", "core_file_read", "core_patch_apply", "core_search_text"]);
    assert.equal(events.some((event) =>
      event.kind === "capability.started" &&
      event.data.toolCallId === "call-duplicate-read"
    ), false);
    assert.match(await deps.platform.readFile("/workspace/src/example.py"), /changed evidence/);
    await kernel.shutdown();
  });

  it("allows one bounded read of a directly imported relative dependency", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/pkg/entry.py", [
      "from .dependency import transform",
      "",
      "def run(value):",
      "    return value",
      ""
    ].join("\n"));
    await deps.platform.writeFile("/workspace/pkg/dependency.py", [
      "def transform(value):",
      "    return value + 1",
      ""
    ].join("\n"));
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-hidden-read", name: "core.file.read", input: { path: "pkg/entry.py" } },
      { id: "call-entry-read", name: "core.file.read", input: { path: "pkg/entry.py" } },
      { id: "call-dependency-read", name: "core.file.read", input: { path: "pkg/dependency.py" } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "pkg/entry.py", expected: "    return value", replacement: "    return transform(value)" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "inspect the directly imported helper, then apply the source change",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: officialDiagnosticMutationPolicy(),
      limits: { maxModelIterations: 7, maxToolCalls: 9 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolCallId === "call-dependency-read" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.equal(events.some((event) =>
      event.kind === "workflow.stage-evidence.accepted" &&
      event.data.toolCallId === "call-dependency-read" &&
      event.data.acceptedOperations === 2
    ), true);
    assert.match(await deps.platform.readFile("/workspace/pkg/entry.py"), /return transform\(value\)/);
    await kernel.shutdown();
  });

  it("closes the focused evidence window after an empty search", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-hidden-search", name: "core.search.text", input: { pattern: "missing symbol", glob: "README.md" } },
      { id: "call-empty-search", name: "core.search.text", input: { pattern: "missing symbol", glob: "README.md" } },
      { id: "call-search-variant", name: "core.search.text", input: { pattern: "missing symbol", glob: "**/README.md", contextLines: 10 } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "stop searching after one focused search returns no source evidence",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: officialDiagnosticMutationPolicy(),
      limits: { maxModelIterations: 7, maxToolCalls: 9 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolCallId === "call-empty-search" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.deepEqual(gateway.visibleToolNamesForRequest(2), ["core_file_edit", "core_patch_apply"]);
    assert.equal(events.some((event) =>
      event.kind === "capability.started" &&
      event.data.toolCallId === "call-search-variant"
    ), false);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("rejects a fully covered focused read before execution", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\nmore local context\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-hidden-read", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 2 } },
      { id: "call-first-read", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 2 } },
      { id: "call-duplicate-read", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 2 } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "reject a duplicate bounded read, then edit",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: officialDiagnosticMutationPolicy(),
      limits: { maxModelIterations: 7, maxToolCalls: 9 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "capability.started" &&
      event.data.toolCallId === "call-duplicate-read"
    ), false);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolCallId === "call-duplicate-read" &&
      event.data.terminalKind === "workflow-stage-evidence-duplicate.rejected"
    ), true);
    assert.equal(events.some((event) =>
      event.kind === "workflow.stage-evidence.window.closed" &&
      event.data.reason === "duplicate"
    ), true);
    assert.deepEqual(gateway.visibleToolNamesForRequest(3), ["core_file_edit", "core_patch_apply"]);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\nmore local context\n");
    await kernel.shutdown();
  });

  it("applies the focused evidence window to standard primary staged workflows", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-hidden-read", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 1 } },
      { id: "call-focused-read", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 1 } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const profilePolicy = officialDiagnosticMutationPolicy();

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "use generic staged recovery outside evaluation mode",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: { ...profilePolicy, workflowGovernanceMode: "standard" },
      limits: { maxModelIterations: 6, maxToolCalls: 8 }
    }));

    assert.equal(events.some((event) => event.kind === "workflow.stage-evidence.window.opened"), true);
    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit", "core_file_read", "core_patch_apply", "core_search_text"]);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("normalizes focused unbounded reads into two bounded source windows", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const source = Array.from({ length: 420 }, (_, index) =>
      index === 244 ? "target evidence" : `line ${index + 1}`
    ).join("\n") + "\n";
    await deps.platform.writeFile("/workspace/src/example.py", source);
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-hidden-read", name: "core.file.read", input: { path: "src/example.py" } },
      { id: "call-first-read", name: "core.file.read", input: { path: "src/example.py" } },
      { id: "call-second-read", name: "core.file.read", input: { path: "src/example.py", offset: 200 } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "src/example.py", expected: "target evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "normalize missing read bounds while gathering focused mutation evidence",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: officialDiagnosticMutationPolicy(),
      limits: { maxModelIterations: 7, maxToolCalls: 9 }
    }));

    const acceptedRanges = events
      .filter((event) => event.kind === "workflow.stage-evidence.accepted")
      .flatMap((event) => Array.isArray(event.data.coveredReadRanges) ? event.data.coveredReadRanges : []) as JsonObject[];
    assert.deepEqual(acceptedRanges.map((range) => [range.start, range.end]), [[0, 199], [0, 399]]);
    assert.equal(await deps.platform.readFile("/workspace/src/example.py").then((content) => content.includes("changed evidence")), true);
    await kernel.shutdown();
  });

  it("rejects unbounded source reads in governed evidence stages", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/src/app.py", "line 1\nline 2\nline 3\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-full-read", name: "core.file.read", input: { path: "src/app.py" } },
      { id: "call-bounded-read", name: "core.file.read", input: { path: "src/app.py", offset: 1, limit: 20 } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "inspect the relevant source file with bounded evidence",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: readThenMutationPolicy(),
      limits: { maxModelIterations: 3, maxToolCalls: 5 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "capability.started" &&
      event.data.toolCallId === "call-full-read"
    ), false);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.read" &&
      event.data.terminalKind === "workflow-unbounded-source-read.rejected"
    ), true);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.read" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    await kernel.shutdown();
  });

  it("suppresses repeated stale mutation input after refresh evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const staleEdit = { path: "README.md", expected: "missing evidence", replacement: "changed evidence" };
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-extra-read", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-edit-stale-1", name: "core.file.edit", input: staleEdit },
      { id: "call-repair-read-1", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 20 } },
      { id: "call-edit-stale-2", name: "core.file.edit", input: staleEdit },
      { id: "call-repair-read-2", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-edit-stale-3", name: "core.file.edit", input: staleEdit }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "do not keep executing stale edits",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy(),
      limits: { maxModelIterations: 8, maxToolCalls: 10 }
    }));

    const staleEditExecutions = events.filter((event) =>
      event.kind === "capability.failed" &&
      event.data.capabilityId === "core.file.edit"
    );
    assert.equal(staleEditExecutions.length, 1);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.terminalKind === "decision-loop.rejected"
    ), true);
    await kernel.shutdown();
  });

  it("suppresses repeated stale mutation preconditions after diagnostic evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const staleEdit = { path: "README.md", expected: "missing evidence", replacement: "changed evidence" };
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-edit-stale-1", name: "core.file.edit", input: staleEdit },
      { id: "call-edit-stale-2", name: "core.file.edit", input: staleEdit }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "do not repeat a stale exact edit after diagnostic context",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy(),
      limits: { maxModelIterations: 4, maxToolCalls: 6 }
    }));

    const staleEditExecutions = events.filter((event) =>
      event.kind === "capability.failed" &&
      event.data.capabilityId === "core.file.edit"
    );
    assert.equal(staleEditExecutions.length, 1);
    const suppressed = events.find((event) =>
      event.kind === "model.tool.result" &&
      event.data.terminalKind === "decision-loop.rejected"
    );
    assert.ok(suppressed);
    assert.match(String(suppressed.data.result ?? ""), /stale mutation/i);
    await kernel.shutdown();
  });

  it("forces patch-only after suppressing repeated stale mutation when patch is available", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const staleEdit = { path: "README.md", expected: "missing evidence", replacement: "changed evidence" };
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-edit-stale-1", name: "core.file.edit", input: staleEdit },
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 20 } },
      { id: "call-edit-stale-2", name: "core.file.edit", input: staleEdit },
      { id: "call-edit-stale-3", name: "core.file.edit", input: staleEdit }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "force patch-only after repeated stale exact edit suppression",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy({ includePatch: true }),
      limits: { maxModelIterations: 6, maxToolCalls: 8 }
    }));

    assert.equal(workflowGateForModelRequest(events, 3)?.requiredNextAction, "core.patch.apply");
    assert.deepEqual(gateway.visibleToolNamesForRequest(3), ["core_patch_apply"]);
    assert.equal(events.some((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.requestedCapabilityId === "core.file.edit" &&
      event.data.iteration === 4
    ), true);
    await kernel.shutdown();
  });

  it("does not spend mutation repair attempts on non-progress stage misses", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-edit-stale-1", name: "core.file.edit", input: { path: "README.md", expected: "missing one", replacement: "changed evidence" } },
      { id: "call-repair-read", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 20 } },
      { id: "call-edit-stale-2", name: "core.file.edit", input: { path: "README.md", expected: "missing two", replacement: "changed evidence" } },
      { id: "call-edit-stale-3", name: "core.file.edit", input: { path: "README.md", expected: "missing three", replacement: "changed evidence" } },
      { id: "call-edit-fresh", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "recover across distinct stale edit attempts",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy(),
      limits: { maxModelIterations: 10, maxToolCalls: 12 }
    }));

    assert.deepEqual(gateway.visibleToolNamesForRequest(0), ["core_file_edit"]);
    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit", "core_file_read", "core_patch_apply"]);
    assert.deepEqual(gateway.visibleToolNamesForRequest(3), ["core_file_edit", "core_file_read", "core_patch_apply"]);
    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "exact-target-refresh-or-source-edit-or-bounded-blocker");
    assert.equal(workflowGateForModelRequest(events, 3)?.requiredNextAction, "exact-target-refresh-or-source-edit-or-bounded-blocker");
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.edit" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("keeps exact-target recovery after multiple distinct stale exact edits", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-edit-stale-1", name: "core.file.edit", input: { path: "README.md", expected: "missing one", replacement: "changed evidence" } },
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 20 } },
      { id: "call-edit-stale-2", name: "core.file.edit", input: { path: "README.md", expected: "missing two", replacement: "changed evidence" } },
      { id: "call-edit-stale-3", name: "core.file.edit", input: { path: "README.md", expected: "missing three", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "recover stale exact edits without guessing expected text",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy({ includePatch: true }),
      limits: { maxModelIterations: 6, maxToolCalls: 8 }
    }));

    assert.equal(workflowGateForModelRequest(events, 3)?.requiredNextAction, "exact-target-refresh-or-source-edit-or-bounded-blocker");
    assert.deepEqual(gateway.visibleToolNamesForRequest(3), ["core_file_edit", "core_file_read", "core_patch_apply"]);
    await kernel.shutdown();
  });

  it("fails closed after repeating an exact-target refresh", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-edit-stale-1", name: "core.file.edit", input: { path: "README.md", expected: "missing one", replacement: "changed evidence" } },
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 20 } },
      { id: "call-refresh-again", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 20 } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "fail closed after repeating the one-shot exact-target refresh",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy({ includePatch: true }),
      limits: { maxModelIterations: 7, maxToolCalls: 9 }
    }));

    const repeatedRefresh = events.find((event) =>
      event.kind === "model.tool.result" && event.data.toolCallId === "call-refresh-again"
    );
    assert.equal(repeatedRefresh?.data.terminalKind, "workflow-mutation-recovery-exhausted");
    assert.equal(events.some((event) =>
      event.kind === "agent.loop.failed" && event.data.reason === "flow-mutation-recovery-exhausted"
    ), true);
    await kernel.shutdown();
  });

  it("allows focused context refresh after a stale patch recovery failure", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-patch-stale", name: "core.patch.apply", input: { patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-missing patch\n+changed evidence\n" } },
      { id: "call-read-after-patch-failure", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 20 } },
      { id: "call-edit-fresh", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "refresh exact context after stale patch failure",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy({ includeFocusedSearch: true, includePatch: true }),
      limits: { maxModelIterations: 9, maxToolCalls: 10 }
    }));

    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "focused-read-or-source-edit-or-bounded-blocker");
    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit", "core_file_read", "core_patch_apply", "core_search_text"]);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.read" &&
      event.data.terminalKind === "workflow-required-action.rejected"
    ), false);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.edit" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("counts alternating edit and patch repair failures against the same mutation stage", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-edit-stale-1", name: "core.file.edit", input: { path: "README.md", expected: "missing one", replacement: "changed evidence" } },
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 20 } },
      { id: "call-edit-stale-2", name: "core.file.edit", input: { path: "README.md", expected: "missing two", replacement: "changed evidence" } },
      { id: "call-patch-stale", name: "core.patch.apply", input: { patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-missing patch\n+changed evidence\n" } },
      { id: "call-refresh-after-patch", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 20 } },
      { id: "call-edit-stale-3", name: "core.file.edit", input: { path: "README.md", expected: "missing three", replacement: "changed evidence" } },
      { id: "call-patch-stale-2", name: "core.patch.apply", input: { patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-missing patch again\n+changed evidence\n" } },
      { id: "call-edit-stale-4", name: "core.file.edit", input: { path: "README.md", expected: "missing four", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "do not let edit and patch alternate around one mutation repair budget",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy({ includePatch: true }),
      limits: { maxModelIterations: 10, maxToolCalls: 12 }
    }));

    assert.equal(workflowGateForModelRequest(events, 7)?.requiredNextAction, "core.patch.apply");
    assert.deepEqual(gateway.visibleToolNamesForRequest(7), ["core_patch_apply"]);
    assert.equal(events.some((event) =>
      event.kind === "capability.started" &&
      event.data.capabilityId === "core.file.edit" &&
      event.data.toolCallId === "call-edit-stale-4"
    ), false);
    assert.equal(events.some((event) =>
      event.kind === "agent.loop.failed" &&
      event.data.reason === "workflow-required-action-missed"
    ), true);
    await kernel.shutdown();
  });

  it("rejects placeholder mutation intents before executing source tools", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-placeholder-edit", name: "core.file.edit", input: { path: "README.md", expected: "placeholder", replacement: "placeholder" } },
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-edit-fresh", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "reject placeholder edits and recover with evidence",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy(),
      limits: { maxModelIterations: 5, maxToolCalls: 8 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "capability.failed" &&
      event.data.capabilityId === "core.file.edit" &&
      String(event.error?.details?.originalCode ?? "") === "EDIT_PRECONDITION_FAILED"
    ), false);
    const rejected = events.find((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.edit" &&
      event.data.terminalKind === "workflow-invalid-mutation-intent.rejected"
    );
    assert.ok(rejected);
    assert.match(String(rejected.data.result ?? ""), /placeholder mutation/i);
    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "focused-read-or-source-edit-or-bounded-blocker");
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("closes placeholder mutation evidence refresh after one focused read", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-placeholder-edit", name: "core.file.edit", input: { path: "README.md", expected: "placeholder", replacement: "placeholder" } },
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-extra-read", name: "core.file.read", input: { path: "README.md", offset: 1, limit: 20 } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "reject placeholder edits and allow only one evidence refresh",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy(),
      limits: { maxModelIterations: 4, maxToolCalls: 6 }
    }));

    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "focused-read-or-source-edit-or-bounded-blocker");
    assert.equal(workflowGateForModelRequest(events, 2)?.requiredNextAction, "core.file.edit");
    assert.deepEqual(gateway.visibleToolNamesForRequest(2), ["core_file_edit"]);
    assert.equal(events.some((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.requestedCapabilityId === "core.file.read" &&
      event.data.iteration === 3
    ), true);
    await kernel.shutdown();
  });

  it("does not keep a broad mutation refresh gate after repeated invalid mutation intents", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-placeholder-edit-1", name: "core.file.edit", input: { path: "README.md", expected: "placeholder", replacement: "placeholder" } },
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-placeholder-edit-2", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "stage evidence" } },
      { id: "call-placeholder-edit-3", name: "core.file.edit", input: { path: "README.md", expected: "missing", replacement: "missing" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "close broad repair after repeated invalid edits",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy({ includePatch: true }),
      limits: { maxModelIterations: 6, maxToolCalls: 8 }
    }));

    assert.equal(workflowGateForModelRequest(events, 3)?.requiredNextAction, "core.patch.apply");
    assert.deepEqual(gateway.visibleToolNamesForRequest(3), ["core_patch_apply"]);
    assert.equal(events.some((event) =>
      event.kind === "capability.started" &&
      event.data.toolCallId === "call-placeholder-edit-3"
    ), false);
    await kernel.shutdown();
  });

  it("keeps reviewed-evidence mutation stages on source mutation after a placeholder edit", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-placeholder-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "stage evidence" } },
      { id: "call-extra-search", name: "core.search.text", input: { pattern: "stage evidence", glob: "README.md", outputMode: "content", contextLines: 1 } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "do not reopen evidence search after reviewed evidence is already driving mutation",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: reviewedEvidenceMutationPolicy({ includeFocusedSearch: true }),
      limits: { maxModelIterations: 5, maxToolCalls: 7 }
    }));

    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "core.file.edit");
    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit"]);
    assert.equal(events.some((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.requestedCapabilityId === "core.search.text" &&
      event.data.iteration === 2
    ), true);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.search.text" &&
      event.data.terminalKind === "capability.completed"
    ), false);
    await kernel.shutdown();
  });

  it("keeps reviewed-evidence mutation stages on source mutation after a failed patch", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-stale-patch", name: "core.patch.apply", input: { patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-missing evidence\n+changed evidence\n" } },
      { id: "call-extra-search", name: "core.search.text", input: { pattern: "stage evidence", glob: "README.md", outputMode: "content", contextLines: 1 } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "do not reopen evidence search after reviewed evidence patch failure",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: reviewedEvidenceMutationPolicy({ includeFocusedSearch: true, includePatch: true }),
      limits: { maxModelIterations: 5, maxToolCalls: 7 }
    }));

    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "core.patch.apply|core.file.edit");
    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit", "core_patch_apply"]);
    assert.equal(events.some((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.requestedCapabilityId === "core.search.text" &&
      event.data.iteration === 2
    ), true);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.search.text" &&
      event.data.terminalKind === "capability.completed"
    ), false);
    await kernel.shutdown();
  });

  it("projects declared patch failure context before fuzzy context into mutation repair instructions", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-stale-patch", name: "core.patch.apply", input: { patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-missing evidence\n+changed evidence\n" } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "surface declared context for failed patch repair",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: reviewedEvidenceMutationPolicy({ includePatch: true }),
      limits: { maxModelIterations: 4, maxToolCalls: 6 }
    }));

    const repairRequestText = requestMessagesText(gateway.requests[1]);
    assert.match(repairRequestText, /Current actualAtDeclaredLocation from failed mutation/i);
    assert.match(repairRequestText, /README\.md/);
    assert.match(repairRequestText, /stage evidence/);
    assert.doesNotMatch(repairRequestText, /Current nearestContext from failed mutation/i);
    await kernel.shutdown();
  });

  it("keeps exact source edit available after a failed patch precondition", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-stale-patch", name: "core.patch.apply", input: { patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-missing evidence\n+changed evidence\n" } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "recover from a stale patch by applying the exact current source edit",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: reviewedEvidenceMutationPolicy({ includePatch: true }),
      limits: { maxModelIterations: 4, maxToolCalls: 6 }
    }));

    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit", "core_patch_apply"]);
    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "core.patch.apply|core.file.edit");
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.edit" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.equal(events.some((event) =>
      event.kind === "agent.loop.failed" &&
      event.data.reason === "workflow-mutation-input-stalled"
    ), false);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("allows one focused refresh after the first invalid mutation in a reviewed stage", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-placeholder-edit", name: "core.file.edit", input: { path: "README.md", expected: "placeholder", replacement: "placeholder" } },
      { id: "call-focused-read", name: "core.file.read", input: { path: "README.md", offset: 1, limit: 20 } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "refresh exact context once after invalid mutation in reviewed stage",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: reviewedEvidenceMutationPolicy({ includeReadInChange: true, includePatch: true }),
      limits: { maxModelIterations: 5, maxToolCalls: 7 }
    }));

    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "focused-read-or-source-edit-or-bounded-blocker");
    const repairRequestText = requestMessagesText(gateway.requests[1]);
    assert.match(repairRequestText, /WORKFLOW_INVALID_MUTATION_INTENT_REJECTED/);
    assert.match(repairRequestText, /expected and replacement/i);
    assert.match(repairRequestText, /must differ/i);
    assert.match(repairRequestText, /Rejected mutation input/i);
    assert.match(repairRequestText, /"expected": "placeholder"/);
    assert.match(repairRequestText, /"replacement": "placeholder"/);
    assert.match(repairRequestText, /Current accepted source evidence/i);
    assert.match(repairRequestText, /README\.md/);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.read" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("keeps reviewed-evidence mutation stages on source mutation after patch then edit failures", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-stale-patch", name: "core.patch.apply", input: { patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-missing evidence\n+changed evidence\n" } },
      { id: "call-stale-edit", name: "core.file.edit", input: { path: "README.md", expected: "missing evidence", replacement: "changed evidence" } },
      { id: "call-extra-search", name: "core.search.text", input: { pattern: "stage evidence", glob: "README.md", outputMode: "content", contextLines: 1 } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "do not reopen evidence search after reviewed evidence patch and edit failures",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: reviewedEvidenceMutationPolicy({ includeFocusedSearch: true, includePatch: true }),
      limits: { maxModelIterations: 5, maxToolCalls: 7 }
    }));

    assert.equal(workflowGateForModelRequest(events, 2)?.requiredNextAction, "exact-target-refresh-or-source-edit-or-bounded-blocker");
    assert.deepEqual(gateway.visibleToolNamesForRequest(2), ["core_file_edit", "core_file_read", "core_patch_apply"]);
    assert.equal(events.some((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.requestedCapabilityId === "core.search.text" &&
      event.data.iteration === 3
    ), true);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.search.text" &&
      event.data.terminalKind === "capability.completed"
    ), false);
    await kernel.shutdown();
  });

  it("allows one exact-context retry after refreshed reviewed evidence still produces stale patch and edit inputs", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\nmore local context\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-placeholder-edit", name: "core.file.edit", input: { path: "README.md", expected: "placeholder", replacement: "placeholder" } },
      { id: "call-refresh-read", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 2 } },
      { id: "call-noop-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "stage evidence" } },
      { id: "call-stale-patch", name: "core.patch.apply", input: { patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-missing evidence\n+changed evidence\n" } },
      { id: "call-stale-edit", name: "core.file.edit", input: { path: "README.md", expected: "missing evidence", replacement: "changed evidence" } },
      { id: "call-fresh-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "recover from refreshed source evidence after stale patch and stale edit contexts",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: reviewedEvidenceMutationPolicy({ includePatch: true, includeReadInChange: true }),
      limits: { maxModelIterations: 8, maxToolCalls: 10 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "agent.loop.failed" &&
      event.data.reason === "workflow-mutation-input-stalled"
    ), false);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.intent" &&
      event.data.toolCallId === "call-fresh-edit"
    ), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\nmore local context\n");
    await kernel.shutdown();
  });

  it("keeps exact edit recovery after refreshed context is followed by a stale expected block", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile(
      "/workspace/separable.py",
      [
        "def _cstack(left, right):",
        "    noutp = _compute_n_outputs(left, right)",
        "",
        "    if isinstance(left, Model):",
        "        cleft = _coord_matrix(left, 'left', noutp)",
        "    else:",
        "        cleft = np.zeros((noutp, left.shape[1]))",
        "        cleft[: left.shape[0], : left.shape[1]] = left",
        "    if isinstance(right, Model):",
        "        cright = _coord_matrix(right, 'right', noutp)",
        "    else:",
        "        cright = np.zeros((noutp, right.shape[1]))",
        "        cright[-right.shape[0]:, -right.shape[1]:] = 1",
        "",
        "    return np.hstack([cleft, cright])",
        ""
      ].join("\n")
    );
    const staleExpectedBlock = [
      "    noutp = _compute_n_outputs(left, right)",
      "",
      "    if isinstance(left, Model):",
      "        cleft = _coord_matrix(left, 'left', noutp)",
      "    else:",
      "        cleft = np.zeros((noutp, left.shape[1]))",
      "        cleft[: left.shape[0], : left.shape[1]] = left",
      "    if isinstance(right, Model):",
      "        cright = _coord_matrix(right, 'right', noutp)",
      "    else:",
      "        cright = np.zeros((noutp, right.shape[1]))",
      "        cright[: right.shape[0], : right.shape[1]] = right"
    ].join("\n");
    const correctedBlock = [
      "    noutp = _compute_n_outputs(left, right)",
      "",
      "    if isinstance(left, Model):",
      "        cleft = _coord_matrix(left, 'left', noutp)",
      "    else:",
      "        cleft = np.zeros((noutp, left.shape[1]))",
      "        cleft[: left.shape[0], : left.shape[1]] = left",
      "    if isinstance(right, Model):",
      "        cright = _coord_matrix(right, 'right', noutp)",
      "    else:",
      "        cright = np.zeros((noutp, right.shape[1]))",
      "        cright[-right.shape[0]:, -right.shape[1]:] = right"
    ].join("\n");
    const currentBlock = staleExpectedBlock.replace(
      "        cright[: right.shape[0], : right.shape[1]] = right",
      "        cright[-right.shape[0]:, -right.shape[1]:] = 1"
    );
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-large-stale-edit", name: "core.file.edit", input: { path: "separable.py", expected: "def _missing_cstack():\n    pass", replacement: correctedBlock } },
      { id: "call-refresh-read-1", name: "core.file.read", input: { path: "separable.py", offset: 0, limit: 20 } },
      { id: "call-stale-expected-edit", name: "core.file.edit", input: { path: "separable.py", expected: staleExpectedBlock, replacement: correctedBlock } },
      { id: "call-refresh-read-2", name: "core.file.read", input: { path: "separable.py", offset: 0, limit: 20 } },
      { id: "call-fresh-edit", name: "core.file.edit", input: { path: "separable.py", expected: currentBlock, replacement: correctedBlock } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "recover after a refreshed source window but one stale exact expected block",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy({ includePatch: true }),
      limits: { maxModelIterations: 14, maxToolCalls: 16 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "model.tool.intent" &&
      event.data.toolCallId === "call-fresh-edit"
    ), true);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolCallId === "call-fresh-edit" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.match(await deps.platform.readFile("/workspace/separable.py"), /cright\[-right\.shape\[0\]:, -right\.shape\[1\]:\] = right/);
    await kernel.shutdown();
  });

  it("fails closed when reviewed-evidence mutation input keeps stalling across edit and patch", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-placeholder-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "stage evidence" } },
      { id: "call-stale-patch-1", name: "core.patch.apply", input: { patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-missing one\n+changed evidence\n" } },
      { id: "call-stale-edit", name: "core.file.edit", input: { path: "README.md", expected: "missing two", replacement: "changed evidence" } },
      { id: "call-stale-patch-2", name: "core.patch.apply", input: { patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-missing three\n+changed evidence\n" } },
      { id: "call-stale-patch-3", name: "core.patch.apply", input: { patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-missing four\n+changed evidence\n" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "stop repeated invalid mutation attempts after reviewed evidence",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: reviewedEvidenceMutationPolicy({ includePatch: true }),
      limits: { maxModelIterations: 8, maxToolCalls: 10 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "capability.started" &&
      event.data.toolCallId === "call-stale-patch-2"
    ), false);
    assert.equal(events.some((event) =>
      event.kind === "agent.loop.failed" &&
      event.data.reason === "workflow-mutation-input-stalled"
    ), true);
    const finalBoard = [...events].reverse().find((event) => {
      if (event.kind !== "tool.decision-board.snapshot") return false;
      const shared = jsonObjectField(event.data, "sharedSchedulingEvidence");
      return failureAnalysisRecords(shared).some((record) =>
        record.terminalKind === "workflow.required-action.missed"
      );
    });
    const shared = finalBoard ? jsonObjectField(finalBoard.data, "sharedSchedulingEvidence") : undefined;
    const failureRecord = failureAnalysisRecords(shared).find((record) =>
      record.terminalKind === "workflow.required-action.missed"
    );
    assert.equal(failureRecord?.nextAllowedAction, "repair");
    assert.equal(shared?.nextAllowedAction, "repair");
    await kernel.shutdown();
  });

  it("rejects placeholder patch hunks before executing patch recovery", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      {
        id: "call-placeholder-patch",
        name: "core.patch.apply",
        input: {
          patch: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-PLACEHOLDER\n+PLACEHOLDER\n"
        }
      },
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md" } },
      {
        id: "call-real-patch",
        name: "core.patch.apply",
        input: {
          patch: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-stage evidence\n+changed evidence\n"
        }
      }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "reject placeholder patch and recover with real patch",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy({ includePatch: true }),
      limits: { maxModelIterations: 5, maxToolCalls: 8 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "capability.started" &&
      event.data.toolCallId === "call-placeholder-patch"
    ), false);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.patch.apply" &&
      event.data.terminalKind === "workflow-invalid-mutation-intent.rejected"
    ), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("rejects patch targets outside accepted source evidence before execution", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-read-source", name: "core.file.read", input: { path: "README.md" } },
      {
        id: "call-probe-patch",
        name: "core.patch.apply",
        input: {
          patch: "diff --git a/.tmp_probe b/.tmp_probe\n--- a/.tmp_probe\n+++ b/.tmp_probe\n@@ -1 +1 @@\n-DUMMY\n+DUMMY2\n"
        }
      },
      {
        id: "call-real-patch",
        name: "core.patch.apply",
        input: {
          patch: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-stage evidence\n+changed evidence\n"
        }
      }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "read the target then patch only the target evidence path",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: readThenMutationPolicyWithPatch(),
      limits: { maxModelIterations: 5, maxToolCalls: 8 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "capability.started" &&
      event.data.toolCallId === "call-probe-patch"
    ), false);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.patch.apply" &&
      event.data.terminalKind === "workflow-invalid-mutation-intent.rejected" &&
      String(event.data.result ?? "").includes("patch target is outside accepted source evidence")
    ), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("rejects malformed patch intents before executing patch recovery", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-malformed-patch", name: "core.patch.apply", input: { patch: "a\n" } },
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md" } },
      {
        id: "call-real-patch",
        name: "core.patch.apply",
        input: {
          patch: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-stage evidence\n+changed evidence\n"
        }
      }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "reject malformed patch and recover with real patch",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy({ includePatch: true }),
      limits: { maxModelIterations: 5, maxToolCalls: 8 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "capability.started" &&
      event.data.toolCallId === "call-malformed-patch"
    ), false);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.patch.apply" &&
      event.data.terminalKind === "workflow-invalid-mutation-intent.rejected"
    ), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("keeps focused evidence refresh available after the first reviewed-evidence edit precondition failure when patch is available", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-stale-edit", name: "core.file.edit", input: { path: "README.md", expected: "missing evidence", replacement: "changed evidence" } },
      { id: "call-refresh-read", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 20 } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "refresh current source context after a stale reviewed-evidence edit, then edit",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: reviewedEvidenceMutationPolicy({ includeFocusedSearch: true, includePatch: true }),
      limits: { maxModelIterations: 5, maxToolCalls: 7 }
    }));

    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "exact-target-refresh-or-source-edit-or-bounded-blocker");
    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit", "core_file_read", "core_patch_apply"]);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.read" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("keeps focused refresh open after the first bounded read caused by an invalid mutation intent", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\nmore local context\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-noop-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "stage evidence" } },
      { id: "call-bounded-read", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 1 } },
      { id: "call-search", name: "core.search.text", input: { pattern: "more local context", glob: "README.md", outputMode: "content", contextLines: 1 } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "keep searching after a first narrow read from invalid mutation recovery",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: reviewedEvidenceMutationPolicy({ includeFocusedSearch: true, includePatch: true, includeReadInChange: true }),
      limits: { maxModelIterations: 6, maxToolCalls: 8 }
    }));

    assert.equal(workflowGateForModelRequest(events, 2)?.requiredNextAction, "focused-read-or-source-edit-or-bounded-blocker");
    assert.deepEqual(gateway.visibleToolNamesForRequest(2), ["core_file_edit", "core_file_read", "core_patch_apply", "core_search_text"]);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.search.text" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\nmore local context\n");
    await kernel.shutdown();
  });

  it("does not reopen focused reads after a no-op mutation follows refreshed evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-placeholder-edit", name: "core.file.edit", input: { path: "README.md", expected: "placeholder", replacement: "placeholder" } },
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-noop-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "stage evidence" } },
      { id: "call-extra-read", name: "core.file.read", input: { path: "README.md", offset: 1, limit: 20 } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "do not reopen evidence refresh after a no-op edit follows refreshed evidence",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy(),
      limits: { maxModelIterations: 5, maxToolCalls: 7 }
    }));

    assert.equal(workflowGateForModelRequest(events, 2)?.requiredNextAction, "core.file.edit");
    assert.equal(workflowGateForModelRequest(events, 3)?.requiredNextAction, "core.file.edit");
    assert.deepEqual(gateway.visibleToolNamesForRequest(3), ["core_file_edit"]);
    assert.equal(events.some((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.requestedCapabilityId === "core.file.read" &&
      event.data.iteration === 4
    ), true);
    await kernel.shutdown();
  });

  it("requires patch-only after a no-op mutation follows refreshed evidence when patch is available", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-placeholder-edit", name: "core.file.edit", input: { path: "README.md", expected: "placeholder", replacement: "placeholder" } },
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-noop-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "stage evidence" } },
      { id: "call-extra-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "switch to patch after no-op edit follows refreshed evidence",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy({ includePatch: true }),
      limits: { maxModelIterations: 5, maxToolCalls: 7 }
    }));

    assert.equal(workflowGateForModelRequest(events, 3)?.requiredNextAction, "core.patch.apply");
    assert.deepEqual(gateway.visibleToolNamesForRequest(3), ["core_patch_apply"]);
    assert.equal(events.some((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.requestedCapabilityId === "core.file.edit" &&
      event.data.iteration === 4
    ), true);
    await kernel.shutdown();
  });

  it("reopens exact edit recovery after a patch-only recovery hunk fails", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-placeholder-edit", name: "core.file.edit", input: { path: "README.md", expected: "placeholder", replacement: "placeholder" } },
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-noop-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "stage evidence" } },
      {
        id: "call-stale-patch",
        name: "core.patch.apply",
        input: {
          patch: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-missing evidence\n+changed evidence\n"
        }
      },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "recover with exact edit after patch-only recovery has stale context",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy({ includePatch: true }),
      limits: { maxModelIterations: 7, maxToolCalls: 9 }
    }));

    assert.equal(workflowGateForModelRequest(events, 3)?.requiredNextAction, "core.patch.apply");
    assert.deepEqual(gateway.visibleToolNamesForRequest(3), ["core_patch_apply"]);
    assert.equal(workflowGateForModelRequest(events, 4)?.requiredNextAction, "core.patch.apply|core.file.edit");
    assert.deepEqual(gateway.visibleToolNamesForRequest(4), ["core_file_edit", "core_patch_apply"]);
    assert.equal(events.some((event) =>
      event.kind === "agent.loop.failed" &&
      event.data.reason === "workflow-mutation-input-stalled"
    ), false);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("reopens exact edit recovery after a patch-only malformed patch", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-placeholder-edit", name: "core.file.edit", input: { path: "README.md", expected: "placeholder", replacement: "placeholder" } },
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-noop-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "stage evidence" } },
      { id: "call-malformed-patch", name: "core.patch.apply", input: { patch: "a/dummy\nb/dummy\n" } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "recover with exact edit after patch-only malformed patch",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy({ includePatch: true }),
      limits: { maxModelIterations: 7, maxToolCalls: 9 }
    }));

    assert.equal(workflowGateForModelRequest(events, 3)?.requiredNextAction, "core.patch.apply");
    assert.deepEqual(gateway.visibleToolNamesForRequest(3), ["core_patch_apply"]);
    assert.equal(workflowGateForModelRequest(events, 4)?.requiredNextAction, "core.patch.apply|core.file.edit");
    assert.deepEqual(gateway.visibleToolNamesForRequest(4), ["core_file_edit", "core_patch_apply"]);
    assert.equal(events.some((event) =>
      event.kind === "agent.loop.failed" &&
      event.data.reason === "workflow-mutation-input-stalled"
    ), false);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("reopens exact edit recovery after stale edit context is followed by a no-op edit", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-placeholder-edit", name: "core.file.edit", input: { path: "README.md", expected: "placeholder", replacement: "placeholder" } },
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-stale-edit", name: "core.file.edit", input: { path: "README.md", expected: "missing evidence", replacement: "changed evidence" } },
      { id: "call-exact-refresh", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 20 } },
      { id: "call-noop-after-nearest", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "stage evidence" } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "recover with nearest context after stale edit and no-op retry",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy({ includePatch: true }),
      limits: { maxModelIterations: 8, maxToolCalls: 10 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "agent.loop.failed" &&
      event.data.reason === "workflow-mutation-input-stalled"
    ), false);
    assert.equal(workflowGateForModelRequest(events, 5)?.requiredNextAction, "core.patch.apply|core.file.edit");
    assert.deepEqual(gateway.visibleToolNamesForRequest(5), ["core_file_edit", "core_patch_apply"]);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("requires patch-only instead of fail-closed after refreshed evidence in a reviewed mutation stage", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\nlocal context\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-placeholder-edit", name: "core.file.edit", input: { path: "README.md", expected: "placeholder", replacement: "placeholder" } },
      { id: "call-search-refresh", name: "core.search.text", input: { pattern: "local context", glob: "README.md", outputMode: "content", contextLines: 1 } },
      { id: "call-bounded-read", name: "core.file.read", input: { path: "README.md", offset: 0, limit: 2 } },
      { id: "call-noop-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "stage evidence" } },
      { id: "call-extra-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "switch reviewed mutation recovery to patch after refreshed no-op edit",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: reviewedEvidenceMutationPolicy({ includeFocusedSearch: true, includePatch: true, includeReadInChange: true }),
      limits: { maxModelIterations: 7, maxToolCalls: 9 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "agent.loop.failed" &&
      event.data.reason === "workflow-mutation-input-stalled"
    ), false);
    assert.equal(workflowGateForModelRequest(events, 4)?.requiredNextAction, "core.patch.apply");
    assert.deepEqual(gateway.visibleToolNamesForRequest(4), ["core_patch_apply"]);
    assert.equal(events.some((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.requestedCapabilityId === "core.file.edit" &&
      event.data.iteration === 5
    ), true);
    await kernel.shutdown();
  });

  it("allows one bounded read after search refresh before forcing mutation", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\nlocal context\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-placeholder-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "stage evidence" } },
      { id: "call-search-refresh", name: "core.search.text", input: { pattern: "local context", glob: "README.md", outputMode: "content", contextLines: 1 } },
      { id: "call-bounded-read", name: "core.file.read", input: { path: "README.md", offset: 1, limit: 20 } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "allow precise bounded read after search refresh before mutating",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy({ includeFocusedSearch: true, includePatch: true }),
      limits: { maxModelIterations: 6, maxToolCalls: 8 }
    }));

    assert.equal(workflowGateForModelRequest(events, 2)?.requiredNextAction, "focused-read-or-source-edit-or-bounded-blocker");
    assert.equal(events.some((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.requestedCapabilityId === "core.file.read" &&
      event.data.iteration === 3
    ), false);
    assert.equal(workflowGateForModelRequest(events, 3)?.requiredNextAction, "core.file.edit|core.patch.apply");
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\nlocal context\n");
    await kernel.shutdown();
  });

  it("does not treat truncated unbounded source reads as refreshed mutation evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", `${"stage evidence\n".repeat(1_200)}target evidence\n`);
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-placeholder-edit", name: "core.file.edit", input: { path: "README.md", expected: "placeholder", replacement: "placeholder" } },
      { id: "call-unbounded-read", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-noop-edit", name: "core.file.edit", input: { path: "README.md", expected: "target evidence", replacement: "target evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "do not mark truncated whole-file reads as mutation evidence refresh",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: reviewedEvidenceMutationPolicy({ includePatch: true, includeReadInChange: true }),
      limits: { maxModelIterations: 5, maxToolCalls: 7 }
    }));

    assert.equal(workflowGateForModelRequest(events, 2)?.terminalKind, "workflow-invalid-mutation-intent.rejected");
    assert.notEqual(workflowGateForModelRequest(events, 3)?.terminalKind, "workflow-mutation-repair.refreshed");
    assert.equal(events.some((event) =>
      event.kind === "agent.loop.failed" &&
      event.data.reason === "workflow-mutation-input-stalled"
    ), true);
    await kernel.shutdown();
  });

  it("does not treat empty focused search as refreshed mutation evidence", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-noop-edit-1", name: "core.file.edit", input: { path: "README.md", expected: "placeholder", replacement: "placeholder" } },
      { id: "call-empty-search", name: "core.search.text", input: { pattern: "missing symbol", glob: "README.md", outputMode: "content", contextLines: 1 } },
      { id: "call-noop-edit-2", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "stage evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "do not mark empty search as mutation evidence refresh",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: reviewedEvidenceMutationPolicy({ includeFocusedSearch: true, includePatch: true, includeReadInChange: true }),
      limits: { maxModelIterations: 5, maxToolCalls: 7 }
    }));

    assert.equal(workflowGateForModelRequest(events, 2)?.terminalKind, "workflow-invalid-mutation-intent.rejected");
    assert.notEqual(workflowGateForModelRequest(events, 3)?.terminalKind, "workflow-mutation-repair.refreshed");
    assert.equal(events.some((event) =>
      event.kind === "agent.loop.failed" &&
      event.data.reason === "workflow-mutation-input-stalled"
    ), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "stage evidence\n");
    await kernel.shutdown();
  });

  it("fails closed after repeated preflight no-op edits in a reviewed mutation stage", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-noop-edit-1", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "stage evidence" } },
      { id: "call-noop-edit-2", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "stage evidence" } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "stop repeated no-op edits after reviewed evidence",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: reviewedEvidenceMutationPolicy({ includePatch: true }),
      limits: { maxModelIterations: 5, maxToolCalls: 7 }
    }));

    assert.equal(events.some((event) =>
      event.kind === "capability.started" &&
      event.data.toolCallId === "call-real-edit"
    ), false);
    assert.equal(events.some((event) =>
      event.kind === "agent.loop.failed" &&
      event.data.reason === "workflow-mutation-input-stalled"
    ), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "stage evidence\n");
    await kernel.shutdown();
  });

  it("keeps edit recovery after a no-op file edit when patch is available", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-noop-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "stage evidence" } },
      { id: "call-real-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "recover from no-op edit with a real edit",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: reviewedEvidenceMutationPolicy({ includePatch: true }),
      limits: { maxModelIterations: 4, maxToolCalls: 6 }
    }));

    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "core.file.edit");
    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit"]);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("keeps edit recovery after a failed patch is followed by a no-op edit", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      {
        id: "call-stale-patch",
        name: "core.patch.apply",
        input: {
          patch: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-missing evidence\n+changed evidence\n"
        }
      },
      { id: "call-noop-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "stage evidence" } },
      { id: "call-fresh-edit", name: "core.file.edit", input: { path: "README.md", expected: "stage evidence", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "recover from failed patch using exact edit context",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: reviewedEvidenceMutationPolicy({ includePatch: true }),
      limits: { maxModelIterations: 5, maxToolCalls: 7 }
    }));

    assert.equal(workflowGateForModelRequest(events, 2)?.requiredNextAction, "core.file.edit");
    assert.deepEqual(gateway.visibleToolNamesForRequest(2), ["core_file_edit"]);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("does not convert retryable provider failures into workflow required-action misses", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "before\n");
    const gateway = new RetryableErrorThenEditModelGateway();
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "continue after provider transport overload",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy(),
      selfRepair: { enabled: true, maxAttempts: 1, requireCheckpointForWrites: false, verificationMode: "minimal" },
      limits: { maxModelIterations: 3, maxToolCalls: 4, maxRepairAttempts: 1 }
    }));

    assert.equal(events.some((event) => event.kind === "runtime.error" && event.error?.code === "PROVIDER_TRANSPORT_FAILED"), true);
    assert.equal(events.some((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.iteration === 1
    ), false);
    assert.equal(gateway.requests.length >= 2, true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "after\n");
    await kernel.shutdown();
  });

  it("allows only one review response after a ready-stage model budget is spent", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-read-1", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-read-2", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-read-after-review", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-read-should-not-run", name: "core.file.read", input: { path: "README.md" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "do not keep spending the same produce stage budget",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy(),
      limits: {
        maxModelIterations: 8,
        maxToolCalls: 8,
        stageBudgets: [{
          stageKind: "produce",
          maxModelIterations: 2,
          stopReason: "test-produce-stage-budget"
        }]
      }
    }));

    assert.equal(events.filter((event) => event.kind === "model.requested").length, 3);
    assert.equal(gateway.requests.length, 3);
    assert.equal(events.some((event) =>
      event.kind === "agent.loop.budget.consumed" &&
      event.data.kind === "ready-stage-model-iterations" &&
      event.data.stopReason === "test-produce-stage-budget"
    ), true);
    assert.equal(events.some((event) =>
      event.kind === "agent.loop.failed" &&
      event.data.reason === "test-produce-stage-budget"
    ), true);
    await kernel.shutdown();
  });
});

class SequentialToolCallModelGateway implements ModelGateway {
  private index = 0;
  readonly requests: ModelRequest[] = [];

  constructor(private readonly calls: readonly { readonly id: string; readonly name: string; readonly input: JsonObject }[]) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const call = this.calls[this.index];
    this.index += 1;
    if (call) {
      yield { kind: "tool-call", id: call.id, name: call.name, input: call.input };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: "done" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }

  visibleToolNamesForRequest(index: number): readonly string[] {
    return (this.requests[index]?.tools ?? [])
      .map((tool) => {
        const fn = (tool as JsonObject).function as JsonObject | undefined;
        return typeof fn?.name === "string" ? fn.name : "";
      })
      .filter(Boolean)
      .sort();
  }

}

class RetryableErrorThenEditModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield {
        kind: "error",
        error: {
          code: "PROVIDER_TRANSPORT_FAILED",
          message: "provider overloaded",
          retryable: true,
          redaction: { class: "public" }
        }
      };
      return;
    }
    if (this.requests.length > 2) {
      yield { kind: "delta", text: "Recovered after provider retry." };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield {
      kind: "tool-call",
      id: "call-edit-after-provider-error",
      name: "core.file.edit",
      input: { path: "README.md", expected: "before", replacement: "after" }
    };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

function workflowGateForModelRequest(events: readonly { readonly kind: string; readonly data: JsonObject }[], index: number): JsonObject | undefined {
  const request = events.filter((event) => event.kind === "model.requested").at(index);
  return ((request?.data.profilePolicy as JsonObject | undefined)?.workflowGateOverride as JsonObject | undefined);
}

function jsonObjectField(object: JsonObject | undefined, key: string): JsonObject | undefined {
  const value = object?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function failureAnalysisRecords(shared: JsonObject | undefined): readonly JsonObject[] {
  const records = shared?.failureAnalysisRecords;
  return Array.isArray(records)
    ? records.filter((record): record is JsonObject => Boolean(record) && typeof record === "object" && !Array.isArray(record))
    : [];
}

function requestMessagesText(request: ModelRequest | undefined): string {
  return (request?.messages ?? [])
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
    .join("\n");
}

class AllowAllPolicyEngine implements PolicyEngine {
  async decide(_request: PolicyRequest): Promise<PolicyDecision> {
    return {
      action: "allow",
      reason: "test policy",
      audit: {},
      sandboxProfile: "none"
    };
  }
}

function mutationReadyPolicy(options: { readonly includeFocusedSearch?: boolean; readonly includePatch?: boolean } = {}): AgentLoopProfilePolicyMetadata {
  const allowedTools = [
    "core.file.read",
    ...(options.includeFocusedSearch ? ["core.search.text"] : []),
    "core.file.edit",
    ...(options.includePatch ? ["core.patch.apply"] : [])
  ];
  return {
    schemaVersion: "1.0.0",
    profileId: "test/mutation-repair-routing.v1",
    role: "evaluation-workflow",
    workflowGraphId: "workflow/test.mutation-repair-routing.v1",
    workflowPriority: "primary",
    orchestrationMode: "staged-capability-workflow",
    workflowCapabilityIds: allowedTools,
    toolProjectionSource: "profile",
    stageAcceptanceMode: "supervisor",
    antiTailoring: false,
    executionBoundary: "governed-capabilities",
    redaction: { class: "internal" },
    stagedTaskWorkflow: {
      schemaVersion: "1.0.0",
      profileId: "test/mutation-repair-routing.v1",
      graphId: "graph:test.mutation-repair-routing",
      fingerprint: "fnv1a:mutation-repair-routing",
      stageCount: 1,
      refCount: 1,
      executorKinds: ["agent-loop"],
      graph: {
        schemaVersion: "1.0.0",
        graphId: "graph:test.mutation-repair-routing",
        profileId: "test/mutation-repair-routing.v1",
        stages: [{
          schemaVersion: "1.0.0",
          stageId: "stage:change",
          kind: "produce",
          executorKind: "agent-loop",
          dependsOn: [],
          inputRefs: [],
          expectedOutputRefs: ["ref:change"],
          allowedTools,
          compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
          redaction: { class: "internal" }
        }],
        refs: [{
          schemaVersion: "1.0.0",
          refId: "ref:change",
          type: "artifact",
          producerStageId: "stage:change",
          scope: "task",
          compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
          redaction: { class: "internal" }
        }],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      runState: {
        schemaVersion: "1.0.0",
        taskRunId: "staged:graph:test.mutation-repair-routing",
        graphId: "graph:test.mutation-repair-routing",
        profileId: "test/mutation-repair-routing.v1",
        stageStates: [{
          stageId: "stage:change",
          status: "ready",
          attempts: 0,
          inputRefs: [],
          outputRefs: [],
          diagnostics: []
        }],
        refs: [],
        events: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      },
      redaction: { class: "internal" }
    }
  };
}

function readThenMutationPolicy(): AgentLoopProfilePolicyMetadata {
  return {
    ...mutationReadyPolicy(),
    workflowGraphId: "workflow/test.read-then-mutation-routing.v1",
    stagedTaskWorkflow: {
      ...mutationReadyPolicy().stagedTaskWorkflow!,
      graphId: "graph:test.read-then-mutation-routing",
      fingerprint: "fnv1a:read-then-mutation-routing",
      stageCount: 2,
      graph: {
        ...mutationReadyPolicy().stagedTaskWorkflow!.graph,
        graphId: "graph:test.read-then-mutation-routing",
        stages: [
          {
            schemaVersion: "1.0.0",
            stageId: "stage:understand",
            kind: "collect-evidence",
            executorKind: "agent-loop",
            dependsOn: [],
            inputRefs: [],
            expectedOutputRefs: ["ref:understand"],
            allowedTools: ["core.file.read"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            stageId: "stage:change",
            kind: "produce",
            executorKind: "agent-loop",
            dependsOn: ["stage:understand"],
            inputRefs: ["ref:understand"],
            expectedOutputRefs: ["ref:change"],
            allowedTools: ["core.file.edit"],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          }
        ],
        refs: [
          {
            schemaVersion: "1.0.0",
            refId: "ref:understand",
            type: "evidence",
            producerStageId: "stage:understand",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          },
          {
            schemaVersion: "1.0.0",
            refId: "ref:change",
            type: "artifact",
            producerStageId: "stage:change",
            scope: "task",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal" }
          }
        ]
      },
      runState: {
        schemaVersion: "1.0.0",
        taskRunId: "staged:graph:test.read-then-mutation-routing",
        graphId: "graph:test.read-then-mutation-routing",
        profileId: "test/mutation-repair-routing.v1",
        stageStates: [
          {
            stageId: "stage:understand",
            status: "ready",
            attempts: 0,
            inputRefs: [],
            outputRefs: [],
            diagnostics: []
          },
          {
            stageId: "stage:change",
            status: "pending",
            attempts: 0,
            inputRefs: ["ref:understand"],
            outputRefs: [],
            diagnostics: []
          }
        ],
        refs: [],
        events: [],
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal" }
      }
    }
  };
}

function readThenMutationPolicyWithPatch(): AgentLoopProfilePolicyMetadata {
  const policy = readThenMutationPolicy();
  const workflow = policy.stagedTaskWorkflow!;
  return {
    ...policy,
    workflowCapabilityIds: ["core.file.read", "core.file.edit", "core.patch.apply"],
    stagedTaskWorkflow: {
      ...workflow,
      graph: {
        ...workflow.graph,
        stages: workflow.graph.stages.map((stage) =>
          stage.stageId === "stage:change"
            ? { ...stage, allowedTools: ["core.file.edit", "core.patch.apply"] }
            : stage
        )
      }
    }
  };
}

function reviewedEvidenceMutationPolicy(options: { readonly includeFocusedSearch?: boolean; readonly includePatch?: boolean; readonly includeReadInChange?: boolean } = {}): AgentLoopProfilePolicyMetadata {
  const policy = readThenMutationPolicy();
  const workflow = policy.stagedTaskWorkflow!;
  return {
    ...policy,
    workflowCapabilityIds: [
      "core.file.read",
      ...(options.includeFocusedSearch ? ["core.search.text"] : []),
      "core.file.edit",
      ...(options.includePatch ? ["core.patch.apply"] : [])
    ],
    stagedTaskWorkflow: {
      ...workflow,
      graph: {
        ...workflow.graph,
        stages: workflow.graph.stages.map((stage) =>
          stage.stageId === "stage:change"
            ? {
              ...stage,
              allowedTools: [
                ...(options.includeReadInChange ? ["core.file.read"] : []),
                "core.file.edit",
                ...(options.includePatch ? ["core.patch.apply"] : []),
                ...(options.includeFocusedSearch ? ["core.search.text"] : [])
              ]
            }
            : stage
        )
      },
      runState: {
        ...workflow.runState,
        stageStates: [
          {
            stageId: "stage:understand",
            status: "running",
            attempts: 1,
            inputRefs: [],
            outputRefs: ["ref:understand"],
            evaluation: {
              schemaVersion: "1.0.0",
              evaluationId: "evaluation:stage:understand:reviewed",
              stageId: "stage:understand",
              evaluatorId: "runtime:test",
              status: "needs-review",
              reason: "Reviewed evidence is sufficient to drive downstream mutation.",
              evidenceRefs: ["ref:understand"],
              evaluatedAt: "2026-07-06T00:00:00.000Z",
              compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
              redaction: { class: "internal" }
            },
            diagnostics: []
          },
          {
            stageId: "stage:change",
            status: "pending",
            attempts: 0,
            inputRefs: ["ref:understand"],
            outputRefs: [],
            diagnostics: []
          }
        ]
      }
    }
  };
}

function officialDiagnosticMutationPolicy(): AgentLoopProfilePolicyMetadata {
  const policy = reviewedEvidenceMutationPolicy({
    includeFocusedSearch: true,
    includePatch: true,
    includeReadInChange: true
  });
  const workflow = policy.stagedTaskWorkflow!;
  const diagnosticRef = {
    schemaVersion: "1.0.0" as const,
    refId: "ref:official-diagnostic",
    type: "diagnostic" as const,
    producerStageId: "stage:understand",
    scope: "task" as const,
    compatibility: { schemaVersion: "1.0.0" as const, minReaderVersion: "1.0.0" as const },
    redaction: { class: "internal" as const }
  };
  return {
    ...policy,
    workflowGovernanceMode: "evaluation",
    stagedTaskWorkflow: {
      ...workflow,
      refCount: workflow.refCount + 1,
      graph: {
        ...workflow.graph,
        refs: [...workflow.graph.refs, diagnosticRef],
        stages: workflow.graph.stages.map((stage) =>
          stage.stageId === "stage:change"
            ? { ...stage, inputRefs: [...stage.inputRefs, diagnosticRef.refId] }
            : stage
        )
      },
      runState: {
        ...workflow.runState,
        refs: [...workflow.runState.refs, diagnosticRef],
        stageStates: workflow.runState.stageStates.map((stage) =>
          stage.stageId === "stage:change"
            ? { ...stage, inputRefs: [...stage.inputRefs, diagnosticRef.refId] }
            : stage
        )
      }
    }
  };
}
