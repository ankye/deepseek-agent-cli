import type { StagedTaskProfileRecord } from "@deepseek/platform-contracts";
import { taskProfileCatalog } from "./catalog.js";

const PROFILE_ALIASES: Readonly<Record<string, string>> = {
  "software-engineer": "engineering/software-engineer.v1"
};

export function listTaskProfiles(): readonly StagedTaskProfileRecord[] {
  return taskProfileCatalog;
}

export function getTaskProfile(profileId: string): StagedTaskProfileRecord | undefined {
  const canonicalProfileId = PROFILE_ALIASES[profileId] ?? profileId;
  return taskProfileCatalog.find((profile) => profile.profileId === canonicalProfileId);
}
