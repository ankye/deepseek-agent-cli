import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { CliTerminalCapabilityProfile } from "../src/apps/cli/src/host/terminal-profile.js";
import { createChatTuiState, renderChatTuiFullscreenFrame } from "../src/apps/cli/src/commands/chat-tui.js";

const OUT_DIR = resolve(".codex/tmp/tui-screenshot");
const HTML_PATH = resolve(OUT_DIR, "tui-fullscreen.html");
const TEXT_PATH = resolve(OUT_DIR, "tui-fullscreen.txt");
const PNG_PATH = resolve(OUT_DIR, "tui-fullscreen.png");
const COLUMNS = 128;
const ROWS = 24;

const requiredFrameText = [
  "DeepSeek Workbench",
  "+ Transcript *",
  "+ Reasoning",
  "+ Inspector",
  "+ Plugins",
  "+ Input",
  "No assistant turn is streaming yet.",
  "No active turn",
  "Current selection",
  "Keys | / commands",
  "Mode Ready"
];

mkdirSync(OUT_DIR, { recursive: true });
const frameText = renderFrameText();
writeFileSync(TEXT_PATH, frameText, "utf8");
writeFileSync(HTML_PATH, htmlFor(frameText), "utf8");
assertFrameText(frameText);

const browser = findBrowser();
const result = spawnSync(browser.command, [
  ...browser.args,
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  `--screenshot=${PNG_PATH}`,
  "--window-size=1280,720",
  pathToFileURL(HTML_PATH).href
], { encoding: "utf8" });

if (result.status !== 0) {
  throw new Error(`TUI screenshot browser failed with status ${result.status ?? "unknown"}: ${result.stderr || result.stdout}`);
}

const pngBytes = statSync(PNG_PATH).size;
if (pngBytes < 10_000) throw new Error(`TUI screenshot is too small to be credible: ${pngBytes} bytes`);

console.log(JSON.stringify({
  ok: true,
  screenshotPath: PNG_PATH,
  htmlPath: HTML_PATH,
  textPath: TEXT_PATH,
  pngBytes,
  columns: COLUMNS,
  rows: ROWS
}, null, 2));

function renderFrameText(): string {
  const terminalProfile: CliTerminalCapabilityProfile = {
    rendererProfile: "full-screen",
    inputStrategy: "raw",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    isCI: false,
    platform: process.platform,
    columns: COLUMNS,
    colorDepth: "ansi256",
    unicode: process.platform === "win32" ? "basic" : "unicode",
    rawInput: true,
    inlineText: true,
    tuiProfile: "full-screen",
    reasons: ["renderer:full-screen", "input:raw", "tui:full-screen"]
  };
  const state = createChatTuiState({ enabled: true, terminalProfile, sessionId: "session-screenshot-check" });
  const frame = renderChatTuiFullscreenFrame({ workbench: state.workbench, phase: "repaint", rows: ROWS });
  return frame.chunks.at(-1) ?? "";
}

function assertFrameText(text: string): void {
  const lines = text.split(/\r?\n/);
  const missing = requiredFrameText.filter((entry) => !text.includes(entry));
  if (missing.length > 0) throw new Error(`TUI screenshot frame is missing expected regions: ${missing.join(", ")}`);
  if (lines.length !== ROWS) throw new Error(`TUI screenshot frame row mismatch: expected ${ROWS}, got ${lines.length}`);
  const narrow = lines.find((line) => line.length !== COLUMNS);
  if (narrow) throw new Error(`TUI screenshot frame width mismatch: expected ${COLUMNS}, got ${narrow.length}`);
}

function htmlFor(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
body { margin: 0; background: #05090d; color: #d8e7ff; font-family: Consolas, "Cascadia Mono", monospace; }
.terminal { width: 1280px; height: 720px; padding: 24px 32px; box-sizing: border-box; background: #0d141d; border: 1px solid #26384c; box-shadow: inset 0 0 0 1px #101d2a; }
.header { color: #91c8ff; height: 24px; display: flex; justify-content: space-between; font-size: 14px; }
pre { margin: 0; font-size: 15px; line-height: 1.5; white-space: pre; }
</style></head><body><div class="terminal"><div class="header"><span>DeepSeek full-screen TUI screenshot check</span><span>128x24 raw TTY</span></div><pre>${escaped}</pre></div></body></html>`;
}

function findBrowser(): { readonly command: string; readonly args: readonly string[] } {
  const explicit = process.env.TUI_SCREENSHOT_BROWSER;
  const candidates = [
    explicit,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "msedge",
    "microsoft-edge",
    "google-chrome",
    "chromium",
    "chromium-browser"
  ].filter((entry): entry is string => Boolean(entry));
  for (const candidate of candidates) {
    if (candidate.includes("\\") && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return { command: candidate, args: [] };
  }
  throw new Error("No Edge/Chrome/Chromium browser found. Set TUI_SCREENSHOT_BROWSER to run the screenshot check.");
}
