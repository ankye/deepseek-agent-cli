import type { CliEvaluationOutcomeGate } from "@deepseek/platform-contracts";

export function evaluationOutcomeGate(input: {
  readonly commandPassed: boolean;
  readonly checksPassed: boolean;
  readonly artifactsPresent: boolean;
  readonly evidencePresent: boolean;
  readonly terminalEventPresent: boolean;
  readonly boundedCommandOutputEvidencePresent?: boolean;
  readonly adversarialProbePresent?: boolean;
}): CliEvaluationOutcomeGate {
  const reasonCodes = [
    ...(input.commandPassed ? [] : ["command-failed"]),
    ...(input.checksPassed ? [] : ["checks-failed"]),
    ...(input.artifactsPresent ? [] : ["artifacts-missing"]),
    ...(input.evidencePresent ? [] : ["evidence-missing"]),
    ...(input.terminalEventPresent ? [] : ["terminal-event-missing"]),
    ...(input.boundedCommandOutputEvidencePresent === false ? ["command-output-evidence-missing"] : []),
    ...(input.adversarialProbePresent === false ? ["adversarial-probe-missing"] : [])
  ];
  return {
    status: reasonCodes.length === 0 ? "pass" : "fail",
    commandPassed: input.commandPassed,
    checksPassed: input.checksPassed,
    artifactsPresent: input.artifactsPresent,
    evidencePresent: input.evidencePresent,
    terminalEventPresent: input.terminalEventPresent,
    ...(input.boundedCommandOutputEvidencePresent !== undefined ? { boundedCommandOutputEvidencePresent: input.boundedCommandOutputEvidencePresent } : {}),
    ...(input.adversarialProbePresent !== undefined ? { adversarialProbePresent: input.adversarialProbePresent } : {}),
    reasonCodes,
    redaction: { class: "internal" }
  };
}
