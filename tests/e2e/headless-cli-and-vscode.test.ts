import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { ProtocolEnvelope } from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";
import { createDefaultRuntimeKernel, runtimeEchoCapability } from "@deepseek/runtime";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";
import { runCli } from "../../src/apps/cli/src/index.js";
import { activate } from "../../src/apps/vscode-extension/src/index.js";

before(() => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["run", "build:cli"], {
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});

describe("host adapter smoke", () => {
  it("runs CLI jsonl and activates VSCode bridge", async () => {
    const lines: string[] = [];
    await runCli(["run", "e2e", "--output", "jsonl"], (line: string) => {
      lines.push(line);
    });
    assert.ok(lines.some((line) => JSON.parse(line).kind === "agent.loop.completed"));
    assert.ok(lines.some((line) => JSON.parse(line).kind === "model.delta"));
    const bridge = activate({ subscriptions: [] });
    assert.equal(bridge.context.hostKind, "vscode");
  });

  it("runs CLI one-shot command in JSON summary mode", async () => {
    const lines: string[] = [];
    await runCli(["run", "kernel e2e", "--output", "json"], (line: string) => {
      lines.push(line);
    });
    const summary = JSON.parse(lines[0] ?? "{}") as { status?: string; sessionId?: string; traceId?: string };
    assert.equal(summary.status, "completed");
    assert.equal(typeof summary.sessionId, "string");
    assert.equal(typeof summary.traceId, "string");
  });

  it("runs CLI core tools smoke through runtime events without live provider access", async () => {
    const lines: string[] = [];
    await runCli(["tools-smoke", "--output", "jsonl"], (line: string) => {
      lines.push(line);
    });
    const events = lines.map((line) => JSON.parse(line) as { kind: string; error?: { code?: string } });

    assert.equal(events.filter((event) => event.kind === "execution.envelope.created").length, 3);
    assert.equal(events.some((event) => event.kind === "capability.completed"), true);
    assert.equal(events.some((event) => event.kind === "execution.rejected" && event.error?.code === "KERNEL_POLICY_DENIED"), true);
    assert.equal(events.some((event) => event.kind === "scheduler.completed"), true);
    assert.equal(lines.join("\n").includes("sk-live-secret-value"), false);
  });

  it("runs scripted chat prompts and exits cleanly", async () => {
    const lines: string[] = [];
    await runCli(["chat", "--output", "jsonl"], (line: string) => {
      lines.push(line);
    }, ["hello e2e\n/exit\n"], { stdinIsTTY: false, stdoutIsTTY: false });
    const events = lines.map((line) => JSON.parse(line) as { kind: string });

    assert.equal(events.some((event) => event.kind === "agent.loop.started"), true);
    assert.equal(events.some((event) => event.kind === "model.delta"), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal(lines.join("\n").includes("sk-live-secret-value"), false);
  });

  it("runs scriptable session resume and fork failures without live provider access", async () => {
    const resumeLines: string[] = [];
    await runCli(["session", "resume", "session-missing", "--output", "json"], (line: string) => {
      resumeLines.push(line);
    });
    const resume = JSON.parse(resumeLines[0] ?? "{}") as { ok?: boolean; error?: { code?: string } };
    assert.equal(resume.ok, false);
    assert.equal(resume.error?.code, "SESSION_NOT_FOUND");

    const forkLines: string[] = [];
    await runCli(["session", "fork", "session-missing", "--output", "json"], (line: string) => {
      forkLines.push(line);
    });
    const fork = JSON.parse(forkLines[0] ?? "{}") as { ok?: boolean; error?: { code?: string } };
    assert.equal(fork.ok, false);
    assert.equal(fork.error?.code, "SESSION_NOT_FOUND");
    assert.equal([...resumeLines, ...forkLines].join("\n").includes("sk-live-secret-value"), false);
  });

  it("runs the built CLI binary with traceable runtime metadata", () => {
    assert.equal(existsSync("src/apps/cli/dist/index.js"), true, "run npm run build:cli before npm run test:e2e");
    const result = spawnSync(process.execPath, ["src/apps/cli/dist/index.js", "run", "built e2e", "--output", "jsonl"], {
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);

    const events = result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; sessionId?: string; trace?: { traceId?: string; correlationId?: string } });
    assert.deepEqual(
      events.map((event) => event.kind),
      [
        "agent.loop.started",
        "turn.started",
        "visible.reasoning.recorded",
        "context.lcm.node-recorded",
        "hooks.invoked",
        "mode.interaction.changed",
        "mode.agent.bound",
        "agent.phase.plan.created",
        "visible.reasoning.recorded",
        "agent.phase.skipped",
        "agent.phase.skipped",
        "agent.phase.skipped",
        "agent.phase.skipped",
        "model.reasoning.effort.mapped",
        "evidence.classified",
        "visible.reasoning.recorded",
        "context.projection.started",
        "context.memory.collected",
        "context.projection.completed",
        "visible.reasoning.recorded",
        "tool.decision-board.snapshot",
        "hooks.invoked",
        "prompt.assembled",
        "visible.reasoning.recorded",
        "model.requested",
        "model.delta",
        "usage.updated",
        "model.finished",
        "model.done",
        "hooks.invoked",
        "visible.reasoning.recorded",
        "visible.reasoning.projected",
        "context.lcm.node-recorded",
        "turn.completed",
        "agent.loop.completed"
      ]
    );

    for (const event of events) {
      assert.equal(typeof event.sessionId, "string");
      assert.equal(typeof event.trace?.traceId, "string");
      assert.equal(typeof event.trace?.correlationId, "string");
    }
  });

  it("keeps raw secret fixtures out of CLI text and jsonl output", () => {
    const secret = "sk-live-1234567890";
    const text = spawnSync(process.execPath, ["--import", "tsx", "src/apps/cli/src/index.ts", "run", secret], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    const stream = spawnSync(process.execPath, ["--import", "tsx", "src/apps/cli/src/index.ts", "run", secret, "--output", "jsonl"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(text.stdout.includes(secret), false);
    assert.equal(text.stderr.includes(secret), false);
    assert.equal(stream.stdout.includes(secret), false);
    assert.equal(stream.stderr.includes(secret), false);
    assert.equal(stream.stdout.includes("[REDACTED"), true);
  });

  it("runs the built CLI binary in scripted chat mode", () => {
    assert.equal(existsSync("src/apps/cli/dist/index.js"), true, "run npm run build:cli before npm run test:e2e");
    const result = spawnSync(process.execPath, ["src/apps/cli/dist/index.js", "chat", "--output", "jsonl"], {
      encoding: "utf8",
      input: "built chat\n/exit\n"
    });
    assert.equal(result.status, 0, result.stderr);
    const events = result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string });

    assert.equal(events.some((event) => event.kind === "agent.loop.started"), true);
    assert.equal(events.some((event) => event.kind === "model.delta"), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
  });

  it("keeps the VSCode bridge transport-backed and isolated from CLI rendering", async () => {
    const subscriptions: Array<{ dispose(): unknown }> = [];
    const bridge = activate({ subscriptions });
    assert.equal(subscriptions.length, 1);
    assert.deepEqual(bridge.context.capabilities, ["commands", "chat-input", "editor-context", "approvals", "workspace-edits"]);

    const editorContext = await bridge.collectEditorContext();
    assert.deepEqual(editorContext, {
      activeDocument: null,
      selections: [],
      diagnostics: [],
      workspaceFolders: []
    });

    const stream = bridge.transport.receive()[Symbol.asyncIterator]();
    const event: ProtocolEnvelope = {
      protocolVersion: "1",
      schemaVersion: "1.0.0",
      id: "msg-e2e",
      messageId: asId<"message">("msg-e2e"),
      correlationId: asId<"correlation">("corr-e2e"),
      type: "event",
      createdAt: new Date(0).toISOString(),
      trace: {
        traceId: asId<"trace">("trace-e2e"),
        spanId: asId<"span">("span-e2e"),
        correlationId: asId<"correlation">("corr-e2e")
      },
      redaction: { class: "internal" },
      compatibility: { schemaVersion: "1.0.0" },
      routing: { host: "vscode", target: "host" },
      payload: {
        event: {
          kind: "capability.completed",
          sessionId: asId<"session">("session-e2e"),
          createdAt: new Date(0).toISOString(),
          trace: {
            traceId: asId<"trace">("trace-e2e"),
            spanId: asId<"span">("span-e2e"),
            correlationId: asId<"correlation">("corr-e2e")
          },
          data: {}
        }
      }
    };
    await bridge.transport.send(event);
    assert.deepEqual((await stream.next()).value, event);
  });

  it("lets VSCode project runtime kernel events without importing CLI", async () => {
    const bridge = activate({ subscriptions: [] });
    const deps = createDeterministicRuntimeDependencies();
    const kernel = await createDefaultRuntimeKernel(deps);
    const events: unknown[] = [];
    for await (const event of bridge.projectRuntimeEvents(kernel, {
      capabilityId: runtimeEchoCapability.id,
      caller: "vscode",
      input: { text: "vscode kernel" }
    })) {
      events.push(event);
    }
    assert.equal(bridge.getRenderedEvents().some((event) => event.kind === "capability.completed"), true);
    assert.equal(events.some((event) => (event as { kind?: string }).kind === "workflow.opened"), true);
    await kernel.shutdown();
  });
});
