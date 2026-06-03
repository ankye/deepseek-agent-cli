import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_TUI_ALT_SCREEN_ENTER,
  CHAT_TUI_ALT_SCREEN_EXIT,
  CHAT_TUI_CLEAR_HOME,
  CHAT_TUI_REPAINT_HOME
} from "../../src/apps/cli/src/commands/chat-tui-workbench-renderer.js";
import {
  createChatTuiState,
  isChatTuiEnabled,
  renderChatTuiFullscreenFrame
} from "../../src/apps/cli/src/commands/chat-tui.js";
import { createTerminalCapabilityProfile } from "../../src/apps/cli/src/host/terminal-profile.js";
import { terminalProfileFixtures } from "../../src/apps/cli/src/host/terminal-fixtures.js";

describe("professional TUI renderer golden replay", () => {
  it("replays full-screen enter, repaint, resize, and teardown lifecycle chunks", () => {
    const state = createChatTuiState({ enabled: true, terminalProfile: fullScreenProfile("linux", 120) });
    const entered = renderChatTuiFullscreenFrame({ workbench: state.workbench, phase: "enter", rows: 24 });
    const repainted = renderChatTuiFullscreenFrame({ workbench: state.workbench, phase: "repaint", rows: 24 });
    const resized = renderChatTuiFullscreenFrame({
      workbench: { ...state.workbench, columns: 96 },
      phase: "resize",
      rows: 18
    });
    const tornDown = renderChatTuiFullscreenFrame({ workbench: state.workbench, phase: "teardown", rows: 24 });

    assert.deepEqual(entered.chunks.slice(0, 2), [CHAT_TUI_ALT_SCREEN_ENTER, CHAT_TUI_CLEAR_HOME]);
    assert.equal(entered.lifecycle.alternateScreen, true);
    assert.equal(entered.lifecycle.cursorVisible, false);
    assert.equal(repainted.chunks[0], CHAT_TUI_REPAINT_HOME);
    assert.equal(repainted.lifecycle.phase, "repaint");
    assert.equal(resized.lifecycle.phase, "resize");
    assert.deepEqual(resized.lifecycle.repaintBounds, { columns: 96, rows: 18 });
    assert.equal((resized.chunks[1] ?? "").split("\n").every((line) => line.length === 96), true);
    assert.deepEqual(tornDown.chunks, [CHAT_TUI_ALT_SCREEN_EXIT]);
    assert.equal(tornDown.lifecycle.alternateScreen, false);
    assert.equal(tornDown.lifecycle.cursorVisible, true);
  });

  it("keeps no-color frame content free of SGR decoration while preserving lifecycle controls", () => {
    const state = createChatTuiState({ enabled: true, terminalProfile: fullScreenProfile("linux", 100, { NO_COLOR: "1" }) });
    const entered = renderChatTuiFullscreenFrame({ workbench: state.workbench, phase: "enter", rows: 20 });
    const frame = entered.chunks.at(-1) ?? "";

    assert.equal(state.terminalProfile.colorDepth, "none");
    assert.equal(entered.chunks.join("").includes(CHAT_TUI_ALT_SCREEN_ENTER), true);
    assert.equal(/\x1b\[[0-9;]*m/.test(frame), false);
    assert.equal(frame.includes("DeepSeek Workbench"), true);
  });

  it("degrades narrow width, CI, redirected output, and structured output to clean non-full-screen profiles", () => {
    const profiles = [
      profileFrom({ command: "chat", output: "text", stdinIsTTY: true, stdoutIsTTY: true, platform: "linux", columns: 48, env: { TERM: "xterm-256color" }, tuiProfile: "full-screen" }),
      profileFrom({ command: "chat", output: "text", stdinIsTTY: true, stdoutIsTTY: true, platform: "linux", columns: 120, env: { CI: "true" }, tuiProfile: "full-screen" }),
      profileFrom({ command: "chat", output: "text", stdinIsTTY: false, stdoutIsTTY: false, platform: "linux", columns: 120, env: {}, tuiProfile: "full-screen" }),
      profileFrom({ command: "chat", output: "json", stdinIsTTY: true, stdoutIsTTY: true, platform: "linux", columns: 120, env: {}, tuiProfile: "full-screen" }),
      profileFrom({ command: "chat", output: "jsonl", stdinIsTTY: true, stdoutIsTTY: true, platform: "linux", columns: 120, env: {}, tuiProfile: "full-screen" })
    ];

    assert.deepEqual(profiles.map((profile) => profile.rendererProfile), ["interactive", "plain", "plain", "json", "jsonl"]);
    assert.deepEqual(profiles.map((profile) => profile.inputStrategy), ["raw", "line", "scripted", "line", "line"]);
    assert.equal(profiles.every((profile) => profile.rendererProfile !== "full-screen"), true);
    assert.equal(isChatTuiEnabled({ output: "text" }, profiles[0]!), true);
    assert.equal(profiles.slice(1).every((profile) => !isChatTuiEnabled({ output: profile.rendererProfile === "json" ? "json" : profile.rendererProfile === "jsonl" ? "jsonl" : "text" }, profile)), true);
  });

  it("keeps Windows, macOS, and Linux full-screen frames deterministic under the same replay contract", () => {
    const frames = ["win32", "darwin", "linux"].map((platform) => {
      const state = createChatTuiState({ enabled: true, terminalProfile: fullScreenProfile(platform, 100) });
      return renderChatTuiFullscreenFrame({ workbench: state.workbench, phase: "repaint", rows: 16 });
    });

    assert.equal(frames.every((frame) => frame.lifecycle.repaintBounds.columns === 100), true);
    assert.equal(frames.every((frame) => frame.lifecycle.repaintBounds.rows === 16), true);
    assert.equal(frames.every((frame) => (frame.chunks[1] ?? "").split("\n").length === 16), true);
    assert.equal(frames.every((frame) => frame.chunks.join("").includes("DeepSeek Workbench")), true);
  });

  it("covers checked-in terminal fixtures without promoting redirected or CI output into full-screen rendering", () => {
    const profiles = terminalProfileFixtures.map((fixture) => ({
      fixture,
      profile: createTerminalCapabilityProfile({
        command: fixture.command,
        output: fixture.output,
        terminal: fixture.terminal,
        input: fixture.terminal.stdinIsTTY ? process.stdin : [],
        facts: { ...fixture.facts, processStdin: process.stdin }
      })
    }));

    assert.equal(profiles.find((entry) => entry.fixture.name === "ci-non-tty")?.profile.rendererProfile, "plain");
    assert.equal(profiles.find((entry) => entry.fixture.name === "redirected-jsonl")?.profile.rendererProfile, "jsonl");
    assert.equal(profiles.find((entry) => entry.fixture.name === "no-color-terminal")?.profile.colorDepth, "none");
    assert.equal(profiles.filter((entry) => entry.profile.rendererProfile === "full-screen").length, 0);
  });
});

function fullScreenProfile(platform: string, columns: number, env: Record<string, string | undefined> = {}) {
  return profileFrom({
    command: "chat",
    output: "text",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    platform,
    columns,
    env: { TERM: "xterm-256color", ...env },
    tuiProfile: "full-screen"
  });
}

function profileFrom(input: {
  readonly command: "chat" | "run";
  readonly output: "text" | "json" | "jsonl";
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly platform: string;
  readonly columns: number;
  readonly env: Record<string, string | undefined>;
  readonly tuiProfile?: "auto" | "line" | "full-screen" | "off";
}) {
  return createTerminalCapabilityProfile({
    command: input.command,
    output: input.output,
    terminal: { stdinIsTTY: input.stdinIsTTY, stdoutIsTTY: input.stdoutIsTTY },
    input: input.stdinIsTTY ? process.stdin : [],
    ...(input.tuiProfile ? { tuiProfile: input.tuiProfile } : {}),
    facts: {
      env: input.env,
      platform: input.platform,
      columns: input.columns,
      colorDepth: input.env.NO_COLOR ? 1 : 24,
      processStdin: process.stdin
    }
  });
}
