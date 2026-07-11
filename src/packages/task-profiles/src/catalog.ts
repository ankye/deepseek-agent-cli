import type { StagedTaskProfileRecord } from "@deepseek/platform-contracts";
import { softwareEngineerProfile } from "./profiles/engineering/software-engineer.v1.js";
import { webpageGenerationProfile } from "./profiles/evaluation/webpage-generation.v1.js";

export const taskProfileCatalog: readonly StagedTaskProfileRecord[] = [
  webpageGenerationProfile,
  softwareEngineerProfile
];
