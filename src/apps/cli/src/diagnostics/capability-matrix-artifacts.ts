import type { CapabilityMatrixTask } from "./capability-matrix-types.js";

export interface CapabilityMatrixArtifactContract {
  readonly expectedPaths: readonly string[];
  readonly actualPaths: readonly string[];
  readonly missingPaths: readonly string[];
  readonly caseMismatchedPaths: readonly string[];
}

export function artifactContractMismatchReason(contract: CapabilityMatrixArtifactContract): string {
  const actualSuffix = contract.caseMismatchedPaths.length > 0
    ? ` Case-mismatched artifacts were present: ${contract.caseMismatchedPaths.join(", ")}.`
    : contract.actualPaths.length > 0
      ? ` Actual artifacts: ${contract.actualPaths.join(", ")}.`
      : "";
  return `CLI produced artifact evidence, but requested exact artifact paths are missing: ${contract.missingPaths.join(", ")}.${actualSuffix}`;
}

export function artifactContractForTask(
  task: Pick<CapabilityMatrixTask, "workspaceMode"> & Partial<Pick<CapabilityMatrixTask, "prompt">>,
  diff: string
): CapabilityMatrixArtifactContract {
  if (task.workspaceMode !== "disposable-write") {
    return { expectedPaths: [], actualPaths: [], missingPaths: [], caseMismatchedPaths: [] };
  }
  const expectedPaths = extractPathLiterals(task.prompt ?? "");
  if (expectedPaths.length === 0) {
    return { expectedPaths, actualPaths: [], missingPaths: [], caseMismatchedPaths: [] };
  }
  const actualPaths = extractDiffArtifactPaths(diff);
  const actualSet = new Set(actualPaths);
  const actualByLower = new Map(actualPaths.map((path) => [path.toLowerCase(), path]));
  const missingPaths = expectedPaths.filter((path) => !actualSet.has(path));
  const caseMismatchedPaths = missingPaths
    .map((path) => actualByLower.get(path.toLowerCase()))
    .filter((path): path is string => typeof path === "string");
  return { expectedPaths, actualPaths, missingPaths, caseMismatchedPaths };
}

function extractPathLiterals(text: string): readonly string[] {
  const paths = new Set<string>();
  for (const match of text.matchAll(/(?:^|[\s"'`，。；：、,;:(（])((?:\.\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)(?=$|[\s"'`，。；：、,;:)）])/g)) {
    const path = match[1]?.replace(/^\.\//, "");
    if (path && !path.includes("://") && isArtifactPathLiteral(path)) paths.add(path);
  }
  return [...paths];
}

function isArtifactPathLiteral(path: string): boolean {
  if (path.startsWith("../")) return false;
  const parts = path.split("/");
  const last = parts.at(-1) ?? "";
  if (/\.[A-Za-z0-9]{1,12}$/.test(last)) return true;
  const first = parts[0]?.toLowerCase() ?? "";
  return [
    "src",
    "test",
    "tests",
    "docs",
    "examples",
    "fixtures",
    "public",
    "assets",
    "scripts",
    "packages",
    "apps"
  ].includes(first);
}

function extractDiffArtifactPaths(diff: string): readonly string[] {
  const paths = new Set<string>();
  let inUntracked = false;
  for (const rawLine of diff.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (line === "# Untracked files") {
      inUntracked = true;
      continue;
    }
    const diffMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diffMatch) {
      inUntracked = false;
      const left = diffMatch[1];
      const right = diffMatch[2];
      if (left) paths.add(left);
      if (right) paths.add(right);
      continue;
    }
    if (inUntracked && line.length > 0 && !line.startsWith("#")) paths.add(line);
  }
  return [...paths];
}
