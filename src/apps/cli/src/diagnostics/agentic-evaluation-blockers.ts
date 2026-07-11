export type AgenticEvaluationBlockerPhase =
  | "task-routing"
  | "tool-policy"
  | "phase-progress"
  | "environment"
  | "verification"
  | "tool-execution"
  | "evaluation-scoring"
  | "batch-resume"
  | "cache-economics"
  | "trace-observability";

export type AgenticEvaluationBlockerSeverity = "release-blocking" | "error" | "warn";

export interface AgenticEvaluationSignals {
  readonly diagnosticCodes?: readonly string[];
  readonly terminalReason?: string;
  readonly evaluationResolved?: boolean;
  readonly sourceInspectionToolCount?: number;
  readonly sourceMutationCount?: number;
  readonly testCommandCount?: number;
  readonly successfulTestCommandCount?: number;
  readonly shellCommandCount?: number;
  readonly postVerificationShellCommandCount?: number;
  readonly batchExpectedCount?: number;
  readonly batchCompletedCount?: number;
  readonly providerCacheHitRate?: number;
  readonly providerCacheRequestCount?: number;
  readonly [key: string]: unknown;
}

export type AgenticEvaluationBlockerDetector =
  | { readonly kind: "diagnostic-code"; readonly code: string }
  | { readonly kind: "field-equals"; readonly field: string; readonly value: string | number | boolean }
  | { readonly kind: "field-not-equals"; readonly field: string; readonly value: string | number | boolean }
  | { readonly kind: "field-missing"; readonly field: string }
  | { readonly kind: "metric-at-least"; readonly metric: string; readonly threshold: number }
  | { readonly kind: "metric-below"; readonly metric: string; readonly threshold: number; readonly minimumSamplesMetric?: string; readonly minimumSamples?: number }
  | { readonly kind: "metric-less-than-metric"; readonly left: string; readonly right: string }
  | { readonly kind: "all"; readonly detectors: readonly AgenticEvaluationBlockerDetector[] }
  | { readonly kind: "any"; readonly detectors: readonly AgenticEvaluationBlockerDetector[] };

export interface AgenticEvaluationBlocker {
  readonly id: string;
  readonly phase: AgenticEvaluationBlockerPhase;
  readonly severity: AgenticEvaluationBlockerSeverity;
  readonly title: string;
  readonly detector: AgenticEvaluationBlockerDetector;
  readonly remediation: string;
}

export interface AgenticEvaluationBlockerFinding {
  readonly blocker: AgenticEvaluationBlocker;
  readonly evidence: string;
}

export function createAgenticEvaluationBlockerCatalog(): readonly AgenticEvaluationBlocker[] {
  return blockerCatalog;
}

export function evaluateAgenticEvaluationBlockers(signals: AgenticEvaluationSignals, catalog: readonly AgenticEvaluationBlocker[] = blockerCatalog): readonly AgenticEvaluationBlockerFinding[] {
  return catalog
    .filter((blocker) => matchesDetector(blocker.detector, signals))
    .map((blocker) => ({ blocker, evidence: evidenceForDetector(blocker.detector, signals) }));
}

const blockerCatalog: readonly AgenticEvaluationBlocker[] = [
  b(1, "stale-workspace-visible", "task-routing", "release-blocking", "Stale SWE-bench workspace path reached model context.", d("SWE_BENCH_STALE_WORKSPACE_VISIBLE"), "Hide historical evaluator workspaces from model-facing task guidance."),
  b(2, "short-prompt-not-classified", "task-routing", "error", "SWE-bench short prompt was not classified as executable evaluation.", d("SWE_BENCH_PROMPT_CLASSIFICATION_MISSING"), "Repair task delivery classification before launching the child agent."),
  b(3, "numbered-task-not-bound", "task-routing", "error", "Numbered task was not bound to a dataset instance.", d("SWE_BENCH_TASK_BINDING_MISSING"), "Resolve the dataset instance before creating a checkout."),
  b(4, "historical-trace-advertised", "task-routing", "error", "Historical trace path was advertised as model guidance.", d("SWE_BENCH_HISTORICAL_TRACE_VISIBLE"), "Keep historical traces supervisor-only and expose only governed tools."),
  b(5, "workspace-root-missing", "task-routing", "error", "Workspace root was missing from governed tool input.", d("TOOL_INTENT_WORKSPACE_ROOT_MISSING"), "Inject active workspaceRoot during preflight."),
  b(6, "cwd-missing-before-policy", "task-routing", "error", "Process cwd was missing before policy evaluation.", d("process.cwd.missing"), "Default cwd before sandbox policy evaluation."),
  b(7, "run-id-stale-reused", "task-routing", "error", "Fresh live probe reused a stale default run id.", d("SWE_BENCH_DEFAULT_RUN_ID_STALE"), "Use fresh run ids for non-resume probes."),
  b(8, "resume-run-id-unstable", "task-routing", "error", "Resume campaign omitted a stable run id.", d("SWE_BENCH_RESUME_RUN_ID_UNSTABLE"), "Derive stable campaign ids for resume batches."),
  b(9, "task-range-not-normalized", "task-routing", "error", "Prompt-declared task range was not normalized into taskNumbers.", d("SWE_BENCH_TASK_RANGE_NOT_NORMALIZED"), "Repair single task calls into prompt-declared taskNumbers."),
  b(10, "tool-projection-incomplete", "task-routing", "error", "Required governed tools were hidden from the model.", d("SWE_BENCH_TOOL_PROJECTION_INCOMPLETE"), "Expose governed SWE-bench, env, file, search, shell, and test tools."),

  b(11, "unknown-tool-called", "tool-policy", "error", "Model called an unknown tool.", d("TOOL_INTENT_UNKNOWN_TOOL"), "Reject unknown tools before envelope creation and feed back visible tool names."),
  b(12, "alias-not-normalized", "tool-policy", "error", "Provider-safe tool alias was not normalized.", d("TOOL_INTENT_ALIAS_NOT_NORMALIZED"), "Normalize provider aliases before policy checks."),
  b(13, "unsafe-absolute-path", "tool-policy", "release-blocking", "Tool input attempted an unsafe absolute path.", d("TOOL_INTENT_UNSAFE_ABSOLUTE_PATH"), "Reject paths outside the active workspace."),
  b(14, "parent-traversal", "tool-policy", "release-blocking", "Tool input attempted parent traversal.", d("TOOL_INTENT_PARENT_TRAVERSAL"), "Normalize and reject parent traversal before kernel execution."),
  b(15, "home-path-expanded", "tool-policy", "release-blocking", "Tool input attempted home path expansion.", d("TOOL_INTENT_HOME_PATH_REJECTED"), "Reject home-relative paths in model-authored inputs."),
  b(16, "secret-in-tool-input", "tool-policy", "release-blocking", "Model-authored tool input exposed a secret-like value.", d("TOOL_INTENT_SECRET_EXPOSURE"), "Redact and reject secret-bearing inputs."),
  b(17, "stale-workspace-tool-input", "tool-policy", "release-blocking", "Tool input targeted a historical SWE-bench workspace.", d("TASK_SCOPE_STALE_SWEBENCH_WORKSPACE"), "Reject stale workspace inputs before kernel execution."),
  b(18, "low-tool-timeout", "tool-policy", "error", "Governed SWE-bench timeout was lower than the long-running budget.", d("SWE_BENCH_TIMEOUT_TOO_LOW"), "Normalize run timeout to the governed long budget."),
  b(19, "policy-denied-envelope", "tool-policy", "error", "Runtime policy denied a governed execution envelope.", d("KERNEL_POLICY_DENIED"), "Fix preflight resource scope before kernel execution."),
  b(20, "approval-loop", "tool-policy", "warn", "Tool execution repeatedly asked for approval in an autonomous evaluation.", d("TOOL_APPROVAL_LOOP"), "Use full-access governed mode only inside the controlled evaluation boundary."),

  b(21, "source-inspection-loop", "phase-progress", "error", "Child spent source-inspection budget on read/search/list without edit or test progress.", all([m("sourceInspectionToolCount", 8), eq("sourceMutationCount", 0), eq("testCommandCount", 0)]), "Insert and enforce a source-inspection gate."),
  b(22, "no-source-inspection", "phase-progress", "warn", "Child attempted patching without any source inspection evidence.", d("SWE_BENCH_SOURCE_INSPECTION_MISSING"), "Require at least bounded source inspection before edit."),
  b(23, "edit-never-started", "phase-progress", "error", "Child never produced source mutation evidence.", d("SWE_BENCH_SOURCE_MUTATION_MISSING"), "Gate read/search loops and require concrete source progress."),
  b(24, "repair-no-diff", "phase-progress", "error", "Repair attempt ended without a diff.", d("SWE_BENCH_REPAIR_DIFF_MISSING"), "Require diff evidence before scoring a repair attempt."),
  b(25, "model-iteration-limit", "phase-progress", "error", "Child hit the model iteration limit.", eq("terminalReason", "model-iteration-limit"), "Classify the stuck phase and tighten phase budgets."),
  b(26, "tool-call-limit", "phase-progress", "error", "Child hit the tool-call limit.", eq("terminalReason", "tool-call-limit"), "Classify the noisy tool family and add a gate."),
  b(27, "text-only-completion", "phase-progress", "error", "Child returned text without required file mutation.", d("SWE_BENCH_TEXT_ONLY_COMPLETION"), "Reject text-only completion for mutation tasks."),
  b(28, "phase-budget-missing", "phase-progress", "error", "Managed child prompt did not include phase budgets.", d("SWE_BENCH_PHASE_BUDGET_MISSING"), "Inject the managed execution profile."),
  b(29, "gate-ignored", "phase-progress", "error", "Model ignored a framework gate without tool rejection.", d("SWE_BENCH_GATE_IGNORED"), "Convert soft gate feedback into pre-kernel rejection."),
  b(30, "self-repair-loop", "phase-progress", "warn", "Self-repair loop repeated without new evidence.", d("SELF_REPAIR_NO_NEW_EVIDENCE"), "Require new evidence before another repair attempt."),
  b(106, "post-edit-verification-missing", "phase-progress", "error", "Child edited source after heavy inspection but did not run a standard test command.", d("SWE_BENCH_POST_EDIT_VERIFICATION_GATE"), "Enforce a post-edit verification gate before more read/search/setup iterations."),
  b(124, "ready-for-harness-gate-missing", "phase-progress", "error", "Child had source mutation and successful test evidence but did not return through the ready-for-harness gate.", d("SWE_BENCH_READY_FOR_HARNESS_GATE_MISSING"), "Return control to the official harness immediately after successful local verification."),
  b(102, "swe-bench-request-budget-exceeded", "phase-progress", "error", "Child reached or exceeded the managed SWE-bench model request budget.", any([eq("terminalReason", "swe-bench-request-budget-exceeded"), all([m("modelRequestCount", 24), neq("terminalReason", "swe-bench-ready-for-harness"), any([missing("successfulTestCommandCount"), below("successfulTestCommandCount", 1)])])]), "Classify the runaway phase before spending more benchmark attempts."),

  b(31, "env-prepare-not-called", "environment", "error", "Outer model skipped governed environment preparation.", d("SWE_BENCH_ENV_PREPARE_MISSING"), "Route short prompts through core.env.prepare before the run capability."),
  b(32, "dataset-download-failed", "environment", "error", "SWE-bench dataset download failed.", d("SWE_BENCH_DATASET_DOWNLOAD_FAILED"), "Surface the dataset/network blocker and stop the run."),
  b(33, "checkout-base-commit-failed", "environment", "error", "Checkout could not be reset to the base commit.", d("SWE_BENCH_CHECKOUT_BASE_COMMIT_FAILED"), "Reset or recreate the run-scoped checkout."),
  b(34, "venv-creation-loop", "environment", "error", "Child looped on virtual environment creation.", d("SWE_BENCH_VENV_CREATION_LOOP"), "Let env.prepare own venv setup and block repeated child setup."),
  b(35, "dependency-install-loop", "environment", "error", "Child looped on dependency installation.", all([m("postVerificationShellCommandCount", 8), d("SWE_BENCH_ENVIRONMENT_BLOCKER_GATE")]), "Enforce the environment blocker gate."),
  b(36, "docker-unavailable", "environment", "error", "Official harness could not access Docker.", d("SWE_BENCH_DOCKER_CONTEXT_UNAVAILABLE"), "Record Docker as an environment blocker before scoring."),
  b(37, "docker-context-empty", "environment", "error", "Docker context did not expose a host.", d("SWE_BENCH_DOCKER_CONTEXT_EMPTY"), "Repair Docker context propagation."),
  b(101, "docker-image-not-found", "environment", "error", "Official harness could not find the required Docker image.", d("SWE_BENCH_DOCKER_IMAGE_NOT_FOUND"), "Prebuild, pull, or repair the missing SWE-bench evaluation image before rescoring."),
  b(38, "network-required-after-prepare", "environment", "warn", "Child requested broad network setup after preparation.", d("SWE_BENCH_NETWORK_SETUP_DRIFT"), "Keep network setup in env.prepare and block child drift."),
  b(39, "local-env-blocker-unreported", "environment", "error", "Local environment blocker was not reported as bounded evidence.", d("SWE_BENCH_ENV_BLOCKER_UNREPORTED"), "Return structured blocker evidence instead of looping."),
  b(40, "harness-env-missing", "environment", "error", "Harness environment variables were missing.", d("SWE_BENCH_HARNESS_ENV_MISSING"), "Propagate governed evaluation env explicitly."),
  b(109, "test-env-dependency-incompatible", "environment", "error", "Child test command failed during pytest setup because the local dependency set is incompatible with the checkout.", d("SWE_BENCH_TEST_ENV_DEPENDENCY_INCOMPATIBLE"), "Repair checkout constraints or dependency pinning before treating the patch as model-insufficient."),
  b(119, "test-env-dependency-missing", "environment", "error", "Child test command failed because a checkout-local Python test dependency is missing.", d("SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING"), "Repair the checkout-local virtualenv or dependency installation before treating the patch as model-insufficient."),

  b(41, "verification-command-missing", "verification", "error", "Child trace has shell activity but no test command.", d("SWE_BENCH_CHILD_TRACE_VERIFICATION_MISSING"), "Require model-authored standard test evidence."),
  b(42, "verification-gate-soft", "verification", "release-blocking", "Verification gate was inserted but not enforced.", d("SWE_BENCH_VERIFICATION_GATE_SOFT"), "Reject non-test shell commands after the gate."),
  b(43, "verification-gate-rejected", "verification", "warn", "Runtime had to reject a non-test shell after verification gate.", d("SWE_BENCH_VERIFICATION_GATE_ENFORCED"), "Review why the child ignored the test requirement."),
  b(44, "test-output-not-captured", "verification", "error", "Test command output was not captured as evidence.", d("SWE_BENCH_TEST_OUTPUT_MISSING"), "Record bounded test output and exit code."),
  b(45, "test-command-unrecognized", "verification", "error", "Model used an unrecognized test command form.", d("SWE_BENCH_TEST_COMMAND_UNRECOGNIZED"), "Expand or repair standard test command detection."),
  b(46, "test-after-final-missing", "verification", "error", "Final answer lacked independent test evidence.", d("FINAL_VERIFICATION_MISSING"), "Run or cite test evidence before final completion."),
  b(47, "core-test-run-not-counted", "verification", "error", "core.test.run was not counted as verification evidence.", d("SWE_BENCH_CORE_TEST_RUN_NOT_COUNTED"), "Count first-class test tools in trace summaries and gates."),
  b(48, "test-failures-not-summarized", "verification", "error", "Failing test names were not summarized.", d("SWE_BENCH_TEST_FAILURES_MISSING"), "Extract failing test ids for repair attempts."),
  b(49, "post-test-setup-loop", "verification", "error", "Child kept doing setup after edit and test evidence.", d("SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"), "Enforce dependency-loop blocker before kernel execution."),
  b(50, "verification-cache-stale", "verification", "warn", "Verification summary came from stale trace evidence.", d("SWE_BENCH_VERIFICATION_TRACE_STALE"), "Bind verification diagnostics to the current attempt trace."),
  b(123, "invalid-test-tool-command", "verification", "error", "core.test.run was used for a non-test read/search/list command.", d("SWE_BENCH_INVALID_TEST_TOOL_COMMAND_GATE"), "Reject and classify non-test commands in test tools before they can satisfy verification pressure."),
  b(110, "verification-oracle-gap", "verification", "error", "Local verification evidence did not predict official harness failure.", d("VERIFICATION_ORACLE_GAP"), "Feed official failures into the next repair and improve focused reproduction selection before model blame."),
  b(115, "local-test-unsuccessful", "verification", "error", "Child attempted local test commands but none completed successfully.", d("SWE_BENCH_CHILD_TRACE_TEST_UNSUCCESSFUL"), "Classify the local test failure or environment output before blaming model patch quality."),
  b(116, "test-entrypoint-missing", "verification", "error", "Child invoked a Python test runner path that does not exist in the checkout.", d("SWE_BENCH_TEST_ENTRYPOINT_MISSING"), "Locate the repo-local test entrypoint and rerun the focused test from the correct checkout directory."),
  b(117, "test-argument-unsupported", "verification", "error", "Child invoked a Python test runner with unsupported arguments.", d("SWE_BENCH_TEST_ARGUMENT_UNSUPPORTED"), "Rewrite the test command using the runner-supported option spelling before retrying."),
  b(122, "test-command-env-misscoped", "verification", "error", "Child invoked a Python test command from the wrong cwd, settings, or module scope.", d("SWE_BENCH_TEST_COMMAND_ENV_MISSCOPED"), "Repair the repo-local test runner, cwd, module path, or settings module before retrying."),

  b(51, "shell-pipeline-hidden-failure", "tool-execution", "error", "Shell pipeline could hide failed commands.", d("SWE_BENCH_SHELL_PIPEFAIL_MISSING"), "Run bash syntax with pipefail."),
  b(52, "process-output-truncated-critical", "tool-execution", "warn", "Critical tool output was truncated without evidence link.", d("TOOL_OUTPUT_CRITICAL_TRUNCATED"), "Store full evidence and return a bounded preview."),
  b(53, "kernel-executor-failure-no-evidence", "tool-execution", "error", "Kernel executor failed after structured run evidence existed.", d("SWE_BENCH_EXECUTOR_FAILURE_WITH_EVIDENCE"), "Return structured failed evidence instead of executor failure."),
  b(54, "terminal-tool-not-terminal", "tool-execution", "error", "Terminal governed run tool did not stop the outer loop.", d("SWE_BENCH_TERMINAL_TOOL_CONTINUED"), "Treat core.swe.bench.run as terminal on completion."),
  b(55, "hook-blocked-tool", "tool-execution", "error", "Hook blocked a required evaluation tool.", d("HOOK_TOOL_BLOCKED"), "Fix hook policy or surface the block as explicit evidence."),
  b(56, "tool-result-not-linked", "tool-execution", "error", "Tool result lacked durable evidence link.", d("TOOL_RESULT_EVIDENCE_MISSING"), "Record tool-result evidence for every model-visible result."),
  b(57, "lossless-tool-result-missing", "tool-execution", "warn", "Tool result was not recorded in lossless context.", d("LOSSLESS_TOOL_RESULT_MISSING"), "Persist bounded tool result context for continuation."),
  b(58, "preflight-repair-not-recorded", "tool-execution", "error", "Preflight repaired input without recording repair evidence.", d("TOOL_PREFLIGHT_REPAIR_UNRECORDED"), "Emit model.tool.repaired with repair details."),
  b(59, "sandbox-policy-mismatch", "tool-execution", "error", "Sandbox policy did not match tool side effects.", d("SANDBOX_POLICY_MISMATCH"), "Align capability permissions, sideEffect, and resource scope."),
  b(60, "tool-timeout-short", "tool-execution", "error", "Long-running governed tool used ordinary short timeout.", d("SWE_BENCH_LONG_TOOL_TIMEOUT_MISSING"), "Use manifest-declared long-running budget."),

  b(61, "official-harness-unresolved", "evaluation-scoring", "error", "Official harness reported unresolved instances.", any([d("SWE_BENCH_EVALUATION_UNRESOLVED"), eq("evaluationResolved", false)]), "Score as unresolved and launch bounded repair if available."),
  b(62, "official-harness-not-run", "evaluation-scoring", "release-blocking", "Prediction completed without official harness scoring.", d("SWE_BENCH_HARNESS_NOT_RUN"), "Run the official harness before reporting score."),
  b(63, "harness-report-stale", "evaluation-scoring", "release-blocking", "Harness report was stale.", d("SWE_BENCH_REPORT_STALE"), "Reject stale report files using a freshness marker."),
  b(64, "harness-report-missing", "evaluation-scoring", "error", "Expected harness report was missing.", d("SWE_BENCH_REPORT_READ_FAILED"), "Return structured failed evidence and preserve command plan."),
  b(65, "harness-run-id-collision", "evaluation-scoring", "error", "Official harness run id collided with a prior run.", d("SWE_BENCH_HARNESS_RUN_ID_COLLISION"), "Use unique official harness run ids per invocation."),
  b(66, "prediction-json-invalid", "evaluation-scoring", "error", "Prediction JSONL was invalid.", d("SWE_BENCH_PREDICTION_JSON_INVALID"), "Validate prediction records before harness execution."),
  b(67, "patch-empty", "evaluation-scoring", "error", "Prediction patch was empty.", d("SWE_BENCH_PATCH_EMPTY"), "Require non-empty diff evidence before scoring."),
  b(68, "raw-problem-leaked", "evaluation-scoring", "release-blocking", "Model-visible evidence leaked raw problem data.", d("SWE_BENCH_RAW_PROBLEM_LEAKED"), "Redact problem statements from bounded evidence."),
  b(69, "score-not-aggregated", "evaluation-scoring", "error", "Batch resolved rate was not aggregated.", d("SWE_BENCH_SCORE_AGGREGATE_MISSING"), "Compute total/resolved/unresolved/skipped counts."),
  b(70, "failed-evidence-misreported-pass", "evaluation-scoring", "release-blocking", "Failed evaluation evidence was reported as pass.", d("SWE_BENCH_FAILED_EVIDENCE_REPORTED_PASS"), "Separate capability envelope success from evaluation status."),

  b(71, "batch-task-root-shared", "batch-resume", "error", "Batch tasks shared the same run root.", d("SWE_BENCH_BATCH_ROOT_SHARED"), "Use isolated per-task run roots."),
  b(72, "resume-skipped-unresolved", "batch-resume", "error", "Resume skipped an unresolved task.", d("SWE_BENCH_RESUME_SKIPPED_UNRESOLVED"), "Skip only summaries proving evaluationResolved true."),
  b(73, "batch-progress-incomplete", "batch-resume", "error", "Batch progress is incomplete for the requested campaign.", less("batchCompletedCount", "batchExpectedCount"), "Persist batch progress after each child and resume pending tasks."),
  b(74, "batch-summary-missing", "batch-resume", "error", "Batch summary was missing.", d("SWE_BENCH_BATCH_SUMMARY_MISSING"), "Write batch-summary.json even for partial progress."),
  b(75, "task-state-missing", "batch-resume", "error", "Batch summary lacked per-task states.", d("SWE_BENCH_TASK_STATES_MISSING"), "Expose pending/resolved/unresolved/skipped states for every task."),
  b(76, "range-too-small", "batch-resume", "error", "Range normalization capped below campaign size.", d("SWE_BENCH_RANGE_CAP_TOO_SMALL"), "Support 200-instance campaign prompts."),
  b(77, "batch-resume-no-stable-id", "batch-resume", "error", "Resume did not use a stable campaign id.", d("SWE_BENCH_BATCH_RESUME_ID_MISSING"), "Derive default resume run id from taskNumbers."),
  b(78, "batch-child-trace-missing", "batch-resume", "error", "A child task summary lacked trace evidence.", d("SWE_BENCH_BATCH_CHILD_TRACE_MISSING"), "Require per-task trace path in child summaries."),
  b(79, "batch-score-stale", "batch-resume", "error", "Batch summary mixed stale child evidence.", d("SWE_BENCH_BATCH_SCORE_STALE"), "Validate child summary freshness before aggregation."),
  b(80, "batch-no-backpressure", "batch-resume", "warn", "Batch scheduling lacked bounded concurrency/backpressure.", d("SWE_BENCH_BATCH_BACKPRESSURE_MISSING"), "Keep campaign execution bounded and resumable."),

  b(81, "provider-cache-hit-low", "cache-economics", "warn", "Provider token cache hit rate missed the target.", all([below("providerCacheHitRate", 0.9, "providerCacheRequestCount", 1)]), "Improve prompt cache stability and provider cache reuse."),
  b(82, "provider-cache-missing", "cache-economics", "warn", "Provider usage cache metrics were missing.", d("SWE_BENCH_CACHE_TRACE_UNAVAILABLE"), "Surface provider usage cache in child traces."),
  b(83, "context-cache-mixed", "cache-economics", "error", "Context projection cache was mixed into provider cache SLO.", d("SWE_BENCH_CACHE_LAYER_MIXED"), "Report provider token cache and context projection cache separately."),
  b(84, "prompt-cache-busted", "cache-economics", "warn", "Prompt assembly changed stable cacheable prefixes.", d("PROMPT_CACHE_PREFIX_BUSTED"), "Move dynamic content after stable cacheable sections."),
  b(107, "whole-prompt-dynamic-prefix-stable", "cache-economics", "warn", "Whole prompt fingerprints changed while cacheable prefix fingerprints stayed stable.", d("PROMPT_WHOLE_FINGERPRINT_DYNAMIC_WITH_STABLE_PREFIX"), "Keep treating the stable prefix as cacheable and optimize the dynamic history tail separately."),
  b(85, "cache-request-count-low", "cache-economics", "warn", "Cache hit rate had too few provider requests to trust.", d("SWE_BENCH_CACHE_SAMPLE_TOO_SMALL"), "Report sample count alongside hit rate."),
  b(86, "cache-metadata-not-audited", "cache-economics", "error", "Token usage and cache metadata were not audited.", d("USAGE_CACHE_AUDIT_MISSING"), "Write request/token/cache usage to audit events."),
  b(87, "request-count-missing", "cache-economics", "error", "Provider request count was missing from summary.", d("SWE_BENCH_CACHE_REQUEST_COUNT_MISSING"), "Surface provider cache request count in run and batch summaries."),
  b(88, "token-budget-unbounded", "cache-economics", "warn", "Task consumed tokens without a budget signal.", d("USAGE_BUDGET_SIGNAL_MISSING"), "Record token usage against the active audit budget."),
  b(89, "dynamic-profile-cache-miss", "cache-economics", "warn", "Dynamic profile assembly reduced cacheability.", d("PROFILE_DYNAMIC_CACHE_MISS"), "Separate stable profile prefix from dynamic task payload."),
  b(90, "provider-cache-pipeline-missing", "cache-economics", "warn", "Context pipeline metadata did not reach provider requests before cache misses.", d("SWE_BENCH_PROVIDER_CACHE_PIPELINE_MISSING"), "Pass context pipeline metadata through prompt assembly, model.requested, and provider request usage."),
  b(122, "provider-cache-pipeline-telemetry-absent", "cache-economics", "warn", "Provider cache trace predates context pipeline telemetry.", d("SWE_BENCH_PROVIDER_CACHE_PIPELINE_TELEMETRY_ABSENT"), "Refresh cache evidence with the current context pipeline before diagnosing current provider pipeline failures."),
  b(101, "cache-regression-not-gated", "cache-economics", "error", "Cache regression did not fail evaluation readiness.", d("SWE_BENCH_CACHE_REGRESSION_NOT_GATED"), "Gate provider cache SLO in diagnostics evaluate."),
  b(103, "provider-cache-history-tail-miss", "cache-economics", "warn", "Stable prompt assembly still missed provider cache because tool-result history tail grew.", d("SWE_BENCH_PROVIDER_CACHE_HISTORY_TAIL_MISS"), "Keep provider-facing replay history bounded while preserving full lossless evidence."),
  b(104, "provider-cache-prefix-hint-missing", "cache-economics", "warn", "Stable prompt assembly reached the provider without explicit prefix cache hints.", d("SWE_BENCH_PROVIDER_CACHE_PREFIX_HINT_MISSING"), "Attach provider-supported prefix cache hints to the stable context pipeline prefix."),
  b(105, "provider-cache-prefix-hint-unsupported", "cache-economics", "warn", "Provider cache misses occurred while the selected provider reported explicit prefix hints as unsupported.", d("SWE_BENCH_PROVIDER_CACHE_PREFIX_HINT_UNSUPPORTED"), "Switch to a provider/model that supports prefix hints or lower this provider's cache-readiness gate."),
  b(111, "provider-cache-prefix-drift", "cache-economics", "warn", "Provider prefix fingerprints changed while replay fingerprints stayed stable.", d("SWE_BENCH_PROVIDER_CACHE_PREFIX_DRIFT"), "Remove session, turn, request, plan, or current-turn identifiers from provider-facing stable prefix text."),
  b(112, "provider-cache-breakpoint-shape-miss", "cache-economics", "warn", "Repeated zero-hit provider cache requests used the same context pipeline with sent prefix hints.", d("SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_MISS"), "Review provider-native cache breakpoint placement and preserve the stable prefix boundary."),
  b(113, "provider-tool-schema-cache-gap", "cache-economics", "warn", "Provider cache stayed low while stable visible tool schemas were present.", d("SWE_BENCH_PROVIDER_TOOL_SCHEMA_CACHE_GAP"), "Attach provider-native cache breakpoints to stable tool schemas and keep dynamic tools after the cached schema prefix."),
  b(114, "provider-prefix-coverage-low", "cache-economics", "warn", "Stable provider prefix covers too little of the growing provider request.", d("SWE_BENCH_PROVIDER_CACHE_PREFIX_COVERAGE_LOW"), "Bound dynamic provider history/tool-result tails or move reusable framework/tool schema content into a provider-cacheable prefix."),
  b(118, "provider-cache-dynamic-tail-miss", "cache-economics", "warn", "Provider cache reused stable prompt/tool regions but dynamic request tails dominated misses.", d("SWE_BENCH_PROVIDER_CACHE_DYNAMIC_TAIL_MISS"), "Reduce provider-facing dynamic history and tool-result tails while preserving full lossless evidence outside the provider request."),
  b(108, "provider-history-unbounded-after-gate", "cache-economics", "warn", "Provider-facing history grew past the managed tail after a framework gate user message.", d("SWE_BENCH_PROVIDER_HISTORY_UNBOUNDED_AFTER_GATE"), "Keep gate feedback as the latest user turn while bounding prior tool-result history."),
  b(120, "provider-cache-multi-message-breakpoint", "cache-economics", "warn", "Provider requests carried multiple message-level cache breakpoints while cache hits stayed low.", d("SWE_BENCH_PROVIDER_CACHE_MULTI_MESSAGE_BREAKPOINT"), "Keep at most one provider-native message breakpoint after the stable task prompt; prefer system, stable user task, and tool schema boundaries."),
  b(121, "provider-cache-breakpoint-shape-telemetry-missing", "cache-economics", "warn", "Low provider cache evidence lacked provider-native cache breakpoint-shape telemetry.", d("SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_TELEMETRY_MISSING"), "Attach redacted breakpoint-shape counts to provider usage events before drawing cache-shape conclusions from historical traces."),

  b(91, "trace-missing", "trace-observability", "error", "Child trace file was missing.", d("SWE_BENCH_CHILD_TRACE_MISSING"), "Persist every child attempt trace."),
  b(92, "trace-invalid-jsonl", "trace-observability", "error", "Child trace contained invalid JSONL.", d("SWE_BENCH_CHILD_TRACE_INVALID_JSONL"), "Validate trace lines before summarizing."),
  b(93, "terminal-event-missing", "trace-observability", "error", "Trace lacked terminal agent loop event.", d("SWE_BENCH_CHILD_TRACE_TERMINAL_MISSING"), "Require completed/failed/cancelled terminal event."),
  b(94, "terminal-failed", "trace-observability", "error", "Child trace ended in failure.", d("SWE_BENCH_CHILD_TRACE_TERMINAL_FAILED"), "Classify terminal reason and map it to a blocker."),
  b(95, "attempt-trace-overwritten", "trace-observability", "error", "Attempt trace was overwritten.", d("SWE_BENCH_ATTEMPT_TRACE_OVERWRITTEN"), "Write trace-attempt-N files and keep trace.jsonl as latest pointer."),
  b(96, "visible-reasoning-missing", "trace-observability", "warn", "Visible execution reasoning was missing.", d("VISIBLE_REASONING_MISSING"), "Emit visible reasoning records for tool intent and results."),
  b(97, "audit-event-missing", "trace-observability", "error", "Request/token/tool audit event was missing.", d("AUDIT_EVENT_MISSING"), "Record unified audit events for model and tools."),
  b(98, "diagnostic-code-unstable", "trace-observability", "error", "Diagnostic code was unstable or absent.", d("DIAGNOSTIC_CODE_UNSTABLE"), "Use stable diagnostic ids in summaries and tests."),
  b(99, "summary-redaction-missing", "trace-observability", "release-blocking", "Summary lacked redaction metadata.", d("SUMMARY_REDACTION_MISSING"), "Attach redaction metadata to run, batch, and diagnostic summaries."),
  b(100, "human-only-jsonl-review", "trace-observability", "error", "Failure required manual JSONL review instead of automatic blocker findings.", d("AGENTIC_BLOCKER_CATALOG_MISSING"), "Run the executable blocker catalog over trace and summary signals.")
];

function b(
  index: number,
  slug: string,
  phase: AgenticEvaluationBlockerPhase,
  severity: AgenticEvaluationBlockerSeverity,
  title: string,
  detector: AgenticEvaluationBlockerDetector,
  remediation: string
): AgenticEvaluationBlocker {
  return {
    id: `agentic.blocker.${String(index).padStart(3, "0")}.${slug}`,
    phase,
    severity,
    title,
    detector,
    remediation
  };
}

function d(code: string): AgenticEvaluationBlockerDetector {
  return { kind: "diagnostic-code", code };
}

function eq(field: string, value: string | number | boolean): AgenticEvaluationBlockerDetector {
  return { kind: "field-equals", field, value };
}

function neq(field: string, value: string | number | boolean): AgenticEvaluationBlockerDetector {
  return { kind: "field-not-equals", field, value };
}

function missing(field: string): AgenticEvaluationBlockerDetector {
  return { kind: "field-missing", field };
}

function m(metric: string, threshold: number): AgenticEvaluationBlockerDetector {
  return { kind: "metric-at-least", metric, threshold };
}

function below(metric: string, threshold: number, minimumSamplesMetric?: string, minimumSamples?: number): AgenticEvaluationBlockerDetector {
  return {
    kind: "metric-below",
    metric,
    threshold,
    ...(minimumSamplesMetric ? { minimumSamplesMetric } : {}),
    ...(typeof minimumSamples === "number" ? { minimumSamples } : {})
  };
}

function less(left: string, right: string): AgenticEvaluationBlockerDetector {
  return { kind: "metric-less-than-metric", left, right };
}

function all(detectors: readonly AgenticEvaluationBlockerDetector[]): AgenticEvaluationBlockerDetector {
  return { kind: "all", detectors };
}

function any(detectors: readonly AgenticEvaluationBlockerDetector[]): AgenticEvaluationBlockerDetector {
  return { kind: "any", detectors };
}

function matchesDetector(detector: AgenticEvaluationBlockerDetector, signals: AgenticEvaluationSignals): boolean {
  if (detector.kind === "diagnostic-code") return (signals.diagnosticCodes ?? []).includes(detector.code);
  if (detector.kind === "field-equals") return signals[detector.field] === detector.value;
  if (detector.kind === "field-not-equals") return signals[detector.field] !== detector.value;
  if (detector.kind === "field-missing") return signals[detector.field] === undefined;
  if (detector.kind === "metric-at-least") return numberSignal(signals, detector.metric) >= detector.threshold;
  if (detector.kind === "metric-below") {
    if (detector.minimumSamplesMetric && numberSignal(signals, detector.minimumSamplesMetric) < (detector.minimumSamples ?? 1)) return false;
    return numberSignal(signals, detector.metric) < detector.threshold;
  }
  if (detector.kind === "metric-less-than-metric") {
    const left = numberSignal(signals, detector.left);
    const right = numberSignal(signals, detector.right);
    return Number.isFinite(left) && Number.isFinite(right) && left < right;
  }
  if (detector.kind === "all") return detector.detectors.every((item) => matchesDetector(item, signals));
  return detector.detectors.some((item) => matchesDetector(item, signals));
}

function evidenceForDetector(detector: AgenticEvaluationBlockerDetector, signals: AgenticEvaluationSignals): string {
  if (detector.kind === "diagnostic-code") return `diagnostic:${detector.code}`;
  if (detector.kind === "field-equals") return `${detector.field}=${String(signals[detector.field])}`;
  if (detector.kind === "field-not-equals") return `${detector.field}!=${String(detector.value)} actual=${String(signals[detector.field])}`;
  if (detector.kind === "field-missing") return `${detector.field}=missing`;
  if (detector.kind === "metric-at-least") return `${detector.metric}=${numberSignal(signals, detector.metric)} >= ${detector.threshold}`;
  if (detector.kind === "metric-below") return `${detector.metric}=${numberSignal(signals, detector.metric)} < ${detector.threshold}`;
  if (detector.kind === "metric-less-than-metric") return `${detector.left}=${numberSignal(signals, detector.left)} < ${detector.right}=${numberSignal(signals, detector.right)}`;
  return detector.detectors.map((item) => evidenceForDetector(item, signals)).join("; ");
}

function numberSignal(signals: AgenticEvaluationSignals, key: string): number {
  const value = signals[key];
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}
