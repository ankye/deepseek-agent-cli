import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCliAgentLoopLimits, resolveCliModelProfile } from "../src/host/model-selection.js";

describe("cli model selection", () => {
  it("uses a larger GLM Anthropic output budget for expanded webpage tasks", () => {
    const profile = resolveCliModelProfile({
      modelProvider: "glm",
      model: "glm-5.1",
      prompt: "Evaluation task id: eval.webpage.generation\nCreate a responsive webpage."
    });

    assert.equal(profile.providerOptions?.max_tokens, 8192);
  });

  it("does not add GLM provider token overrides for simple prompts", () => {
    const profile = resolveCliModelProfile({
      modelProvider: "glm",
      model: "glm-5.1",
      prompt: "Reply with ok."
    });

    assert.equal(profile.providerOptions, undefined);
  });

  it("widens one-shot agent loop limits for expanded webpage tasks", () => {
    assert.deepEqual(resolveCliAgentLoopLimits("Create a polished product webpage."), {
      maxModelIterations: 24,
      maxToolCalls: 64,
      maxOutputBytes: 96_000
    });
  });
});
