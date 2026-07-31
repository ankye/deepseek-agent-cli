import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compareSweBenchAttemptCandidates,
  selectBestSweBenchAttemptCandidate,
  type SweBenchAttemptCandidate
} from "./swe-bench-attempt-candidates.js";

function candidate(
  overrides: Partial<SweBenchAttemptCandidate<Record<string, never>, Record<string, never>>>
): SweBenchAttemptCandidate<Record<string, never>, Record<string, never>> {
  const attempt = overrides.attempt ?? 1;
  return {
    attempt,
    patchPath: `/run/candidate-attempt-${attempt}.patch`,
    predictionPath: `/run/prediction-attempt-${attempt}.jsonl`,
    tracePath: `/run/trace-attempt-${attempt}.jsonl`,
    metadataPath: `/run/candidate-attempt-${attempt}.json`,
    prediction: {},
    sourceMutationCount: 1,
    testCommandCount: 1,
    patchBytes: 128,
    harnessReady: true,
    localVerificationPassed: true,
    harnessReportValid: true,
    resolved: false,
    passToPassFailures: 0,
    failToPassFailures: 1,
    ...overrides
  };
}

describe("SWE-bench attempt candidate ranking", () => {
  it("prefers an officially resolved candidate", () => {
    const best = selectBestSweBenchAttemptCandidate([
      candidate({ attempt: 1, resolved: false, failToPassFailures: 0 }),
      candidate({ attempt: 2, resolved: true, failToPassFailures: 0 })
    ]);

    assert.equal(best?.attempt, 2);
  });

  it("keeps a harness-scored candidate over a later non-harness-ready attempt", () => {
    const best = selectBestSweBenchAttemptCandidate([
      candidate({ attempt: 1, harnessReportValid: true, failToPassFailures: 1 }),
      candidate({
        attempt: 2,
        harnessReady: false,
        localVerificationPassed: false,
        harnessReportValid: false,
        failToPassFailures: 0
      })
    ]);

    assert.equal(best?.attempt, 1);
  });

  it("rejects a repair that introduces pass-to-pass regressions", () => {
    const comparison = compareSweBenchAttemptCandidates(
      candidate({ attempt: 2, passToPassFailures: 9, failToPassFailures: 0 }),
      candidate({ attempt: 1, passToPassFailures: 0, failToPassFailures: 1 })
    );

    assert.equal(comparison < 0, true);
  });

  it("prefers fewer fail-to-pass failures after pass-to-pass ties", () => {
    const best = selectBestSweBenchAttemptCandidate([
      candidate({ attempt: 1, failToPassFailures: 2 }),
      candidate({ attempt: 2, failToPassFailures: 1 })
    ]);

    assert.equal(best?.attempt, 2);
  });

  it("keeps the earlier candidate when observable scores tie", () => {
    const best = selectBestSweBenchAttemptCandidate([
      candidate({ attempt: 1 }),
      candidate({ attempt: 2 })
    ]);

    assert.equal(best?.attempt, 1);
  });

  it("prefers real mutation progress over an earlier empty non-harness candidate", () => {
    const best = selectBestSweBenchAttemptCandidate([
      candidate({
        attempt: 1,
        harnessReady: false,
        localVerificationPassed: false,
        harnessReportValid: false,
        sourceMutationCount: 0,
        testCommandCount: 0,
        patchBytes: 0
      }),
      candidate({
        attempt: 2,
        harnessReady: false,
        localVerificationPassed: false,
        harnessReportValid: false,
        sourceMutationCount: 1,
        testCommandCount: 0,
        patchBytes: 96
      })
    ]);

    assert.equal(best?.attempt, 2);
  });
});
