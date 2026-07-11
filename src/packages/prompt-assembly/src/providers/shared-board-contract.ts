import { PROMPT_ASSEMBLY_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import type { PromptSectionProviderRegistration } from "../assembler.js";
import { createPromptSection } from "../sections.js";

export function createSharedBoardContractProvider(): PromptSectionProviderRegistration {
  return {
    id: "core.shared-board-contract",
    version: "1.0.0",
    kind: "system.mode",
    source: "runtime",
    priority: 989,
    budgetClass: "required",
    trust: "system",
    required: false,
    compatibility: { schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION },
    provide(input) {
      if (!input.toolDecisionBoard) return [];
      return [createPromptSection({
        id: "section.shared-board-contract",
        providerId: "core.shared-board-contract",
        kind: "system.mode",
        source: "runtime",
        role: "system",
        content: [
          "Shared board cache contract:",
          "- stable-prefix partition: board schema, parent-child sharing rules, record classes, and cache partition boundaries.",
          "- dynamic-tail partition: board ids, current iteration, stage status, recent records, recommendations, counters, lineage, and failure-analysis evidence.",
          "- Parent and child agents share the board storage contract, while each agent keeps its own conversation context.",
          "- Cache rule: stable board contract can be cached; runtime board contents must stay outside the provider prefix."
        ].join("\n"),
        priority: 989,
        budgetClass: "required",
        trust: "system",
        required: false,
        provenance: {
          contractId: "shared-board-cache-contract.v1",
          stablePartition: "schema-and-sharing-rules",
          dynamicPartition: "runtime-records-and-stage-state"
        }
      })];
    }
  };
}
