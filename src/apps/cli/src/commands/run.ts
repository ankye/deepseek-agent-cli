import type { CliOptions, CliRunOptions } from "../types.js";
import { createCliAgentRuntime } from "../host/runtime.js";
import { resolveCliAgentLoopLimits, resolveCliModelProfile } from "../host/model-selection.js";
import { collectCliProjectRuleEvidence } from "../host/project-rules.js";
import type { CliTerminalCapabilityProfile } from "../host/terminal-profile.js";
import { emitAgentLoop, finalAgentLoopEvent, renderFinalJsonIfNeeded, resumeHint } from "../renderers/runtime-events.js";

export async function runOneShotCommand(
  options: CliOptions,
  write: (line: string) => Promise<void>,
  writeInline: (chunk: string) => Promise<void>,
  bufferedInline: boolean,
  terminalProfile: CliTerminalCapabilityProfile,
  runOptions: CliRunOptions
): Promise<void> {
  const workspaceRoot = process.cwd();
  const runtime = await createCliAgentRuntime({ live: options.live, workspaceRoot, ...(options.toolProjection ? { toolProjection: options.toolProjection } : {}), ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}), ...(options.model ? { model: options.model } : {}) }, runOptions);
  const reasoning = options.reasoning ?? (options.live ? { enabled: false } : undefined);
  const projectRules = await collectCliProjectRuleEvidence(runtime.deps.platform, workspaceRoot);
  const profile = resolveCliModelProfile(options);
  const limits = resolveCliAgentLoopLimits(options.prompt);
  try {
    const events = await emitAgentLoop(runtime.deps, runtime.kernel, {
      prompt: options.prompt,
      outputMode: options.output,
      workspaceRoot,
      caller: "cli.run",
      profile,
      live: options.live,
      ...(reasoning ? { reasoning } : {}),
      projectRules,
      ...(options.outputContract ? { outputContract: options.outputContract } : {}),
      selfRepair: {
        enabled: true,
        maxAttempts: 1,
        requireCheckpointForWrites: true,
        verificationMode: "targeted"
      },
      ...(options.toolProjection ? { toolProjection: options.toolProjection } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(limits ? { limits } : {})
    }, write, writeInline, bufferedInline, undefined, terminalProfile);
    await renderFinalJsonIfNeeded(options.output, events, write);
    if (options.output === "text") {
      const finalSessionId = finalAgentLoopEvent(events)?.sessionId ?? events.at(-1)?.sessionId;
      if (finalSessionId) await write(resumeHint(finalSessionId));
    }
  } finally {
    await runtime.kernel.shutdown("cli-run-completed");
  }
}
