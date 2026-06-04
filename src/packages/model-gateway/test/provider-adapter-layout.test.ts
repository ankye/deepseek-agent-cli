import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeepSeekOpenAIProvider,
  GlmAnthropicProvider,
  defaultDeepSeekProfile,
  defaultGlmAnthropicProfile,
  deepSeekOpenAIProviderConfig,
  glmAnthropicProviderConfig
} from "../src/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("model-gateway provider adapter layout", () => {
  it("keeps public package-root provider exports stable", () => {
    assert.equal(typeof DeepSeekOpenAIProvider, "function");
    assert.equal(typeof GlmAnthropicProvider, "function");
    assert.equal(defaultDeepSeekProfile.providerId, deepSeekOpenAIProviderConfig.providerId);
    assert.equal(defaultGlmAnthropicProfile.providerId, glmAnthropicProviderConfig.providerId);
  });

  it("separates provider adapters by vendor and wire protocol", () => {
    const adapterEntries = [
      "src/providers/deepseek/openai/index.ts",
      "src/providers/deepseek/anthropic/index.ts",
      "src/providers/glm/anthropic/index.ts"
    ];

    for (const adapterEntry of adapterEntries) {
      assert.equal(existsSync(resolve(packageRoot, adapterEntry)), true, `${adapterEntry} should exist`);
    }
  });

  it("keeps adapter implementation files inside their vendor/protocol unit", () => {
    const implementationFiles = [
      "src/providers/deepseek/openai/config.ts",
      "src/providers/deepseek/openai/request.ts",
      "src/providers/deepseek/openai/normalizer.ts",
      "src/providers/deepseek/openai/provider.ts",
      "src/providers/deepseek/anthropic/request.ts",
      "src/providers/glm/anthropic/config.ts",
      "src/providers/glm/anthropic/request.ts",
      "src/providers/glm/anthropic/normalizer.ts",
      "src/providers/glm/anthropic/provider.ts"
    ];

    for (const implementationFile of implementationFiles) {
      assert.equal(existsSync(resolve(packageRoot, implementationFile)), true, `${implementationFile} should exist`);
    }
  });

  it("keeps DeepSeek OpenAI adapter implementation independent from the package root", () => {
    const adapterFiles = [
      "src/providers/deepseek/openai/config.ts",
      "src/providers/deepseek/openai/request.ts",
      "src/providers/deepseek/openai/normalizer.ts",
      "src/providers/deepseek/openai/provider.ts"
    ];

    for (const adapterFile of adapterFiles) {
      const source = readFileSync(resolve(packageRoot, adapterFile), "utf8");
      assert.equal(source.includes("../../../index.js"), false, `${adapterFile} must not re-export from package root`);
    }
  });

  it("keeps the package root from owning DeepSeek OpenAI provider implementation", () => {
    const source = readFileSync(resolve(packageRoot, "src/index.ts"), "utf8");
    assert.equal(source.includes("export class DeepSeekOpenAIProvider"), false);
  });
});
