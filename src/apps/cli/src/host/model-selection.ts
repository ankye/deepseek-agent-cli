import { defaultDeepSeekProfile, defaultGlmAnthropicProfile } from "@deepseek/model-gateway";
import type { ModelProfile } from "@deepseek/platform-contracts";
import type { CliOptions } from "../types.js";

const GLM_EXPANDED_TASK_MAX_TOKENS = 8192;

export const EXPANDED_TASK_AGENT_LOOP_LIMITS = {
  maxModelIterations: 24,
  maxToolCalls: 64,
  maxOutputBytes: 96_000
} as const;

export function resolveCliModelProfile(options: Pick<CliOptions, "modelProvider" | "model" | "prompt">, env: Readonly<Record<string, string | undefined>> = {}): ModelProfile {
  const provider = options.modelProvider ?? parseProvider(env.DEEPSEEK_MODEL_PROVIDER ?? env.MODEL_PROVIDER) ?? "deepseek";
  if (provider === "glm") {
    const envMaxTokens = positiveInteger(env.GLM_ANTHROPIC_MAX_TOKENS);
    const expandedMaxTokens = usesExpandedTaskBudget(options.prompt) ? GLM_EXPANDED_TASK_MAX_TOKENS : undefined;
    const maxTokens = envMaxTokens ?? expandedMaxTokens;
    return {
      ...defaultGlmAnthropicProfile,
      model: options.model ?? env.GLM_ANTHROPIC_MODEL ?? defaultGlmAnthropicProfile.model,
      ...(maxTokens ? {
        providerOptions: {
          ...(defaultGlmAnthropicProfile.providerOptions ?? {}),
          max_tokens: maxTokens
        }
      } : {})
    };
  }
  return {
    ...defaultDeepSeekProfile,
    model: options.model ?? env.DEEPSEEK_MODEL ?? defaultDeepSeekProfile.model
  };
}

export function resolveCliAgentLoopLimits(prompt: string): typeof EXPANDED_TASK_AGENT_LOOP_LIMITS | undefined {
  return usesExpandedTaskBudget(prompt) ? EXPANDED_TASK_AGENT_LOOP_LIMITS : undefined;
}

export function usesExpandedTaskBudget(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return (
    lower.includes("evaluation task id:") ||
    lower.includes("website") ||
    lower.includes("webpage") ||
    lower.includes("html") ||
    lower.includes("网页") ||
    lower.includes("网站") ||
    lower.includes("页面")
  );
}

function parseProvider(value: string | undefined): "deepseek" | "glm" | undefined {
  return value === "deepseek" || value === "glm" ? value : undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
