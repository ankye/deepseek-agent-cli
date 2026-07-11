import type { AgentLoopToolProjection, CapabilityManifest } from "@deepseek/platform-contracts";

export function isCapabilityVisibleForProjection(
  capability: CapabilityManifest,
  policy: AgentLoopToolProjection,
  toolOptIns: readonly string[] = []
): boolean {
  if (policy === "none") return false;
  if (requiresExplicitHostOptIn(capability) && !isExplicitlyOptedIn(capability, toolOptIns)) return false;
  if (policy === "safe-all" || policy === "all") return true;
  if (policy === "read-write") {
    return capability.sideEffect === "none"
      || capability.sideEffect === "read"
      || capability.sideEffect === "write"
      || isGovernedProcessCapability(capability);
  }
  return capability.sideEffect === "none" || capability.sideEffect === "read";
}

export function isExplicitlyOptedIn(capability: CapabilityManifest, toolOptIns: readonly string[]): boolean {
  const optIns = new Set(toolOptIns.map((item) => item.toLowerCase()));
  const permissions = capability.permissions.map((permission) => permission.toLowerCase());
  if (optIns.has("network") && (capability.sideEffect === "network" || permissions.some((permission) => permission.includes("network")))) return true;
  if (optIns.has("browser") && permissions.some((permission) => permission.includes("browser"))) return true;
  if (optIns.has("connector") && permissions.some((permission) => permission.includes("connector") || permission.includes("mcp"))) return true;
  if (optIns.has("mcp") && permissions.some((permission) => permission.includes("mcp") || permission.includes("connector"))) return true;
  if (optIns.has("media") && permissions.some((permission) => permission.includes("media"))) return true;
  if (optIns.has("design") && permissions.some((permission) => permission.includes("design"))) return true;
  if (optIns.has("remote") && permissions.some((permission) => permission.includes("remote"))) return true;
  return false;
}

export function isWorkspaceProcessCapability(capability: CapabilityManifest): boolean {
  return capability.sideEffect === "process" && capability.permissions.includes("process:run");
}

export function isGovernedTestProcessCapability(capability: CapabilityManifest): boolean {
  return capability.sideEffect === "process" && capability.permissions.includes("process:test");
}

export function isGovernedProcessCapability(capability: CapabilityManifest): boolean {
  if (capability.sideEffect !== "process") return false;
  const permissions = capability.permissions.map((permission) => permission.toLowerCase());
  return permissions.includes("process:test")
    || permissions.some((permission) => permission.startsWith("evaluation:"))
    || permissions.includes("environment:prepare");
}

export function requiresExplicitHostOptIn(capability: CapabilityManifest): boolean {
  if (capability.sideEffect === "network") return true;
  const permissions = capability.permissions.map((permission) => permission.toLowerCase());
  return permissions.some((permission) =>
    permission.includes("network")
    || permission.includes("browser")
    || permission.includes("connector")
    || permission.includes("mcp")
    || permission.includes("media")
    || permission.includes("design")
    || permission.includes("remote")
  );
}
