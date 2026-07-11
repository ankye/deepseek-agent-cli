import { appendFile as fsAppendFile, cp, mkdir, mkdtemp, readFile as fsReadFile, rename, rm, stat as stat_, writeFile as fsWriteFile, readdir } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, posix, resolve, win32 } from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type {
  JsonObject,
  NativeCapabilityName,
  NativeCapabilityProbe,
  PlatformDescriptor,
  PlatformDiagnostic,
  PlatformEnvironmentKind,
  PlatformOsFamily,
  PlatformPathTranslation,
  PlatformPersistenceDiagnostic,
  PlatformPersistenceMetadata,
  PlatformProviderName,
  PlatformProviderResultMetadata,
  PlatformRuntime,
  PlatformResolvedPath,
  ProcessProviderDescriptor,
  ProcessRunControl,
  ProcessRunObserver,
  ProcessResult,
  ProcessRunOptions,
  RedactedError,
  SandboxCapabilityMatrix,
  SearchProviderDescriptor,
  SearchResult,
  SecureStorageCapability,
  SerializableResult,
  ShellProfile,
  ShellProviderDescriptor,
  WatcherCapability
} from "@deepseek/platform-contracts";
import { SECRET_SANDBOX_SCHEMA_VERSION } from "@deepseek/platform-contracts";

export class NodePlatformRuntime implements PlatformRuntime {
  readonly os: PlatformOsFamily;
  readonly environmentKind: PlatformEnvironmentKind;
  readonly architecture: string;
  private readonly noLocalShell: boolean;
  private readonly readOnlyFilesystem: boolean;
  private readonly networkStatus: PlatformProviderResultMetadata["status"];

  constructor(
    os: PlatformOsFamily = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
    options: {
      readonly environmentKind?: PlatformEnvironmentKind;
      readonly architecture?: string;
      readonly noLocalShell?: boolean;
      readonly readOnlyFilesystem?: boolean;
      readonly networkStatus?: PlatformProviderResultMetadata["status"];
    } = {}
  ) {
    this.os = os;
    this.environmentKind = options.environmentKind ?? detectEnvironmentKind();
    this.architecture = options.architecture ?? process.arch;
    this.noLocalShell = options.noLocalShell ?? this.environmentKind === "remote";
    this.readOnlyFilesystem = options.readOnlyFilesystem ?? false;
    this.networkStatus = options.networkStatus ?? "available";
  }

  async descriptor(): Promise<PlatformDescriptor> {
    const shell = (await this.resolveShell()).value ?? unavailableShell("none", "SHELL_UNAVAILABLE", "No shell provider is available on this host.");
    const processProvider = await this.resolveProcessProvider();
    const search = await this.selectSearchProvider();
    const secureStorage = await this.secureStorageCapability();
    const watcher = await this.watcherCapability(process.cwd());
    const nativeCapabilities = await Promise.all(
      (["voice", "clipboard", "url-handler", "image-processing", "file-watcher", "secure-storage"] as const).map((capability) => this.probeNativeCapability(capability))
    );
    const diagnostics = [
      ...shell.diagnostics,
      ...processProvider.diagnostics,
      ...search.diagnostics,
      ...secureStorage.diagnostics,
      ...watcher.diagnostics,
      ...nativeCapabilities.flatMap((capability) => capability.diagnostics)
    ];
    const degradedReasons = diagnostics.filter((diagnostic) => diagnostic.severity !== "info").map((diagnostic) => diagnostic.code);
    const sandbox = sandboxCapabilities({
      filesystemReadOnly: this.readOnlyFilesystem,
      shell,
      processProvider,
      secureStorage,
      nativeCapabilities,
      networkStatus: this.networkStatus,
      degradedReasons
    });
    return {
      os: this.os,
      environmentKind: this.environmentKind,
      architecture: this.architecture,
      shell,
      processProvider,
      search,
      secureStorage,
      nativeCapabilities,
      watcher,
      filesystem: filesystemSemantics(this.os),
      sandbox,
      degraded: sandbox.degraded,
      degradedReasons: sandbox.degradedReasons,
      diagnostics,
      redaction: { class: "internal", fields: ["diagnostics.details"] }
    };
  }

  async resolveShell(profile: ShellProfile = defaultShellProfile(this.os)): Promise<SerializableResult<ShellProviderDescriptor>> {
    if (this.noLocalShell || profile === "none") {
      const shell = unavailableShell(profile, "SHELL_UNAVAILABLE", this.noLocalShell ? "This host does not expose a local shell." : "Shell execution was not requested.");
      return profile === "none" && !this.noLocalShell ? { ok: true, value: shell } : { ok: false, error: platformError("SHELL_UNAVAILABLE", shell.diagnostics[0]?.message ?? "Shell unavailable.", { profile }) };
    }
    if (profile === "powershell") {
      return {
        ok: true,
        value: {
          profile,
          provider: "powershell",
          available: true,
          status: "available",
          command: this.os === "windows" ? "powershell.exe" : "pwsh",
          args: ["-NoProfile", "-Command"],
          requiresShellSyntax: true,
          diagnostics: [],
          redaction: { class: "public" }
        }
      };
    }
    if (profile === "cmd") {
      return {
        ok: true,
        value: {
          profile,
          provider: "cmd",
          available: this.os === "windows",
          status: this.os === "windows" ? "available" : "unavailable",
          command: "cmd.exe",
          args: ["/d", "/s", "/c"],
          requiresShellSyntax: true,
          diagnostics: this.os === "windows" ? [] : [diagnostic("CMD_UNAVAILABLE", "warn", "cmd shell is only available on Windows.")],
          redaction: { class: "public" }
        }
      };
    }
    return {
      ok: true,
      value: {
        profile,
        provider: profile === "bash" ? "bash" : "bash",
        available: true,
        status: this.os === "windows" ? "degraded" : "available",
        command: profile === "bash" ? "bash" : "sh",
        args: ["-lc"],
        requiresShellSyntax: true,
        diagnostics: this.os === "windows" ? [diagnostic("POSIX_SHELL_ON_WINDOWS", "warn", "POSIX shell on Windows depends on user-installed tooling.")] : [],
        redaction: { class: "public" }
      }
    };
  }

  async selectSearchProvider(preferred?: PlatformProviderName): Promise<SearchProviderDescriptor> {
    const fallbackChain = searchFallbackChain(this.os);
    const selected = preferred && fallbackChain.includes(preferred) ? preferred : fallbackChain[0] ?? "js";
    const degraded = selected === "js";
    return {
      provider: selected,
      available: true,
      status: degraded ? "degraded" : "available",
      timeoutMs: this.environmentKind === "wsl" ? 20_000 : 10_000,
      fallbackChain,
      diagnostics: degraded ? [diagnostic("SEARCH_JS_FALLBACK", "warn", "Search provider is using deterministic JavaScript fallback.")] : [],
      redaction: { class: "public" }
    };
  }

  async resolveProcessProvider(): Promise<ProcessProviderDescriptor> {
    if (this.environmentKind === "remote") {
      return {
        provider: "none",
        available: false,
        status: "unavailable",
        shell: false,
        diagnostics: [diagnostic("PROCESS_UNAVAILABLE", "error", "Remote host does not expose local process execution.")],
        redaction: { class: "public" }
      };
    }
    return {
      provider: "argv",
      available: true,
      status: "available",
      shell: false,
      diagnostics: [],
      redaction: { class: "public" }
    };
  }

  resolveWorkspacePath(workspaceRoot: string, inputPath: string): SerializableResult<PlatformResolvedPath> {
    if (isUnsupportedWorkspacePathSyntax(inputPath)) {
      return {
        ok: false,
        error: platformError("PLATFORM_PATH_REJECTED", "Workspace path contains unsupported home, drive-relative, null-byte, UNC, glob, shell-expansion, or trailing dot/space syntax.", { inputPath })
      };
    }
    const pathApi = workspacePathApi(this.os);
    const root = pathApi.resolve(workspaceRoot);
    const target = pathApi.isAbsolute(inputPath) ? pathApi.resolve(inputPath) : pathApi.resolve(root, inputPath);
    const filesystem = filesystemSemantics(this.os);
    if (!isPathInside(root, target, filesystem.caseSensitive, pathApi)) {
      return {
        ok: false,
        error: platformError("PLATFORM_PATH_OUTSIDE_ROOT", "Workspace path resolved outside the governed root.", { workspaceRoot: root })
      };
    }
    const relativePath = relativePathInside(root, target, filesystem.caseSensitive, pathApi);
    return {
      ok: true,
      value: {
        path: target,
        root,
        relativePath,
        safe: true,
        diagnostics: [],
        redaction: { class: "internal", fields: ["path", "root", "relativePath"] }
      }
    };
  }

  translatePath(path: string, targetEnvironment: PlatformEnvironmentKind): SerializableResult<PlatformPathTranslation> {
    if (path.startsWith("~") || hasAmbiguousDriveRelativePath(path)) {
      return { ok: false, error: platformError("PATH_TRANSLATION_REJECTED", "Path translation rejected unsafe path syntax.", { path }) };
    }
    const translatedPath = this.environmentKind === "wsl" && targetEnvironment === "local" && path.startsWith("/mnt/")
      ? wslToWindowsPath(path)
      : normalize(path);
    return {
      ok: true,
      value: {
        sourcePath: path,
        translatedPath,
        sourceEnvironment: this.environmentKind,
        targetEnvironment,
        metadata: providerMetadata("js", "available", [], undefined, []),
        redaction: { class: "internal", fields: ["sourcePath", "translatedPath"] }
      }
    };
  }

  async secureStorageCapability(): Promise<SecureStorageCapability> {
    const unavailable = this.environmentKind === "ci" || this.environmentKind === "remote";
    return {
      status: unavailable ? "unavailable" : "degraded",
      provider: unavailable ? "none" : "environment",
      scopedReferences: !unavailable,
      diagnostics: unavailable
        ? [diagnostic("SECURE_STORAGE_UNAVAILABLE", "warn", "Secure storage is unavailable in this host mode.")]
        : [diagnostic("SECURE_STORAGE_ENV_ONLY", "warn", "Secure storage is limited to environment-backed credential references.")],
      redaction: { class: "secret", fields: ["provider"] }
    };
  }

  async probeNativeCapability(capability: NativeCapabilityName): Promise<NativeCapabilityProbe> {
    if (capability === "secure-storage") {
      const secureStorage = await this.secureStorageCapability();
      return {
        capability,
        status: secureStorage.status,
        provider: secureStorage.provider,
        diagnostics: secureStorage.diagnostics,
        redaction: { class: "internal" }
      };
    }
    if (capability === "file-watcher") {
      const watcher = await this.watcherCapability(process.cwd());
      return {
        capability,
        status: watcher.status,
        provider: watcher.provider,
        diagnostics: watcher.diagnostics,
        redaction: { class: "internal" }
      };
    }
    return {
      capability,
      status: "unavailable",
      provider: "none",
      diagnostics: [diagnostic("NATIVE_CAPABILITY_UNAVAILABLE", "warn", `Native capability ${capability} is not available in the base platform adapter.`)],
      redaction: { class: "internal" }
    };
  }

  async watcherCapability(_root: string): Promise<WatcherCapability> {
    const unavailable = this.environmentKind === "remote";
    return {
      status: unavailable ? "unavailable" : "degraded",
      provider: unavailable ? "none" : "polling",
      recursive: !unavailable,
      diagnostics: unavailable ? [diagnostic("WATCHER_UNAVAILABLE", "warn", "File watching is unavailable without local filesystem access.")] : [diagnostic("WATCHER_POLLING", "info", "File watching uses deterministic polling semantics.")],
      redaction: { class: "internal" }
    };
  }

  resolvePath(...parts: readonly string[]): string {
    return resolve(...parts);
  }

  async createTempDirectory(prefix: string): Promise<string> {
    const root = resolve(tmpdir(), "deepseek-evaluation-runs");
    await mkdir(root, { recursive: true });
    return mkdtemp(join(root, prefix));
  }

  async ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  userConfigPath(appName: string): string {
    if (this.os === "windows") return resolve(process.env.APPDATA ?? join(process.cwd(), ".appdata"), appName, "config.json");
    if (this.os === "macos") return resolve(process.env.HOME ?? process.cwd(), "Library", "Application Support", appName, "config.json");
    return resolve(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? process.cwd(), ".config"), appName, "config.json");
  }

  workspaceMetadataPath(workspaceRoot: string, appName: string): SerializableResult<string> {
    const root = resolve(workspaceRoot);
    const metadataPath = resolve(root, `.${appName}`, "config.json");
    if (!isPathInside(root, metadataPath)) {
      return {
        ok: false,
        error: {
          code: "WORKSPACE_METADATA_PATH_OUTSIDE_ROOT",
          message: "Workspace metadata path resolved outside the workspace root.",
          retryable: false,
          redaction: { class: "public" },
          details: { workspaceRoot: root }
        }
      };
    }
    return { ok: true, value: metadataPath };
  }

  async atomicWriteFile(path: string, content: string): Promise<SerializableResult<PlatformPersistenceMetadata>> {
    if (this.readOnlyFilesystem) {
      return {
        ok: false,
        error: {
          code: "FILESYSTEM_READ_ONLY",
          message: "The active platform reports a read-only filesystem.",
          retryable: false,
          redaction: { class: "public" },
          details: { path: resolve(path), os: this.os }
        }
      };
    }
    const target = resolve(path);
    const temp = `${target}.tmp`;
    try {
      await mkdir(dirname(target), { recursive: true });
      await fsWriteFile(temp, content, "utf8");
      await rename(temp, target);
      return {
        ok: true,
        value: {
          path: target,
          pathKind: "workspace-metadata",
          os: this.os,
          atomic: true,
          redaction: { class: "internal", fields: ["path"] }
        }
      };
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      return {
        ok: false,
        error: {
          code: "ATOMIC_WRITE_FAILED",
          message: error instanceof Error ? error.message : "Atomic write failed.",
          retryable: true,
          redaction: { class: "public" },
          details: { path: target, os: this.os }
        }
      };
    }
  }

  async permissionDiagnostics(path: string): Promise<readonly PlatformPersistenceDiagnostic[]> {
    return [
      {
        code: "PERMISSION_DIAGNOSTIC_AVAILABLE",
        severity: "info",
        message: "Permission diagnostics are available for the configured platform adapter.",
        path: resolve(path),
        os: this.os,
        suggestedActions: [],
        redaction: { class: "internal", fields: ["path"] }
      }
    ];
  }

  async readFile(path: string): Promise<string> {
    return fsReadFile(path, "utf8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (this.readOnlyFilesystem) throw new Error("FILESYSTEM_READ_ONLY");
    await fsWriteFile(path, content, "utf8");
  }

  async appendFile(path: string, content: string): Promise<void> {
    if (this.readOnlyFilesystem) throw new Error("FILESYSTEM_READ_ONLY");
    await mkdir(dirname(path), { recursive: true });
    await fsAppendFile(path, content, "utf8");
  }

  async statPath(path: string) {
    const stat = await stat_(path);
    return {
      path: resolve(path),
      kind: stat.isFile() ? "file" as const : stat.isDirectory() ? "directory" as const : "other" as const,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs
    };
  }

  async copyPath(sourcePath: string, targetPath: string, options: { readonly overwrite?: boolean; readonly recursive?: boolean } = {}): Promise<void> {
    if (this.readOnlyFilesystem) throw new Error("FILESYSTEM_READ_ONLY");
    const sourceStat = await stat_(sourcePath);
    if (sourceStat.isDirectory() && options.recursive !== true) throw new Error("COPY_RECURSIVE_REQUIRED");
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, {
      recursive: sourceStat.isDirectory(),
      errorOnExist: options.overwrite !== true,
      force: options.overwrite === true
    });
  }

  async movePath(sourcePath: string, targetPath: string, options: { readonly overwrite?: boolean } = {}): Promise<void> {
    if (this.readOnlyFilesystem) throw new Error("FILESYSTEM_READ_ONLY");
    await mkdir(dirname(targetPath), { recursive: true });
    if (options.overwrite === true) await rm(targetPath, { recursive: true, force: true });
    await rename(sourcePath, targetPath);
  }

  async deletePath(path: string, options: { readonly recursive?: boolean } = {}): Promise<void> {
    if (this.readOnlyFilesystem) throw new Error("FILESYSTEM_READ_ONLY");
    const targetStat = await stat_(path);
    if (targetStat.isDirectory() && options.recursive !== true) throw new Error("DELETE_RECURSIVE_REQUIRED");
    await rm(path, { recursive: targetStat.isDirectory(), force: false });
  }

  async findFiles(pattern: string, root: string): Promise<readonly string[]> {
    const files: string[] = [];
    await walk(root, files);
    const normalizedPattern = normalizePathForSearch(pattern);
    return files.filter((file) => normalizePathForSearch(file).includes(normalizedPattern));
  }

  async searchText(pattern: string, root: string): Promise<readonly SearchResult[]> {
    const provider = await this.selectSearchProvider();
    const metadata = providerMetadata(provider.provider, provider.status, provider.fallbackChain, provider.diagnostics[0]?.code, provider.diagnostics);
    const files: string[] = [];
    await walk(root, files);
    const results: SearchResult[] = [];
    for (const file of files) {
      const content = await fsReadFile(file, "utf8").catch(() => "");
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.includes(pattern)) {
          results.push({
            path: file,
            line: index + 1,
            text: line,
            engine: provider.provider === "rg" || provider.provider === "grep" || provider.provider === "select-string" ? provider.provider : "js",
            ...(metadata.fallbackReason ? { fallbackReason: metadata.fallbackReason } : {}),
            metadata
          });
        }
      });
    }
    return results;
  }

  async runProcess(command: string, args: readonly string[], options: ProcessRunOptions = {}, observer?: ProcessRunObserver, control?: ProcessRunControl): Promise<ProcessResult> {
    const processProvider = await this.resolveProcessProvider();
    if (!processProvider.available) {
      return {
        exitCode: 126,
        stdout: "",
        stderr: processProvider.diagnostics[0]?.message ?? "Process execution is unavailable.",
        metadata: providerMetadata("none", "unavailable", [], processProvider.diagnostics[0]?.code, processProvider.diagnostics)
      };
    }
    return new Promise((resolvePromise) => {
      const executionProfile = options.executionProfile ?? "default";
      const stdinMode = options.stdin ?? (executionProfile === "noninteractive" ? "ignore" : "pipe");
      const scopedEnv = stringRecord(options.env);
      const profileEnv = executionProfile === "noninteractive" ? noninteractiveProcessEnv() : {};
      const profileDiagnostics = executionProfile === "noninteractive"
        ? [
            diagnostic("PROCESS_NONINTERACTIVE_PROFILE", "info", "Process ran with noninteractive stdin, pager/editor guards, and bounded machine-output hygiene."),
            ...(isGitCommand(command) ? [diagnostic("GIT_PAGER_DISABLED", "info", "Git process ran with pager and editor prompts disabled.")] : [])
          ]
        : [];
      const outputLimitBytes = typeof options.outputLimitBytes === "number" && Number.isFinite(options.outputLimitBytes) && options.outputLimitBytes > 0
        ? Math.floor(options.outputLimitBytes)
        : undefined;
      const invocation = processSpawnInvocation(this.os, command, args, executionProfile);
      const useProcessGroup = process.platform !== "win32";
      const child = spawn(invocation.command, [...invocation.args], {
        cwd: typeof options.cwd === "string" ? options.cwd : undefined,
        env: { ...process.env, ...profileEnv, ...scopedEnv },
        shell: false,
        stdio: [stdinMode === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
        detached: useProcessGroup,
        windowsHide: true
      });
      const timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : undefined;
      let stdout = "";
      let stderr = "";
      let settled = false;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (stdinMode === "pipe") child.stdin?.end();
      const finish = (result: ProcessResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        control?.signal?.removeEventListener("abort", onAbort);
        observer?.onProcessExit?.();
        resolvePromise(result);
      };
      const onAbort = () => {
        stderr += `${stderr ? "\n" : ""}Process aborted by caller.`;
        killProcessTree(child, "SIGKILL");
        finish({ exitCode: 130, stdout, stderr, metadata: providerMetadata("argv", "degraded", [], "PROCESS_ABORTED", [diagnostic("PROCESS_ABORTED", "error", "Process aborted by caller."), ...profileDiagnostics], timeoutMs) });
      };
      if (control?.signal?.aborted) {
        onAbort();
        return;
      }
      control?.signal?.addEventListener("abort", onAbort, { once: true });
      timer = timeoutMs
        ? setTimeout(() => {
          stderr += `${stderr ? "\n" : ""}Process timed out after ${timeoutMs}ms.`;
          killProcessTree(child, "SIGKILL");
          finish({ exitCode: 124, stdout, stderr, metadata: providerMetadata("argv", "degraded", [], "PROCESS_TIMEOUT", [diagnostic("PROCESS_TIMEOUT", "error", `Process timed out after ${timeoutMs}ms.`), ...profileDiagnostics], timeoutMs) });
        }, timeoutMs)
        : undefined;
      child.stdout?.on("data", (chunk) => {
        const text = String(chunk);
        observer?.onStdoutChunk?.(text);
        const next = appendBoundedOutput(stdout, text, outputLimitBytes);
        stdout = next.text;
        stdoutTruncated ||= next.truncated;
      });
      child.stderr?.on("data", (chunk) => {
        const text = String(chunk);
        observer?.onStderrChunk?.(text);
        const next = appendBoundedOutput(stderr, text, outputLimitBytes);
        stderr = next.text;
        stderrTruncated ||= next.truncated;
      });
      child.on("close", (exitCode) => {
        const truncationDiagnostics = [
          ...(stdoutTruncated ? [diagnostic("PROCESS_STDOUT_TRUNCATED", "warn", `Process stdout exceeded ${outputLimitBytes} bytes and was truncated.`)] : []),
          ...(stderrTruncated ? [diagnostic("PROCESS_STDERR_TRUNCATED", "warn", `Process stderr exceeded ${outputLimitBytes} bytes and was truncated.`)] : [])
        ];
        finish({
          exitCode: exitCode ?? 0,
          stdout,
          stderr,
          metadata: providerMetadata("argv", truncationDiagnostics.length > 0 ? "degraded" : "available", [], truncationDiagnostics[0]?.code, [...profileDiagnostics, ...truncationDiagnostics], timeoutMs)
        });
      });
      child.on("error", (error) => finish({ exitCode: 1, stdout, stderr: error.message, metadata: providerMetadata("argv", "degraded", [], "PROCESS_SPAWN_FAILED", [diagnostic("PROCESS_SPAWN_FAILED", "error", error.message), ...profileDiagnostics], timeoutMs) }));
    });
  }

  async availability(): Promise<JsonObject> {
    const descriptor = await this.descriptor();
    return {
      os: this.os,
      environmentKind: this.environmentKind,
      descriptor,
      searchFallbacks: descriptor.search.fallbackChain,
      degraded: descriptor.degraded,
      degradedReasons: descriptor.degradedReasons
    };
  }

  spawnMcpServer(command: string, args: readonly string[]): {
    readonly stdin: import("node:stream").Writable;
    readonly stdout: import("node:stream").Readable;
    readonly stderr?: import("node:stream").Readable;
    readonly kill: (signal?: "SIGTERM" | "SIGKILL") => void;
    readonly exit: Promise<number>;
  } {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    const exit = new Promise<number>((resolvePromise) => {
      child.once("exit", (code) => resolvePromise(code ?? 0));
    });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      kill: (signal?: "SIGTERM" | "SIGKILL") => { child.kill(signal ?? "SIGTERM"); },
      exit
    };
  }

  async readBinaryFile(path: string): Promise<Uint8Array> {
    return fsReadFile(path);
  }

  async statFile(path: string): Promise<{ mtimeMs: number; size: number }> {
    const stat = await this.statPath(path);
    return { mtimeMs: stat.mtimeMs, size: stat.sizeBytes };
  }

  async httpFetch(url: string, options: {
    readonly method?: "GET" | "HEAD";
    readonly headers?: Record<string, string>;
    readonly maxRedirects?: number;
    readonly maxBytes?: number;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {}): Promise<{
    readonly status: number;
    readonly finalUrl: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly truncated: boolean;
    readonly redirects: number;
  }> {
    const maxBytes = options.maxBytes ?? 10_000_000;
    const maxRedirects = options.maxRedirects ?? 5;
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`httpFetch: only http(s) URLs are allowed (got: ${url.slice(0, 16)}...)`);
    }
    const signals: AbortSignal[] = [];
    signals.push(AbortSignal.timeout(timeoutMs));
    if (options.signal) signals.push(options.signal);
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    const response = await fetch(url, {
      method: options.method ?? "GET",
      ...(options.headers ? { headers: options.headers } : {}),
      redirect: "follow",
      signal
    });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let bytes = 0;
    let truncated = false;
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          truncated = true;
          break;
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
      if (truncated) await reader.cancel().catch(() => undefined);
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of response.headers) headers[key.toLowerCase()] = value;
    const redirects = response.redirected ? Math.min(maxRedirects, 1) : 0;
    return {
      status: response.status,
      finalUrl: response.url,
      headers,
      body,
      truncated,
      redirects
    };
  }
}

export class FakePlatformRuntime extends NodePlatformRuntime {
  private readonly files = new Map<string, string>();
  failNextAtomicWrite = false;

  constructor(
    os: PlatformOsFamily = "fake",
    private readonly fakeRoot = "/workspace",
    options: {
      readonly environmentKind?: PlatformEnvironmentKind;
      readonly noLocalShell?: boolean;
      readonly secureStorageStatus?: "available" | "degraded" | "unavailable";
      readonly nativeStatus?: "available" | "degraded" | "unavailable";
      readonly searchProvider?: PlatformProviderName;
      readonly readOnlyFilesystem?: boolean;
      readonly networkStatus?: PlatformProviderResultMetadata["status"];
    } = {}
  ) {
    super(os, {
      environmentKind: options.environmentKind ?? "test",
      architecture: "fake-arch",
      noLocalShell: options.noLocalShell ?? false,
      readOnlyFilesystem: options.readOnlyFilesystem ?? false,
      networkStatus: options.networkStatus ?? "available"
    });
    this.fakeOptions = options;
  }

  private readonly fakeOptions: {
    readonly environmentKind?: PlatformEnvironmentKind;
    readonly noLocalShell?: boolean;
    readonly secureStorageStatus?: "available" | "degraded" | "unavailable";
    readonly nativeStatus?: "available" | "degraded" | "unavailable";
    readonly searchProvider?: PlatformProviderName;
    readonly readOnlyFilesystem?: boolean;
    readonly networkStatus?: PlatformProviderResultMetadata["status"];
  };

  override userConfigPath(appName: string): string {
    if (this.os === "windows") return normalize(`C:/Users/fake/AppData/Roaming/${appName}/config.json`);
    if (this.os === "macos") return normalize(`/Users/fake/Library/Application Support/${appName}/config.json`);
    if (this.os === "linux") return normalize(`/home/fake/.config/${appName}/config.json`);
    return normalize(`${this.fakeRoot}/.config/${appName}/config.json`);
  }

  override workspaceMetadataPath(workspaceRoot: string, appName: string): SerializableResult<string> {
    if (workspaceRoot.includes("..") || workspaceRoot.startsWith("~")) {
      return {
        ok: false,
        error: {
          code: "WORKSPACE_METADATA_PATH_REJECTED",
          message: "Workspace metadata path contains unsafe segments.",
          retryable: false,
          redaction: { class: "public" }
        }
      };
    }
    const root = isAbsolute(workspaceRoot) ? normalize(workspaceRoot) : normalize(`${this.fakeRoot}/${workspaceRoot}`);
    return { ok: true, value: normalize(`${root}/.deepseek/config.json`) };
  }

  override resolveWorkspacePath(workspaceRoot: string, inputPath: string): SerializableResult<PlatformResolvedPath> {
    if (isUnsupportedWorkspacePathSyntax(inputPath)) {
      return {
        ok: false,
        error: platformError("PLATFORM_PATH_REJECTED", "Workspace path contains unsupported home, drive-relative, null-byte, UNC, glob, shell-expansion, or trailing dot/space syntax.", { inputPath })
      };
    }
    const root = normalizeVirtualPath(isVirtualAbsolutePath(workspaceRoot) ? workspaceRoot : `${this.fakeRoot}/${workspaceRoot}`);
    const target = normalizeVirtualPath(isVirtualAbsolutePath(inputPath) ? inputPath : `${root}/${inputPath}`);
    const filesystem = filesystemSemantics(this.os);
    if (!isVirtualPathInside(root, target, filesystem.caseSensitive)) {
      return {
        ok: false,
        error: platformError("PLATFORM_PATH_OUTSIDE_ROOT", "Workspace path resolved outside the governed root.", { workspaceRoot: root })
      };
    }
    const relativePath = virtualRelativePathInside(root, target, filesystem.caseSensitive);
    return {
      ok: true,
      value: {
        path: target,
        root,
        relativePath,
        safe: true,
        diagnostics: [],
        redaction: { class: "internal", fields: ["path", "root", "relativePath"] }
      }
    };
  }

  override async selectSearchProvider(preferred?: PlatformProviderName): Promise<SearchProviderDescriptor> {
    const base = await super.selectSearchProvider(preferred);
    const provider = this.fakeOptions.searchProvider ?? base.provider;
    const degraded = provider === "js";
    return {
      ...base,
      provider,
      status: degraded ? "degraded" : "available",
      fallbackChain: searchFallbackChain(this.os),
      diagnostics: degraded ? [diagnostic("SEARCH_JS_FALLBACK", "warn", "Fake platform selected JavaScript search fallback.")] : []
    };
  }

  override async secureStorageCapability(): Promise<SecureStorageCapability> {
    const status = this.fakeOptions.secureStorageStatus ?? "degraded";
    return {
      status,
      provider: status === "available" ? "fake-storage" : status === "degraded" ? "environment" : "none",
      scopedReferences: status !== "unavailable",
      diagnostics: status === "unavailable" ? [diagnostic("SECURE_STORAGE_UNAVAILABLE", "warn", "Fake platform secure storage is unavailable.")] : [],
      redaction: { class: "secret", fields: ["provider"] }
    };
  }

  override async probeNativeCapability(capability: NativeCapabilityName): Promise<NativeCapabilityProbe> {
    if (capability === "secure-storage") return super.probeNativeCapability(capability);
    const status = this.fakeOptions.nativeStatus ?? (capability === "file-watcher" ? "degraded" : "unavailable");
    return {
      capability,
      status,
      provider: status === "unavailable" ? "none" : "fake-native",
      diagnostics: status === "unavailable" ? [diagnostic("NATIVE_CAPABILITY_UNAVAILABLE", "warn", `Fake native capability ${capability} is unavailable.`)] : [],
      redaction: { class: "internal" }
    };
  }

  override async atomicWriteFile(path: string, content: string): Promise<SerializableResult<PlatformPersistenceMetadata>> {
    if (this.fakeOptions.readOnlyFilesystem) {
      return {
        ok: false,
        error: {
          code: "FILESYSTEM_READ_ONLY",
          message: "Fake platform filesystem is read-only.",
          retryable: false,
          redaction: { class: "public" },
          details: { path, os: this.os }
        }
      };
    }
    if (this.failNextAtomicWrite) {
      this.failNextAtomicWrite = false;
      return {
        ok: false,
        error: {
          code: "ATOMIC_WRITE_FAILED",
          message: "Fake atomic write failure.",
          retryable: true,
          redaction: { class: "public" },
          details: { path, os: this.os }
        }
      };
    }
    this.files.set(normalizeVirtualPath(path), content);
    return {
      ok: true,
      value: {
        path: normalizeVirtualPath(path),
        pathKind: "workspace-metadata",
        os: this.os,
        atomic: true,
        redaction: { class: "internal", fields: ["path"] }
      }
    };
  }

  override async permissionDiagnostics(path: string): Promise<readonly PlatformPersistenceDiagnostic[]> {
    return [
      {
        code: "FAKE_PERMISSION_OK",
        severity: "info",
        message: "Fake platform permissions are deterministic.",
        path: normalize(path),
        os: this.os,
        suggestedActions: [],
        redaction: { class: "internal", fields: ["path"] }
      }
    ];
  }

  override async readFile(path: string): Promise<string> {
    const normalized = normalizeVirtualPath(path);
    const value = this.files.get(normalized);
    if (value === undefined) throw new Error(`Fake file not found: ${normalized}`);
    return value;
  }

  override async writeFile(path: string, content: string): Promise<void> {
    if (this.fakeOptions.readOnlyFilesystem) throw new Error("FILESYSTEM_READ_ONLY");
    this.files.set(normalizeVirtualPath(path), content);
  }

  override async appendFile(path: string, content: string): Promise<void> {
    if (this.fakeOptions.readOnlyFilesystem) throw new Error("FILESYSTEM_READ_ONLY");
    const normalized = normalizeVirtualPath(path);
    this.files.set(normalized, `${this.files.get(normalized) ?? ""}${content}`);
  }

  override async statPath(path: string) {
    const normalized = normalizeVirtualPath(path);
    const content = this.files.get(normalized);
    if (content !== undefined) {
      return {
        path: normalized,
        kind: "file" as const,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        mtimeMs: 0
      };
    }
    if ([...this.files.keys()].some((candidate) => candidate.startsWith(`${normalized}/`))) {
      return {
        path: normalized,
        kind: "directory" as const,
        sizeBytes: 0,
        mtimeMs: 0
      };
    }
    throw new Error(`Fake path not found: ${normalized}`);
  }

  override async copyPath(sourcePath: string, targetPath: string, options: { readonly overwrite?: boolean; readonly recursive?: boolean } = {}): Promise<void> {
    if (this.fakeOptions.readOnlyFilesystem) throw new Error("FILESYSTEM_READ_ONLY");
    const source = normalizeVirtualPath(sourcePath);
    const target = normalizeVirtualPath(targetPath);
    const content = this.files.get(source);
    if (content !== undefined) {
      if (options.overwrite !== true && this.pathExists(target)) throw new Error("TARGET_EXISTS");
      this.files.set(target, content);
      return;
    }
    const sourcePrefix = `${source}/`;
    const entries = [...this.files.entries()].filter(([path]) => path.startsWith(sourcePrefix));
    if (entries.length === 0) throw new Error(`Fake path not found: ${source}`);
    if (options.recursive !== true) throw new Error("COPY_RECURSIVE_REQUIRED");
    if (options.overwrite !== true && this.pathExists(target)) throw new Error("TARGET_EXISTS");
    for (const [path, value] of entries) {
      this.files.set(`${target}/${path.slice(sourcePrefix.length)}`, value);
    }
  }

  override async movePath(sourcePath: string, targetPath: string, options: { readonly overwrite?: boolean } = {}): Promise<void> {
    if (this.fakeOptions.readOnlyFilesystem) throw new Error("FILESYSTEM_READ_ONLY");
    await this.copyPath(sourcePath, targetPath, { ...(options.overwrite !== undefined ? { overwrite: options.overwrite } : {}), recursive: true });
    await this.deletePath(sourcePath, { recursive: true });
  }

  override async deletePath(path: string, options: { readonly recursive?: boolean } = {}): Promise<void> {
    if (this.fakeOptions.readOnlyFilesystem) throw new Error("FILESYSTEM_READ_ONLY");
    const target = normalizeVirtualPath(path);
    if (this.files.delete(target)) return;
    const targetPrefix = `${target}/`;
    const entries = [...this.files.keys()].filter((candidate) => candidate.startsWith(targetPrefix));
    if (entries.length === 0) throw new Error(`Fake path not found: ${target}`);
    if (options.recursive !== true) throw new Error("DELETE_RECURSIVE_REQUIRED");
    for (const entry of entries) this.files.delete(entry);
  }

  private pathExists(path: string): boolean {
    const normalized = normalizeVirtualPath(path);
    return this.files.has(normalized) || [...this.files.keys()].some((candidate) => candidate.startsWith(`${normalized}/`));
  }

  override async createTempDirectory(prefix: string): Promise<string> {
    const root = normalizeVirtualPath(`${this.fakeRoot}/tmp/deepseek-evaluation-runs`);
    const id = `${prefix}${this.files.size}`;
    return normalizeVirtualPath(`${root}/${id}`);
  }

  override async ensureDirectory(_path: string): Promise<void> {
    if (this.fakeOptions.readOnlyFilesystem) throw new Error("FILESYSTEM_READ_ONLY");
  }

  override async findFiles(pattern: string, root: string): Promise<readonly string[]> {
    const normalizedRoot = normalizeVirtualPath(root);
    const normalizedPattern = normalizePathForSearch(pattern);
    return [...this.files.keys()].filter((path) => path.startsWith(normalizedRoot) && normalizePathForSearch(path).includes(normalizedPattern));
  }

  override async searchText(pattern: string, root: string): Promise<readonly SearchResult[]> {
    const provider = await this.selectSearchProvider();
    const metadata = providerMetadata(provider.provider, provider.status, provider.fallbackChain, provider.diagnostics[0]?.code, provider.diagnostics);
    const normalizedRoot = normalizeVirtualPath(root);
    const results: SearchResult[] = [];
    for (const [path, content] of this.files.entries()) {
      if (!path.startsWith(normalizedRoot)) continue;
      content.split(/\r?\n/).forEach((line, index) => {
        if (!line.includes(pattern)) return;
        results.push({
          path,
          line: index + 1,
          text: line,
          engine: provider.provider === "rg" || provider.provider === "grep" || provider.provider === "select-string" ? provider.provider : "js",
          ...(metadata.fallbackReason ? { fallbackReason: metadata.fallbackReason } : {}),
          metadata
        });
      });
    }
    return results;
  }

  override async runProcess(command: string, args: readonly string[], options: ProcessRunOptions = {}, observer?: ProcessRunObserver, control?: ProcessRunControl): Promise<ProcessResult> {
    const processProvider = await this.resolveProcessProvider();
    if (!processProvider.available) {
      return {
        exitCode: 126,
        stdout: "",
        stderr: processProvider.diagnostics[0]?.message ?? "Process execution is unavailable.",
        metadata: providerMetadata("none", "unavailable", [], processProvider.diagnostics[0]?.code, processProvider.diagnostics)
      };
    }
    const stdout = JSON.stringify({
      command,
      args,
      executionProfile: options.executionProfile ?? "default",
      stdin: options.stdin ?? (options.executionProfile === "noninteractive" ? "ignore" : "pipe"),
      aborted: control?.signal?.aborted === true
    });
    observer?.onStdoutChunk?.(stdout);
    observer?.onProcessExit?.();
    return {
      exitCode: 0,
      stdout,
      stderr: "",
      metadata: providerMetadata("argv", "available", [], undefined, options.executionProfile === "noninteractive" ? [diagnostic("PROCESS_NONINTERACTIVE_PROFILE", "info", "Fake process observed noninteractive profile.")] : [])
    };
  }
}

function processSpawnInvocation(os: PlatformOsFamily, command: string, args: readonly string[], executionProfile: "default" | "noninteractive" = "default"): { readonly command: string; readonly args: readonly string[] } {
  if (executionProfile === "noninteractive" && isGitCommand(command) && !args.includes("--no-pager")) {
    return { command, args: ["--no-pager", ...args] };
  }
  if (os === "windows" && /\.(?:cmd|bat)$/i.test(command)) {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", command, ...args] };
  }
  return { command, args };
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    child.kill(signal);
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to killing the direct child when the process group is already gone.
    }
  }
  child.kill(signal);
}

export function createPlatformRuntime(os: PlatformOsFamily): PlatformRuntime {
  return os === "fake" ? new FakePlatformRuntime("fake") : new NodePlatformRuntime(os);
}

function sandboxCapabilities(input: {
  readonly filesystemReadOnly: boolean;
  readonly shell: ShellProviderDescriptor;
  readonly processProvider: ProcessProviderDescriptor;
  readonly secureStorage: SecureStorageCapability;
  readonly nativeCapabilities: readonly NativeCapabilityProbe[];
  readonly networkStatus: PlatformProviderResultMetadata["status"];
  readonly degradedReasons: readonly string[];
}): SandboxCapabilityMatrix {
  const nativeStatuses = Object.fromEntries(input.nativeCapabilities.map((capability) => [capability.capability, capability.status]));
  const networkUnavailable = input.networkStatus === "unavailable";
  const degradedReasons = [
    ...input.degradedReasons,
    ...(input.filesystemReadOnly ? ["FILESYSTEM_READ_ONLY"] : []),
    ...(networkUnavailable ? ["NETWORK_UNAVAILABLE"] : []),
    ...input.nativeCapabilities.filter((capability) => capability.status === "unavailable").map((capability) => `NATIVE_${capability.capability.toUpperCase().replace(/-/g, "_")}_UNAVAILABLE`)
  ];
  return {
    schemaVersion: SECRET_SANDBOX_SCHEMA_VERSION,
    filesystem: {
      read: true,
      write: !input.filesystemReadOnly,
      readOnly: input.filesystemReadOnly,
      traversalPolicy: "workspace-root",
      rollback: !input.filesystemReadOnly
    },
    processExecution: {
      execute: input.processProvider.available,
      providerStatus: input.processProvider.status
    },
    shell: {
      execute: input.shell.available,
      profile: input.shell.profile,
      providerStatus: input.shell.status
    },
    network: {
      access: !networkUnavailable,
      providerStatus: input.networkStatus,
      hostScopes: []
    },
    environment: { access: "scoped" },
    native: {
      access: input.nativeCapabilities.some((capability) => capability.status !== "unavailable"),
      providerStatuses: nativeStatuses
    },
    secureStorage: {
      status: input.secureStorage.status,
      scopedReferences: input.secureStorage.scopedReferences
    },
    degraded: degradedReasons.length > 0 || input.networkStatus === "degraded",
    degradedReasons: [...new Set(degradedReasons)].sort(),
    redaction: { class: "internal", fields: ["native.providerStatuses", "degradedReasons"] }
  };
}

function workspacePathApi(os: PlatformOsFamily): typeof posix | typeof win32 {
  return os === "windows" ? win32 : posix;
}

function isPathInside(root: string, target: string, caseSensitive = true, pathApi: typeof posix | typeof win32 = workspacePathApi(process.platform === "win32" ? "windows" : "linux")): boolean {
  const normalizedRoot = stripTrailingPathSeparator(pathApi.normalize(root), pathApi.sep);
  const normalizedTarget = stripTrailingPathSeparator(pathApi.normalize(target), pathApi.sep);
  const comparableRoot = caseSensitive ? normalizedRoot : normalizedRoot.toLowerCase();
  const comparableTarget = caseSensitive ? normalizedTarget : normalizedTarget.toLowerCase();
  return comparableTarget === comparableRoot || comparableTarget.startsWith(pathChildPrefix(comparableRoot, pathApi.sep));
}

function relativePathInside(root: string, target: string, caseSensitive: boolean, pathApi: typeof posix | typeof win32): string {
  const normalizedRoot = stripTrailingPathSeparator(pathApi.normalize(root), pathApi.sep);
  const normalizedTarget = stripTrailingPathSeparator(pathApi.normalize(target), pathApi.sep);
  if (caseSensitive) return pathApi.relative(normalizedRoot, normalizedTarget);
  const canonical = realFilesystemRelativePathInside(normalizedRoot, normalizedTarget, pathApi);
  if (canonical !== undefined) return canonical;
  const comparableRoot = normalizedRoot.toLowerCase();
  const comparableTarget = normalizedTarget.toLowerCase();
  if (comparableTarget === comparableRoot) return "";
  const targetPrefix = pathChildPrefix(comparableRoot, pathApi.sep);
  if (comparableTarget.startsWith(targetPrefix)) {
    return comparableTarget.slice(targetPrefix.length);
  }
  return pathApi.relative(comparableRoot, comparableTarget);
}

function realFilesystemRelativePathInside(root: string, target: string, pathApi: typeof posix | typeof win32): string | undefined {
  const relative = pathApi.relative(root, target);
  if (!relative || relative.startsWith("..")) return relative === "" ? "" : undefined;
  const segments = relative.split(/[\\/]+/).filter(Boolean);
  const canonical: string[] = [];
  let current = root;
  for (const segment of segments) {
    const entries = safeReadDirNames(current);
    if (!entries) return undefined;
    const entry = entries.find((name) => name.toLowerCase() === segment.toLowerCase());
    if (!entry) return undefined;
    canonical.push(entry);
    current = pathApi.join(current, entry);
  }
  return canonical.join(pathApi.sep);
}

function safeReadDirNames(path: string): readonly string[] | undefined {
  try {
    return readdirSync(path, { withFileTypes: true }).map((entry) => entry.name);
  } catch {
    return undefined;
  }
}

function pathChildPrefix(path: string, separator: string): string {
  return path.endsWith(separator) ? path : `${path}${separator}`;
}

function stripTrailingPathSeparator(path: string, separator: string): string {
  if (path === separator) return path;
  if (/^[a-zA-Z]:\\$/.test(path)) return path;
  return path.endsWith(separator) ? path.slice(0, -separator.length) : path;
}

function isVirtualAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:\//.test(path.replace(/\\/g, "/"));
}

function normalizeVirtualPath(path: string): string {
  const slashPath = path.replace(/\\/g, "/");
  const driveMatch = /^([a-zA-Z]:)(\/.*)?$/.exec(slashPath);
  const prefix = driveMatch ? driveMatch[1] ?? "" : slashPath.startsWith("/") ? "/" : "";
  const body = driveMatch ? driveMatch[2] ?? "/" : prefix === "/" ? slashPath.slice(1) : slashPath;
  const segments: string[] = [];
  for (const segment of body.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (driveMatch) return `${prefix}/${segments.join("/")}`.replace(/\/$/, "");
  if (prefix === "/") return `/${segments.join("/")}`.replace(/\/$/, "") || "/";
  return segments.join("/");
}

function normalizePathForSearch(path: string): string {
  return path.replace(/\\/g, "/");
}

function isVirtualPathInside(root: string, target: string, caseSensitive = true): boolean {
  const comparableRoot = caseSensitive ? root : root.toLowerCase();
  const comparableTarget = caseSensitive ? target : target.toLowerCase();
  return comparableTarget === comparableRoot || comparableTarget.startsWith(`${comparableRoot}/`);
}

function virtualRelativePathInside(root: string, target: string, caseSensitive = true): string {
  const comparableRoot = caseSensitive ? root : root.toLowerCase();
  const comparableTarget = caseSensitive ? target : target.toLowerCase();
  if (comparableTarget === comparableRoot) return "";
  return comparableTarget.slice(comparableRoot.length).replace(/^\//, "");
}

async function walk(root: string, files: string[]): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(path, files);
    } else {
      files.push(path);
    }
  }
}

function detectEnvironmentKind(): PlatformEnvironmentKind {
  if (process.env.DEEPSEEK_REMOTE_RUNTIME === "1") return "remote";
  if (process.env.CI === "true" || process.env.CI === "1") return "ci";
  if (process.platform === "linux" && (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)) return "wsl";
  return "local";
}

function defaultShellProfile(os: PlatformOsFamily): ShellProfile {
  if (os === "windows") return "powershell";
  if (os === "fake") return "none";
  return "bash";
}

function unavailableShell(profile: ShellProfile, code: string, message: string): ShellProviderDescriptor {
  return {
    profile,
    provider: "none",
    available: false,
    status: "unavailable",
    args: [],
    requiresShellSyntax: profile !== "none",
    diagnostics: [diagnostic(code, "warn", message)],
    redaction: { class: "public" }
  };
}

function searchFallbackChain(os: PlatformOsFamily): readonly PlatformProviderName[] {
  if (os === "windows") return ["rg", "select-string", "js"];
  if (os === "fake") return ["js"];
  return ["rg", "grep", "js"];
}

function filesystemSemantics(os: PlatformOsFamily) {
  return {
    caseSensitive: os === "linux" || os === "fake",
    pathSeparator: os === "windows" ? "\\" as const : "/" as const,
    homeExpansionAllowed: false,
    driveLetters: os === "windows",
    symlinkAware: true
  };
}

function providerMetadata(
  selectedProvider: PlatformProviderName,
  status: PlatformProviderResultMetadata["status"],
  fallbackChain: readonly PlatformProviderName[],
  fallbackReason: string | undefined,
  diagnostics: readonly PlatformDiagnostic[],
  timeoutMs?: number
): PlatformProviderResultMetadata {
  return {
    selectedProvider,
    status,
    fallbackChain,
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    degradedReasons: diagnostics.filter((entry) => entry.severity !== "info").map((entry) => entry.code),
    diagnostics,
    redaction: { class: "internal" }
  };
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function noninteractiveProcessEnv(): Record<string, string> {
  return {
    CI: "1",
    TERM: "dumb",
    NO_COLOR: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_TERMINAL_PROMPT: "0",
    EDITOR: "true",
    VISUAL: "true",
    LESS: "-FRX",
    SSH_ASKPASS: "",
    GCM_INTERACTIVE: "Never",
    npm_config_yes: "true",
    npm_config_color: "false"
  };
}

function isGitCommand(command: string): boolean {
  return /(?:^|[/\\])git(?:\.exe)?$/i.test(command);
}

function appendBoundedOutput(current: string, chunk: string, limitBytes: number | undefined): { readonly text: string; readonly truncated: boolean } {
  if (!limitBytes) return { text: current + chunk, truncated: false };
  const currentBytes = Buffer.byteLength(current, "utf8");
  if (currentBytes >= limitBytes) return { text: current, truncated: true };
  const remaining = limitBytes - currentBytes;
  if (Buffer.byteLength(chunk, "utf8") <= remaining) return { text: current + chunk, truncated: false };
  return { text: current + truncateUtf8(chunk, remaining), truncated: true };
}

function truncateUtf8(text: string, limitBytes: number): string {
  const chunks: string[] = [];
  let bytes = 0;
  for (const character of text) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > limitBytes) break;
    chunks.push(character);
    bytes += nextBytes;
  }
  return chunks.join("");
}

function diagnostic(code: string, severity: PlatformDiagnostic["severity"], message: string, details: JsonObject = {}): PlatformDiagnostic {
  return {
    code,
    severity,
    message,
    suggestedActions: [],
    redaction: { class: "internal", fields: ["details"] },
    details
  };
}

function platformError(code: string, message: string, details: JsonObject = {}): RedactedError {
  return {
    code,
    message,
    retryable: false,
    redaction: { class: "internal", fields: ["details"] },
    details
  };
}

function hasAmbiguousDriveRelativePath(path: string): boolean {
  return /^[a-zA-Z]:[^/\\]/.test(path);
}

function isUnsupportedWorkspacePathSyntax(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, "/");
  return (
    path.startsWith("~") ||
    path.includes("\0") ||
    hasAmbiguousDriveRelativePath(path) ||
    path.startsWith("\\\\") ||
    normalizedPath.startsWith("//") ||
    hasTrailingDotOrSpaceSegment(normalizedPath) ||
    /[*?\[\]{}]/.test(path) ||
    /(^|[^\\])[$`]/.test(path)
  );
}

function hasTrailingDotOrSpaceSegment(path: string): boolean {
  return path
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .some((segment) => /[. ]$/.test(segment));
}

function wslToWindowsPath(path: string): string {
  const match = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(path);
  if (!match) return normalize(path);
  return normalize(`${match[1]?.toUpperCase()}:/${match[2] ?? ""}`);
}

export * from "./placeholders/agent-plugin.js";
export * from "./placeholders/agent-extension.js";
export * from "./placeholders/agent-evolution.js";
export * from "./placeholders/agent-remote.js";
export * from "./placeholders/agent-distribution.js";
export { NodeBackgroundTaskManager } from "./background-tasks.js";
