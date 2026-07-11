import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

async function writeFixtureFile(root: string, path: string, content: string): Promise<void> {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

function lintScript(root: string): string {
  const frameworkUrl = pathToFileURL(resolve("scripts/lint-framework/index.mjs")).href;
  const sourceRoot = join(root, "src");
  const tsconfigPath = join(root, "tsconfig.base.json");
  return `
import { runArchitectureLint } from ${JSON.stringify(frameworkUrl)};

const conventions = {
  sourceRoots: [${JSON.stringify(sourceRoot)}],
  metadataRoots: [${JSON.stringify(sourceRoot)}],
  metadataFiles: [${JSON.stringify(tsconfigPath)}],
  ignoredDirectoryNames: new Set(["node_modules", ".git", "dist", "coverage", ".cache", "\\u53c2\\u8003"]),
  typescriptExtensions: [".ts"],
  packageManifestNames: ["package.json"],
  hostApiModules: new Set(["node:fs", "node:fs/promises", "node:process", "vscode"]),
  packageImportPrefix: "@deepseek/",
      workspacePackageNames: new Map([
        ["platform-contracts", "@deepseek/platform-contracts"],
        ["runtime", "@deepseek/runtime"],
        ["model-gateway", "@deepseek/model-gateway"],
        ["prompt-assembly", "@deepseek/prompt-assembly"],
        ["core-coding-tools", "@deepseek/core-coding-tools"],
        ["credential-auth-management", "@deepseek/credential-auth-management"],
        ["cli", "deepseek-agent-cli"],
        ["vscode-extension", "@deepseek/vscode-extension"]
      ]),
      packageDependencyPolicy: new Map([
        ["platform-contracts", new Set()],
        ["runtime", new Set(["@deepseek/platform-contracts"])],
        ["model-gateway", new Set(["@deepseek/platform-contracts"])],
        ["prompt-assembly", new Set(["@deepseek/platform-contracts"])],
        ["credential-auth-management", new Set(["@deepseek/platform-contracts"])]
      ]),
  appDependencyPolicy: new Map([
    ["cli", new Set(["@deepseek/platform-contracts"])],
    ["vscode-extension", new Set(["@deepseek/platform-contracts"])]
  ]),
  publishableApps: new Map([
    ["cli", { packageName: "deepseek-agent-cli", binName: "deepseek", files: new Set(["dist", "README.md"]) }]
  ]),
  appPackages: new Map([
    ["cli", new Set(["@deepseek/vscode-extension"])],
    ["vscode-extension", new Set(["deepseek-agent-cli"])]
  ]),
  packageRules: {
    "platform-contracts": {
      forbidPackageImports: true,
      forbidHostApiImports: true,
      forbiddenGlobals: new Set(["process", "Buffer"])
    },
    runtime: {
      forbiddenImports: new Set(["@deepseek/testing-regression"])
    }
  },
  platformContractsUapi: {
    appPackageNames: new Set(["deepseek-agent-cli", "@deepseek/vscode-extension"]),
    providerSdkModules: new Set(["openai", "@anthropic-ai/sdk"]),
    forbiddenWorkspacePackages: new Set(["@deepseek/testing-regression"]),
    privateImportSegments: ["/src", "/dist", "/internal"],
    ownerPackage: "platform-contracts",
    suggestedOwner: "owner implementation package"
  },
  runtimeKernel: {
    appPackageNames: new Set(["deepseek-agent-cli", "@deepseek/vscode-extension"]),
    providerSdkModules: new Set(["openai", "@anthropic-ai/sdk"]),
    privateImportSegments: ["/src", "/dist", "/internal"],
    centralFiles: new Map([
      ["src/packages/runtime/src/kernel.ts", { maxLines: 20, ownerPackage: "runtime", extractionTargets: ["policy-sandbox"] }]
    ]),
    compatibilityShims: [
      {
        id: "runtime.test-compat",
        ownerPackage: "runtime",
        file: "src/packages/runtime/src/agent-loop.ts",
        reason: "fixture",
        extractionTarget: "runtime-event-loop",
        expirationTrigger: "fixture complete",
        diagnosticId: "RUNTIME_TEST_COMPAT",
        severity: "warning"
      }
    ]
  },
  governedExecution: {
    approvedPackages: new Set(["runtime", "core-coding-tools"]),
    deterministicPackages: new Set(["testing-regression"]),
    primitives: [
      {
        serviceNames: new Set(["capabilities", "capabilityRegistry"]),
        methods: new Set(["execute", "resolveExecutable"]),
        ownerPackage: "capability-registry"
      },
      {
        serviceNames: new Set(["skills", "skillSystem"]),
        methods: new Set(["activate"]),
        ownerPackage: "skill-system"
      },
      {
        serviceNames: new Set(["hooks", "hookSystem"]),
        methods: new Set(["invokeHooks", "registerHook", "projectOrder"]),
        ownerPackage: "hook-system"
      },
      {
        serviceNames: new Set(["mcp", "mcpGateway"]),
        methods: new Set(["connectServer", "listTools", "listResources", "listPrompts", "callTool", "readResource"]),
        ownerPackage: "mcp-gateway"
      },
      {
        serviceNames: new Set(["models", "modelGateway"]),
        methods: new Set(["stream"]),
        ownerPackage: "model-gateway"
      },
      {
        serviceNames: new Set(["sandbox", "sandboxRuntime"]),
        methods: new Set(["run"]),
        ownerPackage: "policy-sandbox"
      },
      {
        serviceNames: new Set(["scheduler", "concurrency", "concurrencyOrchestrator"]),
        methods: new Set(["run", "cancel"]),
        ownerPackage: "concurrency-orchestration"
      },
      {
        serviceNames: new Set(["policy", "policyEngine"]),
        methods: new Set(["decide"]),
        ownerPackage: "policy-sandbox"
      },
      {
        serviceNames: new Set(["workflow", "workflowOrchestrator"]),
        methods: new Set(["openInvocation", "closeInvocation"]),
        ownerPackage: "workflow-orchestration"
      },
      {
        serviceNames: new Set(["bus", "runtimeMessageBus"]),
        methods: new Set(["publish"]),
        ownerPackage: "runtime-message-bus"
      }
    ]
  },
  contextProjection: {
    approvedPackages: new Set(["context-engine", "runtime", "testing-regression"]),
    serviceNames: new Set(["context", "contextEngine"]),
    methods: new Set(["addNode", "project", "projectGraph"])
  },
  platformAccess: {
    approvedPackages: new Set(["platform-abstraction", "testing-regression"]),
    forbiddenImports: new Set(["child_process", "node:child_process", "keytar", "clipboardy", "sharp"]),
    forbiddenProcessProperties: new Set(["platform", "arch"]),
    forbiddenSearchCommands: new Set(["rg", "grep", "findstr", "Select-String", "select-string"]),
    forbiddenNativeNames: [/keytar/i, /keychain/i, /clipboard/i, /native/i, /sharp/i]
  },
  secretSandbox: {
    approvedPackages: new Set(["platform-contracts", "policy-sandbox", "runtime", "credential-auth-management", "model-gateway", "platform-abstraction", "testing-regression"]),
    forbiddenSandboxProperties: new Set(["sandboxProfile", "sandboxRequirements", "sandboxCapabilities"]),
    forbiddenSecretProperties: new Set(["apiKey", "token", "secret", "password", "credential"])
  },
  scaleGuardrails: {
    maxCentralFileLines: 20,
    maxPackageIndexLines: 10,
    plannedOversizedFiles: new Set(["src/packages/platform-abstraction/src/index.ts"])
  },
  architectureDrift: {
    aliasGovernanceRecords: new Map([
      ["@deepseek/retired-thing", {
        status: "retired",
        ownerPackage: "platform-governance",
        severity: "warning",
        allowedConsumers: ["none"],
        blockedProductClaims: ["retired-thing"],
        replacementTrigger: "Remove the alias after compatibility fixtures no longer import it.",
        evidenceIds: ["tests/fixtures/retired-alias.md"]
      }],
      ["@deepseek/placeholder-thing", {
        status: "placeholder",
        ownerPackage: "platform-abstraction",
        severity: "warning",
        allowedConsumers: ["runtime diagnostics"],
        blockedProductClaims: ["placeholder-thing"],
        replacementTrigger: "Create a real workspace package before product promotion.",
        evidenceIds: ["tests/fixtures/placeholder-alias.md"]
      }],
      ["@deepseek/incomplete-placeholder", {
        status: "placeholder",
        ownerPackage: "platform-abstraction",
        severity: "warning",
        allowedConsumers: [],
        blockedProductClaims: [],
        evidenceIds: []
      }]
    ])
  }
};

const result = await runArchitectureLint({ conventions });
console.log(JSON.stringify(result.failures.map((failure) => failure.ruleId).sort()));
process.exit(result.failures.length > 0 ? 2 : 0);
`;
}

async function withFixture<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "deepseek-lint-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("architecture lint framework", () => {
  it("passes a valid minimal workspace", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(
        root,
        "src/packages/platform-contracts/src/index.ts",
        "export interface ContractValue { readonly value: string; }\n"
      );
      await writeFixtureFile(
        root,
        "src/packages/platform-contracts/package.json",
        JSON.stringify({
          name: "@deepseek/platform-contracts",
          version: "0.1.0",
          private: true,
          type: "module",
          exports: {
            ".": {
              types: "./src/index.ts",
              default: "./src/index.ts"
            }
          },
          dependencies: {}
        })
      );
      await writeFixtureFile(
        root,
        "src/packages/runtime/src/index.ts",
        "import type { ContractValue } from \"@deepseek/platform-contracts\";\nexport type RuntimeValue = ContractValue;\n"
      );
      await writeFixtureFile(
        root,
        "src/packages/runtime/package.json",
        JSON.stringify({
          name: "@deepseek/runtime",
          version: "0.1.0",
          private: true,
          type: "module",
          exports: {
            ".": {
              types: "./src/index.ts",
              default: "./src/index.ts"
            }
          },
          dependencies: {
            "@deepseek/platform-contracts": "0.1.0"
          }
        })
      );

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(JSON.parse(result.stdout), []);
    });
  });

  it("reports stable rule ids for boundary violations", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(
        root,
        "src/packages/platform-contracts/src/index.ts",
        "import { createHeadlessRuntime } from \"@deepseek/runtime\";\nexport const env = process.env;\nexport { createHeadlessRuntime };\n"
      );
      await writeFixtureFile(
        root,
        "src/packages/runtime/src/index.ts",
        "import { createDeterministicRuntimeDependencies } from \"@deepseek/testing-regression\";\nexport { createDeterministicRuntimeDependencies };\n"
      );
      await writeFixtureFile(root, "src/apps/cli/src/index.ts", "import \"@deepseek/vscode-extension\";\n");
      await writeFixtureFile(
        root,
        "src/packages/runtime/package.json",
        JSON.stringify({
          name: "@deepseek/runtime",
          version: "0.1.0",
          private: true,
          type: "module",
          dependencies: {
            "@deepseek/testing-regression": "workspace:*"
          }
        })
      );

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);

      assert.equal(ruleIds.has("contracts/platform-contracts-are-pure"), true);
      assert.equal(ruleIds.has("contracts/platform-contracts-uapi-boundary"), true);
      assert.equal(ruleIds.has("runtime/no-testing-regression-dependency"), true);
      assert.equal(ruleIds.has("imports/no-app-to-app-imports"), true);
      assert.equal(ruleIds.has("package/package-json-boundaries"), true);
    });
  });

  it("rejects platform contracts UAPI imports from hosts providers tests apps and private internals", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(
        root,
        "src/packages/platform-contracts/src/index.ts",
        [
          "import { readFileSync } from \"node:fs\";",
          "import OpenAI from \"openai\";",
          "import { privateRuntime } from \"@deepseek/runtime/src/private\";",
          "import { runCli } from \"deepseek-agent-cli\";",
          "import { createDeterministicRuntimeDependencies } from \"@deepseek/testing-regression\";",
          "export { readFileSync, OpenAI, privateRuntime, runCli, createDeterministicRuntimeDependencies };"
        ].join("\n")
      );

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);
      assert.equal(ruleIds.has("contracts/platform-contracts-uapi-boundary"), true);
    });
  });

  it("allows governed execution primitives in runtime, owner packages, model-facing core tool facades, and tests", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(root, "src/packages/runtime/src/index.ts", "export async function run(deps) { await deps.skills.activateSkill({ schemaVersion: \"1.0.0\", name: \"review\", trigger: \"explicit\", context: {} }); }\n");
      await writeFixtureFile(root, "src/packages/skill-system/src/index.ts", "export async function own(skillSystem) { await skillSystem.activateSkill({ schemaVersion: \"1.0.0\", name: \"review\", trigger: \"explicit\", context: {} }); }\n");
      await writeFixtureFile(root, "src/packages/concurrency-orchestration/src/index.ts", "export async function ownScheduler(scheduler) { await scheduler.run({ id: \"task\", name: \"work\" }, async () => undefined); }\n");
      await writeFixtureFile(root, "src/packages/core-coding-tools/src/index.ts", "export async function facade(deps) { await deps.mcp.callTool({ schemaVersion: \"1.0.0\", serverId: \"mcp\", name: \"fake\", caller: \"model\", input: {} }); await deps.scheduler.run({ id: \"task\", name: \"work\" }, async () => undefined); }\n");
      await writeFixtureFile(root, "src/apps/cli/test/cli.test.ts", "export async function test(deps) { await deps.mcp.listTools({ schemaVersion: \"1.0.0\", namespace: \"fake\" }); }\n");

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(JSON.parse(result.stdout), []);
    });
  });

  it("rejects direct governed execution primitive bypasses outside approved owners", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(root, "src/apps/cli/src/index.ts", "export async function bad(deps) { await deps.skills.activateSkill({ schemaVersion: \"1.0.0\", name: \"review\", trigger: \"explicit\", context: {} }); }\n");
      await writeFixtureFile(root, "src/apps/vscode-extension/src/index.ts", "export async function badHost(deps) { await deps.scheduler.run({ id: \"task\", name: \"work\" }, async () => undefined); }\n");
      await writeFixtureFile(root, "src/packages/context-engine/src/index.ts", "export async function alsoBad(deps) { await deps.mcp.callTool({ schemaVersion: \"1.0.0\", serverId: \"mcp\", name: \"fake\", caller: \"runtime\", input: {} }); await deps.policy.decide({}); await deps.capabilities.resolveExecutable(\"runtime.echo\"); await deps.hooks.invokeHooks({ schemaVersion: \"1.0.0\", point: \"turn.before\", input: {} }); }\n");

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);

      assert.deepEqual([...ruleIds], ["governed-execution/no-direct-primitive-bypass"]);
    });
  });

  it("rejects legacy generic skill system APIs", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(
        root,
        "src/packages/platform-contracts/src/skill.ts",
        "export interface SkillSystem { register(manifest: unknown): Promise<unknown>; activate(name: string): Promise<unknown>; list(): Promise<unknown[]>; }\n"
      );
      await writeFixtureFile(
        root,
        "src/packages/skill-system/src/index.ts",
        "export class InMemorySkillSystem { register() {} activate() {} list() { return []; } }\n"
      );

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);
      assert.equal(ruleIds.has("skill-system/no-legacy-generic-api"), true);
    });
  });

  it("rejects legacy generic hook system APIs", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(
        root,
        "src/packages/platform-contracts/src/hook.ts",
        "export interface HookSystem { register(manifest: unknown): Promise<void>; run(point: string): Promise<unknown[]>; }\n"
      );
      await writeFixtureFile(
        root,
        "src/packages/hook-system/src/index.ts",
        "export class InMemoryHookSystem { register() {} run() { return []; } }\n"
      );

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);
      assert.equal(ruleIds.has("hook-system/no-legacy-generic-api"), true);
    });
  });

  it("rejects legacy generic MCP gateway APIs", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(
        root,
        "src/packages/platform-contracts/src/mcp.ts",
        "export interface McpGateway { connect(manifest: unknown): Promise<void>; listTools(namespace: string): Promise<unknown[]>; callTool(namespace: string, name: string, input: unknown): Promise<unknown>; }\n"
      );
      await writeFixtureFile(
        root,
        "src/packages/mcp-gateway/src/index.ts",
        "export class InMemoryMcpGateway { connect() {} listTools(namespace: string) { return []; } callTool(namespace: string, name: string, input: unknown) { return input; } }\n"
      );

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);
      assert.equal(ruleIds.has("mcp-gateway/no-legacy-generic-api"), true);
    });
  });

  it("rejects legacy runtime direct execution paths inside runtime package", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(
        root,
        "src/packages/runtime/src/index.ts",
        "export class HeadlessAgentRuntime { async *runTurn(deps) { yield* deps.models.stream({}); await deps.workflow.runGraph({}, {}); } }\n"
      );

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);
      assert.equal(ruleIds.has("runtime/no-legacy-direct-execution"), true);
    });
  });

  it("rejects runtime kernel imports that couple to apps hosts providers tests or private internals", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(
        root,
        "src/packages/runtime/src/kernel.ts",
        [
          "import { readFileSync } from \"node:fs\";",
          "import OpenAI from \"openai\";",
          "import { privateProvider } from \"@deepseek/model-gateway/src/private\";",
          "import { runCli } from \"deepseek-agent-cli\";",
          "import { createDeterministicRuntimeDependencies } from \"@deepseek/testing-regression\";",
          "export { readFileSync, OpenAI, privateProvider, runCli, createDeterministicRuntimeDependencies };"
        ].join("\n")
      );

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);
      assert.equal(ruleIds.has("runtime/kernel-boundary-imports"), true);
    });
  });

  it("rejects benchmark-specific hardcode in shared runtime and platform packages", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(
        root,
        "src/packages/runtime/src/agent-loop.ts",
        [
          "const SWE_BENCH_REQUEST_BUDGET_GATE = 'forbidden';",
          "export function createSweBenchVerificationGateState() { return SWE_BENCH_REQUEST_BUDGET_GATE; }"
        ].join("\n")
      );
      await writeFixtureFile(
        root,
        "src/packages/platform-contracts/src/runtime.ts",
        "export const scorerTerminalReason = 'swe-bench-ready-for-harness';\n"
      );
      await writeFixtureFile(
        root,
        "src/apps/cli/src/diagnostics/swe-bench-prediction.ts",
        "export const allowedHostDiagnostic = 'SWE_BENCH_HOST_DIAGNOSTIC';\n"
      );

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);
      assert.equal(ruleIds.has("benchmark/no-shared-runtime-hardcode"), true);
    });
  });

  it("reports runtime kernel central file pressure with a stable rule id", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(
        root,
        "src/packages/runtime/src/kernel.ts",
        Array.from({ length: 25 }, (_, index) => `export const kernelLine${index} = ${index};`).join("\n")
      );

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);
      assert.equal(ruleIds.has("runtime/kernel-central-file-pressure"), true);
    });
  });

  it("rejects direct provider credential access outside credential owners and tests", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(root, "src/packages/model-gateway/src/index.ts", "export const apiKey = process.env.DEEPSEEK_API_KEY;\n");
      await writeFixtureFile(root, "src/apps/vscode-extension/src/index.ts", "export async function bad(vscode) { return vscode.authentication.getSession(\"deepseek\", []); }\n");
      await writeFixtureFile(root, "src/packages/context-engine/src/index.ts", "export async function bad(fs) { return fs.readFileSync(\"./deepseek-api-key.txt\", \"utf8\"); }\n");

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);
      assert.equal(ruleIds.has("provider/no-direct-credential-access"), true);
    });
  });

  it("allows credential owner and tests to access host credential seams", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(root, "src/packages/credential-auth-management/src/index.ts", "export const env = process.env.DEEPSEEK_API_KEY;\n");
      await writeFixtureFile(root, "src/packages/model-gateway/test/provider.test.ts", "export const env = process.env.DEEPSEEK_API_KEY;\n");

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(JSON.parse(result.stdout), []);
    });
  });

  it("rejects direct platform primitive access outside platform owners", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(root, "src/apps/cli/src/index.ts", "import { spawn } from \"node:child_process\";\nexport const os = process.platform;\nexport function search() { spawn(\"rg\", [\"needle\"]); }\n");
      await writeFixtureFile(root, "src/packages/context-engine/src/index.ts", "import keytar from \"keytar\";\nexport async function bad() { return keytar.getPassword(\"deepseek\", \"api\"); }\n");

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);
      assert.equal(ruleIds.has("platform/no-direct-platform-primitive-access"), true);
    });
  });

  it("rejects direct secret, filesystem, process, native, and sandbox bypasses outside owners", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(root, "src/apps/cli/src/index.ts", "import { writeFileSync } from \"node:fs\";\nexport const token = process.env.DEEPSEEK_API_KEY;\nexport function bad() { writeFileSync(\"secret.txt\", token ?? \"\"); }\n");
      await writeFixtureFile(root, "src/packages/model-gateway/src/index.ts", "export const request = { apiKey: \"raw\", sandboxProfile: \"none\" };\n");
      await writeFixtureFile(root, "src/packages/plugin-system/src/index.ts", "import { spawnSync } from \"node:child_process\";\nexport function bad() { return spawnSync(\"rg\", [\"secret\"]); }\n");

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);
      assert.equal(ruleIds.has("secret-sandbox/no-direct-secret-or-sandbox-bypass"), true);
      assert.equal(ruleIds.has("platform/no-direct-platform-primitive-access"), true);
      assert.equal(ruleIds.has("provider/no-direct-credential-access"), true);
    });
  });

  it("rejects direct context projection assembly outside approved owners", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(root, "src/apps/cli/src/index.ts", "export async function bad(deps) { return deps.context.projectGraph({}); }\n");
      await writeFixtureFile(root, "src/packages/model-gateway/src/index.ts", "export async function badProvider(context) { return context.project(\"session\", \"prompt\"); }\n");
      await writeFixtureFile(root, "src/packages/runtime/src/index.ts", "export async function ok(deps) { return deps.context.projectGraph({}); }\n");

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);
      assert.equal(ruleIds.has("context-projection/no-direct-context-assembly"), true);
    });
  });

  it("rejects prompt assembly host or implementation dependencies", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(root, "src/packages/prompt-assembly/src/index.ts", "import { runAgentLoop } from \"@deepseek/runtime\";\nimport { readFileSync } from \"node:fs\";\nexport { runAgentLoop, readFileSync };\n");

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);
      assert.equal(ruleIds.has("prompt-assembly/host-neutral-boundary"), true);
    });
  });

  it("allows platform owners and tests to access platform primitives", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(root, "src/packages/platform-abstraction/src/index.ts", "import { spawn } from \"node:child_process\";\nexport const os = process.platform;\nexport function search() { spawn(\"rg\", [\"needle\"]); }\n");
      await writeFixtureFile(root, "src/packages/context-engine/test/platform.test.ts", "import { spawn } from \"node:child_process\";\nexport const os = process.platform;\nexport function search() { spawn(\"rg\", [\"needle\"]); }\n");

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(JSON.parse(result.stdout), []);
    });
  });

  it("rejects central file and package index growth without a split plan", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(
        root,
        "src/packages/model-gateway/src/index.ts",
        Array.from({ length: 12 }, (_, index) => `export const value${index} = ${index};`).join("\n")
      );
      await writeFixtureFile(
        root,
        "src/apps/cli/src/index.ts",
        Array.from({ length: 85 }, (_, index) => `export const cli${index} = ${index};`).join("\n")
      );

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);
      assert.equal(ruleIds.has("architecture/central-file-scale-guardrail"), true);
    });
  });

  it("allows planned oversized files while the split plan is active", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(
        root,
        "src/packages/platform-abstraction/src/index.ts",
        Array.from({ length: 30 }, (_, index) => `export const planned${index} = ${index};`).join("\n")
      );

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(JSON.parse(result.stdout), []);
    });
  });

  it("rejects ghost path aliases without governance records", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(
        root,
        "tsconfig.base.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@deepseek/missing-system": ["src/packages/missing-system/src/index.ts"]
            }
          }
        }, null, 2)
      );

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);
      assert.equal(ruleIds.has("architecture/ghost-alias-drift"), true);
    });
  });

  it("allows retired or placeholder aliases only with complete governance metadata", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(
        root,
        "tsconfig.base.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@deepseek/retired-thing": ["src/packages/retired-thing/src/index.ts"],
              "@deepseek/placeholder-thing": ["src/packages/placeholder-thing/src/index.ts"]
            }
          }
        }, null, 2)
      );

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.deepEqual(JSON.parse(result.stdout), []);
    });
  });

  it("rejects placeholder alias records missing promotion-gate metadata", async () => {
    await withFixture(async (root) => {
      await writeFixtureFile(
        root,
        "tsconfig.base.json",
        JSON.stringify({
          compilerOptions: {
            paths: {
              "@deepseek/incomplete-placeholder": ["src/packages/incomplete-placeholder/src/index.ts"]
            }
          }
        }, null, 2)
      );

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", lintScript(root)], { encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr || result.stdout);
      const ruleIds = new Set(JSON.parse(result.stdout) as string[]);
      assert.equal(ruleIds.has("architecture/ghost-alias-drift"), true);
    });
  });
});
