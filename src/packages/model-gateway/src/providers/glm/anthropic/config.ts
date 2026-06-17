import type { ModelProfile, ModelProviderConfig } from "@deepseek/platform-contracts";
import { asId } from "@deepseek/platform-contracts";

const glmAnthropicProviderId = asId<"modelProvider">("provider-glm-anthropic");
export const glmAnthropicCredentialRef = asId<"credentialRef">("credential-glm-anthropic-api-key");

export const glmAnthropicProviderConfig: ModelProviderConfig = {
  providerId: glmAnthropicProviderId,
  provider: "glm",
  protocol: "anthropic-messages",
  baseUrl: "https://open.bigmodel.cn/api/anthropic",
  credentialRef: glmAnthropicCredentialRef,
  cacheHints: {
    explicitPrefixCacheHints: true,
    supportedPolicies: ["stable", "ephemeral"],
    maxCacheHintBlocks: 4
  }
};

export const defaultGlmAnthropicProfile: ModelProfile = {
  id: asId<"modelProfile">("model-glm-anthropic-default"),
  providerId: glmAnthropicProviderId,
  model: "glm-5.1",
  temperature: 0
};
