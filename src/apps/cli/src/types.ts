import type {
  AgentLoopOutputMode,
  AgentLoopOutputContract,
  DiagnosticsCommandName,
  ExtensionManagementCommandKind,
  JsonObject,
  CliKeymapProfileName,
  CliTuiProfile,
  ModelReasoningOptions,
  ReadinessCommandName,
  RuntimeDependencies,
  RuntimeKernel,
  SessionId,
  TurnId,
  WorkspaceRevertRequestTarget
} from "@deepseek/platform-contracts";

export interface CliTerminalFlags {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
}

export type CliCommand = "run" | "chat" | "readiness" | "diagnostics" | "extension" | "palette" | "revert" | "tools-smoke" | "help" | "session" | "mcp" | "index-provider" | "mode" | "memory" | "context" | "checks" | "file" | "repo" | "git" | "jump";
export type CliPaletteAction = "list" | "keymap" | "action";
export type CliRevertAction = "preview" | "apply";
export type CliIndexProviderAction = "status" | "set";
export type CliModeAction = "status" | "agent" | "workers" | "verify" | "plan";

export interface CliOptions {
  readonly command: CliCommand;
  readonly prompt: string;
  readonly output: AgentLoopOutputMode;
  readonly outputContract?: AgentLoopOutputContract;
  readonly live: boolean;
  readonly modelProvider?: "deepseek" | "glm";
  readonly model?: string;
  readonly tuiProfile?: CliTuiProfile;
  readonly timeoutMs?: number;
  readonly reasoning?: ModelReasoningOptions;
  readonly readinessCommand?: ReadinessCommandName;
  readonly readinessInput?: JsonObject;
  readonly diagnosticsCommand?: DiagnosticsCommandName;
  readonly diagnosticsInput?: JsonObject;
  readonly extensionCommand?: ExtensionManagementCommandKind;
  readonly extensionInput?: JsonObject;
  readonly paletteAction?: CliPaletteAction;
  readonly paletteKeymapProfile?: CliKeymapProfileName;
  readonly paletteActionName?: string;
  readonly paletteTargetId?: string;
  readonly revertAction?: CliRevertAction;
  readonly revertTarget?: WorkspaceRevertRequestTarget;
  readonly revertReason?: string;
  readonly sessionAction?: "resume" | "fork";
  readonly sessionId?: SessionId;
  readonly turnId?: TurnId;
  readonly parentSessionId?: SessionId;
  readonly mcpAction?: "test";
  readonly mcpManifestPath?: string;
  readonly mcpCallTool?: string;
  readonly mcpCallInput?: string;
  readonly enableRealMcp?: boolean;
  readonly indexProviderAction?: CliIndexProviderAction;
  readonly indexProviderId?: string;
  readonly indexProviderStatus?: string;
  readonly indexProviderScope?: "workspace" | "user";
  readonly modeAction?: CliModeAction;
  readonly modeRequestedTransition?: string;
  readonly toolProjection?: "none" | "read-only" | "read-write" | "all";
  readonly memoryAction?: "status" | "list" | "candidates" | "remember" | "approve" | "reject" | "edit" | "delete" | "enable" | "disable" | "export" | "explain";
  readonly memoryInput?: JsonObject;
  readonly contextInput?: JsonObject;
  readonly checkAction?: "openspec" | "typecheck" | "lint" | "test" | "boundaries" | "build-cli";
  readonly checkInput?: JsonObject;
  readonly fileAction?: "list" | "preview" | "references";
  readonly fileInput?: JsonObject;
  readonly repoAction?: "files" | "grep" | "recall" | "project-index";
  readonly repoInput?: JsonObject;
  readonly gitInput?: JsonObject;
  readonly jumpAction?: "file" | "text" | "symbol";
  readonly jumpInput?: JsonObject;
}

export type CliWrite = (line: string) => void | Promise<void>;
export type CliInputChunk = Uint8Array | string;
export type CliInputStream = AsyncIterable<CliInputChunk> | Iterable<CliInputChunk>;

export interface CliRuntimeFactoryOptions {
  readonly live: boolean;
  readonly workspaceRoot: string;
  readonly toolProjection?: CliOptions["toolProjection"];
  readonly modelProvider?: CliOptions["modelProvider"];
  readonly model?: CliOptions["model"];
}

export interface CliRunOptions {
  readonly createRuntime?: (options: CliRuntimeFactoryOptions) => Promise<{ readonly deps: RuntimeDependencies; readonly kernel: RuntimeKernel }>;
}
