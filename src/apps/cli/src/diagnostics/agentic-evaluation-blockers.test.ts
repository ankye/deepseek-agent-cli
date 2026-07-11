import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateAgenticEvaluationBlockers,
  createAgenticEvaluationBlockerCatalog
} from "./agentic-evaluation-blockers.js";
import { summarizeSweBenchChildTrace } from "./swe-bench-child-trace.js";

describe("agentic evaluation blocker catalog", () => {
  it("defines at least 100 stable executable blockers for real agentic failure modes", () => {
    const catalog = createAgenticEvaluationBlockerCatalog();
    const ids = new Set(catalog.map((blocker) => blocker.id));
    const phases = new Set(catalog.map((blocker) => blocker.phase));

    assert.equal(catalog.length >= 100, true);
    assert.equal(ids.size, catalog.length);
    assert.equal(catalog[0]?.id, "agentic.blocker.001.stale-workspace-visible");
    assert.equal(phases.has("task-routing"), true);
    assert.equal(phases.has("phase-progress"), true);
    assert.equal(phases.has("evaluation-scoring"), true);
    assert.equal(phases.has("cache-economics"), true);
    assert.equal(phases.has("trace-observability"), true);
    assert.equal(catalog.every((blocker) => blocker.detector.kind.length > 0 && blocker.remediation.length > 0), true);
  });

  it("flags live-run failure signals instead of leaving JSONL trace review to humans", () => {
    const findings = evaluateAgenticEvaluationBlockers({
      sourceInspectionToolCount: 14,
      sourceMutationCount: 0,
      testCommandCount: 0,
      terminalReason: "model-iteration-limit",
      evaluationResolved: false,
      batchExpectedCount: 3,
      batchCompletedCount: 1,
      providerCacheHitRate: 0.68,
      providerCacheRequestCount: 14,
      diagnosticCodes: [
        "SWE_BENCH_REPAIR_ATTEMPT_REQUESTED",
        "SWE_BENCH_CHILD_TRACE_TERMINAL_FAILED",
        "SWE_BENCH_EVALUATION_UNRESOLVED"
      ]
    });
    const ids = new Set(findings.map((finding) => finding.blocker.id));

    assert.equal(ids.has("agentic.blocker.021.source-inspection-loop"), true);
    assert.equal(ids.has("agentic.blocker.025.model-iteration-limit"), true);
    assert.equal(ids.has("agentic.blocker.061.official-harness-unresolved"), true);
    assert.equal(ids.has("agentic.blocker.073.batch-progress-incomplete"), true);
    assert.equal(ids.has("agentic.blocker.081.provider-cache-hit-low"), true);
  });

  it("does not flag metric blockers when the metric is missing", () => {
    const findings = evaluateAgenticEvaluationBlockers({}, [{
      id: "agentic.blocker.test.metric",
      phase: "phase-progress",
      severity: "error",
      title: "Metric-only blocker",
      detector: { kind: "metric-at-least", metric: "missingMetric", threshold: 1 },
      remediation: "Provide the metric before evaluating this blocker."
    }]);

    assert.deepEqual(findings, []);
  });

  it("projects blocker findings from child trace summaries", () => {
    const trace = [
      ...Array.from({ length: 8 }, (_, index) => JSON.stringify({
        kind: "model.tool.intent",
        data: {
          name: index % 2 === 0 ? "core.search.text" : "core.file.read",
          input: index % 2 === 0 ? { pattern: "header_rows", glob: "*.py" } : { path: "astropy/io/ascii/rst.py" },
          iteration: index + 1
        }
      })),
      JSON.stringify({ kind: "agent.loop.failed", data: { status: "failed", reason: "model-iteration-limit", iterations: 10 } }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.sourceInspectionToolCount, 8);
    assert.equal(ids.has("agentic.blocker.021.source-inspection-loop"), true);
    assert.equal(ids.has("agentic.blocker.025.model-iteration-limit"), true);
  });

  it("counts workspace glob intents as child trace source inspection", () => {
    const trace = [
      ...Array.from({ length: 8 }, (_, index) => JSON.stringify({
        kind: "model.tool.intent",
        data: {
          name: "core.workspace.glob",
          input: { pattern: `src/**/candidate_${index}.py` },
          iteration: index + 1
        }
      })),
      JSON.stringify({ kind: "agent.loop.failed", data: { status: "failed", reason: "model-iteration-limit", iterations: 10 } }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.sourceInspectionToolCount, 8);
    assert.equal(ids.has("agentic.blocker.021.source-inspection-loop"), true);
  });

  it("projects request budget failures into a stable phase-progress blocker", () => {
    const trace = [
      ...Array.from({ length: 12 }, (_, index) => JSON.stringify({
        kind: "model.requested",
        data: {
          iteration: index + 1,
          modelRequestCount: index + 1
        }
      })),
      JSON.stringify({
        kind: "agent.loop.failed",
        data: {
          status: "rejected",
          reason: "swe-bench-request-budget-exceeded",
          iterations: 12,
          modelRequestCount: 12
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.modelRequestCount, 12);
    assert.equal(summary.terminalReason, "swe-bench-request-budget-exceeded");
    assert.equal(ids.has("agentic.blocker.102.swe-bench-request-budget-exceeded"), true);
  });

  it("does not treat twelve model requests as the widened request-budget signal", () => {
    const findings = evaluateAgenticEvaluationBlockers({
      modelRequestCount: 12
    });
    const ids = new Set(findings.map((finding) => finding.blocker.id));

    assert.equal(ids.has("agentic.blocker.102.swe-bench-request-budget-exceeded"), false);
  });

  it("treats twenty-four model requests as the widened request-budget signal", () => {
    const findings = evaluateAgenticEvaluationBlockers({
      modelRequestCount: 24
    });
    const ids = new Set(findings.map((finding) => finding.blocker.id));

    assert.equal(ids.has("agentic.blocker.102.swe-bench-request-budget-exceeded"), true);
  });

  it("does not treat twelve ready-for-harness requests as request-budget failures", () => {
    const findings = evaluateAgenticEvaluationBlockers({
      terminalReason: "swe-bench-ready-for-harness",
      modelRequestCount: 12
    });
    const ids = new Set(findings.map((finding) => finding.blocker.id));

    assert.equal(ids.has("agentic.blocker.102.swe-bench-request-budget-exceeded"), false);
  });

  it("projects local verification success followed by official failure into an oracle-gap blocker", () => {
    const findings = evaluateAgenticEvaluationBlockers({
      diagnosticCodes: ["VERIFICATION_ORACLE_GAP"],
      terminalReason: "swe-bench-ready-for-harness",
      evaluationResolved: false,
      testCommandCount: 1
    });
    const ids = new Set(findings.map((finding) => finding.blocker.id));

    assert.equal(ids.has("agentic.blocker.110.verification-oracle-gap"), true);
    assert.equal(ids.has("agentic.blocker.102.swe-bench-request-budget-exceeded"), false);
  });

  it("projects stable provider-prefix coverage gaps into cache blocker findings", () => {
    const findings = evaluateAgenticEvaluationBlockers({
      diagnosticCodes: ["SWE_BENCH_PROVIDER_CACHE_PREFIX_COVERAGE_LOW"]
    });
    const ids = new Set(findings.map((finding) => finding.blocker.id));

    assert.equal(ids.has("agentic.blocker.114.provider-prefix-coverage-low"), true);
  });

  it("projects effective stable-cache hits with dynamic tail misses into cache blocker findings", () => {
    const findings = evaluateAgenticEvaluationBlockers({
      diagnosticCodes: ["SWE_BENCH_PROVIDER_CACHE_DYNAMIC_TAIL_MISS"]
    });
    const ids = new Set(findings.map((finding) => finding.blocker.id));

    assert.equal(ids.has("agentic.blocker.118.provider-cache-dynamic-tail-miss"), true);
  });

  it("projects multiple provider message cache breakpoints into cache blocker findings", () => {
    const findings = evaluateAgenticEvaluationBlockers({
      diagnosticCodes: ["SWE_BENCH_PROVIDER_CACHE_MULTI_MESSAGE_BREAKPOINT"]
    });
    const ids = new Set(findings.map((finding) => finding.blocker.id));

    assert.equal(ids.has("agentic.blocker.120.provider-cache-multi-message-breakpoint"), true);
  });

  it("projects missing provider breakpoint-shape telemetry into cache blocker findings", () => {
    const findings = evaluateAgenticEvaluationBlockers({
      diagnosticCodes: ["SWE_BENCH_PROVIDER_CACHE_BREAKPOINT_SHAPE_TELEMETRY_MISSING"]
    });
    const ids = new Set(findings.map((finding) => finding.blocker.id));

    assert.equal(ids.has("agentic.blocker.121.provider-cache-breakpoint-shape-telemetry-missing"), true);
  });

  it("projects managed budget-consumed events into request-budget blockers", () => {
    const trace = [
      ...Array.from({ length: 12 }, (_, index) => JSON.stringify({
        kind: "model.requested",
        data: {
          iteration: index + 1
        }
      })),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "model-iteration",
            consumed: 12,
            allowed: 12,
            remaining: 0,
            stopReason: "swe-bench-request-budget-exceeded"
          },
          gate: "SWE_BENCH_REQUEST_BUDGET_GATE",
          modelRequestCount: 12,
          toolCallCount: 13,
          sourceInspectionToolCount: 12,
          sourceMutationCount: 1,
          shellCommandCount: 0,
          testCommandCount: 0
        }
      }),
      JSON.stringify({
        kind: "agent.repair.stopped",
        data: {
          stopReason: "completed"
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.modelRequestCount, 12);
    assert.equal(summary.terminalKind, "agent.loop.budget.consumed");
    assert.equal(summary.terminalReason, "swe-bench-request-budget-exceeded");
    assert.equal(summary.sourceInspectionToolCount, 12);
    assert.equal(summary.sourceMutationCount, 1);
    assert.equal(summary.testCommandCount, 0);
    assert.equal(ids.has("agentic.blocker.102.swe-bench-request-budget-exceeded"), true);
  });

  it("projects post-edit verification gates into stable blockers", () => {
    const trace = [
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-post-edit-test-command-missing"
          },
          gate: "SWE_BENCH_POST_EDIT_VERIFICATION_GATE",
          sourceInspectionToolCount: 8,
          sourceMutationCount: 1,
          shellCommandCount: 0,
          testCommandCount: 0
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.terminalKind, "agent.loop.budget.consumed");
    assert.equal(summary.terminalReason, "swe-bench-post-edit-test-command-missing");
    assert.equal(ids.has("agentic.blocker.106.post-edit-verification-missing"), true);
  });

  it("does not count failed source edit tool results as mutation progress", () => {
    const trace = [
      ...Array.from({ length: 10 }, (_, index) => JSON.stringify({
        kind: "model.tool.intent",
        data: {
          name: index % 2 === 0 ? "core.search.text" : "core.file.read",
          input: index % 2 === 0 ? { pattern: "needle", glob: "*.py" } : { path: "src/example.py" },
          iteration: index + 1
        }
      })),
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-noop-edit",
          name: "core.file.edit",
          input: { path: "src/example.py", expected: "old", replacement: "old" },
          iteration: 11
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-noop-edit",
          toolName: "core.file.edit",
          terminalKind: "capability.failed"
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.sourceInspectionToolCount, 10);
    assert.equal(summary.sourceMutationCount, 0);
    assert.equal(ids.has("agentic.blocker.021.source-inspection-loop"), true);
  });

  it("keeps the last managed budget gate as terminal evidence when the loop closes normally", () => {
    const trace = [
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-post-edit-test-command-missing"
          },
          gate: "SWE_BENCH_POST_EDIT_VERIFICATION_GATE",
          sourceInspectionToolCount: 8,
          sourceMutationCount: 1,
          shellCommandCount: 0,
          testCommandCount: 0
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-environment-blocker"
          },
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          sourceMutationCount: 1,
          shellCommandCount: 2,
          testCommandCount: 1
        }
      }),
      JSON.stringify({
        kind: "agent.loop.completed",
        data: {
          status: "completed",
          reason: "swe-bench-environment-blocker"
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");

    assert.equal(summary.terminalKind, "agent.loop.budget.consumed");
    assert.equal(summary.terminalReason, "swe-bench-environment-blocker");
    assert.equal(summary.testCommandCount, 1);
  });

  it("does not treat post-edit or phase-planner budget events as terminal after later completion", () => {
    const trace = [
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-post-edit-test-command-missing"
          },
          gate: "SWE_BENCH_POST_EDIT_VERIFICATION_GATE",
          sourceInspectionToolCount: 2,
          sourceMutationCount: 1,
          shellCommandCount: 0,
          testCommandCount: 0
        }
      }),
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          name: "core.test.run",
          input: {
            command: "python -m pytest",
            args: ["astropy/io/ascii/tests/test_qdp.py"]
          },
          iteration: 2
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolName: "core.test.run",
          terminalKind: "capability.completed",
          feedback: { status: "success" }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          schemaVersion: "1.0.0",
          kind: "verification",
          policy: { source: "runtime.phase-planner" }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.completed",
        data: {
          status: "completed",
          iterations: 8
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.terminalKind, "agent.loop.completed");
    assert.equal(summary.terminalStatus, "completed");
    assert.equal(summary.terminalReason, undefined);
    assert.equal(summary.testCommandCount, 1);
    assert.equal(summary.diagnosticCodes.includes("SWE_BENCH_POST_EDIT_VERIFICATION_GATE"), false);
    assert.equal(ids.has("agentic.blocker.106.post-edit-verification-missing"), false);
  });

  it("treats managed ready-for-harness gates as completed child traces", () => {
    const trace = [
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-ready-for-harness"
          },
          gate: "SWE_BENCH_READY_FOR_HARNESS_GATE",
          sourceMutationCount: 1,
          testCommandCount: 1,
          successfulTestCommandCount: 1,
          diffInspectionCount: 1,
          modelRequestCount: 12
        }
      }),
      JSON.stringify({
        kind: "agent.loop.completed",
        data: {
          status: "completed",
          reason: "swe-bench-ready-for-harness"
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.terminalKind, "agent.loop.completed");
    assert.equal(summary.terminalStatus, "completed");
    assert.equal(summary.terminalReason, "swe-bench-ready-for-harness");
    assert.equal(summary.successfulTestCommandCount, 1);
    assert.equal(summary.diagnosticCodes.includes("SWE_BENCH_READY_FOR_HARNESS_GATE"), true);
    assert.equal(ids.has("agentic.blocker.102.swe-bench-request-budget-exceeded"), false);
  });

  it("does not count non-test core.test.run commands as verification evidence", () => {
    const trace = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-invalid-test-tool",
          name: "core.test.run",
          input: {
            command: "cat",
            args: ["django/forms/widgets.py"]
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-invalid-test-tool",
          toolName: "core.test.run",
          terminalKind: "capability.completed",
          evidence: {
            status: "success",
            metadata: { exitCode: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "model-iteration",
            stopReason: "swe-bench-request-budget-exceeded"
          },
          gate: "SWE_BENCH_REQUEST_BUDGET_GATE",
          modelRequestCount: 12,
          sourceInspectionToolCount: 8,
          sourceMutationCount: 0,
          shellCommandCount: 0,
          testCommandCount: 0,
          successfulTestCommandCount: 0
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.testCommandCount, 0);
    assert.equal(summary.successfulTestCommandCount, 0);
    assert.equal(summary.invalidTestToolCommandCount, 1);
    assert.equal(summary.diagnosticCodes.includes("SWE_BENCH_INVALID_TEST_TOOL_COMMAND_GATE"), true);
    assert.equal(ids.has("agentic.blocker.123.invalid-test-tool-command"), true);
  });

  it("classifies pytest internal dependency API mismatches as environment blockers", () => {
    const trace = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          name: "core.test.run",
          input: {
            command: "python -m pytest",
            args: ["astropy/io/ascii/tests/test_qdp.py", "-xvs"]
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolName: "core.test.run",
          result: [
            "Tool core.test.run reported failed:",
            "INTERNALERROR> Traceback (most recent call last):",
            "INTERNALERROR>   File \"/workspace/repo/.venv/lib/python3.9/site-packages/numpy/__init__.py\", line 410, in __getattr__",
            "INTERNALERROR>     raise AttributeError(\"module {!r} has no attribute \")",
            "INTERNALERROR> AttributeError: module 'numpy' has no attribute 'product'"
          ].join("\n"),
          feedback: { status: "failed" }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-environment-blocker"
          },
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          sourceMutationCount: 1,
          shellCommandCount: 0,
          testCommandCount: 1
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.diagnosticCodes.includes("SWE_BENCH_TEST_ENV_DEPENDENCY_INCOMPATIBLE"), true);
    assert.equal(ids.has("agentic.blocker.109.test-env-dependency-incompatible"), true);
  });

  it("classifies missing Python test dependencies as environment blockers", () => {
    const trace = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.shell.run",
          input: {
            command: "python -m pytest astropy/io/ascii/tests/test_rst.py -x -v"
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.shell.run",
          result: [
            "Tool core.shell.run reported failed:",
            "PYTHON_TEST_DEPENDENCY_MISSING: Python test environment is missing module 'pytest'.",
            "Do not repeat the same pytest command until the checkout environment is repaired."
          ].join("\n"),
          evidence: {
            status: "failed",
            metadata: { exitCode: 1 }
          }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-environment-blocker"
          },
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          sourceMutationCount: 1,
          shellCommandCount: 1,
          testCommandCount: 1
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.diagnosticCodes.includes("SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING"), true);
    assert.equal(ids.has("agentic.blocker.119.test-env-dependency-missing"), true);
  });

  it("preserves structured Python test failure details from child trace evidence", () => {
    const trace = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.test.run",
          input: {
            command: "python",
            args: ["-m", "django", "test", "forms_tests.tests.test_media"]
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.test.run",
          result: [
            "Tool core.test.run reported failed:",
            "PYTHON_TEST_DEPENDENCY_MISSING: Python test environment is missing module 'forms_tests'."
          ].join("\n"),
          evidence: {
            status: "failed",
            metadata: {
              exitCode: 1,
              testFailure: {
                kind: "python-missing-module",
                moduleName: "forms_tests",
                suggestedAction: "install-python-test-dependency",
                suggestedCommand: "python -m pip install forms_tests",
                alternateCommand: "python tests/runtests.py",
                alternateRunnerPath: "tests/runtests.py"
              }
            }
          }
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");

    assert.deepEqual(summary.testFailureDetails, [{
      toolCallId: "call-test",
      toolName: "core.test.run",
      kind: "python-missing-module",
      moduleName: "forms_tests",
      suggestedAction: "install-python-test-dependency",
      suggestedCommand: "python -m pip install forms_tests",
      alternateCommand: "python tests/runtests.py",
      alternateRunnerPath: "tests/runtests.py"
    }]);
  });

  it("normalizes missing Python test launcher details to repo-local runner next actions", () => {
    const trace = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.test.run",
          input: {
            command: "python",
            args: ["-m", "nose", "tests/test_demo.py"]
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.test.run",
          result: "Tool core.test.run reported failed:\nPYTHON_TEST_DEPENDENCY_MISSING: Python test environment is missing module 'nose'.",
          evidence: {
            status: "failed",
            metadata: {
              testFailure: {
                kind: "python-missing-module",
                moduleName: "nose",
                suggestedAction: "install-python-test-dependency",
                suggestedCommand: "python -m pip install nose",
                alternateCommand: "python tests/runtests.py",
                alternateRunnerPath: "tests/runtests.py"
              }
            }
          }
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");

    assert.deepEqual(summary.testFailureDetails, [{
      toolCallId: "call-test",
      toolName: "core.test.run",
      kind: "python-missing-module",
      moduleName: "nose",
      suggestedAction: "use-repo-local-python-test-runner",
      suggestedCommand: "python tests/runtests.py",
      alternateCommand: "python tests/runtests.py",
      alternateRunnerPath: "tests/runtests.py"
    }]);
  });

  it("recovers Python test failure details from legacy child trace output text", () => {
    const trace = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.shell.run",
          input: {
            command: "python -m pytest tests/invalid_models_tests/test_ordinary_fields.py -xvs 2>&1 | tail -30"
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.shell.run",
          result: "Tool core.shell.run reported failed:\n/workspace/repo/.venv/bin/python: No module named pytest",
          evidence: {
            status: "failed",
            metadata: { exitCode: 1 }
          }
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");

    assert.deepEqual(summary.testFailureDetails, [{
      toolCallId: "call-test",
      toolName: "core.shell.run",
      kind: "python-missing-module",
      moduleName: "pytest",
      suggestedAction: "install-python-test-dependency",
      suggestedCommand: "python -m pip install pytest"
    }]);
  });

  it("deduplicates equivalent Python test failure details across capability and tool result events", () => {
    const testFailure = {
      kind: "python-missing-module",
      moduleName: "forms_tests",
      suggestedAction: "install-python-test-dependency",
      suggestedCommand: "python -m pip install forms_tests"
    };
    const trace = [
      JSON.stringify({
        kind: "capability.completed",
        data: {
          capabilityId: "core.test.run",
          output: {
            evidence: {
              metadata: { testFailure }
            }
          }
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.test.run",
          result: "Tool core.test.run reported failed:\nPYTHON_TEST_DEPENDENCY_MISSING: Python test environment is missing module 'forms_tests'.",
          evidence: {
            status: "failed",
            metadata: {
              exitCode: 1,
              testFailure
            }
          }
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");

    assert.deepEqual(summary.testFailureDetails, [{
      toolCallId: "call-test",
      toolName: "core.test.run",
      ...testFailure
    }]);
  });

  it("does not keep stale Python setup blockers after later successful test evidence", () => {
    const trace = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-missing-dep",
          name: "core.test.run",
          input: {
            command: "python",
            args: ["-m", "django", "test", "forms_tests.tests.test_media"]
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-missing-dep",
          toolName: "core.test.run",
          result: [
            "Tool core.test.run reported failed:",
            "PYTHON_TEST_DEPENDENCY_MISSING: Python test environment is missing module 'forms_tests'."
          ].join("\n"),
          evidence: {
            status: "failed",
            metadata: { exitCode: 1 }
          }
        }
      }),
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-focused-test",
          name: "core.shell.run",
          input: {
            command: "python tests/runtests.py forms_tests.tests.test_media -v 2"
          },
          iteration: 2
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-focused-test",
          toolName: "core.shell.run",
          result: "Ran 17 tests in 0.012s\n\nOK",
          evidence: {
            status: "success",
            metadata: { exitCode: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-environment-blocker"
          },
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          sourceMutationCount: 1,
          shellCommandCount: 2,
          testCommandCount: 2,
          successfulTestCommandCount: 1
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.successfulTestCommandCount, 1);
    assert.equal(summary.diagnosticCodes.includes("SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING"), false);
    assert.equal(summary.diagnosticCodes.includes("SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"), false);
    assert.equal(ids.has("agentic.blocker.119.test-env-dependency-missing"), false);
    assert.equal(ids.has("agentic.blocker.049.post-test-setup-loop"), false);
  });

  it("counts piped repo-local Django runner shell commands as successful tests", () => {
    const trace = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-focused-test",
          name: "core.shell.run",
          input: {
            command: "cd repo && python tests/runtests.py forms_tests.tests.test_media -v 2 | head -100"
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-focused-test",
          toolName: "core.shell.run",
          result: "Ran 17 tests in 0.012s\n\nOK",
          evidence: {
            status: "success",
            metadata: { exitCode: 0 }
          }
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");

    assert.equal(summary.testCommandCount, 1);
    assert.equal(summary.successfulTestCommandCount, 1);
  });

  it("keeps Python setup blockers that occur after the latest successful test evidence", () => {
    const trace = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-focused-test",
          name: "core.shell.run",
          input: {
            command: "python tests/runtests.py forms_tests.tests.test_media -v 2"
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-focused-test",
          toolName: "core.shell.run",
          result: "Ran 17 tests in 0.012s\n\nOK",
          evidence: {
            status: "success",
            metadata: { exitCode: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-later-missing-dep",
          name: "core.test.run",
          input: {
            command: "python",
            args: ["-m", "django", "test", "forms_tests.tests.test_media"]
          },
          iteration: 2
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-later-missing-dep",
          toolName: "core.test.run",
          result: [
            "Tool core.test.run reported failed:",
            "PYTHON_TEST_DEPENDENCY_MISSING: Python test environment is missing module 'forms_tests'."
          ].join("\n"),
          evidence: {
            status: "failed",
            metadata: { exitCode: 1 }
          }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-environment-blocker"
          },
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          sourceMutationCount: 1,
          shellCommandCount: 2,
          testCommandCount: 2,
          successfulTestCommandCount: 1
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.successfulTestCommandCount, 1);
    assert.equal(summary.diagnosticCodes.includes("SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING"), true);
    assert.equal(summary.diagnosticCodes.includes("SWE_BENCH_ENVIRONMENT_BLOCKER_GATE"), true);
    assert.equal(ids.has("agentic.blocker.119.test-env-dependency-missing"), true);
    assert.equal(ids.has("agentic.blocker.049.post-test-setup-loop"), true);
  });

  it("classifies legacy no-module Python output as missing test dependencies", () => {
    const trace = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.test.run",
          input: {
            command: "python -m pytest",
            args: ["astropy/io/ascii/tests/test_rst.py", "-x", "-v"]
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.test.run",
          result: [
            "Tool core.test.run reported failed:",
            "/workspace/.deepseek/swe-lite-runs/unit-run/repo/.venv/bin/python: No module named pytest"
          ].join("\n"),
          evidence: {
            status: "failed",
            metadata: { exitCode: 1 }
          }
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.diagnosticCodes.includes("SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING"), true);
    assert.equal(ids.has("agentic.blocker.119.test-env-dependency-missing"), true);
  });

  it("projects attempted local tests with zero successes into a verification blocker", () => {
    const trace = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.test.run",
          input: {
            command: "python",
            args: ["-m", "pytest", "tests/test_demo.py"]
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.test.run",
          terminalKind: "capability.completed",
          feedback: { status: "success" },
          evidence: {
            status: "failed",
            metadata: { exitCode: 1 }
          }
        }
      }),
      JSON.stringify({
        kind: "agent.loop.budget.consumed",
        data: {
          budget: {
            kind: "verification",
            stopReason: "swe-bench-environment-blocker"
          },
          gate: "SWE_BENCH_ENVIRONMENT_BLOCKER_GATE",
          sourceMutationCount: 1,
          shellCommandCount: 5,
          testCommandCount: 1,
          successfulTestCommandCount: 0
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.testCommandCount, 1);
    assert.equal(summary.successfulTestCommandCount, 0);
    assert.equal(summary.diagnosticCodes.includes("SWE_BENCH_CHILD_TRACE_TEST_UNSUCCESSFUL"), true);
    assert.equal(ids.has("agentic.blocker.115.local-test-unsuccessful"), true);
  });

  it("recognizes structured WSL shell test intents during child trace review", () => {
    const trace = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-wsl-test",
          name: "core.shell.run",
          input: {
            command: "wsl.exe",
            args: ["--cd", "/mnt/c/repo", "python", "-m", "pytest", "tests/test_demo.py"]
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-wsl-test",
          toolName: "core.shell.run",
          terminalKind: "capability.completed",
          evidence: {
            status: "success",
            metadata: { exitCode: 0 }
          }
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");

    assert.equal(summary.shellCommandCount, 1);
    assert.equal(summary.testCommandCount, 1);
    assert.equal(summary.successfulTestCommandCount, 1);
    assert.equal(summary.diagnosticCodes.includes("SWE_BENCH_CHILD_TRACE_VERIFICATION_MISSING"), false);
  });

  it("projects missing Python test runner feedback into a stable verification blocker", () => {
    const trace = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.test.run",
          input: {
            command: "python",
            args: ["runtests.py", "forms_tests.tests.test_media"]
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.test.run",
          terminalKind: "capability.completed",
          result: [
            "Tool core.test.run reported failed:",
            "PYTHON_TEST_ENTRYPOINT_MISSING: Python could not open test runner file '/workspace/repo/runtests.py'.",
            "Find the repo-local test runner before retrying; do not repeat the same command from the wrong directory."
          ].join("\n"),
          evidence: {
            status: "failed",
            metadata: { exitCode: 2 }
          }
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.diagnosticCodes.includes("SWE_BENCH_TEST_ENTRYPOINT_MISSING"), true);
    assert.equal(ids.has("agentic.blocker.116.test-entrypoint-missing"), true);
  });

  it("projects unsupported Python test argument feedback into a stable verification blocker", () => {
    const trace = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.test.run",
          input: {
            command: "python",
            args: ["tests/runtests.py", "forms_tests.tests.test_media", "--no-input"]
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.test.run",
          terminalKind: "capability.completed",
          result: [
            "Tool core.test.run reported failed:",
            "PYTHON_TEST_ARGUMENT_UNSUPPORTED: Python test runner rejected option '--no-input'.",
            "Use '--noinput' instead of '--no-input' before retrying."
          ].join("\n"),
          evidence: {
            status: "failed",
            metadata: { exitCode: 2 }
          }
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.diagnosticCodes.includes("SWE_BENCH_TEST_ARGUMENT_UNSUPPORTED"), true);
    assert.equal(ids.has("agentic.blocker.117.test-argument-unsupported"), true);
  });

  it("projects Python test command environment scope failures into a stable verification blocker", () => {
    const trace = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.shell.run",
          input: {
            command: "python -m django test tests.invalid_models_tests.test_ordinary_fields.FilePathFieldTests --settings=test_sqlite --verbosity=2"
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.shell.run",
          terminalKind: "capability.completed",
          result: [
            "Tool core.shell.run reported failed:",
            "PYTHON_TEST_COMMAND_ENV_MISSCOPED: Python test command could not import local test module/settings 'test_sqlite'.",
            "Use the repo-local test runner, cwd, module path, or settings module before retrying."
          ].join("\n"),
          evidence: {
            status: "failed",
            metadata: { exitCode: 1 }
          }
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.diagnosticCodes.includes("SWE_BENCH_TEST_COMMAND_ENV_MISSCOPED"), true);
    assert.equal(summary.diagnosticCodes.includes("SWE_BENCH_TEST_ENV_DEPENDENCY_MISSING"), false);
    assert.equal(ids.has("agentic.blocker.122.test-command-env-misscoped"), true);
  });

  it("does not count a successful non-test shell result as successful test evidence", () => {
    const trace = [
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-probe",
          name: "core.shell.run",
          input: {
            command: "python -c \"print('probe')\""
          },
          iteration: 1
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-probe",
          toolName: "core.shell.run",
          terminalKind: "capability.completed",
          evidence: {
            status: "success",
            metadata: { exitCode: 0 }
          }
        }
      }),
      JSON.stringify({
        kind: "model.tool.intent",
        data: {
          toolCallId: "call-test",
          name: "core.test.run",
          input: {
            command: "python",
            args: ["-m", "pytest", "tests/test_demo.py"]
          },
          iteration: 2
        }
      }),
      JSON.stringify({
        kind: "model.tool.result",
        data: {
          toolCallId: "call-test",
          toolName: "core.test.run",
          terminalKind: "capability.completed",
          feedback: { status: "success" },
          evidence: {
            status: "failed",
            metadata: { exitCode: 1 }
          }
        }
      }),
      ""
    ].join("\n");

    const summary = summarizeSweBenchChildTrace(trace, "/workspace/trace.jsonl");
    const ids = new Set(summary.blockerFindings.map((finding) => finding.blockerId));

    assert.equal(summary.shellCommandCount, 1);
    assert.equal(summary.testCommandCount, 1);
    assert.equal(summary.successfulTestCommandCount, 0);
    assert.equal(summary.diagnosticCodes.includes("SWE_BENCH_CHILD_TRACE_TEST_UNSUCCESSFUL"), true);
    assert.equal(ids.has("agentic.blocker.115.local-test-unsuccessful"), true);
  });
});
