import type { CliEvaluationOutcomeGate } from "@deepseek/platform-contracts";
import { artifactContractForTask, artifactContractMismatchReason } from "./capability-matrix-artifacts.js";
import {
  credentialResolutionAvailable,
  hasCapabilityEvidenceSignal,
  hasAgentLoopFailedSignal,
  hasAgentLoopFailureReason,
  hasCredentialMissingSignal,
  hasTerminalEventSignal,
  hasTerminalWorkflowRequiredActionMiss,
  hasVerificationSuccessSignal
} from "./capability-matrix-terminal-signals.js";
import { guidance } from "./capability-matrix-guidance.js";
import { evaluationOutcomeGate } from "./evaluation-outcome-gate.js";
import { collectDecisionQuality } from "./capability-matrix-decision-quality.js";
import type { CapabilityMatrixDecisionQuality } from "./capability-matrix-decision-quality.js";
import { profileCapabilityGate } from "./capability-matrix-profile-gate.js";
import {
  evaluateCapabilityMatrixRubric,
  mergeRubricIntoOutcomeGate
} from "./capability-matrix-rubric.js";
import type {
  CapabilityMatrixClassification,
  CapabilityMatrixGuidance,
  CapabilityMatrixTask
} from "./capability-matrix-types.js";

export function classifyCapabilityMatrixRun(
  exitCode: number,
  stdout: string,
  stderr: string,
  diff: string,
  task: Pick<CapabilityMatrixTask, "workspaceMode"> & Partial<Pick<CapabilityMatrixTask, "prompt" | "requiredFamilyIds">>
): {
  readonly classification: CapabilityMatrixClassification;
  readonly reason: string;
  readonly guidance: CapabilityMatrixGuidance;
  readonly outcomeGate: CliEvaluationOutcomeGate;
  readonly decisionQuality: CapabilityMatrixDecisionQuality;
} {
  const combined = `${stdout}\n${stderr}`;
  const baseOutcomeGate = capabilityMatrixOutcomeGate(exitCode, combined, diff, task);
  const rubric = evaluateCapabilityMatrixRubric(task, diff, combined);
  const outcomeGate = mergeRubricIntoOutcomeGate(baseOutcomeGate, rubric);
  const artifactContract = artifactContractForTask(task, diff);
  const decisionQuality = collectDecisionQuality(combined);
  if (hasCredentialMissingSignal(combined)) {
    if (credentialResolutionAvailable(combined)) {
      return {
        classification: "blocked-by-cli-bug",
        reason: "Provider reported missing credentials even though credential resolution evidence shows an approved fallback source was available.",
        guidance: guidance(
          "credentials",
          "Credentials resolved before provider dispatch but were not delivered to the provider transport.",
          "Inspect CLI credential plumbing between credential resolution, runtime dependency creation, and provider transport initialization.",
          "Rerun after provider readiness uses the resolved credential source without reporting credential missing.",
          ["credential resolution event", "provider transport credential binding"],
          "high"
        ),
        outcomeGate,
        decisionQuality
      };
    }
    return {
      classification: "invalid-test-environment",
      reason: "CLI execution could not start or continue because credentials/authentication were missing.",
      guidance: guidance(
        "credentials",
        "No approved credential source was available to the CLI process.",
        "Check provider credential resolution evidence and configure an approved workspace, launch-workspace, user, or global credential source without copying raw secrets into task fixtures.",
        "Rerun after credential evidence reports available=true for the requested provider.",
        ["credential source class", "provider readiness event"],
        "high"
      ),
      outcomeGate,
      decisionQuality
    };
  }
  if (isCliEntrypointUnavailable(combined)) {
    return {
      classification: "invalid-test-environment",
      reason: "Configured CLI command is unavailable in this test environment.",
      guidance: guidance(
        "test-environment",
        "The configured CLI entrypoint is unavailable from the task workspace.",
        "Build the CLI or pass a working cliCommand to the capability-matrix runner.",
        "Rerun after the CLI command starts and emits JSONL trace records.",
        ["CLI command path", "build artifact"],
        "high"
      ),
      outcomeGate,
      decisionQuality
    };
  }
  const profileGate = profileCapabilityGate(task, decisionQuality, outcomeGate);
  if (profileGate) return profileGate;
  if (hasAgentLoopFailureReason(combined, "evidence-unsupported-claim")) {
    return {
      classification: "blocked-by-model",
      reason: "Model completed artifact/tool work but final evidence-first grounding still had unsupported strict claims.",
      guidance: guidance(
        "model-behavior",
        "The model produced artifacts and tool evidence, but its final answer asserted strict factual claims that were not grounded by selected evidence.",
        "Tighten final-answer synthesis instructions and evidence citation requirements; do not weaken evidence-first gating just to accept unsupported narrative claims.",
        "Rerun after trace evidence shows unsupportedClaimCount=0 or final text omits unsupported package, command, or verification claims.",
        ["evidence:unsupported-claim", "final answer", "selected evidence"],
        "high"
      ),
      outcomeGate,
      decisionQuality
    };
  }
  if (hasAgentLoopFailureReason(combined, "model-iteration-limit")) {
    return {
      classification: "blocked-by-model",
      reason: "Model exhausted the configured model iteration limit before producing an accepted terminal success.",
      guidance: guidance(
        "model-behavior",
        "The required tools were available, but the model spent the available iterations on corrections or non-converging actions.",
        "Inspect the late trace window, tool rejection feedback, and final visible tool set; tighten the repair prompt or reduce ambiguous repair choices before increasing limits.",
        "Rerun after the trace shows the model either reaches workflow completion or fails with a narrower typed blocker before the iteration budget is exhausted.",
        ["model:iteration-limit", "late tool call sequence", "repair feedback"],
        "medium"
      ),
      outcomeGate,
      decisionQuality
    };
  }
  if (hasTerminalWorkflowRequiredActionMiss(combined)) {
    return {
      classification: "blocked-by-model",
      reason: "Model did not call the workflow-required evidence/tool action; inspect trace.jsonl for required stage and visible tool projection.",
      guidance: guidance(
        "model-behavior",
        "The required tools were available, but the model did not select the required action.",
        "Inspect visible tool schemas, profile instructions, and stage gate prompts; simplify or strengthen the required action contract before changing tools.",
        "Rerun after the prompt/profile evidence states the required action and the trace shows the tool remained visible.",
        ["tool call sequence", "stage gate prompt", "visible tool schema"],
        "medium"
      ),
      outcomeGate,
      decisionQuality
    };
  }
  if (hasPolicySandboxDenial(combined)) {
    return {
      classification: "blocked-by-cli-bug",
      reason: "CLI execution was blocked by sandbox or host policy; inspect trace.jsonl for the denied permission, sandbox profile, and requested capability.",
      guidance: guidance(
        "policy-sandbox",
        "Host policy or sandbox denied an action required by the selected workflow.",
        "Align the selected profile, tool risk class, and host policy so required actions are either allowed or reported as an explicit policy-disabled capability.",
        "Rerun after sandbox policy evidence shows the required action is allowed or intentionally disabled before model dispatch.",
        ["denied permission", "sandbox profile", "tool risk class"],
        "high"
      ),
      outcomeGate,
      decisionQuality
    };
  }
  if (/WORKFLOW_CAPABILITY_PROJECTION_EMPTY|blocked-by-cli-capability-gap|"diagnosticKind"\s*:/i.test(combined)) {
    const diagnosticKind = extractJsonString(combined, "diagnosticKind");
    const unregistered = extractCapabilityIds(combined, "unregisteredWorkflowCapabilityIds") ?? [];
    const policyHidden = extractCapabilityIds(combined, "policyHiddenCapabilityIds") ?? [];
    const missing = extractCapabilityIds(combined, "missingCapabilityIds") ?? [];
    if (diagnosticKind === "projection-bug") {
      const suffix = missing.length > 0 ? ` Affected capabilities: ${missing.join(", ")}.` : "";
      return {
        classification: "blocked-by-cli-bug",
        reason: `CLI projection bug: workflow-required capabilities were registered but no executable model-visible tool satisfied the active stage.${suffix}`,
        guidance: guidance(
          "tool-projection",
          "Registered capabilities did not compile into executable model-visible tools for the active stage.",
          "Inspect the projection compiler mapping from required family ids to visible tool ids and fix schema or stage filtering defects.",
          "Rerun after projection compiler trace shows each required family has at least one visible executable tool.",
          ["projection compiler trace", "required family ids", "visible tool ids"],
          "high"
        ),
        outcomeGate,
        decisionQuality
      };
    }
    if (diagnosticKind === "absent-implementation" || unregistered.length > 0) {
      const ids = unregistered.length > 0 ? unregistered : missing;
      const suffix = ids.length > 0 ? ` Unregistered capabilities: ${ids.join(", ")}.` : "";
      return {
        classification: "blocked-by-cli-capability-gap",
        reason: `CLI required an absent implementation for one or more workflow capabilities before model dispatch.${suffix}`,
        guidance: guidance(
          "tool-implementation",
          "The selected profile required capability families that have no registered executable implementation.",
          "Implement or register the missing general-purpose tool family, then expose it through the host registry without adding benchmark-specific behavior.",
          "Rerun after the registry reports the required capability ids as implemented and executable.",
          ["registry entry", "executor manifest", "capability family mapping"],
          "high"
        ),
        outcomeGate,
        decisionQuality
      };
    }
    if (diagnosticKind === "disabled-by-policy" || policyHidden.length > 0) {
      const ids = policyHidden.length > 0 ? policyHidden : missing;
      const suffix = ids.length > 0 ? ` Policy-hidden capabilities: ${ids.join(", ")}.` : "";
      return {
        classification: "blocked-by-cli-capability-gap",
        reason: `CLI required capabilities that were registered but disabled by tool projection policy before model dispatch.${suffix}`,
        guidance: guidance(
          "tool-policy",
          "Registered required capabilities were hidden by active tool projection or host policy.",
          "Adjust the host policy or profile projection so required Tier 1 tools are visible for write-capable stages while Tier 2 and Tier 3 remain explicit opt-in.",
          "Rerun after policy evidence lists the required capability ids as visible for the active stage.",
          ["policy decision", "hidden capability ids", "profile tool projection"],
          "high"
        ),
        outcomeGate,
        decisionQuality
      };
    }
    const suffix = missing.length > 0 ? ` Missing/unprojected capabilities: ${missing.join(", ")}.` : "";
    return {
      classification: "blocked-by-cli-capability-gap",
      reason: `CLI required general-purpose capabilities that were absent or not projected before model dispatch.${suffix}`,
      guidance: guidance(
        "tool-projection",
        "Required general-purpose capabilities were absent from the model-visible projection.",
        "Register or expose the required families through the profile capability compiler and verify the prompt assembly evidence.",
        "Rerun after required families are visible in prompt assembly evidence.",
        ["profile id", "stage id", "visible tool ids"],
        "medium"
      ),
      outcomeGate,
      decisionQuality
    };
  }
  if (exitCode !== 0) {
    return {
      classification: "blocked-by-cli-bug",
      reason: `CLI command exited with ${exitCode}; inspect trace.jsonl for routing, tool, or runtime failure evidence.`,
      guidance: guidance(
        "unknown",
        "The CLI process failed without a more specific classifier match.",
        "Inspect terminal events, routing records, tool errors, and provider responses to add a narrower classifier or fix the failing subsystem.",
        "Rerun after trace.jsonl contains a typed terminal event for the failure boundary.",
        ["typed terminal event", "runtime error boundary"],
        "medium"
      ),
      outcomeGate,
      decisionQuality
    };
  }
  if (task.workspaceMode === "disposable-write" && diff.trim().length === 0) {
    return {
      classification: "blocked-by-model",
      reason: "CLI finished without modifying the disposable write workspace.",
      guidance: guidance(
        "prompt-profile",
        "The run ended without the required workspace mutation evidence.",
        "Inspect whether the selected profile decomposed the task into edit and verification stages and whether the model called write-capable tools.",
        "Rerun after trace evidence shows an edit/patch/write tool call or a typed blocker explaining why mutation was impossible.",
        ["edit tool call", "diff.patch", "task decomposition evidence"],
        "medium"
      ),
      outcomeGate,
      decisionQuality
    };
  }
  if (artifactContract.missingPaths.length > 0) {
    return {
      classification: "partial",
      reason: artifactContractMismatchReason(artifactContract),
      guidance: guidance(
        "model-behavior",
        "The model wrote or reported artifacts that did not match the exact path literals requested by the task.",
        "Keep the CLI supervisor in evaluate-only mode; strengthen the generic artifact contract so model-visible instructions require preserving path strings exactly and repair when artifact checks report path mismatches.",
        "Rerun after the trace shows the model creating the exact requested artifact paths and the artifact contract has no missing paths.",
        artifactContract.missingPaths.map((path) => `artifact:${path}`),
        "high"
      ),
      outcomeGate,
      decisionQuality
    };
  }
  if (outcomeGate.status === "pass" && rubric.status === "pass") {
    return {
      classification: "pass",
      reason: rubric.reason,
      guidance: guidance(
        "evaluation-supervisor",
        "The automated outcome gate and task-specific rubric both passed.",
        "Use this run as capability evidence; rerun only when changing tool projection, workflow gating, profile assembly, or the task rubric.",
        "Rerun after behavior-affecting changes to the CLI or rubric.",
        [],
        "high"
      ),
      outcomeGate,
      decisionQuality
    };
  }
  const outcomeEvidenceGaps = outcomeGate.reasonCodes.map((code) => `outcome:${code}`);
  const fixableRubricGaps = rubric.status === "fail" ? rubric.evidenceGaps : [];
  return {
    classification: "partial",
    reason: outcomeGate.status === "pass"
      ? "CLI produced diff/evidence/check/terminal signals, but semantic success still requires task-specific rubric review."
      : rubric.status === "fail"
        ? rubric.reason
        : `CLI produced evidence, but semantic success is not proven by the outcome gate. Missing: ${outcomeGate.reasonCodes.join(", ") || "none"}.`,
    guidance: guidance(
      "task-design",
      outcomeGate.status === "pass"
        ? "The automated outcome gate found required execution evidence; residual review should focus on task-specific semantic correctness."
        : "The CLI produced some evidence, but automated scoring has not proven semantic task completion.",
      outcomeGate.status === "pass"
        ? "Review the diff and task-specific rubric for semantic correctness before using this as a capability pass example."
        : fixableRubricGaps.length > 0
          ? continuationGuidanceForRubricGaps(fixableRubricGaps)
          : "Compare diff, artifacts, test output, and terminal events against the task success criteria before marking pass or changing architecture.",
      outcomeGate.status === "pass"
        ? "Rerun when changing prompt/profile/tool projection behavior or when adding stricter task-specific rubric checks."
        : "Rerun only after adding the missing outcome evidence or a rubric check that can decide pass versus residual blocker.",
      rubric.status === "fail" ? rubric.evidenceGaps : outcomeEvidenceGaps.length > 0 ? outcomeEvidenceGaps : ["semantic rubric review"],
      "medium"
    ),
    outcomeGate,
    decisionQuality
  };
}

function continuationGuidanceForRubricGaps(gaps: readonly string[]): string {
  const toolHint = gaps.some((gap) => gap.includes("T08"))
    ? "Use visible artifact mutation tools such as core.file.write, core.file.edit, or core.text.replace, then verify with core.test.run or core.git.diff."
    : gaps.some((gap) => gap.includes("T04"))
      ? "Use visible read/search tools such as core.file.read, core.search.text, core.workspace.glob, or core.git.diff to collect the missing routing/rendering evidence."
      : gaps.some((gap) => gap.includes("T06"))
        ? "Use visible file mutation tools to repair the root command contract, then verify with core.test.run or core.shell.run."
        : "Use visible governed tools to produce the missing semantic evidence, then verify before reporting.";
  return [
    `Continue the model run with task-specific rubric feedback: ${gaps.join(", ")}.`,
    toolHint,
    "Do not treat this as supervisor help or a benchmark answer; it is a semantic evidence gap that the CLI can feed back before final acceptance."
  ].join(" ");
}

function capabilityMatrixOutcomeGate(
  exitCode: number,
  combined: string,
  diff: string,
  task: Pick<CapabilityMatrixTask, "workspaceMode"> & Partial<Pick<CapabilityMatrixTask, "prompt">>
): CliEvaluationOutcomeGate {
  const artifactContract = artifactContractForTask(task, diff);
  const agentLoopFailed = hasAgentLoopFailedSignal(combined);
  return evaluationOutcomeGate({
    commandPassed: exitCode === 0,
    checksPassed: !agentLoopFailed && (isReadOnlyWorkspaceMode(task.workspaceMode) || hasVerificationSuccessSignal(combined)),
    artifactsPresent: task.workspaceMode !== "disposable-write"
      || (diff.trim().length > 0 && artifactContract.missingPaths.length === 0),
    evidencePresent: hasCapabilityEvidenceSignal(combined),
    terminalEventPresent: hasTerminalEventSignal(combined),
    boundedCommandOutputEvidencePresent: combined.trim().length > 0,
    adversarialProbePresent: isReadOnlyWorkspaceMode(task.workspaceMode) ? hasTerminalEventSignal(combined) : hasVerificationSuccessSignal(combined)
  });
}

function isReadOnlyWorkspaceMode(workspaceMode: CapabilityMatrixTask["workspaceMode"]): boolean {
  return workspaceMode === "project-read-only" || workspaceMode === "disposable-read-only";
}

function extractJsonString(text: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`).exec(text);
  return match?.[1];
}

function extractCapabilityIds(text: string, field: string): readonly string[] | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`"${escaped}"\\s*:\\s*\\[([^\\]]*)\\]`).exec(text);
  const body = match?.[1];
  if (!body) return undefined;
  return [...body.matchAll(/"([^"]+)"/g)]
    .map((item) => item[1])
    .filter((item): item is string => typeof item === "string" && item.length > 0);
}

function isCliEntrypointUnavailable(text: string): boolean {
  if (/agent\.loop\.started/i.test(text)) return false;
  if (/ENOENT.*(?:dist\/index|src\/apps\/cli\/(?:src\/)?index|deepseek-agent-cli)/i.test(text)) return true;
  if (!/MODULE_NOT_FOUND|Cannot find module/i.test(text)) return false;
  if (/prompt\.assembled|capability\.(?:completed|failed)|core\.shell\.run/i.test(text)) return false;
  return /(?:dist\/index|src\/apps\/cli\/(?:src\/)?index|deepseek-agent-cli)/i.test(text);
}

function hasPolicySandboxDenial(text: string): boolean {
  if (/WORKFLOW_REQUIRED_ACTION_MISSED/i.test(text) && /workflow-stages-completed/i.test(text)) return false;
  return /KERNEL_POLICY_DENIED|sandbox blocked|permission denied|operation not permitted|approval\.denied|approval\.required|Runtime approval required/i.test(text)
    || /"kind"\s*:\s*"policy\.decided"[\s\S]*"action"\s*:\s*"(deny|ask)"/i.test(text)
    || /"policy"\s*:\s*\{[\s\S]*"action"\s*:\s*"(deny|ask)"/i.test(text);
}
