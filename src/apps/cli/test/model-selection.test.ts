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

  it("widens GLM budgets for user-realistic SWE-bench prompts", () => {
    const prompt = "给我完成 SWE-bench Lite 第 1 题测试，跑通并告诉我结果。";
    const profile = resolveCliModelProfile({
      modelProvider: "glm",
      model: "glm-5.1",
      prompt
    });

    assert.equal(profile.providerOptions?.max_tokens, 8192);
    assert.deepEqual(resolveCliAgentLoopLimits(prompt), {
      maxModelIterations: 48,
      maxToolCalls: 96,
      toolTimeoutMs: 180_000,
      maxOutputBytes: 96_000
    });
  });
});
