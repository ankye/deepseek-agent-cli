import { appDependencies, apps, packageDependencies, packages, plugins } from "../workspace-packages.mjs";

function packageNameForWorkspace(workspaceName) {
  if (workspaceName === "cli") return "deepseek-agent-cli";
  if (workspaceName === "builtin") return "@deepseek/builtin-plugins";
  return `@deepseek/${workspaceName}`;
}

function dependencyPolicyFrom(dependenciesByWorkspace) {
  return new Map(
    Object.entries(dependenciesByWorkspace).map(([workspaceName, dependencies]) => [
      workspaceName,
      new Set(dependencies.map(packageNameForWorkspace))
    ])
  );
}

export const lintConventions = {
  sourceRoots: ["src", "tests"],
  metadataRoots: ["src"],
  metadataFiles: ["tsconfig.base.json"],
  ignoredDirectoryNames: new Set(["node_modules", ".git", "dist", "coverage", ".cache", "\u53c2\u8003"]),
  typescriptExtensions: [".ts", ".tsx", ".mts", ".cts"],
  packageManifestNames: ["package.json"],
  hostApiModules: new Set([
    "fs",
    "node:fs",
    "fs/promises",
    "node:fs/promises",
    "child_process",
    "node:child_process",
    "process",
    "node:process",
    "vscode"
  ]),
  packageImportPrefix: "@deepseek/",
  workspacePackages: new Set([...packages, ...plugins]),
  workspaceApps: new Set(apps),
  workspacePackageNames: new Map([...packages, ...plugins, ...apps].map((workspaceName) => [workspaceName, packageNameForWorkspace(workspaceName)])),
  packageDependencyPolicy: dependencyPolicyFrom(packageDependencies),
  appDependencyPolicy: dependencyPolicyFrom(appDependencies),
  publishableApps: new Map([
    [
      "cli",
      {
        packageName: "deepseek-agent-cli",
        binName: "deepseek",
        files: new Set(["dist", "README.md"])
      }
    ]
  ]),
  appPackages: new Map([
    ["cli", new Set(["@deepseek/vscode-extension"])],
    ["vscode-extension", new Set(["@deepseek/cli", "deepseek-agent-cli"])]
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
    providerSdkModules: new Set([
      "openai",
      "@anthropic-ai/sdk",
      "@google/generative-ai",
      "@ai-sdk/openai",
      "@ai-sdk/anthropic",
      "langchain",
      "@langchain/openai",
      "ollama"
    ]),
    forbiddenWorkspacePackages: new Set(["@deepseek/testing-regression"]),
    privateImportSegments: ["/src", "/dist", "/internal"],
    ownerPackage: "platform-contracts",
    suggestedOwner: "owner implementation package"
  },
  runtimeKernel: {
    appPackageNames: new Set(["deepseek-agent-cli", "@deepseek/vscode-extension"]),
    providerSdkModules: new Set([
      "openai",
      "@anthropic-ai/sdk",
      "@google/generative-ai",
      "@ai-sdk/openai",
      "@ai-sdk/anthropic",
      "langchain",
      "@langchain/openai",
      "ollama"
    ]),
    privateImportSegments: ["/src", "/dist", "/internal"],
    centralFiles: new Map([
      [
        "src/packages/runtime/src/kernel.ts",
        {
          maxLines: 700,
          ownerPackage: "runtime",
          extractionTargets: ["policy-sandbox", "concurrency-orchestration", "runtime-message-bus"]
        }
      ],
      [
        "src/packages/runtime/src/agent-loop.ts",
        {
          maxLines: 800,
          ownerPackage: "runtime",
          extractionTargets: ["runtime-event-loop", "prompt-assembly", "model-gateway"]
        }
      ],
      [
        "src/packages/runtime/src/index.ts",
        {
          maxLines: 120,
          ownerPackage: "runtime",
          extractionTargets: ["package public exports"]
        }
      ]
    ]),
    compatibilityShims: [
      {
        id: "runtime.agent-loop-compat",
        ownerPackage: "runtime",
        file: "src/packages/runtime/src/agent-loop.ts",
        reason: "Current CLI product path still owns the high-level model/tool turn loop.",
        extractionTarget: "runtime-event-loop, prompt-assembly, model-gateway",
        expirationTrigger: "Layered context pipeline and model request planning are enabled on the main path.",
        diagnosticId: "RUNTIME_KERNEL_COMPAT_AGENT_LOOP",
        severity: "warning"
      },
      {
        id: "runtime.capability-registration-compat",
        ownerPackage: "runtime",
        file: "src/packages/runtime/src/echo-capability.ts",
        reason: "Built-in capability wiring remains in runtime while governed module registration is introduced.",
        extractionTarget: "capability-registry, plugin-system, first-party-dev-plugins",
        expirationTrigger: "Governed module contribution registration owns built-in capability wiring.",
        diagnosticId: "RUNTIME_KERNEL_COMPAT_CAPABILITY_REGISTRATION",
        severity: "warning"
      },
      {
        id: "runtime.platform-family-compat",
        ownerPackage: "runtime",
        file: "src/packages/runtime/src/platform-family-capabilities.ts",
        reason: "Platform family tools are still assembled through runtime exports.",
        extractionTarget: "platform-abstraction, workspace-state-management, session-store, observability",
        expirationTrigger: "Platform family tools are exported through owner packages.",
        diagnosticId: "RUNTIME_KERNEL_COMPAT_PLATFORM_FAMILY",
        severity: "warning"
      },
      {
        id: "runtime.context-memory-compat",
        ownerPackage: "runtime",
        file: "src/packages/runtime/src/context-projection.ts",
        reason: "Context and memory helpers remain in runtime until pipeline block storage is enabled.",
        extractionTarget: "context-engine, memory-cache-management, prompt-assembly",
        expirationTrigger: "Context pipeline block storage and prompt assembly handoff are product-ready.",
        diagnosticId: "RUNTIME_KERNEL_COMPAT_CONTEXT_MEMORY",
        severity: "warning"
      },
      {
        id: "runtime.agent-mode-compat",
        ownerPackage: "runtime",
        file: "src/packages/runtime/src/agent-spawner.ts",
        reason: "Agent spawning and mode support are rollout-gated while namespace/quota governance lands.",
        extractionTarget: "agent-management, workflow-orchestration",
        expirationTrigger: "Agent namespace/quota governance is enforced.",
        diagnosticId: "RUNTIME_KERNEL_COMPAT_AGENT_MODE",
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
        serviceNames: new Set(["commands", "commandSystem"]),
        methods: new Set(["invoke"]),
        ownerPackage: "command-system"
      },
      {
        serviceNames: new Set(["skills", "skillSystem"]),
        methods: new Set(["activateSkill", "projectContext", "loadSkill", "registerSkill"]),
        ownerPackage: "skill-system"
      },
      {
        serviceNames: new Set(["hooks", "hookSystem"]),
        methods: new Set(["invokeHooks", "registerHook", "projectOrder"]),
        ownerPackage: "hook-system"
      },
      {
        serviceNames: new Set(["mcp", "mcpGateway"]),
        methods: new Set(["connectServer", "callTool", "readResource", "listTools", "listResources", "listPrompts"]),
        ownerPackage: "mcp-gateway"
      },
      {
        serviceNames: new Set(["plugins", "pluginManager"]),
        methods: new Set(["install", "uninstall"]),
        ownerPackage: "plugin-system"
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
    approvedPackages: new Set(["platform-abstraction", "workspace-state-management", "session-store", "testing-regression"]),
    forbiddenImports: new Set([
      "fs",
      "node:fs",
      "fs/promises",
      "node:fs/promises",
      "child_process",
      "node:child_process",
      "keytar",
      "keychain",
      "node-keytar",
      "clipboardy",
      "open",
      "sharp"
    ]),
    forbiddenProcessProperties: new Set(["platform", "arch"]),
    forbiddenSearchCommands: new Set(["rg", "grep", "findstr", "Select-String", "select-string"]),
    forbiddenNativeNames: [/keytar/i, /keychain/i, /clipboard/i, /native/i, /sharp/i]
  },
  secretSandbox: {
    approvedPackages: new Set([
      "platform-contracts",
      "policy-sandbox",
      "runtime",
      "core-coding-tools",
      "platform-abstraction",
      "credential-auth-management",
      "command-system",
      "model-gateway",
      "workspace-state-management",
      "session-store",
      "testing-regression"
    ]),
    forbiddenSandboxProperties: new Set(["sandboxProfile", "sandboxRequirements", "sandboxCapabilities"]),
    forbiddenSecretProperties: new Set(["apiKey", "token", "secret", "password", "credential"])
  },
  scaleGuardrails: {
    maxCentralFileLines: 800,
    maxPackageIndexLines: 500,
    plannedOversizedFiles: new Set([
      "src/packages/platform-abstraction/src/index.ts",
      "src/packages/mcp-gateway/src/index.ts",
      "src/packages/model-gateway/src/index.ts",
      "src/packages/context-engine/src/index.ts",
      "src/packages/policy-sandbox/src/index.ts",
      "src/packages/runtime/src/agent-loop.ts",
      "src/packages/runtime/src/agent-loop-tools.ts",
      "src/apps/cli/src/diagnostics/swe-bench-prediction.ts",
      "src/apps/cli/src/host/swe-bench-run-capabilities.ts"
    ])
  },
  architectureDrift: {
    aliasGovernanceRecords: new Map([
      [
        "@deepseek/distribution-update-management",
        {
          status: "placeholder",
          ownerPackage: "platform-abstraction",
          severity: "warning",
          allowedConsumers: ["release diagnostics", "package-map planning", "update placeholder adapter"],
          blockedProductClaims: ["distribution-update-management", "release-channel-management", "update-catalog"],
          replacementTrigger: "Create a real src/packages/distribution-update-management workspace before update channel or release catalog promotion.",
          evidenceIds: [
            "src/packages/platform-abstraction/src/placeholders/agent-distribution.ts",
            "docs/architecture/package-map.md",
            "openspec/changes/enforce-architecture-guardrails-drift"
          ]
        }
      ],
      [
        "@deepseek/evolution-engine",
        {
          status: "placeholder",
          ownerPackage: "platform-abstraction",
          severity: "warning",
          allowedConsumers: ["release diagnostics", "package-map planning", "evolution placeholder adapter"],
          blockedProductClaims: ["evolution-engine", "feedback-loop", "managed-rollout"],
          replacementTrigger: "Create a real src/packages/evolution-engine workspace before feedback, evaluation, or managed rollout promotion.",
          evidenceIds: [
            "src/packages/platform-abstraction/src/placeholders/agent-evolution.ts",
            "docs/architecture/package-map.md",
            "openspec/changes/enforce-architecture-guardrails-drift"
          ]
        }
      ],
      [
        "@deepseek/extension-system",
        {
          status: "placeholder",
          ownerPackage: "plugin-system",
          severity: "warning",
          allowedConsumers: ["release diagnostics", "package-map planning", "governed module projection"],
          blockedProductClaims: ["extension-system", "third-party-extension-runtime", "host-extension-marketplace"],
          replacementTrigger: "Create a real src/packages/extension-system workspace or merge the alias into plugin-system before extension product promotion.",
          evidenceIds: [
            "src/packages/platform-abstraction/src/placeholders/agent-extension.ts",
            "docs/architecture/plugin-module-boundaries.md",
            "openspec/changes/enforce-architecture-guardrails-drift"
          ]
        }
      ],
      [
        "@deepseek/remote-runtime-connectivity",
        {
          status: "placeholder",
          ownerPackage: "platform-abstraction",
          severity: "warning",
          allowedConsumers: ["release diagnostics", "package-map planning", "remote placeholder adapter"],
          blockedProductClaims: ["remote-runtime-connectivity", "server-runtime", "remote-control-api"],
          replacementTrigger: "Create a real src/packages/remote-runtime-connectivity workspace before server, SDK, or remote runtime promotion.",
          evidenceIds: [
            "src/packages/platform-abstraction/src/placeholders/agent-remote.ts",
            "docs/architecture/future-host-landings.md",
            "openspec/changes/enforce-architecture-guardrails-drift"
          ]
        }
      ]
    ])
  }
};
