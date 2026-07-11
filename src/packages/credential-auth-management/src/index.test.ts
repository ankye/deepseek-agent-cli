import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakePlatformRuntime } from "@deepseek/platform-abstraction";
import {
  deepSeekLiveCredentialResolution,
  glmAnthropicLiveCredentialResolution,
  liveCredentialLaunchCwdEnvKey
} from "./index.js";

describe("credential auth management", () => {
  it("resolves disposable workspace credentials from launch cwd env files with redacted source metadata", async () => {
    const platform = new FakePlatformRuntime("fake", "/workspace");
    await platform.writeFile("/launch/.env", [
      "DEEPSEEK_API_KEY=fixture-deepseek-secret",
      "GLM_ANTHROPIC_API_KEY=fixture-glm-secret"
    ].join("\n"));

    const deepseek = await deepSeekLiveCredentialResolution(platform, "/tmp/disposable", {
      [liveCredentialLaunchCwdEnvKey]: "/launch"
    });
    const glm = await glmAnthropicLiveCredentialResolution(platform, "/tmp/disposable", {
      [liveCredentialLaunchCwdEnvKey]: "/launch"
    });

    assert.equal(deepseek.env.DEEPSEEK_API_KEY, "fixture-deepseek-secret");
    assert.equal(deepseek.summary.available, true);
    assert.equal(deepseek.summary.sourceClass, "launch-workspace-env-file");
    assert.equal(deepseek.summary.provider, "deepseek");
    assert.equal(JSON.stringify(deepseek.summary).includes("fixture-deepseek-secret"), false);
    assert.deepEqual(deepseek.summary.redaction.fields, ["env"]);

    assert.equal(glm.env.GLM_ANTHROPIC_API_KEY, "fixture-glm-secret");
    assert.equal(glm.summary.available, true);
    assert.equal(glm.summary.sourceClass, "launch-workspace-env-file");
    assert.equal(glm.summary.provider, "glm");
    assert.equal(JSON.stringify(glm.summary).includes("fixture-glm-secret"), false);
  });
});
