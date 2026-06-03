import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CliCompositionSnapshot, CliResultList } from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import {
  explainCliPluginContribution,
  rawInputEventToKeyName,
  resolveViKeySequence,
  viProfessionalKeymapProfile
} from "@deepseek/command-system";
import {
  createChatTuiContributionRegistry,
  createChatTuiState,
  dispatchChatTuiInputEvent,
  renderChatTuiFullscreenFrame
} from "../../src/apps/cli/src/commands/chat-tui.js";
import { decodeRawKeyChunk } from "../../src/apps/cli/src/input/raw-keys.js";
import type { CliTerminalCapabilityProfile } from "../../src/apps/cli/src/host/terminal-profile.js";

describe("professional vi TUI contracts", () => {
  it("decodes raw terminal chunks into typed key events", () => {
    const events = decodeRawKeyChunk("j\x04\x1b[A\r\x1b[200~x\x1b[201~");

    assert.deepEqual(events.map((event) => rawInputEventToKeyName(event) ?? event.kind), [
      "j",
      "Ctrl+d",
      "ArrowUp",
      "Enter",
      "paste-start",
      "x",
      "paste-end"
    ]);
    assert.equal(events.every((event) => event.schemaVersion === "1.0.0"), true);
  });

  it("resolves counts, multi-key commands, search/command entry, and leader plugin actions", () => {
    const profile = viProfessionalKeymapProfile();
    const counted = resolveViKeySequence({ mode: "result-list", keys: ["2", "j"], profile });
    const firstPending = resolveViKeySequence({ mode: "result-list", keys: ["g"], profile });
    const firstTimedOut = resolveViKeySequence({ mode: "result-list", keys: ["g"], profile, elapsedMs: 1200, sequenceTimeoutMs: 1000 });
    const first = resolveViKeySequence({ mode: "result-list", keys: ["g", "g"], profile });
    const search = resolveViKeySequence({ mode: "result-list", keys: ["/"], profile });
    const plugin = resolveViKeySequence({ mode: "normal", keys: ["Space", "p"], profile });

    assert.equal(counted.status, "resolved");
    assert.equal(counted.action, "next");
    assert.equal(counted.count, 2);
    assert.equal(firstPending.status, "pending");
    assert.equal(firstTimedOut.status, "unbound");
    assert.equal(firstTimedOut.diagnostic?.message.includes("Timed out"), true);
    assert.equal(first.action, "first");
    assert.equal(search.commandMode, "search");
    assert.equal(plugin.action, "plugin-action");
    assert.equal(plugin.targetKind, "plugin-contribution");
  });

  it("routes raw vi input through the same inert action resolver without model-visible text", () => {
    const base = createChatTuiState({
      enabled: true,
      terminalProfile: fullScreenProfile(),
      composition: snapshotWithList()
    });
    const state = {
      ...base,
      mode: "result-list" as const,
      composition: { ...base.composition, mode: "result-list" as const }
    };
    const result = dispatchChatTuiInputEvent(state, decodeRawKeyChunk("2")[0]!);
    const moved = dispatchChatTuiInputEvent(result.state, decodeRawKeyChunk("j")[0]!);

    assert.equal(result.kind, "sequence");
    assert.equal(result.state.keySequence?.status, "pending");
    assert.equal(moved.ok, true);
    assert.equal(moved.action, "next");
    assert.equal(moved.state.composition.activeTarget?.id, "file:b.ts");
    assert.equal(JSON.stringify(moved).includes("2j"), false);
  });

  it("renders full-screen lifecycle chunks separately from bounded workbench text", () => {
    const state = createChatTuiState({ enabled: true, terminalProfile: fullScreenProfile() });
    const entered = renderChatTuiFullscreenFrame({ workbench: state.workbench, phase: "enter", rows: 16 });
    const repainted = renderChatTuiFullscreenFrame({ workbench: state.workbench, phase: "repaint", rows: 16 });
    const tornDown = renderChatTuiFullscreenFrame({ workbench: state.workbench, phase: "teardown", rows: 16 });

    assert.equal(state.viewportProfile, "full-screen");
    assert.equal(state.workbench.scrollStates.some((entry) => entry.panelId === "transcript" && entry.totalRows > entry.visibleRows), true);
    assert.equal(entered.lifecycle.phase, "enter");
    assert.equal(entered.chunks[0]?.includes("\u001b[?1049h"), true);
    assert.equal(repainted.chunks.join("").includes("DeepSeek Workbench"), true);
    assert.equal(tornDown.lifecycle.alternateScreen, false);
    assert.equal(tornDown.chunks.join("").includes("\u001b[?1049l"), true);
  });

  it("renders a dense split-pane full-screen workbench frame", () => {
    const state = createChatTuiState({ enabled: true, terminalProfile: fullScreenProfile(128) });
    const repainted = renderChatTuiFullscreenFrame({ workbench: state.workbench, phase: "repaint", rows: 24 });
    const frame = repainted.chunks[1] ?? "";
    const lines = frame.split("\n");

    assert.equal(repainted.lifecycle.repaintBounds.columns, 128);
    assert.equal(repainted.lifecycle.repaintBounds.rows, 24);
    assert.equal(lines.length, 24);
    assert.equal(lines.every((line) => line.length === 128), true);
    assert.equal(lines.some((line) => line.includes("+ Transcript *")), true);
    assert.equal(lines.some((line) => line.includes("+ Reasoning")), true);
    assert.equal(lines.some((line) => line.includes("+ Inspector")), true);
    assert.equal(lines.some((line) => line.includes("+ Plugins")), true);
    assert.equal(lines.some((line) => line.includes("+ Input")), true);
    assert.equal(lines.some((line) => line.includes("No assistant turn is streaming yet.")), true);
  });

  it("explains plugin contributions and governed descriptors, including hidden conflicts", () => {
    const registry = createChatTuiContributionRegistry({
      keymapProfile: "vi-professional",
      plugin: [{
        id: "plugin.test.conflict",
        kind: "keymap",
        source: "plugin",
        pluginId: asId<"plugin">("@deepseek/plugin-test"),
        priority: 1,
        action: "plugin-action",
        targetKind: "plugin-contribution",
        namespace: "test",
        permissions: ["workspace:read"],
        keymap: {
          id: "plugin.test.conflict",
          mode: "result-list",
          key: "j",
          action: "plugin-action",
          targetKind: "plugin-contribution"
        }
      }]
    });
    const explanation = registry.pluginExplanations.find((entry) => entry.contributionId === "plugin.test.conflict");
    const direct = explainCliPluginContribution(registry.accepted.find((entry) => entry.source === "plugin")!);

    assert.equal(registry.summary.conflicts > 0, true);
    assert.equal(explanation?.hidden, true);
    assert.equal(explanation?.permissions.includes("workspace:read"), true);
    assert.equal(direct.governance.directHostAccess, false);
  });
});

function fullScreenProfile(columns = 120): CliTerminalCapabilityProfile {
  return {
    rendererProfile: "full-screen",
    inputStrategy: "raw",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    isCI: false,
    platform: "linux",
    columns,
    colorDepth: "ansi256",
    unicode: "unicode",
    rawInput: true,
    inlineText: true,
    tuiProfile: "full-screen",
    reasons: ["renderer:full-screen", "input:raw", "tui:full-screen"]
  };
}

function snapshotWithList(): CliCompositionSnapshot {
  const resultList: CliResultList = {
    id: "results",
    kind: "search",
    label: "Search",
    activeItemId: "item:a",
    items: [
      { id: "item:a", target: { kind: "file", id: "file:a.ts", path: "a.ts" }, label: "a.ts", order: 0 },
      { id: "item:b", target: { kind: "file", id: "file:b.ts", path: "b.ts" }, label: "b.ts", order: 1 }
    ]
  };
  return {
    mode: "result-list",
    activeTarget: resultList.items[0]!.target,
    referenceSets: [],
    resultLists: [resultList],
    jumpHistory: { entries: [], cursor: -1 },
    contributions: viProfessionalKeymapProfile().contributions
  };
}
