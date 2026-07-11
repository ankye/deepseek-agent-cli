import type { CliInputStream, CliRunOptions, CliTerminalFlags, CliWrite } from "../types.js";
import { cliUsageLines, parseCliArgs } from "../commands/parse.js";
import { runChatCommand } from "../commands/chat.js";
import { runCoreToolsSmoke } from "../commands/tools-smoke.js";
import { runContextCommand } from "../commands/context.js";
import { runDevCheckCommand } from "../commands/dev-check.js";
import { runFileManagerCommand } from "../commands/file-manager.js";
import { runGitReviewCommand } from "../commands/git-review.js";
import { runJumpNavigatorCommand } from "../commands/jump-navigator.js";
import { runMcpCommand } from "../commands/mcp.js";
import { runMemoryCommand } from "../commands/memory.js";
import { runModeCommand } from "../commands/mode.js";
import { runOneShotCommand } from "../commands/run.js";
import { runPaletteCommand } from "../commands/palette.js";
import { runReadinessCommand } from "../commands/readiness.js";
import { runRevertCommand } from "../commands/revert.js";
import { runSessionCommand } from "../commands/session.js";
import { runRepoNavigatorCommand } from "../commands/repo.js";
import { runDiagnosticsCommand } from "../diagnostics/index.js";
import { runExtensionCommand } from "../commands/extension.js";
import { runIndexProviderCommand } from "../commands/index-provider.js";
import { createInlineWriter, shouldBufferInline, terminalFlagsFromProcess, terminalHostFactsFromProcess } from "../host/terminal.js";
import { createTerminalCapabilityProfile } from "../host/terminal-profile.js";

export async function runCli(
  args: readonly string[],
  write: CliWrite = console.log,
  input: CliInputStream = process.stdin,
  terminal: CliTerminalFlags = terminalFlagsFromProcess(),
  runOptions: CliRunOptions = {}
): Promise<void> {
  const options = parseCliArgs(args, terminal);
  const terminalProfile = createTerminalCapabilityProfile({
    command: options.command,
    output: options.output,
    terminal,
    input,
    ...(options.tuiProfile ? { tuiProfile: options.tuiProfile } : {}),
    facts: await terminalHostFactsFromProcess()
  });
  const writer = (line: string) => Promise.resolve(write(line));
  const inlineWriter = createInlineWriter(write, terminalProfile);
  const bufferedInline = shouldBufferInline(write, terminalProfile);
  const effectiveRunOptions = options.workspaceRoot
    ? { ...runOptions, workspaceRoot: options.workspaceRoot }
    : runOptions;
  if (options.command === "help") {
    for (const line of cliUsageLines()) await writer(line);
    return;
  }
  if (options.command === "readiness") {
    await runReadinessCommand(options, writer, effectiveRunOptions);
    return;
  }
  if (options.command === "diagnostics") {
    await runDiagnosticsCommand(options, writer, effectiveRunOptions);
    return;
  }
  if (options.command === "extension") {
    await runExtensionCommand(options, writer);
    return;
  }
  if (options.command === "index-provider") {
    await runIndexProviderCommand(options, writer, effectiveRunOptions);
    return;
  }
  if (options.command === "mode") {
    await runModeCommand(options, writer);
    return;
  }
  if (options.command === "memory") {
    await runMemoryCommand(options, writer, effectiveRunOptions);
    return;
  }
  if (options.command === "context") {
    await runContextCommand(options, writer, effectiveRunOptions);
    return;
  }
  if (options.command === "checks") {
    await runDevCheckCommand(options, writer, effectiveRunOptions);
    return;
  }
  if (options.command === "file") {
    await runFileManagerCommand(options, writer, effectiveRunOptions);
    return;
  }
  if (options.command === "repo") {
    await runRepoNavigatorCommand(options, writer, effectiveRunOptions);
    return;
  }
  if (options.command === "git") {
    await runGitReviewCommand(options, writer, effectiveRunOptions);
    return;
  }
  if (options.command === "jump") {
    await runJumpNavigatorCommand(options, writer, effectiveRunOptions);
    return;
  }
  if (options.command === "palette") {
    await runPaletteCommand(options, writer);
    return;
  }
  if (options.command === "revert") {
    await runRevertCommand(options, writer, effectiveRunOptions);
    return;
  }
  if (options.command === "tools-smoke") {
    await runCoreToolsSmoke(writer, options.output);
    return;
  }
  if (options.command === "session") {
    await runSessionCommand(options, writer, effectiveRunOptions);
    return;
  }
  if (options.command === "mcp") {
    await runMcpCommand(options, writer);
    return;
  }
  if (options.command === "chat") {
    await runChatCommand(options, writer, inlineWriter, bufferedInline, input, terminalProfile, effectiveRunOptions);
    return;
  }
  await runOneShotCommand(options, writer, inlineWriter, bufferedInline, terminalProfile, effectiveRunOptions);
}
