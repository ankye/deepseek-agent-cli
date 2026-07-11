import type { JsonObject, PlatformRuntime } from "@deepseek/platform-contracts";

export interface SweBenchEvaluationCacheSummary extends JsonObject {
  readonly tracePath: string;
  readonly targetHitRate?: number;
  readonly hitTokens: number;
  readonly missTokens: number;
  readonly hitRate: number;
  readonly requestCount: number;
  readonly lowHitRequestCount: number;
  readonly passed?: boolean;
  readonly provider: SweBenchProviderCacheSummary;
  readonly contextProjection: SweBenchContextProjectionCacheSummary;
  readonly promptAssembly: SweBenchPromptAssemblyCacheSummary;
  readonly redaction: { readonly class: "internal"; readonly fields?: readonly string[] };
}

export interface SweBenchProviderCacheSummary extends JsonObject {
  readonly hitTokens: number;
  readonly missTokens: number;
  readonly hitRate: number;
  readonly requestCount: number;
  readonly lowHitRequestCount: number;
  readonly lowHitColdStartCount: number;
  readonly lowHitHistoryTailCount: number;
  readonly lowHitPromptAssemblyDriftCount: number;
  readonly maxSelectedHistoryMessageCount: number;
  readonly maxAssistantToolCallCount: number;
  readonly maxToolResultCount: number;
  readonly lowHitHistoryTailMaxSelectedHistoryMessageCount: number;
  readonly lowHitHistoryTailMaxAssistantToolCallCount: number;
  readonly lowHitHistoryTailMaxToolResultCount: number;
  readonly lowHitUnboundedAfterGateCount: number;
  readonly lowHitUnboundedAfterGateMaxSelectedHistoryMessageCount: number;
  readonly lowHitUnboundedAfterGateMaxAssistantToolCallCount: number;
  readonly lowHitUnboundedAfterGateMaxToolResultCount: number;
  readonly requestWithPipelineCount: number;
  readonly lowHitPipelineMissingCount: number;
  readonly lowHitPrefixHintMissingCount: number;
  readonly lowHitPrefixHintUnsupportedCount: number;
  readonly lowHitRepeatedZeroHitWithPipelineCount: number;
  readonly lowHitProviderPrefixTooSmallCount: number;
  readonly lowHitProviderPrefixCoverageLowCount: number;
  readonly minProviderPrefixCoverageRatio: number;
  readonly maxProviderPrefixCoverageRatio: number;
  readonly lowHitDynamicTailMissCount: number;
  readonly lowHitDynamicTailMissTokens: number;
  readonly effectiveStableCacheHitTokens: number;
  readonly maxPositiveHitTokens: number;
  readonly minPositiveHitTokens: number;
  readonly lowHitToolSchemaCacheGapCount: number;
  readonly lowHitMultiMessageCacheControlCount: number;
  readonly requestWithBreakpointShapeCount: number;
  readonly lowHitBreakpointShapeTelemetryMissingCount: number;
  readonly lowHitFirstMessageCacheControlCount: number;
  readonly lowHitMiddleMessageCacheControlCount: number;
  readonly lowHitLastMessageCacheControlCount: number;
  readonly maxSystemCacheControlCount: number;
  readonly maxMessageCacheControlCount: number;
  readonly maxToolCacheControlCount: number;
  readonly maxTotalCacheControlCount: number;
}

export interface SweBenchContextProjectionCacheSummary extends JsonObject {
  readonly requestCount: number;
  readonly hitCount: number;
  readonly missCount: number;
  readonly noStoreCount: number;
  readonly hitRate: number;
  readonly promptDependencyCount: number;
  readonly uniquePromptDependencyCount: number;
  readonly samplePromptDependencyFingerprints: readonly string[];
  readonly uniqueKeyCount: number;
}

export interface SweBenchPromptAssemblyCacheSummary extends JsonObject {
  readonly eventCount: number;
  readonly uniqueWholePromptFingerprintCount: number;
  readonly uniqueSectionOrderFingerprintCount: number;
  readonly uniqueBudgetFingerprintCount: number;
  readonly uniqueToolPlanFingerprintCount: number;
  readonly providerPrefixEventCount: number;
  readonly uniqueProviderPrefixFingerprintCount: number;
  readonly minProviderPrefixMessageCount: number;
  readonly maxProviderPrefixMessageCount: number;
  readonly minProviderPrefixTokenEstimate: number;
  readonly maxProviderPrefixTokenEstimate: number;
  readonly stableProviderPrefixFingerprint: boolean;
  readonly stableReplayFingerprint: boolean;
  readonly wholePromptFingerprintDynamicWithStablePrefix: boolean;
}

const MIN_CACHEABLE_PROVIDER_PREFIX_MESSAGE_COUNT = 2;
const MIN_CACHEABLE_PROVIDER_PREFIX_TOKEN_ESTIMATE = 256;

export async function readSweBenchCacheTrace(
  platform: PlatformRuntime,
  cacheTracePath: string,
  targetHitRate: number | undefined
): Promise<SweBenchEvaluationCacheSummary> {
  const content = await platform.readFile(cacheTracePath);
  let hitTokens = 0;
  let missTokens = 0;
  let requestCount = 0;
  let lowHitRequestCount = 0;
  let lowHitColdStartCount = 0;
  let lowHitHistoryTailCount = 0;
  let lowHitPromptAssemblyDriftCount = 0;
  let maxSelectedHistoryMessageCount = 0;
  let maxAssistantToolCallCount = 0;
  let maxToolResultCount = 0;
  let lowHitHistoryTailMaxSelectedHistoryMessageCount = 0;
  let lowHitHistoryTailMaxAssistantToolCallCount = 0;
  let lowHitHistoryTailMaxToolResultCount = 0;
  let lowHitUnboundedAfterGateCount = 0;
  let lowHitUnboundedAfterGateMaxSelectedHistoryMessageCount = 0;
  let lowHitUnboundedAfterGateMaxAssistantToolCallCount = 0;
  let lowHitUnboundedAfterGateMaxToolResultCount = 0;
  let requestWithPipelineCount = 0;
  let lowHitPipelineMissingCount = 0;
  let lowHitPrefixHintMissingCount = 0;
  let lowHitPrefixHintUnsupportedCount = 0;
  let lowHitRepeatedZeroHitWithPipelineCount = 0;
  let lowHitProviderPrefixTooSmallCount = 0;
  let lowHitProviderPrefixCoverageLowCount = 0;
  let minProviderPrefixCoverageRatio = Number.POSITIVE_INFINITY;
  let maxProviderPrefixCoverageRatio = 0;
  let lowHitDynamicTailMissCount = 0;
  let lowHitDynamicTailMissTokens = 0;
  let maxPositiveHitTokens = 0;
  let minPositiveHitTokens = Number.POSITIVE_INFINITY;
  let lowHitToolSchemaCacheGapCount = 0;
  let lowHitMultiMessageCacheControlCount = 0;
  let requestWithBreakpointShapeCount = 0;
  let lowHitBreakpointShapeTelemetryMissingCount = 0;
  let lowHitFirstMessageCacheControlCount = 0;
  let lowHitMiddleMessageCacheControlCount = 0;
  let lowHitLastMessageCacheControlCount = 0;
  let maxSystemCacheControlCount = 0;
  let maxMessageCacheControlCount = 0;
  let maxToolCacheControlCount = 0;
  let maxTotalCacheControlCount = 0;
  let contextRequestCount = 0;
  let contextHitCount = 0;
  let contextMissCount = 0;
  let contextNoStoreCount = 0;
  let contextPromptDependencyCount = 0;
  const contextKeys = new Set<string>();
  const contextPromptDependencies = new Set<string>();
  const wholePromptFingerprints = new Set<string>();
  const sectionOrderFingerprints = new Set<string>();
  const budgetFingerprints = new Set<string>();
  const toolPlanFingerprints = new Set<string>();
  const providerPrefixFingerprints = new Set<string>();
  let promptAssemblyEventCount = 0;
  let providerPrefixEventCount = 0;
  let minProviderPrefixMessageCount = Number.POSITIVE_INFINITY;
  let maxProviderPrefixMessageCount = 0;
  let minProviderPrefixTokenEstimate = Number.POSITIVE_INFINITY;
  let maxProviderPrefixTokenEstimate = 0;
  let latestProviderPrefixMessageCount: number | undefined;
  let latestProviderPrefixTokenEstimate: number | undefined;
  let latestPromptAssemblyStable = true;
  let pendingProviderRequest: ProviderRequestReplay | undefined;
  const seenPipelineFingerprints = new Set<string>();
  const lowHitThreshold = targetHitRate ?? 0.9;
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as JsonObject;
    const contextCache = contextProjectionCache(parsed);
    if (contextCache) {
      if (contextCache.noStore) {
        contextNoStoreCount += 1;
      } else {
        contextRequestCount += 1;
        if (contextCache.key) contextKeys.add(contextCache.key);
        const promptDependencies = contextCache.dependencyFingerprints.filter((fingerprint) => fingerprint.startsWith("prompt:"));
        for (const fingerprint of promptDependencies) contextPromptDependencies.add(fingerprint);
        if (promptDependencies.length > 0) contextPromptDependencyCount += 1;
        if (contextCache.hit === true) {
          contextHitCount += 1;
        } else {
          contextMissCount += 1;
        }
      }
    }
    const promptAssembly = promptAssemblyReplay(parsed);
    if (promptAssembly) {
      promptAssemblyEventCount += 1;
      if (promptAssembly.wholePromptFingerprint) wholePromptFingerprints.add(promptAssembly.wholePromptFingerprint);
      if (promptAssembly.sectionOrderFingerprint) sectionOrderFingerprints.add(promptAssembly.sectionOrderFingerprint);
      if (promptAssembly.budgetFingerprint) budgetFingerprints.add(promptAssembly.budgetFingerprint);
      if (promptAssembly.toolPlanFingerprint) toolPlanFingerprints.add(promptAssembly.toolPlanFingerprint);
      if (promptAssembly.providerPrefixFingerprint) providerPrefixFingerprints.add(promptAssembly.providerPrefixFingerprint);
      if (promptAssembly.providerPrefixMessageCount !== undefined || promptAssembly.providerPrefixTokenEstimate !== undefined) {
        providerPrefixEventCount += 1;
        const messageCount = promptAssembly.providerPrefixMessageCount ?? 0;
        const tokenEstimate = promptAssembly.providerPrefixTokenEstimate ?? 0;
        minProviderPrefixMessageCount = Math.min(minProviderPrefixMessageCount, messageCount);
        maxProviderPrefixMessageCount = Math.max(maxProviderPrefixMessageCount, messageCount);
        minProviderPrefixTokenEstimate = Math.min(minProviderPrefixTokenEstimate, tokenEstimate);
        maxProviderPrefixTokenEstimate = Math.max(maxProviderPrefixTokenEstimate, tokenEstimate);
        latestProviderPrefixMessageCount = messageCount;
        latestProviderPrefixTokenEstimate = tokenEstimate;
      }
      latestPromptAssemblyStable = promptAssemblyCacheablePrefixIsStable(
        sectionOrderFingerprints,
        budgetFingerprints,
        toolPlanFingerprints,
        providerPrefixEventCount,
        providerPrefixFingerprints
      );
    }
    const providerReplay = providerRequestReplay(parsed);
    if (providerReplay) {
      pendingProviderRequest = providerReplay;
      maxSelectedHistoryMessageCount = Math.max(maxSelectedHistoryMessageCount, providerReplay.selectedHistoryMessageCount);
      maxAssistantToolCallCount = Math.max(maxAssistantToolCallCount, providerReplay.assistantToolCallCount);
      maxToolResultCount = Math.max(maxToolResultCount, providerReplay.toolResultCount);
    }
    const data = usageData(parsed);
    if (!data) continue;
    const cache = usageCache(data);
    if (!cache) continue;
    const hit = numberField(cache, "hitTokens") ?? 0;
    const miss = numberField(cache, "missTokens") ?? numberField(data, "inputTokens") ?? numberField(data, "input_tokens") ?? 0;
    const total = hit + miss;
    if (total <= 0) continue;
    const rate = hit / total;
    const explicitPrefixHintStatus = explicitPrefixCacheHintStatus(cache);
    const breakpointShape = providerCacheBreakpointShape(cache);
    if (breakpointShape) {
      requestWithBreakpointShapeCount += 1;
      maxSystemCacheControlCount = Math.max(maxSystemCacheControlCount, breakpointShape.systemCacheControlCount);
      maxMessageCacheControlCount = Math.max(maxMessageCacheControlCount, breakpointShape.messageCacheControlCount);
      maxToolCacheControlCount = Math.max(maxToolCacheControlCount, breakpointShape.toolCacheControlCount);
      maxTotalCacheControlCount = Math.max(maxTotalCacheControlCount, breakpointShape.totalCacheControlCount);
    }
    const hasPipelineHint = providerRequestHasPipelineHint(pendingProviderRequest) || typeof cache.pipelineFingerprint === "string";
    const pipelineFingerprint = providerRequestPipelineFingerprint(pendingProviderRequest) ?? stringField(cache, "pipelineFingerprint");
    const seenPipelineBefore = pipelineFingerprint ? seenPipelineFingerprints.has(pipelineFingerprint) : false;
    const hasProviderPrefixHint = explicitPrefixHintStatus === "sent";
    const providerPrefixHintUnsupported = explicitPrefixHintStatus === "unsupported";
    requestCount += 1;
    if (hasPipelineHint) requestWithPipelineCount += 1;
    hitTokens += hit;
    missTokens += miss;
    if (hit > 0) {
      maxPositiveHitTokens = Math.max(maxPositiveHitTokens, hit);
      minPositiveHitTokens = Math.min(minPositiveHitTokens, hit);
    }
    if (rate < lowHitThreshold) {
      lowHitRequestCount += 1;
      if (hit === 0 && seenPipelineBefore && hasPipelineHint) {
        lowHitRepeatedZeroHitWithPipelineCount += 1;
      } else if (hit === 0) {
        lowHitColdStartCount += 1;
      }
      if (!latestPromptAssemblyStable) lowHitPromptAssemblyDriftCount += 1;
      const historyTailRequest = latestPromptAssemblyStable && isHistoryTailProviderRequest(pendingProviderRequest) ? pendingProviderRequest : undefined;
      if (historyTailRequest) {
        lowHitHistoryTailCount += 1;
        lowHitHistoryTailMaxSelectedHistoryMessageCount = Math.max(lowHitHistoryTailMaxSelectedHistoryMessageCount, historyTailRequest.selectedHistoryMessageCount);
        lowHitHistoryTailMaxAssistantToolCallCount = Math.max(lowHitHistoryTailMaxAssistantToolCallCount, historyTailRequest.assistantToolCallCount);
        lowHitHistoryTailMaxToolResultCount = Math.max(lowHitHistoryTailMaxToolResultCount, historyTailRequest.toolResultCount);
      }
      const unboundedAfterGateRequest = latestPromptAssemblyStable && isUnboundedProviderHistoryAfterGate(pendingProviderRequest) ? pendingProviderRequest : undefined;
      if (unboundedAfterGateRequest) {
        lowHitUnboundedAfterGateCount += 1;
        lowHitUnboundedAfterGateMaxSelectedHistoryMessageCount = Math.max(lowHitUnboundedAfterGateMaxSelectedHistoryMessageCount, unboundedAfterGateRequest.selectedHistoryMessageCount);
        lowHitUnboundedAfterGateMaxAssistantToolCallCount = Math.max(lowHitUnboundedAfterGateMaxAssistantToolCallCount, unboundedAfterGateRequest.assistantToolCallCount);
        lowHitUnboundedAfterGateMaxToolResultCount = Math.max(lowHitUnboundedAfterGateMaxToolResultCount, unboundedAfterGateRequest.toolResultCount);
      }
      if (latestPromptAssemblyStable && providerPrefixHintUnsupported) lowHitPrefixHintUnsupportedCount += 1;
      if (latestPromptAssemblyStable && !hasPipelineHint) lowHitPipelineMissingCount += 1;
      if (latestPromptAssemblyStable && hasPipelineHint && !providerPrefixHintUnsupported && !hasProviderPrefixHint) lowHitPrefixHintMissingCount += 1;
      if (
        latestPromptAssemblyStable
        && hasPipelineHint
        && hasProviderPrefixHint
        && providerPrefixIsTooSmall(latestProviderPrefixMessageCount, latestProviderPrefixTokenEstimate)
      ) {
          lowHitProviderPrefixTooSmallCount += 1;
      }
      const providerPrefixReuseSignal = hasProviderPrefixHint || providerPrefixHintUnsupported;
      const dynamicTailMiss = latestPromptAssemblyStable
        && hasPipelineHint
        && providerPrefixReuseSignal
        && providerPrefixFingerprints.size <= 1
        && providerHitExceedsPromptPrefix(hit, latestProviderPrefixTokenEstimate);
      if (dynamicTailMiss) {
        lowHitDynamicTailMissCount += 1;
        lowHitDynamicTailMissTokens += miss;
      }
      const providerPrefixCoverageRatio = providerPrefixCoverage(latestProviderPrefixTokenEstimate, total);
      if (
        latestPromptAssemblyStable
        && hasPipelineHint
        && hasProviderPrefixHint
        && !dynamicTailMiss
        && providerPrefixCoverageRatio !== undefined
        && providerPrefixCoverageRatio < lowHitThreshold
      ) {
        lowHitProviderPrefixCoverageLowCount += 1;
        minProviderPrefixCoverageRatio = Math.min(minProviderPrefixCoverageRatio, providerPrefixCoverageRatio);
        maxProviderPrefixCoverageRatio = Math.max(maxProviderPrefixCoverageRatio, providerPrefixCoverageRatio);
      }
      if (
        latestPromptAssemblyStable
        && hasPipelineHint
        && hasProviderPrefixHint
        && !dynamicTailMiss
        && hasVisibleToolSchemas(pendingProviderRequest)
      ) {
        lowHitToolSchemaCacheGapCount += 1;
      }
      if (latestPromptAssemblyStable && (breakpointShape?.messageCacheControlCount ?? 0) > 1) {
        lowHitMultiMessageCacheControlCount += 1;
      }
      if (latestPromptAssemblyStable && breakpointShape) {
        if (breakpointShape.messageCacheControlPositions.includes("first-message")) lowHitFirstMessageCacheControlCount += 1;
        if (breakpointShape.messageCacheControlPositions.includes("middle-message")) lowHitMiddleMessageCacheControlCount += 1;
        if (breakpointShape.messageCacheControlPositions.includes("last-message")) lowHitLastMessageCacheControlCount += 1;
      }
      if (
        latestPromptAssemblyStable
        && hasPipelineHint
        && hasProviderPrefixHint
        && !breakpointShape
      ) {
        lowHitBreakpointShapeTelemetryMissingCount += 1;
      }
    }
    if (pipelineFingerprint) seenPipelineFingerprints.add(pipelineFingerprint);
    pendingProviderRequest = undefined;
  }
  const totalTokens = hitTokens + missTokens;
  const hitRate = totalTokens > 0 ? hitTokens / totalTokens : 0;
  const effectiveStableCacheHitTokens = maxPositiveHitTokens;
  const effectiveStableHitExceedsPromptPrefix = providerHitExceedsPromptPrefix(effectiveStableCacheHitTokens, maxProviderPrefixTokenEstimate);
  const reportedLowHitProviderPrefixCoverageLowCount = effectiveStableHitExceedsPromptPrefix ? 0 : lowHitProviderPrefixCoverageLowCount;
  const reportedLowHitToolSchemaCacheGapCount = effectiveStableHitExceedsPromptPrefix ? 0 : lowHitToolSchemaCacheGapCount;
  return {
    tracePath: cacheTracePath,
    ...(targetHitRate !== undefined ? { targetHitRate } : {}),
    hitTokens,
    missTokens,
    hitRate,
    requestCount,
    lowHitRequestCount,
    ...(targetHitRate !== undefined ? { passed: requestCount > 0 && hitRate >= targetHitRate } : {}),
    provider: {
      hitTokens,
      missTokens,
      hitRate,
      requestCount,
      lowHitRequestCount,
      lowHitColdStartCount,
      lowHitHistoryTailCount,
      lowHitPromptAssemblyDriftCount,
      maxSelectedHistoryMessageCount,
      maxAssistantToolCallCount,
      maxToolResultCount,
      lowHitHistoryTailMaxSelectedHistoryMessageCount,
      lowHitHistoryTailMaxAssistantToolCallCount,
      lowHitHistoryTailMaxToolResultCount,
      lowHitUnboundedAfterGateCount,
      lowHitUnboundedAfterGateMaxSelectedHistoryMessageCount,
      lowHitUnboundedAfterGateMaxAssistantToolCallCount,
      lowHitUnboundedAfterGateMaxToolResultCount,
      requestWithPipelineCount,
      lowHitPipelineMissingCount,
      lowHitPrefixHintMissingCount,
      lowHitPrefixHintUnsupportedCount,
      lowHitRepeatedZeroHitWithPipelineCount,
      lowHitProviderPrefixTooSmallCount,
      lowHitProviderPrefixCoverageLowCount: reportedLowHitProviderPrefixCoverageLowCount,
      minProviderPrefixCoverageRatio: reportedLowHitProviderPrefixCoverageLowCount > 0 ? minProviderPrefixCoverageRatio : 0,
      maxProviderPrefixCoverageRatio: reportedLowHitProviderPrefixCoverageLowCount > 0 ? maxProviderPrefixCoverageRatio : 0,
      lowHitDynamicTailMissCount,
      lowHitDynamicTailMissTokens,
      effectiveStableCacheHitTokens,
      maxPositiveHitTokens,
      minPositiveHitTokens: minPositiveHitTokens === Number.POSITIVE_INFINITY ? 0 : minPositiveHitTokens,
      lowHitToolSchemaCacheGapCount: reportedLowHitToolSchemaCacheGapCount,
      lowHitMultiMessageCacheControlCount,
      requestWithBreakpointShapeCount,
      lowHitBreakpointShapeTelemetryMissingCount,
      lowHitFirstMessageCacheControlCount,
      lowHitMiddleMessageCacheControlCount,
      lowHitLastMessageCacheControlCount,
      maxSystemCacheControlCount,
      maxMessageCacheControlCount,
      maxToolCacheControlCount,
      maxTotalCacheControlCount
    },
    contextProjection: {
      requestCount: contextRequestCount,
      hitCount: contextHitCount,
      missCount: contextMissCount,
      noStoreCount: contextNoStoreCount,
      hitRate: contextRequestCount > 0 ? contextHitCount / contextRequestCount : 0,
      promptDependencyCount: contextPromptDependencyCount,
      uniquePromptDependencyCount: contextPromptDependencies.size,
      samplePromptDependencyFingerprints: [...contextPromptDependencies].slice(0, 8),
      uniqueKeyCount: contextKeys.size
    },
    promptAssembly: {
      eventCount: promptAssemblyEventCount,
      uniqueWholePromptFingerprintCount: wholePromptFingerprints.size,
      uniqueSectionOrderFingerprintCount: sectionOrderFingerprints.size,
      uniqueBudgetFingerprintCount: budgetFingerprints.size,
      uniqueToolPlanFingerprintCount: toolPlanFingerprints.size,
      providerPrefixEventCount,
      uniqueProviderPrefixFingerprintCount: providerPrefixFingerprints.size,
      minProviderPrefixMessageCount: providerPrefixEventCount > 0 ? minProviderPrefixMessageCount : 0,
      maxProviderPrefixMessageCount,
      minProviderPrefixTokenEstimate: providerPrefixEventCount > 0 ? minProviderPrefixTokenEstimate : 0,
      maxProviderPrefixTokenEstimate,
      stableProviderPrefixFingerprint: providerPrefixEventCount > 1 && providerPrefixFingerprints.size <= 1,
      stableReplayFingerprint: promptAssemblyEventCount > 1 && promptAssemblyFingerprintsAreStable(sectionOrderFingerprints, budgetFingerprints, toolPlanFingerprints),
      wholePromptFingerprintDynamicWithStablePrefix: wholePromptFingerprints.size > 1 && promptAssemblyCacheablePrefixIsStable(
        sectionOrderFingerprints,
        budgetFingerprints,
        toolPlanFingerprints,
        providerPrefixEventCount,
        providerPrefixFingerprints
      )
    },
    redaction: { class: "internal", fields: ["tracePath"] }
  };
}

function providerPrefixIsTooSmall(messageCount: number | undefined, tokenEstimate: number | undefined): boolean {
  if (messageCount === undefined && tokenEstimate === undefined) return false;
  return (messageCount ?? 0) < MIN_CACHEABLE_PROVIDER_PREFIX_MESSAGE_COUNT ||
    (tokenEstimate ?? 0) < MIN_CACHEABLE_PROVIDER_PREFIX_TOKEN_ESTIMATE;
}

function providerPrefixCoverage(tokenEstimate: number | undefined, requestCacheTotalTokens: number): number | undefined {
  if (tokenEstimate === undefined || tokenEstimate <= 0 || requestCacheTotalTokens <= 0) return undefined;
  return Math.min(1, tokenEstimate / requestCacheTotalTokens);
}

function providerHitExceedsPromptPrefix(hitTokens: number, tokenEstimate: number | undefined): boolean {
  if (hitTokens <= 0 || tokenEstimate === undefined || tokenEstimate <= 0) return false;
  return hitTokens > tokenEstimate;
}

export function cacheReviewThreshold(targetHitRate: number | undefined): number {
  return targetHitRate ?? 0.8;
}

function usageData(record: JsonObject): JsonObject | undefined {
  if (record.kind === "usage.updated" && isJsonObject(record.data)) return record.data;
  const event = record.event;
  if (isJsonObject(event) && event.kind === "usage.updated" && isJsonObject(event.data)) return event.data;
  return undefined;
}

function usageCache(data: JsonObject): JsonObject | undefined {
  const metadata = data.metadata;
  if (isJsonObject(metadata) && isJsonObject(metadata.cache)) return metadata.cache;
  return isJsonObject(data.cache) ? data.cache : undefined;
}

function explicitPrefixCacheHintStatus(cache: JsonObject): "sent" | "unsupported" | "missing" | undefined {
  const hint = isJsonObject(cache.explicitPrefixCacheHint) ? cache.explicitPrefixCacheHint : undefined;
  const status = hint?.status;
  return status === "sent" || status === "unsupported" || status === "missing" ? status : undefined;
}

function providerCacheBreakpointShape(cache: JsonObject): {
  readonly systemCacheControlCount: number;
  readonly messageCacheControlCount: number;
  readonly toolCacheControlCount: number;
  readonly totalCacheControlCount: number;
  readonly messageCacheControlPositions: readonly ("first-message" | "middle-message" | "last-message")[];
} | undefined {
  const shape = isJsonObject(cache.breakpointShape) ? cache.breakpointShape : undefined;
  if (!shape) return undefined;
  const systemCacheControlCount = numberField(shape, "systemCacheControlCount") ?? 0;
  const messageCacheControlCount = numberField(shape, "messageCacheControlCount") ?? 0;
  const toolCacheControlCount = numberField(shape, "toolCacheControlCount") ?? 0;
  const totalCacheControlCount = numberField(shape, "totalCacheControlCount") ??
    systemCacheControlCount + messageCacheControlCount + toolCacheControlCount;
  return {
    systemCacheControlCount,
    messageCacheControlCount,
    toolCacheControlCount,
    totalCacheControlCount,
    messageCacheControlPositions: messageCacheControlPositions(shape)
  };
}

function messageCacheControlPositions(shape: JsonObject): readonly ("first-message" | "middle-message" | "last-message")[] {
  if (!Array.isArray(shape.messageCacheControlPositions)) return [];
  return shape.messageCacheControlPositions.filter((position): position is "first-message" | "middle-message" | "last-message" =>
    position === "first-message" || position === "middle-message" || position === "last-message"
  );
}

interface ProviderRequestReplay {
  readonly selectedHistoryMessageCount: number;
  readonly historyMessageCount: number;
  readonly assistantToolCallCount: number;
  readonly toolResultCount: number;
  readonly hasContextPipeline: boolean;
  readonly pipelineFingerprint?: string;
  readonly messageRoleSequence: readonly string[];
  readonly visibleToolCount?: number;
}

function providerRequestReplay(record: JsonObject): ProviderRequestReplay | undefined {
  const event = isJsonObject(record.event) ? record.event : record;
  if (event.kind !== "model.requested") return undefined;
  const data = isJsonObject(event.data) ? event.data : {};
  const replay = isJsonObject(data.providerRequestReplay) ? data.providerRequestReplay : {};
  const contextPipeline = isJsonObject(data.contextPipeline) ? data.contextPipeline : undefined;
  const pipelineFingerprint = stringField(contextPipeline, "pipelineFingerprint");
  const linkage = isJsonObject(replay.toolCallLinkage) ? replay.toolCallLinkage : {};
  const selectedHistoryMessageCount = numberField(replay, "selectedHistoryMessageCount") ?? 0;
  const historyMessageCount = numberField(replay, "historyMessageCount") ?? selectedHistoryMessageCount;
  const visibleToolCount = numberField(replay, "visibleToolCount")
    ?? numberField(replay, "visibleToolSchemaCount")
    ?? numberField(data, "visibleToolCount")
    ?? numberField(data, "visibleToolSchemaCount");
  const assistantToolCallCount = numberField(linkage, "assistantToolCallCount") ?? 0;
  const toolResultCount = numberField(linkage, "toolResultCount") ?? 0;
  const messageRoleSequence = Array.isArray(replay.messageRoleSequence)
    ? replay.messageRoleSequence.filter((role): role is string => typeof role === "string")
    : [];
  if (historyMessageCount <= 0 && selectedHistoryMessageCount <= 0 && assistantToolCallCount <= 0 && toolResultCount <= 0) return undefined;
  return {
    selectedHistoryMessageCount,
    historyMessageCount,
    assistantToolCallCount,
    toolResultCount,
    messageRoleSequence,
    hasContextPipeline: pipelineFingerprint.length > 0,
    ...(visibleToolCount !== undefined ? { visibleToolCount } : {}),
    ...(pipelineFingerprint.length > 0 ? { pipelineFingerprint } : {})
  };
}

function hasVisibleToolSchemas(replay: ProviderRequestReplay | undefined): boolean {
  return (replay?.visibleToolCount ?? 0) > 0;
}

function providerRequestHasPipelineHint(replay: ProviderRequestReplay | undefined): boolean {
  return replay?.hasContextPipeline === true;
}

function providerRequestPipelineFingerprint(replay: ProviderRequestReplay | undefined): string | undefined {
  return replay?.pipelineFingerprint;
}

function isHistoryTailProviderRequest(replay: ProviderRequestReplay | undefined): boolean {
  if (!replay) return false;
  return replay.historyMessageCount > 12 && (replay.assistantToolCallCount > 0 || replay.toolResultCount > 0);
}

function isUnboundedProviderHistoryAfterGate(replay: ProviderRequestReplay | undefined): boolean {
  if (!replay) return false;
  const userMessageCount = replay.messageRoleSequence.filter((role) => role === "user").length;
  const retainedToolPairCount = Math.min(replay.assistantToolCallCount, replay.toolResultCount);
  return userMessageCount > 1 && replay.selectedHistoryMessageCount > 24 && retainedToolPairCount > 6;
}

function contextProjectionCache(record: JsonObject): { readonly hit: boolean; readonly key?: string; readonly dependencyFingerprints: readonly string[]; readonly noStore: boolean } | undefined {
  const event = isJsonObject(record.event) ? record.event : record;
  if (event.kind !== "context.projection.completed") return undefined;
  const data = isJsonObject(event.data) ? event.data : {};
  const cache = isJsonObject(data.cache) ? data.cache : undefined;
  if (!cache || cache.namespace !== "context.projection" || typeof cache.hit !== "boolean") return undefined;
  const key = typeof cache.key === "string" ? cache.key : undefined;
  const dependencyFingerprints = Array.isArray(cache.dependencyFingerprints)
    ? cache.dependencyFingerprints.filter((item): item is string => typeof item === "string")
    : [];
  const promptOnlyDependencies = dependencyFingerprints.length > 0 && dependencyFingerprints.every((fingerprint) => fingerprint.startsWith("prompt:"));
  return {
    hit: cache.hit,
    ...(key ? { key } : {}),
    dependencyFingerprints,
    noStore: key === "context.projection:no-store" || promptOnlyDependencies
  };
}

function promptAssemblyReplay(record: JsonObject): {
  readonly wholePromptFingerprint?: string;
  readonly sectionOrderFingerprint?: string;
  readonly budgetFingerprint?: string;
  readonly toolPlanFingerprint?: string;
  readonly providerPrefixFingerprint?: string;
  readonly providerPrefixMessageCount?: number;
  readonly providerPrefixTokenEstimate?: number;
} | undefined {
  const event = isJsonObject(record.event) ? record.event : record;
  if (event.kind !== "prompt.assembled") return undefined;
  const data = isJsonObject(event.data) ? event.data : {};
  const trace = isJsonObject(data.trace) ? data.trace : {};
  const replay = isJsonObject(trace.replay) ? trace.replay : {};
  const pipeline = isJsonObject(trace.pipeline) ? trace.pipeline : {};
  const wholePromptFingerprint = typeof data.fingerprint === "string" ? data.fingerprint : undefined;
  const sectionOrderFingerprint = typeof replay.sectionOrderFingerprint === "string" ? replay.sectionOrderFingerprint : undefined;
  const budgetFingerprint = typeof replay.budgetFingerprint === "string" ? replay.budgetFingerprint : undefined;
  const toolPlanFingerprint = typeof replay.toolPlanFingerprint === "string" ? replay.toolPlanFingerprint : undefined;
  const providerPrefixFingerprint = typeof pipeline.providerPrefixFingerprint === "string"
    ? pipeline.providerPrefixFingerprint
    : typeof replay.providerPrefixFingerprint === "string"
      ? replay.providerPrefixFingerprint
      : undefined;
  const providerPrefixMessageCount = numberField(pipeline, "providerPrefixMessageCount") ?? numberField(replay, "providerPrefixMessageCount");
  const providerPrefixTokenEstimate = numberField(pipeline, "providerPrefixTokenEstimate") ?? numberField(replay, "providerPrefixTokenEstimate");
  if (
    !wholePromptFingerprint
    && !sectionOrderFingerprint
    && !budgetFingerprint
    && !toolPlanFingerprint
    && !providerPrefixFingerprint
    && providerPrefixMessageCount === undefined
    && providerPrefixTokenEstimate === undefined
  ) return undefined;
  return {
    ...(wholePromptFingerprint ? { wholePromptFingerprint } : {}),
    ...(sectionOrderFingerprint ? { sectionOrderFingerprint } : {}),
    ...(budgetFingerprint ? { budgetFingerprint } : {}),
    ...(toolPlanFingerprint ? { toolPlanFingerprint } : {}),
    ...(providerPrefixFingerprint ? { providerPrefixFingerprint } : {}),
    ...(providerPrefixMessageCount !== undefined ? { providerPrefixMessageCount } : {}),
    ...(providerPrefixTokenEstimate !== undefined ? { providerPrefixTokenEstimate } : {})
  };
}

function promptAssemblyFingerprintsAreStable(
  sectionOrderFingerprints: ReadonlySet<string>,
  budgetFingerprints: ReadonlySet<string>,
  toolPlanFingerprints: ReadonlySet<string>
): boolean {
  return sectionOrderFingerprints.size <= 1 && budgetFingerprints.size <= 1 && toolPlanFingerprints.size <= 1;
}

function promptAssemblyCacheablePrefixIsStable(
  sectionOrderFingerprints: ReadonlySet<string>,
  budgetFingerprints: ReadonlySet<string>,
  toolPlanFingerprints: ReadonlySet<string>,
  providerPrefixEventCount: number,
  providerPrefixFingerprints: ReadonlySet<string>
): boolean {
  if (providerPrefixEventCount > 1) {
    return providerPrefixFingerprints.size <= 1;
  }
  return promptAssemblyFingerprintsAreStable(sectionOrderFingerprints, budgetFingerprints, toolPlanFingerprints);
}

function numberField(value: JsonObject, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function stringField(value: JsonObject | undefined, key: string): string {
  const field = value?.[key];
  return typeof field === "string" ? field : "";
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
