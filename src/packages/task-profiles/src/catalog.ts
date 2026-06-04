import type { StagedTaskProfileRecord } from "@deepseek/platform-contracts";
import { webpageGenerationProfile } from "./profiles/evaluation/webpage-generation.v1.js";

export const taskProfileCatalog: readonly StagedTaskProfileRecord[] = [
  webpageGenerationProfile
];
