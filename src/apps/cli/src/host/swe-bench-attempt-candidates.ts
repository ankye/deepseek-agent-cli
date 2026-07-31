export interface SweBenchAttemptCandidate<TPrediction = unknown, TEvaluation = unknown> {
  readonly attempt: number;
  readonly patchPath: string;
  readonly predictionPath: string;
  readonly tracePath: string;
  readonly metadataPath: string;
  readonly prediction: TPrediction;
  readonly evaluation?: TEvaluation;
  readonly sourceMutationCount: number;
  readonly testCommandCount: number;
  readonly patchBytes: number;
  readonly harnessReady: boolean;
  readonly localVerificationPassed: boolean;
  readonly harnessReportValid: boolean;
  readonly resolved: boolean;
  readonly passToPassFailures: number;
  readonly failToPassFailures: number;
}

function candidateScore(candidate: SweBenchAttemptCandidate): readonly number[] {
  return [
    candidate.resolved ? 1 : 0,
    candidate.harnessReportValid ? 1 : 0,
    -candidate.passToPassFailures,
    -candidate.failToPassFailures,
    candidate.harnessReady ? 1 : 0,
    candidate.localVerificationPassed ? 1 : 0,
    candidate.sourceMutationCount > 0 ? 1 : 0,
    candidate.patchBytes > 0 ? 1 : 0,
    candidate.testCommandCount > 0 ? 1 : 0
  ];
}

export function compareSweBenchAttemptCandidates<TPrediction, TEvaluation>(
  left: SweBenchAttemptCandidate<TPrediction, TEvaluation>,
  right: SweBenchAttemptCandidate<TPrediction, TEvaluation>
): number {
  const leftScore = candidateScore(left);
  const rightScore = candidateScore(right);
  for (let index = 0; index < leftScore.length; index += 1) {
    const difference = (leftScore[index] ?? 0) - (rightScore[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return right.attempt - left.attempt;
}

export function selectBestSweBenchAttemptCandidate<TPrediction, TEvaluation>(
  candidates: readonly SweBenchAttemptCandidate<TPrediction, TEvaluation>[]
): SweBenchAttemptCandidate<TPrediction, TEvaluation> | undefined {
  return candidates.reduce<SweBenchAttemptCandidate<TPrediction, TEvaluation> | undefined>(
    (best, candidate) =>
      !best || compareSweBenchAttemptCandidates(candidate, best) > 0 ? candidate : best,
    undefined
  );
}
