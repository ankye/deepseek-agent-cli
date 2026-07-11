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

    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit", "core_file_read", "core_search_text"]);
    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "focused-read-or-source-edit-or-bounded-blocker");
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
    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit", "core_file_read", "core_search_text"]);
    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "focused-read-or-source-edit-or-bounded-blocker");
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.edit" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("allows one focused evidence refresh after a failed mutation precondition", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-edit-stale", name: "core.file.edit", input: { path: "README.md", expected: "missing evidence", replacement: "changed evidence" } },
      { id: "call-refresh-search", name: "core.search.text", input: { pattern: "stage evidence", glob: "README.md", outputMode: "content", contextLines: 1 } },
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

    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit", "core_file_read", "core_search_text"]);
    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "focused-read-or-source-edit-or-bounded-blocker");
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.search.text" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.search.text" &&
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
      { id: "call-repair-read-1", name: "core.file.read", input: { path: "README.md" } },
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
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md" } },
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
      { id: "call-repair-read", name: "core.file.read", input: { path: "README.md" } },
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
    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit", "core_file_read", "core_search_text"]);
    assert.deepEqual(gateway.visibleToolNamesForRequest(3), ["core_file_edit"]);
    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "focused-read-or-source-edit-or-bounded-blocker");
    assert.equal(workflowGateForModelRequest(events, 3)?.requiredNextAction, "core.file.edit");
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.file.edit" &&
      event.data.terminalKind === "capability.completed"
    ), true);
    assert.equal(await deps.platform.readFile("/workspace/README.md"), "changed evidence\n");
    await kernel.shutdown();
  });

  it("requires patch-capable recovery after multiple distinct stale exact edits", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-edit-stale-1", name: "core.file.edit", input: { path: "README.md", expected: "missing one", replacement: "changed evidence" } },
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md" } },
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

    assert.equal(workflowGateForModelRequest(events, 3)?.requiredNextAction, "core.patch.apply|core.file.edit");
    assert.deepEqual(gateway.visibleToolNamesForRequest(3), ["core_file_edit", "core_patch_apply"]);
    await kernel.shutdown();
  });

  it("requires patch-only recovery after repeated distinct stale exact edits", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-edit-stale-1", name: "core.file.edit", input: { path: "README.md", expected: "missing one", replacement: "changed evidence" } },
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-edit-stale-2", name: "core.file.edit", input: { path: "README.md", expected: "missing two", replacement: "changed evidence" } },
      { id: "call-edit-stale-3", name: "core.file.edit", input: { path: "README.md", expected: "missing three", replacement: "changed evidence" } },
      { id: "call-edit-stale-4", name: "core.file.edit", input: { path: "README.md", expected: "missing four", replacement: "changed evidence" } }
    ]);
    const loopDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);

    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "switch to patch-only after repeated stale exact edits",
      caller: "runtime.mutation-repair-routing.test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      toolProjection: "safe-all",
      profilePolicy: mutationReadyPolicy({ includePatch: true }),
      limits: { maxModelIterations: 7, maxToolCalls: 9 }
    }));

    assert.equal(workflowGateForModelRequest(events, 4)?.requiredNextAction, "core.patch.apply");
    assert.deepEqual(gateway.visibleToolNamesForRequest(4), ["core_patch_apply"]);
    assert.equal(events.some((event) =>
      event.kind === "workflow.required-action.missed" &&
      event.data.requestedCapabilityId === "core.file.edit" &&
      event.data.iteration === 5
    ), true);
    await kernel.shutdown();
  });

  it("allows focused context refresh after a stale patch recovery failure", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "stage evidence\n");
    const gateway = new SequentialToolCallModelGateway([
      { id: "call-edit-stale-1", name: "core.file.edit", input: { path: "README.md", expected: "missing one", replacement: "changed evidence" } },
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-edit-stale-2", name: "core.file.edit", input: { path: "README.md", expected: "missing two", replacement: "changed evidence" } },
      { id: "call-edit-stale-3", name: "core.file.edit", input: { path: "README.md", expected: "missing three", replacement: "changed evidence" } },
      { id: "call-patch-stale", name: "core.patch.apply", input: { patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-missing patch\n+changed evidence\n" } },
      { id: "call-read-after-patch-failure", name: "core.file.read", input: { path: "README.md" } },
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

    assert.equal(workflowGateForModelRequest(events, 4)?.requiredNextAction, "core.patch.apply");
    assert.deepEqual(gateway.visibleToolNamesForRequest(4), ["core_patch_apply"]);
    assert.equal(workflowGateForModelRequest(events, 5)?.requiredNextAction, "focused-read-or-source-edit-or-bounded-blocker");
    assert.deepEqual(gateway.visibleToolNamesForRequest(5), ["core_file_edit", "core_file_read", "core_search_text"]);
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
      { id: "call-refresh", name: "core.file.read", input: { path: "README.md" } },
      { id: "call-edit-stale-2", name: "core.file.edit", input: { path: "README.md", expected: "missing two", replacement: "changed evidence" } },
      { id: "call-patch-stale", name: "core.patch.apply", input: { patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-missing patch\n+changed evidence\n" } },
      { id: "call-refresh-after-patch", name: "core.file.read", input: { path: "README.md" } },
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

    assert.equal(workflowGateForModelRequest(events, 2)?.requiredNextAction, "core.patch.apply|core.file.edit");
    assert.deepEqual(gateway.visibleToolNamesForRequest(2), ["core_file_edit", "core_patch_apply"]);
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
      { id: "call-full-read-1", name: "core.file.read", input: { path: "separable.py" } },
      { id: "call-refresh-read-1", name: "core.file.read", input: { path: "separable.py", offset: 0, limit: 20 } },
      { id: "call-noop-edit", name: "core.file.edit", input: { path: "separable.py", expected: "placeholder", replacement: "placeholder" } },
      { id: "call-stale-edit-1", name: "core.file.edit", input: { path: "separable.py", expected: "missing evidence", replacement: correctedBlock } },
      { id: "call-placeholder-edit", name: "core.file.edit", input: { path: "separable.py", expected: currentBlock, replacement: "PLACEHOLDER" } },
      { id: "call-stale-edit-2", name: "core.file.edit", input: { path: "separable.py", expected: "missing evidence", replacement: correctedBlock } },
      {
        id: "call-stale-patch",
        name: "core.patch.apply",
        input: {
          patch: "--- a/separable.py\n+++ b/separable.py\n@@ -99,3 +99,3 @@\n-missing evidence\n+changed evidence\n"
        }
      },
      { id: "call-full-read-2", name: "core.file.read", input: { path: "separable.py" } },
      { id: "call-refresh-read-2", name: "core.file.read", input: { path: "separable.py", offset: 0, limit: 20 } },
      { id: "call-stale-expected-edit", name: "core.file.edit", input: { path: "separable.py", expected: staleExpectedBlock, replacement: correctedBlock } },
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
      { id: "call-refresh-search", name: "core.search.text", input: { pattern: "stage evidence", glob: "README.md", outputMode: "content", contextLines: 1 } },
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

    assert.equal(workflowGateForModelRequest(events, 1)?.requiredNextAction, "focused-read-or-source-edit-or-bounded-blocker");
    assert.deepEqual(gateway.visibleToolNamesForRequest(1), ["core_file_edit", "core_file_read", "core_search_text"]);
    assert.equal(events.some((event) =>
      event.kind === "model.tool.result" &&
      event.data.toolName === "core.search.text" &&
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
    assert.deepEqual(gateway.visibleToolNamesForRequest(2), ["core_file_edit", "core_file_read", "core_search_text"]);
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
    assert.equal(workflowGateForModelRequest(events, 4)?.requiredNextAction, "core.patch.apply|core.file.edit");
    assert.deepEqual(gateway.visibleToolNamesForRequest(4), ["core_file_edit", "core_patch_apply"]);
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
