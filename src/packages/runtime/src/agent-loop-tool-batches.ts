import type { JsonObject } from "@deepseek/platform-contracts";

export type ToolDispatchExecutionMode = "serial" | "concurrent";

export interface ToolDispatchRequest {
  readonly modelToolCalls: readonly ToolDispatchRequestItem[];
  readonly visibleCapabilityIds: readonly string[];
  readonly activeStageControl?: JsonObject;
}

export interface ToolDispatchRequestItem {
  readonly toolCallId: string;
  readonly providerToolName: string;
  readonly resolvedCapabilityId: string;
  readonly normalizedInputHash: string;
  readonly input: JsonObject;
  readonly sideEffect: string;
  readonly iteration: number;
}

export interface ToolDispatchBatch {
  readonly items: readonly ToolDispatchBatchItem[];
  readonly groups: readonly ToolDispatchBatchGroup[];
}

export interface ToolDispatchBatchItem extends ToolDispatchRequestItem {
  readonly executionMode: ToolDispatchExecutionMode;
}

export interface ToolDispatchBatchGroup {
  readonly executionMode: ToolDispatchExecutionMode;
  readonly items: readonly ToolDispatchBatchItem[];
}

export function planToolDispatchBatch(request: ToolDispatchRequest): ToolDispatchBatch {
  const items = request.modelToolCalls.map((toolCall) => ({
    ...toolCall,
    executionMode: request.modelToolCalls.length === 1 ? "serial" : executionModeFor(toolCall.sideEffect)
  }));
  return {
    items,
    groups: groupDispatchItems(items)
  };
}

function executionModeFor(sideEffect: string): ToolDispatchExecutionMode {
  if (sideEffect === "none" || sideEffect === "read") return "concurrent";
  return "serial";
}

function groupDispatchItems(items: readonly ToolDispatchBatchItem[]): readonly ToolDispatchBatchGroup[] {
  const groups: ToolDispatchBatchGroup[] = [];
  for (const item of items) {
    const executionMode = item.executionMode;
    const previous = groups.at(-1);
    if (!previous || executionMode === "serial" || previous.executionMode !== executionMode) {
      groups.push({ executionMode, items: [item] });
      continue;
    }
    groups[groups.length - 1] = {
      executionMode,
      items: [...previous.items, item]
    };
  }
  return groups;
}
