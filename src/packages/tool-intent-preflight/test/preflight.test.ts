import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { asId } from "@deepseek/platform-contracts";
import { FakePlatformRuntime } from "@deepseek/platform-abstraction";
import { coreToolManifests } from "@deepseek/core-coding-tools";
import { DeterministicToolIntentPreflight, deepSeekToolIntentProfile, normalizeWorkspacePath, prepareProviderIntent } from "../src/index.js";

const visible = [asId<"capability">("core.file.read")];
const writeVisible = [asId<"capability">("core.file.write")];
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
          cwd: "/repo/.deepseek/evaluation-workspaces/project/repo"
        }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: [asId<"capability">("core.test.run")]
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.diagnostics.length, 0);
    assert.equal(result.repaired?.input.cwd, ".deepseek/evaluation-workspaces/project/repo");
    assert.equal(result.repaired?.input.workspaceRoot, "/repo");
    assert.equal(result.repairs.some((repair) => repair.kind === "path-normalized" && repair.before === "/repo/.deepseek/evaluation-workspaces/project/repo"), true);

    const outside = normalizeWorkspacePath("/tmp/outside", "/repo", "linux");
    assert.equal(outside.value, undefined);
    assert.equal(outside.diagnostics[0]?.code, "TOOL_INTENT_ABSOLUTE_PATH_REJECTED");
  });

  it("delegates canonical workspace path safety to the injected platform resolver", async () => {
    const platform = new FakePlatformRuntime("windows");
    const preflight = new DeterministicToolIntentPreflight([deepSeekToolIntentProfile], {
      resolveWorkspacePath: platform.resolveWorkspacePath.bind(platform)
    });

    const contained = await preflight.check({
      intent: {
        name: "core.file.read",
        source: "model",
        input: { path: "C:/WORKSPACE/Repo/SRC/Readme.MD" }
      },
      workspaceRoot: "C:/workspace/repo",
      platform: "windows",
      modelVisibleCapabilities: visible
    });

    assert.equal(contained.status, "repaired");
    assert.deepEqual(contained.repaired?.input, { path: "src/readme.md", workspaceRoot: "C:/workspace/repo" });
    assert.equal(contained.repairs.some((repair) => repair.kind === "path-normalized" && repair.executorValue === "src/readme.md"), true);

    const unsupported = await preflight.check({
      intent: {
        name: "core.file.read",
        source: "model",
        input: { path: "src/trailing. " }
      },
      workspaceRoot: "C:/workspace/repo",
      platform: "windows",
      modelVisibleCapabilities: visible
    });

    assert.equal(unsupported.status, "rejected");
    assert.equal(unsupported.diagnostics[0]?.code, "TOOL_INTENT_PLATFORM_PATH_REJECTED");
  });

  it("injects request workspace root and preserves read path casing for executor input", async () => {
    const platform = new FakePlatformRuntime("macos");
    const preflight = new DeterministicToolIntentPreflight([deepSeekToolIntentProfile], {
      resolveWorkspacePath: platform.resolveWorkspacePath.bind(platform)
    });

    const result = await preflight.check({
      intent: {
        name: "core.file.read",
        source: "model",
        input: { path: "README.rst" }
      },
      workspaceRoot: "/workspace/repo",
      platform: "macos",
      modelVisibleCapabilities: visible
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.diagnostics.length, 0);
    assert.deepEqual(result.repaired?.input, {
      path: "README.rst",
      workspaceRoot: "/workspace/repo"
    });
    assert.equal(result.repairs.some((repair) => repair.kind === "workspace-root-defaulted"), true);
  });

  it("preserves literal mutation path casing after platform safety resolution", async () => {
    const platform = new FakePlatformRuntime("windows");
    const preflight = new DeterministicToolIntentPreflight([deepSeekToolIntentProfile], {
      resolveWorkspacePath: platform.resolveWorkspacePath.bind(platform)
    });

    const result = await preflight.check({
      intent: {
        name: "core.file.write",
        source: "model",
        input: { path: "Docs/USAGE.md", content: "# Usage" }
      },
      workspaceRoot: "C:/workspace/repo",
      platform: "windows",
      modelVisibleCapabilities: writeVisible
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.diagnostics.length, 0);
    assert.deepEqual(result.repaired?.input, { path: "Docs/USAGE.md", content: "# Usage", workspaceRoot: "C:/workspace/repo" });
    assert.equal(result.repairs.some((repair) => repair.kind === "path-normalized" && repair.executorValue === "Docs/USAGE.md"), true);
  });

  it("applies workspace path governance to semantic source and target path fields", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const safe = await preflight.check({
      intent: {
        name: "core.file.copy",
        source: "model",
        input: { sourcePath: "./docs\\source.txt", targetPath: "generated/copied.txt" }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: [asId<"capability">("core.file.copy")]
    });

    assert.equal(safe.status, "repaired");
    assert.equal(safe.diagnostics.length, 0);
    assert.deepEqual(safe.repaired?.input, {
      sourcePath: "docs/source.txt",
      targetPath: "generated/copied.txt"
    });
    assert.equal(safe.repairs.some((repair) => repair.field === "sourcePath" && repair.kind === "path-separator-normalized"), true);

    const unsafe = await preflight.check({
      intent: {
        name: "core.file.move",
        source: "model",
        input: { sourcePath: "../outside.txt", targetPath: "generated/moved.txt" }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: [asId<"capability">("core.file.move")]
    });

    assert.equal(unsafe.status, "rejected");
    assert.equal(unsafe.diagnostics[0]?.field, "sourcePath");
    assert.equal(unsafe.diagnostics[0]?.code, "TOOL_INTENT_PARENT_TRAVERSAL_REJECTED");
  });

  it("applies DeepSeek profile path governance to command-habit source and target fields", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const safe = await preflight.check({
      providerId: deepseek,
      intent: {
        name: "cp",
        source: "model",
        input: { sourcePath: "./Docs\\Source.md", targetPath: "Generated/Copied.md" }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: [asId<"capability">("core.file.copy")]
    });

    assert.equal(safe.status, "repaired");
    assert.equal(safe.capabilityId, "core.file.copy");
    assert.deepEqual(safe.repaired?.input, {
      sourcePath: "Docs/Source.md",
      targetPath: "Generated/Copied.md"
    });
    assert.equal(safe.repairs.some((repair) => repair.field === "sourcePath" && repair.kind === "path-separator-normalized"), true);

    const unsafe = await preflight.check({
      providerId: deepseek,
      intent: {
        name: "mv",
        source: "model",
        input: { sourcePath: "../outside.txt", targetPath: "Generated/Moved.md" }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: [asId<"capability">("core.file.move")]
    });

    assert.equal(unsafe.status, "rejected");
    assert.equal(unsafe.diagnostics[0]?.field, "sourcePath");
    assert.equal(unsafe.diagnostics[0]?.code, "TOOL_INTENT_PARENT_TRAVERSAL_REJECTED");
  });

  it("preserves specific unsafe syntax diagnostics before platform path resolution", async () => {
    const platform = new FakePlatformRuntime("linux");
    const preflight = new DeterministicToolIntentPreflight(undefined, {
      resolveWorkspacePath: platform.resolveWorkspacePath.bind(platform)
    });

    const cases = [
      ["../outside.txt", "TOOL_INTENT_PARENT_TRAVERSAL_REJECTED"],
      ["src/../outside.txt", "TOOL_INTENT_PARENT_TRAVERSAL_REJECTED"],
      ["file\x00.txt", "TOOL_INTENT_NULL_BYTE_REJECTED"],
      ["C:secret.txt", "TOOL_INTENT_AMBIGUOUS_PLATFORM_PATH"]
    ] as const;

    for (const [path, code] of cases) {
      const result = await preflight.check({
        intent: {
          name: "core.file.read",
          source: "model",
          input: { path }
        },
        workspaceRoot: "/workspace",
        platform: "linux",
        modelVisibleCapabilities: visible
      });

      assert.equal(result.status, "rejected", path);
      assert.equal(result.diagnostics[0]?.code, code, path);
    }
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

  it("normalizes model-projected semantic aliases to visible capabilities", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const cases = [
      ["ViewImage", "core.asset.view-local"],
      ["Diagnostics", "core.code.diagnostics"],
      ["ApplyPatch", "core.patch.apply"],
      ["Revert", "core.revert.undo"],
      ["Repl", "core.repl.execute"],
      ["Test", "core.test.run"],
      ["Npm", "core.package.manager"],
      ["MCP", "core.mcp.tool.call"],
      ["ListMcpResources", "core.mcp.resource.list"],
      ["ReadMcpResource", "core.mcp.resource.read"],
      ["AskUserQuestion", "core.user.input"],
      ["EnterPlanMode", "core.mode.plan.enter"],
      ["ExitPlanMode", "core.mode.plan.exit"],
      ["Config", "core.config.manage"],
      ["Agent", "core.agent.spawn"],
      ["Skill", "core.skill.activate"],
      ["Schedule", "core.schedule.cron"],
      ["Brief", "core.brief.package"],
      ["SyntheticOutput", "core.synthetic.output"]
    ] as const;

    for (const [alias, capabilityId] of cases) {
      const result = await preflight.check({
        providerId: deepseek,
        intent: {
          name: alias,
          source: "model",
          input: {}
        },
        workspaceRoot: "/repo",
        platform: "linux",
        modelVisibleCapabilities: [asId<"capability">(capabilityId)]
      });

      assert.equal(result.status, "repaired", alias);
      assert.equal(result.capabilityId, capabilityId, alias);
      assert.equal(result.repaired?.name, capabilityId, alias);
      assert.equal(result.repairs.some((repair) => repair.kind === "provider-tool-alias-normalized"), true, alias);
      assert.equal(result.diagnostics.length, 0, alias);
    }
  });

  it("normalizes every model-projected core tool alias to its visible capability", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    const manifests = coreToolManifests().filter((manifest) => manifest.projection?.modelVisible !== false);
    const cases = manifests.flatMap((manifest) =>
      stringArray(manifest.projection?.modelAliases).map((alias) => ({
        alias,
        capabilityId: String(manifest.id)
      }))
    );

    assert.equal(cases.length > 0, true);

    for (const { alias, capabilityId } of cases) {
      const result = await preflight.check({
        providerId: deepseek,
        intent: {
          name: alias,
          source: "model",
          input: {}
        },
        workspaceRoot: "/repo",
        platform: "linux",
        modelVisibleCapabilities: [asId<"capability">(capabilityId)]
      });

      assert.equal(result.status, "repaired", alias);
      assert.equal(result.capabilityId, capabilityId, alias);
      assert.equal(result.repaired?.name, capabilityId, alias);
      assert.equal(result.diagnostics.length, 0, alias);
    }
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

  it("defaults governed process capabilities to the active workspace before policy evaluation", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    for (const capabilityId of ["core.env.prepare", "core.test.run"] as const) {
      const result = await preflight.check({
        providerId: deepseek,
        intent: {
          name: capabilityId.replace(/[^a-zA-Z0-9_-]/g, "_"),
          source: "model",
          input: capabilityId === "core.env.prepare" ? { profile: "evaluation/dynamic.v1", execute: true } : { command: "npm", args: ["test"] }
        },
        workspaceRoot: "/repo",
        platform: "linux",
        modelVisibleCapabilities: [asId<"capability">(capabilityId)]
      });

      assert.equal(result.status, "repaired", capabilityId);
      assert.equal(result.repaired?.name, capabilityId);
      assert.equal(result.repaired?.input.cwd, ".", capabilityId);
      assert.equal(result.repaired?.input.workspaceRoot, "/repo", capabilityId);
      assert.equal(result.repairs.some((repair) => repair.kind === "workspace-cwd-defaulted"), true, capabilityId);
      assert.equal(result.repairs.some((repair) => repair.kind === "workspace-root-defaulted"), true, capabilityId);
    }
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
      ["core_text_replace", "core.text.replace"],
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

  it("normalizes reference-style semantic tool aliases before visibility checks", () => {
    const aliases = [
      ["Read", "core.file.read"],
      ["Grep", "core.search.text"],
      ["Glob", "core.workspace.glob"],
      ["Edit", "core.file.edit"],
      ["Sed", "core.text.replace"],
      ["Replace", "core.text.replace"],
      ["Write", "core.file.write"],
      ["Copy", "core.file.copy"],
      ["Move", "core.file.move"],
      ["Delete", "core.file.delete"],
      ["Mkdir", "core.directory.create"],
      ["Touch", "core.file.touch"],
      ["Stat", "core.file.stat"],
      ["JsonRead", "core.json.read"],
      ["JsonPatch", "core.json.patch"],
      ["Hash", "core.checksum.hash"],
      ["PathResolve", "core.path.resolve"],
      ["Env", "core.env.inspect"],
      ["Which", "core.command.lookup"],
      ["ArchiveCreate", "core.archive.create"],
      ["ArchiveExtract", "core.archive.extract"],
      ["PluginInstall", "core.plugin.install"],
      ["PluginVerify", "core.plugin.verify"],
      ["CommandPalette", "core.command.palette"],
      ["ShellOutput", "core.shell.output"],
      ["ShellKill", "core.shell.kill"],
      ["ReplExecute", "core.repl.execute"],
      ["GitStatus", "core.git.status"],
      ["GitDiff", "core.git.diff"],
      ["GitHistory", "core.git.history-branch"],
      ["TestRun", "core.test.run"],
      ["PackageManager", "core.package.manager"],
      ["TodoWrite", "core.todo.plan"],
      ["WebFetch", "core.web.fetch"],
      ["WebSearch", "core.web.search"],
      ["AgentSpawn", "core.agent.spawn"],
      ["AgentContinue", "core.agent.continue"],
      ["AgentStop", "core.agent.stop"],
      ["TaskCreate", "core.task.create"],
      ["TaskGet", "core.task.get"],
      ["TaskList", "core.task.list"],
      ["TaskUpdate", "core.task.update"],
      ["TaskOutput", "core.task.output"],
      ["TeamCreate", "core.team.create"],
      ["TeamDelete", "core.team.delete"],
      ["SkillList", "core.skill.list"],
      ["SkillActivate", "core.skill.activate"],
      ["HookList", "core.hook.list"],
      ["HookRun", "core.hook.run"],
      ["ConfigManage", "core.config.manage"],
      ["ToolSearch", "core.tool.search"],
      ["McpToolCall", "core.mcp.tool.call"],
      ["McpResourceList", "core.mcp.resource.list"],
      ["McpResourceRead", "core.mcp.resource.read"],
      ["UserInput", "core.user.input"],
      ["PlanEnter", "core.mode.plan.enter"],
      ["PlanExit", "core.mode.plan.exit"],
      ["SessionResume", "core.session.resume"],
      ["SessionFork", "core.session.fork"],
      ["MemoryWrite", "core.memory.write"],
      ["MemoryRead", "core.memory.read"],
      ["CompactSummary", "core.compact.summary"],
      ["WorktreeEnter", "core.worktree.enter"],
      ["WorktreeExit", "core.worktree.exit"],
      ["ScheduleCron", "core.schedule.cron"],
      ["RemoteTrigger", "core.remote.trigger"],
      ["BriefPackage", "core.brief.package"],
      ["SyntheticOutput", "core.synthetic.output"],
      ["CodeDiagnostics", "core.code.diagnostics"],
      ["NotebookRead", "core.notebook.read"],
      ["NotebookEdit", "core.notebook.edit"],
      ["Bash", "core.shell.run"],
      ["PowerShell", "core.shell.run"]
    ] as const;

    for (const [alias, expected] of aliases) {
      const prepared = prepareProviderIntent({ name: alias, source: "model", input: {} }, deepSeekToolIntentProfile);
      assert.equal(prepared.intent.name, expected);
      assert.equal(prepared.repairs.some((repair) => repair.kind === "provider-tool-alias-normalized"), true);
    }
  });

  it("normalizes every manifest-projected core tool alias for DeepSeek", () => {
    const aliases = coreToolManifests()
      .flatMap((manifest) => stringArray(manifest.projection?.modelAliases)
        .map((alias) => ({ alias, capabilityId: String(manifest.id) })));

    assert.equal(aliases.length > 0, true);
    for (const { alias, capabilityId } of aliases) {
      const prepared = prepareProviderIntent({ name: alias, source: "model", input: {} }, deepSeekToolIntentProfile);
      assert.equal(prepared.intent.name, capabilityId, `${alias} should normalize to ${capabilityId}`);
      assert.equal(prepared.repairs.some((repair) => repair.kind === "provider-tool-alias-normalized"), true, `${alias} should record alias normalization`);
    }
  });

  it("normalizes every provider-safe core tool function name during DeepSeek preflight", async () => {
    const preflight = new DeterministicToolIntentPreflight();
    for (const manifest of coreToolManifests()) {
      const capabilityId = String(manifest.id);
      const providerSafeName = capabilityId.replace(/[^A-Za-z0-9_-]/g, "_");
      const result = await preflight.check({
        providerId: deepseek,
        intent: { name: providerSafeName, source: "model", input: {} },
        workspaceRoot: "/repo",
        platform: "linux",
        modelVisibleCapabilities: [asId<"capability">(capabilityId)]
      });
      assert.equal(result.capabilityId, capabilityId, `${providerSafeName} should normalize to ${capabilityId}`);
      assert.equal(result.status === "accepted" || result.status === "repaired", true);
      assert.equal(result.repairs.some((repair) => repair.kind === "provider-tool-alias-normalized"), true, `${providerSafeName} should record provider-safe name normalization`);
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

  it("normalizes common command-habit aliases to governed cross-platform tools", () => {
    const aliases = [
      ["cat", "core.file.read"],
      ["ls", "core.file.list"],
      ["grep", "core.search.text"],
      ["rg", "core.search.text"],
      ["sed", "core.text.replace"],
      ["glob", "core.workspace.glob"],
      ["cp", "core.file.copy"],
      ["mv", "core.file.move"],
      ["rm", "core.file.delete"],
      ["mkdir", "core.directory.create"],
      ["touch", "core.file.touch"],
      ["stat", "core.file.stat"],
      ["env", "core.env.inspect"],
      ["printenv", "core.env.inspect"],
      ["which", "core.command.lookup"],
      ["where", "core.command.lookup"],
      ["bash", "core.shell.run"],
      ["sh", "core.shell.run"],
      ["powershell", "core.shell.run"],
      ["pwsh", "core.shell.run"],
      ["npm", "core.package.manager"],
      ["yarn", "core.package.manager"],
      ["pnpm", "core.package.manager"],
      ["tar", "core.archive.create"],
      ["unzip", "core.archive.extract"]
    ] as const;

    for (const [alias, expected] of aliases) {
      const prepared = prepareProviderIntent({ name: alias, source: "model", input: {} }, deepSeekToolIntentProfile);
      assert.equal(prepared.intent.name, expected, alias);
      assert.equal(prepared.repairs.some((repair) => repair.kind === "provider-tool-alias-normalized"), true, alias);
    }
  });

  it("normalizes provider tool aliases case-insensitively without touching path casing", async () => {
    const preflight = new DeterministicToolIntentPreflight([deepSeekToolIntentProfile]);
    const result = await preflight.check({
      providerId: deepseek,
      intent: {
        name: "CAT",
        source: "model",
        input: { path: "Docs/USAGE.md" }
      },
      workspaceRoot: "/repo",
      platform: "linux",
      modelVisibleCapabilities: visible
    });

    assert.equal(result.status, "repaired");
    assert.equal(result.capabilityId, "core.file.read");
    assert.equal(result.repaired?.input.path, "Docs/USAGE.md");
    assert.equal(result.repairs.some((repair) =>
      repair.kind === "provider-tool-alias-normalized" &&
      repair.before === "CAT" &&
      repair.after === "core.file.read"
    ), true);
  });
});

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
