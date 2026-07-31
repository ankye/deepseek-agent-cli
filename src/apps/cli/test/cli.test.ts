import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { AGENT_MODE_COMPATIBILITY, AGENT_MODE_SCHEMA_VERSION, APPROVAL_SCHEMA_VERSION, INTERACTION_MODE_COMPATIBILITY, INTERACTION_MODE_SCHEMA_VERSION, TOOL_FAMILY_CATALOG_SCHEMA_VERSION, asId } from "@deepseek/platform-contracts";
import type { ApprovalId, ApprovalRequest, CapabilityExecutionContext, JsonObject, ModelGateway, ModelRequest, ModelStreamEvent, PlatformRuntime, PolicyDecision, PolicyEngine, PolicyRequest, ProcessResult, ProcessRunObserver, ProcessRunOptions, RuntimeEvent, SessionEvent, SessionId, WorkspaceEditTransaction } from "@deepseek/platform-contracts";
import { FakePlatformRuntime, NodePlatformRuntime } from "@deepseek/platform-abstraction";
import { createDefaultRuntimeKernel, registerRuntimeCoreTools } from "@deepseek/runtime";
import { createDeterministicRuntimeDependencies } from "@deepseek/testing-regression";
import { DurablePermanentMemoryProvider, InMemoryLosslessContextManager, InMemoryPermanentMemoryStorageAdapter } from "@deepseek/memory-cache-management";
import { chatPageIndexPagesFromSnapshot, explainChatPageIndexRecallItem, markStalePageIndexPagesAfterWorkspaceEdits, markStalePageIndexPagesFromWorkspaceWatermark, recordChatPageIndexTurn, renderChatPageIndexRecallExplain, resolveChatPageIndexRecall } from "../src/commands/pageindex.js";
import { boundedText, defineToolManifest, objectSchema, replay } from "@deepseek/core-coding-tools";
import { createChatPaletteState } from "../src/commands/palette-state.js";
import { collectCliEvaluation } from "../src/diagnostics/evaluation.js";
import { classifyCapabilityMatrixRun, collectCapabilityMatrix } from "../src/diagnostics/capability-matrix.js";
import { liveCredentialLaunchCwdEnvKey } from "@deepseek/credential-auth-management";
import { collectDeliveryCapabilitySummary } from "../src/diagnostics/delivery-capability.js";
import { buildEvaluationDeliveryCapabilityEvidence } from "../src/diagnostics/evaluation-delivery-evidence.js";
import { renderDiagnosticsResult } from "../src/diagnostics/index.js";
import { collectModeMatrix } from "../src/diagnostics/mode-matrix.js";
import { refreshAcceptanceEvidence } from "../src/diagnostics/refresh-evidence.js";
import { resolveCliAgentLoopLimits } from "../src/host/model-selection.js";
import {
  cliUsageLines,
  isCliEntryPoint,
  parseCliArgs,
  runCli
} from "../src/index.js";
import { registerCliEnvironmentCapabilities } from "../src/host/runtime.js";

describe("cli host adapter", () => {
  it("recognizes npm bin symlink entrypoints", async (t) => {
    const tempDir = await mkdtemp(join(tmpdir(), "deepseek-cli-bin-"));
    try {
      const packageDistDir = join(tempDir, "node_modules", "deepseek-agent-cli", "dist");
      const binDir = join(tempDir, "node_modules", ".bin");
      await mkdir(packageDistDir, { recursive: true });
      await mkdir(binDir, { recursive: true });

      const targetPath = join(packageDistDir, "index.js");
      const binPath = join(binDir, "deepseek");
      await writeFile(targetPath, "#!/usr/bin/env node\n");

      try {
        await symlink(targetPath, binPath, "file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          t.skip("file symlink creation is not available in this environment");
          return;
        }
        throw error;
      }

      assert.equal(isCliEntryPoint(binPath, pathToFileURL(targetPath).href), true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("recognizes package entrypoints launched through linked install paths", async (t) => {
    const tempDir = await mkdtemp(join(tmpdir(), "deepseek-cli-linked-root-"));
    try {
      const realDistDir = join(tempDir, "persist", "bin", "node_modules", "deepseek-agent-cli", "dist");
      const linkedRoot = join(tempDir, "current");
      await mkdir(realDistDir, { recursive: true });
      await writeFile(join(realDistDir, "index.js"), "#!/usr/bin/env node\n");

      try {
        await symlink(join(tempDir, "persist"), linkedRoot, "junction");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          t.skip("directory symlink creation is not available in this environment");
          return;
        }
        throw error;
      }

      const linkedEntryPath = join(linkedRoot, "bin", "node_modules", "deepseek-agent-cli", "dist", "index.js");
      const realEntryPath = join(realDistDir, "index.js");
      assert.equal(isCliEntryPoint(linkedEntryPath, pathToFileURL(realEntryPath).href), true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("recognizes package bin paths linked to workspace dist entrypoints", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "deepseek-cli-workspace-link-"));
    try {
      const packageDistDir = join(tempDir, "node_modules", "deepseek-agent-cli", "dist");
      const workspaceDistDir = join(tempDir, "src", "apps", "cli", "dist");
      await mkdir(packageDistDir, { recursive: true });
      await mkdir(workspaceDistDir, { recursive: true });

      const packageEntryPath = join(packageDistDir, "index.js");
      const workspaceEntryPath = join(workspaceDistDir, "index.js");
      await writeFile(packageEntryPath, "#!/usr/bin/env node\n");
      await writeFile(workspaceEntryPath, "#!/usr/bin/env node\n");

      assert.equal(isCliEntryPoint(packageEntryPath, pathToFileURL(workspaceEntryPath).href), true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("registers agent-visible CLI environment preparation without host-side execution", async () => {
    const platform = new FakePlatformRuntime("fake");
    const deps = createDeterministicRuntimeDependencies({ platform });
    await registerRuntimeCoreTools(deps, "/workspace");
    await registerCliEnvironmentCapabilities(deps, "/workspace", { env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" } });

    const manifest = await deps.capabilities.get(asId<"capability">("core.env.prepare"));
    const visibleTools = await deps.capabilities.listModelVisible();
    assert.equal(manifest?.projection?.modelVisible, true);
    assert.equal(visibleTools.some((tool) => tool.id === "core.env.prepare"), true);
    assert.equal(String(manifest?.description ?? "").includes("SWE-bench Lite"), true);
    assert.equal(String(manifest?.description ?? "").includes("run this first"), false);

    const result = await deps.capabilities.execute(asId<"capability">("core.env.prepare"), {
      profile: "swe-bench-lite"
    }, capabilityContext());

    assert.equal(result.ok, true);
    const value = result.value as { evidence?: { preview?: { text?: string }; metadata?: JsonObject } };
    const preview = value.evidence?.preview?.text ?? "";
    const metadata = value.evidence?.metadata as { profileId?: string; dryRun?: boolean; execute?: boolean; dependencyCounts?: JsonObject } | undefined;
    assert.equal(preview.includes("swe-bench-lite"), true);
    assert.equal(preview.includes("dependencies"), true);
    assert.equal(preview.includes("fixture-secret-value"), false);
    assert.equal(preview.includes("brew install"), false);
    assert.equal(preview.includes("deepseek diagnostics"), false);
    assert.equal(metadata?.profileId, "swe-bench-lite");
    assert.equal(metadata?.dryRun, true);
    assert.equal(metadata?.execute, false);
    assert.equal(typeof metadata?.dependencyCounts === "object", true);
  });

  it("parses the new run and chat commands without legacy prompt compatibility", () => {
    assert.deepEqual(parseCliArgs(["run", "hello", "--output", "jsonl"]), {
      command: "run",
      prompt: "hello",
      output: "jsonl",
      live: false
    });
    assert.deepEqual(parseCliArgs(["chat", "--output", "json", "--live", "--timeout-ms", "1000"]), {
      command: "chat",
      prompt: "",
      output: "json",
      live: true,
      timeoutMs: 1000
    });
    assert.deepEqual(parseCliArgs(["chat", "--tool-projection", "safe-all", "--tool-opt-in", "network", "--output", "jsonl"]), {
      command: "chat",
      prompt: "",
      output: "jsonl",
      live: false,
      toolProjection: "safe-all",
      toolOptIns: ["network"]
    });
    assert.deepEqual(parseCliArgs(["chat", "--session", "session-resume", "--output", "jsonl"]), {
      command: "chat",
      prompt: "",
      output: "jsonl",
      live: false,
      sessionId: asId<"session">("session-resume")
    });
    assert.deepEqual(parseCliArgs(["session", "board", "session-board", "--output", "json"]), {
      command: "session",
      prompt: "",
      output: "json",
      live: false,
      sessionAction: "board",
      sessionId: asId<"session">("session-board")
    });
    assert.deepEqual(parseCliArgs(["chat", "--tui", "full-screen", "--output", "text"]), {
      command: "chat",
      prompt: "",
      output: "text",
      live: false,
      tuiProfile: "full-screen"
    });
    assert.deepEqual(parseCliArgs(["run", "json task", "--thinking", "xhigh", "--output", "jsonl"]), {
      command: "run",
      prompt: "json task",
      output: "jsonl",
      live: false,
      reasoning: { enabled: true, effort: "xhigh" }
    });
    assert.deepEqual(parseCliArgs(["run", "json task", "--no-tools", "--output", "jsonl"]), {
      command: "run",
      prompt: "json task",
      output: "jsonl",
      live: false,
      toolProjection: "none"
    });
    assert.deepEqual(parseCliArgs(["run", "fetch docs", "--tool-opt-in", "network", "--tool-opt-in", "browser,connector", "--output", "jsonl"]), {
      command: "run",
      prompt: "fetch docs",
      output: "jsonl",
      live: false,
      toolOptIns: ["network", "browser", "connector"]
    });
    assert.deepEqual(parseCliArgs(["run", "inspect workspace", "--workspace-root", "/tmp/task-workspace", "--output", "jsonl"]), {
      command: "run",
      prompt: "inspect workspace",
      output: "jsonl",
      live: false,
      workspaceRoot: "/tmp/task-workspace"
    });
    assert.deepEqual(parseCliArgs([
      "run",
      "contract task",
      "--output-contract",
      "json-object",
      "--output-schema",
      "{\"type\":\"object\",\"required\":[\"ok\"],\"properties\":{\"ok\":{\"type\":\"boolean\"}}}",
      "--output-contract-description",
      "Return status JSON.",
      "--output",
      "jsonl"
    ]), {
      command: "run",
      prompt: "contract task",
      output: "jsonl",
      live: false,
      outputContract: {
        schemaVersion: "1.0.0",
        kind: "json-object",
        required: true,
        description: "Return status JSON.",
        schema: {
          type: "object",
          required: ["ok"],
          properties: { ok: { type: "boolean" } }
        },
        redaction: { class: "internal" }
      }
    });
    assert.deepEqual(parseCliArgs(["run", "plan task", "--output-contract", "command-plan", "--output", "jsonl"]), {
      command: "run",
      prompt: "plan task",
      output: "jsonl",
      live: false,
      outputContract: {
        schemaVersion: "1.0.0",
        kind: "command-plan",
        required: true,
        redaction: { class: "internal" }
      }
    });
    assert.deepEqual(parseCliArgs(["run", "stateful task", "--supervisor-workflow-state", ".deepseek/run-state.json", "--output", "jsonl"]), {
      command: "run",
      prompt: "stateful task",
      output: "jsonl",
      live: false,
      supervisorWorkflowStatePath: ".deepseek/run-state.json"
    });
    assert.deepEqual(parseCliArgs(["run", "repair task", "--additional-user-context-file", ".deepseek/repair.md", "--output", "jsonl"]), {
      command: "run",
      prompt: "repair task",
      output: "jsonl",
      live: false,
      additionalUserContextFile: ".deepseek/repair.md"
    });
    assert.deepEqual(parseCliArgs(["chat", "--live", "--thinking", "max", "--output", "jsonl"]), {
      command: "chat",
      prompt: "",
      output: "jsonl",
      live: true,
      reasoning: { enabled: true, providerEffort: "max" }
    });
    assert.deepEqual(parseCliArgs(["run", "glm task", "--live", "--provider", "glm", "--model", "glm-5.1", "--output", "jsonl"]), {
      command: "run",
      prompt: "glm task",
      output: "jsonl",
      live: true,
      modelProvider: "glm",
      model: "glm-5.1"
    });
    assert.deepEqual(parseCliArgs(["diagnostics", "doctor", "--live", "--provider", "glm", "--model", "glm-5.1", "--output", "json"]), {
      command: "diagnostics",
      diagnosticsCommand: "doctor",
      prompt: "",
      output: "json",
      live: true,
      modelProvider: "glm",
      model: "glm-5.1",
      diagnosticsInput: {
        command: "doctor",
        live: true,
        provider: "glm",
        model: "glm-5.1"
      }
    });
    assert.deepEqual(parseCliArgs(["diagnostics", "flow", "inspect", "--prompt", "继续", "--output", "json"]), {
      command: "diagnostics",
      diagnosticsCommand: "flow",
      prompt: "",
      output: "json",
      live: false,
      diagnosticsInput: {
        command: "flow",
        action: "inspect",
        prompt: "继续",
        extraArgs: []
      }
    });
    assert.deepEqual(parseCliArgs(["diagnostics", "capability-matrix", "run", "--task", "T01", "--task", "T05", "--report-dir", ".deepseek/capability-matrix/test", "--dry-run", "--output", "json"]), {
      command: "diagnostics",
      diagnosticsCommand: "capability-matrix",
      prompt: "",
      output: "json",
      live: false,
      diagnosticsInput: {
        command: "capability-matrix",
        action: "run",
        dryRun: true,
        taskIds: ["T01", "T05"],
        reportDir: ".deepseek/capability-matrix/test",
        extraArgs: []
      }
    });
    assert.deepEqual(parseCliArgs(["index-provider", "set", "zvec", "enabled", "--user", "--output", "json"]), {
      command: "index-provider",
      prompt: "",
      output: "json",
      live: false,
      indexProviderAction: "set",
      indexProviderId: "zvec",
      indexProviderStatus: "enabled",
      indexProviderScope: "user"
    });
    assert.deepEqual(parseCliArgs(["mode", "workers", "--output", "jsonl"]), {
      command: "mode",
      prompt: "",
      output: "jsonl",
      live: false,
      modeAction: "workers"
    });
    assert.deepEqual(parseCliArgs(["memory", "remember", "Use provider-backed memory", "--scope", "project", "--output", "json"]), {
      command: "memory",
      prompt: "",
      output: "json",
      live: false,
      memoryAction: "remember",
      memoryInput: { action: "remember", content: "Use provider-backed memory", scope: "project" }
    });
    assert.deepEqual(parseCliArgs(["context", "grep", "database", "--session", "session-context", "--output", "jsonl"]), {
      command: "context",
      prompt: "",
      output: "jsonl",
      live: false,
      contextInput: { raw: "grep database" },
      sessionId: asId<"session">("session-context")
    });
    assert.deepEqual(parseCliArgs(["checks", "lint", "--output", "jsonl"]), {
      command: "checks",
      prompt: "",
      output: "jsonl",
      live: false,
      checkAction: "lint",
      checkInput: { action: "lint", args: [] }
    });
    assert.deepEqual(parseCliArgs(["file", "preview", "src/index.ts", "--output", "json"]), {
      command: "file",
      prompt: "",
      output: "json",
      live: false,
      fileAction: "preview",
      fileInput: { action: "preview", query: "src/index.ts" }
    });
    assert.deepEqual(parseCliArgs(["file", "refs", ".ts", "--output", "jsonl"]), {
      command: "file",
      prompt: "",
      output: "jsonl",
      live: false,
      fileAction: "references",
      fileInput: { action: "references", query: ".ts" }
    });
    assert.deepEqual(parseCliArgs(["repo", "grep", "database", "--output", "json"]), {
      command: "repo",
      prompt: "",
      output: "json",
      live: false,
      repoAction: "grep",
      repoInput: { action: "grep", query: "database" }
    });
    assert.deepEqual(parseCliArgs(["git", "status", "--output", "jsonl"]), {
      command: "git",
      prompt: "",
      output: "jsonl",
      live: false,
      gitInput: { action: "status", args: [] }
    });
    assert.deepEqual(parseCliArgs(["jump", "text", "needle", "--output", "json"]), {
      command: "jump",
      prompt: "",
      output: "json",
      live: false,
      jumpAction: "text",
      jumpInput: { action: "text", query: "needle" }
    });
    assert.deepEqual(parseCliArgs(["jump", "symbol", "run", "--output", "jsonl"]), {
      command: "jump",
      prompt: "",
      output: "jsonl",
      live: false,
      jumpAction: "symbol",
      jumpInput: { action: "symbol", query: "run" }
    });
    assert.deepEqual(parseCliArgs(["revert", "preview", "--request", "request-1", "--output", "jsonl"]), {
      command: "revert",
      prompt: "",
      output: "jsonl",
      live: false,
      revertAction: "preview",
      revertTarget: { requestId: "request-1" }
    });
    assert.deepEqual(parseCliArgs(["revert", "apply", "--turn", "turn-1", "--output", "json"]), {
      command: "revert",
      prompt: "",
      output: "json",
      live: false,
      revertAction: "apply",
      revertTarget: { turnId: asId<"turn">("turn-1") }
    });
    assert.deepEqual(parseCliArgs(["diagnostics", "verify", "--output", "jsonl"]), {
      command: "diagnostics",
      diagnosticsCommand: "verify",
      prompt: "",
      output: "jsonl",
      live: false,
      diagnosticsInput: { command: "verify" }
    });
    assert.deepEqual(parseCliArgs(["diagnostics", "env", "prepare", "--profile", "swe-bench-lite", "--output", "json"]), {
      command: "diagnostics",
      diagnosticsCommand: "env",
      prompt: "",
      output: "json",
      live: false,
      diagnosticsInput: {
        command: "env",
        action: "prepare",
        profile: "swe-bench-lite",
        dryRun: true,
        execute: false,
        extraArgs: []
      }
    });
    assert.deepEqual(parseCliArgs(["diagnostics", "env", "prepare", "--profile", "swe-bench-lite", "--execute", "--output", "jsonl"]), {
      command: "diagnostics",
      diagnosticsCommand: "env",
      prompt: "",
      output: "jsonl",
      live: false,
      diagnosticsInput: {
        command: "env",
        action: "prepare",
        profile: "swe-bench-lite",
        dryRun: false,
        execute: true,
        extraArgs: []
      }
    });
    assert.deepEqual(parseCliArgs([
      "diagnostics",
      "swe-bench",
      "evaluate",
      "--predictions-path",
      ".deepseek/swe-lite-runs/glm.jsonl",
      "--report-dir",
      ".deepseek/swe-lite-runs/harness",
      "--run-id",
      "glm-run",
      "--instance-id",
      "astropy__astropy-12907",
      "--instance-id",
      "django__django-11099",
      "--cache-trace-path",
      ".deepseek/swe-lite-runs/glm-trace.jsonl",
      "--cache-hit-target",
      "0.9",
      "--harness-python",
      ".deepseek/swebench-venv/bin/python",
      "--output",
      "json"
    ]), {
      command: "diagnostics",
      diagnosticsCommand: "swe-bench",
      prompt: "",
      output: "json",
      live: false,
      diagnosticsInput: {
        command: "swe-bench",
        action: "evaluate",
        dryRun: false,
        instanceIds: ["astropy__astropy-12907", "django__django-11099"],
        predictionsPath: ".deepseek/swe-lite-runs/glm.jsonl",
        reportDir: ".deepseek/swe-lite-runs/harness",
        runId: "glm-run",
        cacheTracePath: ".deepseek/swe-lite-runs/glm-trace.jsonl",
        cacheHitTarget: 0.9,
        harnessPython: ".deepseek/swebench-venv/bin/python",
        extraArgs: []
      }
    });
    assert.equal(
      parseCliArgs([
        "diagnostics",
        "swe-bench",
        "evaluate",
        "--predictions-path",
        "predictions.jsonl",
        "--report-dir",
        "reports",
        "--run-id",
        "glm-run",
        "--cache-trace-path",
        "trace.jsonl",
        "--cache-hit-target",
        "0",
        "--output",
        "json"
      ]).diagnosticsInput?.cacheHitTarget,
      0
    );
    assert.deepEqual(parseCliArgs([
      "diagnostics",
      "swe-bench",
      "run",
      "--task",
      "1",
      "--execute",
      "--provider",
      "glm",
      "--model",
      "glm-5.2",
      "--run-id",
      "glm-run",
      "--output",
      "json"
    ]), {
      command: "diagnostics",
      diagnosticsCommand: "swe-bench",
      prompt: "",
      output: "json",
      live: false,
      modelProvider: "glm",
      model: "glm-5.2",
      diagnosticsInput: {
        command: "swe-bench",
        action: "run",
        dryRun: false,
        provider: "glm",
        model: "glm-5.2",
        runId: "glm-run",
        task: "1",
        execute: true,
        extraArgs: []
      }
    });
    assert.deepEqual(parseCliArgs([
      "diagnostics",
      "swe-bench",
      "predict",
      "--instance-file",
      ".deepseek/swe-lite-runs/demo/instance.json",
      "--repo-dir",
      ".deepseek/swe-lite-runs/demo/repo",
      "--output-path",
      ".deepseek/swe-lite-runs/predictions.jsonl",
      "--trace-output-path",
      ".deepseek/swe-lite-runs/traces/demo.jsonl",
      "--append-output",
      "--live",
      "--provider",
      "glm",
      "--model",
      "glm-5.1",
      "--output",
      "json"
    ]), {
      command: "diagnostics",
      diagnosticsCommand: "swe-bench",
      prompt: "",
      output: "json",
      live: true,
      modelProvider: "glm",
      model: "glm-5.1",
      diagnosticsInput: {
        command: "swe-bench",
        live: true,
        action: "predict",
        dryRun: false,
        instanceFile: ".deepseek/swe-lite-runs/demo/instance.json",
        repoDir: ".deepseek/swe-lite-runs/demo/repo",
        outputPath: ".deepseek/swe-lite-runs/predictions.jsonl",
        traceOutputPath: ".deepseek/swe-lite-runs/traces/demo.jsonl",
        appendOutput: true,
        provider: "glm",
        model: "glm-5.1",
        extraArgs: []
      }
    });
    assert.deepEqual(parseCliArgs(["diagnostics", "refresh", "--full", "--dry-run", "--output", "jsonl"]), {
      command: "diagnostics",
      diagnosticsCommand: "refresh",
      prompt: "",
      output: "jsonl",
      live: false,
      diagnosticsInput: { command: "refresh", full: true, dryRun: true, extraArgs: [] }
    });
    assert.deepEqual(parseCliArgs(["diagnostics", "evaluate", "--baseline", "claude-code", "--dry-run", "--output", "json"]), {
      command: "diagnostics",
      diagnosticsCommand: "evaluate",
      prompt: "",
      output: "json",
      live: false,
      diagnosticsInput: { command: "evaluate", full: false, smoke: false, dryRun: true, baseline: "claude-code", allowExternalBaseline: false, baselineArgs: [], extraArgs: [] }
    });
    assert.deepEqual(parseCliArgs(["diagnostics", "swe-bench", "run", "--task", "1", "--execute", "--trusted", "--output", "json"]), {
      command: "diagnostics",
      diagnosticsCommand: "swe-bench",
      prompt: "",
      output: "json",
      live: false,
      approvalMode: "trusted",
      diagnosticsInput: {
        command: "swe-bench",
        action: "run",
        dryRun: false,
        task: "1",
        execute: true,
        extraArgs: []
      }
    });
    assert.deepEqual(parseCliArgs(["diagnostics", "evaluate", "--baseline", "codex", "--allow-external-baseline", "--baseline-command", "codex", "--baseline-arg", "--version", "--dry-run", "--output", "json"]), {
      command: "diagnostics",
      diagnosticsCommand: "evaluate",
      prompt: "",
      output: "json",
      live: false,
      diagnosticsInput: {
        command: "evaluate",
        full: false,
        smoke: false,
        dryRun: true,
        baseline: "codex",
        allowExternalBaseline: true,
        baselineCommand: "codex",
        baselineArgs: ["--version"],
        extraArgs: []
      }
    });
    assert.deepEqual(parseCliArgs([
      "diagnostics",
      "evaluate",
      "--full",
      "--compare-baseline",
      "deepseek-cli",
      "--compare-baseline",
      "codex",
      "--compare-baseline",
      "claude-code",
      "--execute-task",
      "eval.webpage.generation",
      "--codex-command",
      "codex",
      "--claude-command",
      "claude",
      "--output",
      "json"
    ]), {
      command: "diagnostics",
      diagnosticsCommand: "evaluate",
      prompt: "",
      output: "json",
      live: false,
      diagnosticsInput: {
        command: "evaluate",
        full: true,
        smoke: false,
        dryRun: false,
        baseline: "deepseek-cli",
        compareBaselines: ["deepseek-cli", "codex", "claude-code"],
        allowExternalBaseline: false,
        codexCommand: "codex",
        claudeCommand: "claude",
        executeTask: "eval.webpage.generation",
        baselineArgs: [],
        extraArgs: []
      }
    });
    assert.deepEqual(parseCliArgs(["-p", "hello"]), {
      command: "help",
      prompt: "",
      output: "text",
      live: false
    });
  });

  it("prints deterministic help for no-arg usage", async () => {
    const lines: string[] = [];
    await runCli([], (line: string) => {
      lines.push(line);
    }, [], { stdinIsTTY: true, stdoutIsTTY: true });
    assert.deepEqual(lines, cliUsageLines());
    assert.equal(lines.some((line) => line.includes("deepseek palette list")), true);
    assert.equal(lines.some((line) => line.includes("deepseek palette keymap")), true);
    assert.equal(lines.some((line) => line.includes("deepseek palette action")), true);
    assert.equal(lines.some((line) => line.includes("deepseek revert preview")), true);
    assert.equal(lines.some((line) => line.includes("deepseek revert apply")), true);
    assert.equal(lines.some((line) => line.includes("deepseek index-provider status")), true);
    assert.equal(lines.some((line) => line.includes("deepseek mode [status|agent|workers|verify|plan]")), true);
    assert.equal(lines.some((line) => line.includes("deepseek memory status|list|candidates")), true);
    assert.equal(lines.some((line) => line.includes("deepseek context status|grep|describe|summarize|expand|budget|pin")), true);
    assert.equal(lines.some((line) => line.includes("deepseek checks openspec|typecheck|lint|test|boundaries|build-cli")), true);
    assert.equal(lines.some((line) => line.includes("deepseek file list|preview|refs")), true);
    assert.equal(lines.some((line) => line.includes("deepseek repo files|grep|recall|project-index")), true);
    assert.equal(lines.some((line) => line.includes("deepseek git status|diff|review")), true);
    assert.equal(lines.some((line) => line.includes("deepseek jump file|text|symbol")), true);
    assert.equal(lines.some((line) => line.includes("deepseek diagnostics bundle|release|doctor|verify|refresh|evaluate|env|flow|swe-bench")), true);
    assert.equal(lines.some((line) => line.includes("--predictions-path <path>")), true);
    assert.equal(lines.some((line) => line.includes("deepseek chat [--session <session-id>]")), true);
    assert.equal(lines.some((line) => line.includes("--tool-projection none|read-only|read-write|safe-all")), true);
    assert.equal(lines.some((line) => line.includes("--tool-opt-in <category>")), true);
    assert.equal(lines.some((line) => line.includes("--tool-projection none|read-only|read-write|all")), false);
    assert.equal(lines.join("\n").includes("stream-json"), false);
    assert.equal(lines.join("\n").includes(" -p "), false);
  });

  it("renders diagnostics evaluation task execution trace in text output", () => {
    const result = {
      schemaVersion: "1.0.0",
      kind: "diagnostics.evaluate",
      status: "warn",
      command: "evaluate",
      evaluation: {
        schemaVersion: "1.0.0",
        kind: "cli.evaluation.comparison.summary",
        status: "warn",
        mode: "smoke",
        dryRun: false,
        taskCatalogVersion: "test",
        reportTimestamp: "1970-01-01T00:00:00.000Z",
        baselines: [],
        taskRuns: [{
          schemaVersion: "1.0.0",
          kind: "cli.evaluation.task-run",
          runId: "eval:deepseek-cli:eval.trace",
          task: {
            schemaVersion: "1.0.0",
            taskId: "eval.trace",
            title: "Trace task",
            category: "diagnostic",
            fixtureId: "fixture.trace",
            workspaceSnapshotId: "snapshot.trace",
            promptDigest: "sha256:test",
            promptSummary: "Trace the task.",
            allowedCapabilityProfile: "read-write",
            timeBudgetMs: 1000,
            checkCommands: ["node check.js"],
            scoringRubricId: "rubric.trace",
            mode: "smoke",
            redaction: { class: "internal" }
          },
          baseline: {
            baselineId: "deepseek-cli",
            label: "DeepSeek CLI",
            kind: "deepseek-cli",
            status: "available",
            configured: true,
            diagnostics: [],
            redaction: { class: "internal" }
          },
          dryRun: false,
          outcome: "failed",
          checks: [{
            command: "node check.js",
            status: "fail",
            exitCode: 1,
            redaction: { class: "internal" }
          }],
          metrics: {
            retryCount: 0,
            userInterventionCount: 0,
            safetyViolationCount: 0,
            recoveryUsed: false,
            repairMetricsAvailability: "available",
            repairActivationCount: 1,
            repairSuccessCount: 0,
            repairStopReason: "model-iteration-limit",
            redaction: { class: "internal" }
          },
          stagedTask: {
            schemaVersion: "1.0.0",
            profileId: "profile.trace",
            graphId: "graph.trace",
            profileFingerprint: "htrace",
            stageCount: 2,
            refCount: 1,
            executorKinds: ["model", "checker"],
            graph: { schemaVersion: "1.0.0", graphId: "graph.trace", nodes: [], edges: [], redaction: { class: "internal" } },
            runState: { schemaVersion: "1.0.0", stateId: "state.trace", status: "failed", currentNodeIds: ["checker"], completedNodeIds: ["model"], failedNodeIds: ["checker"], redaction: { class: "internal" } },
            redaction: { class: "internal" }
          },
          instrumentationEvents: [
            { schemaVersion: "1.0.0", eventId: "event-1", kind: "run_started", runId: "eval:deepseek-cli:eval.trace", baselineId: "deepseek-cli", taskId: "eval.trace", sequence: 1, recordedAt: "1970-01-01T00:00:00.000Z", metadata: {}, redaction: { class: "internal" } },
            { schemaVersion: "1.0.0", eventId: "event-2", kind: "command_started", runId: "eval:deepseek-cli:eval.trace", baselineId: "deepseek-cli", taskId: "eval.trace", sequence: 2, recordedAt: "1970-01-01T00:00:00.000Z", metadata: { argCount: 9 }, redaction: { class: "internal" } },
            { schemaVersion: "1.0.0", eventId: "event-3", kind: "checker_finished", runId: "eval:deepseek-cli:eval.trace", baselineId: "deepseek-cli", taskId: "eval.trace", sequence: 3, recordedAt: "1970-01-01T00:00:00.000Z", metadata: { exitCode: 1 }, redaction: { class: "internal" } }
          ],
          diagnostics: [],
          evidencePaths: [],
          redaction: { class: "internal" }
        }],
        baselineAggregates: [],
        publicBenchmarkReferences: [],
        packageScorecards: [],
        gapFindings: [],
        diagnostics: [],
        evidencePaths: [],
        nextAction: "Inspect trace.",
        redaction: { class: "internal" }
      },
      referencePitFixtureIds: [],
      redaction: { class: "internal" }
    } as unknown as Parameters<typeof renderDiagnosticsResult>[0];

    const lines = renderDiagnosticsResult(result, "text");

    assert.equal(lines.some((line) => line.includes("trace: run_started -> command_started -> checker_finished")), true);
    assert.equal(lines.some((line) => line.includes("last=checker_finished")), true);
    assert.equal(lines.some((line) => line.includes("check: fail exit=1 command=node check.js")), true);
    assert.equal(lines.some((line) => line.includes("staged: failed current=checker failed=checker executors=model, checker")), true);
  });

  it("runs context compactor CLI status with structured output", async () => {
    const deps = { ...createDeterministicRuntimeDependencies(), losslessContext: new InMemoryLosslessContextManager() };
    const kernel = await createDefaultRuntimeKernel(deps);
    const outputs: string[] = [];
    await runCli(["context", "status", "--output", "json"], (line: string) => {
      outputs.push(line);
    }, [], { stdinIsTTY: true, stdoutIsTTY: true }, {
      createRuntime: async () => ({ deps, kernel })
    });

    const result = JSON.parse(outputs[0] ?? "{}") as { readonly kind?: string; readonly action?: string; readonly status?: string };
    assert.equal(result.kind, "context.compactor");
    assert.equal(result.action, "status");
    assert.equal(result.status, "completed");
  });

  it("runs file manager CLI commands with text, JSON, and JSONL output", async () => {
    const root = process.cwd().replace(/\\/g, "/");
    const textLines = await runWithSeededWorkspace(["file", "list", "src", "--output", "text"]);
    const jsonLines = await runWithSeededWorkspace(["file", "preview", `${root}/src/index.ts`, "--output", "json"]);
    const jsonlLines = await runWithSeededWorkspace(["file", "refs", ".md", "--output", "jsonl"]);
    const missingLines = await runWithSeededWorkspace(["file", "preview", "--output", "json"]);
    const preview = JSON.parse(jsonLines[0] ?? "{}") as { readonly kind?: string; readonly action?: string; readonly status?: string; readonly resultList?: { readonly id?: string }; readonly referenceTargets?: readonly { readonly path?: string }[] };
    const jsonlRecords = jsonlLines.map((line) => JSON.parse(line) as { readonly kind?: string; readonly result?: { readonly action?: string; readonly status?: string; readonly itemCount?: number }; readonly item?: { readonly target?: { readonly kind?: string; readonly path?: string } } });
    const missing = JSON.parse(missingLines[0] ?? "{}") as { readonly status?: string; readonly diagnostics?: readonly { readonly code?: string }[] };

    assert.equal(textLines[0]?.startsWith("file list: completed"), true);
    assert.equal(textLines.some((line) => line.includes("src/index.ts")), true);
    assert.equal(preview.kind, "file.manager");
    assert.equal(preview.action, "preview");
    assert.equal(preview.status, "completed");
    assert.equal(preview.resultList?.id, "result-list:file-manager.preview");
    assert.equal(preview.referenceTargets?.[0]?.path, `${root}/src/index.ts`);
    assert.equal(jsonlRecords[0]?.kind, "file.manager.summary");
    assert.equal(jsonlRecords[0]?.result?.action, "references");
    assert.equal(jsonlRecords.some((record) => record.kind === "file.manager.item" && record.item?.target?.kind === "file"), true);
    assert.equal(missing.status, "failed");
    assert.equal(missing.diagnostics?.[0]?.code, "FILE_MANAGER_QUERY_REQUIRED");
    assert.equal([...textLines, ...jsonLines, ...jsonlLines, ...missingLines].join("\n").includes("agent.loop.started"), false);
  });

  it("runs jump navigator CLI commands with text, JSON, JSONL, and symbol output", async () => {
    const textLines = await runWithSeededWorkspace(["jump", "file", "src", "--output", "text"]);
    const jsonLines = await runWithSeededWorkspace(["jump", "text", "needle", "--output", "json"]);
    const jsonlLines = await runWithSeededWorkspace(["jump", "symbol", "needle", "--output", "jsonl"]);
    const missingLines = await runWithSeededWorkspace(["jump", "text", "--output", "json"]);
    const text = JSON.parse(jsonLines[0] ?? "{}") as { readonly kind?: string; readonly action?: string; readonly status?: string; readonly resultList?: { readonly id?: string; readonly items?: readonly unknown[] }; readonly activeTarget?: { readonly kind?: string } };
    const symbolRecords = jsonlLines.map((line) => JSON.parse(line) as { readonly kind?: string; readonly result?: { readonly status?: string; readonly itemCount?: number }; readonly item?: { readonly target?: { readonly kind?: string; readonly path?: string }; readonly metadata?: { readonly symbolName?: string } }; readonly diagnostic?: { readonly code?: string } });
    const missing = JSON.parse(missingLines[0] ?? "{}") as { readonly status?: string; readonly diagnostics?: readonly { readonly code?: string }[] };

    assert.equal(textLines[0]?.startsWith("jump file: completed"), true);
    assert.equal(textLines.some((line) => line.includes("src/index.ts")), true);
    assert.equal(text.kind, "jump.navigator");
    assert.equal(text.action, "text");
    assert.equal(text.status, "completed");
    assert.equal(text.resultList?.id, "result-list:jump.text");
    assert.equal(text.resultList?.items?.length, 2);
    assert.equal(text.activeTarget?.kind, "file");
    assert.equal(symbolRecords[0]?.kind, "jump.navigator.summary");
    assert.equal(symbolRecords[0]?.result?.status, "completed");
    assert.equal(symbolRecords[0]?.result?.itemCount, 1);
    assert.equal(symbolRecords.some((record) => record.kind === "jump.navigator.item" && record.item?.target?.kind === "file" && record.item.metadata?.symbolName === "needle"), true);
    assert.equal(symbolRecords.some((record) => record.kind === "jump.navigator.diagnostic" && record.diagnostic?.code === "JUMP_NAVIGATOR_SYMBOL_DEFERRED"), false);
    assert.equal(missing.status, "failed");
    assert.equal(missing.diagnostics?.[0]?.code, "JUMP_NAVIGATOR_QUERY_REQUIRED");
    assert.equal([...textLines, ...jsonLines, ...jsonlLines, ...missingLines].join("\n").includes("agent.loop.started"), false);
  });

  it("uses the real local workspace for default navigation commands", async () => {
    await withTempCwd("deepseek-cli-local-navigation-", async () => {
      await mkdir("src", { recursive: true });
      await writeFile(join("src", "local.ts"), "export const LocalNavNeedle = true;\n", "utf8");

      const fileLines: string[] = [];
      await runCli(["file", "list", "src", "--output", "json"], (line: string) => {
        fileLines.push(line);
      }, [], { stdinIsTTY: false, stdoutIsTTY: false });
      const fileResult = JSON.parse(fileLines[0] ?? "{}") as {
        readonly status?: string;
        readonly resultList?: { readonly items?: readonly { readonly target?: { readonly path?: string } }[] };
      };

      const symbolLines: string[] = [];
      await runCli(["jump", "symbol", "LocalNavNeedle", "--output", "json"], (line: string) => {
        symbolLines.push(line);
      }, [], { stdinIsTTY: false, stdoutIsTTY: false });
      const symbolResult = JSON.parse(symbolLines[0] ?? "{}") as {
        readonly status?: string;
        readonly resultList?: { readonly items?: readonly { readonly target?: { readonly path?: string }; readonly metadata?: { readonly symbolName?: string } }[] };
      };

      const repoLines: string[] = [];
      await runCli(["repo", "files", "src/local", "--output", "json"], (line: string) => {
        repoLines.push(line);
      }, [], { stdinIsTTY: false, stdoutIsTTY: false });
      const repoResult = JSON.parse(repoLines[0] ?? "{}") as {
        readonly status?: string;
        readonly resultList?: { readonly items?: readonly { readonly target?: { readonly path?: string } }[] };
      };

      assert.equal(fileResult.status, "completed");
      assert.equal(fileResult.resultList?.items?.some((item) => item.target?.path?.endsWith("src/local.ts")), true);
      assert.equal(symbolResult.status, "completed");
      assert.equal(symbolResult.resultList?.items?.some((item) => item.target?.path?.endsWith("src/local.ts") && item.metadata?.symbolName === "LocalNavNeedle"), true);
      assert.equal(repoResult.status, "completed");
      assert.equal(repoResult.resultList?.items?.some((item) => item.target?.path?.endsWith("src/local.ts")), true);
      assert.equal([...fileLines, ...symbolLines, ...repoLines].join("\n").includes("agent.loop.started"), false);
    });
  });

  it("discovers the workspace root from a nested launch directory", async () => {
    await withTempCwd("deepseek-cli-workspace-discovery-", async () => {
      await mkdir(join("src", "nested"), { recursive: true });
      await writeFile("package.json", JSON.stringify({ name: "workspace-discovery-fixture" }), "utf8");
      await writeFile(join("src", "root-only.ts"), "export const WorkspaceDiscoveryNeedle = true;\n", "utf8");
      process.chdir(join(process.cwd(), "src", "nested"));

      const fileLines: string[] = [];
      await runCli(["file", "list", "src", "--output", "json"], (line: string) => {
        fileLines.push(line);
      }, [], { stdinIsTTY: false, stdoutIsTTY: false });
      const fileResult = JSON.parse(fileLines[0] ?? "{}") as {
        readonly status?: string;
        readonly resultList?: { readonly items?: readonly { readonly target?: { readonly path?: string } }[] };
      };

      assert.equal(fileResult.status, "completed");
      assert.equal(fileResult.resultList?.items?.some((item) => item.target?.path?.endsWith("src/root-only.ts")), true);
    });
  });

  it("runs /file as a local chat navigation command and projects result lists", async () => {
    const lines = await runWithSeededWorkspace(["chat", "--output", "jsonl"], [
      "/file list src\n/palette state\n/palette refs add current\n/palette refs list\n/file refs .md\n/file preview src/index.ts\n/file preview\n/exit\n"
    ]);
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        result?: { action?: string; status?: string; itemCount?: number };
        diagnostic?: { code?: string };
        mode?: string;
        resultListId?: string;
        item?: { target?: { kind?: string; path?: string } };
      };
    });

    assert.equal(records.some((record) => record.kind === "chat.command.file" && record.record?.kind === "file.manager.summary" && record.record.result?.action === "list" && record.record.result.status === "completed"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.file" && record.record?.kind === "file.manager.item" && record.record.item?.target?.path?.includes("src/index.ts")), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-state" && record.record?.kind === "palette.state" && record.record.mode === "result-list" && record.record.resultListId === "result-list:file-manager.list"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.item" && record.record.item?.target?.path?.includes("src/index.ts")), true);
    assert.equal(records.some((record) => record.kind === "chat.command.file" && record.record?.kind === "file.manager.summary" && record.record.result?.action === "references" && record.record.result.status === "completed"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.file" && record.record?.kind === "file.manager.item" && record.record.item?.target?.path?.includes("docs/guide.md")), true);
    assert.equal(records.some((record) => record.kind === "chat.command.file" && record.record?.kind === "file.manager.summary" && record.record.result?.action === "preview" && record.record.result.status === "completed"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.file" && record.record?.kind === "file.manager.diagnostic" && record.record.diagnostic?.code === "FILE_MANAGER_QUERY_REQUIRED"), true);
    assert.equal(records.some((record) => record.kind === "model.requested" || record.kind === "agent.loop.started"), false);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("resolves chat file previews through the injected workspace root", async () => {
    const cwdRoot = process.cwd().replace(/\\/g, "/");
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile(`${cwdRoot}/src/index.ts`, "export const wrongRoot = true;\n");
    await deps.platform.writeFile("/workspace/src/index.ts", "export const workspaceRoot = true;\n");
    const kernel = await createDefaultRuntimeKernel(deps);
    const lines: string[] = [];
    await runCli(["chat", "--output", "jsonl"], (line: string) => {
      lines.push(line);
    }, ["/file preview src/index.ts\n/exit\n"], { stdinIsTTY: false, stdoutIsTTY: false }, {
      createRuntime: async () => ({ deps, kernel }),
      workspaceRoot: "/workspace"
    });

    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        item?: { label?: string; target?: { path?: string; metadata?: { preview?: string } } };
      };
    });
    assert.equal(records.some((record) => record.kind === "chat.command.file" && record.record?.kind === "file.manager.item" && record.record.item?.target?.path === "/workspace/src/index.ts"), true);
    assert.equal(records.some((record) => record.record?.item?.target?.metadata?.preview?.includes("workspaceRoot")), true);
    assert.equal(records.some((record) => record.record?.item?.target?.metadata?.preview?.includes("wrongRoot")), false);
  });

  it("runs /jump as a local chat navigation command and projects symbol results", async () => {
    const lines = await runWithSeededWorkspace(["chat", "--output", "jsonl"], [
      "/jump text needle\n/palette state\n/palette refs replace current\n/palette refs list\n/jump symbol needle\n/palette state\n/jump text\n/exit\n"
    ]);
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        result?: { action?: string; status?: string; itemCount?: number };
        diagnostic?: { code?: string };
        mode?: string;
        resultListId?: string;
        item?: { target?: { kind?: string; path?: string } };
      };
    });

    assert.equal(records.some((record) => record.kind === "chat.command.jump" && record.record?.kind === "jump.navigator.summary" && record.record.result?.action === "text" && record.record.result.status === "completed"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.jump" && record.record?.kind === "jump.navigator.item" && record.record.item?.target?.kind === "file"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-state" && record.record?.kind === "palette.state" && record.record.mode === "result-list" && record.record.resultListId === "result-list:jump.text"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.item" && record.record.item?.target?.kind === "file"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.jump" && record.record?.kind === "jump.navigator.summary" && record.record.result?.action === "symbol" && record.record.result.status === "completed"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.jump" && record.record?.kind === "jump.navigator.item" && record.record.item?.target?.path?.includes("src/index.ts")), true);
    assert.equal(records.some((record) => record.kind === "chat.command.jump" && record.record?.kind === "jump.navigator.diagnostic" && record.record.diagnostic?.code === "JUMP_NAVIGATOR_SYMBOL_DEFERRED"), false);
    assert.equal(records.filter((record) => record.kind === "chat.command.palette-state" && record.record?.kind === "palette.state").at(-1)?.record?.resultListId, "result-list:jump.symbol");
    assert.equal(records.some((record) => record.kind === "chat.command.jump" && record.record?.kind === "jump.navigator.diagnostic" && record.record.diagnostic?.code === "JUMP_NAVIGATOR_QUERY_REQUIRED"), true);
    assert.equal(records.some((record) => record.kind === "model.requested" || record.kind === "agent.loop.started"), false);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("handles /context as a local chat command without model dispatch", async () => {
    const deps = { ...createDeterministicRuntimeDependencies(), losslessContext: new InMemoryLosslessContextManager() };
    const kernel = await createDefaultRuntimeKernel(deps);
    const outputs: string[] = [];
    await runCli(["chat", "--output", "text"], (line: string) => {
      outputs.push(line);
    }, ["/context status\n/exit\n"], { stdinIsTTY: false, stdoutIsTTY: false }, {
      createRuntime: async () => ({ deps, kernel })
    });

    assert.equal(outputs.some((line) => line.includes("context status: completed")), true);
    assert.equal(outputs.some((line) => line.includes("[chat] Interactive session closing.")), true);
  });

  it("runs permanent memory CLI remember and candidate list commands", async () => {
    const memory = new DurablePermanentMemoryProvider({ adapter: new InMemoryPermanentMemoryStorageAdapter() });
    const deps = { ...createDeterministicRuntimeDependencies(), memory };
    const kernel = await createDefaultRuntimeKernel(deps);
    const outputs: string[] = [];
    await runCli(["memory", "remember", "Use provider-backed memory", "--output", "json"], (line: string) => {
      outputs.push(line);
    }, [], { stdinIsTTY: true, stdoutIsTTY: true }, {
      createRuntime: async () => ({ deps, kernel })
    });
    const remembered = JSON.parse(outputs[0] ?? "{}") as { readonly status?: string; readonly entry?: { readonly state?: string } };
    assert.equal(remembered.status, "completed");
    assert.equal(remembered.entry?.state, "candidate");

    outputs.length = 0;
    await runCli(["memory", "candidates", "--query", "provider-backed", "--output", "json"], (line: string) => {
      outputs.push(line);
    }, [], { stdinIsTTY: true, stdoutIsTTY: true }, {
      createRuntime: async () => ({ deps, kernel })
    });
    const listed = JSON.parse(outputs[0] ?? "{}") as { readonly count?: number };
    assert.equal(listed.count, 1);
    await kernel.shutdown();
  });

  it("runs one-shot tasks through the runtime-owned agent loop as JSONL", async () => {
    const lines: string[] = [];
    await runCli(["run", "hello", "--output", "jsonl"], (line: string) => {
      lines.push(line);
    });
    const events = lines.map((line) => JSON.parse(line) as { kind: string; data?: Record<string, unknown> });

    assert.equal(events[0]?.kind, "agent.loop.started");
    assert.equal(events.some((event) => event.kind === "model.requested"), true);
    assert.equal(events.some((event) => event.kind === "model.delta"), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    assert.equal(lines.join("\n").includes("sk-live-secret-value"), false);
  });

  it("disables reasoning chunks for live one-shot runs to avoid event backpressure", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const capturedRequests: ModelRequest[] = [];
    const runtimeDeps = {
      ...deps,
      models: new CaptureModelRequestGateway(capturedRequests)
    };
    await registerRuntimeCoreTools(runtimeDeps, process.cwd());
    const kernel = await createDefaultRuntimeKernel(runtimeDeps);
    const lines: string[] = [];

    await runCli(
      ["run", "生成 website", "--output", "jsonl", "--live"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps: runtimeDeps, kernel })
      }
    );

    assert.equal(capturedRequests[0]?.reasoning?.enabled, false);
    assert.equal(lines.some((line) => line.includes("agent.loop.completed")), true);
    await kernel.shutdown("cli-test-live-reasoning-disabled");
  });

  it("passes explicit thinking controls through live one-shot runs", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const capturedRequests: ModelRequest[] = [];
    const runtimeDeps = {
      ...deps,
      models: new CaptureModelRequestGateway(capturedRequests)
    };
    await registerRuntimeCoreTools(runtimeDeps, process.cwd());
    const kernel = await createDefaultRuntimeKernel(runtimeDeps);
    const lines: string[] = [];

    await runCli(
      ["run", "需要深度推理", "--output", "jsonl", "--live", "--thinking", "max"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps: runtimeDeps, kernel })
      }
    );

    assert.deepEqual(capturedRequests[0]?.reasoning, { enabled: true, providerEffort: "max" });
    assert.equal(lines.some((line) => line.includes("agent.loop.completed")), true);
    await kernel.shutdown("cli-test-live-reasoning-explicit");
  });

  it("passes explicit GLM model profile through live one-shot runs", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const capturedRequests: ModelRequest[] = [];
    const runtimeDeps = {
      ...deps,
      models: new CaptureModelRequestGateway(capturedRequests)
    };
    await registerRuntimeCoreTools(runtimeDeps, process.cwd());
    const kernel = await createDefaultRuntimeKernel(runtimeDeps);
    const lines: string[] = [];

    await runCli(
      ["run", "glm flow", "--output", "jsonl", "--live", "--provider", "glm", "--model", "glm-5.1"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async (runtimeOptions) => {
          assert.equal(runtimeOptions.modelProvider, "glm");
          assert.equal(runtimeOptions.model, "glm-5.1");
          return { deps: runtimeDeps, kernel };
        }
      }
    );

    assert.equal(String(capturedRequests[0]?.profile.providerId), "provider-glm-anthropic");
    assert.equal(capturedRequests[0]?.profile.model, "glm-5.1");
    assert.equal(lines.some((line) => line.includes("agent.loop.completed")), true);
    await kernel.shutdown("cli-test-live-glm-profile");
  });

  it("passes explicit tool opt-ins into one-shot runtime projection", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const capturedRequests: ModelRequest[] = [];
    const runtimeDeps = {
      ...deps,
      models: new CaptureModelRequestGateway(capturedRequests)
    };
    await registerRuntimeCoreTools(runtimeDeps, process.cwd());
    const kernel = await createDefaultRuntimeKernel(runtimeDeps);
    const lines: string[] = [];

    await runCli(
      ["run", "fetch public docs", "--output", "jsonl", "--live", "--tool-projection", "safe-all", "--tool-opt-in", "network"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps: runtimeDeps, kernel })
      }
    );

    const firstRequest = capturedRequests[0];
    assert.ok(firstRequest, "expected one-shot run to dispatch a model request");
    const toolNames = (firstRequest.tools ?? []).map((tool) => {
      const fn = tool.function;
      return isJsonObject(fn) ? String(fn.name) : "";
    });
    const toolPolicy = (firstRequest.messages ?? []).find((message) => message.content.includes("Tool visibility policy: safe-all"))?.content ?? "";

    assert.equal(toolNames.includes("core_web_fetch"), true);
    assert.equal(toolPolicy.includes("Tool opt-ins: network."), true);
    assert.equal(lines.some((line) => line.includes("agent.loop.completed")), true);
    await kernel.shutdown("cli-test-tool-opt-ins");
  });

  it("projects command-habit aliases through CLI one-shot tool policy", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const capturedRequests: ModelRequest[] = [];
    const runtimeDeps = {
      ...deps,
      models: new CaptureModelRequestGateway(capturedRequests)
    };
    await registerRuntimeCoreTools(runtimeDeps, process.cwd());
    const kernel = await createDefaultRuntimeKernel(runtimeDeps);
    const lines: string[] = [];

    await runCli(
      ["run", "search, copy, and verify files", "--output", "jsonl", "--live", "--tool-projection", "safe-all"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps: runtimeDeps, kernel })
      }
    );

    const firstRequest = capturedRequests[0];
    assert.ok(firstRequest, "expected one-shot run to dispatch a model request");
    const toolPolicy = (firstRequest.messages ?? []).find((message) => message.content.includes("Tool visibility policy: safe-all"))?.content ?? "";
    assert.equal(toolPolicy.includes("Common command-habit aliases route to governed tools:"), true, toolPolicy);

    assert.equal(toolPolicy.includes("grep -> core_search_text"), true);
    assert.equal(toolPolicy.includes("rg -> core_search_text"), true);
    assert.equal(toolPolicy.includes("ls -> core_file_list"), true);
    assert.equal(toolPolicy.includes("cat -> core_file_read"), true);
    await kernel.shutdown("cli-test-command-habit-aliases");
  });

  it("projects engineering prompts through a primary role workflow before model dispatch", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const capturedRequests: ModelRequest[] = [];
    const runtimeDeps = {
      ...deps,
      models: new CaptureModelRequestGateway(capturedRequests)
    };
    await registerRuntimeCoreTools(runtimeDeps, process.cwd());
    const kernel = await createDefaultRuntimeKernel(runtimeDeps);
    const lines: string[] = [];

    await runCli(
      ["run", "修复这个仓库里的 CLI 调度缺陷，补测试并跑验证。", "--output", "jsonl", "--live"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps: runtimeDeps, kernel })
      }
    );

    const firstRequest = capturedRequests[0];
    const profilePolicy = firstRequest?.metadata?.profilePolicy as JsonObject | undefined;
    const readyStage = firstRequest?.metadata?.workflowReadyStageControl as JsonObject | undefined;
    const toolNames = (firstRequest?.tools ?? []).map((tool) => {
      const fn = tool.function;
      return isJsonObject(fn) ? String(fn.name) : "";
    });

    assert.equal(profilePolicy?.profileId, "engineering/coding.v1");
    assert.equal(profilePolicy?.role, "engineering-agent");
    assert.equal(profilePolicy?.workflowPriority, "primary");
    assert.equal(readyStage?.stageId, "stage:understand");
    assert.equal(String(readyStage?.requiredNextAction).includes("core.file.read"), true);
    assert.equal(String(readyStage?.requiredNextAction).includes("core.search.text"), true);
    assert.equal(toolNames.includes("core_file_read"), true);
    assert.equal(toolNames.includes("core_file_edit"), false);
    assert.equal(lines.some((line) => line.includes("workflow.ready-stage.control")), true);
    await kernel.shutdown("cli-test-engineering-primary-workflow");
  });

  it("threads supervisor workflow run state into dynamic prompt state without changing stable profile guidance", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const statePath = `${process.cwd().replace(/\\/g, "/")}/.deepseek/test-supervisor-run-state.json`;
    await deps.platform.writeFile(statePath, JSON.stringify({
      schemaVersion: "1.0.0",
      taskRunId: "staged:runner:unit-child-state:2",
      graphId: "workflow/evaluation.swe-bench-lite.child.v1",
      profileId: "evaluation/swe-bench-lite.child.v1",
      stageStates: [
        { stageId: "prepare", status: "succeeded", attempts: 1, inputRefs: [], outputRefs: ["ref:runner:tool-matrix"], diagnostics: [] },
        { stageId: "understand", status: "running", attempts: 0, inputRefs: ["ref:runner:tool-matrix"], outputRefs: [], diagnostics: [] }
      ],
      refs: [
        { schemaVersion: "1.0.0", refId: "ref:runner:tool-matrix", type: "state", producerStageId: "prepare", scope: "task", metadata: { status: "complete" }, compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" }, redaction: { class: "internal", fields: ["metadata"] } }
      ],
      events: [],
      compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
      redaction: { class: "internal" }
    }));
    const capturedRequests: ModelRequest[] = [];
    const runtimeDeps = {
      ...deps,
      models: new CaptureModelRequestGateway(capturedRequests)
    };
    await registerRuntimeCoreTools(runtimeDeps, process.cwd());
    const kernel = await createDefaultRuntimeKernel(runtimeDeps);
    const lines: string[] = [];

    await runCli(
      [
        "run",
        "Resolve SWE-bench instance demo__repo-1.\n\nManaged SWE-bench execution profile:\nProblem statement:\nfix it",
        "--supervisor-workflow-state",
        statePath,
        "--output",
        "jsonl",
        "--live",
        "--tool-projection",
        "all"
      ],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps: runtimeDeps, kernel })
      }
    );

    const messages = capturedRequests[0]?.messages ?? [];
    const stableProfile = messages.find((message) => message.content.includes("Agent profile workflow:"));
    const dynamicState = messages.find((message) => message.content.includes("Supervisor workflow state:"));

    assert.equal(stableProfile?.cacheHint?.policy, "stable");
    assert.equal(dynamicState?.cacheHint?.policy, "ephemeral");
    assert.equal(dynamicState?.content.includes("Task run: staged:runner:unit-child-state:2."), true);
    assert.equal(dynamicState?.content.includes("prepare:succeeded refs=ref:runner:tool-matrix attempts=1"), true);
    assert.equal(dynamicState?.content.includes("understand:running refs=none attempts=0"), true);
    assert.equal(capturedRequests[0]?.metadata?.profilePolicy !== undefined, true);
    assert.equal(lines.some((line) => line.includes("prompt.assembled")), true);
    await kernel.shutdown("cli-test-supervisor-workflow-state");
  });

  it("uses supervisor repair workflow state for child runtime gates", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const statePath = `${process.cwd().replace(/\\/g, "/")}/.deepseek/test-supervisor-repair-state.json`;
    await deps.platform.writeFile(statePath, JSON.stringify({
      schemaVersion: "1.0.0",
      taskRunId: "staged:runner:unit-child-repair-state:2",
      graphId: "workflow/evaluation.swe-bench-lite.child.v1",
      profileId: "evaluation/swe-bench-lite.child.v1",
      stageStates: [
        { stageId: "prepare", status: "succeeded", attempts: 1, inputRefs: [], outputRefs: ["ref:runner:tool-matrix"], diagnostics: [] },
        { stageId: "understand", status: "succeeded", attempts: 1, inputRefs: ["ref:runner:tool-matrix"], outputRefs: ["ref:runner:source-inspection-evidence", "ref:runner:official-repair-feedback"], diagnostics: [] },
        { stageId: "change", status: "pending", attempts: 0, inputRefs: ["ref:runner:source-inspection-evidence", "ref:runner:official-repair-feedback"], outputRefs: [], diagnostics: [] }
      ],
      refs: [
        { schemaVersion: "1.0.0", refId: "ref:runner:tool-matrix", type: "state", producerStageId: "prepare", scope: "task", metadata: { status: "complete" }, compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" }, redaction: { class: "internal", fields: ["metadata"] } },
        { schemaVersion: "1.0.0", refId: "ref:runner:official-repair-feedback", type: "diagnostic", producerStageId: "understand", scope: "task", metadata: { failingTestCount: 2, failureExcerptCount: 1 }, compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" }, redaction: { class: "internal", fields: ["metadata"] } }
      ],
      events: [],
      compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
      redaction: { class: "internal" }
    }));
    const capturedRequests: ModelRequest[] = [];
    const runtimeDeps = {
      ...deps,
      models: new CaptureModelRequestGateway(capturedRequests)
    };
    await registerRuntimeCoreTools(runtimeDeps, process.cwd());
    const kernel = await createDefaultRuntimeKernel(runtimeDeps);

    await runCli(
      [
        "run",
        "Resolve SWE-bench instance demo__repo-1.\n\nManaged SWE-bench execution profile:\nProblem statement:\nfix it",
        "--supervisor-workflow-state",
        statePath,
        "--output",
        "jsonl",
        "--live",
        "--tool-projection",
        "all"
      ],
      () => undefined,
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps: runtimeDeps, kernel })
      }
    );

    const firstRequest = capturedRequests[0];
    const profilePolicy = firstRequest?.metadata?.profilePolicy as JsonObject | undefined;
    const readyStage = firstRequest?.metadata?.workflowReadyStageControl as JsonObject | undefined;
    const toolNames = (firstRequest?.tools ?? []).map((tool) => {
      const fn = tool.function;
      return isJsonObject(fn) ? String(fn.name) : "";
    });
    const stagedWorkflow = profilePolicy?.stagedTaskWorkflow as JsonObject | undefined;
    const runState = stagedWorkflow?.runState as JsonObject | undefined;
    const stageStates = runState?.stageStates as JsonObject[] | undefined;

    assert.equal(stageStates?.find((stage) => stage.stageId === "stage:understand")?.status, "succeeded");
    assert.equal(readyStage?.stageId, "stage:change");
    assert.equal(readyStage?.stageKind, "produce");
    assert.equal(String(readyStage?.requiredNextAction).includes("core.file.edit"), true);
    assert.equal(toolNames.includes("core_file_edit"), true);
    assert.equal(toolNames.includes("core_patch_apply"), true);
    await kernel.shutdown("cli-test-supervisor-repair-workflow-state");
  });

  it("projects one-shot output contracts through prompt assembly and verification", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await deps.platform.writeFile(`${process.cwd().replace(/\\/g, "/")}/AGENTS.md`, "Use repository rules from AGENTS.md.\n");
    const capturedRequests: ModelRequest[] = [];
    const runtimeDeps = {
      ...deps,
      models: new CaptureModelRequestGateway(capturedRequests, "{\"ok\":true}")
    };
    await registerRuntimeCoreTools(runtimeDeps, process.cwd());
    const kernel = await createDefaultRuntimeKernel(runtimeDeps);
    const lines: string[] = [];

    await runCli(
      [
        "run",
        "contract task",
        "--output",
        "jsonl",
        "--output-contract",
        "json-object",
        "--output-schema",
        "{\"type\":\"object\",\"required\":[\"ok\"],\"properties\":{\"ok\":{\"type\":\"boolean\"}}}"
      ],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps: runtimeDeps, kernel })
      }
    );

    const firstRequest = capturedRequests[0];
    const promptText = firstRequest?.messages ? firstRequest.messages.map((message) => message.content).join("\n") : "";
    const events = lines.map((line) => JSON.parse(line) as { kind?: string; data?: { status?: string; outputContract?: { status?: string } } });
    assert.equal(promptText.includes("Task output contract:"), true);
    assert.equal(promptText.includes("Project repository instructions:"), true);
    assert.equal(promptText.includes("AGENTS.md"), true);
    assert.equal(promptText.includes("\"ok\""), true);
    assert.deepEqual(firstRequest?.output, {
      format: "json_object",
      schema: {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean" } }
      },
      strict: true
    });
    assert.equal(events.some((event) => event.kind === "agent.output-contract.verified" && event.data?.status === "pass"), true);
    assert.equal(events.at(-1)?.data?.outputContract?.status, "pass");
    await kernel.shutdown("cli-test-output-contract");
  });

  it("verifies command-plan output contracts as JSON object mode", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const capturedRequests: ModelRequest[] = [];
    const runtimeDeps = {
      ...deps,
      models: new CaptureModelRequestGateway(capturedRequests, "{\"commands\":[\"pwd\"],\"done\":true}")
    };
    await registerRuntimeCoreTools(runtimeDeps, process.cwd());
    const kernel = await createDefaultRuntimeKernel(runtimeDeps);
    const lines: string[] = [];

    await runCli(
      ["run", "plan task", "--output", "jsonl", "--output-contract", "command-plan"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps: runtimeDeps, kernel })
      }
    );

    const firstRequest = capturedRequests[0];
    const promptText = firstRequest?.messages ? firstRequest.messages.map((message) => message.content).join("\n") : "";
    const events = lines.map((line) => JSON.parse(line) as { kind?: string; data?: { status?: string; outputContract?: { status?: string } } });
    assert.equal(firstRequest?.output?.format, "json_object");
    assert.equal(promptText.includes("commands array of shell command strings"), true);
    assert.equal(events.some((event) => event.kind === "agent.output-contract.verified" && event.data?.status === "pass"), true);
    assert.equal(events.at(-1)?.data?.outputContract?.status, "pass");
    await kernel.shutdown("cli-test-command-plan-output-contract");
  });

  it("renders one-shot final JSON summaries", async () => {
    const lines: string[] = [];
    await runCli(["run", "summary", "--output", "json"], (line: string) => {
      lines.push(line);
    });
    const summary = JSON.parse(lines[0] ?? "{}") as { status?: string; assistantText?: string; traceId?: string; selfRepair?: { enabled?: boolean; activated?: boolean; stopReason?: string } };

    assert.equal(lines.length, 1);
    assert.equal(summary.status, "completed");
    assert.equal(summary.assistantText?.includes("DeepSeek mock response"), true);
    assert.equal(typeof summary.traceId, "string");
    assert.equal(summary.selfRepair?.enabled, true);
    assert.equal(summary.selfRepair?.activated, false);
    assert.equal(summary.selfRepair?.stopReason, "completed");
  });

  it("runs scripted chat turns with one session id", async () => {
    const lines: string[] = [];
    await runCli(["chat", "--output", "jsonl"], (line: string) => {
      lines.push(line);
    }, ["first\nsecond\n/exit\n"], { stdinIsTTY: false, stdoutIsTTY: false });
    const events = lines.map((line) => JSON.parse(line) as { kind: string; sessionId?: string });
    const completed = events.filter((event) => event.kind === "agent.loop.completed");

    assert.equal(completed.length, 2);
    assert.equal(completed[0]?.sessionId, completed[1]?.sessionId);
  });

  it("keeps approval slash commands local in chat", async () => {
    const lines: string[] = [];
    await runCli(["chat", "--output", "jsonl"], (line: string) => {
      lines.push(line);
    }, ["/approval inspect approval:cli-test\n/approval deny approval:cli-test\n/approval unknown approval:cli-test\n/exit\n"], { stdinIsTTY: false, stdoutIsTTY: false });
    const records = lines.map((line) => JSON.parse(line) as { kind?: string; result?: { action?: string; brokerDecision?: string }; command?: string; code?: string });

    assert.equal(records.some((record) => record.kind === "chat.command.approval" && record.result?.action === "inspect"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.approval" && record.result?.brokerDecision === "deny"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.local-failure" && record.code === "CLI_APPROVAL_COMMAND_INVALID"), true);
    assert.equal(records.some((record) => record.kind === "model.requested"), false);
  });

  it("keeps palette slash commands local in chat", async () => {
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/palette\n/keymap vi-minimal\n/palette action inspect command:readiness.doctor\n/palette action inspect missing-target\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      turnId?: string;
      record?: {
        kind?: string;
        ok?: boolean;
        action?: string;
        target?: { id?: string };
        diagnostics?: readonly { code?: string }[];
        diagnostic?: { code?: string };
        name?: string;
      };
    });

    assert.equal(records.some((record) => record.kind === "chat.command.palette" && record.record?.kind === "palette.summary"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.keymap" && record.record?.kind === "palette.keymap.summary"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.keymap" && record.record?.name === "vi-minimal"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-action" && record.record?.ok === true && record.record.action === "inspect"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-action" && record.record?.kind === "palette.action.result" && record.record.ok === false), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-action" && record.record?.kind === "palette.action.diagnostic" && record.record.diagnostic?.code === "CLI_ACTION_TARGET_NOT_FOUND"), true);
    assert.equal(records.some((record) => record.kind === "model.requested"), false);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("keeps palette navigation state local in chat", async () => {
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/palette\n/palette state\n/palette next\n/palette back\n/palette forward\n/palette refs add current\n/palette state\n/palette refs remove current\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      command?: string;
      code?: string;
      record?: {
        kind?: string;
        ok?: boolean;
        action?: string;
        activeTargetId?: string;
        activeItemId?: string;
        jumpCount?: number;
        jumpCursor?: number;
        referenceCount?: number;
      };
    });
    const stateRecords = records
      .filter((record) => record.kind === "chat.command.palette-state" || record.record?.kind === "palette.state")
      .map((record) => record.record ?? record as { activeTargetId?: string; activeItemId?: string; jumpCount?: number; jumpCursor?: number; referenceCount?: number });
    const initialState = stateRecords.find((record) => record.jumpCount === 0 && record.jumpCursor === -1);
    const navigationState = stateRecords.find((record) => record.jumpCount === 1 && record.jumpCursor === 0 && record.activeItemId !== initialState?.activeItemId);
    const backState = stateRecords.find((record) => record.jumpCount === 1 && record.jumpCursor === -1 && record.activeItemId === initialState?.activeItemId);
    const forwardState = stateRecords.find((record) => record.jumpCount === 1 && record.jumpCursor === 0 && record.activeItemId === navigationState?.activeItemId);
    const referenceState = stateRecords.find((record) => record.jumpCount === 1 && record.jumpCursor === 0 && record.referenceCount === 1);

    assert.equal(records.some((record) => record.kind === "chat.command.palette-action" && record.record?.kind === "palette.action.result" && record.record.ok === true && record.record.action === "next"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-action" && record.record?.kind === "palette.action.result" && record.record.ok === true && record.record.action === "back"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-action" && record.record?.kind === "palette.action.result" && record.record.ok === true && record.record.action === "forward"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-action" && record.record?.kind === "palette.action.result" && record.record.ok === true && record.record.action === "add-to-reference-set"), true);
    assert.equal(Boolean(initialState), true);
    assert.equal(Boolean(navigationState), true);
    assert.equal(Boolean(backState), true);
    assert.equal(Boolean(forwardState), true);
    assert.equal(Boolean(referenceState), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.mutation" && record.record.ok === true && record.record.action === "remove" && record.record.referenceCount === 0), true);
    assert.equal(records.some((record) => record.kind === "model.requested"), false);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("lists and focuses chat palette references locally", async () => {
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/palette\n/palette refs add current\n/palette next\n/palette refs add current\n/palette refs list\n/palette refs focus 1\n/palette refs list\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        ok?: boolean;
        selector?: string;
        referenceCount?: number;
        activeReferenceId?: string;
        referenceId?: string;
        targetId?: string;
        set?: { itemCount?: number };
        item?: { id?: string; target?: { id?: string } };
        active?: boolean;
      };
    });
    const items = records.filter((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.item");
    const focus = records.find((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.focus");
    const finalSummary = records.filter((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.references").at(-1)?.record;

    assert.equal(records.some((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.references" && record.record.referenceCount === 2), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.set" && record.record.set?.itemCount === 2), true);
    assert.equal(items.length >= 4, true);
    assert.equal(focus?.record?.ok, true);
    assert.equal(focus?.record?.selector, "1");
    assert.equal(finalSummary?.activeReferenceId, focus?.record?.referenceId);
    assert.equal(records.some((record) => record.kind === "model.requested"), false);
    assert.equal(lines.join("\n").includes("\u001b["), false);
    assert.equal(lines.join("\n").includes('"content"'), false);
  });

  it("removes and clears chat palette references locally", async () => {
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/palette\n/palette refs add current\n/palette next\n/palette refs add current\n/palette refs remove 1\n/palette refs list\n/palette refs remove missing-reference\n/palette refs clear\n/palette refs list\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        ok?: boolean;
        action?: string;
        selector?: string;
        referenceCount?: number;
        activeReferenceId?: string;
      };
    });

    assert.equal(records.some((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.mutation" && record.record.ok === true && record.record.action === "remove" && record.record.referenceCount === 1), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.references" && record.record.referenceCount === 1), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.mutation" && record.record.ok === false && record.record.action === "remove" && record.record.selector === "missing-reference"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.mutation" && record.record.ok === true && record.record.action === "clear" && record.record.referenceCount === 0), true);
    assert.equal(records.filter((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.references").at(-1)?.record?.referenceCount, 0);
    assert.equal(records.some((record) => record.kind === "model.requested"), false);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("keeps missing palette reference focus local in chat", async () => {
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/palette refs focus missing-reference\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        ok?: boolean;
        action?: string;
        diagnostic?: { code?: string };
      };
    });

    assert.equal(records.some((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.focus" && record.record.ok === false), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.action.diagnostic" && record.record.diagnostic?.code === "CLI_ACTION_TARGET_NOT_FOUND"), true);
    assert.equal(records.some((record) => record.kind === "model.requested"), false);
  });

  it("carries active chat references as runtime request metadata without prompt mutation", async () => {
    const lines: string[] = [];
    const gateway = new CapturingModelGateway();
    const deps = { ...createDeterministicRuntimeDependencies(), models: gateway };
    const kernel = await createDefaultRuntimeKernel(deps);
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/palette\n/palette refs add current\nuse active refs\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel })
      }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      data?: {
        referenceContext?: {
          itemCount?: number;
          setCount?: number;
          activeItemId?: string;
          targets?: readonly { targetId?: string }[];
          sets?: readonly { items?: readonly { target?: { id?: string } }[] }[];
        };
      };
    });
    const started = records.find((record) => record.kind === "agent.loop.started");
    const turnStarted = records.find((record) => record.kind === "turn.started");
    const modelRequested = records.find((record) => record.kind === "model.requested");

    assert.equal(started?.data?.referenceContext?.itemCount, 1);
    assert.equal(started?.data?.referenceContext?.targets?.[0]?.targetId, "command:interactive.cancel");
    assert.equal(turnStarted?.data?.referenceContext?.itemCount, 1);
    assert.equal(turnStarted?.data?.referenceContext?.sets?.[0]?.items?.[0]?.target?.id, "command:interactive.cancel");
    assert.equal(modelRequested?.data?.referenceContext?.itemCount, 1);
    assert.equal(gateway.requests.length, 1);
    assert.equal(requestUserMessage(gateway.requests[0], "use active refs")?.content, "use active refs");
    assert.equal(gateway.requests[0]?.prompt.includes("user: use active refs"), true);
    assert.equal(gateway.requests[0]?.metadata?.referenceContext && typeof gateway.requests[0]?.metadata.referenceContext === "object", true);
    assert.equal(JSON.stringify(gateway.requests[0]).includes("use active refs\n"), false);
    assert.equal(lines.join("\n").includes('"content"'), false);
    await kernel.shutdown("cli-test-reference-context");
  });

  it("keeps add-file references local and projects them on the next prompt", async () => {
    const lines: string[] = [];
    const gateway = new CapturingModelGateway();
    const deps = { ...createDeterministicRuntimeDependencies(), models: gateway };
    await deps.platform.writeFile(`${process.cwd().replace(/\\/g, "/")}/notes.md`, "cli projected note\n");
    const kernel = await createDefaultRuntimeKernel(deps);
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/palette refs add-file notes.md\n/palette refs list\nuse file ref\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel })
      }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: { kind?: string; referenceCount?: number; item?: { target?: { path?: string } } };
      data?: { contextProjection?: { selectedNodeCount?: number } };
    });
    const firstModelIndex = records.findIndex((record) => record.kind === "model.requested");
    const firstRuntimeIndex = records.findIndex((record) => record.kind === "agent.loop.started");
    const addFileIndex = records.findIndex((record) => record.kind === "chat.command.palette-action");

    assert.equal(addFileIndex >= 0, true);
    assert.equal(firstModelIndex > addFileIndex, true);
    assert.equal(firstRuntimeIndex > addFileIndex, true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.item" && record.record.item?.target?.path === "notes.md"), true);
    assert.equal(records.some((record) => record.kind === "model.requested" && (record.data?.contextProjection?.selectedNodeCount ?? 0) >= 2), true);
    assert.equal(requestSystemMessageIncluding(gateway.requests[0], "cli projected note")?.role, "system");
    assert.equal(requestUserMessage(gateway.requests[0], "use file ref")?.content, "use file ref");
    assert.equal(lines.slice(0, firstRuntimeIndex).join("\n").includes("cli projected note"), false);
    await kernel.shutdown("cli-test-add-file-reference");
  });

  it("turns palette file search results into navigable file references", async () => {
    const lines: string[] = [];
    const gateway = new CapturingModelGateway();
    const deps = { ...createDeterministicRuntimeDependencies(), models: gateway };
    const root = process.cwd().replace(/\\/g, "/");
    await deps.platform.writeFile(`${root}/src/alpha-search.ts`, "alpha should stay local before prompt\n");
    await deps.platform.writeFile(`${root}/src/beta-search.ts`, "beta selected through palette files\n");
    const kernel = await createDefaultRuntimeKernel(deps);
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/palette files search.ts\n/palette next\n/palette refs add current\n/palette refs list\nuse selected file\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel })
      }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        ok?: boolean;
        action?: string;
        matchedCount?: number;
        activeItemId?: string;
        item?: { kind?: string; target?: { kind?: string; path?: string } };
        referenceCount?: number;
      };
      data?: { contextProjection?: { selectedNodeCount?: number } };
    });
    const firstModelIndex = records.findIndex((record) => record.kind === "model.requested");
    const preModelOutput = lines.slice(0, firstModelIndex).join("\n");

    assert.equal(records.some((record) => record.kind === "chat.command.palette-files" && record.record?.kind === "palette.files" && record.record.matchedCount === 2), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-files" && record.record?.kind === "palette.file.item" && record.record.item?.target?.kind === "file"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-action" && record.record?.kind === "palette.action.result" && record.record.ok === true && record.record.action === "next"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.item" && record.record.item?.kind === "file" && record.record.item.target?.path === "src/beta-search.ts"), true);
    assert.equal(firstModelIndex > 0, true);
    assert.equal(preModelOutput.includes("alpha should stay local before prompt"), false);
    assert.equal(preModelOutput.includes("beta selected through palette files"), false);
    assert.equal(records.some((record) => record.kind === "model.requested" && (record.data?.contextProjection?.selectedNodeCount ?? 0) >= 2), true);
    assert.equal(gateway.requests.length, 1);
    assert.equal(requestSystemMessageIncluding(gateway.requests[0], "beta selected through palette files")?.content.includes("alpha should stay local before prompt"), false);
    assert.equal(requestUserMessage(gateway.requests[0], "use selected file")?.content, "use selected file");
    assert.equal(lines.join("\n").includes("\u001b["), false);
    await kernel.shutdown("cli-test-palette-file-search");
  });

  it("turns palette text search results into navigable file references", async () => {
    const lines: string[] = [];
    const gateway = new CapturingModelGateway();
    const deps = { ...createDeterministicRuntimeDependencies(), models: gateway };
    const root = process.cwd().replace(/\\/g, "/");
    await deps.platform.writeFile(`${root}/src/grep-alpha.ts`, "needle alpha preview\nalpha hidden full line detail\n");
    await deps.platform.writeFile(`${root}/src/grep-beta.ts`, "needle beta preview\nbeta projected full file detail\n");
    const kernel = await createDefaultRuntimeKernel(deps);
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/palette grep needle\n/palette next\n/palette refs add current\n/palette refs list\nuse selected grep result\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel })
      }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        ok?: boolean;
        action?: string;
        matchedCount?: number;
        item?: { kind?: string; target?: { kind?: string; path?: string; metadata?: { line?: number; preview?: string } } };
      };
      data?: { contextProjection?: { selectedNodeCount?: number } };
    });
    const firstModelIndex = records.findIndex((record) => record.kind === "model.requested");
    const preModelOutput = lines.slice(0, firstModelIndex).join("\n");

    assert.equal(records.some((record) => record.kind === "chat.command.palette-grep" && record.record?.kind === "palette.grep" && record.record.matchedCount === 2), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-grep" && record.record?.kind === "palette.grep.item" && record.record.item?.target?.kind === "file" && record.record.item.target.metadata?.line === 1), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-action" && record.record?.kind === "palette.action.result" && record.record.ok === true && record.record.action === "next"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.item" && record.record.item?.kind === "file" && record.record.item.target?.path === "src/grep-beta.ts" && record.record.item.target.metadata?.line === 1), true);
    assert.equal(firstModelIndex > 0, true);
    assert.equal(preModelOutput.includes("alpha hidden full line detail"), false);
    assert.equal(preModelOutput.includes("beta projected full file detail"), false);
    assert.equal(records.some((record) => record.kind === "model.requested" && (record.data?.contextProjection?.selectedNodeCount ?? 0) >= 2), true);
    assert.equal(gateway.requests.length, 1);
    assert.equal(requestSystemMessageIncluding(gateway.requests[0], "beta projected full file detail")?.content.includes("alpha hidden full line detail"), false);
    assert.equal(requestUserMessage(gateway.requests[0], "use selected grep result")?.content, "use selected grep result");
    assert.equal(lines.join("\n").includes("\u001b["), false);
    await kernel.shutdown("cli-test-palette-text-search");
  });

  it("replaces chat palette references with the current result before projection", async () => {
    const lines: string[] = [];
    const gateway = new CapturingModelGateway();
    const deps = { ...createDeterministicRuntimeDependencies(), models: gateway };
    const root = process.cwd().replace(/\\/g, "/");
    await deps.platform.writeFile(`${root}/src/replace-alpha.ts`, "alpha replaced away\n");
    await deps.platform.writeFile(`${root}/src/replace-beta.ts`, "beta replacement context\n");
    const kernel = await createDefaultRuntimeKernel(deps);
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/palette refs add-file src/replace-alpha.ts\n/palette files replace-\n/palette next\n/palette refs replace current\n/palette refs list\nuse replacement only\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel })
      }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        ok?: boolean;
        action?: string;
        referenceCount?: number;
        item?: { target?: { path?: string } };
      };
      data?: {
        referenceContext?: { itemCount?: number };
        contextProjection?: { selectedNodeCount?: number };
      };
    });
    const firstModelIndex = records.findIndex((record) => record.kind === "model.requested");
    const firstRuntimeIndex = records.findIndex((record) => record.kind === "agent.loop.started");

    assert.equal(records.some((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.mutation" && record.record.ok === true && record.record.action === "replace" && record.record.referenceCount === 1), true);
    assert.equal(records.filter((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.item").length, 1);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.item" && record.record.item?.target?.path === "src/replace-beta.ts"), true);
    assert.equal(firstRuntimeIndex >= 0, true);
    assert.equal(records.some((record) => record.kind === "agent.loop.started" && record.data?.referenceContext?.itemCount === 1), true);
    assert.equal(records.some((record) => record.kind === "model.requested" && (record.data?.contextProjection?.selectedNodeCount ?? 0) >= 2), true);
    assert.equal(gateway.requests.length, 1);
    assert.equal(requestSystemMessageIncluding(gateway.requests[0], "beta replacement context")?.content.includes("alpha replaced away"), false);
    assert.equal(requestUserMessage(gateway.requests[0], "use replacement only")?.content, "use replacement only");
    assert.equal(lines.slice(0, firstRuntimeIndex).join("\n").includes("beta replacement context"), false);
    await kernel.shutdown("cli-test-reference-replace");
  });

  it("keeps empty palette jump traversal local in chat", async () => {
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/palette back\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        ok?: boolean;
        action?: string;
        diagnostic?: { code?: string };
      };
    });

    assert.equal(records.some((record) => record.kind === "chat.command.palette-action" && record.record?.kind === "palette.action.result" && record.record.ok === false && record.record.action === "back"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-action" && record.record?.kind === "palette.action.diagnostic" && record.record.diagnostic?.code === "CLI_ACTION_TARGET_NOT_FOUND"), true);
    assert.equal(records.some((record) => record.kind === "model.requested"), false);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("renders scriptable revert preview as typed dry-run output", async () => {
    const jsonLines: string[] = [];
    await runCli(["revert", "preview", "--request", "request-missing", "--output", "json"], (line: string) => {
      jsonLines.push(line);
    }, [], { stdinIsTTY: false, stdoutIsTTY: false });
    const preview = JSON.parse(jsonLines[0] ?? "{}") as {
      kind?: string;
      ok?: boolean;
      dryRun?: boolean;
      status?: string;
      diagnostics?: readonly { code?: string }[];
    };

    assert.equal(preview.kind, "revert.preview");
    assert.equal(preview.ok, false);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.status, "rejected");
    assert.equal(preview.diagnostics?.[0]?.code, "CHECKPOINT_REVERT_EMPTY");

    const jsonlLines: string[] = [];
    await runCli(["revert", "preview", "--turn", "turn-missing", "--output", "jsonl"], (line: string) => {
      jsonlLines.push(line);
    }, [], { stdinIsTTY: false, stdoutIsTTY: false });
    const records = jsonlLines.map((line) => JSON.parse(line) as { kind?: string; ok?: boolean; status?: string; diagnostic?: { code?: string } });

    assert.equal(records[0]?.kind, "revert.preview.summary");
    assert.equal(records[0]?.ok, false);
    assert.equal(records[0]?.status, "rejected");
    assert.equal(records.some((record) => record.kind === "revert.preview.diagnostic" && record.diagnostic?.code === "CHECKPOINT_REVERT_EMPTY"), true);
  });

  it("keeps chat revert preview local", async () => {
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/revert preview --turn turn-missing\n/revert preview\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: { kind?: string; ok?: boolean; status?: string; diagnostic?: { code?: string } };
    });

    assert.equal(records.some((record) => record.kind === "chat.command.revert-preview" && record.record?.kind === "revert.preview.summary" && record.record.ok === false), true);
    assert.equal(records.some((record) => record.kind === "chat.command.revert-preview" && record.record?.kind === "revert.preview.diagnostic" && record.record.diagnostic?.code === "CHECKPOINT_REVERT_EMPTY"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.revert-preview" && record.record?.kind === "revert.preview.diagnostic" && record.record.diagnostic?.code === "CLI_REVERT_TARGET_REQUIRED"), true);
    assert.equal(records.some((record) => record.kind === "model.requested"), false);
  });

  it("tracks chat history and previews revert for the selected current turn", async () => {
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["first prompt\nsecond prompt\n/history\n/history select 1\n/revert preview current\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      turnId?: string;
      record?: {
        kind?: string;
        count?: number;
        selectedTurnId?: string;
        entry?: { index?: number; turnId?: string; selected?: boolean; promptPreview?: string };
        target?: { turnId?: string; sessionId?: string };
        diagnostic?: { code?: string };
      };
    });
    const completed = records.filter((record) => record.kind === "agent.loop.completed");
    const firstTurnId = completed[0]?.turnId;

    assert.equal(completed.length, 2);
    assert.equal(records.some((record) => record.kind === "chat.command.history" && record.record?.kind === "history.summary" && record.record.count === 2), true);
    assert.equal(records.some((record) => record.kind === "chat.command.history" && record.record?.kind === "history.entry" && record.record.entry?.promptPreview === "first prompt"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.history" && record.record?.kind === "history.selection" && record.record.entry?.index === 1), true);
    assert.equal(records.some((record) => record.kind === "chat.command.revert-preview" && record.record?.kind === "revert.preview.summary" && record.record.target?.turnId === firstTurnId), true);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("recalls completed chat turns through the local PageIndex", async () => {
    const lines: string[] = [];
    const longHiddenSuffix = "pageindex-secret-detail-".repeat(12);
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      [`database auth decision ${longHiddenSuffix}\nrenderer layout decision\n/palette recall database\n/palette next\n/palette state\n/exit\n`],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        indexedCount?: number;
        matchedCount?: number;
        activeItemId?: string;
        activeTargetKind?: string;
        jumpCount?: number;
        item?: {
          id?: string;
          target?: {
            kind?: string;
            sessionId?: string;
            turnId?: string;
            metadata?: {
              createdAt?: string;
              pageId?: string;
              promptPreview?: string;
              assistantPreview?: string;
              deterministicScore?: number;
              rankingReason?: string;
              matchedFields?: readonly string[];
              freshnessStatus?: string;
              evidenceQuality?: { createdAtSource?: string; freshnessStatus?: string };
              semantic?: { status?: string };
            };
          };
          metadata?: {
            createdAt?: string;
            pageId?: string;
            promptPreview?: string;
            assistantPreview?: string;
            deterministicScore?: number;
            rankingReason?: string;
            matchedFields?: readonly string[];
            freshnessStatus?: string;
            evidenceQuality?: { createdAtSource?: string; freshnessStatus?: string };
          };
        };
        action?: string;
        ok?: boolean;
      };
    });
    const recallSummary = records.find((record) => record.kind === "chat.command.palette-recall" && record.record?.kind === "palette.recall")?.record;
    const recallItem = records.find((record) => record.kind === "chat.command.palette-recall" && record.record?.kind === "palette.recall.item")?.record;
    const paletteState = records.find((record) => record.kind === "chat.command.palette-state" && record.record?.kind === "palette.state")?.record;

    assert.equal(records.filter((record) => record.kind === "model.requested").length, 2);
    assert.equal(recallSummary?.indexedCount, 2);
    assert.equal(recallSummary?.matchedCount, 1);
    assert.equal(recallItem?.item?.target?.kind, "turn");
    assert.equal(typeof recallItem?.item?.target?.sessionId, "string");
    assert.equal(typeof recallItem?.item?.target?.turnId, "string");
    assert.equal(typeof recallItem?.item?.target?.metadata?.pageId, "string");
    assert.equal(recallItem?.item?.target?.metadata?.createdAt, "1970-01-01T00:00:00.000Z");
    assert.equal(recallItem?.item?.target?.metadata?.freshnessStatus, "fresh");
    assert.deepEqual(recallItem?.item?.target?.metadata?.matchedFields, ["assistantPreview", "promptPreview"]);
    assert.equal(recallItem?.item?.target?.metadata?.rankingReason, "deterministic-text-match");
    assert.equal(recallItem?.item?.target?.metadata?.evidenceQuality?.createdAtSource, "runtime-event");
    assert.equal(recallItem?.item?.target?.metadata?.semantic?.status, "deferred");
    assert.equal((recallItem?.item?.target?.metadata?.promptPreview?.length ?? 0) <= 160, true);
    assert.equal((recallItem?.item?.target?.metadata?.assistantPreview?.length ?? 0) <= 160, true);
    assert.equal(typeof recallItem?.item?.target?.metadata?.deterministicScore, "number");
    assert.deepEqual(recallItem?.item?.metadata?.matchedFields, ["assistantPreview", "promptPreview"]);
    assert.equal(recallItem?.item?.metadata?.freshnessStatus, "fresh");
    assert.equal(records.some((record) => record.kind === "chat.command.palette-action" && record.record?.kind === "palette.action.result" && record.record.ok === true && record.record.action === "next"), true);
    assert.equal(paletteState?.activeTargetKind, "turn");
    assert.equal(JSON.stringify(recallSummary).includes(longHiddenSuffix), false);
    assert.equal(JSON.stringify(recallItem).includes(longHiddenSuffix), false);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("explains the active PageIndex recall result locally", async () => {
    const lines: string[] = [];
    const longHiddenSuffix = "pageindex-explain-hidden-".repeat(12);
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      [`database explain decision ${longHiddenSuffix}\nrenderer layout decision\n/palette recall database\n/palette recall explain current\n/exit\n`],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        ok?: boolean;
        scope?: string;
        pageId?: string;
        sessionId?: string;
        turnId?: string;
        createdAt?: string;
        freshnessStatus?: string;
        matchedFields?: readonly string[];
        rankingReason?: string;
        deterministicScore?: number;
        semanticStatus?: string;
        promptPreview?: string;
        assistantPreview?: string;
        diagnosticCode?: string;
      };
    });
    const explain = records.find((record) => record.kind === "chat.command.palette-recall-explain" && record.record?.kind === "palette.recall.explain")?.record;

    assert.equal(records.filter((record) => record.kind === "model.requested").length, 2);
    assert.equal(explain?.ok, true);
    assert.equal(explain?.scope, "session");
    assert.equal(typeof explain?.pageId, "string");
    assert.equal(typeof explain?.sessionId, "string");
    assert.equal(typeof explain?.turnId, "string");
    assert.equal(explain?.createdAt, "1970-01-01T00:00:00.000Z");
    assert.equal(explain?.freshnessStatus, "fresh");
    assert.deepEqual(explain?.matchedFields, ["assistantPreview", "promptPreview"]);
    assert.equal(explain?.rankingReason, "deterministic-text-match");
    assert.equal(typeof explain?.deterministicScore, "number");
    assert.equal(explain?.semanticStatus, "deferred");
    assert.equal(JSON.stringify(explain).includes(longHiddenSuffix), false);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("keeps missing PageIndex recall explain targets local", async () => {
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/palette recall explain current\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: { kind?: string; ok?: boolean; diagnosticCode?: string };
    });
    const explain = records.find((record) => record.kind === "chat.command.palette-recall-explain" && record.record?.kind === "palette.recall.explain")?.record;

    assert.equal(records.some((record) => record.kind === "model.requested"), false);
    assert.equal(explain?.ok, false);
    assert.equal(explain?.diagnosticCode, "CLI_PAGEINDEX_RECALL_EXPLAIN_TARGET_NOT_FOUND");
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("keeps PageIndex deterministic timestamp fallback for legacy terminal events", () => {
    const sessionId = asId<"session">("session-pageindex-legacy");
    const turnId = asId<"turn">("turn-pageindex-legacy");
    const terminal = {
      kind: "agent.loop.completed",
      sessionId,
      turnId,
      trace: {
        traceId: asId<"trace">("trace-pageindex-legacy"),
        spanId: asId<"span">("span-pageindex-legacy"),
        correlationId: asId<"correlation">("corr-pageindex-legacy"),
        sessionId
      },
      data: { assistantText: "legacy assistant" }
    } as unknown as RuntimeEvent;
    const pages = recordChatPageIndexTurn([], { prompt: "legacy prompt", terminal });
    const page = pages[0];

    assert.equal(page?.createdAt, "1970-01-01T00:00:00.000Z");
    assert.equal(page?.evidenceQuality.createdAtSource, "deterministic-fallback");
    assert.equal(page?.evidenceQuality.freshnessStatus, "unknown");
  });

  it("preserves stale PageIndex freshness through restored snapshots", () => {
    const sessionId = asId<"session">("session-pageindex-stale");
    const turnId = asId<"turn">("turn-pageindex-stale");
    const pages = chatPageIndexPagesFromSnapshot({
      kind: "chat.pageindex.snapshot",
      schemaVersion: "1.0.0",
      scope: "session",
      pageCount: 1,
      pages: [{
        kind: "pageindex.page",
        scope: "session",
        pageId: "page-stale",
        sessionId,
        turnId,
        sequence: 1,
        status: "completed",
        traceId: "trace-pageindex-stale",
        createdAt: "1970-01-01T00:00:00.000Z",
        promptPreview: "stale database decision",
        assistantPreview: "stale assistant",
        evidenceQuality: {
          createdAt: "1970-01-01T00:00:00.000Z",
          createdAtSource: "runtime-event",
          freshnessStatus: "stale"
        },
        redaction: { class: "internal" },
        semantic: { status: "deferred" }
      }],
      redaction: { class: "internal" }
    });
    const resolved = resolveChatPageIndexRecall(createChatPaletteState(), pages, "database");
    const item = resolved.resultList.items[0];

    assert.equal(pages[0]?.evidenceQuality.freshnessStatus, "stale");
    assert.equal(item?.target.metadata?.freshnessStatus, "stale");
    assert.equal(item?.metadata?.freshnessStatus, "stale");
  });

  it("marks earlier same-session PageIndex pages stale after later workspace mutations", () => {
    const sessionId = asId<"session">("session-pageindex-workspace-stale");
    const firstTurnId = asId<"turn">("turn-pageindex-workspace-stale-1");
    const secondTurnId = asId<"turn">("turn-pageindex-workspace-stale-2");
    const pages = chatPageIndexPagesFromSnapshot({
      kind: "chat.pageindex.snapshot",
      schemaVersion: "1.0.0",
      scope: "session",
      pageCount: 1,
      pages: [{
        kind: "pageindex.page",
        scope: "session",
        pageId: "page-workspace-stale",
        sessionId,
        turnId: firstTurnId,
        sequence: 1,
        status: "completed",
        traceId: "trace-pageindex-workspace-stale",
        createdAt: "1970-01-01T00:00:00.000Z",
        promptPreview: "database stale candidate",
        assistantPreview: "assistant stale candidate",
        evidenceQuality: {
          createdAt: "1970-01-01T00:00:00.000Z",
          createdAtSource: "runtime-event",
          freshnessStatus: "fresh"
        },
        redaction: { class: "internal" },
        semantic: { status: "deferred" }
      }],
      redaction: { class: "internal" }
    });
    const adjusted = markStalePageIndexPagesAfterWorkspaceEdits(pages, {
      turnOrder: [
        { sessionId, turnId: firstTurnId, index: 1 },
        { sessionId, turnId: secondTurnId, index: 2 }
      ],
      mutations: [{ sessionId, turnId: secondTurnId }]
    });
    const resolved = resolveChatPageIndexRecall(createChatPaletteState(), adjusted, "database");
    const item = resolved.resultList.items[0];

    assert.equal(adjusted[0]?.evidenceQuality.freshnessStatus, "stale");
    assert.equal(adjusted[0]?.evidenceQuality.staleReason, "workspace-edit-after-page");
    assert.equal(item?.target.metadata?.freshnessStatus, "stale");
    assert.equal(item?.metadata?.freshnessStatus, "stale");
  });

  it("preserves unknown and cross-session PageIndex freshness when stale ordering is unproven", () => {
    const sessionId = asId<"session">("session-pageindex-stale-unproven");
    const otherSessionId = asId<"session">("session-pageindex-stale-other");
    const turnId = asId<"turn">("turn-pageindex-stale-unproven-1");
    const laterTurnId = asId<"turn">("turn-pageindex-stale-unproven-2");
    const pages = chatPageIndexPagesFromSnapshot({
      kind: "chat.pageindex.snapshot",
      schemaVersion: "1.0.0",
      scope: "session",
      pageCount: 2,
      pages: [{
        kind: "pageindex.page",
        scope: "session",
        pageId: "page-unknown",
        sessionId,
        turnId,
        sequence: 1,
        status: "completed",
        traceId: "trace-pageindex-unknown",
        createdAt: "1970-01-01T00:00:00.000Z",
        promptPreview: "unknown database",
        assistantPreview: "assistant unknown",
        evidenceQuality: {
          createdAt: "1970-01-01T00:00:00.000Z",
          createdAtSource: "deterministic-fallback",
          freshnessStatus: "unknown"
        },
        redaction: { class: "internal" },
        semantic: { status: "deferred" }
      }, {
        kind: "pageindex.page",
        scope: "session",
        pageId: "page-fresh-cross-session",
        sessionId,
        turnId: laterTurnId,
        sequence: 2,
        status: "completed",
        traceId: "trace-pageindex-fresh-cross-session",
        createdAt: "1970-01-01T00:00:00.000Z",
        promptPreview: "fresh database",
        assistantPreview: "assistant fresh",
        evidenceQuality: {
          createdAt: "1970-01-01T00:00:00.000Z",
          createdAtSource: "runtime-event",
          freshnessStatus: "fresh"
        },
        redaction: { class: "internal" },
        semantic: { status: "deferred" }
      }],
      redaction: { class: "internal" }
    });
    const adjusted = markStalePageIndexPagesAfterWorkspaceEdits(pages, {
      turnOrder: [
        { sessionId, turnId, index: 1 },
        { sessionId, turnId: laterTurnId, index: 2 }
      ],
      mutations: [{ sessionId: otherSessionId, turnId: asId<"turn">("turn-pageindex-stale-other") }]
    });

    assert.equal(adjusted[0]?.evidenceQuality.freshnessStatus, "unknown");
    assert.equal(adjusted[1]?.evidenceQuality.freshnessStatus, "fresh");
  });

  it("adjusts workspace PageIndex freshness from checkpoint watermarks", () => {
    const sessionId = asId<"session">("session-pageindex-watermark");
    const basePage = {
      kind: "pageindex.page",
      scope: "workspace",
      pageId: "page-watermark",
      sessionId,
      turnId: asId<"turn">("turn-pageindex-watermark"),
      sequence: 1,
      status: "completed",
      traceId: "trace-pageindex-watermark",
      createdAt: "1970-01-01T00:00:00.000Z",
      promptPreview: "database watermark",
      assistantPreview: "assistant watermark",
      evidenceQuality: {
        createdAt: "1970-01-01T00:00:00.000Z",
        createdAtSource: "runtime-event",
        freshnessStatus: "fresh",
        workspaceCheckpointWatermark: 1
      },
      redaction: { class: "internal" },
      semantic: { status: "deferred" }
    } as const;
    const fresh = markStalePageIndexPagesFromWorkspaceWatermark([basePage], { workspaceCheckpointWatermark: 1 });
    const stale = markStalePageIndexPagesFromWorkspaceWatermark([basePage], { workspaceCheckpointWatermark: 2 });
    const unknown = markStalePageIndexPagesFromWorkspaceWatermark([{
      ...basePage,
      pageId: "page-watermark-legacy",
      evidenceQuality: {
        createdAt: "1970-01-01T00:00:00.000Z",
        createdAtSource: "runtime-event",
        freshnessStatus: "fresh"
      }
    }], { workspaceCheckpointWatermark: 2 });

    assert.equal(fresh[0]?.evidenceQuality.freshnessStatus, "fresh");
    assert.equal(stale[0]?.evidenceQuality.freshnessStatus, "stale");
    assert.equal(stale[0]?.evidenceQuality.staleReason, "workspace-checkpoint-watermark-advanced");
    assert.equal(unknown[0]?.evidenceQuality.freshnessStatus, "unknown");
    assert.equal(unknown[0]?.evidenceQuality.staleReason, "workspace-watermark-missing");
  });

  it("explains unknown PageIndex freshness evidence for missing workspace watermarks", () => {
    const sessionId = asId<"session">("session-pageindex-unknown-evidence");
    const page = {
      kind: "pageindex.page",
      scope: "workspace",
      pageId: "page-unknown-evidence",
      sessionId,
      turnId: asId<"turn">("turn-pageindex-unknown-evidence"),
      sequence: 1,
      status: "completed",
      traceId: "trace-pageindex-unknown-evidence",
      createdAt: "1970-01-01T00:00:00.000Z",
      promptPreview: "database unknown evidence",
      assistantPreview: "assistant unknown evidence",
      evidenceQuality: {
        createdAt: "1970-01-01T00:00:00.000Z",
        createdAtSource: "runtime-event",
        freshnessStatus: "fresh"
      },
      redaction: { class: "internal" },
      semantic: { status: "deferred" }
    } as const;
    const adjusted = markStalePageIndexPagesFromWorkspaceWatermark([page], { workspaceCheckpointWatermark: 2 });
    const resolved = resolveChatPageIndexRecall(createChatPaletteState(), adjusted, "database", "workspace");
    const explain = JSON.parse(renderChatPageIndexRecallExplain(explainChatPageIndexRecallItem(resolved.state.snapshot, "current"), "json")[0] ?? "{}") as {
      freshnessStatus?: string;
      freshnessEvidence?: { reason?: string; scope?: string; currentWorkspaceCheckpointWatermark?: number };
    };

    assert.equal(explain.freshnessStatus, "unknown");
    assert.equal(explain.freshnessEvidence?.reason, "workspace-watermark-missing");
    assert.equal(explain.freshnessEvidence?.scope, "workspace-checkpoint-watermark");
    assert.equal(explain.freshnessEvidence?.currentWorkspaceCheckpointWatermark, 2);
  });

  it("recalls PageIndex turns with explicit session scope provenance", async () => {
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["database scoped recall\n/palette recall --scope session database\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        scope?: string;
        indexedCount?: number;
        matchedCount?: number;
        item?: {
          target?: { kind?: string; metadata?: { scope?: string } };
          metadata?: { scope?: string };
        };
      };
    });
    const recallSummary = records.find((record) => record.kind === "chat.command.palette-recall" && record.record?.kind === "palette.recall")?.record;
    const recallItem = records.find((record) => record.kind === "chat.command.palette-recall" && record.record?.kind === "palette.recall.item")?.record;

    assert.equal(records.filter((record) => record.kind === "model.requested").length, 1);
    assert.equal(recallSummary?.scope, "session");
    assert.equal(recallSummary?.indexedCount, 1);
    assert.equal(recallSummary?.matchedCount, 1);
    assert.equal(recallItem?.item?.target?.kind, "turn");
    assert.equal(recallItem?.item?.target?.metadata?.scope, "session");
    assert.equal(recallItem?.item?.metadata?.scope, "session");
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("marks chat PageIndex recall stale after a later core file write", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new WritingThenCapturingModelGateway();
    const toolDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(toolDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(toolDeps);
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["database schema baseline\nwrite app\n/palette recall database\n/palette recall explain current\n/palette refs add current\n/palette refs list\ncontinue from stale recall\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        workspaceRoot: "/workspace",
        createRuntime: async () => ({ deps: toolDeps, kernel })
      }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        ok?: boolean;
        freshnessStatus?: string;
        freshnessEvidence?: { reason?: string; scope?: string; staleMutationTurnId?: string; workspaceCheckpointWatermark?: number; currentWorkspaceCheckpointWatermark?: number };
        item?: {
          kind?: string;
          target?: { kind?: string; metadata?: { freshnessStatus?: string; freshnessEvidence?: { reason?: string; scope?: string; staleMutationTurnId?: string }; promptPreview?: string } };
          metadata?: { freshnessStatus?: string; freshnessEvidence?: { reason?: string; scope?: string; staleMutationTurnId?: string } };
        };
      };
    });
    const recallItem = records.find((record) => record.kind === "chat.command.palette-recall" && record.record?.kind === "palette.recall.item")?.record;
    const explain = records.find((record) => record.kind === "chat.command.palette-recall-explain" && record.record?.kind === "palette.recall.explain")?.record;
    const referenceItem = records.find((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.item" && record.record.item?.kind === "turn")?.record?.item;
    const finalRequest = gateway.requests.at(-1);

    assert.equal(toolDeps.workspaceState.checkpoints().length, 1);
    assert.equal(recallItem?.item?.target?.kind, "turn");
    assert.equal(recallItem?.item?.target?.metadata?.promptPreview, "database schema baseline");
    assert.equal(recallItem?.item?.target?.metadata?.freshnessStatus, "stale");
    assert.equal(recallItem?.item?.target?.metadata?.freshnessEvidence?.reason, "workspace-edit-after-page");
    assert.equal(recallItem?.item?.target?.metadata?.freshnessEvidence?.scope, "session-turn-order");
    assert.equal(recallItem?.item?.metadata?.freshnessStatus, "stale");
    assert.equal(explain?.freshnessStatus, "stale");
    assert.equal(explain?.freshnessEvidence?.reason, "workspace-edit-after-page");
    assert.equal(typeof explain?.freshnessEvidence?.staleMutationTurnId, "string");
    assert.equal(referenceItem?.target?.metadata?.freshnessStatus, "stale");
    assert.equal(referenceItem?.target?.metadata?.freshnessEvidence?.reason, "workspace-edit-after-page");
    assert.equal(records.filter((record) => record.kind === "model.requested").length, 4);
    assert.equal(finalRequest?.messages?.some((message) => message.role === "system" && message.content.includes("Evidence: createdAt=1970-01-01T00:00:00.000Z freshness=stale")), true);
    assert.equal(finalRequest?.messages?.some((message) => message.role === "system" && message.content.includes("Freshness evidence: reason=workspace-edit-after-page scope=session-turn-order")), true);
    assert.equal(lines.join("\n").includes("\u001b["), false);
    await kernel.shutdown("cli-test-pageindex-stale-after-file-write");
  });

  it("recalls workspace PageIndex turns across chat sessions", async () => {
    const workspaceRoot = "/workspace";
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const deps = { ...createDeterministicRuntimeDependencies(), platform };
    await registerRuntimeCoreTools(deps, workspaceRoot);
    const firstKernel = await createDefaultRuntimeKernel(deps);
    const firstLines: string[] = [];
    const longHiddenSuffix = "workspace-pageindex-hidden-".repeat(12);
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        firstLines.push(line);
      },
      [`database workspace memory ${longHiddenSuffix}\n/exit\n`],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel: firstKernel })
      }
    );
    const metadata = platform.workspaceMetadataPath(process.cwd(), "deepseek");
    assert.equal(metadata.ok, true);
    const metadataDir = platform.resolvePath(platform.resolvePath(metadata.value ?? "", ".."), "pageindex.json");
    const stored = JSON.parse(await platform.readFile(metadataDir)) as {
      kind?: string;
      pageCount?: number;
      pages?: readonly { scope?: string; promptPreview?: string; evidenceQuality?: { workspaceCheckpointWatermark?: number } }[];
    };

    assert.equal(stored.kind, "chat.pageindex.workspace");
    assert.equal(stored.pageCount, 1);
    assert.equal(stored.pages?.[0]?.scope, "workspace");
    assert.equal(stored.pages?.[0]?.evidenceQuality?.workspaceCheckpointWatermark, 0);
    assert.equal((stored.pages?.[0]?.promptPreview?.length ?? 0) <= 160, true);
    assert.equal(JSON.stringify(stored).includes(longHiddenSuffix), false);

    const secondKernel = await createDefaultRuntimeKernel(deps);
    const secondLines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        secondLines.push(line);
      },
      ["/palette recall --scope workspace database\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel: secondKernel })
      }
    );
    const records = secondLines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        scope?: string;
        indexedCount?: number;
        matchedCount?: number;
        item?: {
          target?: { kind?: string; metadata?: { scope?: string; promptPreview?: string } };
          metadata?: { scope?: string; promptPreview?: string };
        };
      };
    });
    const recallSummary = records.find((record) => record.kind === "chat.command.palette-recall" && record.record?.kind === "palette.recall")?.record;
    const recallItem = records.find((record) => record.kind === "chat.command.palette-recall" && record.record?.kind === "palette.recall.item")?.record;

    assert.equal(records.some((record) => record.kind === "model.requested"), false);
    assert.equal(recallSummary?.scope, "workspace");
    assert.equal(recallSummary?.indexedCount, 1);
    assert.equal(recallSummary?.matchedCount, 1);
    assert.equal(recallItem?.item?.target?.kind, "turn");
    assert.equal(recallItem?.item?.target?.metadata?.scope, "workspace");
    assert.equal(recallItem?.item?.metadata?.scope, "workspace");
    assert.equal(JSON.stringify(records).includes(longHiddenSuffix), false);
    assert.equal(secondLines.join("\n").includes("\u001b["), false);
    await firstKernel.shutdown("cli-workspace-pageindex-first");
    await secondKernel.shutdown("cli-workspace-pageindex-second");
  });

  it("marks prior workspace PageIndex recall stale after a later session writes the workspace", async () => {
    const workspaceRoot = "/workspace";
    const platform = new FakePlatformRuntime("fake", workspaceRoot);
    const gateway = new WritingThenCapturingModelGateway();
    const deps = { ...createDeterministicRuntimeDependencies(), models: gateway, platform, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(deps, workspaceRoot);
    const firstKernel = await createDefaultRuntimeKernel(deps);
    const firstLines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        firstLines.push(line);
      },
      ["database workspace watermark baseline\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel: firstKernel })
      }
    );

    const secondKernel = await createDefaultRuntimeKernel(deps);
    const secondLines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        secondLines.push(line);
      },
      ["write app\n/palette recall --scope workspace database\n/palette recall explain current\n/palette refs add current\n/palette refs list\ncontinue from stale workspace recall\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel: secondKernel })
      }
    );
    const records = secondLines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        freshnessStatus?: string;
        freshnessEvidence?: { reason?: string; scope?: string; workspaceCheckpointWatermark?: number; currentWorkspaceCheckpointWatermark?: number };
        item?: {
          kind?: string;
          target?: { kind?: string; metadata?: { scope?: string; freshnessStatus?: string; freshnessEvidence?: { reason?: string; scope?: string; workspaceCheckpointWatermark?: number; currentWorkspaceCheckpointWatermark?: number }; promptPreview?: string; evidenceQuality?: { workspaceCheckpointWatermark?: number } } };
          metadata?: { freshnessStatus?: string; freshnessEvidence?: { reason?: string; scope?: string; workspaceCheckpointWatermark?: number; currentWorkspaceCheckpointWatermark?: number }; evidenceQuality?: { workspaceCheckpointWatermark?: number } };
        };
      };
    });
    const recallItem = records.find((record) => record.kind === "chat.command.palette-recall" && record.record?.kind === "palette.recall.item")?.record;
    const explain = records.find((record) => record.kind === "chat.command.palette-recall-explain" && record.record?.kind === "palette.recall.explain")?.record;
    const referenceItem = records.find((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.item" && record.record.item?.kind === "turn")?.record?.item;
    const finalRequest = gateway.requests.at(-1);

    assert.equal(deps.workspaceState.checkpoints().length, 1);
    assert.equal(recallItem?.item?.target?.metadata?.scope, "workspace");
    assert.equal(recallItem?.item?.target?.metadata?.promptPreview, "database workspace watermark baseline");
    assert.equal(recallItem?.item?.target?.metadata?.freshnessStatus, "stale");
    assert.equal(recallItem?.item?.target?.metadata?.freshnessEvidence?.reason, "workspace-checkpoint-watermark-advanced");
    assert.equal(recallItem?.item?.target?.metadata?.freshnessEvidence?.workspaceCheckpointWatermark, 0);
    assert.equal(recallItem?.item?.target?.metadata?.freshnessEvidence?.currentWorkspaceCheckpointWatermark, 1);
    assert.equal(recallItem?.item?.target?.metadata?.evidenceQuality?.workspaceCheckpointWatermark, 0);
    assert.equal(recallItem?.item?.metadata?.freshnessStatus, "stale");
    assert.equal(explain?.freshnessStatus, "stale");
    assert.equal(explain?.freshnessEvidence?.reason, "workspace-checkpoint-watermark-advanced");
    assert.equal(explain?.freshnessEvidence?.currentWorkspaceCheckpointWatermark, 1);
    assert.equal(referenceItem?.target?.metadata?.freshnessStatus, "stale");
    assert.equal(referenceItem?.target?.metadata?.freshnessEvidence?.reason, "workspace-checkpoint-watermark-advanced");
    assert.equal(finalRequest?.messages?.some((message) => message.role === "system" && message.content.includes("Source: scope=workspace")), true);
    assert.equal(finalRequest?.messages?.some((message) => message.role === "system" && message.content.includes("freshness=stale")), true);
    assert.equal(finalRequest?.messages?.some((message) => message.role === "system" && message.content.includes("Freshness evidence: reason=workspace-checkpoint-watermark-advanced scope=workspace-checkpoint-watermark workspaceCheckpointWatermark=0 currentWorkspaceCheckpointWatermark=1")), true);
    assert.equal(secondLines.join("\n").includes("\u001b["), false);
    await firstKernel.shutdown("cli-workspace-pageindex-watermark-first");
    await secondKernel.shutdown("cli-workspace-pageindex-watermark-second");
  });

  it("defers global PageIndex recall scope locally without workspace fallback", async () => {
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["database scoped recall\n/palette recall --scope global database\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        requestedScope?: string;
        code?: string;
        availableScopes?: readonly string[];
      };
    });
    const deferredRecords = records.filter((record) => record.kind === "chat.command.palette-recall.deferred" && record.record?.kind === "palette.recall.deferred");

    assert.equal(records.filter((record) => record.kind === "model.requested").length, 1);
    assert.equal(deferredRecords.length, 1);
    assert.equal(deferredRecords.some((record) => record.record?.requestedScope === "global"), true);
    assert.equal(deferredRecords.every((record) => record.record?.code === "CLI_PALETTE_RECALL_SCOPE_DEFERRED"), true);
    assert.equal(deferredRecords.every((record) => record.record?.availableScopes?.includes("session")), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-recall" && record.record?.kind === "palette.recall.item"), false);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("keeps invalid PageIndex recall scopes local", async () => {
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/palette recall --scope project database\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as { kind?: string; command?: string; code?: string });

    assert.equal(records.some((record) => record.kind === "chat.command.local-failure" && record.command === "palette" && record.code === "CLI_PALETTE_RECALL_SCOPE_INVALID"), true);
    assert.equal(records.some((record) => record.kind === "model.requested"), false);
  });

  it("keeps workspace PageIndex storage failures local without session fallback", async () => {
    const workspaceRoot = "/workspace";
    const platform = new FakePlatformRuntime("fake", workspaceRoot, { readOnlyFilesystem: true });
    const deps = { ...createDeterministicRuntimeDependencies(), platform };
    const kernel = await createDefaultRuntimeKernel(deps);
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["database session-only fallback check\n/palette recall --scope workspace database\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel })
      }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: { kind?: string; code?: string; item?: unknown };
    });

    assert.equal(records.filter((record) => record.kind === "model.requested").length, 1);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-recall.workspace-failure" && record.record?.kind === "palette.recall.workspace.failure" && record.record.code === "CLI_PAGEINDEX_WORKSPACE_WRITE_FAILED"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.palette-recall" && record.record?.kind === "palette.recall.item"), false);
    assert.equal(lines.join("\n").includes("\u001b["), false);
    await kernel.shutdown("cli-workspace-pageindex-storage-failure");
  });

  it("keeps missing PageIndex recall scope values local", async () => {
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/palette recall --scope\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as { kind?: string; command?: string; code?: string });

    assert.equal(records.some((record) => record.kind === "chat.command.local-failure" && record.command === "palette" && record.code === "CLI_PALETTE_RECALL_SCOPE_REQUIRED"), true);
    assert.equal(records.some((record) => record.kind === "model.requested"), false);
  });

  it("persists and restores chat PageIndex pages through session snapshots", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, process.cwd());
    const firstKernel = await createDefaultRuntimeKernel(deps);
    const firstLines: string[] = [];
    const longHiddenSuffix = "pageindex-snapshot-hidden-".repeat(12);
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        firstLines.push(line);
      },
      [`database auth snapshot ${longHiddenSuffix}\n/exit\n`],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel: firstKernel })
      }
    );
    const firstRecords = firstLines.map((line) => JSON.parse(line) as { kind?: string; sessionId?: string });
    const sessionId = firstRecords.find((record) => record.kind === "agent.loop.completed")?.sessionId;
    assert.equal(typeof sessionId, "string");
    const resumed = await deps.sessions.resume(asId<"session">(sessionId ?? ""));
    const snapshot = resumed.value?.snapshot?.payload as { kind?: string; pageCount?: number; pages?: readonly { scope?: string; promptPreview?: string }[] } | undefined;

    assert.equal(resumed.ok, true);
    assert.equal(snapshot?.kind, "chat.pageindex.snapshot");
    assert.equal(snapshot?.pageCount, 1);
    assert.equal(snapshot?.pages?.[0]?.scope, "session");
    assert.equal((snapshot?.pages?.[0]?.promptPreview?.length ?? 0) <= 160, true);
    assert.equal(JSON.stringify(snapshot).includes(longHiddenSuffix), false);

    const secondKernel = await createDefaultRuntimeKernel(deps);
    const secondLines: string[] = [];
    await runCli(
      ["chat", "--session", sessionId ?? "", "--output", "jsonl"],
      (line: string) => {
        secondLines.push(line);
      },
      ["/palette recall database\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel: secondKernel })
      }
    );
    const secondRecords = secondLines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        scope?: string;
        indexedCount?: number;
        matchedCount?: number;
        item?: { target?: { kind?: string; sessionId?: string; metadata?: { scope?: string; promptPreview?: string } } };
      };
    });
    const recallSummary = secondRecords.find((record) => record.kind === "chat.command.palette-recall" && record.record?.kind === "palette.recall")?.record;
    const recallItem = secondRecords.find((record) => record.kind === "chat.command.palette-recall" && record.record?.kind === "palette.recall.item")?.record;

    assert.equal(secondRecords.some((record) => record.kind === "model.requested"), false);
    assert.equal(recallSummary?.indexedCount, 1);
    assert.equal(recallSummary?.matchedCount, 1);
    assert.equal(recallSummary?.scope, "session");
    assert.equal(recallItem?.item?.target?.kind, "turn");
    assert.equal(recallItem?.item?.target?.sessionId, sessionId);
    assert.equal(recallItem?.item?.target?.metadata?.scope, "session");
    assert.equal(JSON.stringify(secondRecords).includes(longHiddenSuffix), false);
    assert.equal(secondLines.join("\n").includes("\u001b["), false);
    await firstKernel.shutdown("cli-pageindex-snapshot-first");
    await secondKernel.shutdown("cli-pageindex-snapshot-second");
  });

  it("fails explicit chat session resume locally without model submission", async () => {
    const lines: string[] = [];
    const deps = createDeterministicRuntimeDependencies();
    const kernel = await createDefaultRuntimeKernel(deps);
    await runCli(
      ["chat", "--session", "session-missing", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/palette recall database\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel })
      }
    );
    const records = lines.map((line) => JSON.parse(line) as { kind?: string; command?: string; code?: string });

    assert.equal(records.some((record) => record.kind === "chat.command.local-failure" && record.command === "session" && record.code === "SESSION_NOT_FOUND"), true);
    assert.equal(records.some((record) => record.kind === "model.requested"), false);
    await kernel.shutdown("cli-pageindex-missing-session");
  });

  it("projects selected PageIndex recall references on the next prompt", async () => {
    const lines: string[] = [];
    const gateway = new CapturingModelGateway();
    const deps = { ...createDeterministicRuntimeDependencies(), models: gateway };
    const kernel = await createDefaultRuntimeKernel(deps);
    const longHiddenSuffix = "recall-projection-hidden-".repeat(12);
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      [`database auth decision ${longHiddenSuffix}\nrenderer layout decision\n/palette recall database\n/palette refs add current\n/palette refs list\ncontinue from recall\n/exit\n`],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel })
      }
    );
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        item?: { kind?: string; target?: { kind?: string; metadata?: { pageId?: string; promptPreview?: string; matchedFields?: readonly string[]; freshnessStatus?: string } } };
      };
      data?: {
        contextProjection?: {
          selectedNodeCount?: number;
          referenceEvidence?: { resolvedReferenceCount?: number; unresolvedReferences?: readonly unknown[] };
        };
        referenceContext?: { itemCount?: number; targets?: readonly { targetKind?: string; targetId?: string }[] };
      };
    });
    const finalModelRequest = gateway.requests.at(-1);
    const finalModelRequested = records.filter((record) => record.kind === "model.requested").at(-1);
    const recallReferenceItem = records.find((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.item" && record.record.item?.kind === "turn")?.record?.item;
    const serializedRecallRecords = records
      .filter((record) => record.kind === "chat.command.palette-recall" || record.kind === "chat.command.palette-refs")
      .map((record) => JSON.stringify(record))
      .join("\n");

    assert.equal(records.filter((record) => record.kind === "model.requested").length, 3);
    assert.equal(recallReferenceItem?.target?.kind, "turn");
    assert.equal(typeof recallReferenceItem?.target?.metadata?.pageId, "string");
    assert.deepEqual(recallReferenceItem?.target?.metadata?.matchedFields, ["promptPreview"]);
    assert.equal(recallReferenceItem?.target?.metadata?.freshnessStatus, "fresh");
    assert.equal(finalModelRequested?.data?.referenceContext?.itemCount, 1);
    assert.equal(finalModelRequested?.data?.contextProjection?.referenceEvidence?.resolvedReferenceCount, 1);
    assert.equal(finalModelRequested?.data?.contextProjection?.referenceEvidence?.unresolvedReferences?.length, 0);
    const recallContextMessage = requestSystemMessageIncluding(finalModelRequest, "PageIndex recall");
    assert.equal(recallContextMessage?.content.includes("Usage: Treat this as historical recall evidence; verify against current workspace state before relying on it because it may be stale or incomplete."), true);
    assert.equal(recallContextMessage?.content.includes("Evidence: createdAt=1970-01-01T00:00:00.000Z freshness=fresh matchedFields=promptPreview rankingReason=deterministic-text-match"), true);
    assert.equal(recallContextMessage?.content.includes("User prompt preview: database auth decision"), true);
    assert.equal(recallContextMessage?.content.includes("Assistant preview:"), true);
    assert.equal(requestUserMessage(finalModelRequest, "continue from recall")?.content, "continue from recall");
    assert.equal(finalModelRequest?.prompt.includes("user: continue from recall"), true);
    assert.equal(serializedRecallRecords.includes(longHiddenSuffix), false);
    assert.equal(lines.join("\n").includes("\u001b["), false);
    await kernel.shutdown("cli-test-pageindex-recall-reference-projection");
  });

  it("projects workspace PageIndex recall references across chat sessions", async () => {
    const platform = new FakePlatformRuntime("fake", "/workspace");
    const gateway = new CapturingModelGateway();
    const deps = { ...createDeterministicRuntimeDependencies(), models: gateway, platform };
    await registerRuntimeCoreTools(deps, process.cwd());
    const firstKernel = await createDefaultRuntimeKernel(deps);
    const firstLines: string[] = [];
    const longHiddenSuffix = "workspace-recall-projection-hidden-".repeat(12);
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        firstLines.push(line);
      },
      [`database workspace durable note ${longHiddenSuffix}\n/exit\n`],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel: firstKernel })
      }
    );

    const secondKernel = await createDefaultRuntimeKernel(deps);
    const secondLines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        secondLines.push(line);
      },
      ["/palette recall --scope workspace database\n/palette refs add current\n/palette refs list\ncontinue from workspace recall\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel: secondKernel })
      }
    );
    const records = secondLines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        scope?: string;
        item?: {
          kind?: string;
          target?: { kind?: string; metadata?: { scope?: string; pageId?: string; promptPreview?: string; matchedFields?: readonly string[]; freshnessStatus?: string } };
        };
      };
      data?: {
        contextProjection?: {
          referenceEvidence?: { resolvedReferenceCount?: number; unresolvedReferences?: readonly unknown[] };
        };
        referenceContext?: { itemCount?: number; targets?: readonly { targetKind?: string; targetId?: string }[] };
      };
    });
    const finalModelRequest = gateway.requests.at(-1);
    const finalModelRequested = records.filter((record) => record.kind === "model.requested").at(-1);
    const recallReferenceItem = records.find((record) => record.kind === "chat.command.palette-refs" && record.record?.kind === "palette.reference.item" && record.record.item?.kind === "turn")?.record?.item;
    const serializedLocalRecords = records
      .filter((record) => record.kind === "chat.command.palette-recall" || record.kind === "chat.command.palette-refs")
      .map((record) => JSON.stringify(record))
      .join("\n");

    assert.equal(gateway.requests.length, 2);
    assert.equal(records.filter((record) => record.kind === "model.requested").length, 1);
    assert.equal(recallReferenceItem?.target?.kind, "turn");
    assert.equal(recallReferenceItem?.target?.metadata?.scope, "workspace");
    assert.equal(typeof recallReferenceItem?.target?.metadata?.pageId, "string");
    assert.deepEqual(recallReferenceItem?.target?.metadata?.matchedFields, ["promptPreview"]);
    assert.equal(recallReferenceItem?.target?.metadata?.freshnessStatus, "fresh");
    assert.equal(finalModelRequested?.data?.referenceContext?.itemCount, 1);
    assert.equal(finalModelRequested?.data?.contextProjection?.referenceEvidence?.resolvedReferenceCount, 1);
    assert.equal(finalModelRequested?.data?.contextProjection?.referenceEvidence?.unresolvedReferences?.length, 0);
    const workspaceRecallContextMessage = requestSystemMessageIncluding(finalModelRequest, "PageIndex recall");
    assert.equal(workspaceRecallContextMessage?.content.includes("Usage: Treat this as historical recall evidence; verify against current workspace state before relying on it because it may be stale or incomplete."), true);
    assert.equal(workspaceRecallContextMessage?.content.includes("Source: scope=workspace"), true);
    assert.equal(workspaceRecallContextMessage?.content.includes("Evidence: createdAt=1970-01-01T00:00:00.000Z freshness=fresh matchedFields=promptPreview rankingReason=deterministic-text-match"), true);
    assert.equal(workspaceRecallContextMessage?.content.includes("User prompt preview: database workspace durable note"), true);
    assert.equal(requestUserMessage(finalModelRequest, "continue from workspace recall")?.content, "continue from workspace recall");
    assert.equal(finalModelRequest?.prompt.includes("user: continue from workspace recall"), true);
    assert.equal(serializedLocalRecords.includes(longHiddenSuffix), false);
    assert.equal(secondLines.join("\n").includes("\u001b["), false);
    await firstKernel.shutdown("cli-test-workspace-pageindex-reference-first");
    await secondKernel.shutdown("cli-test-workspace-pageindex-reference-second");
  });

  it("keeps empty PageIndex recall queries local", async () => {
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/palette recall\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as { kind?: string; command?: string; code?: string });

    assert.equal(records.some((record) => record.kind === "chat.command.local-failure" && record.command === "palette" && record.code === "CLI_PALETTE_RECALL_QUERY_REQUIRED"), true);
    assert.equal(records.some((record) => record.kind === "model.requested"), false);
  });

  it("keeps empty history current failures local", async () => {
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/history select current\n/revert preview current\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as { kind?: string; command?: string; code?: string });

    assert.equal(records.some((record) => record.kind === "chat.command.local-failure" && record.command === "history" && record.code === "CLI_HISTORY_TARGET_NOT_FOUND"), true);
    assert.equal(records.some((record) => record.kind === "chat.command.local-failure" && record.command === "revert" && record.code === "CLI_REVERT_CURRENT_UNAVAILABLE"), true);
    assert.equal(records.some((record) => record.kind === "model.requested"), false);
  });

  it("previews injected workspace revert without mutating files or checkpoints", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const workspaceRoot = "/workspace";
    const path = `${workspaceRoot}/app.ts`;
    await deps.platform.writeFile(path, "after");
    const transaction: WorkspaceEditTransaction = {
      id: "tx-revert-preview",
      sessionId: asId<"session">("session-revert-preview"),
      turnId: asId<"turn">("turn-revert-preview"),
      requestId: "request-revert-preview",
      edits: [{
        applied: true,
        path,
        beforeHash: "00000001",
        afterHash: "00000002",
        precondition: "exact"
      }],
      rollback: {
        content: "before",
        contentHash: "00000001"
      }
    };
    await deps.workspaceState.transact(transaction);
    const kernel = await createDefaultRuntimeKernel(deps);
    const lines: string[] = [];

    await runCli(
      ["revert", "preview", "--request", "request-revert-preview", "--output", "json"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel })
      }
    );

    const preview = JSON.parse(lines[0] ?? "{}") as {
      ok?: boolean;
      status?: string;
      result?: { affectedCheckpointIds?: readonly string[]; affectedPaths?: readonly string[] };
    };
    assert.equal(preview.ok, true);
    assert.equal(preview.status, "preview");
    assert.equal(preview.result?.affectedCheckpointIds?.length, 1);
    assert.equal(preview.result?.affectedPaths?.[0], path);
    assert.equal(await deps.platform.readFile(path), "after");
    assert.equal(deps.workspaceState.checkpoints()[0]?.status, "eligible");
    await kernel.shutdown("cli-test-revert-preview");
  });

  it("applies injected workspace revert through checkpoint safety checks", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const workspaceRoot = "/workspace";
    const path = `${workspaceRoot}/app.ts`;
    await deps.platform.writeFile(path, "after");
    const transaction: WorkspaceEditTransaction = {
      id: "tx-revert-apply",
      sessionId: asId<"session">("session-revert-apply"),
      turnId: asId<"turn">("turn-revert-apply"),
      requestId: "request-revert-apply",
      edits: [{
        applied: true,
        path,
        beforeHash: hashTextForTest("before"),
        afterHash: hashTextForTest("after"),
        precondition: "exact"
      }],
      rollback: {
        content: "before",
        contentHash: hashTextForTest("before")
      }
    };
    await deps.workspaceState.transact(transaction);
    const kernel = await createDefaultRuntimeKernel(deps);
    const lines: string[] = [];

    await runCli(
      ["revert", "apply", "--request", "request-revert-apply", "--output", "json"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel })
      }
    );

    const applied = JSON.parse(lines[0] ?? "{}") as {
      kind?: string;
      ok?: boolean;
      dryRun?: boolean;
      status?: string;
      result?: { restoredPaths?: readonly string[] };
    };
    assert.equal(applied.kind, "revert.apply");
    assert.equal(applied.ok, true);
    assert.equal(applied.dryRun, false);
    assert.equal(applied.status, "restored");
    assert.equal(applied.result?.restoredPaths?.[0], path);
    assert.equal(await deps.platform.readFile(path), "before");
    assert.equal(deps.workspaceState.checkpoints()[0]?.status, "restored");
    const serialized = lines.join("\n");
    assert.equal(serialized.includes('"content":"before"'), false);
    assert.equal(serialized.includes('"privateContent":"before"'), false);
    await kernel.shutdown("cli-test-revert-apply");
  });

  it("rejects stale workspace revert apply without mutating files or checkpoints", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const workspaceRoot = "/workspace";
    const path = `${workspaceRoot}/app.ts`;
    await deps.platform.writeFile(path, "after");
    const transaction: WorkspaceEditTransaction = {
      id: "tx-revert-stale",
      sessionId: asId<"session">("session-revert-stale"),
      turnId: asId<"turn">("turn-revert-stale"),
      requestId: "request-revert-stale",
      edits: [{
        applied: true,
        path,
        beforeHash: hashTextForTest("before"),
        afterHash: hashTextForTest("after"),
        precondition: "exact"
      }],
      rollback: {
        content: "before",
        contentHash: hashTextForTest("before")
      }
    };
    await deps.workspaceState.transact(transaction);
    await deps.platform.writeFile(path, "changed-after-checkpoint");
    const kernel = await createDefaultRuntimeKernel(deps);
    const lines: string[] = [];

    await runCli(
      ["revert", "apply", "--request", "request-revert-stale", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel })
      }
    );

    const records = lines.map((line) => JSON.parse(line) as { kind?: string; ok?: boolean; status?: string; diagnostic?: { code?: string } });
    assert.equal(records[0]?.kind, "revert.apply.summary");
    assert.equal(records[0]?.ok, false);
    assert.equal(records[0]?.status, "rejected");
    assert.equal(records.some((record) => record.kind === "revert.apply.diagnostic" && record.diagnostic?.code === "CHECKPOINT_STALE_FILE"), true);
    assert.equal(await deps.platform.readFile(path), "changed-after-checkpoint");
    assert.equal(deps.workspaceState.checkpoints()[0]?.status, "eligible");
    await kernel.shutdown("cli-test-revert-stale");
  });

  it("applies chat current revert locally through selected history", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const toolDeps = { ...deps, models: new WritingToolModelGateway(), policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(toolDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(toolDeps);
    const lines: string[] = [];

    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["write app\n/revert apply current\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        workspaceRoot: "/workspace",
        createRuntime: async () => ({ deps: toolDeps, kernel })
      }
    );

    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      turnId?: string;
      record?: {
        kind?: string;
        ok?: boolean;
        dryRun?: boolean;
        status?: string;
        target?: { turnId?: string; sessionId?: string };
        restoredPathCount?: number;
      };
    });
    const completed = records.find((record) => record.kind === "agent.loop.completed");
    const applySummary = records.find((record) => record.kind === "chat.command.revert-apply" && record.record?.kind === "revert.apply.summary");

    assert.equal(Boolean(completed), true);
    assert.equal(applySummary?.record?.ok, true);
    assert.equal(applySummary?.record?.dryRun, false);
    assert.equal(applySummary?.record?.status, "restored");
    assert.equal(applySummary?.record?.target?.turnId, completed?.turnId);
    assert.equal(applySummary?.record?.restoredPathCount, 1);
    assert.equal(await toolDeps.platform.readFile("/workspace/app.ts"), "");
    assert.equal(toolDeps.workspaceState.checkpoints()[0]?.status, "restored");
    assert.equal(records.filter((record) => record.kind === "model.requested").length, 2);
    assert.equal(lines.join("\n").includes("\u001b["), false);
    await kernel.shutdown("cli-test-chat-revert-apply");
  });

  it("reviews and confirms chat current revert locally", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const toolDeps = { ...deps, models: new WritingToolModelGateway(), policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(toolDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(toolDeps);
    const lines: string[] = [];

    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["write app\n/revert review current\n/revert confirm current\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        workspaceRoot: "/workspace",
        createRuntime: async () => ({ deps: toolDeps, kernel })
      }
    );

    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      turnId?: string;
      command?: string;
      code?: string;
      record?: {
        kind?: string;
        reviewId?: string;
        ok?: boolean;
        dryRun?: boolean;
        status?: string;
        target?: { turnId?: string; sessionId?: string };
        affectedCheckpointCount?: number;
        restoredPathCount?: number;
      };
    });
    const completed = records.find((record) => record.kind === "agent.loop.completed");
    const review = records.find((record) => record.kind === "chat.command.revert-review" && record.record?.kind === "revert.review");
    const confirm = records.find((record) => record.kind === "chat.command.revert-confirm" && record.record?.kind === "revert.confirm");

    assert.equal(review?.record?.reviewId, "review-1");
    assert.equal(review?.record?.ok, true);
    assert.equal(review?.record?.dryRun, true);
    assert.equal(review?.record?.status, "preview");
    assert.equal(review?.record?.target?.turnId, completed?.turnId);
    assert.equal(review?.record?.affectedCheckpointCount, 1);
    assert.equal(confirm?.record?.reviewId, "review-1");
    assert.equal(confirm?.record?.ok, true);
    assert.equal(confirm?.record?.dryRun, false);
    assert.equal(confirm?.record?.status, "restored");
    assert.equal(confirm?.record?.restoredPathCount, 1);
    assert.equal(await toolDeps.platform.readFile("/workspace/app.ts"), "");
    assert.equal(toolDeps.workspaceState.checkpoints()[0]?.status, "restored");
    assert.equal(records.filter((record) => record.kind === "model.requested").length, 2);
    assert.equal(records.some((record) => record.kind === "chat.command.local-failure"), false);
    assert.equal(lines.join("\n").includes("\u001b["), false);
    await kernel.shutdown("cli-test-chat-revert-review-confirm");
  });

  it("keeps revert confirm without review as a local typed failure", async () => {
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["/revert confirm current\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const records = lines.map((line) => JSON.parse(line) as { kind?: string; command?: string; code?: string });

    assert.equal(records.some((record) => record.kind === "chat.command.local-failure" && record.command === "revert" && record.code === "CLI_REVERT_REVIEW_NOT_FOUND"), true);
    assert.equal(records.some((record) => record.kind === "model.requested"), false);
  });

  it("rejects stale revert confirm after review without mutating files or checkpoints", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const toolDeps = { ...deps, models: new WritingToolModelGateway(), policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(toolDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(toolDeps);
    const lines: string[] = [];
    let staleInjected = false;

    await runCli(
      ["chat", "--output", "jsonl"],
      async (line: string) => {
        lines.push(line);
        const record = JSON.parse(line) as { kind?: string; record?: { kind?: string } };
        if (!staleInjected && record.kind === "chat.command.revert-review" && record.record?.kind === "revert.review") {
          staleInjected = true;
          await toolDeps.platform.writeFile("/workspace/app.ts", "changed-after-review");
        }
      },
      ["write app\n/revert review current\n/revert confirm current\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        workspaceRoot: "/workspace",
        createRuntime: async () => ({ deps: toolDeps, kernel })
      }
    );

    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      record?: {
        kind?: string;
        ok?: boolean;
        status?: string;
        stalePathCount?: number;
        diagnostic?: { code?: string };
      };
    });
    const confirm = records.find((record) => record.kind === "chat.command.revert-confirm" && record.record?.kind === "revert.confirm");

    assert.equal(staleInjected, true);
    assert.equal(confirm?.record?.ok, false);
    assert.equal(confirm?.record?.status, "rejected");
    assert.equal(confirm?.record?.stalePathCount, 1);
    assert.equal(records.some((record) => record.kind === "chat.command.revert-confirm" && record.record?.kind === "revert.confirm.diagnostic" && record.record.diagnostic?.code === "CHECKPOINT_STALE_FILE"), true);
    assert.equal(await toolDeps.platform.readFile("/workspace/app.ts"), "changed-after-review");
    assert.equal(toolDeps.workspaceState.checkpoints()[0]?.status, "eligible");
    assert.equal(records.filter((record) => record.kind === "model.requested").length, 2);
    await kernel.shutdown("cli-test-chat-revert-stale-confirm");
  });

  it("lists palette slash controls in chat help", async () => {
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "text"],
      (line: string) => {
        lines.push(line);
      },
      ["/help\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );
    const output = lines.join("\n");

    assert.equal(output.includes("/file list|preview|refs <query>"), true);
    assert.equal(output.includes("/jump file|text|symbol <query>"), true);
    assert.equal(output.includes("/palette"), true);
    assert.equal(output.includes("/palette next|previous|first|last"), true);
    assert.equal(output.includes("/palette back|forward"), true);
    assert.equal(output.includes("/palette recall <query>"), true);
    assert.equal(output.includes("/palette refs add <target-id|current>"), true);
    assert.equal(output.includes("/palette refs list"), true);
    assert.equal(output.includes("/palette refs focus <ref-id|index|target-id|current>"), true);
    assert.equal(output.includes("/palette state"), true);
    assert.equal(output.includes("/palette action <action> <target-id>"), true);
    assert.equal(output.includes("/keymap [core|vi-minimal]"), true);
    assert.equal(output.includes("/revert preview --request <id>|--turn <id>|--session <id>"), true);
    assert.equal(output.includes("/revert preview current"), true);
    assert.equal(output.includes("/revert review current"), true);
    assert.equal(output.includes("/revert confirm <review-id|current>"), true);
    assert.equal(output.includes("/revert apply current"), true);
    assert.equal(output.includes("/history select <turn-id|index|current|last>"), true);
    assert.equal(output.includes("DeepSeek mock response"), false);
  });

  it("keeps scripted, non-TTY, JSON, and JSONL chat output free of workbench frames", async () => {
    const textLines: string[] = [];
    await runCli(
      ["chat", "--output", "text"],
      (line: string) => {
        textLines.push(line);
      },
      ["/help\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false }
    );

    assert.equal(textLines.some((line) => line.startsWith("DeepSeek Workbench")), false);
    assert.equal(textLines.some((line) => line.includes("deepseek> ")), false);
    assert.equal(textLines.some((line) => line === "Chat controls:"), true);

    for (const output of ["json", "jsonl"] as const) {
      const lines: string[] = [];
      await runCli(
        ["chat", "--output", output],
        (line: string) => {
          lines.push(line);
        },
        ["/help\n/exit\n"],
        { stdinIsTTY: false, stdoutIsTTY: false }
      );
      assert.equal(lines.some((line) => line.startsWith("DeepSeek Workbench")), false);
      assert.equal(lines.some((line) => line.includes("deepseek> ")), false);
      assert.equal(lines.every((line) => {
        JSON.parse(line);
        return true;
      }), true);
    }
  });

  it("preserves chat session id across runtime submissions", async () => {
    const deps = createDeterministicRuntimeDependencies();
    await registerRuntimeCoreTools(deps, process.cwd());
    const kernel = await createDefaultRuntimeKernel(deps);
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      ["one\ntwo\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps, kernel })
      }
    );
    const events = lines.map((line) => JSON.parse(line) as { kind: string; sessionId?: string });
    const sessionIds = new Set(events.filter((event) => event.kind === "agent.loop.completed").map((event) => event.sessionId));

    assert.deepEqual([...sessionIds].length, 1);
  });

  it("passes explicit tool projection and opt-ins through chat runtime submissions", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const capturedRequests: ModelRequest[] = [];
    const runtimeDeps = {
      ...deps,
      models: new CaptureModelRequestGateway(capturedRequests)
    };
    await registerRuntimeCoreTools(runtimeDeps, process.cwd());
    const kernel = await createDefaultRuntimeKernel(runtimeDeps);
    const lines: string[] = [];
    await runCli(
      ["chat", "--output", "jsonl", "--tool-projection", "safe-all", "--tool-opt-in", "network"],
      (line: string) => {
        lines.push(line);
      },
      ["fetch docs\n/exit\n"],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps: runtimeDeps, kernel })
      }
    );

    const firstRequest = capturedRequests[0];
    assert.ok(firstRequest, "expected chat to dispatch a model request");
    const toolNames = (firstRequest.tools ?? []).map((tool) => {
      const fn = tool.function;
      return isJsonObject(fn) ? String(fn.name) : "";
    });
    const toolPolicy = (firstRequest.messages ?? []).find((message) => message.content.includes("Tool visibility policy: safe-all"))?.content ?? "";

    assert.equal(toolNames.includes("core_web_fetch"), true);
    assert.equal(toolPolicy.includes("Tool opt-ins: network."), true);
    assert.equal(lines.some((line) => line.includes("agent.loop.completed")), true);
    await kernel.shutdown("cli-test-chat-tool-opt-ins");
  });

  it("routes model tool calls through preflight and governed execution", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const toolDeps = { ...deps, models: new ToolCallingModelGateway() };
    await toolDeps.platform.writeFile("/workspace/README.md", "tool loop\n");
    await registerRuntimeCoreTools(toolDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(toolDeps);
    const lines: string[] = [];
    await runCli(
      ["run", "read README", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        workspaceRoot: "/workspace",
        createRuntime: async () => {
          return { deps: toolDeps, kernel };
        }
      }
    );
    const events = lines.map((line) => JSON.parse(line) as { kind: string; data?: Record<string, unknown> });

    assert.equal(events.some((event) => event.kind === "model.tool.intent"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.repaired"), true);
    assert.equal(events.some((event) => event.kind === "execution.envelope.created"), true);
    assert.equal(events.some((event) => event.kind === "capability.completed"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result"), true);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
  });

  it("dispatches SWE-bench one-shot runs through the governed run capability instead of parent env preparation", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const gateway = new SweBenchDispatchRunModelGateway();
    const toolDeps = { ...deps, models: gateway, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(toolDeps, "/workspace");
    await registerCliEnvironmentCapabilities(toolDeps, "/workspace", { env: { GLM_ANTHROPIC_API_KEY: "fixture-secret-value" } });
    await registerFakeCliSweBenchRunCapability(toolDeps);
    const kernel = await createDefaultRuntimeKernel(toolDeps);
    const lines: string[] = [];

    await runCli(
      ["run", "给我完成 SWE-bench Lite 第 2 题测试，跑通并告诉我结果。", "--output", "jsonl", "--tool-projection", "all"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps: toolDeps, kernel })
      }
    );
    const events = lines.map((line) => JSON.parse(line) as { kind: string; data?: JsonObject });
    const projectedRunTool = gateway.requests[0]?.tools?.find((tool) => {
      const fn = tool.function;
      return isJsonObject(fn) && fn.name === "core_swe_bench_run";
    });
    const projectedEnvTool = gateway.requests[0]?.tools?.find((tool) => {
      const fn = tool.function;
      return isJsonObject(fn) && fn.name === "core_env_prepare";
    });

    assert.equal(Boolean(projectedRunTool), true);
    assert.equal(Boolean(projectedEnvTool), false);
    assert.equal(isJsonObject(projectedRunTool?.metadata) ? projectedRunTool.metadata.capabilityId : "", "core.swe.bench.run");
    assert.deepEqual(gateway.firstToolNames, ["core_swe_bench_run"]);
    assert.equal(gateway.firstPromptText.includes("给我完成 SWE-bench Lite 第 2 题测试，跑通并告诉我结果。"), true);
    assert.equal(gateway.firstPromptText.includes("run this first"), false);
    assert.equal(gateway.firstPromptText.includes("brew install"), false);
    assert.equal(gateway.firstPromptText.includes("deepseek diagnostics env prepare"), false);
    assert.equal(gateway.firstPromptText.includes(".deepseek/swebench-workspaces"), false);
    assert.equal(resolveCliAgentLoopLimits("给我完成 SWE-bench Lite 第 2 题测试，跑通并告诉我结果。")?.toolTimeoutMs, 600_000);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data?.name === "core.swe.bench.run"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.intent" && event.data?.name === "core.env.prepare"), false);
    assert.equal(events.some((event) => event.kind === "model.tool.repaired" && event.data?.capabilityId === "core.swe.bench.run"), true);
    assert.equal(events.some((event) => event.kind === "capability.completed" && isJsonObject(event.data?.output) && isJsonObject(event.data.output.evidence) && event.data.output.evidence.tool === "swe.bench.run"), true);
    assert.equal(events.some((event) => event.kind === "model.tool.result" && String(event.data?.result ?? "").includes("fake swe-bench run")), true);
    assert.equal(gateway.requests.length, 1);
    assert.equal(lines.join("\n").includes("fixture-secret-value"), false);
    assert.equal(events.at(-1)?.kind, "agent.loop.completed");
    await kernel.shutdown("cli-test-swe-env-prepare-tool-call");
  });

  it("routes diagnostics swe-bench run through the governed run capability", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const toolDeps = { ...deps, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(toolDeps, "/workspace");
    const capturedInputs: JsonObject[] = [];
    await registerFakeCliSweBenchRunCapability(toolDeps, capturedInputs);
    const kernel = await createDefaultRuntimeKernel(toolDeps);
    const lines: string[] = [];

    await runCli(
      ["diagnostics", "swe-bench", "run", "--task", "1", "--execute", "--provider", "glm", "--model", "glm-5.2", "--run-id", "test-run", "--output", "json"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        workspaceRoot: "/workspace",
        createRuntime: async () => ({ deps: toolDeps, kernel })
      }
    );

    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      kind?: string;
      status?: string;
      command?: string;
      sweBench?: { action?: string; run?: { ok?: boolean; value?: JsonObject }; diagnostics?: readonly { code?: string }[] };
    };
    assert.equal(parsed.kind, "diagnostics.swe-bench");
    assert.equal(parsed.status, "pass");
    assert.equal(parsed.command, "swe-bench");
    assert.equal(parsed.sweBench?.action, "run");
    assert.equal(parsed.sweBench?.run?.ok, true);
    assert.equal((parsed.sweBench?.run?.value?.evidence as JsonObject | undefined)?.tool, "swe.bench.run");
    assert.equal(parsed.sweBench?.diagnostics?.some((entry) => entry.code === "SWE_BENCH_PREDICTION_INVALID_ACTION"), false);
    assert.deepEqual(capturedInputs[0], {
      taskNumber: 1,
      execute: true,
      dryRun: false,
      provider: "glm",
      model: "glm-5.2",
      runId: "test-run",
      workspaceRoot: "/workspace",
      cwd: "/workspace"
    });
    assert.equal(lines.join("\n").includes("fake swe-bench run"), true);
    await kernel.shutdown("cli-test-diagnostics-swe-bench-run");
  });

  it("propagates failed SWE-bench evidence through diagnostics status", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const toolDeps = { ...deps, policy: new AllowAllPolicyEngine() };
    await registerRuntimeCoreTools(toolDeps, "/workspace");
    await registerFakeCliSweBenchRunCapability(toolDeps, [], {
      status: "fail",
      evaluationResolved: false,
      bestAttempt: 1,
      lastAttempt: 3
    });
    const kernel = await createDefaultRuntimeKernel(toolDeps);
    const lines: string[] = [];

    await runCli(
      ["diagnostics", "swe-bench", "run", "--task", "2", "--execute", "--provider", "glm", "--model", "glm-5.2", "--run-id", "failed-run", "--output", "json"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        workspaceRoot: "/workspace",
        createRuntime: async () => ({ deps: toolDeps, kernel })
      }
    );

    const parsed = JSON.parse(lines[0] ?? "{}") as {
      status?: string;
      sweBench?: { status?: string; run?: { ok?: boolean } };
    };
    assert.equal(parsed.status, "fail");
    assert.equal(parsed.sweBench?.status, "fail");
    assert.equal(parsed.sweBench?.run?.ok, true);
    await kernel.shutdown("cli-test-diagnostics-swe-bench-failed-evidence");
  });

  it("runs scriptable session commands with typed failures for unknown sessions", async () => {
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
  });

  it("renders a session execution board from persisted session events", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const kernel = await createDefaultRuntimeKernel(deps);
    const sessionId = await deps.sessions.create({ label: "board-fixture" });
    await deps.sessions.append(cliModeSessionEvent(sessionId, 1, "agent.loop.started", {
      status: "running",
      caller: "cli.run",
      redaction: { class: "internal" }
    }));
    await deps.sessions.append(cliModeSessionEvent(sessionId, 2, "agent.phase.plan.created", {
      schemaVersion: AGENT_MODE_SCHEMA_VERSION,
      planId: "agent-phase-plan:board",
      sessionId,
      interactionMode: "chat",
      agentMode: "engineer",
      phases: [{
        schemaVersion: AGENT_MODE_SCHEMA_VERSION,
        phase: "execute",
        status: "required",
        required: true,
        mode: "executor",
        budgets: [],
        diagnostics: [],
        redaction: { class: "internal" },
        compatibility: AGENT_MODE_COMPATIBILITY
      }, {
        schemaVersion: AGENT_MODE_SCHEMA_VERSION,
        phase: "verify",
        status: "required",
        required: true,
        mode: "verifier",
        budgets: [],
        diagnostics: [],
        redaction: { class: "internal" },
        compatibility: AGENT_MODE_COMPATIBILITY
      }],
      budgets: [],
      reason: "board fixture",
      diagnostics: [],
      redaction: { class: "internal" },
      compatibility: AGENT_MODE_COMPATIBILITY
    }));
    await deps.sessions.append(cliModeSessionEvent(sessionId, 3, "model.tool.intent", {
      name: "core.shell.run",
      redaction: { class: "internal" }
    }));
    await deps.sessions.append(cliModeSessionEvent(sessionId, 4, "model.tool.result", {
      terminalKind: "success",
      redaction: { class: "internal" }
    }));
    await deps.sessions.append(cliModeSessionEvent(sessionId, 5, "agent.loop.completed", {
      status: "completed",
      traceId: "trace-board",
      redaction: { class: "internal" }
    }));

    const jsonLines: string[] = [];
    await runCli(["session", "board", sessionId, "--output", "json"], (line: string) => {
      jsonLines.push(line);
    }, [], { stdinIsTTY: false, stdoutIsTTY: false }, {
      createRuntime: async () => ({ deps, kernel })
    });
    const parsed = JSON.parse(jsonLines[0] ?? "{}") as {
      ok?: boolean;
      value?: {
        status?: string;
        summary?: { totalSteps?: number; toolCallCount?: number; terminalStatus?: string };
        steps?: readonly { sequence?: number; kind?: string; label?: string; status?: string }[];
      };
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value?.status, "completed");
    assert.equal(parsed.value?.summary?.totalSteps, 5);
    assert.equal(parsed.value?.summary?.toolCallCount, 1);
    assert.equal(parsed.value?.summary?.terminalStatus, "completed");
    assert.equal(parsed.value?.steps?.some((step) => step.kind === "model.tool.intent" && step.label?.includes("core.shell.run")), true);

    const textLines: string[] = [];
    await runCli(["session", "board", sessionId, "--output", "text"], (line: string) => {
      textLines.push(line);
    }, [], { stdinIsTTY: false, stdoutIsTTY: false }, {
      createRuntime: async () => ({ deps, kernel })
    });
    assert.equal(textLines.some((line) => line.includes(`session board ${sessionId}`)), true);
    assert.equal(textLines.some((line) => line.includes("tool core.shell.run")), true);
  });

  it("renders mode-aware fork-lite output with active worker inheritance policy", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const kernel = await createDefaultRuntimeKernel(deps);
    const sessionId = await deps.sessions.create({ label: "mode-fork-lite" });
    await deps.sessions.append(cliModeSessionEvent(sessionId, 1, "mode.interaction.changed", {
      schemaVersion: INTERACTION_MODE_SCHEMA_VERSION,
      transitionId: "interaction-transition:cli-fork",
      sessionId,
      previousMode: "chat",
      nextMode: "chat",
      reason: "runtime-phase",
      initiator: "runtime",
      at: new Date(0).toISOString(),
      diagnostics: [],
      redaction: { class: "internal" },
      compatibility: INTERACTION_MODE_COMPATIBILITY
    }));
    await deps.sessions.append(cliModeSessionEvent(sessionId, 2, "agent.phase.plan.created", {
      schemaVersion: AGENT_MODE_SCHEMA_VERSION,
      planId: "agent-phase-plan:cli-fork",
      sessionId,
      interactionMode: "chat",
      agentMode: "coordinator",
      phases: [{
        schemaVersion: AGENT_MODE_SCHEMA_VERSION,
        phase: "verify",
        status: "required",
        required: true,
        mode: "verifier",
        budgets: [],
        diagnostics: [],
        redaction: { class: "internal" },
        compatibility: AGENT_MODE_COMPATIBILITY
      }],
      budgets: [cliLoopBudget("verification", 1, 1, 0)],
      reason: "mode-aware fork lite test",
      diagnostics: [],
      redaction: { class: "internal" },
      compatibility: AGENT_MODE_COMPATIBILITY
    }));
    await deps.sessions.append(cliModeSessionEvent(sessionId, 3, "agent.worker.launched", {
      schemaVersion: AGENT_MODE_SCHEMA_VERSION,
      workerEventId: "worker-event:cli-fork",
      status: "running",
      sessionId,
      workerSessionId: "session-worker-cli-fork",
      workOrderId: "work-order:cli-fork",
      at: new Date(0).toISOString(),
      delegationDecision: {
        schemaVersion: AGENT_MODE_SCHEMA_VERSION,
        decisionId: "delegation-decision:cli-fork",
        kind: "spawn",
        reasonCode: "parallel-independent-work",
        parentSessionId: sessionId,
        workOrderId: "work-order:cli-fork",
        evidenceIds: ["evidence:cli-fork"],
        diagnostics: [],
        redaction: { class: "internal" },
        compatibility: AGENT_MODE_COMPATIBILITY
      },
      diagnostics: [],
      redaction: { class: "internal" },
      compatibility: AGENT_MODE_COMPATIBILITY
    }));
    const lines: string[] = [];
    await runCli(["session", "fork", sessionId, "--output", "text"], (line: string) => {
      lines.push(line);
    }, [], { stdinIsTTY: false, stdoutIsTTY: false }, {
      createRuntime: async () => ({ deps, kernel })
    });
    const output = lines.join("\n");

    assert.equal(output.includes(`forked ${sessionId} -> session-2`), true, output);
    assert.equal(output.includes("mode interaction=chat agent=coordinator phase_plan=agent-phase-plan:cli-fork"), true, output);
    assert.equal(output.includes("active_workers policy=historical-lineage-only"), true, output);
    assert.equal(output.includes("delegation_lineage=1"), true, output);
    assert.equal(output.includes("phase_summary phases=1 budgets=verification=0/1"), true, output);
    await kernel.shutdown("cli-session-fork-lite-test");
  });

  it("coalesces streaming model deltas into one inline line in text mode", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const streamingDeps = { ...deps, models: new StreamingDeltaModelGateway() };
    await registerRuntimeCoreTools(streamingDeps, process.cwd());
    const kernel = await createDefaultRuntimeKernel(streamingDeps);
    const lines: string[] = [];
    await runCli(
      ["run", "hello", "--output", "text"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps: streamingDeps, kernel })
      }
    );
    const combined = lines.join("\n");
    assert.equal(combined.includes("hi there friend"), true, combined);
    // each delta chunk must not be a standalone line
    assert.equal(lines.includes("hi "), false);
    assert.equal(lines.includes("there "), false);
    assert.equal(lines.includes("friend"), false);
  });

  it("emits a single [reasoning] indicator per iteration in text mode", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const reasoningDeps = { ...deps, models: new ReasoningStreamModelGateway() };
    await registerRuntimeCoreTools(reasoningDeps, process.cwd());
    const kernel = await createDefaultRuntimeKernel(reasoningDeps);
    const lines: string[] = [];
    await runCli(
      ["run", "think", "--output", "text"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps: reasoningDeps, kernel })
      }
    );
    const reasoningCount = lines.filter((line) => line.startsWith("[reasoning] ") && !line.startsWith("[reasoning] records=")).length;
    assert.equal(reasoningCount, 1, `expected one reasoning prefix, got: ${JSON.stringify(lines)}`);
    const combined = lines.join("\n");
    assert.equal(combined.includes("plan first step."), true, combined);
  });

  it("leaves JSONL mode byte-identical to today (no streaming coalescence)", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const streamingDeps = { ...deps, models: new StreamingDeltaModelGateway() };
    await registerRuntimeCoreTools(streamingDeps, process.cwd());
    const kernel = await createDefaultRuntimeKernel(streamingDeps);
    const lines: string[] = [];
    await runCli(
      ["run", "hello", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps: streamingDeps, kernel })
      }
    );
    const deltaEvents = lines
      .map((line) => JSON.parse(line) as { kind: string; data?: { text?: string } })
      .filter((event) => event.kind === "model.delta");
    assert.equal(deltaEvents.length, 3, "JSONL mode must still produce one event per delta chunk");
  });

  it("renders approval denial evidence in JSONL without terminal controls", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const approvalDeps = { ...deps, models: new ToolCallingModelGateway(), policy: new CliAskApprovalPolicyEngine() };
    await registerRuntimeCoreTools(approvalDeps, "/workspace");
    const kernel = await createDefaultRuntimeKernel(approvalDeps);
    const lines: string[] = [];
    await runCli(
      ["run", "read README", "--output", "jsonl"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps: approvalDeps, kernel })
      }
    );
    const events = lines.map((line) => JSON.parse(line) as { kind: string; data?: { approval?: { approvalId?: string; summary?: { referencePitFixtureIds?: string[] } } } });
    const approval = events.find((event) => event.kind === "approval.denied");

    assert.equal(Boolean(approval), true);
    assert.equal(approval?.data?.approval?.approvalId, "approval:cli-test");
    assert.equal(approval?.data?.approval?.summary?.referencePitFixtureIds?.includes("pit.headless-trust.fail-closed"), true);
    assert.equal(lines.join("\n").includes("\u001b["), false);
    assert.equal(lines.join("\n").includes("? "), false);
  });

  it("renders approval denial evidence in text mode from runtime events", async () => {
    const deps = createDeterministicRuntimeDependencies();
    const approvalDeps = { ...deps, models: new ToolCallingModelGateway(), policy: new CliAskApprovalPolicyEngine() };
    await registerRuntimeCoreTools(approvalDeps, process.cwd());
    const kernel = await createDefaultRuntimeKernel(approvalDeps);
    const lines: string[] = [];
    await runCli(
      ["run", "read README", "--output", "text"],
      (line: string) => {
        lines.push(line);
      },
      [],
      { stdinIsTTY: false, stdoutIsTTY: false },
      {
        createRuntime: async () => ({ deps: approvalDeps, kernel })
      }
    );
    const output = lines.join("\n");

    assert.equal(output.includes("[approval required]"), true);
    assert.equal(output.includes("[approval denied]"), true);
    assert.equal(output.includes("pit.headless-trust.fail-closed"), true);
    assert.equal(output.includes("profile: plain"), true);
  });

  it("renders diagnostics bundle as redacted JSON", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "bundle", "--fake-secret", "--output", "json"], (line: string) => {
      lines.push(line);
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      kind?: string;
      bundle?: { selectedRecordCount?: number; redactionSummary?: { redactedValueCount?: number } };
      externalExportDecision?: { action?: string };
      referencePitFixtureIds?: string[];
    };
    const serialized = lines.join("\n");

    assert.equal(parsed.kind, "diagnostics.bundle");
    assert.equal((parsed.bundle?.selectedRecordCount ?? 0) > 0, true);
    assert.equal((parsed.bundle?.redactionSummary?.redactedValueCount ?? 0) > 0, true);
    assert.equal(parsed.externalExportDecision?.action, "deny-export");
    assert.equal(parsed.referencePitFixtureIds?.includes("pit.diagnostic-redaction.support-bundle"), true);
    assert.equal(parsed.referencePitFixtureIds?.includes("pit.env-snapshot.immutable-startup"), true);
    assert.equal(serialized.includes("sk-diagnostics-secret-123456"), false);
  });

  it("renders diagnostics flow inspect as JSON with task delivery decisions", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "flow", "inspect", "--prompt", "继续", "--output", "json"], (line: string) => {
      lines.push(line);
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      kind?: string;
      status?: string;
      command?: string;
      flow?: {
        schemaVersion?: string;
        brief?: { rawInput?: string; normalizedIntent?: string; needsUserConfirmation?: boolean };
        decisionRequest?: { requestId?: string; candidateProfiles?: readonly string[] };
        goal?: { goalId?: string; acceptanceCriteria?: readonly { criterionId?: string }[] };
        plan?: { steps?: readonly { phase?: string; status?: string }[]; planningMode?: string };
        acceptance?: { decision?: string; recommendedReturnPhase?: string };
        delivery?: { status?: string; nextPhase?: string };
      };
    };
    const serialized = lines.join("\n");

    assert.equal(parsed.kind, "diagnostics.flow.inspect");
    assert.equal(parsed.status === "pass" || parsed.status === "warn", true);
    assert.equal(parsed.command, "flow");
    assert.equal(parsed.flow?.brief?.rawInput, "继续");
    assert.equal(parsed.flow?.brief?.needsUserConfirmation, false);
    assert.equal(parsed.flow?.decisionRequest?.candidateProfiles?.includes("coding/general.v1"), true);
    assert.equal(parsed.flow?.goal?.acceptanceCriteria?.some((criterion) => criterion.criterionId === "criterion:proof"), true);
    assert.equal(parsed.flow?.plan?.steps?.some((step) => step.phase === "proof" && step.status === "required"), true);
    assert.equal(parsed.flow?.acceptance?.decision, "verify_required");
    assert.equal(parsed.flow?.delivery?.nextPhase, "proof");
    assert.equal(serialized.includes("\u001b["), false);
    assert.equal(serialized.includes("sk-diagnostics-secret-123456"), false);
  });

  it("renders diagnostics flow inspect as JSONL records", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "flow", "inspect", "--prompt", "继续", "--output", "jsonl"], (line: string) => {
      lines.push(line);
    });
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      summary?: { briefId?: string; goalId?: string; deliveryStatus?: string };
      phase?: { phase?: string; status?: string };
      acceptance?: { decision?: string };
      delivery?: { status?: string; nextPhase?: string };
    });

    assert.equal(records[0]?.kind, "diagnostics.flow.inspect");
    assert.equal(records.some((record) => record.kind === "diagnostics.flow.inspect.summary" && record.summary?.deliveryStatus === "returned"), true);
    assert.equal(records.some((record) => record.kind === "diagnostics.flow.inspect.phase" && record.phase?.phase === "proof" && record.phase.status === "required"), true);
    assert.equal(records.some((record) => record.kind === "diagnostics.flow.inspect.acceptance" && record.acceptance?.decision === "verify_required"), true);
    assert.equal(records.some((record) => record.kind === "diagnostics.flow.inspect.delivery" && record.delivery?.nextPhase === "proof"), true);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("renders diagnostics capability matrix dry-run as supervisor evidence plan", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "capability-matrix", "run", "--dry-run", "--output", "json"], (line: string) => {
      lines.push(line);
    });

    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      kind?: string;
      status?: string;
      capabilityMatrix?: {
        dryRun?: boolean;
        supervisorBoundary?: string;
        tasks?: readonly { taskId?: string; toolProjection?: string; evidenceArtifacts?: readonly string[] }[];
        runs?: readonly {
          taskId?: string;
          guidance?: {
            ownerLayer: string;
            rootCause: string;
            recommendedAction: string;
            rerunCondition: string;
            evidenceGaps: readonly string[];
            confidence: string;
          };
        }[];
        aggregate?: { totalTaskCount?: number; classificationCounts?: Record<string, number> };
      };
    };
    assert.equal(parsed.kind, "diagnostics.capability-matrix");
    assert.equal(parsed.status, "warn");
    assert.equal(parsed.capabilityMatrix?.dryRun, true);
    assert.equal(parsed.capabilityMatrix?.supervisorBoundary, "evaluate-only-no-help");
    assert.equal(parsed.capabilityMatrix?.tasks?.length, 8);
    assert.equal(parsed.capabilityMatrix?.aggregate?.totalTaskCount, 8);
    assert.equal(parsed.capabilityMatrix?.aggregate?.classificationCounts?.["partial"], 8);
    assert.equal(JSON.stringify(parsed.capabilityMatrix).includes("src/math.ts"), false);
    assert.equal(JSON.stringify(parsed.capabilityMatrix).includes("src/math.js"), true);
    assert.equal(parsed.capabilityMatrix?.tasks?.some((task) => task.toolProjection === "all"), false);
    assert.equal(parsed.capabilityMatrix?.tasks?.some((task) => task.toolProjection === "safe-all"), true);
    for (const task of parsed.capabilityMatrix?.tasks ?? []) {
      assert.deepEqual(task.evidenceArtifacts, ["prompt.txt", "trace.jsonl", "summary.json", "diff.patch", "classification.json"]);
    }
    const firstRun = parsed.capabilityMatrix?.runs?.[0];
    assert.equal(firstRun?.guidance?.ownerLayer, "evaluation-supervisor");
    assert.equal(firstRun.guidance.rootCause.includes("Dry-run"), true);
    assert.equal(firstRun.guidance.recommendedAction.includes("live"), true);
    assert.equal(firstRun.guidance.rerunCondition.includes("credentials"), true);
    assert.deepEqual(firstRun.guidance.evidenceGaps, ["trace.jsonl", "diff.patch", "summary.json"]);
    assert.equal(firstRun.guidance.confidence, "high");
  });

  it("classifies workflow projection gaps as CLI capability gaps", () => {
    const classification = classifyCapabilityMatrixRun(
      1,
      "",
      [
        "WORKFLOW_CAPABILITY_PROJECTION_EMPTY: primary governed workflow declared capabilities that are not executable.",
        '"classification":"blocked-by-cli-capability-gap"',
        '"missingCapabilityIds":["core.file.edit","core.test.run"]'
      ].join("\n"),
      "",
      { workspaceMode: "disposable-write" }
    );

    assert.equal(classification.classification, "blocked-by-cli-capability-gap");
    assert.equal(classification.reason.includes("core.file.edit"), true);
    assert.equal(classification.reason.includes("core.test.run"), true);
    assert.equal(classification.guidance.ownerLayer, "tool-projection");
    assert.equal(classification.guidance.recommendedAction.includes("Register or expose"), true);
    assert.equal(classification.guidance.rerunCondition.includes("visible"), true);
    assert.deepEqual(classification.guidance.evidenceGaps, ["profile id", "stage id", "visible tool ids"]);
  });

  it("distinguishes capability gap root causes in matrix classification reasons", () => {
    const absent = classifyCapabilityMatrixRun(
      1,
      "",
      [
        "WORKFLOW_CAPABILITY_PROJECTION_EMPTY",
        '"diagnosticKind":"absent-implementation"',
        '"unregisteredWorkflowCapabilityIds":["core.patch.apply"]'
      ].join("\n"),
      "",
      { workspaceMode: "disposable-write" }
    );
    const policyHidden = classifyCapabilityMatrixRun(
      1,
      "",
      [
        "WORKFLOW_CAPABILITY_PROJECTION_EMPTY",
        '"diagnosticKind":"disabled-by-policy"',
        '"policyHiddenCapabilityIds":["core.shell.run"]'
      ].join("\n"),
      "",
      { workspaceMode: "disposable-write" }
    );
    const sandboxBlocked = classifyCapabilityMatrixRun(
      1,
      "",
      "KERNEL_POLICY_DENIED: sandbox blocked process execution for permission process:run",
      "",
      { workspaceMode: "disposable-write" }
    );
    const projectionBug = classifyCapabilityMatrixRun(
      1,
      "",
      [
        "WORKFLOW_CAPABILITY_PROJECTION_EMPTY",
        '"diagnosticKind":"projection-bug"',
        '"allowedCapabilityIds":["core.file.edit"]'
      ].join("\n"),
      "",
      { workspaceMode: "disposable-write" }
    );

    assert.equal(absent.classification, "blocked-by-cli-capability-gap");
    assert.equal(absent.reason.includes("absent implementation"), true);
    assert.equal(absent.reason.includes("core.patch.apply"), true);
    assert.equal(policyHidden.classification, "blocked-by-cli-capability-gap");
    assert.equal(policyHidden.reason.includes("disabled by tool projection policy"), true);
    assert.equal(policyHidden.reason.includes("core.shell.run"), true);
    assert.equal(sandboxBlocked.classification, "blocked-by-cli-bug");
    assert.equal(sandboxBlocked.reason.includes("blocked by sandbox or host policy"), true);
    assert.equal(projectionBug.classification, "blocked-by-cli-bug");
    assert.equal(projectionBug.reason.includes("projection bug"), true);
    assert.equal(absent.guidance.ownerLayer, "tool-implementation");
    assert.equal(policyHidden.guidance.ownerLayer, "tool-policy");
    assert.equal(sandboxBlocked.guidance.ownerLayer, "policy-sandbox");
    assert.equal(projectionBug.guidance.ownerLayer, "tool-projection");
    assert.equal(policyHidden.guidance.recommendedAction.includes("host policy"), true);
    assert.equal(sandboxBlocked.guidance.rerunCondition.includes("sandbox"), true);
    assert.equal(projectionBug.guidance.evidenceGaps.includes("projection compiler trace"), true);
  });

  it("does not classify credential plumbing failures as missing environment when fallback credentials are available", () => {
    const classification = classifyCapabilityMatrixRun(
      1,
      JSON.stringify({
        kind: "runtime.observability",
        name: "credential.resolution",
        fields: {
          provider: "glm",
          available: true,
          sourceClass: "launch-workspace-env-file"
        }
      }),
      "PROVIDER_CREDENTIAL_MISSING",
      "",
      { workspaceMode: "disposable-write" }
    );

    assert.equal(classification.classification, "blocked-by-cli-bug");
    assert.equal(classification.guidance.ownerLayer, "credentials");
    assert.equal(classification.guidance.rootCause.includes("resolved"), true);
    assert.equal(classification.guidance.recommendedAction.includes("credential plumbing"), true);
  });

  it("does not treat unrelated auth substrings in successful traces as credential failures", () => {
    const classification = classifyCapabilityMatrixRun(
      0,
      [
        JSON.stringify({ kind: "context.lcm.node-recorded", data: { sourceClass: "user-prompt" } }),
        JSON.stringify({ kind: "model.tool.intent", data: { name: "core.file.read" } }),
        JSON.stringify({ kind: "agent.loop.completed", reason: "workflow-stages-completed", diagnostics: [{ code: "KERNEL_SCHEDULER_TIMEOUT", message: "Task cancelled: timeout" }] }),
        "authoritative local evidence was inspected"
      ].join("\n"),
      "",
      "",
      { workspaceMode: "project-read-only" }
    );

    assert.equal(classification.classification, "partial");
    assert.equal(classification.guidance.ownerLayer, "task-design");
  });

  it("does not classify fixture command module failures as a missing CLI entrypoint", () => {
    const classification = classifyCapabilityMatrixRun(
      1,
      [
        JSON.stringify({ kind: "agent.loop.started" }),
        JSON.stringify({
          kind: "capability.completed",
          data: {
            capabilityId: "core.shell.run",
            output: {
              stderr: "Error: Cannot find module '/tmp/capability-matrix/T06/workspace/missing-check.js'\ncode: 'MODULE_NOT_FOUND'"
            }
          }
        })
      ].join("\n"),
      "",
      "",
      { workspaceMode: "disposable-write" }
    );

    assert.notEqual(classification.classification, "invalid-test-environment");
    assert.notEqual(classification.guidance.ownerLayer, "test-environment");
  });

  it("does not classify post-start workspace ENOENT as a missing CLI entrypoint", () => {
    const classification = classifyCapabilityMatrixRun(
      0,
      [
        JSON.stringify({ kind: "agent.loop.started" }),
        JSON.stringify({
          kind: "agent.loop.completed",
          data: {
            reason: "workflow-stages-completed",
            diagnostics: [{
              code: "KERNEL_EXECUTOR_FAILED",
              message: "ENOENT: no such file or directory, open '/Users/ankye/work/deepseek-agent-cli/.deepseek/capability-matrix/T03/workspace/readme.md'"
            }]
          }
        })
      ].join("\n"),
      "",
      "diff --git a/src/slug.js b/src/slug.js\n",
      { workspaceMode: "disposable-write" }
    );

    assert.notEqual(classification.classification, "invalid-test-environment");
    assert.notEqual(classification.guidance.ownerLayer, "test-environment");
  });

  it("does not classify allowed policy metadata as a sandbox denial", () => {
    const classification = classifyCapabilityMatrixRun(
      0,
      [
        JSON.stringify({ kind: "execution.envelope.created", data: { envelope: { capabilityId: "core.shell.run", permissions: ["process:run"] } } }),
        JSON.stringify({ kind: "policy.decided", data: { action: "allow", reason: "Live CLI policy allows workspace-scoped process execution." } }),
        JSON.stringify({ kind: "capability.completed", data: { capabilityId: "core.shell.run", status: "success" } })
      ].join("\n"),
      "",
      "",
      { workspaceMode: "project-read-only" }
    );

    assert.notEqual(classification.classification, "blocked-by-cli-bug");
    assert.notEqual(classification.guidance.ownerLayer, "policy-sandbox");
  });

  it("does not classify projection evidence as a capability gap without a projection failure", () => {
    const classification = classifyCapabilityMatrixRun(
      0,
      [
        JSON.stringify({
          kind: "prompt.assembled",
          data: {
            trace: {
              sections: [{
                provenance: {
                  projectionLimitedWorkflowCapabilityIds: ["core.shell.run"],
                  unregisteredWorkflowCapabilityIds: []
                }
              }]
            }
          }
        }),
        JSON.stringify({ kind: "agent.loop.completed", data: { reason: "workflow-stages-completed" } })
      ].join("\n"),
      "",
      "",
      { workspaceMode: "project-read-only" }
    );

    assert.notEqual(classification.classification, "blocked-by-cli-capability-gap");
    assert.notEqual(classification.guidance.ownerLayer, "tool-projection");
  });

  it("does not classify recovered workflow required-action diagnostics as sandbox denials", () => {
    const classification = classifyCapabilityMatrixRun(
      0,
      JSON.stringify({
        kind: "agent.loop.completed",
        data: {
          reason: "workflow-stages-completed",
          diagnostics: [{
            code: "KERNEL_POLICY_DENIED",
            message: "WORKFLOW_REQUIRED_ACTION_MISSED: model response did not request the required workflow action core.git.diff|core.file.read."
          }]
        }
      }),
      "",
      "diff --git a/src/slug.js b/src/slug.js\n",
      { workspaceMode: "disposable-write" }
    );

    assert.notEqual(classification.classification, "blocked-by-cli-bug");
    assert.notEqual(classification.guidance.ownerLayer, "policy-sandbox");
    assert.equal(classification.classification, "partial");
  });

  it("reports outcome gate evidence gaps for semantic partial matrix runs", () => {
    const classification = classifyCapabilityMatrixRun(
      0,
      [
        JSON.stringify({ kind: "prompt.assembled" }),
        JSON.stringify({ kind: "capability.completed", data: { capabilityId: "core.file.edit", status: "success" } })
      ].join("\n"),
      "",
      "diff --git a/src/slug.js b/src/slug.js\n",
      { workspaceMode: "disposable-write" }
    );

    assert.equal(classification.classification, "partial");
    assert.equal(classification.outcomeGate.status, "fail");
    assert.equal(classification.outcomeGate.reasonCodes.includes("checks-failed"), true);
    assert.equal(classification.outcomeGate.reasonCodes.includes("terminal-event-missing"), true);
    assert.equal(classification.guidance.evidenceGaps.includes("outcome:checks-failed"), true);
    assert.equal(classification.guidance.evidenceGaps.includes("outcome:terminal-event-missing"), true);
  });

  it("classifies terminal workflow required-action misses as model behavior", () => {
    const classification = classifyCapabilityMatrixRun(
      0,
      JSON.stringify({
        kind: "agent.loop.completed",
        data: {
          reason: "workflow-required-action-missed",
          diagnostics: [{
            code: "KERNEL_POLICY_DENIED",
            message: "WORKFLOW_REQUIRED_ACTION_MISSED: model response did not request the required workflow action core.file.write|core.file.edit|core.patch.apply."
          }]
        }
      }),
      "",
      "diff --git a/package.json b/package.json\n",
      { workspaceMode: "disposable-write" }
    );

    assert.equal(classification.classification, "blocked-by-model");
    assert.equal(classification.guidance.ownerLayer, "model-behavior");
  });

  it("passes launch workspace credential fallback env to live capability matrix child runs", async () => {
    const platform = new CapabilityMatrixEnvRecordingPlatform();
    await collectCapabilityMatrix({
      dryRun: false,
      live: true,
      taskIds: ["T02"],
      reportDir: "/matrix",
      cliCommand: "deepseek-test",
      modelProvider: "glm",
      model: "glm-5.1",
      platform
    });

    const childRun = platform.processRuns.find((run) => run.command === "deepseek-test" && run.args.includes("run"));
    assert.ok(childRun);
    assert.equal(typeof childRun.options.env?.[liveCredentialLaunchCwdEnvKey], "string");
    assert.equal(childRun.options.env?.[liveCredentialLaunchCwdEnvKey], process.cwd());
  });

  it("resolves relative capability matrix CLI entrypoint paths from the launch workspace", async () => {
    const platform = new CapabilityMatrixEnvRecordingPlatform();
    await collectCapabilityMatrix({
      dryRun: false,
      live: true,
      taskIds: ["T02"],
      reportDir: "/matrix",
      cliCommand: "node src/apps/cli/dist/index.js",
      modelProvider: "glm",
      model: "glm-5.1",
      platform
    });

    const childRun = platform.processRuns.find((run) => run.command === "node" && run.args.includes("run"));
    assert.ok(childRun);
    assert.equal(childRun.args[0], join(process.cwd(), "src/apps/cli/dist/index.js"));
  });

  it("renders diagnostics release evidence in JSONL", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "release", "--output", "jsonl"], (line: string) => {
      lines.push(line);
    });
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      packageSurface?: { packageName?: string; binEntry?: string; buildOutputPath?: string; expectedPackageFiles?: string[]; generatedBundleIgnored?: boolean; unexpectedPackageFiles?: string[] };
      verification?: { requiredCommands?: string[]; acceptanceEvidencePaths?: string[]; missingAcceptanceEvidencePaths?: string[] };
      check?: { id?: string; status?: string; metadata?: { buildOutputPath?: string; acceptanceEvidencePaths?: string[]; unexpectedPackageFiles?: string[] } };
    });
    const summary = records.find((record) => record.kind === "diagnostics.release.summary");
    const checks = records.filter((record) => record.kind === "diagnostics.release.check");

    assert.equal(records[0]?.kind, "diagnostics.release");
    assert.equal(summary?.packageSurface?.packageName, "deepseek-agent-cli");
    assert.equal(summary?.packageSurface?.binEntry, "dist/index.js");
    assert.equal(summary?.packageSurface?.buildOutputPath, "src/apps/cli/dist/index.js");
    assert.equal(summary?.packageSurface?.expectedPackageFiles?.includes("dist"), true);
    assert.equal(summary?.packageSurface?.generatedBundleIgnored, true);
    assert.deepEqual(summary?.packageSurface?.unexpectedPackageFiles, []);
    assert.equal(summary?.verification?.acceptanceEvidencePaths?.includes("tests/acceptance/acceptance-index.md"), true);
    assert.equal(summary?.verification?.requiredCommands?.some((command) => command.includes("npm publish --dry-run")), true);
    assert.equal(checks.some((record) => record.check?.id === "release.build-output"), true);
    assert.equal(checks.some((record) => record.check?.id === "release.acceptance"), true);
    assert.equal(checks.some((record) => record.check?.id === "release.package-surface"), true);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("renders diagnostics release acceptance evidence in text mode", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "release"], (line: string) => {
      lines.push(line);
    });
    const text = lines.join("\n");

    assert.equal(text.includes("- evidence: tests/acceptance/acceptance-index.md"), true);
    assert.equal(text.includes("tests/acceptance/latest/openspec-validation.txt"), true);
    assert.equal(text.includes("tests/acceptance/latest/smoke-headless.txt"), true);
    assert.equal(text.includes("- build artifact: src/apps/cli/dist/index.js"), true);
    assert.equal(text.includes("- package surface: safe"), true);
    assert.equal(text.includes("- release.build-output:"), true);
    assert.equal(text.includes("- release.acceptance:"), true);
    assert.equal(text.includes("\u001b["), false);
  });

  it("renders diagnostics refresh default dry-run as JSON", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "refresh", "--dry-run", "--output", "json"], (line: string) => {
      lines.push(line);
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      kind?: string;
      status?: string;
      refresh?: {
        mode?: string;
        dryRun?: boolean;
        refreshedPaths?: readonly string[];
        failedStepIds?: readonly string[];
        steps?: readonly { id?: string; status?: string; outputPath?: string; exitCode?: number }[];
        nextAction?: string;
      };
    };

    assert.equal(parsed.kind, "diagnostics.refresh");
    assert.equal(parsed.status, "pass");
    assert.equal(parsed.refresh?.mode, "default");
    assert.equal(parsed.refresh?.dryRun, true);
    assert.deepEqual(parsed.refresh?.refreshedPaths, []);
    assert.deepEqual(parsed.refresh?.failedStepIds, []);
    assert.equal(parsed.refresh?.steps?.some((step) => step.id === "release-verify" && step.outputPath === "tests/acceptance/latest/release-verify.txt"), true);
    assert.equal(parsed.refresh?.steps?.some((step) => step.id === "e2e"), false);
    assert.equal(parsed.refresh?.steps?.every((step) => step.status === "pass" && step.exitCode === undefined), true);
    assert.equal(parsed.refresh?.nextAction, "Run deepseek diagnostics verify --output json.");
    assert.equal(lines.join("\n").includes("\u001b["), false);
    assert.equal(lines.join("\n").includes("sk-live-secret-value"), false);
  });

  it("renders diagnostics refresh full dry-run as JSONL steps", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "refresh", "--full", "--dry-run", "--output", "jsonl"], (line: string) => {
      lines.push(line);
    });
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      status?: string;
      summary?: { mode?: string; dryRun?: boolean; steps?: readonly { id?: string }[] };
      step?: { id?: string; outputPath?: string; status?: string; exitCode?: number };
    });
    const summary = records.find((record) => record.kind === "diagnostics.refresh.summary");

    assert.equal(records[0]?.kind, "diagnostics.refresh");
    assert.equal(records[0]?.status, "pass");
    assert.equal(summary?.summary?.mode, "full");
    assert.equal(summary?.summary?.dryRun, true);
    assert.equal(summary?.summary?.steps?.some((step) => step.id === "contracts"), true);
    assert.equal(summary?.summary?.steps?.some((step) => step.id === "e2e"), true);
    assert.equal(records.some((record) => record.kind === "diagnostics.refresh.step" && record.step?.id === "contracts" && record.step.status === "pass"), true);
    assert.equal(records.some((record) => record.kind === "diagnostics.refresh.step" && record.step?.id === "e2e" && record.step.outputPath === "tests/acceptance/latest/smoke-host-adapters.txt"), true);
    assert.equal(lines.every((line) => JSON.parse(line) && true), true);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("rejects diagnostics refresh positional command input", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "refresh", "npm", "test", "--output", "json"], (line: string) => {
      lines.push(line);
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      kind?: string;
      status?: string;
      refresh?: {
        status?: string;
        steps?: readonly unknown[];
        diagnostics?: readonly { id?: string; message?: string }[];
        failedStepIds?: readonly string[];
      };
    };
    const serialized = lines.join("\n");

    assert.equal(parsed.kind, "diagnostics.refresh");
    assert.equal(parsed.status, "fail");
    assert.equal(parsed.refresh?.status, "fail");
    assert.deepEqual(parsed.refresh?.steps, []);
    assert.deepEqual(parsed.refresh?.failedStepIds, []);
    assert.equal(parsed.refresh?.diagnostics?.[0]?.id, "diagnostics.refresh.invalid-args");
    assert.equal(parsed.refresh?.diagnostics?.[0]?.message, "diagnostics refresh received 2 unsupported argument(s).");
    assert.equal(serialized.includes("npm test"), false);
    assert.equal(serialized.includes("\u001b["), false);
  });

  it("writes diagnostics refresh evidence files through platform execution", async () => {
    const platform = new FakePlatformRuntime("fake", "/workspace");
    const summary = await refreshAcceptanceEvidence({
      mode: "default",
      dryRun: false,
      extraArgs: [],
      platform
    });
    const firstStep = summary.steps[0];
    const stored = await platform.readFile(join(process.cwd(), firstStep?.outputPath ?? ""));

    assert.equal(summary.status, "pass");
    assert.equal(summary.refreshedPaths.includes("tests/acceptance/latest/acceptance-index.txt"), true);
    assert.equal(firstStep?.id, "acceptance-index");
    assert.equal(firstStep?.exitCode, 0);
    assert.equal(stored.includes("# Acceptance index"), true);
    assert.equal(stored.includes("Command: npm run acceptance:index"), true);
    assert.equal(stored.includes('"command":"npm"'), true);
    assert.equal(stored.includes("\u001b["), false);
  });

  it("renders diagnostics env prepare SWE-bench Lite dry-run as redacted JSON", async () => {
    const previousGlm = process.env.GLM_ANTHROPIC_API_KEY;
    const secret = "fixture-glm-env-secret-123456";
    process.env.GLM_ANTHROPIC_API_KEY = secret;
    try {
      const lines: string[] = [];
      await runCli(["diagnostics", "env", "prepare", "--profile", "swe-bench-lite", "--output", "json"], (line: string) => {
        lines.push(line);
      });
      const parsed = JSON.parse(lines[0] ?? "{}") as {
        kind?: string;
        status?: string;
        environment?: {
          profileId?: string;
          action?: string;
          dryRun?: boolean;
          execute?: boolean;
          dependencies?: readonly { id?: string; status?: string; optional?: boolean; commandPlan?: readonly { id?: string; command?: string; autoExecute?: boolean }[]; secretRef?: { present?: boolean; sourceClass?: string } }[];
          diagnostics?: readonly { id?: string; status?: string; message?: string }[];
          nextAction?: string;
        };
      };
      const serialized = lines.join("\n");
      const dependencyIds = parsed.environment?.dependencies?.map((dependency) => dependency.id) ?? [];
      const glmCredential = parsed.environment?.dependencies?.find((dependency) => dependency.id === "credential.glm");
      const dockerInstallPlan = parsed.environment?.dependencies?.find((dependency) => dependency.id === "docker.cli")?.commandPlan?.find((step) => step.id === "docker.install");

      assert.equal(parsed.kind, "diagnostics.env.prepare");
      assert.equal(parsed.status === "pass" || parsed.status === "warn", true);
      assert.equal(parsed.environment?.profileId, "swe-bench-lite");
      assert.equal(parsed.environment?.action, "prepare");
      assert.equal(parsed.environment?.dryRun, true);
      assert.equal(parsed.environment?.execute, false);
      assert.equal(dependencyIds.includes("docker.cli"), true);
      assert.equal(dependencyIds.includes("docker.daemon"), true);
      assert.equal(dependencyIds.includes("docker.host"), true);
      assert.equal(dependencyIds.includes("python.venv"), true);
      assert.equal(dependencyIds.includes("swebench.package"), true);
      assert.equal(dependencyIds.includes("rust.toolchain"), true);
      assert.equal(dependencyIds.includes("credential.glm"), true);
      assert.equal(dependencyIds.includes("credential.huggingface"), true);
      assert.equal(glmCredential?.secretRef?.present, true);
      assert.equal(glmCredential?.secretRef?.sourceClass, "process-env");
      assert.equal(dockerInstallPlan?.command, "brew");
      assert.equal(dockerInstallPlan?.autoExecute, true);
      assert.equal(parsed.environment?.dependencies?.some((dependency) => dependency.commandPlan?.some((step) => step.id === "swebench.install")), true);
      assert.equal(parsed.environment?.nextAction?.includes("--execute"), true);
      assert.equal(serialized.includes(secret), false);
      assert.equal(serialized.includes("\u001b["), false);
    } finally {
      if (previousGlm === undefined) delete process.env.GLM_ANTHROPIC_API_KEY;
      else process.env.GLM_ANTHROPIC_API_KEY = previousGlm;
    }
  });

  it("renders diagnostics env prepare dependencies as JSONL records", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "env", "prepare", "--profile", "swe-bench-lite", "--output", "jsonl"], (line: string) => {
      lines.push(line);
    });
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      status?: string;
      summary?: { profileId?: string; dryRun?: boolean };
      dependency?: { id?: string; status?: string };
    });

    assert.equal(records[0]?.kind, "diagnostics.env.prepare");
    assert.equal(records[0]?.status === "pass" || records[0]?.status === "warn", true);
    assert.equal(records.some((record) => record.kind === "diagnostics.env.prepare.summary" && record.summary?.profileId === "swe-bench-lite" && record.summary.dryRun === true), true);
    assert.equal(records.some((record) => record.kind === "diagnostics.env.prepare.dependency" && record.dependency?.id === "docker.cli"), true);
    assert.equal(records.some((record) => record.kind === "diagnostics.env.prepare.dependency" && record.dependency?.id === "swebench.package"), true);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("rejects diagnostics env prepare arbitrary positional input", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "env", "prepare", "npm", "test", "--profile", "swe-bench-lite", "--execute", "--output", "json"], (line: string) => {
      lines.push(line);
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      kind?: string;
      status?: string;
      environment?: {
        status?: string;
        execute?: boolean;
        executedSteps?: readonly unknown[];
        diagnostics?: readonly { id?: string; message?: string }[];
      };
    };
    const serialized = lines.join("\n");

    assert.equal(parsed.kind, "diagnostics.env.prepare");
    assert.equal(parsed.status, "fail");
    assert.equal(parsed.environment?.status, "fail");
    assert.equal(parsed.environment?.execute, false);
    assert.deepEqual(parsed.environment?.executedSteps, []);
    assert.equal(parsed.environment?.diagnostics?.[0]?.id, "diagnostics.env.invalid-args");
    assert.equal(parsed.environment?.diagnostics?.[0]?.message, "diagnostics env prepare received 2 unsupported argument(s).");
    assert.equal(serialized.includes("npm test"), false);
    assert.equal(serialized.includes("\u001b["), false);
  });

  it("renders diagnostics evaluate smoke dry-run as DeepSeek-owned plan", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "evaluate", "--dry-run", "--output", "json"], (line: string) => {
      lines.push(line);
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      kind?: string;
      status?: string;
      evaluation?: {
        mode?: string;
        dryRun?: boolean;
        taskCatalogVersion?: string;
        baselines?: readonly { baselineId?: string; status?: string; configured?: boolean }[];
        taskRuns?: readonly { outcome?: string; baseline?: { baselineId?: string }; task?: { taskId?: string; mode?: string }; metrics?: { repairMetricsAvailability?: string; repairActivationCount?: number; repairSuccessCount?: number } }[];
        publicBenchmarkReferences?: readonly { name?: string; advisoryOnly?: boolean }[];
      };
    };

    assert.equal(parsed.kind, "diagnostics.evaluate");
    assert.equal(parsed.status, "pass");
    assert.equal(parsed.evaluation?.mode, "smoke");
    assert.equal(parsed.evaluation?.dryRun, true);
    assert.equal(parsed.evaluation?.taskCatalogVersion, "2026-05-15.repair");
    assert.equal(parsed.evaluation?.baselines?.[0]?.baselineId, "deepseek-cli");
    assert.equal(parsed.evaluation?.baselines?.[0]?.status, "available");
    assert.equal(parsed.evaluation?.taskRuns?.length, 3);
    assert.equal(parsed.evaluation?.taskRuns?.every((run) => run.outcome === "planned" && run.baseline?.baselineId === "deepseek-cli" && run.task?.mode === "smoke"), true);
    assert.equal(parsed.evaluation?.taskRuns?.every((run) => run.metrics?.repairMetricsAvailability === "unavailable" && run.metrics.repairActivationCount === 0), true);
    assert.equal(parsed.evaluation?.taskRuns?.some((run) => run.task?.taskId === "eval.webpage.generation"), false);
    assert.equal(parsed.evaluation?.publicBenchmarkReferences?.some((reference) => reference.name === "SWE-bench Verified" && reference.advisoryOnly === true), true);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("renders diagnostics evaluate repair metrics in text output", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "evaluate", "--dry-run", "--output", "text"], (line: string) => {
      lines.push(line);
    });
    const text = lines.join("\n");

    assert.equal(text.includes("repair=unavailable:0/0"), true);
    assert.equal(text.includes("\u001b["), false);
  });

  it("includes webpage generation in diagnostics evaluate full dry-run", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "evaluate", "--full", "--dry-run", "--output", "json"], (line: string) => {
      lines.push(line);
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      evaluation?: {
        mode?: string;
        taskRuns?: readonly {
          task?: { taskId?: string; category?: string; checkCommands?: readonly string[]; mode?: string };
          stagedTask?: {
            profileId?: string;
            graphId?: string;
            profileFingerprint?: string;
            stageCount?: number;
            executorKinds?: readonly string[];
            graph?: { profileId?: string; stages?: readonly { stageId?: string; executorKind?: string }[] };
            runState?: { taskRunId?: string; events?: readonly unknown[]; stageStates?: readonly { status?: string }[] };
          };
        }[];
      };
    };
    const webpageRun = parsed.evaluation?.taskRuns?.find((run) => run.task?.taskId === "eval.webpage.generation");
    const webpage = webpageRun?.task;
    const webpageRepair = parsed.evaluation?.taskRuns?.find((run) => run.task?.taskId === "eval.webpage.failing-first-repair")?.task;
    const codingRepair = parsed.evaluation?.taskRuns?.find((run) => run.task?.taskId === "eval.coding.failing-first-typecheck")?.task;

    assert.equal(parsed.evaluation?.mode, "full");
    assert.equal(webpage?.category, "webpage-generation");
    assert.equal(webpage?.mode, "full");
    assert.equal(webpage?.checkCommands?.includes("node scripts/check-webpage-generation.mjs tests/evaluation/generated-webpage"), true);
    assert.equal(webpageRun?.stagedTask?.profileId, "evaluation/webpage-generation.v1");
    assert.equal(webpageRun?.stagedTask?.graph?.profileId, "evaluation/webpage-generation.v1");
    assert.equal(webpageRun?.stagedTask?.graphId?.startsWith("graph:evaluation/webpage-generation.v1:"), true);
    assert.equal(webpageRun?.stagedTask?.profileFingerprint?.startsWith("fnv1a:"), true);
    assert.equal((webpageRun?.stagedTask?.stageCount ?? 0) >= 5, true);
    assert.equal(webpageRun?.stagedTask?.executorKinds?.includes("agent-loop"), true);
    assert.equal(webpageRun?.stagedTask?.runState?.taskRunId, "staged:eval:deepseek-cli:eval.webpage.generation");
    assert.equal(webpageRun?.stagedTask?.runState?.events?.length, 0);
    assert.equal(webpageRun?.stagedTask?.runState?.stageStates?.some((stage) => stage.status === "ready"), true);
    assert.equal(webpageRepair?.category, "webpage-repair");
    assert.equal(webpageRepair?.checkCommands?.includes("node scripts/check-webpage-generation.mjs tests/evaluation/generated-webpage"), true);
    assert.equal(codingRepair?.category, "coding-repair");
    assert.equal(codingRepair?.checkCommands?.includes("npm run typecheck"), true);
  });

  it("defers diagnostics evaluate external baselines by default", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "evaluate", "--baseline", "claude-code", "--dry-run", "--output", "jsonl"], (line: string) => {
      lines.push(line);
    });
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      status?: string;
      summary?: {
        status?: string;
        baselines?: readonly { baselineId?: string; status?: string; configured?: boolean; kind?: string }[];
        taskRuns?: readonly { outcome?: string; diagnostics?: readonly { code?: string }[] }[];
        diagnostics?: readonly { code?: string }[];
      };
      diagnostic?: { code?: string };
      run?: { outcome?: string; baseline?: { baselineId?: string; status?: string; configured?: boolean } };
    });
    const summary = records.find((record) => record.kind === "diagnostics.evaluate.summary")?.summary;

    assert.equal(records[0]?.kind, "diagnostics.evaluate");
    assert.equal(records[0]?.status, "warn");
    assert.equal(summary?.baselines?.[0]?.baselineId, "claude-code");
    assert.equal(summary?.baselines?.[0]?.status, "deferred");
    assert.equal(summary?.baselines?.[0]?.configured, false);
    assert.equal(summary?.taskRuns?.every((run) => run.outcome === "deferred"), true);
    assert.equal(records.some((record) => record.kind === "diagnostics.evaluate.task-run" && record.run?.baseline?.baselineId === "claude-code" && record.run.baseline.status === "deferred"), true);
    assert.equal(records.some((record) => record.kind === "diagnostics.evaluate.diagnostic" && record.diagnostic?.code === "CLI_EVALUATION_BASELINE_DEFERRED"), true);
    assert.equal(lines.join("\n").includes("claude --"), false);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("renders diagnostics evaluate multi-baseline dry-run without executing tasks", async () => {
    const lines: string[] = [];
    await runCli([
      "diagnostics",
      "evaluate",
      "--full",
      "--compare-baseline",
      "deepseek-cli",
      "--compare-baseline",
      "codex",
      "--compare-baseline",
      "claude-code",
      "--dry-run",
      "--output",
      "jsonl"
    ], (line: string) => {
      lines.push(line);
    });
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      summary?: {
        baselines?: readonly { baselineId?: string; status?: string }[];
        baselineAggregates?: readonly { baselineId?: string; executedRunCount?: number; deferredRunCount?: number; commandSuccessRate?: number }[];
        codexClassGapScorecard?: {
          externalBaselineStatus?: string;
          dimensions?: readonly { dimensionId?: string; status?: string; score?: number }[];
        };
        gapFindings?: readonly { code?: string }[];
        taskRuns?: readonly { outcome?: string; metrics?: { repairMetricsAvailability?: string } }[];
      };
      scorecard?: {
        externalBaselineStatus?: string;
        dimensions?: readonly { dimensionId?: string }[];
      };
      aggregate?: { baselineId?: string; executedRunCount?: number };
      finding?: { code?: string };
      run?: { metrics?: { repairMetricsAvailability?: string } };
    });
    const summary = records.find((record) => record.kind === "diagnostics.evaluate.summary")?.summary;

    assert.deepEqual(summary?.baselines?.map((baseline) => baseline.baselineId), ["deepseek-cli", "codex", "claude-code"]);
    assert.equal(summary?.taskRuns?.every((run) => run.outcome === "planned" || run.outcome === "deferred"), true);
    assert.equal(records.some((record) => record.kind === "diagnostics.evaluate.task-run" && record.run?.metrics?.repairMetricsAvailability === "unavailable"), true);
    assert.equal(summary?.baselineAggregates?.find((item) => item.baselineId === "deepseek-cli")?.executedRunCount, 0);
    assert.equal(summary?.baselineAggregates?.find((item) => item.baselineId === "codex")?.deferredRunCount, 9);
    assert.equal(summary?.baselineAggregates?.find((item) => item.baselineId === "codex")?.commandSuccessRate, undefined);
    assert.equal(summary?.codexClassGapScorecard?.externalBaselineStatus, "deferred");
    assert.equal(summary?.codexClassGapScorecard?.dimensions?.some((dimension) => dimension.dimensionId === "tool-surface"), true);
    assert.equal(summary?.codexClassGapScorecard?.dimensions?.some((dimension) => dimension.dimensionId === "projection"), true);
    assert.equal(summary?.gapFindings?.some((finding) => finding.code === "CLI_EVALUATION_GAP_PENDING_EXECUTION"), true);
    assert.equal(records.some((record) => record.kind === "diagnostics.evaluate.baseline-aggregate" && record.aggregate?.baselineId === "deepseek-cli"), true);
    assert.equal(records.some((record) => record.kind === "diagnostics.evaluate.codex-class-gap-scorecard" && record.scorecard?.externalBaselineStatus === "deferred"), true);
    assert.equal(records.some((record) => record.kind === "diagnostics.evaluate.gap-finding" && record.finding?.code === "CLI_EVALUATION_GAP_PENDING_EXECUTION"), true);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("probes configured diagnostics evaluate codex baseline without task execution", async () => {
    const platform = new FakePlatformRuntime("fake", "/workspace");
    await platform.writeFile(join(process.cwd(), "tests/evaluation/task-catalog.json"), JSON.stringify({
      catalogVersion: "test-catalog",
      tasks: [{
        taskId: "eval.test",
        title: "Test task",
        category: "bug-fix",
        fixtureId: "fixture.test",
        workspaceSnapshotId: "snapshot.test",
        promptDigest: "sha256:test",
        promptSummary: "Test prompt",
        allowedCapabilityProfile: "local-edit-test",
        timeBudgetMs: 1000,
        checkCommands: ["npm test"],
        scoringRubricId: "rubric.test",
        mode: "smoke"
      }]
    }));
    const summary = await collectCliEvaluation({
      mode: "smoke",
      dryRun: true,
      live: false,
      baselineId: "codex",
      compareBaselineIds: [],
      allowExternalBaseline: true,
      baselineCommand: "codex",
      baselineArgs: ["--version"],
      extraArgs: [],
      platform
    });

    assert.equal(summary.status, "pass");
    assert.equal(summary.baselines[0]?.baselineId, "codex");
    assert.equal(summary.baselines[0]?.status, "available");
    assert.equal(summary.baselines[0]?.configured, true);
    assert.equal(summary.baselines[0]?.probeExitCode, 0);
    assert.equal(summary.baselines[0]?.versionCommand, "codex --version");
    assert.equal(typeof summary.baselines[0]?.commandFingerprint, "string");
    assert.equal(summary.baselines[0]?.probeOutputPreview?.includes('"command":"codex"'), true);
    assert.equal(summary.taskRuns[0]?.outcome, "planned");
    assert.equal(summary.taskRuns[0]?.checks[0]?.status, "skipped");
  });

  it("executes webpage generation in an isolated baseline workspace", async () => {
    const platform = new FakeWebpageAgentPlatform();
    const summary = await collectCliEvaluation({
      mode: "full",
      dryRun: false,
      live: false,
      baselineId: "codex",
      compareBaselineIds: ["codex"],
      allowExternalBaseline: true,
      codexCommand: "fake-web-agent",
      baselineArgs: [],
      executeTaskId: "eval.webpage.generation",
      extraArgs: [],
      platform
    });
    const webpageRun = summary.taskRuns.find((run) => run.task.taskId === "eval.webpage.generation");
    const aggregate = summary.baselineAggregates.find((item) => item.baselineId === "codex");
    const workspacePath = webpageRun?.evidencePaths[0] ?? "";

    assert.equal(webpageRun?.outcome, "solved");
    assert.equal(webpageRun?.dryRun, false);
    assert.equal(webpageRun?.checks[0]?.status, "pass");
    assert.equal(webpageRun?.outcomeGate?.status, "pass");
    assert.equal(webpageRun?.outcomeGate?.commandPassed, true);
    assert.equal(webpageRun?.outcomeGate?.checksPassed, true);
    assert.equal(webpageRun?.outcomeGate?.artifactsPresent, true);
    assert.equal(webpageRun?.outcomeGate?.evidencePresent, true);
    assert.equal(webpageRun?.outcomeGate?.terminalEventPresent, true);
    assert.equal(webpageRun?.metrics.firstRunSuccess, true);
    assert.equal(webpageRun?.metrics.commandRunCount, 2);
    assert.equal(webpageRun?.metrics.commandSuccessCount, 2);
    assert.equal(webpageRun?.metrics.commandSuccessRate, 1);
    assert.equal(webpageRun?.metrics.generatedHtmlFileCount, 1);
    assert.equal(webpageRun?.metrics.generatedCssFileCount, 1);
    assert.equal(webpageRun?.metrics.generatedJsFileCount, 1);
    assert.equal((webpageRun?.metrics.codeStructureScore ?? 0) >= 0.85, true);
    assert.equal(webpageRun?.metrics.evidencePlanPresent, true);
    assert.equal(webpageRun?.metrics.evidenceManifestStatus, "passed");
    assert.equal(webpageRun?.metrics.evidenceItemCount, 3);
    assert.equal(webpageRun?.metrics.evidenceSourceCoverageRate, 1);
    assert.equal(webpageRun?.metrics.claimGroundingRate, 1);
    assert.equal(webpageRun?.metrics.unsupportedClaimCount, 0);
    assert.equal(webpageRun?.metrics.hallucinatedCommandCount, 0);
    assert.equal(aggregate?.executedRunCount, 1);
    assert.equal(aggregate?.solvedRunCount, 1);
    assert.equal(aggregate?.successRate, 1);
    assert.equal(aggregate?.commandRunCount, 2);
    assert.equal(aggregate?.commandSuccessCount, 2);
    assert.equal(aggregate?.commandSuccessRate, 1);
    assert.deepEqual(webpageRun?.instrumentationEvents.map((event) => event.kind), [
      "run_started",
      "workspace_created",
      "evidence_written",
      "prompt_written",
      "prompt_sent",
      "command_started",
      "command_finished",
      "checker_started",
      "checker_finished",
      "artifact_scan_started",
      "artifact_scan_finished",
      "evidence_written",
      "run_finished"
    ]);
    assert.equal(webpageRun?.instrumentationEvents.every((event, index) => event.sequence === index + 1), true);
    assert.equal(webpageRun?.instrumentationEvents.find((event) => event.kind === "command_finished")?.metadata.exitCode, 0);
    assert.equal(webpageRun?.instrumentationEvents.find((event) => event.kind === "checker_finished")?.metadata.exitCode, 0);
    assert.equal(workspacePath.includes("deepseek-evaluation-runs"), true);
    assert.equal(resolve(workspacePath).startsWith(resolve(process.cwd())), false);
    assert.equal(platform.executedWorkspaces.length, 1);
    assert.equal(resolve(platform.executedWorkspaces[0] ?? "").startsWith(resolve(process.cwd())), false);
  });

  it("collects DeepSeek prompt assembly metrics during webpage evaluation", async () => {
    const platform = new FakeWebpageAgentPlatform();
    const summary = await collectCliEvaluation({
      mode: "full",
      dryRun: false,
      live: false,
      baselineId: "deepseek-cli",
      compareBaselineIds: ["deepseek-cli"],
      allowExternalBaseline: false,
      baselineArgs: [],
      executeTaskId: "eval.webpage.generation",
      extraArgs: [],
      platform
    });
    const webpageRun = summary.taskRuns.find((run) => run.task.taskId === "eval.webpage.generation");

    assert.equal(webpageRun?.outcome, "solved");
    assert.equal(webpageRun?.metrics.promptAssemblyAvailable, true);
    assert.equal(webpageRun?.metrics.promptAssemblyFingerprint, "assembly-test");
    assert.equal(webpageRun?.metrics.promptAssemblySectionCount, 3);
    assert.equal(webpageRun?.metrics.promptAssemblyExcludedSectionCount, 0);
    assert.equal(webpageRun?.metrics.promptAssemblyBudgetStatus, "within-budget");
    assert.equal(webpageRun?.metrics.promptAssemblyVisibleToolCount, 4);
    assert.equal(webpageRun?.metrics.promptAssemblyGapReason, "post-assembly-model-failure");
    assert.equal(webpageRun?.metrics.evidenceManifestStatus, "passed");
    assert.equal(webpageRun?.metrics.repairMetricsAvailability, "available");
    assert.equal(webpageRun?.metrics.repairActivationCount, 1);
    assert.equal(webpageRun?.metrics.repairSuccessCount, 1);
    assert.equal(webpageRun?.metrics.repairSuccessRate, 1);
    assert.equal(webpageRun?.diagnostics.some((item) => item.code === "CLI_EVALUATION_PROMPT_ASSEMBLY_MISSING"), false);
  });

  it("streams safe diagnostics evaluate progress without exposing raw model deltas", async () => {
    const progressLines: string[] = [];
    const platform = new FakeWebpageAgentPlatform({ streamProgressEvents: true });
    const evaluationOptions = {
      mode: "full" as const,
      dryRun: false,
      live: false,
      baselineId: "deepseek-cli",
      compareBaselineIds: ["deepseek-cli"],
      allowExternalBaseline: false,
      baselineArgs: [],
      executeTaskId: "eval.webpage.generation",
      extraArgs: [],
      platform,
      progressSink: { emit: (line: string) => progressLines.push(line) }
    };

    const summary = await collectCliEvaluation(evaluationOptions as Parameters<typeof collectCliEvaluation>[0]);
    const text = progressLines.join("\n");

    assert.equal(summary.taskRuns.find((run) => run.task.taskId === "eval.webpage.generation")?.outcome, "solved");
    assert.equal(text.includes("progress eval.webpage.generation: task started baseline=deepseek-cli"), true);
    assert.equal(text.includes("progress eval.webpage.generation: agent command started"), true);
    assert.equal(text.includes("progress eval.webpage.generation: tool core.file.read started"), true);
    assert.equal(text.includes("progress eval.webpage.generation: tool core.file.read success"), true);
    assert.equal(text.includes("progress eval.webpage.generation: checker started"), true);
    assert.equal(text.includes("progress eval.webpage.generation: checker pass exit=0"), true);
    assert.equal(text.includes("progress eval.webpage.generation: task solved"), true);
    assert.equal(text.includes("secret raw delta"), false);
  });

  it("does not solve structurally valid webpages without evidence grounding", async () => {
    const platform = new FakeWebpageAgentPlatform({ omitEvidenceManifest: true });
    const summary = await collectCliEvaluation({
      mode: "full",
      dryRun: false,
      live: false,
      baselineId: "codex",
      compareBaselineIds: ["codex"],
      allowExternalBaseline: true,
      codexCommand: "fake-web-agent",
      baselineArgs: [],
      executeTaskId: "eval.webpage.generation",
      extraArgs: [],
      platform
    });
    const webpageRun = summary.taskRuns.find((run) => run.task.taskId === "eval.webpage.generation");

    assert.equal(webpageRun?.outcome, "invalid");
    assert.equal(webpageRun?.outcomeGate?.status, "fail");
    assert.equal(webpageRun?.outcomeGate?.reasonCodes.includes("evidence-missing"), true);
    assert.equal(webpageRun?.checks[0]?.status, "fail");
    assert.equal(webpageRun?.metrics.evidenceManifestStatus, "missing");
    assert.equal(webpageRun?.metrics.evidenceSourceCoverageRate, 0);
    assert.equal(webpageRun?.diagnostics.some((item) => item.code === "CLI_EVALUATION_WEBPAGE_MISSING_EVIDENCE_MANIFEST"), true);
  });

  it("propagates opt-in live DeepSeek webpage execution with write-capable tool projection", async () => {
    const platform = new FakeWebpageAgentPlatform();
    const summary = await collectCliEvaluation({
      mode: "full",
      dryRun: false,
      live: true,
      baselineId: "deepseek-cli",
      compareBaselineIds: ["deepseek-cli"],
      allowExternalBaseline: false,
      baselineArgs: [],
      executeTaskId: "eval.webpage.generation",
      extraArgs: [],
      platform
    });
    const deepseekCommand = platform.executedCommands.find((command) => command.command === process.execPath);
    const webpageRun = summary.taskRuns.find((run) => run.task.taskId === "eval.webpage.generation");

    assert.equal(webpageRun?.outcome, "solved");
    assert.equal(deepseekCommand?.args.includes("--live"), true);
    assert.equal(deepseekCommand?.args.includes("--tool-projection"), true);
    assert.equal(deepseekCommand?.args.includes("read-write"), true);
    assert.equal(deepseekCommand?.args.includes("--timeout-ms"), true);
    assert.equal(deepseekCommand?.args.some((arg) => arg.includes("Use the available local file tools to write the files")), true);
    assert.equal(JSON.stringify(summary).includes("DEEPSEEK_API_KEY"), false);
  });

  it("passes live DeepSeek credentials from a local env file to the isolated child process without logging the secret", async () => {
    await withTempCwd("deepseek-cli-eval-env-", async () => {
      await writeFile(".env", "DEEPSEEK_API_KEY=fixture-eval-secret\n", "utf8");
      await mkdir("tests/evaluation", { recursive: true });
      await writeFile("tests/evaluation/task-catalog.json", JSON.stringify({
        catalogVersion: "test-catalog",
        tasks: [{
          taskId: "eval.webpage.generation",
          title: "Generate webpage",
          category: "webpage-generation",
          fixtureId: "fixture.web",
          workspaceSnapshotId: "snapshot.web",
          promptDigest: "sha256:web",
          promptSummary: "Create local webpage files.",
          allowedCapabilityProfile: "local-create-web-assets",
          timeBudgetMs: 1000,
          checkCommands: ["node scripts/check-webpage-generation.mjs tests/evaluation/generated-webpage"],
          scoringRubricId: "rubric.web",
          mode: "full"
        }]
      }), "utf8");
      const platform = new FakeWebpageAgentPlatform();
      const summary = await collectCliEvaluation({
        mode: "full",
        dryRun: false,
        live: true,
        baselineId: "deepseek-cli",
        compareBaselineIds: ["deepseek-cli"],
        allowExternalBaseline: false,
        baselineArgs: [],
        executeTaskId: "eval.webpage.generation",
        extraArgs: [],
        platform
      });
      const deepseekCommand = platform.executedCommands.find((command) => command.command === process.execPath);

      assert.equal(deepseekCommand?.env?.DEEPSEEK_API_KEY, "fixture-eval-secret");
      assert.equal(JSON.stringify(summary).includes("fixture-eval-secret"), false);
    });
  });

  it("passes live GLM provider selection and credentials to the isolated evaluation child process", async () => {
    await withTempCwd("deepseek-cli-eval-glm-env-", async () => {
      await writeFile(".env", "GLM_ANTHROPIC_API_KEY=fixture-glm-eval-secret\n", "utf8");
      await mkdir("tests/evaluation", { recursive: true });
      await writeFile("tests/evaluation/task-catalog.json", JSON.stringify({
        catalogVersion: "test-catalog",
        tasks: [{
          taskId: "eval.webpage.generation",
          title: "Generate webpage",
          category: "webpage-generation",
          fixtureId: "fixture.web",
          workspaceSnapshotId: "snapshot.web",
          promptDigest: "sha256:web",
          promptSummary: "Create local webpage files.",
          allowedCapabilityProfile: "local-create-web-assets",
          timeBudgetMs: 1000,
          checkCommands: ["node scripts/check-webpage-generation.mjs tests/evaluation/generated-webpage"],
          scoringRubricId: "rubric.web",
          mode: "full"
        }]
      }), "utf8");
      const platform = new FakeWebpageAgentPlatform();
      const evaluationOptions = {
        mode: "full" as const,
        dryRun: false,
        live: true,
        baselineId: "deepseek-cli",
        compareBaselineIds: ["deepseek-cli"],
        allowExternalBaseline: false,
        baselineArgs: [],
        executeTaskId: "eval.webpage.generation",
        extraArgs: [],
        modelProvider: "glm" as const,
        model: "glm-5.1",
        platform
      };
      const summary = await collectCliEvaluation(evaluationOptions);
      const deepseekCommand = platform.executedCommands.find((command) => command.command === process.execPath);

      assert.equal(summary.taskRuns.find((run) => run.task.taskId === "eval.webpage.generation")?.baseline.baselineId, "deepseek-cli");
      assert.equal(deepseekCommand?.args.includes("--provider"), true);
      assert.equal(deepseekCommand?.args.includes("glm"), true);
      assert.equal(deepseekCommand?.args.includes("--model"), true);
      assert.equal(deepseekCommand?.args.includes("glm-5.1"), true);
      assert.equal(deepseekCommand?.env?.GLM_ANTHROPIC_API_KEY, "fixture-glm-eval-secret");
      assert.equal(deepseekCommand?.env?.DEEPSEEK_CLI_LAUNCH_CWD, process.cwd());
      assert.equal(JSON.stringify(summary).includes("fixture-glm-eval-secret"), false);
    });
  });

  it("records GLM provider invocation in overall delivery score evidence", async () => {
    await withTempCwd("deepseek-cli-eval-glm-score-", async () => {
      await writeFile(".env", "GLM_ANTHROPIC_API_KEY=fixture-glm-score-secret\n", "utf8");
      await mkdir("tests/evaluation", { recursive: true });
      await writeFile("tests/evaluation/task-catalog.json", JSON.stringify({
        catalogVersion: "test-catalog",
        tasks: [{
          taskId: "eval.webpage.generation",
          title: "Generate webpage",
          category: "webpage-generation",
          fixtureId: "fixture.web",
          workspaceSnapshotId: "snapshot.web",
          promptDigest: "sha256:web",
          promptSummary: "Create local webpage files.",
          allowedCapabilityProfile: "local-create-web-assets",
          timeBudgetMs: 1000,
          checkCommands: ["node scripts/check-webpage-generation.mjs tests/evaluation/generated-webpage"],
          scoringRubricId: "rubric.web",
          mode: "full"
        }]
      }), "utf8");
      const platform = new FakeWebpageAgentPlatform();
      const evaluationOptions = {
        mode: "full" as const,
        dryRun: false,
        live: true,
        baselineId: "deepseek-cli",
        compareBaselineIds: ["deepseek-cli"],
        allowExternalBaseline: false,
        baselineArgs: [],
        executeTaskId: "all",
        extraArgs: [],
        modelProvider: "glm" as const,
        model: "glm-5.1",
        platform
      };
      const evaluation = await collectCliEvaluation(evaluationOptions);
      const modeMatrix = await collectModeMatrix();
      const delivery = collectDeliveryCapabilitySummary(evaluation, modeMatrix);
      assert.ok(delivery);

      const evidence = buildEvaluationDeliveryCapabilityEvidence(evaluation, delivery, evaluationOptions, "json");
      const serialized = JSON.stringify(evidence);
      const invocation = evidence.invocation as { provider?: string; model?: string; live?: boolean; baselines?: readonly string[] } | undefined;

      assert.equal(invocation?.provider, "glm");
      assert.equal(invocation?.model, "glm-5.1");
      assert.equal(invocation?.live, true);
      assert.deepEqual(invocation?.baselines, ["deepseek-cli"]);
      assert.equal(String(evidence.command).includes("--provider glm"), true);
      assert.equal(String(evidence.command).includes("--model glm-5.1"), true);
      assert.equal(String(evidence.command).includes("--output json"), true);
      assert.equal(serialized.includes("fixture-glm-score-secret"), false);
    });
  });

  it("passes the reference tool arsenal gate when all reference tools are executable", () => {
    const delivery = collectDeliveryCapabilitySummary({ taskRuns: [], packageScorecards: [] }, undefined);

    assert.ok(delivery);
    const arsenal = delivery.dimensions.find((dimension) => dimension.dimensionId === "tool-arsenal");
    assert.ok(arsenal);
    assert.equal(arsenal.status, "pass");
    assert.equal(arsenal.blockingIds.some((id) => id.includes("McpAuthTool")), false);
    assert.equal(arsenal.blockingIds.some((id) => id.includes("MCPTool")), false);
    assert.equal(arsenal.blockingIds.some((id) => id.includes("PowerShellTool")), false);
    assert.equal(arsenal.blockingIds.some((id) => id.includes("AskUserQuestionTool")), false);
    assert.equal(delivery.blockingToolArsenalIds.some((id) => id.includes("McpAuthTool")), false);
    assert.equal(delivery.toolArsenalGatePassed, true);
  });

  it("accepts diagnostics evaluate --live without unsupported-argument diagnostics", async () => {
    const lines: string[] = [];
    await runCli([
      "diagnostics",
      "evaluate",
      "--live",
      "--full",
      "--dry-run",
      "--compare-baseline",
      "deepseek-cli",
      "--output",
      "json"
    ], (line: string) => {
      lines.push(line);
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      status?: string;
      evaluation?: { diagnostics?: readonly { code?: string }[] };
    };

    assert.equal(parsed.status, "pass");
    assert.equal(parsed.evaluation?.diagnostics?.some((item) => item.code === "CLI_EVALUATION_INVALID_ARGS"), false);
  });

  it("includes interaction and agent mode matrices in diagnostics output", async () => {
    const lines: string[] = [];
    await runCli(["diagnostics", "evaluate", "--dry-run", "--output", "jsonl"], (line: string) => {
      lines.push(line);
    });
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      matrix?: { interactionModes?: readonly { mode?: string; status?: string; nextTasks?: readonly string[] }[]; agentModes?: readonly { mode?: string; status?: string }[] };
      mode?: { mode?: string; status?: string; productRole?: string };
    });
    const matrix = records.find((record) => record.kind === "diagnostics.mode-matrix.summary")?.matrix;

    assert.equal(matrix?.interactionModes?.some((mode) => mode.mode === "chat" && mode.status === "complete"), true);
    assert.equal(matrix?.interactionModes?.some((mode) => mode.mode === "remote" && mode.status === "complete"), true);
    assert.equal(matrix?.agentModes?.some((mode) => mode.mode === "verifier" && mode.status === "complete"), true);
    assert.equal(matrix?.agentModes?.some((mode) => mode.mode === "coordinator" && mode.status === "complete"), true);
    assert.equal(records.some((record) => record.kind === "diagnostics.mode-matrix.agent" && record.mode?.mode === "verifier" && record.mode.productRole === "verifier"), true);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("records evaluation mode metrics and unavailable external baseline instrumentation separately", async () => {
    const platform = new FakeWebpageAgentPlatform({ includeRuntimeSignals: true });
    const summary = await collectCliEvaluation({
      mode: "full",
      dryRun: false,
      live: false,
      baselineId: "codex",
      compareBaselineIds: ["codex"],
      allowExternalBaseline: true,
      codexCommand: "fake-web-agent",
      baselineArgs: [],
      executeTaskId: "eval.webpage.generation",
      extraArgs: [],
      platform
    });
    const webpageRun = summary.taskRuns.find((run) => run.task.taskId === "eval.webpage.generation");
    const aggregate = summary.baselineAggregates.find((item) => item.baselineId === "codex");

    assert.equal(webpageRun?.outcome, "solved");
    assert.equal(webpageRun?.metrics.evidenceCredit, true);
    assert.equal(webpageRun?.metrics.verificationCredit, true);
    assert.equal(webpageRun?.metrics.phaseUsage?.some((phase) => phase.phase === "verify" && phase.evidenceSource === "checker"), true);
    assert.equal(webpageRun?.metrics.loopBudgets?.some((budget) => budget.kind === "verification" && budget.evidenceSource === "unavailable"), true);
    assert.equal(webpageRun?.metrics.metricAvailability?.some((metric) => metric.metric === "loop_budgets" && metric.status === "unavailable"), true);
    assert.equal(aggregate?.verificationCreditRate, 1);
    assert.equal((aggregate?.unavailableMetricCount ?? 0) > 0, true);
  });

  it("scores runtime verification credit independently from reasoning effort", async () => {
    const platform = new FakeWebpageAgentPlatform({ includeRuntimeSignals: true, runtimeReasoningOnly: true });
    const summary = await collectCliEvaluation({
      mode: "full",
      dryRun: false,
      live: false,
      baselineId: "deepseek-cli",
      compareBaselineIds: ["deepseek-cli"],
      allowExternalBaseline: false,
      baselineArgs: [],
      executeTaskId: "eval.webpage.generation",
      extraArgs: [],
      platform
    });
    const webpageRun = summary.taskRuns.find((run) => run.task.taskId === "eval.webpage.generation");

    assert.equal(webpageRun?.metrics.reasoningEffort, "xhigh");
    assert.equal(webpageRun?.metrics.providerMappedEffort, "max");
    assert.equal(webpageRun?.metrics.evidenceCredit, false);
    assert.equal(webpageRun?.metrics.verificationCredit, false);
    assert.equal(webpageRun?.metrics.verifierQuality, "missing");
    assert.equal(webpageRun?.metrics.metricAvailability?.some((metric) => metric.metric === "reasoning_effort" && metric.status === "instrumented"), true);
  });

  it("renders diagnostics verify blockers as JSONL", async () => {
    const lines = await withTempReleaseRepo("deepseek-cli-verify-blocked-", { buildOutput: false, acceptanceEvidence: true }, async () => {
      const output: string[] = [];
      await runCli(["diagnostics", "verify", "--output", "jsonl"], (line: string) => {
        output.push(line);
      });
      return output;
    });
    const records = lines.map((line) => JSON.parse(line) as {
      kind?: string;
      status?: string;
      summary?: { status?: string; publishDryRunReady?: boolean; nextAction?: string; blockingChecks?: readonly { id?: string }[] };
      check?: { id?: string };
    });
    const summary = records.find((record) => record.kind === "diagnostics.verify.summary");

    assert.equal(records[0]?.kind, "diagnostics.verify");
    assert.equal(records[0]?.status, "fail");
    assert.equal(summary?.summary?.status, "blocked");
    assert.equal(summary?.summary?.publishDryRunReady, false);
    assert.equal(summary?.summary?.blockingChecks?.some((check) => check.id === "release.build-output"), true);
    assert.equal(summary?.summary?.nextAction, "Run npm run build:cli before publishing.");
    assert.equal(records.some((record) => record.kind === "diagnostics.verify.blocker" && record.check?.id === "release.build-output"), true);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("renders diagnostics verify warnings and ready text", async () => {
    const warningLines = await withTempReleaseRepo("deepseek-cli-verify-warn-", { buildOutput: true, acceptanceEvidence: false }, async () => {
      const output: string[] = [];
      await runCli(["diagnostics", "verify", "--output", "json"], (line: string) => {
        output.push(line);
      });
      return output;
    });
    const warning = JSON.parse(warningLines[0] ?? "{}") as {
      kind?: string;
      status?: string;
      verificationSummary?: { status?: string; missingAcceptanceEvidencePaths?: readonly string[]; warningChecks?: readonly { id?: string }[]; publishDryRunReady?: boolean };
    };

    assert.equal(warning.kind, "diagnostics.verify");
    assert.equal(warning.status, "warn");
    assert.equal(warning.verificationSummary?.status, "warn");
    assert.equal(warning.verificationSummary?.publishDryRunReady, false);
    assert.equal(warning.verificationSummary?.warningChecks?.some((check) => check.id === "release.acceptance"), true);
    assert.equal(warning.verificationSummary?.missingAcceptanceEvidencePaths?.includes("tests/acceptance/latest/typecheck.txt"), true);

    const readyLines = await withTempReleaseRepo("deepseek-cli-verify-ready-", { buildOutput: true, acceptanceEvidence: true }, async () => {
      const output: string[] = [];
      await runCli(["diagnostics", "verify"], (line: string) => {
        output.push(line);
      });
      return output;
    });
    const text = readyLines.join("\n");

    assert.equal(text.includes("diagnostics.verify: pass"), true);
    assert.equal(text.includes("- verification: ready"), true);
    assert.equal(text.includes("- publish dry-run ready: true"), true);
    assert.equal(text.includes("- next action: npm publish --dry-run --workspace deepseek-agent-cli --access public"), true);
    assert.equal(text.includes("\u001b["), false);
  });

  it("renders diagnostics doctor without live provider calls", async () => {
    const lines = await withTempCwd("deepseek-cli-doctor-", async () => {
      const output: string[] = [];
      await runCli(["diagnostics", "doctor", "--output", "json"], (line: string) => {
        output.push(line);
      });
      return output;
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      kind?: string;
      indexProviders?: { enabledProviderIds?: string[]; deferredProviderIds?: string[]; source?: { scope?: string }; providers?: readonly { providerId?: string; requestedStatus?: string; implementationStatus?: string }[] };
      readiness?: { metadata?: { liveRequested?: boolean }; checks?: readonly { id?: string }[] };
      release?: { checks?: readonly { id?: string }[] };
    };

    assert.equal(parsed.kind, "diagnostics.doctor");
    assert.equal(parsed.readiness?.metadata?.liveRequested, false);
    assert.equal(parsed.readiness?.checks?.some((check) => check.id === "doctor.live"), true);
    assert.equal(parsed.readiness?.checks?.some((check) => check.id === "index-provider.pageindex"), true);
    assert.equal(parsed.indexProviders?.enabledProviderIds?.includes("pageindex"), true);
    assert.equal(parsed.indexProviders?.deferredProviderIds?.includes("zvec"), true);
    assert.equal(parsed.indexProviders?.source?.scope, "default");
    assert.equal(parsed.indexProviders?.providers?.some((provider) => provider.providerId === "zvec" && provider.implementationStatus === "missing"), true);
    assert.equal(parsed.release?.checks?.some((check) => check.id === "release.package"), true);
  });

  it("passes GLM provider selection into diagnostics doctor readiness", async () => {
    const lines = await withTempCwd("deepseek-cli-doctor-glm-", async () => {
      const previous = process.env.GLM_ANTHROPIC_API_KEY;
      process.env.GLM_ANTHROPIC_API_KEY = "sk-glm-diagnostics-secret";
      try {
        const output: string[] = [];
        await runCli(["diagnostics", "doctor", "--provider", "glm", "--model", "glm-5.1", "--output", "json"], (line: string) => {
          output.push(line);
        });
        return output;
      } finally {
        if (previous === undefined) delete process.env.GLM_ANTHROPIC_API_KEY;
        else process.env.GLM_ANTHROPIC_API_KEY = previous;
      }
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      readiness?: {
        credential?: { provider?: string; available?: boolean };
        metadata?: { provider?: { provider?: string; model?: string; protocol?: string } };
        checks?: readonly { id?: string; status?: string; metadata?: { provider?: string } }[];
      };
    };
    const credentialCheck = parsed.readiness?.checks?.find((check) => check.id === "auth.glm");

    assert.equal(parsed.readiness?.credential?.provider, "glm");
    assert.equal(parsed.readiness?.credential?.available, true);
    assert.equal(parsed.readiness?.metadata?.provider?.provider, "glm");
    assert.equal(parsed.readiness?.metadata?.provider?.protocol, "anthropic-messages");
    assert.equal(parsed.readiness?.metadata?.provider?.model, "glm-5.1");
    assert.equal(credentialCheck?.status, "pass");
    assert.equal(JSON.stringify(parsed).includes("sk-glm-diagnostics-secret"), false);
  });

  it("renders index provider status without provider execution", async () => {
    const lines = await withTempCwd("deepseek-cli-index-status-", async () => {
      const output: string[] = [];
      await runCli(["index-provider", "status", "--output", "json"], (line: string) => {
        output.push(line);
      });
      return output;
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      kind?: string;
      summary?: { source?: { scope?: string }; enabledProviderIds?: string[]; providers?: readonly { providerId?: string; status?: string; implementationStatus?: string }[] };
    };

    assert.equal(parsed.kind, "index-provider.status");
    assert.equal(parsed.summary?.source?.scope, "default");
    assert.equal(parsed.summary?.enabledProviderIds?.includes("pageindex"), true);
    assert.equal(parsed.summary?.providers?.some((provider) => provider.providerId === "zvec" && provider.status === "deferred" && provider.implementationStatus === "missing"), true);
  });

  it("renders index provider evidence reasons in text mode", async () => {
    const lines = await withTempCwd("deepseek-cli-index-text-", async () => {
      const output: string[] = [];
      await runCli(["index-provider", "status"], (line: string) => {
        output.push(line);
      });
      return output;
    });
    const text = lines.join("\n");

    assert.equal(text.includes("evidence=implementation-module:missing, embedding-provider:missing, vector-store:missing"), true);
    assert.equal(text.includes("missing-evidence=implementation-module, embedding-provider, vector-store"), true);
    assert.equal(text.includes("diagnostics=INDEX_PROVIDER_DEFERRED"), true);
    assert.equal(text.includes("\u001b["), false);
  });

  it("renders diagnostics doctor provider evidence reasons in text mode", async () => {
    const lines = await withTempCwd("deepseek-cli-doctor-text-", async () => {
      const output: string[] = [];
      await runCli(["diagnostics", "doctor"], (line: string) => {
        output.push(line);
      });
      return output;
    });
    const text = lines.join("\n");

    assert.equal(text.includes("index provider zvec: deferred"), true);
    assert.equal(text.includes("evidence=implementation-module:missing, embedding-provider:missing, vector-store:missing"), true);
    assert.equal(text.includes("missing-evidence=implementation-module, embedding-provider, vector-store"), true);
    assert.equal(text.includes("\u001b["), false);
  });

  it("resolves diagnostics doctor readiness through the injected workspace root", async () => {
    await withTempCwd("deepseek-cli-doctor-injected-cwd-", async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "deepseek-cli-doctor-injected-workspace-"));
      try {
        await mkdir(join(workspaceRoot, ".deepseek"), { recursive: true });
        await writeFile(join(workspaceRoot, ".deepseek", "config.json"), `${JSON.stringify({
          schemaVersion: "1.0.0",
          profile: "default",
          values: {
            indexProviders: {
              schemaVersion: "1.0.0",
              kind: "index-provider.manifest",
              defaultProviderId: "pageindex",
              source: {
                scope: "workspace",
                sourceId: "config.indexProviders",
                description: "Injected workspace test config.",
                redaction: { class: "internal", fields: ["sourceId", "description"] }
              },
              providers: [
                {
                  providerId: "zvec",
                  kind: "zvec",
                  status: "enabled",
                  implementationStatus: "missing",
                  metadata: {},
                  redaction: { class: "internal", fields: ["metadata"] }
                }
              ],
              metadata: {},
              redaction: { class: "internal", fields: ["providers.metadata", "source"] }
            }
          },
          source: {
            scope: "workspace",
            priority: 2,
            path: join(workspaceRoot, ".deepseek", "config.json"),
            redaction: { class: "internal", fields: ["path"] }
          },
          redaction: { class: "internal", fields: ["values"] },
          migration: { schemaVersion: "1.0.0" }
        }, null, 2)}\n`);
        const output: string[] = [];
        await runCli(["diagnostics", "doctor", "--output", "json"], (line: string) => {
          output.push(line);
        }, undefined, undefined, { workspaceRoot });
        const parsed = JSON.parse(output[0] ?? "{}") as {
          indexProviders?: { source?: { scope?: string }; providers?: readonly { providerId?: string; requestedStatus?: string; status?: string }[] };
        };
        const zvec = parsed.indexProviders?.providers?.find((provider) => provider.providerId === "zvec");

        assert.equal(parsed.indexProviders?.source?.scope, "workspace");
        assert.equal(zvec?.requestedStatus, "enabled");
        assert.equal(zvec?.status, "deferred");
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  });

  it("writes index provider intent and previews effective downgrade", async () => {
    const lines = await withTempCwd("deepseek-cli-index-set-", async () => {
      const output: string[] = [];
      await runCli(["index-provider", "set", "zvec", "enabled", "--output", "json"], (line: string) => {
        output.push(line);
      });
      return output;
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      kind?: string;
      written?: boolean;
      summary?: { source?: { scope?: string }; providers?: readonly { providerId?: string; status?: string; requestedStatus?: string; implementationStatus?: string }[]; diagnostics?: readonly { code?: string }[] };
    };
    const zvec = parsed.summary?.providers?.find((provider) => provider.providerId === "zvec");

    assert.equal(parsed.kind, "index-provider.set");
    assert.equal(parsed.written, true);
    assert.equal(parsed.summary?.source?.scope, "workspace");
    assert.equal(zvec?.requestedStatus, "enabled");
    assert.equal(zvec?.status, "deferred");
    assert.equal(zvec?.implementationStatus, "missing");
    assert.equal(parsed.summary?.diagnostics?.some((diagnostic) => diagnostic.code === "INDEX_PROVIDER_UNSUPPORTED_ENABLED"), true);
  });

  it("writes index provider workspace config through the injected workspace root", async () => {
    await withTempCwd("deepseek-cli-index-injected-cwd-", async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "deepseek-cli-index-injected-workspace-"));
      try {
        const output: string[] = [];
        await runCli(["index-provider", "set", "zvec", "enabled", "--output", "json"], (line: string) => {
          output.push(line);
        }, undefined, undefined, { workspaceRoot });
        const raw = await readFile(join(workspaceRoot, ".deepseek", "config.json"), "utf8");
        const parsed = JSON.parse(raw) as { values?: { indexProviders?: { providers?: readonly { providerId?: string; status?: string }[] } } };

        assert.equal(parsed.values?.indexProviders?.providers?.some((provider) => provider.providerId === "zvec" && provider.status === "enabled"), true);
        await assert.rejects(stat(join(process.cwd(), ".deepseek", "config.json")));
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  });

  it("rejects invalid index provider arguments before writing config", async () => {
    const lines = await withTempCwd("deepseek-cli-index-invalid-", async () => {
      const output: string[] = [];
      await runCli(["index-provider", "set", "unknown", "enabled", "--output", "json"], (line: string) => {
        output.push(line);
      });
      return output;
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as { ok?: boolean; diagnostics?: readonly { code?: string }[]; written?: boolean };

    assert.equal(parsed.ok, false);
    assert.equal(parsed.written, undefined);
    assert.equal(parsed.diagnostics?.[0]?.code, "INDEX_PROVIDER_CLI_INVALID_ARGUMENT");
  });

  it("writes readiness init workspace config through the injected workspace root", async () => {
    await withTempCwd("deepseek-cli-readiness-injected-cwd-", async () => {
      const workspaceRoot = await mkdtemp(join(tmpdir(), "deepseek-cli-readiness-injected-workspace-"));
      try {
        const output: string[] = [];
        await runCli(["init", "--force", "--output", "json"], (line: string) => {
          output.push(line);
        }, undefined, undefined, { workspaceRoot });
        const raw = await readFile(join(workspaceRoot, ".deepseek", "config.json"), "utf8");
        const parsed = JSON.parse(raw) as { values?: { telemetry?: string; privacy?: string; sandbox?: string } };

        assert.equal(parsed.values?.telemetry, "disabled");
        assert.equal(parsed.values?.privacy, "local");
        assert.equal(parsed.values?.sandbox, "ask");
        await assert.rejects(stat(join(process.cwd(), ".deepseek", "config.json")));
      } finally {
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    });
  });

  it("renders extension list as JSONL result-list records", async () => {
    const lines: string[] = [];
    await runCli(["extension", "list", "--output", "jsonl"], (line: string) => {
      lines.push(line);
    });
    const records = lines.map((line) => JSON.parse(line) as { kind?: string; record?: { referencePitFixtureIds?: string[] }; item?: { targetKind?: string; targetId?: string } });
    const summary = records[0]?.record;

    assert.equal(records[0]?.kind, "extension.list.summary");
    assert.equal(records.some((record) => record.item?.targetKind === "skill"), true);
    assert.equal(records.some((record) => record.item?.targetKind === "credential-scope"), true);
    assert.equal(summary?.referencePitFixtureIds?.includes("pit.legacy-contribution-normalization.manifest-boundary"), true);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("renders extension plugin install permission diff with pit evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepseek-cli-plugin-"));
    const manifestPath = join(dir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify({
      id: "plugin-demo",
      name: "Demo Plugin",
      version: "1.0.0",
      source: "workspace",
      integrity: "sha256:demo",
      permissions: ["workspace:read", "process:execute"],
      contributions: { commands: ["demo"] }
    }), "utf8");
    const lines: string[] = [];
    await runCli(["extension", "plugin", "install", manifestPath, "--output", "json"], (line: string) => {
      lines.push(line);
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as {
      kind?: string;
      permissionDiffs?: readonly { added?: readonly string[]; referencePitFixtureIds?: readonly string[] }[];
      items?: readonly { targetId?: string }[];
    };

    assert.equal(parsed.kind, "extension.plugin.install");
    assert.deepEqual(parsed.permissionDiffs?.[0]?.added, ["process:execute", "workspace:read"]);
    assert.equal(parsed.permissionDiffs?.[0]?.referencePitFixtureIds?.includes("pit.extension-permission-expansion.permission-diff"), true);
    assert.equal(parsed.items?.[0]?.targetId, "plugin:plugin-demo");
  });

  it("renders extension plugin auth diff in text and JSONL without raw secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepseek-cli-plugin-auth-"));
    const manifestPath = join(dir, "plugin-auth.json");
    await writeFile(manifestPath, JSON.stringify({
      id: "plugin-auth",
      name: "Auth Plugin",
      version: "1.0.0",
      source: "workspace",
      integrity: "sha256:auth",
      permissions: ["workspace:read"],
      credentialRequirements: [{
        schemaVersion: "1.0.0",
        requirementId: "req-plugin-auth",
        owner: { kind: "plugin", id: "plugin:plugin-auth", pluginId: "plugin-auth" },
        operations: ["diagnose"],
        provider: "deepseek",
        profile: "default",
        required: true,
        redaction: { class: "internal", fields: ["credentialRef"] },
        compatibility: { schemaVersion: "1.0.0" }
      }],
      contributions: { commands: ["auth-demo"] }
    }), "utf8");

    const textLines: string[] = [];
    await runCli(["extension", "plugin", "install", manifestPath, "--output", "text"], (line: string) => {
      textLines.push(line);
    });
    assert.equal(textLines.some((line) => line.includes("auth-diff: +1 -0")), true);
    assert.equal(textLines.join("\n").includes("sk-extension-secret-123456789"), false);

    const jsonlLines: string[] = [];
    await runCli(["extension", "plugin", "install", manifestPath, "--output", "jsonl"], (line: string) => {
      jsonlLines.push(line);
    });
    const records = jsonlLines.map((line) => JSON.parse(line) as { kind?: string; diff?: { added?: readonly { requirementId?: string }[]; referencePitFixtureIds?: readonly string[] } });
    assert.equal(records.some((record) => record.kind === "extension.auth-diff" && record.diff?.added?.[0]?.requirementId === "req-plugin-auth"), true);
    assert.equal(records.some((record) => record.kind === "extension.auth-diff" && record.diff?.referencePitFixtureIds?.includes("pit.extension-auth.credential-scope-denial")), true);
    assert.equal(jsonlLines.join("\n").includes("sk-extension-secret-123456789"), false);
  });

  it("renders extension plugin apply-lockfile as JSONL lifecycle records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepseek-cli-lockfile-"));
    const lockfilePath = join(dir, "deepseek-plugin-lock.json");
    await writeFile(lockfilePath, JSON.stringify({
      version: 1,
      entries: [{
        pluginId: "plugin-locked",
        version: "1.2.3",
        source: "workspace",
        integrity: "sha256:locked",
        permissions: ["workspace:read"],
        installedAt: "1970-01-01T00:00:00.000Z"
      }]
    }), "utf8");
    const lines: string[] = [];
    await runCli(["extension", "plugin", "apply-lockfile", lockfilePath, "--output", "jsonl"], (line: string) => {
      lines.push(line);
    });
    const records = lines.map((line) => JSON.parse(line) as { kind?: string; step?: { targetId?: string }; diff?: { targetId?: string } });

    assert.equal(records[0]?.kind, "extension.plugin.apply-lockfile.summary");
    assert.equal(records.some((record) => record.kind === "extension.lifecycle" && record.step?.targetId === "plugin-lock-entry:plugin-locked"), true);
    assert.equal(records.some((record) => record.kind === "extension.permission-diff" && record.diff?.targetId === "plugin:plugin-locked"), true);
  });

  it("renders extension skill activation without full context segment text", async () => {
    const lines: string[] = [];
    await runCli(["extension", "skill", "activate", "repo-summary", "--output", "json"], (line: string) => {
      lines.push(line);
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as { kind?: string; lifecycle?: readonly { metadata?: { segmentCount?: number } }[] };
    const serialized = lines.join("\n");

    assert.equal(parsed.kind, "extension.skill.activate");
    assert.equal((parsed.lifecycle?.[0]?.metadata?.segmentCount ?? 0) > 0, true);
    assert.equal(serialized.includes("Use repo-summary guidance when explicitly activated."), false);
  });

  it("renders extension auth scopes without raw environment credentials", async () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-extension-secret-123456789";
    try {
      const lines: string[] = [];
      await runCli(["extension", "auth", "scopes", "--output", "json"], (line: string) => {
        lines.push(line);
      });
      const parsed = JSON.parse(lines[0] ?? "{}") as { kind?: string; credentialScopes?: readonly { source?: string; referencePitFixtureIds?: readonly string[] }[] };
      const serialized = lines.join("\n");

      assert.equal(parsed.kind, "extension.auth.scopes");
      assert.equal(parsed.credentialScopes?.[0]?.source, "fake-storage");
      assert.equal(parsed.credentialScopes?.[0]?.referencePitFixtureIds?.includes("pit.env-snapshot.immutable-startup"), true);
      assert.equal(serialized.includes("sk-extension-secret-123456789"), false);
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });

  it("projects extension MCP test through governed gateway results", async () => {
    const dir = await mkdtemp(join(tmpdir(), "deepseek-cli-mcp-"));
    const manifestPath = join(dir, "mcp.json");
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: "1.0.0",
      id: "mcp-demo",
      name: "Demo MCP",
      version: "1.0.0",
      namespace: "demo",
      source: "workspace",
      trust: "trusted",
      transport: { kind: "fake" },
      permissions: ["mcp:read"],
      timeoutMs: 1000,
      tools: [{
        name: "ping",
        inputSchema: {},
        permissions: ["tool:read"]
      }]
    }), "utf8");
    const lines: string[] = [];
    await runCli(["extension", "mcp", "test", manifestPath, "--output", "json"], (line: string) => {
      lines.push(line);
    });
    const parsed = JSON.parse(lines[0] ?? "{}") as { kind?: string; items?: readonly { targetKind?: string; targetId?: string }[]; referencePitFixtureIds?: readonly string[] };

    assert.equal(parsed.kind, "extension.mcp.test");
    assert.equal(parsed.items?.some((item) => item.targetKind === "mcp-server" && item.targetId === "mcp:mcp-demo"), true);
    assert.equal(parsed.items?.some((item) => item.targetKind === "mcp-tool" && item.targetId === "mcp-tool:demo.ping"), true);
    assert.equal(parsed.referencePitFixtureIds?.includes("pit.mcp-plugin-precedence.enterprise-deny"), true);
  });

  it("renders scriptable palette list without model or runtime events", async () => {
    const jsonLines: string[] = [];
    await runCli(["palette", "list", "--output", "json"], (line: string) => {
      jsonLines.push(line);
    }, [], { stdinIsTTY: false, stdoutIsTTY: false });
    const projection = JSON.parse(jsonLines[0] ?? "{}") as {
      schemaVersion?: string;
      entries?: readonly { entry?: { id?: string; title?: string }; target?: { id?: string }; referencePitFixtureIds?: readonly string[] }[];
      resultList?: { id?: string; items?: readonly { id?: string; target?: { id?: string } }[] };
    };

    assert.equal(jsonLines.length, 1);
    assert.equal(projection.schemaVersion, "1.0.0");
    assert.equal((projection.entries?.length ?? 0) > 0, true);
    assert.equal(projection.resultList?.id, "result-list:command-palette");
    assert.equal(projection.entries?.some((entry) => entry.entry?.title === "doctor"), true);
    assert.equal(projection.entries?.every((entry) => Array.isArray(entry.referencePitFixtureIds)), true);
    assert.equal(jsonLines.join("\n").includes("agent.loop.started"), false);
    assert.equal(jsonLines.join("\n").includes("\u001b["), false);

    const jsonlLines: string[] = [];
    await runCli(["palette", "list", "--output", "jsonl"], (line: string) => {
      jsonlLines.push(line);
    }, [], { stdinIsTTY: false, stdoutIsTTY: false });
    const records = jsonlLines.map((line) => JSON.parse(line) as { kind?: string; entryCount?: number; entry?: { entry?: { title?: string } } });
    assert.equal(records[0]?.kind, "palette.summary");
    assert.equal((records[0]?.entryCount ?? 0) > 0, true);
    assert.equal(records.some((record) => record.kind === "palette.entry" && record.entry?.entry?.title === "doctor"), true);
    assert.equal(jsonlLines.join("\n").includes("\u001b["), false);

    const textLines: string[] = [];
    await runCli(["palette", "list", "--output", "text"], (line: string) => {
      textLines.push(line);
    }, [], { stdinIsTTY: false, stdoutIsTTY: false });
    assert.equal(textLines[0]?.startsWith("palette: "), true);
    assert.equal(textLines.some((line) => line.includes("doctor")), true);
  });

  it("renders scriptable vi keymap profile", async () => {
    const lines: string[] = [];
    await runCli(["palette", "keymap", "vi-minimal", "--output", "json"], (line: string) => {
      lines.push(line);
    }, [], { stdinIsTTY: false, stdoutIsTTY: false });
    const profile = JSON.parse(lines[0] ?? "{}") as {
      name?: string;
      diagnostics?: readonly unknown[];
      contributions?: readonly { id?: string; keymap?: { key?: string; action?: string; mode?: string } }[];
    };

    assert.equal(profile.name, "vi-minimal");
    assert.equal(profile.diagnostics?.length, 0);
    assert.equal(profile.contributions?.some((contribution) => contribution.keymap?.key === "j" && contribution.keymap.action === "next"), true);
    assert.equal(profile.contributions?.some((contribution) => contribution.keymap?.key === "G" && contribution.keymap.action === "last"), true);
    assert.equal(lines.join("\n").includes("\u001b["), false);
  });

  it("resolves scriptable palette actions as dry-run typed results", async () => {
    const inspectLines: string[] = [];
    await runCli(["palette", "action", "inspect", "command:readiness.doctor", "--output", "json"], (line: string) => {
      inspectLines.push(line);
    }, [], { stdinIsTTY: false, stdoutIsTTY: false });
    const inspect = JSON.parse(inspectLines[0] ?? "{}") as {
      ok?: boolean;
      action?: string;
      target?: { id?: string };
      update?: { commandDescriptor?: { kind?: string; dryRun?: boolean; target?: { id?: string } } };
      diagnostics?: readonly unknown[];
    };

    assert.equal(inspect.ok, true);
    assert.equal(inspect.action, "inspect");
    assert.equal(inspect.target?.id, "command:readiness.doctor");
    assert.equal(inspect.update?.commandDescriptor?.kind, "cli.inspect");
    assert.equal(inspect.update?.commandDescriptor?.dryRun, true);
    assert.equal(inspect.diagnostics?.length, 0);

    const addLines: string[] = [];
    await runCli(["palette", "action", "add-to-reference-set", "command:readiness.doctor", "--output", "json"], (line: string) => {
      addLines.push(line);
    }, [], { stdinIsTTY: false, stdoutIsTTY: false });
    const add = JSON.parse(addLines[0] ?? "{}") as { ok?: boolean; update?: { referenceSets?: readonly { items?: readonly { target?: { id?: string } }[] }[] } };
    assert.equal(add.ok, true);
    assert.equal(add.update?.referenceSets?.[0]?.items?.[0]?.target?.id, "command:readiness.doctor");

    const missingLines: string[] = [];
    await runCli(["palette", "action", "inspect", "missing-target", "--output", "json"], (line: string) => {
      missingLines.push(line);
    }, [], { stdinIsTTY: false, stdoutIsTTY: false });
    const missing = JSON.parse(missingLines[0] ?? "{}") as { ok?: boolean; diagnostics?: readonly { code?: string; targetIds?: readonly string[] }[] };
    assert.equal(missing.ok, false);
    assert.equal(missing.diagnostics?.[0]?.code, "CLI_ACTION_TARGET_NOT_FOUND");
    assert.deepEqual(missing.diagnostics?.[0]?.targetIds, ["missing-target"]);
  });
});

class ToolCallingModelGateway implements ModelGateway {
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.messages?.some((message) => message.role === "tool")) {
      yield { kind: "delta", text: "Read completed." };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "tool-call", id: "call-readme", name: "core.file.read", input: { path: "./README.md" } };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class SweBenchDispatchRunModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  firstPromptText = "";
  firstToolNames: readonly string[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      this.firstPromptText = request.messages?.map((message) => message.content).join("\n") ?? request.prompt;
      this.firstToolNames = visibleToolNames(request);
    }
    if (request.messages?.some((message) => message.role === "tool" && message.toolName === "core.swe.bench.run")) {
      yield { kind: "delta", text: "SWE-bench run evidence received." };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    const hasRunTool = request.tools?.some((tool) => {
      const fn = tool.function;
      return isJsonObject(fn) && fn.name === "core_swe_bench_run";
    }) ?? false;
    if (!hasRunTool) {
      yield { kind: "delta", text: "Missing governed SWE-bench run tool." };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "tool-call", id: "call-swe-bench-run", name: "core_swe_bench_run", input: { taskNumber: 2, dryRun: true } };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class WritingToolModelGateway implements ModelGateway {
  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    if (request.messages?.some((message) => message.role === "tool")) {
      yield { kind: "delta", text: "Write completed." };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "tool-call", id: "call-write-app", name: "core.file.write", input: { path: "app.ts", content: "after" } };
    yield { kind: "finish", reason: "tool-call" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class WritingThenCapturingModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  private writeRequested = false;

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    if (request.messages?.some((message) => message.role === "tool")) {
      yield { kind: "delta", text: "Write completed." };
      yield { kind: "finish", reason: "stop" };
      yield { kind: "done" };
      return;
    }
    const userMessage = [...(request.messages ?? [])].reverse().find((message) => message.role === "user")?.content ?? request.prompt;
    if (!this.writeRequested && userMessage.includes("write app")) {
      this.writeRequested = true;
      yield { kind: "tool-call", id: "call-write-app", name: "core.file.write", input: { path: "app.ts", content: "after" } };
      yield { kind: "finish", reason: "tool-call" };
      yield { kind: "done" };
      return;
    }
    yield { kind: "delta", text: `Captured ${userMessage}` };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class StreamingDeltaModelGateway implements ModelGateway {
  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { kind: "delta", text: "hi " };
    yield { kind: "delta", text: "there " };
    yield { kind: "delta", text: "friend" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class CapturingModelGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    yield { kind: "delta", text: "Captured." };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

function requestSystemMessageIncluding(request: ModelRequest | undefined, content: string) {
  return request?.messages?.find((message) => message.role === "system" && message.content.includes(content));
}

function requestUserMessage(request: ModelRequest | undefined, content: string) {
  return request?.messages?.find((message) => message.role === "user" && message.content === content);
}

function cliModeSessionEvent(sessionId: SessionId, sequence: number, kind: string, payload: SessionEvent["payload"]): SessionEvent {
  return {
    sessionId,
    sequence,
    kind,
    at: new Date(0).toISOString(),
    payload,
    redaction: { class: "internal" }
  };
}

function cliLoopBudget(kind: string, allowed: number, requested: number, consumed: number): JsonObject {
  return {
    schemaVersion: AGENT_MODE_SCHEMA_VERSION,
    kind,
    requested,
    allowed,
    consumed,
    remaining: Math.max(0, allowed - consumed),
    policy: { source: "cli-test" },
    redaction: { class: "internal" },
    compatibility: AGENT_MODE_COMPATIBILITY
  };
}

class FakeWebpageAgentPlatform extends NodePlatformRuntime {
  readonly executedWorkspaces: string[] = [];
  readonly executedCommands: { readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly env?: JsonObject }[] = [];

  constructor(private readonly behavior: { readonly omitEvidenceManifest?: boolean; readonly includeRuntimeSignals?: boolean; readonly runtimeReasoningOnly?: boolean; readonly streamProgressEvents?: boolean } = {}) {
    super();
  }

  override async runProcess(command: string, args: readonly string[], options: ProcessRunOptions = {}, observer?: ProcessRunObserver): Promise<ProcessResult> {
    const cwd = typeof options.cwd === "string" ? options.cwd : process.cwd();
    this.executedCommands.push({ command, args: [...args], cwd, ...(isJsonObject(options.env) ? { env: options.env } : {}) });
    if (command === "fake-web-agent" && args[0] === "--version") {
      return {
        exitCode: 0,
        stdout: "fake-web-agent 1.0.0",
        stderr: ""
      };
    }
    if (command === "fake-web-agent" && args[0] === "exec") {
      this.executedWorkspaces.push(cwd);
      await this.writeGeneratedWebpage(cwd);
      return {
        exitCode: 0,
        stdout: "created generated-webpage",
        stderr: ""
      };
    }
    if (command === process.execPath && args.some((arg) => String(arg).replace(/\\/g, "/").endsWith("src/apps/cli/src/index.ts"))) {
      this.executedWorkspaces.push(cwd);
      await this.writeGeneratedWebpage(cwd);
      const stdout = [
        ...this.progressEventLines(),
        JSON.stringify({
        kind: "prompt.assembled",
        data: {
          fingerprint: "assembly-test",
          sectionCount: 3,
          excludedSectionCount: 0,
          budget: { status: "within-budget" },
          toolPlan: { visibleToolCount: 4 },
          trace: {
            sections: [
              { kind: "task.intent", included: true },
              { kind: "task.output-contract", included: true },
              { kind: "tools.policy", included: true }
            ]
          }
        }
        }),
        JSON.stringify({
          kind: "agent.repair.started",
          data: { schemaVersion: "1.0.0", enabled: true, attemptBudget: 1 }
        }),
        JSON.stringify({
          kind: "agent.repair.stopped",
          data: { schemaVersion: "1.0.0", stopReason: "completed" }
        }),
        JSON.stringify({
          kind: "agent.loop.completed",
          data: { selfRepair: { stopReason: "completed" } }
        }),
        ...this.runtimeSignalLines()
      ].join("\n") + "\n";
      observer?.onStdoutChunk?.(stdout);
      return {
        exitCode: 0,
        stdout,
        stderr: ""
      };
    }
    return super.runProcess(command, args, options, observer);
  }

  private progressEventLines(): readonly string[] {
    if (!this.behavior.streamProgressEvents) return [];
    return [
      JSON.stringify({ kind: "model.tool.intent", data: { name: "core.file.read" } }),
      JSON.stringify({ kind: "model.delta", data: { text: "secret raw delta" } }),
      JSON.stringify({ kind: "model.tool.result", data: { name: "core.file.read", status: "success" } })
    ];
  }

  private async writeGeneratedWebpage(cwd: string): Promise<void> {
      const target = join(cwd, "generated-webpage");
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "index.html"), [
        "<!doctype html>",
        "<html lang=\"en\">",
        "<head>",
        "<meta charset=\"utf-8\">",
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
        "<title>DeepSeek CLI</title>",
        "<link rel=\"stylesheet\" href=\"styles.css\">",
        "</head>",
        "<body>",
        "<main role=\"main\">",
        "<h1>DeepSeek CLI</h1>",
        "<p>Contract-first local coding agent platform with a governed runtime kernel and thin host adapters.</p>",
        "<code>npx tsx src/apps/cli/src/index.ts init</code>",
        "<button id=\"demo\" aria-label=\"Preview workflow\">Preview</button>",
        "</main>",
        "<script src=\"app.js\"></script>",
        "</body>",
        "</html>"
      ].join("\n"), "utf8");
      await writeFile(join(target, "styles.css"), "body { font-family: system-ui; margin: 0; } main { padding: 2rem; }\n", "utf8");
      await writeFile(join(target, "app.js"), "document.getElementById('demo')?.addEventListener('click', () => document.body.classList.toggle('ready'));\n", "utf8");
      if (this.behavior.omitEvidenceManifest) return;
      if (this.behavior.runtimeReasoningOnly) return;
      await writeFile(join(target, "evidence.json"), JSON.stringify({
        schemaVersion: "1.0.0",
        manifestId: "evidence-manifest:test-webpage",
        artifactId: "generated-webpage",
        artifactKind: "webpage",
        status: "passed",
        generatedAt: "1970-01-01T00:00:00.000Z",
        sourceCoverage: [
          {
            schemaVersion: "1.0.0",
            sourceGroup: "readme",
            covered: true,
            itemCount: 1,
            factClasses: ["product-copy", "command", "architecture"],
            fingerprints: ["sha256:readme"],
            missingFactClasses: [],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal", fields: ["fingerprints"] }
          },
          {
            schemaVersion: "1.0.0",
            sourceGroup: "package-metadata",
            covered: true,
            itemCount: 1,
            factClasses: ["package", "executable"],
            fingerprints: ["sha256:cli-package"],
            missingFactClasses: [],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal", fields: ["fingerprints"] }
          },
          {
            schemaVersion: "1.0.0",
            sourceGroup: "command-index",
            covered: true,
            itemCount: 1,
            factClasses: ["command"],
            fingerprints: ["sha256:command-index"],
            missingFactClasses: [],
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal", fields: ["fingerprints"] }
          }
        ],
        evidenceItems: [
          {
            schemaVersion: "1.0.0",
            evidenceId: "evidence:readme",
            sourceGroup: "readme",
            sourcePath: "README.md",
            sourceLabel: "Repository README",
            factClasses: ["product-copy", "command", "architecture"],
            preview: "DeepSeek CLI is a contract-first platform with thin host adapters.",
            fingerprint: "sha256:readme",
            freshness: { status: "current", observedAt: "1970-01-01T00:00:00.000Z" },
            trace: {},
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal", fields: ["preview"] }
          },
          {
            schemaVersion: "1.0.0",
            evidenceId: "evidence:cli-package",
            sourceGroup: "package-metadata",
            sourcePath: "src/apps/cli/package.json",
            sourceLabel: "CLI package metadata",
            factClasses: ["package", "executable"],
            preview: "name deepseek-agent-cli, bin deepseek",
            fingerprint: "sha256:cli-package",
            freshness: { status: "current", observedAt: "1970-01-01T00:00:00.000Z" },
            trace: {},
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal", fields: ["preview"] }
          },
          {
            schemaVersion: "1.0.0",
            evidenceId: "evidence:command-index",
            sourceGroup: "command-index",
            sourcePath: "docs/reference/command-index.md",
            sourceLabel: "Command index",
            factClasses: ["command"],
            preview: "npx tsx src/apps/cli/src/index.ts init",
            fingerprint: "sha256:command-index",
            freshness: { status: "current", observedAt: "1970-01-01T00:00:00.000Z" },
            trace: {},
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal", fields: ["preview"] }
          }
        ],
        claimGroundings: [
          {
            schemaVersion: "1.0.0",
            claimId: "claim:platform",
            claimPreview: "Contract-first local coding agent platform with a governed runtime kernel and thin host adapters.",
            claimFingerprint: "claim:platform",
            factClass: "product-copy",
            certainty: "verified",
            evidenceIds: ["evidence:readme"],
            outputScope: "generated-webpage/index.html",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal", fields: ["claimPreview"] }
          },
          {
            schemaVersion: "1.0.0",
            claimId: "claim:init-command",
            claimPreview: "npx tsx src/apps/cli/src/index.ts init",
            claimFingerprint: "claim:init-command",
            factClass: "command",
            certainty: "verified",
            evidenceIds: ["evidence:readme", "evidence:command-index"],
            outputScope: "generated-webpage/index.html",
            compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
            redaction: { class: "internal", fields: ["claimPreview"] }
          }
        ],
        assumptions: [],
        unsupportedClaims: [],
        unsupportedClaimCount: 0,
        trace: {},
        compatibility: { schemaVersion: "1.0.0", minReaderVersion: "1.0.0" },
        redaction: { class: "internal", fields: ["evidenceItems.preview", "claimGroundings.claimPreview"] }
      }, null, 2), "utf8");
  }

  private runtimeSignalLines(): readonly string[] {
    if (!this.behavior.includeRuntimeSignals) return [];
    const base = {
      schemaVersion: "1.0.0",
      redaction: { class: "internal" },
      compatibility: AGENT_MODE_COMPATIBILITY
    };
    const reasoning = JSON.stringify({
      kind: "model.reasoning.effort.mapped",
      data: {
        ...base,
        requestedEffort: "xhigh",
        providerEffort: "max",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        mapped: true,
        supported: true,
        diagnostics: []
      }
    });
    if (this.behavior.runtimeReasoningOnly) return [reasoning];
    return [
      JSON.stringify({
        kind: "agent.phase.plan.created",
        data: {
          ...base,
          planId: "agent-phase-plan:evaluation-test",
          sessionId: "session-evaluation-test",
          interactionMode: "headless",
          agentMode: "default",
          phases: [
            { ...base, phase: "evidence", status: "completed", required: true, mode: "evidence", budgets: [], diagnostics: [] },
            { ...base, phase: "verify", status: "completed", required: true, mode: "verifier", budgets: [], diagnostics: [] }
          ],
          budgets: [],
          reason: "Evaluation fixture."
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          ...base,
          kind: "verification",
          requested: 1,
          allowed: 1,
          consumed: 1,
          remaining: 0,
          policy: { source: "evaluation-test" }
        }
      }),
      JSON.stringify({
        kind: "agent.verifier.verdict",
        data: {
          ...base,
          verifierResultId: "agent-verifier-result:evaluation-test",
          verdict: "pass",
          sessionId: "session-evaluation-test",
          checkedTargets: [{ kind: "directory", id: "generated-webpage", path: "generated-webpage" }],
          commandEvidenceIds: ["command:webpage-check"],
          evidenceIds: ["evidence:artifact-check"],
          unverifiedAreas: [],
          summary: "Fixture verification passed.",
          diagnostics: []
        }
      }),
      JSON.stringify({
        kind: "agent.result.reconciled",
        data: {
          status: "pass",
          repairAttemptCount: 0,
          redaction: { class: "internal" }
        }
      }),
      reasoning
    ];
  }
}

function hashTextForTest(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function runWithSeededWorkspace(args: readonly string[], input: readonly string[] = []): Promise<readonly string[]> {
  const root = process.cwd().replace(/\\/g, "/");
  const deps = createDeterministicRuntimeDependencies();
  await deps.platform.writeFile(`${root}/src/index.ts`, "export const needle = true;\n");
  await deps.platform.writeFile(`${root}/docs/guide.md`, "needle docs\n");
  const kernel = await createDefaultRuntimeKernel(deps);
  const lines: string[] = [];
  await runCli(args, (line: string) => {
    lines.push(line);
  }, input, { stdinIsTTY: false, stdoutIsTTY: false }, {
    createRuntime: async () => ({ deps, kernel })
  });
  return lines;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capabilityContext(): CapabilityExecutionContext {
  const trace = {
    traceId: asId<"trace">("trace-cli-env-prepare-test"),
    spanId: asId<"span">("span-cli-env-prepare-test"),
    correlationId: asId<"correlation">("corr-cli-env-prepare-test")
  };
  return {
    envelope: {
      invocationId: "invocation-cli-env-prepare-test",
      capabilityId: asId<"capability">("core.env.prepare"),
      capabilityVersion: "1.0.0",
      kind: "tool",
      caller: "cli-test"
    } as unknown as CapabilityExecutionContext["envelope"],
    trace,
    signal: new AbortController().signal,
    metadata: {}
  };
}

async function registerFakeCliSweBenchRunCapability(
  deps: Pick<ReturnType<typeof createDeterministicRuntimeDependencies>, "capabilities">,
  capturedInputs: JsonObject[] = [],
  runnerMetadata: JsonObject = {}
): Promise<void> {
  const definition = defineToolManifest(
    "swe.bench.run",
    asId<"capability">("core.swe.bench.run"),
    "Fake SWE-bench Run",
    "process",
    ["process:run", "evaluation:swe-bench"],
    objectSchema([], {
      taskNumber: { type: "number" },
      taskNumbers: { type: "array" },
      execute: { type: "boolean" },
      dryRun: { type: "boolean" },
      resume: { type: "boolean" },
      resumeOnly: { type: "boolean" },
      provider: { type: "string", enum: ["deepseek", "glm"] },
      model: { type: "string" },
      runId: { type: "string" },
      timeoutMs: { type: "number" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    async (input, context) => {
      capturedInputs.push({ ...input });
      return {
        ok: true,
        value: {
          evidence: {
            tool: "swe.bench.run",
            status: "completed",
            affectedPaths: [],
            preview: boundedText("fake swe-bench run", 4_000),
            diagnostics: [],
            metadata: { ...runnerMetadata, redaction: { class: "internal" as const } },
            replay: replay(context),
            redaction: { class: "internal" as const, fields: ["metadata"] }
          }
        }
      };
    },
    { timeoutMs: 30_000, replayPolicy: { replayable: false, snapshot: "fake-cli-swe-bench-run", deterministic: true } }
  );
  await deps.capabilities.register({
    ...definition.manifest,
    toolFamily: {
      schemaVersion: TOOL_FAMILY_CATALOG_SCHEMA_VERSION,
      catalogVersion: "test-cli-fixture",
      domainId: "git-build",
      familyId: "benchmark.run",
      toolId: "benchmark.run",
      implementationState: "implemented",
      maturity: "baseline",
      riskClass: "process",
      operationProfiles: ["process", "observe"],
      hostRequirements: ["cli-host"],
      connectorProfile: "host",
      scorecardRubricId: "rubric.benchmark.run.baseline",
      redaction: { class: "public" }
    }
  }, definition.execute);
}

function visibleToolNames(request: ModelRequest): readonly string[] {
  return (request.tools ?? [])
    .map((tool) => {
      const fn = isJsonObject(tool.function) ? tool.function : undefined;
      return typeof fn?.name === "string" ? fn.name : "";
    })
    .filter(Boolean)
    .sort();
}

async function withTempCwd<T>(prefix: string, run: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    process.chdir(dir);
    return await run();
  } finally {
    process.chdir(previous);
    await rm(dir, { recursive: true, force: true });
  }
}

async function withTempReleaseRepo<T>(
  prefix: string,
  options: { readonly buildOutput: boolean; readonly acceptanceEvidence: boolean },
  run: () => Promise<T>
): Promise<T> {
  return withTempCwd(prefix, async () => {
    await mkdir("src/apps/cli/dist", { recursive: true });
    await mkdir("tests/acceptance/latest", { recursive: true });
    await writeFile("src/apps/cli/package.json", JSON.stringify({
      name: "deepseek-agent-cli",
      version: "0.1.3",
      type: "module",
      exports: { ".": "./dist/index.js" },
      files: ["dist", "README.md"],
      bin: { deepseek: "dist/index.js" },
      publishConfig: { access: "public" }
    }), "utf8");
    await writeFile("tests/acceptance/acceptance-index.md", "# Acceptance Evidence Index\n", "utf8");
    if (options.buildOutput) await writeFile("src/apps/cli/dist/index.js", "#!/usr/bin/env node\n", "utf8");
    for (const file of acceptanceEvidenceFilesForTest()) {
      if (!options.acceptanceEvidence && file === "typecheck.txt") continue;
      await writeFile(join("tests/acceptance/latest", file), acceptanceEvidenceContentForTest(file), "utf8");
    }
    return run();
  });
}

function acceptanceEvidenceFilesForTest(): readonly string[] {
  return [
    "openspec-validation.txt",
    "typecheck.txt",
    "lint.txt",
    "test-summary.txt",
    "dependency-boundaries.txt",
    "build-cli.txt",
    "release-verify.txt",
    "uapi-compatibility.txt",
    "architecture-drift-guardrails.json",
    "governance-evidence-matrix.json",
    "smoke-headless.txt",
    "reference-hygiene.txt",
    "npm-publish-dry-run.txt",
    "live-provider-smoke.txt",
    "live-agent-loop-smoke.txt",
    "live-agent-tool-smoke.txt",
    "live-cli-run-smoke.txt",
    "live-doctor-smoke.txt",
    "live-tool-coverage.json",
    "tool-family-delivery-capability-score.json",
    "deepseek-provider-response-cache.json",
    "overall-delivery-capability-score.json"
  ];
}

function acceptanceEvidenceContentForTest(file: string): string {
  if (file === "npm-publish-dry-run.txt") return "npm notice package: deepseek-agent-cli@0.1.3\nnpm notice Tarball Details\n";
  if (file.startsWith("live-") && file.endsWith("-smoke.txt") && file !== "live-cli-run-smoke.txt" && file !== "live-doctor-smoke.txt") return "# pass 1\n# skipped 0\n";
  if (file === "live-cli-run-smoke.txt") return liveCliRunSmokeEvidenceForTest();
  if (file === "live-doctor-smoke.txt") return liveDoctorSmokeEvidenceForTest();
  if (file === "live-tool-coverage.json") return JSON.stringify({ kind: "deepseek.live-tool-coverage", executionMode: "live", replayOnly: false, summary: { passedToolCount: 64, providerRequestMode: "live" } });
  if (file === "tool-family-delivery-capability-score.json") return JSON.stringify({ kind: "tool-family.delivery-capability-score.evidence", deliveryCapabilityPassed: true, fakeCoveredFamilyCount: 0, replayedCoveredFamilyCount: 0, liveCoveredFamilyCount: 64 });
  if (file === "architecture-drift-guardrails.json") return JSON.stringify({ kind: "governance.architecture-drift", status: "pass", aliasCount: 4 });
  if (file === "governance-evidence-matrix.json") return JSON.stringify({ kind: "governance.evidence-matrix", status: "pass", recordCount: 1 });
  if (file === "deepseek-provider-response-cache.json") return JSON.stringify({
    schemaVersion: "1.0.0",
    kind: "deepseek.provider-response-cache",
    replayOnly: true,
    provider: "deepseek",
    sourceEvidencePath: "tests/acceptance/latest/live-tool-coverage.json",
    entryCount: 1,
    entries: [{ executionMode: "live" }]
  });
  if (file === "overall-delivery-capability-score.json") return JSON.stringify({ kind: "cli.overall-delivery-capability-score.evidence", status: "pass", score: 1, dimensions: [{ dimensionId: "deepseek-api" }, { dimensionId: "memory" }, { dimensionId: "cache-observability" }] });
  return "ok\n";
}

function liveCliRunSmokeEvidenceForTest(): string {
  return [
    JSON.stringify({ kind: "model.finished", data: { provider: { provider: "deepseek", protocol: "openai-chat-completions", model: "deepseek-v4-flash", requestId: "req-live-cli-test" } } }),
    JSON.stringify({ kind: "usage.updated", data: { metadata: { provider: { provider: "deepseek", protocol: "openai-chat-completions", model: "deepseek-v4-flash", requestId: "req-live-cli-test" }, cache: { hitTokens: 0, missTokens: 12 } } } }),
    JSON.stringify({ kind: "agent.loop.completed", data: { modelProvider: "provider-deepseek", status: "completed" } }),
    ""
  ].join("\n");
}

function liveDoctorSmokeEvidenceForTest(): string {
  return `${JSON.stringify({
    command: "doctor",
    metadata: { liveRequested: true },
    checks: [{ id: "doctor.live", status: "pass" }],
    live: {
      reachable: true,
      usage: {
        provider: { provider: "deepseek", protocol: "openai-chat-completions", model: "deepseek-v4-flash", requestId: "req-live-doctor-test" },
        cache: { hitTokens: 0, missTokens: 8 }
      }
    }
  })}\n`;
}

class ReasoningStreamModelGateway implements ModelGateway {
  async *stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield { kind: "reasoning", text: "plan ", redaction: { class: "internal" } };
    yield { kind: "reasoning", text: "first ", redaction: { class: "internal" } };
    yield { kind: "reasoning", text: "step.", redaction: { class: "internal" } };
    yield { kind: "delta", text: "ok" };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class CaptureModelRequestGateway implements ModelGateway {
  constructor(private readonly requests: ModelRequest[], private readonly responseText = "ok") {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    yield { kind: "delta", text: this.responseText };
    yield { kind: "finish", reason: "stop" };
    yield { kind: "done" };
  }

  async countTokens(text: string): Promise<number> {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
  }
}

class CliAskApprovalPolicyEngine implements PolicyEngine {
  async decide(request: PolicyRequest): Promise<PolicyDecision> {
    const trace = request.auditEvidence?.trace ?? {
      traceId: asId<"trace">("trace-cli-approval"),
      spanId: asId<"span">("span-cli-approval"),
      correlationId: asId<"correlation">("corr-cli-approval")
    };
    const approval: ApprovalRequest = {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      approvalId: "approval:cli-test" as ApprovalId,
      subject: request.subject,
      action: request.action,
      resource: request.resource,
      metadata: request.metadata,
      prompt: "Approve CLI tool execution?",
      decisionOptions: ["allow", "deny", "cancel"],
      summary: {
        schemaVersion: APPROVAL_SCHEMA_VERSION,
        title: "Approval required",
        subject: request.subject,
        action: request.action,
        resource: request.resource,
        capability: request.resource,
        targetKind: "capability",
        targetLabel: request.resource,
        riskSummaries: [{
          schemaVersion: APPROVAL_SCHEMA_VERSION,
          kind: "policy",
          severity: "medium",
          title: "Headless CLI approval",
          detail: "Headless CLI execution requires an injected approval decision.",
          reasonCodes: ["policy.approval.required"],
          referencePitFixtureIds: ["pit.headless-trust.fail-closed"],
          redaction: { class: "internal", fields: ["detail"] },
          metadata: {}
        }],
        allowedDecisions: ["allow", "deny", "cancel"],
        referencePitFixtureIds: ["pit.headless-trust.fail-closed"],
        redaction: { class: "internal", fields: ["targetLabel"] },
        metadata: {}
      },
      auditReference: {
        schemaVersion: APPROVAL_SCHEMA_VERSION,
        traceId: trace.traceId,
        correlationId: trace.correlationId,
        policyDecision: "ask",
        reasonCodes: ["policy.approval.required"],
        redaction: { class: "internal", fields: ["reasonCodes"] }
      },
      trace,
      compatibility: { schemaVersion: APPROVAL_SCHEMA_VERSION }
    };
    return {
      action: "ask",
      reason: "Approval required by CLI test policy",
      audit: { policy: "cli-ask-test" },
      sandboxProfile: "development",
      approvalRequest: approval,
      approvalSummary: approval.summary,
      approval: {
        schemaVersion: APPROVAL_SCHEMA_VERSION,
        kind: "approval.required",
        approvalId: approval.approvalId,
        trace,
        summary: approval.summary,
        auditReference: approval.auditReference,
        redaction: { class: "internal" },
        compatibility: { schemaVersion: APPROVAL_SCHEMA_VERSION }
      }
    };
  }
}

class AllowAllPolicyEngine implements PolicyEngine {
  async decide(_request: PolicyRequest): Promise<PolicyDecision> {
    return {
      action: "allow",
      reason: "Allowed by test policy.",
      audit: { policy: "allow-all-test" },
      sandboxProfile: "development"
    };
  }
}

class CapabilityMatrixEnvRecordingPlatform extends FakePlatformRuntime {
  readonly processRuns: Array<{
    readonly command: string;
    readonly args: readonly string[];
    readonly options: ProcessRunOptions;
  }> = [];

  constructor() {
    super("fake", "/workspace");
  }

  override async runProcess(command: string, args: readonly string[], options: ProcessRunOptions = {}, observer?: ProcessRunObserver): Promise<ProcessResult> {
    this.processRuns.push({ command, args, options });
    if (command === "git") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const stdout = JSON.stringify({
      kind: "agent.loop.completed",
      diagnostics: [{ code: "PROVIDER_CREDENTIAL_MISSING", message: "GLM Anthropic-compatible provider credential is missing." }]
    });
    observer?.onStdoutChunk?.(stdout);
    observer?.onProcessExit?.();
    return { exitCode: 0, stdout, stderr: "" };
  }
}
