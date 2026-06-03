import type { CliFullscreenRendererLifecycle } from "@deepseek/platform-contracts";
import { CLI_PALETTE_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import type {
  ChatTuiActivityFeed,
  ChatTuiCommandBarState,
  ChatTuiInspectorState,
  ChatTuiPluginShelf,
  ChatTuiReasoningRail,
  ChatTuiWorkbench,
  ChatTuiWorkbenchPanelId
} from "./chat-tui-workbench.js";

export const CHAT_TUI_ALT_SCREEN_ENTER = "\x1b[?1049h\x1b[?2004h\x1b[?25l";
export const CHAT_TUI_ALT_SCREEN_EXIT = "\x1b[?25h\x1b[?2004l\x1b[?1049l";
export const CHAT_TUI_CLEAR_HOME = "\x1b[H\x1b[2J";
export const CHAT_TUI_REPAINT_HOME = "\x1b[H";

export interface ChatTuiInputFrame {
  readonly commandBarOpen: boolean;
  readonly inputLine: string;
  readonly promptPreviewLines: readonly string[];
  readonly suggestionLines: readonly string[];
  readonly compactSuggestionLine?: string;
}

export function createChatTuiInputFrame(workbench: ChatTuiWorkbench, input: {
  readonly pending?: string;
  readonly maxInputColumns?: number;
  readonly maxPreviewLines?: number;
  readonly previewColumns?: number;
  readonly maxSuggestions?: number;
} = {}): ChatTuiInputFrame {
  if (workbench.commandBar.open) {
    const visibleSuggestions = workbench.commandBar.suggestions
      .slice(0, input.maxSuggestions ?? 3)
      .map((entry) => `${entry.id === workbench.commandBar.activeSuggestionId ? ">" : " "}${entry.title}`);
    const suggestionLines = visibleSuggestions.length > 0 ? visibleSuggestions : ["no matches"];
    return {
      commandBarOpen: true,
      inputLine: formatInputAnchor(`/${workbench.commandBar.query}`, input.maxInputColumns),
      promptPreviewLines: [],
      suggestionLines,
      compactSuggestionLine: `Suggestions | ${suggestionLines.join("  ")}`
    };
  }
  const pending = input.pending ?? "";
  return {
    commandBarOpen: false,
    inputLine: formatInputAnchor(pending, input.maxInputColumns),
    promptPreviewLines: createPromptPreviewLines(pending, input.maxPreviewLines ?? 0, input.previewColumns ?? input.maxInputColumns ?? 80),
    suggestionLines: []
  };
}

export function renderChatTuiWorkbench(workbench: ChatTuiWorkbench): readonly string[] {
  if (workbench.layout === "disabled") return [];
  const maxWidth = Math.max(72, Math.min(workbench.columns ?? 100, 160));
  const lines = workbench.layout === "compact"
    ? renderCompactWorkbench(workbench)
    : renderExpandedWorkbench(workbench);
  return lines.slice(0, workbench.frameLineBudget).map((line) => boundLine(line, maxWidth));
}

export function createChatTuiFullscreenLifecycle(input: {
  readonly phase: CliFullscreenRendererLifecycle["phase"];
  readonly columns: number;
  readonly rows: number;
  readonly reason?: string;
}): CliFullscreenRendererLifecycle {
  return {
    schemaVersion: CLI_PALETTE_SCHEMA_VERSION,
    phase: input.phase,
    alternateScreen: input.phase !== "teardown",
    cursorVisible: input.phase === "teardown",
    repaintBounds: {
      columns: input.columns,
      rows: input.rows
    },
    ...(input.reason ? { reason: input.reason } : {}),
    redaction: { class: "public" }
  };
}

export function renderChatTuiFullscreenFrame(input: {
  readonly workbench: ChatTuiWorkbench;
  readonly pending?: string;
  readonly rows?: number;
  readonly phase?: CliFullscreenRendererLifecycle["phase"];
}): { readonly lifecycle: CliFullscreenRendererLifecycle; readonly chunks: readonly string[] } {
  const columns = Math.max(80, Math.min(input.workbench.columns ?? 100, 200));
  const rows = Math.max(12, Math.min(input.rows ?? 32, 80));
  const phase = input.phase ?? "repaint";
  const padded = renderFullscreenWorkbench(input.workbench, columns, rows, input.pending);
  const lifecycle = createChatTuiFullscreenLifecycle({ phase, columns, rows });
  const repaintHome = phase === "enter" ? CHAT_TUI_CLEAR_HOME : CHAT_TUI_REPAINT_HOME;
  const chunks = [
    ...(phase === "enter" ? [CHAT_TUI_ALT_SCREEN_ENTER] : []),
    ...(phase === "teardown" ? [CHAT_TUI_ALT_SCREEN_EXIT] : [repaintHome, padded.join("\n")])
  ];
  return { lifecycle, chunks };
}

function renderFullscreenWorkbench(workbench: ChatTuiWorkbench, columns: number, rows: number, pending?: string): readonly string[] {
  if (workbench.layout === "disabled") return padFrame(["DeepSeek Workbench disabled"], columns, rows);
  const header = headerLines(workbench, columns, rows);
  const promptPreviewVisible = !workbench.commandBar.open && hasMultipleDisplayLines(pending ?? "");
  const commandRows = workbench.commandBar.open
    ? rows >= 18 ? 6 : 5
    : promptPreviewVisible ? rows >= 18 ? 7 : 5 : 3;
  const footerRows = 2;
  const mainRows = Math.max(3, rows - header.length - commandRows - footerRows);
  const body = renderMainArea(workbench, columns, mainRows);
  const command = renderCommandArea(workbench, columns, commandRows, pending);
  return padFrame([
    ...header,
    ...body,
    keyLine(workbench, columns),
    statusLine(workbench),
    ...command
  ], columns, rows);
}

function headerLines(workbench: ChatTuiWorkbench, columns: number, rows: number): readonly string[] {
  const title = fitColumns(
    ` DeepSeek Workbench  ${workbench.commandBar.open ? "command" : "ready"}  focus:${workbench.focus.activePanel}`,
    "/ commands  Tab panels  Ctrl+C exit",
    columns
  );
  if (rows < 16) return [borderLine(columns, "="), title];
  return [
    borderLine(columns, "="),
    title,
    fitColumns(
      ` Session ${regionSummary(workbench, "transcript")}`,
      workbench.commandBar.open ? `Command /${workbench.commandBar.query}_` : "Input deepseek> _",
      columns
    )
  ];
}

function renderMainArea(workbench: ChatTuiWorkbench, columns: number, rows: number): readonly string[] {
  const sideWidth = sidePanelWidth(columns);
  if (sideWidth === 0) return renderBox("Transcript", transcriptLines(workbench), columns, rows, workbench.focus.activePanel === "transcript");
  const leftWidth = columns - sideWidth - 1;
  const left = renderBox("Transcript", transcriptLines(workbench), leftWidth, rows, workbench.focus.activePanel === "transcript");
  const rightPanels = [
    { title: "Reasoning", lines: reasoningLines(workbench.reasoningRail), active: workbench.focus.activePanel === "reasoning" },
    { title: "Inspector", lines: inspectorLines(workbench.inspector), active: workbench.focus.activePanel === "inspector" },
    { title: "Plugins", lines: pluginLines(workbench.pluginShelf), active: workbench.focus.activePanel === "plugins" }
  ].slice(0, Math.max(1, Math.min(3, Math.floor(rows / 3))));
  const heights = distributePanelHeights(rows, rightPanels.length);
  const right = rightPanels.flatMap((panel, index) => renderBox(panel.title, panel.lines, sideWidth, heights[index] ?? 3, panel.active));
  return Array.from({ length: rows }, (_, index) => `${left[index] ?? "".padEnd(leftWidth)} ${right[index] ?? "".padEnd(sideWidth)}`);
}

function renderCommandArea(workbench: ChatTuiWorkbench, columns: number, rows: number, pending?: string): readonly string[] {
  const inputFrame = createChatTuiInputFrame(workbench, {
    ...(pending === undefined ? {} : { pending }),
    maxInputColumns: Math.max(24, columns - 4),
    maxPreviewLines: Math.max(0, rows - 4),
    previewColumns: Math.max(24, columns - 4)
  });
  if (!inputFrame.commandBarOpen && inputFrame.promptPreviewLines.length > 0) {
    const inputRows = 3;
    const previewRows = Math.max(3, rows - inputRows);
    return [
      ...renderBox("Prompt preview", inputFrame.promptPreviewLines, columns, previewRows, false),
      ...renderBox("Input", [inputFrame.inputLine], columns, inputRows, false)
    ].slice(0, rows);
  }
  if (!inputFrame.commandBarOpen) return renderBox("Input", [inputFrame.inputLine], columns, rows, workbench.focus.activePanel === "command-bar");
  const inputRows = 3;
  const suggestionRows = Math.max(3, rows - inputRows);
  const suggestionFrame = createChatTuiInputFrame(workbench, { maxSuggestions: Math.max(1, suggestionRows - 2) });
  return [
    ...renderBox("Suggestions", suggestionFrame.suggestionLines, columns, suggestionRows, false),
    ...renderBox("Input", [inputFrame.inputLine], columns, inputRows, true)
  ].slice(0, rows);
}

function transcriptLines(workbench: ChatTuiWorkbench): readonly string[] {
  return [
    "Conversation",
    regionSummary(workbench, "transcript"),
    "",
    "No assistant turn is streaming yet.",
    "Type below. Use / for commands.",
    "",
    panelSummaryText(workbench)
  ];
}

function reasoningLines(rail: ChatTuiReasoningRail): readonly string[] {
  if (!rail.enabled) {
    return [
      "Idle",
      rail.statusText,
      "Reasoning details appear here during a turn."
    ];
  }
  const steps = rail.steps.map((step) => {
    const active = step.active ? "*" : " ";
    return `${active} ${step.order}. ${step.stepKind} ${step.status} ${step.certainty} e=${step.evidenceCount}`;
  });
  return [
    `records=${rail.recordCount} evidence=${rail.evidenceLinkCount} detail=${rail.detailLevel}`,
    ...steps,
    ...(rail.overflowCount > 0 ? [`+${rail.overflowCount} more records`] : [])
  ];
}

function inspectorLines(inspector: ChatTuiInspectorState): readonly string[] {
  if (inspector.items.length === 0) return ["Empty", "Targets and evidence appear here."];
  return [
    inspector.title,
    ...inspector.items.map((item) => `${item.source}: ${item.kind} ${item.label}`),
    ...(inspector.overflowCount > 0 ? [`+${inspector.overflowCount} more targets`] : [])
  ];
}

function pluginLines(shelf: ChatTuiPluginShelf): readonly string[] {
  return [
    shelf.readiness === "disabled" ? "Plugins off" : "Plugins ready",
    shelf.totalPlugins > 0 ? `${shelf.totalPlugins} plugins available` : "No plugin activity yet",
    ...shelf.items.map((item) => `${item.status} ${item.pluginId}`),
    ...(shelf.overflowCount > 0 ? [`+${shelf.overflowCount} more plugins`] : [])
  ];
}

function renderBox(title: string, lines: readonly string[], width: number, height: number, active: boolean): readonly string[] {
  const safeWidth = Math.max(12, width);
  const safeHeight = Math.max(3, height);
  const label = active ? ` ${title} * ` : ` ${title} `;
  const top = `+${label}${"-".repeat(Math.max(0, safeWidth - label.length - 2))}+`;
  const bottom = `+${"-".repeat(Math.max(0, safeWidth - 2))}+`;
  const contentHeight = safeHeight - 2;
  const content = Array.from({ length: contentHeight }, (_, index) => {
    const line = lines[index] ?? "";
    return `| ${boundLine(line, safeWidth - 4).padEnd(safeWidth - 4)} |`;
  });
  return [boundLine(top, safeWidth), ...content, bottom];
}

function padFrame(lines: readonly string[], columns: number, rows: number): readonly string[] {
  return Array.from({ length: rows }, (_, index) => boundLine((lines[index] ?? "").padEnd(columns), columns));
}

function sidePanelWidth(columns: number): number {
  if (columns < 96) return 0;
  return Math.min(44, Math.max(34, Math.floor(columns * 0.34)));
}

function distributePanelHeights(totalRows: number, panelCount: number): readonly number[] {
  const base = Math.floor(totalRows / panelCount);
  let remainder = totalRows - base * panelCount;
  return Array.from({ length: panelCount }, () => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return Math.max(3, base + extra);
  });
}

function renderExpandedWorkbench(workbench: ChatTuiWorkbench): readonly string[] {
  return [
    `Workbench [${workbenchModeLabel(workbench)}] | layout=${workbench.layout} | focus=${workbench.focus.activePanel}`,
    ...statusTelemetryLines(workbench),
    `Main [transcript] | ${regionSummary(workbench, "transcript")}`,
    `Focus | active=${workbench.focus.activePanel} | previous=${workbench.focus.previousPanel ?? "none"}`,
    `Panels | ${panelSummaryText(workbench)}`,
    ...reasoningSummaryLines(workbench),
    `Activity | ${activityText(workbench.activityFeed, 3)}`,
    `Keys | ${keyHintText(workbench)}`,
    `Input | ${suggestionText(workbench.commandBar, 4)}`
  ];
}

function renderCompactWorkbench(workbench: ChatTuiWorkbench): readonly string[] {
  return [
    `Workbench [${workbenchModeLabel(workbench)}] | focus=${workbench.focus.activePanel}`,
    ...statusTelemetryLines(workbench),
    `Main | ${regionSummary(workbench, "transcript")}`,
    activeAreaText(workbench),
    `Keys | ${keyHintText(workbench)}`,
    `Input | ${suggestionText(workbench.commandBar, 3)}`
  ];
}

function statusTelemetryLines(workbench: ChatTuiWorkbench): readonly string[] {
  const telemetry = workbench.statusTelemetry;
  if (!telemetry) return [];
  return [
    `Status | model=${telemetry.modelId} think=${telemetry.thinkingMode} cache=${cacheText(telemetry)} ctx=${telemetry.context.selectedTokens}/${telemetry.context.hardLimitTokens}`
  ];
}

function reasoningSummaryLines(workbench: ChatTuiWorkbench): readonly string[] {
  if (!workbench.reasoningRail.enabled) return [];
  return [`Reasoning | ${reasoningText(workbench.reasoningRail, 3)}`];
}

function regionSummary(workbench: ChatTuiWorkbench, id: ChatTuiWorkbenchPanelId): string {
  return workbench.regions.find((regionItem) => regionItem.id === id)?.summary ?? "unavailable";
}

function commandBarStatus(commandBar: ChatTuiCommandBarState): string {
  return `${commandBar.open ? "open" : "ready"}:${commandBar.mode} suggestions=${commandBar.suggestions.length}/${commandBar.totalSuggestionCount}`;
}

function workbenchModeLabel(workbench: ChatTuiWorkbench): string {
  return workbench.commandBar.open ? "command" : "ready";
}

function suggestionText(commandBar: ChatTuiCommandBarState, maxSuggestions: number): string {
  if (!commandBar.open) return "deepseek> _";
  const active = commandBar.suggestions.find((entry) => entry.id === commandBar.activeSuggestionId);
  const names = commandBar.suggestions
    .slice(0, maxSuggestions)
    .map((entry) => `${entry.id === commandBar.activeSuggestionId ? ">" : ""}${boundSegment(entry.title, 22)}`)
    .join(", ");
  const overflow = Math.max(0, commandBar.overflowCount + Math.max(0, commandBar.suggestions.length - maxSuggestions));
  return [
    `/${commandBar.query}_`,
    `suggestions=${names || "none"}`,
    `selected=${active ? boundSegment(active.title, 22) : "none"}`,
    `count=${commandBar.suggestions.length}/${commandBar.totalSuggestionCount}${overflow > 0 ? ` +${overflow}` : ""}`
  ].join(" | ");
}

function activeAreaText(workbench: ChatTuiWorkbench): string {
  if (workbench.focus.activePanel === "command-bar") {
    return `Active | command suggestions=${workbench.commandBar.suggestions.length}/${workbench.commandBar.totalSuggestionCount}`;
  }
  if (workbench.focus.activePanel === "reasoning") return `Active | reasoning ${reasoningText(workbench.reasoningRail, 2)}`;
  if (workbench.focus.activePanel === "inspector") return `Active | inspect ${inspectorText(workbench.inspector, 2)}`;
  if (workbench.focus.activePanel === "plugins") return `Active | plugins ${pluginShelfText(workbench.pluginShelf, 1)}`;
  return `Panels | ${panelSummaryText(workbench)}`;
}

function panelSummaryText(workbench: ChatTuiWorkbench): string {
  return [
    `reasoning=${workbench.reasoningRail.enabled ? "ready" : "idle"}`,
    `inspect=${workbench.inspector.items.length > 0 ? "ready" : "empty"}`,
    `plugins=${workbench.pluginShelf.readiness === "disabled" ? "off" : "ready"}`
  ].join(" | ");
}

function keyHintText(workbench: ChatTuiWorkbench): string {
  if (workbench.commandBar.open) return "Tab suggestions | Enter accept | Esc close | Ctrl+C exit";
  return "/ commands | Tab next panel | Shift+Tab previous | Ctrl+C exit";
}

function reasoningText(rail: ChatTuiReasoningRail, maxSteps: number): string {
  if (!rail.enabled) return `${rail.statusText} records=${rail.recordCount} evidence=${rail.evidenceLinkCount}`;
  const steps = rail.steps
    .slice(0, maxSteps)
    .map((step) => `${step.active ? "*" : ""}${step.order}:${step.stepKind}/${step.status}/${step.certainty}/e${step.evidenceCount}`)
    .join(", ");
  const overflow = Math.max(0, rail.overflowCount + Math.max(0, rail.steps.length - maxSteps));
  return `${steps || "empty"}${overflow > 0 ? ` (+${overflow})` : ""}`;
}

function inspectorText(inspector: ChatTuiInspectorState, maxItems: number): string {
  if (inspector.items.length === 0) return inspector.emptyReason;
  const items = inspector.items.slice(0, maxItems).map((item) => `${item.kind}:${boundSegment(item.label, 20)}`).join(", ");
  const overflow = Math.max(0, inspector.overflowCount + Math.max(0, inspector.items.length - maxItems));
  return `${inspector.title} -> ${items}${overflow > 0 ? ` (+${overflow})` : ""}`;
}

function activityText(feed: ChatTuiActivityFeed, maxRecords = feed.records.length): string {
  const records = feed.records.slice(0, maxRecords).map((entry) => `${entry.kind}:${entry.status}`).join(", ");
  const overflow = Math.max(0, feed.overflowCount + Math.max(0, feed.records.length - maxRecords));
  return `${records || "empty"}${overflow > 0 ? ` (+${overflow})` : ""}`;
}

function pluginShelfText(shelf: ChatTuiPluginShelf, maxItems: number): string {
  const top = shelf.items
    .slice(0, maxItems)
    .map((item) => `${boundSegment(item.pluginId, 18)}=${item.activeContributionCount}/${item.contributionCount} results=${item.resultListCount}${item.lastExecutionStatus ? ` last=${item.lastExecutionStatus}` : ""}`)
    .join(", ");
  const overflow = Math.max(0, shelf.overflowCount + Math.max(0, shelf.items.length - maxItems));
  return `${shelf.readiness} plugins=${shelf.totalPlugins} contributions=${shelf.totalContributions} conflicts=${shelf.conflicts} diagnostics=${shelf.diagnostics}${top ? ` top=${top}` : ""}${overflow > 0 ? ` (+${overflow})` : ""}`;
}

function statusLine(workbench: ChatTuiWorkbench): string {
  const telemetry = workbench.statusTelemetry
    ? ` | model=${workbench.statusTelemetry.modelId} cache=${cacheText(workbench.statusTelemetry)} ctx=${workbench.statusTelemetry.context.selectedTokens}/${workbench.statusTelemetry.context.hardLimitTokens}`
    : "";
  return `DeepSeek | ${workbench.layout} | focus=${workbench.focus.activePanel} | ${workbench.commandBar.open ? "command" : "ready"} | plugins=${workbench.pluginShelf.readiness}${telemetry}`;
}

function cacheText(telemetry: NonNullable<ChatTuiWorkbench["statusTelemetry"]>): string {
  if (telemetry.cache.status === "available" && telemetry.cache.hitRate !== undefined) {
    return `${Math.round(telemetry.cache.hitRate * 100)}%`;
  }
  return telemetry.cache.status;
}

function keyLine(workbench: ChatTuiWorkbench, columns: number): string {
  const left = ` Keys ${workbench.keyboardHints.map((hint) => `${hint.key}:${hint.label}`).join("  ")}`;
  const right = `mode ${workbench.commandBar.mode}`;
  return fitColumns(left, right, columns);
}

function fitColumns(left: string, right: string, columns: number): string {
  const minimumGap = 2;
  if (left.length + right.length + minimumGap <= columns) {
    return `${left}${" ".repeat(columns - left.length - right.length)}${right}`;
  }
  const rightBudget = Math.min(right.length, Math.max(12, Math.floor(columns * 0.36)));
  const boundedRight = boundLine(right, rightBudget);
  const leftBudget = Math.max(1, columns - boundedRight.length - minimumGap);
  return `${boundLine(left, leftBudget)}${" ".repeat(minimumGap)}${boundedRight}`;
}

function borderLine(columns: number, char: string): string {
  return char.repeat(columns);
}

function boundLine(line: string, maxWidth: number): string {
  if (line.length <= maxWidth) return line;
  return `${line.slice(0, Math.max(0, maxWidth - 3))}...`;
}

function boundSegment(text: string, maxWidth: number): string {
  return boundLine(text.replace(/\s+/g, " ").trim(), maxWidth);
}

function formatInputAnchor(text: string, maxColumns?: number): string {
  const prefix = "deepseek> ";
  const suffix = "_";
  const safeText = sanitizeInputTextForDisplay(text);
  if (maxColumns === undefined) return `${prefix}${safeText}${suffix}`;
  const contentBudget = Math.max(0, maxColumns - displayWidth(prefix) - displayWidth(suffix));
  return `${prefix}${tailByDisplayWidth(safeText, contentBudget)}${suffix}`;
}

function createPromptPreviewLines(text: string, maxLines: number, maxColumns: number): readonly string[] {
  if (maxLines <= 0 || !hasMultipleDisplayLines(text)) return [];
  const lines = text.split(/\r\n|\n|\r/);
  const tailCount = Math.max(1, maxLines - 1);
  const tail = lines.slice(-tailCount).map((line) => tailByDisplayWidth(sanitizeInputTextForDisplay(line), maxColumns));
  return [`${lines.length} lines pasted, showing tail`, ...tail];
}

function hasMultipleDisplayLines(text: string): boolean {
  return /[\r\n]/.test(text);
}

function sanitizeInputTextForDisplay(text: string): string {
  let safe = "";
  for (const char of Array.from(text)) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\n") safe += "\\n";
    else if (char === "\r") safe += "\\r";
    else if (char === "\t") safe += "\\t";
    else if (code === 0x1b) safe += "\\x1b";
    else if (code < 32 || (code >= 0x7f && code < 0xa0)) safe += controlByteText(code);
    else safe += char;
  }
  return safe;
}

function controlByteText(code: number): string {
  if (code >= 1 && code <= 26) return `^${String.fromCharCode(64 + code)}`;
  return `\\x${code.toString(16).padStart(2, "0")}`;
}

function tailByDisplayWidth(text: string, maxColumns: number): string {
  if (displayWidth(text) <= maxColumns) return text;
  const marker = "...";
  if (maxColumns <= displayWidth(marker)) return takeTailByDisplayWidth(text, maxColumns);
  return `${marker}${takeTailByDisplayWidth(text, maxColumns - displayWidth(marker))}`;
}

function takeTailByDisplayWidth(text: string, maxColumns: number): string {
  const tail: string[] = [];
  let used = 0;
  for (const char of Array.from(text).reverse()) {
    const width = displayWidth(char);
    if (used + width > maxColumns) break;
    tail.unshift(char);
    used += width;
  }
  return tail.join("");
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of Array.from(text)) width += charDisplayWidth(char);
  return width;
}

function charDisplayWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (code >= 0x300 && code <= 0x36f) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) return 2;
  return 1;
}
