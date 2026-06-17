import type { AgentLoopToolProjection, CapabilityManifest } from "@deepseek/platform-contracts";

export function isCapabilityVisibleForProjection(
  capability: CapabilityManifest,
  policy: AgentLoopToolProjection
): boolean {
  if (policy === "none") return false;
  if (policy === "all") return true;
  if (policy === "read-write") {
    return capability.sideEffect === "none" || capability.sideEffect === "read" || capability.sideEffect === "write";
  }
  return capability.sideEffect === "none" || capability.sideEffect === "read";
}
