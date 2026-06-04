import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CredentialAuthModelCredentialProvider,
  DeepSeekCredentialAuthService,
  InMemoryCredentialStorageAdapter,
  createDeepSeekCredentialAuthServiceFromEnv,
  deepSeekLiveCredentialProcessEnv,
  glmAnthropicLiveCredentialProcessEnv
} from "@deepseek/credential-auth-management";
import { asId } from "@deepseek/platform-contracts";
import type { ConfigDocument, ModelLiveVerificationResult, ReadinessLiveCheckInput } from "@deepseek/platform-contracts";

const fakeSecret = "sk-live-secret-value";

describe("persistent config and auth contracts", () => {
  it("serializes config documents without raw credential fields", () => {
    const document: ConfigDocument = {
      schemaVersion: "1.0.0",
      profile: "default",
      values: { model: "deepseek-v4-flash", credentialRef: asId<"credentialRef">("credential-deepseek-api-key") },
      source: { scope: "workspace", priority: 2, path: "/repo/.deepseek/config.json" },
      redaction: { class: "internal", fields: ["values.*secret*"] },
      migration: { schemaVersion: "1.0.0" }
    };

    assert.equal(JSON.stringify(document).includes(fakeSecret), false);
    assert.equal(document.values.credentialRef, "credential-deepseek-api-key");
  });

  it("stores credential references while keeping raw secret out of reference JSON", async () => {
    const service = new DeepSeekCredentialAuthService(new InMemoryCredentialStorageAdapter());
    const stored = await service.storeDeepSeekCredential({ value: fakeSecret, source: "test" });

    assert.equal(stored.ok, true);
    assert.equal(stored.value?.available, true);
    assert.equal(JSON.stringify(stored).includes(fakeSecret), false);
  });

  it("hydrates live credentials from a workspace env file without exposing the raw token in references", async () => {
    const env = await deepSeekLiveCredentialProcessEnv({
      readFile: async () => `DEEPSEEK_TOKEN=${fakeSecret}\n`
    }, "/workspace", {});
    const service = await createDeepSeekCredentialAuthServiceFromEnv(env);
    const request = {} as Parameters<CredentialAuthModelCredentialProvider["resolve"]>[1];
    const credential = await new CredentialAuthModelCredentialProvider(service).resolve(asId<"credentialRef">("credential-deepseek-api-key"), request);
    const references = await service.listDeepSeekCredentials();

    assert.equal(credential?.value, fakeSecret);
    assert.equal(references.length, 1);
    assert.equal(JSON.stringify(references).includes(fakeSecret), false);
  });

  it("hydrates GLM Anthropic credentials from process env before workspace env files", async () => {
    const env = await glmAnthropicLiveCredentialProcessEnv({
      readFile: async () => `GLM_ANTHROPIC_API_KEY=file-secret\nZHIPU_API_KEY=file-zhipu\n`
    }, "/workspace", { GLM_ANTHROPIC_API_KEY: fakeSecret });

    assert.equal(env.GLM_ANTHROPIC_API_KEY, fakeSecret);
    assert.equal(env.ZHIPU_API_KEY, "file-zhipu");
    assert.equal(JSON.stringify({ ...env, GLM_ANTHROPIC_API_KEY: "present" }).includes(fakeSecret), false);
  });

  it("hydrates GLM Anthropic credentials from launch cwd when an isolated task cwd has no env file", async () => {
    const env = await glmAnthropicLiveCredentialProcessEnv({
      readFile: async (path: string) => {
        if (path === "/launch/.env") return "GLM_ANTHROPIC_API_KEY=fixture-glm-launch-secret\n";
        throw new Error(`unexpected env file path: ${path}`);
      }
    }, "/isolated-task", { DEEPSEEK_CLI_LAUNCH_CWD: "/launch" });

    assert.equal(env.GLM_ANTHROPIC_API_KEY, "fixture-glm-launch-secret");
    assert.equal(JSON.stringify({ ...env, GLM_ANTHROPIC_API_KEY: "present" }).includes("fixture-glm-launch-secret"), false);
  });

  it("defines readiness live-check and live verification result shapes", () => {
    const input: ReadinessLiveCheckInput = { enabled: true, timeoutMs: 1000 };
    const result: ModelLiveVerificationResult = {
      ok: true,
      provider: { provider: "deepseek", protocol: "openai-chat-completions", model: "deepseek-v4-flash" },
      reachable: true,
      terminalStatus: "completed",
      eventKinds: ["delta", "finish", "done"],
      diagnostics: [],
      redaction: { class: "internal" }
    };

    assert.equal(input.enabled, true);
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes(fakeSecret), false);
  });
});
