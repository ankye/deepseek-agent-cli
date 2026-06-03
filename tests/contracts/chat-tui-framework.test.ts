import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CliCompositionSnapshot, CliInteractionContribution, ContextStatuslineTelemetry, RuntimeEvent } from "@deepseek/platform-contracts";
import { asId, createVisibleReasoningRecord, projectVisibleReasoning } from "@deepseek/platform-contracts";
import { statusTelemetryFromEvents } from "../../src/apps/cli/src/renderers/runtime-events.js";
import {
  CHAT_TUI_FRAMEWORK_ID,
  createChatTuiContributionRegistry,
  createChatTuiState,
  dispatchChatTuiKey,
  renderChatTuiStartup,
  renderChatTuiStatus
} from "../../src/apps/cli/src/commands/chat-tui.js";
import { createChatTuiWorkbench } from "../../src/apps/cli/src/commands/chat-tui-workbench.js";
import type { CliTerminalCapabilityProfile } from "../../src/apps/cli/src/host/terminal-profile.js";

describe("chat TUI framework", () => {
  it("registers plugin contributions as metadata and reports keymap conflicts deterministically", () => {
    const pluginConflict: CliInteractionContribution = {
      id: "plugin.navigation.j",
      kind: "keymap",
      source: "plugin",
      action: "inspect",
      targetKind: "result-list-item",
      keymap: {
        id: "plugin.navigation.j",
        mode: "result-list",
        key: "j",
        action: "inspect",
        targetKind: "result-list-item"
      }
    };
    const pluginRenderHint: CliInteractionContribution = {
      id: "plugin.render.diff",
      kind: "render-hint",
      source: "plugin",
      metadata: { targetKind: "diff", renderer: "side-by-side" }
    };

    const registry = createChatTuiContributionRegistry({ plugin: [pluginConflict, pluginRenderHint] });

    assert.equal(registry.summary.conflicts, 1);
    assert.equal(registry.diagnostics.some((diagnostic) => diagnostic.code === "CHAT_TUI_CONTRIBUTION_CONFLICT" && diagnostic.targetIds.includes("vi.pro.result.next")), true);
    assert.equal(registry.accepted.some((entry) => entry.id === "plugin.navigation.j"), false);
    assert.equal(registry.accepted.some((entry) => entry.id === "plugin.render.diff"), true);
  });

  it("renders bounded startup and status lines for the production line viewport", () => {
    const state = createChatTuiState({
      enabled: true,
      terminalProfile: interactiveProfile(),
      sessionId: "session-tui-contract"
    });
    const startup = renderChatTuiStartup(state);
    const status = renderChatTuiStatus(state);

    assert.equal(state.frameworkId, CHAT_TUI_FRAMEWORK_ID);
    assert.equal(state.workbench.layout, "balanced");
    assert.equal(state.workbench.regions.some((region) => region.id === "command-bar" && region.visible), true);
    assert.equal(startup.some((line) => line.startsWith("Workbench [ready]") && line.includes("focus=transcript")), true);
    assert.equal(startup.some((line) => line.startsWith("Input |") && line.includes("deepseek> _")), true);
    assert.equal(startup.every((line) => line.length <= 100), true);
    assert.equal(status.some((line) => line.startsWith("Panels |") && line.includes("plugins=ready")), true);
  });

  it("renders bounded cache-aware statusline telemetry", () => {
    const statusTelemetry: ContextStatuslineTelemetry = {
      schemaVersion: "1.0.0",
      modelId: "deepseek-v4-flash",
      modelProfileId: "model-deepseek-default",
      thinkingMode: "xhigh",
      cache: {
        status: "available",
        hitRate: 0.7,
        hitTokens: 700,
        missTokens: 300
      },
      context: {
        selectedTokens: 1000,
        hardLimitTokens: 2000,
        softLimitTokens: 1500,
        budgetPressure: "normal"
      },
      prefix: {
        stability: "stable",
        stableLayerCount: 2,
        changedLayerCount: 0,
        pipelineFingerprint: "pipeline:test"
      },
      redaction: { class: "internal" },
      compatibility: { schemaVersion: "1.0.0" }
    };
    const state = createChatTuiState({
      enabled: true,
      terminalProfile: interactiveProfile(72),
      statusTelemetry
    });
    const status = renderChatTuiStatus(state);

    assert.equal(status.some((line) => line.includes("model=deepseek-v4-flash")), true);
    assert.equal(status.some((line) => line.includes("think=xhigh")), true);
    assert.equal(status.some((line) => line.includes("cache=70%")), true);
    assert.equal(status.some((line) => line.includes("ctx=1000/2000")), true);
    assert.equal(status.every((line) => line.length <= 100), true);
  });

  it("projects bounded statusline telemetry from runtime events", () => {
    const telemetry = statusTelemetryFromEvents([
      runtimeEvent("model.reasoning.effort.mapped", { requestedEffort: "xhigh", providerEffort: "max" }),
      runtimeEvent("model.requested", { model: "deepseek-v4-flash" }),
      runtimeEvent("context.projection.completed", {
        budget: { selectedTokens: 1200, hardLimitTokens: 2000, softLimitTokens: 1500 },
        pipeline: {
          pipelineFingerprint: "pipeline:test",
          prefixHashes: [
            { layer: "kernel", prefixHash: "prefix-kernel" },
            { layer: "project", prefixHash: "prefix-project" }
          ]
        }
      }),
      runtimeEvent("usage.updated", {
        inputTokens: 1500,
        outputTokens: 20,
        metadata: {
          cache: {
            status: "available",
            hitTokens: 900,
            missTokens: 300,
            hitRate: 0.75,
            pipelineFingerprint: "pipeline:test"
          }
        }
      })
    ]);

    assert.equal(telemetry.modelId, "deepseek-v4-flash");
    assert.equal(telemetry.thinkingMode, "xhigh");
    assert.equal(telemetry.cache.status, "available");
    assert.equal(telemetry.cache.hitRate, 0.75);
    assert.equal(telemetry.context.selectedTokens, 1200);
    assert.equal(telemetry.context.budgetPressure, "normal");
    assert.equal(telemetry.prefix.stability, "stable");
    assert.equal(JSON.stringify(telemetry).includes("prefix-kernel"), false);
  });

  it("records degraded diagnostics when terminal profile cannot host interactive TUI", () => {
    const state = createChatTuiState({
      enabled: false,
      terminalProfile: { ...interactiveProfile(), rendererProfile: "jsonl", inputStrategy: "scripted", stdinIsTTY: false, stdoutIsTTY: false, reasons: ["renderer:jsonl", "input:scripted"] }
    });

    assert.equal(state.viewportProfile, "disabled");
    assert.equal(state.pluginReadiness, "disabled");
    assert.equal(state.diagnostics.some((diagnostic) => diagnostic.code === "CHAT_TUI_DEGRADED"), true);
  });

  it("dispatches vi result-list keys through typed action resolution", () => {
    const base = createChatTuiState({ enabled: true, terminalProfile: interactiveProfile() });
    const state = {
      ...base,
      mode: "result-list" as const,
      composition: { ...base.composition, mode: "result-list" as const }
    };
    const next = dispatchChatTuiKey(state, "j");
    const command = dispatchChatTuiKey({ ...state, mode: "normal" as const, composition: { ...state.composition, mode: "normal" as const } }, ":");

    assert.equal(next.ok, true);
    assert.equal(next.kind, "action");
    assert.equal(next.action, "next");
    assert.equal(command.ok, true);
    assert.equal(command.kind, "command");
    assert.equal(command.commandName, "command");
    assert.equal(command.state.workbench.focus.activePanel, "command-bar");
    assert.equal(command.state.workbench.commandBar.open, true);
  });

  it("moves workbench focus locally without model-visible actions", () => {
    const state = createChatTuiState({ enabled: true, terminalProfile: interactiveProfile() });
    const resultList = dispatchChatTuiKey(state, "Tab");
    const reasoning = dispatchChatTuiKey(resultList.state, "r");
    const inspector = dispatchChatTuiKey(reasoning.state, "i");
    const commandBar = dispatchChatTuiKey(inspector.state, "/");
    const restored = dispatchChatTuiKey(commandBar.state, "Escape");

    assert.equal(resultList.ok, true);
    assert.equal(resultList.kind, "focus");
    assert.equal(resultList.focusPanel, "reasoning");
    assert.equal(reasoning.ok, true);
    assert.equal(reasoning.kind, "focus");
    assert.equal(reasoning.focusPanel, "reasoning");
    assert.equal(inspector.state.workbench.focus.activePanel, "inspector");
    assert.equal(commandBar.state.workbench.commandBar.open, true);
    assert.equal(commandBar.state.mode, "command");
    assert.equal(restored.state.workbench.focus.activePanel, "inspector");
    assert.equal(restored.state.mode, "prompt");
  });

  it("ranks and bounds command bar suggestions across core, context, history, reasoning, and plugins", () => {
    const state = createChatTuiState({ enabled: true, terminalProfile: interactiveProfile() });
    const suggestions = state.workbench.commandBar.suggestions;

    assert.equal(suggestions[0]?.title, "/help");
    assert.equal(suggestions.some((entry) => entry.kind === "context" && entry.title.includes("/context")), true);
    assert.equal(suggestions.some((entry) => entry.kind === "history"), true);
    assert.equal(suggestions.some((entry) => entry.kind === "reasoning-view"), true);
    assert.equal(state.workbench.commandBar.overflowCount > 0, true);
    assert.equal(state.workbench.commandBar.suggestions.length <= 8, true);
  });

  it("surfaces navigation slash commands through command bar search", () => {
    const state = createChatTuiState({ enabled: true, terminalProfile: interactiveProfile() });
    const base = {
      enabled: state.enabled,
      frameworkId: state.frameworkId,
      mode: state.mode,
      terminalProfile: state.terminalProfile,
      composition: state.composition,
      contributionSummary: state.contributionSummary,
      diagnostics: state.diagnostics,
      pluginReadiness: state.pluginReadiness,
      pluginContributionExplanations: state.pluginContributionExplanations,
      pluginExecutions: state.pluginExecutions,
      reasoningPanel: state.reasoningPanel,
      promptReady: state.promptReady,
      turns: state.turns
    };
    const fileWorkbench = createChatTuiWorkbench({
      ...base,
      commandBar: { open: true, mode: "slash", query: "file" }
    });
    const jumpWorkbench = createChatTuiWorkbench({
      ...base,
      commandBar: { open: true, mode: "slash", query: "jump" }
    });

    assert.equal(fileWorkbench.commandBar.suggestions.some((entry) => entry.kind === "navigation" && entry.title === "/file list <query>"), true);
    assert.equal(fileWorkbench.commandBar.suggestions.some((entry) => entry.kind === "navigation" && entry.title === "/file preview <path|query>"), true);
    assert.equal(jumpWorkbench.commandBar.suggestions.some((entry) => entry.kind === "navigation" && entry.title === "/jump file <query>"), true);
    assert.equal(jumpWorkbench.commandBar.suggestions.some((entry) => entry.kind === "navigation" && entry.title === "/jump text <query>"), true);
    assert.equal(jumpWorkbench.commandBar.suggestions.some((entry) => entry.kind === "navigation" && entry.title === "/jump symbol <query>"), true);
    assert.equal(state.workbench.commandBar.suggestions.length <= 8, true);
  });

  it("surfaces first-party plugin slash aliases with owner route placeholders", () => {
    const state = createChatTuiState({ enabled: true, terminalProfile: interactiveProfile() });
    const base = {
      enabled: state.enabled,
      frameworkId: state.frameworkId,
      mode: state.mode,
      terminalProfile: state.terminalProfile,
      composition: state.composition,
      contributionSummary: state.contributionSummary,
      diagnostics: state.diagnostics,
      pluginReadiness: state.pluginReadiness,
      pluginContributionExplanations: state.pluginContributionExplanations,
      pluginExecutions: state.pluginExecutions,
      reasoningPanel: state.reasoningPanel,
      promptReady: state.promptReady,
      turns: state.turns
    };
    const repoWorkbench = createChatTuiWorkbench({
      ...base,
      commandBar: { open: true, mode: "slash", query: "repo" }
    });
    const checksWorkbench = createChatTuiWorkbench({
      ...base,
      commandBar: { open: true, mode: "slash", query: "checks lint" }
    });

    assert.equal(repoWorkbench.commandBar.suggestions.some((entry) => entry.kind === "plugin-action" && entry.title === "/repo files <query>" && entry.commandName === "/repo files"), true);
    assert.equal(repoWorkbench.commandBar.suggestions.some((entry) => entry.kind === "plugin-action" && entry.title === "/repo grep <query>" && entry.commandName === "/repo grep"), true);
    assert.equal(checksWorkbench.commandBar.suggestions.some((entry) => entry.kind === "plugin-action" && entry.title === "/checks lint" && entry.commandName === "/checks lint"), true);
  });

  it("edits, navigates, accepts, and rejects command bar suggestions locally", () => {
    const opened = dispatchChatTuiKey(createChatTuiState({ enabled: true, terminalProfile: interactiveProfile() }), "/");
    const typed = ["f", "i", "l", "e"].reduce((current, key) => dispatchChatTuiKey(current.state, key), opened);
    const backspaced = dispatchChatTuiKey(typed.state, "Backspace");
    const restored = dispatchChatTuiKey(backspaced.state, "e");
    const next = dispatchChatTuiKey(restored.state, "ArrowDown");
    const previous = dispatchChatTuiKey(next.state, "ArrowUp");
    const tabbed = dispatchChatTuiKey(previous.state, "Tab");
    const shifted = dispatchChatTuiKey(tabbed.state, "Shift+Tab");
    const accepted = dispatchChatTuiKey(shifted.state, "Enter");
    const empty = ["z", "z", "z"].reduce((current, key) => dispatchChatTuiKey(current.state, key), opened);
    const rejected = dispatchChatTuiKey(empty.state, "Enter");

    assert.equal(typed.state.workbench.commandBar.query, "file");
    assert.equal(backspaced.state.workbench.commandBar.query, "fil");
    assert.equal(restored.state.workbench.commandBar.activeSuggestionId, "navigation.file.list");
    assert.equal(next.state.workbench.commandBar.activeSuggestionId, "navigation.file.preview");
    assert.equal(previous.state.workbench.commandBar.activeSuggestionId, "navigation.file.list");
    assert.equal(tabbed.state.workbench.commandBar.activeSuggestionId, "navigation.file.preview");
    assert.equal(shifted.state.workbench.commandBar.activeSuggestionId, "navigation.file.list");
    assert.equal(accepted.kind, "command");
    assert.equal(accepted.commandName, "/file list");
    assert.equal(accepted.commandSuggestionId, "navigation.file.list");
    assert.equal(accepted.previewText, "/file list <query>");
    assert.equal(accepted.state.workbench.commandBar.acceptedCommandName, "/file list");
    assert.equal(rejected.ok, false);
    assert.equal(rejected.kind, "diagnostic");
    assert.equal(rejected.diagnostics[0]?.code, "CHAT_TUI_COMMAND_BAR_EMPTY");
    assert.equal(rejected.state.workbench.commandBar.open, true);
  });

  it("accepts plugin command bar suggestions as governed descriptors", () => {
    const registry = createChatTuiContributionRegistry({
      plugin: [{
        id: "plugin.command.repo-grep",
        kind: "command",
        source: "plugin",
        pluginId: asId<"plugin">("@deepseek/plugin-test"),
        commandName: "zzplugin.command",
        targetKind: "file",
        priority: 90
      }]
    });
    const opened = dispatchChatTuiKey(createChatTuiState({ enabled: true, terminalProfile: interactiveProfile(), registry }), "/");
    const searched = ["z", "z", "p", "l", "u", "g", "i", "n"].reduce((current, key) => dispatchChatTuiKey(current.state, key), opened);
    const accepted = dispatchChatTuiKey(searched.state, "Enter");

    assert.equal(searched.state.workbench.commandBar.suggestions.some((entry) => entry.id === "contribution:plugin.command.repo-grep" && entry.kind === "plugin-action"), true);
    assert.equal(accepted.kind, "command");
    assert.equal(accepted.commandName, "zzplugin.command");
    assert.equal(accepted.commandSuggestionId, "contribution:plugin.command.repo-grep");
    assert.equal(accepted.commandSource, "plugin");
    assert.equal(accepted.pluginId, "@deepseek/plugin-test");
    assert.equal(accepted.previewText, "zzplugin.command");
  });

  it("projects visible reasoning into a compact rail and inspector evidence targets", () => {
    const projection = reasoningProjection(6);
    const state = createChatTuiState({
      enabled: true,
      terminalProfile: interactiveProfile(),
      visibleReasoning: projection
    });
    const status = renderChatTuiStatus(state);

    assert.equal(state.reasoningPanel.enabled, true);
    assert.equal(state.reasoningPanel.recordCount, 6);
    assert.equal(state.reasoningPanel.inspectorTargets[0]?.id, "check:typecheck-6");
    assert.equal(state.workbench.reasoningRail.steps.length, 5);
    assert.equal(state.workbench.reasoningRail.steps.some((step) => step.active && step.recordId === projection.activeRecordId), true);
    assert.equal(state.workbench.reasoningRail.overflowCount, 1);
    assert.equal(state.workbench.inspector.items[0]?.target.id, "check:typecheck-6");
    assert.equal(status.some((line) => line.startsWith("Reasoning |") && line.includes("verification")), true);
  });

  it("uses the active result-list target as inspector fallback", () => {
    const base = createChatTuiState({ enabled: true, terminalProfile: interactiveProfile() });
    const composition: CliCompositionSnapshot = {
      ...base.composition,
      mode: "result-list",
      resultLists: [{
        id: "results:files",
        kind: "search",
        label: "Files",
        activeItemId: "item-2",
        items: [
          { id: "item-1", label: "README", order: 1, target: { kind: "file", id: "README.md", path: "README.md", label: "README.md" } },
          { id: "item-2", label: "CLI", order: 2, target: { kind: "file", id: "src/apps/cli/README.md", path: "src/apps/cli/README.md", label: "CLI README" } }
        ]
      }]
    };
    const state = createChatTuiState({ enabled: true, terminalProfile: interactiveProfile(), composition });

    assert.equal(state.workbench.focus.activePanel, "result-list");
    assert.equal(state.workbench.inspector.items[0]?.source, "result-list");
    assert.equal(state.workbench.inspector.items[0]?.target.id, "src/apps/cli/README.md");
  });

  it("summarizes plugin shelf readiness, contribution counts, conflicts, and diagnostics", () => {
    const pluginConflict: CliInteractionContribution = {
      id: "plugin.navigation.j",
      kind: "keymap",
      source: "plugin",
      action: "inspect",
      targetKind: "result-list-item",
      pluginId: asId<"plugin">("@deepseek/plugin-conflict-test"),
      keymap: {
        id: "plugin.navigation.j",
        mode: "result-list",
        key: "j",
        action: "inspect",
        targetKind: "result-list-item"
      }
    };
    const registry = createChatTuiContributionRegistry({ plugin: [pluginConflict] });
    const state = createChatTuiState({ enabled: true, terminalProfile: interactiveProfile(), registry });

    assert.equal(state.workbench.pluginShelf.readiness, "governed-descriptors");
    assert.equal(state.workbench.pluginShelf.totalPlugins >= 4, true);
    assert.equal(state.workbench.pluginShelf.conflicts, 1);
    assert.equal(state.workbench.pluginShelf.items.length <= 4, true);
    assert.equal(state.workbench.activityFeed.records.some((record) => record.kind === "plugins" && record.status === "ready"), true);
  });

  it("falls back to a compact bounded workbench frame in narrow terminals", () => {
    const state = createChatTuiState({
      enabled: true,
      terminalProfile: { ...interactiveProfile(), columns: 72 }
    });
    const lines = renderChatTuiStartup(state);

    assert.equal(state.workbench.layout, "compact");
    assert.equal(lines.filter((line) => line.startsWith("Workbench [ready]")).length, 1);
    assert.equal(lines.length <= 7, true);
    assert.equal(lines.every((line) => line.length <= 100), true);
  });
});

function interactiveProfile(columns = 100): CliTerminalCapabilityProfile {
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

function runtimeEvent(kind: RuntimeEvent["kind"], data: RuntimeEvent["data"]): RuntimeEvent {
  return {
    kind,
    sessionId: asId<"session">("session-tui-statusline"),
    turnId: asId<"turn">("turn-tui-statusline"),
    createdAt: new Date(0).toISOString(),
    trace: {
      traceId: asId<"trace">(`trace-${kind}`),
      spanId: asId<"span">(`span-${kind}`),
      correlationId: asId<"correlation">(`corr-${kind}`)
    },
    data
  };
}

function reasoningProjection(count: number) {
  return projectVisibleReasoning(
    Array.from({ length: count }, (_, index) => createVisibleReasoningRecord({
      sessionId: asId<"session">("session-tui-reasoning"),
      turnId: asId<"turn">("turn-tui-reasoning"),
      trace: {
        traceId: asId<"trace">(`trace-tui-reasoning-${index + 1}`),
        spanId: asId<"span">(`span-tui-reasoning-${index + 1}`),
        correlationId: asId<"correlation">(`corr-tui-reasoning-${index + 1}`)
      },
      createdAt: "1970-01-01T00:00:00.000Z",
      actor: "runtime",
      stepKind: "verification",
      status: "completed",
      summary: `Verification step ${index + 1} passed with linked evidence.`,
      evidence: [{
        kind: "check",
        target: { kind: "tool-evidence", id: `check:typecheck-${index + 1}`, label: `typecheck-${index + 1}` },
        label: `typecheck-${index + 1}`,
        fingerprint: `check:typecheck-${index + 1}`,
        supports: true,
        redaction: { class: "internal" }
      }],
      sequence: index + 1
    })),
    { renderer: "tui", detailLevel: "full" }
  );
}
