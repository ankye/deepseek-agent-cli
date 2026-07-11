export function hasVerificationSuccessSignal(text: string): boolean {
  return /"capabilityId"\s*:\s*"(core\.test\.run|core\.shell\.run)"/i.test(text)
    && /"exitCode"\s*:\s*0/i.test(text);
}

export function hasCapabilityEvidenceSignal(text: string): boolean {
  return /"kind"\s*:\s*"(prompt\.assembled|capability\.completed|model\.tool\.intent|agent\.loop\.(?:completed|failed|cancelled))"/i.test(text)
    || /prompt\.assembled|capability\.completed|agent\.loop\.(?:completed|failed|cancelled)/i.test(text);
}

export function credentialResolutionAvailable(text: string): boolean {
  return /"name"\s*:\s*"credential\.resolution"/.test(text)
    && /"available"\s*:\s*true/.test(text)
    && /"sourceClass"\s*:\s*"(process-env|workspace-env-file|launch-workspace-env-file)"/.test(text);
}

export function hasCredentialMissingSignal(text: string): boolean {
  return /PROVIDER_CREDENTIAL_MISSING|CREDENTIAL_MISSING|credential is missing|provider credential is missing|API[_ -]?KEY.*missing|authentication failed|unauthorized/i.test(text);
}

export function hasTerminalEventSignal(text: string): boolean {
  return /"kind"\s*:\s*"agent\.loop\.(?:completed|failed|cancelled)"/i.test(text)
    || /Agent loop stopped with status=/i.test(text)
    || /workflow-stages-completed|workflow-required-action-missed/i.test(text);
}

export function hasAgentLoopFailedSignal(text: string): boolean {
  return /"kind"\s*:\s*"agent\.loop\.failed"/i.test(text)
    || /Agent loop stopped with status=(?:failed|rejected)/i.test(text);
}

export function hasAgentLoopFailureReason(text: string, reason: string): boolean {
  return agentLoopTerminalReason(text) === reason ||
    new RegExp(`Agent loop stopped with status=(?:failed|rejected) reason=${escapeRegExp(reason)}`, "i").test(text);
}

export function hasTerminalWorkflowRequiredActionMiss(text: string): boolean {
  if (/workflow-stages-completed/i.test(text)) return false;
  const terminalReason = agentLoopTerminalReason(text);
  if (terminalReason) return terminalReason === "workflow-required-action-missed";
  return /"reason"\s*:\s*"workflow-required-action-missed"/i.test(text)
    || /Agent loop stopped with status=rejected reason=workflow-required-action-missed/i.test(text)
    || /"error"\s*:\s*\{[\s\S]*WORKFLOW_REQUIRED_ACTION_MISSED/i.test(text);
}

function agentLoopTerminalReason(text: string): string | undefined {
  return terminalAgentLoopEvent(text)?.reason;
}

function terminalAgentLoopEvent(text: string): { readonly kind: string; readonly reason?: string } | undefined {
  let parsed: { readonly kind?: unknown; readonly data?: { readonly reason?: unknown } } | undefined;
  for (const line of text.split(/\r?\n/g)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { readonly kind?: unknown; readonly data?: { readonly reason?: unknown } };
      if (typeof event.kind === "string" && /^agent\.loop\.(completed|failed|cancelled)$/i.test(event.kind)) {
        parsed = event;
      }
    } catch {
      continue;
    }
  }
  if (!parsed || typeof parsed.kind !== "string") return undefined;
  return {
    kind: parsed.kind,
    ...(typeof parsed.data?.reason === "string" ? { reason: parsed.data.reason } : {})
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
