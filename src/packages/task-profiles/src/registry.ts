import type { StagedTaskProfileRecord } from "@deepseek/platform-contracts";
import { taskProfileCatalog } from "./catalog.js";

export function listTaskProfiles(): readonly StagedTaskProfileRecord[] {
  return taskProfileCatalog;
}

export function getTaskProfile(profileId: string): StagedTaskProfileRecord | undefined {
  return taskProfileCatalog.find((profile) => profile.profileId === profileId);
}
