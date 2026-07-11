import { homedir } from "node:os";
import { join } from "node:path";

export function userSessionsDirectory(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string {
  const resolvedEnv = env ?? sessionEnv();
  const resolvedPlatform = platform ?? sessionPlatform();
  if (resolvedPlatform === "win32") {
    const appData = resolvedEnv.APPDATA ?? resolvedEnv.LOCALAPPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "deepseek", "sessions");
  }
  const xdgDataHome = resolvedEnv.XDG_DATA_HOME;
  if (xdgDataHome && xdgDataHome.length > 0) return join(xdgDataHome, "deepseek", "sessions");
  return join(homedir(), ".deepseek", "sessions");
}

function sessionEnv(): NodeJS.ProcessEnv {
  const proc = globalThis as unknown as { process?: { env?: NodeJS.ProcessEnv } };
  return proc.process?.env ?? {};
}

function sessionPlatform(): NodeJS.Platform {
  const proc = globalThis as unknown as { process?: { platform?: NodeJS.Platform } };
  return proc.process?.platform ?? "linux";
}
