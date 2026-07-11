import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentLoopSummary, AgentPhasePlan, AgentReasoningEffortMapping, AgentVerifierResult, ModelGateway, ModelLiveVerificationRequest, ModelLiveVerificationResult, ModelRequest, ModelStreamEvent } from "@deepseek/platform-contracts";
import { collectRuntimeEvents, createDefaultRuntimeKernel, mapReasoningEffort, registerRuntimeCoreTools, runAgentLoop } from "@deepseek/runtime";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";
import { defaultDeepSeekProfile } from "@deepseek/model-gateway";

describe("agent loop mode orchestration", () => {
  it("records typed skipped phases for a simple single-agent turn", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: "hello",
      caller: "mode-test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const plan = events.find((event) => event.kind === "agent.phase.plan.created")?.data as AgentPhasePlan | undefined;
    assert.equal(plan?.agentMode, "default");
    assert.equal(plan?.phases.some((phase) => phase.phase === "evidence" && phase.status === "skipped" && phase.skipReason === "simple-task"), true);
    assert.equal(plan?.phases.some((phase) => phase.phase === "verify" && phase.status === "skipped" && phase.skipReason === "low-risk"), true);
    assert.equal(events.some((event) => event.kind === "agent.worker.launched"), false);
    await kernel.shutdown();
  });

  it("records evidence phase and consumed evidence budget for fact-sensitive project tasks", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile("/workspace/README.md", "DeepSeek CLI project\n");
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: "介绍当前 DeepSeek CLI 项目",
      caller: "mode-test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const plan = events.find((event) => event.kind === "agent.phase.plan.created")?.data as AgentPhasePlan | undefined;
    assert.equal(plan?.phases.some((phase) => phase.phase === "evidence" && phase.status === "completed"), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.kind === "evidence"), true);
    assert.equal(events.some((event) => event.kind === "evidence.selected"), true);
    await kernel.shutdown();
  });

  it("requires verifier verdict and reconciles generated artifacts without overstating success", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: "生成一个 HTML 网站",
      caller: "mode-test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const plan = events.find((event) => event.kind === "agent.phase.plan.created")?.data as AgentPhasePlan | undefined;
    assert.equal(plan?.phases.some((phase) => phase.phase === "verify" && phase.status === "required" && phase.mode === "verifier"), true);
    const verifier = events.find((event) => event.kind === "agent.verifier.verdict")?.data as AgentVerifierResult | undefined;
    assert.equal(verifier?.verdict, "partial");
    assert.equal(verifier?.diagnostics.some((diagnostic) => diagnostic.code === "VERIFIER_PARTIAL_EVIDENCE"), true);
    assert.equal(events.some((event) => event.kind === "agent.result.reconciled" && event.data.status === "partial"), true);
    const terminal = events.at(-1)?.data as AgentLoopSummary | undefined;
    assert.equal(terminal?.phasePlan?.planId, plan?.planId);
    assert.equal(terminal?.modeSummary?.verifierResults[0]?.verdict, "partial");
    await kernel.shutdown();
  });

  it("fails closed when verifier repair budget exists but self-repair is disabled", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const loopDeps = { ...deps, models: new FailingVerifierModelGateway() };
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "生成一个 HTML 网站",
      caller: "mode-test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      limits: { maxRetries: 1 }
    }));

    const verifier = events.find((event) => event.kind === "agent.verifier.verdict")?.data as AgentVerifierResult | undefined;
    const terminal = events.at(-1);
    assert.equal(verifier?.verdict, "fail");
    assert.equal(events.some((event) => event.kind === "agent.repair.attempted" && event.data.status === "attempted"), true);
    assert.equal(events.some((event) => event.kind === "agent.repair.rerun" && event.data.status === "deferred"), true);
    assert.equal(events.some((event) => event.kind === "agent.result.reconciled" && event.data.status === "fail" && event.data.repairAttemptCount === 1), true);
    assert.equal(events.some((event) => event.kind === "agent.loop.budget.consumed" && event.data.kind === "repair" && event.data.consumed === 1), true);
    assert.equal(terminal?.kind, "agent.loop.failed");
    const summary = terminal?.data as AgentLoopSummary | undefined;
    assert.equal(summary?.modeSummary?.verifierResults[0]?.verdict, "fail");
    await kernel.shutdown();
  });

  it("feeds verifier failure back through self-repair before accepting final completion", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new RepairingVerifierModelGateway();
    const loopDeps = { ...deps, models: gateway };
    await deps.platform.writeFile("/workspace/README.md", "verified repair evidence\n");
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "生成一个 HTML 网站",
      caller: "mode-test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      selfRepair: { enabled: true, maxAttempts: 1, requireCheckpointForWrites: false, verificationMode: "targeted" },
      limits: { maxModelIterations: 4, maxRepairAttempts: 1 }
    }));

    const verifierVerdicts = events
      .filter((event) => event.kind === "agent.verifier.verdict")
      .map((event) => (event.data as AgentVerifierResult).verdict);
    const terminal = events.at(-1)?.data as AgentLoopSummary | undefined;

    assert.deepEqual(verifierVerdicts, ["fail", "pass"]);
    assert.equal(events.some((event) => event.kind === "agent.repair.started"), true);
    assert.equal(events.some((event) => event.kind === "agent.repair.stopped" && event.data.stopReason === "completed"), true);
    assert.equal(gateway.requests.length, 3);
    assert.equal(hasSelfRepairFeedback(gateway.requests[1]), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal(terminal?.selfRepair?.activated, true);
    assert.equal(terminal?.modeSummary?.verifierResults.at(-1)?.verdict, "pass");
    await kernel.shutdown();
  });

  it("credits independent command evidence before reporting verifier pass", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const loopDeps = { ...deps, models: new ReadThenFinishModelGateway() };
    await deps.platform.writeFile("/workspace/README.md", "verified workspace\n");
    await registerRuntimeCoreTools(loopDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(loopDeps);
    const events = await collectRuntimeEvents(runAgentLoop(loopDeps, kernel, {
      prompt: "生成一个 HTML 网站并读取 README 作为验证证据",
      caller: "mode-test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const verifier = events.find((event) => event.kind === "agent.verifier.verdict")?.data as AgentVerifierResult | undefined;
    const terminal = events.at(-1)?.data as AgentLoopSummary | undefined;
    assert.equal(verifier?.verdict, "pass");
    assert.equal((verifier?.commandEvidenceIds.length ?? 0) > 0, true);
    assert.equal(events.some((event) => event.kind === "agent.result.reconciled" && event.data.status === "pass"), true);
    assert.equal(terminal?.modeSummary?.verifierResults[0]?.verdict, "pass");
    await kernel.shutdown();
  });

  it("reports reasoning effort separately from evidence and verification budgets", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(deps);
    const events = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: "hello",
      caller: "mode-test",
      workspaceRoot: "/workspace",
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile,
      reasoning: { enabled: true, effort: "xhigh" }
    }));

    const mapped = events.find((event) => event.kind === "model.reasoning.effort.mapped")?.data as AgentReasoningEffortMapping | undefined;
    const plan = events.find((event) => event.kind === "agent.phase.plan.created")?.data as AgentPhasePlan | undefined;
    assert.equal(mapped?.requestedEffort, "xhigh");
    assert.equal(mapped?.providerEffort, "max");
    assert.equal(plan?.budgets.some((budget) => budget.kind === "evidence" && budget.requested === 0), true);
    assert.equal(plan?.budgets.some((budget) => budget.kind === "verification" && budget.requested === 0), true);
    await kernel.shutdown();
  });

  it("maps DeepSeek low and medium thinking effort to high per provider API contract", () => {
    const low = mapReasoningEffort({
      requested: "low",
      provider: String(defaultDeepSeekProfile.providerId),
      model: defaultDeepSeekProfile.model
    });
    const medium = mapReasoningEffort({
      requested: "medium",
      provider: String(defaultDeepSeekProfile.providerId),
      model: defaultDeepSeekProfile.model
    });

    assert.equal(low.providerEffort, "high");
    assert.equal(medium.providerEffort, "high");
  });
});

class FailingVerifierModelGateway implements ModelGateway {
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    void request;
    yield { kind: "delta", text: "Needs repair." };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }

  async verify(_request: ModelLiveVerificationRequest): Promise<ModelLiveVerificationResult> {
    return {
      ok: false,
      provider: { provider: "deepseek", protocol: "openai-chat-completions", model: defaultDeepSeekProfile.model },
      reachable: true,
      terminalStatus: "failed",
      eventKinds: ["delta", "finish", "done"],
      diagnostics: [{
        code: "TEST_VERIFIER_FAIL",
        message: "Verifier failed by test fixture.",
        retryable: false,
        redaction: { class: "internal" }
      }],
      redaction: { class: "internal" }
    };
  }
}

class RepairingVerifierModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private verifyCalls = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const hasSelfRepairFeedback = requestHasSelfRepairFeedback(request);
    const hasReadEvidence = request.messages?.some((message) => message.role === "tool" && message.toolName === "core.file.read") ?? false;
    if (hasSelfRepairFeedback && !hasReadEvidence) {
      yield { kind: "tool-call", id: "repair-readme", name: "core.file.read", input: { path: "README.md" } };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    if (hasReadEvidence) {
      yield { kind: "delta", text: "Repaired with independent README evidence." };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: "Needs verifier repair." };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }

  async verify(_request: ModelLiveVerificationRequest): Promise<ModelLiveVerificationResult> {
    this.verifyCalls += 1;
    if (this.verifyCalls === 1) {
      return {
        ok: false,
        provider: { provider: "deepseek", protocol: "openai-chat-completions", model: defaultDeepSeekProfile.model },
        reachable: true,
        terminalStatus: "failed",
        eventKinds: ["delta", "finish", "done"],
        diagnostics: [{
          code: "TEST_VERIFIER_FAIL",
          message: "Verifier failed before repair feedback.",
          retryable: false,
          redaction: { class: "internal" }
        }],
        redaction: { class: "internal" }
      };
    }
    return {
      ok: true,
      provider: { provider: "deepseek", protocol: "openai-chat-completions", model: defaultDeepSeekProfile.model },
      reachable: true,
      terminalStatus: "completed",
      eventKinds: ["delta", "finish", "done"],
      diagnostics: [],
      redaction: { class: "internal" }
    };
  }
}

function requestHasSelfRepairFeedback(request: ModelRequest | undefined): boolean {
  return request?.messages?.some((message) =>
    (message.role === "tool" && message.toolName === "agent.self-repair") ||
    (message.role === "system" && message.content.includes("Self-repair failure evidence"))
  ) ?? false;
}

function hasSelfRepairFeedback(request: ModelRequest | undefined): boolean {
  return requestHasSelfRepairFeedback(request);
}

class ReadThenFinishModelGateway implements ModelGateway {
  private requestedRead = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (!this.requestedRead && !request.messages?.some((message) => message.role === "tool")) {
      this.requestedRead = true;
      yield { kind: "tool-call", id: "call-readme", name: "core.file.read", input: { path: "README.md" } };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: "Verified with README evidence." };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}
