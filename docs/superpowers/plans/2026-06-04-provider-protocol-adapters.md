# Provider Protocol Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split model-gateway provider implementations into vendor/protocol adapter modules while keeping package-root exports and runtime event contracts stable.

**Architecture:** `@deepseek/model-gateway` remains the public boundary. Internal adapters move under `src/providers/{vendor}/{protocol}`, with shared helpers only for provider-neutral or protocol-level mechanics.

**Tech Stack:** TypeScript ESM, Node test runner, OpenSpec, existing model-gateway contracts from `@deepseek/platform-contracts`.

---

### Task 1: Adapter Layout Contract

**Files:**
- Create: `src/packages/model-gateway/test/provider-adapter-layout.test.ts`
- Modify: `openspec/changes/split-model-provider-protocol-adapters/tasks.md`

- [x] Add a failing test that imports package-root exports and checks `providers/deepseek/openai`, `providers/deepseek/anthropic`, and `providers/glm/anthropic` entry files exist.
- [x] Run `npx tsx --test src/packages/model-gateway/test/provider-adapter-layout.test.ts`; expect failure before adapter files exist.
- [x] Create adapter module entry files and keep package-root exports stable.
- [x] Run the layout test again; expect pass.

### Task 2: Shared Model Gateway Utilities

**Files:**
- Create: `src/packages/model-gateway/src/shared/types.ts`
- Create: `src/packages/model-gateway/src/shared/json.ts`
- Create: `src/packages/model-gateway/src/shared/events.ts`
- Create: `src/packages/model-gateway/src/shared/transports.ts`
- Create: `src/packages/model-gateway/src/shared/tool-calls.ts`
- Modify: `src/packages/model-gateway/src/index.ts`

- [x] Move shared types and provider-neutral helpers from `index.ts` into focused shared files.
- [x] Keep package-root exports unchanged.
- [x] Run `npx tsx --test src/packages/model-gateway/test/deepseek-provider.test.ts src/packages/model-gateway/test/deepseek-partial-tool-calls.test.ts`.

### Task 3: GLM Anthropic Adapter

**Files:**
- Create: `src/packages/model-gateway/src/providers/glm/anthropic/config.ts`
- Create: `src/packages/model-gateway/src/providers/glm/anthropic/request.ts`
- Create: `src/packages/model-gateway/src/providers/glm/anthropic/normalizer.ts`
- Create: `src/packages/model-gateway/src/providers/glm/anthropic/provider.ts`
- Create: `src/packages/model-gateway/src/providers/glm/anthropic/index.ts`
- Modify: `src/packages/model-gateway/src/index.ts`

- [x] Move GLM config, profile, request builder, normalizer, provider class, and credential ref into the GLM Anthropic adapter files.
- [x] Re-export public GLM symbols from package root.
- [x] Run `npx tsx --test src/packages/model-gateway/test/deepseek-provider.test.ts tests/live/glm-anthropic-provider-live-smoke.test.ts`.

### Task 4: DeepSeek OpenAI Adapter

**Files:**
- Create: `src/packages/model-gateway/src/providers/deepseek/openai/config.ts`
- Create: `src/packages/model-gateway/src/providers/deepseek/openai/request.ts`
- Create: `src/packages/model-gateway/src/providers/deepseek/openai/normalizer.ts`
- Create: `src/packages/model-gateway/src/providers/deepseek/openai/provider.ts`
- Create: `src/packages/model-gateway/src/providers/deepseek/openai/index.ts`
- Modify: `src/packages/model-gateway/src/index.ts`

- [x] Move DeepSeek OpenAI-compatible config, profile, request builders, normalizer, provider class, metadata catalog, and DeepSeek validation helpers into DeepSeek OpenAI adapter files.
- [x] Re-export public DeepSeek symbols from package root.
- [x] Run `npx tsx --test src/packages/model-gateway/test/deepseek-provider.test.ts src/packages/model-gateway/test/deepseek-partial-tool-calls.test.ts src/packages/model-gateway/test/deepseek-reasoning-continuation.test.ts`.

### Task 5: DeepSeek Anthropic Adapter Lane

**Files:**
- Create: `src/packages/model-gateway/src/providers/deepseek/anthropic/request.ts`
- Create: `src/packages/model-gateway/src/providers/deepseek/anthropic/index.ts`
- Modify: `src/packages/model-gateway/src/providers/deepseek/openai/provider.ts`
- Modify: `src/packages/model-gateway/src/index.ts`

- [x] Move DeepSeek Anthropic-compatible request validation and request construction into the DeepSeek Anthropic adapter lane.
- [x] Keep `DeepSeekOpenAIProvider.buildAnthropicMessagesProviderRequest` as a compatibility wrapper that delegates to the lane helper.
- [x] Run `npx tsx --test src/packages/model-gateway/test/deepseek-provider.test.ts`.

### Task 6: Verification And Commit

**Files:**
- Modify: `openspec/changes/split-model-provider-protocol-adapters/tasks.md`

- [ ] Mark completed OpenSpec tasks.
- [ ] Run `npx openspec validate split-model-provider-protocol-adapters --type change --strict`.
- [ ] Run `npx openspec validate --specs --strict`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `node scripts/check-boundaries.mjs`.
- [ ] Run `npm test`.
- [ ] Run secret scan for the provided GLM key fragments and confirm no hits.
- [ ] Run `git status --short --ignored` and `git ls-files -- '参考/*'`.
- [ ] Commit and push to `develop`.
