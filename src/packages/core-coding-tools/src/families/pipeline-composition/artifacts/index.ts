import type {
  CapabilityExecutionContext,
  CoreToolResult,
  JsonObject,
  SerializableResult
} from "@deepseek/platform-contracts";
import { boundedText, defineToolManifest, failure, objectSchema, replay, success } from "../../../shared/tool-kit.js";
import { coreToolIds } from "../../../shared/ids.js";

export function defineBriefPackageTool() {
  return defineToolManifest(
    "brief.package",
    coreToolIds.briefPackage,
    "Brief Package",
    "none",
    ["artifact:write"],
    objectSchema(["title", "summary"], {
      title: { type: "string" },
      summary: { type: "string" },
      artifacts: { type: "array", items: { type: "string" } },
      nextActions: { type: "array", items: { type: "string" } },
      metadata: { type: "object" }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => Promise.resolve(packageBrief(input, context))
  );
}

export function defineSyntheticOutputTool() {
  return defineToolManifest(
    "synthetic.output",
    coreToolIds.syntheticOutput,
    "Synthetic Output",
    "none",
    ["artifact:write"],
    objectSchema(["schemaName", "value"], {
      schemaName: { type: "string" },
      value: { type: "object" },
      requiredKeys: { type: "array", items: { type: "string" } }
    }),
    objectSchema(["evidence"], { evidence: { type: "object" } }),
    (input, context) => Promise.resolve(syntheticOutput(input, context))
  );
}

function packageBrief(input: JsonObject, context: CapabilityExecutionContext): SerializableResult<CoreToolResult> {
  const title = stringValue(input.title);
  const summary = stringValue(input.summary);
  if (!title || !summary) return failure("brief.package", "BRIEF_INPUT_REQUIRED", "title and summary are required.", []);
  const brief = {
    artifactId: `brief:${hashText(`${context.envelope.invocationId}:${title}`)}`,
    title,
    summary,
    artifacts: stringArray(input.artifacts),
    nextActions: stringArray(input.nextActions),
    metadata: jsonObject(input.metadata),
    createdAt: new Date(0).toISOString(),
    redaction: { class: "internal", fields: ["summary"] }
  };
  return success("brief.package", [], {
    preview: boundedText(`${title}\n${summary}`),
    metadata: {
      familyId: "pipeline.artifact-routing",
      brief
    },
    replay: replay(context)
  });
}

function syntheticOutput(input: JsonObject, context: CapabilityExecutionContext): SerializableResult<CoreToolResult> {
  const schemaName = stringValue(input.schemaName);
  if (!schemaName) return failure("synthetic.output", "SYNTHETIC_SCHEMA_REQUIRED", "schemaName is required.", []);
  const output = jsonObject(input.value);
  const requiredKeys = stringArray(input.requiredKeys);
  const missingKeys = requiredKeys.filter((key) => output[key] === undefined);
  if (missingKeys.length > 0) {
    return failure("synthetic.output", "SYNTHETIC_OUTPUT_MISSING_KEYS", "Synthetic output is missing required keys.", [], {
      schemaName,
      missingKeys
    });
  }
  return success("synthetic.output", [], {
    preview: boundedText(JSON.stringify(output, null, 2)),
    metadata: {
      familyId: "pipeline.artifact-routing",
      schemaName,
      valid: true,
      requiredKeys,
      output
    },
    replay: replay(context)
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function jsonObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
