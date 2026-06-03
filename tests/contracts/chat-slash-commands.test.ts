import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeDependencies, RuntimeKernel, SessionEvent } from "@deepseek/platform-contracts";
import { INTERACTION_MODE_COMPATIBILITY, INTERACTION_MODE_SCHEMA_VERSION, asId } from "@deepseek/platform-contracts";
import { createDefaultRuntimeKernel, registerRuntimeCoreTools } from "@deepseek/runtime";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";
import { parseCliArgs, runCli } from "../../src/apps/cli/src/index.js";
import { runChatCommand } from "../../src/apps/cli/src/commands/chat.js";
import { resolveInjectedChatPluginSlashCommand } from "../../src/apps/cli/src/commands/chat-builtin-plugin-slash.js";
import type { CliTerminalCapabilityProfile } from "../../src/apps/cli/src/host/terminal-profile.js";

interface ChatHarness {
  readonly deps: RuntimeDependencies;
  readonly kernel: RuntimeKernel;
  readonly lines: string[];
  modelCallCount: number;
}

async function buildHarness(): Promise<ChatHarness> {
  const deps = createDeterministicRuntimeDependencies();
  await registerRuntimeCoreTools(deps, process.cwd());
  const kernel = await createDefaultRuntimeKernel(deps);
  const harness: ChatHarness = { deps, kernel, lines: [], modelCallCount: 0 };
  const originalStream = deps.models.stream.bind(deps.models);
  deps.models.stream = (request) => {
    harness.modelCallCount += 1;
    return originalStream(request);
  };
  return harness;
}

async function runChatLines(harness: ChatHarness, inputs: readonly string[], output: "text" | "jsonl" = "text", extraArgs: readonly string[] = []): Promise<string[]> {
  harness.lines.length = 0;
  await runCli(
    ["chat", ...extraArgs, "--output", output],
    (line) => { harness.lines.push(line); },
    (async function* () { for (const line of inputs) yield `${line}\n`; })(),
    { stdinIsTTY: false, stdoutIsTTY: false },
    { createRuntime: async () => ({ deps: harness.deps, kernel: harness.kernel }) }
  );
  return [...harness.lines];
}

function interactionModeEvent(sessionId: string, sequence: number, nextMode: string): SessionEvent {
  return {
    sessionId: asId<"session">(sessionId),
    sequence,
    kind: "mode.interaction.changed",
    at: new Date(0).toISOString(),
    payload: {
      schemaVersion: INTERACTION_MODE_SCHEMA_VERSION,
      transitionId: `interaction-transition:test:${sequence}`,
      sessionId,
      previousMode: "chat",
      nextMode,
      reason: "resume-restore",
      initiator: "test",
      at: new Date(0).toISOString(),
      diagnostics: [],
      redaction: { class: "internal" },
      compatibility: INTERACTION_MODE_COMPATIBILITY
    },
    redaction: { class: "internal" }
  };
}

describe("chat slash commands", () => {
  it("renders basic vi-inspired TUI status and prompt only for text TTY line input", async () => {
    const harness = await buildHarness();
    const lines: string[] = [];
    const inline: string[] = [];
    const terminalProfile: CliTerminalCapabilityProfile = {
      rendererProfile: "interactive",
      inputStrategy: "line",
      stdinIsTTY: true,
      stdoutIsTTY: true,
      isCI: false,
      platform: "win32",
      columns: 120,
      colorDepth: "truecolor",
      unicode: "unicode",
      rawInput: true,
      inlineText: true,
      reasons: ["renderer:interactive", "input:line"]
    };

    await runChatCommand(
      parseCliArgs(["chat"]),
      async (line) => { lines.push(line); },
      async (chunk) => { inline.push(chunk); },
      false,
      (async function* () {
        yield "/help\n";
        yield "hello tui\n";
        yield "/exit\n";
      })(),
      terminalProfile,
      { createRuntime: async () => ({ deps: harness.deps, kernel: harness.kernel }) }
    );

    assert.equal(lines.some((line) => line.startsWith("Workbench [ready]") && line.includes("focus=transcript")), true);
    assert.equal(lines.some((line) => line.includes("Keys | / commands | Tab next panel")), true);
    assert.equal(lines.some((line) => line.includes("Panels |") && line.includes("plugins=ready")), true);
    assert.equal(inline.filter((chunk) => chunk === "deepseek> ").length >= 3, true, `expected prompt redraws, got ${JSON.stringify(inline)}`);
    assert.equal(harness.modelCallCount, 1);
  });

  it("keeps scripted and structured chat output prompt-free", async () => {
    const harness = await buildHarness();
    const scripted = await runChatLines(harness, ["hello scripted", "/exit"]);
    assert.equal(scripted.some((line) => line.includes("deepseek> ")), false);
    assert.equal(scripted.some((line) => line.includes("composition=vi-minimal")), false);
    assert.equal(scripted.some((line) => line.includes("DeepSeek Workbench")), false);

    const jsonl = await runChatLines(harness, ["/help", "/exit"], "jsonl");
    assert.equal(jsonl.some((line) => line.includes("deepseek> ")), false);
    assert.equal(jsonl.every((line) => JSON.parse(line)), true);
  });

  it("/help lists controls and does not call the model", async () => {
    const harness = await buildHarness();
    const lines = await runChatLines(harness, ["/help", "/exit"]);
    assert.equal(harness.modelCallCount, 0, `help must not call model, lines=${JSON.stringify(lines)}`);
    assert.equal(lines.some((line) => line === "Chat controls:"), true);
    assert.equal(lines.some((line) => line.startsWith("  /help")), true);
    assert.equal(lines.some((line) => line.startsWith("  /cost")), true);
    assert.equal(lines.some((line) => line.startsWith("  /model")), true);
    assert.equal(lines.some((line) => line.includes("/mode|/agent|/workers|/verify|/plan")), true);
    assert.equal(lines.some((line) => line.includes("/file list|preview|refs <query>")), true);
    assert.equal(lines.some((line) => line.includes("/jump file|text|symbol <query>")), true);
  });

  it("/clear renders ANSI clear sequence without invoking runtime", async () => {
    const harness = await buildHarness();
    const lines = await runChatLines(harness, ["/clear", "/exit"]);
    assert.equal(harness.modelCallCount, 0);
    assert.equal(lines.some((line) => line.includes("\x1B[2J")), true, `expected ANSI clear, got ${JSON.stringify(lines)}`);
  });

  it("/cost reports zero usage before any turn", async () => {
    const harness = await buildHarness();
    const lines = await runChatLines(harness, ["/cost", "/exit"]);
    assert.equal(harness.modelCallCount, 0);
    assert.equal(lines.some((line) => line.startsWith("[chat] tokens in=0 out=0")), true);
  });

  it("/model reports active profile", async () => {
    const harness = await buildHarness();
    const lines = await runChatLines(harness, ["/model", "/exit"]);
    assert.equal(harness.modelCallCount, 0);
    assert.equal(lines.some((line) => line.startsWith("[chat] model=") && line.includes("provider=")), true);
    assert.equal(lines.some((line) => line.includes("reasoning_support")), true);
    assert.equal(lines.some((line) => line.includes("orchestration evidence_loops=")), true);
  });

  it("/mode, /agent, /workers, /verify, and /plan stay local before any turn", async () => {
    const harness = await buildHarness();
    const lines = await runChatLines(harness, ["/mode", "/agent", "/workers", "/verify", "/plan", "/exit"]);
    assert.equal(harness.modelCallCount, 0);
    assert.equal(lines.some((line) => line.startsWith("mode: interaction=chat agent=default")), true);
    assert.equal(lines.some((line) => line.startsWith("agent: mode=default")), true);
    assert.equal(lines.some((line) => line === "workers: none"), true);
    assert.equal(lines.some((line) => line.startsWith("verify: verdicts=0")), true);
    assert.equal(lines.some((line) => line === "plan: none"), true);
  });

  it("/mode unsupported transition is typed and preserves prior local mode", async () => {
    const harness = await buildHarness();
    const lines = await runChatLines(harness, ["/mode remote-unsafe-test", "/mode", "/exit"]);
    assert.equal(harness.modelCallCount, 0);
    assert.equal(lines.some((line) => line.includes("mode transition unsupported: remote-unsafe-test")), true);
    assert.equal(lines.some((line) => line.startsWith("mode: interaction=chat agent=default")), true);
  });

  it("mode controls in JSONL emit structured local command records without ANSI", async () => {
    const harness = await buildHarness();
    const lines = await runChatLines(harness, ["/mode", "/agent", "/workers", "/verify", "/plan", "/mode unsupported", "/exit"], "jsonl");
    assert.equal(harness.modelCallCount, 0);
    const records = lines.map((line) => JSON.parse(line) as { kind?: string; record?: { kind?: string; preservedMode?: string } });
    assert.equal(records.some((record) => record.kind === "chat.command.mode" && record.record?.kind === "mode.status"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.agent" && record.record?.kind === "agent.status"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.workers" && record.record?.kind === "workers.summary"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.verify" && record.record?.kind === "verify.summary"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.plan" && record.record?.kind === "plan.summary"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.mode" && record.record?.kind === "mode.transition.unsupported" && record.record.preservedMode === "chat"), true);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("chat resume restores supported mode state without host degradation", async () => {
    const harness = await buildHarness();
    const sessionId = await harness.deps.sessions.create({ label: "chat-resume-mode" });
    await harness.deps.sessions.append(interactionModeEvent(sessionId, 1, "chat"));
    const lines = await runChatLines(harness, ["/mode", "/exit"], "jsonl", ["--session", sessionId]);
    const records = lines.map((line) => JSON.parse(line) as { kind?: string; record?: { kind?: string; interactionMode?: string; degradationReasons?: readonly string[] } });

    assert.equal(harness.modelCallCount, 0);
    assert.equal(records.some((record) => record.kind === "chat.session.mode-degraded"), false);
    assert.equal(records.some((record) => record.kind === "chat.command.mode" && record.record?.kind === "mode.status" && record.record.interactionMode === "chat"), true);
  });

  it("chat resume degrades unsupported restored modes for the current host profile", async () => {
    const harness = await buildHarness();
    const sessionId = await harness.deps.sessions.create({ label: "chat-resume-unsupported-mode" });
    await harness.deps.sessions.append(interactionModeEvent(sessionId, 1, "interactive"));
    const lines = await runChatLines(harness, ["/mode", "/exit"], "jsonl", ["--session", sessionId]);
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        interactionMode?: string;
        degradationReasons?: readonly string[];
        data?: { mode?: string; previousMode?: string; degradationReasons?: readonly string[] };
      };
    });
    const degradation = records.find((record) => record.kind === "chat.session.mode-degraded");
    const status = records.find((record) => record.kind === "chat.command.mode" && record.record?.kind === "mode.status");

    assert.equal(harness.modelCallCount, 0);
    assert.equal(degradation?.record?.kind, "mode.interaction.degraded");
    assert.equal(degradation?.record?.data?.previousMode, "interactive");
    assert.equal(degradation?.record?.data?.mode, "headless");
    assert.equal(degradation?.record?.data?.degradationReasons?.includes("redirected-io"), true);
    assert.equal(status?.record?.interactionMode, "headless");
    assert.equal(status?.record?.degradationReasons?.includes("raw-input-unavailable"), true);
  });

  it("/cost after a turn sums usage from usage.updated events", async () => {
    const harness = await buildHarness();
    const lines = await runChatLines(harness, ["hello world", "/cost", "/exit"]);
    assert.equal(harness.modelCallCount, 1);
    const cost = lines.find((line) => line.startsWith("[chat] tokens in="));
    assert.ok(cost, `expected /cost line, got ${JSON.stringify(lines)}`);
    assert.equal(cost.includes("out=0"), false, `expected non-zero out tokens in ${cost}`);
  });

  it("mode status after a turn reflects runtime phase, budget, and reasoning events", async () => {
    const harness = await buildHarness();
    const lines = await runChatLines(harness, ["generate html", "/mode", "/plan", "/model", "/exit"]);
    assert.equal(harness.modelCallCount, 2);
    assert.equal(lines.some((line) => line.startsWith("[plan]")), true);
    assert.equal(lines.some((line) => line.startsWith("[verify] verdict=partial")), true);
    assert.equal(lines.some((line) => line.startsWith("mode: interaction=chat agent=default")), true);
    assert.equal(lines.some((line) => line.includes("verification=1/1")), true);
    assert.equal(lines.some((line) => line.startsWith("plan: agent-phase-plan:")), true);
    assert.equal(lines.some((line) => line.includes("mapped=none")), true);
    assert.equal(lines.some((line) => line.includes("verification_loops=1/1")), true);
  });

  it("emits visible reasoning records and final projection for a scripted turn", async () => {
    const harness = await buildHarness();
    const lines = await runChatLines(harness, ["normal prompt", "/exit"], "jsonl");
    const records = lines.map((line) => JSON.parse(line) as { kind?: string; data?: { stepKind?: string; summary?: string; records?: readonly unknown[]; replayFingerprint?: string; visibleReasoning?: unknown } });

    assert.equal(harness.modelCallCount, 1);
    assert.equal(records.some((record) => record.kind === "visible.reasoning.recorded" && record.data?.stepKind === "intent"), true);
    assert.equal(records.some((record) => record.kind === "visible.reasoning.projected" && typeof record.data?.replayFingerprint === "string"), true);
    assert.equal(JSON.stringify(records).includes("rawProviderReasoning"), false);
  });

  it("unknown slash does not reach the model", async () => {
    const harness = await buildHarness();
    const lines = await runChatLines(harness, ["/does-not-exist", "/exit"]);
    assert.equal(harness.modelCallCount, 0);
    assert.equal(lines.some((line) => line === "[chat] unknown command /does-not-exist"), true);
  });

  it("unknown slash in JSONL emits a structured local diagnostic", async () => {
    const harness = await buildHarness();
    const lines = await runChatLines(harness, ["/does-not-exist", "/exit"], "jsonl");
    assert.equal(harness.modelCallCount, 0);
    const records = lines.map((line) => JSON.parse(line) as { kind?: string; command?: string });
    assert.equal(records.some((record) => record.kind === "chat.command.unknown" && record.command === "does-not-exist"), true);
  });

  it("matches injected plugin slash aliases through longest owner route aliases", () => {
    const files = resolveInjectedChatPluginSlashCommand("repo files src");
    const incomplete = resolveInjectedChatPluginSlashCommand("repo");
    const gitStatus = resolveInjectedChatPluginSlashCommand("git status");

    assert.equal(files?.route.commandId, "repo.navigator.files");
    assert.equal(files?.alias, "/repo files");
    assert.deepEqual(files?.args, ["src"]);
    assert.equal(gitStatus?.route.commandId, "git.review.status");
    assert.deepEqual(gitStatus?.args, []);
    assert.equal(incomplete, undefined);
  });

  it("routes first-party plugin slash aliases locally without model dispatch", async () => {
    const harness = await buildHarness();
    const root = process.cwd().replace(/\\/g, "/");
    await harness.deps.platform.writeFile(`${root}/src/plugin-alias.ts`, "export const pluginAliasNeedle = true;\n");
    const lines = await runChatLines(harness, [
      "/repo files plugin-alias",
      "/palette state",
      "/jump symbol pluginAliasNeedle",
      "/palette state",
      "/git status",
      "/checks openspec",
      "/repo files",
      "/exit"
    ], "jsonl");
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        result?: { action?: string; status?: string; itemCount?: number };
        mode?: string;
        resultListId?: string;
        item?: { target?: { kind?: string; path?: string }; metadata?: { symbolName?: string } };
        diagnostic?: { code?: string };
      };
    });

    assert.equal(harness.modelCallCount, 0);
    assert.equal(records.some((record) => record.kind === "chat.command.repo" && record.record?.kind === "repo.navigator.summary" && record.record.result?.action === "files" && record.record.result.status === "completed"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.repo" && record.record?.kind === "repo.navigator.item" && record.record.item?.target?.path?.includes("src/plugin-alias.ts")), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-state" && record.record?.kind === "palette.state" && record.record.mode === "result-list" && record.record.resultListId === "result-list:repo.files"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.jump" && record.record?.kind === "jump.navigator.summary" && record.record.result?.action === "symbol" && record.record.result.status === "completed"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.jump" && record.record?.kind === "jump.navigator.item" && record.record.item?.metadata?.symbolName === "pluginAliasNeedle" && record.record.item.target?.kind === "file"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-state" && record.record?.kind === "palette.state" && record.record.mode === "result-list" && record.record.resultListId === "result-list:jump.symbol"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.git" && record.record?.kind === "git.review.summary" && record.record.result?.action === "status" && record.record.result.status === "completed"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.checks" && record.record?.kind === "dev.check.summary" && record.record.result?.action === "openspec" && record.record.result.status === "completed"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.repo" && record.record?.kind === "repo.navigator.diagnostic" && record.record.diagnostic?.code === "REPO_NAVIGATOR_QUERY_REQUIRED"), true);
    assert.equal(records.some((record) => record.kind === "model.requested" || record.kind === "agent.loop.started"), false);
  });

  it("/cancel with no active turn prints no-op notice", async () => {
    const harness = await buildHarness();
    const lines = await runChatLines(harness, ["/cancel", "/exit"]);
    assert.equal(harness.modelCallCount, 0);
    assert.equal(lines.some((line) => line === "[chat] nothing to cancel"), true);
  });

  it("plain prompt still calls the model", async () => {
    const harness = await buildHarness();
    const lines = await runChatLines(harness, ["normal prompt", "/exit"]);
    assert.equal(harness.modelCallCount, 1);
    assert.equal(lines.some((line) => line.startsWith("[completed]")), true);
  });
});
