import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asId } from "@deepseek/platform-contracts";
import { DeterministicToolIntentPreflight, deepSeekToolIntentProfile, normalizeWorkspacePath, prepareProviderIntent } from "../src/index.js";

const visible = [asId<"capability">("core.file.read")];
const searchVisible = [asId<"capability">("core.search.text")];
const deepseek = asId<"modelProvider">("provider-deepseek");

describe("tool intent preflight", () => {
  it("repairs safe workspace-relative paths before execution", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const result = await preflight.check({
      intent: {
        name: "core.file.read",
        source: "model",
        input: { path: "./src/packages/model-gateway/src/index.ts" }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: visible
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.diagnostics.length, 0);
    assert.deepEqual(result.repaired?.input, { path: "src/packages/model-gateway/src/index.ts" });
    assert.equal(result.repairs.some((repair) => repair.modelValue === "/repo/src/packages/model-gateway/src/index.ts"), true);
    assert.equal(result.repairs.some((repair) => repair.kind === "path-prefix-removed"), true);
    assert.equal(result.repairs.some((repair) => repair.kind === "path-normalized"), true);
  });

  it("normalizes Windows separators deterministically", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const result = await preflight.check({
      intent: {
        name: "core.file.read",
        source: "model",
        input: { path: "src/packages/model-gateway/src/index.ts" }
      },
      workspaceRoot: "C:\\repo",
      platform: "windows",
      modelVisibleCapabilities: visible
    });

    assert.equal(result.status, "repaired");
    assert.deepEqual(result.repaired?.input, { path: "src\\packages\\model-gateway\\src\\index.ts" });
    assert.equal(result.repairs.some((repair) => repair.modelValue === "C:\\repo\\src\\packages\\model-gateway\\src\\index.ts"), true);
    assert.equal(result.repairs.some((repair) => repair.kind === "path-separator-normalized"), true);
  });

  it("repairs workspace-contained absolute paths while rejecting outside absolute paths", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const result = await preflight.check({
      providerId: deepseek,
      intent: {
        name: "core_test_run",
        source: "model",
        input: {
          command: "python3",
          args: ["-m", "pytest"],
          cwd: "/repo/.deepseek/swebench-workspaces/astropy__astropy-12907/repo"
        }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: [asId<"capability">("core.test.run")]
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.diagnostics.length, 0);
    assert.equal(result.repaired?.input.cwd, ".deepseek/swebench-workspaces/astropy__astropy-12907/repo");
    assert.equal(result.repaired?.input.workspaceRoot, "/repo");
    assert.equal(result.repairs.some((repair) => repair.kind === "path-normalized" && repair.before === "/repo/.deepseek/swebench-workspaces/astropy__astropy-12907/repo"), true);

    const outside = normalizeWorkspacePath("/tmp/outside", "/repo", "linux");
    assert.equal(outside.value, undefined);
    assert.equal(outside.diagnostics[0]?.code, "TOOL_INTENT_ABSOLUTE_PATH_REJECTED");
  });

  it("rejects unsafe absolute paths, parent traversal, home paths, null bytes, and ambiguous drive-relative paths", () => {
    const unsafe = [
      ["/etc/passwd", "TOOL_INTENT_ABSOLUTE_PATH_REJECTED"],
      ["../secret.txt", "TOOL_INTENT_PARENT_TRAVERSAL_REJECTED"],
      ["~/secret.txt", "TOOL_INTENT_HOME_PATH_REJECTED"],
      ["C:secret.txt", "TOOL_INTENT_AMBIGUOUS_PLATFORM_PATH"],
      ["file\x00.txt", "TOOL_INTENT_NULL_BYTE_REJECTED"]
    ] as const;

    for (const [path, code] of unsafe) {
      const normalized = normalizeWorkspacePath(path, "/repo", "linux");
      assert.equal(normalized.diagnostics[0]?.code, code);
      assert.equal(normalized.value, undefined);
    }
  });

  it("rejects unknown or non-model-visible tools before envelope creation", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const result = await preflight.check({
      intent: {
        name: "write_file",
        source: "model",
        input: { path: "src/index.ts" }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: visible
    });

    assert.equal(result.status, "rejected");
    assert.equal(result.diagnostics[0]?.code, "TOOL_INTENT_UNKNOWN_TOOL");
    assert.equal(result.repaired, undefined);
  });

  it("applies DeepSeek-specific tool aliases and arguments unwrapping before common safety checks", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const result = await preflight.check({
      providerId: deepseek,
      intent: {
        name: "readFile",
        source: "model",
        input: {
          arguments: JSON.stringify({ path: "./src\\packages\\model-gateway\\src\\index.ts" })
        }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: visible
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.capabilityId, "core.file.read");
    assert.deepEqual(result.repaired?.input, { path: "src/packages/model-gateway/src/index.ts" });
    assert.equal(result.provider?.matched, true);
    assert.equal(result.repairs.some((repair) => repair.kind === "provider-tool-alias-normalized"), true);
    assert.equal(result.repairs.some((repair) => repair.kind === "provider-arguments-unwrapped"), true);
  });

  it("normalizes DeepSeek search aliases to the visible search capability", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const result = await preflight.check({
      providerId: deepseek,
      intent: {
        name: "core_file_search",
        source: "model",
        input: { pattern: "deepseek" }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: searchVisible
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.capabilityId, "core.search.text");
    assert.deepEqual(result.repaired?.input, { pattern: "deepseek" });
    assert.equal(result.repairs.some((repair) => repair.kind === "provider-tool-alias-normalized"), true);
  });

  it("defaults shell execution to the active workspace before policy evaluation", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const result = await preflight.check({
      providerId: deepseek,
      intent: {
        name: "core_shell_run",
        source: "model",
        input: { command: "npm", args: ["test"] }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: [asId<"capability">("core.shell.run")]
    });

    assert.equal(result.status, "repaired");
    assert.deepEqual(result.repaired?.input, { command: "npm", args: ["test"], cwd: ".", workspaceRoot: "/repo" });
    assert.equal(result.repairs.some((repair) => repair.kind === "workspace-cwd-defaulted"), true);
    assert.equal(result.repairs.some((repair) => repair.kind === "workspace-root-defaulted"), true);
  });

  it("defaults REPL execution to the active workspace before policy evaluation", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const result = await preflight.check({
      providerId: deepseek,
      intent: {
        name: "core_repl_execute",
        source: "model",
        input: { code: "1 + 1" }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: [asId<"capability">("core.repl.execute")]
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.repaired?.name, "core.repl.execute");
    assert.deepEqual(result.repaired?.input, { code: "1 + 1", cwd: ".", workspaceRoot: "/repo" });
    assert.equal(result.repairs.some((repair) => repair.kind === "workspace-cwd-defaulted"), true);
    assert.equal(result.repairs.some((repair) => repair.kind === "workspace-root-defaulted"), true);
  });

  it("defaults package manager execution to the active workspace before policy evaluation", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const result = await preflight.check({
      providerId: deepseek,
      intent: {
        name: "core_package_manager",
        source: "model",
        input: { operation: "install", packages: ["hypothesis"] }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: [asId<"capability">("core.package.manager")]
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.repaired?.name, "core.package.manager");
    assert.deepEqual(result.repaired?.input, { operation: "install", packages: ["hypothesis"], cwd: ".", workspaceRoot: "/repo" });
    assert.equal(result.repairs.some((repair) => repair.kind === "workspace-cwd-defaulted"), true);
    assert.equal(result.repairs.some((repair) => repair.kind === "workspace-root-defaulted"), true);
  });

  it("defaults governed host process capabilities to the active workspace before policy evaluation", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    for (const capabilityId of ["core.swe.bench.run", "core.env.prepare"] as const) {
      const result = await preflight.check({
        providerId: deepseek,
        intent: {
          name: capabilityId.replace(/[^a-zA-Z0-9_-]/g, "_"),
          source: "model",
          input: capabilityId === "core.swe.bench.run" ? { taskNumber: 2 } : { profile: "swe-bench-lite", execute: true }
        },
        workspaceRoot: "/repo",
        platform: "linux",
        modelVisibleCapabilities: [asId<"capability">(capabilityId)]
      });

      assert.equal(result.status, "repaired", capabilityId);
      assert.equal(result.repaired?.name, capabilityId);
      assert.equal(result.repaired?.input.cwd, ".", capabilityId);
      assert.equal(result.repaired?.input.workspaceRoot, "/repo", capabilityId);
      if (capabilityId === "core.swe.bench.run") assert.equal(result.repaired?.input.timeoutMs, 7_200_000, capabilityId);
      assert.equal(result.repairs.some((repair) => repair.kind === "workspace-cwd-defaulted"), true, capabilityId);
      assert.equal(result.repairs.some((repair) => repair.kind === "workspace-root-defaulted"), true, capabilityId);
    }
  });

  it("normalizes model-supplied low SWE-bench run timeouts to the governed long-running budget", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const result = await preflight.check({
      providerId: deepseek,
      intent: {
        name: "core_swe_bench_run",
        source: "model",
        input: { taskNumber: 2, timeoutMs: 600_000 }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: [asId<"capability">("core.swe.bench.run")]
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.repaired?.input.timeoutMs, 7_200_000);
    assert.equal(result.repairs.some((repair) =>
      repair.kind === "workspace-tool-timeout-normalized" &&
      repair.field === "timeoutMs" &&
      repair.before === "600000" &&
      repair.after === "7200000"
    ), true);
  });

  it("normalizes model-supplied dryRun away from live SWE-bench completion requests", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const result = await preflight.check({
      providerId: deepseek,
      intent: {
        name: "core_swe_bench_run",
        source: "model",
        input: { taskNumber: 10, dryRun: true }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: [asId<"capability">("core.swe.bench.run")],
      providerHints: {
        userPrompt: "给我完成 SWE-bench Lite 第 10 题测试，修复后做单题 canary，跑通并告诉我 cache 命中率。"
      }
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.repaired?.input.dryRun, false);
    assert.equal(result.repaired?.input.execute, true);
    assert.equal(result.repairs.some((repair) =>
      repair.kind === "swe-bench-run-execution-normalized" &&
      repair.field === "dryRun" &&
      repair.before === "true" &&
      repair.after === "false"
    ), true);
  });

  it("preserves model-supplied dryRun for explicit SWE-bench preview requests", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const result = await preflight.check({
      providerId: deepseek,
      intent: {
        name: "core_swe_bench_run",
        source: "model",
        input: { taskNumber: 10, dryRun: true }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: [asId<"capability">("core.swe.bench.run")],
      providerHints: {
        userPrompt: "dry run SWE-bench Lite 第 10 题，只预览不要执行。"
      }
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.repaired?.input.dryRun, true);
    assert.equal(result.repaired?.input.execute, undefined);
    assert.equal(result.repairs.some((repair) => repair.kind === "swe-bench-run-execution-normalized"), false);
  });

  it("repairs a single SWE-bench task call into a prompt-declared task range", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const result = await preflight.check({
      providerId: deepseek,
      intent: {
        name: "core_swe_bench_run",
        source: "model",
        input: { taskNumber: 2, execute: true, resume: true }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: [asId<"capability">("core.swe.bench.run")],
      providerHints: {
        userPrompt: "给我完成 SWE-bench Lite 第 2 到第 4 题测试，能继续就 resume，跑通并告诉我总体通过率。"
      }
    });

    assert.equal(result.status, "repaired");
    assert.deepEqual(result.repaired?.input.taskNumbers, [2, 3, 4]);
    assert.equal(result.repaired?.input.taskNumber, 2);
    assert.equal(result.repairs.some((repair) =>
      repair.kind === "swe-bench-task-range-normalized" &&
      repair.field === "taskNumbers" &&
      repair.before === "2" &&
      repair.after === "2,3,4"
    ), true);
  });

  it("repairs a SWE-bench Lite 1-200 prompt range for campaign scoring", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const result = await preflight.check({
      providerId: deepseek,
      intent: {
        name: "core_swe_bench_run",
        source: "model",
        input: { taskNumber: 1, execute: true, resume: true }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: [asId<"capability">("core.swe.bench.run")],
      providerHints: {
        userPrompt: "用 GLM 跑 SWE-bench Lite 第 1 到第 200 题，resume，目标累计通过 200 个实例。"
      }
    });

    assert.equal(result.status, "repaired");
    assert.equal((result.repaired?.input.taskNumbers as number[]).length, 200);
    assert.deepEqual((result.repaired?.input.taskNumbers as number[]).slice(0, 3), [1, 2, 3]);
    assert.deepEqual((result.repaired?.input.taskNumbers as number[]).slice(-3), [198, 199, 200]);
    assert.equal(result.repairs.some((repair) => repair.kind === "swe-bench-task-range-normalized"), true);
  });

  it("normalizes provider-safe names against model-visible capability ids", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const result = await preflight.check({
      providerId: deepseek,
      intent: {
        name: "runtime_pipeline_sequence",
        source: "model",
        input: { steps: [] }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: [asId<"capability">("runtime.pipeline.sequence")]
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.capabilityId, "runtime.pipeline.sequence");
    assert.equal(result.repaired?.name, "runtime.pipeline.sequence");
    assert.equal(result.repairs.some((repair) => repair.kind === "provider-tool-alias-normalized" && repair.before === "runtime_pipeline_sequence"), true);
  });

  it("normalizes DeepSeek aliases for every core tool family", () => {
    const aliases = [
      ["core_shell_run", "core.shell.run"],
      ["core_repl_execute", "core.repl.execute"],
      ["core_package_manager", "core.package.manager"],
      ["core_shell_output", "core.shell.output"],
      ["core_shell_kill", "core.shell.kill"],
      ["core_git_status", "core.git.status"],
      ["core_git_diff", "core.git.diff"],
      ["core_test_run", "core.test.run"],
      ["core_todo_plan", "core.todo.plan"],
      ["core_web_fetch", "core.web.fetch"],
      ["core_web_search", "core.web.search"],
      ["core_agent_spawn", "core.agent.spawn"],
      ["core_agent_continue", "core.agent.continue"],
      ["core_agent_stop", "core.agent.stop"],
      ["core_hook_list", "core.hook.list"],
      ["core_skill_list", "core.skill.list"],
      ["core_skill_activate", "core.skill.activate"]
    ] as const;

    for (const [alias, expected] of aliases) {
      const prepared = prepareProviderIntent({ name: alias, source: "model", input: {} }, deepSeekToolIntentProfile);
      assert.equal(prepared.intent.name, expected);
      assert.equal(prepared.repairs.some((repair) => repair.kind === "provider-tool-alias-normalized"), true);
    }
  });

  it("rejects invalid provider argument JSON before execution", () => {
    const prepared = prepareProviderIntent(
      {
        name: "readFile",
        source: "model",
        input: { arguments: "{not-json" }
      },
      deepSeekToolIntentProfile
    );

    assert.equal(prepared.intent.name, "core.file.read");
    assert.equal(prepared.diagnostics[0]?.code, "TOOL_INTENT_PROVIDER_ARGUMENTS_INVALID_JSON");
  });
});
