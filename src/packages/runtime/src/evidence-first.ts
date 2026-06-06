import type {
  EvidenceFactClass,
  EvidenceFirstRuntimeContext,
  EvidenceFirstSummary,
  EvidenceCandidateExclusion,
  EvidenceCandidateExclusionReason,
  EvidenceItem,
  EvidencePlan,
  ClaimGrounding,
  EvidenceSourceCoverage,
  EvidenceSourceGroup,
  EvidenceSourceRequirement,
  UnsupportedClaimDiagnostic,
  EvidenceTaskClassification,
  EvidenceTaskIntent,
  JsonObject,
  RuntimeDependencies,
  SessionId,
  TraceContext,
  TurnId
} from "@deepseek/platform-contracts";
import { EVIDENCE_FIRST_COMPATIBILITY, EVIDENCE_FIRST_SCHEMA_VERSION } from "@deepseek/platform-contracts";
import type { AgentLoopRequest } from "@deepseek/platform-contracts";
import { stableHash } from "./trace.js";

const CURRENT_WORKTREE_FRESHNESS = "local-current-worktree";
const BOUNDED_PREVIEW_REDACTION = "bounded-previews-and-fingerprints";
const MAX_EVIDENCE_ITEMS = 8;
const MAX_PREVIEW_CHARS = 1200;

interface CandidateEvidenceSource {
  readonly sourceGroup: EvidenceSourceGroup;
  readonly sourcePath: string;
  readonly sourceLabel: string;
  readonly factClasses: readonly EvidenceFactClass[];
}

const candidateSources: readonly CandidateEvidenceSource[] = [
  {
    sourceGroup: "readme",
    sourcePath: "README.md",
    sourceLabel: "Repository README",
    factClasses: ["docs", "product-copy", "command", "package", "architecture"]
  },
  {
    sourceGroup: "package-metadata",
    sourcePath: "src/apps/cli/package.json",
    sourceLabel: "CLI package metadata",
    factClasses: ["package", "executable", "install", "release"]
  },
  {
    sourceGroup: "product-docs",
    sourcePath: "src/apps/cli/README.md",
    sourceLabel: "CLI README",
    factClasses: ["docs", "feature", "command", "product-copy"]
  },
  {
    sourceGroup: "command-index",
    sourcePath: "docs/reference/command-index.md",
    sourceLabel: "Command index",
    factClasses: ["command", "executable", "docs"]
  },
  {
    sourceGroup: "product-docs",
    sourcePath: "docs/product/product-roadmap.md",
    sourceLabel: "Product roadmap",
    factClasses: ["roadmap", "product-copy", "feature"]
  },
  {
    sourceGroup: "openspec",
    sourcePath: "openspec/changes/evidence-first-agent-workflow/design.md",
    sourceLabel: "Evidence-first OpenSpec design",
    factClasses: ["architecture", "product-copy", "docs"]
  },
  {
    sourceGroup: "openspec",
    sourcePath: "openspec/changes/evidence-first-agent-workflow/specs/evidence-first-agent-workflow/spec.md",
    sourceLabel: "Evidence-first OpenSpec spec",
    factClasses: ["architecture", "docs", "product-copy"]
  },
  {
    sourceGroup: "source",
    sourcePath: "src/apps/cli/src/commands/parse.ts",
    sourceLabel: "CLI command parser",
    factClasses: ["command", "code", "executable"]
  },
  {
    sourceGroup: "source",
    sourcePath: "src/apps/cli/src/types.ts",
    sourceLabel: "CLI command contracts",
    factClasses: ["command", "code"]
  },
  {
    sourceGroup: "tests",
    sourcePath: "src/apps/cli/test/cli.test.ts",
    sourceLabel: "CLI behavior tests",
    factClasses: ["command", "evaluation", "code"]
  }
];

export async function createEvidenceFirstRuntimeContext(
  deps: Pick<RuntimeDependencies, "platform">,
  request: AgentLoopRequest,
  sessionId: SessionId,
  turnId: TurnId,
  trace: TraceContext
): Promise<EvidenceFirstRuntimeContext> {
  const classification = classifyEvidenceTask(request.prompt, request.workspaceRoot, sessionId, turnId, trace);
  const plan = classification.evidenceRequired ? createEvidencePlan(classification) : undefined;
  const projection = plan ? await selectProjectEvidence(deps, request.workspaceRoot, plan, classification, sessionId, turnId, trace) : { selectedEvidence: [], excludedCandidates: [] };
  const selectedEvidence = projection.selectedEvidence;
  const excludedCandidates = projection.excludedCandidates;
  const sourceCoverage = plan ? summarizeSourceCoverage(plan, selectedEvidence) : [];
  const summary = summarizeEvidenceFirst(classification, plan, selectedEvidence, sourceCoverage, excludedCandidates);
  return {
    schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
    classification,
    ...(plan ? { plan } : {}),
    selectedEvidence,
    ...(excludedCandidates.length > 0 ? { excludedCandidates } : {}),
    sourceCoverage,
    summary,
    compatibility: EVIDENCE_FIRST_COMPATIBILITY,
    redaction: { class: "internal", fields: ["selectedEvidence.preview", "excludedCandidates.sourcePath", "classification.reason"] }
  };
}

export function classifyEvidenceTask(
  prompt: string,
  workspaceRoot: string | undefined,
  sessionId?: SessionId,
  turnId?: TurnId,
  trace?: TraceContext
): EvidenceTaskClassification {
  const lower = prompt.toLowerCase();
  const intents = new Set<EvidenceTaskIntent>();
  const factClasses = new Set<EvidenceFactClass>();
  const speculative = matchesAny(lower, ["brainstorm", "fictional", "hypothetical", "creative", "ideation", "头脑风暴", "虚构", "假设", "创意"]);
  const speculativeOnly = speculative && !matchesAny(lower, [
    "repo",
    "repository",
    "codebase",
    "workspace",
    "当前项目",
    "当前工程",
    "仓库",
    "工程",
    "项目",
    "deepseek cli",
    "package.json",
    "npx",
    "npm",
    "html",
    "webpage",
    "website",
    "网页",
    "网站",
    "页面",
    "codex",
    "claude"
  ]);

  if (speculativeOnly) {
    intents.add("speculative");
    return classificationResult(classificationInput({
      prompt,
      workspaceRoot,
      sessionId,
      turnId,
      trace,
      intents,
      factClasses,
      evidenceRequired: false,
      sensitivity: "speculative",
      reason: "Task is explicitly speculative or creative; factual project evidence is not mandatory but assumptions must stay labeled."
    }));
  }

  if (matchesAny(lower, ["repo", "repository", "codebase", "workspace", "当前项目", "当前工程", "仓库", "工程", "项目"])) {
    intents.add("repository");
    factClasses.add("docs");
  }
  if (matchesAny(lower, ["deepseek cli", "product", "产品", "cli", "工具", "产品页", "介绍"])) {
    intents.add("product");
    factClasses.add("product-copy");
    factClasses.add("feature");
    factClasses.add("package");
    factClasses.add("executable");
  }
  if (matchesAny(lower, ["command", "commands", "subcommand", "flag", "npx", "npm", "命令", "运行", "安装"])) {
    intents.add("command");
    factClasses.add("command");
    factClasses.add("install");
    factClasses.add("executable");
  }
  if (matchesAny(lower, ["package", "package.json", "npm", "包名", "发布包"])) {
    intents.add("package");
    factClasses.add("package");
  }
  if (matchesAny(lower, ["code", "src/", "test", "tests", "bug", "fix", "refactor", "代码", "测试", "修复"])) {
    intents.add("code");
    factClasses.add("code");
  }
  if (matchesAny(lower, ["doc", "docs", "readme", "openspec", "文档", "规范"])) {
    intents.add("docs");
    factClasses.add("docs");
  }
  if (matchesAny(lower, ["release", "publish", "npm publish", "上线", "发布", "可用"])) {
    intents.add("release");
    factClasses.add("release");
  }
  if (matchesAny(lower, ["evaluate", "evaluation", "benchmark", "compare", "codex", "claude", "评估", "对比", "成功率"])) {
    intents.add("evaluation");
    factClasses.add("evaluation");
  }
  if (matchesAny(lower, ["html", "webpage", "website", "site", "page", "网页", "网站", "页面"])) {
    intents.add("generated-artifact");
    factClasses.add("product-copy");
    factClasses.add("docs");
    factClasses.add("package");
    factClasses.add("command");
    factClasses.add("executable");
  }
  if (matchesAny(lower, ["architecture", "runtime", "contracts", "架构", "设计"])) {
    factClasses.add("architecture");
  }
  if (matchesAny(lower, ["roadmap", "route", "路线", "路线图"])) {
    factClasses.add("roadmap");
  }

  if (speculative && intents.size === 0) {
    intents.add("speculative");
  }

  const evidenceRequired = intents.size > 0 && !(intents.size === 1 && intents.has("speculative"));
  const sensitivity = evidenceRequired ? "fact-sensitive" : speculative ? "speculative" : "casual";
  if (factClasses.size === 0 && evidenceRequired) factClasses.add("docs");
  const reason = evidenceRequired
    ? "Task references current project, product, command, code, generated artifact, release, or evaluation facts that require local evidence."
    : speculative
      ? "Task is explicitly speculative or creative; factual project evidence is not mandatory but assumptions must stay labeled."
      : "Task does not require project evidence.";

  return classificationResult(classificationInput({ prompt, workspaceRoot, sessionId, turnId, trace, intents, factClasses, evidenceRequired, sensitivity, reason }));
}

function classificationInput(input: {
  readonly prompt: string;
  readonly workspaceRoot: string | undefined;
  readonly sessionId: SessionId | undefined;
  readonly turnId: TurnId | undefined;
  readonly trace: TraceContext | undefined;
  readonly intents: ReadonlySet<EvidenceTaskIntent>;
  readonly factClasses: ReadonlySet<EvidenceFactClass>;
  readonly evidenceRequired: boolean;
  readonly sensitivity: EvidenceTaskClassification["sensitivity"];
  readonly reason: string;
}): {
  readonly prompt: string;
  readonly workspaceRoot: string | undefined;
  readonly sessionId?: SessionId;
  readonly turnId?: TurnId;
  readonly trace?: TraceContext;
  readonly intents: ReadonlySet<EvidenceTaskIntent>;
  readonly factClasses: ReadonlySet<EvidenceFactClass>;
  readonly evidenceRequired: boolean;
  readonly sensitivity: EvidenceTaskClassification["sensitivity"];
  readonly reason: string;
} {
  return {
    prompt: input.prompt,
    workspaceRoot: input.workspaceRoot,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.trace ? { trace: input.trace } : {}),
    intents: input.intents,
    factClasses: input.factClasses,
    evidenceRequired: input.evidenceRequired,
    sensitivity: input.sensitivity,
    reason: input.reason
  };
}

function classificationResult(input: {
  readonly prompt: string;
  readonly workspaceRoot: string | undefined;
  readonly sessionId?: SessionId;
  readonly turnId?: TurnId;
  readonly trace?: TraceContext;
  readonly intents: ReadonlySet<EvidenceTaskIntent>;
  readonly factClasses: ReadonlySet<EvidenceFactClass>;
  readonly evidenceRequired: boolean;
  readonly sensitivity: EvidenceTaskClassification["sensitivity"];
  readonly reason: string;
}): EvidenceTaskClassification {
  return {
    schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
    classificationId: `evidence-classification:${stableHash(`${input.workspaceRoot ?? ""}:${input.prompt}`)}`,
    sensitivity: input.sensitivity,
    intents: input.intents.size > 0 ? sortEvidenceValues(input.intents) : ["casual"],
    factClasses: sortEvidenceValues(input.factClasses),
    evidenceRequired: input.evidenceRequired,
    reason: input.reason,
    trace: {
      ...(input.trace ? { traceId: input.trace.traceId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {})
    },
    compatibility: EVIDENCE_FIRST_COMPATIBILITY,
    redaction: { class: "internal", fields: ["reason"] }
  };
}

export function createEvidencePlan(classification: EvidenceTaskClassification): EvidencePlan {
  const requiredFactClasses: readonly EvidenceFactClass[] = classification.factClasses.length > 0 ? classification.factClasses : ["docs"];
  const sourceGroups = sourceGroupsFor(requiredFactClasses);
  return {
    schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
    planId: `evidence-plan:${stableHash(`${classification.classificationId}:${requiredFactClasses.join(",")}`)}`,
    classificationId: classification.classificationId,
    requiredFactClasses,
    candidateSourceGroups: sourceGroups.map((sourceGroup) => sourceRequirement(sourceGroup, requiredFactClasses)),
    minimumSourceCoverage: Math.min(1, sourceGroups.length <= 1 ? 1 : 0.6),
    freshnessPolicy: CURRENT_WORKTREE_FRESHNESS,
    redactionPolicy: BOUNDED_PREVIEW_REDACTION,
    stopConditions: [
      "strict command, package, executable, release, or product claims without direct evidence",
      "secret-like evidence that cannot be safely redacted",
      "missing artifact evidence manifest for generated factual product artifacts"
    ],
    trace: classification.trace,
    compatibility: EVIDENCE_FIRST_COMPATIBILITY,
    redaction: { class: "internal", fields: ["stopConditions"] }
  };
}

async function selectProjectEvidence(
  deps: Pick<RuntimeDependencies, "platform">,
  workspaceRoot: string,
  plan: EvidencePlan,
  classification: EvidenceTaskClassification,
  sessionId: SessionId,
  turnId: TurnId,
  trace: TraceContext
): Promise<{ readonly selectedEvidence: readonly EvidenceItem[]; readonly excludedCandidates: readonly EvidenceCandidateExclusion[] }> {
  const requiredGroups = new Set(plan.candidateSourceGroups.map((source) => source.sourceGroup));
  const requiredFactClasses = new Set(plan.requiredFactClasses);
  const sources = candidateSources
    .filter((source) => requiredGroups.has(source.sourceGroup) || overlaps(source.factClasses, requiredFactClasses))
    .sort((left, right) => sourcePriority(left, requiredGroups, requiredFactClasses) - sourcePriority(right, requiredGroups, requiredFactClasses))
    .slice(0, MAX_EVIDENCE_ITEMS * 2);
  const items: EvidenceItem[] = [];
  const exclusions: EvidenceCandidateExclusion[] = [];
  const selectedFingerprints = new Set<string>();
  const selectedPaths = new Set<string>();

  for (const source of sources) {
    if (items.length >= MAX_EVIDENCE_ITEMS) {
      exclusions.push(candidateExclusion(classification, source, "over-budget"));
      continue;
    }
    const resolved = deps.platform.resolveWorkspacePath(workspaceRoot, source.sourcePath);
    if (!resolved.ok || !resolved.value) {
      exclusions.push(candidateExclusion(classification, source, "out-of-scope"));
      continue;
    }
    const content = await deps.platform.readFile(resolved.value.path).catch(() => undefined);
    if (typeof content !== "string") {
      exclusions.push(candidateExclusion(classification, source, "missing"));
      continue;
    }
    if (looksStale(content)) {
      exclusions.push(candidateExclusion(classification, source, "stale"));
      continue;
    }
    if (looksSecretOnly(content)) {
      exclusions.push(candidateExclusion(classification, source, "secret-like"));
      continue;
    }
    const preview = boundedPreview(content);
    const fingerprint = `fnv1a:${stableHash(`${source.sourcePath}:${content}`)}`;
    if (selectedPaths.has(source.sourcePath) || selectedFingerprints.has(fingerprint)) {
      exclusions.push(candidateExclusion(classification, source, "duplicate", fingerprint));
      continue;
    }
    selectedPaths.add(source.sourcePath);
    selectedFingerprints.add(fingerprint);
    items.push({
      schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
      evidenceId: `evidence:${stableHash(`${classification.classificationId}:${source.sourcePath}`)}`,
      sourceGroup: source.sourceGroup,
      sourcePath: source.sourcePath,
      sourceLabel: source.sourceLabel,
      factClasses: source.factClasses.filter((factClass) => requiredFactClasses.size === 0 || requiredFactClasses.has(factClass)),
      preview,
      fingerprint,
      freshness: { status: "current", observedAt: new Date(0).toISOString() },
      trace: { traceId: trace.traceId, sessionId, turnId },
      compatibility: EVIDENCE_FIRST_COMPATIBILITY,
      redaction: { class: "internal", fields: ["preview"] }
    });
  }

  return { selectedEvidence: items, excludedCandidates: exclusions };
}

export async function explainEvidenceCandidateSelection(
  deps: Pick<RuntimeDependencies, "platform">,
  input: {
    readonly prompt: string;
    readonly workspaceRoot: string;
    readonly sessionId?: SessionId;
    readonly turnId?: TurnId;
    readonly trace?: TraceContext;
  }
): Promise<{ readonly selectedEvidence: readonly EvidenceItem[]; readonly excludedCandidates: readonly EvidenceCandidateExclusion[] }> {
  const sessionId = input.sessionId ?? ("session-evidence-explain" as SessionId);
  const turnId = input.turnId ?? ("turn-evidence-explain" as TurnId);
  const trace = input.trace ?? {
    traceId: "trace-evidence-explain" as import("@deepseek/platform-contracts").TraceId,
    spanId: "span-evidence-explain" as import("@deepseek/platform-contracts").SpanId,
    correlationId: "corr-evidence-explain" as import("@deepseek/platform-contracts").CorrelationId
  };
  const classification = classifyEvidenceTask(input.prompt, input.workspaceRoot, sessionId, turnId, trace);
  const plan = createEvidencePlan(classification);
  return selectProjectEvidence(deps, input.workspaceRoot, plan, classification, sessionId, turnId, trace);
}

function summarizeSourceCoverage(plan: EvidencePlan, items: readonly EvidenceItem[]): readonly EvidenceSourceCoverage[] {
  return plan.candidateSourceGroups.map((requirement) => {
    const matching = items.filter((item) => item.sourceGroup === requirement.sourceGroup);
    const coveredClasses = unique(matching.flatMap((item) => item.factClasses));
    const missingFactClasses = requirement.factClasses.filter((factClass) => !coveredClasses.includes(factClass));
    return {
      schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
      sourceGroup: requirement.sourceGroup,
      covered: matching.length >= requirement.minimumItemCount && missingFactClasses.length === 0,
      itemCount: matching.length,
      factClasses: coveredClasses,
      fingerprints: matching.map((item) => item.fingerprint),
      missingFactClasses,
      compatibility: EVIDENCE_FIRST_COMPATIBILITY,
      redaction: { class: "internal", fields: ["fingerprints"] }
    };
  });
}

function summarizeEvidenceFirst(
  classification: EvidenceTaskClassification,
  plan: EvidencePlan | undefined,
  items: readonly EvidenceItem[],
  coverage: readonly EvidenceSourceCoverage[],
  exclusions: readonly EvidenceCandidateExclusion[] = []
): EvidenceFirstSummary {
  const covered = coverage.filter((item) => item.covered).length;
  const sourceCoverageRate = coverage.length === 0 ? 0 : covered / coverage.length;
  return {
    schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
    summaryId: `evidence-summary:${stableHash(`${classification.classificationId}:${items.map((item) => item.fingerprint).join("|")}`)}`,
    classification,
    ...(plan ? { plan } : {}),
    manifestStatus: classification.evidenceRequired ? "missing" : "missing",
    evidenceItemCount: items.length,
    ...(exclusions.length > 0 ? { excludedCandidateCount: exclusions.length } : {}),
    sourceCoverageRate,
    claimGroundingRate: 0,
    unsupportedClaimCount: 0,
    assumptionCount: classification.sensitivity === "speculative" ? 1 : 0,
    hallucinatedCommandCount: 0,
    trace: classification.trace,
    compatibility: EVIDENCE_FIRST_COMPATIBILITY,
    redaction: { class: "internal", fields: ["classification.reason"] }
  };
}

function sourceGroupsFor(factClasses: readonly EvidenceFactClass[]): readonly EvidenceSourceGroup[] {
  const groups = new Set<EvidenceSourceGroup>(["readme"]);
  if (factClasses.some((factClass) => factClass === "package" || factClass === "executable" || factClass === "install" || factClass === "release")) {
    groups.add("package-metadata");
  }
  if (factClasses.some((factClass) => factClass === "command" || factClass === "executable" || factClass === "install")) {
    groups.add("command-index");
    groups.add("source");
  }
  if (factClasses.some((factClass) => factClass === "product-copy" || factClass === "feature" || factClass === "roadmap")) {
    groups.add("product-docs");
    groups.add("openspec");
  }
  if (factClasses.some((factClass) => factClass === "architecture" || factClass === "docs")) {
    groups.add("openspec");
  }
  if (factClasses.some((factClass) => factClass === "evaluation" || factClass === "code")) {
    groups.add("tests");
    groups.add("source");
  }
  return [...groups].sort();
}

function sourceRequirement(sourceGroup: EvidenceSourceGroup, factClasses: readonly EvidenceFactClass[]): EvidenceSourceRequirement {
  const groupClasses = unique(candidateSources.filter((source) => source.sourceGroup === sourceGroup).flatMap((source) => source.factClasses).filter((factClass) => factClasses.includes(factClass)));
  return {
    sourceGroup,
    required: sourceGroup === "readme" || sourceGroup === "package-metadata" || sourceGroup === "command-index",
    factClasses: groupClasses.length > 0 ? groupClasses : factClasses,
    minimumItemCount: 1
  };
}

function sourcePriority(source: CandidateEvidenceSource, requiredGroups: ReadonlySet<EvidenceSourceGroup>, requiredFactClasses: ReadonlySet<EvidenceFactClass>): number {
  const groupPenalty = requiredGroups.has(source.sourceGroup) ? 0 : 10;
  const missingOverlapPenalty = overlaps(source.factClasses, requiredFactClasses) ? 0 : 10;
  const stablePenalty = candidateSources.findIndex((candidate) => candidate.sourcePath === source.sourcePath);
  return groupPenalty + missingOverlapPenalty + stablePenalty;
}

function boundedPreview(content: string): string {
  const safe = content
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-REDACTED")
    .replace(/\b(DEEPSEEK_API_KEY|DEEPSEEK_TOKEN)\s*=\s*\S+/g, "$1=REDACTED")
    .trim();
  return safe.length > MAX_PREVIEW_CHARS ? safe.slice(0, MAX_PREVIEW_CHARS) : safe;
}

function looksSecretOnly(content: string): boolean {
  const trimmed = content.trim();
  return /^(DEEPSEEK_API_KEY|DEEPSEEK_TOKEN)\s*=/.test(trimmed) || /^sk-[A-Za-z0-9_-]{8,}$/.test(trimmed);
}

function looksStale(content: string): boolean {
  return /(?:stale|deprecated|outdated|obsolete|过期|废弃)/i.test(content.slice(0, 400));
}

function candidateExclusion(
  classification: EvidenceTaskClassification,
  source: CandidateEvidenceSource,
  reason: EvidenceCandidateExclusionReason,
  fingerprint?: string
): EvidenceCandidateExclusion {
  return {
    schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
    exclusionId: `evidence-exclusion:${stableHash(`${classification.classificationId}:${source.sourcePath}:${reason}:${fingerprint ?? ""}`)}`,
    sourceGroup: source.sourceGroup,
    sourcePath: source.sourcePath,
    reason,
    ...(fingerprint ? { fingerprint } : {}),
    compatibility: EVIDENCE_FIRST_COMPATIBILITY,
    redaction: { class: "internal", fields: ["sourcePath", "fingerprint"] }
  };
}

function matchesAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function overlaps<T>(left: readonly T[], right: ReadonlySet<T>): boolean {
  return left.some((item) => right.has(item));
}

function unique<T>(items: readonly T[]): readonly T[] {
  return [...new Set(items)].sort((left, right) => String(left).localeCompare(String(right)));
}

function sortEvidenceValues<T extends string>(values: ReadonlySet<T>): readonly T[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function evidenceFirstEventData(context: EvidenceFirstRuntimeContext): JsonObject {
  return {
    schemaVersion: context.schemaVersion,
    classification: context.classification,
    ...(context.plan ? { plan: context.plan } : {}),
    selectedEvidenceCount: context.selectedEvidence.length,
    sourceCoverage: context.sourceCoverage,
    summary: context.summary,
    redaction: context.redaction,
    compatibility: context.compatibility
  };
}

export function groundStrictClaims(
  text: string,
  context: EvidenceFirstRuntimeContext,
  outputScope = "agent.loop.answer"
): { readonly claimGroundings: readonly ClaimGrounding[]; readonly unsupportedClaims: readonly UnsupportedClaimDiagnostic[]; readonly summary: EvidenceFirstSummary } {
  const claims = extractStrictClaims(text);
  const evidenceText = context.selectedEvidence.map((item) => item.preview).join("\n");
  const claimGroundings = claims.map((claim) => {
    const matchingEvidence = context.selectedEvidence.filter((item) => item.factClasses.includes(claim.factClass) && item.preview.toLowerCase().includes(claim.value.toLowerCase()));
    const inferredEvidence = matchingEvidence.length === 0 && !strictDirectEvidenceRequired(claim.factClass)
      ? context.selectedEvidence.filter((item) => hasTokenOverlap(item.preview, claim.value))
      : [];
    const supportEvidence = matchingEvidence.length > 0 ? matchingEvidence : inferredEvidence;
    const certainty = matchingEvidence.length > 0 ? "verified" : inferredEvidence.length > 0 ? "inferred" : claim.assumption ? "assumption" : "unsupported";
    return {
      schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
      claimId: `claim:${stableHash(`${claim.factClass}:${claim.value}`)}`,
      claimPreview: claim.value,
      claimFingerprint: `claim:${stableHash(claim.value)}`,
      factClass: claim.factClass,
      certainty,
      evidenceIds: supportEvidence.map((item) => item.evidenceId),
      outputScope,
      ...(certainty === "unsupported" ? { remediation: "rewrite-as-unknown" as const } : {}),
      compatibility: EVIDENCE_FIRST_COMPATIBILITY,
      redaction: { class: "internal", fields: ["claimPreview"] }
    } satisfies ClaimGrounding;
  });
  const unsupportedClaims = claimGroundings
    .filter((claim) => claim.certainty === "unsupported")
    .map((claim) => unsupportedDiagnostic(claim, outputScope, evidenceText));
  const verifiedOrInferred = claimGroundings.filter((claim) => claim.certainty !== "unsupported" && claim.certainty !== "assumption").length;
  const summary: EvidenceFirstSummary = {
    ...context.summary,
    claimGroundingRate: claimGroundings.length === 0 ? 1 : verifiedOrInferred / claimGroundings.length,
    unsupportedClaimCount: unsupportedClaims.length,
    assumptionCount: claimGroundings.filter((claim) => claim.certainty === "assumption").length,
    hallucinatedCommandCount: unsupportedClaims.filter((claim) => claim.code === "unsupported-command").length
  };
  return { claimGroundings, unsupportedClaims, summary };
}

interface ExtractedStrictClaim {
  readonly value: string;
  readonly factClass: EvidenceFactClass;
  readonly assumption: boolean;
}

function extractStrictClaims(text: string): readonly ExtractedStrictClaim[] {
  const claims: ExtractedStrictClaim[] = [];
  const seen = new Set<string>();
  const add = (value: string, factClass: EvidenceFactClass) => {
    const normalized = value.trim().replace(/\s+/g, " ");
    if (!normalized || seen.has(`${factClass}:${normalized}`)) return;
    seen.add(`${factClass}:${normalized}`);
    claims.push({ value: normalized, factClass, assumption: isAssumption(text, normalized) });
  };

  for (const match of text.matchAll(/\b(?:npm|npx|pnpm|yarn|node|tsx)\s+[^\n`"']{2,120}/gi)) add(cleanClaim(match[0]), "command");
  for (const match of text.matchAll(/\bdeepseek-agent-cli\b|\bdeepseek-cli-platform\b|\b@deepseek\/[a-z0-9-]+\b/gi)) add(match[0], "package");
  for (const match of text.matchAll(/\bdeepseek\b(?=\s+(?:run|chat|diagnostics|palette|revert|index-provider|mcp|extension|readiness)\b)/gi)) add(match[0], "executable");
  for (const match of text.matchAll(/\b(?:published|release-ready|ready to publish|can publish|already published|发布就绪|可以发布|已发布)\b[^\n.。]{0,100}/gi)) add(cleanClaim(match[0]), "release");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(?:assumption|assume|假设|推测)\s*[:：]/i.test(trimmed)) add(trimmed.replace(/^(?:assumption|assume|假设|推测)\s*[:：]\s*/i, ""), "feature");
    if (/^[-*]\s+\S/.test(trimmed)) add(trimmed.replace(/^[-*]\s+/, ""), "feature");
    if (/\b(runtime|platform-contracts|host adapter|monorepo|架构|契约|运行时)\b/i.test(trimmed)) add(trimmed, "architecture");
    if (/\b(success rate|benchmark|evaluation|Codex|Claude|评估|对比|成功率)\b/i.test(trimmed)) add(trimmed, "evaluation");
  }
  return claims.slice(0, 20);
}

function strictDirectEvidenceRequired(factClass: EvidenceFactClass): boolean {
  return factClass === "command" || factClass === "package" || factClass === "executable" || factClass === "install" || factClass === "release";
}

function hasTokenOverlap(evidence: string, claim: string): boolean {
  if (hasPassedSymbolEvidence(evidence, claim)) return true;
  const evidenceTokens = tokenSet(evidence);
  const claimTokens = tokenSet(claim);
  const meaningful = [...claimTokens].filter((token) => token.length >= 5);
  if (meaningful.length === 0) return false;
  const overlap = meaningful.filter((token) => evidenceTokens.has(token)).length;
  return overlap >= Math.min(2, meaningful.length);
}

function hasPassedSymbolEvidence(evidence: string, claim: string): boolean {
  if (!/(?:✅|\bpass(?:ed)?\b|通过)/i.test(claim)) return false;
  const symbols = extractTestLikeSymbols(claim);
  if (symbols.length === 0) return false;
  return symbols.every((symbol) => {
    const escaped = escapeRegExp(symbol);
    const passNearSymbol = new RegExp(`(?:${escaped}[^\\n]{0,80}\\bpass(?:ed)?\\b|\\bpass(?:ed)?\\b[^\\n]{0,80}${escaped}|${escaped}[^\\n]{0,80}通过|通过[^\\n]{0,80}${escaped})`, "i");
    return passNearSymbol.test(evidence);
  });
}

function extractTestLikeSymbols(value: string): readonly string[] {
  const symbols = new Set<string>();
  for (const match of value.matchAll(/`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*(?:\[[A-Za-z0-9_]+\])?)/g)) {
    const symbol = (match[1] ?? match[2] ?? "").trim();
    if (/^(?:pass|passed)$/i.test(symbol)) continue;
    if (symbol.includes("_") || /\[[A-Za-z0-9_]+\]/.test(symbol)) symbols.add(symbol);
  }
  return [...symbols];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenSet(value: string): ReadonlySet<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? []);
}

function cleanClaim(value: string): string {
  return value.replace(/[.;。；,，]+$/g, "").trim();
}

function isAssumption(text: string, value: string): boolean {
  const index = text.indexOf(value);
  const lineStart = index >= 0 ? Math.max(text.lastIndexOf("\n", index - 1) + 1, text.lastIndexOf("\r", index - 1) + 1, 0) : 0;
  const prefix = index >= 0 ? text.slice(lineStart, index).toLowerCase() : "";
  return /assum|假设|推测|inferred|可能|maybe/.test(prefix);
}

function unsupportedDiagnostic(claim: ClaimGrounding, outputScope: string, evidenceText: string): UnsupportedClaimDiagnostic {
  const code = claim.factClass === "command"
    ? "unsupported-command"
    : claim.factClass === "package"
      ? "unsupported-package"
      : claim.factClass === "release"
        ? "unsupported-release"
        : claim.factClass === "feature"
          ? "unsupported-feature"
          : "unsupported-claim";
  const evidenceHint = evidenceText.length > 0 ? "Selected evidence did not contain this strict claim." : "No selected evidence was available.";
  return {
    schemaVersion: EVIDENCE_FIRST_SCHEMA_VERSION,
    diagnosticId: `unsupported:${stableHash(`${claim.claimFingerprint}:${outputScope}`)}`,
    code,
    severity: "error",
    claimId: claim.claimId,
    claimFingerprint: claim.claimFingerprint,
    claimPreview: claim.claimPreview,
    missingFactClass: claim.factClass,
    artifactId: outputScope,
    remediationHint: `${evidenceHint} Remove it, rewrite it as unknown, or cite direct evidence.`,
    compatibility: EVIDENCE_FIRST_COMPATIBILITY,
    redaction: { class: "internal", fields: ["claimPreview", "remediationHint"] }
  };
}
