import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asId, createVisibleReasoningRecord, projectVisibleReasoning } from "@deepseek/platform-contracts";
import { createChatTuiController } from "../../src/apps/cli/src/commands/chat-tui.js";
import { createInitialChatModeControlState } from "../../src/apps/cli/src/commands/chat-mode-controls.js";
import type { ChatSessionState } from "../../src/apps/cli/src/commands/chat-state.js";
import type { CliTerminalCapabilityProfile } from "../../src/apps/cli/src/host/terminal-profile.js";

describe("chat TUI workbench interaction experience", () => {
  it("renders a coherent startup frame and supports local focus, command, reasoning, and inspector flows", async () => {
    const lines: string[] = [];
    const inline: string[] = [];
    const tui = createChatTuiController({
      enabled: true,
      terminalProfile: interactiveProfile(120),
      write: async (line) => {
        lines.push(line);
      },
      writeInline: async (chunk) => {
        inline.push(chunk);
      }
    });

    await tui.renderStartup(chatState());
    await tui.renderPrompt();
    const resultListFocus = tui.dispatchKey("Tab");
    const reasoningFocus = tui.dispatchKey("r");
    const commandBar = tui.dispatchKey("/");
    const restoredFocus = tui.dispatchKey("Escape");
    await tui.afterTurn(chatState({ turns: 1, visibleReasoning: reasoningProjection() }));
    const snapshot = tui.snapshot();

    assert.equal(lines.some((line) => line.startsWith("Workbench [ready]") && line.includes("layout=balanced")), true);
    assert.equal(lines.some((line) => line.startsWith("Input |") && line.includes("deepseek> _")), true);
    assert.deepEqual(inline, ["deepseek> "]);
    assert.equal(resultListFocus.kind, "focus");
    assert.equal(resultListFocus.focusPanel, "reasoning");
    assert.equal(reasoningFocus.kind, "focus");
    assert.equal(reasoningFocus.focusPanel, "reasoning");
    assert.equal(commandBar.state.workbench.commandBar.open, true);
    assert.equal(commandBar.state.mode, "command");
    assert.equal(restoredFocus.state.workbench.focus.activePanel, "reasoning");
    assert.equal(snapshot.turns, 1);
    assert.equal(snapshot.workbench.reasoningRail.enabled, true);
    assert.equal(snapshot.workbench.inspector.items[0]?.target.id, "check:experience");
  });
});

function chatState(overrides: Partial<ChatSessionState> = {}): ChatSessionState {
  return {
    sessionId: asId<"session">("session-tui-experience"),
    turns: 0,
    usage: { inputTokens: 0, outputTokens: 0, elapsedMs: 0 },
    palette: undefined,
    history: [],
    pageIndex: [],
    selectedHistoryTurnId: undefined,
    revertReviews: [],
    currentRevertReviewId: undefined,
    workspaceDeps: undefined,
    workspaceRoot: "/workspace",
    workspacePageIndexFailure: undefined,
    activeController: undefined,
    pendingExit: false,
    pendingExitTimer: undefined,
    modeControls: createInitialChatModeControlState(asId<"session">("session-tui-experience")),
    visibleReasoning: undefined,
    ...overrides
  };
}

function reasoningProjection() {
  return projectVisibleReasoning([
    createVisibleReasoningRecord({
      sessionId: asId<"session">("session-tui-experience"),
      turnId: asId<"turn">("turn-tui-experience"),
      trace: {
        traceId: asId<"trace">("trace-tui-experience"),
        spanId: asId<"span">("span-tui-experience"),
        correlationId: asId<"correlation">("corr-tui-experience")
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      actor: "runtime",
      stepKind: "verification",
      status: "completed",
      certainty: "verified",
      summary: "Experience flow verified with inspector evidence.",
      evidence: [{
        kind: "check",
        target: { kind: "tool-evidence", id: "check:experience", label: "experience-test" },
        label: "experience-test",
        fingerprint: "check:experience",
        supports: true,
        redaction: { class: "internal" }
      }],
      sequence: 1
    })
  ], { renderer: "tui", detailLevel: "full" });
}

function interactiveProfile(columns: number): CliTerminalCapabilityProfile {
  return {
    rendererProfile: "interactive",
    inputStrategy: "line",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    isCI: false,
    platform: "win32",
    columns,
    colorDepth: "ansi256",
    unicode: "unicode",
    rawInput: true,
    inlineText: true,
    reasons: ["renderer:interactive", "input:line"]
  };
}
