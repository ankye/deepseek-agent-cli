import type {
  ModelMetadataCatalogEntry,
  ModelProfile,
  ModelProviderConfig
} from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";

const deepSeekProviderId = asId<"modelProvider">("provider-deepseek");
export const deepSeekOpenAICredentialRef = asId<"credentialRef">("credential-deepseek-api-key");

export const deepSeekOpenAIProviderConfig: ModelProviderConfig = {
  providerId: deepSeekProviderId,
  provider: "deepseek",
  protocol: "openai-chat-completions",
  baseUrl: "https://api.deepseek.com",
  credentialRef: deepSeekOpenAICredentialRef
};

export const defaultDeepSeekProfile: ModelProfile = {
  id: asId<"modelProfile">("model-deepseek-default"),
  providerId: deepSeekProviderId,
  model: "deepseek-v4-flash",
  temperature: 0
};

export const pinnedDeepSeekModelMetadataCatalog: readonly ModelMetadataCatalogEntry[] = [
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    source: "pinned",
    fetchedAt: "2026-05-17T00:00:00.000Z"
  }
];
