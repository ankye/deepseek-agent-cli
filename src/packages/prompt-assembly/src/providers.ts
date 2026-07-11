import type { PromptSectionProviderRegistration } from "./assembler.js";
import { createContextProviders } from "./providers/context.js";
import { createEvidenceFirstProviders } from "./providers/evidence-first.js";
import { createModeProviders } from "./providers/mode.js";
import { createProjectInstructionsProvider } from "./providers/project.js";
import { createSelfRepairProviders } from "./providers/self-repair.js";
import { createSchedulingNextActionProvider } from "./providers/scheduling-next-action.js";
import { createSharedBoardContractProvider } from "./providers/shared-board-contract.js";
import { createTaskDecisionProvider } from "./providers/task-decision.js";
import { createToolDecisionBoardProvider } from "./providers/tool-decision-board.js";
import { createToolPolicyProvider } from "./providers/tool-policy.js";
import { createUserPromptProvider } from "./providers/user.js";
import { createTaskOutputContractProvider } from "./providers/webpage.js";

export function defaultPromptSectionProviders(): readonly PromptSectionProviderRegistration[] {
  return [
    createUserPromptProvider(),
    createProjectInstructionsProvider(),
    ...createModeProviders(),
    ...createEvidenceFirstProviders(),
    ...createSelfRepairProviders(),
    createSchedulingNextActionProvider(),
    createTaskDecisionProvider(),
    createSharedBoardContractProvider(),
    ...createContextProviders(),
    createTaskOutputContractProvider(),
    createToolDecisionBoardProvider(),
    createToolPolicyProvider()
  ];
}
