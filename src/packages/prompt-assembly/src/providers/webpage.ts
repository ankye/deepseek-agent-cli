import { PROMPT_ASSEMBLY_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import type { PromptSectionProviderRegistration } from "../assembler.js";
import { createPromptSection } from "../sections.js";
import { isCapabilityVisibleForProjection } from "../tool-projection.js";

export function createTaskOutputContractProvider(): PromptSectionProviderRegistration {
  return {
    id: "core.task-output-contract",
    version: "1.0.0",
    kind: "task.output-contract",
    source: "runtime",
    priority: 800,
    budgetClass: "high",
    trust: "system",
    required: false,
    compatibility: { schemaVersion: PROMPT_ASSEMBLY_SCHEMA_VERSION },
    provide(input) {
      if (input.outputContract) return explicitOutputContractSections(input);
      if (input.mode !== "webpage-generation") return fileMutationContractSections(input);
      const outputDir = requestedWebpageDirectory(input.prompt);
      return [createPromptSection({
        id: "section.webpage-output-contract",
        providerId: "core.task-output-contract",
        kind: "task.output-contract",
        source: "runtime",
        role: "system",
        content: [
          "Task output contract:",
          `- Create the local ${outputDir} directory for this webpage task.`,
          "- Include an HTML entry file, styling, and JavaScript interaction when appropriate.",
          `- Include ${outputDir}/index.html, ${outputDir}/styles.css, ${outputDir}/app.js, and ${outputDir}/evidence.json.`,
          "- Avoid remote CDN or remote script dependencies unless explicitly requested.",
          "- If enough evidence is already present in selected local project evidence, do not keep browsing; write the files."
        ].join("\n"),
        priority: 800,
        budgetClass: "high",
        trust: "system",
        required: false,
        provenance: { mode: input.mode }
      })];
    }
  };
}

function explicitOutputContractSections(input: Parameters<PromptSectionProviderRegistration["provide"]>[0]) {
  const contract = input.outputContract;
  if (!contract) return [];
  return [createPromptSection({
    id: "section.explicit-output-contract",
    providerId: "core.task-output-contract",
    kind: "task.output-contract",
    source: "runtime",
    role: "system",
    content: [
      "Task output contract:",
      `- Kind: ${contract.kind}.`,
      `- Required: ${contract.required ? "yes" : "no"}.`,
      contract.description ? `- Description: ${contract.description}.` : undefined,
      contract.path ? `- Required path: ${contract.path}.` : undefined,
      contract.kind === "json-object" ? "- Final answer must be a parseable JSON object and should not include surrounding prose." : undefined,
      contract.kind === "command-plan" ? "- Final answer must be a parseable JSON object with a commands array of shell command strings and a done boolean. Do not include surrounding prose." : undefined,
      contract.kind === "json-file" ? "- Write a parseable JSON object to the required path." : undefined,
      contract.kind === "file" ? "- Create or update the required path on disk." : undefined,
      contract.schema ? `- JSON schema: ${JSON.stringify(contract.schema)}` : undefined,
      ...(contract.verificationExpectations?.length
        ? [
            "- Verification expectations:",
            ...contract.verificationExpectations.map((expectation) => `  - ${expectation.kind} (${expectation.required ? "required" : "optional"}): ${expectation.description}${expectation.path ? `; path=${expectation.path}` : ""}${expectation.command ? "; command=<redacted>" : ""}`)
          ]
        : []),
      "- The runtime verifier will check this contract after the final response. If verification fails, repair the artifact or final answer instead of claiming completion."
    ].filter((line): line is string => typeof line === "string").join("\n"),
    priority: 900,
    budgetClass: "required",
    trust: "system",
    required: contract.required,
    provenance: {
      contractKind: contract.kind,
      ...(contract.path ? { path: contract.path } : {}),
      hasSchema: contract.schema !== undefined,
      expectationCount: contract.verificationExpectations?.length ?? 0
    }
  })];
}

function fileMutationContractSections(input: Parameters<PromptSectionProviderRegistration["provide"]>[0]) {
  if (!fileMutationRequested(input.prompt)) return [];
  const requestedPaths = requestedPathLiterals(input.prompt);
  const readyMutationTools = readyMutationProgressTools(input);
  const visibleToolNames = input.availableTools
    .filter((tool) => tool.enabled !== false && isCapabilityVisibleForProjection(tool, input.toolPolicy))
    .map((tool) => safeToolName(String(tool.id)));
  const preferredTools = ["core_file_read", "core_file_write", "core_file_edit", "core_test_run", "core_shell_run"]
    .filter((toolName) => visibleToolNames.includes(toolName));
  return [createPromptSection({
    id: "section.file-mutation-output-contract",
    providerId: "core.task-output-contract",
    kind: "task.output-contract",
    source: "runtime",
    role: "system",
    content: [
      "File mutation output contract:",
      "- This task is only complete after the requested workspace files are changed on disk; a text-only answer is incomplete.",
      readyMutationTools.length > 0
        ? `- Current ready stage requires mutation progress: ${joinAsChoices(readyMutationTools)}.`
        : "- Inspect the relevant files first, then use governed file write/edit tools to update them.",
      ...(readyMutationTools.length > 0 ? ["- Do not continue with read/search/list-only inspection unless a mutation tool is blocked."] : []),
      "- Preserve any requested path literals exactly, including case.",
      ...(requestedPaths.length > 0 ? [`- Requested path literals: ${requestedPaths.join(", ")}.`] : []),
      ...(preferredTools.length > 0 ? [`- Prefer exact visible tool names for this flow: ${preferredTools.join(", ")}.`] : []),
      "- Remove placeholder markers such as TODO or TBD when the task asks to replace them.",
      "- Run the local checker after writing files when a checker is available. If it fails, make a bounded correction and rerun when possible."
    ].join("\n"),
    priority: 800,
    budgetClass: "high",
    trust: "system",
    required: false,
    provenance: { mode: input.mode, contract: "file-mutation" }
  })];
}

export function requestedWebpageDirectory(prompt: string): string {
  const normalized = prompt.replace(/\\/g, "/");
  const explicitAtDir = normalized.match(/@([A-Za-z0-9._/-]*(?:website|webpage|generated-webpage)[A-Za-z0-9._/-]*)/i);
  if (explicitAtDir?.[1]) return stripRelativePrefix(explicitAtDir[1]);

  const toDir = normalized.match(/(?:to|into|under|in|到|至|目录|文件夹)\s+([A-Za-z0-9._/-]*(?:website|webpage|generated-webpage)[A-Za-z0-9._/-]*)/i);
  if (toDir?.[1]) return stripRelativePrefix(toDir[1]);

  const bareDir = normalized.match(/\b((?:website|webpage|generated-webpage)(?:[A-Za-z0-9._/-]*))\b/i);
  if (bareDir?.[1]) return stripRelativePrefix(bareDir[1]);

  return "generated-webpage";
}

function stripRelativePrefix(value: string): string {
  return value.trim().replace(/^\.\/+/, "").replace(/\/+$/, "") || "generated-webpage";
}

function fileMutationRequested(prompt: string): boolean {
  if (/不要(?:修改|写入|编辑|删除|创建|生成)|不应(?:修改|写入|编辑|删除|创建|生成)|不应该(?:修改|写入|编辑|删除|创建|生成)|do not (?:modify|write|edit|delete|create|generate)/i.test(prompt)) {
    return false;
  }
  return /\b(update|write|edit|create|modify|fix|repair|refactor|add|remove|delete)\b/i.test(prompt)
    || /更新|写入|编辑|修改|修复|新增|创建|删除|补齐|生成/.test(prompt);
}

function requestedPathLiterals(prompt: string): readonly string[] {
  const paths = new Set<string>();
  for (const match of prompt.matchAll(/(?:^|[\s"'`，。；：、,;:(（])((?:\.\/)?(?:(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9][A-Za-z0-9_.-]*))(?=$|[\s"'`，。；：、,;:)）])/g)) {
    const path = match[1]?.replace(/^\.\//, "");
    if (path && !path.includes("://") && !path.startsWith("../") && !path.includes("/../")) paths.add(path);
  }
  return [...paths];
}

function readyMutationProgressTools(input: Parameters<PromptSectionProviderRegistration["provide"]>[0]): readonly string[] {
  const workflow = input.profilePolicy?.stagedTaskWorkflow;
  if (!workflow) return [];
  const stagesById = new Map(workflow.graph.stages.map((stage) => [stage.stageId, stage]));
  const evidenceSucceeded = workflow.runState.stageStates.some((state) => {
    const stage = stagesById.get(state.stageId);
    return state.status === "succeeded" && stage?.kind === "collect-evidence";
  });
  if (!evidenceSucceeded) return [];
  for (const state of workflow.runState.stageStates) {
    if (state.status !== "ready") continue;
    const stage = stagesById.get(state.stageId);
    if (stage?.kind !== "produce" && stage?.kind !== "repair") continue;
    const mutationTools = (stage.allowedTools ?? []).filter(isMutationCapabilityId);
    if (mutationTools.length > 0) return mutationTools;
  }
  return [];
}

function isMutationCapabilityId(capabilityId: string): boolean {
  return capabilityId.includes(".edit")
    || capabilityId.includes(".write")
    || capabilityId.includes(".patch")
    || capabilityId.includes("patch.apply")
    || capabilityId.includes("file.write");
}

function joinAsChoices(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "mutation tool";
  return `${values.slice(0, -1).join(", ")} or ${values.at(-1)}`;
}

function safeToolName(capabilityId: string): string {
  return capabilityId.replace(/[^A-Za-z0-9_]/g, "_");
}
