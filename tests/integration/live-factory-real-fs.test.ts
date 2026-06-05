import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  JsonObject,
  ModelGateway,
  ModelRequest,
  ModelStreamEvent,
  ToolResultFeedback
} from "@deepseek/platform-contracts";
import { collectRuntimeEvents, createDefaultRuntimeKernel, registerRuntimeCoreTools, runAgentLoop } from "@deepseek/runtime";
import { createLiveCliDependencies } from "@deepseek/testing-regression";
import { NodePlatformRuntime } from "@deepseek/platform-abstraction";
import { defaultDeepSeekProfile } from "@deepseek/model-gateway";

class SingleToolCallModelGateway implements ModelGateway {
  constructor(private readonly name: string, private readonly input: JsonObject) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.messages?.some((message) => message.role === "tool")) {
      yield { kind: "delta", text: "real file read resolved" };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "tool-call", id: "call-live-factory", name: this.name, input: this.input };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

describe("live CLI dependency factory resolves against real filesystem", () => {
  it("core.file.read resolves a fixture file through the real NodePlatformRuntime", async () => {
    const workspaceRoot = resolve(process.cwd(), "tests/fixtures/fake-workspace");
    const liveDeps = createLiveCliDependencies({ workspaceRoot });
    const deps = { ...liveDeps, models: new SingleToolCallModelGateway("core.file.read", { path: "README.md" }) };
    await registerRuntimeCoreTools(deps, workspaceRoot);
    const kernel = await createDefaultRuntimeKernel(deps);

    const events = await collectRuntimeEvents(runAgentLoop(deps, kernel, {
      prompt: "read fixture readme through live factory",
      caller: "integration.live-factory.test",
      workspaceRoot,
      outputMode: "jsonl",
      profile: defaultDeepSeekProfile
    }));

    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("Fake file not found"), false, "real platform runtime must not report fake-filesystem errors");

    const resultEvent = events.find((event) => event.kind === "model.tool.result");
    assert.ok(resultEvent, "model.tool.result event should exist");
    const feedback = (resultEvent!.data as { feedback?: ToolResultFeedback }).feedback;
    assert.ok(feedback);
    assert.equal(feedback.status, "success");
    assert.equal(feedback.preview.text.includes("Fake Workspace"), true, `expected fixture content in preview, got ${feedback.preview.text.slice(0, 80)}`);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    await kernel.shutdown();
  });

  it("returns a dependency bundle whose platform is a real NodePlatformRuntime", () => {
    const deps = createLiveCliDependencies();
    assert.equal(deps.platform instanceof NodePlatformRuntime, true);
    assert.equal(typeof deps.workspaceState.snapshot, "function");
    assert.equal(typeof deps.codeIntelligence.diagnostics, "function");
  });

  it("leaves deterministic dependencies in place for non-platform concerns", () => {
    const deps = createLiveCliDependencies();
    assert.equal(typeof deps.bus.publish, "function");
    assert.equal(typeof deps.workflow.openInvocation, "function");
    assert.equal(typeof deps.concurrency.run, "function");
    assert.equal(typeof deps.sessions.create, "function");
    assert.equal(typeof deps.policy.decide, "function");
  });

  it("allows workspace writes only when explicitly requested", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "deepseek-live-write-"));
    try {
      const defaultDeps = createLiveCliDependencies({ workspaceRoot });
      const defaultRun = await runWriteTurn(defaultDeps, workspaceRoot);
      assert.equal(defaultRun.events.some((event) => event.kind === "execution.rejected"), true);
      assert.equal(defaultRun.events.some((event) => event.kind === "capability.completed"), false);

      const writeDeps = createLiveCliDependencies({ workspaceRoot, allowWorkspaceWrites: true });
      const writeRun = await runWriteTurn(writeDeps, workspaceRoot);
      assert.equal(writeRun.events.some((event) => event.kind === "capability.completed"), true);
      assert.equal(await readFile(join(workspaceRoot, "generated-webpage", "index.html"), "utf8"), "<h1>Live write</h1>\n");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("allows workspace process execution only when explicitly requested", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "deepseek-live-process-"));
    try {
      const writeOnlyDeps = createLiveCliDependencies({ workspaceRoot, allowWorkspaceWrites: true });
      const writeOnlyRun = await runShellTurn(writeOnlyDeps, workspaceRoot);
      assert.equal(writeOnlyRun.events.some((event) => event.kind === "execution.rejected"), true);
      assert.equal(writeOnlyRun.events.some((event) => event.kind === "capability.completed"), false);

      const processDeps = createLiveCliDependencies({
        workspaceRoot,
        allowWorkspaceWrites: true,
        allowWorkspaceProcesses: true
      });
      const processRun = await runShellTurn(processDeps, workspaceRoot);
      const resultEvent = processRun.events.find((event) => event.kind === "model.tool.result");
      const feedback = resultEvent?.data as { feedback?: ToolResultFeedback };
      assert.equal(processRun.events.some((event) => event.kind === "capability.completed"), true);
      assert.equal(feedback.feedback?.preview.text.includes("live process ok"), true);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

async function runWriteTurn(deps: ReturnType<typeof createLiveCliDependencies>, workspaceRoot: string) {
  const runtimeDeps = { ...deps, models: new SingleToolCallModelGateway("core.file.write", { path: "generated-webpage/index.html", content: "<h1>Live write</h1>\n" }) };
  await registerRuntimeCoreTools(runtimeDeps, workspaceRoot);
  const kernel = await createDefaultRuntimeKernel(runtimeDeps);
  try {
    return {
      events: await collectRuntimeEvents(runAgentLoop(runtimeDeps, kernel, {
        prompt: "write webpage file through live factory",
        caller: "integration.live-factory.test",
        workspaceRoot,
        outputMode: "jsonl",
        profile: defaultDeepSeekProfile,
        toolProjection: "read-write"
      }))
    };
  } finally {
    await kernel.shutdown();
  }
}

async function runShellTurn(deps: ReturnType<typeof createLiveCliDependencies>, workspaceRoot: string) {
  const runtimeDeps = {
    ...deps,
    models: new SingleToolCallModelGateway("core.shell.run", {
      command: process.execPath,
      args: ["-e", "console.log('live process ok')"],
      cwd: ".",
      timeoutMs: 30_000
    })
  };
  await registerRuntimeCoreTools(runtimeDeps, workspaceRoot);
  const kernel = await createDefaultRuntimeKernel(runtimeDeps);
  try {
    return {
      events: await collectRuntimeEvents(runAgentLoop(runtimeDeps, kernel, {
        prompt: "run a scoped process through live factory",
        caller: "integration.live-factory.test",
        workspaceRoot,
        outputMode: "jsonl",
        profile: defaultDeepSeekProfile,
        toolProjection: "all"
      }))
    };
  } finally {
    await kernel.shutdown();
  }
}
