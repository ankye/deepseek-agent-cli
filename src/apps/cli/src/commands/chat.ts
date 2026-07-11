import type { AgentLoopTerminalStatus, RuntimeEvent } from "@deepseek/platform-contracts";
import type { CliInputStream, CliOptions, CliRunOptions } from "../types.js";
import { createCliAgentRuntime } from "../host/runtime.js";
import { resolveCliWorkspaceRoot } from "../host/workspace-root.js";
import { resolveCliModelProfile } from "../host/model-selection.js";
import type { CliTerminalCapabilityProfile } from "../host/terminal-profile.js";
import { createInitialChatModeControlState, restoreChatModeControlState, updateChatModeControlState } from "./chat-mode-controls.js";
import { writeChatLocalLines, writeLocalFailure } from "./chat-local-output.js";
import { handleChatFileSlashCommand, handleChatJumpSlashCommand } from "./chat-navigation-slash.js";
import { createChatSlashRouter, slashCommandName } from "./chat-slash-router.js";
import { renderApprovalActionText, runLocalApprovalAction } from "./approval.js";
import {
  createCliPaletteProjection,
  paletteKeymapProfile,
  renderPaletteActionResult,
  renderPaletteKeymapProfile,
  renderPaletteProjection,
  resolvePaletteAction
} from "./palette.js";
import {
  agentLoopReferenceContextFromPaletteState,
  createChatPaletteState,
  ensureChatPaletteState,
  renderChatPaletteFileSearch,
  renderChatPaletteActionWithState,
  renderChatPaletteReferenceMutation,
  renderChatPaletteReferenceFocus,
  renderChatPaletteReferences,
  renderChatPaletteStateSummary,
  renderChatPaletteTextSearch,
  resolveChatPaletteFileSearch,
  resolveChatPaletteTextSearch,
  resolveChatPaletteJumpTraversal,
  resolveChatPaletteNavigation,
  resolveChatPaletteFileReferenceAdd,
  resolveChatPaletteReferenceClear,
  resolveChatPaletteReferenceAdd,
  resolveChatPaletteReferenceFocus,
  resolveChatPaletteReferenceRemove,
  resolveChatPaletteReferenceReplaceCurrent,
  summarizeChatPaletteState
} from "./palette-state.js";
import {
  chatPageIndexPagesFromSnapshot,
  createChatPageIndexRecallDeferred,
  createChatPageIndexSnapshotPayload,
  explainChatPageIndexRecallItem,
  markStalePageIndexPagesFromWorkspaceWatermark,
  markStalePageIndexPagesAfterWorkspaceEdits,
  parseChatPageIndexRecallRequest,
  recordChatPageIndexTurn,
  renderChatPageIndexRecall,
  renderChatPageIndexRecallDeferred,
  renderChatPageIndexRecallExplain,
  resolveChatPageIndexRecall
} from "./pageindex.js";
import type { ChatPageIndexPage } from "./pageindex.js";
import { CliWorkspacePageIndexStore, renderWorkspacePageIndexFailure } from "./pageindex-workspace.js";
import type { WorkspacePageIndexDiagnostic } from "./pageindex-workspace.js";
import { handleChatContextSlashCommand } from "./context.js";
import { readCliChatPrompts } from "../input/chat-input.js";
import { enterCliRawInputSession } from "../input/raw-keys.js";
import { accumulateChatUsage } from "./chat-usage.js";
import { applyRevert, parseRevertApplyArgs, parseRevertPreviewArgs, previewRevert, renderRevertApply, renderRevertPreview } from "./revert.js";
import { emitAgentLoop, finalAgentLoopEvent, renderFinalJsonIfNeeded, resumeHint, statusTelemetryFromEvents, visibleReasoningProjectionFromEvents } from "../renderers/runtime-events.js";
import type { ChatHistoryEntry, ChatRevertReviewEntry, ChatSessionState } from "./chat-state.js";
import { createBasicChatTui, createChatTuiInputFrame, renderChatTuiFullscreenFrame } from "./chat-tui.js";
import { dispatchRawInputToTui } from "./chat-raw-input.js";

export async function runChatCommand(
  options: CliOptions,
  write: (line: string) => Promise<void>,
  writeInline: (chunk: string) => Promise<void>,
  bufferedInline: boolean,
  input: CliInputStream,
  terminalProfile: CliTerminalCapabilityProfile,
  runOptions: CliRunOptions
): Promise<void> {
  const workspaceRoot = await resolveCliWorkspaceRoot(runOptions);
  const runtime = await createCliAgentRuntime({ live: options.live, workspaceRoot, ...(options.toolProjection ? { toolProjection: options.toolProjection } : {}), ...(options.toolOptIns ? { toolOptIns: options.toolOptIns } : {}), ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}), ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}), ...(options.model ? { model: options.model } : {}) }, runOptions);
  const profile = resolveCliModelProfile(options);
  const state: ChatSessionState = {
    sessionId: options.sessionId,
    turns: 0,
    usage: { inputTokens: 0, outputTokens: 0, elapsedMs: 0 },
    palette: undefined,
    history: [],
    pageIndex: [],
    selectedHistoryTurnId: undefined,
    revertReviews: [],
    currentRevertReviewId: undefined,
    workspaceDeps: runtime.deps,
    workspaceRoot,
    workspacePageIndexFailure: undefined,
    activeController: undefined,
    pendingExit: false,
    pendingExitTimer: undefined,
    modeControls: createInitialChatModeControlState(options.sessionId),
    visibleReasoning: undefined,
    statusTelemetry: undefined
  };
  const basicTui = createBasicChatTui(options, terminalProfile, write, writeInline);
  const slashRouter = createChatSlashRouter({
    approval: handleApprovalSlashCommand,
    palette: handlePaletteSlashCommand,
    file: handleChatFileSlashCommand,
    jump: handleChatJumpSlashCommand,
    context: (raw, cliOptions, chatState, localWrite) => handleChatContextSlashCommand(raw, cliOptions, chatState, (kind, lines) => writeChatLocalLines(kind, lines, cliOptions, localWrite)),
    keymap: handleKeymapSlashCommand,
    revert: handleRevertSlashCommand,
    history: handleHistorySlashCommand
  });
  const rawInputSession = enterCliRawInputSession(input, terminalProfile.inputStrategy === "raw");
  const sigintHandler = makeSigintHandler(state, write, options.output);
  let commandBarFrameVisible = false;
  process.on("SIGINT", sigintHandler);
  try {
    const resumed = await hydrateChatSession(options, state, terminalProfile, write);
    if (!resumed) return;
    if (basicTui.enabled) {
      await basicTui.renderStartup(state);
      await basicTui.renderPrompt();
    } else if (options.output === "text") {
      await write("DeepSeek chat");
    }
    for await (const line of readCliChatPrompts(
      input,
      terminalProfile.inputStrategy,
      (event, context) => dispatchRawInputToTui(basicTui, event, context),
      async (update) => {
        if (!basicTui.enabled || terminalProfile.inputStrategy !== "raw") return;
        if (basicTui.snapshot().viewportProfile === "full-screen") {
          if (update.submitted) {
            commandBarFrameVisible = false;
            return;
          }
          for (const chunk of renderChatTuiFullscreenFrame({ workbench: basicTui.snapshot().workbench, pending: update.pending, phase: "repaint" }).chunks) {
            await writeInline(chunk);
          }
          return;
        }
        if (update.submitted) {
          commandBarFrameVisible = false;
          await writeInline("\n");
          return;
        }
        const rendered = renderRawTuiPromptUpdate(basicTui, update.pending, commandBarFrameVisible);
        commandBarFrameVisible = isCommandBarInputVisible(basicTui);
        await writeInline(rendered);
      }
    )) {
      const prompt = line.trim();
      if (!prompt) {
        await basicTui.renderPrompt();
        continue;
      }
      if (state.pendingExit) break;
      if (prompt.startsWith("/")) {
        const outcome = await slashRouter.handle(prompt, options, state, write);
        if (outcome === "exit") break;
        await basicTui.afterLocalCommand(slashCommandName(prompt), state);
        await basicTui.renderPrompt();
        continue;
      }
      state.turns += 1;
      state.activeController = new AbortController();
      const referenceContext = agentLoopReferenceContextFromPaletteState(state.palette);
      const reasoning = options.reasoning ?? (options.live ? { enabled: false } : undefined);
      const events = await emitAgentLoop(runtime.deps, runtime.kernel, {
        prompt,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        outputMode: options.output,
        workspaceRoot,
        caller: "cli.chat",
        profile,
        live: options.live,
        ...(reasoning ? { reasoning } : {}),
        ...(referenceContext ? { referenceContext } : {}),
        ...(options.toolProjection ? { toolProjection: options.toolProjection } : {}),
        ...(options.toolOptIns ? { toolOptIns: options.toolOptIns } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
      }, write, writeInline, bufferedInline, state.activeController.signal, terminalProfile);
      const terminal = finalAgentLoopEvent(events);
      state.sessionId = terminal?.sessionId ?? state.sessionId;
      recordHistoryTurn(state, prompt, terminal);
      state.pageIndex = recordChatPageIndexTurn(state.pageIndex, { prompt, terminal });
      await snapshotChatPageIndex(state);
      await persistWorkspaceChatPageIndex(state);
      accumulateChatUsage(state.usage, events);
      state.modeControls = updateChatModeControlState(state.modeControls, events);
      state.visibleReasoning = visibleReasoningProjectionFromEvents(events, terminal);
      state.statusTelemetry = statusTelemetryFromEvents(events);
      await renderFinalJsonIfNeeded(options.output, events, write);
      state.activeController = undefined;
      if (state.pendingExit) break;
      await basicTui.afterTurn(state);
      await basicTui.renderPrompt();
    }
    if (options.output === "text") {
      await write(`[chat completed] turns=${state.turns}${state.sessionId ? ` session=${state.sessionId}` : ""}`);
      if (state.sessionId) await write(resumeHint(state.sessionId));
    }
  } finally {
    process.off("SIGINT", sigintHandler);
    if (state.pendingExitTimer) clearTimeout(state.pendingExitTimer);
    rawInputSession.teardown();
    if (basicTui.enabled && basicTui.snapshot().viewportProfile === "full-screen") {
      for (const chunk of renderChatTuiFullscreenFrame({ workbench: basicTui.snapshot().workbench, phase: "teardown" }).chunks) {
        await writeInline(chunk);
      }
    }
    await runtime.kernel.shutdown("cli-chat-completed");
  }
}

function renderRawTuiPromptUpdate(tui: ReturnType<typeof createBasicChatTui>, pending: string, commandBarFrameVisible: boolean): string {
  const snapshot = tui.snapshot();
  const inputFrame = createChatTuiInputFrame(snapshot.workbench, {
    pending,
    maxSuggestions: 3,
    maxInputColumns: Math.max(24, Math.min(snapshot.workbench.columns ?? 100, 100))
  });
  if (isCommandBarInputVisible(tui)) {
    const suggestionsLine = clearCurrentInputLine(inputFrame.compactSuggestionLine ?? "Suggestions | no matches");
    const inputLine = clearCurrentInputLine(inputFrame.inputLine);
    return commandBarFrameVisible
      ? `\x1b[1A${suggestionsLine}\n${inputLine}`
      : `${suggestionsLine}\n${inputLine}`;
  }
  if (commandBarFrameVisible) {
    return `\x1b[1A${clearCurrentInputLine("")}\n${clearCurrentInputLine(inputFrame.inputLine)}`;
  }
  return clearCurrentInputLine(inputFrame.inputLine);
}

function clearCurrentInputLine(text: string): string {
  return `\r\x1b[2K${text}`;
}

function isCommandBarInputVisible(tui: ReturnType<typeof createBasicChatTui>): boolean {
  const snapshot = tui.snapshot();
  return snapshot.workbench.commandBar.open && snapshot.workbench.focus.activePanel === "command-bar";
}

async function hydrateChatSession(options: CliOptions, state: ChatSessionState, terminalProfile: CliTerminalCapabilityProfile, write: (line: string) => Promise<void>): Promise<boolean> {
  if (!options.sessionId) return true;
  if (!state.workspaceDeps) {
    await writeLocalFailure("session", "CLI_CHAT_SESSION_STORE_UNAVAILABLE", options, write);
    return false;
  }
  const resumed = await state.workspaceDeps.sessions.resume(options.sessionId);
  if (!resumed.ok) {
    await writeLocalFailure("session", resumed.error?.code ?? "CLI_CHAT_SESSION_RESUME_FAILED", options, write);
    return false;
  }
  state.sessionId = resumed.value?.sessionId ?? options.sessionId;
  state.modeControls = createInitialChatModeControlState(state.sessionId);
  if (resumed.value?.mode) {
    const restored = restoreChatModeControlState(state.modeControls, resumed.value.mode, state.sessionId, terminalProfile, options.output);
    state.modeControls = restored.state;
    const degradationEvents = restored.degradationEvents;
    if (degradationEvents.length > 0) {
      await writeChatLocalLines("chat.session.mode-degraded", degradationEvents.map((event) => JSON.stringify({
        kind: event.kind,
        sessionId: event.sessionId,
        data: event.data
      })), options, write);
    }
  }
  state.pageIndex = chatPageIndexPagesFromSnapshot(resumed.value?.snapshot?.payload);
  return true;
}

async function snapshotChatPageIndex(state: ChatSessionState): Promise<void> {
  if (!state.sessionId || !state.workspaceDeps || state.pageIndex.length === 0) return;
  await state.workspaceDeps.sessions.snapshot(state.sessionId, createChatPageIndexSnapshotPayload(state.pageIndex));
}

async function persistWorkspaceChatPageIndex(state: ChatSessionState): Promise<void> {
  if (!state.workspaceDeps || state.pageIndex.length === 0) return;
  const store = new CliWorkspacePageIndexStore(state.workspaceDeps.platform, state.workspaceRoot);
  const result = await store.append(state.pageIndex, {
    workspaceCheckpointWatermark: workspaceCheckpointWatermark(state)
  }).catch((error: unknown) => ({
    ok: false as const,
    diagnostic: {
      kind: "palette.recall.workspace.failure" as const,
      code: "CLI_PAGEINDEX_WORKSPACE_WRITE_FAILED" as const,
      message: error instanceof Error ? error.message : "Workspace PageIndex write failed.",
      redaction: { class: "internal", fields: ["message"] }
    }
  }));
  state.workspacePageIndexFailure = result.ok ? undefined : result.diagnostic;
}

function makeSigintHandler(state: ChatSessionState, write: (line: string) => Promise<void>, output: CliOptions["output"]): () => void {
  return () => {
    if (state.activeController) {
      state.activeController.abort();
      state.activeController = undefined;
      if (output === "text") {
        void write("[chat] press Ctrl+C again within 2s to exit");
      }
      if (state.pendingExitTimer) clearTimeout(state.pendingExitTimer);
      state.pendingExitTimer = setTimeout(() => {
        state.pendingExitTimer = undefined;
      }, 2000);
      return;
    }
    if (state.pendingExitTimer) {
      clearTimeout(state.pendingExitTimer);
      state.pendingExitTimer = undefined;
      state.pendingExit = true;
      return;
    }
    state.pendingExit = true;
  };
}

async function handleApprovalSlashCommand(raw: string, options: CliOptions, state: ChatSessionState, write: (line: string) => Promise<void>): Promise<void> {
  const [actionRaw, approvalIdRaw] = raw.split(/\s+/);
  const action = approvalAction(actionRaw);
  const approvalId = approvalIdRaw ?? "";
  if (!action || !approvalId) {
    if (options.output === "text") await write("[chat] approval command requires: /approval inspect|accept|deny|cancel <approval-id>");
    else if (options.output === "json" || options.output === "jsonl") await write(JSON.stringify({ kind: "chat.command.local-failure", command: "approval", code: "CLI_APPROVAL_COMMAND_INVALID" }));
    return;
  }
  const result = runLocalApprovalAction({
    action,
    approvalId,
    ...(state.sessionId ? { sessionId: state.sessionId } : {})
  });
  if (options.output === "text") await write(renderApprovalActionText(result));
  else if (options.output === "json" || options.output === "jsonl") await write(JSON.stringify({ kind: "chat.command.approval", result }));
}

async function handlePaletteSlashCommand(raw: string, options: CliOptions, state: ChatSessionState, write: (line: string) => Promise<void>): Promise<void> {
  const [subcommand, actionName, targetId] = raw.split(/\s+/).filter(Boolean);
  const projection = createCliPaletteProjection();
  if (!subcommand || subcommand === "list") {
    state.palette = createChatPaletteState();
    await writeChatLocalLines("chat.command.palette", renderPaletteProjection(projection, options.output), options, write);
    return;
  }
  if (isPaletteNavigation(subcommand)) {
    const navigation = resolveChatPaletteNavigation(ensureChatPaletteState(state.palette), subcommand);
    state.palette = navigation.state;
    await writeChatLocalLines("chat.command.palette-action", renderChatPaletteActionWithState(navigation.result, navigation.state, options.output), options, write);
    return;
  }
  if (isPaletteJumpTraversal(subcommand)) {
    const traversal = resolveChatPaletteJumpTraversal(ensureChatPaletteState(state.palette), subcommand);
    state.palette = traversal.state;
    await writeChatLocalLines("chat.command.palette-action", renderChatPaletteActionWithState(traversal.result, traversal.state, options.output), options, write);
    return;
  }
  if (subcommand === "files") {
    const pattern = raw.slice(raw.indexOf(subcommand) + subcommand.length).trim();
    if (!pattern) {
      await writeLocalFailure("palette", "CLI_PALETTE_FILES_PATTERN_REQUIRED", options, write);
      return;
    }
    if (!state.workspaceDeps) {
      await writeLocalFailure("palette", "CLI_PALETTE_FILES_PLATFORM_UNAVAILABLE", options, write);
      return;
    }
    const fileSearch = await resolveChatPaletteFileSearch(ensureChatPaletteState(state.palette), state.workspaceDeps.platform, state.workspaceRoot, pattern);
    state.palette = fileSearch.state;
    await writeChatLocalLines("chat.command.palette-files", renderChatPaletteFileSearch(fileSearch.summary, fileSearch.resultList, options.output), options, write);
    return;
  }
  if (subcommand === "grep") {
    const pattern = raw.slice(raw.indexOf(subcommand) + subcommand.length).trim();
    if (!pattern) {
      await writeLocalFailure("palette", "CLI_PALETTE_GREP_PATTERN_REQUIRED", options, write);
      return;
    }
    if (!state.workspaceDeps) {
      await writeLocalFailure("palette", "CLI_PALETTE_GREP_PLATFORM_UNAVAILABLE", options, write);
      return;
    }
    const textSearch = await resolveChatPaletteTextSearch(ensureChatPaletteState(state.palette), state.workspaceDeps.platform, state.workspaceRoot, pattern);
    state.palette = textSearch.state;
    await writeChatLocalLines("chat.command.palette-grep", renderChatPaletteTextSearch(textSearch.summary, textSearch.resultList, options.output), options, write);
    return;
  }
  if (subcommand === "recall") {
    const recallRaw = raw.slice(raw.indexOf(subcommand) + subcommand.length).trim();
    const [recallAction, recallSelector] = recallRaw.split(/\s+/).filter(Boolean);
    if (recallAction === "explain") {
      const explain = explainChatPageIndexRecallItem(ensureChatPaletteState(state.palette).snapshot, recallSelector ?? "current");
      await writeChatLocalLines("chat.command.palette-recall-explain", renderChatPageIndexRecallExplain(explain, options.output), options, write);
      return;
    }
    const recallRequest = parseChatPageIndexRecallRequest(recallRaw);
    if (!recallRequest.ok) {
      await writeLocalFailure("palette", recallRequest.code, options, write);
      return;
    }
    if (!recallRequest.value.query) {
      await writeLocalFailure("palette", "CLI_PALETTE_RECALL_QUERY_REQUIRED", options, write);
      return;
    }
    const deferred = createChatPageIndexRecallDeferred(recallRequest.value);
    if (deferred) {
      await writeChatLocalLines("chat.command.palette-recall.deferred", renderChatPageIndexRecallDeferred(deferred, options.output), options, write);
      return;
    }
    const rawPages = recallRequest.value.scope === "workspace" ? await readWorkspacePageIndexForRecall(state, options, write) : state.pageIndex;
    const pages = rawPages ? pageIndexPagesForRecall(state, rawPages) : undefined;
    if (!pages) return;
    const recall = resolveChatPageIndexRecall(ensureChatPaletteState(state.palette), pages, recallRequest.value.query, recallRequest.value.scope);
    state.palette = recall.state;
    await writeChatLocalLines("chat.command.palette-recall", renderChatPageIndexRecall(recall.summary, recall.resultList, options.output), options, write);
    return;
  }
  if (subcommand === "refs") {
    if (!actionName || actionName === "list") {
      state.palette = ensureChatPaletteState(state.palette);
      await writeChatLocalLines("chat.command.palette-refs", renderChatPaletteReferences(state.palette, options.output), options, write);
      return;
    }
    if (actionName === "add") {
      const referenceAdd = resolveChatPaletteReferenceAdd(ensureChatPaletteState(state.palette), targetId ?? "current");
      state.palette = referenceAdd.state;
      await writeChatLocalLines("chat.command.palette-action", renderChatPaletteActionWithState(referenceAdd.result, referenceAdd.state, options.output), options, write);
      return;
    }
    if (actionName === "remove") {
      const referenceRemove = resolveChatPaletteReferenceRemove(ensureChatPaletteState(state.palette), targetId ?? "current");
      state.palette = referenceRemove.state;
      await writeChatLocalLines("chat.command.palette-refs", renderChatPaletteReferenceMutation(referenceRemove.mutation, referenceRemove.state, options.output), options, write);
      return;
    }
    if (actionName === "clear") {
      const referenceClear = resolveChatPaletteReferenceClear(ensureChatPaletteState(state.palette));
      state.palette = referenceClear.state;
      await writeChatLocalLines("chat.command.palette-refs", renderChatPaletteReferenceMutation(referenceClear.mutation, referenceClear.state, options.output), options, write);
      return;
    }
    if (actionName === "replace") {
      if ((targetId ?? "current") !== "current") {
        await writeLocalFailure("palette", "CLI_PALETTE_REFS_REPLACE_TARGET_INVALID", options, write);
        return;
      }
      const referenceReplace = resolveChatPaletteReferenceReplaceCurrent(ensureChatPaletteState(state.palette));
      state.palette = referenceReplace.state;
      await writeChatLocalLines("chat.command.palette-refs", renderChatPaletteReferenceMutation(referenceReplace.mutation, referenceReplace.state, options.output), options, write);
      return;
    }
    if (actionName === "add-file") {
      if (!targetId) {
        await writeLocalFailure("palette", "CLI_PALETTE_REFS_ADD_FILE_PATH_REQUIRED", options, write);
        return;
      }
      const referenceAdd = resolveChatPaletteFileReferenceAdd(ensureChatPaletteState(state.palette), targetId);
      state.palette = referenceAdd.state;
      await writeChatLocalLines("chat.command.palette-action", renderChatPaletteActionWithState(referenceAdd.result, referenceAdd.state, options.output), options, write);
      return;
    }
    if (actionName === "focus") {
      const referenceFocus = resolveChatPaletteReferenceFocus(ensureChatPaletteState(state.palette), targetId ?? "current");
      state.palette = referenceFocus.state;
      await writeChatLocalLines("chat.command.palette-refs", [
        ...renderPaletteActionResult(referenceFocus.result, options.output),
        ...renderChatPaletteReferenceFocus(referenceFocus.focus, referenceFocus.state, options.output)
      ], options, write);
      return;
    }
    await writeLocalFailure("palette", "CLI_PALETTE_REFS_COMMAND_INVALID", options, write);
    return;
  }
  if (subcommand === "state") {
    state.palette = ensureChatPaletteState(state.palette);
    await writeChatLocalLines("chat.command.palette-state", renderChatPaletteStateSummary(summarizeChatPaletteState(state.palette), options.output), options, write);
    return;
  }
  if (subcommand === "action") {
    const result = resolvePaletteAction({
      ...(actionName ? { paletteActionName: actionName } : {}),
      ...(targetId ? { paletteTargetId: targetId } : {})
    }, projection);
    await writeChatLocalLines("chat.command.palette-action", renderPaletteActionResult(result, options.output), options, write);
    return;
  }
  await writeLocalFailure("palette", "CLI_PALETTE_COMMAND_INVALID", options, write);
}

function isPaletteNavigation(value: string): value is "next" | "previous" | "first" | "last" {
  return value === "next" || value === "previous" || value === "first" || value === "last";
}

function isPaletteJumpTraversal(value: string): value is "back" | "forward" {
  return value === "back" || value === "forward";
}

async function handleKeymapSlashCommand(raw: string, options: CliOptions, write: (line: string) => Promise<void>): Promise<void> {
  const requested = raw.trim();
  const profile = requested === "core" || requested === "vi-professional" ? requested : "vi-minimal";
  await writeChatLocalLines(
    "chat.command.keymap",
    renderPaletteKeymapProfile(paletteKeymapProfile({ paletteKeymapProfile: profile }), options.output),
    options,
    write
  );
}

async function handleRevertSlashCommand(raw: string, options: CliOptions, state: ChatSessionState, write: (line: string) => Promise<void>): Promise<void> {
  const [subcommand, ...rest] = raw.split(/\s+/).filter(Boolean);
  if ((subcommand !== "preview" && subcommand !== "apply" && subcommand !== "review" && subcommand !== "confirm") || !state.workspaceDeps) {
    await writeLocalFailure("revert", "CLI_REVERT_COMMAND_INVALID", options, write);
    return;
  }
  if (subcommand === "confirm") {
    const review = selectRevertReview(state, rest[0] ?? "current");
    if (!review) {
      await writeLocalFailure("revert", "CLI_REVERT_REVIEW_NOT_FOUND", options, write);
      return;
    }
    const result = await applyRevert(state.workspaceDeps, review.target, `chat revert confirm ${review.reviewId}`);
    state.revertReviews = state.revertReviews.map((entry) => entry.reviewId === review.reviewId ? { ...entry, confirmed: result.ok } : entry);
    await writeChatLocalLines("chat.command.revert-confirm", renderRevertConfirm(review, result, options.output), options, write);
    return;
  }
  const selected = rest[0] === "current" ? selectedHistoryEntry(state) : undefined;
  if (rest[0] === "current" && !selected) {
    await writeLocalFailure("revert", "CLI_REVERT_CURRENT_UNAVAILABLE", options, write);
    return;
  }
  if (subcommand === "review") {
    if (rest[0] !== "current" || !selected) {
      await writeLocalFailure("revert", "CLI_REVERT_REVIEW_COMMAND_INVALID", options, write);
      return;
    }
    const target = { sessionId: selected.sessionId, turnId: selected.turnId };
    const preview = await previewRevert(state.workspaceDeps, target, "chat revert review current");
    const review: ChatRevertReviewEntry = {
      reviewId: `review-${state.revertReviews.length + 1}`,
      index: state.revertReviews.length + 1,
      target,
      selectedTurnId: selected.turnId,
      preview,
      createdFrom: "current",
      confirmed: false
    };
    state.revertReviews = [...state.revertReviews, review];
    state.currentRevertReviewId = review.reviewId;
    await writeChatLocalLines("chat.command.revert-review", renderRevertReviewRecord(review, options.output), options, write);
    return;
  }
  if (subcommand === "apply") {
    const parsed = selected
      ? { target: { sessionId: selected.sessionId, turnId: selected.turnId }, reason: "chat revert apply current" }
      : parseRevertApplyArgs(rest.join(" "));
    const result = await applyRevert(state.workspaceDeps, parsed.target, parsed.reason ?? "chat revert apply");
    await writeChatLocalLines("chat.command.revert-apply", renderRevertApply(result, options.output), options, write);
    return;
  }
  const parsed = selected
    ? { target: { sessionId: selected.sessionId, turnId: selected.turnId }, reason: "chat revert preview current" }
    : parseRevertPreviewArgs(rest.join(" "));
  const result = await previewRevert(state.workspaceDeps, parsed.target, parsed.reason ?? "chat revert preview");
  await writeChatLocalLines("chat.command.revert-preview", renderRevertPreview(result, options.output), options, write);
}

async function handleHistorySlashCommand(raw: string, options: CliOptions, state: ChatSessionState, write: (line: string) => Promise<void>): Promise<void> {
  const [subcommand, selector] = raw.split(/\s+/).filter(Boolean);
  if (!subcommand) {
    await writeChatLocalLines("chat.command.history", renderHistory(state, options.output), options, write);
    return;
  }
  if (subcommand === "select") {
    const selected = selectHistoryEntry(state, selector ?? "current");
    if (!selected) {
      await writeLocalFailure("history", "CLI_HISTORY_TARGET_NOT_FOUND", options, write);
      return;
    }
    state.selectedHistoryTurnId = selected.turnId;
    state.history = state.history.map((entry) => ({ ...entry, selected: entry.turnId === selected.turnId }));
    await writeChatLocalLines("chat.command.history", renderHistorySelection(selectedHistoryEntry(state) ?? selected, options.output), options, write);
    return;
  }
  await writeLocalFailure("history", "CLI_HISTORY_COMMAND_INVALID", options, write);
}

async function readWorkspacePageIndexForRecall(state: ChatSessionState, options: CliOptions, write: (line: string) => Promise<void>): Promise<readonly ChatPageIndexPage[] | undefined> {
  if (!state.workspaceDeps) {
    await writeLocalFailure("palette", "CLI_PAGEINDEX_WORKSPACE_PLATFORM_UNAVAILABLE", options, write);
    return undefined;
  }
  if (state.workspacePageIndexFailure) {
    await writeChatLocalLines("chat.command.palette-recall.workspace-failure", renderWorkspacePageIndexFailure(state.workspacePageIndexFailure, options.output), options, write);
    return undefined;
  }
  const store = new CliWorkspacePageIndexStore(state.workspaceDeps.platform, state.workspaceRoot);
  const read = await store.read();
  if (!read.ok) {
    await writeChatLocalLines("chat.command.palette-recall.workspace-failure", renderWorkspacePageIndexFailure(read.diagnostic, options.output), options, write);
    return undefined;
  }
  return read.pages;
}

function pageIndexPagesForRecall(state: ChatSessionState, pages: readonly ChatPageIndexPage[]): readonly ChatPageIndexPage[] {
  const watermarkAdjusted = markStalePageIndexPagesFromWorkspaceWatermark(pages, {
    workspaceCheckpointWatermark: workspaceCheckpointWatermark(state)
  });
  return markStalePageIndexPagesAfterWorkspaceEdits(watermarkAdjusted, {
    turnOrder: state.history.map((entry) => ({
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      index: entry.index
    })),
    mutations: state.workspaceDeps?.workspaceState.checkpoints().map((checkpoint) => ({
      sessionId: checkpoint.sessionId,
      ...(checkpoint.turnId ? { turnId: checkpoint.turnId } : {})
    })) ?? []
  });
}

function workspaceCheckpointWatermark(state: ChatSessionState): number {
  return state.workspaceDeps?.workspaceState.checkpoints().length ?? 0;
}

function approvalAction(value: string | undefined): "inspect" | "accept" | "deny" | "cancel" | undefined {
  if (value === "inspect" || value === "accept" || value === "deny" || value === "cancel") return value;
  return undefined;
}

function recordHistoryTurn(state: ChatSessionState, prompt: string, terminal: RuntimeEvent | undefined): void {
  if (!terminal?.turnId) return;
  const status = terminalStatus(terminal);
  const entry: ChatHistoryEntry = {
    index: state.history.length + 1,
    sessionId: terminal.sessionId,
    turnId: terminal.turnId,
    status,
    traceId: String(terminal.trace.traceId),
    promptPreview: promptPreview(prompt),
    selected: true
  };
  state.selectedHistoryTurnId = entry.turnId;
  state.history = [...state.history.map((item) => ({ ...item, selected: false })), entry];
}

function terminalStatus(event: RuntimeEvent): AgentLoopTerminalStatus {
  if (event.kind === "agent.loop.completed") return "completed";
  if (event.kind === "agent.loop.cancelled") return "cancelled";
  if (event.kind === "agent.loop.failed") return "failed";
  return "failed";
}

function promptPreview(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function selectedHistoryEntry(state: ChatSessionState): ChatHistoryEntry | undefined {
  return state.history.find((entry) => entry.turnId === state.selectedHistoryTurnId) ?? state.history.at(-1);
}

function selectHistoryEntry(state: ChatSessionState, selector: string): ChatHistoryEntry | undefined {
  if (state.history.length === 0) return undefined;
  if (selector === "current") return selectedHistoryEntry(state);
  if (selector === "last") return state.history.at(-1);
  const index = Number(selector);
  if (Number.isInteger(index) && index > 0) return state.history.find((entry) => entry.index === index);
  return state.history.find((entry) => entry.turnId === selector);
}

function renderHistory(state: ChatSessionState, output: CliOptions["output"]): readonly string[] {
  if (output === "json") {
    return [JSON.stringify({
      kind: "history.summary",
      count: state.history.length,
      selectedTurnId: state.selectedHistoryTurnId,
      entries: state.history
    })];
  }
  if (output === "jsonl") {
    return [
      JSON.stringify({
        kind: "history.summary",
        count: state.history.length,
        selectedTurnId: state.selectedHistoryTurnId
      }),
      ...state.history.map((entry) => JSON.stringify({ kind: "history.entry", entry }))
    ];
  }
  if (state.history.length === 0) return ["history: empty"];
  return [
    `history: ${state.history.length} turns selected=${state.selectedHistoryTurnId ?? "none"}`,
    ...state.history.map((entry) => `  ${entry.selected ? "*" : " "} ${entry.index} ${entry.turnId} ${entry.status} ${entry.promptPreview}`)
  ];
}

function renderHistorySelection(entry: ChatHistoryEntry, output: CliOptions["output"]): readonly string[] {
  if (output === "json") return [JSON.stringify({ kind: "history.selection", entry })];
  if (output === "jsonl") return [JSON.stringify({ kind: "history.selection", entry })];
  return [`history selected: ${entry.index} ${entry.turnId} ${entry.status}`];
}

function selectRevertReview(state: ChatSessionState, selector: string): ChatRevertReviewEntry | undefined {
  if (state.revertReviews.length === 0) return undefined;
  if (selector === "current" || selector === "last") {
    return state.revertReviews.find((entry) => entry.reviewId === state.currentRevertReviewId) ?? state.revertReviews.at(-1);
  }
  const index = Number(selector);
  if (Number.isInteger(index) && index > 0) return state.revertReviews.find((entry) => entry.index === index);
  return state.revertReviews.find((entry) => entry.reviewId === selector);
}

function renderRevertReviewRecord(review: ChatRevertReviewEntry, output: CliOptions["output"]): readonly string[] {
  const record = {
    kind: "revert.review",
    reviewId: review.reviewId,
    index: review.index,
    ok: review.preview.ok,
    dryRun: true,
    status: review.preview.status,
    target: review.target,
    selectedTurnId: review.selectedTurnId,
    affectedCheckpointCount: review.preview.result?.affectedCheckpointIds.length ?? 0,
    affectedPathCount: review.preview.result?.affectedPaths.length ?? 0,
    diagnosticCount: review.preview.diagnostics.length,
    confirmed: review.confirmed,
    redaction: { class: "internal", fields: ["target", "affectedPaths"] }
  };
  if (output === "json") return [JSON.stringify({ ...record, preview: review.preview })];
  if (output === "jsonl") {
    return [
      JSON.stringify(record),
      ...review.preview.diagnostics.map((entry) => JSON.stringify({ kind: "revert.review.diagnostic", reviewId: review.reviewId, diagnostic: entry }))
    ];
  }
  return [
    `revert review: ${review.reviewId} ${review.preview.ok ? "ok" : "failed"} status=${review.preview.status} dryRun=true target=sessionId=${review.target.sessionId} turnId=${review.target.turnId}`,
    `  affected_checkpoints=${record.affectedCheckpointCount} affected_paths=${record.affectedPathCount} diagnostics=${record.diagnosticCount}`,
    `  confirm: /revert confirm ${review.reviewId}`
  ];
}

function renderRevertConfirm(review: ChatRevertReviewEntry, result: Awaited<ReturnType<typeof applyRevert>>, output: CliOptions["output"]): readonly string[] {
  const record = {
    kind: "revert.confirm",
    reviewId: review.reviewId,
    ok: result.ok,
    dryRun: false,
    status: result.status,
    target: review.target,
    affectedCheckpointCount: result.result?.affectedCheckpointIds.length ?? 0,
    affectedPathCount: result.result?.affectedPaths.length ?? 0,
    restoredPathCount: result.result?.restoredPaths.length ?? 0,
    stalePathCount: result.result?.stalePaths.length ?? 0,
    nonRestorablePathCount: result.result?.nonRestorablePaths.length ?? 0,
    diagnosticCount: result.diagnostics.length,
    redaction: { class: "internal", fields: ["target", "affectedPaths", "restoredPaths", "stalePaths", "nonRestorablePaths"] }
  };
  if (output === "json") return [JSON.stringify({ ...record, result })];
  if (output === "jsonl") {
    return [
      JSON.stringify(record),
      ...result.diagnostics.map((entry) => JSON.stringify({ kind: "revert.confirm.diagnostic", reviewId: review.reviewId, diagnostic: entry }))
    ];
  }
  return [
    `revert confirm: ${review.reviewId} ${result.ok ? "ok" : "failed"} status=${result.status} dryRun=false target=sessionId=${review.target.sessionId} turnId=${review.target.turnId}`,
    `  affected_checkpoints=${record.affectedCheckpointCount} affected_paths=${record.affectedPathCount} restored_paths=${record.restoredPathCount} stale_paths=${record.stalePathCount} non_restorable_paths=${record.nonRestorablePathCount}`
  ];
}
