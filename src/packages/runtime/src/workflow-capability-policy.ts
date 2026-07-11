export const mutationCapabilityIds = new Set([
  "core.file.write",
  "core.file.edit",
  "core.text.replace",
  "core.file.copy",
  "core.file.move",
  "core.file.delete",
  "core.directory.create",
  "core.file.touch",
  "core.json.patch",
  "core.archive.create",
  "core.archive.extract",
  "core.patch.apply",
  "core.revert.undo"
]);

export function isMutationCapabilityId(capabilityId: string): boolean {
  return mutationCapabilityIds.has(capabilityId)
    || capabilityId.includes(".edit")
    || capabilityId.includes(".write")
    || capabilityId.includes(".patch")
    || capabilityId.includes("patch.apply")
    || capabilityId.includes("file-edit")
    || capabilityId.includes("file.write");
}

export function isTestCapabilityId(capabilityId: string): boolean {
  return capabilityId === "core.test.run"
    || capabilityId === "test.run"
    || capabilityId.endsWith(".test.run")
    || capabilityId.includes("test-run");
}

export function isStandardTestExecutionCapabilityId(capabilityId: string): boolean {
  return isTestCapabilityId(capabilityId) || capabilityId === "core.shell.run";
}

export function progressCapabilityIdsForWorkflowStage(
  stageKind: string | undefined,
  allowedCapabilityIds: readonly string[]
): readonly string[] {
  if (stageKind === "produce" || stageKind === "materialize" || stageKind === "repair") {
    const mutation = allowedCapabilityIds.filter(isMutationCapabilityId);
    const surgicalMutation = mutation.filter((capabilityId) => capabilityId !== "core.file.write" && !capabilityId.endsWith(".write"));
    if (surgicalMutation.length > 0) return surgicalMutation;
    return mutation.length > 0 ? mutation : allowedCapabilityIds;
  }
  if (stageKind === "verify" || stageKind === "score") {
    const tests = allowedCapabilityIds.filter(isTestCapabilityId);
    if (tests.length > 0) return tests;
    const verification = allowedCapabilityIds.filter((capabilityId) =>
      capabilityId.includes("git.diff") ||
      capabilityId.includes("score") ||
      capabilityId.includes("bench") ||
      capabilityId === "core.shell.run"
    );
    return verification.length > 0 ? verification : allowedCapabilityIds;
  }
  return allowedCapabilityIds;
}
