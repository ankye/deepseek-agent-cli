import type { CliRunOptions } from "../types.js";
import { dirname, join, resolve } from "node:path";
import type { PlatformRuntime } from "@deepseek/platform-contracts";
import { NodePlatformRuntime } from "@deepseek/platform-abstraction";

export async function resolveCliWorkspaceRoot(runOptions: Pick<CliRunOptions, "workspaceRoot"> = {}, platform: PlatformRuntime = new NodePlatformRuntime()): Promise<string> {
  return runOptions.workspaceRoot ? resolve(runOptions.workspaceRoot) : discoverWorkspaceRoot(platform, process.cwd());
}

const workspaceRootFileMarkers = ["package.json", "AGENTS.md", "CLAUDE.md"] as const;

async function discoverWorkspaceRoot(platform: PlatformRuntime, startDir: string): Promise<string> {
  let current = resolve(startDir);
  while (true) {
    if (await hasWorkspaceRootMarker(platform, current)) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

async function hasWorkspaceRootMarker(platform: PlatformRuntime, dir: string): Promise<boolean> {
  for (const marker of workspaceRootFileMarkers) {
    try {
      await platform.readFile(join(dir, marker));
      return true;
    } catch {
      // Keep walking upward until a readable workspace marker is found.
    }
  }
  return false;
}
