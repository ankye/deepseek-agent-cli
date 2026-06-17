import type { JsonObject, RedactedError, RedactionMetadata } from "./common.js";
import type { CapabilityId, ModelProfileId, ModelProviderId } from "./ids.js";

export type ToolIntentPreflightStatus = "repaired" | "accepted" | "rejected";

export type ToolIntentRepairKind =
  | "path-normalized"
  | "path-prefix-removed"
  | "path-separator-normalized"
  | "provider-arguments-unwrapped"
  | "provider-tool-alias-normalized"
  | "semantic-platform-operation"
  | "swe-bench-run-execution-normalized"
  | "swe-bench-task-range-normalized"
  | "workspace-cwd-defaulted"
  | "workspace-root-defaulted"
  | "workspace-tool-timeout-defaulted"
  | "workspace-tool-timeout-normalized";

export interface ToolIntent extends JsonObject {
  readonly toolCallId?: string;
  readonly name: string;
  readonly input: JsonObject;
  readonly source: "model" | "user" | "host";
}

export interface ToolIntentRepairAction extends JsonObject {
  readonly kind: ToolIntentRepairKind;
  readonly field: string;
  readonly before: string;
  readonly after: string;
  readonly confidence: number;
  readonly modelValue?: string;
  readonly executorValue?: string;
}

export interface ToolIntentDiagnostic extends RedactedError {
  readonly field?: string;
}

export interface ToolIntentPreflightRequest extends JsonObject {
  readonly intent: ToolIntent;
  readonly workspaceRoot: string;
  readonly platform: "macos" | "windows" | "linux" | "fake";
  readonly modelVisibleCapabilities: readonly CapabilityId[];
  readonly providerId?: ModelProviderId;
  readonly profileId?: ModelProfileId;
  readonly providerHints?: JsonObject;
  readonly pathFields?: readonly string[];
}

export interface ToolIntentProviderProfile extends JsonObject {
  readonly providerId: ModelProviderId;
  readonly profileId?: ModelProfileId;
  readonly pathFields?: readonly string[];
  readonly toolNameAliases?: JsonObject;
  readonly unwrapArgumentsField?: string;
  readonly strictJsonArguments?: boolean;
}

export interface ToolIntentPreflightResult extends JsonObject {
  readonly status: ToolIntentPreflightStatus;
  readonly original: ToolIntent;
  readonly repaired?: ToolIntent;
  readonly capabilityId?: CapabilityId;
  readonly repairs: readonly ToolIntentRepairAction[];
  readonly diagnostics: readonly ToolIntentDiagnostic[];
  readonly platform: JsonObject;
  readonly provider?: JsonObject;
  readonly workspaceRoot: string;
  readonly redaction: RedactionMetadata;
}

export interface ToolIntentPreflightService {
  check(request: ToolIntentPreflightRequest): Promise<ToolIntentPreflightResult>;
}

export type ToolFeedbackStatus =
  | "success"
  | "repaired"
  | "rejected"
  | "denied"
  | "timeout"
  | "cancelled"
  | "failed";

export interface ToolFeedbackPreview extends JsonObject {
  readonly text: string;
  readonly byteLength: number;
  readonly truncated: boolean;
  readonly limitBytes: number;
  readonly redaction: RedactionMetadata;
}

export interface ToolResultFeedback extends JsonObject {
  readonly schemaVersion: "1.0.0";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly capabilityId?: string;
  readonly status: ToolFeedbackStatus;
  readonly preview: ToolFeedbackPreview;
  readonly diagnostics: readonly RedactedError[];
  readonly trace: { readonly traceId: string; readonly correlationId: string };
  readonly continuation: "continue" | "terminate";
  readonly redaction: RedactionMetadata;
}
