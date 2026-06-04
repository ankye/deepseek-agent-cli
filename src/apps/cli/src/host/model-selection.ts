import { defaultDeepSeekProfile, defaultGlmAnthropicProfile } from "@deepseek/model-gateway";
import type { ModelProfile } from "@deepseek/platform-contracts";
import type { CliOptions } from "../types.js";

export function resolveCliModelProfile(options: Pick<CliOptions, "modelProvider" | "model">, env: Readonly<Record<string, string | undefined>> = {}): ModelProfile {
  const provider = options.modelProvider ?? parseProvider(env.DEEPSEEK_MODEL_PROVIDER ?? env.MODEL_PROVIDER) ?? "deepseek";
  if (provider === "glm") {
    return {
      ...defaultGlmAnthropicProfile,
      model: options.model ?? env.GLM_ANTHROPIC_MODEL ?? defaultGlmAnthropicProfile.model
    };
  }
  return {
    ...defaultDeepSeekProfile,
    model: options.model ?? env.DEEPSEEK_MODEL ?? defaultDeepSeekProfile.model
  };
}

function parseProvider(value: string | undefined): "deepseek" | "glm" | undefined {
  return value === "deepseek" || value === "glm" ? value : undefined;
}
