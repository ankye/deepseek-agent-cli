import { deepSeekLiveCredentialProcessEnv, glmAnthropicLiveCredentialProcessEnv } from "@deepseek/credential-auth-management";
import type { JsonObject, PlatformRuntime } from "@deepseek/platform-contracts";
import type { CliEvaluationOptions } from "./evaluation.js";

type EvaluationModelSelection = Pick<CliEvaluationOptions, "modelProvider" | "model">;

export function evaluationModelSelectionArgs(options: EvaluationModelSelection): readonly string[] {
  return [
    ...(options.modelProvider ? ["--provider", options.modelProvider] : []),
    ...(options.model ? ["--model", options.model] : [])
  ];
}

export async function evaluationLiveCredentialEnv(
  platform: PlatformRuntime,
  provider: CliEvaluationOptions["modelProvider"]
): Promise<JsonObject> {
  const env = provider === "glm"
    ? await glmAnthropicLiveCredentialProcessEnv(platform)
    : await deepSeekLiveCredentialProcessEnv(platform);

  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
  );
}
