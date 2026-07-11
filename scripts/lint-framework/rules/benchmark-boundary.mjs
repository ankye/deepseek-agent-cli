import { createRule } from "../rule.mjs";

const DEFAULT_FORBIDDEN_TOKENS = [
  "SWE_BENCH",
  "SweBench",
  "sweBench",
  "SweLite",
  "sweLite",
  "SWE-bench",
  "swe-bench",
  "swe-lite",
  "swebench",
  "SWE bench",
  "SWE-bench",
  "core.swe.bench.run",
  "swe.bench.run"
];

const INSTANCE_ID_PATTERN = /\b[a-z][a-z0-9_]*__[a-z][a-z0-9_]*-\d+\b/i;

function benchmarkBoundaryPolicy(context) {
  return context.conventions.benchmarkBoundary ?? {};
}

function forbiddenTokens(context) {
  return benchmarkBoundaryPolicy(context).forbiddenTokens ?? DEFAULT_FORBIDDEN_TOKENS;
}

function forbiddenWorkspaceNames(context) {
  return benchmarkBoundaryPolicy(context).forbiddenWorkspaceNames ?? new Set([
    "runtime",
    "platform-contracts",
    "prompt-assembly",
    "core-coding-tools",
    "task-profiles"
  ]);
}

function allowedPathFragments(context) {
  return benchmarkBoundaryPolicy(context).allowedPathFragments ?? [
    "/src/apps/cli/src/diagnostics/swe-bench-",
    "/src/apps/cli/src/host/swe-bench-run-capabilities",
    "/src/apps/cli/test/",
    "/src/apps/cli/src/diagnostics/"
  ];
}

function isForbiddenSharedSource(context) {
  if (context.isTestFile()) return false;
  return forbiddenWorkspaceNames(context).has(context.workspaceName());
}

function isAllowedHostAdapterPath(context) {
  const file = context.normalizedFile();
  return allowedPathFragments(context).some((fragment) => file.includes(fragment));
}

function lineAndColumnFor(source, offset) {
  const prefix = source.slice(0, offset);
  const lines = prefix.split(/\r?\n/);
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1
  };
}

function findForbiddenBenchmarkToken(source, context) {
  let first;
  for (const token of forbiddenTokens(context)) {
    const index = source.indexOf(token);
    if (index < 0) continue;
    if (!first || index < first.index) first = { token, index };
  }
  const instanceMatch = INSTANCE_ID_PATTERN.exec(source);
  if (instanceMatch?.index !== undefined && (!first || instanceMatch.index < first.index)) {
    first = { token: instanceMatch[0], index: instanceMatch.index };
  }
  return first;
}

export const noSharedBenchmarkHardcode = createRule({
  id: "benchmark/no-shared-runtime-hardcode",
  description: "Benchmark-specific behavior must stay out of shared runtime/platform packages and enter through host adapters or dynamic profile data.",
  onFile(context) {
    if (!isForbiddenSharedSource(context)) return;
    if (isAllowedHostAdapterPath(context)) return;
    const match = findForbiddenBenchmarkToken(context.sourceFile.text, context);
    if (!match) return;
    const location = lineAndColumnFor(context.sourceFile.text, match.index);
    context.reportAt(
      this.id,
      `benchmark-specific token ${JSON.stringify(match.token)} is forbidden in shared ${context.workspaceName()} source; move benchmark facts to host evaluation adapters or dynamic/external profile data`,
      location.line,
      location.column
    );
  }
});
