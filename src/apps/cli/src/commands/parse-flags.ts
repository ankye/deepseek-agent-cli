export function parsePositiveNumberFlag(args: readonly string[], name: string): number | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function parseNumberFlag(args: readonly string[], name: string): number | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) ? value : undefined;
}

export function readFlagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return typeof value === "string" && !value.startsWith("-") ? value : undefined;
}

export function readRepeatedFlagValues(args: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (typeof value === "string") values.push(value);
  }
  return values;
}

export function promptFromArgs(args: readonly string[]): string {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (
      value === "--output" ||
      value === "--timeout-ms" ||
      value === "--workspace-root" ||
      value === "--tool-projection" ||
      value === "--tool-opt-in" ||
      value === "--approval-mode" ||
      value === "--supervisor-workflow-state" ||
      value === "--additional-user-context-file" ||
      value === "--tui" ||
      value === "--thinking" ||
      value === "--reasoning-effort" ||
      value === "--provider" ||
      value === "--model-provider" ||
      value === "--model" ||
      value === "--output-contract" ||
      value === "--output-contract-path" ||
      value === "--output-schema" ||
      value === "--output-schema-file" ||
      value === "--output-contract-description"
    ) {
      index += 1;
      continue;
    }
    if (value === "--palette") continue;
    if (value === "--live") continue;
    if (value === "--no-tools") continue;
    if (value === "--trusted") continue;
    if (value === "--output-contract-optional") continue;
    filtered.push(value);
  }
  return filtered.join(" ").trim();
}
