import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { RuntimeDependencies, RuntimeKernel } from "@deepseek/platform-contracts";
import { dispatchRawInputToTui } from "../src/commands/chat-raw-input.js";
import { createChatTuiController, createChatTuiInputFrame, renderChatTuiFullscreenFrame, renderChatTuiStartup, renderChatTuiWorkbench } from "../src/commands/chat-tui.js";
import { runChatCommand } from "../src/commands/chat.js";
import { readCliChatPrompts } from "../src/input/chat-input.js";
import type { ChatTui } from "../src/commands/chat-tui.js";
import type { CliTerminalCapabilityProfile } from "../src/host/terminal-profile.js";
import type { CliInputStream, CliOptions, CliRunOptions } from "../src/types.js";

function createInteractiveTerminalProfile(): CliTerminalCapabilityProfile {
  return {
    rendererProfile: "interactive",
    inputStrategy: "raw",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    isCI: false,
    platform: "linux",
    colorDepth: "truecolor",
    unicode: "unicode",
    rawInput: true,
    inlineText: true,
    reasons: []
  };
}

function createFullScreenTerminalProfile(): CliTerminalCapabilityProfile {
  return {
    ...createInteractiveTerminalProfile(),
    rendererProfile: "full-screen",
    columns: 120,
    tuiProfile: "full-screen"
  };
}

function createTui(enabled = true): ChatTui {
  return createChatTuiController({
    enabled,
    terminalProfile: createInteractiveTerminalProfile(),
    write: async () => undefined,
    writeInline: async () => undefined
  });
}

function createTuiWithProfile(profile: CliTerminalCapabilityProfile, enabled = true): ChatTui {
  return createChatTuiController({
    enabled,
    terminalProfile: profile,
    write: async () => undefined,
    writeInline: async () => undefined
  });
}

function createChatOptions(tuiProfile?: CliOptions["tuiProfile"]): CliOptions {
  return {
    command: "chat",
    prompt: "",
    output: "text",
    live: false,
    ...(tuiProfile ? { tuiProfile } : {})
  };
}

function createRawTtyInput(chunks: readonly string[]): CliInputStream & {
  readonly isTTY: true;
  readonly rawModes: boolean[];
  setRawMode(enabled: boolean): void;
  resume(): void;
  pause(): void;
} {
  const rawModes: boolean[] = [];
  return {
    isTTY: true,
    rawModes,
    setRawMode(enabled: boolean) {
      rawModes.push(enabled);
    },
    resume() {},
    pause() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    }
  };
}

function createRunOptions(): CliRunOptions {
  const kernel = {
    shutdown: async () => undefined
  } as unknown as RuntimeKernel;
  const deps = {} as unknown as RuntimeDependencies;
  return {
    createRuntime: async () => ({ deps, kernel })
  };
}

async function readPrompts(tui: ChatTui, chunks: readonly string[]): Promise<readonly string[]> {
  async function* stream(): AsyncIterable<string> {
    for (const chunk of chunks) yield chunk;
  }

  const outputs: string[] = [];
  for await (const text of readCliChatPrompts(stream(), "raw", (event, context) => dispatchRawInputToTui(tui, event, context))) {
    outputs.push(text);
  }
  return outputs;
}

describe("chat TUI workbench interactions", () => {
  it("opens command bar on empty slash only", async () => {
    const tui = createTui();
    const outputs = await readPrompts(tui, ["/"]);

    assert.deepEqual(outputs, []);
    assert.equal(tui.snapshot().workbench.commandBar.open, true);
    assert.equal(tui.snapshot().workbench.commandBar.query, "");
    assert.equal(tui.snapshot().workbench.focus.activePanel, "command-bar");
  });

  it("keeps slash as prompt text when pending input is not empty", async () => {
    const tui = createTui();
    const outputs = await readPrompts(tui, ["a", "/", "\n"]);

    assert.deepEqual(outputs, ["a/"]);
    assert.equal(tui.snapshot().workbench.commandBar.open, false);
  });

  it("updates command-bar query in real time without prompt-side emission", async () => {
    const tui = createTui();
    const outputs = await readPrompts(tui, ["/", "h"]);
    const commandBar = tui.snapshot().workbench.commandBar;

    assert.deepEqual(outputs, []);
    assert.equal(commandBar.query, "h");
    assert.ok(commandBar.suggestions.some((entry) => entry.commandName === "/help"));
  });

  it("keeps unmatched command-bar enter local", async () => {
    const tui = createTui();
    const outputs = await readPrompts(tui, ["/", "z", "z", "z", "\n"]);
    const commandBar = tui.snapshot().workbench.commandBar;

    assert.deepEqual(outputs, []);
    assert.equal(commandBar.open, true);
    assert.equal(commandBar.query, "zzz");
    assert.equal(commandBar.suggestions.length, 0);
  });

  it("uses Tab for suggestion navigation while command bar is open", async () => {
    const tui = createTui();
    await readPrompts(tui, ["/"]);
    const firstSuggestion = tui.snapshot().workbench.commandBar.activeSuggestionId;

    await readPrompts(tui, ["\t"]);

    assert.equal(tui.snapshot().workbench.focus.activePanel, "command-bar");
    assert.notEqual(tui.snapshot().workbench.commandBar.activeSuggestionId, firstSuggestion);
  });

  it("uses Tab for panel focus when command bar is closed", async () => {
    const tui = createTui();

    await readPrompts(tui, ["\t"]);

    assert.equal(tui.snapshot().workbench.focus.activePanel, "reasoning");
    assert.equal(tui.snapshot().workbench.commandBar.open, false);
  });

  it("submits interactive command suggestions only through explicit bridge output", async () => {
    const tui = createTui();
    const outputs = await readPrompts(tui, ["/", "h", "e", "l", "p", "\n"]);

    assert.deepEqual(outputs, ["/help"]);
    assert.equal(tui.snapshot().workbench.commandBar.open, false);
  });

  it("bridges Ctrl+C to an explicit exit command in raw TUI input", async () => {
    const tui = createTui();
    const outputs = await readPrompts(tui, ["\x03"]);

    assert.deepEqual(outputs, ["/exit"]);
  });

  it("makes exit discoverable in command suggestions", async () => {
    const tui = createTui();
    await readPrompts(tui, ["/", "e"]);

    assert.ok(tui.snapshot().workbench.commandBar.suggestions.some((entry) => entry.commandName === "/exit"));
  });

  it("renders line-mode summaries with explicit bounded sections", async () => {
    const tui = createTui();
    await readPrompts(tui, ["/", "h"]);

    const lines = renderChatTuiWorkbench(tui.snapshot().workbench);
    const commandLine = lines.find((line) => line.startsWith("Input |"));

    assert.ok(lines.every((line) => line.length <= 100));
    assert.match(lines[0] ?? "", /^Workbench command \| active=Commands/);
    assert.match(commandLine ?? "", /^Input \| \/h_ \| suggestions=/);
    assert.ok(lines.some((line) => line.startsWith("Active | Commands ")));
    assert.ok(lines.some((line) => line.startsWith("Keys |")));
  });

  it("keeps the initial line-mode screen low density and action oriented", () => {
    const tui = createTui();
    const lines = renderChatTuiWorkbench(tui.snapshot().workbench);
    const text = lines.join("\n");

    assert.equal(lines.length, 5);
    assert.ok(lines.every((line) => line.length <= 100));
    assert.equal(lines[0], "Workbench ready | active=Chat");
    assert.equal(lines[1], "Session | New conversation | 0 turns");
    assert.match(lines[2] ?? "", /^Panels \| Reasoning idle \| Inspector (empty|ready) \| Plugins ready$/);
    assert.equal(lines.at(-1), "Input | deepseek> _");
    assert.ok(!text.includes("focus="));
    assert.ok(!text.includes("promptReady="));
    assert.ok(!text.includes("governed-descriptors"));
    assert.ok(!text.includes("contributions="));
    assert.ok(!text.includes("diagnostics="));
    assert.ok(!text.includes("suggestions="));
    assert.ok(!text.includes("Input | deepseek> _ |"));
  });

  it("keeps startup copy focused on user actions instead of internals", () => {
    const tui = createTui();
    const lines = renderChatTuiStartup(tui.snapshot());
    const text = lines.join("\n");

    assert.ok(lines.length <= 5);
    assert.equal(lines.at(-1), "Input | deepseek> _");
    assert.ok(!text.includes("keymap="));
    assert.ok(!text.includes("Ready | deepseek> _"));
    assert.ok(!text.includes("focus=transcript"));
    assert.ok(!text.includes("promptReady=true"));
    assert.ok(!text.includes("governed-descriptors"));
  });

  it("exits the real chat loop when raw TUI receives Ctrl+C", async () => {
    const input = createRawTtyInput(["\x03"]);
    const lines: string[] = [];
    const inline: string[] = [];

    await runChatCommand(
      createChatOptions(),
      async (line) => {
        lines.push(line);
      },
      async (chunk) => {
        inline.push(chunk);
      },
      false,
      input,
      createInteractiveTerminalProfile(),
      createRunOptions()
    );

    const rendered = [...lines, ...inline].join("\n");
    assert.deepEqual(input.rawModes, [true, false]);
    assert.ok(rendered.includes("Input | deepseek> _"));
    assert.ok(!rendered.includes("Input | deepseek> _ |"));
    assert.ok(!rendered.includes("Ready | deepseek> _"));
    assert.ok(lines.some((line) => line.startsWith("[chat completed] turns=0")));
  });

  it("echoes raw prompt text updates in the real chat loop", async () => {
    const input = createRawTtyInput(["h", "i", "\x7f", "!", "\x03"]);
    const lines: string[] = [];
    const inline: string[] = [];

    await runChatCommand(
      createChatOptions(),
      async (line) => {
        lines.push(line);
      },
      async (chunk) => {
        inline.push(chunk);
      },
      false,
      input,
      createInteractiveTerminalProfile(),
      createRunOptions()
    );

    const renderedInline = inline.join("\n");
    assert.ok(renderedInline.includes("deepseek> h_"));
    assert.ok(renderedInline.includes("deepseek> hi_"));
    assert.ok(renderedInline.includes("deepseek> h!_"));
    assert.ok(!renderedInline.includes("deepseek> h_ |"));
    assert.ok(!renderedInline.includes("deepseek> h!_ |"));
    assert.ok(lines.some((line) => line.startsWith("[chat completed] turns=0")));
  });

  it("echoes command-bar query updates in the real chat loop", async () => {
    const input = createRawTtyInput(["/", "h", "\x03"]);
    const lines: string[] = [];
    const inline: string[] = [];

    await runChatCommand(
      createChatOptions(),
      async (line) => {
        lines.push(line);
      },
      async (chunk) => {
        inline.push(chunk);
      },
      false,
      input,
      createInteractiveTerminalProfile(),
      createRunOptions()
    );

    const renderedInline = inline.join("\n");
    const commandFrame = inline.find((chunk) => chunk.includes("deepseek> /h_")) ?? "";
    assert.ok(renderedInline.includes("deepseek> /_"));
    assert.ok(renderedInline.includes("deepseek> /h_"));
    assert.ok(renderedInline.includes("Suggestions | >/help - Show commands and shortcuts"));
    assert.ok(!renderedInline.includes("deepseek> /h_ |"));
    assert.ok(commandFrame.indexOf("Suggestions | >/help - Show commands and shortcuts") < commandFrame.indexOf("deepseek> /h_"));
    assert.ok(!commandFrame.includes("Tab move"));
    assert.ok(!commandFrame.includes("Enter accept"));
    assert.ok(!commandFrame.includes("Esc close"));
    assert.ok(lines.some((line) => line.startsWith("[chat completed] turns=0")));
  });

  it("renders full-screen command suggestions above a stable input box", async () => {
    const tui = createTuiWithProfile(createFullScreenTerminalProfile());
    await readPrompts(tui, ["/", "h"]);

    const frame = renderChatTuiFullscreenFrame({ workbench: tui.snapshot().workbench, rows: 24, phase: "repaint" }).chunks.join("\n");
    const suggestionsIndex = frame.indexOf("+ Suggestions");
    const inputIndex = frame.indexOf("+ Input");

    assert.ok(suggestionsIndex >= 0);
    assert.ok(inputIndex > suggestionsIndex);
    assert.ok(frame.includes("| >/help - Show commands and shortcuts"));
    assert.ok(frame.includes("| deepseek> /h_"));
    assert.ok(!frame.includes("promptReady=true"));
    assert.ok(!frame.includes("governed-descriptors"));
    assert.ok(!frame.includes("focus=command-bar"));
    assert.ok(!frame.includes("Tab move"));
    assert.ok(!frame.includes("Enter accept"));
    assert.ok(!frame.includes("Esc close"));
    assert.ok(!frame.includes("raw/full-screen"));
    assert.ok(!frame.includes("contributions="));
    assert.ok(!frame.includes("diagnostics="));
    assert.ok(frame.indexOf("Keys ") < inputIndex);
    assert.ok(frame.indexOf("DeepSeek |") < inputIndex);
  });

  it("repaints full-screen frames instead of line-mode prompt fragments", async () => {
    const input = createRawTtyInput(["/", "h", "\x03"]);
    const lines: string[] = [];
    const inline: string[] = [];

    await runChatCommand(
      createChatOptions("full-screen"),
      async (line) => {
        lines.push(line);
      },
      async (chunk) => {
        inline.push(chunk);
      },
      false,
      input,
      createFullScreenTerminalProfile(),
      createRunOptions()
    );

    const renderedInline = inline.join("\n");
    assert.ok(renderedInline.includes("\x1b[H\x1b[2J"));
    assert.equal(renderedInline.split("\x1b[2J").length - 1, 1);
    assert.ok(renderedInline.includes("+ Suggestions"));
    assert.ok(renderedInline.includes("| deepseek> /h_"));
    assert.ok(!renderedInline.includes("Suggestions | >/help"));
    assert.ok(lines.some((line) => line.startsWith("[chat completed] turns=0")));
  });

  it("echoes ordinary full-screen prompt text inside the input box", async () => {
    const input = createRawTtyInput(["h", "i", "\x03"]);
    const lines: string[] = [];
    const inline: string[] = [];

    await runChatCommand(
      createChatOptions("full-screen"),
      async (line) => {
        lines.push(line);
      },
      async (chunk) => {
        inline.push(chunk);
      },
      false,
      input,
      createFullScreenTerminalProfile(),
      createRunOptions()
    );

    const renderedInline = inline.join("\n");
    assert.ok(renderedInline.includes("\x1b[H\x1b[2J"));
    assert.equal(renderedInline.split("\x1b[2J").length - 1, 1);
    assert.ok(renderedInline.includes("+ Input"));
    assert.ok(renderedInline.includes("| deepseek> h_"));
    assert.ok(renderedInline.includes("| deepseek> hi_"));
    assert.ok(!renderedInline.includes("Input | deepseek> h_"));
    assert.ok(lines.some((line) => line.startsWith("[chat completed] turns=0")));
  });

  it("keeps long mixed-language prompt tails visible and bounded", async () => {
    const tui = createTuiWithProfile(createFullScreenTerminalProfile());
    const longPrompt = `prefix-${"x".repeat(120)}中文Mix-!@#$%^&*()_+=[]{}尾`;
    const inputFrame = createChatTuiInputFrame(tui.snapshot().workbench, {
      pending: longPrompt,
      maxInputColumns: 48
    });

    assert.equal(inputFrame.inputLine.length <= 48, true);
    assert.match(inputFrame.inputLine, /^deepseek> \.\.\./);
    assert.ok(inputFrame.inputLine.endsWith("中文Mix-!@#$%^&*()_+=[]{}尾_"));
    assert.equal(inputFrame.inputLine.includes("prefix-"), false);
  });

  it("keeps hundreds of log-shaped lines display-safe inside one input anchor", async () => {
    const tui = createTuiWithProfile(createFullScreenTerminalProfile());
    const noisyLog = [
      ...Array.from({ length: 240 }, (_, index) => (
        `line-${index} ERROR path=C:\\repo\\src\\file-${index}.ts:${index}:7\tjson={"msg":"中文-${index}|value"} \x1b[31mred\x1b[0m 🙂 !@#$%^&*()`
      )),
      "FINAL 中文🙂 symbols !@#$%^&*() path=C:\\tmp\\last.ts:999:1 \x1b[31mRED\x1b[0m"
    ].join("\n");
    const inputFrame = createChatTuiInputFrame(tui.snapshot().workbench, {
      pending: noisyLog,
      maxInputColumns: 120
    });

    assert.equal(inputFrame.inputLine.length <= 120, true);
    assert.match(inputFrame.inputLine, /^deepseek> \.\.\./);
    assert.equal(inputFrame.inputLine.includes("\n"), false);
    assert.equal(inputFrame.inputLine.includes("\r"), false);
    assert.equal(inputFrame.inputLine.includes("\t"), false);
    assert.equal(inputFrame.inputLine.includes("\x1b"), false);
    assert.ok(inputFrame.inputLine.includes("FINAL 中文🙂 symbols"));
    assert.ok(inputFrame.inputLine.includes("\\x1b[31mRED\\x1b[0m"));
    assert.ok(inputFrame.inputLine.endsWith("_"));

    const frame = renderChatTuiFullscreenFrame({
      workbench: tui.snapshot().workbench,
      pending: noisyLog,
      rows: 24,
      phase: "repaint"
    }).chunks.join("\n");
    assert.ok(frame.includes("+ Prompt preview"));
    assert.ok(frame.includes("241 lines pasted, showing tail"));
    assert.ok(frame.includes("FINAL 中文🙂 symbols"));
    assert.ok(frame.indexOf("+ Prompt preview") < frame.indexOf("+ Input"));
  });

  it("uses origin-only full-screen raw repaints after the initial clear", async () => {
    const input = createRawTtyInput(["a", "b", "c", "\x03"]);
    const lines: string[] = [];
    const inline: string[] = [];

    await runChatCommand(
      createChatOptions("full-screen"),
      async (line) => {
        lines.push(line);
      },
      async (chunk) => {
        inline.push(chunk);
      },
      false,
      input,
      createFullScreenTerminalProfile(),
      createRunOptions()
    );

    const clearChunks = inline.filter((chunk) => chunk.includes("\x1b[2J"));
    const repaintChunks = inline.filter((chunk) => chunk.startsWith("\x1b[H") && !chunk.includes("\x1b[2J"));
    assert.equal(clearChunks.length, 1);
    assert.ok(repaintChunks.length >= 3);
    assert.ok(inline.join("\n").includes("| deepseek> abc_"));
    assert.ok(lines.some((line) => line.startsWith("[chat completed] turns=0")));
  });

  it("buffers bracketed multiline paste as one prompt without opening command mode", async () => {
    const tui = createTui();
    const pasted = "/first\nline two 中文\nERROR path=C:\\repo\\x.ts:9:1";
    const outputs = await readPrompts(tui, [`\x1b[200~${pasted}\x1b[201~`, "\n"]);

    assert.deepEqual(outputs, [pasted]);
    assert.equal(tui.snapshot().workbench.commandBar.open, false);
    assert.equal(tui.snapshot().workbench.focus.activePanel, "transcript");
  });

  it("enables bracketed paste mode for full-screen lifecycle", () => {
    const tui = createTuiWithProfile(createFullScreenTerminalProfile());
    const enter = renderChatTuiFullscreenFrame({ workbench: tui.snapshot().workbench, phase: "enter" }).chunks.join("");
    const teardown = renderChatTuiFullscreenFrame({ workbench: tui.snapshot().workbench, phase: "teardown" }).chunks.join("");

    assert.ok(enter.includes("\x1b[?2004h"));
    assert.ok(teardown.includes("\x1b[?2004l"));
  });

  it("preserves raw prompt behavior when TUI is disabled", async () => {
    const tui = createTui(false);
    const outputs = await readPrompts(tui, ["/", "\n"]);

    assert.deepEqual(outputs, ["/"]);
  });

  it("preserves non-raw line input behavior", async () => {
    async function* stream(): AsyncIterable<string> {
      yield "hello\n";
    }

    const outputs: string[] = [];
    for await (const text of readCliChatPrompts(stream(), "line", () => {
      throw new Error("non-raw input should not dispatch local TUI events");
    })) {
      outputs.push(text);
    }

    assert.deepEqual(outputs, ["hello"]);
  });
});
